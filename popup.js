// ============================
// Media DownloadHelper - Popup Script
// ============================

'use strict';

// State
let allMedia = [];
let filteredMedia = [];
let selectedUrls = new Set();
let currentFilter = 'all';
let currentTabId = null;
let currentTabUrl = '';

// DOM refs
const mediaList = document.getElementById('mediaList');
const emptyState = document.getElementById('emptyState');
const selectAllBtn = document.getElementById('selectAllBtn');
const selectCount = document.getElementById('selectCount');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const clearBtn = document.getElementById('clearBtn');
const refreshBtn = document.getElementById('refreshBtn');
const scanBtn = document.getElementById('scanBtn');
const toastContainer = document.getElementById('toastContainer');
const footerTabInfo = document.getElementById('footerTabInfo');

const countElements = {
  video: document.getElementById('countVideo'),
  audio: document.getElementById('countAudio'),
  stream: document.getElementById('countStream'),
  media: document.getElementById('countOther'),
};

// ---- Type Icons & Labels ----

const TYPE_META = {
  video: { icon: '🎬', label: 'VIDEO' },
  audio: { icon: '🎵', label: 'AUDIO' },
  stream: { icon: '📡', label: 'STREAM' },
  media: { icon: '📎', label: 'MEDIA' },
};

// ---- Toast ----

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ---- Stats ----

function updateStats() {
  const counts = { video: 0, audio: 0, stream: 0, media: 0 };
  for (const item of allMedia) {
    const t = item.type || 'media';
    if (counts[t] !== undefined) counts[t]++;
    else counts.media++;
  }

  for (const [key, el] of Object.entries(countElements)) {
    const val = counts[key] || 0;
    el.textContent = val;
    el.classList.toggle('has-items', val > 0);
  }
}

// ---- Select count ----

function updateSelectCount() {
  const count = selectedUrls.size;
  selectCount.textContent = count > 0 ? `${count} selected` : '';
  downloadSelectedBtn.disabled = count === 0;
  downloadSelectedBtn.style.opacity = count === 0 ? '0.5' : '1';
}

// ---- Filter ----

function applyFilter() {
  if (currentFilter === 'all') {
    filteredMedia = [...allMedia];
  } else {
    filteredMedia = allMedia.filter(m => m.type === currentFilter);
  }
  renderList();
}

// ---- Render ----

function renderList() {
  // Remove existing items (keep empty state in DOM, just hide it)
  const existingItems = mediaList.querySelectorAll('.media-item');
  existingItems.forEach(el => el.remove());

  if (filteredMedia.length === 0) {
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  // Render in reverse order (newest first)
  const reversed = [...filteredMedia].reverse();

  for (const item of reversed) {
    const el = createMediaItem(item);
    mediaList.appendChild(el);
  }
}

function createMediaItem(item) {
  const div = document.createElement('div');
  const type = item.type || 'media';
  div.className = `media-item type-${type}`;
  div.dataset.url = item.url;

  if (selectedUrls.has(item.url)) {
    div.classList.add('selected');
  }

  const meta = TYPE_META[type] || TYPE_META.media;
  const fileName = sanitizeFileName(item.fileName || 'media_file');
  const shortUrl = shortenUrl(item.url);

  div.innerHTML = `
    <div class="item-checkbox">
      ${selectedUrls.has(item.url) ? '✓' : ''}
    </div>
    <div class="item-type-icon">${meta.icon}</div>
    <div class="item-info">
      <div class="item-name" title="${escapeHtml(item.fileName || 'media_file')}">${escapeHtml(fileName)}</div>
      <div class="item-meta">
        <span class="badge badge-${type}">${meta.label}</span>
        <span class="item-size">${item.sizeFormatted || 'Unknown size'}</span>
      </div>
      <div class="item-url" title="${escapeHtml(item.url)}">${escapeHtml(shortUrl)}</div>
    </div>
    <div class="item-actions">
      <button class="action-btn copy-btn" title="Copy URL">⎘</button>
      <button class="action-btn download-btn" title="Download">⬇</button>
    </div>
  `;

  // Toggle selection
  div.addEventListener('click', (e) => {
    if (e.target.closest('.action-btn')) return;
    toggleSelection(item.url);

    const checkbox = div.querySelector('.item-checkbox');
    if (selectedUrls.has(item.url)) {
      div.classList.add('selected');
      checkbox.textContent = '✓';
    } else {
      div.classList.remove('selected');
      checkbox.textContent = '';
    }
    updateSelectCount();
  });

  // Download button
  div.querySelector('.download-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    downloadItem(item);
  });

  // Copy URL button
  div.querySelector('.copy-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    copyUrl(item.url);
  });

  return div;
}

// ---- Selection ----

function toggleSelection(url) {
  if (selectedUrls.has(url)) {
    selectedUrls.delete(url);
  } else {
    selectedUrls.add(url);
  }
}

