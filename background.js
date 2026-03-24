// ============================
// ClipCatch - Background Service Worker
// HLS assembly delegated to offscreen document (has real DOM APIs)
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

const TAB_MEDIA_KEY   = 'tabMedia';
const tabMediaStore   = new Map();
const activeDownloads = new Map();
const speedSamples    = new Map();

// ── HLS Job state (lives in background, populated via progress reports from offscreen) ──
// jobId -> { id, url, fileName, state, segTotal, segDone, bytesDone, error, downloadId, startTime, speed, eta, … }
const hlsJobs = new Map();
let hlsJobCounter = 0;

// ── Offscreen document management ─────────────────────────────────────────
let offscreenReady = false;

async function ensureOffscreen() {
  // Check if already exists
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) { offscreenReady = true; return; }

  await chrome.offscreen.createDocument({
    url:           chrome.runtime.getURL('offscreen.html'),
    reasons:       ['BLOBS'],
    justification: 'Assemble HLS/DASH segments into a Blob for download',
  });
  offscreenReady = true;
}

async function closeOffscreen() {
  const exists = await chrome.offscreen.hasDocument().catch(() => false);
  if (exists) await chrome.offscreen.closeDocument().catch(() => {});
  offscreenReady = false;
}

// Close offscreen when no active HLS jobs remain
function maybeCloseOffscreen() {
  const anyActive = [...hlsJobs.values()].some(j =>
    j.state === 'fetching' || j.state === 'downloading' ||
    j.state === 'merging'  || j.state === 'saving'
  );
  if (!anyActive) closeOffscreen();
}

// ── Keep service worker alive during HLS downloads ─────────────────────────
chrome.alarms.create('hlsKeepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hlsKeepalive') {
    const anyActive = [...hlsJobs.values()].some(j =>
      j.state === 'fetching'||j.state==='downloading'||j.state==='merging'||j.state==='saving'
    );
    if (anyActive) broadcastHLSJobs();
  }
});

// ── Format helpers ─────────────────────────────────────────────────────────
function fmtBytes(b) {
  if(!b||b<=0) return null;
  const u=['B','KB','MB','GB']; let v=b,i=0;
  while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(1)} ${u[i]}`;
}
function fmtSpeed(bps){return bps>0?(fmtBytes(bps)||'')+'/s':'';}
function fmtEta(left,bps){if(!bps||bps<=0||!left||left<=0)return '';const s=Math.round(left/bps);if(s<60)return`${s}s`;if(s<3600)return`${Math.floor(s/60)}m ${s%60}s`;return`${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;}

// ── HLS job broadcasting ───────────────────────────────────────────────────
function hlsStateLabel(j) {
  switch(j.state) {
    case 'fetching':    return 'Fetching playlist…';
    case 'downloading': return `Downloading segments (${j.segDone}/${j.segTotal})`;
    case 'merging':     return 'Merging segments…';
    case 'saving':      return 'Saving file…';
    case 'complete':    return 'Complete';
    case 'error':       return `Error: ${truncateErr(j.error)}`;
    case 'cancelled':   return 'Cancelled';
    default:            return j.state;
  }
}
function truncateErr(msg) {
  if (!msg) return 'Unknown error';
  return msg.replace(/https?:\/\/[^\s,;)]+/g, u => { try{return new URL(u).hostname+'/…';}catch{return u.slice(0,40)+'…';} }).substring(0,100);
}
function broadcastHLSJobs() {
  const jobs = [...hlsJobs.values()].map(j => ({
    id:j.id, url:j.url, fileName:j.fileName, state:j.state,
    segTotal:j.segTotal||0, segDone:j.segDone||0,
    bytesDone:j.bytesDone||0,
    error:j.error||null, downloadId:j.downloadId||null, startTime:j.startTime,
    progress:j.segTotal>0?Math.round((j.segDone/j.segTotal)*100):-1,
    bytesDoneFmt:fmtBytes(j.bytesDone)||'0 B',
    speed:j.speed||0, speedFmt:fmtSpeed(j.speed||0), eta:j.eta||'',
    stateLabel:hlsStateLabel(j),
  }));
  chrome.runtime.sendMessage({type:'HLS_JOBS_UPDATE',jobs}).catch(()=>{});
}

