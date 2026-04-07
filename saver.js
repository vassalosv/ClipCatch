// ============================
// saver.js — HLS Download Trigger
// Opened as a minimal popup by the background service worker.
// Regular extension pages have both URL.createObjectURL and chrome.downloads —
// this page bridges the gap between the offscreen assembler and the download API.
// ============================
'use strict';

(async () => {
  const params = new URLSearchParams(location.search);
  const jobId  = params.get('jobId');
  if (!jobId) { window.close(); return; }

  try {
    // Read and immediately delete the transfer record in one readwrite transaction
    const record = await new Promise((resolve, reject) => {
      const req = indexedDB.open('clipcatch_transfers', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('transfers');
      req.onerror   = () => reject(new Error('IndexedDB open failed'));
      req.onsuccess = e => {
        const db    = e.target.result;
        const store = db.transaction('transfers', 'readwrite').objectStore('transfers');
        const get   = store.get(jobId);
        get.onsuccess = () => {
          if (!get.result) { reject(new Error('Transfer record not found')); return; }
          store.delete(jobId);
          resolve(get.result);
        };
        get.onerror = () => reject(get.error);
      };
    });

    const blobUrl = URL.createObjectURL(record.blob);

    chrome.downloads.download({ url: blobUrl, filename: record.filename, saveAs: false }, (downloadId) => {
      const err = chrome.runtime.lastError;

      // Revoke blob URL after Chrome has had time to start reading it (5 s is ample)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);

      // Notify background of outcome
      chrome.runtime.sendMessage({
        type:       'SAVER_DONE',
        jobId,
        success:    !err && downloadId != null,
        downloadId: downloadId ?? null,
        error:      err?.message ?? null,
      });

      window.close();
    });

  } catch (err) {
    chrome.runtime.sendMessage({ type: 'SAVER_DONE', jobId, success: false, error: err.message });
    window.close();
  }
})();
