// ============================
// Media DownloadHelper - Background Service Worker
// ============================

// Media file extensions to detect
const MEDIA_EXTENSIONS = [
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'mpeg', 'mpg', 'm4v',
  'mp3', 'aac', 'ogg', 'flac', 'wav', 'm4a', 'opus', 'wma',
  'm3u8', 'mpd', 'ts', 'f4v', 'f4a', '3gp', 'ogv', 'ogm'
];

// MIME types to detect
const MEDIA_MIME_TYPES = [
  'video/', 'audio/',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
  'application/octet-stream'
];

// Storage key per tab
const TAB_MEDIA_KEY = 'tabMedia';

// In-memory store: tabId -> Map of url -> mediaInfo
const tabMediaStore = new Map();

// ---- Helpers ----

function getFileExtension(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    const parts = pathname.split('.');
    if (parts.length > 1) {
      return parts[parts.length - 1].toLowerCase().split('?')[0];
    }
  } catch (e) {}
  return '';
}

function getFileName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const name = parts[parts.length - 1];
    return name ? decodeURIComponent(name) : 'media_file';
  } catch (e) {
    return 'media_file';
  }
}

function guessType(url, mimeType) {
  const ext = getFileExtension(url);
  const videoExts = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'mpeg', 'mpg', 'm4v', 'ogv', 'ogm', '3gp', 'f4v'];
  const audioExts = ['mp3', 'aac', 'ogg', 'flac', 'wav', 'm4a', 'opus', 'wma', 'f4a'];
  const streamExts = ['m3u8', 'mpd', 'ts'];

  if (streamExts.includes(ext) || (mimeType && (mimeType.includes('mpegurl') || mimeType.includes('dash')))) {
    return 'stream';
  }
  if (videoExts.includes(ext) || (mimeType && mimeType.startsWith('video/'))) {
    return 'video';
  }
  if (audioExts.includes(ext) || (mimeType && mimeType.startsWith('audio/'))) {
    return 'audio';
  }
  return 'media';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit++;
  }
  return `${val.toFixed(1)} ${units[unit]}`;
}

function isMediaUrl(url, mimeType) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return false;

  const ext = getFileExtension(url);
  if (MEDIA_EXTENSIONS.includes(ext)) return true;

  if (mimeType) {
    for (const m of MEDIA_MIME_TYPES) {
      if (mimeType.includes(m)) return true;
    }
  }
  return false;
}

function updateBadge(tabId) {
  const mediaMap = tabMediaStore.get(tabId);
  const count = mediaMap ? mediaMap.size : 0;
  const text = count > 0 ? String(count) : '';
  const color = count > 0 ? '#e05c1a' : '#888888';

  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}

function addMediaToTab(tabId, url, details) {
  if (!tabMediaStore.has(tabId)) {
    tabMediaStore.set(tabId, new Map());
  }

  const mediaMap = tabMediaStore.get(tabId);

  // Avoid duplicates by URL
  if (!mediaMap.has(url)) {
    const mediaInfo = {
      url,
      fileName: getFileName(url),
      type: guessType(url, details.mimeType),
      mimeType: details.mimeType || '',
      size: details.size || 0,
      sizeFormatted: formatBytes(details.size),
      timestamp: Date.now(),
      tabId,
      pageTitle: details.pageTitle || '',
      pageUrl: details.pageUrl || ''
    };
    mediaMap.set(url, mediaInfo);
    updateBadge(tabId);

    // Persist to storage for popup access
    persistTabMedia(tabId);
  }
}

function persistTabMedia(tabId) {
  const mediaMap = tabMediaStore.get(tabId);
  if (!mediaMap) return;

  const items = Array.from(mediaMap.values());
  const storageKey = `${TAB_MEDIA_KEY}_${tabId}`;
  chrome.storage.session.set({ [storageKey]: items }).catch(() => {
    // Fallback: try local storage
    chrome.storage.local.set({ [storageKey]: items });
  });
}

function clearTabMedia(tabId) {
  tabMediaStore.delete(tabId);
  updateBadge(tabId);
  const storageKey = `${TAB_MEDIA_KEY}_${tabId}`;
  chrome.storage.session.remove(storageKey).catch(() => {
    chrome.storage.local.remove(storageKey);
  });
}

// ---- Network Request Listener ----

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return; // Ignore background requests

    const url = details.url;
    const responseHeaders = details.responseHeaders || [];

    // Extract content-type and content-length
    let mimeType = '';
    let size = 0;

    for (const header of responseHeaders) {
      const name = header.name.toLowerCase();
      if (name === 'content-type') {
        mimeType = header.value.split(';')[0].trim().toLowerCase();
      }
      if (name === 'content-length') {
        size = parseInt(header.value, 10) || 0;
      }
    }

    if (isMediaUrl(url, mimeType)) {
      addMediaToTab(details.tabId, url, {
        mimeType,
        size,
        pageUrl: details.initiator || ''
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ---- Message Handler (from popup/content scripts) ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_MEDIA') {
    const tabId = message.tabId;
    const mediaMap = tabMediaStore.get(tabId);
    const items = mediaMap ? Array.from(mediaMap.values()) : [];
    sendResponse({ media: items });
    return true;
  }

  if (message.type === 'CLEAR_MEDIA') {
    const tabId = message.tabId;
    clearTabMedia(tabId);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'DOWNLOAD_MEDIA') {
    const { url, fileName } = message;
    chrome.downloads.download({
      url,
      filename: fileName,
      saveAs: message.saveAs || false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true; // Keep channel open for async response
  }

  if (message.type === 'CONTENT_MEDIA') {
    // From content script reporting DOM-based media
    const tabId = sender.tab ? sender.tab.id : -1;
    if (tabId >= 0 && message.items) {
      for (const item of message.items) {
        if (isMediaUrl(item.url, item.mimeType)) {
          addMediaToTab(tabId, item.url, {
            mimeType: item.mimeType || '',
            size: item.size || 0,
            pageUrl: item.pageUrl || ''
          });
        }
      }
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'COPY_URL') {
    // Can't directly copy from background, but we'll handle it in popup
    sendResponse({ success: true });
    return true;
  }
});

// ---- Tab Lifecycle Management ----

// Clear media when tab navigates to new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTabMedia(tabId);
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabMedia(tabId);
  // Clean storage
  const storageKey = `${TAB_MEDIA_KEY}_${tabId}`;
  chrome.storage.session.remove(storageKey).catch(() => {
    chrome.storage.local.remove(storageKey);
  });
});

console.log('[Media DownloadHelper] Background service worker started.');
