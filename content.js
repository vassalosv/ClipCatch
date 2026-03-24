// ============================
// ClipCatch - Content Script
// ============================

(function () {
  'use strict';

  if (window.__clipCatchRunning) return;
  window.__clipCatchRunning = true;

  // ── ALLOWED media extensions (sent to background for further classification) ──
  // NOTE: 'ts' is intentionally EXCLUDED — .ts files are HLS segments, not full videos.
  //       .m3u8 and .mpd are the playlist URLs that represent the whole video.
  const ALLOWED_EXTS = new Set([
    // Video
    'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'mpeg', 'mpg',
    'm4v', 'f4v', '3gp', 'ogv', 'ogm',
    // Audio
    'mp3', 'aac', 'ogg', 'flac', 'wav', 'm4a', 'opus', 'wma', 'f4a',
    // Stream playlists (single entry-point URL = whole video)
    'm3u8', 'mpd'
  ]);

  // ── HARD DENY — never send these regardless of anything ──
  const DENIED_EXTS = new Set([
    'ts', 'fmp4', 'm4s', 'cmfv', 'cmfa',          // HLS/DASH segments
    'webmanifest', 'manifest', 'appcache',          // Web app manifests
    'json', 'xml', 'html', 'htm', 'css', 'js',     // Web resources
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',    // Images
    'woff', 'woff2', 'ttf', 'eot', 'otf',          // Fonts
    'map', 'gz', 'zip', 'br', 'txt', 'pdf',        // Other
    'ico', 'cur', 'bmp', 'tiff',
  ]);

  function getExt(url) {
    try {
      const pathname = new URL(url, location.href).pathname;
      const last = pathname.split('/').pop() || '';
      const dot = last.lastIndexOf('.');
      if (dot >= 0) return last.slice(dot + 1).toLowerCase().split('?')[0];
    } catch (e) {}
    return '';
  }

  function resolveUrl(url) {
    try { return new URL(url, location.href).href; } catch (e) { return url; }
  }

  function captureVideoThumb(el) {
    // 1. Try canvas — works for same-origin / non-tainted video
    try {
      if (el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0) {
        const W = 80, H = Math.round(W * el.videoHeight / el.videoWidth) || 45;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        canvas.getContext('2d').drawImage(el, 0, 0, W, H);
        return canvas.toDataURL('image/jpeg', 0.65); // throws SecurityError if tainted
      }
    } catch (e) {} // cross-origin canvas taint — fall through
    // 2. Fall back to poster attribute (set by virtually every streaming player)
    return el.poster || null;
  }

  function isAllowed(url) {
    if (!url) return false;
    const resolved = resolveUrl(url);
    // Skip data URIs and blob URLs (can't download these externally)
    if (resolved.startsWith('data:') || resolved.startsWith('blob:')) return false;
    const ext = getExt(resolved);
    if (DENIED_EXTS.has(ext)) return false;   // Hard deny first
    if (ext && !ALLOWED_EXTS.has(ext)) return false; // Not a known media ext
    return true;
  }

  function collectDomMedia() {
    const found = [];
    const seen = new Set();

    function add(rawUrl, mimeType, thumbnail) {
      try {
        const url = resolveUrl(rawUrl);
        if (!seen.has(url) && isAllowed(url)) {
          seen.add(url);
          found.push({ url, mimeType: mimeType || '', pageUrl: location.href, thumbnail: thumbnail || null });
        }
      } catch (e) {}
    }

    // <video> and <audio> src / currentSrc
    document.querySelectorAll('video, audio').forEach(el => {
      const thumb = el.tagName === 'VIDEO' ? captureVideoThumb(el) : null;
      if (el.src)        add(el.src, el.type || '', thumb);
      if (el.currentSrc) add(el.currentSrc, '', thumb);
      el.querySelectorAll('source').forEach(s => { if (s.src) add(s.src, s.type || '', thumb); });
    });

    // Standalone <source> elements
    document.querySelectorAll('source[src]').forEach(el => add(el.src, el.type || ''));

    // <a href> links — only if extension is explicitly in ALLOWED_EXTS
    document.querySelectorAll('a[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (href) {
        const ext = getExt(resolveUrl(href));
        if (ALLOWED_EXTS.has(ext)) add(href, ''); // Must be explicitly allowed
      }
    });

    // Open Graph video/audio meta tags
    document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:audio"], meta[property="og:video:url"]'
    ).forEach(el => {
      const c = el.getAttribute('content');
      if (c) add(c, '');
    });

    return found;
  }

  function report() {
    const items = collectDomMedia();
    if (items.length > 0) {
      chrome.runtime.sendMessage({ type: 'CONTENT_MEDIA', items }).catch(() => {});
    }
    // Also broadcast the best available video thumbnail for this page so that
    // stream items detected via network requests can get a visual preview.
    reportPageThumb();
  }

  function reportPageThumb() {
    const videos = document.querySelectorAll('video');
    for (const el of videos) {
      const thumb = captureVideoThumb(el);
      if (thumb) {
        chrome.runtime.sendMessage({ type: 'PAGE_THUMB', thumbnail: thumb }).catch(() => {});
        return; // first usable frame is enough
      }
    }
  }

  // Initial scan
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report);
  } else {
    report();
  }

  // Watch for dynamically added players
  const observer = new MutationObserver(report);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Capture a real playing frame on first timeupdate (fires when video is actually rendering)
  const capturedEls = new WeakSet();
  document.addEventListener('timeupdate', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'VIDEO' || capturedEls.has(el)) return;
    const thumb = captureVideoThumb(el);
    if (thumb) {
      capturedEls.add(el);
      chrome.runtime.sendMessage({ type: 'PAGE_THUMB', thumbnail: thumb }).catch(() => {});
    }
  }, true);

  // Catch lazy-loaded video sources and capture thumbnail once first frame loads
  document.addEventListener('loadeddata', (e) => {
    const el = e.target;
    if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
    if (el.currentSrc) {
      const url = resolveUrl(el.currentSrc);
      if (isAllowed(url)) {
        const thumbnail = el.tagName === 'VIDEO' ? captureVideoThumb(el) : null;
        chrome.runtime.sendMessage({
          type: 'CONTENT_MEDIA',
          items: [{ url, mimeType: '', pageUrl: location.href, thumbnail }]
        }).catch(() => {});
      }
    }
    // Always try to update the page-level thumb (covers blob/MSE streams)
    if (el.tagName === 'VIDEO') reportPageThumb();
  }, true);

})();
