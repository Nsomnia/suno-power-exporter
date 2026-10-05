# 🪜 The download ladder

Seven rungs, in order, each carrying a **cost class**. The ladder is the single
most important idea in this extension: *how you get the bytes* is a separate
decision from *whether you are allowed to download them*, and conflating the two
is how people accidentally spend a month's allowance on 40 songs.

The table that defines it is `LADDER_RUNGS` at
`background/background.js:331-389`. Nothing else defines a source. If you want to
know what a rung is, read that array.

---

## 🚨 Read this first: two rungs are free, five cost you

| | Rungs | Cost |
|---|---|---|
| 🟢 **UNMETERED** | `progressive`, `mango-drm` | **never touch the download meter** |
| 🔴 **METERED** | `studio`, `download-route`, `wav-official`, `zip` | **one song = one download** |
| ⚪ opt-in | `wav-official`, `zip`, `hls` | only run when `allowMeteredExtras` / `allowHlsCapture` is on |

The default ladder is the four that always work without permission
(`background/background.js:536`):

```js
downloadSource: ['progressive', 'mango-drm', 'studio', 'download-route']
```

**The default therefore does spend quota** — on any clip where the two free rungs
cannot deliver. If you are batching 200 songs, check whether they can first: run
`PROBE_DRM` (see below), or turn the metered rungs off in settings and see how far
the batch gets. `background/background.js:3033` types `ladder_exhausted` when a
clip runs out of rungs.

---

## 🪜 The seven rungs

### 1. `progressive` — 🟢 unmetered

| | |
|---|---|
| **Mechanism** | A `media_urls[]` entry with **no `encoding` field**. Plain GET. |
| **Endpoint** | the CloudFront object itself, `.../1/clip/{id}.m4a` (`lib/api.js:63`) |
| **Metered** | **No.** `background/background.js:332-339` |
| **Produces** | the raw M4A bytes, then optional local WAV render + tags + sidecars |
| **Fails when** | every `media_urls` entry carries an `encoding` field — i.e. every entry is encrypted. The reason string is explicit: *"every media_urls entry carries an `encoding` field, so there is no unencrypted asset"* (`background/background.js:2740-2743`). |
| **Skipped when** | `SunoDRM.pickMediaUrl(clip, {preferUnencrypted:true})` returns nothing with `encrypted === false` (`background/background.js:2779-2781`) |

The detection rule is a **negative** one, which is worth internalising: an asset
is treated as unencrypted precisely when the `encoding` key is *missing*
(`lib/drm.js:24-27` notes BetterSuno filters on exactly `!m.encoding`).

### 2. `mango-drm` — 🟢 unmetered

| | |
|---|---|
| **Mechanism** | Encrypted `media_urls` entry → rights → AES-GCM unwrap → chunked AES-CTR |
| **Endpoint** | `POST /api/mango/rights` (`lib/api.js:939`) + the media CDN |
| **Metered** | **No.** `background/background.js:340-347` — *"Never touches the meter."* |
| **Produces** | decrypted M4A bytes, same downstream path as rung 1 |
| **Fails when** | the clip exposes no usable `media_urls` entry; the rights call fails all three body shapes; or the unwrap fails on both user-key seeds |
| **Skipped when** | no usable `media_urls` entry (`background/background.js:2772-2778`) |

This is the rung that makes "download 300 songs on a free account" possible at
all. The full pipeline is below.

### 3. `studio` — 🔴 metered

| | |
|---|---|
| **Mechanism** | GET the clip's official Studio download |
| **Endpoint** | `GET /api/studio/clip/{id}/download` (`lib/api.js:922`) |
| **Metered** | **Yes — counts as ONE download** (`background/background.js:348-355`) |
| **Produces** | a signed URL handed straight to `chrome.downloads` (`saveUrl`, `background/background.js:2525`) |
| **Fails when** | the server answers **HTTP 200 with a refusal body** — see the trap below. Or returns a job id, which is not implemented (`background/background.js:2875-2877`). |
| **Skipped when** | nothing in the ladder list reaches it, or rung 1/2 already succeeded |

