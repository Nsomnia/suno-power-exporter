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
 *   module-scope variable; caches are caches and are re-derived on wake. THE RUN
 *   BOOKKEEPING IS THE EXCEPTION THAT PROVES IT, and it exists because the rule
 *   was not enough on its own: §13c keeps "a crawl is in flight, started at T, and
 *   a Stop was requested" in `chrome.storage.session`, which survives the
 *   eviction. `syncController` and `syncCancelRequested` stay module-scope
 *   because they are the things that DIE — they describe the crawl this worker is
 *   running, and after an eviction there is no such crawl to describe. The honest
 *   version of the rule is the one the code now follows: a module-scope binding may
 *   be a cache or a handle, never the only copy of a fact a surface needs.
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
  '../lib/audio.js',
  /* Sections extracted out of this file. Each part declares its own top-level
   * functions and publishes them on a single SMU-prefixed global. This list
   * runs before the monolith's own declarations are evaluated, so a part must
   * not CALL into the monolith at load time, only at call time.
   * scripts/check-build.sh enforces the load-order and reference rules. */
  './parts/02-diagnostics.js',
  './parts/03-errors.js',
  './parts/06-messaging.js',
  './parts/15-quota.js'
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

/* Extracted sections, and whether they actually loaded. Each part is an
 * `importScripts` entry above, so a part that fails to parse — or a path typo —
 * leaves its names undefined and every call site below throws on first use.
 * That is a loud enough failure, but it surfaces as a mid-session error on a
 * route rather than as "the file is missing" at wake, so it is checked here
 * where the other load-time health checks already live.
 *
 * The names are read off the global deliberately and never re-bound: see the
 * export note at the bottom of `background/parts/15-quota.js` for why a
 * top-level `const` with one of these names throws in a classic worker. */
const MISSING_PARTS = [];
if (!globalThis.SMUDiagnostics || typeof globalThis.SMUDiagnostics.log !== 'function') {
  MISSING_PARTS.push('background/parts/02-diagnostics.js (log)');
}
if (!globalThis.SMUErrors || typeof globalThis.SMUErrors.describeError !== 'function') {
  MISSING_PARTS.push('background/parts/03-errors.js (describeError)');
}
if (!globalThis.SMUMessaging || typeof globalThis.SMUMessaging.broadcast !== 'function') {
  MISSING_PARTS.push('background/parts/06-messaging.js (broadcast)');
}
if (!globalThis.SMUQuota || typeof globalThis.SMUQuota.quotaView !== 'function') {
  MISSING_PARTS.push('background/parts/15-quota.js (quotaView)');
}

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
  /* THE RUN-BOOKKEEPING RECORD. See §13c for the full argument; the short version
   * is that `DB.syncState` holds the CRAWL and this holds the RUN, and the two
   * have different lifetimes and different reasons to exist.
   *
   * No clip content, no cursor, no oracle numbers, no token material: six scalars
   * saying whether a crawl is in flight, and when it started. `storage.session` is
   * the right home for exactly that, because it SURVIVES service-worker eviction
   * (which is the bug) and is CLEARED when the browser closes (which is correct —
   * a browser that is not running is not running a crawl). */
  SESSION_SYNC_RUN: 'suno.syncRun.session',
});

const META_KEYS = Object.freeze({
  ACTIVE_BATCH: 'batch.active',
  BATCH_PREFIX: 'batch.plan.',
  PROJECTS: 'projects.cached',
  SELECTION: 'selection.durable',
  // The disliked id set, produced by the `filters.disliked:'True'` walk. The
  // symmetric-difference keys that sat beside it (`feed.baseIds`,
  // `feed.seenIds`) are REMOVED: they existed only to work around v3's missing
  // per-clip dislike field, which the server-side filter now covers.
  FEED_DISLIKED_IDS: 'feed.dislikedIds',
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

/**
 * How long `clerk-token` is allowed to WAIT inside the page for Clerk to appear.
 *
 * This is the actual fix for the sign-in bug. The old primary pass injected with
 * `injectImmediately:true`, i.e. at document_start, and read `window.Clerk`
 * exactly once: at document_start Clerk has not constructed its instance yet, so
 * the read returned undefined and there was no retry. A single un-waiting probe
 * can only ever lose that race. Twelve seconds covers Clerk's own bundle load on
 * a slow connection and still fits inside the request budget of every caller
 * that triggers a mint.
 */
const CLERK_WAIT_DEFAULT_MS = 12000;

/** Floor/ceiling for a caller-supplied `clerk-token` timeout. */
const CLERK_WAIT_MIN_MS = 500;
const CLERK_WAIT_MAX_MS = 30000;

/** Ring-buffer cap for the diagnostics log (also persisted to storage.local). */
const DIAG_BUFFER_CAP = 500;

/** How often the in-memory diagnostics buffer is written through to storage. */
const DIAG_FLUSH_MS = 750;

/**
 * Default per-page flush cadence for the DISLIKED ID SET. Persisting a
 * 3,000-id array on every page would dominate the crawl; persisting only at the
 * end would lose the set to an eviction. Five pages bounds both.
 *
 * It used to also gate the two symmetric-difference id sets (`feed.baseIds`,
 * `feed.seenIds`). Both are gone: `/api/feed/v3` filters disliked SERVER-SIDE
 * (`filters.disliked`), so `dislikedMode:'both'` is two ordinary walks whose
 * results need no differencing. Only the id set is still worth flushing.
 */
const DISLIKED_FLUSH_EVERY_PAGES = 5;

/** Hard ceiling on clips buffered in memory during a forced full rebuild. */
const FULL_REBUILD_BUFFER_CAP = 25000;

/**
 * `syncState.feed` shape marker.
 *
 * WHY: `/api/feed/v2` paged by PAGE NUMBER and the cursor stored `nextPage`;
 * `/api/feed/v3` pages by CURSOR and stores a per-project plan instead. A row
 * left by the v2 era therefore has a `nextPage` that means nothing to a cursor
 * walk and no project plan to resume from. A mismatched marker is treated as
 * "not resumable" and the crawl starts from a fresh plan, rather than silently
 * skipping the first N pages of the first project.
 *
 * BUMPED 2 -> 3 FOR THE `totalSeen` SPLIT, NOT FOR A NEW CRAWL SHAPE: schema 2
 * stored one number under `totalSeen` (rows EXAMINED, repeats across projects
 * included) and a different one under `uniqueSeen`. Schema 3 stores the UNIQUE
 * count under `totalSeen` — so the stored row means what every reply means — and
 * the examined count under `examined`, which is what the oracle is compared
 * against. A schema-2 row therefore carries a `totalSeen` whose meaning is the
 * OPPOSITE of a schema-3 row's, and reading it as the unique count would resume
 * with a total larger than the library ("4,600 of ~4,500"). The marker is the
 * mechanism that exists for exactly this, so it is used rather than a silent
 * reinterpretation of an old field.
 */
const SYNC_CURSOR_SCHEMA = 3;

/** Cursor fields from the page-number era. Never meaningful on a cursor walk. */
const LEGACY_PAGE_FIELDS = Object.freeze(['nextPage', 'pass']);

/**
 * Page cap for the `/api/project/me` walk that enumerates the workspaces.
 *
 * The route is paged (20 per page) and `num_total_results` is the project count.
 * `fetchProjects()` reads page 1 only, which on a 20-project account happens to
 * be the whole list and on a 25-project account silently loses five of them.
 * On the recon account that is the whole bug: `default` held 3,444 of ~5,500
 * clips and every other project was unreachable, because only `default` was
 * ever walked.
 */
const PROJECT_LIST_MAX_PAGES = 100;

/**
 * `/api/project/me` returns 20 projects per page.
 *
 * A PROGRESS HINT ONLY — never a stop condition. `num_total_results` is the stop
 * condition; a short page with no advertised total is an incomplete list, not a
 * finished one.
 */
const PROJECT_LIST_PAGE_HINT = 20;

/**
 * Feed-page size bounds for `settings.feedPageLimit`. The ceiling is the client's
 * own documented maximum (`SunoAPI.LIMITS.feedPageLimit`) rather than a literal
 * here, so the two can never disagree about what 100 means.
 * @type {{min:number, max:number}}
 */
const FEED_PAGE_LIMIT_RANGE = Object.freeze({
  min: 1,
  max: SunoAPI && SunoAPI.LIMITS && Number.isFinite(SunoAPI.LIMITS.feedPageLimit)
    ? SunoAPI.LIMITS.feedPageLimit
    : 100,
});

/**
 * How much of a workspace may be missing before a shortfall stops being
 * explainable by trashed/disliked accounting.
 *
 * THE ARITHMETIC BEHIND THE NUMBER. `project.clip_count` is a project ROW count
 * and the default walk is a FILTERED request (`filters.trashed:'False'`,
 * `filters.disliked:'False'`). Nothing in the wire contract says the count
 * excludes those rows, so a small shortfall is exactly what that mismatch looks
 * like: a handful of trashed or disliked clips on a workspace of thousands. The
 * failure being hunted looks nothing like that — it loses 80-90% of the library,
 * which is orders of magnitude larger — so anything at or below 5% of the
 * workspace (and at least one row) is reported as `shortfallLikelyFilters`, and
 * the copy is allowed to say "this may be trashed/disliked clips, OR truncation".
 *
 * NOT A TRUNCATION DETECTOR. It only decides which sentence the UI is allowed to
 * lead with. The `completed:false` verdict does not depend on it, because a
 * shortfall of either size means the library on disk is short of what the account
 * says it has.
 */
const SHORTFALL_FILTER_CAUSE_SHARE = 0.05;


/**
 * `dislikedMode` -> the SERVER-SIDE tri-state filter handed to `iterateFeed`.
 *
 * WHY A TABLE: the previous build passed `mode` straight through as
 * `iterateFeed({disliked})` and separately asked for `disliked:'both'`, whose
 * `type:'dislikedIds'` envelope the client no longer emits. `for await` then
 * never matched that envelope, so `dislikedIds` stayed null and the run recorded
 * `dislikedCount: 0` — a hard "you have zero dislikes" claim built out of an
 * envelope that was never read. Every value here is one of the three strings the
 * client forwards as `filters.disliked` (`'True'` / `'False'` / `'Any'`).
 */
const DISLIKED_FILTER_BY_MODE = Object.freeze({
  // "hide dislikes" -> ONE walk with `filters.disliked:'False'`.
  exclude: 'exclude',
  // "index everything" -> ONE walk with `filters.disliked:'Any'`. Suno exposes no
  // per-clip dislike field, so WHICH of these clips are disliked is not knowable
  // from this walk; `dislikedCount` stays unknown (null) rather than being
  // reported as 0, which is what a null used to be silently converted into.
  include: 'any',
  // "index both, and tell me which" -> the library walk hides dislikes
  // (`'False'`) and a SECOND walk over `'True'` yields the id set to stamp.
  both: 'exclude',
});

/** The `iterateFeed` filter that returns ONLY the disliked clips. */
const DISLIKED_ONLY_FILTER = 'only';

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
  /**
   * Page size asked of `POST /api/feed/v3`, clamped to [1, 100].
   *
   * WHY A SETTING AT ALL, WHEN 100 IS THE DOCUMENTED MAXIMUM: because the
   * maximum is UNVERIFIED. 100 is what the shipped web client's own caller sends,
   * what the bundle contains, and what two third-party extensions claim; no live
   * response has been checked against it. If the server really caps pages at 20,
   * every "full page" inference and every page-count estimate is wrong by 5x —
   * and the only way to find out on a real account, without a rebuild, is to ask
   * for 100 and then ask for 20 and compare. That is what `PROBE_FEED` is for, and
   * it takes a `limit` of its own so the experiment needs no settings change at
   * all; this setting is the persistent form of the same experiment.
   *
   * NOT A PROOF OF COMPLETENESS: this value bounds what a page can hold, never
   * where the library ends. Only the server's own cursor does that.
   */
  feedPageLimit: 100,
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
  'SYNC_STARTED', 'SYNC_PROGRESS', 'SYNC_DONE', 'SYNC_ERROR',
  'SYNC_CANCEL_REQUESTED', 'SYNC_CANCELLED',
  'DL_PROGRESS', 'DL_ITEM', 'DL_DONE', 'DL_ERROR',
  'TOKEN_CHANGED',
]));

/* ==========================================================================
 * 2. DIAGNOSTICS
 *
 * MOVED to `background/parts/02-diagnostics.js`, loaded by `importScripts` at
 * the top of this file. Its three mutable bindings (`diagBuffer`,
 * `diagFlushTimer`, `diagFlushPending`) are section-local, verified by reference
 * count before the move. Note the mutual call-time dependency with
 * `03-errors.js` — this section calls `redactText` and is called by `log` —
 * for which the importScripts order is genuinely irrelevant.
 * ======================================================================== */

/* ==========================================================================
 * 3. ERRORS, REDACTION, CLASSIFICATION
 *
 * MOVED to `background/parts/03-errors.js`, loaded by `importScripts` at the
 * top of this file. Extracted second because it has no mutable module-scope
 * state and every identifier it needs from the monolith is read at CALL time,
 * so the move cannot change when anything resolves. Its five exports are read
 * by 16 of the remaining sections, which is precisely why they stay hoisted
 * globals on this side rather than becoming properties to be destructured.
 * ======================================================================== */

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
 * @property {number} feedPageLimit page size asked of `POST /api/feed/v3`,
 *   clamped to [1, `SunoAPI.LIMITS.feedPageLimit`] and floored to a whole number,
 *   default 100. Coerced by `resolveFeedPageLimit`, which treats `null`/`''`/
 *   absent as MISSING rather than as 0 — otherwise a cleared field would mean
 *   "one clip per page". This is a CEILING ON WHAT WE ASK FOR, never a claim
 *   about what the server grants or about where the library ends: the ceiling is
 *   the shipped client's documented maximum and has never been checked against a
 *   live response, which is what `PROBE_FEED` exists to settle. An account that
 *   caps pages below this value is not truncated BY it — the cursor chain still
 *   walks to the end — but the `pagesFull`/`lastPageSize` figures reported per
 *   crawl will show it.
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
  // Feed page size. Floored (a page size of 20.7 is not a page size) and clamped
  // to the client's documented ceiling; see `resolveFeedPageLimit` for why this is
  // not `clampNumber` alone.
  out.feedPageLimit = resolveFeedPageLimit(input.feedPageLimit, DEFAULT_SETTINGS.feedPageLimit);

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
 * Resolve `settings.feedPageLimit` — the page size the crawl asks
 * `POST /api/feed/v3` for — to a whole number in [1, 100].
 *
 * WHY NOT `clampNumber`. Two things, both of which `clampNumber` gets wrong for
 * this key:
 *   - A page size must be an INTEGER. `limit: 20.7` is not a page size, and
 *     forwarding a float to the wire turns "ask for 20" into a request no server
 *     has ever been shown accepting.
 *   - `clampNumber(null)` returns `0` (because `Number(null) === 0`), which the
 *     clamp then raises to `1`. So a settings blob that carries the key with an
 *     explicit `null` — an exported file, an options page that clears the field,
 *     a JSON round trip — would silently turn a 5,500-clip crawl into a
 *     5,500-request crawl at one clip per page. A missing value is a missing
 *     value, not a request for the smallest legal page, which is why `null`,
 *     `undefined`, `''` and booleans are treated as absent here exactly as
 *     `snapToChoice` treats them.
 *
 * The range is [1, {@link SunoAPI.LIMITS}.feedPageLimit] and is read from the
 * client rather than restated, so this file and `lib/api.js` cannot disagree about
 * the ceiling. That ceiling is what the client will ASK for; it is not a verified
 * statement about what the server grants — see `DEFAULT_SETTINGS.feedPageLimit`.
 *
 * @param {unknown} value
 * @param {number} fallback used when `value` is absent or unusable
 * @returns {number} an integer in [1, 100]; never NaN, never 0
 */
function resolveFeedPageLimit(value, fallback) {
  const min = Number.isFinite(FEED_PAGE_LIMIT_RANGE.min) ? FEED_PAGE_LIMIT_RANGE.min : 1;
  const max = Number.isFinite(FEED_PAGE_LIMIT_RANGE.max) ? FEED_PAGE_LIMIT_RANGE.max : 100;
  const safe = Number.isFinite(fallback) ? Math.floor(fallback) : max;
  const bounded = Math.min(max, Math.max(min, safe));
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') {
    return bounded;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return bounded;
  return Math.min(max, Math.max(min, Math.floor(num)));
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

/**
 * The content-script token relay's waiter map used to live here. It is gone:
 * `content/content.js` has no `SUNO_TOKEN_REQUEST` handler and never had one —
 * the only way a content script could read `window.Clerk` was an inline
 * `<script>` element, which suno.com's own CSP refuses to execute while still
 * letting the append "succeed". Nothing could ever have answered, so the waiter
 * could only ever be resolved by its own timeout.
 *
 * What replaced it is the layered MAIN-world strategy in §5b: an `Authorization`
 * header tap on Suno's own requests (`auth-tap`/`auth-read`), which does not
 * depend on Clerk being a page global at all, with a real in-page wait
 * (`clerk-token`) for the case where it is.
 */

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
 * Refill `authCache` from session storage, if what is there is still usable.
 *
 * WHY `authCache` IS A CACHE AND NOT A SECOND SOURCE OF TRUTH — and why this is
 * needed at all, given `getAuthToken` already falls back to `readSessionToken`:
 *
 * The gap is not the token, it is what the FALLBACK COSTS. `getAuthToken` on a
 * cold worker has to await a `chrome.storage.session` read before it can use a
 * token that is already on disk, and `SunoAPIClient` — whose own `cachedToken`
 * died with the worker too — reaches it through a `tokenProvider` that, on a
 * miss, runs the whole four-layer MAIN-world sweep: a `chrome.scripting`
 * injection per Suno tab and up to `CLERK_WAIT_DEFAULT_MS` (12 s) of waiting for
 * a page global that may not exist. A crawl that resumes at the start of a page
 * pays that on its first request, and pays it again on the next one if the mint
 * fails for want of a tab. Warming the cache at wake collapses all of it to one
 * storage read, and `SunoAPIClient` is handed the same entry through
 * `getAuthToken`, so the two caches warm together.
 *
 * NOTHING NEW IS PERSISTED. The token was already in `chrome.storage.session`
 * (invariant G: no token is ever written outside it) — this reads a record that
 * exists rather than creating one, and it expires with the browser, which is the
 * right lifetime for a bearer token.
 *
 * A token that is present but no longer fresh is deliberately NOT warmed: the
 * cache exists to skip a mint, and caching a token inside the refresh skew would
 * make `isFreshToken` decide the opposite way on the next call. It is left for
 * `getAuthToken` to mint over, exactly as if this had never run.
 *
 * @returns {Promise<{warmed:boolean, expiresAt:number|null}>}
 */
async function warmAuthCacheOnWake() {
  const stored = await readSessionToken();
  if (!stored) {
    log('debug', 'auth.cache_warm_empty', {});
    return { warmed: false, expiresAt: null };
  }
  if (!isFreshToken(stored, false)) {
    /* Logged WITHOUT the token: `expiresAt` is the JWT's own `exp` claim, which
     * is a timestamp, and the presence of the record is already the fact worth
     * having. */
    log('info', 'auth.cache_warm_stale', {
      expiresAt: Number.isFinite(stored.exp) ? stored.exp : null,
      obtainedAt: Number.isFinite(stored.obtainedAt) ? stored.obtainedAt : null,
    });
    return { warmed: false, expiresAt: Number.isFinite(stored.exp) ? stored.exp : null };
  }
  authCache = stored;
  log('info', 'auth.cache_warmed', {
    expiresAt: stored.exp,
    obtainedAt: stored.obtainedAt,
  });
  return { warmed: true, expiresAt: stored.exp };
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
 * `tabId` is the caller's own tab when the caller knows it. It only affects
 * WHICH tab is tried first — the token is a page-agnostic bearer token — but
 * preferring the tab the user is looking at beats an arbitrary sweep order.
 *
 * @param {{force?:boolean, tabId?:number}} [opts]
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

  tokenMintInFlight = mintAuthToken(force, opts && opts.tabId)
    .then(async (token) => {
      if (!token) {
        log('warn', 'auth.mint_failed', {
          // `lastAuthFailure` is the answer to "which of the four layers was
          // reached, and what did each one say". No token material: every
          // field in it is a description of the search.
          ...(lastAuthFailure || {}),
          reason: 'no MAIN-world source produced a token on any tab',
        });
        return null;
      }
      await writeSessionToken(token);
      return token;
    })
    .catch((err) => {
      log('error', 'auth.mint_threw', { error: describeError(err) });
      return null;
    })
    // `finally`, not two separate assignments: the in-flight guard must be
    // released on EVERY path — success, null, and throw. Clearing it inside
    // `.then` and `.catch` separately is correct only while both exist, and a
    // cached failed mint would block every later retry.
    .finally(clearTokenMintInFlight);
  return tokenMintInFlight;
}

/**
 * The tab the user is actually looking at, when it is a Suno tab.
 *
 * `mintAuthToken` used to sweep `findSunoTabs()` and take the FIRST tab that
 * answered. With several Suno tabs open that ordering is arbitrary, and the tab
 * the user is watching is the one whose Clerk session is guaranteed to be
 * warm. `currentWindow:true` resolves to the most recently focused window from
 * the worker, and the same `SUNO_TAB_PATTERNS` list is passed through so this
 * cannot drift from what `findSunoTabs` considers a Suno tab.
 *
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function activeSunoTab() {
  try {
    const active = await chrome.tabs.query({
      active: true,
      currentWindow: true,
      url: SUNO_TAB_PATTERNS,
    });
    const tab = Array.isArray(active) ? active[0] : null;
    return tab && typeof tab.id === 'number' ? tab : null;
  } catch (queryErr) {
    // Not fatal: this is an ordering preference, and the sweep below still runs.
    log('debug', 'auth.active_tab_query_failed', { error: describeError(queryErr) });
    return null;
  }
}

/**
 * The tabs a mint may use, in order.
 *
 * Order of preference, and the ONLY ordering change: the caller's own tab, then
 * the focused window's active Suno tab, then everything else. Taking the FIRST
 * tab that yields a token is arbitrary when several Suno tabs are open, and the
 * tab the user is looking at is the one whose Clerk session and whose outgoing
 * API traffic are guaranteed to be warm. Duplicates are dropped so no tab is
 * injected into twice in one pass.
 *
 * Tab ids only — a URL query string can carry a share id or an OAuth
 * continuation and must never reach a log.
 *
 * @param {number} [preferredTabId]
 * @returns {Promise<Array<{id:number, active?:boolean}>>}
 */
async function orderedMintTabs(preferredTabId) {
  const [active, tabs] = await Promise.all([activeSunoTab(), findSunoTabs()]);
  const ordered = [];
  const seen = new Set();
  const consider = (tab) => {
    if (!tab || typeof tab.id !== 'number' || seen.has(tab.id)) return;
    seen.add(tab.id);
    ordered.push({ id: tab.id, active: tab.active === true });
  };
  if (Number.isFinite(preferredTabId)) consider({ id: preferredTabId });
  consider(active);
  for (const tab of tabs) consider(tab);
  return ordered;
}

/**
 * Is a MAIN-world token result a credential we are willing to hand on?
 *
 * Whole-or-nothing on purpose: a truncated or whitespace-bearing value is not a
 * JWT, and forwarding one produces a 401 that reads like an expired session.
 *
 * @param {unknown} token
 * @returns {boolean}
 */
function isUsableJwt(token) {
  return typeof token === 'string' && token.length >= 20 && !/\s/.test(token);
}

/**
 * Mint a Clerk JWT through a LAYERED strategy over the MAIN-world ops.
 *
 * WHY LAYERED. Two independent things are not knowable from this build:
 *
 *   * Whether Suno publishes `window.Clerk` as a page global. If it does not,
 *     every Clerk-based path is a guaranteed miss and the user is signed in and
 *     still told otherwise — which is exactly the bug being fixed.
 *   * Whether a given tab is past document_start when we look at it. Clerk's
 *     instance does not exist that early, so a single un-waiting read can only
 *     ever lose the race. `clerk-token` waits inside the page, which is the fix.
 *
 * So the order below is cheapest-and-most-likely first, and the expensive wait
 * LAST:
 *
 *   a. `auth-read`  — the tap's captured header. No page dependency, and once the
 *                    tap is installed it is one instant MAIN-world call. This is
 *                    the fast common path: a working tap never reaches (c).
 *   b. `auth-tap`   — idempotent; installs the tap if the content script has not
 *                    already done so on mount, then re-run (a).
 *   c. `clerk-token` — the real wait (default `CLERK_WAIT_DEFAULT_MS`). This is
 *                    what fixes the document-start race, and it is why it is
 *                    third and not first: it costs up to 12 seconds, and (a)/(b)
 *                    have already answered or proved they cannot.
 *   d. `auth-read`  — once more, because the page may well have made an
 *                    authenticated request while (c) was waiting.
 *
 * First non-empty token wins.
 *
 * @param {boolean} force
 * @param {number} [preferredTabId] the caller's own tab, when the caller had one
 * @returns {Promise<string|null>}
 */
async function mintAuthToken(force, preferredTabId) {
  const ordered = await orderedMintTabs(preferredTabId);
  const steps = [];
  let reachedOp = null;
  let tapInstalled = false;
  let usedTabId = null;

  log('debug', 'auth.mint_start', { tabsFound: ordered.length, tabIds: ordered.map((t) => t.id) });

  if (!ordered.length) {
    lastAuthFailure = {
      at: Date.now(),
      reason: 'no_suno_tab',
      tabsFound: 0,
      tabsTried: 0,
      tabIds: [],
      usedTabId: null,
      tapInstalled: false,
      reachedOp: null,
      steps: [],
    };
    return null;
  }

  /** Record one step of the search and keep it for the diagnostics reply. */
  const record = (op, tabId, ok, code, error) => {
    steps.push({ op, tabId, ok, code: code || null, error: error || null });
    return ok;
  };

  /** Run one op on one tab and normalise it into `{ok, token, result}`. */
  const tryOp = async (op, tabId, payload) => {
    const reply = await injectMainWorldOp(op, tabId, payload || {});
    if (!reply.ok) {
      record(op, tabId, false, reply.code, reply.error);
      return { ok: false, token: null, result: null };
    }
    const result = reply.result;
    const opOk = result.ok !== false && !result.error;
    if (op === 'auth-read' || op === 'clerk-token') {
      const token = isUsableJwt(result.token) ? result.token : null;
      record(op, tabId, !!token, null, token ? null : (result.error || 'no usable token'));
      return { ok: !!token, token, result };
    }
    record(op, tabId, opOk, null, result.error || null);
    return { ok: opOk, token: null, result };
  };

  // --- (a) read the tap, if one is already there --------------------------
  for (const tab of ordered) {
    reachedOp = 'auth-read';
    const hit = await tryOp('auth-read', tab.id);
    if (hit.ok) {
      usedTabId = tab.id;
      log('info', 'auth.minted_from_tap', { tabId: tab.id, forced: force, ageMs: hit.result.ageMs });
      return hit.token;
    }
  }

  // --- (b) install the tap, then read it again -----------------------------
  // The content script also fires `RUN_MAIN_WORLD {op:'auth-tap'}` on mount, so
  // the tap is normally in place before this runs. This step is the worker-side
  // guarantee for a tab whose content script never mounted (a signed-in Suno tab
  // with no dock, an about:blank that just navigated) — and `authTap()` is
  // idempotent, so re-installing over an existing one is a cheap no-op.
  for (const tab of ordered) {
    reachedOp = 'auth-tap';
    const install = await tryOp('auth-tap', tab.id);
    if (install.ok) {
      tapInstalled = true;
      log('debug', 'auth.tap_ready', {
        tabId: tab.id,
        alreadyInstalled: install.result.alreadyInstalled === true,
        fetchHooked: install.result.fetchHooked === true,
        xhrOpenHooked: install.result.xhrOpenHooked === true,
        xhrHeaderHooked: install.result.xhrHeaderHooked === true,
      });
    }
    reachedOp = 'auth-read';
    const hit = await tryOp('auth-read', tab.id);
    if (hit.ok) {
      usedTabId = tab.id;
      log('info', 'auth.minted_from_tap_after_install', { tabId: tab.id, forced: force });
      return hit.token;
    }
  }

  // --- (c) Clerk, with a real in-page wait ---------------------------------
  for (const tab of ordered) {
    reachedOp = 'clerk-token';
    const hit = await tryOp('clerk-token', tab.id, { timeoutMs: CLERK_WAIT_DEFAULT_MS });
    if (hit.ok) {
      usedTabId = tab.id;
      log('info', 'auth.minted_from_clerk', { tabId: tab.id, forced: force, waitedMs: hit.result.waitedMs });
      return hit.token;
    }
  }

  // --- (d) the page may have called the API while we waited ----------------
  for (const tab of ordered) {
    reachedOp = 'auth-read';
    const hit = await tryOp('auth-read', tab.id);
    if (hit.ok) {
      usedTabId = tab.id;
      log('info', 'auth.minted_from_tap_after_wait', { tabId: tab.id, forced: force, ageMs: hit.result.ageMs });
      return hit.token;
    }
  }

  // Nothing worked. Publish the structured account of WHY, so the next "not
  // signed in" report can be answered instead of guessed at. Nothing in here is
  // token material: it is the op, the tab id, and the error string each op
  // produced.
  lastAuthFailure = {
    at: Date.now(),
    reason: 'no_source_produced_a_token',
    tabsFound: ordered.length,
    tabsTried: ordered.length,
    tabIds: ordered.map((t) => t.id),
    usedTabId,
    tapInstalled,
    reachedOp,
    steps,
  };
  return null;
}

/**
 * Every Suno tab we may talk to.
 *
 * `chrome.tabs.query({url})` is URL-FILTERED, and whether it is honoured depends
 * on how the browser grants host-permission-scoped tab reads. An empty result
 * from it therefore does NOT prove there is no Suno tab — it may mean the filter
 * was not applied. So an empty answer falls back to an unfiltered query with the
 * SAME patterns applied in JS, and only an empty result from both is reported as
 * "no Suno tabs".
 *
 * @returns {Promise<Array<chrome.tabs.Tab>>}
 */
async function findSunoTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: SUNO_TAB_PATTERNS });
    if (Array.isArray(tabs) && tabs.length) return tabs;
  } catch (queryErr) {
    log('warn', 'auth.tabs_query_failed', { error: describeError(queryErr) });
  }
  // Fallback: filter in JS against the same patterns.
  try {
    const all = await chrome.tabs.query({});
    if (!Array.isArray(all)) return [];
    const matchers = SUNO_TAB_PATTERNS.map((pattern) => {
      try {
        return new RegExp(pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'));
      } catch (compileErr) {
        void compileErr;
        return null;
      }
    }).filter(Boolean);
    const matched = all.filter((tab) => {
      const url = tab && typeof tab.url === 'string' ? tab.url : '';
      if (!url) return false;
      for (const matcher of matchers) {
        if (matcher.test(url)) return true;
      }
      return false;
    });
    log('debug', 'auth.tabs_query_fallback', { scanned: all.length, matched: matched.length });
    return matched;
  } catch (fallbackErr) {
    log('warn', 'auth.tabs_query_fallback_failed', { error: describeError(fallbackErr) });
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
 * 5b. MAIN-WORLD OPERATIONS
 *
 * WHY THIS SECTION EXISTS. suno.com ships
 *
 *   script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' …
 *
 * with no `'unsafe-inline'`. A content script that builds a `<script>` element,
 * assigns `.textContent` and appends it to `document.head` gets a SUCCESSFUL
 * APPEND and a BLOCKED EXECUTION — the CSP violation is reported afterwards — so
 * an inline-injection helper returns `true` while nothing ran at all. That
 * silently killed three things: the `window.MediaSource` patch never landed, so
 * every HLS capture burned a 20s poll and then failed with a misleading "no
 * manifest appeared"; the page token reader never ran, so `requestPageToken()`
 * was a no-op; and the RESTORE never ran either, which means that if a patch
 * ever HAD landed, the page would have been left with `MediaSource` destroyed
 * and Suno's own player broken. There is no way to make inline injection work
 * from a content script, and the page's CSP is not to be worked around.
 *
 * `chrome.scripting.executeScript({world:'MAIN'})` runs in the page's main world
 * but is NOT subject to the page's CSP. That is the only route this build uses.
 *
 * THE CONTRACT EVERY FUNCTION BELOW MUST HONOUR
 *
 * 1. SELF-CONTAINED. `executeScript` stringifies `func` and evaluates it in the
 *    page, so a MAIN-world function CANNOT close over anything in this file.
 *    Every constant it needs is a literal inside its own body. (That is also why
 *    `MAIN_WORLD_OPS` exists rather than a name the page resolves: the map is
 *    the worker's copy, and only the value — the source text — crosses.)
 * 2. NEVER THROW ACROSS THE BRIDGE. A MAIN-world exception surfaces at the
 *    worker as an opaque `inject_failed`, destroying the distinction between
 *    "the operation ran and failed" and "the operation never ran". So every one
 *    of them catches internally and returns a plain object carrying `ok:false`
 *    and an `error` string.
 * 3. PLAIN, JSON-SERIALISABLE VALUES ONLY. No function objects, no DOM nodes, no
 *    `Headers`, no `Request`. The result is copied through Chrome's own
 *    serialiser to reach this worker, so anything exotic comes back mangled or
 *    missing.
 * 4. NO TOKEN EVER APPEARS IN A FIELD THAT IS NOT `token`. `token` is the only
 *    field any caller is allowed to forward, and it must be whole: a truncated
 *    or malformed JWT is worse than none, because it produces a 401 that reads
 *    like an expired session.
 * ======================================================================== */

/**
 * Reachability diagnostic. Answers "what can this page actually give us?" in
 * one injection, which is the question every "not signed in" report should be
 * answered with instead of a guess.
 *
 * `href` is reported as origin + pathname only. A suno.com query string can
 * carry a share id, a search, or an OAuth continuation, and this result is
 * written into a diagnostics ring buffer that is PERSISTED to
 * chrome.storage.local — so the query is dropped here rather than at every
 * call site.
 *
 * @returns {{ok:boolean, href:string, hasClerk:boolean, hasSession:boolean,
 *   getTokenType:string|null, hasMediaSource:boolean, mediaSourceType:string|null,
 *   hasFetch:boolean, hasXHR:boolean, tapInstalled:boolean, tapHasToken:boolean,
 *   readyState:string, error:string|null}}
 */
function mainWorldProbe() {
  /** typeof, or null for absent — never the value itself. */
  const typeName = (value) => (value === null || value === undefined ? null : typeof value);
  const out = {
    ok: false,
    href: '',
    hasClerk: false,
    hasSession: false,
    getTokenType: null,
    hasMediaSource: false,
    mediaSourceType: null,
    hasFetch: false,
    hasXHR: false,
    tapInstalled: false,
    tapHasToken: false,
    readyState: '',
    error: null,
  };
  try {
    out.href = String(location.origin || '') + String(location.pathname || '');
    out.readyState = String(document.readyState || '');
    const clerk = window.Clerk;
    out.hasClerk = !!clerk;
    out.hasSession = !!(clerk && clerk.session);
    out.getTokenType = out.hasSession ? typeName(clerk.session.getToken) : null;
    out.hasMediaSource = 'MediaSource' in window;
    out.mediaSourceType = typeName(window.MediaSource);
    out.hasFetch = typeof window.fetch === 'function';
    out.hasXHR = typeof window.XMLHttpRequest === 'function';
    // `read` is a getter, `hasToken` a predicate: neither is ever RETURNED, only
    // called, because a function object cannot survive the bridge.
    const holder = window.__smAuthTap;
    out.tapInstalled = !!(holder && holder.version === 1);
    out.tapHasToken = out.tapInstalled && typeof holder.hasToken === 'function'
      ? holder.hasToken() === true
      : false;
    out.ok = true;
    return out;
  } catch (probeErr) {
    out.error = 'probe failed: ' + (probeErr && probeErr.message ? String(probeErr.message) : 'unknown');
    return out;
  }
}

/**
 * Install a passive observer that captures the `Authorization: Bearer <jwt>`
 * header off Suno's OWN requests.
 *
 * This is the proven approach — it is what the working third-party extensions in
 * `scratchpad/extracted/` do — and it is here because the alternative cannot be
 * relied on: whether Suno publishes `window.Clerk` as a page global is not
 * knowable from this build, and if it does not, every `Clerk`-based path is a
 * guaranteed miss. Suno sends a real `Authorization` header on its own API calls
 * whether or not it also exposes the instance.
 *
 * TRANSPARENCY, which is the only thing that makes page tampering acceptable:
 * every inspection is individually wrapped, and the original is ALWAYS called
 * through — the wrappers cannot alter, delay, reorder or block a request, and
 * cannot throw into the page's call. If any inspection throws, the request
 * happens exactly as it would have without us.
 *
 * READ-ONLY. Nothing is added to, removed from, or rewritten on any request.
 *
 * IDEMPOTENT. `window.__smAuthTap` is written BEFORE any wrapper is installed,
 * so a second call can never double-wrap `fetch` or `XMLHttpRequest.prototype`
 * even if the first call died part-way. A double-wrap is a permanent,
 * unbounded page regression; a partial install is merely reported. Per-hook
 * outcomes are recorded on the holder so the lost information is not lost.
 *
 * THE TOKEN'S EXPOSURE, stated honestly rather than implied away: the captured
 * value is kept in a closure and is reachable only through the holder's `read()`
 * getter, but that holder lives on `window`. Any script the page itself runs can
 * therefore read it. That grants a same-origin page script nothing it does not
 * already have — the JWT is in the page's own memory and in every outgoing
 * request header — and this build does not send it anywhere except the worker,
 * which stores it in `chrome.storage.session` and presents it to Suno. It is
 * still worth being accurate about: this is the page's credential, not a
 * credential this extension created.
 *
 * @returns {{ok:boolean, alreadyInstalled:boolean, installedAt:number|null,
 *   fetchHooked:boolean, xhrOpenHooked:boolean, xhrHeaderHooked:boolean,
 *   hasToken:boolean, errors:string[]}}
 */
function mainWorldAuthTap() {
  const out = {
    ok: false,
    alreadyInstalled: false,
    installedAt: null,
    fetchHooked: false,
    xhrOpenHooked: false,
    xhrHeaderHooked: false,
    hasToken: false,
    errors: [],
  };

  // Re-derive the current state of an existing install rather than reporting
  // only what the first call recorded: a hook can be removed later by the page
  // itself, and then `probe`/`authRead` must see the truth.
  const describeExisting = (holder) => {
    out.alreadyInstalled = true;
    out.installedAt = Number.isFinite(holder.installedAt) ? holder.installedAt : null;
    try {
      out.fetchHooked = window.fetch && window.fetch.__smAuthTapWrapped === true;
      out.xhrOpenHooked = typeof window.XMLHttpRequest === 'function'
        && window.XMLHttpRequest.prototype.open.__smAuthTapWrapped === true;
      out.xhrHeaderHooked = typeof window.XMLHttpRequest === 'function'
        && window.XMLHttpRequest.prototype.setRequestHeader.__smAuthTapWrapped === true;
      out.hasToken = typeof holder.hasToken === 'function' ? holder.hasToken() === true : false;
    } catch (inspectErr) {
      out.errors.push('inspect: ' + (inspectErr && inspectErr.message ? String(inspectErr.message) : 'unknown'));
    }
    out.ok = true;
    return out;
  };

  try {
    const existing = window.__smAuthTap;
    if (existing && existing.version === 1) return describeExisting(existing);
  } catch (readErr) {
    out.errors.push('marker read: ' + (readErr && readErr.message ? String(readErr.message) : 'unknown'));
  }

  // The captured credential. Closure-private: nothing outside this install can
  // name `state`, only call `holder.read()`.
  const state = { token: null, at: 0, hits: 0 };

  const record = (value) => {
    try {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      // Only a real bearer credential. Anything shorter than 20 chars, or
      // containing whitespace, is a malformed value and must not be handed on
      // as a token — a truncated JWT produces a 401 indistinguishable from an
      // expired session.
      if (trimmed.slice(0, 7).toLowerCase() !== 'bearer ') return;
      const token = trimmed.slice(7).trim();
      if (!token || token.length < 20 || /\s/.test(token)) return;
      state.token = token;
      state.at = Date.now();
      state.hits += 1;
    } catch (recordErr) {
      void recordErr;
    }
  };

  // Hosts inlined rather than read from SUNO_API_* constants: this function is
  // evaluated in the page and cannot see this file's scope.
  const isSunoApi = (raw) => {
    try {
      if (!raw) return false;
      const u = new URL(String(raw), location.href);
      const host = String(u.hostname || '').toLowerCase();
      return host === 'studio-api-prod.suno.com' || host === 'studio-api.prod.suno.com';
    } catch (urlErr) {
      return false;
    }
  };

  const urlOf = (input) => {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;     // Request
      if (input && typeof input.href === 'string') return input.href;   // URL
    } catch (inErr) {
      void inErr;
    }
    return '';
  };

  /**
   * Read `Authorization` out of whatever header container `fetch` was handed:
   * a `Headers` instance, a plain object, or an array of `[name, value]` pairs.
   * All three are legal in the Fetch spec and Suno's own bundle uses more than
   * one, so supporting only the first would silently miss captures.
   */
  const authFromHeaders = (headers) => {
    if (!headers) return null;
    try {
      if (typeof headers.get === 'function') {
        const v = headers.get('authorization');
        return typeof v === 'string' ? v : null;
      }
    } catch (headersErr) {
      void headersErr;
    }
    try {
      if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i++) {
          const pair = headers[i];
          if (!pair || pair.length < 2) continue;
          if (String(pair[0]).toLowerCase() === 'authorization') {
            return typeof pair[1] === 'string' ? pair[1] : null;
          }
        }
        return null;
      }
      const keys = Object.keys(headers);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === 'authorization') {
          const v = headers[keys[i]];
          return typeof v === 'string' ? v : null;
        }
      }
    } catch (plainErr) {
      void plainErr;
    }
    return null;
  };

  const nativeFetch = window.fetch;
  const XHR = window.XMLHttpRequest;
  const nativeOpen = XHR && XHR.prototype ? XHR.prototype.open : null;
  const nativeSetHeader = XHR && XHR.prototype ? XHR.prototype.setRequestHeader : null;

  // Marker written FIRST (see the JSDoc: at-most-once wrapping beats a
  // retryable partial install).
  const installedAt = Date.now();
  const holder = {
    version: 1,
    installedAt,
    host: String(location.hostname || ''),
    read: () => ({ token: state.token, at: state.at, hits: state.hits }),
    hasToken: () => state.token !== null,
  };
  try {
    window.__smAuthTap = holder;
  } catch (installErr) {
    out.errors.push('marker write: ' + (installErr && installErr.message ? String(installErr.message) : 'unknown'));
  }
  out.installedAt = installedAt;

  if (typeof nativeFetch === 'function') {
    const wrappedFetch = function () {
      try {
        if (isSunoApi(urlOf(arguments[0]))) {
          const init = arguments[1];
          if (init && init.headers) record(authFromHeaders(init.headers));
        }
      } catch (inspectErr) {
        // Swallowed on purpose: an inspection failure must not change the
        // request, so there is nothing here worth reporting to the page.
        void inspectErr;
      }
      // Always call through. `window` is passed explicitly because a detached
      // `fetch` call must still satisfy fetch's WindowOrWorkerGlobalScope `this`.
      return nativeFetch.apply(window, arguments);
    };
    try {
      wrappedFetch.__smAuthTapWrapped = true;
      window.fetch = wrappedFetch;
      // Verified, not assumed: assigning to a non-writable `window.fetch` is a
      // SILENT no-op in sloppy mode, and `ok:true` with a fetch hook that is not
      // there would be the same phantom success this operation exists to avoid.
      out.fetchHooked = window.fetch === wrappedFetch;
      if (!out.fetchHooked) {
        out.errors.push('fetch: window.fetch is not writable, so the hook did not take');
      }
    } catch (fetchErr) {
      out.errors.push('fetch: ' + (fetchErr && fetchErr.message ? String(fetchErr.message) : 'unknown'));
    }
  } else {
    out.errors.push('fetch: window.fetch is not a function');
  }

  if (typeof nativeOpen === 'function' && typeof nativeSetHeader === 'function') {
    // WeakMap rather than a property on the XHR instance: it cannot collide
    // with a page key and cannot be enumerated by page code.
    const urlByXhr = new WeakMap();

    const wrappedOpen = function (method, url) {
      try {
        urlByXhr.set(this, typeof url === 'string' ? url : urlOf(url));
      } catch (openErr) {
        void openErr;
      }
      return nativeOpen.apply(this, arguments);
    };
    const wrappedSetHeader = function (name, value) {
      try {
        if (String(name).toLowerCase() === 'authorization' && isSunoApi(urlByXhr.get(this))) {
          record(value);
        }
      } catch (headerErr) {
        void headerErr;
      }
      return nativeSetHeader.apply(this, arguments);
    };
    try {
      wrappedOpen.__smAuthTapWrapped = true;
      XHR.prototype.open = wrappedOpen;
      out.xhrOpenHooked = XHR.prototype.open === wrappedOpen;
    } catch (xhrOpenErr) {
      out.errors.push('xhr.open: ' + (xhrOpenErr && xhrOpenErr.message ? String(xhrOpenErr.message) : 'unknown'));
    }
    try {
      wrappedSetHeader.__smAuthTapWrapped = true;
      XHR.prototype.setRequestHeader = wrappedSetHeader;
      out.xhrHeaderHooked = XHR.prototype.setRequestHeader === wrappedSetHeader;
    } catch (xhrHeaderErr) {
      out.errors.push('xhr.setRequestHeader: ' + (xhrHeaderErr && xhrHeaderErr.message ? String(xhrHeaderErr.message) : 'unknown'));
    }
  } else {
    out.errors.push('xhr: XMLHttpRequest.prototype.open/setRequestHeader not available');
  }

  try {
    out.hasToken = holder.hasToken();
  } catch (hasErr) {
    void hasErr;
  }
  out.ok = out.errors.length === 0;
  return out;
}

