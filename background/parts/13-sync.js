/**
 * 13. LIBRARY SYNC — the resumable crawl, its contract, heal, and keepalive.
 *
 * Extracted verbatim from `background/background.js` section 13. For the
 * mechanism read `background/parts/15-quota.js` first.
 *
 * VERIFIED BY REFERENCE COUNT BEFORE THE CUT, not assumed:
 *   - 53 declarations; the outside reads are all call-time:
 *     `syncController`/`syncCancelRequested` (read by the router's guards),
 *     `startSync`/`cancelSync` (router), `runSync` (lifecycle/alarm wake),
 *     `syncLiveness`+`reconcileStaleCursor` (read paths), `cursorForWire`/
 *     `syncContractView` (reporting surfaces), `readSyncRun`/`writeSyncRun`,
 *     `reconcileSyncRunOnBootstrap`, `syncHealthLines`, `probeFeed`,
 *     `lastFeedProbe`, `MAX_SYNC_AUTO_RESUMES`. A mechanical scan found zero
 *     top-level outside references — the part can load with the rest of the
 *     imports while the monolith body evaluates later.
 *   - The section-internal mutable bindings (syncController,
 *     syncWatchdogTimer, syncWatchdogFired, syncCancelRequested,
 *     lastSyncRunBeat, lastFeedProbe) are section-local in writes.
 *   - Its top-level is declaration-only (a scan for column-0 non-declaration
 *     statements returned none), so no read of a monolith or sibling binding
 *     can fire at load time.
 *
 * This is the seam class the stale-error bug lived in — one file, one intent,
 * one place to test.
 */

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
 * - EVERY project from `/api/project/me` is CONSIDERED on every run, `default`
 *   included. A `workspace:'default'` walk alone reached 3,444 of ~5,500 clips
 *   on the recon account and reported success, because the clips in every
 *   other project were never requested. Two things may now SHORT-CIRCUIT a
 *   workspace without walking its pages, and both carry their own proof:
 *   a workspace the previous run completed may be served from its stored row
 *   when THIS run's membership walk saw no new clips for it AND the project
 *   row itself is unchanged (the cache-skip gate in `runSync`), and a resumed
 *   run skips workspaces the interrupted run already completed. A FORCED
 *   re-sync does neither: it re-walks every workspace from `cursor:null`,
 *   ignores the membership cache, and rebuilds the index atomically.
 * - `POST /api/feed/v3` pages by CURSOR, and the cursor is written to `syncState`
 *   after EVERY page, so an evicted worker resumes instead of restarting. It
 *   resumes at WORKSPACE granularity: `iterateFeed` accepts no `startCursor`
 *   (it accepts and explicitly ignores `startPage`), so completed workspaces are
 *   skipped entirely and the workspace that was in flight is re-walked from
 *   `cursor:null`. Writes are additive and idempotent by clip id, so that is
 *   safe, just not free.
 * - Each page is committed with `clips.putMany` (ONE transaction per page, never
 *   one per clip), and `project/feed` is walked ONCE per sync rather than once
 *   per hydrating batch — incrementally when the membership cache from a
 *   previous COMPLETE walk is available, in full otherwise.
 * - `clips.clear()` is NEVER called. A forced rebuild buffers and then uses
 *   `clips.bulkReplace`, which is a single atomic transaction, and only when the
 *   crawl COMPLETED — replacing a library with a truncated one would delete the
 *   clips the crawl never reached. An abort leaves the previous library intact.
 * - `maxPages` is honoured and reported. A user with 3,000 clips must not
 *   silently lose 2,000 to a page cap, so truncation is surfaced everywhere.
 *
 * @param {{force?:boolean, dislikedMode?:string, maxPages?:number}} options
 *   `force:true` is the FULL RE-SYNC: it ignores the membership cache, defeats
 *   the workspace cache-skip gate, re-walks every workspace from the first
 *   cursor, and — only if the crawl completes — REPLACES the library in one
 *   atomic `bulkReplace` instead of writing additively. The UI reaches it with
 *   a modifier-click on any Sync button (Shift/Alt/Cmd/Ctrl), the dock also
 *   has its checkbox, and it is the documented escape hatch whenever a cache
 *   is suspected stale.
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
    /* THE PROBE'S PER-RUN LATCH IS RESET HERE, by the run that owns it. The
     * comment on `AUTO_FEED_PROBE` says "reset by startSync" and this is that
     * line — without it the latch survived every run inside one worker
     * lifetime, so only the first sync after a worker wake ever probed. */
    AUTO_FEED_PROBE.runFired = false;
    /* THE RUN-SCOPED KEEPALIVE. A crawl spends most of its wall clock inside
     * `await`s on single feed pages, and an MV3 worker that sees no event for
     * 30 seconds is reclaimable EVEN MID-AWAIT — which is exactly how a slow
     * page produced "the extension worker was stopped mid-crawl (no page for
     * 93s)". An alarm at the 30 s floor fires for as long as this run lives
     * and each firing is an event the idle timer has to respect. Cleared on
     * every terminal path in `runSync`'s finally. */
    void armSyncRunKeepalive();
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
        /* THE SKIP GATE'S THIRD SIGNAL, carried raw: `last_updated_clip` is
         * whatever the account sends (shape unverified — see
         * `lastUpdatedKeyOf`), and a value that changed since the last walk
         * defeats a cache-skip for this project. Dropped values become `null`
         * here so a missing field compares equal to itself run over run. */
        lastUpdatedClip: project.last_updated_clip === undefined ? null : project.last_updated_clip,
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
 * @param {Array<{id:string,name:string,clipCount:number|null,
 *   lastUpdatedClip:unknown}>} projects
 * @returns {Array<{id:string,name:string,clipCount:number|null,
 *   lastUpdatedClip:unknown}>}
 */
