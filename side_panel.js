/**
 * Suno Master Utility — side panel (the always-on library browser)
 * ===========================================================================
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS WRITTEN THE WAY IT IS
 * ---------------------------------------------------------------------------
 * A. SEARCH IS DEBOUNCED (250 ms) and PAGINATED through `GET_CLIPS`. The
 *    previous build asked for the whole library on EVERY keystroke and then
 *    filtered it in the page. This build asks the worker, which filters and
 *    pages against IndexedDB, so the panel never holds more than one page.
 * B. A REQUEST SEQUENCE NUMBER discards a slow earlier reply. Without it, a
 *    reply that lands after a newer one repaints the list with stale results.
 * C. `send()` THROWS on `{ok:false}`. The previous `msg()` resolved `null` and
 *    `renderLibrary()` then set the button label to "Done" — the error branch
 *    below it was unreachable, so a failed download reported success. Here a
 *    failure is a rejection the button's catch branch handles and shows.
 * D. NOTHING is built from markup. Every node is created and filled with
 *    `textContent`. A clip title, its style tags and its prompt are all
 *    user-controlled and all land in this DOM.
 * E. Dislike state is NOT a field on a clip. Suno has no per-clip dislike
 *    flag; the worker derives the set by diffing two crawls and reports the
 *    totals through `GET_FACETS`. So the row dot reflects liked state only, and
 *    the disliked TOTAL comes from facets. Inventing a per-row dislike dot would
 *    be a lie.
 * F. THE INCOMPLETENESS BANNER NAMES THE ACTUAL CAUSE. It used to say "the last
 *    sync hit its page cap" for every short walk, which is wrong for the
 *    failure that matters most: a request that errored on page 21 of 275. It is
 *    gated on `completed === false` (with `truncated` accepted as the
 *    compatibility stand-in) and reads `stopReason` and `expectedTotal`, so it
 *    says "stopped on a failed request · 400 of ~5,500" instead of naming a cap
 *    that was never reached.
 * G. `SYNC_REASON_PHRASE` IS SHARED COPY. Byte-identical values also live in
 *    popup/popup.js and content/content.js; the three must be changed together
 *    or one stop gets three different explanations.
 * H. A TRANSPORT FAILURE IS CLASSIFIED, NOT ECHOED. `send()` used to reject with
 *    "The background worker is not reachable (Extension context invalidated.)",
 *    so pressing Search after a reload painted a raw Chrome string in the error
 *    strip and read as a broken search. An invalidated context and an application
 *    refusal are different facts with different fixes — one needs this panel
 *    reloaded, the other needs the user to change something — so they are painted
 *    as two different things (see `classifyTransport`, `showContextNotice`).
 * I. THE PANEL CAN ACT. It used to be a read-only browser: no `SYNC_START`, no
 *    `DOWNLOAD_START` beyond a single id, no selection. Every control here is
 *    wired to a route that exists in background/background.js `ROUTES`, and the
 *    payloads match what that worker's handlers read.
 * J. THE SELECTION IS THE WORKER'S, NOT THE PANEL'S. `GET_SELECTION` on open and
 *    `SET_SELECTION` on every change, because the popup and the dock act on the
 *    same saved selection — a private set here would be a third, invisible one.
 *    Ids the panel has never rendered stay in the set and are counted honestly;
 *    that is why "Clear selection" exists and why select-all touches only the
 *    rows on screen.
 * K. SYNC PROGRESS HAS ITS OWN LINE. It used to be painted into `#sp-status` with
 *    a `statusBaseText` save/restore dance, so "Loading more…" and "Syncing —
 *    3 pages" fought over one node. Two lines, one for the result count and one
 *    for the run in flight; neither is a live region, because a progress push
 *    per file must not be read aloud. Announcements go through `announce()`.
 * ===========================================================================
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ DOM */

  var C = {
    count: document.getElementById('sp-count'),
    truncated: document.getElementById('sp-truncated'),
    truncatedText: document.getElementById('sp-truncated-text'),
    error: document.getElementById('sp-error'),
    dead: document.getElementById('sp-dead'),
    deadReload: document.getElementById('sp-dead-reload'),
    sync: document.getElementById('sp-sync'),
    syncStop: document.getElementById('sp-sync-stop'),
    syncBox: document.getElementById('sp-syncbox'),
    syncLine: document.getElementById('sp-sync-line'),
    syncFill: document.getElementById('sp-sync-fill'),
    dlSel: document.getElementById('sp-dl-sel'),
    dlAll: document.getElementById('sp-dl-all'),
    dlStop: document.getElementById('sp-dl-stop'),
    dlRetry: document.getElementById('sp-dl-retry'),
    dlBox: document.getElementById('sp-dlbox'),
    dlLine: document.getElementById('sp-dl-line'),
    dlFill: document.getElementById('sp-dl-fill'),
    selbar: document.getElementById('sp-selbar'),
    selAll: document.getElementById('sp-sel-all'),
    selCount: document.getElementById('sp-sel-count'),
    selClear: document.getElementById('sp-sel-clear'),
    search: document.getElementById('sp-search'),
    sort: document.getElementById('sp-sort'),
    facets: document.getElementById('sp-facets'),
    status: document.getElementById('sp-status'),
    list: document.getElementById('sp-list'),
    more: document.getElementById('sp-more'),
    announce: document.getElementById('sp-announce')
  };

  /* --------------------------------------------------------------- state */

  /** Debounce floor. The audit finding was "fetches on EVERY keystroke". */
  var SEARCH_DEBOUNCE_MS = 250;
  var PAGE_SIZE = 50;
  /** Quiet period before a tick run is written to the worker's saved selection. */
  var SELECTION_PUSH_MS = 300;
  /** Same bounds content/content.js uses after a cancel; the abort is cooperative. */
  var SYNC_STOP_WAIT_MS = 20000;
  var SYNC_STOP_POLL_MS = 500;

  var state = {
    clips: [],
    total: 0,
    offset: 0,
    hasMore: false,
    librarySize: 0,
    query: '',
    sort: 'newest',
    order: 'desc',
    loading: false,
    seq: 0,
    searchTimer: null,
    settings: null,
    projectNames: Object.create(null),
    /**
     * The completeness facts learned so far, merged across replies. `GET_CLIPS`
     * and `GET_FACETS` carry at most `truncated`; `SYNC_STATUS.cursor` is the
     * route that carries `completed` / `stopReason` / `expectedTotal`, which is
     * what lets this panel name the ACTUAL cause instead of guessing.
     */
    syncFacts: null,
    syncRunning: false,
    syncCancelling: false,
    syncPhase: '',
    syncPagesDone: 0,
    syncTotalSeen: 0,
    /**
     * The page cap the worker reported applying, from the `SYNC_START` reply and
     * from `SYNC_PROGRESS`. Kept so the sync bar can be measured against the cap
     * that is REALLY in force rather than one this panel invented.
     */
    syncMaxPages: 0,
    syncEtaMs: 0,
    /** clipId -> {button, note, pick} so a DL_ITEM can flip the row it belongs to. */
    rows: new Map(),
    /**
     * The worker's saved selection, mirrored. Ids this panel has never rendered
     * are kept: the panel only ever sees 50 rows at a time, so its DOM is not the
     * selection — the worker's copy is, and "download selected" has to mean what
     * the count says it means.
     */
    selection: new Set(),
    selectionTimer: 0,
    /** clip ids on screen, in list order, for the select-all tri-state. */
    pageIds: [],
    /**
     * The batch in flight, mirroring what the worker's `DL_PROGRESS` /
     * `DL_DONE` pushes carry. It exists because this panel used to handle
     * `DL_ITEM` only, so a 400-clip batch showed no progress and no outcome.
     */
    batch: {
      running: false,
      batchId: '',
      done: 0,
      total: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      current: '',
      etaMs: 0,
      /** Set by `DOWNLOAD_CANCEL`; the abort is cooperative, not instant. */
      stopping: false,
      /** The last settled outcome, so the box can explain itself after the run. */
      settled: '',
      quotaLeft: null
    },
    /**
     * The extension this document belongs to is gone — it was reloaded, updated
     * or disabled. Every `chrome.*` call from here throws from now on, so this
     * is a LATCH: requests stop, controls disable, and the only way out is the
     * Reload button in the notice. Set from `classifyTransport`, never cleared
     * without a reload.
     */
    contextDead: false
  };

  /* -------------------------------------------------------------- helpers */

  /** The ONE debug-gated logger in this build. */
  function dbg() {
    if (!state.debug) return;
    var args = ['[sm-side-panel]'];
    for (var i = 0; i < arguments.length; i += 1) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  /** @param {unknown} err */
  function textOf(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return 'unknown error';
  }

  /**
   * @param {Element} node
   * @param {string} message plain text, never markup
   */
  function setText(node, message) {
    node.textContent = message;
  }

  /** @param {string|null} message */
  function showError(message) {
    if (!message) {
      C.error.hidden = true;
      setText(C.error, '');
      return;
    }
    C.error.hidden = false;
    setText(C.error, message);
  }

  /**
   * The one latch, and the only place `contextDead` is ever set.
   *
   * Every `chrome.*` call from an orphaned document throws from here on, so
   * there is nothing to retry and nothing else the panel can honestly do. Latching
   * also stops the loop that produced the original symptom: without it, every
   * keystroke kept sending a doomed request and repainting "Could not read the
   * library" over the top of the notice that explains it.
   */
  function showContextNotice() {
    if (state.contextDead) return;
    state.contextDead = true;
    C.dead.hidden = false;
    stopSyncPoll();
    dbg('extension context is gone; the panel is now read-only');
    paintControls();
    announce('The extension was reloaded. Reload the panel to continue.');
  }

  /**
   * True only for the dead-context case. An application refusal carries the
   * worker's own `code` and must never be mistaken for this.
   *
   * @param {unknown} err
   * @returns {boolean}
   */
  function isDeadContext(err) {
    return !!(err && err.code === CONTEXT_DEAD_CODE);
  }

  /**
   * The single funnel for a rejected action.
   *
   * A dead context becomes the reload notice; everything else becomes the loud
   * error strip, prefixed, because "says so, out loud" is the product's headline
   * property and a real failure is never softened here. The distinction is about
   * WHO is broken, not about how much the message matters.
   *
   * @param {unknown} err
   * @param {string} [prefix] what was being attempted, e.g. 'Download failed'
   */
  function paintFailure(err, prefix) {
    if (isDeadContext(err)) {
      showContextNotice();
      return;
    }
    showError((prefix ? prefix + ': ' : '') + textOf(err));
  }

  /**
   * Last-resort reporter. Every action handles its own failures; this exists so
   * nothing in this file can end as an unhandled promise rejection.
   *
   * @param {unknown} err
   */
  function reportUnexpected(err) {
    paintFailure(err, 'Unexpected failure');
  }

  /** @param {string} message */
  function announce(message) {
    setText(C.announce, message);
  }

  function setSyncRunning(running, cancelling) {
    dbg('setSyncRunning', running, cancelling);
    state.syncRunning = running;
    state.syncCancelling = cancelling;
    paintSyncStatus();
  }

  /** @param {string} iso @returns {string} */
  function formatDay(value) {
    var ms = Date.parse(String(value || ''));
    if (!isFinite(ms)) return '';
    var d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }

  /** @param {number} n */
  function plural(n, one, many) {
    return n === 1 ? one : (many || one + 's');
  }

  /**
   * Thousands separators without `Intl`, so "5,500" is spelled identically
   * here, in the popup and in the dock.
   *
   * @param {unknown} value
   * @returns {string} '' when not a finite number
   */
  function group(value) {
    var num = Number(value);
    if (!isFinite(num)) return '';
    var rounded = Math.round(num);
    var sign = rounded < 0 ? '-' : '';
    var digits = String(Math.abs(rounded));
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* --------------------------------------------------- sync completeness */

  /**
   * `stopReason` -> plain English. THE SHARED MAP — byte-identical copies live
   * in popup/popup.js and content/content.js (see header note G).
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

  /** Used when the walk stopped and the worker named no reason. */
  var SYNC_REASON_FALLBACK = 'it stopped early for a reason the worker did not report';

  /**
   * @param {unknown} stopReason
   * @returns {string} a plain-English phrase; never '' and never `undefined`
   */
  function syncReasonPhrase(stopReason) {
    var key = typeof stopReason === 'string' ? stopReason.trim() : '';
    return SYNC_REASON_PHRASE[key] || SYNC_REASON_FALLBACK;
  }

  /** @param {string} text @returns {string} */
  function sentence(text) {
    var s = String(text || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  /**
   * The first candidate that is a real, positive count; null when none is.
   *
   * @returns {number|null}
   */
  function firstPositive() {
    for (var i = 0; i < arguments.length; i += 1) {
      var num = Number(arguments[i]);
      if (isFinite(num) && num > 0) return num;
    }
    return null;
  }

  /**
   * Read the completeness contract from ANY reply, flat or cursor-wrapped.
   * EVERY field is optional, so a worker that predates the contract produces
   * nulls here instead of `undefined` leaking into the banner as text.
   *
   * @param {unknown} reply
   * @returns {object|null}
   */
  function readSyncFacts(reply) {
    if (!reply || typeof reply !== 'object') return null;
    var cursor = (reply.cursor && typeof reply.cursor === 'object') ? reply.cursor : null;
    /**
     * Present-but-`null` means "unknown", which is the same as absent: folding
     * it in would make `Number(null) === 0` render "0 of ~0".
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
     * Whether the key is present AT ALL, `0` included — the only correct test for
     * "the worker told us". Needed because folding `null` into absent (right for
     * `expectedTotal`, whose `0` is a sentinel) is what makes a naive
     * `> 0` test discard a legitimate `0`.
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
    var error = pick('error');
    var expected = Number(pick('expectedTotal'));
    // ABSENT and `0` are different facts and must not collapse; see the identical
    // note in `popup/popup.js`. `pick()` passes `0` through, so `has()` plus a
    // numeric coercion is the whole test.
    var missing = has('missing') && isFinite(Number(pick('missing')))
      ? Number(pick('missing')) : null;
    // `totalSeen` is the contract name, but the STORED CURSOR counts the unique
    // clips it walked under `uniqueSeen` and `GET_BOOT.sync` publishes that name;
    // reading `totalSeen` alone gives 0, and "0 of ~5,500" over a 5,500-clip
    // library is worse than no count. The first POSITIVE of the two names wins.
    var totalSeen = firstPositive(pick('totalSeen'), pick('uniqueSeen'));
    // `expectedTotal === 0` is the worker's "Suno reported no count" sentinel.
    var expectedTotal = isFinite(expected) && expected > 0 ? expected : null;

    return {
      hasContract: completed !== undefined || truncated !== undefined ||
        stopReason !== undefined || error !== undefined || expectedTotal !== null ||
        missing !== null || totalSeen !== null,
      completed: typeof completed === 'boolean' ? completed : null,
      truncated: typeof truncated === 'boolean' ? truncated : null,
      stopReason: typeof stopReason === 'string' ? stopReason.trim() : '',
      // `lastError` is the pre-contract spelling of `error`.
      error: (error || pick('lastError')) ? String(error || pick('lastError')) : '',
      expectedTotal: expectedTotal,
      totalSeen: totalSeen,
      // `missing` is AUTHORITATIVE whenever the key is present as a number, `0`
      // included: the worker measures it against rows EXAMINED while publishing
      // `totalSeen` as the UNIQUE count, so `5502 / 5501` with `missing:0` is a
      // complete library and re-deriving prints a phantom "1 clip missing"
      // forever. Deriving is the legacy-reply fallback, for an absent key only.
      missing: missing !== null ? missing
        : (expectedTotal !== null && totalSeen !== null ? expectedTotal - totalSeen : null),
      // `oracleApplied === false` means crawl filters ran, so the counts are a
      // LOWER BOUND, not a shortfall. Optional: absent is unknown.
      oracleApplied: pick('oracleApplied') === false ? false : (pick('oracleApplied') === true ? true : null)
    };
  }

  /**
   * Fold newly read facts into the ones already known, keeping whichever reply
   * knew more. `GET_CLIPS` carries `truncated` and `SYNC_STATUS.cursor` carries
   * the reason, so a later sparse reply must not erase an earlier rich one.
   *
   * @param {object|null} known
   * @param {object|null} fresh
   * @returns {object|null}
   */
  function mergeSyncFacts(known, fresh) {
    if (!fresh) return known || null;
    if (!known) return fresh;
    var out = {};
    var keys = ['hasContract', 'completed', 'truncated', 'stopReason', 'error',
      'expectedTotal', 'totalSeen', 'missing', 'oracleApplied'];
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      var a = fresh[k];
      var b = known[k];
      if (a === undefined || a === null) {
        out[k] = (b === undefined) ? null : b;
      } else if (typeof a === 'boolean') {
        // Only `hasContract` is sticky truth: once any reply has said something
        // about completeness, a later sparse one cannot unsay it. Every other
        // boolean takes the FRESHEST value, because a non-null fresh value here
        // means the reply stated it deliberately — and `false` is a real answer.
        // Making `completed` sticky was how a `SYNC_ERROR` (`completed:false`,
        // `error:'…'`) could leave the previous run's `completed:true` standing,
        // hiding the banner; `oracleApplied:false` (a lower bound) died the same
        // way, silently becoming `true`.
        out[k] = (k === 'hasContract') ? (a === true ? true : (b === true ? true : a)) : a;
      } else {
        out[k] = a;
      }
    }
    return out;
  }

  /**
   * @param {object} facts
   * @param {boolean} [exact] drop the "~"
   * @returns {string} '' when `expectedTotal` is unknown
   */
  function countsPhrase(facts, exact) {
    if (!facts || facts.expectedTotal === null || facts.expectedTotal === undefined) return '';
    var expected = (exact ? '' : '~') + group(facts.expectedTotal);
    var text = (facts.totalSeen === null || facts.totalSeen === undefined)
      ? expected : group(facts.totalSeen) + ' of ' + expected;
    // `oracleApplied === false`: crawl filters ran, so this count is a LOWER BOUND
    // rather than a shortfall. Absent (a legacy reply) adds nothing.
    return facts.oracleApplied === false ? text + ' — a lower bound, filters applied' : text;
  }

  /**
   * TRUE for the PLACEHOLDER reply an account with no finished walk gets:
   * `completed:false`, `stopReason:null`, `error:null`, `expectedTotal:0`,
   * `totalSeen:0`, `missing:0`, `truncated:false`. It says "no walk has
   * finished", NOT "a walk stopped", and this panel reads `SYNC_STATUS` on every
   * open, so without this guard a brand-new install would show the incompleteness
   * banner forever. Two things are explicitly NOT placeholders: an explicit
   * `truncated:true` (that one really is a short walk), and a record that walked a
   * page or indexed a clip — mechanical proof that a crawl happened even when the
   * verdict is missing.
   *
   * @param {object|null} facts
   * @returns {boolean}
   */
  function isPlaceholderSyncFacts(facts) {
    if (!facts) return false;
    return !facts.completed && !facts.stopReason && !facts.error && facts.truncated !== true &&
      (facts.totalSeen === null || facts.totalSeen <= 0) &&
      (facts.expectedTotal === null || facts.expectedTotal <= 0) &&
      (facts.missing === null || facts.missing <= 0);
  }

  /**
   * The banner's gate. `completed === false` is authoritative, `truncated` is
   * accepted for older replies, and a reply that says nothing about
   * completeness leaves the previous decision alone.
   *
   * @param {object|null} facts
   * @returns {object|null} the facts to warn about, or null
   */
  function bannerFacts(facts) {
    if (!facts) return null;
    // Evidence that NO walk finished is not evidence that a walk stopped. This
    // panel polls `SYNC_STATUS`, so it meets that placeholder on a fresh install.
    if (isPlaceholderSyncFacts(facts)) return null;
    /* THE RULE, AND IT IS THE WORKER'S CALL TO MAKE: a `completed` BOOLEAN on the
     * reply is the verdict, and nothing here second-guesses it. The worker already
     * ANDed its own oracle scoping (`oracleApplied`, false whenever the walk was
     * filtered — which is every sync in this build) into that verdict, so a
     * filtered walk's shortfall against an unfiltered `project.clip_count` arrives
     * as ADVISORY: `completed:true, stopReason:'complete', oracleApplied:false,
     * missing:100`. Re-deriving failure from `missing` on top of it re-created a
     * permanent "Incomplete" over crawls the worker had called clean, which is
     * what that second-guessing bought and what this rule removes.
     *
     * The converse is equally binding: `completed === false` is a REAL walk
     * failure whatever the oracle did, so oracle scoping can never mask one. It is
     * painted, and `stopReason` names it. */
    if (facts.completed === false) return facts;
    if (facts.completed === true) return null;
    /* ---- LEGACY REPLIES ONLY, i.e. no `completed` key at all. Those predate the
     * oracle entirely, so the heuristics below are all the evidence there is —
     * and for them they are correct. */
    if (facts.truncated === true) return facts;
    if (facts.stopReason && facts.stopReason !== 'complete') return facts;
    if (facts.expectedTotal !== null && facts.missing !== null && facts.missing > 0) return facts;
    return null;
  }

  /* ------------------------------------------------------------ transport */

  /** The one code that means "this document outlived its extension". */
  var CONTEXT_DEAD_CODE = 'context_dead';

  /**
   * Chrome's own words for a document that can no longer reach the worker,
   * sorted into the two facts a user can act on differently.
   *
   * WHY CLASSIFY: the previous build concatenated the raw string into the error
   * strip, so a user who had merely reloaded the extension and then pressed
   * Search was told "Could not read the library: The background worker is not
   * reachable (Extension context invalidated.)" — an error about their library
   * that was actually about the browser. The raw text goes to `dbg()` (gated
   * behind `settings.debug`) and the user gets prose.
   *
   * @param {string} raw the browser's own message
   * @returns {string} CONTEXT_DEAD_CODE, or 'no_worker'
   */
  function classifyTransport(raw) {
    var text = String(raw || '').toLowerCase();
    // Both spellings Chrome uses for an invalidated context. Both mean the same
    // thing to the user and have the same fix, so they are one branch.
    if (text.indexOf('context invalidated') >= 0) return CONTEXT_DEAD_CODE;
    if (text.indexOf('extension context') >= 0) return CONTEXT_DEAD_CODE;
    return 'no_worker';
  }

  function ReqError(message, code) {
    var err = new Error(message);
    err.name = 'ReqError';
    err.code = code || 'failed';
    return err;
  }

  /**
   * Send one request and REQUIRE `{ok:true}`. Rejects on transport failure, on
   * a missing reply, and on an explicit refusal.
   *
   * @param {string} type
   * @param {object} [payload]
   * @returns {Promise<object>}
   */
  function send(type, payload) {
    dbg('send', type, payload || null);
    return chrome.runtime.sendMessage({ type: type, payload: payload || {} }).then(
      function (reply) {
        if (!reply || typeof reply !== 'object') {
          throw ReqError('The background worker did not reply to ' + type + '. It may have just been restarted.', 'no_reply');
        }
        if (reply.ok !== true) {
          // An application refusal. `code` is the worker's own, so this stays an
          // ordinary loud failure — only the transport branch below can be the
          // dead-context case.
          throw ReqError(reply.error || (type + ' failed'), reply.code || 'failed');
        }
        return reply;
      },
      function (transportErr) {
        var raw = textOf(transportErr);
        dbg('transport failure', type, raw);
        if (classifyTransport(raw) === CONTEXT_DEAD_CODE) {
          throw ReqError('The extension was reloaded, so this panel lost its connection to the background worker.', CONTEXT_DEAD_CODE);
        }
        // Still a real failure and still painted as one, but in words rather
        // than in Chrome's: the worker exists and did not answer, which is a
        // different thing from the library being unreadable.
        throw ReqError('Could not reach the background worker (' + raw + ').', 'no_worker');
      }
    );
  }

  /* --------------------------------------------------------------- facets */

  /**
   * The incompleteness banner, painted in ONE place so the three call sites
   * below cannot drift apart.
   *
   * It is gated on `completed === false` (`truncated` accepted for older
   * replies) and it states the REAL cause. The previous copy said "the last sync
   * hit its page cap" unconditionally, which is a guess: the walk that mattered
   * stopped on a FAILED REQUEST, and telling the user to raise a cap that was
   * never reached sends them to the wrong setting.
   *
   * @param {object|null} facts from `readSyncFacts`, or null to hide it
   */
  function paintBanner(facts) {
    var warn = bannerFacts(facts);
    if (!warn) {
      hideBanner();
      return;
    }
    // stopReason in plain English, then the worker's own error text if it sent
    // one. The phrase is a whole clause, so it needs no rewording per sentence.
    var reason = sentence(syncReasonPhrase(warn.stopReason));
    if (warn.error) reason += ' (' + warn.error + ')';
    reason += '.';

    var counts = countsPhrase(warn, false);
    /* The banner IS painted for `completed:false` under a filter — the walk
     * stopped early, which is a real failure — but the uncaveated "N clips are
     * missing" clause is not. With `oracleApplied:false` the worker explicitly
     * declined to check that number against `clip_count`, so it is a lower bound
     * (which `countsPhrase` already says) rather than a shortfall. `absent` is
     * not `false`: a legacy reply said nothing about the oracle. */
    var missing = (warn.missing !== null && warn.missing > 0 && warn.oracleApplied !== false)
      ? warn.missing : null;

    var parts = ['The last sync stopped early — the index is INCOMPLETE and some clips are missing.', reason];
    if (counts) parts.push('Indexed ' + counts + '.');
    if (missing !== null) {
      parts.push(group(missing) + ' ' + plural(missing, 'clip') + ' ' +
        (missing === 1 ? 'is' : 'are') + ' missing.');
    }
    if (warn.stopReason === 'max_pages') {
      parts.push('Raise "Max pages per sync" in Settings, then sync again.');
    } else if (warn.stopReason === 'aborted') {
      parts.push('Nothing is broken — start the sync again when you are ready.');
    } else {
      parts.push('Sync again to finish the crawl; the popup names the reason in full.');
    }

    var text = parts.join(' ');
    C.truncated.hidden = false;
    setText(C.truncatedText, text);
    C.truncated.title = text;
    // `sp-banner` is already `role="alert"` in side_panel.html, so this needs no
    // second live region; the word INCOMPLETE carries the state for anyone who
    // cannot see the banner's colour.
    C.truncated.setAttribute('aria-label', 'Incomplete library. ' + text);
  }

  /** A CLEAN sync has to be able to clear a stale warning, so hiding is a path. */
  function hideBanner() {
    C.truncated.hidden = true;
    setText(C.truncatedText, '');
    C.truncated.title = '';
    C.truncated.removeAttribute('aria-label');
  }

  /**
   * A coarse "about 2m 10s" for the two places a remaining time is shown. Short
   * on purpose: the panel is narrow, and a precise-looking estimate from a
   * per-file rate is worse than a rounded one.
   *
   * @param {unknown} ms
   * @returns {string} '' when the estimate is absent or not positive
   */
  function humanMs(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '';
    var secs = Math.round(n / 1000);
    if (secs < 60) return secs + 's left';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm' + (secs % 60 ? ' ' + (secs % 60) + 's' : '') + ' left';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h' + (mins % 60 ? ' ' + (mins % 60) + 'm' : '') + ' left';
    return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h left';
  }

  /**
   * @param {number} part
   * @param {number} whole
   * @returns {number} 0..100, and 0 whenever `whole` is not a positive count, so
   *   a missing total paints an empty bar rather than a full one.
   */
  function percent(part, whole) {
    var p = Number(part);
    var w = Number(whole);
    if (!isFinite(p) || !isFinite(w) || w <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((p / w) * 100)));
  }

  /** @param {Element} node @param {number} ratio 0..100 @param {string} [kind] */
  function setFill(node, ratio, kind) {
    node.style.width = Math.max(0, Math.min(100, ratio || 0)) + '%';
    node.classList.remove('is-ok', 'is-bad');
    if (kind === 'ok') node.classList.add('is-ok');
    if (kind === 'bad') node.classList.add('is-bad');
  }

  /**
   * The sync line and its bar, and nothing else. It used to overwrite
   * `#sp-status` and stash the old text in `state.statusBaseText`, which meant
   * "Loading more…" and "Syncing — 3 pages" were the same node: a search during
   * a crawl silently renamed the crawl, and the crawl renamed the search.
   *
   * The measure is CLIPS INDEXED against `expectedTotal` when the worker
   * reported one, because that is the pair the whole product is built around
   * ("400 indexed · Suno reports ~5,500"). Pages are the secondary number,
   * capped against the cap the worker actually applied.
   */
  function paintSyncStatus() {
    dbg('paintSyncStatus', state.syncRunning, state.syncPhase, state.syncPagesDone, state.syncTotalSeen);
    paintControls();
    if (!state.syncRunning) {
      C.syncBox.hidden = true;
      setText(C.syncLine, '');
      setFill(C.syncFill, 0);
      return;
    }
    C.syncBox.hidden = false;

    var parts = [];
    if (state.syncPhase) parts.push(state.syncPhase);
    parts.push(group(state.syncTotalSeen) + ' ' + plural(state.syncTotalSeen, 'clip') + ' indexed');
    if (state.syncPagesDone) parts.push(state.syncPagesDone + ' ' + plural(state.syncPagesDone, 'page'));
    var eta = humanMs(state.syncEtaMs);
    if (eta) parts.push(eta);
    if (state.syncCancelling) parts.push('stopping — this takes effect at the next page');
    setText(C.syncLine, parts.join(' · '));

    var facts = state.syncFacts;
    var expected = facts ? facts.expectedTotal : null;
    if (expected !== null && expected !== undefined && expected > 0) {
      setFill(C.syncFill, percent(state.syncTotalSeen, expected));
    } else if (state.syncMaxPages > 0) {
      setFill(C.syncFill, percent(state.syncPagesDone, state.syncMaxPages));
    } else {
      // No denominator was ever reported. An indeterminate bar is the honest
      // shape; a full bar would claim the crawl is finished.
      setFill(C.syncFill, 0);
    }
  }

  /**
   * The download box. Mirrors the worker's `DL_PROGRESS` / `DL_DONE` fields and
   * the popup's outcome vocabulary, so one batch tells the same story here as it
   * does there.
   *
   * The box STAYS after a batch settles, showing the outcome, because the
   * alternative — a progress bar that vanishes the instant it stops — is how a
   * 400-clip batch ends with no visible result.
   */
  function paintBatch() {
    var b = state.batch;
    paintControls();
    if (!b.running && !b.settled) {
      C.dlBox.hidden = true;
      setText(C.dlLine, '');
      setFill(C.dlFill, 0);
      return;
    }
    C.dlBox.hidden = false;

    var parts = [];
    var kind = '';
    if (b.running) {
      parts.push(group(b.done) + ' of ' + group(b.total) + ' ' + plural(b.total, 'file'));
      if (b.ok) parts.push(group(b.ok) + ' saved');
      if (b.failed) parts.push(group(b.failed) + ' failed');
      if (b.skipped) parts.push(group(b.skipped) + ' skipped');
      var eta = humanMs(b.etaMs);
      if (eta) parts.push(eta);
      if (b.stopping) parts.push('stopping — in-flight transfers finish first');
    } else {
      parts.push(b.settled);
      if (b.ok) parts.push(group(b.ok) + ' saved');
      if (b.failed) parts.push(group(b.failed) + ' failed');
      if (b.skipped) parts.push(group(b.skipped) + ' skipped');
      if (b.quotaLeft !== null) {
        parts.push(group(b.quotaLeft) + ' ' + plural(b.quotaLeft, 'download') + ' left on the account');
      }
      kind = b.failed > 0 ? 'bad' : 'ok';
    }
    setText(C.dlLine, parts.filter(Boolean).join(' · '));

    if (b.current && b.running) {
      var current = document.createElement('span');
      current.className = 'sp-quiet';
      current.textContent = b.current;
      // Built, never interpolated: a clip title is user text.
      C.dlLine.appendChild(document.createTextNode(' — '));
      C.dlLine.appendChild(current);
    }

    setFill(C.dlFill, b.running ? percent(b.done, b.total) : (b.failed > 0 ? 100 : (b.ok ? 100 : 0)), kind);
    C.dlBox.classList.toggle('is-bad', !b.running && b.failed > 0);
  }

  /**
   * The toolbar, from state only. Called from every painter rather than from the
   * handlers, so a control can never be enabled by something that did not change
   * what it would do — and so the dead-context latch can disable the whole row
   * from one place.
   */
  function paintControls() {
    var dead = state.contextDead;
    var selected = state.selection.size;
    var busy = state.batch.running;

    C.sync.disabled = dead || state.syncRunning;
    C.syncStop.hidden = !state.syncRunning;
    C.syncStop.disabled = dead || state.syncCancelling;
    C.sync.textContent = state.syncRunning ? 'Syncing' : 'Sync';

    C.dlSel.disabled = dead || selected === 0 || busy;
    C.dlSel.textContent = selected ? 'Download selected (' + group(selected) + ')' : 'Download selected';
    C.dlAll.disabled = dead || busy || state.librarySize <= 0;
    C.dlStop.hidden = !busy;
    C.dlStop.disabled = dead || state.batch.stopping;
    // Only offered when the settled batch actually left failures behind;
    // `DOWNLOAD_RETRY_FAILED` replays the recorded failed rows and nothing else.
    C.dlRetry.hidden = busy || state.batch.failed <= 0;
    C.dlRetry.disabled = dead;

    var haveRows = state.clips.length > 0;
    C.selbar.hidden = !haveRows || dead;
    C.selAll.disabled = !haveRows;
    setText(C.selCount, group(selected) + ' selected');
    C.selClear.hidden = selected === 0;
    C.selClear.disabled = dead;
    paintSelectAll();
  }

  /**
   * The tri-state. Deliberately derived from the ROWS ON SCREEN and the saved
   * selection together: the shown rows are "all selected" only when every id is
   * in the set, and "some" whenever the count is between the two.
   *
   * It never rewrites the whole selection. The panel holds 50 rows at a time out
   * of a library that can be thousands, so "select all" that meant "replace the
   * selection with these fifty" would be a trap on exactly the large libraries
   * this feature exists for.
   */
  function paintSelectAll() {
    if (!C.selAll) return;
    var total = state.pageIds.length;
    var onPage = 0;
    for (var i = 0; i < total; i += 1) {
      if (state.selection.has(state.pageIds[i])) onPage += 1;
    }
    C.selAll.checked = total > 0 && onPage === total;
    C.selAll.indeterminate = onPage > 0 && onPage < total;
    C.selAll.setAttribute('aria-label', total
      ? 'Select the ' + group(total) + ' ' + plural(total, 'clip') + ' shown'
      : 'Select the clips shown');
  }

  /**
    * Fold any completeness fields a reply carried into what is already known and
   * repaint. A reply with no such field changes nothing, and a sparse one — a
   * `GET_CLIPS` carrying only `truncated` — keeps the reason that
   * `SYNC_STATUS.cursor` already supplied.
   *
   * @param {object} reply any `GET_CLIPS` / `GET_FACETS` / `SYNC_STATUS` reply
   */
  function applySyncReply(reply) {
    var fresh = readSyncFacts(reply);
    if (!fresh || !fresh.hasContract || isPlaceholderSyncFacts(fresh)) return;
    state.syncFacts = mergeSyncFacts(state.syncFacts, fresh);
    paintBanner(state.syncFacts);
  }

  /**
   * Live counts from `GET_FACETS`. The worker computes these over the WHOLE
   * library plus the size of the current match, which is exactly the pair of
   * numbers a browser needs: "312 of 1,203".
   *
   * @param {object} reply
   */
  function renderFacets(reply) {
    var facets = (reply && reply.facets) || {};
    var counts = facets.counts || {};
    var libraryTotal = typeof reply.total === 'number' ? reply.total : 0;
    var matched = typeof reply.matched === 'number' ? reply.matched : state.total;

    // Project id -> name, used to label each row's workspace.
    var projects = Array.isArray(reply.projects) ? reply.projects : [];
    for (var i = 0; i < projects.length; i += 1) {
      var project = projects[i];
      if (project && project.id !== undefined && project.name !== undefined) {
        state.projectNames[String(project.id)] = String(project.name);
      }
    }

    C.facets.textContent = '';

    appendFacet('total', libraryTotal);
    appendFacet('matched', matched);
    if (typeof counts.liked === 'number' && counts.liked > 0) appendFacet('liked', counts.liked);
    if (typeof counts.disliked === 'number' && counts.disliked > 0) appendFacet('disliked', counts.disliked);
    if (typeof counts.instrumental === 'number' && counts.instrumental > 0) appendFacet('instrumental', counts.instrumental);

    var models = Array.isArray(facets.models) ? facets.models : [];
    for (var m = 0; m < models.length && m < 6; m += 1) {
      appendFacet(models[m].label || models[m].id, models[m].count);
    }

    setText(C.count, libraryTotal + ' ' + plural(libraryTotal, 'clip') + ' indexed');

    // The banner is driven by the COMPLETENESS FIELDS, not by `truncated`
    // alone: a reply that says `completed:true` clears it, and one that names a
    // `stopReason` gets the real cause printed.
    applySyncReply(reply);
  }

  /** @param {string} label @param {number} value */
  function appendFacet(label, value) {
    var item = document.createElement('li');
    item.className = 'sp-facet';

    var name = document.createElement('span');
    name.textContent = label + ' ';

    var count = document.createElement('b');
    count.textContent = String(value);

    item.appendChild(name);
    item.appendChild(count);
    C.facets.appendChild(item);
  }

  /* ----------------------------------------------------------------- rows */

  /**
   * The workspace label for a clip. Suno has NO project field on a clip;
   * membership is joined from the project feed, so a clip with no membership is
   * the unassigned bucket, which the worker names "My Workspace".
   *
   * @param {object} clip
   * @returns {string}
   */
  function workspaceOf(clip) {
    var ids = Array.isArray(clip.projectIds) ? clip.projectIds
      : (Array.isArray(clip.project_ids) ? clip.project_ids : []);
    for (var i = 0; i < ids.length; i += 1) {
      var name = state.projectNames[String(ids[i])];
      if (name) return name;
    }
    return 'My Workspace';
  }

  /** @param {object} clip @returns {string} */
  function modelOf(clip) {
    var meta = (clip && clip.metadata) || {};
    return String(meta.major_model_version || clip.model_name || '').trim();
  }

  /**
   * Build ONE row. Every text value goes in through `textContent`; the only
   * markup is the element structure created here.
   *
   * @param {object} clip a raw clip row as `GET_CLIPS` returns it
   * @returns {HTMLLIElement}
   */
  function buildRow(clip) {
    var row = document.createElement('li');
    row.className = 'sp-row';
    var clipId = String(clip.id || '');
    var label = String(clip.title || '').trim() || 'untitled';

    /* ---- selection tick ----
     * A checkbox, not a tri-state button on the row: it is the one control the
     * keyboard and every screen reader already know, and it matches the dock's
     * per-row tick so a clip means the same thing in both places. The row's tint
     * mirrors the tick, so a selection is visible from the row itself. */
    var pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'sp-check';
    pick.checked = !!clipId && state.selection.has(clipId);
    pick.disabled = !clipId;
    // Untrusted: the title is user text, and `aria-label` is set through the
    // same text-only path.
    pick.setAttribute('aria-label', clipId ? 'Select ' + label : 'This clip has no id, so it cannot be selected');
    if (clipId) {
      (function (id) {
        pick.addEventListener('change', function () {
          onRowPick(id, pick.checked);
        });
      })(clipId);
      state.pageIds.push(clipId);
    }
    if (clipId && state.selection.has(clipId)) row.classList.add('is-sel');
    row.appendChild(pick);

    var body = document.createElement('div');
    body.className = 'sp-body';

    /* ---- title line ---- */
    var titleRow = document.createElement('div');
    titleRow.className = 'sp-title-row';

    var name = document.createElement('span');
    name.className = 'sp-name';
    // Untrusted: a clip title is arbitrary user text.
    name.textContent = String(clip.title || '').trim() || 'untitled';
    name.title = String(clip.title || '').trim() || 'untitled';

    titleRow.appendChild(name);

    var model = modelOf(clip);
    if (model) {
      var badge = document.createElement('span');
      badge.className = 'sp-badge';
      badge.textContent = model;
      titleRow.appendChild(badge);
    }

    // Liked state only. There is no per-clip dislike field to read here; the
    // disliked TOTAL comes from GET_FACETS and is shown above the list.
    var liked = clip.isLiked === true || clip.is_liked === true;
    var disliked = clip.disliked === true || clip.is_disliked === true;
    if (liked || disliked) {
      var dots = document.createElement('span');
      dots.className = 'sp-dots';
      if (liked) {
        var likedDot = document.createElement('span');
        likedDot.className = 'sp-dotmark is-liked';
        likedDot.title = 'Liked';
        likedDot.setAttribute('aria-label', 'Liked');
        dots.appendChild(likedDot);
      }
      if (disliked) {
        var dislikedDot = document.createElement('span');
        dislikedDot.className = 'sp-dotmark is-disliked';
        dislikedDot.title = 'Downvoted';
        dislikedDot.setAttribute('aria-label', 'Downvoted');
        dots.appendChild(dislikedDot);
      }
      titleRow.appendChild(dots);
    }

    body.appendChild(titleRow);

    /* ---- meta line ---- */
    var day = formatDay(clip.created_at);
    var metaLine = document.createElement('div');
    metaLine.className = 'sp-meta';

    var workspace = document.createElement('span');
    workspace.className = 'sp-workspace';
    workspace.textContent = workspaceOf(clip);
    metaLine.appendChild(workspace);

    if (day) {
      var sep1 = document.createElement('span');
      sep1.className = 'sp-sep';
      sep1.textContent = '·';
      metaLine.appendChild(sep1);

      var dateNode = document.createElement('span');
      dateNode.className = 'sp-date';
      dateNode.textContent = day;
      metaLine.appendChild(dateNode);
    }

    if (typeof clip.duration === 'string' && clip.duration) {
      var sep2 = document.createElement('span');
      sep2.className = 'sp-sep';
      sep2.textContent = '·';
      metaLine.appendChild(sep2);

      var duration = document.createElement('span');
      duration.className = 'sp-duration';
      duration.textContent = clip.duration;
      metaLine.appendChild(duration);
    }

    body.appendChild(metaLine);

    /* ---- per-row status line, also where a DL_ITEM lands ---- */
    var note = document.createElement('div');
    note.className = 'sp-note';
    var style = String((clip.metadata && clip.metadata.tags) || '').trim();
    note.textContent = style;
    note.title = style;
    body.appendChild(note);

    row.appendChild(body);

    /* ---- download button ---- */
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sp-dl';
    button.textContent = 'Download';
    button.setAttribute('aria-label', 'Download ' + label + ' (' + (clipId || 'unknown clip') + ')');
    button.addEventListener('click', function () {
      void downloadOne(clip, button, note).catch(reportUnexpected);
    });
    row.appendChild(button);

    if (clipId) state.rows.set(clipId, { button: button, note: note, pick: pick, row: row });

    return row;
  }

  /**
   * @param {string|null} message
   */
  function renderEmpty(message) {
    state.rows.clear();
    // Select-all is computed from the rows on screen, so an empty list has to
    // clear it — otherwise it stays "all selected" over nothing.
    state.pageIds = [];
    C.list.textContent = '';
    var empty = document.createElement('li');
    empty.className = 'sp-empty';
    empty.textContent = message;
    C.list.appendChild(empty);
    paintControls();
  }

  /* -------------------------------------------------------------- querying */

  /**
   * The spec sent to `GET_CLIPS`. An empty `spec` is legitimate here — the
   * worker pages the whole library — but the search term is always an EXPLICIT
   * `text` field when there is one, and never an absent key that means
   * something else.
   *
   * @returns {object}
   */
  function buildSpec() {
    var spec = {};
    if (state.query) {
      spec.text = state.query;
      spec.textMode = 'any';
    }
    return spec;
  }

  /**
   * Run a query for the CURRENT state. `append` is used by "Load more".
   * @param {boolean} append
   */
  function runQuery(append) {
    // The extension this panel belonged to is gone; every request below would
    // reject and repaint an error that says nothing about the library.
    if (state.contextDead) return Promise.resolve();

    var seq = state.seq + 1;
    state.seq = seq;

    var offset = append ? state.offset : 0;
    state.loading = true;
    C.more.disabled = true;
    setText(C.status, append ? 'Loading more…' : (state.query ? 'Searching…' : 'Loading…'));
    if (!append) showError(null);

    return send('GET_CLIPS', {
      spec: buildSpec(),
      limit: PAGE_SIZE,
      offset: offset,
      sort: state.sort,
      order: state.order
    }).then(
      function (reply) {
        // A slower earlier reply must never repaint over a newer one.
        if (seq !== state.seq) {
          dbg('discarding stale reply', seq, 'current', state.seq);
          return;
        }
        var clips = Array.isArray(reply.clips) ? reply.clips : [];
        state.total = typeof reply.total === 'number' ? reply.total : clips.length;
        state.hasMore = reply.hasMore === true;
        state.librarySize = typeof reply.librarySize === 'number' ? reply.librarySize : state.total;
        state.clips = append ? state.clips.concat(clips) : clips;
        // The next cursor is derived from the worker's OWN reported offset plus
        // what it actually returned, not from how many rows this panel happens
        // to be holding. A short final page would otherwise re-request the tail
        // it already has.
        var served = typeof reply.offset === 'number' ? reply.offset : offset;
        state.offset = served + clips.length;

        applySyncReply(reply);

        if (!state.clips.length) {
          // The second sentence used to send the user to "the toolbar popup or
          // the side panel" for a sync the side panel could not start. It can
          // now, so it points at the control that is actually on screen — and
          // says what a sync does, because a first-time user does not know that
          // indexing is what turns a signed-in session into a browsable library.
          renderEmpty(state.query
            ? 'No indexed clip matches “' + state.query + '”.'
            : 'Nothing is indexed yet. Press Sync to read your Suno feed and build the index. '
              + 'The search above only ever reads what a sync has already stored.');
        } else {
          // Only the rows THIS page returned are rendered. Passing the
          // accumulated list here would duplicate every earlier page on each
          // "Load more", because the DOM already holds them.
          renderRows(clips, append);
          var label = state.clips.length + ' of ' + state.total + ' ' + plural(state.total, 'clip');
          if (state.query) label += ' matching “' + state.query + '”';
          setText(C.status, label);
        }

        C.more.hidden = !state.hasMore;
        C.more.disabled = false;
        state.loading = false;
        paintControls();

        // Facets are a second, cheap call, and only after the rows are on
        // screen: a failed facet call must not hold up the list.
        return refreshFacets().catch(function (err) {
          // Facet counts are decoration on top of a list that is already
          // correct, so a failure here is logged and never painted over it —
          // EXCEPT a dead context, which is not decoration: it invalidates
          // everything this panel can do.
          if (isDeadContext(err)) {
            showContextNotice();
            return;
          }
          dbg('GET_FACETS failed:', textOf(err));
        });
      },
      function (err) {
        if (seq !== state.seq) return;
        state.loading = false;
        C.more.disabled = false;
        if (isDeadContext(err)) {
          showContextNotice();
          return;
        }
        var message = textOf(err);
        showError(message);
        if (!state.clips.length) renderEmpty('Could not read the library: ' + message);
        setText(C.status, 'Query failed.');
        paintControls();
      }
    );
  }

  function refreshFacets() {
    return send('GET_FACETS', { spec: buildSpec() }).then(function (reply) {
      renderFacets(reply);
    });
  }

  /**
   * @param {object[]} clips
   * @param {boolean} append
   */
  function renderRows(clips, append) {
    if (!append) {
      C.list.textContent = '';
      state.rows.clear();
      state.pageIds = [];
    }
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < clips.length; i += 1) {
      fragment.appendChild(buildRow(clips[i]));
    }
    C.list.appendChild(fragment);
    paintControls();
  }

  /* ------------------------------------------------------------ downloading */

  /**
   * Queue ONE clip.
   *
   * The payload is explicit — `ids` with exactly this clip — so a row button can
   * never be read as "download everything". A refusal surfaces on the row AND
   * in the panel's alert region; it is never reported as done.
   *
   * @param {object} clip
   * @param {HTMLButtonElement} button
   * @param {HTMLElement} note
   */
  async function downloadOne(clip, button, note) {
    var clipId = String(clip.id || '');
    if (!clipId) {
      button.disabled = true;
      button.classList.add('is-bad');
      button.textContent = 'No id';
      setText(note, 'This clip has no id, so it cannot be queued.');
      note.classList.add('is-bad');
      return;
    }

    var settings = state.settings || {};
    var ladder = Array.isArray(settings.downloadSource) ? settings.downloadSource : [];

    button.disabled = true;
    button.classList.remove('is-ok', 'is-bad');
    button.textContent = 'Starting…';
    note.classList.remove('is-ok', 'is-bad');
    setText(note, 'Queuing…');

    var payload = {
      ids: [clipId],
      variant: settings.variant,
      source: ladder.slice(),
      tagOptions: settings.tagOptions,
      overwrite: settings.overwrite === true
    };
    if (payload.source.length === 0) delete payload.source;

    try {
      var reply = await send('DOWNLOAD_START', payload);
      if (reply.dryRun === true) {
        button.textContent = 'Planned';
        button.classList.add('is-ok');
        setText(note, 'Dry run: planned, nothing downloaded, no quota spent.');
        note.classList.add('is-ok');
      } else if (reply.stopped === 'quota' || reply.quotaShortfall) {
        button.textContent = 'No quota';
        button.classList.add('is-bad');
        var short = reply.quotaShortfall || {};
        var text = short.message || 'Not enough downloads remain for this batch.';
        setText(note, text);
        note.classList.add('is-bad');
        showError(text);
      } else if (!reply.planned) {
        button.textContent = 'Skipped';
        setText(note, reply.note || 'Nothing to download — this file is already saved for that format.');
      } else {
        button.textContent = 'Queued';
        button.classList.add('is-ok');
        setText(note, 'Queued' + (typeof reply.skipped === 'number' && reply.skipped
          ? ' (' + reply.skipped + ' already on disk)'
          : '') + '. The batch runs in the background; this button updates when the file is written.');
      }
      announce(String(clip.title || 'Clip') + ': ' + button.textContent);
    } catch (err) {
      // Reachable, and the whole point: a refusal must be visible, not "Done".
      button.disabled = false;
      button.classList.add('is-bad');
      button.textContent = 'Retry';
      var message = textOf(err);
      setText(note, message);
      note.classList.add('is-bad');
      showError('Download failed: ' + message);
    }
  }

  /**
   * Flip the row a `DL_ITEM` refers to. Without this the panel would show
   * "Queued" forever, because the worker's result arrives as a push and not as
   * a reply to the button's own request.
   *
   * @param {object} msg
   */
  function applyDlItem(msg) {
    var entry = state.rows.get(String(msg.clipId || ''));
    if (!entry) return;

    var button = entry.button;
    var note = entry.note;
    var itemState = String(msg.state || '');

    if (itemState === 'ok') {
      button.textContent = 'Saved';
      button.classList.add('is-ok');
      button.disabled = true;
      setText(note, msg.filename ? 'Saved ' + msg.filename : 'Saved');
      note.classList.remove('is-bad');
      note.classList.add('is-ok');
      return;
    }
    if (itemState === 'failed') {
      button.textContent = 'Retry';
      button.classList.remove('is-ok');
      button.classList.add('is-bad');
      button.disabled = false;
      setText(note, 'Failed: ' + (msg.error ? String(msg.error) : 'unknown error'));
      note.classList.add('is-bad');
      showError('A download failed: ' + (msg.error ? String(msg.error) : 'unknown error'));
      return;
    }
    if (itemState === 'skipped') {
      button.textContent = 'Skipped';
      setText(note, msg.error ? 'Skipped: ' + String(msg.error) : 'Skipped');
      note.classList.add('is-ok');
      return;
    }
    if (itemState === 'pending') {
      button.textContent = 'In flight';
      setText(note, 'Transfer in flight; it will be reconciled when the browser reports it finished.');
    }
  }

  /* ------------------------------------------------------------ selection */

  /**
   * The worker's saved selection, read once on open.
   *
   * It is NOT the panel's own set: `SET_SELECTION` writes to
   * `chrome.storage.session` and to the DB, and both the popup and the dock act
   * on that copy. A private set here would be a third selection the user could
   * not see, and "download selected" would quietly disagree with the count in
   * the popup.
   *
   * Ids the panel has never rendered are KEPT — it holds 50 rows of a library
   * that can be thousands, so the DOM was never the selection.
   *
   * Best-effort by design, and it is NOT allowed to fall back to "nothing
   * selected, therefore everything" anywhere downstream: that fallback is the
   * defect `DOWNLOAD_START`'s explicit-ids contract exists to prevent.
   *
   * @returns {Promise<void>}
   */
  async function loadSelection() {
    try {
      var reply = await send('GET_SELECTION', {});
      var ids = Array.isArray(reply.ids) ? reply.ids : [];
      state.selection = new Set(ids.map(String).filter(Boolean));
    } catch (err) {
      if (isDeadContext(err)) {
        showContextNotice();
        return;
      }
      // An unreadable selection leaves an EMPTY one. Every action below refuses
      // on an empty set rather than widening it, so the cost of this branch is
      // "the count reads 0 until you tick something" and never a surprise batch.
      dbg('GET_SELECTION failed:', textOf(err));
      state.selection = new Set();
    }
    repaintTicks();
    paintControls();
  }

  /**
   * Persist the selection after a short quiet period, the way the dock does
   * (content/content.js). Ticking fifty rows must not be fifty writes.
   */
  function scheduleSelectionPush() {
    if (state.selectionTimer) clearTimeout(state.selectionTimer);
    state.selectionTimer = setTimeout(pushSelection, SELECTION_PUSH_MS);
  }

  async function pushSelection() {
    state.selectionTimer = 0;
    try {
      await send('SET_SELECTION', { ids: Array.from(state.selection) });
    } catch (err) {
      paintFailure(err, 'Could not save the selection');
    }
  }

  /**
   * Push the current set into every tick and row tint on screen. Needed after a
   * `GET_SELECTION` (the rows may already be built) and after a bulk action.
   */
  function repaintTicks() {
    state.rows.forEach(function (entry, id) {
      if (!entry.pick) return;
      entry.pick.checked = state.selection.has(id);
      if (entry.row) entry.row.classList.toggle('is-sel', entry.pick.checked);
    });
    paintSelectAll();
  }

  /** @param {string} clipId @param {boolean} checked */
  function onRowPick(clipId, checked) {
    if (checked) state.selection.add(clipId);
    else state.selection.delete(clipId);
    var entry = state.rows.get(clipId);
    if (entry && entry.row) entry.row.classList.toggle('is-sel', checked);
    scheduleSelectionPush();
    paintControls();
    announce(group(state.selection.size) + ' ' + plural(state.selection.size, 'clip') + ' selected.');
  }

  /**
   * Add or remove exactly the rows on screen. It does NOT replace the whole
   * selection, because most of the selection is not on screen: doing that would
   * make "select the clips shown" on a 5,000-clip library throw away a
   * selection the user built page by page.
   *
   * @param {boolean} checked
   */
  function onSelectAll(checked) {
    var ids = state.pageIds;
    for (var i = 0; i < ids.length; i += 1) {
      if (checked) state.selection.add(ids[i]);
      else state.selection.delete(ids[i]);
    }
    repaintTicks();
    scheduleSelectionPush();
    paintControls();
    announce(checked
      ? 'Selected the ' + group(ids.length) + ' ' + plural(ids.length, 'clip') + ' shown. '
        + group(state.selection.size) + ' selected in total.'
      : 'Cleared the ' + group(ids.length) + ' ' + plural(ids.length, 'clip') + ' shown. '
        + group(state.selection.size) + ' still selected.');
  }

  /**
   * The only way to drop ids that are not on screen. Without it, a selection
   * made in the dock or the popup could only be cleared by going back there.
   */
  function onClearSelection() {
    var n = state.selection.size;
    state.selection = new Set();
    repaintTicks();
    void send('SET_SELECTION', { ids: [] }).catch(function (err) {
      paintFailure(err, 'Could not clear the selection');
    });
    paintControls();
    announce('Cleared ' + group(n) + ' selected ' + plural(n, 'clip') + '.');
  }

  /* ------------------------------------------------------- batch actions */

  /**
   * A structural guarantee, copied from popup/popup.js for the same reason: a
   * `DOWNLOAD_START` with neither a non-empty `ids` array nor a non-empty `spec`
   * is a request whose meaning the worker has to guess, and what
   * `resolveBatchClips` guesses when both are absent is THE WHOLE LIBRARY. That
   * is a batch that can spend a month's allowance on one mis-clicked button.
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

  /**
   * The shared part of both bulk actions: the worker's own settings for variant,
   * source ladder, tags and overwrite, so this panel never invents a format and
   * never drifts from what the popup would have sent for the same batch.
   *
   * @returns {object}
   */
  function downloadBasePayload() {
    var settings = state.settings || {};
    var payload = {
      variant: settings.variant,
      tagOptions: settings.tagOptions,
      overwrite: settings.overwrite === true
    };
    if (Array.isArray(settings.downloadSource) && settings.downloadSource.length) {
      payload.source = settings.downloadSource.slice();
    }
    return payload;
  }

  /**
   * One confirmation sentence for a batch that spends download credit. "One
   * song uses one download regardless of format" is the fact that decides
   * whether a user clicks through, so it is in the sentence rather than in a
   * tooltip.
   *
   * @param {number} count
   * @param {boolean} wholeLibrary
   * @returns {boolean}
   */
  function confirmBatch(count, wholeLibrary) {
    var head = wholeLibrary
      ? 'Queue all ' + group(count) + ' indexed ' + plural(count, 'clip') + '?'
      : 'Queue ' + group(count) + ' selected ' + plural(count, 'clip') + '?';
    return window.confirm(head
      + '\n\nOne song uses one download regardless of the format you pick, and the format and source ladder come from Settings. '
      + 'A dry run in Settings plans a batch without spending any of it.');
  }

  async function downloadSelected() {
    if (state.contextDead || state.batch.running) return;
    var ids = Array.from(state.selection).map(String).filter(Boolean);
    if (!ids.length) {
      showError('No clips are selected, so nothing was queued. Tick a row, or use Download all to queue the whole library.');
      announce('Nothing was queued: no clips are selected.');
      return;
    }
    if (!confirmBatch(ids.length, false)) {
      announce('Batch cancelled before it started.');
      return;
    }
    var payload;
    try {
      payload = assertDownloadPayload(Object.assign(downloadBasePayload(), { ids: ids }));
    } catch (err) {
      paintFailure(err, 'Refused to start');
      return;
    }
    try {
      var reply = await send('DOWNLOAD_START', payload);
      applyBatchReply(reply, 'selected');
    } catch (err) {
      paintFailure(err, 'Could not start the batch');
    }
  }

  /**
   * The whole library, named EXPLICITLY. `payload.spec` rather than an absent
   * filter, because an absent filter means "everything" only by accident.
   * `includeUnassigned` is what keeps the clips in no project — the unassigned
   * bucket the worker calls "My Workspace" — in the plan.
   */
  async function downloadAll() {
    if (state.contextDead || state.batch.running) return;
    var count = state.librarySize;
    if (!(count > 0)) {
      showError('Nothing to download: the index is empty. Sync first.');
      announce('Nothing was queued: the index is empty.');
      return;
    }
    if (!confirmBatch(count, true)) {
      announce('Batch cancelled before it started.');
      return;
    }
    var payload;
    try {
      payload = assertDownloadPayload(Object.assign(downloadBasePayload(), {
        spec: { includeUnassigned: true, sort: 'newest', order: 'desc' }
      }));
    } catch (err) {
      paintFailure(err, 'Refused to start');
      return;
    }
    try {
      var reply = await send('DOWNLOAD_START', payload);
      applyBatchReply(reply, 'whole library');
    } catch (err) {
      paintFailure(err, 'Could not start the batch');
    }
  }

  /**
   * The `DOWNLOAD_START` reply, painted as one of the four outcomes the worker
   * can report. `reply.planned` absent with `stopped: 'quota'` is a batch that
   * never started, and saying "Queued" there would be the "says done, is not
   * done" defect this repo documents.
   *
   * @param {object} reply
   * @param {string} via what the user asked for, for the spoken line
   */
  function applyBatchReply(reply, via) {
    var b = state.batch;
    b.batchId = reply.batchId ? String(reply.batchId) : '';
    b.done = 0;
    b.total = typeof reply.planned === 'number' ? reply.planned : 0;
    b.ok = 0;
    b.failed = 0;
    b.skipped = 0;
    b.current = '';
    b.etaMs = 0;
    b.quotaLeft = null;
    b.stopping = false;
    b.settled = '';

    if (reply.dryRun === true) {
      // A dry run is a success that downloaded nothing. Both flags are set on
      // every branch below so a stale severity cannot survive into the summary.
      b.running = false;
      b.skipped = b.total;
      b.settled = 'Dry run: ' + group(b.total) + ' ' + plural(b.total, 'file') + ' planned, nothing downloaded and no quota spent';
      announce('Dry run: ' + group(b.total) + ' files planned. Nothing was downloaded.');
    } else if (reply.stopped === 'quota' || reply.quotaShortfall) {
      b.running = false;
      b.skipped = typeof reply.skipped === 'number' ? reply.skipped : 0;
      var short = reply.quotaShortfall || {};
      b.settled = 'Stopped before starting: ' + group(b.total) + ' of ' + group(short.needed) + ' fit';
      var text = short.message || 'Not enough downloads remain for this batch.';
      showError(text);
      announce(text);
    } else if (!reply.planned) {
      b.running = false;
      b.skipped = 0;
      b.settled = reply.note || 'Nothing to download: every clip in this batch is already saved for that format.';
      announce(b.settled);
    } else {
      b.running = true;
      var skipped = typeof reply.skipped === 'number' ? reply.skipped : 0;
      b.settled = '';
      announce('Queued ' + group(b.total) + ' ' + plural(b.total, 'clip') + ' from the ' + via + '. '
        + (skipped ? group(skipped) + ' already on disk and skipped. ' : '')
        + 'The batch runs in the background.');
    }
    paintBatch();
  }

  /**
   * `DOWNLOAD_CANCEL`. The abort is cooperative, so this does NOT end the batch
   * here — it says stopping, and `DL_DONE` settles it. Claiming the batch had
   * stopped before `DL_DONE` arrives is how a panel ends up reporting a
   * cancelled batch as still running forever.
   */
  async function stopDownloads() {
    if (!state.batch.running) return;
    state.batch.stopping = true;
    paintBatch();
    announce('Stopping the downloads. Transfers already in flight finish first.');
    try {
      var reply = await send('DOWNLOAD_CANCEL', {});
      if (!reply || reply.ok !== true) {
        state.batch.stopping = false;
        paintBatch();
        showError('Could not stop the downloads: the worker did not confirm.');
        return;
      }
      // `aborted` is false when nothing was attached to abort. If the panel
      // thinks a batch is running and the worker says nothing was, the pushes
      // have gone missing — the pop is the correction.
      if (reply.aborted !== true) {
        state.batch.running = false;
        state.batch.stopping = false;
        state.batch.settled = 'No download batch was running in the worker.';
        paintBatch();
        announce('No download batch was running.');
      }
    } catch (err) {
      state.batch.stopping = false;
      paintBatch();
      paintFailure(err, 'Could not stop the downloads');
    }
  }

  /**
   * `DOWNLOAD_RETRY_FAILED`. This replays the rows the worker recorded as
   * FAILED and nothing else — clips that were saved are left alone, and clips
   * that were never attempted are not part of this. So it is only offered when
   * the settled batch reported failures.
   */
  async function retryFailedDownloads() {
    if (state.contextDead || state.batch.running) return;
    try {
      var reply = await send('DOWNLOAD_RETRY_FAILED', {});
      if (!reply || typeof reply.planned !== 'number' || !reply.planned) {
        showError(reply && reply.note ? reply.note : 'There are no failed downloads to retry.');
        announce('There are no failed downloads to retry.');
        return;
      }
      applyBatchReply(reply, 'failed downloads');
    } catch (err) {
      paintFailure(err, 'Could not retry the failed downloads');
    }
  }

  /* -------------------------------------------------------- sync actions */

  /**
   * `SYNC_START`, with the STORED settings and no panel-side overrides.
   *
   * There is deliberately no disliked-mode or page-cap control here: both are
   * settings, and duplicating them in a 320px column would give the user two
   * places that disagree. What the worker actually applied comes back on the
   * reply and is what the bar is measured against.
   *
   * @returns {Promise<void>}
   */
  async function startSync() {
    if (state.contextDead || state.syncRunning) return;
    var settings = state.settings || {};
    C.sync.disabled = true;
    setText(C.status, 'Starting a sync…');
    try {
      var reply = await send('SYNC_START', {
        force: false,
        dislikedMode: settings.dislikedMode,
        maxPages: settings.syncMaxPages
      });
      state.syncMaxPages = typeof reply.maxPages === 'number' ? reply.maxPages : 0;
      state.syncPagesDone = 0;
      state.syncTotalSeen = 0;
      state.syncPhase = '';
      state.syncEtaMs = 0;
      setSyncRunning(true, false);
      scheduleSyncPoll(true);
      var mode = reply.dislikedMode ? ' (' + String(reply.dislikedMode) + ')' : '';
      announce('Sync started' + mode + (state.syncMaxPages > 0 ? ', page cap ' + group(state.syncMaxPages) : '') + '.');
    } catch (err) {
      C.sync.disabled = false;
      // `SYNC_START` refuses with `sync_running` when a crawl is already in
      // flight — which is the worker's word for "you are already syncing", so
      // the panel adopts that state instead of reporting a failure the user can
      // do nothing about.
      if (err && err.code === 'sync_running') {
        setSyncRunning(true, false);
        scheduleSyncPoll(true);
        announce('A sync was already running.');
        return;
      }
      paintFailure(err, 'Could not start the sync');
    }
  }

  /**
   * `SYNC_CANCEL`.
   *
   * The reply is a contract and this handler reads it as one:
   * `{running, cancelRequested, abortAvailable, orphanedCursorCleared, stale}`.
   * An earlier copy of this file had no way to read it, which is why the panel
   * used to be able to sit on "stopping…" with no exit — an abort is
   * cooperative and a rate-limit backoff can hold a page open, so the panel
   * polls `SYNC_STATUS` for a bounded time and then says plainly that the
   * worker has not stopped yet.
   */
  async function stopSync() {
    if (state.contextDead || !state.syncRunning) return;
    try {
      var reply = await send('SYNC_CANCEL', {});
      if (reply && reply.orphanedCursorCleared === true) {
        // Nothing was running; the press cleared a crawl the worker had
        // abandoned after an eviction. Indexed clips were kept — saying so
        // matters, because "cancel" reads like "I lost my library".
        setSyncRunning(false, false);
        stopSyncPoll();
        announce(reply.stale === true
          ? 'Cleared a crawl the extension worker had abandoned. Indexed clips were kept.'
          : 'Cleared the stale sync state. Indexed clips were kept.');
        void refreshSyncStatus().catch(function (err) { dbg('SYNC_STATUS after cancel failed:', textOf(err)); });
        return;
      }
      if (reply && reply.running === false) {
        setSyncRunning(false, false);
        stopSyncPoll();
        announce('No sync was running.');
        return;
      }
      setSyncRunning(true, true);
      announce('Stopping the sync. The worker checks for the cancel between pages, so a rate-limit wait delays it.');
      await waitForSyncToStop(SYNC_STOP_WAIT_MS);
    } catch (err) {
      paintFailure(err, 'Could not stop the sync');
    }
  }

  /**
   * Wait for `SYNC_STATUS` to report the crawl settled, then report the
   * authoritative state either way. Never rejects: the timeout is a legitimate
   * outcome, and the poll keeps running so the panel corrects itself when the
   * worker finally does stop.
   *
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async function waitForSyncToStop(timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(SYNC_STOP_POLL_MS);
      if (!state.syncRunning) return;
    }
    if (state.syncRunning) {
      announce('Still stopping. The worker is waiting on a rate limit and will stop at the next page boundary.');
    }
  }

  /** @param {number} ms @returns {Promise<void>} */
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ------------------------------------------------------------------ wire */

  /**
   * The four `stoppedReason` values the worker's ternary can produce
   * (background/background.js runBatch). Kept in the popup's vocabulary so one
   * batch tells the same story in both surfaces.
   */
  var STOPPED_REASONS = ['complete', 'cancelled', 'quota', 'ladder_exhausted'];

  var OUTCOME_PHRASE = {
    complete: 'finished',
    cancelled: 'cancelled',
    quota: 'stopped on the download allowance',
    ladder_exhausted: 'failed: every source refused it'
  };

  /**
   * The outcome, normalised, using the popup's fallback rule.
   *
   * A worker that predates `stoppedReason` sends no such field, and reporting
   * that as a plain success is the defect this reconstructs: `ok === 0 &&
   * failed > 0` means every rung refused the batch, not that it worked.
   *
   * @param {object} msg
   * @returns {string}
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
   * The word "left" is the one thing a user needs from a partial batch: what was
   * never attempted is still planned, and a plain Download will pick it up.
   * Read from the worker's own fields; nothing here is invented.
   *
   * @param {object} msg
   * @returns {string}
   */
  function remainingText(msg) {
    var left = Number(msg && msg.remainingItems);
    if (isFinite(left) && left > 0) {
      return group(left) + ' ' + plural(left, 'clip') + ' never attempted — still planned';
    }
    return '';
  }

  /**
   * `DL_PROGRESS`. Every field is presence-tested and `typeof`-guarded because
   * a partial push must not blank a number the last one supplied.
   *
   * A push for a DIFFERENT batch id is ignored: without that check, a batch
   * started from the popup after this panel's own finished would repaint this
   * panel's box with the popup's counts.
   *
   * @param {object} msg
   */
  function applyDlProgress(msg) {
    var b = state.batch;
    if (msg && msg.batchId && b.batchId && String(msg.batchId) !== b.batchId) return;
    if (msg && msg.batchId) b.batchId = String(msg.batchId);
    b.running = true;
    b.stopping = false;
    if (typeof msg.done === 'number') b.done = msg.done;
    if (typeof msg.total === 'number') b.total = msg.total;
    if (typeof msg.ok === 'number') b.ok = msg.ok;
    if (typeof msg.failed === 'number') b.failed = msg.failed;
    if (typeof msg.skipped === 'number') b.skipped = msg.skipped;
    if (typeof msg.etaMs === 'number') b.etaMs = msg.etaMs;
    b.current = msg.currentTitle ? String(msg.currentTitle) : '';
    b.settled = '';
    paintBatch();
  }

  /**
   * `DL_DONE`. The batch is over and the counts are final, so the box settles
   * on the outcome and stays there — and `failed` is kept, which is what keeps
   * the Retry button honest.
   *
   * @param {object} msg
   */
  function applyDlDone(msg) {
    var b = state.batch;
    if (msg && msg.batchId && b.batchId && String(msg.batchId) !== b.batchId) return;
    b.running = false;
    b.stopping = false;
    b.current = '';
    if (typeof msg.ok === 'number') b.ok = msg.ok;
    if (typeof msg.failed === 'number') b.failed = msg.failed;
    if (typeof msg.skipped === 'number') b.skipped = msg.skipped;
    if (typeof msg.done === 'number') b.done = msg.done;
    else b.done = b.ok + b.failed + b.skipped;

    var reason = normalizeStoppedReason(msg);
    b.settled = 'Batch ' + (OUTCOME_PHRASE[reason] || reason);

    // Quota is worth one line here and nowhere else: it is the fact that
    // explains a stopped batch, and it is a reading, not an estimate.
    var quotaAfter = msg && msg.quotaAfter && typeof msg.quotaAfter === 'object' ? msg.quotaAfter : null;
    if (quotaAfter && quotaAfter.unlimited !== true && typeof quotaAfter.effectiveRemaining === 'number') {
      b.quotaLeft = quotaAfter.effectiveRemaining;
    }

    var lines = [b.settled];
    if (reason === 'quota') {
      lines.push('Downloads are the limit, not the queue. Raise nothing here: wait for the allowance, or turn off the metered sources in Settings.');
    } else if (reason === 'ladder_exhausted') {
      lines.push('Every rung in the source ladder refused these clips, so none of them was saved. A different ladder in Settings is the fix.');
    } else if (reason === 'cancelled') {
      lines.push('Nothing is broken — you stopped it.');
    }
    var rest = remainingText(msg);
    if (rest) lines.push(rest);

    // Only a genuine failure is painted red and announced as one. A cancelled
    // batch is a normal outcome; saying it out loud in an error strip is not.
    if (b.failed > 0 || reason === 'ladder_exhausted' || reason === 'quota') {
      C.dlBox.classList.add('is-bad');
    }
    paintBatch();
    announce(lines.join(' ') + ' ' + group(b.ok) + ' ' + plural(b.ok, 'clip') + ' saved'
      + (b.failed ? ', ' + group(b.failed) + ' failed' : '') + '.');
  }

  /**
   * `DL_ERROR`.
   *
   * DELIBERATELY does not end the batch, unlike the dock and the popup, and the
   * reason is the only producer of this push: `broadcastTranscodeNotice` in
   * background/background.js, whose whole message is "Cannot convert to X: Y.
   * The original file was saved unchanged." Tearing the batch bar down there
   * would report a running batch as finished — the same "says done, is not done"
   * defect the completeness contract exists to prevent, just in the other
   * direction. Liveness still comes from `DL_PROGRESS` and `DL_DONE`, and the
   * message is painted and announced at full volume.
   *
   * @param {object} msg
   */
  function applyDlError(msg) {
    var message = msg && msg.error ? String(msg.error) : 'unknown error';
    showError('Download error: ' + message);
    announce('Download error: ' + message);
    paintBatch();
  }

  /**
   * Debounced search. The previous version fired a request per keystroke; this
   * one collapses a burst into a single query after SEARCH_DEBOUNCE_MS of quiet.
   */
  function wireSearch() {
    C.search.addEventListener('input', function () {
      if (state.searchTimer !== null) clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () {
        state.searchTimer = null;
        state.query = C.search.value.trim();
        dbg('debounced search fired for', JSON.stringify(state.query));
        void runQuery(false).catch(reportUnexpected);
      }, SEARCH_DEBOUNCE_MS);
    });

    // Enter commits immediately rather than waiting out the timer.
    C.search.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (state.searchTimer !== null) {
        clearTimeout(state.searchTimer);
        state.searchTimer = null;
      }
      state.query = C.search.value.trim();
      void runQuery(false).catch(reportUnexpected);
    });

    C.search.addEventListener('search', function () {
      if (state.searchTimer !== null) {
        clearTimeout(state.searchTimer);
        state.searchTimer = null;
      }
      state.query = C.search.value.trim();
      void runQuery(false).catch(reportUnexpected);
    });

    C.sort.addEventListener('change', function () {
      state.sort = C.sort.value;
      // `title` and `oldest` read naturally ascending; everything else is a
      // ranking and reads descending.
      state.order = (state.sort === 'title' || state.sort === 'oldest') ? 'asc' : 'desc';
      void runQuery(false).catch(reportUnexpected);
    });

    C.more.addEventListener('click', function () {
      if (state.loading || !state.hasMore) return;
      void runQuery(true).catch(reportUnexpected);
    });
  }

  /**
   * The action toolbar, the selection bar, the reload notice.
   *
   * Every handler re-checks its own precondition instead of trusting the button's
   * `disabled`: `paintControls()` can be one render behind a push, and a control
   * that acts on state it did not verify is how "Download selected" becomes
   * "Download everything".
   */
  function wireActions() {
    C.sync.addEventListener('click', function () {
      void startSync().catch(reportUnexpected);
    });
    C.syncStop.addEventListener('click', function () {
      void stopSync().catch(reportUnexpected);
    });
    C.dlSel.addEventListener('click', function () {
      void downloadSelected().catch(reportUnexpected);
    });
    C.dlAll.addEventListener('click', function () {
      void downloadAll().catch(reportUnexpected);
    });
    C.dlStop.addEventListener('click', function () {
      void stopDownloads().catch(reportUnexpected);
    });
    C.dlRetry.addEventListener('click', function () {
      void retryFailedDownloads().catch(reportUnexpected);
    });

    C.selAll.addEventListener('change', function () {
      // `checked` is read, not inverted: an indeterminate click reports the
      // direction the user chose in most engines, and reading the property is
      // the only way that stays true across them.
      onSelectAll(C.selAll.checked);
    });
    C.selClear.addEventListener('click', function () {
      if (state.contextDead) return;
      onClearSelection();
    });

    C.deadReload.addEventListener('click', function () {
      // Plain DOM, no `chrome.*`: an orphaned extension page can still do this,
      // which is the entire reason the button is here. The notice also tells the
      // user to close and reopen the panel, so this is offered as the fast path
      // rather than as the only path.
      location.reload();
    });
  }

  function listenForPushes() {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg.type !== 'string') return;
      try {
        switch (msg.type) {
          case 'DL_PROGRESS':
            dbg('DL_PROGRESS', msg.done, msg.total);
            applyDlProgress(msg);
            break;
          case 'DL_ITEM':
            applyDlItem(msg);
            break;
          case 'DL_DONE':
            dbg('DL_DONE', msg.ok, msg.failed, msg.stoppedReason);
            applyDlDone(msg);
            break;
          case 'DL_ERROR':
            dbg('DL_ERROR', msg.error);
            applyDlError(msg);
            break;
          case 'SYNC_STARTED':
            dbg('SYNC_STARTED', msg);
            setSyncRunning(true, false);
            state.syncPhase = '';
            state.syncPagesDone = 0;
            state.syncTotalSeen = 0;
            state.syncEtaMs = 0;
            if (typeof msg.maxPages === 'number') state.syncMaxPages = msg.maxPages;
            scheduleSyncPoll(true);
            announce('Library sync started.');
            break;
          case 'SYNC_PROGRESS':
            dbg('SYNC_PROGRESS', msg.phase, msg);
            if (msg.phase && msg.phase !== state.syncPhase) {
              dbg('sync phase changed to', msg.phase);
              state.syncPhase = msg.phase;
            }
            state.syncPagesDone = typeof msg.pagesDone === 'number' ? msg.pagesDone : (typeof msg.page === 'number' ? msg.page : state.syncPagesDone);
            state.syncTotalSeen = typeof msg.totalSeen === 'number' ? msg.totalSeen : (typeof msg.seen === 'number' ? msg.seen : state.syncTotalSeen);
            if (typeof msg.etaMs === 'number') state.syncEtaMs = msg.etaMs;
            if (msg.note) state.syncNote = msg.note;
            setSyncRunning(true, msg.state === 'cancelling');
            scheduleSyncPoll(true);
            paintSyncStatus();
            break;
          case 'SYNC_CANCEL_REQUESTED':
            dbg('SYNC_CANCEL_REQUESTED', msg);
            setSyncRunning(true, true);
            announce('Stopping the library sync.');
            paintSyncStatus();
            break;
          case 'SYNC_CANCELLED':
            dbg('SYNC_CANCELLED', msg);
            setSyncRunning(false, false);
            stopSyncPoll();
            if (msg.orphanedCursorCleared === true) {
              announce('Sync cancelled. Orphaned cursor was cleared.');
            } else {
              announce('Sync cancelled.');
            }
            applySyncReply(msg);
            void runQuery(false).catch(reportUnexpected);
            break;
          case 'SYNC_DONE':
            // The index changed under us, so the banner has to be re-read from the
            // message: this is the ONLY push that carries `completed`,
            // `stopReason` and `expectedTotal` together. The previous copy keyed
            // on `truncated` and announced the same sentence for every short walk.
            stopSyncPoll();
            setSyncRunning(false, false);
            applySyncReply(msg);
            var syncFacts = state.syncFacts;
            var syncWarn = bannerFacts(syncFacts);
            announce(syncWarn
              ? 'Sync stopped early. The library is incomplete: ' +
                syncReasonPhrase(syncWarn.stopReason) +
                (countsPhrase(syncWarn, false) ? '. Indexed ' + countsPhrase(syncWarn, false) : '') + '.'
              : 'Sync finished. The library is up to date.');
            void runQuery(false).catch(reportUnexpected);
            break;
          case 'SYNC_ERROR':
            // A hard failure leaves an incomplete index too, so it gets the same
            // banner rather than an error strip with nothing under it.
            stopSyncPoll();
            setSyncRunning(false, false);
            applySyncReply({
              completed: false,
              stopReason: msg && msg.stopReason ? msg.stopReason : 'page_failed',
              error: msg && msg.error ? msg.error : 'unknown error'
            });
            showError('Sync error: ' + (msg.error ? String(msg.error) : 'unknown error'));
            break;
          case 'TOKEN_CHANGED':
            announce('Session changed.');
            break;
          default:
            break;
        }
      } catch (pushErr) {
        // Never let a rendering fault kill the listener.
        showError('Could not handle a ' + msg.type + ' event: ' + textOf(pushErr));
      }
    });
  }

  /* ------------------------------------------------------------------ boot */

  async function loadSettings() {
    try {
      var reply = await send('GET_SETTINGS', {});
      state.settings = reply.settings || {};
      state.debug = state.settings.debug === true;
    } catch (err) {
      if (isDeadContext(err)) {
        showContextNotice();
        return;
      }
      // The panel is still usable without settings: the row download falls back
      // to the worker's own defaults for anything missing from the payload.
      paintFailure(err, 'Could not read settings, so downloads use the worker defaults');
    }
  }

  /**
   * Read the sync completeness contract from the worker.
   *
   * `GET_CLIPS` / `GET_FACETS` only know whether the index was truncated; the
   * cursor in `SYNC_STATUS` is what carries `completed`, `stopReason`, `error`
   * and `expectedTotal`, so this is the one read that lets the banner name the
   * real cause instead of asserting a page cap that may never have been hit.
   *
   * Best-effort by design: the panel is fully usable without it, so a failure
   * is logged for debugging and nothing else. It never rejects.
   *
   * @returns {Promise<void>}
   */
  async function refreshSyncStatus() {
    try {
      var reply = await send('SYNC_STATUS', {});
      if (reply && reply.running === true) {
        setSyncRunning(true, reply.cancelling === true);
      } else if (state.syncRunning) {
        setSyncRunning(false, false);
        announce('Sync ended.');
      }
      // `readSyncFacts` reads the top level first and `cursor` as the fallback for
      // every field, and this reply carries the contract in BOTH places, so one
      // call covers the whole thing and repaints the banner.
      applySyncReply(reply);
      scheduleSyncPoll(!!(reply && reply.running));
    } catch (err) {
      dbg('SYNC_STATUS failed:', textOf(err));
    }
  }

  /**
   * Poll `SYNC_STATUS` only while a crawl is in flight.
   *
   * The toolbar popup, the in-page dock and this panel all render the same crawl,
   * and they disagreed because each kept its own copy of its state. The worker's
   * `SYNC_STATUS` is the only authority, so every surface polls it — the pushes
   * stay the fast path, this is the correction that stops the three drifting apart.
   * Idle-gated: no crawl, no timer.
   */
  var syncPollTimer = 0;
  var SYNC_POLL_MS = 1500;

  function scheduleSyncPoll(running) {
    if (syncPollTimer) {
      if (!running) stopSyncPoll();
      return;
    }
    if (!running) return;
    syncPollTimer = setInterval(function () {
      refreshSyncStatus().catch(function (pollErr) { dbg('sync poll failed:', textOf(pollErr)); });
    }, SYNC_POLL_MS);
  }

  function stopSyncPoll() {
    if (!syncPollTimer) return;
    clearInterval(syncPollTimer);
    syncPollTimer = 0;
  }

  async function boot() {
    wireSearch();
    wireActions();
    listenForPushes();
    paintControls();
    await loadSettings();
    // The selection is read BEFORE the first query so the ticks are correct on
    // the rows' first paint rather than flipping a moment later. It is
    // best-effort and never blocks the list: `GET_SELECTION` failing leaves an
    // empty selection, which every action below refuses to widen.
    await loadSelection();
    try {
      await runQuery(false);
    } catch (err) {
      paintFailure(err, 'Could not load the library');
    }
    // AFTER the first query, so the rows are on screen before the extra round
    // trip, and so a banner painted from `GET_CLIPS` can be enriched with the
    // reason rather than flashing the wrong text first.
    await refreshSyncStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();