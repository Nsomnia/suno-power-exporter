# 🎛️ Known limits — read this before you touch anything

This is the file that saves the next session a week. Every entry below was read
out of the shipped code or the recon ledger, not guessed. If something here
becomes wrong, the code that proves it is named, so you can check.

Order matters: the first item is the one that changes what the extension can do
at all. **28 numbered items, plus a resolved note at the top and a "used to be
here" list at the bottom.**

> 🚨 **Since 6.1.1 there is a second thing to read before you touch auth: items
> 21–24.** Sign-in and the HLS capture both used to be reported as "does not
> work", and both were non-functional until 6.1.1. If you are reasoning about a
> credential or about anything that touches the page's own JavaScript, those four
> items are the current truth.

> 🔄 **Since 6.2.0, read items 25–28 before you reason about the library crawl.**
> Items **4** and **5** used to say the feed page size was unknown and that
> dislike detection needed two crawls. **Both claims are false now** — the crawl
> runs on `POST /api/feed/v3` at up to 100 clips per request, and a single walk
> answers the dislike question. The four items are the honest residue: resume
> granularity, the **`oracleApplied` rule** — including the guarantee it gives up
> — the shared-clip double count and the `totalSeen`/`examined` split that came
> with it, and the one cluster of claims in the whole crawl that is
> **evidence-backed rather than live-verified**. Items 21–24 keep their numbers
> because `ARCHITECTURE.md`, `README.md` and `CHANGELOG.md` cite them by number.

---

## 🎉 Resolved: MP3 and OGG now ship

**This used to be item #1 on this page and it is no longer a limit.** Both
encoders are vendored, byte-identical to upstream, and both transcode paths work:

| | file | size | SHA-256 | licence |
|---|---|---:|---|---|
| **MP3** | `vendor/lame.all.js` — lamejs 1.2.1 | 530,087 B | `026bd888…fea3b` | **LGPL-3.0** |
| **Ogg Vorbis** | `vendor/OggVorbisEncoder.js` — `higuma/ogg-vorbis-encoder-js` @ `7a87242` | 2,358,493 B | `5a9f749a…179b` | **MIT** wrapper + **Xiph BSD** C |

The setting that reaches them is `transcode`, whose clamp is now
`TRANSCODE_FORMATS = ['none', 'wav', 'mp3', 'ogg']`
(`background/background.js:644`, resolved by `resolveTranscode` at `:662`,
applied at `:1189`), with two encoder knobs behind it — `mp3Bitrate`
(`:761`) and `oggQuality` (`:769`), both snapped by `snapToChoice`
(`:1315`, reasoning at `:1301-1314`).

**Where the capability is documented now:**
[`DOWNLOAD-LADDER.md` § format support](DOWNLOAD-LADDER.md) for the format matrix
and the CPU-for-compatibility trade-off,
[`ARCHITECTURE.md` § why the encoders are vendored](ARCHITECTURE.md) for the file
map and the `.gitattributes` policy, and `vendor/README.md` for the full
provenance record.

**What is still true, and is the reason it was hard:** MV3's
`script-src 'self'` (`manifest.json:77-79`) means there is **no "download it if
missing" fallback** — a CDN fetch is forbidden, so `vendor/` has to be *committed*,
and an untracked `vendor/` fails **silently**: the control looks live, the click
succeeds, and no file appears (`offscreen/offscreen.js:863-870` returns a typed
`ENCODER_UNAVAILABLE`, which `OFFSCREEN_FATAL_CODES`
(`background/background.js:3148`) makes permanently non-retryable).
`scripts/check-build.sh` is the thing that catches it, and it now verifies both
digests **parsed out of `vendor/README.md`** rather than restated.

> **Do not re-add "no MP3/OGG" to this page, `README.md`, the ladder doc or the
> architecture doc from memory.** It was true at 6.0.1 and it is false now. The
> *distribution* obligations that came with the encoders are real and are item 12.

---

## 🔤 1. The `format` enum is undocumented, so formats are a guess

**This is the top blocker now.** Everything else on this page is a refinement; this
one decides what you can ask Suno for at all.

The `?format=` value is passed straight through from the caller's string.
`background/background.js:541` is the honest position:

```js
const VARIANTS = Object.freeze(['m4a', 'wav-48k', 'wav']);
```

The value the worker actually sends is whatever the ladder rung was asked for, and
`VARIANT_EXTENSIONS` (`background/background.js:556`) maps it to the extension
written on disk — which is why `wav-48k` lands on `.wav` even though it keeps its
own identity.

### What that means for the format list

| Variant | What it is | Cost |
|---|---|---|
| **`m4a`** | native. The download already *is* an m4a, so no encoder is involved at any point | 🟢 free on rungs 1–2 |
| **`wav-48k`** | a local render with the rate **pinned** to 48000 (`WAV_48K_RATE`, `background/background.js:562`), so the rung stays distinguishable from plain `wav` when `wavSampleRate` moves | 🟢 free — it renders bytes you already have |
| **`wav`** | a local render at `settings.wavSampleRate` through the offscreen `sunoRenderWav` (decode → resample → real RIFF header) | 🟢 free |

The full reasoning is spelled out in the `VARIANTS` comment
(`background/background.js:512-541`), and the load-bearing part is that
**`variant` and `transcode` are two different things**:

> **A distinction that trips people up:** asking Suno for MP3 via the *format*
> dropdown is a **different thing** from encoding to MP3 locally. `variant` selects
> the **download route** — it becomes the route's `?format=` parameter, and it is
> the identity `isDone(id, variant)` and the filename extension are keyed on.
> Because that enum is undocumented, advertising `mp3` there would mean *asking* for
> a format the server may not serve, failing, and falling through the ladder —
> **potentially spending the metered rungs' quota to produce the very file the
> free rungs already gave us.** `transcode` is a post-fetch local step on bytes
> already in hand.

So MP3 and Ogg Vorbis are reachable as `transcode`, and deliberately **not** as
variants. `flac`, `aac` and `opus` have no vendored encoder and no `transcode`
format, so they remain genuinely undeliverable
(`background/background.js:534-535`). `lrc`, `cover` and `json` left the variant
list for a different reason: they are **sidecars, not audio**, controlled by
`tagOptions.lrc`, `tagOptions.artwork` and `tagOptions.json`
(`content/content.js:88-92`, `background/background.js:1195-1203`).

An old stored setting does **not** hard-reset. `VARIANT_ALIASES`
(`background/background.js:581`) is a 13-entry map and `resolveVariant`
(`:609-629`) substitutes the nearest thing this build can produce, logging
`settings.variant_aliased` once per occurrence at debug level with **both**
values, so "I asked for MP3 and got M4A" is answerable from the diagnostics
surface. A hard reset is indistinguishable from "your settings were lost", and it
would also silently move a user who had deliberately chosen a different default.

