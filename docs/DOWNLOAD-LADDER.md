# 🪜 The download ladder

Seven rungs, in order, each carrying a **cost class**. The ladder is the single
most important idea in this extension: *how you get the bytes* is a separate
decision from *whether you are allowed to download them*, and conflating the two
is how people accidentally spend a month's allowance on 40 songs.

The table that defines it is `LADDER_RUNGS` at
`background/background.js:394-470`. Nothing else defines a source. If you want to
know what a rung is, read that array.

---

## 🚨 Read this first: two rungs are free, five cost you

| | Rungs | Cost |
|---|---|---|
| 🟢 **UNMETERED** | `progressive`, `mango-drm` | **never touch the download meter** |
| 🔴 **METERED** | `studio`, `download-route`, `wav-official`, `zip` | **one song = one download** |
| ⚪ opt-in | `wav-official`, `zip`, `hls` | only run when `allowMeteredExtras` / `allowHlsCapture` is on |

The default ladder is the four that always work without permission
(`background/background.js:687`):

```js
downloadSource: ['progressive', 'mango-drm', 'studio', 'download-route']
```

**The default therefore does spend quota** — on any clip where the two free rungs
cannot deliver. If you are batching 200 songs, check whether they can first: run
`PROBE_DRM` (see below), or turn the metered rungs off in settings and see how far
the batch gets. `background/background.js:5477-5484` types `ladder_exhausted` when a
clip runs out of rungs.

---

## 🪜 The seven rungs

### 1. `progressive` — 🟢 unmetered

| | |
|---|---|
| **Mechanism** | A `media_urls[]` entry with **no `encoding` field**. Plain GET. |
| **Endpoint** | the CloudFront object itself, `.../1/clip/{id}.m4a` (`lib/api.js:66`) |
| **Metered** | **No.** `background/background.js:427-432` |
| **Produces** | the raw M4A bytes, then optional local WAV render + tags + sidecars |
| **Fails when** | every `media_urls` entry carries an `encoding` field — i.e. every entry is encrypted. The reason string is explicit: *"every media_urls entry carries an `encoding` field, so there is no unencrypted asset"* (`evaluateLadder`, `background/background.js:4074-4079`). |
| **Skipped when** | `SunoDRM.pickMediaUrl(clip, {preferUnencrypted:true})` returns nothing, or returns something whose `encrypted !== false` (`runLadderRung`, `background/background.js:4108-4116`) |

The detection rule is a **negative** one, which is worth internalising: an asset
is treated as unencrypted precisely when the `encoding` key is *missing*
(`lib/drm.js:24-27` notes BetterSuno filters on exactly `!m.encoding`).

### 2. `mango-drm` — 🟢 unmetered

| | |
|---|---|
| **Mechanism** | Encrypted `media_urls` entry → rights → AES-GCM unwrap → chunked AES-CTR |
| **Endpoint** | `POST /api/mango/rights` (`lib/api.js:1121`) + the media CDN |
| **Metered** | **No.** `background/background.js:433-438` — *"Never touches the meter."* |
| **Produces** | decrypted M4A bytes, same downstream path as rung 1 |
| **Fails when** | the clip exposes no usable `media_urls` entry; the rights call fails all three body shapes; or the unwrap fails on both user-key seeds |
| **Skipped when** | no usable `media_urls` entry (`background/background.js:4110-4113`; the `PROBE_DRM` reason string is at `:4080-4085`) |

This is the rung that makes "download 300 songs on a free account" possible at
all. The full pipeline is below.

### 3. `studio` — 🔴 metered

| | |
|---|---|
| **Mechanism** | GET the clip's official Studio download |
| **Endpoint** | `GET /api/studio/clip/{id}/download` (`lib/api.js:1105`) |
| **Metered** | **Yes — counts as ONE download** (`background/background.js:443-447`) |
| **Produces** | a signed URL handed straight to `chrome.downloads` (`saveUrl`, `background/background.js:3847-3860`) |
| **Fails when** | the server answers **HTTP 200 with a refusal body** — see the trap below. Or returns a job id, which is not implemented (`background/background.js:4209-4214`). |
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
| **Endpoint** | `GET /api/download/clip/{id}` (`lib/api.js:1106`) |
| **Metered** | **Yes — counts as ONE download** (`background/background.js:448-453`) |
| **Produces** | a signed URL |
| **Fails when** | same 200-with-refusal trap; or a job id |
| **Skipped when** | rung 3 already succeeded, or rungs 1/2 succeeded |

