/**
 * 10. THE DOWNLOAD LADDER — media asset rules plus the per-clip rung runner.
 *
 * Extracted verbatim from `background/background.js` section 10. For the
 * mechanism (why the worker may call these as bare globals, why nothing here
 * is rebound at load time) read `background/parts/15-quota.js` first.
 *
 * VERIFIED BY REFERENCE COUNT BEFORE THE CUT, not assumed:
 *   - 11 declarations; the only outside reads are call-time: `evaluateLadder`
 *     (from the batch driver), `runLadder` (download start), `fetchMediaAsset`,
 *     `captureHls`, `ART_MAX_BYTES`. A mechanical scan found zero top-level
 *     outside references.
 *   - The five section constants are literal or builtin-only at load time, so
 *     this part can load before the monolith body (no TDZ reads).
 *   - All outbound calls — `LADDER_BY_ID`, the settings coercers, the save and
 *     tagging parts, `log`, `describeError`, `broadcast`, `SunoAPIClient`,
 *     `chrome.downloads.*`, offscreen calls — resolve at call time.
 */

/* ==========================================================================
 * 10. THE DOWNLOAD LADDER
 * ======================================================================== */

/**
 * Why a rung cannot run for this clip. Reported verbatim by `PROBE_DRM` so the
 * user learns what would work BEFORE spending anything.
 *
 * @param {object} clip
 * @param {string[]} rungIds
 * @returns {Array<{id:string, available:boolean, metered:boolean, reason:string}>}
 */
function evaluateLadder(clip, rungIds) {
  const pickedPlain = SunoDRM && typeof SunoDRM.pickMediaUrl === 'function'
    ? SunoDRM.pickMediaUrl(clip, { preferUnencrypted: true })
    : null;
  const pickedAny = SunoDRM && typeof SunoDRM.pickMediaUrl === 'function'
    ? SunoDRM.pickMediaUrl(clip, { preferUnencrypted: false })
    : null;
  const hasMedia = !!(pickedAny && pickedAny.url);
  const hasPlain = !!(pickedPlain && pickedPlain.url && pickedPlain.encrypted === false);

  const out = [];
  for (const id of rungIds) {
    const rung = LADDER_BY_ID.get(id);
    if (!rung) {
      out.push({ id, available: false, metered: false, reason: 'unknown rung' });
      continue;
    }
    let available = true;
    let reason = rung.note;
    if (id === 'progressive') {
      available = hasPlain;
      reason = hasPlain
        ? 'an unencrypted media_urls entry exists; a plain GET will not touch the download meter'
        : 'every media_urls entry carries an `encoding` field, so there is no unencrypted asset';
    } else if (id === 'mango-drm') {
      available = hasMedia;
      reason = hasMedia
        ? 'an encrypted media_urls entry exists; rights + AES is available'
        : 'the clip exposes no usable media_urls entry';
    } else if (id === 'zip') {
      available = true;
      reason = 'batch-only; response shape is unknown and may be a job';
    }
    out.push({ id, available, metered: rung.metered, reason });
  }
  return out;
}

/**
 * One rung of the ladder. Throws an `OpError` carrying `code`, `metered` and a
 * human `reason` so the driver can decide whether to fall through, retry, or
 * stop.
 *
 * @param {object} rung a LADDER_RUNGS entry
 * @param {object} clip raw clip record
 * @param {{variant:string, signal:AbortSignal, batchId:string, overwrite:boolean,
 *   filename:string, tagOptions:object, settings:Settings}} ctx
 * @returns {Promise<{ok:true, downloadId:number, byteLength:number, source:string, metered:boolean, method:string, tagged:boolean}>}
 */
