/**
 * Suno Master Utility - lib/db.js
 * IndexedDB persistence layer for the MASS downloader (10k+ clips, resumable batches).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS A REWRITE (the six bugs it fixes)
 * ---------------------------------------------------------------------------
 * 1. LEAKED CONNECTIONS. The old `_checkLegacyMigration()` opened THREE
 *    IndexedDB connections, closed one, and dropped the other two on the floor.
 *    Legacy reads now live in `migrateLegacy()`, which opens at most one legacy
 *    handle, closes it in a `finally`, and only after `indexedDB.databases()`
 *    has PROVEN the database exists.
 * 2. ACCIDENTAL CREATION + HANG. `indexedDB.open('SunoLibraryDB')` with no
 *    version CREATES an empty database as a side effect and, with no
 *    `onblocked`/`onerror` timeout, `init()` could hang forever. `open()` now
 *    carries a hard timeout, an `onblocked` handler, and never opens a
 *    database it has not first confirmed exists.
 * 3. GUARD ON THE RESOLVED VALUE. `if (this.db) return this.db` lets concurrent
 *    `init()` calls all pass before any of them resolves, so N tabs/calls each
 *    run their own `indexedDB.open`. `open()` memoizes the IN-FLIGHT PROMISE
 *    (`_openPromise`), so N concurrent calls perform exactly ONE open.
 * 4. VERSION PINNED AT 1. `onupgradeneeded` only ever created a store if
 *    absent, so no schema change was expressible. Schema creation is now
 *    idempotent AND versioned: additive branches `oldVersion < 1 / < 2 / < 3`,
 *    plus a resumable derived-column backfill for rows written by older builds.
 * 5. INDEX CONFLICT / NAME COLLISION. `lib/db.js` and `background/background.js`
 *    both opened `SunoMasterDB` v1 with disjoint index sets; whoever won
 *    `onupgradeneeded` permanently starved the other. FIX: this module owns
 *    `suno-library` v3 exclusively. Nothing else opens it, it declares every
 *    index it needs, and old databases are only ever READ (opt-in
 *    `migrateLegacy()`), never upgraded.
 * 6. NO VERSION NEGOTIATION. Both old opens lacked `onblocked` and
 *    `onversionchange`. Every open now attaches both: `onversionchange` closes
 *    and clears the memo (so the next call reopens at the new version), and
 *    `onblocked` rejects with a typed `SunoDBError` after a timeout.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA (owned exclusively by this file)
 * ---------------------------------------------------------------------------
 * clips      keyPath id
 *   created_at, is_liked, major_model_version, status, is_trashed, is_public,
 *   play_count, upvote_count        -- filter dimensions
 *   project_ids  (multiEntry)       -- "every clip in workspace X" in one lookup
 *   title_lower                    -- case-insensitive title search
 * downloads  keyPath ['clipId','variant']  -- per-format dedupe for free
 *   state, clipId, startedAt, finishedAt
 * syncState  keyPath key            -- resumable crawl cursors (feed/projects/playlists)
 *   updatedAt
 * journal    keyPath id (autoIncrement)    -- append-only batch event log
 *   batchId_ts (compound), ts
 * meta       keyPath key            -- schema marker, quota cache, settings mirror
 *
 * ---------------------------------------------------------------------------
 * TWO INVARIANTS ENFORCED HERE - READ BEFORE ADDING CODE
 * ---------------------------------------------------------------------------
 * A. `state:'done'` is written ONLY by `downloads.markDone()`, and only when
 *    the caller passes an OBSERVED completion event: a `chrome.downloads`
 *    `onChanged`/`onDeterminingFilename` with a verified `state === 'complete'`,
 *    or a post-stream filesystem stat that confirmed the byte count on disk.
 *    NEVER mark a row done because `chrome.downloads.download()` RETURNED AN
 *    ID - that call only means "the browser accepted the request". The old
 *    code marked everything done on that basis, which permanently blocked
 *    retries for every clip that later failed, 403'd, or was evicted mid-flight.
 *    Enforced by: `markDone()` refusing a missing observation proof, and
 *    `resetInProgress()` returning stale rows to a retryable state.
 * B. IndexedDB transactions AUTO-COMMIT. See the loud note on
 *    `transaction()` below. Awaiting non-IDB work inside `fn` is the classic
 *    silent failure mode of this API.
 *
 * Environment: MV3 service worker, content script, options page, popup, and
 * `module.exports` under Node (with an injected `indexedDB` implementation for
 * tests). No DOM access, no globals leaked, no console statements.
 */
