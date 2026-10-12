/**
 * 7. OFFSCREEN — the document that supplies what a service worker lacks.
 *
 * Extracted verbatim from `background/background.js` section 7. For the
 * mechanism (why the worker may call these as bare globals, why nothing here
 * is rebound at load time) read `background/parts/15-quota.js` first.
 *
 * VERIFIED BY REFERENCE COUNT BEFORE THE CUT, not assumed:
 *   - 21 declarations, 8 read from outside the section (`callOffscreen` and
 *     the bytes/bytesToBase64/mime/blob-URL/transcode helpers plus
 *     `resolveOffscreenReply`), and EVERY outside reference is a call-time
 *     read inside a function body — a mechanical scan found zero top-level
 *     references from the monolith or sibling parts.
 *   - The section's own top-level code is declaration-only and its const
 *     initialisers are builtins (`new Map()`, `new Set()`, a regex literal),
 *     so it cannot read a monolith `const` (TDZ'd while parts load).
 *   - `offscreenWaiters` / `offscreenResults` / `offscreenSequence` are
 *     section-local; nothing outside writes them.
 *   - Outbound calls (`broadcast`, `log`, `describeError`, `chrome.*`,
 *     `STORAGE_KEYS.*`) all resolve at call time.
 */

/* ==========================================================================
 * 7. OFFSCREEN DOCUMENT
 *
 * A worker has no `URL.createObjectURL` and no Web Audio. The offscreen
 * document is a DOM page that supplies both. Protocol: WE send
 * `{target:'offscreen', type, id, ...}`; the offscreen page replies with its own
 * `chrome.runtime.sendMessage`, which lands back on OUR `onMessage`.
 * ======================================================================== */

/** @type {Map<string,{resolve:Function,reject:Function}>} id -> pending request. */
const offscreenWaiters = new Map();
/** @type {Map<string,object>} id -> settled reply, so the caller can read it. */
const offscreenResults = new Map();
let offscreenSequence = 0;
/**
 * The offscreen wire protocol, mirrored from offscreen/offscreen.js `PROTOCOL`.
 * An inbound message is only treated as an offscreen reply when it declares this
 * exact string, which is what stops a guessed id from settling a waiter.
 */
const OFFSCREEN_PROTOCOL = 'suno-offscreen/1';
/**
 * The only page allowed to author an offscreen reply. Cross-checked against
 * `sender.url` when the runtime supplies one.
 */
const OFFSCREEN_PAGE_RE = /^chrome-extension:\/\/[^/]+\/offscreen\/offscreen\.html$/;
/** Grace period after a payload-truncated broadcast before failing fast. */
const OFFSCREEN_TRUNCATED_GRACE_MS = 5000;

/**
 * Create the offscreen document if it does not exist, then prove it is alive.
 *
 * `createDocument` THROWS if the document already exists, so `hasDocument()` is
 * mandatory. `AUDIO_PLAYBACK` covers decoding; `BLOBS` covers `createObjectURL`,
 * which this worker needs for any buffer over the data-URL threshold.
 *
 * The liveness ping matters: a document that exists but whose Web Audio failed
 * to initialise will answer `sunoPing` with `audio:false`, and discovering that
 * at the first 24 MB buffer is far worse than finding out now.
 *
 * @returns {Promise<boolean>} false when the offscreen path is unavailable
 */
async function ensureOffscreenDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
    log('warn', 'offscreen.api_unavailable', { hint: 'manifest needs the "offscreen" permission' });
    return false;
  }
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
        justification: 'Decode audio (Web Audio) and mint blob URLs, neither of which exists in an MV3 service worker.',
      });
      log('info', 'offscreen.created', { url: 'offscreen/offscreen.html' });
    }
  } catch (createErr) {
    log('error', 'offscreen.create_failed', { error: describeError(createErr) });
    return false;
  }
  try {
    const ping = await callOffscreen('sunoPing', {}, 5000, { skipEnsure: true });
    log('info', 'offscreen.ping', {
      ready: ping.ready === true,
      audio: ping.audio === true,
      encoder: ping.encoder || null,
      blobs: ping.blobs,
    });
  } catch (pingErr) {
    log('warn', 'offscreen.ping_failed', { error: describeError(pingErr) });
  }
  return true;
}

