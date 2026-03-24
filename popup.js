// ============================
// ClipCatch - Popup
// HLS assembler + download tracking
// ============================
'use strict';

let allMedia       = [];
let filteredMedia  = [];
let selectedUrls   = new Set();
let currentFilter  = 'all';
let currentTabId   = null;
let mediaPoller    = null;
let downloadPoller = null;
let trackedDownloads = [];
let trackedHLSJobs   = [];

const $ = id => document.getElementById(id);

const mediaList    = $('mediaList');
const emptyState   = $('emptyState');
const selectAllBtn = $('selectAllBtn');
const selectCount  = $('selectCount');
const dlSelBtn     = $('downloadSelectedBtn');
const toastWrap    = $('toastContainer');
const footerTab    = $('footerTabInfo');
const dlPanelList  = $('downloadPanelList');
const dlPanelBadge = $('dlPanelBadge');

const countEls = {
  video:$('countVideo'), audio:$('countAudio'),
  stream:$('countStream'), media:$('countOther'),
};

const TYPE_META = {
  video:{icon:'🎬',label:'VIDEO'}, audio:{icon:'🎵',label:'AUDIO'},
  stream:{icon:'📡',label:'STREAM'}, media:{icon:'📎',label:'MEDIA'},
};

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function shortUrl(url){try{const u=new URL(url);const p=u.pathname.length>34?'…'+u.pathname.slice(-32):u.pathname;return u.hostname+p;}catch{return url.length>54?url.slice(0,51)+'…':url;}}
function cleanName(n){return(n||'media_file').replace(/[/\\:*?"<>|]/g,'_').substring(0,120);}

function truncateError(msg) {
  if (!msg) return 'Unknown error';
  // Shorten any embedded URL to just the hostname
  return msg.replace(/https?:\/\/[^\s,;)]+/g, url => {
    try { return new URL(url).hostname + '/…'; } catch { return url.slice(0, 40) + '…'; }
  }).substring(0, 100);
}

function showToast(msg,type='info'){
  const el=document.createElement('div');
  el.className=`toast ${type}`; el.textContent=msg;
  toastWrap.appendChild(el);
  setTimeout(()=>el.remove(),2600);
}
function copyText(text,label){
  navigator.clipboard.writeText(text)
    .then(()=>showToast(`📋 ${label} copied`,'success'))
    .catch(()=>{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);showToast(`📋 ${label} copied`,'success');});
}

// ── Stats ──────────────────────────────────────────────────────────────────
function updateStats(){
  const c={video:0,audio:0,stream:0,media:0};
  for(const m of allMedia){const t=m.type||'media';if(c[t]!==undefined)c[t]++;else c.media++;}
  for(const[k,el]of Object.entries(countEls)){el.textContent=c[k]||0;el.classList.toggle('has-items',(c[k]||0)>0);}
}
function updateSelectCount(){const n=selectedUrls.size;selectCount.textContent=n>0?`${n} selected`:'';dlSelBtn.style.opacity=n===0?'0.5':'1';}
function applyFilter(){filteredMedia=currentFilter==='all'?[...allMedia]:allMedia.filter(m=>m.type===currentFilter);renderList();}

// ── Media list render ──────────────────────────────────────────────────────
function renderList(){
  mediaList.querySelectorAll('.media-item').forEach(e=>e.remove());
  if(filteredMedia.length===0){emptyState.style.display='flex';return;}
  emptyState.style.display='none';
  [...filteredMedia].reverse().forEach(item=>mediaList.appendChild(createItem(item)));
}

function createItem(item){
  const type=item.type||'media';
  const meta=TYPE_META[type]||TYPE_META.media;
  const div=document.createElement('div');
  div.className=`media-item type-${type}`;
  div.dataset.url=item.url;
  if(selectedUrls.has(item.url)) div.classList.add('selected');

  // Stream items get: [⬇ Merge] [⬇ Try Direct] [⌘ commands] [⎘ copy]
  // Video/audio items get: [⬇ Download] [⎘ copy]
  let actionBtns = '';
  let streamNote = '';
  if(item.isStream){
    actionBtns=`
      <button class="action-btn merge-btn" title="Download & merge all segments (built-in)">⬇ Merge</button>
      <button class="action-btn try-btn" title="Try direct HTTP download">↗</button>
      <button class="action-btn cmd-btn" title="yt-dlp / ffmpeg commands">⌘</button>`;
    streamNote = item.directUrl
      ? `<span class="direct-hint" title="Direct MP4 found — use ↗ button">📥 direct</span>`
      : `<span class="stream-tag">HLS/DASH</span>`;
  } else {
    actionBtns=`<button class="action-btn download-btn" title="Download">⬇</button>`;
  }

  div.innerHTML=`
    <div class="item-checkbox">${selectedUrls.has(item.url)?'✓':''}</div>
    <div class="item-type-icon">${meta.icon}</div>
    <div class="item-info">
      <div class="item-name" title="${esc(item.fileName)}">${esc(item.fileName)}</div>
      <div class="item-meta">
        <span class="badge badge-${type}">${meta.label}</span>
        <span class="item-size">${esc(item.sizeFormatted||'')}</span>
        ${streamNote}
      </div>
      <div class="item-url" title="${esc(item.url)}">${esc(shortUrl(item.url))}</div>
    </div>
    <div class="item-actions">
      <button class="action-btn copy-btn" title="Copy URL">⎘</button>
      ${actionBtns}
    </div>`;

  // Selection
  div.addEventListener('click',e=>{
    if(e.target.closest('.action-btn')) return;
    if(selectedUrls.has(item.url)) selectedUrls.delete(item.url);
    else selectedUrls.add(item.url);
    div.classList.toggle('selected',selectedUrls.has(item.url));
    div.querySelector('.item-checkbox').textContent=selectedUrls.has(item.url)?'✓':'';
    updateSelectCount();
  });

  div.querySelector('.copy-btn').addEventListener('click',e=>{e.stopPropagation();copyText(item.url,'URL');});

  if(item.isStream){
    // ⬇ Merge — built-in HLS assembler
    div.querySelector('.merge-btn').addEventListener('click',e=>{
      e.stopPropagation();
      startHLSDownload(item);
    });
    // ↗ Try direct HTTP
    div.querySelector('.try-btn').addEventListener('click',e=>{
      e.stopPropagation();
      tryDirectDownload(item);
    });
    // ⌘ Commands window
    div.querySelector('.cmd-btn').addEventListener('click',e=>{
      e.stopPropagation();
      openCommandsWindow(item);
    });
  } else {
    div.querySelector('.download-btn').addEventListener('click',e=>{
      e.stopPropagation();
      startDirectDownload(item.url,item.fileName);
    });
  }
  return div;
}

// ── HLS built-in assembler ─────────────────────────────────────────────────
function startHLSDownload(item){
  const fileName = cleanName(item.fileName);
  switchTab('downloads');
  showToast('📡 Starting HLS assembler…','info');

  chrome.runtime.sendMessage({type:'DOWNLOAD_HLS', url:item.url, fileName}, (resp)=>{
    if(chrome.runtime.lastError||!resp?.success){
      showToast('⚠ Failed to start — try ⌘ for manual commands','info');
    } else {
      showToast('📡 Assembling segments… check Downloads tab','success');
      fetchAllProgress();
    }
  });
}

// ── Try direct download ────────────────────────────────────────────────────
function tryDirectDownload(item){
  const dlUrl  = item.directUrl||item.url;
  const rawName= dlUrl.split('/').pop().split('?')[0];
  const name   = cleanName(rawName.includes('.')?rawName:rawName+'.mp4');
  switchTab('downloads');
  showToast('⬇ Trying direct download…','info');

  chrome.runtime.sendMessage({type:'DOWNLOAD_MEDIA',url:dlUrl,fileName:name},(resp)=>{
    if(chrome.runtime.lastError||!resp?.success){
      showToast('⚠ Direct blocked — use ⬇ Merge or ⌘','info');
    } else {
      showToast('⬇ Download started!','success');
    }
  });
}

// ── Open commands window ───────────────────────────────────────────────────
function openCommandsWindow(item){
  chrome.runtime.sendMessage({type:'OPEN_COMMANDS',data:{url:item.url,fileName:item.fileName,directUrl:item.directUrl||null,ytdlpCommand:item.ytdlpCommand,ffmpegCommand:item.ffmpegCommand}},()=>{
    showToast('📡 Commands window opened','success');
  });
}

// ── Direct download (video/audio) ──────────────────────────────────────────
function startDirectDownload(url,fileName){
  const name=cleanName(fileName);
  switchTab('downloads');
  chrome.runtime.sendMessage({type:'DOWNLOAD_MEDIA',url,fileName:name},(resp)=>{
    if(chrome.runtime.lastError||!resp?.success){chrome.tabs.create({url});showToast('📂 Opened in new tab','info');}
    else showToast(`⬇ Download started: ${name}`,'success');
  });
}

function downloadSelected(){
  const streams=allMedia.filter(m=>selectedUrls.has(m.url)&&m.isStream);
  const direct =allMedia.filter(m=>selectedUrls.has(m.url)&&!m.isStream);
  streams.forEach((item,i)=>setTimeout(()=>startHLSDownload(item),i*200));
  direct.forEach((item,i)=>setTimeout(()=>startDirectDownload(item.url,item.fileName),(streams.length+i)*200));
  if(streams.length+direct.length>0) showToast(`⬇ Starting ${streams.length+direct.length} download(s)`,'success');
}

// ── Downloads panel ────────────────────────────────────────────────────────
function fetchAllProgress(){
  // Fetch both chrome.downloads and HLS jobs
  chrome.runtime.sendMessage({type:'GET_DOWNLOADS'},(resp)=>{
    if(resp?.downloads) trackedDownloads=resp.downloads;
  });
  chrome.runtime.sendMessage({type:'GET_HLS_JOBS'},(resp)=>{
    if(resp?.jobs) trackedHLSJobs=resp.jobs;
    renderDownloadsPanel();
  });
}

function updateBadge(){
  const activeHLS = trackedHLSJobs.filter(j=>j.state==='downloading'||j.state==='fetching'||j.state==='merging'||j.state==='saving').length;
  const activeDL  = trackedDownloads.filter(d=>d.state==='in_progress').length;
  const total = activeHLS + activeDL;
  dlPanelBadge.textContent = total>0 ? total : '';
  dlPanelBadge.style.display = total>0 ? 'inline-block' : 'none';
}

function renderDownloadsPanel(){
  updateBadge();
  if($('downloadsView').classList.contains('hidden')) return;

  const hasHLS = trackedHLSJobs.length>0;
  const hasDL  = trackedDownloads.length>0;

  if(!hasHLS && !hasDL){
    dlPanelList.innerHTML=`<div class="dl-empty"><div class="dl-empty-icon">📂</div><div>No downloads yet</div><div class="dl-empty-sub">Click ⬇ Merge on a stream or ⬇ on a video file</div></div>`;
    return;
  }

  dlPanelList.innerHTML='';

  // ── HLS Jobs first ─────────────────────────────────────────────────────
  if(hasHLS){
    const label=document.createElement('div');
    label.className='dl-section-label';
    label.textContent='📡 Stream Downloads (Built-in Assembler)';
    dlPanelList.appendChild(label);

    const sorted=[...trackedHLSJobs].sort((a,b)=>{
      const r=s=>['downloading','fetching','merging','saving'].includes(s)?0:s==='complete'?1:2;
      return r(a.state)-r(b.state);
    });
    sorted.forEach(job=>dlPanelList.appendChild(createHLSRow(job)));
  }

  // ── Direct downloads ───────────────────────────────────────────────────
  if(hasDL){
    const label=document.createElement('div');
    label.className='dl-section-label';
    label.textContent='⬇ Direct Downloads';
    dlPanelList.appendChild(label);

    const sorted=[...trackedDownloads].sort((a,b)=>{
      const r=s=>s==='in_progress'?0:s==='complete'?1:2;
      return r(a.state)-r(b.state);
    });
    sorted.forEach(dl=>dlPanelList.appendChild(createDLRow(dl)));
  }
}

// ── HLS job row ────────────────────────────────────────────────────────────
function createHLSRow(job){
  const div=document.createElement('div');
  const stateClass = job.state==='complete'?'hls-complete':job.state==='error'?'hls-error':job.state==='cancelled'?'hls-cancelled':'';
  div.className=`hls-row ${stateClass}`;
  div.dataset.jobId=job.id;

  const isActive=['downloading','fetching','merging','saving'].includes(job.state);
  const pct=job.progress>=0?job.progress:null;
  const indet=job.progress<0&&isActive;

  const icons={fetching:'🔍',downloading:'📡',merging:'🔧',saving:'💾',complete:'✅',error:'❌',cancelled:'⛔'};
  const icon=icons[job.state]||'📡';

  const bar = isActive ? `
    <div class="hls-progress-track">
      <div class="hls-progress-fill${indet?' indeterminate':''}" style="width:${pct!=null?pct:0}%"></div>
    </div>` : '';

  let metaHtml='';
  if(job.state==='downloading'){
    metaHtml=`<div class="hls-meta">
      <span class="hls-segs">${job.segDone}/${job.segTotal} segs</span>
      ${job.bytesDoneFmt?`<span class="hls-bytes">${job.bytesDoneFmt}</span>`:''}
      ${job.speedFmt?`<span class="hls-speed">${job.speedFmt}</span>`:''}
      ${job.eta?`<span class="hls-eta">ETA ${job.eta}</span>`:''}
    </div>`;
  } else if(job.state==='complete'){
    metaHtml=`<div class="hls-meta"><span class="hls-bytes dl-done">${job.segTotal} segs · ${job.bytesDoneFmt}</span></div>`;
  } else if(job.state==='error'){
    metaHtml=`<div class="hls-meta"><span class="hls-bytes dl-err">${esc(truncateError(job.error))}</span></div>`;
  }

  div.innerHTML=`
    <div class="hls-row-top">
      <span class="hls-icon">${icon}</span>
      <div class="hls-info">
        <div class="hls-name" title="${esc(job.fileName)}">${esc(job.fileName)}</div>
        <div class="hls-state">${esc(job.stateLabel||job.state)}</div>
      </div>
      <div class="hls-controls">
        <span class="hls-type-badge">HLS</span>
        ${isActive?`<button class="dl-btn dl-btn-cancel" data-action="cancel-hls" data-id="${esc(job.id)}" title="Cancel">✕</button>`:''}
        ${job.state==='complete'?`<span style="font-size:11px;color:var(--green);padding:0 4px">✓ Saved</span>`:''}
      </div>
    </div>
    ${bar}
    ${metaHtml}`;

  div.querySelectorAll('[data-action]').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const action=btn.dataset.action;
      if(action==='cancel-hls') chrome.runtime.sendMessage({type:'CANCEL_HLS',jobId:btn.dataset.id},()=>fetchAllProgress());
      if(action==='show-dl')    chrome.runtime.sendMessage({type:'SHOW_DOWNLOAD',downloadId:parseInt(btn.dataset.id,10)});
    });
  });

  return div;
}