// ── chrome.downloads tracking ──────────────────────────────────────────────
// IMPORTANT: we only track downloads that WE started (ids in ourDownloadIds).
// Never auto-ingest every Chrome download — that causes stale history on reopen.
const ourDownloadIds = new Set();

function recordSample(id,bytes){if(!speedSamples.has(id))speedSamples.set(id,[]);const s=speedSamples.get(id);s.push({bytes,time:Date.now()});if(s.length>5)s.shift();}
function calcSpeed(id){const s=speedSamples.get(id);if(!s||s.length<2)return 0;const dt=(s[s.length-1].time-s[0].time)/1000,db=s[s.length-1].bytes-s[0].bytes;return dt>0?db/dt:0;}

// onCreated fires for ALL Chrome downloads — ignore any we didn't start
chrome.downloads.onCreated.addListener((item)=>{
  if(!ourDownloadIds.has(item.id)) return;
  const dl=activeDownloads.get(item.id);
  if(dl){dl.totalBytes=item.totalBytes||0; activeDownloads.set(item.id,dl); broadcastDownloads();}
});

chrome.downloads.onChanged.addListener((delta)=>{
  const id=delta.id;
  if(!activeDownloads.has(id)) return; // ignore downloads not started by us
  const dl=activeDownloads.get(id);
  if(delta.bytesReceived){dl.bytesReceived=delta.bytesReceived.current;recordSample(id,dl.bytesReceived);dl.speed=calcSpeed(id);}
  if(delta.totalBytes) dl.totalBytes=delta.totalBytes.current;
  if(delta.filename)   dl.fileName=delta.filename.current||dl.fileName;
  if(delta.paused)     dl.paused=delta.paused.current;
  if(delta.error)      dl.error=delta.error.current;
  if(delta.state){dl.state=delta.state.current;if(dl.state==='complete'){dl.progress=100;dl.speed=0;dl.eta='';speedSamples.delete(id);}if(dl.state==='interrupted')speedSamples.delete(id);}
  if(dl.totalBytes>0){dl.progress=Math.round((dl.bytesReceived/dl.totalBytes)*100);dl.eta=fmtEta(dl.totalBytes-dl.bytesReceived,dl.speed);}else{dl.progress=-1;dl.eta='';}
  activeDownloads.set(id,dl); broadcastDownloads();
});

// Poll only the specific IDs we own — never query all in-progress downloads
setInterval(()=>{
  const inProg=[...activeDownloads.values()].filter(d=>d.state==='in_progress');
  if(!inProg.length) return;
  for(const dl of inProg){
    chrome.downloads.search({id:dl.id},(items)=>{
      const item=items?.[0]; if(!item||!activeDownloads.has(item.id)) return;
      const d=activeDownloads.get(item.id);
      d.bytesReceived=item.bytesReceived||d.bytesReceived;
      d.totalBytes=item.totalBytes||d.totalBytes;
      d.paused=item.paused;
      recordSample(item.id,d.bytesReceived);
      d.speed=calcSpeed(item.id);
      d.progress=d.totalBytes>0?Math.round((d.bytesReceived/d.totalBytes)*100):-1;
      d.eta=d.totalBytes>0?fmtEta(d.totalBytes-d.bytesReceived,d.speed):'';
      activeDownloads.set(item.id,d);
    });
  }
  broadcastDownloads();
},800);
function broadcastDownloads(){
  const list=[...activeDownloads.values()].map(dl=>({...dl,bytesFormatted:fmtBytes(dl.bytesReceived)||'0 B',totalFormatted:dl.totalBytes>0?fmtBytes(dl.totalBytes):'Unknown',speedFormatted:fmtSpeed(dl.speed),fileName:dl.fileName.split(/[/\\]/).pop()}));
  chrome.runtime.sendMessage({type:'DOWNLOADS_UPDATE',downloads:list}).catch(()=>{});
}

