/**
 * 11. TAGGING + SIDECARS — cover art fetch, tag embed, and the sidecar writers.
 *
 * Extracted verbatim from `background/background.js` section 11. For the
 * mechanism read `background/parts/15-quota.js` first.
 *
 * VERIFIED BY REFERENCE COUNT BEFORE THE CUT: all four declarations are used
 * at call time only — through `runLadderRung` in the ladder part and the batch
 * driver's own helpers afterwards. There are ZERO top-level outside
 * references (mechanical scan) and no load-time reads of monolith or sibling-part
 * bindings, so this part's declarations land before the monolith body evaluates
 * in both classic workers and the tests' importScripts shim.
 */

/* ==========================================================================
 * 11. TAGGING + SIDECARS
 *
 * `lib/tagger.js` publishes on `globalThis` (lib/tagger.js:2125, with the
 * comment "not window: an MV3 service worker has no window"), so it resolves
 * through the §0 compat shim like everything else. It used to be window-only,
 * and this block used to say so and promise a fix that has since landed; that
 * sentence was stale and would have had the next session debugging a shim that
 * works. The degrade-to-untagged behaviour below is still correct and still
 * wanted — it is the fallback for an install where `lib/tagger.js` failed to
 * load entirely (`MISSING_LIBS`), not for a publication mismatch.
 * ======================================================================== */

/**
 * Fetch cover art for embedding. Any failure degrades to "no artwork": a track
 * without an embedded image is strictly better than a failed download.
 *
 * @param {object} clip raw clip record
 * @param {object} rec normalized record (carries coverUrl / imageLargeUrl)
 * @param {AbortSignal} signal
 * @returns {Promise<{bytes:Uint8Array, mime:string}|null>}
 */
async function fetchCoverArt(clip, rec, signal) {
  if (!rec) return null;
  const url = String(rec.imageLargeUrl || rec.coverUrl || (clip && clip.image_url) || '');
  if (!url) return null;
  try {
    const bytes = await fetchMediaAsset(url, { signal, maxBytes: ART_MAX_BYTES, label: 'cover art' });
    if (!bytes.length) return null;
    const mime = /png/i.test(url) ? 'image/png'
      : /jpe?g/i.test(url) ? 'image/jpeg'
        : /webp/i.test(url) ? 'image/webp'
          : 'image/jpeg';
    log('debug', 'tags.cover_fetched', { bytes: bytes.length, mime });
    return { bytes, mime };
  } catch (artErr) {
    log('debug', 'tags.cover_unavailable', { error: describeError(artErr) });
    return null;
  }
}

/**
 * Tag the downloaded bytes and optionally write lyrics/meta sidecars.
 *
 * @param {object} clip raw clip record
 * @param {Uint8Array} bytes
 * @param {object} ctx {variant, settings, signal}
 * @param {string} container detected container
 * @returns {Promise<{bytes:Uint8Array, container:string, tagged:boolean, warnings:string[]}>}
 */
async function applyTagsAndSidecars(clip, bytes, ctx, container) {
  const warnings = [];
  const options = ctx.settings.tagOptions || DEFAULT_SETTINGS.tagOptions;
  const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip) : null;

  if (!TAGGER_AVAILABLE || options.embed === false) {
    if (!TAGGER_AVAILABLE) warnings.push('lib/tagger.js is not loaded; the file is written untagged');
    else warnings.push('tagging is disabled in settings');
    return { bytes, container, tagged: false, warnings };
  }

  const meta = SunoAudio && typeof SunoAudio.toTagMeta === 'function'
    ? SunoAudio.toTagMeta(rec || clip)
    : Object.assign({ id: clip.id, title: clip.title }, clip);

  let bpm = bpmFromClip(rec, clip);
  if (options.bpm && !(bpm > 0)) {
    // No tempo on the clip: measure it rather than writing a tag that claims one.
    bpm = (await detectBpmViaOffscreen(bytes, mimeForVariant(ctx.variant))) || 0;
  }
  let coverArt = null;
  if (options.artwork !== false) {
    coverArt = await fetchCoverArt(clip, rec, ctx.signal);
    if (!coverArt) warnings.push('cover art could not be fetched; the file is written without embedded artwork');
  }

  let taggedBytes = bytes;
  try {
    const result = SunoTagger.tagAudioFile({
      bytes: taggedBytes.buffer.slice(
        taggedBytes.byteOffset,
        taggedBytes.byteOffset + taggedBytes.byteLength
      ),
      container,
      // `meta.bpm` is gated EXACTLY like the top-level `bpm` below, because
      // lib/tagger.js resolves `req.bpm !== undefined && req.bpm !== null ?
      // req.bpm : meta.bpm`. An ungated `meta.bpm` therefore re-enabled the
      // TBPM frame whenever the tempo toggle was off but the clip carried one.
      meta: Object.assign({}, meta, {
        bpm: options.bpm ? bpm : undefined,
        album: ctx.settings.albumName,
      }),
      lyrics: options.lyrics ? (rec ? rec.lyrics : clip.lyrics) : '',
      coverArt,
      bpm: options.bpm ? bpm : undefined,
      options: {
        artist: ctx.settings.artistPolicy === 'neutral' ? ctx.settings.neutralArtist : '',
        useClipOwnerAsArtist: ctx.settings.artistPolicy === 'clip-owner',
        album: ctx.settings.albumName,
        comment: options.comment ? buildClipComment(clip, rec) : '',
      },
    });
    if (result && result.bytes) taggedBytes = await toBytes(result.bytes);
    if (result && Array.isArray(result.warnings)) warnings.push(...result.warnings);
    if (result && result.container && result.container !== 'unknown') {
      return { bytes: taggedBytes, container: result.container, tagged: result.injected !== false, warnings };
    }
  } catch (tagErr) {
    warnings.push('tagging failed, saving untagged: ' + describeError(tagErr).message);
    log('warn', 'tagging.failed', { clipId: clip && clip.id, error: describeError(tagErr) });
  }

  return { bytes: taggedBytes, container, tagged: false, warnings };
}

