# 🔬 Recon notes — the verified-truth ledger

This is the fact-check. Every claim this extension makes about Suno's API is
either **built on** something verified live, or **deliberately not built on** with
a reason and a citation. Nothing here is inference dressed up as knowledge.

The upstream ledger lives at `../suno-recon/` and is cited throughout as
`../suno-recon/reports/FILE.md:LINE`. Line numbers are real — go check them.

**Recon window:** 2026-09-28 (baseline, read-only) and 2026-09-30 (full
re-verification + authenticated sweep). Corpus: 96 minified JS chunks (7.3 MB)
+ 7 sitemaps + live authenticated API. Account: Premier, `country_code: CA`,
owns one custom model (`../suno-recon/reports/FINDINGS.md:3-6`).

---

## ✅ Built on — verified live

### The 23 verified routes

`SunoAPI.ENDPOINTS`, `lib/api.js:909-940`. **23 entries**, asserted at construction
time (`lib/api.js:1034-1046`): every entry must be an absolute `/api/...` path and
must survive the forbidden-fragment guard, or the client refuses to construct.

Three grades, per `lib/api.js:902-909`:

> `CONFIRMED LIVE` = 200 with a known body · `CONFIRMED REFUSAL` = live, answers
> 200 with `{ok,reason,message}` · `CONFIRMED REGISTERED` = 401/405/422 proves the
> route exists; **body unknown**

#### CONFIRMED LIVE (200 + known body) — 9

| route | returns |
|---|---|
| `GET /api/feed/v2` | `{"clips":[...]}` — **page size UNKNOWN** |
| `GET /api/project/me` | `{num_total_results, current_page, projects:[...]}` |
| `GET /api/project/feed` | `{items:[{type, added_at_ms, clip}]}` |
| `GET /api/playlist/me` | `{num_total_results, current_page, playlists:[...]}` |
| `GET /api/profiles/pinned-clips` | `{pinned_clips:[...]}` |
| `GET /api/persona/get-personas/` | `{personas:[...]}` |
| `GET /api/persona/get-loved-personas/` | — |
| `GET /api/persona/get-followed-personas/` | — |
| `GET /api/billing/info/` | **entitlement ground truth** |

#### CONFIRMED LIVE, known refusal contract — 2

| route | behaviour |
|---|---|
| `GET /api/studio/clip/{id}/download` | answers **200 with `{ok:false, reason:'no_permission'}`** |
| `GET /api/download/clip/{id}` | same |

#### CONFIRMED REGISTERED — bodies NOT confirmed — 12

| route | how existence is proven |
|---|---|
| `GET /api/profiles/me` | 422 — **both** sort params required |
| `GET /api/clips/get_songs_by_ids` | 422 — `ids` required; envelope unknown |
| `GET /api/clips/parent` | 422 — `clip_id` required |
| `GET /api/clips/aligned_clip_siblings` | 422 — `clip_id` required |
| `GET /api/gen/{id}/waveform-aggregates` | 401 unauthenticated |
| `GET /api/gen/{id}/aligned_lyrics/v3` | 401 unauthenticated |
| `POST /api/download/authorize` | 405 on GET — POST-only |
| `POST /api/download/clips/zip/prepare` | 405 on GET — POST-only, flat, max 200 ids |
| `GET /api/download/sample-pack/{clip_id}` | 422 — `job_id` required |
| `POST /api/gen/{id}/convert_wav/` | **403 means entitlement**, not auth |
| `GET /api/gen/{id}/wav_file/` | signed S3 URL, observed TTL 3599 s |
| `POST /api/mango/rights` | 422 — **nesting UNCONFIRMED; do not trust 422 `loc`** |

> **A 401/405/422 is proof of existence, not of shape.** Every one of these twelve
> carries an explicit "bodies and envelopes are NOT confirmed" warning in the table
> itself (`lib/api.js:926-928`). Nothing above is documented as a schema.

### Behaviour constants that are verified, not guessed

`SunoAPI.LIMITS`, `lib/api.js:943-951`:

