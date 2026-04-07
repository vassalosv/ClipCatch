# Changelog

All notable changes to ClipCatch will be documented in this file.

## [0.9.0] - 2026-04-07

### Added
- **Page-title-based filenames** — ClipCatch now extracts the best available title from the page and uses it as the download filename, the same way VideoHelper Online does. Priority order: element-specific title (`title` attribute, `aria-label`, nearest heading `h1–h4`) → Open Graph `og:title` → `document.title`. For streams the title replaces the URL-derived name entirely. For direct video/audio files it replaces only obviously generic names (`index`, `video`, `media`, `player`, etc.).
- `PAGE_INFO` message type: the content script sends the page title to the background immediately on load (before any network requests fire) so that network-intercepted media also benefits from the title.
- `tabTitleStore` in the background service worker stores one title per active tab; cleaned up on tab close/navigate.

## [0.8.0] - 2026-04-07

### Fixed
- **Remuxed MP4 files unplayable in all players** — `patchStco()` and `getStszSizes()` used a flat box scan that started at the `trak` header itself (depth 0), immediately jumped past the entire box, and exited without ever finding `stco`/`stsz`. These boxes sit four levels deep (`trak > mdia > minf > stbl`). Result: every remuxed file had all chunk offsets set to 0 — players tried to read sample data from byte 0 of the file (the `ftyp` header) instead of the `mdat` payload. Added recursive `findBox()` helper; both functions now correctly locate deeply nested boxes.
- **Garbled video from HLS streams with PTS discontinuities** — HLS segments often reset PTS to 0 at each boundary. After concatenation, `buildVideoTrack()` sorts samples by DTS, which interleaved samples from different segments into the wrong order. Added `normalizePTSArray()` in `demuxTS()`: detects backward jumps > 1 s and shifts subsequent timestamps to be continuous before sorting occurs.
- **H.265/HEVC streams silently remuxed as broken H.264** — HEVC video was assigned a `videoPid` and processed through the H.264 remux path, producing structurally invalid output. `demuxTS()` now returns a `videoIsHEVC` flag; `remuxTStoMP4()` throws immediately on HEVC, triggering the raw-TS fallback path cleanly.
- **`merged.fill(0)` called after remux** — redundant and misleading; `remuxTStoMP4()` copies all data it processes so the TS buffer is no longer referenced. Replaced with `merged = null`.

### Improved
- **HLS segment concurrency**: 2 → 5 parallel fetches; inter-batch delay 100 ms → 50 ms — significantly faster assembly on typical CDNs.
- **Speed report throttling**: progress IPC messages capped at 4/sec (previously fired once per segment completion) — reduces message bus pressure on high-segment-count streams.
- **MutationObserver debounced 300 ms** in content script — prevents a full DOM scan on every individual DOM mutation on dynamic pages.
- **Download poll batched**: replaced N individual `chrome.downloads.search({id})` calls with a single `chrome.downloads.search({state:'in_progress'})` query per tick.
- **Removed redundant popup download poller** — the 800 ms `setInterval` in the popup duplicated push updates already sent by the background (`DOWNLOADS_UPDATE` / `HLS_JOBS_UPDATE` messages).
- **Deduplicated format helpers**: extracted `formatJob()` and `formatDl()` used by both broadcast functions and `GET_*` message handlers; extracted `hasActiveHLSJobs()` to replace two identical inline checks.
- **`saver.js` IndexedDB**: merged two sequential `indexedDB.open()` calls into a single `readwrite` transaction that reads and deletes the transfer record atomically.
- **Blob URL revocation**: shortened from 60 s to 5 s — Chrome begins reading the blob URL within milliseconds of `chrome.downloads.download()` being called.
- **Version in popup footer** is now read dynamically from `chrome.runtime.getManifest().version` — will always stay in sync with `manifest.json`.

## [0.7.8] - 2026-04-01

### Changed
- **HLS streams always saved as `.mp4`** — Previously, streams that failed remuxing or exceeded the 600 MB in-memory remux limit fell back to a `.ts` extension. All outputs now use `.mp4` regardless of the remux path. Modern players (VLC, mpv, Chrome, MPC-HC) detect the container format from the file's content headers, not the extension, so raw MPEG-TS data saved as `.mp4` plays correctly.

## [0.7.7] - 2026-04-01

### Fixed
- **HLS stream save error: "Invalid URL"** — `chrome.downloads.download()` does not accept data URLs, only `http://`, `https://`, `file://`, and `blob://`. The data URL approach (v0.7.6) was fundamentally incompatible. The saving mechanism has been fully redesigned around a dedicated `saver.html` extension page: the offscreen doc stores the raw `Blob` in a shared `IndexedDB` store (`clipcatch_transfers`), sends a lightweight trigger message (job ID only) to the background, which opens `saver.html` as a minimal popup. As a regular extension page, `saver.js` has both `URL.createObjectURL` and `chrome.downloads` — it reads the `Blob` from IndexedDB, creates a local blob URL, calls `chrome.downloads.download()`, cleans up IndexedDB, and closes itself. The `Blob` never crosses the IPC boundary.

## [0.7.6] - 2026-03-30

### Fixed
- **HLS stream save error: "URL.createObjectURL is not a function"** — `URL.createObjectURL` is not available in MV3 service workers. The IndexedDB approach from v0.7.5 stored a raw `Blob`, which then required creating a blob URL in the service worker — impossible. The fix keeps the conversion to the offscreen document (which has `FileReader`): the Blob is converted to a data URL there, the data URL string is stored in IndexedDB (no size limit), and a lightweight trigger message is sent to the background. The service worker reads the data URL string from IndexedDB and passes it directly to `chrome.downloads.download()`, which accepts data URLs natively — no `URL.createObjectURL` required.

## [0.7.5] - 2026-03-30

### Fixed
- **HLS stream save error: "Error in invocation of runtime.sendMessage"** — The data URL approach (v0.7.4) hit Chrome's ~64 MB IPC message size limit on real-world streams, causing `sendMessage` to throw before even reaching the background. Replaced with an **IndexedDB transfer buffer**: the offscreen document writes the assembled Blob directly into a shared `clipcatch_transfers` IndexedDB store (same extension origin = same database), then sends a lightweight message containing only the job ID and filename. The background service worker reads the Blob back from IndexedDB, creates a local blob URL within its own context, calls `chrome.downloads.download()`, and cleans up the IndexedDB entry.

## [0.7.4] - 2026-03-30

### Fixed
- **HLS stream not saving after assembly** — The offscreen document has no access to `chrome.downloads` (API is undefined there), and anchor clicks without a user gesture are silently ignored by Chrome. The saving step now converts the assembled output to a data URL via `FileReader` and sends it to the background service worker via a new `SAVE_HLS_FILE` message, where `chrome.downloads.download()` is called correctly. The job now properly transitions to `complete` (or `error` on failure) instead of hanging on "Saving file…" or throwing a runtime error.

## [0.7.3] - 2026-03-30

### Fixed
- **HLS stream saving stuck at "Saving file…"** — Replaced the silent `<a>` anchor-click approach in the offscreen document. Chrome blocks anchor-initiated downloads inside offscreen documents due to the absence of a user gesture, causing the save to stall indefinitely with no error.
