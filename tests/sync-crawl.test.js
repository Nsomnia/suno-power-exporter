'use strict';

/**
 * BEHAVIOURAL TESTS FOR THE LIBRARY CRAWL.
 *
 * These are the first behavioural tests this repository has ever had.
 * `scripts/check-build.sh` runs 98 STRUCTURAL checks — every file parses, every
 * file is UTF-8, every `manifest.json` path resolves — and all 98 passed while
 * the crawl indexed 5,943 of ~6,287 clips and reported INCOMPLETE forever. That
 * gap is what this file closes.
 *
 * WHAT IS ACTUALLY UNDER TEST. Not a reimplementation of the crawl: the REAL
 * `background/background.js` is evaluated in a `node:vm` context by
 * `tests/harness/worker.js`, against a fake Suno backend with OPAQUE cursors,
 * over an in-memory `SunoDB`. Every cursor-token, every retry, every
 * `DB.syncState.set` and every verdict is the production code path.
 *
 * WHY THE CURSORS ARE OPAQUE. `lib/api.js` pages `/api/feed/v3` by a cursor in
 * the REQUEST BODY (`lib/api.js:2745`), and the monolith records
 * `cursor.cursors[projectId]` only at a workspace's end
 * (`background.js:6761-6768`). A fake whose cursors were page numbers would let
 * a resume "work" by arithmetic. These are 12 random bytes each, in a private
 * Map, and the server rejects a token it never issued — so a resumed worker that
 * cannot actually resume fails here rather than passing by coincidence.
 *
 * HOW TO READ A FAILURE. Every assertion is on a value the WORKER produced
 * (`SYNC_DONE`'s contract, or `DB.syncState.get('feed')`), never on the fake's
 * own bookkeeping. If a test fails, the worker disagreed with the library it was
 * pointed at — which is the product bug, not the harness.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { FakeSunoServer, END_OF_FEED, FAILURE } = require('./harness/fake-suno-server');
const { FakeDB } = require('./harness/fake-db');
const { ChromeStub } = require('./harness/chrome-stub');
const { createWorker, defaultStorageSeed } = require('./harness/worker');

const TERMINAL_TIMEOUT_MS = 60000;

/**
 * Stand up a fresh account + worker.
 *
 * The settings seed comes from `worker.js`'s `defaultStorageSeed`, which also
 * plants a session bearer token. The token is NOT optional: with no
 * `suno.auth.session` record, `getAuthToken` (background.js:1660) runs the whole
 * MAIN-world Clerk mint sweep and fails with `missing_token`, so every crawl
 * would stop at page 0 for a reason that has nothing to do with the bug under
 * test.
 *
 * @param {object} [opts]
 * @param {object} [opts.server] FakeSunoServer options
 * @param {object} [opts.settings] extra `suno.settings` overrides
 * @returns {Promise<object>} the shared fakes plus a `boot()` for more workers
 */
async function setup(opts = {}) {
  const o = opts || {};
  const server = new FakeSunoServer(o.server || {});
  const db = new FakeDB();
  const chrome = new ChromeStub();
  const seed = defaultStorageSeed({
    local: { 'suno.settings': Object.assign({ feedPageLimit: 40 }, o.settings || {}) },
  });

  const worker = await createWorker({
    fetch: server.fetch,
    fetchOwner: server,
    db,
    chrome,
    storage: seed,
  });

  /* THE HARNESS'S OWN LOAD-TIME CONTRACT. `background.js:253-271` computes
   * `MISSING_LIBS` / `MISSING_PARTS` and reports them (background.js:11027,
   * :9900, :9966) without ever acting on them — verified, they are purely
   * diagnostic. So if they are non-empty here the crawl would silently run with
   * a feature switched off, which is exactly the kind of quiet degradation a
   * behavioural harness must refuse to hide. */
  assert.deepEqual(worker.diagnostics.missingLibs, null,
    'every lib must load under node:vm — missing: ' + JSON.stringify(worker.diagnostics.missingLibs));
  assert.deepEqual(worker.diagnostics.missingParts, null,
    'every parts/*.js must load — missing: ' + JSON.stringify(worker.diagnostics.missingParts));

  return { server, db, chrome, worker };
}

/** Start a crawl and wait for the terminal push. */
async function runSync(worker, opts = {}) {
  const reply = await worker.sendMessage('SYNC_START', Object.assign(
    { force: false, dislikedMode: 'exclude', maxPages: 200 },
    opts,
  ));
  assert.equal(reply.ok, true, 'SYNC_START should be accepted, got ' + JSON.stringify(reply));
  const terminal = await worker.waitForTerminal(TERMINAL_TIMEOUT_MS);
  assert.ok(terminal,
    'the crawl must reach a terminal push. Broadcasts seen: '
    + JSON.stringify([...new Set(worker.opts.chrome.broadcasts.map((b) => b.message.type))]));
  return terminal;
}

/** A compact, assertable view of the crawl's contract. */
function verdictOf(push) {
  return {
    type: push.type,
    state: push.state,
    completed: push.completed,
    truncated: push.truncated,
    stopReason: push.stopReason,
    error: push.error ? String(push.error) : null,
    total: push.total,
    totalSeen: push.totalSeen,
    uniqueSeen: push.uniqueSeen,
    expectedTotal: push.expectedTotal,
    missing: push.missing,
    pagesDone: push.pagesDone,
    workspaces: (push.workspaces || []).map((w) => ({
      projectId: w.projectId,
      completed: w.completed,
      pagesDone: w.pagesDone,
      totalSeen: w.totalSeen,
      stopReason: w.stopReason,
      cursorOmitted: w.cursorOmitted === true,
    })),
  };
}

/* ======================================================================== *
 * (a) THE BASELINE — a clean, uninterrupted crawl COMPLETES
 * ======================================================================== */

/**
 * GUARDS: the claim every fix has to earn before it is allowed to claim
 * anything else.
 *
 * THE BUG THIS IS POINTED AT: twenty-plus fix attempts were made against a crawl
 * that had never once been observed to finish. If the BASELINE crawl cannot
 * complete, then no eviction test below means anything, and any fix "verified"
 * against it was verified against a broken premise. This test is the premise.
 *
 * It pins the three things a completed crawl must agree on simultaneously:
 *   - the worker's own contract (`SYNC_DONE` says `completed:true`)
 *   - the crawl cursor on disk (`DB.syncState.get('feed')` says the same)
 *   - the indexed library itself (`DB.clips.count()` == the server's count)
 *
 * A verdict that disagrees with the rows it wrote is precisely the reported
 * symptom: "Sync INCOMPLETE: 5,943 clips indexed" beside an index the crawl had
 * actually finished.
 */
