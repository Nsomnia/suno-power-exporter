# 🏗️ Architecture

Eight libraries, one orchestrator, and a set of Manifest V3 constraints that each
forced a specific design decision. The constraints are the interesting part —
this is a document about working inside them.

---

## 📁 File map

Line counts from `wc -l` at time of writing. **A line count in this table is a
size, not an address** — nothing in this document navigates by it. Where a claim
depends on a specific line, it is quoted as `file:line` **next to the text it
belongs to**, and the code's own comments are the authority; several of them
describe *why* a line must stay where it is. `scripts/check-build.sh` locates its
own targets by content for the same reason — a check anchored to a line number
silently stops checking anything the moment anything above it is edited.

| File | Lines | Responsibility |
|---|---:|---|
| `manifest.json` | 82 | MV3 declaration, permissions, host permissions, CSP |
| `background/background.js` | 11060 | **the only orchestrator** — 18 numbered sections + §5b, four of which now live in `background/parts/` |
| `background/parts/02-diagnostics.js` | 170 | §2 verbatim: the single `log()` + ring buffer. See § the parts mechanism |
| `background/parts/03-errors.js` | 182 | §3 verbatim: redaction, typed failures, classification. Five exports, read by 16 of the remaining sections |
| `background/parts/06-messaging.js` | 101 | §6 verbatim: `broadcast` + `validateSender`. 19 call sites, so the part mechanism's real stress test |
| `background/parts/15-quota.js` | 159 | §15 verbatim: the flat quota view, the fetch behind it, the toolbar badge. **Read this one first** — its header is the authoritative statement of how parts load |
| `content/content.js` | 5105 | the in-page dock: filters, results, batch drawer, row checkboxes, token **status** panel, the incompleteness banner |
| `content/content.css` | 980 | dock styling, loaded as a web-accessible resource |
| `lib/api.js` | 4351 | the only HTTP client; **24** verified routes, `RateLimiter`, typed errors, the `/api/feed/v3` cursor walk |
| `lib/audio.js` | 2037 | decode / resample / interleave / BPM primitives (pure math) |
| `lib/crypto.js` | 1234 | AES-GCM unwrap, chunked AES-CTR, counter arithmetic, container sniffing |
| `lib/db.js` | 2964 | the **only** thing allowed to open `suno-library`; 5 stores, schema v3 |
| `lib/drm.js` | 1808 | the Mango pipeline: rights handshake, streaming fetch, key cache, fan-out |
| `lib/lyrics.js` | 897 | LRC/txt/json sidecar construction, key-material scrubbing |
| `lib/suno.js` | 1567 | the filter engine: normalize, matches, facets, sort, parseQuery, presets |
| `lib/tagger.js` | 2126 | ID3 / MP4 metadata writing, container detection |
| `offscreen/offscreen.js` | 1607 | Web Audio + `createObjectURL` + the WAV renderer **and both vendored encoders** |
| `offscreen/offscreen.html` | 38 | the offscreen page; `default-src 'none'` |
| `options/options.js` | 1898 | the settings page |
| `options/options.html` | 612 | ladder editor, pacing, naming, tags, conversion, quota guard, import/export |
| `options/options.css` | 563 | |
| `popup/popup.js` | 3376 | the toolbar popup: boot, tiles, progress, activity log, the three-way sync verdict |
| `popup/popup.html` | 82 | |
| `popup/popup.css` | 401 | |
| `side_panel.js` | 2741 | the browse/search surface; 50-row paging from the local index, the same sync verdict |
| `side_panel.html` | 625 | |
| `vendor/lame.all.js` | 530,087 B | **third-party**: lamejs 1.2.1, **LGPL-3.0**, SHA-256 `026bd888…fea3b` |
| `vendor/OggVorbisEncoder.js` | 2,358,493 B | **third-party**: `higuma/ogg-vorbis-encoder-js` @ `7a87242`, **MIT** wrapper + **Xiph BSD** C, SHA-256 `5a9f749a…179b` |
| `vendor/LICENSE-lamejs.txt` | 424 B | the LAME FAQ answer shipped in the npm tarball, verbatim — see the caveat below |
| `vendor/LICENSE-OggVorbisEncoder.txt` | 1,078 B | the upstream **MIT** licence, © 2015 Yuji Miyane, verbatim |
| `vendor/README.md` | 10,327 B | provenance, pinned version/commit, both SHA-256s, licence positions, API notes |
| `.gitattributes` | 109 | `* text=auto eol=lf` plus `vendor/** -text` — see § why the encoders are vendored |
| `scripts/check-build.sh` | 951 | the pre-flight gate: **92 checks**, including SHA-256 of both encoders, cross-surface `stopReason` parity, and the parts collision/probe guards |
| `run` | 18 | a bash loop that opens `urls.lst` in Brave. Handy, not part of the build. |
| `urls.lst` | 85 | URL list for `run` |
| `icons/icon16.png` | 400 B | |
| `icons/icon48.png` | 3.6 KB | |
| `icons/icon128.png` | 18 KB | |

46,684 lines across the JS/HTML/CSS files in this table (including the four
extracted parts), **plus 2,888,580 bytes of vendored third-party JavaScript** that
is deliberately *not* counted there — see § why the encoders are vendored.

### The boundary rule

> `background/background.js:5-8`: *"It owns nothing that a lib already owns: every
> HTTP call goes through `SunoAPIClient`, every library row through `SunoDB`, every
> byte transform through `SunoDRM` / `SunoTagger` / `SunoLyrics` / `SunoAudio`. What
> lives here is the part no lib can own."*

The eight libs take their dependencies by injection rather than reaching for
globals — `fetchImpl` (`lib/api.js:1165`, settable at `:1179`) and an injectable clock
(`lib/api.js:1168`), an injectable
`indexedDB` under node (`lib/db.js:71`), an injectable crypto implementation with a
four-step resolution chain (`lib/drm.js:407-412`), a replaceable logger everywhere.
That is what lets the same file run in the service worker, in a content script, and
in an assertion harness with no shims.

The 18 sections, in order (`background/background.js:10-28`):

```
 0  Bootstrap            importScripts + global resolution
 1  Constants            storage keys, alarm names, ladder definition
 2  Diagnostics          the single log() + ring buffer            -> parts/02-diagnostics.js
 3  Errors               redaction, typed failures, classification -> parts/03-errors.js
 4  Settings             in-memory cache with write-behind
 5  Auth                 Clerk JWT minted from the page, never from cookies
 5b MAIN-world           the six page-side operations + the RUN_MAIN_WORLD route
 6  Messaging            broadcast, sender validation, router     -> parts/06-messaging.js
 7  Offscreen            blob URLs + Web Audio (worker has neither)
 8  Filenames            hard sanitisation + path templates
 9  Saving bytes         data: URL vs offscreen blob URL
10  The download ladder  seven rungs (progressive, mango-drm, studio,
      download-route, wav-official, zip, hls), each with a cost class
11  Tagging              tag + sidecar pipeline
12  Batch driver         resumable, isolated failures, quota-aware
13  Library sync         resumable crawl, no silent truncation, and §13c's run record
14  Query + selection    filter/sort/page server-side, explicit id list
15  Quota                DOWNLOAD quota, never credits             -> parts/15-quota.js
16  Router               the request table
17  Lifecycle            install / startup / alarms / download events
```

> The section-10 banner names all **seven** rung ids and the array it introduces has
> seven entries, so the header and the code agree.
>
> **§5b is not in the header list at `background/background.js:10-28`.** It was
> added after that list was written and the header was not updated, so the list
> reads as 18 sections while the file carries 19. This is a documentation nit in
> the source, not a code defect — `MAIN_WORLD_OPS` (`background.js:2719`) and
> `runMainWorldOp` are real, and everything below cites them at their actual lines.
>
> **The four arrows are a newer split.** §§2, 3, 6 and 15 have been extracted into
> `background/parts/*.js` as classic scripts loaded by `importScripts`; the
> numbered signpost comment for each one stays in the worker so a reader scanning
> the section list still finds where the code went. The mechanism, and the three
> rules that break silently when it is violated, are in
> [§ the parts mechanism](#the-parts-mechanism-backgroundpartsjs).
>
> The header's own list still describes all four sections as if they were inline,
> which is the same class of documentation nit as §5b — deliberately left in place
> rather than silently corrected, because the signposts do point at the truth.

### 🧩 The parts mechanism (`background/parts/*.js`)

The worker is 11,060 lines and splitting it is the only way it gets smaller
without an 11,000-line class. Four sections have moved out. The authoritative
statement of the mechanism is the header comment of the **first** part extracted,
`background/parts/15-quota.js:1-28`, and this section is downstream of it — read
that file if the two ever disagree.

`manifest.json` declares no `"type": "module"`, so the worker is a **classic**
worker and `importScripts` (`background/background.js:168-186`) evaluates in the
**same global scope** as the monolith. Each part therefore declares its own
top-level `function`s, which *are* the worker's bindings, and the worker calls
them as bare globals — exactly as it called them when they lived inline. Nothing
is imported; nothing is namespaced at the binding level.

Each part also publishes **one namespaced global** for discovery and load-time
health-checking:

| part | publishes | probed by |
|---|---|---|
| `background/parts/02-diagnostics.js` | `globalThis.SMUDiagnostics` (`:167`) | `MISSING_PARTS` at `background/background.js:252-254` |
| `background/parts/03-errors.js` | `globalThis.SMUErrors` (`:179`) | `:255-257` |
| `background/parts/06-messaging.js` | `globalThis.SMUMessaging` (`:100`) | `:258-260` |
| `background/parts/15-quota.js` | `globalThis.SMUQuota` (`:158`) | `:261-263` |

`MISSING_PARTS` is a **load-time** check, alongside `MISSING_LIBS`, because a part
that fails to parse or a path typo leaves its names undefined and the failure
otherwise surfaces as a mid-session error on one route rather than as "the file is
missing" at wake.

#### The three rules, and the regression each one prevents

These are the constraints that break **silently**, which is why they are written
down rather than left to a code review.

1. **A part must not CALL into the monolith at load time, only at call time.**
   `importScripts` runs near the top of the worker, long before the monolith's own
   declarations are evaluated. Everything a part needs from the monolith —
   `log`, `OpError`, `describeError`, `classifyAuthFailure`, `STORAGE_KEYS`,
   `SunoAPIClient`, `SunoAPI`, `TRUSTED_PAGE_PATTERNS`, `findSunoTabs` — is
   referenced inside function bodies, never while the part is being evaluated. A
   load-time reference would throw on **every worker wake**, not on a rare path.
   *Regression prevented:* an `importScripts` list reorder turning one keystroke of
   load order into a dead worker. Note that the `02 ↔ 03` cycle (`log` calls
   `redactText`; `redactText` is used by `log`) is safe **because both references
   are call-time**, so the order between those two files is genuinely irrelevant —
   they are listed in numeric order for readability only.

2. **A part must NOT re-bind its exports at the top level of the worker.**
   `const { quotaView } = SMUQuota;` in the worker throws
   `SyntaxError: Identifier 'quotaView' has already been declared`. A top-level
   `function` declaration occupies the global **lexical** scope that a top-level
   `const` also claims; wrapping it in a block only moves the error into a scope
   that cannot be used. That is why the worker reads the exported names **off the
   global deliberately and never re-binds them** (`background.js:248-250`,
   `MISSING_PARTS` reads `globalThis.SMUDiagnostics` rather than destructuring).
   *Regression prevented:* "cleaning up" the export contract into something that
   looks more idiomatic and takes the whole worker down at load.

3. **A top-level `function` in a part whose name the monolith also declares
   SILENTLY REPLACES the monolith's.** No error, no warning, and `node --check`
   still passes — it validates each file in isolation and cannot see that two files
   claim one global name. Every call site in the worker then quietly starts
   calling the part's version. (`const` behaves differently and worse-looking but
   better-caught: two parts declaring the same `const` throws `SyntaxError` at
   load. It is the `function` case that is invisible, and it is the only one worth
   guarding.)
   *Regression prevented:* this is what `scripts/check-build.sh` § 4c exists for —
   it extracts every column-0 `function` / `const` / `let` / `var` / `class`
   declaration from the worker and from every part and **fails on any overlap**,
   because the symptom it prevents is that logging (or whatever else a part
   shadows) behaves wrong in a way nothing points at.

A fourth asymmetry is worth knowing before anyone "fixes" a report: `function`
declarations become **properties** of the global object; `class` and `const`
declarations do **not** — they become bindings in the global *lexical* environment,
which is shared across classic scripts but is not reachable as a property. So after
`03-errors.js` loads, `globalThis.describeError` is a function, `globalThis.OpError`
is `undefined`, and a bare `OpError` reference works fine. **The worker must
reference the class export as a bare global.** Only the `globalThis.` form is
wrong, and only for the class.

#### What the build enforces

| check | what it prevents |
|---|---|
| every part is listed in `BUILD_FILES` (`scripts/check-build.sh:62-65`) | a part that exists on disk but is never `node --check`ed, so a parse error in it ships silently. The manifest/`importScripts` check proves the path *exists*; nothing proved it was *built* |
| every `MISSING_PARTS` probe names a symbol its part **actually exports** | a health check that reports healthy on a broken part — the same failure shape as the parity-check bug below, one level up |
| every `importScripts` path resolves **relative to the worker's own directory** | a renamed or moved part failing at runtime with no build-time complaint |
| no column-0 name is declared by both the worker and a part, or by two parts | rule 3 above |

Note that the parity check that first shipped in § 4b **had its own bug and
silently passed an injected drift**: it brace-balanced the map's span, and the
entries contain no braces, so the scan stopped after the first key — comparing one
trivial key across three files and passing however far they had drifted. It now
reads **consecutive entry lines**. It is in this document because a check that has
been wrong in exactly that way is worth knowing about the second time.

