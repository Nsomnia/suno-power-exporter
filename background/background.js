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
  './parts/04-settings.js',
  './parts/06-messaging.js',
  './parts/07-offscreen.js',
  './parts/08-filenames.js',
  './parts/09-save.js',
  './parts/10-ladder.js',
  './parts/11-tagging.js',
  './parts/12-batch.js',
  './parts/13-sync.js',
  './parts/14-query.js',
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
if (!globalThis.SMUFilenames || typeof globalThis.SMUFilenames.buildDownloadPath !== 'function') {
  MISSING_PARTS.push('background/parts/08-filenames.js (buildDownloadPath)');
}
if (!globalThis.SMUQuery || typeof globalThis.SMUQuery.queryClips !== 'function') {
  MISSING_PARTS.push('background/parts/14-query.js (queryClips)');
}
if (!globalThis.SMUQuota || typeof globalThis.SMUQuota.quotaView !== 'function') {
  MISSING_PARTS.push('background/parts/15-quota.js (quotaView)');
}
if (!globalThis.SMUSettings || typeof globalThis.SMUSettings.loadSettings !== 'function') {
  MISSING_PARTS.push('background/parts/04-settings.js (loadSettings)');
}
if (!globalThis.SMUOffscreen || typeof globalThis.SMUOffscreen.callOffscreen !== 'function') {
  MISSING_PARTS.push('background/parts/07-offscreen.js (callOffscreen)');
}
if (!globalThis.SMUSave || typeof globalThis.SMUSave.saveBytes !== 'function') {
  MISSING_PARTS.push('background/parts/09-save.js (saveBytes)');
}
if (!globalThis.SMULadder || typeof globalThis.SMULadder.runLadder !== 'function') {
  MISSING_PARTS.push('background/parts/10-ladder.js (runLadder)');
}
if (!globalThis.SMUBatch || typeof globalThis.SMUBatch.runBatch !== 'function') {
  MISSING_PARTS.push('background/parts/12-batch.js (runBatch)');
}
if (!globalThis.SMUSync || typeof globalThis.SMUSync.runSync !== 'function') {
  MISSING_PARTS.push('background/parts/13-sync.js (runSync)');
}
if (!globalThis.SMUTagging || typeof globalThis.SMUTagging.applyTagsAndSidecars !== 'function') {
  MISSING_PARTS.push('background/parts/11-tagging.js (applyTagsAndSidecars)');
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
  /* THE MEMBERSHIP CACHE — the `clip id -> [project ids]` join (plus
   * `added_at_ms`) from the last walk of `/api/project/feed` that reached the
   * feed's own end (a full walk, or an incremental one whose prefix was
   * all-known). On a 6,000-clip library that walk is ~200 requests — the
   * single most expensive phase of a sync — so the map is persisted and
   * refreshed INCREMENTALLY: new clips surface at the top of the feed, so the
   * next walk stops once it has re-seen enough all-known pages. A FORCED
   * re-sync never reads it and a walk that did not reach the end never
   * overwrites it. Clip ids and project ids only; no clip content. */
  FEED_MEMBERSHIPS: 'feed.memberships',
  LAST_BATCH_SUMMARY: 'batch.lastSummary',
});

const ALARMS = Object.freeze({
  KEEPALIVE: 'suno.batch.keepalive',
  QUOTA: 'suno.quota.refresh',
  SYNC: 'suno.sync.autosync',
  /* Run-scoped keepalive for a library crawl. Unlike the batch keepalive it is
   * armed when a sync STARTS and cleared when the run ends, because its one
   * job is to keep the worker alive across the long `await`s a crawl spends
   * inside a single feed page — the eviction that produced "the extension
   * worker was stopped mid-crawl (no page for 93s)". See `armSyncRunKeepalive`.
   */
  SYNC_RUN: 'suno.sync.runkeepalive',
});

/**
 * `chrome.alarms` minimum period. 0.5 min is the documented floor and it is the
 * only thing that reliably wakes an evicted worker mid-batch.
 */
const KEEPALIVE_PERIOD_MINUTES = 0.5;

