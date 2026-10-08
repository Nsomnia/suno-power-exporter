/**
 * 6. MESSAGING — the one path by which anything the worker does reaches a
 * surface that is listening.
 *
 * Extracted verbatim from `background/background.js` section 6. Read
 * `background/parts/15-quota.js` first: it states the mechanism, the hoisting
 * rule, and why a part must not re-bind its own names on the worker side.
 *
 * WHY THIS SECTION AND NOT A SMALLER ONE. `broadcast` is called from 19 sites
 * across the worker, so this is the real stress test of the part mechanism: if
 * `importScripts` ordering or a hoisting violation breaks it, it breaks
 * everywhere at once rather than quietly in one corner. Two facts keep that safe:
 *
 *   - Every identifier read from the monolith (`TRUSTED_PAGE_PATTERNS`, `log`,
 *     `findSunoTabs`) is touched at CALL time, inside function bodies, never
 *     while this file is being evaluated.
 *   - `describeError` now lives in `background/parts/03-errors.js`, which is
 *     listed BEFORE this file in the worker's `importScripts`. That ordering is
 *     a courtesy, not a requirement — the reference is call-time — but it keeps
 *     the list readable in dependency order and means a future edit that DOES
 *     reach load time fails in the obvious place.
 *
 * NOTHING HERE MAY CARRY A VERDICT. `broadcast` is the fan-out for every push
 * type, and a push carries progress, never a completeness claim: the contract
 * that says whether a crawl is complete is `syncContractView` in section 13, and
 * a second surface inventing its own answer from a push is exactly the drift
 * this repo's contract exists to prevent.
 */

/* ==========================================================================
 * 6. MESSAGING
 *
 * `chrome.runtime.sendMessage` from a service worker reaches extension pages
 * (popup / options / side panel) but NOT content scripts. The previous build
 * acknowledged that in a comment and then only used the broken path, so no event
 * ever reached the page. Every push goes to both.
 * ======================================================================== */

/**
 * Deliver a push to extension pages AND to content scripts in Suno tabs.
 * @param {object} message
 * @returns {Promise<void>} resolves when both fan-outs have been attempted
 */
async function broadcast(message) {
  if (!message || typeof message.type !== 'string') return;
  try {
    // No inner `.catch()`: the outer catch below logs. An empty rejection
    // handler here is exactly the kind of swallow this file forbids.
    await chrome.runtime.sendMessage(message);
  } catch (runtimeErr) {
    log('debug', 'broadcast.runtime_failed', { type: message.type, error: describeError(runtimeErr) });
  }
  try {
    const tabs = await findSunoTabs();
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (tabErr) {
        // A tab with no listener (or a navigating frame) is normal. One
        // message per tab per push, so this is cheap and must not be retried.
        log('debug', 'broadcast.tab_failed', { type: message.type, tabId: tab.id });
        void tabErr;
      }
    }
  } catch (tabsErr) {
    log('debug', 'broadcast.tab_query_failed', { type: message.type, error: describeError(tabsErr) });
  }
}

/**
 * Is this message from a source we are willing to take instructions from?
 *
 * Both halves matter: `sender.id` alone admits any extension page, and
 * `sender.url` alone is absent for some senders. The previous build checked
 * NEITHER on `TRIGGER_NATIVE_DOWNLOAD`, which downloaded an arbitrary
 * caller-supplied URL.
 *
 * @param {chrome.runtime.MessageSender} sender
 * @returns {{ok:boolean, reason?:string}}
 */
function validateSender(sender) {
  if (!sender) return { ok: false, reason: 'no sender' };
  if (sender.id !== chrome.runtime.id) return { ok: false, reason: 'sender is not this extension' };
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (!url) return { ok: false, reason: 'sender has no url' };
  for (const pattern of TRUSTED_PAGE_PATTERNS) {
    if (pattern.test(url)) return { ok: true };
  }
  return { ok: false, reason: 'sender url is not allowlisted: ' + url.slice(0, 120) };
}

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see `background/parts/15-quota.js`
 * for why the worker calls these as bare globals. `scripts/check-build.sh`
 * asserts neither name collides with a monolith declaration, which is the one
 * failure mode of this mechanism that raises no error at all.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUMessaging = { broadcast, validateSender };
}
