# TODO list

- Only the user can remove items. Models/Agenmts are allowed to freely refactor, reorganize, re-prioritize, but may not remove items done without the users explicit consent.
- Agent/Model is free to classify into priority list if deemed benefital alomngside refactoring to best suit the agents/models best practices.
- Use a standard ascii guide for items in progresss. completed, blocked, awaiting user decision, etc

# Items To Complete

- [ ] **[UI — P1] Sidebar stats should be clickable filter chips.** The sidebar's
  stats block currently reads as passive text:
  ```
  total 5951
  matched 5951
  liked 2103
  instrumental 60
  v5 2192
  v5.5 1300
  v4.5 873
  v6 558
  v4.5+ 347
  v4 286
  ```
  Make each line a TOGGLE BUTTON (chip) that filters what the download buttons
  will act on, composing with each other and with the search box:
  - `total` / `matched` are scope selectors (everything indexed / everything the
    current query matches); `liked` and `instrumental` are boolean facets;
    the model-version lines (`v5`, `v5.5`, `v4.5`, `v6`, `v4.5+`, `v4`) are
    single-select-with-multiples (click to include, click again to exclude or
    clear — the interaction should be obvious from the chip's own styling).
  - The chips must state what a download will act on: the count on the chip
    should become "X selected" while a filter is active, so a user can never
    fire a 2,000-file batch believing it was 55.
  - The facets already exist server-side — `GET_FACETS` computes them over the
    whole index (`side_panel.js` renders them at ~:1150), and the worker's
    QUERY engine already filters by model/liked/instrumental. This is wiring,
    not new engine work.
  - Regression to avoid: the triplicated dock state machine (the P2 refactor
    item below) means every surface must agree what "filtered" means — extract
    the shared filter-state core BEFORE adding a second consumer of it, or the
    sidebar will disagree with the popup the way the sync dock once did.

- [ ] **[UI — P1] Per-row download controls are nearly unusable.** Each row in
  the user's library view has two controls: a tri-state mark (blank → check →
  'x' → blank) and a per-row download icon. Reported behaviour, in the user's
  words: selecting multiple tracks with the overlay UI buttons is "quite
  clunky", it "appeared to not be working" but then downloaded at least some of
  the selection, and — worst — rows that finished downloading did not change
  state, so the user could not tell what was done or what was still pending.
  Fix as one item:
  - a row's download state must be VISIBLE and LIVE: pending / in-flight /
    done / failed, driven off the DL_ITEM pushes the worker already sends
    (`state.batch.items` in the content script already tracks per-clip state —
    the grid just does not render it);
  - the tri-state mark needs a single, obvious meaning (mark-for-download vs
    mark-to-exclude is not discoverable) and must not silently change meaning
    between surfaces;
  - multi-select needs shift/ctrl range selection and a visible running tally
    ("12 of 40 selected · 8 queued");
  - the appearance of failure-then-download must be explained: either the
    drawer was showing a stale stop notice (`renderBatchStop`) or the selection
    model diverged from what was sent — reproduce under the harness before
    touching the DOM.

- [ ] **[TESTING — P1] The download batch path is untested.** The sync crawl now
  has a behavioural harness (`tests/`, 13/13); the download batch driver has
  nothing. Before adding the facet-filter work above, extend the harness to
  cover the batch: plan → DOWNLOAD_START → DL_PROGRESS/DL_ITEM pushes →
  DL_DONE for the four terminal outcomes (`complete`, `cancelled`, `quota`,
  `ladder_exhausted`), plus a resumable batch interrupted by eviction and
  resumed by a fresh worker (the same shape as sync test (b)). The quota
  preflight refusal (stopped:'quota' with quotaShortfall, no batch started)
  must be pinned too — the popup's `reportQuotaShortfall` depends on its exact
  reply shape. The fake server already stubs media URLs; it needs a
  `downloads.onChanged` stub in `chrome-stub.js` to reconcile what the browser
  "did".

- [ ] **[PERF — P2] Search works but should get a local query/index layer.**
  Search is functional and not painfully slow today, but every query round-trips
  the worker, which filters over IndexedDB. Investigate a local index (an
  in-worker inverted index over the facets the QUERY engine already computes —
  model, liked, instrumental, workspace, date — with the full row fetched by
  id on hit) so a 6,000-clip library answers filter queries without a table
  scan. NOTE: Suno's own page console noise (Statsig multi-instance warnings,
  Stripe.js double-load, ably.net SSE drops, `blob:` 404s, and the 401 burst
  from `studio-api-prod.suno.com/*`) is the SITE's own traffic, not the
  extension's — do not chase it as part of this item; the 401 cluster is
  suno.com's page session expiring, which the extension's MAIN-world token tap
  handles independently.

