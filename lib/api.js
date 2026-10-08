/**
 * Suno Master Utility — lib/api.js
 * ============================================================================
 * Authenticated Suno Studio API client.
 *
 * Every route in `SunoAPI.ENDPOINTS` below was confirmed to EXIST by
 * authenticated recon on 2026-09-30 / 2026-10-01 (ground truth). Routes the
 * previous implementation referenced but which are fiction have been removed
 * outright, not "kept as a fallback":
 *
 *   - there is NO liked-songs route at all. Liking is per-clip state carried on
 *     each clip object (`is_liked`). It is derived locally by filtering the feed.
 *   - there is no `ids` query on the feed route. Use the clips-by-ids route.
 *   - `GET /api/feed/v2` is NOT a Suno web-app route and has been REMOVED from
 *     the table below rather than "kept as a fallback". It appears in ZERO of
 *     the 96 shipped bundle chunks and in ZERO captures, its page size is a
 *     fixed 20, and its own `num_total_results` reported **21** for an account
 *     whose `/api/project/me` reported **3,444** clips in a single workspace.
 *     Enumerating a library through it caps a 5,500-clip sync at 400 clips
 *     across 20 pages and still reports success — that is the silent-truncation
 *     bug {@link SunoAPI#iterateFeed} now walks away from. Library enumeration
 *     is `POST /api/feed/v3` (cursor in the BODY, server max `limit` 100).
 *   - none of the 84 experimental route names probed (168 requests, both
 *     methods, anonymous and authenticated) are deployed: all 404. Those names
 *     survive only in the public bundle's route manifest. The allowlist is gone.
 *   - suno.com is the Next.js web origin and does NOT proxy `/api/*`.
 *   - `studio-api-staging`, `-beta`, `-dev`, `-preview`, `-canary` do not
 *     resolve. Staging in particular is an unauthenticated misconfiguration to
 *     report to Suno, never to contact.
 *   - the session route is not a model catalogue. `/api/billing/info/` is.
 *
 * Hard-won behaviours encoded below:
 *
 *   1. A download route can answer HTTP 200 with a REFUSAL body
 *      `{"ok":false,"reason":"no_permission",...}`. Never branch on
 *      `resp.ok` for downloads; parse the body via `parseDownloadResponse`.
 *   2. `POST /api/download/clips/zip/prepare` takes a FLAT body and caps
 *      `clip_ids` at 200 per request.
 *   3. One song = one download regardless of format; re-downloading in a
 *      different format does NOT re-count. Batch per SONG and dedupe by clip id
 *      before spending quota — batching per format burns it N times over.
 *   4. The Clerk JWT is not readable from `document.cookie`. `__session` is
 *      HttpOnly and is a different, Next.js SSR value; sending it as a Bearer
 *      token is a bug. The token arrives via an injected token provider.
 *   5. A 401 while the JWT `exp` is still in the future is a BAD TOKEN, not an
 *      expired session. Surfaced as `error.code === 'bad_token'` vs
 *      `'unauthorized'`.
 *   6. 403 from the wav routes means ENTITLEMENT, not auth.
 *   7. Clerk hydrates long AFTER document-start, so the first token probe of a
 *      sync can legitimately find nothing. One forced re-acquisition, then
 *      `missing_token` — which means "could not mint", never "signed out".
 *   8. A feed walk is only COMPLETE on a POSITIVE signal: an `ok` envelope whose
 *      cursor field is PRESENT and explicitly null/empty after at least one page.
 *      Three states, not two, and the distinction is load-bearing — see
 *      {@link readNextCursor} and {@link SunoAPI#iterateFeed}:
 *        (a) a usable cursor            -> keep walking;
 *        (b) NO cursor field at all    -> BUG: this parser does not understand the
 *                                          response. `stopReason:'cursor_missing'`,
 *                                          `completed:false`. NEVER "the end".
 *        (c) present and null/empty     -> genuine end of feed, and the ONLY state
 *                                          that may set `stopReason:'complete'`.
 *      Before this distinction existed, (b) and (c) were the same `null`, so a
 *      server that named its cursor anything other than `next_cursor` made page 1
 *      look like the end of a 5,500-clip library — which is exactly the reported
 *      symptom. Two empty pages, a short page, or a page counter running out are
 *      all evidence of a problem, never evidence of the end of the library.
 *   9. The `limit` a feed page returns is NOT verified. `FEED_LIMIT_MAX` is the
 *      documented/observed maximum (the shipped bundle, plus two third-party
 *      extensions' claims); no live response has been checked against it. That is
 *      why `pagesFull`/`lastPageSize` are published — a page that came back FULL
 *      to a larger request is the direct evidence either way, and
 *      {@link SunoAPI#fetchFeedPageRaw} exists to fetch one and measure it.
 *
 * No page tampering: this file never monkey-patches `window.fetch` and never
 * injects script. It is a plain IIFE so no internal name leaks to global scope.
 */

