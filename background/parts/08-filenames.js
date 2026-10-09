/**
 * 8. FILENAMES — hostile string handling on the one input the user cannot
 * control and the filesystem can.
 *
 * Extracted verbatim from `background/background.js` section 8. Read
 * `background/parts/15-quota.js` first: it states the mechanism, the hoisting
 * rule, and why a part must not re-bind its own names on the worker side.
 *
 * WHY IT IS SAFE TO EXTRACT, in one sentence: this section owns NO mutable
 * module-scope state at all, and every identifier it needs from the monolith
 * (`VARIANT_EXTENSIONS`, `resolveVariant`, `DEFAULT_VARIANT`,
 * `DEFAULT_SETTINGS`, `FILTER_AVAILABLE`, `SunoFilter`, `bpmFromClip`) is read
 * inside a function body, so the move cannot change when any of them resolve.
 *
 * The four constants at the top are section-local by reference count — all
 * eleven mentions of `CONTROL_CHARS_RE` / `ILLEGAL_FILENAME_CHARS_RE` /
 * `WINDOWS_RESERVED_RE` / `MAX_BASENAME_CHARS` in this worker (four
 * declarations, seven reads) are in this file — so they moved with the section
 * rather than staying behind. They are `const` and therefore global LEXICAL
 * bindings, not `globalThis` properties; nothing outside this file reads them,
 * so nothing has to be published for them.
 *
 * The four functions are NOT section-local: `buildDownloadPath` is called from
 * §10 (the download ladder) and §10b (the HLS hand-off), so it stays a hoisted
 * global on the worker side, called bare.
 */

/* ==========================================================================
 * 8. FILENAMES
 *
 * The previous build wrote EXTENSIONLESS files and hardcoded `{format}` to
 * `wav` regardless of what was requested. Sanitisation here is hostile by
 * design: a clip title is attacker-influenced text that ends up on the user's
 * filesystem.
 * ======================================================================== */

/** C0, C1, bidi overrides, line separators, BOM. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g;
/** Characters no mainstream filesystem accepts. */
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]/g;
/** Windows device names, with or without an extension. */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Total basename cap, leaving room for the extension and a uniquifier. */
const MAX_BASENAME_CHARS = 180;

/**
 * Make ONE path segment safe: control-character strip, illegal-char
 * substitution, traversal collapse, dot/space trim, reserved-name guard,
 * length cap, NFC.
 *
 * @param {unknown} value
 * @param {{maxLen?:number}} [opts]
 * @returns {string} never empty (falls back to '_')
 */
function sanitizeSegment(value, opts) {
  const maxLen = (opts && opts.maxLen) || 100;
  let text = value === null || value === undefined ? '' : String(value);
  try {
    text = text.normalize('NFC');
  } catch (normErr) {
    void normErr; // Lone surrogates: fall through with the raw text.
  }
  text = text.replace(CONTROL_CHARS_RE, '');
  text = text.replace(ILLEGAL_FILENAME_CHARS_RE, '_');
  text = text.replace(/\s+/g, ' ').trim();
  // Collapse any run of dots so '..' can never survive as a traversal segment.
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!text) return '_';
  if (WINDOWS_RESERVED_RE.test(text)) text = '_' + text;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen).replace(/[.\s]+$/, '');
  }
  return text || '_';
}

/**
 * The extension for a variant, without a leading dot.
 *
 * Driven by `resolveVariant`, so an aliased or unknown value yields the file
 * extension of what will ACTUALLY be written, not of what was asked for. The
 * old fallback was `mp3`, a format this build cannot produce.
 *
 * @param {string} variant
 * @returns {string}
 */
function extensionFor(variant) {
  return VARIANT_EXTENSIONS[resolveVariant(variant, DEFAULT_VARIANT)];
}

/**
 * Build the replacement map for the filename template.
 *
 * Supported: {workspace} {title} {model} {year} {month} {versionIndex}
 * {clipIdShort} {bpm} {artist} {id} {format} {ext}
 *
 * `{artist}` resolves to the configured artist policy, NOT to the clip's
 * `display_name`, unless the policy is `clip-owner` — those fields are the
 * OWNER's account identity, not a third-party artist credit.
 *
 * @param {object} clip raw clip record
 * @param {object} ctx {variant, settings, workspaceName, versionIndex}
 * @returns {Record<string,string>}
 */