- [ ] **[REFACTOR — P0] The SIP refactor program.** Every JS file in this
  project is a monolith — `background/background.js` ~11.3k lines,
  `content/content.js` ~5.1k, `popup/popup.js` ~3.4k, `lib/api.js` ~4.4k,
  `lib/db.js` ~2.9k, `side_panel.js` ~2.8k — which has produced exactly the
  failure mode the user describes: feature creep to the max, bugs that live in
  the seam between 4,000 lines of unrelated code, and users who cannot begin
  to report problems beyond "this UI element does this". This item is the
  program header; the P1/P2/P3 items below are its execution order:
  1. `[REFACTOR — P1]` decompose `background/background.js` (parts list below),
  2. `[REFACTOR — P2]` the triplicated sync-dock core, then
     `[REFACTOR — P2]` decompose `content/content.js`,
  3. `[REFACTOR — P3]` decompose `lib/`.
  THE GATE, non-negotiable: `npm run verify` (98 structural checks + the
  13-test behavioural harness) must be green after EVERY extraction, one part
  per commit, behaviour-preserving only. The harness is what makes this
  refactor verifiable rather than another unverifiable rewrite — the exact
  mistake that produced 20+ unverified fix iterations is to refactor without
  it.

- [ ] **[REFACTOR — P2] Triplicate sync-dock logic across three surfaces.** The same
  sync state machine is hand-written three times: `content/content.js` (the in-page
  overlay), `popup/popup.js` (toolbar mini-window), and `side_panel.js` (full panel).
  Only ~9 functions and 4 constant tables are genuinely shared; 13 of 26 symbols are
  content-only, and the rest have DIVERGED rather than stayed in sync.

  Known live divergences (each one is a latent cross-surface disagreement):
  - `SYNC_POLL_MS` is **2000** in `popup/popup.js:292` but **1500** in
    `content/content.js:2795` and `side_panel.js:2709` — so the three surfaces refresh
    on different cadences.
  - `SYNC_STOP_WAIT_MS` is renamed `SYNC_CANCEL_WAIT_MS` in the popup.
  - `SYNC_CONTROL` labels differ per surface: `{Sync, Stop sync}` in content and the
    panel, `{Sync library, Stop}` in the popup — so the three surfaces cannot agree on
    wording even when they agree on state.
  - `applySyncAuthority` is only ~74% shared popup↔panel and ~58% content; it diverges
    on whether/when `statusKnown` is set, which is precisely the flag that gates the
    duplicate-start guard.
  - `syncVerdict` is ~38% shared (content takes no args and reads `state.sync`; popup
    takes `(facts, sync)`), so the three surfaces can render different verdicts from
    the same worker reply.

  This is the structural cause behind bug #2 above: three copies of one state machine
  is exactly how the overlay came to disagree with the popup about whether a crawl
  was running. Extract ONE shared, single-intent module (`renderSync` /
  `applySyncAuthority` / `syncVerdict` / `syncView` / `countsPhrase` / the SYNC_*
  constant tables) consumed by all three surfaces, with each surface supplying only
  its own DOM wiring. Do this AFTER the crawl-completion bug is fixed and covered by
  the behavioural test harness, so the refactor is verifiable rather than another
  unverifiable rewrite.