---

## 🧱 The MV3 constraints, and how each one is solved

This is the good part. Manifest V3 removes a lot of what an extension used to
take for granted, and each removal here produced a design decision that is still
visible in the code.

### 🚫 1. No Web Audio in a service worker

A service worker has no DOM, so no `AudioContext`, no `OfflineAudioContext`, no
`decodeAudioData`.

**Solved by an offscreen document** — `chrome.offscreen.createDocument` with
reasons `['AUDIO_PLAYBACK','BLOBS']` (`background/background.js:2987-2991`). It is
a real DOM page, so it can decode, resample, render a WAV header and detect BPM.

It is created lazily and **proven alive before first use**
(`ensureOffscreenDocument`, `background/background.js:2979-3035`, the `sunoPing`
probe at `:2999`). The liveness ping matters: a document that
exists but whose Web Audio failed to initialise answers `sunoPing` with `audio:false`,
and *"discovering that at the first 24 MB buffer is far worse than finding out
now."*

The protocol is `suno-offscreen/1` (`background/background.js:2957`):

| request | returns |
|---|---|
| `sunoPing` | `{ok, ready, protocol, audio, offlineAudioContext, encoder, stats, blobs, queue}` |
| `sunoAudioDecode` | `{ok, pcm:{channels:Float32Array[], sampleRate, durationSec}, warnings, contextsClosed}` |
| `sunoAnalyze` | `{ok, analysis:{peakDb, rmsDb, durationSec, sampleRate, channels, bpm, bpmConfidence}, warnings}` |
| `sunoRenderWav` | `{ok, bytes, sampleRate, bitDepth, bpm, bpmSource, warnings}` |
| `sunoBlobUrl` | `{ok, url, mime, byteLength, live}` |
| `sunoBlobRevoke` / `sunoBlobRevokeAll` | `{ok, revoked, live}` |
| `sunoTranscode` | `{ok, bytes, mime, format, sampleRate, warnings}` **or** `{ok:false, code:'ENCODER_UNAVAILABLE'}` / `{ok:false, code:'ENCODE_ERROR'}` / `{ok:false, code:'UNSUPPORTED_FORMAT'}` |

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
(`background/background.js:3222-3228`) — handing a truncated descriptor to a caller
expecting WAV bytes would produce a corrupt file. A truncated broadcast is still
decisive *evidence*, so it arms a 5-second fuse rather than the full budget
(`OFFSCREEN_TRUNCATED_GRACE_MS`, `background/background.js:2964`, armed at
`:3056-3072`).

#### 🔐 Why "the only sender is us" is not a security argument

Worth its own paragraph, because it is the kind of assumption that reads as
reasoning and is not.

`resolveOffscreenReply` used to match on `/:result$/` alone, and it runs **before**
`validateSender` (`background/background.js:7798-7801` vs `:7818`) — so it was
reachable by anything that could post a message on the runtime channel. The
request id is `'os' + sequence + '-' + Date.now().toString(36)`
(`background/background.js:3042`): a small, entirely enumerable space. Anything
that could post could guess an in-flight id and settle its waiter with a payload
of its choosing. The worst case is `sunoBlobUrl` — the forged `url` goes straight
to `chrome.downloads.download`.

`isOffscreenReply` (`background/background.js:3166-3183`) now requires **all** of:

- `message.from === 'offscreen'`
- `message.protocol === OFFSCREEN_PROTOCOL`
- `/:result$/` on `type`, **and** the shape `/^suno[A-Za-z]+:result$/` so the type
  agrees with the shape of the id we mint (`:3174`)
- `message.id` matching `/^os\d+-[a-z0-9]+$/` (`:3175`)
- `sender.url` matching `OFFSCREEN_PAGE_RE`, **when present** — belt and braces,
  because making it mandatory would turn a Chrome-side reporting change into
  "every download times out" (`:3180-3181`)

A rejected envelope never reaches the registry, not even to be remembered; it is
logged as `offscreen.reply_rejected` so a protocol change on either side is visible
in diagnostics instead of showing up as an unrelated timeout
(`background/background.js:3203-3210`).

The general lesson: **"the only extension sender is us" is an assumption about the
protocol, not a check.** Every inbound discriminator gets verified at the boundary,
in the same place, in one function.

### 🚫 2. No `URL.createObjectURL` in a service worker

`chrome.downloads.download()` needs a URL. There is no `URL.createObjectURL` in a
worker.

**Solved with a threshold** (`materializeUrl`, `background/background.js:3772-3788`):

```
bytes.length <= settings.dataUrlMaxBytes (default 24 MB)
   -> 'data:' + mime + ';base64,' + base64      -> data-url
otherwise
   -> ask the offscreen document for a blob URL -> blob-url
```

Two consequences worth knowing:

- The offscreen page keeps an **LRU of 8 blob URLs**. A long batch would evict a
  live URL mid-transfer, so each URL is **revoked the moment its transfer
  completes** (`revokeBlobUrls`, `background/background.js:3257-3267`, called from
  `onDownloadChanged` at `:3933`, `:3942`, and the startup reconciliation at `:4006`).
- `dataUrlMaxBytes` is user-tunable, clamped to 64 KB–64 MB
  (`background/background.js:1151`).

### ⏱️ 3. Workers get evicted at ~30 s idle

The worker can be killed at **any `await`** (`background/background.js:59-60`).
This is the constraint that shaped the most code.

| Rule | Where |
|---|---|
| **Nothing authoritative lives in a module-scope variable — with one qualified exception, below** | `background/background.js:59-68` |
| All durable state in IndexedDB + `chrome.storage.session` | `STORAGE_KEYS` at `background/background.js:269-287` |
| Settings are a **cache**, re-derived on every wake | `settingsCache`, `loadSettings` — both located by name; the declaration lines move with every extraction |
| Crawl cursors written after **every page** | `afterPage` → `DB.syncState.set('feed', cursor)` at `background/background.js:7249` (and after every workspace at `:7294`) |
| **The RUN is recorded in `chrome.storage.session`, not in a module binding** | `STORAGE_KEYS.SESSION_SYNC_RUN` = `suno.syncRun.session` at `:286`; the six scalars it holds are declared in `coerceSyncRun`'s `@returns` at `:8324-8326` |
| Batch plans persisted so an evicted worker can rebuild them | `persistPlan` at `background/background.js:4777` |
| An append-only journal per batch | `DB.journal.append` throughout |
| A 30-second alarm is the only reliable wake | `KEEPALIVE_PERIOD_MINUTES = 0.5` |
| `bootstrap()` is idempotent and re-entrant | `background/background.js:10778` |

#### 🚨 The module-scope rule is real, and it was FALSE here until §13c existed

This document used to assert *"Nothing authoritative lives in a module-scope
variable"* with a flat citation to two lines of the worker's header. **That
statement was not merely imprecise — the code was violating it, and two live bugs
came out of the violation.** Both were user-visible, and both looked like the UI
lying:

1. **A dead crawl reported itself as running.** `SYNC_STATUS.running` ORed in
   *"the stored heartbeat is younger than 90 seconds"* (`SYNC_STALE_MS`). A
   heartbeat written by a worker that has since been **evicted** stays fresh for
   ninety seconds, so every poll in that window was told a crawl was in flight when
   nothing could cancel it and no page would ever commit. There is exactly one
   worker at a time, so **"no controller" cannot mean "a different worker owns
   this"** — `running` is now `!!syncController` and nothing else
   (`background/background.js:10039-10049`).
2. **`cancelling:true` became permanent.** The stored `cancelRequested` was written
   on the press and **cleared nowhere**, and `DB.syncState.set` **merges**, so one
   cancel in a browser session made every later `SYNC_STATUS` report a cancellation
   still in progress — for every subsequent run, forever. It is now cleared at the
   run's verdict, at the §13c reconciliation (`background/background.js:8587-8596`),
   and `cancelling` is gated on a live run (`:10050-10057`).

**The honest version of the rule is the one the code now follows**, and it is
stated in the worker's own invariants block (`background/background.js:59-68`):

> a module-scope binding may be a cache or a handle, never the only copy of a fact
> a surface needs.

`syncController` and `syncCancelRequested` remain module-scope **deliberately**:
they are the things that *die* with the worker, because they describe the crawl
*this* worker is running, and after an eviction there is no such crawl to describe.
§13c keeps the part that must outlive the worker — *"a crawl is in flight, started
at T, and a Stop was requested"* — in `chrome.storage.session`, which survives
eviction and is cleared on browser close. **Two stores, two questions, one writer
each**: `DB.syncState` holds the **crawl** (how far the walk got, and does it
satisfy the oracle); `chrome.storage.session` holds the **run** (is a crawl in
flight right now).

The full argument, including why the run record is not simply a column on the
cursor row, is in § the state machine below and in the source at
`background/background.js:8256-8301`.

**Invariant B** (`background/background.js:38-39`) is the sharp edge:

> Every worker startup calls `downloads.resetInProgress()`; anything left
> `in_progress` was written by an evicted worker and is NOT done.

`reconcileDownloadsOnStartup` (`background/background.js:3962-4029`) then asks
Chrome what actually happened to every download we started, so transfers that
completed while the worker was dead get recorded correctly instead of retried. It
runs from `bootstrap` at `background/background.js:8091`.

**Invariant F** is the subtle one (`background/background.js:48-49`):

> `chrome.alarms.create` runs ONLY from onInstalled / onStartup. Creating an alarm
> at module scope resets its period on every worker wake.

The previous build ended up with a keepalive that fired constantly **and** one
that still did not protect a batch — the reasoning is repeated in the body of
`armKeepalive` (`background/background.js:7922-7941`), which along with
`armQuotaAlarm` (`:7955-7973`) is the only place an alarm is created.

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

`broadcast` at `background/background.js:2889-2926`.

### 🪟 5. `window` is undefined in a worker

The shim is four lines and runs **before `importScripts`**
(`background/background.js:128-156`):

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
(`offscreen/offscreen.html:17`).

**Consequence: an encoder cannot be fetched from a CDN, ever.** That is why MP3
and Ogg Vorbis are served by **locally vendored bundles** in `vendor/` rather than
a CDN import — and therefore why there is no "download it if missing" fallback
path to degrade to. See § why the encoders are vendored, immediately below.

`lib/api.js:58-59` records the other half of the posture: *"No page tampering: this
file never monkey-patches `window.fetch` and never injects script. It is a plain
IIFE so no internal name leaks to global scope."*

> ⚠️ **That sentence is scoped to `lib/api.js`, and it is still true there. It is
> no longer true of the extension.** `background/background.js` §5b does both — it
> installs a passive `fetch`/`XMLHttpRequest` header tap and it patches
> `window.MediaSource` — because the page has to be read from the page's own world.
> See § MAIN-world access, below, and KNOWN-LIMITS items 21–22. Do not read the
> `lib/api.js` header as a claim about the whole build.

### 🚫 7. A page's CSP forbids inline script — and you do not control the page

`suno.com` ships:

```
script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http://127.0.0.1:* chrome-extension://…/
```

**There is no `'unsafe-inline'`.** The old build needed to read `window.Clerk` and
to patch `window.MediaSource` — both page-world objects, neither visible to a
content script's isolated world — so it built a `<script>`, set `.textContent`,
appended it, and returned `true`.

**The append succeeds. The execution is refused.** The CSP violation is reported
afterwards, out of band, and the helper has already returned success. That is the
whole shape of the bug that shipped: three dead subsystems (the HLS patch, the HLS
restore, the page token reader) and zero errors anywhere. The reasoning is recorded
at `background/background.js:2015-2026` and `content/content.js:3163-3217`.

> **The general rule, and it is the one worth keeping.** Under a CSP you do not
> control, "did it run?" can never be inferred from the absence of an exception.
> It has to be answered by **reading state back**. `appendChild` not throwing tells
> you the DOM accepted a node.

**Solved by moving MAIN-world access into the worker**, which uses
`chrome.scripting.executeScript({world:'MAIN'})`
(`injectMainWorldOp`, `background/background.js:2755-2816`).
That runs in the page's main world and is **not** subject to the page's CSP, so it
is the only route this build uses for anything page-side.

Four design decisions, each of which is a consequence of MV3 rather than taste:

**1. The op is an allowlisted key, never a code string.** The page is handed one of
**six functions this file already contains**, resolved by exact key from a frozen
map:

```js
const MAIN_WORLD_OPS = Object.freeze({
  probe:       mainWorldProbe,        // background/background.js:2066
  'auth-tap':  mainWorldAuthTap,      // :2149
  'auth-read': mainWorldAuthRead,     // :2388
  'clerk-token': mainWorldClerkToken,// :2451
  'hls-patch': mainWorldHlsPatch,     // :2584
  'hls-restore': mainWorldHlsRestore, // :2648
});
```

`background/background.js:2716-2723`. There is no `eval`, no `new Function` and no
string-to-function path anywhere in the build — and there could not be, because
`script-src 'self'` forbids all three. Lookup is
`Object.prototype.hasOwnProperty` (`background/background.js:2761`), never
inherited, so `constructor` and `toString` cannot resolve to something; `Object.freeze`
stops a later route mutating the map but does **not** seal the prototype chain,
which is exactly why the exact-key guard is there rather than assumed.

The names are published as `mainWorldOps` on `GET_DIAGNOSTICS`
(`background/background.js:7385`), so "which probes exist" is answerable from one
reply instead of from memory.

**2. The tab comes from `sender.tab.id`, not from a guess.**
`runMainWorldOp` (`background/background.js:2817-2845`) resolves the caller's *own*
tab at `:2820` and refuses with `no_tab` when there is not one. That is correct:
`RUN_MAIN_WORLD` exists for content scripts, and an extension page has no
`sender.tab`. The worker, which must be able to reach a Suno tab the caller is not
sitting in, calls `injectMainWorldOp` (`background/background.js:2755-2816`)
directly with a tab id it already knows. It also re-checks `sender.url` against
`TRUSTED_PAGE_PATTERNS` at `:2829-2842` — defence in depth, because this is the one
route that injects into a page.

