/**
 * 12. BATCH DRIVER — plan, leasing, per-clip rung execution, quota guard.
 *
 * Extracted verbatim from `background/background.js` section 12. For the
 * mechanism read `background/parts/15-quota.js` first.
 *
 * VERIFIED BY REFERENCE COUNT BEFORE THE CUT, not assumed:
 *   - 16 declarations; the outside-facing ones are all driven at call time
 *     (`startBatch`/`runBatch`/`cancelBatch`/`retryFailedBatch` from the
 *     router and lifecycle; `readPlan` for batch resume; `batchController`/
 *     `activeBatchId` read from the cancel/poll paths). Mechanical scan found
 *     zero top-level outside reads.
 *   - The two mutable bindings (`batchController`, `activeBatchId`) are
 *     section-local; nothing outside assigns them.
 *   - Load-safe: its only evaluable top-level code is `let x = null;` twice —
 *     declaration-only at load.
 *   - All outbound references — quota, save, tagging, ladder parts, `log`,
 *     `describeError`, `broadcast`, `DB.*`, `SunoAPIClient`, `chrome.*` —
 *     resolve at call time.
 */

/* ==========================================================================
 * 12. BATCH DRIVER
 * ======================================================================== */

/**
 * @typedef {object} BatchPlan
 * @property {string} batchId
 * @property {string} variant
 * @property {string[]} sourceLadder
 * @property {boolean} overwrite
 * @property {boolean} dryRun
 * @property {number} createdAt
 * @property {'planned'|'running'|'done'|'cancelled'|'error'|'shortfall'} status
 * @property {'complete'|'quota'|'ladder_exhausted'|'cancelled'} [stoppedReason]
 *   WHY the run ended, when it ended before or short of the plan. Absent until
 *   the batch settles.
 * @property {object} [quotaStop] set only when `stoppedReason === 'quota'`:
 *   `{reason, remaining, reserve, meteredDownloads, remainingItems, resetsOn, at}`
 * @property {Array<{clipId:string,title:string,state:string,source?:string,
 *   error?:string,bytes?:number,filename?:string}>} items
 * @property {number} cursor
 * @property {{ok:number,failed:number,skipped:number,bytes:number}} stats
 */

/** @type {AbortController|null} live batch; recreated per worker wake. */
let batchController = null;
/** @type {string|null} the batch this worker is currently running. */
let activeBatchId = null;

/**
 * Persist the plan so an evicted worker can rebuild it.
 * @param {BatchPlan} plan
 * @returns {Promise<BatchPlan>}
 */
async function persistPlan(plan) {
  try {
    await DB.meta.set(META_KEYS.BATCH_PREFIX + plan.batchId, plan);
    await DB.meta.set(META_KEYS.ACTIVE_BATCH, plan.batchId);
  } catch (persistErr) {
    log('error', 'batch.persist_failed', { batchId: plan.batchId, error: describeError(persistErr) });
  }
  return plan;
}

/**
 * @param {string} batchId
 * @returns {Promise<BatchPlan|null>}
 */
async function readPlan(batchId) {
  try {
    return (await DB.meta.get(META_KEYS.BATCH_PREFIX + batchId, null)) || null;
  } catch (readErr) {
    log('error', 'batch.read_failed', { batchId, error: describeError(readErr) });
    return null;
  }
}

/**
 * Build a fresh batch id. Not a UUID: it must be short, sortable and legible in
 * a journal row.
 * @returns {string}
 */
function newBatchId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Resolve the clip list for a batch: an EXPLICIT id list wins, otherwise the
 * caller's filter spec is applied to the whole library.
 *
 * The previous build ignored the caller's selection entirely and re-filtered
 * everything, which is why "download these 12 rows" downloaded the library.
 *
 * @param {object} payload
 * @param {Settings} settings
 * @returns {Promise<{clips:object[], explicit:boolean, description:string}>}
 */
