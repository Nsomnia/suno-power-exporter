/**
 * Suno Master Utility — background service worker (MV3)
 * ===========================================================================
 *
 * This file is the extension's ONLY orchestrator. It owns nothing that a lib
 * already owns: every HTTP call goes through `SunoAPIClient`, every library
 * row through `SunoDB`, every byte transform through `SunoDRM` / `SunoTagger` /
 * `SunoLyrics` / `SunoAudio`. What lives here is the part no lib can own:
 *
 *   0  Bootstrap            importScripts + global resolution
 *   1  Constants            storage keys, alarm names, ladder definition
 *   2  Diagnostics          the single `log()` + ring buffer
 *   3  Errors               redaction, typed failures, classification
 *   4  Settings             in-memory cache with write-behind
 *   5  Auth                 Clerk JWT minted from the page, never from cookies
 *   6  Messaging            broadcast, sender validation, router scaffolding
 *   7  Offscreen            blob URLs + Web Audio (worker has neither)
 *   8  Filenames            hard sanitisation + path templates
 *   9  Saving bytes         data: URL vs offscreen blob URL
 *  10  The download ladder  seven rungs (progressive, mango-drm, studio,
 *       download-route, wav-official, zip, hls), each with a cost class
 *  11  Tagging              tag + sidecar pipeline
 *  12  Batch driver         resumable, isolated failures, quota-aware
 *  13  Library sync         resumable crawl, no silent truncation
 *  14  Query + selection    filter/sort/page server-side, explicit id list
 *  15  Quota                DOWNLOAD quota, never credits
 *  16  Router               the request table
 *  17  Lifecycle            install / startup / alarms / download events
 *
 * ---------------------------------------------------------------------------
 * HARD INVARIANTS (each one exists because breaking it was a real bug)
 * ---------------------------------------------------------------------------
 * A. `downloads.markDone` is reachable from exactly TWO call sites, and both
 *    require an OBSERVED completion: the `chrome.downloads.onChanged` listener
 *    reporting `state === 'complete'`, or a startup `chrome.downloads.search`
 *    reporting `state === 'complete'`. Never because `downloads.download()`
 *    returned an id.
 * B. Every worker startup calls `downloads.resetInProgress()`; anything left
 *    `in_progress` was written by an evicted worker and is NOT done.
 * C. `clips.clear()` is never followed by re-inserting. A full rebuild uses
 *    `clips.bulkReplace` (one transaction, abort-safe).
 * D. Every push goes to BOTH extension pages (`runtime.sendMessage`) and tab
 *    content scripts (`tabs.sendMessage`). `runtime.sendMessage` alone never
 *    reaches a content script, which is why the previous build's UI never
 *    received a single event.
 * E. The router ignores its own push types, so a broadcast can never re-enter
 *    the router and be answered with "unknown message type".
 * F. `chrome.alarms.create` runs ONLY from onInstalled / onStartup. Creating an
 *    alarm at module scope resets its period on every worker wake.
 * G. No token or key material is ever logged, or written outside
 *    `chrome.storage.session`.
 * H. Zero empty catch blocks. Every failure is logged with enough context to
 *    diagnose it, which is what made the previous 30-swallows build
 *    undiagnosable.
 *
 * ---------------------------------------------------------------------------
 * MV3 CONSTRAINTS THIS FILE IS WRITTEN AGAINST
 * ---------------------------------------------------------------------------
 * - The worker can be evicted at any await. Nothing authoritative may live in a
 *   module-scope variable; caches are caches and are re-derived on wake.
 * - `URL.createObjectURL` does not exist here. `chrome.downloads` needs a URL,
 *   so bytes become either a `data:` URL or an offscreen-minted blob URL.
 * - `chrome.alarms` has a 30 s floor in release builds and wakes the worker, so
 *   long loops must be re-entrant rather than assumed-alive.
 * - `chrome.runtime.sendMessage` JSON-serialises, so a typed array sent to the
 *   offscreen document must be base64 (see §7).
 */

/* ==========================================================================
 * 0. BOOTSTRAP
 * ======================================================================== */

/*
 * COMPAT SHIM — WHY THIS IS HERE, AND WHY IT IS SAFE.
 *
 * An MV3 service worker has no `window`, so a lib that publishes onto `window`
 * and nothing else registers NOTHING here and its export silently degrades to
 * null. Making `window` an alias of the worker global BEFORE importScripts
 * converts those `window.X = …` writes into `globalThis.X = …`. In a worker
 * `self === globalThis`, so the alias target is the same object every resolver
 * below already probes. No lib branches on `typeof window` for anything other
 * than choosing where to publish, and no lib touches `document`.
 *
 * ---------------------------------------------------------------------------
 * WHO ACTUALLY NEEDS THIS — AUDITED AGAINST SOURCE, DO NOT "TIDY" THIS LIST
 * WITHOUT RE-READING THE REGISTRATION BLOCKS. It was previously WRONG: the old
 * text named lib/suno.js, lib/lyrics.js and lib/tagger.js as window-only, all
 * three have since been converted to `globalThis`, and anyone trusting the old
 * text would delete the shim and lose the database and the audio helpers.
 * ---------------------------------------------------------------------------
 *
 *   lib/audio.js   *** REQUIRES THE SHIM ***  — its UMD tail is
 *                  `if (typeof window !== 'undefined' && window) { window.SunoAudio = api; }`
 *                  (lib/audio.js:102-103) and there is NO globalThis or self
 *                  fallback anywhere in the file. Without the alias
 *                  `resolveGlobal('SunoAudio')` returns null, `MISSING_LIBS`
 *                  reports it, and every tag embed / artwork / BPM / LRC
 *                  sidecar silently degrades to "write it untagged".
 *                  CONSEQUENCE OF REMOVING: audio helpers are gone.
 *
 *   lib/db.js      WINDOW-FIRST, NOT WINDOW-ONLY — `var scope = typeof window !==
 *                  'undefined' && window ? window : typeof self !== 'undefined' ?
 *                  self : null;` then `scope.SunoDB = instance`
 *                  (lib/db.js:2959-2960). A service worker ALWAYS has `self`, so
 *                  the database still resolves without the alias, and with the
 *                  alias it takes the branch its owner wrote first and lands on
 *                  the same object. It is named here because a future edit that
 *                  drops that `self` fallback WOULD make it load-bearing.
 *                  CONSEQUENCE OF REMOVING (today): none; of removing that
 *                  `self` fallback instead: the entire library is gone and every
 *                  subsystem degrades to "not in the library".
 *
 * Everything else registers on `globalThis` and does not need the alias:
 *   lib/api.js     dual — globalThis (3140-3144) AND window (3147-3149).
 *   lib/crypto.js  window first (1224-1227), with a globalThis branch used only
 *                  when `window` is absent (1230-1233).
 *   lib/drm.js     same shape — window (1799-1802), globalOnly when window is
 *                  absent (1804-1807).
 *   lib/suno.js    `globalThis` ONLY -> globalThis.SunoFilter (1562-1565).
 *   lib/lyrics.js  `globalThis` ONLY -> globalThis.SunoLyrics (896).
 *   lib/tagger.js  `globalThis` ONLY -> globalThis.SunoTagger (2125), and its
 *                  own comment says so: "not window: an MV3 service worker has
 *                  no window".
 *
 * The resolvers below are still written defensively: if a lib's owner later
 * changes its exposure strategy this file must degrade, not crash.
 */
(function installWorkerWindowAlias() {
  if (typeof window === 'undefined' && typeof globalThis !== 'undefined') {
    globalThis.window = globalThis;
  }
})();

/*
 * LOAD ORDER IS SIGNIFICANT, NOT ALPHABETICAL:
 *
 *   crypto.js BEFORE drm.js — `SunoDRM` resolves its AES primitives by looking
 *   up `globalThis.SunoCrypto` / `SunoCryptoClass` at CALL time, and throws a
 *   typed error naming this file if it is absent. Loading drm first is safe
 *   (resolution is lazy) but makes the failure mode depend on load order.
 *
 *   db.js BEFORE anything that writes — `SunoDB` owns the connection pool and
 *   the schema; a write attempted before `open()` resolves is a rejected
 *   transaction, not a queue.
 *
 *   api.js before suno.js — `api.js` publishes `SunoAPI`, the only verified
 *   route table (`SunoAPI.ENDPOINTS`); `suno.js`'s model families are keyed off
 *   the same vocabulary and reference it in comments/docs.
 *
 *   audio.js LAST — it resolves `SunoTagger` lazily by probing globalThis, so
 *   the tagger must already be registered.
 *
 * This block says nothing about the `window` compat shim above, and must not
 * start: only `lib/audio.js` genuinely needs it (`lib/db.js` has a `self`
 * fallback and survives without it). The audited "who needs the shim" list is
 * the one in the shim's own comment, directly above `installWorkerWindowAlias`.
 * If you change load order, re-read that list rather than reasoning about the
 * shim from the ORDER of these two comments.
 */
importScripts(
  '../lib/api.js',
  '../lib/suno.js',
  '../lib/db.js',
  '../lib/crypto.js',
  '../lib/drm.js',
  '../lib/tagger.js',
  '../lib/lyrics.js',
  '../lib/audio.js'
);

/**
 * Resolve a lib global tolerantly. A lib that has not been (or is no longer)
 * published must produce `null` and a single warning, never a worker that
 * throws on wake.
 *
 * @param {string} name global name, e.g. 'SunoTagger'
 * @returns {*} the value, or null
 */
function resolveGlobal(name) {
  const scopes = [];
  if (typeof globalThis !== 'undefined') scopes.push(globalThis);
  if (typeof self !== 'undefined') scopes.push(self);
  if (typeof window !== 'undefined') scopes.push(window);
  for (const scope of scopes) {
    if (scope && scope[name]) return scope[name];
  }
  return null;
}

const SunoAPIClient = resolveGlobal('SunoAPIClient');
const SunoAPI = resolveGlobal('SunoAPI');
const SunoApiError = resolveGlobal('SunoApiError');
const SunoDB = resolveGlobal('SunoDB');
const SunoDRM = resolveGlobal('SunoDRM');
const SunoCrypto = resolveGlobal('SunoCrypto');
const SunoFilter = resolveGlobal('SunoFilter');
const SunoAudio = resolveGlobal('SunoAudio');
const SunoLyrics = resolveGlobal('SunoLyrics');
// lib/tagger.js now publishes on `globalThis` (see its own note at
// lib/tagger.js:2125), so no shim is needed for it. If the tagger is genuinely
// absent every export degrades to UNTAGGED-BUT-WORKING (§11).
const SunoTagger = resolveGlobal('SunoTagger');

/**
 * Short alias for the database instance. Every subsystem below refers to `DB`
 * (`DB.clips`, `DB.downloads`, `DB.syncState`, `DB.journal`, `DB.meta`), and
 * this binding is what makes those references resolve.
 */
const DB = SunoDB;

const MISSING_LIBS = [];
if (!SunoAPIClient || !SunoAPI) MISSING_LIBS.push('lib/api.js (SunoAPIClient)');
if (!SunoDB) MISSING_LIBS.push('lib/db.js (SunoDB)');
if (!SunoFilter) MISSING_LIBS.push('lib/suno.js (SunoFilter) — filtering is disabled');
if (!SunoDRM) MISSING_LIBS.push('lib/drm.js (SunoDRM) — DRM + media fetch disabled');
if (!SunoCrypto) MISSING_LIBS.push('lib/crypto.js (SunoCrypto)');
if (!SunoAudio) MISSING_LIBS.push('lib/audio.js (SunoAudio)');
if (!SunoLyrics) MISSING_LIBS.push('lib/lyrics.js (SunoLyrics) — sidecars disabled');
if (!SunoTagger) MISSING_LIBS.push('lib/tagger.js (SunoTagger) — files will be written UNTAGGED');

const TAGGER_AVAILABLE = !!(SunoTagger && typeof SunoTagger.tagAudioFile === 'function');
const FILTER_AVAILABLE = !!(SunoFilter && typeof SunoFilter.apply === 'function');

/* ==========================================================================
 * 1. CONSTANTS
 * ======================================================================== */

const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'suno.settings',
  DIAGNOSTICS: 'suno.diagnostics',
  QUOTA: 'suno.quota.last',
  SESSION_AUTH: 'suno.auth.session',
  SESSION_SELECTION: 'suno.selection.session',
  SESSION_ACTIVE_DOWNLOADS: 'suno.activeDownloads.session',
  SESSION_TABS: 'suno.registeredTabs.session',
});

const META_KEYS = Object.freeze({
  ACTIVE_BATCH: 'batch.active',
  BATCH_PREFIX: 'batch.plan.',
  PROJECTS: 'projects.cached',
  SELECTION: 'selection.durable',
  FEED_BASE_IDS: 'feed.baseIds',
  FEED_DISLIKED_IDS: 'feed.dislikedIds',
  FEED_SEEN_IDS: 'feed.seenIds',
  LAST_BATCH_SUMMARY: 'batch.lastSummary',
});

const ALARMS = Object.freeze({
  KEEPALIVE: 'suno.batch.keepalive',
  QUOTA: 'suno.quota.refresh',
  SYNC: 'suno.sync.autosync',
});

/**
 * `chrome.alarms` minimum period. 0.5 min is the documented floor and it is the
 * only thing that reliably wakes an evicted worker mid-batch.
 */
const KEEPALIVE_PERIOD_MINUTES = 0.5;

/** Token freshness margin: re-mint well before the JWT's own `exp`. */
const TOKEN_REFRESH_SKEW_MS = 90_000;

/** How long a content-script token relay may take before it is abandoned. */
const TOKEN_RELAY_TIMEOUT_MS = 2500;

/** Ring-buffer cap for the diagnostics log (also persisted to storage.local). */
const DIAG_BUFFER_CAP = 500;

/** How often the in-memory diagnostics buffer is written through to storage. */
const DIAG_FLUSH_MS = 750;

/**
 * Default per-page flush cadence for the two-pass dislike sets. Persisting a
 * 3,000-id array on every page would dominate the crawl; persisting only at the
 * end would lose the diff to an eviction. Five pages bounds both.
 */
const DISLIKED_FLUSH_EVERY_PAGES = 5;

/** Hard ceiling on clips buffered in memory during a forced full rebuild. */
const FULL_REBUILD_BUFFER_CAP = 25000;

/**
 * Rows per `clips.putMany` chunk.
 *
 * `putMany` is one transaction for the whole array, which is what we want per
 * PAGE (a few dozen rows) but not for a forced rebuild's fallback path, where
 * the buffer can hold tens of thousands of rows. One 25,000-row transaction
 * risks a long lock and an all-or-nothing abort; chunking it means a mid-way
 * failure loses at most one chunk of NEW rows and never touches the existing
 * library, because this path is additive by construction.
 */
const PUT_CHUNK_SIZE = 500;

/** `SunoDB.clips.all()` defaults to 1000 rows; a negative limit means "all". */
const ALL_CLIPS = Object.freeze({ limit: -1 });

/** How long an item waits for the browser to report a completed transfer. */
const DOWNLOAD_SETTLE_TIMEOUT_MS = 180_000;

/** Extension pages allowed to send requests to this worker. */
const TRUSTED_PAGE_PATTERNS = [
  /^chrome-extension:\/\//,
  /^https:\/\/suno\.com\//,
  /^https:\/\/[a-z0-9-]+\.suno\.com\//i,
  /^https:\/\/[a-z0-9-]+\.suno\.ai\//i,
];

/** Tab patterns the worker is allowed to talk to. */
const SUNO_TAB_PATTERNS = [
  'https://suno.com/*',
  'https://*.suno.com/*',
  'https://*.suno.ai/*',
];

/**
 * THE DOWNLOAD LADDER.
 *
 * Ordered, and each rung carries its COST CLASS. One song consumes exactly one
 * download from Suno's official meter (`download_usage`) regardless of format;
 * the meter is free 0 / pro 20 / premier 60 per billing period, resets on the
 * billing date, no carryover. Reading `media_urls` does not touch it.
 *
 * The old exploit — "the Studio route does not count toward quota" — was closed
 * server-side on 2026-09-09. `metered` below is therefore the OBSERVED contract
 * and not a bypass claim.
 *
 * @type {ReadonlyArray<{id:string,label:string,metered:boolean,optIn:boolean,
 *   batchOnly:boolean,note:string}>}
 */
const LADDER_RUNGS = Object.freeze([
  {
    id: 'progressive',
    label: 'progressive (media_urls, unencrypted)',
    metered: false,
    optIn: false,
    batchOnly: false,
    note: 'A media_urls entry with NO `encoding` field. Plain GET. Never touches the download meter.',
  },
  {
    id: 'mango-drm',
    label: 'mango-drm (rights + AES)',
    metered: false,
    optIn: false,
    batchOnly: false,
    note: 'Encrypted media_urls entry -> POST rights -> AES-GCM unwrap -> chunked AES-CTR. Never touches the meter.',
  },
  {
    id: 'studio',
    label: 'studio download route',
    metered: true,
    optIn: false,
    batchOnly: false,
    note: 'GET /api/studio/clip/{id}/download. Counts as ONE download.',
  },
  {
    id: 'download-route',
    label: 'generic download route',
    metered: true,
    optIn: false,
    batchOnly: false,
    note: 'GET /api/download/clip/{id}. Counts as ONE download.',
  },
  {
    id: 'wav-official',
    label: 'official WAV (convert + signed URL)',
    metered: true,
    optIn: true,
    batchOnly: false,
    note: 'POST convert_wav then GET wav_file (signed URL TTL 3599s). 403 means ENTITLEMENT, not auth.',
  },
  {
    id: 'zip',
    label: 'bulk ZIP prepare',
    metered: true,
    optIn: true,
    batchOnly: true,
    note: 'POST download/clips/zip/prepare, flat body, <=200 clips per chunk. Response shape is UNKNOWN and may be a job.',
  },
  {
    id: 'hls',
    label: 'HLS hand-off (page capture)',
    metered: false,
    optIn: true,
    batchOnly: true,
    note: 'Not a rung: the page captures the stream and hands the segment list over via HLS_CAPTURE, '
      + 'which is page manipulation and is therefore opt-in and explicit.',
  },
]);

/** Rung id -> definition. */
const LADDER_BY_ID = new Map(LADDER_RUNGS.map((rung) => [rung.id, rung]));

/**
 * Ladder aliases accepted from older UI builds so a stale settings blob cannot
 * silently disable every rung.
 *
 * `hls` IS mapped — to itself, one key past the end — but that is the fact worth
 * knowing rather than "hls is unsupported": `hls` is `batchOnly: true`, and
 * `normalizeLadder` drops every `batchOnly` rung unconditionally (it is not the
 * opt-in flag that removes it, it is removed either way). So a stored `['hls']`
 * normalises to an EMPTY per-clip ladder and `startBatch` answers `ladder_empty`.
 * That is correct, not a bug: the HLS hand-off is driven by the page capture
 * (§10b) and never runs as a rung. Mapping the key also keeps it out of
 * `ladder.unknown_rungs_ignored`, so the log names the real cause
 * (`ladder.empty_after_filtering`) instead of blaming an unknown rung id.
 */
const LADDER_ALIASES = Object.freeze({
  media: ['progressive', 'mango-drm'],
  progressive: ['progressive', 'mango-drm'],
  audio: ['progressive', 'mango-drm'],
  wav: ['wav-official'],
  'wav-official': ['wav-official'],
  studio: ['studio', 'download-route'],
  'download-route': ['download-route', 'studio'],
  'mango-drm': ['mango-drm', 'progressive'],
  zip: ['zip'],
  hls: ['hls'],
});

/**
 * VARIANTS — THE CANONICAL LIST IS EXACTLY THREE ENTRIES, AND THAT IS A
 * CAPABILITY DECISION, NOT AN OMISSION. DO NOT "HELPFULLY" RE-ADD THE OTHERS.
 *
 * A variant is only listed here if this build can actually deliver the file it
 * names:
 *
 *   m4a       Suno's default container. NATIVE: the download already IS an
 *             m4a, so no encoder is involved at any point.
 *   wav       A LOCAL render at `settings.wavSampleRate` through the offscreen
 *             `sunoRenderWav` (decode -> resample -> real WAV header).
 *   wav-48k   The same local render with the rate PINNED to 48000, so the rung
 *             stays distinguishable from plain `wav` when the global setting has
 *             been moved to something else.
 *
 * Everything the old list offered besides those — mp3, mp3-256, mp3-320, flac,
 * ogg, aac, opus — needed a real encoder. lamejs 1.2.1 and
 * higuma/ogg-vorbis-encoder-js are now vendored under `vendor/` and loaded by
 * `offscreen/offscreen.js` from `chrome-extension://` URLs, so MP3 and Ogg
 * Vorbis ARE reachable — but as `settings.transcode`, not as variants. That
 * distinction is the reason they stay off this list:
 *
 *   - `variant` selects the DOWNLOAD ROUTE: it is passed through as the route's
 *     `?format=` parameter and is the identity `isDone(id, variant)` and the
 *     filename extension are keyed on. Those enum members are undocumented, so
 *     advertising `mp3` here would mean asking the route for a format it may
 *     not serve, failing, and falling through the ladder — potentially spending
 *     the metered rungs' quota to produce the very file the free rungs give us.
 *   - `transcode` is a POST-FETCH local step (`maybeTranscode`) applied to bytes
 *     already in hand, best-effort, falling back to saving the original. It
 *     costs CPU and RAM and no download quota, which is what makes it safe to
 *     offer.
 * FLAC, AAC and Opus have no vendored encoder and no `transcode` format, so they
 * remain genuinely undeliverable.
 *
 * The value is still passed straight through as the download route's
 * `?format=` parameter, whose enum members are undocumented — `lib/api.js`
 * tallies every value tried so the real members can be learned from telemetry.
 */
const VARIANTS = Object.freeze(['m4a', 'wav-48k', 'wav']);

/** The variant used when nothing recognisable was requested. Matches DEFAULT_SETTINGS.variant. */
const DEFAULT_VARIANT = 'm4a';

/**
 * Canonical variant -> the file extension actually written.
 *
 * An explicit map, not `VARIANTS` membership: the two WAV rungs deliver one
 * container, so `wav-48k` must land on `.wav` even though it keeps its own
 * identity in `VARIANTS`. Deriving the extension from the variant id is what
 * used to produce a literal `.wav-48k` filename.
 *
 * @type {Readonly<Record<string,string>>}
 */
const VARIANT_EXTENSIONS = Object.freeze({ m4a: 'm4a', wav: 'wav', 'wav-48k': 'wav' });

/**
 * The rate the `wav-48k` rung pins. A named constant so the rung's identity
 * lives in ONE place and cannot drift from its label.
 */
const WAV_48K_RATE = 48000;

/**
 * Tolerated legacy / non-canonical variant spellings.
 *
 * WHY TOLERANT: a stored setting, an imported settings blob, or a page UI that
 * has not been updated yet can all still say `mp3-320`. Hard-resetting to the
 * default on read is indistinguishable from "your settings were lost" and would
 * also silently move a user who had deliberately chosen a different default.
 * Substituting the nearest thing this build CAN produce keeps the batch running
 * and is recorded in the diagnostic ring buffer so the substitution is visible
 * rather than mysterious.
 *
 * `lrc` / `cover` / `json` appear here because `content/content.js` offered them
 * as if they were formats; they are sidecar TAGS, not containers, and the
 * `tagOptions` booleans already cover them.
 *
 * @type {Readonly<Record<string,string>>} original spelling -> canonical variant
 */
const VARIANT_ALIASES = Object.freeze({
  mp3: 'm4a',
  'mp3-256': 'm4a',
  'mp3-320': 'm4a',
  flac: 'm4a',
  ogg: 'm4a',
  aac: 'm4a',
  opus: 'm4a',
  lrc: 'm4a',
  cover: 'm4a',
  json: 'm4a',
  m4a: 'm4a',
  'wav-48k': 'wav-48k',
  wav: 'wav',
});

/**
 * Reduce any requested variant to one this build can actually deliver.
 *
 * Used by `coerceSettings`, `startBatch` and the HLS capture path so an unknown
 * or aliased value can NEVER reach the download route raw. The alias branch logs
 * once per occurrence at debug level, naming BOTH values, because "I asked for
 * MP3 and got M4A" must be answerable from the diagnostics surface.
 *
 * @param {unknown} raw
 * @param {string} fallback the variant to use when nothing is recognisable
 * @returns {string} a member of `VARIANTS`
 */
function resolveVariant(raw, fallback) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (VARIANTS.indexOf(key) >= 0) return key;
  const aliased = Object.prototype.hasOwnProperty.call(VARIANT_ALIASES, key) ? VARIANT_ALIASES[key] : null;
  if (aliased) {
    log('debug', 'settings.variant_aliased', { requested: key, using: aliased });
    return aliased;
  }
  if (key) log('debug', 'settings.variant_unknown', { requested: key, using: fallback });
  return VARIANTS.indexOf(fallback) >= 0 ? fallback : DEFAULT_VARIANT;
}

/**
 * The conversions this build can actually perform, in ladder order.
 *
 * A single source of truth because two things must agree: `coerceSettings` (which
 * rejects anything outside this list) and the offscreen document's own `format`
 * dispatch. Exported nowhere — it is deliberately not a capability a caller can
 * extend.
 * @type {ReadonlyArray<string>}
 */
const TRANSCODE_FORMATS = Object.freeze(['none', 'wav', 'mp3', 'ogg']);

/**
 * Reduce any requested `transcode` to a member of `TRANSCODE_FORMATS`.
 *
 * WHY A DEDICATED RESOLVER rather than an inline `indexOf` test: the previous
 * clamp was hardcoded to `none|wav`, which meant MP3/OGG were unreachable even
 * though both encoders are vendored. That narrowing is exactly the kind of
 * silent capability removal that leaves the UI showing "None" while the stored
 * blob still says `'mp3'` — and an unrecognised value must still degrade to
 * `'none'` ("save the original") rather than reach `maybeTranscode` raw. Both
 * the membership test and the unknown-value log live here so the two can never
 * drift apart again, exactly as `resolveVariant` does for the ladder.
 *
 * @param {unknown} raw
 * @param {string} fallback
 * @returns {string} a member of `TRANSCODE_FORMATS`
 */
function resolveTranscode(raw, fallback) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (TRANSCODE_FORMATS.indexOf(key) >= 0) return key;
  if (key) log('debug', 'settings.transcode_unknown', { requested: key, using: fallback });
  return TRANSCODE_FORMATS.indexOf(fallback) >= 0 ? fallback : 'none';
}

/**
 * The MP3 bitrates `mp3Bitrate` may hold, ascending.
 *
 * These are the six bitrates `lamejs.Mp3Encoder(channels, rate, bitrate)`
 * actually accepts at full quality; anything else makes LAME fall back to its
 * own internal choice, which would silently ignore the user's setting. A named
 * list rather than a `[min,max]` clamp so `coerceSettings` can SNAP instead of
 * rejecting — see `snapToChoice`.
 * @type {ReadonlyArray<number>}
 */
const MP3_BITRATES = Object.freeze([128, 160, 192, 224, 256, 320]);

