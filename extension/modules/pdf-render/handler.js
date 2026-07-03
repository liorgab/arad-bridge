// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — PDF Generator Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  Thin HTTP forwarder to the ARAD Bulk Daemon (Python) on port 8766.
//
//  The daemon renders self-contained HTML → a REAL-TEXT PDF via a
//  dedicated headless Chrome + CDP Page.printToPDF (NOT a screenshot).
//  See daemon: POST /render_pdf, and docs/modules/pdf-generator/SPEC.md.
//
//  This handler just forwards the call. Mirrors modules/whatsapp-bulk.
// ═══════════════════════════════════════════════════════════════════

const DAEMON_BASE = 'http://127.0.0.1:8766';
// Generous — headless Chrome first-launch + font load + print can take a
// few seconds; the page-bridge postMessage timeout (60s) is the outer bound.
const RENDER_TIMEOUT_MS = 55000;
const STATUS_TIMEOUT_MS = 3000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = RENDER_TIMEOUT_MS) {
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

// ─── PDF_RENDER — HTML → real-text PDF (base64) ──────────────────
async function renderPdf(payload) {
  const html = payload?.html || '';
  const options = payload?.options || {};
  if (!html) {
    return { success: false, error: 'empty html', error_code: 'RENDER_FAILED' };
  }
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/render_pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, options })
    }, RENDER_TIMEOUT_MS);

    if (!r.ok) {
      const text = await r.text();
      return {
        success: false,
        error: `Daemon returned HTTP ${r.status}`,
        error_code: 'RENDER_FAILED',
        details: text.substring(0, 500)
      };
    }
    // { success:true, pdf_base64 } | { success:false, error, error_code }
    return await r.json();
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return {
      success: false,
      error: aborted ? 'Daemon render timeout' : e.message,
      error_code: aborted ? 'TIMEOUT' : 'DAEMON_DOWN',
      hint: 'ודא שה-ARAD Bulk Daemon רץ (פורט 8766)'
    };
  }
}

// ─── Health check (for popup health cards) ───────────────────────
export async function getHealth() {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/status`, {}, STATUS_TIMEOUT_MS);
    if (!r.ok) {
      return { ok: false, status: 'DAEMON_ERROR', message: `Daemon החזיר HTTP ${r.status}`,
               hint: 'בדוק את הלוג של ה-Daemon' };
    }
    await r.json();
    // PDF rendering only needs the daemon (headless Chrome) — NOT a WA login.
    return { ok: true, status: 'CONNECTED', message: 'Daemon פעיל — מוכן להפקת PDF' };
  } catch (e) {
    return { ok: false, status: 'DAEMON_OFFLINE', message: 'Daemon לא רץ',
             hint: 'התקן או הפעל את ה-Daemon (port 8766)' };
  }
}

// ─── Main handler entry point ────────────────────────────────────
export default async function handle(type, msg, sender) {
  switch (type) {
    case 'PDF_RENDER':
      return renderPdf(msg.payload);
    default:
      return { success: false, error: `PDF handler: unknown type '${type}'` };
  }
}
