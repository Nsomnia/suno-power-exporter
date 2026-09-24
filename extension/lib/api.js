// lib/api.js — Authenticated Suno Studio API client.
import { API_BASE, buildAuthHeaders, getAuthToken, getDeviceId, generateBrowserToken, delay } from "./utils.js";
import { dbg } from "./debug.js";
import {
  FeedCrawlError,
  abortableDelay,
  createRequestPacer,
  crawlLibraryDetailed as crawlLibrary,
  flattenFeedClips,
  getFeedEntries,
  getFeedPaginationState,
  probeFeedConnection as probeFeed,
  raceWithAbort,
  throwIfAborted
} from "./feed.js";

export { flattenFeedClips, getFeedEntries, getFeedPaginationState };

export class SunoApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function authHeaders(token) {
  const t = token || (await getAuthToken());
  return buildAuthHeaders(t);
}

export async function apiRequest(path, { method = "GET", body = null, query = null, token = null, signal = null, json = true } = {}) {
  let url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  if (query) url += (url.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();

  const headers = await authHeaders(token);
  const opts = { method, signal, headers, credentials: "include" };
  if (body != null) opts.body = typeof body === "string" ? body : JSON.stringify(body);

  const resp = await retryAsyncFetch(url, opts);
  if (!resp.ok) {
    let data = null;
    try { data = await resp.clone().json(); } catch (_) {}
    throw new SunoApiError(`${resp.status} ${resp.statusText} for ${path}`, resp.status, data);
  }
  if (!json || resp.status === 204) return null;
  return resp.json();
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

export function parseRetryAfter(value, now = Date.now()) {
  if (Array.isArray(value)) value = value[0];
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

async function responseError(response, path) {
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    try {
      data = await response.text();
    } catch (_) {}
  }
  const label = [response.status, response.statusText].filter(Boolean).join(" ");
  const error = new SunoApiError(`${label} for ${path}`, response.status, data);
  error.url = response.url || null;
  error.headers = response.headers || {};
  error.retryAfterMs = parseRetryAfter(headerValue(response.headers, "retry-after"));
  return error;
}

export async function pageFetch(
  url,
  {
    method = "GET",
    headers = {},
    body = null,
    token = null,
    retries = 4,
    signal = null,
    beforeRequest = null,
    onAttempt = null,
    onRetry = null
  } = {}
) {
  dbg("pageFetch", url, method);
  let authToken = token || (await getAuthToken());
  let authRetried = false;
  const parsedRetries = Number(retries);
  const retryLimit = Number.isFinite(parsedRetries) ? Math.max(0, Math.floor(parsedRetries)) : 4;
  let attempt = 0;
  for (;;) {
    throwIfAborted(signal);
    if (typeof beforeRequest === "function") await beforeRequest(signal);
    throwIfAborted(signal);
    onAttempt?.({ url, attempt: attempt + 1 });
    const [deviceId, browserToken] = await Promise.all([getDeviceId(), generateBrowserToken()]);
    const mergedHeaders = {
      accept: "*/*",
      "content-type": "application/json",
      ...(headers || {}),
      "device-id": deviceId,
      "browser-token": browserToken
    };
    if (authToken) mergedHeaders.Authorization = authToken;
    let response;
    try {
      const request = chrome.runtime.sendMessage({
        action: "proxyFetch",
        payload: { url, method, headers: mergedHeaders, body }
      });
      response = await raceWithAbort(request, signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (attempt >= retryLimit) throw new SunoApiError(error.message || "Proxy request failed", 0);
      const wait = 1000 * Math.pow(2, attempt) + Math.random() * 500;
      onRetry?.({ url, status: 0, attempt: attempt + 1, waitMs: wait, retryAfterMs: null });
      await abortableDelay(wait, signal);
      attempt++;
      continue;
    }
    const status = response ? response.__status || 0 : 0;
    if ((status === 401 || status === 403) && !token && !authRetried) {
      authRetried = true;
      const refreshed = await getAuthToken();
      if (refreshed && refreshed !== authToken) {
        authToken = refreshed;
        await abortableDelay(750, signal);
        continue;
      }
      if (authToken) {
        authToken = null;
        await chrome.storage.local.remove?.(["__sppe_token", "authToken"]);
        await abortableDelay(250, signal);
        continue;
      }
    }
    const transient = status === 0 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    if (transient && attempt < retryLimit) {
      const retryAfterMs = parseRetryAfter(headerValue(response?.__headers, "retry-after"));
      const base = status === 429 ? 4000 : 1000;
      const wait = retryAfterMs ?? base * Math.pow(2, attempt) + Math.random() * 1000;
      const retry = { url, status, attempt: attempt + 1, waitMs: wait, retryAfterMs };
      dbg("pageFetch transient", status, "retry", attempt, "wait", Math.round(wait));
      onRetry?.(retry);
      await abortableDelay(wait, signal);
      attempt++;
      continue;
    }
    dbg("pageFetch done", url, status);
    if (response?.__error) throw new SunoApiError(response.__error, status);
    const responseBody = response?.__body || "";
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: response?.__statusText || "",
      url,
      headers: response?.__headers || {},
      attempts: attempt + 1,
      text: () => Promise.resolve(responseBody),
      json: () => Promise.resolve(JSON.parse(responseBody || "null"))
    };
  }
}

async function retryAsyncFetch(url, opts) {
  let attempt = 0;
  for (;;) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      if (attempt++ >= 2) throw err;
      await delay(800 * Math.pow(2, attempt));
    }
  }
}