| constant | value | why it matters |
|---|---|---|
| `zipChunkSize` | **200** | confirmed server max for `clip_ids` |
| `idsChunkSize` | **100** | conservative max for `?ids=` |
| `ratePerSecond` | **4** | the production pace |
| `concurrency` | **3** | global in-flight cap |
| `stallPageLimit` | **2** | two empty pages ends a crawl |
| `bulkUnavailableMarker` | `Bulk download is not available` | verbatim refusal string |

`SIGNED_URL_TTL_SECONDS = 3599` (`lib/api.js:969`) — observed, not documented.

### Verified clip fields

Every field the filter engine reads is recon-verified. The full mapping lives in
`SunoFilter.normalize` (`lib/suno.js:870-1018`). The ones that bit hardest:

| finding | where |
|---|---|
| `audio_url` is **always** the literal `https://studio-api.prod.suno.com/api/forbidden` | `lib/suno.js:36-38`, `lib/drm.js:12-13` |
| real audio is `media_urls[].url`, a CloudFront object with `content_type: "m4a-opus"` | `lib/drm.js:15-16` |
| liking is per-clip `is_liked` | `lib/suno.js:897-899` |
| `major_model_version` is **frequently the empty string** | `lib/suno.js:44-48`, `:893` |
| **no project field on a clip** — membership is joined from `/api/project/feed` | `background/background.js:4251` |
| the `action_config.actions` entitlement enum | `lib/suno.js:71-77` |
| model keys: v6=`chirp-hawk`, v6-wild=`chirp-hawk-wild`, v6-mini=`chirp-goose`, remaster=`chirp-halibut` | `../suno-recon/reports/LIVE-2026-09-30.md:74-75`, `../suno-recon/reports/THIRD-PARTY-2026-09-30.md:140-141` |

### The `/b-side/*` measurement, for the record

**84 route names × 2 methods = 168 requests, all 404**, byte-identical anonymous
and authenticated, plus 64 further staff-path probes on the API host all 404
matching the negative control exactly (`../suno-recon/reports/LIVE-2026-09-30.md:422-425`). On
the page layer all 84 fall through to `/[lang]`
(`../suno-recon/reports/FINDINGS.md:313-318`). Zero 200s, zero 403s, zero staff data.

**Authorization is enforced by non-deployment, not by a role check**
(`../suno-recon/reports/FINDINGS.md:320-321`).

---

## 🚫 Deliberately NOT built on — and why

Each of these is a real, reachable, interesting thing. **The extension does not
touch it, and here is the reason.**

### 1. `/b-side/*` — 84 routes, all 404

**Status:** measured on both layers, negative.

**Why not built on:** it does not exist. The route names survive only in the public
bundle's route manifest, which is itself the disclosure
(`../suno-recon/reports/FINDINGS.md:315-323`).

> **This is the best disclosure candidate of either recon session.** Not an
> exploit, not a bypass — an information-disclosure finding: Suno ships staff route
> names to every customer. **Report it. Do not use it.**

### 2. `studio-api-staging.suno.com` — live and unauthenticated

**Status:** `GET /api/session/` returns HTTP 200 with **no credentials**
(`../suno-recon/reports/FINDINGS.md:199-203`).

| | prod | staging |
|---|---|---|
| flags | 47 | **58** |
| `configs` | `{gen-endpoint:…}` | `null` |
| `experiments` | `{}` | `null` |

14 flags exist **only** in staging (`../suno-recon/reports/FINDINGS.md:213-229`), naming features
prod does not have: `can-create-album`, `can-publish-album`, `collab-workspaces`,
`midi-transcription`, `open-task-midi-input`, `diffusion-infill`,
`new-model-beta-test`, `clip-feedback`, `clip-parent-populates-remix-sidebar`,
`realtime-billing-credits`, `can-delete-account`,
`enable-sharelist-and-share-notifications`, `custom-model-ui`, `mumble-mode`.

**Why not built on:** it is an **unauthenticated misconfiguration** to report to
Suno, not a resource to exploit. The recon's own words
(`../suno-recon/reports/FINDINGS.md:261-265`):