/**
 * How many consecutive ALL-KNOWN pages the incremental membership walk must
 * re-see before it stops and lets the cache cover the rest of the feed.
 *
 * WHY MORE THAN ONE: the project feed's ordering is UNVERIFIED (recency is the
 * conventional shape and new clips were observed at the top, but nothing in the
 * contract says so), so a single all-known page could be a gap in any ordering.
 * Three consecutive full pages of already-mapped ids is strong evidence the
 * changed prefix has been walked, and the cost of being wrong is bounded: the
 * gate that CONSUMES this walk (`runSync`'s workspace skip) demands the
 * project's own `clip_count` and `last_updated_clip` be unchanged too, and a
 * forced re-sync re-walks everything regardless.
 */
const MEMBERSHIP_CACHE_PREFIX_PAGES = 3;

/**
 * The `stopReason` the MEMBERSHIP phase publishes when ITS OWN page budget ends
 * the walk — deliberately NOT `'max_pages'`.
 *
 * WHY IT NEEDS ITS OWN NAME. `max_pages` belongs to the FEED phase: it means
 * "`iterateFeed` hit the cap the user set, with a cursor still outstanding, so
 * CLIPS ARE MISSING". This walk used to emit the same slug for a completely
 * different fact — "`/api/project/feed` ran out of budget before it reached the
 * end, so the clips it did not reach are indexed but ATTRIBUTED TO NOTHING". A
 * reader given `max_pages` on a `projectFeed` block has to guess which of the
 * two happened, and the two need opposite advice: one is fixed by raising a
 * setting, the other by nothing at all.
 *
 * IT IS NOT A RUN-LEVEL `stopReason`. It appears only under
 * `cursor.projectFeed.stopReason`, which is a nested diagnostic the surfaces read
 * for membership detail and never as the crawl's verdict — the run verdict is
 * computed from the workspace walks alone. So the three surfaces'
 * `stopReason` maps are untouched by this name, and `scripts/check-build.sh`'s
 * byte-identical-map check over them is unaffected.
 */
const MEMBERSHIP_BUDGET_STOP_REASON = 'membership_budget';

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
/* `DEFAULT_SETTINGS` MOVED to `background/parts/04-settings.js`. Its owner is
 * settings, so it lives with them; every read outside that section was inside
 * a function body (call time), verified mechanically before the move. */


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
/* ==========================================================================
 * 4. SETTINGS  —  MOVED to `background/parts/04-settings.js`
 *
 * Verbatim cut, not a rewrite: the cache, the defaults, coercion, load/save
 * and the write-behind all live there now. `importScripts` above loads it
 * before this body evaluates, and every reference between the two resolves
 * at call time — the one load-time dependency (`DEFAULT_SETTINGS` in the
 * `settingsCache` initializer) moved WITH the section, which is why the part
 * owns the constant.
 * ======================================================================== */

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
 * 7. OFFSCREEN DOCUMENT  —  MOVED to `background/parts/07-offscreen.js`
 *
 * Verbatim cut. A worker has no `URL.createObjectURL` and no Web Audio;
 * the document that supplies both, the protocol around it, and every
 * bytes/transcode helper live in the part now. All monolith references
 * resolve at call time (verified: zero top-level outside reads).
 * ======================================================================== */

/* ==========================================================================
 * 8. FILENAMES
 *
 * MOVED to `background/parts/08-filenames.js`, loaded by `importScripts` near
 * the top of this file. This signpost stays so a reader scanning the numbered
 * sections still finds where filename construction lives.
 *
 * Extracted because it is the last section with NO mutable module-scope state
 * and no section-local constant anyone outside it reads. `buildDownloadPath`
 * is still called from §10 and §10b as a bare global, exactly as it was called
 * when it lived here; see the header of `background/parts/08-filenames.js` for
 * what the part reads from the monolith, and `background/parts/15-quota.js`
 * for why those reads are all at call time.
 * ======================================================================== */

