/**
 * 4. SETTINGS — defaults, the per-wake cache, coercion, and write-behind.
 *
 * Extracted verbatim from `background/background.js` section 4. For the
 * mechanism (why the worker may call these as bare globals, why nothing here
 * is rebound at load time) read `background/parts/15-quota.js` first.
 *
 * WHAT MOVED, AND WHY IT IS SAFE, VERIFIED BY REFERENCE COUNT BEFORE THE CUT:
 *
 *   loadSettings / updateSettings / resetSettings / persistSettings /
 *   coerceSettings / normalizeLadder / resolveFeedPageLimit /
 *   applySettingsToLibraries / libLogger (and the small coercers
 *   `clampNumber` / `snapToChoice` / `boolOr` / `numOr` / `bpmFromClip`) —
 *   every outside reference is a CALL-TIME read inside a function body, so the
 *   classic-script shared-global rule covers them. None is read at top level by
 *   the monolith or by a sibling part (checked, mechanical scan, 0 hits).
 *
 *   DEFAULT_SETTINGS — moved here FROM §1 CONSTANTS (it is settings' own
 *   default blob, so this is the natural owner). Its initializer is pure
 *   literals — no reference to any other constant, verified by reading the
 *   body — because a part is imported BEFORE the monolith body evaluates, and
 *   a load-time read of a §1 `const` would be a TDZ ReferenceError that kills
 *   the worker at wake. The same rule is why `let settingsCache =
 *   Object.assign({}, DEFAULT_SETTINGS)` stays VERBATIM: its dependency now
 *   lives ABOVE it in this same part, so load order is trivially safe.
 *
 *   STORAGE_KEYS.SETTINGS stays in §1 and is used here only inside function
 *   bodies (call time) — legal under the same rule.
 *
 * THE FIVE MUTABLE BINDINGS (settingsCache, settingsLoaded,
 * settingsLoadPromise, settingsWriteTimer, settingsWritePending) are
 * section-local; nothing outside this file assigns them. Verified, not
 * assumed: zero outside writers.
 */

/* ==========================================================================
 * 4. SETTINGS
 * ======================================================================== */