**3. Every MAIN-world function is self-contained and cannot throw across the
bridge.** `executeScript` stringifies `func`, so a MAIN-world function cannot close
over anything in the worker file — every constant it needs is a literal inside its
own body. That is also why `MAIN_WORLD_OPS` exists as a map rather than as a name
the page resolves: the map is the worker's copy and only the *value* (the source
text) crosses. The four-part contract is written out at
`background/background.js:2028-2048`: self-contained, never throw across the bridge
(a MAIN-world exception surfaces as an opaque `inject_failed`, destroying the
difference between "ran and failed" and "never ran"), plain JSON-serialisable
values only, and **no token in any field other than `token`**.

**4. The result is verified, not trusted** — in both directions.
`injectMainWorldOp` rejects `ok:true` with no result object
(`background/background.js:2790-2792`) and treats a thrown `executeScript` as
`inject_failed` (`:2780-2787`); the content script's `mainWorldOp`
(`content/content.js:3227-3245`) then makes the same distinction, so
*"the worker reported success but sent no result"* and *"the operation ran and
failed"* are two different messages. Inside the page, each op reads its own effect
back: `window.fetch === wrappedFetch` (`background/background.js:2319`),
`XHR.prototype.open === wrappedOpen` (`:2356`),
`window.MediaSource === undefined` (`:2623-2626`). **The last one was itself a
bug once** — assigning to a non-writable `MediaSource` is a silent no-op in sloppy
mode, so the first version of the fix would have repeated the original lie in a new
place.

**The one `timeoutMs` is a value, not code.** `clerk-token` takes its wait through
`executeScript`'s `args` channel, which cannot inject anything, and the worker
coerces and clamps it into `[500, 30000]` before it gets there
(`background/background.js:2764`, clamp helper at `:2739-2743`, bounds at `:279-281`).
The 100 ms poll cadence inside `mainWorldClerkToken` is a literal **in that
function and only there**, on purpose: the function is stringified into the page, so
a worker-side constant to "keep in step with" would be a constant nothing reads, and
a trap for whoever changes the wrong one (`background/background.js:2452-2457`).

### 📦 Why the encoders are vendored, and how `.gitattributes` protects their bytes

**The files.** Two upstream bundles, shipped unmodified, with their notices:

| file | what it is | size | SHA-256 | licence |
|---|---|---:|---|---|
| `vendor/lame.all.js` | lamejs **1.2.1** — defines the global `lamejs`, whose `Mp3Encoder` does the MP3 encode | 530,087 B | `026bd88846040f357a937cd85821a48492a362eff0812cda734f23fca55fea3b` | **LGPL-3.0** |
| `vendor/OggVorbisEncoder.js` | `higuma/ogg-vorbis-encoder-js` @ **`7a872423f416e330e925f5266d2eb66cff63c1b6`** — defines the constructor `OggVorbisEncoder` | 2,358,493 B | `5a9f749ab0f84da2292bd68b0e906422378428aea2e298fd116e8a1696da179b` | **MIT** (JS wrapper) + **Xiph BSD** (the compiled-in libogg/libvorbis C) |

Plus `vendor/LICENSE-lamejs.txt`, `vendor/LICENSE-OggVorbisEncoder.txt` and
`vendor/README.md`, which records provenance, the pinned version and commit, both
digests and both licence positions. **Note the Ogg licence is MIT, not
BSD-3-Clause** — the shipped file wins over the task brief that said otherwise, and
the split between the MIT JS wrapper and the Xiph BSD C is real rather than a
formality (`vendor/README.md:110-131`).

**Why local, mechanically.** Three reasons, any one of which is decisive:

1. They are loaded from inside the extension package at runtime.
   `offscreen/offscreen.js` injects a `<script src>` for each one, resolved
   relative to `offscreen/offscreen.html`, and `loadVendoredScript()` asserts the
   resolved URL's protocol is `chrome-extension:` and **refuses anything else**
   (`offscreen/offscreen.js:781-790` guard, `loadVendoredScript` at `:797`). Editing
   that path constant to an `https` URL cannot reintroduce remote code.
2. MV3's `script-src 'self'` plus the Web Store's ban on remotely hosted code means
   fetching an encoder is not an available fallback at all — see § 6 above.
3. **An untracked `vendor/` fails silently and only in production.** The extension
   still loads, the options page still offers MP3 and Ogg Vorbis, and
   `sunoTranscode` just returns `ENCODER_UNAVAILABLE`
   (`offscreen/offscreen.js:863-870`): the control looks live, the click succeeds,
   and no file appears. A fresh clone would ship that way with no error anywhere.
   `.gitignore:38-88` spells out why that directory is **tracked on purpose** and
   carries no ignore rule.

Neither file needs `wasm-unsafe-eval` or a sidecar: `lame.all.js` is a browserified
bundle of the `src/js` tree, and `OggVorbisEncoder.js` is an **asm.js** build with
its memory initialiser embedded (one `use asm` directive, zero `WebAssembly`
references, no `.mem` file). `manifest.json` needs no `web_accessible_resources`
entry for either, because a `<script>` injected by an extension page into that same
page is same-origin.

**Why `.gitattributes` exists.** Because `.gitignore` cannot do this job.
`.gitignore` controls **membership** — which paths git tracks — and has no say
whatsoever over the **bytes** of the files it does track. A tracked file is
rewritten in the working tree on checkout according to the EOL rules, whether or
not it is listed. So the only place to state *"these files are binary, leave them
alone"* is `.gitattributes`:

```
* text=auto eol=lf
vendor/** -text
```

Under `core.autocrlf=input` (the macOS default) git applies no EOL normalisation
and today's checkout is already correct. The danger is the next contributor:
anyone on Windows with `core.autocrlf=true`, or anyone whose editor rewrites line
endings on save, would check out **2.8 MB of CRLF-lifted JavaScript**. Every LF
becomes CRLF, the stored blob changes, the recorded SHA-256 stops matching — and
two separate claims fail at once:

- the **integrity claim** in `vendor/README.md` becomes a lie that nobody notices,
- and so does the **LGPL-3.0 "unmodified separate work"** position that
  `offscreen/offscreen.js` relies on. A CRLF-rewritten file is no longer the file
  upstream published, and "drop-in replaceable by the user" stops being true.

Note that `vendor/** text eol=lf` would **not** be enough: `eol=lf` also rewrites
a *lone* CR, and `vendor/OggVorbisEncoder.js` is an asm.js bundle whose byte-exact
content is load-bearing. `-text` is the correct rule.

**What enforces it.** `scripts/check-build.sh` runs **92 checks**, up from 63. The
ones that matter most:

| check | what it does |
|---|---|
| SHA-256 of both encoders | verifies each bundle against the digest **parsed out of `vendor/README.md`** — never restated in the script, so the record and the bytes cannot drift apart. A missing section, a missing `\| SHA-256 \|` row or an unparseable digest is a **FAILURE**, not a silent skip. Also compares the recorded byte size. (`scripts/check-build.sh:326-420`) |
| existence + byte audit + UTF-8 over all five `vendor/` files | the byte audit, the Chrome-strict non-character gate and the `iconv`/`python3` validity pass used to **skip** `vendor/`, which meant the largest JavaScript in the package was the only JavaScript nobody checked (`scripts/check-build.sh:151-325`) |
| `node --check` on both bundles | **tolerated, not failed**: `OggVorbisEncoder.js` parses but V8 prints *"Invalid asm.js: Expected shift of word size"* on stderr while still exiting 0 — a compiled-mode advisory about one shift inside libvorbis, not a syntax error and not a sign the bytes changed. Failing on upstream code we are forbidden to patch would be failing on the wrong thing (`scripts/check-build.sh:721-754`) |
| **duplicated `stopReason` maps are byte-identical** | the sync `stopReason` → English map is deliberately duplicated in `popup/popup.js:648-660`, `side_panel.js:483-495` and `content/content.js:2055-2067` — content scripts and extension pages share no module graph, so there is nowhere to put one copy all three can read. Nothing but discipline kept them equal, and a reason added to one file and forgotten in the other two produces two surfaces describing the same failure differently. **This check has been wrong exactly once and passed an injected drift**: it brace-balanced the map's span, and the entries contain no braces, so the scan stopped after the first key. It now reads consecutive entry lines (`scripts/check-build.sh:421-524`) |
| **no global name collision between parts and the monolith** | rule 3 of [§ the parts mechanism](#the-parts-mechanism-backgroundpartsjs): a part declaring a top-level `function` the worker also declares silently replaces it, with no error and `node --check` still passing. The check extracts every column-0 `function`/`const`/`let`/`var`/`class` name from the worker and from every part and fails on any overlap (`scripts/check-build.sh:525-617`) |
| **every part is registered in `BUILD_FILES` and its `MISSING_PARTS` probe is honest** | a part on disk but absent from `BUILD_FILES` is never syntax-checked, and a probe naming a symbol the part does not export reports healthy on a broken part. Both are asserted (`scripts/check-build.sh:618-704`) |
| **`importScripts` paths resolve** | resolved **relative to the worker's own directory**, because the manifest cannot express them at all — so nothing else in the build would notice a renamed or moved part until a worker wake (`scripts/check-build.sh:812-885`) |

> **`vendor/` is in `AUDIT_FILES`, deliberately *not* in `BUILD_FILES`.** None of
> those five paths appear in `manifest.json` (the offscreen page injects the
> `<script>` at runtime), so the manifest path check cannot police them, and
> `BUILD_FILES` is documented as the list to keep in sync with the manifest
> (`scripts/check-build.sh:51-81`, the declaration and its comment). **A part
> belongs in it**, and there is now a check for that — see the parts table above.

### Other MV3 details the code handles

- **`onMessage` must return `true` only for async handlers.** Returning it
  unconditionally leaks the channel for every synchronous reply — the documented
  cause of *"the message port closed before a response was received"*. The listener
  inspects the **result**, not a hand-maintained `async` flag, *"because a flag that
  disagrees with the handler is exactly how a reply gets written to a channel that
  has already closed"* (`routeMessage` at `background/background.js:7779-7830`, the
  listener `onRuntimeMessage` at `:7875`).
- **`document.body` is null at `document_start`.** The content script obeys one
  rule: no DOM access anywhere that assumes body exists until `mount()` runs
  (`content/content.js:6-11`, `mount()` at `:3635-3641`). Getting this wrong is what
  made the old page UI completely dead.
- **Sender validation on every route.** `validateSender`
  (`background/background.js:2927-2937`) checks **both** `sender.id === chrome.runtime.id`
  **and** a `sender.url` allowlist (`background/background.js:383-389`). An unknown
  type is rejected the same way, and both replies are **synchronous**
  (`background/background.js:7818-7826`). The old `TRIGGER_NATIVE_DOWNLOAD`
  checked neither and downloaded an arbitrary caller-supplied URL.
- **`RUN_MAIN_WORLD` re-checks the sender URL itself**
  (`background/background.js:2829-2842`), on top of `validateSender`, because it is
  the one route that puts code into a page. See § MAIN-world access.
- **There is no page-side credential relay, and there never was a working one.**
  The old `window.addEventListener('message', …)` handler that accepted a token
  pushed by a page-injected script is gone, along with the worker's waiter map
  (`background/background.js:1494-1505`) and the `SUNO_TOKEN_REQUEST` message.
  It could not have worked: it required the inline `<script>` suno.com's CSP refuses
  to execute, and `window.Clerk` is invisible to a content script's isolated world
  regardless. The reason is recorded at `content/content.js:3212-3217` rather than
  deleted, because *"it could not have worked from a content script either way"* is
  the fact worth keeping.
- **The `SET_TOKEN` handler has no `requestId` branch.** It used to call
  `resolveTokenRelay(...)`, which was deleted along with the relay and was not
  defined *anywhere* in the file — so any caller sending a `requestId` would have
  thrown a `ReferenceError` and died before storing the token. Removed, with the
  reasoning in place (`background/background.js:7420-7427`).
- **Zero empty catch blocks** (invariant H, `background/background.js:52-54`).
  Every failure logs with enough context to diagnose it, *"which is what made the
  previous 30-swallows build undiagnosable."*

---

## 📨 The message protocol

### Request types (extension pages → worker)

**28 routes** in the `ROUTES` table (`background/background.js:7676-8176`). Every
one is `{handler}` where `handler(payload, sender)` returns a plain object
(synchronous reply, channel NOT held open) or a promise. There is no
hand-maintained `async` flag, because a flag that disagrees with the handler is
precisely how a reply ends up written to a closed channel
(`background/background.js:7663-7676`).

| Type | payload | returns |
|---|---|---|
| `GET_LIMITS` | — | `{ok, ladder, variants, variantAliases, wavRungRates, signedUrlTtlSeconds, apiLimits, quotaSemantics, endpoints, dataUrlMaxBytes, maxFolderDepth, syncFlushEveryPages, rebuildBufferCap}` — **the only synchronous handler** |
| `GET_BOOT` | — | `{ok, version, settings, defaults, ladder, variants, token, quota, quotaFetchedAt, library:{counts,downloadsByState,estimate,schemaVersion}, sync, download:{running,batchId,lastBatch}, capabilities:{filter,tagger,drm,crypto,audio,lyrics,offscreen,missingLibs,mainWorld,lastAuthFailure}}` — **`sync` is the completeness contract; see below** |
| `GET_DIAGNOSTICS` | — | `{ok, debug, entries, api, drm, audioWarnings, missingLibs, rateLimiter, mainWorldOps, lastAuthFailure}` |
| `RUN_MAIN_WORLD` | `{op, timeoutMs?}` — **`op` is one of six fixed keys**, `timeoutMs` is read only by `clerk-token` | `{ok:true, op, result}` **or** `{ok:false, code:'bad_op'\|'no_tab'\|'forbidden'\|'inject_failed', error}` |
| `SET_TOKEN` | `{token, expiresAt?}` — **`requestId` no longer accepted**; see § MAIN-world access | `{ok, expiresAt}` |
| `GET_TOKEN_STATUS` | — | `{ok, token}` |
| `SYNC_START` | `{force?, dislikedMode?, maxPages?}` | `{ok, force, dislikedMode, maxPages, total, state}` |
| `SYNC_STATUS` | — | `{ok, running, cursor, truncated, total, completed, stopReason, error, expectedTotal, totalSeen, missing, workspaces}` — see below |
| `SYNC_CANCEL` | — | `{ok}` |
| `GET_CLIPS` | `{spec, sort?, order?, offset?, limit?}` | `{ok, clips, items, total, offset, limit, hasMore, librarySize, truncated, description}` |
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