> **This rung used to be free. That is a closed bug, not a feature.**
> A third party documented it serving **42 WAVs without moving the counter** on
> 2026-09-04; Suno closed the gap by 2026-09-09
> (`../suno-recon/reports/FINDINGS.md:357-361`; `../suno-recon/reports/THIRD-PARTY-2026-09-30.md:126-136`).
> Counting is now server-authoritative. **Report it as fixed; do not present it as
> an exploit.**

### 4. `download-route` — 🔴 metered

| | |
|---|---|
| **Mechanism** | GET the generic per-clip download |
| **Endpoint** | `GET /api/download/clip/{id}` (`lib/api.js:923`) |
| **Metered** | **Yes — counts as ONE download** (`background/background.js:356-363`) |
| **Produces** | a signed URL |
| **Fails when** | same 200-with-refusal trap; or a job id |
| **Skipped when** | rung 3 already succeeded, or rungs 1/2 succeeded |

Both metered URL rungs share one code path (`background/background.js:2840-2896`)
and both route through `parseDownloadResponse`.

### 5. `wav-official` — 🔴 metered, opt-in

| | |
|---|---|
| **Mechanism** | Ask Suno to convert to WAV, then fetch the signed S3 URL |
| **Endpoint** | `POST /api/gen/{id}/convert_wav/` → `GET /api/gen/{id}/wav_file/` (`lib/api.js:937-938`) |
| **Metered** | **Yes** (`background/background.js:364-371`) |
| **Gated on** | `allowMeteredExtras === true` — otherwise `normalizeLadder` drops it (`background/background.js:1042`) |
| **Produces** | a genuine WAV, at the source bit depth, from Suno's own pipeline |
| **Fails when** | **403 means ENTITLEMENT, not auth** (`lib/api.js:937`, `background/background.js:367`) — your plan has no WAV, which is a wall, not a bug |
| **Signed URL TTL** | **3599 seconds**, observed (`lib/api.js:969`) |

This is the *only* rung that produces a server-side WAV. The local WAV render
(§"Format support matrix") is a different thing and costs nothing.

### 6. `zip` — 🔴 metered, opt-in, **batch-only**

| | |
|---|---|
| **Mechanism** | Ask Suno to build a ZIP |
| **Endpoint** | `POST /api/download/clips/zip/prepare` (`lib/api.js:935`) |
| **Metered** | **Yes** |
| **Gated on** | `allowMeteredExtras === true` **and** `batchOnly: true` |
| **Body** | **flat**, `clip_ids` array, **≤200 per chunk** |
| **Produces** | ⚠️ **unknown.** The response shape has never been confirmed. |
| **Fails when** | it returns a job id — `background/background.js:2875-2877` refuses: *"job polling is not implemented"*. Or the plan is not entitled: the validator emits `Bulk download is not available` (`../suno-recon/reports/FINDINGS.md:469`). |

`batchOnly` means `normalizeLadder` removes it from every single-clip path
(`background/background.js:1043`), so it can only ever be reached deliberately.
**Treat this rung as experimental.** See KNOWN-LIMITS, section 3 ("Bulk ZIP").

### 7. `hls` — 🟢 unmetered, opt-in, **and not really a rung**

`background/background.js:380-388` is unusually honest about this one:

> *Not a rung: the page captures the stream and hands the segment list over via
> HLS_CAPTURE, which is page manipulation and is therefore opt-in and explicit.*

Calling it from the single-clip ladder **throws**
(`background/background.js:2947-2951`):
*"HLS is not a ladder rung: it needs a segment list captured from the page, which
only the HLS_CAPTURE hand-off can provide."*

