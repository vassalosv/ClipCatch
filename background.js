// ============================
// Media DownloadHelper - Background v6
// HLS/DASH segment assembler built-in
// ============================

// ── Deny / Allow lists ─────────────────────────────────────────────────────
const HARD_DENY_EXTS = new Set([
  'ts','fmp4','m4s','cmfv','cmfa',
  'webmanifest','manifest','appcache',
  'json','xml','html','htm','xhtml','css','js','mjs','map',
  'png','jpg','jpeg','gif','webp','svg','ico','bmp','tiff','avif',
  'woff','woff2','ttf','eot','otf',
  'pdf','txt','csv','vtt','srt','ass','ssa',
  'gz','br','zip','tar',
]);
const HARD_DENY_MIME_PREFIXES = [
  'text/','image/','font/',
  'application/json','application/manifest','application/xml',
  'application/javascript','application/x-javascript',
];
const DIRECT_VIDEO_EXTS = new Set(['mp4','webm','mkv','avi','mov','flv','wmv','mpeg','mpg','m4v','f4v','3gp','ogv','ogm']);
const DIRECT_AUDIO_EXTS = new Set(['mp3','aac','ogg','flac','wav','m4a','opus','wma','f4a']);
const STREAM_PLAYLIST_EXTS = new Set(['m3u8','mpd']);
const STREAM_PLAYLIST_MIME = [
  'application/x-mpegurl','application/vnd.apple.mpegurl','application/dash+xml',
];

// ── Storage ────────────────────────────────────────────────────────────────
const TAB_MEDIA_KEY   = 'tabMedia';
const tabMediaStore   = new Map();
const activeDownloads = new Map(); // chrome.downloads tracking
const speedSamples    = new Map();

// ── HLS Job tracking ───────────────────────────────────────────────────────
// jobId -> { id, url, fileName, state, segTotal, segDone, bytesDone, bytesTotal,
//            cancelled, error, downloadId, startTime }
const hlsJobs = new Map();
let hlsJobCounter = 0;

// ── Keep service worker alive during HLS downloads ─────────────────────────
// Chrome MV3 SW can be killed after ~30s inactivity. We use an alarm to keep it alive.
chrome.alarms.create('hlsKeepalive', { periodInMinutes: 0.4 }); // every ~24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hlsKeepalive') {
    // Just touching hlsJobs is enough to keep the SW awake
    const active = [...hlsJobs.values()].filter(j => j.state === 'downloading' || j.state === 'fetching');
    if (active.length > 0) broadcastHLSJobs();
  }
});

// ── Format helpers ─────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (!b || b <= 0) return null;
  const u = ['B','KB','MB','GB']; let v=b, i=0;
  while (v>=1024 && i<u.length-1) { v/=1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}
