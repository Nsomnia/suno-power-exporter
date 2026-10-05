/**
 * Suno Master Utility — clip normalization, filter engine, facets, query parser.
 *
 * Ground truth for every field name below comes from authenticated recon of
 * studio-api.prod.suno.com (2026-09-30). Fields that were GUESSED by the
 * previous version of this file (is_disliked, dislike_count, num_likes,
 * reaction_count, project_id, persona_id, remix_of, is_pinned,
 * clip.is_instrumental, …) are gone: they do not exist on a Suno clip, so
 * every filter built on them compared against `undefined` and silently dropped
 * real clips.
 *
 * Depends on nothing: no imports, no network, no DOM, no chrome.*. Runs in the
 * MV3 service worker, in a content script, and under node for unit tests.
 *
 * Exposure:
 *   window.SunoFilter          -> an instance of SunoFilter (content script)
 *   SunoFilter (static)        -> the class, every method mirrored as a static
 *   module.exports             -> { SunoFilter, SunoFilterClass }
 */

(function () {
  'use strict';

  /* ================================================================== *
   * constants
   * ================================================================== */

  // The unassigned bucket. Suno calls the catch-all project "default"; the UI
  // shows it as "My Workspace". Project membership is NOT a clip field — the
  // caller joins it client-side onto `clip.projectIds`.
  var DEFAULT_PROJECT_ID = 'default';
  var UNASSIGNED_LABEL = 'My Workspace';

  var MAX_GENRES = 40;

  // Recon-verified decoy: every clip carries `audio_url` pointing at
  // ".../api/forbidden". The real audio lives in `media_urls[].url`.
  var DECOY_RE = /forbidden/i;

  /*
   * Model taxonomy. `aliases` are recon-observed values of `model_name` /
   * `major_model_version`. An alias ending in ':' is a prefix match, which is
   * how `chirp-custom:<anything>` identifies a custom model.
   *
   * Precedence: `model_name` wins over `major_model_version` because it names
   * the exact checkpoint, while the version tag is coarse AND is frequently the
   * EMPTY STRING (recon-observed) — never assume it is non-null.
   */
  var MODELS = [
    { id: 'v6', label: 'v6', aliases: ['v6', 'v6-wild', 'chirp-hawk', 'chirp-hawk-wild'] },
    { id: 'v6-mini', label: 'v6 mini', aliases: ['v6-mini', 'chirp-goose'] },
    { id: 'v5.5', label: 'v5.5', aliases: ['v5.5', 'chirp-fenix'] },
    { id: 'v5', label: 'v5', aliases: ['v5', 'chirp-crow'] },
    { id: 'v4.5plus', label: 'v4.5+', aliases: ['v4.5plus', 'v4.5+', 'chirp-bluejay'] },
    { id: 'v4.5', label: 'v4.5', aliases: ['v4.5', 'chirp-auk', 'chirp-auk-turbo'] },
    { id: 'v4', label: 'v4', aliases: ['v4', 'chirp-v4'] },
    { id: 'v3.5', label: 'v3.5', aliases: ['v3.5', 'chirp-v3-5'] },
    { id: 'v3', label: 'v3', aliases: ['v3', 'chirp-v3-0'] },
    { id: 'remaster', label: 'Remaster', aliases: ['remaster', 'chirp-halibut'] },
    { id: 'custom', label: 'Custom', aliases: ['custom', 'chirp-custom:'] },
    { id: 'unknown', label: 'Unknown', aliases: ['unknown'] }
  ];

  var MODEL_LABEL = {};
  var MODEL_INDEX = {};
  for (var mi = 0; mi < MODELS.length; mi++) {
    MODEL_LABEL[MODELS[mi].id] = MODELS[mi].label;
    MODEL_INDEX[MODELS[mi].id] = mi;
  }

  // action_config.actions[].action_type -> entitlement (recon-verified enum).
  var ACTION_FIELDS = {
    like_song: 'canLike',
    dislike_song: 'canDislike',
    share_song: 'canShare',
    add_to_playlist: 'canPlaylist'
  };

  var FIELD_SYNONYMS = {
    title: 'title', name: 'title',
    style: 'style', styles: 'style', genre: 'style', genres: 'style', tags: 'style',
    lyrics: 'lyrics', words: 'lyrics',
    prompt: 'prompt', prompttext: 'prompt', desc: 'prompt', description: 'prompt',
    model: 'model', models: 'model',
    project: 'project', projects: 'project', workspace: 'project', playlist: 'project',
    text: 'any', any: 'any', keyword: 'any'
  };

  /* ================================================================== *
   * primitive coercion helpers (total: never throw)
   * ================================================================== */

  function isObj(v) { return v !== null && typeof v === 'object'; }

  function str(v) {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    try { return String(v); } catch (e) { return ''; }
  }

  function lower(v) { return str(v).toLowerCase(); }

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  // Integer or null (used for batch_index, limit, offset).
  function intOrNull(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }

  // Strict truthiness for recon-verified BOOLEAN fields. `upvote_count > 0` is
  // deliberately NOT treated as a like: those are different things (the old
  // engine conflated them and "liked" every clip other people upvoted).
  function boolOf(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  // For flags whose absence means "permissive" rather than "false".
  function boolOrTrue(v) {
    if (v == null || v === '') return true;
    return boolOf(v);
  }

  // ISO-8601 (recon format: ms precision + "Z") or epoch ms -> ms, else null.
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    var s = str(v).trim();
    if (s === '') return null;
    if (/^-?\d+$/.test(s)) {
      var n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    var p = Date.parse(s);
    return Number.isFinite(p) ? p : null;
  }

  /*
   * `duration` is recon-verified to EXIST but its type is NOT verified. Accept
   * number-of-seconds and "m:ss" / "h:mm:ss" strings so one code path covers
   * every observed payload shape instead of NaN-ing an entire facet.
   */
  function parseDuration(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
    var s = str(v).trim();
    if (s === '') return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      var n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (m) return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    var f = Number(s);
    return Number.isFinite(f) ? f : null;
  }

  function arrOf(v) {
    if (Array.isArray(v)) return v;
    if (typeof Set !== 'undefined' && v instanceof Set) return Array.from(v);
    if (v == null) return [];
    if (isObj(v) && Array.isArray(v.items)) return v.items;
    return [];
  }

  function idSet(v) {
    var out = {};
    var a = arrOf(v);
    for (var i = 0; i < a.length; i++) out[str(a[i])] = true;
    return out;
  }

  function uniqStr(v) {
    var seen = {};
    var out = [];
    var a = arrOf(v);
    for (var i = 0; i < a.length; i++) {
      var k = str(a[i]);
      if (k === '' || seen[k]) continue;
      seen[k] = true;
      out.push(k);
    }
    return out;
  }

  // Project membership when the caller keeps the id -> [project ids] join in ctx
  // instead of on the clip itself.
  function projectIdsFromCtx(ctx, clipId) {
    var map = ctx.projectIdsById;
    if (!map) return [];
    try {
      if (typeof Map !== 'undefined' && map instanceof Map) return arrOf(map.get(clipId));
      if (Object.prototype.hasOwnProperty.call(map, clipId)) return arrOf(map[clipId]);
    } catch (e) { /* hostile getter: treat as unassigned */ }
    return [];
  }

  // "YYYY-MM-DD" for describe(); total (never throws on a bad Date).
  function isoDay(ms) {
    try {
      var d = new Date(ms);
      var t = d.getTime();
      if (Number.isFinite(t)) return d.toISOString().slice(0, 10);
    } catch (e) { /* fall through */ }
    return '?';
  }

  /* ================================================================== *
   * model family resolution
   * ================================================================== */

  function matchAlias(alias, value) {
    if (!value) return false;
    if (alias.charAt(alias.length - 1) === ':') return value.indexOf(alias) === 0;
    return alias === value;
  }

  // Always returns a taxonomy id; unknown data maps to 'unknown' rather than
  // dropping the clip (recon: major_model_version is often "" and model_name
  // is sometimes "chirp-chirp", which is outside the documented taxonomy).
  function resolveModelFamily(version, name) {
    var v = lower(version).replace(/^suno[-_]?/, '').trim();
    var n = lower(name).trim();
    if (n) {
      for (var a = 0; a < MODELS.length; a++) {
        for (var b = 0; b < MODELS[a].aliases.length; b++) {
          if (matchAlias(MODELS[a].aliases[b], n)) return MODELS[a].id;
        }
      }
    }
    if (v) {
      for (var c = 0; c < MODELS.length; c++) {
        for (var d = 0; d < MODELS[c].aliases.length; d++) {
          var al = MODELS[c].aliases[d];
          if (al.charAt(al.length - 1) !== ':' && al === v) return MODELS[c].id;
        }
      }
    }
    return 'unknown';
  }

  function modelLabel(family) {
    return Object.prototype.hasOwnProperty.call(MODEL_LABEL, family) ? MODEL_LABEL[family] : family;
  }

  /* ================================================================== *
   * entitlements (server-authoritative action_config)
   * ================================================================== */

  /*
   * `action_config.actions` is the server's own statement of what the caller may
   * do with the clip, so it is read instead of guessing from flags.
   *
   * WHY canDownload defaults to true: the recon'd action enum has no "download"
   * member (add_to_playlist / like_song / share_song / dislike_song). Audio
   * comes from the media CDN, not from this list, so the absence of a download
   * action says nothing about download rights. It is only turned off if a future
   * enum member matching /download/ shows up disabled.
   */
  function readEntitlements(actionConfig) {
    var out = {
      canDownload: true,
      canLike: false,
      canDislike: false,
      canShare: false,
      canPlaylist: false
    };
    var actions = isObj(actionConfig) && Array.isArray(actionConfig.actions) ? actionConfig.actions : null;
    if (!actions) return out;
    var seen = {};
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (!isObj(a)) continue;
      var type = lower(a.action_type).trim();
      if (!type || seen[type]) continue;
      seen[type] = true;
      // `visible` and `disabled` are always present in recon captures; if a
      // future payload omits one we read it permissively.
      var allowed = boolOrTrue(a.visible) && !boolOf(a.disabled);
      if (Object.prototype.hasOwnProperty.call(ACTION_FIELDS, type)) {
        out[ACTION_FIELDS[type]] = allowed;
      } else if (type.indexOf('download') !== -1) {
        out.canDownload = allowed;
      }
    }
    return out;
  }

/* ================================================================== *
   * legacy spec aliasing
   * ================================================================== *
   * The old engine took booleans whose names did not match their polarity:
   * `skipDislikes = skipDislikes || !includeDisliked` made the DEFAULT "hide
   * dislikes" and only let `includeDisliked: true` win by accident. New code
   * uses tri-state strings; the old keys are folded in here, exactly once.
   *
   *   legacy key                        true                     false
   *   --------------------------------  ----------------------  ----------------------
   *   likedOnly                         liked:'only'             (no constraint)
   *   liked (boolean)                   liked:'only'             (no constraint)
   *   dislikedOnly                      disliked:'only'          (no constraint)
   *   excludeDisliked                   disliked:'exclude'
   *   includeDisliked                   disliked:'any'           disliked:'exclude'
   *   skipDislikes                      disliked:'exclude'       disliked:'any'
   *   disliked (boolean)                disliked:'only'          (no constraint)
   *   skipUploads / excludeUploads       include.uploads=false
   *   skipInstrumentals                 include.instrumental=false
   *   skipRemixes / excludeRemixes      include.remixes=false
   *   skipTrashed / excludeTrashed      include.trashed=false
   *   skipUnliked                       include.unliked=false
   *   unlikedOnly                       include.unliked=true
   *   skipHooks / excludeHooks          include.hooks=false
   *   withHook / hasHook / hooksOnly    include.hooks=true
   *   skipContests / excludeContests    include.contests=false
   *   contestsOnly                      include.contests=true
   *   skipGenerated / excludeGenerated  include.generated=false
   *   modelV6 / modelV6Mini / modelV55  models:['<family>']  (union when combined)
   *   modelV5 / modelV45plus / modelV45
   *   modelV4 / modelV35 / modelV3
   *   modelRemaster / modelCustom
   *   allV6Models                       models:['v6','v6-mini']
   *   keyword / q / search              text:<string>  (textMode from matchAll)
   *   minPlays / maxPlays               playsMin / playsMax
   *   minUpvotes / maxUpvotes           upvotesMin / upvotesMax
   *   minDuration / maxDuration         durationMin / durationMax
   *   includeIds / excludeIds           ids.include / ids.exclude
   *   workspace / projectId             projects:[id]  ('default' = unassigned)
   *   after/before/since/until          createdAfter / createdBefore
   *   newestFirst:true / oldestFirst    sort:'newest' / sort:'oldest'
   *   sort:'recent'|'play_count'|...    canonical sort key
   *
   * An explicit new-style tri-state ('any'|'only'|'exclude') always wins and is
   * never overwritten by a legacy boolean.
   */

  function triKey(v) {
    if (v === 'any' || v === 'only' || v === 'exclude') return v;
    if (v == null || v === '') return null;
    if (v === true || v === 1 || v === 'true' || v === '1') return 'only';
    if (v === false || v === 0 || v === 'false' || v === '0') return 'any';
    var s = lower(v).trim();
    if (s === 'any' || s === 'all' || s === 'both') return 'any';
    if (s === 'only' || s === 'yes' || s === 'true') return 'only';
    if (s === 'exclude' || s === 'no' || s === 'false' || s === 'skip') return 'exclude';
    return 'any';
  }

  function boolFlag(s, names) {
    for (var i = 0; i < names.length; i++) {
      if (s[names[i]] === true || s[names[i]] === 1 || s[names[i]] === 'true' || s[names[i]] === '1') return true;
    }
    return false;
  }

  // true / false / null(absent) — for flags whose polarity must be preserved.
  function flagKey(s, names) {
    for (var i = 0; i < names.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(s, names[i])) continue;
      var v = s[names[i]];
      if (v === true || v === 1 || v === 'true' || v === '1') return true;
      if (v === false || v === 0 || v === 'false' || v === '0') return false;
    }
    return null;
  }

  var SORT_ALIASES = {
    recent: 'newest', newest: 'newest', new: 'newest',
    old: 'oldest', oldest: 'oldest',
    play_count: 'plays', playcount: 'plays', plays: 'plays', popular: 'plays', most_played: 'plays',
    upvote_count: 'upvotes', upvotecount: 'upvotes', upvotes: 'upvotes', likes: 'upvotes',
    most_liked: 'upvotes',
    name: 'title', title: 'title', alphabetical: 'title',
    length: 'duration', duration: 'duration'
  };

  function canonSort(k) {
    var key = lower(k).trim();
    if (Object.prototype.hasOwnProperty.call(SORT_ALIASES, key)) key = SORT_ALIASES[key];
    return ['newest', 'oldest', 'plays', 'upvotes', 'title', 'duration'].indexOf(key) === -1 ? '' : key;
  }

  // Folds every legacy alias into a canonical spec. Unknown keys are preserved
  // on the result (harmless) and never throw.
  function normalizeSpec(spec) {
    var s = isObj(spec) ? Object.assign({}, spec) : {};
    var include = Object.assign({}, isObj(s.include) ? s.include : {});

    /* --- like / dislike tri-state --- */
    var liked = triKey(s.liked);
    if (liked === null && boolFlag(s, ['likedOnly'])) liked = 'only';
    if (liked !== null) s.liked = liked;

    var disliked = triKey(s.disliked);
    if (disliked === null && boolFlag(s, ['dislikedOnly'])) disliked = 'only';
    if (disliked === null && boolFlag(s, ['excludeDisliked', 'skipDislikes'])) disliked = 'exclude';
    if (disliked === null && Object.prototype.hasOwnProperty.call(s, 'includeDisliked')) {
      // NOTE the polarity: includeDisliked === true means "do NOT hide dislikes".
      disliked = boolFlag(s, ['includeDisliked']) ? 'any' : 'exclude';
    }
    if (disliked !== null) s.disliked = disliked;

    /* --- include.* booleans --- */
    var f;
    f = flagKey(s, ['skipUploads', 'excludeUploads']);
    if (f !== null) include.uploads = !f;
    if (boolFlag(s, ['includeUploads'])) include.uploads = true;
    f = flagKey(s, ['skipInstrumentals', 'excludeInstrumentals']);
    if (f !== null) include.instrumental = !f;
    if (boolFlag(s, ['instrumentalOnly', 'onlyInstrumentals'])) include.instrumental = true;
    f = flagKey(s, ['skipRemixes', 'excludeRemixes']);
    if (f !== null) include.remixes = !f;
    if (boolFlag(s, ['remixesOnly', 'onlyRemixes'])) include.remixes = true;
    f = flagKey(s, ['skipTrashed', 'excludeTrashed']);
    if (f !== null) include.trashed = !f;
    if (boolFlag(s, ['trashedOnly'])) include.trashed = true;
    f = flagKey(s, ['skipUnliked']);
    if (f !== null) include.unliked = !f;
    if (boolFlag(s, ['unlikedOnly'])) include.unliked = true;
    f = flagKey(s, ['skipHooks', 'excludeHooks']);
    if (f !== null) include.hooks = !f;
    if (boolFlag(s, ['withHook', 'hasHook', 'hooksOnly'])) include.hooks = true;
    f = flagKey(s, ['skipContests', 'excludeContests']);
    if (f !== null) include.contests = !f;
    if (boolFlag(s, ['contestsOnly'])) include.contests = true;
    f = flagKey(s, ['skipGenerated', 'excludeGenerated']);
    if (f !== null) include.generated = !f;
    s.include = include;

    /* --- models --- */
    var families = uniqStr(s.models);
    var legacy = [];
    if (boolFlag(s, ['modelV6'])) legacy.push('v6');
    if (boolFlag(s, ['modelV6Mini'])) legacy.push('v6-mini');
    if (boolFlag(s, ['modelV55', 'modelV5_5'])) legacy.push('v5.5');
    if (boolFlag(s, ['modelV5'])) legacy.push('v5');
    if (boolFlag(s, ['modelV45plus', 'modelV45Plus'])) legacy.push('v4.5plus');
    if (boolFlag(s, ['modelV45'])) legacy.push('v4.5');
    if (boolFlag(s, ['modelV4'])) legacy.push('v4');
    if (boolFlag(s, ['modelV35'])) legacy.push('v3.5');
    if (boolFlag(s, ['modelV3'])) legacy.push('v3');
    if (boolFlag(s, ['modelRemaster'])) legacy.push('remaster');
    if (boolFlag(s, ['modelCustom'])) legacy.push('custom');
    if (boolFlag(s, ['allV6Models'])) legacy.push('v6', 'v6-mini');
    if (legacy.length) families = uniqStr(families.concat(legacy));
    if (families.length) s.models = families;
    if (s.modelNames != null) s.modelNames = uniqStr(s.modelNames);

    /* --- projects (membership is joined client-side by the caller) --- */
    var projects = uniqStr(s.projects);
    if (!projects.length) {
      var one = s.projectId != null ? s.projectId : (s.project != null ? s.project : s.workspace);
      if (one != null && str(one) !== '') projects = [str(one)];
    }
    if (projects.length) s.projects = projects;
    // Default true: picking projects must never silently drop the unassigned
    // bucket from a mass download.
    if (typeof s.includeUnassigned !== 'boolean') s.includeUnassigned = true;

    /* --- explicit ids --- */
    var inc = arrOf(isObj(s.ids) ? s.ids.include : null);
    if (!inc.length) inc = arrOf(s.includeIds);
    var exc = arrOf(isObj(s.ids) ? s.ids.exclude : null);
    if (!exc.length) exc = arrOf(s.excludeIds);
    if (inc.length || exc.length) s.ids = { include: uniqStr(inc), exclude: uniqStr(exc) };

    /* --- text --- */
    if (s.text == null) {
      var t = s.keyword != null ? s.keyword : (s.q != null ? s.q : s.search);
      if (t != null && str(t) !== '') s.text = str(t);
    }
    if (s.textMode !== 'all' && s.textMode !== 'any') {
      s.textMode = boolFlag(s, ['matchAll']) ? 'all' : 'any';
    }

    /* --- numeric ranges --- */
    var ranges = [
      ['playsMin', ['minPlays', 'minPlayCount']],
      ['playsMax', ['maxPlays', 'maxPlayCount']],
      ['upvotesMin', ['minUpvotes', 'minUpvoteCount']],
      ['upvotesMax', ['maxUpvotes', 'maxUpvoteCount']],
      ['durationMin', ['minDuration']],
      ['durationMax', ['maxDuration']]
    ];
    for (var p = 0; p < ranges.length; p++) {
      if (s[ranges[p][0]] != null) continue;
      for (var q = 0; q < ranges[p][1].length; q++) {
        var alt = s[ranges[p][1][q]];
        if (alt != null && alt !== '') { s[ranges[p][0]] = num(alt); break; }
      }
    }
    if (s.createdAfter == null) {
      s.createdAfter = s.after != null ? s.after : (s.since != null ? s.since : s.newerThan);
    }
    if (s.createdBefore == null) {
      s.createdBefore = s.before != null ? s.before : (s.until != null ? s.until : s.olderThan);
    }
    s.createdAfter = toMs(s.createdAfter);
    s.createdBefore = toMs(s.createdBefore);

    /* --- sort / paging --- */
    var key = canonSort(s.sort);
    if (!key) key = canonSort(boolFlag(s, ['oldestFirst']) ? 'oldest' : (boolFlag(s, ['recent', 'newestFirst']) ? 'newest' : ''));
    if (key) s.sort = key;
    var order = lower(s.order).trim();
    if (order === 'ascending') order = 'asc';
    else if (order === 'descending') order = 'desc';
    if (order !== 'asc' && order !== 'desc') order = (key === 'oldest' || key === 'title') ? 'asc' : 'desc';
    s.order = order;
    if (s.limit != null && s.limit !== '') s.limit = intOrNull(s.limit);
    if (s.offset != null && s.offset !== '') s.offset = intOrNull(s.offset);

    return s;
  }

/* ================================================================== *
   * text matching
   * ================================================================== */

  function allText(rec) {
    return [rec.title, rec.tags, rec.style, rec.prompt, rec.lyrics]
      .map(lower).join(' ').replace(/\s+/g, ' ').trim();
  }

  function fieldHaystack(rec, field) {
    switch (field) {
      case 'title':
        return lower(rec.title);
      case 'style':
        // metadata.tags IS the free-text style/genre field (recon); metadata.style
        // shows up on some payloads, so both feed the same haystack.
        return (lower(rec.tags) + ' ' + lower(rec.style)).replace(/\s+/g, ' ').trim();
      case 'prompt':
        return lower(rec.prompt);
      case 'lyrics':
        // NOT recon-verified on a clip (background.js normalizeClip attaches
        // `lyrics` client-side). Kept so lyric search works when present.
        return lower(rec.lyrics);
      case 'model':
        return [rec.modelName, rec.modelFamily, rec.modelLabel, rec.modelVersion]
          .map(lower).join(' ').trim();
      case 'project':
        var ps = arrOf(rec.projectIds).map(lower).join(' ');
        return rec.isUnassigned
          ? (ps + ' default my workspace unassigned').trim()
          : ps;
      default:
        return allText(rec);
    }
  }

  function termMatches(rec, term) {
    var v = lower(term && term.value).trim();
    if (!v) return false;
    return fieldHaystack(rec, term && term.field ? term.field : 'any').indexOf(v) !== -1;
  }

  /*
   * `spec.text` is a PLAIN string, not a query: 'any' (default) is classic
   * substring search over title + tags/style + prompt (+ lyrics), 'all' requires
   * every whitespace token to appear. Field prefixes, negation and OR live in
   * `spec.terms` (see parseQuery), which is what the search box should use.
   */
  function textMatches(rec, spec) {
    var text = lower(spec.text).trim().replace(/\s+/g, ' ');
    if (!text) return true;
    var hay = allText(rec);
    if (spec.textMode === 'all') {
      var toks = text.split(' ');
      for (var i = 0; i < toks.length; i++) {
        if (toks[i] && hay.indexOf(toks[i]) === -1) return false;
      }
      return true;
    }
    return hay.indexOf(text) !== -1;
  }

  /*
   * Negation is global AND-NOT: one negated hit rejects the clip, in both AND and
   * OR groups. Positives are evaluated per group. `groups` (only present for
   * mixed AND/OR queries) takes precedence over the flat `terms` list so exact
   * operator intent survives the round trip through parseQuery.
   */
  function termsMatch(rec, spec) {
    var groups = Array.isArray(spec.groups) ? spec.groups : null;
    var all = Array.isArray(spec.terms) ? spec.terms.slice() : [];
    if (groups) {
      for (var g = 0; g < groups.length; g++) {
        var gt = (groups[g] && Array.isArray(groups[g].terms)) ? groups[g].terms : [];
        for (var t = 0; t < gt.length; t++) all.push(gt[t]);
      }
    }
    if (!all.length) return true;

    var positives = [];
    for (var i = 0; i < all.length; i++) {
      if (!all[i] || typeof all[i] !== 'object') continue;
      if (all[i].negate === true) {
        if (termMatches(rec, all[i])) return false;
      } else {
        positives.push(all[i]);
      }
    }
    if (!positives.length) return true;

    if (groups) {
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi];
        if (!grp || !Array.isArray(grp.terms)) continue;
        var gp = grp.terms.filter(function (x) { return x && x.negate !== true; });
        if (!gp.length) continue;
        var ok = grp.mode === 'OR'
          ? gp.some(function (x) { return termMatches(rec, x); })
          : gp.every(function (x) { return termMatches(rec, x); });
        if (!ok) return false;
      }
      return true;
    }

    if (spec.any === true) {
      for (var p = 0; p < positives.length; p++) if (termMatches(rec, positives[p])) return true;
      return false;
    }
    for (var q = 0; q < positives.length; q++) if (!termMatches(rec, positives[q])) return false;
    return true;
  }

  /* ================================================================== *
   * query parser
   * ================================================================== */

  // Splits on whitespace while keeping "quoted phrases" and honouring \\ escapes.
  function tokenizeQuery(q) {
    var out = [];
    var buf = '';
    var quoted = false;
    var quoteChar = '';
    var s = str(q);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\\' && i + 1 < s.length) { buf += s.charAt(i + 1); i++; continue; }
      if (quoteChar) {
        if (ch === quoteChar) { quoteChar = ''; continue; }
        buf += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quoteChar = ch; quoted = true; continue; }
      if (/\s/.test(ch)) {
        if (buf !== '') out.push({ value: buf, quoted: quoted });
        buf = '';
        quoted = false;
        continue;
      }
      buf += ch;
    }
    if (buf !== '') out.push({ value: buf, quoted: quoted });
    return out;
  }

  function canonField(name) {
    var key = lower(name).replace(/[\s_-]/g, '');
    return Object.prototype.hasOwnProperty.call(FIELD_SYNONYMS, key) ? FIELD_SYNONYMS[key] : null;
  }

  /*
   * parseQuery('style: "dream pop" -metal')
   *   -> { text: 'style: "dream pop" -metal',
   *        terms: [ {field:'style', value:'dream pop', negate:false},
   *                 {field:'any',   value:'metal',     negate:true } ],
   *        any: false, groups: [...] }
   *
   * Operators are case-SENSITIVE (AND / OR, also && / ||) so ordinary words
   * like "and" / "or" inside a title are not eaten as operators. Negation is a
   * leading '-' or '!'.
   *
   * `any` is true only when the whole query is a single OR group (the common
   * `dream OR synth` case). A query that MIXES AND and OR keeps exact grouping
   * on `groups`, which matches() honours over the flat list, so no operator is
   * silently dropped. Unparseable fragments (unknown field prefix, empty value)
   * are never swallowed: they are emitted with field 'any' and their original
   * text in `raw`.
   */
  function parseQuery(q) {
    var raw = str(q);
    var out = { text: raw.trim(), terms: [], any: false, groups: null, mode: 'AND' };
    var toks = tokenizeQuery(raw);
    if (!toks.length) return out;

    // Groups are AND-ed with each other; terms inside a group are AND-ed, or
    // OR-ed when the group is an OR group. An explicit OR extends the current
    // group; an implicit term after an OR run starts a fresh AND group (so
    // `a OR b title:x` reads as `(a OR b) AND title:x`), and an explicit AND
    // always closes the current group.
    var groups = [{ mode: 'AND', terms: [] }];
    var current = groups[0];
    var sawOr = false;

    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i];

      // `style: "dream pop"` — a bare `field:` token takes the NEXT token as its
      // value, so a quoted phrase after a field prefix stays one term.
      if (!tok.quoted && tok.value.charAt(tok.value.length - 1) === ':' &&
          canonField(tok.value.slice(0, -1)) !== null && i + 1 < toks.length) {
        var head = tok.value.slice(0, -1);
        i++;
        // The merged token counts as quoted when the value was, so `style:"-x"`
        // and `style: AND` are values rather than operators.
        tok = { value: head + ':' + toks[i].value, quoted: toks[i].quoted === true };
      }

      var v = tok.value;

      if (!tok.quoted && (v === 'AND' || v === '&&')) {
        if (current.mode === 'OR' || current.terms.length) {
          current = { mode: 'AND', terms: [] };
          groups.push(current);
        }
        sawOr = false;
        continue;
      }
      if (!tok.quoted && (v === 'OR' || v === '||')) {
        current.mode = 'OR';
        sawOr = true;
        out.mode = 'OR';
        continue;
      }
      if (!sawOr && current.mode === 'OR' && current.terms.length) {
        current = { mode: 'AND', terms: [] };
        groups.push(current);
      }
      sawOr = false;

      var negate = false;
      if (!tok.quoted && v.length > 1 && (v.charAt(0) === '-' || v.charAt(0) === '!')) {
        negate = true;
        v = v.slice(1);
      }
      if (v === '') continue;

      var field = 'any';
      var colon = v.indexOf(':');
      if (colon > 0) {
        var canon = canonField(v.slice(0, colon));
        var rest = v.slice(colon + 1).trim();
        if (canon && rest !== '') {
          field = canon;
          v = rest;
        }
        // Unknown field name or empty value: keep the fragment searchable
        // instead of silently dropping it.
      }

      var term = { field: field, value: v, negate: negate };
      if (colon > 0 && field === 'any' && canonField(v.slice(0, colon)) === null) {
        term.raw = tok.value;
      }
      current.terms.push(term);
    }

    var terms = [];
    var orGroups = 0;
    var used = 0;
    for (var g = 0; g < groups.length; g++) {
      for (var t = 0; t < groups[g].terms.length; t++) terms.push(groups[g].terms[t]);
      if (groups[g].terms.length) {
        used++;
        if (groups[g].mode === 'OR') orGroups++;
      }
    }
    out.terms = terms;
    if (used > 1) out.groups = groups;
    out.any = used === 1 && orGroups === 1;
    out.mode = out.any ? 'OR' : 'AND';
    return out;
  }

  /* ================================================================== *
   * sorting
   * ================================================================== */

  /*
   * Every comparator below is ASCENDING in its key; `sort()` applies the sign.
   * Unknown values (no created_at, no duration) sort last in ascending order so
   * they never lead a list, and ties fall back to input order (stable), which
   * keeps pagination from shuffling equal rows between pages.
   */
  var SORTERS = {
    newest: function (a, b) { return a.createdMs - b.createdMs; },
    oldest: function (a, b) { return a.createdMs - b.createdMs; },
    plays: function (a, b) { return a.playCount - b.playCount; },
    upvotes: function (a, b) { return a.upvoteCount - b.upvoteCount; },
    title: function (a, b) {
      var x = lower(a.title);
      var y = lower(b.title);
      return x < y ? -1 : (x > y ? 1 : 0);
    },
    duration: function (a, b) {
      var x = a.durationSec == null ? Infinity : a.durationSec;
      var y = b.durationSec == null ? Infinity : b.durationSec;
      return x - y;
    }
  };

  var SORT_KEYS = Object.keys(SORTERS);
  var SORT_DEFAULT_ORDER = {
    newest: 'desc', oldest: 'asc', plays: 'desc',
    upvotes: 'desc', title: 'asc', duration: 'desc'
  };

