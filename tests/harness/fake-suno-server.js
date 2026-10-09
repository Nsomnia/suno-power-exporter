'use strict';

/**
 * A fake Suno backend, shaped to the exact contract `lib/api.js` and
 * `background/background.js` actually speak.
 *
 * WHY A FETCH AND NOT AN HTTP SERVER: `lib/api.js:985` resolves its transport as
 * `typeof globalThis !== 'undefined' ? globalThis.fetch : null`, and
 * `lib/api.js:1843` calls `this.fetchImpl(url, init)`. So dropping this class's
 * `fetch` method onto the sandbox's `globalThis.fetch` intercepts every request
 * the REAL client makes, with no port, no socket and no flakiness.
 *
 * THE ROUTES SERVED — both confirmed against the real code, not guessed:
 *   `GET  /api/project/me`  `SunoAPI.ENDPOINTS.projectMe` (lib/api.js:1283).
 *          Requested as `?page=N&sort=created_at&show_trashed=false&exclude_shared=false`
 *          (background/background.js:5806-5810). The envelope must carry
 *          `projects: [...]`, a `current_page` that EQUALS the page asked for
 *          (background.js:5829-5835 rejects a mismatch) and `num_total_results`
 *          (background.js:5868).
 *   `POST /api/feed/v3`     `SunoAPI.ENDPOINTS.feedV3` (lib/api.js:1301).
 *          Body `{cursor, limit, filters}` (lib/api.js:2745) — `limit` is a BODY
 *          field, never a query string. Envelope `{clips: [...], next_cursor}`.
 *
 * CURSORS ARE OPAQUE ON PURPOSE. Every cursor is a random base64 token, kept in a
 * private `Map` from token to page offset. Nothing about it looks like a page
 * number, so a walk that "resumes" by guessing `page = n` cannot accidentally
 * pass; and a token the server never issued is rejected rather than coerced,
 * which is what makes the eviction tests honest — the resumed worker must hand
 * back a token this server actually issued before.
 */

const crypto = require('node:crypto');

/** The two verified bases, in the order `lib/api.js:100` lists them. */
const BASE_URLS = ['https://studio-api-prod.suno.com', 'https://studio-api.prod.suno.com'];

const FEED_V3 = '/api/feed/v3';
const PROJECT_ME = '/api/project/me';
const PROJECT_FEED = '/api/project/feed';

/**
 * The three ways a walk can learn it has reached the end of the feed.
 *
 * These map 1:1 onto `readNextCursor`'s three states at `lib/api.js:580-598`,
 * which `iterateFeed` branches on at `lib/api.js:2798`, `:2858` and `:2893`:
 *
 *   'usable'  a cursor was found and is usable    -> keep walking
 *              (lib/api.js:594)
 *   'empty'   a cursor field is PRESENT and null/empty -> `completed:true`,
 *              `stopReason:'complete'` (lib/api.js:2858-2861)
 *   'absent'  NO cursor field under any of the eight aliases -> `completed:true`,
 *              `stopReason:'complete'`, `cursorOmitted:true` (lib/api.js:2893-2896)
 *
 * Both terminal spellings must produce the SAME verdict, and that is exactly
 * what `tests/sync-crawl.test.js` case (d) asserts.
 */
const END_OF_FEED = Object.freeze({
  EMPTY_CURSOR: 'empty-cursor', // next_cursor: null
  OMITTED_CURSOR: 'omitted-cursor', // no cursor field at all
  EMPTY_STRING: 'empty-string', // next_cursor: ''  (api.js:521 treats '' as unusable)
});

/** Failure kinds this server can inject. */
const FAILURE = Object.freeze({
  HTTP_429: '429',
  HTTP_500: '500',
  HTTP_401: '401',
  NETWORK: 'network',
  STALL: 'stall', // never resolves until the abort signal fires — a >30s page
  BAD_JSON: 'bad-json', // 200 with an unparseable body
});

