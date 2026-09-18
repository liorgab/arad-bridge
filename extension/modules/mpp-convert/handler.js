// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — MPP Convert Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  Thin HTTP forwarder to the ARAD Bulk Daemon (Python) on port 8766.
//
//  The daemon shells out to the MPXJ-based `mpp2xml` tool to convert a
//  binary MS Project (.mpp) file into MSPDI XML, and returns it base64.
//  See daemon: POST /convert_mpp, worker cmd_convert_mpp.
//
//  This handler just forwards the call. Mirrors modules/pdf-render.
// ═══════════════════════════════════════════════════════════════════

const DAEMON_BASE = 'http://127.0.0.1:8766';
const CONVERT_TIMEOUT_MS = 55000;   // MPXJ first-run can take a few seconds
const STATUS_TIMEOUT_MS = 3000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = CONVERT_TIMEOUT_MS) {
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

// ─── MPP_CONVERT — .mpp (base64) → MSPDI XML (base64) ────────────
async function convertMpp(payload) {
  const mpp_base64 = payload?.mpp_base64 || '';
  if (!mpp_base64) {
    return { success: false, error: 'empty mpp', error_code: 'CONVERT_FAILED' };
  }
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/convert_mpp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mpp_base64 })
    }, CONVERT_TIMEOUT_MS);

    if (!r.ok) {
      const text = await r.text();
      return {
        success: false,
        error: `Daemon returned HTTP ${r.status}`,
        error_code: 'CONVERT_FAILED',
        details: text.substring(0, 500)
      };
    }
    // { success:true, xml_base64 } | { success:false, error, error_code }
    return await r.json();
  } catch (e) {
    const aborted = e.name === 'AbortError';
    return {
      success: false,
      error: aborted ? 'Daemon convert timeout' : e.message,
      error_code: aborted ? 'TIMEOUT' : 'DAEMON_DOWN',
      hint: 'ודא שה-ARAD Bulk Daemon רץ (פורט 8766) ושכלי mpp2xml מותקן'
    };
  }
}

// ─── Health check (for popup health cards) ───────────────────────
export async function getHealth() {
  try {
    const r = await fetchWithTimeout(`${DAEMON_BASE}/status`, {}, STATUS_TIMEOUT_MS);
    if (!r.ok) {
      return { ok: false, status: 'DAEMON_ERROR', message: `Daemon החזיר HTTP ${r.status}`, hint: 'בדוק את הלוג של ה-Daemon' };
    }
    await r.json();
    return { ok: true, status: 'CONNECTED', message: 'Daemon פעיל — מוכן להמרת MPP' };
  } catch (e) {
    return { ok: false, status: 'DAEMON_OFFLINE', message: 'Daemon לא רץ', hint: 'התקן או הפעל את ה-Daemon (port 8766)' };
  }
}

// ─── Main handler entry point ────────────────────────────────────
export default async function handle(type, msg, sender) {
  switch (type) {
    case 'MPP_CONVERT':
      return convertMpp(msg.payload);
    default:
      return { success: false, error: `MPP handler: unknown type '${type}'` };
  }
}
