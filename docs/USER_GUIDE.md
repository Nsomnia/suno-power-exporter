# User guide

## First run

1. Load the `extension/` directory from `chrome://extensions`.
2. Open a signed-in Suno tab.
3. Click the extension action.
4. Choose **Sync library**.

The first sync can take several minutes when an account has many workspaces and feed pages. The controls window is intentionally persistent; do not close it while a sync or export is active.

## Sync scope

The Library toolbar controls the next sync:

| Control | Behavior |
|---|---|
| **Workspace** | Limits the crawl to one discovered project or all workspaces. |
| **Liked only** | Requests only liked clips. |
| **Include uploads** | Keeps clips whose metadata type is `upload`. |
| **Skip disliked** | When enabled, requests `disliked: "False"`. Leave it off for a complete library. |
| **Clear list** | Removes the local cache and selection from this profile. |

The coverage summary reports discovered workspaces, reported project counts, loaded tracks, and filtered/unavailable differences. A partial result is retained and visibly marked.

## Search and selection

Search is local and does not call the API. It checks:

- title and artist;
- workspace and model;
- album and track ID;
- prompt, tags, and lyrics when present.

Use **Select page** for the visible 100 rows, **Select all matches** for the current search, or individual checkboxes. Selection is keyed by stable track IDs, so it survives pagination and re-rendering.

## Output

### Folder mode

Choose a folder explicitly in the Directory tab. The extension writes under `sppe_downloads/` and scans the folder to avoid duplicate filenames. Permission loss is surfaced through **Reconnect**; the extension never silently opens a picker during a background job.

### Browser Downloads mode

Select **Browser Downloads** in the Directory tab. Chrome’s download completion event is used before a browser-mode item is marked complete. Blob URLs are revoked after completion. Metadata sidecars are downloaded when enabled.

## Formats

- **M4A / source audio:** uses a valid direct MP4-family source when available; otherwise the existing authorized source pipeline is used.
- **MP3:** requires a direct plaintext MP3 source. The UI reports unavailable selections instead of pretending every clip is convertible.
- **WAV:** uses a direct WAV source when available, otherwise the configured decode path.

Formats and account capabilities can change. A failed item is shown as failed with its reason and can be retried after the source or permissions change.

## Stop and recovery

The Stop control stops scheduling new work after the current operation where possible. Network, decryption, tagging, and filesystem calls already in progress may finish before the job settles. A closed or interrupted window does not imply that a job completed.

## Troubleshooting

### No Suno tab found

Open a normal `https://suno.com` page, sign in, and return to the controls window. API requests are relayed through that page session.

### Partial sync

Read the Activity panel. The most useful details are workspace discovery errors, repeated cursor tokens, authorization failures, and rate-limit retries. Cached tracks remain available while you retry.

### Folder unavailable

Use **Choose Folder** or **Reconnect** from a user gesture. If the browser does not support File System Access, switch to **Browser Downloads**.

### MP3 unavailable

This is expected for feeds that expose only protected M4A/Opus media. Select M4A/source audio or export only tracks with direct MP3 sources.