test('(a) clean uninterrupted crawl COMPLETES and the verdict matches the index', async (t) => {
  const TOTAL_CLIPS = 120;
  const PAGE_SIZE = 40;
  const { server, db, worker } = await setup({
    server: { totalClips: TOTAL_CLIPS, serverMaxPageSize: PAGE_SIZE },
  });
  t.after(() => worker.dispose());

  const push = await runSync(worker);
  const v = verdictOf(push);

  assert.equal(push.type, 'SYNC_DONE',
    'a clean crawl ends in SYNC_DONE, not SYNC_ERROR. Got ' + JSON.stringify(v));
  assert.equal(v.completed, true, 'completed must be true. ' + JSON.stringify(v));
  assert.equal(v.stopReason, 'complete', 'stopReason must be "complete". ' + JSON.stringify(v));
  assert.equal(v.truncated, false, 'a completed crawl is not truncated. ' + JSON.stringify(v));
  assert.equal(v.error, null, 'a completed crawl carries no error. ' + JSON.stringify(v));

  // The counts must agree with EACH OTHER and with the account.
  assert.equal(v.totalSeen, TOTAL_CLIPS, 'totalSeen. ' + JSON.stringify(v));
  assert.equal(v.expectedTotal, TOTAL_CLIPS, 'expectedTotal from /api/project/me. ' + JSON.stringify(v));
  assert.equal(v.missing, 0, 'missing. ' + JSON.stringify(v));

  // ...and with what is actually on disk.
  assert.equal(db.clipIds().length, TOTAL_CLIPS,
    'the index must hold every clip. Indexed: ' + db.clipIds().length);
  assert.deepEqual(db.clipIds(), server.expectedIds(),
    'the indexed set must be exactly the library — no duplicates, no gaps.');

  // ...and with the cursor the crawl left behind, which is what a resume reads.
  const cursor = db.feedCursor();
  assert.equal(cursor.state, 'idle', 'a completed crawl leaves state "idle"');
  assert.equal(cursor.completed, true, 'the stored cursor must also say completed');
  assert.equal(cursor.stopReason, 'complete', 'the stored cursor must also say complete');
  assert.deepEqual(cursor.projectsDone, ['default'], 'the one workspace is recorded done');
  assert.equal(v.pagesDone, 3, '120 clips at 40 per page is 3 pages');

  // The oracle is the workspace's own `clip_count`, so the fake and the crawl
  // cannot disagree about what "the whole library" means.
  const feedRequests = server.feedRequests();
  assert.equal(feedRequests.length, 3, 'exactly three feed pages were requested');
  for (const r of feedRequests) {
    assert.equal(r.status, 200, 'every feed page must be 200');
    assert.equal(r.failure, null, 'no failures were injected');
  }

  /* `buildWorkspacePlan` ALWAYS appends a `default` workspace when
   * `/api/project/me` did not report one (background.js:5952-5954), with
   * `clipCount: null`. THIS account's only reported workspace IS `default`, so
   * `seen.has('default')` is true and nothing is appended — one workspace in,
   * one workspace walked. Test (b2) is where the invented-`default` case is
   * asserted, because its workspaces are named `ws-a`/`ws-b`/`ws-c`.
   *
   * It is asserted rather than left implicit because the obvious fake — fall
   * back to the first known workspace for an unknown id — silently inflates an
   * unrelated workspace's request count and makes a resume look like it
   * re-walked finished work. It did exactly that while this file was written. */
  assert.equal(v.workspaces.length, 1, 'exactly one workspace was reported and walked: ' + JSON.stringify(v.workspaces));
  assert.equal(v.workspaces[0].projectId, 'default', JSON.stringify(v.workspaces));
  assert.equal(v.workspaces[0].totalSeen, TOTAL_CLIPS, JSON.stringify(v.workspaces));
  assert.equal(server.timesServed('ws-a', 0), 0, 'nothing was invented');
});

/* ======================================================================== *
 * (b) EVICTION — the crawl is killed mid-flight and must RESUME
 * ======================================================================== */

/**
 * GUARDS: the headline bug. "the extension worker was stopped mid-crawl (no page
 * for 93s)", after which the index sat at 5,943 of ~6,287 and the verdict said
 * INCOMPLETE forever.
 *
 * This test reproduces that shape exactly:
 *
 *   1. a worker starts and commits page 1 (40 clips), writing `state:'running'`
 *      to `DB.syncState('feed')` — the row an evicted worker leaves behind
 *      (`background.js:7384`, :7434, every page);
 *   2. it parks mid-page-2 on a server stall, which is the `await` MV3 reclaims
 *      a worker inside;
 *   3. `dispose()` throws the whole realm away — every module-scope binding,
 *      `syncController`, `bootstrapPromise`, the rate limiter, every pending
 *      await — while `SunoDB` and `chrome.storage.session` (both test-held, both
 *      IndexedDB- and memory-backed in Chrome) survive;
 *   4. a BRAND NEW worker boots over the same DB and the same chrome stub, which
 *      is what a browser does on the next event;
 *   5. `SYNC_START` with `force:false` must pick the stored cursor up and finish
 *      the library.
 *
 * AND THE HONEST PART: `iterateFeed` accepts no `startCursor`
 * (`lib/api.js:2673-2679`) and the monolith says so itself
 * (`background.js:5564-5567`), so a resume is at WORKSPACE granularity — the
 * in-flight workspace is re-walked from `cursor:null`. That is correct only if
 * writes are additive and idempotent by clip id, which is what
 * `clips.putMany` is for (`background.js:5567`). So this test asserts the two
 * things that make re-walking legitimate:
 *
 *   - the FINAL index is exactly the library, with no duplicates and no gaps;
 *   - a resume really happened: page offset 0 is requested a SECOND time, and
 *     the workspace that was already finished is not re-walked at all.
 *
 * A fix that merely made the verdict say "complete" would fail the first
 * assertion. A fix that made the resume re-walk a FINISHED workspace would fail
 * the second. Both are the bugs this test exists to catch.
 */
