# 🎛️ The filter catalog

Every filter this extension offers, the `SunoFilter` spec key it writes, the
**verified Suno field or route it reads**, and what it cannot do.

The engine is `lib/suno.js` (1567 lines, zero dependencies — no imports, no
network, no DOM, no `chrome.*`; it runs in the service worker, in a content
script, and under node). The spec shape is one plain object; the UI builds it in
`content/content.js:454-540` (`buildSpec`) and every surface sends it to the
worker, which calls `SunoFilter.apply` (`background/background.js:6886`).

> **Read this bit first.** The previous version of this file was built on fields
> that **do not exist on a Suno clip** — `is_disliked`, `dislike_count`,
> `num_likes`, `reaction_count`, `project_id`, `persona_id`, `remix_of`,
> `is_pinned`, `clip.is_instrumental` (`lib/suno.js:4-10`). Every filter built on
> them compared against `undefined` and silently dropped real clips. If you add a
> filter, check the field exists in recon before you add it.

---

## 🧠 The two tri-states that carry the catalog

**`liked` and `disliked`** are tri-state strings, not booleans:

| value | meaning |
|---|---|
| `'any'` | no constraint (absent) |
| `'only'` | must match |
| `'exclude'` | must NOT match |

Evaluated at `lib/suno.js:1038-1041`. Everything else in the `include.*` family is
a **three-state boolean**: `true` = only these, `false` = none of these, **absent =
no constraint** (`lib/suno.js:1049-1066`).

The UI's tri-select maps straight onto them (`content/content.js:738`):

```js
function triFlag(v) {
  if (v === 'only') return true;
  if (v === 'exclude') return false;
  return null;   // 'any' -> absent -> no constraint
}
```

---

## ❤️ Liked — the one that was catastrophically wrong

| | |
|---|---|
| **UI control** | Liked tri-select in the page dock; a green row dot in the side panel list (`side_panel.js:594-600`) |
| **Spec key** | `liked: 'only' \| 'exclude'` |
| **Reads** | **`clip.is_liked`** — *your own* like state |
| **NOT** | `upvote_count` |
| **Recon citation** | `lib/suno.js:897-899` |

```js
// is_liked is the user's OWN like state (recon-verified bool). It is
// never inferred from upvote_count.
var isLiked = boolOf(c.is_liked);
```

`boolOf` is strict — `true`, `1`, `'1'`, `'true'` only (`lib/suno.js:125-127`).

### 🚨 Why this is the headline

**`upvote_count` is a public count of how many people upvoted a song.**
`is_liked` is a boolean about *your* account. They are different things.

The old engine conflated them, which is exactly why **"liked only" matched 100% of
the library** — in a personal library essentially every clip has at least one
upvote, so the filter matched everything and looked like it was working.

`lib/suno.js:122-124` warns about this by name:

> Strict truthiness for recon-verified BOOLEAN fields. `upvote_count > 0` is
> deliberately NOT treated as a like: those are different things (the old engine
> conflated them and "liked" every clip other people upvoted).

There is also a separate, independent filter for the actual upvote count:
`upvotesMin` / `upvotesMax`. **Use that one** if you want "songs with ≥10 upvotes".

The inverse filter is `include.unliked: true` — *"only clips you have NOT liked"*
(`lib/suno.js:1059-1060`; UI hint at `content/content.js:1107`).

---

## 👎 Downvoted — no clip field, but the server filters on it, so one walk answers it

| | |
|---|---|
| **UI control** | Downvoted tri-select; a red row dot (`side_panel.js:601-607`) |
| **Spec key** | `disliked: 'only' \| 'exclude'` |
| **Reads** | **`is_disliked` on the stored clip row**, stamped by the crawl from the server-side filter it actually asked for |
| **Recon citation** | `lib/suno.js:864-868`, `:901-902`; `lib/api.js:167-179`, `:2295-2308`; `background/background.js:6327-6329` |

### The hard truth, unchanged

