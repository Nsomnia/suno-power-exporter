# Changelog

All notable changes to Suno Master Utility.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

---

## [6.2.0] — 2026-10-05

> *"Four hundred clips out of five thousand five hundred, and a green tick that
> meant it."*

### 🔥 Severity, stated plainly first

**The library crawl silently stopped at 400 clips on a ~5,500-clip account, and the
UI reported "Up to date".** Two independent bugs, stacked:

| | what the user saw | what was true |
|---|---|---|
| **the crawl** | 400 clips indexed, 20 pages, "Up to date" | ~5,100 clips were never requested. **Bulk download of the library was impossible**, and the one number that would have said so (`Suno reports ~5,500`) did not exist |
| **the UI** | "Up to date" — the green, cheerful word | the 20th page request had **failed**. `lastError` was set, and then discarded |

This is not a degraded feature and not an edge case. It is **the product's headline
capability returning a confident wrong answer**, on the exact account shape the
recon measured (Premier, 25 workspaces, ~5,500 clips).

### 🧨 Bug 1 — the endpoint was one version too old, and 0.1.0 already knew better

The crawl paginated `GET /api/feed/v2?hide_disliked=<bool>&page=<N>`. **Suno's web
app has never called that route.** Four independent pieces of evidence, none of
which required guessing:

1. **The shipped client does not use it.** The real thing POSTs
   `/api/feed/v3` with a body of `{cursor, limit, filters}` and follows
   `next_cursor` (`suno-recon/out/chunks/1r1sqgyc3uj2o.js:5`).
2. **It is absent from the entire bundle corpus and from every capture.**
   `/api/feed/v2` appears in **0 of 96** minified chunks. The only feed route in
   the whole recon capture log is `POST /api/feed/v3`
   (`scratchpad/captured_endpoints.txt:27`).
3. **Its own total was nonsense.** In one authenticated run, v2 page 0 returned
   `num_total_results: 21` and **20 clips** while `/api/project/me` on the same
   account, in the same session, reported `default` alone holding **3,444**
   (`suno-recon/out/authed/_api_feed_v2_hide_disliked_true_page_0.json` vs
   `_api_project_me.json`).
4. **Its page size is a fixed 20** — which is precisely why a 5,500-clip library
   came back as **20 pages and 400 clips**, arithmetically indistinguishable from
   a finished crawl.

> ### 🚨 This was a regression, and it is the single most useful sentence in this entry.
>
> **`legacy-1.0.0/extension/lib/api.js` and `lib/feed.js` already had the whole
> thing.** The 1.0.0 tree walked `POST /api/feed/v3` per workspace
> (`legacy-1.0.0/extension/lib/api.js:406-439` — `{cursor, limit, filters}`,
> `limit = 100` by default, `workspace: {presence:'True', workspaceId}`, and
> `disliked`/`trashed` normalised to the **strings** `"True"`/`"False"`). It
> carried a `has_more` / `next_cursor` / `num_total_results` state machine with
> `enforceExpectedTotal` (`legacy-1.0.0/extension/lib/feed.js:139`, `:180`,
> `:189-282`), detected a **repeated pagination token** twice — once before the
> request and once on the way out (`legacy-1.0.0/extension/lib/feed.js:588`,
> `:684`) — turned a `maxPages` overrun into an **error** rather than a finish
> (`:696`), paged `/api/project/me` per workspace with repeated-page detection
> (`legacy-1.0.0/extension/lib/api.js:247`), and reported the run as
> `partial` with one `complete` row per source and a flat `errors[]` list
> (`legacy-1.0.0/extension/lib/feed.js:716-735`) — which the 1.0.0 UI actually
> rendered as *"partial sync"* (`legacy-1.0.0/extension/controls/controls.js:89`,
> `:124`, `:546-547`).
>
> **The rewrite deleted every one of those and replaced it with a page counter on
> a legacy route.** Nothing about this was a discovery problem. It was a
> regression, discovered by reading the old tree.

### 💣 Bug 2 — a failed request was reported as success

Worth separating, because **fixing bug 1 alone would not have fixed the user's
report.** The walk did *not* stop early by any of its own rules. The page-20
request **failed**:

- the stall rule would have yielded 22 pages, not 20;
- the 200-page cap would have yielded 200;
- and an abort renders **"Cancelled"**, which nobody saw.

The failure set `lastError`, and then `background.js` mapped that state to
`state:'idle'` — which the popup renders as **"Up to date"**
(`syncVerdict`, `popup/popup.js:431-472`). `lastError` was only ever rendered on the
`state === 'error'` branch, **which a `break` never produces.**

> **The UI discarded the one piece of information that would have explained the
> failure.** Everything needed to say *"the index is incomplete, 400 of ~5,500,
> because page 21 failed"* was already in memory. The reporting layer threw it
> away and printed the opposite.

The feed page size was also annotated `// page size UNKNOWN` in the client and in
three documents, when the recon already held the capture that settles it: **v2 is
20, observed; v3's `limit` is settable to 100, the server maximum.**

### 🔁 The crawl now: `POST /api/feed/v3`, cursor-first, no query string

```
POST /api/feed/v3
body: { cursor, limit, filters }        // NO query string — a GET-shaped
                                        // ?page=N is the v2 bug wearing a new name
```

First request sends `cursor: null`; every later request sends the previous
response's `next_cursor` (`lib/api.js:2331-2340`). `limit` defaults to **100**,
the confirmed server maximum (`lib/api.js:149-153`; corroborated by
`scratchpad/extracted/BetterSuno/background.js:43` — *"`/api/feed/v3` rejects
limit > 100 (verified 2026-09)"*). The filter object is the bundle's own
vocabulary — `trashed`, `disliked`, `fromStudioProject`, `stem`,
`stemComplement`, `sort:{sortBy, sortDirection}`, `workspace:{presence,
workspaceId}` (`lib/api.js:2295-2308`) — and **`BooleanFilter` values are the
strings `"True"` / `"False"` / `"Any"`, never booleans** (`lib/api.js:167-179`).

### ✅ Completion is positive, or it is a machine-readable failure

A walk is `completed` **only** when the envelope is ok **and** `next_cursor` is
null **and** at least one page arrived. That check runs **first**, because a null
cursor is the terminal value, not a repeated one — a repeat check that ran before
it would flag every finished walk as stuck (`lib/api.js:2412-2423`). Everything
else is incomplete, with one of eight `stopReason` values
(`lib/api.js:2419-2481`):

| `stopReason` | means | never mistaken for |
|---|---|---|
| `page_failed` | a request failed after the page's own retries — 429/5xx/401 included | the end of the feed |
| `empty_page` | 0 clips arrived while a cursor was still offered — **the feed is unreadable from here** | an empty library |
| `stuck_cursor` | a `next_cursor` the walk already followed | a finish |
| `no_new_ids` | a page added **0 new clip ids** while the cursor advanced | a finish |
| `max_pages` | the per-workspace page cap with a cursor outstanding | a finish |
| `expected_total` | the feed said "done" and the oracle disagreed | a finish |
| `aborted` | you pressed Cancel | a failure |
| `complete` | the only positive signal | — |

`truncated` is now **defined as `!completed`**
(`lib/api.js:2488-2493`) rather than meaning only the `maxPages` case, and the
invariant *"`completed` may never be true next to a truncation or an error"* is
**asserted at the end of the walk**, not assumed (`lib/api.js:2514-2519`).

### 👎 Dislikes are a server-side filter now, so one walk answers the question

Suno still exposes **no per-clip dislike field**. The old build therefore walked
the library twice with `hide_disliked` flipped and reported the symmetric
difference. `/api/feed/v3` has a **tri-state `disliked: "True"|"False"|"Any"`
filter**, so one walk answers it and `is_disliked: boolean` is now stamped onto
every stored clip row (`commitPage`, `background/background.js:6680-6700`, the
stamp at `:6682`) — which makes the filter engine's existing `disliked` tri-state
filter **exact**.

This also killed a latent bug nobody had found: the two-pass shape **shared one
`maxPages` budget across both passes**, so pass B was silently truncated to
whatever pass A left over (`lib/api.js:2194-2202`).

`dislikedMode:'both'` is still two walks — `'False'` for the library, `'True'`
for the id set to stamp (`background/background.js:7002-7017`) — but it is two
ordinary walks with **no page-set differencing**, and the `'True'` walk runs with
the oracle **off**, because a disliked-only walk is legitimately far smaller than
the project's `clip_count` (`crawlWorkspace`'s `oracleFatal`, decided at
`background/background.js:6020-6035`).

> ### 🧮 In `both` mode the two phases were both feeding the completeness tallies,
> > so the number the user was shown described nothing.
>
> The `'True'` walk is a **different row set** of the same library — a subset of
> what phase 1 walked. It was writing into the *same* accumulators, so the run
> reported *"library rows + disliked rows"* examined against an `expectedTotal`
> that counts each clip once per project it lives in. `totalsMet` survived (more
> rows only made it easier to pass), so nothing looked broken — but
> **"X of ~Y" was meaningless in exactly that mode**, and the only reason it went
> unnoticed is that nobody read that number while `both` was selected.
>
> Phase 2 is now excluded from `examined` and from `uniqueSeen` entirely
> (`countsForOracle:false` reaches `afterPage` at
> `background/background.js:6781-6782` and is set at `:7016`); its ids go to
> `dislikedIds` only, which is what that walk exists for. **Phase 1 alone defines
> completeness.** The reasoning is recorded where the accumulators are declared
> (`background/background.js:6737-6755`).

### 🗂️ Per-workspace, with an oracle that makes a broken sync self-evidently wrong

The crawl now iterates **every project from `/api/project/me`**, `default` —
*"My Workspace"* — included, and forces it in if the list somehow arrives without
it (`buildWorkspacePlan`, `background/background.js:5937-5950`, rationale at
`:5923-5936`). That route is paged at 20 with
`num_total_results` as the count, and `fetchProjects()` read **page 1 only**
(`lib/api.js:2524-2532`): on the recon account that is **20 of 55 projects**, so
the previous build was walking 20 of 25-known workspaces and dropping whole
libraries. It is now paged to the advertised count, with a repeated-page check, a
page-mismatch check, and an incomplete-list verdict of its own
(`fetchAllProjects`, `background/background.js:5807-5921`).

Each project's own `clip_count` is the **completeness oracle**
(`lib/api.js:2556-2586`), and it is compared **per project, never against the
account-wide sum** — a short walk is not excused by a generous sibling. The
payoff is a headline sentence the UI can always say:

> ### **"400 indexed · Suno reports ~5,500"**
>
> **No log, no bug report, no support thread.** The numbers are already on screen,
> side by side, and they cannot both be right. That exact string is assembled at
> `content/content.js:2317-2327`.

**One failing workspace no longer aborts the rest.** It is reported **by name**,
with its own `stopReason`, in a `workspaces[]` row
(`crawlWorkspace`, `background/background.js:6017-6146`; the row shape is
`newWorkspaceOutcome`, `:5965-5983`).

### 📏 The oracle was comparing a FILTERED walk to an UNFILTERED count

The audit behind this entry found the defect **above** the shared-clip
double-count and it is worse, because it would have made the new crawl
permanently, permanently wrong on every account.

`project.clip_count` is a **project row count**. The walk is a **filtered
request**. On the default settings the crawl sends two filters that the row count
has no reason to share:

- `filters.trashed` is **`'False'`** on every walk — `includeTrashed` is hard
  `false` at the top of `runSync` (`background/background.js:6344`);
- `filters.disliked` is **`'False'`** for the default `dislikedMode:'exclude'`.

Nothing in the wire contract says `clip_count` omits trashed or disliked rows,
and if it does not — it is a count from the same store the feed filters — then
**every default-mode sync falls short by exactly trashed + disliked, forever**,
and tells the user to raise a page cap that was never reached. That is the same
*"looks broken forever"* shape the crawl rewrite exists to eliminate, arrived at
through the other door.

**Nobody could settle it from static reading.** So the comparison was made
**honest instead of fatal**:

| | before | now |
|---|---|---|
| a filtered walk with a shortfall | `completed:false`, `stopReason:'expected_total'`, **and the count handed to `iterateFeed`**, which would flip the client's own verdict too | `completed` stands on the walk's own evidence (an exhausted cursor, no failed page) |
| the shortfall itself | an `error` | still reported as `missing` — plus **`oracleApplied:false`** and a human sentence in **`advisory`** |
| the count | the oracle | **not handed to the client at all**, so it cannot become `expected_total` there |

`oracleApplied` is decided **once, up front**, and it is a single readable
expression (`background/background.js:6536-6555`):

```js
oracleApplied = includeTrashed === true && libraryWireFilter === 'Any';
```

Only a genuinely **unfiltered** walk may treat a shortfall as a failure.
`'Any'` is the string the *server* receives, not the mode key this file uses
internally, so the check is made on the wire value rather than on the mode
(`dislikedWireValue`, `background/background.js:6179`, rationale at
`:6163-6178`) — because "unfiltered" is a property of the request, not of the
setting name. The per-workspace half of the same rule is at
`background/background.js:6020-6035` and `:6074`.

**`advisory` is a new key and it is deliberately not `error`.** A lower bound is
not a failure, and painting one as an error is the bug the whole entry is about.
It is kept in its own field, published per row *and* run-wide, and all three
surfaces render it as a qualifier on the counts rather than as a failure:

```
5,501 of ~5,502 — a lower bound, filters applied
```

(`popup/popup.js:484-487`, `side_panel.js:344-346`,
`content/content.js:2055-2058`.)

A workspace whose `clipCount` is `null` — `default` forced into a plan whose
project list arrived without a count (`background/background.js:5946-5948`) — gets
`oracleApplied:false` and **no oracle at all**. It used to report
`completed:true` with no check whatsoever.

> ### 🎯 What would make the oracle fatal again. Write this down.
>
> **An authenticated capture, on an account holding at least one trashed clip and
> at least one disliked clip, showing that a project's `clip_count` is NOT greater
> than the number of rows an UNFILTERED `POST /api/feed/v3` walk returns for that
> same project** — i.e. that the count is the count of what the unfiltered feed
> returns.
>
> Then `includeTrashed:true` + `disliked:'Any'` makes the walk and the count
> measure the same set, `oracleApplied` becomes `true` for exactly that
> configuration (it is the expression above), and a shortfall becomes **proof**
> again. Until that capture exists, the default configuration cannot fail a sync
> on a number nobody can vouch for.
>
> The full statement is in the source at `background/background.js:6520-6529`.

⚠️ **This is a real, deliberate loss of a guarantee, and the extension is saying
so out loud.** With `oracleApplied:false` the sync can no longer *prove* a
shortfall — the advisory text is the only signal, and it is a statement about
**which number is trustworthy**, not a measurement. Before this change the
default sync failed loudly on every run; after it, it fails loudly only in the one
configuration that can be justified. That trade is recorded as
[`KNOWN-LIMITS` §26](docs/KNOWN-LIMITS.md).

### 📊 Three numbers, three names — and the collision that made the UIs invert a correct verdict

The worker computes `missing` against rows **examined**, and it must: the oracle
is the **SUM** of per-project `clip_count`, which counts a clip living in two
projects **twice** while the store holds it **once**. It then published the
**unique** count under the same key name, `totalSeen`.

All three surfaces then *re-derived* `missing = expectedTotal - totalSeen`
whenever the worker's `missing` came back as falsy. Consequence, exactly:

> 20 workspaces × 275 clips = `expectedTotal` **5502**. **One** clip lives in two
> workspaces, so 5,501 unique rows are on disk.
>
> | | |
> |---|---|
> | the worker said | `completed:true`, `missing:0` — **correct**, and it was checked against the examined count |
> | the popup computed | `5502 − 5501 = 1` |
> | the popup painted | **"Incomplete — 1 clip is missing"** — **permanently, on a crawl that was complete** |
>
> The dock contradicted *itself* on top of it: the banner was **hidden** (because
> `completed === true`) while the status line said **`INCOMPLETE`**.

**The rule now: `missing` is authoritative whenever the key is present as a
number, `0` included. It is derived only when the key is entirely absent** — the
legacy-reply case, where deriving from `examined` still says something truthful
instead of nothing. A present `0` and an absent key are now distinguished by
*presence*, in all three surfaces: `popup/popup.js:325-328` and `:337-338` and
`:363-372`, `side_panel.js:262-263` and `:283-289`,
`content/content.js:1968-1969` and `:1991-1999`.

> #### The root cause is worth naming, because the shape recurs.
>
> The worker's own reply builder had a `pick()` helper that selected a fallback
> whenever the value was **falsy**, so a present **`0`** was coerced to `null` —
> and "the worker did not tell us" became indistinguishable from "the worker told
> us zero". **A falsy check where a presence check belongs.** The same shape
> appears in this codebase at least four more times, and each of them is a bug
> waiting for a value that is legitimately `0`: `SYNC_STATUS`'s no-row reply, the
> `pick()` fold of `null` for `expectedTotal` (correct *there*, because
> `expectedTotal === 0` really is a sentinel), and the merge-sticky booleans.
> The reason it survived to release is that no test asserted a complete crawl
> renders as complete — **every** existing assertion was about the incomplete case.

So the contract emits, **identically** on `SYNC_DONE` (normal *and* abort), both
`SYNC_ERROR` paths, `GET_BOOT.sync` and `SYNC_STATUS`:

| field | meaning |
|---|---|
| `completed` | authoritative |
| `truncated` | derived, `=== !completed`, in the builder and nowhere else |
| `stopReason` · `error` | the walk's own vocabulary · redacted text, **never dropped** |
| `expectedTotal` | the summed oracle |
| **`totalSeen`** | **unique** clips indexed — what "5,501 of ~5,500" has to mean |
| **`uniqueSeen`** | the *same number* under its own name, so nothing has to guess which spelling a given reply used |
| **`examined`** | rows **walked**, repeats included — what `missing` is computed from |
| **`missing`** | `max(0, expectedTotal − examined)`, **authoritative when present, `0` included** |
| **`oracleApplied`** | was `missing` **checked** against the oracle, or merely **reported**? |
| **`advisory`** | why it was only reported, in words. Never an `error` |
| `workspaces[]` · `state` · `pagesDone` | one row per project · the four-value state · pages walked |

All of it comes from **one builder** (`syncContractView`,
`background/background.js:6273-6322`, the rationale at `:6232-6272`). Those were
six hand-written payload literals that had already drifted — the abort path
dropped `projectList`/`projectFeed`/`dislikedCount`, `SYNC_ERROR` dropped
`truncated`, so `truncated === !completed` was not even *checkable* everywhere. A
single builder makes the invariant structural instead of a convention someone has
to re-remember per literal.

### 🗣️ `SYNC_ERROR` was broadcasting the wrong half of the error

`SYNC_ERROR` published `info.message` — the **tail** of the failure list. The run
died on page 3 of workspace 12 after three workspaces had already failed, and the
one line the user reads named only the last of them: **the least useful one.**
It now carries `cursor.lastError`, the **accumulated** message, appended to
rather than replacing whatever the walk had already learned
(`background/background.js:7288-7290`, broadcast at `:7303-7310`) — the same
contract, and the same text `GET_BOOT.sync` shows afterwards. The outer net in
`startSync`, for a rejection from before `runSync`'s own `try`, carries the full
key set too, with zeros that say so honestly and an `advisory` naming why
(`background/background.js:5749-5783`).

### 💾 Resume is per-workspace, and that is a real trade-off

`syncState.feed` is written after **every page**
(`background/background.js:6781-6793`), so an evicted worker resumes instead of
restarting the crawl. But resume is at
**workspace granularity**: `iterateFeed` accepts **no `startCursor`** — it
accepts and explicitly ignores `startPage`, because v3 pagination is cursor-based
and "resume at page N" is not expressible (`lib/api.js:2233-2237`, `:2280-2286`).
Completed workspaces are skipped entirely; **the workspace that was in flight
restarts from `cursor:null`.**

That is safe — writes are additive and idempotent by clip id — but it is not
free, and the cursors *are* recorded per project
(`background/background.js:6911-6912`) so a future client that accepts a
`startCursor` can use them without another schema change.

A resumed run SKIPS the workspaces an evicted worker finished, so its
accumulators start where that worker left off — otherwise `examined` would
restart at `0` while the oracle still counts the whole library, and the resumed
run would refuse to call itself complete *precisely because it resumed*. The carry
reads `stored.examined` and `stored.uniqueSeen` **by their own names only**:
`stored.totalSeen` is deliberately **not** a fallback, because on a schema-2 row
it means rows-examined while on a schema-3 row it means unique clips, and
reading it as either without knowing which is how a resume invents a shortfall
(`background/background.js:6702-6727`).

#### 🧬 The cursor moved to schema **3**, and the reason is the collision above

Schema 2 stored **one** number under `totalSeen` (rows examined, repeats across
projects included) and a *different* one under `uniqueSeen`. Schema 3 stores the
**unique** count under `totalSeen` — so the stored row means what every reply
means — and the examined count under `examined`.

**A schema-2 row therefore carries a `totalSeen` whose meaning is the *opposite*
of a schema-3 row's**, and reading it as the unique count would resume with a
total larger than the library (*"4,600 of ~4,500"*). This is exactly what the
schema marker exists for, so it is used rather than silently reinterpreting an old
field: `SYNC_CURSOR_SCHEMA = 3` (`background/background.js:314-325`). Resumability
additionally requires a finite `stored.examined`, which is absent from every row
this build did not write, so a corrupt or hand-patched row restarts instead of
lying (`background/background.js:6445-6457`).

#### 💀 A dead `nextPage` field is gone from the wire, not just nulled

`nextPage` and `pass` are page-number-era fields. A cursor walk resumes at
**workspace** granularity, so **every value they could carry is useless** — and
`nextPage: 0` invites a reader to treat "page 0" as a position. They are now
stripped from every emitted reply (`cursorForWire`, `background/background.js:6212-6230`)
**and** explicitly nulled in the fresh cursor, because `DB.syncState.set`
**merges** its patch into the stored row: omitting a key leaves the legacy value
in place and the next write republishes it
(`background/background.js:6362-6369`, and `normaliseResumedCursor` at `:6205-6210`
because the schema check is one number and a partial write can invalidate it).

### 🗣️ The UI cannot lie again

