// background.js — MV3 service worker: auth capture, window routing, message hub.
import { getSettings } from "./lib/storage.js";
import { dbg } from "./lib/debug.js";

chrome.action.onClicked.addListener(() => {
  dbg("action clicked -> open controls");
  openControls("");
});

let controlsWindowId = null;
let controlsTabId = null;
const CONTROLS_QUEUE_KEY = "__sppe_controls_queue";
let controlsQueueWrite = Promise.resolve();

(async () => {
  const data = await chrome.storage.local.get(["__sppe_controls_win", "__sppe_controls_tab"]);
  controlsWindowId = data.__sppe_controls_win || null;
  controlsTabId = data.__sppe_controls_tab || null;
})();

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const auth = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === "authorization"
    );
    if (auth && auth.value && auth.value.startsWith("Bearer ")) {
      chrome.storage.local.set({ __sppe_token: auth.value, __sppe_token_ts: Date.now() });
      dbg("auth captured from", new URL(details.url).pathname);
    }
    return { requestHeaders: details.requestHeaders };
  },
  { urls: ["https://studio-api-prod.suno.com/*", "https://studio-api.prod.suno.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  dbg("bg message", msg.action);
  const reply = (value) => {
    try { respond(value); } catch (_) {}
  };

  switch (msg.action) {
    case "getSettings":
      getSettings().then(reply);
      return true;

    case "saveSettings":
      getSettings().then((current) => {
        const next = Object.assign({}, current, msg.patch || {});
        chrome.storage.local.set({ sppe_settings: next }, () => reply(next));
      });
      return true;

    case "openControls":
      openControls(msg.query || "").then(() => reply({ ok: true }));
      return true;

    case "downloadTrack":
      handleDownloadTrack(msg).then((res) => reply(res));
      return true;

    case "downloadBatch":
      handleBatch(msg).then((res) => reply(res));
      return true;

    case "notify":
      if (controlsTabId != null) {
        dispatchControlsMessage(msg.payload || {}).catch(() => {});
      }
      reply({ ok: true });
      break;

    case "proxyFetch":
      proxyFetch(msg.payload).then(reply);
      return true;

    default:
      reply({ error: "unknown action" });
  }
});

async function getControlsClient() {
  if (controlsTabId != null) {
    try {
      const tab = await chrome.tabs.get(controlsTabId);
      const controlsUrl = chrome.runtime.getURL("controls/controls.html");
      if (!tab || !tab.windowId || !String(tab.url || "").startsWith(controlsUrl)) throw new Error("controls tab gone");
      controlsWindowId = tab.windowId;
      return { windowId: tab.windowId, tabId: tab.id };
    } catch (_) {
      controlsTabId = null;
      controlsWindowId = null;
    }
  }
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      for (const t of w.tabs || []) {
        if (t.url && t.url.includes(chrome.runtime.getURL("controls/controls.html"))) {
          controlsTabId = t.id;
          controlsWindowId = w.id;
          return { windowId: w.id, tabId: t.id };
        }
      }
    }
  } catch (_) {}
  return null;
}

async function openControls(query) {
  const existing = await getControlsClient();
  const url = chrome.runtime.getURL("controls/controls.html") + query;
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    if (query) await chrome.tabs.update(existing.tabId, { url, active: true });
    return;
  }
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 1320,
    height: 860,
    focused: true
  });
  controlsWindowId = win?.id || null;
  const tabs = controlsWindowId ? await chrome.tabs.query({ windowId: controlsWindowId }) : [];
  controlsTabId = tabs[0]?.id || null;
  await chrome.storage.local.set({ __sppe_controls_win: controlsWindowId, __sppe_controls_tab: controlsTabId });
}