function fmtSpeed(bps) { return bps>0 ? (fmtBytes(bps)||'')+ '/s' : ''; }
function fmtEta(left, bps) {
  if (!bps||bps<=0||!left||left<=0) return '';
  const s=Math.round(left/bps);
  if(s<60) return `${s}s`; if(s<3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

// ── chrome.downloads tracking ──────────────────────────────────────────────
function recordSample(id, bytes) {
  if (!speedSamples.has(id)) speedSamples.set(id, []);
  const s = speedSamples.get(id);
  s.push({ bytes, time: Date.now() });
  if (s.length > 5) s.shift();
}
function calcSpeed(id) {
  const s = speedSamples.get(id);
  if (!s||s.length<2) return 0;
  const dt=(s[s.length-1].time-s[0].time)/1000, db=s[s.length-1].bytes-s[0].bytes;
  return dt>0 ? db/dt : 0;
}
chrome.downloads.onCreated.addListener((item) => {
  activeDownloads.set(item.id,{
    id:item.id, url:item.url, fileName:item.filename||'file',
    state:'in_progress', bytesReceived:item.bytesReceived||0,
    totalBytes:item.totalBytes||0, startTime:Date.now(),
    speed:0, eta:'', error:null, paused:false, progress:-1,
  });
  recordSample(item.id, item.bytesReceived||0);
  broadcastDownloads();
});
chrome.downloads.onChanged.addListener((delta) => {
  const id=delta.id;
  if (!activeDownloads.has(id)) {
    chrome.downloads.search({id},(items)=>{
      if(items?.[0]){const d=items[0]; activeDownloads.set(id,{id,url:d.url,fileName:d.filename||'file',state:d.state||'in_progress',bytesReceived:d.bytesReceived||0,totalBytes:d.totalBytes||0,startTime:Date.now(),speed:0,eta:'',error:d.error||null,paused:d.paused||false,progress:-1}); broadcastDownloads();}
    }); return;
  }
  const dl=activeDownloads.get(id);
  if(delta.bytesReceived){dl.bytesReceived=delta.bytesReceived.current; recordSample(id,dl.bytesReceived); dl.speed=calcSpeed(id);}
  if(delta.totalBytes) dl.totalBytes=delta.totalBytes.current;
  if(delta.filename)   dl.fileName=delta.filename.current||dl.fileName;
  if(delta.paused)     dl.paused=delta.paused.current;
  if(delta.error)      dl.error=delta.error.current;
  if(delta.state){ dl.state=delta.state.current; if(dl.state==='complete'){dl.progress=100;dl.speed=0;dl.eta='';speedSamples.delete(id);} if(dl.state==='interrupted') speedSamples.delete(id); }
  if(dl.totalBytes>0){dl.progress=Math.round((dl.bytesReceived/dl.totalBytes)*100); dl.eta=fmtEta(dl.totalBytes-dl.bytesReceived,dl.speed);} else{dl.progress=-1;dl.eta='';}
  activeDownloads.set(id,dl); broadcastDownloads();
});
setInterval(()=>{
  const inProg=[...activeDownloads.values()].filter(d=>d.state==='in_progress');
  if(!inProg.length) return;
  chrome.downloads.search({state:'in_progress'},(items)=>{
    for(const item of(items||[])){const dl=activeDownloads.get(item.id); if(!dl) continue; dl.bytesReceived=item.bytesReceived||dl.bytesReceived; dl.totalBytes=item.totalBytes||dl.totalBytes; dl.paused=item.paused; recordSample(item.id,dl.bytesReceived); dl.speed=calcSpeed(item.id); dl.progress=dl.totalBytes>0?Math.round((dl.bytesReceived/dl.totalBytes)*100):-1; dl.eta=dl.totalBytes>0?fmtEta(dl.totalBytes-dl.bytesReceived,dl.speed):''; activeDownloads.set(item.id,dl);}
    broadcastDownloads();
  });
},800);
function broadcastDownloads() {
  const list=[...activeDownloads.values()].map(dl=>({...dl,bytesFormatted:fmtBytes(dl.bytesReceived)||'0 B',totalFormatted:dl.totalBytes>0?fmtBytes(dl.totalBytes):'Unknown',speedFormatted:fmtSpeed(dl.speed),fileName:dl.fileName.split(/[/\\]/).pop()}));
  chrome.runtime.sendMessage({type:'DOWNLOADS_UPDATE',downloads:list}).catch(()=>{});
}

// ═══════════════════════════════════════════════════════════════════════════
// HLS / DASH ASSEMBLER ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// Resolve a potentially relative URL against a base URL
function resolveUrl(rel, base) {
  try { return new URL(rel, base).href; } catch(e) { return rel; }
}

// Fetch text with error handling
async function fetchText(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// Fetch binary buffer — retries up to 4 times with exponential backoff.
// Handles 429 (Too Many Requests) and transient 5xx errors gracefully.
async function fetchBuffer(url, attempt = 0) {
  const MAX_ATTEMPTS = 4;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (resp.ok) return resp.arrayBuffer();

    if (resp.status === 429 || resp.status === 503) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${resp.status} after ${MAX_ATTEMPTS} retries`);
      const retryAfter = resp.headers.get('Retry-After');
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 16000);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchBuffer(url, attempt + 1);
    }
    if (resp.status >= 500 && attempt < MAX_ATTEMPTS) {
      const waitMs = Math.min(800 * Math.pow(2, attempt), 10000);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchBuffer(url, attempt + 1);
    }
    throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    if (attempt < MAX_ATTEMPTS && !(err.message.startsWith('HTTP'))) {
      const waitMs = Math.min(600 * Math.pow(2, attempt), 8000);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchBuffer(url, attempt + 1);
    }
    throw err;
  }
}

// Parse an HLS master playlist → array of {url, bandwidth, resolution}
function parseMasterPlaylist(text, baseUrl) {
  const lines   = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const variants = [];
  for (let i=0; i<lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch  = lines[i].match(/BANDWIDTH=(\d+)/i);
      const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/i);
      const url      = lines[i+1] && !lines[i+1].startsWith('#') ? resolveUrl(lines[i+1], baseUrl) : null;
      if (url) variants.push({ url, bandwidth: bwMatch?parseInt(bwMatch[1]):0, resolution: resMatch?resMatch[1]:'' });
    }
  }
  return variants;
}

// Parse an HLS media playlist → array of segment URLs
function parseMediaPlaylist(text, baseUrl) {
  const lines    = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const segments = [];
  for (const line of lines) {
    if (!line.startsWith('#') && line.length > 0) {
      segments.push(resolveUrl(line, baseUrl));
    }
  }
  return segments;
}

// Parse a simple MPEG-DASH MPD → array of segment URLs
// Supports SegmentTemplate with $Number$ and SegmentList
function parseMPD(text, baseUrl) {
  const segments = [];
  try {
    // SegmentTemplate with initialization + media
    const initMatch = text.match(/initialization="([^"]+)"/i);
    const mediaMatch = text.match(/media="([^"]+)"/i);
    const startMatch = text.match(/startNumber="(\d+)"/i);
    const durationMatch = text.match(/duration="(\d+)"/i);
    const timescaleMatch = text.match(/timescale="(\d+)"/i);
    const periodDurMatch = text.match(/mediaPresentationDuration="PT([\d.]+)S"/i);

    if (mediaMatch && durationMatch) {
      const template  = mediaMatch[1];
      const start     = startMatch ? parseInt(startMatch[1]) : 1;
      const duration  = parseInt(durationMatch[1]);
      const timescale = timescaleMatch ? parseInt(timescaleMatch[1]) : 1;
      const totalDur  = periodDurMatch ? parseFloat(periodDurMatch[1]) : 0;
      const count     = totalDur > 0 ? Math.ceil(totalDur * timescale / duration) : 100;

      for (let i=start; i<start+count; i++) {
        const url = resolveUrl(template.replace('$Number$', i).replace(/\$Number%\d+d\$/, String(i).padStart(6,'0')), baseUrl);
        segments.push(url);
      }
    }

    // SegmentList
    const segMatches = [...text.matchAll(/<SegmentURL\s+media="([^"]+)"/gi)];
    for (const m of segMatches) segments.push(resolveUrl(m[1], baseUrl));

    // BaseURL-based segments
    if (segments.length === 0) {
      const baseMatches = [...text.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/gi)];
      for (const m of baseMatches) {
        const url = resolveUrl(m[1].trim(), baseUrl);
        if (!segments.includes(url)) segments.push(url);
      }
    }
  } catch(e) {}
  return segments;
}

// Detect if playlist is HLS master (contains variant streams)
function isMasterPlaylist(text) {
  return text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:');
}

// Detect if this is DASH
function isDASH(url, text) {
  return url.endsWith('.mpd') || text.includes('<MPD ') || text.includes('urn:mpeg:dash');
}

// Broadcast HLS job progress to popup
function broadcastHLSJobs() {
  const jobs = [...hlsJobs.values()].map(j => ({
    id:         j.id,
    url:        j.url,
    fileName:   j.fileName,
    state:      j.state,         // 'fetching' | 'downloading' | 'merging' | 'saving' | 'complete' | 'error' | 'cancelled'
    segTotal:   j.segTotal,
    segDone:    j.segDone,
    bytesDone:  j.bytesDone,
    bytesTotal: j.bytesTotal,
    error:      j.error || null,
    downloadId: j.downloadId || null,
    startTime:  j.startTime,
    // Computed display fields
    progress:   j.segTotal > 0 ? Math.round((j.segDone / j.segTotal) * 100) : -1,
    bytesDoneFmt:  fmtBytes(j.bytesDone)  || '0 B',
    bytesTotalFmt: fmtBytes(j.bytesTotal) || '…',
    speed:      j.speed || 0,
    speedFmt:   fmtSpeed(j.speed || 0),
    eta:        j.eta || '',
    stateLabel: hlsStateLabel(j),
  }));
  chrome.runtime.sendMessage({ type: 'HLS_JOBS_UPDATE', jobs }).catch(()=>{});
}

function hlsStateLabel(j) {
  switch(j.state) {
    case 'fetching':    return 'Fetching playlist…';
    case 'downloading': return `Downloading segments (${j.segDone}/${j.segTotal})`;
    case 'merging':     return 'Merging segments…';
    case 'saving':      return 'Saving file…';
    case 'complete':    return 'Complete';
    case 'error':       return `Error: ${j.error}`;
    case 'cancelled':   return 'Cancelled';
    default:            return j.state;
  }
}

// Main HLS/DASH download function
async function runHLSDownload(jobId) {
  const job = hlsJobs.get(jobId);
  if (!job) return;

  const speedWindow = [];
  function updateSpeed(newBytes) {
    const now = Date.now();
    speedWindow.push({ bytes: newBytes, time: now });
    if (speedWindow.length > 8) speedWindow.shift();
    if (speedWindow.length >= 2) {
      const dt = (speedWindow[speedWindow.length-1].time - speedWindow[0].time) / 1000;
      const db = speedWindow[speedWindow.length-1].bytes - speedWindow[0].bytes;
      job.speed = dt > 0 ? db / dt : 0;
    }
    job.eta = job.bytesTotal > 0 ? fmtEta(job.bytesTotal - job.bytesDone, job.speed) : '';
  }

  try {
    // ── Step 1: Fetch playlist ────────────────────────────────────────────
    job.state = 'fetching';
    broadcastHLSJobs();

    const playlistText = await fetchText(job.url);
    if (job.cancelled) { job.state = 'cancelled'; broadcastHLSJobs(); return; }

    let segments = [];
    let mediaBaseUrl = job.url;

    if (isDASH(job.url, playlistText)) {
      // DASH MPD
      segments = parseMPD(playlistText, job.url);
    } else if (isMasterPlaylist(playlistText)) {
      // HLS master playlist — pick highest bandwidth variant
      const variants = parseMasterPlaylist(playlistText, job.url);
      if (variants.length === 0) throw new Error('No variants found in master playlist');
      variants.sort((a,b) => b.bandwidth - a.bandwidth);
      const best = variants[0];
      mediaBaseUrl = best.url;
      const mediaText = await fetchText(best.url);
      if (job.cancelled) { job.state='cancelled'; broadcastHLSJobs(); return; }
      segments = parseMediaPlaylist(mediaText, best.url);
    } else {
      // HLS media playlist directly
      segments = parseMediaPlaylist(playlistText, job.url);
    }

    if (segments.length === 0) throw new Error('No segments found in playlist');
    job.segTotal = segments.length;
    job.state = 'downloading';
    broadcastHLSJobs();

    // ── Step 2: Download all segments ─────────────────────────────────────
    const buffers = [];
    // Keep concurrency low (2) to avoid 429 rate-limiting from CDNs.
    // Add a short delay between batches so we don't hammer the server.
    const CONCURRENCY = 2;
    const BATCH_DELAY_MS = 120; // ms between batches

    for (let i = 0; i < segments.length; i += CONCURRENCY) {
      if (job.cancelled) { job.state='cancelled'; broadcastHLSJobs(); return; }

      const batch = segments.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (segUrl) => {
          const buf = await fetchBuffer(segUrl); // has built-in retry+backoff
          job.segDone++;
          job.bytesDone += buf.byteLength;
          updateSpeed(job.bytesDone);
          broadcastHLSJobs();
          return buf;
        })
      );
      buffers.push(...results);

      // Brief pause between batches — prevents 429 on rate-limited CDNs
      if (i + CONCURRENCY < segments.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    if (job.cancelled) { job.state='cancelled'; broadcastHLSJobs(); return; }

    // ── Step 3: Merge all segments into one buffer ─────────────────────────
    job.state = 'merging';
    broadcastHLSJobs();

    const totalSize = buffers.reduce((s,b) => s + b.byteLength, 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    // ── Step 4: Save via chrome.downloads ─────────────────────────────────
    job.state = 'saving';
    broadcastHLSJobs();

    // Output as .ts (MPEG-TS) — plays in VLC, MPC-HC, modern browsers
    const baseName  = job.fileName
      .replace(/\s*\(stream\)\s*/i, '')
      .replace(/\.(m3u8|mpd|ts)$/i, '');
    const outName = baseName + '.ts';

    // Service workers don't have URL.createObjectURL — convert to base64 data URL instead.
    // We do this in chunks to avoid call-stack overflow on large files.
    const CHUNK = 8192;
    let binary = '';
    for (let i = 0; i < merged.length; i += CHUNK) {
      binary += String.fromCharCode(...merged.subarray(i, i + CHUNK));
    }
    const dataUrl = 'data:video/mp2t;base64,' + btoa(binary);

    chrome.downloads.download({ url: dataUrl, filename: outName }, (dlId) => {
      if (chrome.runtime.lastError) {
        job.state = 'error';
        job.error = chrome.runtime.lastError.message;
      } else {
        job.state      = 'complete';
        job.downloadId = dlId;
      }
      broadcastHLSJobs();
    });

  } catch(err) {
    if (!job.cancelled) {
      job.state = 'error';
      job.error = err.message || String(err);
      broadcastHLSJobs();
    }
  }
}

// ── Media classification ───────────────────────────────────────────────────
function getExt(url) {
  try { const last=new URL(url).pathname.split('/').pop()||''; const dot=last.lastIndexOf('.'); return dot>=0?last.slice(dot+1).toLowerCase().split('?')[0]:''; } catch(e){return '';}
}
function getFileName(url) {
  try { const parts=new URL(url).pathname.split('/'); const name=parts[parts.length-1]; return name?decodeURIComponent(name):'media_file'; } catch(e){return 'media_file';}
}
function extractEmbeddedDirectUrl(url) {
  try {
    const u=new URL(url); const parts=u.pathname.split('/');
    for(let i=parts.length-2;i>=1;i--){const seg=parts[i]; const dot=seg.lastIndexOf('.'); if(dot<0) continue; const ext=seg.slice(dot+1).toLowerCase(); if(DIRECT_VIDEO_EXTS.has(ext)||DIRECT_AUDIO_EXTS.has(ext)){const direct=new URL(u.origin+parts.slice(0,i+1).join('/')); if(u.search) direct.search=u.search; return direct.href;}}
  } catch(e){}
  return null;
}
function classify(url, mimeType) {
  const ext=getExt(url); const mime=(mimeType||'').toLowerCase().split(';')[0].trim();
  if(HARD_DENY_EXTS.has(ext)) return null;
  for(const p of HARD_DENY_MIME_PREFIXES){if(mime.startsWith(p)) return null;}
  if(STREAM_PLAYLIST_EXTS.has(ext)) return 'stream';
  for(const m of STREAM_PLAYLIST_MIME){if(mime.includes(m)) return 'stream';}
  if(mime.includes('mpegurl')||mime.includes('dash+xml')) return 'stream';
  if(DIRECT_VIDEO_EXTS.has(ext)) return 'video';
  if(mime.startsWith('video/')) return 'video';
  if(DIRECT_AUDIO_EXTS.has(ext)) return 'audio';
  if(mime.startsWith('audio/')) return 'audio';
  if(mime==='application/octet-stream'){if(DIRECT_VIDEO_EXTS.has(ext)) return 'video'; if(DIRECT_AUDIO_EXTS.has(ext)) return 'audio'; if(STREAM_PLAYLIST_EXTS.has(ext)) return 'stream'; return null;}
  return null;
}
function buildName(url, type, directUrl) {
  if(type==='stream'){if(directUrl) return getFileName(directUrl)+' (stream)'; try{const IGNORE=/^(hls|dash|stream|media|video|manifest|playlist|index|master|chunklist)$/i; const parts=new URL(url).pathname.split('/').filter(Boolean); for(let i=parts.length-2;i>=0;i--){const seg=decodeURIComponent(parts[i]); if(seg&&!IGNORE.test(seg)) return seg+' (stream)';}}catch(e){} return 'stream_playlist.m3u8';}
  return getFileName(url)||'media_file';
}
function updateBadge(tabId) {
  const n=tabMediaStore.get(tabId)?.size||0;
  chrome.action.setBadgeText({text:n>0?String(n):'',tabId});
  chrome.action.setBadgeBackgroundColor({color:n>0?'#e05c1a':'#888888',tabId});
}
function persistTab(tabId) {
  const store=tabMediaStore.get(tabId); if(!store) return;
  const key=`${TAB_MEDIA_KEY}_${tabId}`; const items=[...store.values()];
  chrome.storage.session.set({[key]:items}).catch(()=>chrome.storage.local.set({[key]:items}));
}
function addMedia(tabId, url, details) {
  const type=classify(url,details.mimeType); if(!type) return;
  if(!tabMediaStore.has(tabId)) tabMediaStore.set(tabId,new Map());
  const store=tabMediaStore.get(tabId); if(store.has(url)) return;
  const directUrl=type==='stream'?extractEmbeddedDirectUrl(url):null;
  if(directUrl&&!store.has(directUrl)){store.set(directUrl,{url:directUrl,type:'video',fileName:getFileName(directUrl),mimeType:'video/mp4',size:0,sizeFormatted:'Unknown',timestamp:Date.now(),tabId,pageUrl:details.pageUrl||'',isStream:false,directUrl:null,ytdlpCommand:null,ffmpegCommand:null});}
  store.set(url,{url,type,fileName:buildName(url,type,directUrl),mimeType:details.mimeType||'',size:details.size||0,sizeFormatted:type==='stream'?'HLS/DASH':(fmtBytes(details.size)||'Unknown'),timestamp:Date.now(),tabId,pageUrl:details.pageUrl||'',isStream:type==='stream',directUrl:directUrl||null,ytdlpCommand:`yt-dlp "${url}"`,ffmpegCommand:`ffmpeg -i "${url}" -c copy output.mp4`});
  updateBadge(tabId); persistTab(tabId);
}
function clearTab(tabId) {
  tabMediaStore.delete(tabId); updateBadge(tabId);
  const key=`${TAB_MEDIA_KEY}_${tabId}`;
  chrome.storage.session.remove(key).catch(()=>chrome.storage.local.remove(key));
}

// ── Network listener ───────────────────────────────────────────────────────
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if(details.tabId<0) return;
    let mimeType='',size=0;
    for(const h of(details.responseHeaders||[])){const n=h.name.toLowerCase(); if(n==='content-type') mimeType=h.value; if(n==='content-length') size=parseInt(h.value,10)||0;}
    addMedia(details.tabId,details.url,{mimeType,size,pageUrl:details.initiator||''});
  },
  {urls:['<all_urls>']},['responseHeaders']
);

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {

  if(msg.type==='GET_MEDIA'){const store=tabMediaStore.get(msg.tabId); respond({media:store?[...store.values()]:[]}); return true;}
  if(msg.type==='CLEAR_MEDIA'){clearTab(msg.tabId); respond({success:true}); return true;}

  if(msg.type==='DOWNLOAD_MEDIA'){
    chrome.downloads.download({url:msg.url,filename:msg.fileName,saveAs:msg.saveAs||false},(id)=>{
      if(chrome.runtime.lastError||id==null){respond({success:false,error:chrome.runtime.lastError?.message});}
      else{activeDownloads.set(id,{id,url:msg.url,fileName:msg.fileName.split(/[/\\]/).pop(),state:'in_progress',bytesReceived:0,totalBytes:0,startTime:Date.now(),speed:0,eta:'',error:null,paused:false,progress:-1,bytesFormatted:'0 B',totalFormatted:'Unknown',speedFormatted:''}); broadcastDownloads(); respond({success:true,downloadId:id});}
    }); return true;
  }

  // ── START HLS DOWNLOAD ──────────────────────────────────────────────────
  if(msg.type==='DOWNLOAD_HLS'){
    const jobId = `hls_${++hlsJobCounter}_${Date.now()}`;
    const job = {
      id:        jobId,
      url:       msg.url,
      fileName:  msg.fileName || 'stream',
      state:     'fetching',
      segTotal:  0, segDone:  0,
      bytesDone: 0, bytesTotal: 0,
      cancelled: false,
      error:     null,
      downloadId:null,
      startTime: Date.now(),
      speed:     0,
      eta:       '',
    };
    hlsJobs.set(jobId, job);
    broadcastHLSJobs();
    respond({ success: true, jobId });
    // Start async - don't await
    runHLSDownload(jobId);
    return true;
  }

  if(msg.type==='CANCEL_HLS'){
    const job=hlsJobs.get(msg.jobId);
    if(job){job.cancelled=true; job.state='cancelled'; broadcastHLSJobs();}
    respond({success:true}); return true;
  }

  if(msg.type==='GET_HLS_JOBS'){
    const jobs=[...hlsJobs.values()].map(j=>({...j,progress:j.segTotal>0?Math.round((j.segDone/j.segTotal)*100):-1,bytesDoneFmt:fmtBytes(j.bytesDone)||'0 B',bytesTotalFmt:fmtBytes(j.bytesTotal)||'…',speedFmt:fmtSpeed(j.speed||0),stateLabel:hlsStateLabel(j)}));
    respond({jobs}); return true;
  }

  if(msg.type==='GET_DOWNLOADS'){
    const list=[...activeDownloads.values()].map(dl=>({...dl,bytesFormatted:fmtBytes(dl.bytesReceived)||'0 B',totalFormatted:dl.totalBytes>0?fmtBytes(dl.totalBytes):'Unknown',speedFormatted:fmtSpeed(dl.speed),fileName:dl.fileName.split(/[/\\]/).pop()}));
    respond({downloads:list}); return true;
  }

  if(msg.type==='CANCEL_DOWNLOAD'){chrome.downloads.cancel(msg.downloadId,()=>{activeDownloads.delete(msg.downloadId);speedSamples.delete(msg.downloadId);broadcastDownloads();respond({success:true});}); return true;}
  if(msg.type==='PAUSE_DOWNLOAD') {chrome.downloads.pause(msg.downloadId,()=>respond({success:true})); return true;}
  if(msg.type==='RESUME_DOWNLOAD'){chrome.downloads.resume(msg.downloadId,()=>respond({success:true})); return true;}
  if(msg.type==='SHOW_DOWNLOAD')  {chrome.downloads.show(msg.downloadId); respond({success:true}); return true;}

  if(msg.type==='OPEN_COMMANDS'){
    const data=msg.data;
    const save=(cb)=>{chrome.storage.session.set({pendingStreamCommands:data},()=>{chrome.storage.local.set({pendingStreamCommands:data},cb);});};
    save(()=>{chrome.windows.create({url:chrome.runtime.getURL('commands.html'),type:'popup',width:620,height:720,focused:true}); respond({success:true});});
    return true;
  }

  if(msg.type==='CONTENT_MEDIA'){
    const tabId=sender.tab?.id??-1;
    if(tabId>=0&&msg.items){for(const item of msg.items){addMedia(tabId,item.url,{mimeType:item.mimeType||'',size:0,pageUrl:item.pageUrl||'',});}}
    respond({success:true}); return true;
  }
});

// ── Tab lifecycle ──────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{if(changeInfo.status==='loading'&&changeInfo.url) clearTab(tabId);});
chrome.tabs.onRemoved.addListener((tabId)=>{clearTab(tabId); const key=`${TAB_MEDIA_KEY}_${tabId}`; chrome.storage.session.remove(key).catch(()=>chrome.storage.local.remove(key));});

// Cleanup old completed/error jobs after 2 minutes
setInterval(()=>{const now=Date.now(); for(const[id,j] of hlsJobs){if((j.state==='complete'||j.state==='error'||j.state==='cancelled')&&(now-j.startTime>120000)) hlsJobs.delete(id);}},60000);
setInterval(()=>{const now=Date.now(); for(const[id,dl] of activeDownloads){if((dl.state==='complete'||dl.state==='interrupted')&&(now-dl.startTime>60000)){activeDownloads.delete(id);speedSamples.delete(id);}}},30000);

console.log('[Media DownloadHelper] v6 — HLS/DASH assembler engine active.');