class FakeSunoServer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.totalClips=100] clips the library actually holds
   * @param {number} [opts.serverMaxPageSize=100] the server's own `limit` ceiling;
   *   a request asking for more is silently capped, which is what the real
   *   service does and what `FEED_LIMIT_MAX` exists to describe
   * @param {Array<{id:string,name?:string,clipCount:number}>} [opts.projects]
   *   workspaces, partitioned across `totalClips` in order
   * @param {string} [opts.endOfFeed=END_OF_FEED.EMPTY_CURSOR] which of the three
   *   terminal signals the final page of each workspace uses
   * @param {number} [opts.projectPageSize=20] rows per `/api/project/me` page
   * @param {number} [opts.projectFeedPageSize=30] rows per `/api/project/feed`
   *   page. This walk is what the TODO names as the phase a 200-page cap starves,
   *   so it is a separate knob from the feed's page size.
   * @param {boolean} [opts.projectFeed=true] serve `/api/project/feed`. Set it
   *   false to exercise the `sync.project_feed_incomplete` path
   *   (background.js:7122).
   * @param {Array<object>} [opts.failures] rules, see {@link failWhen}
   * @param {boolean} [opts.clampAdvertisedTotal=false] make `/api/project/me`
   *   under-report `num_total_results`, which is the shape that drives the
   *   `expected_total` verdict (lib/api.js:2953-2965)
   * @param {boolean} [opts.advertiseTotalOnFeed=false] include
   *   `num_total_results` on feed pages too. Left OFF by default because it is a
   *   key in `END_OF_FEED_PAGE_SIGNALS` (lib/api.js:613) and would otherwise
   *   change what an omitted-cursor page looks like.
   */
  constructor(opts = {}) {
    const o = opts || {};

    this.totalClips = numOr(o.totalClips, 100);
    this.serverMaxPageSize = numOr(o.serverMaxPageSize, 100);
    this.projectPageSize = numOr(o.projectPageSize, 20);
    this.projectFeedPageSize = numOr(o.projectFeedPageSize, 30);
    this.projectFeed = o.projectFeed !== false;
    this.endOfFeed = o.endOfFeed || END_OF_FEED.EMPTY_CURSOR;
    this.clampAdvertisedTotal = o.clampAdvertisedTotal === true;
    this.advertiseTotalOnFeed = o.advertiseTotalOnFeed === true;
    this.now = typeof o.now === 'function' ? o.now : () => Date.now();

    // A monotonic clock for request records, independent of the worker's.
    this._t = 0;

    /** Every request, in order. Tests assert on the sequence. */
    this.requests = [];
    /** Rules not yet consumed. */
    this.failures = Array.isArray(o.failures) ? o.failures.slice() : [];

    this.projects = normaliseProjects(o.projects, this.totalClips);
    this._byWorkspace = buildClipLibrary(this.projects, this.totalClips);

    /* The cursor chain. `_cursorForOffset` lazily mints one token per page
     * offset, so a workspace of 400 clips at page size 100 has exactly 3 pages
     * and 4 valid tokens (the null start plus 3), and the walk cannot
     * accidentally walk a 5th. */
    this._cursorToOffset = new Map();
    this._offsetToCursor = new Map();
    this._cursorSeq = 0;

    /** How many times each (workspace, page offset) was actually WALKED — i.e.
     *  requests that got a 200. Refused attempts are excluded. */
    this.servedOffsets = new Map();
    /** How many times each (workspace, page offset) was REQUESTED, refusals
     *  included. This is what proves a retry happened. */
    this.requestedOffsets = new Map();

    /**
     * Requests parked on `FAILURE.STALL`, so an eviction can kill them.
     *
     * THIS IS WHY THE STALL KNOB EXISTS, AND IT IS A HARNESS NECESSITY. A
     * stalled request's promise lives in THIS object, which the TEST owns — so
     * unlike the real worker's `await`, it does not die when the worker's realm
     * is thrown away. Without `cancelInFlight`, an eviction test would leave a
     * promise parked forever and the next worker would never get a clean turn.
     * `Worker.dispose()` calls it, which is the faithful version: in Chrome an
     * eviction kills every in-flight `fetch` belonging to the dying realm.
     */
    this._parked = new Set();
    this.cancelledInFlight = 0;
  }

  /* ------------------------------------------------------------------ *
   * Failure injection
   * ------------------------------------------------------------------ */

  /**
   * Queue a failure.
   *
   * @param {object} rule
   * @param {string} rule.route `'feed' | 'projects'`
   * @param {'429'|'500'|'401'|'network'|'stall'|'bad-json'} [rule.kind='429']
   * @param {number} [rule.pageOffset] only fire on this 0-based page offset
   * @param {number} [rule.workspaceId] only fire on this workspace
   * @param {number} [rule.after=0] let this many matching requests through first
   * @param {number} [rule.times=1] how many matching requests it applies to
   * @param {number} [rule.retryAfterMs=10] Retry-After for a 429
   * @returns {FakeSunoServer} this
   */
  failWhen(rule) {
    this.failures.push({
      route: rule.route || 'feed',
      kind: rule.kind || FAILURE.HTTP_429,
      pageOffset: typeof rule.pageOffset === 'number' ? rule.pageOffset : null,
      workspaceId: rule.workspaceId === undefined ? null : rule.workspaceId,
      after: numOr(rule.after, 0),
      times: numOr(rule.times, 1),
      retryAfterMs: numOr(rule.retryAfterMs, 10),
      _seen: 0,
      _fired: 0,
    });
    return this;
  }

  /** Clear every queued failure. */
  clearFailures() {
    this.failures = [];
    return this;
  }

  /**
   * Abandon every request currently parked on a stall, as an eviction would.
   *
   * Called by `Worker.dispose()`. A real MV3 teardown kills the JS realm
   * MID-AWAIT: the request the dead worker was parked on never resolves, never
   * rejects, and no line after that await ever runs again. So the parked
   * promise is ABANDONED here, not rejected — this used to reject with a
   * network error, which `lib/api.js` classifies as retryable, and the "dead"
   * worker caught it, retried, and went on to finish its entire crawl AFTER the
   * eviction, racing the fresh worker for the same cursor row and flipping
   * end-of-test assertions nondeterministically (observed: the row's
   * `autoResumeAttempts` alternating between the two writers' values across
   * runs). Abandoning keeps the dead realm frozen on its await forever, which
   * is exactly what the row on disk should look like after a real eviction:
   * every write the dead worker already made, and not one more.
   *
   * @returns {number} how many were abandoned
   */
  cancelInFlight() {
    const n = this._parked.size;
    for (const parked of [...this._parked]) {
      this._parked.delete(parked);
      /* deliberately NOT settling `parked.resolve` / `parked.reject`: the
       * promise must never come back, because the realm that awaited it no
       * longer exists to observe anything. */
    }
    this.cancelledInFlight += n;
    return n;
  }

  /**
   * @returns {object|null} the rule that applies to this request, marked consumed
   */
  _matchFailure(route, pageOffset, workspaceId) {
    for (const rule of this.failures) {
      if (rule._fired >= rule.times) continue;
      if (rule.route !== route) continue;
      if (rule.pageOffset !== null && rule.pageOffset !== pageOffset) continue;
      if (rule.workspaceId !== null && String(rule.workspaceId) !== String(workspaceId)) continue;
      rule._seen += 1;
      if (rule._seen <= rule.after) continue;
      rule._fired += 1;
      return rule;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * The fetch seam
   * ------------------------------------------------------------------ */

  /**
   * Drop-in `fetch`. `lib/api.js:1843` calls it as `this.fetchImpl(url, init)`.
   *
   * @param {string} url
   * @param {object} [init]
   * @returns {Promise<object>} a Response-shaped object: `.status`, `.url`,
   *   `.headers` (a `Headers`-alike), `.text()`
   */
  fetch = async (url, init) => {
    const parsed = parseUrl(url);
    const method = String((init && init.method) || 'GET').toUpperCase();
    const signal = (init && init.signal) || null;

    let body = null;
    if (init && typeof init.body === 'string' && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch (err) {
        body = { __unparseable: init.body };
      }
    }

    const base = BASE_URLS.includes(originOf(url)) ? originOf(url) : BASE_URLS[0];
    const record = {
      seq: this.requests.length,
      at: this.now(),
      base,
      method,
      path: parsed.pathname,
      query: parsed.query,
      body,
      status: null,
      route: null,
      pageOffset: null,
      workspaceId: null,
      cursorIn: null,
      cursorOut: null,
      failure: null,
    };
    this.requests.push(record);

    let result;
    try {
      if (parsed.pathname === FEED_V3 && method === 'POST') {
        record.route = 'feed';
        result = await this._serveFeed(record, body, signal);
      } else if (parsed.pathname === PROJECT_ME && method === 'GET') {
        record.route = 'projects';
        result = await this._serveProjects(record, signal);
      } else if (parsed.pathname === PROJECT_FEED && method === 'GET') {
        record.route = 'projectFeed';
        result = await this._serveProjectFeed(record, signal);
      } else {
        record.status = 404;
        result = jsonResponse(404, { error: 'no such route', path: parsed.pathname });
      }
    } catch (err) {
      if (record.status === null) {
        record.status = 0;
        record.failure = 'threw';
      }
      throw err;
    }

    record.status = result.status;
    return result;
  };

  /* ------------------------------------------------------------------ *
   * POST /api/feed/v3
   * ------------------------------------------------------------------ */

  async _serveFeed(record, body, signal) {
    const filters = (body && body.filters) || {};
    const requestedLimit = numOr(body && body.limit, this.serverMaxPageSize);
    // The server's ceiling is not the client's. A request for 100 on a server
    // that grants 50 comes back SHORT, and a short page is NOT end-of-feed —
    // this is the `short_page` ambiguity lib/api.js refuses to resolve.
    const limit = Math.max(1, Math.min(this.serverMaxPageSize, requestedLimit));
    const workspaceId = workspaceOf(filters);
    const cursorIn = body && body.cursor !== undefined ? body.cursor : null;

    record.workspaceId = workspaceId;
    record.cursorIn = cursorIn;

    /* A workspace the fake does not know about is NOT another workspace: it holds
     * NOTHING. This matters because `buildWorkspacePlan`
     * (`background/background.js:5943-5956`) ALWAYS appends a `default`
     * workspace when `/api/project/me` did not report one — lines 5952-5954,
     * with `clipCount: null` because the server said nothing about it. A test
     * that names its workspaces `ws-a`/`ws-b`/`ws-c` therefore always gets a
     * fourth, empty, `default` workspace walked, and it must come back empty.
     *
     * Falling back to `projects[0]` here instead would silently serve another
     * workspace's clips for it, which inflates the feed requests of an unrelated
     * workspace and makes a resume look like it re-walked finished work. */
    const project = this.projects.find((p) => String(p.id) === String(workspaceId)) || null;
    const known = project !== null;

        /* ORDER MATTERS AND IS THE POINT OF THE TWO COUNTERS.
     *
     * The offset is resolved, and BOTH counters bumped, BEFORE any failure is
     * injected. So:
     *
     *   timesRequested()  every request that reached this page, refused ones
     *                     included — this is what proves a RETRY happened.
     *   timesServed()     requests that got a 200 out — this is what proves the
     *                     page was actually WALKED, i.e. not re-fetched after
     *                     an eviction but also not skipped.
     *
     * A test that only counted successes would report "the 429 page was
     * requested once" and pass a crawl that had silently given up, which is the
     * exact bug class this file exists to detect. */
    const offset = cursorIn === null || cursorIn === undefined ? 0 : this._offsetOf(cursorIn);
    if (offset === null) {
      // A cursor this server never issued. A real API would 400; the walk must
      // not be able to invent one.
      record.failure = 'bad-cursor';
      return jsonResponse(400, { error: 'unrecognised cursor', cursor: String(cursorIn) });
    }
    record.pageOffset = offset;
    bump(this.requestedOffsets, workspaceId, offset);
    const injected = this._matchFailure('feed', offset, workspaceId);
    if (injected) {
      record.failure = injected.kind;
      return this._applyFailure(injected, record, signal);
    }
    bump(this.servedOffsets, workspaceId, offset);

    const ids = known ? this._clipsFor(project.id) : [];
    const slice = ids.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const isLast = nextOffset >= ids.length;

    const clips = slice.map((id, i) => this._clip(id, offset + i));

    const envelope = { clips };
    if (!isLast) {
      const out = this._cursorForOffset(nextOffset);
      record.cursorOut = out;
      envelope.next_cursor = out;
    } else {
      record.cursorOut = null;
      applyTerminalSignal(envelope, this.endOfFeed);
    }
    if (this.advertiseTotalOnFeed) envelope.num_total_results = ids.length;
    if (this.clampAdvertisedTotal) {
      envelope.num_total_results = Math.max(0, ids.length - 1);
    }

    return jsonResponse(200, envelope);
  }

  async _applyFailure(rule, record, signal) {
    switch (rule.kind) {
      case FAILURE.NETWORK:
        // A transport failure, which `lib/api.js:1853-1877` turns into a
        // retryable `network_error` — the "transient network error" case.
        throw new TypeError('fetch failed (fake network error)');
      case FAILURE.STALL: {
        // Never resolves until the caller's signal aborts, or until the harness
        // cancels it. This is the shape that produced the reported "no page for
        // 93s" eviction: the worker sits in an `await` and MV3 reclaims it.
        const parked = { reject: null };
        const settled = new Promise((resolve, reject) => { parked.reject = reject; });
        this._parked.add(parked);
        const cap = setTimeout(() => {
          this._parked.delete(parked);
          reject(abortError());
        }, 120000);
        if (typeof cap.unref === 'function') cap.unref();
        if (signal) {
          const onAbort = () => {
            this._parked.delete(parked);
            clearTimeout(cap);
            reject(abortError());
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        await settled;
        throw abortError();
      }
      case FAILURE.BAD_JSON:
        return {
          status: 200,
          url: BASE_URLS[0] + record.path,
          headers: headersOf({ 'content-type': 'application/json' }),
          text: async () => '{not json at all',
        };
      case FAILURE.HTTP_401:
        return jsonResponse(401, { error: 'unauthorized' });
      case FAILURE.HTTP_500:
        return jsonResponse(500, { error: 'upstream error' });
      case FAILURE.HTTP_429:
      default:
        return jsonResponse(429, { error: 'rate limited' }, { 'retry-after': String(rule.retryAfterMs / 1000) });
    }
  }

  /* ------------------------------------------------------------------ *
   * GET /api/project/me
   * ------------------------------------------------------------------ */

  async _serveProjects(record, signal) {
    const page = Math.max(1, parseInt(record.query.get('page') || '1', 10) || 1);

    const injected = this._matchFailure('projects', page - 1, null);
    if (injected) {
      record.failure = injected.kind;
      return this._applyFailure(injected, record, signal);
    }

    const start = (page - 1) * this.projectPageSize;
    const slice = this.projects.slice(start, start + this.projectPageSize);
    const total = this.clampAdvertisedTotal ? Math.max(0, this.projects.length - 1) : this.projects.length;

    return jsonResponse(200, {
      num_total_results: total,
      // MUST echo the page asked for: background.js:5829-5835 fails the walk on
      // a mismatch, and a fake that always answered `current_page: 1` would
      // mask that check entirely.
      current_page: page,
      projects: slice.map((p) => ({
        id: p.id,
        name: p.name,
        clip_count: p.clipCount,
        last_updated_clip: p.lastUpdatedClip === undefined ? null : p.lastUpdatedClip,
      })),
    });
  }

  /* ------------------------------------------------------------------ *
   * GET /api/project/feed — the clip→workspace membership walk
   * ------------------------------------------------------------------ */

  /**
   * `fetchProjectFeed` (lib/api.js:3265-3280) issues `GET /api/project/feed`
   * with `?scope=library&entity_type=clip&limit=N` and a `cursor` query param
   * OMITTED on the first call, and reads `data.items[]`, each shaped
   * `{type, added_at_ms, clip}`.
   *
   * WHY IT IS HERE AND NOT LEFT 404: this is the "mapping" phase the crawl runs
   * BEFORE its first feed page (background.js:7058-7066, "~200 pages on a
   * 6,000-clip library when there is no cache to lean on"). It is the phase the
   * TODO names as starved by the shared `maxPages`, so leaving it broken would
   * mean the harness could never observe that at all.
   *
   * Also note `lib/api.js:3310-3311`: an item whose `clip` key is absent is
   * DROPPED with a bare `if (!clipId) continue` — no counter, no log. Real
   * `/api/project/feed` rows of `type:'video'` carry no `clip` (a fact recorded
   * in the TODO from a 162 KB capture), so a fake that emits only clip-bearing
   * items would silently model the happy path forever. `orphanItems` below makes
   * that droppable shape available on demand.
   */
  async _serveProjectFeed(record, signal) {
    if (!this.projectFeed) {
      record.failure = 'disabled';
      return jsonResponse(404, { error: 'project feed disabled by test configuration' });
    }

    const requestedLimit = numOr(record.query.get('limit'), this.projectFeedPageSize);
    const limit = Math.max(1, Math.min(this.projectFeedPageSize, requestedLimit));
    const cursorIn = record.query.get('cursor');
    const offset = cursorIn === null || cursorIn === undefined ? 0 : this._offsetOf(cursorIn);
    record.pageOffset = offset;
    record.workspaceId = null;
    record.cursorIn = cursorIn === null ? null : cursorIn;

    const injected = this._matchFailure('projectFeed', offset === null ? 0 : offset, null);
    if (injected) {
      record.failure = injected.kind;
      return this._applyFailure(injected, record, signal);
    }
    if (offset === null) {
      record.failure = 'bad-cursor';
      return jsonResponse(400, { error: 'unrecognised cursor', cursor: String(cursorIn) });
    }

    if (!this.servedProjectFeed) this.servedProjectFeed = new Map();
    this.servedProjectFeed.set(offset, (this.servedProjectFeed.get(offset) || 0) + 1);

    const everyId = [];
    for (const ids of this._byWorkspace.values()) for (const id of ids) everyId.push(id);

    const slice = everyId.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const isLast = nextOffset >= everyId.length;

    const items = slice.map((id, i) => ({
      type: 'clip',
      added_at_ms: 1700000000000 + offset + i,
      clip: { id },
      project_id: id.split('-')[0],
    }));

    /* The `type:'video'` row with no `clip` key, which `lib/api.js:3310-3311`
     * drops silently. Injected on the page whose offset is named. */
    if (this.orphanItemOffset !== null && this.orphanItemOffset !== undefined && offset === this.orphanItemOffset) {
      items.push({ type: 'video', added_at_ms: 1700000009999 });
      this.orphanItems = (this.orphanItems || 0) + 1;
    }

    const envelope = { items };
    if (!isLast) {
      const out = this._cursorForOffset(nextOffset);
      record.cursorOut = out;
      envelope.next_cursor = out;
    } else {
      record.cursorOut = null;
      applyTerminalSignal(envelope, this.endOfFeed);
    }
    return jsonResponse(200, envelope);
  }

  /* ------------------------------------------------------------------ *
   * Clip library
   * ------------------------------------------------------------------ */

  _clipsFor(workspaceId) {
    return this._byWorkspace.get(String(workspaceId)) || [];
  }

  /**
   * A clip shaped like a real feed row: `lib/api.js:858 extractClipList` finds
   * `clips[]`, and `normalizeClip` (lib/api.js:905) only needs an `id` plus a
   * URL to scrape `mediaUrls` out of. The `project_id` is what the worker groups
   * by, so it has to be right.
   */
  _clip(id, index) {
    return {
      id,
      title: 'fake clip ' + id,
      created_at: 1700000000 + index,
      added_at_ms: 1700000000000 + index,
      project_id: id.split('-')[0],
      status: 'complete',
      is_liked: false,
      media_urls: ['https://cdn.fake.suno.com/' + id + '.m4a'],
    };
  }

  /* ------------------------------------------------------------------ *
   * Opaque cursors
   * ------------------------------------------------------------------ */

  _cursorForOffset(offset) {
    if (this._offsetToCursor.has(offset)) return this._offsetToCursor.get(offset);
    // 12 random bytes, base64url-ish. Deliberately NOT an encoding of the
    // offset: a walk cannot decode its way to page 7.
    const token = 'c_' + crypto.randomBytes(12).toString('hex');
    this._cursorSeq += 1;
    this._offsetToCursor.set(offset, token);
    this._cursorToOffset.set(token, offset);
    return token;
  }

  /** @returns {number|null} the page offset a token stands for */
  _offsetOf(token) {
    if (token === null || token === undefined) return 0;
    const off = this._cursorToOffset.get(token);
    return off === undefined ? null : off;
  }

  /* ------------------------------------------------------------------ *
   * Assertions support
   * ------------------------------------------------------------------ */

  /** @returns {Array<object>} only the feed requests, in order */
  feedRequests() {
    return this.requests.filter((r) => r.route === 'feed');
  }

  /** @returns {Array<string>} the cursor the client sent on each feed request */
  cursorsSent() {
    return this.feedRequests().map((r) => (r.cursorIn === null ? '<start>' : r.cursorIn));
  }

  /** Every clip id the library actually holds, sorted. The oracle a resume test
   *  compares the indexed set against — "no duplicates and no gaps" means
   *  `db.clipIds()` equals THIS, exactly. */
  expectedIds() {
    const out = [];
    for (const ids of this._byWorkspace.values()) for (const id of ids) out.push(id);
    return out.sort();
  }

  /** @returns {number} how many times a feed page offset was WALKED (200s only) */
  timesServed(workspaceId, offset) {
    return countOf(this.servedOffsets, workspaceId, offset);
  }

  /** @returns {number} how many times a feed page offset was REQUESTED (any outcome) */
  timesRequested(workspaceId, offset) {
    return countOf(this.requestedOffsets, workspaceId, offset);
  }

  /** A snapshot safe to assert against. */
  dump() {
    return {
      totalClips: this.totalClips,
      projects: this.projects.map((p) => ({ ...p })),
      requests: this.requests.map((r) => ({
        seq: r.seq, route: r.route, method: r.method, path: r.path, status: r.status,
        pageOffset: r.pageOffset, workspaceId: r.workspaceId, failure: r.failure,
        cursorIn: r.cursorIn, cursorOut: r.cursorOut,
      })),
    };
  }
}

/* ======================================================================== *
 * helpers
 * ======================================================================== */

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Partition `totalClips` across the workspaces, in order, so the per-project
 * `clip_count` oracle agrees with what the feed actually serves. A fake that
 * disagreed with itself would make `expected_total`
 * (lib/api.js:2953) fail for reasons that have nothing to do with the bug.
 */
function normaliseProjects(projects, totalClips) {
  if (!Array.isArray(projects) || !projects.length) {
    return [{ id: 'default', name: 'My Workspace', clipCount: totalClips }];
  }
  let remaining = totalClips;
  const out = [];
  for (let i = 0; i < projects.length; i += 1) {
    const p = projects[i];
    const isLast = i === projects.length - 1;
    const clipCount = isLast ? remaining : Math.min(remaining, numOr(p.clipCount, remaining));
    remaining -= clipCount;
    out.push({
      id: String(p.id),
      name: p.name || String(p.id),
      clipCount,
      lastUpdatedClip: p.lastUpdatedClip === undefined ? null : p.lastUpdatedClip,
    });
  }
  return out;
}

/**
 * Allocate `<workspace>-<n>` ids, in project order, until `totalClips` is spent.
 * The `id.split('-')[0]` in `_clip` recovers the workspace from the id, so the
 * shape has to carry it.
 */
function buildClipLibrary(projects, totalClips) {
  const byProject = new Map();
  let n = 0;
  for (const p of projects) {
    const ids = [];
    for (let i = 0; i < p.clipCount && n < totalClips; i += 1) {
      ids.push(p.id + '-' + n);
      n += 1;
    }
    byProject.set(p.id, ids);
  }
  return byProject;
}

/**
 * Which workspace a feed request is for. `iterateFeed` builds
 * `filters.workspace = {presence:'only', workspaceId}`
 * (lib/api.js:2701); a `scope:'all'` walk omits it.
 */
function workspaceOf(filters) {
  if (filters && filters.workspace && filters.workspace.workspaceId) {
    return String(filters.workspace.workspaceId);
  }
  return 'default';
}

/**
 * Write the terminal signal onto the last page's envelope.
 *
 * `lib/api.js:589-597` tries the eight `CURSOR_FIELD_ALIASES` in order and
 * reports `usable` / `empty` / `absent`. `empty` needs a field PRESENT with an
 * unusable value (`isUsableCursor`, lib/api.js:519-526, rejects null, undefined,
 * `''`, 0 and `{}`); `absent` needs NO alias at all.
 */
function applyTerminalSignal(envelope, mode) {
  switch (mode) {
    case END_OF_FEED.OMITTED_CURSOR:
      // Deliberately delete nothing and add nothing: `next_cursor` simply never
      // appears. This is the spelling every walk on the recon account ends on
      // (lib/api.js:2863-2869).
      break;
    case END_OF_FEED.EMPTY_STRING:
      envelope.next_cursor = '';
      break;
    case END_OF_FEED.EMPTY_CURSOR:
    default:
      envelope.next_cursor = null;
      break;
  }
}

function parseUrl(url) {
  const u = new URL(url);
  return { pathname: u.pathname, search: u.search, query: u.searchParams };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (err) {
    return String(url).split('/').slice(0, 3).join('/');
  }
}

function headersOf(obj) {
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = String(obj[k]);
  return {
    get: (name) => {
      const v = lower[String(name).toLowerCase()];
      return v === undefined ? null : v;
    },
    forEach: (fn) => {
      for (const k of Object.keys(lower)) fn(lower[k], k);
    },
    entries: function* () {
      for (const k of Object.keys(lower)) yield [k, lower[k]];
    },
  };
}

/**
 * @returns {object} a Response-shaped object. `lib/api.js:1880-1888` reads
 * `.status`, then `headersToObject(response.headers)` (which prefers
 * `forEach`/`entries`), then `await response.text()`.
 */
function jsonResponse(status, payload, extraHeaders) {
  return {
    status,
    ok: status < 400,
    url: BASE_URLS[0],
    headers: headersOf({ 'content-type': 'application/json', ...(extraHeaders || {}) }),
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Count an offset out of a `Map<key, Map<offset, n>>`.
 * @param {Map<string, Map<number, number>>} store
 */
function countOf(store, key, offset) {
  const m = store.get(String(key));
  return m ? (m.get(offset) || 0) : 0;
}

function bump(store, key, offset) {
  if (!store.has(key)) store.set(key, new Map());
  const m = store.get(key);
  m.set(offset, (m.get(offset) || 0) + 1);
}

module.exports = {
  FakeSunoServer,
  END_OF_FEED,
  FAILURE,
  BASE_URLS,
  FEED_V3,
  PROJECT_ME,
};