Both metered URL rungs share one code path (`background/background.js:4287-4407`)
and both route through `parseDownloadResponse`.

### 5. `wav-official` — 🔴 metered, opt-in

| | |
|---|---|
| **Mechanism** | Ask Suno to convert to WAV, then fetch the signed S3 URL |
| **Endpoint** | `POST /api/gen/{id}/convert_wav/` → `GET /api/gen/{id}/wav_file/` (`lib/api.js:1119-1120`) |
| **Metered** | **Yes** (`background/background.js:458-464`) |
| **Gated on** | `allowMeteredExtras === true` — otherwise `normalizeLadder` drops it (`background/background.js:1243`) |
| **Produces** | a genuine WAV, at the source bit depth, from Suno's own pipeline |
| **Fails when** | **403 means ENTITLEMENT, not auth** (`lib/api.js:1119` notes it at the route; `SunoApiError.isEntitlementError` at `:869`; applied at `background/background.js:4243-4249`) — your plan has no WAV, which is a wall, not a bug |
| **Signed URL TTL** | **3599 seconds**, observed (`lib/api.js:1120`) |

This is the *only* rung that produces a server-side WAV. The local WAV render
(§"Format support matrix") is a different thing and costs nothing.

### 6. `zip` — 🔴 metered, opt-in, **batch-only**

| | |
|---|---|
| **Mechanism** | Ask Suno to build a ZIP |
| **Endpoint** | `POST /api/download/clips/zip/prepare` (`lib/api.js:1117`) |
| **Metered** | **Yes** |
| **Gated on** | `allowMeteredExtras === true` **and** `batchOnly: true` |
| **Body** | **flat**, `clip_ids` array, **≤200 per chunk** |
| **Produces** | ⚠️ **unknown.** The response shape has never been confirmed. |
| **Fails when** | it returns a job id — `background/background.js:4209-4214` refuses: *"job polling is not implemented"*. Or the plan is not entitled: the validator emits `Bulk download is not available` (`../suno-recon/reports/FINDINGS.md:469`). |

`batchOnly` means `normalizeLadder` removes it from every single-clip path
(`background/background.js:1244`), so it can only ever be reached deliberately.
**Treat this rung as experimental.** See KNOWN-LIMITS, section 2 ("Bulk ZIP").

### 7. `hls` — 🟢 unmetered, opt-in, **and not really a rung**

`background/background.js:466-470` is unusually honest about this one:

> *Not a rung: the page captures the stream and hands the segment list over via
> HLS_CAPTURE, which is page manipulation and is therefore opt-in and explicit.*

Calling it from the single-clip ladder **throws**
(`background/background.js:4283-4287`):
*"HLS is not a ladder rung: it needs a segment list captured from the page, which
only the HLS_CAPTURE hand-off can provide."*

| | |
|---|---|
| **Endpoint** | the page's own media segments, reassembled from an init segment + media segments |
| **Metered** | **No** |
| **Gated on** | `allowHlsCapture === true` **in the worker** (`background/background.js:4477-4493`) *and* an explicit `window.confirm` in the content script (`confirmHls`, `content/content.js:3370-3401`) — both sides must agree |
| **Produces** | a fragmented MP4, then tagged and saved like everything else (`captureHls`, `background/background.js:4477-4500`) |
| **Fails when** | `allowHlsCapture` is false → `hls_disabled` with the full explanation; too many segments (> `HLS_MAX_SEGMENTS` = 4000, `background/background.js:4399`, checked at `:4496-4498`); any segment fetch failure |

#### 🚨 This rung was completely non-functional until 6.1.1. Say so plainly.

**The capture path did not work, and it failed silently.** The mechanism requires
setting `window.MediaSource = undefined` in the page's MAIN world. The previous
build did that by building a `<script>`, assigning `.textContent` and appending it —
and **suno.com's CSP refuses to execute an inline `<script>`**. The append
*succeeded*, so the helper returned success while nothing ran. Consequences:

- **The patch never landed**, so Suno's player never fell back to a plain fetch, so
  **no `manifest.m3u8` ever appeared**.
- `runHlsCapture` then did exactly what it was written to do: polled for **20
  seconds** (`content/content.js:3429-3430`) and failed with *"no manifest.m3u8 appeared
  on any `<audio>` element within 20s"* — which blames the player, not the patch.
  **Every attempt, every time, ~20 wasted seconds each.**
