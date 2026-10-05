// lib/utils.js — Shared pure helpers used across background, content, and controls.

export const API_BASE = "https://studio-api-prod.suno.com";
export const MANGO_CDN = "https://d2lwuy8qc234o3.cloudfront.net";

export function isSunoApiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.origin === "https://studio-api-prod.suno.com" || url.origin === "https://studio-api.prod.suno.com") && url.pathname.startsWith("/api/");
  } catch (_) {
    return false;
  }
}

export const CLIP_ID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function extractClipId(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const match = value.match(CLIP_ID_REGEX);
    if (match) return match[0].toLowerCase();
    return null;
  }
  return null;
}

export function generateDeviceId() {
  return crypto.randomUUID();
}

export async function getDeviceId() {
  const stored = await chrome.storage.local.get(["__sppe_device_id", "deviceId"]);
  const existing = stored.__sppe_device_id || stored.deviceId;
  if (existing) {
    if (!stored.__sppe_device_id) await chrome.storage.local.set({ __sppe_device_id: existing });
    return existing;
  }
  const id = generateDeviceId();
  await chrome.storage.local.set({ __sppe_device_id: id });
  return id;
}

export function generateBrowserToken() {
  const token = btoa(JSON.stringify({ timestamp: Date.now() }));
  return JSON.stringify({ token });
}

export async function getAuthToken() {
  const stored = await chrome.storage.local.get(["__sppe_token", "__sppe_token_ts", "authToken"]);
  const token = stored.__sppe_token || stored.authToken || null;
  if (!token) return null;
  return /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
}

export function buildAuthHeaders(token, extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    Origin: "https://suno.com",
    Referer: "https://suno.com/"
  };
  if (token) headers.Authorization = token;
  if (extra.deviceId) headers["device-id"] = extra.deviceId;
  if (extra.browserToken) headers["browser-token"] = extra.browserToken;
  return Object.assign({}, headers, extra);
}

export function sanitize(value, max = 120) {
  if (value == null) return "";
  return String(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.+/g, ".")
    .trim()
    .slice(0, max);
}

export function interpolateTemplate(template, data) {
  return template
    .replace(/\{title\}/g, sanitize(data.title))
    .replace(/\{artist\}/g, sanitize(data.artist))
    .replace(/\{album\}/g, sanitize(data.album))
    .replace(/\{id\}/g, data.id || "")
    .replace(/\{shortid\}/g, data.id ? data.id.slice(0, 8) : "")
    .replace(/\{workspace\}/g, sanitize(data.workspace || ""))
    .replace(/\{model\}/g, sanitize(data.model))
    .replace(/\{ext\}/g, data.ext || "m4a");
}

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[i]}`;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryAsync(fn, { retries = 3, backoff = 1000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt++ >= retries) throw err;
      await delay(Math.min(backoff * Math.pow(2, attempt - 1), 15000));
    }
  }
}

export function safeJson(response) {
  if (!response) return null;
  const contentType = response.headers?.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return response.json().catch(() => null);
}