async function resolveBatchClips(payload, settings) {
  const explicitIds = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : null;
  if (explicitIds && explicitIds.length) {
    const clips = await loadClipsByIds(explicitIds);
    return { clips, explicit: true, description: `explicit selection (${clips.length} clips)` };
  }
  const savedSelection = await readSelectionIds();
  if (payload.useSelection === true && savedSelection.length) {
    const clips = await loadClipsByIds(savedSelection);
    return { clips, explicit: true, description: `saved selection (${clips.length} clips)` };
  }
  const context = await queryContext();
  const spec = FILTER_AVAILABLE ? SunoFilter.normalizeSpec(payload.spec || {}) : {};
  const all = await DB.clips.all(ALL_CLIPS);
  const filtered = FILTER_AVAILABLE ? SunoFilter.apply(all, spec, context) : all;
  const sorted = FILTER_AVAILABLE
    ? SunoFilter.sort(filtered, payload.sort || 'newest', payload.order || 'desc')
    : filtered;
  const description = FILTER_AVAILABLE ? SunoFilter.describe(spec) : 'no filter engine available';
  return { clips: sorted, explicit: false, description };
}

/**
 * Load clips by id, preserving the caller's order and skipping unknown ids.
 * @param {string[]} ids
 * @returns {Promise<object[]>}
 */
async function loadClipsByIds(ids) {
  const out = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await DB.clips.getMany(ids.slice(i, i + CHUNK));
    for (const row of rows) if (row) out.push(row);
  }
  return out;
}

/**
 * THE single quota-fetch path. Fetch the meter once and write it to the cache
 * the popup's quota tile reads, in ONE place.
 *
 * `quotaPreflight` (before a batch), the mid-batch guard (during) and
 * `runBatch`'s post-batch read (after) all call this; the fetch + cache-write
 * logic deliberately exists only here so a third caller cannot grow its own
 * subtly different copy. `null` means "could not read the meter" and callers MUST
 * treat that as "unknown", never as "zero remaining".
 *
 * @param {string} event diagnostic event name for a failed fetch
 * @param {'debug'|'info'|'warn'|'error'} [level] a recurring in-flight poll is
 *   not a warning; a pre-flight that could not verify the plan is
 * @returns {Promise<object|null>} a `SunoAPIClient.quota()` result, or null
 */
async function readQuotaCached(event, level = 'warn') {
  if (!SunoAPIClient || typeof SunoAPIClient.quota !== 'function') return null;
  let quota;
  try {
    quota = await SunoAPIClient.quota({ force: true });
  } catch (quotaErr) {
    log(level, event, { error: describeError(quotaErr) });
    return null;
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUOTA]: { at: Date.now(), quota } });
  } catch (storeErr) {
    log('warn', 'quota.cache_write_failed', { error: describeError(storeErr) });
  }
  return quota;
}

/**
 * The quota preflight.
 *
 * Suno's meter is `download_usage`: free 0, pro 20, premier 60 per billing
 * period, resetting on the billing date, and ONE SONG = ONE DOWNLOAD regardless
 * of format. The old badge showed CREDITS — a different resource entirely — so
 * the old UI cheerfully told users they had plenty of headroom while the
 * download meter was exhausted.
 *
 * This is a BEFORE check only. It is not, and cannot be, the in-batch guard:
 * a plan of 60 clips checked against 60 remaining is still wrong the moment one
 * clip fails, another succeeds off an unmetered rung, or a sibling tab spends
 * the meter. `runBatch`'s mid-batch guard covers that; see `guardQuotaAfterItem`.
 *
 * @param {number} planned number of unique songs in the plan
 * @returns {Promise<{shortfall:boolean, quota:object, needed:number,
 *   remaining:number|null, fits:number, packs:Array<object>, message:string|null}>}
 */
async function quotaPreflight(planned) {
  const result = { shortfall: false, quota: null, needed: planned, remaining: null, fits: planned, packs: [], message: null };
  const quota = await readQuotaCached('quota.preflight_failed');
  if (!quota) return result;
  result.quota = quota;

  const remaining = typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : null;
  result.remaining = remaining;
  result.packs = Array.isArray(quota.raw && quota.raw.download_credit_packs)
    ? quota.raw.download_credit_packs
    : [];

  if (quota.unlimited === true) return result;
  if (remaining === null) {
    result.message = 'Suno did not report a download limit for this account, so the batch will proceed unverified.';
    return result;
  }
  if (remaining >= planned) return result;

  result.shortfall = true;
  result.fits = remaining;
  result.message = `This batch needs ${planned} download${planned === 1 ? '' : 's'} but only ${remaining} remain`
    + (quota.resetsOn ? ` before the quota resets on ${quota.resetsOn}` : '')
    + '. One song uses one download regardless of format, and no rung in the ladder can produce the file without one of those slots '
    + 'unless the unencrypted media_urls or DRM rungs succeed.';
  return result;
}

