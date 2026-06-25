// ARAD Bridge — PIBA Module Handler

const PIBA_BASE = 'https://inforhub.piba.gov.il';

async function getValidPibaToken() {
  const { piba_token, piba_token_exp } = await chrome.storage.local.get([
    'piba_token', 'piba_token_exp'
  ]);
  if (!piba_token) return { error: 'NO_TOKEN', msg: 'No PIBA token. Login to PIBA.' };
  if (!piba_token_exp || piba_token_exp < Date.now() + 30_000) {
    return { error: 'TOKEN_EXPIRED', msg: 'PIBA token expired. Re-login.' };
  }
  return { token: piba_token, exp: piba_token_exp };
}

function bytesToBase64(bytes) {
  let bin = '';
  const c = 8192;
  for (let i = 0; i < bytes.length; i += c) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + c));
  }
  return btoa(bin);
}

function isPdfMagic(bytes) {
  return bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === '%PDF';
}

// ─── Poll PIBA async job until PDF is ready ─────────────────────
// PIBA returns { jobId, pollUrl, status, estimatedTime, ... }
// We poll until status indicates completion, then fetch the PDF.
async function pollPibaJob(pollUrl, token, maxWaitMs = 30000, intervalMs = 2000) {
  const start = Date.now();
  let lastData = null;
  while (Date.now() - start < maxWaitMs) {
    try {
      const headers = { 'Accept': 'application/json, application/pdf, */*' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const r = await fetch(pollUrl, { method: 'GET', headers });
      const ct = r.headers.get('content-type') || '';

      // Sometimes pollUrl returns the PDF directly when ready
      if (r.ok && ct.includes('application/pdf')) {
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (isPdfMagic(bytes)) return { pdf_bytes: bytes };
      }

      if (!r.ok) {
        // Some endpoints return 202 (Accepted, still processing) or 404 (not yet)
        if (r.status !== 202 && r.status !== 404) {
          return { error: `pollUrl returned HTTP ${r.status}` };
        }
        await new Promise(rs => setTimeout(rs, intervalMs));
        continue;
      }

      const data = await r.json();
      lastData = data;

      // Look for completion status
      const s = String(data.status || '').toUpperCase();
      if (s === 'COMPLETED' || s === 'DONE' || s === 'READY' || s === 'SUCCESS' || s === 'FINISHED') {
        // Try to find the actual PDF URL or inline base64
        const url = data.signedUrl || data.signed_url || data.url || data.pdfUrl ||
                    data.downloadUrl || data.fileUrl || data.pdf_url;
        if (url) return { pdf_url: url };
        const b64 = data.pdf || data.pdfBase64 || data.base64 || data.file || data.content;
        if (b64) return { pdf_base64: String(b64).replace(/^data:application\/pdf;base64,/, '') };
        return { error: 'Job completed but no PDF location', keys: Object.keys(data), sample: JSON.stringify(data).substring(0, 300) };
      }

      if (s === 'FAILED' || s === 'ERROR' || s === 'REJECTED') {
        return { error: `PIBA job failed: ${data.message || s}` };
      }

      // Still processing — wait and retry
      await new Promise(rs => setTimeout(rs, intervalMs));
    } catch (e) {
      return { error: `Poll error: ${e.message}` };
    }
  }
  return {
    error: `Polling timed out after ${maxWaitMs / 1000}s`,
    last_status: lastData?.status,
    keys: lastData ? Object.keys(lastData) : null
  };
}

// ─── Convert poll result to standard {success, pdf_base64} response ─
async function _finalizeFromPoll(pollResult, foreignKey, jobId, bearerToken) {
  if (pollResult.error) {
    return {
      success: false,
      error_code: 'POLL_FAILED',
      error: pollResult.error,
      job_id: jobId,
      keys: pollResult.keys,
      sample: pollResult.sample
    };
  }
  if (pollResult.pdf_bytes) {
    return {
      success: true,
      pdf_base64: bytesToBase64(pollResult.pdf_bytes),
      byteLength: pollResult.pdf_bytes.length,
      foreignKey, fetched_via: 'poll_direct', job_id: jobId
    };
  }
  if (pollResult.pdf_base64) {
    return {
      success: true,
      pdf_base64: pollResult.pdf_base64,
      foreignKey, fetched_via: 'poll_inline', job_id: jobId
    };
  }
  if (pollResult.pdf_url) {
    try {
      const headers = { 'Accept': 'application/pdf, */*' };
      if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
      const r2 = await fetch(pollResult.pdf_url, { method: 'GET', headers });
      if (!r2.ok) return { success: false, error_code: 'PDF_FETCH_FAILED', error: `HTTP ${r2.status}`, url: pollResult.pdf_url };
      const buf = await r2.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length < 100) return { success: false, error_code: 'PDF_TOO_SMALL' };
      if (!isPdfMagic(bytes)) return { success: false, error_code: 'NOT_PDF', error: 'URL did not return a PDF' };
      return {
        success: true,
        pdf_base64: bytesToBase64(bytes),
        byteLength: bytes.length,
        foreignKey, fetched_via: 'poll_url', job_id: jobId
      };
    } catch (e) {
      return { success: false, error_code: 'PDF_FETCH_ERROR', error: e.message, url: pollResult.pdf_url };
    }
  }
  return { success: false, error_code: 'POLL_UNEXPECTED', error: 'Poll returned no PDF or URL' };
}