| | |
|---|---|
| **Endpoint** | the page's own media segments, reassembled from an init segment + media segments |
| **Metered** | **No** |
| **Gated on** | `allowHlsCapture === true` **in the worker** (`background/background.js:3143-3152`) *and* an explicit confirm in the content script (`content/content.js:2815-2824`) — both sides must agree |
| **Produces** | a fragmented MP4, then tagged and saved like everything else (`captureHls`, `background/background.js:3141`) |
| **Fails when** | `allowHlsCapture` is false → `hls_disabled` with the full explanation; too many segments (> `HLS_MAX_SEGMENTS` = 4000, `background/background.js:3063`, checked at `:3160-3162`); any segment fetch failure |

> ⚠️ **HLS manipulates Suno's page.** The content script temporarily sets
> `window.MediaSource = undefined` **in the page's MAIN world** so Suno's own
> player falls back to a plain fetch, collects the `#EXT-X-MAP` init segment plus
> the media segments, and restores `MediaSource` in a `finally`
> (`content/content.js:2764-2776`). This trips abuse heuristics, which is why it
> is off by default and behind a confirm. It is the only page manipulation in the
> extension; `lib/api.js:41-42` states the API client itself never monkey-patches
> `window.fetch` and never injects script.

---

## 🪤 The trap: HTTP 200 with a refusal body

**Never branch on `resp.ok` for a download route.** Both download routes answer
**HTTP 200** with a body that says no:

```json
{ "ok": false, "reason": "no_permission", "message": "You don't have ..." }
```

`lib/api.js:25-28` leads its own header with this, and
`SunoAPI.parseDownloadResponse` (`lib/api.js:1769-1890`) exists solely to handle
it. The refusal contract is checked **before** any artifact probing
(`lib/api.js:1818`). `background/background.js:2856-2863` calls that parser for
both metered rungs instead of inspecting the response status.

Related, from the same header — **403 means entitlement, not auth**
(`lib/api.js:39`). `SunoApiError.isEntitlementError` is `status === 403`
(`lib/api.js:697-699`), and the batch driver treats `entitlement` as
**never retryable** (`background/background.js:862`).

---

## 🪤 `audio_url` is a decoy. Always. Literally.

For **every** clip, `audio_url` is the constant string:

```
https://studio-api.prod.suno.com/api/forbidden
```

`lib/drm.js:12-13` says it plainly, and `lib/suno.js:36-38` carries the detector:

```js
var DECOY_RE = /forbidden/i;
```

`audioUrlIsDecoy` is computed on every normalized record (`lib/suno.js:1001`) and
the real audio URL is taken from `media_urls[0]`, never from `audio_url`
(`lib/suno.js:1000-1002`).

The real audio is in **`media_urls[]`** — a CloudFront object
`.../1/clip/{id}.m4a` with `content_type: "m4a-opus"` (`lib/drm.js:15-16`).

> **The previous build scraped `audio_url` as if it were a media URL.** That is
> why it could never actually download music: it saved 111-byte 403 XML bodies
> under `.mp3`-ish names and wrote "done" rows for files that were never audio
> (`lib/db.js:369-378` documents the captured evidence). `lib/db.js` now **nulls
> the decoy on persist** and flags it, because storing a poisoned constant would
> force every future reader to re-detect it.

---

## 🔐 The Mango DRM pipeline

Rung 2, as a numbered sequence. `lib/drm.js:23-35` is the reference.

```
1. pickMediaUrl      find the real asset, skipping the decoy.
                     An entry with NO `encoding` field == unencrypted
                     progressive. If one exists, the whole rights detour
                     comes out of the loop.

2. fetchRights       POST /api/mango/rights.
                     Walks RIGHTS_BODY_SHAPES in priority order and stops
                     at the first 2xx. Records which shape won in
                     stats().rights.bodyShape.

3. resolveUserKey    SHA-256 of the bearer token, else of `glt`.
                     Always returns an ORDERED `attempts` array so the
                     caller can retry with the other seed with no extra
                     network round trip.

4. unwrap key + IV   AES-GCM under the user key.
                     AAD is TEXT (`rights.aad || clipId`), utf8 — never
                     base64.

5. probe size        Range: bytes=0-0, parse Content-Range.
                     CloudFront refuses HEAD, so a 1-byte GET is the only
                     way. If the CDN ignores Range and returns 200 with
                     the whole object, the body is cancelled immediately
                     and `rangeIgnored` is recorded.

6. stream media      With progress, with a memory cap.

7. chunked AES-CTR   256 KiB at a time, byte-exact counters.

8. verify container  ftyp / ID3. A failure is a TYPED error, never silent.
```

