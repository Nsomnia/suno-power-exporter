// controls/controls.js — Advanced controls window: library, directory, settings, activity.
import { DEFAULTS, getSettings, saveSettings } from "../lib/storage.js";
import { fetchWorkspaces, normalizeClip } from "../lib/engine.js";
import { fetchLibraryDetailed, probeFeedConnection, fetchClipMetadata } from "../lib/api.js";
import { dbg, setDebug } from "../lib/debug.js";
import {
  pickDirectory,
  getStoredDirHandle,
  clearStoredDirHandle,
  dirLabel,
  scanExistingIds
} from "../lib/directory.js";
import {
  downloadTrack,
  downloadBatch
} from "../lib/engine.js";

let settings = { ...DEFAULTS };
let library = [];
let workspaces = [];
let workspaceLoadPromise = null;
let cachedDirHandle = null;
let workspaceLoadController = null;
let workspaceLoadGeneration = 0;
let selectedIds = new Set();
let trackStatuses = new Map();
let currentPage = 0;
let lastFetchStats = null;
let isDownloading = false;
let fetching = false;
let testingConnection = false;
let controlsInitialized = false;
let drainingQueue = false;
let remoteMessageBusy = false;
const pendingControlMessages = [];
let abortController = null;
const CACHE_KEY = "sppe_library_cache";
const PAGE_SIZE = 100;

const $ = (id) => document.getElementById(id);

function log(message, kind = "info") {
  const el = $("activity-log");
  const time = new Date().toLocaleTimeString();
  const lines = `${el.textContent}[${time}] [${kind}] ${message}\n`.split("\n");
  el.textContent = lines.slice(-500).join("\n");
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, kind = "ok") {
  const el = $("status");
  el.textContent = text;
  el.className = "sp-status " + kind;
}

function setBusy(busy) {
  document.body.classList.toggle("sp-busy", busy);
  document.body.setAttribute("aria-busy", String(busy));
  document.querySelectorAll("button, input, select").forEach((element) => {
    if (element.dataset.keepEnabled === "true" || element.classList.contains("sp-tab-btn")) return;
    if (element.id === "btn-stop") return;
    element.disabled = busy;
  });
  if (!busy) {
    $("btn-stop").disabled = !isDownloading;
    updateLibraryToolbar();
  }
}

function setCoverage(stats) {
  const el = $("coverage-summary");
  if (!el) return;
  if (!stats) {
    el.textContent = library.length ? `${library.length} tracks loaded` : "No sync yet";
    const footer = $("footer-meta");
    if (footer) footer.textContent = library.length ? "Cached locally" : "";
    return;
  }
  const expected = Number(stats.expectedCount || stats.reportedCount || stats.totalExpected) || 0;
  const workspaces = Number(stats.workspaceCount || stats.workspacesDiscovered) || 0;
  const errors = Array.isArray(stats.errors) ? stats.errors.length : 0;
  const parts = [`${library.length} tracks loaded`];
  if (workspaces) parts.push(`${workspaces} workspaces`);
  if (expected) {
    parts.push(`${expected} reported`);
    if (expected > library.length) parts.push(`${expected - library.length} filtered or unavailable`);
  }
  if (errors) parts.push(`${errors} warning${errors === 1 ? "" : "s"}`);
  else if (stats.partial) parts.push("partial sync");
  el.textContent = parts.join(" · ");
  const footer = $("footer-meta");
  if (footer) footer.textContent = stats.savedAt ? `Last sync ${new Date(stats.savedAt).toLocaleString()}` : "Synced locally";
}