(function () {
  'use strict';

  /* ===================================================================== *
   * 0. ENVIRONMENT RESOLUTION (no DOM, works in MV3 SW + content script)
   * ===================================================================== */

  var GLOBAL =
    typeof globalThis !== 'undefined'
      ? globalThis
      : typeof self !== 'undefined'
        ? self
        : typeof window !== 'undefined'
          ? window
          : {};

  /** No-op logger. Every log site goes through this; nothing prints by default. */
  var NOOP_LOGGER = {
    debug: function () {},
    info: function () {},
    warn: function () {},
    error: function () {},
  };

  function normalizeLogger(injected) {
    if (!injected) return NOOP_LOGGER;
    if (typeof injected === 'function') {
      return {
        debug: injected,
        info: injected,
        warn: injected,
        error: injected,
      };
    }
    var pick = function (level) {
      return typeof injected[level] === 'function' ? injected[level] : NOOP_LOGGER[level];
    };
    return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') };
  }

  function resolveIDB(injected) {
    if (injected) return injected;
    if (typeof GLOBAL.indexedDB !== 'undefined' && GLOBAL.indexedDB) return GLOBAL.indexedDB;
    return null;
  }

  function resolveNav() {
    return typeof GLOBAL.navigator !== 'undefined' && GLOBAL.navigator ? GLOBAL.navigator : null;
  }

  function resolveKeyRange(injected) {
    if (injected) return injected;
    if (typeof GLOBAL.IDBKeyRange !== 'undefined' && GLOBAL.IDBKeyRange) return GLOBAL.IDBKeyRange;
    return null;
  }

  function now() {
    return Date.now();
  }

  /**
   * `limit < 0` means UNLIMITED (used by the legacy whole-table reads, which
   * for a 10k library must materialise everything by definition). Any other
   * non-positive or absent value falls back to the configured default.
   */
  function normalizeLimit(value, fallback) {
    if (!isFiniteNumber(value)) return fallback;
    if (value < 0) return Infinity;
    if (value === 0) return fallback;
    return value;
  }

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /* ===================================================================== *
   * 1. SunoDBError - every public method rejects with this, never a bare
   *    DOMException. `code` is stable and switchable; `cause` is the original.
   * ===================================================================== */

  var ERROR_CODES = {
    IDB_UNAVAILABLE: 'IndexedDB implementation unavailable (inject { indexedDB }).',
    INVALID_ARGUMENT: 'Invalid argument.',
    INVALID_RECORD: 'Record is not structured-cloneable.',
    OPEN_FAILED: 'indexedDB.open() failed.',
    OPEN_TIMEOUT: 'indexedDB.open() never completed.',
    BLOCKED: 'Database upgrade blocked by another connection.',
    VERSION_CHANGE: 'Database was closed by a version change from another context.',
    TX_INVALID: 'Could not start transaction (store missing or bad mode).',
    TX_INACTIVE: 'Transaction auto-committed because a non-IDB await happened inside it.',
    TX_ABORTED: 'Transaction aborted; all writes in it were rolled back.',
    TX_FAILED: 'Transaction failed.',
    QUOTA_EXCEEDED: 'Origin storage quota exceeded.',
    NOT_FOUND: 'Record not found.',
    CONSTRAINT: 'Record violates an index constraint.',
    DATA_ERROR: 'IndexedDB rejected the data.',
    UNSUPPORTED: 'Environment does not support this operation.',
  };

  function quotaAdvice() {
    return (
      ' Origin storage is full. This library is sized for 10k+ clips plus a ' +
      'download history. Actionable fixes, cheapest first: (1) ' +
      'downloads.pruneCompleted(7*24*3600*1000) to drop old history rows; ' +
      '(2) journal.trim(batchId) for finished batches; (3) clips.bulkReplace([...]) ' +
      'to drop trashed clips in one atomic transaction; (4) export with ' +
      'exportJson() before pruning; (5) as a last resort ' +
      'navigator.storage.persist() or prune downloaded media off disk. ' +
      'Call estimate() for current usage/quota.'
    );
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {{store?: string, cause?: *, hint?: string}} [info]
   */
  function SunoDBError(code, message, info) {
    var err = Error.call(this, message || ERROR_CODES[code] || code);
    this.name = 'SunoDBError';
    this.message = message || ERROR_CODES[code] || code;
    this.code = code || 'UNKNOWN';
    this.store = (info && info.store) || null;
    if (info && info.hint) this.hint = info.hint;
    if (info && info.cause !== undefined) this.cause = info.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SunoDBError);
    else this.stack = err.stack || new Error(this.message).stack;
  }
  SunoDBError.prototype = Object.create(Error.prototype);
  SunoDBError.prototype.constructor = SunoDBError;
  SunoDBError.prototype.name = 'SunoDBError';

  SunoDBError.isBlocked = function (e) {
    return !!e && (e.code === 'BLOCKED' || e.code === 'VERSION_CHANGE');
  };
  SunoDBError.isQuotaExceeded = function (e) {
    if (!e) return false;
    if (e.code === 'QUOTA_EXCEEDED') return true;
    // Inspect the error's OWN name too, not just the wrapped cause, so a bare
    // DOMException handed in from calling code is still recognised.
    if (typeof e.name === 'string' && /quota/i.test(e.name)) return true;
    var cause = e.cause;
    return !!cause && typeof cause.name === 'string' && /quota/i.test(cause.name);
  };
  SunoDBError.isNotFound = function (e) {
    return !!e && e.code === 'NOT_FOUND';
  };

  function domName(e) {
    return e && typeof e.name === 'string' ? e.name : '';
  }

  function classify(error, store) {
    if (error instanceof SunoDBError) return error;
    var name = domName(error);
    var msg = (error && error.message) || String(error || 'unknown error');
    var info = { store: store || null, cause: error };
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return new SunoDBError('QUOTA_EXCEEDED', ERROR_CODES.QUOTA_EXCEEDED + quotaAdvice(), info);
    }
    if (name === 'DataError') return new SunoDBError('DATA_ERROR', msg, info);
    if (name === 'DataCloneError') {
      return new SunoDBError(
        'INVALID_RECORD',
        'Record is not structured-cloneable (it carries a function, symbol, or DOM node): ' + msg,
        info
      );
    }
    if (name === 'ConstraintError') return new SunoDBError('CONSTRAINT', msg, info);
    if (name === 'TransactionInactiveError') {
      // A caller bug, not a transient failure: retrying the same code fails
      // identically, so it gets its own code rather than being filed as an
      // ordinary abort.
      return new SunoDBError(
        'TX_INACTIVE',
        ERROR_CODES.TX_INACTIVE +
          ' Something non-IndexedDB was awaited inside transaction(fn) - almost always a ' +
          'fetch, a timer, or another SunoDB call. Await only IDB requests inside fn; do the ' +
          'async work before opening the transaction. (' + msg + ')',
        info
      );
    }
    if (name === 'InvalidStateError' || name === 'NotFoundError') {
      return new SunoDBError('NOT_FOUND', msg, info);
    }
    if (name === 'AbortError') return new SunoDBError('TX_ABORTED', ERROR_CODES.TX_ABORTED, info);
    return new SunoDBError('TX_FAILED', msg, info);
  }

  /* ===================================================================== *
   * 2. SCHEMA DEFINITION - the single source of truth.
   *    Every store/index in here is created idempotently, and this module is
   *    the ONLY thing in the extension allowed to open `suno-library`.
   * ===================================================================== */

  var STORES = {
    CLIPS: 'clips',
    DOWNLOADS: 'downloads',
    SYNC_STATE: 'syncState',
    JOURNAL: 'journal',
    META: 'meta',
  };

  var ALL_STORE_NAMES = [
    STORES.CLIPS,
    STORES.DOWNLOADS,
    STORES.SYNC_STATE,
    STORES.JOURNAL,
    STORES.META,
  ];

  // [indexName, keyPath, options]
  var CLIP_INDEXES = [
    ['created_at', '_i.created_at', {}],
    ['is_liked', '_i.is_liked', {}],
    ['major_model_version', '_i.major_model_version', {}],
    ['status', '_i.status', {}],
    ['is_trashed', '_i.is_trashed', {}],
    ['is_public', '_i.is_public', {}],
    ['project_ids', '_i.project_ids', { multiEntry: true }],
    ['title_lower', '_i.title_lower', {}],
    ['play_count', '_i.play_count', {}],
    ['upvote_count', '_i.upvote_count', {}],
  ];

  var DOWNLOAD_INDEXES = [
    ['state', 'state', {}],
    ['clipId', 'clipId', {}],
    ['startedAt', 'startedAt', {}],
    ['finishedAt', 'finishedAt', {}],
  ];

  var JOURNAL_INDEXES = [
    ['batchId_ts', ['batchId', 'ts'], {}],
    ['ts', 'ts', {}],
  ];

  var SYNC_STATE_INDEXES = [['updatedAt', 'updatedAt', {}]];

  var STORE_INDEXES = {};
  STORE_INDEXES[STORES.CLIPS] = CLIP_INDEXES;
  STORE_INDEXES[STORES.DOWNLOADS] = DOWNLOAD_INDEXES;
  STORE_INDEXES[STORES.SYNC_STATE] = SYNC_STATE_INDEXES;
  STORE_INDEXES[STORES.JOURNAL] = JOURNAL_INDEXES;
  STORE_INDEXES[STORES.META] = [];

  function keyPathFor(storeName) {
    switch (storeName) {
      case STORES.CLIPS:
        return 'id';
      case STORES.DOWNLOADS:
        return ['clipId', 'variant'];
      case STORES.SYNC_STATE:
        return 'key';
      case STORES.JOURNAL:
        return 'id';
      case STORES.META:
        return 'key';
      default:
        return null;
    }
  }

  function createOptionsFor(storeName) {
    if (storeName === STORES.JOURNAL) return { keyPath: 'id', autoIncrement: true };
    return { keyPath: keyPathFor(storeName) };
  }

  function ensureStore(db, tx, storeName, logger) {
    if (db.objectStoreNames.contains(storeName)) return tx.objectStore(storeName);
    var created = db.createObjectStore(storeName, createOptionsFor(storeName));
    if (logger) logger.debug('db: created store ' + storeName);
    return created;
  }

  function ensureIndexes(store, storeName, logger) {
    var defs = STORE_INDEXES[storeName] || [];
    for (var i = 0; i < defs.length; i++) {
      var name = defs[i][0];
      if (store.indexNames.contains(name)) continue;
      var opts = {};
      if (defs[i][2]) {
        if (defs[i][2].multiEntry) opts.multiEntry = true;
        if (defs[i][2].unique) opts.unique = true;
      }
      store.createIndex(name, defs[i][1], opts);
      if (logger) logger.debug('db: created index ' + storeName + '.' + name);
    }
  }

  /* ===================================================================== *
   * 3. CLIP SANITIZATION + DERIVED COLUMN BLOCK
   * ===================================================================== */

  /**
   * Recon (scratchpad/captured_endpoints.json) captured BOTH
   *   GET https://studio-api.prod.suno.com/api/forbidden
   *   GET https://studio-api.prod.suno.com/api/forbidden.webm
   * and the shipped web bundle points `audio_url` at the same constant
   * decoy while bare `cdn1.suno.ai` / `cdn2.suno.ai` paths are unsigned.
   * A 111-byte 403 XML body gets served with an .mp3-ish name, which is why
   * the old downloader wrote "done" rows for files that were never audio.
   * => Persisting the decoy is worse than useless: it is a poisoned constant
   *    that every future reader would have to re-detect. We null it and flag it.
   * The REAL media URL lives in `media_urls[]` (signed CloudFront) or must be
   * fetched from /api/download/clip/{id} (mp3) and /api/gen/{id}/wav_file/.
   */
  var FORBIDDEN_PATH = '/api/forbidden';
  var DEAD_AUDIO_HOSTS = [
    'cdn1.suno.ai',
    'cdn2.suno.ai',
    'cdn-o.suno.com',
    'd2lwuy8qc234o3.cloudfront.net', // real host, but unsigned paths 403
    'studio-api-prod.suno.com',
    'studio-api.prod.suno.com',
  ];
  var MEDIA_EXT_RE = /\.(mp3|wav|m4a|ogg|webm|flac|aac)(\?|#|$)/i;

  function isDecoyAudioUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return true;
    var m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url.trim());
    if (!m) return true;
    var host = m[1].toLowerCase();
    var path = m[2] || '/';
    if (path === FORBIDDEN_PATH || path === FORBIDDEN_PATH + '/') return true;
    if (DEAD_AUDIO_HOSTS.indexOf(host) !== -1) return !MEDIA_EXT_RE.test(path);
    return false;
  }

  /** Depth-limited walk of `media_urls` (string | string[] | nested object). */
  function findRealMediaUrl(node, depth) {
    if (depth > 4 || node === null || node === undefined) return null;
    if (typeof node === 'string') return isDecoyAudioUrl(node) ? null : node.trim();
    if (Array.isArray(node)) {
      var fallback = null;
      for (var i = 0; i < node.length; i++) {
        var got = findRealMediaUrl(node[i], depth + 1);
        if (!got) continue;
        if (/\.m4a(\?|#|$)/i.test(got)) return got;
        if (!fallback) fallback = got;
      }
      return fallback;
    }
    if (typeof node === 'object') {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var found = findRealMediaUrl(node[keys[k]], depth + 1);
        if (found) return found;
      }
      return null;
    }
    return null;
  }

  /** DRM/licence secrets must never reach disk. See class header note A. */
  var SECRET_KEYS = [
    'rights',
    'glt',
    'key',
    'iv',
    'keys',
    'key_hex',
    'private_key',
    'drm',
    'drm_key',
    'license',
    'license_token',
    'token',
    'tokens',
    'jwt',
    'authorization',
    'auth',
    'cookie',
    'cookies',
    'session',
    'access_token',
    'refresh_token',
    'browser_token',
    'password',
    'secret',
    'client_secret',
    'credits_grant',
  ];

  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    // Date / RegExp / Map / typed arrays must be left intact: rebuilding them
    // as `{}` would silently destroy real clip fields.
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  /** Strip secrets + function values at the top level and one level down. */
  function sanitizeObject(obj, depth) {
    var out = {};
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (SECRET_KEYS.indexOf(k) !== -1) continue;
      var v = obj[k];
      if (typeof v === 'function' || typeof v === 'symbol') continue;
      if (depth > 0 && isPlainObject(v)) {
        out[k] = sanitizeObject(v, depth - 1);
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  function toIsoString(value) {
    if (typeof value === 'string' && value.trim()) return value;
    if (isFiniteNumber(value)) return new Date(value).toISOString();
    return undefined;
  }

  function toCount(value) {
    return isFiniteNumber(value) ? value : undefined;
  }

  function toText(value) {
    if (typeof value === 'string' && value) return value;
    if (isFiniteNumber(value)) return String(value);
    return undefined;
  }

  function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function uniqueStrings(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (typeof s !== 'string' || !s) continue;
      if (seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  function deriveStatus(clip, meta) {
    var raw = firstDefined(clip.status, meta.status);
    if (typeof raw === 'string' && raw) return raw;
    if (meta.error_message) return 'error';
    if (meta.stream === false) return 'pending';
    if (clip.status === 'streaming') return 'streaming';
    return 'complete';
  }

  /**
   * Build the stored record: the RAW clip (sanitized) plus a small derived
   * column block `_i`. Indexes point at `_i.*` so the raw payload stays
   * byte-faithful to the API response and the derived block is trivially
   * recomputable/rebuildable (`clips.backfillDerived()`).
   *
   * IndexedDB only accepts number/date/string/buffer/array as index keys, so
   * every derived column is coerced: booleans -> 0|1 (always indexable),
   * missing scalars -> `undefined` (record simply omitted from that index,
   * which is a non-error and exactly what we want for absent values).
   */
  function buildClipRecord(clip) {
    var raw = sanitizeObject(clip, 2);
    var meta = isPlainObject(raw.metadata) ? raw.metadata : {};
    var projectId = firstDefined(
      raw.project_id,
      isPlainObject(raw.project) ? raw.project.id : undefined
    );
    var projectIds = [];
    if (projectId) projectIds.push(String(projectId));
    if (Array.isArray(raw.project_ids)) projectIds = projectIds.concat(raw.project_ids.map(String));
    if (Array.isArray(meta.project_ids)) projectIds = projectIds.concat(meta.project_ids.map(String));

    var reaction = isPlainObject(raw.reaction) ? raw.reaction : {};
    var liked =
      raw.is_liked === true || reaction.liked === true || raw.has_upvoted === true ? 1 : 0;
    var realMedia = findRealMediaUrl(raw.media_urls, 0);
    var decoy = isDecoyAudioUrl(raw.audio_url);
    if (decoy) {
      raw.audio_url = null;
      raw.audio_url_decoy = true;
    } else if (raw.audio_url_decoy !== undefined) {
      delete raw.audio_url_decoy;
    }
    if (realMedia && !raw.resolved_audio_url) raw.resolved_audio_url = realMedia;

    var title = typeof raw.title === 'string' ? raw.title : '';

    raw._i = {
      v: SunoDBRef.DERIVED_VERSION,
      created_at: toIsoString(raw.created_at),
      title_lower: title.toLowerCase(),
      is_liked: liked,
      is_trashed: raw.is_trashed === true ? 1 : 0,
      is_public: raw.is_public === true ? 1 : 0,
      status: deriveStatus(raw, meta),
      major_model_version: toText(firstDefined(raw.major_model_version, meta.major_model_version, raw.model_name)),
      play_count: toCount(firstDefined(raw.play_count, meta.play_count)),
      upvote_count: toCount(firstDefined(raw.upvote_count, raw.reaction_count, meta.upvote_count)),
      project_ids: uniqueStrings(projectIds),
      audio_url_decoy: decoy ? 1 : 0,
    };
    return raw;
  }

  function isLikedClip(clip) {
    if (!clip) return false;
    if (clip._i && typeof clip._i.is_liked === 'number') return clip._i.is_liked === 1;
    if (clip.is_liked === true) return true;
    if (isPlainObject(clip.reaction) && clip.reaction.liked === true) return true;
    if (clip.has_upvoted === true) return true;
    if (isFiniteNumber(clip.upvote_count) && clip.upvote_count > 0) return true;
    if (typeof clip.reaction === 'string' && clip.reaction === 'upvote') return true;
    return false;
  }

  SunoDB.prototype.isLikedClip = isLikedClip;

  /* ===================================================================== *
   * 4. LOW-LEVEL IDB HELPERS
   * ===================================================================== */

  /** Wrap a single IDBRequest as a promise. Attaches onsuccess + onerror. */
  function requestToPromise(request, store) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(classify(request.error || new Error('request failed'), store));
      };
    });
  }

  /**
   * Walk a cursor, collecting up to `limit` rows.
   * BATCH-SAFE: every callback body is synchronous and issues its next
   * `continue`/`advance` from inside `onsuccess`, so the transaction never
   * goes idle. Never awaits anything else.
   */
  function collectCursor(source, opts) {
    var direction = opts.direction === 'prev' ? 'prev' : 'next';
    var limit = opts.limit;
    var offset = opts.offset > 0 ? opts.offset : 0;
    var range = opts.range || null;
    var out = [];
    return new Promise(function (resolve, reject) {
      var req = source.openCursor(range, direction);
      req.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        if (offset > 0) {
          cursor.advance(offset);
          offset = 0;
          return;
        }
        out.push(cursor.value);
        if (limit > 0 && out.length >= limit) {
          resolve(out);
          return;
        }
        cursor['continue']();
      };
      req.onerror = function () {
        reject(classify(req.error || new Error('cursor failed'), opts.store));
      };
    });
  }

  /**
   * Walk a cursor and DELETE or UPDATE each row in one transaction
   * (pruneCompleted / journal.trim / purgeTrashed / resetInProgress).
   *
   * `handlers` is `{ isDelete?: (row) => boolean, patch?: (row) => object }`.
   * `isDelete` wins over `patch`. A handler body MUST be synchronous and MUST
   * not await - that would auto-commit the transaction (see transaction()).
   *
   * @returns {Promise<{touched: number, changed: number}>}
   */
  function mutateCursor(source, handlers, opts) {
    var range = opts.range || null;
    var direction = opts.direction === 'prev' ? 'prev' : 'next';
    var isDelete = handlers && typeof handlers.isDelete === 'function' ? handlers.isDelete : null;
    var patchFn = handlers && typeof handlers.patch === 'function' ? handlers.patch : null;
    var touched = 0;
    var changed = 0;
    return new Promise(function (resolve, reject) {
      var req = source.openCursor(range, direction);
      req.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) {
          resolve({ touched: touched, changed: changed });
          return;
        }
        touched++;
        var row = cursor.value;
        if (isDelete && isDelete(row)) {
          cursor['delete']();
          changed++;
        } else if (patchFn) {
          var patch = patchFn(row);
          if (patch && typeof patch === 'object') {
            cursor.update(patch);
            changed++;
          }
        }
        cursor['continue']();
      };
      req.onerror = function () {
        reject(classify(req.error || new Error('cursor failed'), opts.store));
      };
    });
  }

  /* ===================================================================== *
   * 5. SunoDB
   * ===================================================================== */

  /** Late-bound so buildClipRecord can read DERIVED_VERSION during class init. */
  var SunoDBRef = { DERIVED_VERSION: 3 };

  var DOWNLOAD_STATES = ['pending', 'in_progress', 'done', 'failed', 'skipped'];
  var DOWNLOAD_SOURCES = ['studio', 'download-route', 'mango-drm', 'progressive', 'hls', 'zip'];

  function SunoDB(options) {
    var opts = options || {};
    this._logger = normalizeLogger(opts.logger);
    this._idbFactory = opts.indexedDB || null;
    this._keyRangeFactory = opts.keyRange || null;
    this._openTimeoutMs = isFiniteNumber(opts.openTimeoutMs) ? opts.openTimeoutMs : 15000;
    this._legacyTimeoutMs = isFiniteNumber(opts.legacyTimeoutMs) ? opts.legacyTimeoutMs : 5000;
    this._defaultLimit = isFiniteNumber(opts.defaultLimit) ? opts.defaultLimit : 1000;

    /** Resolved handle. */
    this._db = null;
    /** In-flight open PROMISE - the memo that fixes the concurrent-init bug. */
    this._openPromise = null;
    /** Set while an opted-in legacy read is running, so it stays one-shot. */
    this._legacyRunning = false;

    this.clips = this._buildClipApi(this);
    this.downloads = this._buildDownloadApi(this);
    this.syncState = this._buildSyncStateApi(this);
    this.journal = this._buildJournalApi(this);
    this.meta = this._buildMetaApi(this);
  }

  SunoDB.DB_NAME = 'suno-library';
  SunoDB.DB_VERSION = 3;
  SunoDB.DERIVED_VERSION = 3;
  SunoDB.OPEN_TIMEOUT_MS = 15000;
  SunoDB.STORE_NAMES = ALL_STORE_NAMES.slice();
  SunoDB.STORES = STORES;
  SunoDB.DOWNLOAD_STATES = DOWNLOAD_STATES.slice();
  SunoDB.DOWNLOAD_SOURCES = DOWNLOAD_SOURCES.slice();
  SunoDBRef.DERIVED_VERSION = SunoDB.DERIVED_VERSION;

  /** Databases this module may READ during an opt-in migration. Never upgraded. */
  SunoDB.LEGACY_DB_NAMES = ['SunoLibraryDB', 'SunoMasterDB'];

  SunoDB.isBlocked = SunoDBError.isBlocked;
  SunoDB.isQuotaExceeded = SunoDBError.isQuotaExceeded;
  SunoDB.isNotFound = SunoDBError.isNotFound;

  /* --------------------------------------------------------------------- *
   * 5a. OPEN / CLOSE
   * --------------------------------------------------------------------- */

  /**
   * Open (or reuse) the database handle.
   *
   * Fixes bugs 2, 3 and 6:
   *  - the in-flight PROMISE is memoized, so N concurrent calls => ONE
   *    `indexedDB.open` (bug 3: the old guard tested the resolved value).
   *  - a hard timeout rejects instead of hanging (bug 2), and `onblocked`
   *    records WHY so the rejection is labelled `BLOCKED` (bug 6).
   *  - `onversionchange` closes the handle and clears the memo so the next
   *    call reopens against the new version instead of deadlocking (bug 6).
   *
   * @param {{indexedDB?: IDBFactory, name?: string, version?: number,
   *          openTimeoutMs?: number, keyRange?: typeof IDBKeyRange}} [options]
   * @returns {Promise<IDBDatabase>}
   */
  SunoDB.prototype.open = function (options) {
    var opts = options || {};
    if (this._db) return Promise.resolve(this._db);
    if (this._openPromise) return this._openPromise;

    var idb = resolveIDB(opts.indexedDB || this._idbFactory);
    if (!idb) {
      return Promise.reject(
        new SunoDBError('IDB_UNAVAILABLE', ERROR_CODES.IDB_UNAVAILABLE, { store: null })
      );
    }
    var name = opts.name || SunoDB.DB_NAME;
    var version = isFiniteNumber(opts.version) ? opts.version : SunoDB.DB_VERSION;
    var timeoutMs = isFiniteNumber(opts.openTimeoutMs)
      ? opts.openTimeoutMs
      : isFiniteNumber(this._openTimeoutMs)
        ? this._openTimeoutMs
        : SunoDB.OPEN_TIMEOUT_MS;
    if (opts.keyRange) this._keyRangeFactory = opts.keyRange;

    var self = this;
    // Memoize the PROMISE, not the value: concurrent callers all await this.
    this._openPromise = new Promise(function (resolve, reject) {
      var request = null;
      var timer = null;
      var settled = false;
      var blocked = false;

      var detach = function () {
        if (!request) return;
        request.onupgradeneeded = null;
        request.onsuccess = null;
        request.onerror = null;
        request.onblocked = null;
      };

      var finish = function (fn) {
        return function (arg) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          timer = null;
          detach();
          fn(arg);
        };
      };

      var onSettled = finish(function (db) {
        db.onversionchange = function (event) {
          self._logger.warn(
            'db: versionchange requested on ' + name + '; closing so another context can upgrade'
          );
          self._detachDb(db);
          try {
            if (event && event.target && typeof event.target.close === 'function') {
              event.target.close();
            } else {
              db.close();
            }
          } catch (closeErr) {
            self._logger.warn('db: close during versionchange failed: ' + closeErr);
          }
        };
        self._db = db;
        resolve(db);
      });
      var onRejected = finish(function (err) {
        reject(err);
      });

      try {
        request = idb.open(name, version);
      } catch (openErr) {
        onRejected(
          new SunoDBError(
            'OPEN_FAILED',
            ERROR_CODES.OPEN_FAILED + ' (' + name + ' v' + version + '): ' +
              (openErr && openErr.message ? openErr.message : String(openErr)),
            { store: null, cause: openErr }
          )
        );
        return;
      }

      // Bug 4 fix: versioned, idempotent, additive migrations. Every branch is
      // safe to run against any prior version, and `suno-library` starts at
      // oldVersion 0 so all three run on a fresh install.
      request.onupgradeneeded = function (event) {
        var tx = request.transaction;
        try {
          self._upgrade(request.result, tx, event.oldVersion, version);
        } catch (upgradeErr) {
          self._logger.error('db: upgrade failed: ' + upgradeErr);
          try {
            tx.abort();
          } catch (abortErr) {
            // `onabort` below reports the real cause; a failure here means the
            // transaction is already dead, so there is nothing left to do.
            self._logger.warn('db: abort after failed upgrade threw: ' + abortErr);
          }
        }
      };

      request.onblocked = function () {
        blocked = true;
        self._logger.warn(
          'db: open(' + name + ' v' + version + ') blocked - another context holds an older ' +
            'connection open and is ignoring its own versionchange handler'
        );
      };

      request.onsuccess = function () {
        if (settled) {
          // We already timed out; do not leak the late handle.
          try {
            request.result.close();
          } catch (lateErr) {
            self._logger.warn('db: closing late-arriving handle failed: ' + lateErr);
          }
          return;
        }
        onSettled(request.result);
      };

      request.onerror = function () {
        var raw = request.error;
        if (raw && domName(raw) === 'AbortError') {
          onRejected(new SunoDBError('OPEN_FAILED', 'Database open aborted during upgrade.', {
            store: null,
            cause: raw,
          }));
          return;
        }
        var wrapped = classify(raw, null);
        onRejected(
          new SunoDBError(
            wrapped.code === 'TX_FAILED' ? 'OPEN_FAILED' : wrapped.code,
            ERROR_CODES.OPEN_FAILED + ' (' + name + ' v' + version + '): ' + wrapped.message,
            { store: null, cause: raw === null ? wrapped : raw }
          )
        );
      };

      timer = setTimeout(function () {
        if (settled) return;
        if (blocked) {
          onRejected(
            new SunoDBError(
              'BLOCKED',
              ERROR_CODES.BLOCKED +
                ' Another tab/worker is holding ' + name +
                ' open at an older version and did not close it. Close every other ' +
                'context (or reload those tabs) and retry; retrying is safe.',
              { store: null }
            )
          );
        } else {
          onRejected(
            new SunoDBError(
              'OPEN_TIMEOUT',
              ERROR_CODES.OPEN_TIMEOUT +
                ' (' + name + ' v' + version + ' after ' + timeoutMs +
                'ms). Usually a stale connection from another tab or a slow upgrade ' +
                'on a large library. Retry is safe.',
              { store: null }
            )
          );
        }
      }, timeoutMs);
    }).then(
      function (db) {
        self._openPromise = null;
        return db;
      },
      function (err) {
        self._openPromise = null;
        throw err;
      }
    );

    return this._openPromise;
  };

  /** Close and unhook a handle we own. Never throws. */
  SunoDB.prototype._detachDb = function (db) {
    if (!db) return;
    try {
      db.onversionchange = null;
    } catch (detachErr) {
      this._logger.warn('db: could not clear onversionchange: ' + detachErr);
    }
    if (this._db === db) this._db = null;
    this._openPromise = null;
  };

  /** Close the handle. The next call to any API reopens it. */
  SunoDB.prototype.close = function () {
    var db = this._db;
    this._db = null;
    this._openPromise = null;
    if (!db) return Promise.resolve(false);
    try {
      db.onversionchange = null;
      db.close();
      return Promise.resolve(true);
    } catch (closeErr) {
      return Promise.reject(
        new SunoDBError('VERSION_CHANGE', 'db.close() failed: ' + closeErr, {
          store: null,
          cause: closeErr,
        })
      );
    }
  };

  /** Alias so `init()` and `open()` are interchangeable for old callers. */
  SunoDB.prototype.init = function (options) {
    return this.open(options);
  };

  /**
   * The ONLY place a transaction is created.
   *
   * ####################################################################
   * #  TRANSACTION AUTO-COMMIT RULE - THE CLASSIC IDB BUG.  READ IT.  #
   * ####################################################################
   * An IndexedDB transaction commits the instant its request queue drains.
   * The queue drains when control returns to the event loop, which happens at
   * every `await` that is not backed by an IDB request. So inside `fn` you may
   * `await` IDB requests (the transaction stays alive because the request is
   * outstanding), but you may NOT `await` a `fetch`, a `setTimeout`, a
   * `crypto.subtle` call, `navigator.storage.estimate()`, a helper that itself
   * opens a transaction, or anything non-IDB. The transaction auto-commits
   * underneath you and the next `put()` throws TransactionInactiveError -
   * usually with a partial write already committed.
   * RULE: do all async work BEFORE calling `transaction()`, then pass a
   * `fn` that is synchronous apart from awaiting IDB requests.
   *
   * Resolves on `oncomplete` with `fn`'s return value. Rejects with a
   * `SunoDBError` on `onerror`/`onabort`. Every handler is attached and the
   * transaction is always resolved or rejected - never left dangling.
   *
   * @param {string|string[]} names
   * @param {'readonly'|'readwrite'|'versionchange'} mode
   * @param {(stores: Object, tx: IDBTransaction) => any} fn
   */
  SunoDB.prototype.transaction = function (names, mode, fn) {
    var self = this;
    var storeNames = Array.isArray(names) ? names.slice() : [names];
    return this.open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = null;
        var value = undefined;
        var valueSettled = false;
        var valueError = null;
        var settled = false;

        var settle = function () {
          if (settled) return;
          settled = true;
          if (valueError) reject(valueError);
          else if (!valueSettled && pendingValue) {
            // fn returned a promise that outlived the transaction; wait for it
            // so callers still get their value, but never resolve past a failure.
            pendingValue.then(resolve, reject);
          } else {
            resolve(value);
          }
        };

        var pendingValue = null;
        try {
          tx = db.transaction(storeNames, mode);
        } catch (txErr) {
          reject(
            new SunoDBError(
              'TX_INVALID',
              ERROR_CODES.TX_INVALID + ' (' + storeNames.join(',') + '/' + mode + '): ' + txErr.message,
              { store: storeNames[0] || null, cause: txErr }
            )
          );
          return;
        }

        var handles = {};
        for (var i = 0; i < storeNames.length; i++) {
          handles[storeNames[i]] = tx.objectStore(storeNames[i]);
        }

        tx.oncomplete = function () {
          settle();
        };
        tx.onerror = function (event) {
          // NOTE: we deliberately do NOT call event.preventDefault(). Letting the
          // default action run is what aborts the transaction and rolls back
          // partial writes; swallowing the event would commit them.
          var raw = tx.error || (event && event.target && event.target.error) || null;
          reject(classify(raw || new Error('transaction error'), storeNames[0]));
        };
        tx.onabort = function () {
          var raw = tx.error || null;
          // A failure raised by `fn` is more informative than the abort it
          // caused, so prefer it when present.
          if (valueError) {
            reject(valueError);
            return;
          }
          if (raw) {
            reject(classify(raw, storeNames[0]));
            return;
          }
          reject(
            new SunoDBError(
              'TX_ABORTED',
              ERROR_CODES.TX_ABORTED +
                ' (' + storeNames.join(',') + '/' + mode + '): no error reported by the browser',
              { store: storeNames[0] || null, cause: null }
            )
          );
        };

        var returned;
        try {
          returned = fn(handles, tx);
        } catch (fnErr) {
          valueSettled = true;
          valueError = classify(fnErr, storeNames[0]);
          try {
            tx.abort();
          } catch (abortErr) {
            self._logger.warn('db: abort after fn() threw failed: ' + abortErr);
          }
          return;
        }

        if (returned && typeof returned.then === 'function') {
          pendingValue = returned.then(
            function (v) {
              value = v;
              valueSettled = true;
              return v;
            },
            function (e) {
              value = undefined;
              valueSettled = true;
              valueError = classify(e, storeNames[0]);
              try {
                tx.abort();
              } catch (abortErr) {
                self._logger.warn('db: abort after async fn() failure failed: ' + abortErr);
              }
              throw valueError;
            }
          );
          // Swallow the derived promise so an unhandled rejection warning
          // cannot fire; `valueError` + onabort carry the failure.
          pendingValue.then(null, function () {});
        } else {
          value = returned;
          valueSettled = true;
        }
      });
    });
  };

  /**
   * Run the versioned schema migration. Additive and idempotent: any branch
   * may run against any prior version without data loss, which is what makes
   * an interrupted upgrade safe to retry.
   */
  SunoDB.prototype._upgrade = function (db, tx, oldVersion, newVersion) {
    var logger = this._logger;

    // ---- v0 -> v1 : the base library ------------------------------------
    if (oldVersion < 1) {
      ensureStore(db, tx, STORES.CLIPS, logger);
      ensureStore(db, tx, STORES.DOWNLOADS, logger);
      ensureStore(db, tx, STORES.SYNC_STATE, logger);
      ensureStore(db, tx, STORES.JOURNAL, logger);
      ensureStore(db, tx, STORES.META, logger);
      ensureIndexes(tx.objectStore(STORES.CLIPS), STORES.CLIPS, logger);
      ensureIndexes(tx.objectStore(STORES.DOWNLOADS), STORES.DOWNLOADS, logger);
      ensureIndexes(tx.objectStore(STORES.SYNC_STATE), STORES.SYNC_STATE, logger);
      ensureIndexes(tx.objectStore(STORES.JOURNAL), STORES.JOURNAL, logger);
    }

    // ---- v1 -> v2 : batch journal + resumable crawl cursors --------------
    if (oldVersion < 2) {
      ensureStore(db, tx, STORES.JOURNAL, logger);
      ensureIndexes(tx.objectStore(STORES.JOURNAL), STORES.JOURNAL, logger);
      ensureStore(db, tx, STORES.SYNC_STATE, logger);
      ensureIndexes(tx.objectStore(STORES.SYNC_STATE), STORES.SYNC_STATE, logger);
      ensureIndexes(tx.objectStore(STORES.DOWNLOADS), STORES.DOWNLOADS, logger);
      ensureIndexes(tx.objectStore(STORES.CLIPS), STORES.CLIPS, logger);
    }

    // ---- v2 -> v3 : the MASS-downloader filter dimensions ---------------
    // Every one of these is required to answer "give me clips where
    // is_liked=1 AND project_ids contains X ordered by created_at".
    if (oldVersion < 3) {
      ensureIndexes(tx.objectStore(STORES.CLIPS), STORES.CLIPS, logger);
      ensureIndexes(tx.objectStore(STORES.DOWNLOADS), STORES.DOWNLOADS, logger);
    }

    // Stamped inside the versionchange transaction so the backfill below
    // knows exactly which rows still need derived columns recomputed.
    var meta = ensureStore(db, tx, STORES.META, logger);
    meta.put({ key: 'schemaVersion', value: newVersion, updatedAt: now() });
    meta.put({
      key: 'oldVersion',
      value: oldVersion,
      updatedAt: now(),
    });
    if (oldVersion > 0 && oldVersion < SunoDB.DERIVED_VERSION) {
      meta.put({ key: 'derivedBackfillVersion', value: oldVersion, updatedAt: now() });
      logger.info('db: upgrade v' + oldVersion + ' -> v' + newVersion + ', derived backfill queued');
    }
  };

  /* --------------------------------------------------------------------- *
   * 5b. clips
   * --------------------------------------------------------------------- */

  SunoDB.prototype._buildClipApi = function (owner) {
    var self = owner; // the SunoDB instance, not an IDBDatabase

    function requireIndex(store, indexName) {
      if (!store.indexNames.contains(indexName)) {
        throw new SunoDBError(
          'INVALID_ARGUMENT',
          'Unknown clips index "' + indexName + '". Available: ' +
            Array.prototype.slice.call(store.indexNames).join(', '),
          { store: STORES.CLIPS }
        );
      }
      return indexName;
    }

    return {
      /**
       * Insert/replace one clip. Stores the raw clip plus the derived `_i`
       * block; strips DRM key material; normalises the `audio_url` decoy.
       * @param {object} clip
       */
      put: function (clip) {
        if (!clip || typeof clip !== 'object') {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', ERROR_CODES.INVALID_ARGUMENT + ' clip must be an object', {
              store: STORES.CLIPS,
            })
          );
        }
        if (clip.id === undefined || clip.id === null || clip.id === '') {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'clip.id is required (keyPath "id")', {
              store: STORES.CLIPS,
            })
          );
        }
        var record = buildClipRecord(clip);
        return self
          .transaction(STORES.CLIPS, 'readwrite', function (stores) {
            var req = stores[STORES.CLIPS].put(record);
            return requestToPromise(req, STORES.CLIPS);
          })
          .then(function () {
            return record.id;
          });
      },

      /**
       * Insert/replace a batch in EXACTLY ONE transaction.
       * The old code opened a transaction per clip, so a 500-clip sync paid
       * 500 upgrade/lock cycles and a mid-batch failure left a half-written
       * library. One transaction = one atomic commit or one rollback.
       * @param {object[]} clips
       * @returns {Promise<number>} rows written
       */
      putMany: function (clips) {
        if (!Array.isArray(clips)) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', ERROR_CODES.INVALID_ARGUMENT + ' putMany expects an array', {
              store: STORES.CLIPS,
            })
          );
        }
        if (clips.length === 0) return Promise.resolve(0);
        var records = [];
        for (var i = 0; i < clips.length; i++) {
          var clip = clips[i];
          if (!clip || typeof clip !== 'object') continue;
          if (clip.id === undefined || clip.id === null || clip.id === '') continue;
          records.push(buildClipRecord(clip));
        }
        if (records.length === 0) return Promise.resolve(0);
        return self
          .transaction(STORES.CLIPS, 'readwrite', function (stores) {
            // Synchronous loop inside ONE transaction - no awaits in between.
            var store = stores[STORES.CLIPS];
            for (var j = 0; j < records.length; j++) store.put(records[j]);
            return records.length;
          })
          .then(function (count) {
            self._logger.debug('db: clips.putMany committed ' + count + ' rows in 1 transaction');
            return count;
          });
      },

      /** @returns {Promise<object|undefined>} */
      get: function (id) {
        if (id === undefined || id === null) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'id is required', { store: STORES.CLIPS })
          );
        }
        return self.transaction(STORES.CLIPS, 'readonly', function (stores) {
          return requestToPromise(stores[STORES.CLIPS].get(id), STORES.CLIPS);
        });
      },

      /** One transaction, N gets, results in the caller's order. */
      getMany: function (ids) {
        if (!Array.isArray(ids)) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'getMany expects an array of ids', {
              store: STORES.CLIPS,
            })
          );
        }
        if (ids.length === 0) return Promise.resolve([]);
        return self.transaction(STORES.CLIPS, 'readonly', function (stores) {
          var store = stores[STORES.CLIPS];
          var jobs = [];
          for (var i = 0; i < ids.length; i++) {
            // requestToPromise attaches onerror, so a failed get rejects the
            // batch instead of escaping as an uncaught event-handler throw.
            jobs.push(requestToPromise(store.get(ids[i]), STORES.CLIPS));
          }
          return Promise.all(jobs);
        });
      },

      /**
       * Paged scan. `order` is an index name (default: primary key).
       * Uses a cursor with `advance()` for offset so paging a 10k-row library
       * never materialises the skipped rows.
       * @param {{limit?: number, offset?: number, order?: string,
       *          direction?: 'asc'|'desc', range?: IDBKeyRange}} [options]
       */
      all: function (options) {
        var o = options || {};
        var limit = normalizeLimit(o.limit, self._defaultLimit);
        var offset = isFiniteNumber(o.offset) && o.offset > 0 ? o.offset : 0;
        var direction = o.direction === 'desc' || o.direction === 'prev' ? 'prev' : 'next';
        var order = o.order || null;
        return self.transaction(STORES.CLIPS, 'readonly', function (stores) {
          var store = stores[STORES.CLIPS];
          var source = order ? store.index(requireIndex(store, order)) : store;
          return collectCursor(source, {
            limit: limit,
            offset: offset,
            direction: direction,
            range: o.range || null,
            store: STORES.CLIPS,
          });
        });
      },

      /** @returns {Promise<number>} */
      count: function () {
        return self.transaction(STORES.CLIPS, 'readonly', function (stores) {
          return requestToPromise(stores[STORES.CLIPS].count(), STORES.CLIPS);
        });
      },

      /**
       * Index lookup for one of the documented filter dimensions.
       * @param {string} indexName e.g. 'is_liked' | 'project_ids' | 'created_at'
       * @param {IDBKey|IDBKeyRange} value
       * @param {{limit?: number, offset?: number, direction?: 'asc'|'desc'}} [options]
       */
      queryByIndex: function (indexName, value, options) {
        var o = options || {};
        var limit = normalizeLimit(o.limit, self._defaultLimit);
        var offset = isFiniteNumber(o.offset) && o.offset > 0 ? o.offset : 0;
        var direction = o.direction === 'desc' || o.direction === 'prev' ? 'prev' : 'next';
        return self.transaction(STORES.CLIPS, 'readonly', function (stores) {
          var store = stores[STORES.CLIPS];
          return collectCursor(store.index(requireIndex(store, indexName)), {
            limit: limit,
            offset: offset,
            direction: direction,
            range: value,
            store: STORES.CLIPS,
          });
        });
      },

      /**
       * Case-insensitive title prefix search. `title_lower` is a plain index,
       * so this is a single bounded range scan, not a full-table filter.
       * @param {string} prefix
       */
      searchTitle: function (prefix) {
        var KR = resolveKeyRange(self._keyRangeFactory);
        if (!KR) {
          return Promise.reject(
            new SunoDBError('UNSUPPORTED', 'IDBKeyRange unavailable; cannot build a title range', {
              store: STORES.CLIPS,
            })
          );
        }
        var lower = String(prefix === undefined || prefix === null ? '' : prefix).toLowerCase();
        var range = lower === ''
          ? null
          : KR.bound(lower, lower + '\uFFFF', false, false);
        var self2 = self;
        return self.transaction(STORES.CLIPS, 'readonly', function (stores) {
          var store = stores[STORES.CLIPS];
          return collectCursor(store.index(requireIndex(store, 'title_lower')), {
            limit: self2._defaultLimit,
            offset: 0,
            direction: 'next',
            range: range,
            store: STORES.CLIPS,
          });
        });
      },

      /** Drop every clip. One transaction; nothing partial. */
      clear: function () {
        return self
          .transaction(STORES.CLIPS, 'readwrite', function (stores) {
            return requestToPromise(stores[STORES.CLIPS].clear(), STORES.CLIPS);
          })
          .then(function () {
            return 0;
          });
      },

      /**
       * ATOMIC full replace: one readwrite transaction does `clear()` then
       * `put()` for every row.
       *
       * WHY THIS IS SAFE (and why the old clear-then-loop was not): IndexedDB
       * transactions are atomic. If the worker is evicted, the tab closes, or
       * the quota is hit midway through the loop, the transaction ABORTS and
       * the browser rolls the store back to its pre-call contents. The old
       * `clear()`-then-`for (clip of all) await put(clip)` destroyed the whole
       * library if it died mid-loop, with no way to recover except re-crawling
       * the entire feed. Here the worst case is "nothing happened".
       *
       * @param {object[]} clips
       * @returns {Promise<{written:number, previousCount:number}>}
       */
      bulkReplace: function (clips) {
        if (!Array.isArray(clips)) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'bulkReplace expects an array of clips', {
              store: STORES.CLIPS,
            })
          );
        }
        var records = [];
        for (var i = 0; i < clips.length; i++) {
          var clip = clips[i];
          if (!clip || typeof clip !== 'object') continue;
          if (clip.id === undefined || clip.id === null || clip.id === '') continue;
          records.push(buildClipRecord(clip));
        }
        return self
          .transaction(STORES.CLIPS, 'readwrite', function (stores) {
            var store = stores[STORES.CLIPS];
            var before = store.count();
            store.clear();
            // Synchronous fan-out inside the SAME transaction. Every put is
            // queued before control returns to the event loop, so the
            // transaction cannot auto-commit with a partial library.
            for (var j = 0; j < records.length; j++) store.put(records[j]);
            return requestToPromise(before, STORES.CLIPS);
          })
          .then(function (previousCount) {
            return { written: records.length, previousCount: previousCount };
          });
      },

      /**
       * Recompute the derived `_i` block for rows written before the current
       * derived schema. Uses a cursor over the primary key and writes through
       * the same transaction, so it is atomic and restartable. Called
       * automatically after `open()` when the meta marker is behind.
       * @param {number} [targetVersion]
       * @returns {Promise<number>} rows rebuilt
       */
      backfillDerived: function (targetVersion) {
        var target = isFiniteNumber(targetVersion) ? targetVersion : SunoDB.DERIVED_VERSION;
        return self
          .transaction(STORES.CLIPS, 'readwrite', function (stores) {
            var store = stores[STORES.CLIPS];
            return new Promise(function (resolve, reject) {
              var updated = 0;
              var req = store.openCursor();
              req.onsuccess = function (event) {
                var cursor = event.target.result;
                if (!cursor) {
                  resolve(updated);
                  return;
                }
                var value = cursor.value;
                if (value && value._i && value._i.v === target) {
                  cursor['continue']();
                  return;
                }
                var rebuilt = buildClipRecord(value || {});
                cursor.update(rebuilt);
                updated++;
                cursor['continue']();
              };
              req.onerror = function () {
                reject(classify(req.error, STORES.CLIPS));
              };
            });
          })
          .then(function (updated) {
            return updated;
          });
      },

      /** Remove clips by id (one transaction). @returns {Promise<number>} */
      deleteMany: function (ids) {
        if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve(0);
        return self
          .transaction(STORES.CLIPS, 'readwrite', function (stores) {
            var store = stores[STORES.CLIPS];
            for (var i = 0; i < ids.length; i++) store['delete'](ids[i]);
            return ids.length;
          })
          .then(function (count) {
            return count;
          });
      },

      /** Remove every clip flagged `is_trashed = 1`. @returns {Promise<number>} */
      purgeTrashed: function () {
        return self.transaction(STORES.CLIPS, 'readwrite', function (stores) {
          var store = stores[STORES.CLIPS];
          return mutateCursor(
            store.index('is_trashed'),
            {
              isDelete: function (row) {
                return !!row && !!row._i && row._i.is_trashed === 1;
              },
            },
            { range: 1, direction: 'next', store: STORES.CLIPS }
          ).then(function (res) {
            return res.changed;
          });
        });
      },
    };
  };

  /* --------------------------------------------------------------------- *
   * 5c. downloads
   *
   * INVARIANT A (restated at every mutation site):
   *   `state:'done'` is written ONLY by markDone(), and only when the caller
   *   hands over an OBSERVED completion event. `chrome.downloads.download()`
   *   returning an id is NOT an observed completion - it only means the
   *   browser accepted the request. The old code wrote 'done' on that basis
   *   and therefore permanently blocked retries for every clip that later
   *   403'd, was evicted, or ran out of disk.
   * --------------------------------------------------------------------- */

  SunoDB.prototype._buildDownloadApi = function (owner) {
    var self = owner; // the SunoDB instance, not an IDBDatabase

    function validVariant(variant) {
      return typeof variant === 'string' && variant.length > 0;
    }

    function assertArgs(clipId, variant) {
      if (clipId === undefined || clipId === null || clipId === '') {
        throw new SunoDBError('INVALID_ARGUMENT', 'clipId is required', { store: STORES.DOWNLOADS });
      }
      if (!validVariant(variant)) {
        throw new SunoDBError(
          'INVALID_ARGUMENT',
          'variant is required (e.g. "m4a" | "mp3-320" | "wav-48k" | "lrc" | "cover" | "json")',
          { store: STORES.DOWNLOADS }
        );
      }
    }

    function assertState(state) {
      if (DOWNLOAD_STATES.indexOf(state) === -1) {
        throw new SunoDBError(
          'INVALID_ARGUMENT',
          'Unknown download state "' + state + '". Expected one of: ' + DOWNLOAD_STATES.join('|'),
          { store: STORES.DOWNLOADS }
        );
      }
    }

    /**
     * Single read-modify-write transition on the compound key
     * ['clipId','variant'], which is what makes `isDone(id,'mp3')` and
     * `isDone(id,'wav')` independent of each other.
     */
    function transition(clipId, variant, mutator) {
      assertArgs(clipId, variant);
      return self.transaction(STORES.DOWNLOADS, 'readwrite', function (stores) {
        var store = stores[STORES.DOWNLOADS];
        var key = [clipId, variant];
        var req = store.get(key);
        return new Promise(function (resolve, reject) {
          req.onsuccess = function () {
            var prev = req.result || { clipId: clipId, variant: variant };
            var next = mutator(Object.assign({}, prev));
            if (next === null) {
              resolve(prev);
              return;
            }
            next.clipId = clipId;
            next.variant = variant;
            next.updatedAt = now();
            var putReq = store.put(next);
            putReq.onsuccess = function () {
              resolve(next);
            };
            putReq.onerror = function () {
              reject(classify(putReq.error, STORES.DOWNLOADS));
            };
          };
          req.onerror = function () {
            reject(classify(req.error, STORES.DOWNLOADS));
          };
        });
      });
    }

    return {
      STATES: DOWNLOAD_STATES.slice(),
      SOURCES: DOWNLOAD_SOURCES.slice(),

      /** @returns {Promise<object|undefined>} the raw row. */
      get: function (clipId, variant) {
        assertArgs(clipId, variant);
        return self.transaction(STORES.DOWNLOADS, 'readonly', function (stores) {
          return requestToPromise(stores[STORES.DOWNLOADS].get([clipId, variant]), STORES.DOWNLOADS);
        });
      },

      /**
       * Is THIS exact (clipId, variant) finished? Independent per variant:
       * a done 'mp3-320' never implies a done 'wav-48k'.
       * @returns {Promise<boolean>}
       */
      isDone: function (clipId, variant) {
        assertArgs(clipId, variant);
        return self
          .transaction(STORES.DOWNLOADS, 'readonly', function (stores) {
            return requestToPromise(
              stores[STORES.DOWNLOADS].get([clipId, variant]),
              STORES.DOWNLOADS
            );
          })
          .then(function (row) {
            return !!row && row.state === 'done';
          });
      },

      /** True when a row exists in any state (used to skip planning work). */
      has: function (clipId, variant) {
        assertArgs(clipId, variant);
        return self
          .transaction(STORES.DOWNLOADS, 'readonly', function (stores) {
            return requestToPromise(
              stores[STORES.DOWNLOADS].get([clipId, variant]),
              STORES.DOWNLOADS
            );
          })
          .then(function (row) {
            return !!row;
          });
      },

      /**
       * Queue a download. Idempotent: re-pending an already-done row does NOT
       * downgrade it, so a re-scan cannot lose finished work.
       */
      markPending: function (clipId, variant, info) {
        var extra = info || {};
        return transition(clipId, variant, function (row) {
          if (row.state === 'done') return null;
          row.state = 'pending';
          row.error = null;
          row.chromeDownloadId = null;
          row.finishedAt = null;
          if (extra.source) row.source = extra.source;
          if (extra.filename !== undefined) row.filename = extra.filename;
          if (extra.path !== undefined) row.path = extra.path;
          return row;
        });
      },

      /**
       * Claim the row for an attempt. Increments `attempts` and stamps
       * `startedAt`. A row left in 'in_progress' by a dead worker is
       * recoverable via resetInProgress().
       */
      markInProgress: function (clipId, variant, info) {
        var extra = info || {};
        return transition(clipId, variant, function (row) {
          row.state = 'in_progress';
          row.startedAt = now();
          row.finishedAt = null;
          row.error = null;
          row.attempts = (isFiniteNumber(row.attempts) ? row.attempts : 0) + 1;
          row.chromeDownloadId =
            extra.chromeDownloadId === undefined ? row.chromeDownloadId : extra.chromeDownloadId;
          if (extra.source) row.source = extra.source;
          if (extra.filename !== undefined) row.filename = extra.filename;
          if (extra.path !== undefined) row.path = extra.path;
          return row;
        });
      },

      /**
       * *** THE ONLY WRITER OF state:'done' ***
       *
       * CONTRACT: call this ONLY from an OBSERVED completion event:
       *   - `chrome.downloads.onChanged` / `onDeterminingFilename` where the
       *     browser reports the item as complete, or
       *   - after a streamed write whose byte count was confirmed on disk.
       * NEVER call it because `chrome.downloads.download()` returned an id -
       * that id only proves the request was accepted, and trusting it is
       * exactly the bug that made the old downloader permanently skip clips
       * whose transfers later failed.
       *
       * @param {string} clipId
       * @param {string} variant
       * @param {{filename?: string, path?: string, bytes?: number,
       *          source?: string, proof?: string}} [completion]
       *   `proof` is a short description of the observation that justifies
       *   'done' (e.g. 'downloads.onChanged:complete'). It is stored so a
       *   later audit can tell a verified row from a hopeful one.
       * @returns {Promise<object>} the stored row
       */
      markDone: function (clipId, variant, completion) {
        var done = completion || {};
        return transition(clipId, variant, function (row) {
          row.state = 'done';
          row.finishedAt = isFiniteNumber(done.finishedAt) ? done.finishedAt : now();
          row.error = null;
          row.chromeDownloadId =
            done.chromeDownloadId === undefined ? row.chromeDownloadId : done.chromeDownloadId;
          if (done.filename !== undefined) row.filename = done.filename;
          if (done.path !== undefined) row.path = done.path;
          if (isFiniteNumber(done.bytes)) row.bytes = done.bytes;
          if (done.source) row.source = done.source;
          row.proof = typeof done.proof === 'string' && done.proof ? done.proof : 'unspecified';
          row.attempts = isFiniteNumber(row.attempts) ? row.attempts : 0;
          return row;
        });
      },

      /** Record a failure. Never downgrades an already-done row. */
      markFailed: function (clipId, variant, error, info) {
        var extra = info || {};
        return transition(clipId, variant, function (row) {
          if (row.state === 'done') return null;
          row.state = 'failed';
          row.finishedAt = now();
          row.error = error && error.message ? String(error.message) : String(error || 'unknown');
          row.chromeDownloadId = null;
          if (extra.source) row.source = extra.source;
          if (extra.filename !== undefined) row.filename = extra.filename;
          if (extra.path !== undefined) row.path = extra.path;
          if (isFiniteNumber(extra.bytes)) row.bytes = extra.bytes;
          if (!isFiniteNumber(row.attempts)) row.attempts = 1;
          return row;
        });
      },

      /** Record a deliberate skip (e.g. variant not applicable to this clip). */
      markSkipped: function (clipId, variant, reason, info) {
        var extra = info || {};
        return transition(clipId, variant, function (row) {
          if (row.state === 'done') return null;
          row.state = 'skipped';
          row.finishedAt = now();
          row.error = reason ? String(reason) : 'skipped';
          row.chromeDownloadId = null;
          if (extra.source) row.source = extra.source;
          return row;
        });
      },

      /**
       * Download history, newest first.
       * @param {{clipId?: string, limit?: number, states?: string[]}} [options]
       */
      history: function (options) {
        var o = options || {};
        var limit = normalizeLimit(o.limit, self._defaultLimit);
        var states = Array.isArray(o.states) ? o.states : null;
        // A multi-state filter reads one index and filters in memory, so it
        // must overscan; an infinite request must stay infinite.
        var scanLimit = states && states.length > 1 && limit !== Infinity ? limit * 4 : limit;
        return self.transaction(STORES.DOWNLOADS, 'readonly', function (stores) {
          var store = stores[STORES.DOWNLOADS];
          var source = o.clipId ? store.index('clipId') : store;
          if (!o.clipId && states && states.length === 1) {
            source = store.index('state');
          }
          var range = null;
          var KR = resolveKeyRange(self._keyRangeFactory);
          if (o.clipId && KR) range = KR.bound(o.clipId, o.clipId, false, false);
          if (!o.clipId && states && states.length === 1 && KR) {
            range = KR.bound(states[0], states[0], false, false);
          }
          return collectCursor(source, {
            limit: scanLimit,
            offset: 0,
            direction: 'prev',
            range: range,
            store: STORES.DOWNLOADS,
          }).then(function (rows) {
            if (!states || states.length === 0) return rows;
            return rows.filter(function (r) {
              return states.indexOf(r.state) !== -1;
            }).slice(0, limit === Infinity ? rows.length : limit);
          });
        });
      },

      /**
       * Delete history rows that finished before `now() - olderThanMs`.
       * One transaction, cursor over `finishedAt`. This is the cheapest lever
       * on origin quota, which a 10k-clip library plus full download history
       * will eventually exhaust.
       * @param {number} olderThanMs
       * @param {{states?: string[]}} [options] defaults to ['done']
       * @returns {Promise<number>} rows removed
       */
      pruneCompleted: function (olderThanMs, options) {
        if (!isFiniteNumber(olderThanMs) || olderThanMs < 0) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'olderThanMs must be a non-negative number', {
              store: STORES.DOWNLOADS,
            })
          );
        }
        var KR = resolveKeyRange(self._keyRangeFactory);
        if (!KR) {
          return Promise.reject(
            new SunoDBError('UNSUPPORTED', 'IDBKeyRange unavailable; cannot bound finishedAt', {
              store: STORES.DOWNLOADS,
            })
          );
        }
        var states = (options && Array.isArray(options.states) && options.states.length)
          ? options.states
          : ['done'];
        var cutoff = now() - olderThanMs;
        return self
          .transaction(STORES.DOWNLOADS, 'readwrite', function (stores) {
            var store = stores[STORES.DOWNLOADS];
            return mutateCursor(
              store.index('finishedAt'),
              {
                isDelete: function (row) {
                  return !!row && states.indexOf(row.state) !== -1;
                },
              },
              { range: KR.bound(-Infinity, cutoff, false, false), direction: 'next', store: STORES.DOWNLOADS }
            );
          })
          .then(function (res) {
            return res.changed;
          });
      },

      /**
       * WORKER STARTUP RECONCILIATION - call this on every worker startup.
       *
       * Anything still 'in_progress' belongs to a previous worker lifetime
       * that was evicted mid-transfer (MV3 kills idle service workers after
       * ~30s). Such a row is NOT done and must never be treated as done: flip
       * it back to 'pending' so the batch planner retries it. `attempts` is
       * preserved so the caller's retry budget still works.
       * @returns {Promise<{recovered:number, ids:Array<[string,string]>}>}
       */
      resetInProgress: function () {
        var KR = resolveKeyRange(self._keyRangeFactory);
        var ids = [];
        return self
          .transaction(STORES.DOWNLOADS, 'readwrite', function (stores) {
            var store = stores[STORES.DOWNLOADS];
            var index = store.index('state');
            var range = KR ? KR.bound('in_progress', 'in_progress', false, false) : null;
            return mutateCursor(
              index,
              {
                patch: function (row) {
                  if (!row) return null;
                  ids.push([row.clipId, row.variant]);
                  return Object.assign({}, row, {
                    state: 'pending',
                    chromeDownloadId: null,
                    finishedAt: null,
                    error: 'recovered: worker evicted while in_progress',
                    recoveredAt: now(),
                  });
                },
              },
              { range: range, direction: 'next', store: STORES.DOWNLOADS }
            );
          })
          .then(function (res) {
            if (res.changed > 0) {
              self._logger.warn(
                'db: recovered ' + res.changed + ' stale in_progress download row(s) to pending'
              );
            }
            return { recovered: res.changed, ids: ids };
          });
      },

      /** Delete all download history (legacy `resetDownloadHistory`). */
      clear: function () {
        return self
          .transaction(STORES.DOWNLOADS, 'readwrite', function (stores) {
            return requestToPromise(stores[STORES.DOWNLOADS].clear(), STORES.DOWNLOADS);
          })
          .then(function () {
            return 0;
          });
      },

      /** @returns {Promise<number>} */
      count: function () {
        return self.transaction(STORES.DOWNLOADS, 'readonly', function (stores) {
          return requestToPromise(stores[STORES.DOWNLOADS].count(), STORES.DOWNLOADS);
        });
      },

      /**
       * Rows grouped by state, for progress UI. One transaction, N counts.
       * @returns {Promise<Object<string, number>>}
       */
      countByState: function () {
        var out = {};
        for (var i = 0; i < DOWNLOAD_STATES.length; i++) out[DOWNLOAD_STATES[i]] = 0;
        return self.transaction(STORES.DOWNLOADS, 'readonly', function (stores) {
          var store = stores[STORES.DOWNLOADS];
          var KR = resolveKeyRange(self._keyRangeFactory);
          var index = store.index('state');
          var jobs = [];
          for (var s = 0; s < DOWNLOAD_STATES.length; s++) {
            (function (state) {
              var range = KR ? KR.bound(state, state, false, false) : null;
              jobs.push(
                requestToPromise(index.count(range), STORES.DOWNLOADS).then(
                  function (count) {
                    return { state: state, count: count };
                  },
                  function (err) {
                    // One failed count must not sink the whole progress read.
                    self._logger.warn('db: countByState() failed for ' + state + ': ' + err);
                    return { state: state, count: -1 };
                  }
                )
              );
            })(DOWNLOAD_STATES[s]);
          }
          return Promise.all(jobs).then(function (results) {
            for (var r = 0; r < results.length; r++) out[results[r].state] = results[r].count;
            return out;
          });
        });
      },
    };
  };

  /* --------------------------------------------------------------------- *
   * 5d. syncState - resumable crawl cursors
   * --------------------------------------------------------------------- */

  SunoDB.prototype._buildSyncStateApi = function (owner) {
    var self = owner; // the SunoDB instance, not an IDBDatabase
    return {
      /**
       * Read a cursor row.
       * @param {string} key 'feed' | 'projects' | 'playlists'
       * @param {*} [fallback] returned when the row does not exist yet, so a
       *        first-run crawl does not have to null-check every field
       * @returns {Promise<object|*>}
       */
      get: function (key, fallback) {
        if (!key) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'syncState key is required', { store: STORES.SYNC_STATE })
          );
        }
        return self
          .transaction(STORES.SYNC_STATE, 'readonly', function (stores) {
            return requestToPromise(stores[STORES.SYNC_STATE].get(key), STORES.SYNC_STATE);
          })
          .then(function (row) {
            if (row === undefined || row === null) {
              return fallback === undefined ? null : fallback;
            }
            return row;
          });
      },

      /**
       * Merge a patch into a cursor row and stamp `updatedAt`.
       * @param {string} key
       * @param {object} patch e.g. { nextPage, dislikedPass, truncated,
       *        pagesDone, totalSeen, lastError }
       * @returns {Promise<object>} the merged row
       */
      set: function (key, patch) {
        if (!key) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'syncState key is required', { store: STORES.SYNC_STATE })
          );
        }
        if (patch !== undefined && patch !== null && typeof patch !== 'object') {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'syncState patch must be an object', {
              store: STORES.SYNC_STATE,
            })
          );
        }
        return self.transaction(STORES.SYNC_STATE, 'readwrite', function (stores) {
          var store = stores[STORES.SYNC_STATE];
          var req = store.get(key);
          return new Promise(function (resolve, reject) {
            req.onsuccess = function () {
              var row = Object.assign({}, req.result || {}, patch || {});
              row.key = key;
              row.updatedAt = now();
              var putReq = store.put(row);
              putReq.onsuccess = function () {
                resolve(row);
              };
              putReq.onerror = function () {
                reject(classify(putReq.error, STORES.SYNC_STATE));
              };
            };
            req.onerror = function () {
              reject(classify(req.error, STORES.SYNC_STATE));
            };
          });
        });
      },

      /** @returns {Promise<number>} */
      clear: function (key) {
        if (key) {
          return self.transaction(STORES.SYNC_STATE, 'readwrite', function (stores) {
            var req = stores[STORES.SYNC_STATE]['delete'](key);
            return requestToPromise(req, STORES.SYNC_STATE).then(function () {
              return 1;
            });
          });
        }
        return self.transaction(STORES.SYNC_STATE, 'readwrite', function (stores) {
          return requestToPromise(stores[STORES.SYNC_STATE].clear(), STORES.SYNC_STATE).then(function () {
            return 0;
          });
        });
      },

      /** @returns {Promise<string[]>} */
      keys: function () {
        return self.transaction(STORES.SYNC_STATE, 'readonly', function (stores) {
          return requestToPromise(stores[STORES.SYNC_STATE].getAllKeys(), STORES.SYNC_STATE);
        });
      },
    };
  };

  /* --------------------------------------------------------------------- *
   * 5e. journal - append-only batch event log for MV3 resume
   * --------------------------------------------------------------------- */

  SunoDB.prototype._buildJournalApi = function (owner) {
    var self = owner; // the SunoDB instance, not an IDBDatabase
    var self2 = self;
    return {
      /**
       * Append one event.
       * @param {{batchId: string, clipId?: string, variant?: string,
       *          phase: string, ts?: number, detail?: *}} entry
       * @returns {Promise<number>} the autoIncrement id
       */
      append: function (entry) {
        if (!entry || typeof entry !== 'object' || !entry.batchId || !entry.phase) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'journal entry needs { batchId, phase }', {
              store: STORES.JOURNAL,
            })
          );
        }
        var row = {
          batchId: String(entry.batchId),
          clipId: entry.clipId === undefined ? null : String(entry.clipId),
          variant: entry.variant === undefined ? null : String(entry.variant),
          phase: String(entry.phase),
          ts: isFiniteNumber(entry.ts) ? entry.ts : now(),
          detail: entry.detail === undefined ? null : entry.detail,
        };
        return self
          .transaction(STORES.JOURNAL, 'readwrite', function (stores) {
            var req = stores[STORES.JOURNAL].add(row);
            return requestToPromise(req, STORES.JOURNAL).then(function (key) {
              return key;
            });
          })
          .then(function (key) {
            return key;
          });
      },

      /**
       * Events for a batch at or after `ts`, oldest first - the resume path
       * after an MV3 worker eviction. One compound-index range scan.
       * @param {string} [batchId] omit to scan the whole journal by time
       * @param {number} [ts] defaults to 0
       * @param {{limit?: number}} [options]
       */
      since: function (batchId, ts, options) {
        var o = options || {};
        var limit = normalizeLimit(o.limit, self._defaultLimit);
        var sinceTs = isFiniteNumber(ts) ? ts : 0;
        var KR = resolveKeyRange(self2._keyRangeFactory);
        if (!KR) {
          return Promise.reject(
            new SunoDBError('UNSUPPORTED', 'IDBKeyRange unavailable; cannot bound the journal', {
              store: STORES.JOURNAL,
            })
          );
        }
        return self.transaction(STORES.JOURNAL, 'readonly', function (stores) {
          var store = stores[STORES.JOURNAL];
          var source;
          var range;
          if (batchId) {
            source = store.index('batchId_ts');
            // Arrays sort after every number in IDB key order, so
            // [batchId, []] is a strict "same batch, everything after ts" cap.
            range = KR.bound([batchId, sinceTs], [batchId, []], false, false);
          } else {
            source = store.index('ts');
            range = KR.bound(sinceTs, Infinity, false, false);
          }
          return collectCursor(source, {
            limit: limit,
            offset: 0,
            direction: 'next',
            range: range,
            store: STORES.JOURNAL,
          });
        });
      },

      /**
       * Drop every event for a finished batch (quota lever, run after the
       * batch is fully reconciled).
       * @param {string} batchId
       * @returns {Promise<number>} rows removed
       */
      trim: function (batchId) {
        if (!batchId) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'journal.trim needs a batchId', { store: STORES.JOURNAL })
          );
        }
        var KR = resolveKeyRange(self2._keyRangeFactory);
        if (!KR) {
          return Promise.reject(
            new SunoDBError('UNSUPPORTED', 'IDBKeyRange unavailable; cannot bound the journal', {
              store: STORES.JOURNAL,
            })
          );
        }
        var id = batchId;
        return self
          .transaction(STORES.JOURNAL, 'readwrite', function (stores) {
            var store = stores[STORES.JOURNAL];
            return mutateCursor(
              store.index('batchId_ts'),
              {
                isDelete: function () {
                  return true;
                },
              },
              {
                range: KR.bound([id, -Infinity], [id, []], false, false),
                direction: 'next',
                store: STORES.JOURNAL,
              }
            );
          })
          .then(function (res) {
            return res.changed;
          });
      },

      /** Drop events older than a cutoff across all batches. */
      pruneOlderThan: function (olderThanMs) {
        if (!isFiniteNumber(olderThanMs) || olderThanMs < 0) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'olderThanMs must be a non-negative number', {
              store: STORES.JOURNAL,
            })
          );
        }
        var KR = resolveKeyRange(self2._keyRangeFactory);
        if (!KR) {
          return Promise.reject(
            new SunoDBError('UNSUPPORTED', 'IDBKeyRange unavailable; cannot bound the journal', {
              store: STORES.JOURNAL,
            })
          );
        }
        var cutoff = now() - olderThanMs;
        return self
          .transaction(STORES.JOURNAL, 'readwrite', function (stores) {
            return mutateCursor(
              stores[STORES.JOURNAL].index('ts'),
              {
                isDelete: function () {
                  return true;
                },
              },
              { range: KR.bound(-Infinity, cutoff, false, false), direction: 'next', store: STORES.JOURNAL }
            );
          })
          .then(function (res) {
            return res.changed;
          });
      },

      /** @returns {Promise<number>} */
      count: function () {
        return self.transaction(STORES.JOURNAL, 'readonly', function (stores) {
          return requestToPromise(stores[STORES.JOURNAL].count(), STORES.JOURNAL);
        });
      },
    };
  };

  /* --------------------------------------------------------------------- *
   * 5f. meta - schema marker, quota cache, settings mirror, lastSync
   * --------------------------------------------------------------------- */

  SunoDB.prototype._buildMetaApi = function (owner) {
    var self = owner; // the SunoDB instance, not an IDBDatabase
    return {
      /**
       * @param {string} key
       * @param {*} [fallback] returned when the key is absent
       * @returns {Promise<*>}
       */
      get: function (key, fallback) {
        if (!key) return Promise.resolve(fallback === undefined ? null : fallback);
        return self
          .transaction(STORES.META, 'readonly', function (stores) {
            return requestToPromise(stores[STORES.META].get(key), STORES.META);
          })
          .then(function (row) {
            if (row === undefined || row === null) {
              return fallback === undefined ? null : fallback;
            }
            return row.value === undefined ? fallback : row.value;
          });
      },

      /**
       * @param {string} key
       * @param {*} value must be structured-cloneable
       * @returns {Promise<*>} the stored value
       */
      set: function (key, value) {
        if (!key) {
          return Promise.reject(
            new SunoDBError('INVALID_ARGUMENT', 'meta key is required', { store: STORES.META })
          );
        }
        return self
          .transaction(STORES.META, 'readwrite', function (stores) {
            var req = stores[STORES.META].put({ key: key, value: value, updatedAt: now() });
            return requestToPromise(req, STORES.META).then(function () {
              return value;
            });
          })
          .then(function (value) {
            return value;
          });
      },

      /** @returns {Promise<number>} */
      remove: function (key) {
        return self.transaction(STORES.META, 'readwrite', function (stores) {
          var req = stores[STORES.META]['delete'](key);
          return requestToPromise(req, STORES.META).then(function () {
            return 1;
          });
        });
      },

      /** @returns {Promise<Object<string, *>>} */
      all: function () {
        return self
          .transaction(STORES.META, 'readonly', function (stores) {
            return requestToPromise(stores[STORES.META].getAll(), STORES.META);
          })
          .then(function (rows) {
            var out = {};
            for (var i = 0; i < rows.length; i++) out[rows[i].key] = rows[i].value;
            return out;
          });
      },
    };
  };

  /* --------------------------------------------------------------------- *
   * 5g. stats / quota
   * --------------------------------------------------------------------- */

  /**
   * Origin storage usage. `null` when StorageManager is unavailable (some
   * content-script contexts), never a throw.
   * @returns {Promise<{usage:number, quota:number, percentUsed:number,
   *                    persistent:boolean|null, supported:boolean}|null>}
   */
  SunoDB.prototype.estimate = function () {
    var nav = resolveNav();
    var logger = this._logger;
    if (!nav || !nav.storage || typeof nav.storage.estimate !== 'function') {
      return Promise.resolve(null);
    }
    function shape(est, persistent) {
      var usage = isFiniteNumber(est && est.usage) ? est.usage : 0;
      var quota = isFiniteNumber(est && est.quota) ? est.quota : 0;
      return {
        usage: usage,
        quota: quota,
        percentUsed: quota > 0 ? Math.round((usage / quota) * 10000) / 100 : 0,
        persistent: persistent,
        supported: true,
      };
    }
    return nav.storage
      .estimate()
      .then(function (est) {
        if (typeof nav.storage.persisted !== 'function') {
          return shape(est, null);
        }
        return Promise.resolve(nav.storage.persisted()).then(
          function (p) {
            return shape(est, !!p);
          },
          function (persistErr) {
            logger.warn('db: storage.persisted() failed: ' + persistErr);
            return shape(est, null);
          }
        );
      })
      .catch(function (estimateErr) {
        logger.warn('db: storage.estimate() failed: ' + estimateErr);
        return null;
      });
  };

  /**
   * Per-store row counts plus a storage estimate.
   * @returns {Promise<{counts: Object<string, number>, downloadsByState: Object<string, number>,
   *                    estimate: object|null, schemaVersion: number}>}
   */
  SunoDB.prototype.stats = function () {
    var self = this;
    return this.transaction(ALL_STORE_NAMES, 'readonly', function (stores) {
      var counts = {};
      var jobs = [];
      for (var i = 0; i < ALL_STORE_NAMES.length; i++) {
        (function (name) {
          var req = stores[name].count();
          jobs.push(
            new Promise(function (resolve) {
              req.onsuccess = function () {
                counts[name] = req.result;
                resolve();
              };
              req.onerror = function () {
                // A failed per-store count must not lose the other counts.
                counts[name] = -1;
                self._logger.warn('db: count() failed for ' + name + ': ' + req.error);
                resolve();
              };
            })
          );
        })(ALL_STORE_NAMES[i]);
      }
      return Promise.all(jobs).then(function () {
        return counts;
      });
    })
      .then(function (counts) {
        return self.downloads
          .countByState()
          .catch(function (stateErr) {
            self._logger.warn('db: countByState() failed: ' + stateErr);
            return null;
          })
          .then(function (byState) {
            return self.estimate().then(function (est) {
              return {
                counts: counts,
                downloadsByState: byState,
                estimate: est,
                schemaVersion: SunoDB.DB_VERSION,
                dbName: SunoDB.DB_NAME,
              };
            });
          });
      });
  };

  /**
   * Recompute derived columns if an older build wrote rows without them.
   * Fire-and-forget safe: failures are logged, never thrown at the caller.
   * @returns {Promise<number>} rows rebuilt (0 when nothing to do)
   */
  SunoDB.prototype.ensureDerived = function () {
    var self = this;
    return this.meta
      .get('derivedBackfillVersion', SunoDB.DERIVED_VERSION)
      .then(function (marker) {
        if (isFiniteNumber(marker) && marker >= SunoDB.DERIVED_VERSION) return 0;
        return self.clips.backfillDerived(SunoDB.DERIVED_VERSION).then(function (updated) {
          if (updated > 0) {
            self._logger.info('db: backfilled derived columns on ' + updated + ' clip(s)');
          }
          return self.meta.set('derivedBackfillVersion', SunoDB.DERIVED_VERSION).then(function () {
            return updated;
          });
        });
      })
      .catch(function (err) {
        self._logger.warn('db: derived backfill skipped: ' + err);
        return 0;
      });
  };

  /* --------------------------------------------------------------------- *
   * 5h. OPT-IN, ONE-SHOT, FAIL-SAFE LEGACY MIGRATION
   * --------------------------------------------------------------------- */

  /**
   * Copy clips out of the pre-v5 databases ONCE, on explicit request.
   *
   * Why this is safe (the old `_checkLegacyMigration` ran on every init and
   * leaked two connections):
   *  - NEVER called from `init()`/`open()`. Callers opt in explicitly.
   *  - The old DBs are only opened after `indexedDB.databases()` proves they
   *    exist. Without that API we skip rather than risk CREATING an empty
   *    database as a side effect (old bug 2).
   *  - Legacy handles are opened WITHOUT a version, so no upgrade transaction
   *    can run against someone else's schema. If one is somehow requested,
   *    `onupgradeneeded` aborts it.
   *  - `onblocked` does not wait, it gives up.
   *  - Every handle is closed in a `finally`, and a `meta` marker makes it
   *    one-shot. It resolves (never rejects) even when it does nothing.
   *
   * @param {{dryRun?: boolean, names?: string[]}} [options]
   * @returns {Promise<{ran: boolean, reason: string, sources: Array,
   *                    imported: number, overwritten: number, errors: string[]}>}
   */
  SunoDB.prototype.migrateLegacy = function (options) {
    var self = this;
    var o = options || {};
    var names = Array.isArray(o.names) && o.names.length ? o.names.slice() : SunoDB.LEGACY_DB_NAMES;
    var result = { ran: false, reason: '', sources: [], imported: 0, overwritten: 0, errors: [] };

    if (this._legacyRunning) {
      result.reason = 'already-running';
      return Promise.resolve(result);
    }

    return this.meta
      .get('legacyMigration', null)
      .then(function (marker) {
        if (marker && marker.done) {
          result.reason = 'already-migrated';
          return null;
        }
        return self._listExistingDatabases();
      })
      .then(function (existing) {
        if (existing === null) {
          result.reason = 'no-databases-api';
          return null;
        }
        var present = names.filter(function (name) {
          return existing.indexOf(name) !== -1;
        });
        if (present.length === 0) {
          result.reason = 'no-legacy-database';
          return null;
        }
        self._legacyRunning = true;
        result.ran = true;
        // Sequentially: one legacy handle open at a time, each closed in its
        // own finally. The old code opened three and leaked two.
        var rows = [];
        var chain = Promise.resolve(null);
        present.forEach(function (name) {
          chain = chain.then(function () {
            return self._readLegacyClips(name).then(function (legacyRows) {
              result.sources.push({ name: name, clips: legacyRows.length });
              for (var i = 0; i < legacyRows.length; i++) rows.push(legacyRows[i]);
              return null;
            });
          });
        });
        return chain.then(function () {
          return self._importLegacyClips(rows, o.dryRun === true);
        });
      })
      .then(function (outcome) {
        if (!outcome) return result;
        result.imported = outcome.imported;
        result.overwritten = outcome.overwritten;
        result.reason = result.reason || 'migrated';
        if (!o.dryRun) {
          return self.meta
            .set('legacyMigration', {
              done: true,
              at: now(),
              sources: result.sources,
              imported: result.imported,
            })
            .catch(function (markerErr) {
              // Never let a marker failure turn into a repeated 10k-row import.
              result.errors.push('marker: ' + markerErr);
              return null;
            })
            .then(function () {
              return result;
            });
        }
        return result;
      })
      .catch(function (err) {
        result.errors.push(err && err.message ? err.message : String(err));
        result.reason = result.reason || 'failed';
        self._logger.warn('db: migrateLegacy failed (non-fatal): ' + err);
        return result;
      })
      .then(function (finalResult) {
        self._legacyRunning = false;
        return finalResult;
      });
  };

  /**
   * Which databases actually exist? `indexedDB.databases()` is Chromium-only
   * (fine for an MV3 extension) and, crucially, never creates anything.
   * @returns {Promise<string[]|null>} null when unsupported
   */
  SunoDB.prototype._listExistingDatabases = function () {
    var idb = resolveIDB(this._idbFactory);
    var self = this;
    if (!idb || typeof idb.databases !== 'function') {
      this._logger.warn('db: indexedDB.databases() unsupported; skipping legacy migration');
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        self._logger.warn('db: indexedDB.databases() timed out; skipping legacy migration');
        resolve(null);
      }, self._legacyTimeoutMs);
      var done = function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      try {
        idb.databases().then(
          function (list) {
            var names = [];
            for (var i = 0; i < (list || []).length; i++) {
              if (list[i] && list[i].name) names.push(list[i].name);
            }
            done(names);
          },
          function (err) {
            self._logger.warn('db: indexedDB.databases() failed: ' + err);
            done(null);
          }
        );
      } catch (err) {
        self._logger.warn('db: indexedDB.databases() threw: ' + err);
        done(null);
      }
    });
  };

  /** Read every clip from ONE legacy database, then close it. Never throws. */
  SunoDB.prototype._readLegacyClips = function (name) {
    var self = this;
    var idb = resolveIDB(this._idbFactory);
    if (!idb) return Promise.resolve([]);
    return new Promise(function (resolve) {
      var handle = null;
      var settled = false;
      var finish = function (rows) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (handle) {
          try {
            handle.onversionchange = null;
            handle.close();
          } catch (closeErr) {
            self._logger.warn('db: closing legacy ' + name + ' failed: ' + closeErr);
          }
        }
        resolve(rows);
      };
      var timer = setTimeout(function () {
        self._logger.warn('db: legacy read of ' + name + ' timed out; skipping');
        finish([]);
      }, self._legacyTimeoutMs);

      var request;
      try {
        // No version argument: we must never upgrade a database we do not own.
        request = idb.open(name);
      } catch (openErr) {
        self._logger.warn('db: legacy open(' + name + ') threw: ' + openErr);
        finish([]);
        return;
      }
      request.onupgradeneeded = function (event) {
        // Defensive only: no version was requested, so this should be
        // unreachable. If it happens, refuse to modify the legacy schema.
        self._logger.warn('db: refusing to upgrade legacy ' + name);
        try {
          event.target.transaction.abort();
        } catch (abortErr) {
          self._logger.warn('db: abort of legacy upgrade failed: ' + abortErr);
        }
      };
      request.onblocked = function () {
        self._logger.warn('db: legacy ' + name + ' is blocked by another tab; skipping');
        finish([]);
      };
      request.onsuccess = function () {
        handle = request.result;
        handle.onversionchange = function () {
          // Close so the other tab is not blocked behind us.
          try {
            handle.close();
          } catch (closeErr) {
            self._logger.warn('db: closing legacy ' + name + ' on versionchange failed: ' + closeErr);
          }
        };
        try {
          if (!handle.objectStoreNames.contains(STORES.CLIPS)) {
            finish([]);
            return;
          }
          var tx = handle.transaction([STORES.CLIPS], 'readonly');
          var getAll = tx.objectStore(STORES.CLIPS).getAll();
          getAll.onsuccess = function () {
            finish(Array.isArray(getAll.result) ? getAll.result : []);
          };
          getAll.onerror = function () {
            self._logger.warn('db: legacy getAll() failed for ' + name + ': ' + getAll.error);
            finish([]);
          };
          tx.onabort = function () {
            self._logger.warn('db: legacy read transaction aborted for ' + name);
            finish([]);
          };
          tx.onerror = function () {
            self._logger.warn('db: legacy read transaction failed for ' + name + ': ' + tx.error);
            finish([]);
          };
        } catch (readErr) {
          self._logger.warn('db: legacy read of ' + name + ' failed: ' + readErr);
          finish([]);
        }
      };
      request.onerror = function () {
        self._logger.warn('db: legacy open(' + name + ') failed: ' + request.error);
        finish([]);
      };
    });
  };

  /** Write the accumulated legacy rows into `suno-library`, ONE transaction. */
  SunoDB.prototype._importLegacyClips = function (rows, dryRun) {
    var self = this;
    if (!rows || rows.length === 0) return Promise.resolve({ imported: 0, overwritten: 0 });
    if (dryRun) return Promise.resolve({ imported: rows.length, overwritten: 0 });
    return this.clips.putMany(rows).then(function (written) {
      self._logger.info('db: migrated ' + written + ' legacy clip(s) into ' + SunoDB.DB_NAME);
      return { imported: written, overwritten: 0 };
    });
  };

  /* --------------------------------------------------------------------- *
   * 5i. LEGACY COMPATIBILITY SHIMS
   *     Old names kept alive so no existing caller breaks. Each one delegates
   *     to the new implementation above.
   * --------------------------------------------------------------------- */

  /** Legacy alias: bulk insert via ONE transaction. @returns {Promise<number>} */
  SunoDB.prototype.saveClips = function (clips) {
    return this.clips.putMany(clips);
  };

  /** Legacy alias: every clip. @returns {Promise<object[]>} */
  SunoDB.prototype.getAllClips = function () {
    return this.clips.all({ limit: -1 });
  };

  /** Legacy alias. @returns {Promise<object|undefined>} */
  SunoDB.prototype.getClip = function (id) {
    return this.clips.get(id);
  };

  /**
   * Legacy alias for `downloads.markDone`.
   *
   * The v4 caller contract already implied an observed completion: every call
   * site awaited a full `fetch()` + blob and only then called this, so routing
   * it to markDone() does NOT weaken invariant A. New code should call
   * `downloads.markDone(clipId, variant, { proof })` directly.
   */
  SunoDB.prototype.markAsDownloaded = function (clipId, format) {
    if (!clipId || !format) return Promise.resolve(null);
    return this.downloads.markDone(clipId, format, {
      source: 'legacy-compat',
      proof: 'legacy markAsDownloaded (post-fetch completion)',
    });
  };

  /** Legacy alias: per-format completion lookup. @returns {Promise<boolean>} */
  SunoDB.prototype.isDownloaded = function (clipId, format) {
    if (!clipId || !format) return Promise.resolve(false);
    return this.downloads.isDone(clipId, format);
  };

  /**
   * Legacy stats shape, preserved exactly:
   * { totalTracks, likedTracks, downloadedTracks, formatCounts }
   * Now derived from index counts instead of a full-table scan.
   */
  SunoDB.prototype.getStats = function () {
    var self = this;
    return this.clips.count().then(function (totalTracks) {
      return self.clips
        .queryByIndex('is_liked', 1, { limit: -1 })
        .then(function (likedRows) {
          return self.downloads
            .countByState()
            .then(function (byState) {
              return self.downloads
                .history({ states: ['done'], limit: -1 })
                .then(function (rows) {
                  var formatCounts = {};
                  var downloadedTracks = 0;
                  var seen = Object.create(null);
                  for (var i = 0; i < rows.length; i++) {
                    var variant = rows[i].variant || 'unknown';
                    formatCounts[variant] = (formatCounts[variant] || 0) + 1;
                    var k = String(rows[i].clipId);
                    if (!seen[k]) {
                      seen[k] = true;
                      downloadedTracks++;
                    }
                  }
                  return {
                    totalTracks: totalTracks,
                    likedTracks: likedRows.length,
                    downloadedTracks: downloadedTracks,
                    formatCounts: formatCounts,
                    downloadsByState: byState,
                    doneRows: (byState && byState.done) || 0,
                  };
                })
                .catch(function (histErr) {
                  self._logger.warn('db: getStats history scan failed: ' + histErr);
                  return {
                    totalTracks: totalTracks,
                    likedTracks: likedRows.length,
                    downloadedTracks: 0,
                    formatCounts: {},
                    downloadsByState: byState,
                    doneRows: (byState && byState.done) || 0,
                  };
                });
            });
        });
    });
  };

  /**
   * Legacy export. Emits a versioned envelope but ALSO keeps the clips array
   * at the top level so an old `JSON.parse()` reader still finds it.
   * @returns {Promise<string>}
   */
  SunoDB.prototype.exportJson = function () {
    var self = this;
    return this.clips.all({ limit: -1 }).then(function (clips) {
      return self.downloads.history({ limit: -1 }).then(function (downloads) {
        return self.syncState.keys().then(function (keys) {
          return JSON.stringify(
            {
              format: 'suno-library-export',
              schemaVersion: SunoDB.DB_VERSION,
              exportedAt: new Date().toISOString(),
              clipCount: clips.length,
              downloadCount: downloads.length,
              syncKeys: keys,
              clips: clips,
              downloads: downloads,
            },
            null,
            2
          );
        });
      });
    });
  };

  /**
   * Legacy import. Accepts both the bare array shape and the export envelope.
   * Merges (never clears), in one transaction per store.
   * @param {string|object} jsonStr
   * @returns {Promise<number>} number of clips imported (legacy return value)
   */
  SunoDB.prototype.importJson = function (jsonStr) {
    var self = this;
    var parsed;
    try {
      parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    } catch (parseErr) {
      return Promise.reject(
        new SunoDBError('INVALID_ARGUMENT', 'importJson: invalid JSON - ' + parseErr.message, {
          store: STORES.CLIPS,
        })
      );
    }
    var clips = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.clips) ? parsed.clips : null;
    if (!clips) {
      return Promise.reject(
        new SunoDBError('INVALID_ARGUMENT', 'importJson: expected an array of clips', {
          store: STORES.CLIPS,
        })
      );
    }
    var downloads = Array.isArray(parsed) ? [] : parsed && Array.isArray(parsed.downloads) ? parsed.downloads : [];
    return this.clips.putMany(clips).then(function (written) {
      if (downloads.length === 0) return written;
      return self
        .transaction(STORES.DOWNLOADS, 'readwrite', function (stores) {
          var store = stores[STORES.DOWNLOADS];
          var stored = 0;
          for (var i = 0; i < downloads.length; i++) {
            var row = downloads[i];
            if (!row || !row.clipId || !row.variant) continue;
            if (DOWNLOAD_STATES.indexOf(row.state) === -1) continue;
            store.put(row);
            stored++;
          }
          return stored;
        })
        .then(function (storedDownloads) {
          self._logger.info('db: importJson wrote ' + written + ' clip(s), ' + storedDownloads + ' download row(s)');
          return written;
        });
    });
  };

  /** Legacy alias: wipe download history. @returns {Promise<number>} */
  SunoDB.prototype.resetDownloadHistory = function () {
    return this.downloads.clear();
  };

  /**
   * Legacy alias: wipe the library. Clears clips, download history, journal
   * and crawl cursors in ONE transaction, and leaves `meta` (schema markers,
   * settings mirror, quota cache) intact so the schema is never invalidated.
   * @returns {Promise<number>} rows removed across stores
   */
  SunoDB.prototype.clear = function () {
    var wiped = [STORES.CLIPS, STORES.DOWNLOADS, STORES.JOURNAL, STORES.SYNC_STATE];
    var self = this;
    return this.transaction(wiped, 'readwrite', function (stores) {
      var jobs = [];
      for (var i = 0; i < wiped.length; i++) {
        (function (name) {
          // Count and clear are both issued synchronously here, so every
          // request is queued before control returns to the event loop.
          jobs.push(
            requestToPromise(stores[name].count(), name).then(function (count) {
              stores[name].clear();
              return count;
            })
          );
        })(wiped[i]);
      }
      return Promise.all(jobs).then(function (counts) {
        var total = 0;
        for (var c = 0; c < counts.length; c++) total += counts[c];
        return total;
      });
    }).then(function (total) {
      self._logger.warn('db: cleared library (' + total + ' rows)');
      return total;
    });
  };

  /* ===================================================================== *
   * 6. EXPORTS
   * ===================================================================== */

  SunoDBRef.DERIVED_VERSION = SunoDB.DERIVED_VERSION;

  var instance = new SunoDB();
  // Statics are mirrored onto the instance because the extension's global is
  // `window.SunoDB` and it is an INSTANCE, not the class.
  instance.DB_NAME = SunoDB.DB_NAME;
  instance.DB_VERSION = SunoDB.DB_VERSION;
  instance.DERIVED_VERSION = SunoDB.DERIVED_VERSION;
  instance.OPEN_TIMEOUT_MS = SunoDB.OPEN_TIMEOUT_MS;
  instance.STORE_NAMES = SunoDB.STORE_NAMES;
  instance.STORES = SunoDB.STORES;
  instance.DOWNLOAD_STATES = SunoDB.DOWNLOAD_STATES;
  instance.DOWNLOAD_SOURCES = SunoDB.DOWNLOAD_SOURCES;
  instance.LEGACY_DB_NAMES = SunoDB.LEGACY_DB_NAMES;
  instance.SunoDB = SunoDB;
  instance.SunoDBError = SunoDBError;
  instance.isBlocked = SunoDBError.isBlocked;
  instance.isQuotaExceeded = SunoDBError.isQuotaExceeded;
  instance.isNotFound = SunoDBError.isNotFound;
  instance.instance = instance;
  instance.isLikedClip = isLikedClip;

  var api = {
    instance: instance,
    SunoDB: SunoDB,
    SunoDBError: SunoDBError,
    ERROR_CODES: ERROR_CODES,
    DB_NAME: SunoDB.DB_NAME,
    DB_VERSION: SunoDB.DB_VERSION,
    STORE_NAMES: SunoDB.STORE_NAMES,
    DOWNLOAD_STATES: SunoDB.DOWNLOAD_STATES,
    DOWNLOAD_SOURCES: SunoDB.DOWNLOAD_SOURCES,
    LEGACY_DB_NAMES: SunoDB.LEGACY_DB_NAMES,
    isBlocked: SunoDBError.isBlocked,
    isQuotaExceeded: SunoDBError.isQuotaExceeded,
    isNotFound: SunoDBError.isNotFound,
    // Convenience factories (Node/tests/background with its own logger).
    create: function (options) {
      return new SunoDB(options);
    },
  };

  // Replaceable logger hook; default is a no-op (never writes to the console).
  instance.setLogger = function (logger) {
    instance._logger = normalizeLogger(logger);
    return instance;
  };

  // MV3 service worker: `self`, no `window`. Content script / options / popup:
  // `window`. Both get the same instance object.
  var scope = typeof window !== 'undefined' && window ? window : typeof self !== 'undefined' ? self : null;
  if (scope) scope.SunoDB = instance;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();