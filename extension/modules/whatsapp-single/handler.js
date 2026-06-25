// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — WhatsApp Single Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  Single-message WA sending through regular Chrome (NOT the daemon).
//  Includes optional Native Messaging helper for PDF dialog (com.arad.bridge).
//
//  Message types:
//    WHATSAPP_OPEN_CHAT       — main entry: open/reuse tab, send message
//    WHATSAPP_AUTO_SEND       — click send button in already-prepared tab
//    WHATSAPP_GET_STATUS      — daily counts + logged_in status
//    OPEN_WHATSAPP            — open WA Web in new tab
//    NATIVE_*                 — file dialog automation via native helper
// ═══════════════════════════════════════════════════════════════════

const WA_BASE = 'https://web.whatsapp.com';
const NATIVE_HOST = 'com.arad.bridge';

// ─── Rate limiting ───────────────────────────────────────────────
const WA_RATE = {
  per_minute: 3,
  per_day: 150,
  min_gap_ms: 15_000
};

async function checkWhatsAppRate() {
  const { arad_wa_history = [] } = await chrome.storage.local.get(['arad_wa_history']);
  const now = Date.now();
  const fresh = arad_wa_history.filter(t => now - t < 86_400_000);
  const lastMin = fresh.filter(t => now - t < 60_000);
  const lastMs = fresh.length ? now - fresh[fresh.length - 1] : Infinity;

  if (fresh.length >= WA_RATE.per_day)   return { ok: false, reason: 'DAILY_LIMIT', count: fresh.length };
  if (lastMin.length >= WA_RATE.per_minute) return { ok: false, reason: 'MINUTE_LIMIT', count: lastMin.length };
  if (lastMs < WA_RATE.min_gap_ms)       return { ok: false, reason: 'TOO_FAST', waitMs: WA_RATE.min_gap_ms - lastMs };

  return { ok: true, today: fresh.length, in_last_minute: lastMin.length };
}

async function recordWhatsAppSend() {
  const { arad_wa_history = [] } = await chrome.storage.local.get(['arad_wa_history']);
  const now = Date.now();
  const fresh = arad_wa_history.filter(t => now - t < 86_400_000);
  fresh.push(now);
  await chrome.storage.local.set({ arad_wa_history: fresh });
}

// ─── Native helper (optional) ────────────────────────────────────
function callNativeHelper(payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let port;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { port && port.disconnect(); } catch {}
      resolve(result);
    };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      finish({ success: false, error_code: 'NATIVE_NOT_INSTALLED',
               error: 'Native helper לא מותקן: ' + e.message });
      return;
    }

    port.onMessage.addListener((msg) => finish(msg));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish({
        success: false,
        error_code: 'NATIVE_DISCONNECTED',
        error: err?.message || 'Native helper disconnected',
        hint: 'ודא שהרצת install.ps1 ושה-Extension ID תואם'
      });
    });

    setTimeout(() => finish({ success: false, error_code: 'NATIVE_TIMEOUT', error: 'Native helper timeout' }), timeoutMs);

    try { port.postMessage(payload); }
    catch (e) { finish({ success: false, error_code: 'NATIVE_SEND_FAILED', error: e.message }); }
  });
}

// ─── WA tab management ───────────────────────────────────────────
async function findWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: `${WA_BASE}/*` });
  return tabs[0] || null;
}

function sendMessageToTab(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (resp) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { success: false, error: 'Empty response' });
    });
  });
}

async function ensureWAContentScript(tabId) {
  const pingResp = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'WHATSAPP_PING' }, (r) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    } catch { clearTimeout(timer); resolve(null); }
  });

  if (pingResp?.pong) return { ready: true, injected: false, loggedIn: pingResp.loggedIn };

  console.log('[ARAD Bridge/WA] content script missing, injecting...');
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['modules/whatsapp-single/content.js']
    });
    await new Promise(r => setTimeout(r, 800));

    const retryPing = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1500);
      chrome.tabs.sendMessage(tabId, { type: 'WHATSAPP_PING' }, (r) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    });

    if (retryPing?.pong) return { ready: true, injected: true, loggedIn: retryPing.loggedIn };
    return { ready: false, error: 'Content script unresponsive after injection' };
  } catch (e) {
    return { ready: false, error: e.message };
  }
}