`cursor.state` is `'idle'` **only** when `completed === true`
(`background/background.js:7163-7167`). Otherwise it is `'incomplete'` (the run
reached its verdict and the library on disk is short), `'error'` (the run broke),
or `'cancelled'`. `lastError` is **cleared in exactly one place** — where the
verdict is known — and never on a page that happened to succeed.

| surface | verdict | wording source |
|---|---|---|
| **popup** | `Up to date` / `Incomplete` / `Failed` / `Cancelled` / `Never` | `syncVerdict`, `popup/popup.js:431-472`; the tile word at `:883-886` |
| **side panel** | same verdict, same sentences | `paintBanner` / `bannerFacts`, `side_panel.js:379-390` and `:441-478` |
| **in-page dock** | same verdict, same sentences | `content/content.js:2256-2332` |

The **`stopReason` → English map is byte-identical in all three files**
(`popup/popup.js:263-272`, `side_panel.js:174-183`,
`content/content.js:1866-1877`) — a deliberate cross-file coupling, documented in
each. The banner's lead sentence is likewise one string reused for the visible
text, the hover title and the `aria-label` (`side_panel.js:470-477`), the tile
word is a `role="status" aria-live="polite"` node (`popup/popup.js:883-886`), and
**nothing anywhere relies on colour alone.** The dock builds the headline count
string in one place, with the reasoning in a comment above it —
`content/content.js:2317-2327`: *"400 indexed · Suno reports ~5,500" is the single
most valuable string this dock can show."*

**And the converse is now just as load-bearing as the original bug: the UI must
never call a *complete* crawl incomplete.** Not "probably won't". The popup's
verdict branch is `completed === true && !error && (missing === null || missing ≤
0)` (`popup/popup.js:451-452`), the side panel's banner is hidden outright on
`completed === true` (`side_panel.js:385`), and `missing` can no longer be
re-derived into a phantom shortfall. A number that is right in the pessimistic
direction is **still a lie** — it teaches the user to ignore the word.

The same contract now rides `SYNC_DONE` (`:7204-7218` and the abort path at
`:7265-7275`), `SYNC_ERROR` (`:7303-7310` and `:5763-5783`), `GET_BOOT.sync`
(`:7768-7815`) and `SYNC_STATUS` (`:7963-8016`) — including on the failure paths,
because "a reply that cannot say
`completed:false`" is exactly how a broken crawl gets rendered as up to date.

> **"Up to date" is now unfalsifiable over an incomplete library, and "Incomplete"
> is unfalsifiable over a complete one.** There is no code path that produces
> either. That symmetry is the actual property — a wrong answer in the cautious
> direction is still a wrong answer, and it is the direction that trains users to
> stop reading the word.

### 📕 Docs

- **`docs/ARCHITECTURE.md`** — the sync section rewritten around `/api/feed/v3`:
  the cursor contract, `limit ≤ 100`, the filter vocabulary with **string**
  tri-states, per-workspace iteration, the oracle, resume granularity and the full
  eight-value state machine. The two stale spots a worker agent flagged are fixed
  (`flushIdSets()` and `feed.baseIds`/`feed.seenIds`, all three deleted). The
  message-protocol rows and the file map are corrected against current source.
  The **sync-completeness contract table** now carries `examined`,
  `oracleApplied` and `advisory`; states the **`missing`-authoritative** rule; and
  carries the oracle's **scope** — why it is only fatal on a genuinely unfiltered
  walk, and the single observation that would re-arm it.
- **`docs/FILTERS.md`** — the **downvoted** section rewritten. It documented the
  two-pass symmetric difference as the mechanism; that is gone. The
  *"roughly doubles sync time"* warning is demoted from default advice to a note
  on the one mode that genuinely needs two walks.
- **`docs/RECON-NOTES.md`** — `/api/feed/v2` moves into **deliberately NOT built
  on**, with all three pieces of evidence, because it is a **do-not-build-on** item
  and it was sitting in the *verified* table. The *"feed page size UNKNOWN"*
  question is closed. `GET /api/clips/get_songs_by_ids` is promoted: its envelope
  is confirmed `{clips:[…]}` from the shipped client's own guard
  (`suno-recon/out/chunks/0zj00x725960e.js:3`), not "unknown". The
  `userId` vs `user_id` spelling conflict in the feed filter is recorded as an
  **unresolved** conflict rather than papered over.
- **`docs/KNOWN-LIMITS.md`** — old items 4 and 5 (feed page size unknown; dislikes
  need two crawls) removed or rewritten, and four honest new limits added:
  per-workspace resume cost, the **`oracleApplied` rule** (replacing the older and
  weaker "`expectedClipTotal` is a lower bound"), the summed-oracle double-count,
  and the standing note that `limit:100`, the accepted
  filter keys and v3's `num_total_results` semantics are **evidence-backed from
  the shipped bundle plus two third-party extensions, not live-verified** —
  **no authenticated capture of `POST /api/feed/v3` exists in the recon.** Item 26
  now also states the cost of the scoping change: with `oracleApplied:false` the
  sync **can no longer prove a shortfall**, so the advisory is the only signal.
- **`README.md`** — the install/quick-start now describes the real crawl (all
  workspaces, cursor-based), and *"400 indexed · Suno reports ~5,500"* is the
  headline example of the honesty property. **The converse is now stated too**:
  the UI must never call a *complete* crawl incomplete either, and that symmetry
  is the property, not the one-sided version.
- **`docs/DOWNLOAD-LADDER.md`** — 14 in-range citations re-anchored against current
  source after the worker and client grew; each had drifted onto a neighbouring
  statement (or, in the `lib/api.js` cases, into the middle of the `RateLimiter`).
- **`MIGRATION.md`** — §4 described `lib/api.js#iterateFeed` as a *page-integer*
  feed on `{ hide_disliked, page }` terminating on an empty-page streak. That
  describes the crawl as it stood at 6.0.1 and is **not** the current build. It is
  a historical migration record, so the *description* is corrected and a dated
  note records that the route changed again at 6.2.0 — the history is not
  rewritten.

### The 6.1.1 → 6.2.0 relationship, stated plainly

**6.2.0 is corrective. Nothing 6.1.1 fixed is reverted.**

- The auth ladder, the `auth-tap`, the MAIN-world allowlist and the HLS
  patch/restore are **untouched**. Nothing in this entry executes in a page.
- Both vendored encoders stay at the same bytes and the same SHA-256s. Nothing in
  this fix touches `vendor/`.
- `syncMaxPages`, `dislikedMode`, the ladder's seven rungs and every quota semantic
  are unchanged. What changed is **what a page of the crawl means** and **what the
  UI is allowed to claim about it.**
- **One thing is genuinely better than it was:** a library crawl can now fail
  *visibly*. Before this entry, the worst outcome was a green tick.

> ⚠️ **`manifest.json` jumps `6.1.0` → `6.2.0`, so the 6.1.1 entry never had a
> version stamp of its own.** Its note recorded that the bump was owed; this entry
> discharges that debt at `6.2.0` rather than shipping a `6.1.1` build. The
> sign-in fix described in 6.1.1 is in this build.

---

## [6.1.1] — 2026-10-05

> *"Nothing in this extension worked at all, and the reason was a helper that
> reported success without checking."*

### 🔥 Severity, stated plainly first

**Sign-in was completely non-functional in 6.1.0.** Every authenticated call the
extension makes — the library crawl, the quota read, every rung of the ladder that
goes through Suno's API — needed a Clerk JWT, and no JWT could be minted. The user
was signed in on suno.com in the same profile and the extension still said:

> *Not signed in. Open suno.com in a tab and sign in — click here to open it.*

This was not a degraded feature. It was **a total outage of every capability in the
extension**, shipped in a release whose own changelog entry was about adding two
audio encoders.

It survived two releases because the symptom is *absence*. Nothing threw. Nothing
logged an error. The UI rendered, the filters worked, the download button was
enabled, and pressing it produced "no Clerk JWT available; authenticated call not
attempted" — which reads as a signed-out user, not as a bug.

### 🧨 The root cause: an injection helper that reported success without verifying anything

`suno.com` ships a Content Security Policy with **no `'unsafe-inline'`**:

```
script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:* chrome-extension://…/
```

Every page load, every user saw:

```
Executing inline script violates the following Content Security Policy directive …
Context: https://suno.com/discover
```

The old content script built a `<script>`, assigned `.textContent`, appended it to
`document.head`, and returned `true`. **The append succeeded. The execution was
refused.** The CSP violation is reported afterwards, on the console, out of band —
and the helper had already returned success.

That is the whole bug in one shape: **`appendChild` returning without throwing says
nothing about whether the script ran.** Three consequences, and only the first is
obvious:

| | what was dead | how it failed |
|---|---|---|
| **HLS capture** | `window.MediaSource` never patched → no `manifest.m3u8` ever appeared | **100% dead.** `runHlsCapture` polled for 20 s (`content/content.js:2925`) and then failed with *"no manifest appeared"*, which blamed the player instead of the patch |
| **The HLS restore** | the `finally` restore never ran either | **Also dead, and it is the safety-critical half.** Had a patch ever landed, Suno's own player would have been left with `MediaSource` destroyed — a page the user cannot play audio on, and the one failure mode nobody would think to report |
| **The page token reader** | the `window.Clerk` read never ran | `requestPageToken()` was a no-op that returned success |

**The general lesson, and it is the reason this entry is long:** under a CSP you do
not control, "did it run?" can never be inferred from the absence of an exception.
It has to be answered by **reading state back**. Every operation in this fix now
does — `window.fetch === wrappedFetch`, `XHR.prototype.open === wrappedOpen`,
`window.MediaSource === undefined` — and a result that cannot be confirmed is
reported as a failure (`background/background.js:2252`, `:2289`, `:2296`, `:2556`).

There is no way to make inline injection work from a content script, and the page's
CSP is not to be worked around. The route changed instead.

### 🕳️ Sign-in, three links deep

The CSP bug was necessary but not sufficient. Even with a working MAIN-world
channel, sign-in was broken — by three separate defects stacked on top of each
other, each of which had to be fixed for anything to work:

1. **The worker probed once, at the worst possible moment.** It made a single
   `chrome.scripting.executeScript({world:'MAIN'})` call with
   `injectImmediately: true`, i.e. at **document-start**, read `window.Clerk`,
   found `undefined` — Clerk has not constructed its instance that early — and
   **there was no retry.** A single un-waiting probe can only ever lose that race.
2. **The fallback was aimed at a message nobody handled.** It sent
   `SUNO_TOKEN_REQUEST` to content scripts. `content/content.js` **never had that
   handler and never could have had one**: reading `window.Clerk` from a content
   script requires exactly the inline `<script>` that bug 1 had killed. Dead at
   both ends. The worker's waiter map is gone entirely, and why is recorded in
   place at `background/background.js:1426-1438`.
3. **The HTTP client gave up before it started.** `lib/api.js` raised
   `missing_token` **before the attempt loop**, so a null on the first probe ended
   the request with **zero HTTP attempts and zero further token acquisitions**. A
   token that appeared one second later was, from the client's point of view,
   indistinguishable from one that never would.

> Record the chain, not just the patch. **One defect is a bug; three stacked
> defects each hiding behind the others is why this shipped.** Any of the three
> alone would have produced the same user report.

### 🪜 How auth works now: a layered ladder, cheapest first