/* ================================================================== *
   * the engine
   * ================================================================== */

  // Absolute fallback for normalize(); contains nothing that can throw, so the
  // catch in normalize() cannot recurse forever.
  function blankRecord() {
    return {
      __smf: 1,
      id: '', title: '', status: '', isComplete: true,
      createdMs: 0, createdIso: '',
      playCount: 0, upvoteCount: 0, flagCount: 0, bpm: 0,
      isLiked: false, isDisliked: false, isPublic: false, isHidden: false,
      isTrashed: false, isContest: false, isVerified: false, hasHook: false,
      isPersonaRoot: false, allowComments: true,
      modelVersion: '', modelName: '', modelFamily: 'unknown', modelLabel: 'Unknown',
      isCustomModel: false, isRemix: false, canRemix: false, isInstrumental: false,
      isUploadLike: false, metadataType: '', prompt: '', tags: '', style: '', lyrics: '',
      batchIndex: null, ownerName: '', ownerHandle: '', ownerId: '', ownerAvatar: '',
      projectIds: [], isUnassigned: true, durationSec: null,
      audioUrl: '', audioUrlIsDecoy: false, bestAudioUrl: '', mediaUrls: [],
      coverUrl: '', imageLargeUrl: '', videoUrl: '',
      entitlements: { canDownload: true, canLike: false, canDislike: false, canShare: false, canPlaylist: false }
    };
  }

  class SunoFilter {
    /* ---------------------------------------------------------------- *
     * normalize
     * ---------------------------------------------------------------- */

    /*
     * Total function: never throws, never returns null, even for
     * null/undefined/garbage input. Every recon-verified field is read here
     * exactly once so the rest of the engine never touches raw clip shape again.
     *
     * `bpm` is on every record but is deliberately NOT filterable: there is no
     * bpm predicate or numeric range in normalizeSpec(). No recon-verified clip
     * payload carries a tempo field — tempo is computed client-side from
     * decoded audio — so `bpm` is 0 on essentially every record from the feed.
     * Do not add a BPM range filter here: it would match nothing, and the field
     * being usually-0 is the absence of data, not a bug to filter around.
     *
     * ctx may carry:
     *   dislikedIds     Set/array of ids the caller diffed out of the feed
     *                   (disliked state is NOT a clip field)
     *   projectIdsById  Map|object of id -> [project ids] when membership is
     *                   joined outside the clip object
     */
    normalize(clip, ctx) {
      ctx = isObj(ctx) ? ctx : {};
      try {
        // Already normalized: only the disliked flag can be refreshed cheaply.
        if (isObj(clip) && clip.__smf === 1) {
          var dset = ctx.dislikedIds;
          if (dset != null && (dset instanceof Set || Array.isArray(dset))) {
            var copy = Object.assign({}, clip);
            copy.isDisliked = idSet(dset)[str(clip.id)] === true;
            return copy;
          }
          return clip;
        }

        var c = isObj(clip) ? clip : {};
        var meta = isObj(c.metadata) ? c.metadata : {};
        var id = str(c.id);

        var createdIso = str(c.created_at);
        var createdMs = toMs(createdIso);
        if (createdMs === null) createdMs = 0;

        var status = lower(c.status).trim();
        var modelVersion = str(c.major_model_version); // may be "" — never assume non-null
        var modelName = str(c.model_name);
        var modelFamily = resolveModelFamily(modelVersion, modelName);

        // is_liked is the user's OWN like state (recon-verified bool). It is
        // never inferred from upvote_count.
        var isLiked = boolOf(c.is_liked);

        var dislikes = idSet(ctx.dislikedIds);
        var isDisliked = dislikes[id] === true || c.disliked === true || boolOf(c.is_disliked);

        // Project membership is joined client-side by the caller.
        var projectIds = uniqStr(
          arrOf(c.projectIds).length ? c.projectIds
            : (arrOf(c.project_ids).length ? c.project_ids
              : projectIdsFromCtx(ctx, id))
        );
        var isUnassigned = true;
        for (var pi = 0; pi < projectIds.length; pi++) {
          if (projectIds[pi] !== DEFAULT_PROJECT_ID) { isUnassigned = false; break; }
        }

        var metadataType = lower(meta.type).trim();
        // Recon only ever observed metadata.type === "gen". Rather than dropping
        // anything unusual, a non-"gen" type is treated as upload-like; the
        // legacy source_type marker is honoured too.
        var isUploadLike = (metadataType !== '' && metadataType !== 'gen') ||
          lower(c.source_type).trim() === 'upload' || boolOf(c.is_upload);

        // make_instrumental MAY BE ABSENT on vocal clips -> absent means false.
        var isInstrumental = boolOf(meta.make_instrumental) ||
          (meta.make_instrumental == null && boolOf(meta.is_instrumental)) ||
          boolOf(c.is_instrumental);

        var audioUrl = str(c.audio_url);
        var mediaUrls = [];
        var rawMedia = arrOf(c.media_urls);
        for (var mi2 = 0; mi2 < rawMedia.length; mi2++) {
          var u = isObj(rawMedia[mi2]) ? str(rawMedia[mi2].url) : str(rawMedia[mi2]);
          if (u) mediaUrls.push(u);
        }

        var statusComplete = status === 'complete' || status === 'completed' ||
          status === 'finished' || status === '';

        return {
          __smf: 1,
          id: id,
          title: str(c.title),

          status: status,
          isComplete: statusComplete,

          createdMs: createdMs,
          createdIso: createdIso,

          playCount: num(c.play_count),
          upvoteCount: num(c.upvote_count),
          flagCount: num(c.flag_count),
          // Client-side analysis result, not a feed field; see the note above
          // normalize(). First of clip.bpm / metadata.bpm / metadata.tempo_bpm
          // that coerces to a non-zero number, else 0. `num()` is total, so
          // '120 BPM' and null both land on 0 rather than throwing.
          bpm: num(c.bpm) || num(meta.bpm) || num(meta.tempo_bpm) || 0,

          isLiked: isLiked,
          isDisliked: isDisliked,
          isPublic: boolOf(c.is_public),
          isHidden: boolOf(c.is_hidden),
          isTrashed: boolOf(c.is_trashed),
          isContest: boolOf(c.is_contest_clip),
          isVerified: boolOf(c.is_verified),
          hasHook: boolOf(c.has_hook),
          isPersonaRoot: boolOf(c.is_persona_root),
          allowComments: boolOrTrue(c.allow_comments),

          modelVersion: modelVersion,
          modelName: modelName,
          modelFamily: modelFamily,
          modelLabel: modelLabel(modelFamily),
          isCustomModel: lower(modelName).indexOf('chirp-custom:') === 0,

          isRemix: boolOf(meta.is_remix) || boolOf(c.is_remix),
          canRemix: boolOf(meta.can_remix),
          isInstrumental: isInstrumental,
          isUploadLike: isUploadLike,
          metadataType: metadataType,
          prompt: str(meta.prompt),
          tags: str(meta.tags),
          style: str(meta.style),
          lyrics: str(c.lyrics != null ? c.lyrics : meta.lyrics),

          batchIndex: intOrNull(c.batch_index),

          // display_name / handle / user_id / avatar_image_url are the OWNER's
          // identity (the signed-in user), NOT clip-level artist data. Renamed
          // to owner* so no caller mistakes them for an artist field.
          ownerName: str(c.display_name),
          ownerHandle: str(c.handle),
          ownerId: str(c.user_id),
          ownerAvatar: str(c.avatar_image_url),

          projectIds: projectIds,
          isUnassigned: isUnassigned,

          durationSec: parseDuration(c.duration),
          audioUrl: audioUrl,
          // The decoy must never be fetched; media_urls holds the real audio.
          audioUrlIsDecoy: DECOY_RE.test(audioUrl),
          bestAudioUrl: mediaUrls.length ? mediaUrls[0] : '',
          mediaUrls: mediaUrls,
          coverUrl: str(c.image_url) || str(c.cover_url),
          imageLargeUrl: str(c.image_large_url),
          videoUrl: str(c.video_url),

          entitlements: readEntitlements(c.action_config)
        };
      } catch (e) {
        return blankRecord();
      }
    }

    /* ---------------------------------------------------------------- *
     * matches
     * ---------------------------------------------------------------- */

    // `record` may be a raw clip or an already-normalized record.
    matches(record, spec, ctx) {
      try {
        var s = normalizeSpec(spec);
        var rec = (isObj(record) && record.__smf === 1) ? record : this.normalize(record, ctx);

        /* --- explicit ids --- */
        if (s.ids) {
          if (s.ids.include.length) {
            if (!s._incSet) s._incSet = idSet(s.ids.include);
            if (!s._incSet[str(rec.id)]) return false;
          }
          if (s.ids.exclude.length) {
            if (!s._excSet) s._excSet = idSet(s.ids.exclude);
            if (s._excSet[str(rec.id)]) return false;
          }
        }

        /* --- like / dislike tri-state --- */
        if (s.liked === 'only' && !rec.isLiked) return false;
        if (s.liked === 'exclude' && rec.isLiked) return false;
        if (s.disliked === 'only' && !rec.isDisliked) return false;
        if (s.disliked === 'exclude' && rec.isDisliked) return false;

        /* --- status / visibility --- */
        if (s.status === 'complete' && !rec.isComplete) return false;
        if (s.status === 'pending' && rec.isComplete) return false;
        if (s.visibility === 'public' && (!rec.isPublic || rec.isHidden)) return false;
        if (s.visibility === 'private' && rec.isPublic && !rec.isHidden) return false;

        /* --- include.* booleans (absent = no constraint) --- */
        var inc = s.include;
        if (inc.instrumental === true && !rec.isInstrumental) return false;
        if (inc.instrumental === false && rec.isInstrumental) return false;
        if (inc.remixes === true && !rec.isRemix) return false;
        if (inc.remixes === false && rec.isRemix) return false;
        if (inc.trashed === true && !rec.isTrashed) return false;
        if (inc.trashed === false && rec.isTrashed) return false;
        if (inc.contests === true && !rec.isContest) return false;
        if (inc.contests === false && rec.isContest) return false;
        if (inc.unliked === true && rec.isLiked) return false;
        if (inc.unliked === false && !rec.isLiked) return false;
        if (inc.hooks === true && !rec.hasHook) return false;
        if (inc.hooks === false && rec.hasHook) return false;
        if (inc.uploads === true && !rec.isUploadLike) return false;
        if (inc.uploads === false && rec.isUploadLike) return false;
        if (inc.generated === true && rec.metadataType !== 'gen') return false;
        if (inc.generated === false && rec.metadataType === 'gen') return false;

        /* --- model family / raw model name --- */
        if (s.models && s.models.length && s.models.indexOf(rec.modelFamily) === -1) return false;
        if (s.modelNames && s.modelNames.length) {
          if (!s._nameSet) {
            s._nameSet = {};
            for (var ni = 0; ni < s.modelNames.length; ni++) {
              s._nameSet[s.modelNames[ni]] = true;
              s._nameSet[lower(s.modelNames[ni])] = true;
            }
          }
          if (!s._nameSet[rec.modelName] && !s._nameSet[lower(rec.modelName)]) return false;
        }

        /* --- projects; 'default' is the unassigned bucket --- */
        if (s.projects && s.projects.length) {
          if (!s._projSet) s._projSet = idSet(s.projects);
          var ids = arrOf(rec.projectIds);
          var hit = false;
          for (var i = 0; i < ids.length; i++) {
            if (s._projSet[ids[i]]) { hit = true; break; }
          }
          if (!hit && rec.isUnassigned) {
            if (s._projSet[DEFAULT_PROJECT_ID]) hit = true;
            else if (s.includeUnassigned !== false) hit = true;
          }
          if (!hit) return false;
        }

        /* --- text / terms --- */
        // Terms (from parseQuery) are evaluated first; `text` is a plain
        // substring filter and is ignored when terms exist, because parseQuery
        // keeps the RAW query in `text` (including `-term` and `field:`).
        if (Array.isArray(s.terms) && s.terms.length) {
          if (!termsMatch(rec, s)) return false;
        } else if (s.text) {
          if (!textMatches(rec, s)) return false;
        }

        /* --- ranges --- */
        if (s.createdAfter != null && (!rec.createdMs || rec.createdMs < s.createdAfter)) return false;
        if (s.createdBefore != null && (!rec.createdMs || rec.createdMs > s.createdBefore)) return false;
        if (s.durationMin != null && (rec.durationSec == null || rec.durationSec < s.durationMin)) return false;
        if (s.durationMax != null && (rec.durationSec == null || rec.durationSec > s.durationMax)) return false;
        if (s.playsMin != null && rec.playCount < s.playsMin) return false;
        if (s.playsMax != null && rec.playCount > s.playsMax) return false;
        if (s.upvotesMin != null && rec.upvoteCount < s.upvotesMin) return false;
        if (s.upvotesMax != null && rec.upvoteCount > s.upvotesMax) return false;
        if (s.batchIndex !== undefined && s.batchIndex !== null &&
            rec.batchIndex !== s.batchIndex) return false;

        return true;
      } catch (e) {
        return false;
      }
    }

    /* ---------------------------------------------------------------- *
     * apply
     * ---------------------------------------------------------------- */

    /*
     * Returns matching RAW clips in input order. Sorting and paging are NOT
     * applied here (see sort() / paginate()) so a caller can chain them without
     * double-applying spec.limit.
     */
    apply(clips, spec, ctx) {
      var out = [];
      if (!Array.isArray(clips)) return out;
      var s = normalizeSpec(spec);
      for (var i = 0; i < clips.length; i++) {
        // A non-object entry has no id to download; it is dropped rather than
        // handed downstream as a "matching clip".
        if (!isObj(clips[i])) continue;
        if (this.matches(clips[i], s, ctx)) out.push(clips[i]);
      }
      return out;
    }

/* ---------------------------------------------------------------- *
     * facets
     * ---------------------------------------------------------------- */

    /*
     * ctx: { projects:[{id,name}], dislikedIds:Set }.
     * genres = the top MAX_GENRES comma-separated tokens across metadata.tags
     * (+ metadata.style), deduplicated per clip so one clip reading
     * "pop, pop, dream" cannot out-vote 40 genuinely different tracks.
     */
    facets(clips, ctx) {
      ctx = isObj(ctx) ? ctx : {};
      var list = Array.isArray(clips) ? clips : [];
      var counts = {
        liked: 0, disliked: 0, complete: 0, instrumental: 0,
        remix: 0, trashed: 0, public: 0, unassigned: 0
      };
      var modelCounts = {};
      var projectCounts = {};
      var genreCounts = {};
      var createdMin = null;
      var createdMax = null;
      var durationMin = null;
      var durationMax = null;
      var playMax = null;
      var i, j, rec;

      for (i = 0; i < list.length; i++) {
        rec = this.normalize(list[i], ctx);

        if (rec.isLiked) counts.liked++;
        if (rec.isDisliked) counts.disliked++;
        if (rec.isComplete) counts.complete++;
        if (rec.isInstrumental) counts.instrumental++;
        if (rec.isRemix) counts.remix++;
        if (rec.isTrashed) counts.trashed++;
        if (rec.isPublic && !rec.isHidden) counts.public++;
        if (rec.isUnassigned) counts.unassigned++;

        modelCounts[rec.modelFamily] = (modelCounts[rec.modelFamily] || 0) + 1;

        // A clip with no projects belongs to the unassigned bucket, which is
        // reported under the "default" project id.
        var pids = arrOf(rec.projectIds);
        if (!pids.length) pids = [DEFAULT_PROJECT_ID];
        for (j = 0; j < pids.length; j++) {
          var pid = pids[j] || DEFAULT_PROJECT_ID;
          projectCounts[pid] = (projectCounts[pid] || 0) + 1;
        }

        if (rec.createdMs) {
          if (createdMin === null || rec.createdMs < createdMin) createdMin = rec.createdMs;
          if (createdMax === null || rec.createdMs > createdMax) createdMax = rec.createdMs;
        }
        if (rec.durationSec != null) {
          if (durationMin === null || rec.durationSec < durationMin) durationMin = rec.durationSec;
          if (durationMax === null || rec.durationSec > durationMax) durationMax = rec.durationSec;
        }
        if (playMax === null || rec.playCount > playMax) playMax = rec.playCount;

        var tokens = (rec.tags + ',' + rec.style).split(/[,;|\n]+/);
        var seenTok = {};
        for (j = 0; j < tokens.length; j++) {
          var tok = lower(tokens[j]).replace(/\s+/g, ' ').trim();
          if (!tok || tok.length > 40) continue;
          if (seenTok[tok]) continue;
          seenTok[tok] = true;
          genreCounts[tok] = (genreCounts[tok] || 0) + 1;
        }
      }

      // Only families actually present, most clips first, taxonomy order for ties.
      var models = [];
      for (i = 0; i < MODELS.length; i++) {
        if (modelCounts[MODELS[i].id]) {
          models.push({ id: MODELS[i].id, label: MODELS[i].label, count: modelCounts[MODELS[i].id] });
        }
      }
      models.sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count;
        return MODEL_INDEX[a.id] - MODEL_INDEX[b.id];
      });

      // Declared projects first (they carry real names), then any project id
      // seen in the data that the caller did not declare.
      var nameById = {};
      var declared = arrOf(ctx.projects);
      var order = [];
      for (i = 0; i < declared.length; i++) {
        var dp = declared[i];
        if (!isObj(dp)) continue;
        var did = str(dp.id);
        if (!did) continue;
        nameById[did] = str(dp.name) || (did === DEFAULT_PROJECT_ID ? UNASSIGNED_LABEL : did);
        order.push(did);
        if (projectCounts[did] == null) projectCounts[did] = 0;
      }
      for (var key in projectCounts) {
        if (!Object.prototype.hasOwnProperty.call(projectCounts, key)) continue;
        if (order.indexOf(key) === -1) order.push(key);
        if (!nameById[key]) nameById[key] = key === DEFAULT_PROJECT_ID ? UNASSIGNED_LABEL : key;
      }
      var projects = [];
      for (i = 0; i < order.length; i++) {
        projects.push({ id: order[i], name: nameById[order[i]], count: projectCounts[order[i]] || 0 });
      }

      var genreKeys = Object.keys(genreCounts);
      genreKeys.sort(function (a, b) {
        if (genreCounts[b] !== genreCounts[a]) return genreCounts[b] - genreCounts[a];
        return a < b ? -1 : (a > b ? 1 : 0);
      });

      return {
        total: list.length,
        counts: counts,
        models: models,
        projects: projects,
        createdMin: createdMin,
        createdMax: createdMax,
        durationMin: durationMin,
        durationMax: durationMax,
        playMax: playMax,
        genres: genreKeys.slice(0, MAX_GENRES)
      };
    }

    /* ---------------------------------------------------------------- *
     * sort / paginate
     * ---------------------------------------------------------------- */

    // Stable sort of RAW clips; dir defaults per key (newest/plays/upvotes/
    // duration desc, oldest/title asc). Ties fall back to newest first, then to
    // input order, so pagination never shuffles equal rows.
    sort(clips, key, dir) {
      var list = Array.isArray(clips) ? clips : [];
      var k = canonSort(key) || 'newest';
      var sign = (dir === 'asc' || dir === 'desc') ? dir : SORT_DEFAULT_ORDER[k];
      var cmp = SORTERS[k];
      var decorated = [];
      for (var i = 0; i < list.length; i++) {
        decorated.push({ raw: list[i], rec: this.normalize(list[i]), idx: i });
      }
      decorated.sort(function (a, b) {
        var d = cmp(a.rec, b.rec);
        if (d) return sign === 'asc' ? d : -d;
        return a.idx - b.idx;
      });
      var out = [];
      for (var j = 0; j < decorated.length; j++) out.push(decorated[j].raw);
      return out;
    }

    paginate(clips, opts) {
      var list = Array.isArray(clips) ? clips : [];
      var o = isObj(opts) ? opts : {};
      var total = list.length;
      var offset = intOrNull(o.offset);
      if (offset === null || offset < 0) offset = 0;
      var limit = intOrNull(o.limit);
      if (limit !== null && limit < 0) limit = 0;
      if (offset > total) offset = total;
      var end = (limit === null) ? total : Math.min(total, offset + limit);
      return {
        items: list.slice(offset, end),
        total: total,
        offset: offset,
        limit: limit === null ? total : limit,
        hasMore: end < total
      };
    }

    /* ---------------------------------------------------------------- *
     * describe
     * ---------------------------------------------------------------- */

    // One-line human summary, e.g.
    // 'Liked only · v6 · 2 projects · style:"dream pop" · not any:"metal"'
    describe(spec) {
      try {
        var s = normalizeSpec(spec);
        var parts = [];

        if (s.liked === 'only') parts.push('Liked only');
        else if (s.liked === 'exclude') parts.push('Not liked');
        if (s.disliked === 'only') parts.push('Disliked only');
        else if (s.disliked === 'exclude') parts.push('No dislikes');

        if (s.status === 'complete') parts.push('Complete');
        else if (s.status === 'pending') parts.push('Still generating');
        if (s.visibility === 'public') parts.push('Public');
        else if (s.visibility === 'private') parts.push('Private');

        if (s.models && s.models.length) parts.push(s.models.map(modelLabel).join(', '));
        if (s.modelNames && s.modelNames.length) parts.push(s.modelNames.join(', '));

        if (s.projects && s.projects.length) {
          var wantsDefault = s.projects.indexOf(DEFAULT_PROJECT_ID) !== -1;
          parts.push(s.projects.length + ' project' + (s.projects.length === 1 ? '' : 's') +
            (wantsDefault ? ' incl. My Workspace'
              : (s.includeUnassigned === false ? '' : ' + unassigned')));
        }

        var inc = s.include;
        if (inc.instrumental === true) parts.push('Instrumental');
        if (inc.instrumental === false) parts.push('With vocals');
        if (inc.remixes === true) parts.push('Remixes');
        if (inc.remixes === false) parts.push('Originals');
        if (inc.trashed === true) parts.push('Trashed');
        if (inc.contests === true) parts.push('Contests');
        if (inc.unliked === true) parts.push('Unliked');
        if (inc.hooks === true) parts.push('Has hook');
        if (inc.uploads === false) parts.push('No uploads');
        if (inc.generated === false) parts.push('No AI generations');

        if (s.createdAfter != null || s.createdBefore != null) {
          parts.push('Created ' +
            (s.createdAfter != null ? 'after ' + isoDay(s.createdAfter) : '') +
            (s.createdAfter != null && s.createdBefore != null ? ' – ' : '') +
            (s.createdBefore != null ? 'before ' + isoDay(s.createdBefore) : ''));
        }
        if (s.durationMin != null || s.durationMax != null) {
          parts.push('Duration ' +
            (s.durationMin != null ? '≥' + s.durationMin + 's' : '') +
            (s.durationMin != null && s.durationMax != null ? '–' : '') +
            (s.durationMax != null ? '≤' + s.durationMax + 's' : ''));
        }
        if (s.playsMin != null) parts.push('≥' + s.playsMin + ' plays');
        if (s.playsMax != null) parts.push('≤' + s.playsMax + ' plays');
        if (s.upvotesMin != null) parts.push('≥' + s.upvotesMin + ' upvotes');

        var terms = Array.isArray(s.terms) ? s.terms : [];
        if (terms.length) {
          for (var i = 0; i < terms.length; i++) {
            var t = terms[i];
            if (!t) continue;
            parts.push((t.negate ? 'not ' : '') + (t.field || 'any') + ':' + JSON.stringify(t.value));
          }
          if (s.any) parts.push('(any of the above)');
        } else if (s.text) {
          parts.push('text ' + JSON.stringify(s.text) + ' in title/style/prompt');
        }

        return parts.length ? parts.join(' · ') : 'All clips';
      } catch (e) {
        return 'All clips';
      }
    }

    /* ---------------------------------------------------------------- *
     * query parsing / spec helpers
     * ---------------------------------------------------------------- */

    parseQuery(q) { return parseQuery(q); }

    normalizeSpec(spec) { return normalizeSpec(spec); }

    modelFamily(clip) {
      var c = isObj(clip) ? clip : {};
      if (c.__smf === 1 && c.modelFamily) return c.modelFamily;
      return resolveModelFamily(c.major_model_version, c.model_name);
    }

    /* ---------------------------------------------------------------- *
     * legacy API — thin wrappers so nothing else breaks
     * ---------------------------------------------------------------- */

    classify(clip, ctx) { return this.normalize(clip, ctx); }
    match(clip, spec, ctx) { return this.matches(clip, spec, ctx); }
    filterList(clips, spec, ctx) { return this.apply(clips, spec, ctx); }
    search(clips, keyword) { return this.apply(clips, { text: str(keyword) }); }

    // Old shape preserved (total/liked/disliked/uploads/neutral/instrumental/
    // v4/v5/v6/other/totalPlays/trashed), now computed from recon fields.
    summarize(clips, ctx) {
      var f = this.facets(clips, ctx);
      var byModel = {};
      for (var i = 0; i < f.models.length; i++) byModel[f.models[i].id] = f.models[i].count;
      var list = Array.isArray(clips) ? clips : [];
      var uploads = 0;
      var totalPlays = 0;
      for (var j = 0; j < list.length; j++) {
        var rec = this.normalize(list[j], ctx);
        if (rec.isUploadLike) uploads++;
        totalPlays += rec.playCount;
      }
      return {
        total: f.total,
        liked: f.counts.liked,
        disliked: f.counts.disliked,
        uploads: uploads,
        neutral: f.total - f.counts.liked - f.counts.disliked,
        instrumental: f.counts.instrumental,
        remix: f.counts.remix,
        complete: f.counts.complete,
        v4: byModel.v4 || 0,
        v5: byModel.v5 || 0,
        v6: byModel.v6 || 0,
        other: byModel.unknown || 0,
        totalPlays: totalPlays,
        trashed: f.counts.trashed
      };
    }

    // Keyed by taxonomy id, plus the legacy 'other' bucket (= 'unknown').
    byModel(clips, ctx) {
      var out = { other: [] };
      for (var i = 0; i < MODELS.length; i++) out[MODELS[i].id] = [];
      var list = Array.isArray(clips) ? clips : [];
      for (var j = 0; j < list.length; j++) {
        var rec = this.normalize(list[j], ctx);
        if (!out[rec.modelFamily]) out[rec.modelFamily] = [];
        out[rec.modelFamily].push(list[j]);
        if (rec.modelFamily === 'unknown') out.other.push(list[j]);
      }
      return out;
    }

    mostPlayed(clips, n) {
      var out = this.sort(clips, 'plays', 'desc');
      return n == null ? out : out.slice(0, Math.max(0, intOrNull(n) || 0));
    }

    mostLiked(clips, n) {
      var out = this.sort(clips, 'upvotes', 'desc');
      return n == null ? out : out.slice(0, Math.max(0, intOrNull(n) || 0));
    }
  }