function enqueueControlsMessage(message) {
  const operation = controlsQueueWrite.then(async () => {
    const id = crypto.randomUUID();
    const key = `${CONTROLS_QUEUE_KEY}:${id}`;
    const stored = await chrome.storage.local.get(null);
    const existing = Object.entries(stored)
      .filter(([candidate]) => candidate.startsWith(`${CONTROLS_QUEUE_KEY}:`))
      .map(([candidate, value]) => ({ key: candidate, queuedAt: Number(value?.queuedAt) || 0 }))
      .sort((a, b) => a.queuedAt - b.queuedAt);
    const cutoff = Date.now() - 86400000;
    const expired = existing.filter((item) => item.queuedAt < cutoff).map((item) => item.key);
    const overflow = existing.slice(0, Math.max(0, existing.length - 19)).map((item) => item.key);
    const remove = [...new Set([...expired, ...overflow])];
    if (remove.length) await chrome.storage.local.remove(remove);
    await chrome.storage.local.set({
      [key]: { ...message, queuedAt: Date.now(), queueId: id }
    });
  });
  controlsQueueWrite = operation.catch(() => {});
  return operation;
}

async function dispatchControlsMessage(message) {
  try {
    await chrome.runtime.sendMessage({ ...message, target: "controls" });
    return true;
  } catch (_) {
    await enqueueControlsMessage(message);
    return false;
  }
}

async function handleDownloadTrack(msg) {
  const existing = await getControlsClient();
  if (existing) {
    await dispatchControlsMessage({ action: "downloadTrack", clip: msg.clip, format: msg.format });
    return { routed: true };
  }
  const q = new URLSearchParams({ dl: msg.clip?.id || "", fmt: msg.format || "" }).toString();
  await openControls("?" + q);
  return { opened: true };
}

function isAllowedProxyUrl(value) {
  try {
    const url = new URL(value);
    const allowedOrigin = url.origin === "https://studio-api-prod.suno.com" || url.origin === "https://studio-api.prod.suno.com";
    return url.protocol === "https:" && allowedOrigin && url.pathname.startsWith("/api/");
  } catch (_) {
    return false;
  }
}

async function proxyFetch(payload) {
  if (!payload || !["GET", "POST"].includes(payload.method || "GET") || !isAllowedProxyUrl(payload.url)) {
    return { __error: "Blocked proxy destination", __status: 0 };
  }
  const allowedHeaders = new Set(["accept", "content-type", "authorization", "device-id", "browser-token"]);
  const safeHeaders = Object.fromEntries(Object.entries(payload.headers || {}).filter(([key]) => allowedHeaders.has(key.toLowerCase())));
  const safePayload = { ...payload, headers: safeHeaders };
  dbg("proxyFetch", payload.url, payload.method);
  try {
    const tabs = await chrome.tabs.query({
      url: [
        "https://suno.com/*",
        "https://*.suno.com/*"
      ]
    });
    const tab = tabs.find((candidate) => {
      try { return new URL(candidate.url).origin === "https://suno.com"; } catch (_) { return false; }
    }) || tabs[tabs.length - 1] || null;
    if (!tab) {
      return { __error: "Open suno.com in a tab and retry", __status: 0 };
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "proxyFetch",
      payload: safePayload
    }, { frameId: 0 });
    dbg("proxyFetch response", payload.url, response ? response.__status : null);
    return response || { __error: "No response from content script", __status: 0 };
  } catch (err) {
    return { __error: err.message, __status: 0 };
  }
}

async function handleBatch(msg) {
  const existing = await getControlsClient();
  if (existing) {
    await dispatchControlsMessage({ action: "downloadBatch", clips: msg.clips, filters: msg.filters });
    return { routed: true };
  }
  await enqueueControlsMessage({ action: "downloadBatch", clips: msg.clips, filters: msg.filters });
  await openControls("?batch=1");
  return { opened: true };
}

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === controlsWindowId) {
    controlsWindowId = null;
    controlsTabId = null;
    chrome.storage.local.set({ __sppe_controls_win: null, __sppe_controls_tab: null });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === controlsTabId) {
    controlsTabId = null;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  getSettings().then((settings) => chrome.storage.local.set({ sppe_settings: settings }));
});

chrome.runtime.onStartup.addListener(() => {
  controlsWindowId = null;
  controlsTabId = null;
});