async function runLadderRung(rung, clip, ctx) {
  if (rung.id === 'progressive' || rung.id === 'mango-drm') {
    const preferUnencrypted = rung.id === 'progressive';
    const picked = SunoDRM.pickMediaUrl(clip, { preferUnencrypted });
    if (!picked) {
      throw new OpError('no_media_url',
        rung.id === 'progressive'
          ? 'no unencrypted media_urls entry on this clip'
          : 'no usable media_urls entry on this clip');
    }
    if (rung.id === 'progressive' && picked.encrypted !== false) {
      throw new OpError('no_media_url', 'no unencrypted media_urls entry on this clip');
    }
    let bearerToken = null;
    try {
      bearerToken = await getAuthToken({ force: false });
    } catch (tokenErr) {
      log('warn', 'ladder.token_unavailable', { error: describeError(tokenErr) });
    }
    // `decryptClipBuffer` performs the plain GET for an unencrypted asset and
    // the rights+AES pipeline for an encrypted one. The worker never calls
    // `fetch` against a Suno host itself.
    const decrypted = await SunoDRM.decryptClipBuffer(String(clip.id), {
      clip,
      preferUnencrypted,
      bearerToken,
      signal: ctx.signal,
      allowUnknownContainer: true,
    });
    const bytes = await toBytes(decrypted.bytes);
    // Optional conversion, paid for with the free rung's bytes rather than with
    // quota. A null result means "off, unavailable, or failed", never a
    // failure: the original bytes are saved either way.
    const rec = FILTER_AVAILABLE ? SunoFilter.normalize(clip) : null;
    const transcoded = await maybeTranscode(
      bytes,
      decrypted.container === 'wav' ? 'audio/wav' : mimeForVariant(ctx.variant),
      ctx.settings,
      ctx.signal,
      bpmFromClip(rec, clip),
      ctx.variant
    );
    const finalBytes = transcoded ? transcoded.bytes : bytes;
    const finalVariant = transcoded ? transcoded.format : ctx.variant;
    const tagged = await applyTagsAndSidecars(clip, finalBytes, ctx, finalVariant);
    const saved = await saveBytes(tagged.bytes, {
      mime: mimeForVariant(finalVariant),
      filename: ctx.filename,
      clipId: clip.id,
      // The recorded variant must match the DELIVERED file, or a later
      // `isDone(id, variant)` check would re-download the same song.
      variant: finalVariant,
      source: rung.id,
      batchId: ctx.batchId,
      overwrite: ctx.overwrite,
    });
    let sidecars = [];
    try {
      sidecars = await writeSidecars(clip, ctx.filename, Object.assign({}, ctx, {
        clipId: String(clip.id),
        variant: finalVariant,
        source: rung.id,
      }));
    } catch (sidecarErr) {
      log('warn', 'ladder.sidecars_failed', { clipId: clip.id, error: describeError(sidecarErr) });
    }
    return {
      ok: true,
      downloadId: saved.downloadId,
      byteLength: saved.byteLength,
      source: rung.id,
      metered: false,
      method: saved.method,
      tagged: tagged.tagged,
      variant: finalVariant,
      sidecars,
    };
  }

  if (rung.id === 'studio' || rung.id === 'download-route') {
    const routeKey = rung.id === 'studio' ? 'downloadStudioClip' : 'downloadClip';
    const envelope = await SunoAPIClient.request(SunoAPI.ENDPOINTS[routeKey], {
      method: 'GET',
      pathParams: { id: String(clip.id) },
      query: { format: ctx.variant },
      signal: ctx.signal,
    });
    // NEVER branch on `envelope.ok`: these routes answer HTTP 200 with a
    // REFUSAL body `{ok:false, reason, message}`. The parser is the contract.
    const parsed = SunoAPI.parseDownloadResponse(envelope.data, {
      status: envelope.status,
      headers: envelope.headers,
      responseUrl: envelope.responseUrl,
      format: ctx.variant,
    });
    if (!parsed.ok) {
      const err = new OpError('refused', `the server refused the download: ${parsed.message}`, {
        rung: rung.id,
        reason: parsed.reason,
        status: parsed.status || envelope.status || 0,
        metered: rung.metered,
      });
      err.reason = parsed.reason || 'refused';
      throw err;
    }
    if (!parsed.url) {
      throw new OpError('job_not_supported',
        `the ${rung.id} route returned a job id rather than a URL; job polling is not implemented`,
        { rung: rung.id, jobId: parsed.jobId || null, metered: rung.metered });
    }
    const saved = await saveUrl(parsed.url, {
      filename: ctx.filename,
      clipId: clip.id,
      variant: ctx.variant,
      source: rung.id,
      batchId: ctx.batchId,
      overwrite: ctx.overwrite,
    });
    return {
      ok: true,
      downloadId: saved.downloadId,
      byteLength: saved.byteLength,
      source: rung.id,
      metered: true,
      method: saved.method,
      tagged: false,
    };
  }

  if (rung.id === 'wav-official') {
    if (!ctx.settings.allowMeteredExtras) {
      throw new OpError('not_enabled', 'the official WAV endpoint is a metered opt-in (settings.allowMeteredExtras)');
    }
    const convert = await SunoAPIClient.request(SunoAPI.ENDPOINTS.convertWav, {
      method: 'POST',
      pathParams: { id: String(clip.id) },
      body: {},
      signal: ctx.signal,
    });
    if (!convert.ok) {
      // 403 here is an ENTITLEMENT wall, never an auth problem, and never a
      // reason to retry or to go minting tokens.
      const info = describeError(convert.error);
      throw new OpError(info.code === 'entitlement' ? 'entitlement' : info.code,
        info.code === 'entitlement'
          ? 'this account is not entitled to the official WAV conversion'
          : `the WAV conversion request failed: ${info.message}`,
        { rung: rung.id, status: convert.status, metered: true });
    }
    const file = await SunoAPIClient.request(SunoAPI.ENDPOINTS.wavFile, {
      method: 'GET',
      pathParams: { id: String(clip.id) },
      signal: ctx.signal,
    });
    const parsed = SunoAPI.parseDownloadResponse(file.data, {
      status: file.status,
      headers: file.headers,
      responseUrl: file.responseUrl,
      format: 'wav',
    });
    if (!parsed.ok || !parsed.url) {
      throw new OpError('refused', `the WAV file route returned no URL: ${parsed.message || 'no artifact'}`,
        { rung: rung.id, metered: true });
    }
    const saved = await saveUrl(parsed.url, {
      filename: ctx.filename,
      clipId: clip.id,
      variant: 'wav',
      source: rung.id,
      batchId: ctx.batchId,
      overwrite: ctx.overwrite,
    });
    return {
      ok: true, downloadId: saved.downloadId, byteLength: saved.byteLength,
      source: rung.id, metered: true, method: saved.method, tagged: false,
    };
  }

  if (rung.id === 'hls') {
    throw new OpError('not_a_rung',
      'HLS is not a ladder rung: it needs a segment list captured from the page, which only the '
      + 'HLS_CAPTURE hand-off can provide. Ask the page UI to capture this clip.');
  }
  throw new OpError('unsupported_rung', `rung "${rung.id}" is not implemented in the single-clip path`);
}