/**
 * Send one request to the offscreen document and await its reply.
 *
 * CONTRACT (offscreen/offscreen.js, protocol `suno-offscreen/1`):
 *   - Request: `{target:'offscreen', type, id, ...payload}`. MV3 runtime
 *     messaging is JSON-serialised, so an ArrayBuffer or typed array sent
 *     through it arrives as `{}`; BYTES TRAVEL AS A BASE64 STRING.
 *   - The offscreen page replies on BOTH channels: `sendResponse` (structured
 *     clone, so `Float32Array` PCM and the WAV bytes survive) AND a broadcast
 *     `{type:'<type>:result', id, ok, ...}`. The broadcast is JSON, so any byte
 *     payload in it is replaced by `{byteLength, payloadTruncated:true}`.
 *   - Therefore: an id-keyed registry, first channel to answer wins, and a
 *     broadcast is IGNORED when it declares `payloadTruncated` because it cannot
 *     satisfy a byte-carrying request.
 *
 * @param {string} type e.g. 'sunoBlobUrl'
 * @param {object} payload
 * @param {number} [timeoutMs]
 * @param {{skipEnsure?:boolean}} [internal]
 *   `skipEnsure` exists for ONE caller: the `sunoPing` liveness probe. Without
 *   it, `ensureOffscreenDocument` -> `callOffscreen` -> `ensureOffscreenDocument`
 *   is unbounded mutual recursion and the worker dies on its first big buffer.
 * @returns {Promise<object>} the offscreen result object
 */
async function callOffscreen(type, payload, timeoutMs, internal) {
  if (!(internal && internal.skipEnsure)) {
    const ready = await ensureOffscreenDocument();
    if (!ready) throw new OpError('offscreen_unavailable', 'The offscreen document is unavailable.');
  }
  offscreenSequence += 1;
  const id = 'os' + offscreenSequence + '-' + Date.now().toString(36);
  const budget = timeoutMs || 120_000;

  let settleOnce;
  const waiter = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offscreenWaiters.delete(id);
      reject(new OpError('offscreen_timeout', `offscreen "${type}" did not answer within ${budget}ms`));
    }, budget);
    // Second, much shorter budget. Armed only when a payload-truncated
    // broadcast proves the byte-bearing `sendResponse` never arrived: without
    // it the caller would sit for the full two minutes on an answer that can
    // never come. The offscreen sends both channels microseconds apart, so a
    // 5s grace cannot race a healthy reply.
    let graceTimer = null;
    let done = false;
    settleOnce = {
      get settled() { return done; },
      /** Note a truncated broadcast: arm the short fuse, but do not settle. */
      noteTruncated() {
        if (done || graceTimer !== null) return;
        graceTimer = setTimeout(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          offscreenWaiters.delete(id);
          reject(new OpError('offscreen_truncated',
            `offscreen "${type}" answered only on the JSON broadcast, which cannot carry bytes. `
            + 'The byte-bearing sendResponse never arrived.'));
        }, OFFSCREEN_TRUNCATED_GRACE_MS);
      },
      resolve(value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (graceTimer !== null) clearTimeout(graceTimer);
        offscreenWaiters.delete(id);
        resolve(value);
      },
      reject(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (graceTimer !== null) clearTimeout(graceTimer);
        offscreenWaiters.delete(id);
        reject(err);
      },
    };
  });
  offscreenWaiters.set(id, settleOnce);

  let response;
  try {
    response = await chrome.runtime.sendMessage(
      Object.assign({ target: 'offscreen', type, id, timeoutMs: budget }, payload || {})
    );
  } catch (sendErr) {
    const message = `could not reach the offscreen document: ${describeError(sendErr).message}`;
    settleOnce.reject(new OpError('offscreen_send_failed', message));
    throw new OpError('offscreen_send_failed', message);
  }

  // Preferred channel: the direct, structured-cloned response.
  if (response && response.id === id && typeof response.ok === 'boolean') {
    settleOnce.resolve(response);
  } else {
    // Fallback: the offscreen page's own broadcast, if the registry is still open.
    await waiter;
  }

  const reply = offscreenResults.get(id) || response;
  if (!reply) throw new OpError('offscreen_no_reply', `offscreen "${type}" produced no reply`);
  if (reply.ok === false) {
    const code = String(reply.code || 'offscreen_error');
    const err = new OpError(
      OFFSCREEN_FATAL_CODES.has(code) ? code : 'offscreen_error',
      String(reply.detail || reply.message || code)
    );
    // `ENCODER_UNAVAILABLE` is a permanent load/integrity gap, not a transient
    // fault: the vendored encoder either defined its global or it did not, and
    // retrying produces the identical answer forever.
    err.offscreenCode = code;
    err.retryable = false;
    throw err;
  }
  return reply;
}