// ── chrome.downloads row ───────────────────────────────────────────────────
function createDLRow(dl){
  const div=document.createElement('div');
  div.className=`dl-row dl-${dl.state}${dl.paused?' dl-paused':''}`;
  div.dataset.id=dl.id;
  const pct=dl.progress>=0?dl.progress:null;
  const indet=dl.progress<0&&dl.state==='in_progress';
  const stateIcon=dl.state==='complete'?'✅':dl.state==='interrupted'?'❌':dl.paused?'⏸':'⬇';
  const stateLabel=dl.state==='complete'?'Complete':dl.state==='interrupted'?(dl.error||'Failed'):dl.paused?'Paused':`${pct!=null?pct+'%':'…'}`;

  const bar=dl.state!=='complete'&&dl.state!=='interrupted'?`<div class="dl-progress-track"><div class="dl-progress-fill${indet?' indeterminate':''}" style="width:${pct!=null?pct:0}%"></div></div>`:'';
  const meta=dl.state==='in_progress'?`<div class="dl-meta"><span class="dl-bytes">${dl.bytesFormatted} / ${dl.totalFormatted}</span>${dl.speedFormatted?`<span class="dl-speed">${dl.speedFormatted}</span>`:''} ${dl.eta?`<span class="dl-eta">ETA ${dl.eta}</span>`:''}</div>`:dl.state==='complete'?`<div class="dl-meta"><span class="dl-bytes dl-done">${dl.totalFormatted||dl.bytesFormatted}</span></div>`:`<div class="dl-meta"><span class="dl-bytes dl-err">${dl.error||'Interrupted'}</span></div>`;

  div.innerHTML=`
    <div class="dl-row-top">
      <span class="dl-icon">${stateIcon}</span>
      <div class="dl-info">
        <div class="dl-name" title="${esc(dl.fileName)}">${esc(dl.fileName)}</div>
        <div class="dl-state-label">${esc(stateLabel)}</div>
      </div>
      <div class="dl-controls">
        ${dl.state==='in_progress'&&!dl.paused?`<button class="dl-btn" data-action="pause" data-id="${dl.id}" title="Pause">⏸</button>`:''}
        ${dl.state==='in_progress'&& dl.paused?`<button class="dl-btn" data-action="resume" data-id="${dl.id}" title="Resume">▶</button>`:''}
        ${dl.state==='in_progress'?`<button class="dl-btn dl-btn-cancel" data-action="cancel" data-id="${dl.id}" title="Cancel">✕</button>`:''}
        ${dl.state==='complete'?`<button class="dl-btn" data-action="show" data-id="${dl.id}" title="Show in folder">📁</button>`:''}
      </div>
    </div>
    ${bar}${meta}`;

  div.querySelectorAll('.dl-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const action=btn.dataset.action,id=parseInt(btn.dataset.id,10);
      if(action==='pause')  chrome.runtime.sendMessage({type:'PAUSE_DOWNLOAD',downloadId:id});
      if(action==='resume') chrome.runtime.sendMessage({type:'RESUME_DOWNLOAD',downloadId:id});
      if(action==='cancel') chrome.runtime.sendMessage({type:'CANCEL_DOWNLOAD',downloadId:id},()=>fetchAllProgress());
      if(action==='show')   chrome.runtime.sendMessage({type:'SHOW_DOWNLOAD',downloadId:id});
    });
  });
  return div;
}

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(tab){
  const mv=$('mediaView'),dv=$('downloadsView'),tm=$('tabMedia'),td=$('tabDownloads');
  if(tab==='downloads'){mv.classList.add('hidden');dv.classList.remove('hidden');tm.classList.remove('active');td.classList.add('active');renderDownloadsPanel();}
  else{dv.classList.add('hidden');mv.classList.remove('hidden');td.classList.remove('active');tm.classList.add('active');}
}

