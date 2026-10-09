/**
 * 15. QUOTA — the download meter, and the credits that are NOT the meter.
 *
 * Extracted verbatim from `background/background.js` section 15. This is the
 * first section pulled out of the monolith, so the loading rules are worth
 * stating once, here, rather than repeating in every part:
 *
 *   - The worker is a CLASSIC worker (`manifest.json` declares no
 *     `"type": "module"`), and `importScripts` evaluates in the SAME global
 *     scope. So the top-level `function` declarations below become globals that
 *     `background.js` can call, and `background.js` can call them back.
 *   - That cuts both ways, and the hazard is HOISTING, not scoping. Everything
 *     this part references from the monolith — `log`, `OpError`,
 *     `describeError`, `classifyAuthFailure`, `STORAGE_KEYS`, `SunoAPIClient`,
 *     `SunoAPI` — is referenced at CALL time, never at load time. `importScripts`
 *     runs at `background.js:168`, long before those are defined, so a
 *     load-time reference here would throw on every worker wake. Call-time is
 *     what makes the split safe.
 *   - Keep it that way: no top-level code in a part may CALL into the monolith.
 *     Declare and export only. A part that runs at load time is a part that
 *     breaks the moment the importScripts list is reordered.
 *
 * What this part owns: the flat quota view every surface reads, the fetch
 * behind it, and the toolbar badge.
 *
 * Deliberately NOT here, because it is a different resource and conflating them
 * is the bug the comment on `quotaView` describes: credits.
 */

/* ==========================================================================
 * 15. QUOTA
 * ======================================================================== */

/**
 * A flat quota view for every consumer.
 *
 * `downloads` and `credits` are deliberately SEPARATE objects: credits are a
 * different resource from the download meter, and conflating them is how the
 * old badge cheerfully reported plenty of headroom while downloads were
 * exhausted. The scalar aliases exist because the page UI reads several
 * spellings; they all carry the SAME number.
 *
 * @param {object} quota a `SunoAPIClient.quota()` result
 * @returns {object}
 */
function quotaView(quota) {
  if (!quota) return null;
  const remaining = quota.unlimited === true
    ? null
    : (typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : quota.remaining);
  const view = {
    used: typeof quota.used === 'number' ? quota.used : null,
    limit: typeof quota.limit === 'number' ? quota.limit : null,
    remaining,
    effectiveRemaining: typeof quota.effectiveRemaining === 'number' ? quota.effectiveRemaining : null,
    additionalRemaining: typeof quota.additionalRemaining === 'number' ? quota.additionalRemaining : null,
    unlimited: quota.unlimited === true,
    resetsOn: quota.resetsOn || null,
    plan: quota.plan || null,
    canBulkDownload: quota.canBulkDownload === undefined ? null : quota.canBulkDownload,
    // Aliases. Identical values, spelled so no consumer has to guess.
    left: remaining,
    available: remaining,
    downloadsRemaining: remaining,
    total: typeof quota.limit === 'number' ? quota.limit : null,
    resetsAt: quota.resetsOn || null,
    resetAt: quota.resetsOn || null,
    resetDate: quota.resetsOn || null,
    fetchedAt: quota.fetchedAt || Date.now(),
  };
  return view;
}

/**
 * The DOWNLOAD quota. Credits are a DIFFERENT resource and are reported in a
 * separate field, never merged — the old badge showed credits.
 * @param {{refresh?:boolean}} payload
 * @returns {Promise<object>}
 */
async function getQuota(payload) {
  if (!SunoAPIClient || typeof SunoAPIClient.quota !== 'function') {
    throw new OpError('no_quota', 'lib/api.js did not register.');
  }
  let quota;
  try {
    quota = await SunoAPIClient.quota({ force: payload.refresh === true });
  } catch (quotaErr) {
    const info = describeError(quotaErr);
    if (info.code === 'unauthorized' || info.code === 'bad_token' || info.code === 'missing_token') {
      const auth = classifyAuthFailure(quotaErr);
      throw new OpError(auth.code, auth.message, { badToken: auth.badToken });
    }
    throw new OpError(info.code, info.message);
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUOTA]: { at: Date.now(), quota } });
  } catch (cacheErr) {
    log('warn', 'quota.cache_write_failed', { error: describeError(cacheErr) });
  }
  await paintQuotaBadge(quota);
  return {
    ok: true,
    // `quota` is the flat, alias-rich download view every UI reads.
    quota: quotaView(quota),
    downloads: quotaView(quota),
    // Credits are NOT downloads. Kept in their own field on purpose.
    credits: {
      monthly: quota.monthlyCredits,
      total: quota.totalCredits,
    },
    creditPacks: Array.isArray(quota.raw && quota.raw.download_credit_packs)
      ? quota.raw.download_credit_packs
      : [],
    semantics: SunoAPI && SunoAPI.QUOTA_SEMANTICS ? SunoAPI.QUOTA_SEMANTICS.rules : null,
    fetchedAt: quota.fetchedAt,
  };
}

/**
 * Paint the toolbar badge with DOWNLOADS REMAINING, not credits.
 * @param {object} quota
 * @returns {Promise<void>}
 */
async function paintQuotaBadge(quota) {
  if (!chrome.action || typeof chrome.action.setBadgeText !== 'function') return;
  try {
    let text = '';
    if (quota.unlimited) text = '∞';
    else if (typeof quota.effectiveRemaining === 'number') text = String(Math.max(0, quota.effectiveRemaining));
    else if (typeof quota.remaining === 'number') text = String(Math.max(0, quota.remaining));
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' });
  } catch (badgeErr) {
    log('debug', 'quota.badge_failed', { error: describeError(badgeErr) });
  }
}

/* ---------------------------------------------------------------- *
 * Exports.
 *
 * WHY THERE IS NO `const quotaView = ...` ON THE OTHER SIDE: the worker is a
 * classic script sharing this global scope, so these `function` declarations
 * ARE already the worker's bindings. Declaring `const { quotaView } = SMUQuota`
 * in the worker does not shadow them safely — it throws
 * `SyntaxError: Identifier 'quotaView' has already been declared`, because a
 * top-level function declaration occupies the global lexical scope that a
 * top-level `const` also claims. Wrapping it in a block only moves the error
 * into a scope that cannot be used.
 *
 * So the contract is deliberately the least clever one available: this part
 * publishes `SMUQuota` for DISCOVERY and for the load-order check, and the
 * worker calls `quotaView` / `getQuota` / `paintQuotaBadge` as plain globals,
 * exactly as it called them when they lived inline. `scripts/check-build.sh`
 * asserts that the names this part exports are the names the worker calls, so a
 * rename that breaks the wiring fails the build instead of failing at runtime.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUQuota = { quotaView, getQuota, paintQuotaBadge };
}
