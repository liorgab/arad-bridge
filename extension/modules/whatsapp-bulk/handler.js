// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — WhatsApp Bulk Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  Thin HTTP forwarder to the external ARAD Bulk Daemon (Python).
//
//  Daemon runs as a separate Windows process on port 8766 (NOT 8765 -
//  that's the legacy D.Yohai daemon's port; we use 8766 to avoid conflict).
//
//  The daemon does the heavy lifting:
//   • Selenium + Chrome for Testing
//   • Anti-ban delays, pause/resume, chunking
//   • SSE progress streaming
//
//  This handler just forwards HTTP calls. SSE subscription is done
//  directly from page-bridge.js via EventSource (no router involved).
// ═══════════════════════════════════════════════════════════════════

const DAEMON_BASE = 'http://127.0.0.1:8766';
const FETCH_TIMEOUT_MS = 10000;
const STATUS_TIMEOUT_MS = 3000;

// Wrapper with timeout to prevent hangs when daemon is unresponsive
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
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

// ─── BULK_DAEMON_STATUS — health check ───────────────────────────
async function getDaemonStatus() {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/status`, {}, STATUS_TIMEOUT_MS);
    return await r.json();
  } catch (e) {
    return {
      success: false,
      daemon: 'offline',
      error: e.name === 'AbortError' ? 'Daemon timeout' : e.message,
      hint: 'הפעל את ARAD Bulk Daemon מקיצור הדרך בשולחן העבודה'
    };
  }
}

// ─── BULK_OPEN_WHATSAPP — tell daemon to launch Chrome Test ──────
async function openBulkWhatsApp() {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/open_whatsapp`, { method: 'POST' });
    return await r.json();
  } catch (e) {
    return {
      success: false,
      error: e.message,
      hint: 'ודא שהדאי-מון רץ ולחץ "פתח Chrome Test"'
    };
  }
}

// ─── BULK_SEND_START — kick off a bulk job ───────────────────────
async function startBulkSend(payload) {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/bulk_send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }, 30000);  // longer timeout - large payloads can take a moment

    if (!r.ok) {
      const text = await r.text();
      return {
        success: false,
        error: `Daemon returned HTTP ${r.status}`,
        details: text.substring(0, 500)
      };
    }
    return await r.json();
  } catch (e) {
    return {
      success: false,
      error: e.message,
      hint: 'ודא שהדאי-מון רץ ושיש לך התחברות WA פעילה'
    };
  }
}

// ─── BULK_SEND_STOP / PAUSE / RESUME ─────────────────────────────
async function controlJob(action, job_id) {
  if (!job_id) return { success: false, error: 'Missing job_id' };
  try {
    const r = await fetchWithTimeout(
      `${DAEMON_BASE}/${action}/${encodeURIComponent(job_id)}`,
      { method: 'POST' }
    );
    return await r.json();
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Health check ─────────────────────────────────────────────────
export async function getHealth() {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/status`, {}, 2000);
    if (!r.ok) {
      return {
        ok: false,
        status: 'DAEMON_ERROR',
        message: `Daemon החזיר HTTP ${r.status}`,
        hint: 'בדוק את הלוג של הDaemon'
      };
    }
    const data = await r.json();
    if (!data.wa_logged_in) {
      return {
        ok: false,
        status: 'DAEMON_NO_WA',
        message: 'Daemon רץ - WA לא מחובר',
        hint: 'פתח Chrome Test וסרוק QR'
      };
    }
    return {
      ok: true,
      status: 'CONNECTED',
      message: 'Daemon פעיל ו-WA מחובר',
      detail: 'Chrome Test מוכן לשליחה'
    };
  } catch (e) {
    return {
      ok: false,
      status: 'DAEMON_OFFLINE',
      message: 'Daemon לא רץ',
      hint: 'התקן או הפעל את הDaemon (port 8766)'
    };
  }
}

// ─── Main handler entry point ────────────────────────────────────
export default async function handle(type, msg, sender) {
  switch (type) {
    case 'BULK_DAEMON_STATUS':
      return getDaemonStatus();
    case 'BULK_OPEN_WHATSAPP':
      return openBulkWhatsApp();
    case 'BULK_SEND_START':
      return startBulkSend(msg.payload);
    case 'BULK_SEND_STOP':
      return controlJob('stop', msg.job_id);
    case 'BULK_SEND_PAUSE':
      return controlJob('pause', msg.job_id);
    case 'BULK_SEND_RESUME':
      return controlJob('resume', msg.job_id);
    default:
      return { success: false, error: `WhatsApp Bulk handler: unknown type '${type}'` };
  }
}