#### 🔴 The sync-completeness contract

**Six** replies carry it, and **they carry the same field names with the same
meanings**, because all six are produced by **one builder**
(`syncContractView`, `background/background.js:6273-6322`; the rationale for the
builder being one function at `:6232-6272`). This is the single most load-bearing
thing in the protocol, and it exists because a crawl that died on page 20 once set
`lastError` and still rendered **"Up to date."**

| field | meaning |
|---|---|
| `completed` | **authoritative.** `true` only when the crawl reached the end of its own walk **and**, where the oracle is valid, met it |
| `truncated` | the compatibility flag, derived as **`!completed`** — never only the `max_pages` case |
| `stopReason` | the machine-readable cause; one of `complete \| page_failed \| empty_page \| stuck_cursor \| no_new_ids \| max_pages \| expected_total \| suspected_truncation \| interrupted \| aborted` (rows from older builds may also carry `cursor_missing` — a cursor-less page now completes by omission, so no new row can) |
| `error` | redacted text. **Never dropped on the failure path**, and `SYNC_STATUS` also carries it as `error` beside the cursor's own `lastError` |
| `expectedTotal` | the sum of every project's `clip_count` — the oracle. **`0` is the "Suno reported no count" sentinel** and every surface treats it as *unknown* rather than as zero |
| **`totalSeen`** | **UNIQUE clips indexed** — what "5,501 of ~5,500" has to mean |
| **`uniqueSeen`** | the **same number under its own name**, so a reader never has to work out which of two spellings a given reply used |
| **`examined`** | rows **walked**, repeats across workspaces included. This is what `missing` is computed from, and the only tally the oracle may be compared against — see § the oracle |
| `missing` | `max(0, expectedTotal - examined)`, floored at 0 |
| **`oracleApplied`** | was `missing` **CHECKED** against the oracle, or merely **REPORTED**? `false` when the walk was filtered, or when no count describes it |
| **`advisory`** | the human sentence for the same fact. **Never an `error`** — painting an unfiltered lower bound as a failure is the defect this key exists to prevent |
| `workspaces[]` | one row per project: `{projectId, name, completed, pagesDone, totalSeen, expected, missing, oracleApplied, advisory, stopReason, error, disliked}` |
| `state` | `'idle'` **only** when `completed === true`; else `'incomplete' \| 'error' \| 'cancelled'` |
| `pagesDone` | pages walked, never derived from a count |

> ### 🔴 `missing` is AUTHORITATIVE whenever the key is present as a number — `0` included.
>
> A `missing:0` beside an `expectedTotal:5502` means *"checked, nothing missing."*
> A reader that re-derives `expectedTotal - totalSeen` there gets a **phantom
> shortfall** — and did, on every UI in this build, because `totalSeen` is the
> **unique** count while `missing` is computed from `examined`. On 20 workspaces ×
> 275 clips with **one** clip in two workspaces the worker correctly said
> `completed:true, missing:0` and the popup printed *"1 clip is missing"*,
> permanently, on a crawl that had every clip. The dock contradicted itself at the
> same time: banner hidden (because `completed === true`), status line
> `INCOMPLETE`.
>
> **Derive `missing` only when the key is entirely absent** — the legacy-reply
> case, where deriving from `examined` still says something truthful instead of
> nothing. The root cause was a `pick()` helper that chose its fallback on
> **falsiness**, so a present `0` was coerced to `null` and *"not told"* became
> indistinguishable from *"told zero"*: **a falsy check where a presence check
> belongs.** All three surfaces now test **presence** —
> `popup/popup.js:325-328` + `:337-338` + `:363-372`, `side_panel.js:262-263` +
> `:283-289`, `content/content.js:1968-1969` + `:1991-1999`.

**And the converse is enforced too:** the UI must never call a *complete* crawl
incomplete. A wrong answer in the cautious direction is still a wrong answer, and
it is the direction that teaches users to stop reading the word.

Carriers:

- `GET_BOOT.sync` — flat, at `background/background.js:7768-7815`
- `SYNC_STATUS` — the whole `cursor` object one level down **and** mirrored at the
  top level (`background/background.js:7963-8016`); a **no-row** install gets
  every flag and count `null`, which is the placeholder and not a verdict
  (`:7971-8000`)
- `SYNC_DONE` — top level (`background/background.js:7204-7218`, and the abort
  path at `:7265-7275`)
- `SYNC_ERROR` — top level, **including on both failure paths**
  (`background/background.js:7303-7310` and the outer net at `:5763-5783`)

### The four routes that changed shape in 6.0.1

Every route now carries a self-describing doc comment naming its side-effect
class and which surface owns the corresponding control, because *"nothing in this
build sends this message on its own"* is exactly the fact that used to be
undocumented and therefore unfindable:

| Route | what changed |
|---|---|
| `GET_LIMITS` | now publishes **`variantAliases`** and **`wavRungRates`** (`background/background.js:7694-7712`, returned at `:7712-7740`) alongside `variants`, so a UI can build its select from the worker's own list *and* explain a substitution instead of silently showing a different value than the user picked. Also documented as **NO SIDE EFFECT** — reads constants and cached values only. |
| `GET_DIAGNOSTICS` | documented as the "is this install healthy?" surface and the **only** reader of `missingLibs` / `audioWarnings` (`background/background.js:7866-7890`). No side effect. Since 6.1.1 it also carries **`mainWorldOps`** and **`lastAuthFailure`** (`:7385-7386`), so "not signed in" is answerable from one reply. |
| `DOWNLOAD_STATUS` | accepts an **optional `{batchId}`** (`background/background.js:8071`, read at `:8077`): a UI holding a stale id from an earlier poll can ask about *that* batch. Omitting it keeps the previous behaviour (active batch, else last recorded), so an existing caller that sends nothing is unaffected. |
| `PROBE_DRM` | accepts an **optional `{ladder:[…]}`** to probe a hypothetical ordering instead of the configured one (`background/background.js:8206-8231`, `evaluateLadder` called at `:8261`), and now reports **`metered`** — the first available rung that *costs* a download, so a UI can say what the honest-but-paid alternative is (`:8262-8278`). |

### `RUN_MAIN_WORLD` — the only route that puts code in a page

`{op}` is resolved by exact key from `MAIN_WORLD_OPS`. **There is no `op` that
takes code.** Request: `{op, timeoutMs?}`; reply: `{ok:true, op, result}` where
`result` is the op's own plain object, or `{ok:false, code, error}`.

| op | what it does | returns | writes the page? |
|---|---|---|---|
| `probe` | reachability diagnostic: `href`, `readyState`, whether `Clerk`/its `session`/`getToken` exist, whether `MediaSource` exists and what type, whether `fetch`/`XHR` are functions, and whether the tap is installed and holds a token. `href` is origin + pathname only — a suno.com query string can carry a share id, and this lands in a buffer **persisted** to `storage.local` (`background/background.js:2066-2079`) | `{ok, href, hasClerk, hasSession, getTokenType, hasMediaSource, mediaSourceType, hasFetch, hasXHR, tapInstalled, tapHasToken, readyState, error}` | no |
| `auth-tap` | installs the **passive** `Authorization: Bearer <jwt>` header observer on `fetch` and `XMLHttpRequest`. Idempotent; writes `window.__smAuthTap` **before** any hook, so a partial install can never become a double-wrap (`background/background.js:2163-2360`) | `{ok, alreadyInstalled, installedAt, fetchHooked, xhrOpenHooked, xhrHeaderHooked, hasToken, errors[]}` | **yes** — wraps `fetch` and two `XMLHttpRequest.prototype` methods |
| `auth-read` | reads whatever the tap has captured, if the tap is installed. Cheapest op in the set; answers immediately (`background/background.js:2402-2440`) | `{ok, token, source:'tap'\|null, ageMs, error}` | no |
| `clerk-token` | polls for `window.Clerk` **inside the page** at 100 ms, then calls `session.getToken()`. Reports `{hasClerk}` separately from success, so *"Clerk never appeared"* is distinguishable from *"Clerk was there and `getToken()` never settled"* (`background/background.js:2465-2530`) | `{ok, token, waitedMs, hasClerk, error}` | no |
| `hls-patch` | `window.MediaSource = undefined`, so Suno's player falls back to a plain fetch and the resulting `manifest.m3u8` becomes readable. **Verifies the write landed** by reading the property back (`background/background.js:2631-2641`) | `{ok, patched, alreadyActive, hadMediaSource, error}` | **yes** — one property |
| `hls-restore` | the undo. Puts `MediaSource` back, or **deletes** the property when the page never had it, and re-checks that the delete took. Both branches in one `try`/`catch` so a failure still reaches the flag-clearing step — otherwise the page is left broken **and** un-restorable by the next attempt (`background/background.js:2650-2718`) | `{ok, restored, note:'restored'\|'deleted'\|'notActive'\|'deleteFailed', error}` | **yes** — restores |

Two of the six write to the page and one of *those* two writes to the page only
during an explicitly confirmed HLS capture. Everything else is a read.

> ⚠️ **`auth-tap` is page tampering, however passive.** It wraps `fetch` and two
> `XMLHttpRequest.prototype` methods, forever, until a reload. It never alters a
> request and always calls through — but it is a hook on Suno's own page, and the
> token it captures is readable by same-origin page script. Recorded in full at
> KNOWN-LIMITS items 21–22.

> ⚠️ **`SYNC_STATUS` still returns `total` but not `added`** — see KNOWN-LIMITS §15.
> And `DL_DONE` still carries no per-clip detail — see KNOWN-LIMITS §14.

### Push types (worker → everyone)

**11 types**, frozen in one `Object.freeze`d `Set` named `PUSH_TYPES`
(`background/background.js:911-916`). **The router ignores all of them**, so a
broadcast can never re-enter the router and be answered with "unknown message type"
(invariant E, `background/background.js:46-47`; the router's own check is
`if (PUSH_TYPES.has(message.type)) return null;` at `:10460`).

| Type | payload |
|---|---|
| `SYNC_STARTED` | `{state:'running', running:true, cancelRequested:false, force, dislikedMode, maxPages, feedPageLimit, total, heartbeatAt}` (`background/background.js:5755-5766`). **Authoritative**: it is the worker's own statement that a crawl exists, and all three surfaces route it through their one authority writer rather than inferring liveness |
| `SYNC_PROGRESS` | `{page, pagesDone, seen, added, etaMs, state, workspace, workspacesDone, expectedTotal, totalSeen, uniqueSeen, completed, truncated}` — `truncated:true` because a run in progress is by definition not a finished library (`background/background.js:7250-7276`). The phase-reporting path broadcasts the **same type** with `{phase, phasePagesDone, phaseJoined, phaseItems, note, total}` and `etaMs:null` (`:8102-8118`) — one type, two shapes, which is why `SYNC_PROGRESS` alone never establishes liveness on a surface |
| `SYNC_DONE` | the **whole contract** (`...syncContractView(cursor)`, `background/background.js:7791-7805`) plus `{total, projects, durationMs, projectList, projectFeed, dislikedCount, dislikedApproximate}`. The abort path is the **same reply** (`:7858-7868`) — an abort is still a `SYNC_DONE`, because the reply a user sees after pressing cancel has to say the same things every other reply says |
| `SYNC_ERROR` | the **same key set as `SYNC_DONE`**, `completed:false` (`background/background.js:7902-7909`, outer nets at `:5781-5790` and `:5810+`) — `error` is the **accumulated** `lastError`, not the tail of the failure list |
| `SYNC_CANCEL_REQUESTED` | `{state:'cancelling', running:true, cancelRequested:true, alreadyRequested, heartbeatAt}` (`:8225-8232`). "Stopping", **not** "stopped": an abort is cooperative and the crawl unwinds at its next `await` |
| `SYNC_CANCELLED` | `{state, running:false, cancelRequested:false, orphanedCursorCleared, stale, heartbeatAt}` (`:8174-8182` cleared an orphan; `:8203-8211` nothing was running; `:8648-8658` the §13c wake reconciliation). `running:false` and **no verdict rides on it** — a surface must re-read the cursor, which is what makes it safe as the reconciliation's terminal push |
| `DL_PROGRESS` | `{batchId, done, total, ok, failed, skipped, currentTitle, bytes, etaMs}` (`:5218`) |
| `DL_ITEM` | `{batchId, clipId, variant, state, filename, source, error, bytes}` (`:5233`) |
| `DL_DONE` | `{batchId, ok, failed, skipped, durationMs, stoppedReason, quotaPolls, remainingItems, quotaStop, quotaAfter}` (`:5494`) |
| `DL_ERROR` | `{error, code?}` (`:3495`) |
| `TOKEN_CHANGED` | `{expiresAt}` (`:1580`, and `:10001` on the `SET_TOKEN` route). `expiresAt: null` means **"unknown"**, not "none" |