- [ ] **[REFACTOR — P1] Decompose `background/background.js` (~11.3k lines, 500 KB).**
  Follow the extraction pattern that already exists and works: `background/parts/`
  holds `02-diagnostics`, `03-errors`, `06-messaging`, `08-filenames`, `14-query`,
  `15-quota`, each a single-intent file loaded via `importScripts`, each publishing
  onto one `SMU`-prefixed global, with load order and global-collision rules enforced
  by `scripts/check-build.sh`. The remaining monolith sections, as candidate parts
  (ONE intent per file):
  - `01-bootstrap.js` — the window alias, `importScripts` list, `resolveGlobal`, the
    lib/part health probes (`MISSING_LIBS` / `MISSING_PARTS`).
  - `04-settings.js` — defaults, migration, `chrome.storage.local` read/write.
  - `05-auth.js` — the Clerk JWT tap (MAIN-world `executeScript`, the auth-tap /
    auth-read round trip, the 12 s in-page wait, the 401-vs-expiry classification).
  - `07-offscreen.js` — offscreen document lifecycle.
  - `09-save.js` — saving bytes + reconciling what the browser did.
  - `10-batch.js` — the download batch driver (§12: resumable, isolated failures,
    quota-aware).
  - `11-sync-crawl.js` — the crawl itself: `runSync`, the workspace walk, page
    commits, the membership join.
  - `11b-sync-contract.js` — the verdict/contract layer: `syncContractView`,
    `cursorForWire`, `syncLiveness`, `syncEvictionVerdict`, the stopReason vocabulary.
  - `11c-sync-heal.js` — `reconcileStaleCursor`, `reconcileSyncRunOnWake`,
    `reconcileSyncRunOnBootstrap`, `clearSyncRun` — the read-path healers.
  - `11d-sync-keepalive.js` — `armSyncRunKeepalive`, the `SYNC_RUN` alarm, the
    run-record heartbeat.
  RULES (learned from this session, non-negotiable):
  - Behaviour-preserving ONLY. The behavioural harness (`tests/`, 10/10 green:
    full crawl, eviction + fresh worker over the same DB, 429 recovery, the three
    end-of-feed signals) is the gate — `npm test` must stay green after EVERY
    extraction, one part per commit.
  - A part must not CALL into the monolith at load time, only at call time (the
    existing `importScripts` rule, already enforced).
  - Every extraction lands with its health probe wired into `MISSING_PARTS` and the
    `check-build.sh` path/import list.
  - The three sync parts above (crawl / contract / heal / keepalive) are the
    highest-value split: the stale-`error` bug lived in the seam between the healers
    and the contract view, and that seam is currently 4,000 lines of unrelated code
    away from either of them.

- [ ] **[REFACTOR — P2] Decompose `content/content.js` (~5.1k lines).** The overlay
  is one file containing: the shadow-DOM shell/mount; the results grid + selection
  model; the filter panel; the sync dock (see the triplication item above — extract
  the dock's shared core first, then this file's own DOM wiring shrinks to a
  consumer); the download batch drawer; the projects/facets panels; the token relay.
  Candidate parts mirror the background's: `content/parts/dock-shell.js`,
  `results-grid.js`, `filter-panel.js`, `sync-dock.js`, `batch-drawer.js`. Same
  gating rule: harness green after every extraction.

- [ ] **[REFACTOR — P3] Decompose `lib/`.** `lib/api.js` (~4.4k lines) is at least
  three intents: the HTTP client + auth header handling; the pagination engines
  (`iterateFeed`, `fetchProjectFeed`, `fetchAllProjects` — the cursor/stop-signal
  rules that produced the end-of-feed fixes); the budget/filter helpers
  (`membershipPageBudget`, the disliked tri-state, the alias-tolerant cursor
  readers). `lib/db.js` (~2.9k) splits naturally along its five stores
  (`clips`, `downloads`, `syncState`, `journal`, `meta`) plus the connection
  pool/migration core. Lower priority than the background and content splits: these
  files are internally coherent, just large.

- [ ] **Overlay reports "1 clip match · 0 selected" on a fresh `/me` page.** With no
  search term and nothing selected, on a fresh suno.com/me library page, the page
  overlay dock reports:
  ```
  Suno Master
  running
  1 clip match · 0 selected
  ```
  The string is `renderCounts()` (`content/content.js:1937`) reading
  `state.results.total`, which comes from the worker's SEARCH reply
  (`refreshResults`, `content/content.js:1926`). So the worker answered `total: 1`
  (or one item, no total) for what should be an unfiltered query over ~5,943
  indexed clips. Suspects to check, in order:
  - persisted filter-panel state restored at mount (`schedulePersist` writes
    `state.filters`; a stale facet — liked-only, a project scope, a date range —
    is invisible in the count line and reads as "no filter" to the user);
  - the default `specForRequest()` shape vs what the worker's QUERY engine expects
    (a dropped/empty field meaning "match nothing" rather than "match all");
  - a search issued WHILE a crawl holds the DB (transaction visibility, or the
    force-rebuild window);
  - the worker returning `total` under a different key than the overlay reads, so
    `state.results.total` falls back to `items.length === 1`.
  The count line should also NAME the active filter when one is applied, so a
  filtered count can never masquerade as the whole library.