### Three corrections that are easy to get wrong

**① The CTR counter is a BLOCK counter, not a byte offset.**

This is called out in shouting capitals at `lib/crypto.js:758-767` because it is
the single easiest thing to get wrong:

> *** UNIT OF `delta`: AES BLOCKS, NOT BYTES. ***
> In AES-CTR the counter block counts **blocks**. It advances by one per 16-byte
> block consumed, not by 16.

So a chunk starting at byte offset `o` needs `incrementCounter(iv16, o / 16)` —
**blocks**, not bytes. `incrementCounter` (`lib/crypto.js:787-816`) does the
128-bit big-endian add byte-wise with exact carry propagation, because doing it
in `Number` is wrong past 2⁵³.

The failure mode if you get it wrong: the keystream desynchronises by 16× and
produces **well-formed garbage** — which is precisely why step 8 exists.

`chunkSize` is forced to a multiple of 16 so `o / 16` is always an exact integer
(`lib/crypto.js:833-836`).

**② `toBytes` is for KEY MATERIAL ONLY. Never for the AAD.**

`lib/drm.js:1055-1057`, verbatim:

> `// AAD is TEXT (`rights.aad || clipId`), never base64. Using the key`
> `// decoder here would silently corrupt it.`

So: `toBytes(rights.key)` ✅ · `toBytes(rights.iv)` ✅ ·
`crypto.utf8Bytes(aad)` ✅ · `toBytes(aad)` ❌ **silently corrupts the AAD**, the
unwrap fails, and the error points at AES rather than at the text encoding.

**③ The 422 `loc` chains are fabricated. Ignore them.**

Suno's validation errors report `loc=['body','spec','is_public']`, but
`{"spec":{"is_public":1}}` still returns *Field required* while the flat body
passes validation and reaches the handler (`../suno-recon/reports/sweep2/write_schemas.md:10-15`).
The `loc` is a renamed projection; real bodies are flat.

`lib/drm.js:39-44` says this is exactly why `RIGHTS_BODY_SHAPES` is a **prioritised
list** rather than a reconstruction: *"we never read them."* The three shapes,
in order (`lib/drm.js:108-127`):

| # | name | body |
|---|---|---|
| 1 | `content_params` | `{content_params: {content_id, content_type: 'clip'}}` |
| 2 | `flat` | `{content_id, content_type: 'clip'}` |
| 3 | `minimal` | `{content_id}` |

The sweep never resolved the shape either — every flat attempt still failed
validation (`../suno-recon/reports/sweep2/write_schemas.md:491-494`). **Which shape actually wins is an open
question**, recorded at runtime in `stats().rights.bodyShape`.

---

## 🎚️ Format support matrix

**Exactly three audio variants ship.** `VARIANTS` is
`Object.freeze(['m4a', 'wav-48k', 'wav'])` (`background/background.js:449`), and
that list is a **capability decision, not an omission** — the reasoning is
`background/background.js:421-448`. `GET_LIMITS` publishes it, so a UI should
build its select from *that* rather than from a hardcoded list.

### Works today

| Variant | Mechanism | Cost |
|---|---|---|
| **`m4a`** | native. The `media_urls` stream already *is* `audio/x-m4a` | 🟢 on rungs 1–2 |
| **`wav`** | local render at `settings.wavSampleRate`: offscreen `sunoRenderWav` — decode → resample → real RIFF header (`background/background.js:2167-2181`) | 🟢 free — a local render of free bytes |
| **`wav-48k`** | the same render with the rate **pinned** to 48000 (`wavRateForVariant`, `background/background.js:2119-2123`) so the rung stays distinguishable when `wavSampleRate` moves | 🟢 free |
| **`.lrc`** | timed lyrics, only written when the clip actually has lyrics | 🟢 |
| **embedded cover art** | `APIC` / `covr`, full-size image fetched per clip | 🟢 |
| **`.json`** sidecar | machine-readable clip record. Contains prompt text; **no** token or key material | 🟢 |

