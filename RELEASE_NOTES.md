# ClipCatch v0.9.0 — Page-Title Filenames

Downloaded files are now named after the video title on the page rather than the raw URL segment, matching the behaviour of VideoHelper Online.

---

## What's New

### Smarter filenames from the page

ClipCatch now reads the title of the page (or the individual video element) and uses it as the filename when saving a download. The title is resolved in this priority order:

1. **Element-specific** — `title` attribute or `aria-label` on the `<video>`/`<audio>` element
2. **Nearest heading** — walks up the DOM up to 5 levels looking for an `<h1>`–`<h4>` near the player
3. **Open Graph** — `<meta property="og:title">`
4. **Page title** — `document.title`

**For streams (HLS/DASH):** the page title always replaces the URL-derived name (which is usually something like `master.m3u8` or `index (stream)`).

**For direct video/audio files:** the page title replaces only obviously generic URL names (`index`, `video`, `media`, `player`, `stream`, `embed`, etc.). Files that already have meaningful names in the URL keep them.

### Title available for network-intercepted media

The content script now sends a `PAGE_INFO` message to the background immediately when it loads — before any media network requests fire. This means media detected via the `webRequest` API (rather than DOM scanning) also gets the correct page title as its filename.

---

## Technical Notes

- Illegal filename characters (`/ \ : * ? " < > |`) are replaced with spaces and collapsed
- Titles are capped at 100 characters
- `tabTitleStore` in the background worker stores one title per tab; cleared on tab close or navigation

---

# ClipCatch v0.8.0 — Remuxer Fix & Performance

This release fixes a critical bug that made every in-browser remuxed MP4 unplayable, adds PTS continuity handling for multi-segment HLS streams, and delivers a round of performance improvements across the extension.

---

## Bug Fixes

### Remuxed MP4 files were always unplayable
The MP4 box-patching functions (`patchStco`, `getStszSizes`) used a flat scan that only read the outermost box header and then jumped past the entire `trak` box on the first iteration. The `stco` box — which holds the byte offsets telling the player where each sample lives in the file — sits four levels deep (`trak › mdia › minf › stbl › stco`) and was never reached. Every remuxed file had all chunk offsets set to `0`, pointing players at the `ftyp` header instead of the actual media data. Fixed with a recursive `findBox()` helper.

### Scrambled video from multi-segment HLS streams
HLS segments frequently reset PTS timestamps to `0` at each boundary. After all segments were concatenated and samples sorted by DTS, footage from later segments was interleaved before earlier segments, producing garbled or unplayable video. A new `normalizePTSArray()` step in the demuxer detects backward time jumps > 1 s and shifts subsequent timestamps forward to maintain continuity.

### H.265/HEVC streams no longer produce corrupt output
HEVC video was silently pushed through the H.264 remux path, generating structurally invalid MP4 files. HEVC streams are now detected in the PMT and immediately fall back to saving raw MPEG-TS data (still with a `.mp4` extension, playable in VLC/mpv/ffmpeg).

---

## Performance Improvements

| Area | Before | After |
|------|--------|-------|
| HLS segment concurrency | 2 | 5 |
| Inter-batch delay | 100 ms | 50 ms |
| Progress IPC messages | 1 per segment | max 4/sec |
| MutationObserver DOM scan | every mutation | debounced 300 ms |
| Download poll | N individual API calls | 1 batched query |
| Popup download poller | 800 ms interval | removed (push only) |

---

## Other Changes

- Version in the popup footer now reads directly from the manifest — no more hardcoded strings
- `saver.js` IndexedDB: read + delete combined into a single transaction
- Blob URL revocation shortened from 60 s to 5 s