- [ ] **Sync Reports Incomplete:** In pop-up mini-window when clicking the extension icon the following is reported: 
```
Suno Master Utility
Refresh
Settings
Signed in. Session token valid for about 55m 11s more.
Clips indexed
5943
indexed locally
Library sync
Incomplete
the crawl finished cleanly (the extension worker was stopped mid-crawl (no page for 93s) — press Sync to resume; indexed clips are kept) · 5,939 of ~6,287 — a lower bound, filters applied
Downloads left
∞
no monthly cap
Credits
— / 7103
separate from downloads
Idle
—

Sync INCOMPLETE: 5,943 clips indexed in 4m 14s · The crawl finished cleanly (the extension worker was stopped mid-crawl (no page for 93s) — press Sync to resume; indexed clips are kept). · Indexed 5,939 of ~6,287 — a lower bound, filters applied
Indexed 5,939 of ~6,287 — a lower bound, filters applied against the count Suno reports for your account.
Sync library
Download everything…
Cancel
Open full panel
Activity
Clear
11:12:43
No library sync is running.
11:12:42
The walk did not finish: the crawl finished cleanly (the extension worker was stopped mid-crawl (no page for 93s) — press Sync to resume; indexed clips are kept).
11:12:42
Sync INCOMPLETE: 5,943 clips indexed in 4m 14s
11:10:33
sync phase: crawling
11:08:31
sync phase: mapping
11:08:27
sync phase: planning
11:08:27
Worker resolved feedPageLimit=100 maxPages=200
11:08:27
Sync started: 200 page cap, dislikedMode=exclude
11:08:27
Library sync started.
11:08:27
A library sync is running. It indexes your Suno feed and downloads nothing.
11:08:19
No library sync is running.
```
Thusly the sync does not complete

**[x] ROOT CAUSE FIXED** — the stale-field poisoning described below is repaired.
The fix is in `syncContractView` (`background.js` ~6619-6661), not only in the
healer, so it also repairs rows **already poisoned** in storage — the user's
account is in exactly that state, and nothing else could un-poison it:

1. `lastError` (written AND cleared by the run's own verdict) now **outranks**
   `error` (written by two healers, cleared by nothing).
2. A row with `completed:true` publishes **no error at all**.
3. `reconcileStaleCursor` now refuses to heal while `syncController` exists —
   checked INSIDE the function so every present and future caller inherits it
   rather than having to remember it.
4. Both healers (`reconcileStaleCursor`, `reconcileSyncRunOnWake`) now write
   `lastError`, so a healed row is recoverable by the next verdict.
5. `SYNC_STATUS` and `GET_BOOT` additionally guard the call site.
   NOTE: `cancelSync`'s call site was ALREADY guarded
   (`if (!syncController && stored && stored.state === 'running')`) — the earlier
   claim that all three were unguarded was wrong for that one, and no redundant
   guard was added.

**[x] FIXED AND TESTED — the resume half of the bug (this session).** The
behavioural harness (`tests/`, 13/13 green: `node --test tests/sync-crawl.test.js`)
now covers the eviction paths end to end, driving the REAL `background.js` over a
fake Suno server with opaque cursors:

- [x] **"Press Sync to resume" now resumes.** `resumable` accepts
  `state:'interrupted'` as well as `'running'` — a healed row is not a verdict;
  its plan and `projectsDone` are as of its last commit, identical in kind to the
  `'running'` row it was healed from. Verified by (b3): the manual Sync after a
  heal skips the finished workspaces instead of re-crawling them.
- [x] **Eviction is now self-healing, boundedly.** A fresh worker that finds a
  genuinely orphaned run (no controller, run record gone stale) RESTARTS the
  crawl itself, resuming at workspace granularity — at most
  `MAX_SYNC_AUTO_RESUMES` (3) consecutive times, counted on the cursor row and
  reset by the next fresh Sync; a stop the user asked for is never restarted;
  after the bound the row is healed to `interrupted` for manual action. Verified
  by (b4): the crawl completes unattended with no SYNC_START sent.
- [x] **The resumed tally double-count is fixed.** Carried
  `examined`/`uniqueSeen` are now summed per FINISHED workspace row, not read
  off the row's global figures (which include the in-flight workspace's
  committed pages, previously counted once in the carry and again in the
  re-walk — a resume parked one page in reported `totalSeen: 160` on a
  120-clip library). The cache-skip re-verify variant of the same bug is fixed
  with it. Verified by (b) and (b5).
