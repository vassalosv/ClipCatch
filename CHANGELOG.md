# Changelog

All notable changes to ClipCatch will be documented in this file.

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