async function fetchPibaVisa(foreignKey) {
  const tok = await getValidPibaToken();
  if (tok.error) return { success: false, error_code: tok.error, error: tok.msg };
  try {
    const r = await fetch(`${PIBA_BASE}/api/employers/viewPdfVisaEmployer?foreignKey=${encodeURIComponent(foreignKey)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${tok.token}`, 'Accept': 'application/pdf, application/json' }
    });
    const ct = r.headers.get('content-type') || '';
    if (r.status === 401 || r.status === 403) {
      return { success: false, error_code: 'TOKEN_EXPIRED', error: 'PIBA rejected token' };
    }
    if (!r.ok) {
      const t = await r.text();
      let msg = t.substring(0, 200);
      try { const j = JSON.parse(t); msg = j.error || j.message || msg; } catch {}
      return { success: false, error_code: 'PIBA_ERROR', error: msg, piba_status: r.status };
    }
    if (ct.includes('application/pdf')) {
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length < 100) return { success: false, error_code: 'PDF_TOO_SMALL' };
      if (!isPdfMagic(bytes)) return { success: false, error_code: 'NOT_PDF' };
      return { success: true, pdf_base64: bytesToBase64(bytes), byteLength: bytes.length, foreignKey };
    }
    if (ct.includes('application/json')) {
      const j = await r.json();
      // Path A: PDF inline
      const b = j.pdf || j.pdfBase64 || j.data || j.base64 || j.file || j.fileBase64 || j.pdfData || j.content;
      if (b) {
        return { success: true, pdf_base64: String(b).replace(/^data:application\/pdf;base64,/, ''), foreignKey, metadata: j };
      }
      // Path B: async poll pattern { jobId, pollUrl, status, estimatedTime, ... }
      if (j.pollUrl && j.jobId) {
        // Wait estimatedTime if provided (cap at 8s before first poll)
        const initWait = Math.min(Math.max(0, Number(j.estimatedTime) || 0), 8) * 1000;
        if (initWait > 0) await new Promise(rs => setTimeout(rs, initWait));
        const poll = await pollPibaJob(j.pollUrl, tok.token, 30000, 2000);
        return _finalizeFromPoll(poll, foreignKey, j.jobId, tok.token);
      }
      // Path C: direct signedUrl (older async pattern)
      const url = j.signedUrl || j.signed_url || j.url || j.pdfUrl || j.downloadUrl || j.fileUrl;
      if (url && typeof url === 'string' && url.startsWith('http')) {
        return _finalizeFromPoll({ pdf_url: url }, foreignKey, j.jobId, tok.token);
      }
      return { success: false, error_code: 'NO_PDF_IN_JSON', keys: Object.keys(j), sample: JSON.stringify(j).substring(0, 300) };
    }
    return { success: false, error_code: 'UNKNOWN_RESPONSE_TYPE', error: ct };
  } catch (e) {
    return { success: false, error_code: 'FETCH_ERROR', error: e.message };
  }
}