(function () {
  'use strict';

  /* ====================================================================
   * 0. Verified constants
   * ================================================================== */

  /** Primary + fallback API hosts. Both confirmed live. */
  const VERIFIED_BASE_URLS = Object.freeze([
    'https://studio-api-prod.suno.com',
    'https://studio-api.prod.suno.com',
  ]);

  /**
   * Stream URL pattern confirmed on real clip objects. NOT a "download" route:
   * it serves the stream and never touches the download quota, so it must
   * never be reported as a successful download.
   */
  const MEDIA_CDN_TEMPLATE = 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/{id}.m4a';

  /**
   * Route fragments that must never appear in a request path. Assembled from
   * concatenated parts on purpose, so this guard cannot itself re-introduce the
   * literal strings it forbids.
   *   '/b-' + 'side/'      -> 84 names probed, 0 deployed, all 404
   *   'suno.' + 'com/api'   -> web origin, does not proxy /api/*
   *   the playlist 'liked' route -> does not exist at all
   */
  const FORBIDDEN_ROUTE_FRAGMENTS = Object.freeze([
    '/b-' + 'side/',
    'suno.' + 'com/api',
    '/api/playlist/' + 'liked',
  ]);

  /** Host substrings that are not deployed and must never be contacted. */
  const FORBIDDEN_HOST_FRAGMENTS = Object.freeze([
    'staging',
    '-beta',
    '-dev',
    '-preview',
    '-canary',
  ]);

  /** Refresh this long before the JWT's own `exp` to avoid racing expiry. */
  const TOKEN_EXPIRY_SKEW_MS = 30_000;
  /** TTL assumed for a non-JWT (opaque) bearer token. Short on purpose. */
  const OPAQUE_TOKEN_TTL_MS = 60_000;

  /**
   * How long a request waits before spending its ONE extra token acquisition on
   * an empty first probe. Clerk hydrates well after document-start, so a
   * re-probe issued in the same tick reproduces the same null.
   */
  const MISSING_TOKEN_RETRY_WAIT_MS = 750;
  /** Hard cap on the slice of the caller's own timeout that wait may consume. */
  const MISSING_TOKEN_WAIT_RATIO = 0.5;

  /**
   * `missing_token` means the token could not be MINTED, not that the user is
   * signed out — they usually are signed in, and the page simply has not produced
   * a Clerk JWT yet. The old wording ("no Clerk JWT available; authenticated call
   * not attempted") is accurate but reads as "you are not logged in" and gives the
   * user nothing to do.
   *
   * `background/background.js` branches on `error.code === 'missing_token'` in
   * four places, so the CODE is load-bearing and must not change. This message
   * carries no token, no URL with credentials and nothing else sensitive.
   */
  const MISSING_TOKEN_MESSAGE =
    'could not obtain a session token from the suno.com page, so the authenticated call '
    + 'was never sent. The Clerk session on that page may still be loading, or no signed-in '
    + 'suno.com tab is available to read it from. Open suno.com, sign in, reload that tab, '
    + 'then press Refresh to retry.';

  const DEFAULT_RATE_PER_SECOND = 4;
  const DEFAULT_CONCURRENCY = 3;
  const DEFAULT_MAX_PAGES = 500;
  const DEFAULT_RETRIES = 3;
  const DEFAULT_TIMEOUT_MS = 30_000;
  const BACKOFF_BASE_MS = 400;
  const BACKOFF_CAP_MS = 8_000;
  const MAX_HONOURED_RETRY_AFTER_MS = 60_000;
  const ZIP_CHUNK_SIZE = 200; // CONFIRMED server maximum for clip_ids
  const IDS_CHUNK_SIZE = 100; // conservative server maximum for ?ids=
  const QUOTA_CACHE_TTL_MS = 30_000;

  /**
   * The `limit` ceiling a `POST /api/feed/v3` BODY asks for.
   *
   * ASSUMED, NOT VERIFIED — the grade of this constant matters, so it is stated
   * rather than implied: 100 is what the shipped web client's own OpenAPI caller
   * documents, what the bundle sends, and what two third-party extensions claim
   * ("rejects limit > 100", recon 2026-09). NO LIVE RESPONSE HAS CONFIRMED IT.
   * If the real cap were 20, a `limit:100` walk would still follow its cursor to
   * the end — so a wrong cap cannot truncate the library — but every piece of
   * "full page" reasoning, and every page-count estimate, would be wrong by 5x.
   * {@link SunoAPI#fetchFeedPageRaw} fetches one page and reports how many clips
   * actually came back, which is how the assumption gets settled on a real
   * account instead of by argument.
   */
  const FEED_LIMIT_MAX = 100;

  /**
   * Every spelling a feed envelope's cursor has plausibly travelled under, in the
   * order they are tried.
   *
   * `next_cursor` is what the shipped client documents on the wire and is tried
   * first; the rest are pure tolerance. The ORDER is also the REPORTING order:
   * {@link SunoAPI#fetchFeedPageRaw} reports a per-name census in this order, so
   * "which name matched" and "what each name held" are the same list.
   * @type {ReadonlyArray<string>}
   */
  const CURSOR_FIELD_ALIASES = Object.freeze([
    'next_cursor',
    'nextCursor',
    'cursor',
    'next',
    'next_page',
    'nextPage',
    'next_page_token',
    'continuation',
  ]);

  /**
   * Retry budget for a library walk only. `request()`'s default of 3 retries
   * (4 attempts) is thin across ~55 pages of a 5,500-clip library, where one
   * transient 5xx costs a page; the walk gets 5. The GLOBAL default is
   * untouched — downloads and one-shot calls keep their 3.
   */
  const FEED_PAGE_RETRIES = 5;
  /**
   * `GET /api/project/feed` page size. 30 is the value the shipped web client
   * sends; the server maximum was not probed and is not assumed.
   */
  const PROJECT_FEED_LIMIT = 30;

  /**
   * v3's `disliked` filter is a TRI-STATE OF STRINGS, not a boolean:
   * `'Any' | 'True' | 'False'` (bundle `BooleanFilter`). Mapping the caller's
   * vocabulary onto it is the whole reason the two-pass diff is unnecessary —
   * Suno still exposes no per-clip dislike field, but the SERVER can now be
   * asked for exactly the disliked rows, so one walk replaces two.
   * @type {Readonly<Record<string, string>>}
   */
  const DISLIKED_FILTER_VALUES = Object.freeze({
    any: 'Any',
    only: 'True',
    exclude: 'False',
  });

  /** Business rule string observed verbatim on the zip route. */
  const BULK_UNAVAILABLE_MARKER = 'Bulk download is not available';

  /**
   * The verified route values, indexed for O(1) membership. Filled immediately
   * after the class body is evaluated; used so `request()` can refuse to build a
   * URL from anywhere outside the table.
   * @type {Record<string, boolean>}
   */
  let VERIFIED_ROUTE_SET = {};

  /* ====================================================================
   * 1. Logging — a single injected logger, silent by default
   * ================================================================== */

  const noop = () => {};

  const NOOP_LOGGER = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop });

  /**
   * @param {{debug?:Function,info?:Function,warn?:Function,error?:Function}|null} logger
   * @returns {{debug:Function,info:Function,warn:Function,error:Function}}
   */
  function normalizeLogger(logger) {
    if (!logger) return NOOP_LOGGER;
    return {
      debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : noop,
      info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
      warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
      error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
    };
  }

  /**
   * Module-level warn sink, re-pointed at the newest instance's logger. Helpers
   * that have no instance context still have to be able to report.
   * @type {Function}
   */
  let moduleWarn = noop;

  const REDACTED = '[redacted]';

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (err) {
      moduleWarn('safeStringify failed: ' + redact(err && err.message));
      return String(value);
    }
  }

  /**
   * Strip anything token-shaped before it reaches a log sink or Error message.
   * Covers both `Bearer <jwt>` headers and bare JWTs embedded in text.
   * @param {unknown} value
   * @returns {string}
   */
  function redact(value) {
    if (value === null || value === undefined) return '';
    let text = typeof value === 'string' ? value : safeStringify(value);
    text = text.replace(/(bearer\s+)[\w\-._~+/]+=*/gi, `$1${REDACTED}`);
    text = text.replace(/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, REDACTED);
    return text;
  }

  /* ====================================================================
   * 2. Small utilities — no third-party dependencies
   * ================================================================== */

  /** @returns {Error} an error that reads as control flow, not failure. */
  function makeAbortError() {
    const err = new Error('Operation aborted');
    err.name = 'AbortError';
    err.code = 'aborted';
    err.aborted = true;
    err.retryable = false;
    return err;
  }

  /**
   * @param {unknown} e
   * @returns {boolean} true when `e` represents an abort rather than a failure.
   */
  function isAbortError(e) {
    return !!e && (e.name === 'AbortError' || e.code === 'aborted' || e.aborted === true);
  }

  /**
   * Sleep that rejects promptly when `signal` aborts.
   * @param {number} ms
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  function sleep(ms, signal) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(makeAbortError());
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Full-jitter exponential backoff.
   * @param {number} attempt 1-based
   * @param {() => number} random
   * @returns {number} milliseconds
   */
  function jitteredBackoffMs(attempt, random) {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt)));
    return Math.floor(random() * ceiling);
  }

  /**
   * Parse `Retry-After`, which may be delta-seconds or an HTTP-date.
   * @param {Record<string,string>} headers
   * @param {number} now
   * @returns {number|null} milliseconds (capped), or null when absent/unusable
   */
  function parseRetryAfterMs(headers, now) {
    const raw = getHeader(headers, 'retry-after');
    if (!raw) return null;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.min(MAX_HONOURED_RETRY_AFTER_MS, Math.round(asNumber * 1000));
    }
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) {
      return Math.min(MAX_HONOURED_RETRY_AFTER_MS, Math.max(0, asDate - now));
    }
    moduleWarn('unparseable Retry-After header: ' + redact(raw));
    return null;
  }

  /**
   * Decode one base64url JWT segment without any library.
   * @param {string} segment
   * @returns {string|null} utf-8 text, or null when not decodable
   */
  function base64UrlDecode(segment) {
    if (typeof segment !== 'string' || segment.length === 0) return null;
    try {
      const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
      const remainder = b64.length % 4;
      const padded = remainder === 0 ? b64 : b64 + '='.repeat(4 - remainder);
      if (typeof atob === 'function') {
        const binary = atob(padded);
        let percent = '';
        for (let i = 0; i < binary.length; i += 1) {
          percent += '%' + ('00' + binary.charCodeAt(i).toString(16)).slice(-2);
        }
        return decodeURIComponent(percent);
      }
      if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8');
      moduleWarn('no base64 decoder (atob/Buffer) available; treating token as opaque');
      return null;
    } catch (err) {
      moduleWarn('base64url decode failed: ' + redact(err && err.message));
      return null;
    }
  }

  /**
   * Read `exp` (seconds) out of a JWT and return epoch milliseconds.
   * @param {string} token
   * @returns {number|null} null when the token is not a JWT
   */
  function decodeJwtExpiry(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const payload = base64UrlDecode(parts[1]);
    if (!payload) return null;
    try {
      const claims = JSON.parse(payload);
      if (claims && typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
        return claims.exp * 1000;
      }
      moduleWarn('JWT payload decoded but carries no numeric exp claim');
      return null;
    } catch (err) {
      moduleWarn('JWT payload is not JSON: ' + redact(err && err.message));
      return null;
    }
  }

  /**
   * @param {unknown[]} list
   * @param {number} size
   * @returns {unknown[][]}
   */
  function chunkList(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /**
   * Order-preserving de-duplication of clip ids. Non-empty strings only.
   * @param {unknown} ids
   * @returns {string[]}
   */
  function dedupeIds(ids) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(ids) ? ids : [];
    for (const raw of list) {
      if (raw === null || raw === undefined || raw === '') continue;
      const id = String(raw);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /**
   * Replace a `{clips:[…]}` wrapper entry with its children.
   *
   * Three sources agree the shipped feed is a FLAT `{clips:[clip,…]}`, so this
   * is pure tolerance for the older wrapper shape rather than a fix for
   * anything currently broken — but silently dropping a wrapper row (it has no
   * `id`, so an id filter discards it and its children with it) is exactly the
   * kind of quiet data loss this file refuses to do.
   *
   * @param {unknown[]} entries
   * @returns {unknown[]}
   */
  function flattenClipEntries(entries) {
    const out = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && typeof entry === 'object' && Array.isArray(entry.clips)) {
        for (const child of entry.clips) if (child != null) out.push(child);
        continue;
      }
      if (entry != null) out.push(entry);
    }
    return out;
  }

  /**
   * Map a caller's dislike vocabulary onto v3's string tri-state.
   *
   * `'any'|'include'|'all'|'both'` -> `'Any'`, `'only'|'true'` -> `'True'`,
   * `'exclude'|'hidden'|'false'` -> `'False'`. Anything unrecognised falls back
   * to the library default (`'exclude'`), because silently widening a sync to
   * include disliked rows would be a worse default than being explicit.
   *
   * @param {unknown} value
   * @returns {'Any'|'True'|'False'}
   */
  function normalizeDislikedFilter(value) {
    const key = String(value === undefined || value === null ? 'exclude' : value).trim().toLowerCase();
    if (key === 'any' || key === 'include' || key === 'all' || key === 'both') return DISLIKED_FILTER_VALUES.any;
    if (key === 'only' || key === 'true' || key === 'disliked') return DISLIKED_FILTER_VALUES.only;
    return DISLIKED_FILTER_VALUES.exclude;
  }

  /**
   * Whether a pagination token can carry the walk forward. End-of-feed on v3 is
   * `next_cursor === null` — and `''`, `0` and `{}` are treated as the same
   * "no cursor" signal, because every one of them has been observed to mean it.
   * @param {unknown} value
   * @returns {boolean}
   */
  function isUsableCursor(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    if (typeof value === 'boolean') return value;
    return true;
  }

  /**
   * Read the next cursor out of a feed or project-feed envelope, ALIAS-TOLERANT
   * and THREE-STATE.
   *
   * WHY THREE STATES AND NOT TWO. The only end-of-feed signal this walk trusts is
   * a cursor field that is PRESENT and explicitly empty. That is a positive
   * signal, and it is the only one. The previous reader collapsed two different
   * worlds into one `null`:
   *
   *   (b) the response carried no cursor field at all, under any of the eight
   *       spellings in {@link CURSOR_FIELD_ALIASES} — i.e. this parser does not
   *       understand the envelope — and
   *   (c) the response carried a cursor field and it was null/empty, i.e. the end
   *       of the library.
   *
   * (b) is a BUG in the reader, not the end of the feed, and it was reported as
   * the end of the feed. On a real account whose envelope names its cursor
   * anything other than `next_cursor`, page 1 looked like the last page and a
   * ~5,500-clip library reported `completed:true` after 10-20% of it. Callers must
   * therefore branch on `state`, never on `value === null`:
   *
   *   'usable' — a cursor was found, `value` is it, `alias` is the name it was
   *              found under. Keep walking.
   *   'empty'  — a cursor field was present and explicitly null/empty. THE ONLY
   *              state that may end the walk as complete.
   *   'absent' — no cursor field existed under any alias. The response shape is
   *              NOT UNDERSTOOD; report `stopReason:'cursor_missing'`,
   *              `completed:false`.
   *
   * The eight aliases are tried in {@link CURSOR_FIELD_ALIASES} order and the
   * first PRESENT AND USABLE one wins, so a response carrying both
   * `next_cursor:null` (a legacy field) and a live `continuation` still walks
   * instead of claiming victory on page 1. When several are present but none is
   * usable, `alias` names the first present one so the diagnosis is reproducible.
   *
   * VERIFIED: that an explicitly-null `next_cursor` ends the walk (the shipped
   * client's own `getNextPageParam`). ASSUMED, and the reason this function is
   * tolerant: the field NAME and the full set of aliases. Nothing here has been
   * observed against a live response — see {@link SunoAPI#fetchFeedPageRaw}.
   *
   * @param {unknown} data the parsed envelope
   * @returns {{value:unknown, alias:string|null, state:'usable'|'empty'|'absent',
   *   present:Array<string>}} `present` lists every alias the envelope DID carry,
   *   in probe order, which is what makes the shape diagnosable without the body.
   */
  function readNextCursor(data) {
    if (!data || typeof data !== 'object') {
      // A non-object body (a bare array, a text error page) carries no cursor
      // field by definition. That is state (b): not understood, not "finished".
      return { value: null, alias: null, state: 'absent', present: [] };
    }
    const body = /** @type {Record<string, unknown>} */ (data);
    const present = [];
    let firstPresent = null;
    for (const key of CURSOR_FIELD_ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      present.push(key);
      if (firstPresent === null) firstPresent = key;
      const value = body[key];
      if (isUsableCursor(value)) return { value, alias: key, state: 'usable', present };
    }
    if (firstPresent !== null) return { value: null, alias: firstPresent, state: 'empty', present };
    return { value: null, alias: null, state: 'absent', present };
  }

  /**
   * The top-level fields whose PRESENCE on a cursor-less page would say something
   * about how the server ends a feed. Recorded, never read as a verdict.
   *
   * WHY THESE THREE AND NOT MORE: they are the spellings a paginated endpoint
   * conventionally carries to say "there is a next page" / "here is how many rows
   * exist". If the feed OMITS the cursor at end-of-feed and instead relies on
   * `has_more:false`, then a page with no cursor field and `has_more` absent is a
   * different situation from one with `has_more:false` beside it — and nothing in
   * the current build can tell them apart, because the page body is discarded the
   * moment the walk stops. Recording presence turns "somebody must hand-write a
   * probe to find out" into "read the log line".
   */
  const END_OF_FEED_PAGE_SIGNALS = Object.freeze(['has_more', 'num_total_results', 'total']);

  /**
   * Everything worth knowing about a page that carried NO cursor field, as
   * structured data instead of a sentence.
   *
   * WHY A FUNCTION: the cursor-less page now has TWO honest readings (see the
   * branch in `iterateFeed`) and both must carry the same evidence, because the
   * evidence is what settles which one happened. Built once, in one place, so the
   * two error objects cannot drift into reporting different measurements of the
   * same page.
   *
   * NOTHING HERE IS ACTED ON. No field in the result can set `completed`, choose
   * a `stopReason`, or end a walk — the whole point is to make the NEXT occurrence
   * of this bug self-explaining (what did the envelope carry, which base host
   * answered, how full was the page) instead of requiring a hand-written
   * authenticated probe to reconstruct it.
   *
   * SCALARS ONLY: `via` is a base host this build already put on the wire, and
   * the signal values are kept only when they are a primitive. No key VALUE of any
   * other type is copied, so a clips array, a prompt or a signed URL cannot ride
   * out of here into a log line.
   *
   * @param {unknown} data the parsed page envelope
   * @param {{via:unknown, lastPageSize:number, limit:number, pagesFull:number,
   *   pagesDone:number}} ctx
   * @returns {{via:string|null, lastPageSize:number, limit:number,
   *   pagesFull:number, pagesDone:number, topLevelKeys:Array<string>,
   *   signals:Record<string,{present:boolean,type:string|null,value:unknown}>}}
   */
  function describeMissingCursorPage(data, ctx) {
    const isObject = !!data && typeof data === 'object';
    const body = isObject ? /** @type {Record<string, unknown>} */ (data) : {};
    const signals = {};
    for (const key of END_OF_FEED_PAGE_SIGNALS) {
      const present = Object.prototype.hasOwnProperty.call(body, key);
      const value = present ? body[key] : undefined;
      const type = present ? (Array.isArray(value) ? 'array' : typeof value) : null;
      const primitive = present && (typeof value === 'boolean' || typeof value === 'number'
        || typeof value === 'string');
      signals[key] = { present, type, value: primitive ? redact(value) : null };
    }
    return {
      via: typeof ctx.via === 'string' && ctx.via ? ctx.via : null,
      lastPageSize: ctx.lastPageSize,
      limit: ctx.limit,
      pagesFull: ctx.pagesFull,
      pagesDone: ctx.pagesDone,
      /* KEY NAMES ONLY, and this is the field that settles H-B: the envelope's
       * complete top-level key list is what a discovered cursor spelling would
       * have to be added to, and it is the one thing the old debug string was
       * already computing and then throwing away. */
      topLevelKeys: isObject ? Object.keys(body) : [],
      signals,
    };
  }

  /**
   * A comparable identity for a pagination token, so a feed that keeps handing
   * back the cursor it was just given is recognised as stuck instead of walked
   * forever.
   * @param {unknown} value
   * @returns {string}
   */
  function cursorKey(value) {
    if (value === null) return '__null__';
    if (value === undefined) return '__undefined__';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (err) {
        moduleWarn('cursorKey stringify failed: ' + redact(err && err.message));
        return String(value);
      }
    }
    return `${typeof value}:${String(value)}`;
  }

  /**
   * Serialize a query object. Arrays become repeated keys; undefined/null are
   * skipped; booleans become 'true'/'false'.
   * @param {Record<string, unknown>} query
   * @returns {string}
   */
  function queryToString(query) {
    if (!query) return '';
    const parts = [];
    for (const key of Object.keys(query)) {
      const value = query[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry === undefined || entry === null) continue;
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(entry))}`);
        }
        continue;
      }
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.join('&');
  }

  /**
   * Case-insensitive single header read.
   * @param {Record<string,string>|null} headers
   * @param {string} name
   * @returns {string|null}
   */
  function getHeader(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
      try {
        return headers.get(name);
      } catch (err) {
        moduleWarn('header .get() failed: ' + redact(err && err.message));
      }
    }
    const lower = String(name).toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) return headers[key];
    }
    return null;
  }

  /**
   * Normalize Headers / Map / plain object into a plain object.
   * @param {unknown} headers
   * @returns {Record<string,string>}
   */
  function headersToObject(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
          out[String(key).toLowerCase()] = String(value);
        });
        return out;
      }
      if (typeof headers.entries === 'function') {
        for (const entry of headers.entries()) {
          out[String(entry[0]).toLowerCase()] = String(entry[1]);
        }
        return out;
      }
    } catch (err) {
      moduleWarn('failed to enumerate response headers: ' + redact(err && err.message));
    }
    for (const key of Object.keys(headers)) {
      const value = headers[key];
      if (value !== undefined && value !== null) out[key.toLowerCase()] = String(value);
    }
    return out;
  }

  /**
   * Parse a response body. JSON is parsed, everything else is returned as text.
   * @param {string} rawText
   * @param {Record<string,string>} headers
   * @returns {unknown}
   */
  function decodeBody(rawText, headers) {
    if (rawText === '') return null;
    const contentType = String(getHeader(headers, 'content-type') || '').toLowerCase();
    if (contentType.indexOf('json') >= 0 || /^\s*[[{"]/.test(rawText)) {
      try {
        return JSON.parse(rawText);
      } catch (err) {
        moduleWarn('response advertised JSON but did not parse: ' + redact(err && err.message));
        return rawText;
      }
    }
    return rawText;
  }

  /**
   * Best-effort extraction of a server-supplied refusal reason.
   * @param {unknown} data
   * @returns {string|null}
   */
  function pickReason(data) {    if (!data || typeof data !== 'object') return null;
    const body = /** @type {Record<string, unknown>} */ (data);
    const nested = body.error && typeof body.error === 'object' ? /** @type {Record<string, unknown>} */ (body.error) : null;
    return firstString(body.reason, nested && nested.reason, body.code, nested && nested.code);
  }

  /**
   * Best-effort plan/tier name from a billing body. The key has not been
   * confirmed, so every plausible location is probed and `null` is returned
   * rather than a guess.
   * @param {Record<string, any>|null} raw
   * @returns {string|null}
   */
  function pickPlan(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const direct = firstString(raw.plan, raw.subscription_plan, raw.tier, raw.product_name, raw.plan_name);
    if (direct) return direct;
    if (raw.subscription && typeof raw.subscription === 'object') {
      const nested = firstString(raw.subscription.plan, raw.subscription.tier, raw.subscription.name);
      if (nested) return nested;
    }
    return null;
  }

  /**
   * First non-empty string among the candidates.
   * @param {...unknown} candidates
   * @returns {string|null}
   */
  function firstString(...candidates) {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return null;
  }

  /**
   * Invoke a user callback without letting it break enumeration. A throwing
   * progress callback must not abort a mass download.
   * @param {Function} fn
   * @param {unknown} payload first argument
   * @param {object} context `this` binding (the API instance)
   * @param {...unknown} extra additional arguments forwarded after `payload`
   */
  function safeCallback(fn, payload, context, ...extra) {
    if (typeof fn !== 'function') return;
    try {
      fn.call(context, payload, ...extra);
    } catch (err) {
      moduleWarn('callback threw: ' + redact(err && err.message));
    }
  }

  /**
   * Pull a clip array out of an unknown envelope. The feed envelope is the only
   * confirmed one (`{clips:[...]}`); the clips-by-ids envelope is NOT
   * confirmed, so every plausible shape is tolerated.
   * @param {unknown} data
   * @returns {unknown[]}
   */
  function extractClipList(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    const body = /** @type {Record<string, any>} */ (data);
    if (Array.isArray(body.clips)) return body.clips;
    if (Array.isArray(body.songs)) return body.songs;
    if (Array.isArray(body.items)) {
      return body.items.map((item) => (item && item.clip ? item.clip : item)).filter(Boolean);
    }
    if (Array.isArray(body.results)) return body.results;
    if (body.clip && typeof body.clip === 'object') return [body.clip];
    moduleWarn('unrecognised list envelope; keys: ' + redact(Object.keys(body).join(',')));
    return [];
  }

  /**
   * Extract every playable URL a clip advertises, without assuming key names.
   * @param {Record<string, unknown>} clip
   * @returns {string[]}
   */
  function extractMediaUrls(clip) {
    const out = [];
    const push = (value) => {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) out.push(value);
    };
    if (!clip || typeof clip !== 'object') return out;
    for (const key of ['media_urls', 'mediaUrls', 'video_urls']) {
      const list = clip[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry === 'string') push(entry);
        else if (entry && typeof entry === 'object') {
          push(entry.url);
          push(entry.audio_url);
          push(entry.video_url);
        }
      }
    }
    return Array.from(new Set(out));
  }

  /**
   * Normalize a raw clip without discarding unknown fields — a real feed page
   * is ~140 KB and its complete shape is not documented.
   * @param {Record<string, unknown>} clip
   * @returns {Record<string, unknown>}
   */
  function normalizeClip(clip) {
    if (!clip || typeof clip !== 'object') return {};
    const normalized = { ...clip };
    if (clip.id !== undefined && clip.id !== null) normalized.id = String(clip.id);
    normalized.mediaUrls = extractMediaUrls(clip);
    normalized.isLiked = clip.is_liked === true;
    return normalized;
  }

  /**
   * `?format=` is always sent because the recon observed it literally. The
   * legal enum values are NOT documented anywhere, so nothing is defaulted and
   * nothing is invented: the caller's value is passed through and recorded.
   * @param {unknown} format
   * @returns {string}
   */
  function formatQueryValue(format) {
    if (format === undefined || format === null || format === '') return '';
    return String(format);
  }

/**
   * Detect the verbatim bulk-download refusal string anywhere in a response body.
 * @param {unknown} data
 * @returns {string|null} the matched message, or null
 */
  function containsBulkUnavailable(data) {
    if (data === null || data === undefined) return null;
    let text;
    try {
      text = typeof data === 'string' ? data : JSON.stringify(data);
    } catch (err) {
      moduleWarn('containsBulkUnavailable stringify failed: ' + redact(err && err.message));
      return null;
    }
    if (typeof text !== 'string') return null;
    const index = text.indexOf(BULK_UNAVAILABLE_MARKER);
    return index >= 0 ? BULK_UNAVAILABLE_MARKER : null;
  }

  /**
   * @param {unknown} path
   * @returns {string}
   */
  function normalizeRoute(path) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new SunoApiError('request() requires a route path', { code: 'missing_path' });
    }
    if (path.startsWith('http://') || path.startsWith('https://')) {
      throw new SunoApiError('absolute URLs are rejected; pass a verified ENDPOINTS route', {
        code: 'absolute_url_rejected',
        path: redact(path),
      });
    }
    return path.startsWith('/') ? path : `/${path}`;
  }

  /**
   * @param {string} route
   * @returns {string} the route, unchanged
   * @throws {SunoApiError} when the route is one of the known fictions
   */
  function assertRouteAllowed(route) {
    const lower = route.toLowerCase();
    for (const fragment of FORBIDDEN_ROUTE_FRAGMENTS) {
      if (lower.indexOf(fragment.toLowerCase()) >= 0) {
        throw new SunoApiError(`refusing to build a request for a route proven not to exist: ${redact(route)}`, {
          code: 'forbidden_route',
          path: route,
        });
      }
    }
    return route;
  }

  /**
   * @param {object} client the owning SunoAPI instance
   * @returns {typeof fetch|null}
   */
  function resolveGlobalFetch(client) {
    const candidate = typeof globalThis !== 'undefined' ? globalThis.fetch : null;
    if (typeof candidate === 'function') return candidate.bind(globalThis);
    client.logger.warn('no global fetch found; pass options.fetchImpl (e.g. in a unit test)');
    return null;
  }

  /* ====================================================================
   * 3. SunoApiError
   * ================================================================== */

  const QUOTA_REASONS = new Set([
    'quota_exceeded',
    'limit_reached',
    'insufficient_quota',
    'download_limit_reached',
    'out_of_downloads',
  ]);

  /**
   * Typed transport / protocol failure. `request()` never throws on an HTTP
   * error status; it returns an envelope whose `error` field is one of these.
   */
  class SunoApiError extends Error {
    /**
     * @param {string} message
     * @param {object} [opts]
     * @param {number} [opts.status] HTTP status, or 0 when no response arrived
     * @param {string} [opts.code] stable machine code
     * @param {string} [opts.reason] server-supplied refusal reason
     * @param {unknown} [opts.body] parsed or raw response body
     * @param {boolean} [opts.retryable]
     * @param {boolean} [opts.tokenExpired] true only when the token's own exp had passed
     * @param {string} [opts.path]
     * @param {string} [opts.method]
     * @param {boolean} [opts.aborted]
     *
     * `evidence` IS NOT AN OPTION. It is a property a CALLER attaches after
     * construction (`iterateFeed` does this on the two cursor-less page errors),
     * because only the code that read the response can measure it and no
     * constructor can know what to measure. Constructing one never sets it, so
     * its presence always means "somebody looked at this and recorded what they
     * saw". Treat it as read-only.
     */
    constructor(message, opts = {}) {
      super(redact(message));
      this.name = 'SunoApiError';
      this.status = typeof opts.status === 'number' ? opts.status : 0;
      this.code = opts.code || 'unknown_error';
      this.reason = opts.reason || null;
      this.body = opts.body === undefined ? null : opts.body;
      this.retryable = opts.retryable === true;
      this.tokenExpired = opts.tokenExpired === true;
      this.path = opts.path || null;
      this.method = opts.method || null;
      if (opts.aborted === true) this.aborted = true;
    }

    /**
     * @param {SunoApiError|{status?:number,reason?:string,code?:string}|null} e
     * @returns {boolean} 429, or a refusal whose reason is a quota word
     */
    static isQuotaError(e) {
      if (!e) return false;
      if (e.status === 429) return true;
      if (QUOTA_REASONS.has(String(e.reason || '').toLowerCase())) return true;
      return e.code === 'rate_limited' || e.code === 'quota_exceeded';
    }

    /**
     * @param {SunoApiError|{status?:number,code?:string}|null} e
     * @returns {boolean} 401-class only. A 403 is an entitlement wall, not auth.
     */
    static isAuthError(e) {
      if (!e) return false;
      return e.status === 401 || e.code === 'unauthorized' || e.code === 'bad_token';
    }

    /**
     * @param {SunoApiError|{status?:number}|null} e
     * @returns {boolean} 403 — the account lacks the entitlement
     */
    static isEntitlementError(e) {
      return !!e && e.status === 403;
    }

    /**
     * @param {SunoApiError|{status?:number}|null} e
     * @returns {boolean} 404
     */
    static isNotFound(e) {
      return !!e && e.status === 404;
    }

    /**
     * @param {unknown} e
     * @returns {boolean} aborts are control flow, not failures
     */
    static isAbortError(e) {
      return isAbortError(e);
    }
  }

  /* ====================================================================
   * 4. RateLimiter — token bucket + global concurrency cap
   * ================================================================== */

  /**
   * Shared, one per SunoAPI instance. Default 4 requests/second with jitter
   * and a global cap of 3 in-flight requests. `pause()` is how a 429 is
   * propagated to every concurrent worker without extra call-site bookkeeping.
   */
  class RateLimiter {
    /**
     * @param {object} [opts]
     * @param {number} [opts.ratePerSecond=4]
     * @param {number} [opts.concurrency=3]
     * @param {boolean} [opts.jitter=true]
     * @param {() => number} [opts.now]
     * @param {() => number} [opts.random]
     * @param {object} [opts.logger]
     */
    constructor(opts = {}) {
      this.ratePerSecond = Math.max(0.1, opts.ratePerSecond || DEFAULT_RATE_PER_SECOND);
      this.concurrency = Math.max(1, opts.concurrency || DEFAULT_CONCURRENCY);
      this.jitter = opts.jitter !== false;
      this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
      this._random = typeof opts.random === 'function' ? opts.random : Math.random;
      this._logger = normalizeLogger(opts.logger);
      this._tokens = this.ratePerSecond;
      this._lastRefill = this._now();
      this._active = 0;
      this._queue = [];
      this._pausedUntil = 0;
      this._acquired = 0;
      this._waitedMs = 0;
      this._peakActive = 0;
    }

    /**
     * Re-tune at runtime (lowering the rate mid-run is the main use case).
     * @param {number} [ratePerSecond]
     * @param {number} [concurrency]
     * @returns {RateLimiter} this
     */
    setRate(ratePerSecond, concurrency) {
      this._refill();
      if (Number.isFinite(ratePerSecond)) this.ratePerSecond = Math.max(0.1, ratePerSecond);
      if (Number.isFinite(concurrency)) this.concurrency = Math.max(1, concurrency);
      this._tokens = Math.min(this._tokens, this.ratePerSecond);
      this._logger.debug(`rate limiter: ${this.ratePerSecond}/s, concurrency ${this.concurrency}`);
      return this;
    }

    /**
     * Global cooldown — e.g. a 429's Retry-After, shared by all workers.
     * @param {number} ms
     * @returns {RateLimiter} this
     */
    pause(ms) {
      const delta = Math.max(0, Number(ms) || 0);
      this._pausedUntil = Math.max(this._pausedUntil, this._now() + delta);
      if (delta > 0) this._logger.info(`rate limiter paused for ${delta}ms`);
      return this;
    }

    /**
     * Take one permit. Rate is consumed first, then a concurrency slot, so a
     * rate wait never holds a slot hostage.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<() => void>} idempotent release function
     * @throws {Error} AbortError when `signal` aborts while queued
     */
    async acquire(opts = {}) {
      const signal = opts.signal || null;
      if (signal && signal.aborted) throw makeAbortError();
      await this._waitForToken(signal);
      await this._waitForSlot(signal);
      this._acquired += 1;
      this._peakActive = Math.max(this._peakActive, this._active);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this._active = Math.max(0, this._active - 1);
        const next = this._queue.shift();
        if (next) next.grant();
      };
    }

    /** @returns {object} snapshot of limiter state */
    stats() {
      this._refill();
      return {
        ratePerSecond: this.ratePerSecond,
        concurrency: this.concurrency,
        tokens: Math.round(this._tokens * 100) / 100,
        active: this._active,
        queued: this._queue.length,
        peakActive: this._peakActive,
        acquired: this._acquired,
        waitedMs: Math.round(this._waitedMs),
        pausedForMs: Math.max(0, this._pausedUntil - this._now()),
      };
    }

    /** @returns {RateLimiter} this */
    reset() {
      this._refill();
      this._tokens = this.ratePerSecond;
      this._active = 0;
      this._acquired = 0;
      this._waitedMs = 0;
      this._peakActive = 0;
      this._pausedUntil = 0;
      const waiters = this._queue.splice(0, this._queue.length);
      for (const waiter of waiters) waiter.grant();
      return this;
    }

    _refill() {
      const t = this._now();
      const elapsed = Math.max(0, t - this._lastRefill);
      this._lastRefill = t;
      if (elapsed > 0) {
        this._tokens = Math.min(this.ratePerSecond, this._tokens + (elapsed / 1000) * this.ratePerSecond);
      }
    }

    async _waitForToken(signal) {
      for (;;) {
        this._refill();
        const pauseRemaining = this._pausedUntil - this._now();
        const deficit = Math.max(0, 1 - this._tokens);
        const refillWait = deficit <= 0 ? 0 : (deficit / this.ratePerSecond) * 1000;
        const waiting = refillWait > 0 || pauseRemaining > 0;
        const jitterWait = waiting && this.jitter ? this._random() * (1000 / this.ratePerSecond) * 0.5 : 0;
        const wait = Math.max(pauseRemaining, refillWait) + jitterWait;
        if (wait <= 0) {
          this._tokens -= 1;
          return;
        }
        const startedAt = this._now();
        await sleep(Math.ceil(wait), signal);
        this._waitedMs += Math.max(0, this._now() - startedAt);
      }
    }

    _waitForSlot(signal) {
      if (this._active < this.concurrency) {
        this._active += 1;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        /** @type {{grant:Function, onAbort:Function|null}} */
        const entry = {
          grant: () => {
            this._active += 1;
            resolve();
          },
          onAbort: null,
        };
        this._queue.push(entry);
        if (signal) {
          if (signal.aborted) {
            const index = this._queue.indexOf(entry);
            if (index >= 0) this._queue.splice(index, 1);
            reject(makeAbortError());
            return;
          }
          entry.onAbort = () => {
            const index = this._queue.indexOf(entry);
            if (index >= 0) this._queue.splice(index, 1);
            reject(makeAbortError());
          };
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
      });
    }
  }

  /* ====================================================================
   * 5. SunoAPI
   * ================================================================== */

  class SunoAPI {
    /**
     * VERIFIED ROUTE TABLE — the single source of truth for every URL this
     * client builds. Grades used below:
     *   CONFIRMED LIVE      = 200 with a known body
     *   CONFIRMED REFUSAL   = live, answers 200 with {ok,reason,message}
     *   CONFIRMED REGISTERED= 401/405/422 proves the route exists; body unknown
     *   CONFIRMED IN CLIENT = the shipped web client's own OpenAPI caller names
     *                         the route (route + envelope known from source,
     *                         no authenticated capture)
     */
    static ENDPOINTS = Object.freeze({
      /* ---- CONFIRMED LIVE (200 + known body) ------------------------- */
      projectMe: '/api/project/me', // {num_total_results,current_page,projects:[...]}
      projectFeed: '/api/project/feed', // {items:[{type,added_at_ms,clip}],next_cursor}
      playlistMe: '/api/playlist/me', // {num_total_results,current_page,playlists:[...]}
      pinnedClips: '/api/profiles/pinned-clips', // {pinned_clips:[...]}
      personas: '/api/persona/get-personas/', // {personas:[...]}
      lovedPersonas: '/api/persona/get-loved-personas/',
      followedPersonas: '/api/persona/get-followed-personas/',
      billingInfo: '/api/billing/info/', // entitlement ground truth

      /* ---- CONFIRMED IN CLIENT (bundle chunk, no capture) ------------- *
       * `POST /api/feed/v3` is the ONLY route this client enumerates the   *
       * library with. `limit` is a BODY parameter, not a query string. The  *
       * documented cap is 100 (shipped client + two third-party            *
       * extensions) and it is UNVERIFIED against a live response — see     *
       * `LIMITS.feedPageLimit` and `fetchFeedPageRaw`. The walk ends on a   *
       * cursor field that is PRESENT and null, and on nothing else; a page  *
       * with NO cursor field is `stopReason:'cursor_missing'`, never        *
       * "the end of the library".                                           */
      feedV3: '/api/feed/v3', // POST {cursor,limit,filters} -> {clips:[...],next_cursor}
      feedV3Offset: '/api/feed/v3/offset', // POST {offset,filters} — the offset sibling
      clipsByIds: '/api/clips/get_songs_by_ids', // GET ?ids=csv -> {clips:[...]}

      /* ---- CONFIRMED LIVE, known refusal contract --------------------- */
      downloadStudioClip: '/api/studio/clip/{id}/download',
      downloadClip: '/api/download/clip/{id}',

      /* ---- CONFIRMED REGISTERED (422/401/405 prove the route) --------- *
       * Bodies and envelopes below are NOT confirmed. Documented as such  *
       * at every call site.                                            */
      profilesMe: '/api/profiles/me', // BOTH sort params REQUIRED (422)
      clipParent: '/api/clips/parent', // clip_id REQUIRED (422)
      alignedSiblings: '/api/clips/aligned_clip_siblings', // clip_id REQUIRED (422)
      waveformAggregates: '/api/gen/{id}/waveform-aggregates', // 401 unauthenticated
      alignedLyrics: '/api/gen/{id}/aligned_lyrics/v3', // 401 unauthenticated
      downloadAuthorize: '/api/download/authorize', // POST-only (GET -> 405)
      downloadZipPrepare: '/api/download/clips/zip/prepare', // POST-only, flat, max 200 ids
      downloadSamplePack: '/api/download/sample-pack/{clip_id}', // job_id REQUIRED (422)
      convertWav: '/api/gen/{id}/convert_wav/', // 403 means entitlement
      wavFile: '/api/gen/{id}/wav_file/', // signed S3 URL, observed TTL 3599s
      mangoRights: '/api/mango/rights', // nesting UNCONFIRMED; do not trust 422 `loc`
    });

    /** Verified behaviour constants, so no call site hardcodes a magic number. */
    static LIMITS = Object.freeze({
      zipChunkSize: ZIP_CHUNK_SIZE,
      idsChunkSize: IDS_CHUNK_SIZE,
      /**
       * The page size this client ASKS for, not one the server has been observed
       * to grant. See `FEED_LIMIT_MAX`; `fetchFeedPageRaw` is how the assumption
       * gets checked against a real response.
       */
      feedPageLimit: FEED_LIMIT_MAX,
      feedLimitMin: 1,
      /**
       * Every spelling the cursor reader accepts, in probe order. Published so a
       * caller that reports on the envelope shape (the worker's `PROBE_FEED`
       * route) asks the SAME question this client asks, instead of keeping its own
       * copy of the list and drifting from it.
       */
      feedCursorFields: CURSOR_FIELD_ALIASES,
      feedPageRetries: FEED_PAGE_RETRIES,
      projectFeedLimit: PROJECT_FEED_LIMIT,
      defaultMaxPages: DEFAULT_MAX_PAGES,
      ratePerSecond: DEFAULT_RATE_PER_SECOND,
      concurrency: DEFAULT_CONCURRENCY,
      bulkUnavailableMarker: BULK_UNAVAILABLE_MARKER,
    });

    /**
     * Quota semantics as Suno documents them and as confirmed on the billing
     * route. `limit: null` means "no number reported" — use `unlimited`, never
     * a substituted number. The free-tier figure is UNVERIFIED (the recon
     * account was never on free); pro=20 and premier=60 are the reliable ones.
     */
    static QUOTA_SEMANTICS = Object.freeze({
      free: Object.freeze({ limit: null, period: 'lifetime', verified: false }),
      pro: Object.freeze({ limit: 20, period: 'month', verified: true }),
      premier: Object.freeze({ limit: 60, period: 'month', verified: true }),
      premierPlusStudio: Object.freeze({ limit: null, period: 'none', verified: true }),
      rules:
        'One song = one download, regardless of format. Re-downloading in a different format does NOT re-count. Resets on the billing date, no carryover.',
    });

    /** Observed TTL of the signed S3 URL returned by the wav route. */
    static SIGNED_URL_TTL_SECONDS = 3599;

    /**
     * Observed size of ONE feed page body, for progress estimation only. It
     * was measured on the removed `/api/feed/v2` route (20 clips) and is a
     * per-request constant, so a v3 page of 100 clips is roughly five times
     * this. Progress maths must never depend on it.
     */
    static FEED_PAGE_BYTES_HINT = 140_000;

    /**
     * @param {object} [opts]
     * @param {typeof fetch} [opts.fetchImpl] injectable for tests
     * @param {(ctx:{force:boolean}) => (string|Promise<string>)} [opts.tokenProvider]
     *   must resolve a Clerk JWT (never read from `document.cookie`)
     * @param {() => number} [opts.now] injectable clock
     * @param {object} [opts.logger] `{debug,info,warn,error}`; silent when omitted
     * @param {RateLimiter} [opts.rateLimiter] share one across instances if desired
     * @param {number} [opts.timeoutMs]
     * @param {number} [opts.retries]
     */
    constructor(opts = {}) {
      this.logger = normalizeLogger(opts.logger);
      moduleWarn = (message) => this.logger.warn(`[suno-api] ${message}`);
      this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
      this._random = typeof opts.random === 'function' ? opts.random : Math.random;
      this.fetchImpl = opts.fetchImpl || resolveGlobalFetch(this);
      this.tokenProvider = typeof opts.tokenProvider === 'function' ? opts.tokenProvider : null;

      this.baseUrls = Object.freeze(
        (Array.isArray(opts.baseUrls) && opts.baseUrls.length ? opts.baseUrls : VERIFIED_BASE_URLS).slice()
      );
      this._assertBaseUrls(this.baseUrls);

      /** Cached Clerk JWT. In memory only, never persisted, never logged. */
      this.cachedToken = null;
      /** Epoch ms, derived from the JWT's own `exp` claim. */
      this.tokenExpiry = 0;

      this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
      this.retries = Number.isFinite(opts.retries) ? opts.retries : DEFAULT_RETRIES;

      this.rateLimiter =
        opts.rateLimiter ||
        new RateLimiter({
          ratePerSecond: DEFAULT_RATE_PER_SECOND,
          concurrency: DEFAULT_CONCURRENCY,
          jitter: true,
          now: this._now,
          random: this._random,
          logger: this.logger,
        });

      this._baseHealth = this.baseUrls.map(() => ({ fails: 0, unhealthyUntil: 0 }));
      this._quotaCache = null;
      this._quotaCachedAt = 0;
      this._formatTally = new Map();

      this.metrics = this._freshMetrics();
      this._assertEndpoints();
    }

    /* ---------------------------------------------------------------
     * Construction-time validation
     * ------------------------------------------------------------- */

    /**
     * Fail fast if the route table ever regrows a proven fiction.
     * @throws {SunoApiError} on an illegal entry or host
     */
    _assertEndpoints() {
      const entries = Object.entries(SunoAPI.ENDPOINTS);
      for (const [name, value] of entries) {
        if (typeof value !== 'string' || value.charAt(0) !== '/') {
          throw new SunoApiError(`ENDPOINTS.${name} must be an absolute API path`, {
            code: 'invalid_endpoint_table',
            path: String(value),
          });
        }
        assertRouteAllowed(value);
      }
      this.logger.debug(`endpoint table validated: ${entries.length} verified routes`);
    }

    /**
     * Staging is not deployed and must never be contacted; it is an
     * unauthenticated misconfiguration to report, not a fallback.
     * @param {string[]} baseUrls
     * @throws {SunoApiError} on a non-HTTPS or non-deployed host
     */
    _assertBaseUrls(baseUrls) {
      for (const raw of baseUrls) {
        const host = String(raw);
        if (!/^https:\/\//i.test(host) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(host)) {
          throw new SunoApiError('baseUrls must be https (localhost http allowed for tests)', {
            code: 'insecure_base_url',
            path: redact(host),
          });
        }
        const lower = host.toLowerCase();
        for (const fragment of FORBIDDEN_HOST_FRAGMENTS) {
          if (lower.indexOf(fragment) >= 0) {
            throw new SunoApiError(
              `refusing to use a host containing "${fragment}": it is not deployed and must never be contacted`,
              { code: 'forbidden_base_url', path: redact(host) }
            );
          }
        }
      }
    }

    /**
     * Resolve a caller-supplied route to a concrete verified path. The
     * argument is either an ENDPOINTS key (with `pathParams` for `{...}`
     * templates) or a literal path — and a literal path MUST be one of the
     * verified values, so no URL can ever be built from outside the table.
     *
     * @param {string} path
     * @param {Record<string, unknown>} [pathParams]
     * @returns {string}
     * @throws {SunoApiError} on an unverified route or a missing path param
     */
    _resolveRoute(path, pathParams) {
      const table = SunoAPI.ENDPOINTS;
      let template;
      if (Object.prototype.hasOwnProperty.call(table, path)) {
        template = table[path];
      } else {
        template = normalizeRoute(path);
        // Check the known fictions FIRST so they get the specific code.
        assertRouteAllowed(template);
        if (!VERIFIED_ROUTE_SET[template]) {
          throw new SunoApiError(
            `route is not in SunoAPI.ENDPOINTS and will not be requested: ${redact(template)}`,
            { code: 'unverified_route', path: template }
          );
        }
      }
      const route = normalizeRoute(template);
      return route.replace(/\{(\w+)\}/g, (_match, key) => {
        const value = pathParams ? pathParams[key] : undefined;
        if (value === undefined || value === null || value === '') {
          throw new SunoApiError(`missing path param "${key}" for route "${path}"`, {
            code: 'missing_path_param',
            path: route,
          });
        }
        return encodeURIComponent(String(value));
      });
    }

    /* ---------------------------------------------------------------
     * Configuration
     * ------------------------------------------------------------- */

    /**
     * Reconfigure auth/transport at runtime.
     * @param {object} [opts]
     * @param {(ctx:{force:boolean}) => (string|Promise<string>)} [opts.tokenProvider]
     * @param {string[]} [opts.baseUrls] verified hosts only
     * @param {{ratePerSecond?:number, concurrency?:number, jitter?:boolean}} [opts.rateLimit]
     * @param {object} [opts.logger]
     * @param {typeof fetch} [opts.fetchImpl]
     * @param {() => number} [opts.now]
     * @param {number} [opts.timeoutMs]
     * @param {number} [opts.retries]
     * @returns {SunoAPI} this
     */
    configure(opts = {}) {
      if (typeof opts.tokenProvider === 'function') this.tokenProvider = opts.tokenProvider;
      if (Array.isArray(opts.baseUrls) && opts.baseUrls.length) {
        this._assertBaseUrls(opts.baseUrls);
        this.baseUrls = Object.freeze(opts.baseUrls.slice());
        this._baseHealth = this.baseUrls.map(() => ({ fails: 0, unhealthyUntil: 0 }));
      }
      if (opts.rateLimit && typeof opts.rateLimit === 'object') {
        this.rateLimiter.setRate(opts.rateLimit.ratePerSecond, opts.rateLimit.concurrency);
        if (opts.rateLimit.jitter === false) this.rateLimiter.jitter = false;
      }
      if (opts.logger) this.logger = normalizeLogger(opts.logger);
      if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
      if (typeof opts.now === 'function') this._now = opts.now;
      if (Number.isFinite(opts.timeoutMs)) this.timeoutMs = opts.timeoutMs;
      if (Number.isFinite(opts.retries)) this.retries = opts.retries;
      this.logger.debug('configured', { baseUrls: this.baseUrls, hasTokenProvider: !!this.tokenProvider });
      return this;
    }

    /* ---------------------------------------------------------------
     * Auth
     * ------------------------------------------------------------- */

    /**
     * Resolve a Clerk JWT, cached until shortly before its own `exp`.
     *
     * The token CANNOT be read from `document.cookie`: `__session` is HttpOnly
     * and is a Next.js SSR value, not a bearer token. It must be relayed from
     * the page's Clerk instance (`window.Clerk.session.getToken()`) or supplied
     * by the caller. A non-JWT token is tolerated with a short TTL.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.force] ignore the cache and re-resolve
     * @returns {Promise<string|null>} token, or null when none is obtainable
     */
    async getToken(opts = {}) {
      const force = opts.force === true;
      const now = this._now();
      if (!force && this.cachedToken && this.tokenExpiry > now + TOKEN_EXPIRY_SKEW_MS) {
        return this.cachedToken;
      }
      const liveCached = () => (this.cachedToken && this.tokenExpiry > now ? this.cachedToken : null);
      if (!this.tokenProvider) {
        if (!force) {
          const cached = liveCached();
          if (cached) return cached;
        }
        this.logger.warn('getToken: no tokenProvider configured and no live cached token');
        return null;
      }
      let token = null;
      try {
        token = await this.tokenProvider({ force });
      } catch (err) {
        // A failed refresh must not invalidate a token we still hold.
        this.logger.warn('tokenProvider threw: ' + redact(err && err.message));
        return liveCached();
      }
      if (typeof token !== 'string' || token.length === 0) {
        this.logger.warn('tokenProvider returned no usable token');
        return liveCached();
      }
      const exp = decodeJwtExpiry(token);
      if (exp === null) {
        this.logger.debug('token is not a JWT; using a short cache TTL');
        this.tokenExpiry = now + OPAQUE_TOKEN_TTL_MS;
      } else {
        this.tokenExpiry = exp;
        if (exp <= now) this.metrics.tokensExpired += 1;
      }
      this.cachedToken = token;
      return token;
    }

    /** @returns {SunoAPI} this */
    clearToken() {
      this.cachedToken = null;
      this.tokenExpiry = 0;
      return this;
    }

    /**
     * Whether the cached token is past its own `exp`.
     * @returns {boolean}
     */
    isTokenExpired() {
      return !this.cachedToken || this.tokenExpiry <= this._now();
    }

    /**
     * Whether a token we ACTUALLY HOLD has passed its own `exp`.
     *
     * `isTokenExpired()` deliberately folds "nothing was ever obtained" into
     * `true`: on the 401 path that is correct, since a 401 with no token in hand
     * can only mean the session is gone. As a *report* on a `missing_token` it is
     * the opposite of the truth — nothing expired, because there was never
     * anything to expire, and `tokenExpired: true` would tell the user their
     * session timed out. There it reads false, and `code: 'missing_token'`
     * carries "we never got one" instead.
     *
     * @returns {boolean}
     */
    _heldTokenIsExpired() {
      return !!this.cachedToken && this.tokenExpiry <= this._now();
    }

    /* ---------------------------------------------------------------
     * Core transport
     * ------------------------------------------------------------- */

    /**
     * Perform one API call with failover, rate limiting, retries and typed
     * failures. NEVER throws on an HTTP error status — failures arrive in the
     * envelope's `error` field.
     *
     * Handles:
     *   - base-URL failover (primary -> fallback) on network error and 5xx
     *   - 401 -> ONE forced token refresh + ONE retry. A 401 while the JWT is
     *     still valid by its own clock is a BAD TOKEN (`code='bad_token'`).
     *   - an empty first token probe -> ONE forced re-acquisition before giving
     *     up, because the page's Clerk can still be hydrating. Still nothing and
     *     the request fails `code='missing_token'` without ever being sent.
     *   - 429 -> honours `Retry-After` (delta-seconds or HTTP-date) and pauses
     *     the shared RateLimiter so every worker slows down together
     *   - 5xx / network -> full-jitter exponential backoff
     *   - hard per-request timeout via AbortController, linked to `signal`
     *
     * No `User-Agent` is set (the browser owns it; it must not be spoofed) and
     * no Origin/Referer (both are forbidden headers an extension cannot set).
     *
     * @param {string} path an ENDPOINTS key or a literal verified path
     * @param {object} [options]
     * @param {string} [options.method='GET']
     * @param {unknown} [options.body] JSON-encoded unless already a string
     * @param {Record<string, unknown>} [options.query]
     * @param {Record<string, string>} [options.headers]
     * @param {AbortSignal} [options.signal]
     * @param {boolean} [options.auth=true]
     * @param {number} [options.retries]
     * @param {number} [options.timeout]
     * @param {Record<string, unknown>} [options.pathParams] for `{id}` templates
     * @param {boolean} [options.allowFailover=true]
     * @returns {Promise<{ok:boolean,status:number,data:unknown,
     *   headers:Record<string,string>,error:SunoApiError|null,url:string|null,
     *   responseUrl:string|null,method:string,path:string,attempts:number,
     *   retried:boolean,elapsedMs:number,via:string|null}>}
     */
    async request(path, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      const auth = options.auth !== false;
      const retries = Number.isFinite(options.retries) ? options.retries : this.retries;
      const timeout = Number.isFinite(options.timeout) ? options.timeout : this.timeoutMs;
      const signal = options.signal || null;
      const allowFailover = options.allowFailover !== false;
      const startedAt = this._now();

      let route;
      try {
        route = assertRouteAllowed(this._resolveRoute(path, options.pathParams));
      } catch (err) {
        const error =
          err instanceof SunoApiError
            ? err
            : new SunoApiError('invalid route: ' + redact(err && err.message), {
                code: 'invalid_route',
                path: typeof path === 'string' ? path : null,
                method,
              });
        return this._envelope({
          method,
          path: typeof path === 'string' ? path : null,
          status: 0,
          data: null,
          headers: {},
          url: null,
          responseUrl: null,
          elapsedMs: this._now() - startedAt,
          attempts: 0,
          retried: false,
          via: null,
          error,
        });
      }

      const buildFailure = (error, extra) =>
        this._envelope({
          method,
          path: route,
          status: error.status || 0,
          data: null,
          headers: {},
          url: (extra && extra.url) || null,
          responseUrl: null,
          elapsedMs: this._now() - startedAt,
          attempts: (extra && extra.attempts) || 0,
          retried: !!(extra && extra.retried),
          via: (extra && extra.via) || null,
          error,
        });

      if (signal && signal.aborted) {
        return buildFailure(
          new SunoApiError('request aborted before dispatch', {
            code: 'aborted',
            path: route,
            method,
            aborted: true,
          }),
          { attempts: 1 }
        );
      }
      if (typeof this.fetchImpl !== 'function') {
        return buildFailure(
          new SunoApiError('no fetch implementation available', {
            code: 'no_fetch',
            path: route,
            method,
          })
        );
      }

      let token = null;
      if (auth) {
        token = await this.getToken();
        if (!token) {
          /* Clerk hydrates AFTER document-start, so an empty first probe is a
           * race, not a verdict. Spend ONE forced re-acquisition on it; if that
           * still yields nothing the caller gets the same terminal
           * `missing_token` as before. A request with no bearer token must never
           * reach the network, so neither branch adds an HTTP attempt. */
          const retry = await this._retryMissingToken(signal, timeout);
          if (retry.aborted) {
            return buildFailure(
              new SunoApiError('request aborted before dispatch', {
                code: 'aborted',
                path: route,
                method,
                aborted: true,
              }),
              { attempts: 1 }
            );
          }
          if (retry.token) {
            token = retry.token;
            this.metrics.tokenRefreshes += 1;
            this.logger.info('no token on the first probe; the forced re-acquisition produced one');
          } else {
            this.logger.warn('missing_token: no token before or after one forced re-acquisition');
            return buildFailure(
              new SunoApiError(MISSING_TOKEN_MESSAGE, {
                code: 'missing_token',
                path: route,
                method,
                tokenExpired: this._heldTokenIsExpired(),
              })
            );
          }
        }
      }

      const hasBody = options.body !== undefined && options.body !== null;
      const bodyText = hasBody ? (typeof options.body === 'string' ? options.body : safeStringify(options.body)) : undefined;
      const qs = queryToString(options.query);
      const attemptsAllowed = Math.max(0, retries) + 1;

      let attempt = 0;
      let refreshed = false;
      let baseIdx = this._pickBase();
      let lastEnvelope = null;

      while (attempt < attemptsAllowed) {
        attempt += 1;
        const base = this.baseUrls[baseIdx];
        const url = `${String(base).replace(/\/+$/, '')}${route}${qs ? '?' + qs : ''}`;

        const headers = { accept: 'application/json', ...(options.headers || {}) };
        const hasContentType =
          headers['content-type'] !== undefined || headers['Content-Type'] !== undefined;
        if (hasBody && !hasContentType) headers['content-type'] = 'application/json';
        if (token) headers.authorization = `Bearer ${token}`;

        const init = {
          method,
          headers,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow',
        };
        if (bodyText !== undefined) init.body = bodyText;

        const controller = new AbortController();
        let timedOut = false;
        let release = null;
        let timer = null;
        const onCallerAbort = () => controller.abort();
        if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, Math.max(1, timeout));
        init.signal = controller.signal;

        let response = null;
        let dispatchError = null;
        try {
          release = await this.rateLimiter.acquire({ signal });
          this.metrics.requests += 1;
          response = await this.fetchImpl(url, init);
        } catch (err) {
          dispatchError = err;
        } finally {
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onCallerAbort);
          if (typeof release === 'function') release();
        }

        /* ---- transport failure (network / abort / timeout) ------------- */
        if (dispatchError) {
          const callerAborted = !!(signal && signal.aborted);
          const aborted = callerAborted || timedOut || isAbortError(dispatchError);
          const error = new SunoApiError(
            timedOut
              ? `request timed out after ${timeout}ms`
              : `network failure for ${method} ${redact(route)}: ${redact(dispatchError && dispatchError.message)}`,
            {
              code: timedOut ? 'timeout' : aborted ? 'aborted' : 'network_error',
              path: route,
              method,
              retryable: !aborted && !timedOut,
              aborted,
            }
          );
          this._noteBaseFailure(baseIdx);
          lastEnvelope = buildFailure(error, { attempts: attempt, retried: attempt > 1, via: base, url });
          if (error.retryable && attempt < attemptsAllowed) {
            this.metrics.retries += 1;
            if (allowFailover && this.baseUrls.length > 1) baseIdx = this._nextBase(baseIdx);
            await this._backoff(attempt, signal);
            continue;
          }
          return lastEnvelope;
        }

        /* ---- response received ---------------------------------------- */
        const status = response.status;
        const responseHeaders = headersToObject(response.headers);
        let rawText = '';
        try {
          rawText = typeof response.text === 'function' ? await response.text() : '';
        } catch (err) {
          this.logger.warn(`failed to read body of ${method} ${redact(route)}: ${redact(err && err.message)}`);
        }
        const data = decodeBody(rawText, responseHeaders);
        const bytes = Number(getHeader(responseHeaders, 'content-length')) || rawText.length || 0;
        const elapsedMs = this._now() - startedAt;
        this._recordRoute(route, status, elapsedMs, bytes);
        if (status < 400) this.metrics.ok += 1;
        else this.metrics.failed += 1;

        const envelope = this._envelope({
          method,
          path: route,
          status,
          data,
          headers: responseHeaders,
          url,
          responseUrl: typeof response.url === 'string' ? response.url : null,
          elapsedMs,
          attempts: attempt,
          retried: attempt > 1,
          via: base,
          error: null,
        });

        /* 401: one forced refresh, then one retry.
         *
         * This branch is method-agnostic on purpose: the library walk is a
         * `POST /api/feed/v3`, and a 401 there is a token the same way a 401 on
         * a GET is. `refreshed` is per-`request()`, and a walk issues one
         * request per page, so every page gets its own refresh budget rather
         * than the whole 55-page crawl sharing one. 403 is deliberately NOT
         * refreshed: on these routes 403 is an ENTITLEMENT wall (see the class
         * header), and burning a token acquisition on it would hide the real
         * answer from the user. */
        if (status === 401 && auth && !refreshed && token) {
          const stillValid = !this.isTokenExpired();
          refreshed = true;
          this.metrics.tokenRefreshes += 1;
          const fresh = await this.getToken({ force: true });
          if (fresh && fresh !== token) {
            token = fresh;
            this.logger.info('401 -> forced token refresh, retrying once');
            attempt -= 1; // the refresh retry does not consume the backoff budget
            continue;
          }
          envelope.error = new SunoApiError(
            stillValid
              ? '401 with a still-valid JWT: the token is bad, not the session'
              : '401 unauthorized: the session token has expired',
            {
              status: 401,
              code: stillValid ? 'bad_token' : 'unauthorized',
              reason: pickReason(data),
              body: data,
              tokenExpired: !stillValid,
              path: route,
              method,
              retryable: false,
            }
          );
          return envelope;
        }

        /* 429: honour Retry-After and pause the shared limiter. */
        if (status === 429) {
          const retryAfterMs = parseRetryAfterMs(responseHeaders, this._now());
          this.metrics.rateLimited += 1;
          if (retryAfterMs !== null) this.rateLimiter.pause(retryAfterMs);
          const error = new SunoApiError('rate limited (429)', {
            status: 429,
            code: 'rate_limited',
            reason: pickReason(data),
            body: data,
            path: route,
            method,
            retryable: true,
          });
          lastEnvelope = this._envelope({ ...envelope, error, retried: attempt > 1 });
          if (attempt < attemptsAllowed) {
            this.metrics.retries += 1;
            await this._backoff(attempt, signal, retryAfterMs === null ? null : retryAfterMs);
            continue;
          }
          return lastEnvelope;
        }

        /* 5xx: fail over to the next verified base URL. */
        if (status >= 500) {
          this._noteBaseFailure(baseIdx);
          const error = new SunoApiError(`upstream error ${status}`, {
            status,
            code: 'server_error',
            reason: pickReason(data),
            body: data,
            path: route,
            method,
            retryable: true,
          });
          lastEnvelope = this._envelope({ ...envelope, error, retried: attempt > 1 });
          if (attempt < attemptsAllowed) {
            this.metrics.retries += 1;
            if (allowFailover && this.baseUrls.length > 1) baseIdx = this._nextBase(baseIdx);
            await this._backoff(attempt, signal);
            continue;
          }
          return lastEnvelope;
        }

        if (status === 405) {
          // Empirically 405 here means "wrong HTTP method" on a POST-only route.
          envelope.error = new SunoApiError('method not allowed (405): this route is POST-only', {
            status: 405,
            code: 'method_not_allowed',
            reason: pickReason(data),
            body: data,
            path: route,
            method,
            retryable: false,
          });
          return envelope;
        }
        if (status === 403) {
          // 403 on the wav/download routes is an ENTITLEMENT wall, not bad auth.
          envelope.error = new SunoApiError('forbidden (403): the account lacks this entitlement', {
            status: 403,
            code: 'forbidden',
            reason: pickReason(data),
            body: data,
            path: route,
            method,
            retryable: false,
          });
          return envelope;
        }
        if (status === 404) {
          envelope.error = new SunoApiError('not found (404)', {
            status: 404,
            code: 'not_found',
            reason: pickReason(data),
            body: data,
            path: route,
            method,
            retryable: false,
          });
          return envelope;
        }
        if (status >= 400) {
          envelope.error = new SunoApiError(`request rejected (${status})`, {
            status,
            code: 'bad_request',
            reason: pickReason(data),
            body: data,
            path: route,
            method,
            retryable: false,
          });
          return envelope;
        }

        this._noteBaseSuccess(baseIdx);
        return envelope;
      }

      if (lastEnvelope) {
        lastEnvelope.attempts = attempt;
        lastEnvelope.retried = attempt > 1;
        lastEnvelope.elapsedMs = this._now() - startedAt;
        return lastEnvelope;
      }
      return buildFailure(
        new SunoApiError('request exhausted all attempts without a response', {
          code: 'exhausted',
          path: route,
          method,
          retryable: true,
        }),
        { attempts: attempt, retried: attempt > 1 }
      );
    }

    /* ---------------------------------------------------------------
     * Transport internals
     * ------------------------------------------------------------- */

    /**
     * @param {number} attempt 1-based
     * @param {AbortSignal|null} signal
     * @param {number|null} [fixedMs] explicit wait (Retry-After) instead of backoff
     * @returns {Promise<void>} resolves after the wait, or immediately on abort
     */
    async _backoff(attempt, signal, fixedMs) {
      const wait = fixedMs === null || fixedMs === undefined ? jitteredBackoffMs(attempt, this._random) : fixedMs;
      try {
        await sleep(wait, signal);
      } catch (err) {
        if (!isAbortError(err)) this.logger.warn('backoff sleep failed: ' + redact(err && err.message));
      }
    }

    /**
     * The ONE extra token acquisition a request may spend on a missing token.
     *
     * `getToken({force:true})` is the existing forced entry point: it ignores the
     * cache and re-enters the injected `tokenProvider({force:true})`, which is the
     * only contract a provider is documented to understand. No new option name is
     * introduced here — an option the provider does not read would be dropped in
     * silence and the retry would be a no-op.
     *
     * The wait in front of it exists because an immediate re-probe is worthless:
     * the provider can be asked too early, before Clerk exists. It is capped at
     * half the caller's own `timeout` and aborts on the caller's `signal`, so
     * this can never outlive the request it belongs to.
     *
     * @param {AbortSignal|null} signal
     * @param {number} timeout the request's own timeout, milliseconds
     * @returns {Promise<{aborted:boolean,token:string|null}>} at most one extra
     *   acquisition; `aborted` means the caller went away mid-wait
     */
    async _retryMissingToken(signal, timeout) {
      const budget = Number.isFinite(timeout) ? Math.max(0, timeout) : 0;
      const waitMs = Math.min(MISSING_TOKEN_RETRY_WAIT_MS, budget * MISSING_TOKEN_WAIT_RATIO);
      if (waitMs > 0) {
        try {
          await sleep(waitMs, signal);
        } catch (err) {
          if (isAbortError(err)) return { aborted: true, token: null };
          this.logger.warn('missing-token wait failed: ' + redact(err && err.message));
        }
      }
      if (signal && signal.aborted) return { aborted: true, token: null };
      return { aborted: false, token: await this.getToken({ force: true }) };
    }

    /** @returns {object} a zeroed metrics block */
    _freshMetrics() {
      return {
        requests: 0,
        ok: 0,
        failed: 0,
        rateLimited: 0,
        retries: 0,
        tokenRefreshes: 0,
        tokensExpired: 0,
        bytes: 0,
        startedAt: this._now ? this._now() : Date.now(),
        lastLatencyMs: 0,
        byRoute: {},
        formats: {},
      };
    }

    /** @returns {SunoAPI} this */
    resetMetrics() {
      this.metrics = this._freshMetrics();
      return this;
    }

    /**
     * @param {number} status
     * @param {number} latencyMs
     * @param {number} bytes
     */
    _recordRoute(route, status, latencyMs, bytes) {
      const metrics = this.metrics;
      metrics.bytes += bytes || 0;
      metrics.lastLatencyMs = latencyMs;
      const entry = metrics.byRoute[route];
      if (!entry) {
        metrics.byRoute[route] = {
          requests: 1,
          errors: status >= 400 ? 1 : 0,
          bytes: bytes || 0,
          totalLatencyMs: latencyMs,
          lastLatencyMs: latencyMs,
          maxLatencyMs: latencyMs,
        };
        return;
      }
      entry.requests += 1;
      if (status >= 400) entry.errors += 1;
      entry.bytes += bytes || 0;
      entry.totalLatencyMs += latencyMs;
      entry.lastLatencyMs = latencyMs;
      if (latencyMs > entry.maxLatencyMs) entry.maxLatencyMs = latencyMs;
    }

    /**
     * @param {object} baseUrl
     * @returns {object} a normalized envelope
     */
    _envelope(base) {
      return {
        ok: base.status >= 200 && base.status < 400,
        status: base.status,
        data: base.data === undefined ? null : base.data,
        headers: base.headers || {},
        error: base.error || null,
        url: base.url || null,
        responseUrl: base.responseUrl || null,
        method: base.method || 'GET',
        path: base.path || null,
        attempts: base.attempts || 0,
        retried: base.retried === true,
        elapsedMs: base.elapsedMs || 0,
        via: base.via || null,
      };
    }

    /** @returns {number} index of the healthiest configured base URL */
    _pickBase() {
      let best = 0;
      let bestFails = Infinity;
      const now = this._now();
      for (let i = 0; i < this._baseHealth.length; i += 1) {
        const health = this._baseHealth[i];
        if (health.unhealthyUntil > now) continue;
        if (health.fails < bestFails) {
          bestFails = health.fails;
          best = i;
        }
      }
      return best;
    }

    /**
     * @param {number} index
     * @returns {number} the next base URL index (round-robin)
     */
    _nextBase(index) {
      if (this._baseHealth.length <= 1) return 0;
      return (index + 1) % this._baseHealth.length;
    }

    /** @param {number} index */
    _noteBaseFailure(index) {
      const health = this._baseHealth[index];
      if (!health) return;
      health.fails += 1;
      health.unhealthyUntil = this._now() + Math.min(30_000, 1_000 * health.fails);
    }

    /** @param {number} index */
    _noteBaseSuccess(index) {
      const health = this._baseHealth[index];
      if (!health) return;
      health.fails = 0;
      health.unhealthyUntil = 0;
    }

    /* ---------------------------------------------------------------
     * Download response parsing
     * ------------------------------------------------------------- */

    /**
     * Interpret a download response body.
     *
     * CRITICAL: these routes answer HTTP 200 with a REFUSAL body, e.g.
     * `{"ok":false,"reason":"no_permission","message":"You don't have
     * permission to download in Studio."}`. Branching on `resp.ok` silently
     * reports a refusal as a success. Branch on THIS instead.
     *
     * @param {unknown} data parsed JSON body, raw text, or binary
     * @param {object} [ctx]
     * @param {string} [ctx.responseUrl] final URL after redirects (signed S3)
     * @param {number} [ctx.status]
     * @param {Record<string,string>} [ctx.headers]
     * @param {string|null} [ctx.format] recorded, never invented
     * @returns {{ok:true,url:string|null,jobId:string|null,format:string|null,
     *   quotaCounted?:'yes'|'no'|'unknown',binary?:boolean,redirected?:boolean,
     *   needsPoll?:boolean,raw:unknown}
     *   | {ok:false,reason:string,message:string,status:number|null,
     *   format:string|null,raw:unknown}}
     */
    static parseDownloadResponse(data, ctx = {}) {
      const status = Number.isFinite(ctx.status) ? ctx.status : null;
      const format = ctx.format === undefined ? null : ctx.format;
      const responseUrl = typeof ctx.responseUrl === 'string' && ctx.responseUrl ? ctx.responseUrl : null;
      const contentType = String(getHeader(ctx.headers, 'content-type') || '').toLowerCase();

      const refuse = (reason, message) => ({
        ok: false,
        reason: reason || 'refused',
        message: message || 'server refused the download without a reason',
        status,
        format,
        raw: data,
      });

      if (data === null || data === undefined || data === '') {
        // A redirect straight to a signed CDN asset never yields a JSON body.
        if (responseUrl && /^https?:\/\//i.test(responseUrl)) {
          return { ok: true, url: responseUrl, jobId: null, format, redirected: true, raw: data };
        }
        return refuse('empty_response', 'download response had no body and no redirect target');
      }

      if (typeof data === 'string') {
        const trimmed = data.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          return { ok: true, url: trimmed, jobId: null, format, raw: data };
        }
        if (contentType.indexOf('audio/') === 0 || contentType.indexOf('application/octet-stream') === 0) {
          return { ok: true, url: responseUrl, jobId: null, format, binary: true, raw: data };
        }
        if (/<Error>|<Code>AccessDenied|<Code>NoSuchKey/i.test(trimmed)) {
          return refuse('cdn_error', trimmed.slice(0, 300));
        }
        return refuse('unrecognized_text_response', trimmed.slice(0, 300));
      }

      if ((typeof Blob !== 'undefined' && data instanceof Blob) ||
          (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer)) {
        return { ok: true, url: responseUrl, jobId: null, format, binary: true, raw: null };
      }

      if (typeof data !== 'object') {
        return refuse('unrecognized_response', `unhandled body type ${typeof data}`);
      }

      const body = /** @type {Record<string, any>} */ (data);
      const nested = body.error && typeof body.error === 'object' ? body.error : null;

      /* The refusal contract — checked BEFORE any artifact probing. */
      if (body.ok === false) {
        const reason = firstString(body.reason, nested && nested.reason, body.code, nested && nested.code);
        const message = firstString(
          body.message,
          nested && nested.message,
          body.detail,
          body.error_description,
          'server refused the download'
        );
        return refuse(reason || 'refused', message);
      }

      const firstUrl = (list) => {
        if (!Array.isArray(list) || list.length === 0) return undefined;
        const first = list[0];
        return typeof first === 'string' ? first : first && first.url ? first.url : undefined;
      };

      const url = firstString(
        body.url,
        body.download_url,
        body.signed_url,
        body.s3_url,
        body.audio_url,
        body.file_url,
        body.location,
        body.href,
        body.uri,
        body.redirect_url,
        body.zip_url,
        body.download_link,
        body.file && body.file.url,
        body.data && (body.data.url || body.data.download_url),
        body.asset && (body.asset.url || body.asset.signed_url),
        firstUrl(body.urls),
        firstUrl(body.media_urls)
      );

      const jobId = firstString(
        body.job_id,
        body.jobId,
        body.task_id,
        body.taskId,
        body.download_job_id,
        body.job && body.job.id
      );

      const quotaCounted =
        body.quota_counted === true || body.download_counted === true || body.counted === true
          ? 'yes'
          : body.quota_counted === false || body.download_counted === false || body.counted === false
            ? 'no'
            : 'unknown';

      if (url || jobId) {
        return { ok: true, url: url || null, jobId: jobId || null, format, quotaCounted, raw: data };
      }
      if (body.ok === true) {
        // Declared success with no artifact: most likely a job to poll.
        return { ok: true, url: null, jobId: null, format, quotaCounted, needsPoll: true, raw: data };
      }

      return refuse(
        firstString(body.reason, body.code, nested && nested.reason),
        firstString(
          body.message,
          nested && nested.message,
          body.detail,
          'download response carried neither an artifact nor an explicit refusal'
        )
      );
    }

    /**
     * Instance wrapper around {@link SunoAPI.parseDownloadResponse}.
     * @param {unknown} data
     * @param {object} [ctx]
     * @returns {object} see the static
     */
    parseDownloadResponse(data, ctx = {}) {
      return SunoAPI.parseDownloadResponse(data, ctx);
    }

    /* ---------------------------------------------------------------
     * Library enumeration
     * ------------------------------------------------------------- */

    /**
     * ONE real `POST /api/feed/v3`, unwrapped, with the response envelope handed
     * back intact. This is the measuring instrument, and it exists because the
     * walk's two load-bearing assumptions are both UNVERIFIED against a live
     * response:
     *
     *   1. WHAT THE PAGE SIZE ACTUALLY IS. `FEED_LIMIT_MAX` (100) rests on the
     *      shipped bundle plus two third-party extensions. If the server really
     *      caps at 20, every "full page" inference and every page-count estimate
     *      is wrong by 5x. One call answers it: `data.clips.length` against the
     *      `limit` that was asked for.
     *   2. WHAT THE CURSOR FIELD IS CALLED. The bundle says `next_cursor`; a
     *      bundle is not a response. `readNextCursor` now tolerates eight
     *      spellings and reports which one matched, but tolerance is a guess
     *      until somebody looks at a body — and if none of the eight is present,
     *      the walk reports `stopReason:'cursor_missing'` instead of pretending
     *      the library ended.
     *
     * NOTHING HERE WALKS. It sends exactly one request and does not read the
     * clips; measuring the shape costs a single page.
     *
     * IT RETURNS THE RAW BODY, and that is the caller's whole problem to manage:
     * `data` is the server's response, including clip titles, prompts, lyrics and
     * URLs. It is returned as an object, never as a reply, precisely so the
     * caller has to build a derived view. `background/background.js`'s
     * `PROBE_FEED` route is that view — key names, types, counts and a
     * 12-character sample of the cursor — and nothing else. Never serialise this
     * return value straight into a message.
     *
     * Response headers are deliberately NOT returned: on an authenticated route
     * they can carry `set-cookie`, and this method has no use for one.
     *
     * ASSUMED (not verified): the route, the body shape `{cursor,limit,filters}`
     * and the field names inside the response. VERIFIED: nothing. That is the
     * point of the method.
     *
     * @param {object} [opts]
     * @param {unknown} [opts.cursor=null] the cursor to ask from; the first
     *   measurement always passes `null`
     * @param {number} [opts.limit] page size, floored and clamped to
     *   [1, {@link SunoAPI.LIMITS}.feedPageLimit]
     * @param {Record<string, unknown>} [opts.filters] the filter object exactly as
     *   the walk would send it, so the probe measures the same request the crawl
     *   makes
     * @param {AbortSignal} [opts.signal]
     * @param {number} [opts.retries=1] one retry only: this is a probe, and a
     *   failing probe should fail
     * @returns {Promise<{ok:boolean,status:number,url:string|null,via:string|null,
     *   responseUrl:string|null,method:'POST',path:string|null,requested:object,
     *   data:unknown,error:SunoApiError|null,attempts:number,elapsedMs:number}>}
     *   never throws for an HTTP or transport failure — those arrive in `error`
     */
    async fetchFeedPageRaw(opts = {}) {
      const cursor = opts.cursor === undefined ? null : opts.cursor;
      const limit = Math.max(
        1,
        Math.min(FEED_LIMIT_MAX, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : FEED_LIMIT_MAX)
      );
      const filters = opts.filters && typeof opts.filters === 'object' ? opts.filters : {};
      const requested = { cursor, limit, filters };
      const envelope = await this.request(SunoAPI.ENDPOINTS.feedV3, {
        method: 'POST',
        body: requested,
        signal: opts.signal,
        retries: Number.isFinite(opts.retries) ? opts.retries : 1,
      });
      return {
        ok: envelope.ok,
        status: envelope.status,
        url: envelope.url,
        // Which of the verified base hosts actually answered. Both are deployed,
        // and only the one that served the page can be told apart from a
        // failover, so this is part of the measurement.
        via: envelope.via,
        responseUrl: envelope.responseUrl,
        method: 'POST',
        path: envelope.path,
        requested,
        data: envelope.data,
        error: envelope.error || null,
        attempts: envelope.attempts,
        elapsedMs: envelope.elapsedMs,
      };
    }

    /**
     * The cursor reader, exposed so a caller can explain or diagnose it without
     * keeping a second implementation of it.
     *
     * `iterateFeed` and `fetchProjectFeed` both branch on
     * `readNextCursor(...).state`, and the worker's `PROBE_FEED` route publishes
     * `matchedAlias` from THIS function so the reply answers "which spelling did
     * the walk actually use?" with the walk's own parser rather than a guess. A
     * second copy of the alias list in the reporter is exactly how the two would
     * drift and how a probe would cheerfully report a field the walk never reads.
     *
     * ASSUMED, like the reader it returns: the field name and the alias set. See
     * `readNextCursor` and `fetchFeedPageRaw`.
     *
     * @param {unknown} data the parsed feed / project-feed envelope
     * @returns {{value:unknown, alias:string|null, state:'usable'|'empty'|'absent',
     *   present:Array<string>}}
     */
    static readCursorField(data) {
      return readNextCursor(data);
    }

    /**
     * The instance wrapper around {@link SunoAPI.readCursorField}, for a caller
     * that already holds a client.
     * @param {unknown} data
     * @returns {{value:unknown, alias:string|null, state:'usable'|'empty'|'absent',
     *   present:Array<string>}}
     */
    readCursorField(data) {
      return readNextCursor(data);
    }

    /**
     * Walk the library with `POST /api/feed/v3`, following the cursor.
     *
     * WHY v3 AND NOT `/api/feed/v2`: v2 is not a route Suno's web app ever
     * calls. It is absent from all 96 shipped bundle chunks and from every
     * capture, its page size is a fixed 20, and its own `num_total_results`
     * reported 21 for an account whose `/api/project/me` reported 3,444 clips.
     * A sync built on it indexed 400 clips across 20 pages of a 5,500-clip
     * library and reported "Up to date" — silent truncation, the worst class
     * of bug this client has. v3 pages by CURSOR and ends on a cursor field that
     * is present and null.
     *
     * WHY ONE WALK AND NOT TWO: the old `disliked:'both'` mode walked the feed
     * twice with `hide_disliked` flipped and reported the symmetric difference,
     * because Suno exposes NO per-clip dislike field and v2's only knob was a
     * boolean. v3's `disliked` filter is a tri-state OF STRINGS
     * (`'Any'|'True'|'False'`), so the server can be asked for exactly the
     * disliked rows and the diff is no longer needed for the walk itself. The
     * cost of the two-pass shape was not just time: `maxPages` was SHARED
     * across both passes, so pass B was silently truncated to whatever budget
     * pass A left over. One walk removes that bug by construction.
     *
     * COMPLETION IS POSITIVE, AND THREE-WAY. A walk is `completed` only when an
     * `ok` envelope carried a cursor field that is PRESENT and explicitly
     * null/empty, after at least one page. A page that carries NO cursor field
     * under any of the eight spellings {@link readNextCursor} knows stops the walk
     * with `completed:false` and an error — loudly, because that is the difference
     * between a bug the user reports and a library that silently indexes 10-20% of
     * itself and says COMPLETE. That no-cursor case reports one of TWO reasons,
     * because "no cursor field" is not one situation:
     *
     *   - `cursor_missing` the page carried CLIPS but no cursor field, so this
     *     parser does not understand the envelope. A parser bug. The fix is named
     *     in the message: look at what the field is called (PROBE_FEED) and add
     *     the spelling to {@link CURSOR_FIELD_ALIASES}.
     *   - `empty_page` the page carried NO CLIPS and no cursor field. That is a
     *     plain empty page, and reporting it as "response shape not understood"
     *     points whoever reads the log at a rebuild when the likelier truth is the
     *     feed simply omitting the cursor at end-of-feed. It is still NOT complete
     *     — see the regression this guards below.
     *
     * The regression the split guards: re-admitting `completed:true` for a
     * cursor-less page in EITHER reading. An empty page is evidence the server had
     * nothing left to give at this page size; it is not the positive end-of-feed
     * signal this walk trusts, and the shortfall is often filter accounting that
     * only a `missing` number can settle. So the zero-clip branch stops the walk
     * exactly as loudly as the parser-miss branch, reports `empty_page`, and sets
     * no `completed`. The one place in this loop that sets `completed` is the
     * present-and-null branch above it.
     *
     * Everything else is reported as incomplete, in this order:
     *   - `!envelope.ok` after the page's retries -> `error` (status, path,
     *     method and code recorded on the `SunoApiError`), never "done";
     *   - a page with 0 clips but a USABLE cursor -> `empty_page` (the server is
     *     offering more and we cannot read it) — distinct from the 0-clips-no-cursor
     *     case above by its error code, `empty_page_with_cursor`;
     *   - a `next_cursor` that repeats a cursor already used -> stuck cursor
     *     (before the no-new-ids rule, because a stuck cursor usually also
     *     repeats rows and this is the real diagnosis);
     *   - a page that yields 0 NEW ids while the cursor advances -> error
     *     (BetterSuno's `added === 0` guard);
     *   - `maxPages` reached with a cursor still outstanding -> `truncated`;
     *   - `totalSeen < expectedTotal` -> `expected_total`, with `missing`.
     * Two empty pages, a short page, or a counter running out are evidence of
     * a problem; none of them is evidence of the end of the library.
     *
     * WHAT THE FINAL PAGE LOOKED LIKE IS PUBLISHED AND NEVER ENFORCED.
     * `endOfFeedEvidence` names the shape of the last page in four values, and
     * `stopCursor` is the token the stopping request was sent with. Together they
     * let a surface say "the final page had 12 of 100 clips" instead of "we do not
     * know", and let a diagnostic probe re-request the exact page that failed.
     * Neither sets `completed`, chooses a `stopReason`, or ends a walk; see the
     * long note where `endOfFeedEvidence` is derived.
     *
     * FULL PAGES ARE REPORTED, NEVER INTERPRETED. `pagesFull` counts the pages
     * that came back with exactly `limit` clips and `lastPageSize`/`lastPageFull`
     * describe the final one. A walk that stops on a full page is suspicious —
     * the server was not out of rows — but a genuine null cursor still ends the
     * walk, because "the server said there is no more" is a fact and "the page
     * looked full" is an inference. The numbers are published so the user and
     * this file's own log can see "ended on a full page of 100" instead of having
     * it silently disappear into `completed:true`.
     *
     * INVARIANT: `completed` is false whenever `truncated` or `error` is set.
     * It is folded at the end rather than assumed, so no caller can ever read
     * `completed:true` beside a truncation.
     *
     * `dislikedIds` is retained on the summary as an ALWAYS-EMPTY Set: the
     * legacy reporting shape survives so existing call sites keep compiling,
     * but a single walk cannot classify rows it never asked for. A caller that
     * needs the disliked set runs its own `disliked:'only'` walk. (Note that
     * `background/background.js:5851` reads this off a separate `dislikedIds`
     * envelope, which no longer exists either.)
     *
     * `startPage` is deliberately NOT honoured: v3 pagination is cursor-based,
     * so "resume at page N" is not expressible. A caller that passes it gets a
     * warning and a walk that restarts from the first cursor — which is safe,
     * because writes are additive and idempotent by clip id. Persist the
     * summary's / batch's `nextCursor` to resume properly.
     *
     * @param {object} [opts]
     * @param {'workspace'|'all'} [opts.scope='workspace'] `'all'` omits the
     *   workspace filter, which is what a WHOLE-library walk requires: clips
     *   created while another project was selected live in THAT project.
     * @param {string} [opts.workspaceId='default']
     * @param {'any'|'only'|'exclude'} [opts.disliked='exclude'] `'both'` is
     *   accepted as an alias for `'any'` (the legacy mode value) and warns.
     * @param {boolean} [opts.includeTrashed=false]
     * @param {number} [opts.limit=100] floored and clamped to
     *   [1, {@link SunoAPI.LIMITS}.feedPageLimit]. NOTE that the clamp is a
     *   CEILING ON WHAT WE ASK FOR, not a statement about what the server grants:
     *   `pagesFull`/`lastPageSize` are what says which happened.
     * @param {number} [opts.maxPages=500] 500 pages x 100 = 50,000 clips
     * @param {number} [opts.expectedTotal] the number of clips the scope is
     *   KNOWN to hold — see {@link SunoAPI#expectedClipTotal}. This single
     *   number is what turns "I walked 20 pages" into "I have 400 of 5,500".
     * @param {AbortSignal} [opts.signal]
     * @param {Function} [opts.onBatch] called with each batch as it is yielded
     * @param {Function} [opts.onProgress] called with each batch and the summary
     * @returns {AsyncGenerator<object>} batch objects, then ONE summary object
     *   `{type:'summary', completed, truncated, stopReason, error, pagesDone,
     *   totalSeen, expectedTotal, missing, nextCursor, cursorAlias, sawNewIdsOnLastPage,
     *   pagesFull, lastPageSize, lastPageFull, endOfFeedEvidence, stopCursor, …}`.
     *   `stopReason` is one of
     *   `'complete' | 'cursor_missing' | 'empty_page' | 'stuck_cursor' |
     *   'no_new_ids' | 'max_pages' | 'expected_total' | 'page_failed' |
     *   'aborted'`.
     * @throws {SunoApiError} when the FIRST page fails, so that "nothing was
     *   indexed" surfaces as a failed sync instead of an empty successful one.
     *   A failure on any later page is reported in the summary instead, because
     *   by then there is real work to keep.
     */
    async *iterateFeed(opts = {}) {
      const scope = opts.scope === 'all' ? 'all' : 'workspace';
      const workspaceId = String(opts.workspaceId || 'default');
      const includeTrashed = opts.includeTrashed === true;
      const limit = Math.max(
        1,
        Math.min(FEED_LIMIT_MAX, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : FEED_LIMIT_MAX)
      );
      const maxPages = Number.isFinite(opts.maxPages) ? Math.max(1, Math.floor(opts.maxPages)) : DEFAULT_MAX_PAGES;
      const expectedTotal =
        Number.isFinite(opts.expectedTotal) && opts.expectedTotal >= 0 ? Math.floor(opts.expectedTotal) : null;
      const signal = opts.signal || null;
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      const onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : null;
      const dislikesEverything = String(opts.disliked || 'exclude').toLowerCase() === 'both';
      const disliked = normalizeDislikedFilter(opts.disliked);

      if (Number.isFinite(opts.startPage) && Math.floor(opts.startPage) > 0) {
        this.logger.warn(
          `iterateFeed: startPage=${Math.floor(opts.startPage)} is ignored — /api/feed/v3 pages by ` +
            'cursor, not by page number. The walk restarts from the first cursor; persist and pass ' +
            'a nextCursor to resume.'
        );
      }
      if (dislikesEverything) {
        this.logger.warn(
          "iterateFeed: disliked:'both' is now a single walk of the whole library (disliked:'Any'). " +
            "The two-pass symmetric difference is gone because v3 can filter disliked server-side; " +
            "run a separate disliked:'only' walk if the disliked SET is what you need."
        );
      }

      /* The bundle's own vocabulary: `getWorkspaceDefaultClipBrowserFilters`
       * overlaid on the base filter object, with `disliked` overridden by the
       * caller. Anything left at its default is not sent — the web client prunes
       * keys equal to 'Any', and a full 20-key filter object is not what the
       * server has ever been shown accepting. */
      const filters = {
        trashed: includeTrashed ? DISLIKED_FILTER_VALUES.any : DISLIKED_FILTER_VALUES.exclude,
        disliked,
        fromStudioProject: { presence: DISLIKED_FILTER_VALUES.exclude },
        stem: { presence: DISLIKED_FILTER_VALUES.exclude },
        stemComplement: DISLIKED_FILTER_VALUES.exclude,
        sort: { sortBy: 'created_at', sortDirection: 'desc' },
      };
      if (scope === 'workspace') filters.workspace = { presence: DISLIKED_FILTER_VALUES.only, workspaceId };
      const pass = `feed/v3 disliked=${disliked} scope=${scope}`;
      const seenIds = new Set();
      const usedCursors = new Set();
      let cursor = null;
      let pagesDone = 0;
      let duplicates = 0;
      let completed = false;
      let truncated = false;
      let error = null;
      let stopReason = null;
      let nextCursor = null;
      let cursorAlias = null;
      let cursorAliasesSeen = [];
      let sawNewIdsOnLastPage = false;
      let serverTotal = null;
      /* FULL-PAGE ACCOUNTING. A page that comes back with exactly `limit` clips is
       * evidence the server had more to give, which is the one piece of direct
       * evidence about the UNVERIFIED page-size cap (see
       * {@link SunoAPI#fetchFeedPageRaw}). Recorded, never acted on: a genuine
       * null cursor still ends the walk, because that is a fact and this is an
       * inference. */
      let pagesFull = 0;
      let lastPageSize = 0;

      while (pagesDone < maxPages) {
        if (signal && signal.aborted) {
          error = new SunoApiError('feed walk aborted', { code: 'aborted', aborted: true });
          stopReason = 'aborted';
          break;
        }

        usedCursors.add(cursorKey(cursor));
        // NO query string: `cursor`, `limit` and `filters` are all body fields on
        // v3. A GET-shaped `?page=N` is the v2 bug wearing a new route name.
        const envelope = await this.request(SunoAPI.ENDPOINTS.feedV3, {
          method: 'POST',
          body: { cursor, limit, filters },
          signal,
          // A 5,500-clip crawl is 55 pages; `request()`'s global default of 3
          // retries is too thin when one transient 5xx costs a whole page.
          retries: FEED_PAGE_RETRIES,
        });

        if (!envelope.ok) {
          // A page that failed because the CALLER aborted is not a page failure.
          // It is reported as an abort, so a cancelled sync is never mistaken
          // for a broken one — or, worse, for a complete one.
          if (isAbortError(envelope.error) || (signal && signal.aborted)) {
            error = new SunoApiError('feed walk aborted', { code: 'aborted', aborted: true });
            stopReason = 'aborted';
            break;
          }
          const failure =
            envelope.error ||
            new SunoApiError(`feed page failed: HTTP ${envelope.status}`, {
              status: envelope.status,
              path: envelope.path,
              method: 'POST',
            });
          if (pagesDone === 0) {
            // Nothing was indexed and nothing is recoverable: this is a failed
            // sync, not a partial one, so it is thrown rather than summarised.
            throw failure;
          }
          error = failure;
          stopReason = 'page_failed';
          this.logger.warn(
            `iterateFeed: page ${pagesDone + 1} failed after ${envelope.attempts} attempt(s): ` +
              `${redact(failure.message)} (${failure.status || 0} ${failure.code || ''})`
          );
          break;
        }

        const clips = flattenClipEntries(extractClipList(envelope.data)).map(normalizeClip).filter((clip) => clip.id);
        const fresh = [];
        for (const clip of clips) {
          if (seenIds.has(clip.id)) {
            duplicates += 1;
            continue;
          }
          seenIds.add(clip.id);
          fresh.push(clip);
        }
        pagesDone += 1;
        sawNewIdsOnLastPage = fresh.length > 0;
        /* THE THREE STATES ARE DISTINGUISHED HERE, ONCE. `readNextCursor` returns
         * `state` rather than a bare `null` precisely so this branch cannot
         * collapse "no such field" into "end of feed" again; see its JSDoc for
         * the bug that made that collapse expensive. */
        const cursorField = readNextCursor(envelope.data);
        nextCursor = cursorField.state === 'usable' ? cursorField.value : null;
        cursorAlias = cursorField.alias;
        cursorAliasesSeen = cursorField.present;
        lastPageSize = clips.length;
        if (clips.length === limit) pagesFull += 1;
        /* THE MEASUREMENT FOR A CURSOR-LESS PAGE, taken only when there is going
         * to be one — i.e. on the page the state machine below is about to stop
         * on. It costs a key enumeration and nothing else, and it is the
         * difference between the next `cursor_missing` being explicable from a log
         * line and needing somebody to hand-write a probe for it. `null` on every
         * other page, and nothing outside the `absent` branches reads it. */
        const missingCursorEvidence = cursorField.state === 'absent'
          ? describeMissingCursorPage(envelope.data, {
            via: envelope.via,
            lastPageSize,
            limit,
            pagesFull,
            pagesDone,
          })
          : null;
        /* `num_total_results` is recorded, NOT enforced. The caller's
         * `expectedTotal` is the oracle because the server's own figure is not
         * trustworthy as one: on the removed v2 route it reported 21 for a
         * library of 3,444, so adopting it here would make every sync that
         * filters rows (disliked, trashed) permanently report itself
         * incomplete. Reported for diagnostics only. */
        const advertised = envelope.data && typeof envelope.data === 'object' ? envelope.data.num_total_results : null;
        if (Number.isFinite(advertised) && advertised >= 0) serverTotal = Math.max(serverTotal, advertised);

        const batch = {
          clips: fresh,
          page: pagesDone, // 1-based ordinal: the worker reads `batch.page`
          pass,
          cursor,
          limit,
          newClips: fresh.length, // this page
          duplicates, // cumulative over the walk
          totalSeen: seenIds.size,
          pagesDone,
          expectedTotal,
          maxPages,
          completed: false, // a page is never the end of the library
        };
        if (onBatch) safeCallback(onBatch, batch, this);
        if (onProgress) safeCallback(onProgress, batch, this);
        yield batch;

        /* --- the state machine, in strict order ----------------------- */

        /* (c) THE ONLY positive completion signal, tested FIRST so that nothing
         * below can second-guess it. In particular a null cursor is the terminal
         * value, not a repeated one: the walk's first request also carries a null
         * cursor, so a repeat check that ran before this one would flag every
         * finished walk as stuck.
         *
         * This branch is reached ONLY when a cursor field was present and empty.
         * A page carrying no cursor field at all falls through to the branch
         * below, which reports the page as unreadable — a bug report, not a
         * victory lap, and never a `completed:true`. */
        if (cursorField.state === 'empty') {
          completed = true;
          stopReason = 'complete';
          break;
        }
        /* (b) NO CURSOR FIELD AT ALL.
         *
         * WHY THIS BRANCH SPLITS IN TWO, AND WHY THE ZERO-CLIP CASE IS CHECKED
         * FIRST: `absent` has always been one verdict ("this parser does not
         * understand the response"), and it fired before the empty-page check
         * below it. That ordering made a page which plainly returned 0 clips be
         * reported as "response shape not understood" — a diagnosis that points at
         * a rebuild when the truth is usually the far more boring end of the feed
         * simply omitting the cursor. It is a bug either way, and the walk still
         * stops loudly, but the CAUSE has to be the one the page actually
         * supports or the next person to read the log is sent to the wrong place.
         *
         * The regression this guards: re-admitting `completed:true` for a
         * cursor-less page. Neither branch below sets it, NEITHER is reachable
         * without `state === 'absent'`, and the only branch in this loop that
         * sets `completed` at all is the present-and-null one directly above. An
         * empty page is evidence that the server had nothing left to give at this
         * page size; it is NOT the positive end-of-feed signal this walk is built
         * to trust, and a short crawl must never be laundered into a complete one
         * by guessing at it. See `README.md`'s contract and `iterateFeed`'s
         * JSDoc.
         *
         * BOTH branches carry the same measurement (`missingCursorEvidence`), so
         * the next occurrence explains itself from the log instead of needing a
         * hand-written authenticated probe. */
        if (cursorField.state === 'absent') {
          /* (b1) 0 CLIPS AND NO CURSOR FIELD: an empty page the walk cannot
           * positively confirm as the end of the library. `stopReason` is the
           * EXISTING `empty_page` vocabulary value rather than a new one, so
           * every surface that already phrases it keeps working — the shared
           * `SYNC_REASON_PHRASE` map reads it as "the feed returned an empty
           * page", which is true, where `cursor_missing` read as a client bug.
           * The error CODE is distinct from `empty_page_with_cursor` below so the
           * two 0-clip readings stay distinguishable in the diagnostics. */
          if (clips.length === 0) {
            error = new SunoApiError(
              `feed page ${pagesDone} returned 0 clips and carried no cursor field under any of the `
                + `${CURSOR_FIELD_ALIASES.length} spellings this client knows `
                + `(${CURSOR_FIELD_ALIASES.join(', ')}). The walk stops here and is NOT claiming the `
                + 'library is finished: an empty page is not the positive end-of-feed signal this '
                + 'walk trusts, and if the page was in fact an envelope this client cannot read then '
                + 'this walk was reading nothing at all — run PROBE_FEED to see the keys the server '
                + 'actually sent',
              { code: 'empty_page_no_cursor', path: SunoAPI.ENDPOINTS.feedV3, method: 'POST' }
            );
            /* THE MEASUREMENT, AS DATA. Attached rather than interpolated into the
             * message so a reader — a diagnostics surface, the worker's automatic
             * probe — can take the envelope's key list and the base host that
             * answered without parsing English back out of a sentence. Documented on
             * the class: `evidence` is a caller-attached field, never an
             * automatically-set one. */
            error.evidence = missingCursorEvidence;
            stopReason = 'empty_page';
            this.logger.warn(
              `iterateFeed: page ${pagesDone} returned 0 clips and has no cursor field `
                + `(top-level keys: ${redact(missingCursorEvidence.topLevelKeys.join(','))}) `
                + '— the feed walk is stopping, NOT completing'
            );
            break;
          }
          /* (b2) CLIPS BUT NO CURSOR FIELD — THIS PARSER DOES NOT UNDERSTAND THE
           * RESPONSE. That is a bug, not the end of the library, and the one
           * behaviour that turned the reported symptom ("the crawl stops at 10-20%
           * and reports COMPLETE") into an invisible failure: a null from
           * `readNextCursor` used to mean both of these. It is now loud — an error
           * naming every alias that was probed, and a `stopReason` of its own so no
           * surface can render it as success. The named fix is in the message: look
           * at what the field is called (PROBE_FEED) and add the spelling. */
          error = new SunoApiError(
            `feed page ${pagesDone} carried no cursor field under any of the `
              + `${CURSOR_FIELD_ALIASES.length} spellings this client knows `
              + `(${CURSOR_FIELD_ALIASES.join(', ')}), so the response shape is not `
              + 'understood and the walk cannot claim to be finished: run PROBE_FEED '
              + 'to see the envelope, and add the field it actually uses',
            { code: 'cursor_missing', path: SunoAPI.ENDPOINTS.feedV3, method: 'POST' }
          );
          /* THE MEASUREMENT, AS DATA — see the identical attach in the branch
           * above. `topLevelKeys` is the field that settles H-B: it is the
           * complete list a discovered cursor spelling would have to join, captured
           * by the code that just threw the page away. */
          error.evidence = missingCursorEvidence;
          stopReason = 'cursor_missing';
          this.logger.warn(
            `iterateFeed: page ${pagesDone} has no cursor field (top-level keys: `
              + `${redact(missingCursorEvidence.topLevelKeys.join(','))}) `
              + '— the feed walk is stopping, NOT completing'
          );
          break;
        }
        /* A page we cannot read, with the server still offering one. Reached only
         * when the cursor WAS readable and usable, which is what distinguishes it
         * from the 0-clip branch above: here the feed is unreadable from a cursor
         * it is still handing out. */
        if (clips.length === 0) {
          error = new SunoApiError(
            `feed page ${pagesDone} returned 0 clips but a non-null next_cursor: the feed is ` +
              'unreadable from here, not finished',
            { code: 'empty_page_with_cursor', path: SunoAPI.ENDPOINTS.feedV3, method: 'POST' }
          );
          stopReason = 'empty_page';
          break;
        }
        // A cursor the walk has already followed: pagination is stuck, and
        // saying so is more actionable than any symptom of it. Checked BEFORE
        // the no-new-ids rule because a stuck cursor usually also repeats rows.
        if (usedCursors.has(cursorKey(nextCursor))) {
          error = new SunoApiError(
            `feed page ${pagesDone} repeated a next_cursor the walk already used: pagination is stuck`,
            { code: 'stuck_cursor', path: SunoAPI.ENDPOINTS.feedV3, method: 'POST' }
          );
          stopReason = 'stuck_cursor';
          break;
        }
        // A page that only repeats rows we already hold cannot be making
        // progress, so the cursor is not being advanced by anything real.
        if (fresh.length === 0) {
          error = new SunoApiError(
            `feed page ${pagesDone} added 0 new clip ids while the cursor advances: the walk is stuck`,
            { code: 'no_new_ids', path: SunoAPI.ENDPOINTS.feedV3, method: 'POST' }
          );
          stopReason = 'no_new_ids';
          break;
        }
        if (pagesDone >= maxPages) {
          truncated = true;
          stopReason = 'max_pages';
          this.logger.warn(
            `iterateFeed: stopped at maxPages=${maxPages} with ${seenIds.size} clips and a cursor ` +
              `still outstanding — this library is NOT fully indexed`
          );
          break;
        }
        cursor = nextCursor;
      }

      const totalSeen = seenIds.size;
      const missing = expectedTotal === null ? 0 : Math.max(0, expectedTotal - totalSeen);
      if (expectedTotal !== null && missing > 0 && stopReason === 'complete') {
        // The feed says it is finished and the oracle disagrees. The feed is
        // wrong (a filter hid rows, a workspace was under-counted, or the
        // total moved under us) — and the summary must say so rather than let
        // the caller report "Up to date".
        completed = false;
        truncated = true;
        stopReason = 'expected_total';
        error = new SunoApiError(
          `feed ended at ${totalSeen} of ${expectedTotal} clips`,
          { code: 'short_of_expected_total', path: SunoAPI.ENDPOINTS.feedV3, method: 'POST' }
        );
      }
      /* A walk that ended on a FULL page while still short of its oracle is the
       * signature of a truncated feed, and it is worth saying out loud in the
       * diagnostics stream even though nothing above branches on it. `warn`
       * because a crawl that indexes 10-20% of a library and says COMPLETE is
       * exactly what this file is not allowed to do quietly. */
      if (completed && lastPageSize === limit && limit > 0) {
        this.logger.warn(
          `iterateFeed: the feed reported end-of-feed (${cursorAlias || 'cursor'} was null) on a FULL page `
            + `of ${limit} clips after ${pagesDone} page(s) — the server had more to give. `
            + 'If this account is larger than that, run PROBE_FEED to check the page size and cursor field.'
        );
      }

      /* WHAT THE FINAL PAGE LOOKED LIKE, IN FOUR WORDS, AND WHAT IT IS NOT USED
       * FOR. `endOfFeedEvidence` is published so a surface can say "the last page
       * came back with 12 of 100 clips" instead of "we do not know" — which is the
       * difference this file exists to preserve: `we do not know` is honest and
       * useless, and a user cannot act on it, while "12 of 100" says the server
       * had nothing more to give at this page size and is at least a statement
       * about the walk rather than about the parser.
       *
       * WHY IT GATES NOTHING, WHICH IS THE WHOLE POINT. `completed` is false and
       * the stop reason stays in the `cursor_missing` / `empty_page` family for
       * EVERY `absent` case, and `endOfFeedEvidence` is not read by any of them.
       * There is no threshold here, no `partial_final_page ⇒ finished` shortcut,
       * and no `full_final_page ⇒ definitely truncated` shortcut either — both
       * would be inference dressed as a fact, and inference in the direction of
       * `completed` is precisely the bug class this walk was rebuilt to kill (see
       * the "THREE-WAY" note on `iterateFeed` and `README.md`'s contract). If a
       * future change wires this field into a verdict, it is the regression that
       * comment exists to prevent.
       *
       * The four values:
       *   'partial_final_page'  the walk ended on a page the server did not fill —
       *                          it had nothing more to give at this page size.
       *   'empty_page_no_cursor' the last page carried 0 clips (and, on a `cursor_missing`
       *                          or `empty_page` stop, no cursor field either).
       *   'full_final_page'      the server filled the page AND the walk still stopped:
       *                          suspicious, and reported rather than interpreted.
       *   'unknown'              the defensive default. Unreachable while `limit` is
       *                          clamped to >= 1 as it is above, so seeing it reported
       *                          is itself the bug.
       */
      let endOfFeedEvidence = 'unknown';
      if (lastPageSize === limit) endOfFeedEvidence = 'full_final_page';
      else if (lastPageSize === 0) endOfFeedEvidence = 'empty_page_no_cursor';
      else if (lastPageSize > 0 && lastPageSize < limit) endOfFeedEvidence = 'partial_final_page';

      const summary = {
        type: 'summary',
        scope,
        workspaceId: scope === 'workspace' ? workspaceId : null,
        disliked,
        // The worker-facing "this run is not the whole library" flag. It is the
        // NEGATION of `completed` by construction, so the pre-existing read of
        // `summary.truncated` in background.js keeps meaning "do not tell the
        // user we synced everything" for every incomplete case, not only for
        // the maxPages one.
        truncated: !completed,
        stopReason: stopReason || 'complete',
        completed,
        pagesDone,
        totalSeen,
        expectedTotal,
        missing,
        // What the feed CLAIMED it held, if anything. Never used as the oracle
        // — see the note where it is collected.
        serverTotal,
        nextCursor,
        /* WHICH SPELLING carried the cursor, and which spellings the last page
         * carried at all. `null`/`[]` is the `cursor_missing` signature; a name
         * other than `next_cursor` is proof that the bundle was wrong about the
         * field name. */
        cursorAlias,
        cursorAliasesSeen,
        sawNewIdsOnLastPage,
        duplicates,
        limit,
        /* FULL-PAGE SIGNAL — published, never enforced. See `fetchFeedPageRaw`
         * for why the page size is unverified and why this matters. */
        pagesFull,
        lastPageSize,
        lastPageFull: lastPageSize === limit,
        /* "the final page had N of 100 clips", in one field. Published, never
         * enforced — read the long note where it is derived. */
        endOfFeedEvidence,
        /* THE CURSOR THE STOPPING REQUEST WAS SENT WITH, so a caller can re-issue
         * the exact page that failed. `cursor` is only advanced at the very bottom
         * of the loop body, after every check, so wherever the walk `break`s the
         * local still holds the token the failing page was fetched with.
         *
         * NOT A RESUME POSITION, and deliberately not the same field as
         * `nextCursor`: `iterateFeed` accepts no start cursor (see the `startPage`
         * note), so nothing here can be handed back to this method. Its one reader
         * is a diagnostic probe that re-requests the page to read its envelope.
         * A page-1 failure reports `null`, which is the honest answer for "the
         * first request sent no cursor". */
        stopCursor: cursor,
        maxPages,
        error,
        // Legacy reporting shape, kept so existing call sites keep compiling.
        // ALWAYS EMPTY: one walk cannot classify rows it never requested.
        dislikedIds: new Set(),
        dislikedCount: 0,
      };
      /* INVARIANT (asserted, not assumed): `completed` may never be true next
       * to a truncation or an error. */
      if (summary.completed && (summary.truncated || summary.error)) {
        summary.completed = false;
        summary.truncated = true;
      }
      if (onProgress) safeCallback(onProgress, summary, this);
      yield summary;
    }

    /**
     * VERIFIED: `GET /api/project/me`. The `default` project ("My Workspace" /
     * "Workspace for unassigned clips") is always present.
     *
     * The response is PAGED (`num_total_results` / `current_page`, 20 per page)
     * and this call requests no query at all, so it returns page 1 only. That is
     * enough for the workspace LIST and its per-project `clip_count`, but a
     * completeness oracle built from it is a LOWER BOUND — see
     * {@link SunoAPI#expectedClipTotal}, which says so where it matters.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<Array<{id:string,name:string,description:string,
     *   clipCount:number|null,lastUpdatedClip:unknown,shared:boolean,canInvite:boolean}>>}
     * @throws {SunoApiError} when the request fails
     */
    async fetchProjects(opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.projectMe, { method: 'GET', signal: opts.signal });
      if (!envelope.ok) {
        throw envelope.error || new SunoApiError('fetchProjects failed', { path: envelope.path, status: envelope.status });
      }
      const projects = Array.isArray(envelope.data && envelope.data.projects) ? envelope.data.projects : [];
      return projects.map((project) => ({
        id: String(project.id),
        name: project.name || '',
        description: project.description || '',
        clipCount: typeof project.clip_count === 'number' ? project.clip_count : null,
        lastUpdatedClip: project.last_updated_clip === undefined ? null : project.last_updated_clip,
        shared: project.shared === true,
        canInvite: project.can_invite === true,
      }));
    }

    /**
     * The completeness oracle: how many clips these projects are KNOWN to hold.
     *
     * This is the one number that lets a sync say "I have 400 of 5,500"
     * instead of "I walked 20 pages, so I must be done". Feed a walk's
     * `expectedTotal` from here and {@link SunoAPI#iterateFeed} refuses to
     * report `completed` when `totalSeen` comes up short.
     *
     * Two honest caveats, both of which make the result CONSERVATIVE rather
     * than wrong:
     *   - `/api/project/me` is paged and {@link SunoAPI#fetchProjects} reads
     *     page 1 only, so this is a LOWER BOUND. Falling short of it is proof
     *     of incompleteness; meeting it is necessary but not sufficient.
     *   - pass only the projects that belong to the scope actually walked. A
     *     `scope:'workspace'` walk of `default` must be compared against THAT
     *     project's count, not the sum of every workspace, or the walk is
     *     declared short for the wrong reason.
     *
     * @param {Array<{clipCount:number|null}>} projects as returned by
     *   {@link SunoAPI#fetchProjects}
     * @returns {number} the sum of every reported `clip_count`; 0 when none are
     */
    expectedClipTotal(projects) {
      const list = Array.isArray(projects) ? projects : [];
      let total = 0;
      for (const project of list) {
        const count = project && Number.isFinite(project.clipCount) ? project.clipCount : 0;
        if (count > 0) total += count;
      }
      return total;
    }

    /**
     * VERIFIED: `GET /api/project/feed` -> `{"items":[{"type":"clip"|"video",
     * "added_at_ms":int,"clip":{...}}], "next_cursor":string|null}`. The ONLY
     * confirmed route that scopes clips to a project; membership is built by
     * joining `items[].clip.id`.
     *
     * SCOPED, PAGED, CURSOR-FED. The shipped client calls this route as
     * `GET /api/project/feed?scope=library&entity_type=clip&limit=30` and
     * advances with `getNextPageParam: e => e.next_cursor ?? null`. Calling it
     * with NO query at all — which is what this method used to do — returns one
     * unfiltered page and silently under-joins workspace membership on a large
     * library, which is the same failure shape as the v2 page walk: a partial
     * result that reads as complete. The same three-state rule as the library
     * walk applies here, deliberately: a cursor field that is PRESENT and null
     * ends the walk, a cursor field that is ABSENT means this parser does not
     * understand the response and the walk stops `cursor_missing`, and a
     * repeated cursor is an error. `maxPages` exhaustion is a truncation. The
     * `cursor_missing` case is not theoretical here either — the same envelope
     * that would hide a `next_cursor` from the library walk would hide this one.
     *
     * UNVERIFIED: the documented item shape carries no project id, so
     * attribution prefers an explicit `project_id` / `project.id` and
     * otherwise falls back to the `default` project (where unassigned clips
     * live). `inferred` reports whether that fallback was used.
     *
     * A first-page failure THROWS (nothing was gathered, so there is nothing to
     * return). A failure after at least one page RETURNS what was gathered with
     * `completed:false` and the error attached, because throwing there would
     * discard membership that is already known — and because `hydrate()` falls
     * back to re-running this whole walk whenever it is handed no memberships,
     * so a throw would re-page the feed once per hydrating batch.
     *
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @param {string} [opts.projectId='default'] fallback attribution target
     * @param {number} [opts.limit=30] the client's own default page size
     * @param {number} [opts.maxPages=500]
     * @returns {Promise<{memberships:Map<string,string>,membershipsAll:Map<string,string[]>,
     *   addedAtMs:Map<string,number>,items:number,projectId:string,inferred:boolean,
     *   completed:boolean,truncated:boolean,stopReason:string,error:SunoApiError|null,
     *   pagesDone:number,nextCursor:unknown,cursorAlias:string|null,
     *   pagesFull:number,lastPageSize:number,duplicates:number}>}
     * @throws {SunoApiError} when the FIRST page fails
     */
    async fetchProjectFeed(opts = {}) {
      const signal = opts.signal || null;
      const fallbackProject = opts.projectId || 'default';
      const limit = Math.max(
        1,
        Math.min(100, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : PROJECT_FEED_LIMIT)
      );
      const maxPages = Number.isFinite(opts.maxPages) ? Math.max(1, Math.floor(opts.maxPages)) : DEFAULT_MAX_PAGES;

      const memberships = new Map();
      const membershipsAll = new Map();
      const addedAtMs = new Map();
      const usedCursors = new Set();
      let inferred = false;
      let items = 0;
      let pagesDone = 0;
      let duplicates = 0;
      let completed = false;
      let truncated = false;
      let error = null;
      let stopReason = null;
      let nextCursor = null;
      let cursorAlias = null;
      let pagesFull = 0;
      let lastPageSize = 0;
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      let cursor = null;

      while (pagesDone < maxPages) {
        if (signal && signal.aborted) {
          error = new SunoApiError('project feed walk aborted', { code: 'aborted', aborted: true });
          stopReason = 'aborted';
          break;
        }
        usedCursors.add(cursorKey(cursor));
        // `cursor` is omitted entirely on the first call, exactly as the shipped
        // client does (`...cursor ? {cursor} : {}`).
        const query = { scope: 'library', entity_type: 'clip', limit };
        if (cursor !== null) query.cursor = cursor;
        const envelope = await this.request(SunoAPI.ENDPOINTS.projectFeed, {
          method: 'GET',
          query,
          signal,
          retries: FEED_PAGE_RETRIES,
        });
        if (!envelope.ok) {
          if (isAbortError(envelope.error) || (signal && signal.aborted)) {
            error = new SunoApiError('project feed walk aborted', { code: 'aborted', aborted: true });
            stopReason = 'aborted';
            break;
          }
          const failure =
            envelope.error ||
            new SunoApiError(`project feed page failed: HTTP ${envelope.status}`, {
              status: envelope.status,
              path: envelope.path,
              method: 'GET',
            });
          if (pagesDone === 0) throw failure;
          error = failure;
          stopReason = 'page_failed';
          this.logger.warn(
            `fetchProjectFeed: page ${pagesDone + 1} failed after ${envelope.attempts} attempt(s): ` +
              `${redact(failure.message)} (${failure.status || 0} ${failure.code || ''})`
          );
          break;
        }

        const pageItems = Array.isArray(envelope.data && envelope.data.items) ? envelope.data.items : [];
        pagesDone += 1;
        items += pageItems.length;
        for (const item of pageItems) {
          if (!item || typeof item !== 'object') continue;
          const clipId = item.clip && item.clip.id !== undefined ? String(item.clip.id) : null;
          if (!clipId) continue;
          const explicit = firstString(item.project_id, item.project && item.project.id, item.projectId);
          const projectId = explicit || fallbackProject;
          // `inferred` stays true if ANY item lacked an explicit project id.
          if (!explicit) inferred = true;
          if (!memberships.has(clipId)) memberships.set(clipId, projectId);
          else duplicates += 1;
          const list = membershipsAll.get(clipId);
          if (list) {
            if (list.indexOf(projectId) < 0) list.push(projectId);
          } else {
            membershipsAll.set(clipId, [projectId]);
          }
          if (typeof item.added_at_ms === 'number') addedAtMs.set(clipId, item.added_at_ms);
        }
        /* This walk is ~180 requests on a 5,500-clip library, and it runs BEFORE
         * the first feed page. Without a progress callback the whole opening of a
         * sync is silent, so the UI shows "0 pages, 0 clips" for minutes and reads
         * as a dead crawl. `onProgress` is what makes that phase legible. */
        if (onProgress) {
          safeCallback(onProgress, {
            phase: 'mapping',
            pagesDone,
            items,
            joined: membershipsAll.size,
            maxPages,
          }, this);
        }

        /* The SAME three-state read the library walk uses, so a project feed whose
         * cursor field is spelled differently stops the join loudly instead of
         * reporting "membership complete" on page 1 — which is what a silent
         * under-join looks like from `hydrate()`'s point of view. */
        const cursorField = readNextCursor(envelope.data);
        nextCursor = cursorField.state === 'usable' ? cursorField.value : null;
        cursorAlias = cursorField.alias;
        lastPageSize = pageItems.length;
        if (pageItems.length === limit) pagesFull += 1;
        /* (c) A cursor field that is PRESENT and empty is the terminal value, so
         * it is tested before any of the failure rules below — a repeat check
         * that ran first would match the walk's own initial null cursor and call
         * every finished walk stuck. */
        if (cursorField.state === 'empty') {
          completed = true;
          stopReason = 'complete';
          break;
        }
        /* (b) No cursor field at all: the response shape is not understood. NOT
         * the end of the project feed. */
        if (cursorField.state === 'absent') {
          error = new SunoApiError(
            `project feed page ${pagesDone} carried no cursor field under any of the `
              + `${CURSOR_FIELD_ALIASES.length} spellings this client knows `
              + `(${CURSOR_FIELD_ALIASES.join(', ')}), so workspace membership cannot be `
              + 'claimed complete — run PROBE_FEED against the feed route to see what the '
              + 'server actually calls it',
            { code: 'cursor_missing', path: SunoAPI.ENDPOINTS.projectFeed, method: 'GET' }
          );
          stopReason = 'cursor_missing';
          break;
        }
        if (pageItems.length === 0) {
          error = new SunoApiError(
            `project feed page ${pagesDone} returned 0 items but a non-null next_cursor`,
            { code: 'empty_page_with_cursor', path: SunoAPI.ENDPOINTS.projectFeed, method: 'GET' }
          );
          stopReason = 'empty_page';
          break;
        }
        if (pagesDone >= maxPages) {
          truncated = true;
          stopReason = 'max_pages';
          this.logger.warn(
            `fetchProjectFeed: stopped at maxPages=${maxPages} with ${memberships.size} clips joined and a ` +
              'cursor still outstanding — workspace membership is NOT complete'
          );
          break;
        }
        if (usedCursors.has(cursorKey(nextCursor))) {
          error = new SunoApiError('project feed returned an already-used next_cursor: pagination is stuck', {
            code: 'stuck_cursor',
            path: SunoAPI.ENDPOINTS.projectFeed,
            method: 'GET',
          });
          stopReason = 'stuck_cursor';
          break;
        }
        cursor = nextCursor;
      }

      if (!completed && !truncated && !error) {
        // The loop can only exit early through a `break`, so this is defensive.
        truncated = true;
        stopReason = stopReason || 'max_pages';
      }

      return {
        memberships,
        membershipsAll,
        addedAtMs,
        items,
        projectId: fallbackProject,
        inferred,
        completed,
        truncated: !completed,
        stopReason: stopReason || 'complete',
        error,
        pagesDone,
        nextCursor,
        cursorAlias,
        pagesFull,
        lastPageSize,
        duplicates,
        limit,
        maxPages,
      };
    }

    /**
     * VERIFIED: `GET /api/profiles/pinned-clips` -> `{"pinned_clips":[...]}`.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<Array<object>>} normalized clips; empty array on failure
     */
    async fetchPinnedClips(opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.pinnedClips, { method: 'GET', signal: opts.signal });
      if (!envelope.ok) {
        this.logger.warn('fetchPinnedClips failed: ' + redact(envelope.error && envelope.error.message));
        return [];
      }
      const pins = Array.isArray(envelope.data && envelope.data.pinned_clips) ? envelope.data.pinned_clips : [];
      return pins.map(normalizeClip).filter((clip) => clip.id);
    }

    /**
     * Liked clips, DERIVED. There is no liked-songs route: Suno exposes liking
     * only as the per-clip `is_liked` boolean, so this filters the feed.
     * @param {object} [ctx]
     * @param {AbortSignal} [ctx.signal]
     * @param {number} [ctx.maxPages]
     * @param {number} [ctx.startPage] IGNORED by the cursor walk; see
     *   {@link SunoAPI#iterateFeed}
     * @param {'any'|'only'|'exclude'|'include'} [ctx.disliked='any'] `include`
     *   is the legacy spelling of `any`
     * @param {(progress:object)=>void} [ctx.onProgress]
     * @returns {Promise<{clips:Array<object>,map:Map<string,object>,totalSeen:number,truncated:boolean}>}
     */
    async fetchLikedClips(ctx = {}) {
      const liked = new Map();
      let totalSeen = 0;
      let truncated = false;
      for await (const batch of this.iterateFeed({
        disliked: ctx.disliked || 'any',
        maxPages: ctx.maxPages,
        startPage: ctx.startPage,
        signal: ctx.signal,
        onProgress: ctx.onProgress,
      })) {
        if (!batch.clips) {
          if (batch.type === 'summary' && batch.truncated) truncated = true;
          continue;
        }
        totalSeen += batch.clips.length;
        for (const clip of batch.clips) {
          if (clip.is_liked === true) liked.set(clip.id, clip);
        }
      }
      return { clips: Array.from(liked.values()), map: liked, totalSeen, truncated };
    }

    /**
     * VERIFIED IN CLIENT: `GET /api/clips/get_songs_by_ids?ids=<csv>` -> `{"clips":[...]}`
     * (`ids` is required — 422 without it; the shipped client reads
     * `data.clips` and nothing else). Chunked to
     * {@link SunoAPI.LIMITS}.idsChunkSize (100) ids per request. This is the
     * by-id lookup route — nothing enumerates a library through it.
     * @param {string[]} ids
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @param {(progress:object)=>void} [opts.onProgress]
     * @returns {Promise<Map<string,object>>} clipId -> normalized clip
     */
    async fetchClipsByIds(ids, opts = {}) {
      const out = new Map();
      const unique = dedupeIds(ids);
      if (unique.length === 0) return out;
      const chunks = chunkList(unique, IDS_CHUNK_SIZE);
      let done = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        if (opts.signal && opts.signal.aborted) break;
        const envelope = await this.request(SunoAPI.ENDPOINTS.clipsByIds, {
          method: 'GET',
          query: { ids: chunks[i].join(',') },
          signal: opts.signal,
        });
        done += chunks[i].length;
        if (!envelope.ok) {
          this.logger.warn(
            `fetchClipsByIds chunk ${i + 1}/${chunks.length} failed: ${redact(envelope.error && envelope.error.message)}`
          );
          if (opts.onProgress) {
            safeCallback(opts.onProgress, { done, total: unique.length, chunk: i, error: envelope.error }, this);
          }
          continue;
        }
        for (const clip of flattenClipEntries(extractClipList(envelope.data))) {
          const normalized = normalizeClip(clip);
          if (normalized.id) out.set(normalized.id, normalized);
        }
        if (opts.onProgress) safeCallback(opts.onProgress, { done, total: unique.length, chunk: i, found: out.size }, this);
      }
      return out;
    }

    /**
     * Attach project membership to clips from the project-feed join.
     * @param {Array<object>|Map<string,object>} clips
     * @param {object} [ctx]
     * @param {AbortSignal} [ctx.signal]
     * @param {Map<string,string[]>} [ctx.membershipsAll] reuse a prior fetch
     * @param {Map<string,number>} [ctx.addedAtMs]
     * @param {number} [ctx.projectFeedLimit] forwarded to the fallback walk
     * @returns {Promise<Map<string,object>>} clipId -> clip plus `projectIds`
     *   and `addedAtMs`
     */
    async hydrate(clips, ctx = {}) {
      let membershipsAll = ctx.membershipsAll;
      let addedAtMs = ctx.addedAtMs;
      if (!membershipsAll) {
        const feed = await this.fetchProjectFeed({ signal: ctx.signal, limit: ctx.projectFeedLimit });
        membershipsAll = feed.membershipsAll;
        addedAtMs = feed.addedAtMs;
        if (!feed.completed) {
          // Partial membership is still real membership; the clips are simply
          // not all attributed, so it is logged rather than thrown.
          this.logger.warn(
            `hydrate: project-feed join is incomplete (${feed.stopReason}, ${membershipsAll.size} clips joined)`
          );
        }
      }
      const list = Array.isArray(clips)
        ? clips
        : clips && typeof clips.values === 'function'
          ? Array.from(clips.values())
          : [];
      const out = new Map();
      for (const clip of list) {
        const id = clip && clip.id !== undefined && clip.id !== null ? String(clip.id) : null;
        if (!id) continue;
        const stamp = addedAtMs ? addedAtMs.get(id) : undefined;
        out.set(id, {
          ...clip,
          projectIds: (membershipsAll && membershipsAll.get(id)) || [],
          addedAtMs: stamp === undefined ? null : stamp,
        });
      }
      return out;
    }

    /* ---------------------------------------------------------------
     * Remaining verified routes
     * ------------------------------------------------------------- */

    /**
     * VERIFIED: `GET /api/playlist/me` -> `{num_total_results,current_page,playlists}`.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<Array<object>>} playlists; empty array on failure
     */
    async fetchPlaylists(opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.playlistMe, { method: 'GET', signal: opts.signal });
      if (!envelope.ok) {
        this.logger.warn('fetchPlaylists failed: ' + redact(envelope.error && envelope.error.message));
        return [];
      }
      return Array.isArray(envelope.data && envelope.data.playlists) ? envelope.data.playlists : [];
    }

    /**
     * VERIFIED ROUTE, EXPERIMENTAL ENVELOPE: `GET /api/profiles/me`. BOTH
     * `playlists_sort_by` and `clips_sort_by` are REQUIRED (422 without them)
     * and their legal values are undocumented, so nothing is defaulted here.
     *
     * @param {object} opts
     * @param {string} opts.playlistsSortBy caller-supplied enum value
     * @param {string} opts.clipsSortBy caller-supplied enum value
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>} the raw, unverified envelope
     * @throws {SunoApiError} when a sort param is missing
     */
    async fetchProfileMe(opts = {}) {
      if (!opts.playlistsSortBy || !opts.clipsSortBy) {
        throw new SunoApiError(
          'fetchProfileMe requires both playlistsSortBy and clipsSortBy: the API requires both and documents neither',
          { code: 'missing_required_param', path: SunoAPI.ENDPOINTS.profilesMe }
        );
      }
      const envelope = await this.request(SunoAPI.ENDPOINTS.profilesMe, {
        method: 'GET',
        query: { playlists_sort_by: opts.playlistsSortBy, clips_sort_by: opts.clipsSortBy },
        signal: opts.signal,
      });
      return envelope.data;
    }

    /**
     * VERIFIED: `GET /api/persona/get-personas/` -> `{personas:[...]}`.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{personas:Array<object>}>}
     */
    async fetchPersonas(opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.personas, { method: 'GET', signal: opts.signal });
      return envelope.ok ? envelope.data : { personas: [] };
    }

    /**
     * VERIFIED: `GET /api/persona/get-loved-personas/`.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>}
     */
    async fetchLovedPersonas(opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.lovedPersonas, { method: 'GET', signal: opts.signal });
      return envelope.ok ? envelope.data : { personas: [] };
    }

    /**
     * VERIFIED: `GET /api/persona/get-followed-personas/`.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>}
     */
    async fetchFollowedPersonas(opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.followedPersonas, { method: 'GET', signal: opts.signal });
      return envelope.ok ? envelope.data : { personas: [] };
    }

    /**
     * VERIFIED: `GET /api/gen/{id}/waveform-aggregates` (401 when
     * unauthenticated, which is what proves the route is registered).
     * @param {string} clipId
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>} raw body
     */
    async fetchWaveformAggregates(clipId, opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.waveformAggregates, {
        method: 'GET',
        pathParams: { id: clipId },
        signal: opts.signal,
      });
      return envelope.data;
    }

    /**
     * VERIFIED: `GET /api/gen/{id}/aligned_lyrics/v3`.
     * @param {string} clipId
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>} raw body
     */
    async fetchAlignedLyrics(clipId, opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.alignedLyrics, {
        method: 'GET',
        pathParams: { id: clipId },
        signal: opts.signal,
      });
      return envelope.data;
    }

    /**
     * VERIFIED ROUTE (422 without `clip_id`): `GET /api/clips/parent`.
     * @param {string} clipId
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>} raw body (envelope undocumented)
     */
    async fetchClipParent(clipId, opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.clipParent, {
        method: 'GET',
        query: { clip_id: clipId },
        signal: opts.signal,
      });
      return envelope.data;
    }

    /**
     * VERIFIED ROUTE (422 without `clip_id`): `GET /api/clips/aligned_clip_siblings`.
     * @param {string} clipId
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>} raw body (envelope undocumented)
     */
    async fetchAlignedSiblings(clipId, opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.alignedSiblings, {
        method: 'GET',
        query: { clip_id: clipId },
        signal: opts.signal,
      });
      return envelope.data;
    }

    /**
     * VERIFIED ROUTE (422 without `job_id`, proving a job/poll model):
     * `GET /api/download/sample-pack/{clip_id}`.
     * @param {string} clipId
     * @param {object} opts
     * @param {string} opts.jobId a job id from an authorize/prepare call
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<unknown>} raw body (envelope undocumented)
     */
    async fetchSamplePack(clipId, opts = {}) {
      if (!opts.jobId) {
        throw new SunoApiError('fetchSamplePack requires a jobId (the route 422s without it)', {
          code: 'missing_required_param',
          path: SunoAPI.ENDPOINTS.downloadSamplePack,
        });
      }
      const envelope = await this.request(SunoAPI.ENDPOINTS.downloadSamplePack, {
        method: 'GET',
        pathParams: { clip_id: clipId },
        query: { job_id: opts.jobId },
        signal: opts.signal,
      });
      return envelope.data;
    }

    /**
     * POST `/api/mango/rights`.
     *
     * UNVERIFIED NESTING: every flat attempt failed validation, and the 422
     * `loc` chains this route returns are a known FABRICATION — do not trust
     * `loc`, and do not infer the body shape from it. The nesting used here is
     * the recon's best candidate; override it wholesale with `opts.body`.
     * `content_type` is a 16-value enum whose members are undocumented, so it
     * is passed through rather than guessed.
     *
     * @param {string} clipId
     * @param {object} [opts]
     * @param {string} [opts.contentType='clip']
     * @param {object} [opts.body] verbatim body override
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{ok:boolean,status:number,data:unknown,requestBody:unknown,error:SunoApiError|null}>}
     */
    async fetchMangoRights(clipId, opts = {}) {
      const requestBody = opts.body || {
        content_params: { content_id: clipId, content_type: opts.contentType || 'clip' },
      };
      const envelope = await this.request(SunoAPI.ENDPOINTS.mangoRights, {
        method: 'POST',
        body: requestBody,
        signal: opts.signal,
        retries: 0,
      });
      return {
        ok: envelope.ok,
        status: envelope.status,
        data: envelope.data,
        requestBody,
        error: envelope.error,
      };
    }

    /**
     * The stream URL pattern confirmed on real clip objects. NOT a download
     * route: it never counts against the quota.
     * @param {string} clipId
     * @returns {string}
     */
    mediaUrl(clipId) {
      return MEDIA_CDN_TEMPLATE.replace('{id}', encodeURIComponent(String(clipId)));
    }

    /* ---------------------------------------------------------------
     * Billing / quota
     * ------------------------------------------------------------- */

    /**
     * VERIFIED: `GET /api/billing/info/` — the entitlement ground truth and the
     * only trusted model catalogue. `download_usage`,
     * `additional_download_remaining`, `accessible_features`, credits,
     * `agentic_limits`, `models[]`, `subscription_platform` and
     * `remaster_model_types` all live here.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{ok:boolean,status:number,data:unknown,error:SunoApiError|null}>}
     */
    async fetchBillingInfo(opts = {}) {
      const envelope = await this.request(SunoAPI.ENDPOINTS.billingInfo, {
        method: 'GET',
        signal: opts.signal,
      });
      if (!envelope.ok) {
        this.logger.warn('fetchBillingInfo failed: ' + redact(envelope.error && envelope.error.message));
      }
      return { ok: envelope.ok, status: envelope.status, data: envelope.data, error: envelope.error };
    }

    /**
     * Normalized download quota.
     *
     * Reads `download_usage.current_period_downloads_used` and `.limit`. An
     * absent field is returned as `null`, never guessed. A `limit` of -1 or
     * null reports `unlimited:true` with `remaining:null` instead of a
     * fabricated number. `effectiveRemaining` folds in
     * `additional_download_remaining` and is what {@link SunoAPI#downloadMany}
     * 's preflight uses.
     *
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @param {boolean} [opts.force] bypass the short-lived cache
     * @returns {Promise<{used:number|null,limit:number|null,remaining:number|null,
     *   effectiveRemaining:number|null,additionalRemaining:number|null,
     *   unlimited:boolean,resetsOn:string|null,plan:string|null,
     *   canBulkDownload:boolean|null,monthlyCredits:number|null,
     *   totalCredits:number|null,ok:boolean,raw:unknown,fetchedAt:number}>}
     */
    async quota(opts = {}) {
      const now = this._now();
      if (!opts.force && this._quotaCache && now - this._quotaCachedAt < QUOTA_CACHE_TTL_MS) {
        return this._quotaCache;
      }
      const info = await this.fetchBillingInfo({ signal: opts.signal });
      const raw = info.data && typeof info.data === 'object' ? info.data : null;

      const usage = raw && typeof raw.download_usage === 'object' && raw.download_usage !== null
        ? raw.download_usage
        : null;
      const used =
        usage && typeof usage.current_period_downloads_used === 'number' ? usage.current_period_downloads_used : null;
      const limit = usage && typeof usage.limit === 'number' ? usage.limit : null;
      const unlimited = limit === null || limit < 0;
      const remaining = unlimited ? null : Math.max(0, limit - (used || 0));

      const additionalRemaining =
        raw && typeof raw.additional_download_remaining === 'number' ? raw.additional_download_remaining : null;
      const effectiveRemaining = remaining === null ? null : remaining + (additionalRemaining || 0);

      const features = raw && Array.isArray(raw.accessible_features) ? raw.accessible_features : null;
      const canBulkDownload = features
        ? features.some((feature) => /bulk|mass|zip|batch/i.test(String(feature)))
        : null;

      const quotaResult = {
        used,
        limit,
        remaining,
        effectiveRemaining,
        additionalRemaining,
        unlimited,
        resetsOn: raw && raw.renews_on !== undefined && raw.renews_on !== null ? String(raw.renews_on) : null,
        plan: pickPlan(raw),
        canBulkDownload,
        monthlyCredits:
          raw && typeof raw.monthly_credits_left === 'number'
            ? raw.monthly_credits_left
            : raw && raw.credits && typeof raw.credits.monthly_credits_left === 'number'
              ? raw.credits.monthly_credits_left
              : null,
        totalCredits:
          raw && typeof raw.total_credits_left === 'number'
            ? raw.total_credits_left
            : raw && raw.credits && typeof raw.credits.total_credits_left === 'number'
              ? raw.credits.total_credits_left
              : null,
        subscriptionPlatform: raw && raw.subscription_platform ? String(raw.subscription_platform) : null,
        ok: info.ok,
        raw,
        fetchedAt: now,
      };
      this._quotaCache = quotaResult;
      this._quotaCachedAt = now;
      return quotaResult;
    }

    /**
     * The trusted model catalogue, read from billing (NOT from the session
     * route). Each entry carries an `external_key` such as
     * `chirp-custom:<uuid>` and a `can_use` flag.
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @param {boolean} [opts.force]
     * @returns {Promise<Array<{externalKey:string,name:string|null,canUse:boolean,raw:object}>>}
     */
    async fetchModelCatalogue(opts = {}) {
      const quotaInfo = await this.quota({ signal: opts.signal, force: opts.force });
      const raw = quotaInfo.raw;
      const models = raw && Array.isArray(raw.models) ? raw.models : [];
      return models.map((model) => ({
        externalKey: firstString(model.external_key, model.key) || null,
        name: model.name || model.title || null,
        canUse: model.can_use === true,
        raw: model,
      }));
    }

    /* ---------------------------------------------------------------
     * Downloads
     * ------------------------------------------------------------- */

    /**
     * POST `/api/download/authorize` — registered, POST-only (GET returns 405).
     *
     * UNVERIFIED: the request and response shapes are both unknown. The body
     * sent here is a flat `{clip_ids:[...]}` guess; override it with
     * `opts.body`. The raw response is always returned so the caller can
     * record the real shape the first time it succeeds.
     *
     * @param {string[]} clipIds
     * @param {object} [opts]
     * @param {object} [opts.body] verbatim body override
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<{ok:boolean,status:number,data:unknown,requestBody:unknown,error:SunoApiError|null}>}
     */
    async authorizeDownload(clipIds, opts = {}) {
      const ids = dedupeIds(clipIds);
      const requestBody = opts.body || { clip_ids: ids };
      const envelope = await this.request(SunoAPI.ENDPOINTS.downloadAuthorize, {
        method: 'POST',
        body: requestBody,
        signal: opts.signal,
      });
      return {
        ok: envelope.ok,
        status: envelope.status,
        data: envelope.data,
        requestBody,
        error: envelope.error,
      };
    }

    /**
     * POST `/api/download/clips/zip/prepare` — registered, POST-only. The body
     * is FLAT and requires `clip_ids`, capped at **200 per request**
     * (confirmed). The response shape is UNKNOWN and may be a job; the business
     * rule string "Bulk download is not available." is detected and reported
     * as a synthesized `{unsupported:true}` rather than as a failure.
     *
     * @param {string[]} clipIds
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @param {number} [opts.chunkSize=200] do not exceed the server maximum
     * @param {(progress:object)=>void} [opts.onProgress]
     * @returns {Promise<{chunks:Array<object>,responses:Array<object>,unsupported:boolean,
     *   totalChunks:number,sentClipIds:number,unsupportedMessage:string|null}>}
     *   `responses` is the raw per-chunk request envelopes, in order.
     */
    async prepareZip(clipIds, opts = {}) {
      const ids = dedupeIds(clipIds);
      const chunkSize = Math.max(1, Math.min(ZIP_CHUNK_SIZE, opts.chunkSize || ZIP_CHUNK_SIZE));
      const chunks = chunkList(ids, chunkSize);
      const responses = [];
      const details = [];
      let unsupported = false;
      let unsupportedMessage = null;

      for (let i = 0; i < chunks.length; i += 1) {
        if (opts.signal && opts.signal.aborted) break;
        const batch = chunks[i];
        const envelope = await this.request(SunoAPI.ENDPOINTS.downloadZipPrepare, {
          method: 'POST',
          body: { clip_ids: batch }, // FLAT body, exactly as confirmed
          signal: opts.signal,
        });
        const marker = containsBulkUnavailable(envelope.data);
        if (marker) {
          unsupported = true;
          unsupportedMessage = marker;
        }
        responses.push(envelope);
        details.push({
          chunkIndex: i,
          clipIds: batch,
          request: { method: 'POST', body: { clip_ids: batch } },
          ok: envelope.ok,
          status: envelope.status,
          data: envelope.data,
          error: envelope.error,
          unsupported: !!marker,
        });
        if (opts.onProgress) {
          safeCallback(
            opts.onProgress,
            { done: i + 1, total: chunks.length, chunk: i, unsupported: unsupported },
            this
          );
        }
      }

      return {
        chunks: details,
        responses,
        unsupported,
        totalChunks: chunks.length,
        sentClipIds: details.reduce((sum, chunk) => sum + chunk.clipIds.length, 0),
        unsupportedMessage,
      };
    }

    /**
     * Download one clip, trying each verified route IN ORDER and reporting
     * which one worked:
     *
     *   1. `GET /api/studio/clip/{id}/download?format=`   (primary)
     *   2. `GET /api/download/clip/{id}?format=`          (fallback)
     *   3. `POST /api/gen/{id}/convert_wav/` then `GET /api/gen/{id}/wav_file/`
     *      (legacy WAV path; 403 here means ENTITLEMENT, not auth)
     *
     * A step that answers `ok:false` records its reason and falls through. If
     * every step fails, the collected reasons are returned. The `format` enum
     * is undocumented: the caller's value is passed through verbatim (empty
     * when omitted, matching the observed `?format=`) and recorded in metrics.
     *
     * The old bug where route 2 served files without counting quota was closed
     * server-side on 2026-09-09, so this is NOT a free bypass and
     * `quotaCounted` is reported as `'unknown'` unless the body says otherwise.
     *
     * @param {string} clipId
     * @param {object} [opts]
     * @param {string} [opts.format] caller-supplied format enum value
     * @param {AbortSignal} [opts.signal]
     * @param {boolean} [opts.allowWavFallback=true]
     * @returns {Promise<{ok:boolean,url:string|null,via:string|null,jobId:string|null,
     *   quotaCounted:'unknown'|'yes'|'no',body:unknown,format:string|null,
     *   reasons:Array<{via:string,reason:string,message:string,status:number}>,
     *   attempts:Array<object>}>}
     */
    async downloadClip(clipId, opts = {}) {
      const id = String(clipId);
      const format = formatQueryValue(opts.format);
      const signal = opts.signal || null;
      const attempts = [];
      const reasons = [];
      this._tallyFormat(format);

      const attempt = async (via, run) => {
        if (signal && signal.aborted) {
          const aborted = new SunoApiError('download aborted', { code: 'aborted', path: via, aborted: true });
          attempts.push({ via, ok: false, reason: 'aborted', message: aborted.message, status: 0 });
          return { ok: false, via, result: null, envelope: null };
        }
        const outcome = await run();
        if (outcome.result && outcome.result.ok) {
          attempts.push({
            via,
            ok: true,
            status: outcome.envelope ? outcome.envelope.status : 0,
            url: outcome.result.url,
            jobId: outcome.result.jobId,
          });
          return { ok: true, via, result: outcome.result, envelope: outcome.envelope };
        }
        const reason = outcome.result ? outcome.result.reason : 'unknown';
        const message = outcome.result ? outcome.result.message : 'no response';
        const status = outcome.result ? outcome.result.status : outcome.envelope ? outcome.envelope.status : 0;
        attempts.push({ via, ok: false, reason, message, status });
        reasons.push({ via, reason, message, status });
        return { ok: false, via, result: outcome.result, envelope: outcome.envelope };
      };

      /* Step 1 — Studio download route. */
      const studio = await attempt('studio/clip/{id}/download', async () => {
        const envelope = await this.request(SunoAPI.ENDPOINTS.downloadStudioClip, {
          method: 'GET',
          pathParams: { id },
          query: { format },
          signal,
        });
        return {
          envelope,
          result: SunoAPI.parseDownloadResponse(envelope.data, {
            status: envelope.status,
            headers: envelope.headers,
            responseUrl: envelope.responseUrl,
            format,
          }),
        };
      });
      if (studio.ok) {
        return this._downloadResult(id, format, studio.via, studio.result, attempts, reasons);
      }

      /* Step 2 — generic download route. */
      const generic = await attempt('download/clip/{id}', async () => {
        const envelope = await this.request(SunoAPI.ENDPOINTS.downloadClip, {
          method: 'GET',
          pathParams: { id },
          query: { format },
          signal,
        });
        return {
          envelope,
          result: SunoAPI.parseDownloadResponse(envelope.data, {
            status: envelope.status,
            headers: envelope.headers,
            responseUrl: envelope.responseUrl,
            format,
          }),
        };
      });
      if (generic.ok) {
        return this._downloadResult(id, format, generic.via, generic.result, attempts, reasons);
      }

      /* Step 3 — legacy WAV: convert, then fetch the signed S3 URL. */
      if (opts.allowWavFallback !== false) {
        const wav = await attempt('gen/{id}/convert_wav/ + gen/{id}/wav_file/', async () => {
          const convert = await this.request(SunoAPI.ENDPOINTS.convertWav, {
            method: 'POST',
            pathParams: { id },
            body: {},
            signal,
          });
          if (!convert.ok) {
            const refusal = SunoAPI.parseDownloadResponse(convert.data, {
              status: convert.status,
              headers: convert.headers,
              format,
            });
            if (refusal.ok) return { envelope: convert, result: refusal };
            return {
              envelope: convert,
              result: {
                ok: false,
                reason: convert.error
                  ? `${convert.error.code}${SunoApiError.isEntitlementError(convert.error) ? '_entitlement' : ''}`
                  : 'convert_failed',
                message: convert.error ? convert.error.message : 'convert_wav request failed',
                status: convert.status,
                raw: convert.data,
              },
            };
          }
          const file = await this.request(SunoAPI.ENDPOINTS.wavFile, {
            method: 'GET',
            pathParams: { id },
            signal,
          });
          return {
            envelope: file,
            result: SunoAPI.parseDownloadResponse(file.data, {
              status: file.status,
              headers: file.headers,
              responseUrl: file.responseUrl,
              format,
            }),
          };
        });
        if (wav.ok) {
          return this._downloadResult(id, format, wav.via, wav.result, attempts, reasons);
        }
      }

      this.logger.warn(`downloadClip ${id} failed on all routes: ${redact(reasons.map((r) => r.reason).join(', '))}`);
      this._tallyFormat(format, false);
      return {
        ok: false,
        clipId: id,
        url: null,
        via: null,
        jobId: null,
        quotaCounted: 'unknown',
        body: null,
        format: format || null,
        reasons,
        attempts,
      };
    }

    /**
     * Batch download driver. Sequential, so the shared RateLimiter (not a
     * concurrency race) sets the pace.
     *
     * Because one song = one download regardless of format, the input is
     * DEDUPED BY CLIP ID before any request is spent. A quota preflight stops
     * the batch when `quota().effectiveRemaining` is lower than the number of
     * unique songs, calling `opts.onQuotaShortfall(quota, info)` first.
     * Per-item error isolation: one failure never aborts the batch.
     *
     * @param {string[]} clipIds
     * @param {object} [opts]
     * @param {string} [opts.format]
     * @param {AbortSignal} [opts.signal]
     * @param {(progress:object)=>void} [opts.onProgress]
     * @param {(quota:object, info:object)=>void} [opts.onQuotaShortfall]
     * @param {boolean} [opts.stopOnQuotaShortfall=true]
     * @param {boolean} [opts.skipPreflight=false] spend quota blindly
     * @param {boolean} [opts.allowWavFallback=true]
     * @returns {Promise<{results:Array<object>,succeeded:number,failed:number,
     *   stopped:'quota'|'aborted'|null,quota:object|null,quotaShortfall:object|null,
     *   requested:number,unique:number,duplicatesDropped:number}>}
     */
    async downloadMany(clipIds, opts = {}) {
      const requested = Array.isArray(clipIds) ? clipIds.length : 0;
      const unique = dedupeIds(clipIds);
      const duplicatesDropped = requested - unique.length;
      if (duplicatesDropped > 0) {
        this.logger.info(`downloadMany: dropped ${duplicatesDropped} duplicate clip ids (one song = one download)`);
      }

      const summary = {
        results: [],
        succeeded: 0,
        failed: 0,
        stopped: /** @type {'quota'|'aborted'|null} */ (null),
        quota: null,
        quotaShortfall: null,
        requested,
        unique: unique.length,
        duplicatesDropped,
      };
      if (unique.length === 0) return summary;

      if (opts.skipPreflight !== true) {
        const quota = await this.quota({ signal: opts.signal, force: true });
        summary.quota = quota;
        const remaining = quota.effectiveRemaining;
        if (typeof remaining === 'number' && remaining < unique.length) {
          summary.quotaShortfall = { needed: unique.length, remaining, limit: quota.limit, used: quota.used };
          if (typeof opts.onQuotaShortfall === 'function') {
            safeCallback(
              opts.onQuotaShortfall,
              quota,
              this,
              summary.quotaShortfall
            );
          }
          this.logger.warn(
            `downloadMany preflight: ${unique.length} songs requested but only ${remaining} downloads remain`
          );
          if (opts.stopOnQuotaShortfall !== false) {
            summary.stopped = 'quota';
            return summary;
          }
        }
      }

      for (let i = 0; i < unique.length; i += 1) {
        if (opts.signal && opts.signal.aborted) {
          summary.stopped = 'aborted';
          break;
        }
        const id = unique[i];
        let result;
        try {
          result = await this.downloadClip(id, {
            format: opts.format,
            signal: opts.signal,
            allowWavFallback: opts.allowWavFallback,
          });
        } catch (err) {
          // Per-item isolation: record and keep going. Nothing is swallowed.
          this.logger.warn(`downloadMany item ${id} threw: ${redact(err && err.message)}`);
          result = {
            ok: false,
            clipId: id,
            url: null,
            via: null,
            jobId: null,
            quotaCounted: 'unknown',
            body: null,
            reasons: [{ via: 'driver', reason: 'exception', message: redact(err && err.message), status: 0 }],
            attempts: [],
          };
        }
        summary.results.push(result);
        if (result.ok) summary.succeeded += 1;
        else summary.failed += 1;
        if (opts.onProgress) {
          safeCallback(
            opts.onProgress,
            {
              index: i + 1,
              total: unique.length,
              clipId: id,
              ok: result.ok === true,
              succeeded: summary.succeeded,
              failed: summary.failed,
              url: result.url,
              via: result.via,
            },
            this
          );
        }
      }
      return summary;
    }

    /**
     * Normalize a successful download attempt into the public result shape.
     * @param {string} clipId
     * @param {string} format
     * @param {string} via
     * @param {object} result parseDownloadResponse output
     * @param {Array<object>} attempts
     * @param {Array<object>} reasons
     * @returns {object}
     * @private
     */
    _downloadResult(clipId, format, via, result, attempts, reasons) {
      this._tallyFormat(format, true);
      return {
        ok: true,
        clipId,
        url: result.url || null,
        via,
        jobId: result.jobId || null,
        // Never assume: the server-side fix that closed the free-download bug
        // means we can only report what the body actually stated.
        quotaCounted: result.quotaCounted || 'unknown',
        signedUrlTtlSeconds: result.url ? SunoAPI.SIGNED_URL_TTL_SECONDS : null,
        body: result.raw,
        format: format || null,
        reasons,
        attempts,
      };
    }

    /**
     * Record which format enum values were attempted and how they fared. The
     * enum is undocumented, so this tally is the only way to learn its members.
     * @param {string} format
     * @private
     */
    _tallyFormat(format, ok) {
      const key = format === '' ? '(empty)' : format;
      const current = this._formatTally.get(key) || { attempts: 0, ok: 0, failed: 0 };
      current.attempts += 1;
      if (ok === true) current.ok += 1;
      else if (ok === false) current.failed += 1;
      this._formatTally.set(key, current);
      this.metrics.formats = {};
      for (const [name, entry] of this._formatTally) {
        this.metrics.formats[name] = { attempts: entry.attempts, ok: entry.ok, failed: entry.failed };
      }
    }

    /**
     * A flat snapshot of limiter state, metrics and format tallies.
     * @returns {object}
     */
