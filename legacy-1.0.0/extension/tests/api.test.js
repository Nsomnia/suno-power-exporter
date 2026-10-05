import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchFeedPage,
  fetchLibrary,
  fetchLibraryDetailed,
  fetchWorkspacesDetailed,
  pageFetch,
  probeFeedConnection,
  parseRetryAfter
} from "../lib/api.js";

function installChrome(responses) {
  let calls = 0;
  const requests = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ __sppe_device_id: "device-id" }),
        set: async () => {}
      }
    },
    runtime: {
      sendMessage: async (message) => {
        requests.push(message.payload);
        const response = responses[Math.min(calls, responses.length - 1)];
        calls++;
        return response;
      }
    }
  };
  const getCalls = () => calls;
  getCalls.requests = requests;
  return getCalls;
}

test("parses Retry-After seconds and HTTP dates", () => {
  const now = Date.parse("Thu, 24 Sep 2026 00:00:00 GMT");
  assert.equal(parseRetryAfter("3", now), 3000);
  assert.equal(parseRetryAfter("Thu, 24 Sep 2026 00:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("", now), null);
});

test("retries a 503 using Retry-After before returning success", async () => {
  const getCalls = installChrome([
    { __status: 503, __headers: { "Retry-After": "0" }, __body: "{}" },
    { __status: 200, __headers: {}, __body: '{"ok":true}' }
  ]);
  const retries = [];

  const response = await pageFetch("https://example.test/feed", {
    token: "Bearer test",
    retries: 1,
    onRetry: (event) => retries.push(event)
  });

  assert.equal(response.status, 200);
  assert.equal(response.attempts, 2);
  assert.equal(getCalls(), 2);
  assert.equal(retries[0].retryAfterMs, 0);
  assert.equal(retries[0].waitMs, 0);
});

test("retries a 429 using Retry-After before returning success", async () => {
  const getCalls = installChrome([
    { __status: 429, __headers: { "retry-after": "0" }, __body: "{}" },
    { __status: 200, __headers: {}, __body: "{}" }
  ]);

  const response = await pageFetch("https://example.test/feed", {
    token: "Bearer test",
    retries: 1
  });

  assert.equal(response.status, 200);
  assert.equal(getCalls(), 2);
});

test("retries transport and 500 failures and counts attempts", async () => {
  const getCalls = installChrome([
    { __status: 0, __headers: {}, __error: "offline" },
    { __status: 500, __headers: { "retry-after": "0" }, __body: "{}" },
    { __status: 200, __headers: {}, __body: "{}" }
  ]);
  const response = await pageFetch("https://example.test/feed", {
    token: "Bearer test",
    retries: 2
  });
  assert.equal(response.status, 200);
  assert.equal(response.attempts, 3);
  assert.equal(getCalls(), 3);
});

test("workspace pagination uses current_page and num_total_results", async () => {
  const getCalls = installChrome([
    {
      __status: 200,
      __headers: {},
      __body: JSON.stringify({
        current_page: 1,
        num_total_results: 2,
        projects: [{ id: "one", name: "One" }]
      })
    },
    {
      __status: 200,
      __headers: {},
      __body: JSON.stringify({
        current_page: 2,
        num_total_results: 2,
        projects: [{ id: "two", name: "Two" }]
      })
    }
  ]);

  const result = await fetchWorkspacesDetailed("Bearer test", { requestPacingMs: 0 });

  assert.equal(result.complete, true);
  assert.equal(getCalls(), 2);
  assert.deepEqual(result.projects.map((project) => project.id), ["one", "two"]);
  assert.equal(result.stats.expectedTotal, 2);
});

test("discovers and drains all project pages before crawling every workspace", async () => {
  const responses = [];
  for (let page = 1; page <= 3; page += 1) {
    const size = page < 3 ? 20 : 15;
    responses.push({
      __status: 200,
      __headers: {},
      __body: JSON.stringify({
        current_page: page,
        num_total_results: 55,
        projects: Array.from({ length: size }, (_, index) => ({
          id: page === 1 && index === 0 ? "default" : `p${page}-${index}`,
          name: `Project ${page}-${index}`,
          clip_count: 1
        }))
      })
    });
  }
  for (let index = 0; index < 55; index += 1) {
    responses.push({
      __status: 200,
      __headers: {},
      __body: JSON.stringify({
        clips: [{ id: `clip-${index}` }],
        has_more: false
      })
    });
  }
  const getCalls = installChrome(responses);
  const result = await fetchLibraryDetailed({
    workspaceId: "all",
    includeUploads: true,
    includeDisliked: true,
    token: "Bearer test",
    requestPacingMs: 0
  });
  assert.equal(result.complete, true);
  assert.equal(result.workspaces.length, 55);
  assert.equal(result.clips.length, 55);
  assert.equal(getCalls(), 58);
});

test("detailed library sync accepts provided workspaces and preserves normalized metadata", async () => {
  installChrome([
    {
      __status: 200,
      __headers: {},
      __body: JSON.stringify({
        clips: [{ id: "default-track", metadata: { prompt: "default prompt" } }],
        has_more: false
      })
    },
    {
      __status: 200,
      __headers: {},
      __body: JSON.stringify({
        clips: [{
          id: "workspace-track",
          display_name: "Child Artist",
          metadata: { tags: ["test"], prompt: "workspace prompt" }
        }],
        has_more: false
      })
    }
  ]);

  const result = await fetchLibraryDetailed({
    workspaceId: "all",
    workspaces: [{ id: "workspace-one", name: "Workspace One" }],
    includeUploads: true,
    token: "Bearer test",
    requestPacingMs: 0
  });

  assert.equal(result.complete, true);
  assert.equal(result.workspaces.length, 2);
  assert.deepEqual(result.clips.map((clip) => clip.workspace_id), ["default", "workspace-one"]);
  assert.equal(result.clips[0].metadata.prompt, "default prompt");
  assert.equal(result.clips[1].display_name, "Child Artist");
  assert.deepEqual(result.clips[1].metadata.tags, ["test"]);
});

test("serializes explicit disliked and trashed filters consistently", async () => {
  const getCalls = installChrome([
    { __status: 200, __headers: {}, __body: JSON.stringify({ clips: [{ id: "default" }], has_more: false }) },
    { __status: 200, __headers: {}, __body: JSON.stringify({ clips: [{ id: "workspace" }], has_more: false }) }
  ]);
  await fetchLibraryDetailed({
    workspaceId: "all",
    workspaces: [{ id: "default" }, { id: "workspace" }],
    includeDisliked: true,
    includeTrashed: true,
    trashed: true,
    token: "Bearer test",
    requestPacingMs: 0
  });
  const bodies = getCalls.requests.filter((request) => request.url.endsWith("/api/feed/v3")).map((request) => JSON.parse(request.body));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].filters.disliked, undefined);
  assert.equal(bodies[0].filters.trashed, "True");
});

