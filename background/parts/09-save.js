/**
 * 9. SAVING BYTES — and reconciling what the browser actually did.
 *
 * Extracted verbatim from `background/background.js` section 9. For the
 * mechanism (why the worker may call these as bare globals, why nothing here
 * is rebound at load time) read `background/parts/15-quota.js` first.
 *
 * VERIFIED BY REFERENCE COUNT BEFORE THE CUT, not assumed:
 *   - 10 declarations; outside references are all call-time
 *     (`saveBytes`/`saveUrl` from the download ladder, the waiter/registerer
 *     helpers from the lifecycle section); a mechanical scan found zero
 *     top-level outside reads.
 *   - The two mutable bindings (`activeDownloads`, `settleWaiters`) are
 *     section-local; nothing outside writes them.
 *   - The part's own top-level is declarations plus builtin initialisers —
 *     nothing reads a sibling-part or monolith binding at load.
 *   - All outbound references (`log`, `broadcast`, `chrome.*`,
 *     `STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS`) resolve at call time.
 */

/* ==========================================================================
 * 9. SAVING BYTES, AND RECONCILING WHAT THE BROWSER DID
 * ======================================================================== */

/**
 * `chrome.downloads.onChanged` -> record. In memory only as a fast path; the
 * durable copy lives in `chrome.storage.session` because the worker can be
 * evicted between `download()` and the event.
 * @type {Map<number,{clipId:string,variant:string,filename:string,source:string,batchId:string,bytes:number}>}
 */
const activeDownloads = new Map();

/** Waiters resolved by the onChanged listener, so a batch can count outcomes. */
const settleWaiters = new Map();

/**
 * Mirror `activeDownloads` into session storage.
 * @returns {Promise<void>}
 */
async function persistActiveDownloads() {
  try {
    const entries = [];
    for (const [id, info] of activeDownloads) entries.push([id, info]);
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS]: entries });
  } catch (persistErr) {
    log('warn', 'downloads.active_persist_failed', { error: describeError(persistErr) });
  }
}

/**
 * Reload `activeDownloads` after a worker restart.
 * @returns {Promise<void>}
 */
async function restoreActiveDownloads() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS);
    const entries = stored[STORAGE_KEYS.SESSION_ACTIVE_DOWNLOADS];
    if (Array.isArray(entries)) {
      for (const pair of entries) {
        if (Array.isArray(pair) && pair.length === 2 && typeof pair[1] === 'object' && pair[1]) {
          activeDownloads.set(Number(pair[0]), pair[1]);
        }
      }
    }
  } catch (restoreErr) {
    log('warn', 'downloads.active_restore_failed', { error: describeError(restoreErr) });
  }
}

/**
 * Ask the offscreen document for a blob URL when the buffer is too large for a
 * `data:` URL, then hand the URL to `chrome.downloads`.
 *
 * @param {Uint8Array} bytes
 * @param {{mime:string, filename:string}} target
 * @returns {Promise<{url:string, method:'data-url'|'blob-url', byteLength:number}>}
 */
async function materializeUrl(bytes, target) {
  const threshold = settingsCache.dataUrlMaxBytes;
  if (bytes.length <= threshold) {
    const base64 = bytesToBase64(bytes);
    return {
      url: 'data:' + target.mime + ';base64,' + base64,
      method: 'data-url',
      byteLength: bytes.length,
      revokeAfter: [],
    };
  }
  const url = await offscreenBlobUrl(bytes, target.mime);
  log('info', 'downloads.blob_url_used', { bytes: bytes.length, threshold, filename: target.filename });
  // The offscreen page keeps an LRU of 8 blob URLs; a long batch would evict a
  // live URL mid-transfer, so it is revoked the moment the transfer completes.
  return { url, method: 'blob-url', byteLength: bytes.length, revokeAfter: [url] };
}

/**
 * Save bytes produced inside the worker.
 *
 * `track:false` is for artefacts that are NOT songs — lyrics sidecars, cover
 * art, metadata JSON. They are handed to `chrome.downloads` but deliberately
 * NOT registered in `SunoDB.downloads`, because that store is the record of
 * which (clip, variant) pairs are finished and a `.lrc` file is not a variant.
 * Registering one there would double every count and make `isDone(id, 'mp3')`
 * ambiguous.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{mime?:string, filename:string, clipId:string, variant:string,
 *   source:string, batchId?:string, overwrite?:boolean, track?:boolean}} target
 * @returns {Promise<{downloadId:number, method:string, byteLength:number, tracked:boolean}>}
 */
