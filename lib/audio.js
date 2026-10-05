/**
 * Suno Master Utility - Audio Processing Engine (lib/audio.js)
 * ===========================================================================
 *
 * SERVICE-WORKER SAFETY IS THE WHOLE POINT OF THIS FILE.
 *
 * An MV3 service worker has NO Web Audio API. There is no `AudioContext`, no
 * `OfflineAudioContext`, no `AudioBuffer`, no `decodeAudioData` and no
 * Blob-URL audio decoding. It DOES have `crypto.subtle`, `fetch`,
 * `AbortController`, `Blob`, `ReadableStream`, `TextDecoder`, `TextEncoder`,
 * `DataView` and typed arrays.
 *
 * So this module is split in two halves:
 *
 *   SW-SAFE (context-free, pure math / bytes). Callable from
 *   background/background.js with zero globals:
 *     floatTo16BitPcm / floatTo24BitPcm / floatTo32BitPcm
 *     interleave / deinterleave / toMono
 *     resample / applyGain / normalize
 *     detectBeatsPerMinute / detectBPM
 *     analyzeAudio
 *     buildWav / wavBlob / renderToWav
 *     rateTag / toTagMeta
 *     getWarnings / takeWarnings / setLogger / setAudioContextCtor
 *     audioBufferToWavBlob and processAndCreateWav, as long as the caller
 *       injects an AudioContext constructor or hands over already-decoded
 *       PCM; otherwise they throw NO_AUDIO_CONTEXT.
 *
 *   CONTEXT-REQUIRED (needs a real Web Audio implementation):
 *     decodeToPcm
 *     getAudioContext / closeAudioContext (instance helpers)
 *
 * Nothing here touches `window` or `document` at load time, and no function
 * reads a global unless documented otherwise (only `wavBlob` needs `Blob`).
 *
 * ---------------------------------------------------------------------------
 * EXPECTED OFFSCREEN DOCUMENT INTERFACE (owned by the manifest, NOT by us)
 * ---------------------------------------------------------------------------
 * `offscreen/offscreen.html` must be a DOM document, because Web Audio is
 * unavailable in the worker. It loads this same file and acts as a decode
 * proxy; the SW only ever handles PCM and bytes.
 *
 *   service worker (SW-safe half)        offscreen document (DOM half)
 *   ----------------------------------   -------------------------------------
 *   chrome.offscreen.createDocument({    SunoAudio.decodeToPcm(bytes, {
 *     url: 'offscreen/offscreen.html',     AudioContextCtor: OfflineAudioContext
 *     reasons: ['AUDIO_PLAYBACK'],         // or AudioContext
 *     justification: 'decode media'        // preferred, no audio hardware
 *   })                                  })
 *                                      ->
 *   chrome.runtime.sendMessage({          { ok: true,
 *     target: 'offscreen',                  pcm: { channels: [Float32Array...],
 *     type: 'sunoAudioDecode',                  sampleRate, durationSec } }
 *     id,
 *     audio: arrayBuffer                 }
 *   })                                 <- channel buffers are transferable
 *
 * Message contract:
 *   request : { type:'sunoAudioDecode', id, audio:ArrayBuffer, sampleRate? }
 *   success : { type:'sunoAudioDecode:result', id, ok:true,
 *               pcm:{ channels:Float32Array[], sampleRate, durationSec } }
 *   failure : { type:'sunoAudioDecode:result', id, ok:false,
 *               code:'DECODE_ERROR'|'ABORTED', detail }
 *
 * The offscreen document MUST close its context after each decode; this
 * module's `decodeToPcm` already does that for you. Keep one offscreen
 * document alive for the session and route every decode through it, then run
 * BPM + WAV mux + tagging inline in the worker where no Web Audio exists.
 *
 * ---------------------------------------------------------------------------
 * TYPED ERRORS
 * ---------------------------------------------------------------------------
 *   NO_AUDIO_CONTEXT     no Web Audio implementation is reachable
 *   DECODE_ERROR         decodeAudioData rejected, or produced 0 frames
 *   ABORTED              the caller's AbortSignal fired
 *   INVALID_SOURCE       not an ArrayBuffer / TypedArray / Blob / base64 string
 *   NO_CHANNELS          the channel list was empty
 *   EMPTY_AUDIO          channels exist but every one is 0 frames long
 *   INVALID_SAMPLE_RATE  non-finite, <= 0, or out of range
 *   INVALID_BIT_DEPTH    not one of 8 / 16 / 24 / 32
 *   INVALID_FORMAT       WAV format code is neither PCM(1) nor IEEE_FLOAT(3)
 *   NO_BLOB              the Blob constructor is unavailable and required
 *
 * A malformed `extraChunks` entry (bad 4-character id, wrong type) is NOT an
 * error: it is skipped and reported in `warnings`, because one bad tag chunk
 * should never cost you the audio.
 *
 * Everything else is total: garbage in, a neutral value out. In particular
 * `detectBeatsPerMinute`, `analyzeAudio`, `normalize`, `applyGain`, `toMono`,
 * `interleave` and `deinterleave` never throw, and nothing is ever written
 * to `console`.
 */