`mintAuthToken` (`background/background.js:1705-1830`) walks four rungs and the
first non-empty token wins:

| | rung | cost | why it is here |
|---|---|---|---|
| **a** | `auth-read` | one instant MAIN-world call | the header tap's captured token. No page dependency, and once the tap is installed a working tab **never reaches (c)** |
| **b** | `auth-tap` → `auth-read` | one injection, idempotent | installs the tap if the content script never mounted, then reads it. Re-installing over an existing tap is a cheap no-op |
| **c** | `clerk-token`, **~12 s** | up to 12 seconds | **this is the fix for the document-start race.** It polls for `window.Clerk` *inside the page*, so "not loaded yet" is no longer a verdict |
| **d** | `auth-read` | one instant call | the page may well have made an authenticated request while (c) was waiting |

The expensive wait is **third, not first**, because (a) and (b) have already
answered or proved they cannot. `CLERK_WAIT_DEFAULT_MS = 12000`
(`background/background.js:275`), clamped to 500–30,000 ms for a caller-supplied
value (`:278-279`, coerced at `:2697`). The op reports `{waitedMs, hasClerk}` so
"Clerk never appeared" is distinguishable from "Clerk was there and `getToken()`
never settled" (`background/background.js:2414-2426`).

### 👂 `auth-tap`: the idea that actually works

Rather than depending on `window.Clerk` being a page global — **which nobody has
ever confirmed for suno.com**, and which is exactly why the working third-party
extensions in `scratchpad/extracted/` intercept the header instead — the tap
passively observes the `Authorization: Bearer <jwt>` header off **Suno's own**
`fetch` and `XMLHttpRequest` calls (`mainWorldAuthTap`,
`background/background.js:2082-2311`). Three guarantees, all structural rather
than promised:

- **Read-only.** Nothing is added to, removed from or rewritten on any request.
- **Always calls through.** The inspection is individually wrapped, and the
  original is *always* invoked — a detached `fetch` call still gets `window`
  passed as its receiver (`:2244`). If any inspection throws, the request happens
  exactly as it would have without us. The wrappers cannot alter, delay, reorder
  or block a request, and cannot throw into the page's call.
- **At-most-once wrapping.** `window.__smAuthTap` is written **before** any hook
  is installed (`:2213-2228`), so a second call can never double-wrap `fetch` or
  `XMLHttpRequest.prototype` even if the first call died part-way. A double-wrap is
  a permanent, unbounded page regression; a partial install is merely *reported*.
  Each hook's outcome is verified by reading the property back (`:2252`, `:2289`,
  `:2296`), so "installed" is never assumed.

The token lives in a closure and is reachable only through the holder's `read()`
getter. **Stated rather than implied away:** that holder lives on `window`, so any
script the page itself runs can read the captured value. That grants a same-origin
page script nothing it does not already have — the JWT is already in the page's
memory and in every outgoing header — and this build sends it nowhere except the
worker, which stores it in `chrome.storage.session`.

### 🧭 MAIN-world access moved into the worker

A new route, `RUN_MAIN_WORLD` (`background/background.js:6537-6539`, body at
`:2750-2778`), is the **only** thing in this build that executes code in a page:

- **No code string, ever.** The op is resolved by **exact key** from a frozen
  six-entry map, `MAIN_WORLD_OPS` (`:2649-2656`), via
  `Object.prototype.hasOwnProperty` so `constructor` and `toString` cannot resolve
  to something. There is no `eval`, no `new Function` and no string-to-function
  path — MV3's `script-src 'self'` forbids all of them anyway.
- **Six ops, no more:** `probe`, `auth-tap`, `auth-read`, `clerk-token`,
  `hls-patch`, `hls-restore`. Published as `mainWorldOps` on `GET_DIAGNOSTICS`
  (`:6516`) so "what probes exist" is answerable from one reply.
- **The tab is the caller's own**, resolved from `sender.tab.id` (`:2753`), not
  guessed. An extension page has no `sender.tab` and is refused with `no_tab` —
  which is correct: the worker drives its *other* tabs through `injectMainWorldOp`
  directly, because a mint has to be able to reach a Suno tab the caller is not
  sitting in.
- The `mainWorldOp` wrapper in `content/content.js:2842-2860` verifies the reply
  rather than trusting it: `ok:true` with no `result` means the injection never
  ran; a non-empty `result.error` means it ran and failed. Both return `{ok:false}`
  with the reason surfaced.

**"Not signed in" is now answerable instead of guessable.** `lastAuthFailure`
(`background/background.js:1818-1828`, `:2793`) records which op was reached, what
each op returned, and the tab ids tried — and never any token material.
`GET_DIAGNOSTICS` returns it (`:6517`).

### 🧹 The tap is installed before the first mint, on purpose

`mount()` installs the tap **immediately after `REGISTER_TAB` and before
`GET_BOOT`** (`content/content.js:3335-3362`). Minting before the tap exists is
precisely how a plainly-signed-in user ends up reading "no Clerk JWT available":
the calls that trigger a mint are the very calls that had no token yet. One eager
`auth-read` then hands the worker whatever the tap already has via `SET_TOKEN`
(`:3364-3391`), so the worker holds a token before it needs one instead of minting
on the critical path. A **tap failure is logged and does not abort mounting** — a
dock that refuses to appear because an auth helper is unhappy is strictly worse
than a dock with no tap.

A quiet `GET_TOKEN_STATUS` re-read closes the mount (`:3424-3428`), because the tap
only sees a token when Suno makes an authenticated request, which happens at its
own pace.

### 🔁 The client stopped giving up early

- **One forced re-acquisition on `missing_token`, with no extra HTTP attempt**
  (`lib/api.js:1383-1419`, helper at `:1721-1734`). A request with no bearer token
  must never reach the network, so neither branch adds an attempt — this buys a
  second chance at the credential without spending anything. The wait in front of
  it is 750 ms capped at half the caller's own timeout (`:101`, `:103`), because an
  immediate re-probe issued in the same tick reproduces the same null.
- **The error message is actionable now**
  (`lib/api.js:116-120`): *"Open suno.com, sign in, reload that tab, then press
  Refresh to retry."* The old wording was accurate and read as "you are not logged
  in", which gave the user nothing to do. The `code` is load-bearing — the worker
  branches on `missing_token` in four places — so only the prose changed.
- **`tokenExpired` no longer reports `true` when no token was ever obtained**
  (`lib/api.js:1251-1266`). `isTokenExpired()` deliberately folds "nothing was ever
  obtained" into `true`, which is correct on the 401 path; as a *report* on a
  `missing_token` it was the opposite of the truth, and "your session expired" is
  not what happened when there was never a session to expire.
- The page-side recursion is gone (`content/content.js:3187-3198`): with the relay
  retired, the old `requestPageToken()` was just `refreshToken()`, so it called
  itself until the tab went unresponsive.

### 🧯 Four latent defects found *during* the fix, recorded because they recur

1. **A half-applied edit killed the panel again.** `mount()` still called the
   deleted `setupTokenRelay()` and still referenced the deleted `clerkTried`, so it
   threw **before** `GET_BOOT` — the dock never finished mounting. This is the
   failure class 6.0.1 was written about, in its purest form: a partial edit that
   compiles, loads, and is invisible until the panel is missing.
2. **`refreshToken()` and `requestPageToken()` recursed into each other** in an
   unbounded `send()` loop, showing the same "no token" answer forever while
   spinning the message channel. Two functions that are aliases of each other
   cannot also call each other.
3. **`resolveTokenRelay` was called where the function no longer existed.** The
   `SET_TOKEN` handler still had a `payload.requestId` branch invoking it, and the
   function was not defined anywhere in the file — so **any** caller sending a
   `requestId` would have thrown a `ReferenceError` and died before storing the
   token or broadcasting anything. The branch is removed and the reason recorded in
   place (`background/background.js:6551-6558`); the one real caller sends no
   `requestId`, which is exactly why it never surfaced.
4. **The MAIN-world patch reported `patched: true` when it had done nothing.**
   Assigning to a non-writable `window.MediaSource` is a **silent no-op in sloppy
   mode**, so the first version of the fix would have repeated the original lie in
   a new place. It now reads the property back and reports a patch error when the
   write did not land (`background/background.js:2631-2641`).

> Defect 4 is the one worth remembering. **The CSP bug and the non-writable
> property are the same bug**: an operation that cannot report its own failure will
> report success, and the only cure is reading state back. That principle now
> governs every page-side operation in this build.

### 📕 Docs

- **`docs/ARCHITECTURE.md`**: new **MAIN-world access** subsection and a new § on
  the auth ladder, `RUN_MAIN_WORLD` added to the protocol table with all six ops,
  and the token-acquisition section rewritten — it still described inline
  `<script>` injection from a content script and a `window.Clerk` relay, neither of
  which exists.
- **`docs/KNOWN-LIMITS.md`**: new items recording that **`window.Clerk`'s
  availability on suno.com is unverified**, that the tap needs the page to make at
  least one authenticated request, that a full reload loses it (and reinstalls),
  and that it *is* page tampering however passive.
- **`docs/DOWNLOAD-LADDER.md`**: the `hls` section said "manipulates Suno's page"
  and left the reader to assume it worked. It did not work at all — the patch never
  landed — and that is now stated, along with the verified patch result and the
  loud failed-restore path.
- **`README.md`**: the install step said the extension "mints its Clerk JWT from the
  page", which was true and useless; it now describes the ladder.

> ⚠️ **`manifest.json` shipped at `"version": "6.1.0"` /
> `"version_name": "6.1.0 - MP3/OGG ship via vendored encoders; clamp lifted,
> mp3Bitrate/oggQuality added, U+FFFF load-blocker fixed"`**
> (`manifest.json:80-81` at the time). **This entry is 6.1.1 and the manifest was
> not bumped to match.** `manifest.json` is a source file and was not in scope for
> this pass, so the bump was owed in a follow-up. Unlike the 6.1.0 entry, this note
> shipped **before** the bump rather than with it.
>
> ✅ **Resolved in 6.2.0** — and discharged as **`6.2.0`, not `6.1.1`**. The
> manifest went `6.1.0` → `6.2.0` directly, so **no build was ever stamped 6.1.1**
> and this entry describes code that shipped inside 6.2.0.

### The 6.1.0 → 6.1.1 relationship, stated plainly

**6.1.1 is a patch: corrective only, and nothing 6.1.0 shipped is reverted.**

- Both vendored encoders stay exactly as they were, at the same bytes and the same
  SHA-256s. Nothing in this fix touches `vendor/`.
- `transcode` still admits all four values; `mp3Bitrate` and `oggQuality` are
  unchanged; the ladder is still seven rungs with the same cost classes.
- The fix is confined to how the worker reaches a page, how it obtains a token, and
  how the client reacts to a missing one. The download pipeline is untouched apart
  from HLS's patch/restore now being **verified** instead of assumed.
- **One thing is genuinely better than it was:** the `hls` rung is no longer a
  feature whose failure mode was invisible. It either patches the page, or it says
  it did not.

---

## [6.1.0] — 2026-10-05

> *"The number one limitation is gone, and two bugs were hiding behind it."*

### 🎉 The story worth telling

6.0.1 closed with a loud, honest gap at the top of `KNOWN-LIMITS.md`: **MP3 and OGG
output did not exist in this build.** Not "were rough", not "were untested" — the
encoders were not in the repository, and the docs said so in four places.