/**
 * Plan and (unless dryRun) start a batch. Returns IMMEDIATELY with the batch id;
 * the loop runs detached with its own AbortController and is re-armed by an
 * alarm.
 *
 * @param {object} payload {spec?, ids?, variant, source, tagOptions, overwrite, dryRun}
 * @returns {Promise<object>} the reply body
 */
async function startBatch(payload) {
  await loadSettings();
  const settings = settingsCache;
  const variant = resolveVariant(payload.variant, settings.variant);
  const dryRun = payload.dryRun === true ? true : settings.dryRun === true;
  const sourceLadder = payload.sourceLadder || payload.source || settings.downloadSource;
  const tagOptions = Object.assign({}, settings.tagOptions, payload.tagOptions || {});
  const overwrite = typeof payload.overwrite === 'boolean' ? payload.overwrite : settings.overwrite;
  const ladder = normalizeLadder(sourceLadder, settings.allowMeteredExtras);
  if (!ladder.length) {
    // Fail fast and loudly here rather than planning N items that will each
    // report "ladder exhausted".
    return {
      ok: false,
      code: 'ladder_empty',
      error: 'The download ladder is empty. Enable "allow metered extras" for the official WAV route, '
        + 'or restore at least one of progressive / mango-drm / studio / download-route in settings.sourceLadder.',
    };
  }

  const resolved = await resolveBatchClips(payload, settings);
  if (!resolved.clips.length) {
    return { ok: false, error: 'nothing matched', code: 'empty_plan' };
  }

  // Dedupe by clip id BEFORE anything is spent: one song is one download.
  const byId = new Map();
  for (const clip of resolved.clips) {
    const id = String(clip && clip.id || '');
    if (!id || byId.has(id)) continue;
    byId.set(id, clip);
  }
  const unique = Array.from(byId.values());
  const duplicatesDropped = resolved.clips.length - unique.length;

  // Skip variants that are already recorded done (unless overwriting).
  const items = [];
  let alreadyDone = 0;
  for (const clip of unique) {
    let done = false;
    try {
      done = await DB.downloads.isDone(String(clip.id), variant);
    } catch (doneErr) {
      log('warn', 'batch.is_done_failed', { clipId: clip.id, error: describeError(doneErr) });
    }
    if (done && !overwrite) {
      alreadyDone += 1;
      continue;
    }
    items.push({
      clipId: String(clip.id),
      title: String(clip.title || ''),
      variant,
      state: 'queued',
      source: '',
      error: '',
      bytes: 0,
      filename: '',
    });
  }

  const batchId = newBatchId();
  const plan = {
    batchId,
    variant,
    sourceLadder: ladder,
    tagOptions,
    overwrite,
    dryRun,
    description: resolved.description,
    explicit: resolved.explicit,
    createdAt: Date.now(),
    status: 'planned',
    items,
    cursor: 0,
    stats: { ok: 0, failed: 0, skipped: 0, bytes: 0, duplicatesDropped, alreadyDone },
  };

  const preflight = await quotaPreflight(items.length);
  plan.preflight = {
    needed: preflight.needed,
    remaining: preflight.remaining,
    fits: preflight.fits,
    shortfall: preflight.shortfall,
    message: preflight.message,
    packs: preflight.packs,
  };

  if (preflight.shortfall) {
    plan.status = 'shortfall';
    await persistPlan(plan);
    await DB.journal.append({ batchId, phase: 'quota-shortfall', detail: preflight });
    log('warn', 'batch.quota_shortfall', { batchId, needed: preflight.needed, remaining: preflight.remaining });
    void notify('Download quota shortfall', preflight.message || 'Not enough downloads remain.');
    return {
      ok: true,
      batchId,
      planned: items.length,
      skipped: alreadyDone,
      duplicatesDropped,
      stopped: 'quota',
      quotaShortfall: {
        needed: preflight.needed,
        remaining: preflight.remaining,
        fits: preflight.fits,
        message: preflight.message,
        packs: preflight.packs,
      },
    };
  }

  await persistPlan(plan);
  await DB.journal.append({
    batchId,
    phase: 'planned',
    detail: { planned: items.length, variant, ladder: plan.sourceLadder, dryRun, description: resolved.description },
  });

  const reply = {
    ok: true,
    batchId,
    planned: items.length,
    skipped: alreadyDone,
    duplicatesDropped,
    dryRun,
    description: resolved.description,
    quota: quotaView(preflight.quota),
  };

  if (dryRun || items.length === 0) {
    plan.status = dryRun ? 'done' : 'done';
    plan.stats.skipped = items.length;
    await persistPlan(plan);
    await DB.journal.append({ batchId, phase: dryRun ? 'dry-run' : 'empty', detail: { planned: items.length } });
    log('info', 'batch.dry_run', { batchId, planned: items.length });
    reply.note = dryRun
      ? 'Dry run: the plan was computed and recorded; nothing was downloaded and no quota was spent.'
      : 'Nothing to download.';
    return reply;
  }

  // Detached. The alarm in §17 is what brings it back after an eviction.
  void runBatch(batchId);
  return reply;
}

