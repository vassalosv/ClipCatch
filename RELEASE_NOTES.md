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