This release ships them. `vendor/lame.all.js` and `vendor/OggVorbisEncoder.js` are
committed, **byte-identical to upstream**, with their licence notices, a provenance
record, and a SHA-256 gate that keeps all three honest.

But the interesting part is not the 2.8 MB. It is what was *behind* the gap:

- **`lib/db.js` contained a raw `U+FFFF` non-character that Chrome refused to
  load.** It was valid UTF-8 by every standard definition. It was the standard
  IndexedDB prefix-range upper-bound sentinel — the one character in the file that
  a Unicode tool cannot help but accept.
- **The Ogg encode loop was written against lamejs's API, and
  `OggVorbisEncoder` does not have one.** Every OGG request would have thrown a
  `TypeError`.

Both were invisible while the encoders were absent, because nothing could reach
them. Lifting the limitation exposed them.

### 🔤 The `U+FFFF` load-blocker

Chrome refused to load the extension at all:

> *Could not load file 'lib/db.js' for content script. It isn't UTF-8 encoded.*

The cause was a **single raw `U+FFFF` non-character** at `lib/db.js:1382` — the
upper bound of the `title_lower` prefix range built by `clips.searchTitle`:

```js
: KR.bound(lower, lower + '￿', false, false);
```

That line is now written as the `\uFFFF` escape, which is the same character
expressed in ASCII source.

**The diagnosis is the lesson, and it is why `scripts/check-build.sh` grew a gate
rather than a note.** `iconv -f UTF-8 -t UTF-8`, Python's strict codec, `file`,
every editor and every linter accept `U+FFFF` as valid UTF-8. Chromium does not:
`base::IsStringUTF8` uses `base::IsValidCharacter`, which rejects the whole
non-character range — `U+FDD0..U+FDEF` and every code point ending in
`0xFFFE`/`0xFFFF` — where `IsValidCodepoint` allows them. A file can therefore be
valid UTF-8 by every standard tool and still be refused by the consumer.

The fix in the checker is to **test against the consumer's actual validator**, not
against a standard one. `scripts/check-build.sh:164-285` reimplements
`base::IsValidCharacter`, the ICU `U8_NEXT` walk, and Chromium's rejection of
`U+FFFE`/`U+FFFF`, and reports the offending line number. This is not optional
hygiene: it is the only check in the script that would have caught this.

### 🎧 The Ogg API mismatch that would have broken OGG export

The existing encode loop assumed `encoder.encode()` returns bytes and that
`encoder.flush()` exists. The real `OggVorbisEncoder` does neither:

| | `lamejs.Mp3Encoder` | `OggVorbisEncoder` |
|---|---|---|
| encode | `encodeBuffer(left, right)` → `Int8Array` | `encode([left, right])` → **`undefined`**; it pushes each finished page onto its own `oggBuffers` array |
| flush | `flush()` → `Int8Array` | **`flush()` does not exist.** The methods are `encode`, `finish`, `cancel`, `process`; `finish('audio/ogg')` *is* the flush and hands over the whole stream as a `Blob` |

A `if (buf && buf.length) parts.push(buf)` loop — the shape lamejs requires —
therefore **silently discards every page** and yields zero bytes, and calling
`flush()` was a `TypeError` on every single OGG request.

Both facts are now **asserted, not assumed**
(`offscreen/offscreen.js:923-939`): a missing `encode`/`finish` pair yields a typed
`ENCODE_ERROR` naming the pinned SHA-256 rather than a raw `TypeError`, and a
zero-byte result yields its own `ENCODE_ERROR`
(`offscreen/offscreen.js:1136-1141`) instead of a silent success.

### ➕ Added

- **Both audio encoders, vendored and hash-verified.**

  | file | what | size | SHA-256 | licence |
  |---|---|---:|---|---|
  | `vendor/lame.all.js` | lamejs **1.2.1**, defines the global `lamejs` | 530,087 B | `026bd88846040f357a937cd85821a48492a362eff0812cda734f23fca55fea3b` | **LGPL-3.0** |
  | `vendor/OggVorbisEncoder.js` | `higuma/ogg-vorbis-encoder-js` @ **`7a872423f416e330e925f5266d2eb66cff63c1b6`**, defines the constructor `OggVorbisEncoder` | 2,358,493 B | `5a9f749ab0f84da2292bd68b0e906422378428aea2e298fd116e8a1696da179b` | **MIT** wrapper + **Xiph BSD** C |

  `lame.all.js` was independently compared against the same file extracted from
  the `lamejs@1.2.1` npm tarball: **byte-identical**, both hashes `026bd888…a3b`.
  `OggVorbisEncoder.js` matches the git blob SHA the GitHub API reports for
  `lib/OggVorbisEncoder.js` at that commit. Plus `vendor/LICENSE-lamejs.txt`,
  `vendor/LICENSE-OggVorbisEncoder.txt` and `vendor/README.md`.
- **The `transcode` clamp now admits all four values.**
  `TRANSCODE_FORMATS = ['none', 'wav', 'mp3', 'ogg']`
  (`background/background.js:549`), reduced by a dedicated `resolveTranscode`
  (`:567-572`) and applied at `:1094`. The 6.0.1 clamp to `none|wav` was correct at
  the time — the encoders did not exist — but it silently removed a capability the
  moment the capability arrived, leaving the UI rendering "None" while the stored
  blob still said `'mp3'`.
- **Two new settings keys, with real controls.** `mp3Bitrate` (default `192`;
  valid `128,160,192,224,256,320`) and `oggQuality` (default `0.5`; valid `0`–`1.0`
  by tenths), both snapped by a new `snapToChoice` helper
  (`background/background.js:1188-1235`) — **nearest wins, ties go lower** — and
  both backed by `<select>` elements on the options page
  (`options/options.html:502-529`) that are gated on the matching transcode format
  and **preserve their value across format switches**, because `gateOnTranscode`
  touches only `.disabled`/`aria-disabled` and never `.value`
  (`options/options.js:653-678`).
- **`.gitattributes`** — `* text=auto eol=lf`, plus `vendor/** -text`.
- **`scripts/check-build.sh`, now 77 checks** (was 63).

### 🎚️ Changed

- **Transcoding is a local, unmetered operation, and that is now stated as the
  trade-off it is.** `maybeTranscode` runs after the bytes arrive, its only I/O is
  a runtime message to the offscreen document, and every rung it is called from is
  already unmetered — so **a transcode consumes no monthly download allowance at
  all**. It costs a full decode plus a re-encode (wall-clock CPU) and peak memory
  for both the decoded PCM and the encoded output, and it buys a file that plays
  everywhere. The reasoning is in the code at
  `background/background.js:2297-2313` and in
  [`docs/DOWNLOAD-LADDER.md`](docs/DOWNLOAD-LADDER.md).
- **MP3 and Ogg are always encoded at 48 kHz**, because the worker sends no
  `sampleRate` on the lossy rungs and the offscreen page falls back to `48000`
  (`background/background.js:2332`, `:2359-2366`;
  `offscreen/offscreen.js:1120-1121`). Only WAV has a user-controllable rate. The
  options page now says so on the WAV rate control.
- **MP3 and Ogg remain off the *variant* list, deliberately.** `variant` selects
  the download route and becomes its `?format=` parameter, whose enum is
  undocumented; asking for a format the server may not serve means failing and
  falling through the ladder, potentially spending the metered rungs' quota to
  produce the very file the free rungs already gave us. They are one key away,
  under `transcode`. `FLAC`, `AAC` and `Opus` have no encoder and no `transcode`
  format, so they remain genuinely undeliverable.
- **`scripts/check-build.sh` gained SHA-256 verification of both encoders, parsed
  out of `vendor/README.md` rather than restated** (`scripts/check-build.sh:322-415`),
  so the recorded digests and the bytes on disk cannot drift apart. A missing
  section, a missing `| SHA-256 |` row or an unparseable digest is a **failure**,
  not a silent skip. It also compares the recorded byte size.
- **`scripts/check-build.sh` extended its existence, byte-audit and UTF-8 coverage
  to all five `vendor/` files** (`scripts/check-build.sh:147-320`). Those gates used
  to skip `vendor/`, which meant the largest JavaScript in the package was the only
  JavaScript nobody checked.
- **`node --check` on the vendored bundles is tolerated, not failed.**
  `OggVorbisEncoder.js` parses but V8 prints *"Invalid asm.js: Expected shift of
  word size"* on stderr while still exiting 0 — a compiled-mode advisory about one
  shift inside libvorbis, not a syntax error and not a sign the bytes changed
  (`scripts/check-build.sh:433-466`). Failing on upstream code we are forbidden to
  patch would be failing on the wrong thing; the file is not excused from the
  existence, byte-audit, UTF-8 or SHA-256 gates, which is where real damage shows.

### 🐛 Fixed

- **`lib/db.js` contained a raw `U+FFFF` non-character**, which is valid UTF-8 by
  every standard tool and rejected by Chromium's `base::IsStringUTF8`. Chrome
  refused to load the extension at all — see the story above. Now written as the
  `\uFFFF` escape at `lib/db.js:1382`.
- **`offscreen/offscreen.js` called the Ogg encoder with lamejs's API**, which
  would have thrown a `TypeError` on every OGG request and silently produced a
  zero-byte file even where it did not. Fixed, with a capability assertion — see
  the story above.
- **`sunoTranscode` was unreachable dead code.** `coerceSettings` clamped
  `transcode` to `none|wav`, `maybeTranscode` read the clamped value, and the two
  branches that actually encode (`mode === 'mp3'`, `mode === 'ogg'`) could never
  run. Shipping the encoders without lifting the clamp would have shipped a UI
  control that saves the original and says nothing.

### ⚖️ Licence obligations, recorded honestly