export async function fetchClipMetadata(clipId, token = null) {
  const path = `/api/clip/${encodeURIComponent(clipId)}`;
  const response = await pageFetch(`${API_BASE}${path}`, { token });
  if (!response.ok) throw await responseError(response, path);
  return response.json();
}

export async function fetchMangoRights(clipId, token = null) {
  const path = "/api/mango/rights";
  const response = await pageFetch(`${API_BASE}${path}`, {
    method: "POST",
    body: JSON.stringify({ content_params: { content_id: clipId, content_type: "clip" } }),
    token
  });
  if (!response.ok) throw await responseError(response, path);
  return response.json();
}

export async function triggerWavConversion(clipId, token = null) {
  const path = `/api/gen/${clipId}/convert_wav/`;
  const response = await pageFetch(`${API_BASE}${path}`, {
    method: "POST",
    body: "{}",
    token
  });
  if (!response.ok) throw await responseError(response, path);
  return response.json();
}

export async function fetchWorkspacesDetailed(token = null, options = {}) {
  const started = new Date();
  const projects = [];
  const errors = [];
  const seenIds = new Set();
  const signal = options.signal || null;
  const parsedMaxPages = Number(options.maxPages);
  const maxPages = Number.isFinite(parsedMaxPages) ? Math.max(1, Math.floor(parsedMaxPages)) : 10000;
  const requestPacingMs = options.requestPacingMs == null ? 250 : Math.max(0, Number(options.requestPacingMs) || 0);
  const beforeRequest = options.beforeRequest || createRequestPacer(requestPacingMs, abortableDelay).wait;
  let page = 1;
  const seenPages = new Set();
  let pagesFetched = 0;
  let complete = true;
  let stopped = false;
  let expectedTotal = null;

  while (pagesFetched < maxPages) {
    throwIfAborted(signal);
    if (seenPages.has(page)) {
      errors.push(new FeedCrawlError(`Repeated workspace page ${page}`));
      complete = false;
      break;
    }
    seenPages.add(page);
    let data;
    try {
      const response = await pageFetch(
        `${API_BASE}/api/project/me?page=${page}&sort=created_at&show_trashed=false&exclude_shared=false`,
        {
          token,
          signal,
          beforeRequest,
          onAttempt: options.onAttempt,
          onRetry: options.onRetry
        }
      );
      if (!response.ok) throw await responseError(response, "/api/project/me");
      data = typeof response.json === "function" ? await response.json() : response;
    } catch (error) {
      throwIfAborted(signal);
      errors.push(error);
      complete = false;
      break;
    }

    const batch = Array.isArray(data)
      ? data
      : Array.isArray(data?.projects)
        ? data.projects
        : Array.isArray(data?.data?.projects)
          ? data.data.projects
          : null;
    if (!batch) {
      const error = new FeedCrawlError("Workspace response does not contain a projects array");
      errors.push(error);
      complete = false;
      break;
    }

    if (data?.current_page != null && Number(data.current_page) !== page) {
      const error = new FeedCrawlError(`Workspace page mismatch: requested ${page}, received ${data.current_page}`);
      errors.push(error);
      complete = false;
      break;
    }
    pagesFetched++;
    for (const project of batch) {
      const id = project?.id ?? project?.project_id ?? project?.uuid;
      if (id == null || id === "") continue;
      const normalizedId = String(id);
      if (seenIds.has(normalizedId)) continue;
      seenIds.add(normalizedId);
      projects.push({
        id: normalizedId,
        name: project.name || project.title || normalizedId,
        count: project.clip_count ?? project.song_count ?? project.count ?? null,
        clipCount: project.clip_count ?? project.song_count ?? project.count ?? null,
        lastUpdatedClip: project.last_updated_clip || null
      });
    }

    const paginationData = data?.num_total_results == null && expectedTotal != null
      ? { ...data, num_total_results: expectedTotal }
      : data;
    const state = getFeedPaginationState(paginationData, {
      mode: "legacy",
      currentPage: page,
      pageSize: 20,
      itemCount: batch.length,
      collectedCount: projects.length
    });
    if (state.error) {
      errors.push(new FeedCrawlError(state.error));
      complete = false;
      break;
    }
    if (state.expectedTotal !== null && state.expectedTotal !== undefined) {
      if (expectedTotal !== null && state.expectedTotal !== expectedTotal) {
        errors.push(new FeedCrawlError(`Workspace total changed from ${expectedTotal} to ${state.expectedTotal}`));
        complete = false;
        break;
      }
      expectedTotal = state.expectedTotal;
    }
    if (state.done) {
      stopped = true;
      break;
    }
    const nextPage = Number(state.nextPage);
    if (!Number.isInteger(nextPage) || nextPage <= 0) {
      errors.push(new FeedCrawlError(`Invalid workspace next_page value: ${String(state.nextPage)}`));
      complete = false;
      break;
    }
    page = nextPage;
  }

  if (pagesFetched >= maxPages && complete && !stopped) {
    const error = new FeedCrawlError(`Workspace pagination exceeded ${maxPages} pages`);
    errors.push(error);
    complete = false;
  }

  const finished = new Date();
  return {
    complete,
    projects,
    errors,
    stats: {
      pagesFetched,
      projectsDiscovered: projects.length,
      expectedTotal,
      elapsedMs: finished.getTime() - started.getTime()
    },
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString()
  };
}