/**
 * Write the lyrics / metadata sidecars next to the audio file.
 *
 * `SunoLyrics.buildSidecars` emits only the documents that have real content, and
 * it scrubs DRM key material INTERNALLY while building the text — that is what
 * actually protects these files. The `stripKeyMaterial` call below is a
 * structural no-op: `lib/lyrics.js:540` returns strings unchanged
 * (`if (t === 'string' ...) return node;`), and every sidecar `text` here is a
 * string. It is kept only because it is cheap, it is correct if the library ever
 * starts returning a non-string document, and it keeps the no-secrets-here
 * intent visible at the call site. This comment previously described it as
 * "defence in depth", which overstated a function that cannot redact anything
 * it is given here.
 *
 * @param {object} clip raw clip record
 * @param {string} audioPath the path the audio was written to
 * @param {object} ctx {variant, settings, signal, clipId, source, batchId, overwrite}
 * @returns {Promise<string[]>} the filenames written
 */
async function writeSidecars(clip, audioPath, ctx) {
  const options = ctx.settings.tagOptions || DEFAULT_SETTINGS.tagOptions;
  if (!SunoLyrics || typeof SunoLyrics.buildSidecars !== 'function') return [];
  if (options.lrc === false && options.json === false) return [];

  const slash = audioPath.lastIndexOf('/');
  const dir = slash >= 0 ? audioPath.slice(0, slash + 1) : '';
  const base = slash >= 0 ? audioPath.slice(slash + 1) : audioPath;
  const stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip) : null;
  const written = [];

  let documents;
  try {
    documents = SunoLyrics.buildSidecars(clip, {
      lyrics: options.lyrics ? (rec ? rec.lyrics : clip.lyrics) : '',
      alignedLyrics: null,
      artist: ctx.settings.artistPolicy === 'clip-owner'
        ? (rec ? rec.ownerName : '')
        : ctx.settings.neutralArtist,
      album: ctx.settings.albumName,
      bpm: bpmFromClip(rec, clip),
      durationMs: rec && rec.durationSec ? Math.round(rec.durationSec * 1000) : 0,
    });
  } catch (sidecarErr) {
    log('warn', 'sidecars.build_failed', { clipId: clip && clip.id, error: describeError(sidecarErr) });
    return [];
  }

  const wanted = [
    { ext: '.lrc', text: options.lrc === false ? null : documents.lrc },
    { ext: '.txt', text: documents.txt },
    { ext: '.json', text: options.json ? documents.json : null },
  ];
  for (const entry of wanted) {
    if (!entry.text || typeof entry.text !== 'string' || !entry.text.trim()) continue;
    const filename = dir + stem + entry.ext;
    try {
      const text = SunoLyrics.stripKeyMaterial ? SunoLyrics.stripKeyMaterial(entry.text) : entry.text;
      const bytes = new TextEncoder().encode(text);
      await saveBytes(bytes, {
        mime: entry.ext === '.json' ? 'application/json' : 'text/plain;charset=utf-8',
        filename,
        clipId: ctx.clipId,
        variant: ctx.variant + entry.ext,
        source: 'sidecar',
        batchId: ctx.batchId,
        overwrite: false,
        // A sidecar is not a song: it must not appear in download history or
        // affect isDone(clipId, variant).
        track: false,
      });
      written.push(filename);
    } catch (sidecarErr) {
      // A missing .lrc must never fail the audio download.
      log('warn', 'sidecars.write_failed', { clipId: clip && clip.id, ext: entry.ext, error: describeError(sidecarErr) });
    }
  }
  if (written.length) log('info', 'sidecars.written', { clipId: clip && clip.id, files: written.length });
  return written;
}

/**
 * Build the provenance comment. `display_name`/`handle` are the OWNER's account
 * identity and are only included when the artist policy says so.
 * @param {object} clip
 * @param {object|null} rec normalized record
 * @returns {string}
 */
function buildClipComment(clip, rec) {
  const metadata = (clip && clip.metadata) || {};
  const parts = [];
  const model = rec ? rec.modelVersion || rec.modelName : metadata.major_model_version;
  if (model) parts.push('Model: ' + model);
  if (clip && clip.id) parts.push('Clip ID: ' + clip.id);
  const prompt = rec ? rec.prompt : metadata.prompt;
  if (prompt) parts.push('Prompt:\n' + prompt);
  const style = rec ? rec.tags || rec.style : metadata.tags || metadata.style;
  if (style) parts.push('Style: ' + style);
  return parts.join('\n');
}


/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see 15-quota.js.
 * `scripts/check-build.sh` asserts these names do not collide with a
 * monolith declaration.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUTagging = {
    fetchCoverArt, applyTagsAndSidecars, writeSidecars, buildClipComment,
  };
}
