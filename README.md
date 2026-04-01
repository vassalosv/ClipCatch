# 🎬 Media DownloadHelper — Chrome Extension

A powerful browser extension to detect and download video, audio, and streaming media from any website — inspired by the popular Video DownloadHelper.

---

## ✨ Features

- **Auto-detection** of video, audio, and streaming files via network request monitoring
- **DOM scanning** to find `<video>` and `<audio>` elements embedded in pages
- **Live badge counter** showing how many media files are found on the current tab
- **Filter by type**: Video, Audio, Stream (HLS/DASH), or Other
- **Batch download**: Select multiple items and download them all
- **Copy URL**: Quickly copy any media URL to clipboard
- **Auto-polling**: Popup refreshes every 2 seconds to catch late-loading media
- **Clean dark UI** with a sleek, professional aesthetic

### Supported formats
| Category | Formats |
|----------|---------|
| Video | MP4, WebM, MKV, AVI, MOV, FLV, WMV, MPEG, M4V, 3GP, OGV |
| Audio | MP3, AAC, OGG, FLAC, WAV, M4A, OPUS, WMA |
| Streams | M3U8 (HLS), MPD (DASH), TS segments |

---

## 🚀 Installation (Developer Mode)

1. **Unzip** `media-downloadhelper.zip` to a folder on your PC
2. Open **Google Chrome** and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the unzipped `video-downloadhelper-clone` folder
6. The extension icon (🟠) will appear in your toolbar

> **Tip:** Pin the extension for quick access by clicking the puzzle piece icon in the toolbar and pinning "Media DLHelper".

---

## 🎯 How to Use

1. Navigate to any website with video or audio (YouTube, Vimeo, news sites, etc.)
2. Click the **Media DLHelper** icon in the toolbar
3. Detected media files appear automatically in the popup
4. Click a media row to **select** it, then click **⬇ Download**
5. Use **Select All** to download everything at once
6. Use **🔍 Scan Page Now** to force a rescan if nothing appeared

---

## ⚠️ Notes

- **HLS/DASH streams** (`.m3u8`, `.mpd`) are detected as URLs but require a tool like [yt-dlp](https://github.com/yt-dlp/yt-dlp) or [ffmpeg](https://ffmpeg.org/) to download the full stream.
- Sites using DRM (Netflix, Disney+) protect their content — URLs may be detected but downloads will be encrypted.
- This extension is for **personal use** only. Always respect copyright and terms of service.

---

## 🔧 Technical Details

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — monitors all network requests |
| `content.js` | Content script — scans DOM for embedded media |
| `popup.html` | Popup UI |
| `popup.js` | Popup logic and state management |
| `icons/` | Extension icons (16/32/48/128px) |

---

## 📝 License

MIT License — free for personal and educational use.