export async function fetchWorkspaces(token = null, options = {}) {
  const result = await fetchWorkspacesDetailed(token, options);
  if (!result.complete) {
    const error = result.errors[0] || new FeedCrawlError("Workspace crawl was incomplete");
    error.partialResult = result;
    throw error;
  }
  return result.projects;
}

export function normalizeClip(raw, fallbackWorkspaceId = null) {
  if (!raw || !raw.id) return null;
  const md = raw.metadata || {};
  const likes = raw.is_liked != null ? raw.is_liked : raw.liked != null;
  const dislikes = raw.is_disliked != null ? raw.is_disliked : raw.disliked != null;
  return {
    id: String(raw.id),
    title: raw.title || md.title || "Suno Track",
    artist: raw.display_name || raw.username || md.artist || "Suno AI",
    display_name: raw.display_name || raw.username || md.artist || "Suno AI",
    album: md.album || "Suno AI Music",
    model: raw.major_model_version || md.model || "v3",
    major_model_version: raw.major_model_version || md.model || "v3",
    tags: md.tags || raw.tags || [],
    prompt: md.prompt || raw.prompt || md.gpt_description_prompt || raw.gpt_description_prompt || "",
    lyrics: md.infill_lyrics || md.lyrics || raw.lyrics || null,
    metadata: md,
    image_url: raw.image_url || raw.image_large_url || md.image_url || "https://suno.com/favicon.ico",
    media_urls: Array.isArray(raw.media_urls) ? raw.media_urls : [],
    audio_url: raw.audio_url || null,
    created_at: raw.created_at || md.created_at || null,
    duration: raw.duration || md.duration || null,
    has_vocal: md.has_vocal != null ? md.has_vocal : true,
    is_upload: raw.is_audio_upload === true || raw.type === "upload" || md.type === "upload" || md.is_audio_upload === true || raw.is_upload === true,
    is_liked: likes === true,
    is_disliked: dislikes === true,
    is_trashed: raw.is_trashed === true || raw.trashed === true || md.is_trashed === true,
    workspace_id: raw.project?.id || raw.project_id || raw.workspace_id || md.project_id || md.workspace_id || fallbackWorkspaceId || null,
    project: raw.project || null,
    raw
  };
}

