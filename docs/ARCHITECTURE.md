# 🏗️ Architecture

Eight libraries, one orchestrator, and a set of Manifest V3 constraints that each
forced a specific design decision. The constraints are the interesting part —
this is a document about working inside them.

---

## 📁 File map

Line counts from `wc -l` at time of writing.

| File | Lines | Responsibility |
|---|---:|---|
| `manifest.json` | 82 | MV3 declaration, permissions, host permissions, CSP |
| `background/background.js` | 6073 | **the only orchestrator** — 18 numbered sections |
| `content/content.js` | 3370 | the in-page dock: filters, results, batch drawer, row checkboxes, Clerk token relay |
| `content/content.css` | 980 | dock styling, loaded as a web-accessible resource |
| `lib/api.js` | 3151 | the only HTTP client; 23 verified routes, `RateLimiter`, typed errors |
| `lib/audio.js` | 2037 | decode / resample / interleave / BPM primitives (pure math) |
| `lib/crypto.js` | 1234 | AES-GCM unwrap, chunked AES-CTR, counter arithmetic, container sniffing |
| `lib/db.js` | 2964 | the **only** thing allowed to open `suno-library`; 5 stores, schema v3 |
| `lib/drm.js` | 1808 | the Mango pipeline: rights handshake, streaming fetch, key cache, fan-out |
| `lib/lyrics.js` | 897 | LRC/txt/json sidecar construction, key-material scrubbing |
| `lib/suno.js` | 1567 | the filter engine: normalize, matches, facets, sort, parseQuery, presets |
| `lib/tagger.js` | 2126 | ID3 / MP4 metadata writing, container detection |
| `offscreen/offscreen.js` | 1579 | Web Audio + `createObjectURL` + the WAV renderer |
| `offscreen/offscreen.html` | 38 | the offscreen page; `default-src 'none'` |
| `options/options.js` | 1382 | the settings page |
| `options/options.html` | 557 | ladder editor, pacing, naming, tags, conversion, quota guard, import/export |
| `options/options.css` | 563 | |
| `popup/popup.js` | 1761 | the toolbar popup: boot, tiles, progress, activity log |
| `popup/popup.html` | 82 | |
| `popup/popup.css` | 401 | |
| `side_panel.js` | 758 | the browse/search surface; 50-row paging from the local index |
| `side_panel.html` | 372 | |
| `run` | 18 | a bash loop that opens `urls.lst` in Brave. Handy, not part of the build. |
| `urls.lst` | 85 | URL list for `run` |
| `icons/icon16.png` | 400 B | |
| `icons/icon48.png` | 3.6 KB | |
| `icons/icon128.png` | 18 KB | |

33,782 lines across the JS/HTML/CSS files in this table.

### The boundary rule

> `background/background.js:4-8`: *"It owns nothing that a lib already owns: every
> HTTP call goes through `SunoAPIClient`, every library row through `SunoDB`, every
> byte transform through `SunoDRM` / `SunoTagger` / `SunoLyrics` / `SunoAudio`. What
> lives here is the part no lib can own."*

The eight libs take their dependencies by injection rather than reaching for
globals — `fetchImpl` and an injectable clock (`lib/api.js:974-983`), an injectable
`indexedDB` under node (`lib/db.js:71`), an injectable crypto implementation with a
four-step resolution chain (`lib/drm.js:405-412`), a replaceable logger everywhere.
That is what lets the same file run in the service worker, in a content script, and
in an assertion harness with no shims.

The 18 sections, in order (`background/background.js:10-28`):

```
 0  Bootstrap            importScripts + global resolution
 1  Constants            storage keys, alarm names, ladder definition
 2  Diagnostics          the single log() + ring buffer
 3  Errors               redaction, typed failures, classification
 4  Settings             in-memory cache with write-behind
 5  Auth                 Clerk JWT minted from the page, never from cookies
 6  Messaging            broadcast, sender validation, router scaffolding
 7  Offscreen            blob URLs + Web Audio (worker has neither)
 8  Filenames            hard sanitisation + path templates
 9  Saving bytes         data: URL vs offscreen blob URL
10  The download ladder  seven rungs (progressive, mango-drm, studio,
      download-route, wav-official, zip, hls), each with a cost class
11  Tagging              tag + sidecar pipeline
12  Batch driver         resumable, isolated failures, quota-aware
13  Library sync         resumable crawl, no silent truncation
14  Query + selection    filter/sort/page server-side, explicit id list
15  Quota                DOWNLOAD quota, never credits
16  Router               the request table
17  Lifecycle            install / startup / alarms / download events
```

> The section-10 banner names all **seven** rung ids and the array it introduces has
> seven entries, so the header and the code agree.

---

## 🧱 The MV3 constraints, and how each one is solved

This is the good part. Manifest V3 removes a lot of what an extension used to
take for granted, and each removal here produced a design decision that is still
visible in the code.

### 🚫 1. No Web Audio in a service worker

A service worker has no DOM, so no `AudioContext`, no `OfflineAudioContext`, no
`decodeAudioData`.

**Solved by an offscreen document** — `chrome.offscreen.createDocument` with
reasons `['AUDIO_PLAYBACK','BLOBS']` (`background/background.js:1694-1698`). It is a
real DOM page, so it can decode, resample, render a WAV header and detect BPM.

It is created lazily and **proven alive before first use**
(`background/background.js:1686-1714`). The liveness ping matters: a document that
exists but whose Web Audio failed to initialise answers `sunoPing` with `audio:false`,
and *"discovering that at the first 24 MB buffer is far worse than finding out
now."*

The protocol is `suno-offscreen/1` (`background/background.js:1664`):