/**
 * Read the token the tap captured, if any. The cheapest of the MAIN-world
 * operations — no page dependency beyond the marker, and once the tap is
 * installed it answers immediately.
 *
 * ABSENCE IS NOT FAILURE. A missing tap, or a tap that has not yet seen an
 * authenticated request, returns `ok:true` with `token:null` and a human
 * `reason`. It previously returned `ok:false` + `error`, which the content
 * script surfaced as a red error strip on every page load — so "Suno has not
 * made a request yet" was displayed as a fault. The worker's own ladder is
 * unaffected: `tryOp` keys on `isUsableJwt(result.token)`, not on `result.ok`.
 *
 * @returns {{ok:boolean, token:string|null, source:'tap'|null, ageMs:number|null,
 *   hits:number, reason:string|null, error:string|null}}
 */
function mainWorldAuthRead() {
  try {
    const holder = window.__smAuthTap;
    if (!holder || holder.version !== 1 || typeof holder.read !== 'function') {
      return {
        ok: true,
        token: null,
        source: null,
        ageMs: null,
        hits: 0,
        reason: 'no auth tap is installed in this page',
        error: null,
      };
    }
    const got = holder.read();
    const token = got && typeof got.token === 'string' ? got.token : null;
    // Whole-or-nothing: a short or whitespace-bearing value is not a JWT and is
    // never forwarded.
    if (!token || token.length < 20 || /\s/.test(token)) {
      return {
        ok: true,
        token: null,
        source: null,
        ageMs: null,
        hits: got && Number.isFinite(Number(got.hits)) ? Number(got.hits) : 0,
        reason: got && got.hits
          ? 'auth tap has seen ' + String(got.hits) + ' Authorization header(s) but holds no usable token'
          : 'auth tap has not captured an Authorization header yet',
        error: null,
      };
    }
    const at = Number(got.at);
    return {
      ok: true,
      token,
      source: 'tap',
      ageMs: Number.isFinite(at) && at > 0 ? Math.max(0, Date.now() - at) : null,
      hits: got && Number.isFinite(Number(got.hits)) ? Number(got.hits) : 0,
      reason: null,
      error: null,
    };
  } catch (readErr) {
    return {
      ok: false,
      token: null,
      source: null,
      ageMs: null,
      error: 'auth read failed: ' + (readErr && readErr.message ? String(readErr.message) : 'unknown'),
    };
  }
}

/**
 * Poll for `window.Clerk` up to `timeoutMs`, then call `session.getToken()`.
 *
 * WAITING IS THE FIX FOR THE DOCUMENT-START RACE. The old primary pass injected
 * with `injectImmediately:true`, i.e. at document_start, read `window.Clerk`
 * once, found nothing, and gave up: Clerk had not constructed its instance yet.
 * An un-waiting probe can only ever lose that race, which is why sign-in looked
 * permanently broken while the user was in fact signed in.
 *
 * `timeoutMs` arrives through `executeScript`'s `args`, which is a VALUE
 * channel, not a code channel — it is safe for a caller to influence, and the
 * worker validates and clamps it before it gets here.
 *
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean, token:string|null, waitedMs:number,
 *   hasClerk:boolean, error:string|null}>}
 */
function mainWorldClerkToken(timeoutMs) {
  // Poll cadence. 100ms is far below any budget that matters and keeps a 12s
  // wait at ~120 wakeups. It is a literal here and ONLY here: this function is
  // stringified and evaluated in the page, so there is no worker-side constant to
  // keep in step with it — a duplicate would be a constant nothing reads, and a
  // trap for whoever changes the wrong one.
  const POLL_MS = 100;
  return new Promise((resolve) => {
    const started = Date.now();
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Number(timeoutMs) : 0;
    let poll = null;
    let deadline = null;
    let settled = false;
    // A `getToken()` call that never settles must not hold the whole op open:
    // Clerk's promise can outlive any reasonable wait on a hung network.
    let awaitingToken = false;
    // Whether Clerk was EVER seen. The deadline has to consult this, otherwise a
    // page where Clerk simply never loads is misreported as "Clerk was present
    // but getToken() hung" — a diagnostic that sends the reader down the wrong
    // path entirely.
    let seenClerk = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { if (poll !== null) clearInterval(poll); } catch (clearPollErr) { void clearPollErr; }
      try { if (deadline !== null) clearTimeout(deadline); } catch (clearDeadlineErr) { void clearDeadlineErr; }
      resolve(Object.assign({ waitedMs: Date.now() - started }, payload));
    };

    const giveUp = (sawClerk) => finish(sawClerk
      ? {
        ok: false,
        token: null,
        hasClerk: true,
        error: 'Clerk was present but session.getToken() did not settle within the wait',
      }
      : {
        ok: false,
        token: null,
        hasClerk: false,
        error: 'window.Clerk never appeared within ' + String(limit) + 'ms',
      });

    deadline = setTimeout(() => giveUp(seenClerk), Math.max(50, limit));

    const attempt = () => {
      if (settled || awaitingToken) return;
      let clerk = null;
      try {
        clerk = window.Clerk;
      } catch (accessErr) {
        void accessErr;
      }
      if (clerk && clerk.session && typeof clerk.session.getToken === 'function') {
        seenClerk = true;
        awaitingToken = true;
        let settledHere = false;
        let pending = null;
        try {
          pending = Promise.resolve(clerk.session.getToken());
        } catch (callErr) {
          finish({
            ok: false,
            token: null,
            hasClerk: true,
            error: 'Clerk getToken() threw: ' + (callErr && callErr.message ? String(callErr.message) : 'unknown'),
          });
          return;
        }
        pending.then(
          (token) => {
            if (settledHere) return;
            settledHere = true;
            if (typeof token === 'string' && token.length >= 20 && !/\s/.test(token)) {
              finish({ ok: true, token, hasClerk: true, error: null });
            } else {
              finish({
                ok: false,
                token: null,
                hasClerk: true,
                error: 'Clerk session exists but getToken() returned no usable token — the page is signed out',
              });
            }
          },
          (err) => {
            if (settledHere) return;
            settledHere = true;
            finish({
              ok: false,
              token: null,
              hasClerk: true,
              error: 'Clerk getToken() rejected: ' + (err && err.message ? String(err.message) : 'unknown'),
            });
          }
        );
        return;
      }
      if (Date.now() - started >= limit) giveUp(seenClerk);
    };

    poll = setInterval(attempt, POLL_MS);
    // First attempt immediately, so a Clerk that is ALREADY present does not
    // cost one poll interval.
    attempt();
  });
}

/**
 * Patch the page's `window.MediaSource` so Suno's player falls back to a plain
 * fetch and the resulting `manifest.m3u8` becomes readable.
 *
 * The step order and the per-step guards below are the contract recorded in
 * `content/content.js` §20 and are reproduced exactly, because each one exists
 * to make the page RESTORABLE:
 *
 *   1. `__smHlsActive` short-circuit. A second patch must not clobber
 *      `__smHlsSavedMS` — the restore would then put back an already-overwritten
 *      value and permanently destroy the real `MediaSource`.
 *   2. `__smHlsActive = true`.
 *   3. `__smHlsHadMS = ('MediaSource' in window)`, recorded BEFORE the write: a
 *      page that never had the property must be restored by DELETING it, not by
 *      assigning it.
 *   4. `__smHlsSavedMS = window.MediaSource` in its own try/catch, so a throwing
 *      getter aborts neither the patch nor the flag recording.
 *   5. `window.MediaSource = undefined` in its own try/catch, so a non-writable
 *      property is reported as a patch error instead of throwing the whole
 *      operation away half-applied — the flags are already set, so the restore
 *      still has everything it needs.
 *
 * @returns {{ok:boolean, patched:boolean, alreadyActive:boolean,
 *   hadMediaSource:boolean, error:string|null}}
 */
function mainWorldHlsPatch() {
  const out = {
    ok: false,
    patched: false,
    alreadyActive: false,
    hadMediaSource: false,
    error: null,
  };
  try {
    if (window.__smHlsActive) {
      out.alreadyActive = true;
      out.ok = true;
      return out;
    }
  } catch (guardErr) {
    out.error = 're-entry guard threw: ' + (guardErr && guardErr.message ? String(guardErr.message) : 'unknown');
    return out;
  }

  try { window.__smHlsActive = true; } catch (flagErr) {
    out.error = 'could not set __smHlsActive: ' + (flagErr && flagErr.message ? String(flagErr.message) : 'unknown');
    return out;
  }
  try {
    window.__smHlsHadMS = 'MediaSource' in window;
    out.hadMediaSource = window.__smHlsHadMS === true;
  } catch (hadErr) {
    out.error = 'could not record __smHlsHadMS: ' + (hadErr && hadErr.message ? String(hadErr.message) : 'unknown');
  }
  try { window.__smHlsSavedMS = window.MediaSource; } catch (saveErr) {
    out.error = (out.error ? out.error + '; ' : '')
      + 'could not save MediaSource: ' + (saveErr && saveErr.message ? String(saveErr.message) : 'unknown');
  }
  try {
    window.MediaSource = undefined;
    // VERIFY the write landed. Assignment to a non-writable property is a
    // SILENT no-op in sloppy mode, so trusting it would reproduce the exact
    // "reported success but did nothing" failure this whole operation exists to
    // eliminate — the same lie the CSP-blocked inline script used to tell.
    if (window.MediaSource !== undefined) {
      out.error = 'MediaSource is not writable; the page still exposes it, so the patch did not land';
    } else {
      out.patched = true;
    }
  } catch (patchErr) {
    out.error = (out.error ? out.error + '; ' : '')
      + 'MediaSource is not writable: ' + (patchErr && patchErr.message ? String(patchErr.message) : 'unknown');
  }
  out.ok = out.patched;
  return out;
}

/**
 * Undo `mainWorldHlsPatch`. Safe to call any number of times, including after
 * zero, one or two patches — the flags are the source of truth and are always
 * cleared, so a failed patch is always undoable and a repeated restore is a
 * no-op.
 *
 * The both-branches-in-one-try/catch below is deliberate: a failure to restore
 * must still REACH the flag-clearing step, or the page is left both broken and
 * un-restorable by the next attempt.
 *
 * @returns {{ok:boolean, restored:boolean, note:string, error:string|null}}
 */
function mainWorldHlsRestore() {
  const out = { ok: false, restored: false, note: '', error: null };
  let active = false;
  try {
    active = window.__smHlsActive === true;
  } catch (readErr) {
    out.note = 'notActive';
    out.error = 'could not read __smHlsActive: ' + (readErr && readErr.message ? String(readErr.message) : 'unknown');
    return out;
  }
  if (!active) {
    // Reported as `notActive` rather than success: a restore with nothing to
    // undo must not claim credit over a patch that never landed.
    out.note = 'notActive';
    out.ok = true;
    return out;
  }

  let hadMS = false;
  try { hadMS = window.__smHlsHadMS === true; } catch (hadErr) { void hadErr; }

  try {
    if (hadMS) {
      window.MediaSource = window.__smHlsSavedMS;
      out.note = 'restored';
      out.restored = true;
    } else {
      // The page had NO MediaSource before the patch, so the patch CREATED the
      // property (as `undefined`). Restoring means deleting it again — not
      // leaving a property the page never had. The re-check below catches a
      // delete that silently failed.
      delete window.MediaSource;
      if ('MediaSource' in window && window.MediaSource !== undefined) {
        window.MediaSource = undefined;
        out.note = 'deleteFailed';
        out.error = 'delete window.MediaSource did not take effect; property left as undefined';
      } else {
        out.note = 'deleted';
        out.restored = true;
      }
    }
  } catch (restoreErr) {
    out.error = 'restore step failed: ' + (restoreErr && restoreErr.message ? String(restoreErr.message) : 'unknown');
  }

  try {
    delete window.__smHlsActive;
  } catch (flagErr) {
    void flagErr;
    try { window.__smHlsActive = false; } catch (flagFallbackErr) { void flagFallbackErr; }
  }
  try { delete window.__smHlsHadMS; } catch (clearHadErr) { void clearHadErr; }
  try { delete window.__smHlsSavedMS; } catch (clearSavedErr) { void clearSavedErr; }

  out.ok = out.error === null || out.note === 'deleteFailed';
  return out;
}

/**
 * The op -> function map. EXACT keys, looked up with
 * `Object.prototype.hasOwnProperty` (never inherited lookup) so `constructor`,
 * `toString` and friends cannot resolve to something.
 *
 * `Object.freeze` prevents the map being mutated by a later route; it does NOT
 * seal the prototype chain, which is exactly why the exact-key guard exists.
 *
 * @type {Readonly<Record<string,Function>>}
 */
const MAIN_WORLD_OPS = Object.freeze({
  probe: mainWorldProbe,
  'auth-tap': mainWorldAuthTap,
  'auth-read': mainWorldAuthRead,
  'clerk-token': mainWorldClerkToken,
  'hls-patch': mainWorldHlsPatch,
  'hls-restore': mainWorldHlsRestore,
});

/** Every op this build can run in a page, for the diagnostics reply. */
const MAIN_WORLD_OP_NAMES = Object.freeze(Object.keys(MAIN_WORLD_OPS));

/**
 * Validate and clamp a caller-supplied `clerk-token` timeout.
 *
 * `args` is a VALUE channel, so this cannot inject code — but it is still
 * caller-influenced, and an object, a string or a NaN must not reach the page.
 * Coerce, then reject anything not finite, then clamp into
 * [CLERK_WAIT_MIN_MS, CLERK_WAIT_MAX_MS].
 *
 * @param {unknown} value
 * @returns {number}
 */
function validateClerkTimeout(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return CLERK_WAIT_DEFAULT_MS;
  return clampNumber(num, CLERK_WAIT_MIN_MS, CLERK_WAIT_MAX_MS, CLERK_WAIT_DEFAULT_MS);
}

/**
 * Run one MAIN-world op in a specific tab. This is the worker's INTERNAL entry
 * point — `runMainWorldOp` is the route wrapper, and `mintAuthToken` calls this
 * directly because it must drive tabs other than the caller's own.
 *
 * @param {string} op exact key into `MAIN_WORLD_OPS`
 * @param {number} tabId
 * @param {object} [payload] caller payload; only `timeoutMs` is ever read
 * @returns {Promise<{ok:true, op:string, result:object}|{ok:false, code:string, error:string}>}
 */
async function injectMainWorldOp(op, tabId, payload) {
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(MAIN_WORLD_OPS, op)) {
    return { ok: false, code: 'bad_op', error: 'unknown MAIN-world op: ' + String(op).slice(0, 40) };
  }
  if (!Number.isFinite(tabId)) {
    return { ok: false, code: 'no_tab', error: 'no tab id to run a MAIN-world op in' };
  }

  const args = [];
  if (op === 'clerk-token') args.push(validateClerkTimeout(payload && payload.timeoutMs));

  let results = null;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      // Immediate, because these ops are called on demand from a warm tab, not
      // as document-start hooks. `clerk-token` supplies its own document-start
      // tolerance by polling INSIDE the page.
      injectImmediately: true,
      func: MAIN_WORLD_OPS[op],
      args,
    });
  } catch (injectErr) {
    // `describeError().message`, not the whole object: the reply's `error` is
    // rendered as text by content.js (`String(msg)`), and "[object Object]" is
    // not a diagnostic.
    return { ok: false, code: 'inject_failed', error: describeError(injectErr).message };
  }

  if (!Array.isArray(results) || results.length === 0) {
    return { ok: false, code: 'inject_failed', error: 'executeScript returned no results' };
  }
  const first = results[0];
  const result = first && typeof first === 'object' ? first.result : undefined;
  if (!result || typeof result !== 'object') {
    return { ok: false, code: 'inject_failed', error: 'executeScript reported success but returned no result object' };
  }
  return { ok: true, op, result };
}

/**
 * The `RUN_MAIN_WORLD` route body.
 *
 * WHY THIS ROUTE EXISTS: inline script injection from a content script is
 * CSP-blocked on suno.com (see §5b), so the page-side work — the auth tap, the
 * Clerk read, the MediaSource patch — has to be driven from here.
 *
 * The op is resolved by EXACT key from `MAIN_WORLD_OPS`. There is no `eval`,
 * no `new Function`, and no string-to-function path anywhere in this build: the
 * page is never handed code as text, it is handed one of six functions this
 * file already contains.
 *
 * The tab is the CALLER'S OWN tab (`sender.tab`), unlike `mintAuthToken`, which
 * has to guess. An extension page has no `sender.tab` and is therefore refused
 * with `no_tab` — correct, because this route exists for content scripts and
 * the worker drives its own tabs through `injectMainWorldOp` instead.
 *
 * @param {object} payload `{op: string, timeoutMs?: number}`
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<{ok:true, op:string, result:object}|{ok:false, code:string, error:string}>}
 */
async function runMainWorldOp(payload, sender) {
  const op = payload && typeof payload.op === 'string' ? payload.op : '';

  const tabId = sender && sender.tab && Number.isFinite(sender.tab.id) ? sender.tab.id : null;
  if (tabId === null) {
    return {
      ok: false,
      code: 'no_tab',
      error: 'the caller has no tab; RUN_MAIN_WORLD is a content-script route',
    };
  }

  // Defence in depth: `validateSender` already gated this message, but this is
  // the one route that injects into a page, so the sender URL is re-checked
  // here rather than assumed.
  const senderUrl = sender && typeof sender.url === 'string' ? sender.url : '';
  let trusted = false;
  for (const pattern of TRUSTED_PAGE_PATTERNS) {
    if (pattern.test(senderUrl)) {
      trusted = true;
      break;
    }
  }
  if (!trusted) {
    return { ok: false, code: 'forbidden', error: 'sender url is not allowlisted for page injection' };
  }

  return injectMainWorldOp(op, tabId, payload);
}

/**
 * Structured record of the last failed mint, surfaced by `GET_DIAGNOSTICS` and
 * `GET_BOOT` so the next "not signed in" report is answerable without guesswork.
 *
 * It records WHICH op was reached and what each op returned — deliberately not
 * the token material any op may have seen. Everything in here is a description
 * of the search, never a credential.
 *
 * @type {{at:number, reason:string, tabsFound:number, tabsTried:number,
 *   tabIds:number[], usedTabId:number|null, tapInstalled:boolean,
 *   reachedOp:string|null, steps:Array<{op:string, tabId:number|null,
 *   ok:boolean, code:string|null, error:string|null}>}|null}
 */
let lastAuthFailure = null;

/**
 * Drop the cached "minting in progress" promise. Called from a `finally`, so a
 * FAILURE can never be cached in a way that blocks later retries: the previous
 * code cleared the field inside `.then` and inside `.catch`, which is correct
 * only while both exist and would silently wedge every future mint if either
 * were ever removed.
 *
 * @returns {void}
 */
function clearTokenMintInFlight() {
  tokenMintInFlight = null;
}

/* ==========================================================================
 * 6. MESSAGING
 *
 * MOVED to `background/parts/06-messaging.js`, loaded by `importScripts` at
 * the top of this file. Extracted third, and chosen for that position:
 * `broadcast` has 19 call sites across the worker, so it exercises the part
 * mechanism at full fan-out instead of in one quiet corner. It carries no
 * completeness verdict — pushes are progress, and the verdict belongs to
 * `syncContractView` in section 13.
 * ======================================================================== */

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
/** @type {number|null} watchdog timer for the current crawl. */
let syncWatchdogTimer = null;
/** True when the watchdog (not the user) aborted the current run. */
let syncWatchdogFired = false;
/**
 * Clear the sync watchdog timer if one is armed. Never throws.
 */
function clearWatchdog() {
  if (syncWatchdogTimer !== null) {
    clearTimeout(syncWatchdogTimer);
    syncWatchdogTimer = null;
  }
  syncWatchdogFired = false;
}
/**
 * True once a cancel has been signalled for the CURRENT run.
 *
 * Aborting is cooperative, so a second press is a normal thing to do — the user
 * cannot see whether the first one landed. Without this the second press
 * repeated the first press's log line verbatim, which read as the button being
 * broken rather than as "already stopping".
 */
let syncCancelRequested = false;

/**
 * When the run record was last heartbeated, so the per-page heartbeat in
 * `afterPage` can be throttled.
 *
 * This is the ONLY module-scope binding the eviction fix adds to the sync
 * section, and it is a throttle, not a fact: losing it on eviction costs at most
 * one redundant write. Every decision about whether a run is in flight is made
 * from the record in `chrome.storage.session` (§13c), which is durable.
 * @type {number}
 */