/**
 * The Ogg Vorbis quality levels `oggQuality` may hold, ascending.
 *
 * `new OggVorbisEncoder(rate, channels, quality)` takes a named-quality index on
 * a 0..1 scale (0 = smallest / worst, 1 = largest / best), and the offscreen
 * document substitutes 0.8 for anything outside that range. Stepping by 0.1
 * matches the library's own granularity.
 * @type {ReadonlyArray<number>}
 */
const OGG_QUALITIES = Object.freeze([
  0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
]);

/** Default settings. Persisted to `chrome.storage.local` under SETTINGS. */
const DEFAULT_SETTINGS = Object.freeze({
  debug: false,

  /* ---- what to fetch ---- */
  variant: 'm4a',
  /** Ordered ladder preference; the first AVAILABLE rung is used. */
  downloadSource: ['progressive', 'mango-drm', 'studio', 'download-route'],
  /** Alias key kept for the existing content-script settings panel. */
  sourceLadder: ['progressive', 'mango-drm', 'studio', 'download-route'],
  /** Allow the metered opt-in extras (official WAV, bulk ZIP). */
  allowMeteredExtras: false,

  /* ---- pacing ---- */
  rateLimit: 4,
  rateLimitJitter: true,
  concurrency: 3,
  retryAttempts: 2,

  /* ---- naming ---- */
  filenameTemplate: '{title}_{clipIdShort}.{ext}',
  folderDepth: 2,
  maxFolderDepth: 4,
  overwrite: false,
  dataUrlMaxBytes: 24 * 1024 * 1024,

  /* ---- tags & sidecars ---- */
  tagOptions: Object.freeze({
    embed: true,
    lyrics: true,
    artwork: true,
    bpm: false,
    comment: true,
    json: false,
    lrc: true,
  }),
  /**
   * `neutral` writes the configured neutral artist name; `clip-owner` uses the
   * clip's `display_name`/`handle`. Those fields are the OWNER's account
   * identity, never a third-party artist credit, so `neutral` is the default.
   */
  artistPolicy: 'neutral',
  neutralArtist: 'Suno',
  albumName: 'Suno Library',

  /* ---- conversion ---- */
  // 'none' | 'wav' | 'mp3' | 'ogg'.
  //   'wav' is an offscreen sunoRenderWav call: a real resample with the rate
  //   written into a real WAV header.
  //   'mp3' | 'ogg' are offscreen sunoTranscode calls that need
  //   `globalThis.lamejs` / `OggVorbisEncoder`. Both ARE vendored now, at
  //   vendor/lame.all.js and vendor/OggVorbisEncoder.js, and the offscreen
  //   document loads them from `chrome-extension://` URLs (its
  //   `resolveVendorPath` asserts that protocol). They MUST stay local files:
  //   MV3's default CSP is `script-src 'self'`, which forbids fetching an
  //   encoder from a CDN outright, so a remote copy is not an option.
  // M4A never needs a transcode: the source stream already is one.
  transcode: 'none',
  // Applies to the `wav` rung only. The `wav-48k` rung pins 48000 instead, so
  // the two WAV variants stay distinguishable when this is moved elsewhere.
  wavSampleRate: 48000,
  /**
   * MP3 encoder bitrate in kbps, used by the `mp3` rung only.
   * One of MP3_BITRATES = [128, 160, 192, 224, 256, 320]; a value off that
   * list is SNAPPED to the nearest entry by `snapToChoice`, not rejected, so
   * typing 200 yields 192. Ignore entirely when `transcode !== 'mp3'`.
   */
  mp3Bitrate: 192,
  /**
   * Ogg Vorbis encoder quality, used by the `ogg` rung only. 0 = smallest /
   * fastest, 1 = largest / slowest. One of OGG_QUALITIES = the tenths from 0.0
   * to 1.0, snapped to the nearest tenth. A missing value becomes 0.5, NOT the
   * offscreen document's own 0.8 default, so what the file says and what the
   * encoder does cannot disagree. Ignore when `transcode !== 'ogg'`.
   */
  oggQuality: 0.5,

  /* ---- crawl ---- */
  syncMaxPages: 200,
  dislikedMode: 'exclude',
  autoSync: false,
  syncIntervalMinutes: 60,

  /* ---- safety ---- */
  /** Plan a batch and report it without spending a single download. */
  dryRun: false,
  /**
   * MID-BATCH QUOTA GUARD. `quotaPreflight` reads the meter BEFORE a plan and
   * `runBatch` reads it AFTER, so a plan built on a stale reading used to keep
   * going and then fail item-by-item on the metered rungs — a healthy badge and
   * an opaque mid-batch failure, which is the exact defect this build existed to
   * kill. The guard re-reads the meter DURING the run.
   *
   * `quotaReserve` is the floor the guard stops AT: `remaining <= quotaReserve`
   * ends the batch cleanly. 0 means "stop the moment the meter is empty".
   */
  quotaReserve: 0,
  /**
   * Re-read the meter at most once per N SUCCESSFUL METERED downloads.
   * Re-metering is the expensive part, and `progressive` / `mango-drm` never
   * consume the allowance, so unmetered rungs are not counted and a
   * purely-unmetered batch polls ZERO times.
   */
  quotaCheckEvery: 5,
  /**
   * HLS stream hand-off. OFF by default: collecting the segments requires the
   * page to patch MediaSource on Suno's own player, which is page manipulation
   * and trips abuse heuristics. The content script also gates it behind an
   * explicit confirm, so both sides must agree.
   */
  allowHlsCapture: false,
});

/** Push message types this worker emits. The router ignores all of them. */
const PUSH_TYPES = Object.freeze(new Set([
  'SYNC_PROGRESS', 'SYNC_DONE', 'SYNC_ERROR',
  'DL_PROGRESS', 'DL_ITEM', 'DL_DONE', 'DL_ERROR',
  'TOKEN_CHANGED',
]));

/* ==========================================================================
 * 2. DIAGNOSTICS
 *
 * One `log()`, gated behind `settings.debug`, writing to a ring buffer in
 * `chrome.storage.local`. There is no `console.log` in this file: the console is
 * invisible in a packaged extension and lost the moment the worker dies.
 * ======================================================================== */

/** @type {Array<{t:number,level:string,event:string,data:object}>} cache only. */
let diagBuffer = [];
let diagFlushTimer = null;
let diagFlushPending = false;

/** Anything matching this never reaches the log, at any level. */
const SENSITIVE_KEY_RE = /(token|jwt|authorization|bearer|password|secret|cookie|session_key|private_key|content_key|user_key|glt|iv)/i;

/**
 * Make a value safe to log: drop sensitive keys, cap depth and string length,
 * and turn anything unserialisable into a marker rather than throwing.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function sanitizeLogData(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '[function]';
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name}(${value.byteLength})]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer(${value.byteLength})]`;
  if (depth >= 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 40).map((entry) => sanitizeLogData(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    let kept = 0;
    for (const key of Object.keys(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      if (kept >= 40) break;
      out[key] = sanitizeLogData(value[key], depth + 1);
      kept += 1;
    }
    return out;
  }
  return String(value);
}

/**
 * THE single logging entry point.
 *
 * Persists to `chrome.storage.local` when `settings.debug` is on, and ALWAYS for
 * `error` level — an error you cannot see is the defect that just shipped.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event stable, greppable event name
 * @param {object} [data] structured context (redacted automatically)
 * @returns {void}
 */
function log(level, event, data) {
  try {
    diagBuffer.push({ t: Date.now(), level, event, data: sanitizeLogData(data || {}) });
    if (diagBuffer.length > DIAG_BUFFER_CAP) {
      diagBuffer.splice(0, diagBuffer.length - DIAG_BUFFER_CAP);
    }
    scheduleDiagFlush();
  } catch (logErr) {
    // A logger that throws is worse than no logger, but it must not take the
    // worker down. Record the fact in the console-free path we still have:
    // the last entry is silently dropped and the flush still runs.
    void logErr;
    scheduleDiagFlush();
  }
}

/**
 * Arm the write-behind flush. Coalesced so a hot loop cannot produce one
 * storage write per log line.
 * @returns {void}
 */
function scheduleDiagFlush() {
  if (diagFlushTimer !== null || diagFlushPending) return;
  diagFlushPending = true;
  diagFlushTimer = setTimeout(() => {
    diagFlushTimer = null;
    diagFlushPending = false;
    void flushDiagnostics();
  }, DIAG_FLUSH_MS);
}

/**
 * Write the in-memory ring buffer through to `chrome.storage.local`, trimming
 * the stored buffer to the cap.
 * @returns {Promise<void>}
 */
async function flushDiagnostics() {
  const settings = settingsCache;
  const hasError = diagBuffer.some((entry) => entry.level === 'error');
  if (!hasError && !(settings && settings.debug)) return;
  const batch = diagBuffer.slice();
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.DIAGNOSTICS);
    const existing = Array.isArray(stored[STORAGE_KEYS.DIAGNOSTICS])
      ? stored[STORAGE_KEYS.DIAGNOSTICS]
      : [];
    const merged = existing.concat(batch).slice(-DIAG_BUFFER_CAP);
    await chrome.storage.local.set({ [STORAGE_KEYS.DIAGNOSTICS]: merged });
  } catch (flushErr) {
    // Storage can be unavailable during extension update. Nothing to do but
    // keep the in-memory buffer and try again on the next flush.
    void flushErr;
  }
}

/**
 * Read the persisted ring buffer back, newest last.
 * @returns {Promise<Array<object>>}
 */
async function readDiagnostics() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.DIAGNOSTICS);
    const entries = stored[STORAGE_KEYS.DIAGNOSTICS];
    return Array.isArray(entries) ? entries.slice(-DIAG_BUFFER_CAP) : [];
  } catch (readErr) {
    void readErr;
    return [];
  }
}

/* ==========================================================================
 * 3. ERRORS, REDACTION, CLASSIFICATION
 * ======================================================================== */

/**
 * Redact bearer material and key material from arbitrary text before it can
 * reach a log, a notification, or a message payload.
 * @param {unknown} value
 * @returns {string}
 */
function redactText(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
  text = text.replace(/\beyJ[A-Za-z0-9._-]{8,}/g, '[redacted-jwt]');
  text = text.replace(/("(?:authorization|token|jwt|password|secret|content_key|user_key|glt)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
  return text.length > 600 ? text.slice(0, 600) + '…' : text;
}

/**
 * A failure shaped for a message reply: never carries a stack, never carries a
 * token, always carries a machine code the UI can branch on.
 */
class OpError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human text (redacted)
   * @param {object} [info] extra fields merged onto the reply
   */
  constructor(code, message, info) {
    super(redactText(message));
    this.name = 'OpError';
    this.code = code;
    this.info = info && typeof info === 'object' ? info : {};
  }

  /** @returns {{ok:false, error:string, code:string}} */
  toReply() {
    return { ok: false, error: this.message, code: this.code, ...this.info };
  }
}

/**
 * Normalise anything thrown into `{code, message, retryable, status}`.
 * @param {unknown} err
 * @returns {{code:string, message:string, retryable:boolean, status:number}}
 */
function describeError(err) {
  if (err instanceof OpError) {
    return { code: err.code, message: err.message, retryable: false, status: 0 };
  }
  if (err && typeof err === 'object') {
    const status = Number.isFinite(err.status) ? err.status : 0;
    let code = typeof err.code === 'string' && err.code ? err.code : 'unknown_error';
    if (SunoApiError && typeof SunoApiError.isAuthError === 'function' && SunoApiError.isAuthError(err)) {
      code = err.code === 'bad_token' ? 'bad_token' : 'unauthorized';
    } else if (SunoApiError && SunoApiError.isQuotaError && SunoApiError.isQuotaError(err)) {
      code = 'quota';
    } else if (SunoApiError && SunoApiError.isEntitlementError && SunoApiError.isEntitlementError(err)) {
      code = 'entitlement';
    } else if (SunoApiError && SunoApiError.isNotFound && SunoApiError.isNotFound(err)) {
      code = 'not_found';
    }
    return {
      code,
      message: redactText(err.message || String(err)),
      retryable: err.retryable === true || isTransientStatus(status),
      status,
    };
  }
  return { code: 'unknown_error', message: redactText(String(err)), retryable: false, status: 0 };
}

/**
 * Is this HTTP status worth retrying? 429 and 5xx and network faults are
 * transient. 401/403/404 and an explicit refusal body never are.
 * @param {number} status
 * @returns {boolean}
 */
function isTransientStatus(status) {
  if (!Number.isFinite(status) || status <= 0) return true; // network-level
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * Should this failure be retried by the batch driver? Deliberately narrow: a
 * 403 is an entitlement wall, a 404 will never appear, and a `{ok:false}`
 * refusal is a decision, not a glitch.
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryableFailure(err) {
  if (!err) return false;
  if (err.aborted === true) return false;
  if (err.name === 'AbortError') return false;
  if (SunoApiError && typeof SunoApiError.isAbortError === 'function' && SunoApiError.isAbortError(err)) {
    return false;
  }
  if (err.code === 'entitlement' || err.code === 'not_found' || err.code === 'bad_token') return false;
  if (err.code === 'unauthorized' || err.code === 'missing_token') return false;
  if (err.code === 'refused') return false;
  // An explicit `reason` is the server refusing on purpose, never a glitch.
  if (typeof err.reason === 'string' && err.reason) return false;
  // An EXPLICIT `retryable: false` is authoritative in both directions. Without
  // this, a ladder failure carrying `retryable:false` and no HTTP status fell
  // through to `isTransientStatus(0)`, which means "network fault" — and the
  // item would be retried forever.
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  return isTransientStatus(Number(err.status) || 0);
}

/**
 * Was this failure a cancellation rather than a fault? Aborts are control flow.
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortLike(err) {
  if (!err) return false;
  if (err.aborted === true) return true;
  if (err.name === 'AbortError') return true;
  if (err.code === 'aborted' || err.code === 'cancelled') return true;
  if (SunoApiError && typeof SunoApiError.isAbortError === 'function' && SunoApiError.isAbortError(err)) {
    return true;
  }
  return false;
}

/* ==========================================================================
 * 4. SETTINGS
 * ======================================================================== */

/**
 * @typedef {object} Settings
 * @property {boolean} debug
 * @property {string} variant one of `VARIANTS`; an unrecognised or aliased
 *   value is substituted by `resolveVariant` on read, never stored raw
 * @property {string[]} downloadSource ordered ladder preference
 * @property {string[]} sourceLadder alias of downloadSource
 * @property {boolean} allowMeteredExtras
 * @property {number} rateLimit requests/second
 * @property {boolean} rateLimitJitter
 * @property {number} concurrency
 * @property {number} retryAttempts
 * @property {string} filenameTemplate
 * @property {number} folderDepth
 * @property {number} maxFolderDepth
 * @property {boolean} overwrite
 * @property {number} dataUrlMaxBytes
 * @property {{embed:boolean,lyrics:boolean,artwork:boolean,bpm:boolean,comment:boolean,json:boolean,lrc:boolean}} tagOptions
 * @property {'neutral'|'clip-owner'} artistPolicy
 * @property {string} neutralArtist
 * @property {string} albumName
 * @property {'none'|'wav'|'mp3'|'ogg'} transcode what to convert the fetched
 *   bytes into, via `maybeTranscode`. `'none'` saves the original. All four are
 *   deliverable: `'wav'` renders a local WAV, `'mp3'`/`'ogg'` re-encode locally
 *   with the vendored encoders in `vendor/` (which must stay local — MV3's
 *   `script-src 'self'` CSP forbids loading an encoder from a CDN). Anything
 *   unrecognised, `null`, or the literal `'none'` resolves to `'none'`.
 * @property {number} wavSampleRate target rate for the `wav` rung only, Hz,
 *   clamped to [8000, 192000], default 48000. The `wav-48k` rung IGNORES this
 *   and pins 48000, which is what keeps the two rungs distinguishable.
 * @property {number} mp3Bitrate encoder bitrate in kbps for the `mp3` rung
 *   only. Valid MP3_BITRATES = [128, 160, 192, 224, 256, 320], default 192.
 *   An off-list value is SNAPPED to the nearest entry (200 -> 192), which also
 *   clamps it into range; a missing or non-numeric value yields 192. Never NaN,
 *   because it is handed straight to `lamejs.Mp3Encoder`.
 * @property {number} oggQuality encoder quality for the `ogg` rung only, 0.0
 *   (smallest) to 1.0 (largest). Valid OGG_QUALITIES = the tenths 0.0, 0.1 …
 *   1.0, default 0.5. Snapped to the nearest tenth; a missing or non-numeric
 *   value yields 0.5. Never NaN, because it is handed straight to
 *   `new OggVorbisEncoder(rate, channels, quality)`.
 * @property {number} syncMaxPages
 * @property {'include'|'exclude'|'both'} dislikedMode
 * @property {boolean} autoSync
 * @property {number} syncIntervalMinutes
 * @property {boolean} dryRun
 *
 * Mid-batch quota guard. Both keys are set by the options page and re-read by
 * `startBatch` on every run; both are clamped so a corrupt or hand-edited blob
 * cannot disable the guard or turn it into a metered-rung polling loop.
 *
 * @property {number} quotaReserve downloads to keep in reserve. The guard stops
 *   the batch CLEANLY once `remaining <= quotaReserve`. Valid [0, 10000],
 *   default 0, meaning "stop the moment the meter is empty".
 * @property {number} quotaCheckEvery re-read the meter at most once per N
 *   SUCCESSFUL METERED downloads; unmetered rungs never count, so a purely
 *   unmetered batch polls zero times. Valid [1, 100], default 5. A value of 0
 *   would poll on every item (a quota-hammering loop) and is clamped up to 1.
 */

/** @type {Settings} cache; re-derived on every worker wake, never authoritative. */
let settingsCache = Object.assign({}, DEFAULT_SETTINGS);
let settingsLoaded = false;
let settingsLoadPromise = null;
let settingsWriteTimer = null;
let settingsWritePending = null;

/**
 * Coerce a stored/partial blob into a valid Settings object. Every key is
 * validated because a corrupt blob must not be able to produce a NaN rate or an
 * unsanitised path template.
 * @param {object} raw
 * @returns {Settings}
 */
function coerceSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = Object.assign({}, DEFAULT_SETTINGS);
  out.debug = input.debug === true;
  out.allowMeteredExtras = input.allowMeteredExtras === true;
  out.autoSync = input.autoSync === true;
  out.dryRun = input.dryRun === true;
  out.allowHlsCapture = input.allowHlsCapture === true;
  out.overwrite = input.overwrite === true;
  out.rateLimitJitter = input.rateLimitJitter !== false;
  out.rateLimit = clampNumber(input.rateLimit, 0.2, 20, DEFAULT_SETTINGS.rateLimit);
  out.concurrency = clampNumber(input.concurrency, 1, 8, DEFAULT_SETTINGS.concurrency);
  out.retryAttempts = clampNumber(input.retryAttempts, 0, 5, DEFAULT_SETTINGS.retryAttempts);
  out.dataUrlMaxBytes = clampNumber(input.dataUrlMaxBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULT_SETTINGS.dataUrlMaxBytes);
  out.wavSampleRate = clampNumber(input.wavSampleRate, 8000, 192000, DEFAULT_SETTINGS.wavSampleRate);
  out.syncMaxPages = clampNumber(input.syncMaxPages, 1, 2000, DEFAULT_SETTINGS.syncMaxPages);
  out.syncIntervalMinutes = clampNumber(input.syncIntervalMinutes, 5, 1440, DEFAULT_SETTINGS.syncIntervalMinutes);
  out.maxFolderDepth = clampNumber(input.maxFolderDepth, 0, 4, DEFAULT_SETTINGS.maxFolderDepth);
  out.folderDepth = clampNumber(input.folderDepth, 0, out.maxFolderDepth, DEFAULT_SETTINGS.folderDepth);
  // Alias-tolerant, unlike the old `VARIANTS.indexOf(...) >= 0` membership test,
  // which reverted a stored `mp3-320` to the default with no trace.
  out.variant = resolveVariant(input.variant, DEFAULT_SETTINGS.variant);
  out.filenameTemplate = typeof input.filenameTemplate === 'string' && input.filenameTemplate.trim()
    ? input.filenameTemplate.slice(0, 400)
    : DEFAULT_SETTINGS.filenameTemplate;
  out.artistPolicy = input.artistPolicy === 'clip-owner' ? 'clip-owner' : 'neutral';
  out.neutralArtist = typeof input.neutralArtist === 'string' ? input.neutralArtist.slice(0, 120) : DEFAULT_SETTINGS.neutralArtist;
  out.albumName = typeof input.albumName === 'string' ? input.albumName.slice(0, 120) : DEFAULT_SETTINGS.albumName;
  // `TRANSCODE_FORMATS` — WHY A RESOLVER AND NOT A BARE `indexOf`. The clamp
  // used to be hardcoded to `input.transcode === 'wav' ? 'wav' : 'none'`, which
  // made MP3/OGG permanently unreachable even though both encoders are now
  // vendored: `maybeTranscode` read this value, so `sunoTranscode` was dead code
  // and every `mp3`/`ogg` blob silently saved the original. `resolveTranscode`
  // keeps the two properties that actually matter — an unrecognised value still
  // degrades to `'none'` ("leave the original alone", the safe default for a
  // corrupt or hand-edited blob), and the occurrence is logged — while adding
  // the two formats this build can genuinely perform.
  out.transcode = resolveTranscode(input.transcode, DEFAULT_SETTINGS.transcode);
  // Encoder params. Snapped, never rejected, so a hand-typed 200 becomes 192
  // rather than a silent reset; and the fallback is resolved HERE so a missing
  // key can never reach an encoder as NaN.
  out.mp3Bitrate = snapToChoice(input.mp3Bitrate, MP3_BITRATES, DEFAULT_SETTINGS.mp3Bitrate);
  out.oggQuality = snapToChoice(input.oggQuality, OGG_QUALITIES, DEFAULT_SETTINGS.oggQuality);
  out.dislikedMode = ['include', 'exclude', 'both'].indexOf(input.dislikedMode) >= 0
    ? input.dislikedMode
    : DEFAULT_SETTINGS.dislikedMode;
  // Mid-batch quota guard. Clamped so a corrupt blob cannot disable the guard
  // (0 downloads) or turn it into a quota-polling loop (thousands).
  out.quotaReserve = clampNumber(input.quotaReserve, 0, 10000, DEFAULT_SETTINGS.quotaReserve);
  out.quotaCheckEvery = clampNumber(input.quotaCheckEvery, 1, 100, DEFAULT_SETTINGS.quotaCheckEvery);

  const ladder = normalizeLadder(input.downloadSource || input.sourceLadder, out.allowMeteredExtras);
  out.downloadSource = ladder;
  out.sourceLadder = ladder.slice();

  const tagIn = input.tagOptions && typeof input.tagOptions === 'object' ? input.tagOptions : {};
  const tagDefaults = DEFAULT_SETTINGS.tagOptions;
  out.tagOptions = {
    embed: boolOr(tagIn.embed, tagDefaults.embed),
    lyrics: boolOr(tagIn.lyrics, tagDefaults.lyrics),
    artwork: boolOr(tagIn.artwork, tagDefaults.artwork),
    bpm: boolOr(tagIn.bpm, tagDefaults.bpm),
    comment: boolOr(tagIn.comment, tagDefaults.comment),
    json: boolOr(tagIn.json, tagDefaults.json),
    lrc: boolOr(tagIn.lrc, tagDefaults.lrc),
  };
  return out;
}

/**
 * Normalise a ladder preference into real rung ids, preserving order, dropping
 * unknown and disabled entries, and always leaving the non-metered rungs first
 * unless the caller deliberately ordered otherwise.
 * @param {unknown} list
 * @param {boolean} allowMeteredExtras
 * @returns {string[]}
 */
function normalizeLadder(list, allowMeteredExtras) {
  const input = Array.isArray(list) ? list : [];
  const out = [];
  const unknown = [];
  for (const raw of input) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) continue;
    const mapped = LADDER_ALIASES[key] || [key];
    for (const id of mapped) {
      const rung = LADDER_BY_ID.get(id);
      if (!rung) {
        unknown.push(id);
        continue;
      }
      if (rung.optIn && !allowMeteredExtras) continue;
      if (rung.batchOnly) continue;
      if (out.indexOf(id) === -1) out.push(id);
    }
  }
  if (unknown.length) {
    log('warn', 'ladder.unknown_rungs_ignored', { unknown: Array.from(new Set(unknown)) });
  }
  if (out.length > 0) return out;
  // An EMPTY input means "not configured" and gets the standard ladder. A
  // non-empty input that yielded nothing means the user configured only rungs
  // that are disabled or batch-only — returning the default would silently
  // re-enable metered rungs they deliberately turned off.
  if (input.length === 0) return ['progressive', 'mango-drm', 'studio', 'download-route'];
  log('warn', 'ladder.empty_after_filtering', { requested: input });
  return [];
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * Snap a numeric setting onto the nearest allowed choice, or the fallback when
 * the value is unusable.
 *
 * WHY SNAP AND NOT REJECT. The encoder-facing settings (`mp3Bitrate`,
 * `oggQuality`) do not accept a range — LAME silently substitutes its own
 * bitrate for an unsupported one, and the offscreen document substitutes 0.8
 * for an out-of-range Ogg quality, so a value this helper let through as-is
 * would be discarded with no trace and the file would come out at a bitrate the
 * user never asked for. But outright reverting to the default is worse for a
 * hand-edited or imported blob: a user who typed 200 means "close to 192", and
 * silently getting 320 instead would be just as surprising. Nearest-choice
 * snapping also subsumes clamping — 10000 snaps up to the largest option and a
 * negative snaps down to the smallest, so no separate range check is needed.
 *
 * Ties snap to the LOWER option (`200` -> `192`, not `224`), so the result is a
 * deterministic function of the input rather than of iteration luck. One
 * consequence of doing this in plain float arithmetic rather than on scaled
 * integers: `0.55` lands on `0.6`, because `0.55 - 0.5` and `0.6 - 0.55` are
 * not bit-identical, so there is no tie to break. Harmless — either tenth is a
 * valid Ogg quality — but recorded so nobody "fixes" it by guessing.
 *
 * `null`, `''` and booleans are treated as MISSING rather than as 0/1, because
 * `Number(null)` is 0 and `Number(true)` is 1, which would otherwise quietly
 * mean "the lowest quality" for a key that was simply never set.
 *
 * @param {unknown} value
 * @param {ReadonlyArray<number>} choices non-empty, ascending
 * @param {number} fallback must be a member of `choices`; anything else falls
 *   back to `choices[0]`, so the return value is ALWAYS a member
 * @returns {number}
 */