#### Handling is per-surface, and the three sync-lifecycle pushes were the gap

**Handling is not universal, and it was not — it is worth being precise about which
push went missing where, because the symptom was silent and one of the three was a
dropped verdict rather than a dropped pixel.**

`SYNC_STARTED`, `SYNC_CANCEL_REQUESTED` and `SYNC_CANCELLED` are the **three
sync-lifecycle pushes**. All three are in `PUSH_TYPES`, and all three surfaces now
handle all three — but the in-page dock **did not**, at the time this document was
written:

| surface | listener | the three lifecycle cases |
|---|---|---|
| popup | `popup/popup.js:3096-3106` | `:3099-3101` |
| side panel | `side_panel.js:2463-2570` | `:2478`, `:2513`, `:2519` |
| in-page dock | `content/content.js:4917-5085` | `:4939`, `:4957`, `:4971` — **added**; they used to fall through to `default:` and vanish |

The dock's three cases carry the reason they exist in place
(`content/content.js:4932-4938`): a sync started from the popup or the side panel
left the dock idle — no running dot, no phase, no poll armed — and a cancellation
started elsewhere was never reflected at all. **The dock is the surface that
reports the crawl's completeness**, so a dropped push there is a dropped verdict,
not a cosmetic gap.

Two related facts the same fix depends on, and which a reader should not
reconstruct by accident:

- **`SYNC_PROGRESS` cannot put a surface from "not running" into "running."** It
  carries no `running` field, and arming a poll means believing a crawl is live.
  Both the dock and the side panel enforce that in their `applySyncProgress`
  handlers (`content/content.js:4922-4926`, `side_panel.js:2492-2498`) — the side
  panel used to call `setSyncRunning(true, …)` on exactly that evidence, which was
  one of the ways two surfaces came to disagree about one crawl. **The running
  answer comes from `SYNC_STATUS`, `SYNC_STARTED`, or the surface's own
  `SYNC_START`.**
- **An unhandled push type is not silently swallowed on the dock.** `default:`
  tallies it into `unknownPushes` and logs a count under `settings.debug`
  (`content/content.js:5069-5085`), because a push type the switch does not know
  is either a worker that grew one — and the dock is then behind the contract — or
  a message that should never have been sent. The side panel's `default:` is a bare
  `break` (`side_panel.js:2568-2569`), so it is the dock that carries that tally.

> **No push may carry a completeness verdict.** `broadcast` is the fan-out for
> every push type, and the contract that says whether a crawl is complete is
> `syncContractView` in §13. A second surface inventing its own answer from a push
> is exactly the drift the completeness contract exists to prevent — which is why
> `SYNC_CANCELLED` deliberately carries no verdict and each surface re-reads the
> durable cursor instead.

`stoppedReason` is the one field that must never collapse: it is
`'complete' | 'quota' | 'ladder_exhausted' | 'cancelled'`
(`background/background.js:4756`, computed by the ternary at `:5428-5432`), and
both UIs branch on it rather than on `failed` — a batch that halted on the monthly
allowance is a warning, not a success and not a failure (invariant H,
`popup/popup.js:42-48`; the dock renders four distinct outcomes from it at
`content/content.js:3480`).

Note the two `stoppedReason` vocabularies, which are easy to confuse: **`DL_DONE`
carries the batch reason; `SYNC_DONE` carries `stopReason`.** They are unrelated
fields with different value sets.

### Offscreen traffic (worker ↔ offscreen page)

`{target:'offscreen', type, id, ...payload}` out; the reply lands back on the
worker's `onMessage` as either a structured-clone `sendResponse` or a
`{type:'<type>:result', id, ok, …}` broadcast.

The router deliberately **falls through** for `target:'offscreen'`
(`background/background.js:8314-8318`) — swallowing it is how a blob URL silently never
arrives. `:result` messages go to `resolveOffscreenReply`, which verifies the
envelope before anything can settle a waiter (`background/background.js:3180-3205`),
and all of them are then **dropped** (`background/background.js:8330`): the offscreen page is not waiting on a
reply to its own reply, and answering a rejected one "unknown message type" is pure
noise on top of the rejection already logged.

> There used to be a `target:'background'` branch answering `offscreenReady` /
> `offscreenPing`. It was **removed**, because `offscreen.js` has never sent such a
> message — a listener for messages that cannot arrive is pure liability. The
> reasoning is recorded in place (`background/background.js:8332-8340`). The
> offscreen document's liveness is established by `sunoPing`, which is a real
> request/response exchange.

---

## 🔄 Data flows

### Sync

```
UI                    SYNC_START {force?, dislikedMode?, maxPages?}
  │
  ▼
startSync()                          background/background.js:5714-5787
  │  refuse if a sync is running    (one at a time)
  │  resolve mode: 'include' | 'exclude' | 'both'
  ▼
runSync()                            background/background.js:6340-7314
  │                                     (rationale at :6324-6339)
  │
  ├──> fetchAllProjects()      -> GET /api/project/me, PAGED to num_total_results
  │      background/background.js:5807-5921
  │      └──> buildWorkspacePlan()  : every project, `default` forced in
  │                                  background/background.js:5937-5950
  │      └──> expectedClipTotal()   the ORACLE: sum of clip_count   lib/api.js:2556-2586
  │      └──> cache the plan to meta.projects.cached
  │
  ├──> ORACLE SCOPE, decided ONCE and up front   background/background.js:6500-6555
  │      oracleApplied = (includeTrashed === true && disliked-on-the-wire === 'Any')
  │      false  -> `missing` is REPORTED, with `advisory`; `completed` untouched
  │      false  -> the count is NOT handed to iterateFeed, so the client cannot
  │                 flip the walk to 'expected_total' itself
  │
  ├──> fetchProjectFeed()      -> GET /api/project/feed?scope=library&entity_type=clip
  │      ONCE per sync (not per hydrating batch)     background/background.js:6594-6630
  │      └──> clip -> [projectIds] join, cached for the run
  │
  ▼
for EACH project in the plan, in the server's order:
crawlWorkspace()                      background/background.js:6017-6146
  │  never throws — one failing workspace must not abort the other 19
  │  expectedTotal = THIS project's clip_count, never the account-wide sum
  │  oracleFatal   = the run's scope AND this project has a finite count
  │                    background/background.js:6020-6035, applied at :6074
  ▼
iterateFeed()                        lib/api.js:2263-2522
  │
  │   POST /api/feed/v3     body { cursor, limit, filters }   NO QUERY STRING
  │   cursor: null on the FIRST request, then each response's next_cursor
  │   limit : 100, the confirmed server maximum      lib/api.js:149-153
  │   filters: the bundle's own vocabulary           lib/api.js:2295-2308
  │            BooleanFilter values are STRINGS: "True" | "False" | "Any"
  │
  ├──> [per page]  batch { clips[], page, pass, cursor, limit, totalSeen, … }
  ├──> [summary]   batch { type:'summary', completed, truncated, stopReason,
  │                         error, pagesDone, totalSeen, expectedTotal, missing,
  │                         nextCursor, serverTotal, … }
  │
  ▼  per page:  afterPage()         background/background.js:6781-6821
  │   countsForOracle === false for phase 2 -> its rows move NEITHER tally
  ├──> commitPage()               background/background.js:6680-6700
  │      stamps is_disliked from the walk's own filter (the SERVER filtered)
  │      forced rebuild? buffer, cap 25,000 -> overflow to additive
  │      incremental?    hydrate -> clips.putMany(chunk of 500)   ONE tx per chunk
  ├──> disliked-id flush        every 5 pages ('both' mode only)
  │      DISLIKED_FLUSH_EVERY_PAGES, background/background.js:299, applied at :6891-6894
  ├──> DB.syncState.set('feed', cursor)          <-- RESUMABLE, at :6793
  └──> broadcast SYNC_PROGRESS
  │
  ▼  after EVERY workspace:  persist()   background/background.js:6828-6839
  │
  ▼  mode === 'both' only: a SECOND walk per project with disliked:'True'
  │      background/background.js:7002-7017 — oracle OFF, countsForOracle:false,
  │      ids to meta.feed.dislikedIds and to NOTHING else
  ▼
the verdict, computed BEFORE the rebuild is committed
   background/background.js:7055-7126
   │   oracleBlocksCompletion = oracleApplied && !totalsMet    :7080-7081
  ▼
forced rebuild, complete, not overflowed?
  └──> clips.bulkReplace(all)      ONE atomic tx; abort leaves the old library intact
      otherwise -> additive writes only, and mark the result incomplete
  │
  ▼
cursor.state = 'idle' | 'incomplete' | 'cancelled' | 'error'   :7163-7167
cursor.missing = max(0, expectedTotal - examined)                :7174
broadcast SYNC_DONE / SYNC_ERROR with the whole contract
   background/background.js:7204-7218 / :7303-7310
```

#### 🧭 The cursor contract

**`POST /api/feed/v3`. Body only. No query string.** A GET-shaped `?page=N` is the
`/api/feed/v2` bug wearing a new route name — the two are the same mistake.

