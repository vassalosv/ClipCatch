# ClipCatch — Chrome Extension

A powerful Chrome extension to detect and download video, audio, and streaming media from any website — with a built-in HLS/DASH assembler that requires no external tools and has no file size limits.

---

## Features

- **Auto-detection** of video, audio, and streaming files via network request monitoring
- **DOM scanning** to find `<video>` and `<audio>` elements embedded in pages
- **Live badge counter** showing how many media files are found on the current tab
- **Filter by type**: Video, Audio, Stream (HLS/DASH), or Other
- **Batch download**: Select multiple items and download them all at once
- **Copy URL**: Quickly copy any media URL to clipboard
- **Auto-polling**: Popup refreshes every 2 seconds to catch late-loading media
- **Built-in HLS/DASH assembler**: Downloads and stitches `.m3u8` / `.mpd` streams directly in the browser — no yt-dlp or ffmpeg needed
- **MP4 output by default**: Assembled streams are saved as `.mp4` — fMP4/ISOBMFF segments are packaged directly; MPEG-TS segments are remuxed via the built-in remuxer
- **Retry with backoff**: Segment fetches automatically retry on 429/5xx errors
- **Download tracking panel**: Monitor active downloads and HLS assembly jobs with progress, speed, and ETA
- **Stream Commands window**: Displays ready-to-use `yt-dlp` / `ffmpeg` commands for streams that require external tools
- **Cancel in-flight jobs**: Stop any active HLS assembly or download mid-flight
- **Video thumbnails**: Popup shows a live screenshot from the page's `<video>` element as each item's icon — works for both DOM-detected videos and network-intercepted HLS/DASH streams
- **Clean dark UI** with a sleek, professional aesthetic

### Supported formats

| Category | Formats |
|----------|---------|
| Video    | MP4, WebM, MKV, AVI, MOV, FLV, WMV, MPEG, M4V, 3GP, OGV |
| Audio    | MP3, AAC, OGG, FLAC, WAV, M4A, OPUS, WMA |
| Streams  | M3U8 (HLS), MPD (DASH), TS segments |

---

## Installation (Developer Mode)

1. Download or clone this repository to a folder on your PC
2. Open **Google Chrome** and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the `ClipCatch` folder
6. The **ClipCatch** icon will appear in your toolbar

> **Tip:** Pin the extension for quick access by clicking the puzzle piece icon in the toolbar and pinning "ClipCatch".

---

## How to Use

1. Navigate to any website with video or audio (YouTube, Vimeo, news sites, etc.)
2. Click the **ClipCatch** icon in the toolbar
3. Detected media files appear automatically in the popup
4. Click a media row to **select** it, then click **Download**
5. Use **Select All** to download everything at once
6. Use **Scan Page Now** to force a rescan if nothing appeared
7. For HLS/DASH streams, ClipCatch will assemble them in-browser and save as a single file
8. Check the **Downloads panel** (bottom tab) to monitor progress

---

## Notes

- **HLS/DASH streams** (`.m3u8`, `.mpd`) are assembled in-browser using the built-in engine. No external tools required.
- Sites using DRM (Netflix, Disney+) protect their content — URLs may be detected but downloads will be encrypted.
- This extension is for **personal use** only. Always respect copyright and terms of service.

---

## Technical Details

| File | Purpose |
|------|---------|
| `manifest.json`  | Extension manifest (MV3) |
| `background.js`  | Service worker — monitors all network requests and coordinates jobs |
| `content.js`     | Content script — scans DOM for embedded media elements |
| `popup.html`     | Popup UI |
| `popup.js`       | Popup logic, state management, and download tracking |
| `offscreen.html` | Offscreen document host for the HLS/DASH assembly engine |
| `offscreen.js`   | HLS/DASH assembly engine — fetches, retries, and stitches segments |
| `remux.js`       | MP4 remuxer — wraps raw TS/AAC/H.264 streams into a valid MP4 container |
| `commands.html`  | Stream commands popup UI |
| `commands.js`    | Displays yt-dlp / ffmpeg commands for streams requiring external tools |
| `icons/`         | Extension icons (16/32/48/128px) |

---

## License

MIT License — free for personal and educational use.

---

## Changelog

### v0.7.1 — 2026-03-24
- Replaced dynamic hostname in popup footer with a static **"ClipCatch on Github.com"** link pointing to the repository
- Removed unused `footerTabInfo` element and hostname-detection code from `popup.js`

### v0.7 — 2026-03-24
- **Page-level thumbnail channel**: introduced `PAGE_THUMB` message so HLS/DASH stream items (detected via network requests, not DOM) also receive a visual preview — `content.js` captures the first usable frame from any `<video>` on the page and broadcasts it; `background.js` back-fills it onto all existing items in that tab that have no thumbnail yet
- Thumbnail back-fill fires on initial page scan and on every `loadeddata` event, covering late-loading and MSE-based (blob URL) players
- `tabPageThumbs` map in `background.js` cleaned up on tab navigation and close

### v0.6 — 2026-03-24
- **MP4 output for all stream types**: `offscreen.js` now detects segment container format (fMP4 vs MPEG-TS) from magic bytes — fMP4 segments are concatenated directly as `.mp4`; MPEG-TS segments are remuxed; no more `.ts` fallback for modern streams
- **Video thumbnails in popup**: `content.js` captures a live JPEG frame (80×45) from `<video>` elements using Canvas API and displays it as the item icon; updates on `loadeddata` for late-loading players; falls back to type emoji on cross-origin or unavailable frames
- Thumbnail data flows through `background.js` and is stored per media item; existing entries get their thumbnail updated if a better one arrives later

### v0.5 — 2026-03-24
- Fixed cross-file consistency issues (manifest, popup, content script, offscreen document, commands window)
- Improved HLS assembly reliability and segment handling in `offscreen.js`
- Minor bug fixes and stability improvements across all components

### v0.3 — 2026-03-22
- Added built-in **HLS/DASH assembly engine** (`offscreen.js` + `offscreen.html`) — no external tools required
- Added **MP4 remuxer** (`remux.js`) to wrap TS segments into a valid MP4 container
- Refactored `background.js` for cleaner job coordination with the offscreen document
- Updated manifest to declare `offscreen` and `declarativeNetRequest` permissions

### v0.2 — 2026-03-21
- Major rewrite of `background.js`, `popup.html`, `popup.js`, and `content.js`
- Added **Stream Commands window** (`commands.html` / `commands.js`) showing ready-to-use yt-dlp/ffmpeg commands
- Added download tracking panel with progress, speed, and ETA
- Added cancel support for in-flight downloads and HLS jobs
- Redesigned popup UI with filter tabs and batch selection

### v0.1 — 2026-02-14 *(first commit)*
- Initial working extension: network request monitoring via service worker
- DOM scanner for `<video>` / `<audio>` elements
- Popup with filter tabs (Video, Audio, Stream, Other), batch download, and copy URL
- Live badge counter on the extension icon
- Auto-polling every 2 seconds

### Initial commit — 2026-02-11
- Repository created with `LICENSE` (MIT) and placeholder `README.md`