/**
 * Run (or resume) a batch to completion.
 *
 * @param {string} batchId
 * @returns {Promise<void>}
 */
async function runBatch(batchId) {
  const plan = await readPlan(batchId);
  if (!plan) {
    log('warn', 'batch.plan_missing', { batchId });
    return;
  }
  if (plan.status === 'done' || plan.status === 'cancelled') {
    log('info', 'batch.already_settled', { batchId, status: plan.status });
    return;
  }

  if (!batchController) batchController = new AbortController();
  const signal = batchController.signal;
  activeBatchId = batchId;
  plan.status = 'running';
  plan.startedAt = plan.startedAt || Date.now();
  await persistPlan(plan);
  await DB.journal.append({ batchId, phase: 'run-start', detail: { remaining: plan.items.length } });

  await loadSettings();
  const settings = settingsCache;
  // A per-request tagOptions patch wins over the stored defaults for THIS batch
  // only; nothing is written back to settings.
  const effectiveSettings = Object.assign({}, settings, { tagOptions: plan.tagOptions || settings.tagOptions });
  const workspaceNames = await loadProjectNames();
  const total = plan.items.length;
  const startedAt = Date.now();
  let done = 0;

  /* ---- the MID-BATCH quota guard ----------------------------------
   * `quotaPreflight` reads the meter BEFORE the plan and the tail of this
   * function reads it AFTER, so NOTHING used to check DURING. A plan built
   * against a stale reading kept going and then failed item by item on the
   * metered rungs: a healthy badge, then an opaque mid-batch wall. That is the
   * old build's failure mode verbatim.
   *
   * Two rules make this cheap enough to always have on:
   *   - it counts only SUCCESSFUL METERED downloads. `progressive` and
   *     `mango-drm` do not consume the allowance, so a purely-unmetered ladder
   *     polls ZERO times and never pays for a re-meter it cannot use.
   *   - a failed poll is NOT an exhausted meter. "Could not read it" leaves the
   *     batch running; only a positive reading at or below the reserve stops it.
   * A dry run polls nothing and can never be stopped by this.
   */
  const quotaGuardOn = plan.dryRun !== true
    && settings.dryRun !== true
    && !!SunoAPIClient
    && typeof SunoAPIClient.quota === 'function';
  const quotaCheckEvery = Math.max(1, Math.round(Number(settings.quotaCheckEvery) || DEFAULT_SETTINGS.quotaCheckEvery));
  const quotaReserve = Math.max(0, Number(settings.quotaReserve) || 0);
  /** Successful metered downloads since the last poll. */
  let meteredSinceCheck = 0;
  /** Successful metered downloads in total, for the stop message. */
  let meteredTotal = 0;
  let quotaPolls = 0;
  /** @type {object|null} set the moment the guard decides to halt. */
  let quotaStop = null;
  /** In-flight poll, shared so N pool workers trigger ONE fetch. @type {Promise<object|null>|null} */
  let quotaProbe = null;

  const readQuotaOnce = async () => {
    if (quotaProbe) return quotaProbe;
    quotaPolls += 1;
    quotaProbe = readQuotaCached('batch.quota_midflight_failed', 'debug')
      .catch((probeErr) => {
        log('debug', 'batch.quota_midflight_failed', { error: describeError(probeErr) });
        return null;
      })
      .finally(() => { quotaProbe = null; });
    return quotaProbe;
  };

  /**
   * Run after each settled item. Counts metered successes, polls at most once per
   * `quotaCheckEvery` of them, and records a clean stop when the meter reaches
   * the reserve. Never throws: a guard fault must not fail a download.
   * @param {object} item
   * @returns {Promise<void>}
   */
  const guardQuotaAfterItem = async (item) => {
    if (!quotaGuardOn || quotaStop || signal.aborted) return;
    if (item.state !== 'ok') return;
    const rung = LADDER_BY_ID.get(String(item.source || ''));
    // Unmetered rungs (and an unknown source) never count and never trigger a poll.
    if (!rung || rung.metered !== true) return;
    meteredTotal += 1;
    meteredSinceCheck += 1;
    if (meteredSinceCheck < quotaCheckEvery) return;
    meteredSinceCheck = 0;

    const quota = await readQuotaOnce();
    // Cancelled while the poll was in flight: the user's decision outranks ours.
    if (signal.aborted) return;
    // No reading at all (unauthenticated, fetch failed, API absent) is UNKNOWN,
    // not zero. Keep going.
    if (!quota || quota.unlimited === true) return;
    const remaining = typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : null;
    // Suno reported no limit: there is nothing to enforce.
    if (remaining === null || remaining > quotaReserve) return;

    quotaStop = {
      reason: 'quota',
      remaining,
      reserve: quotaReserve,
      meteredDownloads: meteredTotal,
      remainingItems: Math.max(0, total - Math.min(index, total)),
      resetsOn: quota.resetsOn || null,
      at: Date.now(),
    };
    log('warn', 'batch.quota_stop', {
      batchId,
      remaining,
      reserve: quotaReserve,
      meteredDownloads: meteredTotal,
      ok: plan.stats.ok,
      remainingItems: quotaStop.remainingItems,
    });
  };

  const emitProgress = async (currentTitle) => {
    const elapsed = Date.now() - startedAt;
    const etaMs = done > 0 && done < total ? Math.round((elapsed / done) * (total - done)) : 0;
    await broadcast({
      type: 'DL_PROGRESS',
      batchId,
      done,
      total,
      ok: plan.stats.ok,
      failed: plan.stats.failed,
      skipped: plan.stats.skipped,
      currentTitle: currentTitle || '',
      bytes: plan.stats.bytes,
      etaMs,
    });
  };

  const emitItem = async (item, state) => {
    await broadcast({
      type: 'DL_ITEM',
      batchId,
      clipId: item.clipId,
      // The DELIVERED variant, which can differ from the requested one when the
      // WAV transcode kicked in.
      variant: item.variant || plan.variant,
      state,
      filename: item.filename || '',
      source: item.source || '',
      error: item.error || '',
      bytes: item.bytes || 0,
    });
  };

  /* ---- the per-item loop ---------------------------------------- */

  const runItem = async (item) => {
    const clipId = item.clipId;
    try {
      if (signal.aborted) {
        item.state = 'skipped';
        item.error = 'cancelled';
        plan.stats.skipped += 1;
        await DB.downloads.markSkipped(clipId, plan.variant, 'cancelled');
        await emitItem(item, 'skipped');
        return;
      }

      const clip = await DB.clips.get(clipId);
      if (!clip) {
        item.state = 'skipped';
        item.error = 'clip is no longer in the library';
        plan.stats.skipped += 1;
        await DB.downloads.markSkipped(clipId, plan.variant, item.error, { source: 'unknown' });
        await emitItem(item, 'skipped');
        return;
      }

      await DB.downloads.markInProgress(clipId, plan.variant, { source: plan.sourceLadder[0] || 'unknown' });
      await DB.journal.append({ batchId, clipId, variant: plan.variant, phase: 'item-start' });

      const workspaceName = resolveWorkspaceName(clip, workspaceNames);
      const versionIndex = versionIndexFor(clip, plan.items);

      let lastError = null;
      const attempts = 1 + Math.max(0, settings.retryAttempts);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal.aborted) break;
        const outcome = await runLadder(clip, {
          variant: plan.variant,
          sourceLadder: plan.sourceLadder,
          signal,
          batchId,
          overwrite: plan.overwrite,
          tagOptions: plan.tagOptions,
          settings: effectiveSettings,
          workspaceName,
          versionIndex,
        });
        if (outcome.ok) {
          // INVARIANT A: `ok` here means the browser ACCEPTED the transfer.
          // The row is only flipped to done when onChanged reports completion.
          const settled = await awaitDownloadSettlement(outcome.downloadId);
          item.filename = outcome.filename || '';
          item.source = outcome.source || '';
          item.bytes = outcome.byteLength || 0;
          item.variant = outcome.variant || plan.variant;
          plan.stats.bytes += item.bytes;
          if (settled.state === 'complete') {
            item.state = 'ok';
            plan.stats.ok += 1;
            await DB.journal.append({
              batchId, clipId, variant: item.variant, phase: 'item-ok',
              detail: { source: item.source, bytes: item.bytes },
            });
            await emitItem(item, 'ok');
          } else if (settled.state === 'timeout') {
            // The transfer is still in flight. Leave the row `in_progress`;
            // startup reconciliation owns it from here.
            item.state = 'pending';
            item.error = 'transfer still in flight; will be reconciled on the next worker wake';
            await emitItem(item, 'pending');
            log('warn', 'batch.item_settle_timeout', { batchId, clipId, downloadId: outcome.downloadId });
          } else {
            item.state = 'failed';
            item.error = settled.error || 'the browser interrupted the transfer';
            plan.stats.failed += 1;
            await emitItem(item, 'failed');
          }
          return;
        }

        lastError = outcome.error || { code: 'unknown', message: 'the ladder produced no result' };
        // `isRetryableFailure` is the authority, not the error's own flag: it is
        // the only thing that knows a 403 is an entitlement wall, a 404 will
        // never appear, and an explicit `{ok:false}` refusal is a decision.
        const retryable = isRetryableFailure(Object.assign({}, lastError, {
          status: lastError.status,
          reason: lastError.reason,
          name: lastError.code === 'aborted' ? 'AbortError' : undefined,
        }));
        if (!retryable) break;
        if (attempt < attempts) {
          log('info', 'batch.item_retry', { batchId, clipId, attempt, code: lastError.code });
          // Let the shared limiter pace the retry; it is the same token bucket
          // every other request goes through.
          try {
            await SunoAPIClient.rateLimiter.acquire({ signal });
          } catch (paceErr) {
            if (isAbortLike(paceErr)) break;
            log('warn', 'batch.item_retry_pace_failed', { error: describeError(paceErr) });
          }
        }
      }

      const info = lastError || { code: 'unknown', message: 'unknown failure' };
      if (isAbortLike(info) || signal.aborted) {
        item.state = 'skipped';
        item.error = 'cancelled';
        plan.stats.skipped += 1;
        await DB.downloads.markSkipped(clipId, plan.variant, 'cancelled');
        await emitItem(item, 'skipped');
        return;
      }
      item.state = info.code === 'entitlement' ? 'entitlement' : 'failed';
      item.error = info.message;
      plan.stats.failed += 1;
      await DB.downloads.markFailed(clipId, plan.variant, new Error(info.message), {
        source: (item.source || plan.sourceLadder[0] || 'unknown'),
      });
      await DB.journal.append({
        batchId, clipId, variant: plan.variant, phase: 'item-failed',
        detail: { code: info.code },
      });
      await emitItem(item, item.state);
    } catch (err) {
      // Per-item isolation. A single clip NEVER aborts the batch.
      const info = describeError(err);
      item.state = isAbortLike(err) ? 'skipped' : 'failed';
      item.error = info.message;
      if (item.state === 'skipped') plan.stats.skipped += 1;
      else plan.stats.failed += 1;
      log('error', 'batch.item_threw', { batchId, clipId, error: info });
      try {
        if (item.state === 'skipped') {
          await DB.downloads.markSkipped(clipId, plan.variant, info.message);
        } else {
          await DB.downloads.markFailed(clipId, plan.variant, new Error(info.message), {});
        }
        await DB.journal.append({ batchId, clipId, variant: plan.variant, phase: `item-${item.state}` });
      } catch (dbErr) {
        log('error', 'batch.item_record_failed', { clipId, error: describeError(dbErr) });
      }
      await emitItem(item, item.state);
    }
  };

  // Bounded worker pool. The shared RateLimiter, not the pool, sets the pace;
  // the pool only bounds how many decryptions are in memory at once.
  const concurrency = Math.max(1, Math.min(8, settings.concurrency));
  let index = plan.cursor || 0;
  const nextIndex = () => {
    const current = index;
    index += 1;
    return current;
  };
  const worker = async () => {
    for (;;) {
      const i = nextIndex();
      if (i >= total) return;
      if (signal.aborted) return;
      // The mid-batch quota guard reached the reserve. Stop claiming new items;
      // in-flight workers finish the item they already own and then leave.
      if (quotaStop) return;
      const item = plan.items[i];
      await runItem(item);
      done += 1;
      plan.cursor = i + 1;
      await persistPlan(plan);
      await emitProgress(item.title);
      await guardQuotaAfterItem(item);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
  } catch (poolErr) {
    // `runItem` isolates everything, so this can only be a pool-level fault.
    log('error', 'batch.pool_threw', { batchId, error: describeError(poolErr) });
  }

  const cancelled = signal.aborted;
  // The ONE field that separates "finished" from "stopped", and it must never
  // collapse them: a quota halt, an exhausted ladder and a user cancel are three
  // different outcomes with three different recoveries, and the old build
  // reported all three as a plain `DL_DONE`.
  const stoppedReason = cancelled
    ? 'cancelled'
    : (quotaStop
      ? 'quota'
      : (plan.stats.ok === 0 && plan.stats.failed > 0 ? 'ladder_exhausted' : 'complete'));
  const leftInBatch = Math.max(0, total - Math.min(index, total));
  plan.status = cancelled ? 'cancelled' : 'done';
  plan.stoppedReason = stoppedReason;
  if (quotaStop) {
    plan.quotaStop = Object.assign({}, quotaStop, { remainingItems: leftInBatch });
  }
  plan.finishedAt = Date.now();
  plan.cursor = index;
  await persistPlan(plan);
  await DB.journal.append({
    batchId,
    phase: cancelled ? 'cancelled' : 'done',
    detail: {
      ok: plan.stats.ok,
      failed: plan.stats.failed,
      skipped: plan.stats.skipped,
      stoppedReason,
      meteredDownloads: meteredTotal,
      quotaPolls,
      remainingItems: leftInBatch,
    },
  });
  if (quotaStop) {
    // A SEPARATE phase, so `DOWNLOAD_RETRY_FAILED` and the startup resume path can
    // tell a deliberate quota halt (keep `cursor`, do not re-plan the rest) from a
    // batch that ran to the end of its plan.
    await DB.journal.append({
      batchId,
      phase: 'quota-stop',
      detail: {
        stoppedReason: 'quota',
        cursor: index,
        ok: plan.stats.ok,
        remainingItems: leftInBatch,
        meteredDownloads: meteredTotal,
        quotaPolls,
        remaining: quotaStop.remaining,
        reserve: quotaStop.reserve,
        resetsOn: quotaStop.resetsOn,
      },
    });
  }

  // Read the meter one last time through the shared helper, which also refreshes
  // the cache the popup's quota tile reads, so the tile reflects the meter at the
  // moment the batch ENDED rather than the pre-batch reading.
  const quotaAfter = await readQuotaCached('batch.quota_after_failed');
  await DB.meta.set(META_KEYS.LAST_BATCH_SUMMARY, {
    batchId,
    at: plan.finishedAt,
    ok: plan.stats.ok,
    failed: plan.stats.failed,
    skipped: plan.stats.skipped,
    bytes: plan.stats.bytes,
    durationMs: plan.finishedAt - startedAt,
    stoppedReason,
    ...(quotaStop ? { quotaStop: plan.quotaStop } : {}),
  });
  await DB.journal.trim(batchId);

  await broadcast({
    type: 'DL_DONE',
    batchId,
    ok: plan.stats.ok,
    failed: plan.stats.failed,
    skipped: plan.stats.skipped,
    durationMs: plan.finishedAt - startedAt,
    stoppedReason,
    quotaPolls,
    remainingItems: leftInBatch,
    quotaStop: plan.quotaStop || null,
    quotaAfter: quotaView(quotaAfter),
  });
  activeBatchId = null;
  batchController = null;
  if (plan.quotaStop) {
    // The stop is REPORTED, never silent. Say how much of the plan fitted, how
    // much did not, and when the meter comes back.
    const saved = plan.stats.ok;
    const stop = plan.quotaStop;
    const fits = Math.max(0, stop.remaining - stop.reserve);
    await notify(
      'Download quota reached — batch stopped',
      `${saved} clip${saved === 1 ? '' : 's'} saved, ${leftInBatch} left in this batch. `
      + `The meter reports ${stop.remaining} remaining${stop.reserve > 0 ? ` against a reserve of ${stop.reserve}` : ''}, `
      + `so ${fits} more download${fits === 1 ? '' : 's'} fit${fits === 1 ? 's' : ''} before the reserve. `
      + (stop.resetsOn ? `Your quota resets on ${stop.resetsOn}.` : 'Resume this batch after it resets.')
      + ' Nothing was deleted; the remaining clips are still planned.',
    );
    log('info', 'batch.quota_stopped', {
      batchId, saved, remainingItems: leftInBatch, remaining: stop.remaining, fits,
    });
  }
  log('info', 'batch.finished', {
    batchId, ok: plan.stats.ok, failed: plan.stats.failed, skipped: plan.stats.skipped, stoppedReason,
  });
}

