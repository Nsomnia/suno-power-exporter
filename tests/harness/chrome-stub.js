'use strict';

/**
 * A fake `chrome` global.
 *
 * THE NAMESPACES background.js touches at LOAD time — every one of these has to
 * exist before `vm.runInContext(background.js)` or evaluation throws:
 *
 *   runtime.onMessage / onStartup / onInstalled    addListener at
 *                                                  background.js:11131, :11151, :11061
 *   alarms.onAlarm.addListener                      background.js:11166
 *   downloads.onChanged.addListener                background.js:10862  <-- the
 *                                                  one that bites first if
 *                                                  `downloads` is a bare object
 *
 * THE NAMESPACES it touches at RUN time (measured from background.js):
 *   storage.local (get/set), storage.session (get/set/remove) — the session
 *   record at `STORAGE_KEYS.SESSION_SYNC_RUN` (background.js:294) is the
 *   eviction-reconciliation state, so it MUST outlive a worker here exactly as
 *   `storage.session` outlives one in Chrome;
 *   alarms create/clear/get — `armKeepalive`, `armQuotaAlarm`, `armSyncAlarm`,
 *   `armSyncRunKeepalive` (background.js:10672-10769);
 *   runtime.getManifest, getURL, sendMessage, MessageSender;
 *   downloads.*, tabs.*, offscreen.*, scripting.*, notifications.*, sidePanel.*
 *
 * `runtime.MessageSender` appears 9 times in background.js and is TYPE ANNOTATION
 * ONLY — it is read as a constructor in JSDoc `@param {chrome.runtime.MessageSender}`
 * types, never called. It is exported here anyway so nothing can trip on it.
 *
 * THE VIRTUAL CLOCK IS THE POINT OF THIS FILE. `KEEPALIVE_PERIOD_MINUTES` is
 * 0.5 (background.js:337), so the crawl's keepalive alarm is a 30 s tick, and
 * the whole reported failure is "the extension worker was stopped mid-crawl (no
 * page for 93s)". A test that has to wait 30 real seconds per alarm cannot prove
 * anything, so alarms here are driven by an in-memory clock the test advances by
 * hand. Note that this makes the alarms deterministic; it does NOT make the
 * worker's own `setTimeout`s deterministic, so anything on a real timer is
 * driven by awaiting, not by the clock.
 */

const NOOP_PROMISE = () => Promise.resolve(undefined);

class ChromeStub {
  /**
   * @param {object} [opts]
   * @param {number} [opts.startTime=1700000000000] the virtual clock's origin
   * @param {object} [opts.manifest] a `chrome.runtime.getManifest()` result
   * @param {boolean} [opts.autoStorageAccessLog=false] record every
   *   `storage.*` read, so a test can assert what the resumed worker looked for
   */
  constructor(opts = {}) {
    const o = opts || {};
    this._clock = typeof o.startTime === 'number' ? o.startTime : 1700000000000;

    /** Shared storage areas. Held by the TEST, handed to each worker — they
     *  outlive an evicted worker exactly as `chrome.storage.*` does in Chrome. */
    this.storageData = {
      local: o.local ? { ...o.local } : {},
      session: o.session ? { ...o.session } : {},
    };
    this.storageAccessLog = [];

    /** name -> alarm record */
    this.alarms = new Map();
    /** name -> time it fires at (single-shot) or null (periodic) */
    this._alarmSeq = 0;

    /** Every `runtime.sendMessage` / broadcast the worker made. */
    this.broadcasts = [];
    /** Every `console.*` line the worker wrote, for bootstrap diagnostics. */
    this.consoleLines = [];
    /** Every `chrome.runtime.onMessage` payload dispatched, for assertions. */
    this.inbound = [];

    this.manifest = o.manifest || {
      manifest_version: 3,
      name: 'Suno Master Utility',
      version: '0.0.0-test',
    };

    this.chrome = this._build();
  }

  /** The virtual clock's current value, epoch ms. */
  now() {
    return this._clock;
  }

  /* ================================================================== *
   * The virtual clock
   * ================================================================== */

