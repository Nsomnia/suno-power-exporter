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

### The 24 verified routes

`SunoAPI.ENDPOINTS`, `lib/api.js:1084-1122`. **24 entries**, asserted at
construction time (`lib/api.js:1212`, `_assertEndpoints` at `:1223-1235`): every
entry must be an absolute `/api/...` path and must survive the forbidden-fragment
guard, or the client refuses to construct.

Four grades, per `lib/api.js:1074-1083`:

> `CONFIRMED LIVE` = 200 with a known body · `CONFIRMED REFUSAL` = live, answers
> 200 with `{ok,reason,message}` · `CONFIRMED REGISTERED` = 401/405/422 proves the
> route exists; **body unknown** · `CONFIRMED IN CLIENT` = the shipped web client's
> own OpenAPI caller names it — **route and envelope known from source, no
> authenticated capture**

#### CONFIRMED LIVE (200 + known body) — 8

| route | returns |
|---|---|
| `GET /api/project/me` | `{num_total_results, current_page, projects:[...]}` |
| `GET /api/project/feed` | `{items:[{type, added_at_ms, clip}], next_cursor}` |
| `GET /api/playlist/me` | `{num_total_results, current_page, playlists:[...]}` |
| `GET /api/profiles/pinned-clips` | `{pinned_clips:[...]}` |
| `GET /api/persona/get-personas/` | `{personas:[...]}` |
| `GET /api/persona/get-loved-personas/` | — |
| `GET /api/persona/get-followed-personas/` | — |
| `GET /api/billing/info/` | **entitlement ground truth** |

#### CONFIRMED IN CLIENT (bundle chunk, no authenticated capture) — 3

| route | returns | evidence |
|---|---|---|
| `POST /api/feed/v3` | `{clips:[...], next_cursor}` — **the only route this client enumerates a library with** | `suno-recon/out/chunks/1r1sqgyc3uj2o.js:5`; `POST("/api/feed/v3",{body:{cursor,limit,filters}})` returning `{clips, nextCursor}` |
| `POST /api/feed/v3/offset` | the **offset** sibling: `POST {offset, filters}` | same chunk; the web client calls it from the same file |
| `GET /api/clips/get_songs_by_ids` | **`{clips:[…]}` — confirmed, not unknown.** `ids` is required (422 without it) and the shipped client guards on `Array.isArray(t.data?.clips)` | `suno-recon/out/chunks/0zj00x725960e.js:3` |

> ⚠️ **None of these three has an authenticated capture.** The recon captured the
> route but never a 200 from it. `limit`'s maximum, the accepted filter keys and
> v3's `num_total_results` semantics all rest on the bundle plus two working
> third-party extensions — **evidence-backed, not live-verified.** See
> [`KNOWN-LIMITS.md`](KNOWN-LIMITS.md).

#### CONFIRMED LIVE, known refusal contract — 2

| route | behaviour |
|---|---|
| `GET /api/studio/clip/{id}/download` | answers **200 with `{ok:false, reason:'no_permission'}`** |
| `GET /api/download/clip/{id}` | same |

#### CONFIRMED REGISTERED — bodies NOT confirmed — 11

| route | how existence is proven |
|---|---|
| `GET /api/profiles/me` | 422 — **both** sort params required |
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

> **A 401/405/422 is proof of existence, not of shape.** Every one of these eleven
> carries an explicit "bodies and envelopes are NOT confirmed" warning in the table
> itself (`lib/api.js:1108-1110`). Nothing above is documented as a schema.

### Behaviour constants that are verified, not guessed

`SunoAPI.LIMITS`, `lib/api.js:1125-1135`:

| constant | value | why it matters |
|---|---|---|
| `zipChunkSize` | **200** | confirmed server max for `clip_ids` |
| `idsChunkSize` | **100** | conservative max for `?ids=` |
| `feedPageLimit` | **100** | **the confirmed server maximum for `/api/feed/v3`'s `limit`** — larger values are rejected |
| `feedPageRetries` | **5** | a library walk only; the global default stays at 3 |
| `projectFeedLimit` | **30** | the shipped client's own page size for `/api/project/feed` |
| `defaultMaxPages` | **500** | 500 pages × 100 = 50,000 clips |
| `ratePerSecond` | **4** | the production pace |
| `concurrency` | **3** | global in-flight cap |
| `bulkUnavailableMarker` | `Bulk download is not available` | verbatim refusal string |