// ── Events ─────────────────────────────────────────────────────────────────
$('tabMedia').addEventListener('click',()=>switchTab('media'));
$('tabDownloads').addEventListener('click',()=>switchTab('downloads'));
document.querySelectorAll('.filter-tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); currentFilter=btn.dataset.filter;
    selectedUrls.clear(); applyFilter(); updateSelectCount();
  });
});
selectAllBtn.addEventListener('click',()=>{
  const allSel=filteredMedia.length>0&&filteredMedia.every(m=>selectedUrls.has(m.url));
  if(allSel){filteredMedia.forEach(m=>selectedUrls.delete(m.url));selectAllBtn.textContent='☑ Select All';}
  else{filteredMedia.forEach(m=>selectedUrls.add(m.url));selectAllBtn.textContent='☐ Deselect All';}
  renderList();updateSelectCount();
});
dlSelBtn.addEventListener('click',downloadSelected);
$('clearBtn').addEventListener('click',()=>{
  if(!currentTabId) return;
  chrome.runtime.sendMessage({type:'CLEAR_MEDIA',tabId:currentTabId},()=>{allMedia=[];filteredMedia=[];selectedUrls.clear();updateStats();applyFilter();updateSelectCount();showToast('✓ Cleared','info');});
});
$('refreshBtn').addEventListener('click',()=>{
  if(!currentTabId) return;
  mediaList.querySelectorAll('.media-item').forEach(el=>el.remove());
  emptyState.style.display='none';
  const ld=document.createElement('div');ld.className='loading-indicator';ld.innerHTML='<div class="spinner"></div><span>Scanning…</span>';
  mediaList.appendChild(ld);
  chrome.scripting.executeScript({target:{tabId:currentTabId},files:['content.js']}).catch(()=>{});
  setTimeout(loadMedia,900);
});
const scanBtn=$('scanBtn'); if(scanBtn) scanBtn.addEventListener('click',()=>$('refreshBtn').click());
$('settingsBtn').addEventListener('click',()=>showToast('⚙ Settings coming soon','info'));

