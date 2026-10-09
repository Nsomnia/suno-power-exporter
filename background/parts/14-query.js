/**
 * 14. QUERY, SELECTION, PROJECTS — the read side of the extension's own
 * IndexedDB copy, plus the one mass-download primitive the UI can express.
 *
 * Extracted verbatim from `background/background.js` section 14. Read
 * `background/parts/15-quota.js` first: it states the mechanism, the hoisting
 * rule, and why a part must not re-bind its own names on the worker side.
 *
 * WHY IT IS SAFE TO EXTRACT: like §8, this section owns NO mutable module-scope
 * state. Everything it needs from the monolith (`DB`, `META_KEYS`,
 * `STORAGE_KEYS`, `ALL_CLIPS`, `FILTER_AVAILABLE`, `SunoFilter`,
 * `SunoAPIClient`, `loadSettings`, `loadClipsByIds`, `OpError`, `log`,
 * `describeError`) is read inside a function body, and one of them —
 * `loadClipsByIds` — is declared in §12, far below this file's call sites.
 * That is the hoisting case that matters: it works because §12's declaration is
 * a `function`, so it is bound before any of this runs, and because the
 * reference lives in a body that is not entered until the router dispatches.
 *
 * WHO CALLS IN, which is why these nine stay hoisted globals rather than
 * becoming properties:
 *
 *   §12 BATCH DRIVER   `readSelectionIds` (plan a batch from a saved list),
 *                      `queryContext` (the same projects + dislike set the
 *                      crawler gets), `loadProjectNames` (workspace labels for
 *                      the filename template).
 *   §16 ROUTER         `queryClips`, `queryFacets`, `queryProjects`,
 *                      `setSelection`, `getSelection` — one handler each.
 *
 * All five router references are inside handler bodies, so they are call-time
 * too. Nothing here reads a section-14 binding at load time.
 *
 * `isSyncTruncated` is section-LOCAL (its only two readers are `queryClips`
 * and `queryFacets`, both above it in this file) and is published anyway,
 * because "is the stored library known to be short?" is a question other
 * surfaces will ask and this is where the answer is defined.
 */

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

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see `background/parts/15-quota.js`
 * for why the worker calls these as bare globals rather than destructuring
 * them here. `scripts/check-build.sh` asserts that none of these names
 * collides with a monolith declaration, which is the one failure mode of this
 * mechanism that produces no error at all.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUQuery = {
    queryContext, queryClips, isSyncTruncated, queryFacets,
    queryProjects, loadProjectNames, setSelection, getSelection, readSelectionIds,
  };
}
