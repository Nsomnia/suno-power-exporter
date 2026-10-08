# 🎸 Suno Master Utility

**Bulk-download your entire Suno library with filters that actually work.**

All your liked songs. Include or exclude the ones you downvoted. Specific
workspaces. Search strings. A specific model generation. Duration, plays, upvotes,
date ranges, instrumental-or-not, remixes, trashed, contests, public-only, exact
clip-id lists — every filter the Suno API can *actually* support, and an honest
account of the three it cannot.

Version **6.2.0** (see [`CHANGELOG.md`](CHANGELOG.md)). Manifest V3.
Chrome 116+.

> **6.2.0 is the release that fixed the library crawl.** A sync over a large
> library indexed 400 of ~5,500 clips and reported **"Up to date"**. It now walks
> every workspace on `POST /api/feed/v3` and cannot report success over a short
> library. → [`CHANGELOG.md` 6.2.0](CHANGELOG.md)

---

## 🤝 The one property this extension is actually built around

Everything else here is a feature. This is the requirement.

> **If the extension does not know, it says so — out loud, with a number.**
>
> No green tick over a library that is short. No "complete" that means "I stopped".
> No count rounded to look settled.

**The headline example is the bug that made this a release.** A user with ~5,500
clips pressed *Sync library*. The extension indexed **400**, and the popup said:

```
✅  Up to date        400 indexed
```

That was not a display bug. The crawl was paging a route Suno's web app has
never called, with a fixed page size of 20, and stopped after 20 pages — while the
21st request **failed** and the error was thrown away on the way to the screen.

### What it says now

The same crawl, on the same account, now renders like this — tile word, then the
count, then the named cause:

```
⚠️  Incomplete

   a page request failed (HTTP 429) · 400 of ~5,500 · 5,100 clips missing
```

and the accessible name, hover text and banner are **one reused string**, so the
three can never describe the same failure differently:

```
The last sync is INCOMPLETE. a page request failed (HTTP 429).
Indexed 400 of ~5,500. 5,100 clips missing.
```

The in-page dock says the same thing in its own register — `Library INCOMPLETE —
the last sync stopped early.` — because the dock is a different surface with a
different amount of room, but **the `stopReason` → English map is byte-identical
in all three files** (`popup/popup.js:263-272`, `side_panel.js:174-183`,
`content/content.js:1866-1877`). That coupling is deliberate and each file says so.

### …and the converse, which is the actual property

The obvious direction is "never say *Up to date* over a short library." That was
the bug. **The harder half is never saying *Incomplete* over a complete one** —
and this build got that wrong too, in a way that is worth showing you because it
is the same defect wearing a different hat.

20 workspaces × 275 clips = **5,502** by Suno's own per-project counts. **One**
clip lives in two workspaces, so 5,501 unique rows are on disk. The crawl did
exactly the right thing:

```
✅  Up to date        5,501 indexed · Suno reports ~5,502
```

and then the UI overrode it:

```
⚠️  INCOMPLETE — 1 clip is missing          ← forever, on a finished crawl
```

**Why.** The worker counts rows **examined** (a clip in two workspaces is walked
twice) and stores clips **once** — so "missing" has to be computed against
*examined*. It was publishing the **unique** count under the same field name, and
all three surfaces then re-did the subtraction themselves. The worker had already
answered `missing: 0`. The UI didn't believe it.

The rule now: **the worker's `missing` is authoritative whenever the key is
present, `0` included.** It is derived only when the key is *entirely* absent —
the legacy-reply case. The root cause was a helper that chose its fallback on
*falsiness*, so a present `0` looked like no answer at all. **A falsy check where
a presence check belongs.** That shape of bug recurs across this codebase, and it
is why a green tick is not the thing to be satisfied about.

> A wrong answer in the cautious direction is **still a wrong answer** — and it is
> the one that teaches you to stop reading the word.

### Three numbers, one glance