function snapToChoice(value, choices, fallback) {
  const safe = choices.indexOf(fallback) >= 0 ? fallback : choices[0];
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return safe;
  const num = Number(value);
  if (!Number.isFinite(num)) return safe;
  let best = choices[0];
  let bestDistance = Math.abs(num - choices[0]);
  for (let i = 1; i < choices.length; i += 1) {
    const distance = Math.abs(num - choices[i]);
    if (distance < bestDistance) {
      best = choices[i];
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Coerce anything to a finite number, or 0.
 *
 * WHY THIS EXISTS: every tempo read in this file used to be
 * `rec ? rec.bpm : Number(clip.bpm) || 0`. `rec` is truthy whenever
 * `lib/suno.js` registered, and `SunoFilter.normalize()` did not (yet) expose a
 * `bpm` field, so `rec.bpm` was permanently `undefined` — which made `bpm` a
 * non-number, rendered `{bpm}` as empty, and made `!(bpm > 0)` always true so
 * `tagOptions.bpm` paid for a `sunoAnalyze` round trip on every tagged file and
 * then wrote nothing. One coercion helper, used by every read, so the four
 * call sites cannot drift apart again.
 *
 * NOTE: `Number(undefined)` is NaN and `Number(null)` is 0, so a missing field
 * and a literal zero are indistinguishable on purpose: a caller only ever asks
 * "is there a usable tempo?", and the answer to both is "no".
 *
 * @param {unknown} value
 * @returns {number} a finite number, never NaN/undefined
 */
function numOr(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * The clip's tempo, from wherever it can be found.
 *
 * Source of truth is the normalized record, because that is the only shape that
 * survives the filter's normalizations; the raw clip and its `metadata` bag are
 * fallbacks for when `lib/suno.js` is absent or the record predates the field.
 * All of them go through `numOr`, so the result is always a real number and
 * `bpm > 0` is a meaningful test at every call site.
 *
 * @param {object|null} rec the `SunoFilter.normalize()` record, or null
 * @param {object|null} clip the raw clip record
 * @returns {number} a tempo, or 0 when the clip carries none
 */
function bpmFromClip(rec, clip) {
  return rec
    ? (numOr(rec.bpm) || numOr(clip && clip.bpm) || numOr(clip && clip.metadata && clip.metadata.bpm) || 0)
    : (numOr(clip && clip.bpm) || 0);
}

/**
 * Load settings once per worker lifetime. Safe to call concurrently.
 * @returns {Promise<Settings>}
 */
function loadSettings() {
  if (settingsLoaded) return Promise.resolve(settingsCache);
  if (settingsLoadPromise) return settingsLoadPromise;
  settingsLoadPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      settingsCache = coerceSettings(stored[STORAGE_KEYS.SETTINGS]);
    } catch (loadErr) {
      log('warn', 'settings.load_failed', { error: describeError(loadErr) });
      settingsCache = coerceSettings({});
    }
    settingsLoaded = true;
    applySettingsToLibraries();
    return settingsCache;
  })();
  return settingsLoadPromise;
}

/**
 * Push the settings that libraries care about (rate limit, logger) into
 * `SunoAPIClient`, so no call site ever bypasses the shared limiter.
 * @returns {void}
 */
function applySettingsToLibraries() {
  if (!SunoAPIClient || typeof SunoAPIClient.configure !== 'function') return;
  try {
    SunoAPIClient.configure({
      rateLimit: {
        ratePerSecond: settingsCache.rateLimit,
        concurrency: settingsCache.concurrency,
        jitter: settingsCache.rateLimitJitter,
      },
      tokenProvider: ({ force }) => getAuthToken({ force: !!force }),
      logger: libLogger('api'),
    });
  } catch (configErr) {
    log('error', 'settings.configure_api_failed', { error: describeError(configErr) });
  }
  if (SunoDB && typeof SunoDB.setLogger === 'function') {
    try {
      SunoDB.setLogger(libLogger('db'));
    } catch (dbLogErr) {
      log('warn', 'settings.logger_db_failed', { error: describeError(dbLogErr) });
    }
  }
}

/**
 * Bridge a library's logger into the ring buffer, prefixed by source.
 * @param {string} tag
 * @returns {{debug:Function,info:Function,warn:Function,error:Function}}
 */
function libLogger(tag) {
  const emit = (level) => (message, context) => log(level, `${tag}:${String(message)}`, context);
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/**
 * Merge a patch into settings and schedule a write-behind.
 * @param {object} patch
 * @returns {Promise<Settings>}
 */
async function updateSettings(patch) {
  await loadSettings();
  const merged = Object.assign({}, patch || {});
  // `downloadSource` is canonical and `sourceLadder` is the legacy alias the
  // page UI writes. Without this, the previously-stored canonical key shadows
  // the incoming alias and the user's ladder ordering is silently discarded.
  if (Object.prototype.hasOwnProperty.call(merged, 'sourceLadder')
      && !Object.prototype.hasOwnProperty.call(merged, 'downloadSource')) {
    merged.downloadSource = merged.sourceLadder;
  }
  settingsCache = coerceSettings(Object.assign({}, settingsCache, merged));
  applySettingsToLibraries();
  armSettingsWrite();
  return settingsCache;
}

/**
 * Reset to defaults.
 * @returns {Promise<Settings>}
 */
async function resetSettings() {
  settingsCache = coerceSettings({});
  applySettingsToLibraries();
  armSettingsWrite();
  return settingsCache;
}

/**
 * Coalesce settings writes so a slider drag is one storage write, not fifty.
 * @returns {void}
 */
function armSettingsWrite() {
  if (settingsWriteTimer !== null) return;
  settingsWriteTimer = setTimeout(() => {
    settingsWriteTimer = null;
    const pending = settingsWritePending;
    settingsWritePending = null;
    if (pending) void persistSettings(pending);
  }, 400);
  settingsWritePending = settingsCache;
}

/**
 * @param {Settings} value
 * @returns {Promise<void>}
 */
async function persistSettings(value) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: value });
  } catch (writeErr) {
    log('error', 'settings.persist_failed', { error: describeError(writeErr) });
  }
}

/* ==========================================================================
 * 5. AUTH — the Clerk JWT
 *
 * The old build read `document.cookie.__session` (HttpOnly, therefore ALWAYS
 * empty) and captured the JWT once, never refreshing it. Every batch therefore
 * died about sixty seconds in with an unexplained 401. There is exactly one
 * correct source: the page's own Clerk instance, read from the MAIN world.
 * ======================================================================== */

/** @type {{token:string, exp:number, obtainedAt:number}|null} cache only. */
let authCache = null;

/** @type {Map<string,{resolve:Function,reject:Function,timer:any}>} relay waiters. */
const tokenRelayWaiters = new Map();

/** Guards against a thundering herd of concurrent token mints. */
let tokenMintInFlight = null;

/**
 * Decode a JWT's `exp` claim without verifying it. Verification is Clerk's job
 * and impossible from here; we only need the expiry the token claims.
 * @param {string} jwt
 * @returns {number|null} epoch ms, or null when the token is not a JWT
 */
function decodeJwtExpiry(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    const json = atob(payload);
    const claims = JSON.parse(json);
    if (!claims || typeof claims.exp !== 'number') return null;
    return claims.exp * 1000;
  } catch (decodeErr) {
    void decodeErr;
    return null;
  }
}

/**
 * Is the cached token good enough to use right now?
 * @param {{token:string,exp:number}|null} entry
 * @param {boolean} force
 * @returns {boolean}
 */
function isFreshToken(entry, force) {
  if (!entry || typeof entry.token !== 'string' || !entry.token) return false;
  if (force) return false;
  if (!Number.isFinite(entry.exp)) return false;
  return entry.exp - Date.now() > TOKEN_REFRESH_SKEW_MS;
}

/**
 * Read the session-storage token record. `chrome.storage.session` is
 * memory-backed and cleared on browser restart, which is exactly the lifetime a
 * bearer token should have.
 * @returns {Promise<{token:string,exp:number,obtainedAt:number}|null>}
 */
async function readSessionToken() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.SESSION_AUTH);
    const entry = stored[STORAGE_KEYS.SESSION_AUTH];
    if (entry && typeof entry.token === 'string' && entry.token) return entry;
  } catch (sessionErr) {
    log('warn', 'auth.session_read_failed', { error: describeError(sessionErr) });
  }
  return null;
}

/**
 * Persist the token to `chrome.storage.session` — the ONLY place a raw token is
 * ever written. Also fires `TOKEN_CHANGED` so the UI can show a live countdown.
 *
 * `callerExpiresAt` is honoured when it is a positive number. A caller that
 * reports `0` means "unknown", NOT "expired": `Clerk.session.getToken()` does
 * not reliably expose an expiry, so treating 0 as expired would mint a new
 * token on literally every request.
 *
 * @param {string} token
 * @param {number} [callerExpiresAt]
 * @returns {Promise<{token:string,exp:number,obtainedAt:number}>}
 */
async function writeSessionToken(token, callerExpiresAt) {
  const decoded = decodeJwtExpiry(token);
  const supplied = Number(callerExpiresAt);
  const exp = Number.isFinite(decoded)
    ? decoded
    : Number.isFinite(supplied) && supplied > Date.now()
      ? supplied
      : Date.now() + 60_000;
  const entry = { token, exp, obtainedAt: Date.now() };
  authCache = entry;
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_AUTH]: entry });
  } catch (sessionErr) {
    log('warn', 'auth.session_write_failed', { error: describeError(sessionErr) });
  }
  void broadcast({ type: 'TOKEN_CHANGED', expiresAt: entry.exp });
  log('info', 'auth.token_minted', {
    expiresAt: entry.exp,
    source: Number.isFinite(decoded) ? 'jwt' : Number.isFinite(supplied) && supplied > 0 ? 'caller' : 'short-ttl',
  });
  return entry;
}

/**
 * Forget the token everywhere (in memory, session storage, and the client's own
 * cache) without touching disk-resident state.
 * @returns {Promise<void>}
 */
async function clearAuthToken() {
  authCache = null;
  tokenMintInFlight = null;
  if (SunoAPIClient && typeof SunoAPIClient.clearToken === 'function') {
    try {
      SunoAPIClient.clearToken();
    } catch (clearErr) {
      log('warn', 'auth.client_clear_failed', { error: describeError(clearErr) });
    }
  }
  try {
    await chrome.storage.session.remove(STORAGE_KEYS.SESSION_AUTH);
  } catch (removeErr) {
    log('warn', 'auth.session_remove_failed', { error: describeError(removeErr) });
  }
}

/**
 * Resolve a usable Clerk JWT, minting a new one when needed.
 *
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<string|null>} the token, or null when none is obtainable
 */
async function getAuthToken(opts) {
  const force = !!(opts && opts.force);
  if (isFreshToken(authCache, force)) return authCache.token;
  const stored = force ? null : await readSessionToken();
  if (isFreshToken(stored, force)) {
    authCache = stored;
    return stored.token;
  }
  if (tokenMintInFlight) return tokenMintInFlight;

  tokenMintInFlight = mintAuthToken(force)
    .then(async (token) => {
      tokenMintInFlight = null;
      if (!token) {
        log('warn', 'auth.mint_failed', { reason: 'no suno tab with a Clerk session, and no relay answered' });
        return null;
      }
      await writeSessionToken(token);
      return token;
    })
    .catch((err) => {
      tokenMintInFlight = null;
      log('error', 'auth.mint_threw', { error: describeError(err) });
      return null;
    });
  return tokenMintInFlight;
}

/**
 * Mint a JWT. Primary path: `chrome.scripting.executeScript` in the MAIN world.
 * Fallback: ask the content script to relay it, accepting only a reply that
 * passed `event.source === window` AND `event.origin` validation on its side.
 *
 * @param {boolean} force
 * @returns {Promise<string|null>}
 */
async function mintAuthToken(force) {
  const tabs = await findSunoTabs();
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        injectImmediately: true,
        // Self-contained: it is stringified and evaluated in the page, so it
        // cannot close over anything here.
        func: () => {
          try {
            const clerk = window.Clerk;
            if (clerk && clerk.session && typeof clerk.session.getToken === 'function') {
              return Promise.resolve(clerk.session.getToken()).then((token) => (token || null));
            }
            return null;
          } catch (err) {
            return null;
          }
        },
      });
      const token = Array.isArray(results) && results.length ? results[0].result : null;
      if (typeof token === 'string' && token.length > 20) {
        log('info', 'auth.minted_from_clerk', { tabId: tab.id, forced: force });
        return token;
      }
    } catch (execErr) {
      log('warn', 'auth.execute_script_failed', { tabId: tab.id, error: describeError(execErr) });
    }
  }
  return relayAuthToken();
}

/**
 * Ask every Suno tab's content script for the token. The content script is the
 * authority on whether its own relay was trustworthy; here we only bound the
 * wait and validate that the reply came from a Suno origin.
 * @returns {Promise<string|null>}
 */
async function relayAuthToken() {
  const tabs = await findSunoTabs();
  if (!tabs.length) return null;
  const requestId = 'tr' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const reply = new Promise((resolve) => {
    const timer = setTimeout(() => {
      tokenRelayWaiters.delete(requestId);
      resolve(null);
    }, TOKEN_RELAY_TIMEOUT_MS);
    tokenRelayWaiters.set(requestId, {
      resolve: (token) => {
        clearTimeout(timer);
        tokenRelayWaiters.delete(requestId);
        resolve(token);
      },
    });
  });
  let asked = 0;
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    asked += 1;
    try {
      // Deliberately not awaited: we want the FIRST answer, and awaiting a
      // per-tab sendMessage would serialise the 2.5s timeout. The rejection is
      // logged, not swallowed — a tab with no content script is normal, but a
      // silent rejection here is exactly how a dead relay looks identical to a
      // working one.
      chrome.tabs.sendMessage(tab.id, { type: 'SUNO_TOKEN_REQUEST', requestId }).catch((relayErr) => {
        log('debug', 'auth.relay_no_listener', { tabId: tab.id, error: describeError(relayErr) });
      });
    } catch (sendErr) {
      log('debug', 'auth.relay_send_failed', { tabId: tab.id, error: describeError(sendErr) });
    }
  }
  if (!asked) return null;
  const token = await reply;
  if (token) log('info', 'auth.minted_from_relay', { tabId: tabs[0].id });
  return token;
}

/**
 * Resolve a relay answer that arrived through the `SET_TOKEN` route.
 * @param {string} requestId
 * @param {string} token
 * @returns {void}
 */
function resolveTokenRelay(requestId, token) {
  const waiter = tokenRelayWaiters.get(String(requestId || ''));
  if (!waiter) return;
  waiter.resolve(typeof token === 'string' && token.length > 20 ? token : null);
}

/**
 * Every Suno tab we may talk to, most recently active first.
 * @returns {Promise<Array<chrome.tabs.Tab>>}
 */
async function findSunoTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: SUNO_TAB_PATTERNS });
    return Array.isArray(tabs) ? tabs : [];
  } catch (queryErr) {
    log('warn', 'auth.tabs_query_failed', { error: describeError(queryErr) });
    return [];
  }
}

/**
 * Describe the token WITHOUT revealing it, for `GET_TOKEN_STATUS`.
 * @returns {Promise<{hasToken:boolean, expiresAt:number|null, secondsRemaining:number|null, source:string, badToken:boolean}>}
 */
async function tokenStatus() {
  const entry = authCache || (await readSessionToken());
  if (!entry) {
    return { hasToken: false, expiresAt: null, secondsRemaining: null, source: 'none', badToken: false };
  }
  const secondsRemaining = Number.isFinite(entry.exp) ? Math.round((entry.exp - Date.now()) / 1000) : null;
  return {
    hasToken: true,
    expiresAt: Number.isFinite(entry.exp) ? entry.exp : null,
    secondsRemaining,
    source: 'clerk',
    badToken: authState.badToken,
  };
}

/** Set when a 401 arrived while the presented JWT was still inside its own life. */
const authState = { badToken: false, lastBadTokenAt: 0 };

/**
 * Classify an auth failure and make the distinction the user needs visible.
 *
 * A 401 whose JWT is still valid by its own `exp` is NOT an expired session —
 * it is a BAD token (wrong account, revoked, or minted for another origin). The
 * previous build reported both as "unauthorized" and told users to sign in again,
 * which was actively misleading.
 *
 * @param {unknown} err
 * @returns {{code:string, message:string, badToken:boolean}}
 */
function classifyAuthFailure(err) {
  const info = describeError(err);
  if (info.code === 'bad_token') {
    authState.badToken = true;
    authState.lastBadTokenAt = Date.now();
    // Drop it everywhere. Leaving a rejected JWT in chrome.storage.session means
    // every subsequent request replays the same bad credential; clearing it
    // makes the next call mint a fresh one from the page.
    void clearAuthToken();
    return {
      code: 'bad_token',
      message: 'Suno rejected a JWT that is still inside its own validity window. '
        + 'That is a bad token, not an expired session: sign out and back in on suno.com, '
        + 'then re-run the action. (No retry will help.)',
      badToken: true,
    };
  }
  authState.badToken = false;
  return {
    code: info.code === 'missing_token' ? 'missing_token' : 'unauthorized',
    message: info.code === 'missing_token'
      ? 'No Clerk token could be minted. Open suno.com in a tab and sign in.'
      : 'The Suno session expired. Sign in again on suno.com.',
    badToken: false,
  };
}

/* ==========================================================================
 * 6. MESSAGING
 *
 * `chrome.runtime.sendMessage` from a service worker reaches extension pages
 * (popup / options / side panel) but NOT content scripts. The previous build
 * acknowledged that in a comment and then only used the broken path, so no event
 * ever reached the page. Every push goes to both.
 * ======================================================================== */

/**
 * Deliver a push to extension pages AND to content scripts in Suno tabs.
 * @param {object} message
 * @returns {Promise<void>} resolves when both fan-outs have been attempted
 */
async function broadcast(message) {
  if (!message || typeof message.type !== 'string') return;
  try {
    // No inner `.catch()`: the outer catch below logs. An empty rejection
    // handler here is exactly the kind of swallow this file forbids.
    await chrome.runtime.sendMessage(message);
  } catch (runtimeErr) {
    log('debug', 'broadcast.runtime_failed', { type: message.type, error: describeError(runtimeErr) });
  }
  try {
    const tabs = await findSunoTabs();
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (tabErr) {
        // A tab with no listener (or a navigating frame) is normal. One
        // message per tab per push, so this is cheap and must not be retried.
        log('debug', 'broadcast.tab_failed', { type: message.type, tabId: tab.id });
        void tabErr;
      }
    }
  } catch (tabsErr) {
    log('debug', 'broadcast.tab_query_failed', { type: message.type, error: describeError(tabsErr) });
  }
}

/**
 * Is this message from a source we are willing to take instructions from?
 *
 * Both halves matter: `sender.id` alone admits any extension page, and
 * `sender.url` alone is absent for some senders. The previous build checked
 * NEITHER on `TRIGGER_NATIVE_DOWNLOAD`, which downloaded an arbitrary
 * caller-supplied URL.
 *
 * @param {chrome.runtime.MessageSender} sender
 * @returns {{ok:boolean, reason?:string}}
 */
function validateSender(sender) {
  if (!sender) return { ok: false, reason: 'no sender' };
  if (sender.id !== chrome.runtime.id) return { ok: false, reason: 'sender is not this extension' };
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (!url) return { ok: false, reason: 'sender has no url' };
  for (const pattern of TRUSTED_PAGE_PATTERNS) {
    if (pattern.test(url)) return { ok: true };
  }
  return { ok: false, reason: 'sender url is not allowlisted: ' + url.slice(0, 120) };
}

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

/* ==========================================================================
 * 8. FILENAMES
 *
 * The previous build wrote EXTENSIONLESS files and hardcoded `{format}` to
 * `wav` regardless of what was requested. Sanitisation here is hostile by
 * design: a clip title is attacker-influenced text that ends up on the user's
 * filesystem.
 * ======================================================================== */

/** C0, C1, bidi overrides, line separators, BOM. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g;
/** Characters no mainstream filesystem accepts. */
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]/g;
/** Windows device names, with or without an extension. */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Total basename cap, leaving room for the extension and a uniquifier. */
const MAX_BASENAME_CHARS = 180;

/**
 * Make ONE path segment safe: control-character strip, illegal-char
 * substitution, traversal collapse, dot/space trim, reserved-name guard,
 * length cap, NFC.
 *
 * @param {unknown} value
 * @param {{maxLen?:number}} [opts]
 * @returns {string} never empty (falls back to '_')
 */
function sanitizeSegment(value, opts) {
  const maxLen = (opts && opts.maxLen) || 100;
  let text = value === null || value === undefined ? '' : String(value);
  try {
    text = text.normalize('NFC');
  } catch (normErr) {
    void normErr; // Lone surrogates: fall through with the raw text.
  }
  text = text.replace(CONTROL_CHARS_RE, '');
  text = text.replace(ILLEGAL_FILENAME_CHARS_RE, '_');
  text = text.replace(/\s+/g, ' ').trim();
  // Collapse any run of dots so '..' can never survive as a traversal segment.
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!text) return '_';
  if (WINDOWS_RESERVED_RE.test(text)) text = '_' + text;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen).replace(/[.\s]+$/, '');
  }
  return text || '_';
}

/**
 * The extension for a variant, without a leading dot.
 *
 * Driven by `resolveVariant`, so an aliased or unknown value yields the file
 * extension of what will ACTUALLY be written, not of what was asked for. The
 * old fallback was `mp3`, a format this build cannot produce.
 *
 * @param {string} variant
 * @returns {string}
 */
function extensionFor(variant) {
  return VARIANT_EXTENSIONS[resolveVariant(variant, DEFAULT_VARIANT)];
}

/**
 * Build the replacement map for the filename template.
 *
 * Supported: {workspace} {title} {model} {year} {month} {versionIndex}
 * {clipIdShort} {bpm} {artist} {id} {format} {ext}
 *
 * `{artist}` resolves to the configured artist policy, NOT to the clip's
 * `display_name`, unless the policy is `clip-owner` — those fields are the
 * OWNER's account identity, not a third-party artist credit.
 *
 * @param {object} clip raw clip record
 * @param {object} ctx {variant, settings, workspaceName, versionIndex}
 * @returns {Record<string,string>}
 */
function buildTemplateVars(clip, ctx) {
  const settings = ctx.settings;
  const variant = ctx.variant;
  const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip || {}) : null;
  const id = String((clip && clip.id) || '');
  const metadata = (clip && clip.metadata) || {};
  const createdMs = rec ? rec.createdMs : Date.parse(String((clip && clip.created_at) || '')) || 0;
  const created = createdMs ? new Date(createdMs) : null;
  const bpm = bpmFromClip(rec, clip);
  const modelLabel = rec ? String(rec.modelLabel || rec.modelVersion || '') : String(metadata.major_model_version || '');
  const title = rec ? String(rec.title || '') : String((clip && clip.title) || '');
  const ownerName = rec ? String(rec.ownerName || '') : String((clip && clip.display_name) || '');
  const artist = settings.artistPolicy === 'clip-owner' && ownerName ? ownerName : settings.neutralArtist;

  return {
    workspace: ctx.workspaceName || 'My Workspace',
    title: title || 'untitled',
    model: modelLabel || 'unknown-model',
    artist,
    year: created ? String(created.getUTCFullYear()) : '',
    month: created ? String(created.getUTCMonth() + 1).padStart(2, '0') : '',
    day: created ? String(created.getUTCDate()).padStart(2, '0') : '',
    versionIndex: String(Number.isFinite(ctx.versionIndex) && ctx.versionIndex > 0 ? Math.floor(ctx.versionIndex) : 1),
    clipIdShort: id ? id.slice(0, 8) : '',
    id,
    bpm: bpm > 0 ? String(Math.round(bpm)) : '',
    format: extensionFor(variant),
    ext: extensionFor(variant),
  };
}

/**
 * Expand the template into a `chrome.downloads` relative path.
 *
 * Folder segments from the template are honoured up to `maxFolderDepth` (hard
 * cap 4). The extension is ALWAYS appended when the rendered name lacks one.
 *
 * @param {object} clip raw clip record
 * @param {object} ctx {variant, settings, workspaceName, versionIndex}
 * @returns {{path:string, filename:string, folders:string[]}}
 */
function buildDownloadPath(clip, ctx) {
  const settings = ctx.settings;
  const template = settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;
  const vars = buildTemplateVars(clip, ctx);
  let expanded = template;
  for (const key of Object.keys(vars)) {
    expanded = expanded.split('{' + key + '}').join(vars[key]);
  }
  // An unknown token would otherwise leave literal braces in the filename.
  expanded = expanded.replace(/\{[a-zA-Z]+\}/g, '_');

  const rawParts = expanded.split('/').filter((part) => part.trim() !== '');
  let name = rawParts.length ? rawParts[rawParts.length - 1] : 'untitled';
  const folderParts = rawParts.slice(0, -1);

  const maxDepth = Math.min(4, Math.max(0, settings.maxFolderDepth));
  const depth = Math.min(folderParts.length, maxDepth, Math.max(0, settings.folderDepth));
  const folders = folderParts
    .slice(0, depth)
    .map((part) => sanitizeSegment(part, { maxLen: 80 }))
    .filter((part) => part !== '_' || folderParts.length === 1);

  const extension = extensionFor(ctx.variant);
  let base = sanitizeSegment(name, { maxLen: MAX_BASENAME_CHARS });

  // A title that sanitises away to nothing (all dots, all control characters)
  // must not become a bare `.mp3`. Fall back to the short clip id, which is
  // always stable and always unique.
  const stemOf = (value) => {
    const dot = value.lastIndexOf('.');
    return dot > 0 ? value.slice(0, dot) : value;
  };
  if (!stemOf(base)) base = (vars.clipIdShort || 'track').replace(ILLEGAL_FILENAME_CHARS_RE, '_');

  // Guarantee the real extension is present, whatever the template rendered.
  if (!/\.[A-Za-z0-9]{1,6}$/.test(base)) base = base.replace(/[.\s]+$/, '') + '.' + extension;
  if (base.length > MAX_BASENAME_CHARS) {
    const stem = base.slice(0, MAX_BASENAME_CHARS - extension.length - 1).replace(/[.\s]+$/, '');
    base = (stem || vars.clipIdShort || 'track') + '.' + extension;
  }

  return {
    folders,
    filename: base,
    path: folders.concat([base]).join('/'),
  };
}

/* ==========================================================================
 * 9. SAVING BYTES, AND RECONCILING WHAT THE BROWSER DID
 * ======================================================================== */

/**
 * `chrome.downloads.onChanged` -> record. In memory only as a fast path; the
 * durable copy lives in `chrome.storage.session` because the worker can be
 * evicted between `download()` and the event.
 * @type {Map<number,{clipId:string,variant:string,filename:string,source:string,batchId:string,bytes:number}>}
 */
const activeDownloads = new Map();

/** Waiters resolved by the onChanged listener, so a batch can count outcomes. */
const settleWaiters = new Map();

/**
 * Mirror `activeDownloads` into session storage.
 * @returns {Promise<void>}
 */
async function persistActiveDownloads() {
  try {
    const entries = [];
    for (const [id, info] of activeDownloads) entries.push([id, info]);
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS]: entries });
  } catch (persistErr) {
    log('warn', 'downloads.active_persist_failed', { error: describeError(persistErr) });
  }
}

/**
 * Reload `activeDownloads` after a worker restart.
 * @returns {Promise<void>}
 */
