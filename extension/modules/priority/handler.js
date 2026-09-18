// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Priority Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  OPEN_PRIORITY { url } — open a Priority Web document deep-link in the
//  user's (single, shared) Priority tab.
//
//  WHY THIS EXISTS (the whole point of the module):
//  TOWER links into Priority (openmail.htm priform deep-links). A normal
//  <a href> click from TOWER is a CROSS-SITE navigation (tower.vercel.app →
//  p.priority-connect.online). Priority's login-session cookie is
//  SameSite=Strict, and browsers WITHHOLD Strict cookies on cross-site
//  navigations — so Priority sees no session and bounces the user to the
//  OIDC login page on EVERY click, even though they are logged in.
//
//  A navigation started by the extension's chrome.tabs API is
//  BROWSER-initiated (no web initiator), so the browser DOES send
//  SameSite=Strict cookies → Priority recognizes the session → the document
//  opens directly, no re-login. That is why TOWER routes the click through
//  here when the bridge is installed (and falls back to a plain link if not).
//
//  Tab policy: reuse the one existing Priority tab (update its URL + focus)
//  so the user keeps a single logged-in Priority tab; create one if absent.
//  Only https://p.priority-connect.online/* URLs are accepted — the page
//  must never be able to drive arbitrary navigation through the bridge.
// ═══════════════════════════════════════════════════════════════════

const PRIORITY_ORIGIN = 'https://p.priority-connect.online';
const PRIORITY_MATCH  = `${PRIORITY_ORIGIN}/*`;
// Default when called with no url (e.g. the popup's "open Priority" button).
const PRIORITY_HOME   = `${PRIORITY_ORIGIN}/`;

function isAllowedUrl(url) {
  return typeof url === 'string' && url.startsWith(PRIORITY_ORIGIN + '/');
}

async function findPriorityTab() {
  try {
    const tabs = await chrome.tabs.query({ url: PRIORITY_MATCH });
    // Prefer a tab in the currently focused window so focus() feels natural.
    const current = tabs.find(t => t.active) || tabs[0];
    return current || null;
  } catch (e) {
    console.warn('[ARAD Bridge/Priority] tabs.query failed:', e);
    return null;
  }
}

// ─── OPEN_PRIORITY ────────────────────────────────────────────────
async function openPriority(msg) {
  const url = msg?.url || PRIORITY_HOME;
  if (!isAllowedUrl(url)) {
    return {
      success: false,
      error_code: 'BAD_URL',
      error: `Refusing to open a non-Priority URL: ${String(url).slice(0, 120)}`
    };
  }

  try {
    let tab = await findPriorityTab();
    if (tab && tab.id != null) {
      // Reuse the existing Priority tab: browser-initiated navigation keeps
      // the SameSite=Strict session cookie → no re-login.
      await chrome.tabs.update(tab.id, { url, active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* window may be gone */ }
      return { success: true, tab_id: tab.id, mode: 'reused' };
    }
    tab = await chrome.tabs.create({ url, active: true });
    return { success: true, tab_id: tab.id, mode: 'created' };
  } catch (e) {
    return { success: false, error_code: 'TAB_ERROR', error: e.message };
  }
}

// ─── Health check (for popup health cards) ───────────────────────
// No external dependency (no daemon, no token): healthy iff the tabs API is
// usable. We also report whether a Priority tab is currently open.
export async function getHealth() {
  try {
    const tab = await findPriorityTab();
    return tab
      ? { ok: true, status: 'CONNECTED', message: 'טאב Priority פתוח', detail: 'קישורים ממגדל ייפתחו בו ללא התחברות-מחדש' }
      : { ok: true, status: 'READY',     message: 'מוכן',               detail: 'הלחיצה הראשונה ממגדל תפתח טאב Priority' };
  } catch (e) {
    return { ok: false, status: 'ERROR', message: e.message };
  }
}

// ─── Main handler entry point ────────────────────────────────────
export default async function handle(type, msg, sender) {
  switch (type) {
    case 'OPEN_PRIORITY':
      return openPriority(msg);
    default:
      return { success: false, error: `Priority handler: unknown type '${type}'` };
  }
}