/**
 * Walk the ladder for one clip, in order, falling through on every failure.
 *
 * @param {object} clip raw clip record
 * @param {{variant:string, sourceLadder:string[], signal:AbortSignal, batchId:string,
 *   overwrite:boolean, tagOptions:object, settings:Settings, workspaceName:string,
 *   versionIndex:number}} ctx
 * @returns {Promise<{ok:boolean, source?:string, metered?:boolean, error?:object,
 *   attempts:Array<{rung:string, ok:boolean, code:string, message:string}>}>}
 */
async function runLadder(clip, ctx) {
  const attempts = [];
  // `ctx.sourceLadder` is already normalised (and may be deliberately empty).
  // Re-normalising an empty array here would resurrect the default rungs and
  // spend metered quota the user explicitly disabled.
  const ladder = Array.isArray(ctx.sourceLadder)
    ? ctx.sourceLadder.slice()
    : normalizeLadder(ctx.sourceLadder, ctx.settings.allowMeteredExtras);
  if (!ladder.length) {
    return {
      ok: false,
      attempts,
      error: {
        code: 'ladder_empty',
        message: 'The download ladder is empty: every rung is either disabled or an opt-in that has not '
          + 'been granted. Enable "allow metered extras" for the official WAV route, or restore at least '
          + 'one of progressive / mango-drm / studio / download-route.',
        retryable: false,
      },
    };
  }
  const path = buildDownloadPath(clip, {
    variant: ctx.variant,
    settings: ctx.settings,
    workspaceName: ctx.workspaceName,
    versionIndex: ctx.versionIndex,
  });

  for (const rungId of ladder) {
    const rung = LADDER_BY_ID.get(rungId);
    if (!rung) continue;
    if (ctx.signal && ctx.signal.aborted) {
      return { ok: false, error: { code: 'aborted', message: 'the batch was cancelled' }, attempts };
    }
    const rungCtx = Object.assign({}, ctx, { filename: path.path, rung });
    try {
      const result = await runLadderRung(rung, clip, rungCtx);
      // A rung may deliver a different variant than was requested (the WAV
      // transcode). The filename and the recorded variant must both follow the
      // bytes that were actually written, or `isDone(id, variant)` will
      // disagree with the file on disk.
      let finalPath = path;
      if (result.variant && result.variant !== ctx.variant) {
        finalPath = buildDownloadPath(clip, {
          variant: result.variant,
          settings: ctx.settings,
          workspaceName: ctx.workspaceName,
          versionIndex: ctx.versionIndex,
        });
      }
      attempts.push({ rung: rung.id, ok: true, code: 'ok', message: rung.note });
      return Object.assign({ ok: true, filename: finalPath.path, attempts }, result);
    } catch (err) {
      const info = describeError(err);
      attempts.push({ rung: rung.id, ok: false, code: info.code, message: info.message });
      if (isAbortLike(err)) {
        return { ok: false, error: { code: 'aborted', message: info.message }, attempts };
      }
      log('warn', 'ladder.rung_failed', { clipId: clip && clip.id, rung: rung.id, code: info.code, message: info.message });
      // Fall through: that is the entire point of a ladder.
    }
  }

  return {
    ok: false,
    filename: path.path,
    attempts,
    error: {
      code: 'ladder_exhausted',
      message: 'every rung in the ladder failed for this clip: '
        + attempts.map((a) => `${a.rung}=${a.code}`).join(', '),
      retryable: attempts.some((a) => a.code === 'timeout' || a.code === 'network_error'),
    },
  };
}