**Suno still exposes no per-clip dislike field.** There is no `is_disliked` and no
`dislike_count` on a clip that comes off the wire. `lib/suno.js:901-902` will
*accept* one — as a caller-supplied value, alongside the diffed id set:

```js
var dislikes = idSet(ctx.dislikedIds);
var isDisliked = dislikes[id] === true || c.disliked === true || boolOf(c.is_disliked);
```

The doc comment immediately above it (`lib/suno.js:864-868`) says why:

> `dislikedIds` Set/array of ids the caller diffed out of the feed
> *(disliked state is NOT a clip field)*

### What changed: the filter moved server-side

`/api/feed/v3` takes a **tri-state `disliked` filter whose values are strings** —
`"True" | "False" | "Any"`, the bundle's `BooleanFilter`
(`lib/api.js:167-179`, `:2295-2308`). So the server can be asked for exactly the
disliked rows, and the crawl **stamps that verdict onto every clip it stores**:

```js
const stamped = clips.map((clip) => ({ ...clip, is_disliked: verdict }));
```

— `commitPage`, `background/background.js:6680-6700` (the stamp at `:6682`).
It is stamped for **both** filter
directions, because the server did the filtering: a `'False'` walk can only
contain non-disliked clips and a `'True'` walk can only contain disliked ones.

**The consequence is that this filter is now exact, and it costs one walk, not
two.** The old two-pass symmetric difference existed only because Suno had no
per-clip dislike field *and* no filter for it; the filter is why the difference is
no longer needed at any point in the crawl.

> **What the "roughly doubles sync time" warning was actually describing, and what
> replaces it.** The honest tradeoff now is not *"dislikes are expensive"* but
> **"which mode you are asking for."**
>
> | `dislikedMode` | walks | what you can trust |
> |---|:--:|---|
> | `exclude` (the default) | **1** — `filters.disliked:'False'` | `disliked:'exclude'` is **exact**. Rows stamped `is_disliked:false`; there are simply no disliked rows in the index |
> | `include` | **1** — `filters.disliked:'Any'` | **nothing about dislikes is knowable.** This walk cannot classify rows it never filtered on, so `dislikedCount` stays `null` — reported as *unknown*, never as `0` |
> | `both` | **2** — `'False'` for the library, then `'True'` for the disliked id set | both directions exact, and the count is a real number |
>
> **So the two-crawl cost is real only for `both`**, which is the one mode that
> genuinely needs to see the disliked rows. It is no longer the default advice for
> "I want a dislike filter" — `exclude` gives you that for free, and it is the
> default for that reason (`DISMISSED_FILTER_BY_MODE`,
> `background/background.js:362`, `dislikedMode: 'exclude'` at `:773`).
>
> One latent bug went with the two-pass shape: **`maxPages` was shared across
> both passes**, so pass B was silently truncated to whatever pass A left over
> (`lib/api.js:2194-2202`). One walk removes that by construction.

### Trust flag — narrower than it was

`cursor.dislikedApproximate` (`background/background.js:7020-7029`, published on
every reply at `:7217`, `:7274` and `:5782`) is set when a `'True'` walk did not finish for **every**
project — a cancelled or partial phase 2 makes the id set a **partial** set, and
that is what gets reported. It no longer means *"the diff could not be computed"*,
because there is no diff.

Full mechanics: [KNOWN-LIMITS, section 5](KNOWN-LIMITS.md).

---

## 📁 Workspaces (projects)

| | |
|---|---|
| **UI control** | multi-select over fetched projects, plus an *include unassigned* checkbox (`content/content.js:936-952`) |
| **Spec key** | `projects: string[]` + `includeUnassigned: boolean` |
| **Reads** | `GET /api/project/me` (names) and `GET /api/project/feed` (membership) |
| **Recon citation** | `lib/api.js:1086-1087`, `background/background.js:5581` |

### A workspace IS a project

The default project is literally:

```json
{"id": "default", "name": "My Workspace"}
```