The last three are **sidecars, not variants**. They are controlled by
`tagOptions.lrc`, `tagOptions.artwork` and `tagOptions.json`
(`background/background.js:556-564`) and are toggled in the page drawer at
`content/content.js:1165-1173`. A *standalone cover-art FILE* is a different
feature entirely and is not offered, because it needs the `image_url` /
`image_large_url` CDN fetches, which this build does not implement
(`content/content.js:93-96`).

`GET_LIMITS` also publishes `variantAliases` and `wavRungRates`, so a UI can
explain a substitution instead of silently showing a different value than the
user picked (`background/background.js:5116-5135`).

> **Do not rename the M4A blob MIME.** It MUST be `audio/x-m4a`, never
> `audio/mp4` (`lib/drm.js:137-145`): an MP4-family blob declared as `audio/mp4`
> is what Chromium writes to disk as `.m4b` — the file plays, but no desktop
> player opens it. *"Changing this is a one-character outage."*

### Does not work

| Format | Why, exactly |
|---|---|
| **MP3** | MV3 CSP is `script-src 'self'` (`manifest.json:77-79`) — remote code is forbidden, so an encoder cannot be fetched from a CDN. It would have to be vendored at `vendor/lame.all.js` (~1 MB, LGPL). Not present. The offscreen returns a typed `ENCODER_UNAVAILABLE`, which `background/background.js:1840-1847` marks as never-retryable. The settings radio is rendered `disabled` with the reason (`options/options.html:425-427`). |
| **OGG Vorbis** | identical reason; `vendor/OggVorbisEncoder.js` is not present (`offscreen/offscreen.js:176`, `options/options.html:429-430`). |

The pipeline code already knows how to call both encoders
(`offscreen/offscreen.js:888-889`). Only the binary is missing.

### `transcode` is now `none` or `wav`, full stop

`coerceSettings` narrows the setting to exactly those two
(`background/background.js:984-993`). `mp3` and `ogg` used to be *accepted* here,
which meant an imported settings blob could put the worker into a
permanently-failing state — every download attempted a `sunoTranscode`, got
`ENCODER_UNAVAILABLE`, logged, and saved the original instead — while `options.js`
rendered the choice as "None", so the user had no way to see or undo it.

**`wav` never reaches `sunoTranscode` at all.** The `mode === 'wav'` branch is
served by `sunoRenderWav` (`background/background.js:2134-2145`, `:2167-2182`),
which is the only conversion this build can actually perform; `sunoTranscode` is
the mp3 / ogg *encoder*. That branch and its `ENCODER_UNAVAILABLE` handling stay
(`background/background.js:2184-2196`, `:2197-2207`) so a value that *does*
arrive from a corrupted cache is answered honestly instead of silently ignored.
`coerceSettings` admits only `none|wav`, so **no settings value can select it any
more** — it is unreachable by design, and it is kept precisely so
`ENCODER_UNAVAILABLE` is surfaced to the UI rather than swallowed by a silently
skipped branch.

### BPM: measured, never invented — and never filterable

The tempo field is a **working feature** end to end:

- `SunoFilter.normalize()` returns `bpm` (`lib/suno.js:952-956`), taking the first
  of `clip.bpm` / `metadata.bpm` / `metadata.tempo_bpm` that coerces to a
  non-zero number.
- All four read sites in the worker go through one helper, `bpmFromClip`
  (`background/background.js:1119-1123`), so the `{bpm}` filename token
  (`:2312`), the ID3 `TBPM` frame (`:3319`), the `.json` sidecar field (`:3409`)
  and the HLS path (`:2808`) cannot drift apart again. That single helper is the
  fix: the pipeline was dead because four sites each rolled their own coercion.