- **The restore never ran either**, and that is the safety-critical half. Had a
  patch ever landed, Suno's own player would have been left with `MediaSource`
  destroyed and no working audio in that tab — the one failure a user would not
  think to report.

So if you find a report saying "the HLS option is enabled but nothing ever
captures", that report describes 6.1.0 and earlier. **The fix is MAIN-world access
driven by the worker**, described in
[`ARCHITECTURE.md` § MAIN-world access](ARCHITECTURE.md); the reason it is not
inline injection is in the source at `background/background.js:2020-2048` and
`content/content.js:3411-3427`.

#### ✅ What is verified now, rather than assumed

The patch is **confirmed in the page before anything else happens**, and a failure
is a failure rather than a 20-second wait for something that will never appear
(`content/content.js:3411-3427`):

```
hls-patch ──► ok:false ?          throw immediately, nothing was patched
          └─► alreadyActive:true ? throw: a STALE patch is on the page; the
                                    restore that follows is what clears it
          └─► patched:true        ONLY now is pollForManifest(20000) allowed to run
```

And the MAIN-world op itself **reads the write back**. Assigning to a non-writable
`window.MediaSource` is a silent no-op in sloppy mode, so `mainWorldHlsPatch`
checks `window.MediaSource === undefined` and reports
*"MediaSource is not writable; the page still exposes it, so the patch did not
land"* instead of a phantom success (`mainWorldHlsPatch`, `background/background.js:2631-2641`). This is
the same *"reported success, did nothing"* lie as the CSP bug, caught the second
time by reading state back.

#### 🛟 A failed restore is surfaced loudly, not swallowed

The restore runs in a `finally` block whatever happened above, because it is the
only thing that can leave the page usable
(`content/content.js:3458-3489`):

| outcome | what the user is told |
|---|---|
| restore **failed**, and this run *did* patch | *"idle — RESTORE FAILED, `window.MediaSource` may still be disabled"* plus an error strip naming the cause and **telling them to reload the tab** (`content/content.js:3470-3472`) |
| restore failed, and this run patched nothing | *"no patch was applied, so there was nothing to restore"* — the honest version, without crying wolf (`content/content.js:3476`) |
| restore ok, `notActive`, nothing patched | *"nothing was patched, and the page needed no restore"* (`content/content.js:3480`) |
| restore ok, nothing patched by this run | *"a stale patch from an earlier capture was cleared; `window.MediaSource` restored"* (`content/content.js:3487`) |
| restore ok, this run patched | *"idle — `window.MediaSource` restored"* |

**Nothing in that table claims a restore the worker did not confirm.**
`mainWorldHlsRestore` reports `note: 'notActive'` rather than success when there was
nothing to undo, so a restore with no patch cannot claim credit over a patch that
never landed (`background/background.js:2672-2678`).

> ⚠️ **HLS manipulates Suno's page, and so does the auth tap.**
> The content script temporarily sets `window.MediaSource = undefined` **in the
> page's MAIN world** so Suno's own player falls back to a plain fetch, collects
> the `#EXT-X-MAP` init segment plus the media segments, and restores
> `MediaSource` in a `finally` (`content/content.js:2773-2809`). This trips abuse
> heuristics, which is why it is off by default and behind a confirm.
>
> Separately, **`auth-tap` wraps `window.fetch` and two `XMLHttpRequest.prototype`
> methods on every mount** to observe Suno's own `Authorization` header. It never
> alters a request and always calls through, but it is still a hook on the page.
> Both are recorded together at
> [`KNOWN-LIMITS.md` § 22](KNOWN-LIMITS.md).
>
> `lib/api.js:58-59` states that the API client itself never monkey-patches
> `window.fetch` and never injects script. **That is scoped to `lib/api.js` and is
> true there. It is not a claim about the extension.**

---

## 🪤 The trap: HTTP 200 with a refusal body

**Never branch on `resp.ok` for a download route.** Both download routes answer
**HTTP 200** with a body that says no:

```json
{ "ok": false, "reason": "no_permission", "message": "You don't have ..." }
```

