# MIGRATION.md — how the 1.0.0 lineage was folded into the 6.0.1 rewrite

**This file exists only on the `feat/6.0.1-rewrite` branch.** It is not part of
the extension build and is not loaded by Chrome.

## What happened, in one paragraph

The repository's default branch (`main`) held a sanitized, renamed ancestor of
this extension: `Suno Power Exporter`, `version 1.0.0`, one commit
(`22958b68`), ~5,400 lines, 322,992 bytes. This build is `Suno Master
Utility`, `version 6.0.1`, ~92,000 lines, 4,484,824 bytes. The ancestor is a
sub-par predecessor of the same product — same `/api/mango/rights` DRM lineage,
same purpose — so overwriting it would be an upgrade in kind. But a blind
overwrite would have destroyed ~700 lines of tests, the repository's only
`package.json`, and a 782-line feed crawler that the new build does **not**
contain. Those are preserved here, verbatim, under `legacy-1.0.0/`.

## Ground rules observed

- `main` was **not** modified. Its HEAD is still `22958b68`, verified before and
  after every push.
- No force-push, no branch deletion, no tag deletion, at any point.
- Nothing was edited. The 42 files of the 6.0.1 build are byte-identical to the
  working tree that produced them, and all 33 preserved ancestor files are
  byte-identical to the blobs on `main` (verified by `git hash-object` against
  `git rev-parse 22958b68:<path>`; 33 compared, 0 mismatches).

## The preserved tree

`legacy-1.0.0/` is a byte-for-byte export of `main` at `22958b68`, in its
original `extension/` + `docs/` + root layout, so its relative imports still
resolve. **The ancestor's test suite runs green in place:**

```
$ cd legacy-1.0.0/extension && node --test tests/*.test.js
ℹ tests 31
ℹ pass 31
ℹ fail 0
```

That is the reason the whole ancestor tree was preserved rather than just the
three interesting files: `tests/api.test.js` imports `../lib/api.js` and
`tests/feed.test.js` imports `../lib/feed.js`, so pulling the tests across
*without* the implementation they test would have shipped 31 permanently red
tests. Preserving the tree keeps them meaningful and passing.

## What is superseded, with evidence

| Ancestor artifact | Local counterpart | Verdict |
|---|---|---|
| `extension/background.js` (8,480 B) | `background/background.js` (250,298 B) + `offscreen/` | Superseded — ~30× larger, plus an offscreen audio pipeline the ancestor had no concept of |
| `extension/lib/api.js` (17,284 B) | `lib/api.js` (119,230 B, 3,151 lines) | Superseded |
| `extension/lib/feed.js` (28,391 B) | `lib/api.js#iterateFeed` | **Partially** — see below |
| `extension/lib/storage.js` | `lib/db.js` (2,964 lines, IndexedDB w/ v1→v2 migration) | Superseded |
| `extension/lib/m4a-decrypt.js` | `lib/drm.js` (1,808 lines) | Superseded |
| `extension/lib/tagging.js` | `lib/tagger.js` (2,126 lines) | Superseded |
| `extension/lib/engine.js` | `lib/audio.js` + `background/` export pipeline | Superseded |
| `extension/controls/` (52,127 B) | `popup/` + `options/` + `side_panel.*` | Superseded by design — a persistent controls window replaced by three first-class surfaces |
| `extension/lib/utils.js`, `lib/debug.js` | inlined into `lib/api.js` (e.g. `normalizeLogger`, `redact`, `safeStringify`) | Superseded |

Licence and authorship: **no conflict.** The ancestor carries no `LICENSE`
file at all, and its own `README.md` line 144 states *"No license has been
selected in this archival release."* Its single commit is authored by
`Nsomnia`, i.e. the same owner as this build, whose `manifest.json` names
`曲元 & Antigravity`. Nothing third-party is being relicensed. The only licence
obligations in play are the two vendored encoders, and their notices travel
with them in `vendor/`.

## What is genuinely NOT covered by 6.0.1

These ancestor capabilities have **no** local equivalent. They are preserved
because they are real capability or real coverage, not because they are
current.

### 1. `lib/directory.js` — File System Access output (5,784 B)

The ancestor persists a user-selected directory handle in IndexedDB and writes
exports straight into it. The 6.0.1 build has **no File System Access code at
all** — `showDirectoryPicker`, `FileSystemDirectoryHandle` and
`getDirectoryHandle` appear nowhere in the tree, and its output path is
`chrome.downloads` (`manifest.json` requests `downloads`;
`background/background.js` builds a relative path template at line 2520 and
waits on `chrome.downloads.onChanged` for completion at line 2582).