- Suno sends **no tempo field** in a feed payload, so when `tagOptions.bpm` is on
  and the clip carries none, the worker measures one itself through the offscreen
  document: `detectBpmViaOffscreen` (`background/background.js:2063-2104`) calls
  `sunoAnalyze`, which replies `{ok, analysis:{peakDb, rmsDb, durationSec,
  sampleRate, channels, bpm, bpmConfidence}}`
  (`offscreen/offscreen.js:61-63`, `:966-983`). The tempo lives at
  `reply.analysis.bpm` — **not** `reply.bpm`, and reading the shallow path made
  the function return `null` on every single clip
  (`background/background.js:2076-2087`).

**There is deliberately no BPM range filter.** `normalizeSpec()` has no bpm
predicate and no numeric range, and the comment at `lib/suno.js:857-863` says
why: no recon-verified clip payload carries a tempo field, so `bpm` is 0 on
essentially every record straight from the feed. *"Do not add a BPM range filter
here: it would match nothing, and the field being usually-0 is the absence of
data, not a bug to filter around."* The tempo is a **tag**, not a facet.

### Untested

| | |
|---|---|
| **`?format=` passthrough** | the enum is undocumented — no recon source enumerates the accepted members. `lib/api.js` tallies every value tried so they can be learned from telemetry (`lib/api.js:1020`). `m4a` is the only guaranteed container; `wav`/`wav-48k` are honest because they are rendered locally, not asked for. |
| **ZIP** | response shape unknown; job polling not implemented. See KNOWN-LIMITS, section 3 ("Bulk ZIP"). |
| **HLS** | gated behind `allowHlsCapture` + a page confirm; the reassembly path exists (`background/background.js:3141`) but is not the default path for anything. |

---

## 💸 Quota semantics

| Plan | Limit | Period | Verified |
|---|---|---|---|
| `free` | **no number reported** | lifetime | ❌ **not verified** |
| `pro` | **20** | month | ✅ |
| `premier` | **60** | month | ✅ |
| `premierPlusStudio` | unlimited | — | ✅ |

Encoded at `lib/api.js:959-966`. The recon account was Premier, so the free-tier
figure was never observed — the report gives a *policy* figure of 7 lifetime
(`../suno-recon/reports/FINDINGS.md:340`) and `background/background.js:321`
writes "free 0". **Neither is verified**, and the code is right to refuse to invent
one: a `null` limit becomes `unlimited: true` rather than a substituted number
(`lib/api.js:2604`). Read your own badge.

**The rules, verbatim** (`lib/api.js:964-965`):

> One song = one download, regardless of format. Re-downloading in a different
> format does NOT re-count. Resets on the billing date, no carryover.

### 🧮 Batch per SONG, not per format

This is the arithmetic that matters:

```
200 clips, M4A only          ->  200 downloads
200 clips, M4A AND WAV      ->  200 downloads   (not 400)
200 clips, 4 formats         ->  200 downloads   (not 800)
```

So the batch dedupes by **clip id before anything is spent**
(`background/background.js:3695-3703`), and `duplicatesDropped` is reported in the
plan stats (`background/background.js:3703`, `:3745`). Getting this wrong is the
single most expensive mistake available in this extension.

Suno's stated purpose for the limits: to make it "harder for bad actors to
mass-export music" (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:21-22`). Stay inside your
own quota — see the README's *Ethics & scope* section.

### Credits are a DIFFERENT resource

`getQuota` returns downloads and credits in **separate objects** and never merges
them (`background/background.js:5026-5032`). The old badge showed credits, so a
user at zero downloads saw a healthy badge. The toolbar badge now paints
**downloads remaining** in violet (`paintQuotaBadge`,
`background/background.js:5046-5058`).

### Preflight, the mid-batch guard, and four outcomes

There are **two** checks now, and the second one is the interesting one.