The id is the string `default` (`lib/suno.js:31`, `DEFAULT_PROJECT_ID`); the label
shown is `My Workspace` (`lib/suno.js:32`, `UNASSIGNED_LABEL`).

### 🚨 Suno has NO project field on a clip

`background/background.js:5581-5583` is the statement of record:

> Which workspace (project) a clip belongs to. Suno has NO project field on a
> clip; membership is joined from the project feed, and `default` is named
> "My Workspace". This is the only correct basis for a per-workspace filter.

So membership is a **client-side join**, built once per sync from
`/api/project/feed` (`background/background.js:6244-6278`, shape
`{items:[{type,added_at_ms,clip}], next_cursor}`) and **stamped onto each clip row
as `projectIds`** by `SunoAPIClient.hydrate` (`lib/api.js:2884-2916`), which is what
the engine reads first (`lib/suno.js:905-908`). `ctx.projectIdsById` is a supported
alternative the engine also accepts (`lib/suno.js:197-207`); this worker does not
supply it, because the row already carries the join.

Consequences:
- **Clips in no project land in `default`** and are counted there in facets
  (`lib/suno.js:1187-1194`).
- **`includeUnassigned` defaults to `true`** (`lib/suno.js:466-468`) — *"Default
  true: picking projects must never silently drop the unassigned bucket from a
  mass download."* Turn it off if you want strict project membership.
- If `/api/project/feed` fails, the sync warns and continues
  (`background/background.js:6262-6277`) and **every clip reads as unassigned**.
- `playlist` is a **search synonym for `project`**, not the same thing
  (`lib/suno.js:85`) — playlists are a different surface entirely
  (`/api/playlist/me`, `lib/api.js:1088`) and are not joined into membership.

### 🚨 Collaborative workspaces do not exist in prod

`collab-workspaces` is a **staging-only** server flag (`../suno-recon/reports/FINDINGS.md:219`)
with **no known API surface**. There is nothing in the verified 23-route table and
nothing in the recon bundle. There is no collaborative-workspace filter here
because there is no such concept in the product yet. **Say so plainly to anyone
who asks for it.**

---

## 🤖 Model generation

| | |
|---|---|
| **UI control** | model multi-select, populated from live facet counts |
| **Spec key** | `models: string[]` (taxonomy ids) and/or `modelNames: string[]` (raw `model_name` strings) |
| **Reads** | **`model_name` first, then `major_model_version`** |
| **Recon citation** | `lib/suno.js:40-62`, `:893-895` |

### The full taxonomy

`lib/suno.js:49-62`. Aliases are recon-observed values; an alias ending in `:` is
a **prefix match**, which is how every custom model is caught.

| id | label | aliases |
|---|---|---|
| `v6` | v6 | `v6`, `v6-wild`, `chirp-hawk`, `chirp-hawk-wild` |
| `v6-mini` | v6 mini | `v6-mini`, `chirp-goose` |
| `v5.5` | v5.5 | `v5.5`, `chirp-fenix` |
| `v5` | v5 | `v5`, `chirp-crow` |
| `v4.5plus` | v4.5+ | `v4.5plus`, `v4.5+`, `chirp-bluejay` |
| `v4.5` | v4.5 | `v4.5`, `chirp-auk`, `chirp-auk-turbo` |
| `v4` | v4 | `v4`, `chirp-v4` |
| `v3.5` | v3.5 | `v3.5`, `chirp-v3-5` |
| `v3` | v3 | `v3`, `chirp-v3-0` |
| `remaster` | Remaster | `remaster`, `chirp-halibut` |
| `custom` | Custom | `custom`, **`chirp-custom:`** (prefix) |
| `unknown` | **Unknown / legacy** | `unknown` |

Model keys cross-checked against the recon: v6 = `chirp-hawk`, v6-wild =
`chirp-hawk-wild`, v6-mini = `chirp-goose` (`../suno-recon/reports/LIVE-2026-09-30.md:71-75`);
`chirp-halibut` for remaster (`../suno-recon/reports/THIRD-PARTY-2026-09-30.md:140-143`).