| | |
|---|---|
| **method + path** | `POST /api/feed/v3` (`lib/api.js:1100`) |
| **first request** | `cursor: null` in the body |
| **every later request** | that response's `next_cursor` verbatim. `''`, `0` and `{}` are treated as the same empty value (`lib/api.js:474-509`) |
| **`limit`** | `settings.feedPageLimit` (**100** by default — the confirmed server maximum, larger rejected; **20** is the site's own page size and the minimum sensible value), **clamped to 1–100** (`lib/api.js:149-153`, `:2267-2270`). A page size the server caps lower cannot truncate the walk — the cursor chain, not the page size, decides where it ends |
| **`filters`** | `trashed`, `disliked`, `fromStudioProject:{presence}`, `stem:{presence}`, `stemComplement`, `sort:{sortBy, sortDirection}`, `workspace:{presence, workspaceId}` (`lib/api.js:2300-2308`) |
| **tri-states** | `BooleanFilter` values are the **strings** `"True"` / `"False"` / `"Any"`, **never booleans** (`lib/api.js:167-179`, `:444-459`) |
| **response** | `{clips:[…], next_cursor}`; the client also accepts `nextCursor` (`lib/api.js:495-509`). **The terminal signal is either spelling**: `next_cursor` present and null, or the field absent entirely — the same stop the shipped client makes (`nextCursor: l.data?.next_cursor || null` → `getNextPageParam`), published by this client as `cursorOmitted` with the envelope evidence retained |
| **`startPage`** | **ignored, with a warning.** Cursor pagination makes "resume at page N" inexpressible (`lib/api.js:2280-2286`) |

The whole filter object is the bundle's own
`getWorkspaceDefaultClipBrowserFilters`, pruned to the keys left at their default,
because the shipped web client prunes keys equal to `'Any'` and a full twenty-key
filter object is not something the server has ever been shown accepting.

> ⚠️ **`filters.user`'s id field spelling is an UNRESOLVED conflict.** The bundle
> sends **camelCase `userId`** (`suno-recon/out/chunks/1r1sqgyc3uj2o.js:5`); the
> working third-party extension sends **snake_case `user_id`**
> (`scratchpad/extracted/BetterSuno/background.js:2486`). **This extension sends no
> `user` filter at all**, so the conflict cannot bite here — but it is recorded
> rather than smoothed over, because anyone adding a "one user's public clips"
> filter is about to pick one. See [RECON-NOTES](RECON-NOTES.md).

#### 🧱 Per-workspace, and why

The library is not one list. A clip lives in the project it was generated into, and
the other projects are never returned by a `workspace:'default'` walk. On the recon
account `default` held **3,444** clips and the whole account was **~5,500** across
**55** projects (`/api/project/me`: 20 on page 1, `num_total_results: 55`).

So the crawl enumerates the projects and walks **each one exactly as the web app
would** (`scope:'workspace'`, `workspaceId: <project>`,
`background/background.js:6057-6066`, with the reasoning at `:6057-6062`).
`scope:'all'` *is* a documented way to read
the whole library in one walk, but it cannot be compared against a per-project
oracle, and it is not what the app does when a project is open.

`default` is **forced into the plan** even if the list arrives without it, so a
partial page can never cost the unassigned clips — and it is appended with
`clipCount: null` when the list carried no count, which is what earns it
`oracleApplied:false` and no oracle at all
(`background/background.js:5946-5948`, rationale at `:5923-5936`).

#### 📏 The oracle — and the condition under which it is allowed to fail a sync

`expectedClipTotal` sums every project's reported `clip_count`
(`lib/api.js:2556-2586`), and each walk is compared against **its own project's**
count (`crawlWorkspace`, `background/background.js:6017-6146`). That is what makes
the failure visible as a number rather than as a feeling.

**The comparison is against `examined`, not `totalSeen`.** The oracle is the
**SUM** of per-project `clip_count`, which counts a clip living in two projects
**twice**, while the store holds it **once**. So the run keeps three tallies under
three names (`background/background.js:6386-6401`): `examined` (rows walked,
repeats included — the oracle's operand), and `totalSeen` / `uniqueSeen` (the same
number twice, the unique clip count — what the user is waiting for and what
`missing` must never be derived from).

> #### 🚨 The oracle compared a FILTERED walk to an UNFILTERED count, and that was worse than the shared-clip bug.
>
> `clip_count` is a **project row count**. The walk is a **filtered request**. On
> the default settings the crawl always sends `filters.trashed:'False'`
> (`includeTrashed` is hard `false`, `background/background.js:6344`) and, in the
> default mode, `filters.disliked:'False'`. Nothing in the wire contract says
> `clip_count` omits trashed or disliked rows — it is a count from the same store
> the feed filters — so **every default-mode sync would have fallen short by
> exactly trashed + disliked, permanently**, and told the user to raise a page cap
> that was never reached.
>
> **Nobody could settle it by reading the code**, so the comparison was made
> **honest instead of fatal**. `oracleApplied` is decided **once, up front** and is
> one readable expression (`background/background.js:6536-6555`):
>
> ```js
> oracleApplied = includeTrashed === true && libraryWireFilter === 'Any';
> ```
>
> `'Any'` is the string the **server** receives, not the mode key the worker uses
> internally, so the test is made on the wire value
> (`dislikedWireValue`, `background/background.js:6179`, rationale at
> `:6163-6178`) — because *"unfiltered"* is a property of the request, not of the
> setting's name. Per workspace the same rule is `oracleFatal` at
> `background/background.js:6020-6035`, and it is applied where the count is handed
> to the client at `:6074`.
>
> When it is false:
>
> - `completed` stands on the **walk's own evidence** — an exhausted cursor, no
>   failed page — and a shortfall does **not** make the crawl incomplete
>   (`oracleBlocksCompletion`, `background/background.js:7080-7086`);
> - the count is **not handed to `iterateFeed` at all**, because a filtered walk's
>   shortfall is not evidence of a missing clip — it may be evidence of a filter —
>   and handing it over would let the *client* flip the walk to
>   `completed:false / 'expected_total'` on its own;
> - `missing` is still **reported**, because the arithmetic is still the best
>   estimate available, and `oracleApplied:false` plus `advisory` is what tells a
>   reader it is a **lower bound** rather than a checked shortfall.
>
> A workspace whose `clipCount` is `null` — `default` forced into a plan whose
> project list arrived without a count (`background/background.js:5946-5948`) —
> gets `oracleApplied:false` and **no oracle at all**. It used to report
> `completed:true` with no check whatsoever.

> #### 🎯 The single observation that would re-arm it. Write this down.
>
> **An authenticated capture, on an account holding at least one trashed clip and
> at least one disliked clip, showing that a project's `clip_count` is NOT greater
> than the number of rows an UNFILTERED `POST /api/feed/v3` walk returns for that
> same project** — i.e. that the count is the count of what the unfiltered feed
> returns.
>
> Then `includeTrashed:true` + `disliked:'Any'` makes the walk and the count
> measure the same set, `oracleApplied` becomes `true` for exactly that
> configuration, and a shortfall becomes **proof** again. Until that capture
> exists, the default configuration cannot fail a sync on a number nobody can vouch
> for. The full statement is in the source at
> `background/background.js:6520-6529`.

⚠️ **This is a real, deliberate loss of a guarantee, and it is stated as one.** With
`oracleApplied:false` the sync can no longer **prove** a shortfall — the advisory
is the only signal, and it is a statement about *which number is trustworthy*,
not a measurement. Before the scoping change the default sync failed loudly on
every single run; after it, it fails loudly only in the one configuration that can
be justified. Recorded as [KNOWN-LIMITS §26](KNOWN-LIMITS.md).

Two further honest caveats, both conservative:

- **`fetchProjects()` reads page 1 only** (`lib/api.js:2524-2532`), so the summed
  figure is a **lower bound** *of the projects the plan saw*. The crawl itself no
  longer depends on it — `fetchAllProjects` pages the route to the advertised count
  and reports `complete:false` when it cannot prove it reached the end
  (`background/background.js:5807-5921`), and **that** oracle
  (`projectList.complete`) is unaffected by the walk's filters and stays fatal.
- **v3's own `num_total_results` is recorded, never enforced**
  (`lib/api.js:2385-2392`). On the route this replaced it reported **21** for a
  library of 3,444; adopting it would make every sync that filters rows
  permanently report itself incomplete.

If the feed says "done" and the oracle disagrees **where the oracle is valid**, the
feed is wrong, and the summary says so (`lib/api.js:2469-2481`,
`stopReason: 'expected_total'`). Note that row 6 of the state machine below only
fires when the worker actually handed `iterateFeed` a count — i.e. only when
`oracleApplied` was `true`.

#### ✅ The state machine — completion is the feed's own terminal signal

A walk is `completed` **only** when the envelope is ok and the feed says "no
more" — which it says two ways, both verified against the shipped web client's
own bundle (`out/chunks/1r1sqgyc3uj2o.js`): a `next_cursor` that is **present
and null**, or a cursor field that is **absent entirely** (the site's
`getNextPageParam` receives null for `l.data?.next_cursor || null` either way,
and every walk on a live account ends on the omission spelling — mid-walk pages
carry the cursor, only the final partial page omits it). An omission-completion
is published as `cursorOmitted:true` with the envelope's key list retained on
the summary, so a short one stays diagnosable and the automatic probe can
re-request the exact page.

The terminal check runs **first** (`lib/api.js`), because a null cursor is the
*terminal* value, not a repeated one — the walk's own first request also
carries a null cursor, so a repeat check that ran earlier would flag every
finished walk as stuck.

Everything else, in strict order:

| # | condition | `stopReason` | `completed` |
|---|---|---|:--:|
| — | ok page, `next_cursor` present and null, ≥1 page | `complete` | ✅ |
| — | ok page, **no cursor field at all** (end-of-feed by omission, `cursorOmitted:true`) | `complete` | ✅ |
| 1 | `!envelope.ok` after the page's 5 retries — 429/5xx/401 included. A **first-page** failure is **thrown**, because nothing was indexed | `page_failed` | ❌ |
| 1a | the caller aborted (checked **before** `page_failed`, so a cancel is never a fault) | `aborted` | ❌ |
| 2 | 0 clips arrived while a cursor is still offered — **the feed is unreadable from here, not finished** | `empty_page` | ❌ |
| 3 | a `next_cursor` the walk already followed — checked **before** the no-new-ids rule, because a stuck cursor usually also repeats rows | `stuck_cursor` | ❌ |
| 4 | a page that added **0 new clip ids** while the cursor advanced | `no_new_ids` | ❌ |
| 5 | `maxPages` reached with a cursor outstanding | `max_pages` | ❌ |
| 6 | the feed said "no more" **but** `totalSeen < expectedTotal` — **only when the worker handed the client a count**, i.e. `oracleApplied === true` | `expected_total` | ❌ |

`truncated` is defined as **`!completed`**, so the pre-existing
`summary.truncated` read in `background.js` keeps meaning *"do not tell the user we
synced everything"* for every incomplete case, not only for the `max_pages` one. And the
invariant *"`completed` may never be true next to a truncation or an error"* is
**asserted at the end**, not assumed.

> **This is the rule the previous build broke in the crudest way possible:** two
> empty pages, a short page, or a counter running out were all read as "end of
> library". None of them is evidence of the end of the library. The omission
> reading is not that bug back: it is the server's OWN signal (the same one the
> shipped client stops on), taken as-is from an `ok` page and published with its
> evidence — never inferred from page fill, and never reachable from a page that
> failed, repeated its cursor, or ran out of page budget.

#### 🧾 §13c — the run record, and what an evicted worker leaves behind