function buildTemplateVars(clip, ctx) {
  const settings = ctx.settings;
  const variant = ctx.variant;
  const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip || {}) : null;
  const id = String((clip && clip.id) || '');
  const metadata = (clip && clip.metadata) || {};
  const createdMs = rec ? rec.createdMs : Date.parse(String((clip && clip.created_at) || '')) || 0;
  const created = createdMs ? new Date(createdMs) : null;
  const bpm = bpmFromClip(rec, clip);
  const modelLabel = rec ? String(rec.modelLabel || rec.modelVersion || '') : String(metadata.major_model_version || '');
  const title = rec ? String(rec.title || '') : String((clip && clip.title) || '');
  const ownerName = rec ? String(rec.ownerName || '') : String((clip && clip.display_name) || '');
  const artist = settings.artistPolicy === 'clip-owner' && ownerName ? ownerName : settings.neutralArtist;

  return {
    workspace: ctx.workspaceName || 'My Workspace',
    title: title || 'untitled',
    model: modelLabel || 'unknown-model',
    artist,
    year: created ? String(created.getUTCFullYear()) : '',
    month: created ? String(created.getUTCMonth() + 1).padStart(2, '0') : '',
    day: created ? String(created.getUTCDate()).padStart(2, '0') : '',
    versionIndex: String(Number.isFinite(ctx.versionIndex) && ctx.versionIndex > 0 ? Math.floor(ctx.versionIndex) : 1),
    clipIdShort: id ? id.slice(0, 8) : '',
    id,
    bpm: bpm > 0 ? String(Math.round(bpm)) : '',
    format: extensionFor(variant),
    ext: extensionFor(variant),
  };
}

/**
 * Expand the template into a `chrome.downloads` relative path.
 *
 * Folder segments from the template are honoured up to `maxFolderDepth` (hard
 * cap 4). The extension is ALWAYS appended when the rendered name lacks one.
 *
 * @param {object} clip raw clip record
 * @param {object} ctx {variant, settings, workspaceName, versionIndex}
 * @returns {{path:string, filename:string, folders:string[]}}
 */
function buildDownloadPath(clip, ctx) {
  const settings = ctx.settings;
  const template = settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;
  const vars = buildTemplateVars(clip, ctx);
  let expanded = template;
  for (const key of Object.keys(vars)) {
    expanded = expanded.split('{' + key + '}').join(vars[key]);
  }
  // An unknown token would otherwise leave literal braces in the filename.
  expanded = expanded.replace(/\{[a-zA-Z]+\}/g, '_');

  const rawParts = expanded.split('/').filter((part) => part.trim() !== '');
  let name = rawParts.length ? rawParts[rawParts.length - 1] : 'untitled';
  const folderParts = rawParts.slice(0, -1);

  const maxDepth = Math.min(4, Math.max(0, settings.maxFolderDepth));
  const depth = Math.min(folderParts.length, maxDepth, Math.max(0, settings.folderDepth));
  const folders = folderParts
    .slice(0, depth)
    .map((part) => sanitizeSegment(part, { maxLen: 80 }))
    .filter((part) => part !== '_' || folderParts.length === 1);

  const extension = extensionFor(ctx.variant);
  let base = sanitizeSegment(name, { maxLen: MAX_BASENAME_CHARS });

  // A title that sanitises away to nothing (all dots, all control characters)
  // must not become a bare `.mp3`. Fall back to the short clip id, which is
  // always stable and always unique.
  const stemOf = (value) => {
    const dot = value.lastIndexOf('.');
    return dot > 0 ? value.slice(0, dot) : value;
  };
  if (!stemOf(base)) base = (vars.clipIdShort || 'track').replace(ILLEGAL_FILENAME_CHARS_RE, '_');

  // Guarantee the real extension is present, whatever the template rendered.
  if (!/\.[A-Za-z0-9]{1,6}$/.test(base)) base = base.replace(/[.\s]+$/, '') + '.' + extension;
  if (base.length > MAX_BASENAME_CHARS) {
    const stem = base.slice(0, MAX_BASENAME_CHARS - extension.length - 1).replace(/[.\s]+$/, '');
    base = (stem || vars.clipIdShort || 'track') + '.' + extension;
  }

  return {
    folders,
    filename: base,
    path: folders.concat([base]).join('/'),
  };
}

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see `background/parts/15-quota.js`
 * for why the worker calls these as bare globals rather than destructuring
 * them here. `scripts/check-build.sh` asserts that none of these names
 * collides with a monolith declaration, which is the one failure mode of this
 * mechanism that produces no error at all.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUFilenames = {
    sanitizeSegment, extensionFor, buildTemplateVars, buildDownloadPath,
  };
}