// ─── Attachment fetching ─────────────────────────────────────────
async function fetchAttachmentAsBase64(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
    const blob = await resp.blob();
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return {
      success: true,
      base64: btoa(binary),
      mimeType: blob.type || 'application/octet-stream',
      size: bytes.length
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Main open-chat flow ─────────────────────────────────────────
async function openWhatsAppChat(phoneE164, text, autoSend = false, attachment = null) {
  const phone = String(phoneE164).replace(/^\+/, '').replace(/\D/g, '');
  if (!phone) return { success: false, error_code: 'BAD_PHONE', error: 'מספר טלפון לא תקין' };

  let tab = await findWhatsAppTab();
  const tabExists = !!tab;

  // Strategy 1: existing tab → send in place
  if (tabExists) {
    if (tab.status === 'loading') {
      await new Promise(r => setTimeout(r, 2000));
      tab = await chrome.tabs.get(tab.id);
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });

    const csCheck = await ensureWAContentScript(tab.id);
    if (csCheck.ready) {
      const inPlaceResult = await sendMessageToTab(tab.id, {
        type: 'WHATSAPP_SEND_IN_PLACE', phone, message: text, autoSend, attachment
      });

      if (inPlaceResult?.success) {
        return {
          success: true, tab_id: tab.id, mode: 'in_place',
          via: inPlaceResult.via, sent: inPlaceResult.sent, log: inPlaceResult.log
        };
      }

      const fallbackCodes = ['CONTACT_NOT_FOUND', 'SEARCH_NOT_FOUND', 'IN_PLACE_FAILED',
                             'NEW_CHAT_BTN_NOT_FOUND', 'NEW_CHAT_SEARCH_NOT_FOUND',
                             'NO_RESULT_AFTER_TYPE', 'MSG_INPUT_NOT_FOUND'];
      if (!fallbackCodes.includes(inPlaceResult?.error_code)) {
        return {
          success: false,
          error_code: inPlaceResult?.error_code || 'IN_PLACE_FAILED',
          error: inPlaceResult?.error || 'שליחה נכשלה',
          tab_id: tab.id, log: inPlaceResult?.log, details: inPlaceResult
        };
      }
    }
  }

  // Strategy 2: URL-based fallback
  const url = `${WA_BASE}/send?phone=${phone}&text=${encodeURIComponent(text)}`;
  if (tabExists) {
    await chrome.tabs.update(tab.id, { url, active: true });
  } else {
    tab = await chrome.tabs.create({ url, active: true });
  }
  await new Promise(r => setTimeout(r, 2000));

  const prepResult = await new Promise((resolve) => {
    const tryRequest = (attempts = 6) => {
      chrome.tabs.sendMessage(tab.id, { type: 'WHATSAPP_PREPARE_URL_SEND', autoSend }, (resp) => {
        if (chrome.runtime.lastError) {
          if (attempts > 0) setTimeout(() => tryRequest(attempts - 1), 1000);
          else resolve({ success: false, error_code: 'TAB_UNAVAILABLE', error: 'לא ניתן לתקשר עם הטאב' });
          return;
        }
        resolve(resp || { success: false, error: 'Empty response' });
      });
    };
    tryRequest();
  });

  if (prepResult?.success) {
    return { success: true, tab_id: tab.id, mode: 'url', sent: prepResult.sent };
  }

  return {
    success: false,
    error_code: prepResult?.error_code || 'URL_PREP_FAILED',
    error: prepResult?.error || 'הטאב לא מוכן',
    tab_id: tab.id, details: prepResult
  };
}

async function autoSendWhatsApp(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'WHATSAPP_CLICK_SEND' }, (resp) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve({ success: !!resp?.sent, ...resp });
    });
  });
}

async function getWhatsAppStatus() {
  const { whatsapp_logged_in, whatsapp_status_updated_at, arad_wa_history = [] } =
    await chrome.storage.local.get(['whatsapp_logged_in', 'whatsapp_status_updated_at', 'arad_wa_history']);
  const now = Date.now();
  const today = arad_wa_history.filter(t => now - t < 86_400_000).length;
  return {
    logged_in: !!whatsapp_logged_in,
    status_updated_at: whatsapp_status_updated_at,
    sent_today: today,
    daily_limit: WA_RATE.per_day
  };
}