let lastSyncRunBeat = 0;

/**
 * Start the crawl. `runSync` is fire-and-forget; this returns immediately.
 *
 * INVARIANTS THE CRAWL KEEPS (each one is a bug this build fixed):
 *
 * - EVERY project from `/api/project/me` is walked, `default` included. A
 *   `workspace:'default'` walk alone reached 3,444 of ~5,500 clips on the recon
 *   account and reported success, because the clips in every other project were
 *   never requested.
 * - `POST /api/feed/v3` pages by CURSOR, and the cursor is written to `syncState`
 *   after EVERY page, so an evicted worker resumes instead of restarting. It
 *   resumes at WORKSPACE granularity: `iterateFeed` accepts no `startCursor`
 *   (it accepts and explicitly ignores `startPage`), so completed workspaces are
 *   skipped entirely and the workspace that was in flight is re-walked from
 *   `cursor:null`. Writes are additive and idempotent by clip id, so that is
 *   safe, just not free.
 * - Each page is committed with `clips.putMany` (ONE transaction per page, never
 *   one per clip), and `project/feed` is walked ONCE per sync rather than once
 *   per hydrating batch.
 * - `clips.clear()` is NEVER called. A forced rebuild buffers and then uses
 *   `clips.bulkReplace`, which is a single atomic transaction, and only when the
 *   crawl COMPLETED — replacing a library with a truncated one would delete the
 *   clips the crawl never reached. An abort leaves the previous library intact.
 * - `maxPages` is honoured and reported. A user with 3,000 clips must not
 *   silently lose 2,000 to a page cap, so truncation is surfaced everywhere.
 *
 * @param {{force?:boolean, dislikedMode?:string, maxPages?:number}} options
 * @returns {Promise<{ok:boolean, batchId?:string, ...}>} the immediate reply
 */
async function startSync(options) {
  await loadSettings();
  if (syncController) {
    log('warn', 'sync.start_rejected_running', {});
    return { ok: false, error: 'a sync is already running', code: 'sync_running' };
  }

  const settings = settingsCache;
  const mode = ['include', 'exclude', 'both'].indexOf(options.dislikedMode) >= 0
    ? String(options.dislikedMode)
    : settings.dislikedMode;
  const requestedMaxPages = Number(options.maxPages);
  const maxPages = Number.isFinite(requestedMaxPages) && requestedMaxPages > 0
    ? Math.floor(requestedMaxPages)
    : settings.syncMaxPages;
  const feedPageLimit = resolveFeedPageLimit(settings.feedPageLimit, DEFAULT_SETTINGS.feedPageLimit);
  const total = await DB.clips.count();

  let reply;
  try {
    syncController = new AbortController();
    syncCancelRequested = false;
    const watchdogStart = Date.now();
    syncWatchdogTimer = setTimeout(() => {
      const elapsedMs = Date.now() - watchdogStart;
      log('error', 'sync.watchdog_fired', { elapsedMs });
      syncWatchdogFired = true;
      if (syncController && !syncController.signal.aborted) {
        syncController.abort();
      }
    }, SYNC_WALL_CLOCK_MS);

    /* THE RUN RECORD, WRITTEN BEFORE THE CRAWL IS ANNOUNCED. §13c. The order is
     * the point: `syncController` is created on the line above and dies with the
     * worker, so if this record is not on disk before the first `await` in
     * `runSync`, there is a window in which a wake can see a cursor claiming a
     * run that no record corroborates and no controller owns — which is exactly
     * the disagreement this record exists to prevent. */
    await writeSyncRun({
      running: true,
      startedAt: Date.now(),
      cancelRequested: false,
      cancelRequestedAt: null,
      phase: 'starting',
      heartbeatAt: Date.now(),
    });
    /* The per-page heartbeat throttle is reset with the record, so a run that
     * starts seconds after the last one cannot inherit a beat new enough to
     * suppress its own first heartbeats. */
    lastSyncRunBeat = Date.now();

    reply = {
      ok: true,
      force: options.force === true,
      dislikedMode: mode,
      maxPages,
      feedPageLimit,
      total,
      state: 'running',
    };

    log('info', 'sync.started', {
      force: options.force === true,
      mode,
      maxPages,
      feedPageLimit,
      total,
    });

    void broadcast({
      type: 'SYNC_STARTED',
      state: 'running',
      running: true,
      cancelRequested: false,
      force: options.force === true,
      dislikedMode: mode,
      maxPages,
      feedPageLimit,
      total,
      heartbeatAt: Date.now(),
    });

    void runSync({
      force: options.force === true,
      mode,
      maxPages,
      feedPageLimit,
      signal: syncController.signal,
    }).catch((err) => {
      const info = describeError(err);
      log('error', 'sync.threw', { error: info });
      syncController = null;
      syncCancelRequested = false;
      clearWatchdog();
      void clearSyncRun();
      void broadcast({
        type: 'SYNC_ERROR',
        ...syncContractView(null, {
          completed: false,
          stopReason: isAbortLike(err) ? 'aborted' : 'page_failed',
          error: info.message,
          state: isAbortLike(err) ? 'cancelled' : 'error',
          expectedTotal: 0,
          examined: 0,
          uniqueSeen: 0,
          missing: 0,
          oracleApplied: false,
          advisory: 'the run failed before it could measure anything',
          workspaces: [],
          pagesDone: 0,
        }),
        projectList: null,
        projectFeed: null,
        dislikedCount: null,
        dislikedApproximate: false,
      });
    });
  } catch (err) {
    const info = describeError(err);
    log('error', 'sync.start_failed', { error: info });
    syncController = null;
    syncCancelRequested = false;
    clearWatchdog();
    void clearSyncRun();
    void broadcast({
      type: 'SYNC_ERROR',
      ...syncContractView(null, {
        completed: false,
        stopReason: 'page_failed',
        error: info.message,
        state: 'error',
        expectedTotal: 0,
        examined: 0,
        uniqueSeen: 0,
        missing: 0,
        oracleApplied: false,
        advisory: 'the run failed before it could measure anything',
        workspaces: [],
        pagesDone: 0,
      }),
      projectList: null,
      projectFeed: null,
      dislikedCount: null,
      dislikedApproximate: false,
    });
    return { ok: false, error: info.message, code: 'sync_start_failed' };
  }

  return reply;
}

/**
 * EVERY project on the account, by paging `/api/project/me`.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `fetchProjects`: `fetchProjects()` requests
 * no query at all, so the server answers with page 1 — 20 projects. That is the
 * entire list only on an account with <= 20 projects. On the recon account it
 * was 20 of 25, and the five it dropped were five whole libraries. The route is
 * documented as `{num_total_results, current_page, projects:[…]}`, and
 * `num_total_results` is the PROJECT COUNT, which is exactly the completeness
 * oracle a multi-workspace crawl needs. So this walks it until the advertised
 * count is reached, and reports `complete:false` when it cannot prove it reached
 * the end. A partial project list must never be reported as a finished one: the
 * run would then claim `completed:true` over a library it never looked at.
 *
 * @param {{signal?:AbortSignal, maxPages?:number}} opts
 * @returns {Promise<{projects:Array<object>, complete:boolean, pagesDone:number,
 *   expectedProjects:number|null, stopReason:string, error:string|null}>}
 */
async function fetchAllProjects(opts = {}) {
  const signal = opts.signal || null;
  const maxPages = Number.isFinite(opts.maxPages) && opts.maxPages > 0
    ? Math.floor(opts.maxPages)
    : PROJECT_LIST_MAX_PAGES;
  const projects = [];
  const seenIds = new Set();
  const seenPages = new Set();
  let page = 1;
  let pagesDone = 0;
  let expectedProjects = null;
  let complete = true;
  let stopReason = 'complete';
  let error = null;

  while (pagesDone < maxPages) {
    if (signal && signal.aborted) {
      complete = false;
      stopReason = 'aborted';
      error = 'the project list walk was cancelled';
      break;
    }
    if (seenPages.has(page)) {
      complete = false;
      stopReason = 'page_failed';
      error = `/api/project/me repeated page ${page}: pagination is stuck`;
      break;
    }
    seenPages.add(page);

    /* The query is the one the 1.0.0 build shipped (legacy-1.0.0/extension/lib/
     * api.js:247). `page` is the only field the route's own envelope documents
     * as pagination; `sort`, `show_trashed` and `exclude_shared` are carried
     * forward verbatim rather than invented here. */
    const envelope = await SunoAPIClient.request(SunoAPI.ENDPOINTS.projectMe, {
      method: 'GET',
      query: { page, sort: 'created_at', show_trashed: 'false', exclude_shared: 'false' },
      signal,
    });
    if (!envelope.ok) {
      const aborted = isAbortLike(envelope.error) || !!(signal && signal.aborted);
      complete = false;
      stopReason = aborted ? 'aborted' : 'page_failed';
      error = aborted
        ? 'the project list walk was cancelled'
        : `/api/project/me page ${page} failed: HTTP ${envelope.status || 0}`;
      break;
    }

    const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : null;
    const batch = data && Array.isArray(data.projects) ? data.projects : null;
    if (!batch) {
      complete = false;
      stopReason = 'page_failed';
      error = `/api/project/me page ${page} carried no projects array`;
      break;
    }
    if (data.current_page !== undefined && data.current_page !== null
      && Number(data.current_page) !== page) {
      complete = false;
      stopReason = 'page_failed';
      error = `/api/project/me page mismatch: asked for ${page}, received ${data.current_page}`;
      break;
    }
    pagesDone += 1;
    for (const project of batch) {
      const id = project && project.id !== undefined && project.id !== null ? String(project.id) : '';
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      projects.push({
        id,
        name: typeof project.name === 'string' ? project.name : '',
        // THIS project's own oracle. `expectedClipTotal` sums them for the run,
        // and each walk is compared against its own project so a short walk is
        // never excused by a generous sibling.
        clipCount: typeof project.clip_count === 'number' ? project.clip_count : null,
      });
    }
    /* Up to 100 pages on a large account, and it is the FIRST thing a sync does —
     * so without this the opening of every crawl is a silent gap that reads as a
     * hung extension. Same reasoning as the `project/feed` walk's `onProgress`. */
    if (typeof onProgress === 'function') {
      safeCallback(onProgress, {
        phase: 'planning',
        pagesDone,
        discovered: projects.length,
        expectedProjects,
      });
    }

    const advertised = Number(data.num_total_results);
    if (Number.isFinite(advertised) && advertised >= 0) {
      if (expectedProjects !== null && advertised !== expectedProjects) {
        // The project list changed under the walk, so the set we hold is neither
        // the old one nor the new one and cannot be called complete.
        complete = false;
        stopReason = 'page_failed';
        error = `/api/project/me project count changed mid-walk (${expectedProjects} -> ${advertised})`;
        break;
      }
      expectedProjects = Math.floor(advertised);
    }
    if (expectedProjects !== null && projects.length >= expectedProjects) {
      stopReason = 'complete';
      break;
    }
    if (expectedProjects === null && batch.length < PROJECT_LIST_PAGE_HINT) {
      // No advertised total and a short page. Stopping here is the only option,
      // but it is NOT proof that the list ended, so it is reported incomplete.
      complete = false;
      stopReason = 'page_failed';
      error = '/api/project/me advertised no num_total_results, so the project list cannot be proven complete';
      break;
    }
    page += 1;
  }

  if (complete && pagesDone >= maxPages && (expectedProjects === null || projects.length < expectedProjects)) {
    complete = false;
    stopReason = 'max_pages';
    error = `the project list walk hit its ${maxPages}-page cap with ${projects.length} of `
      + `${expectedProjects === null ? 'an unknown number of' : expectedProjects} projects`;
  }

  return { projects, complete, pagesDone, expectedProjects, stopReason, error };
}

/**
 * The workspaces the crawl will walk, in a stable order, always including
 * `default`.
 *
 * WHY `default` IS FORCED IN: `/api/project/me` always carries it on a real
 * account, but a list that arrives without it (trashed projects excluded by a
 * future default, a partial page) must not lose the unassigned clips that live
 * there. It is APPENDED to the discovered order rather than substituted, so a
 * genuinely empty list still produces exactly one walk and a normal list keeps
 * the server's own ordering.
 *
 * @param {Array<{id:string,name:string,clipCount:number|null}>} projects
 * @returns {Array<{id:string,name:string,clipCount:number|null}>}
 */
function buildWorkspacePlan(projects) {
  const plan = [];
  const seen = new Set();
  for (const project of Array.isArray(projects) ? projects : []) {
    const id = project && project.id !== undefined && project.id !== null ? String(project.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    plan.push({ id, name: (project.name || id), clipCount: project.clipCount });
  }
  if (!seen.has('default')) {
    plan.push({ id: 'default', name: 'My Workspace', clipCount: null });
  }
  return plan;
}

/**
 * One workspace's outcome, in the exact shape the UIs read.
 *
 * `missing` starts as `null` — "not measured" — and only becomes a number where
 * something actually compared this walk's total against a count. A row with no
 * comparable count at all (no `clip_count`, or a walk of a different row set)
 * stays `null` with `oracleApplied:false` and an `advisory` saying why, because
 * `0` would be a claim — "I checked and found nothing missing" — that nothing
 * checked.
 *
 * WHERE THIS USED TO DIVERGE FROM THE RUN, AND WHAT FIXED IT: `missing` was a
 * number ONLY when `oracleApplied` was true, which on the default filtered
 * settings is never — so a workspace that indexed 10-20% of its library reported
 * `completed:true` and no shortfall at all. The comparison is now made for every
 * workspace that HAS a comparable count, and `oracleApplied` answers the narrower
 * and different question it always meant to: "is the count apples-to-apples with
 * this filtered walk?". `shortfallLikelyFilters` carries the size of the gap so a
 * reader can tell a trashed/disliked accounting difference from a feed that
 * stopped early without having to re-derive either.
 *
 * @param {{projectId:string,name:string,expected:number|null,disliked:string,
 *   oracleApplied:boolean,advisory:string|null}} init
 * @returns {object}
 */
function newWorkspaceOutcome(init) {
  const oracleApplied = init.oracleApplied === true;
  const hasCount = Number.isFinite(init.expected) && init.expected >= 0;
  return {
    projectId: init.projectId,
    name: init.name,
    completed: false,
    pagesDone: 0,
    totalSeen: 0,
    expected: hasCount ? init.expected : null,
    missing: hasCount ? init.expected : null,
    oracleApplied,
    advisory: oracleApplied ? null : (init.advisory || null),
    stopReason: null,
    /* WHAT THE WALK ITSELF SAID, kept separately from `stopReason`.
     *
     * WHY TWO FIELDS: the shortfall block below replaces `stopReason` with
     * `'expected_total'`, and that replacement destroys the one fact the run-level
     * verdict needs in order to tell truncation from an ordinary shortfall —
     * whether this walk ended on the feed's OWN end-of-feed signal (a cursor field
     * that was present and null) or on a failure (a page error, a stuck cursor, a
     * page cap). Reading it back off `stopReason` after the overwrite reports
     * every short workspace as a failure, and `suspected_truncation` can then never
     * fire — which is the verdict that matters most here.
     *
     * So: `walkStopReason` is the CLIENT's summary, verbatim, and is never
     * rewritten. `stopReason` is the row's final verdict. */
    walkStopReason: null,
    error: null,
    disliked: init.disliked,
    /* True only when this row is short AND the gap is small enough to be the
     * filter accounting (see `SHORTFALL_FILTER_CAUSE_SHARE`). Filled in by
     * `crawlWorkspace` once the walk's total is known. */
    shortfallLikelyFilters: false,
    /* The full-page signal, carried off the walk's summary. `lastPageFull` means
     * "the server filled the page we asked for and then said there was no more",
     * which is visible evidence of truncation and is published rather than acted
     * upon. */
    pagesFull: 0,
    lastPageSize: 0,
    lastPageFull: false,
  };
}

/**
 * Walk ONE workspace to its end, committing and persisting after every page.
 *
 * Never throws. One failing workspace must not abort the other 19: that is the
 * difference between "4,400 clips and one broken project" and "nothing", and the
 * per-workspace row is what lets the summary NAME the broken one.
 *
 * @param {object} params
 * @param {{id:string,name:string,clipCount:number|null}} params.project
 * @param {string} params.disliked the server-side tri-state filter
 * @param {number} params.maxPages per-workspace page cap
 * @param {number} params.limit page size, already resolved from
 *   `settings.feedPageLimit` by the caller
 * @param {boolean} params.includeTrashed
 * @param {AbortSignal} params.signal
 * @param {Set<string>} params.uniqueSink ids to accumulate, mutated here. The
 *        CALLER chooses the set, which is how phase 2 keeps its own tallies out
 *        of the run's: its ids land in the disliked set, not in `totalSeen`.
 * @param {number|null} params.expected the count that DESCRIBES THIS WALK, or
 *        null when none does. Published on the row even when the comparison
 *        cannot be FATAL (a filtered walk still benefits from "this project says
 *        275, the walk saw 274"); null for the `disliked:'only'` walk, whose rows
 *        are a different set and whose `clip_count` describes something it never
 *        asks for. A row WITH a count is always compared against it — see the
 *        shortfall block at the end of this function.
 * @param {boolean} [params.oracleFatal] may this walk's shortfall be treated as
 *        PROOF that the library is short, i.e. may it be worded as a checked
 *        shortfall rather than a lower bound? TRUE only for a genuinely
 *        unfiltered walk against a project that reported a `clip_count`. FALSE
 *        for (a) the `disliked:'only'` walk, which by construction returns far
 *        fewer rows than the project holds, (b) any walk whose server-side
 *        filters hide rows that a project row count probably still includes, and
 *        (c) a project whose `clipCount` is `null`, which has no oracle at all.
 *        It no longer decides WHETHER a shortfall fails the walk — only how the
 *        verdict is worded — and that is the whole point of the change.
 * @param {string} [params.oracleAdvisory] why the oracle is not fatal here

 * @param {(outcome:object, page:{projectId:string,page:number,clips:object[]})=>Promise<void>} params.onPage
 * @param {(summary:object, projectId:string)=>void} [params.onSummary]
 * @returns {Promise<object>} the workspace outcome row
 */
async function crawlWorkspace(params) {
  const { project, disliked, maxPages, limit, includeTrashed, signal } = params;
  const uniqueSink = params.uniqueSink instanceof Set ? params.uniqueSink : new Set();
  log('info', 'sync.workspace_start', { projectId: project.id, name: project.name });
  /* A WORKSPACE SHORT OF ITS OWN COUNT IS INCOMPLETE, AND `oracleApplied` ALONE
   * IS NOT WHAT DECIDES THAT.
   *
   * `project.clip_count` is a PROJECT ROW COUNT and the walk is a FILTERED
   * request: on the default settings the walk sends `filters.trashed:'False'` and
   * `filters.disliked:'False'`, so it cannot return trashed or disliked rows, and
   * nothing in the wire contract says `clip_count` omits them. That mismatch is
   * real, and it is why the count is handed to `iterateFeed` as `expectedTotal`
   * only when the two are comparable — otherwise the CLIENT would flip itself to
   * `completed:false / 'expected_total'` permanently, by exactly the number of
   * trashed + disliked rows, which is the "looks broken forever" failure this crawl
   * was rebuilt to fix.
   *
   * But "the comparison is not apples-to-apples" is not the same statement as
   * "a shortfall must be ignored", and collapsing the two is how a crawl that
   * indexed 10-20% of the library came to report `completed:true`. So the count is
   * NOT handed to the client when it is only a lower bound — and OUR row still
   * compares against it, at the end of this function, where the wording can be
   * chosen per row. `oracleApplied` is published per row either way, so a reader
   * can tell "checked, apples-to-apples" from "checked, lower bound". */
  const hasExpectedCount = Number.isFinite(params.expected) && params.expected >= 0;
  const oracleFatal = params.oracleFatal === true && hasExpectedCount;
  const expected = Number.isFinite(params.expected) && params.expected >= 0
    ? Math.floor(params.expected)
    : null;
  const outcome = newWorkspaceOutcome({
    projectId: project.id,
    name: project.name,
    // The count is PUBLISHED whenever one describes this walk, even when it
    // cannot be enforced: "this project says 275, the walk saw 274" is worth
    // showing. `missing` is the part that must not be invented — see below.
    expected,
    disliked,
    oracleApplied: oracleFatal,
    /* THE CALLER OWNS THE ROW SENTENCE: it is the only party that knows WHY this
     * walk was not checked (a filtered pass, a disjoint `'only'` walk, a plan
     * entry with no count), and the fallback covers the case where it said
     * nothing. `oracleFatal` rows get no sentence — they were checked. */
    advisory: params.oracleAdvisory || (oracleFatal ? null
      : `workspace ${project.id} has no comparable clip_count for this walk`),
  });
  const onPage = typeof params.onPage === 'function' ? params.onPage : async () => {};
  const onSummary = typeof params.onSummary === 'function' ? params.onSummary : () => {};

  /* ROWS THIS WALK HAS ACCEPTED, counted here as well as in the client, and
   * whether a client summary ever arrived.
   *
   * `outcome.totalSeen` is normally OVERWRITTEN by the summary batch
   * (`seenIds.size`, de-duplicated within the walk) and that figure is the one
   * `crawlInto` reconciles `examined` against. An ABORTED walk never reaches that
   * summary: the loop below breaks straight after `onPage`, abandoning the
   * generator before it yields one, so the only carrier of `totalSeen` was never
   * read. The row then reported `totalSeen: 0` beside the pages it had just
   * committed, and `crawlInto` reconciled `examined` against that zero — throwing
   * away rows already in the database and reporting a run that examined fewer clips
   * than it had written. `acceptedRows` is the floor for that case: it counts the
   * same rows `afterPage` already added to `examined`, so reconciliation can never
   * land below the rows actually persisted. A summary still wins where there is
   * one, which leaves the normal path bit-for-bit unchanged. */
  let acceptedRows = 0;
  let summarySeen = false;

  try {
    const iterator = SunoAPIClient.iterateFeed({
      /* WHY SCOPE IS `workspace` AND NOT `all`, PER PROJECT: `scope:'all'` drops
       * the workspace filter and IS the documented way to read the whole library
       * in one walk — but it cannot be compared against a per-project oracle, and
       * it is not what the web app does when a project is open. This crawl
       * enumerates the projects itself (which is what makes the clips outside
       * `default` reachable) and then walks each one exactly as the app would. */
      scope: 'workspace',
      workspaceId: project.id,
      disliked,
      includeTrashed: includeTrashed === true,
      limit,
      maxPages,
      /* THIS project's `clip_count`, never the account-wide sum — and only when
       * the two measure the same set (see `oracleFatal`). Passing a count the
       * walk cannot possibly meet is precisely how a filtered walk comes to
       * report itself incomplete forever. It is the SAME number the row publishes
       * as `expected`, so the client's verdict and ours are about one figure. */
      expectedTotal: oracleFatal ? expected : null,
      signal,
    });
    /* `startPage` IS DELIBERATELY NOT PASSED, and there is no pass-through to
     * remove on this side: this call is the ONLY `iterateFeed` call in the build,
     * `hydrate()` has never accepted the option, and no route forwards it. The
     * option died with the v2 page walk — `/api/feed/v3` pages by cursor, so
     * "resume at page N" is not expressible and the client would only ignore it
     * (see `SunoAPI#iterateFeed` in lib/api.js, which keeps a warn-and-ignore
     * guard so an OLDER caller that still sends one hears about it once instead
     * of silently resuming from the wrong place). Resume here is the persisted
     * cursor and the workspace plan, both written above `crawlInto`'s
     * reconciliation. */
    /* ROWS THIS WALK HAS ACCEPTED, counted here as well as in the client.
     *
     * `outcome.totalSeen` is normally OVERWRITTEN by the client's own summary
     * (`seenIds.size`, de-duplicated within the walk) and that figure is the one
     * `crawlInto` reconciles `examined` against. An ABORTED walk never reaches that
     * summary: the loop below breaks straight after `onPage`, abandoning the
     * generator before it yields one, so the only carrier of `totalSeen` was never
     * read. The row then reported `totalSeen: 0` beside the pages it had just
     * committed, and `crawlInto` reconciled `examined` against that zero — throwing
     * away 100 rows already in the database and reporting a run that examined fewer
     * clips than it wrote. This counter is the floor for that case: it is the same
     * rows `afterPage` already added to `examined`, so reconciliation can never
     * land below the rows actually persisted. A summary still wins where there is
     * one, which leaves the normal path bit-for-bit unchanged. */
    for await (const batch of iterator) {
      /* The summary is read FIRST, including when the signal has fired: it is
       * the only thing that carries `totalSeen` and the authoritative
       * `completed`, and dropping it on cancel would report "no clips" for a
       * workspace that indexed thousands. */
      if (batch.type === 'summary') {
        outcome.completed = batch.completed === true;
        outcome.pagesDone = Number.isFinite(batch.pagesDone) ? batch.pagesDone : outcome.pagesDone;
        outcome.totalSeen = Number.isFinite(batch.totalSeen) ? batch.totalSeen : outcome.totalSeen;
        outcome.stopReason = batch.stopReason || outcome.stopReason || 'complete';
        outcome.walkStopReason = outcome.stopReason;
        if (batch.error) outcome.error = describeError(batch.error).message;
        /* The full-page signal and the cursor spelling, straight off the client's
         * own summary. `cursorAlias` is the direct answer to "is the field called
         * what the bundle says?" — a name other than `next_cursor` means the
         * bundle was wrong, and a null here with `stopReason:'cursor_missing'`
         * means the parser found nothing at all. */
        outcome.cursorAlias = batch.cursorAlias === undefined ? null : batch.cursorAlias;
        outcome.pagesFull = Number.isFinite(batch.pagesFull) ? batch.pagesFull : outcome.pagesFull;
        outcome.lastPageSize = Number.isFinite(batch.lastPageSize) ? batch.lastPageSize : outcome.lastPageSize;
        outcome.lastPageFull = batch.lastPageFull === true;
        /* "The final page had N of 100 clips", carried onto the row so a surface
         * can say that instead of "we do not know". NEVER A VERDICT: the client
         * does not read it, this file does not read it, and the walk that produced
         * it reported `completed:false`. It is published so a future surface has
         * a fact rather than an absence — see the note on `endOfFeedEvidence` in
         * lib/api.js for why nothing may branch on it. */
        outcome.endOfFeedEvidence = typeof batch.endOfFeedEvidence === 'string' ? batch.endOfFeedEvidence : null;
        /* THE AUTOMATIC CURSOR-LESS PROBE — see `maybeAutoProbeFeed`.
         *
         * GATED ON THE CLIENT'S OWN ERROR CODE, not on a stop reason and not on a
         * counter: `cursor_missing` is the page-with-clips-and-no-cursor case and
         * `empty_page_no_cursor` is the 0-clips-and-no-cursor case, which are the
         * only two that mean "this page had no cursor field under any spelling I
         * know". An abort, a page failure, a page cap, a stuck cursor and a walk
         * that simply ended on a null cursor are all reachable with a code outside
         * that set, and none of them is the question the probe answers.
         *
         * `completed` is asserted false alongside it as a second, redundant guard:
         * the one branch in the client that can set `completed` is the one that
         * found a cursor field present and null, so this can only ever be an
         * incomplete walk — but a probe that ever fired on a completed one would be
         * a probe of a page that is already known to work, and that is the old
         * useless measurement this exists to replace.
         *
         * `batch.stopCursor` is the token the FAILING request was sent with, so the
         * probe asks for that page and not for page 1. */
        const stopCode = batch.error && typeof batch.error.code === 'string' ? batch.error.code : null;
        if (outcome.completed !== true && CURSOR_LESS_STOP_CODES.indexOf(stopCode) >= 0) {
          maybeAutoProbeFeed({
            workspaceId: project.id,
            cursor: batch.stopCursor,
            limit,
            includeTrashed: includeTrashed === true,
            dislikedWire: dislikedWireValue(disliked),
            stopReason: batch.stopReason || null,
            endOfFeedEvidence: outcome.endOfFeedEvidence,
            /* The client's own measurement of the failing page, read straight off
             * the error rather than off the log. `SunoApiError.evidence` is
             * caller-attached (see lib/api.js), and this is the caller that
             * attached it. */
            evidence: batch.error && batch.error.evidence ? batch.error.evidence : null,
            signal,
          });
        }
        summarySeen = true;
        onSummary(batch, project.id);
        break;
      }
      if (signal && signal.aborted) {
        /* A page the server ALREADY sent is never discarded: the request was
         * paid for, its rows are real, and writing them is idempotent. The walk
         * is then left to the client, which stops at the top of its own loop and
         * reports `stopReason:'aborted'` on the summary this consumer reads
         * next. Discarding the page here instead would let a cancel mid-page
         * silently drop up to `limit` clips that had already arrived. */
        outcome.stopReason = outcome.stopReason || 'aborted';
        outcome.walkStopReason = outcome.walkStopReason || 'aborted';
        outcome.error = outcome.error || 'the crawl was cancelled';
      }
      const pageClips = Array.isArray(batch.clips) ? batch.clips : [];
      outcome.pagesDone = Number.isFinite(batch.pagesDone) ? batch.pagesDone : outcome.pagesDone + 1;
      acceptedRows += pageClips.length;
      for (const clip of pageClips) {
        const id = clip && clip.id !== undefined && clip.id !== null ? String(clip.id) : '';
        if (id) uniqueSink.add(id);
      }
      await onPage(outcome, {
        projectId: project.id,
        page: Number.isFinite(batch.page) ? batch.page : outcome.pagesDone,
        clips: pageClips,
      });
      if (signal && signal.aborted) break;
    }
    if (!outcome.stopReason) outcome.stopReason = outcome.completed ? 'complete' : 'page_failed';
    if (!outcome.walkStopReason) outcome.walkStopReason = outcome.stopReason;
  } catch (err) {
    /* A first-page failure THROWS out of the client (nothing was indexed, so
     * there is nothing to keep). It becomes THIS workspace's row, not the run's:
     * the other 19 projects still get walked. */
    const info = describeError(err);
    const aborted = isAbortLike(err);
    outcome.completed = false;
    outcome.stopReason = aborted ? 'aborted' : 'page_failed';
    outcome.walkStopReason = outcome.stopReason;
    outcome.error = aborted ? 'the crawl was cancelled' : info.message;
    log('warn', 'sync.workspace_failed', { projectId: project.id, error: info });
  }

  /* NO SUMMARY BATCH ARRIVED — an abort is the ordinary way to get here, and a
   * mid-walk throw is the other. Either way this workspace committed pages, so it
   * must not report `totalSeen:0` and must not let `crawlInto` reconcile
   * `examined` against zero: the run would then report examining fewer clips than
   * it wrote, which is the claim the row above was making. `stopReason` is not
   * touched — an aborted walk still says `'aborted'`, and this only corrects the
   * COUNT beside it. A summary, when there is one, still wins: it is the client's
   * own de-duplicated figure and is what the oracle was designed around. */
  if (!summarySeen) outcome.totalSeen = acceptedRows;

  /* A WORKSPACE SHORT OF ITS OWN `clip_count` IS INCOMPLETE, ALWAYS.
   *
   * The previous arrangement made this conditional on `oracleFatal`, i.e. on
   * `oracleApplied`, which on the default settings is false on EVERY sync: the
   * crawl sends `filters.trashed:'False'` and `filters.disliked:'False'`, so no
   * walk and no project row count were ever declared comparable. The consequence
   * was that a walk which indexed 10-20% of a workspace and ended on a full page
   * reported `completed:true`, with `missing:null` to say the gap was never even
   * measured. The filter accounting argument is real — a handful of trashed or
   * disliked rows can legitimately make a filtered walk come up short — but it
   * cannot explain a gap two orders of magnitude larger, and it must never be able
   * to turn "my index is short" into "Up to date".
   *
   * So the comparison is now made for every workspace that HAS a comparable
   * count, `missing` is published whenever one exists, and:
   *   - `completed` becomes false and `stopReason:'expected_total'` on any gap;
   *   - `shortfallLikelyFilters` is true when the gap is small enough to be the
   *     filter accounting (`SHORTFALL_FILTER_CAUSE_SHARE`), which is what lets
   *     the copy say "this may be trashed/disliked clips, OR truncation — try a
   *     lower page limit" instead of asserting a cause it cannot support;
   *   - a gap large enough to rule the filters out says so, and names the next
   *     action (`PROBE_FEED`) rather than just the word "incomplete".
   *
   * An ALREADY-FAILED workspace keeps its own reason (`page_failed`,
   * `cursor_missing`, `aborted`, …): this block only supplies a reason where
   * there is none, because "the feed stopped on a parser miss" is a better
   * diagnosis than "you are 900 clips short" and both are true. */
  const hasCount = Number.isFinite(outcome.expected) && outcome.expected >= 0;
  if (hasCount) {
    const shortBy = Math.max(0, Math.floor(outcome.expected) - outcome.totalSeen);
    outcome.missing = shortBy;
    outcome.shortfallLikelyFilters = shortBy > 0
      && !oracleFatal
      && shortBy <= Math.max(1, Math.floor(Math.floor(outcome.expected) * SHORTFALL_FILTER_CAUSE_SHARE));
    if (shortBy > 0) {
      outcome.completed = false;
      if (outcome.stopReason === 'complete' || !outcome.stopReason) outcome.stopReason = 'expected_total';
      outcome.error = outcome.error || (outcome.shortfallLikelyFilters
        ? `workspace ${project.id} ended at ${outcome.totalSeen} of ${outcome.expected} clips. This `
          + "small gap may be trashed or disliked clips this walk's filters hide, or a truncated "
          + `feed — try a lower feedPageLimit (currently ${limit}) and sync again`
        : `workspace ${project.id} ended at ${outcome.totalSeen} of ${outcome.expected} clips, and the `
          + `gap is far larger than the trashed/disliked rows these filters hide. Run PROBE_FEED to `
          + 'check the feed page size and cursor field, then sync again');
    } else if (oracleFatal) {
      // Checked and met: `missing:0` is a real answer, and `stopReason` stays
      // whatever the walk itself concluded.
      outcome.missing = 0;
    }
  }
  /* NOT `else { outcome.missing = 0 }`: without a comparable count there is no
   * `missing` to report, and a hard `0` is a claim — "checked, found nothing
   * missing" — that nothing here checked. `newWorkspaceOutcome` already left it
   * `null` with `oracleApplied:false` and the sentence saying why. */
  log('info', 'sync.workspace_done', {
    projectId: project.id,
    pages: outcome.pagesDone || 0,
    seen: outcome.totalSeen || 0,
    expected: outcome.expected,
    completed: outcome.completed,
    stopReason: outcome.stopReason,
  });
  return outcome;
}

/**
 * Drop any row already recorded for a project id. Used when a workspace is
 * re-walked after an eviction: its earlier partial row must not survive next to
 * the new, complete one, or the summary would carry two rows for one project.
 *
 * @param {object[]} rows
 * @param {string} projectId
 * @returns {void}
 */
function dropWorkspaceRow(rows, projectId) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].projectId === projectId) rows.splice(i, 1);
  }
}

