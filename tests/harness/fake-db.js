'use strict';

/**
 * An in-memory `SunoDB`, implementing exactly the surface `background.js`
 * touches and nothing more.
 *
 * THE SURFACE, and where each member is called from (measured with
 * `grep -ohE "DB\.[a-z]+\.[a-z]+" background/background.js | sort | uniq -c`):
 *
 *   syncState.set        17   background.js:7384, :7434 (the cursor, EVERY page)
 *   journal.append       15   background.js:4923, :4944, :4965, :5001, ...
 *   meta.get             11   background.js:5606, :10931
 *   syncState.get         9   background.js:6834, :10998, ...
 *   meta.set              7   background.js:4668
 *   downloads.markFailed  7   background.js:3780, :3822, ...
 *   clips.count           5   background.js:5606
 *   downloads.markSkipped 4
 *   clips.get             3   background.js:4331
 *   downloads.markPending / markInProgress / markDone  2 each
 *   downloads.history     2
 *   downloads.countByState 2
 *   clips.putMany         2   background.js:7181, :7226
 *   clips.all             2   background.js:4722 (`{limit:-1}` = ALL, :517)
 *   meta.remove           1   background.js:10944
 *   journal.trim          1   background.js:5380
 *   downloads.resetInProgress 1
 *   downloads.isDone      1
 *   downloads.count       1
 *   clips.getMany         1   background.js:4740
 *   clips.bulkReplace     1   background.js:7906 — resolves `{written}` (see :7907)
 *
 *   Plus, called on the BOOTSTRAP path the harness has to survive:
 *   open / ensureDerived / setLogger / close  (background.js:10901-10902, :1381)
 *
 * SURVIVING EVICTION IS THE POINT. A real `SunoDB` is backed by IndexedDB, which
 * outlives an MV3 service worker; this object is therefore held by the TEST and
 * handed to each worker instance, never owned by one. `createWorker()` in
 * `worker.js` takes it as a parameter for exactly this reason.
 *
 * `syncState.set` MERGES. Confirmed at `lib/db.js:2010`:
 *
 *     var row = Object.assign({}, req.result || {}, patch || {});
 *
 * i.e. the stored row is the base and the patch wins on every colliding key.
 * The monolith depends on this HARD and says so in its own comments
 * (`background.js:6748`, `:6773`, `:6815`, `:7946`): it nulls `nextPage`/`pass`
 * and resets `cachedSkipped`/`interrupted` explicitly because omitting a key
 * from the patch would leave the previous run's value visible. A fake that
 * REPLACED would make those comments look like cargo cult — and would make this
 * harness disagree with production on exactly the resume path it exists to test.
 */

const DEFAULT_LIMIT = 1000;

class FakeDB {
  constructor(opts = {}) {
    this.log = [];
    this.opened = 0;
    this.ensuredDerived = 0;
    this.logger = null;

    /** key -> row */
    this._syncState = new Map();
    /** key -> value (JSON-cloned on write so callers cannot mutate stored state) */
    this._meta = new Map();
    /** clipId -> clip record */
    this._clips = new Map();
    /** `${clipId}|${variant}` -> download row */
    this._downloads = new Map();
    /** batchId -> [entries] */
    this._journal = new Map();

    this.setLogger = (logger) => { this.logger = logger; };
  }

  /* ------------------------------------------------------------------ *
   * lifecycle
   * ------------------------------------------------------------------ */

  /** background.js:10901 */
  async open() {
    this.opened += 1;
    this._record('open');
    return this;
  }

  /** background.js:10902 */
  async ensureDerived() {
    this.ensuredDerived += 1;
    this._record('ensureDerived');
    return true;
  }

  async close() {
    this._record('close');
  }

  async clear() {
    this._syncState.clear();
    this._meta.clear();
    this._clips.clear();
    this._downloads.clear();
    this._journal.clear();
  }

  /* ------------------------------------------------------------------ *
   * syncState — the resumable crawl cursor
   * ------------------------------------------------------------------ */