async function loadLibraryCache() {
  try {
    const stored = await chrome.storage.local.get(null);
    const cached = stored[CACHE_KEY];
    let clips = cached?.version === 1 && Array.isArray(cached.clips) ? cached.clips : [];
    let stats = cached?.version === 1 ? cached.stats || null : null;
    if (!clips.length) {
      const legacyEntries = Object.entries(stored)
        .filter(([key, value]) => key.startsWith("tracks_") && Array.isArray(value))
        .flatMap(([, value]) => value);
      clips = legacyEntries;
      if (clips.length) stats = { migrated: true, partial: false, errors: [] };
    }
    const normalized = [];
    const seen = new Set();
    for (const clip of clips) {
      const value = normalizeClip(clip?.clip || clip, clip?.workspace_id);
      const id = String(value?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(value);
    }
    if (!normalized.length) return false;
    library = normalized;
    lastFetchStats = stats;
    selectedIds = new Set();
    currentPage = 0;
    renderLibrary();
    setCoverage(lastFetchStats);
    setStatus(`Cached library: ${library.length} tracks`, lastFetchStats?.partial ? "warn" : "ok");
    if (!cached || cached.version !== 1) await saveLibraryCache();
    return true;
  } catch (_) {
    return false;
  }
}

async function saveLibraryCache() {
  try {
    const savedAt = Date.now();
    if (lastFetchStats) lastFetchStats.savedAt = savedAt;
    await chrome.storage.local.set({
      [CACHE_KEY]: {
        version: 1,
        savedAt,
        clips: library,
        stats: lastFetchStats
      }
    });
  } catch (error) {
    log(`Library cache unavailable: ${error.message}`, "warn");
  }
}

function setSyncProgress(progress) {
  const wrap = $("sync-progress");
  const bar = $("sync-progress-bar");
  const label = $("sync-progress-label");
  if (!wrap || !bar || !label) return;
  if (!progress) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  bar.style.width = `${percent}%`;
  wrap.classList.toggle("sp-indeterminate", percent === 0);
  wrap.setAttribute("aria-valuenow", String(Math.round(percent)));
  label.textContent = progress.label || `${percent}%`;
}

function renderTabs() {
  const buttons = [...document.querySelectorAll(".sp-tab-btn")];
  const activate = (button) => {
    buttons.forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll(".sp-tab-panel").forEach((panel) => {
      const activePanel = panel.id === `tab-${button.dataset.tab}`;
      panel.classList.toggle("active", activePanel);
      panel.setAttribute("aria-hidden", String(!activePanel));
    });
  };
  buttons.forEach((button, index) => {
    button.tabIndex = button.classList.contains("active") ? 0 : -1;
    button.addEventListener("click", () => activate(button));
    button.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      buttons[next].focus();
      activate(buttons[next]);
    });
  });
  if (buttons[0]) activate(buttons[0]);
}

function renderWorkspaceOptions() {
  const sel = $("f-workspace");
  if (!sel) return;
  sel.innerHTML = '<option value="">All workspace(s)</option>';
  const currentValue = sel.value;
  workspaces.forEach((w) => {
    const opt = document.createElement("option");
    opt.value = w.id;
    const count = Number(w.clipCount ?? w.count);
    opt.textContent = `${w.name || w.id}${Number.isFinite(count) && count > 0 ? ` · ${count}` : ""}`;
    sel.appendChild(opt);
  });
  const savedWorkspace = settings.lastFilters?.workspaceId;
  if (currentValue && workspaces.some((workspace) => workspace.id === currentValue)) sel.value = currentValue;
  else if (savedWorkspace && workspaces.some((workspace) => workspace.id === savedWorkspace)) sel.value = savedWorkspace;
}