Shipping this extension **redistributes** both encoders, and the terms bind
whoever distributes it. This is now item 12 in
[`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md) rather than a footnote, because two
gaps are real:

- The `LICENSE` file shipped inside the `lamejs` npm tarball — saved verbatim as
  `vendor/LICENSE-lamejs.txt` — is **not** the licence text. It is the LAME FAQ
  answer *"Can I use LAME in my commercial program?"*, which says the LGPL applies
  and **names no LGPL version**. So **"LGPL-3.0" rests on `package.json` and the
  npm registry metadata**, not on the licence shipped beside the code. Nobody has
  audited the origin of lamejs's JS port against the upstream LAME C sources.
- `OggVorbisEncoder.js` is **MIT, not BSD-3-Clause** — the JS wrapper is MIT and
  the compiled-in libogg/libvorbis C is under the 3-clause BSD text, a split the
  upstream README states and the shipped file confirms. The **Xiph BSD text is
  referenced by URL and not reproduced locally**, so a distributor who wants it
  physically in the package should add it.

Neither blocks shipping. Both are the first two questions for a legal review.

### 📕 Docs

- **`docs/KNOWN-LIMITS.md` was restructured.** The MP3/OGG item is **demoted out of
  the top slot** into a "resolved" note that names where the capability is now
  documented, so a future session does not re-add the claim from memory. The new
  **item 1 is the `?format=` enum** — the real remaining limit that decides what you
  can ask Suno for at all, and the reason the variant list is three and MP3/Ogg live
  under `transcode`. A **new item 12** records the redistribution obligations above.
  Items 2–12 shifted up one; items 13–20 kept their numbers, so most cross-references
  survived.
- **`docs/DOWNLOAD-LADDER.md`**: the format matrix now covers all five audio
  outputs, with the local-transcode cost/quota trade-off stated in full, both new
  settings keys, the fixed 48 kHz encode rate, and the Ogg API asymmetry.
- **`docs/ARCHITECTURE.md`**: `vendor/` added to the file map with both licences and
  both SHA-256s, `.gitattributes` and `scripts/check-build.sh` added, a new
  subsection on **why the encoders are vendored and how `.gitattributes` protects
  their bytes**, and `mp3Bitrate`/`oggQuality` added to the settings table.
- **`README.md`**: feature line and limitations section updated; the MP3/OGG row is
  replaced by the licence-obligation row; `scripts/check-build.sh` is now
  documented in *Contributing & verification* with the `U+FFFF` story.
- **Every `file:line` citation in the doc set was re-verified against the current
  source.** `background/background.js` had grown to 6,257 lines and had moved
  substantially; the stale citations were re-quoted rather than carried forward.
  The `lib/*.js` residue flagged by the previous pass was audited line by line —
  almost all of it was already correct, and the two exceptions
  (`lib/api.js:55-58` → `:53-56`, and `lib/db.js:2743`) were fixed.

> **`manifest.json` ships at `"version": "6.1.0"` / `"version_name": "6.1.0 - …"`**
> (`manifest.json:80-81`). The bump shipped **with** this entry, unlike the note an
> earlier draft carried.

### The 6.0.1 → 6.1.0 relationship, stated plainly

**6.1.0 is additive and corrective; it does not revert anything 6.0.1 fixed.**

- Every defect 6.0.1 fixed stays fixed. The 6.0.1 clamp on `transcode` was **not
  reverted** — it was *widened*, from `none|wav` to all four values, and the
  reduction still degrades an unrecognised value to `'none'` rather than letting it
  reach `maybeTranscode` raw. The narrow clamp was a correct response to a missing
  encoder; the wide clamp is the correct response to a shipped one.
- The variant list is **still exactly three entries**. Shipping two encoders did
  not add two variants, because a variant is a download route and its enum is
  undocumented (see item 1).
- The four distinct batch outcomes, the observed-completion invariant, the
  mid-batch quota guard and the alias-tolerant variant resolution are untouched.
- **One 6.0.1 statement is now superseded and is marked as such:** 6.0.1 said
  *"the MP3/OGG limitation itself is unchanged and still true, it is still the #1
  item."* That was true when written. It is the one claim in this changelog that
  6.1.0 invalidates, and both `CHANGELOG.md` and `docs/KNOWN-LIMITS.md` now say so
  explicitly so nobody re-reads the old line as current.

---

## [6.0.1] — 2026-10-04

> *"Found by auditing our own integration seams."*

### 🎤 The story worth telling

6.0.0 was a rewrite by many hands across parallel sessions. Every module was
verified *against itself* — every `file:line` citation in the doc set was checked,
every unit of behaviour was traced from its own entry point, and all of it was
correct.

What nobody checked was **the seams**.

A rewrite divided across six agents has a specific failure mode: each agent reads
the contract it can see and infers the rest. When two agents own opposite ends of
one field, each concludes the other is handling it. Per-file verification cannot
catch that, because each file is individually flawless. It took a dedicated
integration pass — one session, no new features, its whole job being to read the
*contracts* and ask "who actually owns this?" — to find the list below.

None of these were reachable bugs. All of them were plausible-looking, and three
of them looked like they worked.

---

### 🐛 Fixed

**The BPM pipeline was dead end to end, and nobody noticed for a full release
cycle.** Two agents each assumed the other owned the tempo field. `lib/suno.js`
put `bpm` on the record; the worker read `clip.bpm` directly at four separate
sites and therefore never saw it; and the offscreen analysis that *measures* a
tempo when the feed carries none read `reply.bpm` instead of
`reply.analysis.bpm`, so `Number(undefined)` was `NaN` and the function returned
`null` on **every clip**. The `{bpm}` filename token rendered empty, the ID3
`TBPM` frame was never written, and the `.json` sidecar had no tempo — all
consistently, which is exactly what makes a broken pipeline look like a quiet one.

The fix is one helper. `bpmFromClip` (`background/background.js:1274-1278`) is now
the only reader, and the analysis reply is read at its real depth
(`background/background.js:2243-2250`). Tempo is a **tag, not a facet** — there is
deliberately still no BPM range filter, because the field is `0` on essentially
every record straight from the feed (`lib/suno.js:857-863`).

**`GET_BOOT.token` was an object; every consumer stringified it.** The reply field
is `{hasToken, expiresAt, secondsRemaining, source, badToken}`
(`background/background.js:1677-1694`). The dock's guard was
`TOKEN_RE.test(String(res.token))`, and `String({hasToken:true,…})` is
`"[object Object]"` — which can never match a JWT pattern. The whole block was
unreachable dead code, so the session-token panel silently reported nothing on
every page. Now a shape test (`content/content.js:3040-3051`).

**`SYNC_STATUS` returns a nested cursor; the status view read the wrong shape.**
The route answers `{ok, running, cursor, truncated, total}`, where everything
progress-shaped lives *inside* `cursor` under crawl field names
(`nextPage`, `pagesDone`, `totalSeen`). The poller read `res.page` / `res.pagesDone`
/ `res.seen` / `res.added` / `res.etaMs` / `res.state` — every one of them
`undefined` — and the consumer is entirely `typeof … === 'number'` guards. So
**"Check status" updated literally nothing at all**, with no error anywhere.
`applySyncCursor` (`content/content.js:1903-1919`) now maps the cursor explicitly
and deliberately leaves `added`/`etaMs` alone rather than inventing them.

**`tagOptions.cover` was a toggle that did nothing.** The page drawer's tag list
carried a `cover` key the worker does not read, while omitting `artwork` and `lrc`
— which it does read. Because `coerceSettings` rebuilds `tagOptions` wholesale from
the incoming object, a save from that drawer reset the other six to worker
defaults every time. The list is now **exactly the seven keys the worker reads**,
declared once and rendered from that declaration (`content/content.js:1165-1173`).

**Variant aliases reverted silently.** `coerceSettings` used a
`VARIANTS.indexOf(...) >= 0` membership test, so a stored `mp3-320` was hard-reset
to the default with no trace — indistinguishable from "your settings were lost",
and it silently moved anyone who had deliberately chosen a different default.
`resolveVariant` (`background/background.js:528-538`) now substitutes via a
13-entry `VARIANT_ALIASES` map and logs both values at debug level, so "I asked
for MP3 and got M4A" is answerable from diagnostics.

**A quota-stopped batch was reported as "Batch complete".** `DL_DONE` carried
`ok`/`failed`/`skipped` and nothing else, so a batch that halted on the monthly
download allowance — with nothing deleted and clips still planned — produced the
same green success toast as a clean run. `stoppedReason` now distinguishes
`complete` / `quota` / `ladder_exhausted` / `cancelled`
(`background/background.js:4339-4343`) and **both UIs render four distinct
outcomes** (`popup/popup.js:1462-1591`, `content/content.js:2232-2318`).

**The offscreen reply resolver trusted any message ending in `:result`.**
`resolveOffscreenReply` matched on `/:result$/` alone and ran *before*
`validateSender`, so it was reachable by anything that could post on the runtime
channel. Request ids are `'os' + sequence + '-' + Date.now().toString(36)` — a
small, enumerable space — so a guessed in-flight id could settle a waiter with a
chosen payload. The worst case is `sunoBlobUrl`: the forged URL goes straight to
`chrome.downloads.download`. `isOffscreenReply`
(`background/background.js:2028-2045`) now verifies `from`, the protocol string,
the type shape, the id shape, and the sender URL.

> *"The only extension sender is us" reads like an argument. It is an assumption
> about the protocol, not a check.*

**There was no mid-batch quota guard at all.** `quotaPreflight` read the meter
*before* a plan and `runBatch` read it *after*, so nothing checked *during*. A
plan built on a stale reading kept going and then failed item by item on the
metered rungs: a healthy badge, then an opaque wall. `guardQuotaAfterItem`
(`background/background.js:4085-4123`) re-reads the meter every `quotaCheckEvery`
(default 5) **metered** successes and halts cleanly at `quotaReserve` (default 0).
It counts only successful metered downloads, so a purely-unmetered batch polls
**zero** times; it polls nothing under `dryRun`; and it only stops on a **positive**
reading, so an `unlimited` plan, a missing limit and a failed poll all leave the
batch running. A halt writes a separate `quota-stop` journal phase so a later run
can tell a deliberate stop from a batch that ran out of plan.

**Several dead controls.** `transcode` accepted `mp3` and `ogg`, values that route
through an encoder this build does not ship — so an imported settings blob put the
worker into a permanently-failing state while `options.js` rendered the radios as
"None", leaving the user no way to see or undo it. Narrowed to `none | wav`
(`background/background.js:1085-1094`, as it stood in 6.0.1). `options/options.js` also kept a
hardcoded nine-variant fallback list for when `state.variants` was empty, which
would have re-offered every removed format.

---

### 🎚️ Changed

- **The audio variants are now exactly three: `m4a`, `wav-48k`, `wav`**
  (`background/background.js:460`). `mp3`, `mp3-256`, `mp3-320`, `flac`, `ogg`,
  `aac`, `opus` are gone from the variant list, and so are `lrc`, `cover` and
  `json` — the last three because they are **sidecars, not audio**, and are
  controlled by `tagOptions.lrc` / `.artwork` / `.json`. Advertising a format this
  build cannot deliver was the worst kind of lie: the UI offered it, the setting
  stored fine, and every download came back `ENCODER_UNAVAILABLE` with the
  original file saved. See
  [`docs/KNOWN-LIMITS.md` § 1](docs/KNOWN-LIMITS.md) — **the MP3/OGG limitation
  itself is unchanged and still true**, it is still the #1 item.
  > ⚠️ **Superseded by 6.1.0.** That sentence was true when written and is now
  > false: both encoders ship. `KNOWN-LIMITS.md` § 1 is now the undocumented
  > `?format=` enum, and the MP3/OGG item is a resolved note at the top of that
  > page. Read it as history, not as the current state.
- **Four routes gained self-describing replies.** `GET_LIMITS` publishes
  `variantAliases` and `wavRungRates`; `GET_DIAGNOSTICS` is documented as the
  "is this install healthy?" surface; `DOWNLOAD_STATUS` accepts an optional
  `{batchId}`; `PROBE_DRM` accepts an optional `{ladder:[...]}` and reports
  `metered`. Every route now names its side-effect class and which surface owns
  the corresponding control, because *"nothing in this build sends this message on
  its own"* is exactly the fact that used to be unfindable.
- **Two new settings keys.** `quotaReserve` `[0, 10000]`, default 0 — the floor
  the guard stops at. `quotaCheckEvery` `[1, 100]`, default 5 — re-meter at most
  once per N successful metered downloads. Both clamped so a corrupt or hand-edited
  blob cannot disable the guard or turn it into a quota-hammering loop.
- `GET_BOOT.variant` is alias-tolerant rather than membership-tested.
- The `{bpm}` filename token, the ID3 `TBPM` frame and the `.json` sidecar field
  now populate, after a client-side offscreen analysis.

### 📕 Docs

All seven documents were re-verified against the current source. Citations in the
ladder, quota, transcode, BPM, token, batch-outcome and settings-reference
passages were re-quoted rather than carried forward — `background.js` grew past
6,000 lines and `content.js` past 3,300 during this cycle, so the previous line
numbers were substantially wrong. `KNOWN-LIMITS.md` gained the open items the audit
surfaced: no `DOWNLOAD_RESUME` route, no per-clip detail on `DL_DONE`, no `added`
on `SYNC_STATUS`, a `host_permissions` / `content_scripts` mismatch on
`*.suno.ai`, and a pile of exported-and-uncalled helpers.

A final R1–R9 pass moved `background.js`, `content.js`, `options.js` and
`popup.js` again, so those passages were re-quoted a second time against the new
line numbers, the four grown files had their line counts re-taken, and
`KNOWN-LIMITS.md` §17 was re-verified against the shipped code.

> **`manifest.json` is now `"version": "6.0.1"` / `"version_name": "6.0.1 - …"`
> (`manifest.json:80-81`).** The bump shipped with this entry; it is no longer a
> to-do for whoever cuts the release.

---

## [6.0.0] — 2026-10-04

> *"Rewritten data layer, download ladder, filter engine and UI."*
> — the 6.0.0 `version_name`, since replaced by the 6.0.1 one at `manifest.json:81`

A ground-up rewrite. **86 audited defects** in the 5.0.0 build, of which the ones
below were total — features that were advertised, present in the UI, and could not
work. Several were invisible because they failed *silently*, which is worse.

Nothing here is theoretical. Every defect was reproduced or read out of the shipped
code before being called a defect.

---

### 💀 The five that killed the product

These are not bugs. These are features that appeared to work and did not.

**1. The content script never initialised at all — the entire page UI was dead.**

`manifest.json` runs content scripts at `run_at: "document_start"`, where
`document.body` is still `null`. The old file called
`document.body.appendChild(dock)` at the top level of its init IIFE, threw a
`TypeError`, and took the whole script down with it.

**Every suno.com page, every run: no dock, no filter panel, no row checkboxes, no
Clerk token reader.** Nothing. The extension looked installed and was inert.
`content/content.js:6-18` now documents this as the reason the entire file obeys
one rule: no DOM access anywhere that assumes body exists until `mount()` runs.

> ⚠️ **The "Clerk token reader" that used to sit in that list did not work either,
> and in 6.1.1 it was removed entirely** — see the 6.1.1 entry. It needed an inline
> `<script>`, which suno.com's CSP refuses to execute. MAIN-world access now goes
> through the worker. Do not re-add a page-side token reader from this entry.

**2. No message ever reached the content script.**

`chrome.runtime.sendMessage` from a service worker reaches extension pages (popup
/ options / side panel) but **not content scripts**. The old build *documented
that in a comment* and then used only the broken path.

So even if the page UI had mounted, it would have received nothing — no sync
progress, no download progress, no token-changed, nothing. Every push now fans out
to **both** `chrome.runtime.sendMessage` and `chrome.tabs.sendMessage`
(invariant D, `background/background.js:42-45`).

**3. `/api/playlist/liked/` does not exist.**

The old build paged it for the "liked only" filter. Every call 404'd and the
pagination silently returned nothing. Liking is per-clip state — `is_liked` — and
is derived locally by filtering the feed (`lib/api.js:11-12`).

Combined with defect 4, this is why **"liked only" never worked for anyone.**

**4. "Liked only" matched 100% of the library.**

The filter inferred "liked" from **`upvote_count > 0`**. `upvote_count` is a
*public count of how many people upvoted a song*, not your like state. In a
personal library essentially every clip has at least one upvote, so the filter
matched everything and looked like it was working.

Now: `is_liked` and nothing else (`lib/suno.js:897-899`), with a strict `boolOf`
that does not treat `1` as truthy-by-accident (`lib/suno.js:125-127`). The
upvote-count filter is separate and still exists, reading `upvote_count`.

**5. `audio_url` was scraped as if it were a media URL.**

For **every** clip, `audio_url` is the literal constant
`https://studio-api.prod.suno.com/api/forbidden`. Recon captured it being served
as a **111-byte 403 XML body** under an audio-ish filename — which is why the old
downloader wrote "done" rows for files that were never audio
(`lib/db.js:369-378`).

**The extension could never actually download music.** The real audio lives in
`media_urls[]`, a CloudFront object with `content_type: "m4a-opus"`, AES-CTR
encrypted under a per-clip content key that is itself AES-GCM wrapped under a
per-user key.

---

### 🩹 Seven more that shipped broken

| defect | symptom |
|---|---|
| **~1,356 lines in `lib/` were loaded on every page and never called** | dead weight in the critical path, and a maintenance trap: `lib/*.js` sat in the content-script list in `manifest.json:30-38` while the actual work happened in a `lib/` nobody was importing |
| **The indexer silently truncated at 20 pages** | a user with 3,000 clips lost 2,000 with **no warning anywhere**. `syncMaxPages` now defaults to 200, is user-tunable, and truncation is surfaced in `GET_BOOT`, the popup banner, the side panel, and the sync cursor — `background/background.js:5362-5365` calls it *"the single most important field in this reply"* |
| **Filter and download-history keys used mismatched format values** | dedupe never matched, so **every batch re-downloaded everything**, and each re-download looked like new work |
| **Download history was written before the download completed** | history rows existed for files that never landed. `chrome.downloads.download()` returning an id means *accepted*, nothing more. `markDone` is now reachable from exactly **two** call sites, both requiring an **observed** completion (invariant A, `background/background.js:33-37`) |
| **The filename builder never appended an extension** | files written with **no extension at all**, so nothing on the user's disk would open. It also hardcoded `{format}` to `wav` regardless of what was requested. The real extension is now always appended (`background/background.js:2563-2564`, `:2470-2472`) |
| **The old filter engine's `includeDisliked: true` EXCLUDED dislikes** | the name says include, the code excluded. It only behaved correctly by accident of a `\|\|` chain (`skipDislikes = skipDislikes \|\| !includeDisliked`). `lib/suno.js:302-306` |
| **30 silent `catch {}` blocks** | an undiagnosable build. Invariant H: **zero empty catch blocks**, every failure logged with enough context (`background/background.js:52-54`) |

Two more from the same audit that are worth naming even though they're smaller:

- **`chrome.downloads.onChanged` failure detection was permanently dead and its
  polarity backwards.** `download.error` is a **string** on the delta item; the old
  build tested a non-existent `errorDetails` field *inside* `state === 'complete'`
  — so failures were only ever supposed to be detectable from inside the success
  case (`background/background.js:2769`).
- **The page token relay validated `origin` but not `source`**, so any same-origin
  script could overwrite the extension's credential **profile-wide**. Both were
  checked in 6.0.1 — and in **6.1.1 the relay itself was deleted**, because it could
  never have worked under suno.com's CSP. See the 6.1.1 entry; there is no page-side
  relay to re-introduce.

---

### ✨ Added

**The download ladder.** Seven ordered rungs, each with an explicit cost class
(`background/background.js:331-389`), so *how you get the bytes* is a separate decision from
*whether it costs a download*. Two rungs are unmetered; the rest spend a monthly
allowance. Includes the Mango DRM pipeline: rights → user key → AES-GCM unwrap →
chunked AES-CTR → container verification.

**A filter engine built on recon-verified fields only.** `lib/suno.js` reads every
field exactly once in `normalize()` and never touches raw clip shape again. The
fields the previous version **guessed** — `is_disliked`, `dislike_count`,
`num_likes`, `reaction_count`, `project_id`, `persona_id`, `remix_of`, `is_pinned`,
`clip.is_instrumental` — do not exist on a Suno clip, so every filter built on them
compared against `undefined`.

**Tri-state filters** (`any` / `only` / `exclude`) for likes and dislikes, plus
three-state booleans (`true` / `false` / absent) for the rest. The old engine used
booleans whose names didn't match their polarity.

**A real query parser.** `parseQuery` with `"quoted phrases"`, `title:` / `style:` /
`lyrics:` / `prompt:` / `model:` / `project:` prefixes, `-`/`!` negation, and
case-sensitive `AND`/`OR` (case-sensitive so ordinary words in a title aren't eaten
as operators). Mixed AND/OR keeps exact grouping.

**A two-pass dislike detector**, because no dislike field exists: page
`/api/feed/v2` twice with `hide_disliked` flipped and diff the id sets. The result
carries an `dislikedApproximate` flag when it could not be computed honestly.

> 🕑 **Historical — both the route and the two-pass diff were removed in 6.2.0.**
> `/api/feed/v2` is not a Suno web-app route, and `/api/feed/v3` filters on
> `disliked` server-side, so one walk answers the question. Read this paragraph as
> a record of what 6.0.1 shipped, not as the current mechanism. → the **6.2.0** entry at
> the top of this file

**A workspace filter that admits what it is.** A workspace *is* a project; the
default one is literally `{"id":"default","name":"My Workspace"}`. Membership is
joined client-side from `/api/project/feed` because **Suno has no project field on
a clip**.

**12 model families** with the two source fields (`model_name`, then
`major_model_version`), prefix-matching so `chirp-custom:*` catches every custom
model, and an explicit **Unknown / legacy** bucket because `major_model_version` is
frequently the **empty string**.

**Facets, stable sorting and paging.** Stable comparators so equal rows never
shuffle between pages. Genre facets deduplicate per clip so one clip reading
`"pop, pop, dream"` cannot out-vote 40 genuinely different tracks.

**24 presets** — including `MOST_PLAYED` and `MOST_LIKED`, which used to be `{}`,
byte-identical to `ALL`, i.e. **no sorting at all**.

**An offscreen document** supplying the three things a service worker does not
have: Web Audio, `URL.createObjectURL`, and a real DOM. Decode, resample, render a
WAV with a real RIFF header, detect BPM, mint blob URLs. Lazily created and
**proven alive before first use** — a document whose Web Audio failed to initialise
answers the ping with `audio:false`, and finding that out at the first 24 MB buffer
is far worse than finding out now.

**A real tagging pipeline.** ID3 / MP4 metadata (`USLT`/`©lyr`, `APIC`/`covr`,
`TBPM`/`tmpo`, `COMM`/`desc`, `TALB`/`©alb`), plus `.lrc` and `.json` sidecars
written only when they have real content, scrubbed of key material as defence in
depth because they land on the user's disk in plaintext. BPM is **measured** from
decoded audio when a clip has none — a missing BPM is never invented. Artwork that
can't be fetched degrades to "no artwork", never to a failed download.

**A resumable, quota-aware batch driver.** Per-item failure isolation, a bounded
worker pool, a per-batch journal, dry run, retry-failed, and a quota preflight that
names the exact shortfall and reset date.

**A resumable crawl with no silent truncation.** Cursor written after every page;
`clips.clear()` never called; a forced rebuild finishes with one atomic
`bulkReplace` so an abort leaves the previous library completely intact.

**Additive hand-off for HLS capture** — off by default, gated on both sides,
behind an explicit confirm, because it requires patching `MediaSource` on Suno's
own player.

**`PROBE_DRM`** — a diagnostic that reports which ladder rungs *would* work for a
clip and why, downloading nothing and spending nothing.

**A full settings surface**: ladder reordering, opt-in gates, filename templates
with a live preview and a token cheatsheet, pacing, tagging, conversion, and
JSON import/export that never emits the token, key material or diagnostics.

**Diagnostics that persist.** One `log()` writing to a 500-entry ring buffer in
`chrome.storage.local`, gated on `settings.debug` and **always on for `error`** —
an error you cannot see is the defect that just shipped. Sensitive keys are dropped
by regex at any level.

---

### 🔧 Fixed

- **Content script initialises at `document_start`.** A `MutationObserver` on
  `document.body` replaces a single `ensureRowCheckboxes()` call, which meant rows
  rendered later in Suno's SPA never got a checkbox and *"Download All" was
  permanently dead*.
- **Row identity no longer reads `data-clip-id`.** The old build read
  `row.dataset.clipId || row.dataset.id || row.getAttribute('data-id')` — none of
  which Suno's DOM carries. Competitor extensions inject `data-clip-id` themselves,
  which is why it *"worked" for them and not for us*.
- **The quota badge shows DOWNLOADS, not credits.** They are different resources.
  The old badge cheerfully reported plenty of headroom while the download meter was
  exhausted. Credits now live in their own field, never merged
  (`background/background.js:4978-4989`).
- **The quota is primed on install and on browser start**, so the badge is never
  blank until some UI happens to ask.
- **`chrome.alarms.create` runs only from `onInstalled`/`onStartup`.** At module
  scope it re-armed on every worker wake and reset its own period — the old build
  had a keepalive that fired constantly *and* one that still did not protect a
  batch.
- **`onMessage` returns `true` only for async handlers.** Returning it
  unconditionally leaks the response channel — the documented cause of *"the
  message port closed before a response was received"*. It now inspects the
  **result**, not a hand-maintained `async` flag.
- **The router ignores its own push types**, so a broadcast can never re-enter the
  router and be answered with "unknown message type".
- **Offscreen replies settle on an id-keyed registry, first channel wins**, and a
  JSON-truncated broadcast is dropped unless `sendResponse` already answered —
  handing `{byteLength, payloadTruncated:true}` to a caller expecting WAV bytes
  would produce a corrupt file.
- **Sender validation on every route**, checking both `sender.id` and a
  `sender.url` allowlist. The old `TRIGGER_NATIVE_DOWNLOAD` checked **neither** and
  downloaded an arbitrary caller-supplied URL.
- **Settings writes are coalesced** with a 400 ms write-behind, so a slider drag is
  one storage write rather than fifty. Every key is validated on read, because a
  corrupt blob must not produce a NaN rate or an unsanitised path template.
- **`downloadSource` and `sourceLadder` are reconciled in both directions**, so the
  canonical key no longer shadows the legacy alias and silently discards the user's
  ladder ordering.
- **An empty ladder fails loudly.** A non-empty preference that filters down to
  nothing returns `[]` and the batch refuses with `ladder_empty`, rather than
  silently re-enabling metered rungs the user deliberately turned off.
- **Filename sanitisation is hostile by design.** A clip title is
  attacker-influenced text that ends up on the user's filesystem: control
  characters, bidi overrides and BOM stripped; illegal characters replaced; dot-runs
  collapsed so `..` cannot survive as a traversal segment; Windows device names
  prefixed; NFC normalised; 180-char cap.
- **A title that sanitises to nothing falls back to the short clip id**, so a file
  can never be written as a bare `.mp3`.
- **`{artist}` resolves the configured artist policy, not the clip's
  `display_name`.** Those fields are the *owner's account identity*, never a
  third-party artist credit.
- **No `innerHTML` anywhere in the content script.** The old `escapeHtml` escaped
  `< > &` but not `"`, so a workspace id could break out of a `value="…"`
  attribute. Every node now goes through `textContent`.
- **All UI lives in one shadow root.** Nothing is written to the page `:root` or
  `document.head` for styling, so Suno's cascade is untouched.
- **The journal and the sync cursor are written after every step**, so "what
  happened at 3am" is answerable and an eviction resumes instead of restarting.

---

### 🔄 Changed

- **Trusted hosts are pinned.** `VERIFIED_BASE_URLS` is two exact origins; anything
  containing `staging`, `-beta`, `-dev`, `-preview` or `-canary` throws
  `forbidden_base_url` **at construction time**. It cannot be configured away.
- **The route table is validated at construction.** Every entry must be an absolute
  `/api/...` path and must survive the forbidden-fragment guard — `/b-side/`,
  `suno.com/api`, and the fictional liked-playlist route.
- **Rate limiting is 4 req/s + jitter with a global concurrency cap of 3**, a
  shared token bucket with a `pause()` for 429s. This is production, so the default
  is the production pace.
- **Retry is deliberately narrow.** A 403 is an entitlement wall, a 404 will never
  appear, and an explicit `{ok:false}` refusal is a decision, not a glitch. An
  explicit `retryable:false` is authoritative **in both directions** — without that,
  a failure carrying `retryable:false` and no status fell through to "network
  fault" and would be retried forever.
- **Credits and downloads are separate objects everywhere.**
- **`audio_url` is nulled on persist** and flagged, because storing a poisoned
  constant would force every future reader to re-detect it.
- **`ALL` means all, including trashed.** The old engine dropped trashed clips
  implicitly, which silently shrank mass downloads. `NO_TRASHED` excludes them
  explicitly.
- **`RECENT_30_DAYS` is a getter**, so the 30-day window is computed when it is
  read. A literal `Date.now()` at script load goes stale in a long-lived service
  worker.
- **Naming is template-driven**, with folder depth capped at 4 and the extension
  always appended.

---

### 🗑️ Removed

- **All fiction.** Routes that do not exist were deleted outright rather than kept
  as "fallbacks" — including `/api/playlist/liked/`, the 84 `/b-side/*` names, and
  every `suno.com/api/*` path. A fiction kept as a fallback is a fiction you will
  eventually successfully request.
- **`chrome.sidePanel.setPanelBehavior` is still not called**, so the panel opens
  from the browser's own side-panel UI or the popup's *Open full panel* — not
  directly from the toolbar icon.
- **`MP3` and `OGG` transcode options are rendered `disabled`** rather than offered
  as settings that would silently fail. MV3 forbids remotely hosted code, so the
  encoders must be vendored at `vendor/lame.all.js` (~1 MB, LGPL) and
  `vendor/OggVorbisEncoder.js`; neither is present. Asking Suno for MP3 via the
  *format* dropdown is unaffected — that is a different thing from encoding locally.
- **The Studio-download-not-counted bypass is gone**, and is documented as a **closed
  bug** (server-side, 2026-09-09), not an exploit. The `metered` flags in the ladder
  are the observed contract, not a bypass claim.
- **Staging is unreachable by construction.** A host denylist, enforced before any
  request can be built.
- **No telemetry, no analytics, no remote calls.** Every request goes to Suno or a
  CloudFront CDN.
- **No test files.** Every module was verified with assertion suites run outside
  the repository; the results were folded into the code comments and
  `docs/KNOWN-LIMITS.md`. Disclosed in the README: there is no `npm test` and no CI.

---

### 🔒 Security

- **No token or key material is ever logged, or written outside
  `chrome.storage.session`.** A regex drops anything matching
  `token|jwt|authorization|bearer|password|secret|cookie|session_key|private_key|content_key|user_key|glt|iv`
  from the log at any level.
- **Unwrapped content keys live in a bounded, TTL'd in-memory LRU only** — never
  `chrome.storage`, `localStorage`, `sessionStorage` or IndexedDB, because key
  material in extension storage is readable by anything with the extension id and
  survives on disk.
- **The page token relay validated `origin` *and* `source`** before trusting a
  reply, closing a profile-wide credential-overwrite gap that origin checking alone
  left open. *(Historical: the whole relay was deleted in 6.1.1 — it required an
  inline `<script>` that suno.com's CSP blocks, so it never worked. MAIN-world
  access now runs in the worker.)*
- **Sender validation on every route**, `id` **and** `url`. An unauthorised sender
  and an unknown message type are both rejected **synchronously**, so the response
  channel never has to be held open for them.
- **Host and route denylists are enforced at construction time**, so a staging host
  or a fictional route cannot be reached even by a corrupted settings blob.
- **`EXPORT_SETTINGS` never emits the token, key material, or the diagnostics ring
  buffer** — settings stay exportable even when IndexedDB is unavailable.
- **Hostile filename sanitisation**, because a clip title is attacker-influenced
  text landing on the user's filesystem.
- **Sidecars are scrubbed of key material twice** — once by the lyric builder, once
  again as defence in depth.
- **No remote code.** MV3's `script-src 'self'` plus an offscreen document running
  under `default-src 'none'` and `connect-src 'none'`. This is also, honestly, the
  reason MP3 and OGG don't exist yet.

---

## [5.0.0] — the previous release

The build this one replaces.

**Shipped state:** the page UI never mounted; no message ever reached it; liked
filtering matched everything; the liked-playlist route did not exist; the indexer
silently truncated at 20 pages; `audio_url` was scraped as a media URL; download
history was written before completion; dedupe never matched; filenames had no
extension.

Its store description advertised *"Ultimate asset manager for Suno AI: 48kHz WAV
export, M4A/MP3, Cover Art, BPM detection, LRC/TXT lyrics, smart library sync &
batch downloading"* — three of those six claims (MP3 export, 48 kHz WAV,
download-history-backed sync) were not delivered by the build. **6.0.0 rewrote the
description to what actually ships** — `manifest.json:4` is now:

> *"Bulk-export Suno: Liked/Workspace/model/date/search filters, resumable batch
> downloads, M4A/WAV with cover art, BPM and LRC lyrics."*

Note what is absent: **no MP3**, because the encoder is not vendored. The store
listing and the build now agree.

> ⚠️ **Superseded by 6.1.0, twice over.** The encoder *is* vendored now, and MP3
> *is* shipped — but it is reached through **Settings → Convert → MP3**, not through
> the store description, which `manifest.json:4` still reads "M4A/WAV with cover
> art, BPM and LRC lyrics" and which nobody has re-cut. So the "no MP3" note is
> wrong about the build and right about the listing.

**86 audited defects** across the data layer, the download ladder, the filter
engine and the UI. The full accounting is above — this entry exists so the diff is
readable, not because 5.0.0 had anything worth keeping.

---

## Doc set shipped with 6.1.0

Re-verified against the current source; see the 6.1.0 entry for what moved.

| file | what it is |
|---|---|
| `docs/KNOWN-LIMITS.md` | 20 hard limits plus the resolved MP3/OGG note, most valuable file in the repo |
| `docs/FILTERS.md` | every filter, its spec key, its verified field, its caveats |
| `docs/DOWNLOAD-LADDER.md` | seven rungs, quota semantics, DRM pipeline, format matrix |
| `docs/ARCHITECTURE.md` | file map, MV3 constraints, message protocol, data flows, IDB schema |
| `docs/RECON-NOTES.md` | the verified-truth ledger — built on, and deliberately refused |

[6.1.0]: #610--2026-10-05
[6.0.1]: #601--2026-10-04
[6.0.0]: #600---2026-10-04
[5.0.0]: #500---the-previous-release