`lib/api.js:34-36` leads its own header with this, and
`SunoAPI.parseDownloadResponse` (`lib/api.js:2025-2166`) exists solely to handle
it. The refusal contract is checked **before** any artifact probing, and the
parser is called at `lib/api.js:2169-2176`. `background/background.js:4194-4201`
calls that parser for both metered rungs instead of inspecting the response
status.

Related, from the same header — **403 means entitlement, not auth**
(`lib/api.js:858` and `:867`, and at the route itself in `:1119`). `SunoApiError.isEntitlementError` is `status === 403`
(`lib/api.js:869`), and the batch driver treats `entitlement` as
**never retryable** (`isRetryableFailure`, `background/background.js:1004-1010`).

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

**The variant list is still exactly three** — `m4a`, `wav-48k`, `wav`
(`VARIANTS`, `background/background.js:555`) — because a `variant` selects the
**download route** and the `?format=` enum behind it is undocumented. That list is a
**capability decision, not an omission**; the reasoning is
`background/background.js:535-556`. `GET_LIMITS` publishes it, so a UI should build
its select from *that* rather than from a hardcoded list.

**Separately, the `transcode` setting now performs four conversions**, MP3 and Ogg
Vorbis included. These are two different mechanisms and conflating them is the
single most common misreading of this extension:

| | `variant` (3 values) | `transcode` (4 values) |
|---|---|---|
| **what it picks** | the download **route** — passed through as the route's `?format=`, and keyed on by `isDone(id, variant)` and the filename extension | a **post-fetch local step** on bytes already in hand |
| **when it runs** | before the request | after the bytes arrive |
| **can it fail server-side** | **yes** — the enum is undocumented | no network call at all |
| **cost** | one download if a metered rung serves it | **zero downloads**, CPU and RAM instead |

**Why the encoders are local files rather than a CDN fetch.** MV3 sets
`extension_pages` to `script-src 'self'` (`manifest.json:77-79`) and the offscreen
page goes further with `default-src 'none'; script-src 'self'`, so
`<script src="https://cdn…">` cannot load and the Web Store policy bans remotely
hosted code outright. There is therefore **no "download it if missing" fallback**
— the encoders must be *inside* the extension directory, and `vendor/` must be
committed. `loadVendoredScript()` even asserts the resolved URL's protocol is
`chrome-extension:` and refuses anything else (`offscreen/offscreen.js:781-835`),
so editing that path constant to an https URL cannot reintroduce remote code. See
[`ARCHITECTURE.md` § why the encoders are vendored](ARCHITECTURE.md) and
`vendor/README.md` for the full provenance and licence record.

### Works today

| Format | Mechanism | Cost |
|---|---|---|
| **`m4a`** | native. The `media_urls` stream already *is* `audio/x-m4a` | 🟢 on rungs 1–2 |
| **`wav`** | local render at `settings.wavSampleRate`: offscreen `sunoRenderWav` — decode → resample → real RIFF header (`background/background.js:3395-3425`) | 🟢 free — a local render of free bytes |
| **`wav-48k`** | the same render with the rate **pinned** to 48000 (`WAV_48K_RATE`, `background/background.js:576`, applied by `wavRateForVariant` at `:3427-3431`) so the rung stays distinguishable when `wavSampleRate` moves | 🟢 free |
| **`mp3`** | offscreen `sunoTranscode` → `encodeMp3` (`offscreen/offscreen.js:901-917`) → `lamejs.Mp3Encoder` from `vendor/lame.all.js` at `settings.mp3Bitrate` | 🟢 **unmetered** — CPU + RAM |
| **`ogg`** | offscreen `sunoTranscode` → `encodeOgg` (`offscreen/offscreen.js:919-953`) → `OggVorbisEncoder` from `vendor/OggVorbisEncoder.js` at `settings.oggQuality` | 🟢 **unmetered** — CPU + RAM |
| **`.lrc`** | timed lyrics, only written when the clip actually has lyrics | 🟢 |
| **embedded cover art** | `APIC` / `covr`, full-size image fetched per clip | 🟢 |
| **`.json`** sidecar | machine-readable clip record. Contains prompt text; **no** token or key material | 🟢 |

The last three are **sidecars, not variants**. They are controlled by
`tagOptions.lrc`, `tagOptions.artwork` and `tagOptions.json`
(`background/background.js:1195-1203`) and are toggled in the page drawer at
`content/content.js:88-92`. A *standalone cover-art FILE* is a different
feature entirely and is not offered, because it needs the `image_url` /
`image_large_url` CDN fetches, which this build does not implement
(`content/content.js:93-96`).

