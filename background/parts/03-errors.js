/**
 * 3. ERRORS, REDACTION, CLASSIFICATION — the typed-error vocabulary every
 * section raises and every reply is phrased from.
 *
 * Extracted verbatim from `background/background.js` section 3. Read
 * `background/parts/15-quota.js` first: it states the mechanism, the hoisting
 * rule, and why a part must not re-bind its own names on the worker side.
 *
 * WHY IT IS SAFE TO EXTRACT, in one sentence: every identifier this section
 * needs from the monolith is read at CALL time, never at load time.
 *
 *   `SunoApiError` is a lib global, published by `importScripts` above.
 *   `log` is a hoisted function declaration.
 *
 * Neither is touched while this file is being evaluated, so moving the bodies
 * cannot change when they resolve. Note `OpError` is a `class`, which is NOT
 * hoisted like a function — it sits in the temporal dead zone until this file
 * evaluates. That is safe for the same reason: the only consumer is
 * `new OpError(...)` inside other functions, long after load.
 *
 * Its five exports are read by 16 of the worker's 21 sections, which is exactly
 * why it must keep being hoisted globals on the monolith side. Do NOT add
 * `const { OpError } = SMUErrors` here or in the worker: in a classic worker that
 * is a SyntaxError, because this file's `class OpError` already owns the global
 * lexical scope a top-level `const` would claim.
 *
 * A NOTE ON `globalThis`, because it cost real confusion when this file was
 * first extracted. `function` declarations become PROPERTIES of the global
 * object; `class` and `const` declarations do not — they become bindings in the
 * global LEXICAL environment, which is shared across classic scripts but is not
 * reachable as a property. So after this file loads:
 *
 *     globalThis.describeError   -> function   (a function: it IS a property)
 *     globalThis.OpError         -> undefined  (a class: it is NOT)
 *     OpError                    -> function   (bare reference: works fine)
 *
 * The worker must therefore reference every export here as a BARE global. They
 * all work; only the `globalThis.` form is wrong, and only for the class. Do not
 * "fix" a future `globalThis.OpError` report — there is nothing to fix.
 */

/* ==========================================================================
 * 3. ERRORS, REDACTION, CLASSIFICATION
 * ======================================================================== */

/**
 * Redact bearer material and key material from arbitrary text before it can
 * reach a log, a notification, or a message payload.
 * @param {unknown} value
 * @returns {string}
 */
function redactText(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
  text = text.replace(/\beyJ[A-Za-z0-9._-]{8,}/g, '[redacted-jwt]');
  text = text.replace(/("(?:authorization|token|jwt|password|secret|content_key|user_key|glt)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
  return text.length > 600 ? text.slice(0, 600) + '…' : text;
}

/**
 * A failure shaped for a message reply: never carries a stack, never carries a
 * token, always carries a machine code the UI can branch on.
 */
class OpError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human text (redacted)
   * @param {object} [info] extra fields merged onto the reply
   */
  constructor(code, message, info) {
    super(redactText(message));
    this.name = 'OpError';
    this.code = code;
    this.info = info && typeof info === 'object' ? info : {};
  }

  /** @returns {{ok:false, error:string, code:string}} */
  toReply() {
    return { ok: false, error: this.message, code: this.code, ...this.info };
  }
}

/**
 * Normalise anything thrown into `{code, message, retryable, status}`.
 * @param {unknown} err
 * @returns {{code:string, message:string, retryable:boolean, status:number}}
 */
function describeError(err) {
  if (err instanceof OpError) {
    return { code: err.code, message: err.message, retryable: false, status: 0 };
  }
  if (err && typeof err === 'object') {
    const status = Number.isFinite(err.status) ? err.status : 0;
    let code = typeof err.code === 'string' && err.code ? err.code : 'unknown_error';
    if (SunoApiError && typeof SunoApiError.isAuthError === 'function' && SunoApiError.isAuthError(err)) {
      code = err.code === 'bad_token' ? 'bad_token' : 'unauthorized';
    } else if (SunoApiError && SunoApiError.isQuotaError && SunoApiError.isQuotaError(err)) {
      code = 'quota';
    } else if (SunoApiError && SunoApiError.isEntitlementError && SunoApiError.isEntitlementError(err)) {
      code = 'entitlement';
    } else if (SunoApiError && SunoApiError.isNotFound && SunoApiError.isNotFound(err)) {
      code = 'not_found';
    }
    return {
      code,
      message: redactText(err.message || String(err)),
      retryable: err.retryable === true || isTransientStatus(status),
      status,
    };
  }
  return { code: 'unknown_error', message: redactText(String(err)), retryable: false, status: 0 };
}

/**
 * Is this HTTP status worth retrying? 429 and 5xx and network faults are
 * transient. 401/403/404 and an explicit refusal body never are.
 * @param {number} status
 * @returns {boolean}
 */
function isTransientStatus(status) {
  if (!Number.isFinite(status) || status <= 0) return true; // network-level
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * Should this failure be retried by the batch driver? Deliberately narrow: a
 * 403 is an entitlement wall, a 404 will never appear, and a `{ok:false}`
 * refusal is a decision, not a glitch.
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryableFailure(err) {
  if (!err) return false;
  if (err.aborted === true) return false;
  if (err.name === 'AbortError') return false;
  if (SunoApiError && typeof SunoApiError.isAbortError === 'function' && SunoApiError.isAbortError(err)) {
    return false;
  }
  if (err.code === 'entitlement' || err.code === 'not_found' || err.code === 'bad_token') return false;
  if (err.code === 'unauthorized' || err.code === 'missing_token') return false;
  if (err.code === 'refused') return false;
  // An explicit `reason` is the server refusing on purpose, never a glitch.
  if (typeof err.reason === 'string' && err.reason) return false;
  // An EXPLICIT `retryable: false` is authoritative in both directions. Without
  // this, a ladder failure carrying `retryable:false` and no HTTP status fell
  // through to `isTransientStatus(0)`, which means "network fault" — and the
  // item would be retried forever.
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  return isTransientStatus(Number(err.status) || 0);
}

/**
 * Was this failure a cancellation rather than a fault? Aborts are control flow.
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortLike(err) {
  if (!err) return false;
  if (err.aborted === true) return true;
  if (err.name === 'AbortError') return true;
  if (err.code === 'aborted' || err.code === 'cancelled') return true;
  if (SunoApiError && typeof SunoApiError.isAbortError === 'function' && SunoApiError.isAbortError(err)) {
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------- *
 * Exports. Discovery and health-check only — see the header of
 * `background/parts/15-quota.js` for why the worker must call these as bare
 * globals rather than destructuring them here. `scripts/check-build.sh` asserts
 * that none of these names collides with a monolith declaration, which is the
 * one failure mode of this mechanism that produces no error at all.
 * ---------------------------------------------------------------- */
if (typeof globalThis !== 'undefined') {
  globalThis.SMUErrors = {
    redactText, OpError, describeError, isTransientStatus, isRetryableFailure, isAbortLike,
  };
}
