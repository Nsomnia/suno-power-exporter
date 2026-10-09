'use strict';

/**
 * Load the REAL `background/background.js` inside a `node:vm` context.
 *
 * ============================ WHAT WORKS, VERIFIED =========================
 *
 * The monolith DOES evaluate cleanly under `node:vm`. Every one of its
 * `importScripts` entries loads, and the body registers four listeners
 * (`runtime.onMessage`, `runtime.onStartup`, `runtime.onInstalled`,
 * `alarms.onAlarm`) without throwing. The three load-time `chrome` touch points
 * that MUST exist are:
 *
 *   background.js:10861-10862  chrome.downloads.onChanged.addListener  <-- bites first
 *   background.js:11130-11131  chrome.runtime.onInstalled.addListener
 *   background.js:11150-11151  chrome.runtime.onStartup.addListener
 *   background.js:11160-11166  chrome.runtime.onMessage / chrome.alarms.onAlarm
 *
 * ============================ WHAT NEEDS A WORKAROUND ======================
 *
 * EXACTLY ONE: `lib/db.js`. It is not that it throws at load time — it does not,
 * it loads fine and publishes a `SunoDB` whose methods reject when they reach
 * for `indexedDB`. It is skipped because:
 *
 *   1. `background.js:228` does `const DB = SunoDB` ONCE at module scope, and
 *      `SunoDB` comes from `resolveGlobal` (:212), which reads
 *      `globalThis.SunoDB` (background.js:198-207). So seeding a fake onto the
 *      sandbox's globalThis BEFORE the body evaluates is sufficient to replace
 *      it completely. That is the primary injection seam and it works.
 *   2. The real one cannot work in Node: `DB.open()` (background.js:10901) is
 *      the first thing bootstrap does, and it reaches for `indexedDB`.
 *
 * NOTHING ELSE needed a workaround. Verified empirically, loading the real
 * files in Node with no browser globals at all:
 *
 *   lib/api.js      loads. Resolves `globalThis.fetch` at :985 — a plain
 *                   function on the sandbox is enough.
 *   lib/suno.js     loads, publishes `SunoFilter` on `globalThis` (:1562-1565).
 *   lib/crypto.js   loads. Takes its `window` branch (:1224-1227) and
 *                   `background.js:136-140` has already aliased `window` to
 *                   `globalThis`, so that branch is the one that runs.
 *   lib/drm.js      loads, same shape (:1799-1807).
 *   lib/tagger.js   loads. `globalThis` only, by its own note (:2125).
 *   lib/lyrics.js   loads, `globalThis` only (:896).
 *   lib/audio.js    loads. Resolves `SunoTagger` lazily off `globalThis`.
 *   parts/*.js      all six load; each publishes an `SMU*` global, which is what
 *                   the `MISSING_PARTS` check at background.js:253-271 reads.
 *
 * `MISSING_LIBS` / `MISSING_PARTS` ARE PURELY DIAGNOSTIC — verified. They are
 * pushed to at background.js:230-238 and :253-271, reported in the
 * `bootstrap.ready` log line (:11027-11028), published on the diagnostics
 * routes (:9900, :9966) and NEVER GUARD ANY EXECUTION. The only thing that reads
 * them is `log()`. A missing lib degrades that feature; it does not stop the
 * worker. (The one place a missing global would actually throw is
 * `background.js:6722`, `SunoAPI.LIMITS.feedPageLimit`, inside `runSync` — but
 * that only runs if `api.js` failed, which it does not.)
 */

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKGROUND = path.join(ROOT, 'background', 'background.js');

/**
 * The `importScripts` list from `background.js:168-188`, in order.
 *
 * `lib/db.js` is dropped and a fake `SunoDB` is seeded instead — see the header.
 * The ORDER is kept exactly as the monolith declares it, because the monolith's
 * own comment (background.js:143-166) says it is load-bearing, not alphabetical:
 * crypto before drm (drm resolves AES at CALL time), db before anything that
 * writes, api before suno, audio LAST (it resolves `SunoTagger` lazily).
 */
const SKIP = ['../lib/db.js'];

class Worker {
  /**
   * @param {object} opts see {@link createWorker}
   */
  constructor(opts) {
    this.opts = opts;
    this.disposed = false;
    this.ctx = null;
    this.sandbox = null;
    this.loadedScripts = [];
    this.loadErrors = [];
    this.diagnostics = null;
  }