This is a deliberate product difference, not an oversight: `downloads` with an
observed-completion path survives service-worker restarts, which a live
directory handle does not. But if "write into a folder I pick" is wanted back,
`legacy-1.0.0/extension/lib/directory.js` is the working starting point, and
`legacy-1.0.0/extension/tests/directory.test.js` is its regression test
(persists a handle through IndexedDB, migrates legacy records).

### 2. `extension/tests/` — the only test coverage (706 lines, 31 tests)

The 6.0.1 build ships **no tests and no test runner**; `.gitignore` even says
*"there is no package.json and no toolchain."* All 31 ancestor tests are
preserved and pass. They test the **1.0.0 implementation**, not 6.0.1 — they
are a spec of the old behaviour, and a starting point, not a description of
the current one.

**Marked as needing updating:** every one of the five files. Nothing was adapted,
because adaptation means rewriting 31 assertions against an API whose shape
changed (`lib/api.js` went from `fetchLibrary()`/`pageFetch()` functions to a
`SunoAPI` class with an `iterateFeed()` async generator and an endpoint
allowlist). Rewriting them against a moving target is a real project, not a
migration step, and a half-done adaptation would have been worse than an
honest red-to-do marker. Priorities if someone picks this up:

- `api.test.js` — `Retry-After` parsing, retry/backoff counting, workspace
  pagination via `current_page`/`num_total_results`, "reject an incomplete crawl
  rather than return partial clips", abort during `pageFetch`. All of these
  behaviours still exist in 6.0.1 (`parseRetryAfterMs` at `lib/api.js:237`,
  `jitteredBackoffMs` at `:226`, `projectMe` at `:2135`, `signal` handling in
  `iterateFeed` at `:1960`) — the tests just need new call sites.
- `feed.test.js` — see below; needs a target decision before it can be ported.
- `mp3.test.js` — 20 lines, asserts an undeclared auth helper is gone. Cheap.
- `storage.test.js` — settings migration. 6.0.1 stores in IndexedDB
  (`lib/db.js`), not `chrome.storage`, so this is a genuine rewrite.
- `directory.test.js` — see File System Access above.

### 3. `extension/package.json` (265 B)

Kept as-is. Its scripts reference the *ancestor's* paths
(`for f in background.js content/content.js controls/controls.js lib/*.js`) and
so will not check the 6.0.1 tree as written. It is **not** merged into the build
root: doing so would put a `type: module` package boundary in front of the
extension's classic content scripts and contradict the `.gitignore` comment
that documents the tree as deliberately toolchain-free. Bringing it across is
only meaningful together with a decision to adopt a toolchain.

### 4. `extension/lib/feed.js` — cursor-protocol crawler (782 lines)

**This one is a real protocol difference, not dead code, and it is the most
interesting thing in the ancestor.**

`feed.js` implements a *cursor* feed: `has_more`, `next_cursor`, `next_page`,
`num_total_results`, with an explicit state machine (`getFeedPaginationState`,
`lib/feed.js:186`) that treats `has_more: false` as terminal, refuses a
repeated cursor as an incomplete crawl, and compares collected count against
the advertised total.

> ### 🔄 The route changed AGAIN at 6.2.0. Read this before reading the comparison below.
>
> **Everything in the rest of this subsection describes the build as it stood at
> 6.0.1**, and the 6.0.1 `lib/api.js` no longer exists — the numbers below are that
> build's line numbers, kept because this is a migration record and the history is
> not being rewritten. For **current** behaviour read
> [`ARCHITECTURE.md` § the cursor contract](docs/ARCHITECTURE.md) and
> [`KNOWN-LIMITS` §25–28](docs/KNOWN-LIMITS.md).
>
> The short version: `iterateFeed` **is** a cursor-protocol walker now, over
> `POST /api/feed/v3` with a `{cursor, limit, filters}` body
> (`lib/api.js:2263-2522`; rationale at `:2190-2200`). The page-integer feed,
> `STALL_PAGE_LIMIT` and the `query: { hide_disliked, page }` shape this subsection
> describes were **removed** — along with `/api/feed/v2` itself, which appears in
> **0 of 96** shipped bundle chunks and in **0** captures
> (`lib/api.js:15-30`). So **two** of the three "uncovered behaviours" listed at
> the end of this subsection have since been covered by the current build:
> cursor pagination **and** expected-total reconciliation
> (`expectedClipTotal`, `lib/api.js:2578-2586`). Only repeated-cursor stall
> detection was implemented by a different mechanism — a null `next_cursor` ends
> the walk and a repeated one is caught by name
> (`stopReason: 'stuck_cursor'`).

