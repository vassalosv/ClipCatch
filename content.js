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

    function add(rawUrl, mimeType) {
      try {
        const url = resolveUrl(rawUrl);
        if (!seen.has(url) && isAllowed(url)) {
          seen.add(url);
          found.push({ url, mimeType: mimeType || '', pageUrl: location.href });
        }
      } catch (e) {}
    }

    // <video> and <audio> src / currentSrc
    document.querySelectorAll('video, audio').forEach(el => {
      if (el.src)        add(el.src, el.type || '');
      if (el.currentSrc) add(el.currentSrc, '');
      el.querySelectorAll('source').forEach(s => { if (s.src) add(s.src, s.type || ''); });
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
  }

  // Initial scan
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report);
  } else {
    report();
  }

  // Watch for dynamically added players — debounced to avoid scanning on every mutation
  let reportTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(report, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Catch lazy-loaded video sources
  document.addEventListener('loadedmetadata', (e) => {
    const el = e.target;
    if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') && el.currentSrc) {
      const url = resolveUrl(el.currentSrc);
      if (isAllowed(url)) {
        chrome.runtime.sendMessage({
          type: 'CONTENT_MEDIA',
          items: [{ url, mimeType: '', pageUrl: location.href }]
        }).catch(() => {});
      }
    }
  }, true);

})();