const DEFAULT_SETTINGS = Object.freeze({
  debug: false,

  /* ---- what to fetch ---- */
  variant: 'm4a',
  /** Ordered ladder preference; the first AVAILABLE rung is used. */
  downloadSource: ['progressive', 'mango-drm', 'studio', 'download-route'],
  /** Alias key kept for the existing content-script settings panel. */
  sourceLadder: ['progressive', 'mango-drm', 'studio', 'download-route'],
  /** Allow the metered opt-in extras (official WAV, bulk ZIP). */
  allowMeteredExtras: false,

  /* ---- pacing ---- */
  rateLimit: 4,
  rateLimitJitter: true,
  concurrency: 3,
  retryAttempts: 2,

  /* ---- naming ---- */
  filenameTemplate: '{title}_{clipIdShort}.{ext}',
  folderDepth: 2,
  maxFolderDepth: 4,
  overwrite: false,
  dataUrlMaxBytes: 24 * 1024 * 1024,

  /* ---- tags & sidecars ---- */
  tagOptions: Object.freeze({
    embed: true,
    lyrics: true,
    artwork: true,
    bpm: false,
    comment: true,
    json: false,
    lrc: true,
  }),
  /**
   * `neutral` writes the configured neutral artist name; `clip-owner` uses the
   * clip's `display_name`/`handle`. Those fields are the OWNER's account
   * identity, never a third-party artist credit, so `neutral` is the default.
   */
  artistPolicy: 'neutral',
  neutralArtist: 'Suno',
  albumName: 'Suno Library',

  /* ---- conversion ---- */
  // 'none' | 'wav' | 'mp3' | 'ogg'.
  //   'wav' is an offscreen sunoRenderWav call: a real resample with the rate
  //   written into a real WAV header.
  //   'mp3' | 'ogg' are offscreen sunoTranscode calls that need
  //   `globalThis.lamejs` / `OggVorbisEncoder`. Both ARE vendored now, at
  //   vendor/lame.all.js and vendor/OggVorbisEncoder.js, and the offscreen
  //   document loads them from `chrome-extension://` URLs (its
  //   `resolveVendorPath` asserts that protocol). They MUST stay local files:
  //   MV3's default CSP is `script-src 'self'`, which forbids fetching an
  //   encoder from a CDN outright, so a remote copy is not an option.
  // M4A never needs a transcode: the source stream already is one.
  transcode: 'none',
  // Applies to the `wav` rung only. The `wav-48k` rung pins 48000 instead, so
  // the two WAV variants stay distinguishable when this is moved elsewhere.
  wavSampleRate: 48000,
  /**
   * MP3 encoder bitrate in kbps, used by the `mp3` rung only.
   * One of MP3_BITRATES = [128, 160, 192, 224, 256, 320]; a value off that
   * list is SNAPPED to the nearest entry by `snapToChoice`, not rejected, so
   * typing 200 yields 192. Ignore entirely when `transcode !== 'mp3'`.
   */
  mp3Bitrate: 192,
  /**
   * Ogg Vorbis encoder quality, used by the `ogg` rung only. 0 = smallest /
   * fastest, 1 = largest / slowest. One of OGG_QUALITIES = the tenths from 0.0
   * to 1.0, snapped to the nearest tenth. A missing value becomes 0.5, NOT the
   * offscreen document's own 0.8 default, so what the file says and what the
   * encoder does cannot disagree. Ignore when `transcode !== 'ogg'`.
   */
  oggQuality: 0.5,

  /* ---- crawl ---- */
  syncMaxPages: 200,
  /**
   * Page size asked of `POST /api/feed/v3`, clamped to [1, 100].
   *
   * WHY A SETTING AT ALL, WHEN 100 IS THE DOCUMENTED MAXIMUM: because the
   * maximum is UNVERIFIED. 100 is what the shipped web client's own caller sends,
   * what the bundle contains, and what two third-party extensions claim; no live
   * response has been checked against it. If the server really caps pages at 20,
   * every "full page" inference and every page-count estimate is wrong by 5x —
   * and the only way to find out on a real account, without a rebuild, is to ask
   * for 100 and then ask for 20 and compare. That is what `PROBE_FEED` is for, and
   * it takes a `limit` of its own so the experiment needs no settings change at
   * all; this setting is the persistent form of the same experiment.
   *
   * NOT A PROOF OF COMPLETENESS: this value bounds what a page can hold, never
   * where the library ends. Only the server's own cursor does that.
   */
  feedPageLimit: 100,
  dislikedMode: 'exclude',
  autoSync: false,
  syncIntervalMinutes: 60,

  /* ---- safety ---- */
  /** Plan a batch and report it without spending a single download. */
  dryRun: false,
  /**
   * MID-BATCH QUOTA GUARD. `quotaPreflight` reads the meter BEFORE a plan and
   * `runBatch` reads it AFTER, so a plan built on a stale reading used to keep
   * going and then fail item-by-item on the metered rungs — a healthy badge and
   * an opaque mid-batch failure, which is the exact defect this build existed to
   * kill. The guard re-reads the meter DURING the run.
   *
   * `quotaReserve` is the floor the guard stops AT: `remaining <= quotaReserve`
   * ends the batch cleanly. 0 means "stop the moment the meter is empty".
   */
  quotaReserve: 0,
  /**
   * Re-read the meter at most once per N SUCCESSFUL METERED downloads.
   * Re-metering is the expensive part, and `progressive` / `mango-drm` never
   * consume the allowance, so unmetered rungs are not counted and a
   * purely-unmetered batch polls ZERO times.
   */
  quotaCheckEvery: 5,
  /**
   * HLS stream hand-off. OFF by default: collecting the segments requires the
   * page to patch MediaSource on Suno's own player, which is page manipulation
   * and trips abuse heuristics. The content script also gates it behind an
   * explicit confirm, so both sides must agree.
   */
  allowHlsCapture: false,
});

