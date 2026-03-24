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

  function updateSpeed(newBytes) {
    const now = Date.now();
    speedWindow.push({ bytes: newBytes, time: now });
    if (speedWindow.length > 8) speedWindow.shift();
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
    const CONCURRENCY = 2;
    const DELAY_MS    = 100;

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

    // Calculate total size
    const totalSize = buffers.reduce((s,b) => s + b.byteLength, 0);
    const merged    = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    // ── Step 4: Remux TS → MP4 ────────────────────────────────────────────
    // The merged buffer is raw MPEG-TS. We remux it into a proper MP4
    // container so it plays natively in any video player.
    report(jobId, { state:'merging', segDone, segTotal, bytesDone, progress:100, stateLabel:'Remuxing to MP4…' });

    let outputBuffer = merged.buffer;
    let outMime      = 'video/mp2t';
    // Strip any existing media extension, then add .mp4
    // e.g. "tt26443597GR.mp4 (stream)" → "tt26443597GR.mp4" → "tt26443597GR" → "tt26443597GR.mp4"
    const cleanName = fileName
      .replace(/\s*\(stream\)\s*/gi, '')  // remove " (stream)"
      .replace(/\.[^.]+$/, '');              // remove last extension (e.g. .mp4, .m3u8)
    let outName = cleanName + '.mp4';

    try {
      if (typeof remuxTStoMP4 === 'function') {
        const mp4Buffer = remuxTStoMP4(merged.buffer);
        outputBuffer = mp4Buffer.buffer;
        outMime      = 'video/mp4';
      }
    } catch (remuxErr) {
      console.warn('[DLHelper] Remux failed, saving as .ts:', remuxErr.message);
      outName  = cleanName + '.ts';
      outMime  = 'video/mp2t';
    }

    // ── Step 5: Save ──────────────────────────────────────────────────────
    // Offscreen has URL.createObjectURL; background has chrome.downloads.
    // We create the Blob URL here and ask background to trigger the download.
    report(jobId, { state:'saving', segDone, segTotal, bytesDone, progress:100, stateLabel:'Saving file…' });

    const blob    = new Blob([outputBuffer], { type: outMime });
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      type:     'OFFSCREEN_DOWNLOAD',
      jobId,
      blobUrl,
      fileName: outName,
    }, (resp) => {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
      activeJobs.delete(jobId);
      if (!resp || resp.error) {
        report(jobId, { state:'error', error: resp?.error || 'Download failed' });
      } else {
        report(jobId, { state:'complete', downloadId: resp.downloadId, segDone, segTotal,
          bytesDone, bytesDoneFmt: fmtBytes(bytesDone)||'0 B', stateLabel:'Complete' });
      }
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

console.log('[Media DLHelper] Offscreen document ready.');
