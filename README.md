# ClipCatch — Chrome Extension

> v0.7.8 — Detect and download video, audio, and streaming media from any website. Built-in HLS/DASH assembler — no external tools, no size limits.

---

## ✨ Features

- **Auto-detection** of video, audio, and streaming files via network request monitoring
- **DOM scanning** to find `<video>` and `<audio>` elements embedded in pages
- **Live badge counter** showing how many media files are detected on the current tab
- **Filter by type**: Video, Audio, Stream (HLS/DASH), or Other
- **Built-in HLS/DASH assembler** — fetches, merges, and remuxes all segments internally; no yt-dlp, ffmpeg, or any external tool required
- **TS → MP4 remuxing** — automatically converts MPEG-TS streams to MP4 (files up to 600 MB); larger streams are saved directly as `.mp4`
- **Real-time assembly progress** — live segment counter, bytes downloaded, speed, and ETA
- **Try direct download** — detects embedded MP4 URLs inside HLS playlists and offers a one-click direct download
- **yt-dlp / ffmpeg commands** — ⌘ button opens a commands window with ready-to-run CLI commands as a fallback
- **Batch download** — select multiple items and download them all at once
- **Pause / Resume / Cancel** for direct downloads
- **Copy URL** — quickly copy any media URL to clipboard
- **Auto-polling** — popup refreshes every 2 seconds to catch late-loading media
- **Clean dark UI** with a sleek, professional aesthetic

### Supported formats
| Category | Formats |
|----------|---------|
| Video | MP4, WebM, MKV, AVI, MOV, FLV, WMV, MPEG, M4V, 3GP, OGV |
| Audio | MP3, AAC, OGG, FLAC, WAV, M4A, OPUS, WMA |
| Streams | M3U8 (HLS), MPD (DASH) |

---

## 🚀 Installation (Developer Mode)

1. **Unzip** the `clipcatch` folder to anywhere on your PC
2. Open **Google Chrome** and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the unzipped `clipcatch` folder
6. The ClipCatch icon will appear in your toolbar

> **Tip:** Pin the extension for quick access by clicking the puzzle piece icon in the toolbar and pinning "ClipCatch".

---

## 🎯 How to Use

### Video & Audio files
1. Navigate to any website with video or audio
2. Click the **ClipCatch** icon in the toolbar
3. Detected media files appear automatically in the **Media** tab
4. Click a row to select it, then click **⬇ Download**
5. Use **Select All** to download everything at once
6. Use **🔍 Scan Page Now** to force a rescan if nothing appeared

### HLS / DASH streams
1. Detected streams appear with a `📡 STREAM` badge
2. Click **⬇ Merge** to start the built-in assembler — it fetches all segments, merges them, and saves the result as an `.mp4` file
3. Switch to the **Downloads** tab to track progress (segments, speed, ETA)
4. Use **↗** to attempt a direct HTTP download if an embedded MP4 URL was detected
5. Use **⌘** to open the commands window with yt-dlp / ffmpeg CLI commands as a manual fallback

---

## ⚠️ Notes

- Sites using DRM (Netflix, Disney+, etc.) protect their content — URLs may be detected but the downloaded file will be encrypted and unplayable.
- This extension is for **personal use** only. Always respect copyright and terms of service.

---

## 🔧 Technical Details

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — monitors network requests, manages HLS jobs and downloads |
| `content.js` | Content script — scans DOM for embedded `<video>` / `<audio>` elements |
| `popup.html` / `popup.js` | Popup UI — media list, filters, download panel |
| `offscreen.html` / `offscreen.js` | HLS/DASH assembly engine (offscreen document with full DOM APIs) |
| `remux.js` | Pure-JS MPEG-TS → MP4 remuxer (H.264 + AAC, zero dependencies) |
| `saver.html` / `saver.js` | Download trigger page — bridges the offscreen assembler and `chrome.downloads` |
| `commands.html` / `commands.js` | yt-dlp / ffmpeg commands popup |
| `icons/` | Extension icons (16 / 32 / 48 / 128 px) |

---

## 📝 License

MIT License — free for personal and educational use.
