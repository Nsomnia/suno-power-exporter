# 🎛️ Known limits — read this before you touch anything

This is the file that saves the next session a week. Every entry below was read
out of the shipped code or the recon ledger, not guessed. If something here
becomes wrong, the code that proves it is named, so you can check.

Order matters: the first item is the one that changes what the extension can do
at all.

---

## 🧱 1. MP3 and OGG output do not exist in this build

**This is the top blocker. Everything else on this page is a refinement; this one
is a missing binary.**

Manifest V3 forbids remotely hosted code. `manifest.json:77-79` sets
`content_security_policy.extension_pages` to `script-src 'self'`, so the offscreen
document cannot fetch an encoder from a CDN at runtime — there is nowhere to put a
`<script src="https://cdn…">` that would load. An audio encoder therefore has to
be **shipped inside the extension**.

`offscreen/offscreen.js:173-176` declares exactly where the two missing encoders
would live:

```js
mp3: { path: '../vendor/lame.all.js',        global: 'lamejs' },
ogg: { path: '../vendor/OggVorbisEncoder.js', global: 'OggVorbisEncoder' }
```

`offscreen/offscreen.js:120-121` states that no `vendor/` directory exists in this
repository, and `offscreen/offscreen.js:851-852` makes `sunoTranscode` return a
typed `ENCODER_UNAVAILABLE` with the path it expected.
`background/background.js:1840-1847` adds that code to `OFFSCREEN_FATAL_CODES`, so
it is **never retried** — retrying a capability gap produces the identical answer
forever.

### What that means for the format list

`VARIANTS` is now **exactly three entries** (`background/background.js:449`):

| Variant | What it is | Cost |
|---|---|---|
| **`m4a`** | native. The download already *is* an m4a, so no encoder is involved at any point | 🟢 free on rungs 1–2 |
| **`wav-48k`** | a local render with the rate **pinned** to 48000, so the rung stays distinguishable from plain `wav` when `wavSampleRate` moves | 🟢 free — it renders bytes you already have |
| **`wav`** | a local render at `settings.wavSampleRate` through the offscreen `sunoRenderWav` (decode → resample → real RIFF header) | 🟢 free |

Everything the old list offered besides those — `mp3`, `mp3-256`, `mp3-320`,
`flac`, `ogg`, `aac`, `opus` — needs a real encoder, and this build has none.
**Advertising them was the worst kind of lie**: the UI offered them, the setting
stored fine, and every download came back `ENCODER_UNAVAILABLE` with the original
file saved. The reasoning is spelled out at `background/background.js:421-448`;
do not "helpfully" re-add the others.

`lrc`, `cover` and `json` left the variant list for a different reason: they are
**sidecars, not audio**. They are controlled by `tagOptions.lrc`,
`tagOptions.artwork` and `tagOptions.json`
(`background/background.js:556-564`, `content/content.js:1165-1173`).

An old stored setting does **not** hard-reset. `VARIANT_ALIASES`
(`background/background.js:489-503`) is a 13-entry map and `resolveVariant`
(`:517-527`) substitutes the nearest thing this build can produce, logging
`settings.variant_aliased` once per occurrence at debug level with **both**
values, so "I asked for MP3 and got M4A" is answerable from the diagnostics
surface. A hard reset is indistinguishable from "your settings were lost", and it
would also silently move a user who had deliberately chosen a different default.

> **A distinction that trips people up:** asking Suno for MP3 via the *format*
> dropdown is a **different thing** from encoding to MP3 locally. The download
> routes take a caller-supplied `?format=` value, and Suno may or may not honour it
> (see §2). That path costs one download and is metered. *Transcoding* the bytes
> you already have is free but needs the encoder. Neither works without the other.