/**
 * Offscreen failures that must never be retried.
 * @type {Set<string>}
 */
const OFFSCREEN_FATAL_CODES = new Set([
  'ENCODER_UNAVAILABLE',
  'AUDIO_LIB_MISSING',
  'NO_AUDIO_CONTEXT',
  'DOCUMENT_CLOSING',
  'UNKNOWN_TYPE',
  'DUPLICATE_ID',
]);

/**
 * Is this inbound message the offscreen document's answer to one of our
 * requests?
 *
 * WHY THIS CHECK IS LOAD-BEARING. `resolveOffscreenReply` used to match on
 * `/:result$/` alone and it runs BEFORE `validateSender`, so it was reached by
 * any message that could arrive on the runtime channel. The request id is
 * `'os' + sequence + '-' + Date.now().toString(36)'` — a small, entirely
 * enumerable space — so anything able to post a message could guess an in-flight
 * id and settle its waiter with an attacker-chosen payload. The worst case is
 * `sunoBlobUrl`: the forged `url` is handed straight to
 * `chrome.downloads.download`.
 *
 * The offscreen document stamps EVERY reply it sends, on both channels, with
 * (offscreen.js `finish`/`onMessage`, protocol `suno-offscreen/1`):
 *   `from:'offscreen'`, `protocol:'suno-offscreen/1'`, `type:'<type>:result'`,
 *   `id`, `elapsedMs`, `stats`, plus the payload's own `ok`.
 * All of those discriminators are required, so a guessed id alone is worthless.
 *
 * `@param {object} message
 * @param {chrome.runtime.MessageSender} [sender]
 * @returns {boolean} true when this is a well-formed offscreen reply envelope
 */
function isOffscreenReply(message, sender) {
  if (!message || typeof message !== 'object') return false;
  if (message.from !== 'offscreen') return false;
  if (message.protocol !== OFFSCREEN_PROTOCOL) return false;
  if (typeof message.type !== 'string' || !/:result$/.test(message.type)) return false;
  // The type must agree with the shape of the id we mint: the offscreen builds
  // `type` as `entry.type + ':result'` for the id it received, and every
  // request type it accepts is `suno<Name>`.
  if (!/^suno[A-Za-z]+:result$/.test(message.type)) return false;
  if (typeof message.id !== 'string' || !/^os\d+-[a-z0-9]+$/.test(message.id)) return false;
  // Belt and braces: the body claims to be the offscreen document, so the
  // sender had better BE it. `sender.url` is compared only when present — the
  // envelope checks above are the primary gate, and making this one mandatory
  // would turn a Chrome-side reporting change into "every download times out".
  const senderUrl = sender && typeof sender.url === 'string' ? sender.url : '';
  if (senderUrl && !OFFSCREEN_PAGE_RE.test(senderUrl)) return false;
  return true;
}

