/**
 * Suno Master Utility — options page
 * ===========================================================================
 * The one surface that can be trusted to describe the worker's behaviour
 * accurately, because it reads the worker's own reply rather than a local copy
 * of the defaults.
 *
 * ---------------------------------------------------------------------------
 * SETTINGS KEYS WRITTEN HERE — every one of these is read by
 * `background/background.js` §4 `coerceSettings()`. There are no others, and
 * nothing below writes a key the worker ignores:
 *
 *   debug, variant, downloadSource, allowMeteredExtras, rateLimit,
 *   rateLimitJitter, concurrency, retryAttempts, filenameTemplate, folderDepth,
 *   maxFolderDepth, overwrite, dataUrlMaxBytes,
 *   tagOptions.{embed,lyrics,artwork,bpm,comment,json,lrc},
 *   artistPolicy, neutralArtist, albumName, transcode, wavSampleRate,
 *   mp3Bitrate, oggQuality,
 *   syncMaxPages, dislikedMode, autoSync, syncIntervalMinutes, dryRun,
 *   allowHlsCapture, quotaReserve, quotaCheckEvery
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS WRITTEN THE WAY IT IS
 * ---------------------------------------------------------------------------
 * A. `send()` THROWS on `{ok:false}` and on an unreachable worker, so every
 *    failure reaches the user. The previous build's `msg()` resolved `null` on
 *    error and `saveSettings()` then reported "Settings saved" regardless.
 * B. EVERY settings load and save is AWAITED before the DOM is touched, and the
 *    whole form is disabled while a write is in flight. `resetSettings()` calls
 *    `loadSettings()` — which in the previous build was fired without `await`,
 *    so the form was repopulated with the values it already had.
 * C. The reply of `UPDATE_SETTINGS` / `RESET_SETTINGS` / `IMPORT_SETTINGS` is
 *    authoritative (the worker clamps every value), so the form is repainted
 *    from `reply.settings`, never from the raw DOM.
 * D. The download ladder is rendered and reordered with real buttons and real
 *    DOM nodes. No HTML-parsing sink is used anywhere; template strings only
 *    ever appear in `textContent` assignments.
 * E. All four transcode radios are live. background.js `coerceSettings()`
 *    resolves `transcode` through `TRANSCODE_FORMATS`, which is
 *    `none | wav | mp3 | ogg` — all four are deliverable, because both encoders
 *    are vendored locally in `vendor/` (see `vendor/README.md`) and MV3's
 *    `script-src 'self'` is satisfied by an ordinary local `<script>`. The
 *    `mp3Bitrate` and `oggQuality` selects below it are the encoder parameters
 *    for the two lossy rungs, and each is gated on its own format. A value the
 *    worker does NOT echo back is a genuine fault, not an expected clamp: it is
 *    reported inline by `transcodeMismatchText()`, and no such thing is claimed
 *    to be normal here.
 * F. The filename preview mirrors the worker's §8 expansion, including
 *    sanitisation, and says which clip it is previewing against.
 * G. The mid-batch quota guard has real controls. `quotaReserve` and
 *    `quotaCheckEvery` are read by `runBatch()` §12 on every batch; without
 *    them the whole guard was pinned at its defaults with no way to move it.
 * ===========================================================================
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ DOM */

  /**
   * Every control is looked up by id in one place so a renamed control is a
   * load-time failure here rather than a silent no-op later.
   */
  var C = {
    version: document.getElementById('sm-version'),
    status: document.getElementById('sm-status'),
    saved: document.getElementById('sm-saved'),
    savenote: document.getElementById('sm-savenote'),

    syncMaxPages: document.getElementById('opt-sync-max-pages'),
    dislikedMode: document.getElementById('opt-disliked-mode'),
    autoSync: document.getElementById('opt-auto-sync'),
    syncInterval: document.getElementById('opt-sync-interval'),

    variant: document.getElementById('opt-variant'),
    ladder: document.getElementById('opt-ladder'),
    ladderEmpty: document.getElementById('opt-ladder-empty'),
    pool: document.getElementById('opt-pool'),
    meteredExtras: document.getElementById('opt-metered-extras'),
    quotaReserve: document.getElementById('opt-quota-reserve'),
    quotaCheckEvery: document.getElementById('opt-quota-check-every'),
    quotaReserveHint: document.getElementById('opt-quota-reserve-h'),
    quotaCheckHint: document.getElementById('opt-quota-check-every-h'),
    overwrite: document.getElementById('opt-overwrite'),
    dataUrl: document.getElementById('opt-dataurl'),
    concurrency: document.getElementById('opt-concurrency'),
    rate: document.getElementById('opt-rate'),
    retries: document.getElementById('opt-retries'),
    jitter: document.getElementById('opt-jitter'),

    template: document.getElementById('opt-template'),
    folderDepth: document.getElementById('opt-folder-depth'),
    maxFolderDepth: document.getElementById('opt-max-folder-depth'),
    previewSrc: document.getElementById('opt-preview-src'),
    previewPath: document.getElementById('opt-preview-path'),
    tokens: document.getElementById('opt-tokens'),

    tagEmbed: document.getElementById('opt-tag-embed'),
    tagLyrics: document.getElementById('opt-tag-lyrics'),
    tagArtwork: document.getElementById('opt-tag-artwork'),
    tagBpm: document.getElementById('opt-tag-bpm'),
    tagComment: document.getElementById('opt-tag-comment'),
    tagLrc: document.getElementById('opt-tag-lrc'),
    tagJson: document.getElementById('opt-tag-json'),

    artistPolicy: document.getElementById('opt-artist-policy'),
    neutralArtist: document.getElementById('opt-neutral-artist'),
    album: document.getElementById('opt-album'),

    transcodeNone: document.getElementById('opt-transcode-none'),
    transcodeWav: document.getElementById('opt-transcode-wav'),
    transcodeMp3: document.getElementById('opt-transcode-mp3'),
    transcodeOgg: document.getElementById('opt-transcode-ogg'),
    transcodeHintNone: document.getElementById('opt-transcode-h'),
    transcodeHintWav: document.getElementById('opt-transcode-wav-h'),
    transcodeHintMp3: document.getElementById('opt-transcode-mp3-h'),
    transcodeHintOgg: document.getElementById('opt-transcode-ogg-h'),
    transcodeError: document.getElementById('opt-transcode-error'),
    wavRate: document.getElementById('opt-wav-rate'),
    mp3Bitrate: document.getElementById('opt-mp3-bitrate'),
    oggQuality: document.getElementById('opt-ogg-quality'),
    mp3BitrateHint: document.getElementById('opt-mp3-bitrate-h'),
    oggQualityHint: document.getElementById('opt-ogg-quality-h'),

    hls: document.getElementById('opt-hls'),
    dryRun: document.getElementById('opt-dry-run'),
    debug: document.getElementById('opt-debug'),

    exportBtn: document.getElementById('opt-export'),
    importBtn: document.getElementById('opt-import'),
    resetBtn: document.getElementById('opt-reset'),
    importFile: document.getElementById('opt-import-file'),

    saveBtn: document.getElementById('opt-save')
  };

  /** The sections whose controls are disabled while a write is in flight. */
  var FIELDSETS = Array.prototype.slice.call(document.querySelectorAll('.sm-fs'));

  /**
   * The encoder parameters offered by the two selects below the transcode radios.
   *
   * Mirrors background.js `MP3_BITRATES` and `OGG_QUALITIES`. The lists are named
   * rather than numeric ranges because neither encoder accepts a range: LAME
   * substitutes its own bitrate for an unsupported one and the offscreen page
   * substitutes 0.8 for an out-of-range Ogg quality, so a control offering a
   * free-typed number would let the setting be silently discarded. A `<select>`
   * makes every stored value valid by construction and needs no validation
   * messaging here.
   */
  var MP3_BITRATE_CHOICES = [
    { value: 128, label: '128 kbps — smallest file' },
    { value: 160, label: '160 kbps — smaller' },
    { value: 192, label: '192 kbps — balanced' },
    { value: 224, label: '224 kbps — higher' },
    { value: 256, label: '256 kbps — high' },
    { value: 320, label: '320 kbps — best quality' }
  ];

  var OGG_QUALITY_CHOICES = [
    { value: 0, label: '0.0 — smallest file, fastest encode' },
    { value: 0.1, label: '0.1' },
    { value: 0.2, label: '0.2' },
    { value: 0.3, label: '0.3' },
    { value: 0.4, label: '0.4' },
    { value: 0.5, label: '0.5 — balanced' },
    { value: 0.6, label: '0.6' },
    { value: 0.7, label: '0.7' },
    { value: 0.8, label: '0.8' },
    { value: 0.9, label: '0.9' },
    { value: 1, label: '1.0 — best quality, slowest encode' }
  ];

  function mp3BitrateValues() {
    return MP3_BITRATE_CHOICES.map(function (choice) { return choice.value; });
  }

  function oggQualityValues() {
    return OGG_QUALITY_CHOICES.map(function (choice) { return choice.value; });
  }

  /* --------------------------------------------------------------- state */

  var state = {
    settings: null,
    defaults: null,
    ladderDefs: [],
    variants: [],
    ladder: [],
    exampleClip: null,
    exampleSource: 'none',
    workspaceName: 'My Workspace',
    saving: false,
    debug: false,
    /** The inline transcode warning body; '' when there is nothing to say. */
    transcodeWarning: '',
    /**
     * The transcode value this page last WROTE, kept so the worker's reply can
     * be compared against it. See `applyTranscode`.
     */
    askedTranscode: ''
  };

  /* -------------------------------------------------------------- helpers */

  /**
   * The ONE debug-gated logger in this build.
   */
  function dbg() {
    if (!state.debug) return;
    var args = ['[sm-options]'];
    for (var i = 0; i < arguments.length; i += 1) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  /** @param {unknown} err */
  function textOf(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return 'unknown error';
  }

  /**
   * Snap a value onto the nearest member of an ascending choice list.
   *
   * Mirrors background.js `snapToChoice()`. It is NOT a second validation layer:
   * the worker's copy is the authority and is applied to every write. This only
   * decides which OPTION to paint when the page is handed a value the selects do
   * not carry — a settings object from a worker that predates these two keys
   * hands over `undefined`, and a `<select>` with no matching option silently
   * renders as BLANK, which reads as "this control is broken".
   *
   * @param {unknown} value
   * @param {ReadonlyArray<number>} choices ascending, non-empty
   * @param {number} fallback must be a member of `choices`
   * @returns {number} always a member of `choices`
   */
  function snapChoice(value, choices, fallback) {
    var safe = choices.indexOf(fallback) >= 0 ? fallback : choices[0];
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return safe;
    var num = Number(value);
    if (!isFinite(num)) return safe;
    var best = choices[0];
    var bestDistance = Math.abs(num - choices[0]);
    for (var i = 1; i < choices.length; i += 1) {
      var distance = Math.abs(num - choices[i]);
      if (distance < bestDistance) {
        best = choices[i];
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * @param {Element|null} node
   * @param {boolean} disabled
   */
  function setDisabled(node, disabled) {
    if (node) node.disabled = !!disabled;
  }

  function setStatus(message, kind) {
    C.status.textContent = message;
    C.status.classList.remove('is-ok', 'is-bad');
    if (kind) C.status.classList.add('is-' + kind);
  }

  var savedTimer = null;

  /** @param {string} message */
  function reportError(message) {
    C.saved.textContent = message;
    C.saved.hidden = false;
    if (savedTimer !== null) clearTimeout(savedTimer);
    savedTimer = setTimeout(function () {
      C.saved.hidden = true;
      savedTimer = null;
    }, 9000);
    setStatus(message, 'bad');
  }

  /**
   * Last-resort reporter. Every action below handles its own failures, so this
   * only ever fires for a genuine bug — and it exists so no promise in this file
   * can end as an unhandled rejection.
   *
   * @param {unknown} err
   */
  function reportUnexpected(err) {
    reportError('Unexpected failure: ' + textOf(err));
  }

  /** @param {string} message */
  function setSaveNote(message) {
    C.savenote.textContent = message || '';
  }

  /* ------------------------------------------------------------ transport */

  function ReqError(message, code) {
    var err = new Error(message);
    err.name = 'ReqError';
    err.code = code || 'failed';
    return err;
  }

  /**
   * Send one request and REQUIRE `{ok:true}`. Rejects on transport failure, on
   * a missing reply, and on an explicit refusal, so no caller can mistake a
   * failure for a success.
   *
   * @param {string} type
   * @param {object} [payload]
   * @returns {Promise<object>}
   */
  function send(type, payload) {
    dbg('send', type, payload || null);
    return chrome.runtime.sendMessage({ type: type, payload: payload || {} }).then(
      function (reply) {
        if (!reply || typeof reply !== 'object') {
          throw ReqError('The background worker did not reply to ' + type + '. It may have just been restarted.', 'no_reply');
        }
        if (reply.ok !== true) {
          throw ReqError(reply.error || (type + ' failed'), reply.code || 'failed');
        }
        dbg('reply', type, reply);
        return reply;
      },
      function (transportErr) {
        throw ReqError('The background worker is not reachable (' + textOf(transportErr) + ').', 'no_worker');
      }
    );
  }

  /* ------------------------------------------------------------ constants */

  /**
   * The template tokens `background.js` §8 `buildTemplateVars()` actually
   * substitutes. Mirrored here so the cheatsheet cannot drift from reality by
   * advertising a token the worker ignores.
   */
  var TEMPLATE_TOKENS = [
    { token: '{workspace}', desc: 'Project / workspace name, joined from the project feed. "My Workspace" when the clip has no project.' },
    { token: '{title}', desc: 'Clip title, sanitised. "untitled" when empty.' },
    { token: '{model}', desc: 'Model family label, e.g. "v5". "unknown-model" when Suno sends nothing usable.' },
    { token: '{artist}', desc: 'The artist tag resolved by the policy above — the neutral name, or the clip owner under a clip-owner policy.' },
    { token: '{year}', desc: 'UTC year of creation, four digits. Empty if the clip has no date.' },
    { token: '{month}', desc: 'UTC month, zero-padded ("01"–"12").' },
    { token: '{day}', desc: 'UTC day, zero-padded.' },
    { token: '{versionIndex}', desc: 'Ordinal among the batch items that share this title, so generated variants of one song number themselves.' },
    { token: '{clipIdShort}', desc: 'First 8 characters of the clip id. Stable and unique — the safest token to keep in a filename.' },
    { token: '{id}', desc: 'The whole clip id.' },
    { token: '{bpm}', desc: 'Tempo, if one is known or was measured. Empty otherwise; never invented.' },
    { token: '{ext}', desc: 'The file extension for the delivered variant. Omit it and the extension is appended automatically.' }
  ];

  /* ----------------------------------------------------------- populating */

  function populateVariants() {
    // Placeholder only: the worker's `VARIANTS` is the single source of truth and
    // normally arrives in `GET_SETTINGS`; this list only paints the select during
    // the one render before boot replies.
    var list = state.variants.length ? state.variants : ['m4a', 'wav-48k', 'wav'];
    C.variant.textContent = '';
    for (var i = 0; i < list.length; i += 1) {
      var value = String(list[i]);
      var option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      if (value === 'wav-48k') option.textContent = 'wav-48k (variant requested from Suno, not a local resample)';
      C.variant.appendChild(option);
    }
  }

  /**
   * Fill the two encoder-parameter selects from the worker's choice lists.
   *
   * Built in JS rather than written into the HTML so the options cannot drift
   * from `MP3_BITRATE_CHOICES` / `OGG_QUALITY_CHOICES`, and so each option's
   * `value` is `String(number)` — an Ogg quality of 0 must serialise as `"0"`,
   * not `"0.0"`, or the worker's `0.5` can never match the option it came from.
   *
   * @param {HTMLSelectElement} select
   * @param {ReadonlyArray<{value:number,label:string}>} choices
   */
  function populateChoice(select, choices) {
    if (!select) return;
    select.textContent = '';
    for (var i = 0; i < choices.length; i += 1) {
      var option = document.createElement('option');
      option.value = String(choices[i].value);
      option.textContent = choices[i].label;
      select.appendChild(option);
    }
  }

  function populateEncoderParams() {
    populateChoice(C.mp3Bitrate, MP3_BITRATE_CHOICES);
    populateChoice(C.oggQuality, OGG_QUALITY_CHOICES);
  }

  function populateTokenSheet() {
    C.tokens.textContent = '';
    for (var i = 0; i < TEMPLATE_TOKENS.length; i += 1) {
      var entry = TEMPLATE_TOKENS[i];
      var row = document.createElement('li');
      row.className = 'sm-token';

      var code = document.createElement('code');
      code.textContent = entry.token;

      var value = document.createElement('span');
      value.className = 'sm-token-val';
      value.textContent = entry.desc;

      row.appendChild(code);
      row.appendChild(value);
      C.tokens.appendChild(row);
    }
  }

  /**
   * Apply the authoritative settings object to every control.
   *
   * @param {object} s a `Settings` object straight from the worker
   */
  function applySettings(s) {
    state.settings = s;

    C.syncMaxPages.value = String(s.syncMaxPages);
    C.dislikedMode.value = s.dislikedMode;
    setDisabled(C.autoSync, false);
    C.autoSync.checked = s.autoSync === true;
    C.syncInterval.value = String(s.syncIntervalMinutes);

    C.variant.value = s.variant;
    // `allowMeteredExtras` must be applied BEFORE the ladder is rendered: the
    // pool's "Add" buttons are gated on it, so rendering first would draw them
    // from the previous value.
    C.meteredExtras.checked = s.allowMeteredExtras === true;
    state.ladder = Array.isArray(s.downloadSource) ? s.downloadSource.slice() : [];
    renderLadder();

    C.overwrite.checked = s.overwrite === true;
    C.dataUrl.value = String(s.dataUrlMaxBytes);
    C.concurrency.value = String(s.concurrency);
    C.rate.value = String(s.rateLimit);
    C.retries.value = String(s.retryAttempts);
    C.jitter.checked = s.rateLimitJitter === true;
    // The worker's reply is already clamped (0..10000 / 1..100), and it is the
    // same object `coerceSettings` will read back on the next batch, so what is
    // painted here is exactly what the guard will use.
    C.quotaReserve.value = String(s.quotaReserve);
    C.quotaCheckEvery.value = String(s.quotaCheckEvery);
    renderQuotaDefaults();

    C.template.value = s.filenameTemplate;
    C.maxFolderDepth.value = String(s.maxFolderDepth);
    C.folderDepth.value = String(Math.min(s.folderDepth, s.maxFolderDepth));

    var tags = s.tagOptions || {};
    C.tagEmbed.checked = tags.embed === true;
    C.tagLyrics.checked = tags.lyrics === true;
    C.tagArtwork.checked = tags.artwork === true;
    C.tagBpm.checked = tags.bpm === true;
    C.tagComment.checked = tags.comment === true;
    C.tagLrc.checked = tags.lrc === true;
    C.tagJson.checked = tags.json === true;

    C.artistPolicy.value = s.artistPolicy;
    C.neutralArtist.value = s.neutralArtist;
    C.album.value = s.albumName;

    applyTranscode(s.transcode);
    C.wavRate.value = String(s.wavSampleRate);
    // The worker's reply is already snapped to a member of each list, so the
    // select is painted from it directly; `snapChoice` is only the guard for a
    // reply that predates these keys and would otherwise paint a blank select.
    C.mp3Bitrate.value = String(snapChoice(s.mp3Bitrate, mp3BitrateValues(), 192));
    C.oggQuality.value = String(snapChoice(s.oggQuality, oggQualityValues(), 0.5));
    updateAudioAvailability();
    renderEncoderDefaults();

    C.hls.checked = s.allowHlsCapture === true;
    C.dryRun.checked = s.dryRun === true;
    C.debug.checked = s.debug === true;
    state.debug = s.debug === true;

    renderPreview();
  }

  /**
   * State the SHIPPED default of the two guard numbers, read from the worker's
   * own `DEFAULT_SETTINGS` instead of restating the numbers here, so the two
   * cannot drift apart. A `title` is used because the explanation already in
   * the DOM is the primary text.
   */
  function renderQuotaDefaults() {
    var defaults = state.defaults;
    if (!defaults) return;
    if (C.quotaReserveHint) C.quotaReserveHint.title = 'Shipped default: ' + String(defaults.quotaReserve);
    if (C.quotaCheckHint) C.quotaCheckHint.title = 'Shipped default: ' + String(defaults.quotaCheckEvery);
  }

  /**
   * State the SHIPPED default of the two encoder parameters, read from the
   * worker's own `DEFAULT_SETTINGS` instead of restating the numbers here, for
   * the same reason as `renderQuotaDefaults()` above.
   */
  function renderEncoderDefaults() {
    var defaults = state.defaults;
    if (!defaults) return;
    if (C.mp3BitrateHint) {
      C.mp3BitrateHint.title = 'Shipped default: ' + String(defaults.mp3Bitrate) + ' kbps';
    }
    if (C.oggQualityHint) {
      C.oggQualityHint.title = 'Shipped default: ' + String(defaults.oggQuality);
    }
  }

  /** Every transcode value this page offers. */
  var TRANSCODE_MODES = ['none', 'wav', 'mp3', 'ogg'];

  /** Display names for those values, shared by both warning paths. */
  var TRANSCODE_LABELS = { none: 'Nothing', wav: 'WAV', mp3: 'MP3', ogg: 'Ogg Vorbis' };

  /**
   * The transcode radio group. All four values are LIVE: the MP3 and Ogg Vorbis
   * encoders are vendored locally in `vendor/` (see `vendor/README.md`) and
   * loaded by the offscreen page from `chrome-extension://` URLs, so MV3's
   * `script-src 'self'` is satisfied by an ordinary local `<script>`, no remote
   * code is involved, and every encode happens on the user's own machine.
   * `TRANSCODE_FORMATS` in background.js admits exactly these four.
   *
   * A stored value this page does not recognise selects "Nothing" AND raises a
   * visible inline warning naming it. It is NOT repaired silently: rendering
   * "Nothing" with no word about it is a display that lies.
   *
   * Two ways a rewritten or unusable value reaches this page, both covered:
   *
   *   1. `IMPORT_SETTINGS` — the value arrives in the FILE, before any reply.
   *      `noteTranscodeValue()` reads it out of the parsed blob.
   *   2. A save whose reply holds a DIFFERENT transcode than the one sent. That
   *      is a fault, not an expected rewrite, and it is reported: see
   *      `transcodeMismatchText()`.
   *
   * @param {string} value
   */
  function applyTranscode(value) {
    var raw = value === null || value === undefined ? '' : String(value);
    var mode = TRANSCODE_MODES.indexOf(raw) >= 0 ? raw : 'none';
    C.transcodeNone.checked = mode === 'none';
    C.transcodeWav.checked = mode === 'wav';
    C.transcodeMp3.checked = mode === 'mp3';
    C.transcodeOgg.checked = mode === 'ogg';
    updateTranscodeHint(mode);
    updateAudioAvailability();

    // The worker holding something other than what was just asked for is a
    // genuine fault: every one of the four values is deliverable, so any other
    // outcome means the write did not take. It must never be silent.
    if (state.askedTranscode !== '' && raw !== state.askedTranscode) {
      state.transcodeWarning = transcodeMismatchText(state.askedTranscode, raw);
    } else if (TRANSCODE_MODES.indexOf(raw) < 0) {
      state.transcodeWarning = transcodeWarningText(raw, false);
    }
    renderTranscodeWarning();
  }

  /**
   * A save that came back holding a different transcode than the one sent. Both
   * values are named, and the message says plainly that this is not expected.
   *
   * @param {string} asked what this page sent
   * @param {string} stored what the worker's reply reported back
   * @returns {string}
   */
  function transcodeMismatchText(asked, stored) {
    var askedLabel = TRANSCODE_LABELS[asked] || asked;
    var storedLabel = TRANSCODE_LABELS[stored] || stored;
    return 'You chose ' + askedLabel + ' and pressed Save, but the worker reported ' + storedLabel
      + ' back. That is not an expected outcome \u2014 all four of these values are deliverable \u2014 '
      + 'so either the worker is not the build these settings describe, or the write did not take. '
      + 'Nothing was transcoded, and the radio above now shows what is genuinely stored ('
      + storedLabel + '). Press Save again to try once more.';
  }

  /**
   * The one genuine fault on load: a stored `transcode` outside
   * `TRANSCODE_MODES`, which `resolveTranscode()` has already reduced to
   * `'none'` (and logged).
   *
   * @param {string} raw the offending value
   * @param {boolean} imported true when it came out of an imported file
   * @returns {string} '' when nothing needs saying
   */
  function transcodeWarningText(raw, imported) {
    if (raw === '' || TRANSCODE_MODES.indexOf(raw) >= 0) return '';

    return 'The stored transcode value is "' + raw + '", which is not a value this build can '
      + 'deliver, so the radio above shows Nothing. '
      + (imported
        ? 'It came from the file you imported: the worker resolved it to Nothing, so nothing is '
          + 'being asked for any more \u2014 but the file was not honoured, and it was not quietly '
          + 'rewritten here either.'
        : 'Nothing was changed on disk: saving stores Nothing, and until you save the setting '
          + 'still reads "' + raw + '". Pick a value above and press Save to replace it.');
  }

  /**
   * Record a transcode value read out of an imported file, before the worker
   * answers, so a value the file asked for cannot vanish without a word.
   *
   * @param {unknown} value
   * @param {boolean} [imported]
   */
  function noteTranscodeValue(value, imported) {
    var raw = value === null || value === undefined ? '' : String(value);
    state.transcodeWarning = transcodeWarningText(raw, imported === true);
    renderTranscodeWarning();
  }

  function renderTranscodeWarning() {
    var warn = C.transcodeError;
    if (!warn) return;
    var text = state.transcodeWarning || '';
    warn.textContent = text;
    warn.hidden = !text;
  }

  function clearTranscodeWarning() {
    state.transcodeWarning = '';
    renderTranscodeWarning();
  }

  function updateTranscodeHint(mode) {
    C.transcodeHintNone.hidden = mode !== 'none';
    C.transcodeHintWav.hidden = mode !== 'wav';
    if (C.transcodeHintMp3) C.transcodeHintMp3.hidden = mode !== 'mp3';
    if (C.transcodeHintOgg) C.transcodeHintOgg.hidden = mode !== 'ogg';
  }

  /** The currently selected radio's value, or 'none' if somehow none is checked. */
  function selectedTranscode() {
    if (C.transcodeWav.checked) return 'wav';
    if (C.transcodeMp3.checked) return 'mp3';
    if (C.transcodeOgg.checked) return 'ogg';
    return 'none';
  }

  /**
   * Gate the three conversion-parameter controls on the format that reads them.
   *
   * Only `.disabled` and `aria-disabled` are touched — never `.value`. That is
   * what preserves a choice made under one format across a switch: MP3 -> Ogg ->
   * MP3 comes back to the bitrate that was picked, because nothing here ever
   * cleared it. The native `disabled` attribute is set alongside `aria-disabled`
   * so the state is announced as well as enforced, which is how the WAV rate
   * control has always reported it.
   */
  function updateAudioAvailability() {
    gateOnTranscode(C.wavRate, C.transcodeWav);
    gateOnTranscode(C.mp3Bitrate, C.transcodeMp3);
    gateOnTranscode(C.oggQuality, C.transcodeOgg);
  }

  /**
   * @param {HTMLSelectElement|null} select
   * @param {HTMLInputElement} radio
   */
  function gateOnTranscode(select, radio) {
    if (!select) return;
    var on = radio.checked === true;
    select.disabled = !on;
    select.setAttribute('aria-disabled', String(!on));
  }

  /* ---------------------------------------------------------------- ladder */

  function rungDef(id) {
    for (var i = 0; i < state.ladderDefs.length; i += 1) {
      if (state.ladderDefs[i].id === id) return state.ladderDefs[i];
    }
    return null;
  }

  /**
   * Rungs this editor will let you order.
   *
   * Two are excluded on purpose:
   *   `hls` — the worker's own note says "Not a rung"; stream capture is gated
   *           by "Allow HLS stream capture" in Advanced, and listing it among
   *           the others would suggest it can be positioned against them.
   *   `zip` — declared `batchOnly`, so `normalizeLadder()` drops it from the
   *           stored list unconditionally. Offering it would be offering a
   *           control that cannot take effect.
   */
  function editableRungs() {
    return state.ladderDefs.filter(function (rung) {
      return rung && rung.id !== 'hls' && rung.batchOnly !== true;
    });
  }

  /**
   * Render the ordered ladder with real up / down / remove buttons.
   *
   * Every label, id, note and cost pill is written with `textContent`, so a rung
   * note or id can never inject markup.
   */
  function renderLadder() {
    C.ladder.textContent = '';
    C.ladderEmpty.hidden = state.ladder.length > 0;

    var lastIndex = state.ladder.length - 1;

    // `forEach` rather than a `for` loop: every handler below closes over the
    // index, and a `var` loop variable would leave all of them sharing the
    // final value — which makes "move up" and "remove" act on the wrong row.
    state.ladder.forEach(function (rawId, index) {
      var id = String(rawId);
      var def = rungDef(id);
      var row = document.createElement('li');
      row.className = 'sm-rung';

      var pos = document.createElement('span');
      pos.className = 'sm-rung-pos';
      pos.textContent = String(index + 1);
      pos.setAttribute('aria-hidden', 'true');

      var body = document.createElement('div');
      body.className = 'sm-rung-body';

      var label = document.createElement('div');
      label.className = 'sm-rung-label';

      var nameNode = document.createElement('span');
      nameNode.textContent = def ? def.label : id;

      var idNode = document.createElement('span');
      idNode.className = 'sm-rung-id';
      idNode.textContent = id;

      var pill = document.createElement('span');
      pill.className = 'pill ' + (def && def.metered ? 'pill-metered' : 'pill-free');
      pill.textContent = def && def.metered ? 'METERED' : 'UNMETERED';

      label.appendChild(nameNode);
      label.appendChild(idNode);
      label.appendChild(pill);

      if (def && def.optIn) {
        var optPill = document.createElement('span');
        optPill.className = 'pill pill-optin';
        optPill.textContent = 'OPT-IN';
        label.appendChild(optPill);
      }

      var note = document.createElement('p');
      note.className = 'sm-rung-note';
      note.textContent = def ? def.note : 'Unknown rung id; the worker will ignore it.';

      body.appendChild(label);
      body.appendChild(note);

      var ops = document.createElement('div');
      ops.className = 'sm-rung-ops';

      var up = iconButton(
        '↑',
        index === 0
          ? id + ' is already the first rung'
          : 'Move ' + id + ' up to position ' + index,
        index === 0,
        false,
        function () { moveRung(index, -1); }
      );
      var down = iconButton(
        '↓',
        index === lastIndex
          ? id + ' is already the last rung'
          : 'Move ' + id + ' down to position ' + (index + 2),
        index === lastIndex,
        false,
        function () { moveRung(index, 1); }
      );
      var remove = iconButton(
        '×',
        'Remove ' + id + ' from the ladder',
        false,
        true,
        function () { removeRung(index); }
      );

      ops.appendChild(up);
      ops.appendChild(down);
      ops.appendChild(remove);

      row.appendChild(pos);
      row.appendChild(body);
      row.appendChild(ops);
      C.ladder.appendChild(row);
    });

    renderPool();
  }

  /**
   * Render the rungs that are NOT currently in the ladder.
   */
  function renderPool() {
    C.pool.textContent = '';
    var extras = C.meteredExtras.checked === true;

    editableRungs().forEach(function (rung) {
      if (!rung || state.ladder.indexOf(rung.id) >= 0) return;

      var blocked = rung.optIn === true && !extras;
      var item = document.createElement('li');
      item.className = 'sm-pool-item' + (blocked ? ' is-blocked' : '');

      var name = document.createElement('span');
      name.textContent = rung.id;

      var pill = document.createElement('span');
      pill.className = 'pill ' + (rung.metered ? 'pill-metered' : 'pill-free');
      pill.textContent = rung.metered ? 'METERED' : 'UNMETERED';

      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'sm-btn sm-btn-s';
      add.disabled = blocked;
      add.textContent = blocked ? 'needs "allow metered extras"' : 'Add';
      add.setAttribute(
        'aria-label',
        blocked
          ? 'Cannot add ' + rung.id + ': it is metered and opt-in, so "allow metered extras" must be on first'
          : 'Add ' + rung.id + ' to the bottom of the download ladder'
      );
      add.addEventListener('click', function () {
        state.ladder.push(rung.id);
        renderLadder();
        markDirty();
      });

      item.appendChild(name);
      item.appendChild(pill);
      item.appendChild(add);
      C.pool.appendChild(item);
    });
  }

  /** @param {number} index */
  function removeRung(index) {
    if (index < 0 || index >= state.ladder.length) return;
    var nextFocus = index > 0 ? index - 1 : 0;
    state.ladder.splice(index, 1);
    renderLadder();
    markDirty();
    focusRung(nextFocus);
  }

  /**
   * @param {string} glyph
   * @param {string} label
   * @param {boolean} disabled
   * @param {boolean} danger
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  function iconButton(glyph, label, disabled, danger, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sm-iconbtn' + (danger ? ' is-danger' : '');
    button.textContent = glyph;
    button.disabled = disabled === true;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * Keep keyboard focus on the row the user just acted on. Without this, a
   * keyboard user is dropped back to the top of the document after every
   * reorder, because `renderLadder()` replaced the row they were standing on.
   *
   * @param {number} index
   * @param {number} [slot] 0 = up, 1 = down, 2 = remove
   */
  function focusRung(index, slot) {
    var rows = C.ladder.querySelectorAll('.sm-rung');
    var row = rows[index];
    if (!row) return;
    var buttons = row.querySelectorAll('button');
    if (!buttons.length) return;
    var target = typeof slot === 'number' ? buttons[slot] : buttons[buttons.length - 1];
    if (target && typeof target.focus === 'function') target.focus();
  }

  /** @param {number} index @param {number} delta */
  function moveRung(index, delta) {
    var target = index + delta;
    if (target < 0 || target >= state.ladder.length) return;
    var moved = state.ladder.splice(index, 1)[0];
    state.ladder.splice(target, 0, moved);
    renderLadder();
    markDirty();
    // Land on the same-direction control in the row's new position, falling
    // back to the other one when it has reached the end and become disabled.
    focusRung(target, delta > 0 ? 0 : 1);
  }

  /* ----------------------------------------------------------- previewing */

  /**
   * Fetch one real clip to preview the template against.
   *
   * A synthetic fallback is used when the library is empty, and it is LABELLED
   * as synthetic — a preview that silently invents a plausible-looking example
   * is worse than one that admits it has no data.
   */
  async function loadExampleClip() {
    try {
      var reply = await send('GET_CLIPS', { spec: {}, limit: 1, offset: 0, sort: 'newest', order: 'desc' });
      var clips = Array.isArray(reply.clips) ? reply.clips : [];
      if (clips.length && clips[0] && typeof clips[0] === 'object') {
        state.exampleClip = clips[0];
        var title = String(clips[0].title || '').trim();
        state.exampleSource = 'newest clip in your library'
          + (title ? ': “' + (title.length > 48 ? title.slice(0, 48) + '…' : title) + '”' : ' (untitled)');
        return;
      }
      state.exampleClip = syntheticClip();
      state.exampleSource = 'synthetic example — sync your library to preview against a real clip';
    } catch (err) {
      state.exampleClip = syntheticClip();
      state.exampleSource = 'synthetic example — GET_CLIPS failed (' + textOf(err) + ')';
    }
  }

  function syntheticClip() {
    return {
      id: 'a1b2c3d4e5f60718',
      title: 'Midnight Drive (Demo)',
      created_at: '2026-09-14T21:07:33.000Z',
      bpm: 118,
      metadata: { major_model_version: 'v5', tags: 'synthwave, night drive' },
      projectIds: ['default']
    };
  }

  /** Mirrors §8 `buildTemplateVars()` closely enough for a faithful preview. */
  function previewVars(clip) {
    var s = state.settings || {};
    var meta = (clip && clip.metadata) || {};
    var createdMs = Date.parse(String((clip && clip.created_at) || ''));
    var created = isFinite(createdMs) ? new Date(createdMs) : null;
    var id = String((clip && clip.id) || '');
    var policy = s.artistPolicy === 'clip-owner';
    var owner = String((clip && clip.display_name) || '');

    return {
      workspace: state.workspaceName || 'My Workspace',
      title: String((clip && clip.title) || '') || 'untitled',
      model: String(meta.major_model_version || (clip && clip.model_name) || '') || 'unknown-model',
      artist: policy && owner ? owner : String(s.neutralArtist || 'Suno'),
      year: created ? String(created.getUTCFullYear()) : '',
      month: created ? String(created.getUTCMonth() + 1).padStart(2, '0') : '',
      day: created ? String(created.getUTCDate()).padStart(2, '0') : '',
      versionIndex: '1',
      clipIdShort: id ? id.slice(0, 8) : '',
      id: id,
      bpm: Number(clip && clip.bpm) > 0 ? String(Math.round(Number(clip.bpm))) : '',
      format: extensionFor(s.variant),
      ext: extensionFor(s.variant)
    };
  }

  /**
   * Mirrors §8 `extensionFor()` — the canonical variant -> extension map.
   *
   * §8 resolves the id through `resolveVariant()` FIRST, so a stored `mp3-320`
   * reaches the worker as `m4a` and the file is written `.m4a`. Branching on the
   * removed ids here instead previewed an extension this build never writes.
   */
  function extensionFor(variant) {
    var v = String(variant || '').toLowerCase();
    if (v === 'wav' || v === 'wav-48k') return 'wav';
    return 'm4a';
  }

  /** Mirrors §8 `sanitizeSegment()`. */
  var CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g;
  var ILLEGAL_RE = /[\\/:*?"<>|]/g;
  var RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  function sanitizeSegment(value, maxLen) {
    var limit = maxLen || 100;
    var text = value === null || value === undefined ? '' : String(value);
    try { text = text.normalize('NFC'); } catch (normErr) { void normErr; }
    // Control characters and bidi overrides first, exactly as §8 does: they are
    // invisible, so stripping them after the visible characters are replaced
    // would let a bidi override ride along inside an otherwise clean segment.
    text = text.replace(CONTROL_RE, '');
    text = text.replace(ILLEGAL_RE, '_');
    text = text.replace(/\s+/g, ' ').trim();
    text = text.replace(/\.{2,}/g, '.');
    text = text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (!text) return '_';
    if (RESERVED_RE.test(text)) text = '_' + text;
    if (text.length > limit) text = text.slice(0, limit).replace(/[.\s]+$/, '');
    return text || '_';
  }

  /** Mirrors §8 `buildDownloadPath()`. */
  function previewPath() {
    var s = state.settings || {};
    var vars = previewVars(state.exampleClip);
    var template = C.template.value.trim() || '{title}_{clipIdShort}.{ext}';
    var expanded = template;
    Object.keys(vars).forEach(function (key) {
      expanded = expanded.split('{' + key + '}').join(vars[key]);
    });
    expanded = expanded.replace(/\{[a-zA-Z]+\}/g, '_');

    var rawParts = expanded.split('/').filter(function (part) { return part.trim() !== ''; });
    var name = rawParts.length ? rawParts[rawParts.length - 1] : 'untitled';
    var folderParts = rawParts.slice(0, -1);

    var maxDepth = Math.min(4, Math.max(0, Number(s.maxFolderDepth) || 0));
    var depth = Math.min(folderParts.length, maxDepth, Math.max(0, Number(s.folderDepth) || 0));
    var folders = folderParts.slice(0, depth).map(function (part) { return sanitizeSegment(part, 80); });

    var ext = extensionFor(s.variant);
    var base = sanitizeSegment(name, 180);
    if (!/\.[A-Za-z0-9]{1,6}$/.test(base)) base = base.replace(/[.\s]+$/, '') + '.' + ext;

    return folders.concat([base]).join('/');
  }

  function renderPreview() {
    var path = previewPath();
    C.previewPath.textContent = path;
    C.previewPath.title = path;
    C.previewSrc.textContent = 'against the ' + state.exampleSource;
  }

  /* ------------------------------------------------------- collect / save */

  /**
   * @param {Element} input
   * @param {number} fallback
   * @returns {number}
   */
  function numberOf(input, fallback) {
    var num = Number(input.value);
    return isFinite(num) ? num : fallback;
  }

  /**
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampInt(value, min, max, fallback) {
    var num = Number(value);
    if (!isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  }

  /**
   * Build the patch from the DOM. The key names here ARE the worker's settings
   * keys; there is no translation layer to get wrong.
   *
   * @returns {object}
   */
  function collectPatch() {
    var maxDepth = Math.max(0, Math.min(4, Math.round(numberOf(C.maxFolderDepth, 4))));
    var folderDepth = Math.max(0, Math.min(maxDepth, Math.round(numberOf(C.folderDepth, 0))));
    var variant = C.variant.value;
    var transcode = selectedTranscode();

    return {
      /* ---- library sync ---- */
      syncMaxPages: Math.round(numberOf(C.syncMaxPages, 200)),
      dislikedMode: ['include', 'exclude', 'both'].indexOf(C.dislikedMode.value) >= 0 ? C.dislikedMode.value : 'exclude',
      autoSync: C.autoSync.checked === true,
      syncIntervalMinutes: Math.round(numberOf(C.syncInterval, 60)),

      /* ---- download ---- */
      variant: variant,
      downloadSource: state.ladder.slice(),
      allowMeteredExtras: C.meteredExtras.checked === true,
      // Mid-batch quota guard. Clamped to the worker's own bounds here as well,
      // so an out-of-range number is corrected in the form the user is looking
      // at rather than only in the reply that repaints it.
      quotaReserve: clampInt(numberOf(C.quotaReserve, 0), 0, 10000, 0),
      quotaCheckEvery: clampInt(numberOf(C.quotaCheckEvery, 5), 1, 100, 5),
      overwrite: C.overwrite.checked === true,
      dataUrlMaxBytes: Math.round(numberOf(C.dataUrl, 24 * 1024 * 1024)),
      concurrency: Math.round(numberOf(C.concurrency, 3)),
      retryAttempts: Math.round(numberOf(C.retries, 2)),
      rateLimit: Number(numberOf(C.rate, 4).toFixed(2)),
      rateLimitJitter: C.jitter.checked === true,

      /* ---- naming ---- */
      filenameTemplate: C.template.value,
      folderDepth: folderDepth,
      maxFolderDepth: maxDepth,

      /* ---- tags ---- */
      tagOptions: {
        embed: C.tagEmbed.checked === true,
        lyrics: C.tagLyrics.checked === true,
        artwork: C.tagArtwork.checked === true,
        bpm: C.tagBpm.checked === true,
        comment: C.tagComment.checked === true,
        json: C.tagJson.checked === true,
        lrc: C.tagLrc.checked === true
      },

      /* ---- artist ---- */
      artistPolicy: C.artistPolicy.value === 'clip-owner' ? 'clip-owner' : 'neutral',
      neutralArtist: C.neutralArtist.value,
      albumName: C.album.value,

      /* ---- audio ---- */
      transcode: transcode,
      wavSampleRate: Math.round(numberOf(C.wavRate, 48000)),
      // Encoder parameters for the two lossy rungs. A `<select>` can only hold a
      // listed value, and the worker snaps whatever arrives, so these are always
      // valid by construction — no client-side validation to keep in step.
      mp3Bitrate: snapChoice(C.mp3Bitrate.value, mp3BitrateValues(), 192),
      oggQuality: snapChoice(C.oggQuality.value, oggQualityValues(), 0.5),

      /* ---- advanced ---- */
      allowHlsCapture: C.hls.checked === true,
      dryRun: C.dryRun.checked === true,
      debug: C.debug.checked === true
    };
  }

  /**
   * Warn about a patch before it is written, in the worker's own terms.
   *
   * @param {object} patch
   * @returns {boolean} false when the user cancelled
   */
  function confirmRiskyChanges(patch) {
    var settings = state.settings || {};
    var notes = [];

    if (patch.allowHlsCapture === true && settings.allowHlsCapture !== true) {
      notes.push('Allowing HLS stream capture makes the content script temporarily set '
        + 'window.MediaSource = undefined on Suno\'s player so the stream can be fetched as plain '
        + 'segments. That manipulates the page and can trip abuse heuristics on Suno\'s side.');
    }
    if (Array.isArray(patch.downloadSource) && patch.downloadSource.some(isMeteredId)) {
      var metered = patch.downloadSource.filter(isMeteredId);
      notes.push('Your ladder will contain ' + metered.length + ' METERED ' + (metered.length === 1 ? 'rung' : 'rungs')
        + ' (' + metered.join(', ') + '). Any clip whose unmetered rungs fail will fall through '
        + 'to one of those and spend one of your monthly downloads.');
    }
    if (patch.folderDepth > 2 || patch.maxFolderDepth > 2) {
      notes.push('Folder depth ' + patch.folderDepth + ' (ceiling ' + patch.maxFolderDepth + ') nests files '
        + Math.min(patch.folderDepth, patch.maxFolderDepth) + ' levels deep inside your downloads folder.');
    }
    if (patch.dryRun === true && settings.dryRun !== true) {
      notes.push('With dry run on, every batch will be planned and recorded and then stop. Nothing will be downloaded.');
    }

    if (!notes.length) return true;
    return window.confirm('Please read before saving:\n\n• ' + notes.join('\n• ') + '\n\nSave anyway?');
  }

  var METERED_IDS = ['studio', 'download-route', 'wav-official', 'zip'];

  function isMeteredId(id) {
    return METERED_IDS.indexOf(String(id)) >= 0;
  }

  /* --------------------------------------------------------- form locking */

  function setFormLocked(locked) {
    for (var i = 0; i < FIELDSETS.length; i += 1) FIELDSETS[i].disabled = locked;
    setDisabled(C.saveBtn, locked);
    setDisabled(C.exportBtn, locked);
    setDisabled(C.importBtn, locked);
    setDisabled(C.resetBtn, locked);
  }

  function markDirty() {
    setSaveNote('Unsaved changes.');
  }

  /* ------------------------------------------------------------- save flow */

  async function saveSettings() {
    if (state.saving) return;
    var patch = collectPatch();

    if (!patch.filenameTemplate.trim()) {
      reportError('The filename template cannot be empty. Put something like {title}_{clipIdShort}.{ext} in it.');
      C.template.focus();
      return;
    }
    if (patch.filenameTemplate.indexOf('/') === 0) {
      reportError('A leading "/" is rejected: paths are always relative to your downloads folder. Remove it and use folder names after the template instead.');
      C.template.focus();
      return;
    }
    if (!confirmRiskyChanges(patch)) {
      setSaveNote('Save cancelled.');
      return;
    }
    if (patch.allowHlsCapture === true && (state.settings || {}).allowHlsCapture !== true) {
      // Belt and braces: the danger is stated twice on purpose, because turning
      // it on is the one change here that can affect how the page behaves.
      var again = window.confirm('Last confirmation on HLS capture.\n\n'
        + 'This patches Suno\'s own player in every open suno.com tab and can interrupt playback, '
        + 'and it manipulates the page in a way that can trip abuse detection.\n\nEnable it?');
      if (!again) {
        patch.allowHlsCapture = false;
        C.hls.checked = false;
        setSaveNote('HLS capture left off.');
      }
    }

    state.saving = true;
    setFormLocked(true);
    setStatus('Saving…');

    try {
      var reply = await send('UPDATE_SETTINGS', { settings: patch });
      // The worker's reply is authoritative: it clamps every number, so
      // repaint from it rather than from the DOM the user was looking at.
      state.debug = reply.settings.debug === true;
      // Remember what was asked so `applyTranscode` can report a save that came
      // back holding a different value. It is cleared again below, once the reply
      // has been compared.
      state.askedTranscode = patch.transcode;
      applySettings(reply.settings);
      state.askedTranscode = '';
      if (state.transcodeWarning) {
        setStatus('Saved, but the worker did not keep the transcode you chose.', 'bad');
        setSaveNote('Saved just now — see the warning under "Audio conversion".');
      } else {
        setStatus('Saved.', 'ok');
        setSaveNote('Saved just now.');
      }
      renderLadder();
    } catch (err) {
      reportError('Could not save: ' + textOf(err));
    } finally {
      state.saving = false;
      setFormLocked(false);
    }
  }

  /* ------------------------------------------------------------ reset flow */

  async function resetSettings() {
    if (state.saving) return;
    var ok = window.confirm(
      'Reset every setting to its default?\n\n'
      + 'This changes settings only. Your indexed library, download history, and any files already '
      + 'saved to disk are untouched — but the ladder goes back to its default order (which includes '
      + 'two metered rungs), folder depth resets, and every tag option returns to its default.'
    );
    if (!ok) return;

    state.saving = true;
    setFormLocked(true);
    setStatus('Resetting…');

    try {
      var reply = await send('RESET_SETTINGS', {});
      // AWAITED, then repainted. The previous build fired `loadSettings()`
      // without awaiting it, so the form kept showing the values it already
      // had and the user could not tell whether the reset had happened.
      state.askedTranscode = '';
      applySettings(reply.settings);
      clearTranscodeWarning();
      renderLadder();
      setStatus('Reset to defaults.', 'ok');
      setSaveNote('Defaults restored just now.');
      C.template.focus();
    } catch (err) {
      reportError('Could not reset: ' + textOf(err));
    } finally {
      state.saving = false;
      setFormLocked(false);
    }
  }

  /* ----------------------------------------------------------- export flow */

  /** @param {string} text @returns {string} a data: URL safe for chrome.downloads */
  function toDataUrl(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return 'data:application/json;base64,' + btoa(binary);
  }

  async function exportSettings() {
    if (state.saving) return;
    state.saving = true;
    setFormLocked(true);
    setStatus('Exporting…');

    var objectUrl = null;
    try {
      var reply = await send('EXPORT_SETTINGS', {});
      var payload = {
        exportedAt: new Date(reply.exportedAt || Date.now()).toISOString(),
        extensionVersion: reply.version,
        settings: reply.settings,
        projects: reply.projects,
        quota: reply.quota
      };
      var json = JSON.stringify(payload, null, 2);

      // A `data:` URL is used rather than a blob URL: MV3's CSP makes blob
      // navigation unreliable from an extension page, and `data:` needs no
      // object-URL lifetime management. The blob URL is minted ONLY in the
      // fallback branch below — creating it up front meant a host without
      // `URL.createObjectURL` failed the whole export even though the `data:`
      // path never needed it.
      try {
        await chrome.downloads.download({
          url: toDataUrl(json),
          filename: 'suno-master-utility-settings.json',
          saveAs: true,
          conflictAction: 'uniquify'
        });
      } catch (downloadErr) {
        dbg('data: download refused, falling back to an anchor', textOf(downloadErr));
        objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        await anchorDownload(objectUrl, 'suno-master-utility-settings.json');
      }

      setStatus('Exported.', 'ok');
      setSaveNote('Export written to your downloads.');
    } catch (err) {
      reportError('Could not export: ' + textOf(err));
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      state.saving = false;
      setFormLocked(false);
    }
  }

  /**
 * Fallback save path when `chrome.downloads.download` refuses the `data:` URL.
 * A programmatic click cannot report an outcome, so this resolves optimistically
 * and the status line tells the user where to look.
 *
 * @param {string} url
 * @param {string} filename
 * @returns {Promise<void>}
 */
  function anchorDownload(url, filename) {
    return new Promise(function (resolve) {
      try {
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      } catch (anchorErr) {
        dbg('anchor download failed:', textOf(anchorErr));
      }
      setTimeout(resolve, 250);
    });
  }

  /* ----------------------------------------------------------- import flow */

  function importSettings() {
    if (state.saving) return;
    C.importFile.value = '';
    C.importFile.click();
  }

  /** @returns {Promise<void>} */
  function onImportFileChosen() {
    var file = C.importFile.files && C.importFile.files[0];
    if (!file) return Promise.resolve();
    if (file.size > 4 * 1024 * 1024) {
      reportError('That file is too large to be a settings export (max 4 MB).');
      return Promise.resolve();
    }

    state.saving = true;
    setFormLocked(true);
    setStatus('Importing…');

    return file.text().then(
      function (text) {
        var parsed;
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          reportError('That file is not valid JSON, so nothing was changed.');
          return null;
        }
        var incoming = parsed && typeof parsed === 'object' ? parsed.settings : null;
        if (!incoming || typeof incoming !== 'object') {
          reportError('That JSON has no "settings" object, so nothing was changed.');
          return null;
        }

        var ok = window.confirm(
          'Import settings from "' + file.name + '"?\n\n'
          + 'Imported keys are merged over your current settings; anything the file does not mention '
          + 'is left alone. Unknown keys in the file are dropped by the worker, not written.'
        );
        if (!ok) {
          setStatus('Import cancelled.');
          return null;
        }

        // Read the file's OWN transcode value, before the worker answers, so
        // a value the file asked for cannot vanish without a word if the worker
        // resolves it to something else on the way in.
        noteTranscodeValue(incoming.transcode, true);

        return send('IMPORT_SETTINGS', { settings: incoming }).then(
          function (reply) {
            state.debug = reply.settings.debug === true;
            applySettings(reply.settings);
            renderLadder();
            setStatus(state.transcodeWarning
              ? 'Imported, but the file asked for a transcode this build cannot deliver.'
              : 'Imported.',
            state.transcodeWarning ? 'bad' : 'ok');
            setSaveNote(state.transcodeWarning
              ? 'Imported just now — see the warning under "Audio conversion".'
              : 'Imported just now.');
          }
        );
      }
    ).then(
      function () {
        state.saving = false;
        setFormLocked(false);
      },
      function (err) {
        // Nothing was written, so a warning raised from the file must not linger.
        clearTranscodeWarning();
        reportError('Could not import: ' + textOf(err));
        state.saving = false;
        setFormLocked(false);
      }
    );
  }

  /* ----------------------------------------------------------------- wire */

  function wirePreview() {
    C.template.addEventListener('input', function () {
      renderPreview();
      markDirty();
    });
    C.variant.addEventListener('change', function () {
      renderPreview();
      markDirty();
    });
    C.folderDepth.addEventListener('input', markDirty);
    C.maxFolderDepth.addEventListener('input', function () {
      // The worker clamps folderDepth to maxFolderDepth; do it here so the
      // preview and the number the user sees agree with what will be saved.
      var max = Math.max(0, Math.min(4, Math.round(numberOf(C.maxFolderDepth, 4))));
      if (numberOf(C.folderDepth, 0) > max) C.folderDepth.value = String(max);
      renderPreview();
      markDirty();
    });
    C.artistPolicy.addEventListener('change', function () {
      renderPreview();
      markDirty();
    });
    C.neutralArtist.addEventListener('input', function () {
      renderPreview();
      markDirty();
    });
  }

  function wireDirtyTracking() {
    var inputs = document.querySelectorAll('#sm-main input, #sm-main select');
    for (var i = 0; i < inputs.length; i += 1) {
      var node = inputs[i];
      if (node === C.template || node === C.variant || node === C.folderDepth
          || node === C.maxFolderDepth || node === C.artistPolicy || node === C.neutralArtist) {
        continue; // already wired
      }
      node.addEventListener('change', markDirty);
      if (node.type !== 'checkbox' && node.type !== 'radio' && node.type !== 'file') {
        node.addEventListener('input', markDirty);
      }
    }
    C.meteredExtras.addEventListener('change', renderPool);
    // An explicit choice supersedes whatever was imported or reported: the
    // message is about a value the user has now replaced. `askedTranscode` is
    // cleared too, so a later load cannot resurrect a warning about a value the
    // user is no longer asking for.
    ['transcodeNone', 'transcodeWav', 'transcodeMp3', 'transcodeOgg'].forEach(function (key) {
      C[key].addEventListener('change', function () {
        state.askedTranscode = '';
        clearTranscodeWarning();
        updateTranscodeHint(selectedTranscode());
        // Re-gate the parameter selects: the two lossy ones are each reachable
        // only under their own format. Values are left alone, so a bitrate or a
        // quality chosen before switching away is still there on switching back.
        updateAudioAvailability();
      });
    });
  }

  function wireActions() {
    C.saveBtn.addEventListener('click', function () { void saveSettings().catch(reportUnexpected); });
    C.resetBtn.addEventListener('click', function () { void resetSettings().catch(reportUnexpected); });
    C.exportBtn.addEventListener('click', function () { void exportSettings().catch(reportUnexpected); });
    C.importBtn.addEventListener('click', importSettings);
    C.importFile.addEventListener('change', function () { void onImportFileChosen().catch(reportUnexpected); });

    // Ctrl/Cmd-S saves, because this is a settings page in a tab and people
    // expect it. The handler never intercepts a modified press.
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        void saveSettings().catch(reportUnexpected);
      }
    });

    // Leaving with unsaved edits is the one place a confirm is genuinely right.
    window.addEventListener('beforeunload', function (event) {
      if (C.savenote.textContent !== 'Unsaved changes.') return;
      event.preventDefault();
      event.returnValue = '';
      return '';
    });
  }

  /* ------------------------------------------------------------------ boot */

  async function load() {
    setFormLocked(true);
    setStatus('Loading settings…');

    try {
      var reply = await send('GET_SETTINGS', {});
      state.defaults = reply.defaults || null;
      state.ladderDefs = Array.isArray(reply.ladder) ? reply.ladder : [];
      state.variants = Array.isArray(reply.variants) ? reply.variants : [];
      state.debug = reply.settings.debug === true;

      populateVariants();
      populateTokenSheet();

      // AWAITED before the DOM is touched. `applySettings` reads `reply.settings`
      // and nothing else, so there is no window in which a control shows a
      // value the worker does not hold.
      applySettings(reply.settings);

      await loadExampleClip();
      renderPreview();

      setStatus('Settings loaded.', 'ok');
      setSaveNote('');
    } catch (err) {
      reportError('Could not load settings: ' + textOf(err));
    } finally {
      setFormLocked(false);
    }
  }

  function boot() {
    wirePreview();
    wireDirtyTracking();
    wireActions();
    // Option lists are local data, not worker state, so they are built before
    // anything is awaited: a `GET_SETTINGS` that fails must still leave two
    // populated, usable selects rather than two empty ones.
    populateEncoderParams();
    renderLadder();

    try {
      var manifest = chrome.runtime.getManifest();
      C.version.textContent = 'v' + String(manifest.version || '?');
    } catch (manifestErr) {
      C.version.textContent = '';
      dbg('getManifest failed:', textOf(manifestErr));
    }

    void load().catch(reportUnexpected);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();