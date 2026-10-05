/**
 * Suno Master Utility — lib/tagger.js
 * ---------------------------------------------------------------------------
 * Writes rich metadata INTO downloaded audio bytes for three containers:
 *
 *   MP3 -> ID3v2.3 tag prepended to the MPEG stream.
 *   M4A/MP4 -> iTunes-style `moov/udta/meta/ilst` atoms.
 *   WAV -> RIFF `LIST`/`INFO` sub-chunks AND a RIFF chunk literally named `id3 `.
 *
 * DESIGN CONSTRAINTS
 * - Pure byte/Blob work only. No network, no DOM, no `chrome.*`, no timers.
 *   Everything here runs unmodified inside an MV3 service worker.
 * - Every exported function is TOTAL: garbage in, safe value out, never throws.
 *   The single deliberate exception is `encodeSyncsafe` above 2^28-1, which
 *   throws a typed `SunoTagError` (an out-of-range syncsafe integer cannot be
 *   represented, and silently truncating it would corrupt every frame after it).
 * - Nothing is logged through `console`. Diagnostics go through an injected
 *   `logger` that defaults to a no-op, and any string that *does* get logged
 *   should go through `redact()` first.
 * - Wrapped in an IIFE; nothing leaks to global scope except the single
 *   `window.SunoTagger` / `module.exports` binding at the bottom.
 *
 * BUGS FIXED FROM THE PORTED USERSCRIPT REFERENCE
 * (`scratchpad/extracted/Suno Tracks Exporter/metadata.js`) — kept here as a
 * record so the same mistakes are not reintroduced:
 *
 *  1. `metadata.js` summed frame *payloads* into the ID3v2 header size field.
 *     The ID3v2 size field is the size of the whole tag body EXCLUDING the
 *     10-byte header, and each frame contributes `10 + payload.length`
 *     (frame ID + size + flags). `buildId3v23` computes `tagBodySize` exactly.
 *  2. `metadata.js` `createTextFrame` allocated `10 + len + 1` and wrote the
 *     encoding byte at offset 10 with the size field set to `len + 1` — that
 *     part was right — but it never sanitised NUL bytes, and a NUL inside an
 *     ID3v2.3 text frame terminates the string early and corrupts the reader's
 *     frame walk. All text here goes through `cleanText()`.
 *  3. `metadata.js` built COMM and USLT with two copy-pasted functions that had
 *     already drifted. Both now use one shared `buildLangPayload()` so the
 *     `encoding + language(3) + NUL-terminated descriptor + text` layout cannot
 *     diverge between them.
 *  4. `metadata.js` hardcoded APIC encoding `0x00`. Both `0x00` (ISO-8859-1)
 *     and `0x03` (UTF-8) are supported here, selected by a settings flag; the
 *     WMP-friendly default is configurable.
 *  5. `metadata.js` `createLyricsFrame` sized its buffer as `10 + 5 + len`
 *     which is correct only for an EMPTY descriptor; with a real descriptor the
 *     allocation was short. Sizes here are computed, never guessed.
 *  6. `metadata.js` had no overflow guard around `new Uint8Array(...)`. Cover
 *     art can exceed 2 MB, so every allocation is pre-sized exactly once from
 *     a measured total and filled with `set()` — never repeated concatenation.
 *  7. The RIFF note in the port request says the reference used big-endian via
 *     `setUint32(.., true)`. That is backwards: `true` is the *little-endian*
 *     argument, so the reference was already little-endian (correct per the
 *     RIFF spec). `buildRiffInfoChunk` here writes LITTLE-endian sizes and
 *     `check (d)` asserts the byte order explicitly.
 *
 * ARTIST FIELD — IMPORTANT, READ BEFORE CALLING
 * `clip.display_name` / `clip.handle` / `clip.user_id` on a Suno clip are the
 * OWNER's own account echoed back by the API. They are NOT a third-party artist.
 * Writing them into the `artist`/`TPE1`/`©ART` field labels the user's own
 * library with the user's own name, which breaks compilation/artist views in
 * most players and pollutes a library with self-referential entries.
 * Therefore the default artist is a NEUTRAL string derived from settings
 * (`options.artist`, default `'Suno AI'`), and the clip-owner identity is used
 * only when the caller explicitly opts in via `options.useClipOwnerAsArtist`.
 * See `resolveArtist()`.
 *
 * COVER ART MIME
 * The server `content-type` is not trusted: Suno's image CDN can serve
 * `image/jpeg` for a PNG. `sniffImageMime()` sniffs magic bytes first and only
 * falls back to a declared MIME that is one of the two accepted types.
 * (`FF D8 FF` = JPEG, `89 50 4E 47 0D 0A 1A 0A` = PNG.)
 */
