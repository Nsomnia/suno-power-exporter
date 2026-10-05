/**
 * Suno Master Utility — lib/lyrics.js
 * ---------------------------------------------------------------------------
 * Sidecar generators for downloaded Suno clips:
 *   .lrc — time-synced lyrics
 *   .txt — human-readable metadata dump
 *   .json — machine-readable clip record
 *
 * PURE TEXT / DATA ONLY. Everything here produces strings and plain objects;
 * the byte-level tag writing lives in `lib/tagger.js`. No network, no DOM, no
 * `chrome.*`, nothing asynchronous — this runs unchanged in an MV3 service
 * worker.
 *
 * Every exported function is TOTAL: null, undefined or garbage input yields a
 * safe empty value, never an exception.
 *
 * ---------------------------------------------------------------------------
 * SECURITY — DRM KEY MATERIAL MUST NEVER LEAVE THE DECRYPTION PATH
 * ---------------------------------------------------------------------------
 * The previous version of this file ended with:
 *
 *     lines.push('--- Rights ---');
 *     lines.push(clip.rights ? JSON.stringify(clip.rights, null, 2) : '(not fetched)');
 *
 * That is a secret leak. `clip.rights` is the Mango DRM envelope: `glt` is the
 * user's master-token seed, `key` and `iv` are the AES-GCM key and IV that
 * unwrap the content key. Writing them into a `.txt` file that lands in the
 * user's Downloads folder, gets synced to Drive/Dropbox, indexed by Spotlight
 * and pasted into bug reports means the decryption material for the user's
 * entire library is sitting in plaintext outside the extension.
 *
 * So: `rights` is never emitted at all — not even redacted — and every object
 * that leaves this module passes through `stripKeyMaterial()` as a second line
 * of defence in case a future response nests the envelope somewhere else (it
 * has been seen as `metadata.rights` and as a top-level `glt`).
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED: the `aligned_lyrics` response shape
 * ---------------------------------------------------------------------------
 * `GET /api/gen/{id}/aligned_lyrics/v3` is a VERIFIED route, but recon has NOT
 * confirmed the exact shape of its response body. Observed/assumed field names
 * disagree across sources, so `buildLrc` accepts every alias it can plausibly
 * be handed and normalises them:
 *
 *   container : `lines`, `items`, `lyrics_lines`, `lyricsLines`,
 *               `aligned_lyrics`, `alignedLyrics`, `data`, or the payload itself
 *   per line  : `start_s`, `start`, `time`, `startTime`, `start_time`,
 *               `timestamp`, `offset`, `startMs`, `start_ms`, `begin`
 *   text      : `text`, `line`, `word`, `words`, `lyric`, `value`, `content`
 *
 * UNITS ARE ALSO UNCONFIRMED. `start_s` and any `*Ms`/`*_ms` name are read as
 * seconds / milliseconds respectively because the name says so. The bare names
 * `start` and `time` are read as SECONDS (the `_s` suffix in `start_s` implies
 * seconds is the canonical unit Suno uses), but pass `{unit:'ms'}` to
 * `buildLrc` to override that globally. A timestamp already embedded in the
 * text as `[mm:ss.xx]` is detected and used as-is.
 *
 * If recon later confirms the shape, collapse the aliases down to the real
 * field names here — nothing else needs to change.
 */
