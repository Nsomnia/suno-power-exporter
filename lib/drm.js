/**
 * Suno Master Utility — orchestration layer for Suno "Mango" media decryption.
 *
 * WHAT THIS FILE IS
 * -----------------
 * The layer that actually goes and gets the music. `lib/crypto.js` holds the
 * primitives; this file owns the network, the rights handshake, the streaming
 * fetch, the cache, and the fan-out.
 *
 * THE PROBLEM
 * -----------
 * `clip.audio_url` is a decoy. For every clip it is the literal string
 * `https://studio-api.prod.suno.com/api/forbidden`. Anything that trusts it
 * saves a 0-byte or HTML file. The real audio lives at
 * `clip.media_urls[i].url` — a CloudFront object `.../1/clip/{id}.m4a` with
 * `content_type: "m4a-opus"` — and those bytes are AES-CTR encrypted with a
 * per-clip content key that is itself AES-GCM wrapped under a per-user key.
 * Unwrapping requires `POST /api/mango/rights`. This is the only route to the
 * actual music that does not spend the user's monthly download quota.
 *
 * PIPELINE
 * --------
 *   1. `pickMediaUrl`     — find the real asset, skipping the decoy. An entry
 *                           with NO `encoding` field has been reported as an
 *                           unencrypted progressive asset (BetterSuno filters on
 *                           exactly `!m.encoding`); if one is requested we take
 *                           the whole rights detour out of the loop.
 *   2. `fetchRights`      — `POST /api/mango/rights`, walking a prioritized body
 *                           list until one shape returns 2xx.
 *   3. `resolveUserKey`   — SHA-256 of the bearer token, else of `glt`.
 *   4. unwrap key + IV    — AES-GCM under the user key (see lib/crypto.js).
 *   5. probe size         — `Range: bytes=0-0`, parse `Content-Range`.
 *   6. stream media       — with progress, with a memory cap.
 *   7. chunked AES-CTR    — 256 KiB at a time, byte-exact counters.
 *   8. verify container   — `ftyp` / `ID3`. A failure is typed, never silent.
 *
 * TWO UNRESOLVED QUESTIONS, AND WHAT WE DO ABOUT THEM
 * ---------------------------------------------------
 * **(1) Is the request body nested?** No. Recon could not reproduce
 * `{content_params:{content_id,content_type}}`; every flat attempt failed
 * validation. The server's 422 `loc` chains are a KNOWN FABRICATION ARTIFACT and
 * are ignored entirely — we never read them. Instead {@link RIGHTS_BODY_SHAPES}
 * is a prioritized list, we stop at the first 2xx, and we record which shape won
 * in `stats().rights.bodyShape` so it can be pinned down once and hard-coded.
 *
 * **(2) Is the user key seeded from the bearer token or from `glt`?** Genuinely
 * unattested either way: one lineage hashes `glt` and works for guests with no
 * token at all, another hashes the bearer token. They cannot both be right for
 * one account. {@link SunoDRM.resolveUserKey} prefers the bearer digest when a
 * token is present and ALWAYS returns an ordered `attempts` array, so the caller
 * can retry with the other seed without a second network round trip.
 *
 * SECURITY POSTURE
 * ----------------
 * No `console.*` call anywhere in this file; a single injected `logger`, no-op
 * by default, and every argument it receives passes through `redact()` first.
 * Unwrapped content keys are held in an in-memory LRU and are NEVER written to
 * `chrome.storage`, `localStorage`, `sessionStorage`, or `indexedDB` — key
 * material in extension storage is readable by anything with the extension id
 * and survives on disk. The cache is also the only place a `CryptoKey` outlives
 * a single call, so it is deliberately bounded (512) and TTL'd (3600 s).
 *
 * ENVIRONMENT
 * -----------
 * No imports, no DOM, no `window` at load time, no `chrome.*` at load time.
 * Runs in the MV3 service worker, in a content script, and under node. Every
 * network call takes an `AbortSignal` and a timeout. No raw `DOMException`
 * escapes: every failure is a `SunoCryptoError` with `stage`, `clipId`,
 * `status`, and `reason`.
 *
 * EXPOSURE
 * --------
 *   window.SunoDRM       -> an INSTANCE carrying every static
 *   window.SunoDRMClass  -> the class
 *   module.exports       -> { SunoDRM, SunoDRMClass }
 */