- [x] **`freshCursor` now carries `error: null`**, so a stale healer string
  cannot survive a fresh run under the merge.
- [x] **`MAX_HONOURED_RETRY_AFTER_MS` is 60 s → 20 s**: a sleep in an MV3
  worker does not reset the idle timer, so a 60 s honour-sleep outlived the
  ~30 s eviction budget. 20 s keeps every backoff under it.
- [x] **Harness eviction is now faithful.** `dispose()` previously REJECTED the
  parked request; the crawl's retry loop caught that as an ordinary retryable
  network error and the "dead" worker finished its whole crawl after eviction,
  racing the fresh worker for the cursor row (this made the old (b) pass while
  testing nothing about resume, and made row assertions flip
  nondeterministically). Parked requests are now ABANDONED — never settled —
  which is what a real eviction looks like: the row keeps every write the dead
  worker made and not one more.

**STILL OPEN — smaller, each separable:**

- [ ] **`syncLiveness`'s false positive still exists.** The caller guards close
  the poisoning, and the wake path now auto-resumes, but any FUTURE reader of
  `syncLiveness` inherits it: a stall that commits no page for >90 s reads as
  dead even though the worker is alive. Fixing the rule (e.g. honouring the run
  record's heartbeat, which the alarm DOES refresh) removes the class rather
  than the instance.
- [ ] **`/api/project/feed` `type:"video"` rows are dropped silently** — no
  `clip` key, and `lib/api.js` discards them with a bare `continue`, so they are
  indistinguishable from "a feed that stopped early". Count and surface them.
- [ ] **Resume is workspace-granular, not cursor-granular.** `iterateFeed`
  accepts and ignores `startCursor`/`startPage` even though the worker records
  `cursor.cursors[projectId]` at each workspace end, so the IN-FLIGHT workspace
  re-walks from its first page on resume. Correct and tested, just not free;
  a future client that consumes the recorded cursor turns a re-walk into a
  continue.
- [ ] **The sidebar once rendered "a reason the worker did not report"** over a
  row that carried `stopReason:'interrupted'` and a shared phrase map that has
  an entry for it. The healed-row contract is now pinned by (b3), which asserts
  `stopReason:'interrupted'` reaches the row; if the phrasing fallback ever
  reappears in a surface, start from that test.

**DIAGNOSIS — CORRECTED. READ THIS BEFORE THE THREE ITEMS BELOW.**

An earlier revision of this file blamed MV3 worker eviction and the oracle
mismatch. **Eviction is NOT the cause.** The crawl *succeeds*: it writes
`completed:true`, `stopReason:'complete'` and a real `durationMs` (the "4m 14s"
in the report). It is then reported INCOMPLETE forever by a stale field.

**THE ACTUAL CAUSE — a read-path "heal" poisons the run record and nothing
ever clears it.**

1. `reconcileStaleCursor` (`background.js:8258-8272`) writes an **`error`** string
   into the LIVE cursor row. It is called from three READ paths — `SYNC_STATUS`
   (`:10085`), `GET_BOOT` (`:9792`), `cancelSync` (`:8387`) — and **none of them
   checks `syncController` first**, so it "heals" a crawl this same worker is
   still running.
2. The trigger is a false positive. `syncLiveness` (`:8214`) calls a row stale
   when no page has landed for >90 s (`SYNC_STALE_MS`, `:8191`). `heartbeatAt` is
   written only on page commit (`:7363`) and in `reportSyncPhase` (`:8319`); the
   run-scoped alarm deliberately does NOT write it (`:10834-10840`). So a
   rate-limit backoff that commits no page for 90 s trips the rule even though
   the worker is provably alive and firing its alarm.
3. `syncContractView` (`:6616-6619`) **prefers `error` over `lastError`**.
4. Nothing clears it. `DB.syncState.set` MERGES, and `freshCursor` (`:6736-6826`)
   has **no `error` key at all**, so a fresh run cannot wipe it. The success
   verdict at `:7942` clears `lastError` only.
5. `popup/popup.js:879` then pins the verdict:
   `kind = (completed === true && !f.error) ? 'complete' : 'incomplete'`.

The reported sentence says **"press Sync to *resume*"** — that word is the
fingerprint. `reconcileStaleCursor` (`:8266`) says "resume"; the wake path
`reconcileSyncRunOnWake` (`:8819-8822`) says "continue". So the writer was the
READ path, not the wake path.

**Two follow-on defects this exposes (still open):**
- **"Press Sync to resume" never resumes.** `resumable` requires
  `stored.state === 'running'` (`:6855-6857`), but every heal writes
  `state:'interrupted'` (`:8259`). The next start hits `Object.assign(cursor,
  freshCursor)` (`:6880-6888`), resets `projectsDone` (`:6877`) and re-walks every
  workspace from `cursor:null` — a full re-crawl. The UI promises a resume; the
  code performs a restart.
- **Resume cannot use a cursor at all.** `iterateFeed` accepts and explicitly
  ignores `startCursor`/`startPage` (`lib/api.js:2673-2679`), even though the
  worker dutifully records `cursor.cursors[projectId] = summary.nextCursor`
  (`:7507`). Resume is workspace-granular by construction.

**Also real, but NOT the cause of this symptom — independent, worth fixing:**
the oracle mismatch and the shared `maxPages` described in the two items below.
Oracle's note applies: the 348-clip gap here is the filtered-walk lower bound the
code already documents (`:6927-6980`), not a failure.
- [x] **Page Overlay/Menu Pop-up Difference/State Carry-over:**  When sync is running in the toolbar icon clicked pop-up dialog window/canvas the overlay interface drawn at the bottom of the window over the suno.com page does not carry-over the sync active status from the pop-up canvas/dialog. This means both can be activated by the user one-after-another/simutaniously.

**ROOT CAUSE: THIS WAS NOT A SEPARATE BUG — IT WAS BUG #3 (the `counts`
ReferenceError) MANIFESTING AS A UI FAILURE.**