The transcode control is narrowed to match: `coerceSettings` accepts **only**
`'none'` or `'wav'` (`background/background.js:984-993`). `mp3` and `ogg` used to
be admitted there, which put an imported settings blob into a permanently-failing
state while `options.js` rendered the radios as "None" — so the user had no way to
see or undo it. The options page still renders both radios `disabled` with the
reason spelled out (`options/options.html:425-430`,
`options/options.html:442-455`).

**To fix:** vendor `lame.all.js` (and/or an Ogg encoder) into `vendor/`, ship its
licence, delete the `vendor/` line from `.gitignore`, and drop the `disabled`
attributes in `options/options.html`. There is no code change in the pipeline —
`offscreen/offscreen.js:888-889` already knows how to call `lamejs.Mp3Encoder`.

---

## 🔤 2. The `format` enum is undocumented, so formats are a guess

The `?format=` value is passed straight through from the caller's string.
`background/background.js:445-447` is the honest position:

```js
const VARIANTS = Object.freeze(['m4a', 'wav-48k', 'wav']);
```

The value the worker actually sends is whatever the ladder rung was asked for, and
`VARIANT_EXTENSIONS` (`background/background.js:464`) maps it to the extension
written on disk — which is why `wav-48k` lands on `.wav` even though it keeps its
own identity.

**No recon source enumerates which values the server accepts.** `lib/api.js`
therefore tallies every value it has tried so the real members can be learned from
telemetry over time (`lib/api.js:1020`, `this._formatTally`). Treat the
non-`m4a` case as *unverified*: the request will be made, the response parsed by
`parseDownloadResponse` (`lib/api.js:1769-1890`), and a refusal surfaces as a typed
error rather than a silent success.

Consequence: **you cannot rely on asking for a format and getting it.** The one
guaranteed-correct container is `m4a`, because the free rungs deliver the source
stream verbatim and it *is* M4A. `wav` and `wav-48k` are honest regardless, because
neither depends on Suno — they are rendered locally from whatever bytes arrived.

---

## 📦 3. Bulk ZIP: ≤200 per request is confirmed, the response shape is not

`POST /api/download/clips/zip/prepare`

Confirmed:
- **Flat body.** `../suno-recon/reports/sweep2/write_schemas.md:250` — "wire shape: **flat**
  (confirmed — a flat sentinel body was accepted past validation)".
- **Required field:** `clip_ids`, an array (`../suno-recon/reports/sweep2/write_schemas.md:254-256`).
- **≤200 clips per chunk.** Two independent recon sources agree:
  `../suno-recon/reports/THIRD-PARTY-2026-09-30.md:113` and `../suno-recon/reports/LIVE-2026-09-30.md:467`
  both say "≤200 clips". `lib/api.js:101` encodes `ZIP_CHUNK_SIZE = 200` with the
  comment "CONFIRMED server maximum for clip_ids".
- **POST-only.** A `GET` returns 405 (`lib/api.js:935`).

Not confirmed:
- **The response body.** `background/background.js:2875-2877` refuses a job-shaped
  response outright: *"the route returned a job id rather than a URL; job polling
  is not implemented"*, typed `job_not_supported`. There is no polling loop, so a
  job response is a dead end.
- **Whether it works at all on your account.** The validator emits the business
  rule `Bulk download is not available` verbatim
  (`../suno-recon/reports/FINDINGS.md:469`; `../suno-recon/reports/sweep2/write_schemas.md:260`), which
  `lib/api.js:107` carries as `BULK_UNAVAILABLE_MARKER`. The recon account hit
  that message.

> ⚠️ **One unresolved conflict, do not paper over it.** `../suno-recon/reports/FINDINGS.md:467-468`
> lists a validator rule `clip_ids must contain between 1 and 100 items` in the
> same business-rules list as `Bulk download is not available` — but it does not
> say which route it belongs to. It may be a different endpoint. Until someone
> re-probes it against `zip/prepare` specifically, the code's 200 is the better
> sourced number (two sources name the route, one does not) and the 100 remains an
> unexplained string.