function buildWorkspacePlan(projects) {
  const plan = [];
  const seen = new Set();
  for (const project of Array.isArray(projects) ? projects : []) {
    const id = project && project.id !== undefined && project.id !== null ? String(project.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    plan.push({ id, name: (project.name || id), clipCount: project.clipCount, lastUpdatedClip: project.lastUpdatedClip || null });
  }
  if (!seen.has('default')) {
    plan.push({ id: 'default', name: 'My Workspace', clipCount: null, lastUpdatedClip: null });
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
    /* Completion by omission: the walk ended on a page that carried NO cursor
     * field (the server's other end-of-feed spelling). Filled from the client's
     * summary; see the note where it is read. */
    cursorOmitted: false,
    /* THE CACHE-SKIP GATE'S OWN EVIDENCE, written at walk time so a LATER run
     * can tell "this row was walked against the project row I am looking at
     * now" from "the project changed underneath it":
     *   `clipCountAtWalk`  the project's `clip_count` as THIS walk saw it;
     *   `lastUpdatedKey`   the project's `last_updated_clip`, stringified for
     *                      comparison (raw shape unverified; a value that
     *                      stringifies inconsistently fails the gate, which
     *                      costs a re-walk and never correctness).
     * `cached` is set by `runSync` when a later run SKIPS the re-walk on this
     * row's evidence. */
    clipCountAtWalk: null,
    lastUpdatedKey: null,
    cached: false,
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
  /* THE SKIP GATE'S OWN EVIDENCE, stamped at walk time: a later run compares
   * the project row it is looking at against these, and re-walks on any
   * disagreement (see `runSync`'s cache-skip gate). */
  outcome.clipCountAtWalk = Number.isFinite(project.clipCount) ? Math.floor(project.clipCount) : null;
  outcome.lastUpdatedKey = lastUpdatedKeyOf(project.lastUpdatedClip);
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
         * bundle was wrong about the spelling. */
        outcome.cursorAlias = batch.cursorAlias === undefined ? null : batch.cursorAlias;
        /* COMPLETION BY OMISSION, carried off the summary. True when the walk
         * ended on a page that carried no cursor field at all — the server's
         * other end-of-feed spelling, and the one every walk on the recon
         * account ends on. Published on the row so the run-level verdict (and
         * any surface) can tell "the feed said no more, explicitly" from "the
         * feed said no more by saying nothing". */
        outcome.cursorOmitted = batch.cursorOmitted === true;
        outcome.pagesFull = Number.isFinite(batch.pagesFull) ? batch.pagesFull : outcome.pagesFull;
        outcome.lastPageSize = Number.isFinite(batch.lastPageSize) ? batch.lastPageSize : outcome.lastPageSize;
        outcome.lastPageFull = batch.lastPageFull === true;
        /* "The final page had N of 100 clips", carried onto the row so a surface
         * can say that instead of "we do not know". NEVER A VERDICT: the client
         * does not read it, this file does not read it, and the walk that produced
         * it reported `completed:false` on every stop that is not the feed's own
         * terminal signal. It is published so a surface has a fact rather than an
         * absence. */
        outcome.endOfFeedEvidence = typeof batch.endOfFeedEvidence === 'string' ? batch.endOfFeedEvidence : null;
        /* THE AUTOMATIC CURSOR-LESS PROBE — see `maybeAutoProbeFeed`.
         *
         * TWO GATES, because the omission reading moved the question it answers.
         * A walk that STOPS on a cursor-less page is no longer reachable from a
         * healthy feed (an absent cursor completes it now), so the first gate is
         * the defensive remnant: `cursor_missing`/`empty_page_no_cursor` can only
         * arrive from a build that still emits them, and the probe fires exactly
         * as it did before.
         *
         * The second gate is the LIVE one: a walk that COMPLETED BY OMISSION yet
         * came up short of the project's own `clip_count`. Most of those are the
         * trashed/disliked rows a filtered walk cannot see — but the same shape
         * is also what a RENAMED cursor field looks like (mid-walk pages stop
         * advancing, the walk "completes" on page 1, and the shortfall is
         * enormous), and the probe is the one measurement that names the key the
         * envelope actually uses. One probe per run, cooldown-gated, aimed at
         * `stopCursor` — the page the walk ended on, not page 1. */
        const stopCode = batch.error && typeof batch.error.code === 'string' ? batch.error.code : null;
        const shortOfCount = hasExpectedCount
          && Number.isFinite(batch.totalSeen)
          && batch.totalSeen < expected;
        if ((outcome.completed !== true && CURSOR_LESS_STOP_CODES.indexOf(stopCode) >= 0)
          || (outcome.completed === true && outcome.cursorOmitted === true && shortOfCount)) {
          maybeAutoProbeFeed({
            workspaceId: project.id,
            cursor: batch.stopCursor,
            limit,
            includeTrashed: includeTrashed === true,
            dislikedWire: dislikedWireValue(disliked),
            stopReason: batch.stopReason || null,
            endOfFeedEvidence: outcome.endOfFeedEvidence,
            /* The client's own measurement of the page the walk ended on, read
             * straight off the summary (an omission carries it there; the
             * legacy stop codes carry it on the error). */
            evidence: (batch.error && batch.error.evidence) || batch.omissionEvidence || null,
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

  /* A WORKSPACE SHORT OF ITS OWN `clip_count`: MEASURED ALWAYS, FATAL ONLY
   * WHERE THE COMPARISON CAN PROVE ANYTHING.
   *
   * The comparison is made for every workspace that HAS a count, and `missing`
   * is published whenever one exists. What a gap MEANS depends on two facts
   * this row already holds:
   *
   *   1. `oracleFatal` — was this walk UNFILTERED, so `clip_count` measures the
   *      same set the walk did? Then a gap is PROOF the library is short, and
   *      the row fails loudly with `stopReason:'expected_total'`.
   *   2. `walkStopReason === 'complete'` — did the walk end on the feed's OWN
   *      terminal signal (a cursor present-and-null, or end-of-feed by
   *      omission)? A FILTERED walk cannot see trashed or disliked rows, and
   *      nothing in the wire contract says `clip_count` excludes them, so a
   *      walk that the feed itself says is finished is COMPLETE FOR THE
   *      FILTERS IT RAN WITH: the gap is published as a lower bound
   *      (`missing` + `shortfallLikelyFilters` + the advisory sentence) and
   *      does not fail the row. This is the reading the popup's contract
   *      comment already describes ("a shortfall from a filtered walk
   *      reaches us as ADVISORY: completed:true, oracleApplied:false,
   *      missing:100") and the one the "a lower bound, filters applied"
   *      counts-phrase renders; before this, the row-level verdict
   *      contradicted both and every account holding trashed or disliked
   *      clips reported INCOMPLETE on every sync forever.
   *   3. Otherwise — the walk BROKE (a failed page, an aborted run, a page
   *      cap) and is also short — the gap is the least informative fact on the
   *      row, and the walk's own reason leads: `completed:false`,
   *      `stopReason` stays whatever the walk said, and the shortfall wording
   *      is added only where there is no reason yet.
   *
   * `shortfallLikelyFilters` is still computed for every short row (it sizes
   * the gap against `SHORTFALL_FILTER_CAUSE_SHARE`), because the run-level
   * `suspected_truncation` verdict reads it to decide whether an
   * every-workspace-short run is the filter accounting or a truncated feed. */
  const hasCount = Number.isFinite(outcome.expected) && outcome.expected >= 0;
  if (hasCount) {
    const shortBy = Math.max(0, Math.floor(outcome.expected) - outcome.totalSeen);
    outcome.missing = shortBy;
    outcome.shortfallLikelyFilters = shortBy > 0
      && !oracleFatal
      && shortBy <= Math.max(1, Math.floor(Math.floor(outcome.expected) * SHORTFALL_FILTER_CAUSE_SHARE));
    if (shortBy > 0) {
      if (oracleFatal) {
        // Comparable count, unfiltered walk: the gap is real and checked.
        outcome.completed = false;
        if (outcome.stopReason === 'complete' || !outcome.stopReason) outcome.stopReason = 'expected_total';
        outcome.error = outcome.error || (`workspace ${project.id} ended at ${outcome.totalSeen} of `
          + `${outcome.expected} clips on an unfiltered walk, so the shortfall is real: the feed `
          + 'returned fewer rows than the project reports. Run PROBE_FEED to check the feed page '
          + 'size and cursor field, then sync again');
      } else if (outcome.walkStopReason === 'complete') {
        // The feed's own terminal signal + a count this filtered walk cannot be
        // compared against: complete for the filters it ran with, gap published.
        outcome.completed = true;
        outcome.advisory = (outcome.advisory ? outcome.advisory + ' ' : '')
          + `ended at ${outcome.totalSeen} of ${outcome.expected} clips the project reports — the walk `
          + "ran with trashed/disliked filters, so the difference is rows those filters hide (a lower "
          + 'bound), not clips the crawl lost';
      } else {
        // The walk broke AND is short. Its own reason leads; the shortfall only
        // supplies one where the walk did not name a cause.
        outcome.completed = false;
        if (outcome.stopReason === 'complete' || !outcome.stopReason) outcome.stopReason = 'expected_total';
        outcome.error = outcome.error || (outcome.shortfallLikelyFilters
          ? `workspace ${project.id} ended at ${outcome.totalSeen} of ${outcome.expected} clips. This `
            + "small gap may be trashed or disliked clips this walk's filters hide, or a truncated "
            + `feed — try a lower feedPageLimit (currently ${limit}) and sync again`
          : `workspace ${project.id} ended at ${outcome.totalSeen} of ${outcome.expected} clips, and the `
            + `gap is far larger than the trashed/disliked rows these filters hide. Run PROBE_FEED to `
            + 'check the feed page size and cursor field, then sync again');
      }
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
 * A comparable identity for a project's `last_updated_clip` value.
 *
 * WHY A FUNCTION RATHER THAN `String(value)`: the field's shape is UNVERIFIED
 * (scalar on some accounts, object on others, absent on more), and the skip
 * gate compares THIS run's value against the one recorded at the last walk. A
 * JSON stringification is stable for objects with stable key order and for
 * every scalar; a value whose serialization is NOT stable simply never compares
 * equal, which costs a re-walk (speed, never correctness). `null` is the
 * honest spelling of "the account does not send this field" and compares equal
 * only to itself.
 *
 * @param {unknown} value the raw `last_updated_clip` off a project row
 * @returns {string|null}
 */
function lastUpdatedKeyOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) || null;
  } catch (keyErr) {
    return null;
  }
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
  /* TWO RULES, AND THE ORDER THEY ARE APPLIED IN MATTERS.
   *
   * RULE 1 — `lastError` IS THE RUN'S OWN FIELD AND OUTRANKS `error`.
   * `lastError` is written and CLEARED by the run's own verdict
   * (`cursor.lastError = completed ? null : …`), so it is the one error string on
   * this row that belongs to the run being reported. `error` is written by exactly
   * two producers in this file — the orphan healers `reconcileStaleCursor` and
   * `reconcileSyncRunOnWake` — and by nothing that ever clears it. This block used
   * to prefer `error`, so a leftover healer sentence outranked the run's real
   * reason: a run that failed for an ordinary reason would still be shown the old
   * "the extension worker was stopped mid-crawl — press Sync to resume" sentence,
   * which names neither the fault nor the remedy. The `hasOwnProperty` test keeps
   * the legacy fallback honest: a row that predates `lastError` entirely (only
   * `freshCursor` and the verdicts write it) still resolves through `error`, while a
   * modern row's own field wins even when it is `null` — a deliberate "this run
   * recorded no reason" is not permission to resurrect an older run's.
   *
   * RULE 2 — A `completed:true` ROW PUBLISHES NO ERROR AT ALL.
   * Both healers write `error` with `completed:false`, because a healed row IS a
   * failure, so `error` on a completed row can only be a leftover. And they used to
   * heal crawls THIS worker was still running: `syncLiveness` reads "no page
   * committed for 90s" as dead, and `cursor.heartbeatAt` advances only on a page
   * commit or a phase report, so a rate-limit backoff trips the rule while the
   * worker is provably alive and firing its alarm. `DB.syncState.set` MERGES
   * (lib/db.js:2010) and `freshCursor` has no `error` key to null it, so the
   * sentence survived every later run.
   *
   * That is the whole of the reported failure: a crawl that indexed 5,943 clips and
   * finished cleanly — `completed:true`, `stopReason:'complete'`, a real
   * `durationMs` — reported INCOMPLETE forever, because every surface pins its
   * verdict on `completed === true && !f.error` and one stale string beats the
   * flag. This rule is what repairs the rows the current build has ALREADY
   * poisoned: the user's account is in exactly that state, and no re-sync, no
   * storage clear and no code change to the healer can un-poison a stored row that
   * nothing reads correctly.
   *
   * `over.error` is NOT subject to either rule: an override is the live run's own
   * word about the run this reply is describing, and both override call sites (the
   * two `SYNC_ERROR` broadcasts) pass `completed:false` with it. */
  const rowHasLastError = Object.prototype.hasOwnProperty.call(row, 'lastError');
  const errorRaw = has('error')
    ? over.error
    : (completed
      ? null
      : (rowHasLastError ? row.lastError : row.lastError || row.error));
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
     * reported no count to check against. It is the WORDING switch, not the whole
     * verdict: a shortfall fails the run where it can PROVE one (an unfiltered
     * walk, or the every-workspace-short truncation shape — see `runSync`'s
     * verdict block), and `advisory` is the human sentence for the caveat —
     * kept in its own key because `error` is a failure and this is not one. */
    oracleApplied: pick('oracleApplied', false) === true,
    /* HOW MANY WORKSPACES THIS RUN SERVED FROM THE CACHE-SKIP GATE: their last
     * walk completed, their project row is unchanged, and the membership walk
     * saw nothing new. 0 on a forced re-sync and on any run that cannot prove
     * all three. */
    skippedWorkspaces: count('skippedWorkspaces'),
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
    /* `error`, explicitly NULLED for the same reason as the v2 pair above: the
     * orphan healers used to write it and NOTHING ever cleared it — the run's
     * own verdict writes and clears `lastError` only — and because
     * `DB.syncState.set` MERGES, one healer sentence survived every later run
     * and pinned a finished library to INCOMPLETE on all three surfaces. The
     * healers now write `lastError` and `syncContractView` ignores `error` on a
     * completed row, but a fresh run must also WIPE the stale key at source, or
     * the string physically survives in storage forever. */
    error: null,
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
    /* The workspace cache-skip gate's receipt. `cachedSkipped` is the id list
     * (a resumed run re-verifies exactly these) and `skippedWorkspaces` the
     * published count. Reset to empty here because `DB.syncState.set` MERGES —
     * omitting them would hand this run the previous run's skips. */
    cachedSkipped: [],
    skippedWorkspaces: 0,
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
     /* The eviction auto-resume chain's attempt count. A FRESH run resets it to
      * zero here; a RESUMED one keeps the stored value, because
      * `Object.assign({}, freshCursor, stored)` lets stored win on every
      * colliding key — and the count is only meaningful as "how many times has
      * THIS logical crawl been evicted and restarted", which is exactly the
      * per-chain, not per-worker-lifetime, quantity the wake path needs to
      * bound itself against an unbounded restart loop. The wake healer
      * (`reconcileSyncRunOnWake`) increments it before every automatic restart
      * and reads it to decide whether another one is allowed. */
     autoResumeAttempts: 0,
   };

  /* Normalised BEFORE the merge so the row that wins the `Object.assign` below
   * cannot carry a page-era field. `Object.assign({}, freshCursor, stored)` lets
   * STORED win on every colliding key, so `nextPage`/`pass` would otherwise be
   * applied to a cursor walk that has no pages to resume from. The schema check
   * in `resumable` is the primary defence and this is the one that does not
   * depend on a version number being correct. */
  const stored = force ? null : normaliseResumedCursor(await DB.syncState.get('feed', null));
  log('info', 'sync.cursor_loaded', {
    resumed: !!stored && (stored.state === 'running' || stored.state === 'interrupted'),
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
   * `state` is 'running' OR 'interrupted', and nothing else is resumable.
   * 'running' is the one state an EVICTED worker leaves behind, because the
   * last thing such a worker wrote was a page write and a page write always
   * records `running`. 'interrupted' is what BOTH healers
   * (`reconcileStaleCursor`, `reconcileSyncRunOnWake`) write over such a row
   * once a fresh worker has reconciled it — and it is NOT a verdict: the plan,
   * `projectsDone` and every per-page tally on a healed row are exactly as of
   * its last commit, identical in kind to what a 'running' row holds. Refusing
   * to resume it made "press Sync to RESUME" a lie: the predicate fell through,
   * `Object.assign(cursor, freshCursor)` below wiped the plan, and the
   * "resume" re-walked every finished workspace from scratch — a full
   * re-crawl behind a resume promise, which is why retrying after an
   * interruption never converged. A run that reached a REAL verdict —
   * `idle`, `incomplete`, `error`, `cancelled` — is still NOT resumed, and
   * that is deliberate: skipping the workspaces a previous run completed would
   * mean a sync could never see a clip created in one of them, which is the
   * same class of bug as the v2 `nextPage` resume (a fresh sync starting at
   * page 21 of a walk that had already finished) only quieter. */
  const resumable = !!(stored
    && stored.schema === SYNC_CURSOR_SCHEMA
    && (stored.state === 'running' || stored.state === 'interrupted')
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

  /* ---- project/clip membership join: EXACTLY ONCE per sync, CACHED ACROSS
   * syncs and refreshed INCREMENTALLY --------------------------------- */
  /* WHY ONCE PER RUN, AND WHY A FAILED JOIN IS NOT RE-WALKED: `fetchProjectFeed`
   * is a multi-page cursor walk (30 rows per page), so on a 6,000-clip library
   * it is ~200 requests — the single most expensive phase of a sync. `hydrate()`
   * re-runs the WHOLE walk whenever it is handed no memberships, which the
   * previous build did for every one of its batches. So it is called exactly
   * once here and its Map is cached for the run.
   *
   * WHY A CACHE ACROSS RUNS: on a repeat sync almost nothing has changed, and
   * new clips surface at the TOP of the project feed, so the walk only needs to
   * re-verify the changed prefix. The last COMPLETE map is persisted under
   * `META_KEYS.FEED_MEMBERSHIPS`; this run loads it, hands its id set to the
   * walk as `knownIds`, and the walk stops after `MEMBERSHIP_CACHE_PREFIX_PAGES`
   * consecutive all-known pages. A forced re-sync (`force:true`) never reads
   * the cache — "ignore every cache and re-walk everything" is its definition —
   * and a walk that does not reach the feed's own end never OVERWRITES the
   * cache, because `knownIds` may only ever mean "mapped by a walk that saw the
   * whole feed".
   *
   * `newByProject` — what the walk found NEW relative to the cache — is what
   * the workspace skip gate below consumes; it is `null` whenever no cache was
   * loaded, which is also the value that keeps the gate shut. */
  let membershipsAll = new Map();
  let addedAtMs = new Map();
  let projectFeed = null;
  let newByProject = null;
  let mappingOk = false;
  let membershipsCached = false;
  let membershipCacheAt = null;
  if (!force) {
    try {
      const cached = await DB.meta.get(META_KEYS.FEED_MEMBERSHIPS, null);
      if (cached && typeof cached === 'object' && Array.isArray(cached.membershipsAll)) {
        membershipsAll = new Map(cached.membershipsAll);
        addedAtMs = Array.isArray(cached.addedAtMs) ? new Map(cached.addedAtMs) : new Map();
        membershipsCached = membershipsAll.size > 0;
        membershipCacheAt = Number.isFinite(cached.at) ? cached.at : null;
        log('info', 'sync.membership_cache_loaded', { clips: membershipsAll.size, at: membershipCacheAt });
      }
    } catch (cacheReadErr) {
      log('warn', 'sync.membership_cache_read_failed', { error: describeError(cacheReadErr) });
      membershipsAll = new Map();
      addedAtMs = new Map();
      membershipsCached = false;
    }
  }
  /* THE MEMBERSHIP PHASE GETS ITS OWN BUDGET, DERIVED FROM WHAT IT MUST WALK.
   *
   * WHY THIS IS NOT `maxPages`: the run hands ONE user-facing number to two walks
   * whose per-page yields differ by 3.3x, and they spend it independently.
   * `fetchProjectFeed` asks for 30 rows a page (`SunoAPI.LIMITS.projectFeedLimit`)
   * while `iterateFeed` asks for up to 100, so the pages a 6,287-clip library
   * needs are ~210 for this phase and ~63 for the other. A single cap of 200
   * therefore STARVED the membership phase on exactly the account that reports
   * the bug while being wildly generous to the feed phase.
   *
   * WHAT A MEMBERSHIP BUDGET STOP ACTUALLY COSTS — and why it is invisible:
   * this walk is the ONLY writer of the clip -> workspace map on a first sync,
   * and `hydrate()` stamps that map onto every indexed row. A walk stopped at its
   * budget returns a PARTIAL map, so every clip past the cut is indexed with
   * `projectIds: []` — present in the library, attributed to nothing, invisible to
   * every workspace-scoped filter. It also refuses to overwrite the membership
   * cache (a partial map may only ever mean "mapped by a walk that saw the whole
   * feed"), so the NEXT sync pays the same truncated walk again and the deficit
   * is permanent and self-reproducing.
   *
   * WHY IT DOES NOT SHOW UP IN `completed`: the run verdict reads
   * `everyWorkspaceCompleted && everyDislikedCompleted && !oracleBlocksCompletion
   * && projectList.complete && !signal.aborted`, and `mappingOk` is in NONE of
   * them. A membership walk stopped at its budget leaves every WORKSPACE walk
   * untouched, so the run reports `completed:true` over an under-attributed
   * library. `projectFeed.stopReason` / `projectFeed.budgetDerived` below are the
   * only evidence, which is exactly why they are published and why the stop is
   * NAMED: `max_pages` is the feed phase's slug, and reusing it here made an
   * attribution defect indistinguishable from a truncated library.
   *
   * THE USER'S NUMBER IS NOT TAKEN AWAY. `membershipPageBudget` treats `maxPages`
   * as a FLOOR, so a cap the user deliberately raised is honoured and one they
   * deliberately lowered is not raised back behind their back; the derivation
   * only ever ADDS pages this phase provably needs, and its runaway bound is a
   * separate constant. `maxPages` itself is untouched everywhere else: the
   * workspace walks still get exactly the number the user set. */
  const membershipBudget = typeof SunoAPI.membershipPageBudget === 'function'
    ? SunoAPI.membershipPageBudget({
      expectedTotal,
      pageLimit: SunoAPI.LIMITS.projectFeedLimit,
      maxPages,
    })
    /* A client that predates the helper keeps the previous behaviour exactly:
     * the caller's cap, and the old `'max_pages'` slug. This is a fallback for a
     * version skew, not a second implementation of the arithmetic. */
    : { maxPages, derived: false, neededPages: null, reason: 'this client has no membership budget helper' };
  if (membershipBudget.derived) {
    log('info', 'sync.membership_budget_raised', {
      cap: maxPages,
      budget: membershipBudget.maxPages,
      neededPages: membershipBudget.neededPages,
      expectedTotal,
      pageLimit: membershipBudget.pageLimit,
    });
  }
  /* ~200 pages on a 6,000-clip library when there is no cache to lean on, and
   * it runs BEFORE the first feed page, so it is the phase a user is most
   * likely to interrupt by mistake — and the phase in which the library
   * legitimately still holds zero new clips. The count is the DERIVED one, so the
   * note names the budget this walk is actually running under rather than a
   * figure that was only ever right for a mid-sized account. */
  await reportSyncPhase('mapping', {
    note: membershipsCached
      ? 'mapping clips to workspaces (cached since the last sync — walking only what is new)'
      : 'mapping clips to workspaces (~' + membershipBudget.maxPages + ' pages, no clips indexed yet)',
  }, runCtx());
  let lastMappingEmit = 0;
  try {
    const result = await SunoAPIClient.fetchProjectFeed({
      signal,
      limit: SunoAPI.LIMITS.projectFeedLimit,
      maxPages: membershipBudget.maxPages,
      /* THE DISTINCT SLUG, so a reader can tell which walk ran out of budget.
       * `'max_pages'` stays the default in the client for every caller that has
       * not opted in. */
      budgetReasonOnCap: MEMBERSHIP_BUDGET_STOP_REASON,
      budgetDerived: membershipBudget.derived === true,
      budgetNeededPages: membershipBudget.neededPages,
      knownIds: membershipsCached ? new Set(membershipsAll.keys()) : null,
      stopAfterKnownPages: membershipsCached ? MEMBERSHIP_CACHE_PREFIX_PAGES : 0,
      onProgress: (p) => {
        /* Throttled: one DB write and one broadcast per N pages, so a 200-page
         * walk does not turn into 200 round trips of its own. */
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
    /* THE MERGE: pages this walk actually served are the freshest facts (they
     * carry today's membership and `added_at_ms`), so they overwrite the cache
     * entry by entry; everything the incremental walk did not re-serve stays
     * covered by the cache. */
    for (const [id, list] of result.membershipsAll) membershipsAll.set(id, list);
    for (const [id, at] of result.addedAtMs) addedAtMs.set(id, at);
    newByProject = membershipsCached && result.newByProject instanceof Map ? result.newByProject : null;
    mappingOk = result.completed === true;
    projectFeed = {
      ok: true,
      completed: result.completed === true,
      stopReason: result.stopReason || 'complete',
      error: result.error ? describeError(result.error).message : null,
      pagesDone: result.pagesDone || 0,
      joined: membershipsAll.size,
      inferred: result.inferred === true,
      /* The incremental walk's own facts, published so the sync detail can say
       * "membership: incremental, N pages, M new" instead of implying 200
       * pages were walked. */
      incremental: result.incremental === true,
      newIds: Number.isFinite(result.newIds) ? result.newIds : 0,
      cachedAt: membershipCacheAt,
      /* Rows the membership walk dropped for carrying no `clip` key — the
       * `type:'video'` shape proven on a live 162 KB capture, previously
       * invisible. Published as data so a short-looking workspace can be told
       * apart from a walk that lost rows, and so a surface can eventually say
       * "N rows were videos, not clips" instead of showing a silent gap. */
      nonClipRows: Number.isFinite(result.nonClipRows) ? result.nonClipRows : 0,
      nonClipTypes: result.nonClipTypes && typeof result.nonClipTypes === 'object'
        ? result.nonClipTypes
        : {},
      /* THE BUDGET THIS PHASE RAN UNDER, published as DATA. Three reasons, all
       * load-bearing:
       *   1. `stopReason` is now `MEMBERSHIP_BUDGET_STOP_REASON` when the budget
       *      ended the walk, so a reader can tell THIS phase's cap from the feed
       *      phase's `max_pages` without parsing a sentence.
       *   2. `budgetDerived` says the number came from what the library needed
       *      rather than from the setting, which is the difference between "this
       *      account outgrew your cap" (advice: nothing, it is handled) and "your
       *      cap ended a walk" (advice: raise it).
       *   3. `maxPages` and `neededPages` together let a reader re-derive the
       *      arithmetic instead of trusting that a phase's budget was fair.
       * None of this touches the run-level `stopReason`, which is this walk's
       * absence from `completed`'s inputs — see the comment above. */
      maxPages: Number.isFinite(result.maxPages) ? result.maxPages : membershipBudget.maxPages,
      budgetDerived: membershipBudget.derived === true,
      budgetNeededPages: Number.isFinite(result.budgetNeededPages)
        ? result.budgetNeededPages
        : membershipBudget.neededPages,
      budgetReason: membershipBudget.reason,
    };
    if (result.inferred) log('info', 'sync.project_feed_inferred', { items: result.items });
    if (result.incremental) {
      log('info', 'sync.project_feed_incremental', {
        pagesDone: result.pagesDone || 0,
        newIds: result.newIds || 0,
        joined: membershipsAll.size,
      });
    }
    /* Rows the walk could not map because they are not clips — videos,
     * uploads, malformed entries — are now counted by the walk itself. Logged
     * here so a workspace that looks short carries an explanation that is not
     * "rows were lost": the join is exactly as complete as the feed allows. */
    if (Number.isFinite(result.nonClipRows) && result.nonClipRows > 0) {
      log('info', 'sync.project_feed_non_clip_rows', {
        nonClipRows: result.nonClipRows,
        types: result.nonClipTypes || null,
        joined: membershipsAll.size,
      });
    }
    if (!result.completed) {
      log('warn', 'sync.project_feed_incomplete', {
        stopReason: projectFeed.stopReason,
        joined: projectFeed.joined,
        pagesDone: projectFeed.pagesDone,
        maxPages: projectFeed.maxPages,
        budgetDerived: projectFeed.budgetDerived,
        neededPages: projectFeed.budgetNeededPages,
        nonClipRows: projectFeed.nonClipRows || 0,
        /* THE ONE LINE THAT SEPARATES "ATTRIBUTION INCOMPLETE" FROM
         * "LIBRARY INCOMPLETE", and it is worth being unable to confuse them.
         * A membership budget stop leaves every indexed clip on disk and
         * attributed to NOTHING past the cut; the run-level verdict does not
         * read this walk, so `completed` stays true and the UI reports a clean
         * sync. The count of un-attributed clips is published as
         * `oracleAdvisory` below rather than invented into `error`, because it
         * is a caveat on a successful run and `error` is a failure. */
        unjoinedClips: Math.max(0, (Number.isFinite(expectedTotal) ? expectedTotal : 0) - membershipsAll.size),
      });
    } else if (membershipsAll.size) {
      /* ONLY A WALK THAT REACHED THE FEED'S OWN END MAY REPLACE THE CACHE. An
       * incremental stop counts: its all-known prefix plus the cache covers
       * the feed, which is the same completeness the next run will lean on. */
      try {
        await DB.meta.set(META_KEYS.FEED_MEMBERSHIPS, {
          at: Date.now(),
          completed: true,
          incremental: result.incremental === true,
          membershipsAll: Array.from(membershipsAll.entries()),
          addedAtMs: Array.from(addedAtMs.entries()),
        });
      } catch (cacheWriteErr) {
        log('warn', 'sync.membership_cache_write_failed', { error: describeError(cacheWriteErr) });
      }
    }
  } catch (feedErr) {
    const info = describeError(feedErr);
    projectFeed = {
      ok: false,
      completed: false,
      stopReason: isAbortLike(feedErr) ? 'aborted' : 'page_failed',
      error: info.message,
      pagesDone: 0,
      joined: membershipsAll.size,
      inferred: false,
      incremental: false,
      newIds: 0,
      cachedAt: membershipCacheAt,
      /* Same three budget facts as the success path, so a reader does not have to
       * know which of the two shapes it is looking at to find out what budget this
       * phase ran under. A walk that THREW never reached its cap, so
       * `budgetDerived` stays as computed — it describes the budget, not the
       * stop. */
      maxPages: membershipBudget.maxPages,
      budgetDerived: membershipBudget.derived === true,
      budgetNeededPages: membershipBudget.neededPages,
      budgetReason: membershipBudget.reason,
    };
    log('warn', 'sync.project_feed_failed', { error: info });
    /* A FAILED walk must not poison the cache it was refreshing: the old map
     * stays as-is (it is already merged into `membershipsAll` above the catch),
     * it is not re-persisted, and the skip gate stays shut because `mappingOk`
     * is still false. */
  }
  /* THE NEW BUDGET FIELDS ARE INSIDE `projectFeed`, NOT AT THE TOP OF THE ROW, and
   * that placement is the backward-compatibility answer rather than an accident.
   * `DB.syncState.set` MERGES its patch into the stored row —
   * `lib/db.js` `_buildSyncStateApi.set` does `Object.assign({}, req.result || {},
   * patch || {})` — so a key this object OMITS survives from a previous run's row.
   * The three budget facts added above (`maxPages`, `budgetDerived`,
   * `budgetNeededPages`, `budgetReason`) therefore never need explicit nulling:
   * this line REPLACES the whole `projectFeed` object rather than merging into it,
   * so a row written by a build that predates them cannot leak a stale budget into
   * this run, and every shape of `projectFeed` above (success, budget stop, throw)
   * carries all four. `freshCursor.projectFeed: null` already clears the block
   * itself on a non-resumed run. A top-level `cursor.membershipBudget` would have
   * needed a `null` here for exactly the merge reason documented on `nextPage`. */
  cursor.projectFeed = projectFeed;

  /* THE MEMBERSHIP GAP, SAID OUT LOUD.
   *
   * WHY IT NEEDS A SENTENCE AND NOT JUST A FIELD. Every fact above about this
   * walk's budget lives on `cursor.projectFeed`, and nothing reads that block to
   * decide whether the run is complete — deliberately, because clips that are
   * indexed-but-unattributed are not missing clips. The consequence is that a
   * membership walk stopped at its budget produces a run that reports
   * `completed:true` with every clip on disk and a workspace filter that matches
   * nothing for the ones past the cut. `projectFeed.stopReason` is the evidence,
   * but evidence nobody renders is how the original defect shipped: the walk was
   * rationed by a cap meant for another phase, and the only trace was a log line
   * and a nested diagnostic.
   *
   * SO IT IS APPENDED TO `advisory`, which the surfaces DO read (it is
   * `syncContractView.advisory`), as its own sentence beside the clip-count
   * caveat. Not as `error`: this is not a failure, the crawl indexed what it
   * found, and putting it in `error` would make every account with a partial
   * membership walk report a broken sync. Not as `stopReason` either — the run
   * genuinely reached its own end. It is a caveat on a successful run, which is
   * exactly what `advisory` is for.
   *
   * ONLY WHEN THE GAP IS REAL. `projectFeed.completed` is false for a FAILED
   * walk too, and that case is not a budget question — it is already reported as
   * a failure of the phase — so the sentence is scoped to the budget stop, which
   * is the one the `stopReason` now names uniquely. */
  if (projectFeed
    && projectFeed.ok === true
    && projectFeed.completed === false
    && projectFeed.stopReason === MEMBERSHIP_BUDGET_STOP_REASON) {
    const unjoined = Math.max(0, (Number.isFinite(expectedTotal) ? expectedTotal : 0) - (projectFeed.joined || 0));
    oracleAdvisory = (oracleAdvisory ? oracleAdvisory + ' ' : '')
      + `workspace attribution is incomplete: the membership walk stopped at its ${projectFeed.maxPages}-page `
      + `budget after ${projectFeed.pagesDone} page(s), so about ${unjoined} clip(s) are indexed but not `
      + 'assigned to a workspace. They are all in the library; workspace-scoped filters will not show them until '
      + 'a sync maps them. This is not missing clips — it is missing attribution.';
    log('warn', 'sync.membership_budget_truncated', {
      pagesDone: projectFeed.pagesDone,
      maxPages: projectFeed.maxPages,
      joined: projectFeed.joined,
      unjoined,
      neededPages: projectFeed.budgetNeededPages,
    });
  }

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
   * and `examined` is absent from every row this build did not write. */
   const workspaces = (resumable && Array.isArray(stored.workspaces) ? stored.workspaces : [])
     .filter((row) => row && projectsDone.indexOf(String(row.projectId)) >= 0)
     .map((row) => Object.assign({}, row));
   /* THE CARRIED TALLIES ARE SUMMED PER FINISHED WORKSPACE, NOT READ OFF THE
    * ROW'S GLOBAL FIGURES. `stored.examined` / `stored.uniqueSeen` include the
    * IN-FLIGHT workspace's committed pages too, and a resume re-walks that
    * workspace from `cursor:null` — so trusting the global there counted its
    * committed rows once in the carry and AGAIN in the re-walk, and a resume
    * of a crawl parked one page in reported `totalSeen: 160` on a 120-clip
    * library with `missing: 0`, the inflation hiding inside the one number
    * the verdict turns on. The finished workspaces each carry their OWN row
    * (`workspaces[]`, written at every workspace end and by the cache-skip
    * gate), so the carry is the SUM OF THOSE ROWS: the in-flight workspace has
    * no row, its partial starts from zero, and its re-walk counts it exactly
    * once. `examined` per finished workspace is the row's `totalSeen`, the
    * same figure the gate itself adds, so the oracle's `expectedTotal - examined`
    * stays comparable on both sides of a resume.
    *
    * THE BOUND THAT REMAINS: a skipped workspace's ids are not re-walked, so a
    * clip that lives in BOTH a skipped and a re-walked workspace is still
    * counted twice — that bound is inherent to not re-walking, it is bounded
    * by the number of skipped projects, and fixing it would mean persisting
    * every skipped workspace's id set. Getting exact would cost thousands of
    * ids to save one duplicated row in a "X of ~Y" numerator on a resumed
    * run. */
   let carriedExamined = 0;
   let carriedUniqueSeen = 0;
   for (const carriedRow of workspaces) {
     if (Number.isFinite(carriedRow.totalSeen)) {
       carriedExamined += Math.floor(carriedRow.totalSeen);
       carriedUniqueSeen += Math.floor(carriedRow.totalSeen);
     }
   }
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

  /* ---- the workspace CACHE-SKIP gate's accumulators -------------------- */
  /* `storedRowsById` indexes the PREVIOUS run's workspace rows — the ones the
   * skip gate re-uses — by project id. It is built from `stored.workspaces`
   * regardless of `resumable`, because the gate is about the last WALK's
   * evidence, not about resuming a crawl that was in flight. */
  const storedRowsById = new Map();
  for (const row of (stored && Array.isArray(stored.workspaces) ? stored.workspaces : [])) {
    if (row && typeof row === 'object' && row.projectId !== undefined) {
      storedRowsById.set(String(row.projectId), row);
    }
  }
  /* Rows THIS run skipped on the gate's evidence, and the unique-count
   * contribution of the skipped rows. A skipped row's `totalSeen` is
   * unique-within-workspace, exactly like the ids a re-walk would have added
   * to `uniqueIds`, so adding it here keeps "X of ~Y" honest — with the same
   * documented bound a resume puts on the unique count: a clip shared between
   * a skipped and a re-walked workspace is counted twice. */
  const cachedSkipped = [];
  let skippedUnique = 0;
  /* A RESUMED run re-verifies every workspace the interrupted one skipped:
   * clips may have been created since the skip decision was made, and the
   * mapping walk of THIS run is the only thing that can re-acquit them. The
   * re-verification is cheap (a row copy when the gate still holds) and it is
   * the difference between "cached" and "never looked again". */
   if (resumable && Array.isArray(stored.cachedSkipped)) {
     const reverify = new Set(stored.cachedSkipped.map(String));
     const before = projectsDone.length;
     projectsDone = projectsDone.filter((id) => !reverify.has(String(id)));
     if (projectsDone.length !== before) {
       log('info', 'sync.cache_skip_reverify', { requeued: before - projectsDone.length });
     }
     /* THE RE-QUEUED ROWS' CONTRIBUTION COMES OFF THE CARRIED TALLIES.
      *
      * Every id in `cachedSkipped` got into `stored.examined` and
      * `stored.uniqueSeen` through the skip gate's `examined += carried.totalSeen`
      * and `skippedUnique += carried.totalSeen` — exactly `row.totalSeen` each,
      * and nothing else. Re-queueing the workspace puts it back in front of the
      * gate, and a gate that still holds will add that SAME figure a second time
      * while `carriedExamined`/`carriedUniqueSeen` still contain the first one.
      * The double was dormant while interrupted rows were never resumable;
      * accepting them wakes it, so it is subtracted HERE, once per re-queued row,
      * before anything can re-add it. `examined` feeds `missing`
      * (`expectedTotal - examined`), so an inflated one HIDES a real shortfall —
      * the one direction an honest oracle must never err in.
      *
      * A row that has gone missing from `stored.workspaces` cannot be subtracted;
      * that leaves its first contribution in place and the worst case is the old
      * inflated figure for that one workspace, so it is logged rather than
      * guessed at. */
     let requeuedSeen = 0;
     let requeuedMissing = 0;
     for (const id of reverify) {
       const row = storedRowsById.get(String(id));
       if (row && Number.isFinite(row.totalSeen)) {
         requeuedSeen += Math.floor(row.totalSeen);
       } else {
         requeuedMissing += 1;
       }
     }
     if (requeuedSeen > 0) {
       examined = Math.max(0, examined - requeuedSeen);
       carriedUniqueSeen = Math.max(0, carriedUniqueSeen - requeuedSeen);
     }
     if (requeuedMissing > 0) {
       log('warn', 'sync.cache_skip_reverify_row_missing', { rows: requeuedMissing });
     }
   }

  /** Unique clip ids PHASE 1 walked, including the carried-forward and the
   * cache-skipped tallies. */
  const uniqueSeenTotal = () => carriedUniqueSeen + skippedUnique + uniqueIds.size;

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
    /* The skip gate's receipt: which workspaces this run did not re-walk, so a
     * resumed run knows what to re-verify and the summary can say how many
     * were served from the cache. */
    cursor.cachedSkipped = cachedSkipped.slice();
    cursor.skippedWorkspaces = cachedSkipped.length;
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

      /* ---- THE WORKSPACE CACHE-SKIP GATE, and it is FAIL-OPEN -------------
       *
       * A workspace is re-walked unless EVERY ONE of these holds, because each
       * one is a separate way "nothing changed" can be wrong:
       *
       *   1. `!force` — a forced re-sync re-walks everything by definition.
       *   2. `mappingOk && newByProject` — THIS run's membership walk reached
       *      its own end (full or incremental) AND was compared against a
       *      cache, so "no new ids in this project" is a measurement, not an
       *      absence. No cache, a failed walk, or a mapping that did not
       *      finish keeps the gate shut and the workspace is walked.
       *   3. the previous run's row for this project exists, is
       *      `completed:true` and ended on the walk's OWN terminal signal
       *      (`walkStopReason:'complete'` — an explicit null cursor or an
       *      end-of-feed by omission), so the row being re-used is a finished
       *      walk's verdict and not a survivor of a broken one.
       *   4. the project's `clip_count` is UNCHANGED since that walk
       *      (`row.clipCountAtWalk === project.clipCount`, strict, `null`
       *      equal to itself) — the project row itself saying no clip was
       *      added, trashed or un-trashed in this workspace.
       *   5. the project's `last_updated_clip` is UNCHANGED since that walk
       *      (`row.lastUpdatedKey`), the same statement from the one field
       *      whose entire job is to move when a workspace changes.
       *
       * WHAT THE SKIP COSTS, WHICH IS WHY `force` EXISTS: a clip MOVED between
       * workspaces, or un-trashed, can leave the row's tally stale until a
       * full re-sync — neither produces a NEW membership id, and the `clip_count`
       * of two projects can swap a clip without either count moving. The
       * carried row is published with `cached:true`, the run publishes how
       * many workspaces were skipped, and a modifier-click full re-sync is the
       * documented escape hatch. */
      const previousRow = storedRowsById.get(project.id);
      if (!force
        && mappingOk === true
        && newByProject instanceof Map
        && !newByProject.has(project.id)
        && previousRow
        && previousRow.completed === true
        && previousRow.walkStopReason === 'complete'
        && previousRow.clipCountAtWalk === (Number.isFinite(project.clipCount) ? Math.floor(project.clipCount) : null)
        && previousRow.lastUpdatedKey === lastUpdatedKeyOf(project.lastUpdatedClip)) {
        const carried = Object.assign({}, previousRow, {
          cached: true,
          advisory: (previousRow.advisory ? previousRow.advisory + ' ' : '')
            + 'not re-walked this run: the membership walk saw no new clips and the project row '
            + 'is unchanged since the last completed walk (a full re-sync re-walks it)',
        });
        dropWorkspaceRow(workspaces, project.id);
        workspaces.push(carried);
        examined += Number.isFinite(carried.totalSeen) ? carried.totalSeen : 0;
        skippedUnique += Number.isFinite(carried.totalSeen) ? carried.totalSeen : 0;
        projectsDone.push(project.id);
        cachedSkipped.push(project.id);
        nextProjectIndex = index + 1;
        cursor.nextProjectIndex = nextProjectIndex;
        log('info', 'sync.workspace_cache_skipped', {
          projectId: project.id,
          seen: carried.totalSeen || 0,
          expected: carried.expected === undefined ? null : carried.expected,
        });
        await persist();
        continue;
      }

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
    /* A SHORTFALL BLOCKS COMPLETION ONLY WHERE IT CAN PROVE ONE.
     *
     * TWO REGIMES, AND THE REGIME IS `oracleApplied`:
     *
     *   - `oracleApplied:true` (unfiltered walk vs `clip_count`) — the count
     *     measures the same set the walk did, so `!totalsMet` is PROOF and it
     *     still fails the run unconditionally.
     *   - `oracleApplied:false` (the default: the walk filters trashed and
     *     disliked rows, `clip_count` may not) — `!totalsMet` is a DIFFERENCE
     *     NOBODY CAN INTERPRET, and failing every run on it is what made a
     *     complete sync report INCOMPLETE forever on any account that trashes
     *     or dislikes anything. The gap is still fatal in the one shape that
     *     says "truncation" rather than "filters": EVERY comparable workspace
     *     short, every walk ended on the feed's own terminal signal, and the
     *     gaps too large to be the filter accounting — that is
     *     `unexplainedShortfall` below, and it keeps the original
     *     `suspected_truncation` wording. A PARTIAL shortfall (some
     *     workspaces short, or small everywhere) is published as the lower
     *     bound the advisory already describes and does not block.
     *
     * The historic guard is intact in the direction that matters: a crawl
     * that indexed 10-20% of a library CANNOT reach `completed:true` through
     * this clause, because such a crawl has workspaces that did NOT end on
     * their own terminal signal (`everyWorkspaceCompleted` is false and the
     * run is incomplete for that reason alone), or it ended every walk on
     * the feed's own signal while short everywhere by a wide margin — which
     * is exactly `unexplainedShortfall`, and it fails.
     *
     * `everyWorkspaceShort` is the aggregate question: EVERY workspace that
     * reported a count came up short. That is different from ONE workspace
     * dying mid-walk (which `failed.length` covers) and different again from
     * a run-level arithmetic mismatch. A workspace with no count at all
     * cannot be "short", so it is excluded from the ratio rather than counted
     * as a pass.
     *
     * `endedOnTerminalCursor` is the OTHER half: every walk reported a genuine
     * end of feed — a cursor field that was present and null, or end-of-feed
     * by omission (`'complete'` covers both; `'cursor_missing'` is kept for
     * rows stored by builds that treated omission as a failure) — rather than
     * a failed page, a stuck cursor or a page cap. It reads `walkStopReason`,
     * NOT `stopReason`: the shortfall logic rewrites `stopReason` to
     * `'expected_total'`, so by this point `stopReason` says "short" on every
     * failed row and cannot distinguish "the feed ended" from "this walk
     * broke". "Everyone said there is no more, and there demonstrably was
     * more" is a specific and very diagnosable failure, and it deserves its
     * own `stopReason` rather than being filed under the generic
     * `expected_total`. */
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
    /* THE TRUNCATION SHAPE, as one boolean: every comparable workspace short,
     * every walk on the feed's own terminal signal, and the gaps too large
     * for the filters to explain. This — and only this — is what a shortfall
     * may block a filtered run on. */
    const unexplainedShortfall = everyWorkspaceShort && endedOnTerminalCursor && !shortfallLikelyFilters;
    const oracleBlocksCompletion = oracleApplied ? !totalsMet : unexplainedShortfall;
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
        /* The row's own `error` carries the walk's diagnosis, and when the
         * `has_more` guard refused the completion it names the contradiction —
         * the page SAID more clips exist while omitting the cursor, which is
         * the renamed-field signature. Appending it lets one read of the
         * verdict tell "the field was renamed and the feed still has more"
         * apart from "the field is absent and the feed is silent", before
         * anybody runs PROBE_FEED. */
        error = `workspace ${missed ? missed.projectId : '(unknown)'} stopped: the feed response carried no `
          + 'cursor field this client recognises, so the walk could not be continued and the library '
          + 'cannot be proven indexed. Run PROBE_FEED to see what the envelope actually calls it'
          + (missed && missed.error ? ` (walk detail: ${missed.error})` : '');
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
    /* Re-asserted at the final write so a run whose skips happened before its
     * last `persist()` (there are none, but the invariant is cheap) still
     * publishes the cache-skip receipt on the stored row. */
    cursor.cachedSkipped = cachedSkipped.slice();
    cursor.skippedWorkspaces = cachedSkipped.length;
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
    /* The run-scoped keepalive goes with the watchdog: every terminal path
     * reaches this block, and an alarm left armed after the run would fire
     * into a worker with no controller forever (its own handler clears it one
     * tick later, but the run that owns it should not leave it behind at
     * all). */
    await disarmSyncRunKeepalive();
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

/* HOW MANY TIMES A WAKE MAY RESTART A CRAWL THE PREVIOUS WORKER WAS EVICTED
 * FROM, before the chain is abandoned to a manual press. Eviction is an
 * implementation detail the user never asked for — they pressed Sync and the
 * crawl owes them a finished library — so a fresh worker that finds a genuinely
 * orphaned row (no controller, run record gone stale) restarts it rather than
 * reporting an interruption nobody can act on. But a crawl that dies again on
 * every restart (a persistent network fault, an API tantrum, a worker that
 * cannot stay alive for one page) must not become an unattended restart loop
 * hammering the API every time the `SYNC_RUN` alarm fires: after this many
 * consecutive attempts the row is healed to `interrupted` and the manual
 * "press Sync to resume" path — which RESUMES at workspace granularity, see the
 * `resumable` predicate — takes over. The counter lives on the cursor row
 * (`autoResumeAttempts`), is incremented by the healer BEFORE each restart, and
 * is reset by the next FRESH `SYNC_START`, not by a resume. A stop the user
 * asked for (`cancelRequested`) never restarts, on any attempt. */
const MAX_SYNC_AUTO_RESUMES = 3;
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
function syncLiveness(cursor, run) {
  const row = cursor && typeof cursor === 'object' ? cursor : null;
  const claimsRunning = !!row && row.state === 'running';
  const at = row ? Number(row.heartbeatAt) : NaN;
  const hasPageBeat = Number.isFinite(at) && at > 0;
  /* THE RUN RECORD IS LIVENESS EVIDENCE TOO, AND IT IS THE ONE THE ALARM
   * KEEPS FRESH. `cursor.heartbeatAt` means "a page committed", and it is
   * written only by a page commit or a phase report — so a crawl parked in a
   * long rate-limit backoff commits nothing and its cursor heartbeat goes
   * stale WHILE THE WORKER IS PROVABLY ALIVE: the `SYNC_RUN` alarm fires every
   * ~30 s for exactly as long as the run lives and refreshes
   * `run.heartbeatAt` on purpose (§13d). The original rule read only the page
   * clock, which is how one poll during a backoff could declare a running
   * crawl dead. The rule is now: stale only when the FRESHEST evidence from
   * EITHER clock is older than `SYNC_STALE_MS`. A live worker keeps its alarm
   * heartbeat fresh, so a backoff no longer reads as death; a genuinely dead
   * worker stops both clocks, so an eviction is still caught inside the same
   * 90 s.
   *
   * `heartbeatAt` in the RESULT stays the cursor's own page clock — the healed
   * row publishes it, and "no page for Ns" is a claim about pages. The caller
   * gets both clocks separately (`pageAgeMs`, `runHeartbeatAt`) plus the
   * `ageMs` the decision was actually made on, so no sentence has to lie
   * about which clock it read. */
  const runRow = run && typeof run === 'object' ? run : null;
  const runAt = runRow && runRow.running === true
    && Number.isFinite(Number(runRow.heartbeatAt)) && Number(runRow.heartbeatAt) > 0
    ? Number(runRow.heartbeatAt)
    : null;
  const freshestAt = runAt !== null && (!hasPageBeat || runAt > at) ? runAt : (hasPageBeat ? at : null);
  const ageMs = freshestAt !== null ? Math.max(0, Date.now() - freshestAt) : null;
  const pageAgeMs = hasPageBeat ? Math.max(0, Date.now() - at) : null;
  if (!claimsRunning) {
    return {
      live: false, stale: false, heartbeatAt: hasPageBeat ? at : 0,
      ageMs, pageAgeMs, runHeartbeatAt: runAt, reason: null,
    };
  }
  // No heartbeat at all — on EITHER clock — means the row predates these
  // fields, or the worker died before its first page landed and before a
  // single alarm tick. Either way it cannot be shown as live.
  if (ageMs === null) {
    return {
      live: false, stale: true, heartbeatAt: 0, ageMs: null,
      pageAgeMs, runHeartbeatAt: runAt, reason: 'the crawl never reported a page',
    };
  }
  if (ageMs > SYNC_STALE_MS) {
    return {
      live: false,
      stale: true,
      heartbeatAt: hasPageBeat ? at : 0,
      ageMs,
      pageAgeMs,
      runHeartbeatAt: runAt,
      reason: 'no page was committed for '
        + (pageAgeMs === null ? '—' : Math.round(pageAgeMs / 1000) + 's')
        + (runAt !== null ? ' and no worker heartbeat for ' + Math.round(ageMs / 1000) + 's' : '')
        + ', so the crawl is not running any more',
    };
  }
  return {
    live: true, stale: false, heartbeatAt: hasPageBeat ? at : 0,
    ageMs, pageAgeMs, runHeartbeatAt: runAt, reason: null,
  };
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
  /* NEVER HEAL A CRAWL THIS WORKER STILL OWNS. `syncLiveness` cannot tell the two
   * situations apart: `cursor.heartbeatAt` is written only when a page COMMITS and
   * when `reportSyncPhase` runs, so a run parked in a rate-limit backoff commits no
   * page for well over `SYNC_STALE_MS` while the worker is demonstrably alive and
   * firing its alarm (the `SYNC_RUN` keepalive deliberately does not write the
   * cursor heartbeat — the run record carries that, because the cursor heartbeat
   * means "a page landed"). Every caller of this function is a READ path
   * (`SYNC_STATUS`, `GET_BOOT`, `cancelSync`), so one poll during a backoff was
   * enough to declare a running crawl dead, write `completed:false` over its live
   * row — and because the write MERGES into storage, that row stayed broken after
   * the crawl went on to finish. `syncController` is the one thing that actually
   * knows, and it is in-memory, so its absence genuinely means "no crawl in this
   * worker" and its presence means the opposite. Checked HERE rather than at the
   * call sites because that makes it a precondition of healing itself, which every
   * future caller inherits instead of having to remember it. */
  if (syncController) {
    log('debug', 'sync.heal_skipped_owned', {
      ageMs: live.ageMs,
      heartbeatAt: live.heartbeatAt,
    });
    return current;
  }
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
    //
    // `lastError`, NOT `error`. `error` is a field nothing ever clears: the run's
    // verdict writes and clears `lastError` only, and `DB.syncState.set` MERGES,
    // so a sentence written here under `error` outlived every later run and pinned
    // a finished, complete library to INCOMPLETE on all three surfaces. `lastError`
    // is owned by the verdict and cleared by it, so a healed row stays recoverable:
    // the next run's verdict overwrites it whether that run succeeds or fails.
    lastError: 'the extension worker was stopped mid-crawl'
      /* `pageAgeMs`, NOT `ageMs`: the sentence is a claim about PAGES, and the
       * decision's `ageMs` may have been measured off the alarm clock — which
       * is exactly what keeps this heal from firing on a live backoff, but
       * would make the sentence lie about which clock it read. */
      + (live.pageAgeMs !== null ? ' (no page for ' + Math.round(live.pageAgeMs / 1000) + 's)' : '')
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
  /* The run record is liveness evidence too (see `syncLiveness`): a crawl
   * parked in a rate-limit backoff has a stale page clock but a live alarm
   * heartbeat, and a Stop press must not mistake that for an orphan. */
  const runRecord = await readSyncRun().catch(() => null);
  const live = syncLiveness(stored, runRecord);

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
  /* `run` was read by the caller and passed in — the same snapshot the verdict
   * was judged from, so the liveness rule and the eviction verdict cannot
   * disagree about which clocks they read. */
  const live = syncLiveness(fresh, run);
  const afterCancel = cancelRequestedWording(verdict, fresh);
  const noPageFor = verdict.ageMs !== null ? ' (no page for ' + Math.round(verdict.ageMs / 1000) + 's)' : '';
  /* THE AUTO-RESUME DECISION'S INPUTS, read off the row BEFORE the heal is
   * written, so the counter and the sentence are decided on the same snapshot
   * the rest of the heal is. The count is incremented onto the healed row below
   * whether or not a restart follows: a restart that dies before its first page
   * commit has still spent an attempt, and the next wake must see that. */
  const attemptsSoFar = Number.isFinite(fresh.autoResumeAttempts)
    ? Math.max(0, Math.floor(fresh.autoResumeAttempts))
    : 0;
  const attemptsExhausted = attemptsSoFar >= MAX_SYNC_AUTO_RESUMES;
  const healed = Object.assign({}, fresh, {
    state: 'interrupted',
    stopReason: 'interrupted',
    // `lastError`, NOT `error`, for the reason `reconcileStaleCursor` spells out:
    // `error` is never cleared by anything, so a sentence written here survived
    // into every later run under `DB.syncState.set`'s merge and made a library
    // that later indexed cleanly report INCOMPLETE forever. `lastError` belongs to
    // the run's verdict, which overwrites it on the next run either way.
    lastError: afterCancel
      ? 'you asked to stop this crawl, but the extension worker was stopped before the stop '
        + `could take effect${noPageFor} — press Sync to continue; indexed clips are kept`
      : (attemptsExhausted
        ? `the extension worker was stopped mid-crawl${noPageFor} — it tried to resume itself `
          + `${MAX_SYNC_AUTO_RESUMES} times and stopped trying; indexed clips are kept — `
          + 'press Sync to resume from where it stopped'
        : `the extension worker was stopped mid-crawl${noPageFor} — press Sync to continue; indexed clips are kept`),
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
    /* Spent BEFORE the restart, so a restart that never commits a page still
     * cost the chain one attempt. Reset only by the next FRESH run's
     * `freshCursor` (see there). */
    autoResumeAttempts: attemptsSoFar + 1,
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

  /* ---- THE AUTO-RESTART: eviction is an implementation detail ----------------
   *
   * The user pressed Sync and is owed a finished library; a service worker
   * being reclaimed under the crawl is not a fact they can act on. So when the
   * heal above has produced an honest `interrupted` row, and nothing about the
   * situation says "leave it to the user", the SAME worker that healed it
   * starts the crawl again — through `runSync`'s ordinary entry, which RESUMES
   * at workspace granularity off the row just healed (`resumable` accepts
   * 'interrupted'), instead of re-walking everything the evicted run finished.
   *
   * THE FOUR THINGS THAT MUST HOLD, and each one is checked here:
   *   - the user did not ask to stop (`afterCancel`) — a lost STOP is honoured,
   *     never overridden by a restart;
   *   - the attempt chain is not exhausted (`MAX_SYNC_AUTO_RESUMES`) — this is
   *     the bound that keeps a dying crawl from becoming an unattended restart
   *     loop on the `SYNC_RUN` alarm's cadence;
   *   - no controller appeared while the heal was writing — a `SYNC_START` that
   *     landed on this worker during the awaits above owns the row now;
   *   - the healed row carries everything `runSync`'s `resumable` predicate will
   *     demand back (mode, page cap, plan arrays, the examined tally) — a row
   *     that cannot resume is restarted as a FULL crawl by accident otherwise.
   *
   * The restart mirrors `startSync`'s essentials exactly — controller, probe
   * latch, keepalive alarm, wall-clock watchdog, run record, SYNC_STARTED
   * broadcast — because those five are the crawl's own liveness contract, and a
   * restart that skipped one would be a crawl the next eviction could not
   * reconcile. */
  const restartEligible = !afterCancel
    && !attemptsExhausted
    && !syncController
    && typeof fresh.mode === 'string'
    && Object.prototype.hasOwnProperty.call(DISLIKED_FILTER_BY_MODE, fresh.mode)
    && Number.isFinite(fresh.maxPages)
    && fresh.maxPages > 0
    && Array.isArray(fresh.projectsDone)
    && Number.isFinite(fresh.examined);
  if (restartEligible) {
    syncController = new AbortController();
    syncCancelRequested = false;
    AUTO_FEED_PROBE.runFired = false;
    void armSyncRunKeepalive();
    const watchdogStart = Date.now();
    syncWatchdogTimer = setTimeout(() => {
      const elapsedMs = Date.now() - watchdogStart;
      log('error', 'sync.watchdog_fired', { elapsedMs });
      syncWatchdogFired = true;
      if (syncController && !syncController.signal.aborted) {
        syncController.abort();
      }
    }, SYNC_WALL_CLOCK_MS);
    await writeSyncRun({
      running: true,
      startedAt: Date.now(),
      cancelRequested: false,
      cancelRequestedAt: null,
      phase: 'resuming',
      heartbeatAt: Date.now(),
      autoResumed: true,
    });
    lastSyncRunBeat = Date.now();
    const restartedTotal = await DB.clips.count();
    log('info', 'sync.auto_resume_started', {
      attempt: attemptsSoFar + 1,
      ofMax: MAX_SYNC_AUTO_RESUMES,
      mode: fresh.mode,
      maxPages: fresh.maxPages,
      workspacesDone: fresh.projectsDone.length,
      pagesDone: fresh.pagesDone || 0,
      seen: fresh.totalSeen || 0,
      ageMs: verdict.ageMs,
      ageSource: verdict.ageSource,
    });
    await broadcast({
      type: 'SYNC_STARTED',
      state: 'running',
      running: true,
      cancelRequested: false,
      force: false,
      dislikedMode: fresh.mode,
      maxPages: fresh.maxPages,
      feedPageLimit: Number.isFinite(fresh.feedPageLimit) ? fresh.feedPageLimit : 0,
      total: restartedTotal,
      heartbeatAt: Date.now(),
      autoResumed: true,
    });
    void runSync({
      force: false,
      mode: fresh.mode,
      maxPages: fresh.maxPages,
      feedPageLimit: fresh.feedPageLimit,
      signal: syncController.signal,
    }).catch((resumeErr) => {
      const info = describeError(resumeErr);
      log('error', 'sync.threw', { error: info });
      syncController = null;
      syncCancelRequested = false;
      clearWatchdog();
      void clearSyncRun();
      void broadcast({
        type: 'SYNC_ERROR',
        ...syncContractView(null, {
          completed: false,
          stopReason: isAbortLike(resumeErr) ? 'aborted' : 'page_failed',
          error: info.message,
          state: isAbortLike(resumeErr) ? 'cancelled' : 'error',
          expectedTotal: Number.isFinite(fresh.expectedTotal) ? fresh.expectedTotal : 0,
          examined: 0,
          uniqueSeen: 0,
          missing: 0,
          oracleApplied: false,
          advisory: 'the automatically resumed run failed before it could measure anything',
          workspaces: [],
          pagesDone: 0,
        }),
        projectList: null,
        projectFeed: null,
        dislikedCount: null,
        dislikedApproximate: false,
      });
    });
    return true;
  }

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

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see 15-quota.js.
 * `scripts/check-build.sh` asserts these names do not collide with a
 * monolith declaration.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUSync = {
    startSync, cancelSync, runSync, syncLiveness, reconcileStaleCursor,
    readSyncRun, writeSyncRun, clearSyncRun, reconcileSyncRunOnBootstrap,
    syncContractView, cursorForWire, syncHealthLines, probeFeed,
  };
}
