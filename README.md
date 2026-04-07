# ClipCatch — Chrome Extension

Detect and download video, audio, and streaming media from any website. Built-in HLS/DASH assembler — no size limits, no external tools required.

---

## Features

- **Auto-detection** of video, audio, and streaming files via network request monitoring
- **DOM scanning** to find `<video>` and `<audio>` elements, Open Graph tags, and lazy-loaded sources
- **Built-in HLS/DASH assembler** — fetches, concatenates, and remuxes TS segments into a clean MP4 in-browser, no yt-dlp or ffmpeg needed
- **Live badge counter** showing how many media files are found on the current tab
- **Filter by type**: Video, Audio, Stream (HLS/DASH), or Other
- **Batch download**: Select multiple items and download them all at once
- **Copy URL**: Quickly copy any media URL to clipboard
- **Download panel**: Track progress, speed, ETA for both direct and HLS downloads; pause/resume/cancel
- **yt-dlp / ffmpeg commands** for streams that can't be assembled in-browser

### Supported formats

| Category | Formats |
|----------|---------|
| Video | MP4, WebM, MKV, AVI, MOV, FLV, WMV, MPEG, M4V, 3GP, OGV |
| Audio | MP3, AAC, OGG, FLAC, WAV, M4A, OPUS, WMA |
| Streams | M3U8 (HLS), MPD (DASH) |

---

## Installation (Developer Mode)

1. Clone or download this repository
2. Open **Google Chrome** and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the `ClipCatch` folder
6. The ClipCatch icon will appear in your toolbar — pin it for quick access

---

## How to Use

1. Navigate to any website with video or audio
2. Click the **ClipCatch** icon in the toolbar
3. Detected media files appear automatically in the popup
4. **Direct files** (MP4, WebM, etc.): click **⬇** to download
5. **Streams** (HLS/DASH): click **⬇ Merge** to assemble in-browser, or **↗** to try a direct HTTP download, or **⌘** for yt-dlp/ffmpeg commands
6. Use **Select All** + **⬇ Download** to batch-download multiple items
7. Click the **Downloads** tab to track progress

---

## Notes

- Sites using DRM (Netflix, Disney+) protect their content — stream URLs may be detected but the media will be encrypted and unplayable without a licence.
- This extension is for **personal use** only. Always respect copyright and terms of service.
- HLS streams above 600 MB are saved as raw MPEG-TS (`.mp4` extension) — VLC, mpv, and ffmpeg handle this correctly.

---

## Technical Details

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — network monitoring, download management, HLS job orchestration |
| `content.js` | Content script — DOM scan for embedded media elements |
| `offscreen.js` | Offscreen document — HLS/DASH playlist parsing and segment assembly |
| `remux.js` | In-browser MPEG-TS → MP4 remuxer (H.264 + AAC, no dependencies) |
| `saver.js` | Minimal extension page that bridges IndexedDB blobs to `chrome.downloads` |
| `popup.html` / `popup.js` | Popup UI and state management |

---

## License

MIT License — free for personal and educational use.
