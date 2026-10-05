# Changelog

All notable changes to Suno Master Utility.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

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

The fix is one helper. `bpmFromClip` (`background/background.js:1119-1123`) is now
the only reader, and the analysis reply is read at its real depth
(`background/background.js:2076-2087`). Tempo is a **tag, not a facet** — there is
deliberately still no BPM range filter, because the field is `0` on essentially
every record straight from the feed (`lib/suno.js:857-863`).

**`GET_BOOT.token` was an object; every consumer stringified it.** The reply field
is `{hasToken, expiresAt, secondsRemaining, source, badToken}`
(`background/background.js:1526-1539`). The dock's guard was
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
`resolveVariant` (`background/background.js:517-527`) now substitutes via a
13-entry `VARIANT_ALIASES` map and logs both values at debug level, so "I asked
for MP3 and got M4A" is answerable from diagnostics.

**A quota-stopped batch was reported as "Batch complete".** `DL_DONE` carried
`ok`/`failed`/`skipped` and nothing else, so a batch that halted on the monthly
download allowance — with nothing deleted and clips still planned — produced the
same green success toast as a clean run. `stoppedReason` now distinguishes
`complete` / `quota` / `ladder_exhausted` / `cancelled`
(`background/background.js:4155-4160`) and **both UIs render four distinct
outcomes** (`popup/popup.js:1462-1591`, `content/content.js:2252-2322`).

**The offscreen reply resolver trusted any message ending in `:result`.**
`resolveOffscreenReply` matched on `/:result$/` alone and ran *before*
`validateSender`, so it was reachable by anything that could post on the runtime
channel. Request ids are `'os' + sequence + '-' + Date.now().toString(36)` — a
small, enumerable space — so a guessed in-flight id could settle a waiter with a
chosen payload. The worst case is `sunoBlobUrl`: the forged URL goes straight to
`chrome.downloads.download`. `isOffscreenReply`
(`background/background.js:1872-1889`) now verifies `from`, the protocol string,
the type shape, the id shape, and the sender URL.

> *"The only extension sender is us" reads like an argument. It is an assumption
> about the protocol, not a check.*

**There was no mid-batch quota guard at all.** `quotaPreflight` read the meter
*before* a plan and `runBatch` read it *after*, so nothing checked *during*. A
plan built on a stale reading kept going and then failed item by item on the
metered rungs: a healthy badge, then an opaque wall. `guardQuotaAfterItem`
(`background/background.js:3901-3939`) re-reads the meter every `quotaCheckEvery`
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
(`background/background.js:984-993`). `options/options.js` also kept a
hardcoded nine-variant fallback list for when `state.variants` was empty, which
would have re-offered every removed format.

---

### 🎚️ Changed

- **The audio variants are now exactly three: `m4a`, `wav-48k`, `wav`**
  (`background/background.js:449`). `mp3`, `mp3-256`, `mp3-320`, `flac`, `ogg`,
  `aac`, `opus` are gone from the variant list, and so are `lrc`, `cover` and
  `json` — the last three because they are **sidecars, not audio**, and are
  controlled by `tagOptions.lrc` / `.artwork` / `.json`. Advertising a format this
  build cannot deliver was the worst kind of lie: the UI offered it, the setting
  stored fine, and every download came back `ENCODER_UNAVAILABLE` with the
  original file saved. See
  [`docs/KNOWN-LIMITS.md` § 1](docs/KNOWN-LIMITS.md) — **the MP3/OGG limitation
  itself is unchanged and still true**, it is still the #1 item.
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
Clerk token relay.** Nothing. The extension looked installed and was inert.
`content/content.js:6-18` now documents this as the reason the entire file obeys
one rule: no DOM access anywhere that assumes body exists until `mount()` runs.

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
| **The indexer silently truncated at 20 pages** | a user with 3,000 clips lost 2,000 with **no warning anywhere**. `syncMaxPages` now defaults to 200, is user-tunable, and truncation is surfaced in `GET_BOOT`, the popup banner, the side panel, and the sync cursor — `background/background.js:5178` calls it *"the single most important field in this reply"* |
| **Filter and download-history keys used mismatched format values** | dedupe never matched, so **every batch re-downloaded everything**, and each re-download looked like new work |
| **Download history was written before the download completed** | history rows existed for files that never landed. `chrome.downloads.download()` returning an id means *accepted*, nothing more. `markDone` is now reachable from exactly **two** call sites, both requiring an **observed** completion (invariant A, `background/background.js:33-37`) |
| **The filename builder never appended an extension** | files written with **no extension at all**, so nothing on the user's disk would open. It also hardcoded `{format}` to `wav` regardless of what was requested. The real extension is now always appended (`background/background.js:2286-2288`, `:2379-2380`) |
| **The old filter engine's `includeDisliked: true` EXCLUDED dislikes** | the name says include, the code excluded. It only behaved correctly by accident of a `\|\|` chain (`skipDislikes = skipDislikes \|\| !includeDisliked`). `lib/suno.js:302-306` |
| **30 silent `catch {}` blocks** | an undiagnosable build. Invariant H: **zero empty catch blocks**, every failure logged with enough context (`background/background.js:52-54`) |

Two more from the same audit that are worth naming even though they're smaller:

- **`chrome.downloads.onChanged` failure detection was permanently dead and its
  polarity backwards.** `download.error` is a **string** on the delta item; the old
  build tested a non-existent `errorDetails` field *inside* `state === 'complete'`
  — so failures were only ever supposed to be detectable from inside the success
  case (`background/background.js:2574-2585`).
- **The page token relay validated `origin` but not `source`**, so any same-origin
  script could overwrite the extension's credential **profile-wide**. Both are
  checked now (`content/content.js:2966-2980`).

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
  (`background/background.js:4988-4991`).
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
- **The page token relay validates `origin` *and* `source`** before trusting a
  reply, closing a profile-wide credential-overwrite gap that origin checking alone
  left open.
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

**86 audited defects** across the data layer, the download ladder, the filter
engine and the UI. The full accounting is above — this entry exists so the diff is
readable, not because 5.0.0 had anything worth keeping.

---

## Doc set shipped with 6.0.1

| file | what it is |
|---|---|
| `docs/KNOWN-LIMITS.md` | 20 hard limits, most valuable file in the repo |
| `docs/FILTERS.md` | every filter, its spec key, its verified field, its caveats |
| `docs/DOWNLOAD-LADDER.md` | seven rungs, quota semantics, DRM pipeline, format matrix |
| `docs/ARCHITECTURE.md` | file map, MV3 constraints, message protocol, data flows, IDB schema |
| `docs/RECON-NOTES.md` | the verified-truth ledger — built on, and deliberately refused |

[6.0.1]: #601--2026-10-04
[6.0.0]: #600---2026-10-04
[5.0.0]: #500---the-previous-release