/**
 * Route an offscreen broadcast to its pending request.
 *
 * The broadcast is JSON-serialised, so a reply that carried bytes arrives here
 * as `{byteLength, payloadTruncated:true}`. Such a reply is DROPPED unless the
 * registry has already been settled by `sendResponse`: handing a truncated
 * descriptor to a caller expecting WAV bytes would produce a corrupt file.
 *
 * A message that is not an offscreen reply envelope (see `isOffscreenReply`)
 * NEVER reaches the registry, not even to be remembered. It is still logged, so
 * a protocol change on either side is visible in diagnostics instead of showing
 * up as an unrelated timeout.
 *
 * @param {object} message the `<type>:result` envelope
 * @param {chrome.runtime.MessageSender} [sender]
 * @returns {boolean} true when it matched a pending request
 */
function resolveOffscreenReply(message, sender) {
  if (!isOffscreenReply(message, sender)) {
    log('debug', 'offscreen.reply_rejected', {
      type: message && typeof message.type === 'string' ? message.type.slice(0, 60) : typeof message,
      from: message && typeof message.from === 'string' ? message.from.slice(0, 30) : null,
      protocol: message && typeof message.protocol === 'string' ? message.protocol.slice(0, 40) : null,
    });
    return false;
  }
  const id = message.id;
  const waiter = offscreenWaiters.get(id);
  if (!waiter) {
    // Unknown id: still remember it briefly so a late broadcast cannot be
    // mistaken for the answer to a LATER request.
    if (id) {
      offscreenResults.set(id, message);
      trimOffscreenResults();
    }
    return false;
  }
  if (message.payloadTruncated === true && !waiter.settled) {
    // Not an answer, but decisive evidence that the byte-bearing sendResponse is
    // not coming. Arm the short fuse rather than waiting out the full budget.
    log('debug', 'offscreen.truncated_broadcast', { id, type: message.type });
    if (typeof waiter.noteTruncated === 'function') waiter.noteTruncated();
    return true;
  }
  offscreenResults.set(id, message);
  waiter.resolve(message);
  return true;
}

/**
 * Keep the settled-reply map from growing without bound.
 * @returns {void}
 */
function trimOffscreenResults() {
  while (offscreenResults.size > 32) {
    const oldest = offscreenResults.keys().next();
    if (oldest.done) break;
    offscreenResults.delete(oldest.value);
  }
}

/**
 * Revoke blob URLs minted for large buffers.
 *
 * The offscreen document keeps an LRU of 8. A batch of 20 tracks would silently
 * evict live URLs mid-transfer, so the URL is revoked as soon as the browser
 * reports the download complete — the exact moment the bytes are on disk and the
 * URL has no further reader.
 *
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
async function revokeBlobUrls(urls) {
  const list = (urls || []).filter((url) => typeof url === 'string' && url.indexOf('blob:') === 0);
  if (!list.length) return;
  try {
    await callOffscreen('sunoBlobRevoke', { urls: list }, 5000);
    log('debug', 'offscreen.blob_revoked', { count: list.length });
  } catch (revokeErr) {
    // The LRU will reap them anyway; a failed revoke is not worth surfacing.
    log('debug', 'offscreen.revoke_failed', { error: describeError(revokeErr) });
  }
}

/**
 * Turn any byte-ish value into a Uint8Array.
 * @param {ArrayBuffer|Uint8Array|Blob|string} input
 * @returns {Promise<Uint8Array>}
 */
async function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== 'undefined' && input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  if (typeof input === 'string') {
    const binary = atob(input);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new OpError('bad_bytes', 'value is not a byte container');
}

