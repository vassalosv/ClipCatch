// ============================
// Media DownloadHelper - Content Script
// ============================

(function () {
  'use strict';

  // Avoid running multiple times
  if (window.__mediaDownloadHelperRunning) return;
  window.__mediaDownloadHelperRunning = true;

  const MEDIA_EXTENSIONS = [
    'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'mpeg', 'mpg', 'm4v',
    'mp3', 'aac', 'ogg', 'flac', 'wav', 'm4a', 'opus', 'wma',
    'm3u8', 'mpd', 'ts', 'f4v', 'f4a', '3gp', 'ogv'
  ];

  function getExtension(url) {
    try {
      const u = new URL(url, location.href);
      const parts = u.pathname.split('.');
      if (parts.length > 1) {
        return parts[parts.length - 1].toLowerCase().split('?')[0];
      }
    } catch (e) {}
    return '';
  }

  function isMediaUrl(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return false;
    const ext = getExtension(url);
    return MEDIA_EXTENSIONS.includes(ext);
  }

  function resolveUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch (e) {
      return url;
    }
  }

  function collectDomMedia() {
    const found = [];
    const seen = new Set();

    function add(url, mimeType) {
      const resolved = resolveUrl(url);
      if (!seen.has(resolved) && isMediaUrl(resolved)) {
        seen.add(resolved);
        found.push({ url: resolved, mimeType: mimeType || '', pageUrl: location.href });
      }
    }

    // <video> and <audio> elements
    document.querySelectorAll('video, audio').forEach(el => {
      if (el.src) add(el.src, el.type || '');
      el.querySelectorAll('source').forEach(src => {
        if (src.src) add(src.src, src.type || '');
      });
      // currentSrc
      if (el.currentSrc) add(el.currentSrc, '');
    });

    // <source> elements anywhere
    document.querySelectorAll('source[src]').forEach(el => {
      add(el.src, el.type || '');
    });

    // <a> links pointing to media files
    document.querySelectorAll('a[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (href) add(href, '');
    });

    // meta og:video or og:audio
    document.querySelectorAll('meta[property="og:video"], meta[property="og:audio"], meta[property="og:video:url"]').forEach(el => {
      const content = el.getAttribute('content');
      if (content) add(content, '');
    });

    return found;
  }

  function scanAndReport() {
    const items = collectDomMedia();
    if (items.length > 0) {
      chrome.runtime.sendMessage({
        type: 'CONTENT_MEDIA',
        items
      }).catch(() => {});
    }
  }

  // Initial scan after page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanAndReport);
  } else {
    scanAndReport();
  }

  // Watch for dynamic content (e.g., lazy-loaded players)
  const observer = new MutationObserver(() => {
    scanAndReport();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  // Also scan when src attributes change on existing elements
  document.addEventListener('loadedmetadata', (e) => {
    const el = e.target;
    if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
      if (el.currentSrc) {
        const resolved = resolveUrl(el.currentSrc);
        chrome.runtime.sendMessage({
          type: 'CONTENT_MEDIA',
          items: [{ url: resolved, mimeType: '', pageUrl: location.href }]
        }).catch(() => {});
      }
    }
  }, true);

})();