`GET_LIMITS` also publishes `variantAliases` and `wavRungRates`
(`background/background.js:6808-6817`), so a UI can explain a substitution instead
of silently showing a different value than the user picked.

> **Do not rename the M4A blob MIME.** It MUST be `audio/x-m4a`, never
> `audio/mp4` (`lib/drm.js:137-145`): an MP4-family blob declared as `audio/mp4`
> is what Chromium writes to disk as `.m4b` — the file plays, but no desktop
> player opens it. *"Changing this is a one-character outage."*

### Does not work

| Format | Why, exactly |
|---|---|
| **FLAC** | no vendored encoder and no `transcode` format, so there is no code path that can produce one. `background/background.js:467-468` says so in the `VARIANTS` comment. |
| **AAC** | identical. |
| **Opus** | identical — and note the trap: the *source* stream is `m4a-opus` (`lib/drm.js:15-16`), so a standalone Opus file is not reachable from here at all. |
| **MP3/OGG *as variants*** | deliberately, and not for want of an encoder. `variant` is passed through as the route's `?format=`, whose enum is undocumented, so offering `mp3` there means *asking* for a format the server may refuse, failing, and falling through the ladder — potentially spending the metered rungs' quota to produce the very file the free rungs already gave us. They are one key away, under `transcode`. |

### 🎸 What a local transcode actually costs you

This is the honest trade, and it is stated the same way in the code
(`background/background.js:3438-3460`):

- **Downloads: zero.** `maybeTranscode` runs *after* `SunoDRM.decryptClipBuffer`
  has already returned the audio bytes, and its only I/O is `callOffscreen` — a
  runtime message to the offscreen document, **not an HTTP call**. It touches no
  rung and cannot spend the monthly allowance. Since every rung it is called from
  is already unmetered (`progressive` / `mango-drm`), transcoding an M4A source
  **saves no quota**; nothing is gained there.
- **Wall-clock CPU: one full decode plus one full re-encode.** Roughly 1–2× the
  track's duration for MP3, and rather more for Ogg at high quality. That is the
  real cost, and it is paid on the offscreen page's single thread.
- **Peak memory: the decoded PCM *and* the encoded output, both at once**, both
  held in the offscreen document rather than the worker.
- **What it buys:** a file that plays everywhere. M4A/AAC is awkward on some players
  and hardware; MP3 is near-universal, and Ogg Vorbis is the smaller of the two at
  comparable quality. **CPU and RAM for compatibility — that is the entire trade.**
- **It is strictly best-effort.** Every failure path returns `null`, so the
  original bytes are saved unchanged rather than the download being lost
  (`background/background.js:3483`). A damaged install reports a typed
  `ENCODER_UNAVAILABLE` rather than a silent M4A (`:2377-2387`).

> **MP3 and Ogg are always encoded at 48 kHz**, and there is no control for it. The
> worker sends no `sampleRate` on the lossy rungs
> (`background/background.js:3403-3410`, `:3430-3440`), so the offscreen page decodes at
> its own fallback of 48000 and that becomes the encoder rate
> (`offscreen/offscreen.js:1120-1121`). **Only WAV has a user-controllable rate**
> (`wavSampleRate`). A 44.1 kHz source is resampled on the way in; nothing here
> invents detail.

### The two encoder settings

Both are real `<select>` controls on the options page
(`options/options.html:502-529`), gated on the matching transcode format and
**preserving their value across format switches** — `gateOnTranscode` touches only
`.disabled` and `aria-disabled`, never `.value`
(`options/options.js:653-678`), so MP3 → Ogg → MP3 comes back to the bitrate you
picked.

| key | valid values | default | validated by |
|---|---|---:|---|
| `mp3Bitrate` | `128, 160, 192, 224, 256, 320` (kbps) | **192** | `snapToChoice(settings.mp3Bitrate, MP3_BITRATES, …)` |
| `oggQuality` | `0`–`1.0` in tenths | **0.5** | `snapToChoice(settings.oggQuality, OGG_QUALITIES, …)` |