**No recon source enumerates which values the server accepts.** `lib/api.js`
therefore tallies every value it has tried so the real members can be learned from
telemetry over time (`lib/api.js:1209`, `this._formatTally`). Treat the
non-`m4a` case as *unverified*: the request will be made, the response parsed by
`parseDownloadResponse` (`lib/api.js:2064-2176`), and a refusal surfaces as a typed
error rather than a silent success.

Consequence: **you cannot rely on asking for a format and getting it.** The one
guaranteed-correct container is `m4a`, because the free rungs deliver the source
stream verbatim and it *is* M4A. `wav` and `wav-48k` are honest regardless, because
neither depends on Suno — they are rendered locally from whatever bytes arrived.
MP3 and Ogg Vorbis are honest *by a different route*: they never touch the `?format=`
enum at all, which is exactly why they live under `transcode`.

---

## 📦 2. Bulk ZIP: ≤200 per request is confirmed, the response shape is not

`POST /api/download/clips/zip/prepare`

Confirmed:
- **Flat body.** `../suno-recon/reports/sweep2/write_schemas.md:250` — "wire shape: **flat**
  (confirmed — a flat sentinel body was accepted past validation)".
- **Required field:** `clip_ids`, an array (`../suno-recon/reports/sweep2/write_schemas.md:254-256`).
- **≤200 clips per chunk.** Two independent recon sources agree:
  `../suno-recon/reports/THIRD-PARTY-2026-09-30.md:113` and `../suno-recon/reports/LIVE-2026-09-30.md:467`
  both say "≤200 clips". `lib/api.js:144` encodes `ZIP_CHUNK_SIZE = 200` with the
  comment "CONFIRMED server maximum for clip_ids".
- **POST-only.** A `GET` returns 405 (`lib/api.js:1117`).

Not confirmed:
- **The response body.** `background/background.js:4196-4200` refuses a job-shaped
  response outright: *"the route returned a job id rather than a URL; job polling
  is not implemented"*, typed `job_not_supported`. There is no polling loop, so a
  job response is a dead end.
- **Whether it works at all on your account.** The validator emits the business
  rule `Bulk download is not available` verbatim
  (`../suno-recon/reports/FINDINGS.md:469`; `../suno-recon/reports/sweep2/write_schemas.md:260`), which
  `lib/api.js:182` carries as `BULK_UNAVAILABLE_MARKER`. The recon account hit
  that message.

> ⚠️ **One unresolved conflict, do not paper over it.** `../suno-recon/reports/FINDINGS.md:467-468`
> lists a validator rule `clip_ids must contain between 1 and 100 items` in the
> same business-rules list as `Bulk download is not available` — but it does not
> say which route it belongs to. It may be a different endpoint. Until someone
> re-probes it against `zip/prepare` specifically, the code's 200 is the better
> sourced number (two sources name the route, one does not) and the 100 remains an
> unexplained string.

The rung is also `batchOnly: true` (`background/background.js:453-460`), so
`normalizeLadder` drops it from every single-clip path
(`background/background.js:1229`) and it additionally requires
`allowMeteredExtras` (`background/background.js:1212`). Both rungs marked
`batchOnly` — `zip` and `hls` — are removed unconditionally; the opt-in flag is
not what removes them.

---

## ⏱️ 3. `duration`'s type is unverified, so both shapes are handled

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

## 📄 4. A crawl can be short — and it now says so instead of guessing

**This item used to be "Feed page size is unknown". That is no longer true**, and
neither is the "estimate from pages already done" behaviour it justified. Both
page sizes are settled — v2 is a fixed 20 (observed), v3's body `limit` maxes out
at 100 — and the crawl no longer has to guess whether it reached the end:

- `POST /api/feed/v3` with `{cursor, limit, filters}` and `limit: 100`
  (`lib/api.js:149-153`, `:2331-2340`). A 5,500-clip library is ~55 pages, not 275.
  The page size is a SETTING (`settings.feedPageLimit`, options page → "Feed page
  size", 1–100): 20 is what Suno's own site pages at, 100 is the server maximum
  and ~5× fewer requests.
- **Completion is the feed's own terminal signal, in either of its two verified
  spellings.** A walk is complete when the envelope says "no more": a `next_cursor`
  that is present and null, OR one that is **absent entirely** — which is the same
  stop the shipped web client makes (`nextCursor: l.data?.next_cursor || null`
  fed to `getNextPageParam`, recon `out/chunks/1r1sqgyc3uj2o.js`), and the shape
  every walk on a live account ends on. The omission is published
  (`cursorOmitted` + the envelope's key list on the summary), never swallowed, and
  every other outcome — a failed page, a stuck cursor, a page that added nothing,
  the page cap, a shortfall against a comparable count — still carries one of the
  `stopReason` values. The full table is in
  [`ARCHITECTURE.md` § the state machine](ARCHITECTURE.md).
- **`truncated` is now `!completed`** (`lib/api.js:2493`), not a `maxPages`-only
  flag, and it rides `SYNC_DONE`, `SYNC_ERROR`, `GET_BOOT.sync` and `SYNC_STATUS`.
- `syncMaxPages` is a **per-workspace** cap, default **200**
  (`background/background.js:758`, clamped to 1–2000 at `:1153`).

**The three crawl limits that are still real:**

- **A workspace that fails does not stop the rest.** It is reported **by name**,
  with its own `stopReason`, in a `workspaces[]` row
  (`background/background.js:5924-5937`, `:5962-6057`). A 4,400-clip library with
  one broken project is the good outcome; `0` was the bad one.
- **A page with zero clips that still carries a cursor is an ERROR**, not an
  end-of-feed (`lib/api.js:2425-2433`). The old rule was *"two consecutive empty
  pages end the crawl"*, which read a feed that hiccuped twice as a finished
  library.
- **A forced rebuild buffers up to 25,000 rows in memory** before switching to
  additive writes (`background/background.js:302`, `FULL_REBUILD_BUFFER_CAP`).
  Over that cap it falls back to additive writes and marks the result incomplete
  rather than half-replacing your library
  (`background/background.js:6330-6343`, `:6657-6673`).

> **Why this item still exists at all:** because **"Up to date" over a short
> library" was the worst bug this extension ever shipped**, and a limitation you
> have written down is one you can re-check. It is now *unfalsifiable* rather than
> merely unlikely.

---

## 🔁 5. Detecting dislikes costs one walk — except in the one mode that genuinely needs two

**Suno still exposes no per-clip dislike field.** No `is_disliked`, no
`dislike_count`, no `downvotes`. `lib/suno.js:901-902` reads the caller-supplied
id set plus `clip.disliked` / `clip.is_disliked`, and the comment above says
outright that *"disliked state is NOT a clip field"*.

**What changed is that the SERVER can now be asked.** `/api/feed/v3` carries a
tri-state `disliked` filter whose values are the **strings** `"True"` / `"False"`
/ `"Any"` (`lib/api.js:167-179`, `:2295-2308`), and the crawl stamps that verdict
onto every row it stores (`background/background.js:6327-6329`). So:

| `dislikedMode` | walks | honest cost |
|---|:--:|---|
| `exclude` (**the default**) | **1** | none. `disliked:'exclude'` is **exact** |
| `include` | **1** | none, **but you get no dislike information at all** — a single `Any` walk cannot classify rows it never filtered on, so `dislikedCount` stays `null` rather than being reported as `0` |
| `both` | **2** | two full crawls. This is the only mode that genuinely needs to see the disliked rows |

The two-pass symmetric difference is gone (`lib/api.js:2194-2202`) — not because
the diff was wrong, but because there is nothing left to difference. It also took
a latent bug with it: the old shape **shared one `maxPages` budget across both
passes**, so pass B was silently truncated to whatever pass A left over.

If you use `both`:

- the disliked id set is flushed to `meta.feed.dislikedIds` only every **5 pages**
  (`background/background.js:299`, `DISLIKED_FLUSH_EVERY_PAGES`, applied at
  `:6467-6474`) — persisting a 3,000-id array per page would dominate the crawl,
  but an eviction inside that window loses the tail of the set;
- `cursor.dislikedApproximate` is set when a `'True'` walk did not finish for
  **every** project (`background/background.js:6571-6572`). **Check it** before
  trusting a disliked count as exact.

Full filter mechanics: [`FILTERS.md` § Downvoted](FILTERS.md).

---

## 🗂️ 6. Project (workspace) membership needs a join, and `default` swallows the rest

A workspace **is** a project. The default project is literally
`{"id":"default","name":"My Workspace"}` — the id is `default`
(`lib/suno.js:31`) and the UI label is `My Workspace` (`lib/suno.js:32`).

**Suno has no project field on a clip.** `background/background.js:5581-5583` states
this as the rule: *"Suno has NO project field on a clip; membership is joined from
the project feed."* The join is built from `/api/project/feed`
(`lib/api.js:1087`, shape `{items:[{type,added_at_ms,clip}],next_cursor}`), fetched
**exactly once per sync** at `background/background.js:6244-6278`.

Therefore:
- **Clips outside every project land in the `default` bucket** and are reported
  under the id `default` in facets (`lib/suno.js:1187-1194`).
- Picking any project keeps the unassigned bucket in scope by default
  (`lib/suno.js:466-468`, `includeUnassigned` defaults to `true`) — so a
  "just my Rock project" filter still returns everything unfiled unless you turn
  that off. That default is deliberate: it stops a project pick from silently
  shrinking a mass download.
- If `/api/project/feed` fails, the sync logs a warning and continues
  (`background/background.js:6262-6277`); every clip then reads as unassigned.

> **Collaborative / cross-user workspaces do not exist in prod.** `collab-workspaces`
> is a **staging-only** server flag (`../suno-recon/reports/FINDINGS.md:219`) with **no known API
> surface** — nothing in the verified 23-route table, nothing in the recon bundle.
> Do not build a filter for it.

---

## 🎼 7. `make_instrumental` may be absent, and absence means false

`lib/suno.js:922-925`, verbatim:

> `make_instrumental MAY BE ABSENT on vocal clips -> absent means false.`

So `include.instrumental: false` ("with vocals") is really "the flag is not true",
which also matches any clip where the field is simply missing. The UI says the
same thing to the user (`content/content.js:1101`).

There is a fallback chain: `metadata.make_instrumental`, then `metadata.is_instrumental`
when the first is absent, then `clip.is_instrumental`. The middle one is an
unverified field; the last is likewise unverified. Only the first is recon-grounded.

---

## 🎛️ 8. Stems and multitracks have no clip field — the filter is a text search

There is no `has_stems` / `is_multitrack` on a Suno clip. The extension therefore
implements the stems filter as **a literal search for the word "stems"** in
title / style / prompt / lyrics:

```js
if (f.stems === 'only')   stemsTerms.push({ field:'any', value:'stems', negate:false });
else if (f.stems === 'exclude') stemsTerms.push({ field:'any', value:'stems', negate:true });
```

— `content/content.js:478-481`, merged into the spec's terms.
> **The dock's own label used to be stale here, and no longer is.** An earlier pass
> of this file flagged it: the in-page Disliked hint read *"The SW diffs
> `/api/feed/v2` with `hide_disliked=true` vs false. Costs ~2x sync time."* — which
> described the removed two-pass shape. **That text is gone from
> `content/content.js`** (zero occurrences of `feed/v2` or `hide_disliked` in the
> tree). What it says now (`content/content.js:939`) is: *"No per-clip dislike field
> exists to read, so the sync asks the feed instead: `/api/feed/v3` takes a
> server-side tri-state `disliked` filter … only the sync setting 'both passes'
> costs an extra walk."* The dock's own sync-settings hint at
> `content/content.js:890` says the same thing. **If you are reading a report that
> quotes the old hint, that report describes a build that no longer exists.**

The UI is honest about it (`content/content.js:1109`): *"No clip field exists for
stems, so this is a real search term: the word 'stems' in title/style/prompt/lyrics."*

**This is a deliberate approximation, not a bug to fix in this repo.** Any clip
whose prompt happens to say "stems" matches, and any real stem track whose prompt
does not say the word does not. Do not present this filter as accurate.

---

## 🧬 9. Custom-model attribution has no clip field either

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

## 🚪 10. The side panel is declared but never opened automatically

`manifest.json:12` declares the `sidePanel` permission and `manifest.json:53-55`
declares `default_path`. But **nothing in this repository calls
`chrome.sidePanel.setPanelBehavior`**. Verified: the only `sidePanel` API call
anywhere is `chrome.sidePanel.open` in the popup, behind a user gesture
(`popup/popup.js:1496-1505`).

Chrome's `setPanelBehavior({openPanelOnActionClick: true})` is what makes the
toolbar icon open the panel directly. Without it:

> **The side panel is reachable only from the browser's own side-panel UI**
> (right-click the toolbar → *Open side panel*), or by clicking *Open full panel*
> in the popup.

It works — it just is not one click from the toolbar. The fix is three lines in
the `onInstalled` handler; nobody has written them.

---

## 🗃️ 11. `scratchpad/` is a research bench, not source

The repo carries a large `scratchpad/` directory: unpacked third-party Chrome
extensions and working recon notes. It is **not** referenced by `manifest.json`,
is not loaded by any code path, and is **gitignored** (`.gitignore:14-24`, rule `scratchpad/`).

Why the ignore rule exists, stated in the file itself: it holds raw recon captures
and notes that may quote endpoint names, flag lists, or partial response bodies
pulled off Suno's servers. None of that is part of this extension's build and none
of it should leave the machine.

**Do not `git add -f` it. Do not copy anything out of it into `lib/`.**

---

## ⚖️ 12. Shipping the encoders is a redistribution obligation, not a packaging detail

Both encoders in `vendor/` are third-party code, and both come with terms that bind
whoever distributes this extension. `vendor/README.md` is the full record; this is
the part a future session must not soften.

### The MP3 side: **LGPL-3.0**, and it is the strongest obligation in the repo

`vendor/lame.all.js` is lamejs 1.2.1 (530,087 B,
SHA-256 `026bd888…fea3b`), shipped **byte-identical to upstream**. The licence
position is written out at `vendor/README.md:44-79`:

1. **Dynamic linking, which is what this build does.** The library is never linked
   into `offscreen/offscreen.js`; it stays a separate work, loaded at runtime by
   `loadVendoredScript()` injecting a `<script src="../vendor/lame.all.js">`
   (`offscreen/offscreen.js:797-835`). That is what satisfies the LGPL-3.0 §4
   separability requirement.
2. **The user must be able to replace or remove it.** It is a plain file in the
   extension directory, so a user can delete or substitute another build without
   recompiling or relinking anything.
3. **Any modification must be released under the LGPL.** We ship it unmodified, so
   this does not currently apply — and it is precisely why the files must never be
   "improved" in place.
4. **Attribution must travel with the code.** `vendor/LICENSE-lamejs.txt` plus
   `vendor/README.md` in the extension directory is that notice.
5. **No warranty.** The encoders are covered by their own terms, not this
   extension's.

> **Two honest gaps, carried here rather than hidden.** (a) The `LICENSE` file
> shipped inside the lamejs tarball — saved verbatim as
> `vendor/LICENSE-lamejs.txt` — is **not** the licence text: it is the LAME FAQ
> answer *"Can I use LAME in my commercial program?"*, which says the LGPL applies
> and **names no LGPL version**. So "LGPL-3.0" rests on the npm `package.json`
> and the registry metadata, not on the licence shipped beside the code
> (`vendor/README.md:44-53`, `:75-79`). (b) Nobody audited the origin of lamejs's
> JS port against the upstream LAME C sources. Neither blocks shipping; both are
> the first two questions for a legal review.

### The Ogg side: **MIT + Xiph BSD**, and the BSD text is *referenced*, not shipped

`vendor/OggVorbisEncoder.js` is `higuma/ogg-vorbis-encoder-js` @
`7a872423f416e330e925f5266d2eb66cff63c1b6` (2,358,493 B,
SHA-256 `5a9f749a…179b`). **It is not BSD-3-Clause**, which is what the original
task brief said and what upstream contradicts:

- the repository's `LICENSE.txt` is the **MIT Licence**, © 2015 Yuji Miyane, saved
  verbatim as `vendor/LICENSE-OggVorbisEncoder.txt`; GitHub's own detector agrees
  (`spdx_id: MIT`),
- and the README states a **split** licence that is real rather than a formality:
  the Emscripten-compiled **libogg/libvorbis C is under the 3-clause BSD text at
  <http://www.xiph.org/licenses/bsd/>**, while the **JavaScript wrapper around it
  is MIT** (`vendor/README.md:110-131`).

Both are permissive and both require only that the copyright and permission notice
travel with the source — which is why there is **no relinking, no source offer and
no modification-release obligation** here, unlike the MP3 side.

> **The one gap:** the Xiph BSD text is **referenced by URL and not reproduced
> locally**, so it is not on disk in this repository (`vendor/README.md:133-138`).
> The attribution requirement is met by `LICENSE-OggVorbisEncoder.txt` plus
> `vendor/README.md`, but **a distributor who wants the libogg/libvorbis BSD text
> physically in the package should add it.** That is a real, unclosed item.

### And the byte-integrity obligation on top

Both licences assume the code you redistribute *is* the code upstream published.
`vendor/**  -text` in `.gitattributes` is what enforces that on every platform, and
`scripts/check-build.sh` is what reports it — 77 checks, of which the SHA-256 gate
(`scripts/check-build.sh:322-415`) parses the expected digests **out of
`vendor/README.md`** so the record and the bytes cannot drift apart.

---

## 🛑 13. There is no `DOWNLOAD_RESUME` route

After a batch ends — for any reason — the only way to pick up the clips that were
**never attempted** is a fresh `DOWNLOAD_START`. There is no route that takes a
batch id and continues from `plan.cursor`.

`DOWNLOAD_RETRY_FAILED` is close but not the same thing: `retryFailedBatch`
(`background/background.js:5646-5683`) reads history rows whose state is
`failed` and re-plans exactly those clip ids. A
clip that was never claimed by the worker has **no row at all**, so it is
invisible to that route. A quota halt is precisely the case that produces such
clips.

The page UI works around this by re-sending the last payload rather than reaching
for a resume verb (`content/content.js:2660-2672`, whose quota-stop button says
*"Re-run this batch after the reset"*). The popup says the same thing in prose
(`popup/popup.js:2000-2016`).

The worker's own journal comment says why the distinction matters: the
`quota-stop` phase exists so a future resume path *"can tell a deliberate quota
halt (keep `cursor`, do not re-plan the rest) from a batch that ran to the end of
its plan"* (`background/background.js:5504-5520`). The information to build that
route is recorded. The route itself is not written.

---

## 📋 14. `DL_DONE` carries no per-clip failure detail

`DL_DONE` reports `ok` / `failed` / `skipped` / `stoppedReason` /
`quotaStop` / `quotaAfter` (`background/background.js:5491-5503`, `:5573-5580`). There is **no
per-clip array**. The `plan.items` array does carry per-item `error` strings, but
it is not in the push — only in the plan that `DOWNLOAD_STATUS` returns.

So a `ladder_exhausted` report can only quote refusals the UI already saw live via
the `DL_ITEM` pushes, and both UIs are explicit that this is a *second-hand* source:

- the page UI walks `state.batch.items`, which it filled from `DL_ITEM`,
- the popup keeps a bounded list of distinct refusal strings from `DL_ITEM`
  (`popup/popup.js:1965-1975`) and says *"No per-clip reason came back with this
  result"* when the list is empty (`popup/popup.js:2053`).

If the page or popup was closed for the middle of the batch, there is no live
detail to quote and both surfaces say so rather than inventing one. Adding the
array to the push is a protocol change, not a docs change.

---

## 📊 15. `SYNC_STATUS` returns `total` but not `added`

`SYNC_STATUS` answers `{ok, running, cursor, truncated, total, completed,
stopReason, error, expectedTotal, totalSeen, missing, workspaces}`
(`background/background.js:7459-7486`). `total` is the **library size**, and
`cursor` is the crawl record. Neither carries `added`.

**It does now carry the whole completeness contract** — `completed`, `stopReason`,
`error`, `expectedTotal`, `missing` and `workspaces[]` — both inside `cursor` and
mirrored at the top level, so a poller never has to guess where to look.

`added` — how many clips *this* crawl actually wrote — exists only on the live
`SYNC_PROGRESS` push (`background/background.js:6401-6419`). So a *polled* status
view can report how many clips you have and how far the crawl got, but **not** how
many the last crawl added. The content script's cursor mapping is explicit about
this: it maps `nextPage → page`, `pagesDone`, `totalSeen → seen` and `state`, and
deliberately leaves `added` and `etaMs` untouched rather than inventing them
(`content/content.js:2195-2220`).

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
(`lib/api.js:70-73`) plus the CDN object URLs that come back inside a clip's
`media_urls`. The only other mentions of `.suno.ai` in the tree are:

- `background/background.js:383-395` — the sender-URL allowlist and the tab pattern, i.e. *inbound* permission, not outbound requests,
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
`buildSidecars`, `background/background.js:4694`).

---

## 💸 18. The free-tier download figure is genuinely unknown

`lib/api.js:1143-1151` encodes:

| Plan | Limit | Period | Verified |
|---|---|---|---|
| `free` | `null` — **no number reported** | lifetime | **false** |
| `pro` | 20 | month | true |
| `premier` | 60 | month | true |
| `premierPlusStudio` | `null` | none | true |

Pro 20 and Premier 60 are reliable. **Free is not.** The recon account was Premier,
so no free figure was ever observed. The recon report gives
a policy figure of **7 lifetime**
(`../suno-recon/reports/FINDINGS.md:340`; `../suno-recon/reports/THIRD-PARTY-2026-09-30.md:112`), while
`background/background.js:402` and `:4941` write "free 0". Neither is verified, and
the code is right to refuse to substitute a number — the preflight turns a `null`
limit into "no monthly cap" rather than inventing a figure
(`background/background.js:4956-4991`).

**Read the badge, not this table, for your own account.**

---

## 🔍 19. `additional_download_remaining` is unexplained

Read **7** on one account and **0** on the recon account, with **no client
reference in 227 chunks** (`../suno-recon/reports/FINDINGS.md:362-365`;
`../suno-recon/README.md:117-119`). It is not a static free-tier grant — it tracks
real remaining overflow. The extension surfaces it as `quota.additionalRemaining`
and folds it into `effectiveRemaining` (`lib/api.js:3164-3172`), so a batch will spend
it.

**Nobody knows what it is.** Do not build a plan around it, and do not spend
downloads experimentally to find out.

---

## 📉 20. Three smaller ones worth knowing

- **An empty spec no longer hides trashed clips.** The old engine dropped them
  implicitly, which silently shrank mass downloads. Use `NO_TRASHED`
  (`lib/suno.js:1520`) or the explicit trashed toggle.
- **The crawl is per-workspace and resume is per-workspace.** Four more honest
  limits live in items 25–28: the re-walk cost of an interrupted workspace, the
  oracle's lower bound, the shared-clip double count, and the one crawl claim
  that is evidence-backed rather than live-verified.
- **`lyrics` is not recon-verified on a clip.** `lib/suno.js:546-548` says so; the
  filter field is kept because `background.js` attaches `lyrics` client-side. Lyric
  search only works for clips that have it.
- **Two discovery gaps are permanent.** The `format` enum (§1) and the ZIP response
  (§2) are both *absence of information*, not bugs. Neither can be fixed by reading
  the code harder — only by re-probing the live API, which is someone else's
  server.

---

## 🔑 21. `window.Clerk` on suno.com is UNVERIFIED — the auth strategy is built on the header tap, not on it

**Nobody has confirmed that suno.com publishes `window.Clerk` as a page global.**
Not the recon, not this build, not a browser session anyone recorded. Every
reference to it in the source is a *hypothesis about the page*, and one of them —
`probe`'s `hasClerk` field (`background/background.js:2050-2066`) — exists
precisely so the question can be answered at runtime instead of assumed.

**The auth strategy was therefore rebuilt on something that does not depend on it.**
`auth-tap` passively observes the `Authorization: Bearer <jwt>` header on **Suno's
own** `fetch` / `XMLHttpRequest` calls
(`background/background.js:2149-2387`), and `auth-read`
(`:2388-2450`) reads whatever the tap holds. That is the approach the working
third-party extensions in `scratchpad/extracted/` use, and the reason is not
elegance: **the header is sent whether or not the page also exposes the instance.**
`clerk-token` (`:2451-2583`) is now the *third* rung of the ladder, not the first
— a fallback for the case where `window.Clerk` does exist.

Read the ladder in [`ARCHITECTURE.md` § the ladder](ARCHITECTURE.md). Two honest
statements about it:

- **The tap is the best available strategy, not a verified fact.** Nobody has run a
  recorded capture against a live signed-in suno.com tab and pasted the result here.
  If Suno stopped sending a bearer header, rung (c) would be the only thing left and
  `probe` would say `hasClerk:false` — which is the diagnostic to look at first.
- **`window.Clerk` being absent does not break sign-in.** It only means rungs (a)
  and (b) are doing all the work. Do not "fix" a missing `hasClerk` by reordering
  the ladder.

> ⚠️ **A 12-second wait is a real cost when rung (c) is reached.** It is bounded by
> `CLERK_WAIT_DEFAULT_MS` (`background/background.js:277`, clamped to 500–30,000 ms
> at `:279-281`) and it is **third** precisely so the cheap rungs get first refusal —
> but a caller that hits rung (c) waits up to 12 seconds for its answer.

---

## 👂 22. The auth tap is page tampering, however passive — and so is the HLS patch

Two operations in this build put a hook on Suno's own page. Both are recorded here
rather than described as harmless.

| | `auth-tap` | `hls-patch` |
|---|---|---|
| what it touches | `window.fetch`, `XMLHttpRequest.prototype.open`, `XMLHttpRequest.prototype.setRequestHeader` | `window.MediaSource` |
| when | **on every mount of the dock, unconditionally** | only during an HLS capture, behind `allowHlsCapture` **and** a `window.confirm` |
| read-only? | **yes** — nothing is added to, removed from or rewritten on any request | **no** — it deliberately removes the player's streaming capability |
| always calls through? | **yes** — every inspection is individually wrapped and the original is *always* invoked, so a throwing inspection cannot change the request (`background/background.js:2299-2312`, `:2340-2354`) | n/a |
| reversible? | only by a full page reload | yes — `hls-restore` in a `finally` block, and a failed restore is **reported loudly** (`content/content.js:3288-3360`) |
| risk if it misbehaves | a permanent, unbounded page regression: `fetch`/`XHR` wrapped twice, forever | a page with `MediaSource` destroyed and **no working player** |

The `lib/api.js` header still says *"No page tampering: this file never
monkey-patches `window.fetch` and never injects script"*
(`lib/api.js:58-59`). **That sentence is scoped to `lib/api.js` and is true there.
It is not a claim about the extension** — `background/background.js` §5b does both
things. Do not quote it as one.

**The tap's captured token is readable by same-origin page script.** It lives in a
closure reachable only through the holder's `read()` getter, but that holder lives
on `window` (`background/background.js:2157-2165`, `:2288-2293`). That grants a
same-origin script nothing it does not already have — the JWT is in the page's own
memory and in every outgoing header — and this build sends it nowhere except the
worker, which stores it in `chrome.storage.session`. **It is the page's credential,
not a credential this extension created**, and it is worth being accurate about
rather than implying the closure makes it private.

The HLS side of this is documented where the mechanism is:
[`DOWNLOAD-LADDER.md` § 7 `hls`](DOWNLOAD-LADDER.md).

---

## ⏳ 23. The tap needs the page to make one authenticated request — and whether that self-heals is unproven

**The tap can only capture a header that Suno sends *after* it is installed.** If
the tab has just loaded and Suno has not yet called an authenticated endpoint, there
is nothing to capture, `auth-read` returns *"the auth tap has not captured an
Authorization header yet"* (`background/background.js:2412`), and minting falls
through to the Clerk rung.

This is why `mount()` installs the tap **before** `GET_BOOT`
(`content/content.js:3720-3745`) — the calls that trigger a mint are the very calls
that had no token yet. But it cannot install the tap before the page's *first*
authenticated call, which happens during first paint. **Anything Suno sent before
the dock mounted is gone.**

**Does it self-heal?** Partly, and the honest answer has two parts:

- **In practice, usually yes, by luck of Suno's own behaviour.** The tap persists
  until a reload, and Suno's SPA makes authenticated calls on navigation, so a tab
  you navigate around in will produce a captureable header within a navigation or
  two. `TOKEN_CHANGED` then fires and the panel updates
  (`content/content.js:3897-3900`).
- **Not guaranteed, and not tested as a guarantee.** Nothing in this build forces
  Suno to make a request, and nothing re-installs or re-reads on a timer. If the
  page goes quiet, the extension sits with no token until something triggers a mint
  (`GET_TOKEN_STATUS` mints opportunistically — `background/background.js:7444-7452`).
  **If you land in that state, press *Refresh token* in the dock**, which asks the
  worker to re-run the ladder. The button's own message says re-reading will not
  help by itself and that the tap will catch the next request
  (`content/content.js:1266-1280`).

**Nothing here is a "not signed in" state.** The failure mode to recognise is: panel
says *worker: no token* while you *are* signed in. Press Refresh; if it still says
that, run `probe` from diagnostics and read `hasClerk` and `tapHasToken` — those two
fields separate "the page never sent a bearer header" from "Clerk is not a page
global" from "the tap is not installed".

---

## 🔄 24. The tap is lost on a full reload, and reinstalled — SPA navigation does not lose it

`window.__smAuthTap` lives in the page, so **a full reload destroys it.** So does
the dock being torn down and rebuilt.

**This repairs itself, and the repair is `mount()`** (`content/content.js:3635-3641`,
tap install at `:3745`): a full reload re-runs the content script at
`document_start`, `mount()` waits for `document.body` (`content/content.js:3637-3640`),
and reinstalls the tap before the first mint. There is deliberately **no
`pageshow` / `visibilitychange` reinstall handler**, because that would be a second
mechanism for something that already repairs itself; the worker's `alreadyInstalled`
reply makes the one redundant case (mount reached twice without a reload) harmless
and it is treated as success (`content/content.js:3709-3745`,
`background/background.js:2143-2158` and `:2195-2197`).

**SPA navigation does not lose it.** Suno is a client-side app: a route change does
not reload the document, so the wrappers and the captured token survive it. That is
the normal case and it is why the tap usually "just works" after the first load.

The cost of the reload is the same one as item 23: whatever Suno sent before
`mount()` reinstalled the tap was not captured, and if the reloaded page does not
make another authenticated call, minting falls through to the Clerk rung.

---

## 🔁 25. Resume is per-workspace, so an interrupted workspace starts over

`syncState.feed` is written after **every page**
(`background/background.js:6793`), so an evicted worker resumes instead of
restarting the whole crawl. **The granularity is the workspace, not the page.**

`iterateFeed` accepts **no `startCursor`**. It accepts and explicitly ignores
`startPage`, because `/api/feed/v3` pages by cursor and *"resume at page N"* is not
expressible (`lib/api.js:2233-2237`, `:2280-2286`). So on resume:

- workspaces already in `projectsDone` are **skipped entirely**;
- the workspace that was in flight is **re-walked from `cursor: null`**.

**This is safe and it is not free.** Every write is additive and idempotent by clip
id, so re-walking cannot corrupt the library — but it does re-spend requests, and
on a 3,444-clip workspace an eviction near the end costs a full re-walk.

A resumed run therefore has to **carry the evicted worker's tallies forward**, or
`examined` would restart at `0` while the oracle still counts the whole library and
the resumed run would refuse to call itself complete *precisely because it
resumed*. The carry reads `stored.examined` and `stored.uniqueSeen` **by their own
names** (`background/background.js:6702-6727`).

> ⚠️ **One bound a resume puts on the UNIQUE count.** A skipped workspace's ids are
> not re-walked, so `carriedUniqueSeen` is *trusted* rather than recomputed, and a
> clip living in **both** a skipped and a re-walked workspace is counted twice.
> `examined` and `missing` — the figures the verdict and the contract turn on — are
> exact regardless, and the bound is bounded by the number of skipped projects.

The per-project cursors *are* recorded anyway
(`background/background.js:6911-6912`, `cursors`), so a future client that accepts
a `startCursor` can use them **without another schema change**.

> A row left by the `/api/feed/v2` era carries `nextPage`/`pass`, which mean
> nothing to a cursor walk. They are stripped from every emitted reply
> (`background/background.js:6212-6230`) **and** explicitly nulled on a fresh
> cursor (because `DB.syncState.set` *merges*, so omitting a key leaves the legacy
> value in place — `:6362-6369`). The schema marker is **`SYNC_CURSOR_SCHEMA = 3`**
> (`:314-325`): bumped **for the `totalSeen` split, not for a new crawl shape**,
> because a schema-2 row's `totalSeen` means rows-*examined* while a schema-3 row's
> means *unique clips*, and reading it as the unique count would resume with a
> total larger than the library. A row that claims schema 3 but carries no
> `examined` tally is treated as **not resumable** rather than resumed into a
> fabricated shortfall (`:6445-6457`).

---

## 📉 26. `oracleApplied:false` — the sync can no longer **prove** a shortfall

This replaced an earlier item on this page that said `expectedClipTotal` *"is a
lower bound."* That was true and it was **much weaker** than what is actually
enforced now. Do not re-add it from memory.

### The problem it replaced

`expectedClipTotal` sums every project's reported `clip_count`
(`lib/api.js:2556-2586`). That is a **project row count**. The crawl is a
**filtered walk**. On the default settings it always sends:

| sent on every walk | why |
|---|---|
| `filters.trashed: 'False'` | `includeTrashed` is hard `false` (`background/background.js:6344`) |
| `filters.disliked: 'False'` | the default `dislikedMode:'exclude'` |

**Nothing in the wire contract says `clip_count` omits trashed or disliked rows**,
and if it does not — it is a count from the same store the feed filters — then
**every default-mode sync falls short by exactly trashed + disliked, permanently**,
and tells the user to raise a page cap that was never reached.

### The rule now

**Only a genuinely unfiltered walk may treat a shortfall as a failure.**
`oracleApplied` is decided once, up front, and is one readable expression
(`background/background.js:6536-6555`):

```js
oracleApplied = includeTrashed === true && libraryWireFilter === 'Any';
```

`'Any'` is the string the **server** receives, not the mode key the worker uses
internally, so the test is made on the wire value (`background/background.js:6179`)
— because *"unfiltered"* is a property of the request, not of the setting's name.

| | when `oracleApplied` is `true` | when it is `false` |
|---|---|---|
| `missing` | **checked** | **reported**, and flagged as a lower bound |
| `advisory` | `null` — it was checked | the sentence saying why |
| `completed` | a shortfall makes it **`false`** (`stopReason:'expected_total'`) | a shortfall does **not** touch it |
| the count handed to `iterateFeed` | yes | **no** — otherwise the client flips the walk itself (`background/background.js:6074`) |
| what the UI renders | `5,501 of ~5,502` | `5,501 of ~5,502 — a lower bound, filters applied` |

A workspace whose `clipCount` is `null` — `default` forced into a plan whose
project list arrived without a count (`background/background.js:5946-5948`) — gets
`oracleApplied:false` and **no oracle at all**. It used to report
`completed:true` with no check whatsoever.

### 2026-10-08: the rule was restored in the worker, with ONE carve-out

Between the table above and 2026-10-08, the worker quietly contradicted it twice:
a workspace short of its `clip_count` failed **unconditionally**
(`crawlWorkspace`'s shortfall block), and the run-level `!totalsMet` failed
**every filtered sync** on any account that trashes or dislikes anything — the
"permanent INCOMPLETE on a finished crawl" failure, reproduced. Both are now back
on the §26 rule, with one carve-out each that keeps the historic guard whole:

- **Row level:** a short workspace keeps `completed:true` only when its walk ended
  on the feed's **own terminal signal** (`walkStopReason:'complete'` — an explicit
  null cursor or end-of-feed by omission). A walk that broke and is also short
  still fails, with its own reason leading.
- **Run level:** a filtered run is failed by a shortfall only in the
  **truncation shape**: every comparable workspace short, every walk ended on the
  feed's own signal, and the gaps too large for the filter accounting
  (`unexplainedShortfall`, reported as `suspected_truncation`). That is the exact
  signature of a feed that lied about ending, and it stays fatal.

The 10-20%-truncation scenario cannot slip through: such a crawl either has
workspaces that did not end on their own signal (→ `everyWorkspaceCompleted` is
false), or every walk "ended" while short everywhere by a wide margin (→ the
carve-out fails it loudly).

### 🚨 The guarantee this gives up, stated as a loss

**With `oracleApplied:false` the crawl cannot PROVE that a clip is missing.** The
`advisory` is the only signal, and it is a statement about *which number to
trust* — not a measurement. Before this change the default sync failed loudly on
every single run; after it, it fails loudly only in the one configuration that can
be justified.

That is a deliberate trade: a **permanent false alarm on every account** was
already a lie, and a lie that cries wolf is worse than an admitted gap. But it is
a real reduction in what the extension can *assert*, and it is recorded here
rather than buried.

> ### 🎯 What would restore it, concretely
>
> **One authenticated capture**, on an account holding at least one trashed clip
> and at least one disliked clip, showing that a project's `clip_count` is **not
> greater than** the number of rows an **unfiltered** `POST /api/feed/v3` walk
> returns for that same project — i.e. that the count is the count of what the
> unfiltered feed returns.
>
> Then `includeTrashed:true` + `disliked:'Any'` makes walk and count measure the
> same set, `oracleApplied` becomes `true` for exactly that configuration, and a
> shortfall is **proof** again. Until that capture exists, no default sync fails on
> a number nobody can vouch for. Recorded in the source at
> `background/background.js:6520-6529`.

> **The `~` is still load-bearing. Do not remove it.** Suno's project list is read
> page-by-page and `fetchProjects()` still reads page 1 only
> (`lib/api.js:2524-2532`), so `expectedTotal` is a lower bound *of the projects
> the plan saw*. The crawl itself no longer depends on that: `fetchAllProjects`
> pages `/api/project/me` to the advertised count and reports `complete:false`
> when it cannot prove it reached the end (`background/background.js:5807-5921`),
> and **that** oracle is unaffected by the walk's filters, so it stays fatal.
> The tilde is rendered at `popup/popup.js:479-487`, `side_panel.js:339-346` and
> `content/content.js:2053-2058`.

---

## 🧮 27. A clip in two projects is counted twice by the oracle and once on disk — on purpose

This one looks like a bug and is not. Stated in full because the next session
will otherwise "fix" it — and because **it is the reason `examined` exists as a
name separate from `totalSeen`.**

- The oracle is the **sum of every project's `clip_count`**, and a clip that lives
  in two projects is counted by **both** (`lib/api.js:2578-2586`).
- On disk it is **one row**, because the store is keyed by clip id.
- So the crawl keeps **three** tallies under **three** names
  (`background/background.js:6386-6401`): `examined` (rows walked, repeats
  included — the oracle's operand), and `totalSeen` / `uniqueSeen` (the same
  number twice — the unique clip count, which is what every reply publishes and
  what *"X of ~Y"* has to mean).

**Why the comparison is against `examined` and not against unique ids:** the
oracle double-counts a shared clip and the unique count does not, so comparing the
two would report a **permanent shortfall** on every account that shares a clip
between workspaces — the same *"looks broken forever"* class of bug the crawl
rewrite exists to fix. `missing` is therefore `max(0, expectedTotal - examined)`
(`background/background.js:7060-7067` and `:7174`).

> ### 🚨 And this is exactly what made the UIs lie in the other direction.
>
> Publishing the **unique** count under the name `totalSeen` next to an
> **examined-based** `missing` — and then letting all three UIs re-derive
> `expectedTotal - totalSeen` whenever `missing` came back falsy — produced a
> permanent phantom shortfall. With 20 workspaces × 275 clips and **one** clip in
> two workspaces: `expectedTotal` 5,502, `totalSeen` 5,501, `missing` **0**, and
> the popup printed *"1 clip is missing"* on a **complete** library. The dock
> contradicted itself: banner hidden (`completed === true`), status line
> `INCOMPLETE`.
>
> The rule is now: **`missing` is authoritative whenever the key is present as a
> number, `0` included. Derive it only when the key is entirely absent.**
> `popup/popup.js:325-328` + `:337-338` + `:363-372`,
> `side_panel.js:262-263` + `:283-289`,
> `content/content.js:1968-1969` + `:1991-1999`.

**The visible cost:** the completion banner says `400 of ~5,500` when there may be
fewer than 5,500 *distinct* clips. On an account with heavy cross-project sharing
the gap between the banner and reality is real and is the shared-clip double
count. The row count on disk (`GET_BOOT.library.counts`) is the distinct figure.

---

## 🧪 28. `limit: 100`, the accepted filter keys, and v3's `num_total_results` are evidence-backed, NOT live-verified

Stated plainly because everything else on this page that claims evidence has a
capture behind it. This one does not.

**No authenticated capture of `POST /api/feed/v3` exists in the recon.** The recon
captured the route being *posted to*
(`scratchpad/captured_endpoints.txt:27`) and read the route out of the shipped
bundle (`suno-recon/out/chunks/1r1sqgyc3uj2o.js:5`) — but never a 200 from it.
So these three rest on the bundle plus two working third-party extensions:

| claim | source | strength |
|---|---|---|
| `limit` maxes out at **100** | `scratchpad/extracted/BetterSuno/background.js:43` — *"`/api/feed/v3` rejects limit > 100 (verified 2026-09)"* — and the client encodes and clamps it (`lib/api.js:149-153`) | **third-party verified, not ours** |
| the accepted filter **keys** (`trashed`, `disliked`, `fromStudioProject`, `stem`, `stemComplement`, `sort`, `workspace`) and their **string** tri-states | the bundle's `getWorkspaceDefaultClipBrowserFilters` and `BooleanFilter` (`suno-recon/out/chunks/1r1sqgyc3uj2o.js:5`) | **read out of source, never exercised by us** |
| v3's `num_total_results` **semantics** | **nobody knows**, which is why the client **records it and never enforces it** (`lib/api.js:2385-2392`) | **explicitly not trusted** |

**Two mitigations, both structural rather than hopeful:**

1. **Asking for too large a `limit` is rejected, not silently truncated** — so
   `100` is the *safe* direction to be wrong in. A server that ignored the cap
   would give us more, not fewer.
2. **The crawl's correctness does not rest on `limit` at all.** Completion is a
   null `next_cursor` after at least one page; `limit` only affects how many
   round trips that takes. A too-small `limit` costs time and nothing else.

**And a third, which is why item 26 had to be written the way it is.** The
filters are the same class of claim: `trashed` and `disliked` are *read out of
the bundle*, and **whether `clip_count` excludes the rows they remove is not known
at all**. That is precisely why `oracleApplied` is false on the default
configuration — a filter this build sends but cannot verify against the count must
not be allowed to fail the run. **The honest response to an unverifiable filter
is a lower bound and a sentence, not a fatal comparison.**

**What would settle all of it:** one authenticated `POST /api/feed/v3` and its 200
body, on an account holding at least one trashed and one disliked clip. That is one
request against someone's production server, and the recon's own
ground rules make it a decision rather than a formality
(`../suno-recon/README.md:60-74`).

---

## ⚪ Bonus: things that used to be on this page and no longer are

Kept here so nobody re-adds them from memory:

- ~~"There is no mid-batch quota guard."~~ **Fixed in 6.0.1.** See
  [`DOWNLOAD-LADDER.md` § quota semantics](DOWNLOAD-LADDER.md) — the worker now
  re-reads the meter every `quotaCheckEvery` **metered** successes and halts
  cleanly at `quotaReserve`, with `stoppedReason: 'quota'` rendered as four
  distinct outcomes across the popup and the page UI
  (`background/background.js:5188-5200`, `:5206-5216`, `:5491-5495`).
- ~~"The BPM pipeline is dead end-to-end."~~ **Fixed in 6.0.1.** The tempo reaches
  the `{bpm}` filename token, the ID3 `TBPM` frame and the `.json` sidecar field,
  after a client-side offscreen analysis — see
  [`DOWNLOAD-LADDER.md` § format support](DOWNLOAD-LADDER.md). There is
  deliberately still **no BPM range filter**, because the field is 0 on
  essentially every record straight from the feed (`lib/suno.js:857-863`).
- ~~"MP3 and OGG output do not exist in this build."~~ **Fixed in 6.1.0.** Both
  encoders are vendored, byte-identical, licence-noticed and hash-verified, and the
  `transcode` clamp admits all four values. See the
  **resolved note at the top of this page** and item 12
  for what the redistribution still obliges. **Do not re-add the old claim from
  memory** — it was true at 6.0.1.
- ~~"`transcode` accepts only `none` or `wav`."~~ **Fixed in 6.1.0.** The clamp is
  `TRANSCODE_FORMATS = ['none','wav','mp3','ogg']`
  (`background/background.js:644`), with `mp3Bitrate` and `oggQuality` behind it
  (`:761`, `:769`) and real `<select>` controls on the options page
  (`options/options.html:502-529`).
- ~~"`expectedClipTotal` is a lower bound, not a count."~~ **Superseded in
  6.2.0.** It was true and it was weaker than what is enforced now. The rule is
  **`oracleApplied`** — only a genuinely unfiltered walk may treat a shortfall as a
  failure — and it comes with an `advisory` saying so, plus an honest statement of
  the guarantee it gives up. See item 26. **Do not re-add the old wording.**
- ~~"Sign-in does not work" / "HLS capture does not work."~~ **Both were true at
  6.1.0 and both were fixed in 6.1.1.** The cause was suno.com's CSP refusing to
  execute an inline `<script>`, which an injection helper then reported as success
  — so the `window.MediaSource` patch, its restore, and the `window.Clerk` reader
  were all dead code, and MAIN-world access plus the token path were rebuilt around
  `chrome.scripting.executeScript({world:'MAIN'})`. **If you are reading a report
  from 6.1.0 or earlier that says the panel shows "Not signed in" or that no
  `manifest.m3u8` ever appears, that report describes a build that no longer
  exists.** The current auth limits are items 21–24 above, and they are much
  narrower: the tap may not have captured anything yet, and Clerk may not be a page
  global.