The two symptoms looked unrelated but share one root cause. Inside
`renderSync()` the order of operations is:

```
3041  if (ui.truncWarn) {                        <- entered on EVERY render
3047    const detail = ui.truncWarn.querySelector('.sm-trunc-detail');
3051      counts ? 'Indexed ' + counts : ''       <- THREW ReferenceError
        }
3076  paintSyncControls(view);                   <- NEVER REACHED
```

`ui.truncWarn` is constructed unconditionally at mount (`content/content.js:1026`,
inserted at `:1093`) and carries only a visibility toggle (`.on` class, `:3074`) —
it is NEVER removed from the DOM. So the `if` at 3041 was always true, the
ReferenceError fired on every single render, and `paintSyncControls()` — the one
function that disables the Sync button while `state.sync.running` and re-enables it
when idle — never executed even once.

That is precisely the reported symptom: the overlay's Sync control was frozen at its
mount-time state, so it stayed live while a crawl started from the popup was running,
and the user could start a second one from the overlay.

The state PLUMBING was in fact already correct and is NOT the problem:
`content/content.js:4924` handles `SYNC_STARTED` / `SYNC_PROGRESS` /
`SYNC_CANCEL_REQUESTED` / `SYNC_CANCELLED` / `SYNC_DONE` / `SYNC_ERROR`, and
`pollSyncStatus()` (`:2731`) re-reads `SYNC_STATUS` on a 1500 ms poll. The data
arrived and was stored on `state.sync` correctly — it simply could not be painted,
because the render threw before it reached the painting step.

**FIX.** Same one-line hoist as bug #3 above. Both symptoms are resolved by it.
Verified: `node --check` clean and `scripts/check-build.sh` 98/98.
- [x] **Browser Error Caught:** An error reported by Brave browser (chrome fork) as follows:
```
Uncaught (in promise) ReferenceError: counts is not defined
Context
https://suno.com/auth/session-recovery?return_to=%2Fme
Stack Trace
content/content.js:3039 (anonymous function)
```

**ROOT CAUSE (found and fixed).** In `content/content.js` `renderSync()` the line
`const counts = verdict.counts;` was declared INSIDE the `else { ... }` branch that
paints the status line, but read again further down inside the `.sm-trunc-detail`
block, which sits OUTSIDE that branch. `const` is block-scoped, so that read was a
guaranteed `ReferenceError`.