// Live updates from background
chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='DOWNLOADS_UPDATE'){trackedDownloads=msg.downloads;updateBadge();if(!$('downloadsView').classList.contains('hidden')) renderDownloadsPanel();}
  if(msg.type==='HLS_JOBS_UPDATE'){trackedHLSJobs=msg.jobs;updateBadge();if(!$('downloadsView').classList.contains('hidden')) renderDownloadsPanel();}
});

// ── Data loaders ───────────────────────────────────────────────────────────
function loadMedia(){
  if(!currentTabId) return;
  chrome.runtime.sendMessage({type:'GET_MEDIA',tabId:currentTabId},(resp)=>{
    document.querySelector('.loading-indicator')?.remove();
    allMedia=(resp?.media)||[];
    selectedUrls=new Set([...selectedUrls].filter(url=>allMedia.some(m=>m.url===url)));
    updateStats();applyFilter();updateSelectCount();
  });
}
function fetchAllProgressLoop(){
  chrome.runtime.sendMessage({type:'GET_DOWNLOADS'},(resp)=>{if(resp?.downloads){trackedDownloads=resp.downloads;updateBadge();}});
  chrome.runtime.sendMessage({type:'GET_HLS_JOBS'},(resp)=>{if(resp?.jobs){trackedHLSJobs=resp.jobs;updateBadge();if(!$('downloadsView').classList.contains('hidden'))renderDownloadsPanel();}});
}

window.addEventListener('unload',()=>{if(mediaPoller)clearInterval(mediaPoller);if(downloadPoller)clearInterval(downloadPoller);});

async function init(){
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(tab){currentTabId=tab.id;try{footerTab.textContent=new URL(tab.url||'').hostname;}catch{footerTab.textContent='Current tab';}}
  }catch(e){}
  loadMedia();
  fetchAllProgressLoop();
  mediaPoller    = setInterval(loadMedia,2000);
  downloadPoller = setInterval(fetchAllProgressLoop,800);
}
init();