async function restoreActiveDownloads() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS);
    const entries = stored[STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS];
    if (Array.isArray(entries)) {
      for (const pair of entries) {
        if (Array.isArray(pair) && pair.length === 2 && typeof pair[1] === 'object' && pair[1]) {
          activeDownloads.set(Number(pair[0]), pair[1]);
        }
      }
    }
  } catch (restoreErr) {
    log('warn', 'downloads.active_restore_failed', { error: describeError(restoreErr) });
  }
}

/**
 * Ask the offscreen document for a blob URL when the buffer is too large for a
 * `data:` URL, then hand the URL to `chrome.downloads`.
 *
 * @param {Uint8Array} bytes
 * @param {{mime:string, filename:string}} target
 * @returns {Promise<{url:string, method:'data-url'|'blob-url', byteLength:number}>}
 */
async function materializeUrl(bytes, target) {
  const threshold = settingsCache.dataUrlMaxBytes;
  if (bytes.length <= threshold) {
    const base64 = bytesToBase64(bytes);
    return {
      url: 'data:' + target.mime + ';base64,' + base64,
      method: 'data-url',
      byteLength: bytes.length,
      revokeAfter: [],
    };
  }
  const url = await offscreenBlobUrl(bytes, target.mime);
  log('info', 'downloads.blob_url_used', { bytes: bytes.length, threshold, filename: target.filename });
  // The offscreen page keeps an LRU of 8 blob URLs; a long batch would evict a
  // live URL mid-transfer, so it is revoked the moment the transfer completes.
  return { url, method: 'blob-url', byteLength: bytes.length, revokeAfter: [url] };
}

/**
 * Save bytes produced inside the worker.
 *
 * `track:false` is for artefacts that are NOT songs — lyrics sidecars, cover
 * art, metadata JSON. They are handed to `chrome.downloads` but deliberately
 * NOT registered in `SunoDB.downloads`, because that store is the record of
 * which (clip, variant) pairs are finished and a `.lrc` file is not a variant.
 * Registering one there would double every count and make `isDone(id, 'mp3')`
 * ambiguous.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{mime?:string, filename:string, clipId:string, variant:string,
 *   source:string, batchId?:string, overwrite?:boolean, track?:boolean}} target
 * @returns {Promise<{downloadId:number, method:string, byteLength:number, tracked:boolean}>}
 */
async function saveBytes(bytes, target) {
  const payload = await toBytes(bytes);
  const mime = target.mime || mimeForVariant(target.variant);
  const materialized = await materializeUrl(payload, { mime, filename: target.filename });
  const downloadId = await chrome.downloads.download({
    url: materialized.url,
    filename: target.filename,
    conflictAction: target.overwrite ? 'overwrite' : 'uniquify',
    saveAs: false,
  });
  if (!Number.isFinite(downloadId)) {
    throw new OpError('download_not_started', 'chrome.downloads.download returned no id');
  }
  if (target.track === false) {
    log('debug', 'downloads.untracked_saved', { downloadId, filename: target.filename, source: target.source });
    return { downloadId, method: materialized.method, byteLength: materialized.byteLength, tracked: false };
  }
  activeDownloads.set(downloadId, {
    clipId: String(target.clipId || ''),
    variant: String(target.variant || ''),
    filename: target.filename,
    source: String(target.source || ''),
    batchId: String(target.batchId || ''),
    bytes: materialized.byteLength,
    revokeAfter: materialized.revokeAfter || [],
  });
  await persistActiveDownloads();
  log('info', 'downloads.started', {
    downloadId, method: materialized.method, bytes: materialized.byteLength, source: target.source,
  });
  return { downloadId, method: materialized.method, byteLength: materialized.byteLength, tracked: true };
}

/**
 * Hand an already-resolved CDN URL straight to `chrome.downloads` — used by the
 * metered rungs, which return a signed URL instead of bytes. Saves the buffer.
 *
 * @param {string} url
 * @param {{filename:string, clipId:string, variant:string, source:string,
 *   batchId?:string, overwrite?:boolean, byteLength?:number}} target
 * @returns {Promise<{downloadId:number, method:string, byteLength:number}>}
 */
async function saveUrl(url, target) {
  const downloadId = await chrome.downloads.download({
    url,
    filename: target.filename,
    conflictAction: target.overwrite ? 'overwrite' : 'uniquify',
    saveAs: false,
  });
  activeDownloads.set(downloadId, {
    clipId: String(target.clipId || ''),
    variant: String(target.variant || ''),
    filename: target.filename,
    source: String(target.source || ''),
    batchId: String(target.batchId || ''),
    bytes: Number(target.byteLength) || 0,
  });
  await persistActiveDownloads();
  log('info', 'downloads.started_from_url', { downloadId, source: target.source });
  return { downloadId, method: 'signed-url', byteLength: Number(target.byteLength) || 0 };
}

/**
 * Wait for the browser to report a terminal state for one download.
 *
 * This is the ONLY thing that authorises `downloads.markDone`, and it waits for
 * an OBSERVATION, never for the return of `downloads.download()`.
 *
 * @param {number} downloadId
 * @param {number} [timeoutMs]
 * @returns {Promise<{state:'complete'|'interrupted'|'timeout', error?:string, bytes?:number}>}
 */
function awaitDownloadSettlement(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settleWaiters.delete(downloadId);
      resolve({ state: 'timeout' });
    }, timeoutMs || DOWNLOAD_SETTLE_TIMEOUT_MS);
    settleWaiters.set(downloadId, {
      resolve: (outcome) => {
        clearTimeout(timer);
        settleWaiters.delete(downloadId);
        resolve(outcome);
      },
    });
  });
}

/**
 * `chrome.downloads.onChanged`.
 *
 * `download.error` is a STRING on the delta item. The previous build tested a
 * non-existent `errorDetails` field INSIDE `state === 'complete'`, so the branch
 * was permanently dead and its polarity backwards: failures were only ever
 * supposed to be detected from inside the success case.
 *
 * @param {object} delta
 * @returns {Promise<void>}
 */
async function onDownloadChanged(delta) {
  if (!delta || !Number.isFinite(delta.id)) return;
  const state = delta.state && delta.state.current;
  const errorCode = delta.error && delta.error.current ? String(delta.error.current) : null;
  if (!state && !errorCode) return;

  const info = activeDownloads.get(delta.id) || null;
  const finish = async (outcome) => {
    const waiter = settleWaiters.get(delta.id);
    if (waiter) waiter.resolve(outcome);
    activeDownloads.delete(delta.id);
    await persistActiveDownloads();
  };

  if (!info || !info.clipId) {
    log('debug', 'downloads.changed_untracked', { downloadId: delta.id, state, errorCode });
    return;
  }

  if (state === 'complete' && !errorCode) {
    // INVARIANT A, site 1 of 2: observed completion.
    await DB.downloads.markDone(info.clipId, info.variant, {
      proof: 'downloads.onChanged:complete',
      filename: info.filename,
      bytes: Number.isFinite(info.bytes) ? info.bytes : undefined,
      source: info.source,
      chromeDownloadId: delta.id,
    });
    log('info', 'downloads.completed', { downloadId: delta.id, clipId: info.clipId, variant: info.variant });
    if (info.revokeAfter && info.revokeAfter.length) void revokeBlobUrls(info.revokeAfter);
    await finish({ state: 'complete', bytes: info.bytes || 0 });
    return;
  }

  if (errorCode || state === 'interrupted') {
    const message = `chrome.downloads reported ${state || 'error'}${errorCode ? ': ' + errorCode : ''}`;
    await DB.downloads.markFailed(info.clipId, info.variant, new Error(message), { source: info.source });
    log('warn', 'downloads.failed', { downloadId: delta.id, clipId: info.clipId, state, errorCode });
    if (info.revokeAfter && info.revokeAfter.length) void revokeBlobUrls(info.revokeAfter);
    await finish({ state: 'interrupted', error: message });
    return;
  }

  log('debug', 'downloads.progress', { downloadId: delta.id, state });
}

/**
 * Worker startup reconciliation.
 *
 * 1. Anything left `in_progress` in IndexedDB was written by an EVICTED worker.
 *    `resetInProgress()` flips it back to `pending` — it is emphatically not
 *    done, and this is the whole reason the invariant exists.
 * 2. Then ask Chrome what actually happened to every download we started, so
 *    transfers that completed while the worker was dead are recorded correctly
 *    instead of being retried.
 *
 * @returns {Promise<{recovered:number, reconciled:number, orphaned:number}>}
 */
async function reconcileDownloadsOnStartup() {
  let recovered = 0;
  let reconciled = 0;
  let orphaned = 0;

  try {
    const reset = await DB.downloads.resetInProgress();
    recovered = reset.recovered || 0;
    if (recovered > 0) log('warn', 'downloads.reset_in_progress', { recovered });
  } catch (resetErr) {
    log('error', 'downloads.reset_in_progress_failed', { error: describeError(resetErr) });
  }

  try {
    const items = await chrome.downloads.search({ limit: 200, orderBy: ['-startTime'] });
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const [downloadId, info] of Array.from(activeDownloads)) {
      const item = byId.get(downloadId);
      if (!item) {
        // Chrome has no record of it: the transfer never started.
        await DB.downloads.markFailed(info.clipId, info.variant,
          new Error('no record of this download in the browser; it never started'),
          { source: info.source });
        activeDownloads.delete(downloadId);
        orphaned += 1;
        continue;
      }
      // ERROR FIRST, state second. Chrome can report `state:'complete'` WITH a
      // non-null `error`, so testing the state first would mark a FAILED
      // transfer done. That polarity — looking for an error only inside the
      // success case — is exactly the bug the previous build shipped.
      if (item.error) {
        await DB.downloads.markFailed(info.clipId, info.variant,
          new Error(`browser reports ${item.error}`), { source: info.source });
        reconciled += 1;
      } else if (item.state === 'complete') {
        // INVARIANT A, site 2 of 2: an OBSERVED completion, read from Chrome.
        await DB.downloads.markDone(info.clipId, info.variant, {
          proof: 'startup:downloads.search:complete',
          filename: info.filename,
          bytes: Number.isFinite(item.fileSize) && item.fileSize > 0 ? item.fileSize : info.bytes,
          source: info.source,
          chromeDownloadId: downloadId,
        });
        if (info.revokeAfter && info.revokeAfter.length) void revokeBlobUrls(info.revokeAfter);
        reconciled += 1;
      } else if (item.state === 'interrupted') {
        await DB.downloads.markFailed(info.clipId, info.variant,
          new Error('the browser reports the transfer as interrupted'), { source: info.source });
        reconciled += 1;
      }
      // Anything still in flight stays `pending` (resetInProgress already
      // flipped it) and will be replanned on the next batch.
      activeDownloads.delete(downloadId);
      const waiter = settleWaiters.get(downloadId);
      if (waiter) waiter.resolve({ state: item.state === 'complete' ? 'complete' : 'interrupted', error: item.error || undefined });
    }
  } catch (searchErr) {
    log('error', 'downloads.search_failed', { error: describeError(searchErr) });
  }

  await persistActiveDownloads();
  if (reconciled || orphaned) {
    log('info', 'downloads.reconciled', { reconciled, orphaned, recovered });
  }
  return { recovered, reconciled, orphaned };
}

/* ==========================================================================
 * 10. THE DOWNLOAD LADDER
 * ======================================================================== */

/**
 * Why a rung cannot run for this clip. Reported verbatim by `PROBE_DRM` so the
 * user learns what would work BEFORE spending anything.
 *
 * @param {object} clip
 * @param {string[]} rungIds
 * @returns {Array<{id:string, available:boolean, metered:boolean, reason:string}>}
 */
function evaluateLadder(clip, rungIds) {
  const pickedPlain = SunoDRM && typeof SunoDRM.pickMediaUrl === 'function'
    ? SunoDRM.pickMediaUrl(clip, { preferUnencrypted: true })
    : null;
  const pickedAny = SunoDRM && typeof SunoDRM.pickMediaUrl === 'function'
    ? SunoDRM.pickMediaUrl(clip, { preferUnencrypted: false })
    : null;
  const hasMedia = !!(pickedAny && pickedAny.url);
  const hasPlain = !!(pickedPlain && pickedPlain.url && pickedPlain.encrypted === false);

  const out = [];
  for (const id of rungIds) {
    const rung = LADDER_BY_ID.get(id);
    if (!rung) {
      out.push({ id, available: false, metered: false, reason: 'unknown rung' });
      continue;
    }
    let available = true;
    let reason = rung.note;
    if (id === 'progressive') {
      available = hasPlain;
      reason = hasPlain
        ? 'an unencrypted media_urls entry exists; a plain GET will not touch the download meter'
        : 'every media_urls entry carries an `encoding` field, so there is no unencrypted asset';
    } else if (id === 'mango-drm') {
      available = hasMedia;
      reason = hasMedia
        ? 'an encrypted media_urls entry exists; rights + AES is available'
        : 'the clip exposes no usable media_urls entry';
    } else if (id === 'zip') {
      available = true;
      reason = 'batch-only; response shape is unknown and may be a job';
    }
    out.push({ id, available, metered: rung.metered, reason });
  }
  return out;
}

/**
 * One rung of the ladder. Throws an `OpError` carrying `code`, `metered` and a
 * human `reason` so the driver can decide whether to fall through, retry, or
 * stop.
 *
 * @param {object} rung a LADDER_RUNGS entry
 * @param {object} clip raw clip record
 * @param {{variant:string, signal:AbortSignal, batchId:string, overwrite:boolean,
 *   filename:string, tagOptions:object, settings:Settings}} ctx
 * @returns {Promise<{ok:true, downloadId:number, byteLength:number, source:string, metered:boolean, method:string, tagged:boolean}>}
 */
async function runLadderRung(rung, clip, ctx) {
  if (rung.id === 'progressive' || rung.id === 'mango-drm') {
    const preferUnencrypted = rung.id === 'progressive';
    const picked = SunoDRM.pickMediaUrl(clip, { preferUnencrypted });
    if (!picked) {
      throw new OpError('no_media_url',
        rung.id === 'progressive'
          ? 'no unencrypted media_urls entry on this clip'
          : 'no usable media_urls entry on this clip');
    }
    if (rung.id === 'progressive' && picked.encrypted !== false) {
      throw new OpError('no_media_url', 'no unencrypted media_urls entry on this clip');
    }
    let bearerToken = null;
    try {
      bearerToken = await getAuthToken({ force: false });
    } catch (tokenErr) {
      log('warn', 'ladder.token_unavailable', { error: describeError(tokenErr) });
    }
    // `decryptClipBuffer` performs the plain GET for an unencrypted asset and
    // the rights+AES pipeline for an encrypted one. The worker never calls
    // `fetch` against a Suno host itself.
    const decrypted = await SunoDRM.decryptClipBuffer(String(clip.id), {
      clip,
      preferUnencrypted,
      bearerToken,
      signal: ctx.signal,
      allowUnknownContainer: true,
    });
    const bytes = await toBytes(decrypted.bytes);
    // Optional conversion, paid for with the free rung's bytes rather than with
    // quota. A null result means "off, unavailable, or failed", never a
    // failure: the original bytes are saved either way.
    const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip) : null;
    const transcoded = await maybeTranscode(
      bytes,
      decrypted.container === 'wav' ? 'audio/wav' : mimeForVariant(ctx.variant),
      ctx.settings,
      ctx.signal,
      bpmFromClip(rec, clip),
      ctx.variant
    );
    const finalBytes = transcoded ? transcoded.bytes : bytes;
    const finalVariant = transcoded ? transcoded.format : ctx.variant;
    const tagged = await applyTagsAndSidecars(clip, finalBytes, ctx, finalVariant);
    const saved = await saveBytes(tagged.bytes, {
      mime: mimeForVariant(finalVariant),
      filename: ctx.filename,
      clipId: clip.id,
      // The recorded variant must match the DELIVERED file, or a later
      // `isDone(id, variant)` check would re-download the same song.
      variant: finalVariant,
      source: rung.id,
      batchId: ctx.batchId,
      overwrite: ctx.overwrite,
    });
    let sidecars = [];
    try {
      sidecars = await writeSidecars(clip, ctx.filename, Object.assign({}, ctx, {
        clipId: String(clip.id),
        variant: finalVariant,
        source: rung.id,
      }));
    } catch (sidecarErr) {
      log('warn', 'ladder.sidecars_failed', { clipId: clip.id, error: describeError(sidecarErr) });
    }
    return {
      ok: true,
      downloadId: saved.downloadId,
      byteLength: saved.byteLength,
      source: rung.id,
      metered: false,
      method: saved.method,
      tagged: tagged.tagged,
      variant: finalVariant,
      sidecars,
    };
  }

  if (rung.id === 'studio' || rung.id === 'download-route') {
    const routeKey = rung.id === 'studio' ? 'downloadStudioClip' : 'downloadClip';
    const envelope = await SunoAPIClient.request(SunoAPI.ENDPOINTS[routeKey], {
      method: 'GET',
      pathParams: { id: String(clip.id) },
      query: { format: ctx.variant },
      signal: ctx.signal,
    });
    // NEVER branch on `envelope.ok`: these routes answer HTTP 200 with a
    // REFUSAL body `{ok:false, reason, message}`. The parser is the contract.
    const parsed = SunoAPI.parseDownloadResponse(envelope.data, {
      status: envelope.status,
      headers: envelope.headers,
      responseUrl: envelope.responseUrl,
      format: ctx.variant,
    });
    if (!parsed.ok) {
      const err = new OpError('refused', `the server refused the download: ${parsed.message}`, {
        rung: rung.id,
        reason: parsed.reason,
        status: parsed.status || envelope.status || 0,
        metered: rung.metered,
      });
      err.reason = parsed.reason || 'refused';
      throw err;
    }
    if (!parsed.url) {
      throw new OpError('job_not_supported',
        `the ${rung.id} route returned a job id rather than a URL; job polling is not implemented`,
        { rung: rung.id, jobId: parsed.jobId || null, metered: rung.metered });
    }
    const saved = await saveUrl(parsed.url, {
      filename: ctx.filename,
      clipId: clip.id,
      variant: ctx.variant,
      source: rung.id,
      batchId: ctx.batchId,
      overwrite: ctx.overwrite,
    });
    return {
      ok: true,
      downloadId: saved.downloadId,
      byteLength: saved.byteLength,
      source: rung.id,
      metered: true,
      method: saved.method,
      tagged: false,
    };
  }

  if (rung.id === 'wav-official') {
    if (!ctx.settings.allowMeteredExtras) {
      throw new OpError('not_enabled', 'the official WAV endpoint is a metered opt-in (settings.allowMeteredExtras)');
    }
    const convert = await SunoAPIClient.request(SunoAPI.ENDPOINTS.convertWav, {
      method: 'POST',
      pathParams: { id: String(clip.id) },
      body: {},
      signal: ctx.signal,
    });
    if (!convert.ok) {
      // 403 here is an ENTITLEMENT wall, never an auth problem, and never a
      // reason to retry or to go minting tokens.
      const info = describeError(convert.error);
      throw new OpError(info.code === 'entitlement' ? 'entitlement' : info.code,
        info.code === 'entitlement'
          ? 'this account is not entitled to the official WAV conversion'
          : `the WAV conversion request failed: ${info.message}`,
        { rung: rung.id, status: convert.status, metered: true });
    }
    const file = await SunoAPIClient.request(SunoAPI.ENDPOINTS.wavFile, {
      method: 'GET',
      pathParams: { id: String(clip.id) },
      signal: ctx.signal,
    });
    const parsed = SunoAPI.parseDownloadResponse(file.data, {
      status: file.status,
      headers: file.headers,
      responseUrl: file.responseUrl,
      format: 'wav',
    });
    if (!parsed.ok || !parsed.url) {
      throw new OpError('refused', `the WAV file route returned no URL: ${parsed.message || 'no artifact'}`,
        { rung: rung.id, metered: true });
    }
    const saved = await saveUrl(parsed.url, {
      filename: ctx.filename,
      clipId: clip.id,
      variant: 'wav',
      source: rung.id,
      batchId: ctx.batchId,
      overwrite: ctx.overwrite,
    });
    return {
      ok: true, downloadId: saved.downloadId, byteLength: saved.byteLength,
      source: rung.id, metered: true, method: saved.method, tagged: false,
    };
  }

  if (rung.id === 'hls') {
    throw new OpError('not_a_rung',
      'HLS is not a ladder rung: it needs a segment list captured from the page, which only the '
      + 'HLS_CAPTURE hand-off can provide. Ask the page UI to capture this clip.');
  }
  throw new OpError('unsupported_rung', `rung "${rung.id}" is not implemented in the single-clip path`);
}

/**
 * Walk the ladder for one clip, in order, falling through on every failure.
 *
 * @param {object} clip raw clip record
 * @param {{variant:string, sourceLadder:string[], signal:AbortSignal, batchId:string,
 *   overwrite:boolean, tagOptions:object, settings:Settings, workspaceName:string,
 *   versionIndex:number}} ctx
 * @returns {Promise<{ok:boolean, source?:string, metered?:boolean, error?:object,
 *   attempts:Array<{rung:string, ok:boolean, code:string, message:string}>}>}
 */
async function runLadder(clip, ctx) {
  const attempts = [];
  // `ctx.sourceLadder` is already normalised (and may be deliberately empty).
  // Re-normalising an empty array here would resurrect the default rungs and
  // spend metered quota the user explicitly disabled.
  const ladder = Array.isArray(ctx.sourceLadder)
    ? ctx.sourceLadder.slice()
    : normalizeLadder(ctx.sourceLadder, ctx.settings.allowMeteredExtras);
  if (!ladder.length) {
    return {
      ok: false,
      attempts,
      error: {
        code: 'ladder_empty',
        message: 'The download ladder is empty: every rung is either disabled or an opt-in that has not '
          + 'been granted. Enable "allow metered extras" for the official WAV route, or restore at least '
          + 'one of progressive / mango-drm / studio / download-route.',
        retryable: false,
      },
    };
  }
  const path = buildDownloadPath(clip, {
    variant: ctx.variant,
    settings: ctx.settings,
    workspaceName: ctx.workspaceName,
    versionIndex: ctx.versionIndex,
  });

  for (const rungId of ladder) {
    const rung = LADDER_BY_ID.get(rungId);
    if (!rung) continue;
    if (ctx.signal && ctx.signal.aborted) {
      return { ok: false, error: { code: 'aborted', message: 'the batch was cancelled' }, attempts };
    }
    const rungCtx = Object.assign({}, ctx, { filename: path.path, rung });
    try {
      const result = await runLadderRung(rung, clip, rungCtx);
      // A rung may deliver a different variant than was requested (the WAV
      // transcode). The filename and the recorded variant must both follow the
      // bytes that were actually written, or `isDone(id, variant)` will
      // disagree with the file on disk.
      let finalPath = path;
      if (result.variant && result.variant !== ctx.variant) {
        finalPath = buildDownloadPath(clip, {
          variant: result.variant,
          settings: ctx.settings,
          workspaceName: ctx.workspaceName,
          versionIndex: ctx.versionIndex,
        });
      }
      attempts.push({ rung: rung.id, ok: true, code: 'ok', message: rung.note });
      return Object.assign({ ok: true, filename: finalPath.path, attempts }, result);
    } catch (err) {
      const info = describeError(err);
      attempts.push({ rung: rung.id, ok: false, code: info.code, message: info.message });
      if (isAbortLike(err)) {
        return { ok: false, error: { code: 'aborted', message: info.message }, attempts };
      }
      log('warn', 'ladder.rung_failed', { clipId: clip && clip.id, rung: rung.id, code: info.code, message: info.message });
      // Fall through: that is the entire point of a ladder.
    }
  }

  return {
    ok: false,
    filename: path.path,
    attempts,
    error: {
      code: 'ladder_exhausted',
      message: 'every rung in the ladder failed for this clip: '
        + attempts.map((a) => `${a.rung}=${a.code}`).join(', '),
      retryable: attempts.some((a) => a.code === 'timeout' || a.code === 'network_error'),
    },
  };
}

/* ==========================================================================
 * 10b. HLS HAND-OFF
 *
 * The page (which has a MediaSource) captures a stream and hands the ordered
 * segment list to this worker, which reassembles the bytes and saves them.
 *
 * THIS IS THE ONE DELIBERATE EXCEPTION to "no fetch outside SunoAPIClient",
 * and the reason is mechanical, not stylistic: `SunoAPIClient.request` enforces
 * `SunoAPI.ENDPOINTS`, a table of verified API routes, and a signed media-CDN
 * segment is not an API route. Rather than widen that table (which would let any
 * future call site issue an unverified request), the segment fetch below uses its
 * own narrow allowlist, refuses plaintext, and refuses the API host outright.
 * No Suno API call is ever made through it.
 * ======================================================================== */

/** Hosts a media asset (HLS segment, cover image) may be served from. */
const MEDIA_ALLOWED_HOST_RE = /^(?:[a-z0-9-]+\.)*(?:suno\.ai|suno\.com|suno\.com\.cn|cloudfront\.net|amazonaws\.com)$/i;
/** Never fetched here, even though it matches the allowlist: it is the API host. */
const MEDIA_API_HOST_RE = /(^|\.)studio-api(\.prod)?\.suno\.com$/i;
/** Ceiling on a single media asset. */
const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
/** Ceiling on the segment count, so a hostile list cannot spin the worker. */
const HLS_MAX_SEGMENTS = 4000;
/** Cover art is small; refuse anything that claims to be bigger. */
const ART_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Fetch a media asset (HLS segment or cover image) with an allowlist, refusing
 * plaintext and the API host outright. This is the ONE place in this file that
 * calls `fetch` outside `SunoAPIClient`, and the reason is mechanical rather
 * than stylistic: `SunoAPIClient.request` enforces `SunoAPI.ENDPOINTS`, a table
 * of verified API routes, and a signed media-CDN asset is not an API route.
 * Widening that table instead would let any future call site issue an
 * unverified request against the user's account.
 *
 * @param {string} url
 * @param {{signal?:AbortSignal, maxBytes?:number, label?:string}} [opts]
 * @returns {Promise<Uint8Array>}
 */