### 🚨 `major_model_version` can be the empty string

This is why precedence matters (`lib/suno.js:44-48`):

> Precedence: `model_name` wins over `major_model_version` because it names the
> exact checkpoint, while the version tag is coarse AND **is frequently the EMPTY
> STRING** (recon-observed) — never assume it is non-null.

`lib/suno.js:893` makes it explicit in code: `// may be "" — never assume non-null`.
And `model_name` is sometimes `"chirp-chirp"`, outside the documented taxonomy
(`lib/suno.js:229-231`).

**Which is exactly why `unknown` is a real, selectable family.** Unknown data maps
to `unknown` (`lib/suno.js:250`) rather than dropping the clip. The option is
labelled "Unknown" in the UI — read it as *unknown / legacy*. A user filtering
"everything made before v6" needs this bucket, because a huge amount of a real
library lands in it.

`isCustomModel` is a separate convenience flag, prefix-matched on `model_name`
(`lib/suno.js:973`), but there is **no clip boolean** — see KNOWN-LIMITS, section 9.

---

## 🔎 Search: the `parseQuery` grammar

The search box is not a plain substring field. It goes through
`SunoFilter.parseQuery` (`lib/suno.js:693-786`), and the UI hands the parsed terms
to the spec verbatim (`content/content.js:463-477`); the stems term at `:488-489`
and the explicit-id list just below it.

### Operators

| syntax | meaning |
|---|---|
| `word` | bare term, searched across title + style/tags + prompt (+ lyrics) |
| `"quoted phrase"` | one term, spaces and all |
| `title:foo` | restrict to one field |
| `-foo` / `!foo` | **negate** — one hit rejects the clip |
| `OR` / `&&` | case-**sensitive** |
| `AND` / `\|\|` | case-**sensitive** |

> **Operators are case-sensitive on purpose** (`lib/suno.js:682-684`), so ordinary
> words like `and` or `or` inside a title are not eaten as operators.

### Fields

`lib/suno.js:79-87`:

| canonical | synonyms |
|---|---|
| `title` | `name` |
| `style` | `styles`, `genre`, `genres`, `tags` |
| `lyrics` | `words` |
| `prompt` | `prompttext`, `desc`, `description` |
| `model` | `models` |
| `project` | `projects`, `workspace`, `playlist` |
| `any` | `text`, `any`, `keyword` |

Hyphens, spaces and underscores are stripped before lookup
(`canonField`, `lib/suno.js:670-673`), so `prompt_text` resolves to `prompt`.

### Real examples

| query | does |
|---|---|
| `"midnight drive"` | one term, spaces preserved — title OR style OR prompt |
| `title:"blue hour"` | phrase, title only |
| `style: "dream pop" -metal` | dream-pop style AND not anywhere "metal" |
| `lyrics:highway` | lyric text only (works only for clips that have it) |
| `prompt:analog tape` | prompt text only |
| `model:v6` | the resolved model family, id, label or `model_name` |
| `project:"My Workspace"` | unassigned bucket; matches `default my workspace unassigned` (`lib/suno.js:553-556`) |
| `dream OR synth` | either |
| `a OR b title:x` | reads as `(a OR b) AND title:x` (`lib/suno.js:702-706`) |
| `!instrumental` | exclude anything containing the word |

### Two subtleties worth knowing

**Unparseable fragments are never swallowed.** An unknown field prefix or an empty
value keeps the fragment searchable with field `any` and its original text in
`raw` (`lib/suno.js:689-691`, `:760-767`). A query is never silently weaker than
it looks.

**Mixed AND/OR keeps exact grouping.** `groups` takes precedence over the flat
`terms` list (`lib/suno.js:594-628`), so no operator is dropped on the round trip.
`any` is set only when the whole query is a single OR group (`lib/suno.js:783`).

**Negation is global AND-NOT** — a negated hit rejects the clip in *both* AND and
OR groups (`lib/suno.js:588-593`). There is no `OR` that can rescue a negated term.

### `spec.text` vs `spec.terms` — do not confuse them