It fired on **every render in which the truncation banner existed** — i.e. on exactly
the INCOMPLETE syncs the banner exists to explain. The overlay therefore threw while
reporting the failure, and the dock froze on its last good paint. That is why the
popup looked half-alive while a broken sync was in progress.

Note `popup/popup.js` and `side_panel.js` do NOT have this bug: their `counts` is
declared and read in the same scope (`popup/popup.js` reads `verdict.counts`
directly; `side_panel.js:818` and its read at `:829` share one scope).

**FIX.** Hoisted `const counts = verdict.counts;` to the top of `renderSync()`, beside
the `verdict` it derives from, so both the status line and the banner detail read the
same binding. Verified with `node --check` and `scripts/check-build.sh` (98/98).
```
Errors

Clear all
Uncaught (in promise) ReferenceError: counts is not defined
Context
https://suno.com/auth/session-recovery?return_to=%2Fme
Stack Trace
content/content.js:3039 (anonymous function)
...
2540
2541
2542
2543
2544
2545
2546
2547
2548
2549
2550
2551
2552
2553
2554
2555
2556
2557
2558
2559
2560
2561
2562
2563
2564
2565
2566
2567
2568
2569
2570
2571
2572
2573
2574
2575
2576
2577
2578
2579
2580
2581
2582
2583
2584
2585
2586
2587
2588
2589
2590
2591
2592
2593
2594
2595
2596
2597
2598
2599
2600
2601
2602
2603
2604
2605
2606
2607
2608
2609
2610
2611
2612
2613
2614
2615
2616
2617
2618
2619
2620
2621
2622
2623
2624
2625
2626
2627
2628
2629
2630
2631
2632
2633
2634
2635
2636
2637
2638
2639
2640
2641
2642
2643
2644
2645
2646
2647
2648
2649
2650
2651
2652
2653
2654
2655
2656
2657
2658
2659
2660
2661
2662
2663
2664
2665
2666
2667
2668
2669
2670
2671
2672
2673
2674
2675
2676
2677
2678
2679
2680
2681
2682
2683
2684
2685
2686
2687
2688
2689
2690
2691
2692
2693
2694
2695
2696
2697
2698
2699
2700
2701
2702
2703
2704
2705
2706
2707
2708
2709
2710
2711
2712
2713
2714
2715
2716
2717
2718
2719
2720
2721
2722
2723
2724
2725
2726
2727
2728
2729
2730
2731
2732
2733
2734
2735
2736
2737
2738
2739
2740
2741
2742
2743
2744
2745
2746
2747
2748
2749
2750
2751
2752
2753
2754
2755
2756
2757
2758
2759
2760
2761
2762
2763
2764
2765
2766
2767
2768
2769
2770
2771
2772
2773
2774
2775
2776
2777
2778
2779
2780
2781
2782
2783
2784
2785
2786
2787
2788
2789
2790
2791
2792
2793
2794
2795
2796
2797
2798
2799
2800
2801
2802
2803
2804
2805
2806
2807
2808
2809
2810
2811
2812
2813
2814
2815
2816
2817
2818
2819
2820
2821
2822
2823
2824
2825
2826
2827
2828
2829
2830
2831
2832
2833
2834
2835
2836
2837
2838
2839
2840
2841
2842
2843
2844
2845
2846
2847
2848
2849
2850
2851
2852
2853
2854
2855
2856
2857
2858
2859
2860
2861
2862
2863
2864
2865
2866
2867
2868
2869
2870
2871
2872
2873
2874
2875
2876
2877
2878
2879
2880
2881
2882
2883
2884
2885
2886
2887
2888
2889
2890
2891
2892
2893
2894
2895
2896
2897
2898
2899
2900
2901
2902
2903
2904
2905
2906
2907
2908
2909
2910
2911
2912
2913
2914
2915
2916
2917
2918
2919
2920
2921
2922
2923
2924
2925
2926
2927
2928
2929
2930
2931
2932
2933
2934
2935
2936
2937
2938
2939
2940
2941
2942
2943
2944
2945
2946
2947
2948
2949
2950
2951
2952
2953
2954
2955
2956
2957
2958
2959
2960
2961
2962
2963
2964
2965
2966
2967
2968
2969
2970
2971
2972
2973
2974
2975
2976
2977
2978
2979
2980
2981
2982
2983
2984
2985
2986
2987
2988
2989
2990
2991
2992
2993
2994
2995
2996
2997
2998
2999
3000
3001
3002
3003
3004
3005
3006
3007
3008
3009
3010
3011
3012
3013
3014
3015
3016
3017
3018
3019
3020
3021
3022
3023
3024
3025
3026
3027
3028
3029
3030
3031
3032
3033
3034
3035
3036
3037
3038
3039
3040
3041
3042
3043
3044
3045
3046
3047
3048
3049
3050
3051
3052
3053
3054
3055
3056
3057
3058
3059
3060
3061
3062
3063
3064
3065
3066
3067
3068
3069
3070
3071
3072
3073
3074
3075
3076
3077
3078
3079
3080
3081
3082
3083
3084
3085
3086
3087
3088
3089
3090
3091
3092
3093
3094
3095
3096
3097
3098
3099
3100
3101
3102
3103
3104
3105
3106
3107
3108
3109
3110
3111
3112
3113
3114
3115
3116
3117
3118
3119
3120
3121
3122
3123
3124
3125
3126
3127
3128
3129
3130
3131
3132
3133
3134
3135
3136
3137
3138
3139
3140
3141
3142
3143
3144
3145
3146
3147
3148
3149
3150
3151
3152
3153
3154
3155
3156
3157
3158
3159
3160
3161
3162
3163
3164
3165
3166
3167
3168
3169
3170
3171
3172
3173
3174
3175
3176
3177
3178
3179
3180
3181
3182
3183
3184
3185
3186
3187
3188
3189
3190
3191
3192
3193
3194
3195
3196
3197
3198
3199
3200
3201
3202
3203
3204
3205
3206
3207
3208
3209
3210
3211
3212
3213
3214
3215
3216
3217
3218
3219
3220
3221
3222
3223
3224
3225
3226
3227
3228
3229
3230
3231
3232
3233
3234
3235
3236
3237
3238
3239
3240
3241
3242
3243
3244
3245
3246
3247
3248
3249
3250
3251
3252
3253
3254
3255
3256
3257
3258
3259
3260
3261
3262
3263
3264
3265
3266
3267
3268
3269
3270
3271
3272
3273
3274
3275
3276
3277
3278
3279
3280
3281
3282
3283
3284
3285
3286
3287
3288
3289
3290
3291
3292
3293
3294
3295
3296
3297
3298
3299
3300
3301
3302
3303
3304
3305
3306
3307
3308
3309
3310
3311
3312
3313
3314
3315
3316
3317
3318
3319
3320
3321
3322
3323
3324
3325
3326
3327
3328
3329
3330
3331
3332
3333
3334
3335
3336
3337
3338
3339
3340
3341
3342
3343
3344
3345
3346
3347
3348
3349
3350
3351
3352
3353
3354
3355
3356
3357
3358
3359
3360
3361
3362
3363
3364
3365
3366
3367
3368
3369
3370
3371
3372
3373
3374
3375
3376
3377
3378
3379
3380
3381
3382
3383
3384
3385
3386
3387
3388
3389
3390
3391
3392
3393
3394
3395
3396
3397
3398
3399
3400
3401
3402
3403
3404
3405
3406
3407
3408
3409
3410
3411
3412
3413
3414
3415
3416
3417
3418
3419
3420
3421
3422
3423
3424
3425
3426
3427
3428
3429
3430
3431
3432
3433
3434
3435
3436
3437
3438
3439
3440
3441
3442
3443
3444
3445
3446
3447
3448
3449
3450
3451
3452
3453
3454
3455
3456
3457
3458
3459
3460
3461
3462
3463
3464
3465
3466
3467
3468
3469
3470
3471
3472
3473
3474
3475
3476
3477
3478
3479
3480
3481
3482
3483
3484
3485
3486
3487
3488
3489
3490
3491
3492
3493
3494
3495
3496
3497
3498
3499
3500
3501
3502
3503
3504
3505
3506
3507
3508
3509
3510
3511
3512
3513
3514
3515
3516
3517
3518
3519
3520
3521
3522
3523
3524
3525
3526
3527
3528
3529
3530
3531
3532
3533
3534
3535
3536
3537
3538
...
<2539 lines not shown>
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
<1575 lines not shown>
Uncaught (in promise) ReferenceError: counts is not defined
```