> **The correct action is to report it, not to use it.** Nothing here was acted on:
> `GET /api/session/` only, no writes, no generation, no state touched on staging.

**How the extension enforces this** — a host denylist, not a convention:

```js
const FORBIDDEN_HOST_FRAGMENTS = Object.freeze([
  'staging', '-beta', '-dev', '-preview', '-canary'
]);
```
— `lib/api.js:81-87`

`_assertBaseUrls` (`lib/api.js:1054-1073`) throws `forbidden_base_url` at
**construction time** on any host containing one of those substrings. It cannot be
configured away: `baseUrls` is validated before any request can be built. The other
`tiers don't even resolve (`../suno-recon/reports/FINDINGS.md:210-211`).

### 3. `/api/playlist/liked/` — **does not exist**

**Status:** fiction. `lib/api.js:76-80` builds the fragment from concatenated parts
so the guard cannot reintroduce the literal:

```js
const FORBIDDEN_ROUTE_FRAGMENTS = Object.freeze([
  '/b-' + 'side/',
  'suno.' + 'com/api',
  '/api/playlist/' + 'liked',
]);
```

**Why not built on:** there is no liked-songs route at all. The old build paged it
and **silently got nothing** — which is why "liked only" never worked.
`lib/api.js:11-12`:

> there is NO liked-songs route at all. Liking is per-clip state carried on each
> clip object (`is_liked`). It is derived locally by filtering the feed.

The old filter also read `upvote_count` as a proxy for a like, which is why
"liked only" matched 100% of the library. Two bugs, one symptom.

### 4. `suno.com/api/*` — the web origin does not proxy `/api/*`

**Status:** every such call 404s. `suno.com` is the Next.js web origin
(`lib/api.js:17-18`); the two verified hosts are `studio-api-prod.suno.com` and
`studio-api.prod.suno.com` (`lib/api.js:55-58`).

**Enforced by:** the `suno.com/api` forbidden fragment above, plus `_assertEndpoints`
running `assertRouteAllowed` over the whole table at construction
(`lib/api.js:1043`).

> ⚠️ **A trap in the recon methodology, worth repeating.** Vercel sets
> `x-matched-path: /` with a **200** on a large number of *nonexistent* paths,
> because they fall through to the root layout and render the homepage. A naive
> `status == 200 → EXISTS` rule marks `/admin`, `/hooks/admin`,
> `/internal/lyrics-check` and `/taste` as live staff routes. **They are the
> homepage.** Registration must be judged by `x-matched-path` *equalling* the
> requested path (`../suno-recon/README.md:78-81`, `../suno-recon/reports/LIVE-2026-09-30.md:566-571`).
> That single correction accounts for 192 of the 550 probed paths
> (`../suno-recon/reports/LIVE-2026-09-30.md:582`).

### 5. 422 `loc` chains — **fabricated**

**Status:** the validation error path is not the accepted path.

`POST /api/gen/{id}/set_visibility/` reports `loc=['body','spec','is_public']`, but
`{"spec":{"is_public":1}}` still returns *Field required* while the flat
`{"is_public":1}}` passes validation and reaches the handler
(`../suno-recon/reports/sweep2/write_schemas.md:10-15`; `../suno-recon/reports/LIVE-2026-09-30.md:392-407`).

**Why not built on:** the field names and types in the schema map are reliable;
the **nesting is not**. `lib/drm.js:39-44` says the rights call ignores them
outright, which is exactly why `RIGHTS_BODY_SHAPES` is a prioritised list rather
than a reconstruction — *"we never read them"* — and the winning shape is recorded
at runtime so it can be pinned down later.

Bonus finding worth knowing: `detail` is a **string containing a Python
`repr()`**, not a JSON array (`../suno-recon/reports/LIVE-2026-09-30.md:405-407`). No RFC 9457.

### 6. `/api/session/` as the model catalogue — it is stale

**Status:** the web branch serves a **stale list**. `/api/session/`'s model
catalogue is *client-identity-keyed*; under an Android identity it returns
v6 / v6-wild / v6-mini / v5.5, while the web branch still advertises v4.5 as newest
(`../suno-recon/reports/FINDINGS.md:101-103`, `../suno-recon/reports/LIVE-2026-09-30.md:514-521`).

**Why not built on:** use `/api/billing/info/` instead
(`../suno-recon/reports/FINDINGS.md:105-106`; `../suno-recon/README.md:87-88`):

> **trust `/api/billing/info/` for the real model catalogue, not
> `/api/session/`**

`lib/api.js:919` labels it exactly that: `billingInfo: '/api/billing/info/',
// entitlement ground truth`.

> **And this is NOT an entitlement bypass — do not report it as one.** The account
> already held v6 rights; `/api/billing/info/` independently reports
> `can_use: true` (`../suno-recon/reports/FINDINGS.md:98-100`). What the header reveals is only
> that the web branch is stale.

### 7. The Studio-download-not-counted bypass — **closed**

**Status:** a third party documented Path D serving **42 WAVs without moving the
counter** on 2026-09-04 (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:126-128`). Suno closed
it by 2026-09-09; counting is now server-authoritative
(`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:126-128`; `../suno-recon/reports/FINDINGS.md:357-361`).

**Why not built on:** it is a **closed bug**. `background/background.js:322-325` says so in the
ladder definition:

> The old exploit — "the Studio route does not count toward quota" — was closed
> server-side on 2026-09-09. `metered` below is therefore the **OBSERVED contract**
> and not a bypass claim.

**Report it as fixed.** The residual question — Studio's "unlimited" allowance on a
plan whose other paths meter — is a **policy question for Suno**, not an exploit
(`../suno-recon/reports/FINDINGS.md:357-361`).

### 8. `event.source` in the page token relay — a closed gap

**Status:** the old page relay validated `event.origin` but **not**
`event.source`, so **any same-origin script** could post a token-shaped message and
overwrite the extension's credential **profile-wide**.

**How it is closed now** (`content/content.js:2966-2980`), with the reason in the
comment:

```js
// BOTH checks are required: origin alone would let any same-origin script
// (or an injected <script>) overwrite the extension's credential for the
// whole profile.
if (event.source !== window) return;
if (event.origin !== location.origin) return;
if (d.source !== 'suno-master-dock' || d.kind !== 'token') return;
```

Plus a shape check: the token must match `TOKEN_RE` or it is rejected as malformed
(`content/content.js:2973-2978`).

### 9. The 84 experimental route names as a fallback list

**Status:** 168 requests, all 404 (`lib/api.js:13-16`):

> none of the 84 experimental route names probed (168 requests, both methods,
> anonymous and authenticated) are deployed: all 404. Those names survive only in
> the public bundle's route manifest. **The allowlist is gone.**

**Why:** a fiction you keep as a "fallback" is a fiction you will eventually
successfully request. They are removed outright, not kept as alternates.

### 10. Reseller-only routes

**Status:** `/api/generate/sounds/`, `/api/sounds/`, `/api/generate/loop/`,
`/api/loop/`, `/api/jingle/`, `/api/recovery-audio/`, `/api/generate/recovery-audio/`,
`/api/recover/`, `/api/act/tags`, `/api/mashup/` — **all 404** on Suno
(`../suno-recon/reports/LIVE-2026-09-30.md:484-488`).

**Why it matters generally:** reseller docs are a **capability inventory**, not a
route inventory — a capability inventory of *what a reseller chose to build*
(`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:24-26`). This kills the two best
"undiscovered route" hypotheses in the third-party corpus.

---

## ❓ Open questions — genuinely open

These are not "we didn't get round to it". They are things the recon could not
answer and the code cannot guess.

### The `format` enum is undocumented

The download routes take `?format=`. **No source enumerates the accepted members.**
`background/background.js:444-447` is the honest position:

> The value is passed straight through as the download route's `?format=`
> parameter, whose enum members are undocumented — `lib/api.js` tallies every value
> tried so the real members can be learned from telemetry.

`VARIANTS` (`background/background.js:448`) lists **three**: `m4a`, `wav-48k`, `wav`.
Seven values that used to be there — `mp3`, `mp3-256`, `mp3-320`, `flac`, `ogg`,
`aac`, `opus` — were **removed** in 6.0.1, not because the server rejects them but
because this build has no encoder to produce them locally and offering them was a
control that looked live and was not (`background/background.js:421-447`).
`lrc` / `cover` / `json` left the list for a different reason: they are sidecars,
not containers.

`lib/api.js:1020` keeps `_formatTally` for exactly this. **Only `m4a` is
guaranteed**, because the free rungs deliver the source stream verbatim; `wav` and
`wav-48k` are honest regardless, because they are rendered locally from whatever
bytes arrived rather than asked for.

### The ZIP prepare response shape is unknown

`POST /api/download/clips/zip/prepare` is confirmed to exist, POST-only, flat body,
`clip_ids` required, ≤200 per chunk. **What it returns on success has never been
observed.** `background/background.js:2870-2874` refuses a job-shaped response rather than polling:

> the route returned a job id rather than a URL; job polling is not implemented

It may well be a job. Treat the rung as experimental.

### `additional_download_remaining` has no explanation

Read **7** on one account, **0** on the recon account, with **no client reference in
227 chunks** (`../suno-recon/reports/FINDINGS.md:362-365`; `../suno-recon/README.md:117-119`). It is
not a static free-tier grant — it tracks real remaining overflow, because the two
accounts' values differ for a reason nobody has established.

The extension surfaces it as `quota.additionalRemaining` and folds it into
`effectiveRemaining` (`lib/api.js:2609`), so a batch will spend it. **It is a
question for the team, not something to burn 60 downloads finding out.**

### "My Taste" is real and has no backing route

**Real:** user-visible, LLM-authored, and it steers all generation, including Magic
Wand (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:176-180`).

**No route:** `nav.myTaste` is a **single** occurrence in the entire 96-chunk
corpus and the only `taste` token anywhere. It is a `<Button onClick={O}>` in a
nav — an in-page modal. Ten candidate routes (`/my-taste`, `/taste`,
`/settings/taste`, `/preferences/taste`, `/profile/taste`, `/persona/taste`,
`/taste-profile`, `/your-taste`, `/custom-taste`, `/preferences/my-taste`) all fall
through to the homepage or `/profile/[slug]`. **None is registered**
(`../suno-recon/reports/LIVE-2026-09-30.md:77-96`).

> The feature is real, user-visible, and steers all generation, but **its backing
> route is not in the client** (`../suno-recon/reports/FINDINGS.md:601-606`).

**This is a question for Suno staff, not a brute-force target.** And it is a
question this extension cannot act on: there is nothing to call.

### Which `/api/mango/rights` body shape is correct

The sweep could not resolve it either — *"wire shape: unresolved (every flat
attempt still failed validation)"* (`../suno-recon/reports/sweep2/write_schemas.md:491-494`). The
recon knows the required fields and the `content_type` enum spans **16 values**
(`clip, hook, banner, shortcut, contest, creator_profile, playlist_shortcut,
create_playlist_action, playlist, album, generic_feed, persona, genre,
typeahead_suggestion, query_suggestion_text, gem` —
`../suno-recon/reports/FINDINGS.md:456-460`), but not the nesting.

**The extension's answer:** try all three shapes, stop at the first 2xx, record
which one won in `stats().rights.bodyShape` (`lib/drm.js:108-127`, `:42-44`). Once
telemetry pins it down, hard-code it.

**Secondary open question:** is the user key seeded from the bearer token or from
`glt`? `lib/drm.js:46-51`:

> Genuinely unattested either way: one lineage hashes `glt` and works for guests
> with no token at all, another hashes the bearer token. They cannot both be right
> for one account.

So `resolveUserKey` returns an ordered `attempts` array and the caller retries
without a second network round trip.

### The feed page size

`lib/api.js:911` annotates it `// page size UNKNOWN` and nothing in the recon
resolves it. Consequences in KNOWN-LIMITS, section 5.

### The free-tier download figure

Policy says 7 lifetime (`../suno-recon/reports/FINDINGS.md:340`); the extension writes "free 0"
(`background/background.js:320`); the code encodes **`null`, verified: false**
(`lib/api.js:960`). **None of these is verified** because the recon account was
Premier. The code is right to refuse to substitute a number.

---

## 🧾 Adjacent recon facts worth carrying

Not used as behaviour, but they explain decisions in the code.

**Suno ships no public developer API.** No OAuth app surface, no official MCP, no
app on Zapier (confirmed 404), Slack, Notion, Pipedream, IFTTT, Power Automate or
Huin (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:12-17`). Every "Suno API" in circulation is
a reseller or a cookie-scraping client. **The absence across every major
integration platform is itself the finding** — those platforms integrate far more
niche services. It is a licensing/ToS decision, not a capability gap
(`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:19-22`).

**The download-quota subsystem is a Sept-2026 addition.** Four routes —
`authorize` → `zip/prepare` → `studio/render-state` → per-clip signed download —
all confirmed live with 405s, absent from the 235-endpoint bundle list because every
entry point is a lazily-loaded `/create` or `/me` code path
(`../suno-recon/reports/LIVE-2026-09-30.md:479-482`). This is why the recon account was at
60/60 (`../suno-recon/reports/LIVE-2026-09-30.md:58-64`).

**The flag vocabulary is frozen.** 234 `/api/*` endpoints in both corpora, 0 added,
0 removed; 37 named gates, 0 delta; `/b-side/*` 0 delta; 0 new codenames
(`../suno-recon/reports/LIVE-2026-09-30.md:153-158`). **New surface appears in the UI layer and
in staging flags, not in the API** (`../suno-recon/README.md:89-91`). If you are hunting
for new API surface, the bundle and the flag diff are strictly better places to
look — and see the disclosure above before you touch staging.

**The recon's own ground rules are binding here too** (`../suno-recon/README.md:60-74`):
`cookies.txt` is a live credential and must never be committed · run `freshtok.py`
first · never touch another user's data · `/b-side/*` existence-check only ·
staging read-only · never `DELETE` · **rate limit 4 req/s + jitter, because this is
production** (`../suno-recon/README.md:74`).

---

## 🔒 Security posture in this extension

| rule | where |
|---|---|
| Zero empty catch blocks; every failure logged with diagnosable context | `background/background.js:51-53` |
| No token or key material logged, ever | `background/background.js:644`, `lib/api.js:166-172` |
| No token or key material outside `chrome.storage.session` | `background/background.js:49-50` |
| Sender validation on **every** route: `id` **and** `url` | `background/background.js:1633` |
| Offscreen replies verified against the full sender envelope before they can settle a waiter | `background/background.js:1871-1888` |
| Page relay validates origin **and** source | `content/content.js:2966-2980` |
| Host denylist enforced at construction, not at request time | `lib/api.js:1054-1073` |
| Route table validated at construction; unknown routes refused | `lib/api.js:1034-1046` |
| Unwrapped content keys in an in-memory LRU **only** — never storage, never disk | `lib/drm.js:53-61` |
| `EXPORT_SETTINGS` omits token, key material and diagnostics | `background/background.js:5412-5438` |
| Hostile filename sanitisation (a title is attacker-influenced text) | `background/background.js:2242-2269` |
| No `innerHTML` anywhere in the content script — every node via `textContent` | `content/content.js:24-27` |
| No remote code; MV3 CSP `script-src 'self'` | `manifest.json:77-79` |

The key-cache detail deserves its own line (`lib/drm.js:53-61`): unwrapped content
keys are **never written to `chrome.storage`, `localStorage`, `sessionStorage`, or
`indexedDB`** — *"key material in extension storage is readable by anything with
the extension id and survives on disk."* The cache is bounded (512) and TTL'd
(3600 s) because it is also the only place a `CryptoKey` outlives a single call.

---

**Next:** [DOWNLOAD-LADDER](DOWNLOAD-LADDER.md) · [FILTERS](FILTERS.md) ·
[ARCHITECTURE](ARCHITECTURE.md) · [KNOWN-LIMITS](KNOWN-LIMITS.md) ·
[← README](../README.md)