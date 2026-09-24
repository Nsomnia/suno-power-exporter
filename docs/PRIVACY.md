# Privacy & data boundaries

## Public repository contents

This repository is an extension-only source archive. It intentionally excludes:

- `scratchpad/` and every file beneath it;
- HAR files and browser request/response captures;
- Open Sniffer, Requestly, recon, and source-map archives;
- cookies, bearer tokens, browser tokens, device identifiers, and account exports;
- personal names, email addresses, private prompts, telemetry, and real clip payloads;
- local Chrome profiles, IndexedDB files, and downloaded media.

The source still contains endpoint names and generic code references required to understand the extension. Those references are not captured account data.

## Runtime data

When installed locally, the extension may store:

- user-selected settings in `chrome.storage.local`;
- a normalized library cache for offline reopening;
- a File System Access directory handle in IndexedDB;
- a short-lived authorization header captured from the user’s own signed-in Suno tab;
- per-item download markers in browser-download mode.

These values remain in the local browser profile and are not transmitted to a project server. The controls UI does not display raw token values, and the activity log is bounded and redacted.

## Network boundary

API requests are relayed through a signed-in Suno page with an exact Studio API origin allowlist. Media requests are not granted arbitrary destination access through the authenticated proxy. Do not paste real headers, cookies, or API responses into issues, commits, logs, or documentation.

## User responsibilities

- Use the extension only with an account and content you are authorized to access.
- Review applicable terms, licenses, and local laws before redistributing exported media.
- Remove local extension data and revoke browser permissions when decommissioning a profile.
- Report security issues privately to the repository owner rather than including secrets in a public issue.

## Publication checklist

Before any future release, verify that:

```bash
git ls-files | grep -E '(^|/)(scratchpad|.*\.har$|.*\.zip$)' && exit 1 || true
```

A clean release should also pass a secret scan over tracked text files and the extension test suite.