/* ================================================================== *
   * statics, presets, exports
   * ================================================================== */

  // Callers may use SunoFilter.normalize(...) or window.SunoFilter.normalize(...).
  var METHODS = [
    'normalize', 'matches', 'apply', 'facets', 'sort', 'paginate', 'describe', 'parseQuery',
    'normalizeSpec', 'modelFamily',
    'classify', 'match', 'filterList', 'search', 'summarize', 'byModel', 'mostPlayed', 'mostLiked'
  ];
  for (var si = 0; si < METHODS.length; si++) {
    SunoFilter[METHODS[si]] = SunoFilter.prototype[METHODS[si]];
  }

  SunoFilter.MODELS = MODELS;
  SunoFilter.SORT_KEYS = SORT_KEYS;
  SunoFilter.DEFAULT_PROJECT_ID = DEFAULT_PROJECT_ID;
  SunoFilter.UNASSIGNED_LABEL = UNASSIGNED_LABEL;

  var DAY_MS = 86400000;

  var PRESETS = {
    /*
     * An empty spec now means "no constraints": trashed clips are NOT hidden by
     * default. The old engine dropped them implicitly, which silently shrank
     * mass downloads; use NO_TRASHED to exclude them explicitly.
     */
    ALL: {},

    LIKED_ONLY: { liked: 'only' },
    DISLIKED_ONLY: { disliked: 'only' },
    NO_DISLIKES: { disliked: 'exclude' },

    V6: { models: ['v6'] },
    // "v5 plus everything newer": the whole v6 line plus v5.5 and v5.
    V5_PLUS: { models: ['v6', 'v6-mini', 'v5.5', 'v5'] },

    INSTRUMENTAL: { include: { instrumental: true } },
    REMIXES: { include: { remixes: true } },

    // The old presets were `{}` — identical to ALL, i.e. no sorting at all.
    MOST_PLAYED: { sort: 'plays', order: 'desc' },
    MOST_LIKED: { sort: 'upvotes', order: 'desc' },

    // extras
    NO_TRASHED: { include: { trashed: false } },
    TRASHED: { include: { trashed: true } },
    UNASSIGNED: { projects: [DEFAULT_PROJECT_ID] },
    PENDING: { status: 'pending' },
    COMPLETE: { status: 'complete' },
    V6_MINI: { models: ['v6-mini'] },
    CUSTOM_MODELS: { models: ['custom'] },
    PUBLIC_ONLY: { visibility: 'public' },
    NO_UPLOADS: { include: { uploads: false } },
    UNLIKED: { include: { unliked: true } },
    WITH_HOOKS: { include: { hooks: true } },

    // legacy preset names kept so old callers keep working
    V6_MODELS: { models: ['v6'] },
    V5_AND_V6: { models: ['v6', 'v6-mini', 'v5'] }
  };

  /*
   * RECENT_30_DAYS is a getter so the window is computed when it is READ, not
   * when this script is evaluated — a literal Date.now() at load time goes stale
   * in a long-lived service worker.
   */
  Object.defineProperty(PRESETS, 'RECENT_30_DAYS', {
    enumerable: true,
    configurable: true,
    get: function () { return { createdAfter: Date.now() - 30 * DAY_MS, sort: 'newest', order: 'desc' }; }
  });

  SunoFilter.PRESETS = PRESETS;

  // window.SunoFilter is an INSTANCE, so class statics are invisible on it.
  // Mirror everything onto the instance too: callers reach the engine through
  // the instance in content scripts, and must still find MODELS / PRESETS.
  var STATICS = METHODS.concat(['MODELS', 'PRESETS', 'SORT_KEYS',
    'DEFAULT_PROJECT_ID', 'UNASSIGNED_LABEL']);
  var instance = new SunoFilter();
  for (var xi = 0; xi < STATICS.length; xi++) instance[STATICS[xi]] = SunoFilter[STATICS[xi]];

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SunoFilter: SunoFilter, SunoFilterClass: SunoFilter };
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.SunoFilter = instance;
    globalThis.SunoFilterClass = SunoFilter;
  }

})();