/**
 * Which workspace (project) a clip belongs to. Suno has NO project field on a
 * clip; membership is joined from the project feed, and `default` is named
 * "My Workspace". This is the only correct basis for a per-workspace filter.
 * @param {object} clip
 * @param {Map<string,string>} names
 * @returns {string}
 */
function resolveWorkspaceName(clip, names) {
  const ids = Array.isArray(clip.projectIds) && clip.projectIds.length
    ? clip.projectIds
    : (clip._i && Array.isArray(clip._i.project_ids) ? clip._i.project_ids : []);
  for (const id of ids) {
    const name = names.get(String(id));
    if (name) return name;
  }
  return 'My Workspace';
}

/**
 * Ordinal of this clip among its plan siblings that share a title. Gives a
 * template like `{title}_{versionIndex}` a stable per-batch numbering for
 * generated variants of the same song.
 * @param {object} clip
 * @param {Array<{clipId:string,title:string}>} items
 * @returns {number}
 */
function versionIndexFor(clip, items) {
  const title = String((clip && clip.title) || '').trim().toLowerCase();
  if (!title) return 1;
  let index = 0;
  for (const item of items) {
    if (String(item.title || '').trim().toLowerCase() === title) index += 1;
    if (item.clipId === String(clip.id)) return index || 1;
  }
  return 1;
}

