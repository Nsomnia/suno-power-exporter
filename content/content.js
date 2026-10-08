/**
 * Suno Master Utility — page dock (content script).
 *
 * WHY THIS FILE WAS DEAD CODE BEFORE
 * ----------------------------------
 * manifest.json runs content scripts at `document_start`, where `document.body`
 * is still null. The old file called `document.body.appendChild(dock)` at the top
 * level of its init IIFE, threw a TypeError, and took the entire script down with
 * it: no dock, no row checkboxes, no session-token status, on any page. Everything
 * below therefore obeys one rule — NO DOM ACCESS ANYWHERE THAT ASSUMES BODY
 * EXISTS until `mount()` runs (see `boot()` at the very bottom).
 *
 * The second failure was structural: the old build called `ensureRowCheckboxes()`
 * exactly once, but Suno is a client-rendered SPA, so rows rendered after that
 * call never got a checkbox and "Download All" was permanently dead. A debounced
 * MutationObserver on document.body fixes that.
 *
 * The third failure was data: the old build read
 * `row.dataset.clipId || row.dataset.id || row.getAttribute('data-id')`. Suno's DOM
 * carries none of those (competitor extensions inject `data-clip-id` themselves,
 * which is why it "worked" for them and not for us). Row identity now comes from
 * the attested selectors in `ROW_SELECTORS` / `clipIdFor()`.
 *
 * Fourth: the old `escapeHtml` escaped < > & but not ", so a workspace id could
 * break out of a `value="…"` attribute. This file never builds HTML from data at
 * all — every node goes through `h()` / `textContent`. There is no `innerHTML`
 * assignment in the file.
 *
 * Fifth: the old dock badge showed *credits*, a different resource from download
 * quota, so a user at 0 downloads saw a healthy badge. The chip here shows
 * remaining / limit downloads with its reset date.
 *
 * Sixth: the old SW pushed progress with `chrome.runtime.sendMessage`, which
 * cannot reach a content script, so the UI received nothing. Everything below is
 * written against the SW contract in which pushes arrive on
 * `chrome.runtime.onMessage` (the SW uses `chrome.tabs.sendMessage`).
 *
 * All UI lives in ONE shadow root. Nothing is written to the page `:root` or to
 * `document.head` for styling, so Suno's cascade is untouched. The only nodes
 * placed in the page's light DOM are the per-row controls, and those are styled
 * with inline styles precisely so no page-level stylesheet is required.
 */

(function () {
  'use strict';

  /* ================================================================== *
   * 0. constants
   * ================================================================== */

  /**
   * Diagnostics for THIS file, gated on the worker's own `settings.debug` — the
   * same switch `background/background.js` gates its ring buffer on
   * (`flushDiagnostics`), so one setting turns diagnostics on for both halves of
   * the extension and a user reporting a fault only has to find one place.
   *
   * WHY IT IS NOT A CONSTANT: it was `const DEBUG = false`, which made every
   * `dbg()` in this file a no-op at every runtime — including the push handler's
   * `catch` and every `fail()`. A diagnostic that cannot fire is not a
   * diagnostic; it is the "nothing is swallowed silently" rule in
   * `fail()` written down and then hard-wired off.
   *
   * The DEFAULT stays off, deliberately: a content script shares the page's
   * console, so a dock that logged by default would spray Suno's own debugging
   * with another extension's internals. The cost of not hard-coding it is that
   * diagnostics stay silent until the `GET_SETTINGS` read in `loadSettings()`
   * lands — mount-time faults before that point have no diagnostic sink, which is
   * stated there rather than hidden.
   */
  let debugOn = false;

  /**
   * Transport-failure codes, as opposed to the worker's own application codes
   * (`ERROR`, `hls_disabled`, …), which pass through `normalizeReply` untouched
   * and keep rendering as before.
   *
   * `DEAD_CODE` — the extension context of THIS already-mounted content script
   * has been invalidated by a reload or an update. Terminal: nothing this file
   * can do will make the next send work, and the only fix is a real page reload.
   *
   * `NO_RECEIVER` — nothing answered: the worker is asleep, still installing, or
   * has no listener for this route in this version. Transient by nature, so it is
   * reported like any other transport failure and the next send may well succeed.
   *
   * Collapsing these into the single `RUNTIME` code that was here before is what
   * let a dead context reach the user as an ordinary failure string attributed to
   * whatever control they pressed.
   */
  const DEAD_CODE = 'CONTEXT_DEAD';
  const NO_RECEIVER = 'NO_RECEIVER';

  const HOST_ID = 'suno-master-host';
  const MARK_ATTR = 'data-sm';            // marks OUR nodes only
  const STORAGE_KEY = 'sm_ui_state';
  const OBSERVE_DEBOUNCE_MS = 250;
  const SEARCH_DEBOUNCE_MS = 220;
  const PERSIST_DEBOUNCE_MS = 400;
  const RESULT_PAGE_SIZE = 50;
  const MAX_BATCH_ROWS = 400;

  // The absolute CSS integer maximum. The old file used 2147483650, which clamps.
  // Only the host's z-index is set here; the panel/drawer layers live in
  // content.css. Both files cap at 2147483647 (the CSS integer maximum).
  const Z_DOCK = 2147483647;

  // Attested in captured traffic and in competitor extensions working today.
  const ROW_SELECTORS = [
    '[data-testid="clip-row"]',
    'div.clip-row[role="group"]',
    'div.clip-row'
  ];
  const ROW_SELECTOR = ROW_SELECTORS.join(',');
  const TITLE_SELECTORS = ['.clip-title-wrapper a', '[data-testid="clip-title"]', '.clip-title'];
  const PLAY_COUNT_BTN = 'button[aria-label="Play Count"]';
  const SONG_HREF_RE = /\/song\/([a-f0-9-]{36})/i;
  const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const TOKEN_RE = /^[a-zA-Z0-9._~+/=-]{40,}$/;

  // The ONLY variants this build can actually deliver. The worker's VARIANTS is
  // exactly `['m4a', 'wav-48k', 'wav']`; M4A is native, WAV is a local render.
  // Anything else (`mp3`, `mp3-256`, `mp3-320`, `flac`, `ogg`, `aac`, `opus`) would
  // need an encoder binary that is NOT vendored under `vendor/` (the directory does
  // not exist) and MV3's CSP forbids loading one from a CDN, so the worker aliases
  // every one of them back to `m4a` with no error. Offering a variant the worker
  // cannot produce is precisely the "control that looks live and is not" defect:
  // the old list below offered six values and four of them silently reverted.
  //
  // LRC, cover art and JSON are NOT variants. They are SIDECARS written next to the
  // audio file and they are controlled by `tagOptions.lrc` / `.artwork` / `.json`
  // in the settings drawer below.
  //
  // A standalone cover-art FILE download would be a different feature entirely:
  // it needs the `image_url` / `image_large_url` CDN fetches, which this build does
  // NOT implement, so no control for it is offered here rather than offering one
  // that cannot work. Embedded artwork is `tagOptions.artwork` + `tagOptions.embed`.
  const VARIANTS = [
    ['m4a', 'M4A (AAC) — native, no conversion'],
    ['wav-48k', 'WAV 48 kHz — requested from Suno'],
    ['wav', 'WAV — local render from the stream']
  ];

  /** Just the values, for validation against what the worker will accept. */
  const VARIANT_KEYS = VARIANTS.map(function (v) { return v[0]; });

  // Download source ladder. These are the worker's LADDER_ALIASES keys, not its
  // canonical rung ids: `media`/`audio` expand to progressive + mango-drm and `wav`
  // expands to wav-official (background.js LADDER_ALIASES). The ladder list itself
  // is rendered from the worker's own `ladder` payload (LADDER_RUNGS) when it
  // arrives, so a stored canonical rung is shown by its real name instead of being
  // labelled with a synonym. `audio_url` last on purpose: Suno puts a decoy
  // "/api/forbidden" URL in clip.audio_url (SunoFilter.audioUrlIsDecoy).
  const SOURCES = [
    ['media', 'media_urls (CDN)'],
    ['wav', '48 kHz WAV endpoint'],
    ['audio', 'audio_url (may be a decoy)'],
    ['hls', 'HLS stream capture']
  ];

  const PRESET_CHIPS = [
    ['ALL', 'All'], ['LIKED_ONLY', 'Liked'], ['NO_DISLIKES', 'No dislikes'],
    ['DISLIKED_ONLY', 'Disliked'], ['MOST_PLAYED', 'Most played'],
    ['MOST_LIKED', 'Most upvoted'], ['INSTRUMENTAL', 'Instrumental'],
    ['REMIXES', 'Remixes'], ['V6', 'v6'], ['V5_PLUS', 'v5+'], ['V6_MINI', 'v6 mini'],
    ['CUSTOM_MODELS', 'Custom'], ['NO_TRASHED', 'No trashed'], ['TRASHED', 'Trashed'],
    ['UNASSIGNED', 'Unassigned'], ['PENDING', 'Generating'], ['COMPLETE', 'Complete'],
    ['PUBLIC_ONLY', 'Public'], ['NO_UPLOADS', 'No uploads'], ['UNLIKED', 'Unliked'],
    ['WITH_HOOKS', 'Has hook'], ['RECENT_30_DAYS', 'Last 30 days']
  ];

  const DEFAULT_SETTINGS = {
    variant: 'm4a',
    sourceLadder: ['media', 'wav', 'audio'],
    filenameTemplate: '{title}_{artist}_{format}',
    // EXACTLY the seven keys the worker reads (`coerceSettings`: embed, lyrics,
    // artwork, bpm, comment, json, lrc), with the worker's own defaults. A local
    // key the worker does not know (`cover`) is a toggle that does nothing, and a
    // worker key missing here (artwork, lrc) is reset to the worker default on every
    // save from this drawer — which is what the old `cover` list did.
    tagOptions: { embed: true, lyrics: true, artwork: true, bpm: false, comment: true, json: false, lrc: true },
    dryRun: false,
    overwrite: false
  };

  const DEFAULT_FILTERS = {
    liked: 'any',
    disliked: 'exclude',
    projects: [],
    includeUnassigned: true,
    models: [],
    query: '',
    dateFrom: '',
    dateTo: '',
    durationMin: '',
    durationMax: '',
    playsMin: '',
    playsMax: '',
    upvotesMin: '',
    instrumental: 'any',
    remixes: 'any',
    trashed: 'any',
    visibility: 'any',
    contests: 'any',
    hooks: 'any',
    unliked: 'any',
    uploads: 'any',
    stems: 'any',
    generated: 'any',
    idList: '',
    sort: 'newest',
    order: 'desc'
  };

  /* ================================================================== *
   * 1. tiny DOM helpers — textContent only, never innerHTML
   * ================================================================== */

  function h(tag, props, kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = String(v);
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'style') el.setAttribute('style', String(v));
        else if (k === 'value') el.value = String(v);
        else if (k === 'dataset') { for (const d in v) el.dataset[d] = String(v[d]); }
        else if (k === 'checked' || k === 'disabled' || k === 'indeterminate' ||
                 k === 'multiple' || k === 'selected') el[k] = !!v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }

  function append(parent, kids) {
    if (kids === null || kids === undefined || kids === false) return parent;
    if (Array.isArray(kids)) {
      for (let i = 0; i < kids.length; i++) append(parent, kids[i]);
      return parent;
    }
    if (kids instanceof Node) parent.appendChild(kids);
    else parent.appendChild(document.createTextNode(String(kids)));
    return parent;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function dbg() {
    if (!debugOn) return;
    try { console.log.apply(console, ['[SunoMaster/dock]'].concat([].slice.call(arguments))); }
    catch (e) {
      // A console that refuses the write (a page that has replaced it, an embedder
      // that locks it down) must not turn a diagnostic into a fault of its own.
      // Logging is already impossible here, so the throw cannot be reported
      // anywhere else either.
      void e;
    }
  }

  // Every catch in this file funnels here, so nothing is swallowed silently (j).
  function fail(scope, err, opts) {
    const o = opts || {};
    const msg = (err && (err.message || err.error)) || String(err || 'unknown error');
    dbg('failed:', scope, msg, err);
    // A dead extension context is NOT this scope's failure. `send()` has already
    // replaced the dock with the "reload the page" notice, and the text Chrome
    // supplies for it ("Extension context invalidated") names the transport, not
    // the feature the user pressed — which is how a session-token read ended up
    // reporting itself against a filter control. Nothing is lost: the raw string
    // goes to the diagnostic line above, and the notice above it says the same
    // thing in words the user can act on.
    if (err && err.code === DEAD_CODE) return msg;
    if (o.silent) return msg;
    if (state.mounted && ui.errorStrip) {
      showError(scope + ': ' + msg);
      return msg;
    }
    if (state.mounted) toast(scope + ': ' + msg, 5200);
    return msg;
  }

  /* ================================================================== *
   * 2. state
   * ================================================================== */

  const state = {
    mounted: false,
    panelOpen: false,
    batchOpen: false,
    settingsOpen: false,
    filters: clone(DEFAULT_FILTERS),
    settings: cloneSettings(DEFAULT_SETTINGS),
    // The worker's LADDER_RUNGS (from GET_BOOT/GET_SETTINGS `ladder`), so the ladder
    // editor shows real rung labels and metered/opt-in flags instead of synonyms.
    ladder: null,
    selection: new Set(),
    rowIndex: new Map(),          // clipId -> 'only' | 'exclude'  (row tri-state)
    facets: null,
    projects: [],
    sync: {
      // No `page`: the crawl is cursor-based (`/api/feed/v3`) and has no page
      // number, so the field would only ever hold a stale or invented value.
      // Progress reads `pagesDone` against `maxPages`, plus `totalSeen`.
      running: false, pagesDone: 0, seen: 0, added: 0, etaMs: 0,
      /**
       * Whether THIS dock has read an authoritative `SYNC_STATUS` reply. The two
       * Sync controls stay disabled until it has, which closes the window the user
       * reported: a crawl started from the popup or the side panel is in flight,
       * this dock has not been told yet, and its "Start sync" button was live.
       */
      statusKnown: false,
      /**
       * The worker has been told to stop and has not confirmed the crawl ended.
       * Distinct from `state === 'cancelling'`, which means "unwinding and this
       * dock is watching"; at this point nothing is watching, so the dock stops
       * claiming a live crawl and says the stop was unconfirmed rather than leaving
       * an animated "cancelling" line with no exit.
       */
      stopUnconfirmed: false,
      /**
       * The last terminal state was a stop the user asked for, so the shared
       * wording reads "Sync stopped".
       */
      stopped: false,
      /**
       * A cancel has been signalled and the crawl is still unwinding. Mirrors the
       * worker's `cancelRequested`, read only from an authoritative reply.
       */
      cancelling: false,
      /**
       * The stored cursor claimed `running` but no controller owns it — an MV3
       * worker eviction. Distinct from `running`, because the two need different
       * copy and different affordances: a running crawl can be stopped, an
       * orphaned one can only be cleared and resumed.
       */
      orphaned: false,
      /**
       * Which phase the worker's crawl is in, plus that phase's own counters.
       * Read from `SYNC_PROGRESS` AND from `SYNC_STATUS`/`GET_BOOT` so this dock,
       * the popup and the side panel all render the same phase from the same
       * source instead of each keeping its own idea of what the crawl is doing.
       */
      phase: '', phasePages: 0, phaseJoined: 0,
      state: 'idle', truncated: false, total: 0, lastDurationMs: 0, lastProjects: 0,
      maxPages: 0, lastError: '', truncateDismissed: false,
      // The completeness contract (SYNC_DONE / SYNC_STATUS.cursor /
      // GET_BOOT.sync all carry it). EVERY one is optional: a worker that
      // predates the contract leaves them null and the dock renders exactly as
      // it did before. `completed` is the field that replaces reading
      // `state === 'done'` as proof of success.
      completed: null,
      stopReason: '',
      /** The exact text this dock wrote to the error strip, so only that can be retracted. */
      lastErrorText: '',
      expectedTotal: null,
      totalSeen: null,
      missing: null,
      /**
       * `false` means crawl filters ran, so the counts above are a LOWER BOUND
       * rather than a shortfall. `null` is "the worker did not say".
       */
      oracleApplied: null,
      workspaces: []
    },
    batch: {
      running: false, batchId: null, done: 0, total: 0, ok: 0, failed: 0, skipped: 0,
      bytes: 0, etaMs: 0, currentTitle: '', items: new Map(), order: [], failedItems: [],
      remaining: 0, stoppedReason: '', lastPayload: null
    },
    results: { items: [], total: 0, offset: 0, limit: RESULT_PAGE_SIZE, hasMore: false },
    // The credential never lives in this file. The worker reads it by observing
    // the `Authorization: Bearer …` header on Suno's own requests from the page's
    // MAIN world, and reports only presence/expiry in `tokenStatus()`; there is no
    // local copy to keep in sync, so there is no `state.token` field to go stale.
    tokenExpiresAt: 0,
    tokenHas: false,
    tokenBad: false,
    /**
     * Whether a `GET_TOKEN_STATUS` / `GET_BOOT.token` read has answered, and whether
     * one has FAILED.
     *
     * `tokenHas:false` is the initial value, so without this the dock printed "worker:
     * no token" from mount until the first reply landed — and for ever after if that
     * reply never came. That is the same defect the popup had, where a worker that did
     * not answer was rendered as "Not signed in": a credential fact asserted from an
     * unanswered question. "Not read yet" and "read, no answer" are different facts and
     * they now read differently.
     */
    tokenStatusKnown: false,
    tokenReadFailed: false,
    hls: { active: false }
  };

  const ui = {};

  function clone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return {}; }
  }

  /**
   * Normalise a settings object for the page UI.
   *
   * WHY IT MERGES INSTEAD OF REBUILDING: the previous version iterated its OWN
   * `DEFAULT_SETTINGS.tagOptions` key list and emitted exactly those keys. The
   * worker replaces `tagOptions` wholesale on every save
   * (`updateSettings` shallow-merges, then `coerceSettings` re-reads all seven
   * keys with `boolOr`), so a key missing from this list is silently reset to the
   * worker's default, and a key present here that the worker does not read is a
   * toggle that does nothing. Both happened: `cover` was dead and `artwork`/`lrc`
   * were reverted on every save. Merging the incoming object OVER the defaults
   * keeps every worker key the UI is handed, and keeps any future key the worker
   * adds, so this function can never drop one again.
   *
   * @param {object} s the worker's settings object (or my defaults)
   * @returns {object}
   */
  function cloneSettings(s) {
    const src = (s && typeof s === 'object') ? s : {};
    const out = Object.assign({}, DEFAULT_SETTINGS, src);

    // `variant`: only ever one of the three the worker can deliver.
    out.variant = VARIANT_KEYS.indexOf(String(src.variant || '')) >= 0
      ? String(src.variant)
      : DEFAULT_SETTINGS.variant;

    // `sourceLadder`: an array of NON-EMPTY STRINGS, nothing more. It must NOT be
    // filtered against a local rung list: the worker stores CANONICAL ids
    // (`progressive`, `mango-drm`, `wav-official`, `studio`, `download-route`,
    // `zip`, `hls`) while this UI's own vocabulary is aliases (`media`, `wav`,
    // `audio`) which the worker expands through LADDER_ALIASES. Filtering against
    // the local list would strip the entire stored ladder and then save that back.
    // Unknown ids are the worker's business — `normalizeLadder` logs and ignores
    // them — and `renderLadder` shows an unknown id by its raw name.
    const ladder = Array.isArray(src.sourceLadder)
      ? src.sourceLadder.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    out.sourceLadder = ladder.length ? ladder : DEFAULT_SETTINGS.sourceLadder.slice();

    out.filenameTemplate = typeof src.filenameTemplate === 'string' && src.filenameTemplate
      ? src.filenameTemplate
      : DEFAULT_SETTINGS.filenameTemplate;
    out.dryRun = src.dryRun === true;
    out.overwrite = src.overwrite === true;

    // tagOptions: defaults for every key the worker reads, then the incoming values
    // for BOTH known and unknown keys. Never rebuilt from a local list.
    const tagIn = (src.tagOptions && typeof src.tagOptions === 'object') ? src.tagOptions : {};
    out.tagOptions = Object.assign({}, DEFAULT_SETTINGS.tagOptions, tagIn);
    return out;
  }

  /* ================================================================== *
   * 3. messaging (contract in §2 of the brief)
   * ================================================================== */

  const F = function () { return (window.SunoFilter && window.SunoFilter) || null; };

  function normalizeReply(res, type) {
    if (res === null || res === undefined) {
      return { ok: false, error: 'No response from the service worker (' + type + ')', code: 'NO_RESPONSE' };
    }
    if (typeof res !== 'object') return { ok: true, value: res };
    if (res.ok === false) {
      return { ok: false, error: res.error || 'Request failed', code: res.code || 'ERROR' };
    }
    // Tolerate the pre-contract `success` shape so a half-migrated SW still works.
    if (res.ok === undefined && res.success === false) {
      return { ok: false, error: res.error || 'Request failed', code: res.code || 'ERROR' };
    }
    if (res.ok === undefined) res.ok = true;
    return res;
  }