/**
 * @typedef {object} Settings
 * @property {boolean} debug
 * @property {string} variant one of `VARIANTS`; an unrecognised or aliased
 *   value is substituted by `resolveVariant` on read, never stored raw
 * @property {string[]} downloadSource ordered ladder preference
 * @property {string[]} sourceLadder alias of downloadSource
 * @property {boolean} allowMeteredExtras
 * @property {number} rateLimit requests/second
 * @property {boolean} rateLimitJitter
 * @property {number} concurrency
 * @property {number} retryAttempts
 * @property {string} filenameTemplate
 * @property {number} folderDepth
 * @property {number} maxFolderDepth
 * @property {boolean} overwrite
 * @property {number} dataUrlMaxBytes
 * @property {{embed:boolean,lyrics:boolean,artwork:boolean,bpm:boolean,comment:boolean,json:boolean,lrc:boolean}} tagOptions
 * @property {'neutral'|'clip-owner'} artistPolicy
 * @property {string} neutralArtist
 * @property {string} albumName
 * @property {'none'|'wav'|'mp3'|'ogg'} transcode what to convert the fetched
 *   bytes into, via `maybeTranscode`. `'none'` saves the original. All four are
 *   deliverable: `'wav'` renders a local WAV, `'mp3'`/`'ogg'` re-encode locally
 *   with the vendored encoders in `vendor/` (which must stay local — MV3's
 *   `script-src 'self'` CSP forbids loading an encoder from a CDN). Anything
 *   unrecognised, `null`, or the literal `'none'` resolves to `'none'`.
 * @property {number} wavSampleRate target rate for the `wav` rung only, Hz,
 *   clamped to [8000, 192000], default 48000. The `wav-48k` rung IGNORES this
 *   and pins 48000, which is what keeps the two rungs distinguishable.
 * @property {number} mp3Bitrate encoder bitrate in kbps for the `mp3` rung
 *   only. Valid MP3_BITRATES = [128, 160, 192, 224, 256, 320], default 192.
 *   An off-list value is SNAPPED to the nearest entry (200 -> 192), which also
 *   clamps it into range; a missing or non-numeric value yields 192. Never NaN,
 *   because it is handed straight to `lamejs.Mp3Encoder`.
 * @property {number} oggQuality encoder quality for the `ogg` rung only, 0.0
 *   (smallest) to 1.0 (largest). Valid OGG_QUALITIES = the tenths 0.0, 0.1 …
 *   1.0, default 0.5. Snapped to the nearest tenth; a missing or non-numeric
 *   value yields 0.5. Never NaN, because it is handed straight to
 *   `new OggVorbisEncoder(rate, channels, quality)`.
 * @property {number} syncMaxPages
 * @property {number} feedPageLimit page size asked of `POST /api/feed/v3`,
 *   clamped to [1, `SunoAPI.LIMITS.feedPageLimit`] and floored to a whole number,
 *   default 100. Coerced by `resolveFeedPageLimit`, which treats `null`/`''`/
 *   absent as MISSING rather than as 0 — otherwise a cleared field would mean
 *   "one clip per page". This is a CEILING ON WHAT WE ASK FOR, never a claim
 *   about what the server grants or about where the library ends: the ceiling is
 *   the shipped client's documented maximum and has never been checked against a
 *   live response, which is what `PROBE_FEED` exists to settle. An account that
 *   caps pages below this value is not truncated BY it — the cursor chain still
 *   walks to the end — but the `pagesFull`/`lastPageSize` figures reported per
 *   crawl will show it.
 * @property {'include'|'exclude'|'both'} dislikedMode
 * @property {boolean} autoSync
 * @property {number} syncIntervalMinutes
 * @property {boolean} dryRun
 *
 * Mid-batch quota guard. Both keys are set by the options page and re-read by
 * `startBatch` on every run; both are clamped so a corrupt or hand-edited blob
 * cannot disable the guard or turn it into a metered-rung polling loop.
 *
 * @property {number} quotaReserve downloads to keep in reserve. The guard stops
 *   the batch CLEANLY once `remaining <= quotaReserve`. Valid [0, 10000],
 *   default 0, meaning "stop the moment the meter is empty".
 * @property {number} quotaCheckEvery re-read the meter at most once per N
 *   SUCCESSFUL METERED downloads; unmetered rungs never count, so a purely
 *   unmetered batch polls zero times. Valid [1, 100], default 5. A value of 0
 *   would poll on every item (a quota-hammering loop) and is clamped up to 1.
 */

/** @type {Settings} cache; re-derived on every worker wake, never authoritative. */
let settingsCache = Object.assign({}, DEFAULT_SETTINGS);
let settingsLoaded = false;
let settingsLoadPromise = null;
let settingsWriteTimer = null;
let settingsWritePending = null;

/**
 * Coerce a stored/partial blob into a valid Settings object. Every key is
 * validated because a corrupt blob must not be able to produce a NaN rate or an
 * unsanitised path template.
 * @param {object} raw
 * @returns {Settings}
 */
function coerceSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = Object.assign({}, DEFAULT_SETTINGS);
  out.debug = input.debug === true;
  out.allowMeteredExtras = input.allowMeteredExtras === true;
  out.autoSync = input.autoSync === true;
  out.dryRun = input.dryRun === true;
  out.allowHlsCapture = input.allowHlsCapture === true;
  out.overwrite = input.overwrite === true;
  out.rateLimitJitter = input.rateLimitJitter !== false;
  out.rateLimit = clampNumber(input.rateLimit, 0.2, 20, DEFAULT_SETTINGS.rateLimit);
  out.concurrency = clampNumber(input.concurrency, 1, 8, DEFAULT_SETTINGS.concurrency);
  out.retryAttempts = clampNumber(input.retryAttempts, 0, 5, DEFAULT_SETTINGS.retryAttempts);
  out.dataUrlMaxBytes = clampNumber(input.dataUrlMaxBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULT_SETTINGS.dataUrlMaxBytes);
  out.wavSampleRate = clampNumber(input.wavSampleRate, 8000, 192000, DEFAULT_SETTINGS.wavSampleRate);
  out.syncMaxPages = clampNumber(input.syncMaxPages, 1, 2000, DEFAULT_SETTINGS.syncMaxPages);
  // Feed page size. Floored (a page size of 20.7 is not a page size) and clamped
  // to the client's documented ceiling; see `resolveFeedPageLimit` for why this is
  // not `clampNumber` alone.
  out.feedPageLimit = resolveFeedPageLimit(input.feedPageLimit, DEFAULT_SETTINGS.feedPageLimit);

  out.syncIntervalMinutes = clampNumber(input.syncIntervalMinutes, 5, 1440, DEFAULT_SETTINGS.syncIntervalMinutes);
  out.maxFolderDepth = clampNumber(input.maxFolderDepth, 0, 4, DEFAULT_SETTINGS.maxFolderDepth);
  out.folderDepth = clampNumber(input.folderDepth, 0, out.maxFolderDepth, DEFAULT_SETTINGS.folderDepth);
  // Alias-tolerant, unlike the old `VARIANTS.indexOf(...) >= 0` membership test,
  // which reverted a stored `mp3-320` to the default with no trace.
  out.variant = resolveVariant(input.variant, DEFAULT_SETTINGS.variant);
  out.filenameTemplate = typeof input.filenameTemplate === 'string' && input.filenameTemplate.trim()
    ? input.filenameTemplate.slice(0, 400)
    : DEFAULT_SETTINGS.filenameTemplate;
  out.artistPolicy = input.artistPolicy === 'clip-owner' ? 'clip-owner' : 'neutral';
  out.neutralArtist = typeof input.neutralArtist === 'string' ? input.neutralArtist.slice(0, 120) : DEFAULT_SETTINGS.neutralArtist;
  out.albumName = typeof input.albumName === 'string' ? input.albumName.slice(0, 120) : DEFAULT_SETTINGS.albumName;
  // `TRANSCODE_FORMATS` — WHY A RESOLVER AND NOT A BARE `indexOf`. The clamp
  // used to be hardcoded to `input.transcode === 'wav' ? 'wav' : 'none'`, which
  // made MP3/OGG permanently unreachable even though both encoders are now
  // vendored: `maybeTranscode` read this value, so `sunoTranscode` was dead code
  // and every `mp3`/`ogg` blob silently saved the original. `resolveTranscode`
  // keeps the two properties that actually matter — an unrecognised value still
  // degrades to `'none'` ("leave the original alone", the safe default for a
  // corrupt or hand-edited blob), and the occurrence is logged — while adding
  // the two formats this build can genuinely perform.
  out.transcode = resolveTranscode(input.transcode, DEFAULT_SETTINGS.transcode);
  // Encoder params. Snapped, never rejected, so a hand-typed 200 becomes 192
  // rather than a silent reset; and the fallback is resolved HERE so a missing
  // key can never reach an encoder as NaN.
  out.mp3Bitrate = snapToChoice(input.mp3Bitrate, MP3_BITRATES, DEFAULT_SETTINGS.mp3Bitrate);
  out.oggQuality = snapToChoice(input.oggQuality, OGG_QUALITIES, DEFAULT_SETTINGS.oggQuality);
  out.dislikedMode = ['include', 'exclude', 'both'].indexOf(input.dislikedMode) >= 0
    ? input.dislikedMode
    : DEFAULT_SETTINGS.dislikedMode;
  // Mid-batch quota guard. Clamped so a corrupt blob cannot disable the guard
  // (0 downloads) or turn it into a quota-polling loop (thousands).
  out.quotaReserve = clampNumber(input.quotaReserve, 0, 10000, DEFAULT_SETTINGS.quotaReserve);
  out.quotaCheckEvery = clampNumber(input.quotaCheckEvery, 1, 100, DEFAULT_SETTINGS.quotaCheckEvery);

  const ladder = normalizeLadder(input.downloadSource || input.sourceLadder, out.allowMeteredExtras);
  out.downloadSource = ladder;
  out.sourceLadder = ladder.slice();

  const tagIn = input.tagOptions && typeof input.tagOptions === 'object' ? input.tagOptions : {};
  const tagDefaults = DEFAULT_SETTINGS.tagOptions;
  out.tagOptions = {
    embed: boolOr(tagIn.embed, tagDefaults.embed),
    lyrics: boolOr(tagIn.lyrics, tagDefaults.lyrics),
    artwork: boolOr(tagIn.artwork, tagDefaults.artwork),
    bpm: boolOr(tagIn.bpm, tagDefaults.bpm),
    comment: boolOr(tagIn.comment, tagDefaults.comment),
    json: boolOr(tagIn.json, tagDefaults.json),
    lrc: boolOr(tagIn.lrc, tagDefaults.lrc),
  };
  return out;
}

