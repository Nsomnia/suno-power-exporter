/**
 * 2. DIAGNOSTICS — the ring buffer, and the one `log()` the whole worker calls.
 *
 * Extracted verbatim from `background/background.js` section 2. Read
 * `background/parts/15-quota.js` first: it states the mechanism, the hoisting
 * rule, and why a part must not re-bind its own names on the worker side.
 *
 * MUTUAL DEPENDENCY WITH `03-errors.js`, IN BOTH DIRECTIONS, AND ORDER DOES NOT
 * MATTER. This section's `log()` calls `redactText`, which lives in
 * `03-errors.js`; `03-errors.js` calls `log`, which lives here. Neither
 * reference is evaluated while either file is being loaded — both are inside
 * function bodies — so the `importScripts` order between these two files is
 * genuinely irrelevant. They are listed in numeric order for readability, not
 * because anything depends on it. Stated explicitly because a reader who spots
 * the cycle will reasonably assume they must find an order that breaks it.
 *
 * THREE MUTABLE BINDINGS LIVE HERE: `diagBuffer`, `diagFlushTimer`,
 * `diagFlushPending`. All three are section-local — nothing outside this file
 * reads or writes them — so they move with the section. That was verified by
 * reference count before the move rather than assumed from the section header.
 *
 * `log()` is the highest-fan-out name in the worker, which is the one property
 * that made this worth extracting: it is exercised by every single code path,
 * so a hoisting violation introduced here would surface immediately and
 * everywhere rather than in one rarely-taken branch.
 */

/* ==========================================================================
 * 2. DIAGNOSTICS
 *
 * One `log()`, gated behind `settings.debug`, writing to a ring buffer in
 * `chrome.storage.local`. There is no `console.log` in this file: the console is
 * invisible in a packaged extension and lost the moment the worker dies.
 * ======================================================================== */

/** @type {Array<{t:number,level:string,event:string,data:object}>} cache only. */
let diagBuffer = [];
let diagFlushTimer = null;
let diagFlushPending = false;

/** Anything matching this never reaches the log, at any level. */
const SENSITIVE_KEY_RE = /(token|jwt|authorization|bearer|password|secret|cookie|session_key|private_key|content_key|user_key|glt|iv)/i;

/**
 * Make a value safe to log: drop sensitive keys, cap depth and string length,
 * and turn anything unserialisable into a marker rather than throwing.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function sanitizeLogData(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 400 ? value.slice(0, 400) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '[function]';
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name}(${value.byteLength})]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer(${value.byteLength})]`;
  if (depth >= 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 40).map((entry) => sanitizeLogData(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    let kept = 0;
    for (const key of Object.keys(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      if (kept >= 40) break;
      out[key] = sanitizeLogData(value[key], depth + 1);
      kept += 1;
    }
    return out;
  }
  return String(value);
}

/**
 * THE single logging entry point.
 *
 * Persists to `chrome.storage.local` when `settings.debug` is on, and ALWAYS for
 * `error` level — an error you cannot see is the defect that just shipped.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event stable, greppable event name
 * @param {object} [data] structured context (redacted automatically)
 * @returns {void}
 */
function log(level, event, data) {
  try {
    diagBuffer.push({ t: Date.now(), level, event, data: sanitizeLogData(data || {}) });
    if (diagBuffer.length > DIAG_BUFFER_CAP) {
      diagBuffer.splice(0, diagBuffer.length - DIAG_BUFFER_CAP);
    }
    scheduleDiagFlush();
  } catch (logErr) {
    // A logger that throws is worse than no logger, but it must not take the
    // worker down. Record the fact in the console-free path we still have:
    // the last entry is silently dropped and the flush still runs.
    void logErr;
    scheduleDiagFlush();
  }
}

/**
 * Arm the write-behind flush. Coalesced so a hot loop cannot produce one
 * storage write per log line.
 * @returns {void}
 */
function scheduleDiagFlush() {
  if (diagFlushTimer !== null || diagFlushPending) return;
  diagFlushPending = true;
  diagFlushTimer = setTimeout(() => {
    diagFlushTimer = null;
    diagFlushPending = false;
    void flushDiagnostics();
  }, DIAG_FLUSH_MS);
}

/**
 * Write the in-memory ring buffer through to `chrome.storage.local`, trimming
 * the stored buffer to the cap.
 * @returns {Promise<void>}
 */
async function flushDiagnostics() {
  const settings = settingsCache;
  const hasError = diagBuffer.some((entry) => entry.level === 'error');
  if (!hasError && !(settings && settings.debug)) return;
  const batch = diagBuffer.slice();
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.DIAGNOSTICS);
    const existing = Array.isArray(stored[STORAGE_KEYS.DIAGNOSTICS])
      ? stored[STORAGE_KEYS.DIAGNOSTICS]
      : [];
    const merged = existing.concat(batch).slice(-DIAG_BUFFER_CAP);
    await chrome.storage.local.set({ [STORAGE_KEYS.DIAGNOSTICS]: merged });
  } catch (flushErr) {
    // Storage can be unavailable during extension update. Nothing to do but
    // keep the in-memory buffer and try again on the next flush.
    void flushErr;
  }
}

/**
 * Read the persisted ring buffer back, newest last.
 * @returns {Promise<Array<object>>}
 */
async function readDiagnostics() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.DIAGNOSTICS);
    const entries = stored[STORAGE_KEYS.DIAGNOSTICS];
    return Array.isArray(entries) ? entries.slice(-DIAG_BUFFER_CAP) : [];
  } catch (readErr) {
    void readErr;
    return [];
  }
}

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see `background/parts/15-quota.js`
 * for why the worker calls these as bare globals. `scripts/check-build.sh`
 * asserts none of these names collides with a monolith declaration, which is
 * the one failure mode of this mechanism that raises no error at all.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUDiagnostics = {
    sanitizeLogData, log, scheduleDiagFlush, flushDiagnostics, readDiagnostics,
  };
}