The cursor row answers *"how far did the walk get"*. It does **not** answer *"is a
crawl in flight right now"*, and conflating the two is what produced the two bugs
described in [§ workers get evicted](#-3-workers-get-evicted-at-30-s-idle). §13c
is the second store that does answer it.

| | `DB.syncState` (`feed`) | `chrome.storage.session` (`suno.syncRun.session`) |
|---|---|---|
| question | how far the walk got; does it satisfy the oracle | **is a crawl in flight right now** |
| writer | `afterPage` / `persist` / the verdict | `writeSyncRun`, one place |
| lifetime | disk-resident; **outlives a browser restart** | survives worker **eviction**; **cleared on browser close** |
| read by | every surface, as the verdict | `syncEvictionVerdict`, as evidence of liveness |

Six scalars, no clip content, no cursor, no oracle numbers, no token material:
`{running, startedAt, cancelRequested, cancelRequestedAt, phase, heartbeatAt,
epoch}`. `epoch` is `SYNC_RUN_EPOCH`
(`background/background.js:8314`), regenerated on every wake and stamped on every
write and never taken from the caller — so a record can only ever claim the worker
that wrote it, and **a record carrying a different epoch was written by a worker
that no longer exists, which is an eviction by definition.** That is the one piece
of sync state that is still module-scope, and it is deliberately the useless half:
a process identity, not a run.

Three write sites, and the order of the first one is load-bearing:

- `startSync` writes the record **before the crawl is announced**
  (`background/background.js:5718-5731`). `syncController` is created on the line
  above and dies with the worker, so if the record is not on disk before the first
  `await` inside `runSync`, there is a window in which a wake sees a cursor
  claiming a run that no record corroborates and no controller owns — exactly the
  disagreement this record exists to prevent.
- the per-page heartbeat, **throttled** to `SYNC_RUN_HEARTBEAT_FLOOR_MS` (5 s,
  `:7240-7243`), and the phase reporter's own heartbeat (`:8094`).
- `cancelSync` writes the same intent to the **cursor first** and the record second
  (`:8239-8252`), so a failure in the record degrades to the cursor-only path rather
  than to a run claiming a stop the crawl never saw.

`clearSyncRun` runs on **every terminal path** — normal verdict, thrown crawl,
orphan-clearing press, no-op press, and the reconciliation itself — so its absence
is the normal steady state and never means something went wrong.

#### The eviction signature, and the reconciliation

Stated once, because the rule is what makes the reconciliation safe:

> persisted "a crawl is in flight" **AND** no `syncController` in **this** worker

Only `startSync` ever writes the first half, and it also creates the controller.
The second half is true on every worker except the one that started the run, and
only one worker exists at a time — **so a mismatch cannot be a race between two of
them.** `syncEvictionVerdict` (`background/background.js:8442-8501`) computes it,
plus an `epochMismatch` flag and the `ageSource` (`controller` / `run-record` /
`cursor-row` / `none`) so the log says which half of the evidence it had.

Two floors, and the difference between them is deliberate:

- **`cursorOnly`** — no record claimed a crawl, so the row is the sole evidence: a
  browser restart (session storage went with it), an install from a build that
  predates the record, or a failed record write. It gets the **same 90-second
  grace** (`SYNC_STALE_MS`) the read paths already give it, because with no record
  there is nothing to compare an epoch against and being late is better than
  reconciling a crawl that started seconds ago (`:8482-8491`).
- **record present** — a 5-second floor (`SYNC_RUN_HEARTBEAT_FLOOR_MS`) is enough,
  and generous for the same reason the 90 s one is: a page can be held for a long
  rate-limit backoff, and calling a live crawl dead is the same over-confident
  report as the bug being fixed.

`reconcileSyncRunOnWake` (`:8541-8660`) then does three things, and **only ever
says "incomplete"** — an eviction is not evidence of completeness, and the
completeness contract is explicit that a wrong answer in the cautious direction is
still a wrong answer:

1. **re-reads the row before writing** (`:8549`). `reconcileStaleCursor` merges, so
   a row that changed underneath it would come back carrying a live crawl's
   progress with `state:'interrupted'` written over the top. Cheap next to getting
   it wrong, and it is the only thing standing between this and a crawl declared
   dead while it is still running.
2. **heals the row** through the existing `reconcileStaleCursor` wording, so the
   sentence the user reads is the same one `GET_BOOT` / `SYNC_STATUS` will show
   afterwards — plus the one addition there was no wording for before: a stop that
   was asked for and then **lost with the worker** is neither "you cancelled" nor
   "the crawl broke", and reporting it as the latter sends the user off to debug a
   fault they did not cause (`:8581-8584`). It **clears `cancelRequested`** here,
   which is the second half of the stuck-"Stopping" bug.
3. **broadcasts `SYNC_CANCELLED`** (`:8648-8658`). **The push is the point.** Every
   terminal push in §13 is emitted from memory, so a surface that only *listens*
   never learns the run ended — the popup kept an indeterminate "Stopping" slider
   and the dock a live bar, because the last thing either was told was
   `SYNC_CANCEL_REQUESTED`. `SYNC_CANCELLED` is the one push all three surfaces
   already treat as terminal-with-no-verdict, and **carrying no verdict is a
   feature here**: a push cannot be a second source of truth about completeness,
   and the row each surface then re-reads is the one true one.

Then it clears the record, which makes the whole thing **idempotent in the strong
sense**: after it runs there is no record and the row is no longer `running`, so
every later wake sees nothing to reconcile. No tombstone, no marker, no risk of a
duplicate terminal push.

`reconcileSyncRunOnBootstrap` (`:8698-8736`) is the wake-time entry point, called
from `bootstrap` **after** the batch resume and the download reconciliation —
both reconcile "the previous worker left something running", and ordering it after
them means it runs late rather than never, and never races `runBatch` for the
database. It reads the run record and the cursor **concurrently** and judges them
from the same snapshot, because this is the one place that must not re-read and
re-race. It **never throws**: a failed reconciliation has to degrade to "the next
read reconciles it".

#### 💾 Resume — and what it costs

`syncState.feed` is written after **every page**
(`background/background.js:7249`), so an evicted worker resumes instead of
restarting. Resume is honoured only when the
**whole plan agrees**: schema marker, `state === 'running'`, mode, page cap, the
project list itself, and a finite `stored.examined`.

Granularity is the honest part: **`iterateFeed` accepts no `startCursor`.** It
accepts and explicitly ignores `startPage`, so **the workspace that was in flight
restarts from `cursor: null`** and completed workspaces are skipped entirely. Safe
(writes are additive and idempotent by clip id) but not free. The per-project
cursors *are* recorded (`background/background.js:6911-6912`) so a future client
that accepts a `startCursor` can use them without another schema change.

A resumed run **skips** the workspaces an evicted worker finished, so its
accumulators start where that worker stopped
(`background/background.js:6702-6727`) — otherwise `examined` would restart at `0`
while the oracle still counts the whole library, and the resumed run would refuse
to call itself complete *precisely because it resumed*. The carry reads
`stored.examined` and `stored.uniqueSeen` **by their own names**; `stored.totalSeen`
is deliberately **not** a fallback, because on a schema-2 row it means rows-examined
and on a schema-3 row it means unique clips.

##### 🧬 The cursor schema is **3**, and the bump was for the `totalSeen` split

Schema 2 stored **one** number under `totalSeen` (rows examined, repeats across
projects included) and a different one under `uniqueSeen`. Schema 3 stores the
**unique** count under `totalSeen` — so the stored row means what every reply
means — and the examined count under `examined`, which is what the oracle is
compared against.

**A schema-2 row therefore carries a `totalSeen` whose meaning is the *opposite*
of a schema-3 row's**, and reading it as the unique count would resume with a total
larger than the library (*"4,600 of ~4,500"*). This is exactly what the schema
marker exists for, so it is used rather than silently reinterpreting an old field:
`SYNC_CURSOR_SCHEMA = 3` (`background/background.js:314-325`). A row left by the
`/api/feed/v2` era carries `nextPage`/`pass`, which mean nothing to a cursor walk;
they are **stripped from every emitted reply** (`cursorForWire`,
`background/background.js:6212-6230`) **and explicitly nulled** on a fresh cursor
(`:6362-6369`) because `DB.syncState.set` **merges** its patch into the stored row,
so omitting a key leaves the legacy value in place. They are also normalised *by
name* on the way in (`normaliseResumedCursor`, `:6205-6210`) because the schema
check is one number and a future edit, a hand-patched row or a partial write can
invalidate it.

#### 🧯 What this crawl will not do

- **`clips.clear()` is never called** (invariant C, `background/background.js:40-41`).
  A forced rebuild uses `bulkReplace` — one atomic transaction — and only when the
  crawl **completed**, because replacing a library with a truncated one would delete
  the clips the crawl never reached (`background/background.js:7128-7144`). An abort
  leaves the previous library intact.
- **A page that already arrived is never discarded on cancel.** The request was
  paid for and its rows are real; it is written, then the walk stops
  (`background/background.js:6091-6112`).
- **One failing workspace does not abort the rest.** It is reported by name, with
  its own `stopReason`, in a `workspaces[]` row — the difference between *"4,400
  clips and one broken project"* and *nothing*.
- **`dislikedMode:'both'` is two ordinary walks, not a diff.** One `'False'` walk
  for the library, one `'True'` walk for the id set. The symmetric difference is
  gone because the server does the filtering now, and the shared-`maxPages` bug it
  used to cause is gone with it. **Phase 1 alone defines completeness**: phase 2
  runs with `countsForOracle:false` and contributes to **neither** `examined` nor
  `uniqueSeen` (`background/background.js:6737-6755`, applied at `:7016`), because
  its rows are a *different* row set of the same library and feeding them in made
  the reported *"X of ~Y"* describe nothing.

> **`dislikedApproximate` still means something, but not what it used to.** It is
> now set when a `'True'` walk did not finish for **every** project
> (`background/background.js:7020-7029`) — a partial id set is reported as
> approximate, never as a count.

### Filter / query

```
UI                        content/content.js buildSpec()
  │  tri-state selects, numeric ranges, date pickers, id list,
  │  the parseQuery grammar, and the stems text-term hack
  ▼  plain SunoFilter spec
GET_CLIPS {spec, sort, order, offset, limit}
  │
  ▼
queryClips()                          background/background.js:6876-6904
  ├──> queryContext()   { projects, dislikedIds }   :6856-6867
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

Project membership is **not** in that `ctx`: it is stamped onto each clip row as
`projectIds` by `SunoAPIClient.hydrate` (`lib/api.js:2884-2916`) and indexed as
`_i.project_ids` by `lib/db.js:542-584`, `:294`. `ctx.projectIdsById` is a
*supported alternative* the engine also reads (`lib/suno.js:197-207`), and this
worker does not supply it.

### Download

```
UI                        DOWNLOAD_START {spec | ids | useSelection, variant, …}
  │
  ▼
startBatch()                            background/background.js:4992
  │  normalizeLadder()      -- may legitimately yield []
  │  FAIL LOUDLY on []      -> {ok:false, code:'ladder_empty'}
  ▼
resolveBatchClips()                     background/background.js:4869-4889
  │  explicit ids  WIN  -- the old build ignored the selection entirely
  ▼
dedupe by clip id  <-- BEFORE ANYTHING IS SPENT   background/background.js:5017-5025
  │  (one song = one download, so duplicates are free to drop)
  ▼
skip items already isDone(id, variant) unless overwrite   :5030-5051
  ▼
quotaPreflight(items.length)            background/background.js:4956-4991
  │  shortfall? -> message naming N needed, M remaining, reset date
  ▼
plan { status:'planned', items[], cursor:0, stats }  -> persistPlan()  :4826-4839
  │
  ├── dryRun?  -> plan.status = 'done', return, spend nothing
  ▼
runBatch()  [detached, own AbortController]             background/background.js:5144
  │  worker pool of `concurrency` (default 3, max 8)
  │  MID-BATCH QUOTA GUARD armed here                    background/background.js:5188-5191, :5223
  │
  ▼  per item:
  ├──> markInProgress(clipId, variant)
  ├──> for attempt in 1..(1 + retryAttempts):
  │      ├──> runLadder(clip, ctx)                   background/background.js:4287
  │      │      for rungId of sourceLadder:
  │      │        runLadderRung()  ->  bytes OR a signed URL
  │      │        failure? record the attempt, next rung
  │      │        all rungs failed? -> {code:'ladder_exhausted', attempts[]}
  │      ├──> maybeTranscode()      offscreen; WAV render OR mp3/ogg ENCODE
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

1. `onDownloadChanged` — `background/background.js:3904-3961`,
   `proof:'downloads.onChanged:complete'` (`:3926`)
2. `reconcileDownloadsOnStartup` — `background/background.js:3962-4029`

`chrome.downloads.download()` returning an id means **Chrome accepted the request**,
nothing more. Marking done on that signal is how you write a history row for a
file that never landed.

The same listener has a second fix baked in (`background/background.js:3896`):
**`download.error` is a STRING on the delta item.** The old build tested a
non-existent `errorDetails` field *inside* `state === 'complete'`, so the branch was
permanently dead **and its polarity backwards** — failures were only ever supposed
to be detected from inside the success case.

If a settle times out, the row is left `in_progress` on purpose
(`background/background.js:5358-5364`): *"transfer still in flight; will be
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

- **`tagOptions.bpm: false` really does suppress the tempo tag.** The BPM
  measurement is reached only when the clip carries no usable tempo of its own
  **and** `tagOptions.bpm` is on (`background/background.js:3344-3356`), and that
  matters because `lib/tagger.js` resolves
  `req.bpm !== undefined && req.bpm !== null ? req.bpm : meta.bpm`
  (`lib/tagger.js:1968`). An ungated `meta.bpm` therefore re-introduced the
  `TBPM` frame whenever the tempo toggle was off but the clip happened to carry a
  tempo — the tagger's fallback quietly undoing the user's choice. It no longer
  can.
- **`track:false` sidecars are deliberately not in `SunoDB.downloads`**
  (`background/background.js:4758-4761`): that store is the record of
  which `(clip, variant)` pairs are finished, and a `.lrc` file is not a variant.
  Registering one would double every count and make `isDone(id, 'm4a')` ambiguous.
- **The recorded variant must match the DELIVERED file**, and the filename follows
  the bytes actually written (a transcode changes the variant; if the row said
  `m4a` and the file is `.wav`, a later `isDone(id, 'm4a')` check re-downloads the
  same song).

---

## 💾 The IndexedDB schema

Database `suno-library`, **version 3** (`lib/db.js:732`). Five stores, defined once
at `lib/db.js:270-284` and created **idempotently** (`lib/db.js:343-345`).
`lib/db.js` is the only thing in the extension allowed to open it
(`lib/db.js:266-268`).

| store | keyPath | indexes |
|---|---|---|
| `clips` | `id` | `created_at`, `is_liked`, `major_model_version`, `status`, `is_trashed`, `is_public`, **`project_ids` (multiEntry)**, `title_lower`, `play_count`, `upvote_count` — all on the derived `_i.*` block, declared at `lib/db.js:287-298` |
| `downloads` | **`['clipId','variant']`** (`lib/db.js:326`) | `state`, `clipId`, `startedAt`, `finishedAt` |
| `syncState` | `key` | `updatedAt` |
| `journal` | `id` (**autoIncrement**) | `batchId_ts` (**compound** `['batchId','ts']`), `ts` |
| `meta` | `key` | *(none)* |

Database `suno-library`, **version 3** (`lib/db.js:732`). Five stores, defined once
at `lib/db.js:270-284` and created **idempotently** (`lib/db.js:343-345`).
`lib/db.js` is the only thing in the extension allowed to open it
(`lib/db.js:266-268`).

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
`dislike-set`, `truncated-fallback`, `incomplete`, …). It is what makes "what
happened at 3am" answerable, and it is trimmed per batch at the end
(`background/background.js:5540`).

`quota-stop` is a **separate** phase from `done`
(`background/background.js:5504-5520`), precisely so a deliberate quota halt is
distinguishable from a batch that ran out of plan.

### `meta` keys

`META_KEYS` at `background/background.js:238-250`:

| key | value | holds |
|---|---|---|
| `ACTIVE_BATCH` | `batch.active` | the in-flight batch id |
| `BATCH_PREFIX` | `batch.plan.` | one persisted plan per batch |
| `PROJECTS` | `projects.cached` | the workspace plan, `{at, projects:[{id,name,clipCount}]}` |
| `SELECTION` | `selection.durable` | the durable selection |
| `FEED_DISLIKED_IDS` | `feed.dislikedIds` | the disliked id set from the `filters.disliked:'True'` walk |
| `LAST_BATCH_SUMMARY` | `batch.lastSummary` | the last `DL_DONE` summary |

> **The two symmetric-difference keys are gone.** `feed.baseIds` and `feed.seenIds`
> existed only to work around the missing per-clip dislike field. `/api/feed/v3`
> filters disliked **server-side**, so `dislikedMode:'both'` is two ordinary walks
> whose results need no differencing, and only the id set is still worth flushing.
> The reason is recorded in place at `background/background.js:290-298` and
> `:242-247`.

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
| `suno.syncRun.session` | **§13c's run record** — six scalars saying whether a crawl is in flight and when it started. Survives worker eviction, cleared on browser close. Not clip content, not a cursor, no token material. See §13c above |

`STORAGE_KEYS` is at `background/background.js:269-287`; the run-record comment
that explains why this key exists is at `:277-286` and the record's own shape is in
`coerceSyncRun`'s `@returns` at `:8324-8326`.

> **Invariant G** (`background/background.js:50-51`): *No token or key material is
> ever logged, or written outside `chrome.storage.session`.* `SENSITIVE_KEY_RE`
> (`background/background.js:814`) drops anything matching
> `token|jwt|authorization|bearer|password|secret|cookie|session_key|private_key|content_key|user_key|glt|iv`
> from the log at any level, and `EXPORT_SETTINGS` never emits the token, key
> material, or the diagnostics ring buffer
> (`background/background.js:7621`).

---

## 🔢 Settings reference

`DEFAULT_SETTINGS` at `background/background.js:681-791`, with the per-key
documentation in the `Settings` typedef at `:1066-1124`. Every key is validated on
read (`coerceSettings`, `background/background.js:1138-1205`) because a corrupt blob
must not be able to produce a NaN rate or an unsanitised path template.

| group | keys |
|---|---|
| what to fetch | `variant`, `downloadSource` (+ `sourceLadder` legacy alias), `allowMeteredExtras` |
| pacing | `rateLimit` (4), `rateLimitJitter` (true), `concurrency` (3), `retryAttempts` (2) |
| naming | `filenameTemplate`, `folderDepth` (2), `maxFolderDepth` (4), `overwrite`, `dataUrlMaxBytes` (24 MB) |
| tags | `tagOptions.{embed,lyrics,artwork,bpm,comment,json,lrc}` — **exactly seven**, `artistPolicy`, `neutralArtist`, `albumName` |
| conversion | `transcode` (**`none` \| `wav` \| `mp3` \| `ogg`**), `wavSampleRate` (48000), **`mp3Bitrate`** (192), **`oggQuality`** (0.5) |
| crawl | `syncMaxPages` (200), `dislikedMode` (`exclude`), `autoSync`, `syncIntervalMinutes` |
| safety | `dryRun`, `allowHlsCapture`, `debug`, **`quotaReserve`**, **`quotaCheckEvery`** |

`syncMaxPages` is the **per-workspace** page cap (200 by default,
`background/background.js:772`, clamped to 1–2000 at `:1167`), so a 5,500-clip
account spread over 55 workspaces can afford a *far* lower cap than it could when
one cap was being shared across two dislike passes.

### The six settings that changed in 6.0.1

**`quotaReserve` — `background/background.js:766-776`, clamped at `:1186`.** The
floor the mid-batch guard stops **at**: `remaining <= quotaReserve` ends the batch
cleanly. Valid `[0, 10000]`, default `0`, meaning "stop the moment the meter is
empty". Wired to a real control at `options/options.html:150-153`.

**`quotaCheckEvery` — `background/background.js:777-783`, clamped at `:1187`.** Re-read
the meter at most once per N **successful metered** downloads; unmetered rungs never
count, so a purely unmetered batch polls zero times. Valid `[1, 100]`, default `5`.
A value of 0 would poll on every item — a quota-hammering loop — and is clamped up
to 1. Wired at `options/options.html:164-167`.

**`variant` is alias-tolerant, not membership-tested** (`resolveVariant`,
`background/background.js:609-629`, applied at `:1159`). The old
`VARIANTS.indexOf(...) >= 0` test reverted a stored `mp3-320` to the default with
no trace at all. Now it substitutes via `VARIANT_ALIASES` (`:581`), logs both values
at debug level, and only falls back for a value it has never heard of.

