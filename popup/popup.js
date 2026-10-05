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
 * D. `truncated:true` gets a persistent, dismissible-per-session banner. A
 *    capped crawl leaves an INCOMPLETE library on disk and the user has to be
 *    told, not shown a green checkmark.
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
    truncated: false,
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

  function renderSyncTile() {
    if (state.syncRunning) {
      els.tileSync.textContent = 'Syncing';
      els.tileSyncNote.textContent = state.syncMaxPages
        ? state.syncPagesDone + ' of ' + state.syncMaxPages + ' pages'
        : 'crawling the feed';
      return;
    }
    var sync = state.sync || null;
    if (!sync) {
      els.tileSync.textContent = 'Never';
      els.tileSyncNote.textContent = 'no sync has run';
      return;
    }
    var status = String(sync.state || 'idle');
    if (status === 'error') {
      els.tileSync.textContent = 'Failed';
      els.tileSyncNote.textContent = sync.lastError ? String(sync.lastError).slice(0, 90) : 'see the activity log';
      return;
    }
    if (status === 'cancelled') {
      els.tileSync.textContent = 'Cancelled';
      els.tileSyncNote.textContent = (sync.pagesDone || 0) + ' pages done';
      return;
    }
    els.tileSync.textContent = status === 'idle' ? 'Up to date' : status;
    els.tileSyncNote.textContent = (sync.pagesDone || 0) + ' pages · '
      + (sync.dislikedCount !== null && sync.dislikedCount !== undefined
        ? sync.dislikedCount + ' dislikes known'
        : 'dislikes partial');
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
      if (!state.syncMaxPages) return null;
      return clampInt((state.syncPagesDone / state.syncMaxPages) * 100, 0, 100, 0);
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
      label = 'Syncing library';
      var pageText = state.syncMaxPages
        ? 'page ' + state.syncPagesDone + ' of ' + state.syncMaxPages
        : 'page ' + state.syncPagesDone;
      detail = pageText + ' · ' + state.syncSeen + ' clips seen'
        + (state.syncEtaMs > 0 ? ' · ~' + formatDuration(state.syncEtaMs) + ' left' : '');
      if (percent === null) {
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

  function renderTruncated() {
    if (!state.truncated) {
      els.truncated.hidden = true;
      els.truncatedText.textContent = '';
      return;
    }
    els.truncated.hidden = false;
    els.truncatedText.textContent = 'The page cap was reached during the last sync, so the library on disk is '
      + 'INCOMPLETE — some clips are missing and "Download all" will queue only what is indexed. Raise '
      + '"Max pages per sync" in Settings, then sync again.';
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
    els.btnCancel.disabled = state.busy || !(state.syncRunning || state.downloadRunning);
    els.btnCancel.textContent = state.downloadRunning ? 'Stop batch' : (state.syncRunning ? 'Stop sync' : 'Cancel');
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
        + 'It crawls your Suno feed from page 1 (up to ' + maxPages + ' pages) and can take several '
        + 'minutes. It downloads no audio and spends no quota'
        + (settings.dislikedMode === 'both'
          ? ', but the two-pass dislike diff means it walks the feed twice.'
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
          ? 'two-pass crawl (include + exclude downvotes) — roughly double the time'
          : 'mode: ' + String(settings.dislikedMode));
        state.summaryIsBad = false;
        state.summaryKind = '';
        addLog('Sync started: ' + state.syncMaxPages + ' page cap, dislikedMode=' + String(reply.dislikedMode), 'info');
        renderAll();
        toast('Syncing library…', '');
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
        addLog('Sync cancel requested (was running: ' + String(sync.running) + ').', 'warn');
        toast('Cancelling the sync…', '');
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
    state.syncRunning = true;
    state.activity = 'sync';
    state.syncPagesDone = clampInt(msg.pagesDone, 0, 1000000, state.syncPagesDone);
    if (isFinite(Number(msg.page)) && Number(msg.page) > 0) {
      state.syncPagesDone = Math.max(state.syncPagesDone, clampInt(msg.page, 0, 1000000, 0));
    }
    if (isFinite(Number(msg.seen))) state.syncSeen = clampInt(msg.seen, 0, 10000000, state.syncSeen);
    // The worker computes this ETA itself; surfacing it beats guessing one.
    state.syncEtaMs = Number(msg.etaMs) > 0 ? Number(msg.etaMs) : 0;
    if (!state.syncMaxPages && state.settings) {
      state.syncMaxPages = clampInt(state.settings.syncMaxPages, 0, 100000, 0);
    }
    renderProgress();
    renderSyncTile();
    renderButtons();
  }

  function onSyncDone(msg) {
    state.syncRunning = false;
    state.activity = 'idle';
    if (typeof msg.total === 'number') state.libraryTotal = msg.total;
    state.truncated = msg.truncated === true;
    state.syncPagesDone = state.syncPagesDone || state.syncMaxPages;

    var duration = formatDuration(msg.durationMs);
    var head = 'Sync finished: ' + state.libraryTotal + ' ' + plural(state.libraryTotal, 'clip')
      + (duration ? ' in ' + duration : '');
    state.summaryLines = state.truncated ? [head, 'INCOMPLETE — the page cap was reached'] : [head];
    state.summaryQuotaText = state.truncated
      ? 'Some clips are missing from the index. Raise "Max pages per sync" in Settings and sync again.'
      : (isFinite(Number(msg.projects)) ? msg.projects + ' workspaces joined' : '');
    state.summaryIsBad = state.truncated;
    state.summaryKind = state.truncated ? 'bad' : '';

    addLog(head, state.truncated ? 'warn' : 'ok');
    if (state.truncated) {
      addLog('The page cap was hit, so the library on disk is incomplete.', 'bad');
    }
    renderAll();
    refreshBootSafe();
    toast(state.truncated ? 'Sync finished but the library is INCOMPLETE.' : 'Library synced.', state.truncated ? 'bad' : 'ok');
  }

  function onSyncError(msg) {
    state.syncRunning = false;
    state.activity = 'idle';
    var message = msg && msg.error ? String(msg.error) : 'unknown sync error';
    state.summaryLines = ['Sync failed: ' + message];
    state.summaryQuotaText = '';
    state.summaryIsBad = true;
    state.summaryKind = 'bad';
    addLog('Sync error: ' + message, 'bad');
    renderAll();
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
      state.sync = boot.sync || null;
      state.bootCounts = (boot.library && boot.library.counts) || null;
      if (state.bootCounts && typeof state.bootCounts.clips === 'number' && state.bootCounts.clips >= 0) {
        state.libraryTotal = state.bootCounts.clips;
      }
      if (boot.sync && boot.sync.truncated === true) state.truncated = true;
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