| request | returns |
|---|---|
| `sunoPing` | `{ok, ready, protocol, audio, offlineAudioContext, encoder, stats, blobs, queue}` |
| `sunoAudioDecode` | `{ok, pcm:{channels:Float32Array[], sampleRate, durationSec}, warnings, contextsClosed}` |
| `sunoAnalyze` | `{ok, analysis:{peakDb, rmsDb, durationSec, sampleRate, channels, bpm, bpmConfidence}, warnings}` |
| `sunoRenderWav` | `{ok, bytes, sampleRate, bitDepth, bpm, bpmSource, warnings}` |
| `sunoBlobUrl` | `{ok, url, mime, byteLength, live}` |
| `sunoBlobRevoke` / `sunoBlobRevokeAll` | `{ok, revoked, live}` |
| `sunoTranscode` | `{ok, bytes, mime, format}` **or** `{ok:false, code:'ENCODER_UNAVAILABLE'}` |

The reply shapes are quoted from the document's own protocol block
(`offscreen/offscreen.js:55-70`). Note `sunoAnalyze` in particular: the tempo is at
`reply.analysis.bpm`, **not** `reply.bpm`.

**The subtlety that took real work:** `chrome.runtime.sendMessage` is
JSON-serialised, so an `ArrayBuffer` or typed array sent through it arrives as
`{}`. Therefore:

- **bytes going out** travel as a **base64 string**,
- **bytes coming back** travel on `sendResponse` (structured clone, so
  `Float32Array` PCM and WAV bytes survive),
- and the offscreen page *also* broadcasts a `{type:'<type>:result'}` — which is
  JSON, so any byte payload in it becomes
  `{byteLength, payloadTruncated:true}`.

So there is an **id-keyed registry, first channel to answer wins**, and a
truncated broadcast is **dropped unless the registry is already settled**
(`background/background.js:1928-1934`) — handing a truncated descriptor to a caller
expecting WAV bytes would produce a corrupt file. A truncated broadcast is still
decisive *evidence*, so it arms a 5-second fuse rather than the full budget
(`OFFSCREEN_TRUNCATED_GRACE_MS`, `background/background.js:1671`, armed at
`:1766-1777`).

#### 🔐 Why "the only sender is us" is not a security argument

Worth its own paragraph, because it is the kind of assumption that reads as
reasoning and is not.

`resolveOffscreenReply` used to match on `/:result$/` alone, and it runs **before**
`validateSender` (`background/background.js:5590-5600`) — so it was reachable by
anything that could post a message on the runtime channel. The request id is
`'os' + sequence + '-' + Date.now().toString(36)` (`background/background.js:1749`):
a small, entirely enumerable space. Anything that could post could guess an
in-flight id and settle its waiter with a payload of its choosing. The worst case
is `sunoBlobUrl` — the forged `url` goes straight to `chrome.downloads.download`.

`isOffscreenReply` (`background/background.js:1872-1889`) now requires **all** of:

- `message.from === 'offscreen'`
- `message.protocol === OFFSCREEN_PROTOCOL`
- `/:result$/` on `type`, **and** the shape `/^suno[A-Za-z]+:result$/` so the type
  agrees with the shape of the id we mint
- `message.id` matching `/^os\d+-[a-z0-9]+$/`
- `sender.url` matching `OFFSCREEN_PAGE_RE`, **when present** — belt and braces,
  because making it mandatory would turn a Chrome-side reporting change into
  "every download times out" (`:1882-1887`)

A rejected envelope never reaches the registry, not even to be remembered; it is
logged as `offscreen.reply_rejected` so a protocol change on either side is visible
in diagnostics instead of showing up as an unrelated timeout
(`background/background.js:1908-1916`).

The general lesson: **"the only extension sender is us" is an assumption about the
protocol, not a check.** Every inbound discriminator gets verified at the boundary,
in the same place, in one function.

### 🚫 2. No `URL.createObjectURL` in a service worker

`chrome.downloads.download()` needs a URL. There is no `URL.createObjectURL` in a
worker.

**Solved with a threshold** (`materializeUrl`, `background/background.js:2450-2466`):

```
bytes.length <= settings.dataUrlMaxBytes (default 24 MB)
   -> 'data:' + mime + ';base64,' + base64      -> data-url
otherwise
   -> ask the offscreen document for a blob URL -> blob-url
```

Two consequences worth knowing:

- The offscreen page keeps an **LRU of 8 blob URLs**. A long batch would evict a
  live URL mid-transfer, so each URL is **revoked the moment its transfer
  completes** (`revokeBlobUrls`, `background/background.js:1963-1973`, called from
  `onDownloadChanged` at `:2611`).
- `dataUrlMaxBytes` is user-tunable, clamped to 64 KB–64 MB
  (`background/background.js:969`).

### ⏱️ 3. Workers get evicted at ~30 s idle

The worker can be killed at **any `await`** (`background/background.js:59-60`).
This is the constraint that shaped the most code.

| Rule | Where |
|---|---|
| Nothing authoritative lives in a module-scope variable | `background/background.js:59-60` |
| All durable state in IndexedDB + `chrome.storage.session` | `STORAGE_KEYS` at `background/background.js:228-236` |
| Settings are a **cache**, re-derived on every wake | `background/background.js:941-943` |
| Crawl cursors written after **every page** | `background/background.js:4632`, `:4681` |
| Batch plans persisted so an evicted worker can rebuild them | `persistPlan`, `background/background.js:3504-3512` |
| An append-only journal per batch | `DB.journal.append` throughout; trimmed at `background/background.js:4218` |
| A 30-second alarm is the only reliable wake | `KEEPALIVE_PERIOD_MINUTES = 0.5`, `background/background.js:259` |
| `bootstrap()` is idempotent and re-entrant | `background/background.js:5875` |