  /* ------------------------------------------------------------------ *
   * messaging
   * ------------------------------------------------------------------ */

  /**
   * Send a `chrome.runtime.onMessage` payload to the worker's router, exactly
   * as a UI surface would.
   *
   * @param {string} type e.g. `'SYNC_START'`
   * @param {object} [payload]
   * @returns {Promise<object|undefined>} the router's reply
   */
  async sendMessage(type, payload) {
    return this.opts.chrome.dispatchMessage({ type, ...(payload || {}) });
  }

  /** `SYNC_STATUS` — the worker's own answer on whether a crawl is in flight. */
  syncStatus() {
    return this.sendMessage('SYNC_STATUS');
  }

  /** `GET_BOOT` — the surface snapshot, including `missingLibs`/`missingParts`. */
  getBoot() {
    return this.sendMessage('GET_BOOT');
  }

  /* ------------------------------------------------------------------ *
   * alarms
   * ------------------------------------------------------------------ */

  /**
   * Advance the SHARED virtual clock and fire whatever came due. The stub is
   * shared across workers, so this works on a fresh worker over the same
   * storage exactly as it does on the original.
   */
  advanceTime(ms) {
    return this.opts.chrome.advanceTime(ms);
  }

  fireAlarm(name) {
    return this.opts.chrome.fireAlarm(name);
  }

  /* ------------------------------------------------------------------ *
   * observation
   * ------------------------------------------------------------------ */

  /** Every broadcast the worker has made through the shared stub. */
  broadcasts(type) {
    return this.opts.chrome.broadcastsOfType(type);
  }

  /** `SYNC_DONE` / `SYNC_ERROR` — the terminal push, whichever arrived. */
  terminalPush() {
    return this.opts.chrome.lastBroadcast('SYNC_DONE') || this.opts.chrome.lastBroadcast('SYNC_ERROR');
  }

  /**
   * Wait for a terminal sync push (or for the crawl to finish without one).
   *
   * `runSync` is fire-and-forget from `startSync` (background.js:5547, :5685) —
   * the reply comes back immediately with `{state:'running'}` — so a test has to
   * observe the TERMINAL broadcast, not the reply.
   *
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<object|null>}
   */
  async waitForTerminal(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = this.terminalPush();
      if (t) return t;
      if (Date.now() > deadline) return null;
      await sleep(10);
    }
  }

  /** Let queued microtasks and timers drain without advancing the clock. */
  async settle(rounds = 6) {
    for (let i = 0; i < rounds; i += 1) await sleep(5);
  }

  /* ------------------------------------------------------------------ *
   * EVICTION
   * ------------------------------------------------------------------ */

  /**
   * Simulate service-worker eviction.
   *
   * What actually dies in Chrome: the JS realm — every module-scope binding in
   * `background.js`, including `syncController`, `settingsCache`,
   * `bootstrapPromise`, the `RateLimiter`'s queue and every pending `await`.
   * What survives: IndexedDB (`SunoDB`) and `chrome.storage.session`. That is
   * exactly the split this performs — the context is thrown away and every
   * in-flight timer/await in it goes with it, while the `db` and `chrome` objects
   * the TEST holds keep their state.
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    /* Every `await` the DEAD worker had in flight dies with it. For a request
     * parked on the fake server's stall that has to be forced from this side,
     * because the promise lives in the TEST-owned server, not in the realm
     * being discarded. */
    if (this.opts.fetchOwner && typeof this.opts.fetchOwner.cancelInFlight === 'function') {
      try {
        this.killedInFlight = this.opts.fetchOwner.cancelInFlight();
      } catch (err) {
        this.loadErrors.push(err);
      }
    }
    // Cancel every timer the worker created inside the context. Without this a
    // `setInterval` from an earlier worker keeps the process alive and, worse,
    // keeps writing into a DB the next worker is now using.
    if (this.sandbox && typeof this.sandbox.__clearAllTimers === 'function') {
      try {
        this.sandbox.__clearAllTimers();
      } catch (err) {
        this.loadErrors.push(err);
      }
    }
    /* FREEZE THE REALM'S FUTURE, THE WAY A REAL EVICTION DOES.
     *
     * A real MV3 teardown kills the JS realm MID-AWAIT: every pending fetch
     * simply never comes back, and no line after it ever runs. Rejecting the
     * parked request (the previous model) is NOT enough — the crawl's retry
     * loop catches an ordinary retryable network error and continues, so the
     * "dead" worker finished its whole crawl after disposal and raced the
     * fresh worker for the same cursor row. The primary guarantee is now in
     * the server's `cancelInFlight`, which ABANDONS the parked request
     * without settling it — the dead realm stays on its await forever.
     *
     * This fetch poison is the secondary layer: `SunoAPI` resolves
     * `this.fetchImpl` ONCE at construction (lib/api.js:1535), so reassigning
     * the global does not stop an already-built client — but any code in the
     * dead realm that constructs a NEW client, or reads `globalThis.fetch`
     * after this point, gets a promise that never settles, which is the same
     * never-comes-back guarantee. Global property lookups are dynamic in a vm
     * context, so the reassignment is seen by those later reads. */
    if (this.sandbox) {
      const deadRealm = this.sandbox;
      deadRealm.fetch = () => new Promise(() => {
        /* never settles: the realm is gone and nothing is ever coming back */
      });
    }
    // Cut the realm off from the shared storage: a listener registered by the
    // DEAD worker must not receive the next worker's broadcasts.
    this._detachListeners();
    this.ctx = null;
    this.sandbox = null;
    // Two macrotask turns: enough for any in-flight `await` in the discarded
    // realm to observe its dead signals rather than racing the next worker.
    await sleep(0);
    await sleep(0);
  }

  _detachListeners() {
    const stub = this.opts.chrome;
    for (const path of ['runtime.onMessage', 'runtime.onStartup', 'runtime.onInstalled',
      'alarms.onAlarm', 'downloads.onChanged']) {
      let cur = stub.chrome;
      for (const seg of path.split('.')) cur = cur && cur[seg];
      if (cur && Array.isArray(cur._listeners)) cur._listeners.length = 0;
    }
  }
}