/**
 * The `filters.disliked` string the walk actually puts ON THE WIRE.
 *
 * WHY THIS IS NOT JUST `libraryFilter`: whether the completeness oracle may be
 * fatal depends on whether the walk was UNFILTERED, and "unfiltered" is a
 * property of the string the SERVER receives (`'Any'`), not of the mode key this
 * file uses internally (`'any'`). `DISLIKED_FILTER_BY_MODE` hands `iterateFeed`
 * the lowercase key and the client normalises it (`normalizeDislikedFilter`), so
 * the normalisation is MIRRORED here rather than assumed: if the two ever
 * disagreed, a filtered walk would be judged against an unfiltered row count —
 * which is the whole defect this exists to prevent. Duplicating a four-branch
 * string map is a far smaller cost than a silently fatal comparison.
 *
 * @param {string} filter the value handed to `iterateFeed`
 * @returns {'Any'|'True'|'False'} what `filters.disliked` will be
 */
function dislikedWireValue(filter) {
  const key = String(filter === undefined || filter === null ? 'exclude' : filter).trim().toLowerCase();
  if (key === 'any' || key === 'include' || key === 'all' || key === 'both') return 'Any';
  if (key === 'only' || key === 'true' || key === 'disliked') return 'True';
  return 'False';
}

/**
 * A stored row, cleaned of the fields a v3 crawl has no meaning for.
 *
 * WHY THIS EXISTS BESIDE THE SCHEMA CHECK: `resumable` compares
 * `stored.schema`, and the merge below is `Object.assign({}, freshCursor,
 * stored || {})` — where STORED WINS. So the schema marker is the only thing
 * standing between a resumed row and a stale `nextPage`/`pass` landing on the
 * fresh cursor, and a version check is a single number that a future edit, a
 * hand-patched row or a partial write can invalidate. The fields are therefore
 * normalised BY NAME, which does not depend on the marker being right.
 *
 * The values are set to `null` rather than deleted, because `DB.syncState.set`
 * MERGES its patch into the stored row (lib/db.js): omitting a key leaves the old
 * one in place, and the explicit `null` in `freshCursor` exists for that same
 * reason. Deleting here would let the legacy value survive the next write.
 *
 * @param {object|null} stored the row as read, or null
 * @returns {object|null} a shallow copy safe to resume from, or null
 */
function normaliseResumedCursor(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const row = Object.assign({}, stored);
  for (const field of LEGACY_PAGE_FIELDS) row[field] = null;
  return row;
}

/**
 * The stored row as it goes on the wire.
 *
 * WHY `nextPage` IS STRIPPED RATHER THAN NULLED: it is read by nothing — a
 * cursor walk resumes at WORKSPACE granularity and the page ordinal means
 * nothing to `/api/feed/v3` — so every value it could carry is useless, and
 * publishing `nextPage: 0` invites a reader to treat "page 0" as a position.
 * It was null in the stored row already; keeping the name on the wire at all was
 * the defect.
 *
 * WHY `advisory` IS ADDED UNDER ITS OWN NAME: the stored row spells the sentence
 * `oracleAdvisory`, because that is what it is next to, and `cursorForWire`
 * publishes the row nearly verbatim. The flat contract copy on the same reply
 * (`syncContractView`) calls the same sentence `advisory`, so a reader that
 * followed the "the contract is mirrored one level down" comment and read
 * `cursor.advisory` got `undefined` while `advisory` was sitting right there at
 * the top level. No shipped surface hit it — all three read the flat copy — but a
 * trap is a trap. Both spellings now resolve: `advisory` is ADDED (the flat
 * name), and `oracleAdvisory` is left in place so nothing that reads the stored
 * spelling is broken by it.
 *
 * @param {object|null} cursor the stored row
 * @returns {object|null} the row plus the `error` and `advisory` aliases, minus
 *   the dead fields
 */
function cursorForWire(cursor) {
  if (!cursor || typeof cursor !== 'object') return null;
  const view = Object.assign({}, cursor, { error: cursor.lastError || null });
  for (const field of LEGACY_PAGE_FIELDS) delete view[field];
  // `advisory` is OPTIONAL in the sense that matters: it is always present on the
  // wire, and `null` when there is nothing to say, which is what the flat copy
  // publishes too. A legacy row has no `oracleAdvisory` and reads `null`.
  view.advisory = typeof cursor.oracleAdvisory === 'string' && cursor.oracleAdvisory
    ? cursor.oracleAdvisory
    : (typeof cursor.advisory === 'string' && cursor.advisory ? cursor.advisory : null);
  return view;
}

/**
 * THE SYNC-SUMMARY CONTRACT, built once so every reply carries exactly the same
 * keys with exactly the same meanings.
 *
 * WHY ONE BUILDER AND NOT SIX HAND-WRITTEN PAYLOADS: `SYNC_DONE` (normal and
 * abort), `SYNC_ERROR` (both paths), `GET_BOOT.sync` and `SYNC_STATUS` were six
 * separate literals, and they had already drifted — the abort path dropped
 * `projectList`/`projectFeed`/`dislikedCount`, `SYNC_ERROR` dropped `truncated`
 * — so `truncated === !completed` was not even checkable everywhere, and one
 * reply published `totalSeen` as the unique count while the stored cursor of the
 * same name held the examined count. A single builder makes the invariant
 * structural instead of a convention that has to be re-remembered per literal.
 *
 * THE THREE NUMBERS, ONE NAME EACH:
 *   `totalSeen`   UNIQUE clips indexed. What the user is waiting for and what
 *                 "5,501 of ~5,500" has to mean.
 *   `uniqueSeen`  the same number under its own name, so nothing has to guess
 *                 which of the two a given reply used.
 *   `examined`    rows EXAMINED, a clip in two projects counted twice. What the
 *                 oracle (`sum of clip_count`) is compared against, because the
 *                 sum double-counts the same clip the same way.
 * `missing` is therefore `expectedTotal - examined`, which is why emitting the
 * unique count under `totalSeen` next to an examined-based `missing` produced
 * "1 clip is missing" on a library that had every clip.
 *
 * `missing` is AUTHORITATIVE whenever it is a number, `0` included: a
 * `missing:0` beside `expectedTotal:5502` means "checked, nothing missing", and
 * a reader that re-derives `expectedTotal - totalSeen` there gets a phantom
 * shortfall. Deriving from `examined` happens only when the row carries no
 * `missing` at all, so a stored row from an older build still reports something
 * truthful instead of nothing.
 *
 * `truncated` is computed as `!completed` here and nowhere else, so the flag can
 * never disagree with the verdict it summarises.
 *
 * `stopReason` IS A CLOSED VOCABULARY, and every value in it is actionable. The
 * full list, in the order a reader should weigh them:
 *   'complete'               the server said there was no more. Success.
 *   'resumed'                a workspace was carried forward from an earlier run
 *                            instead of being re-walked.
 *   'suspected_truncation'   EVERY workspace ended on the feed's own end-of-feed
 *                            signal and EVERY one of them is short of its
 *                            `clip_count`. The feed is being cut short, not the
 *                            library being small. Copy must name `PROBE_FEED` /
 *                            a lower `feedPageLimit`.
 *   'cursor_missing'         the feed response carried no cursor field this
 *                            client recognises, so the walk could not be
 *                            continued. A parser miss, loudly — never "finished".
 *   'page_failed'            a page failed after at least one page had landed.
 *   'empty_page'             a page carried 0 clips while a usable cursor was
 *                            still on offer.
 *   'stuck_cursor'           the server repeated a cursor already followed.
 *   'no_new_ids'             a page advanced the cursor but added no new clip id.
 *   'max_pages'              the page cap ended the walk with a cursor outstanding.
 *   'expected_total'         the run came up short of the count it compared
 *                            against — a project row count, or the project list.
 *   'aborted'                the user cancelled. Not a fault.
 *   'watchdog_timeout'       the crawl ran past `SYNC_WALL_CLOCK_MS` and the
 *                            watchdog aborted it. A stall, not a user decision.
 *   'interrupted'            THE WORKER WENT AWAY MID-CRAWL, and the row was
 *                            reconciled on read (`reconcileStaleCursor`) or at
 *                            wake (§13c). It is a worker-level reason, not a
 *                            statement from the feed, and it is why the crawl
 *                            cannot be proven indexed. Where the Stop had already
 *                            been requested the row's `error` names that, because
 *                            "your Stop was lost with the worker" and "the crawl
 *                            broke" are different sentences with different
 *                            remedies.
 * Anything else is a bug in the producer: render it as an unknown failure and
 * show `error`, never as a success.
 *
 * @param {object|null} cursor the stored row, when there is one
 * @param {object} [overrides] values this reply knows and the row does not yet
 *        (the live run's figures on the failure paths). Presence, not
 *        truthiness, is what selects an override — `missing: 0` overrides.
 * @returns {object} the contract, same keys and same meanings on every reply
 */
function syncContractView(cursor, overrides) {
  const row = cursor && typeof cursor === 'object' ? cursor : {};
  const over = overrides && typeof overrides === 'object' ? overrides : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(over, key);
  const pick = (key, fallback) => (has(key) ? over[key] : (row[key] === undefined ? fallback : row[key]));
  const count = (key) => Math.max(0, numOr(pick(key, 0)));

  const completed = pick('completed', false) === true;
  const expectedTotal = count('expectedTotal');
  const examined = count('examined');
  const uniqueSeen = count('uniqueSeen');
  const missingRaw = pick('missing', null);
  const missing = Number.isFinite(missingRaw)
    ? Math.max(0, missingRaw)
    : Math.max(0, expectedTotal - examined);
  const stopReasonRaw = pick('stopReason', null);
  const errorRaw = has('error')
    ? over.error
    : (typeof row.error === 'string' && row.error ? row.error : row.lastError);
  const stateRaw = pick('state', null);
  const advisoryRaw = has('advisory') ? over.advisory : row.oracleAdvisory;
  const workspacesRaw = pick('workspaces', []);

  /* WHICH PHASE, so a surface that POLLS (`SYNC_STATUS`, `GET_BOOT`) shows the
   * same thing as one that listens for `SYNC_PROGRESS` pushes. Without it the
   * three surfaces disagreed during the long mapping walk — the push-driven ones
   * had a note and the polling one said "starting", which is the confusion the
   * user reported. */
  const phaseRaw = pick('phase', null);
  const phase = typeof phaseRaw === 'string' && phaseRaw ? phaseRaw : null;

  return {
    phase,
    phasePagesDone: count('phasePagesDone'),
    phaseJoined: count('phaseJoined'),
    phaseItems: count('phaseItems'),
    completed,
    truncated: !completed,
    stopReason: typeof stopReasonRaw === 'string' && stopReasonRaw
      ? stopReasonRaw
      : (completed ? 'complete' : null),
    error: typeof errorRaw === 'string' && errorRaw ? errorRaw : null,
    expectedTotal,
    totalSeen: uniqueSeen,
    uniqueSeen,
    examined,
    missing,
    /* `oracleApplied` says whether the walk and the count measure the SAME SET:
     * it is false when the walk was filtered, so a shortfall may be rows the
     * filters removed rather than rows the crawl missed, and false when the server
     * reported no count to check against. It is the WORDING switch, not the
     * verdict: a shortfall fails the run either way (see `runSync`'s verdict
     * block), and `advisory` is the human sentence for the caveat — kept in its
     * own key because `error` is a failure and this is not one. */
    oracleApplied: pick('oracleApplied', false) === true,
    advisory: typeof advisoryRaw === 'string' && advisoryRaw ? advisoryRaw : null,
    /* TRUE when every workspace that reported a count came up short AND its gap
     * is small enough to be the trashed/disliked rows the walk's filters hide
     * (`SHORTFALL_FILTER_CAUSE_SHARE`). The UI's licence to hedge: "this may be
     * trashed/disliked clips, or truncation — try a lower page limit". FALSE with
     * a shortfall means the gap is far too large for that, and the copy should
     * point at `PROBE_FEED` instead. */
    shortfallLikelyFilters: pick('shortfallLikelyFilters', false) === true,
    /* THE FULL-PAGE SIGNAL. Published, never enforced: `pagesFull` counts pages
     * that filled the requested `limit`, and `lastPageFull` says whether the run
     * finished on one of them. A run that ends on a full page is worth showing to
     * the user as such, because "ended on a full page of 100" and "reached the
     * end of the library" look identical in every other number on this contract. */
    pagesFull: count('pagesFull'),
    lastPageSize: count('lastPageSize'),
    lastPageFull: pick('lastPageFull', false) === true,
    /* At least ONE workspace ended on a full page — the weaker, and more useful,
     * of the two full-page readings for a UI: "some workspace's last page came
     * back full and the feed then said there was no more". */
    anyWorkspaceEndedFull: pick('anyWorkspaceEndedFull', false) === true,
    feedPageLimit: count('feedPageLimit'),
    /* THE TWO FACTS `suspected_truncation` IS DERIVED FROM, published so a reader
     * can re-derive the verdict instead of trusting the wording:
     *   everyWorkspaceShort   every workspace with a count came up short
     *   endedOnTerminalCursor every walk reported the feed's own end-of-feed signal
     * Both true is the truncation shape; neither is a guess about which. */
    everyWorkspaceShort: pick('everyWorkspaceShort', false) === true,
    endedOnTerminalCursor: pick('endedOnTerminalCursor', false) === true,
    workspaces: Array.isArray(workspacesRaw) ? workspacesRaw : [],
    state: typeof stateRaw === 'string' && stateRaw
      ? stateRaw
      : (completed ? 'idle' : 'incomplete'),
    pagesDone: count('pagesDone'),
  };
}

/**
 * The crawl itself: every project, one walk each, de-duplicated across
 * projects, resumable, and never silently incomplete.
 *
 * WHY PER-WORKSPACE AND NOT ONE `scope:'all'` WALK: the library is not one list.
 * `/api/project/me` reported 3,444 clips in `default` on the recon account and
 * ~5,500 across all of it, because a clip lives in the project it was generated
 * into and the other projects (202, 574, 372, 75, 288 …) are never returned by a
 * `workspace:'default'` walk. Walking `default` alone is what left ~2,000 clips
 * permanently unreachable while the sync reported success. Enumerating the
 * projects and walking each one is the only shape in which the summed oracle can
 * actually be met.
 *
 * @param {{force:boolean, mode:string, maxPages:number, feedPageLimit:number,
 *   signal:AbortSignal}} opts
 * @returns {Promise<void>}
 */
