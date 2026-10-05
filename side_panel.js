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
    /** clipId -> {button, note} so a DL_ITEM can flip the row it belongs to. */
    rows: new Map()
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

  /**
   * Last-resort reporter. Every action handles its own failures; this exists so
   * nothing in this file can end as an unhandled promise rejection.
   *
   * @param {unknown} err
   */
  function reportUnexpected(err) {
    showError('Unexpected failure: ' + textOf(err));
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

  /** @param {string} message */
  function announce(message) {
    setText(C.announce, message);
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

  /* ------------------------------------------------------------ transport */

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
          throw ReqError(reply.error || (type + ' failed'), reply.code || 'failed');
        }
        return reply;
      },
      function (transportErr) {
        throw ReqError('The background worker is not reachable (' + textOf(transportErr) + ').', 'no_worker');
      }
    );
  }

  /* --------------------------------------------------------------- facets */

  /**
   * Show the incompleteness banner with the same wording whatever surfaced it.
   *
   * @param {string} [detail]
   */
  function showTruncated(detail) {
    C.truncated.hidden = false;
    setText(
      C.truncatedText,
      (detail ? detail + ' ' : '')
      + 'The last sync hit its page cap, so this index is INCOMPLETE and some clips are missing. '
      + 'Raise "Max pages per sync" in Settings and sync again.'
    );
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

    if (reply.truncated === true) {
      showTruncated();
    }
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
    var label = String(clip.title || '').trim() || 'untitled';
    button.setAttribute('aria-label', 'Download ' + label + ' (' + String(clip.id || 'unknown clip') + ')');
    button.addEventListener('click', function () {
      void downloadOne(clip, button, note).catch(reportUnexpected);
    });
    row.appendChild(button);

    if (clip.id) state.rows.set(String(clip.id), { button: button, note: note });

    return row;
  }

  /** @param {string|null} message */
  function renderEmpty(message) {
    state.rows.clear();
    C.list.textContent = '';
    var empty = document.createElement('li');
    empty.className = 'sp-empty';
    empty.textContent = message;
    C.list.appendChild(empty);
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

        if (reply.truncated === true) showTruncated();

        if (!state.clips.length) {
          renderEmpty(state.query
            ? 'No indexed clip matches “' + state.query + '”.'
            : 'Your library is empty. Run a sync from the toolbar popup or the side panel to build the index.');
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

        // Facets are a second, cheap call, and only after the rows are on
        // screen: a failed facet call must not hold up the list.
        return refreshFacets().catch(function (err) {
          dbg('GET_FACETS failed:', textOf(err));
        });
      },
      function (err) {
        if (seq !== state.seq) return;
        state.loading = false;
        C.more.disabled = false;
        var message = textOf(err);
        showError(message);
        if (!state.clips.length) renderEmpty('Could not read the library: ' + message);
        setText(C.status, 'Query failed.');
      }
    );
  }

  function refreshFacets() {
    return send('GET_FACETS', { spec: buildSpec() }).then(function (reply) {
      renderFacets(reply);
    });
  }

  /** @param {object[]} clips @param {boolean} append */
  function renderRows(clips, append) {
    if (!append) {
      C.list.textContent = '';
      state.rows.clear();
    }
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < clips.length; i += 1) {
      fragment.appendChild(buildRow(clips[i]));
    }
    C.list.appendChild(fragment);
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

  /* ------------------------------------------------------------------ wire */

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

  function listenForPushes() {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg.type !== 'string') return;
      try {
        switch (msg.type) {
          case 'DL_ITEM':
            applyDlItem(msg);
            break;
          case 'SYNC_DONE':
            // The index changed under us; a truncated crawl must be surfaced.
            if (msg.truncated === true) {
              showTruncated();
              announce('Sync finished but the library is incomplete.');
            }
            void runQuery(false).catch(reportUnexpected);
            break;
          case 'SYNC_ERROR':
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
      // The panel is still usable without settings: the row download falls back
      // to the worker's own defaults for anything missing from the payload.
      showError('Could not read settings; downloads will use the worker defaults. ' + textOf(err));
    }
  }

  async function boot() {
    wireSearch();
    listenForPushes();
    await loadSettings();
    try {
      await runQuery(false);
    } catch (err) {
      showError('Could not load the library: ' + textOf(err));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();