**1. The preflight** — `quotaPreflight` (`background/background.js:3634-3660`)
runs once before the plan and compares `planned` against
`quota.effectiveRemaining`. On a shortfall it returns the exact sentence: *"This
batch needs N downloads but only M remain before the quota resets on `<date>`."*
When Suno reports no limit at all it proceeds and says so
(`background/background.js:3647-3650`). The shortfall is logged at **`warn`**
(`batch.quota_shortfall`, `background/background.js:3762`), which is the severity
its amber paint implies — an allowance running out is a warning, not an error.

A before-check cannot be the whole answer: a plan of 60 clips checked against 60
remaining is still wrong the moment one clip fails, another succeeds off an
unmetered rung, or a sibling tab spends the meter.

**2. The mid-batch guard** — `guardQuotaAfterItem`
(`background/background.js:3901-3939`), armed at `:3866-3880`. Two rules make it
cheap enough to always have on:

| rule | why |
|---|---|
| it counts only **successful metered** downloads (`metered !== true` returns early, `:3904-3906`) | `progressive` and `mango-drm` never consume the allowance, so a purely-unmetered batch polls **zero** times and never pays for a re-meter it cannot use |
| a **failed poll is not an exhausted meter** (`:3915-3920`) | `unlimited`, a missing limit and a thrown fetch all leave the batch running. Only a **positive** reading at or below the reserve stops it |
| a dry run polls nothing (`:3866-3869`) and can never be stopped by this | planning must not cost a meter read |
| one in-flight fetch is shared across the pool (`:3879-3892`) | N workers finishing together trigger **one** `readQuotaCached`, not N |

Two settings keys control it (`background/background.js:597-614`, clamped at
`:999-1000`, wired to real controls at `options/options.html:150-167`):

| key | range | default | meaning |
|---|---:|---:|---|
| `quotaReserve` | `[0, 10000]` | `0` | the floor the guard stops **at**: `remaining <= quotaReserve` ends the batch cleanly. 0 = "stop the moment the meter is empty" |
| `quotaCheckEvery` | `[1, 100]` | `5` | re-read the meter at most once per N successful **metered** downloads. 0 is clamped up to 1 because polling on every item is a quota-hammering loop |

**When it stops**, `runBatch` records `quotaStop =
{reason, remaining, reserve, meteredDownloads, remainingItems, resetsOn, at}`
(`background/background.js:3922-3930`), halts claiming new items while in-flight
workers finish the item they already own (`:4131-4133`), writes a **separate
`quota-stop` journal phase** so a later run can tell a deliberate halt from a
batch that ran out of plan (`:4187-4201`), raises a notification saying how much
fitted and when the meter returns (`:4241-4248`), and emits `DL_DONE` with:

```
stoppedReason : 'complete' | 'quota' | 'ladder_exhausted' | 'cancelled'
quotaPolls    : how many meter reads the guard actually cost
remainingItems: how much of the plan is still unattempted
quotaStop     : the reading above, or null
```

The ternary is at `background/background.js:4155-4160`, and it is the one field
that must never collapse the four cases into each other — a quota halt, an
exhausted ladder and a user cancel have three different recoveries.

**Both UIs render four distinct outcomes**, not one green success. The popup names
the outcome in its **headline**, so a cancelled or quota-stopped batch can never be
opened with the word "finished"
(`popup/popup.js:1479-1486`):

| `stoppedReason` | popup headline |
|---|---|
| `complete` | `Batch complete` |
| `quota` | `Batch stopped — download allowance reached` |
| `ladder_exhausted` | `Batch failed — every source refused these clips` |
| `cancelled` | `Batch cancelled` |

The per-outcome detail that follows each headline:

| `stoppedReason` | popup | page UI |
|---|---|---|
| `complete` | success summary | cleared banner + count toast |
| `quota` | amber warning: what was saved, what is still planned, the meter reading, the reserve, how many more would fit, when it resets, how many polls it cost (`popup/popup.js:1494-1516`) | amber banner with the same facts plus **"Re-run this batch after the reset"** (`content/content.js:2256-2284`) |
| `ladder_exhausted` | red: every rung refused, with the per-clip reasons it recorded live from `DL_ITEM` (`popup/popup.js:1517-1527`) | red banner + per-reason detail from the live items (`content/content.js:2286-2309`) |
| `cancelled` | neutral, "not an error" (`popup/popup.js:1528-1533`) | neutral note (`content/content.js:2311-2317`) |