(function () {
  'use strict';

  var SYNCSAFE_MAX = 0x0fffffff; // 2^28 - 1
  var ID3_HEADER_SIZE = 10;
  var U32_MAX = 0xffffffff;

  var EMPTY = new Uint8Array(0);

  var MIME_JPEG = 'image/jpeg';
  var MIME_PNG = 'image/png';

  /** MP4 `covr` well-known type codes. */
  var COVR_JPEG = 13;
  var COVR_PNG = 14;

  /** MP4 freeform atom namespace used by iTunes for foreign tags. */
  var ITUNES_MEAN = 'com.apple.iTunes';

  /* ---------------------------------------------------------------------- *
   * Errors
   * ---------------------------------------------------------------------- */

  /**
   * Typed error for the one class of failure we refuse to paper over.
   * @constructor
   * @extends Error
   * @param {string} message
   * @param {string} [code]
   */
  function SunoTagError(message, code) {
    var err = Error.call(this, message);
    this.name = 'SunoTagError';
    this.message = String(message);
    this.code = code || 'ESUNOTAG';
    if (Error.captureStackTrace) Error.captureStackTrace(this, SunoTagError);
    else if (err.stack) this.stack = err.stack;
  }
  SunoTagError.prototype = Object.create(Error.prototype);
  SunoTagError.prototype.constructor = SunoTagError;

  /* ---------------------------------------------------------------------- *
   * Diagnostics — injected, default no-op, never `console`
   * ---------------------------------------------------------------------- */

  function noop() {}

  var state = {
    logger: noop,
    defaultArtist: 'Suno AI',
    defaultAlbum: '',
    coverDescription: 'Cover',
    coverDescEncoding: 0, // 0x00 Latin-1 (WMP-friendly) | 0x03 UTF-8
    textEncoding: 3, // 0x03 UTF-8 for text frames
    language: 'eng',
    riffTextEncoding: 'utf8' // 'utf8' | 'latin1'
  };

  /**
   * Inject a logger and/or default settings. Safe to call repeatedly.
   * @param {{logger?:Function, artist?:string, album?:string,
   *   coverDescription?:string, coverDescEncoding?:number,
   *   textEncoding?:number, language?:string, riffTextEncoding?:string}} [opts]
   * @returns {object} the live settings object
   */
  function configure(opts) {
    if (opts && typeof opts === 'object') {
      if (typeof opts.logger === 'function') state.logger = opts.logger;
      else if (opts.logger === null) state.logger = noop;
      if (typeof opts.artist === 'string') state.defaultArtist = opts.artist;
      if (typeof opts.album === 'string') state.defaultAlbum = opts.album;
      if (typeof opts.coverDescription === 'string') state.coverDescription = opts.coverDescription;
      if (opts.coverDescEncoding === 0 || opts.coverDescEncoding === 3) {
        state.coverDescEncoding = opts.coverDescEncoding;
      }
      if (opts.textEncoding === 0 || opts.textEncoding === 3) state.textEncoding = opts.textEncoding;
      if (typeof opts.language === 'string') state.language = opts.language;
      if (opts.riffTextEncoding === 'latin1' || opts.riffTextEncoding === 'utf8') {
        state.riffTextEncoding = opts.riffTextEncoding;
      }
    }
    return state;
  }

  function getLogger(ctx) {
    if (ctx && typeof ctx.logger === 'function') return ctx.logger;
    return state.logger;
  }

  function warn(ctx, message) {
    if (ctx && Array.isArray(ctx.warnings)) ctx.warnings.push(String(message));
    var log = getLogger(ctx);
    try {
      log('[SunoTagger] ' + redact(message), { level: 'warn' });
    } catch (e) {
      /* A broken logger must never break tagging. */
    }
  }

  /* ---------------------------------------------------------------------- *
   * Redaction
   * ---------------------------------------------------------------------- */

  var SECRET_QUERY_RE = /([?&](?:key|iv|glt|token|authorization|auth|secret|sig|signature|password|pass)=)[^&#]*/gi;
  var BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
  var LONG_B64_RE = /\b[A-Za-z0-9+/_-]{24,}={0,2}\b/g;

  /**
   * Scrub secrets out of any string before it is logged or written to a
   * sidecar. Masks credential-shaped query parameters, Authorization headers
   * and long base64/hex-looking runs, then truncates.
   * @param {*} value
   * @param {{maxLen?:number}} [opts]
   * @returns {string} never throws, never returns the raw secret
   */
  function redact(value, opts) {
    var maxLen = opts && typeof opts.maxLen === 'number' ? opts.maxLen : 120;
    var s;
    try {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') s = value;
      else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
      else if (typeof Blob !== 'undefined' && value instanceof Blob) return '[Blob ' + value.size + 'B]';
      else if (value instanceof Uint8Array) return '[Uint8Array ' + value.length + 'B]';
      else if (value instanceof ArrayBuffer) return '[ArrayBuffer ' + value.byteLength + 'B]';
      else s = String(value);
    } catch (e) {
      return '[unloggable]';
    }
    try {
      s = s.replace(SECRET_QUERY_RE, '$1REDACTED');
      s = s.replace(BEARER_RE, '$1 REDACTED');
      s = s.replace(LONG_B64_RE, 'REDACTED');
    } catch (e) {
      /* Leave the truncation below as the only guard. */
    }
    if (s.length > maxLen) s = s.slice(0, Math.max(0, maxLen)) + '...[truncated ' + s.length + ' chars]';
    return s;
  }

  /* ---------------------------------------------------------------------- *
   * Byte plumbing
   * ---------------------------------------------------------------------- */

  function viewOf(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  /**
   * Coerce anything byte-ish into a Uint8Array *view*. Returns an empty array
   * for null/garbage. A returned view may alias the input; callers that keep it
   * around copy first.
   * @param {*} input
   * @returns {Uint8Array}
   */
  function toUint8(input) {
    try {
      if (!input) return EMPTY;
      if (input instanceof Uint8Array) return input;
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      if (Array.isArray(input)) {
        var out = new Uint8Array(input.length);
        for (var i = 0; i < input.length; i++) out[i] = Number(input[i]) & 0xff;
        return out;
      }
      return EMPTY;
    } catch (e) {
      return EMPTY;
    }
  }

  /**
   * Coerce into a standalone ArrayBuffer. Always a copy when the input is a
   * view, so the result never aliases caller memory.
   * @param {*} input
   * @returns {ArrayBuffer|null} null when there is no input at all
   */
  function toArrayBufferCopy(input) {
    try {
      if (!input) return null;
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
        if (input.byteLength === 0) return new ArrayBuffer(0);
        var copy = new Uint8Array(input.byteLength);
        copy.set(new Uint8Array(input));
        return copy.buffer;
      }
      var u8 = toUint8(input);
      if (!u8.length) return new ArrayBuffer(0);
      var exact = new Uint8Array(u8.length);
      exact.set(u8);
      return exact.buffer;
    } catch (e) {
      return null;
    }
  }

  var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function utf8(str) {
    var s = str === null || str === undefined ? '' : String(str);
    if (s === '') return EMPTY;
    try {
      if (encoder) return encoder.encode(s);
      /* Manual UTF-8 fallback for exotic hosts. */
      var esc = unescape(encodeURIComponent(s));
      var out = new Uint8Array(esc.length);
      for (var i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i) & 0xff;
      return out;
    } catch (e) {
      return EMPTY;
    }
  }

  /**
   * ISO-8859-1 encoder. Code points above U+00FF become '?' — lossy but the
   * only correct behaviour for an encoding that cannot represent them.
   */
  function latin1(str) {
    var s = str === null || str === undefined ? '' : String(str);
    if (s === '') return EMPTY;
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out[i] = c <= 0xff ? c : 0x3f;
    }
    return out;
  }

  function encodeByEncoding(str, encoding) {
    return encoding === 0 ? latin1(str) : utf8(str);
  }

  /**
   * NUL terminator width for a string field. UTF-16 encodings need two.
   */
  function terminatorWidth(encoding) {
    return encoding === 1 || encoding === 2 ? 2 : 1;
  }

  function makeTerminator(encoding) {
    return new Uint8Array(terminatorWidth(encoding));
  }

  /**
   * Exact-size concatenation. One allocation, filled with `set()`.
   * @param {Array<Uint8Array>} parts
   * @returns {Uint8Array}
   */
  function concatBytes(parts) {
    var list = [];
    var total = 0;
    var i;
    if (parts && parts.length) {
      for (i = 0; i < parts.length; i++) {
        var b = toUint8(parts[i]);
        if (b.length) {
          list.push(b);
          total += b.length;
        }
      }
    }
    if (!list.length) return new Uint8Array(0);
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < list.length; i++) {
      out.set(list[i], off);
      off += list[i].length;
    }
    return out;
  }

  /** Exactly `n` copies of `byte`. */
  function fillBytes(n, byte) {
    var len = n > 0 ? Math.floor(n) : 0;
    var out = new Uint8Array(len);
    if (len) out.fill(byte & 0xff);
    return out;
  }

  function readAscii(u8, offset, length) {
    var out = '';
    if (!u8 || offset < 0 || offset >= u8.length) return out;
    for (var i = 0; i < length; i++) {
      var b = u8[offset + i];
      if (b === undefined || b === 0) break;
      out += String.fromCharCode(b);
    }
    return out;
  }

  /**
   * Coerce a four-character-code to 4 bytes. Never throws.
   *
   * Bytes 0x80-0xFF pass through UNCHANGED: the iTunes atom names are
   * `©nam`, `©ART`, `©alb`, `©gen`, `©lyr`, `©day`, and that leading byte is
   * 0xA9 (the Latin-1 copyright sign), not an ASCII character. Clamping it to
   * '?' produces an atom name no player recognises, and the tags silently
   * vanish from every M4A written.
   */
  function fourCC(type) {
    var s = type === null || type === undefined ? '' : String(type);
    var out = new Uint8Array(4);
    for (var i = 0; i < 4; i++) {
      var code = i < s.length ? s.charCodeAt(i) & 0xff : 0x20;
      out[i] = code < 0x20 ? 0x3f : code;
    }
    return out;
  }

  function eqAscii(u8, offset, text) {
    if (!u8 || offset < 0 || offset + text.length > u8.length) return false;
    for (var i = 0; i < text.length; i++) {
      if (u8[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------------- *
   * Text hygiene
   * ---------------------------------------------------------------------- */

  /**
   * Make a string safe to place in a byte-oriented tag field.
   *
   * NUL is the important one: in ID3v2.3 a NUL terminates a text frame early,
   * and in the MP4 `data`/`RIFF INFO` cases it truncates the value, so a stray
   * NUL silently corrupts the tag. C0 control characters other than tab and
   * newline are dropped too. `\r\n` collapses to `\n`.
   *
   * @param {*} value
   * @param {{maxLen?:number}} [opts]
   * @returns {string} '' for anything unusable
   */
  function cleanText(value, opts) {
    var s;
    try {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') s = value;
      else if (typeof value === 'number') {
        if (!isFinite(value)) return '';
        s = String(value);
      } else if (typeof value === 'boolean') return '';
      else return '';
    } catch (e) {
      return '';
    }
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code === 0x00) continue;
      if (code === 0x0d) {
        if (s.charCodeAt(i + 1) === 0x0a) continue;
        out += '\n';
        continue;
      }
      if (code === 0x0a || code === 0x09) {
        out += s.charAt(i);
        continue;
      }
      if (code < 0x20 || code === 0x7f) continue;
      out += s.charAt(i);
    }
    out = out.replace(/[ \t]+$/gm, '');
    var maxLen = opts && typeof opts.maxLen === 'number' ? opts.maxLen : 0;
    if (maxLen > 0 && out.length > maxLen) out = out.slice(0, maxLen);
    return out;
  }

  /**
   * Normalise a lyrics payload for embedding.
   *
   * USLT is *unsynchronised* lyrics, so raw LRC timestamps are noise unless the
   * caller wants them; pass `{stripTimestamps:true}` to drop `[mm:ss.xx]` tags.
   * @param {*} lyricsText
   * @param {{stripTimestamps?:boolean, maxLen?:number}} [opts]
   * @returns {string}
   */
  function formatLyricsBlock(lyricsText, opts) {
    var s = cleanText(lyricsText);
    if (!s) return '';
    var strip = !!(opts && opts.stripTimestamps);
    var lines = s.split('\n');
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (strip) line = line.replace(/^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*/g, '');
      if (line) kept.push(line);
    }
    var out = kept.join('\n');
    var maxLen = opts && typeof opts.maxLen === 'number' ? opts.maxLen : 0;
    if (maxLen > 0 && out.length > maxLen) out = out.slice(0, maxLen);
    return out;
  }

  /* ---------------------------------------------------------------------- *
   * Syncsafe integers
   * ---------------------------------------------------------------------- */

  /**
   * Encode a 28-bit syncsafe integer (ID3v2 size fields).
   *
   * A syncsafe integer stores 7 bits per byte, most significant group first, so
   * every byte has its top bit clear and a decoder can resynchronise on `0xFF`.
   * The shifts are 21/14/7/0 and EACH byte is masked with `0x7F` — masking is
   * what makes the encoding syncsafe rather than a plain big-endian int.
   *
   * @param {number} n integer 0 .. 268435455
   * @returns {Uint8Array} exactly 4 bytes
   * @throws {SunoTagError} for non-numbers, negatives, fractions and n > 2^28-1
   */
  function encodeSyncsafe(n) {
    if (typeof n !== 'number' || !isFinite(n)) {
      throw new SunoTagError(
        'encodeSyncsafe expects a finite number, received ' + (typeof n) + ' ' + redact(n, { maxLen: 32 }),
        'ERANGE'
      );
    }
    if (Math.floor(n) !== n) {
      throw new SunoTagError('encodeSyncsafe expects an integer, received ' + n, 'ERANGE');
    }
    if (n < 0 || n > SYNCSAFE_MAX) {
      throw new SunoTagError(
        'encodeSyncsafe cannot encode ' + n + '; a syncsafe integer holds 0..' + SYNCSAFE_MAX + ' (2^28-1)',
        'ERANGE'
      );
    }
    var v = n >>> 0;
    var out = new Uint8Array(4);
    out[0] = (v >>> 21) & 0x7f;
    out[1] = (v >>> 14) & 0x7f;
    out[2] = (v >>> 7) & 0x7f;
    out[3] = v & 0x7f;
    return out;
  }

  /**
   * Decode a 28-bit syncsafe integer. High bits are masked off so a corrupt
   * tag yields a plausible in-range number instead of a negative one.
   * @param {Uint8Array|ArrayLike<number>} bytes
   * @returns {number} 0 when fewer than 4 bytes are available
   */
  function decodeSyncsafe(bytes) {
    try {
      if (!bytes || bytes.length < 4) return 0;
      return (
        ((bytes[0] & 0x7f) << 21) |
        ((bytes[1] & 0x7f) << 14) |
        ((bytes[2] & 0x7f) << 7) |
        (bytes[3] & 0x7f)
      ) >>> 0;
    } catch (e) {
      return 0;
    }
  }

  /* ---------------------------------------------------------------------- *
   * ID3v2.3
   * ---------------------------------------------------------------------- */

  /**
   * Is there an ID3v2 tag at the very start of these bytes?
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {boolean}
   */
  function hasId3Tag(bytes) {
    var u8 = toUint8(bytes);
    return u8.length >= 10 && eqAscii(u8, 0, 'ID3');
  }

  /**
   * Remove a leading ID3v2 tag.
   *
   * Handles the v2.4 footer flag (header flags byte bit 0x10, a trailing 10-byte
   * footer that counts toward the tag but not toward the size field). If the
   * declared size overruns the buffer the tag is corrupt; the least destructive
   * recovery is to drop only the 10-byte header and keep the rest as audio.
   *
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {{warnings?:string[]}} [ctx]
   * @returns {{audioBytes:Uint8Array, hadTag:boolean, oldTagBytes:Uint8Array}}
   */
  function stripExistingId3(bytes, ctx) {
    var u8 = toUint8(bytes);
    var none = { audioBytes: u8, hadTag: false, oldTagBytes: new Uint8Array(0) };
    if (u8.length < 10 || !eqAscii(u8, 0, 'ID3')) return none;

    var declared = decodeSyncsafe(u8.subarray(6, 10));
    var flags = u8[5];
    var footerBytes = flags & 0x10 ? 10 : 0;
    var tagEnd = ID3_HEADER_SIZE + declared + footerBytes;

    if (tagEnd > u8.length) {
      warn(ctx, 'existing ID3v2 tag declares ' + declared + ' bytes but only ' + (u8.length - ID3_HEADER_SIZE) +
        ' remain; dropping the 10-byte header only');
      tagEnd = ID3_HEADER_SIZE;
    }
    if (tagEnd < ID3_HEADER_SIZE) tagEnd = ID3_HEADER_SIZE;

    var audio = new Uint8Array(u8.length - tagEnd);
    if (audio.length) audio.set(u8.subarray(tagEnd));
    var old = new Uint8Array(tagEnd);
    if (tagEnd) old.set(u8.subarray(0, tagEnd));
    return { audioBytes: audio, hadTag: true, oldTagBytes: old };
  }

  /** Normalise a 3-letter ISO-639-2 code; anything unusable becomes ''. */
  function normalizeLanguage(lang) {
    var s = cleanText(lang).replace(/[^A-Za-z]/g, '');
    if (s.length !== 3) return '';
    return s.toLowerCase();
  }

  /**
   * Build one ID3v2.3 text frame payload: `encoding(1) + text`.
   * @param {string} text already sanitised
   * @param {number} encoding 0x00 or 0x03
   * @returns {Uint8Array}
   */
  function buildTextFramePayload(text, encoding) {
    var body = encodeByEncoding(text, encoding);
    var out = new Uint8Array(1 + body.length);
    out[0] = encoding & 0xff;
    if (body.length) out.set(body, 1);
    return out;
  }

  /**
   * Shared payload builder for COMM and USLT.
   *
   * Both frames use the identical layout:
   *   encoding(1) + language(3, ISO-639-2) + content-descriptor(NUL-terminated)
   *   + text
   * The descriptor terminator is one NUL for encoding 0x00/0x03 and two for the
   * UTF-16 encodings 0x01/0x02. Having a single builder is what stops USLT and
   * COMM from drifting apart, which is exactly what happened in the reference.
   *
   * @param {{descriptor?:string, text:string, language?:string, encoding?:number}} spec
   * @returns {Uint8Array}
   */
  function buildLangPayload(spec) {
    var encoding = spec && (spec.encoding === 0 || spec.encoding === 3) ? spec.encoding : 3;
    var lang = normalizeLanguage((spec && spec.language) || state.language) || 'eng';
    var descriptor = encodeByEncoding(cleanText(spec && spec.descriptor), encoding);
    var text = encodeByEncoding(cleanText(spec && spec.text), encoding);
    var terminator = makeTerminator(encoding);

    var out = new Uint8Array(1 + 3 + descriptor.length + terminator.length + text.length);
    var pos = 0;
    out[pos++] = encoding & 0xff;
    for (var i = 0; i < 3; i++) out[pos++] = lang.charCodeAt(i) & 0x7f;
    if (descriptor.length) out.set(descriptor, pos);
    pos += descriptor.length;
    if (terminator.length) out.set(terminator, pos);
    pos += terminator.length;
    if (text.length) out.set(text, pos);
    return out;
  }

  /**
   * Sniff a cover-art MIME type from magic bytes, falling back to a declared
   * type only when it is one of the two we accept. The server's `content-type`
   * is deliberately not trusted on its own: Suno's image CDN has been observed
   * labelling PNG payloads as `image/jpeg`.
   *
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {string} [declaredMime]
   * @returns {{mime:string, source:string}|null} null for empty/unsupported input
   */
  function sniffImageMime(bytes, declaredMime) {
    var u8 = toUint8(bytes);
    if (u8.length < 3) return null;
    if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) {
      return { mime: MIME_JPEG, source: 'magic' };
    }
    if (
      u8.length >= 8 &&
      u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
      u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a
    ) {
      return { mime: MIME_PNG, source: 'magic' };
    }
    var declared = cleanText(declaredMime).toLowerCase().split(';')[0].trim();
    if (declared === MIME_JPEG || declared === 'image/jpg' || declared === 'image/pjpeg') {
      return { mime: MIME_JPEG, source: 'declared' };
    }
    if (declared === MIME_PNG) return { mime: MIME_PNG, source: 'declared' };
    return null;
  }

  /**
   * Build an APIC frame payload:
   *   encoding(1) + MIME(NUL-terminated, always ASCII) + pictureType(1)
   *   + description(NUL-terminated) + pictureData
   *
   * The MIME string is ASCII regardless of the description encoding — that is
   * what the spec requires, and writing UTF-8 MIME bytes there confuses some
   * parsers.
   *
   * @param {{bytes:Uint8Array, mime?:string, description?:string,
   *   descEncoding?:number, pictureType?:number}} spec
   * @param {{warnings?:string[]}} [ctx]
   * @returns {Uint8Array|null} null when the art is empty or unsupported
   */
  function buildApicPayload(spec, ctx) {
    var spec2 = spec || {};
    var art = toUint8(spec2.bytes);
    if (!art.length) return null;

    var sniffed = sniffImageMime(art, spec2.mime);
    if (!sniffed) {
      warn(ctx, 'cover art is neither JPEG nor PNG by magic bytes or declared MIME; APIC skipped');
      return null;
    }

    var descEncoding = spec2.descEncoding === 0 || spec2.descEncoding === 3
      ? spec2.descEncoding
      : state.coverDescEncoding;
    var pictureType = typeof spec2.pictureType === 'number' ? spec2.pictureType & 0xff : 0x03;

    var mimeBytes = latin1(sniffed.mime);
    var description = cleanText(
      typeof spec2.description === 'string' ? spec2.description : state.coverDescription
    );
    var descBytes = encodeByEncoding(description, descEncoding);
    var terminator = makeTerminator(descEncoding);

    /* Measured exactly, allocated exactly once — cover art is routinely >2 MB
       and a short allocation here would silently truncate the artwork. */
    var payloadSize =
      1 +
      mimeBytes.length + 1 +
      1 +
      descBytes.length + terminator.length +
      art.length;

    if (payloadSize + 10 > U32_MAX) {
      warn(ctx, 'APIC payload (' + payloadSize + 'B) exceeds the 32-bit ID3v2 frame size field; cover art skipped');
      return null;
    }

    var out = new Uint8Array(payloadSize);
    var pos = 0;
    out[pos++] = descEncoding & 0xff;
    if (mimeBytes.length) out.set(mimeBytes, pos);
    pos += mimeBytes.length;
    out[pos++] = 0x00;
    out[pos++] = pictureType;
    if (descBytes.length) out.set(descBytes, pos);
    pos += descBytes.length;
    if (terminator.length) out.set(terminator, pos);
    pos += terminator.length;
    if (art.length) out.set(art, pos);
    return out;
  }

  /**
   * Assemble an ID3v2.3 frame: ID(4) + size(4, BIG-endian — NOT syncsafe)
   * + flags(2) + payload.
   * @param {string} id four chars
   * @param {Uint8Array} payload
   * @returns {Uint8Array|null}
   */
  function makeId3Frame(id, payload) {
    var payloadBytes = toUint8(payload);
    if (payloadBytes.length === 0) return null;
    var size = payloadBytes.length;
    if (size > U32_MAX) return null;
    var out = new Uint8Array(10 + size);
    var idBytes = fourCC(id);
    var dv = viewOf(out);
    out.set(idBytes, 0);
    dv.setUint32(4, size, false);
    dv.setUint16(8, 0, false);
    out.set(payloadBytes, 10);
    return out;
  }

  /**
   * Build a complete ID3v2.3 tag.
   *
   * Frame order is TIT2 TPE1 TALB TCON TDRC TBPM TKEY COMM USLT APIC. Only
   * non-empty frames are emitted, and the APIC frame is emitted LAST here —
   * ID3v2.3 has no ordering requirement, and putting the multi-megabyte frame
   * last keeps the small frames contiguous at the head of the tag, which is
   * what players read first.
   *
   * @param {{title?:string, artist?:string, album?:string, genre?:string,
   *   year?:(string|number), comment?:string, key?:string, bpm?:(string|number),
   *   lyrics?:string, coverArt?:{bytes:Uint8Array, mime?:string, description?:string,
   *   descEncoding?:number, pictureType?:number}, language?:string,
   *   unsyncLyrics?:boolean, textEncoding?:number, warnings?:string[]}} [opts]
   * @returns {Uint8Array} always a structurally valid tag (possibly just a header)
   */
  function buildId3v23(opts) {
    var report = buildId3v23Report(opts);
    return report.tag;
  }

  /**
   * Same as `buildId3v23` but also reports what was dropped and why.
   * @param {object} [opts] see `buildId3v23`
   * @returns {{tag:Uint8Array, frames:string[], warnings:string[]}}
   */
  function buildId3v23Report(opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var ctx = { warnings: Array.isArray(o.warnings) ? o.warnings : [] };
    var frames = [];
    var textEncoding = o.textEncoding === 0 || o.textEncoding === 3 ? o.textEncoding : state.textEncoding;
    var language = normalizeLanguage(o.language) || normalizeLanguage(state.language) || 'eng';

    function pushTextFrame(id, value) {
      var text = cleanText(value);
      if (!text) return;
      var frame = makeId3Frame(id, buildTextFramePayload(text, textEncoding));
      if (frame) frames.push(frame);
    }

    pushTextFrame('TIT2', o.title);
    pushTextFrame('TPE1', o.artist);
    pushTextFrame('TALB', o.album);
    pushTextFrame('TCON', o.genre);
    pushTextFrame('TDRC', o.year);
    pushTextFrame('TBPM', o.bpm);
    pushTextFrame('TKEY', o.key);

    var comment = cleanText(o.comment);
    if (comment) {
      var commFrame = makeId3Frame(
        'COMM',
        buildLangPayload({ descriptor: '', text: comment, language: language, encoding: textEncoding })
      );
      if (commFrame) frames.push(commFrame);
    }

    var lyrics = formatLyricsBlock(o.lyrics);
    if (lyrics) {
      /* USLT's content descriptor is the whole point of the frame: it tells the
         reader whether the following text is timed or not. */
      var usltFrame = makeId3Frame(
        'USLT',
        buildLangPayload({
          descriptor: o.unsyncLyrics === false ? 'synchronised lyrics' : 'unsynchronised lyrics',
          text: lyrics,
          language: language,
          encoding: textEncoding
        })
      );
      if (usltFrame) frames.push(usltFrame);
    }

    var warningsBefore = ctx.warnings.length;
    if (o.coverArt) {
      var apicPayload = buildApicPayload(o.coverArt, ctx);
      var apicFrame = apicPayload ? makeId3Frame('APIC', apicPayload) : null;
      if (apicFrame) frames.push(apicFrame);
      else if (ctx.warnings.length === warningsBefore) {
        warn(ctx, 'APIC frame could not be built; cover art omitted');
      }
    }

    /* The ID3v2 size field is the syncsafe size of the ENTIRE tag body
       EXCLUDING the 10-byte header, and each frame on the wire is
       `10 + payload.length` bytes. Summing payloads (as the ported reference
       did) understates the size by 10 bytes per frame and desynchronises every
       reader. */
    var bodySize = 0;
    for (var i = 0; i < frames.length; i++) bodySize += frames[i].length;

    if (bodySize > SYNCSAFE_MAX) {
      /* Cannot be represented. Dropping the artwork is the only lossless-ish
         option; a truncated size field would be worse than no art. */
      warn(ctx, 'tag body (' + bodySize + 'B) exceeds the syncsafe limit; cover art dropped');
      var reduced = [];
      for (var j = 0; j < frames.length; j++) {
        if (frames[j].length < 10 || readAscii(frames[j], 0, 4) !== 'APIC') reduced.push(frames[j]);
      }
      frames = reduced;
      bodySize = 0;
      for (var k = 0; k < frames.length; k++) bodySize += frames[k].length;
    }

    var tag = new Uint8Array(ID3_HEADER_SIZE + bodySize);
    var dv = viewOf(tag);
    tag[0] = 0x49; // 'I'
    tag[1] = 0x44; // 'D'
    tag[2] = 0x33; // '3'
    tag[3] = 0x03; // version 2.3
    tag[4] = 0x00; // revision
    tag[5] = 0x00; // flags: no unsynchronisation, no extended header, no footer
    var sizeBytes = encodeSyncsafe(bodySize);
    tag[6] = sizeBytes[0];
    tag[7] = sizeBytes[1];
    tag[8] = sizeBytes[2];
    tag[9] = sizeBytes[3];

    var offset = ID3_HEADER_SIZE;
    var frameIds = [];
    for (var f = 0; f < frames.length; f++) {
      tag.set(frames[f], offset);
      offset += frames[f].length;
      frameIds.push(readAscii(frames[f], 0, 4));
    }

    return { tag: tag, frames: frameIds, warnings: ctx.warnings };
  }

  /**
   * Prepend an ID3v2 tag to an MPEG stream, replacing any tag already there.
   *
   * Prepending blindly would nest tags, and players only ever read the first
   * one — the newly written metadata would be silently ignored and the stale
   * tag would win. The existing tag is therefore removed first.
   *
   * @param {ArrayBuffer|Uint8Array} mp3Buffer
   * @param {Uint8Array|ArrayBuffer} id3TagBytes
   * @param {{warnings?:string[]}} [ctx]
   * @returns {ArrayBuffer}
   */
  function injectId3IntoMp3(mp3Buffer, id3TagBytes, ctx) {
    var input = mp3Buffer;
    var stripped = stripExistingId3(mp3Buffer, ctx);
    var audio = stripped.audioBytes;
    var tag = toUint8(id3TagBytes);

    var out = new Uint8Array(tag.length + audio.length);
    if (tag.length) out.set(tag, 0);
    if (audio.length) out.set(audio, tag.length);
    return out.buffer;
  }

  /* ---------------------------------------------------------------------- *
   * MP4 / iTunes atoms
   * ---------------------------------------------------------------------- */

  /**
   * Build an MP4 atom: `size(u32 BE) + type(4) + payload`.
   * Falls back to the 64-bit `largesize` form (size==1, 8-byte size) past 4 GiB.
   * @param {string} type four-character code
   * @param {Uint8Array|ArrayBuffer} payload
   * @returns {Uint8Array}
   */
  function makeAtom(type, payload) {
    var body = toUint8(payload);
    var typeBytes = fourCC(type);
    var size = body.length + 8;
    if (size <= U32_MAX) {
      var out = new Uint8Array(size);
      var dv = viewOf(out);
      dv.setUint32(0, size, false);
      out.set(typeBytes, 4);
      if (body.length) out.set(body, 8);
      return out;
    }
    var big = new Uint8Array(body.length + 16);
    var bdv = viewOf(big);
    bdv.setUint32(0, 1, false);
    big.set(typeBytes, 4);
    bdv.setUint32(8, 0, false); // high word of the 64-bit size
    bdv.setUint32(12, size, false); // low word
    if (body.length) big.set(body, 16);
    return big;
  }

  /**
   * Build a `data` atom — the leaf that carries an iTunes metadata value.
   *
   * Layout: `size + 'data' + (reserved 1 byte + type 3 bytes) + locale(4) + value`
   * The type code lives in the LOW 3 bytes of the 4-byte type field:
   *   1 = UTF-8 text, 13 = JPEG, 14 = PNG, 21 = BE signed int (used by `tmpo`).
   *
   * @param {number} typeCode
   * @param {string|Uint8Array|ArrayBuffer} payload text is UTF-8 encoded; bytes pass through
   * @returns {Uint8Array}
   */
  function makeDataAtom(typeCode, payload) {
    var value = typeof payload === 'string' ? utf8(payload) : toUint8(payload);
    var code = typeof typeCode === 'number' && isFinite(typeCode) ? typeCode & 0x0ffffff : 1;
    var body = new Uint8Array(8 + value.length);
    var dv = viewOf(body);
    dv.setUint32(0, 0, false); // version/reserved (1 byte) + type code (3 bytes)
    dv.setUint8(3, code);
    dv.setUint32(4, 0, false); // locale: 0
    if (value.length) body.set(value, 8);
    return makeAtom('data', body);
  }

  /**
   * Build a `----` freeform atom, the standard way to park a non-standard tag
   * (such as a raw ID3v2 blob) inside an iTunes `ilst`.
   * @param {string} mean reverse-DNS namespace, conventionally `com.apple.iTunes`
   * @param {string} name field name inside the namespace
   * @param {Uint8Array|string} value raw bytes or UTF-8 text
   * @param {{typeCode?:number}} [opts]
   * @returns {Uint8Array}
   */
  function makeFreeformAtom(mean, name, value, opts) {
    var typeCode = opts && typeof opts.typeCode === 'number' ? opts.typeCode : 1;
    var meanBytes = concatBytes([utf8(mean || ITUNES_MEAN), new Uint8Array([0])]);
    var nameBytes = concatBytes([utf8(name || ''), new Uint8Array([0])]);
    return makeAtom(
      '----',
      concatBytes([
        makeAtom('mean', meanBytes),
        makeAtom('name', nameBytes),
        makeDataAtom(typeCode, value)
      ])
    );
  }

  /**
   * Build the `hdlr` atom that iTunes requires inside `meta`. Handlers that
   * cannot find one often refuse to display any tag at all.
   * @returns {Uint8Array}
   */
  function makeHdlrAtom() {
    var body = new Uint8Array(21);
    var dv = viewOf(body);
    dv.setUint32(0, 0, false); // version + flags
    dv.setUint32(4, 0, false); // pre_defined
    body[8] = 0x6d; // 'm'
    body[9] = 0x64; // 'd'
    body[10] = 0x69; // 'i'
    body[11] = 0x72; // 'r'
    dv.setUint32(12, 0, false); // reserved
    body[20] = 0x00; // empty NUL-terminated name
    return makeAtom('hdlr', body);
  }

  /**
   * Build a `meta` atom. `meta` is a FULL box, so unlike other atoms its body
   * begins with a 4-byte version/flags field before any child atoms — omitting
   * that prefix is the single most common cause of "iTunes sees no tags".
   * @param {Array<Uint8Array>} [children] child atoms, normally `hdlr` + `ilst`
   * @returns {Uint8Array}
   */
  function makeMetaAtom(children) {
    var list = [];
    if (children && children.length) {
      for (var i = 0; i < children.length; i++) {
        var b = toUint8(children[i]);
        if (b.length) list.push(b);
      }
    }
    if (!list.length) list.push(makeHdlrAtom());
    return makeAtom('meta', concatBytes([new Uint8Array(4), concatBytes(list)]));
  }

  /** Numeric ID3v1 genre index for a few common free-text genres, for `©gnre`. */
  var ID3V1_GENRES = [
    'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
    'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
    'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop',
    'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
    'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative',
    'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial',
    'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
    'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave',
    'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz',
    'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'
  ];

  /**
   * Build the `ilst` atom from a tag set.
   *
   * Written: `©nam` `©ART` `©alb` `©gen` (or numeric `©gnre`) `desc` `©lyr`
   * `tmpo` `covr`.
   *
   * Genre note: iTunes has two different genre atoms. `©gen` holds free text
   * and is what a listener actually reads; `©gnre` holds an ID3v1 numeric index
   * and is what older hardware expects. Free-text genres go to `©gen`; pass
   * `genreIsNumeric` (or a `genreIndex`) to target `©gnre` instead.
   *
   * `tmpo` (BPM) is emitted in addition to the atoms named in the port request
   * because BPM is part of the metadata the downloaded library is required to
   * carry and `tmpo` is the only standard place for it in MP4.
   *
   * @param {{title?:string, artist?:string, album?:string, genre?:string,
   *   genreIndex?:number, genreIsNumeric?:boolean, comment?:string,
   *   lyrics?:string, desc?:string, bpm?:(number|string), year?:(string|number),
   *   coverArt?:{bytes:Uint8Array, mime?:string, description?:string}}} [tags]
   * @param {{warnings?:string[]}} [ctx]
   * @returns {Uint8Array|null} null when there is nothing worth writing
   */
  function buildIlst(tags, ctx) {
    var t = tags && typeof tags === 'object' ? tags : {};
    var items = [];

    function add(atomType, value, typeCode) {
      var text = cleanText(value);
      if (!text) return;
      var atom = makeAtom(atomType, makeDataAtom(typeCode === undefined ? 1 : typeCode, text));
      if (atom) items.push(atom);
    }

    add('\u00a9nam', t.title);
    add('\u00a9ART', t.artist);
    add('\u00a9alb', t.album);

    var genreText = cleanText(t.genre);
    var genreIndex = typeof t.genreIndex === 'number' && isFinite(t.genreIndex)
      ? t.genreIndex
      : null;
    if (genreIndex === null && t.genreIsNumeric && genreText) {
      var found = ID3V1_GENRES.indexOf(genreText);
      if (found >= 0) genreIndex = found;
    }
    if (genreIndex !== null && genreIndex >= 0 && genreIndex <= 255) {
      /* typeCode 0 = reserved/implicit; the value is a 1-byte integer. */
      items.push(makeAtom('\u00a9gnre', makeDataAtom(0, new Uint8Array([genreIndex & 0xff]))));
    } else if (genreText) {
      add('\u00a9gen', genreText);
    }

    add('desc', t.comment);
    add('\u00a9lyr', t.lyrics);
    add('\u00a9day', t.year);

    var bpm = typeof t.bpm === 'string' ? parseFloat(t.bpm) : t.bpm;
    if (typeof bpm === 'number' && isFinite(bpm) && bpm > 0) {
      var rounded = Math.round(bpm);
      if (rounded > 0 && rounded < 65536) {
        var num = new Uint8Array(2);
        viewOf(num).setUint16(0, rounded, false); // typeCode 21 = BE signed int
        items.push(makeAtom('tmpo', makeDataAtom(21, num)));
      }
    }

    if (t.coverArt) {
      var art = toUint8(t.coverArt.bytes);
      if (art.length) {
        var sniffed = sniffImageMime(art, t.coverArt.mime);
        if (sniffed) {
          var code = sniffed.mime === MIME_PNG ? COVR_PNG : COVR_JPEG;
          items.push(makeAtom('covr', makeDataAtom(code, art)));
        } else {
          warn(ctx, 'cover art is neither JPEG nor PNG; covr atom skipped');
        }
      }
    }

    if (!items.length) return null;
    return makeAtom('ilst', concatBytes(items));
  }

  /**
   * Walk the top-level atoms of a buffer.
   *
   * Two guards keep a corrupt or hostile size field from turning this into an
   * infinite loop: `size === 0` means "extends to end of file" (legal for the
   * last atom) and anything smaller than its own header, or larger than the
   * bytes remaining, ends the walk.
   *
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {Array<{type:string,start:number,size:number,headerLen:number,end:number}>}
   */
  function walkTopAtoms(bytes) {
    var u8 = toUint8(bytes);
    var list = [];
    if (u8.length < 8) return list;
    var dv = viewOf(u8);
    var offset = 0;
    while (offset + 8 <= u8.length) {
      var size = dv.getUint32(offset, false);
      var type = readAscii(u8, offset + 4, 4);
      var headerLen = 8;
      if (size === 1) {
        if (offset + 16 > u8.length) break;
        var hi = dv.getUint32(offset + 8, false);
        var lo = dv.getUint32(offset + 12, false);
        size = hi * 4294967296 + lo;
        headerLen = 16;
      } else if (size === 0) {
        size = u8.length - offset;
      }
      if (size < headerLen || offset + size > u8.length) break;
      list.push({ type: type, start: offset, size: size, headerLen: headerLen, end: offset + size });
      offset += size;
      if (offset <= 0) break;
    }
    return list;
  }

  /**
   * Recursively locate `stco` / `co64` tables and shift their chunk offsets.
   *
   * This is the part every hand-rolled MP4 tagger gets wrong. `stco` entries are
   * ABSOLUTE file offsets of chunks inside `mdat`. Inserting bytes inside `moov`
   * — which normally precedes `mdat` — pushes `mdat` later in the file and
   * every one of those offsets becomes wrong, so the file plays as silence or
   * garbage. Every entry pointing past the insertion point must be adjusted by
   * the same delta.
   *
   * @param {Uint8Array} u8 buffer to patch in place (already the NEW layout)
   * @param {number} delta signed byte shift
   * @param {number} threshold only offsets strictly greater than this are moved
   * @param {{warnings?:string[]}} [ctx]
   * @returns {number} number of entries patched
   */
  function fixChunkOffsets(u8, ctx, delta, threshold) {
    if (!delta || !u8 || u8.length < 8) return 0;
    var patched = 0;
    var limit = typeof threshold === 'number' ? threshold : 0;
    var dv = viewOf(u8);

    function visit(start, end, depth) {
      if (depth > 8) return;
      var offset = start;
      while (offset + 8 <= end) {
        var size = dv.getUint32(offset, false);
        var type = readAscii(u8, offset + 4, 4);
        var headerLen = 8;
        if (size === 1) {
          if (offset + 16 > end) return;
          size = dv.getUint32(offset + 8, false) * 4294967296 + dv.getUint32(offset + 12, false);
          headerLen = 16;
        } else if (size === 0) {
          size = end - offset;
        }
        if (size < headerLen || offset + size > end) return;

        if (type === 'stco' && offset + 16 <= end) {
          var count = dv.getUint32(offset + 12, false);
          var p = offset + 16;
          for (var i = 0; i < count && p + 4 <= offset + size; i++, p += 4) {
            var v = dv.getUint32(p, false);
            if (v > limit) {
              var next = v + delta;
              if (next < 0) {
                warn(ctx, 'stco entry ' + i + ' would go negative; clamped to 0');
                next = 0;
              } else if (next > U32_MAX) {
                warn(ctx, 'stco entry ' + i + ' exceeds the 32-bit table; left unchanged');
              } else {
                dv.setUint32(p, next, false);
                patched++;
              }
            }
          }
        } else if (type === 'co64' && offset + 16 <= end) {
          var count64 = dv.getUint32(offset + 12, false);
          var q = offset + 16;
          for (var j = 0; j < count64 && q + 8 <= offset + size; j++, q += 8) {
            var lo = dv.getUint32(q, false);
            var hi = dv.getUint32(q + 4, false);
            var wide = hi * 4294967296 + lo;
            if (wide > limit) {
              var shifted = wide + delta;
              if (shifted < 0) shifted = 0;
              if (shifted > 4294967295 * 4294967296 + U32_MAX) {
                warn(ctx, 'co64 entry ' + j + ' exceeds 64 bits; left unchanged');
              } else {
                var sHi = Math.floor(shifted / 4294967296);
                dv.setUint32(q, sHi, false);
                dv.setUint32(q + 4, shifted - sHi * 4294967296, false);
                patched++;
              }
            }
          }
        }

        /* `meta` is a full box: its children start 4 bytes in. Everything else
           is a plain container whose children start right after the header. */
        var childStart = offset + headerLen + (type === 'meta' ? 4 : 0);
        if (size > headerLen && childStart < offset + size) {
          visit(childStart, offset + size, depth + 1);
        }
        offset += size;
      }
    }

    visit(0, u8.length, 0);
    return patched;
  }

  /**
   * Write iTunes tags into an MP4/M4A container.
   *
   * Strategy: find `moov` by walking the top-level atoms, then place
   * `moov/udta/meta/ilst` at the END of `moov` (or replace an existing `udta`,
   * keeping its other children), rewrite `moov`'s size header, and shift every
   * `stco`/`co64` offset that points past the edit. Every other byte in the file
   * is copied verbatim.
   *
   * If anything goes wrong the ORIGINAL buffer is returned, untouched. A
   * half-written MP4 is worse than an untagged one.
   *
   * @param {ArrayBuffer|Uint8Array} buffer
   * @param {{title?:string, artist?:string, album?:string, genre?:string,
   *   comment?:string, lyrics?:string, desc?:string, bpm?:number,
   *   coverArt?:{bytes:Uint8Array, mime?:string}}} [tags]
   * @param {{coverArt?:object, warnings?:string[], logger?:Function}} [opts]
   * @returns {{injected:boolean, bytes:ArrayBuffer, reason:(string|null), ilst:Uint8Array|null}}
   */
  function injectTagsIntoMp4(buffer, tags, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var ctx = { warnings: Array.isArray(o.warnings) ? o.warnings : [], logger: o.logger };
    var original =
      typeof ArrayBuffer !== 'undefined' && buffer instanceof ArrayBuffer
        ? buffer
        : toArrayBufferCopy(buffer);

    function fail(reason) {
      warn(ctx, reason);
      return { injected: false, bytes: original, reason: reason, ilst: null };
    }

    var u8 = toUint8(buffer);
    if (!original || u8.length < 16) return fail('input is too small to be an MP4 container');

    var coverArt = o.coverArt || (tags && tags.coverArt) || null;
    var merged = {};
    if (tags && typeof tags === 'object') {
      for (var k in tags) {
        if (Object.prototype.hasOwnProperty.call(tags, k)) merged[k] = tags[k];
      }
    }
    if (coverArt) merged.coverArt = coverArt;

    var ilst = buildIlst(merged, ctx);
    if (!ilst) return fail('no tag values to write (all fields empty)');

    var top = walkTopAtoms(u8);
    var moov = null;
    var i;
    for (i = 0; i < top.length; i++) {
      if (top[i].type === 'moov') {
        moov = top[i];
        break;
      }
    }
    if (!moov) return fail('no moov atom found; nothing to attach tags to');

    /* Locate (or make room for) `udta` inside `moov`. */
    var moovBodyStart = moov.start + moov.headerLen;
    var moovBodyEnd = moov.end;
    var moovChildren = walkTopAtoms(u8.subarray(moovBodyStart, moovBodyEnd));
    var udta = null;
    for (i = 0; i < moovChildren.length; i++) {
      if (moovChildren[i].type === 'udta') {
        udta = moovChildren[i];
        break;
      }
    }

    var newMetaChildren = [];
    var preservedUdtaChildren = [];
    var udtaStart;
    var udtaEnd;
    var udtaTotalLength;

    if (udta) {
      udtaStart = moovBodyStart + udta.start;
      udtaEnd = moovBodyStart + udta.end;
      udtaTotalLength = udta.size;
      var udtaChildren = walkTopAtoms(u8.subarray(udtaStart + udta.headerLen, udtaEnd));
      var metaChild = null;
      for (i = 0; i < udtaChildren.length; i++) {
        var childType = udtaChildren[i].type;
        if (childType === 'meta') metaChild = udtaChildren[i];
        else preservedUdtaChildren.push(u8.subarray(udtaStart + udtaChildren[i].start, udtaStart + udtaChildren[i].end));
      }
      if (metaChild) {
        var metaStart = udtaStart + udta.headerLen + metaChild.start;
        var metaBodyStart = metaStart + metaChild.headerLen + 4;
        var metaChildren = walkTopAtoms(u8.subarray(metaBodyStart, metaStart + metaChild.size));
        for (i = 0; i < metaChildren.length; i++) {
          /* Replace any previous `ilst`; keep `hdlr`, `keys` and friends. */
          if (metaChildren[i].type === 'ilst') continue;
          newMetaChildren.push(
            u8.subarray(
              metaBodyStart + metaChildren[i].start,
              metaBodyStart + metaChildren[i].end
            )
          );
        }
      } else {
        newMetaChildren.push(makeHdlrAtom());
      }
    } else {
      udtaStart = moovBodyEnd;
      udtaEnd = moovBodyEnd;
      udtaTotalLength = 0;
      newMetaChildren.push(makeHdlrAtom());
    }

    newMetaChildren.push(ilst);
    var newMeta = makeMetaAtom(newMetaChildren);
    var newUdta = makeAtom('udta', newMeta);
    var udtaPayload = concatBytes(preservedUdtaChildren);
    var fullUdta = udtaPayload.length
      ? makeAtom('udta', concatBytes([udtaPayload, newMeta]))
      : newUdta;

    var delta = fullUdta.length - udtaTotalLength;
    var outLength = u8.length + delta;

    var out = new Uint8Array(outLength);
    /* Copy the head verbatim, splice the udta, copy the tail verbatim. */
    if (udtaStart > 0) out.set(u8.subarray(0, udtaStart), 0);
    out.set(fullUdta, udtaStart);
    var tailFrom = udta ? udtaEnd : udtaStart;
    var tailLen = u8.length - tailFrom;
    if (tailLen > 0) out.set(u8.subarray(tailFrom), udtaStart + fullUdta.length);

    /* Rewrite the moov size header. */
    var newMoovSize = moov.size + delta;
    var odv = viewOf(out);
    if (moov.headerLen === 8) {
      if (newMoovSize > U32_MAX) return fail('rewriting moov would exceed the 32-bit atom size field');
      odv.setUint32(moov.start, newMoovSize, false);
    } else {
      var high = Math.floor(newMoovSize / 4294967296);
      odv.setUint32(moov.start + 8, high, false);
      odv.setUint32(moov.start + 12, newMoovSize - high * 4294967296, false);
    }

    /* Fix the audio chunk offsets that the insertion shifted. */
    if (delta !== 0) {
      var fixed = fixChunkOffsets(out, ctx, delta, udta ? udtaEnd : udtaStart);
      if (fixed === 0) {
        /* No stco/co64 found, or nothing pointed past the edit. Either is fine
           when moov trails mdat, which is why this is not an error. */
      }
    }

    /* Post-write sanity check: the top-level walk must still be well formed and
       account for every byte. If it does not, hand back the original. */
    var verify = walkTopAtoms(out);
    if (!verify.length) return fail('post-write validation failed: top-level atom walk produced nothing');
    var last = verify[verify.length - 1];
    if (last.end !== out.length) {
      warn(ctx, 'post-write validation: trailing ' + (out.length - last.end) + ' bytes are not covered by an atom');
    }
    var moovAfter = null;
    for (i = 0; i < verify.length; i++) {
      if (verify[i].type === 'moov') {
        moovAfter = verify[i];
        break;
      }
    }
    if (!moovAfter) return fail('post-write validation failed: moov atom is no longer walkable');

    return { injected: true, bytes: out.buffer, reason: null, ilst: ilst };
  }

  /**
   * Park an ID3v2 tag inside an M4A/MP4 container.
   *
   * ROUTE (deliberate choice): the tag goes into
   * `moov/udta/meta/ilst` as a `----` freeform atom with mean `com.apple.iTunes`
   * and name `ID3 `, whose value is the raw ID3v2 bytes. That is exactly how
   * iTunes and mp4v2 embed an ID3v2 tag in MPEG-4, so the choice is one real
   * players already read, rather than a `free` atom, which every player ignores
   * because `free` means padding.
   *
   * When there is no `moov` to attach to, the fallback appends a top-level
   * `free` atom at the very END of the file. Appending at EOF is deliberate: it
   * shifts nothing, so no `stco`/`co64` table needs correcting.
   *
   * @param {ArrayBuffer|Uint8Array} m4aBuffer
   * @param {Uint8Array|ArrayBuffer} id3TagBytes
   * @param {{report?:object, warnings?:string[], logger?:Function}} [opts]
   * @returns {ArrayBuffer} the original buffer, unchanged, on any failure
   */
  function injectId3IntoM4a(m4aBuffer, id3TagBytes, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var ctx = { warnings: Array.isArray(o.warnings) ? o.warnings : [], logger: o.logger };
    var original =
      typeof ArrayBuffer !== 'undefined' && m4aBuffer instanceof ArrayBuffer
        ? m4aBuffer
        : toArrayBufferCopy(m4aBuffer);
    var tag = toUint8(id3TagBytes);

    function giveUp(reason) {
      warn(ctx, reason);
      if (o.report) {
        o.report.injected = false;
        o.report.reason = reason;
      }
      return original;
    }

    if (!original || !tag.length) return giveUp('no input or no ID3 tag to embed');

    var u8 = toUint8(m4aBuffer);
    var freeform = makeFreeformAtom(ITUNES_MEAN, 'ID3 ', tag, { typeCode: 1 });

    var top = walkTopAtoms(u8);
    var moov = null;
    var i;
    for (i = 0; i < top.length; i++) {
      if (top[i].type === 'moov') {
        moov = top[i];
        break;
      }
    }

    if (!moov) {
      /* Fallback: append a `free` atom carrying the tag at EOF. No bytes move,
         therefore no chunk-offset table needs patching. */
      var appended = concatBytes([u8, makeAtom('free', tag)]);
      if (o.report) {
        o.report.injected = true;
        o.report.reason = 'no moov atom; appended trailing free atom instead of an ilst entry';
      }
      return appended.buffer;
    }

    /* Build `moov/udta/meta/ilst/----` by hand: `buildIlst` only emits the
       fixed atom set, and this route needs one specific freeform atom. The
       udta splice and stco/co64 repair below mirror `injectTagsIntoMp4`. */
    var moovChildren = walkTopAtoms(u8.subarray(moov.start + moov.headerLen, moov.end));
    var udta = null;
    for (i = 0; i < moovChildren.length; i++) {
      if (moovChildren[i].type === 'udta') {
        udta = moovChildren[i];
        break;
      }
    }

    var newMetaChildren = [makeHdlrAtom()];
    var preservedUdtaChildren = [];
    var udtaStart;
    var udtaEnd;
    var udtaTotalLength;

    if (udta) {
      udtaStart = moov.start + moov.headerLen + udta.start;
      udtaEnd = moov.start + moov.headerLen + udta.end;
      udtaTotalLength = udta.size;
      var udtaChildren = walkTopAtoms(u8.subarray(udtaStart + udta.headerLen, udtaEnd));
      var metaChild = null;
      for (i = 0; i < udtaChildren.length; i++) {
        if (udtaChildren[i].type === 'meta') metaChild = udtaChildren[i];
        else {
          preservedUdtaChildren.push(
            u8.subarray(udtaStart + udtaChildren[i].start, udtaStart + udtaChildren[i].end)
          );
        }
      }
      if (metaChild) {
        var metaStart = udtaStart + udta.headerLen + metaChild.start;
        var metaBodyStart = metaStart + metaChild.headerLen + 4;
        var metaChildren = walkTopAtoms(u8.subarray(metaBodyStart, metaStart + metaChild.size));
        for (i = 0; i < metaChildren.length; i++) {
          if (metaChildren[i].type === 'ilst') continue;
          newMetaChildren.push(
            u8.subarray(
              metaBodyStart + metaChildren[i].start,
              metaBodyStart + metaChildren[i].end
            )
          );
        }
      }
    } else {
      udtaStart = moov.end;
      udtaEnd = moov.end;
      udtaTotalLength = 0;
    }

    var ilst = makeAtom('ilst', freeform);
    newMetaChildren.push(ilst);
    var meta = makeMetaAtom(newMetaChildren);
    var fullUdta = preservedUdtaChildren.length
      ? makeAtom('udta', concatBytes([concatBytes(preservedUdtaChildren), meta]))
      : makeAtom('udta', meta);

    var delta = fullUdta.length - udtaTotalLength;
    var out = new Uint8Array(u8.length + delta);
    if (udtaStart > 0) out.set(u8.subarray(0, udtaStart), 0);
    out.set(fullUdta, udtaStart);
    var tailFrom = udta ? udtaEnd : udtaStart;
    var tailLen = u8.length - tailFrom;
    if (tailLen > 0) out.set(u8.subarray(tailFrom), udtaStart + fullUdta.length);

    var newMoovSize = moov.size + delta;
    if (newMoovSize > U32_MAX) return giveUp('rewriting moov would exceed the 32-bit atom size field');
    viewOf(out).setUint32(moov.start, newMoovSize, false);
    if (delta !== 0) fixChunkOffsets(out, ctx, delta, udta ? udtaEnd : udtaStart);

    if (o.report) {
      o.report.injected = true;
      o.report.reason = null;
    }
    return out.buffer;
  }

  /* ---------------------------------------------------------------------- *
   * RIFF / WAV
   * ---------------------------------------------------------------------- */

  /**
   * Normalise a loose metadata record onto the canonical tag field names.
   *
   * Accepts the field spellings used elsewhere in this codebase — notably
   * `lib/audio.js`'s `toTagMeta()`, which emits `genreText`, `styleText`,
   * `modelLabel`, `createdIso`, `durationSec` and `isInstrumental`, and which
   * deliberately puts the clip OWNER into `artist` rather than under
   * `display_name`/`handle`.
   *
   * Note what is NOT read: `display_name`, `handle` and `user_id` are never
   * consulted here. An `artist` is only ever honoured because it was passed
   * explicitly, which is the documented opt-in.
   *
   * @param {object} input
   * @returns {object} canonical field set for the builders below
   */
  function mapTagFields(input) {
    var s = input && typeof input === 'object' ? input : {};
    var md = s.metadata && typeof s.metadata === 'object' ? s.metadata : {};
    var year = s.year;
    if (year === undefined || year === null || cleanText(year) === '') {
    var created = cleanText(s.createdIso || s.created_at || md.created_at);
    if (created.length >= 4) year = created.slice(0, 4);
  }

  var comment = s.comment || buildComment({
    model: s.model || s.modelVersion || s.modelLabel,
    clipId: s.clipId || s.id,
    prompt: s.prompt,
    tags: s.genreText
  });
  var genre = s.genre || s.genreText || s.style || s.styleText || md.tags || md.style;

  /* Apply the neutral-artist default only once the record carries real content,
     so an empty record still produces no chunk/tag at all rather than an
     artifact consisting of a synthesised artist name. */
  var artist = s.artist;
  var hasContent = cleanText(s.title) || cleanText(s.album) || cleanText(genre) ||
    cleanText(comment) || cleanText(s.lyrics) || s.coverArt ||
    cleanText(year) || cleanText(s.bpm) || cleanText(s.key);
  if (hasContent && !cleanText(artist)) artist = resolveArtist(s, {});

  return {
    title: s.title,
    artist: artist,
    album: s.album,
    genre: genre,
    year: year,
    key: s.key,
    bpm: s.bpm,
    lyrics: s.lyrics,
    coverArt: s.coverArt,
    language: s.language,
    unsyncLyrics: s.unsyncLyrics,
    textEncoding: s.textEncoding,
    comment: comment
  };
}

  /**
   * Build a `LIST`/`INFO` chunk.
   *
   * EVERY multi-byte size in a RIFF chunk is LITTLE-ENDIAN — that includes the
   * LIST header size itself. Text values are NUL-terminated and each sub-chunk
   * is padded to an even length with a single zero byte that is NOT counted in
   * the sub-chunk's size field.
   *
   * Sub-chunks: INAM (title), IART (artist), IPRD (product/album), IGNR
   * (genre), ICMT (comment), ICRD (creation date), ITRK (track).
   *
   * Text is written as UTF-8 by default because Suno titles routinely contain
   * non-Latin characters and Latin-1 would replace them with '?'. Pass
   * `riffTextEncoding: 'latin1'` for strict legacy tooling.
   *
   * @param {{title?:string, artist?:string, album?:string, genre?:string,
   *   genreText?:string, style?:string, styleText?:string,
   *   comment?:string, year?:string|number, createdIso?:string,
   *   track?:string|number, encoding?:'utf8'|'latin1'}} [fields]
   * @returns {Uint8Array|null} a COMPLETE chunk, header included, or null when
   *   no field is usable
   */
  function buildRiffInfoChunk(fields) {
    var given = fields && typeof fields === 'object' ? fields : {};
    var canonical = mapTagFields(given);
    var encoding = given.encoding === 'latin1' ? 'latin1'
      : given.riffTextEncoding === 'latin1' || state.riffTextEncoding === 'latin1' ? 'latin1'
      : 'utf8';

    var specs = [
      ['INAM', cleanText(canonical.title)],
      ['IART', cleanText(canonical.artist)],
      ['IPRD', cleanText(canonical.album)],
      ['IGNR', cleanText(canonical.genre)],
      ['ICMT', cleanText(canonical.comment)],
      ['ICRD', cleanText(canonical.year)],
      ['ITRK', cleanText(given.track)]
    ];

    var subChunks = [];
    var innerLength = 4; // the 'INFO' list type
    var i;
    var j;
    for (i = 0; i < specs.length; i++) {
      var text = specs[i][1];
      if (!text) continue;
      var payload = encoding === 'latin1' ? concatBytes([latin1(text), new Uint8Array([0])]) : concatBytes([utf8(text), new Uint8Array([0])]);
      var padded = payload.length + (payload.length % 2);
      var chunk = new Uint8Array(8 + padded);
      chunk.set(fourCC(specs[i][0]), 0);
      /* little-endian, per the RIFF spec */
      viewOf(chunk).setUint32(4, payload.length, true);
      for (j = 0; j < payload.length; j++) chunk[8 + j] = payload[j];
      subChunks.push(chunk);
      innerLength += chunk.length;
    }

    if (!subChunks.length) return null;

    var list = new Uint8Array(8 + innerLength);
    list.set(fourCC('LIST'), 0);
    /* little-endian */
    viewOf(list).setUint32(4, innerLength, true);
    list.set(fourCC('INFO'), 8);
    var offset = 12;
    for (i = 0; i < subChunks.length; i++) {
      list.set(subChunks[i], offset);
      offset += subChunks[i].length;
    }
    return list;
  }

  /**
   * Wrap an ID3v2 tag in a RIFF chunk literally named `id3 `.
   * WAV carries ID3 metadata in exactly this form; the size field is
   * little-endian and the payload is padded to an even length, with the pad
   * byte excluded from the size.
   *
   * @param {Uint8Array|ArrayBuffer} id3TagBytes
   * @returns {Uint8Array|null}
   */
  function buildId3ChunkForWav(id3TagBytes) {
    var tag = toUint8(id3TagBytes);
    if (!tag.length) return null;
    var padded = tag.length + (tag.length % 2);
    var chunk = new Uint8Array(8 + padded);
    chunk[0] = 0x69; // 'i'
    chunk[1] = 0x64; // 'd'
    chunk[2] = 0x33; // '3'
    chunk[3] = 0x20; // ' ' — the fourth character is a SPACE
    viewOf(chunk).setUint32(4, tag.length, true); // little-endian
    chunk.set(tag, 8);
    return chunk;
  }

  /**
   * Compatibility entry point: build an `id3 ` RIFF chunk from EITHER a
   * metadata record or a pre-built ID3v2 tag.
   *
   * `lib/audio.js` calls `SunoTagger.buildId3Chunk(meta)` with the flat record
   * produced by its `toTagMeta()`, so both shapes have to work here.
   *
   * @param {object|Uint8Array|ArrayBuffer} input metadata record, or an ID3 tag
   * @returns {Uint8Array|null}
   */
  function buildId3Chunk(input) {
    if (input === null || input === undefined) return null;
    var isBytes = input instanceof Uint8Array ||
      (typeof ArrayBuffer !== 'undefined' && (input instanceof ArrayBuffer ||
        (ArrayBuffer.isView && ArrayBuffer.isView(input))));
    if (isBytes) return buildId3ChunkForWav(input);
    if (typeof input !== 'object') return null;
    /* buildId3v23 already returns the tag bytes, not a report object. */
    return buildId3ChunkForWav(buildId3v23(mapTagFields(input)));
  }

  /** Build a bare ID3v2.3 tag from a loose metadata record. */
  function buildId3TagFromMeta(input) {
    return buildId3v23(mapTagFields(input));
  }

  /**
   * Insert or replace RIFF chunks in a WAV file.
   *
   * New chunks are appended at the END of the chunk list rather than before
   * `data`. Both are legal and most players accept either, but appending keeps
   * the copy to a single linear pass instead of shifting the entire sample
   * payload, which for a 48 kHz stereo master is tens of megabytes of copying
   * saved per file. Any pre-existing `LIST`/`INFO` or `id3 ` chunk is removed so
   * tags cannot accumulate.
   *
   * @param {ArrayBuffer|Uint8Array} wavBuffer
   * @param {Array<Uint8Array>} chunks chunk blobs to append
   * @param {{warnings?:string[], logger?:Function, report?:object}} [opts]
   * @returns {ArrayBuffer} the original buffer, unchanged, on any failure
   */
  function injectRiffChunks(wavBuffer, chunks, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var ctx = { warnings: Array.isArray(o.warnings) ? o.warnings : [], logger: o.logger };
    var original =
      typeof ArrayBuffer !== 'undefined' && wavBuffer instanceof ArrayBuffer ? wavBuffer : toArrayBufferCopy(wavBuffer);

    function giveUp(reason) {
      warn(ctx, reason);
      if (o.report) {
        o.report.injected = false;
        o.report.reason = reason;
      }
      return original;
    }

    var u8 = toUint8(wavBuffer);
    if (!original || u8.length < 12) return giveUp('input is too small to be a RIFF file');
    if (!eqAscii(u8, 0, 'RIFF') || !eqAscii(u8, 8, 'WAVE')) return giveUp('input is not a RIFF/WAVE file');

    var incoming = [];
    var i;
    var added = 0;
    if (chunks && chunks.length) {
      for (i = 0; i < chunks.length; i++) {
        var c = toUint8(chunks[i]);
        if (c.length >= 8) {
          incoming.push(c);
          added += c.length;
        }
      }
    }
    if (!added) return giveUp('no RIFF chunks to insert');

    var dv = viewOf(u8);
    var offset = 12;
    var kept = []; // [start, end) ranges to preserve, in order
    while (offset + 8 <= u8.length) {
      var size = dv.getUint32(offset + 4, true); // little-endian
      var type = readAscii(u8, offset, 4);
      if (size < 0 || offset + 8 + size > u8.length) {
        /* Trailing garbage: preserve it verbatim rather than guessing. */
        kept.push([offset, u8.length]);
        break;
      }
      var end = offset + 8 + size + (size % 2); // chunks are word aligned
      if (end > u8.length) end = u8.length;
      var isInfo = type === 'LIST' && eqAscii(u8, offset + 8, 'INFO');
      if (type === 'id3 ' || isInfo) {
        warn(ctx, 'replacing existing RIFF ' + (isInfo ? 'LIST/INFO' : "id3 ") + ' chunk');
      } else {
        kept.push([offset, end]);
      }
      offset = end;
    }
    if (offset <= 12) kept.push([12, u8.length]);

    /* Reassemble in ONE allocation: header + preserved chunks + new chunks.
       (Building this incrementally reallocated and recopied the whole buffer per
       chunk, which is quadratic in the chunk count and made the trailing
       alignment easy to get wrong.) */
    var keptTotal = 0;
    for (i = 0; i < kept.length; i++) keptTotal += kept[i][1] - kept[i][0];

    var total = 12 + keptTotal + added;
    var out = new Uint8Array(total);
    out.set(u8.subarray(0, 12), 0);
    var w = 12;
    for (i = 0; i < kept.length; i++) {
      var slice = u8.subarray(kept[i][0], kept[i][1]);
      out.set(slice, w);
      w += slice.length;
    }
    for (i = 0; i < incoming.length; i++) {
      out.set(incoming[i], w);
      w += incoming[i].length;
    }

    /* The RIFF size field counts every byte after the first 8: the 4-byte
       'WAVE' form type plus every chunk. */
    viewOf(out).setUint32(4, total - 8, true);

    if (o.report) {
      o.report.injected = true;
      o.report.reason = null;
    }
    return out.buffer;
  }

  /* ---------------------------------------------------------------------- *
   * High level helpers
   * ---------------------------------------------------------------------- */

  /**
   * Decide the container from a filename, MIME type or an explicit hint.
   * @param {string} hint filename, extension or MIME type
   * @returns {'mp3'|'m4a'|'mp4'|'wav'|'unknown'}
   */
  function detectContainer(hint) {
    var s = cleanText(hint).toLowerCase().split(';')[0].trim();
    if (!s) return 'unknown';
    if (/\.(mp3|mpga|mp2)$/.test(s) || s.indexOf('audio/mpeg') === 0 || s.indexOf('audio/mp3') === 0) {
      return 'mp3';
    }
    if (/\.m4a$/.test(s) || s.indexOf('audio/m4a') === 0 || s.indexOf('audio/x-m4a') === 0) return 'm4a';
    if (
      /\.mp4$/.test(s) || /\.m4b$/.test(s) || /\.m4v$/.test(s) ||
      s.indexOf('audio/mp4') === 0 || s.indexOf('video/mp4') === 0
    ) {
      return 'mp4';
    }
    if (/\.wav$/.test(s) || /\.wave$/.test(s) || s.indexOf('audio/wav') === 0 || s.indexOf('audio/x-wav') === 0) {
      return 'wav';
    }
    if (s === 'mp3' || s === 'm4a' || s === 'mp4' || s === 'wav') return s;
    return 'unknown';
  }

  /**
   * Compose the `comment` / `ICMT` payload: model, clip id and prompt.
   * This is the one field that carries provenance, so it is assembled here
   * rather than left to every caller.
   *
   * @param {{model?:string, modelName?:string, clipId?:string, prompt?:string,
   *   tags?:string, extra?:string, promptLabel?:string}} spec
   * @returns {string}
   */
  function buildComment(spec) {
    var s = spec && typeof spec === 'object' ? spec : {};
    var parts = [];
    var model = cleanText(s.model) || cleanText(s.modelName);
    if (model) parts.push('Model: ' + model);
    var id = cleanText(s.clipId);
    if (id) parts.push('Clip ID: ' + id);
    var prompt = cleanText(s.prompt);
    if (prompt) parts.push((cleanText(s.promptLabel) || 'Prompt') + ':\n' + prompt);
    var tags = cleanText(s.tags);
    if (tags) parts.push('Style: ' + tags);
    var extra = cleanText(s.extra);
    if (extra) parts.push(extra);
    return parts.join('\n');
  }

  /**
   * Resolve the artist field.
   *
   * `clip.display_name`, `clip.handle` and `clip.user_id` are the OWNER's own
   * account echoed back by Suno — they are not a third-party artist. The
   * default is therefore a neutral name from settings; use the clip's own
   * identity only when the caller explicitly opts in.
   *
   * @param {{display_name?:string, handle?:string, user_id?:string}} [meta]
   * @param {{artist?:string, useClipOwnerAsArtist?:boolean}} [options]
   * @returns {string}
   */
  function resolveArtist(meta, options) {
    var o = options && typeof options === 'object' ? options : {};
    if (cleanText(o.artist)) return cleanText(o.artist);
    if (o.useClipOwnerAsArtist) {
      var m = meta && typeof meta === 'object' ? meta : {};
      var owner = cleanText(m.display_name) || cleanText(m.handle);
      if (owner) return owner;
    }
    return state.defaultArtist;
  }

  /**
   * Tag a decoded audio file, dispatching on container.
   *
   * @param {{bytes:ArrayBuffer|Uint8Array, container?:string, meta?:object,
   *   lyrics?:string, coverArt?:{bytes:Uint8Array, mime?:string}, bpm?:number,
   *   options?:object}} request
   * @returns {{bytes:ArrayBuffer|Uint8Array, container:string, injected:boolean,
   *   warnings:string[]}} never throws; `injected:false` means the input was
   *   returned untouched
   */
  function tagAudioFile(request) {
    var req = request && typeof request === 'object' ? request : {};
    var options = req.options && typeof req.options === 'object' ? req.options : {};
    var warnings = [];
    var ctx = { warnings: warnings, logger: options.logger };

    var input = req.bytes;
    var bytes = typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer ? input : toArrayBufferCopy(input);
    if (!bytes) {
      return { bytes: EMPTY, container: 'unknown', injected: false, warnings: ['no input bytes'] };
    }

    var container = detectContainer(req.container) !== 'unknown'
      ? detectContainer(req.container)
      : detectContainer(options.filename || options.mime || '');
    if (container === 'unknown') {
      warnings.push('container could not be determined; returning audio unchanged');
      return { bytes: bytes, container: container, injected: false, warnings: warnings };
    }

    var meta = req.meta && typeof req.meta === 'object' ? req.meta : {};
    var artist = resolveArtist(meta, options);
    var album = cleanText(options.album || state.defaultAlbum || meta.album);
    var genre = cleanText(meta.genre || meta.style || meta.tags);
    var comment = cleanText(options.comment) || buildComment({
      model: meta.model || meta.major_model_version || meta.model_name,
      modelName: meta.model_name,
      clipId: meta.clipId || meta.id,
      prompt: meta.prompt || (meta.metadata && meta.metadata.prompt),
      tags: (meta.metadata && meta.metadata.tags) || meta.tags,
      extra: meta.extra
    });
    var bpm = req.bpm !== undefined && req.bpm !== null ? req.bpm : meta.bpm;
    var lyrics = formatLyricsBlock(req.lyrics);
    var year = meta.year || (cleanText(meta.created_at).length ? String(cleanText(meta.created_at).slice(0, 4)) : '');

    var out = null;
    var injected = false;
    var i;

    if (container === 'mp3') {
      var report = buildId3v23Report({
        title: meta.title,
        artist: artist,
        album: album,
        genre: genre,
        year: year,
        comment: comment,
        key: meta.key,
        bpm: bpm,
        lyrics: lyrics,
        coverArt: req.coverArt,
        language: options.language,
        unsyncLyrics: options.unsyncLyrics,
        textEncoding: options.textEncoding,
        warnings: warnings
      });
      for (i = 0; i < report.warnings.length; i++) {
        if (warnings.indexOf(report.warnings[i]) === -1) warnings.push(report.warnings[i]);
      }
      out = injectId3IntoMp3(bytes, report.tag, ctx);
      injected = true;
    } else if (container === 'm4a' || container === 'mp4') {
      var mp4 = injectTagsIntoMp4(
        bytes,
        {
          title: meta.title,
          artist: artist,
          album: album,
          genre: genre,
          comment: comment,
          lyrics: lyrics,
          desc: cleanText(options.coverDescription || state.coverDescription),
          bpm: bpm,
          year: cleanText(year),
          coverArt: req.coverArt
        },
        { coverArt: req.coverArt, warnings: warnings, logger: options.logger }
      );
      out = mp4.bytes;
      injected = mp4.injected;
    } else if (container === 'wav') {
      var info = buildRiffInfoChunk({
        title: meta.title,
        artist: artist,
        album: album,
        genre: genre,
        comment: comment,
        year: year,
        track: options.trackNumber,
        encoding: options.riffTextEncoding
      });
      var id3Chunk = null;
      if (lyrics || comment || req.coverArt) {
        var wavTag = buildId3v23Report({
          title: meta.title,
          artist: artist,
          album: album,
          genre: genre,
          year: year,
          comment: comment,
          key: meta.key,
          bpm: bpm,
          lyrics: lyrics,
          coverArt: req.coverArt,
          warnings: warnings
        });
        id3Chunk = buildId3ChunkForWav(wavTag.tag);
      }
      var pieces = [];
      if (info) pieces.push(info);
      if (id3Chunk) pieces.push(id3Chunk);
      var riffReport = {};
      out = injectRiffChunks(bytes, pieces, { warnings: warnings, logger: options.logger, report: riffReport });
      injected = !!riffReport.injected;
    }

    if (!out) {
      warnings.push('unsupported container "' + container + '"; returning audio unchanged');
      return { bytes: bytes, container: container, injected: false, warnings: warnings };
    }
    return { bytes: out, container: container, injected: injected, warnings: warnings };
  }

  /* ---------------------------------------------------------------------- *
   * Export surface
   * ---------------------------------------------------------------------- */

  var api = {
    /* errors + configuration */
    SunoTagError: SunoTagError,
    configure: configure,
    createTagger: function (opts) {
      return Object.assign({}, api, { options: opts && typeof opts === 'object' ? opts : {} });
    },

    /* syncsafe integers */
    encodeSyncsafe: encodeSyncsafe,
    decodeSyncsafe: decodeSyncsafe,

    /* text hygiene + redaction */
    cleanText: cleanText,
    formatLyricsBlock: formatLyricsBlock,
    redact: redact,
    mapTagFields: mapTagFields,

    /* ID3v2.3 */
    hasId3Tag: hasId3Tag,
    stripExistingId3: stripExistingId3,
    buildId3v23: buildId3v23,
    buildId3v23Report: buildId3v23Report,
    buildComment: buildComment,
    resolveArtist: resolveArtist,
    sniffImageMime: sniffImageMime,
    injectId3IntoMp3: injectId3IntoMp3,

    /* MP4 / M4A */
    makeAtom: makeAtom,
    makeDataAtom: makeDataAtom,
    makeFreeformAtom: makeFreeformAtom,
    makeHdlrAtom: makeHdlrAtom,
    makeMetaAtom: makeMetaAtom,
    buildIlst: buildIlst,
    walkTopAtoms: walkTopAtoms,
    fixChunkOffsets: fixChunkOffsets,
    injectTagsIntoMp4: injectTagsIntoMp4,
    injectId3IntoM4a: injectId3IntoM4a,

    /* RIFF / WAV */
    buildRiffInfoChunk: buildRiffInfoChunk,
    buildId3ChunkForWav: buildId3ChunkForWav,
    buildId3Chunk: buildId3Chunk,
    buildId3TagFromMeta: buildId3TagFromMeta,
    injectRiffChunks: injectRiffChunks,

    /* dispatch */
    detectContainer: detectContainer,
    tagAudioFile: tagAudioFile,

    /* constants, handy for callers and tests */
    MAX_SYNCSAFE: SYNCSAFE_MAX,
    CONTAINER_MP3: 'mp3',
    CONTAINER_M4A: 'm4a',
    CONTAINER_MP4: 'mp4',
    CONTAINER_WAV: 'wav',
    CONTAINER_UNKNOWN: 'unknown'
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.SunoTagger = api; // not window: an MV3 service worker has no window (see lib/audio.js findTagger)
})();