The rung is also `batchOnly: true` (`background/background.js:372-379`), so
`normalizeLadder` drops it from every single-clip path
(`background/background.js:1043`) and it additionally requires
`allowMeteredExtras` (`background/background.js:1042`). Both rungs marked
`batchOnly` — `zip` and `hls` — are removed unconditionally; the opt-in flag is
not what removes them.

---

## ⏱️ 4. `duration`'s type is unverified, so both shapes are handled

The field exists on a clip. **Its type does not.** `lib/suno.js:149-153` says so
in as many words, and `parseDuration` (`lib/suno.js:154-167`) therefore accepts:

- a plain number of seconds,
- a numeric string (`"213.4"`),
- `"m:ss"` / `"h:mm:ss"` (`"3:33"`, `"1:02:11"`).

The risk is not a crash — the whole function is total — it is a **wrong range
filter**. If Suno ever switches to milliseconds, `durationMin: 60` would mean
60 ms and every clip would pass. Nothing detects that, and nothing in the recon
resolves it.

---

## 📄 5. Feed page size is unknown, and truncation is always surfaced

`lib/api.js:911` annotates `feedV2` with `// {"clips":[...]} — page size UNKNOWN`.
There is no server-declared page size anywhere in the recon, so the crawl cannot
compute "total pages" from a total — only estimate from pages already done
(`estimateSyncEta`, `background/background.js:4710-4727`).

The extension caps the crawl at `syncMaxPages`, default **200**
(`background/background.js:589`, clamped to 1–2000 at `background/background.js:971`)
and surfaces truncation everywhere it matters, because a silently short library is
the failure the previous build shipped:

- `cursor.truncated` is written on every crawl (`background/background.js:4412`,
  `:4673`),
- `GET_BOOT` returns it, commented *"the single most important field in this
  reply"* (`background/background.js:5178`),
- the popup renders a warning banner (`popup/popup.html:19-21`).

**If you see `truncated: true`, your local library is incomplete** and every filter
result is a subset of your real library. Raise `syncMaxPages` in the options page.

Two more crawl limits worth knowing:

- **Two consecutive empty pages end the crawl** (`lib/api.js:104-105`,
  `STALL_PAGE_LIMIT = 2`). A feed that hiccups twice is read as "end of library".
- **A forced rebuild buffers up to 25,000 rows in memory** before switching to
  additive writes (`background/background.js:281`, `FULL_REBUILD_BUFFER_CAP`).
  Over that cap it falls back to additive writes and marks the result incomplete
  rather than half-replacing your library
  (`background/background.js:4503-4515`).

---

## 🔁 6. Detecting dislikes costs roughly double a sync

**There is no per-clip dislike field.** No `is_disliked`, no `dislike_count`, no
`downvotes` — and as of the 6.0.1 audit the engine no longer even *tolerates* them:
`lib/suno.js:901-902` reads the caller-supplied id set plus `clip.disliked` /
`clip.is_disliked` as pure caller-supplied fallbacks, and the comment above says
outright that *"disliked state is NOT a clip field"*.

The only mechanism is a two-pass diff of `/api/feed/v2`
(`lib/api.js:1909-1913`, `:2023-2026`):

```
pass A:  GET /api/feed/v2?hide_disliked=true   →  baseIds
pass B:  GET /api/feed/v2?hide_disliked=false  →  seenIds
dislikedIds = seenIds \ baseIds
```

**Cost: two full crawls.** With `syncMaxPages: 200` that is up to 400 requests for
a disliked pass, at the default 4 req/s (`background/background.js:543`) — call it
a minute and a half of pure page-fetching, before any bytes.

Practical consequences:
- The id sets are flushed to IndexedDB only every **5 pages**
  (`background/background.js:278`, `DISLIKED_FLUSH_EVERY_PAGES`, applied at
  `:4631`) — persisting a 3,000-id array per page would dominate the crawl, but an
  eviction inside that window loses the diff.