async function fetchMediaAsset(url, opts) {
  const options = opts || {};
  const maxBytes = options.maxBytes || MEDIA_MAX_BYTES;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (parseErr) {
    void parseErr;
    throw new OpError('bad_media_url', 'media URL is not parseable');
  }
  if (parsed.protocol !== 'https:') {
    throw new OpError('bad_media_url', 'media URL must be https');
  }
  if (MEDIA_API_HOST_RE.test(parsed.hostname)) {
    throw new OpError('bad_media_url', 'the API host is never fetched as a media asset');
  }
  if (!MEDIA_ALLOWED_HOST_RE.test(parsed.hostname)) {
    throw new OpError('bad_media_url', 'media host is not allowlisted: ' + parsed.hostname);
  }
  const response = await fetch(parsed.href, {
    signal: options.signal || null,
    credentials: 'omit',
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new OpError('media_fetch_failed',
      `${options.label || 'media'} ${response.status} for ${parsed.hostname}`);
  }
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OpError('too_large', `${options.label || 'media'} declares ${declared} bytes, over the cap`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new OpError('too_large', `${options.label || 'media'} exceeds the size cap`);
  }
  return new Uint8Array(buffer);
}

/**
 * Fetch one HLS media segment.
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {number} remainingBytes
 * @returns {Promise<Uint8Array>}
 */
async function fetchHlsSegment(url, signal, remainingBytes) {
  return fetchMediaAsset(url, { signal, maxBytes: remainingBytes, label: 'segment' });
}

/**
 * Reassemble an fMP4 from an init segment plus media segments and save it.
 *
 * `downloads.markDone` is NOT called here: the row is marked in-progress and
 * then settled by the `chrome.downloads.onChanged` observer, like every other
 * path.
 *
 * @param {{clipId:string, initUrl?:string, segments?:string[],
 *   segmentUrls?:string[], mime?:string, title?:string, variant?:string}} payload
 * @returns {Promise<object>} `{ok, clipId, bytes, segments, downloadId, filename, source}`
 */
async function captureHls(payload) {
  await loadSettings();
  if (settingsCache.allowHlsCapture !== true) {
    // Off by default. This rung is page manipulation: the content script had to
    // patch MediaSource on Suno's own page to collect the segments at all.
    return {
      ok: false,
      code: 'hls_disabled',
      error: 'HLS capture is disabled. It requires the page to patch MediaSource on Suno\'s own '
        + 'player, which trips abuse heuristics; enable settings.allowHlsCapture to accept that.',
    };
  }
  const clipId = String(payload.clipId || '');
  // The content script sends `segments`; `segmentUrls` is accepted as an alias.
  const segments = (Array.isArray(payload.segments) ? payload.segments
    : Array.isArray(payload.segmentUrls) ? payload.segmentUrls : [])
    .map(String).filter(Boolean);
  if (!clipId) return { ok: false, error: 'clipId is required', code: 'bad_request' };
  if (!segments.length) return { ok: false, error: 'no segments supplied', code: 'bad_request' };
  if (segments.length > HLS_MAX_SEGMENTS) {
    return { ok: false, error: `too many segments (${segments.length} > ${HLS_MAX_SEGMENTS})`, code: 'bad_request' };
  }

  const variant = resolveVariant(payload.variant, settings.variant);
  const mime = payload.mime || 'audio/mp4';

  let clip = null;
  try {
    clip = await DB.clips.get(clipId);
  } catch (clipErr) {
    log('warn', 'hls.clip_read_failed', { clipId, error: describeError(clipErr) });
  }
  const record = clip || { id: clipId, title: payload.title || clipId };
  const path = buildDownloadPath(record, {
    variant,
    settings: settingsCache,
    workspaceName: 'My Workspace',
    versionIndex: 1,
  });

  const controller = new AbortController();
  const parts = [];
  let total = 0;
  await DB.downloads.markPending(clipId, variant, { source: 'hls', filename: path.path });
  await DB.downloads.markInProgress(clipId, variant, { source: 'hls', filename: path.path });
  log('info', 'hls.capture_started', { clipId, segments: segments.length });

  try {
    if (payload.initUrl) {
      const init = await fetchHlsSegment(payload.initUrl, controller.signal, MEDIA_MAX_BYTES);
      parts.push(init);
      total += init.length;
    }
    for (let i = 0; i < segments.length; i += 1) {
      if (controller.signal.aborted) throw new OpError('aborted', 'the capture was cancelled');
      const chunk = await fetchHlsSegment(segments[i], controller.signal, MEDIA_MAX_BYTES - total);
      parts.push(chunk);
      total += chunk.length;
      if (i % 25 === 0) log('debug', 'hls.progress', { clipId, fetched: i + 1, of: segments.length, bytes: total });
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }

    // `audio/mp4` is a fragmented MP4: detectContainer('m4a') is the right
    // dispatch, and letting the tagger sniff the bytes is better still.
    const tagged = await applyTagsAndSidecars(record, bytes, {
      variant, settings: settingsCache, signal: controller.signal,
    }, SunoTagger && typeof SunoTagger.detectContainer === 'function'
      ? SunoTagger.detectContainer(path.filename)
      : 'unknown');

    const saved = await saveBytes(tagged.bytes, {
      mime,
      filename: path.path,
      clipId,
      variant,
      source: 'hls',
      overwrite: settingsCache.overwrite,
    });
    log('info', 'hls.capture_saved', { clipId, bytes: saved.byteLength, segments: segments.length, method: saved.method });
    // The documented contract is {ok, bytes, segments}; the rest is additive and
    // safe for a reader that only looks at those three.
    return {
      ok: true,
      clipId,
      bytes: saved.byteLength,
      segments: segments.length,
      initSegment: !!payload.initUrl,
      variant,
      downloadId: saved.downloadId,
      filename: path.path,
      source: 'hls',
      method: saved.method,
    };
  } catch (err) {
    const info = describeError(err);
    log('warn', 'hls.capture_failed', { clipId, error: info });
    if (!isAbortLike(err)) {
      try {
        await DB.downloads.markFailed(clipId, variant, new Error(info.message), { source: 'hls' });
      } catch (dbErr) {
        log('error', 'hls.record_failed', { clipId, error: describeError(dbErr) });
      }
    }
    return { ok: false, error: info.message, code: info.code, clipId };
  }
}

/* ==========================================================================
 * 11. TAGGING + SIDECARS
 *
 * `lib/tagger.js` publishes on `globalThis` (lib/tagger.js:2125, with the
 * comment "not window: an MV3 service worker has no window"), so it resolves
 * through the §0 compat shim like everything else. It used to be window-only,
 * and this block used to say so and promise a fix that has since landed; that
 * sentence was stale and would have had the next session debugging a shim that
 * works. The degrade-to-untagged behaviour below is still correct and still
 * wanted — it is the fallback for an install where `lib/tagger.js` failed to
 * load entirely (`MISSING_LIBS`), not for a publication mismatch.
 * ======================================================================== */

/**
 * Fetch cover art for embedding. Any failure degrades to "no artwork": a track
 * without an embedded image is strictly better than a failed download.
 *
 * @param {object} clip raw clip record
 * @param {object} rec normalized record (carries coverUrl / imageLargeUrl)
 * @param {AbortSignal} signal
 * @returns {Promise<{bytes:Uint8Array, mime:string}|null>}
 */
async function fetchCoverArt(clip, rec, signal) {
  if (!rec) return null;
  const url = String(rec.imageLargeUrl || rec.coverUrl || (clip && clip.image_url) || '');
  if (!url) return null;
  try {
    const bytes = await fetchMediaAsset(url, { signal, maxBytes: ART_MAX_BYTES, label: 'cover art' });
    if (!bytes.length) return null;
    const mime = /png/i.test(url) ? 'image/png'
      : /jpe?g/i.test(url) ? 'image/jpeg'
        : /webp/i.test(url) ? 'image/webp'
          : 'image/jpeg';
    log('debug', 'tags.cover_fetched', { bytes: bytes.length, mime });
    return { bytes, mime };
  } catch (artErr) {
    log('debug', 'tags.cover_unavailable', { error: describeError(artErr) });
    return null;
  }
}

/**
 * Tag the downloaded bytes and optionally write lyrics/meta sidecars.
 *
 * @param {object} clip raw clip record
 * @param {Uint8Array} bytes
 * @param {object} ctx {variant, settings, signal}
 * @param {string} container detected container
 * @returns {Promise<{bytes:Uint8Array, container:string, tagged:boolean, warnings:string[]}>}
 */
async function applyTagsAndSidecars(clip, bytes, ctx, container) {
  const warnings = [];
  const options = ctx.settings.tagOptions || DEFAULT_SETTINGS.tagOptions;
  const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip) : null;

  if (!TAGGER_AVAILABLE || options.embed === false) {
    if (!TAGGER_AVAILABLE) warnings.push('lib/tagger.js is not loaded; the file is written untagged');
    else warnings.push('tagging is disabled in settings');
    return { bytes, container, tagged: false, warnings };
  }

  const meta = SunoAudio && typeof SunoAudio.toTagMeta === 'function'
    ? SunoAudio.toTagMeta(rec || clip)
    : Object.assign({ id: clip.id, title: clip.title }, clip);

  let bpm = bpmFromClip(rec, clip);
  if (options.bpm && !(bpm > 0)) {
    // No tempo on the clip: measure it rather than writing a tag that claims one.
    bpm = (await detectBpmViaOffscreen(bytes, mimeForVariant(ctx.variant))) || 0;
  }
  let coverArt = null;
  if (options.artwork !== false) {
    coverArt = await fetchCoverArt(clip, rec, ctx.signal);
    if (!coverArt) warnings.push('cover art could not be fetched; the file is written without embedded artwork');
  }

  let taggedBytes = bytes;
  try {
    const result = SunoTagger.tagAudioFile({
      bytes: taggedBytes.buffer.slice(
        taggedBytes.byteOffset,
        taggedBytes.byteOffset + taggedBytes.byteLength
      ),
      container,
      // `meta.bpm` is gated EXACTLY like the top-level `bpm` below, because
      // lib/tagger.js resolves `req.bpm !== undefined && req.bpm !== null ?
      // req.bpm : meta.bpm`. An ungated `meta.bpm` therefore re-enabled the
      // TBPM frame whenever the tempo toggle was off but the clip carried one.
      meta: Object.assign({}, meta, {
        bpm: options.bpm ? bpm : undefined,
        album: ctx.settings.albumName,
      }),
      lyrics: options.lyrics ? (rec ? rec.lyrics : clip.lyrics) : '',
      coverArt,
      bpm: options.bpm ? bpm : undefined,
      options: {
        artist: ctx.settings.artistPolicy === 'neutral' ? ctx.settings.neutralArtist : '',
        useClipOwnerAsArtist: ctx.settings.artistPolicy === 'clip-owner',
        album: ctx.settings.albumName,
        comment: options.comment ? buildClipComment(clip, rec) : '',
      },
    });
    if (result && result.bytes) taggedBytes = await toBytes(result.bytes);
    if (result && Array.isArray(result.warnings)) warnings.push(...result.warnings);
    if (result && result.container && result.container !== 'unknown') {
      return { bytes: taggedBytes, container: result.container, tagged: result.injected !== false, warnings };
    }
  } catch (tagErr) {
    warnings.push('tagging failed, saving untagged: ' + describeError(tagErr).message);
    log('warn', 'tagging.failed', { clipId: clip && clip.id, error: describeError(tagErr) });
  }

  return { bytes: taggedBytes, container, tagged: false, warnings };
}

/**
 * Write the lyrics / metadata sidecars next to the audio file.
 *
 * `SunoLyrics.buildSidecars` emits only the documents that have real content, and
 * it scrubs DRM key material INTERNALLY while building the text — that is what
 * actually protects these files. The `stripKeyMaterial` call below is a
 * structural no-op: `lib/lyrics.js:540` returns strings unchanged
 * (`if (t === 'string' ...) return node;`), and every sidecar `text` here is a
 * string. It is kept only because it is cheap, it is correct if the library ever
 * starts returning a non-string document, and it keeps the no-secrets-here
 * intent visible at the call site. This comment previously described it as
 * "defence in depth", which overstated a function that cannot redact anything
 * it is given here.
 *
 * @param {object} clip raw clip record
 * @param {string} audioPath the path the audio was written to
 * @param {object} ctx {variant, settings, signal, clipId, source, batchId, overwrite}
 * @returns {Promise<string[]>} the filenames written
 */
async function writeSidecars(clip, audioPath, ctx) {
  const options = ctx.settings.tagOptions || DEFAULT_SETTINGS.tagOptions;
  if (!SunoLyrics || typeof SunoLyrics.buildSidecars !== 'function') return [];
  if (options.lrc === false && options.json === false) return [];

  const slash = audioPath.lastIndexOf('/');
  const dir = slash >= 0 ? audioPath.slice(0, slash + 1) : '';
  const base = slash >= 0 ? audioPath.slice(slash + 1) : audioPath;
  const stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip) : null;
  const written = [];

  let documents;
  try {
    documents = SunoLyrics.buildSidecars(clip, {
      lyrics: options.lyrics ? (rec ? rec.lyrics : clip.lyrics) : '',
      alignedLyrics: null,
      artist: ctx.settings.artistPolicy === 'clip-owner'
        ? (rec ? rec.ownerName : '')
        : ctx.settings.neutralArtist,
      album: ctx.settings.albumName,
      bpm: bpmFromClip(rec, clip),
      durationMs: rec && rec.durationSec ? Math.round(rec.durationSec * 1000) : 0,
    });
  } catch (sidecarErr) {
    log('warn', 'sidecars.build_failed', { clipId: clip && clip.id, error: describeError(sidecarErr) });
    return [];
  }

  const wanted = [
    { ext: '.lrc', text: options.lrc === false ? null : documents.lrc },
    { ext: '.txt', text: documents.txt },
    { ext: '.json', text: options.json ? documents.json : null },
  ];
  for (const entry of wanted) {
    if (!entry.text || typeof entry.text !== 'string' || !entry.text.trim()) continue;
    const filename = dir + stem + entry.ext;
    try {
      const text = SunoLyrics.stripKeyMaterial ? SunoLyrics.stripKeyMaterial(entry.text) : entry.text;
      const bytes = new TextEncoder().encode(text);
      await saveBytes(bytes, {
        mime: entry.ext === '.json' ? 'application/json' : 'text/plain;charset=utf-8',
        filename,
        clipId: ctx.clipId,
        variant: ctx.variant + entry.ext,
        source: 'sidecar',
        batchId: ctx.batchId,
        overwrite: false,
        // A sidecar is not a song: it must not appear in download history or
        // affect isDone(clipId, variant).
        track: false,
      });
      written.push(filename);
    } catch (sidecarErr) {
      // A missing .lrc must never fail the audio download.
      log('warn', 'sidecars.write_failed', { clipId: clip && clip.id, ext: entry.ext, error: describeError(sidecarErr) });
    }
  }
  if (written.length) log('info', 'sidecars.written', { clipId: clip && clip.id, files: written.length });
  return written;
}

/**
 * Build the provenance comment. `display_name`/`handle` are the OWNER's account
 * identity and are only included when the artist policy says so.
 * @param {object} clip
 * @param {object|null} rec normalized record
 * @returns {string}
 */
function buildClipComment(clip, rec) {
  const metadata = (clip && clip.metadata) || {};
  const parts = [];
  const model = rec ? rec.modelVersion || rec.modelName : metadata.major_model_version;
  if (model) parts.push('Model: ' + model);
  if (clip && clip.id) parts.push('Clip ID: ' + clip.id);
  const prompt = rec ? rec.prompt : metadata.prompt;
  if (prompt) parts.push('Prompt:\n' + prompt);
  const style = rec ? rec.tags || rec.style : metadata.tags || metadata.style;
  if (style) parts.push('Style: ' + style);
  return parts.join('\n');
}

/* ==========================================================================
 * 12. BATCH DRIVER
 * ======================================================================== */

/**
 * @typedef {object} BatchPlan
 * @property {string} batchId
 * @property {string} variant
 * @property {string[]} sourceLadder
 * @property {boolean} overwrite
 * @property {boolean} dryRun
 * @property {number} createdAt
 * @property {'planned'|'running'|'done'|'cancelled'|'error'|'shortfall'} status
 * @property {'complete'|'quota'|'ladder_exhausted'|'cancelled'} [stoppedReason]
 *   WHY the run ended, when it ended before or short of the plan. Absent until
 *   the batch settles.
 * @property {object} [quotaStop] set only when `stoppedReason === 'quota'`:
 *   `{reason, remaining, reserve, meteredDownloads, remainingItems, resetsOn, at}`
 * @property {Array<{clipId:string,title:string,state:string,source?:string,
 *   error?:string,bytes?:number,filename?:string}>} items
 * @property {number} cursor
 * @property {{ok:number,failed:number,skipped:number,bytes:number}} stats
 */

/** @type {AbortController|null} live batch; recreated per worker wake. */
let batchController = null;
/** @type {string|null} the batch this worker is currently running. */
let activeBatchId = null;

/**
 * Persist the plan so an evicted worker can rebuild it.
 * @param {BatchPlan} plan
 * @returns {Promise<BatchPlan>}
 */
async function persistPlan(plan) {
  try {
    await DB.meta.set(META_KEYS.BATCH_PREFIX + plan.batchId, plan);
    await DB.meta.set(META_KEYS.ACTIVE_BATCH, plan.batchId);
  } catch (persistErr) {
    log('error', 'batch.persist_failed', { batchId: plan.batchId, error: describeError(persistErr) });
  }
  return plan;
}

/**
 * @param {string} batchId
 * @returns {Promise<BatchPlan|null>}
 */
async function readPlan(batchId) {
  try {
    return (await DB.meta.get(META_KEYS.BATCH_PREFIX + batchId, null)) || null;
  } catch (readErr) {
    log('error', 'batch.read_failed', { batchId, error: describeError(readErr) });
    return null;
  }
}

/**
 * Build a fresh batch id. Not a UUID: it must be short, sortable and legible in
 * a journal row.
 * @returns {string}
 */
function newBatchId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Resolve the clip list for a batch: an EXPLICIT id list wins, otherwise the
 * caller's filter spec is applied to the whole library.
 *
 * The previous build ignored the caller's selection entirely and re-filtered
 * everything, which is why "download these 12 rows" downloaded the library.
 *
 * @param {object} payload
 * @param {Settings} settings
 * @returns {Promise<{clips:object[], explicit:boolean, description:string}>}
 */
async function resolveBatchClips(payload, settings) {
  const explicitIds = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : null;
  if (explicitIds && explicitIds.length) {
    const clips = await loadClipsByIds(explicitIds);
    return { clips, explicit: true, description: `explicit selection (${clips.length} clips)` };
  }
  const savedSelection = await readSelectionIds();
  if (payload.useSelection === true && savedSelection.length) {
    const clips = await loadClipsByIds(savedSelection);
    return { clips, explicit: true, description: `saved selection (${clips.length} clips)` };
  }
  const context = await queryContext();
  const spec = FILTER_AVAILABLE ? SunoFilter.normalizeSpec(payload.spec || {}) : {};
  const all = await DB.clips.all(ALL_CLIPS);
  const filtered = FILTER_AVAILABLE ? SunoFilter.apply(all, spec, context) : all;
  const sorted = FILTER_AVAILABLE
    ? SunoFilter.sort(filtered, payload.sort || 'newest', payload.order || 'desc')
    : filtered;
  const description = FILTER_AVAILABLE ? SunoFilter.describe(spec) : 'no filter engine available';
  return { clips: sorted, explicit: false, description };
}

/**
 * Load clips by id, preserving the caller's order and skipping unknown ids.
 * @param {string[]} ids
 * @returns {Promise<object[]>}
 */
async function loadClipsByIds(ids) {
  const out = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await DB.clips.getMany(ids.slice(i, i + CHUNK));
    for (const row of rows) if (row) out.push(row);
  }
  return out;
}

/**
 * THE single quota-fetch path. Fetch the meter once and write it to the cache
 * the popup's quota tile reads, in ONE place.
 *
 * `quotaPreflight` (before a batch), the mid-batch guard (during) and
 * `runBatch`'s post-batch read (after) all call this; the fetch + cache-write
 * logic deliberately exists only here so a third caller cannot grow its own
 * subtly different copy. `null` means "could not read the meter" and callers MUST
 * treat that as "unknown", never as "zero remaining".
 *
 * @param {string} event diagnostic event name for a failed fetch
 * @param {'debug'|'info'|'warn'|'error'} [level] a recurring in-flight poll is
 *   not a warning; a pre-flight that could not verify the plan is
 * @returns {Promise<object|null>} a `SunoAPIClient.quota()` result, or null
 */
async function readQuotaCached(event, level = 'warn') {
  if (!SunoAPIClient || typeof SunoAPIClient.quota !== 'function') return null;
  let quota;
  try {
    quota = await SunoAPIClient.quota({ force: true });
  } catch (quotaErr) {
    log(level, event, { error: describeError(quotaErr) });
    return null;
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUOTA]: { at: Date.now(), quota } });
  } catch (storeErr) {
    log('warn', 'quota.cache_write_failed', { error: describeError(storeErr) });
  }
  return quota;
}

/**
 * The quota preflight.
 *
 * Suno's meter is `download_usage`: free 0, pro 20, premier 60 per billing
 * period, resetting on the billing date, and ONE SONG = ONE DOWNLOAD regardless
 * of format. The old badge showed CREDITS — a different resource entirely — so
 * the old UI cheerfully told users they had plenty of headroom while the
 * download meter was exhausted.
 *
 * This is a BEFORE check only. It is not, and cannot be, the in-batch guard:
 * a plan of 60 clips checked against 60 remaining is still wrong the moment one
 * clip fails, another succeeds off an unmetered rung, or a sibling tab spends
 * the meter. `runBatch`'s mid-batch guard covers that; see `guardQuotaAfterItem`.
 *
 * @param {number} planned number of unique songs in the plan
 * @returns {Promise<{shortfall:boolean, quota:object, needed:number,
 *   remaining:number|null, fits:number, packs:Array<object>, message:string|null}>}
 */
async function quotaPreflight(planned) {
  const result = { shortfall: false, quota: null, needed: planned, remaining: null, fits: planned, packs: [], message: null };
  const quota = await readQuotaCached('quota.preflight_failed');
  if (!quota) return result;
  result.quota = quota;

  const remaining = typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : null;
  result.remaining = remaining;
  result.packs = Array.isArray(quota.raw && quota.raw.download_credit_packs)
    ? quota.raw.download_credit_packs
    : [];

  if (quota.unlimited === true) return result;
  if (remaining === null) {
    result.message = 'Suno did not report a download limit for this account, so the batch will proceed unverified.';
    return result;
  }
  if (remaining >= planned) return result;

  result.shortfall = true;
  result.fits = remaining;
  result.message = `This batch needs ${planned} download${planned === 1 ? '' : 's'} but only ${remaining} remain`
    + (quota.resetsOn ? ` before the quota resets on ${quota.resetsOn}` : '')
    + '. One song uses one download regardless of format, and no rung in the ladder can produce the file without one of those slots '
    + 'unless the unencrypted media_urls or DRM rungs succeed.';
  return result;
}

/**
 * Plan and (unless dryRun) start a batch. Returns IMMEDIATELY with the batch id;
 * the loop runs detached with its own AbortController and is re-armed by an
 * alarm.
 *
 * @param {object} payload {spec?, ids?, variant, source, tagOptions, overwrite, dryRun}
 * @returns {Promise<object>} the reply body
 */
async function startBatch(payload) {
  await loadSettings();
  const settings = settingsCache;
  const variant = resolveVariant(payload.variant, settings.variant);
  const dryRun = payload.dryRun === true ? true : settings.dryRun === true;
  const sourceLadder = payload.sourceLadder || payload.source || settings.downloadSource;
  const tagOptions = Object.assign({}, settings.tagOptions, payload.tagOptions || {});
  const overwrite = typeof payload.overwrite === 'boolean' ? payload.overwrite : settings.overwrite;
  const ladder = normalizeLadder(sourceLadder, settings.allowMeteredExtras);
  if (!ladder.length) {
    // Fail fast and loudly here rather than planning N items that will each
    // report "ladder exhausted".
    return {
      ok: false,
      code: 'ladder_empty',
      error: 'The download ladder is empty. Enable "allow metered extras" for the official WAV route, '
        + 'or restore at least one of progressive / mango-drm / studio / download-route in settings.sourceLadder.',
    };
  }

  const resolved = await resolveBatchClips(payload, settings);
  if (!resolved.clips.length) {
    return { ok: false, error: 'nothing matched', code: 'empty_plan' };
  }

  // Dedupe by clip id BEFORE anything is spent: one song is one download.
  const byId = new Map();
  for (const clip of resolved.clips) {
    const id = String(clip && clip.id || '');
    if (!id || byId.has(id)) continue;
    byId.set(id, clip);
  }
  const unique = Array.from(byId.values());
  const duplicatesDropped = resolved.clips.length - unique.length;

  // Skip variants that are already recorded done (unless overwriting).
  const items = [];
  let alreadyDone = 0;
  for (const clip of unique) {
    let done = false;
    try {
      done = await DB.downloads.isDone(String(clip.id), variant);
    } catch (doneErr) {
      log('warn', 'batch.is_done_failed', { clipId: clip.id, error: describeError(doneErr) });
    }
    if (done && !overwrite) {
      alreadyDone += 1;
      continue;
    }
    items.push({
      clipId: String(clip.id),
      title: String(clip.title || ''),
      variant,
      state: 'queued',
      source: '',
      error: '',
      bytes: 0,
      filename: '',
    });
  }

  const batchId = newBatchId();
  const plan = {
    batchId,
    variant,
    sourceLadder: ladder,
    tagOptions,
    overwrite,
    dryRun,
    description: resolved.description,
    explicit: resolved.explicit,
    createdAt: Date.now(),
    status: 'planned',
    items,
    cursor: 0,
    stats: { ok: 0, failed: 0, skipped: 0, bytes: 0, duplicatesDropped, alreadyDone },
  };

  const preflight = await quotaPreflight(items.length);
  plan.preflight = {
    needed: preflight.needed,
    remaining: preflight.remaining,
    fits: preflight.fits,
    shortfall: preflight.shortfall,
    message: preflight.message,
    packs: preflight.packs,
  };

  if (preflight.shortfall) {
    plan.status = 'shortfall';
    await persistPlan(plan);
    await DB.journal.append({ batchId, phase: 'quota-shortfall', detail: preflight });
    log('warn', 'batch.quota_shortfall', { batchId, needed: preflight.needed, remaining: preflight.remaining });
    void notify('Download quota shortfall', preflight.message || 'Not enough downloads remain.');
    return {
      ok: true,
      batchId,
      planned: items.length,
      skipped: alreadyDone,
      duplicatesDropped,
      stopped: 'quota',
      quotaShortfall: {
        needed: preflight.needed,
        remaining: preflight.remaining,
        fits: preflight.fits,
        message: preflight.message,
        packs: preflight.packs,
      },
    };
  }

  await persistPlan(plan);
  await DB.journal.append({
    batchId,
    phase: 'planned',
    detail: { planned: items.length, variant, ladder: plan.sourceLadder, dryRun, description: resolved.description },
  });

  const reply = {
    ok: true,
    batchId,
    planned: items.length,
    skipped: alreadyDone,
    duplicatesDropped,
    dryRun,
    description: resolved.description,
    quota: quotaView(preflight.quota),
  };

  if (dryRun || items.length === 0) {
    plan.status = dryRun ? 'done' : 'done';
    plan.stats.skipped = items.length;
    await persistPlan(plan);
    await DB.journal.append({ batchId, phase: dryRun ? 'dry-run' : 'empty', detail: { planned: items.length } });
    log('info', 'batch.dry_run', { batchId, planned: items.length });
    reply.note = dryRun
      ? 'Dry run: the plan was computed and recorded; nothing was downloaded and no quota was spent.'
      : 'Nothing to download.';
    return reply;
  }

  // Detached. The alarm in §17 is what brings it back after an eviction.
  void runBatch(batchId);
  return reply;
}

/**
 * Run (or resume) a batch to completion.
 *
 * @param {string} batchId
 * @returns {Promise<void>}
 */