> ⚠️ **`stallPageLimit` is GONE, and that is the point.** It used to be `2` — *"two
> empty pages ends a crawl"* — which is how a feed that hiccuped twice was read as
> the end of a library. A single empty page that still carries a cursor is now an
> **error** (`stopReason: 'empty_page'`), not a stopping condition.

`SIGNED_URL_TTL_SECONDS = 3599` (`lib/api.js:1153`) — observed, not documented.

`FEED_PAGE_BYTES_HINT = 140_000` (`lib/api.js:1161-1167`) was measured on the
**removed** `/api/feed/v2` route and is a **per-request constant for progress
estimation only** — a v3 page of 100 clips is roughly five times it, and no
correctness decision may depend on it.

### Verified clip fields

Every field the filter engine reads is recon-verified. The full mapping lives in
`SunoFilter.normalize` (`lib/suno.js:870-1018`). The ones that bit hardest:

| finding | where |
|---|---|
| `audio_url` is **always** the literal `https://studio-api.prod.suno.com/api/forbidden` | `lib/suno.js:36-38`, `lib/drm.js:12-13` |
| real audio is `media_urls[].url`, a CloudFront object with `content_type: "m4a-opus"` | `lib/drm.js:15-16` |
| liking is per-clip `is_liked` | `lib/suno.js:897-899` |
| `major_model_version` is **frequently the empty string** | `lib/suno.js:44-48`, `:893` |
| **no project field on a clip** — membership is joined from `/api/project/feed` | `background/background.js:5581-5583` |
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
— `lib/api.js:97-103`

