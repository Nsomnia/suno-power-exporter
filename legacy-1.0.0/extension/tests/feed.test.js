import test from "node:test";
import assert from "node:assert/strict";
import {
  createRequestPacer,
  crawlLibraryDetailed,
  flattenFeedClips,
  getFeedPaginationState,
  probeFeedConnection
} from "../lib/feed.js";

function normalize(raw) {
  if (!raw?.id) return null;
  return {
    id: String(raw.id),
    is_liked: raw.is_liked === true,
    is_disliked: raw.is_disliked === true,
    is_upload: raw.is_audio_upload === true,
    raw
  };
}

test("crawls cursor pages, flattens child clips, preserves metadata, and deduplicates IDs", async () => {
  const first = { id: "one", title: "First", metadata: { prompt: "first prompt" } };
  const second = { id: "two", title: "Second", metadata: { prompt: "second prompt" } };
  const third = { id: "three", title: "Third", metadata: { prompt: "third prompt" } };
  const responses = new Map([
    [null, { clips: [{ clips: [first, second] }], next_cursor: "next", has_more: true }],
    ["next", { clips: [first, third], next_cursor: "", has_more: false }]
  ]);
  let requests = 0;

  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async ({ cursor }) => {
      requests++;
      return responses.get(cursor);
    }
  });

  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(requests, 2);
  assert.deepEqual(result.clips.map((clip) => clip.id), ["one", "two", "three"]);
  assert.equal(result.clips[0].raw, first);
  assert.equal(result.clips[0].raw.metadata.prompt, "first prompt");
  assert.equal(result.stats.duplicateClips, 1);
  assert.equal(result.stats.workspacesCrawled, 1);
});

test("treats zero and empty terminal pagination values as complete", async () => {
  let requests = 0;
  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async () => {
      requests++;
      return { clips: [{ id: "one" }], next_cursor: "", has_more: 0 };
    }
  });

  assert.equal(result.complete, true);
  assert.equal(requests, 1);
  assert.equal(result.clips.length, 1);
});

test("cursor crawl also follows a valid next_page value", async () => {
  const requests = [];
  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    limit: 1,
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async ({ cursor }) => {
      requests.push(cursor);
      if (cursor === null) {
        return { clips: [{ id: "one" }], next_page: 2, has_more: true };
      }
      return { clips: [{ id: "two" }], next_page: 0, has_more: false };
    }
  });

  assert.equal(result.complete, true);
  assert.deepEqual(requests, [null, 2]);
});

test("stops a legacy-style crawl on a short page when no total is advertised", () => {
  const state = getFeedPaginationState({ current_page: 1, projects: [{ id: "one" }] }, {
    mode: "legacy",
    currentPage: 1,
    pageSize: 20,
    itemCount: 1,
    collectedCount: 1
  });
  assert.equal(state.done, true);
  assert.equal(state.error, undefined);
});

test("marks a repeated cursor as an incomplete crawl", async () => {
  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async () => ({ clips: [{ id: "one" }], next_cursor: "same", has_more: true })
  });

  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.match(result.errors[0].message, /Repeated v3 pagination token/);
});

test("uses a full final cursor page with a zero next cursor and satisfied total", async () => {
  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    limit: 1,
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async () => ({
      clips: [{ id: "one" }],
      next_cursor: null,
      num_total_results: 1
    })
  });

  assert.equal(result.complete, true);
  assert.equal(result.sources[0].stats.expectedTotal, 1);
});

test("crawls provided workspaces and merges the legacy feed for all-workspace sync", async () => {
  const legacyFirst = { id: "legacy-one", title: "Legacy" };
  const v3Calls = [];
  const legacyCalls = [];

  const result = await crawlLibraryDetailed({
    workspaceId: "all",
    workspaces: [{ id: "workspace-one", name: "Workspace One" }],
    includeLegacyFeed: true,
    includeUploads: true,
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async ({ workspaceId }) => {
      v3Calls.push(workspaceId);
      return {
        clips: [{ id: `${workspaceId}-clip` }],
        next_cursor: null,
        has_more: false
      };
    },
    fetchLegacyPage: async ({ page }) => {
      legacyCalls.push(page);
      if (page === 1) {
        return {
          clips: [{ clips: [{ id: "default-clip" }, legacyFirst] }],
          next_page: 2
        };
      }
      return { clips: [], next_page: null, has_more: false };
    }
  });

  assert.equal(result.complete, true);
  assert.deepEqual(v3Calls, ["default", "workspace-one"]);
  assert.deepEqual(legacyCalls, [1, 2]);
  assert.deepEqual(result.clips.map((clip) => clip.id), [
    "default-clip",
    "workspace-one-clip",
    "legacy-one"
  ]);
  assert.equal(result.stats.legacy.complete, true);
});

test("includeUploads false excludes uploads from the default workspace", async () => {
  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    includeUploads: false,
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async () => ({
      clips: [
        { id: "upload", is_audio_upload: true },
        { id: "generated" }
      ],
      has_more: false
    })
  });

  assert.equal(result.complete, true);
  assert.deepEqual(result.clips.map((clip) => clip.id), ["generated"]);
  assert.equal(result.stats.filteredClips, 1);
});

test("returns diagnostics instead of claiming a failed source completed", async () => {
  const failure = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    requestPacingMs: 0,
    normalizeClip: normalize,
    fetchPage: async () => {
      throw failure;
    }
  });

  assert.equal(result.complete, false);
  assert.equal(result.clips.length, 0);
  assert.equal(result.errors[0], failure);
  assert.equal(result.errors[0].status, 503);
  assert.equal(result.stats.partial, true);
});

test("marks a throwing normalizer as partial with one invalid row", async () => {
  const result = await crawlLibraryDetailed({
    workspaceId: "default",
    requestPacingMs: 0,
    normalizeClip: () => { throw new Error("bad row"); },
    fetchPage: async () => ({ clips: [{ id: "bad" }], has_more: false })
  });
  assert.equal(result.complete, false);
  assert.equal(result.stats.invalidClips, 1);
  assert.equal(result.errors.length, 1);
});

test("probes exactly one page and flattens its sample", async () => {
  let requests = 0;
  const result = await probeFeedConnection({
    workspaceId: "default",
    limit: 1,
    fetchPage: async () => {
      requests++;
      return { clips: [{ clips: [{ id: "one" }, { id: "two" }] }], next_cursor: "more" };
    }
  });

  assert.equal(requests, 1);
  assert.equal(result.ok, true);
  assert.equal(result.clipCount, 2);
});

test("honors an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    crawlLibraryDetailed({
      workspaceId: "default",
      signal: controller.signal,
      fetchPage: async () => ({ clips: [] })
    }),
    (error) => error.name === "AbortError"
  );
});

test("request pacer globally spaces concurrent requests", async () => {
  let now = 0;
  const waits = [];
  const pacer = createRequestPacer(100, async (ms) => {
    waits.push(ms);
    now += ms;
  }, () => now);

  await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);

  assert.deepEqual(waits, [100, 100]);
});

test("legacy semantics replace a clip wrapper with its child array", () => {
  const child = { id: "child" };
  assert.deepEqual(flattenFeedClips([{ id: "parent", clips: [child] }]), [child]);
  assert.deepEqual(flattenFeedClips([{ id: "parent", clips: [] }]), []);
});