  /**
   * Move the clock forward and fire every alarm whose time has come.
   *
   * Deterministic by construction: alarms are held in a Map keyed by name and
   * sorted by due time, so two alarms due at the same instant fire in a stable
   * order and a periodic alarm re-arms itself the correct number of times for
   * the interval that elapsed — including zero times for a short advance.
   *
   * @param {number} ms
   * @returns {Promise<Array<string>>} the alarm names that fired
   */
  async advanceTime(ms) {
    const delta = Number(ms);
    if (!Number.isFinite(delta) || delta < 0) throw new Error('advanceTime needs a non-negative ms');
    const target = this._clock + delta;

    const fired = [];
    for (;;) {
      let next = null;
      for (const [name, alarm] of this.alarms) {
        const due = nextDue(alarm, this._clock);
        if (due === null || due > target) continue;
        if (next === null || due < next.due || (due === next.due && name < next.name)) {
          next = { name, alarm, due };
        }
      }
      if (next === null) break;

      // Land exactly on the alarm so `scheduledTime` is honest.
      this._clock = next.due;
      if (next.alarm.periodInMinutes !== undefined) {
        const period = Math.max(1, Math.round(next.alarm.periodInMinutes * 60000));
        next.alarm.scheduledTime = next.alarm.scheduledTime + period;
        // A periodic alarm whose period is longer than the advance never
        // re-arms inside this loop, which is correct, not a hang.
      } else {
        this.alarms.delete(next.name);
      }
      const event = {
        name: next.name,
        scheduledTime: next.due,
        periodInMinutes: next.alarm.periodInMinutes,
      };
      fired.push(next.name);
      await this._fire('alarms.onAlarm', event);
    }

    this._clock = target;
    return fired;
  }

  /**
   * Fire one alarm immediately, as if its schedule had arrived.
   * @param {string} name
   */
  async fireAlarm(name) {
    const alarm = this.alarms.get(name) || { name, scheduledTime: this._clock };
    const event = { name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes };
    await this._fire('alarms.onAlarm', event);
    return event;
  }

  /** @returns {object|null} the named alarm, if armed */
  getAlarm(name) {
    const a = this.alarms.get(name);
    return a ? { ...a } : null;
  }

  /** @returns {string[]} every armed alarm name */
  armedAlarms() {
    return [...this.alarms.keys()].sort();
  }

  async _fire(path, payload) {
    let cur = this.chrome;
    for (const seg of path.split('.')) cur = cur && cur[seg];
    if (cur && Array.isArray(cur._listeners)) {
      for (const fn of cur._listeners.slice()) {
        try {
          await fn(payload);
        } catch (err) {
          this.lastListenerError = err;
        }
      }
    }
  }

  /* ================================================================== *
   * the chrome object
   * ================================================================== */