(function () {
  'use strict';

  /** Field names whose value is DRM key material and must never be emitted. */
  var SECRET_KEY_RE = /^(key|iv|glt|token|authorization)$/i;

  /** Containers that have been used to smuggle the DRM envelope. */
  var SECRET_CONTAINERS = { rights: true };

  var LRC_TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  var LRC_ANY_TAG_RE = /^\[[a-zA-Z]+:[^\]]*\]$/;

  var DEFAULTS = {
    by: 'Suno Master Utility',
    offsetMs: 0,
    /** Words-per-line target used when timings are missing entirely. */
    lineDurationMs: 1200
  };

  /* ---------------------------------------------------------------------- *
   * Text hygiene
   * ---------------------------------------------------------------------- */

  function cleanStr(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
    if (typeof value === 'number') return isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return '';
    return '';
  }

  function trimmed(value) {
    var s = cleanStr(value).trim();
    return s;
  }

  /** First non-empty string among several candidate fields. */
  function firstStr(source, keys) {
    if (!source || typeof source !== 'object') return '';
    for (var i = 0; i < keys.length; i++) {
      var v = trimmed(source[keys[i]]);
      if (v) return v;
    }
    return '';
  }

  /** Coerce anything to a finite number, or null. */
  function toFinite(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value === 'string') {
      var n = parseFloat(value.replace(',', '.'));
      return isFinite(n) ? n : null;
    }
    return null;
  }

  /* ---------------------------------------------------------------------- *
   * LRC header
   * ---------------------------------------------------------------------- */

  /**
   * Build the `[ti:]`/`[ar:]`/`[al:]`/`[by:]`/`[offset:]` header block.
   *
   * `offset` is the standard LRC timing adjustment in MILLISECONDS and may be
   * negative — a negative value means every timestamp in the file is that much
   * too late. It is emitted with an explicit sign because `[offset:-250]` and
   * `[offset:250]` mean opposite things to a player.
   *
   * @param {{title?:string, artist?:string, album?:string, by?:string,
   *   offset?:number, offsetMs?:number, includeEmpty?:boolean}} [opts]
   * @returns {string} newline-joined, '' when there is nothing to emit
   */
  function buildLrcHeader(opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var lines = [];
    var title = trimmed(o.title);
    var artist = trimmed(o.artist);
    var album = trimmed(o.album);
    var by = trimmed(o.by) || DEFAULTS.by;
    var offsetRaw = o.offset !== undefined ? o.offset : o.offsetMs;
    var offset = toFinite(offsetRaw);

    if (title) lines.push('[ti:' + title + ']');
    if (artist) lines.push('[ar:' + artist + ']');
    if (album) lines.push('[al:' + album + ']');
    if (by) lines.push('[by:' + by + ']');
    if (offset !== null) {
      var ms = Math.round(offset);
      lines.push('[offset:' + (ms >= 0 ? '+' : '-') + Math.abs(ms) + ']');
    } else if (o.includeEmpty) {
      lines.push('[offset:' + DEFAULTS.offsetMs + ']');
    }
    return lines.join('\n');
  }

  /** Spec-literal alias: `SunoLyrics.LRC_HEADER` is the header builder. */
  var LRC_HEADER = buildLrcHeader;

  /* ---------------------------------------------------------------------- *
   * Timestamps
   * ---------------------------------------------------------------------- */

  /**
   * Format a time in seconds as an LRC timestamp.
   *
   * Negatives, NaN and Infinity all clamp to `[00:00.00]` — a negative or
   * nonsensical timestamp would make a player seek to a negative file position.
   * Minutes are NOT wrapped at 60: a 95-minute live set has to produce `[95:00.00]`,
   * and padding to two digits still works (`[95:00.00]`).
   *
   * @param {number} seconds
   * @param {{ms?:boolean}} [opts] `ms:false` emits `[mm:ss]` with no fraction
   * @returns {string} always bracketed, e.g. `[01:23.45]`
   */
  function formatTimestamp(seconds, opts) {
    var useMs = !(opts && opts.ms === false);
    var total = toFinite(seconds);
    if (total === null || total < 0) total = 0;
    /* Work in integer milliseconds. Doing the split in floating point gives
       12.34 -> "12.33", because 12.34 - 12 is 0.33999999999999986. */
    var totalMs = Math.round(total * 1000);
    var minutes = Math.floor(totalMs / 60000);
    var secs = Math.floor((totalMs - minutes * 60000) / 1000);
    var mm = String(minutes);
    if (mm.length < 2) mm = '0' + mm;
    var ss = secs < 10 ? '0' + secs : String(secs);
    if (!useMs) return '[' + mm + ':' + ss + ']';
    var centis = Math.floor((totalMs - minutes * 60000 - secs * 1000) / 10);
    var f = centis < 10 ? '0' + centis : String(centis);
    return '[' + mm + ':' + ss + '.' + f + ']';
  }

  /**
   * Legacy millisecond formatter kept so callers written against the previous
   * API keep working. NOTE the unit differs from `formatTimestamp`, which takes
   * SECONDS.
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestampMs(ms) {
    var total = toFinite(ms);
    if (total === null || total < 0) total = 0;
    return formatTimestamp(total / 1000, { ms: true });
  }

  /**
   * Parse the leading `[mm:ss.xx]` out of a string, if there is one.
   * @param {string} text
   * @returns {{seconds:number, rest:string}|null}
   */
  function splitLeadingTimestamp(text) {
    var s = cleanStr(text);
    var m = /^\s*\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(s);
    if (!m) return null;
    var mins = parseInt(m[1], 10);
    var secs = parseInt(m[2], 10);
    var frac = m[3] ? parseInt(m[3].length === 1 ? m[3] + '00' : m[3].length === 2 ? m[3] + '0' : m[3], 10) : 0;
    var divisor = m[3] ? Math.pow(10, m[3].length) : 1;
    var seconds = mins * 60 + secs + frac / divisor;
    return { seconds: seconds, rest: s.slice(m[0].length).trim() };
  }

  /* ---------------------------------------------------------------------- *
   * LRC parsing / building
   * ---------------------------------------------------------------------- */

  /**
   * Parse an `.lrc` file back into structured lines.
   *
   * One line may carry several timestamps (`[00:12.00][01:30.00] chorus`), each
   * of which yields its own entry. The `[offset:]` tag is applied to every
   * timestamp, because that is what a player does with it.
   *
   * @param {string} text
   * @returns {Array<{timeSec:number, text:string}>} sorted by time
   */
  function parseLrc(text) {
    var src = cleanStr(text);
    var out = [];
    if (!src) return out;

    var offsetSec = 0;
    var lines = src.split('\n');
    var i;
    var j;
    for (i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) continue;

      var offsetTag = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(raw);
      if (offsetTag) {
        offsetSec = parseInt(offsetTag[1], 10) / 1000;
        continue;
      }
      if (LRC_ANY_TAG_RE.test(raw) && raw.indexOf('[') === 0 && raw.indexOf(']') === raw.length - 1 &&
          !/^\[\d/.test(raw)) {
        continue; // [ti:] / [ar:] / [al:] / [by:] metadata
      }

      var stamps = [];
      LRC_TIME_RE.lastIndex = 0;
      var m;
      var consumed = 0;
      while ((m = LRC_TIME_RE.exec(raw)) !== null) {
        if (m.index !== consumed) break; // timestamps must be contiguous at the line start
        consumed = m.index + m[0].length;
        var mins = parseInt(m[1], 10);
        var secs = parseInt(m[2], 10);
        var fracText = m[3] || '';
        var frac = fracText ? parseInt(fracText, 10) / Math.pow(10, fracText.length) : 0;
        stamps.push(mins * 60 + secs + frac);
      }
      if (!stamps.length) continue;

      var body = raw.slice(consumed).trim();
      if (!body) continue;
      for (j = 0; j < stamps.length; j++) {
        out.push({ timeSec: Math.max(0, Math.round((stamps[j] + offsetSec) * 1000) / 1000), text: body });
      }
    }

    out.sort(function (a, b) { return a.timeSec - b.timeSec; });
    return out;
  }

  var LINE_CONTAINER_KEYS = [
    'lines', 'items', 'lyrics_lines', 'lyricsLines', 'aligned_lyrics', 'alignedLyrics',
    'lyric_lines', 'lyricLines', 'segments', 'cues', 'data'
  ];
  var LINE_TIME_KEYS = [
    'start_s', 'startTime', 'start_time', 'start', 'time', 'timestamp', 'offset', 'begin', 'at', 't'
  ];
  var LINE_TIME_MS_KEYS = ['startMs', 'start_ms', 'startMS', 'timeMs', 'time_ms', 'offsetMs', 'offset_ms', 'beginMs'];
  var LINE_TEXT_KEYS = ['text', 'line', 'lyric', 'word', 'words', 'value', 'content', 'lyrics'];

  /**
   * Locate the array of lyric lines inside whatever shape we were handed.
   * @param {*} payload
   * @returns {Array|null}
   */
  function findLineArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return null;
    for (var i = 0; i < LINE_CONTAINER_KEYS.length; i++) {
      var v = payload[LINE_CONTAINER_KEYS[i]];
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        var nested = findLineArray(v);
        if (nested) return nested;
      }
    }
    return null;
  }

  /**
   * Pull plain lyric text out of a clip when no timings exist: an array of
   * strings, an array of `{text}` objects, or a plain multi-line string.
   *
   * A line that already starts with `[mm:ss.xx]` keeps that timestamp and has
   * the marker stripped from its text, so an LRC that was split into a plain
   * string (or round-tripped through `parseLrc`) comes back out correctly timed
   * instead of getting a second, invented timestamp in front of it.
   *
   * @param {*} clip
   * @returns {Array<{timeSec:(number|null), text:string}>}
   */
  function extractPlainLyricLines(clip) {
    var out = [];
    if (!clip || typeof clip !== 'object') return out;

    function add(raw) {
      var s = trimmed(raw);
      if (!s) return;
      var split = splitLeadingTimestamp(s);
      if (split) {
        if (split.rest) out.push({ timeSec: split.seconds, text: split.rest });
      } else {
        out.push({ timeSec: null, text: s });
      }
    }

    function take(value) {
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
          var entry = value[i];
          if (typeof entry === 'string') {
            add(entry);
          } else if (entry && typeof entry === 'object') {
            var t = firstStr(entry, LINE_TEXT_KEYS);
            if (t) add(t);
          }
        }
      } else if (typeof value === 'string' && trimmed(value)) {
        var parts = cleanStr(value).split('\n');
        for (var j = 0; j < parts.length; j++) add(parts[j]);
      }
    }

    take(clip.lyrics);
    if (!out.length) take(clip.aligned_lyrics);
    if (!out.length) take(clip.alignedLyrics);
    if (!out.length && clip.metadata && typeof clip.metadata === 'object') {
      take(clip.metadata.lyrics);
      if (!out.length) take(clip.metadata.aligned_lyrics);
    }
    if (!out.length && clip.prompt) take(clip.prompt); // prompt doubles as lyrics for instrumental-style clips
    return out;
  }

  /**
   * Build an `.lrc` file.
   *
   * Timed lines are sorted by start time. Untimed lines are emitted at
   * `[00:00.00]` rather than dropped, because a bare lyric sheet is still worth
   * having and silently discarding half a clip's words is worse than a few
   * zeroed timestamps. Empty lines are dropped.
   *
   * @param {{title?:string, artist?:string, album?:string, meta?:object,
   *   lines?:Array, clip?:object, unit?:'s'|'ms', by?:string, offset?:number,
   *   durationMs?:number, header?:boolean}} [spec]
   * @returns {string}
   */
  function buildLrc(spec) {
    var s = spec && typeof spec === 'object' ? spec : {};
    var meta = s.meta && typeof s.meta === 'object' ? s.meta : null;
    var clip = s.clip && typeof s.clip === 'object' ? s.clip : null;
    var unit = s.unit === 'ms' ? 'ms' : 's';

    var rawLines = Array.isArray(s.lines) ? s.lines : findLineArray(meta);
    if (!rawLines && clip) rawLines = findLineArray(clip);
    if (!rawLines && meta) rawLines = findLineArray(clip || meta);

    var entries = [];

    if (rawLines && rawLines.length) {
      for (var i = 0; i < rawLines.length; i++) {
        var entry = rawLines[i];
        if (typeof entry === 'string') {
          var bare = trimmed(entry);
          if (bare) entries.push({ timeSec: null, text: bare, order: i });
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;

        var text = firstStr(entry, LINE_TEXT_KEYS);
        if (!text) continue;

        /* A timestamp already baked into the text wins over a bare numeric
           field, because it is unambiguous about its own unit. */
        var split = splitLeadingTimestamp(text);
        var timeSec = null;
        if (split) {
          timeSec = split.seconds;
          text = split.rest;
          if (!text) continue;
        } else {
          var msValue = null;
          for (var k = 0; k < LINE_TIME_MS_KEYS.length; k++) {
            var candidate = toFinite(entry[LINE_TIME_MS_KEYS[k]]);
            if (candidate !== null) {
              msValue = candidate;
              break;
            }
          }
          if (msValue !== null) timeSec = msValue / 1000;
          else {
            for (var j = 0; j < LINE_TIME_KEYS.length; j++) {
              var v = toFinite(entry[LINE_TIME_KEYS[j]]);
              if (v !== null) {
                timeSec = unit === 'ms' ? v / 1000 : v;
                break;
              }
            }
          }
          if (timeSec === null && Array.isArray(entry.timestamps)) {
            for (var q = 0; q < entry.timestamps.length; q++) {
              var tv = toFinite(entry.timestamps[q]);
              if (tv !== null) {
                timeSec = tv;
                break;
              }
            }
          }
        }
        if (timeSec !== null && (isNaN(timeSec) || !isFinite(timeSec) || timeSec < 0)) timeSec = null;
        entries.push({ timeSec: timeSec, text: text, order: i });
      }
    }

    if (!entries.length) {
      /* No timings anywhere. Fall back to whatever plain text we were handed,
         preferring an explicitly supplied `lyrics` over anything inferred
         from the clip (a prompt is a last resort, not a lyric sheet). */
      var plainSource = null;
      if (s.lyrics !== undefined && s.lyrics !== null) plainSource = { lyrics: s.lyrics };
      else if (clip) plainSource = clip;
      else if (meta) plainSource = { metadata: meta, lyrics: meta.lyrics };
      if (plainSource) entries = extractPlainLyricLines(plainSource);
    }

    /* Nothing timed at all: spread the lines evenly so the file is still
       usable as a scroll-through-the-song reference. */
    var anyTimed = false;
    for (var t = 0; t < entries.length; t++) {
      if (entries[t].timeSec !== null) {
        anyTimed = true;
        break;
      }
    }
    if (entries.length && !anyTimed && s.durationMs) {
      var step = toFinite(s.durationMs);
      if (step !== null && step > 0) {
        var per = step / entries.length;
        for (var d = 0; d < entries.length; d++) entries[d].timeSec = per * d;
        anyTimed = true;
      }
    }

    var header = '';
    if (s.header !== false) {
      header = buildLrcHeader({
        title: s.title !== undefined ? s.title : clip ? clip.title : '',
        artist: s.artist !== undefined ? s.artist : '',
        album: s.album !== undefined ? s.album : '',
        by: s.by,
        offset: s.offset
      });
    }

    if (!entries.length) return header;

    /* Stable sort: equal timestamps keep their original order, which is what
       keeps repeated chorus lines from being shuffled. */
    var decorated = [];
    for (var k2 = 0; k2 < entries.length; k2++) {
      decorated.push({ e: entries[k2], i: k2 });
    }
    decorated.sort(function (a, b) {
      var at = a.e.timeSec === null ? 0 : a.e.timeSec;
      var bt = b.e.timeSec === null ? 0 : b.e.timeSec;
      if (at !== bt) return at - bt;
      return a.i - b.i;
    });

    var body = [];
    for (var o = 0; o < decorated.length; o++) {
      var item = decorated[o].e;
      var time = item.timeSec === null ? 0 : item.timeSec;
      body.push(formatTimestamp(time, { ms: true }) + ' ' + item.text);
    }
    return header ? header + '\n' + body.join('\n') : body.join('\n');
  }

  /* ---------------------------------------------------------------------- *
   * Key material scrubbing
   * ---------------------------------------------------------------------- */

  /**
   * Recursively drop DRM key material from a structure.
   *
   * Matching keys (`key`, `iv`, `glt`, `token`, `authorization`) are OMITTED,
   * not nulled, so `{glt:'x'}` scrubs to `{}`. The input is never mutated —
   * the caller's clip object is returned to the pool and must stay intact for
   * the next decryption.
   *
   * Cycles are handled: a self-referential response becomes `null` at the point
   * it repeats rather than blowing the stack.
   *
   * @param {*} value
   * @param {{depth?:number}} [opts]
   * @returns {*} a scrubbed deep copy; primitives pass through
   */
  function stripKeyMaterial(value, opts) {
    var maxDepth = opts && typeof opts.depth === 'number' ? opts.depth : 12;
    var seen = [];

    function walk(node, depth) {
      if (node === null || node === undefined) return node;
      var t = typeof node;
      if (t === 'string' || t === 'number' || t === 'boolean') return node;
      if (t !== 'object') return null;
      if (depth > maxDepth) return null;
      if (seen.indexOf(node) !== -1) return null;

      seen.push(node);
      var out;
      var i;
      if (Array.isArray(node)) {
        out = [];
        for (i = 0; i < node.length; i++) out.push(walk(node[i], depth + 1));
      } else if (typeof Blob !== 'undefined' && node instanceof Blob) {
        out = '[Blob ' + node.size + 'B]';
      } else if (typeof node.toJSON === 'function') {
        try {
          out = walk(node.toJSON(), depth + 1);
        } catch (e) {
          out = null;
        }
      } else {
        out = {};
        for (var key in node) {
          if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
          if (SECRET_KEY_RE.test(key)) continue;
          if (SECRET_CONTAINERS[key.toLowerCase()] === true) continue;
          out[key] = walk(node[key], depth + 1);
        }
      }
      seen.pop();
      return out;
    }

    return walk(value, 0);
  }

  /* ---------------------------------------------------------------------- *
   * Metadata text sidecar
   * ---------------------------------------------------------------------- */

  /**
   * Build a human-readable `.txt` metadata dump for a clip.
   *
   * NEVER includes `clip.rights` or any other DRM envelope — see the file
   * header for why that matters. `stripKeyMaterial()` runs over the whole
   * result as a second line of defence.
   *
   * Field notes:
   *  - `major_model_version` CAN be the empty string on some clips; `model_name`
   *    is then the only model identifier, so both are shown.
   *  - `metadata.make_instrumental` MAY BE ABSENT, which means false.
   *  - `display_name`/`handle` are the OWNER's own account, not a third-party
   *    artist. They are reported as "Clip owner", never as "Artist".
   *
   * @param {object} clip
   * @param {{bpm?:number, artist?:string, album?:string, lyrics?:string,
   *   durationMs?:number, extra?:string}} [opts]
   * @returns {string}
   */
  function buildMetaTxt(clip, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var c = clip && typeof clip === 'object' ? clip : {};
    var md = c.metadata && typeof c.metadata === 'object' ? c.metadata : {};

    var title = trimmed(c.title) || 'Untitled';
    var clipId = trimmed(c.id) || 'n/a';
    /* `major_model_version` CAN be the empty string, in which case `model_name`
       is the only model identifier — so prefer whichever one is populated
       rather than printing "n/a" next to the real value. */
    var majorModel = trimmed(c.major_model_version);
    var modelName = trimmed(c.model_name);
    var model = majorModel || modelName;
    var modelSuffix = majorModel && modelName ? ' (' + modelName + ')' : '';
    var created = trimmed(c.created_at);
    var createdText = '';
    if (created) {
      var when = new Date(created);
      createdText = isNaN(when.getTime()) ? created : when.toISOString();
    }

    /* Absence means false for this field — do not report "unknown". */
    var instrumental = md.make_instrumental === true || md.is_instrumental === true;

    var lines = [];
    lines.push('=== Suno Track Metadata ===');
    lines.push('');
    lines.push('Title:        ' + title);
    lines.push('Artist:       ' + (trimmed(o.artist) || trimmed(o.defaultArtist) || 'Suno AI'));
    if (trimmed(o.album)) lines.push('Album:        ' + trimmed(o.album));
    lines.push('Clip ID:      ' + clipId);
    lines.push('Model:        ' + (model || 'n/a') + modelSuffix);
    lines.push('Created:      ' + (createdText || 'n/a'));
    var durationMs = toFinite(o.durationMs);
    if (durationMs !== null) lines.push('Duration:     ' + (durationMs / 1000).toFixed(2) + 's');
    var bpm = toFinite(o.bpm);
    lines.push('BPM:          ' + (bpm !== null ? Math.round(bpm) + ' BPM' : 'n/a'));
    lines.push('');
    lines.push('--- Usage ---');
    lines.push('Play count:   ' + (typeof c.play_count === 'number' ? c.play_count : 'n/a'));
    lines.push('Upvotes:      ' + (typeof c.upvote_count === 'number' ? c.upvote_count : 'n/a'));
    lines.push('Flags:        ' + (typeof c.flag_count === 'number' ? c.flag_count : 'n/a'));
    lines.push('Liked:        ' + (c.is_liked === true ? 'yes' : 'no'));
    lines.push('Public:       ' + (c.is_public === true ? 'yes' : 'no'));
    lines.push('Status:       ' + (trimmed(c.status) || 'n/a'));
    if (c.is_instrumental === true || instrumental) lines.push('Instrumental: yes');
    if (c.is_contest_clip === true) lines.push('Contest clip: yes');
    if (c.is_remix === true || md.is_remix === true) lines.push('Remix:        yes');
    if (c.batch_index !== undefined && c.batch_index !== null) {
      lines.push('Batch index:  ' + c.batch_index);
    }
    if (trimmed(c.parent_id)) lines.push('Parent clip:  ' + trimmed(c.parent_id));
    if (trimmed(c.display_name) || trimmed(c.handle)) {
      /* Explicitly labelled: this is the account that owns the clip, which is
         almost always the user running the downloader. It is NOT an artist. */
      lines.push('Clip owner:   ' + (trimmed(c.display_name) || trimmed(c.handle)) + '  (account owner, not a credited artist)');
    }
    lines.push('');
    lines.push('--- Style / Tags ---');
    lines.push(trimmed(md.tags) || trimmed(c.tags) || 'n/a');
    if (trimmed(md.style)) {
      lines.push('');
      lines.push('--- Style ---');
      lines.push(trimmed(md.style));
    }
    lines.push('');
    lines.push('--- Prompt ---');
    lines.push(trimmed(md.prompt) || trimmed(c.prompt) || '(no prompt)');
    if (trimmed(md.type)) lines.push('\nType: ' + trimmed(md.type));
    if (trimmed(md.vox_render_mode)) lines.push('Vox render mode: ' + trimmed(md.vox_render_mode));
    if (md.is_mumble === true) lines.push('Mumble: yes');
    if (md.stream === true) lines.push('Stream: yes');

    var lyrics = cleanStr(o.lyrics !== undefined ? o.lyrics : c.lyrics).trim();
    lines.push('');
    lines.push('--- Lyrics ---');
    lines.push(lyrics || '(instrumental / no lyrics)');

    /* Source URLs. These are the user's own CDN links; no credentials are
       embedded in them by Suno. */
    var urls = [];
    var i;
    if (Array.isArray(c.media_urls)) {
      for (i = 0; i < c.media_urls.length; i++) {
        if (trimmed(c.media_urls[i])) urls.push(trimmed(c.media_urls[i]));
      }
    }
    var singles = [
      ['audio', c.media_url], ['video', c.video_url], ['image', c.image_url], ['image (large)', c.image_large_url]
    ];
    for (i = 0; i < singles.length; i++) {
      if (trimmed(singles[i][1])) urls.push(trimmed(singles[i][0]) + ': ' + trimmed(singles[i][1]));
    }
    lines.push('');
    lines.push('--- Source URLs ---');
    if (urls.length) {
      for (i = 0; i < urls.length; i++) lines.push(urls[i]);
    } else {
      lines.push('(none)');
    }

    if (trimmed(o.extra)) {
      lines.push('');
      lines.push(trimmed(o.extra));
    }

    lines.push('');
    lines.push('--- DRM ---');
    lines.push('Key material is intentionally omitted from this file.');

    var text = lines.join('\n');
    /* Second line of defence: if any field above ever picked up a `glt`/`key`/
       `iv` on the way in, strip it now rather than shipping it. */
    return scrubTextForSecrets(text);
  }

  /**
   * Remove anything key-material-shaped from a finished text block.
   * A blunt net that runs on the FINAL string, so a secret that reached a field
   * by an unforeseen route still does not reach disk.
   * @param {string} text
   * @returns {string}
   */
  function scrubTextForSecrets(text) {
    var s = cleanStr(text);
    if (!s) return '';
    try {
      s = s.replace(/"(?:key|iv|glt|token|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
      s = s.replace(/\b(glt|key|iv)\s*[:=]\s*[A-Za-z0-9+/=_-]{16,}/gi, '$1=[redacted]');
    } catch (e) {
      /* Leave the text as-is if the regex engine misbehaves; it never throws
         in practice, and a partial scrub beats dropping the whole file. */
    }
    return s;
  }

  /* ---------------------------------------------------------------------- *
   * Sidecar bundle
   * ---------------------------------------------------------------------- */

  /**
   * Build the sidecar set for a clip.
   *
   * Each sidecar is independently nullable: a clip with no lyrics still gets a
   * `.txt` and a `.json`, and a null in the result means "do not write this
   * file" rather than "the whole export failed".
   *
   * @param {object} clip
   * @param {{lyrics?:string, bpm?:number, artist?:string, album?:string,
   *   alignedLyrics?:Array, durationMs?:number}} [opts]
   * @returns {{lrc:string|null, txt:string|null, json:object|null}}
   */
  function buildSidecars(clip, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var c = clip && typeof clip === 'object' ? clip : {};
    var md = c.metadata && typeof c.metadata === 'object' ? c.metadata : {};
    var result = { lrc: null, txt: null, json: null };

    /* Nothing to describe: emit no files at all rather than three documents
       full of "n/a". */
    var hasContent = false;
    for (var ck in c) {
      if (Object.prototype.hasOwnProperty.call(c, ck)) {
        hasContent = true;
        break;
      }
    }
    if (!hasContent && !trimmed(o.lyrics) && !trimmed(o.artist)) return result;

    var lyricsText = '';
    if (o.lyrics !== undefined && o.lyrics !== null) lyricsText = cleanStr(o.lyrics);
    else if (typeof c.lyrics === 'string') lyricsText = cleanStr(c.lyrics);
    else if (Array.isArray(c.lyrics)) {
      for (var i = 0; i < c.lyrics.length; i++) {
        var entry = c.lyrics[i];
        var t = typeof entry === 'string' ? trimmed(entry) : entry ? firstStr(entry, LINE_TEXT_KEYS) : '';
        if (t) lyricsText += (lyricsText ? '\n' : '') + t;
      }
    }
    if (!lyricsText) lyricsText = cleanStr(md.lyrics);

    var timed = Array.isArray(o.alignedLyrics) ? o.alignedLyrics : findLineArray(c);

    try {
      var lrc = buildLrc({
        title: c.title,
        artist: o.artist,
        album: o.album,
        meta: { aligned_lyrics: timed, lyrics: lyricsText },
        lines: timed,
        lyrics: lyricsText,
        durationMs: o.durationMs,
        clip: null
      });
      /* A header on its own is not worth a file — only write the `.lrc` when
         there is at least one actual timestamped line in it. */
      if (lrc && /\[\d{1,4}:\d{1,2}[.:]?\d*\]/.test(lrc)) result.lrc = lrc;
    } catch (e) {
      result.lrc = null;
    }

    try {
      var txt = buildMetaTxt(c, {
        bpm: o.bpm,
        artist: o.artist,
        album: o.album,
        lyrics: lyricsText,
        durationMs: o.durationMs
      });
      if (txt) result.txt = txt;
    } catch (e) {
      result.txt = null;
    }

    try {
      if (c && Object.keys(c).length) {
        var scrubbed = stripKeyMaterial(c);
        if (o.bpm !== undefined && o.bpm !== null) scrubbed.bpm = toFinite(o.bpm);
        if (o.durationMs !== undefined && o.durationMs !== null) {
          scrubbed.duration_ms = toFinite(o.durationMs);
        }
        result.json = scrubbed;
      }
    } catch (e) {
      result.json = null;
    }

    return result;
  }

  /* ---------------------------------------------------------------------- *
   * Backwards-compatible instance surface
   * ---------------------------------------------------------------------- */

  var api = {
    /* configuration */
    DEFAULTS: DEFAULTS,

    /* LRC */
    LRC_HEADER: LRC_HEADER,
    buildLrcHeader: buildLrcHeader,
    formatTimestamp: formatTimestamp,
    formatTimestampMs: formatTimestampMs,
    buildLrc: buildLrc,
    parseLrc: parseLrc,
    extractPlainLyricLines: extractPlainLyricLines,
    findLineArray: findLineArray,

    /* metadata sidecars */
    stripKeyMaterial: stripKeyMaterial,
    scrubTextForSecrets: scrubTextForSecrets,
    buildMetaTxt: buildMetaTxt,
    buildSidecars: buildSidecars,

    /* legacy instance members kept for callers written against the old API */
    lyricLineMs: DEFAULTS.lineDurationMs,

    /**
     * Legacy entry point: `sunoLyrics.buildLrc(clip, durationMs)` where
     * `durationMs` is a duration in MILLISECONDS.
     *
     * The new signature is `buildLrc({title, artist, album, meta, lines})`.
     * This shim accepts a clip object and dispatches to it so existing call
     * sites keep working. Note the unit change: the old `formatTimestamp` took
     * milliseconds, the new one takes SECONDS.
     *
     * @param {object} clipOrSpec
     * @param {number} [durationMs]
     * @returns {string}
     */
    buildLrcForClip: function (clipOrSpec, durationMs) {
      var s = clipOrSpec && typeof clipOrSpec === 'object' ? clipOrSpec : {};
      var isClip = s.lines === undefined && (
        s.metadata || s.aligned_lyrics || s.alignedLyrics ||
        Array.isArray(s.lyrics) || typeof s.lyrics === 'string'
      );
      if (!isClip) return buildLrc(s);
      return buildLrc({
        title: s.title,
        meta: s,
        lines: findLineArray(s),
        durationMs: toFinite(durationMs),
        clip: null
      });
    },

    /**
     * Legacy entry point: `sunoLyrics.buildMetaTxt(clip, bpm)`.
     * @param {object} clip
     * @param {number} [bpm]
     * @returns {string}
     */
    buildMetaTxtForClip: function (clip, bpm) {
      return buildMetaTxt(clip, { bpm: bpm });
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.SunoLyrics = api;
})();