  get syncState() {
    const owner = this;
    return {
      /**
       * lib/db.js:1967. A missing row returns `fallback`, and an UNDEFINED
       * fallback returns `null` — which is what `DB.syncState.get('feed', null)`
       * (background.js:6834) relies on to tell "no row" from "empty row".
       */
      async get(key, fallback) {
        owner._record('syncState.get', { key });
        if (!key) throw new Error('INVALID_ARGUMENT: syncState key is required');
        const row = owner._syncState.get(String(key));
        if (row === undefined || row === null) return fallback === undefined ? null : fallback;
        return deepClone(row);
      },

      /**
       * lib/db.js:1992. MERGE, and stamp `key` + `updatedAt`. This is the single
       * most load-bearing behaviour in the fake: the whole eviction/resume path
       * is "does the row the previous worker wrote still say `state:'running'`
       * with the project list half done".
       */
      async set(key, patch) {
        owner._record('syncState.set', { key, patch });
        if (!key) throw new Error('INVALID_ARGUMENT: syncState key is required');
        if (patch !== undefined && patch !== null && typeof patch !== 'object') {
          throw new Error('INVALID_ARGUMENT: syncState patch must be an object');
        }
        // lib/db.js:2010 — Object.assign({}, stored || {}, patch || {})
        const merged = Object.assign({}, owner._syncState.get(String(key)) || {}, patch || {});
        merged.key = String(key);
        merged.updatedAt = owner._now();
        owner._syncState.set(String(key), deepClone(merged));
        return deepClone(merged);
      },

      /** lib/db.js:2029 */
      async clear(key) {
        owner._record('syncState.clear', { key });
        const had = owner._syncState.delete(String(key));
        return had;
      },

      async all() {
        return [...owner._syncState.values()].map(deepClone);
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * meta
   * ------------------------------------------------------------------ */

  get meta() {
    const owner = this;
    return {
      async get(key, fallback) {
        owner._record('meta.get', { key });
        const v = owner._meta.get(String(key));
        if (v === undefined) return fallback === undefined ? null : fallback;
        return deepClone(v);
      },
      async set(key, value) {
        owner._record('meta.set', { key });
        owner._meta.set(String(key), deepClone(value));
        return value;
      },
      async remove(key) {
        owner._record('meta.remove', { key });
        return owner._meta.delete(String(key));
      },
      async keys() {
        return [...owner._meta.keys()];
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * clips
   * ------------------------------------------------------------------ */

  get clips() {
    const owner = this;
    return {
      /**
       * lib/db.js:1245. Upsert by id, one transaction for the whole batch (the
       * monolith relies on "ONE transaction per page, never one per clip",
       * background.js:5569). Returns the number WRITTEN.
       */
      async putMany(clips) {
        owner._record('clips.putMany', { n: Array.isArray(clips) ? clips.length : 0 });
        if (!Array.isArray(clips)) throw new Error('INVALID_ARGUMENT: putMany expects an array');
        let written = 0;
        for (const clip of clips) {
          if (!clip || typeof clip !== 'object') continue;
          if (clip.id === undefined || clip.id === null || clip.id === '') continue;
          const id = String(clip.id);
          owner._clips.set(id, buildClipRecord(clip, owner._clips.get(id)));
          written += 1;
        }
        return written;
      },

      /** lib/db.js:1288 */
      async getMany(ids) {
        owner._record('clips.getMany', { n: Array.isArray(ids) ? ids.length : 0 });
        if (!Array.isArray(ids)) return [];
        const out = [];
        for (const id of ids) {
          const row = owner._clips.get(String(id));
          if (row) out.push(deepClone(row));
        }
        return out;
      },

      async get(id) {
        owner._record('clips.get', { id });
        const row = owner._clips.get(String(id));
        return row ? deepClone(row) : null;
      },

      /**
       * lib/db.js:1316. `all()` defaults to 1000 rows; a NEGATIVE limit means
       * "all" — which is how the monolith calls it (background.js:517,
       * `ALL_CLIPS = Object.freeze({limit: -1})`, used at :4722).
       */
      async all(options) {
        owner._record('clips.all', { options });
        const o = options || {};
        let limit = Number.isFinite(o.limit) ? Math.floor(o.limit) : DEFAULT_LIMIT;
        if (limit < 0) limit = Infinity;
        const offset = Number.isFinite(o.offset) && o.offset > 0 ? Math.floor(o.offset) : 0;
        return [...owner._clips.values()].slice(offset, offset + limit).map(deepClone);
      },

      /** lib/db.js:1336 */
      async count() {
        return owner._clips.size;
      },

      /**
       * lib/db.js:1422. ONE ATOMIC replace — the forced re-sync path
       * (background.js:7906) reads `result.written`.
       */
      async bulkReplace(clips) {
        owner._record('clips.bulkReplace', { n: Array.isArray(clips) ? clips.length : 0 });
        if (!Array.isArray(clips)) throw new Error('INVALID_ARGUMENT: bulkReplace expects an array');
        const before = owner._clips.size;
        owner._clips.clear();
        let written = 0;
        for (const clip of clips) {
          if (!clip || typeof clip !== 'object') continue;
          if (clip.id === undefined || clip.id === null || clip.id === '') continue;
          owner._clips.set(String(clip.id), buildClipRecord(clip, null));
          written += 1;
        }
        return { written, removed: before, store: 'clips' };
      },

      async clear() {
        owner._record('clips.clear');
        const n = owner._clips.size;
        owner._clips.clear();
        return n;
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * journal
   * ------------------------------------------------------------------ */

  get journal() {
    const owner = this;
    return {
      /** lib/db.js:2068. Entry is `{batchId, phase, detail, clipId, variant}`. */
      async append(entry) {
        owner._record('journal.append', { batchId: entry && entry.batchId, phase: entry && entry.phase });
        const batchId = String((entry && entry.batchId) || '');
        if (!owner._journal.has(batchId)) owner._journal.set(batchId, []);
        const rows = owner._journal.get(batchId);
        rows.push(Object.assign({ at: owner._now() }, entry || {}));
        return { batchId, length: rows.length };
      },

      /** lib/db.js:2144. */
      async trim(batchId) {
        owner._record('journal.trim', { batchId });
        const rows = owner._journal.get(String(batchId)) || [];
        owner._journal.delete(String(batchId));
        return rows.length;
      },

      async all(batchId) {
        return (owner._journal.get(String(batchId)) || []).map(deepClone);
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * downloads — not used by the crawl, but the bootstrap path touches it
   * ------------------------------------------------------------------ */

  get downloads() {
    const owner = this;
    const keyOf = (clipId, variant) => String(clipId) + '|' + String(variant);

    const mark = (state) => async (clipId, variant, meta, extra) => {
      owner._record('downloads.' + state, { clipId, variant });
      const key = keyOf(clipId, variant);
      const row = owner._downloads.get(key) || {
        clipId: String(clipId), variant: String(variant), state: 'PENDING',
        attempts: 0, history: [],
      };
      row.state = state.toUpperCase();
      if (state === 'failed' || state === 'skipped') {
        row.error = (extra && extra.error) || (meta instanceof Error ? meta.message : meta) || null;
      }
      row.history.push({ state: row.state, at: owner._now(), meta: meta && !(meta instanceof Error) ? meta : null });
      row.updatedAt = owner._now();
      owner._downloads.set(key, row);
      return deepClone(row);
    };

    return {
      markPending: async (clipId, variant, meta) => {
        owner._record('downloads.markPending', { clipId, variant });
        const key = keyOf(clipId, variant);
        const row = owner._downloads.get(key) || {
          clipId: String(clipId), variant: String(variant), attempts: 0, history: [],
        };
        row.state = 'PENDING';
        row.meta = meta || null;
        owner._downloads.set(key, row);
        return deepClone(row);
      },
      markInProgress: async (clipId, variant, meta) => {
        owner._record('downloads.markInProgress', { clipId, variant });
        const key = keyOf(clipId, variant);
        const row = owner._downloads.get(key) || {
          clipId: String(clipId), variant: String(variant), attempts: 0, history: [],
        };
        row.state = 'IN_PROGRESS';
        row.attempts += 1;
        row.meta = meta || null;
        owner._downloads.set(key, row);
        return deepClone(row);
      },
      markDone: mark('done'),
      markFailed: mark('failed'),
      markSkipped: mark('skipped'),

      async isDone(clipId, variant) {
        owner._record('downloads.isDone', { clipId, variant });
        const row = owner._downloads.get(keyOf(clipId, variant));
        return !!row && row.state === 'DONE';
      },

      async count() {
        return owner._downloads.size;
      },

      /** lib/db.js:1909 shape: a `{STATE: n}` bag. */
      async countByState() {
        owner._record('downloads.countByState');
        const out = {};
        for (const row of owner._downloads.values()) {
          out[row.state] = (out[row.state] || 0) + 1;
        }
        return out;
      },

      async history(clipId, variant) {
        owner._record('downloads.history', { clipId, variant });
        const row = owner._downloads.get(keyOf(clipId, variant));
        return row ? deepClone(row.history) : [];
      },

      /** background.js:3808 — reconciles rows the previous worker left mid-flight. */
      async resetInProgress() {
        owner._record('downloads.resetInProgress');
        let n = 0;
        for (const [key, row] of owner._downloads.entries()) {
          if (row.state === 'IN_PROGRESS') {
            row.state = 'PENDING';
            owner._downloads.set(key, row);
            n += 1;
          }
        }
        return n;
      },

      async all() {
        return [...owner._downloads.values()].map(deepClone);
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * assertions
   * ------------------------------------------------------------------ */

  /** A snapshot tests can assert against without holding a live reference. */
  dump() {
    const sync = {};
    for (const [k, v] of this._syncState.entries()) sync[k] = deepClone(v);
    const meta = {};
    for (const [k, v] of this._meta.entries()) meta[k] = deepClone(v);
    const journal = {};
    for (const [k, v] of this._journal.entries()) journal[k] = v.length;
    return {
      clips: this._clips.size,
      clipIds: [...this._clips.keys()].sort(),
      syncState: sync,
      meta,
      journal,
      downloads: this._downloads.size,
      calls: this.log.map((e) => e.op),
    };
  }

  /** The crawl cursor, or `null`. */
  feedCursor() {
    const row = this._syncState.get('feed');
    return row ? deepClone(row) : null;
  }

  /** Every clip id currently indexed, sorted. */
  clipIds() {
    return [...this._clips.keys()].sort();
  }

  /**
   * Every call this DB saw, in order. Tests use it to prove the resumed worker
   * re-read the cursor before writing anything.
   */
  calls() {
    return this.log.map((e) => ({ ...e }));
  }

  /** Calls of one kind. */
  callsTo(op) {
    return this.log.filter((e) => e.op === op);
  }

  resetLog() {
    this.log = [];
  }

  _record(op, detail) {
    this.log.push({ op, at: Date.now(), detail: detail || null });
  }

  _now() {
    return Date.now();
  }
}

/**
 * A clip record shaped like the real one: an `id`, the search fields the query
 * layer reads, and an `updatedAt`. The monolith stores what `normalizeClip`
 * produced (`lib/api.js:905`) — i.e. the raw row plus `mediaUrls`, `isLiked`.
 */
function buildClipRecord(clip, previous) {
  const id = String(clip.id);
  const record = {
    id,
    title: clip.title === undefined ? (previous && previous.title) || '' : String(clip.title),
    prompt: clip.prompt === undefined ? (previous && previous.prompt) || '' : String(clip.prompt),
    created_at: Number(clip.created_at) || (previous && previous.created_at) || 0,
    added_at_ms: Number(clip.added_at_ms) || (previous && previous.added_at_ms) || 0,
    status: clip.status === undefined ? (previous && previous.status) || 'complete' : clip.status,
    project_id: clip.project_id === undefined
      ? (previous && previous.project_id) || null
      : (clip.project_id === null ? null : String(clip.project_id)),
    project_ids: normaliseStringList(clip.project_ids || (previous && previous.project_ids)),
    is_liked: clip.is_liked === undefined
      ? (previous && previous.isLiked === true) || false
      : clip.is_liked === true,
    media_urls: normaliseStringList(clip.media_urls || (previous && previous.media_urls)),
    mediaUrls: normaliseStringList(clip.mediaUrls || clip.media_urls || (previous && previous.mediaUrls)),
    updatedAt: Date.now(),
    createdAt: Date.now(),
  };
  return record;
}

function normaliseStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : String(v);
    if (s && out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

module.exports = { FakeDB, DEFAULT_LIMIT };