The local count, the count Suno itself reports
(from each project's own `clip_count`), and the verdict. The **`~` is load-bearing**
— the count is a lower bound, because Suno's project list is itself read
page-by-page — so the extension renders *"400 of ~5,500"*, not *"400 of 5,500."*

And when the crawl ran with filters — which it always does, trashed and disliked
rows excluded — Suno's per-project count is a **lower bound on the whole
library**, not a target this walk fell short of. The extension says so in words
rather than failing the run over a number nobody can verify. It publishes a
boolean **`oracleApplied`** — *was the shortfall **checked**, or merely
**reported**?* — and a human **`advisory`** sentence carrying the answer, and the
three surfaces render it as a qualifier on the counts:

```
5,501 of ~5,502 — a lower bound, filters applied
```

That is a deliberate **loss of a guarantee**, and the extension documents it as
one: with `oracleApplied:false` the sync can no longer *prove* a clip is missing,
so the advisory is the only signal and it is a statement about **which number to
trust**, not a measurement. What would restore the guarantee is one
authenticated capture proving `clip_count` excludes trashed and disliked rows. →
[KNOWN-LIMITS §26](docs/KNOWN-LIMITS.md).

**"Up to date" is now unfalsifiable over an incomplete library — and "Incomplete"
over a complete one.** There is no code path that produces either. A crawl is
complete only when the server's own cursor says so, and every other outcome
carries a named cause: a page failed, a page came
back empty, the cursor repeated itself, a page added nothing new, the per-workspace
page cap was hit, or Suno's clip count disagrees with what was found **where that
count can be compared against an unfiltered walk**.

The same rule covers the awkward cases people usually leave out:

- one workspace failing **does not lose the other nineteen** — it is named
- a resumed sync **cannot skip pages it never saw**
- a library that *looks* complete but is short **says "Incomplete"**
- a library that *is* complete never **says "Incomplete"**

**This is why the KNOWN-LIMITS page is 28 items long and the sync banner is a
warning instead of a decoration.**

---

## 🚨 Read the limitations first

This is not a footnote. Three things will bite you.

| | What | Where |
|---|---|---|
| 🔤 | **The `?format=` enum is undocumented.** The client passes your string through unchanged and tallies what it has tried. Only `m4a` is guaranteed — and `wav`/`wav-48k` are honest regardless, because they are rendered locally rather than asked for. That is *also* why MP3 and Ogg Vorbis live under **Convert** rather than under the format dropdown. | [KNOWN-LIMITS §1](docs/KNOWN-LIMITS.md) |
| 👎 | **Suno exposes no per-clip dislike field** — but `/api/feed/v3` filters on it server-side, so one walk answers the question and the result is exact. Only the `"index both"` mode genuinely needs two crawls. | [KNOWN-LIMITS §5](docs/KNOWN-LIMITS.md) |
| ⚖️ | **The MP3 encoder is LGPL-3.0, and shipping this extension redistributes it.** Both encoders are vendored byte-identically with their notices, but a distributor inherits a real obligation — and the Xiph BSD text for the Ogg build is referenced by URL rather than reproduced on disk. | [KNOWN-LIMITS §12](docs/KNOWN-LIMITS.md) |

Plus: bulk ZIP's response shape is unknown, `duration`'s type is unverified,
collaborative workspaces don't exist in prod, the free-tier download allowance is
genuinely unknown, **`window.Clerk` is not confirmed to be a page global on
suno.com at all**, and the `/api/feed/v3` contract rests on the shipped bundle plus
two third-party extensions rather than on a live capture. **The full list — 28
items, all of them read out of the shipped code — is
[`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md).**

> 🎉 **MP3 and Ogg Vorbis used to be the #1 limitation on that page and are now a
> shipped feature.** Both encoders are vendored in `vendor/` at the exact upstream
> bytes, `transcode` accepts all four values, and there are two real settings
> behind it (`mp3Bitrate`, `oggQuality`). It costs **CPU and RAM, never a download
> from your monthly allowance**. → [the format matrix](docs/DOWNLOAD-LADDER.md)

That document is the most valuable thing in this repo. It exists so the next
session doesn't rediscover the same walls.

---

## 📦 Install

**Chrome 116 or newer.** (The extension needs `chrome.offscreen`, which landed in
116; `manifest.json:82` declares it.)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select **this directory**
4. **Sign in to [suno.com](https://suno.com) in the same browser profile**

That last step is not optional. The extension gets its Clerk JWT **from the page's
own requests**, not from a cookie. `__session` is HttpOnly and is a different,
Next.js SSR value — sending it as a Bearer token is a bug (`lib/api.js:42-44`).
So: you must be logged in on `suno.com`, in the same profile, in a tab that has
loaded.

**How it actually gets the token** is a four-rung ladder, cheapest first:
read the `Authorization: Bearer …` header off a passive observer of Suno's own
requests; install that observer if it is missing; fall back to polling for
`window.Clerk` inside the page for up to 12 seconds; then re-read the observer in
case the page called an authenticated API while that wait was running. The
observer is installed the moment the dock mounts, before the first call that could
need a token. Two caveats are worth knowing up front: **nobody has confirmed
`window.Clerk` is a page global on suno.com**, and the observer can only capture a
header Suno sends *after* it is installed — so if the panel still says no token,
press *Refresh token*. → [KNOWN-LIMITS §21, §23](docs/KNOWN-LIMITS.md)

> **401 with `exp` still in the future = bad token, not bad session.**
> (`lib/api.js:45-47`) That distinction is surfaced as `error.code` so you know
> which one you have.

---

## ⚡ 60-second start

1. **Sync library** — popup → *Sync library*. Walks **every workspace** on
   `POST /api/feed/v3`, following a server cursor 100 clips at a time, and writes
   each page into IndexedDB as it lands. If a workspace fails, the others still
   finish and the failed one is named.

   **Then read the two numbers next to the sync state.** They are the whole point
   of the honesty guarantee:

   > ### `400 indexed · Suno reports ~5,500`
   >
   > If your library is short, **this is where it says so** — with a count, in
   > plain words, before you find out by downloading 400 songs and wondering where
   > the other five thousand went. A sync that cannot prove it is complete is
   > rendered **`Incomplete`** (never "Up to date"), announces itself through an
   > `aria-live` region, and names the cause: a failed request, a page cap, a
   > repeated cursor, or a workspace Suno counts as bigger than the walk found.
   > See [`KNOWN-LIMITS §4`](docs/KNOWN-LIMITS.md).
2. **Pick your filters** — the dock injected into every `suno.com` page has the
   full catalog; the side panel is faster for browsing and searching.
3. **Hit download** — *Start (current filter)*, or tick rows and *Start (selected
   rows)*.

**Turn on dry run first** if this is your first batch. Settings → *dry run (plan
only, no files)* plans the whole thing and reports what each item would do without
spending a single download (`background/background.js:779`).

And before you commit to a 200-song batch, run **`PROBE_DRM`** on one clip. It is
diagnostic only — no bytes, no quota — and it tells you which rungs would work and
whether any of them is free (`background/background.js:8206-8280`).

---

## 🪜 The download ladder

Seven ordered rungs. The **cost class** is the whole point: how you get the bytes
is a separate decision from whether you're allowed to download them.

| # | rung | mechanism | metered? | notes |
|--:|---|---|:--:|---|
| 1 | `progressive` | a `media_urls` entry with **no `encoding` field** — plain GET | 🟢 **no** | a negative test: missing key == unencrypted |
| 2 | `mango-drm` | rights → AES-GCM unwrap → chunked AES-CTR | 🟢 **no** | *"Never touches the meter."* |
| 3 | `studio` | `GET /api/studio/clip/{id}/download` | 🔴 **yes** | **used to be free — closed server-side 2026-09-09** |
| 4 | `download-route` | `GET /api/download/clip/{id}` | 🔴 **yes** | same refusal contract |
| 5 | `wav-official` | `convert_wav` → signed `wav_file` (TTL 3599 s) | 🔴 **yes** | opt-in · **403 = entitlement, not auth** |
| 6 | `zip` | `POST /api/download/clips/zip/prepare`, ≤200 clips | 🔴 **yes** | opt-in · batch-only · **response shape unknown** |
| 7 | `hls` | page-captured segment reassembly | 🟢 **no** | opt-in · **not a rung** — page manipulation |

> ### ⚠️ TWO RUNGS ARE UNMETERED. THE REST SPEND A MONTHLY ALLOWANCE.
>
> Rungs 1 and 2 are free. Rungs 3, 4, 5 and 6 each cost **one download**, and
> **one song = one download regardless of format** — so downloading M4A *and* WAV
> for the same song still costs exactly one. Budget per **song**, never per format.
>
> The default ladder is `['progressive', 'mango-drm', 'studio', 'download-route']`
> — which means **it will spend quota** on any clip the two free rungs cannot
> deliver. Turn the metered rungs off in settings to see how far a batch gets for
> nothing.

**🪤 The trap:** download routes answer **HTTP 200 with a refusal body** —
`{"ok":false,"reason":"no_permission"}`. **Never branch on `resp.ok`.**

**🪤 The decoy:** `audio_url` is *always* the literal
`https://studio-api.prod.suno.com/api/forbidden`. The real audio is in
`media_urls[]`. The previous build scraped `audio_url`, which is why it could never
actually download music — it saved 111-byte 403 XML under audio filenames.

### 🎚️ Formats: three variants, four conversions — two different things

The **variant** list is exactly `m4a`, `wav-48k` and `wav`
(`background/background.js:555`), and that is a capability decision: a variant
selects the *download route*, and the `?format=` enum behind it is undocumented.

| Variant | What it is | Cost |
|---|---|---|
| `m4a` | native — the download already *is* an m4a, so no encoder is involved at any point | 🟢 free on rungs 1–2 |
| `wav-48k` | a local render with the rate **pinned** to 48000, so it stays distinguishable from plain `wav` | 🟢 free |
| `wav` | a local render at `settings.wavSampleRate` — decode, resample, real RIFF header | 🟢 free |

Separately, the **Convert** setting performs four conversions — `none`, `wav`,
**`mp3`**, **`ogg`** (`background/background.js:644`) — using the two encoders
vendored in `vendor/`:

| Convert | What happens | Cost |
|---|---|---|
| `mp3` | `lamejs` 1.2.1 re-encodes the decoded PCM at `mp3Bitrate` (default **192** kbps) | 🟢 **zero downloads** — CPU + RAM |
| `ogg` | `OggVorbisEncoder` re-encodes it at `oggQuality` (default **0.5** on a 0–1 named-quality scale) | 🟢 **zero downloads** — CPU + RAM |

Both run locally, entirely on your machine: nothing is uploaded and no server is
contacted. The transcode happens **after** the bytes arrive, and every rung it can
be called from is already unmetered, so **it never spends a single download** — it
costs a full decode plus a re-encode (wall-clock CPU) and peak memory for both the
decoded PCM and the encoded output. What it buys is a file that plays everywhere.
**FLAC, AAC and Opus still have no encoder**, so they are genuinely undeliverable.

An old stored setting degrades gracefully through a 13-entry alias map rather than
hard-resetting, and the substitution is logged.

`lrc`, cover art and JSON are **not variants** — they are sidecars written next to
the audio file, and they are toggles in the settings drawer. A standalone
cover-art *file* download is not offered at all, because it needs CDN image
fetches this build does not implement.

**BPM works end to end.** Suno sends no tempo field, so when a clip carries none
the extension measures one from the decoded audio in the offscreen document and
uses it for the `{bpm}` filename token, the ID3 `TBPM` frame and the `.json`
sidecar. A missing tempo is never invented — and there is deliberately **no BPM
range filter**, because the field is `0` on essentially every record straight from
the feed. Tempo is a tag, not a facet.

→ **[Full ladder, quota semantics and the DRM pipeline: `docs/DOWNLOAD-LADDER.md`](docs/DOWNLOAD-LADDER.md)**

---

## 🔍 One honest note on how this was built

This is a rewrite by many hands across parallel sessions, and it still needed a
**dedicated integration audit** before anyone could trust it end to end.

That is not a criticism of the work — it is the interesting part. Every module was
verified *against itself*: each session traced its own entry points, and every
`file:line` citation in the doc set was each checked against the source — 474 of
them at the time of that pass. All of it was correct. What nobody checked was **the
seams**.

A rewrite split across parallel sessions has one characteristic failure mode: each
agent reads the contract it can see and infers the rest. When two agents own
opposite ends of the same field, each concludes the other is handling it. The BPM
pipeline was dead this way for a full release cycle — `lib/suno.js` put `bpm` on
the record, the worker read `clip.bpm` directly at four separate sites and never
saw it, and the offscreen analysis read `reply.bpm` instead of
`reply.analysis.bpm`, so the measurement returned `null` on **every clip**.
Consistently, which is what makes a broken pipeline look like a quiet one.

**Per-file verification cannot catch contract drift between modules.** One session
reading only the contracts found all of it in a single pass — plus a
`GET_BOOT.token` read as a string, a `SYNC_STATUS` cursor read at the wrong nesting
depth (so "Check status" updated nothing at all), a `tagOptions.cover` toggle that
did nothing while silently resetting the six keys that did, variants reverting
without a trace, a quota-stopped batch reported as "Batch complete", an offscreen
reply resolver that trusted any message ending in `:result`, and the complete
absence of a mid-batch quota guard.

→ **The full accounting: [`CHANGELOG.md`](CHANGELOG.md), 6.0.1.**

**And the same shape of failure got through one release after that audit.** In
6.1.0 sign-in was *completely* non-functional — every authenticated call needed a
token, and no token could be minted, for a user who was plainly signed in. The
cause was an injection helper that appended a `<script>` and returned `true`, while
suno.com's CSP refused to execute it, so the HLS patch, its restore and the
`window.Clerk` reader were all dead code with no error anywhere. Three more defects
were stacked behind it before anything worked. → **[`CHANGELOG.md`](CHANGELOG.md),
6.1.1.**

---

## 🎛️ The filter catalog

| group | filters |
|---|---|
| **Reactions** | Liked · Downvoted · Unliked |
| **Where** | Workspaces (projects) · *include unassigned* |
| **What** | 12 model generations, incl. **Custom** and an explicit **Unknown / legacy** bucket |
| **Search** | the full `parseQuery` grammar — see below |
| **State** | Complete / still generating · Public / private · Trashed |
| **Nature** | Instrumental · Remixes · Uploads · AI generated · Contests · Has hook |
| **Numbers** | Duration · Plays · Upvotes · Date range |
| **Exact** | Clip-id paste list · batch index |

### Three things that were wrong before and are right now

**❤️ Liked reads `is_liked` — your own like state. NOT `upvote_count`.**

`upvote_count` is a *public count* of how many people upvoted a song. In a personal
library essentially every clip has at least one, so the old filter matched
**100% of your library** and looked like it was working. If you want a real
"popular" threshold, use the **upvotes min/max** filter — it is a different filter,
reading a different field.

**👎 Downvoted has no field behind it, but the server does the filtering.** There is
no `is_disliked` and no `dislike_count` on a Suno clip. The old build compensated
by paging `/api/feed/v2` **twice** with `hide_disliked` flipped and diffing the id
sets. `/api/feed/v3` has a **tri-state `disliked` filter** instead, so **one walk**
answers the question and the verdict is stamped onto every clip the crawl stores —
which makes the filter exact. Only the *"index both"* mode still costs two walks,
because only that mode needs to see the disliked rows at all.

**📁 A workspace IS a project, and the default one is literally
`{"id":"default","name":"My Workspace"}`.** Suno has **no project field on a
clip** — membership is joined client-side from `/api/project/feed`. Anything not in
a project lands in `default`. *Collaborative* workspaces are a **staging-only**
flag with no known API surface, so there is no filter for them.

### Search grammar

```
"quoted phrases"              title: style: lyrics: prompt: model: project:
-title            negate      -metal      !metal
dream OR synth                a OR b title:x   reads as  (a OR b) AND title:x
```

Operators are **case-sensitive** so ordinary words like `and` and `or` inside a
title are not eaten. Negation is global AND-NOT. Unparseable fragments stay
searchable rather than silently vanishing.

Real examples:

| query | does |
|---|---|
| `style: "dream pop" -metal` | dream-pop style, and not anywhere "metal" |
| `title:"blue hour"` | phrase, title only |
| `project:"My Workspace"` | the unassigned bucket |
| `!instrumental` | exclude anything containing the word |

### 📝 24 presets

`ALL` · `LIKED_ONLY` · `DISLIKED_ONLY` · `NO_DISLIKES` · `V6` · `V6_MINI` · `V5_PLUS`
· `CUSTOM_MODELS` · `INSTRUMENTAL` · `REMIXES` · `NO_TRASHED` · `TRASHED` ·
`UNASSIGNED` · `PENDING` · `COMPLETE` · `PUBLIC_ONLY` · `NO_UPLOADS` · `UNLIKED` ·
`WITH_HOOKS` · `MOST_PLAYED` · `MOST_LIKED` · `RECENT_30_DAYS` + 2 legacy aliases.

**`MOST_PLAYED` and `MOST_LIKED` used to be `{}`** — byte-identical to `ALL`, i.e.
no sorting at all. Picking "most played" returned your library in storage order.
A top-tracks preset that doesn't sort is worse than no preset, because it looks
like it worked.

**`ALL` now means *all*, including trashed.** The old engine dropped trashed clips
implicitly, which silently shrank mass downloads. Use `NO_TRASHED`.

→ **[Every filter, every spec key, every field it reads: `docs/FILTERS.md`](docs/FILTERS.md)**

---

## 🏗️ Architecture at a glance

38,242 lines of JS, HTML and CSS across eight libraries and one orchestrator, plus
2.8 MB of vendored third-party JavaScript. The
libraries take
their dependencies **by injection** — `fetchImpl`, a clock, a logger, an
`indexedDB`, a crypto implementation — rather than reaching for globals, so each
one runs unmodified in the service worker, in a content script, and under node.

```
manifest.json ─ declares permissions + CSP (script-src 'self')

┌─ background/background.js ─ 8284 lines ─ the ONLY orchestrator ──────┐
│  18 numbered sections + §5b. Owns HTTP, storage, the ladder, the    │
│  batch driver, the per-workspace library crawl and its completeness  │
│  verdict, the message router, the lifecycle, and the only MAIN-world │
│  page channel.                                                       │
└───────────────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
   lib/api.js            lib/db.js            lib/drm.js
   24 verified routes    5 IDB stores,        the Mango pipeline
   RateLimiter 4/s       schema v3             rights → AES-GCM →
   typed errors          downloads keyed       chunked AES-CTR →
                         ['clipId','variant']  container verify

   lib/suno.js      lib/crypto.js     lib/tagger.js    lib/lyrics.js    lib/audio.js
   the filter       AES-GCM + CTR     ID3 / MP4       .lrc / .json     decode, resample,
   engine + parser                   metadata        sidecars         BPM, interleave
   + the cursor walk on /api/feed/v3

┌─ offscreen/ ──────────────────────────────────────────────────────────┐
│  A real DOM page, because the worker has no Web Audio and no          │
│  createObjectURL. Decodes, renders WAV, mints blob URLs, and          │
│  loads the two vendored encoders from vendor/ at runtime.            │
└───────────────────────────────────────────────────────────────────────┘

┌─ vendor/ ─────────────────────────────────────────────────────────────┐
│  2.8 MB of UNMODIFIED third-party audio encoders — lamejs 1.2.1       │
│  (LGPL-3.0) and higuma/ogg-vorbis-encoder-js (MIT + Xiph BSD) — with │
│  both licence notices and a SHA-256 recorded in vendor/README.md.    │
│  Committed on purpose: an untracked vendor/ fails silently.           │
└───────────────────────────────────────────────────────────────────────┘

   content/content.js   popup/   options/   side_panel.js
   the in-page dock     toolbar  settings   browse + search
```

### The MV3 constraints, briefly

These are the interesting ones — each removal forced a specific design.

| constraint | solution |
|---|---|
| **No Web Audio in a worker** | offscreen document, lazily created and **proven alive before first use** |
| **No `URL.createObjectURL` in a worker** | `data:` URL below 24 MB, offscreen-minted blob URL above (LRU of 8, revoked on completion) |
| **Workers evicted at ~30 s idle** | all durable state in IndexedDB + `chrome.storage.session`; resumable cursors; a journal; a 30 s alarm armed **only** from `onInstalled`/`onStartup` |
| **`runtime.sendMessage` can't reach content scripts** | every push fans out to `runtime.sendMessage` **and** `tabs.sendMessage` |
| **`window` is undefined in a worker** | a four-line alias shim before `importScripts`. **Load-bearing — don't remove it** |
| **No remote code** | the two audio encoders are **vendored under `vendor/`** and hash-verified, because `script-src 'self'` makes a CDN fetch impossible — so there is no "grab it if missing" fallback to degrade to |
| **A page's CSP forbids inline `<script>`** | MAIN-world access goes through the **worker**, via `chrome.scripting.executeScript({world:'MAIN'})`, which is not subject to the page's CSP. The op is one of six keys in a frozen allowlist — no code string ever reaches the page |

> The `sendMessage` one is worth remembering: the previous build *documented* the
> limitation in a comment and then used only the broken path. **No event ever
> reached the page.** Every push now fans out to both channels.

→ **[File map, the full message protocol, ASCII data flows, the IndexedDB schema
and the batch state machine: `docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**

### 🛡️ The one invariant that matters most

**Never mark a download done because `chrome.downloads.download()` returned an id.**
An id means Chrome *accepted the request*, nothing more.

`downloads.markDone` is reachable from exactly two call sites, and both require an
**observed** completion: the `chrome.downloads.onChanged` listener reporting
`state === 'complete'`, or a startup reconciliation search. The previous build
wrote history rows for files that never landed.

And: if a transfer times out, the row is left `in_progress` **on purpose** —
reconciliation owns it from there.

---

## 🚫 What we deliberately did NOT build

Not "not yet". Deliberately, with reasons.

| not built | why |
|---|---|
| **`/b-side/*` staff routes** | **84 routes, 168 requests, all 404**, anonymous and authenticated. Authorization is by non-deployment. It's the best **disclosure** candidate in the recon — report it, don't use it. |
| **Staging API** (`studio-api-staging.suno.com`) | live and **unauthenticated** — 58 flags vs prod's 47. A misconfiguration **to report**, not a resource. The client enforces a host denylist at construction time, so it cannot be configured away. |
| **`/api/playlist/liked/`** | **does not exist.** The old build paged it and silently got nothing — which is why "liked only" never worked. |
| **`GET /api/feed/v2`** | 🚨 **it answers, and it is still the wrong route.** It appears in **0 of 96** bundle chunks and **0** captures — Suno's web app has never called it — its own `num_total_results` reported **21** for a library of **3,444**, and its page size is a fixed **20**. Enumerating through it indexed **400 clips of ~5,500** and reported success. Removed from the route table outright rather than kept as a "fallback". Library enumeration is `POST /api/feed/v3`. |
| **`suno.com/api/*`** | the web origin does not proxy `/api/*`; every such call 404s. |
| **Reconstructing payloads from 422 `loc` chains** | **fabricated** — a renamed projection. Real bodies are flat. The rights call tries three shapes for exactly this reason. |
| **The Studio-download bypass** | **closed server-side 2026-09-09.** Report it as fixed. Do not present it as an exploit. |
| **`/api/session/` as the model catalogue** | the web branch serves a **stale** list. Use `/api/billing/info/`. |
| **Cross-account data** | never. Not the feed, not search, not unified, not contests. Your account only. |
| **`DELETE` on any route** | never sent. |
| **A "collaborative workspaces" filter** | staging-only flag, no known API surface. |
| **Zip download** | `batchOnly`, opt-in, and the response shape has never been observed. Opt-in and honest rather than offered and broken. |
| **MP3 / OGG as *variants*** | they are reachable, but as `settings.transcode` rather than through the format dropdown. A variant becomes the route's `?format=` parameter, and that enum is undocumented — asking for a format the server may not serve means failing and falling through the ladder, potentially spending the metered rungs' quota to produce the very file the free rungs already gave you. The old build offered them as variants anyway and every download came back `ENCODER_UNAVAILABLE`. |
| **FLAC / AAC / Opus** | no vendored encoder and no `transcode` format for them, so there is no code path that can produce one. Note the trap: the *source* stream is already `m4a-opus`, so a standalone Opus file is not reachable from here at all. |
| **A standalone cover-art file download** | it needs the `image_url` / `image_large_url` CDN fetches, which this build does not implement. Embedded artwork is `tagOptions.artwork` and that one works. |
| **A BPM range filter** | Suno sends no tempo field, so it is `0` on essentially every record straight from the feed. The tempo is *measured* client-side and used for tags; a filter on it would match nothing. |

→ **[The full verified-truth ledger, with citations for every claim above:
`docs/RECON-NOTES.md`](docs/RECON-NOTES.md)**

---

## ⚖️ Ethics & scope

**This is for your own account and your own music.** No exceptions.

- **The rate limit is 4 req/s + jitter by default because that is production.**
  Not because we're cautious — recon used the same number for the same reason
  (`../suno-recon/README.md:74`). It's tunable between 0.2 and 20 req/s
  (`background/background.js:708`, clamped 0.2–20 at `:1162`); leave it alone
  unless you have a reason.
- **Stay inside your own quota.** 20/month on Pro, 60/month on Premier, resets on
  the billing date, no carryover. One song = one download, regardless of format.
- **Suno's ToS exists to make mass export harder.** The September 2026 policy post
  states the limits exist to make it *"harder for bad actors to mass-export music"*
  (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:21-22`). You have your own music already; the
  API is the fastest way to get a clean copy of *your* library, and that is all this
  is for.
- **Reuse your own session only.** The JWT comes from your own signed-in session.
  There is no credential sharing here and no third-party service in the path —
  `lib/api.js` makes every call directly to Suno's own hosts.
- **No remote code, ever.** MV3 forbids it, and that is also why there is no
  telemetry in here. Everything runs locally against Suno and your disk.
- **A staging API you found unauthenticated is a bug to report, not a resource to
  mine.** It is the single most interesting thing in the recon and the correct
  response is one email.

---

## 🛠️ Contributing & verification

**There are no test files in this repository, and that is a deliberate, disclosed
choice.**

Every module was developed with assertion suites run **outside** the repo — against
captured recon payloads and live responses, with the results read back and the
findings folded into the code comments. Nothing was committed, which means **there
is no `npm test`, no CI, and no regression net.** If you change a lib, verify it
against the field names in `docs/FILTERS.md` before you trust it.

There *is* one thing you should run, though, before you load the extension:

```sh
sh scripts/check-build.sh      # 77 checks, exit 0 = the extension should load
```

It exists because **Chrome aborts loading an unpacked extension on the first bad
file and reports several completely different root causes with the same message.**
The one that is worth knowing about: a single raw `U+FFFF` non-character in
`lib/db.js` — the standard IndexedDB prefix-range upper-bound sentinel — produced
*"Could not load file 'lib/db.js' for content script. It isn't UTF-8 encoded."*
It really was valid UTF-8. `iconv`, Python's strict codec and every standard tool
accept it; Chromium's stricter `base::IsStringUTF8` does not, because it rejects
every code point ending in `0xFFFE`/`0xFFFF`. So the checker now replicates
Chromium's exact predicate instead of asking a standard tool, and the sentinel is
written as the `\uFFFF` escape (`lib/db.js:1382`). The same pass now covers all five
`vendor/` files, and the script SHA-256-verifies both encoders against the digests
recorded in `vendor/README.md`.

The code is written to be verifiable by reading: every lib header names its own
invariants, every non-obvious decision cites the defect that caused it, and every
one of the eight hard invariants at the top of `background/background.js:33-54`
exists because breaking it was a real, shipped bug.

Suggested first reads:

1. `docs/KNOWN-LIMITS.md` — before you touch anything
2. `background/background.js:33-54` — the eight hard invariants
3. `lib/api.js:1-56` — the eight hard-won behaviours, in the author's own words
4. `lib/drm.js:1-76` — the DRM pipeline and its two unresolved questions
5. `vendor/README.md` — the encoders' provenance, licences and the API traps

### 📜 Docs map

| file | what it is |
|---|---|
| [`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md) | 🚨 **28 hard limits** (plus the MP3/OGG item, now resolved). Read first. |
| [`docs/FILTERS.md`](docs/FILTERS.md) | every filter, its spec key, its verified field, its caveats |
| [`docs/DOWNLOAD-LADDER.md`](docs/DOWNLOAD-LADDER.md) | the seven rungs, quota semantics, the DRM pipeline, format support |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | file map, MV3 constraints, message protocol, data flows, IDB schema |
| [`docs/RECON-NOTES.md`](docs/RECON-NOTES.md) | the verified-truth ledger: what we built on, what we refused to |
| [`CHANGELOG.md`](CHANGELOG.md) | 6.2.0 vs 6.1.1 vs 6.1.0 vs 6.0.1 vs 6.0.0 vs 5.0.0 — 86 defects in the rewrite, 9 more in the audit, 2 more in the sign-in fix, and 2 that made the library crawl lie |

Upstream recon: [`../suno-recon/`](../suno-recon/) — start at
[`reports/FINDINGS.md`](../suno-recon/reports/FINDINGS.md).

---

**🎹 Go make some noise.**