/* ==========================================================================
 * 9. SAVING BYTES  —  MOVED to `background/parts/09-save.js`
 *
 * Verbatim cut. The bytes-vs-URL save choice, the data: URL vs offscreen
 * blob URL decision, the download-settlement waiters, the startup
 * reconciliation of what the browser actually wrote, and the session-
 * backed `activeDownloads` mirror all live in the part. Outside
 * references are call-time only (verified: zero top-level reads).
 * ======================================================================== */

/* ==========================================================================
 * 10. THE DOWNLOAD LADDER  —  MOVED to `background/parts/10-ladder.js`
 *
 * Verbatim cut. The rung evaluator, the per-clip ladder driver, the
 * media-asset fetch rules, the HLS segment capture, and the media-host
 * gate all live in the part now. Outside references are all call-time
 * (verified: zero top-level reads). Shareable constants that are ladder
 * faces by nature moved WITH the section.
 * ======================================================================== */


/* ==========================================================================
 * 11. TAGGING + SIDECARS  —  MOVED to `background/parts/11-tagging.js`
 *
 * Verbatim cut. Cover-art fetch, the bpm/lyrics/tag sidecar writers,
 * and the per-variant embed step all live in the part now; the ladder
 * part calls them at rung time only.
 * ======================================================================== */

/* ==========================================================================
 * 12. BATCH DRIVER  —  MOVED to `background/parts/12-batch.js`
 *
 * Verbatim cut. Plan persistence, leasing, the per-clip download
 * driver, quota preflight/guard, cancellation and resumability all
 * live in the part now; the router and lifecycle call into it at
 * message/alarm time (verified: zero top-level outside reads).
 * ======================================================================== */


/* ==========================================================================
 * 13. LIBRARY SYNC  —  MOVED to `background/parts/13-sync.js`
 *
 * Verbatim cut. The crawl engine, the per-workspace walkers, the
 * contract/verdict builders, the healers, and the alarm-keepalive
 * machinery all live in the part now. Outside references are all
 * call-time (verified: zero top-level outside reads). This part is
 * where the stale-error regression lived; splitting it out means the
 * seam is one file, one place to test, one contract to keep honest.
 * ======================================================================== */


/* ==========================================================================
 * 14. QUERY, SELECTION, PROJECTS
 *
 * MOVED to `background/parts/14-query.js`, loaded by `importScripts` near the
 * top of this file. This signpost stays so a reader scanning the numbered
 * sections still finds where the read side of the library lives.
 *
 * No mutable module-scope state moved with it. §12 still calls
 * `readSelectionIds`, `queryContext` and `loadProjectNames` as bare globals,
 * and §16 still routes `GET_CLIPS` / `GET_FACETS` / `GET_PROJECTS` /
 * `SET_SELECTION` / `GET_SELECTION` to bare globals — every one of those
 * references is inside a function body, so none of them changed timing.
 * ======================================================================== */

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
       * means the first paint after an eviction is already truthful. The run
       * record is read alongside it because it is liveness evidence too (see
       * `syncLiveness`): a poll during a rate-limit backoff must see the
       * alarm's heartbeat, not just the stale page clock. */
      const runRecord = await readSyncRun().catch(() => null);
      const live = syncLiveness(storedCursor, runRecord);
      // `!syncController` is checked HERE as well as inside `reconcileStaleCursor`.
      // Opening the popup is enough to trigger the heal, and this is the read every
      // surface performs first, so the guard that matters most is the one a reader
      // of this line can see: a live controller means the crawl this row describes
      // is still running in THIS worker, and a stale heartbeat during a rate-limit
      // backoff is not evidence otherwise.
      const cursor = live.stale && !syncController
        ? await reconcileStaleCursor(storedCursor, live)
        : storedCursor;
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
       * for a surface that polls while no wake ever happens. The run record is
       * read alongside it — it is liveness evidence too (see `syncLiveness`):
       * this handler runs on every poll, and a poll during a rate-limit
       * backoff must see the alarm's heartbeat before it may call a row stale. */
      const runRecord = await readSyncRun().catch(() => null);
      const live = syncLiveness(stored, runRecord);
      // `!syncController`, the same guard `GET_BOOT` applies and for the same
      // reason: this handler runs on EVERY poll of every open surface, so a poll
      // landing during a rate-limit backoff used to be enough to write
      // `completed:false` and a failure sentence over a crawl that was still
      // running and went on to finish. `reconcileStaleCursor` re-checks this as a
      // precondition of healing, so neither guard is the only thing standing
      // between a slow page and a poisoned row.
      const cursor = live.stale && !syncController
        ? await reconcileStaleCursor(stored, live)
        : stored;
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
 * Arm the run-scoped crawl keepalive.
 *
 * NOT INVARIANT F, DELIBERATELY: that invariant (alarms armed only from
 * onInstalled / onStartup) exists because a module-scope `create` on every
 * wake RESETS the period and keeps a useless alarm alive forever. This one is
 * the opposite shape: armed exactly when a crawl starts and cleared on every
 * terminal path (`runSync`'s finally clears it, and the `onAlarm` handler
 * clears it too when it fires on a worker with no controller), so a forgotten
 * alarm cannot outlive its run by more than one 30 s tick.
 *
 * WHY AN ALARM AND NOT THE PAGE-COMMIT HEARTBEAT: the heartbeat only happens
 * when a page LANDS, and the eviction this exists for happens when one does
 * not — a slow page, a long rate-limit backoff, a retry chain. The alarm is
 * the one event source that fires regardless of the network.
 *
 * @returns {Promise<void>}
 */