async function runSync(opts) {
  const { force, mode, maxPages, feedPageLimit, signal } = opts;
  const startedAt = Date.now();
  /* The page size EVERY walk in this run asks for. It arrives as a value from
   * `startSync` (already resolved through `resolveFeedPageLimit`) and is never
   * re-derived here: the ceiling lives in `lib/api.js` and the setting lives in
   * this file's settings, and the one caller that knows both resolves it once. */
  const feedLimit = resolveFeedPageLimit(feedPageLimit, SunoAPI.LIMITS.feedPageLimit);
  const includeTrashed = false;
  /* The library walk's filter, resolved once at the top because the oracle's
   * scope depends on it and the decision is made before the project list exists.
   * `DISLIKED_FILTER_BY_MODE` is the only source of it, so the mode → filter
   * mapping still has exactly one definition. */
  const libraryFilter = DISLIKED_FILTER_BY_MODE[mode] || 'exclude';
  /* The oracle's verdict on this run, and the sentence explaining it. Declared
   * with their defaults BEFORE anything that can throw, because the failure path
   * broadcasts them: a `let` still in its temporal dead zone there would turn a
   * sync error into a `ReferenceError`. */
  let oracleApplied = false;
  let oracleAdvisory = null;

  const freshCursor = {
    schema: SYNC_CURSOR_SCHEMA,
    mode,
    maxPages,
    includeTrashed,
    /* The page size this run asked for, persisted for DIAGNOSIS ONLY. It is
     * deliberately NOT part of the `resumable` predicate below: changing it
     * mid-crawl changes nothing about which workspaces are finished or what the
     * plan is, and refusing to resume because a user nudged a page size would
     * turn a cosmetic change into a full re-walk. */
    feedPageLimit: feedLimit,

    /* The v2-era cursor fields, explicitly NULLed. `DB.syncState.set` MERGES its
     * patch into the stored row, so merely omitting them would leave a legacy
     * `nextPage`/`pass` visible on a row that no longer has those semantics.
     * `cursorForWire` keeps them off the wire as well, because a published field
     * that can only ever be `0` or `null` is a resume position that means
     * nothing to a cursor walk. */
    nextPage: null,
    pass: null,
    /* --- the crawl plan (v3 shape) --------------------------------- */
    projectIds: [],
    projectNames: {},
    nextProjectIndex: 0,
    projectsDone: [],
    /* `{projectId: nextCursor}`. The client publishes `nextCursor` only on the
     * walk's SUMMARY, i.e. at the END of a workspace, and `iterateFeed` accepts
     * NO `startCursor` option (it accepts and explicitly ignores `startPage`).
     * So the cursors are recorded for diagnosis and for a future client that can
     * accept one, but THIS worker resumes at WORKSPACE granularity: workspaces
     * already in `projectsDone` are not re-walked at all, and the workspace that
     * was in flight is re-walked from `cursor:null`. Writing are additive and
     * idempotent by clip id, so re-walking is safe, just not free. */
    cursors: {},
    dislikedProjectsDone: [],
    /* --- progress + the completeness contract ----------------------- */
    pagesDone: 0,
    /* THE THREE TALLIES, THREE NAMES, THREE MEANINGS:
     *   `totalSeen`  UNIQUE clips indexed — what the user is waiting for, and
     *                 what every reply publishes under that name.
     *   `uniqueSeen` the same number, under its own name, so a reader never has
     *                 to work out which of two spellings a given reply used.
     *   `examined`   rows EXAMINED with repeats included: a clip that lives in
     *                 two projects is walked twice and counted twice, because
     *                 `expectedTotal` is the SUM of per-project `clip_count`
     *                 and that sum counts the same clip twice. It is therefore
     *                 the ONLY tally `missing` may be computed from. */
    totalSeen: 0,
    uniqueSeen: 0,
    examined: 0,
    expectedTotal: 0,
    missing: 0,
    /* Was `missing` CHECKED against the oracle, or merely reported? Persisted
     * because the UIs read it and must not treat an unchecked lower bound as a
     * shortfall. `oracleAdvisory` is the same fact as a sentence, kept apart
     * from `lastError` because it is not a failure. */
    oracleApplied: false,
    oracleAdvisory: null,
    completed: false,
    truncated: true,
    stopReason: null,
    lastError: null,
    workspaces: [],
    dislikedWorkspaces: [],
    dislikedCount: null,
    dislikedApproximate: false,
    projectList: null,
    projectFeed: null,
    /* --- run bookkeeping -------------------------------------------- */
    state: 'running',
    force,
    startedAt,
    /* EXPLICITLY RESET, for the same reason `nextPage` and `pass` are nulled
     * above: `DB.syncState.set` MERGES, so a key this object omits survives from
     * a previous run's row. `cancelSync` writes `cancelRequested:true` onto that
     * row and the run's own verdict now clears it, but a row written by a build
     * that predates the clearing would otherwise hand this run a cancel nobody
     * asked for — and `SYNC_STATUS.cancelling` would then report "Stopping" for
     * a crawl that was never stopped. `interrupted*` are the §13c reconciliation's
     * markers and belong to the run that was evicted, not to this one. */
    cancelRequested: false,
    cancelRequestedAt: null,
    interrupted: false,
    interruptedAfterCancel: false,
  };

  /* Normalised BEFORE the merge so the row that wins the `Object.assign` below
   * cannot carry a page-era field. `Object.assign({}, freshCursor, stored)` lets
   * STORED win on every colliding key, so `nextPage`/`pass` would otherwise be
   * applied to a cursor walk that has no pages to resume from. The schema check
   * in `resumable` is the primary defence and this is the one that does not
   * depend on a version number being correct. */
  const stored = force ? null : normaliseResumedCursor(await DB.syncState.get('feed', null));
  log('info', 'sync.cursor_loaded', {
    resumed: !!stored && stored.state === 'running',
    storedState: stored ? stored.state : null,
    pagesDone: stored ? (stored.pagesDone || 0) : 0,
    projectsDone: stored ? (Array.isArray(stored.projectsDone) ? stored.projectsDone.length : 0) : 0,
  });
  const cursor = Object.assign({}, freshCursor, stored || {});
  /* Resumability is a claim about the SAME crawl, so it is only honoured when
   * every part of the plan agrees: the cursor shape, the state, the mode, the
   * page cap, and — checked once the project list is in — the project plan
   * itself.
   *
   * `state === 'running'` and nothing else is resumable. It is the one state an
   * EVICTED worker leaves behind, because the last thing such a worker wrote was
   * a page write, and a page write always records `running`. A run that reached a
   * verdict — `idle`, `incomplete`, `error`, `cancelled` — is NOT resumed, and
   * that is deliberate: skipping the workspaces a previous run completed would
   * mean a sync could never see a clip created in one of them, which is the same
   * class of bug as the v2 `nextPage` resume (a fresh sync starting at page 21
   * of a walk that had already finished) only quieter. */
  const resumable = !!(stored
    && stored.schema === SYNC_CURSOR_SCHEMA
    && stored.state === 'running'
    && stored.mode === mode
    && stored.maxPages === maxPages
    && Array.isArray(stored.projectIds)
    && Array.isArray(stored.projectsDone)
    /* A row that claims this schema but carries no `examined` tally is not a row
     * this build wrote, and resuming from it would restart the examined count at
     * 0 while skipping the workspaces that produced it — i.e. report a shortfall
     * of every clip already on disk. Cheap to check, and it makes a corrupt row
     * restart instead of lie. */
    && Number.isFinite(stored.examined));

  /* The run's own locals, declared HERE so `runCtx()` below can read them.
   *
   * TDZ, and it is worth stating plainly because it bit this twice: `projectsDone`
   * and `added` used to be declared hundreds of lines further down, while the first
   * `reportSyncPhase('planning', …)` call sat above them. Reading a `let` inside its
   * temporal dead zone throws `ReferenceError` — and `typeof` does NOT save you, as
   * it would for an undeclared name. So the declarations that the phase reporter
   * needs must precede its first call. */
  let projectsDone = resumable ? stored.projectsDone.slice() : [];
  let added = 0;
  const runCtx = () => ({ cursor, added, projectsDone });
  if (stored && !resumable) {
    log('info', 'sync.cursor_not_resumed', {
      wasSchema: stored.schema === undefined ? null : stored.schema,
      wasState: stored.state || null,
      wasMode: stored.mode || null,
      wasMaxPages: stored.maxPages === undefined ? null : stored.maxPages,
    });
    Object.assign(cursor, freshCursor);
  }
  cursor.schema = SYNC_CURSOR_SCHEMA;
  cursor.mode = mode;
  cursor.maxPages = maxPages;
  cursor.feedPageLimit = feedLimit;
  cursor.includeTrashed = includeTrashed;
  cursor.state = 'running';
  cursor.heartbeatAt = Date.now();
  cursor.force = force;
  cursor.startedAt = startedAt;

  /* ---- projects: the only source of BOTH membership and the oracle --- */
  /* The run's own locals, handed to `reportSyncPhase` because that helper is at
   * module scope and cannot close over them. */
  await reportSyncPhase('planning', { note: 'listing your workspaces' }, runCtx());
  const projectList = await fetchAllProjects({ signal, maxPages: PROJECT_LIST_MAX_PAGES });
  const plan = buildWorkspacePlan(projectList.projects);
  const projectIds = plan.map((entry) => entry.id);
  const expectedTotal = typeof SunoAPIClient.expectedClipTotal === 'function'
    ? SunoAPIClient.expectedClipTotal(plan)
    : plan.reduce(
      (sum, entry) => sum + (Number.isFinite(entry.clipCount) && entry.clipCount > 0 ? entry.clipCount : 0),
      0
    );
  cursor.projectList = {
    complete: projectList.complete,
    stopReason: projectList.stopReason,
    error: projectList.error,
    pagesDone: projectList.pagesDone,
    discovered: plan.length,
    expectedProjects: projectList.expectedProjects,
  };
  cursor.projectIds = projectIds;
  cursor.projectNames = plan.reduce((acc, entry) => {
    acc[entry.id] = entry.name;
    return acc;
  }, {});
  cursor.expectedTotal = expectedTotal;

  /* ---- WHETHER THE ORACLE MAY BE FATAL, DECIDED ONCE, UP FRONT ------- */
  /* THE PROBLEM: the oracle is `project.clip_count` — a PROJECT ROW COUNT — and
   * it is compared against a WALK, which is a FILTERED request. On the default
   * settings this walk applies two filters the row count has no reason to share:
   *
   *   - `filters.trashed` is 'False' on every walk. `includeTrashed` is hard
   *     false (set at the top of this function) and `iterateFeed` builds the
   *     filter itself.
   *   - `filters.disliked` is 'False' for the default `dislikedMode:'exclude'`.
   *
   * Nothing in the wire contract says `clip_count` excludes trashed or disliked
   * rows, and if it does not — it is a row count from the same store the feed
   * filters — then EVERY default-mode sync falls short by exactly
   * trashed + disliked, permanently, and tells the user to raise a page cap that
   * was never reached. Nobody can settle that from static reading, so the
   * comparison is made HONEST instead of fatal: a shortfall from a filtered walk
   * is reported as a LOWER BOUND (`oracleApplied:false` + `advisory`) and does
   * not touch `completed`. The numbers are still published — they are the best
   * information available — and the verdict stops claiming they prove anything.
   *
   * WHAT WOULD MAKE THE ORACLE FATAL AGAIN, CONCRETELY: an authenticated capture
   * on an account holding at least one trashed clip and at least one disliked
   * clip, showing that `clip_count` for a project is NOT greater than the number
   * of rows an UNFILTERED `/api/feed/v3` walk returns for that same project —
   * i.e. that the count is the count of what the unfiltered feed returns. Then
   * `includeTrashed:true` + `disliked:'Any'` makes the walk and the count
   * measure the same set, `oracleApplied` becomes true for that configuration
   * (exactly the condition computed here), and a shortfall becomes proof again.
   * Until that capture exists, the default configuration cannot fail a sync on a
   * number nobody can vouch for.
   *
   * THE `null` COUNT IS THE SAME PROBLEM ONE WORKSPACE WIDER: `buildWorkspacePlan`
   * appends a `default` project with `clipCount: null` when the list arrives
   * without it, so that workspace has no oracle at all — it was reporting
   * `completed:true` with no check whatsoever. Its row is marked
   * `oracleApplied:false` too, and the run says how many rows were unchecked. */
  const libraryWireFilter = dislikedWireValue(libraryFilter);
  oracleApplied = includeTrashed === true && libraryWireFilter === 'Any';
  const uncheckedWorkspaces = plan.filter((entry) => !Number.isFinite(entry.clipCount));
  const advisories = [];
  if (!oracleApplied) {
    advisories.push(
      `clip counts are a LOWER BOUND here: this walk asked the server for `
      + `trashed='${includeTrashed ? 'Any' : 'False'}', disliked='${libraryWireFilter}', so it cannot see `
      + `rows a project count may still include. A shortfall is reported, not treated as a failure.`
    );
  }
  if (uncheckedWorkspaces.length) {
    advisories.push(
      `${uncheckedWorkspaces.length} of ${plan.length} workspaces reported no clip_count `
      + `(${uncheckedWorkspaces.map((entry) => entry.id).slice(0, 5).join(', ')}) and cannot be checked`
    );
  }
  oracleAdvisory = advisories.length ? advisories.join(' ') : null;
  cursor.oracleApplied = oracleApplied;
  cursor.oracleAdvisory = oracleAdvisory;
  log('info', 'sync.projects', {
    count: plan.length,
    pagesFetched: projectList.pagesDone,
    complete: projectList.complete,
    expectedTotal,
    oracleApplied,
    uncheckedWorkspaces: uncheckedWorkspaces.length,
    filters: { trashed: includeTrashed, disliked: libraryWireFilter },
  });
  try {
    await DB.meta.set(META_KEYS.PROJECTS, { at: Date.now(), projects: plan });
  } catch (projectsMetaErr) {
    log('warn', 'sync.projects_meta_failed', { error: describeError(projectsMetaErr) });
  }

  /* The plan is only resumable if the account still has the same projects. A
   * changed list means a changed library, so the old progress index would point
   * into a different crawl. */
  let nextProjectIndex = resumable && Number.isFinite(stored.nextProjectIndex) ? stored.nextProjectIndex : 0;
  if (resumable && (stored.projectIds.length !== projectIds.length
    || stored.projectIds.some((id, i) => id !== projectIds[i]))) {
    log('info', 'sync.plan_changed', { was: stored.projectIds.length, now: projectIds.length });
    projectsDone = [];
    nextProjectIndex = 0;
  }
  projectsDone = projectsDone.filter((id) => projectIds.indexOf(String(id)) >= 0);
  nextProjectIndex = Math.max(0, Math.min(nextProjectIndex, projectIds.length));

  /* ---- project/clip membership join: EXACTLY ONCE per sync ---------- */
  /* WHY ONCE, AND WHY A FAILED JOIN IS NOT RE-WALKED: `fetchProjectFeed` is a
   * multi-page cursor walk (30 rows per page), so on a 5,500-clip library it is
   * ~180 requests. `hydrate()` re-runs the WHOLE walk whenever it is handed no
   * memberships — which the previous build did for every one of its batches,
   * turning one sync into thousands of requests, and which it would still do
   * after a first-page failure. So it is called exactly once here, its Map is
   * cached for the run, and a failure hands `hydrate` an EMPTY (truthy) map so
   * clips are written UNJOINED and the loss is reported rather than hidden. */
  let membershipsAll = new Map();
  let addedAtMs = new Map();
  let projectFeed = null;
  /* ~180 pages on a 5,500-clip library, and it runs BEFORE the first feed page,
   * so it is the phase a user is most likely to interrupt by mistake — and the
   * phase in which the library legitimately still holds zero new clips. */
  await reportSyncPhase('mapping', { note: 'mapping clips to workspaces (~180 pages, no clips indexed yet)' }, runCtx());
  let lastMappingEmit = 0;
  try {
    const result = await SunoAPIClient.fetchProjectFeed({
      signal,
      limit: SunoAPI.LIMITS.projectFeedLimit,
      maxPages,
      onProgress: (p) => {
        /* Throttled: one DB write and one broadcast per N pages, so a 180-page
         * walk does not turn into 180 round trips of its own. */
        const now = Date.now();
        if (p && p.pagesDone && p.pagesDone % 10 === 0 && now - lastMappingEmit > 900) {
          lastMappingEmit = now;
          reportSyncPhase('mapping', {
            pagesDone: p.pagesDone,
            items: p.items,
            joined: p.joined,
            note: 'mapping clips to workspaces — ' + p.pagesDone + ' pages, ' + p.joined + ' joined (no clips indexed yet)',
          }, runCtx()).catch((emitErr) => log('warn', 'sync.phase_emit_failed', { message: describeError(emitErr).message }));
        }
      },
    });
    membershipsAll = result.membershipsAll || new Map();
    addedAtMs = result.addedAtMs || new Map();
    projectFeed = {
      ok: true,
      completed: result.completed === true,
      stopReason: result.stopReason || 'complete',
      error: result.error ? describeError(result.error).message : null,
      pagesDone: result.pagesDone || 0,
      joined: membershipsAll.size,
      inferred: result.inferred === true,
    };
    if (result.inferred) log('info', 'sync.project_feed_inferred', { items: result.items });
    if (!result.completed) {
      log('warn', 'sync.project_feed_incomplete', { stopReason: projectFeed.stopReason, joined: projectFeed.joined });
    }
  } catch (feedErr) {
    const info = describeError(feedErr);
    projectFeed = {
      ok: false,
      completed: false,
      stopReason: isAbortLike(feedErr) ? 'aborted' : 'page_failed',
      error: info.message,
      pagesDone: 0,
      joined: 0,
      inferred: false,
    };
    log('warn', 'sync.project_feed_failed', { error: info });
  }
  cursor.projectFeed = projectFeed;

  /* ---- the forced-rebuild buffer ----------------------------------- */
  // force:true + additive putMany would leave STALE clips behind forever, so a
  // forced crawl buffers and finishes with one atomic bulkReplace. If the crawl
  // turns out to be truncated, or the buffer overflows, we fall back to additive
  // writes and say so, because losing the user's library is never acceptable.
  const buffered = [];
  let buffering = force;
  let overflowed = false;

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
   * Stamp the dislike verdict onto a page and write it.
   *
   * WHY THE FLAG IS STORED RATHER THAN ONLY DERIVED: `SunoFilter` reads
   * `boolOf(rec.is_disliked)` plus `ctx.dislikedIds`, and the rows on disk are the
   * RAW feed shape — the filter normalises them per query — so the verdict has to
   * survive the round trip through IndexedDB. It is stamped as `is_disliked`, the
   * field name `normalizeClip` and `SunoFilter.normalize` already read, and it is
   * stamped for BOTH phases: a `'False'` walk can only contain non-disliked clips
   * and a `'True'` walk can only contain disliked ones, because the server did the
   * filtering. That makes `disliked:'only'` and `disliked:'exclude'` exact with no
   * second pass over the rows and no difference of page sets.
   *
   * @param {object[]} clips
   * @param {boolean} verdict `false` for the `'False'` walk, `true` for `'True'`
   * @returns {Promise<void>}
   */
  const commitPage = async (clips, verdict) => {
    if (!clips.length) return;
    const stamped = clips.map((clip) => ({ ...clip, is_disliked: verdict }));
    if (buffering) {
      for (const clip of stamped) buffered.push(clip);
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
    const rows = await SunoAPIClient.hydrate(stamped, { membershipsAll, addedAtMs, signal });
    added += (await DB.clips.putMany(Array.from(rows.values()))) || 0;
  };

  const uniqueIds = new Set();
  /* A resumed run SKIPS the workspaces the evicted worker finished, so the run's
   * accumulators have to start where that worker left off. Without the carry
   * `examined` would restart at 0 while the oracle still counts the whole
   * library, and the resumed run would report a shortfall of every clip already
   * on disk — i.e. it would refuse to call itself complete precisely because it
   * resumed. The workspaces it skipped are carried forward as their stored rows
   * for the same reason: the summary must carry one row per project, and a
   * workspace that is not re-walked cannot grow a row.
   *
   * `examined` is carried under its OWN name only. `stored.totalSeen` is not a
   * fallback: on a schema-2 row it means rows-examined while on a schema-3 row it
   * means unique clips, and reading it as either without knowing which is how a
   * resume invents a shortfall (or hides one). `resumable` requires the schema,
   * and `examined` is absent from every row this build did not write.
   *
   * THE ONE BOUND A RESUME PUTS ON THE UNIQUE COUNT: a skipped workspace's ids
   * are not re-walked, so `carriedUniqueSeen` is trusted rather than recomputed,
   * and a clip that lives in BOTH a skipped and a re-walked workspace is counted
   * twice. `examined` and `missing` — the figures the verdict and the contract
   * turn on — are exact regardless, and this bound is bounded by the number of
   * skipped projects. Getting it exact would mean persisting every skipped
   * workspace's id set, which is thousands of ids to save one duplicated row in a
   * "X of ~Y" numerator on a resumed run. */
  const carriedExamined = resumable && Number.isFinite(stored.examined) ? stored.examined : 0;
  const carriedUniqueSeen = resumable && Number.isFinite(stored.uniqueSeen) ? stored.uniqueSeen : 0;
  const workspaces = (resumable && Array.isArray(stored.workspaces) ? stored.workspaces : [])
    .filter((row) => row && projectsDone.indexOf(String(row.projectId)) >= 0)
    .map((row) => Object.assign({}, row));
  const dislikedWorkspaces = (resumable && Array.isArray(stored.dislikedWorkspaces)
    ? stored.dislikedWorkspaces
    : [])
    .filter((row) => row && row.completed === true)
    .map((row) => Object.assign({}, row));
  const dislikedIds = new Set();
  /* PHASE 1 IS THE ONE THAT DEFINES COMPLETENESS, SO IT IS THE ONLY ONE THAT
   * FEEDS THE RUN'S TALLIES. `examined` and `uniqueSeen` answer "how much of the
   * library did this crawl see", and the oracle (`expectedTotal`, the sum of
   * per-project `clip_count`) describes the LIBRARY walk — so phase 2's rows must
   * not be added to either. Phase 2's ids go to `dislikedIds` only, which is
   * what it exists for: stamping `is_disliked` and counting dislikes.
   *
   * WHY THIS MATTERS ENOUGH TO FIX: in `both` mode both walks fed the same
   * accumulators, so the run reported "library rows + disliked rows" examined —
   * a figure corresponding to nothing, since `expectedTotal` counts each clip
   * once per project it lives in and the two walks are different row sets of the
   * same library. `totalsMet` survived (more rows only made it easier to pass),
   * but the number the UI shows as "X of ~Y" was meaningless, and the only reason
   * it went unnoticed is that nobody looked at it in `both` mode.
   *
   * The 'True' walk cannot contain a clip the 'False' walk already counted —
   * the server filtered by dislike state — so phase 1 alone is also the complete
   * unique count for the library it walked, and dropping phase 2's ids from
   * `totalSeen` loses nothing about what phase 1 indexed. */
  let examined = carriedExamined;
  let firstError = null;
  let pagesSinceDislikeFlush = 0;

  /** Unique clip ids PHASE 1 walked, including the carried-forward tally. */
  const uniqueSeenTotal = () => carriedUniqueSeen + uniqueIds.size;

  /**
   * The page hook. Commit, then persist, then broadcast.
   *
   * THE ORDER IS THE POINT: a cursor that claims a page the database does not
   * hold would lose that page on resume, so the write comes first and the claim
   * second. `DB.syncState.set('feed', cursor)` on EVERY page is what lets an
   * evicted worker resume instead of restarting the crawl.
   *
   * `countsForOracle` is FALSE for phase 2: its pages are walked, written and
   * counted in `pagesDone`, but they must not move `examined` or `totalSeen`,
   * because those two are the library walk's figures and the oracle's operands
   * (see the accumulator declaration). Phase 2's ids go to `dislikedIds`.
   *
   * @param {object} outcome the workspace row in progress
   * @param {{projectId:string,page:number,clips:object[],verdict:boolean}} page
   * @param {boolean} countsForOracle
   * @returns {Promise<void>}
   */
  const afterPage = async (outcome, page, countsForOracle) => {
    if (countsForOracle) examined += page.clips.length;
    cursor.pagesDone += 1;
    cursor.examined = examined;
    cursor.totalSeen = uniqueSeenTotal();
    cursor.uniqueSeen = cursor.totalSeen;
    cursor.state = 'running';
    log('debug', 'sync.page', {
      projectId: page.projectId,
      page: cursor.pagesDone,
      clips: page.clips.length,
      seen: cursor.totalSeen,
    });
    // LIVENESS HEARTBEAT. An MV3 service worker can be evicted at any await, and a
    // crawl that dies that way leaves its persisted cursor saying `running` for
    // ever. Every surface then shows a frozen "Syncing" with a Stop button that
    // cannot work, because `syncController` — the only thing cancel can signal —
    // went with the worker. A timestamp written on every committed page lets any
    // later read distinguish "a crawl is genuinely in flight" from "a cursor was
    // orphaned by an eviction", without needing a timer that would itself not
    // survive eviction.
    cursor.heartbeatAt = Date.now();
    /* …and the run record gets the same heartbeat (§13c). THROTTLED, and the
     * throttle is load-bearing rather than tidy: this runs once per feed page,
     * which is ~80 writes on the library this bug was reported from, and the
     * record's only job is to be newer than `SYNC_RUN_HEARTBEAT_FLOOR_MS` when
     * the worker dies. Five seconds is an order of magnitude below the floor it
     * is checked against, so a throttled write can never make a live crawl look
     * evicted. NOT awaited: `afterPage` is on the crawl's hot path and a storage
     * round-trip per page is exactly the kind of cost that pushes a crawl past
     * the eviction window in the first place. `writeSyncRun` logs its own
     * failures, so nothing is lost by letting it settle late — and the cursor
     * write on the next line is the durable record regardless. */
    if (Date.now() - lastSyncRunBeat > SYNC_RUN_HEARTBEAT_FLOOR_MS) {
      lastSyncRunBeat = Date.now();
      void writeSyncRun({ heartbeatAt: lastSyncRunBeat });
    }
    const workspaceIndex = workspaces.findIndex((row) => row.projectId === page.projectId);
    if (workspaceIndex >= 0) {
      workspaces[workspaceIndex] = outcome;
    }
    await commitPage(page.clips, page.verdict);
    await DB.syncState.set('feed', cursor);
    await broadcast({
      type: 'SYNC_PROGRESS',
      page: cursor.pagesDone,
      pagesDone: cursor.pagesDone,
      seen: cursor.totalSeen,
      added,
      etaMs: estimateSyncEta(
        startedAt,
        cursor.pagesDone,
        cursor.pagesDone,
        expectedTotal > 0 ? Math.max(1, Math.ceil(expectedTotal / feedLimit)) : maxPages
      ),
      state: 'running',
      workspace: page.projectId,
      workspacesDone: projectsDone.length,
      expectedTotal,
      /* The unique count, under both names, so a progress reader cannot end up
       * with a different figure from the final reply for the same field. */
      totalSeen: cursor.totalSeen,
      uniqueSeen: cursor.totalSeen,
      completed: false,
      /* A run in progress is by definition not a finished library, so
       * `truncated === !completed` holds here as it does on every other reply.
       * It used to be absent, which made the flag's meaning depend on the type of
       * the message rather than on the run's state. */
      truncated: true,
    });
  };

  /**
   * Persist the cursor with everything learned so far. Called after every
   * workspace so the plan's progress index is never behind the library.
   * @returns {Promise<void>}
   */
  const persist = async () => {
    cursor.workspaces = workspaces.slice();
    cursor.dislikedWorkspaces = dislikedWorkspaces.slice();
    cursor.projectsDone = projectsDone.slice();
    cursor.dislikedProjectsDone = dislikedWorkspaces
      .filter((row) => row.completed)
      .map((row) => row.projectId);
    cursor.examined = examined;
    cursor.totalSeen = uniqueSeenTotal();
    cursor.uniqueSeen = cursor.totalSeen;
    await DB.syncState.set('feed', cursor);
  };

  /**
   * Walk one plan entry and fold its outcome into the run.
   *
   * @param {object} project
   * @param {string} disliked
   * @param {boolean} oracleFatal whether a shortfall here may fail the run
   * @param {object[]} rows where the outcome lands
   * @param {string|null} oracleAdvisory why the oracle is not fatal here
   * @param {{dislikeSink?:Set<string>,uniqueSink?:Set<string>,
   *          countsForOracle?:boolean}} [sinks] where this walk's ids go, and
   *        whether they feed the run's tallies
   * @returns {Promise<object>} the workspace outcome row
   */
  const crawlInto = async (project, disliked, oracleFatal, rows, oracleAdvisory, sinks) => {
    const config = sinks && typeof sinks === 'object' ? sinks : {};
    const dislikeSink = config.dislikeSink instanceof Set ? config.dislikeSink : null;
    /* DEFAULT SINK IS THE RUN'S: phase 1 de-duplicates the whole library, so its
     * ids belong to `totalSeen`. Phase 2 passes `dislikedIds` for both sinks — the
     * 'True' walk's unique ids ARE the disliked set, so that is one accumulation
     * done once, not two copies of the same set. */
    const uniqueSink = config.uniqueSink instanceof Set ? config.uniqueSink : uniqueIds;
    const countsForOracle = config.countsForOracle !== false;
    /* WHICH COUNT DESCRIBES THIS WALK: phase 1 is compared against the plan's
     * oracle, so it publishes the project's own `clip_count`; phase 2 walks a
     * DIFFERENT row set (the disliked rows), so no count describes it and it
     * publishes none. This is the parameter that keeps a `disliked:'only'` row
     * from ever showing "missing 260 of 275". */
    const expectedForWalk = countsForOracle
      && Number.isFinite(project.clipCount)
      && project.clipCount >= 0
      ? project.clipCount
      : null;
    const examinedBefore = examined;
    const outcome = await crawlWorkspace({
      project,
      disliked,
      expected: expectedForWalk,
      oracleFatal,
      oracleAdvisory,
      maxPages,
      limit: feedLimit,
      includeTrashed,
      signal,
      uniqueSink,
      onPage: async (row, page) => {
        if (dislikeSink) {
          for (const clip of page.clips) {
            const id = clip && clip.id !== undefined && clip.id !== null ? String(clip.id) : '';
            if (id) dislikeSink.add(id);
          }
          pagesSinceDislikeFlush += 1;
          if (pagesSinceDislikeFlush >= DISLIKED_FLUSH_EVERY_PAGES) {
            pagesSinceDislikeFlush = 0;
            try {
              await DB.meta.set(META_KEYS.FEED_DISLIKED_IDS, Array.from(dislikeSink));
            } catch (flushErr) {
              log('warn', 'sync.id_set_flush_failed', { error: describeError(flushErr) });
            }
          }
        }
        await afterPage(row, {
          projectId: page.projectId,
          page: page.page,
          clips: page.clips,
          verdict: disliked === DISLIKED_ONLY_FILTER,
        }, countsForOracle);
      },
      onSummary: (summary, projectId) => {
        // The ONLY place a cursor for a workspace is available: the client keeps
        // `nextCursor` to itself until the walk's summary.
        if (summary.nextCursor !== undefined) cursor.cursors[projectId] = summary.nextCursor;
      },
    });
    /* Reconcile against the client's own per-walk total rather than the sum of
     * the pages we happened to see, so the run figure is exactly what the oracle
     * is compared with. Phase 2 reconciles nothing: its total describes a row set
     * the oracle does not cover.
     *
     * `crawlWorkspace` guarantees `outcome.totalSeen` is never LOWER than the rows
     * its pages committed — an abandoned walk reports the pages it accepted rather
     * than the `0` an unread summary batch used to imply — so `examined` can never
     * end a run below the rows actually persisted. It is not floored again here:
     * the client's figure may legitimately be SMALLER than the raw page rows when
     * one clip repeats inside a single workspace, and that smaller number is the
     * one the summed `clip_count` oracle is defined against. */
    if (countsForOracle) examined = examinedBefore + (Number.isFinite(outcome.totalSeen) ? outcome.totalSeen : 0);
    if (!outcome.completed && !firstError) firstError = outcome.error;
    dropWorkspaceRow(rows, project.id);
    rows.push(outcome);
    return outcome;
  };

  try {
    /* ---- phase 1: every project, one walk each ----------------------- */
    /* From here on the crawl is indexing, which is the only phase that changes
     * the clip count — the UI needs to say so, because until this point the
     * library legitimately holds nothing new. */
    await reportSyncPhase('crawling', {
      note: 'crawling your library' + (plan.length ? ' — ' + plan.length + ' workspaces' : ''),
    }, runCtx());
    /* The loop runs over the WHOLE plan every time, not from
     * `nextProjectIndex`, and `projectsDone` is the only thing that gates a
     * workspace. A workspace that did not COMPLETE is deliberately left out of
     * that list, so a resumed run returns to it — an `index` cursor alone would
     * step over the workspace that failed on the previous run and never retry
     * it. `nextProjectIndex` is still persisted, as the plan's progress
     * pointer for diagnostics. */
    for (let index = 0; index < plan.length; index += 1) {
      if (signal.aborted) break;
      const project = plan[index];
      if (projectsDone.indexOf(project.id) >= 0) continue;
      cursor.nextProjectIndex = index;
      /* `oracleFatal` is the run-level scoping decision ANDed with "this project
       * reported a count", so a plan entry with `clipCount: null` cannot be
       * checked and says so on its own row instead of silently passing.
       *
       * THE ROW SENTENCE IS DELIBERATELY SHORT and the run-level `advisory` is
       * the long one: this runs for every workspace, and the full paragraph (which
       * names the exact filter values) is repeated once per row in a payload that
       * is broadcast to every Suno tab. The row says why IT was not checked; the
       * reply says what the filters were. */
      const rowAdvisory = oracleApplied ? null : (Number.isFinite(project.clipCount)
        ? `clip_count for ${project.id} may include rows this walk's filters hide`
        : `${project.id} reported no clip_count, so this walk cannot be checked at all`);
      const outcome = await crawlInto(project, libraryFilter, oracleApplied, workspaces, rowAdvisory, {
        countsForOracle: true,
      });
      if (outcome.completed) projectsDone.push(project.id);
      nextProjectIndex = index + 1;
      cursor.nextProjectIndex = nextProjectIndex;
      await persist();
    }

    /* ---- phase 2 (`dislikedMode:'both'`): the disliked id set -------- */
    /* WHY A SECOND WALK INSTEAD OF A SYMMETRIC DIFFERENCE: there is no per-clip
     * dislike field on Suno, which is the entire reason the previous build walked
     * the library twice and subtracted the two id sets. `/api/feed/v3` takes
     * `filters.disliked` as a SERVER-SIDE tri-state filter, so one walk of
     * `'True'` IS the disliked set, exactly. Nothing is inferred, so nothing can
     * be wrong when two passes see different rows — which is what made the
     * difference wrong in the first place. */
    if (mode === 'both' && !signal.aborted) {
      /* Resume the id set: the partial set is flushed to `meta` every
       * `DISM...EVERY_PAGES` pages precisely so an eviction cannot lose it. */
      const alreadyDone = new Set(resumable && Array.isArray(stored.dislikedProjectsDone)
        ? stored.dislikedProjectsDone
        : []);
      if (resumable && alreadyDone.size) {
        try {
          const remembered = await DB.meta.get(META_KEYS.FEED_DISLIKED_IDS, []);
          if (Array.isArray(remembered)) for (const id of remembered) dislikedIds.add(String(id));
        } catch (dislikeResumeErr) {
          log('warn', 'sync.dislike_set_resume_failed', { error: describeError(dislikeResumeErr) });
        }
      }
      for (const project of plan) {
        if (signal.aborted) break;
        if (alreadyDone.has(project.id)) {
          dropWorkspaceRow(dislikedWorkspaces, project.id);
          dislikedWorkspaces.push({
            projectId: project.id,
            name: project.name,
            completed: true,
            pagesDone: 0,
            totalSeen: 0,
            expected: null,
            missing: null,
            oracleApplied: false,
            advisory: 'carried forward from an earlier run: this walk was not repeated',
            stopReason: 'resumed',
            walkStopReason: 'resumed',
            error: null,
            disliked: DISLIKED_ONLY_FILTER,
            shortfallLikelyFilters: false,
            pagesFull: 0,
            lastPageSize: 0,
            lastPageFull: false,
            cursorAlias: null,
          });
          continue;
        }
        /* NO ORACLE, AND NO EFFECT ON THE RUN'S TALLIES:
         *   - `oracleFatal:false` because a `'True'` walk returns only the
         *     DISLIKED clips in this project, a subset of its `clip_count`.
         *     Comparing them would declare every project permanently short.
         *   - `countsForOracle:false` because `expectedTotal` is the SUM of the
         *     LIBRARY walks' counts; phase 2's rows would inflate `examined`
         *     past it and `totalSeen` into a figure that describes nothing.
         *   - `uniqueSink:dislikedIds` because the 'True' walk's unique ids ARE
         *     the disliked set: one accumulation, feeding `dislikedCount` and the
         *     `is_disliked` stamping, and nothing else. */
        await crawlInto(project, DISLIKED_ONLY_FILTER, false, dislikedWorkspaces,
          'a disliked-only walk covers a subset of this project, so its length is never compared against clip_count', {
            dislikeSink: dislikedIds,
            uniqueSink: dislikedIds,
            countsForOracle: false,
          });
        await persist();
      }
      /* The set is exact only when EVERY project's `'True'` walk finished — a
       * row that is merely absent counts as unfinished, or a cancelled phase 2
       * would report the partial set as exact. Otherwise it is a partial set and
       * is REPORTED as approximate, never as a count. */
      cursor.dislikedCount = dislikedIds.size;
      cursor.dislikedApproximate = dislikedWorkspaces.length !== plan.length
        || dislikedWorkspaces.some((row) => !row.completed);
      if (cursor.dislikedApproximate) {
        log('warn', 'sync.dislike_set_partial', { count: dislikedIds.size });
      }
    } else if (mode !== 'both') {
      /* A single `'Any'` / `'False'` walk cannot classify rows it never
       * requested, so the count stays UNKNOWN (null) rather than being reported
       * as 0 — which is exactly what the vanished `dislikedIds` envelope used to
       * turn into. Any previously measured set is carried forward untouched. */
      let rememberedIds = [];
      try {
        const remembered = await DB.meta.get(META_KEYS.FEED_DISLIKED_IDS, []);
        rememberedIds = Array.isArray(remembered) ? remembered.map(String) : [];
      } catch (dislikeLoadErr) {
        log('warn', 'sync.dislike_set_load_failed', { error: describeError(dislikeLoadErr) });
      }
      cursor.dislikedCount = rememberedIds.length > 0 ? rememberedIds.length : null;
      cursor.dislikedApproximate = rememberedIds.length === 0;
    }

    if (dislikedIds.size) {
      try {
        await DB.meta.set(META_KEYS.FEED_DISLIKED_IDS, Array.from(dislikedIds));
      } catch (dislikePersistErr) {
        log('warn', 'sync.dislike_set_persist_failed', { error: describeError(dislikePersistErr) });
      }
      await DB.journal.append({ batchId: 'sync', phase: 'dislike-set', detail: { count: dislikedIds.size } });
    }

    /* ---- the completeness verdict, BEFORE the rebuild is committed ---- */
    /* WHY THE ORDER: a forced rebuild's `bulkReplace` may only run on a COMPLETE
     * crawl — replacing the library with a truncated one would delete the clips
     * the crawl failed to reach. So the verdict is computed first and the buffer
     * is committed against it. */
    /* `examined` counts rows EXAMINED across workspaces, repeats included, because
     * the oracle is the SUM of per-project `clip_count`s, which counts a clip
     * living in two projects twice. Comparing the run's UNIQUE count against that
     * sum would report a permanent shortfall on every account that shares a clip
     * between projects — the same "looks broken forever" class of bug as the one
     * this crawl exists to fix. So the arithmetic is `examined`, while what the
     * user is shown is `totalSeen` (unique) and `missing` stays the examined-based
     * difference, which is why the two must be emitted under separate names. */
    const everyWorkspaceCompleted = workspaces.length === plan.length
      && workspaces.every((row) => row.completed);
    const everyDislikedCompleted = mode !== 'both'
      || (dislikedWorkspaces.length === plan.length && dislikedWorkspaces.every((row) => row.completed));
    /* A SHORTFALL IS A FAILURE WHETHER OR NOT THE ORACLE IS COMPARABLE.
     *
     * `oracleApplied` decides the WORDING of a shortfall, not whether one can be
     * ignored. On the default filtered settings it is false on every sync, which
     * used to mean a crawl that indexed 10-20% of the library reported
     * `completed:true` — the reported symptom, reproduced exactly. The filter
     * accounting really can explain a handful of rows; it cannot explain losing
     * thousands, and a build that cannot tell those apart has no business calling
     * either of them "Up to date".
     *
     * `everyWorkspaceShort` is the aggregate question the verdict needs: EVERY
     * workspace that reported a count came up short. That is different from ONE
     * workspace dying mid-walk (which `failed.length` covers, and which is a
     * different failure with a different fix) and different again from a run-level
     * arithmetic mismatch. A workspace with no count at all cannot be "short", so
     * it is excluded from the ratio rather than counted as a pass.
     *
     * `endedOnTerminalCursor` is the OTHER half of `suspected_truncation`: every
     * walk reported a genuine end of feed — a cursor field that was present and
     * null (`'complete'`), or was missing entirely (`'cursor_missing'`) — rather
     * than a failed page, a stuck cursor or a page cap. It reads `walkStopReason`,
     * NOT `stopReason`: the shortfall logic rewrites `stopReason` to
     * `'expected_total'`, so by this point `stopReason` says "short" on every row
     * and cannot distinguish "the feed ended" from "this walk broke". "Everyone
     * said there was no more, and there demonstrably was more" is a specific and
     * very diagnosable failure, and it deserves its own `stopReason` rather than
     * being filed under the generic `expected_total`. */
    const comparableRows = workspaces.filter((row) => Number.isFinite(row.expected) && row.expected > 0);
    const shortRows = comparableRows.filter((row) => row.totalSeen < row.expected);
    const everyWorkspaceShort = comparableRows.length > 0 && shortRows.length === comparableRows.length;
    const endedOnTerminalCursor = workspaces.length > 0
      && workspaces.every((row) => row.walkStopReason === 'complete' || row.walkStopReason === 'cursor_missing');
    const anyCursorMissing = workspaces.some((row) => row.walkStopReason === 'cursor_missing');
    /* True when every short row's gap is small enough to be the filter
     * accounting. Published so the UI can hedge ("trashed/disliked clips, or
     * truncation") instead of asserting a cause the data cannot support. */
    const shortfallLikelyFilters = everyWorkspaceShort && shortRows.every((row) => row.shortfallLikelyFilters === true);
    const totalsMet = expectedTotal > 0 ? examined >= expectedTotal : true;
    /* The run-level clause is now UNCONDITIONAL: `!totalsMet` fails the run even
     * when `oracleApplied` is false. The filter caveat survives in `advisory` and
     * in `shortfallLikelyFilters` instead of in the verdict. */
    const oracleBlocksCompletion = !totalsMet;
    const completed = everyWorkspaceCompleted
      && everyDislikedCompleted
      && !oracleBlocksCompletion
      && projectList.complete
      && !signal.aborted;

    let stopReason = 'complete';
    let error = null;
    const failed = workspaces.filter((row) => !row.completed);
    const failedDisliked = dislikedWorkspaces.filter((row) => !row.completed);
    if (!completed) {
      /* A cancellation is checked FIRST, and it always wins: a cancel that also
       * broke the project-list walk must not be reported as a library fault,
       * because "you cancelled this" and "your index is short" are different
       * sentences with different remedies. */
      if (signal.aborted) {
        stopReason = 'aborted';
        error = 'cancelled by the user';
      } else if (everyWorkspaceShort && endedOnTerminalCursor) {
        /* THE TRUNCATION SHAPE. Checked BEFORE `failed.length` on purpose: every
         * short workspace now carries `stopReason:'expected_total'` (that is how a
         * shortfall became fatal at all), so reading the first failed row here
         * would flatten this back into the generic `expected_total` and lose the
         * only information that points at the cause. */
        stopReason = 'suspected_truncation';
        const cursorMiss = anyCursorMissing
          ? ` ${shortRows.length} workspace(s) also reported a missing cursor field, so the feed shape itself is not understood.`
          : '';
        error = `every workspace ended on the feed's own end-of-feed signal and every one of them is `
          + `short of its clip_count: ${examined} of ${expectedTotal} clips examined across `
          + `${comparableRows.length} comparable workspace(s). That is the signature of a TRUNCATED `
          + `feed, not of a smaller library.${cursorMiss} Run PROBE_FEED to see the real page size and `
          + `cursor field, then try a lower feedPageLimit (currently ${feedLimit}) and sync again.`;
        /* Persisted at `error` level unless the gap is small enough to be the
         * filter accounting: an error you cannot see is the defect that just
         * shipped, and a truncation verdict that only exists in memory is how the
         * reported symptom stayed invisible. A small, filter-shaped gap is
         * `warn`, because that one is expected on a default-mode sync and an
         * `error` line for it every run would train everyone to ignore them. */
        log(shortfallLikelyFilters ? 'warn' : 'error', 'sync.suspected_truncation', {
          examined,
          expectedTotal,
          workspaces: comparableRows.length,
          shortfallLikelyFilters,
          feedPageLimit: feedLimit,
        });
      } else if (anyCursorMissing) {
        /* The parser found no cursor field at all. Not "the library ended" — the
         * walk stopped where it could not read the next page. */
        const missed = workspaces.find((row) => row.walkStopReason === 'cursor_missing');
        stopReason = 'cursor_missing';
        error = `workspace ${missed ? missed.projectId : '(unknown)'} stopped: the feed response carried no `
          + 'cursor field this client recognises, so the walk could not be continued and the library '
          + 'cannot be proven indexed. Run PROBE_FEED to see what the envelope actually calls it';
      } else if (failed.length) {
        stopReason = failed[0].stopReason || 'page_failed';
        error = `workspace ${failed[0].projectId} (${failed[0].name}) stopped: ${failed[0].stopReason}`
          + (failed[0].error ? ` — ${failed[0].error}` : '');
      } else if (!projectList.complete) {
        /* A DIFFERENT `expected_total` THAN THE CLIP ORACLE'S, and it is NOT
         * affected by the walk's filters: `/api/project/me` is asked with
         * `show_trashed:'false'` too, but its `num_total_results` is the number of
         * PROJECTS that same walk was paged against, so the two are comparable and
         * a short project list genuinely does mean unseen libraries. It stays
         * fatal. */
        stopReason = 'expected_total';
        error = `the project list is incomplete (${projectList.stopReason}): `
          + `${plan.length} of `
          + `${projectList.expectedProjects === null ? 'an unknown number of' : projectList.expectedProjects} `
          + 'projects are known, so the whole library cannot be proven indexed';
      } else if (oracleBlocksCompletion) {
        stopReason = 'expected_total';
        error = `the crawl examined ${examined} clips of an expected ${expectedTotal}`
          + (shortfallLikelyFilters
            ? '. This may be trashed or disliked clips the walk\'s filters hide, or a truncated feed — '
              + `try a lower feedPageLimit (currently ${feedLimit}) and sync again`
            : '. That is far larger than the trashed/disliked rows these filters hide — run PROBE_FEED '
              + 'and sync again');
      } else if (!everyDislikedCompleted) {
        stopReason = 'expected_total';
        error = 'the disliked-set walk did not finish, so the library is not fully indexed';
      } else {
        stopReason = failedDisliked.length ? (failedDisliked[0].stopReason || 'page_failed') : 'page_failed';
        error = 'the crawl did not reach a clean end';
      }
    }

    if (buffering && completed && !overflowed) {
      const rows = await SunoAPIClient.hydrate(buffered, { membershipsAll, addedAtMs, signal });
      const result = await DB.clips.bulkReplace(Array.from(rows.values()));
      added = result.written;
      log('info', 'sync.bulk_replaced', result);
      cursor.buffered = buffered.length;
      buffered.length = 0;
    } else if (buffering) {
      // Incomplete or overflowed: additive writes only. The previous library is
      // left intact and the UI is told the result is incomplete.
      cursor.buffered = buffered.length;
      if (buffered.length) {
        const rows = await SunoAPIClient.hydrate(buffered, { membershipsAll, addedAtMs, signal });
        added += await putAdditive(Array.from(rows.values()), 'truncated-fallback');
      }
      buffering = false;
    }

    /* WHY NOT `idle`: `idle` is what the popup renders as "Up to date", and the
     * exact failure this crawl was rebuilt for was a walk that died on page 20,
     * set `lastError`, and still reported `idle`. A crawl that reached the end of
     * its loop and still fell short is a different thing from a crawl that broke,
     * and both are different from a clean one:
     *
     *   'idle'       -> completed:true. Everything the server said it had.
     *   'incomplete' -> the run reached its verdict and the library on disk is
     *                   short of the oracle: a workspace failed, a walk stopped
     *                   early, or the totals did not add up. NOT "Up to date".
     *   'error'      -> the run itself broke before it could reach a verdict.
     *   'cancelled'  -> the user asked it to stop.
     *
     * `truncated` stays `!completed` (the client's own definition, and the
     * compatibility flag every surface already reads). `lastError` is CLEARED at
     * exactly one place — here, where the verdict is known — and never on a page
     * that happened to succeed. */
    cursor.completed = completed;
    cursor.truncated = !completed;
    cursor.stopReason = stopReason;
    cursor.lastError = completed ? null : (error || firstError || 'the library is incomplete');
    cursor.state = signal.aborted ? 'cancelled' : (completed ? 'idle' : 'incomplete');
    /* The stop intent is CLEARED at the verdict, here and at the two failure
     * verdicts below. `cancelSync` writes `cancelRequested:true` onto this row
     * and nothing else ever cleared it, and `DB.syncState.set` MERGES — so a row
     * that had once been cancelled carried the flag into every later run, and
     * `SYNC_STATUS.cancelling` (which reads it) reported "Stopping" for a crawl
     * the user had never asked to stop. The same three lines also reset the
     * eviction bookkeeping, so a healed row cannot be mistaken for a fresh one
     * by the reconciliation in §13c. */
    cursor.cancelRequested = false;
    cursor.cancelRequestedAt = null;
    cursor.interrupted = false;
    cursor.interruptedAfterCancel = false;
    /* `missing` IS `expectedTotal - examined`, always, from the same `examined`
     * the oracle compares. It is written even when `oracleApplied` is false — the
     * arithmetic is still the best estimate available, and `oracleApplied` is what
     * tells a reader it is a lower bound rather than a checked shortfall — and it
     * is written even when it is `0`, because `0` is a real answer that must not
     * be re-derived from a differently-defined `totalSeen`. */
    cursor.missing = Math.max(0, expectedTotal - examined);
    cursor.examined = examined;
    cursor.totalSeen = uniqueSeenTotal();
    cursor.uniqueSeen = cursor.totalSeen;
    cursor.oracleApplied = oracleApplied;
    cursor.oracleAdvisory = oracleAdvisory;
    /* The truncation verdict, published as DATA as well as being worded in
     * `error`. `shortfallLikelyFilters` is what lets a UI say "this may be
     * trashed/disliked clips, or truncation — try a lower page limit" instead of
     * asserting a cause it cannot support; `everyWorkspaceShort` and
     * `endedOnTerminalCursor` are the two facts the run-level verdict was derived
     * from, kept so a reader can re-derive it rather than trust the wording. */
    cursor.shortfallLikelyFilters = shortfallLikelyFilters;
    cursor.everyWorkspaceShort = everyWorkspaceShort;
    cursor.endedOnTerminalCursor = endedOnTerminalCursor;
    /* THE FULL-PAGE SIGNAL, aggregated over the run. `pagesFull` counts pages that
     * came back with exactly the `limit` asked for; `lastPageFull` says whether the
     * final page was one of them. A run that ENDS ON A FULL PAGE has been told by
     * the server that there is no more, while having just been handed a page it
     * could not empty — which is the shape of the reported bug. It is published
     * and NEVER acted on: the server's own cursor is the authority on where the
     * library ends, and overriding it with a heuristic is how a build ends up
     * looping on a library that is genuinely finished. */
    cursor.pagesFull = workspaces.reduce((sum, row) => sum + (Number.isFinite(row.pagesFull) ? row.pagesFull : 0), 0);
    cursor.lastPageSize = workspaces.reduce(
      (max, row) => (Number.isFinite(row.lastPageSize) ? Math.max(max, row.lastPageSize) : max),
      0
    );
    cursor.lastPageFull = workspaces.length > 0 && workspaces.every((row) => row.lastPageFull === true);
    cursor.anyWorkspaceEndedFull = workspaces.some((row) => row.lastPageFull === true);
    cursor.feedPageLimit = feedLimit;
    cursor.nextProjectIndex = nextProjectIndex;
    cursor.workspaces = workspaces.slice();
    cursor.dislikedWorkspaces = dislikedWorkspaces.slice();
    cursor.projectsDone = projectsDone.slice();
    cursor.finishedAt = Date.now();
    cursor.durationMs = cursor.finishedAt - startedAt;
    cursor.overflowed = overflowed;
    await DB.syncState.set('feed', cursor);

    const total = await DB.clips.count();
    await DB.journal.append({
      batchId: 'sync',
      phase: signal.aborted ? 'cancelled' : (completed ? 'done' : 'incomplete'),
      detail: {
        pagesDone: cursor.pagesDone,
        seen: cursor.totalSeen,
        examined,
        expectedTotal,
        missing: cursor.missing,
        oracleApplied,
        shortfallLikelyFilters,
        stopReason,
      },
    });

    await broadcast({
      type: 'SYNC_DONE',
      total,
      projects: plan.length,
      durationMs: cursor.durationMs,
      /* The whole contract, built by the one builder every reply uses — so this
       * payload, the abort path below, both `SYNC_ERROR` paths, `GET_BOOT.sync`
       * and `SYNC_STATUS` cannot drift apart in their key set or in what a name
       * means. `completed` is authoritative and `truncated` is derived from it. */
      ...syncContractView(cursor),
      projectList: cursor.projectList,
      projectFeed: cursor.projectFeed,
      dislikedCount: cursor.dislikedCount,
      dislikedApproximate: cursor.dislikedApproximate === true,
    });

    log('info', 'sync.finished', {
      pagesDone: cursor.pagesDone,
      seen: cursor.totalSeen,
      examined,
      total,
      expectedTotal,
      missing: cursor.missing,
      oracleApplied,
      completed,
      stopReason,
      overflowed,
      workspaces: workspaces.length,
    });
  } catch (err) {
    const info = describeError(err);
    /* The completeness contract is written on the failure path too, because
     * `SYNC_ERROR` is the reply a UI gets when the crawl broke and it must not be
     * the one reply that cannot say how much of the library is present. Both this
     * path and the one in `startSync` go through `syncContractView`, so neither
     * can be the reply that forgot `truncated` or `state`. */
    const missingNow = Math.max(0, expectedTotal - examined);
    if (isAbortLike(err)) {
      cursor.completed = false;
      cursor.truncated = true;
      cursor.stopReason = syncWatchdogFired ? 'watchdog_timeout' : 'aborted';
      cursor.state = 'cancelled';
      cursor.lastError = syncWatchdogFired ? 'cancelled by the watchdog' : 'cancelled by the user';
      // The stop has now TAKEN EFFECT, so the intent is spent — see the note on
      // the same three lines at the normal verdict.
      cursor.cancelRequested = false;
      cursor.cancelRequestedAt = null;
      cursor.interrupted = false;
      cursor.interruptedAfterCancel = false;
      cursor.missing = missingNow;
      cursor.examined = examined;
      cursor.totalSeen = uniqueSeenTotal();
      cursor.uniqueSeen = cursor.totalSeen;
      cursor.oracleApplied = oracleApplied;
      cursor.oracleAdvisory = oracleAdvisory;
      cursor.workspaces = workspaces.slice();
      cursor.dislikedWorkspaces = dislikedWorkspaces.slice();
      cursor.projectsDone = projectsDone.slice();
      cursor.finishedAt = Date.now();
      cursor.durationMs = cursor.finishedAt - startedAt;
      await DB.syncState.set('feed', cursor);
      /* An abort is still a `SYNC_DONE`: the reply that reaches a UI when the user
       * pressed cancel has to say the same things every other reply says. It used
       * to omit `projectList`/`projectFeed`/`dislikedCount`/`dislikedApproximate`
       * and `uniqueSeen`/`examined`/`oracleApplied`, so the surfaces that render
       * the cancellation lost the project list they were already holding and had
       * to re-derive a `missing` from mismatched numbers. */
      await broadcast({
        type: 'SYNC_DONE',
        total: await DB.clips.count(),
        projects: plan.length,
        durationMs: cursor.durationMs,
        ...syncContractView(cursor),
        projectList: cursor.projectList,
        projectFeed: cursor.projectFeed,
        dislikedCount: cursor.dislikedCount,
        dislikedApproximate: cursor.dislikedApproximate === true,
      });
      return;
    }
    cursor.completed = false;
    cursor.truncated = true;
    cursor.stopReason = 'page_failed';
    cursor.state = 'error';
    // As at the normal verdict: the run is over, so the stop intent and the
    // eviction bookkeeping are cleared with it.
    cursor.cancelRequested = false;
    cursor.cancelRequestedAt = null;
    cursor.interrupted = false;
    cursor.interruptedAfterCancel = false;
    cursor.missing = missingNow;
    cursor.examined = examined;
    cursor.totalSeen = uniqueSeenTotal();
    cursor.uniqueSeen = cursor.totalSeen;
    cursor.oracleApplied = oracleApplied;
    cursor.oracleAdvisory = oracleAdvisory;
    /* The failing error is ADDED to whatever the walk had already learned; it
     * never replaces a workspace's own reason and it is never dropped. */
    cursor.lastError = cursor.lastError ? `${cursor.lastError}; then: ${info.message}` : info.message;
    cursor.workspaces = workspaces.slice();
    cursor.dislikedWorkspaces = dislikedWorkspaces.slice();
    await DB.syncState.set('feed', cursor);
    await DB.journal.append({ batchId: 'sync', phase: 'error', detail: { code: info.code } });
    log('error', 'sync.failed', { error: info });
    /* `error` IS `cursor.lastError` — the ACCUMULATED message, which carries every
     * earlier failure of this run before this one. Broadcasting `info.message`
     * instead published the TAIL of the failure list: the run died on page 3 of
     * workspace 12 after three workspaces had already failed, and the reply named
     * only the last of them, so the one line the user reads was the least useful
     * one. The accumulated string is built one line above and persisted, so it is
     * the same text `GET_BOOT.sync` will show afterwards. */
    await broadcast({
      type: 'SYNC_ERROR',
      ...syncContractView(cursor),
      projectList: cursor.projectList,
      projectFeed: cursor.projectFeed,
      dislikedCount: cursor.dislikedCount,
      dislikedApproximate: cursor.dislikedApproximate === true,
    });
  } finally {
    clearWatchdog();
    syncController = null;
    // Cleared here, not at abort time: until the crawl has actually unwound the
    // run is still real, and a press in that window must still be answered with
    // `abortAvailable:true` rather than as a no-op.
    syncCancelRequested = false;
    /* The run record goes LAST, and only here. Every terminal path above has
     * already written the verdict to the cursor and broadcast it, so by the time
     * this runs there is a durable row saying the run is over — and clearing the
     * record is what stops the NEXT wake from reconciling a run that finished
     * normally. It is awaited rather than `void`ed for the same reason the
     * cursor write above is: a wake that beat this line would find a live record
     * with no controller and declare a completed run evicted. */
    await clearSyncRun();
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
 * How long a crawl may go without committing a page before it is presumed dead.
 *
 * Generous on purpose: a page can be held for a long rate-limit backoff
 * (`Retry-After`) or one of the feed retries, and calling a live crawl dead
 * would be the same over-confident report as the bugs this fixes. Ninety
 * seconds is far longer than a healthy page takes and far shorter than the
 * "frozen forever" the user was looking at.
 */
const SYNC_STALE_MS = 90000;
/**
 * Hard wall-clock ceiling for an entire crawl. A run that exceeds this is
 * presumed stalled (network hang, evicted worker with no heartbeat), and the
 * watchdog aborts it so the surfaces stop showing a frozen "Syncing".
 * This is a ceiling on the whole run, not on a single page.
 */
const SYNC_WALL_CLOCK_MS = 45 * 60 * 1000;

/**
 * Is the persisted `running` cursor backed by a live crawl?
 *
 * There are two independent sources of truth and they disagree after an
 * eviction: `syncController` is in-memory and dies with the worker, while the
 * cursor row is durable and survives it. Before this existed the UI believed
 * the cursor (so it showed a permanent "Syncing") and the cancel button believed
 * the controller (so it reported "no library sync is running"), and neither could
 * reconcile the two.
 *
 * @param {object|null} cursor the stored `syncState.feed` row
 * @returns {{live:boolean, stale:boolean, heartbeatAt:number, ageMs:number|null,
 *   reason:string|null}}
 */
function syncLiveness(cursor) {
  const row = cursor && typeof cursor === 'object' ? cursor : null;
  const claimsRunning = !!row && row.state === 'running';
  const at = row ? Number(row.heartbeatAt) : NaN;
  const ageMs = Number.isFinite(at) && at > 0 ? Math.max(0, Date.now() - at) : null;
  if (!claimsRunning) {
    return { live: false, stale: false, heartbeatAt: Number.isFinite(at) ? at : 0, ageMs, reason: null };
  }
  // No heartbeat at all means the row predates this field, or the worker died
  // before its first page landed. Either way it cannot be shown as live.
  if (ageMs === null) {
    return { live: false, stale: true, heartbeatAt: 0, ageMs: null, reason: 'the crawl never reported a page' };
  }
  if (ageMs > SYNC_STALE_MS) {
    return {
      live: false,
      stale: true,
      heartbeatAt: at,
      ageMs,
      reason: 'no page was committed for ' + Math.round(ageMs / 1000) + 's, so the crawl is not running any more',
    };
  }
  return { live: true, stale: false, heartbeatAt: at, ageMs, reason: null };
}

/**
 * Turn an orphaned `running` cursor into an honest `interrupted` one.
 *
 * Called from every read of the sync state, so the recovery happens the moment
 * anything looks — no timer, no user action. Idempotent.
 *
 * @param {object|null} row the stored cursor row
 * @param {{live:boolean, stale:boolean, heartbeatAt:number, ageMs:number|null, reason:string|null}} live
 * @returns {Promise<object|null>} the row as it should now be reported
 */
async function reconcileStaleCursor(row, live) {
  if (!live || !live.stale) return row || null;
  const current = row || {};
  if (current.state === 'interrupted') return current;
  log('warn', 'sync.crawl_orphaned', {
    ageMs: live.ageMs,
    heartbeatAt: live.heartbeatAt,
    reason: live.reason,
  });
  const healed = Object.assign({}, current, {
    state: 'interrupted',
    stopReason: 'interrupted',
    // The walk did not finish, and it did not finish because of anything the
    // feed said — it stopped because the worker went away. Saying so is the
    // difference between a user who retries and a user who waits forever.
    error: 'the extension worker was stopped mid-crawl'
      + (live.ageMs !== null ? ' (no page for ' + Math.round(live.ageMs / 1000) + 's)' : '')
      + ' — press Sync to resume; indexed clips are kept',
    completed: false,
    truncated: true,
    heartbeatAt: live.heartbeatAt,
  });
  try {
    await DB.syncState.set('feed', healed);
  } catch (healErr) {
    log('warn', 'sync.heal_failed', { message: describeError(healErr).message });
    return healed;
  }
  return healed;
}

/**
 * Announce which PHASE of the crawl is running, and how far into it we are.
 *
 * WHY THIS EXISTS. `pagesDone` only ever counted `/api/feed/v3` pages, but a sync
 * does three other things first, and on a 5,500-clip library they dominate the
 * wall clock:
 *
 *   planning   page `/api/project/me`            (up to 100 pages)
 *   mapping    page `/api/project/feed`          (~180 pages at 30 rows/page)
 *   crawling   page `/api/feed/v3` per workspace (the only phase that indexes)
 *   committing flush the buffer
 *
 * During planning and mapping ZERO clips are indexed, so the progress line read
 * "starting · clips seen —" with a live-looking bar for minutes, and pressing
 * Stop during it produced "0 clips indexed in 4s" — which reads as a failure when
 * the crawl was in fact working correctly. The phase is what tells the user which
 * of the four things is happening.
 *
 * @param {string} phase
 * @param {{pagesDone?:number, items?:number, joined?:number, maxPages?:number,
 *   note?:string}} [detail]
 * @param {{cursor:object, added:number, projectsDone:number[]}} ctx the run's own
 *   locals. They are passed IN rather than closed over: this function lives at
 *   module scope, and the first version referenced `cursor`/`added`/`projectsDone`
 *   as if they were module bindings. They are not — they are locals of `runSync` —
 *   so every call threw `ReferenceError: cursor is not defined` and the crawl died
 *   before its first request.
 */
async function reportSyncPhase(phase, detail, ctx) {
  const run = ctx || {};
  const cur = run.cursor && typeof run.cursor === 'object' ? run.cursor : null;
  const info = detail || {};
  const addedNow = Number.isFinite(run.added) ? run.added : 0;
  const doneNow = Array.isArray(run.projectsDone) ? run.projectsDone.length : 0;
  if (cur) {
    cur.phase = phase;
    if (info.pagesDone !== undefined) cur.phasePagesDone = info.pagesDone;
    if (info.joined !== undefined) cur.phaseJoined = info.joined;
    if (info.items !== undefined) cur.phaseItems = info.items;
    cur.heartbeatAt = Date.now();
    try {
      await DB.syncState.set('feed', cur);
    } catch (phaseErr) {
      log('warn', 'sync.phase_persist_failed', { phase, message: describeError(phaseErr).message });
    }
  }
  /* The run record is heartbeated here as well as on the cursor row (§13c). The
   * two are not interchangeable: the cursor write is inside `if (cur)`, so a
   * phase reported without a cursor would leave the run record ageing with
   * nothing to show for it, and `syncEvictionVerdict` would call the crawl
   * evicted while it was demonstrably between phases. Cheap, and it makes the
   * phase the thing that keeps a run alive — which is exactly what it is. */
  await writeSyncRun({ phase, heartbeatAt: Date.now() });
   log('info', 'sync.phase', {
     phase,
     pagesDone: Number.isFinite(info.pagesDone) ? info.pagesDone : 0,
     joined: Number.isFinite(info.joined) ? info.joined : 0,
     items: Number.isFinite(info.items) ? info.items : 0,
     note: info.note || null,
   });
   await broadcast({
     type: 'SYNC_PROGRESS',
     phase,
     phasePagesDone: Number.isFinite(info.pagesDone) ? info.pagesDone : 0,
    phaseJoined: Number.isFinite(info.joined) ? info.joined : 0,
    phaseItems: Number.isFinite(info.items) ? info.items : 0,
    note: info.note || null,
    page: cur ? cur.pagesDone : 0,
    pagesDone: cur ? cur.pagesDone : 0,
    seen: cur ? cur.totalSeen : 0,
    added: addedNow,
    etaMs: null,
    state: 'running',
    workspace: null,
    workspacesDone: doneNow,
    total: cur ? cur.expectedTotal : 0,
  });
}

/**
 * Cancel the crawl.
 *
 * The reply is a contract the three UIs read, and it previously carried only
 * `{ok:true}`, so every surface logged `was running: undefined` and none could
 * tell a real cancel from a no-op press:
 *
 *   running         a controller was attached and alive when this was pressed
 *   cancelRequested an abort has actually been signalled
 *   abortAvailable  there is still a controller to signal (false once the run has
 *                   already ended), so a second press can say "already stopping"
 *                   instead of repeating the first press's line
 *
 * Aborting is cooperative: it only takes effect where the crawl awaits. A run
 * parked in a rate-limit backoff or a page retry will not observe it until the
 * current wait ends, so the UIs also need a bounded wait — that is why the
 * reply is honest about what was signalled rather than promising a stop.
 *
 * @returns {Promise<{ok:boolean, running:boolean, cancelRequested:boolean,
 *   abortAvailable:boolean}>}
 */
async function cancelSync() {
  const stored = await DB.syncState.get('feed', null).catch(() => null);
  const live = syncLiveness(stored);

  // An orphaned cursor: the worker that owned the crawl is gone, so there is
  // nothing to abort, but the UI still shows "Syncing" and a Stop button that
  // appeared to do nothing. Clearing the claim is the whole point of the press.
  if (!syncController && stored && stored.state === 'running') {
    const healed = live.stale
      ? await reconcileStaleCursor(stored, live)
      : Object.assign({}, stored, { state: 'cancelled', completed: false, truncated: true, stopReason: 'aborted' });
    if (!live.stale) {
      /* `cancelRequested` is cleared here for the same reason the run verdicts
       * clear it (§13c): this press ENDS the run, so leaving the flag set would
       * make every later `SYNC_STATUS` report a cancellation still in progress.
       * `reconcileStaleCursor` is not given the same treatment in its own body —
       * it may heal a row whose cancel intent the user still expects to be
       * honoured, and the wake-time reconciliation in §13c is what clears it
       * there. */
      healed.cancelRequested = false;
      healed.cancelRequestedAt = null;
      try {
        await DB.syncState.set('feed', healed);
      } catch (markErr) {
        log('warn', 'sync.cancel_mark_failed', { message: describeError(markErr).message });
      }
    }
    /* The run record is dropped on this path too. The press cleared the claim
     * that made the record mean anything, and leaving it behind is what makes the
     * NEXT wake reconcile a run that has been over since this press. */
    await clearSyncRun();
    log('info', 'sync.cancel_orphaned', { stale: live.stale, ageMs: live.ageMs });
    void broadcast({
      type: 'SYNC_CANCELLED',
      state: 'cancelled',
      running: false,
      cancelRequested: false,
      orphanedCursorCleared: true,
      stale: live.stale,
      heartbeatAt: Date.now(),
    });
    // Nothing was running, so `running` is false — but the press DID clear
    // something, which is what the UI needs to hear in order to stop claiming a
    // sync is in flight.
    return {
      ok: true,
      running: false,
      cancelRequested: false,
      abortAvailable: false,
      orphanedCursorCleared: true,
      stale: live.stale,
    };
  }

  if (!syncController) {
    log('info', 'sync.cancel_noop', { storedState: stored && stored.state });
    /* A press with nothing to stop must not leave a run record behind either:
     * §13c's reconciliation reads "a record claiming a crawl with no controller"
     * as an eviction, and a record left by a no-op press would be reconciled as
     * one on the next wake — announcing a run that never existed. */
    await clearSyncRun();
    void broadcast({
      type: 'SYNC_CANCELLED',
      state: 'cancelled',
      running: false,
      cancelRequested: false,
      orphanedCursorCleared: false,
      stale: false,
      heartbeatAt: Date.now(),
    });
    return {
      ok: true,
      running: false,
      cancelRequested: false,
      abortAvailable: false,
      orphanedCursorCleared: false,
      stale: false,
    };
  }
  const alreadyRequested = syncCancelRequested;
  syncController.abort();
  syncCancelRequested = true;
  log('info', 'sync.cancel_requested', { alreadyRequested: alreadyRequested });
  void broadcast({
    type: 'SYNC_CANCEL_REQUESTED',
    state: 'cancelling',
    running: true,
    cancelRequested: true,
    alreadyRequested,
    heartbeatAt: Date.now(),
  });
  // The cursor is the only durable record that survives an evicted worker, so a
  // cancel that lands during a backoff is recorded there too. `state` stays
  // `running` until the crawl actually unwinds, because claiming `cancelled`
  // before it stops would be the same over-confident report as the two bugs
  // this reply exists to fix.
  const cancelRequestedAt = Date.now();
  try {
    await DB.syncState.set('feed', Object.assign({}, (await DB.syncState.get('feed', null)), {
      cancelRequested: true,
      cancelRequestedAt,
    }));
  } catch (markErr) {
    log('warn', 'sync.cancel_mark_failed', { message: markErr && markErr.message ? String(markErr.message) : 'unknown' });
  }
  /* …and the SAME intent goes into the run record (§13c), which is what
   * `syncEvictionVerdict` reads to word a cancellation that was lost with the
   * worker. It is written after the cursor so the cursor stays the primary
   * record and a failure here degrades to the cursor-only path rather than to a
   * run that claims a stop the crawl never saw. */
  await writeSyncRun({ cancelRequested: true, cancelRequestedAt, heartbeatAt: Date.now() });
  return { ok: true, running: true, cancelRequested: true, abortAvailable: true, orphanedCursorCleared: false, stale: false };
}

/* -------------------------------------------------------------------------
 * 13c. THE RUN RECORD — what an EVICTED worker left behind
 *
 * THE BUG THIS EXISTS FOR, in the shape the user saw it: a long library crawl
 * is the single most eviction-prone thing this extension does, because a
 * `chrome.alarms` keepalive at the 30 s floor wakes the worker repeatedly and
 * Chrome is then free to take it away at any `await`. When it does, EVERY
 * module-scope binding is gone: `syncController`, `syncCancelRequested`,
 * `syncWatchdogFired`. What was left in the world was the durable crawl cursor,
 * which says `running`, and nothing that could contradict it. The consequence
 * was a crawl that no surface could ever call finished:
 *
 *   - `SYNC_DONE` / `SYNC_ERROR` / `SYNC_CANCELLED` are emitted FROM MEMORY, so
 *     a worker that dies before it reaches one of them says NOTHING. The popup
 *     kept rendering an indeterminate "Stopping" slider with a live button,
 *     because the last thing it was told was `SYNC_CANCEL_REQUESTED`.
 *   - The stored `cancelRequested` is never cleared once a run ends, so a
 *     single cancel in a browser session made every later `SYNC_STATUS` claim
 *     `cancelling:true` — permanently, for every subsequent run.
 *
 * WHY THIS IS `chrome.storage.session` AND NOT `DB.syncState`, since a crawl
 * cursor is already persisted per page and reusing it would have been the
 * smaller change:
 *
 *   - They answer DIFFERENT questions. The cursor is "how far did the walk get,
 *     and does it satisfy the oracle" — a completeness claim that has to be
 *     written inside a transaction, merged field by field, and is read by every
 *     surface as the verdict. This is "is a crawl in flight right now" — a
 *     liveness fact with a different writer and a different lifetime.
 *   - Their LIFETIMES differ in the direction that matters. The cursor is
 *     disk-resident and outlives a browser restart, so after the browser quits
 *     mid-crawl it still says `running` and the reconciliation below has to
 *     cope with that (it does: the cursor alone is enough to detect the orphan).
 *     A run record belongs to the RUNNING browser: it survives worker eviction
 *     and is cleared on browser close, which is exactly the lifetime of a crawl.
 *   - Writing run state into the cursor row would have made `resumable`
 *     (`runSync`, `stored.state === 'running'`) depend on a field that
 *     reconciliation MUTATES. That predicate is the thing that decides whether
 *     a resume skips workspaces, so it is the last place in this file to invite
 *     a second writer.
 *
 * So: two stores, two questions, one writer each. This is not a third
 * mechanism — `DB.syncState` remains the crawl and `chrome.storage.session`
 * remains the session-scoped state the file already uses for the active-download
 * mirror (`STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS`, `persistActiveDownloads`).
 * ---------------------------------------------------------------------- */

/**
 * Which worker instance is writing. Regenerated on every wake, which is the
 * point: a run record carrying a DIFFERENT epoch was written by a worker that
 * no longer exists, and that is an eviction by definition.
 *
 * This is the one piece of sync state that IS module-scope, and it is
 * deliberately the useless half — a process identity, not a run. Two workers
 * cannot share one (they cannot coexist), and it carries nothing a reader needs
 * to render anything.
 * @type {string}
 */
const SYNC_RUN_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Coerce whatever is in session storage into a run record, or null.
 *
 * Nothing here trusts the stored shape: the record is written on a hot path and
 * read on a cold one, and a half-written or hand-edited record must degrade to
 * "no run" rather than to a claim.
 *
 * @param {unknown} raw
 * @returns {{running:boolean, startedAt:number, cancelRequested:boolean,
 *   cancelRequestedAt:number|null, phase:string|null, heartbeatAt:number,
 *   epoch:string|null}|null}
 */
function coerceSyncRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = Number(raw.startedAt);
  return {
    running: raw.running === true,
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0,
    cancelRequested: raw.cancelRequested === true,
    cancelRequestedAt: Number.isFinite(Number(raw.cancelRequestedAt)) ? Number(raw.cancelRequestedAt) : null,
    phase: typeof raw.phase === 'string' && raw.phase ? raw.phase : null,
    heartbeatAt: Number.isFinite(Number(raw.heartbeatAt)) ? Number(raw.heartbeatAt) : 0,
    epoch: typeof raw.epoch === 'string' && raw.epoch ? raw.epoch : null,
  };
}

/**
 * Read the run record. A missing record means "no run in flight", which is the
 * answer on a fresh install and after a browser restart — both correct.
 * @returns {Promise<ReturnType<typeof coerceSyncRun>|null>}
 */
async function readSyncRun() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.SESSION_SYNC_RUN);
    return coerceSyncRun(stored[STORAGE_KEYS.SESSION_SYNC_RUN]);
  } catch (runReadErr) {
    log('warn', 'sync.run_read_failed', { error: describeError(runReadErr) });
    return null;
  }
}