/**
   * Classify a transport failure from Chrome's own text.
   *
   * WHY THE TEXT IS THE AUTHORITY: when an extension is reloaded or updated,
   * Chrome tears down the isolated world of every content script that is ALREADY
   * mounted, so `sendMessage` fails with "Extension context invalidated" for the
   * rest of that page's life — while the dock's DOM, its timers and the page
   * itself keep working perfectly. Every later call fails identically, so this is
   * a terminal state for the script, not a retryable one, and it has to be told
   * apart from a worker that simply is not listening yet.
   *
   * The strings are matched rather than sniffed for because Chrome is the only
   * thing producing them, and the alternative — deciding from the shape of the
   * reply — cannot work: both failures arrive as `{ok:false, error, code}`.
   *
   * @param {string} text `chrome.runtime.lastError.message`, or a thrown message
   * @returns {string} `DEAD_CODE`, `NO_RECEIVER`, or `'RUNTIME'` for the rest
   */
  function transportCode(text) {
    const t = String(text || '');
    if (/context invalidated|Extension context/i.test(t)) return DEAD_CODE;
    if (/receiving end does not exist|could not establish connection/i.test(t)) return NO_RECEIVER;
    return 'RUNTIME';
  }

  /**
   * This content script can no longer reach the extension.
   *
   * Deliberately idempotent and deliberately cheap: `send()` calls it for every
   * failing message, and after the dock has been replaced every further button
   * press would otherwise re-enter it.
   *
   * @param {string} type the route that failed, for the diagnostic line
   * @param {string} text Chrome's own message, kept verbatim in the log
   * @returns {Promise<void>}
   */
  async function handleDeadContext(type, text) {
    if (contextDead) return;
    contextDead = true;
    dbg('extension context is gone; the dock is going down. last send:', type, '—', text);
    await showReloadNotice();
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      // A dead context is terminal for THIS script, so it is escalated from the one
      // place every reply passes through — before the caller gets a chance to paint
      // Chrome's transport string against whatever control the user happened to
      // press. `showReloadNotice` tears the dock down synchronously, so by the time
      // a consumer resumes on the microtask queue there is nothing left to paint.
      const failTransport = (text) => {
        const code = transportCode(text);
        finish({ ok: false, error: text, code: code });
        if (code === DEAD_CODE) void handleDeadContext(type, text);
      };
      try {
        chrome.runtime.sendMessage({ type: type, payload: payload || {} }, (res) => {
          const last = chrome.runtime.lastError;
          if (last) {
            failTransport(last.message || 'runtime error');
            return;
          }
          finish(normalizeReply(res, type));
        });
      } catch (e) {
        failTransport((e && e.message) || 'sendMessage threw');
      }
    });
  }

  // Anything the SW refuses must become VISIBLE: every caller that can return
  // early on !res.ok routes through here so no failure is swallowed silently.
  // `code` travels with the message because `fail()` needs to recognise the dead
  // context case; an application error from the worker is NOT downgraded by it.
  function bail(res, scope) {
    if (!res || !res.ok) {
      fail(scope, {
        message: (res && res.error) || 'no response',
        error: (res && res.error) || 'no response',
        code: (res && res.code) || ''
      });
      return true;
    }
    return false;
  }

  /* ================================================================== *
   * 4. spec construction — the complete filter -> spec mapping
   * ================================================================== */

  function num(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // "YYYY-MM-DD" -> local midnight ms; endOf -> end of that local day.
  function dayMs(v, endOf) {
    const s = String(v || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const parts = s.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2], endOf ? 23 : 0, endOf ? 59 : 0, endOf ? 59 : 0, 0);
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }

  function parseIdList(raw) {
    const out = [];
    const seen = {};
    const tokens = String(raw || '').split(/[\s,;]+/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].trim();
      if (!t) continue;
      if (!UUID_RE.test(t)) continue;
      const k = t.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      out.push(t);
    }
    return out;
  }

  // 'any' | 'only' | 'exclude' -> include.<key> true | false | (absent)
  function triFlag(v) {
    if (v === 'only') return true;
    if (v === 'exclude') return false;
    return null;
  }

  function buildSpec() {
    const f = state.filters;
    const spec = {};

    /* reactions ---------------------------------------------------------- */
    if (f.liked !== 'any') spec.liked = f.liked;
    if (f.disliked !== 'any') spec.disliked = f.disliked;

    /* projects ----------------------------------------------------------- */
    if (f.projects && f.projects.length) {
      spec.projects = f.projects.slice();
      spec.includeUnassigned = !!f.includeUnassigned;
    }

    /* model family ------------------------------------------------------- */
    if (f.models && f.models.length) spec.models = f.models.slice();

    /* search (parseQuery owns field: / -negation / OR) -------------------- */
    const q = String(f.query || '').trim();
    if (q) {
      const fEngine = F();
      if (fEngine && typeof fEngine.parseQuery === 'function') {
        const parsed = fEngine.parseQuery(q);
        spec.terms = parsed.terms;
        if (parsed.any) spec.any = true;
        if (parsed.groups) spec.groups = parsed.groups;
        spec.text = parsed.text;
      } else {
        spec.text = q;
      }
    }

    /* stems: no clip field exists, so this is a real search term ---------- */
    const stemsTerms = [];
    if (f.stems === 'only') stemsTerms.push({ field: 'any', value: 'stems', negate: false });
    else if (f.stems === 'exclude') stemsTerms.push({ field: 'any', value: 'stems', negate: true });

    /* explicit ids ------------------------------------------------------- */
    const ids = parseIdList(f.idList);
    if (ids.length) spec.ids = { include: ids };

    /* include.* booleans -------------------------------------------------- */
    const include = {};
    const instrumental = triFlag(f.instrumental);
    if (instrumental !== null) include.instrumental = instrumental;
    const remixes = triFlag(f.remixes);
    if (remixes !== null) include.remixes = remixes;
    const trashed = triFlag(f.trashed);
    if (trashed !== null) include.trashed = trashed;
    const contests = triFlag(f.contests);
    if (contests !== null) include.contests = contests;
    const hooks = triFlag(f.hooks);
    if (hooks !== null) include.hooks = hooks;
    const unliked = triFlag(f.unliked);
    if (unliked !== null) include.unliked = unliked;
    const uploads = triFlag(f.uploads);
    if (uploads !== null) include.uploads = uploads;
    const generated = triFlag(f.generated);
    if (generated !== null) include.generated = generated;

    /* dates / ranges ------------------------------------------------------ */
    const after = dayMs(f.dateFrom, false);
    const before = dayMs(f.dateTo, true);
    if (after !== null) spec.createdAfter = after;
    if (before !== null) spec.createdBefore = before;
    const dMin = num(f.durationMin);
    const dMax = num(f.durationMax);
    if (dMin !== null) spec.durationMin = dMin;
    if (dMax !== null) spec.durationMax = dMax;
    const pMin = num(f.playsMin);
    const pMax = num(f.playsMax);
    if (pMin !== null) spec.playsMin = pMin;
    if (pMax !== null) spec.playsMax = pMax;
    const uMin = num(f.upvotesMin);
    if (uMin !== null) spec.upvotesMin = uMin;

    /* visibility ---------------------------------------------------------- */
    if (f.visibility === 'only') spec.visibility = 'public';
    else if (f.visibility === 'exclude') spec.visibility = 'private';

    /* sort ---------------------------------------------------------------- */
    spec.sort = f.sort;
    spec.order = f.order;

    /* merge stems term into the query terms ------------------------------- */
    if (stemsTerms.length) {
      const base = Array.isArray(spec.terms) ? spec.terms.slice() : [];
      if (!base.length && spec.text) base.push({ field: 'any', value: spec.text, negate: false });
      spec.terms = base.concat(stemsTerms);
      if (base.length > 1) spec.any = false;
    }

    if (Object.keys(include).length) spec.include = include;
    return spec;
  }

  function specForRequest() {
    const spec = buildSpec();
    const fEngine = F();
    // Hand the engine a normalized spec so legacy keys can never leak out and
    // createdAfter/createdBefore are guaranteed to be ms.
    return fEngine && typeof fEngine.normalizeSpec === 'function'
      ? fEngine.normalizeSpec(spec)
      : spec;
  }

  function describeSpec() {
    const fEngine = F();
    if (!fEngine || typeof fEngine.describe !== 'function') return 'All clips';
    try { return fEngine.describe(buildSpec()); } catch (e) {
      dbg('describe failed:', e && e.message);
      return 'All clips';
    }
  }

  /* ================================================================== *
   * 5. persistence (UI state only — settings live in the SW)
   * ================================================================== */

  let persistTimer = 0;

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  function persistNow() {
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          filters: state.filters,
          // The page cap is kept too, so the value the user (or the incompleteness
          // banner's "bigger cap" action, which only appears when the cap is what
          // stopped the walk) chose is still there on the next visit instead of
          // silently reverting to the worker's default.
          syncMaxPages: state.syncMaxPages || ''
        }
      }, () => {
        const last = chrome.runtime.lastError;
        if (last) dbg('persist failed:', last.message);
      });
    } catch (e) {
      dbg('persist threw:', e && e.message);
    }
  }

  function loadPersisted() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (data) => {
          const last = chrome.runtime.lastError;
          if (last) { dbg('load failed:', last.message); resolve(null); return; }
          resolve((data && data[STORAGE_KEY]) || null);
        });
      } catch (e) {
        dbg('load threw:', e && e.message);
        resolve(null);
      }
    });
  }

  /* ================================================================== *
   * 6. toast + error strip
   * ================================================================== */

  let toastTimer = 0;

  function toast(msg, ms) {
    if (!state.mounted || !ui.toast) return;
    ui.toast.textContent = String(msg);
    ui.toast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = 0;
      if (ui.toast) ui.toast.classList.remove('on');
    }, ms || 2600);
  }

  function showError(msg) {
    if (!ui.errorStrip) return;
    ui.errorStrip.textContent = String(msg);
    ui.errorStrip.classList.add('on');
  }

  function clearError() {
    if (!ui.errorStrip) return;
    ui.errorStrip.textContent = '';
    ui.errorStrip.classList.remove('on');
  }

  /* ================================================================== *
   * 7. shadow host + stylesheet
   * ================================================================== */

  // Used only when content/content.css cannot be fetched (it needs
  // web_accessible_resources in manifest.json, which this file does not own).
  // Kept minimal on purpose: it is a degraded mode, not the design.
  const FALLBACK_CSS = [
    ':host{all:initial;display:block;position:fixed;inset:0;z-index:2147483647;',
    'pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'font-size:13px;line-height:1.4;color:#eef2ff;-webkit-font-smoothing:antialiased}',
    '.sm-dock{pointer-events:auto;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);',
    'display:flex;gap:6px;align-items:center;padding:8px 12px;border-radius:999px;',
    'background:rgba(15,18,28,.94);border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 40px rgba(0,0,0,.5)}',
    '.sm-btn{appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);',
    'color:#eef2ff;padding:6px 11px;border-radius:999px;font-size:12.5px;font-weight:600;cursor:pointer}',
    '.sm-panel{pointer-events:auto;position:fixed;left:50%;bottom:74px;transform:translateX(-50%);',
    'width:min(940px,94vw);max-height:74vh;overflow:auto;border-radius:14px;padding:14px;',
    'background:rgba(12,15,24,.97);border:1px solid rgba(255,255,255,.14)}'
  ].join('');

  async function loadCssText() {
    try {
      const url = chrome.runtime.getURL('content/content.css');
      const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) return null;
      const text = await res.text();
      return text && text.length > 32 ? text : null;
    } catch (e) {
      dbg('stylesheet fetch failed (needs web_accessible_resources):', e && e.message);
      return null;
    }
  }

  function applyStyles(shadow, cssText) {
    const css = cssText || FALLBACK_CSS;
    // Constructed stylesheet where available, <style> inside the shadow root
    // otherwise. Either way it is scoped to the shadow tree.
    try {
      if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype &&
          'adoptedStyleSheets' in shadow) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
        return 'constructed';
      }
    } catch (e) {
      dbg('constructed stylesheet rejected, using <style>:', e && e.message);
    }
    try {
      shadow.appendChild(h('style', { text: css }));
      return 'style-element';
    } catch (e2) {
      dbg('shadow <style> failed:', e2 && e2.message);
      return 'none';
    }
  }

  /* ================================================================== *
   * 8. small UI atoms
   * ================================================================== */

  // A one-line "?" tooltip citing the underlying field / route.
  function qmark(help) {
    return h('span', { class: 'sm-q', title: help, 'aria-label': help, text: '?' });
  }

  function field(labelText, help, control, extra) {
    return h('div', { class: 'sm-field' }, [
      h('label', { class: 'sm-label' }, [document.createTextNode(labelText), qmark(help)]),
      control,
      extra || null
    ]);
  }

  function selectEl(options, value, onChange, props) {
    const sel = h('select', Object.assign({ class: 'sm-select', onchange: onChange }, props || {}));
    for (let i = 0; i < options.length; i++) {
      const pair = options[i];
      const val = pair[0];
      const lbl = pair[1];
      const count = pair[2];
      sel.appendChild(h('option', {
        value: val,
        text: count === undefined ? lbl : lbl + ' (' + count + ')'
      }));
    }
    sel.value = value;
    return sel;
  }

  function triSelect(value, onChange, opts) {
    const o = opts || {};
    const options = o.onlyLabel || o.excludeLabel
      ? [['any', 'any'], ['only', o.onlyLabel || 'only'], ['exclude', o.excludeLabel || 'exclude']]
      : [['any', 'any'], ['only', 'only'], ['exclude', 'exclude']];
    return selectEl(options, value, onChange);
  }

  function btn(text, onClick, cls) {
    return h('button', {
      type: 'button',
      class: 'sm-btn' + (cls ? ' ' + cls : ''),
      onclick: onClick,
      text: text
    });
  }

  function section(titleText, kids, openByDefault) {
    const body = h('div', { class: 'sm-sec-body' }, kids);
    const head = h('button', {
      type: 'button',
      class: 'sm-sec-head',
      'aria-expanded': openByDefault ? 'true' : 'false',
      onclick: () => {
        const on = wrap.classList.toggle('open');
        head.setAttribute('aria-expanded', on ? 'true' : 'false');
      }
    }, [
      h('span', { class: 'sm-sec-title', text: titleText }),
      h('span', { class: 'sm-sec-caret', text: '▾' })
    ]);
    const wrap = h('section', { class: 'sm-sec' + (openByDefault ? ' open' : '') }, [head, body]);
    return wrap;
  }

  /* ================================================================== *
   * 9. the dock
   * ================================================================== */

  function buildDock() {
    ui.quotaChip = h('button', {
      type: 'button',
      class: 'sm-quota',
      title: 'Download quota (remaining / limit). Click to refresh from /api/billing/info/.',
      onclick: () => refreshQuota(true)
    }, [h('span', { text: '⛁ quota' }), h('b', { text: '—' })]);

    ui.syncChip = h('span', { class: 'sm-sync-chip', title: 'Library sync' }, [
      h('span', { class: 'sm-sync-dot' }),
      h('span', { class: 'sm-sync-text', text: 'not synced' })
    ]);

    ui.countLabel = h('span', { class: 'sm-count', text: 'no clips loaded' });

    ui.syncBtn = btn('Sync', () => startSync(), 'primary');
    ui.filterBtn = btn('Filters', () => togglePanel());
    ui.batchBtn = btn('Batch', () => toggleDrawer('batch'));
    ui.settingsBtn = btn('Settings', () => toggleDrawer('settings'));
    ui.selectAllBtn = btn('All', () => bulkSelect('all'));
    ui.selectNoneBtn = btn('None', () => bulkSelect('none'));
    ui.selectInvBtn = btn('Invert', () => bulkSelect('invert'));
    ui.dlBtn = btn('Download', () => startDownload(), 'primary');

    const dock = h('div', { class: 'sm-dock', id: 'sm-dock' }, [
      h('span', { class: 'sm-brand' }, [
        h('span', { class: 'sm-dot' }),
        h('span', { text: 'Suno Master' })
      ]),
      ui.syncChip,
      ui.countLabel,
      h('span', { class: 'sm-sep' }),
      h('span', { class: 'sm-group' }, [ui.selectAllBtn, ui.selectNoneBtn, ui.selectInvBtn]),
      ui.filterBtn,
      ui.batchBtn,
      ui.syncBtn,
      ui.settingsBtn,
      ui.quotaChip,
      ui.dlBtn,
      btn('Hide', () => destroy(), 'ghost')
    ]);
    return dock;
  }

  /* ---------------------------- filter panel ----------------------- */

  function buildPanel() {
    /* --- sync ---------------------------------------------------------- */
    ui.syncForce = h('input', { type: 'checkbox', class: 'sm-check' });
    ui.syncDisliked = selectEl(
      [['exclude', 'exclude disliked (one pass)'], ['only', 'only disliked (one pass)'], ['any', 'both passes (index everything)']],
      state.filters.disliked,
      (e) => { state.filters.disliked = e.target.value; schedulePersist(); onFiltersChanged(); }
    );
    ui.syncMaxPages = h('input', {
      type: 'number', class: 'sm-input sm-num', min: '0', step: '1', placeholder: 'SW default',
      oninput: (e) => { state.syncMaxPages = e.target.value; schedulePersist(); }
    });
    ui.syncState = h('div', { class: 'sm-sync-state', text: 'idle' });
    ui.syncBar = h('div', { class: 'sm-bar' }, [h('div', { class: 'sm-bar-fill' })]);
    /* THE DOCK'S LIVE REGION FOR CRAWL STATE.
     *
     * `#sm-sync-state` is deliberately NOT one: `SYNC_PROGRESS` lands several times
     * a second and a live region would read every push aloud. But that leaves a
     * change of crawl state with no accessible output at all, which is how "Sync
     * active" in one surface and an enabled Start sync in another could both be
     * invisible to a screen-reader user. `announceSyncView()` writes here, once per
     * transition.
     *
     * The clip technique is `side_panel.html`'s `.sp-live`, inline because
     * content/content.css — which this file does not own — has no equivalent
     * utility, and adding one would mean editing a stylesheet outside this change. */
    ui.syncAnnounce = h('div', {
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      style: 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;'
        + 'clip-path:inset(50%);white-space:nowrap;border:0'
    });
    // The headline names the OUTCOME, not a guess about the cause. The previous
    // build hard-coded "page cap hit", which was false for the failure that
    // mattered — a request that failed on page 21 — and sent the user to the cap
    // setting for a cap they had never reached.
    ui.truncTitle = h('b', { text: 'Library INCOMPLETE — the last sync stopped early. ' });
    ui.truncWarn = h('div', {
      class: 'sm-warn',
      role: 'alert',
      'aria-live': 'polite'
    }, [
      ui.truncTitle,
      h('span', { class: 'sm-trunc-detail', text: '' }),
      // Children go in the THIRD argument. The previous version passed a
      // `children` prop, which `h()` has no case for: it fell through to
      // `setAttribute('children', …)`, so these buttons were never in the DOM at
      // all and the banner had no way out of it.
      h('div', { class: 'sm-warn-actions' }, [
        // Two buttons, and WHICH ONE IS OFFERED depends on the stop reason.
        // "Re-sync with a bigger cap" is only true advice for `max_pages`;
        // after a failed request it is actively misleading, so the genuinely
        // useful action — plain Retry — is shown instead. Both are wired at
        // build time and only revealed by `renderSync()`.
        ui.truncRetryBtn = btn('Retry sync', () => {
          state.sync.truncateDismissed = false;
          startSync();
        }, 'warn'),
        ui.truncCapBtn = btn('Re-sync with a bigger cap', () => {
          // The cap that is actually in force is the worker's (`cursor.maxPages`);
          // fall back to whatever is typed, then to a sane default. The typed value
          // must be written to the input AND the mirrored state, because the send
          // path reads the input, not the state.
          const typed = num(ui.syncMaxPages.value);
          const current = (typed && typed > 0) ? typed : (state.sync.maxPages > 0 ? state.sync.maxPages : 20);
          const next = Math.min(2000, Math.max(2, current * 2));
          ui.syncMaxPages.value = String(next);
          state.syncMaxPages = String(next);
          schedulePersist();
          state.sync.truncateDismissed = false;
          startSync(true);
        }, 'warn'),
        btn('Dismiss', () => {
          // Session-scoped: the flag survives re-renders and pollSyncStatus calls,
          // so a routine SYNC_STATUS poll cannot resurrect a banner the user closed.
          state.sync.truncateDismissed = true;
          renderSync();
        }, 'ghost')
      ])
    ]);

    const syncSec = section('Sync', [
      h('div', { class: 'sm-row' }, [
        h('label', { class: 'sm-inline' }, [ui.syncForce, document.createTextNode(' force full re-sync')])
      ]),
      field('Disliked pass', 'Sent to SYNC_START as dislikedMode. Suno exposes no per-clip dislike field, but the feed itself does: the crawl asks /api/feed/v3 for one tri-state "disliked" filter and records is_disliked on every clip it stores. So "exclude" and "only" are each ONE walk and cost the same as a normal sync. Only "both passes" walks the feed twice — once hiding dislikes and once over the disliked rows only — and that is the only mode that pays double, plus the only one that tells you your disliked set.', ui.syncDisliked),
      field('Page cap', 'Max pages per feed — a SAFETY limit, not a target. It is the only reason the banner will offer "Re-sync with a bigger cap"; every other stop (a failed request, an empty page, a repeated cursor, fewer clips than Suno reports) is fixed by syncing again, not by raising this. Left empty the worker uses settings.syncMaxPages.', ui.syncMaxPages),
      h('div', { class: 'sm-row' }, [
        // Stored on `ui` so `renderSync()` can enable/disable and re-label them
        // from the worker's answer; they used to be created and forgotten, which is
        // why the dock could sit on an enabled "Start sync" through a crawl it did
        // not know about.
        ui.syncStartBtn = btn('Start sync', () => startSync(), 'primary'),
        // Renamed from "Cancel": "Stop sync" is what the other two surfaces call it
        // and what it does. The old label next to "Start sync" read as cancelling
        // the whole operation rather than ending the running crawl.
        ui.syncCancelBtn = btn(SYNC_CONTROL.stop, () => cancelSync(), 'ghost'),
        btn('Check status', () => pollSyncStatus(), 'ghost')
      ]),
      ui.syncState,
      ui.syncBar,
      ui.syncAnnounce,
      ui.truncWarn
    ], true);

    /* --- search -------------------------------------------------------- */
    ui.queryInput = h('input', {
      type: 'search', class: 'sm-input', placeholder: 'e.g. style:"dream pop" -metal title:love OR synth',
      value: state.filters.query,
      oninput: (e) => {
        state.filters.query = e.target.value;
        schedulePersist();
        debounceResults();
      }
    });
    ui.summary = h('div', { class: 'sm-summary', text: 'All clips' });

    const searchSec = section('Search', [
      ui.queryInput,
      h('div', { class: 'sm-help' }, [
        h('code', { text: '"quoted phrases"' }), document.createTextNode(' · '),
        h('code', { text: 'title:' }), h('code', { text: 'style:' }), h('code', { text: 'lyrics:' }),
        h('code', { text: 'prompt:' }), h('code', { text: 'model:' }), h('code', { text: 'project:' }),
        document.createTextNode(' · '), h('code', { text: '-exclude' }), document.createTextNode(' · '),
        h('code', { text: 'OR' })
      ]),
      ui.summary
    ], true);

    /* --- reactions ----------------------------------------------------- */
    ui.likedSel = triSelect(state.filters.liked, (e) => {
      state.filters.liked = e.target.value; schedulePersist(); onFiltersChanged();
    }, { onlyLabel: 'only', excludeLabel: 'exclude' });
    ui.dislikedSel = triSelect(state.filters.disliked, (e) => {
      state.filters.disliked = e.target.value;
      ui.syncDisliked.value = e.target.value;
      schedulePersist();
      onFiltersChanged();
    });

    const reactionsSec = section('Reactions', [
      field('Liked', 'clip.is_liked — YOUR OWN like state. Never inferred from upvote_count.', ui.likedSel),
      field('Disliked', 'No per-clip dislike field exists to read, so the sync asks the feed instead: /api/feed/v3 takes a server-side tri-state "disliked" filter, and every clip the crawl stores keeps its is_disliked value from that response. Defaults to "exclude disliked"; only the sync setting "both passes" costs an extra walk.', ui.dislikedSel),
      h('div', { class: 'sm-help', text: 'Defaults to "exclude disliked". Select "only" only when you specifically want the dislikes.' })
    ], true);

    /* --- workspace ----------------------------------------------------- */
    ui.projectList = h('div', { class: 'sm-checks' });
    ui.unassigned = h('input', {
      type: 'checkbox', class: 'sm-check', checked: state.filters.includeUnassigned,
      onchange: (e) => {
        state.filters.includeUnassigned = e.target.checked;
        schedulePersist();
        onFiltersChanged();
      }
    });
    ui.projectRefresh = btn('Reload projects', () => loadProjects(), 'ghost');

    const workspaceSec = section('Workspace / project', [
      h('div', { class: 'sm-help', text: 'Suno has NO project field on a clip. Membership is joined by the SW from /api/project/feed. The catch-all project id is literally "default" — shown here as My Workspace.' }),
      ui.projectList,
      h('label', { class: 'sm-inline' }, [ui.unassigned, document.createTextNode(' include unassigned when projects are picked')]),
      h('div', { class: 'sm-row' }, [ui.projectRefresh])
    ]);

    /* --- models -------------------------------------------------------- */
    ui.modelList = h('div', { class: 'sm-checks' });

    const modelsSec = section('Model generation', [
      h('div', { class: 'sm-help', text: 'Derived from major_model_version AND model_name (chirp-hawk/goose/crow/fenix/bluejay/auk/halibut/custom:<uuid>). major_model_version is often the empty string — "Unknown / legacy" is listed explicitly so those clips are never silently hidden.' }),
      ui.modelList,
      h('div', { class: 'sm-row' }, [
        btn('Select all', () => setAllModels(true)),
        btn('Clear', () => setAllModels(false))
      ])
    ]);

    /* --- ranges -------------------------------------------------------- */
    ui.dateFrom = h('input', {
      type: 'date', class: 'sm-input', value: state.filters.dateFrom,
      onchange: (e) => { state.filters.dateFrom = e.target.value; schedulePersist(); onFiltersChanged(); }
    });
    ui.dateTo = h('input', {
      type: 'date', class: 'sm-input', value: state.filters.dateTo,
      onchange: (e) => { state.filters.dateTo = e.target.value; schedulePersist(); onFiltersChanged(); }
    });
    ui.durMin = numInput('durationMin', 'sec');
    ui.durMax = numInput('durationMax', 'sec');
    ui.playsMin = numInput('playsMin', '');
    ui.playsMax = numInput('playsMax', '');
    ui.upMin = numInput('upvotesMin', '');

    const rangesSec = section('Ranges', [
      h('div', { class: 'sm-grid2' }, [
        field('Created from', 'clip.created_at — inclusive, local midnight.', ui.dateFrom),
        field('Created to', 'clip.created_at — inclusive, local end of day.', ui.dateTo),
        field('Duration min', 'clip.duration. Its upstream TYPE is unverified — seconds-as-number and "m:ss" are both handled.', ui.durMin),
        field('Duration max', 'clip.duration. Same type caveat as min.', ui.durMax),
        field('Plays min', 'clip.play_count', ui.playsMin),
        field('Plays max', 'clip.play_count', ui.playsMax),
        field('Upvotes min', 'clip.upvote_count — NOT your like state.', ui.upMin)
      ])
    ]);

    /* --- tri-state toggles --------------------------------------------- */
    ui.toggles = h('div', { class: 'sm-toggles' });
    buildToggleRows();

    /* --- presets ------------------------------------------------------- */
    ui.presetRow = h('div', { class: 'sm-chips' });

    /* --- sort ---------------------------------------------------------- */
    const fEngine = F();
    const sortKeys = (fEngine && fEngine.SORT_KEYS) || ['newest', 'oldest', 'plays', 'upvotes', 'title', 'duration'];
    const sortLabels = {
      newest: 'Newest', oldest: 'Oldest', plays: 'Plays', upvotes: 'Upvotes',
      title: 'Title', duration: 'Duration'
    };
    const sortOptions = sortKeys.map((k) => [k, sortLabels[k] || k]);
    ui.sortSel = selectEl(sortOptions, state.filters.sort, (e) => {
      state.filters.sort = e.target.value; schedulePersist(); onFiltersChanged();
    });
    ui.orderSel = selectEl([['desc', 'desc'], ['asc', 'asc']], state.filters.order, (e) => {
      state.filters.order = e.target.value; schedulePersist(); onFiltersChanged();
    });

    const sortSec = section('Sort', [
      h('div', { class: 'sm-grid2' }, [
        field('Key', 'SunoFilter.SORT_KEYS. Sorting is SunoFilter.sort(), never apply().', ui.sortSel),
        field('Order', 'Ascending or descending; each key has a sane default.', ui.orderSel)
      ])
    ]);

    /* --- ids ----------------------------------------------------------- */
    ui.idArea = h('textarea', {
      class: 'sm-area', rows: '3', spellcheck: 'false',
      placeholder: 'paste clip uuids, whitespace/comma separated',
      value: state.filters.idList,
      oninput: (e) => { state.filters.idList = e.target.value; schedulePersist(); debounceResults(); }
    });

    const idsSec = section('Explicit id list', [
      h('div', { class: 'sm-help', text: 'The most useful mass-download primitive: ids.include. Non-uuid tokens are ignored.' }),
      ui.idArea,
      h('div', { class: 'sm-row' }, [
        btn('Apply', () => { state.filters.idList = ui.idArea.value; onFiltersChanged(); }, 'primary'),
        btn('Clear', () => { ui.idArea.value = ''; state.filters.idList = ''; onFiltersChanged(); }, 'ghost'),
        btn('Use selected rows', () => {
          ui.idArea.value = Array.from(state.selection).join('\n');
          state.filters.idList = ui.idArea.value;
          onFiltersChanged();
        }, 'ghost')
      ])
    ]);

    /* --- genres ------------------------------------------------------- */
    ui.genreRow = h('div', { class: 'sm-chips' });
    const genreSec = section('Genre chips', [
      h('div', { class: 'sm-help', text: 'Top metadata.tags / metadata.style tokens from facets.genres. Clicking appends style:"token" to the search box.' }),
      ui.genreRow
    ]);

    /* --- results ------------------------------------------------------- */
    ui.resultCount = h('span', { class: 'sm-count', text: '0' });
    ui.prevBtn = btn('◀ Prev', () => pageResults(-1), 'ghost');
    ui.nextBtn = btn('Next ▶', () => pageResults(1), 'ghost');
    ui.resultList = h('div', { class: 'sm-results' });
    ui.resultsAllBtn = h('input', {
      type: 'checkbox', class: 'sm-check',
      onchange: (e) => bulkSelect(e.target.checked ? 'all' : 'none')
    });

    const panel = h('aside', { class: 'sm-panel', id: 'sm-panel' }, [
      h('div', { class: 'sm-panel-head' }, [
        h('strong', { text: 'Library filters' }),
        h('span', { class: 'sm-grow' }),
        btn('Reset all', () => resetFilters(), 'ghost'),
        btn('Close', () => togglePanel(false), 'ghost')
      ]),
      h('div', { class: 'sm-cols' }, [
        h('div', { class: 'sm-col' }, [syncSec, searchSec, reactionsSec, workspaceSec, modelsSec]),
        h('div', { class: 'sm-col' }, [
          rangesSec,
          section('Toggles', [ui.toggles]),
          section('Presets', [ui.presetRow]),
          sortSec,
          idsSec,
          genreSec,
          section('Results', [
            h('div', { class: 'sm-row' }, [ui.resultsAllBtn, h('span', { text: 'select all filtered' }), ui.resultCount]),
            h('div', { class: 'sm-row' }, [ui.prevBtn, ui.nextBtn]),
            ui.resultList
          ], true)
        ])
      ])
    ]);
    return panel;
  }

  function numInput(key, unit) {
    return h('input', {
      type: 'number', class: 'sm-input sm-num', min: '0', step: 'any',
      value: state.filters[key],
      oninput: (e) => {
        state.filters[key] = e.target.value;
        schedulePersist();
        debounceResults();
      }
    }, unit ? [h('span', { class: 'sm-unit', text: unit })] : []);
  }

  const TOGGLES = [
    ['instrumental', 'Instrumental', 'metadata.make_instrumental — MAY BE ABSENT on vocal clips, absent is treated as false.'],
    ['remixes', 'Remixes', 'metadata.is_remix'],
    ['trashed', 'Trashed', 'clip.is_trashed. An empty spec does NOT hide these any more — pick this explicitly.'],
    ['visibility', 'Public', 'clip.is_public / clip.is_hidden (spec.visibility public|private).'],
    ['contests', 'Contests', 'clip.is_contest_clip'],
    ['hooks', 'Has hook', 'clip.has_hook'],
    ['unliked', 'Unliked', 'include.unliked — true = only clips you have NOT liked.'],
    ['uploads', 'Uploads', 'metadata.type !== "gen" / source_type === "upload".'],
    ['stems', 'Stems', 'No clip field exists for stems, so this is a real search term: the word "stems" in title/style/prompt/lyrics.'],
    ['generated', 'AI generated', 'metadata.type === "gen"']
  ];

  function buildToggleRows() {
    for (let i = 0; i < TOGGLES.length; i++) {
      const key = TOGGLES[i][0];
      const label = TOGGLES[i][1];
      const help = TOGGLES[i][2];
      const sel = triSelect(state.filters[key], (e) => {
        state.filters[key] = e.target.value;
        schedulePersist();
        onFiltersChanged();
      });
      ui['t_' + key] = sel;
      ui.toggles.appendChild(h('div', { class: 'sm-toggle-row' }, [
        h('label', { class: 'sm-label' }, [document.createTextNode(label), qmark(help)]),
        sel
      ]));
    }
  }

  /* ---------------------------- batch drawer ------------------------ */

  function buildBatch() {
    ui.dlProgressText = h('span', { class: 'sm-count', text: 'idle' });
    ui.dlBar = h('div', { class: 'sm-bar' }, [h('div', { class: 'sm-bar-fill' })]);
    // Where a stopped batch explains itself. A quota halt is a WARNING and a dead
    // ladder is an ERROR, so this must not be the same green "done" line.
    ui.dlStopNote = h('div', { class: 'sm-warn' }, []);
    ui.dlList = h('div', { class: 'sm-dl-list' });
    ui.dlHistory = h('div', { class: 'sm-dl-history' });

    return h('aside', { class: 'sm-drawer', id: 'sm-batch-drawer' }, [
      h('div', { class: 'sm-panel-head' }, [
        h('strong', { text: 'Batch downloads' }),
        h('span', { class: 'sm-grow' }),
        btn('Close', () => toggleDrawer('batch', false), 'ghost')
      ]),
      h('div', { class: 'sm-row' }, [
        btn('Start (current filter)', () => startDownload(), 'primary'),
        btn('Start (selected rows)', () => startDownload(true)),
        btn('Cancel', () => cancelDownload(), 'ghost'),
        btn('Retry failed', () => retryFailed(), 'ghost')
      ]),
      h('div', { class: 'sm-row' }, [
        h('label', { class: 'sm-inline' }, [
          h('input', {
            type: 'checkbox', class: 'sm-check', checked: state.settings.dryRun,
            onchange: (e) => { state.settings.dryRun = e.target.checked; saveSettings({ dryRun: e.target.checked }); }
          }),
          document.createTextNode(' dry run (plan only, no files)')
        ])
      ]),
      ui.dlProgressText,
      ui.dlBar,
      ui.dlStopNote,
      ui.dlList,
      h('div', { class: 'sm-sec-head-static', text: 'History' }),
      h('div', { class: 'sm-row' }, [btn('Reload history', () => loadHistory(), 'ghost')]),
      ui.dlHistory
    ]);
  }

  /* ---------------------------- settings drawer --------------------- */

  function buildSettings() {
    ui.variantSel = selectEl(VARIANTS, state.settings.variant, (e) => {
      saveSettings({ variant: e.target.value });
    });
    ui.filenameInput = h('input', {
      type: 'text', class: 'sm-input', value: state.settings.filenameTemplate,
      onchange: (e) => saveSettings({ filenameTemplate: e.target.value })
    });
    ui.ladder = h('div', { class: 'sm-ladder' });
    ui.overwriteChk = h('input', {
      type: 'checkbox', class: 'sm-check', checked: state.settings.overwrite,
      onchange: (e) => saveSettings({ overwrite: e.target.checked })
    });
    ui.tagBox = h('div', { class: 'sm-checks' });
    ui.tokenInfo = h('div', { class: 'sm-help', text: 'token: unknown' });

    // The seven keys `coerceSettings` reads, in one place, so the checkbox list, the
    // initial state and the saved object cannot drift apart. `lrc`, `artwork` and
    // `json` are the SIDECARS that used to be offered (and silently reverted) as
    // variants: they are toggled here instead. A standalone cover-art FILE is
    // NOT offered — it needs `image_url` / `image_large_url`, which this build does
    // not implement.
    const TAG_TOGGLES = [
      ['embed', 'Embed tags in the audio file', 'Needs the tagger; M4A is tagged in place.'],
      ['lyrics', 'Include lyrics in the tags', 'Adds a LYRICS/USLT field.'],
      ['artwork', 'Include cover art', 'Embedded artwork from the clip image.'],
      ['bpm', 'Detect + tag BPM', 'Measured when the clip carries no usable bpm; never invented.'],
      ['comment', 'Tag the Suno clip URL/id as a comment', 'Keeps the source link with the file.'],
      ['lrc', 'Write an .lrc lyrics sidecar', 'A SEPARATE .lrc file next to the audio.'],
      ['json', 'Write a .json metadata sidecar', 'A SEPARATE .json file next to the audio.']
    ];
    ui.tagInputs = {};
    for (let i = 0; i < TAG_TOGGLES.length; i++) {
      const key = TAG_TOGGLES[i][0];
      const label = TAG_TOGGLES[i][1];
      const help = TAG_TOGGLES[i][2];
      const box = h('input', {
        type: 'checkbox', class: 'sm-check', checked: !!state.settings.tagOptions[key],
        title: help,
        onchange: (e) => {
          // Merge over the WHOLE tagOptions object: every worker key is sent back,
          // so toggling one never resets the other six.
          const tags = Object.assign({}, state.settings.tagOptions);
          tags[key] = e.target.checked;
          saveSettings({ tagOptions: tags });
        }
      });
      ui.tagInputs[key] = box;
      ui.tagBox.appendChild(h('label', { class: 'sm-inline' }, [
        box,
        document.createTextNode(' ' + label),
        qmark(help)
      ]));
    }

    // ---- HLS opt-in (OFF by default) ----
    ui.hlsEnable = h('input', {
      type: 'checkbox', class: 'sm-check',
      onchange: (e) => {
        if (e.target.checked) confirmHls();
        else e.target.checked = false;
      }
    });
    ui.hlsStatus = h('div', { class: 'sm-help', text: 'idle — disabled' });
    ui.hlsBtn = btn('Capture current stream', () => confirmHls(), 'warn');
    ui.hlsBlock = h('div', {});

    return h('aside', { class: 'sm-drawer', id: 'sm-settings-drawer' }, [
      h('div', { class: 'sm-panel-head' }, [
        h('strong', { text: 'Settings' }),
        h('span', { class: 'sm-grow' }),
        btn('Close', () => toggleDrawer('settings', false), 'ghost')
      ]),
      field('Variant', 'The only three this build can produce: M4A is native, WAV is a local render. MP3/OGG/FLAC would need an encoder that is not shipped, so the worker would silently alias them to M4A.', ui.variantSel),
      field('Filename template', 'Tokens: {title} {artist} {bpm} {format} {date} {id}.', ui.filenameInput),
      h('div', { class: 'sm-field' }, [
        h('label', { class: 'sm-label' }, [
          document.createTextNode('Download source ladder'),
          qmark('Order the SW tries sources in. audio_url is often the /api/forbidden decoy (SunoFilter.audioUrlIsDecoy), so it is last.')
        ]),
        ui.ladder
      ]),
      h('label', { class: 'sm-inline' }, [ui.overwriteChk, document.createTextNode(' overwrite existing files')]),
      h('div', { class: 'sm-field' }, [
        h('label', { class: 'sm-label' }, [
          document.createTextNode('Tags & sidecars'),
          qmark('All seven worker keys are sent on every save, so toggling one never resets another.')
        ]),
        ui.tagBox,
        h('div', { class: 'sm-help', text: 'LRC / cover art / JSON are SIDECARS written next to the audio file, not variants. They are toggled here because the variant list only holds real audio formats.' })
      ]),
      h('div', { class: 'sm-field' }, [
        h('label', { class: 'sm-label' }, [document.createTextNode('Session token'), qmark('The service worker reads the token out of the page itself, by observing the Authorization header Suno already sends. This panel only reports status and never holds a token.')]),
        ui.tokenInfo,
        h('div', { class: 'sm-row' }, [
          btn('Refresh token', () => refreshToken()),
          btn('Ask worker to re-read session', () => requestPageToken())
        ]),
        h('div', { class: 'sm-help', text: 'Both buttons ask the service worker for the same thing. "Refresh token" also re-checks the token for expiry and tells you to re-sign-in if Suno rejects it; "Ask worker to re-read session" is the blunt version of the same request, for when the status line looks stale. Neither one reads anything out of the page directly — the service worker taps the page’s Authorization header for that, and a token it has not seen yet cannot be conjured by clicking here.' })
      ]),
      h('div', { class: 'sm-field' }, [
        h('label', { class: 'sm-label' }, [
          document.createTextNode('Experimental: HLS capture'),
          qmark('Off by default. The service worker runs a MAIN-world operation that sets window.MediaSource = undefined in the page, so the player falls back to a plain fetch; this dock then collects the #EXT-X-MAP init segment + media segments. The page is restored in a finally, and a failed restore is reported rather than hidden.')
        ]),
        h('div', { class: 'sm-warn sm-warn-inline' }, [
          h('span', { text: 'This manipulates the page and is the kind of behaviour that trips abuse heuristics. Use the API paths unless you need the stream itself.' })
        ]),
        ui.hlsBlock
      ])
    ]);
  }

  /**
   * Render the HLS controls ONLY when the worker will actually accept the hand-off.
   *
   * `captureHls()` returns `{ok:false, code:'hls_disabled'}` unless
   * `settings.allowHlsCapture` is true, and that flag lives in the options page —
   * it cannot be turned on from here. Rendering the two controls anyway produced
   * buttons that looked live and could only ever fail, so instead the drawer shows
   * the one thing that is actionable: the exact setting to switch on.
   */
  function renderHlsAvailability() {
    if (!ui.hlsBlock) return;
    clear(ui.hlsBlock);
    if (state.settings.allowHlsCapture !== true) {
      setHlsStatus('unavailable — settings.allowHlsCapture is off in the service worker');
      ui.hlsBlock.appendChild(h('div', { class: 'sm-warn sm-warn-inline' }, [
        h('span', { text: 'The service worker refuses every HLS_CAPTURE hand-off unless settings.allowHlsCapture is true, and that flag is only settable in the extension options page. Enable it there, then reload this tab.' })
      ]));
      return;
    }
    ui.hlsBlock.appendChild(h('label', { class: 'sm-inline' }, [
      ui.hlsEnable,
      document.createTextNode(' I understand — enable for this session')
    ]));
    ui.hlsBlock.appendChild(h('div', { class: 'sm-row' }, [ui.hlsBtn]));
    ui.hlsBlock.appendChild(ui.hlsStatus);
    // Nothing is patched yet — this is the idle, armed state. Say exactly that, and
    // do not promise the restore here: the restore is only real once the worker
    // confirms it, and `runHlsCapture` is where a failed one gets reported.
    setHlsStatus('idle — nothing is patched yet. The page is only touched while a capture runs, and the restore is reported if it fails.');
  }

  function renderLadder() {
    if (!ui.ladder) return;
    clear(ui.ladder);
    const order = state.settings.sourceLadder;
    // The worker's own rung list when we have it (`GET_BOOT.ladder` /
    // `GET_SETTINGS.ladder` = LADDER_RUNGS), so a stored CANONICAL id is shown by
    // its real label and its metered/opt-in flags are visible. Falls back to this
    // file's alias vocabulary.
    const known = Array.isArray(state.ladder) && state.ladder.length ? state.ladder : null;
    const label = (id) => {
      const rung = known ? known.filter((r) => r && r.id === id)[0] : null;
      if (rung) return rung.label + (rung.metered ? ' · metered' : '') + (rung.optIn ? ' · opt-in' : '');
      const alias = SOURCES.filter((s) => s[0] === id)[0];
      return alias ? alias[1] : id;
    };
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const rung = known ? known.filter((r) => r && r.id === id)[0] : null;
      ui.ladder.appendChild(h('div', { class: 'sm-ladder-row' }, [
        h('span', { class: 'sm-ladder-pos', text: String(i + 1) }),
        h('span', { class: 'sm-ladder-name', text: label(id), title: rung && rung.note ? rung.note : '' }),
        btn('↑', () => moveLadder(i, -1)),
        btn('↓', () => moveLadder(i, 1))
      ]));
    }
    // The "available rungs" pool. Two exclusions, matching the options page's
    // `editableRungs()` — DUPLICATED rather than imported, because a content
    // script and an extension page are separate contexts with no shared graph:
    //   `hls` — the worker's own rung note says "Not a rung"; the hand-off is
    //           gated by "Allow HLS stream capture" in the options page, and
    //           listing it among the others suggests it can be ordered against
    //           them.
    //   `batchOnly` rungs (`zip`) — `normalizeLadder()` (background.js) drops
    //           these from the stored ladder UNCONDITIONALLY, it is not the
    //           opt-in flag that removes them. Offering one here would offer an
    //           "Enable" button that saves, then silently deletes the rung it
    //           just added: a control that looks live and is not.
    const rest = known
      ? known.filter((r) => r && r.id && r.id !== 'hls' && r.batchOnly !== true
        && order.indexOf(r.id) === -1)
      : SOURCES.filter((s) => s[0] !== 'hls' && order.indexOf(s[0]) === -1);
    for (let j = 0; j < rest.length; j++) {
      const entry = rest[j];
      const id = known ? entry.id : entry[0];
      const note = (known && entry.note ? entry.note : '')
        + (known && entry.optIn ? ' Needs settings.allowMeteredExtras in the options page.' : '');
      ui.ladder.appendChild(h('div', { class: 'sm-ladder-row sm-ladder-off' }, [
        h('span', { class: 'sm-ladder-pos', text: '—' }),
        h('span', { class: 'sm-ladder-name', text: label(id), title: note }),
        btn('Enable', () => {
          const next = state.settings.sourceLadder.concat([id]);
          state.settings.sourceLadder = next;
          renderLadder();
          saveSettings({ sourceLadder: next.slice() });
        }, 'ghost')
      ]));
    }
  }

  function moveLadder(i, dir) {
    const arr = state.settings.sourceLadder;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    renderLadder();
    saveSettings({ sourceLadder: arr.slice() });
  }

  /* ================================================================== *
   * 10. panel / drawer visibility
   * ================================================================== */

  function togglePanel(force) {
    const on = force === undefined ? !state.panelOpen : !!force;
    state.panelOpen = on;
    if (ui.panel) ui.panel.classList.toggle('on', on);
    if (on) { refreshResults(); refreshFacets(); }
  }

  function toggleDrawer(which, force) {
    const key = which === 'batch' ? 'batchOpen' : 'settingsOpen';
    const on = force === undefined ? !state[key] : !!force;
    state[key] = on;
    const el = which === 'batch' ? ui.batchDrawer : ui.settingsDrawer;
    if (el) el.classList.toggle('on', on);
    if (on && which === 'batch') loadHistory();
    if (on && which === 'settings') { renderLadder(); renderTokenInfo(); }
  }

  /* ================================================================== *
   * 11. filter plumbing
   * ================================================================== */

  function onFiltersChanged() {
    renderSummary();
    renderModelFacets();
    debounceResults();
  }

  let resultTimer = 0;

  function debounceResults() {
    if (resultTimer) clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      resultTimer = 0;
      refreshResults(true);
    }, SEARCH_DEBOUNCE_MS);
  }

  function renderSummary() {
    if (ui.summary) ui.summary.textContent = describeSpec();
  }

  function setAllModels(on) {
    const fEngine = F();
    const models = (fEngine && fEngine.MODELS) || [];
    state.filters.models = on ? models.map((m) => m.id) : [];
    schedulePersist();
    renderModelFacets();
    onFiltersChanged();
  }

  function facetCount(id) {
    const f = state.facets;
    if (!f || !Array.isArray(f.models)) return 0;
    for (let i = 0; i < f.models.length; i++) {
      if (f.models[i].id === id) return f.models[i].count;
    }
    return 0;
  }

  function projectCount(id) {
    const f = state.facets;
    if (!f || !Array.isArray(f.projects)) return 0;
    for (let i = 0; i < f.projects.length; i++) {
      if (f.projects[i].id === id) return f.projects[i].count;
    }
    return 0;
  }

  function renderModelFacets() {
    if (!ui.modelList) return;
    const fEngine = F();
    const models = (fEngine && fEngine.MODELS) || [];
    clear(ui.modelList);
    const selected = state.filters.models;
    for (let i = 0; i < models.length; i++) {
      const id = models[i].id;
      const count = facetCount(id);
      const isUnknown = id === 'unknown';
      const box = h('input', {
        type: 'checkbox',
        class: 'sm-check',
        checked: selected.indexOf(id) !== -1,
        onchange: (e) => {
          const set = new Set(state.filters.models);
          if (e.target.checked) set.add(id); else set.delete(id);
          state.filters.models = Array.from(set);
          schedulePersist();
          onFiltersChanged();
        }
      });
      ui.modelList.appendChild(h('label', { class: 'sm-inline sm-model-row' + (isUnknown ? ' sm-unknown' : '') }, [
        box,
        document.createTextNode(' ' + (isUnknown ? 'Unknown / legacy' : models[i].label)),
        h('span', { class: 'sm-n', text: ' ' + count })
      ]));
    }
  }

  function renderProjectList() {
    if (!ui.projectList) return;
    clear(ui.projectList);
    const selected = new Set(state.filters.projects);
    const list = state.projects.slice();
    if (!list.length) {
      ui.projectList.appendChild(h('div', { class: 'sm-help', text: 'no projects loaded yet — run a sync first' }));
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const id = String(p.id || '');
      if (!id) continue;
      const name = id === 'default' ? 'My Workspace' : String(p.name || id);
      const box = h('input', {
        type: 'checkbox',
        class: 'sm-check',
        checked: selected.has(id),
        onchange: (e) => {
          const set = new Set(state.filters.projects);
          if (e.target.checked) set.add(id); else set.delete(id);
          state.filters.projects = Array.from(set);
          schedulePersist();
          onFiltersChanged();
        }
      });
      ui.projectList.appendChild(h('label', { class: 'sm-inline sm-model-row' + (id === 'default' ? ' sm-unknown' : '') }, [
        box,
        document.createTextNode(' ' + name),
        h('span', { class: 'sm-n', text: ' ' + projectCount(id) })
      ]));
    }
  }

  function renderPresets() {
    if (!ui.presetRow) return;
    clear(ui.presetRow);
    const fEngine = F();
    const presets = (fEngine && fEngine.PRESETS) || {};
    for (let i = 0; i < PRESET_CHIPS.length; i++) {
      const key = PRESET_CHIPS[i][0];
      const label = PRESET_CHIPS[i][1];
      const preset = presets[key];
      if (!preset) continue;
      ui.presetRow.appendChild(h('button', {
        type: 'button',
        class: 'sm-chip',
        text: label,
        title: describePreset(key, preset),
        onclick: () => applyPreset(key)
      }));
    }
  }

  // MOST_PLAYED / MOST_LIKED used to be empty objects identical to ALL. They are
  // real sorts now, and this tooltip proves it to the user.
  function describePreset(key, preset) {
    const bits = [];
    if (preset.sort) bits.push('sort=' + preset.sort + ' ' + (preset.order || ''));
    if (preset.models) bits.push('models=' + preset.models.join(','));
    if (preset.liked) bits.push('liked=' + preset.liked);
    if (preset.disliked) bits.push('disliked=' + preset.disliked);
    if (preset.include) {
      for (const k in preset.include) bits.push(k + '=' + preset.include[k]);
    }
    if (preset.createdAfter) bits.push('created after ' + new Date(preset.createdAfter).toISOString().slice(0, 10));
    return bits.length ? key + ': ' + bits.join(' · ') : key;
  }

  function applyPreset(key) {
    const fEngine = F();
    const presets = (fEngine && fEngine.PRESETS) || {};
    const preset = presets[key];
    if (!preset) return;
    // PRESETS.ALL is literally {} — "All clips" means no constraints, so it has to
    // clear the controls rather than merge nothing into them.
    if (!Object.keys(preset).length) {
      resetFilters();
      toast('Preset applied: ALL (no constraints)');
      return;
    }
    const f = state.filters;

    // A preset is merged onto the current spec, then the spec is read back into
    // the controls so the UI can never disagree with what will be sent.
    const merged = buildSpec();
    const p = fEngine && typeof fEngine.normalizeSpec === 'function'
      ? fEngine.normalizeSpec(preset)
      : preset;

    if (p.liked) merged.liked = p.liked;
    if (p.disliked) merged.disliked = p.disliked;
    if (p.visibility) merged.visibility = p.visibility;
    if (p.status) merged.status = p.status;
    if (p.models && p.models.length) merged.models = p.models.slice();
    if (p.projects && p.projects.length) merged.projects = p.projects.slice();
    if (p.createdAfter) merged.createdAfter = p.createdAfter;
    if (p.createdBefore) merged.createdBefore = p.createdBefore;
    if (p.sort) merged.sort = p.sort;
    if (p.order) merged.order = p.order;
    if (p.include) {
      // NOTE: `false` is a REAL constraint in SunoFilter (exclude), not "clear".
      // Deleting it here would have turned NO_TRASHED into a no-op.
      merged.include = Object.assign({}, merged.include || {});
      for (const k in p.include) merged.include[k] = p.include[k];
    }

    state.filters = specToFilters(merged, state.filters);
    applyFiltersToControls();
    schedulePersist();
    onFiltersChanged();
    toast('Preset applied: ' + key);
  }

  function specToFilters(spec, base) {
    const f = clone(base);
    const inc = spec.include || {};
    f.liked = spec.liked || 'any';
    f.disliked = spec.disliked || 'any';
    f.models = Array.isArray(spec.models) ? spec.models.slice() : [];
    f.projects = Array.isArray(spec.projects) ? spec.projects.slice() : [];
    f.instrumental = flagToTri(inc.instrumental);
    f.remixes = flagToTri(inc.remixes);
    f.trashed = flagToTri(inc.trashed);
    f.contests = flagToTri(inc.contests);
    f.hooks = flagToTri(inc.hooks);
    f.unliked = flagToTri(inc.unliked);
    f.uploads = flagToTri(inc.uploads);
    f.generated = flagToTri(inc.generated);
    f.visibility = spec.visibility === 'public' ? 'only' : (spec.visibility === 'private' ? 'exclude' : 'any');
    if (spec.createdAfter) f.dateFrom = msToDay(spec.createdAfter);
    if (spec.createdBefore) f.dateTo = msToDay(spec.createdBefore);
    if (spec.durationMin != null) f.durationMin = String(spec.durationMin);
    if (spec.durationMax != null) f.durationMax = String(spec.durationMax);
    if (spec.playsMin != null) f.playsMin = String(spec.playsMin);
    if (spec.playsMax != null) f.playsMax = String(spec.playsMax);
    if (spec.upvotesMin != null) f.upvotesMin = String(spec.upvotesMin);
    if (spec.ids && Array.isArray(spec.ids.include)) f.idList = spec.ids.include.join('\n');
    if (spec.sort) f.sort = spec.sort;
    if (spec.order) f.order = spec.order;
    if (Array.isArray(spec.terms) && spec.terms.length) {
      // Only a pure stem term is representable; anything else goes back to text.
      const others = spec.terms.filter((t) => !(t && !t.negate && t.field === 'any' && t.value === 'stems'));
      f.query = others.length
        ? others.map(termToQuery).join(' ')
        : (f.query || '');
      f.stems = (spec.terms || []).some((t) => t && t.field === 'any' && t.value === 'stems')
        ? (spec.terms.some((t) => t && t.field === 'any' && t.value === 'stems' && t.negate) ? 'exclude' : 'only')
        : 'any';
    }
    return f;
  }

  function flagToTri(v) {
    if (v === true) return 'only';
    if (v === false) return 'exclude';
    return 'any';
  }

  function termToQuery(t) {
    if (!t) return '';
    const prefix = t.field && t.field !== 'any' ? t.field + ':' : '';
    const value = /\s/.test(t.value) ? '"' + t.value + '"' : t.value;
    return (t.negate ? '-' : '') + prefix + value;
  }

  function msToDay(ms) {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function applyFiltersToControls() {
    const f = state.filters;
    if (ui.queryInput) ui.queryInput.value = f.query;
    if (ui.likedSel) ui.likedSel.value = f.liked;
    if (ui.dislikedSel) ui.dislikedSel.value = f.disliked;
    if (ui.syncDisliked) ui.syncDisliked.value = f.disliked;
    if (ui.unassigned) ui.unassigned.checked = f.includeUnassigned;
    if (ui.dateFrom) ui.dateFrom.value = f.dateFrom;
    if (ui.dateTo) ui.dateTo.value = f.dateTo;
    if (ui.durMin) ui.durMin.value = f.durationMin;
    if (ui.durMax) ui.durMax.value = f.durationMax;
    if (ui.playsMin) ui.playsMin.value = f.playsMin;
    if (ui.playsMax) ui.playsMax.value = f.playsMax;
    if (ui.upMin) ui.upMin.value = f.upvotesMin;
    if (ui.sortSel) ui.sortSel.value = f.sort;
    if (ui.orderSel) ui.orderSel.value = f.order;
    if (ui.idArea) ui.idArea.value = f.idList;
    for (let i = 0; i < TOGGLES.length; i++) {
      const sel = ui['t_' + TOGGLES[i][0]];
      if (sel) sel.value = f[TOGGLES[i][0]];
    }
    renderModelFacets();
    renderProjectList();
    renderSummary();
  }

  function resetFilters() {
    state.filters = clone(DEFAULT_FILTERS);
    applyFiltersToControls();
    schedulePersist();
    onFiltersChanged();
    toast('Filters reset');
  }

  /* ================================================================== *
   * 12. results
   * ================================================================== */

  function firstArray(res, keys) {
    for (let i = 0; i < keys.length; i++) {
      const v = res[keys[i]];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  async function refreshResults(resetPage) {
    if (!state.mounted) return;
    if (resetPage) { state.results.offset = 0; }
    const spec = specForRequest();
    const res = await send('GET_CLIPS', {
      spec: spec,
      limit: state.results.limit,
      offset: state.results.offset,
      sort: state.filters.sort,
      order: state.filters.order
    });
    if (bail(res, 'GET_CLIPS')) { renderCounts(); return; }
    const items = firstArray(res, ['clips', 'items', 'data', 'results']);
    state.results.items = items;
    state.results.total = typeof res.total === 'number' ? res.total : items.length;
    state.results.hasMore = !!res.hasMore;
    renderResults();
    renderCounts();
  }

  function renderCounts() {
    if (!ui.countLabel) return;
    const sel = state.selection.size;
    const total = state.results.total;
    ui.countLabel.textContent = total
      ? (total + ' clip' + (total === 1 ? '' : 's') + ' match' + (total === 1 ? '' : 'es') + ' · ' + sel + ' selected')
      : 'no clips loaded';
    if (ui.resultCount) {
      ui.resultCount.textContent = state.results.items.length + ' shown of ' + total;
    }
    if (ui.resultsAllBtn) {
      const shown = state.results.items.filter((c) => c && state.selection.has(c.id)).length;
      ui.resultsAllBtn.checked = state.results.items.length > 0 && shown === state.results.items.length;
      ui.resultsAllBtn.indeterminate = shown > 0 && shown < state.results.items.length;
    }
  }

  function renderResults() {
    if (!ui.resultList) return;
    clear(ui.resultList);
    const items = state.results.items;
    if (!items.length) {
      ui.resultList.appendChild(h('div', { class: 'sm-empty', text: 'No clips match the current filters.' }));
      return;
    }
    const fEngine = F();
    for (let i = 0; i < items.length; i++) {
      const clip = items[i];
      if (!clip || typeof clip !== 'object') continue;
      const id = String(clip.id || '');
      if (!id) continue;
      const rec = fEngine && typeof fEngine.normalize === 'function'
        ? fEngine.normalize(clip)
        : clip;
      const title = String(clip.title || (clip.metadata && clip.metadata.title) || '(untitled)');
      const dur = rec.durationSec != null ? Math.round(rec.durationSec) + 's' : '—';
      const plays = typeof rec.playCount === 'number' ? rec.playCount : 0;
      const model = rec.modelLabel || rec.modelName || 'unknown';

      const box = h('input', {
        type: 'checkbox', class: 'sm-check',
        checked: state.selection.has(id),
        onchange: (e) => toggleSelect(id, e.target.checked)
      });

      ui.resultList.appendChild(h('div', { class: 'sm-result' + (state.selection.has(id) ? ' on' : '') }, [
        box,
        h('span', { class: 'sm-result-title', text: title, title: title }),
        h('span', { class: 'sm-badge', text: model }),
        h('span', { class: 'sm-badge', text: dur }),
        h('span', { class: 'sm-badge', text: plays + ' plays' }),
        rec.isLiked ? h('span', { class: 'sm-badge sm-ok', text: 'liked' }) : null,
        rec.isRemix ? h('span', { class: 'sm-badge', text: 'remix' }) : null,
        rec.isTrashed ? h('span', { class: 'sm-badge sm-warnb', text: 'trashed' }) : null,
        rec.audioUrlIsDecoy ? h('span', { class: 'sm-badge sm-warnb', text: 'decoy url', title: 'audio_url points at /api/forbidden' }) : null,
        btn('↓', () => downloadIds([id]), 'ghost sm-mini')
      ]));
    }
  }

  function pageResults(dir) {
    const next = state.results.offset + dir * state.results.limit;
    if (next < 0) return;
    // `!dir < 0` parses as `(!dir) < 0`, which is false for both -1 and 1, so this
    // guard could never fire and "Next ▶" walked onto empty pages forever.
    if (dir > 0 && !state.results.hasMore && next >= state.results.total) return;
    state.results.offset = next;
    refreshResults(false);
  }

  /* ================================================================== *
   * 13. selection
   * ================================================================== */

  let selectionTimer = 0;

  function toggleSelect(id, on) {
    if (on) state.selection.add(id);
    else state.selection.delete(id);
    scheduleSelectionPush();
    renderResults();
    renderCounts();
    renderRowState(id);
  }

  function bulkSelect(mode) {
    const ids = state.results.items
      .map((c) => (c && c.id ? String(c.id) : ''))
      .filter((id) => !!id);
    if (mode === 'all') ids.forEach((id) => state.selection.add(id));
    else if (mode === 'none') ids.forEach((id) => state.selection.delete(id));
    else ids.forEach((id) => {
      if (state.selection.has(id)) state.selection.delete(id);
      else state.selection.add(id);
    });
    scheduleSelectionPush();
    renderResults();
    renderCounts();
    refreshRowControls();
  }

  function scheduleSelectionPush() {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = 0;
      send('SET_SELECTION', { ids: Array.from(state.selection) }).then((res) => {
        if (!res.ok) fail('SET_SELECTION', { message: res.error, code: res.code });
      });
    }, 300);
  }

  async function loadSelection() {
    const res = await send('GET_SELECTION');
    if (bail(res, 'GET_SELECTION')) return;
    const ids = firstArray(res, ['ids', 'selection']);
    state.selection = new Set(ids.map((x) => String(x)).filter(Boolean));
    renderResults();
    renderCounts();
    refreshRowControls();
  }

  /* ================================================================== *
   * 14. sync
   * ================================================================== */

  /**
   * `stopReason` -> plain English. THE SHARED MAP — byte-identical copies live
   * in popup/popup.js and side_panel.js. Values are whole clauses so the dock,
   * the banner and the error strip can all reuse them unaltered.
   */
  const SYNC_REASON_PHRASE = {
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
  const SYNC_REASON_FALLBACK = 'it stopped early for a reason the worker did not report';

  /**
   * @param {unknown} stopReason
   * @returns {string} a plain-English phrase; never '' and never `undefined`
   */
  function syncReasonPhrase(stopReason) {
    const key = typeof stopReason === 'string' ? stopReason.trim() : '';
    return SYNC_REASON_PHRASE[key] || SYNC_REASON_FALLBACK;
  }

  /** @param {string} text @returns {string} */
  function sentence(text) {
    const s = String(text || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  /**
   * Thousands separators without `Intl`, so "5,500" is spelled identically in
   * all three surfaces.
   *
   * @param {unknown} value
   * @returns {string} '' when not a finite number
   */
  function group(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    const rounded = Math.round(num);
    const sign = rounded < 0 ? '-' : '';
    const digits = String(Math.abs(rounded));
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * The first candidate that is a real, positive count; null when none is.
   *
   * @returns {number|null}
   */
  function firstPositive() {
    for (let i = 0; i < arguments.length; i++) {
      const n = Number(arguments[i]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  /**
   * Read the completeness contract out of any reply, flat or cursor-wrapped.
   * `SYNC_DONE` puts the fields at the top level, `SYNC_STATUS.cursor` puts them
   * one level down, and a worker that predates the contract sends none of them —
   * so every field is optional and a missing one yields null, never a throw and
   * never the string "undefined".
   *
   * @param {object|null|undefined} reply
   * @returns {object|null}
   */
  function readSyncFacts(reply) {
    if (!reply || typeof reply !== 'object') return null;
    const cursor = (reply.cursor && typeof reply.cursor === 'object') ? reply.cursor : null;
    // Present-but-`null` means "unknown", the same as absent: folding it in
    // would make `Number(null) === 0` render "Suno reports ~0".
    const pick = (key) => {
      if (reply[key] !== undefined && reply[key] !== null) return reply[key];
      const nested = cursor ? cursor[key] : undefined;
      return (nested !== undefined && nested !== null) ? nested : undefined;
    };
    /**
     * Whether the key is present AT ALL, `0` included — the only correct test for
     * "the worker told us". Needed because folding `null` into absent (right for
     * `expectedTotal`, whose `0` is a sentinel) is what makes a naive `> 0` test
     * discard a legitimate `0`.
     *
     * @param {string} key
     * @returns {boolean}
     */
    const has = (key) => {
      if (reply[key] !== undefined) return true;
      return !!(cursor && cursor[key] !== undefined);
    };

    const completed = pick('completed');
    const truncated = pick('truncated');
    const stopReason = pick('stopReason');
    const error = pick('error');
    const expected = Number(pick('expectedTotal'));
    // ABSENT and `0` are different facts and must not collapse; see the identical
    // note in `popup/popup.js`. `pick()` passes `0` through, so `has()` plus a
    // numeric coercion is the whole test.
    const missing = has('missing') && Number.isFinite(Number(pick('missing')))
      ? Number(pick('missing')) : null;
    // `totalSeen` is the contract name, but the STORED CURSOR counts the unique
    // clips it walked under `uniqueSeen` (and `GET_BOOT.sync` publishes that
    // name), so reading `totalSeen` alone yields 0 — and "Suno reports 0 of
    // ~5,500" over a 5,500-clip library is worse than showing no count. The first
    // POSITIVE of the two names wins; "no positive count" is reported as unknown.
    const totalSeen = firstPositive(pick('totalSeen'), pick('uniqueSeen'));
    // `expectedTotal === 0` is the worker's "Suno reported no count" sentinel.
    const expectedTotal = Number.isFinite(expected) && expected > 0 ? expected : null;

    return {
      // Did this reply say ANYTHING about completeness?
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
      // complete library. Re-deriving here made the dock print "1 clip is
      // missing" over a finished crawl — a banner hidden by `completed === true`
      // beside a status line reading INCOMPLETE. Deriving is the legacy-reply
      // fallback, for a key that is entirely absent.
      missing: missing !== null ? missing
        : (expectedTotal !== null && totalSeen !== null ? expectedTotal - totalSeen : null),
      // `oracleApplied === false` means crawl filters ran, so the counts are a
      // LOWER BOUND, not a shortfall. Optional: absent is unknown.
      oracleApplied: pick('oracleApplied') === false ? false : (pick('oracleApplied') === true ? true : null),
      // Mechanical evidence that a walk HAPPENED; the placeholder test needs it,
      // because `pagesDone:20` is proof of a real crawl even with no verdict.
      pagesDone: Number(pick('pagesDone')) || 0,
      total: Number(pick('total')) || 0
    };
  }

  /**
   * Write the contract onto `state.sync`, field by field, never with a blanket
   * assignment: a `SYNC_STATUS` poll that carries only `pagesDone` must not wipe
   * `expectedTotal` learned from `SYNC_DONE`. This is the "a later poll does not
   * erase the evidence" guarantee.
   *
   * @param {object|null|undefined} reply any sync reply
   * @returns {object|null} the facts that were read, or null
   */
  function applySyncFacts(reply) {
    const f = readSyncFacts(reply);
    if (!f) return null;
    // A PLACEHOLDER reply is not evidence about a walk. `SYNC_STATUS` returns one
    // before the first walk ever finishes — `completed:false` with no reason, no
    // error and every count at zero — and storing it would put this dock into
    // the INCOMPLETE state before the user had clicked anything.
    if (isPlaceholderSyncFacts(f)) return null;
    if (f.completed !== null) state.sync.completed = f.completed;
    if (f.truncated !== null) state.sync.truncated = f.truncated;
    state.sync.stopReason = f.stopReason || state.sync.stopReason || '';
    state.sync.lastError = f.error || '';
    if (f.expectedTotal !== null) state.sync.expectedTotal = f.expectedTotal;
    if (f.totalSeen !== null) state.sync.totalSeen = f.totalSeen;
    // `missing` is only overwritten by a reply that actually knows about the two
    // numbers behind it, so a status poll carrying neither cannot blank the
    // "5,100 missing" that `SYNC_DONE` established.
    if (f.missing !== null || f.expectedTotal !== null || f.totalSeen !== null) state.sync.missing = f.missing;
    // `0` is a real answer here too ("crawl filters ran, so these counts are a
    // lower bound"), so it must survive: the guard tests for `null`, not truth.
    if (f.oracleApplied !== null) state.sync.oracleApplied = f.oracleApplied;
    if (Array.isArray(reply.workspaces)) state.sync.workspaces = reply.workspaces;
    else if (Array.isArray(reply.cursor && reply.cursor.workspaces)) state.sync.workspaces = reply.cursor.workspaces;
    return f;
  }

  /**
   * @param {boolean} [exact] drop the "~"
   * @returns {string} '' when Suno's own count is unknown
   */
  function countsPhrase(exact) {
    const s = state.sync;
    if (s.expectedTotal === null || s.expectedTotal === undefined) return '';
    var expected = (exact ? '' : '~') + group(s.expectedTotal);
    var text = (s.totalSeen === null || s.totalSeen === undefined)
      ? expected : group(s.totalSeen) + ' of ' + expected;
    // `oracleApplied === false`: crawl filters ran, so Suno's count is a LOWER
    // BOUND on what the walk could reach, not a target it fell short of. Absent on
    // a legacy reply, and then nothing is added.
    return s.oracleApplied === false ? text + ' — a lower bound, filters applied' : text;
  }

  /**
   * TRUE while no walk has finished at all.
   *
   * `SYNC_STATUS` answers `completed:false, stopReason:null, error:null,
   * expectedTotal:0, totalSeen:0, missing:0` before the first walk completes, and
   * that is evidence that nothing ran, not evidence that something failed. The
   * dock polls `SYNC_STATUS` on mount, so without this the banner would greet a
   * fresh install with "Library INCOMPLETE". An explicit `truncated:true` is not a
   * placeholder, and neither is a record that walked a page or indexed a clip.
   *
   * @returns {boolean}
   */
  function isPlaceholderSyncState() {
    const s = state.sync;
    return isPlaceholderSyncFacts({
      completed: s.completed, stopReason: s.stopReason, error: s.lastError,
      truncated: s.truncated, pagesDone: s.pagesDone, total: s.total,
      totalSeen: s.totalSeen, expectedTotal: s.expectedTotal, missing: s.missing
    });
  }

  /**
   * The same test on freshly read facts. `expectedTotal:0` is the worker's "Suno
   * reported no count" sentinel, so it counts as empty here.
   *
   * @param {object|null} f
   * @returns {boolean}
   */
  function isPlaceholderSyncFacts(f) {
    if (!f) return false;
    // `truncated:true` is NOT a placeholder: that one really is a short walk,
    // and it is the only signal an older worker sends.
    return !f.completed && !f.stopReason && !f.error && f.truncated !== true &&
      !(f.pagesDone > 0) && !(f.total > 0) &&
      !(f.totalSeen > 0) && !(f.expectedTotal > 0) && !(f.missing > 0);
  }

  /**
   * The three-way decision, shared by the status line, the banner and the error
   * strip so the dock cannot say "done" over an incomplete index.
   *
   * THE RULE, AND IT IS THE WORKER'S CALL TO MAKE: when `completed` is present as
   * a BOOLEAN it is the verdict, and `missing` is NOT read to overturn it. The
   * worker computes `oracleApplied` (whether the walk was unfiltered, so that
   * `project.clip_count` measures the set the walk measured) and already ANDed it
   * into its own verdict, so a filtered walk's shortfall reaches us as ADVISORY:
   * `completed:true, stopReason:'complete', oracleApplied:false, missing:100`.
   * Re-deriving failure from `missing` on top of that re-created the permanent
   * "INCOMPLETE" this dock used to print over crawls the worker had called clean
   * — and it was wrong on every sync in this build, because `includeTrashed` is
   * hard-coded false in `background/background.js` and so `oracleApplied` never
   * is true here. The rule is stated once, here, and `syncIsIncomplete` below
   * obeys it.
   *
   * The legacy heuristics are kept, and only for state with NO `completed` key:
   * such a worker predates the oracle, so the counts are the only evidence there
   * is and they are correct for it.
   *
   * `truncated` remains the compatibility stand-in for `completed` and a bare
   * `stopReason: 'complete'` is believed, since it is the same statement.
   *
   * @returns {{kind:string, reason:string, error:string, counts:string,
   *   missing:number|null, stopReason:string}}
   */
  function syncVerdict() {
    const s = state.sync;
    // Nothing has ever finished walking the feed. That is a third state, not a
    // verdict: `completed:false` from a pre-walk poll is not a failed walk, and
    // rendering it as one put "INCOMPLETE" on a brand-new install.
    if (isPlaceholderSyncState()) {
      return { kind: 'none', reason: '', error: '', counts: '', missing: null, stopReason: '' };
    }
    let completed = s.completed;
    if (completed === null && typeof s.truncated === 'boolean') completed = s.truncated === false;
    if (completed === null && s.stopReason) completed = s.stopReason === 'complete';
    /* Whether the worker actually STATED a verdict, which is what the rule turns
     * on and which is deliberately NOT `completed === null`: a legacy reply that
     * carries `truncated:false` folds into a `true` on the two lines above, so the
     * fold cannot tell a reply with a verdict from a reply without one.
     * `applySyncFacts` writes `completed` only when the reply stated it, so
     * `null` here still means "this worker has never said". */
    const stated = typeof s.completed === 'boolean';
    const rawMissing = (typeof s.missing === 'number' && s.missing > 0) ? s.missing : null;
    /* `oracleApplied === false` says the worker did NOT check that number: the
     * walk was filtered, so the gap may be rows the filters removed on purpose
     * rather than rows the crawl missed. It still ships, in `countsPhrase`, with
     * the lower-bound caveat the worker asks for in `advisory`; what it must not
     * do is decide the verdict or be stated as "N clips are missing". `null` (a
     * legacy reply said nothing about the oracle) is not `false`. */
    const unchecked = s.oracleApplied === false;
    let kind;
    if (!stated) {
      // NO `completed` KEY AT ALL — a worker that predates the contract, and with
      // it the oracle. Only an explicit error, an explicit `truncated` or a
      // positive count makes it incomplete.
      kind = (s.lastError || s.truncated === true || rawMissing !== null)
        ? 'incomplete' : 'complete';
    } else {
      // `completed` is present, so it IS the verdict. `missing` is deliberately
      // not read here — see the rule above.
      kind = (completed === true && !s.lastError) ? 'complete' : 'incomplete';
    }
    return {
      kind: kind,
      reason: syncReasonPhrase(s.stopReason),
      error: s.lastError || '',
      // Exact for a checked complete walk ("5,500 of 5,500"); "~" is kept both for
      // an incomplete one and for a FILTERED one that finished, where
      // `expectedTotal` is Suno's unfiltered count over a filtered numerator and
      // is therefore approximate whatever the verdict says.
      counts: countsPhrase(kind === 'complete' && !unchecked),
      missing: unchecked ? null : rawMissing,
      stopReason: s.stopReason || ''
    };
  }

  /**
   * The banner's gate. `completed === false` is authoritative, `truncated` is
   * accepted for a worker that predates it, and a reply that says nothing about
   * completeness changes nothing. It obeys the same rule as `syncVerdict` above —
   * in particular `completed === true` is final, and `missing` decides nothing
   * once `completed` has spoken.
   *
   * @returns {boolean}
   */
  function syncIsIncomplete() {
    const s = state.sync;
    if (isPlaceholderSyncState()) return false;
    if (s.completed === false) return true;
    if (s.completed === true) return false;
    // ---- legacy replies only (no `completed` key). These predate the oracle,
    // so the counts are the only evidence there is.
    if (s.truncated === true) return true;
    if (s.stopReason && s.stopReason !== 'complete') return true;
    if (typeof s.expectedTotal === 'number' && typeof s.missing === 'number' && s.missing > 0) return true;
    return false;
  }

  /**
   * Clear everything the PREVIOUS run established, so a walk in progress cannot be
   * read through the last one's result.
   *
   * Shared by `startSync()` and the `SYNC_STARTED` push on purpose: a crawl
   * started from the popup or the side panel arrives here as exactly the same
   * fact, and a second copy of this reset is a second place for it to drift —
   * which is how the popup, this dock and the side panel came to disagree about
   * whether a library was complete. `running` and `maxPages` stay with the
   * callers, which are the ones that know them.
   */
  function resetSyncRun() {
    state.sync.truncated = false;
    state.sync.truncateDismissed = false;
    state.sync.pagesDone = 0;
    state.sync.seen = 0;
    state.sync.added = 0;
    state.sync.lastError = '';
    // The PREVIOUS run's verdict is cleared too. Leaving `completed:true` behind
    // would let a new run that dies before its first push still render as
    // complete — the exact "says done, is not done" failure being fixed here.
    state.sync.completed = null;
    state.sync.stopReason = '';
    state.sync.expectedTotal = null;
    state.sync.totalSeen = null;
    state.sync.missing = null;
    state.sync.workspaces = [];
    state.sync.lastErrorText = '';
  }

  /**
   * The shared sync vocabulary. Every surface shows the crawl in these words, and
   * each word says what is happening AND what happens next.
   *
   * Duplicated byte-for-byte in `popup/popup.js` and `side_panel.js` for the same
   * reason `SYNC_REASON_PHRASE` is: a content script and an extension page share no
   * module graph. They must change together.
   */
  const SYNC_VIEW_WORD = {
    checking: 'Checking whether a sync is running',
    active: 'Sync active',
    stopping: 'Sync stopping',
    stopped: 'Sync stopped',
    interrupted: 'Sync interrupted',
    unconfirmed: 'Stop requested',
    idle: 'Sync idle'
  };

  const SYNC_VIEW_NOTE = {
    checking: 'Checking with the worker whether a library sync is running. Sync stays unavailable until it answers.',
    active: 'A library sync is running. It indexes your Suno feed and downloads nothing.',
    stopping: 'Stopping the library sync. The worker checks for the stop between pages, so it ends after the current page finishes.',
    stopped: 'The library sync stopped. Nothing is broken and the clips already indexed are kept.',
    interrupted: 'The extension worker was stopped mid-crawl. Indexed clips are kept.',
    unconfirmed: 'The worker has not confirmed that the sync stopped. It checks for the stop between pages, so it ends after the current page finishes.',
    idle: 'No library sync is running.'
  };

  /** What THIS dock calls its two sync controls. See the note in popup/popup.js. */
  const SYNC_CONTROL = { start: 'Sync', stop: 'Stop sync' };

  /**
   * How long a stop request watches the worker before reaching a terminal state
   * anyway. Same bound the popup and the panel use; the abort is cooperative and a
   * rate-limit backoff can hold a page open for tens of seconds.
   */
  const SYNC_STOP_WAIT_MS = 20000;
  const SYNC_STOP_POLL_MS = 500;

  /**
   * Which of the seven shared states the dock is in.
   *
   * ONE function, because `state.sync.running` used to be written from six places
   * (`pollSyncStatus`, `startSync`, `applySyncProgress`, three push cases and the
   * `SYNC_CANCEL` reply) with no ordering between them, and the dock's own status
   * line could therefore read "running" while the popup said "Syncing" and the panel
   * still offered a live Sync. Everything below renders from this.
   *
   * @returns {'checking'|'active'|'stopping'|'stopped'|'interrupted'|'unconfirmed'|'idle'}
   */
  function syncView() {
    if (state.sync.stopUnconfirmed) return 'unconfirmed';
    if (state.sync.orphaned) return 'interrupted';
    if (state.sync.running) return state.sync.cancelling ? 'stopping' : 'active';
    if (state.sync.stopped) return 'stopped';
    if (!state.sync.statusKnown) return 'checking';
    return 'idle';
  }

  /**
   * Say the shared sentence for the current state, once per TRANSITION.
   *
   * `ui.syncAnnounce` is this dock's `role="status" aria-live="polite"` region. The
   * status line it mirrors (`#sm-sync-state`) is deliberately NOT a live region —
   * a `SYNC_PROGRESS` push lands several times a second and must not be read aloud —
   * so without this a crawl-state change would be invisible to a screen reader.
   */
  function announceSyncView() {
    const view = syncView();
    // `checking` is the absence of an answer; the failure path that produced it
    // says so itself rather than repeating it on every poll.
    if (view === 'checking') return;
    if (view === lastSyncView) return;
    lastSyncView = view;
    if (!ui.syncAnnounce) return;
    ui.syncAnnounce.textContent = SYNC_VIEW_NOTE[view];
  }

  let lastSyncView = '';

  /**
   * THE single reader of the worker's authoritative crawl state, in this file.
   *
   * `SYNC_STATUS` answers `{ok, running, interrupted, cancelRequested, cancelling,
   * cursor, …}` and the `SYNC_STARTED` / `SYNC_CANCEL_REQUESTED` / `SYNC_CANCELLED`
   * pushes carry the same booleans, so all of them come through here. The rule:
   *
   *   - an explicit boolean `running` OVERWRITES local state, in both directions;
   *   - anything WITHOUT one is not evidence about whether a crawl is in flight and
   *     leaves `state.sync.running` alone. `SYNC_PROGRESS` is the case that matters:
   *     the worker sends it with `state:'running'` and no `running` field, and
   *     `applySyncProgress` used to be read as proof that one existed.
   *
   * `statusKnown` is set only here, so the two Sync controls can tell "the worker
   * says nothing is running" from "this dock has not been told".
   *
   * @param {unknown} reply any reply or push that may carry `running`
   * @returns {boolean} true when the reply was authoritative and was applied
   */
  function applySyncAuthority(reply) {
    if (!reply || typeof reply !== 'object' || typeof reply.running !== 'boolean') return false;
    state.sync.statusKnown = true;
    state.sync.running = reply.running;
    state.sync.cancelling = reply.running === true
      && (reply.cancelRequested === true || reply.cancelling === true);
    if (reply.interrupted === true) {
      // A stored cursor with no controller behind it: an MV3 eviction, not a crawl.
      // `running` is the controller test, so the two cannot both be true.
      state.sync.running = false;
      state.sync.cancelling = false;
      state.sync.orphaned = true;
    } else if (reply.running === true) {
      state.sync.orphaned = false;
    }
    if (reply.running === true) {
      // A confirmed live crawl supersedes anything the dock was still showing about
      // the previous one, including a stop it never saw confirmed.
      state.sync.stopUnconfirmed = false;
      state.sync.stopped = false;
    }
    announceSyncView();
    return true;
  }

  /**
   * Ask the worker whether a crawl is in flight BEFORE starting one.
   *
   * THE guard that actually closes the duplicate-start window. Both Sync controls
   * are disabled while `state.sync.running`, but that is only what this dock has
   * been told, and a crawl can begin from the popup or the side panel between the
   * paint and the press. `pollSyncStatus()` is this dock's `SYNC_STATUS` read, so
   * the press is decided on the worker's own answer.
   *
   * @returns {Promise<{ok: boolean, reason: string}>} `reason` is the plain sentence
   *   to show when `ok` is false.
   */
  async function guardSyncStart() {
    const known = await pollSyncStatus();
    if (!known) {
      return {
        ok: false,
        reason: 'Could not ask the worker whether a library sync is already running, so nothing was started. Press Check status to try again.'
      };
    }
    if (state.sync.running) {
      return {
        ok: false,
        reason: state.sync.cancelling
          ? 'A library sync is already stopping. It ends after the current page finishes.'
          : 'A library sync is already running. Press ' + SYNC_CONTROL.stop + ' to end it, or wait for it to finish.'
      };
    }
    return { ok: true, reason: '' };
  }

  async function startSync(force) {
    const maxPages = num(ui.syncMaxPages ? ui.syncMaxPages.value : null);

    // ASK FIRST. See `guardSyncStart`.
    const guard = await guardSyncStart();
    if (!guard.ok) {
      toast(guard.reason, 6000);
      announceSyncView();
      renderSync();
      return;
    }

    resetSyncRun();
    if (maxPages !== null && maxPages > 0) state.sync.maxPages = Math.floor(maxPages);
    // An accepted `SYNC_START` is itself authoritative — the worker only answers
    // `ok:true` after attaching a controller and broadcasts `SYNC_STARTED` with
    // `running:true` as it does — so it goes through the one writer rather than
    // assigning `state.sync.running` here.
    applySyncAuthority({ running: true, cancelRequested: false });
    renderSync();

    // `SYNC_START` takes `dislikedMode` as 'include' | 'exclude' | 'both' and
    // silently falls back to the stored setting for anything else. The panel's
    // tri-state values are the same vocabulary the filter panel uses, so they are
    // mapped explicitly here instead of being forwarded verbatim (which is how
    // 'any' and 'only' used to be dropped on the floor):
    //   exclude -> 'exclude'  ONE walk, feed filtered to hide dislikes
    //   only    -> 'include'  ONE walk, feed filtered to the disliked rows only
    //   any     -> 'both'     TWO walks, and the only mode that pays double
    const choice = (ui.syncDisliked && ui.syncDisliked.value ? ui.syncDisliked.value : state.filters.disliked);
    const dislikedMode = choice === 'only' ? 'include' : (choice === 'exclude' ? 'exclude' : 'both');

    const res = await send('SYNC_START', {
      force: force === undefined ? !!(ui.syncForce && ui.syncForce.checked) : !!force,
      dislikedMode: dislikedMode,
      maxPages: maxPages === null ? 0 : maxPages
    });
    if (bail(res, 'SYNC_START')) {
      /* The start did NOT happen, so the optimistic claim above is withdrawn —
       * through the one writer, and followed by a re-read so the dock ends on the
       * worker's own answer rather than on "we assume it failed". */
      applySyncAuthority({ running: false, interrupted: false });
      state.sync.state = 'failed';
      void pollSyncStatus().catch(() => {});
      renderSync();
      return;
    }
    state.sync.state = 'running';
    // SYNC_START replies `{ok, force, dislikedMode, maxPages, total, state}`.
    if (typeof res.maxPages === 'number' && res.maxPages > 0) state.sync.maxPages = res.maxPages;
    if (typeof res.total === 'number') state.sync.total = res.total;
    renderSync();
  }

  async function cancelSync() {
    const res = await send('SYNC_CANCEL');
    if (bail(res, 'SYNC_CANCEL')) return;
    /* The worker's reply is a contract: `running` (was a controller attached),
     * `cancelRequested` (an abort was signalled), `abortAvailable` (there is
     * still something to signal). It carries a boolean `running` like every other
     * authority, so it goes through `applySyncAuthority` rather than being read
     * here and again in the three push cases. It used to carry only `{ok:true}`,
     * which is why this handler once set `cancelling` unconditionally — including
     * when no sync was running — and then never left that state, leaving the dock
     * stuck on "Cancelling…" with no exit. */
    applySyncAuthority(res);
    if (res.running === false && res.orphanedCursorCleared === true) {
      state.sync.state = 'interrupted';
      state.sync.stopped = false;
      state.sync.stopUnconfirmed = false;
      toast(res.stale === true
        ? 'Cleared a crawl the extension worker had abandoned. Indexed clips were kept.'
        : 'Cleared the stale sync state. Indexed clips were kept.');
      const after = await send('SYNC_STATUS');
      if (after && after.ok && after.cursor) applySyncCursor(after.cursor);
      announceSyncView();
      renderSync();
      return;
    }
    if (res.running === false) {
      state.sync.stopped = false;
      announceSyncView();
      toast('No sync is running.');
      renderSync();
      return;
    }
    state.sync.state = 'cancelling';
    announceSyncView();
    renderSync();

    /* WATCH THE WORKER, THEN REACH A TERMINAL STATE EITHER WAY.
     *
     * Aborting is cooperative, so the crawl observes the signal only where it
     * awaits and a rate-limit backoff can hold a page open. The loop ends on the
     * worker's own answer or when the bounded wait runs out — and on that second
     * outcome it does NOT leave `state.sync.running` true. The old code did, and
     * then set `state:'stopping'`, which left the dock showing a pulsing "running"
     * dot and a line saying "stopping · …" with nothing left able to end either.
     * Now the timeout sets `stopUnconfirmed`, which stops the claim of a live crawl
     * and paints a terminal, static line that names the next step. */
    const deadline = Date.now() + SYNC_STOP_WAIT_MS;
    let settled = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SYNC_STOP_POLL_MS));
      // `pollSyncStatus` is the dock's own reader, so every poll here also repaints
      // and keeps the phase and counters current.
      const known = await pollSyncStatus();
      // An unreadable status is not a stop; leave the claim alone and keep waiting
      // while the bounded wait still has time.
      if (known && !state.sync.running) {
        settled = true;
        break;
      }
    }
    const final = await send('SYNC_STATUS');
    if (final && final.ok) {
      applySyncAuthority(final);
      if (final.cursor) applySyncCursor(final.cursor);
    }
    if (settled) {
      state.sync.state = 'cancelled';
      state.sync.stopped = true;
      state.sync.stopUnconfirmed = false;
      toast('Sync stopped. Nothing is broken.');
    } else {
      // Re-enabling Start sync is safe: `guardSyncStart` re-reads `SYNC_STATUS`
      // before sending anything, so a press cannot start a second crawl over an
      // unconfirmed one — it is refused in words instead.
      applySyncAuthority({ running: false, interrupted: false });
      state.sync.state = 'stopping';
      state.sync.stopUnconfirmed = true;
      toast('Stop requested. The worker has not confirmed the sync stopped; it checks between pages, '
        + 'so it ends after the current page finishes.', 7000);
    }
    announceSyncView();
    renderSync();
  }

  /**
   * The dock's read of the worker's `SYNC_STATUS` — the ONE place here that
   * decides whether a crawl is in flight.
   *
   * It RETURNS whether it got an authoritative answer, which is what lets
   * `guardSyncStart` and `cancelSync` treat "the worker says nothing is running"
   * differently from "the worker could not be asked". The previous version caught
   * every failure and returned nothing at all, so a failed read left the dock
   * believing nothing was running — with a live Start sync button.
   *
   * @returns {Promise<boolean>} true when the worker answered
   */
  async function pollSyncStatus() {
    // `send()` never rejects: a transport failure comes back as `{ok:false,…}` and
    // `bail` is the single funnel for it. So the only two outcomes here are "the
    // worker answered" and "it did not", and the return value is what tells them
    // apart.
    const res = await send('SYNC_STATUS');
    if (bail(res, 'SYNC_STATUS')) {
      // `statusKnown` is deliberately untouched by the failure branch above: an
      // unanswered question is not an answer, and the dock must not offer to start
      // a crawl over one. `Check status` and `onSurfaceFocus` ask again.
      renderSync();
      return false;
    }
    /* THE AUTHORITY. `applySyncCursor` is the MAPPING of the cursor onto the
     * fields `applySyncProgress` expects — `running` and `total` are genuinely TOP
     * level and everything else lives under `cursor` — and the previous version read
     * `res.pagesDone` / `res.seen` / `res.added` / `res.etaMs` / `res.state`, every
     * one of which is `undefined`, so "Check status" updated nothing at all. */
    applySyncCursor(res.cursor);
    /* A stored `state:'running'` with no live controller is an ORPHANED cursor — an
     * MV3 worker eviction, not a crawl. `SYNC_STATUS` reconciles it and reports
     * `interrupted`, and `applySyncAuthority` turns that into `orphaned` with
     * `running` false, which is what stops the dock showing a frozen "running" dot
     * beside a Stop button that truthfully says nothing is running. */
    applySyncAuthority(res);
    if (state.sync.orphaned) {
      state.sync.state = 'interrupted';
      renderSync();
      return true;
    }
    if (!state.sync.running) {
      const cursorState = res.cursor && res.cursor.state ? String(res.cursor.state) : '';
      if (cursorState) state.sync.state = cursorState;
    } else {
      state.sync.state = 'running';
    }
    if (typeof res.truncated === 'boolean') state.sync.truncated = res.truncated;
    if (typeof res.total === 'number') state.sync.total = res.total;
    // `completed` / `stopReason` / `expectedTotal` / `missing` / `workspaces` are
    // stored by `applySyncCursor` above, field by field, so this poll cannot wipe
    // them. Optional here too: a worker that predates the contract sends none of
    // them and the dock simply keeps whatever it already knew.
    if (!state.sync.running) stopSyncPoll();
    renderSync();
    scheduleSyncPoll();
    return true;
  }

/**
 * One poller for the dock, and it runs ONLY while a crawl is in flight.
 *
 * WHY: three surfaces render this crawl — the toolbar popup, this dock and the side
 * panel — and each used to keep its own idea of "is a sync running, and how far
 * along". They disagreed: the popup said "Syncing" while the dock said idle and Stop
 * said nothing was running. The worker's `SYNC_STATUS` is the only authority, so
 * every surface polls it and derives everything from that reply. Idle-gated, so a
 * crawl that is not running costs nothing.
 *
 * `SYNC_PROGRESS` is the one caller that must NOT be able to arm this, and it cannot:
 * the gate is `state.sync.running`, which only an authoritative reply writes. That is
 * why a push that arrives at a dock which believes nothing is running does not leave
 * it polling a crawl it has no evidence exists.
 */
let syncPollTimer = 0;
const SYNC_POLL_MS = 1500;

function scheduleSyncPoll() {
  if (syncPollTimer) return;
  if (!state.sync.running) return;
  syncPollTimer = setInterval(() => {
    // The push is the fast path; the poll is the correction. Both write the same
    // fields from the same worker reply, so neither can leave the dock stale.
    if (!state.sync.running) {
      stopSyncPoll();
      return;
    }
    void pollSyncStatus();
  }, SYNC_POLL_MS);
}

  function stopSyncPoll() {
    if (!syncPollTimer) return;
    clearInterval(syncPollTimer);
    syncPollTimer = 0;
  }

  /**
   * Map the worker's crawl cursor onto the fields `applySyncProgress` expects.
   *
   * `SYNC_STATUS` returns `{ok, running, cursor, truncated, total}`, where the
   * cursor is the record `runSync` writes to `syncState.feed`. Its field names are
   * the crawl's, not the push's, so they are mapped here explicitly:
   * `pagesDone -> pagesDone`, `totalSeen -> seen`, `state -> state`.
   * The cursor carries no `added` and no ETA (those only exist in the live
   * `SYNC_PROGRESS` push), so those are simply left untouched rather than invented.
   *
   * There is deliberately NO page number here. The crawl is cursor-based and
   * `nextPage` is permanently `null` — the worker advances an opaque feed cursor —
   * so the old `page: cursor.nextPage` mapping fed `null` into `applySyncProgress`,
   * whose `typeof p.page === 'number'` guard dropped it, and the dock's "page N"
   * indicator could only ever update from the live push. Progress is read from
   * `pagesDone`/`totalSeen` instead; see `renderSync`.
   *
   * @param {object|null} cursor
   * @returns {boolean} whether a usable cursor was mapped
   */
  function applySyncCursor(cursor) {
    if (!cursor || typeof cursor !== 'object') return false;
    applySyncProgress({
      pagesDone: cursor.pagesDone,
      // `seen` accepts either name: the contract says `totalSeen`, the stored row
      // counts unique clips under `uniqueSeen`. Reading only `totalSeen` left the
      // dock saying "0 seen" beside "400 indexed" — which is what the user was
      // shown when the whole library was indexed.
      seen: firstPositive(cursor.totalSeen, cursor.uniqueSeen) || 0,
      state: cursor.state
    });
    if (typeof cursor.maxPages === 'number' && cursor.maxPages > 0) {
      // Real, not guessed: this is the cap that produced the truncation, which is
      // what the banner's "bigger cap" action doubles.
      state.sync.maxPages = cursor.maxPages;
    }
    // The completeness fields, stored FIELD BY FIELD. Assigning the whole cursor
    // here would be the bug the old code had: a later poll that carried only
    // `pagesDone` would drop `expectedTotal`, and "400 indexed · Suno reports
    // ~5,500" — the single most useful string this dock can show — would vanish
    // on the next status check.
    applySyncFacts(cursor);
    // The phase, read from the SAME reply the rest of the cursor comes from, so
    // the dock and the popup cannot disagree about what the crawl is doing. The
    // crawl pages `/api/project/me` and `/api/project/feed` (~180 pages) before it
    // indexes anything, and without this the dock said "starting" throughout.
    if (typeof cursor.phase === 'string' && cursor.phase) state.sync.phase = cursor.phase;
    if (Number.isFinite(Number(cursor.phasePagesDone))) state.sync.phasePages = Number(cursor.phasePagesDone);
    if (Number.isFinite(Number(cursor.phaseJoined))) state.sync.phaseJoined = Number(cursor.phaseJoined);
    return true;
  }

  /**
   * Fold a live `SYNC_PROGRESS` push. There is NO page field: the crawl is
   * cursor-based, so a "page N" reading would be a fabrication. What a progress
   * push genuinely carries is pages done, clips seen, clips added and an ETA.
   *
   * IT CANNOT RAISE `running`. The worker sends this push with `state:'running'` and
   * no `running` field, so under the rule in `applySyncAuthority` it is not evidence
   * that a crawl exists; taking it as proof is how the dock could claim a crawl while
   * the popup started one. `state:'cancelling'` is likewise not read here — the
   * worker's `cancelRequested` on an authoritative reply is what sets `cancelling`.
   * The only direction this may move the answer is DOWN, and only for a terminal
   * label, because a progress push is never how a crawl ends.
   *
   * @param {object|null} p
   */
  function applySyncProgress(p) {
    if (!p) return;
    if (typeof p.pagesDone === 'number') state.sync.pagesDone = p.pagesDone;
    if (typeof p.seen === 'number') state.sync.seen = p.seen;
    if (typeof p.added === 'number') state.sync.added = p.added;
    if (typeof p.etaMs === 'number') state.sync.etaMs = p.etaMs;
    if (typeof p.phase === 'string' && p.phase) state.sync.phase = p.phase;
    if (Number.isFinite(Number(p.phasePagesDone))) state.sync.phasePages = Number(p.phasePagesDone);
    if (Number.isFinite(Number(p.phaseJoined))) state.sync.phaseJoined = Number(p.phaseJoined);
    if (p.state && p.state !== 'running' && p.state !== 'cancelling') {
      state.sync.state = String(p.state);
      // Terminal by label, so the local claim of a live crawl is withdrawn. The
      // authoritative confirmation still comes from `SYNC_STATUS` or a terminal
      // push; this only stops the dock asserting something it can no longer justify.
      state.sync.running = false;
      state.sync.cancelling = false;
      state.sync.stopped = String(p.state) === 'cancelled';
    }
  }

  function fmtEta(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const s = Math.round(n / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  }

  function renderSync() {
    if (!ui.syncState) return;
    const s = state.sync;
    const verdict = syncVerdict();
    const view = syncView();
    /* THE SHARED STATE WORD, FIRST. This line used to open with a bare
     * `s.running ? 'running' : (s.state || 'idle')`, which meant three things at
     * once: it printed the worker's lifecycle slug while a crawl was live, it
     * printed that same slug again the moment `running` went false, and it had no
     * word at all for "stopping" or "I have not asked yet". One derived view means
     * the dock says what the popup and the panel say, for one crawl. */
    const parts = [SYNC_VIEW_WORD[view] || SYNC_VIEW_WORD.idle];
    // WHICH PHASE, because it is the fact that explains the numbers below.
    // A sync pages `/api/project/me` and then `/api/project/feed` (~180 pages at
    // 30 rows) before it indexes a single clip, so "0 pages done · 0 seen" for
    // minutes was the dock correctly reporting a crawl that had not reached the
    // indexing phase yet — while looking, to the user, like a hung extension.
    if (s.running && s.phase) {
      if (s.phase === 'planning') parts.push('listing your workspaces');
      else if (s.phase === 'mapping') {
        parts.push('mapping clips to workspaces'
          + (s.phasePages ? ' · ' + s.phasePages + ' pages' : '')
          + (s.phaseJoined ? ' · ' + s.phaseJoined + ' joined' : '')
          + ' · no clips indexed yet');
      } else if (s.phase === 'crawling') parts.push('crawling your library');
      else if (s.phase === 'committing') parts.push('writing the index');
      else parts.push(s.phase);
    }
    if (view === 'stopping') {
      // What happens next, in the same place the state is named.
      parts.push('the worker checks between pages, so it ends after the current page finishes');
      ui.syncState.textContent = parts.join(' · ');
    } else if (view === 'unconfirmed') {
      /* TERMINAL, AND DELIBERATELY NOT ANIMATED. A stop was requested, the bounded
       * wait expired and the worker never confirmed the crawl ended. Asserting
       * "running" here is how the dock kept a pulsing dot and a "stopping" line with
       * nothing left able to stop either; asserting "stopped" would be a claim the
       * worker has not made. So it names the one thing that is true and points at
       * the next step. */
      parts.push('the worker checks between pages, so it ends after the current page finishes',
        SYNC_CONTROL.start + ' reads the worker before it starts anything');
      ui.syncState.textContent = parts.join(' · ');
    } else if (view === 'interrupted') {
      parts.push('indexed clips were kept — press ' + SYNC_CONTROL.start + ' to resume');
      ui.syncState.textContent = parts.join(' · ');
    } else {
      // No "page N": the crawl is cursor-based and has no page number to report.
      // `pagesDone` against the cap is the honest progress reading.
      if (s.pagesDone) parts.push(s.pagesDone + (s.maxPages ? ' of ' + s.maxPages : '') + ' pages done');
      parts.push(s.seen > 0 ? s.seen + ' seen' : 'clips seen —');
      if (s.added) parts.push(s.added + ' added');
      // How many clips are actually indexed on disk — the number the user cares
      // about — and what Suno says it has. "400 indexed · Suno reports ~5,500" is
      // the single most valuable string this dock can show: it makes a broken sync
      // obvious at a glance, with no log and no inference, because the index can
      // never be more complete than the smaller of the two numbers.
      const counts = verdict.counts;
      if (s.total) {
        parts.push(counts ? (s.total + ' indexed · Suno reports ' + counts) : (s.total + ' indexed'));
      } else if (counts) {
        parts.push('Suno reports ' + counts);
      }
      if (verdict.missing !== null) parts.push(group(verdict.missing) + ' missing');
      // The outcome is a WORD, never only a colour: "complete" / "incomplete" /
      // "cancelled" is what a screen reader announces and what a colour-blind user
      // reads, so the amber `sm-warn` banner below is decoration on top of this.
      if (s.stopReason) parts.push(verdict.reason);
      else if (verdict.kind === 'incomplete' && !s.running) parts.push('INCOMPLETE');
      parts.push('eta ' + fmtEta(s.etaMs));
      ui.syncState.textContent = parts.join(' · ');
    }

    const fill = ui.syncBar ? ui.syncBar.firstChild : null;
    if (fill) {
      // The bar shows REAL completeness, never a decorative number. While the walk
      // runs the only meaningful fraction is pages against the cap. Once it stops
      // the crawl fraction is meaningless (a cursor walk has no target page), so
      // the bar reports the fraction of Suno's count that was actually reached —
      // full on a complete walk, the true shortfall on an incomplete one. The old
      // `state === 'done' ? 60 : 0` painted 60% over an INCOMPLETE library, a
      // number that corresponded to nothing the user could see.
      let pct = 0;
      if (s.running) {
        const denom = s.maxPages > 0 ? s.maxPages : 0;
        pct = denom ? Math.min(100, Math.round((s.pagesDone / denom) * 100)) : 0;
      } else if (verdict.kind === 'complete') {
        pct = 100;
      } else if (typeof s.totalSeen === 'number' && s.totalSeen > 0 &&
                 typeof s.expectedTotal === 'number' && s.expectedTotal > 0) {
        pct = Math.max(0, Math.min(100, Math.round((s.totalSeen / s.expectedTotal) * 100)));
      }
      // An unconfirmed stop is not a measurement, so the bar is emptied rather than
      // left showing the last crawl fraction — a bar implies a completeness nobody
      // has confirmed.
      if (view === 'unconfirmed' || view === 'stopping') pct = 0;
      fill.style.width = pct + '%';
      // The bar is decorative: `aria-hidden` keeps a screen reader from reading a
      // bare percentage, while the status line above it already states the
      // counts, the reason and the word INCOMPLETE.
      if (ui.syncBar) ui.syncBar.setAttribute('aria-hidden', 'true');
    }
    const dot = ui.syncChip ? ui.syncChip.firstChild : null;
    /* `done` is NOT `ok`: a walk that died on page 21 also sets `state:'done'`. And
     * the PULSE follows `view`, not `s.running` alone, because the pulse is the
     * "there is live work" signal and `unconfirmed` has no live work behind it. */
    const pulsing = view === 'active' || view === 'stopping';
    if (dot) dot.className = 'sm-sync-dot ' + (pulsing ? 'run' : (verdict.kind === 'complete' ? 'ok' : ''));
    if (ui.syncChip && ui.syncChip.lastChild) {
      ui.syncChip.lastChild.textContent = pulsing
        ? (view === 'stopping' ? 'stopping' : 'running')
        : (verdict.kind === 'complete'
          ? (s.lastDurationMs ? Math.round(s.lastDurationMs / 1000) + 's' : 'synced')
          : (verdict.kind === 'incomplete' ? 'incomplete' : (s.state || 'not synced')));
    }

    const incomplete = syncIsIncomplete();
    if (ui.truncWarn) {
      if (ui.truncTitle) {
        ui.truncTitle.textContent = s.stopReason === 'aborted'
          ? 'Sync cancelled by you — the index is INCOMPLETE. '
          : 'Library INCOMPLETE — the last sync stopped early. ';
      }
      const detail = ui.truncWarn.querySelector('.sm-trunc-detail');
      if (detail) {
        detail.textContent = [
          sentence(verdict.reason) + (verdict.error ? ' (' + verdict.error + ')' : ''),
          counts ? 'Indexed ' + counts : '',
          verdict.missing !== null
            ? group(verdict.missing) + ' ' + (verdict.missing === 1 ? 'clip is' : 'clips are') + ' missing'
            : '',
          s.pagesDone ? s.pagesDone + (s.pagesDone === 1 ? ' page crawled' : ' pages crawled') : '',
          s.stopReason === 'max_pages'
            ? 'Raise the page cap and sync again, or lower it if this was deliberate.'
            : ''
        ].filter(Boolean).join(' · ');
      }
      // The cap button is the honest advice ONLY when the cap is what stopped
      // the walk. After a failed request it is a red herring, so it is removed
      // from the flow entirely rather than merely disabled — a control that is
      // visible but wrong is the defect being fixed here.
      //
      // `style.display`, NOT the `hidden` attribute: `.sm-btn` is an author rule
      // with `display: inline-flex`, and an author declaration beats the user
      // agent's `[hidden] { display: none }` regardless of specificity. Setting
      // `hidden` here would leave the button visible in Chrome while every DOM
      // assertion (and every test) said otherwise.
      if (ui.truncCapBtn) ui.truncCapBtn.style.display = s.stopReason === 'max_pages' ? '' : 'none';
      if (ui.truncRetryBtn) ui.truncRetryBtn.style.display = s.stopReason === 'max_pages' ? 'none' : '';
      // A dismissal is session-scoped: routine status polls must not resurrect it.
      ui.truncWarn.classList.toggle('on', incomplete && !s.truncateDismissed);
    }
    paintSyncControls(view);
  }

  /**
   * The two Sync controls, from state only.
   *
   * NEVER OFFER A START WHILE SOMETHING IS RUNNING, AND ALWAYS SAY WHY. Three
   * distinguishable reasons can disable a start here and a disabled control with no
   * explanation is indistinguishable from a broken one, so each is spelled out:
   *
   *   `s.running`          a crawl is in flight, quite possibly started from the
   *                        popup or the side panel. THIS is the reported defect: the
   *                        dock said "running" while a sibling surface still offered
   *                        a live Start sync, and one click there started a second
   *                        crawl. `startSync()` also re-reads `SYNC_STATUS` before
   *                        sending, so the press itself is decided by the worker.
   *   `!s.statusKnown`     this dock has not been told anything yet, so it keeps
   *                        every start disabled rather than enabling on "I have not
   *                        been told" — which is the state a crawl started elsewhere
   *                        leaves a freshly-mounted dock in.
   *
   * @param {string} view the value `syncView()` returned, passed in so the caller
   *   and this cannot read it at different moments.
   */
  function paintSyncControls(view) {
    const starts = [ui.syncBtn, ui.syncStartBtn].filter(Boolean);
    /* NOT `orphaned`. A stored cursor with no controller is not a live crawl — it is
     * a record — and the worker starts a fresh walk over it without complaint, so
     * blocking a start there would be refusing to do something the extension can do.
     * The dock's own affordance for that record stays the "Clear stale sync" button
     * below, which `startSync()` leaves alone. */
    const blocked = state.sync.running || !state.sync.statusKnown;
    for (const node of starts) {
      node.disabled = blocked;
      node.textContent = (view === 'active' || view === 'stopping')
        ? SYNC_VIEW_WORD[view]
        : SYNC_CONTROL.start;
      node.title = state.sync.running
        ? SYNC_VIEW_NOTE.active + ' It may have been started from the popup or the side panel. '
          + 'Press ' + SYNC_CONTROL.stop + ' to end it, or wait for it to finish.'
        : (!state.sync.statusKnown
          ? 'Asking the worker whether a library sync is already running. '
            + SYNC_CONTROL.start + ' stays unavailable until it answers, so a second crawl cannot be started from here.'
          : (state.sync.orphaned
            ? SYNC_VIEW_NOTE.interrupted + ' Press ' + SYNC_CONTROL.start + ' to resume.'
            : 'Crawl your Suno feed into the local index. Nothing is downloaded and no downloads are spent.'));
      // The accessible name is the text, so the state word above is what a screen
      // reader reads; the reason goes into the label so it is not sighted-only.
      node.setAttribute('aria-label', node.disabled
        ? (SYNC_CONTROL.start + ', unavailable: ' + node.title)
        : (SYNC_CONTROL.start + '. ' + node.title));
    }
    if (ui.syncCancelBtn) {
      // Enabled for a live crawl AND for an interrupted record: an orphaned cursor
      // needs clearing, so hiding this would show a frozen "Sync interrupted" with
      // no way out of it.
      ui.syncCancelBtn.disabled = !(state.sync.running || state.sync.orphaned);
      ui.syncCancelBtn.textContent = state.sync.orphaned
        ? 'Clear stale sync'
        : (view === 'stopping' ? 'Stopping' : SYNC_CONTROL.stop);
      ui.syncCancelBtn.title = view === 'stopping'
        ? SYNC_VIEW_NOTE.stopping
        : (state.sync.orphaned
          ? 'Clear the interrupted crawl record. Indexed clips are kept.'
          : 'Ask the worker to end the running library sync.');
    }
  }

  /**
   * `SYNC_DONE` — store the contract on `state.sync` BEFORE rendering, so a
   * later `SYNC_STATUS` poll (which may carry none of these fields) cannot wipe
   * it, and so the banner, the status line and the toast all read one object.
   *
   * @param {object} m
   */
  function onSyncDone(m) {
    // Terminal, and through the one writer (the push case already applied it; this
    // is the same claim restated so the function is honest when called directly).
    applySyncAuthority({ running: false, interrupted: false });
    state.sync.stopped = typeof m.stopReason === 'string' && m.stopReason.trim() === 'aborted';
    if (typeof m.total === 'number') state.sync.total = m.total;
    state.sync.seen = typeof m.total === 'number' ? m.total : state.sync.seen;
    state.sync.added = typeof m.total === 'number' ? m.total : state.sync.added;
    state.sync.lastDurationMs = Number(m.durationMs) || 0;
    state.sync.lastProjects = Number(m.projects) || 0;
    applySyncFacts(m);

    const verdict = syncVerdict();
    // `state` is the worker's own lifecycle label, trusted when present. The
    // `done` fallback used to be unconditional, which asserted success over an
    // INCOMPLETE crawl; it now follows the verdict, so the one case with no
    // worker label at all cannot claim a finished walk that did not happen.
    state.sync.state = typeof m.state === 'string' && m.state
      ? m.state
      : (verdict.kind === 'complete' ? 'done' : (verdict.stopReason === 'aborted' ? 'cancelled' : 'incomplete'));
    renderSync();

    if (verdict.kind === 'complete') {
      // Clear OUR strip, and only ours: `showError(null)` would write the string
      // "null" into the strip, and a blanket clear would wipe an unrelated
      // failure the user still needs to read. A successful re-sync must be able
      // to retract the incompleteness warning it just disproved.
      if (ui.errorStrip && state.sync.lastErrorText &&
          ui.errorStrip.textContent === state.sync.lastErrorText) clearError();
      state.sync.lastErrorText = '';
      toast('Sync complete: ' + state.sync.seen + ' clips' +
        (state.sync.lastProjects ? ' across ' + state.sync.lastProjects + ' projects' : ''));
    } else if (verdict.stopReason === 'aborted') {
      toast('Sync cancelled — nothing is broken.', 4000);
    } else {
      const counts = countsPhrase(false);
      const why = sentence(verdict.reason) + (verdict.error ? ' (' + verdict.error + ')' : '') + '.';
      const text = 'Sync stopped early — the index is INCOMPLETE: ' + why +
        (counts ? ' Indexed ' + counts + '.' : '') +
        (verdict.missing !== null
          ? ' ' + group(verdict.missing) + ' ' + (verdict.missing === 1 ? 'clip is' : 'clips are') + ' missing.'
          : '') +
        (verdict.stopReason === 'max_pages'
          ? ' Raise the page cap and sync again.'
          : ' Sync again to finish the crawl.');
      state.sync.lastErrorText = text;
      showError(text);
      toast(verdict.stopReason === 'max_pages'
        ? 'Sync stopped at your page cap: ' + state.sync.seen + ' clips indexed.'
        : 'Sync stopped early: ' + state.sync.seen + ' clips indexed, index INCOMPLETE.', 6000);
    }
    refreshResults(true);
    refreshFacets();
    loadProjects();
  }

  /**
   * `SYNC_ERROR` — a hard failure is an INCOMPLETE index, and it is applied
   * through `applySyncFacts` for the same reason `SYNC_DONE` is: the contract has
   * to reach `state.sync`, which is what `renderSync` reads.
   *
   * The old handler set only `state.sync.state = 'error'` and showed a strip.
   * `state.sync.completed` kept its previous value, so a run that had previously
   * SUCCEEDED still rendered the green `ok` dot and the word `synced` sitting
   * beside a strip reading "Sync failed" — two opposite claims, one node apart.
   *
   * The contract is synthesised from the push (`completed:false` plus the worker's
   * own reason, error and counts) rather than invented: `readSyncFacts` reads
   * `expectedTotal` / `totalSeen` / `missing` straight off the message when it
   * sends them, and a legacy push that sends none simply leaves the counts alone.
   * Same shape as `side_panel.js`'s `SYNC_ERROR` case.
   *
   * @param {object} m
   */
  function onSyncError(m) {
    // Terminal for the same reason as `SYNC_DONE`, and through the same writer.
    applySyncAuthority({ running: false, interrupted: false });
    state.sync.stopped = false;
    const message = (m && m.error) ? String(m.error) : 'unknown sync error';
    const stopReason = (m && typeof m.stopReason === 'string' && m.stopReason.trim())
      ? m.stopReason.trim() : 'page_failed';
    applySyncFacts(Object.assign({}, m || {}, {
      completed: false,
      stopReason: stopReason,
      error: message,
      state: 'error'
    }));
    state.sync.state = 'error';
    // A failure is a stop the user did not ask for, so the amber banner shows it
    // too — the same three-way decision the status line and the strip now share.
    renderSync();
    const counts = countsPhrase(false);
    const text = 'Sync failed — the index is INCOMPLETE: ' + sentence(syncReasonPhrase(stopReason)) +
      (message ? ' (' + message + ')' : '') + '.' +
      (counts ? ' Indexed ' + counts + '.' : '') +
      ' Sync again to finish the crawl.';
    state.sync.lastErrorText = text;
    showError(text);
    toast('Sync failed: ' + message, 6000);
  }

  /* ================================================================== *
   * 15. facets + projects
   * ================================================================== */

  async function refreshFacets() {
    const res = await send('GET_FACETS');
    if (bail(res, 'GET_FACETS')) return;
    state.facets = res.facets || res.data || res;
    renderModelFacets();
    renderProjectList();
    renderGenres();
    if (ui.dateFrom && !ui.dateFrom.min) {
      const f = state.facets;
      if (f && (f.createdMin || f.createdMax)) {
        ui.dateFrom.min = msToDay(f.createdMin);
        ui.dateTo.max = msToDay(f.createdMax);
      }
    }
  }

  async function loadProjects() {
    const res = await send('GET_PROJECTS');
    if (bail(res, 'GET_PROJECTS')) return;
    const list = firstArray(res, ['projects', 'items', 'data']);
    const fEngine = F();
    const defId = (fEngine && fEngine.DEFAULT_PROJECT_ID) || 'default';
    const out = [];
    const seen = {};
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      if (typeof p === 'string') { out.push({ id: p, name: p === defId ? 'My Workspace' : p }); continue; }
      const id = String(p.id || p.project_id || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, name: id === defId ? 'My Workspace' : String(p.name || p.title || id) });
    }
    if (!seen[defId]) out.unshift({ id: defId, name: 'My Workspace' });
    state.projects = out;
    renderProjectList();
  }

  function renderGenres() {
    if (!ui.genreRow) return;
    clear(ui.genreRow);
    const f = state.facets;
    if (!f || !Array.isArray(f.genres) || !f.genres.length) return;
    for (let i = 0; i < f.genres.length && i < 40; i++) {
      const token = String(f.genres[i]);
      ui.genreRow.appendChild(h('button', {
        type: 'button',
        class: 'sm-chip sm-chip-genre',
        text: token,
        title: 'Append style:"' + token + '" to the search box (metadata.tags / metadata.style)',
        onclick: () => {
          const add = 'style:"' + token.replace(/"/g, '') + '"';
          const cur = state.filters.query.trim();
          state.filters.query = cur ? cur + ' ' + add : add;
          if (ui.queryInput) ui.queryInput.value = state.filters.query;
          schedulePersist();
          onFiltersChanged();
        }
      }));
    }
  }

  /* ================================================================== *
   * 16. downloads
   * ================================================================== */

  function downloadPayload(spec, ids) {
    const p = {
      variant: state.settings.variant,
      source: state.settings.sourceLadder[0] || 'media',
      tagOptions: clone(state.settings.tagOptions),
      overwrite: !!state.settings.overwrite,
      dryRun: !!state.settings.dryRun,
      filenameTemplate: state.settings.filenameTemplate,
      sourceLadder: state.settings.sourceLadder.slice()
    };
    if (ids && ids.length) p.ids = ids.slice();
    else if (spec) p.spec = spec;
    return p;
  }

  async function startDownload(selectionOnly) {
    let payload;
    if (selectionOnly) {
      if (!state.selection.size) { toast('No rows selected'); return; }
      payload = downloadPayload(null, Array.from(state.selection));
    } else {
      payload = downloadPayload(specForRequest());
    }
    if (state.settings.dryRun) toast('Dry run: the SW will plan only');
    resetBatch();
    state.batch.lastPayload = payload;
    state.batch.running = true;
    renderBatch();
    const res = await send('DOWNLOAD_START', payload);
    if (bail(res, 'DOWNLOAD_START')) {
      state.batch.running = false;
      renderBatch();
      return;
    }
    if (res.batchId) state.batch.batchId = String(res.batchId);
    if (typeof res.total === 'number') state.batch.total = res.total;
    if (typeof res.planned === 'number') state.batch.total = res.planned;
    toggleDrawer('batch', true);
    renderBatch();
    reportQuotaShortfall(res);
  }

  async function downloadIds(ids) {
    const payload = downloadPayload(null, ids);
    resetBatch();
    state.batch.lastPayload = payload;
    state.batch.running = true;
    const res = await send('DOWNLOAD_START', payload);
    if (bail(res, 'DOWNLOAD_START')) {
      state.batch.running = false;
      renderBatch();
      return;
    }
    if (res.batchId) state.batch.batchId = String(res.batchId);
    if (typeof res.planned === 'number') state.batch.total = res.planned;
    toggleDrawer('batch', true);
    renderBatch();
    reportQuotaShortfall(res);
  }

  /**
   * `DOWNLOAD_START` can refuse to run anything and still answer `ok:true`: the
   * quota preflight sets `stopped:'quota'` with a `quotaShortfall` block and no batch
   * ever starts. Ignoring that left the drawer claiming a download was running with
   * nothing happening, so it is surfaced as the warning it is.
   *
   * @param {object} res the DOWNLOAD_START reply
   */
  function reportQuotaShortfall(res) {
    const short = (res && res.quotaShortfall) || null;
    if (!short || res.stopped !== 'quota') return;
    const fits = typeof short.fits === 'number' ? short.fits : null;
    const needed = typeof short.needed === 'number' ? short.needed : state.batch.total;
    state.batch.running = false;
    state.batch.stoppedReason = 'quota';
    state.batch.remaining = needed;
    renderBatch();
    renderBatchStop('warn', [
      h('b', { text: 'Nothing was downloaded — the monthly allowance is already spent. ' }),
      document.createTextNode(short.message
        || ('This batch needs ' + needed + ' downloads and only ' + (fits === null ? 'none' : fits) + ' remain.')),
      h('div', { class: 'sm-warn-actions' }, [
        btn('Re-run this selection', () => restartBatch(), 'warn'),
        btn('Dismiss', () => renderBatchStop(null, []), 'ghost')
      ])
    ]);
    toast('Download quota shortfall: nothing was started', 7000);
  }

  /**
   * Re-send the exact payload of the last batch. This is the only honest recovery
   * from a quota stop: `DOWNLOAD_RETRY_FAILED` only re-plans rows the worker marked
   * FAILED, and the clips left unattempted by a quota halt have no such row. Until
   * the meter resets, the worker's preflight refuses this again — visibly.
   */
  async function restartBatch() {
    const payload = state.batch.lastPayload;
    if (!payload) {
      toast('No batch to re-run in this session — start one first');
      return;
    }
    resetBatch();
    state.batch.lastPayload = payload;
    state.batch.running = true;
    renderBatch();
    const res = await send('DOWNLOAD_START', payload);
    if (bail(res, 'DOWNLOAD_START')) {
      state.batch.running = false;
      renderBatch();
      return;
    }
    if (res.batchId) state.batch.batchId = String(res.batchId);
    if (typeof res.planned === 'number') state.batch.total = res.planned;
    renderBatch();
    reportQuotaShortfall(res);
  }

  async function cancelDownload() {
    const res = await send('DOWNLOAD_CANCEL');
    if (bail(res, 'DOWNLOAD_CANCEL')) return;
    state.batch.running = false;
    renderBatch();
  }

  async function retryFailed() {
    const res = await send('DOWNLOAD_RETRY_FAILED');
    if (bail(res, 'DOWNLOAD_RETRY_FAILED')) return;
    resetBatch();
    state.batch.running = true;
    toggleDrawer('batch', true);
    renderBatch();
  }

  function resetBatch() {
    state.batch.batchId = null;
    state.batch.done = 0;
    state.batch.total = 0;
    state.batch.ok = 0;
    state.batch.failed = 0;
    state.batch.skipped = 0;
    state.batch.bytes = 0;
    state.batch.etaMs = 0;
    state.batch.currentTitle = '';
    state.batch.items = new Map();
    state.batch.order = [];
    state.batch.failedItems = [];
    state.batch.remaining = 0;
    state.batch.stoppedReason = '';
    // A stop notice belongs to the batch that produced it.
    renderBatchStop(null, []);
  }

  function batchKey(m) {
    return String(m.clipId || '') + '|' + String(m.variant || '');
  }

  /**
   * Report how a batch ENDED.
   *
   * `stoppedReason` is the ONE field that separates "finished" from "stopped", and
   * the worker emits it on every DL_DONE: `'complete' | 'cancelled' | 'quota' |
   * 'ladder_exhausted'`. The previous handler read only ok/failed/skipped, so a batch
   * that died at the download quota — with nothing deleted and clips still planned
   * — reported the same green success toast as a clean run. Four outcomes, four
   * visibly different reports:
   *
   *   complete          success summary.
   *   quota             WARNING: allowance spent, what was saved, what remains, when
   *                    it resets, how many more would fit, and the resume action.
   *   ladder_exhausted  ERROR: every source refused this clip; per-reason detail
   *                    from the DL_ITEM pushes, which are the only place it exists.
   *   cancelled         neutral: the user asked for it.
   *
   * @param {object} msg the DL_DONE payload
   * @param {object} b `state.batch`
   */
  function onDownloadDone(msg, b) {
    const reason = String(msg.stoppedReason || 'complete');
    const stop = (msg.quotaStop && typeof msg.quotaStop === 'object') ? msg.quotaStop : null;

    if (reason === 'quota') {
      const remaining = stop && Number.isFinite(stop.remaining) ? Number(stop.remaining) : null;
      const reserve = stop && Number.isFinite(stop.reserve) ? Number(stop.reserve) : 0;
      const leftInBatch = typeof msg.remainingItems === 'number' ? msg.remainingItems : b.remaining;
      // What the meter says would still fit before the worker's reserve.
      const fits = remaining === null ? null : Math.max(0, remaining - reserve);
      const resetsOn = stop ? String(stop.resetsOn || '') : '';
      const detail = [
        b.ok + ' saved',
        leftInBatch + ' still planned',
        remaining === null ? null : remaining + ' downloads left on the meter',
        fits === null ? null : fits + ' more fit before the reserve of ' + reserve,
        resetsOn ? 'resets ' + resetsOn : 'reset date unknown'
      ].filter(Boolean).join(' · ');

      renderBatchStop('warn', [
        h('b', { text: 'Stopped — the monthly download allowance ran out. ' }),
        document.createTextNode(detail + '. Nothing was deleted: the remaining clips are still planned.'),
        h('div', { class: 'sm-warn-actions' }, [
          // The unattempted clips have no FAILED row, so DOWNLOAD_RETRY_FAILED
          // cannot reach them; re-running the same request is the real resume.
          btn('Re-run this batch after the reset', () => restartBatch(), 'warn'),
          b.failed > 0 ? btn('Retry the ' + b.failed + ' failed', () => retryFailed(), 'ghost') : null,
          btn('Dismiss', () => renderBatchStop(null, []), 'ghost')
        ])
      ]);
      toast('Download quota reached — batch stopped after ' + b.ok + ' saved, ' + leftInBatch + ' left', 7000);
      return;
    }

    if (reason === 'ladder_exhausted') {
      // `DL_DONE` carries no per-rung detail; the DL_ITEM pushes did, one per clip.
      const reasons = [];
      state.batch.items.forEach((it) => {
        if (!it || (it.state !== 'failed' && it.state !== 'error')) return;
        const line = (it.error || 'refused by every source')
          + (it.source ? ' (last source: ' + it.source + ')' : '');
        if (reasons.indexOf(line) === -1 && reasons.length < 6) reasons.push(line);
      });
      const detail = reasons.length
        ? reasons.join('; ')
        : 'no source in the ladder accepted the clip';

      renderBatchStop('error', [
        h('b', { text: 'Stopped — every source in the ladder refused the clip. ' }),
        document.createTextNode(b.ok + ' saved, ' + b.failed + ' failed. ' + detail + '.'),
        h('div', { class: 'sm-warn-actions' }, [
          btn('Retry the failures', () => retryFailed(), 'warn'),
          btn('Dismiss', () => renderBatchStop(null, []), 'ghost')
        ])
      ]);
      showError('Batch stopped: the download ladder is exhausted (' + detail + ')');
      return;
    }

    if (reason === 'cancelled') {
      renderBatchStop('neutral', [
        h('span', { text: 'Cancelled by you. ' + b.ok + ' saved before the stop, ' + b.skipped + ' skipped. Nothing was rolled back.' })
      ]);
      toast('Batch cancelled: ' + b.ok + ' saved, ' + b.skipped + ' skipped');
      return;
    }

    // complete
    renderBatchStop(null, []);
    toast('Downloads finished: ' + b.ok + ' ok, ' + b.failed + ' failed, ' + b.skipped + ' skipped');
  }

  // Distinct appearance per outcome, inline because content.css (not this file)
  // only has the amber `.sm-warn` and no error/neutral equivalents.
  const STOP_NOTE_STYLE = {
    warn: 'border:1px solid rgba(251,191,36,.5);background:rgba(251,191,36,.12);color:#fde68a;',
    error: 'border:1px solid rgba(248,113,113,.6);background:rgba(248,113,113,.14);color:#fecaca;',
    neutral: 'border:1px solid rgba(148,163,184,.45);background:rgba(148,163,184,.1);color:#cbd5e1;'
  };

  /**
   * @param {'warn'|'error'|'neutral'|null} kind null clears the notice
   * @param {Node[]} kids
   */
  function renderBatchStop(kind, kids) {
    if (!ui.dlStopNote) return;
    clear(ui.dlStopNote);
    ui.dlStopNote.classList.remove('on');
    if (!kind || !kids || !kids.length) {
      ui.dlStopNote.removeAttribute('style');
      return;
    }
    ui.dlStopNote.setAttribute('style', STOP_NOTE_STYLE[kind] || STOP_NOTE_STYLE.warn);
    ui.dlStopNote.classList.add('on');
    append(ui.dlStopNote, kids);
  }

  function upsertBatchItem(m) {
    const key = batchKey(m);
    if (!state.batch.items.has(key)) state.batch.order.push(key);
    state.batch.items.set(key, {
      clipId: String(m.clipId || ''),
      variant: String(m.variant || state.settings.variant),
      state: String(m.state || ''),
      filename: m.filename ? String(m.filename) : '',
      source: m.source ? String(m.source) : '',
      error: m.error ? String(m.error) : '',
      bytes: Number(m.bytes) || 0
    });
    if (state.batch.order.length > MAX_BATCH_ROWS * 2) {
      state.batch.order = state.batch.order.slice(-MAX_BATCH_ROWS);
    }
  }

  function renderBatch() {
    if (!ui.dlProgressText) return;
    const b = state.batch;
    ui.dlProgressText.textContent = (b.running ? 'downloading ' : 'idle · ') +
      b.done + '/' + b.total + ' · ok ' + b.ok + ' · failed ' + b.failed +
      ' · skipped ' + b.skipped + ' · ' + fmtBytes(b.bytes) +
      (b.currentTitle ? ' · ' + b.currentTitle : '') +
      (b.etaMs ? ' · eta ' + fmtEta(b.etaMs) : '');
    const fill = ui.dlBar ? ui.dlBar.firstChild : null;
    if (fill) {
      const pct = b.total ? Math.min(100, Math.round((b.done / b.total) * 100)) : 0;
      fill.style.width = pct + '%';
    }
    clear(ui.dlList);
    const start = Math.max(0, state.batch.order.length - MAX_BATCH_ROWS);
    for (let i = start; i < state.batch.order.length; i++) {
      const it = state.batch.items.get(state.batch.order[i]);
      if (!it) continue;
      const cls = it.state === 'ok' || it.state === 'done' ? 'sm-ok'
        : (it.state === 'failed' || it.state === 'error' ? 'sm-bad' : '');
      ui.dlList.appendChild(h('div', { class: 'sm-dl-item' }, [
        h('span', { class: 'sm-dl-state ' + cls, text: it.state || '…' }),
        h('span', { class: 'sm-dl-name', text: it.filename || it.clipId, title: it.clipId }),
        h('span', { class: 'sm-dl-meta', text: [it.variant, it.source, it.bytes ? fmtBytes(it.bytes) : '', it.error].filter(Boolean).join(' · ') })
      ]));
    }
  }

  function fmtBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '0 B';
    if (v < 1024) return Math.round(v) + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1048576).toFixed(1) + ' MB';
  }

  async function loadHistory() {
    if (!ui.dlHistory) return;
    const res = await send('DOWNLOAD_HISTORY', { limit: 25 });
    clear(ui.dlHistory);
    if (bail(res, 'DOWNLOAD_HISTORY')) {
      ui.dlHistory.appendChild(h('div', { class: 'sm-help', text: 'history unavailable: ' + res.error }));
      return;
    }
    const list = firstArray(res, ['history', 'items', 'entries']);
    if (!list.length) {
      ui.dlHistory.appendChild(h('div', { class: 'sm-help', text: 'no downloads yet' }));
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const e = list[i] || {};
      const at = e.at || e.timestamp || e.finishedAt;
      const when = at ? new Date(Number(at) || at).toLocaleString() : '';
      ui.dlHistory.appendChild(h('div', { class: 'sm-dl-item' }, [
        h('span', { class: 'sm-dl-state ' + (e.error ? 'sm-bad' : 'sm-ok'), text: e.state || (e.error ? 'failed' : 'ok') }),
        h('span', { class: 'sm-dl-name', text: e.filename || e.clipId || '', title: String(e.clipId || '') }),
        h('span', { class: 'sm-dl-meta', text: [e.variant, e.bytes ? fmtBytes(e.bytes) : '', when, e.error || ''].filter(Boolean).join(' · ') })
      ]));
    }
  }

  /* ================================================================== *
   * 17. quota — DOWNLOAD quota, not credits
   * ================================================================== */

  function pickNum(obj, keys) {
    if (!obj) return null;
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  }

  function pickStr(obj, keys) {
    if (!obj) return '';
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (typeof v === 'string' && v) return v;
    }
    return '';
  }

  async function refreshQuota(force) {
    if (!ui.quotaChip) return;
    const res = await send('GET_QUOTA', { refresh: !!force });
    if (!res.ok) {
      if (ui.quotaChip.lastChild) ui.quotaChip.lastChild.textContent = 'n/a';
      ui.quotaChip.classList.add('sm-bad');
      ui.quotaChip.title = 'Download quota unavailable: ' + res.error;
      fail('GET_QUOTA', { message: res.error, code: res.code });
      return;
    }
    ui.quotaChip.classList.remove('sm-bad');
    renderQuota(res.quota || res);
  }

  function renderQuota(q) {
    if (!ui.quotaChip || !q) return;
    const remaining = pickNum(q, ['remaining', 'left', 'available', 'downloadsRemaining', 'quotaRemaining']);
    const limit = pickNum(q, ['limit', 'total', 'dailyLimit', 'downloadsLimit', 'quotaLimit']);
    const resets = pickStr(q, ['resetsAt', 'resetAt', 'resetsOn', 'resetDate', 'resetTime', 'nextReset']);
    const label = ui.quotaChip.lastChild;
    if (label) {
      if (remaining === null) label.textContent = pickStr(q, ['message', 'text']) || '—';
      else label.textContent = (limit === null ? String(remaining) : remaining + ' / ' + limit);
    }
    ui.quotaChip.classList.toggle('sm-bad', remaining !== null && remaining <= 0);
    const bits = ['Download quota (remaining / limit) — NOT credits.'];
    if (limit !== null) bits.push('limit ' + limit);
    if (resets) bits.push('resets ' + resets);
    ui.quotaChip.title = bits.join(' · ');
  }

  /* ================================================================== *
   * 18. settings (SW-mediated)
   * ================================================================== */

  async function loadSettings() {
    const res = await send('GET_SETTINGS');
    if (!res.ok) {
      showError('GET_SETTINGS failed: ' + res.error + ' — using local defaults');
      renderLadder();
      renderTagBoxes();
      renderHlsAvailability();
      return;
    }
    const s = res.settings || res;
    // GET_SETTINGS answers with LADDER_RUNGS as `ladder`; adopt it so renderLadder
    // can label canonical rung ids truthfully.
    if (Array.isArray(res.ladder) && res.ladder.length) state.ladder = res.ladder;
    if (s && typeof s === 'object') {
      state.settings = cloneSettings(s);
      // The worker's own diagnostics switch, read here so this file's `dbg()` is
      // controllable the same way the worker's `log()` is — one setting, both
      // halves. Until this read lands `debugOn` is false, so mount-time
      // diagnostics are silent; that is the price of not hard-coding the answer,
      // and it is why nothing load-bearing depends on `dbg()` reporting.
      debugOn = s.debug === true;
    }
    if (ui.variantSel) {
      ui.variantSel.value = state.settings.variant;
      ui.filenameInput.value = state.settings.filenameTemplate;
      ui.overwriteChk.checked = state.settings.overwrite;
    }
    renderLadder();
    renderTagBoxes();
    renderHlsAvailability();
  }

  function renderTagBoxes() {
    if (!ui.tagBox) return;
    // Driven by the inputs themselves (keyed in buildSettings), not by a parallel
    // key list: the previous version indexed `querySelectorAll(...)` against its own
    // `['embed','lyrics','cover',…]` array, which is how `artwork` and `lrc` came to
    // be driven by the wrong checkbox and why a rename would silently misalign them.
    if (!ui.tagInputs) return;
    for (const key in ui.tagInputs) {
      const box = ui.tagInputs[key];
      if (box) box.checked = state.settings.tagOptions[key] === true;
    }
  }

  let settingsTimer = 0;

  function saveSettings(patch) {
    state.settings = cloneSettings(Object.assign(clone(state.settings), patch));
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      settingsTimer = 0;
      flushSettings();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function flushSettings() {
    // The WHOLE settings object goes back, not a hand-listed patch:
    //   - `updateSettings` shallow-merges over the worker's stored settings, so
    //     forwarding keys the drawer never touches is harmless, and it is the only
    //     way a key this UI does not know about survives a save.
    //   - `coerceSettings` REBUILDS `tagOptions` from the incoming object alone, so
    //     a partial tagOptions would reset the other six to the worker defaults.
    //     `state.settings.tagOptions` therefore always carries all seven keys.
    //   - `downloadSource` is the worker's canonical ladder key and `sourceLadder`
    //     is the alias this UI edits. `updateSettings` only synthesises
    //     `downloadSource` when it is ABSENT, so a forwarded stale
    //     `downloadSource` would shadow the new ordering. Both are sent the same.
    const ladder = state.settings.sourceLadder.slice();
    const patch = Object.assign({}, state.settings, {
      sourceLadder: ladder,
      downloadSource: ladder,
      tagOptions: Object.assign({}, state.settings.tagOptions)
    });
    // The brief pins the type but not the payload shape of UPDATE_SETTINGS, so the
    // patch is sent flat AND under `settings`: an SW reading either shape works.
    const res = await send('UPDATE_SETTINGS', Object.assign({ settings: patch }, patch));
    if (!res.ok) {
      showError('UPDATE_SETTINGS failed: ' + res.error);
      return;
    }
    // Adopt the worker's authoritative answer, so a rejected/aliased value is
    // reflected in the UI instead of diverging from what is stored.
    if (res.settings && typeof res.settings === 'object') {
      state.settings = cloneSettings(res.settings);
      renderLadder();
      renderTagBoxes();
      if (ui.variantSel) ui.variantSel.value = state.settings.variant;
      renderHlsAvailability();
    }
  }

  /* ================================================================== *
   * 19. row injection — attested selectors only
   * ================================================================== */

  // Inline styles: these nodes live in Suno's light DOM, so they must not depend on
  // any page-level stylesheet (and no page-level stylesheet is written by us).
  const ROW_CTL_STYLE = [
    'display:inline-flex', 'align-items:center', 'gap:4px', 'margin:0 6px',
    'vertical-align:middle', 'font:600 11px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    'color:#e9d5ff'
  ].join(';') + ';';

  const TRI_STYLE = [
    'appearance:none', 'width:20px', 'height:20px', 'min-width:20px', 'border-radius:6px',
    'border:1.5px solid rgba(167,139,250,.75)', 'background:rgba(139,92,246,.18)',
    'color:#fff', 'font:700 11px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    'cursor:pointer', 'display:inline-flex', 'alignItems:center', 'justifyContent:center',
    'padding:0', 'user-select:none'
  ].join(';') + ';';

  const MINI_STYLE = [
    'appearance:none', 'border:1px solid rgba(167,139,250,.6)', 'background:rgba(139,92,246,.2)',
    'color:#ede9fe', 'border-radius:6px', 'padding:2px 7px', 'cursor:pointer',
    'font:700 11px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif'
  ].join(';') + ';';

  const TRI_GLYPH = { any: '□', only: '✓', exclude: '✕' };
  const TRI_NEXT = { any: 'only', only: 'exclude', exclude: 'any' };
  const TRI_ORDER = ['any', 'only', 'exclude'];

  function clipIdFor(row) {
    // Attested fallbacks, in order: data-sm-id we set ourselves, then the song link.
    const marked = row.getAttribute('data-sm-id');
    if (marked) return marked;
    const anchors = row.querySelectorAll('a[href*="/song/"]');
    for (let i = 0; i < anchors.length; i++) {
      const m = SONG_HREF_RE.exec(anchors[i].getAttribute('href') || '');
      if (m) return m[1];
    }
    return '';
  }

  function titleFor(row) {
    for (let i = 0; i < TITLE_SELECTORS.length; i++) {
      const el = row.querySelector(TITLE_SELECTORS[i]);
      if (el) {
        const t = (el.textContent || '').trim();
        if (t) return t;
      }
    }
    return '';
  }

  // Where to insert WITHOUT reordering, removing or restyling anything of Suno's:
  //   1. before the action bar (the parent of button[aria-label="Play Count"])
  //   2. right after the thumbnail (.clip-image-container)
  //   3. as the row's first child
  function findInsertPoint(row) {
    try {
      const pc = row.querySelector(PLAY_COUNT_BTN);
      if (pc && pc.parentElement && pc.parentElement.parentNode) {
        return { parent: pc.parentElement.parentNode, next: pc.parentElement };
      }
      const img = row.querySelector('.clip-image-container');
      if (img && img.parentNode) {
        return { parent: img.parentNode, next: img.nextSibling };
      }
    } catch (e) {
      dbg('findInsertPoint fell back:', e && e.message);
    }
    if (row.firstChild) return { parent: row, next: row.firstChild };
    return null;
  }

  function buildRowControl(id, row) {
    const tri = h('button', {
      type: 'button',
      style: TRI_STYLE,
      text: TRI_GLYPH[state.rowIndex.get(id) || 'any'],
      title: 'Row state — click to cycle any / only / exclude',
      'aria-label': 'Include ' + id,
      role: 'checkbox',
      'aria-checked': (state.rowIndex.get(id) || 'any') === 'any' ? 'mixed' : ((state.rowIndex.get(id) === 'only') ? 'true' : 'false'),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cur = state.rowIndex.get(id) || 'any';
        const next = TRI_NEXT[cur];
        if (next === 'any') state.rowIndex.delete(id);
        else state.rowIndex.set(id, next);
        tri.textContent = TRI_GLYPH[next];
        tri.setAttribute('aria-checked', next === 'any' ? 'mixed' : (next === 'only' ? 'true' : 'false'));
        applyRowStateToSpec();
      }
    });

    const dl = h('button', {
      type: 'button',
      style: MINI_STYLE,
      text: '↓',
      title: 'Download this clip with the current settings',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.selection.has(id)) downloadIds(Array.from(state.selection));
        else downloadIds([id]);
      }
    });

    const label = titleFor(row);
    const wrap = h('span', {
      style: ROW_CTL_STYLE,
      title: 'Suno Master row controls' + (label ? ' — ' + label : '')
    }, [tri, dl]);
    wrap.setAttribute(MARK_ATTR, 'row');
    wrap.setAttribute('data-sm-id', id);
    tri.setAttribute(MARK_ATTR, 'row-tri');
    dl.setAttribute(MARK_ATTR, 'row-dl');
    return wrap;
  }

  // Row tri-state (state.rowIndex) folds into spec.ids.include / ids.exclude so
  // "only these rows" and "everything except these rows" are both expressible.
  function applyRowStateToSpec() {
    const ids = TRI_ORDER.map(function () { return []; });
    state.rowIndex.forEach((v, k) => {
      if (v === 'only') ids[1].push(k);
      else if (v === 'exclude') ids[2].push(k);
    });
    const include = ids[1].length ? ids[1] : [];
    const exclude = ids[2].length ? ids[2] : [];
    if (include.length || exclude.length) {
      state.filters.idList = include.concat(exclude).join('\n');
      if (ui.idArea) ui.idArea.value = state.filters.idList;
      schedulePersist();
      onFiltersChanged();
      toast(include.length
        ? 'Row filter: ' + include.length + ' clip(s) included'
        : 'Row filter: ' + exclude.length + ' clip(s) excluded');
    }
  }

  function injectRows() {
    if (!document.body) return;
    let rows;
    try {
      rows = document.querySelectorAll(ROW_SELECTOR);
    } catch (e) {
      dbg('row query failed:', e && e.message);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (!row || row.nodeType !== 1) continue;
        if (row.querySelector('[' + MARK_ATTR + ']')) continue;
        const id = clipIdFor(row);
        if (!id) continue;
        const pt = findInsertPoint(row);
        if (!pt) continue;
        pt.parent.insertBefore(buildRowControl(id, row), pt.next);
      } catch (e2) {
        dbg('row inject skipped:', e2 && e2.message);
      }
    }
  }

  function refreshRowControls() {
    const nodes = document.querySelectorAll('[' + MARK_ATTR + '="row-tri"]');
    for (let i = 0; i < nodes.length; i++) {
      const wrap = nodes[i].parentNode;
      const id = wrap && wrap.getAttribute ? wrap.getAttribute('data-sm-id') : '';
      if (!id) continue;
      const st = state.rowIndex.get(id) || 'any';
      nodes[i].textContent = TRI_GLYPH[st];
      nodes[i].setAttribute('aria-checked', st === 'any' ? 'mixed' : (st === 'only' ? 'true' : 'false'));
    }
  }

  function renderRowState(id) {
    if (!id) return;
    const nodes = document.querySelectorAll('[' + MARK_ATTR + '="row-tri"]');
    for (let i = 0; i < nodes.length; i++) {
      const wrap = nodes[i].parentNode;
      if (!wrap || !wrap.getAttribute) continue;
      if (wrap.getAttribute('data-sm-id') !== id) continue;
      const st = state.rowIndex.get(id) || 'any';
      nodes[i].textContent = TRI_GLYPH[st];
      nodes[i].setAttribute('aria-checked', st === 'any' ? 'mixed' : (st === 'only' ? 'true' : 'false'));
    }
  }

  function removeRowControls() {
    const nodes = document.querySelectorAll('[' + MARK_ATTR + ']');
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  /* ================================================================== *
   * 20. HLS capture — opt-in, off by default, always restored
   * ================================================================== */

  // The MediaSource patch/restore pair used to live here as two arrays of source
  // STRINGS, appended to the page as inline scripts. It is now the worker's
  // `RUN_MAIN_WORLD` route, and this file only names the operation. The behaviour
  // those two strings relied on is recorded here because it is the contract the
  // worker's MAIN-world functions must keep:
  //
  //   patch   1. `if (window.__smHlsActive) -> report alreadyActive:true and change
  //             nothing`. A second patch must NOT clobber `__smHlsSavedMS`, or the
  //             restore would put back an already-overwritten value.
  //           2. `window.__smHlsActive = true`.
  //           3. `window.__smHlsHadMS = ("MediaSource" in window)` — presence is
  //             recorded BEFORE the write, because a page that never had the
  //             property must be restored by DELETING it, not by assigning it.
  //           4. `window.__smHlsSavedMS = window.MediaSource` in its own try/catch:
  //             a throwing getter must not abort the patch, and a failed save
  //             leaves `__smHlsSavedMS` undefined rather than losing the flag.
  //           5. `window.MediaSource = undefined` in its own try/catch, so a
  //             read-only/non-writable property is reported as a patch error
  //             instead of throwing the whole thing away half-applied.
  //   restore 1. `if (!window.__smHlsActive) -> a no-op, reported as notActive`, so
  //             a restore that has nothing to undo does not claim success over a
  //             patch that never landed.
  //           2. `if (window.__smHlsHadMS) window.MediaSource = window.__smHlsSavedMS`,
  //             ELSE `delete window.MediaSource` followed by a re-check: if the
  //             delete silently failed the property is set back to undefined so
  //             the player still sees it as unusable rather than half-present.
  //           3. Both branches in ONE try/catch — a failure to restore must still
  //             reach the flag-clearing step.
  //           4. Always clear `__smHlsActive` / `__smHlsHadMS` / `__smHlsSavedMS`
  //             so a later capture starts from a clean state.
  //           5. Every step above reports its own error string, so one failed step
  //             cannot leave the page unrestorable AND unexplained.

  /**
   * Run one of the worker's fixed MAIN-world operations.
   *
   * WHY THERE IS NO INLINE `<script>` ANY MORE: suno.com ships
   * `script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' …` with no
   * `'unsafe-inline'`. A content script that builds a `<script>` element, assigns
   * `.textContent` to it and appends it to `document.head` gets a SUCCESSFUL APPEND
   * and a BLOCKED EXECUTION — the CSP violation is reported afterwards — so the
   * old injection helper returned `true` while doing nothing at all. That silently
   * killed three things: the `MediaSource` patch never landed, so no
   * `manifest.m3u8` ever appeared and every capture burned a 20s poll before
   * failing with a misleading "no manifest appeared"; the Clerk reader never ran,
   * so `requestPageToken()` was a no-op; and the RESTORE never ran either, which
   * means that if the patch ever had landed, the page would have been left with
   * `MediaSource` destroyed and Suno's own player broken. There is no way to make
   * inline injection work from a content script, and the page's CSP is not to be
   * worked around.
   *
   * The worker injects instead with `chrome.scripting.executeScript({world:'MAIN'})`,
   * which runs in the page's main world but is NOT subject to the page's CSP. So
   * the page is never handed a string to evaluate, the patch/restore pair stays
   * inside one owner where it cannot drift, and this file cannot accidentally
   * reintroduce an inline script.
   *
   * The reply is VERIFIED rather than trusted, because "reported success but did
   * nothing" is the exact failure mode being removed: `ok:true` with no result
   * means the injection never ran, and a non-empty `result.error` means it ran and
   * failed. Either way this returns `{ok:false}` with the reason surfaced.
   *
   * @param {'auth-tap'|'auth-read'|'probe'|'hls-patch'|'hls-restore'} op
   * @returns {Promise<{ok:boolean, result?:object, error?:string, code?:string}>}
   */
  /**
   * Run one of the worker's fixed MAIN-world operations.
   *
   * Inline `<script>` injection is CSP-blocked on suno.com, so the worker uses
   * `chrome.scripting.executeScript({world:'MAIN'})`, which the page CSP does not
   * cover.
   *
   * `opts.quiet` suppresses the red error strip. It exists because "the tap is
   * not installed" and "nothing captured yet" are NORMAL states for the auth
   * ops, not failures: the tap is installed on demand and Suno has simply not
   * made an authenticated request yet. Raising a user-visible error for them put
   * a permanent red strip on every page load, which is the same
   * reported-success-with-a-problem class of bug this extension is being fixed
   * for. Genuine faults (`bad_op`, `no_tab`, `inject_failed`, a missing result)
   * still surface — `quiet` is for absence, not for breakage.
   *
   * @param {'auth-tap'|'auth-read'|'probe'|'hls-patch'|'hls-restore'} op
   * @param {{quiet?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, result?:object, error?:string, code?:string}>}
   */
  async function mainWorldOp(op, opts) {
    const quiet = !!(opts && opts.quiet);
    const why = (msg, code) => {
      const text = String(msg || 'no reason given') + (code ? ' (' + code + ')' : '');
      // A dead context is not THIS op failing — the op was never reached — and the
      // dock has already been replaced by the reload notice, which says the same
      // thing and is actionable. Painting it here as well would put a red strip
      // about the transport on a surface the user is being told to reload past, and
      // these two calls are UNCONDITIONAL on mount, so it would happen on every page
      // after every extension reload.
      if (code === DEAD_CODE) {
        dbg('MAIN-world ' + op + ' never ran; the extension context is gone.');
      } else if (!quiet) {
        showError('MAIN-world ' + op + ' failed: ' + text);
      } else {
        dbg('MAIN-world ' + op + ' (quiet): ' + text);
      }
      return { ok: false, error: text, code: String(code || '') };
    };
    const res = await send('RUN_MAIN_WORLD', { op: op });
    if (!res || !res.ok) {
      // `bad_op`, `no_tab`, `inject_failed` and friends all land here.
      return why((res && res.error) || 'the worker refused the request', res && res.code);
    }
    if (!res.result || typeof res.result !== 'object') {
      return why('the worker reported success but sent no result, so nothing was injected');
    }
    if (res.result.error) {
      return why(res.result.error, res.result.code);
    }
    return { ok: true, result: res.result };
  }

  function setHlsStatus(txt) {
    if (ui.hlsStatus) ui.hlsStatus.textContent = txt;
  }

  async function confirmHls() {
    // The checkbox is a gesture, not a switch: it is forced back off here so the
    // opt-in is always an explicit `window.confirm`, and the one that actually
    // counts is the dialog below.
    if (ui.hlsEnable) ui.hlsEnable.checked = false;
    const answer = window.confirm([
      'Enable HLS stream capture for this session?',
      '',
      'On your confirmation, the service worker runs a MAIN-world operation that',
      'sets window.MediaSource = undefined in the page, so Suno\'s player falls back',
      'to a plain fetch. This dock then reads the resulting manifest.m3u8',
      '(#EXT-X-MAP init segment + media segments).',
      '',
      'The patch is rejected outright if it is already active, rather than being',
      'stacked on top of itself.',
      'The page is restored in a finally block, and a failed restore is reported',
      'loudly rather than left for you to discover.',
      'The segment list is handed to the service worker, which writes the file.',
      '',
      'Continue?'
    ].join('\n'));
    if (!answer) {
      setHlsStatus('idle — disabled');
      return;
    }
    if (state.hls.active) {
      setHlsStatus('refused — a capture is already active');
      toast('HLS capture already running');
      return;
    }
    await runHlsCapture();
  }

  async function runHlsCapture() {
    state.hls.active = true;
    setHlsStatus('arming: asking the service worker to patch the page…');
    // `patched` = THIS run's patch is confirmed in the page, so the finally block
    // has something real to undo. It decides what the final status is allowed to
    // claim, and nothing claims a restore that was not confirmed.
    let patched = false;
    try {
      // The patch MUST be confirmed before anything else happens. Polling for a
      // manifest after a patch that never landed costs 20 wasted seconds and then
      // blames the wrong thing ("no manifest appeared"), which is how a totally
      // dead mechanism read as a flaky player.
      const patch = await mainWorldOp('hls-patch');
      if (!patch.ok) {
        throw new Error('the MediaSource patch never reached the page: ' + patch.error);
      }
      if (patch.result.alreadyActive === true) {
        // The page's re-entry guard was already set. This run changed NOTHING, so
        // it must not be treated as a successful patch — but the finally block
        // still runs the restore, which is exactly what clears the stale state.
        throw new Error('the page still carries a MediaSource patch from an earlier '
          + 'capture that never restored it; nothing was patched this time, and the '
          + 'stale patch was cleared by the restore that follows');
      }
      patched = true;
      setHlsStatus('patched: waiting for Suno to expose an m3u8 stream…');
      const manifestUrl = await pollForManifest(20000);
      if (!manifestUrl) throw new Error('no manifest.m3u8 appeared on any <audio> element within 20s');
      const manifest = await fetchManifest(manifestUrl);
      const clipId = clipIdFromUrl(manifestUrl);
      const res = await send('HLS_CAPTURE', {
        clipId: clipId,
        manifestUrl: manifestUrl,
        initUrl: manifest.initUrl,
        segments: manifest.segments,
        // `captureHls` resolves this with resolveVariant(payload.variant, …); without
        // it every capture is written as the worker's default variant.
        variant: state.settings.variant,
        mime: 'audio/mp4',
        title: document.title
      });
      if (!res.ok) {
        const why = res.code === 'hls_disabled'
          ? 'the worker refuses HLS captures unless settings.allowHlsCapture is true (options page)'
          : String(res.error || 'no reason given');
        showError('HLS hand-off rejected: ' + why + ' (' + manifest.segments.length + ' segments collected)');
        setHlsStatus('hand-off rejected — ' + why);
      } else {
        setHlsStatus('handed off: ' + manifest.segments.length + ' segments → '
          + (res.filename || 'the downloads folder') + ' (' + fmtBytes(res.bytes) + ')');
        toast('HLS segments handed to the service worker: ' + manifest.segments.length);
      }
    } catch (e) {
      setHlsStatus('failed: ' + ((e && e.message) || e));
      showError('HLS capture failed: ' + ((e && e.message) || e));
    } finally {
      // ALWAYS ask the worker to restore the page, whatever happened above. The
      // restore is the SAFETY-CRITICAL half: a page left with MediaSource
      // destroyed has no working player, and the user has to be told, because the
      // fix is to reload the tab and they will not guess that. It is also the
      // only thing that clears a stale patch, so it runs even when this run never
      // patched anything.
      const restore = await mainWorldOp('hls-restore');
      state.hls.active = false;
      if (!restore.ok) {
        const cause = restore.error || 'unknown reason';
        if (patched) {
          setHlsStatus('idle — RESTORE FAILED, window.MediaSource may still be disabled (' + cause + ')');
          showError('HLS restore FAILED: window.MediaSource may still be disabled in this '
            + 'tab, so Suno\'s own player will not work here. Reload the tab. (' + cause + ')');
        } else {
          // Nothing was patched by this run, so there is nothing this failure can
          // have left broken. Say what actually went wrong without crying wolf.
          setHlsStatus('idle — no patch was applied, so there was nothing to restore (' + cause + ')');
          dbg('restore after an unconfirmed patch failed too:', cause);
        }
      } else if (!patched && restore.result.notActive === true) {
        setHlsStatus('idle — nothing was patched, and the page needed no restore');
      } else {
        // Only now, with the worker confirming the restore, may this claim success.
        // `!patched` with a successful restore means the restore cleared a patch
        // left behind by an earlier capture, which is worth saying out loud.
        setHlsStatus(patched
          ? 'idle — window.MediaSource restored'
          : 'idle — a stale patch from an earlier capture was cleared; window.MediaSource restored');
      }
    }
  }

  function pollForManifest(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = () => {
        let url = '';
        try {
          const audios = document.querySelectorAll('audio');
          for (let i = 0; i < audios.length; i++) {
            const src = audios[i].currentSrc || audios[i].src || '';
            if (src && src.indexOf('manifest.m3u8') !== -1) { url = src; break; }
          }
          if (!url) {
            const sources = document.querySelectorAll('source[src*="manifest.m3u8"]');
            if (sources.length) url = sources[0].getAttribute('src') || '';
          }
        } catch (e) {
          dbg('manifest poll failed:', e && e.message);
        }
        if (url) { resolve(url); return; }
        if (Date.now() > deadline) { resolve(''); return; }
        setTimeout(check, 400);
      };
      check();
    });
  }

  async function fetchManifest(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('manifest HTTP ' + res.status);
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    const segments = [];
    let initUrl = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) === '#') {
        if (line.indexOf('#EXT-X-MAP') === 0) {
          const m = /URI="([^"]+)"/.exec(line);
          if (m) initUrl = absolute(m[1], url);
        }
        continue;
      }
      segments.push(absolute(line, url));
    }
    if (!segments.length) throw new Error('manifest contained no media segments');
    return { initUrl: initUrl, segments: segments };
  }

  function absolute(rel, base) {
    try { return new URL(rel, base).href; } catch (e) {
      dbg('URL resolve failed:', e && e.message, rel);
      return rel;
    }
  }

  function clipIdFromUrl(url) {
    const m = SONG_HREF_RE.exec(String(url || ''));
    if (m) return m[1];
    const u = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i.exec(String(url || ''));
    return u ? u[1] : '';
  }

  /* ================================================================== *
   * 21. session token — worker status only, no page relay
   * ================================================================== */

  // There used to be a whole token RELAY here: a MAIN-world script string that read
  // `window.Clerk`, and a `window.addEventListener('message', …)` handler that
  // validated the answer and pushed the raw JWT into the worker with SET_TOKEN.
  // Both halves are gone, for two independent reasons.
  //
  //   1. The script string was DEAD: appending it as an inline script is blocked
  //      by suno.com's CSP, so it never executed and the handler never fired. It
  //      could not have worked from a content script either way — `window.Clerk`
  //      lives in the page world and is invisible to this isolated world.
  //   2. It was REDUNDANT: the worker reaches the same credential without any page
  //      string at all. It can mint one itself
  //      (`chrome.scripting.executeScript({world:'MAIN'})`), and it can observe the
  //      `Authorization: Bearer …` header on Suno's own requests — which is the
  //      `auth-tap` / `auth-read` pair `mount()` installs (see section 22).
  //      GET_TOKEN_STATUS mints opportunistically when it holds nothing.
  //
  // So asking the worker IS the page read, and this file never holds a credential.
  // What is left is the status half: renderTokenInfo / readTokenStatus /
  // applyTokenStatus / refreshToken / refreshTokenStatusQuietly, all driven by the
  // worker's tokenStatus() OBJECT.

  /**
   * Ask the service worker to re-read the page session, and apply what it reports.
   *
   * This used to inject a MAIN-world script string that read `window.Clerk`
   * directly. That could never have worked: inline injection is blocked by
   * suno.com's CSP (the append succeeded and the execution was refused, which is
   * why it reported success while doing nothing), and `window.Clerk` is invisible
   * to this isolated world anyway. The function now converges on
   * `refreshToken()` — GET_TOKEN_STATUS reads the worker's tap and mints
   * opportunistically when it holds nothing — and this alias exists only so the
   * two buttons keep distinct, honest intents.
   *
   * @returns {Promise<void>} resolves once the worker's status has been applied
   */
  async function requestPageToken() {
    await refreshToken();
  }

  function renderTokenInfo() {
    if (!ui.tokenInfo) return;
    const bits = [];
    // Everything below comes from the worker's tokenStatus() OBJECT. The worker
    // reports presence and expiry, never the credential, so there is no JWT in
    // this file to report on.
    //
    // UNREAD IS NOT "NO TOKEN". `state.tokenHas` starts false, so this line used to
    // claim the worker holds no credential from mount until the first reply landed,
    // and for ever if that reply never came — an unanswered question rendered as an
    // answer. See `state.tokenStatusKnown`.
    if (!state.tokenStatusKnown) {
      bits.push(state.tokenReadFailed
        ? 'worker: token status unknown (the worker did not answer)'
        : 'worker: token status not read yet');
    } else {
      bits.push(state.tokenHas ? 'worker: token present' : 'worker: no token');
    }
    if (state.tokenExpiresAt) bits.push('expires ' + new Date(state.tokenExpiresAt).toLocaleTimeString());
    else if (state.tokenStatusKnown) bits.push('expiry unknown');
    ui.tokenInfo.textContent = bits.join(' · ');
    // A rejected-but-unexpired token needs its own colour; `.sm-bad` has no rule
    // for this element, so the emphasis is inline.
    ui.tokenInfo.setAttribute('style', state.tokenBad ? 'color:#fecaca;' : '');
  }

  /**
   * Read the worker's `tokenStatus()` OBJECT.
   *
   * `GET_BOOT.token` and `GET_TOKEN_STATUS.token` are both
   * `{hasToken, expiresAt, secondsRemaining, source, badToken}` — an OBJECT. An
   * earlier guard here ran a JWT-pattern test against `String(res.token)`, and
   * `String({hasToken:true,…})` is `"[object Object]"`, which can never match the
   * JWT pattern, so the whole block was unreachable dead code. It must be read by
   * field and must never be stringified.
   *
   * @param {object} res a worker reply carrying `token`
   * @returns {{hasToken:boolean, expiresAt:number, secondsRemaining:number|null,
   *   source:string, badToken:boolean}|null} null when no status object was sent
   */
  function readTokenStatus(res) {
    if (!res || typeof res !== 'object') return null;
    const info = res.token;
    if (!info || typeof info !== 'object') return null;
    return {
      hasToken: info.hasToken === true,
      expiresAt: Number(info.expiresAt) || 0,
      secondsRemaining: Number.isFinite(info.secondsRemaining) ? Number(info.secondsRemaining) : null,
      source: String(info.source || 'unknown'),
      badToken: info.badToken === true
    };
  }

  /** @param {ReturnType<typeof readTokenStatus>} info */
  function applyTokenStatus(info) {
    if (!info) return;
    state.tokenHas = info.hasToken;
    state.tokenBad = info.badToken;
    state.tokenExpiresAt = info.expiresAt;
    state.tokenStatusKnown = true;
    state.tokenReadFailed = false;
    renderTokenInfo();
  }

  /**
   * Re-read the worker's token status and apply it, without toasting.
   *
   * `refreshToken()` is the user-facing button: it toasts, and it tells the user
   * to re-sign-in on a bad token. Both of those are wrong for the two places
   * that only want the panel to become true — the end of `mount()`, and the
   * TOKEN_CHANGED push. This is the same route, quietly.
   *
   * @returns {Promise<void>}
   */
  async function refreshTokenStatusQuietly() {
    const res = await send('GET_TOKEN_STATUS');
    if (!res.ok) {
      // Mark the failure so `renderTokenInfo` says "unknown" instead of asserting
      // the worker holds no token. Local state is deliberately left alone: a failed
      // read is not evidence about the credential.
      state.tokenReadFailed = true;
      dbg('token status read failed:', res.error, res.code);
      renderTokenInfo();
      return;
    }
    applyTokenStatus(readTokenStatus(res));
  }

  async function refreshToken() {
    // GET_TOKEN_STATUS is the route that reports the token (and mints one
    // opportunistically when the worker has none).
    const res = await send('GET_TOKEN_STATUS');
    if (bail(res, 'GET_TOKEN_STATUS')) return;
    const info = readTokenStatus(res);
    if (!info) {
      fail('GET_TOKEN_STATUS', { message: 'the worker sent no token status object' });
      return;
    }
    applyTokenStatus(info);
    if (info.badToken) {
      // A JWT still inside its own validity that Suno rejects is a BAD token, not
      // an expired session: signing out and back in is the only fix.
      showError('The worker is holding a token Suno rejects — sign out and back in on suno.com, then retry. No retry will help.');
      return;
    }
    if (info.hasToken) {
      toast('Session token present in the service worker'
        + (info.expiresAt ? ' (expires ' + new Date(info.expiresAt).toLocaleTimeString() + ')' : '')
        + (info.secondsRemaining !== null && info.secondsRemaining < 300 ? ' — expiring soon' : ''));
      return;
    }
    // No token yet. This used to call `requestPageToken()`, which after the relay
    // was retired is just `refreshToken()` — so it recursed into itself and spun
    // the message channel until the tab went unresponsive, showing the same
    // "no token" answer forever. There is nothing left for this file to read: the
    // page credential is observed by the worker's MAIN-world auth tap and only
    // exists inside the worker, so one re-ask of the status route is the entire
    // available remedy. The tap catches the token as soon as Suno makes its next
    // authenticated request, and the worker broadcasts TOKEN_CHANGED then.
    showError('The service worker holds no session token yet. The page is not sending '
      + 'one, so no authenticated call can be attempted — sign in at suno.com and '
      + 'reload this tab. Re-reading will not help.');
  }

  /* ================================================================== *
   * 22. mount / observer / teardown
   * ================================================================== */

  let observer = null;
  let observeTimer = 0;

  function attachObserver() {
    if (observer || !document.body) return;
    try {
      observer = new MutationObserver(() => {
        // Debounced: Suno re-renders constantly and rows must still get
        // checkboxes. Our own shadow-root mutations are NOT observed here, so
        // there is no feedback loop.
        if (observeTimer) clearTimeout(observeTimer);
        observeTimer = setTimeout(() => {
          observeTimer = 0;
          try {
            injectRows();
            refreshRowControls();
          } catch (e) {
            dbg('observer pass failed:', e && e.message);
          }
        }, OBSERVE_DEBOUNCE_MS);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      dbg('MutationObserver unavailable:', e && e.message);
      observer = null;
    }
  }

  function detachObserver() {
    if (observeTimer) { clearTimeout(observeTimer); observeTimer = 0; }
    if (observer) {
      try { observer.disconnect(); } catch (e) { dbg('observer disconnect failed:', e && e.message); }
      observer = null;
    }
  }

  function buildToast() {
    ui.toast = h('div', { class: 'sm-toast' });
    ui.errorStrip = h('div', {
      class: 'sm-error',
      onclick: clearError,
      title: 'click to dismiss'
    });
    return [ui.errorStrip, ui.toast];
  }

  /**
   * Create the shadow host, apply the stylesheet, and return the empty root to fill.
   *
   * Extracted from `mount()` because the dead-context notice needs exactly the same
   * seam — same host, same stylesheet, same z-index, so the notice is styled by the
   * same CSS as the dock it replaces instead of arriving as an unstyled fragment.
   *
   * @returns {Promise<{root:HTMLElement, cssText:string}|null>} null if there is no
   *   body yet, which is the document_start case this file is written against
   */
  async function createRoot() {
    if (!document.body) return null;
    const existing = document.getElementById(HOST_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('style', [
      'all:initial',
      'display:block',
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'z-index:' + Z_DOCK,
      'pointer-events:none',
      'isolation:isolate',
      'contain:layout style'
    ].join(';') + ';');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);

    const cssText = await loadCssText();
    applyStyles(shadow, cssText);

    const root = h('div', { class: 'sm-root' });
    shadow.appendChild(root);
    return { root: root, cssText: cssText };
  }

  async function mount() {
    if (state.mounted) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    // Nothing below can work without a live context, and a dock built on top of a
    // dead one is the defect this check exists for: it looks interactive and every
    // control fails. In practice the script was just injected so this is alive;
    // it is checked because it costs nothing and the failure it prevents is silent.
    if (!contextAlive()) {
      dbg('mount() reached with a dead extension context; showing the reload notice');
      await showReloadNotice();
      return;
    }
    state.mounted = true;

    // ---- shadow host -------------------------------------------------
    const created = await createRoot();
    if (!created) return;
    const cssText = created.cssText;
    const root = created.root;
    const bits = buildToast();
    root.appendChild(bits[0]);
    root.appendChild(bits[1]);
    // Only now does the error strip exist, so the stylesheet notice goes here.
    if (!cssText) {
      showErrorOnce('content.css could not be fetched (manifest web_accessible_resources) — using the fallback stylesheet');
    }

    ui.dock = buildDock();
    root.appendChild(ui.dock);
    ui.panel = buildPanel();
    root.appendChild(ui.panel);
    ui.batchDrawer = buildBatch();
    root.appendChild(ui.batchDrawer);
    ui.settingsDrawer = buildSettings();
    root.appendChild(ui.settingsDrawer);
    renderPresets();
    renderLadder();
    renderTagBoxes();
    renderTokenInfo();
    renderSync();
    renderBatch();
    renderModelFacets();
    renderProjectList();
    renderSummary();
    applyFiltersToControls();

    // ---- restore persisted UI state ----------------------------------
    const saved = await loadPersisted();
    if (saved && saved.filters && typeof saved.filters === 'object') {
      state.filters = Object.assign(clone(DEFAULT_FILTERS), saved.filters);
      applyFiltersToControls();
    }
    if (saved && saved.syncMaxPages) {
      state.syncMaxPages = String(saved.syncMaxPages);
      if (ui.syncMaxPages) ui.syncMaxPages.value = state.syncMaxPages;
    }
    schedulePersist();

    // ---- rows + observer ---------------------------------------------
    injectRows();
    attachObserver();

    // ---- re-read the worker's answer when this tab comes back ---------
    // Only for the sync state. There is deliberately no reinstall for the auth tap
    // here (see the note above): a full reload re-runs mount(), and this listener is
    // about a THROTTLED POLL, not about repairing the tap.
    document.addEventListener('visibilitychange', onSurfaceFocus);
    window.addEventListener('focus', onSurfaceFocus);

    // ---- wire the SW --------------------------------------------------
    const bootRes = await send('REGISTER_TAB', {
      url: location.href,
      path: location.pathname,
      title: document.title
    });
    if (!bootRes.ok) fail('REGISTER_TAB', { message: bootRes.error, code: bootRes.code });

    // ---- sign-in: install the Authorization-header tap FIRST ----------
    // ORDER MATTERS, and this is the sign-in fix. The worker reads the token by
    // observing the `Authorization: Bearer …` header on Suno's OWN requests, and
    // that observer lives in the page, so it has to exist before the page issues
    // its first authenticated fetch. Suno's shell + Clerk session bootstrap
    // happens during first paint, which is already under way by the time this
    // dock is built, so the tap is installed as soon as the dock is up — and
    // BEFORE the first GET_BOOT / GET_TOKEN_STATUS, because those are the calls
    // that make the worker try to mint, and minting blind is what produced
    // "no Clerk JWT available; authenticated call not attempted" for a user who
    // was plainly signed in.
    //
    // Self-healing on reload: the tap lives in the page, so a full reload wipes
    // it — but a full reload also re-runs this content script, so mount() runs
    // again and reinstalls it. That is why there is deliberately NO
    // `pageshow`/`visibilitychange` reinstall handler here: it would be a second
    // mechanism for something that already repairs itself. The worker's
    // `alreadyInstalled` reply makes the one redundant case (mount() reached
    // twice without a reload) harmless, and it is treated as success below.
    //
    // A tap failure must NOT block the mount: Clerk may still work through the
    // worker's own mint path, and a dock that refuses to appear because an auth
    // helper is unhappy is strictly worse than a dock with no tap. `mainWorldOp`
    // has already shown the error strip for the real reason, so this only adds
    // a debug line and carries on.
    const tap = await mainWorldOp('auth-tap', { quiet: true });
    if (!tap.ok) dbg('auth tap not installed; the worker may have to mint instead:', tap.error);
    else dbg('auth tap live (alreadyInstalled=' + (tap.result.alreadyInstalled === true) + ')');

    // ONE eager read, so the worker has a token before it needs one instead of
    // minting on the critical path. Best-effort like the tap: if it yields
    // nothing, GET_TOKEN_STATUS below still asks the worker, and the worker's own
    // tap will pick the token up on Suno's next authenticated request.
    const read = await mainWorldOp('auth-read', { quiet: true });
    if (!read.ok) {
      dbg('eager auth read failed; falling back to the worker status route:', read.error);
    } else if (read.result.token && read.result.token.length > 20) {
      // `expiresAt: 0` means "unknown expiry", which is what SET_TOKEN documents
      // and what the tap can honestly supply: it sees a bearer header, not a
      // verified JWT `exp` claim. The worker re-derives and caches real expiry
      // from the JWT it stores, and broadcasts TOKEN_CHANGED when that lands.
      const set = await send('SET_TOKEN', { token: String(read.result.token), expiresAt: 0 });
      if (!set.ok) {
        dbg('worker refused the tapped token:', set.error, set.code);
      } else {
        applyTokenStatus({
          hasToken: true,
          expiresAt: Number(set.expiresAt) || 0,
          secondsRemaining: null,
          source: 'auth-tap',
          badToken: false
        });
        dbg('tapped token handed to the worker via SET_TOKEN');
      }
    } else {
      dbg('auth read found no token yet; the tap will catch the next request');
    }

    const boot = await send('GET_BOOT');
    if (boot.ok) {
      // LADDER_RUNGS, so the ladder editor shows real rung labels.
      if (Array.isArray(boot.ladder) && boot.ladder.length) state.ladder = boot.ladder;
      // `boot.token` is the tokenStatus() OBJECT, never a JWT string.
      const info = readTokenStatus(boot);
      if (info) applyTokenStatus(info);
      else if (boot.token !== undefined) {
        fail('GET_BOOT', { message: 'token status was not an object; refusing to guess at it' });
      }
      // There is deliberately NO `send('TOKEN_CHANGED', …)` here. TOKEN_CHANGED is a
      // PUSH type: it is in the worker's PUSH_TYPES set, which the router
      // short-circuits, so the request always failed silently. The worker pushes
      // TOKEN_CHANGED itself when the token changes (see the onMessage case below),
      // so nothing needs to be sent.
    } else {
      fail('GET_BOOT', { message: boot.error, code: boot.code });
    }

    await Promise.all([
      loadSettings(),
      loadSelection(),
      loadProjects(),
      refreshFacets(),
      refreshQuota(false),
      pollSyncStatus()
    ]);

    refreshResults(true);
    renderSync();

    // The tap only sees a token when Suno makes an authenticated request, which
    // happens at its own pace. GET_BOOT above read the worker's status before
    // that could have happened, so ask once more, quietly, and let the panel show
    // whatever is true by now.
    await refreshTokenStatusQuietly();
    dbg('mounted; stylesheet source:', cssText ? 'content/content.css' : 'fallback');
  }

  let errorOnceShown = false;

  function showErrorOnce(msg) {
    if (errorOnceShown) return;
    errorOnceShown = true;
    showError(msg);
  }

  /**
 * Re-read the authority when this tab comes back into view.
 *
 * A dock is long-lived — it stays on the page across the whole session — so this is
 * the case the reported defect turns on. Chrome throttles timers in a background tab,
 * so the dock's `SYNC_STATUS` poll may not have run at all while the user was away;
 * and even where it did, a crawl that started and finished elsewhere needs no push to
 * reach a dock that was listening. Either way the last thing this document believes
 * about the crawl is stale, and "stale" is what lets a start be offered. Both events
 * are cheap, idempotent and only ever overwrite with the worker's answer.
 *
 * A dead context latches in `send()`, so a failed re-read here paints nothing and
 * re-asking is harmless.
 */
function onSurfaceFocus() {
  if (!state.mounted || document.hidden || contextDead) return;
  void pollSyncStatus();
}

function destroy() {
  detachObserver();
  removeRowControls();
  // The visibility/focus re-read is installed on the DOCUMENT, so it outlives the
  // shadow host and would keep firing after "Hide" or after the dead-context
  // teardown. `state.mounted` would gate it, but removing the listener is what
  // stops a removed dock from being resurrected by a stray focus event.
  document.removeEventListener('visibilitychange', onSurfaceFocus);
  window.removeEventListener('focus', onSurfaceFocus);
  stopSyncPoll();
  state.mounted = false;
  const host = document.getElementById(HOST_ID);
  if (host && host.parentNode) host.parentNode.removeChild(host);
  dbg('destroyed');
}

  /* ---------------- dead extension context (see DEAD_CODE) ------------ */

  /**
   * Set once this script has lost the extension. Not user state: it exists so the
   * many things that can notice a dead context — a `send()` failure, the mount
   * probe, the tab-focus re-check — agree on whether the notice has been shown.
   */
  let contextDead = false;

  /**
   * Is this script's extension context still usable?
   *
   * WHY A PROBE AT ALL: the authority is the transport failure classified in
   * `send()`, which is definitive. But it only arrives when the user presses
   * something. Reloading the extension while a tab sits open invalidates every
   * mounted content script at once, and the tab then shows a dock that still looks
   * completely live — same chips, same buttons, same row checkboxes — over a
   * context that can no longer answer. The user has to press something before this
   * file learns it is dead, and the result of that press is an error about a
   * feature they did not break. This is the cheap check that notices first.
   *
   * WHY TWO SIGNALS, AND WHY IT FAILS SAFE: `chrome.runtime.id` and
   * `chrome.runtime.getManifest()` both belong to the extension context, so both
   * die with it while `document`, timers and this file keep running — that
   * asymmetry is the whole defect. A context counts as ALIVE if EITHER answers.
   * That is deliberate: the cost of a false negative is nothing new (the user
   * presses a control and `send()` classifies the real failure anyway), whereas a
   * false positive would tear down a working dock on every page load — a far worse
   * failure than the one this is here to catch, and one this file could not
   * recover from without the reload it is asking for.
   *
   * @returns {boolean}
   */
  function contextAlive() {
    try {
      const rt = chrome.runtime;
      if (!rt) return false;
      if (rt.id) return true;
      try { return !!rt.getManifest(); }
      catch (manifestErr) {
        dbg('getManifest() threw on a context with no runtime.id:', manifestErr && manifestErr.message);
        return false;
      }
    } catch (e) {
      dbg('extension-context probe threw:', e && e.message);
      return false;
    }
  }

  /**
   * Replace the dock with the one thing a dead context needs: an explanation and a
   * way out. A reload is the ONLY fix — nothing in this file can revive an
   * invalidated context, which is why there is no retry here and why the button
   * says so rather than offering one.
   *
   * The teardown is SYNCHRONOUS and happens before the first `await`, because the
   * `send()` that got us here has already resolved: any consumer of that reply
   * resumes on the microtask queue and must find nothing left to paint, or it puts
   * Chrome's transport string on screen before the notice arrives.
   *
   * `destroy()` is the same seam the "Hide" button uses, so the observer, the row
   * controls and `state.mounted` all come down with it. Leaving `state.mounted`
   * false is what keeps the notice itself quiet: `toast()` and the error strip
   * are gated on it, so nothing further can be painted over the explanation.
   *
   * @returns {Promise<void>}
   */
  async function showReloadNotice() {
    if (ui.reloadNotice) return;
    stopSyncPoll();
    destroy();
    const created = await createRoot();
    if (!created) return;
    ui.reloadNotice = buildReloadNotice();
    created.root.appendChild(ui.reloadNotice);
    dbg('reload notice shown');
  }

  /**
   * The notice itself. Existing CSS classes only (`sm-panel`, `sm-warn`,
   * `sm-brand`, `sm-btn`): it must look like part of this dock, because the
   * failure it reports is that the user cannot tell the difference between a
   * working dock and a dead one.
   *
   * @returns {HTMLElement}
   */
  function buildReloadNotice() {
    return h('div', {
      class: 'sm-panel',
      // The panel's own width is the layout's; clamped here because a one-line
      // notice inside a 940px surface reads as a page that failed to load.
      style: 'max-width:min(520px,94vw)'
    }, [
      h('div', { class: 'sm-warn on', role: 'alert' }, [
        h('b', { text: 'This extension was reloaded, so this page cannot talk to it any more.' }),
        // What is actually broken, in the user's terms: the controls are still
        // drawn but every one of them fails from here on.
        h('span', {
          class: 'sm-trunc-detail',
          text: 'The dock below was built by the previous copy of the extension. Its '
            + 'buttons, filters and sync status can no longer reach the worker, and '
            + 'no amount of retrying will change that — the extension has to be loaded '
            + 'into this page again.'
        }),
        h('div', { class: 'sm-warn-actions' }, [
          // The one action that is honest here. `location.reload()` re-injects the
          // content script into a context the freshly-loaded extension owns, which
          // is the only path back to a working dock.
          btn('Reload this page', () => { location.reload(); }, 'primary'),
          h('span', {
            class: 'sm-help',
            text: 'Your indexed clips, downloads and settings are untouched — they live '
              + 'in the worker, not on this page.'
          })
        ])
      ])
    ]);
  }

  /* ================================================================== *
   * 23. pushes from the service worker
   * ================================================================== */

  // Unhandled push types, by name. Purely a diagnostic tally (see `default:`
  // below); it is not user state and nothing renders it.
  const unknownPushes = {};

  chrome.runtime.onMessage.addListener((msg) => {
    try {
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'SYNC_PROGRESS':
          /* THE COUNTERS ONLY. This push carries no `running` field, so under the
           * rule in `applySyncAuthority` it cannot put the dock from "not running"
           * into "running" — `applySyncProgress` above enforces that. Arming the
           * poll means believing a crawl is live, so it follows the authority rather
           * than this push. The numbers still arrive on the fast path. */
          applySyncProgress(msg);
          renderSync();
          scheduleSyncPoll();
          break;

        // The three lifecycle pushes below were MISSING from this switch, so they
        // fell through to `default:` and vanished: a sync started from the popup or
        // the side panel left this dock idle (no running dot, no phase, no poll),
        // and a cancellation started elsewhere was never reflected at all. All
        // three are in the worker's PUSH_TYPES, both other surfaces handle them,
        // and the dock is the surface that reports the crawl's completeness — so a
        // dropped push here is a dropped verdict, not a cosmetic gap.
        case 'SYNC_STARTED':
          // The worker announces a crawl with `running:true, cancelRequested:false`,
          // so this push IS authoritative and goes through the one writer — a crawl
          // started from the popup or the side panel therefore reaches the dock as
          // the same fact they received it as, instead of as a dock-side guess.
          //
          // It is also the dock's cue that the counters below belong to a NEW walk and
          // not to the previous one. `total` is deliberately NOT read from it: that
          // field is Suno's clip count, while `state.sync.total` is the number
          // INDEXED, and writing one over the other is what turns "400 indexed ·
          // Suno reports ~5,500" into a single contradictory number.
          resetSyncRun();
          if (typeof msg.maxPages === 'number' && msg.maxPages > 0) state.sync.maxPages = msg.maxPages;
          applySyncAuthority(msg);
          renderSync();
          scheduleSyncPoll();
          break;

        case 'SYNC_CANCEL_REQUESTED':
          // An abort is COOPERATIVE: the worker has signalled the controller and the
          // crawl unwinds at its next await, which during a rate-limit backoff can
          // be seconds away. So this is "stopping", not "stopped" — the same
          // distinction `cancelSync()` draws by watching `SYNC_STATUS` before it
          // claims anything, and the reason the poll stays armed here.
          // Authoritative (`running:true, cancelRequested:true`), so the one writer
          // reads it rather than this case assigning the flags itself.
          applySyncAuthority(msg);
          state.sync.state = 'cancelling';
          renderSync();
          scheduleSyncPoll();
          break;

        case 'SYNC_CANCELLED':
          // The worker only broadcasts this when NO controller was attached, so
          // nothing will follow it with a SYNC_DONE: the press either cleared an
          // orphaned cursor or found nothing running. Both are terminal for the
          // crawl, hence the poll stops — and because no verdict rides on this
          // push, the durable cursor is re-read below rather than guessed at, for
          // the reason `cancelSync()` reads it too.
          stopSyncPoll();
          applySyncAuthority(msg);
          state.sync.state = msg.orphanedCursorCleared === true ? 'interrupted' : 'cancelled';
          state.sync.stopped = msg.orphanedCursorCleared !== true;
          announceSyncView();
          toast(msg.orphanedCursorCleared === true
            ? 'Cleared a crawl the extension worker had abandoned. Indexed clips were kept.'
            : 'No sync was running.');
          renderSync();
          pollSyncStatus().catch(() => {});
          break;

        case 'SYNC_DONE':
          // Terminal by construction, and through the one writer: the crawl that
          // owned the controller has finished, so there is nothing left to stop.
          stopSyncPoll();
          applySyncAuthority({ running: false, interrupted: false });
          onSyncDone(msg);
          break;

        case 'SYNC_ERROR':
          stopSyncPoll();
          // A hard failure is an INCOMPLETE index, so it has to be applied
          // through the SAME writer as `SYNC_DONE`. The old copy only set
          // `state.sync.state = 'error'`, which left `state.sync.completed` on its
          // previous value — so `renderSync` could paint the green `ok` dot and
          // the word `synced` immediately beside a strip reading "Sync failed".
          onSyncError(msg);
          break;

        case 'DL_PROGRESS': {
          const b = state.batch;
          if (msg.batchId && state.batch.batchId && String(msg.batchId) !== state.batch.batchId) break;
          if (typeof msg.done === 'number') b.done = msg.done;
          if (typeof msg.total === 'number') b.total = msg.total;
          if (typeof msg.ok === 'number') b.ok = msg.ok;
          if (typeof msg.failed === 'number') b.failed = msg.failed;
          if (typeof msg.skipped === 'number') b.skipped = msg.skipped;
          if (typeof msg.bytes === 'number') b.bytes = msg.bytes;
          if (typeof msg.etaMs === 'number') b.etaMs = msg.etaMs;
          b.currentTitle = msg.currentTitle ? String(msg.currentTitle) : '';
          renderBatch();
          break;
        }

        case 'DL_ITEM':
          upsertBatchItem(msg);
          renderBatch();
          break;

        case 'DL_DONE': {
          const b = state.batch;
          b.running = false;
          if (typeof msg.ok === 'number') b.ok = msg.ok;
          if (typeof msg.failed === 'number') b.failed = msg.failed;
          if (typeof msg.skipped === 'number') b.skipped = msg.skipped;
          if (typeof msg.remainingItems === 'number') b.remaining = msg.remainingItems;
          b.stoppedReason = String(msg.stoppedReason || 'complete');
          renderBatch();
          if (msg.quotaAfter) renderQuota(msg.quotaAfter);
          else refreshQuota(false);
          onDownloadDone(msg, b);
          break;
        }

        case 'DL_ERROR':
          state.batch.running = false;
          renderBatch();
          showError('Download failed: ' + (msg.error || 'unknown'));
          break;

        case 'TOKEN_CHANGED':
          // A real PUSH from the worker (it broadcasts this from SET_TOKEN), not a
          // route — so this only LISTENS. The payload carries the new expiry ONLY.
          //
          // The worker sends `expiresAt: authCache.exp || null`, and `null` means
          // "unknown", not "none". This used to fold both into
          // `tokenHas = expiresAt > 0`, which meant that handing the worker a
          // freshly tapped token whose `exp` had not been parsed yet immediately
          // downgraded the panel from "token present" to "no token" — the worker
          // broadcasting a SUCCESS was read as the token disappearing. So an
          // unknown expiry updates the expiry field and leaves presence alone,
          // and presence is only ever cleared by a status read that says so.
          state.tokenExpiresAt = Number(msg.expiresAt) || 0;
          if (state.tokenExpiresAt > 0) state.tokenHas = true;
          renderTokenInfo();
          // The expiry may have moved underneath us, so re-read the authoritative
          // status rather than trusting a push that carries one field.
          refreshTokenStatusQuietly();
          break;

        default:
          // NOT silent. A push type this switch does not know is either a worker
          // that grew one (the dock is then behind the contract and a feature may
          // silently do nothing) or a message this build should never have been
          // sent — and either way it is unanswerable from here. It goes to the
          // diagnostic sink, which `settings.debug` turns on, with a count, so a
          // repeated push shows up once with a number attached rather than being
          // buried in a stream of identical lines.
          //
          // Deliberately not a user-visible strip: a push this dock does not model
          // may be informational, and painting every unknown type red is how a
          // permanent error bar appears on pages where nothing is wrong — the exact
          // regression the `quiet` option on `mainWorldOp` exists to prevent.
          unknownPushes[msg.type] = (unknownPushes[msg.type] || 0) + 1;
          dbg('unhandled push type:', msg.type, '(x' + unknownPushes[msg.type] + ')');
          break;
      }
    } catch (e) {
      // A fault in here would drop every later push too, so it is reported rather
      // than swallowed: `debugOn` is false by default, which is why this sink is
      // driven from settings rather than a constant.
      dbg('push handler failed:', e && e.message);
    }
  });

  /* ================================================================== *
   * 24. bootstrap — the ONLY top-level DOM touch, and it is null-safe
   * ================================================================== */

  function boot() {
    // document_start: document.body is null. Do not touch it until it exists.
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  boot();

})();