`spec.text` is a **plain substring** over title + tags/style + prompt (+ lyrics),
with `textMode: 'any' | 'all'` (`lib/suno.js:574-586`). `spec.terms` is the parsed
query. When terms exist, `text` is ignored (`lib/suno.js:1079-1092`) because
`parseQuery` keeps the *raw* query in `text`, including `-term` and `field:`.

The side panel uses the simple path — `spec.textMode = 'any'`
(`side_panel.js:696-703`) with a 50-row page (`side_panel.html:359`). The page dock
uses the full parser.

---

## 🎚️ Every other filter

| UI control | Spec key | Verified field / route | Caveat |
|---|---|---|---|
| **Instrumental** | `include.instrumental: true\|false` | `metadata.make_instrumental` | ⚠️ **MAY BE ABSENT** on vocal clips; absence means false (`lib/suno.js:922-925`) |
| **Remixes** | `include.remixes: true\|false` | `metadata.is_remix`, `clip.is_remix` | |
| **Trashed** | `include.trashed: true\|false` | `clip.is_trashed` | An empty spec **no longer hides these** (`lib/suno.js:1497-1502`) |
| **Contests** | `include.contests: true\|false` | `clip.is_contest_clip` | |
| **Has hook** | `include.hooks: true\|false` | `clip.has_hook` | |
| **Uploads** | `include.uploads: true\|false` | `metadata.type !== 'gen'`, `source_type === 'upload'`, `clip.is_upload` | Only `'gen'` was ever observed in recon (`lib/suno.js:915-920`) |
| **AI generated** | `include.generated: true\|false` | `metadata.type === 'gen'` | same |
| **Public** | `visibility: 'public'\|'private'` | `clip.is_public`, `clip.is_hidden` | `private` means "public **and** not hidden is excluded" (`lib/suno.js:1046-1047`) |
| **Status** | `status: 'complete'\|'pending'` | `clip.status` | `complete`, `completed`, `finished` **or empty** all count as complete (`lib/suno.js:935-936`) |
| **Date from / to** | `createdAfter`, `createdBefore` | `clip.created_at` | ISO-8601 with ms + `Z`, or epoch ms (`toMs`, `lib/suno.js:136-147`) |
| **Duration min / max** | `durationMin`, `durationMax` | `clip.duration` | ⚠️ **type unverified** — see below |
| **Plays min / max** | `playsMin`, `playsMax` | `clip.play_count` | |
| **Upvotes min / max** | `upvotesMin`, `upvotesMax` | `clip.upvote_count` | a **public count**, not your like state |
| **Clip ids** | `ids.include[]`, `ids.exclude[]` | — | one paste box; `content/content.js:1020-1044` |
| **Batch index** | `batchIndex` | `clip.batch_index` | the Nth item of a generation run |
| **Stems** | a `terms` entry `{field:'any', value:'stems'}` | 🚫 **no field exists** | a literal text search; deliberate approximation |
| **Raw model name** | `modelNames: string[]` | `clip.model_name` | exact-match, case-insensitive |

### 🎚️ BPM: a real field, deliberately not a filter

`normalize()` returns `bpm` on every record (`lib/suno.js:952-956`) — the first of
`clip.bpm` / `metadata.bpm` / `metadata.tempo_bpm` that coerces to a non-zero
number. **It reaches tags, filenames and the `.json` sidecar.**

**There is no BPM filter, and there will not be one.** `normalizeSpec()` has no bpm
predicate and no numeric range, and the comment above `normalize`
(`lib/suno.js:857-863`) says exactly why:

> `bpm` is on every record but is deliberately NOT filterable: there is no bpm
> predicate or numeric range in `normalizeSpec()`. No recon-verified clip payload
> carries a tempo field — tempo is computed client-side from decoded audio — so
> `bpm` is 0 on essentially every record from the feed. Do not add a BPM range
> filter here: it would match nothing, and the field being usually-0 is the
> absence of data, not a bug to filter around.