**Invariant B** (`background/background.js:38-39`) is the sharp edge:

> Every worker startup calls `downloads.resetInProgress()`; anything left
> `in_progress` was written by an evicted worker and is NOT done.

`reconcileDownloadsOnStartup` (`background/background.js:2640-2699`) then asks
Chrome what actually happened to every download we started, so transfers that
completed while the worker was dead get recorded correctly instead of retried. It
runs from `bootstrap` at `background/background.js:5890`.

**Invariant F** is the subtle one (`background/background.js:48-49`):

> `chrome.alarms.create` runs ONLY from onInstalled / onStartup. Creating an alarm
> at module scope resets its period on every worker wake.

The previous build ended up with a keepalive that fired constantly **and** one
that still did not protect a batch — the reasoning is repeated in the body of
`armKeepalive` (`background/background.js:5721-5735`), which is the only place an
alarm is created.

### 📡 4. `chrome.runtime.sendMessage` cannot reach content scripts

**This is the bug that killed the entire previous UI.** The old build documented
the limitation in a comment and then used only the broken path, so **no event
ever reached the page**.

**Invariant D** (`background/background.js:42-45`) makes every push fan out to both:

```js
async function broadcast(message) {
  await chrome.runtime.sendMessage(message);        // -> extension pages
  const tabs = await findSunoTabs();
  for (const tab of tabs) await chrome.tabs.sendMessage(tab.id, message);
}                                                    // -> content scripts
```

`broadcast` at `background/background.js:1595-1620`.

### 🪟 5. `window` is undefined in a worker

The shim is four lines and runs **before `importScripts`**
(`background/background.js:128-132`):

```js
(function installWorkerWindowAlias() {
  if (typeof window === 'undefined' && typeof globalThis !== 'undefined') {
    globalThis.window = globalThis;
  }
})();
```

In a worker `self === globalThis`, so `window.SunoAudio = api` becomes
`globalThis.SunoAudio = api`.

Who genuinely needs it is audited in the shim's own comment
(`background/background.js:76-126`), and the answer has changed since this document
was first written:

| lib | exposure | needs the shim? |
|---|---|---|
| `lib/audio.js` | `window.SunoAudio` only, no fallback (`lib/audio.js:102-104`) | **yes — hard** |
| `lib/db.js` | `window` **first, `self` fallback** (`lib/db.js:2959-2960`) | not today; would be if that `self` fallback were dropped |
| `lib/suno.js` | `globalThis` only (`lib/suno.js:1550-1553`) | no |
| `lib/lyrics.js` | `globalThis` only (`lib/lyrics.js:896`) | no |
| `lib/tagger.js` | `globalThis` only, with a comment saying exactly why (`lib/tagger.js:2125`) | no |
| `lib/api.js` | dual — `globalThis` **and** `window` | no |
| `lib/crypto.js`, `lib/drm.js` | `window` first, `globalThis` branch when absent | no |

> ⚠️ **This shim is load-bearing for `lib/audio.js`. Do not remove it.** Removing
> it does not throw — it makes `SunoAudio` silently undefined, `MISSING_LIBS`
> reports it, and every tag embed / artwork / BPM / LRC sidecar degrades to "write
> it untagged".
>
> The earlier version of this document claimed the stale comment at
> `background/background.js:76-86` still named three libs as window-only. That
> comment has since been rewritten and now carries the correct per-lib audit
> above. If you change exposure strategy in a lib, **re-read that comment** rather
> than reasoning about the shim from the load-order comment below it, which
> explicitly defers to it (`background/background.js:153-157`).

### 🚫 6. No remote code

`manifest.json:77-79` sets `extension_pages` CSP to `script-src 'self'`. The
offscreen document goes further: `default-src 'none'` with `connect-src 'none'`
(`offscreen/offscreen.html`).

**Consequence: no CDN encoder, hence no MP3 and no OGG.** An encoder has to be
vendored into the extension. None is. See
[KNOWN-LIMITS, section 1](KNOWN-LIMITS.md) — this is the #1 blocker in the project.

`lib/api.js:41-42` records the other half of the posture: *"No page tampering: this
file never monkey-patches `window.fetch` and never injects script. It is a plain
IIFE so no internal name leaks to global scope."*

### Other MV3 details the code handles

- **`onMessage` must return `true` only for async handlers.** Returning it
  unconditionally leaks the channel for every synchronous reply — the documented
  cause of *"the message port closed before a response was received"*. `onRuntimeMessage`
  (`background/background.js:5674-5700`) inspects the **result**, not a
  hand-maintained `async` flag, *"because a flag that disagrees with the handler is
  exactly how a reply gets written to a channel that has already closed"*
  (`background/background.js:5068-5073`).
- **`document.body` is null at `document_start`.** The content script obeys one
  rule: no DOM access anywhere that assumes body exists until `mount()` runs
  (`content/content.js:6-12`, `:3126-3133`). Getting this wrong is what made the
  old page UI completely dead.
- **Sender validation on every route.** `validateSender`
  (`background/background.js:1634`) checks **both** `sender.id === chrome.runtime.id`
  **and** a `sender.url` allowlist (`background/background.js:302-307`). An unknown
  type is rejected the same way, and both replies are **synchronous**
  (`background/background.js:5611-5625`). The old `TRIGGER_NATIVE_DOWNLOAD`
  checked neither and downloaded an arbitrary caller-supplied URL.
- **The page token relay validates origin AND source**
  (`content/content.js:2981-2987`):

  ```js
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  if (d.source !== 'suno-master-dock' || d.kind !== 'token') return;
  ```

  Both checks are required — origin alone lets any same-origin script overwrite the
  extension's credential for the whole profile. A shape check follows: the token
  must match `TOKEN_RE` or it is rejected as malformed.