function visibleLibrary() {
  const query = String($("f-search")?.value || "").trim().toLowerCase();
  if (!query) return library;
  return library.filter((clip) => {
    return [clip.title, clip.artist, clip.model, clip.album, clip.workspace_id, clip.id, clip.prompt, clip.lyrics, ...(Array.isArray(clip.tags) ? clip.tags : [])]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function updateLibraryToolbar() {
  const count = $("lib-count");
  const selection = $("lib-selection");
  if (count) count.textContent = `${library.length} track${library.length === 1 ? "" : "s"}`;
  if (selection) selection.textContent = `${selectedIds.size} selected`;
  const previous = $("btn-prev-page");
  const next = $("btn-next-page");
  const pages = Math.max(1, Math.ceil(visibleLibrary().length / PAGE_SIZE));
  if (previous) previous.disabled = currentPage <= 0;
  if (next) next.disabled = currentPage >= pages - 1;
}

function renderLibrary() {
  const body = $("lib-body");
  if (!body) return;
  const filtered = visibleLibrary();
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.max(0, Math.min(currentPage, pages - 1));
  const start = currentPage * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  body.replaceChildren();
  if (!pageItems.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "sp-hint sp-empty";
    td.textContent = library.length ? "No tracks match this search." : "Sync your library to get started.";
    tr.appendChild(td);
    body.appendChild(tr);
  } else {
    const fragment = document.createDocumentFragment();
    pageItems.forEach((clip) => {
      const tr = document.createElement("tr");
      tr.dataset.trackId = clip.id;
      const checkCell = document.createElement("td");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "row-check";
      check.dataset.trackId = clip.id;
      check.checked = selectedIds.has(clip.id);
      check.setAttribute("aria-label", `Select ${clip.title || "track"}`);
      check.addEventListener("change", () => {
        if (check.checked) selectedIds.add(clip.id);
        else selectedIds.delete(clip.id);
        updateLibraryToolbar();
      });
      checkCell.appendChild(check);
      const trackCell = document.createElement("td");
      const title = document.createElement("strong");
      title.textContent = clip.title || "Untitled track";
      const subtitle = document.createElement("small");
      subtitle.textContent = clip.workspace_id && clip.workspace_id !== "default" ? "Project track" : "Personal library";
      trackCell.append(title, subtitle);
      const idCell = document.createElement("td");
      idCell.className = "sp-mono";
      idCell.textContent = `${clip.id.slice(0, 8)}…`;
      const artistCell = document.createElement("td");
      artistCell.textContent = clip.artist || "—";
      const modelCell = document.createElement("td");
      modelCell.textContent = clip.model || "—";
      const statusCell = document.createElement("td");
      const savedStatus = trackStatuses.get(clip.id);
      statusCell.className = `row-status sp-mono ${savedStatus?.className || ""}`.trim();
      statusCell.dataset.trackId = clip.id;
      statusCell.textContent = savedStatus?.text || "Ready";
      tr.append(checkCell, trackCell, idCell, artistCell, modelCell, statusCell);
      fragment.appendChild(tr);
    });
    body.appendChild(fragment);
  }
  const pageLabel = $("page-label");
  if (pageLabel) {
    pageLabel.textContent = filtered.length
      ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`
      : "No tracks";
  }
  updateLibraryToolbar();
}

function selectedRows() {
  return library.filter((clip) => selectedIds.has(clip.id));
}

function hasDirectMp3Source(clip) {
  const source = clip?.raw || clip || {};
  const direct = typeof source.audio_url === "string" && /^https?:/i.test(source.audio_url) && !/forbidden/i.test(source.audio_url) && (/\.mp3(?:[?#]|$)/i.test(source.audio_url) || /[?&](?:format|type)=mp3/i.test(source.audio_url));
  const listed = Array.isArray(source.media_urls) && source.media_urls.some((entry) => {
    return typeof entry?.url === "string" && /mp3/i.test(String(entry.content_type || entry.type || ""));
  });
  return direct || listed;
}

function setRowStatus(trackId, text, cls = "") {
  trackStatuses.set(trackId, { text, className: cls });
  document.querySelectorAll(`.row-status[data-track-id="${trackId}"]`).forEach((element) => {
    element.textContent = text;
    element.className = `row-status sp-mono ${cls}`.trim();
  });
}

function currentFilters() {
  return {
    likedOnly: !!$("f-liked").checked,
    includeUploads: !!$("f-uploads").checked,
    ignoreDisliked: !!$("f-ignore-disliked").checked,
    workspaceId: $("f-workspace").value
  };
}

function applySettingsToForm() {
  document.querySelectorAll('input[type="radio"]').forEach((el) => {
    if (el.name) {
      const matching = settings[el.name] === el.value;
      if (matching) el.checked = true;
    }
  });
  const setChk = (id, key) => {
    const el = $(id);
    if (el) el.checked = !!settings[key];
  };
  setChk("f-ignore-disliked", "ignoreDisliked");
  setChk("f-uploads", "includeUploads");
  if (settings.lastFilters && typeof settings.lastFilters.likedOnly === "boolean") $("f-liked").checked = settings.lastFilters.likedOnly;
  if (settings.lastFilters && typeof settings.lastFilters.includeUploads === "boolean") $("f-uploads").checked = settings.lastFilters.includeUploads;
  setChk("s-artwork", "embedArtwork");
  setChk("s-lyrics", "includeLyrics");
  setChk("s-detectbpm", "detectBpm");
  setChk("s-sidecar", "includeMetadataSidecar");
  setChk("s-shortid", "shortId");
  setChk("s-inlinebtns", "enableInlineButtons");
  const tmpl = $("s-template");
  if (tmpl) tmpl.value = settings.filenameTemplate;
  const conc = $("s-concurrency");
  if (conc) conc.value = settings.concurrency;
  const rl = $("s-ratelimit");
  if (rl) rl.value = settings.rateLimitMs;
  const mode = $("s-download-mode");
  if (mode) mode.value = settings.downloadMode || "directory";
}

function readSettingsFromForm() {
  const readRadio = (name) => {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : DEFAULTS[name];
  };
  settings.audioFormat = readRadio("audioFormat");
  settings.includeUploads = !!$("f-uploads").checked;
  settings.ignoreDisliked = !!$("f-ignore-disliked").checked;
  settings.embedArtwork = !!$("s-artwork").checked;
  settings.includeLyrics = !!$("s-lyrics").checked;
  settings.detectBpm = !!$("s-detectbpm").checked;
  settings.includeMetadataSidecar = !!$("s-sidecar").checked;
  settings.shortId = !!$("s-shortid").checked;
  settings.enableInlineButtons = !!$("s-inlinebtns").checked;
  settings.filenameTemplate = $("s-template").value;
  settings.concurrency = Math.max(1, Math.min(4, Number($("s-concurrency").value) || DEFAULTS.concurrency));
  settings.rateLimitMs = Number($("s-ratelimit").value) || DEFAULTS.rateLimitMs;
  settings.downloadMode = $("s-download-mode")?.value || DEFAULTS.downloadMode;
  settings.lastFilters = currentFilters();
  return settings;
}

async function loadSettings() {
  settings = await getSettings();
  applySettingsToForm();
  await refreshDirectoryStatus();
  const session = await chrome.storage.local.get("__sppe_token");
  setStatus(session.__sppe_token ? "Ready" : "Open a signed-in Suno tab", session.__sppe_token ? "ok" : "warn");
  void loadWorkspaces().catch((error) => {
    if (error.name !== "AbortError") log(`Workspace discovery delayed: ${error.message}`, "warn");
  });
}

async function refreshDirectoryStatus() {
  const handle = await getStoredDirHandle();
  cachedDirHandle = handle;
  const el = $("dir-status");
  if (settings.downloadMode === "downloads") {
    el.textContent = "Browser Downloads selected.";
    el.className = "status-row ok";
  } else if (!handle) {
    el.textContent = "No folder selected; exports will use browser Downloads until permission is granted.";
    el.className = "status-row";
  } else {
    el.textContent = `Selected: ${dirLabel(handle)}`;
    el.className = "status-row ok";
  }
}

async function loadWorkspaces(force = false, signal = null) {
  if (workspaceLoadPromise && !force) return workspaceLoadPromise;
  if (!force && workspaces.length) return workspaces;
  if (force && workspaceLoadController) workspaceLoadController.abort();
  const generation = ++workspaceLoadGeneration;
  const internalController = signal ? null : new AbortController();
  workspaceLoadController = internalController;
  const requestSignal = signal || internalController?.signal || null;
  const promise = (async () => {
    try {
      workspaces = await fetchWorkspaces(null, { signal: requestSignal });
      renderWorkspaceOptions();
      return workspaces;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      log(`Workspace fetch failed: ${e.message}`, "error");
      workspaces = [];
      renderWorkspaceOptions();
      return workspaces;
    } finally {
      if (generation === workspaceLoadGeneration) {
        workspaceLoadPromise = null;
        workspaceLoadController = null;
      }
    }
  })();
  workspaceLoadPromise = promise;
  return promise;
}

$("btn-choose-dir").addEventListener("click", async () => {
  try {
    const handle = await pickDirectory();
    cachedDirHandle = handle;
    await refreshDirectoryStatus();
    log(`Directory chosen: ${dirLabel(handle)}`);
    await runDedupeScan();
  } catch (e) {
    log(`Directory selection failed: ${e.message}`, "error");
  }
});

$("btn-reconnect-dir").addEventListener("click", async () => {
  try {
    const handle = cachedDirHandle || await getStoredDirHandle();
    if (!handle) {
      log("No saved folder to reconnect", "warn");
      return;
    }
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      cachedDirHandle = handle;
      log(`Directory reconnected: ${dirLabel(handle)}`, "ok");
    } else log("Directory permission denied", "error");
  } catch (e) {
    log(`Directory reconnect failed: ${e.message}`, "error");
  }
});

$("btn-clear-dir").addEventListener("click", async () => {
  await clearStoredDirHandle();
  cachedDirHandle = null;
  await refreshDirectoryStatus();
  log("Directory cleared");
});

$("btn-scan-dir").addEventListener("click", runDedupeScan);

async function runDedupeScan() {
  const handle = await getStoredDirHandle();
  if (!handle) {
    log("No folder selected; downloads will use the browser Downloads folder.");
    return;
  }
  const before = library.length;
  if (before) {
    const ids = library.map((c) => c.id);
    const existing = await scanExistingIds(handle, ids);
    log(`Folder scan: ${existing.size}/${ids.length} tracks already exist`);
  } else {
    setStatus(`Scanning ${dirLabel(handle)}…`, "ok");
    log(`Scanning folder ${dirLabel(handle)}`);
  }
}

$("btn-fetch").addEventListener("click", fetchLibraryUi);

async function fetchLibraryUi() {
  if (fetching || testingConnection) {
    log("A library operation is already in progress");
    return;
  }
  fetching = true;
  setBusy(true);
  $("btn-stop").disabled = false;
  try {
    const controller = new AbortController();
    abortController = controller;
    const filters = currentFilters();
    const knownWorkspaces = await loadWorkspaces(true, controller.signal);
    setStatus("Syncing library…", "ok");
    setSyncProgress({ percent: 0, label: "Discovering workspaces…" });
    log(`Sync started: ${filters.workspaceId ? "selected workspace" : "all workspaces"}`);
    dbg("fetchLibraryUi", filters);
    const configuredPacing = Number(settings.rateLimitMs);
    const result = await fetchLibraryDetailed({
      ...filters,
      includeDisliked: !filters.ignoreDisliked,
      ...(knownWorkspaces.length ? { workspaces: knownWorkspaces } : {}),
      requestPacingMs: Number.isFinite(configuredPacing) ? Math.max(0, configuredPacing) : 1200,
      signal: controller.signal,
      onProgress: (progress) => {
        const total = Number(progress?.total) || 0;
        const added = Number(progress?.added) || 0;
        const phase = progress?.phase || "page";
        const page = progress?.page || progress?.workspace || "";
        const percent = Number(progress?.percent) || 0;
        setSyncProgress({ percent, label: `${phase} ${page} · ${total} tracks${added ? ` (+${added})` : ""}` });
        setStatus(`Syncing · ${total} tracks`, "ok");
        dbg("feed progress", progress);
        if (phase === "complete" || (progress?.pageCount && progress.pageCount % 5 === 0)) {
          log(`Sync ${phase}: ${total} tracks${added ? ` (+${added})` : ""}`);
        }
      }
    });
    library = Array.isArray(result) ? result : result.clips || [];
    lastFetchStats = Array.isArray(result) ? null : result.stats || null;
    await saveLibraryCache();
    setCoverage(lastFetchStats);
    selectedIds = new Set([...selectedIds].filter((id) => library.some((clip) => clip.id === id)));
    currentPage = 0;
    renderLibrary();
    const warning = lastFetchStats?.errors?.length || lastFetchStats?.partial;
    log(`Library sync ${warning ? "partial" : "complete"}: ${library.length} tracks`);
    if (Array.isArray(lastFetchStats?.errors) && lastFetchStats.errors.length) {
      log(`Sync warnings: ${lastFetchStats.errors.slice(0, 3).join("; ")}`, "error");
    }
    setSyncProgress(null);
    setStatus(warning ? `Partial sync: ${library.length} tracks` : `Library ready: ${library.length} tracks`, warning ? "warn" : "ok");
    try {
      await runDedupeScan();
    } catch (scanError) {
      log(`Folder scan skipped: ${scanError.message}`, "warn");
    }
  } catch (e) {
    if (e.name === "AbortError") {
      setStatus("Library sync cancelled", "warn");
      log("Library sync cancelled");
    } else {
      log(`Library fetch failed: ${e.message}`, "error");
      dbg("fetchLibraryUi error", e);
      setStatus("Library fetch failed: " + e.message, "err");
    }
    setSyncProgress(null);
  } finally {
    fetching = false;
    abortController = null;
    setBusy(false);
  }
}

$("btn-test-conn").addEventListener("click", async () => {
  if (fetching || testingConnection) {
    log("A library operation is already in progress");
    return;
  }
  testingConnection = true;
  setBusy(true);
  try {
    const probe = await withTimeout(probeFeedConnection({ limit: 1, workspaceId: "default" }), 15000, "Connection test");
    log(`Connection OK: ${probe.clipCount} sample item${probe.clipCount === 1 ? "" : "s"} in ${probe.latencyMs}ms`);
    setStatus("Connection OK", "ok");
  } catch (e) {
    log(`Connection failed: ${e.message}`, "error");
    setStatus("Connection failed: " + e.message, "err");
  } finally {
    testingConnection = false;
    setBusy(false);
  }
});

$("btn-clear").addEventListener("click", async () => {
  library = [];
  selectedIds.clear();
  trackStatuses.clear();
  currentPage = 0;
  lastFetchStats = null;
  await chrome.storage.local.remove(CACHE_KEY);
  renderLibrary();
  setCoverage(null);
  setStatus("Library list cleared", "ok");
});

$("f-search")?.addEventListener("input", () => {
  currentPage = 0;
  renderLibrary();
});

$("btn-prev-page")?.addEventListener("click", () => {
  currentPage = Math.max(0, currentPage - 1);
  renderLibrary();
});

$("btn-select-page")?.addEventListener("click", () => {
  const filtered = visibleLibrary();
  const start = currentPage * PAGE_SIZE;
  filtered.slice(start, start + PAGE_SIZE).forEach((clip) => selectedIds.add(clip.id));
  renderLibrary();
});

$("btn-select-all")?.addEventListener("click", () => {
  visibleLibrary().forEach((clip) => selectedIds.add(clip.id));
  renderLibrary();
});

$("btn-clear-selection")?.addEventListener("click", () => {
  selectedIds.clear();
  renderLibrary();
});

$("btn-next-page")?.addEventListener("click", () => {
  currentPage += 1;
  renderLibrary();
});

$("btn-debug").addEventListener("click", async () => {
  const s = await chrome.storage.local.get("sppe_debug");
  const next = !s.sppe_debug;
  await setDebug(next);
  $("btn-debug").textContent = next ? "Debug: on" : "Debug: off";
});

$("btn-dl-m4a").addEventListener("click", () => runBatch("m4a"));
$("btn-dl-mp3").addEventListener("click", () => runBatch("mp3"));
$("btn-dl-wav").addEventListener("click", () => runBatch("wav"));
$("btn-stop").addEventListener("click", () => stopBatch());
$("btn-save-settings").addEventListener("click", async () => {
  readSettingsFromForm();
  await saveSettings(settings);
  const el = $("settings-saved");
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1500);
  log("Settings saved");
  await refreshDirectoryStatus();
});

$("btn-clear-log").addEventListener("click", () => { $("activity-log").textContent = ""; });

async function runBatch(format) {
  let toDownload = selectedRows();
  if (!toDownload.length) {
    setStatus("Select at least one track to export", "warn");
    return;
  }
  let unavailable = 0;
  if (format === "mp3") {
    const unsupported = toDownload.filter((clip) => !hasDirectMp3Source(clip));
    unavailable = unsupported.length;
    toDownload = toDownload.filter((clip) => hasDirectMp3Source(clip));
    if (unavailable) log(`MP3 source unavailable for ${unavailable} selected track${unavailable === 1 ? "" : "s"}; skipping ${unavailable === 1 ? "it" : "them"}.`);
    if (!toDownload.length) {
      setStatus("No direct MP3 sources are available in this selection", "warn");
      return;
    }
  }
  if (isDownloading) return;
  isDownloading = true;
  setBusy(true);
  $("btn-stop").disabled = false;
  const batchSettings = { ...settings, audioFormat: format };
  const controller = new AbortController();
  abortController = controller;
  const startTime = Date.now();
  log(`Export started: ${toDownload.length} tracks (${format})`);
  try {
    const results = await downloadBatch(toDownload, batchSettings, (_rows, _index, _total, pct, clip) => {
      if (clip) setRowStatus(clip.id, pct < 50 ? `Downloading ${Math.round(pct)}%` : `Writing ${Math.round(pct)}%`);
    }, controller.signal);
    const done = results.filter((result) => result?.status === "done").length;
    const skipped = results.filter((result) => result?.status === "skipped").length;
    const failed = results.filter((result) => result?.status === "failed").length;
    results.forEach((result) => {
      if (result?.id) setRowStatus(result.id, result.status || "done", result.status === "failed" ? "status-error" : "");
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (controller.signal.aborted) {
      log(`Export cancelled after ${elapsed}s`);
      setStatus("Export cancelled", "warn");
    } else {
      log(`Export finished in ${elapsed}s: ${done} done, ${skipped} skipped, ${failed} failed${unavailable ? `, ${unavailable} unavailable` : ""}`);
      setStatus(`Export complete: ${done} done${failed ? `, ${failed} failed` : ""}${unavailable ? `, ${unavailable} unavailable` : ""}`, failed || unavailable ? "warn" : "ok");
    }
  } catch (e) {
    log(`Export failed: ${e.message}`, "error");
    setStatus("Export failed: " + e.message, "err");
  } finally {
    isDownloading = false;
    abortController = null;
    setBusy(false);
  }
}

function stopBatch() {
  if (!abortController) return;
  abortController.abort();
  log(fetching ? "Sync cancellation requested" : "Export cancellation requested");
  setStatus("Stopping after the current operation…", "warn");
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function hydrateIncomingClip(clip) {
  const source = clip?.raw || clip || {};
  const hasMetadata = source.title || source.metadata || source.media_urls?.length || source.audio_url;
  if (hasMetadata) return normalizeClip(clip, clip.workspace_id) || clip;
  try {
    const metadata = await withTimeout(fetchClipMetadata(clip.id), 15000, "Metadata request");
    return normalizeClip(metadata?.clip || metadata?.data?.clip || metadata?.data || metadata, clip.workspace_id) || clip;
  } catch (_) {
    return normalizeClip(clip, clip.workspace_id) || clip;
  }
}

async function handleControlsMessage(msg) {
  if (fetching || isDownloading || remoteMessageBusy) {
    log("Ignoring remote download while another library operation is active", "warn");
    return;
  }
  remoteMessageBusy = true;
  try {
    if (msg.action === "downloadTrack" && msg.clip) {
      const format = msg.format || settings.audioFormat;
      log(`Single-track request: ${msg.clip.id}`);
      const clip = await hydrateIncomingClip(msg.clip);
      const controller = new AbortController();
      abortController = controller;
      const result = await downloadTrack(clip, { ...settings, audioFormat: format }, (pct) => setStatus(`Downloading ${msg.clip.id.slice(0, 8)}… ${Math.round(pct)}%`), controller.signal);
      abortController = null;
      if (result?.status === "failed") {
        log(`Single export failed: ${result.error || "unknown error"}`, "error");
        setStatus(`Export failed: ${result.error || "unknown error"}`, "err");
      } else {
        log(`Single export ${result?.status || "complete"}: ${msg.clip.id}`);
      }
      return;
    }
    if (msg.action === "downloadBatch" && Array.isArray(msg.clips)) {
      const fmt = msg.filters?.format || settings.audioFormat;
      log(`Remote batch request: ${msg.clips.length} tracks (${fmt})`);
      library = (await Promise.all(msg.clips.map((clip) => hydrateIncomingClip(clip)))).filter(Boolean);
      selectedIds = new Set(library.map((clip) => clip.id));
      currentPage = 0;
      renderLibrary();
      await runBatch(fmt);
    }
  } finally {
    remoteMessageBusy = false;
    abortController = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "controls") return;
  if (!controlsInitialized) {
    pendingControlMessages.push(msg);
    return;
  }
  void handleControlsMessage(msg).catch((error) => log(error.message, "error"));
});

async function drainControlsQueue() {
  if (drainingQueue) return;
  drainingQueue = true;
  const prefix = "__sppe_controls_queue:";
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const stored = await chrome.storage.local.get(null);
      const entries = Object.entries(stored).filter(([key, value]) => key.startsWith(prefix) && value && typeof value === "object");
      for (const [key, message] of entries) {
        void handleControlsMessage(message).catch((error) => log(error.message, "error"));
        await chrome.storage.local.remove(key);
      }
      const legacy = Array.isArray(stored.__sppe_controls_queue) ? stored.__sppe_controls_queue : [];
      for (const message of legacy) {
        void handleControlsMessage(message).catch((error) => log(error.message, "error"));
      }
      if (legacy.length) await chrome.storage.local.remove("__sppe_controls_queue");
      if (!entries.length && !legacy.length) break;
    }
  } finally {
    drainingQueue = false;
  }
}

async function init() {
  renderTabs();
  await loadSettings();
  await loadLibraryCache();
  const s = await chrome.storage.local.get("sppe_debug");
  $("btn-debug").textContent = s.sppe_debug ? "Debug: on" : "Debug: off";
  await drainControlsQueue();
  await handlePendingQuery();
  controlsInitialized = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((key) => key.startsWith("__sppe_controls_queue"))) {
      void drainControlsQueue();
    }
  });
  const queued = pendingControlMessages.splice(0);
  queued.forEach((message) => void handleControlsMessage(message).catch((error) => log(error.message, "error")));
}

async function handlePendingQuery() {
  const params = new URLSearchParams(location.search);
  const dl = params.get("dl");
  const batch = params.get("batch");
  const requestedFormat = params.get("fmt") || settings.audioFormat;
  if (dl) {
    log(`Fetching metadata for ${dl}`);
    try {
      const meta = await withTimeout(fetchClipMetadata(dl), 15000, "Metadata request");
      const clip = normalizeClip(meta?.clip || meta?.data || meta);
      if (clip) {
        const controller = new AbortController();
        abortController = controller;
        const result = await downloadTrack(clip, { ...settings, audioFormat: requestedFormat }, (pct) => setStatus(`Downloading ${dl.slice(0, 8)}… ${Math.round(pct)}%`), controller.signal);
        abortController = null;
        if (result?.status === "failed") {
          log(`Download ${dl} failed: ${result.error || "unknown error"}`, "error");
          setStatus(`Download failed: ${result.error || "unknown error"}`, "err");
        }
      }
    } catch (e) {
      log(`Download ${dl} failed: ${e.message}`, "error");
    }
    window.history.replaceState({}, document.title, location.pathname);
  } else if (batch) {
    log("Queued batch request loaded");
  }
}

init().catch((error) => {
  log(`Controls initialization failed: ${error.message}`, "error");
  setStatus(`Controls initialization failed: ${error.message}`, "err");
  controlsInitialized = true;
  const queued = pendingControlMessages.splice(0);
  queued.forEach((message) => void handleControlsMessage(message).catch((itemError) => log(itemError.message, "error")));
});