/**
 * Create a worker over the given fakes.
 *
 * @param {object} opts
 * @param {function} opts.fetch  a `fetch`-shaped function — normally
 *   `new FakeSunoServer(...).fetch`
 * @param {object} opts.db  a `FakeDB`. HELD BY THE CALLER, which is what lets a
 *   second `createWorker` over the same `db` see the first one's writes.
 * @param {ChromeStub} opts.chrome  the shared stub. Also caller-held, for the
 *   same reason: `storage.session` is the eviction-survival record
 *   (`STORAGE_KEYS.SESSION_SYNC_RUN`, background.js:294).
 * @param {object} [opts.fetchOwner] the `FakeSunoServer` behind `opts.fetch`.
 *   Only used by `dispose()`, to kill requests parked on a stall.
 * @param {object} [opts.storage] seeded `storage.local` / `storage.session`,
 *   e.g. `{'suno.settings': {...}}`
 * @param {boolean} [opts.bootstrap=true] run `ensureBootstrapped()` and await
 *   it. The monolith kicks this off at module scope anyway
 *   (background.js:11160-11170); awaiting it makes failures a test failure
 *   instead of an unhandled rejection.
 * @returns {Promise<Worker>}
 */
async function createWorker(opts) {
  const o = opts || {};
  if (typeof o.fetch !== 'function') throw new Error('createWorker needs a fetch function');
  if (!o.db) throw new Error('createWorker needs a db');
  if (!o.chrome) throw new Error('createWorker needs a chrome stub');

  const chromeStub = o.chrome;
  // Seed storage BEFORE the worker evaluates, so bootstrap reads it.
  if (o.storage) {
    for (const area of ['local', 'session']) {
      const seed = o.storage[area];
      if (!seed) continue;
      for (const k of Object.keys(seed)) chromeStub.storageData[area][k] = seed[k];
    }
  }

  const worker = new Worker({ fetch: o.fetch, fetchOwner: o.fetchOwner || null, db: o.db, chrome: chromeStub });
  const timers = new Set();

  /* ------------------------------------------------------------------ *
   * The sandbox
   * ------------------------------------------------------------------ */
  const sandbox = {
    // --- what the libs need -------------------------------------------
    fetch: o.fetch,
    console: consoleLogger(chromeStub),
    setTimeout: (fn, ms, ...args) => {
      const h = setTimeout(fn, ms, ...args);
      timers.add(h);
      return h;
    },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms, ...args) => {
      const h = setInterval(fn, ms, ...args);
      timers.add(h);
      return h;
    },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Event,
    EventTarget,
    CustomEvent,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    TransformStream: globalThis.TransformStream,
    Blob: globalThis.Blob,
    URLSearchParams_: undefined,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    structuredClone,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    // Deliberately NOT provided: `document`, `indexedDB`, `localStorage`,
    // `window.fetch`. If any lib needs one of these at LOAD time this harness
    // fails loudly here rather than quietly at crawl time.

    // The REAL chrome stub, shared across workers by reference.
    chrome: chromeStub.chrome,
  };

  /* THE DB SEAM. `background.js:212` resolves `SunoDB` off `globalThis` and
   * `:228` aliases it to `DB` ONCE. Seeding it here, before the body is
   * evaluated, is therefore the whole substitution. */
  sandbox.SunoDB = o.db;

  /* `background.js:136-140` installs a `window` alias itself, but only when
   * `window` is undefined — which it is. That alias points `window` at
   * `globalThis`, i.e. at THIS sandbox, so `lib/crypto.js:1224-1227` and
   * `lib/drm.js:1799-1802` take their `window` branch correctly. */
  sandbox.self = sandbox;

  sandbox.__clearAllTimers = () => {
    for (const h of timers) {
      clearTimeout(h);
      clearInterval(h);
    }
    timers.clear();
  };

  const ctx = vm.createContext(sandbox, {
    name: 'suno-service-worker',
    codeGeneration: { strings: true, wasm: false },
  });

  /* ------------------------------------------------------------------ *
   * importScripts
   * ------------------------------------------------------------------ */
  const loadErrors = [];
  ctx.importScripts = function importScriptsShim(...specs) {
    for (const spec of specs) {
      if (SKIP.indexOf(spec) >= 0) {
        worker.loadedScripts.push({ spec, abs: null, skipped: true });
        continue;
      }
      // `background.js` lives in `background/`, so its `'../lib/x.js'` specs
      // resolve against that directory — which is exactly what `importScripts`
      // does in a real worker.
      const abs = path.resolve(path.dirname(BACKGROUND), spec);
      let code;
      try {
        code = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        loadErrors.push(new Error('importScripts could not read ' + spec + ': ' + err.message));
        continue;
      }
      try {
        vm.runInContext(code, ctx, { filename: abs });
        worker.loadedScripts.push({ spec, abs, skipped: false });
      } catch (err) {
        err.message = 'importScripts failed on ' + spec + ': ' + err.message;
        loadErrors.push(err);
      }
    }
    if (loadErrors.length) {
      // A real `importScripts` throws, and the monolith's load-time health
      // checks (background.js:243-271) exist precisely because a silent skip
      // surfaces later as a confusing first-call error. Throw here too.
      throw loadErrors[0];
    }
  };

  /* ------------------------------------------------------------------ *
   * the monolith
   * ------------------------------------------------------------------ */
  worker.ctx = ctx;
  worker.sandbox = sandbox;
  worker.loadErrors = loadErrors;

  const source = fs.readFileSync(BACKGROUND, 'utf8');
  try {
    vm.runInContext(source, ctx, { filename: BACKGROUND });
  } catch (err) {
    err.message = 'background/background.js failed to evaluate: ' + err.message;
    err.harnessLoadedScripts = worker.loadedScripts.map((s) => s.spec);
    throw err;
  }

  /* The monolith's own load-time health check, run for real. If a lib or a part
   * is missing this is where it shows — and it is the honest signal that the
   * harness, not the extension, is at fault. */
  const boot = await safeSend(worker, 'GET_BOOT');
  worker.diagnostics = {
    missingLibs: (boot && boot.missingLibs) || null,
    missingParts: (boot && boot.missingParts) || null,
    boot,
  };

  if (o.bootstrap !== false) {
    // background.js:11160-11170 fires `ensureBootstrapped()` at module scope.
    // Awaiting the route that depends on it forces the same promise to settle.
    await worker.sendMessage('GET_BOOT');
    await worker.settle(3);
  }

  return worker;
}