**`transcode` was narrowed to `none|wav` in 6.0.1 and is now widened back.**
Applied at `background/background.js:1175`. The 6.0.1 clamp was correct *at the time* —
`mp3` and `ogg` were admitted by a build that shipped no encoder, so an imported
settings blob could put the worker into a permanently-failing state while
`options.js` rendered the radios as "None", leaving no way to see or undo it. The
6.1.0 clamp is `TRANSCODE_FORMATS = ['none','wav','mp3','ogg']`
(`:630`), reduced by `resolveTranscode` (`:648`).

### The two settings that changed in 6.1.0

Both exist only because both encoders ship. Neither accepts a range, which is the
whole reason they are named lists rather than `[min,max]` clamps — see
`snapToChoice` (`background/background.js:1301-1336`) for the full reasoning.

**`mp3Bitrate` — default `192` kbps (`:684-689`).** Valid values are
`MP3_BITRATES = [128, 160, 192, 224, 256, 320]` (`:665`) — the six bitrates
`lamejs.Mp3Encoder(channels, rate, bitrate)` accepts at full quality. Anything else
makes LAME fall back to its own internal choice, so a value let through as-is would
be discarded with no trace and the file would come out at a bitrate the user never
asked for.

**`oggQuality` — default `0.5` (`:691-697`).** Valid values are
`OGG_QUALITIES`, the tenths from `0.0` to `1.0` (`:676`) — the encoder's
*named-quality* index, 0 = smallest/fastest, 1 = largest/slowest, matching the
library's own granularity. A missing value becomes **0.5, not the offscreen page's
own 0.8 default**, so what the settings say and what the encoder does cannot
disagree.

Both are **snapped, never rejected**: the nearest entry wins, and **ties snap to
the lower option** (`200 → 192`, not `224`), so the result is a deterministic
function of the input rather than of iteration luck. Nearest-choice snapping also
subsumes clamping, so 10000 snaps up to the largest option and a negative snaps down
to the smallest with no separate range check. `null`, `''` and booleans count as
**missing** rather than as 0/1, because `Number(null) === 0` would otherwise quietly
mean "the lowest quality" for a key that was simply never set. They are snapped a
**second** time at the point of use (`background/background.js:3495-3496`) so a
caller handing over a hand-built `settings` object cannot push a NaN into an encoder.

Both have real `<select>` controls (`options/options.html:502-529`), gated on the
matching transcode format by `gateOnTranscode`, which touches only `.disabled` and
`aria-disabled` and **never `.value`** (`options/options.js:653-678`) — that is what
preserves a choice made under one format across a switch to another. The option
lists are `MP3_BITRATE_CHOICES` / `OGG_QUALITY_CHOICES`
(`options/options.js:152-173`), duplicated rather than imported because a content
script and an extension page have no shared module graph; a local `snapChoice`
mirror exists purely to paint the right option when the worker hands over a value
the selects do not carry (`options/options.js:224-247`).

**The seven `tagOptions` keys** are rebuilt from the incoming object alone on every
read (`background/background.js:1193-1203`), which is why every UI sends the whole
object back rather than a one-key patch — a partial `tagOptions` would reset the
other six to the worker defaults (`content/content.js:1181-1187`, `:2553-2554`).

### Filename templates

Tokens (`buildTemplateVars`, `background/background.js:3614-3666`):

```
{workspace} {title} {model} {artist} {year} {month} {day}
{versionIndex} {clipIdShort} {id} {bpm} {format} {ext}
```

Default: `{title}_{clipIdShort}.{ext}`.

- `{artist}` resolves the **artist policy**, not the clip's `display_name` —
  those fields are the *owner's account identity*, never a third-party artist
  credit (`background/background.js:3638`).
- An unknown `{token}` becomes `_`, so no literal braces reach the filesystem
  (`background/background.js:3675-3676`).
- Folder segments are honoured up to `maxFolderDepth`, hard-capped at 4
  (`background/background.js:3682-3683`).
- **The extension is ALWAYS appended** when the rendered name lacks one
  (`background/background.js:3702`, using `extensionFor` at `:3608`).
  The previous build never appended one.
- A title that sanitises to nothing falls back to the short clip id
  (`background/background.js:3692-3699`).
- Sanitisation is **hostile by design** (`sanitizeSegment`,
  `background/background.js:3576-3597`, with `WINDOWS_RESERVED_RE` at `:3563` and
  `MAX_BASENAME_CHARS = 180` at `:3565`): control chars, bidi overrides, line
  separators and BOM stripped; illegal characters replaced; dot-runs collapsed so
  `..` cannot survive; Windows device names prefixed; NFC normalised (`:3580`);
  180-char basename cap re-applied after the extension is attached (`:3703-3706`).

---

## 🔐 Token acquisition

Not from cookies. **The Clerk JWT is not readable from `document.cookie`** — the
`__session` cookie is HttpOnly and is a different, Next.js SSR value; sending it
as a Bearer token is a bug (`lib/api.js:42-44`).

**And not from a content script either.** `window.Clerk` lives in the page's
world; a content script's isolated world cannot see it. Getting at it means
MAIN-world access, which means § MAIN-world access above, which means the worker.

> ⚠️ **The previous text on this page described a mechanism that cannot work.** It
> said the content script "injects a small MAIN-world script
> (`content/content.js:2949-2961`, a line range that no longer exists) that awaits
> `window.Clerk.session` and posts the token back". suno.com's CSP refuses to
> execute an inline `<script>`, so that script never ran, and there was no handler
> on the other end either. **There is no
> page-side relay in this build and there never was a working one** — the worker's
> waiter map is gone (`background/background.js:1494-1505`) and the
> `SUNO_TOKEN_REQUEST` message does not exist. See § MAIN-world access for what
> replaced it.

### The ladder

> ⚠️ **Whether suno.com publishes `window.Clerk` as a page global is UNVERIFIED.**
> Nobody has confirmed it for this site, and the ladder is built so that the answer
> does not matter. Full statement, and what to do if `probe` says `hasClerk:false`:
> [`KNOWN-LIMITS.md` § 21](KNOWN-LIMITS.md).

`mintAuthToken` (`background/background.js:1772-1897`) tries four rungs in order
and the **first non-empty token wins**. Cheap-and-most-likely first, expensive
wait last:

```
(a) auth-read                      one instant MAIN-world call
      the tap's captured header. No page dependency, and once the tap is
      installed a working tab NEVER reaches (c).
        │
(b) auth-tap  ->  auth-read       one injection (idempotent) + one read
      installs the tap if the content script never mounted — a signed-in Suno
      tab with no dock, an about:blank that just navigated — then reads it.
        │
(c) clerk-token, ~12 s             THE WAIT, and the fix for the
      polls for window.Clerk INSIDE the page, then session.getToken().
      document-start race.
        │
(d) auth-read                     one instant call
      the page may well have made an authenticated request while (c) waited.
```

**Why the wait is third and not first.** It costs up to 12 seconds
(`CLERK_WAIT_DEFAULT_MS`, `background/background.js:277`, clamped to 500–30,000 ms
for a caller-supplied value at `:279-281`), and by the time it runs, (a) and (b)
have already answered or proved they cannot. In practice a signed-in tab with the
tap installed returns at (a) and never pays for the wait at all.

**Why the wait has to exist at all.** The previous build made a single
`executeScript` call with `injectImmediately: true` — i.e. at **document-start** —
read `window.Clerk` once, found nothing because Clerk had not constructed its
instance yet, and **never retried**. A single un-waiting probe can only ever lose
that race, which is why sign-in read as permanently broken for a user who was
plainly signed in. `clerk-token` polls at 100 ms
(`background/background.js:2452-2457`) and reports `{waitedMs, hasClerk}` so
*"Clerk never appeared in 12000ms"* is distinguishable from *"Clerk was present but
`getToken()` did not settle"* (`:2478-2545`).

**Nothing from a token is ever half-accepted.** `isUsableJwt`
(`background/background.js:1735`) is whole-or-nothing — under 20 characters
or containing whitespace is not a JWT, and forwarding one produces a 401 that reads
like an expired session. Every MAIN-world op that can return a credential goes
through the same test.

### The `auth-tap`, and what it honestly costs

`auth-tap` (`background/background.js:2149-2387`) passively observes the
`Authorization: Bearer <jwt>` header on **Suno's own** `fetch` and
`XMLHttpRequest` calls, and keeps it in a closure.

- **Read-only.** Nothing is added to, removed from, or rewritten on any request.
- **Always calls through.** Every inspection is individually wrapped and the
  original is *always* invoked — a detached `fetch` call still gets `window` passed
  as its receiver (`:2309-2311`). The wrappers cannot alter, delay, reorder or
  block a request, and cannot throw into the page's call. If any inspection throws,
  the request happens exactly as it would have without us.
- **At-most-once wrapping.** `window.__smAuthTap` is written **before** any hook is
  installed (`:2291`), so a second call can never double-wrap `fetch` or
  `XMLHttpRequest.prototype` even if the first call died part-way. A double-wrap is
  a permanent, unbounded page regression; a partial install is merely reported, and
  each hook's outcome is verified by reading the property back (`:2319`, `:2356`,
  `:2363`).
- **Only Suno API hosts** are inspected (`:2295-2303`), and the header container is
  read as a `Headers` instance, a plain object **or** an array of pairs
  (`:2235-2241`), because all three are legal in the Fetch spec and supporting only
  the first would silently miss captures.

**The exposure, stated rather than implied away** (`:2225-2233`): the captured
value is reachable only through the holder's `read()` getter, but **that holder
lives on `window`, so any script the page itself runs can read it.** That grants a
same-origin page script nothing it does not already have — the JWT is in the page's
own memory and in every outgoing header — and this build sends it nowhere except
the worker, which stores it in `chrome.storage.session`. It is still worth being
accurate about: **this is the page's credential, not a credential this extension
created.**

`auth-read` (`background/background.js:2388-2450`) then reads whatever the tap
holds, and distinguishes *"the tap is not installed"* from *"the tap is installed
and has not captured a header yet"* (`:2412`) from *"the tap saw N Authorization
headers and holds no usable token"* — three different problems with three different
fixes.

### Ordering, which is the actual fix

The content script installs the tap on mount, **immediately after `REGISTER_TAB`
and before `GET_BOOT`** (`content/content.js:3712-3778`, tap at `:3745`,
`GET_BOOT` at `:3778`), then does one eager
`auth-read` and hands the worker whatever it has via `SET_TOKEN`
(`content/content.js:3749-3765`) so the worker holds a token before it needs one
rather than minting on the critical path.

> **Minting before the tap exists is precisely how a plainly-signed-in user ends
> up reading "no Clerk JWT available".** `GET_BOOT` and `GET_TOKEN_STATUS` are the
> calls that make the worker try to mint, and if they go first there was nothing to
> capture yet. The comment at `content/content.js:3720-3738` says this in full.
>
> A **tap failure is logged and does not abort mounting** — Clerk may still work
> through the worker's own mint path, and a dock that refuses to appear because an
> auth helper is unhappy is strictly worse than a dock with no tap. A quiet
> `GET_TOKEN_STATUS` re-read closes the mount (`content/content.js:3809-3813`),
> because the tap only sees a token when Suno makes an authenticated request,
> which happens at its own pace.

### Re-mint timing, and what "expired" means

Re-mint happens **90 seconds before the JWT's own `exp`**
(`TOKEN_REFRESH_SKEW_MS`, `background/background.js:264`).

**401 + `exp` still in the future = bad token, not bad session**
(`lib/api.js:45-47`, surfaced as `error.code === 'bad_token'` vs `'unauthorized'`).
The recon hit exactly this trap with a byte-corrupted hand-pasted token
(`../suno-recon/reports/LIVE-2026-09-30.md:15-17`).

**`missing_token` now costs one forced re-acquisition, and no HTTP attempt.**
An empty first probe is a race, not a verdict, so `request` spends exactly one
`getToken({force:true})` on it — behind a 750 ms wait capped at half the caller's
own timeout, because an immediate re-probe in the same tick reproduces the same null
(`lib/api.js:1890-1903`, helper contract at `:1871-1889`, constants `:115`/`:117`). A request
with no bearer token must never reach the network, so neither branch adds an
attempt. The message is now actionable rather than implying a signed-out user
(`lib/api.js:130-134`), and `tokenExpired` reports `false` when no token was ever
obtained (`lib/api.js:1411-1426`) — nothing expired, because there was never
anything to expire.

### When the ladder fails, say which rung failed

`lastAuthFailure` (`background/background.js:2860`, written at `:1782-1795` and
`:1885-1895`) records **which op was reached, what each op returned, the tab ids
tried and whether the tap was installed** — and deliberately **no token material
any op may have seen**. It is a description of the search, never a credential.
`GET_DIAGNOSTICS` returns it alongside `mainWorldOps`
(`background/background.js:7385-7386`), which is the difference between
answering the next "not signed in" report and guessing at it.

> ⚠️ **`GET_BOOT.token` and `GET_TOKEN_STATUS.token` are OBJECTS**, not strings:
> `{hasToken, expiresAt, secondsRemaining, source, badToken}`
> (`tokenStatus`, `background/background.js:1950-1978`). The old consumer guard was
> `TOKEN_RE.test(String(res.token))`, and `String({hasToken:true,…})` is
> `"[object Object]"`, which can never match the token pattern — so the dock's
> token panel silently reported nothing. The check is now a shape test
> (`readTokenStatus`, `content/content.js:3508`).

---

**Next:** [DOWNLOAD-LADDER](DOWNLOAD-LADDER.md) · [FILTERS](FILTERS.md) ·
[RECON-NOTES](RECON-NOTES.md) · [KNOWN-LIMITS](KNOWN-LIMITS.md) ·
[← README](../README.md)