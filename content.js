// ============================
// ClipCatch - Content Script
// ============================

(function () {
  'use strict';

  if (window.__clipCatchRunning) return;
  window.__clipCatchRunning = true;

  // ── Page / element title extraction ───────────────────────────────────────
  function getPageTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    return (og?.getAttribute('content') || document.title || '').trim();
  }

  function getElementTitle(el) {
    if (el.title?.trim())                          return el.title.trim();
    if (el.getAttribute('aria-label')?.trim())     return el.getAttribute('aria-label').trim();
    // Walk up up to 5 levels looking for the nearest heading inside a parent
    let node = el.parentElement;
    for (let d = 0; d < 5 && node && node !== document.body; d++) {
      for (const tag of ['h1', 'h2', 'h3', 'h4']) {
        const h = node.querySelector(tag);
        if (h?.textContent.trim()) return h.textContent.trim();
      }
      node = node.parentElement;
    }
    return null;
  }

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
    const pageTitle = getPageTitle();

    function add(rawUrl, mimeType, title) {
      try {
        const url = resolveUrl(rawUrl);
        if (!seen.has(url) && isAllowed(url)) {
          seen.add(url);
          found.push({ url, mimeType: mimeType || '', pageUrl: location.href, title: title || '' });
        }
      } catch (e) {}
    }

    // <video> and <audio> src / currentSrc — use element-specific title, fall back to page title
    document.querySelectorAll('video, audio').forEach(el => {
      const title = getElementTitle(el) || pageTitle;
      if (el.src)        add(el.src, el.type || '', title);
      if (el.currentSrc) add(el.currentSrc, '', title);
      el.querySelectorAll('source').forEach(s => { if (s.src) add(s.src, s.type || '', title); });
    });

    // Standalone <source> elements
    document.querySelectorAll('source[src]').forEach(el => add(el.src, el.type || '', pageTitle));

    // <a href> links — only if extension is explicitly in ALLOWED_EXTS
    document.querySelectorAll('a[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (href) {
        const ext = getExt(resolveUrl(href));
        if (ALLOWED_EXTS.has(ext)) add(href, '', el.textContent?.trim() || pageTitle);
      }
    });

    // Open Graph video/audio meta tags
    document.querySelectorAll(
      'meta[property="og:video"], meta[property="og:audio"], meta[property="og:video:url"]'
    ).forEach(el => {
      const c = el.getAttribute('content');
      if (c) add(c, '', pageTitle);
    });

    return found;
  }

  function report() {
    const items = collectDomMedia();
    const pageTitle = getPageTitle();
    // Always inform background of current page title so network-detected media can use it
    chrome.runtime.sendMessage({ type: 'PAGE_INFO', title: pageTitle }).catch(() => {});
    if (items.length > 0) {
      chrome.runtime.sendMessage({ type: 'CONTENT_MEDIA', items, pageTitle }).catch(() => {});
    }
  }

  // Initial scan — also send PAGE_INFO immediately so the title is stored before
  // any network responses arrive for this tab
  chrome.runtime.sendMessage({ type: 'PAGE_INFO', title: getPageTitle() }).catch(() => {});

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
        const title = getElementTitle(el) || getPageTitle();
        chrome.runtime.sendMessage({
          type: 'CONTENT_MEDIA',
          items: [{ url, mimeType: '', pageUrl: location.href, title }],
          pageTitle: getPageTitle(),
        }).catch(() => {});
      }
    }
  }, true);

})();