(function (root, factory) {
  'use strict';

  var api = factory();

  if (typeof module === 'object' && module !== null && typeof module.exports !== 'undefined') {
    module.exports = api;
  }
  if (typeof window !== 'undefined' && window) {
    window.SunoAudio = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ===================================================================== *
   * Constants
   * ===================================================================== */

  var VERSION = '2.0.0';

  /** Legacy fold band. Only the `detectBPM` wrapper uses it;               *
   *  `detectBeatsPerMinute` never folds unless you pass `tempoRange`.       */
  var DEFAULT_TEMPO_RANGE = [70, 175];

  /** Search band for the autocorrelation, in BPM. */
  var LOG_RANGE = [40, 220];

  /**
   * Energy-envelope frame length in seconds. The reference detector used
   * 50 ms, which quantizes the tempo badly: a period that does not land on a
   * multiple of the frame splits its energy across two lags and loses to some
   * harmonic. 25 ms measured best across synthetic click tracks from 40 to
   * 220 BPM at 44.1 and 48 kHz. Override per call with `opts.frameSeconds`;
   * 0.05 is reasonable for sparse sustained material where a short frame only
   * adds noise, 0.01 for sharp transients.
   */
  var FRAME_SECONDS = 0.025;

  var SUPPORTED_BIT_DEPTHS = [8, 16, 24, 32];

  /** Reporting floor so silence serializes cleanly instead of -Infinity. */
  var DB_FLOOR = -120;

  var MAX_WARNINGS = 50;

  var NOOP = function () {};

  /** Set via setAudioContextCtor; see the static accessor below. */
  var injectedContextCtor = null;

  /* ===================================================================== *
   * Tiny helpers (no lodash, no globals)
   * ===================================================================== */

  function isObj(v) {
    return v !== null && typeof v === 'object';
  }

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    return isFinite(n) ? n : (fallback === undefined ? NaN : fallback);
  }

  function str(v) {
    if (typeof v === 'string') return v;
    return v === null || v === undefined ? '' : String(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function isTypedArray(v) {
    return !!v && typeof v === 'object' && typeof v.length === 'number' &&
      typeof v.BYTES_PER_ELEMENT === 'number';
  }

  /** NaN-safe clamp to [-1, 1]. */
  function clamp1(v) {
    var n = typeof v === 'number' ? v : NaN;
    if (!isFinite(n)) return 0;
    return n < -1 ? -1 : n > 1 ? 1 : n;
  }

  function amplitudeToDb(amp) {
    if (!isFinite(amp) || amp <= 0) return DB_FLOOR;
    var db = 20 * Math.log10(amp);
    return db < DB_FLOOR ? DB_FLOOR : db;
  }

  /* ===================================================================== *
   * Injected logger + warning sink (default no-op; nothing is ever written to `console`)
   * ===================================================================== */

  var currentLogger = NOOP;
  var warningSink = [];

  function pushWarning(sink, message) {
    var line = str(message);
    try {
      sink.push(line);
      if (sink.length > MAX_WARNINGS) sink.splice(0, sink.length - MAX_WARNINGS);
    } catch (e) {
      // A frozen or non-array sink is a caller bug: drop the warning rather
      // than breaking the audio path.
      currentLogger('[SunoAudio] warning sink rejected a message:', line);
    }
    return line;
  }

  function loggerOf(opts) {
    if (opts && typeof opts.logger === 'function') return opts.logger;
    return currentLogger;
  }

  /** A caller-supplied `opts.warnings` array wins, else the module sink. */
  function warningTarget(opts) {
    if (opts && Array.isArray(opts.warnings)) return opts.warnings;
    return warningSink;
  }

  function warn(opts, sink, message) {
    pushWarning(sink, message);
    loggerOf(opts)('[SunoAudio] ' + str(message));
  }

  /* ===================================================================== *
   * SunoAudioError
   * ===================================================================== */

  function SunoAudioError(message, code, detail) {
    var base = Error.call(this, str(message));
    this.name = 'SunoAudioError';
    this.message = str(message);
    this.code = str(code) || 'AUDIO_ERROR';
    this.detail = detail === undefined ? null : detail;
    if (base && base.stack) this.stack = base.stack;
    else if (Error.captureStackTrace) Error.captureStackTrace(this, SunoAudioError);
  }

  SunoAudioError.prototype = Object.create(Error.prototype);
  SunoAudioError.prototype.constructor = SunoAudioError;

  SunoAudioError.isNoAudioContext = function (e) {
    return !!e && e.code === 'NO_AUDIO_CONTEXT';
  };

  SunoAudioError.isDecodeError = function (e) {
    return !!e && e.code === 'DECODE_ERROR';
  };

  function isAudioError(e) {
    return !!e && e.name === 'SunoAudioError' && typeof e.code === 'string';
  }

  /* ===================================================================== *
   * Input coercion
   * ===================================================================== */

  /** Anything -> Float32Array. Copies when needed, never throws. */
  function toFloat32(v) {
    try {
      if (v instanceof Float32Array) return v;
      if (isTypedArray(v)) return new Float32Array(v.buffer, v.byteOffset, v.length >>> 0);
      if (Array.isArray(v)) return new Float32Array(v);
      if (v instanceof ArrayBuffer) return new Float32Array(v);
      if (v && typeof v.length === 'number') return new Float32Array(v);
    } catch (e) {
      currentLogger('[SunoAudio] toFloat32 could not coerce input:', e && e.message);
    }
    return new Float32Array(0);
  }

  /**
   * Anything -> Float32Array[]. Accepts Float32Array[], Float32Array,
   * ArrayBuffer, { channels } or an AudioBuffer-like ({ numberOfChannels,
   * getChannelData }). Total: returns [] for unusable input.
   *
   * An explicitly declared channel is kept even when it is empty, so
   * buildWav can tell "no channels" (NO_CHANNELS) from "channels with 0
   * frames" (EMPTY_AUDIO) instead of silently collapsing to mono. Entries
   * that coerce to nothing usable become empty channels rather than being
   * removed; a real AudioBuffer never yields one, so that path still drops
   * them.
   */
  function asChannels(input) {
    var out = [];
    if (input === null || input === undefined) return out;
    try {
      if (Array.isArray(input)) {
        for (var i = 0; i < input.length; i++) out.push(toFloat32(input[i]));
        return out;
      }
      if (isTypedArray(input) || input instanceof ArrayBuffer) {
        var single = toFloat32(input);
        return single.length ? [single] : [];
      }
      if (typeof input.getChannelData === 'function') {
        var n = num(input.numberOfChannels, 0) | 0;
        if (n < 1) n = 1;
        for (var c = 0; c < n; c++) {
          var ch = input.getChannelData(c);
          if (ch && ch.length) out.push(toFloat32(ch).slice());
        }
        return out;
      }
      if (input.channels !== undefined && input.channels !== null) return asChannels(input.channels);
    } catch (e) {
      currentLogger('[SunoAudio] asChannels failed:', e && e.message);
    }
    return out;
  }

  /** Pad short channels with silence so every channel has `max` frames. */
  function alignChannels(channels, sink) {
    var max = 0;
    var i;
    for (i = 0; i < channels.length; i++) max = Math.max(max, channels[i].length);
    var out = new Array(channels.length);
    for (i = 0; i < channels.length; i++) {
      var ch = channels[i];
      if (ch.length === max) {
        out[i] = ch;
      } else {
        var padded = new Float32Array(max);
        padded.set(ch.subarray(0, Math.min(ch.length, max)));
        out[i] = padded;
        pushWarning(sink, 'channel ' + i + ' had ' + ch.length + ' frames, padded to ' + max);
      }
    }
    return out;
  }

  function framesOf(channels) {
    var max = 0;
    for (var i = 0; i < channels.length; i++) max = Math.max(max, channels[i].length);
    return max;
  }

  /** Preserve single-channel-vs-array shape across a per-channel transform. */
  function mapChannels(input, fn) {
    var wasSingle = !Array.isArray(input) && (isTypedArray(input) || input instanceof ArrayBuffer);
    var channels = asChannels(input);
    var out = new Array(channels.length);
    for (var i = 0; i < channels.length; i++) out[i] = fn(channels[i], i);
    return wasSingle ? (out.length ? out[0] : new Float32Array(0)) : out;
  }

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i) & 0xFF);
  }

  /* ===================================================================== *
   * RIFF extra chunks
   * ===================================================================== */

  /** { id, bytes } -> { id, bytes:Uint8Array, pad } or null with a warning. */
  function normalizeChunk(chunk, index, sink) {
    if (!isObj(chunk)) {
      pushWarning(sink, 'extraChunks[' + index + '] was not an object; skipped');
      return null;
    }
    var id = str(chunk.id);
    if (id.length !== 4) {
      pushWarning(sink, 'extraChunks[' + index + '] id must be exactly 4 characters; skipped');
      return null;
    }
    var bytes = chunk.bytes;
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    else if (isTypedArray(bytes)) bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    else bytes = new Uint8Array(0);
    return { id: id, bytes: bytes, pad: bytes.length & 1 };
  }

  /**
   * Accepts [{id,bytes}], an ArrayBuffer/TypedArray (wrapped as an 'id3 '
   * chunk), or { extraChunks, id3ChunkBytes }.
   */
  function normalizeExtraChunks(input, sink) {
    var out = [];
    if (input === null || input === undefined) return out;

    if (input instanceof ArrayBuffer || isTypedArray(input)) {
      var raw = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
      if (raw.length) out.push({ id: 'id3 ', bytes: raw, pad: raw.length & 1 });
      return out;
    }

    if (Array.isArray(input)) {
      for (var i = 0; i < input.length; i++) {
        var c = normalizeChunk(input[i], i, sink);
        if (c) out.push(c);
      }
      return out;
    }

    if (isObj(input)) {
      var merged = normalizeExtraChunks(input.extraChunks, sink);
      for (var j = 0; j < merged.length; j++) out.push(merged[j]);
      var id3 = normalizeExtraChunks(input.id3ChunkBytes, sink);
      for (var k = 0; k < id3.length; k++) out.push(id3[k]);
      return out;
    }

    pushWarning(sink, 'extraChunks was of unsupported type ' + typeof input + '; ignored');
    return out;
  }

  /* ===================================================================== *
   * PCM / byte layer (context-free)
   * ===================================================================== */

  function floatTo16BitPcm(float32) {
    var src = toFloat32(float32);
    var out = new Uint8Array(src.length * 2);
    var view = new DataView(out.buffer);
    for (var i = 0; i < src.length; i++) {
      var s = clamp1(src[i]);
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return out;
  }

  function floatTo24BitPcm(float32) {
    var src = toFloat32(float32);
    var out = new Uint8Array(src.length * 3);
    var view = new DataView(out.buffer);
    for (var i = 0; i < src.length; i++) {
      var s = clamp1(src[i]);
      var v = (s < 0 ? s * 0x800000 : s * 0x7FFFFF) | 0;
      var o = i * 3;
      out[o] = v & 0xFF;
      out[o + 1] = (v >> 8) & 0xFF;
      out[o + 2] = (v >> 16) & 0xFF;
    }
    return out;
  }

  /**
   * 32-bit output. Default is signed PCM int32 (WAV format code 1); pass
   * `{ float: true }` for raw IEEE-754 float32 LE (WAV format code 3).
   * Integer depths truncate toward zero, matching DataView semantics.
   */
  function floatTo32BitPcm(float32, opts) {
    var src = toFloat32(float32);
    var asFloat = !!(opts && opts.float);
    var out = new Uint8Array(src.length * 4);
    var view = new DataView(out.buffer);
    for (var i = 0; i < src.length; i++) {
      var s = clamp1(src[i]);
      var o = i * 4;
      if (asFloat) view.setFloat32(o, s, true);
      else view.setInt32(o, (s < 0 ? s * 0x80000000 : s * 0x7FFFFFFF) | 0, true);
    }
    return out;
  }

  /** 8-bit WAV PCM is UNSIGNED with a 128 bias. Used by buildWav. */
  function floatTo8BitPcm(float32) {
    var src = toFloat32(float32);
    var out = new Uint8Array(src.length);
    for (var i = 0; i < src.length; i++) {
      out[i] = ((clamp1(src[i]) * 127) | 0) + 128;
    }
    return out;
  }

  /** Float32Array[] -> one interleaved Float32Array (frame major). */
  function interleave(channels) {
    var list = asChannels(channels);
    if (!list.length) return new Float32Array(0);
    var frames = framesOf(list);
    var out = new Float32Array(frames * list.length);
    var idx = 0;
    for (var i = 0; i < frames; i++) {
      for (var c = 0; c < list.length; c++) out[idx++] = i < list[c].length ? list[c][i] : 0;
    }
    return out;
  }

  /** Interleaved -> Float32Array[]. A trailing partial frame is dropped. */
  function deinterleave(interleaved, channelCount) {
    var src = toFloat32(interleaved);
    var count = num(channelCount, 0) | 0;
    if (count < 1) count = src.length ? 1 : 0;
    if (!count) return [];
    var frames = Math.floor(src.length / count);
    var out = new Array(count);
    for (var c = 0; c < count; c++) out[c] = new Float32Array(frames);
    for (var i = 0; i < frames; i++) {
      var base = i * count;
      for (var c2 = 0; c2 < count; c2++) out[c2][i] = src[base + c2];
    }
    return out;
  }

  /** Stereo defaults to 0.5/0.5, anything else averages. Pure; returns new. */
  function toMono(channels, weights) {
    var list = asChannels(channels);
    var frames = framesOf(list);
    var out = new Float32Array(frames);
    if (!list.length || !frames) return out;

    var w = new Float64Array(list.length);
    if (Array.isArray(weights) && weights.length === list.length) {
      var sum = 0;
      for (var i = 0; i < list.length; i++) {
        w[i] = num(weights[i], 0);
        sum += w[i];
      }
      if (sum > 0) {
        for (var j = 0; j < list.length; j++) w[j] /= sum;
      } else {
        for (var k = 0; k < list.length; k++) w[k] = 1 / list.length;
      }
    } else if (list.length === 2) {
      w[0] = 0.5;
      w[1] = 0.5;
    } else {
      for (var m = 0; m < list.length; m++) w[m] = 1 / list.length;
    }

    for (var c = 0; c < list.length; c++) {
      var ch = list[c];
      if (!w[c]) continue;
      for (var f = 0; f < frames; f++) out[f] += (f < ch.length ? ch[f] : 0) * w[c];
    }
    return out;
  }

  /**
   * Genuine sample-rate conversion -> Float32Array.
   *   linear - O(1) per output sample. Fine for small ratios, but it does not
   *            filter above the new Nyquist, so it softens rather than
   *            properly rejects aliases when decimating.
   *   box    - averages max(1, round(fromRate/toRate)) input samples per
   *            output sample: a cheap anti-alias prefilter for decimation.
   * `fromRate === toRate` returns an equal-length COPY, never the input.
   * Throws INVALID_SAMPLE_RATE for garbage rates; returns a 0-length
   * Float32Array for empty input.
   */
  function resample(input, fromRate, toRate, opts) {
    var src = toFloat32(input);
    var from = num(fromRate, 0);
    var to = num(toRate, 0);
    if (!isFinite(from) || from <= 0 || !isFinite(to) || to <= 0) {
      throw new SunoAudioError(
        'resample: sample rates must be finite and > 0 (got ' + str(fromRate) +
          ' -> ' + str(toRate) + ').',
        'INVALID_SAMPLE_RATE', { fromRate: fromRate, toRate: toRate }
      );
    }
    if (!src.length) return new Float32Array(0);
    if (from === to) return new Float32Array(src);

    var method = str(opts && opts.method).toLowerCase() || 'linear';

    // `outPerIn` is output samples per input sample, so the output length is
    // src.length * outPerIn. `inPerOut` is its reciprocal: how far to advance
    // through the input for each output sample. Mixing these two up is the
    // classic resampler bug - it yields a correct LENGTH carrying a signal of
    // the wrong duration (a 100 Hz sine comes back as 25 Hz).
    var outPerIn = to / from;
    var inPerOut = from / to;
    var outLen = Math.max(1, Math.round(src.length * outPerIn));
    var out = new Float32Array(outLen);

    if (method === 'box' && outPerIn < 1) {
      var box = Math.max(1, Math.round(inPerOut));
      for (var i = 0; i < outLen; i++) {
        var start = Math.floor(i * inPerOut);
        var acc = 0;
        var count = 0;
        for (var w = 0; w < box; w++) {
          var idx = start + w;
          if (idx < 0 || idx >= src.length) continue;
          acc += src[idx];
          count++;
        }
        out[i] = count ? acc / count : 0;
      }
      return out;
    }

    for (var j = 0; j < outLen; j++) {
      var pos = j * inPerOut;
      var i0 = Math.floor(pos);
      var frac = pos - i0;
      var a = i0 >= 0 && i0 < src.length ? src[i0] : 0;
      var b = i0 + 1 < src.length ? src[i0 + 1] : a;
      out[j] = a + (b - a) * frac;
    }
    return out;
  }

  /** gainDb in dB, clamped to [-1, 1] to stay 16-bit clean. Returns copies. */
  function applyGain(channels, gainDb) {
    var db = num(gainDb, NaN);
    if (!isFinite(db)) return mapChannels(channels, function (ch) { return new Float32Array(ch); });
    var factor = Math.pow(10, db / 20);
    return mapChannels(channels, function (ch) {
      var out = new Float32Array(ch.length);
      for (var i = 0; i < ch.length; i++) out[i] = clamp1(ch[i] * factor);
      return out;
    });
  }

  /**
   * Scale every channel by the SAME factor so the loudest peak reaches
   * `targetPeakDb` (default -1 dBFS, the usual "just under full scale").
   * Digital silence is returned untouched: a gain factor is undefined there.
   */
  function normalize(channels, opts) {
    var targetDb = num(opts && opts.targetPeakDb, -1);
    if (!isFinite(targetDb)) targetDb = -1;
    var target = Math.pow(10, clamp(targetDb, DB_FLOOR, 0) / 20);
    var list = asChannels(channels);
    var peak = 0;
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < list[i].length; j++) {
        var v = Math.abs(list[i][j]);
        if (v > peak) peak = v;
      }
    }
    if (!(peak > 0)) return mapChannels(channels, function (ch) { return new Float32Array(ch); });
    var factor = target / peak;
    return mapChannels(channels, function (ch) {
      var out = new Float32Array(ch.length);
      for (var k = 0; k < ch.length; k++) out[k] = clamp1(ch[k] * factor);
      return out;
    });
  }

  /* ===================================================================== *
   * Tempo detection (context-free)
   * ===================================================================== */

  /**
   * detectBeatsPerMinute(channelData, sampleRate, opts)
   *   -> { bpm, confidence, folded, analysedSeconds }
   *
   * Energy-envelope autocorrelation over raw Float32Array PCM.
   *
   * Deliberate differences from the user's v6.0 reference detector:
   *  1. Takes Float32Array PCM rather than an AudioBuffer, so it runs in a
   *     service worker with no Web Audio at all.
   *  2. Naive decimation down to ~4.4 kHz is kept because it is cheap and
   *     matches the reference. It ALIASES: high-frequency energy folds down
   *     and can inflate the envelope. A box or IIR lowpass before decimating
   *     would be more correct but costs a second pass over the samples.
   *  3. The envelope is MEAN-CENTERED and scaled to unit variance before
   *     autocorrelation. That is the fix for the reference's fixed
   *     `maxCorr > 0.003` gate, which silently returned null for any track
   *     quieter than roughly -25 dBFS because raw correlation scaled with
   *     absolute energy. `confidence` is now the normalized autocorrelation
   *     coefficient, i.e. scale-invariant and clamped to [-1, 1] -> [0, 1].
   *  4. Search range is 40-220 BPM (was 60-180), per spec.
   *  5. Folding into a "musical" band is OPT-IN via `tempoRange` and is
   *     always reported as `folded`. The reference silently rewrote 55 BPM
   *     into 110 BPM with no signal to the caller; `analysedSeconds` likewise
   *     reports how much audio the 60 s analysis window actually covered.
   *  6. Frame duration comes from the REAL decimated rate (sampleRate/step),
   *     not a hard-coded 0.05 s. At 48 kHz the reference's step of 10
   *     actually yields 4800 Hz, so its BPM numbers ran 8.8% fast.
   *  7. The winning lag is refined by parabolic interpolation, so the frame
   *     grid no longer quantizes the answer (raw 50 ms grid: 90 BPM -> 92).
   *  8. Harmonic (octave) correction. A periodic envelope correlates just as
   *     well at 2x and 3x its period, and the raw maximum often lands on one
   *     of those multiples: on synthetic click tracks the un-corrected curve
   *     read 128 BPM as 43, 140 as 70 and 160 as 40. The correlation curve is
   *     therefore smoothed, weighted by a prior that decays with lag, and
   *     peak-picked as the SHORTEST lag within `peakRatio` of the best score.
   *     Measured from 40 to 200 BPM that holds the error to about +/-1 BPM.
   *
   *   `confidence` remains the honest quality signal: below ~0.3 the estimate
   *   is a guess, and ambiguous material can still land on an octave.
   *   Callers that need a musical tempo should pass an explicit `tempoRange`
   *   and read `folded`.
   *
   * opts: { minBpm=40, maxBpm=220, frameSeconds=0.025, maxSeconds=60,
   *         envelopeRate=4410, minConfidence=0.08, peakRatio=0.8,
   *         lagPrior=0.5, tempoRange=null, logger }
   * Total: silence or garbage returns { bpm:null, confidence:0, folded:false,
   * analysedSeconds:0 } and never throws.
   */
  function detectBeatsPerMinute(channelData, sampleRate, opts) {
    opts = isObj(opts) ? opts : {};
    var sink = warningTarget(opts);
    var empty = { bpm: null, confidence: 0, folded: false, analysedSeconds: 0 };

    var minBpm = clamp(num(opts.minBpm, LOG_RANGE[0]), 20, 400);
    var maxBpm = clamp(num(opts.maxBpm, LOG_RANGE[1]), minBpm + 1, 600);
    var frameSecRequested = clamp(num(opts.frameSeconds, FRAME_SECONDS), 0.005, 0.5);
    var maxSeconds = clamp(num(opts.maxSeconds, 60), 0.1, 3600);
    var minConfidence = clamp(num(opts.minConfidence, 0.08), 0, 1);
    var peakRatio = clamp(num(opts.peakRatio, 0.8), 0.5, 1);
    var lagPrior = clamp(num(opts.lagPrior, 0.5), 0, 4);

    var tempoRange = null;
    if (Array.isArray(opts.tempoRange) && opts.tempoRange.length === 2) {
      var lo = num(opts.tempoRange[0], NaN);
      var hi = num(opts.tempoRange[1], NaN);
      if (isFinite(lo) && isFinite(hi) && lo > 0 && hi >= lo) tempoRange = [lo, hi];
    }

    var data = toFloat32(channelData);
    var rate = num(sampleRate, NaN);
    if (!data.length || !isFinite(rate) || rate <= 0) {
      warn(opts, sink, 'BPM detection skipped: no usable PCM or sample rate');
      return empty;
    }

    // Hard analysis window (60 s by default). analysedSeconds always reports
    // what actually took part, so truncation is never invisible.
    var analysedSamples = Math.min(data.length, Math.floor(rate * maxSeconds));
    var analysedSeconds = analysedSamples / rate;
    if (analysedSamples < rate * 0.2) {
      warn(opts, sink, 'BPM detection skipped: only ' + analysedSeconds.toFixed(3) + 's of audio');
      return empty;
    }

    var targetEnvRate = clamp(num(opts.envelopeRate, 4410), 200, rate);
    var step = Math.max(1, Math.floor(rate / targetEnvRate));
    var envRate = rate / step;
    var decimatedLength = Math.floor(analysedSamples / step);
    var windowSize = Math.max(4, Math.round(envRate * frameSecRequested));
    var frameCount = Math.floor(decimatedLength / windowSize);
    var frameSec = windowSize / envRate;

    if (frameCount < 8) {
      warn(opts, sink, 'BPM detection skipped: too few ' + (frameSec * 1000).toFixed(0) + 'ms frames');
      return empty;
    }

    // --- energy envelope: decimate, then RMS per frame --------------------
    var energy = new Float32Array(frameCount);
    for (var f = 0; f < frameCount; f++) {
      var acc = 0;
      var start = f * windowSize;
      for (var w = 0; w < windowSize; w++) {
        var idx = (start + w) * step;
        var v = idx < data.length ? data[idx] : 0;
        acc += v * v;
      }
      energy[f] = Math.sqrt(acc / windowSize);
    }

    // --- mean center + unit variance, so the gate is scale invariant ------
    var mean = 0;
    for (var m = 0; m < frameCount; m++) mean += energy[m];
    mean /= frameCount;

    var varianceAcc = 0;
    for (var m2 = 0; m2 < frameCount; m2++) {
      var d = energy[m2] - mean;
      varianceAcc += d * d;
    }
    var variance = varianceAcc / frameCount;

    if (!isFinite(variance) || variance <= 1e-12) {
      // Silence, or a perfectly flat envelope: nothing to autocorrelate.
      return empty;
    }

    var norm = 1 / Math.sqrt(variance);
    var envelope = new Float32Array(frameCount);
    for (var e = 0; e < frameCount; e++) envelope[e] = (energy[e] - mean) * norm;

    // --- autocorrelation over the lags implied by the BPM band -----------
    var minLag = Math.max(1, Math.floor(60 / (maxBpm * frameSec)));
    var maxLag = Math.ceil(60 / (minBpm * frameSec));
    if (maxLag > frameCount - 4) maxLag = frameCount - 4;
    if (maxLag < minLag) {
      warn(opts, sink, 'BPM detection skipped: analysed window is too short for the requested range');
      return empty;
    }

    // Normalized autocorrelation of the unit-variance envelope: the raw curve
    // is scale-invariant, but it still peaks on HARMONICS (2x, 3x the true
    // period) whenever the envelope happens to line up better there. Three
    // cheap corrections, each individually toggleable:
    //   1. a triangular smoothing of the curve, because a period that falls
    //      between two frames splits its energy across both lags and would
    //      otherwise lose to a sharp peak at some multiple;
    //   2. a prior that decays with lag, i.e. a preference for the shortest
    //      period that still correlates well;
    //   3. peak-ratio picking: take the SHORTEST lag within `peakRatio` of the
    //      best score rather than the absolute maximum.
    // Measured on synthetic click tracks from 40 to 200 BPM, this holds the
    // error to about +/-1 BPM; the un-corrected curve misreads 128 as 43,
    // 140 as 70 and 160 as 40.
    var corrAt = new Float64Array(maxLag + 2);
    var shapeAt = new Float64Array(maxLag + 2); // smoothed, no prior
    var scoreAt = new Float64Array(maxLag + 2); // smoothed + lag prior
    var bestLag = 0;
    var bestScore = -Infinity;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var corr = 0;
      var count = frameCount - lag;
      for (var i = 0; i < count; i++) corr += envelope[i] * envelope[i + lag];
      corr /= count; // the envelope is unit-variance, so this IS the coefficient
      corrAt[lag] = corr;
      var left = lag > minLag ? corrAt[lag - 1] : corr;
      var right = lag < maxLag ? corrAt[lag + 1] : corr;
      var smoothed = (left + 2 * corr + right) / 4;
      shapeAt[lag] = smoothed;
      var score = lagPrior > 0 ? smoothed * Math.pow(minLag / lag, lagPrior) : smoothed;
      scoreAt[lag] = score;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    if (bestLag <= 0 || bestScore < minConfidence) {
      return {
        bpm: null,
        confidence: bestLag > 0 && isFinite(corrAt[bestLag]) ? clamp(corrAt[bestLag], 0, 1) : 0,
        folded: false,
        analysedSeconds: analysedSeconds
      };
    }

    var threshold = bestScore * peakRatio;
    var chosenLag = bestLag;
    for (var pick = minLag; pick < bestLag; pick++) {
      if (scoreAt[pick] >= threshold) {
        chosenLag = pick;
        break;
      }
    }

    // Sub-frame refinement. Even a 25 ms frame grid quantizes the tempo, so
    // fit a parabola through the chosen peak and its neighbours to recover a
    // fractional lag. The fit uses the SMOOTHED BUT UN-PRIORED curve: the lag
    // prior tilts a peak's apparent position and would bias every estimate
    // slow by ~0.1 frame (120 BPM came back as 119). It exists to choose WHICH
    // lag, not where it sits. The correction is clamped to +-0.5 frame so a
    // noisy peak can never jump onto its neighbour.
    var lagEstimate = chosenLag;
    if (chosenLag > minLag && chosenLag < maxLag) {
      var y0 = shapeAt[chosenLag - 1];
      var y1 = shapeAt[chosenLag];
      var y2 = shapeAt[chosenLag + 1];
      var denom = y0 - 2 * y1 + y2;
      if (denom !== 0 && isFinite(denom)) {
        var delta = clamp(0.5 * (y0 - y2) / denom, -0.5, 0.5);
        if (isFinite(delta)) lagEstimate = chosenLag + delta;
      }
    }

    var confidence = clamp(corrAt[chosenLag], 0, 1);
    var bpm = 60 / (lagEstimate * frameSec);
    if (!isFinite(bpm) || bpm <= 0) {
      return { bpm: null, confidence: confidence, folded: false, analysedSeconds: analysedSeconds };
    }
    // Lag quantization is coarse at the band edges, so clamp the reported
    // value to the band we actually searched rather than reporting 240 BPM
    // from a 220 BPM request.
    bpm = Math.round(clamp(bpm, minBpm, maxBpm));

    var folded = false;
    if (tempoRange) {
      while (bpm < tempoRange[0]) { bpm *= 2; folded = true; }
      while (bpm > tempoRange[1]) { bpm /= 2; folded = true; }
      bpm = Math.round(bpm);
    }

    return {
      bpm: bpm,
      confidence: Math.round(confidence * 1000) / 1000,
      folded: folded,
      analysedSeconds: Math.round(analysedSeconds * 1000) / 1000
    };
  }

  /** Accepts the legacy AudioBuffer-shaped argument too. */
  function resolveTempoInput(input, sampleRate) {
    if (input && typeof input.getChannelData === 'function') {
      return { data: toFloat32(input.getChannelData(0)), rate: num(input.sampleRate, 0) };
    }
    if (isObj(input) && input.channels !== undefined && input.channels !== null) {
      var list = asChannels(input.channels);
      return { data: list.length ? list[0] : new Float32Array(0), rate: num(input.sampleRate, 0) };
    }
    return { data: toFloat32(input), rate: num(sampleRate, 0) };
  }

  /**
   * detectBPM(input, sampleRate?, opts?) -> number | null
   *
   * Legacy wrapper returning a bare number. Accepts (audioBuffer),
   * (channelData, sampleRate) or (channelData, sampleRate, opts).
   * For backwards compatibility it folds into DEFAULT_TEMPO_RANGE ([70,175])
   * unless you pass `tempoRange: null` explicitly; use
   * detectBeatsPerMinute when you want the un-folded tempo plus the
   * confidence and the analysed window.
   */
  function detectBPM(input, sampleRate, opts) {
    var parsed = resolveTempoInput(input, sampleRate);
    var options = isObj(opts) ? Object.assign({}, opts) : {};
    if (!('tempoRange' in options)) options.tempoRange = DEFAULT_TEMPO_RANGE.slice();
    return detectBeatsPerMinute(parsed.data, parsed.rate, options).bpm;
  }

  /**
   * analyzeAudio({ channels, sampleRate, durationSec, tempoRange, maxSeconds })
   *   -> { peakDb, rmsDb, durationSec, sampleRate, channels, bpm,
   *        bpmConfidence, warnings }
   *
   * Total loudness + tempo summary. Never throws; garbage in gives neutral
   * numbers out plus a warning. dB values are floored at -120 dBFS so
   * digital silence serializes cleanly instead of emitting -Infinity.
   */
  function analyzeAudio(input) {
    var opts = isObj(input) ? input : {};
    var sink = Array.isArray(opts.warnings) ? opts.warnings : [];
    var result = {
      peakDb: DB_FLOOR,
      rmsDb: DB_FLOOR,
      durationSec: 0,
      sampleRate: 0,
      channels: 0,
      bpm: null,
      bpmConfidence: 0,
      warnings: sink
    };
    try {
      var list = asChannels(opts.channels !== undefined ? opts.channels : opts);
      if (!list.length) {
        warn(opts, sink, 'analyzeAudio: no channels to analyze');
        return result;
      }
      list = alignChannels(list, sink);
      var frames = framesOf(list);
      var rate = num(opts.sampleRate, NaN);
      if (!isFinite(rate) || rate <= 0) {
        warn(opts, sink, 'analyzeAudio: invalid sample rate, duration derived as 0');
        rate = 0;
      }

      var peak = 0;
      var squares = 0;
      var counted = 0;
      for (var c = 0; c < list.length; c++) {
        var ch = list[c];
        for (var i = 0; i < ch.length; i++) {
          var v = ch[i];
          var av = Math.abs(v);
          if (av > peak) peak = av;
          if (isFinite(v)) {
            squares += v * v;
            counted++;
          }
        }
      }

      result.channels = list.length;
      result.peakDb = amplitudeToDb(peak);
      result.rmsDb = amplitudeToDb(counted ? Math.sqrt(squares / counted) : 0);
      result.durationSec = rate && frames
        ? Math.round((frames / rate) * 1000) / 1000
        : Math.round(num(opts.durationSec, 0) * 1000) / 1000;
      result.sampleRate = rate ? Math.round(rate) : 0;

      if (rate > 0 && frames > 0) {
        var tempoOpts = {
          warnings: sink,
          logger: typeof opts.logger === 'function' ? opts.logger : undefined
        };
        if (opts.tempoRange !== undefined) tempoOpts.tempoRange = opts.tempoRange;
        if (opts.maxSeconds !== undefined) tempoOpts.maxSeconds = opts.maxSeconds;
        var tempo = detectBeatsPerMinute(list[0], rate, tempoOpts);
        result.bpm = tempo.bpm;
        result.bpmConfidence = tempo.confidence;
      }
    } catch (e) {
      warn(opts, sink, 'analyzeAudio failed: ' + str(e && e.message));
    }
    return result;
  }

  /* ===================================================================== *
   * WAV muxing (context-free)
   * ===================================================================== */

  function normalizeBitDepth(bitDepth) {
    var d = bitDepth === undefined || bitDepth === null ? 16 : num(bitDepth, NaN);
    d = Math.round(d);
    if (SUPPORTED_BIT_DEPTHS.indexOf(d) === -1) {
      throw new SunoAudioError(
        'buildWav: unsupported bit depth ' + str(bitDepth) + ' (expected one of ' +
          SUPPORTED_BIT_DEPTHS.join('/') + ').',
        'INVALID_BIT_DEPTH', { bitDepth: bitDepth, supported: SUPPORTED_BIT_DEPTHS.slice() }
      );
    }
    return d;
  }

  function normalizeFormat(fmt, bitDepth) {
    var code;
    if (typeof fmt === 'number' && isFinite(fmt)) {
      code = fmt | 0;
    } else {
      var f = str(fmt).toLowerCase();
      if (!f || f === 'wav' || f === 'pcm' || f === 'int') code = 1;
      else if (f === 'float' || f === 'ieee' || f === 'ieee_float') code = 3;
    }
    if (code !== 1 && code !== 3) {
      throw new SunoAudioError(
        'buildWav: unsupported WAV format code ' + str(fmt) +
          ' (expected 1/PCM or 3/IEEE_FLOAT).',
        'INVALID_FORMAT', { fmt: fmt }
      );
    }
    if (code === 3 && bitDepth !== 32) {
      throw new SunoAudioError(
        'buildWav: IEEE_FLOAT output requires bitDepth 32 (got ' + bitDepth + ').',
        'INVALID_FORMAT', { fmt: code, bitDepth: bitDepth }
      );
    }
    return code;
  }

  function normalizeSampleRate(sampleRate) {
    var rate = num(sampleRate, NaN);
    if (!isFinite(rate) || rate <= 0 || rate > 384000) {
      throw new SunoAudioError(
        'buildWav: sample rate must be a finite number in (0, 384000] (got ' +
          str(sampleRate) + ').',
        'INVALID_SAMPLE_RATE', { sampleRate: sampleRate }
      );
    }
    return Math.round(rate);
  }

  /**
   * buildWav({ channels, sampleRate, bitDepth = 16, fmt = 'wav',
   *           extraChunks = [] }) -> ArrayBuffer
   *
   * Layout: RIFF <size> WAVE / fmt  (16-byte payload) / data / <extraChunks>
   *
   * `fmt` is 'wav' (PCM, format code 1, integer samples) or 'float'
   * (IEEE_FLOAT, format code 3, requires bitDepth 32). byteRate and blockAlign
   * are always derived from the ACTUAL sample rate and channel count, so a
   * file that says 48 kHz really is 48 kHz. That is the whole point: the old
   * muxer wrote the source rate while the filename claimed `_48k`.
   *
   * `extraChunks` are appended AFTER `data`. That is valid RIFF - the spec
   * constrains nesting inside RIFF, not chunk order - and is what every tagger
   * does; a parser that stops at `data` simply ignores them. Each chunk is
   * word-aligned: an odd-length payload gets a pad byte that is NOT counted in
   * that chunk's size field but IS counted in the RIFF size field.
   * `extraChunks` accepts `{ id:'LIST', bytes }` and `{ id:'id3 ', bytes }` so
   * lib/tagger.js can supply RIFF/INFO and ID3. Those builders are owned by
   * the tagger and are deliberately NOT reimplemented here; this function only
   * consumes their bytes.
   *
   * Throws SunoAudioError for NO_CHANNELS, EMPTY_AUDIO, INVALID_SAMPLE_RATE,
   * INVALID_BIT_DEPTH and INVALID_FORMAT. Mismatched channel lengths are padded
   * with silence and reported in `opts.warnings`.
   */
  function buildWav(opts) {
    opts = isObj(opts) ? opts : {};
    var sink = warningTarget(opts);

    var source = asChannels(opts.channels !== undefined ? opts.channels : opts);
    if (!source.length) {
      throw new SunoAudioError('buildWav: no audio channels were supplied.', 'NO_CHANNELS', {
        received: typeof opts.channels
      });
    }

    var bitDepth = normalizeBitDepth(opts.bitDepth);
    var formatCode = normalizeFormat(opts.fmt, bitDepth);
    var sampleRate = normalizeSampleRate(opts.sampleRate);

    var channels = alignChannels(source, sink);
    var frames = framesOf(channels);
    if (!frames) {
      throw new SunoAudioError(
        'buildWav: channels contain 0 frames; refusing to emit a silent 44-byte WAV.',
        'EMPTY_AUDIO', { channelCount: channels.length }
      );
    }

    var numChannels = channels.length;
    var bytesPerSample = bitDepth / 8;
    var blockAlign = numChannels * bytesPerSample;
    var byteRate = sampleRate * blockAlign;
    var dataSize = frames * blockAlign;

    var extras = normalizeExtraChunks(opts.extraChunks, sink);
    var extrasSize = 0;
    for (var e = 0; e < extras.length; e++) extrasSize += 8 + extras[e].bytes.length + extras[e].pad;

    var totalSize = 12 + 24 + 8 + dataSize + extrasSize;
    var buffer = new ArrayBuffer(totalSize);
    var view = new DataView(buffer);
    var bytes = new Uint8Array(buffer);

    // --- RIFF header ------------------------------------------------------
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true); // everything that follows this field
    writeAscii(view, 8, 'WAVE');

    // --- fmt  (16-byte payload: PCM 1.0 / IEEE float 3.0) -----------------
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, formatCode, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    // --- data -------------------------------------------------------------
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Samples go straight into the output buffer, so a 4-minute stereo track
    // never materialises a second full-size interleaved Float32Array. The
    // loops are channel-outer with the channel reference hoisted and the
    // clamp inlined: that keeps a 3-minute stereo render around a second
    // instead of several, which matters when a batch downloader runs this in
    // the service worker.
    var stepBytes = blockAlign;
    if (formatCode === 1 && bitDepth === 16) {
      for (var c = 0; c < numChannels; c++) {
        var ch = channels[c];
        var o = 44 + c * 2;
        for (var i = 0; i < frames; i++) {
          var v = ch[i];
          if (v >= 1) v = 1; else if (v <= -1) v = -1; else if (v !== v) v = 0;
          // `| 0` truncates toward zero and wraps to int32, which is exactly
          // what DataView#setInt16 does internally; writing the two bytes by
          // hand is several times faster than one call per sample.
          var s = (v < 0 ? v * 0x8000 : v * 0x7FFF) | 0;
          bytes[o] = s & 0xFF;
          bytes[o + 1] = (s >> 8) & 0xFF;
          o += stepBytes;
        }
      }
    } else if (formatCode === 1 && bitDepth === 8) {
      for (var c8 = 0; c8 < numChannels; c8++) {
        var ch8 = channels[c8];
        var o8 = 44 + c8;
        for (var i8 = 0; i8 < frames; i8++) {
          var v8 = ch8[i8];
          if (v8 >= 1) v8 = 1; else if (v8 <= -1) v8 = -1; else if (v8 !== v8) v8 = 0;
          bytes[o8] = ((v8 * 127) | 0) + 128;
          o8 += stepBytes;
        }
      }
    } else if (formatCode === 1 && bitDepth === 24) {
      for (var c24 = 0; c24 < numChannels; c24++) {
        var ch24 = channels[c24];
        var o24 = 44 + c24 * 3;
        for (var i24 = 0; i24 < frames; i24++) {
          var v24 = ch24[i24];
          if (v24 >= 1) v24 = 1; else if (v24 <= -1) v24 = -1; else if (v24 !== v24) v24 = 0;
          var s24 = (v24 < 0 ? v24 * 0x800000 : v24 * 0x7FFFFF) | 0;
          bytes[o24] = s24 & 0xFF;
          bytes[o24 + 1] = (s24 >> 8) & 0xFF;
          bytes[o24 + 2] = (s24 >> 16) & 0xFF;
          o24 += stepBytes;
        }
      }
    } else if (formatCode === 1) {
      for (var c32 = 0; c32 < numChannels; c32++) {
        var ch32 = channels[c32];
        var o32 = 44 + c32 * 4;
        for (var i32 = 0; i32 < frames; i32++) {
          var v32 = ch32[i32];
          if (v32 >= 1) v32 = 1; else if (v32 <= -1) v32 = -1; else if (v32 !== v32) v32 = 0;
          var s32 = (v32 < 0 ? v32 * 0x80000000 : v32 * 0x7FFFFFFF) | 0;
          bytes[o32] = s32 & 0xFF;
          bytes[o32 + 1] = (s32 >> 8) & 0xFF;
          bytes[o32 + 2] = (s32 >> 16) & 0xFF;
          bytes[o32 + 3] = (s32 >>> 24) & 0xFF;
          o32 += stepBytes;
        }
      }
    } else {
      // IEEE float: a Float32Array view over the same buffer is the fastest
      // correct way to write float32 LE (the host is little-endian in every
      // browser this extension targets, and typed arrays follow the platform).
      var f32 = new Float32Array(buffer);
      var f32Step = blockAlign / 4;
      for (var cf = 0; cf < numChannels; cf++) {
        var chf = channels[cf];
        var of = 11 + cf; // 44 bytes / 4
        for (var ifl = 0; ifl < frames; ifl++) {
          var vf = chf[ifl];
          if (vf >= 1) vf = 1; else if (vf <= -1) vf = -1; else if (vf !== vf) vf = 0;
          f32[of] = vf;
          of += f32Step;
        }
      }
    }

    // --- extra chunks, each word-aligned ----------------------------------
    var offset = 44 + dataSize;
    for (var ci = 0; ci < extras.length; ci++) {
      var chunk = extras[ci];
      writeAscii(view, offset, chunk.id);
      view.setUint32(offset + 4, chunk.bytes.length, true);
      bytes.set(chunk.bytes, offset + 8);
      offset += 8 + chunk.bytes.length;
      if (chunk.pad) {
        bytes[offset] = 0;
        offset += 1;
      }
    }

    if (offset !== totalSize) {
      // Unreachable in practice, but a silent size mismatch would emit a
      // truncated file, so make it loud instead.
      throw new SunoAudioError(
        'buildWav: internal size mismatch (wrote ' + offset + ' of ' + totalSize + ' bytes).',
        'INVALID_FORMAT', { wrote: offset, expected: totalSize }
      );
    }

    return buffer;
  }

  /** ArrayBuffer / TypedArray / Blob -> Blob('audio/wav'). Needs Blob. */
  function wavBlob(bytes) {
    if (typeof Blob !== 'function') {
      throw new SunoAudioError(
        'wavBlob: the Blob constructor is unavailable in this context.',
        'NO_BLOB', { received: typeof bytes }
      );
    }
    if (bytes instanceof Blob) return bytes;
    if (isTypedArray(bytes)) {
      return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], {
        type: 'audio/wav'
      });
    }
    return new Blob([bytes], { type: 'audio/wav' });
  }

  /**
   * '48k' / '44k1' / '22050' - filename tag helper. Use this with the sample
   * rate buildWav actually reported instead of hardcoding `_48k`. Non-integer
   * kHz values use the '44k1' form so the result is always filename-safe
   * (no dot).
   */
  function rateTag(sampleRate) {
    var rate = num(sampleRate, NaN);
    if (!isFinite(rate) || rate <= 0) return 'unknown';
    rate = Math.round(rate);
    if (rate % 1000 === 0) return Math.round(rate / 1000) + 'k';
    if (rate % 100 === 0) return Math.floor(rate / 1000) + 'k' + ((rate % 1000) / 100);
    return String(rate);
  }

  /* ===================================================================== *
   * Web Audio layer (NOT service-worker safe)
   * ===================================================================== */

  function noAudioContextError(where) {
    return new SunoAudioError(
      where + ' needs a Web Audio implementation and there is none in this context. ' +
        'An MV3 service worker has no AudioContext or OfflineAudioContext: decode inside the ' +
        "offscreen document (chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', " +
        "reasons: ['AUDIO_PLAYBACK'] })), call SunoAudio.decodeToPcm there, then pass the PCM " +
        'back to the SW-safe half (detectBeatsPerMinute / buildWav). From a DOM page, inject ' +
        '{ AudioContextCtor: OfflineAudioContext } (preferred) or { AudioContextCtor: AudioContext }.',
      'NO_AUDIO_CONTEXT',
      { where: where, globals: typeof AudioContext }
    );
  }

  /**
   * Accepts a constructor, or an object exposing OfflineAudioContext /
   * AudioContext. Falls back to the injected instance setting, then to the DOM
   * globals. Returns { bare, offline, online, source } or null.
   */
  function resolveContextCtor(opts) {
    var candidates = [];
    if (opts && opts.AudioContextCtor) candidates.push(opts.AudioContextCtor);
    if (opts && isObj(opts.AudioContext) && opts.AudioContextCtor === undefined) {
      candidates.push(opts.AudioContext);
    }
    if (SunoAudio.audioContextCtor) candidates.push(SunoAudio.audioContextCtor);

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c) continue;
      if (typeof c === 'function') {
        // A bare constructor may be either flavour; that is decided when the
        // candidate list is built.
        return { bare: c, offline: null, online: null, source: 'injected' };
      }
      if (isObj(c)) {
        var offline = typeof c.OfflineAudioContext === 'function' ? c.OfflineAudioContext
          : typeof c.webkitOfflineAudioContext === 'function' ? c.webkitOfflineAudioContext
            : null;
        var online = typeof c.AudioContext === 'function' ? c.AudioContext
          : typeof c.webkitAudioContext === 'function' ? c.webkitAudioContext
            : null;
        if (offline || online) return { bare: null, offline: offline, online: online, source: 'injected' };
      }
    }

    var globalOffline = typeof OfflineAudioContext === 'function' ? OfflineAudioContext
      : typeof webkitOfflineAudioContext === 'function' ? webkitOfflineAudioContext
        : null;
    var globalOnline = typeof AudioContext === 'function' ? AudioContext
      : typeof webkitAudioContext === 'function' ? webkitAudioContext
        : null;
    if (globalOffline || globalOnline) {
      return { bare: null, offline: globalOffline, online: globalOnline, source: 'global' };
    }
    return null;
  }

  function contextCandidates(resolved, targetRate) {
    var out = [];
    if (resolved.offline) {
      out.push({
        name: 'OfflineAudioContext',
        make: function () {
          // The length argument is irrelevant for decodeAudioData, but Chrome
          // DOES resample the decoded result to the context rate - which is
          // exactly the rate the caller asked for.
          return new resolved.offline(1, 1, targetRate);
        }
      });
    }
    if (resolved.online) {
      out.push({ name: 'AudioContext', make: function () { return new resolved.online(); } });
    }
    if (resolved.bare) {
      out.push({
        name: 'injected(offline-signature)',
        make: function () { return new resolved.bare(1, 1, targetRate); }
      });
      out.push({
        name: 'injected(online-signature)',
        make: function () { return new resolved.bare(); }
      });
    }
    return out;
  }

  /**
   * `instanceof ArrayBuffer` fails across realms (a buffer created in another
   * window, an iframe, or a worker), so also accept the brand check. Cheap
   * insurance: the alternative is a confusing INVALID_SOURCE from a perfectly
   * good buffer.
   */
  function isArrayBufferLike(v) {
    if (!v || typeof v !== 'object') return false;
    if (v instanceof ArrayBuffer) return true;
    try {
      return Object.prototype.toString.call(v) === '[object ArrayBuffer]' ||
        Object.prototype.toString.call(v) === '[object SharedArrayBuffer]';
    } catch (e) {
      currentLogger('[SunoAudio] could not brand-check an ArrayBuffer:', e && e.message);
      return false;
    }
  }

  async function toArrayBuffer(source) {
    if (isArrayBufferLike(source)) return source;
    // ArrayBuffer.isView is cross-realm safe and covers typed arrays + DataView.
    if (ArrayBuffer.isView(source)) {
      return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    }
    if (source && typeof source.arrayBuffer === 'function') return await source.arrayBuffer();
    if (typeof source === 'string') {
      try {
        var binary = atob(source);
        var out = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out.buffer;
      } catch (e) {
        throw new SunoAudioError(
          'decodeToPcm: the input string is not valid base64.',
          'INVALID_SOURCE', null
        );
      }
    }
    throw new SunoAudioError(
      'decodeToPcm: expected an ArrayBuffer, TypedArray, Blob, AudioBuffer or base64 string.',
      'INVALID_SOURCE', { received: typeof source }
    );
  }

  function decodeWithAbort(ctx, copy, signal) {
    var pending;
    try {
      pending = ctx.decodeAudioData(copy);
    } catch (e) {
      return Promise.reject(new SunoAudioError(
        'decodeToPcm: decodeAudioData threw synchronously: ' + str(e && e.message),
        'DECODE_ERROR', { cause: str(e && e.message) }
      ));
    }
    if (!signal) return Promise.resolve(pending);

    return new Promise(function (resolve, reject) {
      var settled = false;

      function onAbort() {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new SunoAudioError('decodeToPcm: aborted by caller.', 'ABORTED', null));
      }

      function cleanup() {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch (e) {
          currentLogger('[SunoAudio] could not remove the abort listener:', e && e.message);
        }
      }

      if (signal.aborted) return onAbort();
      try {
        signal.addEventListener('abort', onAbort, { once: true });
      } catch (e) {
        currentLogger('[SunoAudio] abort listener unavailable:', e && e.message);
      }

      Promise.resolve(pending).then(function (value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }, function (err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
    });
  }

  async function closeQuiet(ctx, log) {
    if (!ctx || typeof ctx.close !== 'function') return;
    try {
      await ctx.close();
    } catch (e) {
      log('[SunoAudio] closing the audio context failed (ignored):', e && e.message);
    }
  }

  /**
   * Normalize a decoded AudioBuffer-like OR a plain { channels, sampleRate }
   * PCM object into { channels, sampleRate, durationSec }. Channel data is
   * copied, because the source may be an AudioBuffer belonging to a context
   * that is about to be closed. `fallbackRate` is used only when the source
   * carries no usable rate; pass 0 to require one.
   */
  function extractPcm(decoded, fallbackRate) {
    var channels;
    var rate = NaN;
    if (isObj(decoded) && typeof decoded.getChannelData === 'function') {
      channels = asChannels(decoded);
      rate = num(decoded.sampleRate, NaN);
    } else if (isObj(decoded) && decoded.channels !== undefined) {
      channels = asChannels(decoded.channels);
      rate = num(decoded.sampleRate, NaN);
    } else {
      channels = asChannels(decoded);
    }
    if (!isFinite(rate) || rate <= 0) rate = num(fallbackRate, NaN);
    if (!isFinite(rate) || rate <= 0) {
      return { channels: channels, sampleRate: 0, durationSec: 0 };
    }
    rate = Math.round(rate);
    var frames = framesOf(channels);
    return {
      channels: channels,
      sampleRate: rate,
      durationSec: frames ? Math.round((frames / rate) * 1000) / 1000 : 0
    };
  }

  /**
   * decodeToPcm(arrayBuffer, { AudioContextCtor, sampleRate, signal, logger })
   *   -> { channels: Float32Array[], sampleRate, durationSec }
   *
   * Web Audio REQUIRED. Not callable from an MV3 service worker without an
   * injected constructor from the offscreen document (see the header).
   *
   * `OfflineAudioContext` is preferred: no audio hardware, cannot glitch on a
   * busy device, cheaper. `sampleRate` is the decode/output rate, i.e. exactly
   * the rate that ends up in the WAV header - default 48000. Pass the rate you
   * actually want rather than letting a filename claim something else. If an
   * offline context yields a zero-length buffer we fall back to `AudioContext`.
   *
   * The context is always closed in a `finally`, including on abort and on
   * decode failure.
   *
   * Throws SunoAudioError: NO_AUDIO_CONTEXT, ABORTED, DECODE_ERROR,
   * INVALID_SOURCE.
   */
  async function decodeToPcm(source, opts) {
    opts = isObj(opts) ? opts : {};
    var log = loggerOf(opts);
    var sink = warningTarget(opts);

    var resolved = resolveContextCtor(opts);
    if (!resolved) throw noAudioContextError('decodeToPcm');

    var requestedRate = num(opts.sampleRate, NaN);
    if (!isFinite(requestedRate) || requestedRate <= 0 || requestedRate > 384000) requestedRate = 48000;

    var bytes = await toArrayBuffer(source);
    if (!bytes || !bytes.byteLength) {
      throw new SunoAudioError(
        'decodeToPcm: input was empty.',
        'INVALID_SOURCE', { byteLength: bytes ? bytes.byteLength : 0 }
      );
    }
    if (opts.signal && opts.signal.aborted) {
      throw new SunoAudioError('decodeToPcm: aborted before decoding.', 'ABORTED', null);
    }

    var candidates = contextCandidates(resolved, Math.round(requestedRate));
    var lastError = null;

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var ctx = null;
      try {
        ctx = candidate.make();
        // decodeAudioData detaches its input, so every attempt gets a copy.
        var decoded = await decodeWithAbort(ctx, bytes.slice(0), opts.signal);
        if (!decoded || !decoded.length) {
          lastError = new SunoAudioError(
            'decodeToPcm: ' + candidate.name + ' returned a zero-length buffer.',
            'DECODE_ERROR', { context: candidate.name, source: resolved.source }
          );
          log('[SunoAudio] ' + lastError.message);
          continue;
        }
        var pcm = extractPcm(decoded, Math.round(requestedRate));
        if (!pcm.channels.length) {
          lastError = new SunoAudioError(
            'decodeToPcm: ' + candidate.name + ' produced no channel data.',
            'DECODE_ERROR', { context: candidate.name }
          );
          continue;
        }
        return pcm;
      } catch (e) {
        if (isAudioError(e) && (e.code === 'ABORTED' || e.code === 'NO_AUDIO_CONTEXT')) throw e;
        lastError = new SunoAudioError(
          'decodeToPcm: ' + candidate.name + ' failed to decode: ' + str(e && e.message),
          'DECODE_ERROR',
          { context: candidate.name, source: resolved.source, cause: str(e && e.message) }
        );
        log('[SunoAudio] ' + lastError.message);
      } finally {
        await closeQuiet(ctx, log);
      }
    }

    if (!lastError) {
      lastError = new SunoAudioError('decodeToPcm: no usable audio context.', 'DECODE_ERROR', {
        source: resolved.source
      });
    }
    warn(opts, sink, lastError.message);
    throw lastError;
  }

  /**
   * renderToWav(pcm, opts) -> { bytes: ArrayBuffer, sampleRate, bitDepth }
   *
   * `opts.sampleRate` is a genuine conversion target: when it differs from the
   * PCM rate every channel is really resampled (`opts.resampleMethod`,
   * default 'linear') and the returned `sampleRate` is the rate actually
   * written into the header. `opts.gainDb` and `opts.normalize` are applied
   * before muxing. SW-safe.
   */
  function renderToWav(pcm, opts) {
    opts = isObj(opts) ? opts : {};
    var sink = warningTarget(opts);
    var source = isObj(pcm) && pcm.channels !== undefined ? pcm.channels : pcm;

    var channels = alignChannels(asChannels(source), sink);
    if (!channels.length) {
      throw new SunoAudioError('renderToWav: no channels to render.', 'NO_CHANNELS', null);
    }
    if (!framesOf(channels)) {
      throw new SunoAudioError('renderToWav: channel data is empty (0 frames).', 'EMPTY_AUDIO', {
        channelCount: channels.length
      });
    }

    var rate = normalizeSampleRate(isObj(pcm) ? pcm.sampleRate : NaN);

    var target = num(opts.sampleRate, NaN);
    if (isFinite(target) && target > 0 && Math.round(target) !== rate) {
      var method = str(opts.resampleMethod).toLowerCase() || 'linear';
      var to = Math.round(clamp(target, 1, 384000));
      var converted = new Array(channels.length);
      for (var i = 0; i < channels.length; i++) {
        converted[i] = resample(channels[i], rate, to, { method: method });
      }
      channels = converted;
      warn(opts, sink, 'resampled ' + rate + ' Hz -> ' + to + ' Hz (' + method + ')');
      rate = to;
    }

    if (isFinite(num(opts.gainDb, NaN))) channels = asChannels(applyGain(channels, opts.gainDb));
    if (opts.normalize) {
      channels = asChannels(normalize(channels, isObj(opts.normalize) ? opts.normalize : {}));
    }

    var bitDepth = normalizeBitDepth(opts.bitDepth);
    var bytes = buildWav({
      channels: channels,
      sampleRate: rate,
      bitDepth: bitDepth,
      fmt: opts.fmt,
      extraChunks: opts.extraChunks,
      warnings: sink
    });

    return { bytes: bytes, sampleRate: rate, bitDepth: bitDepth };
  }

  /* ===================================================================== *
   * Metadata adapter + legacy entry points
   * ===================================================================== */

  /**
   * toTagMeta(clip) -> a flat, verified record for lib/tagger.js.
   *
   * This module owns no tag CONTENT; it only maps a clip onto a field
   * contract, and that mapping is where two long-standing bugs are fixed:
   *
   *  - `display_name` / `handle` / `user_id` live on the CLIP and identify the
   *    OWNER (the signed-in user); SunoFilter.normalize renames them to
   *    ownerName / ownerHandle / ownerId precisely so nobody mistakes them for
   *    artist credits. The old code looked for them under `metadata`, where
   *    they do not exist, so every export was tagged "Suno Artist". Read them
   *    from `owner*` here. When a clip genuinely has no owner, the field is
   *    left EMPTY so the tagger can apply its own fallback, rather than this
   *    file inventing a name.
   *
   *  - There is NO `genre` field on a clip. `metadata.tags` (normalized to
   *    `tags`) is the free-text style/genre field and `metadata.style`
   *    (normalized to `style`) is its companion. Both are surfaced, and the
   *    output field is called genreText so nothing implies a `genre` source.
   */
  function toTagMeta(clip) {
    var meta = isObj(clip) ? clip : {};
    var raw = isObj(meta.metadata) ? meta.metadata : {};
    var owner = isObj(meta.owner) ? meta.owner : {};
    return {
      id: str(meta.id),
      title: str(meta.title),
      // OWNER identity, never a clip-level artist credit.
      artist: str(meta.ownerName || owner.display_name || meta.ownerHandle || owner.handle),
      artistHandle: str(meta.ownerHandle || owner.handle),
      ownerId: str(meta.ownerId || owner.user_id || owner.id),
      // Style/genre free text. No `genre` field exists on a clip.
      genreText: str(meta.tags || raw.tags),
      styleText: str(meta.style || raw.style),
      prompt: str(meta.prompt || raw.prompt),
      lyrics: str(meta.lyrics || raw.lyrics),
      model: str(meta.modelVersion || meta.major_model_version || meta.modelName),
      modelLabel: str(meta.modelLabel),
      createdIso: str(meta.createdIso || meta.created_at),
      durationSec: num(meta.durationSec, 0),
      isInstrumental: meta.isInstrumental === true
    };
  }

  /**
   * Find the tagger's chunk builders without hard-depending on load order.
   * lib/tagger.js owns buildRiffInfoChunk / buildId3Chunk; this file only
   * consumes the bytes they produce.
   *
   * Checked on globalThis, self and window: in an MV3 service worker
   * `window` does not exist, so a tagger that registers only on `window`
   * would be invisible here and every export would silently lose its tags
   * (loudly, via a warning). Callers who already hold the bytes should pass
   * them in `extraChunks` instead of relying on discovery.
   */
  function findTagger() {
    var scopes = [];
    if (typeof globalThis !== 'undefined') scopes.push(globalThis);
    if (typeof self !== 'undefined') scopes.push(self);
    if (typeof window !== 'undefined') scopes.push(window);
    for (var i = 0; i < scopes.length; i++) {
      var tagger = scopes[i] && scopes[i].SunoTagger;
      if (tagger && typeof tagger.buildRiffInfoChunk === 'function') return tagger;
    }
    return null;
  }

  /**
   * Normalize one chunk-builder result into the PAYLOAD buildWav should wrap.
   *
   * lib/tagger.js's buildRiffInfoChunk() and buildId3Chunk() each return a
   * COMPLETE RIFF chunk (4-byte id, u32 size, payload) because they must be
   * self-describing for their own tests. buildWav writes the id and size
   * itself, so handing it a whole chunk produced `LIST( LIST( INFO... ) )` -
   * a reader looking for `INFO` inside the LIST finds `LIST` and silently
   * drops every tag. So: if the bytes really are a self-consistent chunk with
   * the expected id, strip the 8-byte header; otherwise assume they are
   * already a bare payload and use them as-is.
   *
   * The pad byte is dropped here too and re-added by buildWav, so alignment
   * stays correct.
   */
  function toChunkPayload(bytes, expectedId, sink) {
    if (!bytes || !bytes.length) return null;
    var u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
      : isTypedArray(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
        : null;
    if (!u8) return null;
    if (u8.length < 8) return u8;

    var view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var id = '';
    for (var i = 0; i < 4; i++) id += String.fromCharCode(view.getUint8(i));
    if (id !== expectedId) return u8;

    var size = view.getUint32(4, true);
    if (size < 0 || 8 + size + (size & 1) !== u8.length) return u8; // not self-consistent

    pushWarning(sink, 'stripped the 8-byte header from the tagger\'s ' + expectedId + ' chunk before muxing');
    return u8.subarray(8, 8 + size);
  }

  /**
   * Resolve the RIFF extra chunks for an export.
   *
   * Precedence: explicit bytes win (that is how lib/tagger.js supplies
   * LIST/INFO and 'id3 ' chunks). Only when nothing was supplied AND a clip
   * was passed do we ask the tagger to build them. When the tagger is absent
   * the file is written untagged with a warning, which is strictly better
   * than stamping a wrong artist on every track.
   */
  function resolveChunks(provided, meta, opts, sink) {
    var chunks = normalizeExtraChunks(provided, sink);
    if (chunks.length || !meta) return chunks;

    var tagger = findTagger();
    if (!tagger) {
      warn(opts, sink, 'metadata was supplied but lib/tagger.js is not loaded, so the WAV is written untagged');
      return chunks;
    }
    try {
      var tagMeta = toTagMeta(meta);
      var info = typeof tagger.buildRiffInfoChunk === 'function' ? tagger.buildRiffInfoChunk(tagMeta) : null;
      var id3 = typeof tagger.buildId3Chunk === 'function' ? tagger.buildId3Chunk(tagMeta) : null;
      var wanted = [
        { id: 'LIST', bytes: toChunkPayload(info, 'LIST', sink) },
        { id: 'id3 ', bytes: toChunkPayload(id3, 'id3 ', sink) }
      ];
      var usable = [];
      for (var i = 0; i < wanted.length; i++) {
        if (wanted[i].bytes && wanted[i].bytes.length) usable.push(wanted[i]);
      }
      chunks = normalizeExtraChunks(usable, sink);
    } catch (e) {
      warn(opts, sink, 'tag chunk generation failed: ' + str(e && e.message));
    }
    return chunks;
  }

  /**
   * audioBufferToWavBlob(decodedBuffer, meta, id3ChunkBytes, opts) -> Blob
   *
   * Legacy entry point, unchanged contract (it returns a Blob). Accepts an
   * AudioBuffer-like object ({ numberOfChannels, getChannelData, sampleRate })
   * OR plain { channels, sampleRate } PCM.
   *
   * `id3ChunkBytes` accepts a Uint8Array/ArrayBuffer (wrapped as an 'id3 '
   * chunk), an array of `{ id, bytes }`, or `{ extraChunks, id3ChunkBytes }`.
   * If you pass `meta` but no chunk bytes, the bytes come from lib/tagger.js
   * via `globalThis.SunoTagger`.
   *
   * opts: { bitDepth, fmt, sampleRate, gainDb, normalize, extraChunks }
   * Use processAndCreateWav when you also need the real output sample rate.
   */
  function audioBufferToWavBlob(decodedBuffer, meta, id3ChunkBytes, opts) {
    opts = isObj(opts) ? opts : {};
    var sink = warningTarget(opts);
    var pcm = extractPcm(decodedBuffer, 0);

    if (!pcm.channels.length) {
      throw new SunoAudioError(
        'audioBufferToWavBlob: nothing to write (0 frames).',
        'EMPTY_AUDIO', { channelCount: num(decodedBuffer && decodedBuffer.numberOfChannels, 0) | 0 }
      );
    }
    if (!pcm.sampleRate) {
      throw new SunoAudioError(
        'audioBufferToWavBlob: the source sample rate is unknown, so no valid WAV header can be written.',
        'INVALID_SAMPLE_RATE', null
      );
    }

    var chunks = resolveChunks(
      opts.extraChunks !== undefined ? opts.extraChunks : id3ChunkBytes,
      meta, opts, sink
    );

    var wav = renderToWav(
      { channels: pcm.channels, sampleRate: pcm.sampleRate, durationSec: pcm.durationSec },
      {
        bitDepth: opts.bitDepth,
        fmt: opts.fmt,
        sampleRate: opts.sampleRate,
        gainDb: opts.gainDb,
        normalize: opts.normalize,
        extraChunks: chunks,
        warnings: sink
      }
    );
    return wavBlob(wav.bytes);
  }

  /**
   * processAndCreateWav(source, meta, opts)
   *   -> { blob, sampleRate, sampleRateLabel, bitDepth, bpm, bpmConfidence,
   *        bpmFolded, duration, durationSec, warnings }
   *
   * Legacy name, new behaviour. Decoding needs Web Audio (pass
   * `{ AudioContextCtor }` from the offscreen document, or run it on a page);
   * everything after decoding is SW-safe.
   *
   * `sampleRate` is the rate the bytes ACTUALLY carry and `sampleRateLabel` is
   * the honest filename tag, so callers stop hardcoding `_48k`. `opts.sampleRate`
   * requests a real conversion (default: whatever the decoder produced, which
   * is the decode target rate, 48 kHz unless overridden).
   *
   * opts: {
   *   AudioContextCtor, sampleRate (output target), decodeSampleRate,
   *   bitDepth = 16, fmt, gainDb, normalize, extraChunks, id3ChunkBytes,
   *   tempoRange (default null -> no silent folding), bpmMaxSeconds = 60,
   *   signal, logger, warnings
   * }
   */
  async function processAndCreateWav(source, meta, opts) {
    opts = isObj(opts) ? opts : {};
    var sink = warningTarget(opts);
    var log = loggerOf(opts);

    var decodeOpts = {
      AudioContextCtor: opts.AudioContextCtor,
      AudioContext: opts.AudioContext,
      signal: opts.signal,
      logger: log,
      warnings: sink
    };
    if (opts.decodeSampleRate !== undefined) decodeOpts.sampleRate = opts.decodeSampleRate;
    else if (opts.sampleRate !== undefined) decodeOpts.sampleRate = opts.sampleRate;

    var pcm = await decodeToPcm(source, decodeOpts);

    var tempo = detectBeatsPerMinute(pcm.channels[0], pcm.sampleRate, {
      logger: log,
      warnings: sink,
      tempoRange: opts.tempoRange === undefined ? null : opts.tempoRange,
      maxSeconds: num(opts.bpmMaxSeconds, 60)
    });
    if (tempo.bpm !== null && tempo.folded) {
      warn(opts, sink, 'tempo folded into ' + JSON.stringify(opts.tempoRange) + ': ' + tempo.bpm + ' BPM');
    }

    var chunks = resolveChunks(
      opts.extraChunks !== undefined ? opts.extraChunks : opts.id3ChunkBytes,
      meta, opts, sink
    );

    var wav = renderToWav(pcm, {
      bitDepth: opts.bitDepth,
      fmt: opts.fmt,
      sampleRate: opts.sampleRate,
      resampleMethod: opts.resampleMethod,
      gainDb: opts.gainDb,
      normalize: opts.normalize,
      extraChunks: chunks,
      warnings: sink
    });

    return {
      blob: wavBlob(wav.bytes),
      sampleRate: wav.sampleRate,
      sampleRateLabel: rateTag(wav.sampleRate),
      bitDepth: wav.bitDepth,
      bpm: tempo.bpm,
      bpmConfidence: tempo.confidence,
      bpmFolded: tempo.folded,
      duration: pcm.durationSec,
      durationSec: pcm.durationSec,
      warnings: sink
    };
  }

  /* ===================================================================== *
   * Module assembly: SunoAudio class, statics, and the singleton instance
   * ===================================================================== */

  function SunoAudio() {
    /** Legacy lazy context cache. Only usable on a DOM page. */
    this.audioCtx = null;
  }

  SunoAudio.prototype.getAudioContext = function () {
    if (this.audioCtx && this.audioCtx.state !== 'closed') return this.audioCtx;
    var resolved = resolveContextCtor({});
    if (!resolved || !(resolved.online || resolved.bare)) {
      this.audioCtx = null;
      return null;
    }
    try {
      this.audioCtx = resolved.online ? new resolved.online() : new resolved.bare();
    } catch (e) {
      currentLogger('[SunoAudio] could not create an AudioContext:', e && e.message);
      this.audioCtx = null;
    }
    return this.audioCtx;
  };

  SunoAudio.prototype.closeAudioContext = async function () {
    var ctx = this.audioCtx;
    this.audioCtx = null;
    await closeQuiet(ctx, currentLogger);
  };

  // ---- statics: the SW-safe half --------------------------------------
  SunoAudio.version = VERSION;
  SunoAudio.DEFAULT_TEMPO_RANGE = DEFAULT_TEMPO_RANGE;
  SunoAudio.LOG_RANGE = LOG_RANGE;
  SunoAudio.SUPPORTED_BIT_DEPTHS = SUPPORTED_BIT_DEPTHS;
  SunoAudio.SunoAudioError = SunoAudioError;
  SunoAudio.isNoAudioContext = SunoAudioError.isNoAudioContext;
  SunoAudio.isDecodeError = SunoAudioError.isDecodeError;

  SunoAudio.floatTo8BitPcm = floatTo8BitPcm;
  SunoAudio.floatTo16BitPcm = floatTo16BitPcm;
  SunoAudio.floatTo24BitPcm = floatTo24BitPcm;
  SunoAudio.floatTo32BitPcm = floatTo32BitPcm;
  SunoAudio.interleave = interleave;
  SunoAudio.deinterleave = deinterleave;
  SunoAudio.toMono = toMono;
  SunoAudio.resample = resample;
  SunoAudio.applyGain = applyGain;
  SunoAudio.normalize = normalize;
  SunoAudio.detectBeatsPerMinute = detectBeatsPerMinute;
  SunoAudio.detectBPM = detectBPM;
  SunoAudio.analyzeAudio = analyzeAudio;
  SunoAudio.buildWav = buildWav;
  SunoAudio.wavBlob = wavBlob;
  SunoAudio.renderToWav = renderToWav;
  SunoAudio.rateTag = rateTag;
  SunoAudio.toTagMeta = toTagMeta;
  SunoAudio.audioBufferToWavBlob = audioBufferToWavBlob;
  SunoAudio.processAndCreateWav = processAndCreateWav;

  // ---- statics: the Web Audio half ------------------------------------
  SunoAudio.decodeToPcm = decodeToPcm;
  SunoAudio.resolveContextCtor = resolveContextCtor;

  /**
   * Last-resort AudioContext constructor used when a call site does not pass
   * one. Exposed as an accessor on both the class and the exported instance,
   * so `setAudioContextCtor(...)` is immediately visible either way.
   */
  Object.defineProperty(SunoAudio, 'audioContextCtor', {
    get: function () { return injectedContextCtor; },
    set: function (ctor) { injectedContextCtor = ctor || null; },
    enumerable: true,
    configurable: true
  });

  SunoAudio.setAudioContextCtor = function (ctor) {
    injectedContextCtor = ctor || null;
  };

  // ---- diagnostics -----------------------------------------------------
  SunoAudio.setLogger = function (fn) {
    currentLogger = typeof fn === 'function' ? fn : NOOP;
  };
  SunoAudio.getLogger = function () {
    return currentLogger;
  };
  SunoAudio.getWarnings = function () {
    return warningSink.slice();
  };
  SunoAudio.takeWarnings = function () {
    return warningSink.splice(0, warningSink.length);
  };
  SunoAudio.clearWarnings = function () {
    warningSink.length = 0;
  };

  /**
   * The exported object: an instance (so `SunoHelper.audio.processAndCreateWav`
   * keeps working) that also carries every static, plus the class itself for
   * `new SunoAudio.SunoAudio()`.
   */
  function finishModule() {
    var instance = new SunoAudio();

    Object.getOwnPropertyNames(SunoAudio).forEach(function (key) {
      if (key === 'prototype' || key === 'length' || key === 'name' || key === 'caller' ||
        key === 'arguments') return;
      var descriptor = Object.getOwnPropertyDescriptor(SunoAudio, key);
      if (!descriptor) return;
      try {
        Object.defineProperty(instance, key, descriptor);
      } catch (e) {
        currentLogger('[SunoAudio] could not expose static "' + key + '":', e && e.message);
      }
    });

    // `logger` is a live view onto the injected logger, in both directions.
    try {
      Object.defineProperty(instance, 'logger', {
        get: function () { return currentLogger; },
        set: function (fn) { currentLogger = typeof fn === 'function' ? fn : NOOP; },
        enumerable: true,
        configurable: true
      });
    } catch (e) {
      currentLogger('[SunoAudio] could not expose the logger property:', e && e.message);
    }

    instance.SunoAudio = SunoAudio;
    instance.instance = instance;
    instance.default = instance;
    return instance;
  }

  return finishModule();
});
