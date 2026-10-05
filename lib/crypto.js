/**
 * Suno Master Utility — low-level cryptographic primitives for Suno "Mango"
 * media decryption.
 *
 * WHAT THIS FILE IS
 * -----------------
 * A hard-edged, allocation-aware rewrite of the previous 66-line
 * `SunoCrypto.decryptMediaBuffer` sketch, which was dead code with four
 * separate bugs:
 *
 *   1. It imported `AES-GCM` content keys of ANY length, so a truncated or
 *      mis-decoded `rights.key` surfaced as an opaque `OperationError: Operation
 *      not supported` from WebCrypto instead of saying what was wrong.
 *   2. It always ran AES-GCM unwrap, with no passthrough for the 16/32-byte
 *      plaintext-envelope case, so a legal payload was rejected.
 *   3. It decrypted the whole media buffer in one `crypto.subtle.decrypt`
 *      call. A 10-minute clip is ~50 MB of plaintext plus a ~50 MB copy of the
 *      ciphertext plus a ~50 MB keystream: an OOM tab on a mid-range machine.
 *   4. It never verified the output. AES-CTR is unauthenticated, so a wrong
 *      counter offset yields 50 MB of *perfectly well-formed garbage* that the
 *      caller will happily save as a corrupt `.m4a`.
 *
 * THE ALGORITHM (recon / ecosystem-attested)
 * ------------------------------------------
 * Three independent third-party implementations plus one user-supplied
 * reference agree on the following shape for a Suno clip:
 *
 *   - `clip.audio_url` is a DECOY: always the literal string
 *     `https://studio-api.prod.suno.com/api/forbidden`. The real asset is
 *     `clip.media_urls[i].url`, a CloudFront object
 *     `.../1/clip/{clipId}.m4a` with `content_type: "m4a-opus"`.
 *   - That asset is AES-CTR encrypted. Its 32-byte content key and 16-byte
 *     counter block are themselves wrapped under a per-user AES-GCM key:
 *
 *         userKey   = AES-GCM-key( SHA-256( <bearer token> | <glt> ) )
 *         contentKey = AES-GCM-decrypt( rights.key, userKey, aad = rights.aad || clipId )
 *         contentIv  = AES-GCM-decrypt( rights.iv,  userKey, aad = rights.aad || clipId )
 *
 *   - The envelope layout is `iv(12) || ciphertext || tag(16)`, i.e. the first
 *     12 bytes are the GCM nonce and the remainder is the WebCrypto
 *     `ciphertext||tag` blob. That is why the envelope needs >= 28 bytes.
 *   - An envelope that is exactly 16 or 32 bytes is NOT wrapped — it is the
 *     raw material. This is load-bearing, not defensive coding.
 *
 * KNOWN UNCERTAINTY — BEARER vs GLT
 * ---------------------------------
 * The per-user key seed is NOT agreed upon:
 *   - One lineage hashes `glt` (the guest/session token from the rights
 *     payload) and works for anonymous/guest playback with
 *     `credentials: 'include'` and NO bearer token at all.
 *   - Another lineage hashes the Studio bearer token and does not work for
 *     guests.
 * They are mutually exclusive and cannot both be right for a given account, so
 * the correct choice is **empirical**. `SunoDRM.resolveUserKey()` prefers the
 * bearer digest when a token exists and returns an ordered `attempts` array so
 * the caller can fall back to the `glt` digest (and vice versa) without
 * re-fetching rights. See `deriveUserKeyAttempts` in lib/drm.js.
 *
 * KNOWN UNCERTAINTY — REQUEST BODY NESTING
 * ----------------------------------------
 * The `{content_params: {content_id, content_type: 'clip'}}` nesting could not
 * be reproduced during recon; every flat attempt failed validation, and the
 * server's 422 `loc` chains are a KNOWN FABRICATION ARTIFACT and must never be
 * trusted for shape discovery. lib/drm.js therefore walks a prioritized body
 * list and records which shape actually returned 2xx.
 *
 * SECURITY POSTURE
 * ----------------
 * This file NEVER logs. It never touches `chrome.storage`, `localStorage`,
 * `sessionStorage`, `indexedDB`, or any network API. It has no `console.*`
 * call at all. Key material can only leave it as a `Uint8Array`/`CryptoKey`
 * handed to the caller. `redact()` exists so that downstream debug logging
 * cannot leak an envelope, and it replaces EVERY byte array and every
 * sensitive-named field with a placeholder.
 *
 * ENVIRONMENT
 * -----------
 * No imports, no DOM, no `chrome.*`, no `window` at load time. Runs in the MV3
 * service worker, in a content script, and under node.
 *
 * EXPOSURE
 * --------
 *   window.SunoCrypto       -> an INSTANCE carrying every static (see below)
 *   window.SunoCryptoClass  -> the class
 *   window.SunoCryptoError  -> the error class
 *   module.exports          -> { SunoCrypto, SunoCryptoClass, SunoCryptoError }
 *
 * The instance mirrors every static so that BOTH the historical static style
 * (`SunoCrypto.decryptMediaBuffer(...)`, which the previous file exposed and
 * callers in the wild still use) and the instance style
 * (`SunoCrypto.decryptMediaBuffer(...)` on `window.SunoCrypto`) resolve.
 *
 * All statics are written `this`-free and refer to the closed-over class, so
 * detaching them from the class is safe.
 */