// ── Media classification ───────────────────────────────────────────────────
function getExt(url){try{const last=new URL(url).pathname.split('/').pop()||'';const dot=last.lastIndexOf('.');return dot>=0?last.slice(dot+1).toLowerCase().split('?')[0]:'';}catch(e){return '';}}
function getFileName(url){try{const parts=new URL(url).pathname.split('/');const name=parts[parts.length-1];return name?decodeURIComponent(name):'media_file';}catch(e){return 'media_file';}}
function extractDirectUrl(url){try{const u=new URL(url);const parts=u.pathname.split('/');for(let i=parts.length-2;i>=1;i--){const seg=parts[i];const dot=seg.lastIndexOf('.');if(dot<0)continue;const ext=seg.slice(dot+1).toLowerCase();if(DIRECT_VIDEO_EXTS.has(ext)||DIRECT_AUDIO_EXTS.has(ext)){const d=new URL(u.origin+parts.slice(0,i+1).join('/'));if(u.search)d.search=u.search;return d.href;}}}catch(e){}return null;}
function classify(url,mimeType){
  const ext=getExt(url),mime=(mimeType||'').toLowerCase().split(';')[0].trim();
  if(HARD_DENY_EXTS.has(ext))return null;
  for(const p of HARD_DENY_MIME_PREFIXES){if(mime.startsWith(p))return null;}
  if(STREAM_PLAYLIST_EXTS.has(ext))return 'stream';
  for(const m of STREAM_PLAYLIST_MIME){if(mime.includes(m))return 'stream';}
  if(mime.includes('mpegurl')||mime.includes('dash+xml'))return 'stream';
  if(DIRECT_VIDEO_EXTS.has(ext))return 'video';if(mime.startsWith('video/'))return 'video';
  if(DIRECT_AUDIO_EXTS.has(ext))return 'audio';if(mime.startsWith('audio/'))return 'audio';
  if(mime==='application/octet-stream'){if(DIRECT_VIDEO_EXTS.has(ext))return 'video';if(DIRECT_AUDIO_EXTS.has(ext))return 'audio';if(STREAM_PLAYLIST_EXTS.has(ext))return 'stream';return null;}
  return null;
}
function buildName(url,type,directUrl){
  if(type==='stream'){if(directUrl)return getFileName(directUrl)+' (stream)';try{const IGNORE=/^(hls|dash|stream|media|video|manifest|playlist|index|master|chunklist)$/i;const parts=new URL(url).pathname.split('/').filter(Boolean);for(let i=parts.length-2;i>=0;i--){const seg=decodeURIComponent(parts[i]);if(seg&&!IGNORE.test(seg))return seg+' (stream)';}}catch(e){}return 'stream_playlist.m3u8';}
  return getFileName(url)||'media_file';
}
function updateBadge(tabId){const n=tabMediaStore.get(tabId)?.size||0;chrome.action.setBadgeText({text:n>0?String(n):'',tabId});chrome.action.setBadgeBackgroundColor({color:n>0?'#e05c1a':'#888888',tabId});}
function persistTab(tabId){const store=tabMediaStore.get(tabId);if(!store)return;const key=`${TAB_MEDIA_KEY}_${tabId}`;const items=[...store.values()];chrome.storage.session.set({[key]:items}).catch(()=>chrome.storage.local.set({[key]:items}));}
function addMedia(tabId,url,details){
  const type=classify(url,details.mimeType);if(!type)return;
  if(!tabMediaStore.has(tabId))tabMediaStore.set(tabId,new Map());
  const store=tabMediaStore.get(tabId);
  // If URL already stored, only update thumbnail if we now have one
  if(store.has(url)){
    if(details.thumbnail){const ex=store.get(url);if(!ex.thumbnail){ex.thumbnail=details.thumbnail;persistTab(tabId);}}
    return;
  }
  const directUrl=type==='stream'?extractDirectUrl(url):null;
  if(directUrl&&!store.has(directUrl)){store.set(directUrl,{url:directUrl,type:'video',fileName:getFileName(directUrl),mimeType:'video/mp4',size:0,sizeFormatted:'Unknown',timestamp:Date.now(),tabId,pageUrl:details.pageUrl||'',isStream:false,directUrl:null,thumbnail:null,ytdlpCommand:null,ffmpegCommand:null});}
  store.set(url,{url,type,fileName:buildName(url,type,directUrl),mimeType:details.mimeType||'',size:details.size||0,sizeFormatted:type==='stream'?'HLS/DASH':(fmtBytes(details.size)||'Unknown'),timestamp:Date.now(),tabId,pageUrl:details.pageUrl||'',isStream:type==='stream',directUrl:directUrl||null,thumbnail:details.thumbnail||null,ytdlpCommand:`yt-dlp "${url}"`,ffmpegCommand:`ffmpeg -i "${url}" -c copy output.mp4`});
  updateBadge(tabId);persistTab(tabId);
}
function clearTab(tabId){tabMediaStore.delete(tabId);updateBadge(tabId);const key=`${TAB_MEDIA_KEY}_${tabId}`;chrome.storage.session.remove(key).catch(()=>chrome.storage.local.remove(key));}