async function fetchPibaInterVisa(foreignKey) {
  if (!foreignKey || typeof foreignKey !== 'string') {
    return { success: false, error_code: 'BAD_FOREIGN_KEY' };
  }
  const parts = foreignKey.split('_');
  if (parts.length === 2) foreignKey = parts[0] + '_' + parts[1].toLowerCase();

  try {
    const r = await fetch(`${PIBA_BASE}/api/downloadPdfEnterVisa`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': PIBA_BASE,
        'Referer': `${PIBA_BASE}/foreign-enter-visa`
      },
      body: JSON.stringify({ foreignKey })
    });
    const ct = r.headers.get('content-type') || '';

    if (!r.ok) {
      const t = await r.text();
      let msg = t.substring(0, 300);
      try { const j = JSON.parse(t); msg = j.error || j.message || j.errorMessage || msg; } catch {}
      return { success: false, error_code: 'PIBA_ERROR', error: msg, piba_status: r.status, foreignKey };
    }

    if (ct.includes('application/pdf')) {
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length < 100) return { success: false, error_code: 'PDF_TOO_SMALL' };
      if (!isPdfMagic(bytes)) return { success: false, error_code: 'NOT_PDF' };
      return { success: true, pdf_base64: bytesToBase64(bytes), byteLength: bytes.length, foreignKey };
    }

    if (ct.includes('application/json') || ct.includes('text/plain')) {
      const t = await r.text();
      let j;
      try { j = JSON.parse(t); } catch {
        return { success: false, error_code: 'NOT_JSON', sample: t.substring(0, 300) };
      }

      const b = j.pdf || j.pdfBase64 || j.data || j.base64 || j.file || j.fileBase64 || j.pdfData || j.content;
      if (b) {
        const clean = String(b).replace(/^data:application\/pdf;base64,/, '');
        try {
          if (!atob(clean.substring(0, 100)).startsWith('%PDF')) {
            return { success: false, error_code: 'NOT_PDF_BASE64' };
          }
        } catch (e) {
          return { success: false, error_code: 'BAD_BASE64', error: e.message };
        }
        return { success: true, pdf_base64: clean, foreignKey, metadata: j };
      }

      // Path B: async poll pattern { jobId, pollUrl, status, estimatedTime }
      if (j.pollUrl && j.jobId) {
        const initWait = Math.min(Math.max(0, Number(j.estimatedTime) || 0), 8) * 1000;
        if (initWait > 0) await new Promise(rs => setTimeout(rs, initWait));
        const poll = await pollPibaJob(j.pollUrl, null, 30000, 2000);
        return _finalizeFromPoll(poll, foreignKey, j.jobId, null);
      }
      // Path C: direct signedUrl (older async pattern)
      const url = j.signedUrl || j.signed_url || j.url || j.pdfUrl || j.downloadUrl || j.fileUrl;
      if (url && typeof url === 'string' && url.startsWith('http')) {
        return _finalizeFromPoll({ pdf_url: url }, foreignKey, j.jobId, null);
      }

      return {
        success: false,
        error_code: 'NO_PDF_IN_JSON',
        error: 'JSON without PDF, pollUrl or signed URL',
        keys: Object.keys(j),
        sample: JSON.stringify(j).substring(0, 300)
      };
    }

    const sample = await r.text();
    return { success: false, error_code: 'UNKNOWN_RESPONSE_TYPE', error: ct, sample: sample.substring(0, 500) };
  } catch (e) {
    return { success: false, error_code: 'FETCH_ERROR', error: e.message };
  }
}

async function openPiba() {
  await chrome.tabs.create({ url: `${PIBA_BASE}/employer_sign_in`, active: true });
  return { success: true };
}

// Helper: re-inject content script into any open PIBA tabs to force token sync
async function forceSyncFromOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://inforhub.piba.gov.il/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['modules/piba/content.js']
      }).catch(() => {});
    }
    // Give the script ~500ms to read localStorage + save
    if (tabs.length > 0) await new Promise(r => setTimeout(r, 600));
    return tabs.length;
  } catch {
    return 0;
  }
}

export async function getHealth() {
  let { piba_token, piba_token_exp } = await chrome.storage.local.get(['piba_token', 'piba_token_exp']);

  // If token is missing OR expired, try to force a fresh sync from open PIBA tabs.
  const isStale = !piba_token || (piba_token_exp || 0) < Date.now() + 30_000;
  if (isStale) {
    const tabsFound = await forceSyncFromOpenTabs();
    if (tabsFound > 0) {
      // Re-read storage after the sync
      const fresh = await chrome.storage.local.get(['piba_token', 'piba_token_exp']);
      piba_token = fresh.piba_token;
      piba_token_exp = fresh.piba_token_exp;
    }
  }

  if (!piba_token) {
    return { ok: false, status: 'NO_TOKEN', message: 'אין טוקן', hint: 'פתח את PIBA והתחבר' };
  }
  const remMs = (piba_token_exp || 0) - Date.now();
  if (remMs < 30_000) {
    return { ok: false, status: 'EXPIRED', message: 'טוקן פג תוקף', hint: 'התחבר שוב ל-PIBA (אם פתוח אצלך — רענן את הטאב)' };
  }
  return { ok: true, status: 'CONNECTED', message: 'טוקן מסונכרן', detail: `נותרו ${Math.round(remMs / 60000)} דקות` };
}

export default async function handle(type, msg, sender) {
  switch (type) {
    case 'PIBA_FETCH_VISA':       return fetchPibaVisa(msg.foreignKey);
    case 'PIBA_FETCH_INTER_VISA': return fetchPibaInterVisa(msg.foreignKey);
    case 'OPEN_PIBA':             return openPiba();
    default: return { success: false, error: `PIBA: unknown type '${type}'` };
  }
}