Both are **snapped, never rejected** (`snapToChoice`, `background/background.js:1315`): the
nearest entry wins and **ties go to the lower option**, so `200` becomes `192`, not
`224`, and the result is a deterministic function of the input rather than of
iteration luck. That matters because neither encoder accepts a range — LAME
silently substitutes its own bitrate, and the offscreen page substitutes `0.8` for
an out-of-range Ogg quality (`offscreen/offscreen.js:1126-1132`), so a value let
through as-is would be discarded with no trace. `null`, `''` and booleans count as
**missing**, not as 0/1, because `Number(null) === 0`.

They are snapped a **second** time at the point of use
(`background/background.js:3495-3496`), so a caller handing over a hand-built
`settings` object cannot push a NaN into `lamejs.Mp3Encoder`.

### `transcode` accepts all four values

X-NOMATCH
(`background/background.js:644`), reduced by `resolveTranscode` (`:662-667`) and
applied at `:1094`. A dedicated resolver rather than a bare `indexOf`, for the same
reason `resolveVariant` exists: an unrecognised value must still degrade to
`'none'` ("save the original"), and the occurrence is logged.

The clamp used to be hardcoded to `none|wav`, which made MP3 and OGG
**permanently unreachable even though both encoders were already vendored** —
`maybeTranscode` read the clamped value, so `sunoTranscode` was dead code and every
`mp3`/`ogg` blob silently saved the original. That is exactly the kind of silent
capability removal that leaves the UI showing "None" while the stored blob still
says `'mp3'`, and it is the reason the settings are gated on the format that reads
them.

> **The two libraries do not share an API, and the Ogg one fails silently if you
> assume they do.** `lamejs.Mp3Encoder` matches the usual expectation —
> `encodeBuffer()` returns an `Int8Array` and `flush()` returns one.
> `OggVorbisEncoder` is the other way round: **`encode()` returns `undefined`** and
> pushes onto the encoder's own `oggBuffers`, and **there is no `flush()`** — the
> methods are `encode`, `finish`, `cancel`, `process`, and `finish('audio/ogg')` is
> the flush. A `if (buf && buf.length) parts.push(buf)` loop therefore discards
> **every page**, and calling `flush()` was a `TypeError` on every single OGG
> request. Both facts are now **asserted**, not assumed
> (`offscreen/offscreen.js:923-939`), so a wrong or partial build yields a typed
> `ENCODE_ERROR` naming the pinned SHA-256 instead of a raw `TypeError`.

### Untested

| | |
|---|---|
| **`?format=` passthrough** | the enum is undocumented — no recon source enumerates the accepted members. `lib/api.js` tallies every value tried so they can be learned from telemetry (`lib/api.js:1209`). `m4a` is the only guaranteed container; `wav`/`wav-48k` are honest because they are rendered locally, not asked for. See KNOWN-LIMITS, section 1. |
| **ZIP** | response shape unknown; job polling not implemented. See KNOWN-LIMITS, section 2 ("Bulk ZIP"). |
| **HLS** | gated behind `allowHlsCapture` + a page confirm; the reassembly path exists (`background/background.js:4397`) but is not the default path for anything. |

---

### BPM: measured, never invented — and never filterable

The tempo field is a **working feature** end to end:

- `SunoFilter.normalize()` returns `bpm` (`lib/suno.js:952-956`), taking the first
  of `clip.bpm` / `metadata.bpm` / `metadata.tempo_bpm` that coerces to a
  non-zero number.
- All four read sites in the worker go through one helper, `bpmFromClip`
  (`background/background.js:1355-1367`), so the `{bpm}` filename token
  (`:2513`), the ID3 `TBPM` frame (`:3527`), the `.json` sidecar field (`:3593`)
  and the HLS path (`:2992`) cannot drift apart again. That single helper is the
  fix: the pipeline was dead because four sites each rolled their own coercion.
- Suno sends **no tempo field** in a feed payload, so when `tagOptions.bpm` is on
  and the clip carries none, the worker measures one itself through the offscreen
  document: `detectBpmViaOffscreen` (`background/background.js:3290-3330`) calls
  `sunoAnalyze`, which replies `{ok, analysis:{peakDb, rmsDb, durationSec,
  sampleRate, channels, bpm, bpmConfidence}}`
  (`offscreen/offscreen.js:61-63`, `:989-1006`). The tempo lives at
  `reply.analysis.bpm` — **not** `reply.bpm`, and reading the shallow path made
  the function return `null` on every single clip
  (`background/background.js:3310-3320`).

