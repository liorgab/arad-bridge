// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Transcribe Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  Thin HTTP forwarder to the ARAD Bulk Daemon (Python) on port 8766.
//
//  Unlike pdf-render and mpp-convert, this module is NOT request/response:
//  an hour of audio needs ~32 minutes of CPU (measured 30/10/26), which is
//  far past any fetch timeout and far past an MV3 service worker's lifetime.
//  So the contract is a job:
//
//      TRANSCRIBE_START   → { job_id }            returns immediately
//      TRANSCRIBE_STATUS  → { pct, segments, … }  poll while running
//      TRANSCRIBE_RESULT  → { text, segments[] }  once status is 'complete'
//      TRANSCRIBE_STOP    → stop a running job
//
//  Why polling and not the daemon's SSE stream: an MV3 service worker is
//  suspended when idle and cannot hold an EventSource open across that, so
//  a long stream would die silently mid-job. The daemon therefore also keeps
//  the latest progress on the job and exposes it at /transcribe/status/<id>.
//  The SSE stream stays available for callers that can hold it (a page).
//
//  The audio never leaves the machine. That is half the answer to the
//  privacy section of the module spec, not an implementation detail.
// ═══════════════════════════════════════════════════════════════════

const DAEMON_BASE = 'http://127.0.0.1:8766';
const START_TIMEOUT_MS = 30000;   // the POST only queues the job
const POLL_TIMEOUT_MS = 10000;
const RESULT_TIMEOUT_MS = 60000;  // an hour of segments is a large JSON
const STATUS_TIMEOUT_MS = 3000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = POLL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// Every failure carries status + detail all the way back. A screen that
// prints a bare code charges the price on every iteration.
async function daemonCall(path, opts, timeoutMs, hint) {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}${path}`, opts, timeoutMs);
    let body = null;
    try {
      body = await r.json();
    } catch {
      body = { error: (await r.text().catch(() => '')).substring(0, 500) };
    }
    if (!r.ok) {
      return {
        success: false,
        status: r.status,
        error: body?.error || `Daemon returned HTTP ${r.status}`,
        error_code: body?.error_code || 'TRANSCRIBE_FAILED',
        details: body,
        hint
      };
    }
    return body;
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return {
      success: false,
      error: aborted ? 'Daemon timeout' : e.message,
      error_code: aborted ? 'TIMEOUT' : 'DAEMON_DOWN',
      hint: hint || 'ודא שה-ARAD Bulk Daemon רץ (פורט 8766)'
    };
  }
}

// ─── TRANSCRIBE_START ────────────────────────────────────────────
// payload: { audio_base64?, audio_path?, filename?, language?, beam_size?,
//            vad?, model?, compute_type?, threads?, speakers? }
// `speakers` is the KNOWN participant count. There is no auto mode: measured
// 30/10/26, auto-clustering produced 24 speakers on a 56-minute file. 0 or
// missing = no diarization at all.
// The defaults live in the daemon, deliberately: beam 5, no VAD, int8, he.
async function start(payload) {
  const p = payload || {};
  if (!p.audio_base64 && !p.audio_path) {
    return { success: false, error: 'audio_base64 or audio_path required',
             error_code: 'BAD_REQUEST' };
  }
  return daemonCall('/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p)
  }, START_TIMEOUT_MS,
    'ודא שהדימון רץ ושהמודול מותקן (pip install faster-whisper, av<19)');
}

// ─── TRANSCRIBE_STATUS ───────────────────────────────────────────
async function status(payload) {
  const id = payload?.job_id;
  if (!id) return { success: false, error: 'job_id required', error_code: 'BAD_REQUEST' };
  return daemonCall(`/transcribe/status/${encodeURIComponent(id)}`, {}, POLL_TIMEOUT_MS);
}

// ─── TRANSCRIBE_RESULT ───────────────────────────────────────────
async function result(payload) {
  const id = payload?.job_id;
  if (!id) return { success: false, error: 'job_id required', error_code: 'BAD_REQUEST' };
  return daemonCall(`/transcribe/result/${encodeURIComponent(id)}`, {}, RESULT_TIMEOUT_MS);
}

// ─── TRANSCRIBE_STOP ─────────────────────────────────────────────
// Reuses the daemon's existing /stop/<job_id>, not a second mechanism.
async function stop(payload) {
  const id = payload?.job_id;
  if (!id) return { success: false, error: 'job_id required', error_code: 'BAD_REQUEST' };
  return daemonCall(`/stop/${encodeURIComponent(id)}`, { method: 'POST' }, POLL_TIMEOUT_MS);
}

// ─── Health check (for popup health cards) ───────────────────────
export async function getHealth() {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/status`, {}, STATUS_TIMEOUT_MS);
    if (!r.ok) {
      return { ok: false, status: 'DAEMON_ERROR', message: `Daemon החזיר HTTP ${r.status}`,
               hint: 'בדוק את הלוג של ה-Daemon' };
    }
    const st = await r.json();
    const tr = st?.transcribe || {};
    if (!tr.available) {
      // The daemon knows exactly why, including the measured av<19 trap.
      return { ok: false, status: 'TRANSCRIBE_UNAVAILABLE',
               message: 'הדימון רץ אך מנוע התמלול אינו זמין',
               hint: tr.detail || 'pip install faster-whisper "av<19"' };
    }
    if (tr.busy) {
      return { ok: true, status: 'BUSY', message: 'תמלול פעיל כרגע',
               hint: 'תמלול אחד בכל רגע; שליחת וואטסאפ אינה נחסמת' };
    }
    return { ok: true, status: 'CONNECTED',
             message: `מוכן לתמלול — ${tr.model || 'ivrit-ai turbo'}` };
  } catch {
    return { ok: false, status: 'DAEMON_OFFLINE', message: 'Daemon לא רץ',
             hint: 'התקן או הפעל את ה-Daemon (port 8766)' };
  }
}

// ─── Main handler entry point ────────────────────────────────────
export default async function handle(type, msg, sender) {
  switch (type) {
    case 'TRANSCRIBE_START':  return start(msg.payload);
    case 'TRANSCRIBE_STATUS': return status(msg.payload);
    case 'TRANSCRIBE_RESULT': return result(msg.payload);
    case 'TRANSCRIBE_STOP':   return stop(msg.payload);
    default:
      return { success: false, error: `Transcribe handler: unknown type '${type}'` };
  }
}