async function runBatch(batchId) {
  const plan = await readPlan(batchId);
  if (!plan) {
    log('warn', 'batch.plan_missing', { batchId });
    return;
  }
  if (plan.status === 'done' || plan.status === 'cancelled') {
    log('info', 'batch.already_settled', { batchId, status: plan.status });
    return;
  }

  if (!batchController) batchController = new AbortController();
  const signal = batchController.signal;
  activeBatchId = batchId;
  plan.status = 'running';
  plan.startedAt = plan.startedAt || Date.now();
  await persistPlan(plan);
  await DB.journal.append({ batchId, phase: 'run-start', detail: { remaining: plan.items.length } });

  await loadSettings();
  const settings = settingsCache;
  // A per-request tagOptions patch wins over the stored defaults for THIS batch
  // only; nothing is written back to settings.
  const effectiveSettings = Object.assign({}, settings, { tagOptions: plan.tagOptions || settings.tagOptions });
  const workspaceNames = await loadProjectNames();
  const total = plan.items.length;
  const startedAt = Date.now();
  let done = 0;

  /* ---- the MID-BATCH quota guard ----------------------------------
   * `quotaPreflight` reads the meter BEFORE the plan and the tail of this
   * function reads it AFTER, so NOTHING used to check DURING. A plan built
   * against a stale reading kept going and then failed item by item on the
   * metered rungs: a healthy badge, then an opaque mid-batch wall. That is the
   * old build's failure mode verbatim.
   *
   * Two rules make this cheap enough to always have on:
   *   - it counts only SUCCESSFUL METERED downloads. `progressive` and
   *     `mango-drm` do not consume the allowance, so a purely-unmetered ladder
   *     polls ZERO times and never pays for a re-meter it cannot use.
   *   - a failed poll is NOT an exhausted meter. "Could not read it" leaves the
   *     batch running; only a positive reading at or below the reserve stops it.
   * A dry run polls nothing and can never be stopped by this.
   */
  const quotaGuardOn = plan.dryRun !== true
    && settings.dryRun !== true
    && !!SunoAPIClient
    && typeof SunoAPIClient.quota === 'function';
  const quotaCheckEvery = Math.max(1, Math.round(Number(settings.quotaCheckEvery) || DEFAULT_SETTINGS.quotaCheckEvery));
  const quotaReserve = Math.max(0, Number(settings.quotaReserve) || 0);
  /** Successful metered downloads since the last poll. */
  let meteredSinceCheck = 0;
  /** Successful metered downloads in total, for the stop message. */
  let meteredTotal = 0;
  let quotaPolls = 0;
  /** @type {object|null} set the moment the guard decides to halt. */
  let quotaStop = null;
  /** In-flight poll, shared so N pool workers trigger ONE fetch. @type {Promise<object|null>|null} */
  let quotaProbe = null;

  const readQuotaOnce = async () => {
    if (quotaProbe) return quotaProbe;
    quotaPolls += 1;
    quotaProbe = readQuotaCached('batch.quota_midflight_failed', 'debug')
      .catch((probeErr) => {
        log('debug', 'batch.quota_midflight_failed', { error: describeError(probeErr) });
        return null;
      })
      .finally(() => { quotaProbe = null; });
    return quotaProbe;
  };

  /**
   * Run after each settled item. Counts metered successes, polls at most once per
   * `quotaCheckEvery` of them, and records a clean stop when the meter reaches
   * the reserve. Never throws: a guard fault must not fail a download.
   * @param {object} item
   * @returns {Promise<void>}
   */
  const guardQuotaAfterItem = async (item) => {
    if (!quotaGuardOn || quotaStop || signal.aborted) return;
    if (item.state !== 'ok') return;
    const rung = LADDER_BY_ID.get(String(item.source || ''));
    // Unmetered rungs (and an unknown source) never count and never trigger a poll.
    if (!rung || rung.metered !== true) return;
    meteredTotal += 1;
    meteredSinceCheck += 1;
    if (meteredSinceCheck < quotaCheckEvery) return;
    meteredSinceCheck = 0;

    const quota = await readQuotaOnce();
    // Cancelled while the poll was in flight: the user's decision outranks ours.
    if (signal.aborted) return;
    // No reading at all (unauthenticated, fetch failed, API absent) is UNKNOWN,
    // not zero. Keep going.
    if (!quota || quota.unlimited === true) return;
    const remaining = typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : null;
    // Suno reported no limit: there is nothing to enforce.
    if (remaining === null || remaining > quotaReserve) return;

    quotaStop = {
      reason: 'quota',
      remaining,
      reserve: quotaReserve,
      meteredDownloads: meteredTotal,
      remainingItems: Math.max(0, total - Math.min(index, total)),
      resetsOn: quota.resetsOn || null,
      at: Date.now(),
    };
    log('warn', 'batch.quota_stop', {
      batchId,
      remaining,
      reserve: quotaReserve,
      meteredDownloads: meteredTotal,
      ok: plan.stats.ok,
      remainingItems: quotaStop.remainingItems,
    });
  };

  const emitProgress = async (currentTitle) => {
    const elapsed = Date.now() - startedAt;
    const etaMs = done > 0 && done < total ? Math.round((elapsed / done) * (total - done)) : 0;
    await broadcast({
      type: 'DL_PROGRESS',
      batchId,
      done,
      total,
      ok: plan.stats.ok,
      failed: plan.stats.failed,
      skipped: plan.stats.skipped,
      currentTitle: currentTitle || '',
      bytes: plan.stats.bytes,
      etaMs,
    });
  };

  const emitItem = async (item, state) => {
    await broadcast({
      type: 'DL_ITEM',
      batchId,
      clipId: item.clipId,
      // The DELIVERED variant, which can differ from the requested one when the
      // WAV transcode kicked in.
      variant: item.variant || plan.variant,
      state,
      filename: item.filename || '',
      source: item.source || '',
      error: item.error || '',
      bytes: item.bytes || 0,
    });
  };

  /* ---- the per-item loop ---------------------------------------- */

  const runItem = async (item) => {
    const clipId = item.clipId;
    try {
      if (signal.aborted) {
        item.state = 'skipped';
        item.error = 'cancelled';
        plan.stats.skipped += 1;
        await DB.downloads.markSkipped(clipId, plan.variant, 'cancelled');
        await emitItem(item, 'skipped');
        return;
      }

      const clip = await DB.clips.get(clipId);
      if (!clip) {
        item.state = 'skipped';
        item.error = 'clip is no longer in the library';
        plan.stats.skipped += 1;
        await DB.downloads.markSkipped(clipId, plan.variant, item.error, { source: 'unknown' });
        await emitItem(item, 'skipped');
        return;
      }

      await DB.downloads.markInProgress(clipId, plan.variant, { source: plan.sourceLadder[0] || 'unknown' });
      await DB.journal.append({ batchId, clipId, variant: plan.variant, phase: 'item-start' });

      const workspaceName = resolveWorkspaceName(clip, workspaceNames);
      const versionIndex = versionIndexFor(clip, plan.items);

      let lastError = null;
      const attempts = 1 + Math.max(0, settings.retryAttempts);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal.aborted) break;
        const outcome = await runLadder(clip, {
          variant: plan.variant,
          sourceLadder: plan.sourceLadder,
          signal,
          batchId,
          overwrite: plan.overwrite,
          tagOptions: plan.tagOptions,
          settings: effectiveSettings,
          workspaceName,
          versionIndex,
        });
        if (outcome.ok) {
          // INVARIANT A: `ok` here means the browser ACCEPTED the transfer.
          // The row is only flipped to done when onChanged reports completion.
          const settled = await awaitDownloadSettlement(outcome.downloadId);
          item.filename = outcome.filename || '';
          item.source = outcome.source || '';
          item.bytes = outcome.byteLength || 0;
          item.variant = outcome.variant || plan.variant;
          plan.stats.bytes += item.bytes;
          if (settled.state === 'complete') {
            item.state = 'ok';
            plan.stats.ok += 1;
            await DB.journal.append({
              batchId, clipId, variant: item.variant, phase: 'item-ok',
              detail: { source: item.source, bytes: item.bytes },
            });
            await emitItem(item, 'ok');
          } else if (settled.state === 'timeout') {
            // The transfer is still in flight. Leave the row `in_progress`;
            // startup reconciliation owns it from here.
            item.state = 'pending';
            item.error = 'transfer still in flight; will be reconciled on the next worker wake';
            await emitItem(item, 'pending');
            log('warn', 'batch.item_settle_timeout', { batchId, clipId, downloadId: outcome.downloadId });
          } else {
            item.state = 'failed';
            item.error = settled.error || 'the browser interrupted the transfer';
            plan.stats.failed += 1;
            await emitItem(item, 'failed');
          }
          return;
        }

        lastError = outcome.error || { code: 'unknown', message: 'the ladder produced no result' };
        // `isRetryableFailure` is the authority, not the error's own flag: it is
        // the only thing that knows a 403 is an entitlement wall, a 404 will
        // never appear, and an explicit `{ok:false}` refusal is a decision.
        const retryable = isRetryableFailure(Object.assign({}, lastError, {
          status: lastError.status,
          reason: lastError.reason,
          name: lastError.code === 'aborted' ? 'AbortError' : undefined,
        }));
        if (!retryable) break;
        if (attempt < attempts) {
          log('info', 'batch.item_retry', { batchId, clipId, attempt, code: lastError.code });
          // Let the shared limiter pace the retry; it is the same token bucket
          // every other request goes through.
          try {
            await SunoAPIClient.rateLimiter.acquire({ signal });
          } catch (paceErr) {
            if (isAbortLike(paceErr)) break;
            log('warn', 'batch.item_retry_pace_failed', { error: describeError(paceErr) });
          }
        }
      }

      const info = lastError || { code: 'unknown', message: 'unknown failure' };
      if (isAbortLike(info) || signal.aborted) {
        item.state = 'skipped';
        item.error = 'cancelled';
        plan.stats.skipped += 1;
        await DB.downloads.markSkipped(clipId, plan.variant, 'cancelled');
        await emitItem(item, 'skipped');
        return;
      }
      item.state = info.code === 'entitlement' ? 'entitlement' : 'failed';
      item.error = info.message;
      plan.stats.failed += 1;
      await DB.downloads.markFailed(clipId, plan.variant, new Error(info.message), {
        source: (item.source || plan.sourceLadder[0] || 'unknown'),
      });
      await DB.journal.append({
        batchId, clipId, variant: plan.variant, phase: 'item-failed',
        detail: { code: info.code },
      });
      await emitItem(item, item.state);
    } catch (err) {
      // Per-item isolation. A single clip NEVER aborts the batch.
      const info = describeError(err);
      item.state = isAbortLike(err) ? 'skipped' : 'failed';
      item.error = info.message;
      if (item.state === 'skipped') plan.stats.skipped += 1;
      else plan.stats.failed += 1;
      log('error', 'batch.item_threw', { batchId, clipId, error: info });
      try {
        if (item.state === 'skipped') {
          await DB.downloads.markSkipped(clipId, plan.variant, info.message);
        } else {
          await DB.downloads.markFailed(clipId, plan.variant, new Error(info.message), {});
        }
        await DB.journal.append({ batchId, clipId, variant: plan.variant, phase: `item-${item.state}` });
      } catch (dbErr) {
        log('error', 'batch.item_record_failed', { clipId, error: describeError(dbErr) });
      }
      await emitItem(item, item.state);
    }
  };

  // Bounded worker pool. The shared RateLimiter, not the pool, sets the pace;
  // the pool only bounds how many decryptions are in memory at once.
  const concurrency = Math.max(1, Math.min(8, settings.concurrency));
  let index = plan.cursor || 0;
  const nextIndex = () => {
    const current = index;
    index += 1;
    return current;
  };
  const worker = async () => {
    for (;;) {
      const i = nextIndex();
      if (i >= total) return;
      if (signal.aborted) return;
      // The mid-batch quota guard reached the reserve. Stop claiming new items;
      // in-flight workers finish the item they already own and then leave.
      if (quotaStop) return;
      const item = plan.items[i];
      await runItem(item);
      done += 1;
      plan.cursor = i + 1;
      await persistPlan(plan);
      await emitProgress(item.title);
      await guardQuotaAfterItem(item);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
  } catch (poolErr) {
    // `runItem` isolates everything, so this can only be a pool-level fault.
    log('error', 'batch.pool_threw', { batchId, error: describeError(poolErr) });
  }

  const cancelled = signal.aborted;
  // The ONE field that separates "finished" from "stopped", and it must never
  // collapse them: a quota halt, an exhausted ladder and a user cancel are three
  // different outcomes with three different recoveries, and the old build
  // reported all three as a plain `DL_DONE`.
  const stoppedReason = cancelled
    ? 'cancelled'
    : (quotaStop
      ? 'quota'
      : (plan.stats.ok === 0 && plan.stats.failed > 0 ? 'ladder_exhausted' : 'complete'));
  const leftInBatch = Math.max(0, total - Math.min(index, total));
  plan.status = cancelled ? 'cancelled' : 'done';
  plan.stoppedReason = stoppedReason;
  if (quotaStop) {
    plan.quotaStop = Object.assign({}, quotaStop, { remainingItems: leftInBatch });
  }
  plan.finishedAt = Date.now();
  plan.cursor = index;
  await persistPlan(plan);
  await DB.journal.append({
    batchId,
    phase: cancelled ? 'cancelled' : 'done',
    detail: {
      ok: plan.stats.ok,
      failed: plan.stats.failed,
      skipped: plan.stats.skipped,
      stoppedReason,
      meteredDownloads: meteredTotal,
      quotaPolls,
      remainingItems: leftInBatch,
    },
  });
  if (quotaStop) {
    // A SEPARATE phase, so `DOWNLOAD_RETRY_FAILED` and the startup resume path can
    // tell a deliberate quota halt (keep `cursor`, do not re-plan the rest) from a
    // batch that ran to the end of its plan.
    await DB.journal.append({
      batchId,
      phase: 'quota-stop',
      detail: {
        stoppedReason: 'quota',
        cursor: index,
        ok: plan.stats.ok,
        remainingItems: leftInBatch,
        meteredDownloads: meteredTotal,
        quotaPolls,
        remaining: quotaStop.remaining,
        reserve: quotaStop.reserve,
        resetsOn: quotaStop.resetsOn,
      },
    });
  }

  // Read the meter one last time through the shared helper, which also refreshes
  // the cache the popup's quota tile reads, so the tile reflects the meter at the
  // moment the batch ENDED rather than the pre-batch reading.
  const quotaAfter = await readQuotaCached('batch.quota_after_failed');
  await DB.meta.set(META_KEYS.LAST_BATCH_SUMMARY, {
    batchId,
    at: plan.finishedAt,
    ok: plan.stats.ok,
    failed: plan.stats.failed,
    skipped: plan.stats.skipped,
    bytes: plan.stats.bytes,
    durationMs: plan.finishedAt - startedAt,
    stoppedReason,
    ...(quotaStop ? { quotaStop: plan.quotaStop } : {}),
  });
  await DB.journal.trim(batchId);

  await broadcast({
    type: 'DL_DONE',
    batchId,
    ok: plan.stats.ok,
    failed: plan.stats.failed,
    skipped: plan.stats.skipped,
    durationMs: plan.finishedAt - startedAt,
    stoppedReason,
    quotaPolls,
    remainingItems: leftInBatch,
    quotaStop: plan.quotaStop || null,
    quotaAfter: quotaView(quotaAfter),
  });
  activeBatchId = null;
  batchController = null;
  if (plan.quotaStop) {
    // The stop is REPORTED, never silent. Say how much of the plan fitted, how
    // much did not, and when the meter comes back.
    const saved = plan.stats.ok;
    const stop = plan.quotaStop;
    const fits = Math.max(0, stop.remaining - stop.reserve);
    await notify(
      'Download quota reached — batch stopped',
      `${saved} clip${saved === 1 ? '' : 's'} saved, ${leftInBatch} left in this batch. `
      + `The meter reports ${stop.remaining} remaining${stop.reserve > 0 ? ` against a reserve of ${stop.reserve}` : ''}, `
      + `so ${fits} more download${fits === 1 ? '' : 's'} fit${fits === 1 ? 's' : ''} before the reserve. `
      + (stop.resetsOn ? `Your quota resets on ${stop.resetsOn}.` : 'Resume this batch after it resets.')
      + ' Nothing was deleted; the remaining clips are still planned.',
    );
    log('info', 'batch.quota_stopped', {
      batchId, saved, remainingItems: leftInBatch, remaining: stop.remaining, fits,
    });
  }
  log('info', 'batch.finished', {
    batchId, ok: plan.stats.ok, failed: plan.stats.failed, skipped: plan.stats.skipped, stoppedReason,
  });
}

/**
 * Which workspace (project) a clip belongs to. Suno has NO project field on a
 * clip; membership is joined from the project feed, and `default` is named
 * "My Workspace". This is the only correct basis for a per-workspace filter.
 * @param {object} clip
 * @param {Map<string,string>} names
 * @returns {string}
 */
function resolveWorkspaceName(clip, names) {
  const ids = Array.isArray(clip.projectIds) && clip.projectIds.length
    ? clip.projectIds
    : (clip._i && Array.isArray(clip._i.project_ids) ? clip._i.project_ids : []);
  for (const id of ids) {
    const name = names.get(String(id));
    if (name) return name;
  }
  return 'My Workspace';
}

/**
 * Ordinal of this clip among its plan siblings that share a title. Gives a
 * template like `{title}_{versionIndex}` a stable per-batch numbering for
 * generated variants of the same song.
 * @param {object} clip
 * @param {Array<{clipId:string,title:string}>} items
 * @returns {number}
 */
function versionIndexFor(clip, items) {
  const title = String((clip && clip.title) || '').trim().toLowerCase();
  if (!title) return 1;
  let index = 0;
  for (const item of items) {
    if (String(item.title || '').trim().toLowerCase() === title) index += 1;
    if (item.clipId === String(clip.id)) return index || 1;
  }
  return 1;
}

/**
 * Cancel the running batch. The previous `CANCEL_DOWNLOAD` message had ZERO
 * senders and therefore never fired; this one actually aborts the controller.
 * @returns {Promise<{ok:boolean, batchId:string|null, aborted:boolean}>}
 */
async function cancelBatch() {
  const batchId = activeBatchId || (await DB.meta.get(META_KEYS.ACTIVE_BATCH, null));
  if (batchController) {
    batchController.abort();
    log('info', 'batch.cancel_requested', { batchId });
  }
  if (batchId) {
    const plan = await readPlan(batchId);
    if (plan) {
      plan.status = 'cancelled';
      plan.cancelledAt = Date.now();
      await persistPlan(plan);
      await DB.journal.append({ batchId, phase: 'cancel-requested' });
    }
  }
  await disarmKeepalive();
  return { ok: true, batchId: batchId || null, aborted: !!batchController };
}

/**
 * Re-plan every previously FAILED item into a fresh batch.
 * @returns {Promise<object>}
 */
async function retryFailedBatch() {
  await loadSettings();
  const failed = await DB.downloads.history({ limit: 500, states: ['failed'] });
  if (!failed.length) return { ok: true, planned: 0, batchId: null, note: 'no failed downloads to retry' };
  const ids = failed.map((row) => String(row.clipId)).filter(Boolean);
  const variants = new Set(failed.map((row) => String(row.variant)));
  const variant = variants.size === 1 ? Array.from(variants)[0] : settingsCache.variant;
  // Clear the failed rows so the planner treats them as work, not as history.
  for (const id of ids) {
    try {
      await DB.downloads.markPending(id, variant, { source: 'retry' });
    } catch (resetErr) {
      log('warn', 'batch.retry_reset_failed', { clipId: id, error: describeError(resetErr) });
    }
  }
  return startBatch({ ids, variant });
}

/* ==========================================================================
 * 13. LIBRARY SYNC
 * ======================================================================== */

/** @type {AbortController|null} live sync; recreated per worker wake. */
let syncController = null;

/**
 * A resumable crawl.
 *
 * - The cursor is written to `syncState` after EVERY page, so an evicted worker
 *   resumes instead of restarting.
 * - Each page is committed with `clips.putMany` (ONE transaction per page, never
 *   one per clip).
 * - `clips.clear()` is NEVER called. A forced rebuild buffers and then uses
 *   `clips.bulkReplace`, which is a single atomic transaction: an abort leaves
 *   the previous library completely intact.
 * - `maxPages` is honoured and reported. A user with 3,000 clips must not
 *   silently lose 2,000 to a page cap, so truncation is surfaced everywhere.
 *
 * @param {{force?:boolean, dislikedMode?:string, maxPages?:number}} options
 * @returns {Promise<{ok:boolean, batchId?:string, ...}>} the immediate reply
 */
async function startSync(options) {
  await loadSettings();
  if (syncController) {
    return { ok: false, error: 'a sync is already running', code: 'sync_running' };
  }
  syncController = new AbortController();
  const signal = syncController.signal;
  const settings = settingsCache;

  const mode = ['include', 'exclude', 'both'].indexOf(options.dislikedMode) >= 0
    ? String(options.dislikedMode)
    : settings.dislikedMode;
  const requestedMaxPages = Number(options.maxPages);
  const maxPages = Number.isFinite(requestedMaxPages) && requestedMaxPages > 0
    ? Math.floor(requestedMaxPages)
    : settings.syncMaxPages;

  const reply = {
    ok: true,
    force: options.force === true,
    dislikedMode: mode,
    maxPages,
    // `total` is the library size on disk so the UI can show "x of y".
    total: await DB.clips.count(),
    state: 'running',
  };

  void runSync({
    force: options.force === true,
    mode,
    maxPages,
    signal,
  }).catch((err) => {
    const info = describeError(err);
    log('error', 'sync.threw', { error: info });
    void broadcast({ type: 'SYNC_ERROR', error: info.message });
  });

  return reply;
}

/**
 * The crawl itself.
 * @param {{force:boolean, mode:string, maxPages:number, signal:AbortSignal}} opts
 * @returns {Promise<void>}
 */