- A resumed two-pass run **cannot skip ahead**: the generator always starts at
  pass A, so the remaining half is walked directly and the diff is derived from the
  persisted pass-A set (`background/background.js:4644-4654`).
- `cursor.dislikedApproximate` is set when the diff could not be computed
  honestly (`background/background.js:4598`, `:4652`). **Check it** before trusting
  a "disliked only" result.
- Default mode is `dislikedMode: 'exclude'` (`background/background.js:590`) — the
  single-pass cheap mode. `'both'` is the one that doubles the bill.

---

## 🗂️ 7. Project (workspace) membership needs a join, and `default` swallows the rest

A workspace **is** a project. The default project is literally
`{"id":"default","name":"My Workspace"}` — the id is `default`
(`lib/suno.js:31`) and the UI label is `My Workspace` (`lib/suno.js:32`).

**Suno has no project field on a clip.** `background/background.js:4251` states
this as the rule: *"Suno has NO project field on a clip; membership is joined from
the project feed."* The join is built from `/api/project/feed`
(`lib/api.js:913`, shape `{items:[{type,added_at_ms,clip}]}`), fetched once per
sync at `background/background.js:4450`.

Therefore:
- **Clips outside every project land in the `default` bucket** and are reported
  under the id `default` in facets (`lib/suno.js:1187-1194`).
- Picking any project keeps the unassigned bucket in scope by default
  (`lib/suno.js:466-468`, `includeUnassigned` defaults to `true`) — so a
  "just my Rock project" filter still returns everything unfiled unless you turn
  that off. That default is deliberate: it stops a project pick from silently
  shrinking a mass download.
- If `/api/project/feed` fails, the sync logs a warning and continues
  (`background/background.js:4457`); every clip then reads as unassigned.

> **Collaborative / cross-user workspaces do not exist in prod.** `collab-workspaces`
> is a **staging-only** server flag (`../suno-recon/reports/FINDINGS.md:219`) with **no known API
> surface** — nothing in the verified 23-route table, nothing in the recon bundle.
> Do not build a filter for it.

---

## 🎼 8. `make_instrumental` may be absent, and absence means false

`lib/suno.js:922-925`, verbatim:

> `make_instrumental MAY BE ABSENT on vocal clips -> absent means false.`

So `include.instrumental: false` ("with vocals") is really "the flag is not true",
which also matches any clip where the field is simply missing. The UI says the
same thing to the user (`content/content.js:1069`).

There is a fallback chain: `metadata.make_instrumental`, then `metadata.is_instrumental`
when the first is absent, then `clip.is_instrumental`. The middle one is an
unverified field; the last is likewise unverified. Only the first is recon-grounded.

---

## 🎛️ 9. Stems and multitracks have no clip field — the filter is a text search

There is no `has_stems` / `is_multitrack` on a Suno clip. The extension therefore
implements the stems filter as **a literal search for the word "stems"** in
title / style / prompt / lyrics:

```js
if (f.stems === 'only')   stemsTerms.push({ field:'any', value:'stems', negate:false });
else if (f.stems === 'exclude') stemsTerms.push({ field:'any', value:'stems', negate:true });
```

— `content/content.js:466-468`, merged into the query terms at `:517-521`.

The UI is honest about it (`content/content.js:1077`): *"No clip field exists for
stems, so this is a real search term: the word 'stems' in title/style/prompt/lyrics."*

**This is a deliberate approximation, not a bug to fix in this repo.** Any clip
whose prompt happens to say "stems" matches, and any real stem track whose prompt
does not say the word does not. Do not present this filter as accurate.

---

## 🧬 10. Custom-model attribution has no clip field either

A custom model shows up on a clip only through `model_name` carrying the prefix
`chirp-custom:` (`lib/suno.js:42-43`, `:973`). There is **no boolean field**, so:

- `PRESETS.CUSTOM_MODELS = { models: ['custom'] }` (`lib/suno.js:1526`) works,
  because the `custom` family is matched by **prefix** — an alias ending in `:` is
  a prefix match (`lib/suno.js:223-225`, alias `'chirp-custom:'` at `:60`).
- But **you cannot write "custom models only, and nothing else"** as a distinct
  concept, and there is no way to ask "was this generated by *my specific*
  custom model". The taxonomy deliberately collapses every custom model into one
  `custom` bucket. That is a limit of the API surface, not of this UI.

Related: `major_model_version` is frequently the **empty string** and
`model_name` is sometimes `"chirp-chirp"`, outside the documented taxonomy
(`lib/suno.js:229-231`). That is why `unknown` exists as a real, selectable model
family (`lib/suno.js:61`) and why unknown data maps to it rather than dropping the
clip (`lib/suno.js:250`).

---

## 🚪 11. The side panel is declared but never opened automatically

`manifest.json:12` declares the `sidePanel` permission and `manifest.json:53-55`
declares `default_path`. But **nothing in this repository calls
`chrome.sidePanel.setPanelBehavior`**. Verified: the only `sidePanel` API call
anywhere is `chrome.sidePanel.open` in the popup, behind a user gesture
(`popup/popup.js:1059`).

Chrome's `setPanelBehavior({openPanelOnActionClick: true})` is what makes the
toolbar icon open the panel directly. Without it:

> **The side panel is reachable only from the browser's own side-panel UI**
> (right-click the toolbar → *Open side panel*), or by clicking *Open full panel*
> in the popup.

It works — it just is not one click from the toolbar. The fix is three lines in
the `onInstalled` handler; nobody has written them.

---

## 🗃️ 12. `scratchpad/` is a research bench, not source

The repo carries a large `scratchpad/` directory: unpacked third-party Chrome
extensions and working recon notes. It is **not** referenced by `manifest.json`,
is not loaded by any code path, and is **gitignored** (see `.gitignore:10-17`).

Why the ignore rule exists, stated in the file itself: it holds raw recon captures
and notes that may quote endpoint names, flag lists, or partial response bodies
pulled off Suno's servers. None of that is part of this extension's build and none
of it should leave the machine.

**Do not `git add -f` it. Do not copy anything out of it into `lib/`.**

---

## 🛑 13. There is no `DOWNLOAD_RESUME` route

After a batch ends — for any reason — the only way to pick up the clips that were
**never attempted** is a fresh `DOWNLOAD_START`. There is no route that takes a
batch id and continues from `plan.cursor`.

`DOWNLOAD_RETRY_FAILED` is close but not the same thing: `retryFailedBatch`
(`background/background.js:4324-4340`) reads history rows whose state is
`failed` (`background/background.js:4326`) and re-plans exactly those clip ids. A
clip that was never claimed by the worker has **no row at all**, so it is
invisible to that route. A quota halt is precisely the case that produces such
clips.

The page UI works around this by re-sending the last payload rather than reaching
for a resume verb (`content/content.js:2171-2191`, whose quota-stop button at `:2277` says
*"Re-run this batch after the reset"*). The popup says the same thing in prose
(`popup/popup.js:1570-1586`).

The worker's own journal comment says why the distinction matters: the
`quota-stop` phase exists so a future resume path *"can tell a deliberate quota
halt (keep `cursor`, do not re-plan the rest) from a batch that ran to the end of
its plan"* (`background/background.js:4187-4201`). The information to build that
route is recorded. The route itself is not written.

---

## 📋 14. `DL_DONE` carries no per-clip failure detail

`DL_DONE` reports `ok` / `failed` / `skipped` / `stoppedReason` /
`quotaStop` / `quotaAfter` (`background/background.js:4220-4232`). There is **no
per-clip array**. The `plan.items` array does carry per-item `error` strings, but
it is not in the push — only in the plan that `DOWNLOAD_STATUS` returns.

So a `ladder_exhausted` report can only quote refusals the UI already saw live via
the `DL_ITEM` pushes, and both UIs are explicit that this is a *second-hand* source:

- the page UI walks `state.batch.items`, which it filled from `DL_ITEM`
  (`content/content.js:2286-2309`),
- the popup keeps a bounded list of distinct refusal strings from `DL_ITEM`
  (`popup/popup.js:1442-1450`) and says *"No per-clip reason came back with this
  result"* when the list is empty (`popup/popup.js:1523-1525`).

If the page or popup was closed for the middle of the batch, there is no live
detail to quote and both surfaces say so rather than inventing one. Adding the
array to the push is a protocol change, not a docs change.

---

## 📊 15. `SYNC_STATUS` returns `total` but not `added`

`SYNC_STATUS` answers `{ok, running, cursor, truncated, total}`
(`background/background.js:5274-5285`). `total` is the **library size**, and
`cursor` is the crawl record. Neither carries `added`.

`added` — how many clips *this* crawl actually wrote — exists only on the live
`SYNC_PROGRESS` push (`background/background.js:4633-4642`). So a *polled* status
view can report how many clips you have and how far the crawl got, but **not** how
many the last crawl added. The content script's cursor mapping is explicit about
this: it maps `nextPage → page`, `pagesDone`, `totalSeen → seen` and `state`, and
deliberately leaves `added` and `etaMs` untouched rather than inventing them
(`content/content.js:1903-1919`).

This is a low-severity gap — the live push has it, and a polled view is the
after-the-fact path — but it is a real hole if you ever build a status page that
only polls.

---

## 🌐 16. `host_permissions` and `content_scripts[].matches` disagree

`manifest.json:15-20` asks for four hosts:

```
https://suno.com/*
https://*.suno.com/*
https://*.suno.ai/*        <-- granted, and never contacted
https://*.cloudfront.net/*
```

**No code in this repository contacts any `.suno.ai` host.** Every HTTP call goes
through `SunoAPIClient`, whose base URLs are two exact origins
(`lib/api.js:55-58`) plus the CDN object URLs that come back inside a clip's
`media_urls`. The only other mentions of `.suno.ai` in the tree are:

- `background/background.js:306` and `:312` — a sender-URL allowlist entry and a
  tab pattern, i.e. *inbound* permission, not outbound requests,
- `lib/db.js:383-385` — `cdn1.suno.ai` / `cdn2.suno.ai` inside a **denylist** of
  dead audio hosts (`DEAD_AUDIO_HOSTS`).

Meanwhile `content_scripts[].matches` is only `suno.com` and `*.suno.com`
(`manifest.json:26-29`) — it does **not** include `.suno.ai`, while
`web_accessible_resources[].matches` does (`manifest.json:71-74`).

So the three lists disagree, and one grant is unused. The cheap fix is dropping
`https://*.suno.ai/*` from `host_permissions`; the honest fix is deciding whether
`.suno.ai` is a surface this extension ever intends to touch and making all three
lists say the same thing. Neither is urgent, and neither is a source change you
should make without knowing which way you want it to go.

---

## 🧯 17. A pile of exported-and-unused helpers

Not dead code in the harmful sense — most of these are **internally live** — but
they are exported with **no caller anywhere in this repository**. A future session
should not assume a caller exists, and should not "fix" a bug by editing one and
assuming it runs.

Examples, all verified by grepping every `*.js` outside `lib/db.js`:

| symbol | where | note |
|---|---|---|
| `journal.since(batchId, ts, opts)` | `lib/db.js:2103` | no caller |
| `clips.queryByIndex(name, value, opts)` | `lib/db.js:1348` | the *implementation* calls it at `:2743`; the public method does not |
| `clips.searchTitle(prefix)` | `lib/db.js:1370` | no caller |
| `downloads.pruneCompleted(olderThanMs, opts)` | `lib/db.js:1813` | documented at `lib/db.js:178`, never invoked |