async function armSyncRunKeepalive() {
  if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return;
  try {
    await chrome.alarms.create(ALARMS.SYNC_RUN, {
      delayInMinutes: KEEPALIVE_PERIOD_MINUTES,
      periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
    });
    log('debug', 'alarm.sync_run_armed', { period: KEEPALIVE_PERIOD_MINUTES });
  } catch (armErr) {
    log('warn', 'alarm.sync_run_arm_failed', { error: describeError(armErr) });
  }
}

/**
 * Clear the run-scoped crawl keepalive. Called from `runSync`'s finally (every
 * terminal path) and from the alarm's own handler when no crawl owns it.
 * @returns {Promise<void>}
 */
async function disarmSyncRunKeepalive() {
  if (!chrome.alarms || typeof chrome.alarms.clear !== 'function') return;
  try {
    await chrome.alarms.clear(ALARMS.SYNC_RUN);
  } catch (clearErr) {
    log('debug', 'alarm.sync_run_clear_failed', { error: describeError(clearErr) });
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
    return;
  }

  if (alarm.name === ALARMS.SYNC_RUN) {
    if (syncController) {
      /* A crawl is in flight IN THIS WORKER. The alarm firing is itself what
       * resets Chrome's idle timer — that is the whole point of it — and the
       * run-record heartbeat it writes is honest for the same reason the alarm
       * can only fire while a worker is alive: a dead worker runs no handlers,
       * so this beat can never outlive the crawl it vouches for. It is NOT
       * written to the cursor row, whose heartbeat means "a page landed". */
      await writeSyncRun({ heartbeatAt: Date.now() });
    } else {
      /* No controller here: either the run ended and the finally block's clear
       * lost the race with this tick, or the worker was evicted and this wake
       * is the alarm's first firing — in which case bootstrap's §13c
       * reconciliation has already healed the orphaned cursor. Either way the
       * alarm has nothing left to keep alive. */
      await disarmSyncRunKeepalive();
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
   * AUTO-RESUME IS NOW BOUNDED, NOT ABSENT. The original objection — "a crawl
   * can be hundreds of requests and silently restarting one on every worker
   * wake would hammer the API" — is answered by design rather than by refusal:
   * the wake path restarts ONLY a genuinely orphaned run (no controller, run
   * record gone stale — never a stop the user asked for), at most
   * `MAX_SYNC_AUTO_RESUMES` consecutive times, and every restart is journalled
   * and broadcast, so it is not silent. The alternative this replaces was worse
   * on both counts: a manual "press Sync to resume" performed a FULL re-crawl of
   * every finished workspace, because nothing resumed an interrupted row — so
   * the no-auto-resume policy was the single largest source of redundant
   * requests in the whole crawl. */
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