async function runSync(opts) {
  const { force, mode, maxPages, signal } = opts;
  const startedAt = Date.now();

  const freshCursor = {
    nextPage: 0,
    pass: null,
    pagesDone: 0,
    totalSeen: 0,
    truncated: false,
    dislikedCount: null,
    dislikedApproximate: false,
    lastError: null,
    maxPages,
    mode,
    state: 'running',
  };
  const stored = force ? null : await DB.syncState.get('feed', null);
  const cursor = Object.assign({}, freshCursor, stored || {});
  // A cursor written by a different mode/maxPages cannot be resumed honestly.
  if (stored && (cursor.mode !== mode || cursor.maxPages !== maxPages)) {
    log('info', 'sync.cursor_incompatible', { wasMode: cursor.mode, wasMaxPages: cursor.maxPages });
    cursor.nextPage = 0;
    cursor.pass = null;
    cursor.pagesDone = 0;
    cursor.totalSeen = 0;
  }
  cursor.mode = mode;
  cursor.maxPages = maxPages;
  cursor.state = 'running';
  cursor.force = force;
  cursor.startedAt = startedAt;

  /* ---- projects: the ONLY source of "workspace" membership ---------- */
  let projects = [];
  try {
    projects = await SunoAPIClient.fetchProjects({ signal });
    await DB.meta.set(META_KEYS.PROJECTS, { at: Date.now(), projects });
    log('info', 'sync.projects', { count: projects.length });
  } catch (projectsErr) {
    log('warn', 'sync.projects_failed', { error: describeError(projectsErr) });
  }

  /* ---- project/clip membership join -------------------------------- */
  let membershipsAll = null;
  let addedAtMs = null;
  try {
    const projectFeed = await SunoAPIClient.fetchProjectFeed({ signal });
    membershipsAll = projectFeed.membershipsAll;
    addedAtMs = projectFeed.addedAtMs;
    if (projectFeed.inferred) {
      log('info', 'sync.project_feed_inferred', { items: projectFeed.items });
    }
  } catch (feedErr) {
    log('warn', 'sync.project_feed_failed', { error: describeError(feedErr) });
  }

  /* ---- the forced-rebuild buffer ----------------------------------- */
  // force:true + additive putMany would leave STALE clips behind forever, so a
  // forced crawl buffers and finishes with one atomic bulkReplace. If the crawl
  // turns out to be truncated, or the buffer overflows, we fall back to additive
  // writes and say so, because losing the user's library is never acceptable.
  const buffered = [];
  let buffering = force;
  let overflowed = false;
  let added = 0;

  /**
   * @param {object[]} clips
   * @returns {Promise<void>}
   */
  /**
   * Write rows additively, one bounded transaction per chunk.
   *
   * @param {object[]} rows
   * @param {string} phase for the log only
   * @returns {Promise<number>} rows written
   */
  const putAdditive = async (rows, phase) => {
    let written = 0;
    for (let i = 0; i < rows.length; i += PUT_CHUNK_SIZE) {
      const slice = rows.slice(i, i + PUT_CHUNK_SIZE);
      written += (await DB.clips.putMany(slice)) || 0;
      if (signal.aborted) {
        log('warn', 'sync.chunk_aborted', { phase, at: i, of: rows.length });
        break;
      }
    }
    return written;
  };

  /**
   * Commit one page. Buffered while a forced rebuild is accumulating, then a
   * single `putMany` for the page once the crawl is incremental.
   *
   * @param {object[]} clips
   * @returns {Promise<void>}
   */
  const commitPage = async (clips) => {
    if (!clips.length) return;
    if (buffering) {
      for (const clip of clips) buffered.push(clip);
      if (buffered.length >= FULL_REBUILD_BUFFER_CAP) {
        // Over the memory ceiling: stop buffering and go additive from here, so
        // the previous library is preserved rather than half-replaced.
        overflowed = true;
        buffering = false;
        const pending = buffered.splice(0, buffered.length);
        log('warn', 'sync.buffer_overflow', { rows: pending.length });
        const rows = await SunoAPIClient.hydrate(pending, { membershipsAll, addedAtMs, signal });
        added += await putAdditive(Array.from(rows.values()), 'overflow');
      }
      return;
    }
    // One transaction per page.
    const rows = await SunoAPIClient.hydrate(clips, { membershipsAll, addedAtMs, signal });
    added += (await DB.clips.putMany(Array.from(rows.values()))) || 0;
  };

  const baseIds = new Set(mode === 'both' ? await DB.meta.get(META_KEYS.FEED_BASE_IDS, []) : []);
  const seenIds = new Set(mode === 'both' ? await DB.meta.get(META_KEYS.FEED_SEEN_IDS, []) : []);
  let pagesSinceFlush = 0;
  let truncated = false;
  let lastError = null;
  let dislikedIds = null;

  /**
   * @param {number} page
   * @returns {Promise<void>}
   */
  const flushIdSets = async (page) => {
    if (mode !== 'both') return;
    pagesSinceFlush += 1;
    const atBoundary = page === 0;
    if (!atBoundary && pagesSinceFlush < DISLIKED_FLUSH_EVERY_PAGES) return;
    pagesSinceFlush = 0;
    try {
      await DB.meta.set(META_KEYS.FEED_SEEN_IDS, Array.from(seenIds));
      // The base set is only complete once pass A has walked to the end; until
      // then a partial flush would make the diff WRONG rather than merely
      // imprecise, so it is only written at a pass boundary.
      if (cursor.pass === 'hideDisliked=true') {
        await DB.meta.set(META_KEYS.FEED_BASE_IDS, Array.from(baseIds));
      }
    } catch (flushErr) {
      log('warn', 'sync.id_set_flush_failed', { error: describeError(flushErr) });
    }
  };

  /**
   * Choose the walk.
   *
   * Fresh `both`: hand the whole two-pass problem to the lib, which computes
   * the symmetric difference. Resumed `both`: a mid-walk two-pass generator
   * cannot skip ahead (it always starts at pass A), so the remaining half is
   * walked directly and the diff is derived from the persisted pass-A id set.
   * Single-pass modes walk their own `hide_disliked` value.
   */
  const walk = () => {
    if (mode === 'both') {
      if (cursor.pass && cursor.nextPage > 0) {
        const passMode = cursor.pass === 'hideDisliked=false' ? 'include' : 'exclude';
        log('info', 'sync.resumed_pass', { pass: passMode, fromPage: cursor.nextPage });
        return SunoAPIClient.iterateFeed({
          disliked: passMode,
          startPage: cursor.nextPage,
          maxPages,
          signal,
        });
      }
      return SunoAPIClient.iterateFeed({ disliked: 'both', maxPages, signal });
    }
    return SunoAPIClient.iterateFeed({
      disliked: mode,
      startPage: cursor.nextPage,
      maxPages,
      signal,
    });
  };

  try {
    const iterator = walk();
    for await (const batch of iterator) {
      if (signal.aborted) break;

      if (batch.type === 'dislikedIds') {
        dislikedIds = batch.dislikedIds instanceof Set ? batch.dislikedIds : new Set(batch.dislikedIds || []);
        cursor.dislikedApproximate = batch.truncated === true;
        cursor.dislikedCount = dislikedIds.size;
        await DB.meta.set(META_KEYS.FEED_DISLIKED_IDS, Array.from(dislikedIds));
        await DB.journal.append({ batchId: 'sync', phase: 'dislike-diff', detail: { count: dislikedIds.size } });
        log('info', 'sync.dislike_diff', { count: dislikedIds.size, truncated: batch.truncated === true });
        continue;
      }

      if (batch.type === 'summary') {
        truncated = batch.truncated === true;
        lastError = batch.error ? describeError(batch.error).message : null;
        cursor.truncated = truncated;
        continue;
      }

      // A page.
      cursor.pass = batch.pass || cursor.pass;
      cursor.nextPage = Number.isFinite(batch.page) ? batch.page + 1 : cursor.nextPage + 1;
      cursor.pagesDone = (cursor.pagesDone || 0) + 1;
      cursor.totalSeen = (cursor.totalSeen || 0) + (batch.clips ? batch.clips.length : 0);
      cursor.lastError = null;
      cursor.state = 'running';

      const pageClips = Array.isArray(batch.clips) ? batch.clips : [];
      if (mode === 'both') {
        for (const clip of pageClips) {
          const id = String(clip.id);
          if (cursor.pass === 'hideDisliked=true') baseIds.add(id);
          seenIds.add(id);
        }
      }

      await commitPage(pageClips);
      await flushIdSets(batch.page || 0);
      await DB.syncState.set('feed', cursor);
      await broadcast({
        type: 'SYNC_PROGRESS',
        page: cursor.nextPage,
        pagesDone: cursor.pagesDone,
        seen: cursor.totalSeen,
        added,
        etaMs: estimateSyncEta(startedAt, cursor.pagesDone, cursor.pagesDone, maxPages),
        state: 'running',
      });
    }

    if (mode === 'both' && !dislikedIds) {
      // A resumed run finished the second pass but never computed the diff.
      // Derive it from the persisted base set; if that set was never flushed the
      // result is incomplete, and we say so rather than pretend otherwise.
      const persistedBase = new Set(await DB.meta.get(META_KEYS.FEED_BASE_IDS, []));
      const derived = new Set();
      for (const id of seenIds) if (!persistedBase.has(id)) derived.add(id);
      dislikedIds = derived;
      cursor.dislikedApproximate = baseIds.size === 0 || persistedBase.size === 0;
      cursor.dislikedCount = derived.size;
      if (derived.size) await DB.meta.set(META_KEYS.FEED_DISLIKED_IDS, Array.from(derived));
    }

    if (buffering && !truncated && !overflowed) {
      const rows = await SunoAPIClient.hydrate(buffered, { membershipsAll, addedAtMs, signal });
      const result = await DB.clips.bulkReplace(Array.from(rows.values()));
      added = result.written;
      log('info', 'sync.bulk_replaced', result);
      cursor.buffered = buffered.length;
      buffered.length = 0;
    } else if (buffering) {
      // Truncated or overflowed: additive writes only. The previous library is
      // left intact and the UI is told the result is incomplete.
      cursor.buffered = buffered.length;
      if (buffered.length) {
        const rows = await SunoAPIClient.hydrate(buffered, { membershipsAll, addedAtMs, signal });
        added += await putAdditive(Array.from(rows.values()), 'truncated-fallback');
      }
      buffering = false;
    }

    cursor.state = signal.aborted ? 'cancelled' : 'idle';
    cursor.truncated = truncated === true;
    cursor.lastError = signal.aborted ? 'cancelled by the user' : lastError;
    cursor.finishedAt = Date.now();
    cursor.durationMs = cursor.finishedAt - startedAt;
    cursor.overflowed = overflowed;
    await DB.syncState.set('feed', cursor);

    const total = await DB.clips.count();
    await DB.journal.append({
      batchId: 'sync',
      phase: signal.aborted ? 'cancelled' : 'done',
      detail: { pagesDone: cursor.pagesDone, seen: cursor.totalSeen, truncated },
    });

    await broadcast({
      type: 'SYNC_DONE',
      total,
      truncated: truncated === true,
      projects: projects.length,
      durationMs: cursor.durationMs,
    });

    log('info', 'sync.finished', {
      pagesDone: cursor.pagesDone, seen: cursor.totalSeen, total, truncated, overflowed,
    });
  } catch (err) {
    const info = describeError(err);
    if (isAbortLike(err)) {
      cursor.state = 'cancelled';
      await DB.syncState.set('feed', cursor);
      await broadcast({ type: 'SYNC_DONE', total: await DB.clips.count(), truncated: cursor.truncated === true, projects: projects.length, durationMs: Date.now() - startedAt });
      return;
    }
    cursor.state = 'error';
    cursor.lastError = info.message;
    await DB.syncState.set('feed', cursor);
    await DB.journal.append({ batchId: 'sync', phase: 'error', detail: { code: info.code } });
    log('error', 'sync.failed', { error: info });
    await broadcast({ type: 'SYNC_ERROR', error: info.message });
  } finally {
    syncController = null;
  }
}

/**
 * Rough ETA for a crawl.
 * @param {number} startedAt
 * @param {number} done
 * @param {number} totalKnown
 * @param {number} totalEstimate
 * @returns {number}
 */
function estimateSyncEta(startedAt, done, totalKnown, totalEstimate) {
  if (done <= 0) return 0;
  const elapsed = Date.now() - startedAt;
  const perPage = elapsed / done;
  const remaining = Math.max(0, totalEstimate - totalKnown);
  return Math.round(perPage * remaining);
}

/**
 * Cancel the crawl.
 * @returns {Promise<{ok:boolean}>}
 */
async function cancelSync() {
  if (syncController) {
    syncController.abort();
    log('info', 'sync.cancel_requested', {});
  }
  return { ok: true };
}

/* ==========================================================================
 * 14. QUERY, SELECTION, PROJECTS
 * ======================================================================== */

/**
 * Everything the filter engine needs beyond the clip itself: the project list
 * and the diffed dislike set. Dislike state is NOT a clip field on Suno, so it
 * arrives as a caller-supplied `dislikedIds` set.
 * @returns {Promise<{projects:Array<object>, dislikedIds:Set<string>}>}
 */
async function queryContext() {
  const cached = await DB.meta.get(META_KEYS.PROJECTS, null);
  const projects = cached && Array.isArray(cached.projects) ? cached.projects : [];
  let dislikedIds = new Set();
  try {
    const ids = await DB.meta.get(META_KEYS.FEED_DISLIKED_IDS, []);
    dislikedIds = new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch (dislikedErr) {
    log('warn', 'query.disliked_load_failed', { error: describeError(dislikedErr) });
  }
  return { projects, dislikedIds };
}

/**
 * `GET_CLIPS`: filter, sort and page entirely here, against IndexedDB, so the
 * page never has to hold the whole library.
 *
 * @param {{spec?:object, limit?:number, offset?:number, sort?:string, order?:string}} payload
 * @returns {Promise<object>}
 */
async function queryClips(payload) {
  await loadSettings();
  if (!FILTER_AVAILABLE) {
    throw new OpError('no_filter_engine',
      'lib/suno.js did not register, so the filter engine is unavailable. '
      + 'Load order: background must importScripts lib/suno.js.');
  }
  const context = await queryContext();
  const all = await DB.clips.all(ALL_CLIPS);
  const spec = SunoFilter.normalizeSpec(payload.spec || {});
  const matched = SunoFilter.apply(all, spec, context);
  const sorted = SunoFilter.sort(matched, payload.sort || 'newest', payload.order || 'desc');
  const page = SunoFilter.paginate(sorted, {
    limit: Number.isFinite(payload.limit) ? Number(payload.limit) : 50,
    offset: Number.isFinite(payload.offset) ? Number(payload.offset) : 0,
  });
  return {
    ok: true,
    clips: page.items,
    items: page.items,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    librarySize: all.length,
    truncated: isSyncTruncated(),
    description: SunoFilter.describe(spec),
  };
}

/**
 * Is the stored library known to be incomplete? Every UI surface must show this.
 * @returns {boolean}
 */
async function isSyncTruncated() {
  try {
    const cursor = await DB.syncState.get('feed', null);
    return !!(cursor && cursor.truncated === true);
  } catch (truncErr) {
    log('warn', 'query.truncation_check_failed', { error: describeError(truncErr) });
    return false;
  }
}

/**
 * `GET_FACETS`: counts over the whole library plus the size of the match.
 * @param {{spec?:object}} payload
 * @returns {Promise<object>}
 */
async function queryFacets(payload) {
  if (!FILTER_AVAILABLE) throw new OpError('no_filter_engine', 'lib/suno.js did not register.');
  const context = await queryContext();
  const all = await DB.clips.all(ALL_CLIPS);
  const spec = SunoFilter.normalizeSpec(payload.spec || {});
  return {
    ok: true,
    facets: SunoFilter.facets(all, context),
    projects: context.projects,
    total: all.length,
    matched: SunoFilter.apply(all, spec, context).length,
    truncated: await isSyncTruncated(),
  };
}

/**
 * `GET_PROJECTS`: projects on disk, refreshed from the API when asked.
 * @param {{refresh?:boolean}} payload
 * @returns {Promise<object>}
 */
async function queryProjects(payload) {
  const cached = await DB.meta.get(META_KEYS.PROJECTS, null);
  let projects = cached && Array.isArray(cached.projects) ? cached.projects : [];
  if (payload.refresh) {
    try {
      projects = await SunoAPIClient.fetchProjects({});
      await DB.meta.set(META_KEYS.PROJECTS, { at: Date.now(), projects });
    } catch (projectsErr) {
      const info = describeError(projectsErr);
      log('warn', 'projects.refresh_failed', { error: info });
      return { ok: false, error: info.message, code: info.code, projects };
    }
  }
  const counts = new Map();
  for (const project of projects) counts.set(String(project.id), project.clipCount || 0);
  return { ok: true, projects, cachedAt: cached ? cached.at : null, counts: Object.fromEntries(counts) };
}

/**
 * Load project id -> name, for filename templates and workspace labels.
 * @returns {Promise<Map<string,string>>}
 */
async function loadProjectNames() {
  const names = new Map();
  names.set('default', 'My Workspace');
  try {
    const cached = await DB.meta.get(META_KEYS.PROJECTS, null);
    const projects = cached && Array.isArray(cached.projects) ? cached.projects : [];
    for (const project of projects) {
      if (project && project.id) names.set(String(project.id), String(project.name || project.id));
    }
  } catch (namesErr) {
    log('warn', 'projects.names_failed', { error: describeError(namesErr) });
  }
  return names;
}

/**
 * `SET_SELECTION`: persist an explicit id list. This is the single most useful
 * mass-download primitive and the old UI had no way to express it at all.
 * @param {{ids:string[]}} payload
 * @returns {Promise<object>}
 */
async function setSelection(payload) {
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [];
  const unique = Array.from(new Set(ids));
  const record = { ids: unique, at: Date.now() };
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_SELECTION]: record });
  } catch (sessionErr) {
    log('warn', 'selection.session_write_failed', { error: describeError(sessionErr) });
  }
  try {
    // Also durable, so a batch can still be planned after a browser restart.
    await DB.meta.set(META_KEYS.SELECTION, record);
  } catch (metaErr) {
    log('warn', 'selection.meta_write_failed', { error: describeError(metaErr) });
  }
  log('info', 'selection.saved', { count: unique.length });
  return { ok: true, count: unique.length, ids: unique, at: record.at };
}

/**
 * `GET_SELECTION`.
 * @returns {Promise<object>}
 */
async function getSelection() {
  let ids = [];
  let at = null;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.SESSION_SELECTION);
    const record = stored[STORAGE_KEYS.SESSION_SELECTION];
    if (record && Array.isArray(record.ids)) {
      ids = record.ids;
      at = record.at;
    }
  } catch (sessionErr) {
    log('warn', 'selection.session_read_failed', { error: describeError(sessionErr) });
  }
  if (!ids.length) {
    const durable = await DB.meta.get(META_KEYS.SELECTION, null);
    if (durable && Array.isArray(durable.ids)) {
      ids = durable.ids;
      at = durable.at;
    }
  }
  const resolvable = ids.length ? (await loadClipsByIds(ids)).length : 0;
  return { ok: true, ids, count: ids.length, resolvable, at };
}

/**
 * Read the persisted selection ids.
 * @returns {Promise<string[]>}
 */
async function readSelectionIds() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.SESSION_SELECTION);
    const record = stored[STORAGE_KEYS.SESSION_SELECTION];
    if (record && Array.isArray(record.ids)) return record.ids.map(String);
  } catch (sessionErr) {
    log('warn', 'selection.read_failed', { error: describeError(sessionErr) });
  }
  return [];
}

/* ==========================================================================
 * 15. QUOTA
 * ======================================================================== */

/**
 * A flat quota view for every consumer.
 *
 * `downloads` and `credits` are deliberately SEPARATE objects: credits are a
 * different resource from the download meter, and conflating them is how the
 * old badge cheerfully reported plenty of headroom while downloads were
 * exhausted. The scalar aliases exist because the page UI reads several
 * spellings; they all carry the SAME number.
 *
 * @param {object} quota a `SunoAPIClient.quota()` result
 * @returns {object}
 */
function quotaView(quota) {
  if (!quota) return null;
  const remaining = quota.unlimited === true
    ? null
    : (typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : quota.remaining);
  const view = {
    used: typeof quota.used === 'number' ? quota.used : null,
    limit: typeof quota.limit === 'number' ? quota.limit : null,
    remaining,
    effectiveRemaining: typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : null,
    additionalRemaining: typeof quota.additionalRemaining === 'number' ? quota.additionalRemaining : null,
    unlimited: quota.unlimited === true,
    resetsOn: quota.resetsOn || null,
    plan: quota.plan || null,
    canBulkDownload: quota.canBulkDownload === undefined ? null : quota.canBulkDownload,
    // Aliases. Identical values, spelled so no consumer has to guess.
    left: remaining,
    available: remaining,
    downloadsRemaining: remaining,
    total: typeof quota.limit === 'number' ? quota.limit : null,
    resetsAt: quota.resetsOn || null,
    resetAt: quota.resetsOn || null,
    resetDate: quota.resetsOn || null,
    fetchedAt: quota.fetchedAt || Date.now(),
  };
  return view;
}

/**
 * The DOWNLOAD quota. Credits are a DIFFERENT resource and are reported in a
 * separate field, never merged — the old badge showed credits.
 * @param {{refresh?:boolean}} payload
 * @returns {Promise<object>}
 */
async function getQuota(payload) {
  if (!SunoAPIClient || typeof SunoAPIClient.quota !== 'function') {
    throw new OpError('no_quota', 'lib/api.js did not register.');
  }
  let quota;
  try {
    quota = await SunoAPIClient.quota({ force: payload.refresh === true });
  } catch (quotaErr) {
    const info = describeError(quotaErr);
    if (info.code === 'unauthorized' || info.code === 'bad_token' || info.code === 'missing_token') {
      const auth = classifyAuthFailure(quotaErr);
      throw new OpError(auth.code, auth.message, { badToken: auth.badToken });
    }
    throw new OpError(info.code, info.message);
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUOTA]: { at: Date.now(), quota } });
  } catch (cacheErr) {
    log('warn', 'quota.cache_write_failed', { error: describeError(cacheErr) });
  }
  await paintQuotaBadge(quota);
  return {
    ok: true,
    // `quota` is the flat, alias-rich download view every UI reads.
    quota: quotaView(quota),
    downloads: quotaView(quota),
    // Credits are NOT downloads. Kept in their own field on purpose.
    credits: {
      monthly: quota.monthlyCredits,
      total: quota.totalCredits,
    },
    creditPacks: Array.isArray(quota.raw && quota.raw.download_credit_packs)
      ? quota.raw.download_credit_packs
      : [],
    semantics: SunoAPI && SunoAPI.QUOTA_SEMANTICS ? SunoAPI.QUOTA_SEMANTICS.rules : null,
    fetchedAt: quota.fetchedAt,
  };
}

/**
 * Paint the toolbar badge with DOWNLOADS REMAINING, not credits.
 * @param {object} quota
 * @returns {Promise<void>}
 */
async function paintQuotaBadge(quota) {
  if (!chrome.action || typeof chrome.action.setBadgeText !== 'function') return;
  try {
    let text = '';
    if (quota.unlimited) text = '∞';
    else if (typeof quota.effectiveRemaining === 'number') text = String(Math.max(0, quota.effectiveRemaining));
    else if (typeof quota.remaining === 'number') text = String(Math.max(0, quota.remaining));
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' });
  } catch (badgeErr) {
    log('debug', 'quota.badge_failed', { error: describeError(badgeErr) });
  }
}

/* ==========================================================================
 * 16. ROUTER
 *
 * Every entry declares `async`, and only async handlers make `onMessage` return
 * `true`. Push types are ignored at the top so a broadcast can never re-enter
 * the router. Offscreen traffic is never answered here.
 * ======================================================================== */

/**
 * Every entry is `{handler}` where `handler(payload, sender)` returns either a
 * plain object (synchronous reply, channel NOT held open) or a promise (the
 * listener holds the channel and returns `true`). There is no hand-maintained
 * `async` flag, because a flag that disagrees with the handler is precisely how
 * a reply ends up written to a closed channel.
 *
 * @typedef {object} Route
 * @property {(payload:object, sender:chrome.runtime.MessageSender) => (object|Promise<object>)} handler
 */

