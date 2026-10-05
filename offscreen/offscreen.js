/**
 * Suno Master Utility - Offscreen Document (offscreen/offscreen.js)
 * =============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An MV3 service worker has no Web Audio API: no `AudioContext`, no
 * `OfflineAudioContext`, no `AudioBuffer`, no `decodeAudioData`. But Suno
 * streams `m4a-opus`, and to render a WAV, detect BPM or transcode we must
 * decode it to PCM first. `lib/audio.js` is deliberately split into a
 * SW-safe half (bytes + math) and a context-required half (`decodeToPcm`),
 * and its header names this document as the seam.
 *
 * So: the service worker creates this document exactly once
 *
 *     chrome.offscreen.createDocument({
 *       url: 'offscreen/offscreen.html',
 *       reasons: ['AUDIO_PLAYBACK']
 *     })
 *
 * (guarded by `chrome.offscreen.hasDocument()` - recreating throws), and from
 * then on every Web-Audio-needing operation is routed here.
 *
 * -----------------------------------------------------------------------------
 * PROTOCOL
 * -----------------------------------------------------------------------------
 * The worker sends   { target: 'offscreen', type, id, ...payload }
 * and its own onMessage returns false for anything carrying that marker, so
 * this listener is the only one that answers. This document answers on BOTH
 * channels so the worker may use whichever it prefers:
 *
 *   1. the direct `sendResponse` channel. We `return true` from onMessage and
 *      call sendResponse exactly once, which settles the worker's promise.
 *   2. a `chrome.runtime.sendMessage` broadcast of the same envelope, tagged
 *      `from: 'offscreen'` so it can never be mistaken for a request (and so
 *      this document ignores its own echo if a runtime ever delivers one).
 *
 * Byte payloads travel ONLY on channel 1. Chrome's runtime messaging copies
 * (it has no transfer list), so duplicating a decoded 3-minute stereo buffer
 * into a second message would double peak memory for nothing; the broadcast
 * carries the identical envelope with the bytes replaced by a `{ byteLength }`
 * descriptor and `payloadTruncated: true`. Small replies (ping, blob URL,
 * analysis) go out complete on both channels. Both channels are ALWAYS
 * written - a worker waiting on either one is never left hanging.
 *
 *   success : { from:'offscreen', type:'<type>:result', id, ok:true, ... }
 *   failure : { from:'offscreen', type:'<type>:result', id, ok:false,
 *               code:'...', detail:'...' }
 *
 * Every failure - malformed input, a dead decoder, a timeout, the document
 * being torn down mid-request - comes back as a typed `ok:false` reply. This
 * file never rejects a request and never throws out of a listener.
 *
 * -----------------------------------------------------------------------------
 * MESSAGE TYPES
 * -----------------------------------------------------------------------------
 *   sunoPing            -> { ok, ready, protocol, audio, offlineAudioContext,
 *                            encoder, stats, blobs, queue }
 *   sunoAudioDecode     -> { ok, pcm:{ channels:Float32Array[], sampleRate,
 *                             durationSec }, warnings, contextsClosed }
 *   sunoAnalyze         -> { ok, analysis:{ peakDb, rmsDb, durationSec,
 *                             sampleRate, channels, bpm, bpmConfidence },
 *                             warnings }
 *   sunoRenderWav       -> { ok, bytes, sampleRate, bitDepth, bpm, bpmSource,
 *                             warnings }
 *   sunoBlobUrl         -> { ok, url, mime, byteLength, live }
 *   sunoBlobRevoke      -> { ok, revoked, live }
 *   sunoBlobRevokeAll   -> { ok, revoked, live }
 *   sunoTranscode       -> { ok, bytes, mime, format } | { ok:false,
 *                             code:'ENCODER_UNAVAILABLE' }
 *
 * -----------------------------------------------------------------------------
 * CONCURRENCY
 * -----------------------------------------------------------------------------
 * This document is one thread and `decodeAudioData` on a 3-minute track is
 * CPU-bound, so at most MAX_CONCURRENT (2) heavy jobs run at once; the rest
 * wait in a FIFO queue. Light jobs (ping, blob URLs, revokes) bypass the
 * queue so a saturated decoder can never stall a liveness probe. Every request
 * carries a deadline (default 120s, measured from receipt, so queue time
 * counts): the reply is a typed TIMEOUT and the in-flight decode is ABORTED
 * via the AbortSignal we hand lib/audio.js, which is what actually stops the
 * work and lets the library close its context.
 *
 * -----------------------------------------------------------------------------
 * TAG CHUNK CONVENTION (read this before touching sunoRenderWav)
 * -----------------------------------------------------------------------------
 * lib/tagger.js's `buildRiffInfoChunk()` and `buildId3Chunk()` each return a
 * COMPLETE RIFF chunk: 4-byte id, little-endian u32 size, payload, plus the
 * word-alignment pad byte, with the pad EXCLUDED from the size field. So both
 * satisfy `8 + size + (size & 1) === byteLength`.
 *
 * lib/audio.js's `buildWav()` writes the id and the size ITSELF and expects a
 * BARE payload. Handing it a whole chunk nests `LIST( LIST( INFO... ) )` and a
 * conforming reader looking for `INFO` finds `LIST` and silently drops every
 * tag. lib/audio.js does own a self-verifying strip (`toChunkPayload`, see
 * lib/audio.js:1712 - it checks the first 4 bytes equal the expected id AND
 * that `8 + size + (size & 1) === byteLength`, then strips 8 bytes and the
 * pad), but that strip is only reachable via
 * `audioBufferToWavBlob` / `processAndCreateWav` -> `resolveChunks`. The
 * `renderToWav` path we are told to use does NOT go through it.
 *
 * RELIANCE: we replicate that exact predicate in `toBarePayload()` below and
 * add a warning line when we strip, so the resulting WAV is tagged and the
 * caller can see the convention was applied. A payload that is already bare
 * (id mismatch) is passed through untouched.
 *
 * -----------------------------------------------------------------------------
 * TRANSCODING AND MV3's REMOTE-CODE BAN
 * -----------------------------------------------------------------------------
 * MP3/OGG need an encoder. The "Unlimited Suno Downloads" userscript loads one
 * with `importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js')`
 * from a Blob worker. That cannot work here: MV3's default CSP is
 * `script-src 'self'`, remote code is forbidden outright, and the Web Store
 * policy bans it. This file therefore looks ONLY for a LOCALLY VENDORED
 * encoder and nothing else:
 *
 *     vendor/lame.all.js          -> globalThis.lamejs          (mp3)
 *     vendor/OggVorbisEncoder.js  -> globalThis.OggVorbisEncoder(ogg)
 *
 * BOTH ENCODERS ARE NOW VENDORED, at the exact bytes and SHA-256 recorded in
 * `vendor/README.md`:
 *
 *     vendor/lame.all.js          026bd888...a3b  lamejs@1.2.1       (LGPL-3.0)
 *     vendor/OggVorbisEncoder.js  5a9f749a...79b  higuma @7a87242    (MIT + Xiph BSD)
 *
 * The two libraries do NOT share an API. `encodeMp3()` below matches lamejs
 * (`encodeBuffer` returns an Int8Array, `flush()` returns one); `encodeOgg()`
 * documents at length why higuma's is the other way round. Both files are
 * classic scripts loaded by `loadVendoredScript()`, which is also what LGPL-3.0
 * §4 requires: the library stays a separate work, is not linked into this file,
 * and a user can replace or remove it without relinking anything.
 *
 * The encoder is loaded with a dynamically injected `<script src>` pointing at
 * a path relative to THIS document, which resolves inside the extension and is
 * therefore 'self'. `loadVendoredScript()` additionally asserts the resolved
 * URL's protocol is `chrome-extension:` and refuses anything else, so editing
 * that constant to an https URL cannot reintroduce remote code. This file
 * contains no `importScripts`, no `fetch`, and no remote URL of any kind; it
 * only ever handles bytes the service worker hands it.
 *
 * Note that `offscreen.html` declares `default-src 'none'; script-src 'self'`.
 * Both vendored files are served from the extension's own origin, so 'self'
 * covers them, and neither needs a fetch or a second file: `lame.all.js` is a
 * browserified bundle, and `OggVorbisEncoder.js` is an asm.js build with its
 * memory initialiser embedded (no `.mem`, no WebAssembly, so no
 * `wasm-unsafe-eval` relaxation is required either).
 *
 * -----------------------------------------------------------------------------
 * HYGIENE
 * -----------------------------------------------------------------------------
 * IIFE, no leaked globals, no inline script (offscreen.html loads this by
 * `src`), no `console.*` at all - diagnostics go to the status line in
 * offscreen.html so a human staring at the document in chrome://extensions can
 * see it is alive and what it has processed.
 */