export function extractFeedItems(response) {
  return flattenFeedClips(getFeedEntries(response));
}

export async function fetchFeedPage({
  cursor = null,
  limit = 100,
  workspaceId = "default",
  token = null,
  disliked = null,
  trashed = null,
  signal = null,
  beforeRequest = null,
  onAttempt = null,
  onRetry = null
} = {}) {
  const normalizeFlag = (value) => value == null ? undefined : (value === true || value === 1 || value === "1" || value === "True" ? "True" : "False");
  const filters = {
    workspace: { presence: "True", workspaceId }
  };
  if (disliked != null) filters.disliked = normalizeFlag(disliked);
  if (trashed != null) filters.trashed = normalizeFlag(trashed);
  const body = {
    cursor,
    limit,
    filters
  };
  const response = await pageFetch(`${API_BASE}/api/feed/v3`, {
    method: "POST",
    body: JSON.stringify(body),
    token,
    signal,
    beforeRequest,
    onAttempt,
    onRetry
  });
  if (!response.ok) throw await responseError(response, "/api/feed/v3");
  return response.json();
}

export async function fetchLegacyFeedPage({
  page = 1,
  token = null,
  signal = null,
  beforeRequest = null,
  onAttempt = null,
  onRetry = null
} = {}) {
  const numericPage = Number(page);
  if (!Number.isInteger(numericPage) || numericPage <= 0) {
    throw new FeedCrawlError(`Invalid legacy feed page: ${String(page)}`);
  }
  const path = `/api/feed/?page=${numericPage}`;
  const response = await pageFetch(`${API_BASE}${path}`, {
    method: "GET",
    token,
    signal,
    beforeRequest,
    onAttempt,
    onRetry
  });
  if (!response.ok) throw await responseError(response, path);
  return response.json();
}

export async function fetchLibraryDetailed(options = {}) {
  return crawlLibrary({
    ...options,
    normalizeClip,
    fetchWorkspaces: (request) => fetchWorkspacesDetailed(options.token || null, request),
    fetchPage: (request) => fetchFeedPage({ ...request, token: options.token || null }),
    fetchLegacyPage: (request) => fetchLegacyFeedPage({ ...request, token: options.token || null })
  });
}

export async function fetchLibraryWithStats(options = {}) {
  return fetchLibraryDetailed(options);
}

export async function fetchLibrary(options = {}) {
  const result = await fetchLibraryDetailed(options);
  if (!result.complete) {
    const error = result.errors[0] || new FeedCrawlError("Library crawl was incomplete");
    error.partialResult = result;
    error.stats = result.stats;
    throw error;
  }
  return result.clips;
}

export async function probeFeedConnection(options = {}) {
  return probeFeed({
    ...options,
    fetchPage: (request) => fetchFeedPage({ ...request, token: options.token || null })
  });
}

export async function fetchClipFullMetadata(clipId, token = null) {
  const path = `/api/clips/get_songs_by_ids?ids=${encodeURIComponent(clipId)}`;
  const response = await pageFetch(`${API_BASE}${path}`, { token });
  if (!response.ok) throw await responseError(response, path);
  return response.json();
}