stats() {
      return {
        metrics: this.metrics,
        rateLimiter: this.rateLimiter.stats(),
        baseUrls: this.baseUrls,
        formats: this.metrics.formats,
      };
    }
  }

/* ====================================================================
   * 6. Exports
   * ==================================================================
   * The IIFE above keeps every internal name off the global scope. Only the
   * classes and one shared default instance are published.
   */

  VERIFIED_ROUTE_SET = Object.freeze(
    Object.values(SunoAPI.ENDPOINTS).reduce((set, route) => {
      set[route] = true;
      return set;
    }, {})
  );

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SunoAPI: SunoAPI, SunoApiError: SunoApiError, RateLimiter: RateLimiter };
  }

  // The extension background is an MV3 service worker (no `window`), so publish
  // onto globalThis as well; content scripts get it off `window`.
  if (typeof globalThis !== 'undefined') {
    globalThis.SunoAPI = SunoAPI;
    globalThis.SunoApiError = SunoApiError;
    globalThis.RateLimiter = RateLimiter;
    // One shared client, so the rate limiter and token cache are global.
    globalThis.SunoAPIClient = globalThis.SunoAPIClient || new SunoAPI();
  }

  if (typeof window !== 'undefined') {
    window.SunoAPI = SunoAPI;
    window.SunoAPIClient = globalThis.SunoAPIClient;
  }
})();
