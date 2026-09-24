// lib/debug.js — Lightweight debug logger for browser consoles during development.
// Toggle at runtime via chrome.storage.local { sppe_debug: boolean }.

const DEBUG_KEY = "sppe_debug";
export let DEBUG = false;

async function refreshFlag() {
  try {
    const s = await chrome.storage.local.get(DEBUG_KEY);
    DEBUG = s[DEBUG_KEY] !== undefined ? !!s[DEBUG_KEY] : false;
  } catch (_) {
    DEBUG = false;
  }
}

try {
  refreshFlag();
} catch (_) {}

export function dbg(...args) {
  if (DEBUG) console.log("[sppe]", ...args);
}

export async function setDebug(enabled) {
  await chrome.storage.local.set({ [DEBUG_KEY]: !!enabled });
  DEBUG = !!enabled;
  dbg("debug set to", DEBUG);
  return DEBUG;
}

// Re-read the toggle whenever storage changes (covers controls/background/content).
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[DEBUG_KEY]) {
      DEBUG = changes[DEBUG_KEY].newValue !== undefined ? !!changes[DEBUG_KEY].newValue : true;
      dbg("debug flag changed to", DEBUG);
    }
  });
}