/**
 * Merge a patch into the run record. `epoch` is stamped on every write and is
 * never taken from the caller, so a record can only ever claim the worker that
 * wrote it.
 *
 * `chrome.storage.session` has no merge primitive, so this is a read-then-write
 * and two of its callers can interleave: the awaited cancel write and the
 * fire-and-forget per-page heartbeat. A lost update here can cost one field —
 * `phase`, or a heartbeat — and the one field that would actually matter
 * (`cancelRequested`) is written to the crawl cursor as well and read from BOTH
 * by `cancelRequestedWording`, precisely so this race cannot cost the user the
 * distinction between "the crawl broke" and "your Stop never landed".
 *
 * A failed write is logged and NOT retried: the crawl itself does not depend on
 * this record (the cursor still advances and the run still resumes), and the
 * reconciliation below treats a missing record as "no run", which is the honest
 * reading when we cannot prove one.
 *
 * @param {{running?:boolean, startedAt?:number, cancelRequested?:boolean,
 *   cancelRequestedAt?:number|null, phase?:string|null, heartbeatAt?:number}} patch
 * @returns {Promise<void>}
 */
async function writeSyncRun(patch) {
  try {
    const current = (await readSyncRun()) || {
      running: false,
      startedAt: 0,
      cancelRequested: false,
      cancelRequestedAt: null,
      phase: null,
      heartbeatAt: 0,
    };
    const next = Object.assign({}, current, patch || {}, { epoch: SYNC_RUN_EPOCH });
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_SYNC_RUN]: next });
  } catch (runWriteErr) {
    log('warn', 'sync.run_write_failed', { error: describeError(runWriteErr) });
  }
}

/**
 * Forget the run entirely. Called on every terminal path, so its absence is the
 * normal steady state and never means "something went wrong".
 * @returns {Promise<void>}
 */
async function clearSyncRun() {
  try {
    await chrome.storage.session.remove(STORAGE_KEYS.SESSION_SYNC_RUN);
  } catch (runClearErr) {
    log('warn', 'sync.run_clear_failed', { error: describeError(runClearErr) });
  }
}

/**
 * How stale may the run record's own heartbeat be before we believe it?
 *
 * Generous for the same reason `SYNC_STALE_MS` is: a page can be held for a
 * long rate-limit backoff, and calling a live crawl dead is the same
 * over-confident report as the bug being fixed.
 */
const SYNC_RUN_HEARTBEAT_FLOOR_MS = 5000;

/**
 * The stored run and the stored cursor, reduced to the two facts reconciliation
 * needs.
 *
 * THE EVICTION SIGNATURE, stated once so the reconciliation below reads as the
 * rule it is:
 *
 *   persisted "a crawl is in flight"   AND   no `syncController` in THIS worker
 *
 * The first half is only ever written by `startSync`, which also creates the
 * controller, and it is cleared on every terminal path. The second half is true
 * on every worker instance except the one that started the run — and only one
 * worker exists at a time, so a mismatch cannot be a race between two of them.
 * The heartbeat age is checked as well, but only as a floor for the case where
 * the cursor row is the sole evidence (a pre-fix install, or a run started
 * before this record existed): `SYNC_STALE_MS` there is a REASON with a number
 * in it, and this one is only ever a guard against reconciling a run that
 * `startSync` created moments ago in this same worker.
 *
 * @param {object|null} cursor the stored `syncState.feed` row
 * @param {unknown} [runRecord] the stored run record, already read by the caller
 * @returns {{orphaned:boolean, cancelRequested:boolean, ageMs:number|null,
 *   ageSource:string, epochMismatch:boolean, cursorOnly:boolean}}
 */
function syncEvictionVerdict(cursor, runRecord) {
  const row = cursor && typeof cursor === 'object' ? cursor : null;
  const cursorSaysRunning = !!row && row.state === 'running';
  const cursorAt = row ? Number(row.heartbeatAt) : NaN;
  const cursorAgeMs = Number.isFinite(cursorAt) && cursorAt > 0 ? Math.max(0, Date.now() - cursorAt) : null;

  /* The run record is PASSED IN rather than fetched here: reconciliation is the
   * one place that must not re-read and re-race, so the caller reads both
   * records once and judges them from the same snapshot. */
  const run = coerceSyncRun(runRecord);
  const runSaysRunning = !!run && run.running === true;
  const epochMismatch = runSaysRunning && run.epoch !== SYNC_RUN_EPOCH;
  const anyCancelRequested = syncCancelRequested === true
    || (run && run.cancelRequested === true)
    || !!(row && row.cancelRequested === true);

  if (syncController) {
    return {
      orphaned: false,
      cancelRequested: anyCancelRequested,
      ageMs: 0,
      ageSource: 'controller',
      epochMismatch: false,
      cursorOnly: false,
    };
  }
  if (!runSaysRunning && !cursorSaysRunning) {
    return {
      orphaned: false,
      cancelRequested: anyCancelRequested,
      ageMs: cursorAgeMs,
      ageSource: 'none',
      epochMismatch: false,
      cursorOnly: false,
    };
  }

  const ageMs = runSaysRunning && run.heartbeatAt > 0
    ? Math.max(0, Date.now() - run.heartbeatAt)
    : cursorAgeMs;
  /* CURSOR-ONLY: no run record claimed a crawl, so the row is the sole evidence.
   * That is a browser restart (session storage cleared with it), an install from
   * a build that predates the record, or a run whose record write failed. It
   * still means the same thing — nothing owns that row — but it gets the SAME
   * 90-second grace the read paths already give it, because without a record
   * there is nothing to compare an epoch against and we would rather be late
   * than reconcile a crawl that started seconds ago. */
  const cursorOnly = !runSaysRunning;
  const floorMs = cursorOnly ? SYNC_STALE_MS : SYNC_RUN_HEARTBEAT_FLOOR_MS;
  const orphaned = ageMs !== null && ageMs > floorMs;

  return {
    orphaned,
    cancelRequested: anyCancelRequested,
    ageMs,
    ageSource: runSaysRunning ? 'run-record' : 'cursor-row',
    epochMismatch,
    cursorOnly,
  };
}