/**
 * Cancel the running batch. The previous `CANCEL_DOWNLOAD` message had ZERO
 * senders and therefore never fired; this one actually aborts the controller.
 * @returns {Promise<{ok:boolean, batchId:string|null, aborted:boolean}>}
 */
async function cancelBatch() {
  const batchId = activeBatchId || (await DB.meta.get(META_KEYS.ACTIVE_BATCH, null));
  if (batchController) {
    batchController.abort();
    log('info', 'batch.cancel_requested', { batchId });
  }
  if (batchId) {
    const plan = await readPlan(batchId);
    if (plan) {
      plan.status = 'cancelled';
      plan.cancelledAt = Date.now();
      await persistPlan(plan);
      await DB.journal.append({ batchId, phase: 'cancel-requested' });
    }
  }
  await disarmKeepalive();
  return { ok: true, batchId: batchId || null, aborted: !!batchController };
}

/**
 * Re-plan every previously FAILED item into a fresh batch.
 * @returns {Promise<object>}
 */
async function retryFailedBatch() {
  await loadSettings();
  const failed = await DB.downloads.history({ limit: 500, states: ['failed'] });
  if (!failed.length) return { ok: true, planned: 0, batchId: null, note: 'no failed downloads to retry' };
  const ids = failed.map((row) => String(row.clipId)).filter(Boolean);
  const variants = new Set(failed.map((row) => String(row.variant)));
  const variant = variants.size === 1 ? Array.from(variants)[0] : settingsCache.variant;
  // Clear the failed rows so the planner treats them as work, not as history.
  for (const id of ids) {
    try {
      await DB.downloads.markPending(id, variant, { source: 'retry' });
    } catch (resetErr) {
      log('warn', 'batch.retry_reset_failed', { clipId: id, error: describeError(resetErr) });
    }
  }
  return startBatch({ ids, variant });
}

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see 15-quota.js.
 * `scripts/check-build.sh` asserts these names do not collide with a
 * monolith declaration.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUBatch = {
    startBatch, runBatch, cancelBatch, retryFailedBatch, readPlan,
  };
}