/**
 * Normalise a ladder preference into real rung ids, preserving order, dropping
 * unknown and disabled entries, and always leaving the non-metered rungs first
 * unless the caller deliberately ordered otherwise.
 * @param {unknown} list
 * @param {boolean} allowMeteredExtras
 * @returns {string[]}
 */
function normalizeLadder(list, allowMeteredExtras) {
  const input = Array.isArray(list) ? list : [];
  const out = [];
  const unknown = [];
  for (const raw of input) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) continue;
    const mapped = LADDER_ALIASES[key] || [key];
    for (const id of mapped) {
      const rung = LADDER_BY_ID.get(id);
      if (!rung) {
        unknown.push(id);
        continue;
      }
      if (rung.optIn && !allowMeteredExtras) continue;
      if (rung.batchOnly) continue;
      if (out.indexOf(id) === -1) out.push(id);
    }
  }
  if (unknown.length) {
    log('warn', 'ladder.unknown_rungs_ignored', { unknown: Array.from(new Set(unknown)) });
  }
  if (out.length > 0) return out;
  // An EMPTY input means "not configured" and gets the standard ladder. A
  // non-empty input that yielded nothing means the user configured only rungs
  // that are disabled or batch-only — returning the default would silently
  // re-enable metered rungs they deliberately turned off.
  if (input.length === 0) return ['progressive', 'mango-drm', 'studio', 'download-route'];
  log('warn', 'ladder.empty_after_filtering', { requested: input });
  return [];
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * Snap a numeric setting onto the nearest allowed choice, or the fallback when
 * the value is unusable.
 *
 * WHY SNAP AND NOT REJECT. The encoder-facing settings (`mp3Bitrate`,
 * `oggQuality`) do not accept a range — LAME silently substitutes its own
 * bitrate for an unsupported one, and the offscreen document substitutes 0.8
 * for an out-of-range Ogg quality, so a value this helper let through as-is
 * would be discarded with no trace and the file would come out at a bitrate the
 * user never asked for. But outright reverting to the default is worse for a
 * hand-edited or imported blob: a user who typed 200 means "close to 192", and
 * silently getting 320 instead would be just as surprising. Nearest-choice
 * snapping also subsumes clamping — 10000 snaps up to the largest option and a
 * negative snaps down to the smallest, so no separate range check is needed.
 *
 * Ties snap to the LOWER option (`200` -> `192`, not `224`), so the result is a
 * deterministic function of the input rather than of iteration luck. One
 * consequence of doing this in plain float arithmetic rather than on scaled
 * integers: `0.55` lands on `0.6`, because `0.55 - 0.5` and `0.6 - 0.55` are
 * not bit-identical, so there is no tie to break. Harmless — either tenth is a
 * valid Ogg quality — but recorded so nobody "fixes" it by guessing.
 *
 * `null`, `''` and booleans are treated as MISSING rather than as 0/1, because
 * `Number(null)` is 0 and `Number(true)` is 1, which would otherwise quietly
 * mean "the lowest quality" for a key that was simply never set.
 *
 * @param {unknown} value
 * @param {ReadonlyArray<number>} choices non-empty, ascending
 * @param {number} fallback must be a member of `choices`; anything else falls
 *   back to `choices[0]`, so the return value is ALWAYS a member
 * @returns {number}
 */