- **Zero empty catch blocks** (invariant H, `background/background.js:52-54`).
  Every failure logs with enough context to diagnose it, *"which is what made the
  previous 30-swallows build undiagnosable."*

---

## 📨 The message protocol

### Request types (extension pages → worker)

**27 routes** in the `ROUTES` table (`background/background.js:5080-5549`). Every
one is `{handler}` where `handler(payload, sender)` returns a plain object
(synchronous reply, channel NOT held open) or a promise. There is no
hand-maintained `async` flag, because a flag that disagrees with the handler is
precisely how a reply ends up written to a closed channel
(`background/background.js:5068-5076`).

| Type | payload | returns |
|---|---|---|
| `GET_LIMITS` | — | `{ok, ladder, variants, variantAliases, wavRungRates, signedUrlTtlSeconds, apiLimits, quotaSemantics, endpoints, dataUrlMaxBytes, maxFolderDepth, syncFlushEveryPages, rebuildBufferCap}` — **the only synchronous handler** |
| `GET_BOOT` | — | `{ok, version, settings, defaults, ladder, variants, token, quota, quotaFetchedAt, library:{counts,downloadsByState,estimate,schemaVersion}, sync:{state,pagesDone,nextPage,totalSeen,truncated,dislikedCount,dislikedApproximate,lastError,durationMs}, download:{running,batchId,lastBatch}, capabilities:{filter,tagger,drm,crypto,audio,lyrics,offscreen,missingLibs}}` |
| `GET_DIAGNOSTICS` | — | `{ok, debug, entries, api, drm, audioWarnings, missingLibs, rateLimiter}` |
| `SET_TOKEN` | `{token, expiresAt?, requestId?}` | `{ok, expiresAt}` |
| `GET_TOKEN_STATUS` | — | `{ok, token}` |
| `SYNC_START` | `{force?, dislikedMode?, maxPages?}` | `{ok, force, dislikedMode, maxPages, total, state}` |
| `SYNC_STATUS` | — | `{ok, running, cursor, truncated, total}` |
| `SYNC_CANCEL` | — | `{ok}` |
| `GET_CLIPS` | `{spec, sort?, order?, offset?, limit?}` | `{ok, items, total, offset, limit, hasMore, description}` |
| `GET_FACETS` | `{spec?}` | `{ok, facets}` |
| `GET_PROJECTS` | — | `{ok, projects}` |
| `SET_SELECTION` | `{ids}` | `{ok, count}` |
| `GET_SELECTION` | — | `{ok, ids}` |
| `DOWNLOAD_START` | `{spec?, ids?, useSelection?, variant?, sourceLadder?, tagOptions?, overwrite?, dryRun?}` | `{ok, batchId, plan:{…}, preflight}` |
| `DOWNLOAD_STATUS` | `{batchId?}` — **optional** | `{ok, running, batchId, plan, byState, activeDownloads, lastBatch}` |
| `DOWNLOAD_CANCEL` | — | `{ok}` |
| `DOWNLOAD_HISTORY` | `{limit?}` | `{ok, history, total}` |
| `DOWNLOAD_RETRY_FAILED` | — | `{ok, batchId}` |
| `GET_QUOTA` | `{refresh?}` | `{ok, quota, downloads, credits:{monthly,total}, creditPacks, semantics, fetchedAt}` |
| `GET_SETTINGS` | — | `{ok, settings, defaults, ladder, variants}` |
| `UPDATE_SETTINGS` | a patch, flat or under `settings` (nested wins) | `{ok, settings}` |
| `RESET_SETTINGS` | — | `{ok, settings}` |
| `EXPORT_SETTINGS` | — | `{ok, exportedAt, version, settings, projects, quota}` — **never** the token, key material or diagnostics |
| `IMPORT_SETTINGS` | `{settings}` | `{ok, settings}` |
| `REGISTER_TAB` | `{tabId?}` (falls back to `sender.tab.id`) | `{ok, tabId}` |
| `PROBE_DRM` | `{clipId}` **required**, `{ladder:[…]?}` **optional** | `{ok, clipId, inLibrary, title, audioUrlIsDecoy, mediaUrlCount, ladder[], recommended, free, metered?, drm}` |
| `HLS_CAPTURE` | `{clipId, segments[], initUrl?, mime?, title?, variant?}` | `{ok, clipId, bytes, segments, downloadId, filename, source, method}` |

### The four routes that changed shape in 6.0.1

Every route now carries a self-describing doc comment naming its side-effect
class and which surface owns the corresponding control, because *"nothing in this
build sends this message on its own"* is exactly the fact that used to be
undocumented and therefore unfindable:

| Route | what changed |
|---|---|
| `GET_LIMITS` | now publishes **`variantAliases`** and **`wavRungRates`** (`background/background.js:5116-5135`) alongside `variants`, so a UI can build its select from the worker's own list *and* explain a substitution instead of silently showing a different value than the user picked. Also documented as **NO SIDE EFFECT** — reads constants and cached values only. |
| `GET_DIAGNOSTICS` | documented as the "is this install healthy?" surface and the **only** reader of `missingLibs` / `audioWarnings` (`background/background.js:5230-5243`). No side effect. |
| `DOWNLOAD_STATUS` | accepts an **optional `{batchId}`** (`background/background.js:5341-5347`): a UI holding a stale id from an earlier poll can ask about *that* batch. Omitting it keeps the previous behaviour (active batch, else last recorded), so an existing caller that sends nothing is unaffected. |
| `PROBE_DRM` | accepts an **optional `{ladder:[…]}`** to probe a hypothetical ordering instead of the configured one (`background/background.js:5519-5528`), and now reports **`metered`** — the first available rung that *costs* a download, so a UI can say what the honest-but-paid alternative is (`:5541-5544`). |