So if you see a BPM **tag**, the worker measured it client-side through the
offscreen document (`sunoAnalyze`) because the feed carried nothing. A BPM
**filter** would filter on a field that is 0 for every record Suno sends. Tempo is
a tag, not a facet.

### ⏱️ Duration: the field is there, its type is not

`lib/suno.js:149-153`, verbatim:

> `duration` is recon-verified to **EXIST** but its type is **NOT** verified.
> Accept number-of-seconds and "m:ss" / "h:mm:ss" strings so one code path covers
> every observed payload shape instead of NaN-ing an entire facet.

`parseDuration` (`lib/suno.js:154-167`) therefore accepts a number, a numeric
string, `"3:33"`, and `"1:02:11"`. Both seconds-as-number and `mm:ss` work.

**The risk is a silently wrong range filter, not a crash.** If Suno ever switches
to milliseconds, `durationMin: 60` would mean 60 ms and everything passes.

---

## 🔁 Legacy boolean aliases → tri-state

The old engine took booleans whose **names did not match their polarity**. The
mapping table is `lib/suno.js:307-341`; the fold happens once, in
`normalizeSpec` (`lib/suno.js:393-528`).

| legacy key | `true` | `false` |
|---|---|---|
| `likedOnly` | `liked:'only'` | *(no constraint)* |
| `liked` (boolean) | `liked:'only'` | *(no constraint)* |
| `dislikedOnly` | `disliked:'only'` | *(no constraint)* |
| `excludeDisliked` | `disliked:'exclude'` | — |
| **`includeDisliked`** | **`disliked:'any'`** | **`disliked:'exclude'`** |
| `skipDislikes` | `disliked:'exclude'` | `disliked:'any'` |
| `disliked` (boolean) | `disliked:'only'` | *(no constraint)* |
| `skipUploads` / `excludeUploads` | `include.uploads=false` | — |
| `skipInstrumentals` | `include.instrumental=false` | — |
| `skipRemixes` / `excludeRemixes` | `include.remixes=false` | — |
| `skipTrashed` / `excludeTrashed` | `include.trashed=false` | — |
| `skipUnliked` | `include.unliked=false` | — |
| `unlikedOnly` | `include.unliked=true` | — |
| `skipHooks` / `excludeHooks` | `include.hooks=false` | — |
| `withHook` / `hasHook` / `hooksOnly` | `include.hooks=true` | — |
| `skipContests` / `excludeContests` | `include.contests=false` | — |
| `contestsOnly` | `include.contests=true` | — |
| `skipGenerated` / `excludeGenerated` | `include.generated=false` | — |
| `modelV6` / `modelV6Mini` / `modelV55` / `modelV5` / `modelV45plus` / `modelV45` / `modelV4` / `modelV35` / `modelV3` / `modelRemaster` / `modelCustom` | `models:['<family>']` — unioned when combined | — |
| `allV6Models` | `models:['v6','v6-mini']` | — |
| `keyword` / `q` / `search` | `text:<string>` | — |
| `matchAll` | `textMode:'all'` | — |
| `minPlays` / `maxPlays` | `playsMin` / `playsMax` | — |
| `minUpvotes` / `maxUpvotes` | `upvotesMin` / `upvotesMax` | — |
| `minDuration` / `maxDuration` | `durationMin` / `durationMax` | — |
| `includeIds` / `excludeIds` | `ids.include` / `ids.exclude` | — |
| `workspace` / `projectId` | `projects:[id]` (`'default'` = unassigned) | — |
| `after` / `since` / `newerThan` | `createdAfter` | — |
| `before` / `until` / `olderThan` | `createdBefore` | — |
| `newestFirst` / `oldestFirst` | `sort:'newest'` / `sort:'oldest'` | — |
| `sort:'recent'\|'play_count'\|'most_played'\|'most_liked'\|…` | canonical key (`lib/suno.js:377-391`) | — |

### 🚨 The inverted-polarity bug

`lib/suno.js:302-306` is the whole story:

