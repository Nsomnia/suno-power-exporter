/**
 * Suno Master Utility — popup (toolbar cockpit)
 * ===========================================================================
 * Scope: a ~340 px surface. Show the four numbers that decide whether the next
 * click is safe, run one operation at a time, and stream what happens.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS WRITTEN THE WAY IT IS
 * ---------------------------------------------------------------------------
 * A. `send()` THROWS on `{ok:false}` and on a dead worker. The previous build's
 *    `msg()` resolved `null` on every failure, so callers checked `res.error`
 *    on a value that was already null and then reported success. Every call
 *    site here is inside a try/catch whose catch branch reaches the user.
 * B. `buildDownloadPayload()` REFUSES to produce an empty `DOWNLOAD_START`
 *    payload. The previous build sent `{}`, which the worker read as "download
 *    the entire library". Either an explicit `ids` array or an explicit non-
 *    empty `spec` is required; there is no code path that emits neither.
 * C. The percentage is REAL: `pagesDone / maxPages` for a sync (maxPages comes
 *    from the `SYNC_START` reply) and `done / total` for a batch. The previous
 *    arithmetic was `Math.max(page + 2, 5)`, which pinned the bar near 50 %
 *    forever.
 * D. The sync tile is a THREE-WAY decision — complete / incomplete / cancelled
 *    — read from `completed`, `stopReason` and `expectedTotal`, never from
 *    `state === 'idle'`. The defect this replaces: a walk that died on the 21st
 *    request still reported `state:'idle'`, so `status === 'idle' ? 'Up to date'`
 *    painted green over a 400-of-5,500 index, and `lastError` was rendered only
 *    on the `state === 'error'` branch, which a `break` never produces. So the
 *    UI threw away the one piece of information that explained the failure.
 *    `expectedTotal` is what makes the failure self-evident: "400 of ~5,500"
 *    needs no log and no inference. The persistent banner is gated on
 *    `completed === false` (accepting `truncated` for older replies) for the
 *    same reason.
 * E. Downloads and credits are SEPARATE tiles. They are different resources;
 *    the previous badge showed credits, so a user at zero downloads saw a
 *    healthy badge.
 * F. NOTHING here builds markup from data. `textContent` only — no HTML
 *    parsing sink of any kind (no inner/outer/adjacent-HTML assignment).
 *    Clip titles, style tags and prompts are user-controlled text and end up in
 *    this DOM.
 * G. Every `chrome.*` promise is awaited inside a try/catch, or explicitly
 *    `.catch()`ed. There is no unhandled rejection anywhere in this file.
 * H. `DL_DONE` is branched on `stoppedReason`, not on `failed`. The worker
 *    distinguishes `complete` / `cancelled` / `quota` / `ladder_exhausted`, and a
 *    batch that halted on the monthly allowance is a WARNING, not a success and
 *    not a failure: it saved what it could and left the rest planned. Reporting
 *    all four as a green "Batch complete" is the defect this branch removes.
 * I. `DOWNLOAD_STATUS` is read on every boot and from the Refresh button,
 *    because it is the only route that carries `plan.stoppedReason` /
 *    `plan.quotaStop` — a popup reopened mid-batch has no other way to learn
 *    what the worker is actually doing.
 * J. NOTHING CONVEYED BY COLOUR ALONE. The tile value is a `role="status"`
 *    live region and always spells the state in words — `Incomplete`,
 *    `Cancelled`, `Failed`, `Up to date` — with the amber/red tint applied
 *    inline on top. A user who cannot see the colour still gets the answer.
 * K. `SYNC_REASON_PHRASE` IS SHARED COPY. The same map, with byte-identical
 *    values, is duplicated in `side_panel.js` and `content/content.js`. A stop
 *    described three different ways across the three surfaces is a support
 *    question, so the wording is duplicated deliberately and must be changed in
 *    all three together.
 * ===========================================================================
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ DOM */

  var els = {
    auth: document.getElementById('sm-auth'),
    truncated: document.getElementById('sm-truncated'),
    truncatedText: document.getElementById('sm-truncated-text'),
    tileClips: document.getElementById('sm-tile-clips'),
    tileClipsNote: document.getElementById('sm-tile-clips-note'),
    tileSync: document.getElementById('sm-tile-sync'),
    tileSyncNote: document.getElementById('sm-tile-sync-note'),
    tileQuotaBox: document.getElementById('sm-tile-quota-box'),
    tileQuota: document.getElementById('sm-tile-quota'),
    tileQuotaNote: document.getElementById('sm-tile-quota-note'),
    tileCredits: document.getElementById('sm-tile-credits'),
    progressLabel: document.getElementById('sm-progress-label'),
    progressPct: document.getElementById('sm-progress-pct'),
    progressTrack: document.getElementById('sm-progress-track'),
    progressFill: document.getElementById('sm-progress-fill'),
    progressDetail: document.getElementById('sm-progress-detail'),
    summary: document.getElementById('sm-summary'),
    summaryText: document.getElementById('sm-summary-text'),
    summaryQuota: document.getElementById('sm-summary-quota'),
    btnSync: document.getElementById('sm-sync'),
    btnDownload: document.getElementById('sm-download'),
    btnCancel: document.getElementById('sm-cancel'),
    btnPanel: document.getElementById('sm-panel'),
    btnOptions: document.getElementById('sm-options'),
    btnLogClear: document.getElementById('sm-log-clear'),
    log: document.getElementById('sm-log')
  };

  /* --------------------------------------------------------------- state */

  var state = {
    settings: null,
    libraryTotal: null,
    selectionCount: 0,
    quota: null,
    credits: null,
    /**
     * The sync facts that justify the persistent incompleteness banner, or null
     * when the last sync completed cleanly. Replaces the old boolean
     * `truncated`, which could not say WHY and could never be cleared.
     */
    truncFacts: null,
    token: null,
    sync: null,
    bootCounts: null,
    batchStatus: null,
    /** 'idle' | 'sync' | 'download' */
    activity: 'idle',
    syncRunning: false,
    syncPagesDone: 0,
    syncMaxPages: 0,
    syncSeen: 0,
    syncEtaMs: 0,
    /**
     * True once a cancel has been signalled and the crawl has not yet reported
     * itself finished. Used to keep the progress line honest: a cancelling run
     * must not keep rendering a live percentage as if it were still making
     * progress.
     */
    syncCancelling: false,
    syncCancelRequestedAt: 0,
    /**
     * The stored cursor claimed `running` but no controller owns it — an MV3
     * worker eviction, not a live crawl. Kept separate from `syncRunning` because
     * the two need different copy and different affordances: a running crawl can
     * be stopped, an orphaned one can only be resumed.
     */
    syncOrphaned: false,
    /**
     * Which phase of the crawl is running, plus that phase's own counters.
     *
     * THE SINGLE SOURCE OF TRUTH IS THE WORKER, NOT THIS OBJECT. Three surfaces
     * show this crawl (the popup, the in-page dock, the side panel) and they were
     * each keeping their own copy of "is a sync running and how far along", which
     * is how they came to disagree — the popup saying "Syncing" while the dock said
     * idle and Stop said nothing was running. Every surface now derives this from
     * the worker's `SYNC_STATUS` / `SYNC_PROGRESS` and nothing else, and `phase`
     * exists because the phase is the one fact all three were previously guessing.
     */
    syncPhase: '',
    syncPhasePages: 0,
    syncPhaseJoined: 0,
    syncPhaseItems: 0,
    downloadRunning: false,
    downloadDone: 0,
    downloadTotal: 0,
    downloadOk: 0,
    downloadFailed: 0,
    downloadSkipped: 0,
    downloadCurrentTitle: '',
    downloadEtaMs: 0,
    /** The batch id whose per-item rows are currently being collected. */
    dlBatchId: null,
    /** Distinct per-clip refusals seen this batch, for the ladder-exhausted report. */
    dlReasons: [],
    /** `batchId:stoppedReason` already reported, so a re-read cannot repeat it. */
    reportedOutcome: '',
    summaryLines: null,
    summaryQuotaText: '',
    summaryIsBad: false,
    /** '' | 'warn' | 'bad' — drives the summary border and the toast tint. */
    summaryKind: '',
    lastBootOk: false,
    busy: false,
    debug: false
  };

  /* -------------------------------------------------------------- helpers */

  /**
   * The ONE debug-gated logger in this build. A console write appears here and
   * nowhere else, and only when the `debug` setting is on.
   */
  function dbg() {
    if (!state.debug) return;
    var args = ['[sm-popup]'];
    for (var i = 0; i < arguments.length; i += 1) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  /** @param {unknown} err */
  function textOf(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return 'unknown error';
  }

  function noop() {}

  /**
   * How long a cancel request waits for the worker to report the run finished
   * before it gives up and shows the authoritative state.
   *
   * Aborting is cooperative — the crawl observes the signal only where it
   * awaits — and a rate-limit backoff can hold a page open for tens of seconds.
   * Twenty seconds is long enough for a normal unwind and short enough that the
   * popup never sits on "Cancelling…" with no way out.
   */
  var SYNC_CANCEL_WAIT_MS = 20000;
  var SYNC_POLL_MS = 2000;
  var syncPollTimer = 0;

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function startSyncPoll() {
    if (syncPollTimer) return;
    syncPollTimer = setInterval(function () {
      refreshSyncStatus().catch(function (pollErr) {
        addLog('Could not read sync status: ' + textOf(pollErr), 'warn');
        stopSyncPoll();
      });
    }, SYNC_POLL_MS);
  }

  function stopSyncPoll() {
    if (!syncPollTimer) return;
    clearInterval(syncPollTimer);
    syncPollTimer = 0;
  }

  function scheduleSyncPoll(running) {
    if (syncPollTimer) {
      if (!running) stopSyncPoll();
      return;
    }
    if (!running) return;
    startSyncPoll();
  }

  async function refreshSyncStatus() {
    try {
      var reply = await send('SYNC_STATUS', {});
      if (reply && reply.cancelling === true) {
        state.syncRunning = true;
        state.syncCancelling = true;
      }
      if (reply && reply.running === true) {
        state.syncRunning = true;
        state.syncCancelling = reply.cancelling === true;
      }
      if (reply && reply.running === false && state.syncRunning === true) {
        state.syncRunning = false;
        state.syncCancelling = false;
        applySyncReply(reply, {});
        addLog('Sync ended. state=' + String(reply.state || '') + ' completed=' + String(reply.completed || '') + ' stopReason=' + String(reply.stopReason || ''), 'info');
        renderAll();
      }
      scheduleSyncPoll(!!(reply && reply.running));
    } catch (err) {
      stopSyncPoll();
      addLog('Could not read sync status: ' + textOf(err), 'warn');
    }
  }

  /**
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampInt(value, min, max, fallback) {
    var num = Number(value);
    if (!isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  }

  /** @param {number|null|undefined} ms @returns {string} */
  function formatDuration(ms) {
    var num = Number(ms);
    if (!isFinite(num) || num < 0) return '';
    var total = Math.round(num / 1000);
    if (total < 60) return total + 's';
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes + 'm ' + (seconds < 10 ? '0' : '') + seconds + 's';
  }

  /**
 * A date for display. A bare `YYYY-MM-DD` is rendered as that literal calendar
 * day in UTC rather than being pushed through the local timezone, because
 * `new Date('2026-10-01').toLocaleDateString()` is "Sep 30" west of Greenwich —
 * and "the quota resets on the 30th" when Suno says the 1st is exactly the kind
 * of off-by-one a user cannot see the cause of.
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
  function formatDate(value) {
    if (value === null || value === undefined || value === '') return 'unknown date';
    var raw = String(value).trim();
    var bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (bare) {
      return new Date(Date.UTC(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])))
        .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    var ms = typeof value === 'number' ? value : Date.parse(raw);
    if (!isFinite(ms)) return raw;
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function plural(n, one, many) {
    return n === 1 ? one : (many || one + 's');
  }

  /**
   * Thousands separators without `Intl`, so "5,500" is spelled the same way in
   * every locale and in every harness that reads this file's output.
   *
   * @param {number} value
   * @returns {string} '' when the value is not a finite number
   */
  function group(value) {
    var num = Number(value);
    if (!isFinite(num)) return '';
    var rounded = Math.round(num);
    var sign = rounded < 0 ? '-' : '';
    var digits = String(Math.abs(rounded));
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** @param {string} text @returns {string} */
  function sentence(text) {
    var s = String(text || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  /**
   * The first candidate that is a real, positive count; null when none is.
   *
   * @param {...unknown} values
   * @returns {number|null}
   */
  function firstPositive() {
    for (var i = 0; i < arguments.length; i += 1) {
      var num = Number(arguments[i]);
      if (isFinite(num) && num > 0) return num;
    }
    return null;
  }

  /* --------------------------------------------------- sync completeness */

  /**
   * `stopReason` -> plain English. THE SHARED MAP.
   *
   * Byte-identical copies of this object live in `side_panel.js` and
   * `content/content.js` (see header note K). Values are complete phrases with
   * a subject, so they can be dropped into a tile note, a banner sentence and an
   * activity-log line without any of the three re-wording them.
   */
  var SYNC_REASON_PHRASE = {
    complete: 'the crawl finished cleanly',
    suspected_truncation: 'the feed stopped early — your library is only partly indexed',
    cursor_missing: 'it could not read the feed\'s paging field, so it could not continue',
    page_failed: 'it stopped on a failed request',
    empty_page: 'the feed returned an empty page',
    stuck_cursor: 'the pagination cursor repeated',
    no_new_ids: 'a page returned no new clips',
    max_pages: 'it hit your page cap',
    expected_total: 'it found fewer clips than Suno reports',
    aborted: 'it stopped because you cancelled',
    interrupted: 'the extension worker was stopped mid-crawl — press Sync to resume'
  };

  /** Used when the walk stopped but the worker named no reason at all. */
  var SYNC_REASON_FALLBACK = 'it stopped early for a reason the worker did not report';

  /**
   * @param {unknown} stopReason
   * @returns {string} a plain-English phrase; never '' and never `undefined`
   */
  function syncReasonPhrase(stopReason) {
    var key = typeof stopReason === 'string' ? stopReason.trim() : '';
    return SYNC_REASON_PHRASE[key] || SYNC_REASON_FALLBACK;
  }

  /**
   * Read the sync-completeness contract out of ANY reply, flat or wrapped.
   *
   * `SYNC_DONE` carries the fields at the top level, `SYNC_STATUS.cursor`
   * carries the same cursor fields one level down and `GET_BOOT.sync` carries
   * that cursor object itself, so all three are accepted. EVERY field is
   * optional: a worker older than the contract returns an object whose only
   * key is `pagesDone`, and this returns `hasContract:false` with nulls rather
   * than throwing or inventing numbers.
   *
   * @param {unknown} reply
   * @returns {object|null} null when there is no object to read
   */
  function readSyncFacts(reply) {
    if (!reply || typeof reply !== 'object') return null;
    var cursor = (reply.cursor && typeof reply.cursor === 'object') ? reply.cursor : null;
    /**
     * A field that is present but `null` means "the worker knows nothing", which
     * is the same thing as absent. Folding it in instead would make
     * `Number(null) === 0` turn "expectedTotal: null" into "0 of ~0".
     *
     * @param {string} key
     * @returns {unknown}
     */
    function pick(key) {
      if (reply[key] !== undefined && reply[key] !== null) return reply[key];
      var nested = cursor ? cursor[key] : undefined;
      return (nested !== undefined && nested !== null) ? nested : undefined;
    }

    /**
     * Whether the key is present AT ALL, `0` included. This is the only correct
     * test for "the worker told us", and it exists because `undefined`/`null`
     * folding (correct for `expectedTotal`, whose `0` is a sentinel) is exactly
     * what makes a naive `Number(pick(k)) > 0` reject a legitimate `0`.
     *
     * @param {string} key
     * @returns {boolean}
     */
    function has(key) {
      if (reply[key] !== undefined) return true;
      return !!(cursor && cursor[key] !== undefined);
    }

    var completed = pick('completed');
    var truncated = pick('truncated');
    var stopReason = pick('stopReason');
    var expected = Number(pick('expectedTotal'));
    // ABSENT and `0` are different facts and must not collapse. `pick()` already
    // returns `0` unchanged (only `undefined`/`null` fold to absent), so `has()`
    // plus a numeric coercion is the whole test — once, here, for every consumer.
    var missing = has('missing') && isFinite(Number(pick('missing')))
      ? Number(pick('missing')) : null;
    // `totalSeen` is what the contract calls it, but the STORED CURSOR counts the
    // unique clips it actually walked under `uniqueSeen` and `GET_BOOT.sync`
    // publishes that name — reading `totalSeen` alone there yields 0, and
    // "0 of ~5,500" over a 5,500-clip library is worse than no count at all. So
    // the first POSITIVE of the two names wins, and "no positive count" is
    // reported as unknown rather than as zero.
    var totalSeen = firstPositive(pick('totalSeen'), pick('uniqueSeen'));
    // `expectedTotal === 0` is the worker's "Suno reported no count" sentinel, so
    // it is treated as unknown for display.
    var expectedTotal = isFinite(expected) && expected > 0 ? expected : null;

    return {
      /** Did this reply say ANYTHING about completeness? */
      hasContract: completed !== undefined || truncated !== undefined ||
        stopReason !== undefined || expectedTotal !== null ||
        missing !== null || totalSeen !== null || Array.isArray(pick('workspaces')),
      completed: typeof completed === 'boolean' ? completed : null,
      truncated: typeof truncated === 'boolean' ? truncated : null,
      stopReason: typeof stopReason === 'string' ? stopReason.trim() : '',
      // `lastError` is the pre-contract spelling; accepting both means an old
      // worker still gets its real message instead of "unknown error".
      error: (pick('error') || pick('lastError')) ? String(pick('error') || pick('lastError')) : '',
      expectedTotal: expectedTotal,
      totalSeen: totalSeen,
      // The worker's `missing` is AUTHORITATIVE whenever the key is present as a
      // number — `0` included. `0` is the one value that most needs preserving:
      // the worker computes `missing` against rows EXAMINED (a clip in two
      // projects is counted twice) while publishing `totalSeen` as the UNIQUE
      // count, so `expectedTotal:5502, totalSeen:5501` with `missing:0` is a
      // COMPLETE library. Re-deriving here printed "1 clip is missing" on a
      // finished crawl, permanently. Derivation is the legacy-reply fallback and
      // runs only when the key is entirely absent.
      missing: missing !== null ? missing
        : (expectedTotal !== null && totalSeen !== null ? expectedTotal - totalSeen : null),
      // `oracleApplied === false` means the crawl ran with filters, so the counts
      // are a LOWER BOUND rather than a shortfall. Optional: absent means unknown.
      oracleApplied: pick('oracleApplied') === false ? false : (pick('oracleApplied') === true ? true : null),
      workspaces: Array.isArray(pick('workspaces')) ? pick('workspaces') : [],
      // Mechanical evidence that a walk HAPPENED. Not part of the completeness
      // contract, but the placeholder test needs it: `pagesDone:20, total:400`
      // is a real walk, and treating that reply as "nothing ran" would report a
      // legacy sync as "Never".
      pagesDone: Number(pick('pagesDone')) || 0,
      total: Number(pick('total')) || 0
    };
  }

  /** The shape a reply has when it carries nothing but emptiness. */
  var NO_WALK = {
    completed: null, truncated: null, stopReason: '', error: '',
    expectedTotal: null, totalSeen: null, missing: null, workspaces: [],
    pagesDone: 0, total: 0
  };

  /**
   * TRUE for the PLACEHOLDER reply an account with no finished walk gets:
   * `completed:false`, `stopReason:null`, `error:null`, `expectedTotal:0`,
   * `totalSeen:0`, `missing:0`, `truncated:false`. An explicit
   * `truncated:true` is NOT a placeholder — that one really is a short walk —
   * and neither is a record that walked a page or indexed a clip, which is
   * mechanical proof that something happened even when the verdict is missing.
   *
   * It says "no walk has finished", NOT "a walk stopped", and treating it as the
   * latter painted a brand-new install "Incomplete" forever. `expectedTotal:0`
   * is the worker's "Suno reported no count" sentinel, so it counts as empty here.
   *
   * @param {object|null} facts
   * @returns {boolean}
   */
  function isPlaceholderSyncFacts(facts) {
    if (!facts) return false;
    return !facts.completed && !facts.stopReason && !facts.error && facts.truncated !== true &&
      !(facts.pagesDone > 0) && !(facts.total > 0) &&
      (facts.totalSeen === null || facts.totalSeen <= 0) &&
      (facts.expectedTotal === null || facts.expectedTotal <= 0) &&
      (facts.missing === null || facts.missing <= 0);
  }

  /**
   * The three-way decision, in one place so the tile, the banner, the summary
   * and the log cannot disagree about whether the library is whole.
   *
   * THE RULE, AND IT IS THE WORKER'S CALL TO MAKE: when `completed` is present
   * as a BOOLEAN it is the verdict, and `missing` is NOT read to overturn it. The
   * worker computes `oracleApplied` (whether the walk was unfiltered, so that
   * `project.clip_count` measures the same set the walk did) and already ANDed
   * it into its own verdict, so a shortfall from a filtered walk reaches us as
   * ADVISORY: `completed:true, stopReason:'complete', oracleApplied:false,
   * missing:100`. Re-deriving failure from `missing` second-guessed a decision
   * that had been made with the walk's own evidence, and on this build it was
   * wrong on every sync — `includeTrashed` is hard-coded false in
   * `background/background.js`, so `oracleApplied` is `false` always, and any
   * account holding trashed or disliked clips got a permanent "Incomplete" over
   * a crawl the worker had called clean. That false alarm is what this rule
   * removes.
   *
   * The legacy heuristics below are kept whole, and only for a reply with NO
   * `completed` KEY at all: such a worker predates the oracle, so there is no
   * scoped verdict to respect and the counts are the only evidence there is. The
   * test for that is the KEY (`stated` below), never the folded value — a legacy
   * reply carrying `truncated:false` folds into `completed === true`, and taking
   * that fold at face value is what let a legacy `missing:177` render as "Up to
   * date" while the banner beneath it said the library was short.
   *
   * `truncated` remains the compatibility stand-in (`truncated` equals
   * `!completed` by contract) and a bare `stopReason: 'complete'` is believed,
   * since it is the same statement.
   *
   * @param {object|null} facts from `readSyncFacts`
   * @param {object|null} sync the worker's own sync record, for `state`
   * @returns {{kind:string, status:string, reason:string, error:string,
   *   counts:string, expectedTotal:number|null, totalSeen:number|null,
   *   missing:number|null, workspaces:object[]}}
   */
  function syncVerdict(facts, sync) {
    // A placeholder is a distinct KIND, not an incomplete walk: see
    // `isPlaceholderSyncFacts`.
    var placeholder = isPlaceholderSyncFacts(facts);
    var f = placeholder ? NO_WALK : (facts || {});
    var completed = f.completed;
    if (completed === null && f.truncated !== null) completed = f.truncated === false;
    if (completed === null && f.stopReason) completed = f.stopReason === 'complete';

    var missing = f.missing;
    /* Whether the worker actually STATED a verdict. This is the test the rule
     * turns on, and it is deliberately not `completed === null`: a legacy reply
     * carrying `truncated:false` or a bare `stopReason:'complete'` folds into a
     * `true` on the two lines below, so the fold cannot be what tells a reply
     * with a verdict from a reply without one. `hasContract` records the same
     * fact at the reply level; here it is the `completed` key specifically. */
    var stated = typeof f.completed === 'boolean';
    /* `oracleApplied === false` says the worker did NOT check `missing` against
     * `clip_count` — the walk was filtered, so the gap may be rows the filters
     * removed on purpose rather than rows the crawl missed. The figure still
     * ships (in `countsPhrase`, carrying the lower-bound caveat the worker asks
     * for in `advisory`), but it is not an established shortfall: it decides
     * nothing and it is never stated as "N clips are missing". Absent is not
     * `false`: a legacy reply said nothing about the oracle, and then the number
     * is the only evidence there is and it is used normally. */
    var unchecked = f.oracleApplied === false;
    var kind;
    if (!stated) {
      // NO `completed` KEY AT ALL — a worker that predates the contract, and with
      // it the oracle. Falling through to "incomplete" on nothing would paint
      // every legacy sync amber, so the previous behaviour is kept whole: only an
      // explicit error, an explicit `truncated`, or a positive `missing` makes it
      // incomplete. An error with no verdict still must not paint green.
      kind = (f.error || f.truncated === true || (missing !== null && missing > 0))
        ? 'incomplete' : 'complete';
    } else {
      // `completed` is present, so it IS the verdict. `missing` is deliberately
      // not read here — see the rule above.
      kind = (completed === true && !f.error) ? 'complete' : 'incomplete';
    }

    if (placeholder) kind = 'none';

    return {
      kind: kind,
      status: String((sync && sync.state) || 'idle'),
      stopReason: f.stopReason || '',
      reason: syncReasonPhrase(f.stopReason),
      error: f.error || '',
      expectedTotal: f.expectedTotal === undefined ? null : f.expectedTotal,
      totalSeen: f.totalSeen === undefined ? null : f.totalSeen,
      missing: (missing !== null && missing > 0 && !unchecked) ? missing : null,
      // Exact for a complete walk ("5,500 of 5,500"), approximate for an
      // incomplete one ("400 of ~5,500") because Suno's count can include
      // clips the crawl cannot reach, and "~" says so. The tilde is ALSO kept for
      // a filtered walk that finished: `expectedTotal` is then Suno's unfiltered
      // count measured against a filtered numerator, which is approximate
      // whatever the verdict says.
      counts: countsPhrase(f, kind === 'complete' && !unchecked),
      workspaces: f.workspaces || []
    };
  }

  /**
   * @param {object} f facts
   * @param {boolean} [exact] drop the "~"
   * @returns {string} '' when `expectedTotal` is unknown
   */
  function countsPhrase(f, exact) {
    if (f.expectedTotal === null || f.expectedTotal === undefined) return '';
    var expected = (exact ? '' : '~') + group(f.expectedTotal);
    var text = (f.totalSeen === null || f.totalSeen === undefined)
      ? expected : group(f.totalSeen) + ' of ' + expected;
    // `oracleApplied === false`: crawl filters ran, so Suno's count is a FLOOR on
    // what the walk could reach, not a target it fell short of. Saying "a lower
    // bound" stops the UI implying the user is missing clips they never asked for.
    return f.oracleApplied === false ? text + ' — a lower bound, filters applied' : text;
  }

  /**
   * THE ONE writer of the completeness contract onto `state.sync`.
   *
   * `SYNC_DONE` and `SYNC_ERROR` both go through here, which is the whole point:
   * they are the same event as far as the tile is concerned, and when `SYNC_ERROR`
   * wrote only `state.truncFacts` the tile kept the previous run's `completed:true`
   * and said "Up to date" directly above an INCOMPLETE banner. One writer means the
   * two paths cannot drift apart again.
   *
   * `overrides` supplies the fields a given path must assert regardless of what
   * the worker sent — a hard failure has no `completed:true` to inherit, and
   * `stopReason` has a documented fallback. Mechanical counters (`pagesDone`,
   * `dislikedCount`, `durationMs`, `state`) are still read off the reply, so a
   * `SYNC_ERROR` that carries progress keeps it.
   *
   * @param {object} msg the `SYNC_DONE` / `SYNC_ERROR` push
   * @param {object} [overrides] contract fields this path asserts
   * @returns {object} the facts now on `state.sync`
   */
  function applySyncReply(msg, overrides) {
    var over = overrides || {};
    var view = Object.assign({}, msg || {}, over);
    var facts = readSyncFacts(view);
    var next = {};
    var prev = (state.sync && typeof state.sync === 'object') ? state.sync : {};
    for (var key in prev) {
      if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key];
    }
    if (typeof msg.pagesDone === 'number') next.pagesDone = msg.pagesDone;
    if (typeof msg.dislikedCount === 'number') next.dislikedCount = msg.dislikedCount;
    if (typeof msg.durationMs === 'number') next.lastDurationMs = msg.durationMs;
    // `state` is read off the MERGED view so an override wins. `SYNC_ERROR` carries
    // no `state` of its own, and the tile's "Failed" label is gated on
    // `status === 'error'` — without this the override would be dropped and the
    // tile would read "Incomplete" (or inherit a stale `'idle'`) instead.
    if (typeof view.state === 'string') next.state = view.state;
    if (facts.completed !== null) next.completed = facts.completed;
    if (facts.truncated !== null) next.truncated = facts.truncated;
    next.stopReason = facts.stopReason;
    // `error` AND `lastError` are both written, from the one value read. A clean
    // `SYNC_DONE` therefore retracts a stale error left in the record by an
    // earlier run, instead of leaving a permanent amber tile behind a green one.
    next.error = facts.error;
    next.lastError = facts.error;
    next.expectedTotal = facts.expectedTotal;
    next.totalSeen = facts.totalSeen;
    // `missing` is written verbatim, `0` included — see `readSyncFacts`. A
    // derived `null` is still written so a stale count from a previous run cannot
    // outlive the reply that should have replaced it.
    next.missing = facts.missing;
    next.oracleApplied = facts.oracleApplied;
    next.workspaces = facts.workspaces;
    state.sync = next;
    return facts;
  }

  /**
   * Fold a `GET_BOOT.sync` record into the one already held.
   *
   * Mechanical counters (`pagesDone`, `total`, `state`, …) always take the fresh
   * value. The VERDICT fields take it too — EXCEPT when the record already held
   * carries `completed`, in which case a re-read of a less-informed boot reply
   * must not overrule a verdict that arrived on a `SYNC_DONE` push. Without that
   * rule the boot read undid the fix: the tile dropped back to a bare fallback
   * reason the moment `refreshBootSafe()` landed after the push.
   *
   * @param {object|null} stored
   * @param {object} boot
   * @returns {object}
   */
  function mergeSyncRecord(stored, boot) {
    var out = {};
    var source = stored && typeof stored === 'object' ? stored : {};
    for (var i in source) {
      if (Object.prototype.hasOwnProperty.call(source, i)) out[i] = source[i];
    }
    var storedIsAuthoritative = source.completed !== undefined;
    for (var key in boot) {
      if (!Object.prototype.hasOwnProperty.call(boot, key)) continue;
      if (storedIsAuthoritative && VERDICT_FIELDS[key] === 1) continue;
      out[key] = boot[key];
    }
    return out;
  }

  /** The fields that answer "is the library whole?", as opposed to how far it got. */
  var VERDICT_FIELDS = {
    completed: 1, stopReason: 1, error: 1, lastError: 1,
    expectedTotal: 1, totalSeen: 1, missing: 1, workspaces: 1, oracleApplied: 1
  };

  /**
   * The facts that justify the persistent banner, or null for "say nothing".
   *
   * `completed === false` is the gate; `truncated === true` is accepted for a
   * worker that predates it, and a `stopReason` other than `complete` counts as
   * too. A reply carrying none of these leaves the existing decision alone
   * rather than inventing a warning or clearing a real one on no evidence.
   *
   * @param {object|null} facts
   * @returns {object|null}
   */
  function bannerFacts(facts) {
    if (!facts) return null;
    // Evidence that NO walk finished is not evidence that a walk stopped.
    if (isPlaceholderSyncFacts(facts)) return null;
    // The rule is stated once, in `syncVerdict`: a `completed` boolean present on
    // the reply is the worker's verdict and is not second-guessed here either.
    // `completed:false` is still a failure, so oracle scoping can never hide one.
    if (facts.completed === false) return facts;
    if (facts.completed === true) return null;
    // ---- LEGACY REPLIES ONLY (no `completed` key). These predate the oracle,
    // so the count heuristics are all the evidence there is.
    if (facts.truncated === true) return facts;
    if (facts.stopReason && facts.stopReason !== 'complete') return facts;
    if (facts.expectedTotal !== null && facts.missing !== null && facts.missing > 0) return facts;
    return null;
  }

  /**
   * The lead sentence of the incompleteness banner. Identical wording in the
   * popup, the side panel and the dock, because it is the sentence a user
   * screenshots into a bug report.
   *
   * @param {object} verdict
   * @returns {string}
   */
  function bannerSentence(verdict) {
    var parts = ['The last sync stopped early — the index is INCOMPLETE and some clips are missing.'];
    var why = sentence(verdict.reason) + (verdict.error ? ' (' + verdict.error + ')' : '') + '.';
    parts.push(why);
    if (verdict.counts) parts.push('Indexed ' + verdict.counts + '.');
    if (verdict.missing !== null) {
      parts.push(group(verdict.missing) + ' ' + plural(verdict.missing, 'clip') + ' ' +
        (verdict.missing === 1 ? 'is' : 'are') + ' missing.');
    }
    if (verdict.stopReason === 'max_pages') {
      parts.push('Raise "Max pages per sync" in Settings, then sync again.');
    } else if (verdict.stopReason === 'aborted') {
      parts.push('Nothing is broken — start the sync again when you are ready.');
    } else {
      parts.push('Sync again to finish the crawl; the activity log names the reason.');
    }
    return parts.join(' ');
  }

  /* ------------------------------------------------------------ transport */

  /**
   * A request that the worker refused, or that never reached it.
   * @param {string} message
   * @param {string} code
   */
  function ReqError(message, code) {
    var err = new Error(message);
    err.name = 'ReqError';
    err.code = code || 'failed';
    return err;
  }

  /**
   * Send one request and REQUIRE a successful reply.
   *
   * This never resolves with a falsy value, so no call site can accidentally
   * treat a failure as success. It rejects when the worker is unreachable, when
   * it does not reply, and when it replies `{ok:false}`.
   *
   * @param {string} type one of the router's declared request types
   * @param {object} [payload]
   * @returns {Promise<object>} the `ok:true` reply body
   */
  function send(type, payload) {
    dbg('send', type, payload || null);
    return chrome.runtime.sendMessage({ type: type, payload: payload || {} }).then(
      function (reply) {
        if (!reply || typeof reply !== 'object') {
          throw ReqError('The background worker did not reply to ' + type + '. It may have just been restarted.', 'no_reply');
        }
        if (reply.ok !== true) {
          throw ReqError(reply.error || (type + ' failed'), reply.code || 'failed');
        }
        dbg('reply', type, reply);
        return reply;
      },
      function (transportErr) {
        throw ReqError('The background worker is not reachable (' + textOf(transportErr) + ').', 'no_worker');
      }
    );
  }

  /* ---------------------------------------------------------------- toast */

  var toastTimer = null;

  /**
   * @param {string} message plain text — never markup
   * @param {'ok'|'bad'|'warn'|''} [kind]
   */
  function toast(message, kind) {
    var existing = document.querySelector('.sm-toast');
    if (existing) existing.remove();
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    var node = document.createElement('div');
    node.className = 'sm-toast' + (kind ? ' is-' + kind : '');
    node.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    // `popup.css` styles `.is-ok` and `.is-bad` only, and this file does not own
    // that stylesheet, so the warning tint is applied inline from the palette
    // variable the stylesheet already declares. A quota halt is neither of the
    // two, and a green toast for it is the bug.
    if (kind === 'warn') {
      node.style.borderColor = 'var(--sm-warn)';
      node.style.color = 'var(--sm-warn)';
    }
    node.textContent = message;
    document.body.appendChild(node);
    toastTimer = setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
      if (toastTimer !== null) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
    }, kind === 'bad' ? 6000 : (kind === 'warn' ? 5000 : 2800));
  }

  /* ---------------------------------------------------- outcome controls */

  /**
   * The recovery affordance under the summary, and the header Refresh button.
   *
   * `popup.html` is not this file's to change, so both controls are built from
   * real DOM nodes with real `textContent` and real listeners and inserted into
   * containers that already exist. Both reuse the stylesheet's existing button
   * classes rather than introducing new markup vocabulary.
   */
  var outcomeRow = null;
  var outcomeBtn = null;
  var outcomeHandler = null;
  var refreshBtn = null;

  function ensureOutcomeRow() {
    if (outcomeRow) return outcomeRow;
    outcomeRow = document.createElement('div');
    outcomeRow.id = 'sm-outcome-actions';
    outcomeRow.style.display = 'flex';
    outcomeRow.style.flexWrap = 'wrap';
    outcomeRow.style.gap = '6px';
    outcomeRow.style.marginBottom = '11px';
    outcomeRow.hidden = true;

    outcomeBtn = document.createElement('button');
    outcomeBtn.type = 'button';
    outcomeBtn.className = 'sm-btn sm-tiny';
    outcomeBtn.addEventListener('click', function () {
      if (typeof outcomeHandler === 'function') outcomeHandler();
    });

    outcomeRow.appendChild(outcomeBtn);
    els.summary.parentNode.insertBefore(outcomeRow, els.summary.nextSibling);
    return outcomeRow;
  }

  /**
   * @param {string} label visible text
   * @param {string} ariaLabel
   * @param {() => void} handler
   */
  function showOutcomeAction(label, ariaLabel, handler) {
    ensureOutcomeRow();
    outcomeBtn.textContent = label;
    outcomeBtn.setAttribute('aria-label', ariaLabel);
    outcomeHandler = handler;
    outcomeBtn.disabled = false;
    outcomeRow.hidden = false;
  }

  function clearOutcomeAction() {
    if (!outcomeRow) return;
    outcomeRow.hidden = true;
    outcomeHandler = null;
  }

  function ensureRefreshButton() {
    if (refreshBtn) return refreshBtn;
    refreshBtn = document.createElement('button');
    refreshBtn.id = 'sm-refresh';
    refreshBtn.type = 'button';
    refreshBtn.className = 'sm-btn sm-ghost sm-tiny';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.setAttribute('aria-label', 'Re-read the batch state, download balance and library counts from the background worker');
    refreshBtn.addEventListener('click', onRefreshClick);
    els.btnOptions.parentNode.insertBefore(refreshBtn, els.btnOptions);
    return refreshBtn;
  }

  /* ------------------------------------------------------------------ log */

  var LOG_CAP = 60;

  function clockNow() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /**
   * Append one activity row. The message is written with `textContent`, which
   * is what makes an HTML-parsing sink structurally impossible here.
   *
   * @param {string} message
   * @param {'ok'|'bad'|'warn'|'info'} [kind]
   */
  function addLog(message, kind) {
    var row = document.createElement('li');
    row.className = 'sm-log-row' + (kind ? ' is-' + kind : '');

    var time = document.createElement('span');
    time.className = 'sm-log-time';
    time.textContent = clockNow();

    var body = document.createElement('span');
    body.className = 'sm-log-msg';
    body.textContent = message;

    row.appendChild(time);
    row.appendChild(body);
    els.log.insertBefore(row, els.log.firstChild);

    while (els.log.childElementCount > LOG_CAP) {
      els.log.removeChild(els.log.lastElementChild);
    }
  }

  /* ------------------------------------------------------------ rendering */

  function renderAuth(token) {
    var info = token && typeof token === 'object' ? token : {};
    els.auth.classList.remove('is-ok', 'is-bad');

    if (info.badToken === true) {
      els.auth.classList.add('is-bad');
      els.auth.textContent = 'Suno rejected the saved session token. Sign out and back in on suno.com, then retry. No retry will help until you do.';
      return;
    }
    if (info.hasToken !== true) {
      els.auth.classList.add('is-bad');
      els.auth.textContent = 'Not signed in. Open suno.com in a tab and sign in — click here to open it.';
      return;
    }
    var seconds = Number(info.secondsRemaining);
    if (isFinite(seconds) && seconds <= 0) {
      els.auth.classList.add('is-bad');
      els.auth.textContent = 'Session expired. Sign in again on suno.com — click here to open it.';
      return;
    }
    els.auth.classList.add('is-ok');
    els.auth.textContent = isFinite(seconds)
      ? 'Signed in. Session token valid for about ' + formatDuration(seconds * 1000) + ' more.'
      : 'Signed in. Session token present.';
  }

  function renderLibraryTile() {
    var counts = (state.bootCounts && typeof state.bootCounts === 'object') ? state.bootCounts : null;
    var total = null;
    if (typeof state.libraryTotal === 'number' && isFinite(state.libraryTotal)) total = state.libraryTotal;
    else if (counts && typeof counts.clips === 'number') total = counts.clips;

    els.tileClips.textContent = typeof total === 'number' ? String(total) : '—';
    if (typeof total !== 'number') {
      els.tileClipsNote.textContent = 'no local library yet';
    } else if (total === 0) {
      els.tileClipsNote.textContent = 'run a sync to build the index';
    } else {
      els.tileClipsNote.textContent = 'indexed locally';
    }
  }

  /**
   * Paint the tile.
   *
   * `text` is the WORD — `Up to date`, `Incomplete`, `Failed`, `Cancelled` — and
   * it is the primary signal: the colour is decoration on top of it, never the
   * only carrier (header note J). `colour` is applied INLINE because
   * `popup.css` has no warn tile rule and this file does not own that
   * stylesheet.
   *
   * `full` is the unabbreviated sentence. It goes on `title` and `aria-label`
   * because BOTH fields ellipsize inside a ~90 px tile: the counts a complete
   * walk has to show ("Up to date — 5,500 of 5,500") do not fit at 17 px, and a
   * clipped "Up to date — 5,5…" tells the user nothing. The visible note still
   * carries the same numbers.
   *
   * @param {string} text the state word
   * @param {string} [colour] '' | 'var(--sm-warn)' | 'var(--sm-bad)'
   * @param {string} [full] the unabbreviated sentence
   */
  function setSyncValue(text, colour, full) {
    els.tileSync.textContent = text;
    els.tileSync.style.color = colour || '';
    els.tileSync.title = full || '';
    els.tileSync.setAttribute('aria-label', full || text);
  }

  /**
   * Join the note fragments that are actually present, dropping separators
   * rather than emitting `' · '` twice.
   *
   * @param {string[]} parts
   * @returns {string}
   */
  function joinParts(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i]) out.push(parts[i]);
    }
    return out.join(' · ');
  }

  function renderSyncTile() {
    // A live region on the WORD, so a screen reader announces "Incomplete" the
    // moment the walk finishes badly. `aria-describedby` points at the note, so
    // the reason is the accessible description of the same node.
    if (els.tileSync.getAttribute('aria-live') !== 'polite') {
      els.tileSync.setAttribute('role', 'status');
      els.tileSync.setAttribute('aria-live', 'polite');
      els.tileSync.setAttribute('aria-atomic', 'true');
      els.tileSync.setAttribute('aria-describedby', 'sm-tile-sync-note');
    }

    if (state.syncOrphaned) {
      setSyncValue('Interrupted', 'bad', 'The extension worker was stopped mid-crawl. Indexed clips are kept — press Sync to resume.');
      els.tileSyncNote.textContent = state.syncPagesDone > 0
        ? group(state.syncPagesDone) + (state.syncPagesDone === 1 ? ' page crawled' : ' pages crawled')
          + (state.syncSeen > 0 ? ' · ' + group(state.syncSeen) + ' indexed' : '')
        : 'the crawl stopped before it reported a page';
      return;
    }
    if (state.syncRunning) {
      setSyncValue(state.syncCancelling ? 'Stopping' : 'Syncing', '', 'Crawling your Suno feed. Nothing is downloaded.');
      // The page cap is PER WORKSPACE and this counter is the RUN total, so
      // "73 of 200 pages" implied a bound the run is not held to. Report the
      // crawl count and name the cap for what it is.
      var tileSeen = state.syncSeen > 0 ? ' · ' + group(state.syncSeen) + ' seen' : '';
      els.tileSyncNote.textContent = state.syncPagesDone > 0
        ? group(state.syncPagesDone) + (state.syncPagesDone === 1 ? ' page crawled' : ' pages crawled')
          + (state.syncMaxPages ? ' · cap ' + state.syncMaxPages + '/workspace' : '') + tileSeen
        : 'crawling the feed' + tileSeen;
      return;
    }
    var sync = state.sync || null;
    if (!sync) {
      setSyncValue('Never', '', 'No sync has run yet.');
      els.tileSyncNote.textContent = 'no sync has run';
      return;
    }

    var verdict = syncVerdict(readSyncFacts(sync), sync);
    var pages = (sync.pagesDone || 0) + ' pages';
    var dislikes = (sync.dislikedCount !== null && sync.dislikedCount !== undefined
      ? sync.dislikedCount + ' dislikes known'
      : 'dislikes partial');
    var missing = verdict.missing !== null
      ? group(verdict.missing) + ' ' + plural(verdict.missing, 'clip') + ' missing'
      : '';

    if (verdict.status === 'cancelled') {
      // Neutral, and explicitly NOT an error: the user did this.
      setSyncValue('Cancelled', '', 'The last sync was cancelled by you. ' + verdict.reason + '. ' + pages + '.');
      els.tileSyncNote.textContent = joinParts([verdict.reason, verdict.counts, missing]);
      return;
    }

    if (verdict.kind === 'none') {
      // Nothing has ever finished walking the feed: this is the pre-contract
      // "Never" state, not a failure.
      setSyncValue('Never', '', 'No sync has finished walking your feed yet.');
      els.tileSyncNote.textContent = joinParts([pages]);
      return;
    }

    if (verdict.kind === 'complete') {
      setSyncValue('Up to date', '',
        'Up to date' + (verdict.counts ? ' — ' + verdict.counts : '') + '. ' + pages + '.');
      els.tileSyncNote.textContent = joinParts([verdict.counts, pages, dislikes]);
      return;
    }

    // One sentence, reused for the hover text, the accessible name and the note,
    // so the three can never describe the same failure differently.
    var why = sentence(verdict.reason) + (verdict.error ? ' (' + verdict.error + ')' : '') + '.';
    var full = 'The last sync is INCOMPLETE. ' + why
      + (verdict.counts ? ' Indexed ' + verdict.counts + '.' : '')
      + (verdict.missing !== null ? ' ' + group(verdict.missing) + ' ' + plural(verdict.missing, 'clip') + ' missing.' : '');
    if (verdict.status === 'error') {
      setSyncValue('Failed', 'var(--sm-bad)', 'The last sync failed. ' + full);
    } else {
      setSyncValue('Incomplete', 'var(--sm-warn)', full);
    }
    els.tileSyncNote.textContent = joinParts([verdict.reason + (verdict.error ? ' (' + verdict.error + ')' : ''), verdict.counts, missing]);
  }

  function renderQuotaTile() {
    var quota = state.quota;
    els.tileQuotaBox.classList.remove('is-empty', 'is-low');

    if (!quota) {
      els.tileQuota.textContent = '—';
      els.tileQuotaNote.textContent = 'quota not fetched yet';
      return;
    }
    if (quota.unlimited === true) {
      els.tileQuota.textContent = '∞';
      els.tileQuotaNote.textContent = 'no monthly cap';
      return;
    }
    var remaining = null;
    if (typeof quota.effectiveRemaining === 'number') remaining = quota.effectiveRemaining;
    else if (typeof quota.remaining === 'number') remaining = quota.remaining;

    if (remaining === null) {
      els.tileQuota.textContent = '—';
      els.tileQuotaNote.textContent = quota.plan ? String(quota.plan) + ' plan, limit unknown' : 'Suno reported no limit';
      return;
    }
    els.tileQuota.textContent = String(Math.max(0, remaining));

    var limit = typeof quota.limit === 'number' ? quota.limit : null;
    var head = limit === null ? '' : ' of ' + limit;
    var reset = quota.resetsOn ? ' · resets ' + formatDate(quota.resetsOn) : '';
    var plan = quota.plan ? String(quota.plan) : '';

    els.tileQuotaNote.textContent = head + (plan ? ' ' + plan + ' plan' : '') + reset;
    els.tileQuotaBox.title = 'Suno counts one song as one download, whatever the format. '
      + 'The ladder below decides whether a batch touches this meter at all.';

    if (remaining <= 0) els.tileQuotaBox.classList.add('is-empty');
    else if (limit !== null && remaining <= Math.max(1, Math.ceil(limit * 0.2))) els.tileQuotaBox.classList.add('is-low');
  }

  function renderCreditsTile() {
    var credits = state.credits;
    if (!credits) {
      els.tileCredits.textContent = '—';
      return;
    }
    var monthly = typeof credits.monthly === 'number' ? credits.monthly : null;
    var total = typeof credits.total === 'number' ? credits.total : null;
    if (monthly === null && total === null) {
      els.tileCredits.textContent = '—';
      return;
    }
    els.tileCredits.textContent = (monthly !== null ? String(monthly) : '—')
      + (total !== null && total !== monthly ? ' / ' + String(total) : '');
    els.tileCredits.title = 'Credits are a different resource from downloads. A full credit balance '
      + 'does not mean you have any downloads left.';
  }

  /** Real percentage: nothing here is estimated from a page counter. */
  function currentPercent() {
    if (state.activity === 'sync') {
      // The only honest denominator is Suno's own count for the account. The old
      // ratio (`syncPagesDone / syncMaxPages`) divided a RUN total by a
      // PER-WORKSPACE cap, which produced a number that meant nothing and was
      // the "37%" the user saw frozen at 73 pages. With no expected total, the
      // bar is indeterminate rather than confidently wrong.
      var facts = state.sync || null;
      var expected = facts && isFinite(Number(facts.expectedTotal)) && Number(facts.expectedTotal) > 0
        ? Number(facts.expectedTotal)
        : null;
      if (expected === null || state.syncSeen <= 0) return null;
      // The crawl is filtered by default (trashed and disliked excluded), so the
      // indexed total will legitimately finish below Suno's count. Clamp rather
      // than let the bar sit pinned at a misleading value.
      return clampInt((state.syncSeen / expected) * 100, 0, 100, 0);
    }
    if (state.activity === 'download') {
      if (!state.downloadTotal) return null;
      return clampInt((state.downloadDone / state.downloadTotal) * 100, 0, 100, 0);
    }
    return null;
  }

  function renderProgress() {
    var percent = currentPercent();
    var label;
    var detail;
    var fill = els.progressFill;

    if (state.activity === 'sync') {
      label = state.syncCancelling ? 'Stopping the library sync' : 'Syncing library';
      // `syncMaxPages` is a PER-WORKSPACE cap, while `syncPagesDone` is the
      // run total across every workspace. Pairing them ("page 73 of 200") implied
      // a bound that does not exist — a 20-workspace library can legitimately
      // need far more than one workspace's cap — so the run total is now labelled
      // as a crawl count and the cap is named as what it is.
      var pageText = state.syncPagesDone > 0
        ? group(state.syncPagesDone) + (state.syncPagesDone === 1 ? ' page crawled' : ' pages crawled')
        : 'starting';
      // Never render a confident 0 for a cumulative count: "0 clips seen" beside
      // a running bar reads as "nothing has been fetched", which is a different
      // and much more alarming claim than "not known yet".
      var seenText = state.syncSeen > 0
        ? group(state.syncSeen) + (state.syncSeen === 1 ? ' clip seen' : ' clips seen')
        : 'clips seen —';
      // WHICH PHASE. A sync spends most of its wall clock paging `/api/project/me`
      // and `/api/project/feed` (~180 pages) before it indexes a single clip, so
      // without this the progress line read "starting · clips seen —" for minutes
      // and looked like a dead crawl. The phase names the work that is happening.
      var phaseText = '';
      if (state.syncPhase === 'planning') {
        phaseText = 'listing your workspaces';
      } else if (state.syncPhase === 'mapping') {
        var mapped = state.syncPhasePages > 0 ? state.syncPhasePages + ' pages' : '';
        phaseText = 'mapping clips to workspaces' + (mapped ? ' · ' + mapped : '')
          + (state.syncPhaseJoined > 0 ? ' · ' + group(state.syncPhaseJoined) + ' joined' : '')
          + ' · no clips indexed yet';
      } else if (state.syncPhase === 'crawling') {
        phaseText = 'crawling your library';
      } else if (state.syncPhase === 'committing') {
        phaseText = 'writing the index';
      }
      detail = (phaseText ? phaseText + ' · ' : '') + pageText + ' · ' + seenText
        + (state.syncEtaMs > 0 && !state.syncCancelling ? ' · ~' + formatDuration(state.syncEtaMs) + ' left' : '')
        + (state.syncCancelling ? ' · waiting for the current page to finish' : '');
      if (state.syncCancelling) {
        // A cancelling run is not making progress; a live percentage would keep
        // implying otherwise until the worker actually unwinds.
        els.progressPct.textContent = 'stopping';
        els.progressFill.style.width = '100%';
        fill.classList.add('is-indeterminate');
      } else if (percent === null) {
        els.progressPct.textContent = 'working';
        els.progressFill.style.width = '100%';
        fill.classList.add('is-indeterminate');
      } else {
        els.progressPct.textContent = percent + '%';
        els.progressFill.style.width = percent + '%';
      }
    } else if (state.activity === 'download') {
      label = 'Downloading';
      var current = state.downloadCurrentTitle ? ' · ' + state.downloadCurrentTitle : '';
      detail = state.downloadDone + ' of ' + state.downloadTotal + ' done'
        + ' · ' + state.downloadOk + ' ok, ' + state.downloadFailed + ' failed, ' + state.downloadSkipped + ' skipped'
        + (state.downloadEtaMs > 0 ? ' · ~' + formatDuration(state.downloadEtaMs) + ' left' : '')
        + current;
      if (percent === null) {
        els.progressPct.textContent = 'working';
        els.progressFill.style.width = '100%';
      } else {
        els.progressPct.textContent = percent + '%';
        els.progressFill.style.width = percent + '%';
        if (percent >= 100) fill.classList.add('is-done');
        else fill.classList.remove('is-done');
      }
    } else {
      label = 'Idle';
      detail = ' ';
      els.progressPct.textContent = '—';
      fill.style.width = '0%';
      fill.classList.remove('is-done', 'is-indeterminate');
    }

    els.progressLabel.textContent = label;
    els.progressDetail.textContent = detail;
    els.progressDetail.title = detail;

    var shown = percent === null ? 0 : percent;
    els.progressTrack.setAttribute('aria-valuenow', String(shown));
    els.progressTrack.setAttribute('aria-valuetext', label + ': ' + (percent === null ? 'in progress' : percent + '%'));
  }

  /**
   * Three severities, and they are not interchangeable: a hard failure is red,
   * a deliberate stop (quota, and a preflight shortfall) is amber, and
   * everything else is unstyled. `is-warn` has no rule in `popup.css` — which
   * this file does not own — so the amber border is applied inline from the same
   * palette variable and cleared on every render.
   */
  function summaryKind() {
    if (state.summaryIsBad === true || state.summaryKind === 'bad') return 'bad';
    return state.summaryKind === 'warn' ? 'warn' : '';
  }

  function renderSummary() {
    var box = els.summary;
    var kind = summaryKind();
    box.classList.remove('is-bad', 'is-warn');
    box.style.borderColor = '';
    var lines = state.summaryLines || [];
    if (!lines.length) {
      box.hidden = true;
      els.summaryText.textContent = '';
      els.summaryQuota.textContent = '';
      return;
    }
    box.hidden = false;
    els.summaryText.textContent = lines.join(' · ');
    if (kind === 'bad') box.classList.add('is-bad');
    else if (kind === 'warn') {
      box.classList.add('is-warn');
      box.style.borderColor = 'var(--sm-warn)';
    }
    els.summaryQuota.textContent = state.summaryQuotaText || '';
  }

  /**
   * The persistent incompleteness banner. Gated on `completed === false` via
   * `bannerFacts()`, and it says the ACTUAL cause: the previous copy told every
   * user "the page cap was reached", which was false for the failure that
   * mattered most — a request that 500'd on page 21.
   */
  function renderTruncated() {
    var facts = bannerFacts(state.truncFacts);
    if (!facts) {
      els.truncated.hidden = true;
      els.truncatedText.textContent = '';
      els.truncated.removeAttribute('title');
      return;
    }
    var verdict = syncVerdict(facts, state.sync);
    var text = bannerSentence(verdict) + ' "Download all" queues only what is indexed.';
    els.truncated.hidden = false;
    els.truncatedText.textContent = text;
    els.truncated.title = text;
  }

  function renderButtons() {
    var settings = state.settings || {};
    var ladder = Array.isArray(settings.downloadSource) ? settings.downloadSource : [];
    var meteredCount = 0;
    for (var i = 0; i < ladder.length; i += 1) {
      if (isMeteredRung(ladder[i])) meteredCount += 1;
    }
    // Built as a whole string FIRST. The previous build concatenated
    // `'…' + meteredCount ? a : b`, which tested a non-empty string and so always
    // took the metered branch: "No metered rungs are enabled" was unreachable.
    var costNote = meteredCount > 0
      ? 'The ladder contains ' + meteredCount + ' metered ' + plural(meteredCount, 'rung') + ', which can spend downloads.'
      : 'No metered rungs are enabled, so this spends no downloads.';

    if (state.selectionCount > 0) {
      els.btnDownload.textContent = 'Download ' + state.selectionCount + ' selected';
      els.btnDownload.setAttribute(
        'aria-label',
        'Download the ' + state.selectionCount + ' clips currently selected. ' + costNote
      );
    } else {
      els.btnDownload.textContent = 'Download everything…';
      els.btnDownload.setAttribute(
        'aria-label',
        'No clips are selected, so this queues every indexed clip. ' + costNote
      );
    }

    els.btnSync.disabled = state.busy || state.syncRunning;
    els.btnSync.title = libraryEmpty()
      ? 'Your library is empty — this will be a first sync of the whole feed.'
      : 'Resume or extend the crawl of your Suno feed. Nothing is downloaded.';
    els.btnDownload.disabled = state.busy || state.downloadRunning || libraryEmpty();
    /* An orphaned cursor also needs clearing, so the button stays enabled for it —
     * otherwise the user is shown a frozen "Syncing" with no way to clear it,
     * * which is exactly the dead end this state used to be. */
    els.btnCancel.disabled = state.busy || !(state.syncRunning || state.downloadRunning || state.syncOrphaned);
    els.btnCancel.textContent = state.downloadRunning
      ? 'Stop batch'
      : (state.syncOrphaned ? 'Clear stale sync' : (state.syncRunning ? 'Stop sync' : 'Cancel'));
    els.btnPanel.disabled = state.busy;
    if (refreshBtn) refreshBtn.disabled = state.busy;
    if (outcomeBtn) outcomeBtn.disabled = state.busy;
  }

  function renderAll() {
    renderAuth(state.token);
    renderLibraryTile();
    renderSyncTile();
    renderQuotaTile();
    renderCreditsTile();
    renderProgress();
    renderSummary();
    renderTruncated();
    renderButtons();
  }

  /* ------------------------------------------------- ladder cost classes */

  /**
   * The rungs whose ids the worker declares METERED (§1 `LADDER_RUNGS`). The ids
   * are duplicated here rather than fetched so the popup can render instantly
   * from `GET_BOOT` and stay correct if the ladder array is empty.
   */
  var METERED_RUNGS = ['studio', 'download-route', 'wav-official', 'zip'];
  var UNMETERED_RUNGS = ['progressive', 'mango-drm'];

  function isMeteredRung(id) {
    return METERED_RUNGS.indexOf(String(id)) >= 0;
  }

  function isUnmeteredRung(id) {
    return UNMETERED_RUNGS.indexOf(String(id)) >= 0;
  }

  /**
   * Plain-language statement of what a batch will cost. Deliberately blunt: the
   * ladder falls through to the next rung when one fails for a clip, so a
   * metered rung sitting below the unmetered ones is still reachable.
   *
   * @param {number} clipCount
   * @returns {string} the warning body, or '' when no download can be spent
   */
  function meteredWarningFor(clipCount) {
    var ladder = (state.settings && Array.isArray(state.settings.downloadSource))
      ? state.settings.downloadSource : [];
    var metered = ladder.filter(isMeteredRung);
    var unmetered = ladder.filter(isUnmeteredRung);

    if (!metered.length) {
      return 'Every enabled rung (' + (unmetered.join(', ') || 'none') + ') is UNMETERED, so this batch '
        + 'cannot spend any of your monthly downloads.';
    }
    var warn = 'Your ladder has ' + metered.length + ' METERED ' + plural(metered.length, 'rung')
      + ' (' + metered.join(', ') + '). Only ' + (unmetered.join(', ') || 'no unmetered rungs')
      + ' avoid Suno\'s download meter; one song costs one download whatever the format. '
      + 'If an unmetered rung fails for a clip, the driver falls through to the next rung in the order, '
      + 'so a batch of ' + clipCount + ' ' + plural(clipCount, 'clip') + ' can spend up to ' + clipCount + ' downloads.';
    if (state.quota && typeof state.quota.effectiveRemaining === 'number') {
      warn += ' You have ' + state.quota.effectiveRemaining + ' left';
      if (state.quota.resetsOn) warn += ' before the reset on ' + formatDate(state.quota.resetsOn);
      warn += '.';
    }
    return warn;
  }

  /* -------------------------------------------------------- DOWNLOAD_START */

  /**
   * Build the `DOWNLOAD_START` payload, or refuse to build one.
   *
   * The previous build sent `{}`, which `resolveBatchClips` read as "filter
   * nothing, i.e. the whole library" — and it did that from a button labelled
   * "Download Selected". Here there are exactly two shapes, and an empty one is
   * not constructible:
   *
   *   { ids: [...] }  an explicit id list from `GET_SELECTION`
   *   { spec: {...} } an EXPLICIT spec naming the whole library, and only ever
   *                   after the user has confirmed it
   *
   * @param {string[]} ids the current selection
   * @returns {object}
   */
  function buildDownloadPayload(ids) {
    var settings = state.settings || {};
    var payload = {
      variant: settings.variant,
      source: Array.isArray(settings.downloadSource) ? settings.downloadSource.slice() : undefined,
      tagOptions: settings.tagOptions,
      overwrite: settings.overwrite === true
    };
    if (payload.source === undefined) delete payload.source;

    var list = [];
    var seen = Object.create(null);
    var raw = Array.isArray(ids) ? ids : [];
    for (var i = 0; i < raw.length; i += 1) {
      var id = String(raw[i] || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      list.push(id);
    }

    if (list.length) {
      payload.ids = list;
    } else {
      // No selection. Name the whole library EXPLICITLY rather than relying on
      // an absent filter meaning "everything".
      payload.spec = { includeUnassigned: true, sort: 'newest', order: 'desc' };
    }

    assertDownloadPayload(payload);
    return payload;
  }

  /**
   * Structural guarantee for the audit finding: a `DOWNLOAD_START` payload with
   * neither a non-empty `ids` array nor a non-empty `spec` object can never
   * leave this file.
   *
   * @param {object} payload
   * @returns {object} the same payload
   */
  function assertDownloadPayload(payload) {
    var hasIds = Array.isArray(payload.ids) && payload.ids.length > 0;
    var hasSpec = !!payload.spec && typeof payload.spec === 'object' && Object.keys(payload.spec).length > 0;
    if (!hasIds && !hasSpec) {
      throw ReqError('Refusing to send an empty DOWNLOAD_START payload. Pass an explicit id list or an explicit filter.', 'empty_payload');
    }
    return payload;
  }

  /* --------------------------------------------------------------- actions */

  /**
   * Wrap an async action so `state.busy` and the buttons stay honest, and so a
   * rejection can never escape as an unhandled promise rejection: the returned
   * promise always RESOLVES, after reporting the failure to the activity log
   * and the toast.
   *
   * @param {() => Promise<*>} fn
   * @returns {() => Promise<void>}
   */
  function withBusy(fn) {
    return function () {
      if (state.busy) return Promise.resolve();
      state.busy = true;
      renderButtons();
      var result;
      try {
        result = fn();
      } catch (syncErr) {
        state.busy = false;
        renderButtons();
        addLog('Action failed: ' + textOf(syncErr), 'bad');
        toast(textOf(syncErr), 'bad');
        return Promise.resolve();
      }
      return result.then(
        function () {
          state.busy = false;
          renderButtons();
        },
        function (err) {
          state.busy = false;
          renderButtons();
          addLog('Action failed: ' + textOf(err), 'bad');
          toast(textOf(err), 'bad');
        }
      );
    };
  }

  /**
 * True when there is nothing indexed to download. Note this gates the DOWNLOAD
 * button only — never the sync button, because on a fresh install the sync is
 * the only thing that can build the index the download button needs.
 */
  function libraryEmpty() {
    return !(typeof state.libraryTotal === 'number' && isFinite(state.libraryTotal) && state.libraryTotal > 0);
  }

  function onSyncClick() {
    var settings = state.settings || {};
    var maxPages = clampInt(settings.syncMaxPages, 1, 2000, 200);

    if (libraryEmpty()) {
      // The first crawl is the longest thing this extension does, and it walks
      // the feed from page 1. Say so before starting it rather than appearing to
      // hang.
      var go = window.confirm(
        'Your local library is empty, so this will be a FIRST sync.\n\n'
        +         'It walks your Suno feed from the start (up to ' + maxPages + ' pages per project) and can '
        + 'take several minutes. It downloads no audio and spends no quota'
        + (settings.dislikedMode === 'both'
          ? ', but this setting indexes both liked and disliked, so it walks the feed twice.'
          : '.')
        + '\n\nStart it?'
      );
      if (!go) return;
    }
    startSync();
  }

  function startSync() {
    withBusy(async function () {
      var settings = state.settings || {};
      try {
        var reply = await send('SYNC_START', {
          force: false,
          dislikedMode: settings.dislikedMode,
          maxPages: settings.syncMaxPages
        });
        state.activity = 'sync';
        state.syncRunning = true;
        state.syncPagesDone = 0;
        state.syncSeen = 0;
        state.syncEtaMs = 0;
        // `maxPages` comes from the worker's own reply, so the percentage is
        // measured against the cap that is ACTUALLY being applied.
        state.syncMaxPages = clampInt(reply.maxPages, 0, 100000, 0);
        state.summaryLines = ['Sync started'];
        state.summaryQuotaText = (settings.dislikedMode === 'both'
          ? 'indexing disliked and non-disliked (two walks of the feed) — roughly double the time'
          : 'mode: ' + String(settings.dislikedMode));
        state.summaryIsBad = false;
        state.summaryKind = '';
        addLog('Sync started: ' + state.syncMaxPages + ' page cap, dislikedMode=' + String(reply.dislikedMode), 'info');
        if (typeof reply.feedPageLimit === 'number') {
          addLog('Worker resolved feedPageLimit=' + reply.feedPageLimit + ' maxPages=' + reply.maxPages, 'info');
        }
        renderAll();
        toast('Syncing library…', '');
        startSyncPoll();
      } catch (err) {
        addLog('Sync failed to start: ' + textOf(err), 'bad');
        renderAll();
        toast('Sync failed: ' + textOf(err), 'bad');
      }
    })();
  }

  function onDownloadClick() {
    withBusy(async function () {
      var ids = [];
      try {
        var selection = await send('GET_SELECTION', {});
        ids = Array.isArray(selection.ids) ? selection.ids : [];
        state.selectionCount = typeof selection.count === 'number' ? selection.count : ids.length;
      } catch (err) {
        // The selection could not be read. Do NOT fall back to "everything":
        // that is precisely the failure mode this file exists to prevent.
        addLog('Could not read the selection: ' + textOf(err), 'bad');
        toast('Could not read the current selection, so nothing was queued. ' + textOf(err), 'bad');
        renderButtons();
        return;
      }

      var clipCount = ids.length;
      var viaSpec = clipCount === 0;
      if (viaSpec) {
        clipCount = typeof state.libraryTotal === 'number' ? state.libraryTotal : 0;
        if (clipCount <= 0) {
          toast('Nothing to download: the library is empty. Sync first.', 'bad');
          return;
        }
      }

      var warning = meteredWarningFor(clipCount);
      var head = viaSpec
        ? 'No clips are selected, so this queues ALL ' + clipCount + ' indexed ' + plural(clipCount, 'clip') + '.'
        : 'Queue ' + clipCount + ' selected ' + plural(clipCount, 'clip') + '.';
      if (!window.confirm(head + '\n\n' + warning + '\n\nStart this batch?')) {
        addLog('Batch cancelled before it started.', 'info');
        return;
      }

      var payload;
      try {
        payload = buildDownloadPayload(ids);
      } catch (err) {
        addLog('Refused to start: ' + textOf(err), 'bad');
        toast(textOf(err), 'bad');
        return;
      }

      try {
        var reply = await send('DOWNLOAD_START', payload);
        handleBatchAccepted(reply, viaSpec);
      } catch (err) {
        addLog('Batch failed to start: ' + textOf(err), 'bad');
        state.summaryLines = ['Could not start the batch: ' + textOf(err)];
        state.summaryQuotaText = '';
        state.summaryIsBad = true;
        state.summaryKind = 'bad';
        renderAll();
        toast('Batch failed: ' + textOf(err), 'bad');
      }
    })();
  }

  /**
   * @param {object} reply the `DOWNLOAD_START` reply
   * @param {boolean} viaSpec true when the whole library was queued
   */
  function handleBatchAccepted(reply, viaSpec) {
    state.activity = 'download';
    state.downloadRunning = true;
    state.downloadDone = 0;
    state.downloadTotal = typeof reply.planned === 'number' ? reply.planned : 0;
    state.downloadOk = 0;
    state.downloadFailed = 0;
    state.downloadSkipped = 0;
    state.downloadCurrentTitle = '';
    state.downloadEtaMs = 0;
    // Per-batch evidence, reset here so a ladder-exhausted error never quotes
    // a refusal from an older batch.
    state.dlBatchId = reply.batchId ? String(reply.batchId) : null;
    state.dlReasons = [];
    state.reportedOutcome = '';
    clearOutcomeAction();

    var lines = [];
    if (reply.dryRun === true) {
      lines.push('Dry run: ' + state.downloadTotal + ' ' + plural(state.downloadTotal, 'file') + ' planned, nothing downloaded, no quota spent');
      // A dry run is a success that downloaded nothing. Both flags are set on
      // every branch below so a stale severity from the previous batch cannot
      // survive into this summary.
      state.summaryIsBad = false;
      state.summaryKind = '';
    } else if (reply.stopped === 'quota' || reply.quotaShortfall) {
      var short = reply.quotaShortfall || {};
      lines.push('Stopped before starting on quota: ' + state.downloadTotal + ' of ' + short.needed + ' ' + plural(short.needed, 'clip') + ' fit');
      if (short.message) lines.push(short.message);
      // A preflight stop is a deliberate stop, not a failure: the batch never
      // began, so nothing failed.
      state.summaryIsBad = false;
      state.summaryKind = 'warn';
    } else {
      state.summaryIsBad = false;
      state.summaryKind = '';
      lines.push('Queued ' + state.downloadTotal + ' ' + plural(state.downloadTotal, 'file'));
      if (typeof reply.duplicatesDropped === 'number' && reply.duplicatesDropped > 0) {
        lines.push(reply.duplicatesDropped + ' duplicate ' + plural(reply.duplicatesDropped, 'id') + ' dropped');
      }
    }
    if (typeof reply.skipped === 'number' && reply.skipped > 0) {
      lines.push(reply.skipped + ' already downloaded and skipped');
    }
    if (reply.note) lines.push(reply.note);
    if (viaSpec && !reply.dryRun) {
      lines.push('Scope: the whole indexed library, because nothing was selected');
    }
    if (reply.description) {
      state.summaryQuotaText = 'Filter: ' + String(reply.description);
    } else {
      state.summaryQuotaText = reply.dryRun === true ? 'dryRun was on' : '';
    }
    state.summaryLines = lines;

    // Severity must match the paint above: a PREFLIGHT quota stop sets
    // `summaryKind` to 'warn' (amber) while deliberately leaving `summaryIsBad`
    // false, so the old `summaryIsBad ? 'warn' : 'ok'` test logged a green line
    // for a stop the summary paints amber.
    addLog(lines.join(' · '), reply.dryRun === true ? 'info'
      : ((state.summaryIsBad || state.summaryKind === 'warn') ? 'warn' : 'ok'));
    renderAll();
    if (reply.dryRun === true) {
      state.downloadRunning = false;
      state.activity = 'idle';
      renderAll();
      toast('Dry run complete — nothing was downloaded.', 'ok');
    }
  }

  /**
   * After a cancel request, wait (bounded) for the worker to report the run as
   * finished, then re-read authoritative state.
   *
   * Aborting is cooperative: the crawl only observes the signal where it awaits,
   * so a run parked in a rate-limit backoff or a page retry keeps going for a
   * while. The previous version showed "Cancelling the sync…" and then waited
   * forever for a `SYNC_DONE` push that might never come, with no exit. A
   * bounded wait plus an authoritative re-read means the popup always resolves to
   * the truth, and can say plainly when the worker did not stop.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>} true when the run is confirmed finished
   */
  async function awaitSyncSettled(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || SYNC_CANCEL_WAIT_MS);
    var settled = false;
    var polls = 0;
    while (Date.now() < deadline) {
      await sleep(400);
      polls += 1;
      var res = await send('SYNC_STATUS', {});
      if (res && res.ok && res.running !== true) {
        settled = true;
        break;
      }
    }
    // Always re-read: `SYNC_DONE` may have landed in between, and the cursor is
    // the only place the final verdict is recorded.
    await refreshBootSafe();
    addLog('Post-cancel poll: ' + polls + ' queries, settled=' + String(settled), 'info');
    return settled;
  }

  function onCancelClick() {
    withBusy(async function () {
      try {
        if (state.downloadRunning) {
          var batch = await send('DOWNLOAD_CANCEL', {});
          addLog('Cancel requested for batch ' + String(batch.batchId || 'unknown') + '.', 'warn');
          toast('Cancelling the batch…', '');
          return;
        }
        var sync = await send('SYNC_CANCEL', {});
        // `running`/`cancelRequested`/`abortAvailable`/`orphanedCursorCleared` are
        // the worker's contract. The old line read `sync.running` from a reply
        // that only ever carried `{ok:true}`, so it logged "was running:
        // undefined" and the user could not tell a real cancel from a no-op.
        if (sync && sync.orphanedCursorCleared === true) {
          state.syncOrphaned = false;
          state.syncRunning = false;
          state.syncCancelling = false;
          addLog(sync.stale === true
            ? 'Cleared a crawl the extension worker had abandoned. Your indexed clips were kept — press Sync to resume.'
            : 'Cleared the stale "sync in progress" state. Indexed clips were kept.', 'warn');
          toast('Cleared the stale sync state.', 'warn');
          await refreshBootSafe();
          stopSyncPoll();
          renderAll();
          return;
        }
        if (sync && sync.running === false) {
          addLog('Nothing to cancel — no library sync is running. Re-reading authoritative state.', 'info');
          toast('No sync is running.', '');
          void refreshBootSafe().catch(noop);
          void refreshSyncStatus().catch(noop);
          renderButtons();
          return;
        }
        if (sync && sync.cancelRequested === true) {
          state.syncCancelling = true;
          state.syncCancelRequestedAt = Date.now();
          addLog('Cancel signalled. Waiting for the crawl to unwind…', 'warn');
          toast('Cancelling the sync…', '');
          renderProgress();
          var settled = await awaitSyncSettled();
          state.syncCancelling = false;
          if (settled) {
            addLog('Sync stopped.', 'info');
            toast('Sync cancelled — nothing is broken.', '');
          } else {
            addLog('The worker has not reported the sync as stopped yet. It is likely waiting on a rate limit; it will stop at the next page boundary. If it does not, reload the extension.', 'warn');
            toast('Still stopping — the worker is waiting on a rate limit.', 'warn');
          }
          renderAll();
        }
      } catch (err) {
        addLog('Cancel failed: ' + textOf(err), 'bad');
        toast('Cancel failed: ' + textOf(err), 'bad');
      }
    })();
  }

  function onPanelClick() {
    withBusy(async function () {
      var opened = false;
      try {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
        opened = true;
      } catch (openErr) {
        dbg('sidePanel.open failed:', textOf(openErr));
      }
      if (opened) {
        window.close();
        return;
      }
      // `chrome.sidePanel.open` is refused outside a user gesture on some
      // builds. The settings page is a real tab and always works, so fall back
      // to it rather than leaving the click dead.
      try {
        await chrome.runtime.openOptionsPage();
        addLog('Side panel could not be opened from the popup; opened Settings instead.', 'info');
      } catch (fallbackErr) {
        addLog('Could not open the panel: ' + textOf(fallbackErr), 'bad');
        toast('Could not open the full panel: ' + textOf(fallbackErr), 'bad');
      }
    })();
  }

  function onOptionsClick() {
    withBusy(async function () {
      try {
        await chrome.runtime.openOptionsPage();
        window.close();
      } catch (err) {
        addLog('Could not open Settings: ' + textOf(err), 'bad');
        toast('Could not open Settings: ' + textOf(err), 'bad');
      }
    })();
  }

  function onAuthClick() {
    withBusy(async function () {
      try {
        await chrome.tabs.create({ url: 'https://suno.com/', active: true });
        window.close();
      } catch (err) {
        addLog('Could not open suno.com: ' + textOf(err), 'bad');
        toast('Could not open suno.com: ' + textOf(err), 'bad');
      }
    })();
  }

  function onLogClearClick() {
    while (els.log.firstChild) els.log.removeChild(els.log.firstChild);
  }

  /* --------------------------------------------------- DOWNLOAD_STATUS */

  /**
   * `DOWNLOAD_STATUS` is the worker's own read of the batch plan, and it is the
   * only route in the whole protocol that carries `plan.stoppedReason` and
   * `plan.quotaStop`. A popup that was closed for the middle of a batch used to
   * show "Idle" until the next push happened to arrive, so this is called on
   * every boot and by the Refresh button.
   *
   * @returns {Promise<string>} a short phrase for the activity log
   */
  async function refreshBatchStatus() {
    try {
      var reply = await send('DOWNLOAD_STATUS', {});
      var plan = reply.plan && typeof reply.plan === 'object' ? reply.plan : null;
      var stopped = plan && plan.stoppedReason ? String(plan.stoppedReason) : '';
      state.batchStatus = {
        running: reply.running === true,
        batchId: reply.batchId ? String(reply.batchId) : null,
        stoppedReason: stopped || null
      };

      if (reply.running === true) {
        state.downloadRunning = true;
        state.activity = 'download';
        if (plan) {
          state.downloadTotal = clampInt(plan.total, 0, 10000000, state.downloadTotal);
          state.downloadDone = clampInt(plan.cursor, 0, 10000000, state.downloadDone);
          var live = plan.stats && typeof plan.stats === 'object' ? plan.stats : {};
          state.downloadOk = clampInt(live.ok, 0, 10000000, state.downloadOk);
          state.downloadFailed = clampInt(live.failed, 0, 10000000, state.downloadFailed);
          state.downloadSkipped = clampInt(live.skipped, 0, 10000000, state.downloadSkipped);
        }
        renderProgress();
        renderButtons();
        return 'running';
      }

      state.downloadRunning = false;

      // Only an INTERRUPTED outcome is reported on a re-read. A batch that
      // completed normally needs no announcement every time the popup opens, and
      // `plan` survives in the worker's meta store long after the batch is over.
      if (stopped !== 'quota' && stopped !== 'cancelled' && stopped !== 'ladder_exhausted') return 'idle';
      if (!plan) return 'idle';

      var last = reply.lastBatch && typeof reply.lastBatch === 'object' ? reply.lastBatch : null;
      var same = !!(last && last.batchId && last.batchId === plan.batchId);
      var from = same ? last : plan;
      // `plan` nests its counters under `stats`; `lastBatch` is flat. Accept both
      // so the reported numbers are the worker's, never zero-by-default.
      var stats = from.stats && typeof from.stats === 'object' ? from.stats : from;
      var batchId = String(from.batchId || plan.batchId || '');
      if (batchId + ':' + stopped === state.reportedOutcome) return 'reported';
      if (stopped === 'cancelled') {
        // The user did this. Re-announcing it on every open is noise.
        return 'reported';
      }

      onDlDone({
        batchId: batchId,
        ok: stats.ok,
        failed: stats.failed,
        skipped: stats.skipped,
        durationMs: from.durationMs,
        stoppedReason: stopped,
        quotaPolls: from.quotaPolls,
        remainingItems: Math.max(0, clampInt(plan.total, 0, 10000000, 0) - clampInt(plan.cursor, 0, 10000000, 0)),
        quotaStop: from.quotaStop || plan.quotaStop || null,
        // The worker's own cached reading, which is the same one `GET_QUOTA`
        // serves and the one `DL_DONE` would have carried had the popup been open.
        quotaAfter: state.quota
      }, { skipBoot: true });
      return 'reported';
    } catch (err) {
      dbg('DOWNLOAD_STATUS failed:', textOf(err));
      return 'unreachable';
    }
  }

  /**
   * The Refresh affordance: a popup reopened mid-batch has no pushes to listen
   * for, so this is how the user pulls the current state by hand.
   */
  function onRefreshClick() {
    withBusy(async function () {
      await refreshBoot();
      // `refreshBoot` has already reported its own failure; do not overwrite that
      // message with a cheerful "Refreshed".
      if (state.lastBootOk !== true) return;
      var status = state.batchStatus || null;
      var note = status && status.running === true
        ? 'Refreshed — the worker reports a batch still running'
        : 'Refreshed — no batch is running';
      addLog(note + '.', 'info');
      renderAll();
      toast('Refreshed.', 'ok');
    })();
  }

  /**
   * `DOWNLOAD_RETRY_FAILED` is the only recovery the worker exposes for a batch
   * that stopped short: it re-plans exactly the clips recorded as failed and
   * leaves anything already downloaded alone.
   */
  function onRetryFailedClick() {
    withBusy(async function () {
      try {
        var reply = await send('DOWNLOAD_RETRY_FAILED', {});
        var planned = Number(reply.planned) || 0;
        if (planned > 0) {
          addLog('Re-planned ' + planned + ' failed ' + plural(planned, 'download') + '.', 'info');
          handleBatchAccepted(reply, false);
          return;
        }
        var note = reply.note ? String(reply.note) : 'There is nothing to retry.';
        addLog('Retry: ' + note, 'info');
        toast(note, '');
      } catch (err) {
        addLog('Retry failed: ' + textOf(err), 'bad');
        toast('Retry failed: ' + textOf(err), 'bad');
      }
    })();
  }

  /* ---------------------------------------------------------------- pushes */

  function onSyncProgress(msg) {
    var prevPhase = state.syncPhase;
    state.syncRunning = true;
    state.activity = 'sync';
    state.syncPagesDone = clampInt(msg.pagesDone, 0, 1000000, state.syncPagesDone);
    if (isFinite(Number(msg.page)) && Number(msg.page) > 0) {
      state.syncPagesDone = Math.max(state.syncPagesDone, clampInt(msg.page, 0, 1000000, 0));
    }
    if (isFinite(Number(msg.seen))) state.syncSeen = clampInt(msg.seen, 0, 10000000, state.syncSeen);
    if (typeof msg.phase === 'string' && msg.phase) state.syncPhase = msg.phase;
    if (Number.isFinite(Number(msg.phasePagesDone))) state.syncPhasePages = Number(msg.phasePagesDone);
    if (Number.isFinite(Number(msg.phaseJoined))) state.syncPhaseJoined = Number(msg.phaseJoined);
    if (Number.isFinite(Number(msg.phaseItems))) state.syncPhaseItems = Number(msg.phaseItems);
    state.syncEtaMs = Number(msg.etaMs) > 0 ? Number(msg.etaMs) : 0;
    if (!state.syncMaxPages && state.settings) {
      state.syncMaxPages = clampInt(state.settings.syncMaxPages, 0, 100000, 0);
    }
    if (state.syncPhase !== prevPhase) {
      addLog('sync phase: ' + (state.syncPhase || '?'), 'info');
    }
    startSyncPoll();
    renderProgress();
    renderSyncTile();
    renderButtons();
  }

  function onSyncStarted(msg) {
    state.syncRunning = true;
    state.syncCancelling = false;
    state.syncOrphaned = false;
    state.activity = 'sync';
    state.syncPagesDone = 0;
    state.syncSeen = 0;
    state.syncEtaMs = 0;
    if (typeof msg.maxPages === 'number') {
      state.syncMaxPages = clampInt(msg.maxPages, 0, 100000, 0);
    }
    addLog('Library sync started…', 'info');
    renderAll();
  }

  function onSyncCancelRequested(msg) {
    state.syncRunning = true;
    state.syncCancelling = true;
    state.syncCancelRequestedAt = Date.now();
    if (msg.alreadyRequested === true) {
      addLog('The sync was already being stopped.', 'warn');
    } else {
      addLog('Stopping the sync…', 'warn');
    }
    renderProgress();
    renderSyncTile();
    renderButtons();
  }

  function onSyncCancelled(msg) {
    state.syncRunning = false;
    state.syncCancelling = false;
    state.syncOrphaned = false;
    state.activity = 'idle';
    if (msg.orphanedCursorCleared === true) {
      addLog('Cleared a stale sync record.', 'warn');
    } else {
      addLog('Sync cancelled.', 'info');
    }
    renderAll();
    stopSyncPoll();
    void refreshBootSafe().catch(noop);
  }

  /**
   * `SYNC_DONE` — the completion contract, stored before anything is rendered.
   *
   * The new fields are written ONTO `state.sync`, not into a side channel, so
   * that the `GET_BOOT` read on the next popup open (which carries the same
   * cursor) cannot wipe them, and so `renderSyncTile()` and `renderTruncated()`
   * see one object instead of two that can disagree.
   *
   * @param {object} msg
   */
  function onSyncDone(msg) {
    state.syncRunning = false;
    state.activity = 'idle';
    if (typeof msg.total === 'number') state.libraryTotal = msg.total;

    var facts = applySyncReply(msg, { state: msg && typeof msg.state === 'string' ? msg.state : undefined });
    state.syncPagesDone = state.syncPagesDone || state.syncMaxPages;

    var verdict = syncVerdict(facts, state.sync);
    // The banner's gate, stored as facts so a later `GET_BOOT` can reproduce it.
    state.truncFacts = bannerFacts(facts);

    var duration = formatDuration(msg.durationMs);
    var cancelled = verdict.status === 'cancelled';
    var head = (verdict.kind === 'complete' ? 'Sync complete' : (cancelled ? 'Sync cancelled' : 'Sync INCOMPLETE'))
      + ': ' + group(state.libraryTotal) + ' ' + plural(state.libraryTotal, 'clip') + ' indexed'
      + (duration ? ' in ' + duration : '');

    var lines = [head];
    if (verdict.kind !== 'complete') {
      lines.push(sentence(verdict.reason) + (verdict.error ? ' (' + verdict.error + ')' : '') + '.');
      if (verdict.counts) {
        lines.push('Indexed ' + verdict.counts
          + (verdict.missing !== null ? ' · ' + group(verdict.missing) + ' missing' : ''));
      }
    }
    state.summaryLines = lines;
    state.summaryQuotaText = verdict.counts
      ? 'Indexed ' + verdict.counts + ' against the count Suno reports for your account.'
      : (isFinite(Number(msg.projects)) ? msg.projects + ' workspaces joined' : '');
    // Amber for an incomplete walk, red only for a hard failure. A walk that
    // saved what it could and stopped is a warning, exactly like a quota stop.
    state.summaryIsBad = verdict.status === 'error';
    state.summaryKind = verdict.kind === 'complete' || cancelled
      ? ''
      : (state.summaryIsBad ? 'bad' : 'warn');

    addLog(head, verdict.kind === 'complete' ? 'ok' : (cancelled ? 'info' : 'warn'));
    if (verdict.kind !== 'complete') {
      addLog('The walk did not finish: ' + verdict.reason
        + (verdict.error ? ' (' + verdict.error + ')' : '') + '.', cancelled ? 'info' : 'warn');
    }
    // One line per workspace that did not complete. The aggregate hid a single
    // bad workspace behind ~20 good ones, which is how a 20-page crawl over a
    // 5,500-clip library was reported as a success.
    for (var w = 0; w < verdict.workspaces.length; w += 1) {
      var ws = verdict.workspaces[w];
      if (!ws || typeof ws !== 'object' || ws.completed === true) continue;
      var wsSeen = Number(ws.totalSeen);
      var wsExpected = Number(ws.expected);
      var wsMissing = Number(ws.missing);
      addLog('Workspace ' + (ws.name ? String(ws.name) : String(ws.projectId || 'unknown'))
        + ' — INCOMPLETE: ' + syncReasonPhrase(ws.stopReason)
        + (ws.error ? ' (' + String(ws.error) + ')' : '')
        + (isFinite(wsExpected) && wsExpected >= 0
          ? ' · ' + (isFinite(wsSeen) ? group(wsSeen) + ' of ' : '') + '~' + group(wsExpected)
          : '')
        + (isFinite(wsMissing) && wsMissing > 0 ? ' · ' + group(wsMissing) + ' missing' : ''),
        'warn');
    }
    renderAll();
    stopSyncPoll();
    refreshBootSafe();
    if (verdict.kind === 'complete') {
      toast('Library synced.', 'ok');
    } else if (cancelled) {
      toast('Sync cancelled — nothing is broken.', '');
    } else {
      toast(verdict.missing !== null
        ? 'Sync stopped early: ' + group(state.libraryTotal) + ' of ~' + group(verdict.expectedTotal)
          + ' indexed, ' + group(verdict.missing) + ' missing.'
        : 'Sync stopped early: the library is INCOMPLETE.',
      verdict.status === 'error' ? 'bad' : 'warn');
    }
  }

  function onSyncError(msg) {
    state.syncRunning = false;
    state.activity = 'idle';
    var message = msg && msg.error ? String(msg.error) : 'unknown sync error';
    // A hard failure IS an incomplete index, so it goes through the SAME
    // `applySyncReply` as `SYNC_DONE` — the tile reads `state.sync`, and the old
    // version wrote only `state.truncFacts`, which left the tile saying "Up to
    // date" directly above an INCOMPLETE banner. The contract is synthesised here
    // (a failure has no `completed:true` to inherit) rather than invented twice.
    var facts = applySyncReply(msg || {}, {
      completed: false,
      error: message,
      stopReason: (msg && typeof msg.stopReason === 'string' && msg.stopReason.trim())
        ? msg.stopReason.trim() : 'page_failed',
      state: 'error'
    });
    state.truncFacts = bannerFacts(facts);
    state.summaryLines = ['Sync failed: ' + message];
    state.summaryQuotaText = countsPhrase(facts, false)
      ? 'Indexed ' + countsPhrase(facts, false) + '.'
      : '';
    state.summaryIsBad = true;
    state.summaryKind = 'bad';
    addLog('Sync error: ' + message, 'bad');
    renderAll();
    stopSyncPoll();
    toast('Sync error: ' + message, 'bad');
  }

  function onDlProgress(msg) {
    // A new batch id means a new batch: the refusals collected for the previous
    // one must not be quoted for this one.
    if (msg.batchId && String(msg.batchId) !== state.dlBatchId) {
      state.dlBatchId = String(msg.batchId);
      state.dlReasons = [];
    }
    state.downloadRunning = true;
    state.activity = 'download';
    state.downloadDone = clampInt(msg.done, 0, 10000000, state.downloadDone);
    state.downloadTotal = clampInt(msg.total, 0, 10000000, state.downloadTotal);
    state.downloadOk = clampInt(msg.ok, 0, 10000000, state.downloadOk);
    state.downloadFailed = clampInt(msg.failed, 0, 10000000, state.downloadFailed);
    state.downloadSkipped = clampInt(msg.skipped, 0, 10000000, state.downloadSkipped);
    state.downloadCurrentTitle = msg.currentTitle ? String(msg.currentTitle) : '';
    state.downloadEtaMs = Number(msg.etaMs) > 0 ? Number(msg.etaMs) : 0;
    renderProgress();
    renderButtons();
  }

  var SOURCE_LABEL = {
    progressive: 'progressive',
    'mango-drm': 'mango-drm',
    studio: 'studio route',
    'download-route': 'download route',
    'wav-official': 'official WAV',
    zip: 'bulk ZIP',
    hls: 'HLS capture'
  };

  /**
   * The activity log is fed HERE. The previous build defined `addLog()` and
   * never called it, so the list stayed permanently empty.
   *
   * @param {object} msg a `DL_ITEM`
   */
  function onDlItem(msg) {
    var itemState = String(msg.state || '');
    var title = msg.filename ? String(msg.filename) : String(msg.clipId || 'clip');
    var source = msg.source ? String(msg.source) : '';
    var sourceText = source ? (SOURCE_LABEL[source] || source) + (isMeteredRung(source) ? ' (metered)' : '') : '';
    var bytes = Number(msg.bytes);
    var byteText = isFinite(bytes) && bytes > 0 ? ' · ' + formatBytes(bytes) : '';

    if (itemState === 'ok') {
      state.downloadOk += 1;
      addLog('Saved ' + title + byteText + (sourceText ? ' via ' + sourceText : ''), 'ok');
    } else if (itemState === 'failed') {
      state.downloadFailed += 1;
      recordDlReason(msg);
      // The source is named on a failure too: "studio returned 403" is an
      // entitlement wall and "progressive found no unencrypted asset" is not,
      // and the log line is the only place the user can tell them apart.
      addLog('FAILED ' + title
        + (sourceText ? ' on ' + sourceText : '')
        + (msg.error ? ' — ' + String(msg.error) : ''), 'bad');
    } else if (itemState === 'skipped') {
      state.downloadSkipped += 1;
      recordDlReason(msg);
      addLog('Skipped ' + title + (msg.error ? ' — ' + String(msg.error) : ''), 'warn');
    } else if (itemState === 'pending') {
      addLog('In flight ' + title + (msg.error ? ' — ' + String(msg.error) : ''), 'info');
    } else {
      addLog(title + ' → ' + (itemState || 'unknown'), 'info');
    }
    renderProgress();
  }

  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /** The four outcomes the worker's `stoppedReason` ternary can produce. */
  var STOPPED_REASONS = ['complete', 'cancelled', 'quota', 'ladder_exhausted'];

  /** Plain-language phrase for each outcome, used in log lines. */
  var OUTCOME_PHRASE = {
    complete: 'finished',
    cancelled: 'cancelled',
    quota: 'stopped on the download allowance',
    ladder_exhausted: 'failed: every rung refused it'
  };

  /**
   * The outcome, normalised.
   *
   * A worker that predates `stoppedReason` sends no such field, and reporting
   * that as a plain success is exactly the defect being fixed — so the fallback
   * reconstructs it from the fields such a worker does send, using the worker's
   * own rule (`ok === 0 && failed > 0` means every rung refused the batch).
   *
   * @param {object} msg
   * @returns {'complete'|'cancelled'|'quota'|'ladder_exhausted'}
   */
  function normalizeStoppedReason(msg) {
    var raw = msg && typeof msg.stoppedReason === 'string' ? msg.stoppedReason.trim() : '';
    if (STOPPED_REASONS.indexOf(raw) >= 0) return raw;
    if (msg && msg.quotaStop && typeof msg.quotaStop === 'object') return 'quota';
    var ok = Number(msg && msg.ok) || 0;
    var failed = Number(msg && msg.failed) || 0;
    var left = Number(msg && msg.remainingItems);
    if (isFinite(left) && left > 0) return 'cancelled';
    if (failed > 0 && ok === 0) return 'ladder_exhausted';
    return 'complete';
  }

  /**
   * What a quota stop has to state: what the meter said when the batch stopped,
   * the floor it stopped at, how many more downloads would fit before that
   * floor, and when the allowance comes back. `quotaStop` is the reading taken
   * at the moment of the stop and is preferred; the post-batch reading and the
   * saved `quotaReserve` are the fallbacks, so nothing here is invented.
   *
   * @param {object} msg
   * @returns {{remaining:number|null,reserve:number,fits:number|null,resetsOn:string|null}}
   */
  function quotaStopView(msg) {
    var stop = msg && msg.quotaStop && typeof msg.quotaStop === 'object' ? msg.quotaStop : null;
    var after = msg && msg.quotaAfter && typeof msg.quotaAfter === 'object' ? msg.quotaAfter : null;
    var saved = clampInt((state.settings || {}).quotaReserve, 0, 10000, 0);

    var remaining = null;
    if (stop && isFinite(Number(stop.remaining))) remaining = Number(stop.remaining);
    if (remaining === null && after && after.unlimited !== true) {
      if (typeof after.effectiveRemaining === 'number') remaining = after.effectiveRemaining;
      else if (typeof after.remaining === 'number') remaining = after.remaining;
    }
    var reserve = stop && isFinite(Number(stop.reserve)) ? Math.max(0, Number(stop.reserve)) : saved;
    var resetsOn = stop && stop.resetsOn ? String(stop.resetsOn) : (after && after.resetsOn ? String(after.resetsOn) : '');

    return {
      remaining: remaining,
      reserve: reserve,
      fits: remaining === null ? null : Math.max(0, remaining - reserve),
      resetsOn: resetsOn
    };
  }

  /**
   * Remember one distinct per-clip refusal from the current batch, so a
   * `ladder_exhausted` result can say WHY rather than only that it happened.
   *
   * @param {object} msg a `DL_ITEM`
   */
  function recordDlReason(msg) {
    var reason = String(msg.error || '').trim();
    if (!reason) return;
    var source = msg.source ? (SOURCE_LABEL[String(msg.source)] || String(msg.source)) : '';
    var text = source ? source + ': ' + reason : reason;
    if (state.dlReasons.indexOf(text) >= 0) return;
    if (state.dlReasons.length >= 6) return;
    state.dlReasons.push(text);
  }

  /**
   * `DL_DONE` — and the whole point of this function: the outcome is read from
   * `stoppedReason`, because four different things arrive on this one message
   * and three of them are not a success.
   *
   * @param {object} msg a `DL_DONE` push, or the same shape synthesised from
   *   `DOWNLOAD_STATUS` for a batch that ended while this popup was closed
   * @param {{skipBoot?: boolean}} [opts] `skipBoot` stops the refresh that
   *   `refreshBoot()` would otherwise trigger, so a re-read cannot recurse
   */
  function onDlDone(msg, opts) {
    state.downloadRunning = false;
    state.activity = 'idle';
    state.downloadCurrentTitle = '';
    state.downloadDone = state.downloadTotal || state.downloadDone;

    var stoppedReason = normalizeStoppedReason(msg);
    var ok = Number(msg.ok) || 0;
    var failed = Number(msg.failed) || 0;
    var skipped = Number(msg.skipped) || 0;
    var left = Math.max(0, Number(msg.remainingItems) || 0);
    var polls = Math.max(0, Number(msg.quotaPolls) || 0);
    var duration = formatDuration(msg.durationMs);
    // The headline names the OUTCOME, not merely "finished": four different things
    // arrive on this one message and three of them are not a success, so a fixed
    // headline opened a cancelled or quota-stopped batch with the word "finished".
    // The per-branch detail lines below are unchanged; only this first line differs.
    var HEADLINE = {
      quota: 'Batch stopped — download allowance reached',
      ladder_exhausted: 'Batch failed — every source refused these clips',
      cancelled: 'Batch cancelled'
    };
    var head = (HEADLINE[stoppedReason] || 'Batch complete')
      + ': ' + ok + ' saved, ' + failed + ' failed, ' + skipped + ' skipped'
      + (duration ? ' in ' + duration : '');

    var lines = [head];
    var kind = '';
    var logKind = 'ok';
    var toastKind = '';
    var toastText = '';

    if (stoppedReason === 'quota') {
      var view = quotaStopView(msg);
      kind = 'warn';
      logKind = 'warn';
      lines.push('Stopped on the monthly download allowance — a warning, not a failure. Nothing was deleted and no partial file was kept.');
      if (left > 0) {
        lines.push(left + ' ' + plural(left, 'clip') + ' still planned and untouched');
      }
      if (view.remaining !== null) {
        lines.push('The meter reports ' + view.remaining + (view.remaining === 1 ? ' download' : ' downloads')
          + ' remaining' + (view.reserve > 0 ? ' against your reserve of ' + view.reserve : ''));
        lines.push(view.fits > 0
          ? view.fits + ' more would fit before that reserve'
          : 'No more downloads fit before that reserve');
      } else {
        lines.push('The post-batch download balance was not reported.');
      }
      if (view.resetsOn) lines.push('The allowance resets on ' + formatDate(view.resetsOn));
      if (polls > 0) {
        lines.push('The allowance was re-checked ' + polls + ' ' + plural(polls, 'time') + ' during this batch');
      }
      toastText = 'Batch stopped on quota: ' + ok + ' saved, ' + left + ' left.';
      toastKind = 'warn';
    } else if (stoppedReason === 'ladder_exhausted') {
      kind = 'bad';
      logKind = 'bad';
      lines.push('ERROR: every rung in the ladder refused these clips, so none of them was downloaded.');
      var sameBatch = !msg.batchId || !state.dlBatchId || String(msg.batchId) === state.dlBatchId;
      var reasons = sameBatch ? state.dlReasons.slice(0, 4) : [];
      lines.push(reasons.length
        ? 'Per-clip reasons: ' + reasons.join(' / ')
        : 'No per-clip reason came back with this result; the attempt log in the full panel has them.');
      toastText = 'Every source refused these clips.';
      toastKind = 'bad';
    } else if (stoppedReason === 'cancelled') {
      lines.push('Cancelled — not an error. ' + ok + ' ' + plural(ok, 'clip') + ' were saved before it stopped.');
      if (left > 0) lines.push(left + ' ' + plural(left, 'clip') + ' were never attempted');
      logKind = 'info';
      toastText = 'Batch cancelled.';
      toastKind = '';
    } else if (failed > 0) {
      kind = 'bad';
      logKind = 'warn';
      toastText = head;
      toastKind = 'bad';
    } else {
      toastText = 'Batch complete.';
      toastKind = 'ok';
    }

    var quotaAfter = msg.quotaAfter && typeof msg.quotaAfter === 'object' ? msg.quotaAfter : null;
    if (quotaAfter) {
      if (quotaAfter.unlimited === true) {
        state.summaryQuotaText = 'Downloads left after this batch: no monthly cap on this account.';
      } else if (typeof quotaAfter.effectiveRemaining === 'number') {
        state.summaryQuotaText = 'Downloads left after this batch: ' + quotaAfter.effectiveRemaining
          + (typeof quotaAfter.limit === 'number' ? ' of ' + quotaAfter.limit : '')
          + (quotaAfter.resetsOn ? ' · resets ' + formatDate(quotaAfter.resetsOn) : '');
      } else {
        state.summaryQuotaText = 'Suno did not report a post-batch download balance.';
      }
      state.quota = quotaAfter;
    } else {
      state.summaryQuotaText = 'Suno did not report a post-batch download balance.';
    }

    state.summaryLines = lines;
    state.summaryIsBad = kind === 'bad';
    state.summaryKind = kind;
    state.reportedOutcome = String(msg.batchId || '') + ':' + stoppedReason;

    addLog(head + ' — ' + (OUTCOME_PHRASE[stoppedReason] || stoppedReason)
      + (stoppedReason === 'complete' && failed > 0 ? ', with failures' : ''), logKind);
    for (var i = 1; i < lines.length; i += 1) addLog(lines[i], logKind === 'bad' ? 'bad' : 'info');
    if (state.summaryQuotaText) addLog(state.summaryQuotaText, 'info');

    if (stoppedReason === 'quota') {
      showOutcomeAction(
        'Retry the failed downloads',
        'Re-plan only the clips the worker recorded as failed; clips already saved are left alone. '
        + 'Clips that were never attempted are not part of this \u2014 they stay planned, and a plain '
        + 'Download will pick them up once the allowance allows it.',
        onRetryFailedClick
      );
    } else if (stoppedReason === 'ladder_exhausted') {
      showOutcomeAction(
        'Retry these clips',
        'Re-plan the clips every rung refused. Change the ladder or the requested format first if the same refusal is expected to repeat.',
        onRetryFailedClick
      );
    } else {
      clearOutcomeAction();
    }

    renderAll();
    if (!opts || opts.skipBoot !== true) refreshBootSafe();
    toast(toastText, toastKind);
  }

  function onDlError(msg) {
    state.downloadRunning = false;
    state.activity = 'idle';
    var message = msg && msg.error ? String(msg.error) : 'unknown batch error';
    state.summaryLines = ['Batch error: ' + message];
    state.summaryQuotaText = '';
    state.summaryIsBad = true;
    state.summaryKind = 'bad';
    addLog('Batch error: ' + message, 'bad');
    renderAll();
    clearOutcomeAction();
    toast('Batch error: ' + message, 'bad');
  }

  function onTokenChanged() {
    refreshToken();
  }

  function listenForPushes() {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg.type !== 'string') return;
      try {
        switch (msg.type) {
          case 'SYNC_PROGRESS': onSyncProgress(msg); break;
          case 'SYNC_DONE': onSyncDone(msg); break;
          case 'SYNC_ERROR': onSyncError(msg); break;
          case 'SYNC_STARTED': onSyncStarted(msg); break;
          case 'SYNC_CANCEL_REQUESTED': onSyncCancelRequested(msg); break;
          case 'SYNC_CANCELLED': onSyncCancelled(msg); break;
          case 'DL_PROGRESS': onDlProgress(msg); break;
          case 'DL_ITEM': onDlItem(msg); break;
          case 'DL_DONE': onDlDone(msg); break;
          case 'DL_ERROR': onDlError(msg); break;
          case 'TOKEN_CHANGED': onTokenChanged(); break;
          default: break;
        }
      } catch (pushErr) {
        // A rendering fault must never take the listener down: the next push
        // would then be dropped silently.
        addLog('Could not render a ' + msg.type + ' event: ' + textOf(pushErr), 'bad');
      }
    });
  }

  /* ------------------------------------------------------------------ boot */

  async function refreshToken() {
    try {
      var reply = await send('GET_TOKEN_STATUS', {});
      state.token = reply.token;
      renderAuth(state.token);
    } catch (err) {
      state.token = { hasToken: false };
      renderAuth(state.token);
      dbg('GET_TOKEN_STATUS failed:', textOf(err));
    }
  }

  async function refreshSelection() {
    try {
      var reply = await send('GET_SELECTION', {});
      state.selectionCount = typeof reply.count === 'number' ? reply.count : 0;
      if (typeof reply.resolvable === 'number' && reply.resolvable < state.selectionCount) {
        addLog('Selection holds ' + state.selectionCount + ' ids but only ' + reply.resolvable
          + ' are still in the library.', 'warn');
      }
    } catch (err) {
      // Unknown selection: the download button must NOT claim "download all".
      state.selectionCount = 0;
      dbg('GET_SELECTION failed:', textOf(err));
    }
    renderButtons();
  }

  async function refreshQuota(force) {
    try {
      var reply = await send('GET_QUOTA', { refresh: force === true });
      state.quota = reply.quota || null;
      state.credits = reply.credits || null;
      renderQuotaTile();
      renderCreditsTile();
    } catch (err) {
      dbg('GET_QUOTA failed:', textOf(err));
      if (!state.quota) {
        renderQuotaTile();
        renderCreditsTile();
      }
    }
  }

  async function refreshBoot() {
    try {
      var boot = await send('GET_BOOT', {});
      state.lastBootOk = true;
      state.settings = boot.settings || {};
      state.debug = state.settings.debug === true;
      state.sync = (boot.sync && typeof boot.sync === 'object')
        ? mergeSyncRecord(state.sync, boot.sync)
        : state.sync;
      state.bootCounts = (boot.library && boot.library.counts) || null;
      if (state.bootCounts && typeof state.bootCounts.clips === 'number' && state.bootCounts.clips >= 0) {
        state.libraryTotal = state.bootCounts.clips;
      }
      if (boot.sync) {
        // `GET_BOOT.sync` is the cursor record, i.e. the same object
        // `SYNC_STATUS.cursor` returns, so it carries the same completeness
        // fields. The banner is re-derived from it on every boot, which is what
        // lets a later CLEAN sync clear a stale warning instead of leaving the
        // popup permanently amber. It is read from the MERGED record, not from
        // `boot.sync`, so a stale boot read cannot resurrect a warning that a
        // newer `SYNC_DONE` already disproved.
        var bootFacts = readSyncFacts(state.sync);
        var banner = bannerFacts(bootFacts);
        if (banner) state.truncFacts = banner;
        else if (bootFacts && bootFacts.hasContract) state.truncFacts = null;
      }
      if (boot.token) state.token = boot.token;
      if (boot.quota) {
        state.quota = boot.quota;
        renderQuotaTile();
      }
      if (state.settings.syncMaxPages && !state.syncRunning) {
        state.syncMaxPages = clampInt(state.settings.syncMaxPages, 0, 100000, 0);
      }
      if (boot.download && boot.download.running === true) {
        // A batch is already in flight; reflect it rather than claiming idle.
        state.downloadRunning = true;
        state.activity = 'download';
      }
      if (boot.sync && boot.sync.state === 'running') {
        state.syncRunning = true;
        state.activity = 'sync';
        state.syncPagesDone = clampInt(boot.sync.pagesDone, 0, 1000000, 0);
        startSyncPoll();
      }
      /* AN ORPHANED CRAWL IS NOT A RUNNING ONE.
       *
       * `boot.sync.state === 'running'` used to be taken as proof that a crawl was
       * in flight. It is not: the row is durable and the controller that owns it
       * is not, so after a worker eviction the popup showed "Syncing" forever with
       * a Stop button that truthfully reported "no library sync is running". The
       * worker now reconciles that row on read and sets `interrupted`, but the
       * state is also checked here so an older worker cannot reproduce it. */
      if (boot.sync && boot.sync.interrupted === true) {
        state.syncRunning = false;
        state.syncCancelling = false;
        state.activity = 'idle';
        state.syncOrphaned = true;
      } else if (boot.sync && boot.sync.state === 'running') {
        state.syncOrphaned = false;
      }
      // The clips-seen counter is CUMULATIVE and lives in the cursor, so a
      // reopened popup has to read it back. It previously only ever came from a
      // live `SYNC_PROGRESS` push, which means any popup opened mid-crawl
      // reported "0 clips seen" beside a running progress bar and an indexed
      // count in the hundreds — a number that is confidently wrong rather than
      // merely missing. `totalSeen` is the unique count under the sync contract's
      // own name; `uniqueSeen` is accepted as an alias.
      if (boot.sync) {
        var bootSeen = Number(boot.sync.totalSeen);
        if (!isFinite(bootSeen) || bootSeen < 0) bootSeen = Number(boot.sync.uniqueSeen);
        if (isFinite(bootSeen) && bootSeen >= 0) state.syncSeen = Math.max(state.syncSeen, Math.floor(bootSeen));
        if (typeof boot.sync.pagesDone === 'number' && boot.sync.pagesDone > 0) {
          state.syncPagesDone = Math.max(state.syncPagesDone, Math.floor(boot.sync.pagesDone));
        }
        // Phase comes from the worker here too, so a freshly-opened popup shows
        // "mapping clips to workspaces" rather than "starting".
        if (typeof boot.sync.phase === 'string' && boot.sync.phase) state.syncPhase = boot.sync.phase;
        if (Number.isFinite(Number(boot.sync.phasePagesDone))) state.syncPhasePages = Number(boot.sync.phasePagesDone);
        if (Number.isFinite(Number(boot.sync.phaseJoined))) state.syncPhaseJoined = Number(boot.sync.phaseJoined);
      }
      /* Last resort for the clips figure: the cursor's own count can be behind the
       * library after a resume, and "clips seen —" beside an indexed count in the
       * hundreds is worse than showing the count we can actually measure. */
      if (state.syncSeen <= 0 && state.bootCounts && typeof state.bootCounts.clips === 'number') {
        state.syncSeen = state.bootCounts.clips;
      }
      // A cancel that landed while this popup was closed is reported by the
      // cursor; reflect it instead of waiting for a push that already happened.
      if (state.syncRunning === false) {
        state.syncCancelling = boot.sync && boot.sync.cancelRequested === true;
      }
      renderAll();
    } catch (err) {
      state.lastBootOk = false;
      addLog('Could not read the extension state: ' + textOf(err), 'bad');
      renderAll();
      toast('Could not read the extension state: ' + textOf(err), 'bad');
    }
    await refreshSelection();
    await refreshToken();
    await refreshQuota(false);
    // Last, because it is authoritative about the batch and can therefore
    // OVERRIDE the boolean `boot.download.running` above: it is the only route
    // that reports `plan.stoppedReason` / `plan.quotaStop`.
    await refreshBatchStatus();
  }

  /**
   * `refreshBoot()` is fire-and-forget at two call sites, so this keeps it from
   * ever ending as an unhandled rejection. Every inner step already has its own
   * handler; this is the outer belt.
   *
   * @returns {Promise<void>}
   */
  function refreshBootSafe() {
    return refreshBoot().then(null, function (err) {
      addLog('Could not refresh the extension state: ' + textOf(err), 'bad');
    });
  }

  function wire() {
    els.btnSync.addEventListener('click', onSyncClick);
    els.btnDownload.addEventListener('click', onDownloadClick);
    els.btnCancel.addEventListener('click', onCancelClick);
    els.btnPanel.addEventListener('click', onPanelClick);
    els.btnOptions.addEventListener('click', onOptionsClick);
    els.auth.addEventListener('click', onAuthClick);
    els.btnLogClear.addEventListener('click', onLogClearClick);
  }

  function boot() {
    wire();
    ensureRefreshButton();
    renderAll();
    listenForPushes();
    void refreshBootSafe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();