// ── Network listener ───────────────────────────────────────────────────────
chrome.webRequest.onResponseStarted.addListener(
  (details)=>{if(details.tabId<0)return;let mimeType='',size=0;for(const h of(details.responseHeaders||[])){const n=h.name.toLowerCase();if(n==='content-type')mimeType=h.value;if(n==='content-length')size=parseInt(h.value,10)||0;}addMedia(details.tabId,details.url,{mimeType,size,pageUrl:details.initiator||''}); },
  {urls:['<all_urls>']},['responseHeaders']
);

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{

  // ── Progress reports from offscreen document ───────────────────────────
  if(msg.type==='HLS_PROGRESS'){
    const job=hlsJobs.get(msg.jobId);
    if(job){
      Object.assign(job, msg);   // merge all progress fields
      delete job.type;
      broadcastHLSJobs();
      if(job.state==='complete'||job.state==='error'||job.state==='cancelled'){
        maybeCloseOffscreen();
      }
    }
    respond({success:true}); return true;
  }

  if(msg.type==='GET_MEDIA'){const store=tabMediaStore.get(msg.tabId);respond({media:store?[...store.values()]:[]});return true;}
  if(msg.type==='CLEAR_MEDIA'){clearTab(msg.tabId);respond({success:true});return true;}

  if(msg.type==='DOWNLOAD_MEDIA'){
    chrome.downloads.download({url:msg.url,filename:msg.fileName,saveAs:msg.saveAs||false},(id)=>{
      if(chrome.runtime.lastError||id==null){respond({success:false,error:chrome.runtime.lastError?.message});}
      else{ourDownloadIds.add(id); activeDownloads.set(id,{id,url:msg.url,fileName:msg.fileName.split(/[/\\]/).pop(),state:'in_progress',bytesReceived:0,totalBytes:0,startTime:Date.now(),speed:0,eta:'',error:null,paused:false,progress:-1,bytesFormatted:'0 B',totalFormatted:'Unknown',speedFormatted:''});broadcastDownloads();respond({success:true,downloadId:id});}
    }); return true;
  }

  // ── Start HLS download ─────────────────────────────────────────────────
  if(msg.type==='DOWNLOAD_HLS'){
    const jobId=`hls_${++hlsJobCounter}_${Date.now()}`;
    hlsJobs.set(jobId,{
      id:jobId, url:msg.url, fileName:msg.fileName||'stream',
      state:'fetching', segTotal:0, segDone:0, bytesDone:0,
      error:null, downloadId:null, startTime:Date.now(), speed:0, eta:'',
    });
    broadcastHLSJobs();
    respond({success:true,jobId});

    // Ensure offscreen doc is running, then forward the job
    ensureOffscreen().then(()=>{
      chrome.runtime.sendMessage({type:'START_HLS_JOB', jobId, url:msg.url, fileName:msg.fileName||'stream'}).catch(err=>{
        const job=hlsJobs.get(jobId);
        if(job){job.state='error';job.error='Could not reach offscreen document: '+err.message;broadcastHLSJobs();}
      });
    }).catch(err=>{
      const job=hlsJobs.get(jobId);
      if(job){job.state='error';job.error='Failed to create offscreen document: '+err.message;broadcastHLSJobs();}
    });
    return true;
  }

  if(msg.type==='CANCEL_HLS'){
    const job=hlsJobs.get(msg.jobId);
    if(job){
      job.state='cancelled'; broadcastHLSJobs();
      // Tell offscreen to abort
      chrome.runtime.sendMessage({type:'CANCEL_HLS_JOB',jobId:msg.jobId}).catch(()=>{});
      maybeCloseOffscreen();
    }
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

  if(msg.type==='CANCEL_DOWNLOAD'){chrome.downloads.cancel(msg.downloadId,()=>{activeDownloads.delete(msg.downloadId);speedSamples.delete(msg.downloadId);broadcastDownloads();respond({success:true});});return true;}
  if(msg.type==='PAUSE_DOWNLOAD') {chrome.downloads.pause(msg.downloadId,()=>respond({success:true}));return true;}
  if(msg.type==='RESUME_DOWNLOAD'){chrome.downloads.resume(msg.downloadId,()=>respond({success:true}));return true;}
  if(msg.type==='SHOW_DOWNLOAD')  {chrome.downloads.show(msg.downloadId);respond({success:true});return true;}

  if(msg.type==='OPEN_COMMANDS'){
    const data=msg.data;
    const save=(cb)=>{chrome.storage.session.set({pendingStreamCommands:data},()=>{chrome.storage.local.set({pendingStreamCommands:data},cb);});};
    save(()=>{chrome.windows.create({url:chrome.runtime.getURL('commands.html'),type:'popup',width:620,height:720,focused:true});respond({success:true});});
    return true;
  }

  if(msg.type==='CONTENT_MEDIA'){
    const tabId=sender.tab?.id??-1;
    if(tabId>=0&&msg.items){for(const item of msg.items){addMedia(tabId,item.url,{mimeType:item.mimeType||'',size:0,pageUrl:item.pageUrl||'',thumbnail:item.thumbnail||null});}}
    respond({success:true}); return true;
  }
});

// ── Tab lifecycle ──────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{if(changeInfo.status==='loading'&&changeInfo.url)clearTab(tabId);});
chrome.tabs.onRemoved.addListener((tabId)=>{clearTab(tabId);const key=`${TAB_MEDIA_KEY}_${tabId}`;chrome.storage.session.remove(key).catch(()=>chrome.storage.local.remove(key));});

// Cleanup old finished jobs after 2min
setInterval(()=>{const now=Date.now();for(const[id,j]of hlsJobs){if((j.state==='complete'||j.state==='error'||j.state==='cancelled')&&(now-j.startTime>120000))hlsJobs.delete(id);}},60000);
setInterval(()=>{const now=Date.now();for(const[id,dl]of activeDownloads){if((dl.state==='complete'||dl.state==='interrupted')&&(now-dl.startTime>60000)){activeDownloads.delete(id);speedSamples.delete(id);}}},30000);

console.log('[ClipCatch] — offscreen HLS assembly engine ready.');