Same story for a handful of `lib/suno.js` legacy-compat aliases — `classify`,
`match`, `filterList`, `search`, `summarize`, `byModel`, `mostPlayed`, `mostLiked`
(`lib/suno.js:1480-1487`) are mirrored onto the static `SunoFilter` for old
callers and none of the current UIs calls them — and for most of `lib/lyrics.js`'s
export surface (`buildLrcForClip`, `buildMetaTxtForClip` at
`lib/lyrics.js:868` / `:890`; the current tag pipeline calls
`buildSidecars`, `background/background.js:3402`).

---

## 💸 18. The free-tier download figure is genuinely unknown

`lib/api.js:959-963` encodes:

| Plan | Limit | Period | Verified |
|---|---|---|---|
| `free` | `null` — **no number reported** | lifetime | **false** |
| `pro` | 20 | month | true |
| `premier` | 60 | month | true |
| `premierPlusStudio` | `null` | none | true |

Pro 20 and Premier 60 are reliable. **Free is not.** The recon account was Premier,
so no free figure was ever observed (`lib/api.js:955-957`). The recon report gives
a policy figure of **7 lifetime**
(`../suno-recon/reports/FINDINGS.md:340`; `../suno-recon/reports/THIRD-PARTY-2026-09-30.md:112`), while
`background/background.js:320` and `:3611` write "free 0". Neither is verified, and
the code is right to refuse to substitute a number — `lib/api.js:2604` turns a
`null` limit into `unlimited: true` rather than inventing a figure.

**Read the badge, not this table, for your own account.**

---

## 🔍 19. `additional_download_remaining` is unexplained

Read **7** on one account and **0** on the recon account, with **no client
reference in 227 chunks** (`../suno-recon/reports/FINDINGS.md:362-365`;
`../suno-recon/README.md:117-119`). It is not a static free-tier grant — it tracks
real remaining overflow. The extension surfaces it as `quota.additionalRemaining`
and folds it into `effectiveRemaining` (`lib/api.js:2609`), so a batch will spend
it.

**Nobody knows what it is.** Do not build a plan around it, and do not spend
downloads experimentally to find out.

---

## 📉 20. Three smaller ones worth knowing

- **An empty spec no longer hides trashed clips.** The old engine dropped them
  implicitly, which silently shrank mass downloads. Use `NO_TRASHED`
  (`lib/suno.js:1520`) or the explicit trashed toggle.
- **`lyrics` is not recon-verified on a clip.** `lib/suno.js:546-548` says so; the
  filter field is kept because `background.js` attaches `lyrics` client-side. Lyric
  search only works for clips that have it.
- **Two discovery gaps are permanent.** The `format` enum (§2) and the ZIP response
  (§3) are both *absence of information*, not bugs. Neither can be fixed by reading
  the code harder — only by re-probing the live API, which is someone else's
  server.

---

## ⚪ Bonus: things that used to be on this page and no longer are

Kept here so nobody re-adds them from memory:

- ~~"There is no mid-batch quota guard."~~ **Fixed in 6.0.1.** See
  [`DOWNLOAD-LADDER.md` § quota semantics](DOWNLOAD-LADDER.md) — the worker now
  re-reads the meter every `quotaCheckEvery` **metered** successes and halts
  cleanly at `quotaReserve`, with `stoppedReason: 'quota'` rendered as four
  distinct outcomes across the popup and the page UI
  (`background/background.js:3866-3939`, `:4150-4232`).
- ~~"The BPM pipeline is dead end-to-end."~~ **Fixed in 6.0.1.** The tempo reaches
  the `{bpm}` filename token, the ID3 `TBPM` frame and the `.json` sidecar field,
  after a client-side offscreen analysis — see
  [`DOWNLOAD-LADDER.md` § format support](DOWNLOAD-LADDER.md). There is
  deliberately still **no BPM range filter**, because the field is 0 on
  essentially every record straight from the feed (`lib/suno.js:857-863`).