> ⚠️ **`SYNC_STATUS` still returns `total` but not `added`** — see KNOWN-LIMITS §15.
> And `DL_DONE` still carries no per-clip detail — see KNOWN-LIMITS §14.

### Push types (worker → everyone)

8 types, frozen at `background/background.js:625-629`. **The router ignores all of
them**, so a broadcast can never re-enter the router and be answered with
"unknown message type" (invariant E, `background/background.js:46-47`).

| Type | payload |
|---|---|
| `SYNC_PROGRESS` | `{page, pagesDone, seen, added, etaMs, state}` |
| `SYNC_DONE` | `{total, truncated, projects, durationMs}` |
| `SYNC_ERROR` | `{error}` |
| `DL_PROGRESS` | `{batchId, done, total, ok, failed, skipped, currentTitle, bytes, etaMs}` |
| `DL_ITEM` | `{batchId, clipId, variant, state, filename, source, error, bytes}` |
| `DL_DONE` | `{batchId, ok, failed, skipped, durationMs, stoppedReason, quotaPolls, remainingItems, quotaStop, quotaAfter}` |
| `DL_ERROR` | `{error, code?}` |
| `TOKEN_CHANGED` | `{expiresAt}` |

`stoppedReason` is the one field that must never collapse: it is
`'complete' | 'quota' | 'ladder_exhausted' | 'cancelled'`
(`background/background.js:4155-4160`), and both UIs branch on it rather than on
`failed` — a batch that halted on the monthly allowance is a warning, not a success
and not a failure (`popup/popup.js:34-38`, `content/content.js:2232-2251`).

### Offscreen traffic (worker ↔ offscreen page)

`{target:'offscreen', type, id, ...payload}` out; the reply lands back on the
worker's `onMessage` as either a structured-clone `sendResponse` or a
`{type:'<type>:result', id, ok, …}` broadcast.

The router deliberately **falls through** for `target:'offscreen'`
(`background/background.js:5590-5600`) — swallowing it is how a blob URL silently never
arrives. `:result` messages go to `resolveOffscreenReply`, which verifies the
envelope before anything can settle a waiter, and all of them are then **dropped**
(`background/background.js:5582-5592`): the offscreen page is not waiting on a
reply to its own reply, and answering a rejected one "unknown message type" is pure
noise on top of the rejection already logged.

> There used to be a `target:'background'` branch answering `offscreenReady` /
> `offscreenPing`. It was **removed**, because `offscreen.js` has never sent such a
> message — a listener for messages that cannot arrive is pure liability. The
> reasoning is recorded in place (`background/background.js:5602-5609`). The
> offscreen document's liveness is established by `sunoPing`, which is a real
> request/response exchange.

---

## 🔄 Data flows

### Sync

```
UI                     SYNC_START {force?, dislikedMode?, maxPages?}
  │
  ▼
startSync()                          background/background.js:4365
  │  refuse if a sync is running    (one at a time)
  │  resolve mode: 'include' | 'exclude' | 'both'
  ▼
runSync()                            background/background.js:4411
  │
  ├──> fetchProjects()          -> GET /api/project/me            cache to meta.projects
  ├──> fetchProjectFeed()       -> GET /api/project/feed         build clip -> [projectIds] join
  │
  ▼
iterateFeed()                        lib/api.js:1934
  │   mode='both'  ->  TWO PASSES: hide_disliked=true, then false
  │   mode=single ->  one pass with that hide_disliked value
  │
  ├──> [pass A only]  batch { type:'page', page, pass, clips[] }
  ├──> [pass B only]  batch { type:'dislikedIds', dislikedIds:Set, truncated }
  ├──> [end]          batch { type:'summary', truncated, error }
  │
  ▼  per page:
  ├──> commitPage()               background/background.js:4509
  │      forced rebuild? buffer, cap 25,000 -> overflow to additive
  │      incremental?    hydrate -> clips.putMany(chunk of 500)   ONE tx per chunk
  ├──> flushIdSets()              every 5 pages (DISLIKED_FLUSH_EVERY_PAGES)
  ├──> DB.syncState.set('feed', cursor)          <-- RESUMABLE
  └──> broadcast SYNC_PROGRESS
  │
  ▼
forced rebuild, complete, not overflowed?
  └──> clips.bulkReplace(all)      ONE atomic tx; abort leaves the old library intact
      otherwise -> additive writes only, and mark the result incomplete
  │
  ▼
cursor.state = 'idle' | 'cancelled' | 'error';  broadcast SYNC_DONE / SYNC_ERROR
```

**`clips.clear()` is never called** (`background/background.js:4356`). A forced
rebuild uses `bulkReplace` — one transaction, abort-safe, at
`background/background.js:4659`. Invariant C
(`background/background.js:40-41`).

A crawl interrupted by an eviction is **deliberately not auto-resumed**
(`background/background.js:5901-5913`): a crawl can be hundreds of requests, and
silently restarting one on every worker wake would hammer the API. `SYNC_START`
with `force:false` picks up from the stored cursor.

> ⚠️ **A crawl that finished pass B but never computed the diff** derives it from
> the persisted pass-A set and sets `dislikedApproximate` when that set was never
> flushed (`background/background.js:4644-4654`). The UI shows the flag; do not
> treat a "disliked only" result as exact without checking it.

### Filter / query

