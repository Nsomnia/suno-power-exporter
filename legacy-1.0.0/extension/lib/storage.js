// lib/storage.js — Persistent extension settings (Chrome storage.local)
// Shared between background, content, and controls pages.

export const STORAGE_KEY = "sppe_settings";

export const DEFAULTS = Object.freeze({
  audioFormat: "m4a",
  includeUploads: true,
  ignoreDisliked: false,
  includeLyrics: true,
  embedArtwork: true,
  includeMetadataSidecar: false,
  filenameTemplate: "{title} - {artist} [{id}]",
  shortId: false,
  detectBpm: false,
  concurrency: 2,
  rateLimitMs: 900,
  enableInlineButtons: true,
  downloadMode: "directory",
  settingsVersion: 3,
  lastFilters: {}
});

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const legacy = await chrome.storage.local.get(["includeShortUuid", "includeWorkspaceName", "rateLimitConfig"]);
  const current = stored[STORAGE_KEY] || {};
  const next = Object.assign({}, DEFAULTS, current);
  if (!Object.prototype.hasOwnProperty.call(current, "shortId") && typeof legacy.includeShortUuid === "boolean") next.shortId = legacy.includeShortUuid;
  if (!Object.prototype.hasOwnProperty.call(current, "rateLimitMs") && legacy.rateLimitConfig?.delayMs != null) next.rateLimitMs = legacy.rateLimitConfig.delayMs;
  if (legacy.includeShortUuid != null || legacy.rateLimitConfig != null) {
    await chrome.storage.local.remove?.(["includeShortUuid", "includeWorkspaceName", "rateLimitConfig"]);
  }
  if (Number(next.settingsVersion) < 3) next.ignoreDisliked = false;
  next.settingsVersion = 3;
  return next;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = Object.assign({}, current, patch);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function getSetting(key) {
  const settings = await getSettings();
  return settings[key];
}

export async function setSetting(key, value) {
  return saveSettings({ [key]: value });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  const next = Object.assign({}, DEFAULTS, changes[STORAGE_KEY].newValue || {});
  if (typeof window !== "undefined") {
    dispatchEvent(new CustomEvent("sppe:settings", { detail: next }));
  }
});

export function onSettingsChanged(callback) {
  const handler = (e) => callback(e.detail);
  window.addEventListener("sppe:settings", handler);
  return () => window.removeEventListener("sppe:settings", handler);
}