The popup also reconstructs the outcome from a `DOWNLOAD_STATUS` re-read when it
was closed mid-batch, using the worker's own rule, because `DOWNLOAD_STATUS` is the
only route that carries `plan.stoppedReason` / `plan.quotaStop`
(`popup/popup.js:1392-1402`, `:1120-1189`).

> ⚠️ **One honest gap:** there is **no `DOWNLOAD_RESUME` route.**
> `DOWNLOAD_RETRY_FAILED` re-plans only the clips recorded `failed`
> (`background/background.js:4324-4340`), so after a quota halt the
> never-attempted clips need a fresh `DOWNLOAD_START`. The page UI works around
> this by re-sending the last payload. See KNOWN-LIMITS, section 13.

---

## 🔎 Probe before you spend

`PROBE_DRM` (`background/background.js:5501-5548`) is **diagnostic only**: it
downloads nothing and spends nothing. Give it a clip id and it returns:

- `audioUrlIsDecoy` — almost always `true`, and worth seeing once
- `mediaUrlCount`
- per-rung `{id, available, metered, reason}`
- `recommended` — the first available rung
- `free` — the first available **unmetered** rung ← *this is the one you want*
- `metered` — the first available rung that **costs** a download, so you can say
  what the honest-but-paid alternative is (`background/background.js:5541-5544`)

It also accepts an **optional `{ladder:[...]}`** to probe a hypothetical ordering
instead of the configured one (`background/background.js:5519-5528`) — a UI asking
"would studio work if I enabled it?" cannot get a real answer from a ladder that
has studio filtered out, and enabling it just to ask would be a side effect this
route promises not to have. `clipId` is the only required field.

`evaluateLadder` (`background/background.js:2720-2756`) produces those reasons,
and they are written to be read by a human, not parsed. If the clip is not in the
local library it says so and tells you to run a sync first.

---

## ⚙️ Ladder settings

Ordered preference, first **available** rung wins (`background/background.js:535`).

`normalizeLadder` (`background/background.js:1028-1058`) folds legacy aliases
(`LADDER_ALIASES`, `background/background.js:408-419`) so a stale settings blob
cannot silently disable everything. Three subtleties:

- `hls` is deliberately **not** mapped to a working fallback.
- Every `batchOnly` rung is dropped **unconditionally** (`:1043`), not gated on
  the opt-in flag — so a stored `['hls']` normalises to empty, and `hls` is
  documented as *"not a rung"* rather than as "unsupported".
- An **empty** input means "not configured" → the default ladder. A **non-empty**
  input that filters down to nothing returns `[]` and `startBatch` fails loudly
  with `ladder_empty` (`background/background.js:3682-3687`) rather than silently
  re-enabling rungs the user turned off.

**Both rung editors filter that pool to match.** The options page's
`editableRungs()` drops `hls` and every `batchOnly` rung
(`options/options.js:498-502`), and the in-page dock's "available rungs" list
applies the same two exclusions (`content/content.js:1308-1323`). The two are
**duplicated rather than imported**, because a content script and an extension page
are separate contexts with no shared module graph. The point of the exclusion is
that a `batchOnly` rung would otherwise be offered with a live-looking *Enable*
button that saves and then silently deletes the rung it just added — a control that
looks live and is not.

Full settings reference: the options page, `options/options.html:127-146`
(`#opt-ladder` for the ordered list, `#opt-metered-extras` for the opt-in gate).

---

**Next:** [← FILTERS](FILTERS.md) · [ARCHITECTURE](ARCHITECTURE.md) ·
[RECON-NOTES](RECON-NOTES.md) · [KNOWN-LIMITS](KNOWN-LIMITS.md) ·
[← README](../README.md)