> The old engine took booleans whose names did not match their polarity:
> `skipDislikes = skipDislikes || !includeDisliked` made the DEFAULT "hide
> dislikes" and only let `includeDisliked: true` win by accident.

**`includeDisliked: true` used to EXCLUDE dislikes.** The name says "include", the
old code excluded. It only behaved correctly by accident of the `||` chain.

The new code is explicit about the polarity (`lib/suno.js:407-410`):

```js
// NOTE the polarity: includeDisliked === true means "do NOT hide dislikes".
disliked = boolFlag(s, ['includeDisliked']) ? 'any' : 'exclude';
```

**An explicit new-style tri-state always wins** and is never overwritten by a
legacy boolean (`lib/suno.js:343-344`, enforced by the ordering in
`normalizeSpec`). Unknown keys are preserved on the result and never throw
(`lib/suno.js:393-394`).

---

## 🎛️ The 24 presets

`PRESETS` at `lib/suno.js:1496-1546`. Available as `SunoFilter.PRESETS` (`:1548`) and
mirrored onto the instance (`lib/suno.js:1550-1556`) so content scripts find it.

| preset | spec | what it does |
|---|---|---|
| `ALL` | `{}` | **no constraints at all** |
| `LIKED_ONLY` | `{liked:'only'}` | |
| `DISLIKED_ONLY` | `{disliked:'only'}` | exact — `is_disliked` is stamped per clip |
| `NO_DISLIKES` | `{disliked:'exclude'}` | |
| `V6` | `{models:['v6']}` | |
| `V5_PLUS` | `{models:['v6','v6-mini','v5.5','v5']}` | "v5 **plus** everything newer" |
| `V6_MINI` | `{models:['v6-mini']}` | |
| `CUSTOM_MODELS` | `{models:['custom']}` | every `chirp-custom:*` |
| `INSTRUMENTAL` | `{include:{instrumental:true}}` | |
| `REMIXES` | `{include:{remixes:true}}` | |
| `NO_TRASHED` | `{include:{trashed:false}}` | |
| `TRASHED` | `{include:{trashed:true}}` | |
| `UNASSIGNED` | `{projects:['default']}` | the `My Workspace` bucket |
| `PENDING` | `{status:'pending'}` | still generating |
| `COMPLETE` | `{status:'complete'}` | |
| `PUBLIC_ONLY` | `{visibility:'public'}` | |
| `NO_UPLOADS` | `{include:{uploads:false}}` | |
| `UNLIKED` | `{include:{unliked:true}}` | |
| `WITH_HOOKS` | `{include:{hooks:true}}` | |
| **`MOST_PLAYED`** | `{sort:'plays',order:'desc'}` | |
| **`MOST_LIKED`** | `{sort:'upvotes',order:'desc'}` | |
| `RECENT_30_DAYS` | *getter* | `{createdAfter: now−30d, sort:'newest'}` |
| `V6_MODELS` | `{models:['v6']}` | legacy alias of `V6` |
| `V5_AND_V6` | `{models:['v6','v6-mini','v5']}` | legacy alias |

### 🚨 `MOST_PLAYED` and `MOST_LIKED` were empty objects

`lib/suno.js:1515-1517`, verbatim:

> The old presets were `{}` — **identical to ALL**, i.e. no sorting at all.

```js
MOST_PLAYED: { sort: 'plays',   order: 'desc' },
MOST_LIKED:   { sort: 'upvotes', order: 'desc' },
```

Picking "most played" in the old build returned the library in whatever order it
was stored. **A "top tracks" preset that does not sort is worse than no preset**,
because it looks like it worked.

`RECENT_30_DAYS` is a **getter**, not a literal (`lib/suno.js:1542-1546`), because
a literal `Date.now()` evaluated at script load goes stale in a long-lived service
worker. Nice catch; don't "simplify" it back.

### Note what `ALL` now means

`ALL` is `{}` — **trashed clips are NOT hidden** (`lib/suno.js:1497-1502`). The old
engine dropped them implicitly, which silently shrank mass downloads. Use
`NO_TRASHED` to exclude them explicitly.