test("connection probe makes one limit-one feed request", async () => {
  const getCalls = installChrome([
    {
      __status: 200,
      __headers: {},
      __body: JSON.stringify({ clips: [{ id: "probe" }], has_more: true, next_cursor: "more" })
    }
  ]);

  const result = await probeFeedConnection({ token: "Bearer test" });

  assert.equal(result.ok, true);
  assert.equal(result.clipCount, 1);
  assert.equal(getCalls(), 1);
  assert.equal(getCalls.requests[0].url.endsWith("/api/feed/v3"), true);
  assert.equal(JSON.parse(getCalls.requests[0].body).limit, 1);
});

test("surfaces a final non-2xx feed response", async () => {
  installChrome([
    { __status: 500, __headers: { "retry-after": "0" }, __body: '{"error":"failed"}' }
  ]);

  await assert.rejects(
    fetchFeedPage({ token: "Bearer test", workspaceId: "default" }),
    (error) => error.status === 500 && error.data.error === "failed"
  );
});

test("legacy feed non-2xx marks all-workspace sync partial", async () => {
  installChrome([
    {
      __status: 200,
      __headers: {},
      __body: JSON.stringify({ clips: [{ id: "default-track" }], has_more: false })
    },
    { __status: 500, __headers: {}, __body: '{"error":"legacy failed"}' }
  ]);

  const result = await fetchLibraryDetailed({
    workspaceId: "all",
    workspaces: [{ id: "default", name: "Default" }],
    includeLegacyFeed: true,
    token: "Bearer test",
    requestPacingMs: 0
  });

  assert.equal(result.complete, false);
  assert.equal(result.errors[0].status, 500);
  assert.equal(result.sources[1].type, "legacy");
  assert.equal(result.sources[1].complete, false);
});

test("fetchLibrary rejects an incomplete crawl instead of returning partial clips", async () => {
  installChrome([
    { __status: 503, __headers: { "retry-after": "0" }, __body: "{}" }
  ]);

  await assert.rejects(
    fetchLibrary({
      workspaceId: "default",
      token: "Bearer test",
      requestPacingMs: 0
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.partialResult.complete, false);
      assert.equal(error.partialResult.clips.length, 0);
      assert.equal(error.partialResult.partial, true);
      return true;
    }
  );
});

test("pageFetch rejects promptly when aborted", async () => {
  installChrome([]);
  globalThis.chrome.runtime.sendMessage = () => new Promise(() => {});
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);

  await assert.rejects(
    pageFetch("https://example.test/feed", {
      token: "Bearer test",
      signal: controller.signal
    }),
    (error) => error.name === "AbortError"
  );
});