/** A `console` that routes into the stub's log so a test can read it. */
function consoleLogger(stub) {
  const push = (level) => (...args) => {
    stub.consoleLines.push({ at: stub.now(), level, text: args.map(stringify).join(' ') });
  };
  return {
    log: push('log'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    trace: push('trace'),
    dir: push('dir'),
    table: push('table'),
  };
}

function stringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch (err) {
    return String(v);
  }
}

function safeSend(worker, type) {
  return worker.sendMessage(type).catch((err) => ({ ok: false, harnessError: err.message }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mint a fake Clerk JWT whose `exp` claim is `expiresInMs` from now.
 *
 * The token must be a REAL three-part JWT, not an opaque string, because the
 * expiry is read off it twice:
 *   - `decodeJwtExpiry` (`background.js:1606`, and `lib/api.js:421-438`) parses
 *     the payload and reads `exp` in SECONDS;
 *   - `SunoAPI.getToken` (`lib/api.js:1571-1607`) sets `this.tokenExpiry` from
 *     it and then serves the cached token until `exp - now < TOKEN_EXPIRY_SKEW_MS`.
 *
 * The signature is not checked by anything in this repo (the fake server never
 * verifies it), so a fixed filler byte is enough — and deliberately so, so no
 * test can accidentally depend on a valid signature.
 *
 * @param {object} [opts]
 * @param {number} [opts.expiresInMs=3600000] lifetime from now
 * @param {number} [opts.now=Date.now()]
 * @returns {string}
 */
function makeJwt(opts = {}) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const expiresInMs = typeof o.expiresInMs === 'number' ? o.expiresInMs : 3600000;
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ exp: Math.floor((now + expiresInMs) / 1000) }) + '.sig';
}