(function () {
  'use strict';

  /* ===================================================================== *
   * Constants
   * ===================================================================== */

  var PROTOCOL = 'suno-offscreen/1';

  /** Heavy jobs (decode / analyze / render / transcode) allowed at once. */
  var MAX_CONCURRENT = 2;

  /** Per-request deadline, measured from receipt (queue time included). */
  var DEFAULT_TIMEOUT_MS = 120000;

  /** How often the orphan sweeper walks the registry. */
  var ORPHAN_SWEEP_MS = 15000;

  /** Hard cap on a vendored <script> load, so a stuck one cannot wedge a request. */
  var VENDOR_LOAD_MS = 5000;

  /** A request with no answer for this long is declared dead and reaped. */
  var ORPHAN_AGE_MS = 300000;

  /** Blob URLs kept alive at once; older ones are revoked on mint. */
  var BLOB_LRU_LIMIT = 8;

  /** Status-line log lines retained. */
  var LOG_LIMIT = 40;

  /** Locally vendored encoders, keyed by output format. Never a URL. */
  var VENDORED_ENCODERS = {
    mp3: { path: '../vendor/lame.all.js', global: 'lamejs' },
    ogg: { path: '../vendor/OggVorbisEncoder.js', global: 'OggVorbisEncoder' }
  };

  /* ===================================================================== *
   * State
   * ===================================================================== */

  var audio = (typeof globalThis !== 'undefined' && globalThis.SunoAudio) || null;

  /** id -> pending entry. Guards against two requests sharing an id. */
  var registry = new Map();

  /** FIFO of entries waiting for a slot. */
  var queue = [];

  /** Currently running heavy jobs. */
  var active = 0;

  /** Most-recently-used-last list of live blob URLs. */
  var blobLru = [];

  /** format -> true | null while a load is in flight | false on failure. */
  var encoderState = {};

  var stats = {
    received: 0,
    served: 0,
    failed: 0,
    rejected: 0,
    timedOut: 0,
    reaped: 0,
    castErrors: 0,
    encodeAttempts: 0,
    broadcastMisses: 0,
    decoded: 0,
    startedAt: now()
  };

  var shuttingDown = false;
  var sweepTimer = null;
  var stateEl = null;
  var detailEl = null;
  var logEl = null;

  /* ===================================================================== *
   * Tiny utilities (ES5-ish to match lib/audio.js; no console, ever)
   * ===================================================================== */

  function now() { return Date.now(); }

  function str(v) {
    if (v === null || v === undefined) return '';
    try { return String(v); } catch (e) { return '[unstringifiable]'; }
  }

  function msgOf(e) {
    if (!e) return 'unknown error';
    var m = e.message || e.reason || e.detail;
    return str(m) || str(e) || 'unknown error';
  }

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function isObj(v) { return !!v && typeof v === 'object'; }

  function isTypedArray(v) {
    return !!v && typeof v === 'object' && typeof v.length === 'number' &&
      typeof v.BYTES_PER_ELEMENT === 'number';
  }

  /** A typed failure. Every thrown error in this file is one of these. */
  function Fail(code, detail, info) {
    var err = new Error(detail);
    err.name = 'OffscreenError';
    err.code = str(code) || 'OFFSCREEN_ERROR';
    err.detail = str(detail);
    err.info = info === undefined ? null : info;
    err.typed = true;
    return err;
  }

  function fail(code, detail, info) { return Fail(code, detail, info); }

  function ok(payload) {
    var msg = { ok: true };
    if (isObj(payload)) {
      var keys = Object.keys(payload);
      for (var i = 0; i < keys.length; i++) msg[keys[i]] = payload[keys[i]];
    }
    return msg;
  }

  /**
 * Turn any rejection into the typed envelope, never re-throwing.
 *
 * Anything carrying a string `code` keeps it. That covers this file's `Fail`
 * AND lib/audio.js's `SunoAudioError`, whose documented codes (NO_AUDIO_CONTEXT,
 * DECODE_ERROR, INVALID_SOURCE, EMPTY_AUDIO, INVALID_SAMPLE_RATE,
 * INVALID_BIT_DEPTH, INVALID_FORMAT, ABORTED) are the contract the service
 * worker expects to branch on - collapsing them to UNEXPECTED_ERROR would throw
 * away exactly the information the caller needs.
 */
function typedFailure(e) {
    if (e && e.typed) {
      var out = { ok: false, code: e.code, detail: e.detail };
      if (e.info !== null && e.info !== undefined) out.info = e.info;
      return out;
    }
    if (e && typeof e.code === 'string' && e.code) {
      var typed = { ok: false, code: e.code, detail: str(e.message || e.detail) || 'failed' };
      if (isObj(e.detail)) typed.info = e.detail;
      return typed;
    }
    return { ok: false, code: 'UNEXPECTED_ERROR', detail: msgOf(e) };
  }

  /* ===================================================================== *
   * Status line (the only diagnostic channel; chrome://extensions shows it)
   * ===================================================================== */

  function bindDom() {
    try {
      stateEl = document.getElementById('os-state');
      detailEl = document.getElementById('os-detail');
      logEl = document.getElementById('os-log');
    } catch (e) {
      stats.castErrors++;
      stateEl = null;
      detailEl = null;
      logEl = null;
    }
  }

  function setStatus(state, cls, detail) {
    try {
      if (stateEl) {
        stateEl.textContent = state;
        stateEl.className = cls;
      }
      if (detailEl) detailEl.textContent = detail;
    } catch (e) {
      stats.castErrors++;
    }
  }

  function addLog(line, cls) {
    try {
      if (!logEl) return;
      var row = document.createElement('div');
      if (cls) row.className = cls;
      var ts = new Date();
      var stamp = (ts.getHours() < 10 ? '0' : '') + ts.getHours() + ':' +
        (ts.getMinutes() < 10 ? '0' : '') + ts.getMinutes() + ':' +
        (ts.getSeconds() < 10 ? '0' : '') + ts.getSeconds();
      row.textContent = stamp + '  ' + line;
      logEl.appendChild(row);
      while (logEl.childNodes.length > LOG_LIMIT) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) {
      stats.castErrors++;
    }
  }

  function encoderName() {
    var found = [];
    var formats = ['mp3', 'ogg'];
    for (var i = 0; i < formats.length; i++) {
      var spec = VENDORED_ENCODERS[formats[i]];
      if (globalThis[spec.global]) found.push(formats[i] + '=' + spec.global);
    }
    return found.length ? found.join(',') : 'none';
  }

  function renderStatus() {
    var uptime = Math.round((now() - stats.startedAt) / 1000);
    var detail = 'up ' + uptime + 's · recv ' + stats.received +
      ' · ok ' + stats.served + ' · err ' + stats.failed +
      ' · decoded ' + (stats.decoded || 0) +
      ' · jobs ' + active + '/' + MAX_CONCURRENT +
      ' · queued ' + queue.length +
      ' · blobs ' + blobLru.length + '/' + BLOB_LRU_LIMIT +
      ' · enc ' + encoderName() +
      (audio ? '' : ' · lib/audio.js MISSING');
    if (audio) setStatus('ALIVE', 'os-ok', detail);
    else setStatus('DEGRADED', 'os-bad', detail);
  }

  /* ===================================================================== *
   * Blob URL LRU (the worker has no URL.createObjectURL of its own)
   * ===================================================================== */

  function revokeUrl(url) {
    if (str(url).slice(0, 5) !== 'blob:') {
      stats.castErrors++;
      addLog('refusing to revoke a non-blob URL: ' + str(url).slice(0, 40), 'os-bad');
      return false;
    }
    try {
      URL.revokeObjectURL(url);
      return true;
    } catch (e) {
      stats.castErrors++;
      addLog('revokeObjectURL failed: ' + msgOf(e), 'os-bad');
      return false;
    }
  }

  function forgetUrl(url) {
    for (var i = 0; i < blobLru.length; i++) {
      if (blobLru[i] === url) {
        blobLru.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /** Mint a URL and evict (revoke) the oldest ones past the cap. */
  function trackBlobUrl(url) {
    forgetUrl(url);
    blobLru.push(url);
    var revoked = 0;
    while (blobLru.length > BLOB_LRU_LIMIT) {
      var evicted = blobLru.shift();
      if (revokeUrl(evicted)) revoked++;
    }
    if (revoked) addLog('blob LRU evicted + revoked ' + revoked);
    return revoked;
  }

  function revokeOne(url) {
    if (!str(url)) return false;
    forgetUrl(url);
    return revokeUrl(url);
  }

  function revokeAll() {
    var n = 0;
    while (blobLru.length) {
      if (revokeUrl(blobLru.shift())) n++;
    }
    return n;
  }

  /* ===================================================================== *
   * Byte coercion
   *
   * `chrome.runtime.sendMessage` cannot always carry an ArrayBuffer (older
   * Chrome builds serialize to a JSON-ish value and hand the worker a bare
   * `{}`), so every entry point also accepts base64 and an array of
   * transferable chunks. Workers are expected to prefer a base64 string on
   * any runtime they are unsure about.
   * ===================================================================== */

  function base64ToBytes(b64) {
    var text = str(b64).replace(/\s+/g, '');
    var comma = text.indexOf(',');
    if (text.slice(0, 5) === 'data:' && comma > 0) text = text.slice(comma + 1);
    if (!text) return new Uint8Array(0);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
      throw fail('INVALID_SOURCE', 'the audio/base64 string is not valid base64.');
    }
    // Chrome's atob() tolerates missing padding; do the same rather than
    // rejecting a payload the worker built with a stricter-looking encoder.
    while ((text.length % 4) !== 0) text += '=';
    var out = new Uint8Array((text.length / 4) * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0));
    var p = 0;
    for (var i = 0; i < text.length; i += 4) {
      var n = (b64Value(text.charCodeAt(i)) << 18) | (b64Value(text.charCodeAt(i + 1)) << 12) |
        ((text.charCodeAt(i + 2) === 61 ? 0 : b64Value(text.charCodeAt(i + 2))) << 6) |
        (text.charCodeAt(i + 3) === 61 ? 0 : b64Value(text.charCodeAt(i + 3)));
      if (p < out.length) out[p++] = (n >> 16) & 255;
      if (p < out.length) out[p++] = (n >> 8) & 255;
      if (p < out.length) out[p++] = n & 255;
    }
    return out;
  }

  function b64Value(code) {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    if (code === 43) return 62;
    if (code === 47) return 63;
    return 0;
  }

  function concatBytes(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], at);
      at += parts[i].length;
    }
    return out;
  }

  function viewOf(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === 'string') return base64ToBytes(value);
    return null;
  }

  /** Synchronous coercion. Throws a typed Fail on anything unusable. */
  function coerceBytesSync(input, label) {
    var bytes = viewOf(input);
    if (bytes) return bytes;

    if (Array.isArray(input)) {
      var parts = [];
      for (var i = 0; i < input.length; i++) {
        var part = viewOf(input[i]);
        if (part) parts.push(part);
      }
      return concatBytes(parts);
    }

    if (isObj(input)) {
      var keys = ['arrayBuffer', 'bytes', 'data', 'audio', 'buffer', 'base64'];
      for (var k = 0; k < keys.length; k++) {
        if (input[keys[k]] !== undefined && input[keys[k]] !== null) {
          return coerceBytesSync(input[keys[k]], label);
        }
      }
      var lists = ['buffers', 'chunks', 'parts', 'segments'];
      for (var j = 0; j < lists.length; j++) {
        if (Array.isArray(input[lists[j]])) return coerceBytesSync(input[lists[j]], label);
      }
      // An ArrayBuffer that lost its contents in transit arrives as `{}`, or
      // as a plain object of numeric keys. Neither is usable, but the cause is
      // almost always the runtime's serializer rather than the caller, so say
      // so instead of echoing "unsupported type object".
      var own = Object.keys(input);
      if (own.length === 0 || (own.length <= 4096 && own.every(function (k) {
        return /^\d+$/.test(k) && typeof input[k] === 'number';
      }))) {
        throw fail('INVALID_SOURCE',
          label + ' arrived as ' + (own.length ? 'a plain object with ' + own.length +
            ' numeric keys' : 'an empty plain object') + '. This runtime cannot serialize an ' +
          'ArrayBuffer through chrome.runtime.sendMessage - send base64 instead ' +
          '(window.btoa over a binary string).', { keys: own.slice(0, 8) });
      }
    }

    throw fail('INVALID_SOURCE', label + ' must be an ArrayBuffer, a typed array, a base64 ' +
      'string, an array of those, or an object wrapping them (received ' + typeof input + ').',
      { received: typeof input });
  }

  /** Async coercion, so a Blob payload works too. */
  async function coerceBytes(input, label) {
    if (isObj(input) && typeof input.arrayBuffer === 'function' &&
      !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
      try {
        var buf = await input.arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) {
        throw fail('INVALID_SOURCE', label + ' Blob could not be read: ' + msgOf(e));
      }
    }
    return coerceBytesSync(input, label);
  }

  function requireBytes(bytes, label) {
    if (!bytes || !bytes.length) {
      throw fail('INVALID_SOURCE', label + ' was empty (' + (bytes ? bytes.length : 0) + ' bytes).');
    }
    return bytes;
  }

  /* ===================================================================== *
   * Web Audio context plumbing
   * ===================================================================== */

  function requireAudio() {
    if (!audio) {
      throw fail('AUDIO_LIB_MISSING',
        'lib/audio.js did not load in the offscreen document, so SunoAudio is undefined. ' +
        'Check that lib/audio.js exists and that offscreen.html lists it before ' +
        'offscreen.js in its script tags.');
    }
    return audio;
  }

  /** OfflineAudioContext when available (no audio hardware), else AudioContext. */
  function pickContextCtor() {
    if (typeof OfflineAudioContext === 'function') return 'OfflineAudioContext';
    if (typeof webkitOfflineAudioContext === 'function') return 'webkitOfflineAudioContext';
    if (typeof AudioContext === 'function') return 'AudioContext';
    if (typeof webkitAudioContext === 'function') return 'webkitAudioContext';
    return null;
  }

  function haveOfflineContext() {
    return typeof OfflineAudioContext === 'function' ||
      typeof webkitOfflineAudioContext === 'function';
  }

  /**
   * Wrap the real constructor so every context lib/audio.js creates is
   * recorded. `new Wrapper(...)` returns the real instance (returning an
   * object from a constructor overrides `this`), so the library's own
   * `instanceof` checks and `decodeAudioData` calls are untouched.
   */
  function trackingContextCtor(realName, sink) {
    function TrackedContext(numChannels, length, sampleRate) {
      var Real = globalThis[realName];
      var ctx = new Real(numChannels, length, sampleRate);
      sink.push(ctx);
      return ctx;
    }
    TrackedContext.displayName = 'Tracked(' + realName + ')';
    return TrackedContext;
  }

  /**
   * Defensive context close.
   *
   * lib/audio.js's decodeToPcm already closes every context it creates in its
   * own `finally` (closeQuiet, lib/audio.js:1556), so this normally closes
   * nothing. It exists because a leaked OfflineAudioContext holds decoded
   * audio in memory for the life of the document, and this document is kept
   * alive for the whole session: if a future decode path ever skipped the
   * finally, we would rather drop the audio than leak it. Returns how many
   * contexts we actually had to close, which is reported back to the worker.
   */
  async function closeStrayContexts(sink) {
    var closed = 0;
    for (var i = 0; i < sink.length; i++) {
      var ctx = sink[i];
      try {
        if (!ctx || ctx.state === 'closed') continue;
        if (typeof ctx.close !== 'function') continue;
        await ctx.close();
        closed++;
      } catch (e) {
        stats.castErrors++;
        addLog('stray context close failed: ' + msgOf(e), 'os-bad');
      }
    }
    return closed;
  }

  function normalizeSampleRate(value, fallback) {
    var rate = num(value, NaN);
    if (!isFinite(rate) || rate <= 0 || rate > 384000) return fallback;
    return Math.round(rate);
  }

  /**
   * The one decode path used by sunoAudioDecode / sunoAnalyze /
   * sunoRenderWav / sunoTranscode. Always closes its contexts, always hands
   * back Float32Array channels.
   */
  async function decodePcm(entry, rawBytes, sampleRateHint) {
    var lib = requireAudio();
    var ctorName = pickContextCtor();
    if (!ctorName) {
      throw fail('NO_AUDIO_CONTEXT',
        'This document has neither OfflineAudioContext nor AudioContext, so there is no ' +
        'Web Audio implementation to decode with. lib/audio.js documents the same failure ' +
        'as NO_AUDIO_CONTEXT.');
    }

    var bytes = requireBytes(rawBytes, 'audio');
    var rate = normalizeSampleRate(sampleRateHint, 48000);
    var created = [];
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    entry.abort = controller;

    var pcm = null;
    try {
      pcm = await lib.decodeToPcm(bytes, {
        // Deliberately the OBJECT form carrying only the offline flavour: an
        // AudioContext is a real output device and we never want one opened.
        // decodeToPcm's default preference is OfflineAudioContext anyway, so
        // this matches the documented contract
        // `decodeToPcm(bytes, { AudioContextCtor: OfflineAudioContext })`.
        AudioContextCtor: { [ctorName]: trackingContextCtor(ctorName, created) },
        sampleRate: rate,
        signal: controller ? controller.signal : undefined,
        warnings: entry.warnings
      });
    } catch (e) {
      // The only call in this try is decodeToPcm, so an error with no code of
      // its own is a decode failure. lib/audio.js's own codes (DECODE_ERROR,
      // ABORTED, INVALID_SOURCE, EMPTY_AUDIO, ...) pass through untouched.
      throw (e && typeof e.code === 'string' && e.code) ? e : fail('DECODE_ERROR', msgOf(e));
    } finally {
      entry.abort = null;
      entry.contextsClosed = await closeStrayContexts(created);
    }

    if (!pcm || !pcm.channels || !pcm.channels.length) {
      throw fail('NO_CHANNELS', 'decoded audio produced no channel data.');
    }
    stats.decoded = stats.decoded + 1;
    return pcm;
  }

  /* ===================================================================== *
   * Tag chunk convention - see the header block above.
   * ===================================================================== */

  /**
   * Byte-identical to lib/audio.js's `toChunkPayload` (lib/audio.js:1712):
   * if the bytes really are a self-consistent chunk carrying the expected id,
   * strip the 8-byte header (and the pad byte, which buildWav re-adds);
   * otherwise assume they are already a bare payload and use them as-is.
   */
  function toBarePayload(bytes, expectedId, sink) {
    if (!bytes || !bytes.length) return null;
    if (bytes.length < 8) return bytes;

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var id = '';
    for (var i = 0; i < 4; i++) id += String.fromCharCode(view.getUint8(i));
    if (id !== expectedId) return bytes;

    var size = view.getUint32(4, true);
    if (size < 0 || 8 + size + (size & 1) !== bytes.length) return bytes;

    sink.push('stripped the 8-byte header from the tagger\'s ' + expectedId +
      ' chunk before muxing');
    return bytes.subarray(8, 8 + size);
  }

  /** Accepts `[{id, bytes}]`, bare bytes (wrapped as 'id3 '), or {extraChunks}. */
  function normalizeExtraChunks(input, sink) {
    var out = [];
    if (input === null || input === undefined) return out;

    var single = viewOf(input);
    if (single && single.length && !Array.isArray(input)) {
      var payload = toBarePayload(single, 'id3 ', sink);
      if (payload && payload.length) out.push({ id: 'id3 ', bytes: payload });
      return out;
    }

    if (Array.isArray(input)) {
      for (var i = 0; i < input.length; i++) {
        var entry = input[i];
        if (!isObj(entry)) {
          sink.push('extraChunks[' + i + '] was not an object; skipped');
          continue;
        }
        var id = str(entry.id);
        var raw = viewOf(entry.bytes !== undefined ? entry.bytes : entry.data);
        if (id.length !== 4) {
          sink.push('extraChunks[' + i + '] id must be exactly 4 characters; skipped');
          continue;
        }
        if (!raw || !raw.length) {
          sink.push('extraChunks[' + i + '] carried no bytes; skipped');
          continue;
        }
        var bare = toBarePayload(raw, id, sink);
        if (bare && bare.length) out.push({ id: id, bytes: bare });
      }
      return out;
    }

    if (isObj(input)) {
      // The container shape first, so { extraChunks: [...], id3ChunkBytes: x }
      // flattens into the array branch rather than being read as one chunk.
      if (input.extraChunks !== undefined || input.id3ChunkBytes !== undefined) {
        out = normalizeExtraChunks(input.extraChunks, sink);
        out = out.concat(normalizeExtraChunks(input.id3ChunkBytes, sink));
        return out;
      }
      if (str(input.id).length === 4) return normalizeExtraChunks([input], sink);
      sink.push('extraChunks was of unsupported shape; ignored');
    }
    return out;
  }

  /* ===================================================================== *
   * Locally vendored encoder (see the header block: no remote code, ever)
   * ===================================================================== */

  var vendorPromises = {};

  function resolveVendorPath(path) {
    try {
      var url = new URL(path, globalThis.location ? globalThis.location.href : '');
      if (url.protocol !== 'chrome-extension:') return null;
      return url.href;
    } catch (e) {
      stats.castErrors++;
      return null;
    }
  }

  /**
   * Inject a LOCAL <script src>. `script-src 'self'` permits exactly this.
   * Rejects any resolved URL that is not a chrome-extension: URL, which is
   * what makes "no remote code" an enforced invariant rather than a promise.
   */
  function loadVendoredScript(path) {
    return new Promise(function (resolve) {
      var href = resolveVendorPath(path);
      if (!href) {
        resolve(false);
        return;
      }
      var done = false;
      var el = document.createElement('script');
      var timer = null;

      function settle(value) {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        try {
          el.remove();
        } catch (e) {
          stats.castErrors++;
        }
        resolve(value);
      }

      // Belt and braces: onerror normally fires for a missing file, but a load
      // that never settles would otherwise hold the request open until TIMEOUT.
      timer = setTimeout(function () { settle(false); }, VENDOR_LOAD_MS);

      el.async = false;
      el.src = href;
      el.onload = function () { settle(true); };
      el.onerror = function () { settle(false); };
      try {
        (document.head || document.documentElement).appendChild(el);
      } catch (e) {
        stats.castErrors++;
        settle(false);
      }
    });
  }

  function encoderLoaded(format) {
    var spec = VENDORED_ENCODERS[format];
    return !!(spec && globalThis[spec.global]);
  }

  async function ensureEncoder(format) {
    var spec = VENDORED_ENCODERS[format];
    if (encoderLoaded(format)) return true;
    if (vendorPromises[format]) return vendorPromises[format];

    vendorPromises[format] = loadVendoredScript(spec.path).then(function (loaded) {
      delete vendorPromises[format];
      encoderState[format] = encoderLoaded(format);
      if (loaded && !encoderState[format]) {
        addLog(spec.path + ' loaded but did not define ' + spec.global, 'os-bad');
      }
      return encoderState[format];
    }, function (e) {
      delete vendorPromises[format];
      encoderState[format] = false;
      addLog('vendor load threw: ' + msgOf(e), 'os-bad');
      return false;
    });
    return vendorPromises[format];
  }

  function encoderUnavailable(format) {
    var spec = VENDORED_ENCODERS[format];
    return fail('ENCODER_UNAVAILABLE',
      'No local encoder vendored at vendor/' + spec.path.replace('../vendor/', '') +
      '. MP3/OGG transcode requires dropping the encoder into the extension. ' +
      'Remote CDN loading is blocked by MV3 CSP.',
      { format: format, expectedPath: spec.path, expectedGlobal: spec.global });
  }

  /* ===================================================================== *
   * Encoders (only reachable once a local encoder has been vendored)
   * ===================================================================== */

  function floatToInt16(channel, start, length) {
    var out = new Int16Array(length);
    var n = Math.min(length, Math.max(0, channel.length - start));
    for (var i = 0; i < n; i++) {
      var v = channel[start + i];
      if (!isFinite(v)) v = 0;
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  function concatInt8(chunks) {
    var total = 0;
    var i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], at);
      at += chunks[i].length;
    }
    return out;
  }

  async function encodeMp3(channels, sampleRate, bitrate) {
    var lame = globalThis.lamejs;
    var encoder = new lame.Mp3Encoder(channels.length, sampleRate, bitrate);
    var frames = channels[0].length;
    var block = 1152;
    var parts = [];
    for (var at = 0; at < frames; at += block) {
      var left = floatToInt16(channels[0], at, block);
      var buf = channels.length > 1
        ? encoder.encodeBuffer(left, floatToInt16(channels[1], at, block))
        : encoder.encodeBuffer(left);
      if (buf && buf.length) parts.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    }
    var tail = encoder.flush();
    if (tail && tail.length) parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length));
    return concatInt8(parts);
  }

  async function encodeOgg(channels, sampleRate, quality) {
    var Ctor = globalThis.OggVorbisEncoder;
    var encoder = new Ctor(sampleRate, channels.length, quality);

    // higuma/ogg-vorbis-encoder-js has a DIFFERENT instance API from lamejs, and
    // getting this wrong fails silently, so the two facts are asserted rather
    // than assumed:
    //   1. `encode(samples)` returns UNDEFINED. It pushes each finished page onto
    //      the encoder's own `oggBuffers` array and gives you nothing back. A
    //      `if (buf && buf.length) parts.push(...)` loop - the shape lamejs
    //      needs - therefore discards EVERY page and yields zero bytes.
    //   2. There is NO `flush()`. The methods are `encode`, `finish`, `cancel`
    //      and `process`; `finish(mimeType)` is the flush, and it hands over the
    //      whole stream as a Blob and frees the encoder. Calling `flush()` was a
    //      TypeError on every single OGG request.
    if (typeof encoder.encode !== 'function' || typeof encoder.finish !== 'function') {
      throw fail('ENCODE_ERROR',
        'vendor/OggVorbisEncoder.js loaded but the global it defines is not the expected encoder ' +
        '(its instance has no encode/finish pair). Check that the file is the complete, unmodified ' +
        'build from higuma/ogg-vorbis-encoder-js - see vendor/README.md for the pinned SHA-256.');
    }

    var frames = channels[0].length;
    var block = 4096;
    for (var at = 0; at < frames; at += block) {
      var end = Math.min(at + block, frames);
      var chunk = [channels[0].subarray(at, end)];
      if (channels.length > 1) chunk.push(channels[1].subarray(at, end));
      encoder.encode(chunk);
    }

    var blob = encoder.finish('audio/ogg');
    var tail = await coerceBytes(blob, 'ogg');
    return new Uint8Array(tail);
  }

  /* ===================================================================== *
   * Handlers
   * ===================================================================== */

  function handlePing() {
    return ok({
      ready: true,
      protocol: PROTOCOL,
      audio: !!audio,
      offlineAudioContext: haveOfflineContext(),
      contextCtor: pickContextCtor(),
      encoder: encoderName(),
      maxConcurrent: MAX_CONCURRENT,
      blobs: blobLru.length,
      blobLimit: BLOB_LRU_LIMIT,
      queue: { active: active, waiting: queue.length, pending: registry.size },
      stats: stats
    });
  }

  async function handleDecode(entry, msg) {
    var bytes = await coerceBytes(msg.audio, 'audio');
    var pcm = await decodePcm(entry, bytes, msg.sampleRate);
    return ok({
      pcm: {
        channels: pcm.channels,
        sampleRate: pcm.sampleRate,
        durationSec: pcm.durationSec
      },
      warnings: entry.warnings,
      contextsClosed: entry.contextsClosed || 0
    });
  }

  async function handleAnalyze(entry, msg) {
    var lib = requireAudio();
    var bytes = await coerceBytes(msg.audio, 'audio');
    var pcm = await decodePcm(entry, bytes, msg.sampleRate);

    var analysis = lib.analyzeAudio({
      channels: pcm.channels,
      sampleRate: pcm.sampleRate,
      tempoRange: msg.tempoRange,
      maxSeconds: msg.maxSeconds,
      warnings: entry.warnings
    });

    var plain = {
      peakDb: analysis.peakDb,
      rmsDb: analysis.rmsDb,
      durationSec: analysis.durationSec,
      sampleRate: analysis.sampleRate,
      channels: analysis.channels,
      bpm: analysis.bpm,
      bpmConfidence: analysis.bpmConfidence
    };
    return ok({ analysis: plain, warnings: entry.warnings });
  }

  async function handleRenderWav(entry, msg) {
    var lib = requireAudio();
    var bytes = await coerceBytes(msg.audio, 'audio');
    var pcm = await decodePcm(entry, bytes, msg.sampleRate);

    var chunks = normalizeExtraChunks(msg.extraChunks, entry.warnings);

    var opts = { warnings: entry.warnings, extraChunks: chunks };
    if (msg.sampleRate !== undefined && msg.sampleRate !== null) {
      // Must be validated HERE, not left to renderToWav: it resamples BEFORE
      // buildWav calls normalizeSampleRate, and resample() has no upper bound,
      // so a stray 1e9 would try to allocate src.length * 22675 samples and
      // take this single-threaded document down with every request queued
      // behind it. Same code lib/audio.js would have thrown.
      var target = num(msg.sampleRate, NaN);
      if (!isFinite(target) || target <= 0 || target > 384000) {
        throw fail('INVALID_SAMPLE_RATE',
          'render sampleRate must be a finite number in (0, 384000] (got ' +
          str(msg.sampleRate) + '). Omit it to keep the source rate.', { sampleRate: msg.sampleRate });
      }
      opts.sampleRate = Math.round(target);
    }
    if (msg.bitDepth !== undefined && msg.bitDepth !== null) opts.bitDepth = msg.bitDepth;
    if (msg.fmt !== undefined && msg.fmt !== null) opts.fmt = msg.fmt;
    if (msg.gainDb !== undefined && msg.gainDb !== null) opts.gainDb = msg.gainDb;
    if (msg.normalize !== undefined && msg.normalize !== null) opts.normalize = msg.normalize;
    if (msg.resampleMethod !== undefined && msg.resampleMethod !== null) {
      opts.resampleMethod = msg.resampleMethod;
    }

    var wav = lib.renderToWav(
      { channels: pcm.channels, sampleRate: pcm.sampleRate },
      opts
    );

    // `bpm` is reported, never invented: an export carries the tempo the
    // caller already decided on. Set detectBpm to have us measure it here.
    var bpm = num(msg.bpm, NaN);
    var bpmSource = 'none';
    if (isFinite(bpm) && bpm > 0) {
      bpm = Math.round(bpm * 100) / 100;
      bpmSource = 'request';
    } else if (msg.detectBpm === true) {
      var tempo = lib.detectBeatsPerMinute(pcm.channels[0], pcm.sampleRate, {
        warnings: entry.warnings
      });
      bpm = tempo && isFinite(tempo.bpm) ? tempo.bpm : null;
      bpmSource = 'detected';
    } else {
      bpm = null;
    }

    return ok({
      bytes: wav.bytes,
      sampleRate: wav.sampleRate,
      bitDepth: wav.bitDepth,
      bpm: bpm,
      bpmSource: bpmSource,
      warnings: entry.warnings
    });
  }

  async function handleBlobUrl(entry, msg) {
    var source = msg.bytes !== undefined && msg.bytes !== null ? msg.bytes : msg.audio;
    var bytes = requireBytes(await coerceBytes(source, 'bytes'), 'bytes');

    var mime = str(msg.mime).trim() || 'application/octet-stream';
    if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mime)) {
      entry.warnings.push('unusable mime "' + mime + '"; stored as application/octet-stream');
      mime = 'application/octet-stream';
    }

    var url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    trackBlobUrl(url);
    return ok({ url: url, mime: mime, byteLength: bytes.length, live: blobLru.length });
  }

  async function handleBlobRevoke(entry, msg) {
    var urls = [];
    if (msg.url) urls.push(str(msg.url));
    if (Array.isArray(msg.urls)) {
      for (var i = 0; i < msg.urls.length; i++) urls.push(str(msg.urls[i]));
    }
    var revoked = 0;
    for (var j = 0; j < urls.length; j++) {
      if (revokeOne(urls[j])) revoked++;
    }
    return ok({ revoked: revoked, requested: urls.length, live: blobLru.length });
  }

  async function handleBlobRevokeAll() {
    return ok({ revoked: revokeAll(), live: blobLru.length });
  }

  async function handleTranscode(entry, msg) {
    var format = str(msg.format).trim().toLowerCase();
    if (format !== 'mp3' && format !== 'ogg') {
      throw fail('UNSUPPORTED_FORMAT',
        'transcode format must be "mp3" or "ogg" (received "' + str(msg.format) + '"). ' +
        'For M4A/Opus, save the original stream instead - it needs no transcode.', { format: msg.format });
    }

    var ready = await ensureEncoder(format);
    if (!ready) throw encoderUnavailable(format);

    var bytes = await coerceBytes(msg.audio, 'audio');
    var pcm = await decodePcm(entry, bytes, msg.sampleRate);
    var rate = pcm.sampleRate || normalizeSampleRate(msg.sampleRate, 48000);

    stats.encodeAttempts++;
    var out;
    if (format === 'mp3') {
      var bitrate = Math.round(num(msg.bitrate, 192));
      if (bitrate < 32 || bitrate > 320) bitrate = 192;
      out = await encodeMp3(pcm.channels, rate, bitrate);
    } else {
      var quality = num(msg.quality, 0.8);
      if (quality > 1) quality = quality / 10; // accept either 0-1 or 0-10
      if (quality <= 0 || quality > 1) quality = 0.8;
      out = await encodeOgg(pcm.channels, rate, quality);
    }

    if (!out || !out.length) {
      throw fail('ENCODE_ERROR',
        'the vendored ' + format + ' encoder returned zero bytes. The encoder file is present ' +
        'but did not produce output - check that vendor/' + VENDORED_ENCODERS[format].path +
        ' is a complete, unmodified build.');
    }

    return ok({
      bytes: out,
      mime: format === 'mp3' ? 'audio/mpeg' : 'audio/ogg',
      format: format,
      sampleRate: rate,
      warnings: entry.warnings
    });
  }

  /* ===================================================================== *
   * Dispatch table
   * ===================================================================== */

  /** Heavy: these take a concurrency slot. */
  var HEAVY = {
    sunoAudioDecode: handleDecode,
    sunoAnalyze: handleAnalyze,
    sunoRenderWav: handleRenderWav,
    sunoTranscode: handleTranscode
  };

  /** Light: these never take a slot, so a busy decoder cannot stall a probe. */
  var LIGHT = {
    sunoPing: function () { return handlePing(); },
    sunoBlobUrl: handleBlobUrl,
    sunoBlobRevoke: handleBlobRevoke,
    sunoBlobRevokeAll: handleBlobRevokeAll
  };

  function statsSnapshot() {
    return {
      received: stats.received,
      served: stats.served,
      failed: stats.failed,
      decoded: stats.decoded || 0,
      timedOut: stats.timedOut,
      reaped: stats.reaped,
      queued: queue.length,
      active: active
    };
  }

  function runEntry(entry, handler) {
    var result;
    try {
      result = handler(entry, entry.message);
    } catch (e) {
      finish(entry, typedFailure(e));
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(function (value) {
        finish(entry, isObj(value) && value.ok === true ? value : ok(value));
      }, function (e) {
        finish(entry, typedFailure(e));
      });
    } else {
      finish(entry, result);
    }
  }

  function pump() {
    while (!shuttingDown && active < MAX_CONCURRENT && queue.length) {
      var entry = queue.shift();
      entry.heavy = true;
      active++;
      runEntry(entry, HEAVY[entry.type]);
    }
    renderStatus();
  }

  /* ===================================================================== *
   * Registry / reply plumbing
   * ===================================================================== */

  function dequeue(entry) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i] === entry) {
        queue.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Metadata-only twin of a reply, for the broadcast. Chrome's runtime
   * messaging copies every byte it carries, so duplicating a decoded buffer
   * would double peak memory; the broadcast keeps the envelope (so a worker
   * listening only on that channel still learns the outcome) and replaces the
   * bytes with a descriptor.
   */
  function shadowize(value, depth) {
    if (depth > 3) return '[deep]';
    if (value instanceof ArrayBuffer) {
      return { byteLength: value.byteLength, kind: 'ArrayBuffer' };
    }
    if (isTypedArray(value)) {
      return { byteLength: value.byteLength, length: value.length, kind: value.constructor ?
        value.constructor.name : 'TypedArray' };
    }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(shadowize(value[i], depth + 1));
      return arr;
    }
    if (isObj(value)) {
      var out = {};
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) out[keys[k]] = shadowize(value[keys[k]], depth + 1);
      return out;
    }
    return value;
  }

  function containsBytes(value, depth) {
    if (depth > 3) return false;
    if (value instanceof ArrayBuffer || isTypedArray(value)) return true;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (containsBytes(value[i], depth + 1)) return true;
      }
      return false;
    }
    if (isObj(value)) {
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) {
        if (containsBytes(value[keys[k]], depth + 1)) return true;
      }
    }
    return false;
  }

  function broadcast(message) {
    var bcast = shadowize(message, 0);
    if (containsBytes(message, 0)) bcast.payloadTruncated = true;
    try {
      chrome.runtime.sendMessage(bcast, function () {
        var err = chrome.runtime.lastError;
        if (err) stats.broadcastMisses++;
      });
    } catch (e) {
      stats.castErrors++;
      addLog('broadcast failed: ' + msgOf(e), 'os-bad');
    }
  }

  /**
   * Deliver one fully-built envelope on BOTH reply channels. Every reply this
   * document ever sends goes through here - success, failure, unknown type,
   * duplicate id, torn-down request - so a worker listening on either channel
   * is answered identically and no code path can forget the broadcast.
   */
  function deliver(respond, message) {
    broadcast(message);
    try {
      respond(message);
    } catch (e) {
      // The port is gone: the worker was torn down, or it only uses the
      // broadcast channel. Nothing to do - the typed reply already went out.
      stats.castErrors++;
    }
  }

  /** Answer a pending entry exactly once, on BOTH reply channels. */
  function finish(entry, payload) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    registry.delete(entry.id);
    dequeue(entry);
    if (entry.heavy) {
      entry.heavy = false;
      active--;
    }

    var succeeded = isObj(payload) && payload.ok === true;
    var keys = Object.keys(payload);

    if (succeeded) {
      stats.served++;
      // Ping is polled; logging it every time would bury everything useful.
      if (entry.type !== 'sunoPing') {
        addLog('ok   ' + entry.type + ' #' + entry.id + ' in ' + (now() - entry.receivedAt) + 'ms');
      }
    } else {
      stats.failed++;
      addLog('FAIL ' + entry.type + ' #' + entry.id + ' [' + str(payload.code) + '] ' +
        str(payload.detail), 'os-bad');
    }

    var message = {
      from: 'offscreen',
      protocol: PROTOCOL,
      type: entry.type + ':result',
      id: entry.id,
      elapsedMs: now() - entry.receivedAt,
      stats: statsSnapshot()
    };
    for (var i = 0; i < keys.length; i++) message[keys[i]] = payload[keys[i]];

    deliver(entry.sendResponse, message);

    if (active < 0) {
      /* entry.heavy is the only thing allowed to give a slot back, so this is
         unreachable - but a silently wrong cap is worse than a loud line. */
      stats.castErrors++;
      active = 0;
      addLog('concurrency slot accounting underflow; reset to 0', 'os-bad');
    }
    pump();
  }

  function abortInFlight(entry, reason) {
    if (entry.abort) {
      try {
        entry.abort.abort();
      } catch (e) {
        stats.castErrors++;
        addLog('abort(' + reason + ') failed: ' + msgOf(e), 'os-bad');
      }
      entry.abort = null;
    }
  }

  function normalizeId(raw, type) {
    if (typeof raw === 'number' && isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw) return raw;
    return type + '-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** Own-property lookup: `HEAVY['constructor']` must not resolve to Object. */
  function handlerFor(table, type) {
    return Object.prototype.hasOwnProperty.call(table, type) ? table[type] : null;
  }

  /**
   * Inbox. Returns false for anything that is not addressed to us (including
   * our own broadcasts, so a runtime that echoes them cannot loop), true when
   * the reply will be asynchronous.
   */
  function onMessage(message, sender, sendResponse) {
    try {
      if (!isObj(message)) return false;
      if (message.from === 'offscreen') return false;
      if (message.target !== 'offscreen') return false;

      var type = str(message.type);
      var id = normalizeId(message.id, type);
      stats.received++;

      if (!handlerFor(HEAVY, type) && !handlerFor(LIGHT, type)) {
        stats.rejected++;
        addLog('unknown message type "' + type + '"', 'os-bad');
        deliver(sendResponse, {
          from: 'offscreen',
          protocol: PROTOCOL,
          type: type + ':result',
          id: id,
          ok: false,
          code: 'UNKNOWN_TYPE',
          detail: 'The offscreen document does not implement "' + type + '". It implements: ' +
            Object.keys(HEAVY).concat(Object.keys(LIGHT)).join(', ') + '.'
        });
        return true;
      }

      if (registry.has(id)) {
        stats.rejected++;
        addLog('duplicate id #' + id + ' for ' + type + ' rejected', 'os-bad');
        deliver(sendResponse, {
          from: 'offscreen',
          protocol: PROTOCOL,
          type: type + ':result',
          id: id,
          ok: false,
          code: 'DUPLICATE_ID',
          detail: 'Request id "' + id + '" is already in flight. Ids must be unique per request.'
        });
        return true;
      }

      var timeout = num(message.timeoutMs, DEFAULT_TIMEOUT_MS);
      if (!isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT_MS;
      timeout = Math.min(timeout, 15 * 60 * 1000);

      var entry = {
        id: id,
        type: type,
        message: message,
        sender: sender,
        sendResponse: sendResponse,
        receivedAt: now(),
        warnings: [],
        abort: null,
        contextsClosed: 0,
        settled: false,
        timer: null
      };

      entry.timer = setTimeout(function () {
        stats.timedOut++;
        abortInFlight(entry, 'timeout');
        finish(entry, {
          ok: false,
          code: 'TIMEOUT',
          detail: type + ' did not finish within ' + timeout + 'ms. A queued request can ' +
            'time out behind slower decodes: the document runs at most ' + MAX_CONCURRENT +
            ' at a time and a single thread does the work.'
        });
      }, timeout);

      registry.set(id, entry);

      if (handlerFor(LIGHT, type)) {
        runEntry(entry, LIGHT[type]);
      } else {
        queue.push(entry);
        pump();
      }
      renderStatus();
      return true;
    } catch (e) {
      stats.castErrors++;
      stats.failed++;
      addLog('onMessage threw: ' + msgOf(e), 'os-bad');
      deliver(sendResponse, {
        from: 'offscreen',
        protocol: PROTOCOL,
        type: str(isObj(message) ? message.type : 'message') + ':result',
        id: normalizeId(isObj(message) ? message.id : null, 'message'),
        ok: false,
        code: 'HANDLER_ERROR',
        detail: msgOf(e)
      });
      return true;
    }
  }

  /**
   * Answer everything still pending, stop accepting work, drop every blob URL.
   * A request can never be left hanging when the document goes away.
   */
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }

    var pending = [];
    var it = registry.values();
    var step = it.next();
    while (!step.done) {
      pending.push(step.value);
      step = it.next();
    }
    for (var i = 0; i < pending.length; i++) {
      abortInFlight(pending[i], 'shutdown');
      finish(pending[i], {
        ok: false,
        code: 'DOCUMENT_CLOSING',
        detail: 'The offscreen document is being torn down (' + reason + '). Retry after the ' +
          'service worker recreates it with chrome.offscreen.createDocument().'
      });
    }

    queue.length = 0;
    var revoked = revokeAll();
    addLog('shutdown: ' + reason + ' · released ' + pending.length + ' request(s), revoked ' +
      revoked + ' blob URL(s)');
    setStatus('CLOSING', 'os-bad', reason + ' · ' + revoked + ' blob URL(s) revoked');
  }

  /**
   * Age-based orphan reaper. A worker can die mid-request; nothing in the
   * message API reports that, so a request with no answer for ORPHAN_AGE_MS
   * is declared dead, answered with a typed failure and dropped.
   */
  function sweep() {
    if (shuttingDown) return;
    var cutoff = now() - ORPHAN_AGE_MS;
    var orphans = [];
    var it = registry.values();
    var step = it.next();
    while (!step.done) {
      if (step.value.receivedAt < cutoff) orphans.push(step.value);
      step = it.next();
    }
    for (var i = 0; i < orphans.length; i++) {
      var entry = orphans[i];
      stats.reaped++;
      abortInFlight(entry, 'orphan');
      finish(entry, {
        ok: false,
        code: 'ORPHANED',
        detail: 'No reply was delivered within ' + ORPHAN_AGE_MS + 'ms; the requesting context ' +
          'is presumed gone. Reap and dropped here.'
      });
    }
    if (orphans.length) renderStatus();
  }

  /* ===================================================================== *
   * Boot
   * ===================================================================== */

  function boot() {
    bindDom();

    if (!audio) {
      setStatus('DEGRADED', 'os-bad',
        'lib/audio.js did not load - every decode will answer AUDIO_LIB_MISSING.');
      addLog('SunoAudio is undefined; check the <script src="../lib/audio.js"> tag in ' +
        'offscreen.html', 'os-bad');
    } else {
      addLog('SunoAudio ' + str(audio.version || '?') + ' ready; context = ' +
        str(pickContextCtor()) + '; encoder = ' + encoderName());
    }

    try {
      chrome.runtime.onMessage.addListener(onMessage);
    } catch (e) {
      stats.castErrors++;
      setStatus('BROKEN', 'os-bad', 'could not register chrome.runtime.onMessage: ' + msgOf(e));
      return;
    }

    sweepTimer = setInterval(sweep, ORPHAN_SWEEP_MS);

    // Teardown. `unload` fires on a real close; `pagehide` also covers the
    // document being discarded, which is the case that actually leaks blob
    // URLs.
    try {
      globalThis.addEventListener('pagehide', function () { shutdown('pagehide'); });
      globalThis.addEventListener('unload', function () { shutdown('unload'); });
    } catch (e) {
      stats.castErrors++;
    }

    // Nothing in this file is allowed to escape as an unhandled rejection,
    // including anything a vendored encoder script might start. Surface it on
    // the status line instead of letting it vanish.
    try {
      globalThis.addEventListener('unhandledrejection', function (event) {
        stats.castErrors++;
        addLog('unhandled rejection: ' + msgOf(event && event.reason), 'os-bad');
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      });
    } catch (e) {
      stats.castErrors++;
    }

    renderStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();