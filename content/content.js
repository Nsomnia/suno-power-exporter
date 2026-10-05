/**
 * Suno Master Utility — page dock (content script).
 *
 * WHY THIS FILE WAS DEAD CODE BEFORE
 * ----------------------------------
 * manifest.json runs content scripts at `document_start`, where `document.body`
 * is still null. The old file called `document.body.appendChild(dock)` at the top
 * level of its init IIFE, threw a TypeError, and took the entire script down with
 * it: no dock, no row checkboxes, no Clerk-token relay, on any page. Everything
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

  const DEBUG = false;

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
    if (!DEBUG) return;
    try { console.log.apply(console, ['[SunoMaster/dock]'].concat([].slice.call(arguments))); }
    catch (e) { if (DEBUG) return; }
  }

  // Every catch in this file funnels here, so nothing is swallowed silently (j).
  function fail(scope, err, opts) {
    const o = opts || {};
    const msg = (err && (err.message || err.error)) || String(err || 'unknown error');
    dbg('failed:', scope, msg, err);
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
      running: false, page: 0, pagesDone: 0, seen: 0, added: 0, etaMs: 0,
      state: 'idle', truncated: false, total: 0, lastDurationMs: 0, lastProjects: 0,
      maxPages: 0, lastError: '', truncateDismissed: false
    },
    batch: {
      running: false, batchId: null, done: 0, total: 0, ok: 0, failed: 0, skipped: 0,
      bytes: 0, etaMs: 0, currentTitle: '', items: new Map(), order: [], failedItems: [],
      remaining: 0, stoppedReason: '', lastPayload: null
    },
    results: { items: [], total: 0, offset: 0, limit: RESULT_PAGE_SIZE, hasMore: false },
    // `state.token` holds ONLY a raw JWT handed over by the page relay. The worker
    // never returns a JWT — `GET_BOOT.token` / `GET_TOKEN_STATUS.token` are the
    // tokenStatus() OBJECT — so worker-side presence is tracked separately.
    token: null,
    tokenExpiresAt: 0,
    tokenHas: false,
    tokenBad: false,
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

  function send(type, payload) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        chrome.runtime.sendMessage({ type: type, payload: payload || {} }, (res) => {
          const last = chrome.runtime.lastError;
          if (last) {
            finish({
              ok: false,
              error: last.message || 'runtime error',
              code: 'RUNTIME'
            });
            return;
          }
          finish(normalizeReply(res, type));
        });
      } catch (e) {
        finish({ ok: false, error: (e && e.message) || 'sendMessage threw', code: 'THROW' });
      }
    });
  }

  // Anything the SW refuses must become VISIBLE: every caller that can return
  // early on !res.ok routes through here so no failure is swallowed silently.
  function bail(res, scope) {
    if (!res || !res.ok) {
      fail(scope, { message: (res && res.error) || 'no response', error: (res && res.error) || 'no response' });
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
          // The page cap is kept too, so the value the user (or the truncation
          // banner's "bigger cap" action) chose is still there on the next visit
          // instead of silently reverting to the worker's default.
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
    ui.truncWarn = h('div', { class: 'sm-warn' }, [
      h('b', { text: 'Library INCOMPLETE — page cap hit. ' }),
      h('span', { class: 'sm-trunc-detail', text: '' }),
      // Children go in the THIRD argument. The previous version passed a `children`
      // prop, which `h()` has no case for: it fell through to
      // `setAttribute('children', …)`, so these two buttons were never in the DOM at
      // all and the truncation banner had no way out of it.
      h('div', { class: 'sm-warn-actions' }, [
        btn('Re-sync with a bigger cap', () => {
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
      field('Disliked pass', 'Sent to SYNC_START as dislikedMode. Suno exposes NO per-clip dislike field: "exclude" = one pass with hide_disliked=true, "only" = one pass with hide_disliked=false, "both passes" = two passes plus an id-set diff (roughly DOUBLES sync time, and is the only mode that computes your disliked set).', ui.syncDisliked),
      field('Page cap', 'Max pages per feed. Hitting it truncates the library — you will be warned. Left empty the worker uses settings.syncMaxPages.', ui.syncMaxPages),
      h('div', { class: 'sm-row' }, [
        btn('Start sync', () => startSync(), 'primary'),
        btn('Cancel', () => cancelSync(), 'ghost'),
        btn('Check status', () => pollSyncStatus(), 'ghost')
      ]),
      ui.syncState,
      ui.syncBar,
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
      field('Disliked', 'No clip field exists. The SW diffs /api/feed/v2 with hide_disliked=true vs false. Costs ~2x sync time.', ui.dislikedSel),
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
        h('label', { class: 'sm-label' }, [document.createTextNode('Session token'), qmark('The SW mints the Clerk token in the MAIN world; this panel only reports status.')]),
        ui.tokenInfo,
        h('div', { class: 'sm-row' }, [
          btn('Refresh token', () => refreshToken()),
          btn('Read from page (fallback)', () => requestPageToken())
        ])
      ]),
      h('div', { class: 'sm-field' }, [
        h('label', { class: 'sm-label' }, [
          document.createTextNode('Experimental: HLS capture'),
          qmark('Off by default. Temporarily sets window.MediaSource = undefined in the page MAIN world so the player falls back to a plain fetch, then collects the #EXT-X-MAP init segment + media segments. Restored in a finally.')
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
    setHlsStatus('armed — the page is patched only while a capture runs, and always restored');
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
        if (!res.ok) fail('SET_SELECTION', { message: res.error });
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

  async function startSync(force) {
    const maxPages = num(ui.syncMaxPages ? ui.syncMaxPages.value : null);
    state.sync.running = true;
    state.sync.truncated = false;
    state.sync.truncateDismissed = false;
    state.sync.page = 0;
    state.sync.pagesDone = 0;
    state.sync.seen = 0;
    state.sync.added = 0;
    state.sync.lastError = '';
    if (maxPages !== null && maxPages > 0) state.sync.maxPages = Math.floor(maxPages);
    renderSync();

    // `SYNC_START` takes `dislikedMode` as 'include' | 'exclude' | 'both' and
    // silently falls back to the stored setting for anything else. The panel's
    // tri-state values are the same vocabulary the filter panel uses, so they are
    // mapped explicitly here instead of being forwarded verbatim (which is how
    // 'any' and 'only' used to be dropped on the floor):
    //   exclude -> 'exclude'  one pass, hide_disliked=true  (no dislikes indexed)
    //   only    -> 'include'  one pass, hide_disliked=false (indexes dislikes)
    //   any     -> 'both'     two passes + id-set diff, so nothing is skipped
    const choice = (ui.syncDisliked && ui.syncDisliked.value ? ui.syncDisliked.value : state.filters.disliked);
    const dislikedMode = choice === 'only' ? 'include' : (choice === 'exclude' ? 'exclude' : 'both');

    const res = await send('SYNC_START', {
      force: force === undefined ? !!(ui.syncForce && ui.syncForce.checked) : !!force,
      dislikedMode: dislikedMode,
      maxPages: maxPages === null ? 0 : maxPages
    });
    if (bail(res, 'SYNC_START')) {
      state.sync.running = false;
      state.sync.state = 'failed';
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
    state.sync.running = false;
    state.sync.state = 'cancelling';
    renderSync();
  }

  async function pollSyncStatus() {
    const res = await send('SYNC_STATUS');
    if (bail(res, 'SYNC_STATUS')) return;
    applySyncCursor(res.cursor);
    // `running` and `total` are genuinely TOP level; everything else lives under
    // `cursor`. The previous version read `res.page` / `res.pagesDone` / `res.seen`
    // / `res.added` / `res.etaMs` / `res.state`, every one of which is `undefined`,
    // and `applySyncProgress` is entirely `typeof … === 'number'` guards, so "Check
    // status" silently updated nothing at all.
    state.sync.running = res.running === true;
    if (res.running !== true) {
      const cursorState = res.cursor && res.cursor.state ? String(res.cursor.state) : '';
      if (cursorState) state.sync.state = cursorState;
    } else {
      state.sync.state = 'running';
    }
    if (typeof res.truncated === 'boolean') state.sync.truncated = res.truncated;
    if (typeof res.total === 'number') state.sync.total = res.total;
    renderSync();
  }

  /**
   * Map the worker's crawl cursor onto the fields `applySyncProgress` expects.
   *
   * `SYNC_STATUS` returns `{ok, running, cursor, truncated, total}`, where the
   * cursor is the record `runSync` writes to `syncState.feed`. Its field names are
   * the crawl's, not the push's, so they are mapped here explicitly:
   * `nextPage -> page`, `pagesDone -> pagesDone`, `totalSeen -> seen`, `state -> state`.
   * The cursor carries no `added` and no ETA (those only exist in the live
   * `SYNC_PROGRESS` push), so those are simply left untouched rather than invented.
   *
   * @param {object|null} cursor
   * @returns {boolean} whether a usable cursor was mapped
   */
  function applySyncCursor(cursor) {
    if (!cursor || typeof cursor !== 'object') return false;
    applySyncProgress({
      page: cursor.nextPage,
      pagesDone: cursor.pagesDone,
      seen: cursor.totalSeen,
      state: cursor.state
    });
    if (typeof cursor.maxPages === 'number' && cursor.maxPages > 0) {
      // Real, not guessed: this is the cap that produced the truncation, which is
      // what the banner's "bigger cap" action doubles.
      state.sync.maxPages = cursor.maxPages;
    }
    if (cursor.truncated === true) state.sync.truncated = true;
    state.sync.lastError = cursor.lastError ? String(cursor.lastError) : '';
    return true;
  }

  function applySyncProgress(p) {
    if (!p) return;
    if (typeof p.page === 'number') state.sync.page = p.page;
    if (typeof p.pagesDone === 'number') state.sync.pagesDone = p.pagesDone;
    if (typeof p.seen === 'number') state.sync.seen = p.seen;
    if (typeof p.added === 'number') state.sync.added = p.added;
    if (typeof p.etaMs === 'number') state.sync.etaMs = p.etaMs;
    if (p.state) {
      state.sync.state = String(p.state);
      if (p.state !== 'running') state.sync.running = false;
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
    const parts = [s.running ? 'running' : (s.state || 'idle')];
    if (s.page) parts.push('page ' + s.page + (s.maxPages ? '/' + s.maxPages : ''));
    if (s.pagesDone) parts.push(s.pagesDone + ' pages done');
    parts.push(s.seen + ' seen');
    if (s.added) parts.push(s.added + ' added');
    // How many clips are actually indexed on disk — the number the user cares about.
    if (s.total) parts.push(s.total + ' indexed');
    parts.push('eta ' + fmtEta(s.etaMs));
    ui.syncState.textContent = parts.join(' · ');

    const fill = ui.syncBar ? ui.syncBar.firstChild : null;
    if (fill) {
      // The denominator is the page CAP, not the pages already done: dividing by
      // `pagesDone` (the old behaviour) made the bar jump to 100% after one page.
      const denom = s.maxPages || s.pagesDone || 0;
      const pct = denom ? Math.min(100, Math.round((s.page / denom) * 100)) : 0;
      fill.style.width = (s.running ? pct : (s.state === 'done' ? 100 : 0)) + '%';
    }
    const dot = ui.syncChip ? ui.syncChip.firstChild : null;
    if (dot) dot.className = 'sm-sync-dot ' + (s.running ? 'run' : (s.state === 'done' ? 'ok' : ''));
    if (ui.syncChip && ui.syncChip.lastChild) {
      ui.syncChip.lastChild.textContent = s.state === 'done'
        ? (s.lastDurationMs ? Math.round(s.lastDurationMs / 1000) + 's' : 'synced')
        : (s.state || 'not synced');
    }
    if (ui.truncWarn) {
      const detail = ui.truncWarn.querySelector('.sm-trunc-detail');
      if (detail) {
        detail.textContent = [
          s.pagesDone ? s.pagesDone + ' of ' + (s.maxPages || '?') + ' pages crawled' : '',
          s.total ? s.total + ' clips indexed' : '',
          s.lastError ? 'last error: ' + s.lastError : ''
        ].filter(Boolean).join(' · ');
      }
      // A dismissal is session-scoped: routine status polls must not resurrect it.
      ui.truncWarn.classList.toggle('on', !!s.truncated && !s.truncateDismissed);
    }
  }

  function onSyncDone(m) {
    state.sync.running = false;
    state.sync.state = 'done';
    state.sync.seen = typeof m.total === 'number' ? m.total : state.sync.seen;
    state.sync.added = typeof m.total === 'number' ? m.total : state.sync.added;
    state.sync.truncated = !!m.truncated;
    state.sync.lastDurationMs = Number(m.durationMs) || 0;
    state.sync.lastProjects = Number(m.projects) || 0;
    renderSync();
    if (state.sync.truncated) {
      showError('Sync hit the page cap — the local library is INCOMPLETE. Raise the page cap and re-sync before trusting counts.');
      toast('Sync truncated: library incomplete', 6000);
    } else {
      toast('Sync complete: ' + state.sync.seen + ' clips' +
        (state.sync.lastProjects ? ' across ' + state.sync.lastProjects + ' projects' : ''));
    }
    refreshResults(true);
    refreshFacets();
    loadProjects();
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
      fail('GET_QUOTA', { message: res.error });
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

  const HLS_PATCH = [
    '(function(){try{',
    'if(window.__smHlsActive){window.__smHlsPatchError="already active";return;}',
    'window.__smHlsActive=true;',
    'window.__smHlsHadMS=("MediaSource" in window);',
    'try{window.__smHlsSavedMS=window.MediaSource;}catch(e){window.__smHlsSaveError=String(e&&e.message||e);window.__smHlsSavedMS=undefined;}',
    'try{window.MediaSource=undefined;}catch(e2){window.__smHlsPatchError=String(e2&&e2.message||e2);}',
    '}catch(e3){window.__smHlsPatchError=String(e3&&e3.message||e3);}})();'
  ].join('');

  const HLS_RESTORE = [
    '(function(){try{',
    'if(!window.__smHlsActive){window.__smHlsRestoreNote="not active";return;}',
    'try{',
    'if(window.__smHlsHadMS){window.MediaSource=window.__smHlsSavedMS;}',
    'else{delete window.MediaSource;if("MediaSource" in window){window.MediaSource=undefined;}}',
    '}catch(e){window.__smHlsRestoreError=String(e&&e.message||e);}',
    'window.__smHlsActive=false;window.__smHlsHadMS=false;window.__smHlsSavedMS=undefined;',
    '}catch(e2){window.__smHlsRestoreError=String(e2&&e2.message||e2);}})();'
  ].join('');

  function runMainWorld(code) {
    try {
      const el = document.createElement('script');
      el.textContent = code;
      const host = document.head || document.documentElement;
      if (!host) return false;
      host.appendChild(el);
      el.remove();
      return true;
    } catch (e) {
      dbg('main-world injection failed:', e && e.message);
      return false;
    }
  }

  function setHlsStatus(txt) {
    if (ui.hlsStatus) ui.hlsStatus.textContent = txt;
  }

  async function confirmHls() {
    if (ui.hlsEnable) ui.hlsEnable.checked = false;
    const answer = window.confirm([
      'Enable HLS stream capture for this session?',
      '',
      'This temporarily sets window.MediaSource = undefined in the page MAIN world so',
      "Suno's player falls back to a plain fetch, then reads the resulting",
      'manifest.m3u8 (#EXT-X-MAP init segment + media segments).',
      '',
      'It manipulates the page and is restored in a finally block.',
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
    setHlsStatus('arming: waiting for Suno to expose an m3u8 stream…');
    try {
      const injected = runMainWorld(HLS_PATCH);
      if (!injected) throw new Error('could not reach the page MAIN world');
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
      // ALWAYS restore the page, whatever happened above.
      runMainWorld(HLS_RESTORE);
      state.hls.active = false;
      setHlsStatus('idle — window.MediaSource restored');
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
   * 21. token relay
   * ================================================================== */

  // Injected into the page MAIN world to read window.Clerk. Strings only, and the
  // reply is validated by BOTH source and origin before it is trusted.
  const CLERK_ORIGIN = JSON.stringify(String(location.origin || ''));
  const CLERK_SCRIPT = [
    '(async function(){try{',
    'var o=0;',
    'for(;(!window.Clerk||!window.Clerk.session)&&o<40;){await new Promise(function(r){setTimeout(r,500);});o++;}',
    'if(window.Clerk&&window.Clerk.session){',
    'var t=await window.Clerk.session.getToken();',
    'window.postMessage({source:"suno-master-dock",kind:"token",token:t},' + CLERK_ORIGIN + ');',
    '}else{window.postMessage({source:"suno-master-dock",kind:"token-error",error:"Clerk not available"},' + CLERK_ORIGIN + ');}',
    '}catch(e){window.postMessage({source:"suno-master-dock",kind:"token-error",error:String(e&&e.message||e)},' + CLERK_ORIGIN + ');}',
    '})();'
  ].join('');

  let clerkTried = false;

  function requestPageToken() {
    if (!document.body && !document.documentElement) {
      toast('document not ready yet');
      return;
    }
    clerkTried = true;
    const ok = runMainWorld(CLERK_SCRIPT);
    if (!ok) showError('could not inject the Clerk reader (no document element yet)');
  }

  function setupTokenRelay() {
    window.addEventListener('message', (event) => {
      try {
        // BOTH checks are required: origin alone would let any same-origin script
        // (or an injected <script>) overwrite the extension's credential for the
        // whole profile.
        if (event.source !== window) return;
        if (event.origin !== location.origin) return;
        const d = event.data;
        if (!d || typeof d !== 'object') return;
        if (d.source !== 'suno-master-dock' || d.kind !== 'token') return;
        const token = typeof d.token === 'string' ? d.token.trim() : '';
        if (!TOKEN_RE.test(token)) {
          fail('page token', { message: 'rejected: malformed token' });
          return;
        }
        storeToken(token, 0);
      } catch (e) {
        dbg('token relay handler error:', e && e.message);
      }
    });
  }

  async function storeToken(token, expiresAt) {
    state.token = token;
    state.tokenExpiresAt = Number(expiresAt) || 0;
    state.tokenHas = true;
    renderTokenInfo();
    const res = await send('SET_TOKEN', { token: token, expiresAt: state.tokenExpiresAt });
    if (!res.ok) {
      state.tokenHas = false;
      fail('SET_TOKEN', { message: res.error });
    }
  }

  function renderTokenInfo() {
    if (!ui.tokenInfo) return;
    const bits = [];
    // `state.token` holds ONLY a raw JWT the page relay handed over. The worker
    // reports STATUS, never the credential, so presence is tracked separately.
    bits.push(state.tokenHas ? 'worker: token present' : 'worker: no token');
    if (state.token) bits.push('page relay: ' + state.token.length + ' chars');
    if (state.tokenExpiresAt) bits.push('expires ' + new Date(state.tokenExpiresAt).toLocaleTimeString());
    else bits.push('expiry unknown');
    ui.tokenInfo.textContent = bits.join(' · ');
    // A rejected-but-unexpired token needs its own colour; `.sm-bad` has no rule
    // for this element, so the emphasis is inline.
    ui.tokenInfo.setAttribute('style', state.tokenBad ? 'color:#fecaca;' : '');
  }

  /**
   * Read the worker's `tokenStatus()` OBJECT.
   *
   * `GET_BOOT.token` and `GET_TOKEN_STATUS.token` are both
   * `{hasToken, expiresAt, secondsRemaining, source, badToken}` — an OBJECT. The
   * previous guard was `TOKEN_RE.test(String(res.token))`, and
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
    renderTokenInfo();
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
    // No token in the worker: the page MAIN world is the only source of a raw JWT.
    requestPageToken();
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

  async function mount() {
    if (state.mounted) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    state.mounted = true;

    // ---- shadow host -------------------------------------------------
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

    // ---- wire the SW --------------------------------------------------
    setupTokenRelay();
    const bootRes = await send('REGISTER_TAB', {
      url: location.href,
      path: location.pathname,
      title: document.title
    });
    if (!bootRes.ok) fail('REGISTER_TAB', { message: bootRes.error });

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
      fail('GET_BOOT', { message: boot.error });
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

    if (!clerkTried) requestPageToken();
    dbg('mounted; stylesheet source:', cssText ? 'content/content.css' : 'fallback');
  }

  let errorOnceShown = false;

  function showErrorOnce(msg) {
    if (errorOnceShown) return;
    errorOnceShown = true;
    showError(msg);
  }

  function destroy() {
    detachObserver();
    removeRowControls();
    state.mounted = false;
    const host = document.getElementById(HOST_ID);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    dbg('destroyed');
  }

  /* ================================================================== *
   * 23. pushes from the service worker
   * ================================================================== */

  chrome.runtime.onMessage.addListener((msg) => {
    try {
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'SYNC_PROGRESS':
          applySyncProgress(msg);
          renderSync();
          break;

        case 'SYNC_DONE':
          onSyncDone(msg);
          break;

        case 'SYNC_ERROR':
          state.sync.running = false;
          state.sync.state = 'error';
          renderSync();
          showError('Sync failed: ' + (msg.error || 'unknown'));
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
          // route — so this only LISTENS. The payload carries the new expiry only.
          state.tokenExpiresAt = Number(msg.expiresAt) || 0;
          state.tokenHas = state.tokenExpiresAt > 0;
          renderTokenInfo();
          break;

        default:
          // Unknown push: ignore silently rather than logging noise.
          break;
      }
    } catch (e) {
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