/**
 * The default storage seed every crawl test needs.
 *
 * WHY A TOKEN IS SEEDED RATHER THAN MINTED: `getAuthToken`
 * (background.js:1660) resolves through `SunoAPIClient`'s `tokenProvider`
 * (background.js:1373) and, on a miss, runs the whole MAIN-world Clerk sweep —
 * `chrome.scripting.executeScript` per Suno tab and up to 12 s of waiting for a
 * page global (background.js:1544-1551). With no Suno tab, every authenticated
 * request fails with `missing_token` and the crawl stops at page 0, which is a
 * REAL failure mode but the wrong one to be studying.
 *
 * `chrome.storage.session['suno.auth.session']` (`STORAGE_KEYS.SESSION_AUTH`,
 * background.js:281) is the one place a raw token is ever written
 * (background.js:1592-1593), so seeding it here is faithful rather than a
 * backdoor. `warmAuthCacheOnWake` (background.js:1568) picks it up at bootstrap
 * and hands it to both caches.
 *
 * @param {object} [overrides] merged into the returned seed
 * @returns {{local:object, session:object}}
 */
function defaultStorageSeed(overrides) {
  const token = makeJwt({ expiresInMs: 3600000 });
  const seed = {
    local: {
      'suno.settings': {
        /* A high rate limit with jitter OFF so the crawl is not paced by the
         * shared `RateLimiter` (`lib/api.js:1096`, configured at
         * background.js:1367-1375). The default is 4/s (background.js:834),
         * which would make a 10-page crawl take seconds of pure waiting. The
         * limiter is real and still runs — this just stops it being the thing
         * under test. */
        rateLimit: 500,
        rateLimitJitter: false,
        concurrency: 8,
        autoSync: false,
        syncIntervalMinutes: 60,
        /* `syncMaxPages` 200 is the shipped default (background.js:898). Left
         * alone deliberately: the TODO's second cause is that this single cap is
         * applied to BOTH phases of the crawl, so a test that raised it would
         * hide the bug rather than expose it. */
        feedPageLimit: 100,
        dislikedMode: 'exclude',
      },
    },
    session: {
      'suno.auth.session': { token, exp: Date.now() + 3600000, obtainedAt: Date.now() },
    },
  };
  if (overrides && typeof overrides === 'object') {
    for (const area of ['local', 'session']) {
      if (overrides[area]) seed[area] = { ...seed[area], ...overrides[area] };
    }
  }
  return seed;
}

module.exports = {
  createWorker,
  Worker,
  makeJwt,
  defaultStorageSeed,
  ROOT,
  BACKGROUND,
  SKIP,
};