function snapToChoice(value, choices, fallback) {
  const safe = choices.indexOf(fallback) >= 0 ? fallback : choices[0];
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return safe;
  const num = Number(value);
  if (!Number.isFinite(num)) return safe;
  let best = choices[0];
  let bestDistance = Math.abs(num - choices[0]);
  for (let i = 1; i < choices.length; i += 1) {
    const distance = Math.abs(num - choices[i]);
    if (distance < bestDistance) {
    best = choices[i];
    bestDistance = distance;
    }
  }
  return best;
}

/**
 * Resolve `settings.feedPageLimit` — the page size the crawl asks
 * `POST /api/feed/v3` for — to a whole number in [1, 100].
 *
 * WHY NOT `clampNumber`. Two things, both of which `clampNumber` gets wrong for
 * this key:
 *   - A page size must be an INTEGER. `limit: 20.7` is not a page size, and
 *     forwarding a float to the wire turns "ask for 20" into a request no server
 *     has ever been shown accepting.
 *   - `clampNumber(null)` returns `0` (because `Number(null) === 0`), which the
 *     clamp then raises to `1`. So a settings blob that carries the key with an
 *     explicit `null` — an exported file, an options page that clears the field,
 *     a JSON round trip — would silently turn a 5,500-clip crawl into a
 *     5,500-request crawl at one clip per page. A missing value is a missing
 *     value, not a request for the smallest legal page, which is why `null`,
 *     `undefined`, `''` and booleans are treated as absent here exactly as
 *     `snapToChoice` treats them.
 *
 * The range is [1, {@link SunoAPI.LIMITS}.feedPageLimit] and is read from the
 * client rather than restated, so this file and `lib/api.js` cannot disagree about
 * the ceiling. That ceiling is what the client will ASK for; it is not a verified
 * statement about what the server grants — see `DEFAULT_SETTINGS.feedPageLimit`.
 *
 * @param {unknown} value
 * @param {number} fallback used when `value` is absent or unusable
 * @returns {number} an integer in [1, 100]; never NaN, never 0
 */
function resolveFeedPageLimit(value, fallback) {
  const min = Number.isFinite(FEED_PAGE_LIMIT_RANGE.min) ? FEED_PAGE_LIMIT_RANGE.min : 1;
  const max = Number.isFinite(FEED_PAGE_LIMIT_RANGE.max) ? FEED_PAGE_LIMIT_RANGE.max : 100;
  const safe = Number.isFinite(fallback) ? Math.floor(fallback) : max;
  const bounded = Math.min(max, Math.max(min, safe));
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') {
    return bounded;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return bounded;
  return Math.min(max, Math.max(min, Math.floor(num)));
}


/**
 * Coerce anything to a finite number, or 0.
 *
 * WHY THIS EXISTS: every tempo read in this file used to be
 * `rec ? rec.bpm : Number(clip.bpm) || 0`. `rec` is truthy whenever
 * `lib/suno.js` registered, and `SunoFilter.normalize()` did not (yet) expose a
 * `bpm` field, so `rec.bpm` was permanently `undefined` — which made `bpm` a
 * non-number, rendered `{bpm}` as empty, and made `!(bpm > 0)` always true so
 * `tagOptions.bpm` paid for a `sunoAnalyze` round trip on every tagged file and
 * then wrote nothing. One coercion helper, used by every read, so the four
 * call sites cannot drift apart again.
 *
 * NOTE: `Number(undefined)` is NaN and `Number(null)` is 0, so a missing field
 * and a literal zero are indistinguishable on purpose: a caller only ever asks
 * "is there a usable tempo?", and the answer to both is "no".
 *
 * @param {unknown} value
 * @returns {number} a finite number, never NaN/undefined
 */
