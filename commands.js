// ============================
// commands.js — Stream Commands Window
// ============================
'use strict';

const $ = id => document.getElementById(id);

async function loadData() {
  return new Promise((resolve) => {
    // Try session storage first, fall back to local
    chrome.storage.session.get('pendingStreamCommands', (result) => {
      if (result?.pendingStreamCommands) {
        resolve(result.pendingStreamCommands);
      } else {
        chrome.storage.local.get('pendingStreamCommands', (r) => {
          resolve(r?.pendingStreamCommands || null);
        });
      }
    });
  });
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 80) + 'px';
}

function setupCopyBtn(btn) {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target;
    const ta = $(targetId);
    if (!ta) return;

    navigator.clipboard.writeText(ta.value)
      .then(() => flashCopied(btn))
      .catch(() => {
        // Fallback for when clipboard API isn't available
        ta.select();
        document.execCommand('copy');
        flashCopied(btn);
      });
  });
}

function flashCopied(btn) {
  const original = btn.innerHTML;
  btn.innerHTML = '✓ Copied!';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove('copied');
  }, 1800);
}

async function init() {
  const data = await loadData();

  $('loading').style.display = 'none';

  if (!data) {
    $('error-state').style.display = 'flex';
    return;
  }

  // Populate fields
  $('infoName').textContent    = data.fileName || 'stream_file';
  $('infoUrl').textContent     = data.url || '';
  $('ytdlpCmd').value          = data.ytdlpCommand  || `yt-dlp "${data.url}"`;
  $('ffmpegCmd').value         = data.ffmpegCommand || `ffmpeg -i "${data.url}" -c copy output.mp4`;
  $('playlistUrl').value       = data.url || '';

  // Direct URL section
  if (data.directUrl) {
    $('directSection').style.display = 'block';
    $('directUrl').value = data.directUrl;
    autoResize($('directUrl'));
  }

  // Auto-resize all textareas
  [$('ytdlpCmd'), $('ffmpegCmd'), $('playlistUrl')].forEach(autoResize);

  // Wire up all copy buttons
  document.querySelectorAll('.copy-btn').forEach(setupCopyBtn);

  // Show the app
  $('app').style.display = 'flex';
  $('app').style.flexDirection = 'column';
  $('app').style.minHeight = '100vh';
}

init();