(function () {
  'use strict';

  /* ================================================================== *
   * constants
   * ================================================================== */

  /**
   * Envelope length, in bytes, of the smallest legal AES-GCM envelope:
   * 12-byte nonce + 0-byte ciphertext is useless, so WebCrypto's real floor is
   * 12 (iv) + 16 (tag) = 28. Anything shorter cannot be GCM-wrapped.
   * @type {number}
   */
  var GCM_ENVELOPE_MIN = 28;

  /** GCM nonce length mandated by WebCrypto. @type {number} */
  var GCM_IV_BYTES = 12;

  /** GCM authentication tag length. @type {number} */
  var GCM_TAG_BYTES = 16;

  /** AES-CTR operates on a full 16-byte counter block. @type {number} */
  var CTR_BLOCK_BYTES = 16;

  /** Legal AES key lengths (128/192/256). @type {number[]} */
  var AES_KEY_SIZES = [16, 24, 32];

  /**
   * Default chunk size for chunked AES-CTR: 256 KiB.
   *
   * A multiple of the 16-byte AES block so every chunk but the last is a whole
   * number of blocks, which keeps the keystream accounting trivially auditable.
   * @type {number}
   */
  var DEFAULT_CHUNK_SIZE = 262144;

  /**
   * Default AES-CTR counter length in bits. The reference implementation falls
   * back to 64 bits when the engine rejects 128; Chromium supports 128, so that
   * is the default and the fallback is opt-in via `counterLength`.
   * @type {number}
   */
  var DEFAULT_CTR_LENGTH = 128;

  /** Canonical base64 (RFC 4648 §4) alphabet. */
  var B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** base64url (RFC 4648 §5) substitutes for the final two alphabet slots. */
  var B64_URL_SUBSTITUTES = { '-': 62, '_': 63 };

  /** Error `stage` values, exported for callers that switch on them. */
  var STAGES = {
    PARSE: 'parse',
    IMPORT: 'import',
    UNWRAP: 'unwrap',
    DECRYPT: 'decrypt',
    VERIFY: 'verify',
    RIGHTS: 'rights',
    MEDIA: 'media',
    CACHE: 'cache'
  };

  /* ================================================================== *
   * error type
   * ================================================================== */

  /**
   * Every failure this module raises. Carries the pipeline `stage` that failed
   * plus non-sensitive context, so a caller can tell "the server refused us"
   * from "the AES unwrap produced the wrong plaintext" from "we decrypted fine
   * but the output is not audio".
   *
   * WebCrypto throws bare `DOMException`s whose `name` is `OperationError`,
   * `DataError`, or `InvalidAccessError` and whose message is useless out of
   * context. NOTHING in this module lets one escape: each call site wraps the
   * failure in a `SunoCryptoError` carrying `stage`, `clipId`, and a `reason`
   * slug. `message` is derived from `reason` + the original exception's name
   * only — never from anything that could contain key bytes.
   *
   * @property {string} stage  Pipeline stage that failed; one of {@link STAGES}.
   * @property {string} [clipId]  Clip the failure belongs to, when known.
   * @property {number} [status]  HTTP status, for `rights` / `media` stages.
   * @property {string} reason   Stable machine-readable slug, e.g.
   *   `'ciphertext-too-short'`, `'counter-length-invalid'`,
   *   `'container-unrecognized'`.
   */
  class SunoCryptoError extends Error {
    /**
     * @param {string} message  Human-readable, MUST NOT contain key material.
     * @param {object} [info]
     * @param {string} [info.stage]
     * @param {string} [info.clipId]
     * @param {number} [info.status]
     * @param {string} [info.reason]
     * @param {Error}  [info.cause]  Wrapped WebCrypto/HTTP failure.
     */
    constructor(message, info) {
      super(message || 'Suno crypto failure');
      this.name = 'SunoCryptoError';
      var ctx = info || {};
      /** @type {string} */
      this.stage = ctx.stage || 'unknown';
      /** @type {string|undefined} */
      this.clipId = ctx.clipId;
      /** @type {number|undefined} */
      this.status = ctx.status;
      /** @type {string} */
      this.reason = ctx.reason || 'unspecified';
      if (ctx.cause) {
        /** Original exception, kept for `instanceof` checks only. */
        this.cause = ctx.cause;
        /** WebCrypto `DOMException.name`, e.g. 'OperationError'. Never the message. */
        this.causeName = ctx.cause && ctx.cause.name ? String(ctx.cause.name) : 'Error';
      }
      if (Error.captureStackTrace) Error.captureStackTrace(this, SunoCryptoError);
    }

    /**
     * True for a `/api/mango/rights` failure: non-2xx, unparseable JSON, or a
     * 2xx that is missing `key`/`iv`.
     * @param {unknown} err
     * @returns {boolean}
     */
    static isRightsError(err) {
      return !!err && err.stage === STAGES.RIGHTS;
    }

    /**
     * True for any failure of the crypto stages: key import, envelope unwrap,
     * or the AES-CTR media pass. AES-GCM auth-tag failure surfaces here too,
     * which is the signature of a wrong user key (see the bearer/glt note).
     * @param {unknown} err
     * @returns {boolean}
     */
    static isDecryptError(err) {
      return !!err && (err.stage === STAGES.DECRYPT || err.stage === STAGES.UNWRAP ||
        err.stage === STAGES.IMPORT);
    }

    /**
     * True when decryption succeeded but the plaintext is not a recognizable
     * audio container. With AES-CTR this almost always means the counter was
     * advanced by the wrong byte offset.
     * @param {unknown} err
     * @returns {boolean}
     */
    static isVerificationError(err) {
      return !!err && err.stage === STAGES.VERIFY;
    }

    /**
     * Non-sensitive plain object, safe to log or post to an error reporter.
     * @returns {{name: string, message: string, stage: string, reason: string, clipId: (string|undefined), status: (number|undefined), causeName: (string|undefined)}}
     */
    toJSON() {
      return {
        name: this.name,
        message: this.message,
        stage: this.stage,
        reason: this.reason,
        clipId: this.clipId,
        status: this.status,
        causeName: this.causeName
      };
    }
  }

  /* ================================================================== *
   * environment access (service worker + content script + node)
   * ================================================================== */

  /**
   * Resolve the global object without assuming `window` (an MV3 service worker
   * has no `window`) and without assuming `self` (node has neither).
   * @returns {object|null}
   */
  function getGlobal() {
    if (typeof globalThis !== 'undefined') return globalThis;
    /* istanbul ignore next - only reached on pre-globalThis engines */
    if (typeof self !== 'undefined') return self;
    /* istanbul ignore next */
    if (typeof window !== 'undefined') return window;
    /* istanbul ignore next */
    return null;
  }

  /**
   * Fetch `crypto.subtle`, or throw a typed error explaining that this context
   * is not a secure context. `window.isSecureContext` is false on plain-http
   * pages, where `crypto.subtle` is simply absent — the old file called
   * `crypto.subtle.digest` unguarded and died with `TypeError`.
   * @param {string} [clipId]
   * @returns {SubtleCrypto}
   */
  function getSubtle(clipId) {
    var g = getGlobal();
    var c = (g && (g.crypto || g.msCrypto)) || null;
    if (!c || !c.subtle) {
      throw new SunoCryptoError(
        'WebCrypto (crypto.subtle) is unavailable in this context; a secure context is required.',
        { stage: STAGES.IMPORT, clipId: clipId, reason: 'webcrypto-unavailable' }
      );
    }
    return c.subtle;
  }

  /* ================================================================== *
   * byte coercion
   * ================================================================== */

  /**
   * Coerce strings / ArrayBuffers / TypedArrays / DataViews to a `Uint8Array`.
   * A `Uint8Array` view over a larger buffer is preserved byte-exactly
   * (byteOffset honoured) rather than copied from offset zero.
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView|string} input
   * @returns {Uint8Array}
   */
  function asBytes(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string') {
      return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(input) : utf8Encode(input);
    }
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return new Uint8Array(0);
  }

  /**
   * Minimal UTF-8 encoder, used only where `TextEncoder` is missing (very old
   * runtimes). Handles surrogate pairs.
   * @param {string} str
   * @returns {Uint8Array}
   */
  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  /* ================================================================== *
   * base64 / base64url
   * ================================================================== */

  /**
   * Value of one base64 or base64url character, or -1 when illegal.
   * @param {string} ch
   * @returns {number}
   */
  function b64Value(ch) {
    if (ch in B64_URL_SUBSTITUTES) return B64_URL_SUBSTITUTES[ch];
    var idx = B64_STD.indexOf(ch);
    return idx;
  }

  /**
   * Strict base64 / base64url decoder. Returns `null` — never throws — when
   * the input is not canonical base64.
   *
   * "Canonical" is doing real work here and is what makes the decoder
   * *tolerant but not credulous*:
   *
   *   - the alphabet is checked (no spaces, no other punctuation);
   *   - `len % 4 === 1` is impossible and rejected;
   *   - padding must be 0-2 `=` and must complete a 4-char group;
   *   - **the unused low bits of the final group must be zero.**
   *
   * That last rule is what rejects `'zz'`. It is two characters of the alphabet
   * so it is syntactically valid base64 for 1 byte, but the trailing bits are
   * `11` where canonical encoding requires `00`; `'zz'` is text that merely
   * *looks* like base64, not an encoded byte. Without this rule `toBytes('zz')`
   * would silently return `[0xcf]`. Conversely `'aGk'` (the unpadded encoding
   * of `'hi'`) has zero trailing bits and decodes.
   *
   * @param {string} input
   * @returns {Uint8Array|null} `null` when `input` is not canonical base64.
   */
  function decodeBase64Strict(input) {
    var str = String(input).replace(/\s+/g, '');
    if (!str) return null;

    var pad = 0;
    while (str.length > 0 && str.charAt(str.length - 1) === '=') {
      pad++;
      str = str.slice(0, -1);
    }
    if (pad > 2) return null;

    var n = str.length;
    if (n === 0) return pad > 0 ? new Uint8Array(0) : null;
    if (n % 4 === 1) return null;
    if (pad > 0 && (n + pad) % 4 !== 0) return null;

    var out = new Uint8Array(Math.floor((n * 3) / 4));
    var acc = 0;
    var bits = 0;
    var o = 0;
    for (var i = 0; i < n; i++) {
      var v = b64Value(str.charAt(i));
      if (v < 0) return null;
      acc = ((acc << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (acc >>> bits) & 0xff;
      }
    }
    // Canonical-encoding check: trailing bits that carry no data must be zero.
    if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
    return out;
  }

  /* ================================================================== *
   * public surface
   * ================================================================== */

  /**
   * Suno media decryption primitives. Every member is a static so that both the
   * class and an instance carrying mirrored statics can be used interchangeably.
   * @class
   */
  class SunoCrypto {
    /* -------------------------------------------------------------- *
     * decoding
     * -------------------------------------------------------------- */

    /**
     * UTF-8 encode a string.
     *
     * Use this — NEVER {@link SunoCrypto.toBytes} — for text that feeds WebCrypto:
     * the AES-GCM additional authenticated data is `rights.aad || clipId`, and a
     * clip ID is *entirely composed of base64-legal characters* (`l`, `i`, `d`,
     * `0`-`9`, `-`). `toBytes('clip-1')` reads as base64 and yields 4 wrong
     * bytes; `utf8Bytes('clip-1')` yields the right 6. Getting this backwards
     * produces `unwrap-auth-failed` on every single clip, which looks exactly
     * like a wrong user key and sends you chasing the bearer/glt question for
     * hours. `asBytes()` already routes strings here, so passing a plain string
     * as `aad` is safe.
     * @param {string} str
     * @returns {Uint8Array}
     */
  static utf8Bytes(str) {
      return asBytes(str == null ? '' : String(str));
    }

  /**
     * Decode a Suno key material string into bytes.
     *
     * Accepts, in this precedence order:
     *   1. **hex** — `/^[0-9a-fA-F]+$/`, even length, no `=`.
     *   2. **base64 / base64url** — padded, block-aligned, or unpadded-and-long.
     *
     * NEVER THROWS. Returns an empty `Uint8Array` for `null`, `undefined`, `''`,
     * and anything that is not a well-formed encoding — including text that
     * merely resembles base64.
     *
     * *** THIS IS A KEY-MATERIAL DECODER. DO NOT FEED IT TEXT. *** See
     * {@link utf8Bytes} for the trap: `'clip-1'` is six legal base64 characters
     * and decodes to four nonsense bytes here. Everything Suno returns through
     * this path is a key, an IV, or a nonce, so the decoder is tuned to accept
     * exactly those shapes and to reject prose:
     *
     *   - padded base64 whose length is a multiple of 4 — accepted;
     *   - unpadded base64url whose length is a multiple of 4 — accepted;
     *   - unpadded base64url of length % 4 in {2, 3} — accepted ONLY if it
     *     decodes to >= 8 bytes. A 16-byte key is 22 unpadded chars, a 32-byte
     *     key is 43; nothing shorter is key material. This is the rule that
     *     rejects `'clip-1'` (6 chars -> 4 bytes) and `'zz'` (2 chars -> 1 byte)
     *     instead of silently mistaking them for ciphertext.
     *   - everything else — empty.
     *
     * Trailing-bit canonicality is additionally enforced (see
     * {@link decodeBase64Strict}), so `'zz'` is rejected on two independent
     * grounds.
     *
     * @param {string|Uint8Array|ArrayBuffer|null|undefined} str
     * @returns {Uint8Array} Decoded bytes, or a zero-length array on garbage.
     * @example
     *   SunoCrypto.toBytes('');           // Uint8Array(0)
     *   SunoCrypto.toBytes('zz');          // Uint8Array(0)
     *   SunoCrypto.toBytes('clip-1');      // Uint8Array(0)  — text, not a key
     *   SunoCrypto.toBytes('48656c6c6f');  // 48 65 6c 6c 6f  ("Hello")
     *   SunoCrypto.toBytes('aGVsbG8=');    // 68 65 6c 6c 6f  ("hello")
     */
    static toBytes(str) {
      if (str == null) return new Uint8Array(0);
      if (str instanceof Uint8Array) return str;
      if (str instanceof ArrayBuffer || ArrayBuffer.isView(str)) return asBytes(str);
      if (typeof str !== 'string') return new Uint8Array(0);

      var clean = str.trim();
      if (!clean) return new Uint8Array(0);

      if (/^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0 && clean.indexOf('=') === -1) {
        var out = new Uint8Array(clean.length / 2);
        for (var i = 0; i < clean.length; i += 2) {
          out[i / 2] = parseInt(clean.substr(i, 2), 16);
        }
        return out;
      }

      // Padded forms are unambiguous, so take them at any decoded length.
      var isPadded = clean.indexOf('=') !== -1;
      var decoded = decodeBase64Strict(clean);
      if (decoded === null) return new Uint8Array(0);
      if (isPadded || clean.replace(/=+$/, '').length % 4 === 0) return decoded;
      // Unpadded and NOT block-aligned: only believe it if it is key-sized.
      return decoded.length >= 8 ? decoded : new Uint8Array(0);
    }

    /**
     * Decode a base64url string (RFC 4648 §5) to bytes. Returns an empty array
     * rather than throwing on malformed input; see {@link decodeBase64Strict}
     * for the canonicality rules, which apply here too.
     * @param {string} str
     * @returns {Uint8Array}
     */
    static fromBase64Url(str) {
      var decoded = str == null ? null : decodeBase64Strict(String(str));
      return decoded === null ? new Uint8Array(0) : decoded;
    }

    /**
     * Encode bytes as unpadded base64url. Inverse of {@link fromBase64Url}.
     * Unpadded because that is what every JS-side URL-safe encoder consumes;
     * `fromBase64Url` reads padded input as well.
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
     * @returns {string}
     */
    static toBase64Url(bytes) {
      var b = asBytes(bytes);
      var out = '';
      var i = 0;
      for (; i + 2 < b.length; i += 3) {
        var n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
        out += B64_STD.charAt((n >> 18) & 63) + B64_STD.charAt((n >> 12) & 63) +
          B64_STD.charAt((n >> 6) & 63) + B64_STD.charAt(n & 63);
      }
      var rem = b.length - i;
      if (rem === 1) {
        var a = b[i] << 16;
        out += B64_STD.charAt((a >> 18) & 63) + B64_STD.charAt((a >> 12) & 63);
      } else if (rem === 2) {
        var c = (b[i] << 16) | (b[i + 1] << 8);
        out += B64_STD.charAt((c >> 18) & 63) + B64_STD.charAt((c >> 12) & 63) +
          B64_STD.charAt((c >> 6) & 63);
      }
      return out.replace(/\+/g, '-').replace(/\//g, '_');
    }

    /**
     * SHA-256 digest.
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView|string} input Bytes, or a
     *   string which is UTF-8 encoded first.
     * @returns {Promise<Uint8Array>} 32 raw digest bytes.
     */
    static async sha256(input) {
      var subtle = getSubtle();
      var digest = await subtle.digest('SHA-256', asBytes(input));
      return new Uint8Array(digest);
    }

    /**
     * Truncated SHA-256 of a value, as lowercase hex — used as a cache key so
     * that key material is never itself the map key. NOT reversible, but it IS
     * derived from secrets, so `redact()` treats a field named `fingerprint`
     * as sensitive and never logs it.
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView|string} input
     * @param {number} [hexChars=16]
     * @returns {Promise<string>}
     */
    static async fingerprint(input, hexChars) {
      var digest = await SunoCrypto.sha256(input);
      var chars = typeof hexChars === 'number' ? hexChars : 16;
      var hex = '';
      for (var i = 0; i < digest.length && hex.length < chars; i++) {
        var h = digest[i].toString(16);
        hex += h.length === 1 ? '0' + h : h;
      }
      return hex.slice(0, chars);
    }

    /* -------------------------------------------------------------- *
     * key import (validate BEFORE calling WebCrypto)
     * -------------------------------------------------------------- */

    /**
     * Import an AES-GCM key from raw bytes, validating the length first.
     *
     * WebCrypto's own validation for a bad length is an opaque
     * `DataError`/`OperationError`; that is exactly the bug the old file had.
     * This throws a typed {@link SunoCryptoError} with
     * `stage: 'import'`, `reason: 'key-length-invalid'` instead, stating the
     * actual and required lengths.
     *
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView} rawBytes
     * @param {string} [clipId]
     * @returns {Promise<CryptoKey>} Non-extractable, `decrypt` only.
     */
    static async importAesGcmKey(rawBytes, clipId) {
      var raw = asBytes(rawBytes);
      if (AES_KEY_SIZES.indexOf(raw.length) === -1) {
        throw new SunoCryptoError(
          'AES-GCM key must be 16, 24, or 32 bytes; got ' + raw.length + '.',
          { stage: STAGES.IMPORT, clipId: clipId, reason: 'key-length-invalid' }
        );
      }
      var subtle = getSubtle(clipId);
      try {
        return await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
      } catch (cause) {
        throw new SunoCryptoError(
          'AES-GCM key import failed (' + (cause && cause.name ? cause.name : 'Error') + ').',
          { stage: STAGES.IMPORT, clipId: clipId, reason: 'key-import-failed', cause: cause }
        );
      }
    }

    /**
     * Import an AES-CTR content key from raw bytes, validating the length first.
     * Same typed-error contract as {@link importAesGcmKey}.
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView} rawBytes
     * @param {string} [clipId]
     * @returns {Promise<CryptoKey>} Non-extractable, `decrypt` only.
     */
    static async importAesCtrKey(rawBytes, clipId) {
      var raw = asBytes(rawBytes);
      if (AES_KEY_SIZES.indexOf(raw.length) === -1) {
        throw new SunoCryptoError(
          'AES-CTR key must be 16, 24, or 32 bytes; got ' + raw.length + '.',
          { stage: STAGES.IMPORT, clipId: clipId, reason: 'key-length-invalid' }
        );
      }
      var subtle = getSubtle(clipId);
      try {
        return await subtle.importKey('raw', raw, { name: 'AES-CTR' }, false, ['decrypt']);
      } catch (cause) {
        throw new SunoCryptoError(
          'AES-CTR key import failed (' + (cause && cause.name ? cause.name : 'Error') + ').',
          { stage: STAGES.IMPORT, clipId: clipId, reason: 'key-import-failed', cause: cause }
        );
      }
    }

    /* -------------------------------------------------------------- *
     * envelope unwrap
     * -------------------------------------------------------------- */

    /**
     * Unwrap a Suno key-material envelope under the per-user AES-GCM key.
     *
     * Layout: `iv(12) || ciphertext || tag(16)`.
     *
     * Three cases, in order:
     *   1. **16 or 32 bytes** → return as-is. Not every payload is wrapped; a
     *      bare 16-byte IV or bare 32-byte key is legal and MUST NOT be fed to
     *      AES-GCM. The old file had no such branch and rejected those payloads.
     *   2. **>= 28 bytes** → AES-GCM decrypt with the first 12 bytes as the
     *      nonce and the rest as `ciphertext || tag`. 28 is the floor:
     *      12 (nonce) + 16 (tag) + 0 (ciphertext). Anything 17..27 bytes is
     *      structurally impossible as GCM and is reported as such instead of
     *      being handed to WebCrypto as an opaque `OperationError`.
     *   3. **anything else** → return as-is (short opaque payload).
     *
     * An authentication-tag failure here is the signature of the wrong user key
     * — see the bearer-vs-`glt` note at the top of this file.
     *
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView} rawBytes
     * @param {CryptoKey} userKey  AES-GCM key from `SHA-256(bearer|glt)`.
     * @param {Uint8Array|string} [aad]  Additional authenticated data;
     *   `rights.aad || clipId`.
     * @param {string} [clipId]
     * @returns {Promise<Uint8Array>} Unwrapped bytes.
     */
    static async unwrapEnvelope(rawBytes, userKey, aad, clipId) {
      var raw = asBytes(rawBytes);

      if (raw.length === 16 || raw.length === 32) return raw;

      if (raw.length >= GCM_ENVELOPE_MIN) {
        if (!userKey) {
          throw new SunoCryptoError(
            'Envelope is AES-GCM wrapped but no user key was supplied.',
            { stage: STAGES.UNWRAP, clipId: clipId, reason: 'user-key-missing' }
          );
        }
        var iv = raw.subarray(0, GCM_IV_BYTES);
        var ciphertext = raw.subarray(GCM_IV_BYTES);
        // ciphertext here INCLUDES the trailing 16-byte tag, so a legal
        // WebCrypto input needs >= 16 bytes.
        if (ciphertext.length < GCM_TAG_BYTES) {
          throw new SunoCryptoError(
            'AES-GCM envelope body must be at least ' + GCM_TAG_BYTES +
            ' bytes (nonce+tag only); got ' + ciphertext.length + '.',
            { stage: STAGES.UNWRAP, clipId: clipId, reason: 'ciphertext-too-short' }
          );
        }
        var subtle = getSubtle(clipId);
        var params = { name: 'AES-GCM', iv: iv };
        if (aad != null) params.additionalData = asBytes(aad);
        try {
          var plain = await subtle.decrypt(params, userKey, ciphertext);
          return new Uint8Array(plain);
        } catch (cause) {
          // Almost always "the user key is wrong", not "the data is corrupt".
          throw new SunoCryptoError(
            'AES-GCM envelope unwrap failed (' +
            (cause && cause.name ? cause.name : 'Error') +
            '); the per-user key seed is probably wrong (bearer vs glt).',
            { stage: STAGES.UNWRAP, clipId: clipId, reason: 'unwrap-auth-failed', cause: cause }
          );
        }
      }

      if (raw.length > 16 && raw.length < GCM_ENVELOPE_MIN) {
        throw new SunoCryptoError(
          'Envelope length ' + raw.length + ' is impossible for AES-GCM (need >= ' +
          GCM_ENVELOPE_MIN + ') and is not a bare 16/32-byte value.',
          { stage: STAGES.UNWRAP, clipId: clipId, reason: 'envelope-length-invalid' }
        );
      }

      return raw;
    }

    /* -------------------------------------------------------------- *
     * counter arithmetic
     * -------------------------------------------------------------- */

    /**
     * 128-bit big-endian counter addition — the piece that makes chunked
     * AES-CTR byte-exact.
     *
     * WebCrypto's AES-CTR takes an opaque counter block and has no "skip N
     * blocks" parameter, so to decrypt chunk `i` you must hand it the counter
     * the whole buffer would have used for that chunk's first block. That value
     * is `iv16 + delta` computed as a **128-bit big-endian integer**, with
     * carry propagating out of the least-significant byte. Doing this in
     * `Number` is wrong past 2^53; doing it byte-wise is exact.
     *
     * *** UNIT OF `delta`: AES BLOCKS, NOT BYTES. *** This is the single
     * easiest thing to get wrong here, and it is worth stating loudly because
     * the recon notes are written in byte terms:
     *
     *   - In AES-CTR the counter block counts **blocks**. It advances by one per
     *     16-byte block consumed, not by 16.
     *   - The WebCrypto spec says the same: for each block the `length`-bit
     *     counter is incremented by 1 and re-encrypted.
     *   - Therefore a chunk starting at byte offset `o` needs
     *     `incrementCounter(iv16, o / 16)`, NOT `iv + o`.
     *
     * Empirically confirmed on this machine (node 26 / OpenSSL 3.6, same spec
     * as Chromium): decrypting 32 zero bytes with `counter = iv, length: 128`
     * yields keystream block 0 = `E(iv)` and block 1 = `E(iv + 1)`. Passing
     * `counter = iv + 16` instead yields a keystream that does NOT match block 1.
     * Adding the byte offset therefore desynchronises the keystream by 16x and
     * produces well-formed garbage — which is exactly what
     * {@link verifyContainer} exists to catch.
     *
     * Carrying is exact across every byte, including the byte-8 boundary. The
     * case that breaks naive implementations: counter `00…0001` plus
     * `0xFFFFFFFF` must yield `…000100000000` (the low 32 bits roll to zero and
     * the carry lands in the byte above), not a truncated `00000000`.
     *
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView} counter16  Exactly 16 bytes.
     * @param {number} delta  Non-negative integer to add, **in 16-byte blocks**
     *   (< 2^53). For a byte offset pass `offset / 16`.
     * @returns {Uint8Array} A NEW 16-byte block; the input is not mutated.
     */
    static incrementCounter(counter16, delta) {
      var src = asBytes(counter16);
      if (src.length !== CTR_BLOCK_BYTES) {
        throw new SunoCryptoError(
          'AES-CTR counter must be exactly ' + CTR_BLOCK_BYTES + ' bytes; got ' + src.length + '.',
          { stage: STAGES.DECRYPT, reason: 'counter-length-invalid' }
        );
      }
      var step = Number(delta);
      if (!isFinite(step) || step < 0 || Math.floor(step) !== step) {
        throw new SunoCryptoError(
          'Counter delta must be a non-negative integer; got ' + String(delta) + '.',
          { stage: STAGES.DECRYPT, reason: 'counter-delta-invalid' }
        );
      }

      var out = new Uint8Array(CTR_BLOCK_BYTES);
      out.set(src);
      // Consume `step` least-significant-first, keeping the remainder an exact
      // integer so nothing is lost to float rounding.
      var remaining = step;
      for (var i = CTR_BLOCK_BYTES - 1; i >= 0; i--) {
        var add = remaining % 256;
        remaining = (remaining - add) / 256;
        var sum = out[i] + add;
        out[i] = sum & 0xff;
        if (sum > 0xff) remaining += 1; // carry into the next-more-significant byte
      }
      return out;
    }

    /* -------------------------------------------------------------- *
     * media decryption
     * -------------------------------------------------------------- */

/**
     * Decrypt an AES-CTR media buffer in fixed-size chunks.
     *
     * Chunk at byte offset `o` is decrypted with
     * `incrementCounter(iv16, o / 16)` — **blocks, not bytes**, per
     * {@link incrementCounter}. The keystream is therefore identical to what a
     * single-shot decrypt of the whole buffer would have produced, which is the
     * only definition of correct that matters: the single-shot decrypt is the
     * form three independent implementations ship and the one known to yield
     * playable audio.
     *
     * `chunkSize` is forced to a multiple of 16 so `o / 16` is always an exact
     * integer and chunk boundaries land on whole AES blocks. Chunk boundaries
     * are byte-exact by construction; a one-block desync yields
     * silence-to-garbage, which is why {@link verifyContainer} exists.
     *
     * Peak memory is one chunk of plaintext plus the input, not N chunks, which
     * is what makes a long clip survivable where the reference's single
     * `subtle.decrypt` of the whole buffer is not.
     *
     * @param {Uint8Array|ArrayBuffer} bytes  Ciphertext media bytes.
     * @param {CryptoKey} contentKey  AES-CTR key (16/24/32 bytes).
     * @param {Uint8Array} counter16  16-byte initial counter block (the IV).
     * @param {object} [opts]
     * @param {number} [opts.chunkSize=262144]  Rounded down to a multiple of 16.
     * @param {number} [opts.counterLength=128]  AES-CTR counter bits. The
     *   reference retries with 64 when an engine rejects 128; Chromium accepts
     *   128, so this is opt-in. Note the counter *value* is the same either way;
     *   `length` only bounds how many of its bits participate in the increment.
     * @param {AbortSignal} [opts.signal]
     * @param {string} [opts.clipId]
     * @param {(p: {loaded: number, total: number, chunks: number}) => void} [opts.onProgress]
     * @returns {Promise<Uint8Array>} Plaintext of the same total length.
     */
    static async decryptAesCtrChunked(bytes, contentKey, counter16, opts) {
      var o = opts || {};
      var clipId = o.clipId;
      var subtle = getSubtle(clipId);

      var input = asBytes(bytes);
      var iv = asBytes(counter16);
      if (iv.length !== CTR_BLOCK_BYTES) {
        throw new SunoCryptoError(
          'AES-CTR counter must be exactly ' + CTR_BLOCK_BYTES + ' bytes; got ' + iv.length + '.',
          { stage: STAGES.DECRYPT, clipId: clipId, reason: 'counter-length-invalid' }
        );
      }
      if (!contentKey) {
        throw new SunoCryptoError('AES-CTR content key is missing.', {
          stage: STAGES.DECRYPT, clipId: clipId, reason: 'content-key-missing'
        });
      }

      var counterLength = typeof o.counterLength === 'number' ? o.counterLength : DEFAULT_CTR_LENGTH;
      if (counterLength <= 0 || counterLength % 8 !== 0 || counterLength > 128) {
        throw new SunoCryptoError(
          'AES-CTR counter length must be a multiple of 8 in (0, 128]; got ' + counterLength + '.',
          { stage: STAGES.DECRYPT, clipId: clipId, reason: 'ctr-length-invalid' }
        );
      }

      var chunkSize = typeof o.chunkSize === 'number' && o.chunkSize >= 16
        ? o.chunkSize - (o.chunkSize % 16)
        : DEFAULT_CHUNK_SIZE;

      var total = input.length;
      var out = new Uint8Array(total);
      var chunks = Math.ceil(total / chunkSize) || 0;
      var baseCounter = new Uint8Array(CTR_BLOCK_BYTES);
      baseCounter.set(iv);

      for (var offset = 0; offset < total; offset += chunkSize) {
        if (o.signal && o.signal.aborted) {
          throw new SunoCryptoError('Decryption aborted.', {
            stage: STAGES.DECRYPT, clipId: clipId, reason: 'aborted'
          });
        }
        var length = Math.min(chunkSize, total - offset);
        // The counter counts BLOCKS: a chunk starting `offset` bytes in resumes
        // at block `offset / 16`. `chunkSize` is a multiple of 16, so this
        // division is always exact. See incrementCounter() for why adding the
        // byte offset here would be 16x wrong.
        var chunkCounter = offset === 0
          ? baseCounter
          : SunoCrypto.incrementCounter(baseCounter, offset / CTR_BLOCK_BYTES);
        var view = input.subarray(offset, offset + length);
        try {
          var plain = await subtle.decrypt(
            { name: 'AES-CTR', counter: chunkCounter, length: counterLength },
            contentKey,
            view
          );
          out.set(new Uint8Array(plain), offset);
        } catch (cause) {
          throw new SunoCryptoError(
            'AES-CTR chunk at offset ' + offset + ' failed (' +
            (cause && cause.name ? cause.name : 'Error') + '); try counterLength 64.',
            { stage: STAGES.DECRYPT, clipId: clipId, reason: 'ctr-chunk-failed', cause: cause }
          );
        }
        if (o.onProgress) o.onProgress({ loaded: offset + length, total: total, chunks: chunks });
      }

      if (o.onProgress && total === 0) o.onProgress({ loaded: 0, total: 0, chunks: 0 });
      return out;
    }

    /**
     * Verify that decrypted bytes are actually an audio container.
     *
     * AES-CTR provides NO authentication. A wrong counter, a wrong key, or a
     * truncated body all "succeed" and produce N bytes of confident nonsense.
     * Sniffing the container is therefore the only local integrity check
     * available, and the old file had none — it would hand the caller a corrupt
     * `.m4a` and call it success.
     *
     * Accepted:
     *   - `m4a` — ISO-BMFF: bytes 4..8 are the ASCII `ftyp` box type.
     *   - `mp3`  — bytes 0..3 are the ASCII `ID3` tag, or bytes 0..1 are an
     *     MPEG audio frame sync (`0xFF 0xEx`/`0xFx`) for a raw stream.
     *   - otherwise `unknown`.
     *
     * @param {Uint8Array|ArrayBuffer} bytes
     * @returns {'m4a'|'mp3'|'unknown'}
     */
    static detectContainer(bytes) {
      var b = asBytes(bytes);
      if (b.length >= 8 &&
        b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a'; // 'ftyp'
      if (b.length >= 4 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3'; // 'ID3'
      if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'; // frame sync
      return 'unknown';
    }

    /**
     * Container sniff that throws instead of returning `'unknown'`.
     *
     * A failed check MUST be a typed failure, never a silent success — that is
     * the whole point of having this separate from
     * {@link detectContainer}. Pass `allowUnknown: true` to downgrade to a
     * returned `'unknown'` (used when probing is deliberately lenient).
     *
     * @param {Uint8Array|ArrayBuffer} bytes
     * @param {object} [opts]
     * @param {string} [opts.clipId]
     * @param {boolean} [opts.allowUnknown=false]
     * @returns {'m4a'|'mp3'|'unknown'}
     */
    static verifyContainer(bytes, opts) {
      var o = opts || {};
      var container = SunoCrypto.detectContainer(bytes);
      if (container === 'unknown' && !o.allowUnknown) {
        var b = asBytes(bytes);
        throw new SunoCryptoError(
          'Decrypted payload is not a recognized audio container after ' + b.length +
          ' bytes (no ISO-BMFF "ftyp" box at offset 4, no "ID3" tag). ' +
          'With AES-CTR this means the counter offset or key is wrong, not that the data is corrupt.',
          { stage: STAGES.VERIFY, clipId: o.clipId, reason: 'container-unrecognized' }
        );
      }
      return container;
    }

    /* -------------------------------------------------------------- *
     * backward-compatible entry point
     * -------------------------------------------------------------- */

    /**
     * Legacy entry point, preserved so existing callers keep working.
     *
     * Old signature: `decryptMediaBuffer(clipId, rights, mediaBuffer)`.
     * It resolved the per-user key as `SHA-256(rights.glt)` and always ran the
     * single-shot AES-CTR decrypt. This implementation reproduces that
     * behaviour — with the chunked engine underneath, which for any buffer
     * under one chunk is byte-identical to the single-shot call — while
     * adding envelope passthrough, length validation, and typed errors.
     *
     * @param {string} clipId
     * @param {{key: string, iv: string, glt: string, aad?: string}} rights
     * @param {ArrayBuffer|Uint8Array} mediaBuffer
     * @param {object} [opts] Forwarded to {@link decryptAesCtrChunked}.
     * @returns {Promise<ArrayBuffer>} Decrypted audio, same length as input.
     */
    static async decryptMediaBuffer(clipId, rights, mediaBuffer, opts) {
      if (!rights || !rights.glt || !rights.key || !rights.iv) {
        throw new SunoCryptoError('Incomplete rights payload for decryption.', {
          stage: STAGES.RIGHTS, clipId: clipId, reason: 'incomplete-rights-payload'
        });
      }
      var o = opts || {};
      var userKey = await SunoCrypto.importAesGcmKey(
        await SunoCrypto.sha256(String(rights.glt)), clipId
      );
      var aad = rights.aad != null ? rights.aad : clipId;
      var contentKeyBytes = await SunoCrypto.unwrapEnvelope(
        SunoCrypto.toBytes(rights.key), userKey, aad, clipId);
      var contentIvBytes = await SunoCrypto.unwrapEnvelope(
        SunoCrypto.toBytes(rights.iv), userKey, aad, clipId);
      var contentKey = await SunoCrypto.importAesCtrKey(contentKeyBytes, clipId);
      var plain = await SunoCrypto.decryptAesCtrChunked(
        mediaBuffer, contentKey, contentIvBytes, {
          clipId: clipId,
          chunkSize: o.chunkSize,
          counterLength: o.counterLength,
          signal: o.signal
        }
      );
      return plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
    }

    /* -------------------------------------------------------------- *
     * redaction
     * -------------------------------------------------------------- */

    /**
     * Field names that are secret regardless of position.
     * @type {Object<string, true>}
     */
    static _SENSITIVE_EXACT = {
      key: true, keys: true, iv: true, iv16: true, glt: true, glt_token: true,
      contentkey: true, content_key: true, contentiv: true, content_iv: true,
      userkey: true, user_key: true, keymaterial: true, key_material: true,
      token: true, accesstoken: true, access_token: true, refreshtoken: true,
      refresh_token: true, authorization: true, auth: true, bearer: true,
      cookie: true, setcookie: true, password: true, secret: true,
      credential: true, credentials: true, fingerprint: true, digest: true,
      aad: true, additionaldata: true, additional_data: true
    };

    /**
     * Suffixes that mark a field as secret.
     * @type {string[]}
     */
    static _SENSITIVE_SUFFIX = [
      'key', 'keys', 'iv', 'token', 'glt', 'secret', 'password',
      'credential', 'credentials', 'cookie', 'fingerprint', 'digest'
    ];

    /**
     * Substrings that mark a field as secret.
     * @type {string[]}
     */
    static _SENSITIVE_PART = ['password', 'credential', 'authorization', 'cookie', 'bearer', 'apikey'];

    /**
     * Is this field name sensitive?
     * @param {string} name
     * @returns {boolean}
     */
    static _isSensitiveName(name) {
      var n = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (SunoCrypto._SENSITIVE_EXACT[n]) return true;
      for (var i = 0; i < SunoCrypto._SENSITIVE_SUFFIX.length; i++) {
        var suf = SunoCrypto._SENSITIVE_SUFFIX[i];
        if (n.length > suf.length && n.slice(-suf.length) === suf) return true;
      }
      for (var j = 0; j < SunoCrypto._SENSITIVE_PART.length; j++) {
        if (n.indexOf(SunoCrypto._SENSITIVE_PART[j]) !== -1) return true;
      }
      return false;
    }

    /**
     * Produce a deep, log-safe copy of `value`.
     *
     * Two independent guarantees, either of which alone stops a leak:
     *   1. **Every** byte array is replaced by `'[bytes:N]'`, whatever its field
     *      name. There is therefore no way to smuggle key bytes out under an
     *      innocuous-looking property.
     *   2. Every field whose *name* looks sensitive is replaced by
     *      `'[redacted]'`, so key/iv/glt/token never appear even as short
     *      strings.
     *
     * Cycles are handled. Depth is bounded. Class instances are reduced to
     * their own enumerable properties. `CryptoKey` is not inspectable anyway
     * (non-extractable) and is reported as `'[CryptoKey]'`.
     *
     * @param {*} value
     * @param {object} [opts]
     * @param {number} [opts.maxDepth=6]
     * @returns {*} A structurally similar value with no secrets in it.
     */
    static redact(value, opts) {
      var maxDepth = opts && typeof opts.maxDepth === 'number' ? opts.maxDepth : 6;
      var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

      /**
       * @param {*} v
       * @param {number} depth
       * @param {string|null] keyName
       * @returns {*}
       */
      function walk(v, depth, keyName) {
        if (v == null) return v;
        if (typeof v === 'bigint') return v.toString() + 'n';
        if (typeof v !== 'object') {
          // Primitives: only suppress under a sensitive name; short numeric and
          // boolean payloads are harmless and useful in a log.
          return keyName != null && SunoCrypto._isSensitiveName(keyName) ? '[redacted]' : v;
        }
        if (keyName != null && SunoCrypto._isSensitiveName(keyName)) return '[redacted]';

        var t = Object.prototype.toString.call(v);
        if (t === '[object ArrayBuffer]' || ArrayBuffer.isView(v)) {
          return '[bytes:' + asBytes(v).length + ']';
        }
        if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) return '[CryptoKey]';
        if (t === '[object Error]' || v instanceof Error) {
          return v instanceof SunoCryptoError ? v.toJSON() : '[Error: ' + (v.name || 'Error') + ']';
        }
        if (depth >= maxDepth) return '[depth:' + maxDepth + ']';
        if (seen) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        if (Array.isArray(v)) {
          var arr = [];
          for (var i = 0; i < v.length; i++) arr.push(walk(v[i], depth + 1, null));
          return arr;
        }
        if (t === '[object Map]') {
          var mapOut = {};
          v.forEach(function (val, k) { mapOut[String(k)] = walk(val, depth + 1, String(k)); });
          return mapOut;
        }
        if (t === '[object Set]') {
          var setOut = [];
          v.forEach(function (val) { setOut.push(walk(val, depth + 1, null)); });
          return setOut;
        }
        var out = {};
        var keys;
        try {
          keys = Object.keys(v);
        } catch (err) {
          // Exotic proxy/getter failure: report the shape, never the value.
          return '[unreadable:' + (err && err.name ? err.name : 'Error') + ']';
        }
        for (var j = 0; j < keys.length; j++) {
          out[keys[j]] = walk(v[keys[j]], depth + 1, keys[j]);
        }
        return out;
      }

      return walk(value, 0, null);
    }
  }

  /* ================================================================== *
   * statics that are plain values
   * ================================================================== */

  /**
   * Pipeline stages used by {@link SunoCryptoError.stage}.
   * @type {Readonly<{PARSE: string, IMPORT: string, UNWRAP: string, DECRYPT: string, VERIFY: string, RIGHTS: string, MEDIA: string, CACHE: string}>}
   */
  SunoCrypto.STAGES = Object.freeze(STAGES);
  /** Default chunked AES-CTR chunk size, in bytes. @type {number} */
  SunoCrypto.CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
  /** AES-GCM nonce length expected inside an envelope. @type {number} */
  SunoCrypto.GCM_IV_BYTES = GCM_IV_BYTES;
  /** Smallest structurally valid AES-GCM envelope, in bytes. @type {number} */
  SunoCrypto.GCM_ENVELOPE_MIN = GCM_ENVELOPE_MIN;
  /** The error class, also reachable as `window.SunoCryptoError`. @type {typeof SunoCryptoError} */
  SunoCrypto.SunoCryptoError = SunoCryptoError;

  /* ================================================================== *
   * exposure
   * ================================================================== */

  /**
   * `window.SunoCrypto` is an INSTANCE whose prototype chain is a class, so
   * legacy static-style calls (`SunoCrypto.decryptMediaBuffer(...)`) and
   * instance-style calls (`SunoCrypto.toBytes(...)` on the global) both work.
   * Every own static is mirrored — functions AND value statics such as
   * `STAGES` and `CHUNK_SIZE`, which a function-only filter would drop.
   * Mirroring is safe because no static reads `this`.
   */
  var MIRRORED = Object.getOwnPropertyNames(SunoCrypto).filter(function (name) {
    return name !== 'length' && name !== 'name' && name !== 'prototype';
  });

  /** @type {SunoCrypto} */
  var instance = new SunoCrypto();
  MIRRORED.forEach(function (name) {
    try {
      instance[name] = SunoCrypto[name];
    } catch (err) {
      // A non-writable static. Nothing to clean up and nothing to report: the
      // class copy still works.
      void err;
    }
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SunoCrypto: instance,
      SunoCryptoClass: SunoCrypto,
      SunoCryptoError: SunoCryptoError
    };
  }

  if (typeof window !== 'undefined' && window) {
    window.SunoCrypto = instance;
    window.SunoCryptoClass = SunoCrypto;
    window.SunoCryptoError = SunoCryptoError;
  }
  // An MV3 service worker has no `window`; mirror onto the bare global there.
  if (typeof self !== 'undefined' && self && typeof window === 'undefined' && typeof globalThis !== 'undefined') {
    globalThis.SunoCrypto = instance;
    globalThis.SunoCryptoClass = SunoCrypto;
    globalThis.SunoCryptoError = SunoCryptoError;
  }
})();