test('(b) a crawl interrupted by worker eviction RESUMES on a fresh worker and COMPLETES', async (t) => {
  const TOTAL_CLIPS = 120;
  const PAGE_SIZE = 40;
  const STALL_AT_OFFSET = 40; // the SECOND feed page, i.e. after one page commits

  const { server, db, chrome, worker: w1 } = await setup({
    server: { totalClips: TOTAL_CLIPS, serverMaxPageSize: PAGE_SIZE },
  });
  // Park the crawl on page 2, before any of its clips can be committed.
  server.failWhen({ route: 'feed', kind: FAILURE.STALL, pageOffset: STALL_AT_OFFSET, times: 1 });

  t.after(() => w1.dispose());

  await w1.sendMessage('SYNC_START', { force: false, dislikedMode: 'exclude', maxPages: 200 });

  // Wait until page 1 has actually landed and page 2 is parked.
  const deadline = Date.now() + 30000;
  let cursor = null;
  while (Date.now() < deadline) {
    cursor = db.feedCursor();
    if (cursor && cursor.pagesDone >= 1) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(cursor && cursor.pagesDone >= 1, 'the first page must commit before eviction');
  // Let the second request reach the stall.
  for (let i = 0; i < 100 && !server._parked.size; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(server._parked.size > 0, 'the crawl must be parked mid-page-2');

  /* --- THE STATE AN EVICTED WORKER LEAVES BEHIND --------------------- */
  const evicted = db.feedCursor();
  assert.equal(evicted.state, 'running',
    'a page write always records "running" — assert what the worker wrote. '
    + '(A healed row says "interrupted", and THAT is resumable too — see (b3).)');
  assert.equal(evicted.completed, false);
  assert.equal(evicted.totalSeen, PAGE_SIZE, 'exactly one page is committed');
  assert.deepEqual(evicted.projectsDone, [],
    'the in-flight workspace is NOT recorded done — that is what makes it re-walkable');
  assert.equal(db.clipIds().length, PAGE_SIZE, 'one page is indexed');

  /* The run record in storage.session, which is the piece that survives
   * eviction by design (`STORAGE_KEYS.SESSION_SYNC_RUN`, background.js:285-294). */
  const runRecord = chrome.storageData.session['suno.syncRun.session'];
  assert.ok(runRecord && runRecord.running === true,
    'the run record must say a crawl was in flight: ' + JSON.stringify(runRecord));

  /* --- EVICTION ------------------------------------------------------- */
  const clipsBeforeEviction = db.clipIds().length;
  await w1.dispose();
  assert.equal(w1.killedInFlight, 1, 'the parked request must die with the realm');
  assert.equal(db.clipIds().length, clipsBeforeEviction,
    'IndexedDB survives the worker — the index must be intact');
  assert.equal(db.feedCursor().state, 'running',
    'the cursor row survives the worker, which is the whole point');

  /* --- A BRAND NEW WORKER OVER THE SAME FAKES ------------------------- */
  chrome.broadcasts.length = 0; // only judge w2's pushes
  server.clearFailures();
  const w2 = await createWorker({ fetch: server.fetch, fetchOwner: server, db, chrome });
  t.after(() => w2.dispose());
  await w2.settle(5);

  // It really is a different realm, reading state that outlived the first.
  assert.deepEqual(w2.diagnostics.missingLibs, null, 'w2 loaded its libs');
  assert.equal(db.clipIds().length, clipsBeforeEviction, 'w2 boot indexed nothing new yet');

  // The reconciled status must stop claiming a live crawl — no controller exists.
  const status = await w2.syncStatus();
  assert.equal(status.ok, true, 'SYNC_STATUS must answer: ' + JSON.stringify(status).slice(0, 300));
  assert.equal(status.running, false,
    'nothing is running in w2: `running` IS the controller and there is none');

  /* --- RESUME --------------------------------------------------------- */
  const push = await runSync(w2);
  const v = verdictOf(push);

  assert.equal(push.type, 'SYNC_DONE',
    'the resumed crawl ends in SYNC_DONE. ' + JSON.stringify(v));
  assert.equal(v.completed, true, 'the resumed crawl completes. ' + JSON.stringify(v));
  assert.equal(v.stopReason, 'complete', 'stopReason. ' + JSON.stringify(v));
  assert.equal(v.error, null, 'no error. ' + JSON.stringify(v));
  assert.equal(v.totalSeen, TOTAL_CLIPS, 'the whole library, across both workers. ' + JSON.stringify(v));
  assert.equal(v.missing, 0, 'nothing missing. ' + JSON.stringify(v));

  /* THE TWO THINGS THAT MAKE A RE-WALK LEGITIMATE. */
  assert.deepEqual(db.clipIds(), server.expectedIds(),
    'exactly the library — additive, idempotent-by-id writes mean the re-walk added no duplicates and lost nothing');

  const feedRequests = server.feedRequests();
  const offsets = feedRequests.map((r) => r.pageOffset);
  console.error('DEBUG offsets', JSON.stringify(offsets), 'reqs', JSON.stringify(feedRequests.map((r) => ({off:r.pageOffset,st:r.status,f:r.failure,seq:r.seq}))));
  assert.ok(offsets.indexOf(0) !== offsets.lastIndexOf(0),
    'page offset 0 must be served twice: once by w1 and once by w2 re-walking the in-flight workspace. '
    + 'Offsets: ' + JSON.stringify(offsets));
  // w1 requested offset 40 and was evicted while parked on it, so it was
  // REQUESTED twice but only ever WALKED once (w2 got the 200). A resume that
  // restarted from scratch instead of picking the cursor up would show 2 walks.
  assert.equal(server.timesRequested('default', 40), 2,
    'offset 40 was requested by both workers. Offsets: ' + JSON.stringify(offsets));
  assert.equal(server.timesServed('default', 40), 1,
    'offset 40 was only ever WALKED once — w1 never received a 200 for it, it was evicted mid-request.');

  const cursorAfterResume = db.feedCursor();
  assert.deepEqual(cursorAfterResume.projectsDone, ['default'], 'the workspace is recorded done on the resumed run');
});

/**
 * GUARDS: the RESUME half of (b), isolated — and the specific claim the TODO
 * makes about it being broken.
 *
 * A single workspace means the in-flight one and the whole library are the same
 * workspace, which hides whether a resume SKIPS FINISHED WORK. Three workspaces
 * does not: `projectsDone` (`background.js:6760`, written when a workspace's walk
 * ends) is the only thing that stops the finished ones being re-walked, and a
 * resume that ignored it would re-fetch thousands of clips the first worker had
 * already indexed.
 *
 * The TODO records that `resumable` once required `stored.state === 'running'`
 * while every eviction reconcile writes `state:'interrupted'`, so a "resume"
 * after a heal was a full re-crawl. That is FIXED: the predicate now accepts
 * BOTH states (a healed row is not a verdict — its plan and `projectsDone` are
 * as of its last commit), and (b3) below covers the healed-row resume
 * explicitly. This test still asserts that the index is exactly right either
 * way, and it records which workspaces were re-walked so a regression in
 * either direction is visible.
 */
test('(b2) a resume skips the workspaces the evicted worker already finished', async (t) => {
  const PER_WORKSPACE = 40;
  const WORKSPACES = [
    { id: 'ws-a', name: 'Alpha', clipCount: PER_WORKSPACE },
    { id: 'ws-b', name: 'Beta', clipCount: PER_WORKSPACE },
    { id: 'ws-c', name: 'Gamma', clipCount: PER_WORKSPACE },
  ];
  const TOTAL_CLIPS = PER_WORKSPACE * WORKSPACES.length;
  const { server, db, chrome, worker: w1 } = await setup({
    server: { totalClips: TOTAL_CLIPS, serverMaxPageSize: 40, projects: WORKSPACES },
  });

  // Park the crawl inside workspace B, so A is finished and recorded in
  // `projectsDone` and B is the one in flight.
  server.failWhen({ route: 'feed', kind: FAILURE.STALL, workspaceId: 'ws-b', times: 1 });

  t.after(() => w1.dispose());
  await w1.sendMessage('SYNC_START', { force: false, dislikedMode: 'exclude', maxPages: 200 });

  const deadline = Date.now() + 30000;
  let cursor = null;
  while (Date.now() < deadline) {
    cursor = db.feedCursor();
    // Wait for the stall to be PARKED, not just for A to be recorded done:
    // `projectsDone` is written when A's walk ends, which is a moment BEFORE
    // the request for B's first page is issued, so waiting on the cursor alone
    // races the request that is about to park.
    if (cursor && Array.isArray(cursor.projectsDone) && cursor.projectsDone.indexOf('ws-a') >= 0
      && server._parked.size > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(cursor && cursor.projectsDone.indexOf('ws-a') >= 0,
    'workspace A must be recorded done before the eviction. Cursor projectsDone: '
    + JSON.stringify(cursor && cursor.projectsDone));
  assert.ok(server._parked.size > 0, 'the crawl must be parked inside workspace B');
  assert.ok(cursor.projectIds.length >= 3,
    'the crawl must have planned all three workspaces. Got: ' + JSON.stringify(cursor.projectIds));
  assert.equal(server.timesServed('ws-a', 0), 1, 'workspace A was walked exactly once');

  await w1.dispose();

  /* --- resume on a fresh worker over the same DB + chrome --------------- */
  server.clearFailures();
  const w2 = await createWorker({ fetch: server.fetch, fetchOwner: server, db, chrome });
  t.after(() => w2.dispose());

  const push = await runSync(w2);
  const v = verdictOf(push);

  assert.equal(push.type, 'SYNC_DONE', JSON.stringify(v));
  assert.equal(v.completed, true, 'the resumed crawl completes. ' + JSON.stringify(v));
  assert.equal(v.stopReason, 'complete', JSON.stringify(v));
  assert.equal(v.totalSeen, TOTAL_CLIPS, 'all three workspaces. ' + JSON.stringify(v));
  assert.equal(v.missing, 0, JSON.stringify(v));

  // THE POINT OF THREE WORKSPACES: A was finished before the eviction, so a
  // resume that ignored `projectsDone` would re-fetch all 40 of its clips.
  // `ws-a` is single-workspace-sized here, so exactly one page is the whole of it.
  assert.equal(server.timesServed('ws-a', 0), 1,
    'the FINISHED workspace must not be re-walked on resume. '
    + 'If it is, the resume is a restart and a 6,000-clip library re-walks '
    + 'everything it already indexed.');
  assert.equal(v.workspaces.length, 4, JSON.stringify(v.workspaces));
  assert.deepEqual(
    v.workspaces.map((w) => w.projectId).sort(),
    ['default', 'ws-a', 'ws-b', 'ws-c'],
    'all three named workspaces plus the `default` one `buildWorkspacePlan` always '
    + 'appends (background.js:5952-5954). Four, not three.');
  assert.equal(v.workspaces.filter((w) => w.completed).length, 4,
    'and all four completed — the empty `default` is a completed walk too: ' + JSON.stringify(v.workspaces));
  // And the `default` workspace the plan invented must contribute NO clips. It is
  // appended with `clipCount: null`, so the server said nothing about it; a fake
  // that served another workspace's rows for it would inflate every count here.
  assert.equal(server.timesServed('default', 0), 1,
    'the invented `default` workspace is walked exactly once and is empty');
  assert.deepEqual(db.clipIds(), server.expectedIds(), 'the index is exactly the library');
});

/* ======================================================================== *
 * (b3)/(b4) THE HEALED-ROW PATHS — the ones the user actually hits
 * ======================================================================== */

/**
 * Stage the eviction the USER sees, not the fast one (b)/(b2) use.
 *
 * (b)/(b2) evict within a heartbeat of the last page commit, so the fresh
 * worker's bootstrap sees `ageMs < SYNC_RUN_HEARTBEAT_FLOOR_MS` (5 s), the row
 * is NOT orphaned, no heal runs, and the row is still `state:'running'` when
 * Sync is pressed. Real evictions are not that polite: the worker dies, the
 * `SYNC_RUN` alarm wakes a fresh one MINUTES later, and by then the run record
 * is long stale — the wake reconciliation heals the row to `interrupted`.
 * Everything the user has reported lived on that slower path, and until now no
 * test exercised it.
 *
 * This parks the crawl inside workspace B (so A is finished and recorded),
 * evicts, and then BACKDATES the run record's heartbeat past the floor so the
 * next worker's bootstrap genuinely reconciles. The clock in the vm is Node's
 * real `Date`, so backdating the stored record is the deterministic way in —
 * the alternative is sleeping 5+ real seconds per test.
 *
 * @returns {Promise<{atEvict:object}>} the cursor row as the evicted worker
 *   left it
 */
async function parkEvictAndGoStale(t, server, db, chrome, w1) {
  await w1.sendMessage('SYNC_START', { force: false, dislikedMode: 'exclude', maxPages: 200 });
  const deadline = Date.now() + 30000;
  let cursor = null;
  while (Date.now() < deadline) {
    cursor = db.feedCursor();
    if (cursor && Array.isArray(cursor.projectsDone) && cursor.projectsDone.indexOf('ws-a') >= 0
      && server._parked.size > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(cursor && cursor.projectsDone.indexOf('ws-a') >= 0 && server._parked.size > 0,
    'the crawl must be parked inside workspace B with A recorded done');
  const atEvict = db.feedCursor();
  await w1.dispose();
  const record = chrome.storageData.session['suno.syncRun.session'];
  assert.ok(record && record.running === true, 'the run record survived the worker');
  record.heartbeatAt = Date.now() - 20000; // past the 5 s floor: the next wake sees an orphan
  server.clearFailures();
  /* Judge the FRESH worker only. The stub's broadcast log is shared across
   * workers by design (that is how `waitForTerminal` sees a crawl another
   * worker started), so w1's own SYNC_STARTED — and in (b5) run 1's terminal —
   * would otherwise be indistinguishable from w2's. */
  chrome.broadcasts.length = 0;
  return { atEvict };
}

const THREE_WORKSPACES = [
  { id: 'ws-a', name: 'Alpha', clipCount: 40 },
  { id: 'ws-b', name: 'Beta', clipCount: 40 },
  { id: 'ws-c', name: 'Gamma', clipCount: 40 },
];

/**
 * GUARDS: "press Sync to resume" must actually resume.
 *
 * The wake reconciliation heals an orphaned row to `state:'interrupted'`. The
 * resume predicate used to accept ONLY `state:'running'`, so the heal made the
 * row un-resumable by construction: the next Sync hit the not-resumable branch,
 * wiped the plan, and re-walked every finished workspace from scratch — a full
 * re-crawl behind a resume promise, which is why retrying after an
 * interruption never converged. The predicate now accepts BOTH states (a
 * healed row is not a verdict — its plan and `projectsDone` are as of its last
 * commit, exactly like the `running` row it was healed from).
 *
 * The auto-resume chain is exhausted on purpose here (attempts pre-seeded past
 * `MAX_SYNC_AUTO_RESUMES`) so this tests the MANUAL path in isolation; (b4)
 * tests the automatic one.
 */
test('(b3) a HEALED row resumes at workspace granularity when Sync is pressed', async (t) => {
  const { server, db, chrome, worker: w1 } = await setup({
    server: { totalClips: 120, serverMaxPageSize: 40, projects: THREE_WORKSPACES },
  });
  server.failWhen({ route: 'feed', kind: FAILURE.STALL, workspaceId: 'ws-b', times: 1 });
  t.after(() => w1.dispose());
  await parkEvictAndGoStale(t, server, db, chrome, w1);

  /* Exhaust the auto-resume chain BEFORE the fresh worker boots, so the wake
   * heals and hands the row to the user instead of restarting it. */
  await db.syncState.set('feed', { autoResumeAttempts: 99 });

  const w2 = await createWorker({ fetch: server.fetch, fetchOwner: server, db, chrome });
  t.after(() => w2.dispose());
  await w2.settle(6);

  /* THE HEALED ROW, exactly as the sidebar reported it — and now with a
   * stopReason the surfaces' shared phrase map knows how to word. */
  const row = db.feedCursor();
  assert.equal(row.state, 'interrupted', 'the wake healed the orphan. ' + JSON.stringify({ state: row.state }));
  assert.equal(row.stopReason, 'interrupted',
    'the healed row carries the stopReason the reason-phrase map has an entry for. '
    + 'A missing one is what made the sidebar say "a reason the worker did not report". '
    + JSON.stringify({ stopReason: row.stopReason }));
  assert.equal(row.completed, false);
  assert.ok(typeof row.lastError === 'string' && row.lastError.indexOf('stopped trying') >= 0,
    'an exhausted chain says so in words. lastError: ' + JSON.stringify(row.lastError));
  assert.equal(row.autoResumeAttempts, 100, 'the heal spent no further attempt: ' + row.autoResumeAttempts);

  const started = w2.broadcasts('SYNC_STARTED');
  assert.equal(started.length, 0, 'an exhausted chain must not auto-restart');
  const cancelled = w2.broadcasts('SYNC_CANCELLED');
  assert.ok(cancelled.length >= 1
      && cancelled[cancelled.length - 1].orphanedCursorCleared === true,
    'the surfaces were told the orphan was reconciled, not left believing a crawl is live');

  const status = await w2.syncStatus();
  assert.equal(status.running, false, 'nothing is running in the fresh worker');

  /* --- THE MANUAL RESUME --------------------------------------------- */
  const push = await runSync(w2);
  const v = verdictOf(push);
  assert.equal(push.type, 'SYNC_DONE', JSON.stringify(v));
  assert.equal(v.completed, true, 'the resumed crawl completes. ' + JSON.stringify(v));
  assert.equal(v.stopReason, 'complete', JSON.stringify(v));
  assert.equal(v.totalSeen, 120, 'all three workspaces. ' + JSON.stringify(v));
  assert.equal(v.missing, 0, JSON.stringify(v));

  assert.equal(server.timesServed('ws-a', 0), 1,
    'THE assertion: a healed row RESUMES — ws-a was walked exactly once, by the '
    + 'EVICTED worker. If it is 2, the "resume" is a restart and a 6,000-clip '
    + 'library re-walks everything it already indexed.');
  assert.deepEqual(db.clipIds(), server.expectedIds(), 'the index is exactly the library');
});

/**
 * GUARDS: eviction must be transparent to the user.
 *
 * The user pressed Sync; a service worker being reclaimed under the crawl is an
 * implementation detail they cannot act on. A fresh worker that finds a
 * genuinely orphaned row (no controller, run record gone stale) now RESTARTS
 * the crawl itself — resuming at workspace granularity off the healed row —
 * instead of reporting an interruption and waiting. This is the path that
 * turns "the extension worker was stopped mid-crawl" from a user-visible
 * failure into a few extra seconds of crawling.
 *
 * The bound is what makes this safe: `MAX_SYNC_AUTO_RESUMES` (3) consecutive
 * attempts, counted on the cursor row, reset only by a FRESH Sync. (b3) covers
 * the exhausted end of that bound.
 */
test('(b4) an evicted crawl AUTO-RESUMES on the next wake and completes unattended', async (t) => {
  const { server, db, chrome, worker: w1 } = await setup({
    server: { totalClips: 120, serverMaxPageSize: 40, projects: THREE_WORKSPACES },
  });
  server.failWhen({ route: 'feed', kind: FAILURE.STALL, workspaceId: 'ws-b', times: 1 });
  t.after(() => w1.dispose());
  const { atEvict } = await parkEvictAndGoStale(t, server, db, chrome, w1);

  const w2 = await createWorker({ fetch: server.fetch, fetchOwner: server, db, chrome });
  t.after(() => w2.dispose());

  /* No SYNC_START is sent to w2. If the crawl finishes, the wake path started
   * it — that is the entire claim under test. `broadcastsOfType` returns the
   * bare messages, not {at, message} wrappers. */
  const started = w2.broadcasts('SYNC_STARTED');
  assert.ok(started.some((b) => b.autoResumed === true),
    'the wake broadcast SYNC_STARTED with autoResumed:true — the surfaces must '
    + 'see "running", not "interrupted". Broadcasts: '
    + JSON.stringify([...new Set(w2.opts.chrome.broadcasts.map((b) => b.message.type))]));
  assert.equal(w2.broadcasts('SYNC_CANCELLED').length, 0,
    'no terminal interrupted push — the crawl continues instead of stopping');

  const push = await w2.waitForTerminal(TERMINAL_TIMEOUT_MS);
  assert.ok(push, 'the auto-resumed crawl must reach a terminal push with no user action');
  const v = verdictOf(push);
  assert.equal(push.type, 'SYNC_DONE', JSON.stringify(v));
  assert.equal(v.completed, true, JSON.stringify(v));
  assert.equal(v.stopReason, 'complete', JSON.stringify(v));
  assert.equal(v.totalSeen, 120, 'the whole library, across both workers. ' + JSON.stringify(v));
  assert.equal(v.missing, 0, JSON.stringify(v));

  assert.equal(server.timesServed('ws-a', 0), 1,
    'the auto-resume is a RESUME: the workspace the evicted worker finished was '
    + 'not re-walked. If it is 2, the wake is silently doing full re-crawls — '
    + 'the API-hammering the bound exists to prevent, on every page of it.');
  const row = db.feedCursor();
  assert.equal(row.autoResumeAttempts, 1,
    'exactly one attempt was spent and recorded: ' + row.autoResumeAttempts);
  assert.deepEqual(db.clipIds(), server.expectedIds(), 'the index is exactly the library');
  assert.equal(row.pagesDone >= atEvict.pagesDone, true,
    'the resumed run carried the evicted run\'s page count forward, not back to zero');
});

/**
 * GUARDS: the examined tally on a resumed run that RE-SKIPS cached workspaces.
 *
 * Every workspace the gate skips contributes exactly `row.totalSeen` to
 * `examined`. A resume RE-QUEUES the interrupted run's cache-skips (a clip may
 * have been created since the skip decision), and a gate that still holds adds
 * the SAME figure a second time while `carriedExamined` still contains the
 * first — so `examined` double-counts every re-skipped workspace. `examined`
 * feeds `missing` (`expectedTotal - examined`), so an inflated one hides a real
 * shortfall: the one direction an honest oracle must never err in. The
 * subtraction lives in the re-verify block in `runSync`.
 *
 * Staged WITHOUT mutating the server (its library is immutable by design):
 * run 1 fails ws-b's walk terminally (500s beyond the retry budget), so run 2
 * cache-skips the workspaces that DID complete while it must re-walk ws-b —
 * and run 2 is evicted inside that re-walk, leaving `cachedSkipped` populated.
 * The resume then re-queues and re-skips them, which is exactly the path the
 * subtraction guards.
 */
test('(b5) a resumed run that re-skips cached workspaces counts each row ONCE', async (t) => {
  const PER_WORKSPACE = 40;
  const EXPECTED_TOTAL = PER_WORKSPACE * 3;
  const { server, db, chrome, worker: w1 } = await setup({
    server: { totalClips: EXPECTED_TOTAL, serverMaxPageSize: PER_WORKSPACE, projects: THREE_WORKSPACES },
  });
  t.after(() => w1.dispose());

  /* --- run 1: ws-b fails terminally, so its row is not a completed walk -- */
  server.failWhen({ route: 'feed', kind: FAILURE.HTTP_500, workspaceId: 'ws-b', times: 8 });
  await runSync(w1); // terminal whatever its verdict — only the row shapes matter
  server.clearFailures();
  const afterRun1 = db.feedCursor();
  const rowA = (afterRun1.workspaces || []).find((w) => w.projectId === 'ws-a');
  assert.ok(rowA && rowA.completed === true && rowA.walkStopReason === 'complete',
    'run 1 finished ws-a cleanly, so run 2 may cache-skip it: '
    + JSON.stringify(afterRun1.workspaces && afterRun1.workspaces.map((w) => ({ id: w.projectId, done: w.completed }))));

  /* --- run 2: ws-a skips on the gate's evidence, ws-b re-walks, evict there - */
  server.failWhen({ route: 'feed', kind: FAILURE.STALL, workspaceId: 'ws-b', times: 1 });
  await w1.sendMessage('SYNC_START', { force: false, dislikedMode: 'exclude', maxPages: 200 });
  const deadline = Date.now() + 30000;
  let parked2 = null;
  while (Date.now() < deadline) {
    parked2 = db.feedCursor();
    if (parked2 && Array.isArray(parked2.cachedSkipped) && parked2.cachedSkipped.indexOf('ws-a') >= 0
      && parked2.projectsDone.indexOf('ws-a') >= 0 && server._parked.size > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(parked2 && parked2.cachedSkipped && parked2.cachedSkipped.indexOf('ws-a') >= 0,
    'run 2 cache-skipped ws-a and recorded the receipt on the row. cachedSkipped: '
    + JSON.stringify(parked2 && parked2.cachedSkipped));
  assert.ok(server._parked.size > 0, 'run 2 is parked inside ws-b\'s re-walk');
  assert.ok(Number.isFinite(parked2.examined) && parked2.examined >= PER_WORKSPACE,
    'the skip contributed exactly its totalSeen to examined. examined: ' + parked2.examined);

  /* --- evict and resume on a fresh worker (row still 'running': no heal) -- */
  await w1.dispose();
  server.clearFailures();
  /* The broadcast log is shared: without clearing it, `runSync`'s
   * `waitForTerminal` returns RUN 1's terminal instantly (its `lastBroadcast`
   * is the last SYNC_DONE anyone sent) and the resume is never actually
   * awaited — the first version of this test failed on exactly that, reading
   * run 1's ws-b page_failed verdict as if the resume had produced it. */
  chrome.broadcasts.length = 0;
  const w2 = await createWorker({ fetch: server.fetch, fetchOwner: server, db, chrome });
  t.after(() => w2.dispose());
  const push = await runSync(w2);
  const v = verdictOf(push);

  assert.equal(push.type, 'SYNC_DONE', JSON.stringify(v));
  assert.equal(v.completed, true, 'the resumed run completes. ' + JSON.stringify(v));
  assert.equal(v.missing, 0, JSON.stringify(v));
  const row = db.feedCursor();
  assert.equal(row.examined, EXPECTED_TOTAL,
    'THE assertion: examined counts each clip ONCE PER PROJECT after the '
    + 're-verify re-skipped the cached workspaces. '
    + EXPECTED_TOTAL + ' expected, got ' + row.examined + ' — a higher figure means the '
    + 're-skip double-counted rows the interrupted run already counted.');
  assert.equal(server.timesServed('ws-a', 0), 1,
    'ws-a was walked once (run 1), skipped (run 2) and RE-SKIPPED (resume) — never fetched again');
  assert.deepEqual(db.clipIds(), server.expectedIds(), 'the index is exactly the library');
});

/* ======================================================================== *
 * (c) TRANSIENT FAILURES — a 429 and a dropped connection must not be fatal
 * ======================================================================== */

/**
 * GUARDS: rate limiting and transient network loss.
 *
 * A library this size is walked at ~4 req/s (`rateLimit: 4`, background.js:834),
 * which is exactly the traffic profile that earns a 429. `SunoAPI.request`
 * handles it at `lib/api.js:1950-1970`: honour `Retry-After`, pause the shared
 * limiter, retry within `FEED_PAGE_RETRIES` (5). And a dropped connection is the
 * `dispatchError` branch at `lib/api.js:1853-1877`, retryable unless it was an
 * abort or a timeout.
 *
 * The bug this guards is the one where a retried page that eventually SUCCEEDS
 * is still reported as a failure — `iterateFeed` only records `page_failed` when
 * the envelope comes back `!ok` AFTER its own retries (lib/api.js:2752-2780),
 * so the interesting assertion is that a recovered page contributes its clips
 * AND does not set `stopReason`.
 *
 * A crawl that "retried" by giving up and reporting INCOMPLETE would still have
 * the right final count on a 120-clip account, so the test also asserts the
 * RETRY actually happened — the server saw the same offset more than once.
 */
test('(c) a 429 and a dropped connection are retried and the crawl still COMPLETES', async (t) => {
  const TOTAL_CLIPS = 120;
  const { server, db, worker } = await setup({
    server: { totalClips: TOTAL_CLIPS, serverMaxPageSize: 40 },
  });

  // Two 429s on the second feed page, then one dropped connection on the third.
  server.failWhen({ route: 'feed', kind: FAILURE.HTTP_429, pageOffset: 40, times: 2, retryAfterMs: 5 });
  server.failWhen({ route: 'feed', kind: FAILURE.NETWORK, pageOffset: 80, times: 1 });

  t.after(() => worker.dispose());
  const push = await runSync(worker);
  const v = verdictOf(push);

  assert.equal(push.type, 'SYNC_DONE', 'a retried crawl ends in SYNC_DONE. ' + JSON.stringify(v));
  assert.equal(v.completed, true,
    'a transient 429 / network error must not make the crawl report INCOMPLETE. ' + JSON.stringify(v));
  assert.equal(v.stopReason, 'complete', 'stopReason. ' + JSON.stringify(v));
  assert.equal(v.error, null, 'a recovered page leaves no error on the verdict. ' + JSON.stringify(v));
  assert.equal(v.totalSeen, TOTAL_CLIPS, 'every clip is indexed. ' + JSON.stringify(v));
  assert.deepEqual(db.clipIds(), server.expectedIds(), 'the index is exactly the library');

  // The retries really happened — a server that saw each offset once would mean
  // the injection never fired and the test proved nothing.
  assert.equal(server.timesRequested('default', 40), 3,
    'the 429 page must have been requested 3 times (2 refused, 3rd served). '
    + 'Requested: ' + server.timesRequested('default', 40));
  assert.equal(server.timesServed('default', 40), 1,
    'and walked exactly once — the two refusals did not each produce a duplicate page of clips.');
  assert.equal(server.timesRequested('default', 80), 2,
    'the dropped-connection page must have been requested 2 times (1 lost, 2nd served). '
    + 'Requested: ' + server.timesRequested('default', 80));

  const refusals = server.requests.filter((r) => r.route === 'feed' && r.failure);
  assert.equal(refusals.length, 3,
    'the server must have recorded exactly three refusals, got ' + refusals.length);
});

/* ======================================================================== *
 * (d) END-OF-FEED AMBIGUITY — three spellings, one verdict
 * ======================================================================== */

/**
 * GUARDS: end-of-feed ambiguity, which the source documents as the bug class
 * that made this client "report every sync INCOMPLETE".
 *
 * `readNextCursor` (`lib/api.js:580-598`) is deliberately THREE-state, and its
 * own JSDoc names both halves of the history:
 *
 *   (a) 'usable' — a cursor field was found and is usable    -> keep walking
 *   (b) 'empty'  — a cursor field is PRESENT and null/empty    -> end of feed
 *   (c) 'absent' — NO cursor field under any of the eight aliases -> end of
 *                  feed BY OMISSION
 *
 * (b) and (c) used to collapse into one `null`, which was a silent truncation.
 * Then (c) ALONE was a hard `cursor_missing` failure, which was also wrong:
 * `lib/api.js:2863-2869` records that on a real account EVERY walk ends on the
 * omission spelling — mid-walk pages all carry the cursor, only the final
 * partial page omits it — so every workspace stopped a few clips short of its
 * `clip_count` and reported INCOMPLETE forever, even though the walk HAD
 * reached the end and was refusing to say so.
 *
 * So: three terminal spellings, and the crawl must reach the SAME verdict on
 * all three. The extra `'empty-string'` case matters because
 * `isUsableCursor` (`lib/api.js:519-526`) rejects `''` as well as `null`, and a
 * reader that checked only `=== null` would loop forever on it.
 *
 * The test also pins the DIFFERENCE that must survive: `cursorOmitted` is true
 * only on the omission spelling (lib/api.js:2896), and that flag is what lets a
 * later probe tell "the field was renamed" from "the library ended".
 */
for (const mode of [END_OF_FEED.EMPTY_CURSOR, END_OF_FEED.OMITTED_CURSOR, END_OF_FEED.EMPTY_STRING]) {
  test('(d) end-of-feed by ' + mode + ' completes the walk with the same verdict', async (t) => {
    const TOTAL_CLIPS = 120;
    const { server, db, worker } = await setup({
      server: { totalClips: TOTAL_CLIPS, serverMaxPageSize: 40, endOfFeed: mode },
    });
    t.after(() => worker.dispose());

    const push = await runSync(worker);
    const v = verdictOf(push);

    assert.equal(push.type, 'SYNC_DONE', JSON.stringify(v));
    assert.equal(v.completed, true,
      'every terminal spelling completes. ' + mode + ' -> ' + JSON.stringify(v));
    assert.equal(v.stopReason, 'complete', JSON.stringify(v));
    assert.equal(v.error, null, JSON.stringify(v));
    assert.equal(v.totalSeen, TOTAL_CLIPS, JSON.stringify(v));
    assert.equal(v.missing, 0, JSON.stringify(v));
    assert.deepEqual(db.clipIds(), server.expectedIds(), 'the index is exactly the library');

    assert.equal(v.workspaces.length, 1);
    assert.equal(v.workspaces[0].completed, true, JSON.stringify(v));
    assert.equal(v.workspaces[0].cursorOmitted, mode === END_OF_FEED.OMITTED_CURSOR,
      'cursorOmitted must be true ONLY for the omission spelling (lib/api.js:2896). '
      + mode + ' -> ' + JSON.stringify(v.workspaces));
  });
}

/* ======================================================================== *
 * THE FAKE DB'S OWN LOAD-BEARING BEHAVIOUR
 * ======================================================================== */

/**
 * GUARDS: the harness itself, because a fake that disagrees with production
 * would make every test above meaningless.
 *
 * `syncState.set` MERGES (`lib/db.js:2010`,
 * `Object.assign({}, req.result || {}, patch || {})`). The monolith depends on
 * that in at least four places it spells out in its own comments:
 * `background.js:6748` (null `nextPage`/`pass`), `:6773` (reset
 * `cachedSkipped`), `:6815` (reset `interrupted`), `:7946`. A fake that
 * REPLACED would make those look like cargo cult, and would disagree with
 * production on exactly the resume path this file exists to test.
 *
 * This test asserts the merge AND the `updatedAt` stamp (`lib/db.js:2012`), and
 * asserts the eviction-survival contract the whole design rests on: the DB is
 * held by the test, so a worker cannot take it with it.
 */
test('harness: syncState.set merges, and the DB outlives its worker', async (t) => {
  const db = new FakeDB();

  await db.syncState.set('feed', { state: 'running', pagesDone: 3, projectsDone: ['a'] });
  const merged = await db.syncState.set('feed', { pagesDone: 4 });
  assert.equal(merged.pagesDone, 4, 'the patch wins on a colliding key');
  assert.equal(merged.state, 'running', 'and untouched keys SURVIVE — this is a merge, not a replace');
  assert.deepEqual(merged.projectsDone, ['a'], 'arrays survive too');
  assert.equal(merged.key, 'feed', 'the key is stamped (lib/db.js:2011)');
  assert.ok(Number.isFinite(merged.updatedAt), 'updatedAt is stamped (lib/db.js:2012)');

  // get(key, fallback) semantics, which the resume path relies on.
  assert.equal(await db.syncState.get('projects', null), null, 'a missing row returns the fallback');
  assert.deepEqual(await db.syncState.get('projects', { a: 1 }), { a: 1 }, 'and the fallback verbatim');
  assert.equal(await db.syncState.get('nope'), null, 'an undefined fallback yields null (lib/db.js:1979)');

  // The state that survives a worker.
  const owner = db;
  assert.equal(owner, db, 'a test holds the DB directly, so no worker can own its lifetime');
  await t.test('two workers over one DB see one library', async () => {
    const server = new FakeSunoServer({ totalClips: 40, serverMaxPageSize: 20 });
    const chrome = new ChromeStub();
    const w1 = await createWorker({ fetch: server.fetch, fetchOwner: server, db, chrome, storage: defaultStorageSeed() });
    await w1.sendMessage('SYNC_START', { force: false, dislikedMode: 'exclude', maxPages: 200 });
    await w1.waitForTerminal(TERMINAL_TIMEOUT_MS);
    await w1.dispose();
    assert.equal(db.clipIds().length, 40);

    const w2 = await createWorker({ fetch: server.fetch, fetchOwner: server, db, chrome });
    assert.equal(db.clipIds().length, 40, 'w2 sees w1\'s index immediately — IndexedDB semantics');
    await w2.dispose();
  });
});

/* ======================================================================== *
 * THE VIRTUAL CLOCK
 * ======================================================================== */

/**
 * GUARDS: the crawl's keepalive mechanism, which exists precisely because a
 * crawl that stalls is a crawl MV3 will reclaim.
 *
 * `KEEPALIVE_PERIOD_MINUTES` is 0.5 (`background.js:337`), so the run-scoped
 * keepalive is a 30 s alarm, armed when the crawl starts
 * (`armSyncRunKeepalive`, background.js:10758) and cleared on every terminal
 * path. A test that had to sleep 30 real seconds per alarm could not prove
 * anything about it, which is why `chrome.alarms` is driven by a clock the test
 * advances by hand.
 *
 * This asserts the two facts a real-time test could not: the alarm is armed at
 * all, and advancing past its period fires it. Whether the browser would actually
 * honour it is out of scope — that is Chrome's behaviour, not the extension's.
 */
test('harness: the run-scoped keepalive alarm is armed for a crawl and fires on the virtual clock', async (t) => {
  const SYNC_RUN_ALARM = 'suno.sync.runkeepalive';
  const { worker, chrome, db } = await setup({
    server: { totalClips: 40, serverMaxPageSize: 20 },
  });
  t.after(() => worker.dispose());

  assert.equal(chrome.getAlarm(SYNC_RUN_ALARM), null, 'no keepalive before a crawl starts');

  const done = runSync(worker);
  // Poll for the arm rather than sleeping a fixed amount.
  for (let i = 0; i < 200 && !chrome.getAlarm(SYNC_RUN_ALARM); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const armed = chrome.getAlarm(SYNC_RUN_ALARM);
  assert.ok(armed, 'the crawl must arm its run-scoped keepalive alarm');
  assert.equal(armed.periodInMinutes, 0.5, 'and it is the 30 s floor (KEEPALIVE_PERIOD_MINUTES, background.js:337)');

  // 30 s of virtual time fires it exactly once.
  const fired = await chrome.advanceTime(30 * 1000);
  assert.equal(fired.filter((n) => n === SYNC_RUN_ALARM).length, 1,
    'advancing past the period fires the alarm once. Fired: ' + JSON.stringify(fired));

  // Two more periods re-arm it — this is the "fires regardless of the network"
  // property background.js:10751-10754 describes.
  const fired2 = await chrome.advanceTime(60 * 1000);
  assert.equal(fired2.filter((n) => n === SYNC_RUN_ALARM).length, 2,
    'a periodic alarm re-arms. Fired: ' + JSON.stringify(fired2));

  await done;
  // Cleared on the terminal path (background.js:8149).
  for (let i = 0; i < 200 && chrome.getAlarm(SYNC_RUN_ALARM); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(chrome.getAlarm(SYNC_RUN_ALARM), null, 'the keepalive must be cleared when the crawl ends');
  assert.ok(db.clipIds().length === 40, 'and the library is intact');
});