/**
 * Reconcile a run that an eviction took with it, and tell every surface.
 *
 * WHAT "RECONCILE" MEANS HERE, and it is deliberately the SAME operation the
 * read paths already perform (`reconcileStaleCursor`) plus one push:
 *
 *   1. The cursor row is turned into an honest `interrupted` one by the existing
 *      helper, so `completed:false`, `truncated:true` and a named reason are on
 *      disk before anything is said. Nothing here can produce `completed:true`,
 *      and it never will: an eviction is not evidence of completeness and
 *      `docs/ARCHITECTURE.md:655-657` is explicit that a wrong answer in the
 *      cautious direction is still a wrong answer, which is exactly why this
 *      path is only allowed to say "incomplete".
 *   2. A terminal push goes out. THE PUSH IS THE POINT. The reconciliation
 *      helpers healed the row, but every terminal push in this section is
 *      emitted from memory, so a surface that only LISTENS never learns the run
 *      ended — the popup kept an indeterminate "Stopping" slider and the page
 *      overlay kept a live bar, because the last thing either was told was
 *      `SYNC_CANCEL_REQUESTED`. `SYNC_CANCELLED` is the one push every surface
 *      already treats as terminal-with-no-verdict: it stops the poll, clears the
 *      cancelling flag, and then re-reads the cursor. Carrying no verdict is a
 *      FEATURE here — a push cannot be a second source of truth about
 *      completeness, and the row it re-reads is the one true one.
 *   3. The run record is cleared, which is what makes the whole thing IDEMPOTENT
 *      in the strong sense: after it runs there is no record and the cursor is
 *      no longer `running`, so every later wake sees nothing to reconcile. No
 *      tombstone, no marker, no risk of a duplicate terminal push.
 *
 * The cursor's own `state` is the idempotence guard for the case where the run
 * record is gone but the row is not (`cursorOnly`), and the re-read of the row
 * immediately before healing is the guard against clobbering a crawl that
 * started in this same worker while we were awaiting storage.
 *
 * @param {object|null} cursor the row read by the caller
 * @param {object|null} [run] the run record read by the caller
 * @param {{orphaned:boolean}} verdict `syncEvictionVerdict(cursor, run)`
 * @returns {Promise<boolean>} true when a run was reconciled
 */
async function reconcileSyncRunOnWake(cursor, run, verdict) {
  if (!verdict || !verdict.orphaned) return false;

  /* Re-read before writing. `reconcileStaleCursor` merges, so a row that
   * changed underneath us would come back carrying a live crawl's progress with
   * `state:'interrupted'` written over the top of it. Cheap next to getting it
   * wrong, and it is the only thing standing between this and a crawl that is
   * declared dead while it is still running. */
  const fresh = await DB.syncState.get('feed', null).catch((reReadErr) => {
    log('warn', 'sync.eviction_reread_failed', { error: describeError(reReadErr) });
    return null;
  });
  if (!fresh || fresh.state !== 'running' || syncController) {
    log('debug', 'sync.eviction_skipped', {
      state: fresh ? fresh.state : null,
      hasController: !!syncController,
    });
    /* The record is cleared ONLY when there is genuinely nothing in flight. If a
     * controller appeared while we were awaiting storage, a `SYNC_START` landed
     * on this same worker during bootstrap and the record now belongs to that
     * crawl — clearing it would leave a live run with no run record, which is the
     * cursor-only case this whole section exists to avoid. */
    if (!syncController) await clearSyncRun();
    return false;
  }

  /* THE WORDING IS NOT INVENTED HERE. `reconcileStaleCursor` already owns the
   * sentence, already names the no-page interval, and already picks
   * `stopReason:'interrupted'`; it is the same text the user has now seen and
   * the same one `GET_BOOT` / `SYNC_STATUS` will show afterwards. The one
   * addition is the cancel case, which had no wording at all before: a stop that
   * was asked for and then lost with the worker is neither "the user cancelled"
   * nor "the crawl broke", and reporting it as the latter would send the user
   * off to debug a fault they did not cause. */
  const live = syncLiveness(fresh);
  const afterCancel = cancelRequestedWording(verdict, fresh);
  const noPageFor = verdict.ageMs !== null ? ' (no page for ' + Math.round(verdict.ageMs / 1000) + 's)' : '';
  const healed = Object.assign({}, fresh, {
    state: 'interrupted',
    stopReason: 'interrupted',
    error: afterCancel
      ? 'you asked to stop this crawl, but the extension worker was stopped before the stop '
        + `could take effect${noPageFor} — press Sync to continue; indexed clips are kept`
      : `the extension worker was stopped mid-crawl${noPageFor} — press Sync to continue; indexed clips are kept`,
    completed: false,
    truncated: true,
    /* `cancelRequested` is CLEARED here, not merely left set. It is the flag
     * every surface reads to decide whether to render "Stopping", it is written
     * by `cancelSync` and cleared nowhere else, and `DB.syncState.set` MERGES —
     * so before this, one cancel in a browser session made every later
     * `SYNC_STATUS` report `cancelling:true` for every subsequent run, forever.
     * That is the second half of the stuck "Stopping" button: even after the
     * popup learned the run had ended, the flag it re-read on the next open
     * said a cancellation was still in progress. */
    cancelRequested: false,
    cancelRequestedAt: null,
    interrupted: true,
    interruptedAt: Date.now(),
    interruptedAfterCancel: afterCancel,
    heartbeatAt: live.heartbeatAt,
  });
  try {
    await DB.syncState.set('feed', healed);
  } catch (healErr) {
    log('error', 'sync.eviction_heal_failed', { error: describeError(healErr) });
    // The row stays `running`, so the next read reconciles it again. Do NOT
    // broadcast a terminal push for a run we could not record as finished:
    // telling the surfaces it ended while the cursor still claims otherwise is
    // the disagreement this whole function exists to prevent.
    return false;
  }
  try {
    await DB.journal.append({
      batchId: 'sync',
      phase: 'interrupted',
      detail: {
        stopReason: 'interrupted',
        afterCancel: healed.interruptedAfterCancel === true,
        ageMs: verdict.ageMs,
        ageSource: verdict.ageSource,
        epochMismatch: verdict.epochMismatch === true,
        pagesDone: healed.pagesDone || 0,
        seen: healed.totalSeen || 0,
        expectedTotal: healed.expectedTotal || 0,
      },
    });
  } catch (journalErr) {
    log('warn', 'sync.eviction_journal_failed', { error: describeError(journalErr) });
  }

  await clearSyncRun();
  log('warn', 'sync.evicted_mid_crawl', {
    ageMs: verdict.ageMs,
    ageSource: verdict.ageSource,
    epochMismatch: verdict.epochMismatch === true,
    cursorOnly: verdict.cursorOnly === true,
    afterCancel: healed.interruptedAfterCancel === true,
    pagesDone: healed.pagesDone || 0,
    seen: healed.totalSeen || 0,
    expectedTotal: healed.expectedTotal || 0,
  });

  /* The terminal push. `orphanedCursorCleared:true` is the flag all three
   * surfaces already read to mean "the row claimed a run that nobody owned, and
   * it has been cleared", and `stale:true` is the same fact the read paths
   * report. No contract rides on it: each surface stops polling and re-reads the
   * cursor it just healed. */
  await broadcast({
    type: 'SYNC_CANCELLED',
    state: 'interrupted',
    running: false,
    cancelRequested: false,
    orphanedCursorCleared: true,
    stale: true,
    interrupted: true,
    afterCancel: healed.interruptedAfterCancel === true,
    heartbeatAt: Date.now(),
  });
  return true;
}

/**
 * Did the run we are about to declare evicted have a cancel the user asked for?
 *
 * Read from BOTH records because neither is complete on its own: the run record
 * is the one written by THIS build, the cursor carries the same flag for the
 * window where the record write failed or the run predates the record, and
 * `writeSyncRun` is a read-then-write that a per-page heartbeat can interleave
 * with — so either source alone can lose the flag and neither may be trusted
 * alone.
 *
 * @param {{cancelRequested:boolean}} verdict
 * @param {object|null} cursor
 * @returns {boolean}
 */
function cancelRequestedWording(verdict, cursor) {
  if (verdict && verdict.cancelRequested === true) return true;
  return !!(cursor && cursor.cancelRequested === true);
}

/**
 * The wake-time reconciliation, called once from `bootstrap()`.
 *
 * It is deliberately separate from `reconcileStaleCursor`, which heals a row on
 * READ. That is enough for a surface that polls — the panel polls `SYNC_STATUS`
 * on every open — and not enough for a surface that LISTENS: the push types are
 * only ever emitted from memory, so a worker that died before reaching one of
 * them tells nobody. Running this at wake means the terminal push is emitted
 * whether or not anybody ever asks again.
 *
 * NEVER THROWS, and never blocks the rest of bootstrap: it runs after the
 * database is open and its failures are logged, because a failed reconciliation
 * must degrade to "the next read reconciles it" and not to a worker that cannot
 * start.
 *
 * @returns {Promise<{reconciled:boolean, verdict:object|null}>}
 */
async function reconcileSyncRunOnBootstrap() {
  let cursor = null;
  let run = null;
  let verdict = null;
  try {
    // Read the run record and the cursor CONCURRENTLY, then judge them together.
    const read = await Promise.all([readSyncRun(), DB.syncState.get('feed', null)]);
    run = read[0];
    cursor = read[1];
    verdict = syncEvictionVerdict(cursor, run);
    if (!verdict.orphaned) {
      log('debug', 'sync.wake_no_orphan', {
        runRecord: run ? 'present' : 'absent',
        cursorState: cursor ? cursor.state : null,
        ageSource: verdict.ageSource,
        hasController: !!syncController,
      });
      /* Nothing in flight, so a leftover record that claims otherwise is stale
       * and is cleared — leaving one behind is how the NEXT wake reconciles a run
       * that has been over for hours.
       *
       * …but NOT when a controller exists. `bootstrap` yields at every `await`
       * above this point, so a `SYNC_START` can land on this worker while it is
       * still starting; that crawl's controller and record are both live and both
       * belong to it. Clearing the record there would strip a running crawl of
       * the one durable liveness record it has, which is the same defect this
       * section fixes, reached from the other direction. */
      if (!syncController && run && (run.running === true || run.cancelRequested === true)) {
        await clearSyncRun();
      }
      return { reconciled: false, verdict };
    }
    const reconciled = await reconcileSyncRunOnWake(cursor, run, verdict);
    return { reconciled, verdict };
  } catch (wakeErr) {
    log('error', 'sync.wake_reconcile_failed', { error: describeError(wakeErr) });
    return { reconciled: false, verdict };
  }
}

/**
 * The library-crawl health line for `GET_DIAGNOSTICS`, in the shape
 * `MISSING_LIBS` / `MISSING_PARTS` already established: a short list of plain
 * sentences saying what is wrong, empty when nothing is.
 *
 * WHY IT IS NOT A COUNTER OR A LIST OF EVENTS. Those two live in the ring buffer
 * and in the `sync` journal, and both are answers to "what happened". This is the
 * answer to "is the crawl in a state a person needs to act on", which is what a
 * diagnostics panel exists to say, and it has to survive the worker: the
 * symptom this whole section exists for was an in-memory fact that vanished at
 * exactly the moment it became interesting. So it is derived from the durable
 * cursor row every time, and it is a CURRENT-STATE line rather than a history.
 *
 * Never throws — a health line that cannot be computed is a health line that says
 * nothing, and this route must always answer.
 *
 * @returns {Promise<string[]>} empty when the crawl needs nothing
 */
async function syncHealthLines() {
  try {
    const row = await DB.syncState.get('feed', null);
    if (!row || typeof row !== 'object') return [];
    const lines = [];
    if (row.interrupted === true) {
      lines.push(row.interruptedAfterCancel === true
        ? 'library/background.js: a Stop was requested and the extension worker was evicted before it could take '
          + 'effect — the crawl was recorded as interrupted, and the library on disk is INCOMPLETE'
        : 'library/background.js: the extension worker was evicted mid-crawl — the crawl was recorded as '
          + 'interrupted, and the library on disk is INCOMPLETE');
    }
    if (row.state === 'running') {
      /* A row claiming `running` that the reconciliation did NOT touch is the one
       * state that needs a person: either a crawl really is in flight, or the
       * cursor-only grace window is still open. Either way a diagnostics panel
       * should be able to say so out loud. */
      lines.push('library/background.js: the crawl cursor still claims `running`; if no progress is arriving, this '
        + 'is an orphaned cursor and a Stop press will clear it');
    }
    if (row.cancelRequested === true && row.state === 'running') {
      lines.push('library/background.js: a Stop is still outstanding for the last crawl');
    }
    if (row.completed === true && row.truncated === true) {
      /* Structural, not reachable by this build's writers — `truncated` is derived
       * as `!completed` in `syncContractView` — and reported rather than ignored
       * because `docs/ARCHITECTURE.md:655-657` says a disagreement between those
       * two IS the wrong answer, in whichever direction it points. */
      lines.push('library/background.js: the last crawl row is self-contradictory (completed with truncated set); '
        + 'the completeness contract is broken and no verdict from it can be trusted');
    }
    return lines;
  } catch (healthErr) {
    log('warn', 'sync.health_read_failed', { error: describeError(healthErr) });
    return [];
  }
}

/* -------------------------------------------------------------------------
 * 13b. THE FEED PROBE — one real page, reported as a SHAPE
 *
 * It exists because two load-bearing facts about `/api/feed/v3` are UNVERIFIED
 * against a live response, and a crawl that gets either wrong is silently
 * truncated:
 *
 *   H-A  WHAT A PAGE ACTUALLY HOLDS. 100 is the shipped client's documented
 *        maximum plus two third-party extensions' claim. If the server caps at
 *        20, every "full page" inference and every page-count estimate in this
 *        build is wrong by 5x.
 *   H-B  WHAT THE CURSOR FIELD IS CALLED. The bundle says `next_cursor`; a
 *        bundle is not a response. Before `readNextCursor` learned to tolerate
 *        eight spellings and to distinguish "absent" from "null", a differently
 *        named cursor made page 1 look like the end of the library — which is
 *        the reported symptom exactly (a crawl that stops at 10-20% and says
 *        COMPLETE).
 *
 * One request answers both, and the answer is a handful of key names, `typeof`s
 * and counts.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: return any clip content. No titles, prompts,
 * lyrics, tags, descriptions or media URLs, and no token of any kind. A reply
 * that leaked one row of a user's library into a diagnostics panel would be a far
 * worse bug than the one this probes. Everything below is derived from KEY NAMES,
 * TYPES, COUNTS, and a 12-character prefix of a cursor.
 * ---------------------------------------------------------------------- */

/** How much of a cursor value the probe may echo. 12 characters is enough to tell
 *  two opaque tokens apart and far too little to be one. */
const PROBE_CURSOR_SAMPLE_CHARS = 12;

/** Per-clip scalar fields worth reporting, because they identify WHICH generation
 *  of the API answered without being user content. */
const PROBE_CLIP_SCALARS = Object.freeze(['major_model_version', 'is_liked', 'is_trashed']);

/**
 * The last probe's reply, in memory.
 *
 * IN MEMORY ON PURPOSE. It is a measurement, not state: nothing reads it to decide
 * anything, it carries no clip content, and persisting it would mean a shape
 * reading outliving the build that produced it. It is here so `GET_DIAGNOSTICS` can
 * report the measurement after the fact without the caller having to keep the
 * `PROBE_FEED` reply. A worker eviction drops it, which is the correct lifetime for
 * "what did the last request look like".
 * @type {object|null}
 */
let lastFeedProbe = null;

/**
 * The filter object the probe sends, mirroring `SunoAPI#iterateFeed`'s own
 * construction exactly.
 *
 * WHY THE MIRROR IS NOT OPTIONAL: a probe that sends different filters measures a
 * different request, and a different request can come back with a different page
 * size or a different envelope. `iterateFeed` builds this from
 * `getWorkspaceDefaultClipBrowserFilters` overlaid on the base filter, pruning
 * anything left at its default; reproducing that here — with this comment naming
 * it as the thing to keep in step — costs four lines instead of a silent
 * divergence.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeTrashed=false]
 * @param {'Any'|'True'|'False'} [opts.dislikedWire='False']
 * @param {string|null} [opts.workspaceId] omit the key entirely for a whole-library
 *   probe, matching `scope:'all'` in the walk
 * @returns {Record<string, unknown>} the `filters` body field
 */
function feedProbeFilters(opts = {}) {
  const includeTrashed = opts.includeTrashed === true;
  const dislikedWire = opts.dislikedWire === 'Any' || opts.dislikedWire === 'True' || opts.dislikedWire === 'False'
    ? opts.dislikedWire
    : 'False';
  const filters = {
    trashed: includeTrashed ? 'Any' : 'False',
    disliked: dislikedWire,
    fromStudioProject: { presence: 'False' },
    stem: { presence: 'False' },
    stemComplement: 'False',
    sort: { sortBy: 'created_at', sortDirection: 'desc' },
  };
  if (opts.workspaceId !== null && opts.workspaceId !== undefined) {
    filters.workspace = { presence: 'Only', workspaceId: String(opts.workspaceId) };
  }
  return filters;
}

/**
 * How many clips a feed page carried, WITHOUT reading a single one of them.
 *
 * @param {unknown} data the parsed envelope
 * @returns {number} the length of whichever list field the envelope uses; 0 when
 *   the envelope carries no recognisable list, which is itself the answer
 */
function countFeedClips(data) {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== 'object') return 0;
  const body = /** @type {Record<string, any>} */ (data);
  for (const key of ['clips', 'songs', 'items', 'results']) {
    if (Array.isArray(body[key])) return body[key].length;
  }
  return 0;
}

/**
 * The FIRST clip of a page, for shape purposes only: the caller extracts key names
 * from it and nothing else. `items` entries are unwrapped the way the walk unwraps
 * them, because a wrapper row has none of the keys a reader is looking for.
 *
 * @param {unknown} data
 * @returns {Record<string, unknown>|null}
 */
function firstFeedClip(data) {
  const list = Array.isArray(data)
    ? data
    : (data && typeof data === 'object'
      ? (() => {
        const body = /** @type {Record<string, any>} */ (data);
        for (const key of ['clips', 'songs', 'items', 'results']) {
          if (Array.isArray(body[key])) return body[key];
        }
        return null;
      })()
      : null);
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (entry.clip && typeof entry.clip === 'object') return /** @type {Record<string, unknown>} */ (entry.clip);
      return /** @type {Record<string, unknown>} */ (entry);
    }
  }
  return null;
}

/**
 * `{key, type}` for every top-level field of the envelope.
 *
 * KEY NAMES ONLY. A top-level value could be anything — including a clip list, a
 * prompt, a signed URL — so each value is reduced to `typeof` before it leaves this
 * function. This is the check that answers "is the clips array even called
 * `clips`?", which is the same class of assumption the cursor reader got wrong.
 *
 * @param {unknown} data
 * @returns {Array<{key:string, type:string}>}
 */
function describeEnvelopeKeys(data) {
  if (data === null || data === undefined || typeof data !== 'object') return [];
  const body = /** @type {Record<string, any>} */ (data);
  const out = [];
  for (const key of Object.keys(body)) {
    let type;
    try {
      type = Array.isArray(body[key]) ? 'array' : typeof body[key];
    } catch (keyErr) {
      // A throwing getter must not take the probe down; the field is reported as
      // unreadable, which is itself the diagnosis.
      log('warn', 'probe.envelope_key_unreadable', { key, error: describeError(keyErr) });
      type = 'unreadable';
    }
    out.push({ key, type });
  }
  return out;
}

/**
 * A per-name census of every cursor spelling: present? what type? how long? and a
 * 12-character prefix for a string.
 *
 * EVERY NAME IS CHECKED INDEPENDENTLY, which is the whole point. The walk stops at
 * the FIRST usable alias, so a reply describing only the winner cannot answer "was
 * there another field that also carried a cursor?" — and a `next_cursor:null`
 * sitting beside a live `continuation` is precisely the case where that question
 * decides whether the library really ended. A 12-character prefix identifies which
 * token is in play and cannot be replayed as one.
 *
 * @param {unknown} data
 * @param {ReadonlyArray<string>} names the spellings, in probe order
 * @returns {Record<string, {present:boolean, type:string|null, length:number|null,
 *   sample:string|null}>}
 */
function describeCursorFields(data, names) {
  const out = {};
  const body = data && typeof data === 'object' ? /** @type {Record<string, any>} */ (data) : null;
  for (const name of Array.isArray(names) ? names : []) {
    const present = !!body && Object.prototype.hasOwnProperty.call(body, name);
    const value = present ? body[name] : undefined;
    const type = present ? (Array.isArray(value) ? 'array' : typeof value) : null;
    let length = null;
    let sample = null;
    if (present) {
      if (typeof value === 'string') {
        length = value.length;
        sample = value.slice(0, PROBE_CURSOR_SAMPLE_CHARS);
      } else if (Array.isArray(value)) {
        length = value.length;
      } else if (value && typeof value === 'object') {
        length = Object.keys(value).length;
      }
    }
    out[name] = { present, type, length, sample };
  }
  return out;
}

/**
 * Scalar summaries of the fields that say WHICH generation of the API answered,
 * without being user content.
 *
 * `major_model_version` is a model identifier; booleans and numbers are safe to
 * echo. Nothing else is echoed at all — every other value collapses to its `type`,
 * so this function cannot become the place a title leaks even if the field set
 * changes under it.
 *
 * @param {Record<string, unknown>|null} clip
 * @returns {Record<string, {present:boolean, type:string|null, value:unknown}>}
 */
function describeClipScalars(clip) {
  const out = {};
  for (const key of PROBE_CLIP_SCALARS) {
    const present = !!clip && Object.prototype.hasOwnProperty.call(clip, key);
    const value = present ? clip[key] : undefined;
    let shown = null;
    if (present) {
      if (typeof value === 'boolean' || typeof value === 'number') shown = value;
      else if (key === 'major_model_version' && typeof value === 'string') shown = value.slice(0, 24);
    }
    out[key] = {
      present,
      type: present ? (Array.isArray(value) ? 'array' : typeof value) : null,
      value: shown,
    };
  }
  return out;
}

/**
 * Probe the feed route: ONE request, reported as a SHAPE.
 *
 * WHY IT EXISTS: the terminal signal of a library crawl is unverified. `next_cursor`
 * and a page size of 100 are both read out of a bundle rather than out of a
 * response, and when either is wrong the crawl truncates and reports COMPLETE.
 * This route turns "I think" into a measurement on the user's own account, with no
 * rebuild and no second sync: `{limit:100}` and `{limit:20}` settle H-A directly,
 * and `cursorFields` settles H-B.
 *
 * WHAT IT RETURNS: key names, `typeof`s, counts, a 12-character cursor prefix, and
 * three scalar per-clip flags. NEVER a clip title, prompt, lyric, tag, description
 * or media URL, and never a token — not the bearer this request carried, not a
 * `set-cookie`, not a response header. A caller should read `requested`, `url`,
 * `status` and `clipCount` and believe the rest.
 *
 * UNVERIFIED, BY DESIGN: nothing this reports about the server is a claim this
 * file can make — that is the point of the route. What IS enforced is the shape
 * discipline of the reply itself, which is why every field is built by a pure
 * function over key names, types and counts rather than by filtering a clip.
 *
 * @param {object} [payload]
 * @param {number} [payload.limit] page size to ask for; clamped to
 *   [1, `SunoAPI.LIMITS.feedPageLimit`] and defaulted to `settings.feedPageLimit`,
 *   so a user can compare 100 against 20 without changing a stored setting
 * @param {string} [payload.workspaceId='default'] the workspace to ask about
 * @param {boolean} [payload.includeTrashed=false]
 * @param {string} [payload.dislikedMode] one of the `DISLIKED_FILTER_BY_MODE` keys;
 *   defaults to `'exclude'` so the probe measures the request the default crawl
 *   makes
 * @param {unknown} [payload.cursor] the cursor to ask from; omitted or `null`
 *   means PAGE 1. See the note inside — this is the field that makes the probe able
 *   to see the page that actually failed.
 * @param {'Any'|'True'|'False'} [payload.dislikedWire] the tri-state filter to
 *   send, bypassing `dislikedMode`. It grants no capability `dislikedMode` does not
 *   already grant — it is the same three values under two different names — and it
 *   exists because the automatic probe has to reproduce a walk's filter from a
 *   walk-time value, not from a settings key.
 * @param {chrome.runtime.MessageSender} [sender] accepted for route-signature
 *   uniformity. This probe deliberately reads NO tab state and NO page data: it
 *   talks to the API with the worker's own token, and its safety property is that
 *   it has nothing at all to say about the sender.
 * @returns {Promise<object>} the shape report; `{ok:false, code, error}` on failure
 */
async function probeFeed(payload, sender) {
  void sender;
  const input = payload && typeof payload === 'object' ? payload : {};
  const limits = SunoAPI && SunoAPI.LIMITS ? SunoAPI.LIMITS : null;
  if (!SunoAPIClient || typeof SunoAPIClient.fetchFeedPageRaw !== 'function' || !limits) {
    /* Nothing to measure with. A failure with the same shape discipline rather
     * than a half-filled success, so a caller can branch on `ok` without first
     * checking which fields exist. */
    const noClient = {
      ok: false,
      code: 'no_client',
      error: 'lib/api.js did not register, so there is no client to probe the feed with',
    };
    lastFeedProbe = Object.assign({ at: Date.now() }, noClient);
    return noClient;
  }
  /* `feedPageLimit` is resolved here so the reply reports the SETTING beside the
   * value actually requested, and a caller can tell "asked for 20" from "asked
   * for 20 because the setting is 20". */
  const settingLimit = resolveFeedPageLimit(settingsCache.feedPageLimit, DEFAULT_SETTINGS.feedPageLimit);
  const askedLimit = input.limit === undefined || input.limit === null
    ? settingLimit
    : resolveFeedPageLimit(input.limit, settingLimit);
  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.trim()
    ? input.workspaceId.trim().slice(0, 200)
    : 'default';
  const includeTrashed = input.includeTrashed === true;
  const requestedMode = String(input.dislikedMode || '');
  const mode = Object.prototype.hasOwnProperty.call(DISLIKED_FILTER_BY_MODE, requestedMode)
    ? requestedMode
    : 'exclude';
  const filters = feedProbeFilters({
    includeTrashed,
    dislikedWire: input.dislikedWire === 'Any' || input.dislikedWire === 'True' || input.dislikedWire === 'False'
      ? input.dislikedWire
      : dislikedWireValue(DISLIKED_FILTER_BY_MODE[mode]),
    workspaceId,
  });

  /* WHICH PAGE TO ASK FOR.
   *
   * WHY THIS IS NOT STILL HARD-CODED `null`: `cursor:null` is page 1, and page 1
   * of a feed that paginates at all ALWAYS carries a cursor. So the probe as it
   * stood could not reproduce the failure it exists to diagnose — it measured the
   * one page that demonstrably works. The reported defect (`stopReason:
   * 'cursor_missing'`, the walk stopping on its FINAL page, mid-walk cursors read
   * fine on pages 1-4) is a statement about a page this probe never asked for.
   *
   * The token itself is passed through untouched to `fetchFeedPageRaw`
   * (`opts.cursor`), and is NOT echoed in the reply — see `describeRequestedCursor`.
   */
  const cursor = input.cursor === undefined ? null : input.cursor;

  let raw;
  try {
    raw = await SunoAPIClient.fetchFeedPageRaw({
      cursor,
      limit: askedLimit,
      filters,
      // A probe retries once and no more: if the measurement fails, the answer is
      // "it failed", and hammering a route to produce an error page helps nobody.
      retries: 1,
    });
  } catch (probeErr) {
    /* `fetchFeedPageRaw` never throws for an HTTP or a transport failure, so
     * reaching here means the CLIENT ITSELF failed — a route table without the
     * feed route, or a client shaped unlike this build expects. Logged with
     * context (never swallowed) and returned in the shape every other failure
     * uses. */
    const info = describeError(probeErr);
    log('warn', 'probe.feed_threw', { error: info });
    const failed = { ok: false, code: info.code || 'probe_failed', error: redactText(info.message) };
    lastFeedProbe = Object.assign({ at: Date.now() }, failed);
    return failed;
  }
  return finishFeedProbe(raw, { limits, settingLimit, askedLimit, filters });
}

/**
 * The cursor a probe was aimed at, as a description rather than as the value.
 *
 * WHY THIS EXISTS NOW AND NOT BEFORE: `finishFeedProbe` published
 * `requested: raw.requested` verbatim, which is harmless ONLY while
 * `probeFeed` always sent `cursor:null`. A probe that can be aimed at a real page
 * carries a real token, and `lastFeedProbe` is handed to any diagnostics UI and
 * mirrored into the durable log buffer — so publishing it would have leaked a
 * live pagination token into two places that outlive the worker. Same discipline
 * as `describeCursorFields`: type, length, and 12 characters.
 *
 * @param {unknown} value
 * @returns {{supplied:boolean, type:string|null, length:number|null, sample:string|null}}
 */
function describeRequestedCursor(value) {
  if (value === null || value === undefined) {
    return { supplied: false, type: value === null ? 'null' : null, length: null, sample: null };
  }
  const type = Array.isArray(value) ? 'array' : typeof value;
  let length = null;
  let sample = null;
  if (typeof value === 'string') {
    length = value.length;
    sample = value.slice(0, PROBE_CURSOR_SAMPLE_CHARS);
  } else if (Array.isArray(value)) {
    length = value.length;
  } else if (typeof value === 'object') {
    length = Object.keys(value).length;
  }
  return { supplied: true, type, length, sample };
}

/**
 * Turn one `fetchFeedPageRaw` result into the reply, and cache it for
 * `GET_DIAGNOSTICS`.
 *
 * Split out of `probeFeed` so the reply's SHAPE can be read, and audited, in one
 * place — it is the one function in this build whose entire contract is "contains
 * no clip content", and a single constructor is the only way that is checkable.
 *
 * @param {object} raw the client's raw result
 * @param {{limits:object, settingLimit:number, askedLimit:number, filters:object}} ctx
 * @returns {object} the reply, also stored in `lastFeedProbe`
 */
function finishFeedProbe(raw, ctx) {
  const envelope = raw && raw.data;
  const clip = firstFeedClip(envelope);
  const ok = !!(raw && raw.ok);
  const names = Array.isArray(ctx.limits.feedCursorFields) ? ctx.limits.feedCursorFields : [];
  /* `matchedAlias` comes from the WALK'S OWN READER (`SunoAPI.readCursorField`), so
   * it answers "which spelling would the crawl have followed?" rather than "which
   * spelling did the probe think of first". A second copy of the alias list in the
   * reporter is exactly how the two would drift. */
  const matched = SunoAPI.readCursorField(envelope);
  const reply = {
    ok,
    url: typeof raw.url === 'string' ? raw.url : null,
    method: 'POST',
    status: Number.isFinite(raw.status) ? raw.status : 0,
    /* Which verified host answered. Both base URLs are deployed, and "the primary
     * failed over" is part of any honest account of a probe result. */
    via: typeof raw.via === 'string' ? raw.via : null,
    /* What was asked for, with the cursor DESCRIBED rather than reproduced — see
     * `describeRequestedCursor`. `limit` and `filters` are unchanged and still
     * verbatim; `filters` is a fixed vocabulary this file wrote itself, and the
     * reply already publishes it above as `filters`. */
    requested: raw.requested && typeof raw.requested === 'object'
      ? {
        cursor: describeRequestedCursor(raw.requested.cursor),
        limit: raw.requested.limit,
        filters: raw.requested.filters,
      }
      : null,
    /* The SETTING and the value actually requested, side by side. */
    feedPageLimit: ctx.settingLimit,
    requestedLimit: ctx.askedLimit,
    filters: ctx.filters,
    /* THE ANSWER TO H-A: how many clips came back for the `limit` asked for. A
     * number, never the clips. `clipCount < requestedLimit` on page 1 is the
     * server's real cap. */
    clipCount: countFeedClips(envelope),
    topLevelKeys: describeEnvelopeKeys(envelope),
    /* THE ANSWER TO H-B: every spelling, independently. */
    cursorFields: describeCursorFields(envelope, names),
    matchedAlias: matched.alias,
    cursorState: matched.state,
    cursorAliasesPresent: matched.present,
    /* Key NAMES of one clip — the most diagnostic field in the reply and the
     * cheapest. It shows which generation of the API answered, which is why a walk
     * can fail on a field it ASSUMED rather than on a field that is absent. */
    sampleClipKeys: clip ? Object.keys(clip) : [],
    firstClipCounts: describeClipScalars(clip),
    attempts: Number.isFinite(raw.attempts) ? raw.attempts : 0,
    elapsedMs: Number.isFinite(raw.elapsedMs) ? raw.elapsedMs : 0,
    error: null,
  };
  if (!ok) {
    /* The same discipline on the failure path: the status and the SHAPE are the
     * whole diagnosis of a probe that failed — a 422 body says which body field the
     * server rejected — and neither is clip content. `raw.error` is reduced to its
     * redacted MESSAGE: its `body` is the server's response and its `reason` may
     * quote it, so neither is forwarded. */
    const info = describeError(raw.error);
    reply.code = info.code || 'probe_failed';
    reply.error = redactText(info.message || `the probe request failed with HTTP ${reply.status}`);
    log('info', 'probe.feed_failed', {
      status: reply.status,
      code: reply.code,
      clipCount: reply.clipCount,
      topLevelKeys: reply.topLevelKeys.length,
    });
  } else {
    log('info', 'probe.feed', {
      status: reply.status,
      clipCount: reply.clipCount,
      requestedLimit: reply.requestedLimit,
      /* The H-A finding, in one comparison a reader cannot misread. */
      pageCameBackShort: reply.clipCount < ctx.askedLimit,
      matchedAlias: reply.matchedAlias,
      cursorState: reply.cursorState,
      topLevelKeys: reply.topLevelKeys.length,
    });
  }
  lastFeedProbe = Object.assign({ at: Date.now() }, reply);
  return reply;
}