function numOr(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * The clip's tempo, from wherever it can be found.
 *
 * Source of truth is the normalized record, because that is the only shape that
 * survives the filter's normalizations; the raw clip and its `metadata` bag are
 * fallbacks for when `lib/suno.js` is absent or the record predates the field.
 * All of them go through `numOr`, so the result is always a real number and
 * `bpm > 0` is a meaningful test at every call site.
 *
 * @param {object|null} rec the `SunoFilter.normalize()` record, or null
 * @param {object|null} clip the raw clip record
 * @returns {number} a tempo, or 0 when the clip carries none
 */
function bpmFromClip(rec, clip) {
  return rec
    ? (numOr(rec.bpm) || numOr(clip && clip.bpm) || numOr(clip && clip.metadata && clip.metadata.bpm) || 0)
    : (numOr(clip && clip.bpm) || 0);
}

/**
 * Load settings once per worker lifetime. Safe to call concurrently.
 * @returns {Promise<Settings>}
 */
function loadSettings() {
  if (settingsLoaded) return Promise.resolve(settingsCache);
  if (settingsLoadPromise) return settingsLoadPromise;
  settingsLoadPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      settingsCache = coerceSettings(stored[STORAGE_KEYS.SETTINGS]);
    } catch (loadErr) {
      log('warn', 'settings.load_failed', { error: describeError(loadErr) });
      settingsCache = coerceSettings({});
    }
    settingsLoaded = true;
    applySettingsToLibraries();
    return settingsCache;
  })();
  return settingsLoadPromise;
}

/**
 * Push the settings that libraries care about (rate limit, logger) into
 * `SunoAPIClient`, so no call site ever bypasses the shared limiter.
 * @returns {void}
 */
function applySettingsToLibraries() {
  if (!SunoAPIClient || typeof SunoAPIClient.configure !== 'function') return;
  try {
    SunoAPIClient.configure({
      rateLimit: {
        ratePerSecond: settingsCache.rateLimit,
        concurrency: settingsCache.concurrency,
        jitter: settingsCache.rateLimitJitter,
      },
      tokenProvider: ({ force }) => getAuthToken({ force: !!force }),
      logger: libLogger('api'),
    });
  } catch (configErr) {
    log('error', 'settings.configure_api_failed', { error: describeError(configErr) });
  }
  if (SunoDB && typeof SunoDB.setLogger === 'function') {
    try {
      SunoDB.setLogger(libLogger('db'));
    } catch (dbLogErr) {
      log('warn', 'settings.logger_db_failed', { error: describeError(dbLogErr) });
    }
  }
}

/**
 * Bridge a library's logger into the ring buffer, prefixed by source.
 * @param {string} tag
 * @returns {{debug:Function,info:Function,warn:Function,error:Function}}
 */
function libLogger(tag) {
  const emit = (level) => (message, context) => log(level, `${tag}:${String(message)}`, context);
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/**
 * Merge a patch into settings and schedule a write-behind.
 * @param {object} patch
 * @returns {Promise<Settings>}
 */
async function updateSettings(patch) {
  await loadSettings();
  const merged = Object.assign({}, patch || {});
  // `downloadSource` is canonical and `sourceLadder` is the legacy alias the
  // page UI writes. Without this, the previously-stored canonical key shadows
  // the incoming alias and the user's ladder ordering is silently discarded.
  if (Object.prototype.hasOwnProperty.call(merged, 'sourceLadder')
      && !Object.prototype.hasOwnProperty.call(merged, 'downloadSource')) {
    merged.downloadSource = merged.sourceLadder;
  }
  settingsCache = coerceSettings(Object.assign({}, settingsCache, merged));
  applySettingsToLibraries();
  armSettingsWrite();
  return settingsCache;
}

/**
 * Reset to defaults.
 * @returns {Promise<Settings>}
 */
async function resetSettings() {
  settingsCache = coerceSettings({});
  applySettingsToLibraries();
  armSettingsWrite();
  return settingsCache;
}

/**
 * Coalesce settings writes so a slider drag is one storage write, not fifty.
 * @returns {void}
 */
function armSettingsWrite() {
  if (settingsWriteTimer !== null) return;
  settingsWriteTimer = setTimeout(() => {
    settingsWriteTimer = null;
    const pending = settingsWritePending;
    settingsWritePending = null;
    if (pending) void persistSettings(pending);
  }, 400);
  settingsWritePending = settingsCache;
}

/**
 * @param {Settings} value
 * @returns {Promise<void>}
 */
async function persistSettings(value) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: value });
  } catch (writeErr) {
    log('error', 'settings.persist_failed', { error: describeError(writeErr) });
  }
}

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see 15-quota.js.
 * `scripts/check-build.sh` asserts these names do not collide with a
 * monolith declaration.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUSettings = {
    loadSettings, updateSettings, resetSettings, persistSettings,
    coerceSettings, resolveFeedPageLimit,
  };
}