**There is deliberately no BPM range filter.** `normalizeSpec()` has no bpm
predicate and no numeric range, and the comment at `lib/suno.js:857-863` says
why: no recon-verified clip payload carries a tempo field, so `bpm` is 0 on
essentially every record straight from the feed. *"Do not add a BPM range filter
here: it would match nothing, and the field being usually-0 is the absence of
data, not a bug to filter around."* The tempo is a **tag**, not a facet.

---

## 💸 Quota semantics

| Plan | Limit | Period | Verified |
|---|---|---|---|
| `free` | **no number reported** | lifetime | ❌ **not verified** |
| `pro` | **20** | month | ✅ |
| `premier` | **60** | month | ✅ |
| `premierPlusStudio` | unlimited | — | ✅ |

Encoded at `lib/api.js:988-993`. The recon account was Premier, so the free-tier
figure was never observed — the report gives a *policy* figure of 7 lifetime
(`../suno-recon/reports/FINDINGS.md:340`) and the code writes "free 0"
(`background/background.js:335`, restated in the `quotaPreflight` header at
`:3803`). **Neither is verified**, and the code is right to refuse to invent
one: a `null` limit becomes `unlimited: true` rather than a substituted number
(`lib/api.js:2711`). Read your own badge.

**The rules, verbatim** (`lib/api.js:994-996`):

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
(`background/background.js:3886-3889`), and `duplicatesDropped` is reported in the
plan stats (`background/background.js:5000`, `:5024`). Getting this wrong is the
single most expensive mistake available in this extension.

Suno's stated purpose for the limits: to make it "harder for bad actors to
mass-export music" (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:21-22`). Stay inside your
own quota — see the README's *Ethics & scope* section.

### Credits are a DIFFERENT resource

`getQuota` returns downloads and credits in **separate objects** and never merges
them (`background/background.js:6279-6296`). The old badge showed credits, so a
user at zero downloads saw a healthy badge. The toolbar badge now paints
**downloads remaining** in violet (`paintQuotaBadge`,
`background/background.js:6303-6316`).

### Preflight, the mid-batch guard, and four outcomes

There are **two** checks now, and the second one is the interesting one.

**1. The preflight** — `quotaPreflight` (`background/background.js:4889-4920`)
runs once before the plan and compares `planned` against
`quota.effectiveRemaining`. On a shortfall it returns the exact sentence: *"This
batch needs N downloads but only M remain before the quota resets on `<date>`."*
When Suno reports no limit at all it proceeds and says so
(`background/background.js:4929-4933`). The shortfall is logged at **`warn`**
(`batch.quota_shortfall`, `background/background.js:5017`), which is the severity
its amber paint implies — an allowance running out is a warning, not an error.

A before-check cannot be the whole answer: a plan of 60 clips checked against 60
remaining is still wrong the moment one clip fails, another succeeds off an
unmetered rung, or a sibling tab spends the meter.

**2. The mid-batch guard** — `guardQuotaAfterItem`
(`background/background.js:5106-5155`), armed at `:5150-5155`. Two rules make it
cheap enough to always have on:

| rule | why |
|---|---|
| it counts only **successful metered** downloads (an unmetered or unknown rung returns early, `:4088-4090`) | `progressive` and `mango-drm` never consume the allowance, so a purely-unmetered batch polls **zero** times and never pays for a re-meter it cannot use |
| a **failed poll is not an exhausted meter** (`:4101-4104`) | `unlimited`, a missing limit and a thrown fetch all leave the batch running. Only a **positive** reading at or below the reserve stops it |
| a dry run polls nothing (`:4050-4053`) and can never be stopped by this | planning must not cost a meter read |
| one in-flight fetch is shared across the pool (`:4066-4076`) | N workers finishing together trigger **one** `readQuotaCached`, not N |

Two settings keys control it (`background/background.js:766-783`, clamped at
`:1105-1106`, wired to real controls at `options/options.html:150-167`):

| key | range | default | meaning |
|---|---:|---:|---|
| `quotaReserve` | `[0, 10000]` | `0` | the floor the guard stops **at**: `remaining <= quotaReserve` ends the batch cleanly. 0 = "stop the moment the meter is empty" |
| `quotaCheckEvery` | `[1, 100]` | `5` | re-read the meter at most once per N successful **metered** downloads. 0 is clamped up to 1 because polling on every item is a quota-hammering loop |