(function () {
  'use strict';

  /* ================================================================== *
   * constants
   * ================================================================== */

  /**
   * Rights endpoint. The reference implementation uses the dash form; the decoy
   * URL uses the dot form. Overridable via the constructor so a wrong guess is
   * a one-line fix rather than a code change.
   * @type {string}
   */
  var DEFAULT_RIGHTS_ENDPOINT = 'https://studio-api-prod.suno.com/api/mango/rights';

  /**
   * Origin and referer sent with the rights POST. Suno's edge rejects a request
   * without them, and a bare `fetch` from a content script would send
   * `Origin: null`.
   */
  var SUNO_ORIGIN = 'https://suno.com';
  var SUNO_REFERER = 'https://suno.com/';

  /**
   * Prioritized `/api/mango/rights` request bodies, most likely first.
   *
   * Stop at the first 2xx and record which one won. Never infer the shape from
   * a 422 `loc` chain — those are a known fabrication artifact.
   * @type {ReadonlyArray<{name: string, build: function(string): object}>}
   */
  var RIGHTS_BODY_SHAPES = Object.freeze([
    {
      name: 'content_params',
      build: function (clipId) {
        return { content_params: { content_id: clipId, content_type: 'clip' } };
      }
    },
    {
      name: 'flat',
      build: function (clipId) {
        return { content_id: clipId, content_type: 'clip' };
      }
    },
    {
      name: 'minimal',
      build: function (clipId) {
        return { content_id: clipId };
      }
    }
  ]);

  /**
   * The decoy marker. `audio_url` matching this means "you got fooled".
   * @type {RegExp}
   */
  var FORBIDDEN_RE = /forbidden/i;

  /**
   * Blob MIME for decoded M4A.
   *
   * MUST be `audio/x-m4a` and MUST NOT be `audio/mp4`. An MP4-family blob
   * declared as `audio/mp4` is what Chromium writes to disk with an `.m4b`
   * extension — the file plays, but the user's library ends up full of `.m4b`
   * files that no desktop music player will open. `audio/x-m4a` is the MIME
   * that keeps the `.m4a` extension. Changing this is a one-character outage.
   * @type {string}
   */
  var BLOB_TYPE_M4A = 'audio/x-m4a';

  /** Blob MIME for a container detected as MP3. @type {string} */
  var BLOB_TYPE_MP3 = 'audio/mpeg';

  /** Default in-memory key cache TTL. The reference ecosystem caches ~3600 s. @type {number} */
  var KEY_CACHE_TTL_MS = 3600 * 1000;

  /** Default key cache capacity. @type {number} */
  var KEY_CACHE_CAPACITY = 512;

  /** Default chunk size for the media decrypt, bytes. @type {number} */
  var DEFAULT_CHUNK_SIZE = 262144;

  /** Default per-request timeout, ms. @type {number} */
  var DEFAULT_TIMEOUT_MS = 20000;

  /** Default media read timeout, ms — larger, since clips are big. @type {number} */
  var DEFAULT_MEDIA_TIMEOUT_MS = 120000;

  /** Default memory cap for a single clip, bytes (~256 MiB ≈ a 3-hour clip). @type {number} */
  var DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

  /** Default fan-out concurrency for `decryptMany`. @type {number} */
  var DEFAULT_CONCURRENCY = 3;

  /* ================================================================== *
   * small utilities
   * ================================================================== */

  /**
   * Resolve the global object without assuming `window` (an MV3 service worker
   * has none) or `self` (node has neither).
   * @returns {object|null}
   */
  function getGlobal() {
    if (typeof globalThis !== 'undefined') return globalThis;
    /* istanbul ignore next - pre-globalThis engines only */
    if (typeof self !== 'undefined') return self;
    /* istanbul ignore next */
    if (typeof window !== 'undefined') return window;
    /* istanbul ignore next */
    return null;
  }

  /**
   * Coerce whatever the caller injected into a logger with `debug`/`info`/
   * `warn`/`error` methods. Defaults to a complete no-op — this file must be
   * silent unless someone opts in.
   * @param {object|Function} [logger]
   * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
   */
  function normalizeLogger(logger) {
    var noop = function () {};
    var base = { debug: noop, info: noop, warn: noop, error: noop, log: noop };
    if (!logger) return base;
    if (typeof logger === 'function') return {
      debug: logger, info: logger, warn: logger, error: logger, log: logger
    };
    if (typeof logger !== 'object') return base;
    ['debug', 'info', 'warn', 'error', 'log'].forEach(function (level) {
      if (typeof logger[level] === 'function') base[level] = logger[level].bind(logger);
    });
    return base;
  }

  /**
   * Promise-based delay.
   * @param {number} ms
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      var timer = setTimeout(function () {
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Bounded, TTL'd, insertion-ordered LRU.
   *
   * `Map` preserves insertion order, so re-inserting on read makes the first key
   * the least-recently-used and eviction is `keys().next()`. No dependency, no
   * `chrome.storage`, nothing on disk — this holds `CryptoKey` objects.
   * @template V
   */
  class LruCache {
    /**
     * @param {number} ttlMs
     * @param {number} capacity
     */
    constructor(ttlMs, capacity) {
      this.ttlMs = ttlMs;
      this.capacity = capacity;
      this.map = new Map();
      this.hits = 0;
      this.misses = 0;
      this.evictions = 0;
      this.expired = 0;
    }

    /**
     * @param {string} key
     * @returns {*|undefined} The value, or `undefined` on miss/expiry.
     */
    get(key) {
      var entry = this.map.get(key);
      if (!entry) {
        this.misses++;
        return undefined;
      }
      if (Date.now() > entry.expiresAt) {
        this.map.delete(key);
        this.expired++;
        this.misses++;
        return undefined;
      }
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, entry);
      this.hits++;
      return entry.value;
    }

    /**
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, { value: value, expiresAt: Date.now() + this.ttlMs });
      while (this.map.size > this.capacity) {
        var oldest = this.map.keys().next();
        if (oldest.done) break;
        this.map.delete(oldest.value);
        this.evictions++;
      }
    }

    /** Drop everything. Called on account switch and sign-out. */
    clear() {
      this.map.clear();
    }

    /** @returns {number} */
    get size() {
      return this.map.size;
    }
  }

  /* ================================================================== *
   * standalone error fallback
   * ================================================================== */

  /**
   * Minimal `SunoCryptoError` used only when `lib/crypto.js` is not loaded, so
   * that `lib/drm.js` on its own still raises typed errors instead of leaking a
   * `DOMException`. When crypto.js IS present its real class is used, and
   * `instanceof` checks keep working for both.
   * @param {string} message
   * @param {object} [info]
   * @extends {Error}
   */
  function FallbackCryptoError(message, info) {
    var err = Error.call(this, message);
    this.message = message;
    this.name = 'SunoCryptoError';
    this.stage = (info && info.stage) || 'unknown';
    this.clipId = info && info.clipId;
    this.status = info && info.status;
    this.reason = (info && info.reason) || 'unspecified';
    if (info && info.cause) this.causeName = info.cause.name || 'Error';
    if (Error.captureStackTrace) Error.captureStackTrace(this, FallbackCryptoError);
  }
  FallbackCryptoError.prototype = Object.create(Error.prototype);
  FallbackCryptoError.prototype.constructor = FallbackCryptoError;
  FallbackCryptoError.isRightsError = function (e) { return !!e && e.stage === 'rights'; };
  FallbackCryptoError.isDecryptError = function (e) {
    return !!e && (e.stage === 'decrypt' || e.stage === 'unwrap' || e.stage === 'import');
  };
  FallbackCryptoError.isVerificationError = function (e) { return !!e && e.stage === 'verify'; };

  /* ================================================================== *
   * SunoDRM
   * ================================================================== */

  /**
   * Fetches rights and decrypts Suno clip media.
   * @class
   */
  class SunoDRM {
    /**
     * @param {object} [opts]
     * @param {Function} [opts.fetchImpl]  Injected `fetch`. Defaults to
     *   `globalThis.fetch`; injected in tests and by callers that need a
     *   different origin policy.
     * @param {string} [opts.rightsEndpoint]  Defaults to the reference endpoint.
     * @param {object|Function} [opts.logger]  Single injected logger, no-op by
     *   default. Every argument it receives is passed through `redact()` first.
     * @param {object} [opts.cryptoImpl]  Primitives provider; defaults to the
     *   global `SunoCrypto` installed by lib/crypto.js.
     * @param {number} [opts.chunkSize=262144]
     * @param {number} [opts.maxBytes]  Memory cap per clip.
     * @param {number} [opts.timeoutMs=20000]
     * @param {number} [opts.mediaTimeoutMs=120000]
     * @param {number} [opts.concurrency=3]
     * @param {number} [opts.keyCacheTtlMs=3600000]
     * @param {number} [opts.keyCacheCapacity=512]
     */
    constructor(opts) {
      var o = opts || {};
      this._fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : null;
      this.rightsEndpoint = o.rightsEndpoint || DEFAULT_RIGHTS_ENDPOINT;
      this._logger = normalizeLogger(o.logger);
      this._cryptoImpl = o.cryptoImpl || null;
      this._errorImpl = null;
      this.chunkSize = typeof o.chunkSize === 'number' ? o.chunkSize : DEFAULT_CHUNK_SIZE;
      this.maxBytes = typeof o.maxBytes === 'number' ? o.maxBytes : DEFAULT_MAX_BYTES;
      this.timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
      this.mediaTimeoutMs = typeof o.mediaTimeoutMs === 'number' ? o.mediaTimeoutMs : DEFAULT_MEDIA_TIMEOUT_MS;
      this.concurrency = Math.max(1, o.concurrency || DEFAULT_CONCURRENCY);
      this._keyCache = new LruCache(
        typeof o.keyCacheTtlMs === 'number' ? o.keyCacheTtlMs : KEY_CACHE_TTL_MS,
        Math.max(1, o.keyCacheCapacity || KEY_CACHE_CAPACITY)
      );
      this._stats = {
        rights: {
          requests: 0, ok: 0, failed: 0, lastStatus: 0,
          bodyShape: null, shapesTried: {}, attemptsByShape: {}
        },
        media: {
          fetches: 0, probes: 0, rangeIgnored: 0,
          bytesFetched: 0, maxBytesRejected: 0, unknownSize: 0
        },
        decrypt: {
          clips: 0, chunked: 0, unencrypted: 0,
          unwrapFailures: 0, decryptFailures: 0, verificationFailures: 0
        },
        keySource: { bearer: 0, glt: 0, none: 0, fallbackTried: 0 }
      };
    }

    /* -------------------------------------------------------------- *
     * internals
     * -------------------------------------------------------------- */

    /**
     * Resolve the crypto primitives, or throw a typed error explaining that
     * lib/crypto.js is missing. Never returns null.
     *
     * Resolution order:
     *   1. `opts.cryptoImpl` passed to this constructor;
     *   2. `SunoDRM.setCrypto(impl)` — explicit wiring, for bundlers;
     *   3. `globalThis.SunoCrypto` / `.SunoCryptoClass` — the content-script and
     *      service-worker path, where both files are loaded as classic scripts;
     *   4. a CommonJS sibling `require('./crypto.js')` — the node path.
     *
     * @param {string} [clipId]
     * @returns {object} An object exposing `toBytes`, `sha256`, `redact`, …
     */
    _crypto(clipId) {
      if (this._cryptoImpl && typeof this._cryptoImpl.toBytes === 'function') return this._cryptoImpl;
      var shared = SunoDRM._sharedCrypto();
      if (shared) return shared;
      var g = getGlobal();
      if (g) {
        if (g.SunoCrypto && typeof g.SunoCrypto.toBytes === 'function') return g.SunoCrypto;
        if (g.SunoCryptoClass && typeof g.SunoCryptoClass.toBytes === 'function') return g.SunoCryptoClass;
      }
      var sibling = SunoDRM._requireSiblingCrypto();
      if (sibling) return sibling;
      throw this._err(
        'lib/crypto.js is not loaded; SunoDRM needs SunoCrypto primitives. ' +
        'Load lib/crypto.js first, or pass it as { cryptoImpl } / SunoDRM.setCrypto().',
        { stage: 'import', clipId: clipId, reason: 'crypto-impl-missing' }
      );
    }

    /**
     * Wire the crypto primitives explicitly. Needed only when lib/crypto.js is
     * NOT loaded as a global script (bundlers, node unit tests).
     * @param {object|null} impl The `SunoCrypto` instance or class.
     * @returns {object|null} The impl, for chaining.
     */
    static setCrypto(impl) {
      SunoDRM._injectedCrypto = (impl && typeof impl.toBytes === 'function') ? impl : null;
      return SunoDRM._injectedCrypto;
    }

    /**
     * Explicitly-injected primitives, else the global, else null.
     * @returns {object|null}
     */
    static _sharedCrypto() {
      if (SunoDRM._injectedCrypto) return SunoDRM._injectedCrypto;
      return null;
    }

    /**
     * Best-effort `require('./crypto.js')` for the CommonJS path, resolved once.
     * Guarded so it can never run in a browser or service worker.
     * @returns {object|null}
     */
    static _requireSiblingCrypto() {
      if (SunoDRM._siblingCrypto !== undefined) return SunoDRM._siblingCrypto;
      SunoDRM._siblingCrypto = null;
      try {
        if (typeof module !== 'undefined' && module.exports &&
          typeof module.require === 'function') {
          var sibling = module.require('./crypto.js');
          if (sibling && sibling.SunoCrypto && typeof sibling.SunoCrypto.toBytes === 'function') {
            SunoDRM._siblingCrypto = sibling.SunoCrypto;
          } else if (sibling && typeof sibling.toBytes === 'function') {
            SunoDRM._siblingCrypto = sibling;
          }
        }
      } catch (cause) {
        // Not a CommonJS sibling, or crypto.js is absent. The caller turns this
        // into an actionable error message.
        SunoDRM._siblingCrypto = null;
      }
      return SunoDRM._siblingCrypto;
    }

    /**
     * Resolve the error class. Uses the real `SunoCryptoError` when available so
     * `SunoCryptoError.isDecryptError(e)` works on our failures.
     * @returns {Function}
     */
    _errClass() {
      if (this._errorImpl) return this._errorImpl;
      var g = getGlobal();
      var impl = this._cryptoImpl || SunoDRM._sharedCrypto() ||
        (g && (g.SunoCrypto || g.SunoCryptoClass)) ||
        SunoDRM._requireSiblingCrypto();
      if (impl && typeof impl.SunoCryptoError === 'function') this._errorImpl = impl.SunoCryptoError;
      else if (g && typeof g.SunoCryptoError === 'function') this._errorImpl = g.SunoCryptoError;
      else this._errorImpl = FallbackCryptoError;
      return this._errorImpl;
    }

    /**
     * Build a typed error.
     * @param {string} message
     * @param {object} [info]
     * @returns {Error}
     */
    _err(message, info) {
      return new (this._errClass())(message, info);
    }

    /**
     * Resolve the `fetch` implementation.
     * @returns {Function}
     */
    _fetch() {
      if (this._fetchImpl) return this._fetchImpl;
      var g = getGlobal();
      if (g && typeof g.fetch === 'function') return g.fetch.bind(g);
      throw this._err('No fetch implementation available; pass one to the constructor.', {
        stage: 'fetch', reason: 'fetch-unavailable'
      });
    }

    /**
     * Log through the injected logger with every argument redacted.
     * @param {string} level
     * @param {string} message
     * @param {object} [context]
     */
    _log(level, message, context) {
      var fn = this._logger[level];
      if (typeof fn !== 'function') return;
      if (!context) {
        fn(message);
        return;
      }
      var safe;
      try {
        safe = this._crypto().redact(context);
      } catch (err) {
        // redact() itself failed; log shape only, never the values.
        safe = '[unredactable]';
      }
      var rendered;
      try {
        rendered = JSON.stringify(safe);
      } catch (err) {
        rendered = '[unserializable]';
      }
      fn(message + ' ' + rendered);
    }

    /**
     * `fetch` with an `AbortSignal`, a timeout, and typed errors. Every network
     * call in this file goes through here — there is no bare `fetch`.
     *
     * @param {string} url
     * @param {object} init
     * @param {object} opts
     * @param {AbortSignal} [opts.signal]
     * @param {number} opts.timeoutMs
     * @param {string} opts.stage
     * @param {string} [opts.clipId]
     * @returns {Promise<Response>}
     */
    async _fetchWithTimeout(url, init, opts) {
      var self = this;
      var external = opts.signal;

      // An already-aborted signal must fail BEFORE a request is issued, or an
      // injected fetchImpl that ignores `signal` would sail through and return
      // a response for work the caller already cancelled.
      if (external && external.aborted) {
        throw this._err('Request aborted before it started.', {
          stage: opts.stage, clipId: opts.clipId, reason: 'aborted'
        });
      }

      var controller = new AbortController();
      var onAbort = null;
      if (external && external.addEventListener) {
        onAbort = function () { controller.abort(); };
        external.addEventListener('abort', onAbort, { once: true });
      }

      var merged = {};
      Object.keys(init || {}).forEach(function (k) { merged[k] = init[k]; });
      merged.signal = controller.signal;

      // Race the request against our own deadline instead of relying on the
      // transport to honour `signal`. `fetch` does abort, but an injected
      // implementation (or a wedged connection) need not, and a timeout that
      // only works when the transport cooperates is not a timeout.
      //
      // ONE timer drives both the abort and the rejection, and it is always
      // cleared in `finally`. A leaked timer per request would keep an MV3
      // service worker alive long after the work finished.
      var timer = null;
      var deadline = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          controller.abort();
          reject(self._err(
            'Request timed out after ' + opts.timeoutMs + 'ms.',
            { stage: opts.stage, clipId: opts.clipId, reason: 'timeout' }
          ));
        }, opts.timeoutMs);
      });

      var pending;
      try {
        pending = Promise.resolve(this._fetch()(url, merged));
      } catch (cause) {
        // Synchronous throw from an injected fetchImpl (e.g. a malformed URL).
        clearTimeout(timer);
        if (external && onAbort && external.removeEventListener) {
          external.removeEventListener('abort', onAbort);
        }
        throw this._err(
          'Network request failed (' + (cause && cause.name ? cause.name : 'Error') + ').',
          { stage: opts.stage, clipId: opts.clipId, reason: 'network-error', cause: cause }
        );
      }

      // If the deadline wins the race, `pending` is still live and will reject
      // later with nobody listening. Swallow it so it cannot surface as an
      // unhandled rejection.
      pending.catch(function () { /* superseded by the deadline, or already handled below */ });

      try {
        return await Promise.race([pending, deadline]);
      } catch (cause) {
        if (cause && cause.stage === opts.stage &&
          (cause.reason === 'timeout' || cause.reason === 'aborted')) throw cause;
        if (external && external.aborted) {
          throw self._err('Request aborted.', {
            stage: opts.stage, clipId: opts.clipId, reason: 'aborted'
          });
        }
        throw self._err(
          'Network request failed (' + (cause && cause.name ? cause.name : 'Error') + ').',
          { stage: opts.stage, clipId: opts.clipId, reason: 'network-error', cause: cause }
        );
      } finally {
        clearTimeout(timer);
        if (external && onAbort && external.removeEventListener) {
          external.removeEventListener('abort', onAbort);
        }
      }
    }

    /* -------------------------------------------------------------- *
     * media URL selection
     * -------------------------------------------------------------- */

    /**
     * Is this clip's `audio_url` the decoy (or missing)?
     *
     * TRUE means "you cannot trust `audio_url`; go to `media_urls`". Suno sets
     * `audio_url` to `https://studio-api.prod.suno.com/api/forbidden` for every
     * clip, so this is true for essentially the whole library and false only for
     * genuinely playable or hand-fixed payloads.
     *
     * @param {object} clip
     * @returns {boolean}
     */
    static isEncryptedMediaUrl(clip) {
      if (!clip || typeof clip !== 'object') return true;
      var candidates = [clip.audio_url, clip.audioUrl];
      var meta = clip.metadata || clip.meta;
      if (meta && typeof meta === 'object') {
        candidates.push(meta.audio_url, meta.audioUrl);
      }
      var sawAny = false;
      for (var i = 0; i < candidates.length; i++) {
        var v = candidates[i];
        if (v == null || v === '') continue;
        sawAny = true;
        if (FORBIDDEN_RE.test(String(v))) return true;
      }
      // Missing entirely is treated as "the decoy is in play" — conservative.
      return !sawAny;
    }

    /**
     * Pick the real media asset from a clip.
     *
     * Scans `clip.media_urls`, `clip.metadata.media_urls`, and
     * `clip.meta.media_urls`. Entries whose `url` matches the decoy, or which
     * carry no URL at all, are skipped.
     *
     * The unencrypted heuristic: an entry with **no `encoding` field** has been
     * reported as an unencrypted progressive asset — BetterSuno filters on
     * exactly `!m.encoding`. When `preferUnencrypted` is set, such an entry wins
     * outright and the caller can skip the entire rights + AES round trip.
     *
     * Ranking (higher wins):
     *   - `preferUnencrypted` ? no-`encoding` (3) : has-`encoding` (2)
     *   - `preferUnencrypted` ? has-`encoding` (1) : no-`encoding` (1)
     *   - ties break toward an `m4a`-ish `content_type`, then original order.
     *
     * @param {object} clip
     * @param {object} [opts]
     * @param {boolean} [opts.preferUnencrypted=false]
     * @returns {{url: string, contentType: (string|undefined), encrypted: boolean}|null}
     *   `null` when the clip exposes no usable media entry.
     */
    static pickMediaUrl(clip, opts) {
      if (!clip || typeof clip !== 'object') return null;
      var preferUnencrypted = !!(opts && opts.preferUnencrypted);

      var lists = [clip.media_urls];
      var meta = clip.metadata || clip.meta;
      if (meta && typeof meta === 'object') {
        lists.push(meta.media_urls, clip.meta && clip.meta.media_urls);
      }

      var best = null;
      var bestScore = -1;
      var seen = 0;
      for (var l = 0; l < lists.length && best === null; l++) {
        var list = lists[l];
        if (!Array.isArray(list)) continue;
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!m) continue;
          var url = typeof m === 'string' ? m : m.url;
          if (!url || FORBIDDEN_RE.test(String(url))) continue;

          var hasEncoding = m && typeof m === 'object' && m.encoding != null;
          var encrypted = hasEncoding;
          var contentType = m && typeof m === 'object'
            ? (m.content_type || m.contentType || m.mime_type || m.mimeType)
            : undefined;

          var score;
          if (preferUnencrypted) {
            score = encrypted ? 1 : 3;
          } else {
            score = encrypted ? 2 : 1;
          }
          // Prefer an m4a-ish asset when scores tie.
          if (contentType && /m4a|mp4|opus/i.test(String(contentType))) score += 0.1;
          // Stable ordering: earlier entries win exact ties.
          score += Math.max(0, 0.05 - seen * 0.001);

          if (score > bestScore) {
            bestScore = score;
            best = {
              url: String(url),
              contentType: contentType == null ? undefined : String(contentType),
              encrypted: encrypted
            };
            if (preferUnencrypted && !encrypted) break;
          }
          seen++;
          if (best && preferUnencrypted && !best.encrypted) break;
        }
      }
      return best;
    }

    /* -------------------------------------------------------------- *
     * rights
     * -------------------------------------------------------------- */

    /**
     * `POST /api/mango/rights` and normalize the response.
     *
     * Walks {@link RIGHTS_BODY_SHAPES} in order and stops at the first 2xx. The
     * winning shape is recorded in `stats().rights.bodyShape` so it can be
     * pinned once someone confirms it. A 422 `loc` chain is never consulted —
     * those are a known fabrication artifact.
     *
     * A 2xx that lacks `key` or `iv` is treated as a failure and the walk
     * continues, because a proxy that answers 200 with an error object would
     * otherwise end the search early.
     *
     * Guest/anonymous mode works: no `Authorization` header is sent when there
     * is no bearer token, but `credentials: 'include'` still carries the
     * session cookie, and the `glt` field in the response is enough to derive a
     * user key.
     *
     * @param {string} clipId
     * @param {object} [opts]
     * @param {string} [opts.bearerToken]
     * @param {AbortSignal} [opts.signal]
     * @param {number} [opts.timeoutMs]
     * @returns {Promise<{key: string, iv: string, glt: string, aad: string, mediaUrl: (string|undefined), raw: object, bodyShape: string}>}
     * @throws {SunoCryptoError} stage `rights`.
     */
    async fetchRights(clipId, opts) {
      var self = this;
      var o = opts || {};
      var s = this._stats.rights;
      var headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: SUNO_ORIGIN,
        Referer: SUNO_REFERER
      };
      if (o.bearerToken) headers.Authorization = 'Bearer ' + o.bearerToken;

      var lastStatus = 0;
      var shapesTried = [];
      // Tracks whether ANY shape came back 2xx, so the final error can say
      // "the server answered but the payload was unusable" instead of blaming
      // the body shape.
      var sawOk = false;

      for (var i = 0; i < RIGHTS_BODY_SHAPES.length; i++) {
        var shape = RIGHTS_BODY_SHAPES[i];
        s.requests++;
        s.shapesTried[shape.name] = (s.shapesTried[shape.name] || 0) + 1;
        shapesTried.push(shape.name);

        var response = await this._fetchWithTimeout(
          this.rightsEndpoint,
          { method: 'POST', headers: headers, credentials: 'include', body: JSON.stringify(shape.build(clipId)) },
          {
            signal: o.signal,
            timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : this.timeoutMs,
            stage: 'rights',
            clipId: clipId
          }
        );
        lastStatus = response.status;
        s.lastStatus = response.status;

        if (!response.ok) {
          // Drain the body so the connection can be reused, then move on.
          await SunoDRM._discardBody(response);
          this._log('debug', 'rights shape rejected', {
            shape: shape.name, status: response.status, clipId: clipId
          });
          continue;
        }

        var payload = await SunoDRM._readJson(response, clipId, self);
        var normalized = self._normalizeRights(payload, clipId, shape.name);
        if (!normalized) {
          // 2xx but unusable — keep walking the shape list.
          sawOk = true;
          continue;
        }

        s.ok++;
        s.bodyShape = shape.name;
        s.attemptsByShape[shape.name] = shapesTried.length;
        this._log('debug', 'rights ok', {
          shape: shape.name, status: response.status, clipId: clipId,
          attempts: shapesTried.length
        });
        return normalized;
      }

      s.failed++;
      // Classify honestly: a 2xx with no key material is a very different
      // problem from a 401, and neither is the same as "no shape worked".
      var reason;
      if (sawOk) reason = 'missing-key-material';
      else if (lastStatus === 401 || lastStatus === 403) reason = 'unauthorized';
      else if (lastStatus === 404) reason = 'endpoint-not-found';
      else if (lastStatus === 429) reason = 'rate-limited';
      else if (lastStatus >= 500) reason = 'http-5xx';
      else if (lastStatus === 0) reason = 'no-response';
      else reason = 'no-shape-accepted';
      throw this._err(
        'Rights request failed for every known body shape (' + shapesTried.join(', ') +
        '); last HTTP status ' + lastStatus +
        (sawOk ? ' (2xx payload had no key/iv)' : '') + '.',
        {
          stage: 'rights', clipId: clipId, status: lastStatus, reason: reason
        }
      );
    }

    /**
     * Normalize a rights payload, tolerating a `data` envelope.
     *
     * Returns `null` when the payload has no usable key material, so the caller
     * can keep walking the body-shape list.
     *
     * @param {*} payload Parsed JSON.
     * @param {string} clipId
     * @param {string} bodyShape
     * @returns {{key: string, iv: string, glt: string, aad: string, mediaUrl: (string|undefined), raw: object, bodyShape: string}|null}
     */
    _normalizeRights(payload, clipId, bodyShape) {
      if (!payload || typeof payload !== 'object') return null;
      var data = (payload.data && typeof payload.data === 'object') ? payload.data : payload;

      var key = SunoDRM._firstString(data.key, data.content_key, payload.key, payload.content_key);
      var iv = SunoDRM._firstString(data.iv, data.content_iv, payload.iv, payload.content_iv);
      if (!key || !iv) return null;

      var glt = SunoDRM._firstString(data.glt, data.glt_token, payload.glt, payload.glt_token) || '';
      var aad = SunoDRM._firstString(data.aad, payload.aad) || clipId;
      var mediaUrl = SunoDRM._pickRightsMediaUrl(data) || SunoDRM._pickRightsMediaUrl(payload);

      return {
        key: key,
        iv: iv,
        glt: glt,
        aad: aad,
        mediaUrl: mediaUrl && !FORBIDDEN_RE.test(mediaUrl) ? mediaUrl : undefined,
        raw: payload,
        bodyShape: bodyShape
      };
    }

    /**
     * First non-empty string among the candidates.
     * @param {...*} candidates
     * @returns {string|undefined}
     */
    static _firstString() {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (typeof v === 'string' && v.length) return v;
      }
      return undefined;
    }

    /**
     * Pull a media URL out of a rights payload, ignoring the decoy.
     * @param {object} obj
     * @returns {string|undefined}
     */
    static _pickRightsMediaUrl(obj) {
      if (!obj || typeof obj !== 'object') return undefined;
      var url = SunoDRM._firstString(
        obj.media_url, obj.mediaUrl, obj.url, obj.audio_url, obj.audioUrl, obj.src
      );
      if (url && FORBIDDEN_RE.test(url)) return undefined;
      return url;
    }

    /**
     * Read a response body as JSON, typed on failure.
     * @param {Response} response
     * @param {string} clipId
     * @param {SunoDRM} owner
     * @returns {Promise<*>}
     */
    static async _readJson(response, clipId, owner) {
      try {
        return await response.json();
      } catch (cause) {
        throw owner._err('Rights response was not valid JSON.', {
          stage: 'rights', clipId: clipId, status: response.status,
          reason: 'invalid-json', cause: cause
        });
      }
    }

    /**
     * Drain and release a response body we are not going to read.
     * @param {Response} response
     * @returns {Promise<void>}
     */
    static async _discardBody(response) {
      try {
        if (response && response.body && typeof response.body.cancel === 'function') {
          await response.body.cancel();
        } else if (response && typeof response.arrayBuffer === 'function') {
          await response.arrayBuffer();
        }
      } catch (cause) {
        // The body was already consumed or the connection is gone. Nothing to
        // do and nothing to report; the caller is about to try another shape.
      }
    }

    /* -------------------------------------------------------------- *
     * key derivation
     * -------------------------------------------------------------- */

    /**
     * Derive the per-user AES-GCM key.
     *
     * *** THE AMBIGUITY, STATED PLAINLY ***
     *
     * Two independent lineages disagree about the seed:
     *   - `SHA-256(glt)`: the `glt` field from the rights response. Works for
     *     anonymous/guest playback with no bearer token at all, which is why it
     *     is the only option in guest mode.
     *   - `SHA-256(bearerToken)`: the Studio bearer token. Requires a token, so
     *     it cannot serve guests.
     *
     * They are mutually exclusive for a given account and neither is
     * confirmed. So rather than guess and hard-fail, `attempts` is returned in
     * preference order: use `result` first, and if unwrapping throws
     * `unwrap-auth-failed`, retry with the next entry. No second network round
     * trip is needed, because `attempts` is built entirely from data already in
     * hand.
     *
     * @param {{glt?: string, key?: string, iv?: string}} rights
     * @param {object} [opts]
     * @param {string} [opts.bearerToken]
     * @returns {Promise<{key: CryptoKey, source: string, attempts: Array<{key: CryptoKey, source: string}>}>}
     *   `source` is `'bearer'` or `'glt'`. `attempts[0]` always equals
     *   `{key, source}`.
     */
    async resolveUserKey(rights, opts) {
      var crypto = this._crypto(rights && rights.clipId);
      var o = opts || {};
      var glt = rights && rights.glt ? String(rights.glt) : '';
      var bearer = o.bearerToken ? String(o.bearerToken) : '';

      var seeds = [];
      if (bearer) seeds.push({ seed: bearer, source: 'bearer' });
      if (glt) seeds.push({ seed: glt, source: 'glt' });
      // Guest mode with no token at all: the reference still derives a key from
      // the empty-string digest, and that is the seed that makes anonymous
      // playback work.
      if (!seeds.length) seeds.push({ seed: '', source: 'glt' });

      var attempts = [];
      for (var i = 0; i < seeds.length; i++) {
        var digest = await crypto.sha256(seeds[i].seed);
        attempts.push({
          key: await crypto.importAesGcmKey(digest, rights && rights.clipId),
          source: seeds[i].source
        });
      }
      this._log('debug', 'user key candidates derived', {
        count: attempts.length,
        sources: attempts.map(function (a) { return a.source; }),
        // Deliberately no seed, no digest, no key.
      });
      return { key: attempts[0].key, source: attempts[0].source, attempts: attempts };
    }

    /**
     * Unwrap the content key and IV, consulting the in-memory LRU first.
     *
     * Cache key is `clipId + ':' + rightsKeyFingerprint`, TTL 3600 s, capacity
     * 512. Note the cache saves the two AES-GCM unwraps, NOT the rights HTTP
     * call: the fingerprint is derived from the rights response, so the response
     * has to be fetched before the key is known. Never persisted — see the
     * security note in the file header.
     *
     * @param {string} clipId
     * @param {object} rights Normalized rights payload.
     * @param {CryptoKey} userKey
     * @param {string} aad
     * @returns {Promise<{contentKey: CryptoKey, contentIv: Uint8Array, cached: boolean}>}
     */
    async _unwrapWithCache(clipId, rights, userKey, aad) {
      var crypto = this._crypto(clipId);
      var rawKey = crypto.toBytes(rights.key);
      var fingerprint = await crypto.fingerprint(rawKey);
      var cacheKey = clipId + ':' + fingerprint;

      var hit = this._keyCache.get(cacheKey);
      if (hit) return { contentKey: hit.contentKey, contentIv: hit.contentIv, cached: true };

      // AAD is TEXT (`rights.aad || clipId`), never base64. Using the key
      // decoder here would silently corrupt it.
      var aadBytes = crypto.utf8Bytes(aad);
      var rawIv = crypto.toBytes(rights.iv);

      var contentKeyBytes;
      var contentIvBytes;
      try {
        contentKeyBytes = await crypto.unwrapEnvelope(rawKey, userKey, aadBytes, clipId);
        contentIvBytes = await crypto.unwrapEnvelope(rawIv, userKey, aadBytes, clipId);
      } catch (cause) {
        this._stats.decrypt.unwrapFailures++;
        throw cause;
      }

      var contentKey = await crypto.importAesCtrKey(contentKeyBytes, clipId);
      this._keyCache.set(cacheKey, { contentKey: contentKey, contentIv: contentIvBytes });
      return { contentKey: contentKey, contentIv: contentIvBytes, cached: false };
    }

    /* -------------------------------------------------------------- *
     * size probe + media fetch
     * -------------------------------------------------------------- */

    /**
     * Discover the media size with `Range: bytes=0-0` and parse `Content-Range`.
     *
     * CloudFront does not allow HEAD, so a one-byte GET is the only way to learn
     * the length before committing to a download.
     *
     * Guard: some CDNs answer a Range request with the WHOLE object and a 200.
     * That must never defeat the memory cap, so the body is cancelled
     * immediately, `rangeIgnored` is recorded, and the total is taken from
     * `Content-Length` only if it is under the cap. A `Content-Range` of
     * `bytes 0-0/*` (unknown total) yields `null`, which the caller treats as
     * "unknown", never as "unbounded".
     *
     * @param {string} url
     * @param {object} opts
     * @param {AbortSignal} [opts.signal]
     * @param {number} [opts.maxBytes]
     * @param {string} [opts.clipId]
     * @returns {Promise<{total: (number|null), fromContentRange: boolean}>}
     */
    async probeMediaSize(url, opts) {
      var self = this;
      var o = opts || {};
      var maxBytes = typeof o.maxBytes === 'number' ? o.maxBytes : this.maxBytes;
      this._stats.media.probes++;

      var response = await this._fetchWithTimeout(
        url,
        { method: 'GET', headers: { Range: 'bytes=0-0' }, credentials: 'omit' },
        {
          signal: o.signal,
          timeoutMs: this.mediaTimeoutMs,
          stage: 'media',
          clipId: o.clipId
        }
      );
      if (!response.ok && response.status !== 206) {
        await SunoDRM._discardBody(response);
        throw this._err('Media size probe failed with HTTP ' + response.status + '.', {
          stage: 'media', clipId: o.clipId, status: response.status, reason: 'probe-http-error'
        });
      }

      var total = null;
      var fromContentRange = false;
      var contentRange = response.headers && response.headers.get
        ? response.headers.get('content-range') : null;
      if (contentRange) {
        // `bytes 0-0/1234567` -> 1234567 ; `bytes 0-0/*` -> unknown.
        var slash = contentRange.lastIndexOf('/');
        if (slash !== -1) {
          var tail = contentRange.slice(slash + 1).trim();
          if (/^\d+$/.test(tail)) {
            total = parseInt(tail, 10);
            fromContentRange = true;
          }
        }
      }
      if (total == null) {
        var contentLength = response.headers && response.headers.get
          ? response.headers.get('content-length') : null;
        if (contentLength && /^\d+$/.test(contentLength.trim())) {
          var len = parseInt(contentLength.trim(), 10);
          // A 200 (not 206) to a Range request means the CDN sent the whole
          // object. Only trust Content-Length as the total if it is plausible
          // and within the cap; otherwise report unknown and let the streaming
          // reader enforce the cap.
          if (response.status === 200) this._stats.media.rangeIgnored++;
          if (len <= maxBytes) {
            total = len;
            fromContentRange = false;
          }
        }
      }
      // Release the probe body: it is one byte in the good case and the entire
      // object in the bad case.
      await SunoDRM._discardBody(response);

      if (total == null) this._stats.media.unknownSize++;
      if (total != null && total > maxBytes) {
        this._stats.media.maxBytesRejected++;
        throw this._err(
          'Media is ' + total + ' bytes, over the ' + maxBytes + '-byte cap.',
          { stage: 'media', clipId: o.clipId, status: response.status, reason: 'max-bytes-exceeded' }
        );
      }
      this._log('debug', 'probe done', {
        clipId: o.clipId, total: total, fromContentRange: fromContentRange, status: response.status
      });
      return { total: total, fromContentRange: fromContentRange };
    }

    /**
     * Fetch the media body, streaming it into a single right-sized buffer when
     * the total is known, and enforcing the memory cap either way.
     *
     * Allocating the destination up front and streaming into it avoids holding
     * the chunk list AND the joined copy at once, which would double peak
     * memory on exactly the long clips this module exists to survive.
     *
     * @param {string} url
     * @param {object} opts
     * @param {AbortSignal} [opts.signal]
     * @param {number} [opts.maxBytes]
     * @param {string} [opts.clipId]
     * @param {(p: {loaded: number, total: (number|null)}) => void} [opts.onProgress]
     * @returns {Promise<Uint8Array>}
     */
    async _fetchMedia(url, opts) {
      var self = this;
      var o = opts || {};
      var maxBytes = typeof o.maxBytes === 'number' ? o.maxBytes : this.maxBytes;
      this._stats.media.fetches++;

      var probe = opts.total != null
        ? { total: opts.total }
        : await this.probeMediaSize(url, { signal: o.signal, maxBytes: maxBytes, clipId: o.clipId });
      var total = probe.total;

      var response = await this._fetchWithTimeout(
        url,
        { method: 'GET', credentials: 'omit' },
        { signal: o.signal, timeoutMs: this.mediaTimeoutMs, stage: 'media', clipId: o.clipId }
      );
      if (!response.ok) {
        throw this._err('Media fetch failed with HTTP ' + response.status + '.', {
          stage: 'media', clipId: o.clipId, status: response.status, reason: 'media-http-error'
        });
      }

      var buffer = null;
      var view = null;
      var chunks = null;
      var loaded = 0;
      var declared = total != null
        ? total
        : parseInt(
          (response.headers && response.headers.get && response.headers.get('content-length')) || '0', 10);
      if (declared > 0 && declared <= maxBytes) {
        buffer = new ArrayBuffer(declared);
        view = new Uint8Array(buffer);
      } else {
        chunks = [];
      }

      var emit = function (n) {
        self._stats.media.bytesFetched += n;
        if (typeof o.onProgress === 'function') {
          o.onProgress({ loaded: loaded, total: total, clipId: o.clipId });
        }
      };

      if (response.body && typeof response.body.getReader === 'function') {
        var reader = response.body.getReader();
        try {
          for (;;) {
            if (o.signal && o.signal.aborted) {
              await reader.cancel('aborted');
              throw self._err('Media download aborted.', {
                stage: 'media', clipId: o.clipId, reason: 'aborted'
              });
            }
            var step = await reader.read();
            if (step.done) break;
            var piece = step.value;
            if (!piece || !piece.byteLength) continue;
            var offset = loaded;
            loaded += piece.byteLength;
            if (loaded > maxBytes) {
              await reader.cancel('max bytes exceeded');
              self._stats.media.maxBytesRejected++;
              throw self._err(
                'Media exceeded the ' + maxBytes + '-byte cap at ' + loaded + ' bytes.',
                { stage: 'media', clipId: o.clipId, reason: 'max-bytes-exceeded' }
              );
            }
            // A server that sends more than it declared in Content-Length would
            // otherwise turn into a raw RangeError from TypedArray.set(). Fail
            // as a typed error instead, so nothing opaque escapes this module.
            if (view && loaded > view.length) {
              await reader.cancel('body longer than declared');
              throw self._err(
                'Media body (' + loaded + ' bytes so far) exceeded the declared length (' +
                view.length + '); Content-Length was wrong.',
                { stage: 'media', clipId: o.clipId, reason: 'length-mismatch' }
              );
            }
            if (view) view.set(piece, offset);
            else chunks.push(piece);
            emit(piece.byteLength);
          }
        } finally {
          // Release the reader on every exit path, including the throws above.
          if (typeof reader.releaseLock === 'function') {
            try {
              reader.releaseLock();
            } catch (cause) {
              // Already released by cancel(); nothing further to release.
            }
          }
        }
      } else {
        var ab = await response.arrayBuffer();
        loaded = ab.byteLength;
        if (loaded > maxBytes) {
          self._stats.media.maxBytesRejected++;
          throw self._err('Media exceeded the ' + maxBytes + '-byte byte cap.', {
            stage: 'media', clipId: o.clipId, reason: 'max-bytes-exceeded'
          });
        }
        buffer = ab;
        emit(loaded);
      }

      var bytes;
      if (view) {
        // Trim any slack if Content-Length over-declared.
        bytes = loaded === buffer.byteLength
          ? new Uint8Array(buffer)
          : new Uint8Array(buffer, 0, loaded);
      } else if (chunks) {
        bytes = new Uint8Array(loaded);
        var at = 0;
        for (var i = 0; i < chunks.length; i++) {
          bytes.set(chunks[i], at);
          at += chunks[i].byteLength;
        }
      } else {
        bytes = new Uint8Array(buffer);
      }

      this._log('debug', 'media fetched', {
        clipId: o.clipId, bytesFetched: loaded, total: total
      });
      return bytes;
    }

    /* -------------------------------------------------------------- *
     * the pipeline
     * -------------------------------------------------------------- */

    /**
     * Fetch, decrypt, and verify one clip. The whole pipeline.
     *
     * Stages: resolve URL → (skip rights if the asset is unencrypted) → rights
     * → user key → unwrap → probe size → stream media → chunked AES-CTR →
     * verify container.
     *
     * @param {string} clipId
     * @param {object} [opts]
     * @param {string} [opts.mediaUrl]  Skip URL selection.
     * @param {object} [opts.clip]  The clip record, for `pickMediaUrl`.
     * @param {boolean} [opts.preferUnencrypted=false]  Prefer a `media_urls`
     *   entry with no `encoding` field; such an asset needs no decryption.
     * @param {string} [opts.bearerToken]
     * @param {AbortSignal} [opts.signal]
     * @param {number} [opts.maxBytes]  Memory cap for this clip.
     * @param {number} [opts.chunkSize]
     * @param {number} [opts.counterLength=128]  Pass 64 to retry with the
     *   narrower counter the reference falls back to.
     * @param {boolean} [opts.allowUnknownContainer=false]  Return
     *   `container: 'unknown'` instead of throwing when the sniff fails.
     * @param {boolean} [opts.skipRights=false]  Reuse a caller-supplied
     *   `opts.rights` without spending an HTTP round trip.
     * @param {object} [opts.rights]  Pre-fetched normalized rights payload.
     * @param {(p: {loaded: number, total: (number|null), clipId: string}) => void} [opts.onProgress]
     * @returns {Promise<{bytes: ArrayBuffer, container: string, bytesFetched: number,
     *   chunked: boolean, source: string, encrypted: boolean, mediaUrl: string,
     *   cached: boolean, bodyShape: (string|undefined)}>}
     *   `source` is `'bearer'`, `'glt'`, or `'none'` (asset was already
     *   unencrypted, so no key was derived).
     * @throws {SunoCryptoError} stage `rights`, `media`, `unwrap`, `decrypt`, or
     *   `verify`.
     */
    async decryptClipBuffer(clipId, opts) {
      var crypto = this._crypto(clipId);
      var o = opts || {};
      var maxBytes = typeof o.maxBytes === 'number' ? o.maxBytes : this.maxBytes;

      var picked = o.mediaUrl
        ? { url: o.mediaUrl, contentType: undefined, encrypted: true }
        : SunoDRM.pickMediaUrl(o.clip, { preferUnencrypted: o.preferUnencrypted });
      // `picked` being null is NOT fatal here: with no clip supplied we fall
      // back to the media URL that the rights payload itself carries. That is
      // what makes `decryptMany(clipIds, opts)` work with one shared opts
      // object, since each clip's own record cannot be threaded through it.
      if (!picked && o.clip) {
        throw this._err('No usable media URL for clip (media_urls missing or decoy-only).', {
          stage: 'media', clipId: clipId, reason: 'no-media-url'
        });
      }

      // Unencrypted progressive asset: no rights, no key, no AES. `picked` may be
      // null here (no clip supplied) — that is the "let rights supply the URL"
      // path, not the unencrypted one.
      if (picked && !picked.encrypted && o.mediaUrl !== picked.url) {
        var plainBytes = await this._fetchMedia(picked.url, {
          signal: o.signal, maxBytes: maxBytes, clipId: clipId, onProgress: o.onProgress
        });
        var plainContainer = crypto.verifyContainer(plainBytes, {
          clipId: clipId, allowUnknown: o.allowUnknownContainer
        });
        this._stats.decrypt.clips++;
        this._stats.decrypt.unencrypted++;
        this._stats.keySource.none++;
        this._log('debug', 'clip done (unencrypted asset)', {
          clipId: clipId, container: plainContainer, bytes: plainBytes.length
        });
        return {
          bytes: SunoDRM._toArrayBuffer(plainBytes),
          container: plainContainer,
          bytesFetched: plainBytes.length,
          chunked: false,
          source: 'none',
          encrypted: false,
          mediaUrl: picked.url,
          cached: false,
          bodyShape: undefined
        };
      }

      var rights = o.rights || await this.fetchRights(clipId, {
        bearerToken: o.bearerToken, signal: o.signal, timeoutMs: o.timeoutMs
      });
      var mediaUrl = (picked && picked.url) || rights.mediaUrl;
      if (!mediaUrl) {
        throw this._err('Rights payload contained no media URL and no clip was supplied.', {
          stage: 'media', clipId: clipId, reason: 'no-media-url'
        });
      }

      var userKeyResult = await this.resolveUserKey(rights, { bearerToken: o.bearerToken });
      var aad = rights.aad || clipId;

      var unwrapped = null;
      var lastError = null;
      // Walk the seed candidates in preference order. A wrong seed shows up as
      // an AES-GCM auth failure, which is cheap to detect and cheap to retry.
      for (var i = 0; i < userKeyResult.attempts.length; i++) {
        try {
          unwrapped = await this._unwrapWithCache(clipId, rights, userKeyResult.attempts[i].key, aad);
          userKeyResult.source = userKeyResult.attempts[i].source;
          break;
        } catch (cause) {
          lastError = cause;
          this._log('warn', 'unwrap failed for one key seed; trying next', {
            clipId: clipId, source: userKeyResult.attempts[i].source,
            reason: cause && cause.reason
          });
          if (i < userKeyResult.attempts.length - 1) this._stats.keySource.fallbackTried++;
        }
      }
      if (!unwrapped) throw lastError;

      this._stats.keySource[userKeyResult.source]++;

      var mediaBytes = await this._fetchMedia(mediaUrl, {
        signal: o.signal, maxBytes: maxBytes, clipId: clipId, onProgress: o.onProgress
      });

      // `unwrapEnvelope` already returns a Uint8Array (or hands back the bare
      // 16/32-byte envelope unchanged), so it feeds straight into the CTR pass.
      var plain;
      try {
        plain = await crypto.decryptAesCtrChunked(mediaBytes, unwrapped.contentKey, unwrapped.contentIv, {
          chunkSize: typeof o.chunkSize === 'number' ? o.chunkSize : this.chunkSize,
          counterLength: typeof o.counterLength === 'number' ? o.counterLength : 128,
          signal: o.signal,
          clipId: clipId,
          onProgress: o.onProgress
            ? function (p) { o.onProgress({ loaded: p.loaded, total: p.total, clipId: clipId }); }
            : undefined
        });
      } catch (cause) {
        this._stats.decrypt.decryptFailures++;
        throw cause;
      }

      var container;
      try {
        container = crypto.verifyContainer(plain, {
          clipId: clipId, allowUnknown: o.allowUnknownContainer
        });
      } catch (cause) {
        this._stats.decrypt.verificationFailures++;
        throw cause;
      }

      var chunked = plain.length > (typeof o.chunkSize === 'number' ? o.chunkSize : this.chunkSize);
      this._stats.decrypt.clips++;
      if (chunked) this._stats.decrypt.chunked++;
      this._log('debug', 'clip done', {
        clipId: clipId, container: container, bytesFetched: mediaBytes.length,
        chunked: chunked, source: userKeyResult.source, cached: unwrapped.cached,
        bodyShape: rights.bodyShape
      });

      return {
        bytes: SunoDRM._toArrayBuffer(plain),
        container: container,
        bytesFetched: mediaBytes.length,
        chunked: chunked,
        source: userKeyResult.source,
        encrypted: true,
        mediaUrl: mediaUrl,
        cached: unwrapped.cached,
        bodyShape: rights.bodyShape
      };
    }

    /**
     * Detach a `Uint8Array` from its buffer so the returned `ArrayBuffer`
     * carries exactly the decrypted bytes.
     * @param {Uint8Array} bytes
     * @returns {ArrayBuffer}
     */
    static _toArrayBuffer(bytes) {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    /**
     * Decrypt a clip and wrap it in a `Blob`.
     *
     * The MIME is `audio/x-m4a` and MUST stay that way — see
     * {@link BLOB_TYPE_M4A}. A `Blob` declared `audio/mp4` is written to disk by
     * Chromium with an `.m4b` extension, which plays but which no desktop
     * player will open. Only a container actually sniffed as MP3 gets
     * `audio/mpeg`; `opts.mimeType` overrides both.
     *
     * @param {string} clipId
     * @param {object} [opts] Same options as {@link decryptClipBuffer}, plus:
     * @param {string} [opts.mimeType]  Force a MIME type.
     * @returns {Promise<Blob>}
     */
    async decryptClipToBlob(clipId, opts) {
      var result = await this.decryptClipBuffer(clipId, opts);
      var type = (opts && opts.mimeType) ||
        (result.container === 'mp3' ? BLOB_TYPE_MP3 : BLOB_TYPE_M4A);
      // `audio/x-m4a`, not `audio/mp4` — see the comment above.
      return new Blob([result.bytes], { type: type });
    }

    /* -------------------------------------------------------------- *
     * fan-out
     * -------------------------------------------------------------- */

    /**
     * Decrypt many clips with a concurrency cap and per-item error isolation.
     *
     * Yields one result per clip in COMPLETION order:
     *   `{ ok: true,  clipId, result }` or
     *   `{ ok: false, clipId, error, reason, stage }`
     *
     * One failure never aborts the run — that is the whole point. A 400-clip
     * batch where 3 clips are 404 must still deliver 397 files.
     *
     * The caller may supply throttling two ways:
     *   - `opts.rateLimiter`: any object with `await limiter.acquire()` (this
     *     is the shape of `RateLimiter` in lib/api.js);
     *   - `opts.delay` / `opts.delayMs`: a `delay(clipId, index)` hook, or a
     *     fixed pause between items.
     *
     * Breaking out of the `for await` stops the remaining work.
     *
     * @param {Iterable<string>} clipIds
     * @param {object} [opts] Same as {@link decryptClipBuffer}, plus:
     * @param {number} [opts.concurrency=3]
     * @param {{acquire: Function}} [opts.rateLimiter]
     * @param {Function} [opts.delay]
     * @param {number} [opts.delayMs]
     * @param {AbortSignal} [opts.signal]
     * @returns {AsyncGenerator<object>}
     */
    async *decryptMany(clipIds, opts) {
      var self = this;
      var o = opts || {};
      var ids = [];
      if (Array.isArray(clipIds)) ids = clipIds.slice();
      else if (clipIds && typeof clipIds[Symbol.iterator] === 'function') {
        for (var v of clipIds) ids.push(v);
      }
      if (!ids.length) return;

      var concurrency = Math.max(1,
        typeof o.concurrency === 'number' ? o.concurrency : this.concurrency);
      var limiter = (o.rateLimiter && typeof o.rateLimiter.acquire === 'function')
        ? o.rateLimiter : null;
      var delayHook = typeof o.delay === 'function' ? o.delay : null;
      var delayMs = typeof o.delayMs === 'number' ? o.delayMs : 0;

      var buffer = [];
      var notify = null;
      var nextIndex = 0;
      var stopped = false;

      /**
       * @param {*} value
       */
      function publish(value) {
        buffer.push(value);
        if (notify) {
          var wake = notify;
          notify = null;
          wake();
        }
      }

      /**
       * Wait for the next published item. Loops rather than resolving directly
       * with the published value, so a value can never be handed to two
       * waiters or lost between the `push` and the `resolve`.
       * @returns {Promise<*>}
       */
      async function take() {
        while (!buffer.length) {
          await new Promise(function (resolve) { notify = resolve; });
        }
        return buffer.shift();
      }

      /**
       * One worker: pull the next id, throttle, decrypt, publish. Never throws.
       * @returns {Promise<void>}
       */
      async function worker() {
        for (;;) {
          if (stopped) return;
          var index = nextIndex++;
          if (index >= ids.length) return;
          var clipId = ids[index];
          try {
            if (o.signal && o.signal.aborted) {
              throw self._err('Run aborted.', { stage: 'rights', clipId: clipId, reason: 'aborted' });
            }
            if (limiter) {
              await limiter.acquire();
            } else if (delayHook) {
              await delayHook(clipId, index);
            } else if (delayMs > 0) {
              await sleep(delayMs, o.signal);
            }
            var result = await self.decryptClipBuffer(clipId, o);
            publish({ ok: true, clipId: clipId, index: index, result: result });
          } catch (error) {
            // Error isolation: report, never rethrow, never stop the run.
            self._log('warn', 'clip failed', {
              clipId: clipId,
              stage: error && error.stage,
              reason: error && error.reason,
              status: error && error.status
            });
            publish({
              ok: false,
              clipId: clipId,
              index: index,
              error: error,
              stage: error && error.stage,
              reason: error && error.reason
            });
          }
        }
      }

      var workers = [];
      for (var w = 0; w < Math.min(concurrency, ids.length); w++) {
        workers.push(worker());
      }
      // Swallow anything a worker could still reject with, so the generator's
      // consumer never sees an unhandled rejection.
      workers.forEach(function (p) {
        p.catch(function (cause) {
          self._log('error', 'worker stopped unexpectedly', {
            reason: cause && cause.reason
          });
        });
      });

      try {
        for (var done = 0; done < ids.length; done++) {
          yield await take();
        }
      } finally {
        stopped = true;
        notify = null;
      }
    }

    /* -------------------------------------------------------------- *
     * introspection
     * -------------------------------------------------------------- */

    /**
     * Counters for the whole instance. Contains no key material: the key cache
     * reports sizes and hit counts only, never keys, digests, or fingerprints.
     * @returns {{rights: object, media: object, decrypt: object, keySource: object, cache: object}}
     */
    stats() {
      var s = this._stats;
      var shapesTried = {};
      Object.keys(s.rights.shapesTried).forEach(function (k) { shapesTried[k] = s.rights.shapesTried[k]; });
      var attempts = {};
      Object.keys(s.rights.attemptsByShape).forEach(function (k) {
        attempts[k] = s.rights.attemptsByShape[k];
      });
      return {
        rights: {
          requests: s.rights.requests,
          ok: s.rights.ok,
          failed: s.rights.failed,
          lastStatus: s.rights.lastStatus,
          bodyShape: s.rights.bodyShape,
          shapesTried: shapesTried,
          attemptsByShape: attempts
        },
        media: {
          fetches: s.media.fetches,
          probes: s.media.probes,
          rangeIgnored: s.media.rangeIgnored,
          bytesFetched: s.media.bytesFetched,
          maxBytesRejected: s.media.maxBytesRejected,
          unknownSize: s.media.unknownSize
        },
        decrypt: {
          clips: s.decrypt.clips,
          chunked: s.decrypt.chunked,
          unencrypted: s.decrypt.unencrypted,
          unwrapFailures: s.decrypt.unwrapFailures,
          decryptFailures: s.decrypt.decryptFailures,
          verificationFailures: s.decrypt.verificationFailures
        },
        keySource: {
          bearer: s.keySource.bearer,
          glt: s.keySource.glt,
          none: s.keySource.none,
          fallbackTried: s.keySource.fallbackTried
        },
        cache: {
          size: this._keyCache.size,
          capacity: this._keyCache.capacity,
          ttlSeconds: Math.round(this._keyCache.ttlMs / 1000),
          hits: this._keyCache.hits,
          misses: this._keyCache.misses,
          evictions: this._keyCache.evictions,
          expired: this._keyCache.expired
        }
      };
    }

    /**
     * Drop every cached content key. Call on sign-out, account switch, and any
     * rights/decrypt auth failure — a stale key from another account is worse
     * than no cache at all.
     * @returns {number} Entries dropped.
     */
    clearKeyCache() {
      var dropped = this._keyCache.size;
      this._keyCache.clear();
      return dropped;
    }

    /**
     * Redact an object for logging. Delegated to `lib/crypto.js`; every byte
     * array becomes `[bytes:N]` and every sensitive-named field
     * `[redacted]`.
     * @param {*} value
     * @returns {*}
     */
    redact(value) {
      return this._crypto().redact(value);
    }
  }

  /* ================================================================== *
   * statics that are values
   * ================================================================== */

  /** The prioritized rights request-body list, frozen. @type {ReadonlyArray} */
  SunoDRM.RIGHTS_BODY_SHAPES = RIGHTS_BODY_SHAPES;
  /** Blob MIME for decoded M4A. `audio/x-m4a`, NOT `audio/mp4`. @type {string} */
  SunoDRM.BLOB_TYPE_M4A = BLOB_TYPE_M4A;
  /** Blob MIME for MP3. @type {string} */
  SunoDRM.BLOB_TYPE_MP3 = BLOB_TYPE_MP3;
  /** The decoy-URL matcher. @type {RegExp} */
  SunoDRM.FORBIDDEN_RE = FORBIDDEN_RE;
  /** Default rights endpoint. @type {string} */
  SunoDRM.DEFAULT_RIGHTS_ENDPOINT = DEFAULT_RIGHTS_ENDPOINT;
  /** Default in-memory key cache TTL, seconds. @type {number} */
  SunoDRM.KEY_CACHE_TTL_SECONDS = KEY_CACHE_TTL_MS / 1000;
  /** Default key cache capacity. @type {number} */
  SunoDRM.KEY_CACHE_CAPACITY = KEY_CACHE_CAPACITY;

  /* ================================================================== *
   * exposure
   * ================================================================== */

  /**
   * `window.SunoDRM` is an INSTANCE whose statics are mirrored onto it, so both
   * `SunoDRM.pickMediaUrl(...)` (static, matching the class) and
   * instance-style calls resolve. Every own static is mirrored — functions AND
   * value statics like `BLOB_TYPE_M4A`, which a function-only filter would drop.
   */
  var MIRRORED = Object.getOwnPropertyNames(SunoDRM).filter(function (name) {
    return name !== 'length' && name !== 'name' && name !== 'prototype';
  });

  /** @type {SunoDRM} */
  var instance = new SunoDRM();
  MIRRORED.forEach(function (name) {
    try {
      instance[name] = SunoDRM[name];
    } catch (err) {
      // Non-writable static; the class copy remains authoritative.
      void err;
    }
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SunoDRM: instance, SunoDRMClass: SunoDRM };
  }

  if (typeof window !== 'undefined' && window) {
    window.SunoDRM = instance;
    window.SunoDRMClass = SunoDRM;
  }
  // An MV3 service worker has no `window`; mirror onto the bare global there.
  if (typeof self !== 'undefined' && self && typeof window === 'undefined' &&
    typeof globalThis !== 'undefined') {
    globalThis.SunoDRM = instance;
    globalThis.SunoDRMClass = SunoDRM;
  }
})();