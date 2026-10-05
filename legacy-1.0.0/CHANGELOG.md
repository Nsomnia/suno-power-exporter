# Changelog

All notable public changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning for future tags.

## [Unreleased]

### Added

- Durable Chrome MV3 controls window with local search, pagination, stable selection, progress, and coverage diagnostics.
- Complete workspace discovery using the Studio project endpoint’s `current_page` and `num_total_results` contract.
- Resilient feed-v3 cursor traversal with global deduplication, filter-aware normalization, retry/backoff, abort handling, and partial-result reporting.
- Local library cache with legacy per-workspace cache migration and explicit incomplete-state preservation.
- File System Access and browser-download output modes with sidecar support, folder indexing, and completion-aware browser downloads.
- Dependency-free Node regression tests for pagination, filters, retries, cancellation, persistence, settings migration, and export source handling.
- Public documentation covering architecture, user workflows, development, and privacy boundaries.

### Changed

- Workspace discovery no longer stops after the first 20 project rows when the account reports additional pages.
- Default sync scope includes disliked clips for a complete library; users can explicitly enable the filtered view.
- Partial crawls remain visible instead of being reported as successful “ready” libraries.
- API proxy destinations and headers are allowlisted; controls-targeted messages are explicitly routed.
- Activity logging is bounded and redacted; raw token values are never displayed.

### Fixed

- Empty/short project pages, missing totals, changing totals, and mismatched current pages produce explicit coverage diagnostics.
- Feed wrappers are flattened using the legacy child semantics and normalized with workspace/upload/trash metadata.
- Auth failures can recover through a cookie-only request after a stale captured bearer is rejected.
- Directory handles migrate from the older record shape and survive IndexedDB upgrades.
- MP3 source detection rejects protected or mismatched media instead of returning corrupt output.
- Export cancellation, browser download completion, and metadata sidecar failures are reflected in job results.

## [0.1.0] - 2026-09-24

### Added

- Initial public archive of the modular Suno Power Exporter extension.
- MV3 manifest, controls UI, content relay, API client, export engine, directory adapter, and tests.
- README and documentation map for future maintainers and archival sessions.

[Unreleased]: https://github.com/Nsomnia/suno-power-exporter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nsomnia/suno-power-exporter/releases/tag/v0.1.0