```
UI                        content/content.js buildSpec()
  │  tri-state selects, numeric ranges, date pickers, id list,
  │  the parseQuery grammar, and the stems text-term hack
  ▼  plain SunoFilter spec
GET_CLIPS {spec, sort, order, offset, limit}
  │
  ▼
queryClips()                          background/background.js §14
  ├──> queryContext()   { projects, dislikedIds, projectIdsById }
  ├──> DB.clips.all({limit:-1})            the local index, all rows
  ▼
SunoFilter.normalizeSpec(spec)         folds every legacy alias, ONCE
  ▼
SunoFilter.apply(clips, spec, ctx)     per-clip matches(); non-objects dropped
  ▼
SunoFilter.sort(clips, key, dir)       stable; ties keep input order
  ▼
SunoFilter.paginate(clips, {offset,limit})   {items, total, hasMore}
  ▼
GET_CLIPS reply  ->  UI
```

### Download

```
UI                        DOWNLOAD_START {spec | ids | useSelection, variant, …}
  │
  ▼
startBatch()                            background/background.js:3670
  │  normalizeLadder()      -- may legitimately yield []
  │  FAIL LOUDLY on []      -> {ok:false, code:'ladder_empty'}
  ▼
resolveBatchClips()                     background/background.js:3547
  │  explicit ids  WIN  -- the old build ignored the selection entirely
  ▼
dedupe by clip id  <-- BEFORE ANYTHING IS SPENT   background/background.js:3687-3695
  │  (one song = one download, so duplicates are free to drop)
  ▼
skip items already isDone(id, variant) unless overwrite
  ▼
quotaPreflight(items.length)            background/background.js:3740
  │  shortfall? -> message naming N needed, M remaining, reset date
  ▼
plan { status:'planned', items[], cursor:0, stats }  -> persistPlan()
  │
  ├── dryRun?  -> plan.status = 'done', return, spend nothing
  ▼
runBatch()  [detached, own AbortController]             background/background.js:3822
  │  worker pool of `concurrency` (default 3, max 8)
  │  MID-BATCH QUOTA GUARD armed here                    background/background.js:3866-3939
  │
  ▼  per item:
  ├──> markInProgress(clipId, variant)
  ├──> for attempt in 1..(1 + retryAttempts):
  │      ├──> runLadder(clip, ctx)                   background/background.js:2965
  │      │      for rungId of sourceLadder:
  │      │        runLadderRung()  ->  bytes OR a signed URL
  │      │        failure? record the attempt, next rung
  │      │        all rungs failed? -> {code:'ladder_exhausted', attempts[]}
  │      ├──> maybeTranscode()      offscreen; WAV render ONLY
  │      ├──> applyTagsAndSidecars()  §11
  │      ├──> writeSidecars()         .lrc / .json
  │      └──> saveBytes() / saveUrl()  -> data: URL or offscreen blob URL
  │
  ├──> awaitDownloadSettlement(downloadId)
  │      OBSERVED completion only. timeout leaves the row in_progress.
  ├──> guardQuotaAfterItem()   poll the meter at most 1-in-N metered successes
  ▼
stoppedReason ternary;  quotaAfter refetch;  broadcast DL_DONE
```

#### 🛡️ The observed-completion invariant

**Invariant A** (`background/background.js:33-37`) is the most important rule in
the file:

> `downloads.markDone` is reachable from exactly TWO call sites, and both require
> an OBSERVED completion: the `chrome.downloads.onChanged` listener reporting
> `state === 'complete'`, or a startup `chrome.downloads.search` reporting
> `state === 'complete'`. **Never because `downloads.download()` returned an id.**

The two sites:

1. `onDownloadChanged` — `background/background.js:2582-2625`,
   `proof:'downloads.onChanged:complete'` (`:2604`)
2. `reconcileDownloadsOnStartup` — `background/background.js:2640-2699`

`chrome.downloads.download()` returning an id means **Chrome accepted the request**,
nothing more. Marking done on that signal is how you write a history row for a
file that never landed.

The same listener has a second fix baked in (`background/background.js:2574-2585`):
**`download.error` is a STRING on the delta item.** The old build tested a
non-existent `errorDetails` field *inside* `state === 'complete'`, so the branch was
permanently dead **and its polarity backwards** — failures were only ever supposed
to be detected from inside the success case.

If a settle times out, the row is left `in_progress` on purpose
(`background/background.js:4040-4046`): *"transfer still in flight; will be
reconciled on the next worker wake."* Reconciliation owns it from there.

### Tag + save

```
bytes (from any rung, or from the HLS reassembly)
  │
  ├──> detectContainer()              SunoTagger  -> 'm4a' | 'mp3' | 'wav' | 'unknown'
  ├──> SunoAudio.toTagMeta(rec)       the metadata bundle
  ├──> maybe BPM: if tagOptions.bpm and the clip has none,
  │      MEASURE one from the decoded audio via offscreen sunoAnalyze.
  │      A missing BPM is never invented.
  ├──> fetchCoverArt()                any failure -> "no artwork", never a failed download
  ├──> SunoTagger.tagAudioFile()
  │      embed  -> USLT / ©lyr (raw LRC timestamps stripped)
  │      artwork -> APIC / covr
  │      bpm     -> TBPM / tmpo
  │      comment -> COMM / desc, with model, clip id, prompt, style
  │      album   -> TALB / ©alb
  │      artist  -> the configured artist POLICY, not display_name,
  │                 unless the policy is `clip-owner`
  │      failure -> warn and save UNTAGGED. Never refuse to save the audio.
  ├──> writeSidecars()
  │      SunoLyrics.buildSidecars()  emits only documents with real content
  │      stripKeyMaterial()          applied again as defence in depth,
  │                                  because these files land on disk in plaintext
  │      saveBytes(..., track:false)  NOT registered in SunoDB.downloads
  └──> materializeUrl() -> data: URL (<= 24 MB) or offscreen blob URL (LRU of 8)
        └──> chrome.downloads.download({conflictAction: 'overwrite' | 'uniquify'})
```

Two details that matter:

- **`tagOptions.bpm: false` really does suppress the tempo tag.** The worker gates
  `meta.bpm` with the *same* expression as the top-level `bpm`
  (`background/background.js:3338-3348`), and that matters because
  `lib/tagger.js` resolves `req.bpm !== undefined && req.bpm !== null ? req.bpm :
  meta.bpm` (`lib/tagger.js:1968`). An ungated `meta.bpm` therefore re-introduced
  the `TBPM` frame whenever the tempo toggle was off but the clip happened to carry
  a tempo — the tagger's fallback quietly undoing the user's choice. It no longer
  can.
- **`track:false` sidecars are deliberately not in `SunoDB.downloads`**
  (`background/background.js:2496-2498`, `:3438`): that store is the record of
  which `(clip, variant)` pairs are finished, and a `.lrc` file is not a variant.
  Registering one would double every count and make `isDone(id, 'm4a')` ambiguous.
- **The recorded variant must match the DELIVERED file**
  (`background/background.js:2820`, `:3006-3016`). A WAV transcode changes the
  variant; if the row says `m4a` and the file is `.wav`, a later
  `isDone(id, 'm4a')` check re-downloads the same song. Both the recorded variant
  and the filename follow the bytes actually written.

---

## 💾 The IndexedDB schema

Database `suno-library`, **version 3** (`lib/db.js:732`). Five stores, defined once
at `lib/db.js:270-336` and created **idempotently**. `lib/db.js` is the only thing
in the extension allowed to open it (`lib/db.js:266-268`).

| store | keyPath | indexes |
|---|---|---|
| `clips` | `id` | `created_at`, `is_liked`, `major_model_version`, `status`, `is_trashed`, `is_public`, **`project_ids` (multiEntry)**, `title_lower`, `play_count`, `upvote_count` — all on the derived `_i.*` block |
| `downloads` | **`['clipId','variant']`** | `state`, `clipId`, `startedAt`, `finishedAt` |
| `syncState` | `key` | `updatedAt` |
| `journal` | `id` (**autoIncrement**) | `batchId_ts` (**compound** `['batchId','ts']`), `ts` |
| `meta` | `key` | *(none)* |

### Why the compound key gives free per-format dedupe

`downloads`' primary key is `['clipId', 'variant']` (`lib/db.js:326`). That one
decision buys:

- **`isDone(clipId, variant)` is a primary-key lookup.** No index scan, no filter.
- **Dedupe is per format, for free.** `(clipA, 'm4a')` and `(clipA, 'wav')` are two
  distinct rows, so a batch can honestly track "I have this song in M4A but not
  WAV" — and re-downloading WAV will not clobber the M4A row.
- **The previous build's bug is exactly what this fixes.** Its filter and
  download-history keys used **mismatched format values** (the filter wrote one
  spelling, the history read another), so dedupe never matched and every batch
  re-downloaded everything.

### The `clips._i` derived block

Clips are stored with a derived index block, built by `ensureDerived()`. Every
`clips` index points at `_i.*` (`lib/db.js:287-298`), so filtering and sorting
never touch the raw payload. Note `project_ids` is `multiEntry: true` — that is
what makes a per-workspace query an index range scan rather than a full table walk.

### `journal`

Append-only, one row per meaningful step (`item-start`, `item-ok`, `item-failed`,
`phase: 'planned' | 'run-start' | 'done' | 'quota-stop' | 'cancelled' | 'error'`,
`dislike-diff`, `truncated-fallback`, …). It is what makes "what happened at 3am"
answerable, and it is trimmed per batch at the end
(`background/background.js:4218`).

`quota-stop` is a **separate** phase from `done`
(`background/background.js:4174-4193`), precisely so a deliberate quota halt is
distinguishable from a batch that ran out of plan.

### `meta` keys

`META_KEYS` at `background/background.js:238-247`: `batch.active`,
`batch.plan.<id>`, `batch.lastSummary`, `projects`, `selection.durable`,
`feed.baseIds`, `feed.dislikedIds`, `feed.seenIds`.

---

## 🗄️ Storage keys

One frozen key map, `STORAGE_KEYS` (`background/background.js:228-236`), is shared
by both namespaces — which one a key lands in is decided by **where it is read and
written**, not by the declaration.

`chrome.storage.local` — durable, survives browser restart:

| key | holds |
|---|---|
| `suno.settings` | the whole `Settings` object |
| `suno.diagnostics` | the 500-entry ring buffer |
| `suno.quota.last` | the last quota view + timestamp |

`chrome.storage.session` — survives worker eviction, cleared on browser restart:

| key | holds |
|---|---|
| `suno.auth.session` | the Clerk JWT |
| `suno.selection.session` | the in-flight selection |
| `suno.activeDownloads.session` | `[[downloadId, info], …]` — the observed-completion bookkeeping |
| `suno.registeredTabs.session` | the last 50 Suno tabs |

> **Invariant G** (`background/background.js:50-51`): *No token or key material is
> ever logged, or written outside `chrome.storage.session`.* `SENSITIVE_KEY_RE`
> (`background/background.js:645`) drops anything matching
> `token|jwt|authorization|bearer|password|secret|cookie|session_key|private_key|content_key|user_key|glt|iv`
> from the log at any level, and `EXPORT_SETTINGS` never emits the token, key
> material, or the diagnostics ring buffer
> (`background/background.js:5420-5446`).

---

## 🔢 Settings reference

`DEFAULT_SETTINGS` at `background/background.js:530-622`, with the per-key
documentation in the `Settings` typedef at `:897-941`. Every key is validated on
read (`coerceSettings`, `background/background.js:956-1018`) because a corrupt blob
must not be able to produce a NaN rate or an unsanitised path template.