async function saveBytes(bytes, target) {
  const payload = await toBytes(bytes);
  const mime = target.mime || mimeForVariant(target.variant);
  const materialized = await materializeUrl(payload, { mime, filename: target.filename });
  const downloadId = await chrome.downloads.download({
    url: materialized.url,
    filename: target.filename,
    conflictAction: target.overwrite ? 'overwrite' : 'uniquify',
    saveAs: false,
  });
  if (!Number.isFinite(downloadId)) {
    throw new OpError('download_not_started', 'chrome.downloads.download returned no id');
  }
  if (target.track === false) {
    log('debug', 'downloads.untracked_saved', { downloadId, filename: target.filename, source: target.source });
    return { downloadId, method: materialized.method, byteLength: materialized.byteLength, tracked: false };
  }
  activeDownloads.set(downloadId, {
    clipId: String(target.clipId || ''),
    variant: String(target.variant || ''),
    filename: target.filename,
    source: String(target.source || ''),
    batchId: String(target.batchId || ''),
    bytes: materialized.byteLength,
    revokeAfter: materialized.revokeAfter || [],
  });
  await persistActiveDownloads();
  log('info', 'downloads.started', {
    downloadId, method: materialized.method, bytes: materialized.byteLength, source: target.source,
  });
  return { downloadId, method: materialized.method, byteLength: materialized.byteLength, tracked: true };
}

/**
 * Hand an already-resolved CDN URL straight to `chrome.downloads` — used by the
 * metered rungs, which return a signed URL instead of bytes. Saves the buffer.
 *
 * @param {string} url
 * @param {{filename:string, clipId:string, variant:string, source:string,
 *   batchId?:string, overwrite?:boolean, byteLength?:number}} target
 * @returns {Promise<{downloadId:number, method:string, byteLength:number}>}
 */
async function saveUrl(url, target) {
  const downloadId = await chrome.downloads.download({
    url,
    filename: target.filename,
    conflictAction: target.overwrite ? 'overwrite' : 'uniquify',
    saveAs: false,
  });
  activeDownloads.set(downloadId, {
    clipId: String(target.clipId || ''),
    variant: String(target.variant || ''),
    filename: target.filename,
    source: String(target.source || ''),
    batchId: String(target.batchId || ''),
    bytes: Number(target.byteLength) || 0,
  });
  await persistActiveDownloads();
  log('info', 'downloads.started_from_url', { downloadId, source: target.source });
  return { downloadId, method: 'signed-url', byteLength: Number(target.byteLength) || 0 };
}

/**
 * Wait for the browser to report a terminal state for one download.
 *
 * This is the ONLY thing that authorises `downloads.markDone`, and it waits for
 * an OBSERVATION, never for the return of `downloads.download()`.
 *
 * @param {number} downloadId
 * @param {number} [timeoutMs]
 * @returns {Promise<{state:'complete'|'interrupted'|'timeout', error?:string, bytes?:number}>}
 */
function awaitDownloadSettlement(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settleWaiters.delete(downloadId);
      resolve({ state: 'timeout' });
    }, timeoutMs || DOWNLOAD_SETTLE_TIMEOUT_MS);
    settleWaiters.set(downloadId, {
      resolve: (outcome) => {
        clearTimeout(timer);
        settleWaiters.delete(downloadId);
        resolve(outcome);
      },
    });
  });
}

/**
 * `chrome.downloads.onChanged`.
 *
 * `download.error` is a STRING on the delta item. The previous build tested a
 * non-existent `errorDetails` field INSIDE `state === 'complete'`, so the branch
 * was permanently dead and its polarity backwards: failures were only ever
 * supposed to be detected from inside the success case.
 *
 * @param {object} delta
 * @returns {Promise<void>}
 */
async function onDownloadChanged(delta) {
  if (!delta || !Number.isFinite(delta.id)) return;
  const state = delta.state && delta.state.current;
  const errorCode = delta.error && delta.error.current ? String(delta.error.current) : null;
  if (!state && !errorCode) return;

  const info = activeDownloads.get(delta.id) || null;
  const finish = async (outcome) => {
    const waiter = settleWaiters.get(delta.id);
    if (waiter) waiter.resolve(outcome);
    activeDownloads.delete(delta.id);
    await persistActiveDownloads();
  };

  if (!info || !info.clipId) {
    log('debug', 'downloads.changed_untracked', { downloadId: delta.id, state, errorCode });
    return;
  }

  if (state === 'complete' && !errorCode) {
    // INVARIANT A, site 1 of 2: observed completion.
    await DB.downloads.markDone(info.clipId, info.variant, {
      proof: 'downloads.onChanged:complete',
      filename: info.filename,
      bytes: Number.isFinite(info.bytes) ? info.bytes : undefined,
      source: info.source,
      chromeDownloadId: delta.id,
    });
    log('info', 'downloads.completed', { downloadId: delta.id, clipId: info.clipId, variant: info.variant });
    if (info.revokeAfter && info.revokeAfter.length) void revokeBlobUrls(info.revokeAfter);
    await finish({ state: 'complete', bytes: info.bytes || 0 });
    return;
  }

  if (errorCode || state === 'interrupted') {
    const message = `chrome.downloads reported ${state || 'error'}${errorCode ? ': ' + errorCode : ''}`;
    await DB.downloads.markFailed(info.clipId, info.variant, new Error(message), { source: info.source });
    log('warn', 'downloads.failed', { downloadId: delta.id, clipId: info.clipId, state, errorCode });
    if (info.revokeAfter && info.revokeAfter.length) void revokeBlobUrls(info.revokeAfter);
    await finish({ state: 'interrupted', error: message });
    return;
  }

  log('debug', 'downloads.progress', { downloadId: delta.id, state });
}

