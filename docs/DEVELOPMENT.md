# Development

## Requirements

- Node.js with ES module support.
- A Chromium browser with Manifest V3 and Developer Mode.
- A signed-in Suno tab for manual integration testing.

## Local checks

Run all automated checks from the extension directory:

```bash
cd extension
npm test
npm run check
```

The test suite is intentionally dependency-free. It covers:

- workspace page and total handling;
- feed cursor, zero-value, and repeated-token behavior;
- nested feed wrappers and deduplication;
- disliked/trashed/upload filter semantics;
- retry and Retry-After handling;
- cancellation before, during, and after progress;
- settings and legacy-storage migration;
- IndexedDB directory-handle persistence;
- MP3 source handling;
- malformed normalization and partial diagnostics.

For a manifest check:

```bash
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8")); console.log("manifest ok")'
```

## Manual smoke test

1. Load `extension/` as an unpacked extension.
2. Confirm the service worker has no module or permission errors.
3. Open a signed-in Suno page.
4. Open controls and run **Test Connection**.
5. Run **Sync library** with **Skip disliked** off.
6. Verify the coverage summary discovers the expected workspace count and exceeds the old first-page-only result.
7. Search, paginate, select a small subset, and export to a temporary folder.
8. Reopen controls and verify the local cache loads without a network request.
9. Inspect Activity and confirm no token values or raw capture data appear.

## Safe contribution rules

- Keep `scratchpad/`, HAR files, request captures, browser exports, cookies, and account data out of the repository.
- Never commit a real bearer token, browser token, device identifier, email address, or private API response.
- Prefer pure functions and Node built-in tests for pagination, normalization, and state transitions.
- Keep remote values out of `innerHTML`.
- Do not add CDN scripts, remote fonts, or unnecessary permissions.
- Treat API behavior as account- and region-dependent; do not make a completion claim from a partial crawl.

## Commit style

Use a concise Conventional Commit subject and a detailed body describing behavior, compatibility, and validation. For example:

```text
fix(feed): drain all project pages before workspace sync

Use the project endpoint's current_page and num_total_results contract,
report incomplete totals instead of silently stopping after page one,
and add a 20/20/15 regression fixture.
```