| group | keys |
|---|---|
| what to fetch | `variant`, `downloadSource` (+ `sourceLadder` legacy alias), `allowMeteredExtras` |
| pacing | `rateLimit` (4), `rateLimitJitter` (true), `concurrency` (3), `retryAttempts` (2) |
| naming | `filenameTemplate`, `folderDepth` (2), `maxFolderDepth` (4), `overwrite`, `dataUrlMaxBytes` (24 MB) |
| tags | `tagOptions.{embed,lyrics,artwork,bpm,comment,json,lrc}` — **exactly seven**, `artistPolicy`, `neutralArtist`, `albumName` |
| conversion | `transcode` (**`none` \| `wav` only**), `wavSampleRate` (48000) |
| crawl | `syncMaxPages` (200), `dislikedMode` (`exclude`), `autoSync`, `syncIntervalMinutes` |
| safety | `dryRun`, `allowHlsCapture`, `debug`, **`quotaReserve`**, **`quotaCheckEvery`** |

### The four settings that changed in 6.0.1

**`quotaReserve` — `background/background.js:597-607`, clamped at `:999`.** The
floor the mid-batch guard stops **at**: `remaining <= quotaReserve` ends the batch
cleanly. Valid `[0, 10000]`, default `0`, meaning "stop the moment the meter is
empty". Wired to a real control at `options/options.html:150-153`.

**`quotaCheckEvery` — `background/background.js:608-614`, clamped at `:1000`.** Re-read
the meter at most once per N **successful metered** downloads; unmetered rungs never
count, so a purely unmetered batch polls zero times. Valid `[1, 100]`, default `5`.
A value of 0 would poll on every item — a quota-hammering loop — and is clamped up
to 1. Wired at `options/options.html:164-167`.

**`variant` is alias-tolerant, not membership-tested** (`resolveVariant`,
`background/background.js:517-527`, applied at `:977`). The old
`VARIANTS.indexOf(...) >= 0` test reverted a stored `mp3-320` to the default with
no trace at all. Now it substitutes via `VARIANT_ALIASES`, logs both values at
debug level, and only falls back for a value it has never heard of.

**`transcode` is narrowed to `['wav']`** (`background/background.js:984-993`).
`mp3` and `ogg` used to be *accepted* here, which meant an imported settings blob
could put the worker into a permanently-failing state while `options.js` rendered
the radios as "None" — so the user had no way to see or undo it. `'wav'` is the
only conversion this build can genuinely perform, and it is rendered as a real
control.

**The seven `tagOptions` keys** are rebuilt from the incoming object alone on every
read (`background/background.js:1006-1016`), which is why every UI sends the whole
object back rather than a one-key patch — a partial `tagOptions` would reset the
other six to the worker defaults (`content/content.js:1183-1187`, `:2526-2528`).

### Filename templates

Tokens (`buildTemplateVars`, `background/background.js:2290-2294`):

```
{workspace} {title} {model} {artist} {year} {month} {day}
{versionIndex} {clipIdShort} {id} {bpm} {format} {ext}
```

Default: `{title}_{clipIdShort}.{ext}`.

- `{artist}` resolves the **artist policy**, not the clip's `display_name` —
  those fields are the *owner's account identity*, never a third-party artist
  credit (`background/background.js:566-570`, `:2296-2298`).
- An unknown `{token}` becomes `_`, so no literal braces reach the filesystem
  (`background/background.js:2354`).
- Folder segments are honoured up to `maxFolderDepth`, hard-capped at 4
  (`background/background.js:2356-2365`).
- **The extension is ALWAYS appended** when the rendered name lacks one
  (`background/background.js:2379-2380`, using `extensionFor` at `:2286-2288`).
  The previous build never appended one.
- A title that sanitises to nothing falls back to `_`
  (`background/background.js:2370-2377`).
- Sanitisation is **hostile by design** (`background/background.js:2243-2260`):
  control chars, bidi overrides, line separators and BOM stripped; illegal
  characters replaced; dot-runs collapsed so `..` cannot survive; Windows device
  names prefixed; NFC normalised; 180-char basename cap.

---

## 🔐 Token acquisition

Not from cookies. **The Clerk JWT is not readable from `document.cookie`** — the
`__session` cookie is HttpOnly and is a different, Next.js SSR value; sending it
as a Bearer token is a bug (`lib/api.js:33-35`).

Instead the content script injects a small MAIN-world script
(`content/content.js:2949-2961`) that awaits `window.Clerk.session` and posts the
token back, and the worker mints it via `chrome.scripting`. Re-mint happens
**90 seconds before the JWT's own `exp`** (`TOKEN_REFRESH_SKEW_MS`,
`background/background.js:262`).

**401 + `exp` still in the future = bad token, not bad session**
(`lib/api.js:36-38`, surfaced as `error.code === 'bad_token'` vs `'unauthorized'`).
The recon hit exactly this trap with a byte-corrupted hand-pasted token
(`../suno-recon/reports/LIVE-2026-09-30.md:15-17`).

> ⚠️ **`GET_BOOT.token` and `GET_TOKEN_STATUS.token` are OBJECTS**, not strings:
> `{hasToken, expiresAt, secondsRemaining, source, badToken}`
> (`tokenStatus`, `background/background.js:1526-1539`). The old consumer guard was
> `TOKEN_RE.test(String(res.token))`, and `String({hasToken:true,…})` is
> `"[object Object]"`, which can never match the token pattern — so the dock's
> token panel silently reported nothing. The check is now a shape test
> (`content/content.js:3040-3051`).

---

**Next:** [DOWNLOAD-LADDER](DOWNLOAD-LADDER.md) · [FILTERS](FILTERS.md) ·
[RECON-NOTES](RECON-NOTES.md) · [KNOWN-LIMITS](KNOWN-LIMITS.md) ·
[← README](../README.md)