// content/content.js — Injects per-track download buttons on suno.com.
// Self-contained IIFE; sends download requests to the background script.

(function () {
  "use strict";

  const CLIP_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const BUTTON_CLASS = "sp-inline-dl-btn";
  const CONTAINER_CLASS = "sp-btn-host";

  function dbg(...args) {
    if (window.__SPPE_DEBUG) console.log("[sppe]", ...args);
  }

  function extractClipId(value) {
    if (!value) return null;
    const m = String(value).match(CLIP_ID);
    return m ? m[0].toLowerCase() : null;
  }

  const defaultSettings = {
    audioFormat: "m4a",
    enableInlineButtons: true
  };
  let currentSettings = { ...defaultSettings };

  function mergeSettings(value) {
    return { ...defaultSettings, ...(value || {}) };
  }

  function getSettingsSync() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["sppe_settings", "sppe_debug"], (obj) => {
        window.__SPPE_DEBUG = !!obj.sppe_debug;
        resolve(mergeSettings(obj.sppe_settings));
      });
    });
  }

  function findCardRoot(node) {
    let el = node;
    while (el && el !== document.body) {
      if (
        el.dataset?.testid &&
        /card|track|song|item|row|tile|media/.test(el.dataset.testid)
      )
        return el;
      el = el.parentElement;
    }
    return node.closest(
      "article, [data-testid], section, figure, [role='listitem'], [role='article']"
    );
  }

  function findClipIdFromNode(node) {
    if (node.href) {
      const id = extractClipId(node.href);
      if (id) return id;
    }
    const data = node.dataset || {};
    for (const key of Object.keys(data)) {
      const id = extractClipId(data[key]);
      if (id) return id;
    }
    for (const attr of node.attributes || []) {
      const id = extractClipId(attr.value);
      if (id) return id;
    }
    return null;
  }

  function ensureHost(card) {
    if (card.querySelector("." + CONTAINER_CLASS)) return null;
    const host = document.createElement("span");
    host.className = CONTAINER_CLASS;
    host.style.cssText =
      "position:absolute;top:6px;right:6px;z-index:9999;display:flex;gap:4px;";
    card.style.setProperty("position", /static|relative/.test(getComputedStyle(card).position) ? "relative" : getComputedStyle(card).position);
    card.appendChild(host);
    return host;
  }

  function isAllowedApiUrl(value) {
    try {
      const url = new URL(value);
      const allowedOrigin = url.origin === "https://studio-api-prod.suno.com" || url.origin === "https://studio-api.prod.suno.com";
      return url.protocol === "https:" && allowedOrigin && url.pathname.startsWith("/api/");
    } catch (_) {
      return false;
    }
  }

  function isOwnButton(node) {
    return node && (node.classList?.contains(BUTTON_CLASS) || node.classList?.contains(CONTAINER_CLASS));
  }

  function buttonForClip(clipId, settings) {
    const btn = document.createElement("button");
    btn.className = BUTTON_CLASS;
    btn.dataset.clipId = clipId;
    btn.title = "Download with Suno Power Exporter";
    btn.textContent = "↓";
    btn.style.cssText =
      "width:22px;height:22px;border-radius:4px;border:1px solid #333;background:#222;color:#fff;font-size:12px;line-height:1;cursor:pointer;";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      dbg("inline download", clipId);
      requestDownload(clipId, currentSettings);
    });
    return btn;
  }

  function requestDownload(clipId, settings) {
    chrome.runtime.sendMessage({
      action: "downloadTrack",
      clip: { id: clipId },
      format: settings.audioFormat || "m4a"
    });
  }

  function scanAndInject(settings) {
    if (!settings.enableInlineButtons) {
      document.querySelectorAll("." + BUTTON_CLASS).forEach((b) => b.remove());
      document.querySelectorAll("." + CONTAINER_CLASS).forEach((h) => h.remove());
      return;
    }
    const candidates = document.querySelectorAll(
      "a[href*='/song/'], a[href*='/clip/'], [data-clip-id], [data-content-id], [data-testid], [data-id], [data-track-id]"
    );
    dbg("scan candidates", candidates.length);
    let injected = 0;
    candidates.forEach((node) => {
      const id = findClipIdFromNode(node);
      if (!id) return;
      const card = findCardRoot(node);
      if (!card) return;
      if (card.querySelector("." + BUTTON_CLASS + '[data-clip-id="' + id + '"]')) return;
      const host = ensureHost(card);
      if (host) {
        const btn = buttonForClip(id, settings);
        const existing = host.querySelector("." + BUTTON_CLASS);
        if (!existing) {
          host.appendChild(btn);
          injected++;
        }
      }
    });
    dbg("injected buttons", injected);
  }

  function init() {
    getSettingsSync().then((settings) => {
      currentSettings = settings;
      scanAndInject(currentSettings);
      let scanTimer = null;
      const observer = new MutationObserver(() => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => scanAndInject(currentSettings), 120);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.sppe_settings) {
          currentSettings = mergeSettings(changes.sppe_settings.newValue);
          scanAndInject(currentSettings);
        }
        if (changes.sppe_debug) window.__SPPE_DEBUG = !!changes.sppe_debug.newValue;
      });

      // Page-context authenticated fetch proxy (carries suno.com session cookies).
      chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
        if (msg.action === "proxyFetch") {
          const { url, method = "GET", headers = {}, body = null } = msg.payload || {};
          if (!["GET", "POST"].includes(method) || !isAllowedApiUrl(url)) {
            respond({ __error: "Blocked proxy destination", __status: 0 });
            return null;
          }
      fetch(url, { method, headers, body, credentials: "include" })
        .then(async (r) => {
          const text = await r.clone().text();
          dbg("proxyFetch reply", url, r.status, text.length);
          respond({ __status: r.status, __headers: Object.fromEntries(r.headers), __body: text });
          return null;
        })
            .catch((err) => {
              respond({ __error: err.message, __status: 0 });
              return null;
            });
          return true;
        }
        return false;
      });
    });
  }

  function addFloatingDock(settings) {
    if (document.getElementById("sp-floating-dock")) return;
    const dock = document.createElement("div");
    dock.id = "sp-floating-dock";
    dock.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:2147483000;background:#14141c;border:1px solid #2a2a36;border-radius:10px;padding:8px 10px;display:flex;gap:6px;align-items:center;font-size:12px;color:#e4e4e7;box-shadow:0 4px 20px rgba(0,0,0,.5)";
    dock.innerHTML =
      '<button id="sp-open-controls" style="background:#a78bfa;color:#0d0221;border:none;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;">Exporter</button>';
    document.body.appendChild(dock);
    dock.querySelector("#sp-open-controls").addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openControls", query: "" });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      getSettingsSync().then((s) => {
        addFloatingDock(s);
        init();
      });
    });
  } else {
    getSettingsSync().then((s) => {
      addFloatingDock(s);
      init();
    });
  }
})();