// ─── Health check ─────────────────────────────────────────────────
export async function getHealth() {
  const s = await getWhatsAppStatus();
  if (!s.logged_in) {
    // Check if a WA tab is at least open
    const tabs = await chrome.tabs.query({ url: `${WA_BASE}/*` });
    if (tabs.length === 0) {
      return {
        ok: false,
        status: 'NO_TAB',
        message: 'WhatsApp Web לא פתוח',
        hint: 'פתח WhatsApp Web וסרוק QR'
      };
    }
    return {
      ok: false,
      status: 'NOT_LOGGED_IN',
      message: 'WhatsApp Web פתוח אך לא מחובר',
      hint: 'סרוק QR או רענן את WhatsApp Web'
    };
  }
  return {
    ok: true,
    status: 'CONNECTED',
    message: 'מחובר',
    detail: `נשלחו היום: ${s.sent_today}/${s.daily_limit}`
  };
}

// ─── Main handler entry point ────────────────────────────────────
export default async function handle(type, msg, sender) {
  switch (type) {
    case 'WHATSAPP_OPEN_CHAT': {
      const rate = await checkWhatsAppRate();
      if (!rate.ok) {
        return {
          success: false, error_code: 'RATE_LIMIT', reason: rate.reason,
          error: rate.reason === 'DAILY_LIMIT' ? `הגעת למגבלה יומית (${rate.count}/${WA_RATE.per_day})` :
                 rate.reason === 'MINUTE_LIMIT' ? `מהר מדי (${rate.count} בדקה האחרונה)` :
                 `חכה עוד ${Math.ceil(rate.waitMs / 1000)} שניות לפני הודעה נוספת`,
          ...rate
        };
      }

      let attachment = null;
      if (msg.attachmentUrl) {
        const fetchResult = await fetchAttachmentAsBase64(msg.attachmentUrl);
        if (!fetchResult.success) {
          return {
            success: false, error_code: 'ATTACHMENT_FETCH_FAILED',
            error: 'שגיאה בהורדת הקובץ: ' + fetchResult.error
          };
        }
        attachment = {
          base64: fetchResult.base64,
          mimeType: fetchResult.mimeType,
          filename: msg.attachmentFilename || 'file'
        };
      }

      const result = await openWhatsAppChat(msg.phone, msg.message, msg.autoSend || false, attachment);
      if (result.success) await recordWhatsAppSend();
      return { ...result, rate };
    }

    case 'WHATSAPP_AUTO_SEND': {
      if (!msg.tab_id) return { success: false, error: 'Missing tab_id' };
      return autoSendWhatsApp(msg.tab_id);
    }

    case 'WHATSAPP_GET_STATUS':
      return getWhatsAppStatus();

    case 'OPEN_WHATSAPP':
      await chrome.tabs.create({ url: WA_BASE });
      return { success: true };

    // ─── Native helper passthrough (PDF dialog automation) ─────
    case 'NATIVE_PING':
      return callNativeHelper({ action: 'ping' }, 3000);
    case 'NATIVE_SAVE_FILE':
      return callNativeHelper({
        action: 'save_file',
        file_base64: msg.file_base64,
        filename: msg.filename
      }, 30000);
    case 'NATIVE_PASTE_PATH':
      return callNativeHelper({
        action: 'paste_path',
        file_path: msg.file_path,
        pre_delay_ms: msg.pre_delay_ms || 500
      }, 15000);
    case 'NATIVE_WAIT_AND_PASTE': {
      const timeoutS = msg.timeout_s || 15;
      return callNativeHelper({
        action: 'wait_and_paste',
        file_path: msg.file_path,
        timeout_s: timeoutS
      }, (timeoutS + 5) * 1000);
    }
    case 'NATIVE_CLICK_AT_SCREEN':
      return callNativeHelper({
        action: 'click_at_screen', x: msg.x, y: msg.y,
        restore_cursor: msg.restore_cursor !== false
      }, 5000);
    case 'NATIVE_CLEANUP':
      return callNativeHelper({ action: 'cleanup' }, 3000);

    default:
      return { success: false, error: `WhatsApp Single handler: unknown type '${type}'` };
  }
}
