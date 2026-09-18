// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Priority Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  OPEN_PRIORITY { url } — open a Priority Web document deep-link in the
//  user's (single, shared) Priority tab.
//
//  WHY THIS EXISTS (the whole point of the module):
//  Priority Web keeps its OIDC user (access token) in the app tab's
//  sessionStorage (oidc-client-js default userStore) — i.e. PER TAB. Its
//  bootstrap (bootstrapWebUISys.js) loads a form WITHOUT any login when
//  oidc_mgr.getUser() yields a valid user, and only when there is none does
//  it call signinRedirect() with prompt=login (forced re-auth). So a link
//  opened in a NEW tab (empty sessionStorage) always hits the login page,
//  while navigating the tab that is ALREADY running the app reuses its
//  session. TOWER cannot target that specific tab from a web page; the
//  extension can (chrome.tabs). That is why TOWER routes the click here when
//  the bridge is installed (and falls back to a plain named tab if not).
//
//  Tab policy: navigate the tab that RUNS the app (/webui/<tenant>/…) —
//  never the login page, which shares the host but has no session — and
//  create a tab only if no app tab exists (first open → one login, then the
//  tab is reused). Only https://p.priority-connect.online/* URLs are accepted
//  — the page must never drive arbitrary navigation through the bridge.
// ═══════════════════════════════════════════════════════════════════

const PRIORITY_ORIGIN    = 'https://p.priority-connect.online';
const PRIORITY_MATCH     = `${PRIORITY_ORIGIN}/*`;
// The RUNNING Priority Web app lives under /webui/<tenant>/. Its OIDC user
// (access token) is kept in that tab's sessionStorage, so navigating THIS tab
// lets the app's bootstrap find a valid user (getUser()) and load the form
// WITHOUT re-authenticating. Any other Priority tab — above all the login
// page (/accounts/login…, same host!) — has NO session; navigating it just
// re-runs the login. Picking the wrong tab was exactly the bug in v2.3.0.
const PRIORITY_APP_MATCH = `${PRIORITY_ORIGIN}/webui/*`;
// Default when called with no url (e.g. the popup's "open Priority" button).
const PRIORITY_HOME      = `${PRIORITY_ORIGIN}/`;

function isAllowedUrl(url) {
  return typeof url === 'string' && url.startsWith(PRIORITY_ORIGIN + '/');
}
function isLoginTab(t) {
  return /\/accounts\//.test((t && t.url) || '');
}

async function findPriorityTab() {
  try {
    // 1) Prefer the running app tab (holds the session). Active one first.
    const app = await chrome.tabs.query({ url: PRIORITY_APP_MATCH });
    const appTab = app.find(t => t.active) || app[0];
    if (appTab) return appTab;
    // 2) Otherwise any Priority tab that is NOT the login page.
    const others = (await chrome.tabs.query({ url: PRIORITY_MATCH })).filter(t => !isLoginTab(t));
    return others.find(t => t.active) || others[0] || null;
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
      return { success: true, tab_id: tab.id, tab_url: tab.url, mode: 'reused' };
    }
    tab = await chrome.tabs.create({ url, active: true });
    return { success: true, tab_id: tab.id, tab_url: url, mode: 'created' };
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