At **6.0.1**, `lib/api.js#iterateFeed` walked a **page-integer** feed instead:
`query: { hide_disliked, page }`, terminating on an empty-page streak
(`STALL_PAGE_LIMIT`) or `maxPages`, and reporting `{truncated, stalled, error}`
in a final summary. The cursor vocabulary was absent from the whole 6.0.1 build:

```
$ grep -rnE 'has_more|next_cursor|next_page' lib/ background/ side_panel.js \
      content/ options/ popup/ offscreen/
(no matches — zero occurrences anywhere in the 6.0.1 build)
```

`num_total_results` *was* named three times, but only in doc comments
(`lib/api.js:912`, `:914`, `:2336`) documenting the shapes of
`/api/project/me` and `/api/playlist/me`. It is never read as a value:

```
$ grep -rn num_total_results lib/ background/ side_panel.js \
    | grep -vE '^\S+:[0-9]+: *(\*|//)'
(no matches — every occurrence is inside a comment)
```

`fetchProjects` took its count from the per-project
`project.clip_count` field, and `fetchPlaylists` discarded the total
and returned the page it got. So nothing in 6.0.1 reconciled a collected count
against a server-advertised total.

Three specific ancestor behaviours were therefore uncovered **as of 6.0.1**:

1. cursor-based pagination (if any endpoint still returns cursors);
2. **expected-total reconciliation** — 6.0.1 never compares what it collected
   against a server-advertised total, so a silently truncated library can be
   reported as complete;
3. repeated-cursor stall detection — 6.0.1 detects stalls only via empty pages.

Points 2 and 3 are honesty guarantees that `docs/KNOWN-LIMITS.md` may well want
regardless of protocol. The file is preserved unmodified as the reference
implementation; nothing in the 6.0.1 build references it, so importing it
without adaptation would be dead code. It is **not** copied into `lib/`.

> 🕑 **As of 6.2.0: points 1 and 2 are closed and point 3 is closed by a different
> mechanism.** The current crawl enumerates every project from `/api/project/me`,
> walks each on `POST /api/feed/v3`, and publishes `missing`,
> `oracleApplied` and `advisory` from one builder so every surface reads the same
> numbers. The ancestor's `feed.js` is still the clearest written description of
> the cursor state machine, and still worth reading — just no longer a gap.

### 5. Smaller genuinely-uncapped items

- `extension/icons/icon256.png` (77,163 B) — 6.0.1 ships 16/48/128 only.
- `extension/_locales/en/messages.json` (188 B) — 6.0.1's `manifest.json` sets
  no `default_locale` and the UI is not internationalised.
- `docs/PRIVACY.md`, `docs/USER_GUIDE.md`, `docs/DEVELOPMENT.md` — 6.0.1's
  `docs/` covers different ground (`ARCHITECTURE`, `DOWNLOAD-LADDER`,
  `FILTERS`, `KNOWN-LIMITS`, `RECON-NOTES`). `PRIVACY.md` is the notable gap
  given how much recon material this project handles.
- `tabs` / `webRequest` / `unlimitedStorage` permissions — the ancestor
  intercepted requests to capture auth headers; 6.0.1 relays page-context
  `fetch` through a content script with a route allowlist
  (`assertRouteAllowed`, `lib/api.js:605`) instead. Fewer permissions, and
  `unlimitedStorage` is genuinely unnecessary against IndexedDB.

## Verifying this branch

```bash
# the 6.0.1 build still passes its own gate
sh scripts/check-build.sh          # expect: PASS: 77 checks, 0 failures

# the preserved ancestor tree is byte-identical to main@22958b68
git diff --stat main -- legacy-1.0.0   # expect: empty
diff -r <(git archive main | tar -xO) ... # or simply trust the hash check above

# the ancestor's tests still pass in their preserved home
cd legacy-1.0.0/extension && node --test tests/*.test.js   # expect: 31 pass
```

## Undoing

Nothing here is destructive. To remove the branch entirely:

```bash
git push origin --delete feat/6.0.1-rewrite
```

`main` is untouched at `22958b68`, so that single command restores the
repository to its exact prior state.
