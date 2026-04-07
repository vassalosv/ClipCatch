// ============================
// offscreen.js — HLS/DASH Assembly Engine
// Runs in an offscreen document so it has full DOM APIs:
// Blob, URL.createObjectURL, fetch, etc.
// ============================
'use strict';

// Active jobs: jobId -> { cancelled, controller }
const activeJobs = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────
function resolveUrl(rel, base) {
  try { return new URL(rel, base).href; } catch(e) { return rel; }
}

function fmtBytes(b) {
  if (!b || b <= 0) return null;
  const u = ['B','KB','MB','GB']; let v=b, i=0;
  while(v>=1024 && i<u.length-1){v/=1024;i++;}
  return `${v.toFixed(1)} ${u[i]}`;
}
function fmtSpeed(bps) { return bps>0?(fmtBytes(bps)||'')+'/s':''; }
function fmtEta(left, bps) {
  if(!bps||bps<=0||!left||left<=0) return '';
  const s=Math.round(left/bps);
  if(s<60) return `${s}s`; if(s<3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

// ── Network fetch with retry/backoff ───────────────────────────────────────
async function fetchText(url, signal) {
  const resp = await fetch(url, { credentials: 'include', signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function fetchBuffer(url, signal, attempt = 0) {
  const MAX = 4;
  try {
    const resp = await fetch(url, { credentials: 'include', signal });
    if (resp.ok) return resp.arrayBuffer();
    if (resp.status === 429 || resp.status === 503) {
      if (attempt >= MAX) throw new Error(`HTTP ${resp.status} after ${MAX} retries`);
      const after = resp.headers.get('Retry-After');
      const wait  = after ? parseInt(after)*1000 : Math.min(1000*Math.pow(2,attempt)+Math.random()*500, 16000);
      await delay(wait);
      return fetchBuffer(url, signal, attempt+1);
    }
    if (resp.status >= 500 && attempt < MAX) {
      await delay(Math.min(800*Math.pow(2,attempt), 10000));
      return fetchBuffer(url, signal, attempt+1);
    }
    throw new Error(`HTTP ${resp.status}`);
  } catch(err) {
    if (err.name === 'AbortError') throw err;
    if (attempt < MAX && !err.message.startsWith('HTTP')) {
      await delay(Math.min(600*Math.pow(2,attempt), 8000));
      return fetchBuffer(url, signal, attempt+1);
    }
    throw err;
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Playlist parsers ───────────────────────────────────────────────────────
function isMasterPlaylist(text) {
  return text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:');
}
function isDASH(url, text) {
  return url.endsWith('.mpd') || text.includes('<MPD ') || text.includes('urn:mpeg:dash');
}

function parseMasterPlaylist(text, baseUrl) {
  const lines    = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const variants = [];
  for (let i=0; i<lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw  = lines[i].match(/BANDWIDTH=(\d+)/i);
      const res = lines[i].match(/RESOLUTION=(\d+x\d+)/i);
      const url = lines[i+1] && !lines[i+1].startsWith('#') ? resolveUrl(lines[i+1], baseUrl) : null;
      if (url) variants.push({ url, bandwidth: bw?parseInt(bw[1]):0, resolution: res?res[1]:'' });
    }
  }
  return variants;
}

function parseMediaPlaylist(text, baseUrl) {
  return text.split('\n')
    .map(l=>l.trim())
    .filter(l=>l && !l.startsWith('#'))
    .map(l=>resolveUrl(l, baseUrl));
}

function parseMPD(text, baseUrl) {
  const segments = [];
  try {
    const mediaMatch     = text.match(/media="([^"]+)"/i);
    const startMatch     = text.match(/startNumber="(\d+)"/i);
    const durationMatch  = text.match(/duration="(\d+)"/i);
    const timescaleMatch = text.match(/timescale="(\d+)"/i);
    const periodMatch    = text.match(/mediaPresentationDuration="PT([\d.]+)S"/i);
    if (mediaMatch && durationMatch) {
      const start     = startMatch ? parseInt(startMatch[1]) : 1;
      const duration  = parseInt(durationMatch[1]);
      const timescale = timescaleMatch ? parseInt(timescaleMatch[1]) : 1;
      const totalSecs = periodMatch ? parseFloat(periodMatch[1]) : 0;
      const count     = totalSecs>0 ? Math.ceil(totalSecs*timescale/duration) : 100;
      for (let i=start; i<start+count; i++) {
        segments.push(resolveUrl(mediaMatch[1].replace(/\$Number\$|\$Number%\d+d\$/g, i), baseUrl));
      }
    }
    const listMatches = [...text.matchAll(/<SegmentURL\s+media="([^"]+)"/gi)];
    for (const m of listMatches) segments.push(resolveUrl(m[1], baseUrl));
    if (segments.length===0) {
      const baseMatches = [...text.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/gi)];
      for (const m of baseMatches) { const u=resolveUrl(m[1].trim(),baseUrl); if(!segments.includes(u)) segments.push(u); }
    }
  } catch(e) {}
  return segments;
}

// ── Progress reporting back to background ─────────────────────────────────
function report(jobId, fields) {
  chrome.runtime.sendMessage({ type: 'HLS_PROGRESS', jobId, ...fields }).catch(()=>{});
}

// ── Main assembly function ─────────────────────────────────────────────────
async function runJob(jobId, url, fileName) {
  const controller = new AbortController();
  const signal     = controller.signal;
  activeJobs.set(jobId, { controller });

  const speedWindow = [];
  let bytesDone = 0, bytesTotal = 0, segDone = 0, segTotal = 0;
  let lastSpeedReport = 0;

  function updateSpeed(newBytes) {
    const now = Date.now();
    speedWindow.push({ bytes: newBytes, time: now });
    if (speedWindow.length > 8) speedWindow.shift();
    // Throttle IPC to ~4 reports/sec
    if (now - lastSpeedReport < 250) return;
    lastSpeedReport = now;
    let speed = 0;
    if (speedWindow.length >= 2) {
      const dt = (speedWindow[speedWindow.length-1].time - speedWindow[0].time) / 1000;
      const db = speedWindow[speedWindow.length-1].bytes - speedWindow[0].bytes;
      speed = dt > 0 ? db / dt : 0;
    }
    const eta = bytesTotal > 0 ? fmtEta(bytesTotal - newBytes, speed) : '';
    report(jobId, {
      state: 'downloading', segDone, segTotal, bytesDone: newBytes,
      bytesDoneFmt: fmtBytes(newBytes)||'0 B',
      speed, speedFmt: fmtSpeed(speed), eta,
      progress: segTotal > 0 ? Math.round((segDone/segTotal)*100) : -1,
    });
  }

  try {
    // ── Step 1: Fetch & parse playlist ─────────────────────────────────────
    report(jobId, { state: 'fetching', segDone:0, segTotal:0, bytesDone:0, progress:-1, stateLabel:'Fetching playlist…' });

    const playlistText = await fetchText(url, signal);

    let segments = [];
    if (isDASH(url, playlistText)) {
      segments = parseMPD(playlistText, url);
    } else if (isMasterPlaylist(playlistText)) {
      const variants = parseMasterPlaylist(playlistText, url);
      if (variants.length === 0) throw new Error('No variants in master playlist');
      variants.sort((a,b) => b.bandwidth - a.bandwidth);
      const mediaText = await fetchText(variants[0].url, signal);
      segments = parseMediaPlaylist(mediaText, variants[0].url);
    } else {
      segments = parseMediaPlaylist(playlistText, url);
    }

    if (segments.length === 0) throw new Error('No segments found in playlist');
    segTotal = segments.length;
    report(jobId, { state:'downloading', segDone:0, segTotal, bytesDone:0, progress:0, stateLabel:`Downloading segments (0/${segTotal})` });

    // ── Step 2: Download segments (2 at a time, 100ms pause between batches) ──
    // We stream directly into a growing array of ArrayBuffers rather than
    // allocating one giant buffer — avoids hitting string/memory limits.
    const buffers    = [];
    const CONCURRENCY = 5;
    const DELAY_MS    = 50;

    for (let i = 0; i < segments.length; i += CONCURRENCY) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      const batch = segments.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async segUrl => {
        const buf = await fetchBuffer(segUrl, signal);
        segDone++;
        bytesDone += buf.byteLength;
        updateSpeed(bytesDone);
        return buf;
      }));
      buffers.push(...results);

      if (i + CONCURRENCY < segments.length) await delay(DELAY_MS);
    }

    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

    // ── Step 3: Merge ──────────────────────────────────────────────────────
    report(jobId, { state:'merging', segDone, segTotal, bytesDone, progress:100, stateLabel:'Merging segments…' });

    const totalSize = buffers.reduce((s,b) => s + b.byteLength, 0);
    let merged      = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    // *** Free individual segment buffers immediately — they're now in `merged` ***
    // This cuts peak memory from ~3× to ~2× the file size.
    for (let i = 0; i < buffers.length; i++) buffers[i] = null;
    buffers.length = 0;

    // ── Step 4: Remux TS → MP4 ────────────────────────────────────────────
    // Build clean output filename: strip "(stream)" suffix AND any media extension,
    // then append .mp4 (always — players detect container format from content, not extension).
    // e.g. "tt26443597GR.mp4 (stream)" → "tt26443597GR" → "tt26443597GR.mp4"
    const cleanName = fileName
      .replace(/\s*\(stream\)\s*/gi, '')
      .replace(/\.(mp4|mkv|avi|mov|webm|m3u8|mpd|ts|flv|wmv)$/i, '');
    let outName   = cleanName + '.mp4';
    let outMime   = 'video/mp4';
    let outputData = null; // Uint8Array — declared let so we can free it

    report(jobId, { state:'merging', segDone, segTotal, bytesDone, progress:100, stateLabel:'Remuxing to MP4…' });

    // Only attempt remux for files under 600 MB to avoid OOM on large streams.
    // Above that threshold save the raw TS data with a .mp4 extension —
    // VLC/MPC-HC/mpv/ffmpeg detect the container from content headers, not the extension.
    const REMUX_SIZE_LIMIT = 600 * 1024 * 1024;
    if (typeof remuxTStoMP4 === 'function' && totalSize <= REMUX_SIZE_LIMIT) {
      try {
        // remuxTStoMP4 returns a Uint8Array — use it directly (NOT .buffer which may be oversized)
        outputData = remuxTStoMP4(merged.buffer);
        // Free the TS buffer — remuxTStoMP4 has already copied all data it needs
        merged = null;
      } catch (remuxErr) {
        console.warn('[ClipCatch] Remux failed, saving raw stream as .mp4:', remuxErr.message);
        outputData = merged;
        merged     = null;
        // Keep .mp4 extension — players (VLC, mpv, Chrome) detect the container
        // format from content headers, not the file extension.
      }
    } else {
      // Too large to remux in-memory, or remux unavailable — save raw stream
      outputData = merged;
      // Keep .mp4 extension for consistency
    }

    // ── Step 5: Save ──────────────────────────────────────────────────────
    // chrome.downloads is unavailable in offscreen documents, and anchor clicks
    // without a user gesture are silently ignored. Data URLs sent via
    // sendMessage hit Chrome's ~64 MB IPC limit on real-world streams.
    // Solution: write the Blob into shared IndexedDB (same extension origin =
    // same DB), then send a tiny message so the background service worker can
    // read it back, create a local blob URL, and call chrome.downloads.
    report(jobId, { state:'saving', segDone, segTotal, bytesDone, progress:100, stateLabel:'Saving file…' });

    const blob = new Blob([outputData], { type: outMime });
    outputData = null; // free immediately — Blob holds its own copy

    // Deadlock: offscreen docs have URL.createObjectURL but no chrome.downloads;
    // service workers have chrome.downloads but no URL.createObjectURL;
    // sendMessage has a ~64 MB IPC cap (too small for real streams);
    // chrome.downloads rejects data URLs entirely.
    //
    // Solution: store the raw Blob in shared IndexedDB (same extension origin),
    // then ask the background to open saver.html — a regular extension page that
    // has BOTH URL.createObjectURL and chrome.downloads. Only the job ID travels
    // over IPC; the Blob never leaves IndexedDB until saver.js reads it locally.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('clipcatch_transfers', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('transfers');
      req.onerror   = () => reject(new Error('IndexedDB open failed'));
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('transfers', 'readwrite');
        tx.objectStore('transfers').put({ blob, filename: outName }, jobId);
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
      };
    });

    // Lightweight trigger — only the job ID crosses the IPC boundary
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'SAVE_HLS_FILE', jobId }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!resp?.success)      reject(new Error(resp?.error || 'Save failed'));
        else                          resolve();
      });
    });

    activeJobs.delete(jobId);
    report(jobId, {
      state: 'complete', downloadId: null,
      segDone, segTotal, bytesDone,
      bytesDoneFmt: fmtBytes(bytesDone)||'0 B',
      stateLabel: 'Complete',
    });

  } catch(err) {
    activeJobs.delete(jobId);
    if (err.name === 'AbortError' || err.message === 'Cancelled') {
      report(jobId, { state:'cancelled', stateLabel:'Cancelled' });
    } else {
      report(jobId, { state:'error', error: err.message||String(err) });
    }
  }
}

// ── Message listener ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'START_HLS_JOB') {
    runJob(msg.jobId, msg.url, msg.fileName);
    respond({ success: true });
    return true;
  }
  if (msg.type === 'CANCEL_HLS_JOB') {
    const job = activeJobs.get(msg.jobId);
    if (job) {
      job.controller.abort();
      activeJobs.delete(msg.jobId);
    }
    respond({ success: true });
    return true;
  }
});

console.log('[ClipCatch] Offscreen document ready.');
