# ClipCatch — Release Notes

## v0.7.8 — 2026-04-01

### Changed
- **HLS streams always saved as `.mp4`**
  Previously, streams that failed remuxing or exceeded the 600 MB in-memory remux limit were saved with a `.ts` extension. All outputs now use `.mp4` regardless of the remux path. Modern players (VLC, mpv, Chrome, MPC-HC) detect the container format from the file's content headers rather than the extension, so raw MPEG-TS data saved as `.mp4` plays correctly.

---

## v0.7.7 — 2026-04-01

### Fixed
- **HLS stream save error: "Invalid URL"**
  `chrome.downloads.download()` does not accept data URLs — only `http://`, `https://`, `file://`, and `blob://` are supported. The data URL approach introduced in v0.7.6 was fundamentally incompatible with this API.

  The saving mechanism has been fully redesigned around a dedicated `saver.html` extension page. The flow is:
  1. The offscreen assembler stores the raw `Blob` in a shared `IndexedDB` store (`clipcatch_transfers`).
  2. A lightweight trigger message (job ID only) is sent to the background service worker.
  3. The background opens `saver.html` as a minimal popup window.
  4. `saver.js` — a regular extension page — reads the `Blob` from IndexedDB, creates a local blob URL, calls `chrome.downloads.download()`, cleans up IndexedDB, and closes itself.

  The `Blob` never crosses the IPC boundary. Only the job ID travels over `sendMessage`.

---

## v0.7.6 — 2026-03-30

### Fixed
- **HLS stream save error: "URL.createObjectURL is not a function"**
  `URL.createObjectURL` is not available in MV3 extension service workers. The IndexedDB approach from v0.7.5 stored a raw `Blob` and then attempted to create a blob URL inside the service worker — which is impossible.

  The fix moved the conversion step back to the offscreen document, which has `FileReader`. The Blob was converted to a data URL there, stored as a string in IndexedDB, and the background read it back to pass to `chrome.downloads.download()`. *(Note: this approach was superseded in v0.7.7 when it was discovered that `chrome.downloads` also rejects data URLs.)*

---

## v0.7.5 — 2026-03-30

### Fixed
- **HLS stream save error: "Error in invocation of runtime.sendMessage"**
  The data URL sent via `chrome.runtime.sendMessage` in v0.7.4 hit Chrome's ~64 MB IPC message size limit on real-world streams, causing `sendMessage` to throw before the background even received the message.

  Replaced with an IndexedDB transfer buffer: the offscreen document writes the assembled Blob into a shared `clipcatch_transfers` store, then sends a lightweight message containing only the job ID and filename. The background reads the Blob back from IndexedDB, creates a local blob URL, and calls `chrome.downloads.download()`.

---

## v0.7.4 — 2026-03-30

### Fixed
- **HLS stream stuck at "Saving file…" / error: "Cannot read properties of undefined (reading 'download')"**
  `chrome.downloads` is completely unavailable in offscreen documents — the API is `undefined` in that context. The previous anchor-click approach (v0.7.3) stalled silently; this version surfaced the underlying cause.

  The fix converted the assembled output to a data URL via `FileReader` and sent it to the background service worker via a new `SAVE_HLS_FILE` message handler, where `chrome.downloads.download()` is available and called correctly.

---

## v0.7.3 — 2026-03-30

### Fixed
- **HLS stream saving stuck at "Saving file…"**
  After assembling and remuxing the stream, the extension attempted to trigger a file download by programmatically clicking an `<a download>` element inside the offscreen document. Chrome silently blocks anchor-initiated downloads in offscreen documents because there is no user gesture present, causing the job to hang indefinitely on "Saving file…" with no error reported.

  The anchor-click approach was replaced with a direct `chrome.downloads.download()` call. *(Note: this was further revised in v0.7.4 when `chrome.downloads` was found to be unavailable in offscreen documents.)*