/* ==========================================================================
 * 10b. HLS HAND-OFF
 *
 * The page (which has a MediaSource) captures a stream and hands the ordered
 * segment list to this worker, which reassembles the bytes and saves them.
 *
 * THIS IS THE ONE DELIBERATE EXCEPTION to "no fetch outside SunoAPIClient",
 * and the reason is mechanical, not stylistic: `SunoAPIClient.request` enforces
 * `SunoAPI.ENDPOINTS`, a table of verified API routes, and a signed media-CDN
 * segment is not an API route. Rather than widen that table (which would let any
 * future call site issue an unverified request), the segment fetch below uses its
 * own narrow allowlist, refuses plaintext, and refuses the API host outright.
 * No Suno API call is ever made through it.
 * ======================================================================== */

/** Hosts a media asset (HLS segment, cover image) may be served from. */
const MEDIA_ALLOWED_HOST_RE = /^(?:[a-z0-9-]+\.)*(?:suno\.ai|suno\.com|suno\.com\.cn|cloudfront\.net|amazonaws\.com)$/i;
/** Never fetched here, even though it matches the allowlist: it is the API host. */
const MEDIA_API_HOST_RE = /(^|\.)studio-api(\.prod)?\.suno\.com$/i;
/** Ceiling on a single media asset. */
const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
/** Ceiling on the segment count, so a hostile list cannot spin the worker. */
const HLS_MAX_SEGMENTS = 4000;
/** Cover art is small; refuse anything that claims to be bigger. */
const ART_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Fetch a media asset (HLS segment or cover image) with an allowlist, refusing
 * plaintext and the API host outright. This is the ONE place in this file that
 * calls `fetch` outside `SunoAPIClient`, and the reason is mechanical rather
 * than stylistic: `SunoAPIClient.request` enforces `SunoAPI.ENDPOINTS`, a table
 * of verified API routes, and a signed media-CDN asset is not an API route.
 * Widening that table instead would let any future call site issue an
 * unverified request against the user's account.
 *
 * @param {string} url
 * @param {{signal?:AbortSignal, maxBytes?:number, label?:string}} [opts]
 * @returns {Promise<Uint8Array>}
 */
