const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10000;
const DEFAULT_REQUEST_PACING_MS = 1200;

function integerOption(value, fallback, minimum = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.floor(numeric)) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function createAbortError() {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted", "AbortError");
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

export function abortableDelay(ms, signal = null, wait = sleep) {
  throwIfAborted(signal);
  const duration = Math.max(0, Number(ms) || 0);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    function onAbort() {
      clearTimeout(timer);
      reject(createAbortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function raceWithAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  throwIfAborted(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([Promise.resolve(promise), aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

export function createRequestPacer(
  intervalMs = DEFAULT_REQUEST_PACING_MS,
  wait = abortableDelay,
  now = Date.now
) {
  const parsedInterval = Number(intervalMs);
  const interval = Number.isFinite(parsedInterval)
    ? Math.max(0, parsedInterval)
    : DEFAULT_REQUEST_PACING_MS;
  let nextRequestAt = 0;
  let tail = Promise.resolve();
  return {
    wait(signal = null) {
      const operation = tail.then(async () => {
        throwIfAborted(signal);
        const remaining = nextRequestAt - now();
        if (remaining > 0) await wait(remaining, signal);
        throwIfAborted(signal);
        nextRequestAt = now() + interval;
      });
      tail = operation.catch(() => {});
      return operation;
    }
  };
}

export class FeedCrawlError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "FeedCrawlError";
    Object.assign(this, details);
  }
}

function hasOwn(value, key) {
  return value != null && Object.prototype.hasOwnProperty.call(value, key);
}

function findValue(value, keys) {
  for (const key of keys) {
    if (hasOwn(value, key)) return { found: true, key, value: value[key] };
  }
  return { found: false };
}

function usableValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function tokenKey(value) {
  if (value === null) return "__null__";
  if (value === undefined) return "__undefined__";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return `${typeof value}:${String(value)}`;
}

function booleanFlag(value) {
  if (value === true || value === false) return value;
  if (value === 0 || value === 1) return value === 1;
  if (value == null || value === "") return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no", ""].includes(normalized)) return false;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  return undefined;
}

function unwrapResponse(response) {
  if (!response || Array.isArray(response) || typeof response !== "object") return response;
  const recognized =
    findValue(response, ["clips", "items", "next_cursor", "nextCursor", "next_page", "nextPage", "has_more", "hasMore"]).found;
  if (!recognized && response.data && typeof response.data === "object") return response.data;
  return response;
}

export function getFeedEntries(response) {
  const data = unwrapResponse(response);
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") {
    throw new FeedCrawlError("Feed response is not an object or array");
  }
  const clips = findValue(data, ["clips"]);
  if (clips.found) {
    if (Array.isArray(clips.value)) return clips.value;
    if (clips.value == null) return [];
    throw new FeedCrawlError("Feed response clips value is not an array");
  }
  const items = findValue(data, ["items"]);
  if (items.found) {
    if (Array.isArray(items.value)) return items.value;
    if (items.value == null) return [];
    throw new FeedCrawlError("Feed response items value is not an array");
  }
  throw new FeedCrawlError("Feed response does not contain a clips or items array");
}

export function flattenFeedClips(entries) {
  const flattened = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry && Array.isArray(entry.clips)) {
      for (const child of entry.clips) {
        if (child != null) flattened.push(child);
      }
      continue;
    }
    if (entry != null) flattened.push(entry);
  }
  return flattened;
}

function expectedResultCount(data) {
  const total = findValue(data, ["num_total_results", "total_count", "totalCount", "total"]);
  if (!total.found || total.value == null || total.value === "") return null;
  const numeric = Number(total.value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

export function getFeedPaginationState(
  response,
  {
    mode = "cursor",
    currentCursor = null,
    currentPage = null,
    pageSize = DEFAULT_PAGE_SIZE,
    itemCount = 0,
    collectedCount = itemCount,
    enforceExpectedTotal = true
  } = {}
) {
  const data = unwrapResponse(response);
  const hasMore = findValue(data, ["has_more", "hasMore"]);
  let more;
  if (hasMore.found) {
    more = booleanFlag(hasMore.value);
    if (more === undefined) {
      return { done: false, error: `Unrecognized has_more value: ${String(hasMore.value)}` };
    }
  }

  const cursor = findValue(data, ["next_cursor", "nextCursor"]);
  const page = findValue(data, ["next_page", "nextPage"]);
  const expectedTotal = expectedResultCount(data);
  const count = Math.max(0, Number(itemCount) || 0);
  const collected = Math.max(count, Number(collectedCount) || 0);
  const targetReached = enforceExpectedTotal && expectedTotal !== null && collected >= expectedTotal;
  const expectedTotalUnreached = enforceExpectedTotal && expectedTotal !== null && collected < expectedTotal;
  const base = { expectedTotal };

  if (more === false) {
    return expectedTotalUnreached
      ? { ...base, done: false, error: `Feed ended at ${collected} of ${expectedTotal} results` }
      : { ...base, done: true, nextCursor: null, nextPage: null };
  }

  if (mode === "cursor") {
    if (cursor.found) {
      if (!usableValue(cursor.value)) {
        return more === true
          ? { ...base, done: false, error: "has_more is true but next_cursor is empty" }
          : { ...base, done: true, nextCursor: null, nextPage: null };
      }
      return { ...base, done: false, nextCursor: cursor.value, nextPage: null };
    }
    if (page.found) {
      if (!usableValue(page.value)) {
        return more === true
          ? { ...base, done: false, error: "has_more is true but next_page is empty" }
          : { ...base, done: true, nextCursor: null, nextPage: null };
      }
      const numericPage = Number(page.value);
      if (Number.isInteger(numericPage) && numericPage > 0) {
        return { ...base, done: false, nextCursor: null, nextPage: numericPage };
      }
      return more === true
        ? { ...base, done: false, error: `Invalid next_page value: ${String(page.value)}` }
        : { ...base, done: true, nextCursor: null, nextPage: null };
    }
    if (more === true) {
      return { ...base, done: false, error: "has_more is true but no next cursor or page is present" };
    }
    if (targetReached) return { ...base, done: true, nextCursor: null, nextPage: null };
    if (count === 0) {
      return expectedTotalUnreached
        ? { ...base, done: false, error: `Feed ended at ${collected} of ${expectedTotal} results` }
        : { ...base, done: true, nextCursor: null, nextPage: null };
    }
    if (expectedTotalUnreached) {
      return { ...base, done: false, error: `Feed ended at ${collected} of ${expectedTotal} results` };
    }
    if (count < pageSize) return { ...base, done: true, nextCursor: null, nextPage: null };
    return { ...base, done: false, error: "Cursor page ended without a next cursor" };
  }

  if (page.found) {
    if (!usableValue(page.value)) {
      return more === true
        ? { ...base, done: false, error: "has_more is true but next_page is empty" }
        : { ...base, done: true, nextCursor: null, nextPage: null };
    }
    const numericPage = Number(page.value);
    if (!Number.isInteger(numericPage) || numericPage <= 0) {
      return more === true
        ? { ...base, done: false, error: `Invalid next_page value: ${String(page.value)}` }
        : { ...base, done: true, nextCursor: null, nextPage: null };
    }
    return { ...base, done: false, nextCursor: null, nextPage: numericPage };
  }
  if (cursor.found) {
    if (!usableValue(cursor.value)) {
      return more === true
        ? { ...base, done: false, error: "has_more is true but next_cursor is empty" }
        : { ...base, done: true, nextCursor: null, nextPage: null };
    }
    return { ...base, done: false, error: "Legacy page response has next_cursor but no next_page" };
  }
  const reportedPage = findValue(data, ["current_page", "currentPage"]);
  const reportedNumericPage = Number(reportedPage.value);
  const numericCurrentPage = Number(currentPage);
  if (!Number.isInteger(numericCurrentPage) || numericCurrentPage <= 0) {
    return { ...base, done: false, error: "Legacy pagination has no valid current page" };
  }
  if (targetReached) return { ...base, done: true, nextCursor: null, nextPage: null };
  if (count === 0) {
    return expectedTotalUnreached
      ? { ...base, done: false, error: `Feed ended at ${collected} of ${expectedTotal} results` }
      : { ...base, done: true, nextCursor: null, nextPage: null };
  }
  if (!hasMore.found && expectedTotal === null && count < pageSize) {
    return { ...base, done: true, nextCursor: null, nextPage: null };
  }
  const nextPage = reportedPage.found && Number.isInteger(reportedNumericPage) && reportedNumericPage > 0
    ? reportedNumericPage + 1
    : numericCurrentPage + 1;
  return { ...base, done: false, nextCursor: null, nextPage };
}

function emptySourceStats() {
  return {
    pagesFetched: 0,
    rawEntries: 0,
    flattenedClips: 0,
    uniqueClips: 0,
    duplicateClips: 0,
    filteredClips: 0,
    invalidClips: 0,
    addedClips: 0,
    retries: 0,
    attempts: 0,
    expectedTotal: null,
    collectedEntries: 0
  };
}

function errorWithContext(error, context) {
  const result = error instanceof Error ? error : new FeedCrawlError(String(error));
  result.crawlContext = { ...(result.crawlContext || {}), ...context };
  return result;
}

function defaultNormalize(raw) {
  return raw?.id ? { ...raw } : null;
}

export async function crawlLibraryDetailed(options = {}) {
  const started = new Date();
  const normalize = options.normalizeClip || defaultNormalize;
  const fetchPage = options.fetchPage;
  const fetchLegacyPage = options.fetchLegacyPage;
  const fetchWorkspaces = options.fetchWorkspaces;
  const signal = options.signal || null;
  const includeLegacyFeed = options.includeLegacyFeed ?? options.mergeLegacyFeed ?? options.includeLegacy ?? false;
  const limit = integerOption(options.limit, DEFAULT_PAGE_SIZE);
  const maxPages = integerOption(options.maxPages, DEFAULT_MAX_PAGES);
  const requestedWorkspace = options.workspaceId == null || options.workspaceId === ""
    ? "all"
    : String(options.workspaceId);
  const allWorkspaces = requestedWorkspace.toLowerCase() === "all";
  const pacingOption = options.requestPacingMs ?? options.rateLimitMs;
  const requestPacingMs = pacingOption == null
    ? DEFAULT_REQUEST_PACING_MS
    : Math.max(0, Number(pacingOption) || 0);
  const includeTrashed = options.includeTrashed === true;
  const explicitTrashed = options.trashed === true || options.trashed === "True" || options.trashed === 1 || options.trashed === "1";
  const trashedFilter = includeTrashed ? (explicitTrashed ? "True" : null) : "False";
  const beforeRequest = options.beforeRequest || createRequestPacer(requestPacingMs, abortableDelay).wait;
  const clips = [];
  const seenIds = new Set();
  const errors = [];
  const sources = [];
  const workspaces = [];
  const stats = {
    ...emptySourceStats(),
    elapsedMs: 0,
    workspacePagesFetched: 0,
    workspaceDiscovery: allWorkspaces ? null : "not-required",
    workspacesRequested: allWorkspaces ? null : 1,
    workspacesDiscovered: 0,
    workspacesCrawled: 0,
    workspacesFailed: 0,
    partial: false,
    errors: [],
    coverage: {
      complete: false,
      sources: []
    },
    legacy: {
      enabled: allWorkspaces && includeLegacyFeed === true,
      pagesFetched: 0,
      complete: null
    }
  };

  const result = {
    complete: true,
    partial: false,
    clips,
    workspaces,
    sources,
    coverage: stats.coverage,
    errors,
    stats,
    startedAt: started.toISOString(),
    finishedAt: null
  };

  if (typeof fetchPage !== "function") throw new TypeError("fetchPage is required");
  if (allWorkspaces && includeLegacyFeed === true && typeof fetchLegacyPage !== "function") {
    throw new TypeError("fetchLegacyPage is required when legacy feed merging is enabled");
  }

  if (allWorkspaces) {
    let discovery;
    const providedProjects = Array.isArray(options.workspaces)
      ? options.workspaces
      : options.workspaces?.projects;
    const hasUsableProvidedWorkspaces = Array.isArray(providedProjects)
      ? providedProjects.length > 0
      : options.workspaces != null;
    if (hasUsableProvidedWorkspaces) {
      discovery = Array.isArray(options.workspaces)
        ? { projects: options.workspaces, complete: true }
        : options.workspaces;
      stats.workspaceDiscovery = "provided";
    } else {
      if (typeof fetchWorkspaces !== "function") {
        throw new TypeError("fetchWorkspaces is required for all-workspace crawls");
      }
      try {
        discovery = await fetchWorkspaces({
          token: options.token || null,
          signal,
          beforeRequest,
          onAttempt: () => {
            stats.attempts++;
          },
          onRetry: (event) => {
            stats.retries++;
            options.onRetry?.(event);
          }
        });
      } catch (error) {
        throwIfAborted(signal);
        errors.push(errorWithContext(error, { source: "workspaces" }));
        result.complete = false;
        discovery = { projects: [], complete: false };
      }
      stats.workspaceDiscovery = "fetched";
    }
    if (Array.isArray(discovery)) discovery = { projects: discovery, complete: true };
    const discovered = Array.isArray(discovery?.projects)
      ? discovery.projects
      : Array.isArray(discovery?.workspaces)
        ? discovery.workspaces
        : [];
    stats.workspacePagesFetched = Number(discovery?.stats?.pagesFetched) || 0;
    stats.workspaceExpectedTotal = Number(discovery?.stats?.expectedTotal) || null;
    stats.workspacesDiscovered = discovered.length;
    const reported = discovered.reduce((sum, project) => {
      const value = Number(project?.clipCount ?? project?.clip_count ?? project?.count);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
    if (reported > 0) {
      stats.expectedCount = reported;
      stats.reportedCount = reported;
    }
    if (discovery?.complete === false) result.complete = false;
    for (const error of discovery?.errors || []) {
      errors.push(errorWithContext(error, { source: "workspaces" }));
    }
    const defaultProject = discovered.find((project) => String(project?.id ?? project?.project_id ?? "") === "default");
    const workspaceIds = new Set(["default"]);
    workspaces.push({ id: "default", name: defaultProject?.name || defaultProject?.title || "Default" });
    for (const project of discovered) {
      const id = project?.id ?? project?.project_id ?? project?.uuid;
      if (id == null || id === "" || workspaceIds.has(String(id))) continue;
      const normalizedId = String(id);
      workspaceIds.add(normalizedId);
      workspaces.push({ id: normalizedId, name: project?.name || project?.title || normalizedId });
    }
    stats.workspacesRequested = workspaces.length;
  } else {
    workspaces.push({
      id: requestedWorkspace || "default",
      name: options.workspaceName || requestedWorkspace || "default"
    });
    stats.workspacesDiscovered = 1;
  }

  const ingest = (rawClips, source, context) => {
    const flattened = flattenFeedClips(rawClips);
    source.stats.rawEntries += rawClips.length;
    source.stats.flattenedClips += flattened.length;
    source.stats.collectedEntries += flattened.length;
    stats.collectedEntries += flattened.length;
    stats.rawEntries += rawClips.length;
    stats.flattenedClips += flattened.length;
    for (const raw of flattened) {
      let normalized;
      try {
        normalized = normalize(raw, source.type === "v3" ? source.workspaceId : null);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        normalized = null;
        source.stats.invalidClips++;
        stats.invalidClips++;
        source.invalid = true;
        result.complete = false;
        errors.push(errorWithContext(error, { source: source.type, workspaceId: source.workspaceId }));
        continue;
      }
      if (!normalized || normalized.id == null || normalized.id === "") {
        source.stats.invalidClips++;
        stats.invalidClips++;
        source.invalid = true;
        result.complete = false;
        errors.push(new FeedCrawlError(`Invalid clip row in ${source.type} response`, { source: source.type, workspaceId: source.workspaceId }));
        continue;
      }
      if (source.type === "v3" && !normalized.workspace_id && source.workspaceId) {
        normalized.workspace_id = source.workspaceId;
      }
      if (source.type === "legacy" && !normalized.workspace_id) normalized.workspace_id = "default";
      const id = String(normalized.id);
      if (seenIds.has(id)) {
        source.stats.duplicateClips++;
        stats.duplicateClips++;
        continue;
      }
      seenIds.add(id);
      source.stats.uniqueClips++;
      stats.uniqueClips++;
      if (options.includeDisliked === false && normalized.is_disliked === true) {
        source.stats.filteredClips++;
        stats.filteredClips++;
        continue;
      }
      if (options.includeTrashed !== true && normalized.is_trashed === true) {
        source.stats.filteredClips++;
        stats.filteredClips++;
        continue;
      }
      if (options.includeUploads === false && normalized.is_upload === true) {
        source.stats.filteredClips++;
        stats.filteredClips++;
        continue;
      }
      if (options.likedOnly === true && normalized.is_liked !== true) {
        source.stats.filteredClips++;
        stats.filteredClips++;
        continue;
      }
      clips.push(normalized);
      source.stats.addedClips++;
      stats.addedClips++;
    }
    const total = clips.length;
    const progress = {
      type: source.type,
      phase: "page",
      workspaceId: source.workspaceId,
      workspace: source.workspaceId || "legacy",
      page: context.page,
      pageCount: source.pagesFetched,
      cursor: context.cursor,
      rawCount: rawClips.length,
      flattenedCount: flattened.length,
      added: source.stats.addedClips,
      addedCount: source.stats.addedClips,
      total,
      percent: source.stats.expectedTotal ? Math.min(100, Math.round((total / source.stats.expectedTotal) * 100)) : 0,
      complete: false
    };
    Object.defineProperties(progress, {
      valueOf: { value: () => total },
      toString: { value: () => String(total) }
    });
    throwIfAborted(signal);
    options.onProgress?.(progress, context.key, rawClips.length, progress);
    throwIfAborted(signal);
  };

  const crawlSource = async ({ type, workspaceId }) => {
    const source = {
      type,
      workspaceId,
      complete: false,
      pagesFetched: 0,
      stats: emptySourceStats()
    };
    sources.push(source);
    let token = type === "v3" ? null : 1;
    const seenTokens = new Set();
    while (source.pagesFetched < maxPages) {
      throwIfAborted(signal);
      const currentKey = type === "v3"
        ? token === null ? "__first_page__" : String(token)
        : `page_${token}`;
      const currentTokenKey = `${type}:${workspaceId || "legacy"}:${tokenKey(token)}`;
      if (seenTokens.has(currentTokenKey)) {
        const error = new FeedCrawlError(`Repeated ${type} pagination token`, {
          source: type,
          workspaceId,
          token
        });
        source.error = error;
        errors.push(errorWithContext(error, { source: type, workspaceId, token }));
        result.complete = false;
        return source;
      }
      seenTokens.add(currentTokenKey);
      let response;
      try {
        const request = {
          token: options.token || null,
          signal,
          beforeRequest,
          limit,
          workspaceId,
          disliked: options.includeDisliked === false || (options.includeDisliked == null && options.ignoreDisliked === true) ? "False" : null,
          trashed: trashedFilter,
          onAttempt: () => {
            source.stats.attempts++;
            stats.attempts++;
          },
          onRetry: (event) => {
            source.stats.retries++;
            stats.retries++;
            options.onRetry?.(event);
          }
        };
        response = type === "v3"
          ? await fetchPage({ ...request, cursor: token })
          : await fetchLegacyPage({ ...request, page: token });
      } catch (error) {
        throwIfAborted(signal);
        source.error = errorWithContext(error, {
          source: type,
          workspaceId,
          token,
          page: type === "legacy" ? token : null,
          cursor: type === "v3" ? token : null
        });
        errors.push(source.error);
        result.complete = false;
        return source;
      }
      let rawClips;
      let state;
      try {
        rawClips = getFeedEntries(response);
        const flattenedCount = flattenFeedClips(rawClips).length;
        state = getFeedPaginationState(response, {
          mode: type === "v3" ? "cursor" : "legacy",
          currentCursor: token,
          currentPage: type === "legacy" ? token : null,
          pageSize: type === "legacy" ? 1 : limit,
          itemCount: flattenedCount,
          collectedCount: source.stats.collectedEntries + flattenedCount,
          enforceExpectedTotal: true
        });
        if (state.error) throw new FeedCrawlError(state.error);
      } catch (error) {
        source.error = errorWithContext(error, {
          source: type,
          workspaceId,
          token,
          page: type === "legacy" ? token : null,
          cursor: type === "v3" ? token : null
        });
        errors.push(source.error);
        result.complete = false;
        return source;
      }
      source.pagesFetched++;
      source.stats.pagesFetched++;
      stats.pagesFetched++;
      if (type === "legacy") stats.legacy.pagesFetched++;
      if (state.expectedTotal !== null && state.expectedTotal !== undefined) {
        source.stats.expectedTotal = state.expectedTotal;
      }
      ingest(rawClips, source, {
        page: type === "legacy" ? token : source.pagesFetched,
        cursor: type === "v3" ? token : null,
        key: `${workspaceId || "legacy"}::${currentKey}`
      });
      throwIfAborted(signal);
      if (state.done) {
        source.complete = !source.invalid;
        if (type === "v3" && source.complete) stats.workspacesCrawled++;
        if (type === "legacy" && source.complete) stats.legacy.complete = true;
        return source;
      }
      const nextToken = type === "v3" ? state.nextCursor ?? state.nextPage : state.nextPage;
      const nextKey = tokenKey(nextToken);
      if (seenTokens.has(`${type}:${workspaceId || "legacy"}:${nextKey}`)) {
        const error = new FeedCrawlError(`Repeated ${type} pagination token`, {
          source: type,
          workspaceId,
          token: nextToken
        });
        source.error = error;
        errors.push(errorWithContext(error, { source: type, workspaceId, token: nextToken }));
        result.complete = false;
        return source;
      }
      token = nextToken;
    }
    const error = new FeedCrawlError(`${type} pagination exceeded ${maxPages} pages`, {
      source: type,
      workspaceId
    });
    source.error = error;
    errors.push(errorWithContext(error, { source: type, workspaceId }));
    result.complete = false;
    return source;
  };

  for (const workspace of workspaces) {
    const source = await crawlSource({ type: "v3", workspaceId: workspace.id });
    if (!source.complete) stats.workspacesFailed++;
  }

  if (stats.legacy.enabled) {
    await crawlSource({ type: "legacy", workspaceId: null });
  }

  const finished = new Date();
  result.complete = errors.length === 0 && result.complete;
  result.partial = !result.complete;
  result.finishedAt = finished.toISOString();
  stats.elapsedMs = finished.getTime() - started.getTime();
  stats.totalRequests = stats.workspacePagesFetched + stats.pagesFetched;
  stats.totalAttempts = stats.attempts || stats.totalRequests + stats.retries;
  stats.partial = result.partial;
  stats.errors = errors.map((error) => error.message || String(error));
  stats.coverage.sources = sources.map((source) => ({
    type: source.type,
    workspaceId: source.workspaceId,
    complete: source.complete,
    pagesFetched: source.pagesFetched,
    collectedEntries: source.stats.collectedEntries,
    expectedTotal: source.stats.expectedTotal,
    uniqueClips: source.stats.uniqueClips,
    addedClips: source.stats.addedClips
  }));
  stats.coverage.complete = result.complete;
  if (stats.legacy.enabled && stats.legacy.complete === null) stats.legacy.complete = false;
  const finalProgress = {
    type: "summary",
    phase: result.complete ? "complete" : "partial",
    page: null,
    workspace: null,
    pageCount: stats.pagesFetched,
    total: clips.length,
    added: stats.addedClips,
    addedCount: stats.addedClips,
    percent: result.complete ? 100 : 0,
    complete: result.complete,
    errors: stats.errors
  };
  Object.defineProperties(finalProgress, {
    valueOf: { value: () => clips.length },
    toString: { value: () => String(clips.length) }
  });
  options.onProgress?.(finalProgress, "summary", 0, finalProgress);
  throwIfAborted(signal);
  return result;
}

export async function probeFeedConnection(options = {}) {
  throwIfAborted(options.signal);
  if (typeof options.fetchPage !== "function") throw new TypeError("fetchPage is required");
  const started = Date.now();
  const limit = integerOption(options.limit, 1);
  const workspaceId = options.workspaceId == null || options.workspaceId === "all"
    ? "default"
    : String(options.workspaceId);
  const response = await options.fetchPage({
    token: options.token || null,
    signal: options.signal || null,
    beforeRequest: options.beforeRequest,
    cursor: null,
    limit,
    workspaceId,
    trashed: "False"
  });
  const rawClips = getFeedEntries(response);
  return {
    ok: true,
    workspaceId,
    clipCount: flattenFeedClips(rawClips).length,
    latencyMs: Date.now() - started
  };
}