  _build() {
    const self = this;

    return {
      runtime: {
        id: 'suno-master-utility-test',
        lastError: null,
        getManifest: () => deepClone(self.manifest),
        getURL: (p) => 'chrome-extension://suno-test/' + String(p).replace(/^\//, ''),
        /** Broadcasts are RECORDED, not delivered. Tests read `stub.broadcasts`
         *  to observe SYNC_STARTED / SYNC_PROGRESS / SYNC_DONE / SYNC_ERROR. */
        sendMessage: async (message, cb) => {
          self.broadcasts.push({ at: self.now(), message: deepClone(message) });
          if (typeof cb === 'function') cb();
          return undefined;
        },
        onMessage: event(),
        onStartup: event(),
        onInstalled: event(),
        onConnect: event(),
        onSuspend: event(),
        /* TYPE ANNOTATION ONLY in background.js (JSDoc), never called. */
        MessageSender: class MessageSender {},
        getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64', nacl_arch: 'x86-64' }),
      },

      storage: {
        local: makeArea(self, 'local'),
        session: makeArea(self, 'session'),
        onChanged: event(),
      },

      alarms: {
        /**
         * background.js:10761 / :10711 / :10729. `when`/`delayInMinutes`/
         * `periodInMinutes` are all honoured on the virtual clock.
         */
        create: async (name, info) => {
          const i = info || {};
          let when = self._clock;
          if (typeof i.when === 'number') when = i.when;
          else if (typeof i.delayInMinutes === 'number') when = self._clock + i.delayInMinutes * 60000;
          const alarm = {
            name: String(name),
            scheduledTime: when,
            periodInMinutes: typeof i.periodInMinutes === 'number' ? i.periodInMinutes : undefined,
            _seq: self._alarmSeq++,
          };
          self.alarms.set(String(name), alarm);
          return alarm;
        },
        clear: async (name) => self.alarms.delete(String(name)),
        clearAll: async () => {
          const n = self.alarms.size;
          self.alarms.clear();
          return n > 0;
        },
        get: async (name) => {
          const a = self.alarms.get(String(name));
          return a ? { ...a } : undefined;
        },
        getAll: async () => [...self.alarms.values()].map((a) => ({ ...a })),
        onAlarm: event(),
      },

      /* --- namespaces the crawl never reaches, kept recording-only --------- */

      downloads: {
        onChanged: event(),
        onCreated: event(),
        download: async (opts) => {
          self.broadcasts.push({ at: self.now(), message: { type: '__download', options: deepClone(opts) } });
          return ++self._alarmSeq;
        },
        cancel: async () => {},
        search: async () => [],
        erase: async () => ({ erased: [] }),
        show: async () => {},
      },

      tabs: {
        query: async () => [],
        get: async () => null,
        sendMessage: async () => {},
        create: async () => ({ id: ++self._alarmSeq }),
        remove: async () => {},
        onUpdated: event(),
        onRemoved: event(),
        onActivated: event(),
      },

      offscreen: {
        createDocument: NOOP_PROMISE,
        closeDocument: NOOP_PROMISE,
        hasDocument: async () => false,
      },

      scripting: {
        executeScript: async () => [],
        insertCSS: NOOP_PROMISE,
        removeCSS: NOOP_PROMISE,
      },

      notifications: {
        create: async (opts) => {
          self.broadcasts.push({ at: self.now(), message: { type: '__notification', options: deepClone(opts) } });
          return 'n' + (++self._alarmSeq);
        },
        clear: NOOP_PROMISE,
        onClicked: event(),
      },

      sidePanel: {
        setPanelBehavior: async (opts) => {
          self.panelBehavior = opts;
        },
        open: NOOP_PROMISE,
        setOptions: NOOP_PROMISE,
      },

      action: {
        setBadgeText: NOOP_PROMISE,
        setBadgeBackgroundColor: NOOP_PROMISE,
        setTitle: NOOP_PROMISE,
        setIcon: NOOP_PROMISE,
        onClicked: event(),
      },

      windows: {
        getAll: async () => [],
        getCurrent: async () => ({ id: 1, focused: true }),
        onFocusChanged: event(),
        onRemoved: event(),
      },

      idle: {
        onStateChanged: event(),
        queryState: async () => 'active',
      },

      permissions: {
        contains: async () => true,
        request: async () => true,
      },

      i18n: {
        getMessage: (key) => key,
        getUILanguage: () => 'en',
      },
    };
  }

  /**
   * The sender a real extension page would present.
   *
   * NOT OPTIONAL. `validateSender` (`background/parts/06-messaging.js:82-91`)
   * gates EVERY route and requires BOTH halves: `sender.id` must equal
   * `chrome.runtime.id`, AND `sender.url` must match one of
   * `TRUSTED_PAGE_PATTERNS` (background.js:523-528) —
   *
   *     /^chrome-extension:\/\//
   *     /^https:\/\/suno\.com\//
   *     /^https:\/\/[a-z0-9-]+\.suno\.com\//i
   *     /^https:\/\/[a-z0-9-]+\.suno\.ai\//i
   *
   * A sender with no `url` is rejected with `'sender has no url'` and the route
   * replies `{ok:false, code:'forbidden'}`. That failure is completely silent
   * from the outside — the harness would just see a crawl that never started —
   * so this default exists rather than leaving it to each test.
   */
  defaultSender() {
    return { id: this.chrome.runtime.id, url: 'chrome-extension://suno-test/popup.html' };
  }

  /**
   * Dispatch a `chrome.runtime.onMessage` payload to the worker's router, the
   * way Chrome would from an extension page.
   *
   * THE MV3 REPLY SHAPE, and why this is not a one-liner:
   * `onRuntimeMessage` (background.js:10594) does NOT return the reply. It
   * returns `true` to keep the response channel open (background.js:10645-10649)
   * and calls `sendResponse(reply)` from a `.then()` after the bootstrap gate
   * (background.js:10622-10644). So the correct behaviour is:
   *
   *   listener returns `undefined` and never calls sendResponse -> resolved
   *       `undefined` (the documented way to decline, background.js:10597)
   *   listener returns `true` -> WAIT for sendResponse, up to `timeoutMs`
   *   listener returns anything else -> that IS the reply (the pre-MV3 shape)
   *
   * @param {object} message
   * @param {object} [sender]
   * @param {number} [timeoutMs=20000]
   * @returns {Promise<*>} the router's reply
   */
  async dispatchMessage(message, sender, timeoutMs = 20000) {
    this.inbound.push({ at: this.now(), message: deepClone(message) });
    const listeners = this.chrome.runtime.onMessage._listeners;
    if (!listeners.length) return undefined;
    const from = sender || this.defaultSender();

    for (const fn of listeners) {
      let response;
      let responded = false;
      const sendResponse = (value) => {
        responded = true;
        response = value;
      };
      const ret = fn(deepClone(message), from, sendResponse);

      if (responded) return response;
      if (ret === true) {
        // Channel kept open: the reply arrives on a later turn.
        await waitFor(() => responded, timeoutMs, `sendResponse for ${message && message.type}`);
        return response;
      }
      if (ret && typeof ret.then === 'function') return await ret;
      if (ret !== undefined && ret !== false) return ret;
      return undefined;
    }
    return undefined;
  }

  /** Simulate the browser starting up with a fresh worker already loaded. */
  async dispatchStartup() {
    await this._fire('runtime.onStartup', {});
  }

  /** Simulate install / update. */
  async dispatchInstalled(details) {
    await this._fire('runtime.onInstalled', details || { reason: 'install' });
  }

  /** Broadcasts of one type, in order. */
  broadcastsOfType(type) {
    return this.broadcasts.filter((b) => b.message && b.message.type === type).map((b) => b.message);
  }

  /** The LAST broadcast of a type, or `null`. */
  lastBroadcast(type) {
    const list = this.broadcastsOfType(type);
    return list.length ? list[list.length - 1] : null;
  }
}

/* ======================================================================== *
 * helpers
 * ======================================================================== */

/** A `chrome.events.Event` shape: `addListener` and friends. */
function event() {
  return {
    _listeners: [],
    addListener(fn) {
      if (typeof fn === 'function') this._listeners.push(fn);
    },
    removeListener(fn) {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    },
    hasListener(fn) {
      return typeof fn === 'function' ? this._listeners.indexOf(fn) >= 0 : this._listeners.length > 0;
    },
    hasListeners() {
      return this._listeners.length > 0;
    },
  };
}

/**
 * A `chrome.storage.Area`. NOTE THE OWNERSHIP: `stub.storageData[which]` is
 * created once in the constructor and read BY REFERENCE, so the data outlives
 * whatever worker is using it — which is what `chrome.storage.session` does in
 * Chrome, and what the eviction tests rely on.
 */
function makeArea(stub, which) {
  const data = stub.storageData[which];
  const log = stub.storageAccessLog;
  return {
    async get(keys) {
      log.push({ at: stub._clock, area: which, op: 'get', keys: deepClone(keys) });
      if (keys === null || keys === undefined) return deepClone(data);
      const out = {};
      if (typeof keys === 'string') {
        if (Object.prototype.hasOwnProperty.call(data, keys)) out[keys] = deepClone(data[keys]);
        return out;
      }
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = deepClone(data[k]);
        }
        return out;
      }
      if (typeof keys === 'object') {
        for (const k of Object.keys(keys)) {
          out[k] = Object.prototype.hasOwnProperty.call(data, k) ? deepClone(data[k]) : keys[k];
        }
        return out;
      }
      return out;
    },
    async set(items) {
      log.push({ at: stub._clock, area: which, op: 'set', keys: Object.keys(items || {}) });
      for (const k of Object.keys(items || {})) data[k] = deepClone(items[k]);
    },
    async remove(keys) {
      log.push({ at: stub._clock, area: which, op: 'remove', keys: deepClone(keys) });
      for (const k of toArray(keys)) delete data[k];
    },
    async clear() {
      log.push({ at: stub._clock, area: which, op: 'clear' });
      for (const k of Object.keys(data)) delete data[k];
    },
    async getBytesInUse(keys) {
      const json = JSON.stringify(deepClone(data));
      return json.length + toArray(keys).length;
    },
    QUOTA_BYTES: 10485760,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    setAccessLevel: async () => {},
  };
}

function toArray(keys) {
  if (keys === null || keys === undefined) return [];
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  return [keys];
}

function nextDue(alarm, now) {
  if (alarm.scheduledTime > now) return alarm.scheduledTime;
  // A periodic alarm whose period has already elapsed at `now` fires NOW, once,
  // and re-arms — the loop in advanceTime then schedules it again if the
  // remaining advance still covers its next period.
  if (alarm.periodInMinutes !== undefined) return now;
  return null;
}

/**
 * Poll `pred` until it is true, or fail loudly.
 *
 * A timeout here is a HARNESS failure, not a product failure: it means the
 * worker never answered a message at all (a router that declined, or a handler
 * that hung). Failing loudly is the whole point — a silent `undefined` reply
 * would make every downstream assertion read as "the crawl produced no verdict",
 * which is the exact shape of bug this harness exists to detect.
 */
async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() > deadline) {
      throw new Error('chrome-stub: timed out after ' + timeoutMs + 'ms waiting for ' + what);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return value;
  }
}

module.exports = { ChromeStub };