// ---- Download ----

function downloadItem(item, saveAs = false) {
  const fileName = sanitizeFileName(item.fileName || 'media_file');
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA',
    url: item.url,
    fileName: fileName,
    saveAs
  }, (response) => {
    if (response && response.success) {
      showToast(`⬇ Downloading: ${fileName}`, 'success');
    } else {
      // Fallback: open in new tab
      chrome.tabs.create({ url: item.url });
      showToast(`📂 Opened in new tab`, 'info');
    }
  });
}

function downloadSelected() {
  if (selectedUrls.size === 0) return;

  const toDownload = allMedia.filter(m => selectedUrls.has(m.url));
  let count = 0;

  for (const item of toDownload) {
    setTimeout(() => {
      downloadItem(item);
    }, count * 300); // Stagger downloads
    count++;
  }

  showToast(`⬇ Starting ${count} download${count !== 1 ? 's' : ''}`, 'success');
}

// ---- Copy ----

function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('📋 URL copied to clipboard', 'success');
  }).catch(() => {
    // Fallback
    const el = document.createElement('textarea');
    el.value = url;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast('📋 URL copied', 'success');
  });
}

// ---- Select All ----

function handleSelectAll() {
  const allSelected = filteredMedia.every(m => selectedUrls.has(m.url));

  if (allSelected && filteredMedia.length > 0) {
    // Deselect all
    filteredMedia.forEach(m => selectedUrls.delete(m.url));
    selectAllBtn.textContent = '☑ Select All';
  } else {
    // Select all
    filteredMedia.forEach(m => selectedUrls.add(m.url));
    selectAllBtn.textContent = '☐ Deselect All';
  }

  // Re-render
  renderList();
  updateSelectCount();
}

// ---- Clear ----

function clearMedia() {
  if (!currentTabId) return;

  chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA', tabId: currentTabId }, () => {
    allMedia = [];
    filteredMedia = [];
    selectedUrls.clear();
    updateStats();
    applyFilter();
    updateSelectCount();
    showToast('✓ Media list cleared', 'info');
  });
}

// ---- Refresh / Scan ----

function refreshMedia() {
  if (!currentTabId) return;

  // Show loading state
  emptyState.style.display = 'none';
  mediaList.innerHTML = `
    <div class="loading-indicator">
      <div class="spinner"></div>
      <span>Scanning page...</span>
    </div>
  `;

  // Inject content script to re-scan
  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    files: ['content.js']
  }).catch(() => {});

  // Small delay then fetch
  setTimeout(() => {
    loadMedia();
  }, 800);
}

// ---- Load Media ----

function loadMedia() {
  if (!currentTabId) return;

  chrome.runtime.sendMessage({ type: 'GET_MEDIA', tabId: currentTabId }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Error getting media:', chrome.runtime.lastError);
      return;
    }

    // Remove loading indicator
    const loadingEl = mediaList.querySelector('.loading-indicator');
    if (loadingEl) loadingEl.remove();

    allMedia = (response && response.media) ? response.media : [];
    selectedUrls = new Set([...selectedUrls].filter(url => allMedia.some(m => m.url === url)));

    updateStats();
    applyFilter();
    updateSelectCount();
  });
}

// ---- Tab Filter Events ----

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    selectedUrls.clear();
    applyFilter();
    updateSelectCount();
  });
});

// ---- Button Events ----

selectAllBtn.addEventListener('click', handleSelectAll);
downloadSelectedBtn.addEventListener('click', downloadSelected);
clearBtn.addEventListener('click', clearMedia);
refreshBtn.addEventListener('click', refreshMedia);
if (scanBtn) scanBtn.addEventListener('click', refreshMedia);

// Settings (placeholder)
document.getElementById('settingsBtn').addEventListener('click', () => {
  showToast('⚙ Settings coming soon', 'info');
});

// ---- Helpers ----

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeFileName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').substring(0, 120);
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname.length > 30 ? '...' + u.pathname.slice(-28) : u.pathname;
    return `${host}${path}`;
  } catch (e) {
    return url.length > 50 ? url.substring(0, 47) + '...' : url;
  }
}

// ---- Auto-refresh polling (every 2 seconds while popup is open) ----

let pollInterval = null;

function startPolling() {
  pollInterval = setInterval(() => {
    loadMedia();
  }, 2000);
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
}

window.addEventListener('unload', stopPolling);

// ---- Init ----

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentTabId = tab.id;
      currentTabUrl = tab.url || '';
      const hostname = currentTabUrl ? new URL(currentTabUrl).hostname : 'unknown';
      footerTabInfo.textContent = hostname;
    }
  } catch (e) {
    console.warn('Could not get current tab', e);
  }

  loadMedia();
  startPolling();
}

init();