`_assertBaseUrls` (`lib/api.js:1243`) throws `forbidden_base_url` at
**construction time** on any host containing one of those substrings. It cannot be
configured away: `baseUrls` is validated before any request can be built. The other
`tiers don't even resolve (`../suno-recon/reports/FINDINGS.md:210-211`).

### 3. `/api/playlist/liked/` — **does not exist**

**Status:** fiction. `lib/api.js:90-94` builds the fragment from concatenated parts
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
`lib/api.js:12-13`:

> there is NO liked-songs route at all. Liking is per-clip state carried on each
> clip object (`is_liked`). It is derived locally by filtering the feed.

The old filter also read `upvote_count` as a proxy for a like, which is why
"liked only" matched 100% of the library. Two bugs, one symptom.

### 4. 🚨 `GET /api/feed/v2` — **it answers, and it is still wrong. Do not enumerate through it.**

**Status:** live, but **not a Suno web-app route.** It was previously listed in
this document's *verified* table with an honest *"page size UNKNOWN"* note. That
was wrong in the way that matters: an unknown page size on the right route is an
open question, and this is the wrong route entirely. It is recorded here now as a
**do-not-build-on** item, because three independent lines of evidence agree and
because a 200 is not proof of a route.

| # | evidence | what it shows |
|---|---|---|
| 1 | **0 of 96** minified bundle chunks contain the string `api/feed/v2`. The shipped client's own feed caller POSTs `/api/feed/v3` with `{cursor, limit, filters}` and follows `next_cursor` (`suno-recon/out/chunks/1r1sqgyc3uj2o.js:5`) | Suno's web app never calls it |
| 2 | **0 occurrences** in `scratchpad/captured_endpoints.txt`. The only feed route in the entire capture log is `POST /api/feed/v3` (`scratchpad/captured_endpoints.txt:27`) | it was never captured being used |
| 3 | **one authenticated run, same session, same account:** v2 page 0 returned `num_total_results: 21` and **20 clips**, while `/api/project/me` reported `default` alone holding **3,444** clips (and `num_total_results: 55` *projects*) — `suno-recon/out/authed/_api_feed_v2_hide_disliked_true_page_0.json` vs `_api_project_me.json` | its own total is off by two orders of magnitude |

**Its page size is a fixed 20** — observed directly in capture 3, and that is
precisely why a 5,500-clip library came back as **20 pages / 400 clips**, which is
arithmetically indistinguishable from a finished crawl.

**Why not built on:** a build that enumerated through it indexed 400 clips of
~5,500 and **reported success**. The route is removed from `SunoAPI.ENDPOINTS`
outright (`lib/api.js:14-22`) rather than "kept as a fallback", because a fiction
you keep as a fallback is a fiction you will eventually request. Library
enumeration is `POST /api/feed/v3`.

### 5. `suno.com/api/*` — the web origin does not proxy `/api/*`

**Status:** every such call 404s. `suno.com` is the Next.js web origin
(`lib/api.js:26-27`); the two verified hosts are `studio-api-prod.suno.com` and
`studio-api.prod.suno.com` (`lib/api.js:70-73`).

**Enforced by:** the `suno.com/api` forbidden fragment above, plus `_assertEndpoints`
running `assertRouteAllowed` over the whole table at construction
(`lib/api.js:1212`, `:1223-1235`).

> ⚠️ **A trap in the recon methodology, worth repeating.** Vercel sets
> `x-matched-path: /` with a **200** on a large number of *nonexistent* paths,
> because they fall through to the root layout and render the homepage. A naive
> `status == 200 → EXISTS` rule marks `/admin`, `/hooks/admin`,
> `/internal/lyrics-check` and `/taste` as live staff routes. **They are the
> homepage.** Registration must be judged by `x-matched-path` *equalling* the
> requested path (`../suno-recon/README.md:78-81`, `../suno-recon/reports/LIVE-2026-09-30.md:566-571`).
> That single correction accounts for 192 of the 550 probed paths
> (`../suno-recon/reports/LIVE-2026-09-30.md:582`).

### 6. 422 `loc` chains — **fabricated**

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

### 7. `/api/session/` as the model catalogue — it is stale

**Status:** the web branch serves a **stale list**. `/api/session/`'s model
catalogue is *client-identity-keyed*; under an Android identity it returns
v6 / v6-wild / v6-mini / v5.5, while the web branch still advertises v4.5 as newest
(`../suno-recon/reports/FINDINGS.md:101-103`, `../suno-recon/reports/LIVE-2026-09-30.md:514-521`).

**Why not built on:** use `/api/billing/info/` instead
(`../suno-recon/reports/FINDINGS.md:105-106`; `../suno-recon/README.md:87-88`):

> **trust `/api/billing/info/` for the real model catalogue, not
> `/api/session/`**

`lib/api.js:1093` labels it exactly that: `billingInfo: '/api/billing/info/',
// entitlement ground truth`.

> **And this is NOT an entitlement bypass — do not report it as one.** The account
> already held v6 rights; `/api/billing/info/` independently reports
> `can_use: true` (`../suno-recon/reports/FINDINGS.md:98-100`). What the header reveals is only
> that the web branch is stale.

### 8. The Studio-download-not-counted bypass — **closed**

**Status:** a third party documented Path D serving **42 WAVs without moving the
counter** on 2026-09-04 (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:126-128`). Suno closed
it by 2026-09-09; counting is now server-authoritative
(`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:126-128`; `../suno-recon/reports/FINDINGS.md:357-361`).

**Why not built on:** it is a **closed bug**. `background/background.js:405-407` says so in the
ladder definition:

> The old exploit — "the Studio route does not count toward quota" — was closed
> server-side on 2026-09-09. `metered` below is therefore the **OBSERVED contract**
> and not a bypass claim.

**Report it as fixed.** The residual question — Studio's "unlimited" allowance on a
plan whose other paths meter — is a **policy question for Suno**, not an exploit
(`../suno-recon/reports/FINDINGS.md:357-361`).

### 9. The page token relay — the gap AND the mechanism are both gone

**Status:** the old page relay validated `event.origin` but **not**
`event.source`, so **any same-origin script** could post a token-shaped message and
overwrite the extension's credential **profile-wide**.

> ⚠️ **Superseded in 6.1.1 — do not re-add this from memory.** The gap was closed in
> 6.0.1 by validating `origin` *and* `source`. **In 6.1.1 the whole relay was
> deleted instead**, because it could never have worked: reading `window.Clerk` from
> a content script required an inline `<script>`, which suno.com's CSP refuses to
> execute, and the handler on the other end of the message could not have been fed.
> MAIN-world access moved into the worker
> (`chrome.scripting.executeScript({world:'MAIN'})`) behind a six-key allowlist, and
> the token now comes from a passive `Authorization`-header tap plus a Clerk read
> that polls **inside** the page. **There is no page-side relay, no
> `SUNO_TOKEN_REQUEST` message and no `window.addEventListener('message', …)`
> credential handler in this build.** See
> [`ARCHITECTURE.md` § MAIN-world access](ARCHITECTURE.md) and
> [`KNOWN-LIMITS.md` § 22](KNOWN-LIMITS.md). The reason is recorded in place at
> `background/background.js:1494-1505` and `content/content.js:3212-3217`.

The code that used to close it, kept here as the shape of the check rather than as a
claim that it still exists:

```js
// BOTH checks are required: origin alone would let any same-origin script
// (or an injected <script>) overwrite the extension's credential for the
// whole profile.
if (event.source !== window) return;
if (event.origin !== location.origin) return;
if (d.source !== 'suno-master-dock' || d.kind !== 'token') return;
```

Plus a shape check: the token had to match `TOKEN_RE` or it was rejected as
malformed. **None of that code remains**; the equivalent protection now is that no
credential is ever accepted from the page at all — only from the worker, which
reads it in the MAIN world itself and stores it in `chrome.storage.session`.

### 10. The 84 experimental route names as a fallback list

**Status:** 168 requests, all 404 (`lib/api.js:23-25`):

> none of the 84 experimental route names probed (168 requests, both methods,
> anonymous and authenticated) are deployed: all 404. Those names survive only in
> the public bundle's route manifest. **The allowlist is gone.**

**Why:** a fiction you keep as a "fallback" is a fiction you will eventually
successfully request. They are removed outright, not kept as alternates.

### 11. Reseller-only routes

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
`background/background.js:537-539` is the honest position:

> The value is passed straight through as the download route's `?format=`
> parameter, whose enum members are undocumented — `lib/api.js` tallies every value
> tried so the real members can be learned from telemetry.

`VARIANTS` (`background/background.js:541`) lists **three**: `m4a`, `wav-48k`, `wav`.
Seven values that used to be there — `mp3`, `mp3-256`, `mp3-320`, `flac`, `ogg`,
`aac`, `opus` — were **removed** in 6.0.1 and have stayed off the list since. Two
different reasons, and conflating them is the usual misreading
(`background/background.js:512-541`):

- **`mp3` and `ogg` stay off because `variant` is the ROUTE's `?format=`, not a
  local conversion.** Both encoders are vendored and both work — as
  `settings.transcode`. Advertising `mp3` as a variant would mean *asking* for a
  format the server may not serve, failing, and falling through the ladder,
  potentially spending the metered rungs' quota to produce the very file the free
  rungs already gave us.
- **`flac`, `aac` and `opus` stay off because there is genuinely no encoder.** No
  vendored bundle and no `transcode` format, so no code path can produce one.

`lrc` / `cover` / `json` left the list for a third reason: they are sidecars,
not containers.

`lib/api.js:1209` keeps `_formatTally` for exactly this. **Only `m4a` is
guaranteed**, because the free rungs deliver the source stream verbatim; `wav` and
`wav-48k` are honest regardless, because they are rendered locally from whatever
bytes arrived rather than asked for.

### The ZIP prepare response shape is unknown

`POST /api/download/clips/zip/prepare` is confirmed to exist, POST-only, flat body,
`clip_ids` required, ≤200 per chunk. **What it returns on success has never been
observed.** `background/background.js:4196-4200` refuses a job-shaped response rather than polling:

> the route returned a job id rather than a URL; job polling is not implemented

It may well be a job. Treat the rung as experimental.

### `additional_download_remaining` has no explanation

Read **7** on one account, **0** on the recon account, with **no client reference in
227 chunks** (`../suno-recon/reports/FINDINGS.md:362-365`; `../suno-recon/README.md:117-119`). It is
not a static free-tier grant — it tracks real remaining overflow, because the two
accounts' values differ for a reason nobody has established.

The extension surfaces it as `quota.additionalRemaining` and folds it into
`effectiveRemaining` (`lib/api.js:3164-3172`), so a batch will spend it. **It is a
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

### ✅ The feed page size — CLOSED, and it was two different questions

This question used to read *"`lib/api.js` annotates it `// page size UNKNOWN` and
nothing in the recon resolves it."* That was true of **v2**, and v2 is no longer
used. Both numbers are now settled:

| route | page size | how it is settled |
|---|---|---|
| `GET /api/feed/v2` | **20, fixed** | **observed**: the authenticated capture holds exactly 20 clips on page 0 (`suno-recon/out/authed/_api_feed_v2_hide_disliked_true_page_0.json`). There is no query parameter that changes it |
| `POST /api/feed/v3` | **`limit` in the body, maximum 100** | the bundle sends `limit` as a **body** field, and the working third-party extension records the cap as measured: `const BULK_LIBRARY_PAGE_SIZE = 100; // /api/feed/v3 rejects limit > 100 (verified 2026-09)` (`scratchpad/extracted/BetterSuno/background.js:43`). The client encodes `FEED_LIMIT_MAX = 100` and clamps (`lib/api.js:149-153`, `:2267-2270`) |

> **Stated precisely, because the honesty bar here is high:** v3's `limit: 100`
> cap is **evidence-backed from the shipped bundle plus a third-party
> extension's own verification note — not live-verified by this project.** No
> authenticated capture of `POST /api/feed/v3` exists in the recon. That does not
> make it a guess: a too-large `limit` is rejected, not silently truncated, so
> asking for 100 is the *safe* direction. The consequences are in
> [`KNOWN-LIMITS.md`](KNOWN-LIMITS.md).

### ❓ UNRESOLVED: `filters.user`'s id field is camelCase in one source and snake_case in another

Recorded because **nobody should have to rediscover it by guessing.**

| source | what it sends |
|---|---|
| **Suno's shipped web client** | `user: { presence: BooleanFilter.True, userId: <id> }` — **camelCase `userId`** (`suno-recon/out/chunks/1r1sqgyc3uj2o.js:5`, `getLibraryDefaultClipBrowserFilters` / `getPlaylistDefaultClipBrowserFilters`; also `2omiamzhiv6r5.js`) |
| **BetterSuno** (a working third-party extension) | `filters.user = { presence: "True", user_id: userId }` — **snake_case `user_id`** (`scratchpad/extracted/BetterSuno/background.js:2483-2488`) |

**Both are "in use" somewhere and neither can be right for the same server.** What
makes this *unresolved* rather than *decided* is that **no authenticated capture
of either shape exists in the recon**, and the bundle's own sibling filter uses
camelCase (`workspace: { presence, workspaceId }`) which is weak corroboration for
camelCase and nothing more.

**This extension sends no `user` filter at all**, so the conflict cannot bite it
today (`lib/api.js:2300-2308`). It is recorded because anyone adding a
"one user's public clips" filter is about to pick one of these two spellings with
no evidence to pick it by.

### The free-tier download figure

Policy says 7 lifetime (`../suno-recon/reports/FINDINGS.md:340`); the extension writes "free 0"
(`background/background.js:402`, and again at `:4941`); the code encodes
**`null`, verified: false** (`lib/api.js:1144`). **None of these is verified**
because the recon account was Premier. The code is right to refuse to substitute a
number.

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
| Zero empty catch blocks; every failure logged with diagnosable context | `background/background.js:52-54` |
| No token or key material logged, ever | `background/background.js:814`, `lib/api.js:221-244` |
| No token or key material outside `chrome.storage.session` | `background/background.js:50-51` |
| Sender validation on **every** route: `id` **and** `url` | `background/background.js:2927-2937` |
| Offscreen replies verified against the full sender envelope before they can settle a waiter | `background/background.js:3166-3183` |
| MAIN-world replies verified on **both** sides — no code string, no token in a non-`token` field | `background/background.js:2028-2048`, `content/content.js:3219-3245` |
| Host denylist enforced at construction, not at request time | `lib/api.js:1243` |
| Route table validated at construction; unknown routes refused | `lib/api.js:1212`, `:1223-1235` |
| Unwrapped content keys in an in-memory LRU **only** — never storage, never disk | `lib/drm.js:53-61` |
| `EXPORT_SETTINGS` omits token, key material and diagnostics | `background/background.js:7621` |
| Hostile filename sanitisation (a title is attacker-influenced text) | `background/background.js:3576-3597` |
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