/* --------------------------------------------------------------------------
 * THE AUTOMATIC CURSOR-LESS PROBE
 *
 * WHY IT EXISTS. A walk that stops on a page carrying no cursor field is stopped
 * by an UNVERIFIED fact — the name of that field — and the user is left holding
 * "it could not read the feed's paging field" with no way to act on it. The
 * measurement that would settle it (`topLevelKeys` / `cursorFields` /
 * `matchedAlias` on that exact page) used to require opening the options page,
 * hitting PROBE_FEED, and hoping page 1 resembled the page that failed — which it
 * does not, since page 1 is the one page that always carries a cursor. So the
 * probe now fires itself, aimed at the cursor the failing request was sent with,
 * and the next occurrence of this bug explains itself without anybody writing
 * code.
 *
 * WHAT IT IS NOT. It does not change a verdict, a stop reason, a count, or a
 * `completed` flag, it does not write to the database or to `syncState`, and it
 * does not touch the cursor reader's alias list. A discovered spelling is
 * RECORDED AS A DIAGNOSTIC and a human adds it to `CURSOR_FIELD_ALIASES` in
 * lib/api.js: a parser that edits its own alias table is not reviewable, and this
 * is a security-adjacent parser over a live authenticated response.
 * ---------------------------------------------------------------------- */

/** The client's own error codes for "this page carried no cursor field". Both
 *  zero-clip and clip-bearing pages qualify; `empty_page_with_cursor` does not
 *  (that one had a readable cursor), and neither does an abort, a page failure or
 *  a page cap — so a cancelled or capped walk never spends a probe. */
const CURSOR_LESS_STOP_CODES = Object.freeze(['cursor_missing', 'empty_page_no_cursor']);

/** Per-run one-shot. Reset by `startSync`; see `AUTO_FEED_PROBE_STATE`. */
const AUTO_FEED_PROBE = { runFired: false, inFlight: false, lastAt: 0 };

/**
 * How long an automatic probe waits before firing again ACROSS runs.
 *
 * The per-run latch stops one crawl from probing sixty times. This stops a user
 * who presses Sync sixty times from doing it — one measurement per ten minutes is
 * enough to catch a shape change, and this is the user's own rate limit on the
 * user's own account.
 */
const AUTO_FEED_PROBE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Fire at most one probe per sync run, aimed at the page the walk could not read.
 *
 * FIRED, NOT AWAITED. The crawl must not wait on a diagnostic request, so this
 * returns immediately and the promise is settled on its own. Everything the probe
 * produces is a log line plus `lastFeedProbe`; nothing here is on the path to a
 * verdict, which is exactly why it is safe to leave unattended.
 *
 * THE THIRD LATCH IS NOT PARANOIA. `runFired` bounds one run, the cooldown bounds
 * repeated runs, and `inFlight` bounds the worker: a long run can reach its
 * first cursor-less page while a previous run's probe is still outstanding, and
 * two measurements of the same envelope is one too many.
 *
 * @param {{workspaceId:string, cursor:unknown, limit:number, includeTrashed:boolean,
 *   dislikedWire:string, stopReason:string|null, endOfFeedEvidence:string|null,
 *   evidence:object|null, signal:AbortSignal|null}} ctx
 * @returns {void}
 */
function maybeAutoProbeFeed(ctx) {
  const at = Date.now();
  if (AUTO_FEED_PROBE.runFired) {
    log('info', 'probe.feed_auto_skipped', { why: 'already_fired_this_run' });
    return;
  }
  if (AUTO_FEED_PROBE.inFlight) {
    log('info', 'probe.feed_auto_skipped', { why: 'one_in_flight' });
    return;
  }
  const sinceLast = at - AUTO_FEED_PROBE.lastAt;
  if (AUTO_FEED_PROBE.lastAt > 0 && sinceLast < AUTO_FEED_PROBE_COOLDOWN_MS) {
    /* A skip is still said out loud: a reader looking for the measurement and
     * finding nothing needs to know it was suppressed on purpose rather than lost. */
    log('warn', 'probe.feed_auto_skipped', {
      why: 'cooldown',
      retryInMs: AUTO_FEED_PROBE_COOLDOWN_MS - sinceLast,
    });
    return;
  }
  AUTO_FEED_PROBE.runFired = true;
  AUTO_FEED_PROBE.inFlight = true;
  AUTO_FEED_PROBE.lastAt = at;
  /* A null cursor here means the walk failed on page 1, which is a real and
   * distinct situation (the envelope is unreadable from the very start) and still
   * worth one measurement. It is flagged below so nobody reads the result as a
   * measurement of the failing page when it is a measurement of page 1. */
  const aimedAtFirstPage = ctx.cursor === null || ctx.cursor === undefined;
  log('error', 'probe.feed_auto_fired', {
    /* WHY `error` AND NOT `info`: `flushDiagnostics` drops everything below
     * `error` unless `settings.debug` is on, so an `info` line here would leave no
     * durable trace of the one event whose whole purpose is to survive until
     * somebody reads it. The run genuinely failed, so the level is honest too. */
    workspaceId: ctx.workspaceId,
    stopReason: ctx.stopReason,
    endOfFeedEvidence: ctx.endOfFeedEvidence,
    aimedAtFirstPage,
    requestedLimit: ctx.limit,
    /* The client's own measurement of the failing page, beside the probe's. This
     * is the pair that settles it: what the walk saw, next to what the probe saw
     * when asked for the same page. */
    walkSawTopLevelKeys: ctx.evidence && Array.isArray(ctx.evidence.topLevelKeys)
      ? ctx.evidence.topLevelKeys
      : null,
    walkSawVia: ctx.evidence && ctx.evidence.via ? ctx.evidence.via : null,
    walkSawSignals: ctx.evidence && ctx.evidence.signals ? ctx.evidence.signals : null,
  });
  void probeFeed({
    cursor: ctx.cursor,
    limit: ctx.limit,
    workspaceId: ctx.workspaceId,
    includeTrashed: ctx.includeTrashed,
    dislikedWire: ctx.dislikedWire,
    /* `probeFeed` takes a sender it deliberately ignores; there is no tab and no
     * page here, which is the whole safety property of that route. */
  }, null).then((reply) => {
    AUTO_FEED_PROBE.inFlight = false;
    /* `finishFeedProbe` has already cached this as `lastFeedProbe` (and logged
     * `probe.feed`); this line exists so the DURABLE buffer carries the finding
     * itself, not only the fact that a probe ran. The whole payload is key names,
     * types, counts and cursor samples — `finishFeedProbe` is the single function
     * that guarantees it contains no clip content. */
    log('error', 'probe.feed_auto_result', {
      ok: reply && reply.ok === true,
      status: reply ? reply.status : 0,
      via: reply ? reply.via : null,
      clipCount: reply ? reply.clipCount : 0,
      requestedLimit: reply ? reply.requestedLimit : null,
      /* THE ANSWER, IF THERE IS ONE. `cursorFields` reports every known spelling
       * independently; a name showing `present:true` with a length beside it is
       * the spelling `CURSOR_FIELD_ALIASES` is missing, and `matchedAlias` is what
       * the walk's own reader would have followed had it been in the list. */
      matchedAlias: reply ? reply.matchedAlias : null,
      cursorState: reply ? reply.cursorState : null,
      cursorFields: reply ? reply.cursorFields : null,
      topLevelKeys: reply ? reply.topLevelKeys : null,
      sampleClipKeys: reply ? reply.sampleClipKeys : null,
      error: reply ? reply.error : null,
    });
  }).catch((probeErr) => {
    AUTO_FEED_PROBE.inFlight = false;
    /* `probeFeed` returns failures rather than throwing, so reaching here means
     * the probe machinery itself broke. Logged, never swallowed. */
    log('error', 'probe.feed_auto_threw', { error: describeError(probeErr) });
  });
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
 *
 * MOVED to `background/parts/15-quota.js`, loaded by `importScripts` near the
 * top of this file. This signpost stays so a reader scanning the numbered
 * sections still finds where quota lives.
 *
 * Extracted first because it is the smallest section with NO load-time
 * dependency on anything defined below it: everything it needs from the
 * monolith (`log`, `OpError`, `describeError`, `classifyAuthFailure`,
 * `STORAGE_KEYS`, `SunoAPIClient`, `SunoAPI`) is referenced at CALL time, so
 * the split cannot trip the hoisting hazard `importScripts` introduces. See
 * the header comment in the part itself.
 * ======================================================================== */

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
      const [storedCursor, dbStats, byState, quotaCached, lastBatch] = await Promise.all([
        DB.syncState.get('feed', null),
        DB.stats(),
        DB.downloads.countByState(),
        readCachedQuota(),
        DB.meta.get(META_KEYS.LAST_BATCH_SUMMARY, null),
      ]);
      /* Same self-healing as `SYNC_STATUS`. Opening the popup after a worker
       * eviction used to show a permanent "Syncing" with a Stop button that
       * reported "no library sync is running" — the durable row claimed a run
       * that the (now absent) controller no longer owned. Reconciling on read
       * means the first paint after an eviction is already truthful. */
      const live = syncLiveness(storedCursor);
      const cursor = live.stale ? await reconcileStaleCursor(storedCursor, live) : storedCursor;
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
          ? Object.assign(
            /* THE COMPLETENESS CONTRACT, from the same builder as `SYNC_DONE`,
             * `SYNC_ERROR` and `SYNC_STATUS`, so the key set and the MEANING of
             * each name are identical on all four:
             *   completed      authoritative; `truncated === !completed`
             *   stopReason     the walk's own vocabulary where it named one, else
             *                  the worker-level reason
             *   error          redacted text; NEVER dropped on the failure path
             *   expectedTotal  sum of every project's `clip_count`
             *   totalSeen      UNIQUE clips indexed (also published as
             *                  `uniqueSeen`)
             *   examined       rows examined, repeats included — what
             *                  `missing` is computed from
             *   missing        expectedTotal - examined, floored at 0.
             *                  AUTHORITATIVE when it is a number, `0` included
             *   oracleApplied  was `missing` CHECKED, or merely reported?
             *   advisory       why it was only reported (never an error)
             *   workspaces     one row per project:
             *                  {projectId,name,completed,pagesDone,totalSeen,
             *                   expected,missing,oracleApplied,advisory,
             *                   stopReason,error}
             * `state` is `idle` ONLY when the crawl completed; `incomplete` means
             * it finished its loop and the library on disk is still short of the
             * oracle; `error` means the run broke; `cancelled` means the user
             * stopped it. A UI must never collapse the last three into
             * "Up to date".
             *
             * `nextPage` IS GONE FROM HERE, and that is the point: it is read by
             * nothing (a cursor walk resumes at workspace granularity), it is
             * explicitly nulled in the stored row because `syncState.set` merges,
             * and publishing `cursor.nextPage || 0` advertised a resume position
             * that could only ever be `0`. `pass` had the same problem and is gone
             * from `SYNC_STATUS.cursor` for the same reason. */
            syncContractView(cursor),
            {
              projects: Array.isArray(cursor.projectIds) ? cursor.projectIds.length : 0,
              projectList: cursor.projectList || null,
              projectFeed: cursor.projectFeed || null,
              dislikedCount: cursor.dislikedCount,
              dislikedApproximate: cursor.dislikedApproximate === true,
              // The pre-contract spelling, kept so a UI that reads `lastError`
              // instead of `error` still gets the accumulated message.
              lastError: cursor.lastError || null,
              durationMs: cursor.durationMs || null,
              /* Liveness, so a surface can tell "in flight" from "orphaned by a
               * worker eviction" without recomputing a timestamp itself.
               * `live.stale` alone was not enough: it is true only inside the
               * 90-second grace the read paths use, so a page opened straight
               * after an eviction saw `interrupted:false` and a `state` of
               * `running` on a row no worker owned. The row's own marker is
               * written by the §13c reconciliation and stays true afterwards,
               * so this survives being read before that reconciliation ran. */
              interrupted: live.stale === true
                || cursor.interrupted === true
                /* …and the same rule `SYNC_STATUS` now applies, stated here too:
                 * a row claiming `running` that THIS worker owns nothing is not a
                 * running crawl, whatever its heartbeat says. A surface that opens
                 * in the cursor-only grace window — before the §13c reconciliation
                 * has run — gets the honest answer immediately instead of a frozen
                 * "Syncing" for another 90 seconds. */
                || (!syncController && cursor.state === 'running'),
              /* The stop intent, published for the same reason — and GATED on the
               * run still being live. The stored flag outlives the run it belonged
               * to by design: `cancelSync` writes it, the run's verdict and the
               * §13c reconciliation clear it, and a row written by a build that
               * predates the clearing keeps it forever. Publishing it ungated
               * meant a popup opened after one cancelled crawl in the session
               * rendered "Stopping" for a crawl nobody had started. The history
               * is not lost by gating it — the row keeps it, `error` says which
               * of the two interruptions happened, and `interruptedAfterCancel`
               * is the machine-readable form of that. */
              cancelRequested: cursor.cancelRequested === true && cursor.state === 'running',
              heartbeatAt: live.heartbeatAt,
            }
          )
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
          missingParts: MISSING_PARTS,
          // Main-world capability, stated as capability rather than as outcome:
          // the content script uses these to drive the page, and a build that
          // cannot inject cannot patch `MediaSource` or read the auth tap.
          mainWorld: {
            ops: MAIN_WORLD_OP_NAMES,
            scripting: !!(chrome.scripting && chrome.scripting.executeScript),
          },
          // The last mint that came back empty, so the "Not signed in" line the
          // user sees is never a dead end. `GET_BOOT` is polled on mount, which
          // makes it the surface most likely to have the answer.
          lastAuthFailure,
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
   *   missingParts:string[],          extracted sections that failed to register
   *                                    (see `MISSING_PARTS`; the load-time sibling
   *                                    of `missingLibs`)
   *   syncHealth:string[],            current-state library-crawl problems, in the
   *                                    same "what is wrong" shape. Durable: read
   *                                    from the crawl cursor, so it survives the
   *                                    worker eviction that used to erase the
   *                                    evidence. Empty when the crawl is fine
   *   rateLimiter:object|null,
   *   mainWorldOps:string[],          the exact ops `RUN_MAIN_WORLD` accepts
   *   feedProbe:object|null,          the last `PROBE_FEED` shape report, so the
   *                                    feed page size and cursor field name can be
   *                                    read here without opening that route.
   *                                    Null until a probe has run; NEVER contains
   *                                    clip content or token material
   *   lastAuthFailure:object|null}>}  the account of the last failed mint, or
   *                                    null when no mint has failed. NEVER
   *                                    contains token material.
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
      missingParts: MISSING_PARTS,
      rateLimiter: SunoAPIClient && SunoAPIClient.rateLimiter
        ? SunoAPIClient.rateLimiter.stats()
        : null,
      /* The feed-shape measurement, so "is the page size really 100?" and "what is
       * the cursor field called?" are answerable from the diagnostics surface
       * rather than only from the console. Cached in memory by `probeFeed`; null
       * means no probe has run in this worker, which is a different statement from
       * "the probe found nothing". */
      feedProbe: lastFeedProbe,
      // The whole point of this pair: "not signed in" must be answerable from
      // one reply. `mainWorldOps` says which probes exist, and
      // `lastAuthFailure` says which one was reached last time and what each
      // step answered — no guessing, and no credential in either.
      mainWorldOps: MAIN_WORLD_OP_NAMES,
      lastAuthFailure,
      /* THE LIBRARY-CRAWL HEALTH LINE, in the same shape as `missingLibs` /
       * `missingParts`: a short, human-readable list of what is wrong, empty when
       * nothing is. Those two are LOAD-time failures — a file that did not
       * register — and this is a RUN-time one, so it is a separate field rather
       * than an addition to either: an eviction is not a broken install and must
       * not read as one.
       *
       * It is derived from the durable cursor row, not from anything in memory,
       * which is the whole point: the signal that matters here is precisely the
       * one that used to die with the worker. `interrupted` is the row marker the
       * §13c reconciliation writes, so it stays true after the push that
       * announced it has been heard by nobody.
       *
       * NO TOKEN MATERIAL, no clip content — a state name, two counts and a
       * reason, all of which are already published on `GET_BOOT.sync`. */
      syncHealth: await syncHealthLines(),
    }),
  },

  /* ---- auth ------------------------------------------------------- */

  /**
   * The one route that injects into a page's MAIN world.
   *
   * UI: called by `content/content.js` (`mainWorldOp()`) for `hls-patch`,
   * `hls-restore` and `probe`, and for `auth-tap` on mount so the tap is in place
   * before the first mint needs it. There is no extension-page UI for this route:
   * an extension page has no `sender.tab`, so it is refused with `no_tab` — which
   * is correct, because the worker drives its own tabs through `injectMainWorldOp`.
   *
   * @param {{op:string, timeoutMs?:number}} [payload] `timeoutMs` is read only
   *   by `clerk-token`, and is coerced and clamped before it reaches the page
   * @param {chrome.runtime.MessageSender} sender
   * @returns {Promise<{ok:true, op:string, result:object}|{ok:false, code:string, error:string}>}
   */
  RUN_MAIN_WORLD: {
    handler: async (payload, sender) => runMainWorldOp(payload || {}, sender),
  },

  /**
   * Hand the worker a JWT the content script's auth tap captured.
   *
   * ONE CALLER: `content/content.js` (§21, on mount) sends
   * `{token, expiresAt: 0}` from an eager `auth-read`, so the worker holds a
   * token BEFORE it needs one instead of minting on the critical path.
   * `expiresAt: 0` means "unknown expiry", which is the truth: the tap has seen
   * a bearer header, not a verified JWT `exp` claim, and `writeSessionToken`
   * re-derives real expiry from the token it stores.
   *
   * REMOVED FROM THIS HANDLER: the `payload.requestId` branch. It called
   * `resolveTokenRelay(...)`, which was DELETED along with the rest of the
   * content-script token relay (`SUNO_TOKEN_REQUEST` / `tokenRelayWaiters`).
   * Leaving it was not merely dead code — `resolveTokenRelay` was not defined
   * ANYWHERE in this file, so ANY caller sending a `requestId` would have hit
   * a `ReferenceError` and the handler would have died BEFORE storing the token
   * or broadcasting anything. The one real caller sends no `requestId`, which is
   * exactly why the latent crash never surfaced as a symptom.
   *
   * @param {{token:string, expiresAt?:number}} payload
   * @returns {Promise<{ok:true, expiresAt:number|null}|{ok:false, error:string, code:string}>}
   */
  SET_TOKEN: {
    handler: async (payload) => {
      const token = typeof payload.token === 'string' ? payload.token : '';
      if (token.length > 20) {
        await writeSessionToken(token, payload.expiresAt);
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
      const stored = await DB.syncState.get('feed', null);
      /* SELF-HEALING. `running` in the row and a live `syncController` are two
       * independent truths, and after a worker eviction they disagree: the row
       * still claims a run, the controller is gone. Reconciling here means the
       * very next poll — and the panel polls on every open — turns the frozen
       * "Syncing" into an honest "interrupted", without waiting for the user to
       * press anything.
       *
       * The wake-time reconciliation in §13c normally gets there first and emits
       * the terminal push; this is the second line of defence for the cases it
       * cannot judge yet (a cursor-only orphan inside the 90-second grace) and
       * for a surface that polls while no wake ever happens. */
      const live = syncLiveness(stored);
      const cursor = live.stale ? await reconcileStaleCursor(stored, live) : stored;
      /* `running` IS THE CONTROLLER, AND NOTHING ELSE. The old expression ORed in
       * `live.live` — "the stored heartbeat is younger than 90 seconds" — and that
       * is precisely the lie this bug was made of: a heartbeat written by a
       * worker that has since been evicted stays fresh for ninety seconds, so
       * every poll in that window was told a crawl was in flight when nothing
       * could cancel it and no page would ever commit. There is exactly one
       * worker at a time, so "no controller" cannot mean "a different worker
       * owns this", and the row's own state is the honest answer either way.
       * This is the fix for the popup that stayed on an indeterminate
       * "Stopping" slider with a live Stop button. */
      const runningNow = !!syncController;
      /* A cancellation is only a cancellation while something is still running
       * to be cancelled. The stored flag outlives the run it belonged to by
       * design — it is written on the press and cleared at the run's verdict and
       * at the wake-time reconciliation — so gating on `runningNow` is belt and
       * braces rather than a substitute for clearing it, and it means a stale
       * row cannot put a surface into "Stopping" on its own. */
      const cancellingNow = runningNow
        && (syncCancelRequested === true || (cursor && cursor.cancelRequested === true));
      /* `nextPage` and `pass` are STRIPPED from the row on the way out by
       * `cursorForWire`: they are page-era fields this crawl never writes
       * (`freshCursor` nulls them only so `syncState.set`'s merge cannot resurrect
       * a legacy value) and neither is read by anything. A `cursor.nextPage` on
       * this reply is a number that cannot mean anything. */
      if (!cursor) {
        /* NO ROW IS NOT A RUN, AND IT IS NOT A FAILED ONE. This is the reply a
         * brand-new install gets — the panel polls `SYNC_STATUS` on every open —
         * so every count and BOTH VERDICT FLAGS are `null`: "not measured" and
         * "no verdict" rather than `0`/`truncated:true`. Emitting
         * `truncated:true` here would satisfy `truncated === !completed` by
         * making every surface paint a fresh install as an incomplete library,
         * which is precisely what the placeholder is there to prevent. Every
         * reader folds `null` into absent (popup/popup.js `pick`,
         * side_panel.js `pick`), so this shape reads as the placeholder it is. */
         return {
           ok: true,
           running: runningNow,
           interrupted: false,
           heartbeatAt: 0,
           cancelRequested: cancellingNow,
           cancelling: cancellingNow,
           cursor: null,
          completed: null,
           truncated: null,
           stopReason: null,
           error: null,
           expectedTotal: null,
           totalSeen: null,
           uniqueSeen: null,
           examined: null,
           missing: null,
           oracleApplied: null,
           advisory: null,
           workspaces: [],
           state: null,
           pagesDone: 0,
           total: await DB.clips.count(),
         };
      }
      return {
        ok: true,
        running: runningNow,
        interrupted: live.stale === true
          || (cursor && cursor.interrupted === true)
          /* Same rule as `running`, which is the controller and nothing else: a
           * row claiming `running` that this worker owns nothing is orphaned, and
           * saying so immediately is what un-sticks the poll loop. The 90-second
           * grace below is the read-path fallback for a row the wake-time
           * reconciliation has not reached yet. */
          || (!syncController && cursor.state === 'running'),
        heartbeatAt: live.heartbeatAt,
        cancelRequested: cancellingNow,
        cancelling: cancellingNow,
        /* The whole cursor goes back, so `completed` / `truncated` / `stopReason` /
         * `error` / `expectedTotal` / `missing` / `advisory` / `workspaces` are
         * present one level down exactly as `GET_BOOT.sync` presents them flat —
         * `cursorForWire` is what publishes `advisory` there, under the SAME name
         * the flat copy uses, so this claim is now true of every contract key. The
         * contract is also mirrored here at the top level, because this reply is
         * polled by the dock and a poller should not have to know where in the
         * object to look — and it comes from `syncContractView`, so the flat copy
         * and `GET_BOOT.sync` are the same numbers produced by the same code. */
        cursor: cursorForWire(cursor),
        ...syncContractView(cursor),
        total: await DB.clips.count(),
      };
    },
  },

  SYNC_CANCEL: {
    handler: () => cancelSync(),
  },

  /**
   * `PROBE_FEED`: ONE real `POST /api/feed/v3`, reported as a SHAPE.
   *
   * WHY IT IS A ROUTE AND NOT A BUILD FLAG: the two facts a library crawl depends
   * on — the real page size, and the real name of the cursor field — are read out
   * of a shipped bundle and have never been checked against a live response. When
   * either is wrong the crawl truncates and reports COMPLETE, which is the worst
   * failure mode an extension has. This route measures both on the user's own
   * account, on demand, without a rebuild and without a full sync: send
   * `{limit:100}` and then `{limit:20}` and compare `clipCount`, and read
   * `cursorFields` / `matchedAlias` for the field the walk would follow.
   *
   * It REPLACES no clip content and NO token. Every field is a key name, a
   * `typeof`, a count, or a 12-character cursor prefix — see `probeFeed`.
   *
   * ONE REQUEST, no side effects beyond that request: it does not write to the
   * database, does not touch `syncState`, and does not spend download quota.
   *
   * UI: the corresponding control belongs in the OPTIONS surface's diagnostics
   * panel. Nothing in this build sends this message on its own; the result is also
   * readable from `GET_DIAGNOSTICS` as `feedProbe`.
   *
   * @param {{limit?:number, workspaceId?:string, includeTrashed?:boolean,
   *   dislikedMode?:string}} [payload]
   * @param {chrome.runtime.MessageSender} sender
   * @returns {Promise<object>} the shape report, or `{ok:false, code, error}`
   */
  PROBE_FEED: {
    handler: (payload, sender) => probeFeed(payload || {}, sender),
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

  /* THE BOOTSTRAP GATE, AND WHY IT IS HERE RATHER THAN IN EACH HANDLER.
   *
   * The worker can be evicted at any await, and bootstrap runs `void` at module
   * scope, so on a cold wake `routed.run()` could execute while `bootstrap()` was
   * still opening the database. Handlers that touch storage then failed against an
   * unopened DB, and the symptom was indistinguishable from real emptiness: the
   * popup rendered the placeholder triad — "Not signed in", tiles at `—`, and "no
   * local library yet" — for an account with a fully populated index.
   *
   * Two handlers already awaited `ensureBootstrapped()` themselves. Two out of
   * ~28 is not a convention, it is a race with a low sample size, and it fails on
   * exactly the cold wake a user hits after closing the browser overnight.
   *
   * `ensureBootstrapped()` resolves even when bootstrap ITSELF failed — it
   * catches and logs its own failure, and `bootstrap()` returns EARLY if
   * `DB.open()` fails rather than throwing. So this gate guarantees bootstrap has
   * FINISHED, not that the database opened. A genuinely broken DB still surfaces
   * as a handler error, which is correct: that is a real fault worth reporting,
   * unlike a cold wake that merely needed to wait a moment.
   *
   * The cost is one-time. `bootstrapPromise` is memoised, so every message after
   * the first awaits an already-resolved promise — a microtask, not a DB open. The
   * alternative is paying a spurious failure on every cold wake. */
  ensureBootstrapped().then(() => {
    let result;
    try {
      result = routed.run();
    } catch (syncErr) {
      log('error', 'router.handler_threw', { type: message && message.type, error: describeError(syncErr) });
      safeSend(sendResponse, errorReply(syncErr));
      return;
    }

    if (!result || typeof result.then !== 'function') {
      safeSend(sendResponse, result);
      return;
    }

    result.then(
      (reply) => safeSend(sendResponse, reply),
      (err) => {
        log('error', 'router.handler_threw', { type: message && message.type, error: describeError(err) });
        safeSend(sendResponse, errorReply(err));
      }
    );
  });
  /* `true` for every routed message now, including handlers that answer
   * synchronously: the response can no longer arrive in this turn, because the
   * bootstrap gate put a microtask between here and `routed.run()`. Returning
   * `undefined` for those would close the channel before the reply was sent,
   * which is precisely the "message port closed" failure this function exists to
   * avoid. Holding the channel is the safe side of that trade. */
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
  if (MISSING_PARTS.length) {
    log('error', 'bootstrap.missing_parts', { missing: MISSING_PARTS });
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

  /* THE AUTH CACHE, REFILLED BEFORE ANYTHING ASKS FOR A TOKEN (§5). Every
   * module-scope binding died with the previous worker, `authCache` among them,
   * and the first request of this one would otherwise run the whole MAIN-world
   * mint sweep — a scripting injection per Suno tab and up to 12 s of waiting —
   * for a token that has been sitting in `chrome.storage.session` the whole time.
   * It is a cache refill, not a credential fetch: nothing is persisted here, and
   * a missing or stale record is logged and left for `getAuthToken` to handle.
   *
   * Placed BEFORE the database work deliberately. The database calls are where a
   * wake spends its time, and the whole point is that the first API request of
   * this worker does not have to wait for all of it. */
  try {
    const warm = await warmAuthCacheOnWake();
    log('debug', 'bootstrap.auth_cache', { warmed: warm.warmed, expiresAt: warm.expiresAt });
  } catch (authWarmErr) {
    log('warn', 'bootstrap.auth_cache_failed', { error: describeError(authWarmErr) });
  }

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

  /* THE EVICTION RECONCILIATION (§13c), AND IT REPLACES THE LOG-ONLY BLOCK THAT
   * USED TO BE HERE.
   *
   * That block logged `sync.interrupted_state_noted` and stopped, which was
   * enough for a DIAGNOSIS and nothing else: every terminal push in the sync
   * section is emitted from memory, so a worker that died before reaching one
   * told no surface anything, and the page overlay plus the popup stayed on a
   * live progress bar with a Stop button until somebody polled. This now heals
   * the row and emits the terminal push at wake, so a surface that only listens
   * un-sticks without anyone asking.
   *
   * Ordered AFTER the batch resume on purpose. Both reconcile "the previous
   * worker left something running", and if `reconcileDownloadsOnStartup` or the
   * batch resume is slow this runs late rather than never — while running it
   * BEFORE the batch resume would have it racing `runBatch` for the database and
   * broadcasting a terminal sync push while a download was starting.
   *
   * Never throws: `reconcileSyncRunOnBootstrap` catches and logs its own
   * failures, because a failed reconciliation has to degrade to "the next read
   * reconciles it" and not to a worker that cannot finish starting. */
  try {
    const wake = await reconcileSyncRunOnBootstrap();
    log('info', 'bootstrap.sync_wake', {
      reconciled: wake.reconciled,
      orphaned: wake.verdict ? wake.verdict.orphaned === true : false,
      ageSource: wake.verdict ? wake.verdict.ageSource : null,
      epochMismatch: wake.verdict ? wake.verdict.epochMismatch === true : false,
      cursorOnly: wake.verdict ? wake.verdict.cursorOnly === true : false,
      afterCancel: wake.verdict ? wake.verdict.cancelRequested === true : false,
    });
  } catch (wakeErr) {
    log('error', 'bootstrap.sync_wake_failed', { error: describeError(wakeErr) });
  }

  /* Whatever the reconciliation did not consume, this is the record of what the
   * previous worker left, for the diagnostics route and for the log line below.
   * Read AFTER the reconciliation on purpose: it is the post-reconciliation
   * cursor, so `interrupted` here means what it says.
   *
   * STILL DELIBERATELY NOT AUTO-RESUMED, exactly as before: a crawl can be
   * hundreds of requests and silently restarting one on every worker wake would
   * hammer the API. `SYNC_START` with `force:false` picks up from the stored
   * cursor, at workspace granularity. What this block does instead of nothing is
   * stop the surfaces believing the run is still in flight. */
  let syncWakeState = null;
  try {
    const cursor = await DB.syncState.get('feed', null);
    if (cursor) {
      /* `nextPage` is gone: `/api/feed/v3` pages by cursor, so what an evicted
       * worker leaves behind is a PROJECT PLAN plus the list of workspaces it
       * finished, not a page ordinal. */
      log('info', 'sync.wake_state', {
        state: cursor.state || null,
        interrupted: cursor.interrupted === true,
        projects: Array.isArray(cursor.projectIds) ? cursor.projectIds.length : 0,
        projectsDone: Array.isArray(cursor.projectsDone) ? cursor.projectsDone.length : 0,
        nextProjectIndex: cursor.nextProjectIndex || 0,
        pagesDone: cursor.pagesDone || 0,
        expectedTotal: cursor.expectedTotal || 0,
      });
      syncWakeState = {
        state: typeof cursor.state === 'string' ? cursor.state : null,
        interrupted: cursor.interrupted === true,
        interruptedAfterCancel: cursor.interruptedAfterCancel === true,
        pagesDone: Number.isFinite(cursor.pagesDone) ? cursor.pagesDone : 0,
        totalSeen: Number.isFinite(cursor.totalSeen) ? cursor.totalSeen : 0,
        expectedTotal: Number.isFinite(cursor.expectedTotal) ? cursor.expectedTotal : 0,
        stopReason: typeof cursor.stopReason === 'string' ? cursor.stopReason : null,
      };
    }
  } catch (cursorErr) {
    log('warn', 'bootstrap.cursor_read_failed', { error: describeError(cursorErr) });
  }

  log('info', 'bootstrap.ready', {
    missingLibs: MISSING_LIBS,
    missingParts: MISSING_PARTS,
    filter: FILTER_AVAILABLE,
    tagger: TAGGER_AVAILABLE,
    syncWake: syncWakeState,
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