/**
 * Worker startup reconciliation.
 *
 * 1. Anything left `in_progress` in IndexedDB was written by an EVICTED worker.
 *    `resetInProgress()` flips it back to `pending` — it is emphatically not
 *    done, and this is the whole reason the invariant exists.
 * 2. Then ask Chrome what actually happened to every download we started, so
 *    transfers that completed while the worker was dead are recorded correctly
 *    instead of being retried.
 *
 * @returns {Promise<{recovered:number, reconciled:number, orphaned:number}>}
 */
async function reconcileDownloadsOnStartup() {
  let recovered = 0;
  let reconciled = 0;
  let orphaned = 0;

  try {
    const reset = await DB.downloads.resetInProgress();
    recovered = reset.recovered || 0;
    if (recovered > 0) log('warn', 'downloads.reset_in_progress', { recovered });
  } catch (resetErr) {
    log('error', 'downloads.reset_in_progress_failed', { error: describeError(resetErr) });
  }

  try {
    const items = await chrome.downloads.search({ limit: 200, orderBy: ['-startTime'] });
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const [downloadId, info] of Array.from(activeDownloads)) {
      const item = byId.get(downloadId);
      if (!item) {
        // Chrome has no record of it: the transfer never started.
        await DB.downloads.markFailed(info.clipId, info.variant,
          new Error('no record of this download in the browser; it never started'),
          { source: info.source });
        activeDownloads.delete(downloadId);
        orphaned += 1;
        continue;
      }
      // ERROR FIRST, state second. Chrome can report `state:'complete'` WITH a
      // non-null `error`, so testing the state first would mark a FAILED
      // transfer done. That polarity — looking for an error only inside the
      // success case — is exactly the bug the previous build shipped.
      if (item.error) {
        await DB.downloads.markFailed(info.clipId, info.variant,
          new Error(`browser reports ${item.error}`), { source: info.source });
        reconciled += 1;
      } else if (item.state === 'complete') {
        // INVARIANT A, site 2 of 2: an OBSERVED completion, read from Chrome.
        await DB.downloads.markDone(info.clipId, info.variant, {
          proof: 'startup:downloads.search:complete',
          filename: info.filename,
          bytes: Number.isFinite(item.fileSize) && item.fileSize > 0 ? item.fileSize : info.bytes,
          source: info.source,
          chromeDownloadId: downloadId,
        });
        if (info.revokeAfter && info.revokeAfter.length) void revokeBlobUrls(info.revokeAfter);
        reconciled += 1;
      } else if (item.state === 'interrupted') {
        await DB.downloads.markFailed(info.clipId, info.variant,
          new Error('the browser reports the transfer as interrupted'), { source: info.source });
        reconciled += 1;
      }
      // Anything still in flight stays `pending` (resetInProgress already
      // flipped it) and will be replanned on the next batch.
      activeDownloads.delete(downloadId);
      const waiter = settleWaiters.get(downloadId);
      if (waiter) waiter.resolve({ state: item.state === 'complete' ? 'complete' : 'interrupted', error: item.error || undefined });
    }
  } catch (searchErr) {
    log('error', 'downloads.search_failed', { error: describeError(searchErr) });
  }

  await persistActiveDownloads();
  if (reconciled || orphaned) {
    log('info', 'downloads.reconciled', { reconciled, orphaned, recovered });
  }
  return { recovered, reconciled, orphaned };
}


/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see 15-quota.js.
 * `scripts/check-build.sh` asserts these names do not collide with a
 * monolith declaration.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUSave = {
    saveBytes, saveUrl, awaitDownloadSettlement,
    onDownloadChanged, reconcileDownloadsOnStartup,
    persistActiveDownloads, restoreActiveDownloads,
  };
}