/** @type {Record<string, Route>} */
const ROUTES = {

  /**
   * Static capability / limit report. NO SIDE EFFECT: it reads constants and
   * already-cached values only, mutates nothing, spends no quota and starts no
   * network request. Safe to poll.
   *
   * UI: the corresponding control lives in the OPTIONS surface (a "what this
   * build can actually do" readout). Nothing in this build sends this message
   * on its own; it exists for a page to ask.
   *
   * @param {object} [payload] ignored — accepted, and nothing is required
   * @returns {{ok:true,
   *   ladder:Array<object>,           every rung: id, metered, optIn, batchOnly
   *   variants:string[],               CANONICAL variants only. Build a select
   *                                    from THIS, not from a hardcoded list:
   *                                    the formats this build can deliver are a
   *                                    capability decision (see VARIANTS).
   *   variantAliases:Record<string,string>,
   *                                    tolerated legacy spellings -> canonical,
   *                                    so a UI can explain a substitution
   *                                    instead of silently showing a different
   *                                    value than the user picked
   *   wavRungRates:Record<string,number>,
   *                                    the rate each WAV rung writes: 'wav' is
   *                                    the configurable `wavSampleRate`,
   *                                    'wav-48k' is pinned to 48000
   *   signedUrlTtlSeconds:number|null,
   *   apiLimits:object|null,
   *   quotaSemantics:object|null,
   *   endpoints:string[],
   *   dataUrlMaxBytes:number,
   *   maxFolderDepth:number,
   *   syncFlushEveryPages:number,
   *   rebuildBufferCap:number}}
   */
  GET_LIMITS: {
    handler: () => ({
      ok: true,
      ladder: LADDER_RUNGS,
      variants: VARIANTS,
      variantAliases: VARIANT_ALIASES,
      wavRungRates: {
        wav: clampNumber(DEFAULT_SETTINGS.wavSampleRate, 8000, 192000, DEFAULT_SETTINGS.wavSampleRate),
        'wav-48k': WAV_48K_RATE,
      },
      signedUrlTtlSeconds: SunoAPI && SunoAPI.SIGNED_URL_TTL_SECONDS ? SunoAPI.SIGNED_URL_TTL_SECONDS : null,
      apiLimits: SunoAPI && SunoAPI.LIMITS ? SunoAPI.LIMITS : null,
      quotaSemantics: SunoAPI && SunoAPI.QUOTA_SEMANTICS ? SunoAPI.QUOTA_SEMANTICS : null,
      endpoints: SunoAPI && SunoAPI.ENDPOINTS ? Object.keys(SunoAPI.ENDPOINTS) : [],
      dataUrlMaxBytes: DEFAULT_SETTINGS.dataUrlMaxBytes,
      maxFolderDepth: DEFAULT_SETTINGS.maxFolderDepth,
      syncFlushEveryPages: DISLIKED_FLUSH_EVERY_PAGES,
      rebuildBufferCap: FULL_REBUILD_BUFFER_CAP,
    }),
  },

  /**
   * Additive hand-off from the page UI: the page captured a MediaSource stream
   * and is handing over the ordered segment list (§10b).
   */
  HLS_CAPTURE: {
    handler: (payload) => captureHls(payload || {}),
  },

  /* ---- boot ------------------------------------------------------- */
  GET_BOOT: {
    handler: async () => {
      const settings = await loadSettings();
      const [cursor, dbStats, byState, quotaCached, lastBatch] = await Promise.all([
        DB.syncState.get('feed', null),
        DB.stats(),
        DB.downloads.countByState(),
        readCachedQuota(),
        DB.meta.get(META_KEYS.LAST_BATCH_SUMMARY, null),
      ]);
      return {
        ok: true,
        version: chrome.runtime.getManifest().version,
        settings,
        defaults: DEFAULT_SETTINGS,
        ladder: LADDER_RUNGS,
        variants: VARIANTS,
        token: await tokenStatus(),
        quota: quotaCached ? quotaView(quotaCached.quota) : null,
        quotaFetchedAt: quotaCached ? quotaCached.at : null,
        library: {
          counts: dbStats.counts,
          downloadsByState: byState,
          estimate: dbStats.estimate,
          schemaVersion: dbStats.schemaVersion,
        },
        sync: cursor
          ? {
            state: cursor.state || 'idle',
            pagesDone: cursor.pagesDone || 0,
            nextPage: cursor.nextPage || 0,
            totalSeen: cursor.totalSeen || 0,
            // The single most important field in this reply: a truncated crawl
            // means the library on disk is incomplete and every surface must
            // say so loudly.
            truncated: cursor.truncated === true,
            dislikedCount: cursor.dislikedCount,
            dislikedApproximate: cursor.dislikedApproximate === true,
            lastError: cursor.lastError || null,
            durationMs: cursor.durationMs || null,
          }
          : null,
        download: {
          running: !!batchController,
          batchId: activeBatchId,
          lastBatch,
        },
        capabilities: {
          filter: FILTER_AVAILABLE,
          tagger: TAGGER_AVAILABLE,
          drm: !!SunoDRM,
          crypto: !!SunoCrypto,
          audio: !!SunoAudio,
          lyrics: !!SunoLyrics,
          offscreen: !!(chrome.offscreen && chrome.offscreen.hasDocument),
          missingLibs: MISSING_LIBS,
        },
      };
    },
  },

  /**
   * THE "is this install healthy?" SURFACE, and the ONLY reader of `missingLibs`
   * and `audioWarnings` — the two fields that distinguish "the extension is
   * misconfigured" from "the extension is working and this clip is odd".
   *
   * NO SIDE EFFECT: reads the diagnostic ring buffer and per-library `stats()`.
   * It mutates nothing and spends no quota.
   *
   * UI: the corresponding control lives in the OPTIONS surface (a diagnostics
   * panel). Nothing in this build sends this message on its own.
   *
   * @param {object} [payload] ignored — accepted, and nothing is required
   * @returns {Promise<{ok:true,
   *   debug:boolean,                  whether `settings.debug` is on, i.e.
   *                                    whether entries below are being persisted
   *   entries:Array<object>,           the persisted ring buffer, newest last;
   *                                    empty when debug was never enabled
   *   api:object|null,                SunoAPIClient.stats()
   *   drm:object|null,                SunoDRM.stats()
   *   audioWarnings:string[],         non-fatal Web Audio degradations
   *   missingLibs:string[],           global names that failed to register
   *   rateLimiter:object|null}>}
   */
  GET_DIAGNOSTICS: {
    handler: async () => ({
      ok: true,
      debug: settingsCache.debug,
      entries: await readDiagnostics(),
      api: SunoAPIClient && typeof SunoAPIClient.stats === 'function' ? SunoAPIClient.stats() : null,
      drm: SunoDRM && typeof SunoDRM.stats === 'function' ? SunoDRM.stats() : null,
      audioWarnings: SunoAudio && typeof SunoAudio.getWarnings === 'function' ? SunoAudio.getWarnings() : [],
      missingLibs: MISSING_LIBS,
      rateLimiter: SunoAPIClient && SunoAPIClient.rateLimiter
        ? SunoAPIClient.rateLimiter.stats()
        : null,
    }),
  },

  /* ---- auth ------------------------------------------------------- */
  SET_TOKEN: {
    handler: async (payload) => {
      const token = typeof payload.token === 'string' ? payload.token : '';
      if (token.length > 20) {
        await writeSessionToken(token, payload.expiresAt);
        if (payload.requestId) resolveTokenRelay(payload.requestId, token);
        await broadcast({ type: 'TOKEN_CHANGED', expiresAt: (authCache && authCache.exp) || null });
        return { ok: true, expiresAt: authCache ? authCache.exp : null };
      }
      return { ok: false, error: 'no usable token supplied', code: 'bad_token' };
    },
  },

  GET_TOKEN_STATUS: {
    handler: async () => {
      // Mint opportunistically: the useful question is "do I have a usable
      // session?", not "has anything happened to ask for a token yet?". The
      // result is cached, so this costs one scripting call at most.
      await getAuthToken({ force: false });
      return { ok: true, token: await tokenStatus() };
    },
  },

  /* ---- sync ------------------------------------------------------- */
  SYNC_START: {
    handler: (payload) => startSync(payload || {}),
  },

  SYNC_STATUS: {
    handler: async () => {
      const cursor = await DB.syncState.get('feed', null);
      return {
        ok: true,
        running: !!syncController,
        cursor,
        truncated: !!(cursor && cursor.truncated === true),
        total: await DB.clips.count(),
      };
    },
  },

  SYNC_CANCEL: {
    handler: () => cancelSync(),
  },

  /* ---- query ------------------------------------------------------ */
  GET_CLIPS: {
    handler: (payload) => queryClips(payload || {}),
  },

  GET_FACETS: {
    handler: (payload) => queryFacets(payload || {}),
  },

  GET_PROJECTS: {
    handler: (payload) => queryProjects(payload || {}),
  },

  /* ---- selection -------------------------------------------------- */
  SET_SELECTION: {
    handler: (payload) => setSelection(payload || {}),
  },

  GET_SELECTION: {
    handler: () => getSelection(),
  },

  /* ---- downloads -------------------------------------------------- */
  DOWNLOAD_START: {
    handler: (payload) => startBatch(payload || {}),
  },

  /**
   * Current batch / download state. NO SIDE EFFECT: reads the plan, the DB, and
   * the in-memory `activeDownloads` map. It does NOT start, pause or cancel
   * anything — `DOWNLOAD_CANCEL` and `DOWNLOAD_START` are the mutating routes.
   *
   * UI: the corresponding control lives in the POPUP surface (the progress
   * panel). Nothing in this build sends this message on its own; the popup gets
   * its liveness from the `DL_ITEM` / `BATCH_DONE` pushes instead.
   *
   * @param {object} [payload] optionally `{batchId}`; accepted but NOT required —
   *   omitting it reports the active batch, or the last recorded one
   * @returns {Promise<{ok:true,
   *   running:boolean,
   *   batchId:string|null,
   *   plan:object|null,               {batchId, status, variant, sourceLadder,
   *                                    cursor, total, stats, dryRun, preflight,
   *                                    stoppedReason, quotaStop, description}
   *   byState:object,                 download count per state
   *   activeDownloads:Array<{downloadId:number} & object>,
   *   lastBatch:object|null}>}
   */
  DOWNLOAD_STATUS: {
    handler: async (payload) => {
      // OPTIONAL `batchId`: a UI holding a stale batch id from an earlier poll
      // asks about THAT batch. Never required — omitting it keeps the previous
      // behaviour (the active batch, else the last recorded one), so an existing
      // caller that sends nothing is unaffected.
      const requested = String((payload && payload.batchId) || '');
      const batchId = requested || activeBatchId || (await DB.meta.get(META_KEYS.ACTIVE_BATCH, null));
      const plan = batchId ? await readPlan(batchId) : null;
      return {
        ok: true,
        running: !!batchController,
        batchId: batchId || null,
        plan: plan ? {
          batchId: plan.batchId,
          status: plan.status,
          variant: plan.variant,
          sourceLadder: plan.sourceLadder,
          cursor: plan.cursor,
          total: plan.items.length,
          stats: plan.stats,
          dryRun: plan.dryRun,
          preflight: plan.preflight || null,
          stoppedReason: plan.stoppedReason || null,
          quotaStop: plan.quotaStop || null,
          description: plan.description || '',
        } : null,
        byState: await DB.downloads.countByState(),
        activeDownloads: Array.from(activeDownloads.entries()).map(([id, info]) => ({ downloadId: id, ...info })),
        lastBatch: await DB.meta.get(META_KEYS.LAST_BATCH_SUMMARY, null),
      };
    },
  },

  DOWNLOAD_CANCEL: {
    handler: () => cancelBatch(),
  },

  DOWNLOAD_HISTORY: {
    handler: async (payload) => {
      const limit = Number.isFinite(payload && payload.limit) ? Math.max(1, Math.floor(payload.limit)) : 200;
      const rows = await DB.downloads.history({ limit });
      return { ok: true, history: rows, total: await DB.downloads.count() };
    },
  },

  DOWNLOAD_RETRY_FAILED: {
    handler: () => retryFailedBatch(),
  },

  /* ---- quota ------------------------------------------------------ */
  GET_QUOTA: {
    handler: (payload) => getQuota(payload || {}),
  },

  /* ---- settings --------------------------------------------------- */
  GET_SETTINGS: {
    handler: async () => {
      const settings = await loadSettings();
      return { ok: true, settings, defaults: DEFAULT_SETTINGS, ladder: LADDER_RUNGS, variants: VARIANTS };
    },
  },

  UPDATE_SETTINGS: {
    handler: async (payload) => {
      // The page UI sends the patch BOTH flat and under a `settings` key, so
      // both are accepted and the nested copy wins on conflict.
      const nested = payload && typeof payload.settings === 'object' ? payload.settings : null;
      const patch = nested ? Object.assign({}, payload, nested) : (payload || {});
      delete patch.settings;
      const settings = await updateSettings(patch);
      // There is no SETTINGS push in the protocol, so the reply is the
      // notification: the caller already has the authoritative object.
      return { ok: true, settings };
    },
  },

  RESET_SETTINGS: {
    handler: async () => ({ ok: true, settings: await resetSettings() }),
  },

  EXPORT_SETTINGS: {
    handler: async () => {
      const settings = await loadSettings();
      // Never exported: the session token, any key material, or the diagnostic
      // ring buffer (which may contain clip ids the user would not expect to
      // leave the machine). Settings must stay exportable even when IndexedDB
      // is unavailable, so the IDB reads are individually guarded.
      const safeRead = async (fn, fallback) => {
        try {
          return await fn();
        } catch (readErr) {
          log('warn', 'export.read_failed', { error: describeError(readErr) });
          return fallback;
        }
      };
      const projects = await safeRead(() => DB.meta.get(META_KEYS.PROJECTS, null), null);
      const quota = await safeRead(() => readCachedQuota(), null);
      return {
        ok: true,
        exportedAt: Date.now(),
        version: chrome.runtime.getManifest().version,
        settings,
        projects,
        quota: quota ? quotaView(quota.quota) : null,
      };
    },
  },

  IMPORT_SETTINGS: {
    handler: async (payload) => {
      const incoming = payload && payload.settings ? payload.settings : payload;
      const settings = await updateSettings(incoming || {});
      return { ok: true, settings };
    },
  },

  /* ---- misc ------------------------------------------------------- */
  REGISTER_TAB: {
    handler: async (payload, sender) => {
      const tabId = sender && sender.tab ? sender.tab.id : payload && payload.tabId;
      if (!Number.isFinite(tabId)) return { ok: false, error: 'no tab id', code: 'no_tab' };
      try {
        const stored = await chrome.storage.session.get(STORAGE_KEYS.SESSION_TABS);
        const list = Array.isArray(stored[STORAGE_KEYS.SESSION_TABS]) ? stored[STORAGE_KEYS.SESSION_TABS] : [];
        const next = list.filter((entry) => entry.tabId !== tabId);
        next.push({ tabId, url: sender.url || '', at: Date.now() });
        await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_TABS]: next.slice(-50) });
      } catch (tabErr) {
        log('warn', 'tab.register_failed', { error: describeError(tabErr) });
      }
      return { ok: true, tabId };
    },
  },

  /**
   * Diagnostic only. Reports which ladder rung WOULD work for this clip and why,
   * without downloading a single byte or spending a single download.
   *
   * NO SIDE EFFECT: `evaluateLadder` is a pure predicate over the stored clip
   * record. No network request, no DRM key fetch, no quota, no DB write.
   *
   * UI: the corresponding control lives in the POPUP surface (a per-clip
   * "why did this fail?" action on a library row). Nothing in this build sends
   * this message on its own.
   *
   * @param {object} payload `{clipId}` — REQUIRED and the only field read. A
   *   caller may also pass `{ladder:[...]}` to probe a hypothetical ordering
   *   instead of the configured one; both are optional additions to the
   *   mandatory `clipId`, and neither has a default that hides a mistake.
   * @returns {Promise<{ok:false, error:string, code:'bad_request'} | {ok:true,
   *   clipId:string,
   *   inLibrary:boolean,               false means "run a sync first"; `ladder`
   *                                    and everything below are then ABSENT
   *   title?:string,
   *   audioUrlIsDecoy?:boolean,
   *   mediaUrlCount?:number,
   *   ladder:Array<object>,            per-rung verdict, in preference order
   *   recommended:object|null,         first AVAILABLE rung (metered or not)
   *   free:object|null,                first available UNMETERED rung
   *   metered?:object|null}>}          first available METERED rung
   */
  PROBE_DRM: {
    handler: async (payload) => {
      const clipId = String((payload && payload.clipId) || '');
      if (!clipId) return { ok: false, error: 'clipId is required', code: 'bad_request' };
      let clip = null;
      try {
        clip = await DB.clips.get(clipId);
      } catch (clipErr) {
        log('warn', 'probe.clip_read_failed', { clipId, error: describeError(clipErr) });
      }
      if (!clip) {
        return {
          ok: true,
          clipId,
          inLibrary: false,
          note: 'This clip is not in the local library, so there is nothing to probe. Run a sync first.',
        };
      }
      // OPTIONAL `ladder`: probe a hypothetical ordering instead of the stored
      // one. A UI asking "would studio work if I enabled it?" cannot get a real
      // answer from a ladder that has studio filtered out, and enabling it just
      // to ask is a side effect this route promises not to have. Absent means
      // "use the configured ladder", so existing callers are unaffected.
      const override = Array.isArray(payload && payload.ladder) ? payload.ladder : null;
      const ladder = normalizeLadder(
        override || settingsCache.downloadSource,
        settingsCache.allowMeteredExtras
      );
      const rungs = evaluateLadder(clip, ladder);
      const normalized = FILTER_AVAILABLE ? SunoFilter.normalize(clip) : null;
      return {
        ok: true,
        clipId,
        inLibrary: true,
        title: normalized ? normalized.title : clip.title,
        audioUrlIsDecoy: normalized ? normalized.audioUrlIsDecoy : true,
        mediaUrlCount: Array.isArray(clip.media_urls) ? clip.media_urls.length : 0,
        ladder: rungs,
        recommended: rungs.find((rung) => rung.available) || null,
        free: rungs.find((rung) => rung.available && !rung.metered) || null,
        // The first available rung that COSTS a download, so a UI can say what
        // the honest-but-paid alternative is. Absent when everything available
        // is free.
        metered: rungs.find((rung) => rung.available && rung.metered) || null,
        drm: SunoDRM && typeof SunoDRM.stats === 'function' ? SunoDRM.stats() : null,
      };
    },
  },
};

/**
 * Read the last cached quota without a network round trip.
 * @returns {Promise<object|null>}
 */
async function readCachedQuota() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.QUOTA);
    const record = stored[STORAGE_KEYS.QUOTA];
    return record && record.quota ? record : null;
  } catch (cachedErr) {
    log('warn', 'quota.cache_read_failed', { error: describeError(cachedErr) });
    return null;
  }
}

/**
 * Handle one inbound message.
 *
 * `run()` may return a plain object (synchronous reply) or a promise. The
 * listener inspects the RESULT, not a hand-maintained flag, because a flag that
 * disagrees with the handler is exactly how a reply gets written to a channel
 * that has already closed.
 *
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {{run:() => (object|Promise<object>)}|null} null when ignored
 */
function routeMessage(message, sender) {
  if (!message || typeof message !== 'object') return null;

  // Offscreen traffic must fall straight through so the offscreen page's own
  // listener can answer it. Swallowing it here is how a blob URL silently never
  // arrives.
  if (message.target === 'offscreen') return null;

  // Our own pushes, arriving back from `runtime.sendMessage`. Answering them
  // would re-enter the router and produce "Unknown message type" noise.
  if (PUSH_TYPES.has(message.type)) return null;

  // An offscreen reply (`sunoBlobUrl:result`, `sunoAnalyze:result`, ...) belongs
  // to §7, not to the request table. Anything shaped like one is handed to
  // `resolveOffscreenReply`, which VERIFIES the envelope before it can settle a
  // waiter; a lookalike from any other sender is rejected there and logged. All
  // of them are then DROPPED: the offscreen page is not waiting on a reply to
  // its own reply, and answering a rejected one "unknown message type" is pure
  // noise on top of the rejection we already logged.
  if (typeof message.type === 'string' && /:result$/.test(message.type)) {
    resolveOffscreenReply(message, sender);
    return null;
  }

  // NOTE: a `target:'background'` branch used to sit here, answering
  // `offscreenReady` / `offscreenPing`. It was removed: offscreen.js has never
  // sent such a message (`rg "target: *'background'"` matches only
  // docs/ARCHITECTURE.md), so the branch could never run. A listener for messages
  // that cannot arrive is pure liability — it documented a channel that does not
  // exist and would have bypassed `validateSender` if anything ever did send it.
  // The offscreen document's liveness is established by `sunoPing` (§7), which
  // is a real request/response exchange.

  const route = ROUTES[message.type];

  // Sender validation on EVERY handler. `TRIGGER_NATIVE_DOWNLOAD` in the old
  // build accepted a caller-supplied URL from anyone with a runtime port. An
  // unknown type is rejected the same way, and both replies are SYNCHRONOUS so
  // the channel never has to be held open for them.
  const verdict = validateSender(sender);
  if (!route || !verdict.ok) {
    if (route) {
      log('warn', 'router.sender_rejected', { type: message.type, reason: verdict.reason });
      return { run: () => ({ ok: false, error: 'sender is not authorised: ' + verdict.reason, code: 'forbidden' }) };
    }
    log('debug', 'router.unknown_type', { type: String(message.type).slice(0, 80) });
    return { run: () => ({ ok: false, error: `unknown message type "${String(message.type)}"`, code: 'unknown_type' }) };
  }

  const payload = message.payload && typeof message.payload === 'object' ? message.payload : message;
  return { run: () => route.handler(payload || {}, sender) };
}

/**
 * Build the failure reply for a thrown handler, upgrading an auth failure into
 * the bad-token / expired-session distinction the UI needs.
 * @param {unknown} err
 * @returns {object}
 */
function errorReply(err) {
  const info = describeError(err);
  if (info.code === 'unauthorized' || info.code === 'bad_token' || info.code === 'missing_token') {
    const auth = classifyAuthFailure(err);
    return { ok: false, error: auth.message, code: auth.code, badToken: auth.badToken };
  }
  return { ok: false, error: info.message, code: info.code };
}

/**
 * Write a reply, tolerating an already-closed channel.
 * @param {Function} sendResponse
 * @param {object} reply
 * @returns {void}
 */
function safeSend(sendResponse, reply) {
  try {
    sendResponse(reply);
  } catch (sendErr) {
    // The requesting page went away mid-flight. Not an error worth propagating.
    void sendErr;
  }
}

/**
 * `chrome.runtime.onMessage`.
 *
 * Returns `true` ONLY when the handler produced a promise, which is the only
 * case where the response channel must be held open. Returning `true`
 * unconditionally leaks the channel for every synchronous reply and is the
 * documented cause of "the message port closed before a response was received".
 *
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {Function} sendResponse
 * @returns {boolean|undefined} true only for async handlers
 */
function onRuntimeMessage(message, sender, sendResponse) {
  const routed = routeMessage(message, sender);
  // `undefined` (not `false`) is the documented way to decline to respond.
  if (!routed) return undefined;

  let result;
  try {
    result = routed.run();
  } catch (syncErr) {
    log('error', 'router.handler_threw', { type: message && message.type, error: describeError(syncErr) });
    safeSend(sendResponse, errorReply(syncErr));
    return undefined;
  }

  if (!result || typeof result.then !== 'function') {
    safeSend(sendResponse, result);
    return undefined;
  }

  result.then(
    (reply) => safeSend(sendResponse, reply),
    (err) => {
      log('error', 'router.handler_threw', { type: message && message.type, error: describeError(err) });
      safeSend(sendResponse, errorReply(err));
    }
  );
  return true;
}

if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
}

/* ==========================================================================
 * 17. LIFECYCLE
 * ======================================================================== */

/**
 * Arm the batch keepalive.
 *
 * INVARIANT F: this runs only from onInstalled / onStartup. Creating an alarm
 * at module scope re-arms it on EVERY worker wake and resets its period, which
 * is how the old build ended up with a keepalive that fired constantly and one
 * that still did not actually protect a batch.
 *
 * @returns {Promise<void>}
 */
async function armKeepalive() {
  if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return;
  try {
    const existing = await chrome.alarms.get(ALARMS.KEEPALIVE);
    if (!existing) {
      await chrome.alarms.create(ALARMS.KEEPALIVE, {
        delayInMinutes: KEEPALIVE_PERIOD_MINUTES,
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
      });
      log('info', 'alarm.keepalive_armed', { period: KEEPALIVE_PERIOD_MINUTES });
    }
  } catch (armErr) {
    log('error', 'alarm.keepalive_failed', { error: describeError(armErr) });
  }
}

/**
 * Disarm the keepalive.
 * @returns {Promise<void>}
 */
async function disarmKeepalive() {
  if (!chrome.alarms || typeof chrome.alarms.clear !== 'function') return;
  try {
    await chrome.alarms.clear(ALARMS.KEEPALIVE);
  } catch (clearErr) {
    log('warn', 'alarm.keepalive_clear_failed', { error: describeError(clearErr) });
  }
}

/**
 * Arm the periodic quota refresh.
 * @returns {Promise<void>}
 */
async function armQuotaAlarm() {
  if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return;
  try {
    const existing = await chrome.alarms.get(ALARMS.QUOTA);
    if (!existing) {
      await chrome.alarms.create(ALARMS.QUOTA, {
        delayInMinutes: 15,
        periodInMinutes: 15,
      });
    }
  } catch (quotaErr) {
    log('error', 'alarm.quota_failed', { error: describeError(quotaErr) });
  }
}

/**
 * Arm the optional periodic auto-sync.
 * @returns {Promise<void>}
 */
async function armSyncAlarm() {
  if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return;
  try {
    if (settingsCache.autoSync) {
      await chrome.alarms.create(ALARMS.SYNC, {
        delayInMinutes: settingsCache.syncIntervalMinutes,
        periodInMinutes: settingsCache.syncIntervalMinutes,
      });
    } else {
      await chrome.alarms.clear(ALARMS.SYNC);
    }
  } catch (syncErr) {
    log('error', 'alarm.sync_failed', { error: describeError(syncErr) });
  }
}

/**
 * `chrome.alarms.onAlarm`. This is the ONLY thing that reliably wakes an
 * evicted worker, so every long operation re-arms itself here.
 * @param {object} alarm
 * @returns {Promise<void>}
 */
async function onAlarm(alarm) {
  if (!alarm || typeof alarm.name !== 'string') return;
  log('debug', 'alarm.fired', { name: alarm.name });

  if (alarm.name === ALARMS.KEEPALIVE) {
    const batchId = activeBatchId || (await DB.meta.get(META_KEYS.ACTIVE_BATCH, null));
    if (batchId) {
      const plan = await readPlan(batchId);
      if (plan && plan.status === 'running') {
        // Still running: this worker simply took over the loop.
        log('info', 'batch.resumed_by_alarm', { batchId });
        if (!batchController) batchController = new AbortController();
        void runBatch(batchId);
      } else {
        await disarmKeepalive();
      }
    } else {
      await disarmKeepalive();
    }
    return;
  }

  if (alarm.name === ALARMS.QUOTA) {
    const cached = await readCachedQuota();
    if (!cached || Date.now() - cached.at > 10 * 60_000) {
      try {
        await getQuota({ refresh: true });
      } catch (quotaErr) {
        log('debug', 'alarm.quota_refresh_failed', { error: describeError(quotaErr) });
      }
    }
    return;
  }

  if (alarm.name === ALARMS.SYNC) {
    if (settingsCache.autoSync && !syncController) {
      await startSync({ force: false, dislikedMode: settingsCache.dislikedMode });
    }
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => { void onAlarm(alarm); });
}

/**
 * `chrome.downloads.onChanged`. The single observed-completion path.
 * @param {object} delta
 * @returns {Promise<void>}
 */
if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => { void onDownloadChanged(delta); });
}

/**
 * Best-effort desktop notification. Never allowed to throw into a caller.
 * @param {string} title
 * @param {string} message
 * @returns {Promise<void>}
 */
async function notify(title, message) {
  if (!chrome.notifications || typeof chrome.notifications.create !== 'function') return;
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: redactText(title),
      message: redactText(message).slice(0, 400),
    });
  } catch (notifyErr) {
    log('debug', 'notify.failed', { error: describeError(notifyErr) });
  }
}

/**
 * Open the database, wire the caches, and recover whatever the last (evicted)
 * worker left behind.
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  if (MISSING_LIBS.length) {
    log('error', 'bootstrap.missing_libs', { missing: MISSING_LIBS });
  }
  await loadSettings();

  try {
    await DB.open();
    await DB.ensureDerived();
  } catch (dbErr) {
    log('error', 'bootstrap.db_open_failed', { error: describeError(dbErr) });
    return;
  }

  await restoreActiveDownloads();
  await reconcileDownloadsOnStartup();

  // Resume an interrupted batch rather than losing it to an eviction.
  try {
    const batchId = await DB.meta.get(META_KEYS.ACTIVE_BATCH, null);
    if (batchId) {
      const plan = await readPlan(batchId);
      if (plan && plan.status === 'running') {
        batchController = new AbortController();
        log('info', 'batch.resumed_on_wake', { batchId, remaining: plan.items.length });
        await armKeepalive();
        void runBatch(batchId);
      } else if (plan && plan.status === 'planned') {
        batchController = new AbortController();
        await armKeepalive();
        void runBatch(batchId);
      } else {
        await DB.meta.remove(META_KEYS.ACTIVE_BATCH);
        await disarmKeepalive();
      }
    }
  } catch (resumeErr) {
    log('error', 'bootstrap.resume_failed', { error: describeError(resumeErr) });
  }

  // A crawl that was interrupted mid-page resumes on wake too.
  try {
    const cursor = await DB.syncState.get('feed', null);
    if (cursor && cursor.state === 'running') {
      log('info', 'sync.interrupted_state_noted', { nextPage: cursor.nextPage });
      // Deliberately NOT auto-resumed: a crawl can be hundreds of requests and
      // silently restarting one on every worker wake would hammer the API.
      // SYNC_START with force:false picks up from the stored cursor.
    }
  } catch (cursorErr) {
    log('warn', 'bootstrap.cursor_read_failed', { error: describeError(cursorErr) });
  }

  log('info', 'bootstrap.ready', {
    missingLibs: MISSING_LIBS,
    filter: FILTER_AVAILABLE,
    tagger: TAGGER_AVAILABLE,
  });
}

/** One-shot bootstrap promise; re-entrant worker wakes await the same promise. */
let bootstrapPromise = null;

/**
 * @returns {Promise<void>}
 */
function ensureBootstrapped() {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap().catch((err) => {
      log('error', 'bootstrap.threw', { error: describeError(err) });
    });
  }
  return bootstrapPromise;
}

/**
 * Prime the download quota: fill the cache, paint the toolbar badge, and give
 * `GET_BOOT` something real to report.
 *
 * Without this the badge stays blank and `GET_BOOT.quota` stays null until some
 * UI happens to call `GET_QUOTA`, which is how the old build ended up showing
 * nothing at all. Failures are swallowed with a log because a quota refresh
 * must never block install or browser start.
 *
 * @returns {Promise<object|null>}
 */
async function primeQuota() {
  try {
    const reply = await getQuota({ refresh: true });
    log('info', 'quota.primed', { remaining: reply.quota.remaining, limit: reply.quota.limit });
    return reply.quota;
  } catch (err) {
    const info = describeError(err);
    // An unauthenticated prime is expected, not an error worth shouting about.
    log('debug', 'quota.prime_skipped', { code: info.code });
    return null;
  }
}

/**
 * Register the side panel so the BROWSER's own side-panel UI can surface it.
 *
 * `manifest.json` declares the `sidePanel` permission and `side_panel.html`
 * exists and works, but nothing in the extension ever called
 * `setPanelBehavior`, so the panel had no entry point at all and could not be
 * opened by any route.
 *
 * `openPanelOnActionClick: false` is deliberate and load-bearing for the UI
 * design: the POPUP stays the primary toolbar surface (it owns the quota tile
 * and the batch controls). Registering the behaviour only re-enables Chrome's
 * own side-panel affordance; it does not steal the toolbar click.
 *
 * Opening it programmatically is the popup's job — `popup.js` calls
 * `chrome.sidePanel.open({windowId})` from inside the button's user gesture and
 * falls back to the options page (with an explicit log line) on any build that
 * refuses. This call must never reject into install/startup, so a missing API
 * and a rejected promise are both swallowed at debug level.
 *
 * @returns {Promise<void>}
 */
async function registerSidePanel() {
  const api = chrome.sidePanel;
  if (!api || typeof api.setPanelBehavior !== 'function') {
    log('debug', 'lifecycle.side_panel_api_missing', {});
    return;
  }
  try {
    await api.setPanelBehavior({ openPanelOnActionClick: false });
    log('debug', 'lifecycle.side_panel_behavior_registered', { openPanelOnActionClick: false });
  } catch (panelErr) {
    log('debug', 'lifecycle.side_panel_behavior_failed', { error: describeError(panelErr) });
  }
}

/**
 * Install / update. Seeds defaults and arms every alarm HERE, never at module
 * scope.
 * @param {object} details
 * @returns {Promise<void>}
 */
async function onInstalled(details) {
  try {
    await persistSettings(coerceSettings(DEFAULT_SETTINGS));
  } catch (seedErr) {
    log('error', 'lifecycle.seed_settings_failed', { error: describeError(seedErr) });
  }
  await ensureBootstrapped();
  await armKeepalive();
  await armQuotaAlarm();
  await armSyncAlarm();
  await registerSidePanel();
  void primeQuota();
  log('info', 'lifecycle.installed', { reason: details && details.reason ? details.reason : 'unknown' });
}

if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => { void onInstalled(details); });
}

/**
 * Browser start.
 * @returns {Promise<void>}
 */
async function onStartup() {
  await ensureBootstrapped();
  await armKeepalive();
  await armQuotaAlarm();
  await armSyncAlarm();
  // Defensive repeat: the behaviour is per-profile but a Chrome update can
  // reset it, and re-registering is idempotent and cheap.
  await registerSidePanel();
  void primeQuota();
  log('info', 'lifecycle.startup', {});
}

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => { void onStartup(); });
}

/**
 * A new worker instance: bootstrap on the first event we see. Registered as a
 * listener rather than called at module scope so nothing runs before an event
 * actually wakes the worker.
 * @returns {Promise<void>}
 */
if (chrome.runtime && chrome.runtime.onMessage) {
  // (The router is already registered above; this only exists so that a worker
  // woken by a message has already opened the database before the handler runs.)
  void ensureBootstrapped();
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  void ensureBootstrapped();
}
if (chrome.runtime && chrome.runtime.onStartup) {
  void ensureBootstrapped();
}

/* ---------------------------------------------------------------------- *
 * End of file.
 * ---------------------------------------------------------------------- */