/**
 * Base64-encode bytes in chunks; `String.fromCharCode(...bytes)` blows the
 * argument limit on anything over a few hundred kilobytes.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * MIME type for a variant/extension.
 * @param {string} variant
 * @returns {string}
 */
function mimeForVariant(variant) {
  const map = {
    mp3: 'audio/mpeg',
    'mp3-320': 'audio/mpeg',
    m4a: 'audio/x-m4a',
    mp4: 'audio/mp4',
    wav: 'audio/wav',
    'wav-48k': 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    opus: 'audio/ogg; codecs=opus',
  };
  return map[String(variant || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * Ask the offscreen document for a blob URL for large buffers.
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {Promise<string>} a blob: URL
 */
async function offscreenBlobUrl(bytes, mime) {
  const result = await callOffscreen('sunoBlobUrl', {
    bytes: bytesToBase64(bytes),
    encoding: 'base64',
    byteLength: bytes.length,
    mime,
  });
  const url = result && result.url;
  if (typeof url !== 'string' || !url) {
    throw new OpError('offscreen_no_url', 'the offscreen document returned no blob URL');
  }
  return url;
}

/**
 * Measure tempo with the offscreen document.
 *
 * `lib/audio.js`'s `detectBeatsPerMinute` is SW-safe, but it needs decoded PCM
 * and the worker has no `AudioContext` to produce it, so the decode has to
 * happen in the offscreen page. Used only when the clip carries no usable `bpm`
 * of its own and `tagOptions.bpm` is on: an honest measurement beats a tag that
 * silently claims the clip's value, and an absent value beats a fabricated one.
 *
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {Promise<number|null>} a measured BPM, or null when unavailable
 */
async function detectBpmViaOffscreen(bytes, mime) {
  try {
    const result = await callOffscreen('sunoAnalyze', {
      audio: bytesToBase64(bytes),
      encoding: 'base64',
      byteLength: bytes.length,
      mime,
      detectBpm: true,
    }, 120_000);
    // DEPTH: offscreen.js `handleAnalyze` replies `ok({analysis: plain, ...})`,
    // so the tempo lives at `reply.analysis.bpm`, NOT `reply.bpm`. The old
    // read used the shallow path, `Number(undefined)` was NaN, and this
    // function returned null on EVERY clip.
    const analysis = result && typeof result.analysis === 'object' && result.analysis ? result.analysis : null;
    if (!analysis) {
      // A `sunoAnalyze` reply always carries `analysis`. Its absence means a
      // stale offscreen document (protocol skew) rather than "no tempo", so it
      // is worth a warning: the measurement path is broken, not the audio.
      log('warn', 'tags.bpm_reply_malformed', {
        hasReply: !!result,
        keys: result ? Object.keys(result).slice(0, 12) : [],
      });
      return null;
    }
    const bpm = numOr(analysis.bpm);
    if (bpm > 0) {
      log('info', 'tags.bpm_detected', {
        bpm: Math.round(bpm * 100) / 100,
        confidence: numOr(analysis.bpmConfidence),
      });
      return bpm;
    }
    log('debug', 'tags.bpm_undetectable', {
      confidence: numOr(analysis.bpmConfidence),
      durationSec: numOr(analysis.durationSec),
    });
    return null;
  } catch (err) {
    log('debug', 'tags.bpm_unavailable', { error: describeError(err) });
    return null;
  }
}

/**
 * The sample rate the WAV rung must actually write into the header.
 *
 * WHY THIS IS NOT JUST `settings.wavSampleRate`: `wav` and `wav-48k` are two
 * rungs of `VARIANTS`, so they have to be distinguishable. Reading the rate
 * from a global setting made both rungs identical the moment a user moved that
 * setting off 48000, which is exactly the kind of quiet lie this file exists to
 * avoid. `wav-48k` pins its own 48 kHz target; plain `wav` follows the setting.
 *
 * @param {string} variant the requested variant
 * @param {Settings} settings
 * @returns {number} a rate the offscreen `sunoRenderWav` will accept (0, 384000]
 */
function wavRateForVariant(variant, settings) {
  const canonical = resolveVariant(variant, DEFAULT_VARIANT);
  if (canonical === 'wav-48k') return WAV_48K_RATE;
  return clampNumber(settings.wavSampleRate, 8000, 192000, DEFAULT_SETTINGS.wavSampleRate);
}

/**
 * Convert the fetched bytes to another container using the offscreen document.
 *
 * The worker has no Web Audio, so EVERY conversion goes through the offscreen
 * page. Two different messages, because they are not interchangeable:
 *   - `sunoRenderWav` decodes and writes a real WAV header in one hop. This is
 *     the path that makes "48 kHz WAV" honest: the reported `sampleRate` is the
 *     rate actually written into the header, and it comes from
 *     `wavRateForVariant`, so it is per-variant rather than global.
 *   - `sunoTranscode` is the mp3 / ogg ENCODER, backed by the encoders vendored
 *     in `vendor/` (lamejs 1.2.1 and higuma/ogg-vorbis-encoder-js), which the
 *     offscreen document loads from `chrome-extension://` URLs. `wav` never
 *     reaches it: the `mode === 'wav'` branch below is handled by
 *     `sunoRenderWav`. M4A/Opus need no transcode at all, because the source
 *     stream already IS one.
 *
 * WHAT A TRANSCODE COSTS THE USER — verified, not assumed. This function runs
 * AFTER `SunoDRM.decryptClipBuffer` has already returned the audio bytes, and
 * its only I/O is `callOffscreen`, which posts a runtime message to the
 * offscreen document. It performs NO network request of its own and touches no
 * rung, so it cannot spend the monthly allowance:
 *   - Costs: wall-clock CPU (a full decode then re-encode, roughly 1-2x the
 *     track's duration for mp3 and rather more for ogg at high quality) and
 *     peak memory for the decoded PCM plus the encoded output — both held in
 *     the offscreen document, not the worker. Every rung this is called from is
 *     already unmetered (`progressive` / `mango-drm`), so M4A sources save no
 *     quota by transcoding; nothing is gained there.
 *   - Saves: a file that plays everywhere. M4A/AAC is awkward on some players
 *     and hardware; MP3 is near-universal and Ogg is the smaller of the two at
 *     comparable quality. That is the entire trade: CPU and RAM for
 *     compatibility.
 * It is also strictly best-effort: every failure path returns null, so the
 * original bytes are saved unchanged rather than the download being lost.
 *
 * @param {Uint8Array} bytes the original audio
 * @param {string} mime its container
 * @param {Settings} settings
 * @param {AbortSignal} [signal]
 * @param {number} [bpm] the clip's own tempo, forwarded so the export never invents one
 * @param {string} [variant] the requested variant, which decides the WAV rate
 * @returns {Promise<{bytes:Uint8Array, format:'wav'|'mp3'|'ogg', sampleRate:number, warnings:string[]}|null>}
 *   null means "leave the original alone": off, unavailable, or failed
 */
async function maybeTranscode(bytes, mime, settings, signal, bpm, variant) {
  const mode = String(settings.transcode || 'none').toLowerCase();
  if (mode === 'none') return null;
  if (!SunoTagger && mode !== 'none') {
    log('warn', 'transcode.tagger_missing', { mode });
  }
  const wavRate = wavRateForVariant(variant || settings.variant, settings);
  const encoded = bytesToBase64(bytes);
  const common = { audio: encoded, encoding: 'base64', byteLength: bytes.length, mime };

  try {
    if (mode === 'wav') {
      const result = await callOffscreen('sunoRenderWav', Object.assign({}, common, {
        sampleRate: wavRate,
        bitDepth: 16,
        // `bpm` is reported, never invented; `detectBpm` is NOT set, because a
        // 48 kHz re-render is not the moment to silently decide a tempo.
        bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : undefined,
      }), 180_000);
      if (!result || !result.ok || !result.bytes) {
        log('warn', 'transcode.no_wav_bytes', { detail: result && result.detail });
        return null;
      }
      const out = await toBytes(result.bytes);
      log('info', 'transcode.wav_done', { bytes: out.length, sampleRate: result.sampleRate, bitDepth: result.bitDepth, requestedRate: wavRate });
      return { bytes: out, format: 'wav', sampleRate: result.sampleRate || settings.wavSampleRate, warnings: result.warnings || [] };
    }

    if (mode === 'mp3' || mode === 'ogg') {
      // Re-resolved here even though `coerceSettings` already snapped both
      // values, so a caller that hands over a hand-built `settings` object (a
      // `START_BATCH` payload, a test) cannot push a NaN or an unsupported
      // bitrate into `lamejs.Mp3Encoder`. Same settings object, no second fetch.
      const bitrate = snapToChoice(settings.mp3Bitrate, MP3_BITRATES, DEFAULT_SETTINGS.mp3Bitrate);
      const quality = snapToChoice(settings.oggQuality, OGG_QUALITIES, DEFAULT_SETTINGS.oggQuality);
      const result = await callOffscreen('sunoTranscode', Object.assign({}, common, {
        format: mode,
        // Both are sent on every call, not just the relevant one: the offscreen
        // handler ignores the field that does not match `format`, and one
        // payload shape is easier to reason about than two.
        bitrate,
        quality,
      }), 180_000);
      if (!result || !result.ok || !result.bytes) {
        log('warn', 'transcode.no_bytes', { detail: result && result.detail });
        return null;
      }
      const out = await toBytes(result.bytes);
      log('info', 'transcode.encoded', { format: mode, bytes: out.length, sampleRate: result.sampleRate, bitrate, quality });
      return { bytes: out, format: mode, sampleRate: result.sampleRate || 0, warnings: result.warnings || [] };
    }
  } catch (err) {
    const info = describeError(err);
    if (info.code === 'ENCODER_UNAVAILABLE') {
      // Still a real outcome: `offscreen.js` raises it when a `vendor/` script
      // failed to load or defined the wrong global, so a damaged or half-declared
      // install reports this instead of silently saving an M4A. Permanent for
      // the document that reported it, so retrying is pointless — `OFFSCREEN_
      // FATAL_CODES` makes the batch treat it as non-retryable too. Recorded so
      // GET_DIAGNOSTICS shows exactly which capability is missing.
      log('warn', 'transcode.encoder_unavailable', { mode, detail: info.message });
      broadcastTranscodeNotice(mode, info.message);
      return null;
    }
    log('warn', 'transcode.failed', { mode, error: info });
  }
  void signal;
  return null;
}

/**
 * Tell the UI that a requested conversion could not be performed. Used when the
 * offscreen document reports `ENCODER_UNAVAILABLE`, i.e. a `vendor/` encoder
 * failed to load or defined the wrong global. Uses an existing push type rather
 * than inventing one the content script does not listen for, so it cannot be
 * silently dropped.
 * @param {string} mode
 * @param {string} detail
 * @returns {void}
 */
function broadcastTranscodeNotice(mode, detail) {
  void broadcast({
    type: 'DL_ERROR',
    error: `Cannot convert to ${mode}: ${detail}. The original file was saved unchanged.`,
  });
}


/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see 15-quota.js.
 * `scripts/check-build.sh` asserts these names do not collide with a
 * monolith declaration.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUOffscreen = {
    ensureOffscreenDocument, callOffscreen, resolveOffscreenReply,
    offscreenBlobUrl, maybeTranscode, detectBpmViaOffscreen,
    mimeForVariant, toBytes, bytesToBase64, revokeBlobUrls,
  };
}