**When it stops**, `runBatch` records `quotaStop =
{reason, remaining, reserve, meteredDownloads, remainingItems, resetsOn, at}`
(`background/background.js:5175-5186`), halts claiming new items while in-flight
workers finish the item they already own (`:4131-4133`), writes a **separate
`quota-stop` journal phase** so a later run can tell a deliberate halt from a
batch that ran out of plan (`:4366-4385`), raises a notification saying how much
fitted and when the meter returns (`:4425-4436`), and emits `DL_DONE`
(`:4404-4416`) with:

```
stoppedReason : 'complete' | 'quota' | 'ladder_exhausted' | 'cancelled'
quotaPolls    : how many meter reads the guard actually cost
remainingItems: how much of the plan is still unattempted
quotaStop     : the reading above, or null
```

The ternary is at `background/background.js:5477-5484`, and it is the one field
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
| `quota` | amber warning: what was saved, what is still planned, the meter reading, the reserve, how many more would fit, when it resets, how many polls it cost (`popup/popup.js:1494-1516`) | amber banner with the same facts plus **"Re-run this batch after the reset"** (`content/content.js:2256-2390`) |
| `ladder_exhausted` | red: every rung refused, with the per-clip reasons it recorded live from `DL_ITEM` (`popup/popup.js:1517-1527`) | red banner + per-reason detail from the live items (`content/content.js:2354-2365`) |
| `cancelled` | neutral, "not an error" (`popup/popup.js:1528-1533`) | neutral note (`content/content.js:2311-2317`) |

The popup also reconstructs the outcome from a `DOWNLOAD_STATUS` re-read when it
was closed mid-batch, using the worker's own rule, because `DOWNLOAD_STATUS` is the
only route that carries `plan.stoppedReason` / `plan.quotaStop`
(`popup/popup.js:1392-1402`, `:1120-1189`).

> ⚠️ **One honest gap:** there is **no `DOWNLOAD_RESUME` route.**
> `DOWNLOAD_RETRY_FAILED` re-plans only the clips recorded `failed`
> (`background/background.js:5646-5683`), so after a quota halt the
> never-attempted clips need a fresh `DOWNLOAD_START`. The page UI works around
> this by re-sending the last payload. See KNOWN-LIMITS, section 13.

---

## 🔎 Probe before you spend

`PROBE_DRM` (`background/background.js:7702-7749`) is **diagnostic only**: it
downloads nothing and spends nothing. Give it a clip id and it returns:

- `audioUrlIsDecoy` — almost always `true`, and worth seeing once
- `mediaUrlCount`
- per-rung `{id, available, metered, reason}`
- `recommended` — the first available rung
- `free` — the first available **unmetered** rung ← *this is the one you want*
- `metered` — the first available rung that **costs** a download, so you can say
  what the honest-but-paid alternative is (`background/background.js:7742-7745`)

It also accepts an **optional `{ladder:[...]}`** to probe a hypothetical ordering
instead of the configured one (`background/background.js:7687`) — a UI asking
"would studio work if I enabled it?" cannot get a real answer from a ladder that
has studio filtered out, and enabling it just to ask would be a side effect this
route promises not to have. `clipId` is the only required field.

`evaluateLadder` (`background/background.js:3962-4029`) produces those reasons,
and they are written to be read by a human, not parsed. If the clip is not in the
local library it says so and tells you to run a sync first.

---

## ⚙️ Ladder settings

Ordered preference, first **available** rung wins (`background/background.js:620`).

`normalizeLadder` (`background/background.js:1148-1180`) folds legacy aliases
(`LADDER_ALIASES`, `background/background.js:489-510`) so a stale settings blob
cannot silently disable everything. Three subtleties:

- `hls` is deliberately **not** mapped to a working fallback.
- Every `batchOnly` rung is dropped **unconditionally** (`:1163`), not gated on
  the opt-in flag — so a stored `['hls']` normalises to empty, and `hls` is
  documented as *"not a rung"* rather than as "unsupported".
- An **empty** input means "not configured" → the default ladder. A **non-empty**
  input that filters down to nothing returns `[]` and `startBatch` fails loudly
  with `ladder_empty` (`background/background.js:4938-4991`) rather than silently
  re-enabling rungs the user turned off.

**Both rung editors filter that pool to match.** The options page's
`editableRungs()` drops `hls` and every `batchOnly` rung
(`options/options.js:700-704`), and the in-page dock's "available rungs" list
applies the same two exclusions (`content/content.js:1291-1306`). The two are
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