---

## 📐 Sorting

`SORT_KEYS = ['newest','oldest','plays','upvotes','title','duration']`
(`lib/suno.js:815`). Six keys, canonical (`canonSort`, `lib/suno.js:387-391`).

| key | default order | notes |
|---|---|---|
| `newest` | desc | by `created_at` |
| `oldest` | asc | |
| `plays` | desc | by `play_count` |
| `upvotes` | desc | by `upvote_count` — **not** your likes |
| `title` | asc | case-insensitive |
| `duration` | desc | unknown durations sort **last** in ascending (`lib/suno.js:808-812`) |

Comparators are all ascending in their key; `sort()` applies the sign
(`lib/suno.js:798-813`, `:1277-1297`). **Ties fall back to input order**, which is
stable — that is what stops pagination from shuffling equal rows between pages
(`lib/suno.js:795-796`).

Aliases (`lib/suno.js:377-385`): `recent`→`newest`, `old`→`oldest`,
`play_count`/`plays`/`popular`/`most_played`→`plays`,
`upvote_count`/`upvotes`/`likes`/`most_liked`→`upvotes`,
`name`/`title`/`alphabetical`→`title`, `length`/`duration`→`duration`.

Note `most_played` and `most_liked` are **sort aliases**, not the empty presets
they used to be. Different namespace, same words — a real trap.

---

## 🧮 Facets

`SunoFilter.facets` (`lib/suno.js:1156-1271`) powers the counts next to every
filter:

- `counts` — liked, disliked, complete, instrumental, remix, trashed, public,
  unassigned
- `models` — only families actually present, most clips first, taxonomy order for
  ties
- `projects` — declared projects first (they carry real names), then any
  undeclared id seen in the data
- `genres` — the top **40** comma-separated tokens across `metadata.tags` +
  `metadata.style`, **deduplicated per clip** so one clip reading
  `"pop, pop, dream"` cannot out-vote 40 genuinely different tracks
  (`lib/suno.js:1150-1155`, `:1255-1257`; `MAX_GENRES = 40`)
- ranges — `createdMin/Max`, `durationMin/Max`, `playMax`

---

## 🧱 How a filter actually gets applied

```
UI (content/content.js buildSpec, or side_panel.js, or popup.js)
  │   builds a plain SunoFilter spec object
  ▼
chrome.runtime.sendMessage { type:'GET_CLIPS' | 'DOWNLOAD_START', payload:{spec} }
  │   validateSender: sender.id === runtime.id AND sender.url allowlisted
  ▼
background/background.js  queryClips() (6876) / resolveBatchClips() (4869)
  │   ctx = { projects, dislikedIds }
  ▼
SunoDB.clips.all()                        IndexedDB, the local index
  │
  ▼
SunoFilter.apply(clips, spec, ctx)        lib/suno.js:1133-1145
  │   normalizeSpec (fold legacy aliases) -> per-clip matches()
  ▼
SunoFilter.sort(clips, key, dir)          lib/suno.js:1280-1297
  ▼
SunoFilter.paginate(clips, {offset,limit})  lib/suno.js:1299-1316
  │
  ▼
GET_CLIPS reply -> UI
```

`apply` deliberately does **not** sort or page (`lib/suno.js:1128-1132`) so a
caller can chain them without double-applying `spec.limit`.

`describe(spec)` (`lib/suno.js:1322-1394`) renders the one-line human summary —
`Liked only · v6 · 2 projects · style:"dream pop" · not any:"metal"` — and it is
what the batch plan stores as its description (`background/background.js:4887`, carried into the plan),
so you always know what a saved batch was actually going to do.

---

**Next:** [DOWNLOAD-LADDER](DOWNLOAD-LADDER.md) · [ARCHITECTURE](ARCHITECTURE.md) ·
[RECON-NOTES](RECON-NOTES.md) · [KNOWN-LIMITS](KNOWN-LIMITS.md) ·
[← README](../README.md)