async function fetchMediaAsset(url, opts) {
  const options = opts || {};
  const maxBytes = options.maxBytes || MEDIA_MAX_BYTES;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (parseErr) {
    void parseErr;
    throw new OpError('bad_media_url', 'media URL is not parseable');
  }
  if (parsed.protocol !== 'https:') {
    throw new OpError('bad_media_url', 'media URL must be https');
  }
  if (MEDIA_API_HOST_RE.test(parsed.hostname)) {
    throw new OpError('bad_media_url', 'the API host is never fetched as a media asset');
  }
  if (!MEDIA_ALLOWED_HOST_RE.test(parsed.hostname)) {
    throw new OpError('bad_media_url', 'media host is not allowlisted: ' + parsed.hostname);
  }
  const response = await fetch(parsed.href, {
    signal: options.signal || null,
    credentials: 'omit',
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new OpError('media_fetch_failed',
      `${options.label || 'media'} ${response.status} for ${parsed.hostname}`);
  }
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OpError('too_large', `${options.label || 'media'} declares ${declared} bytes, over the cap`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new OpError('too_large', `${options.label || 'media'} exceeds the size cap`);
  }
  return new Uint8Array(buffer);
}

/**
 * Fetch one HLS media segment.
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {number} remainingBytes
 * @returns {Promise<Uint8Array>}
 */
async function fetchHlsSegment(url, signal, remainingBytes) {
  return fetchMediaAsset(url, { signal, maxBytes: remainingBytes, label: 'segment' });
}

/**
 * Reassemble an fMP4 from an init segment plus media segments and save it.
 *
 * `downloads.markDone` is NOT called here: the row is marked in-progress and
 * then settled by the `chrome.downloads.onChanged` observer, like every other
 * path.
 *
 * @param {{clipId:string, initUrl?:string, segments?:string[],
 *   segmentUrls?:string[], mime?:string, title?:string, variant?:string}} payload
 * @returns {Promise<object>} `{ok, clipId, bytes, segments, downloadId, filename, source}`
 */
async function captureHls(payload) {
  await loadSettings();
  if (settingsCache.allowHlsCapture !== true) {
    // Off by default. This rung is page manipulation: the content script had to
    // patch MediaSource on Suno's own page to collect the segments at all.
    return {
      ok: false,
      code: 'hls_disabled',
      error: 'HLS capture is disabled. It requires the page to patch MediaSource on Suno\'s own '
        + 'player, which trips abuse heuristics; enable settings.allowHlsCapture to accept that.',
    };
  }
  const clipId = String(payload.clipId || '');
  // The content script sends `segments`; `segmentUrls` is accepted as an alias.
  const segments = (Array.isArray(payload.segments) ? payload.segments
    : Array.isArray(payload.segmentUrls) ? payload.segmentUrls : [])
    .map(String).filter(Boolean);
  if (!clipId) return { ok: false, error: 'clipId is required', code: 'bad_request' };
  if (!segments.length) return { ok: false, error: 'no segments supplied', code: 'bad_request' };
  if (segments.length > HLS_MAX_SEGMENTS) {
    return { ok: false, error: `too many segments (${segments.length} > ${HLS_MAX_SEGMENTS})`, code: 'bad_request' };
  }

  const variant = resolveVariant(payload.variant, settings.variant);
  const mime = payload.mime || 'audio/mp4';

  let clip = null;
  try {
    clip = await DB.clips.get(clipId);
  } catch (clipErr) {
    log('warn', 'hls.clip_read_failed', { clipId, error: describeError(clipErr) });
  }
  const record = clip || { id: clipId, title: payload.title || clipId };
  const path = buildDownloadPath(record, {
    variant,
    settings: settingsCache,
    workspaceName: 'My Workspace',
    versionIndex: 1,
  });

  const controller = new AbortController();
  const parts = [];
  let total = 0;
  await DB.downloads.markPending(clipId, variant, { source: 'hls', filename: path.path });
  await DB.downloads.markInProgress(clipId, variant, { source: 'hls', filename: path.path });
  log('info', 'hls.capture_started', { clipId, segments: segments.length });

  try {
    if (payload.initUrl) {
      const init = await fetchHlsSegment(payload.initUrl, controller.signal, MEDIA_MAX_BYTES);
      parts.push(init);
      total += init.length;
    }
    for (let i = 0; i < segments.length; i += 1) {
      if (controller.signal.aborted) throw new OpError('aborted', 'the capture was cancelled');
      const chunk = await fetchHlsSegment(segments[i], controller.signal, MEDIA_MAX_BYTES - total);
      parts.push(chunk);
      total += chunk.length;
      if (i % 25 === 0) log('debug', 'hls.progress', { clipId, fetched: i + 1, of: segments.length, bytes: total });
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }

    // `audio/mp4` is a fragmented MP4: detectContainer('m4a') is the right
    // dispatch, and letting the tagger sniff the bytes is better still.
    const tagged = await applyTagsAndSidecars(record, bytes, {
      variant, settings: settingsCache, signal: controller.signal,
    }, SunoTagger && typeof SunoTagger.detectContainer === 'function'
      ? SunoTagger.detectContainer(path.filename)
      : 'unknown');

    const saved = await saveBytes(tagged.bytes, {
      mime,
      filename: path.path,
      clipId,
      variant,
      source: 'hls',
      overwrite: settingsCache.overwrite,
    });
    log('info', 'hls.capture_saved', { clipId, bytes: saved.byteLength, segments: segments.length, method: saved.method });
    // The documented contract is {ok, bytes, segments}; the rest is additive and
    // safe for a reader that only looks at those three.
    return {
      ok: true,
      clipId,
      bytes: saved.byteLength,
      segments: segments.length,
      initSegment: !!payload.initUrl,
      variant,
      downloadId: saved.downloadId,
      filename: path.path,
      source: 'hls',
      method: saved.method,
    };
  } catch (err) {
    const info = describeError(err);
    log('warn', 'hls.capture_failed', { clipId, error: info });
    if (!isAbortLike(err)) {
      try {
        await DB.downloads.markFailed(clipId, variant, new Error(info.message), { source: 'hls' });
      } catch (dbErr) {
        log('error', 'hls.record_failed', { clipId, error: describeError(dbErr) });
      }
    }
    return { ok: false, error: info.message, code: info.code, clipId };
  }
}

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see 15-quota.js.
 * `scripts/check-build.sh` asserts these names do not collide with a
 * monolith declaration.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMULadder = {
    evaluateLadder, runLadder, runLadderRung,
    fetchMediaAsset, captureHls, fetchHlsSegment,
  };
}
