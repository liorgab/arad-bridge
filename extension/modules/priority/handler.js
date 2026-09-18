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
// NOT the host root — https://p.priority-connect.online/ is a 404. /webui/ is
// the app's tenant-less entry (logs in / picks the tenant as needed).
const PRIORITY_HOME      = `${PRIORITY_ORIGIN}/webui/`;
// Refuse a token that expires within this margin (silent renew is ~120s early).
const TOKEN_MIN_TTL_MS   = 60_000;

// The app's real home (/webui/<tenant>/) is synced by the content script from
// the tab that runs it — the extension itself is tenant-agnostic. Falls back to
// the tenant-less /webui/ entry.
async function getHome() {
  const { priority_home } = await chrome.storage.local.get(['priority_home']);
  return (priority_home && isAllowedUrl(priority_home)) ? priority_home : PRIORITY_HOME;
}

// ─── Token (synced from the app tab by modules/priority/content.js) ────
// Priority Web's bootstrap supports "bring your own JWT":
//   /webui/<tenant>/?jwt=<access_token>&<params…>
// It sets window.oidc_access_token from that param and loads the UI directly —
// no OIDC round-trip, so no login page. The query MUST START with ?jwt=
// (the bootstrap checks location.search.startsWith("?jwt=")), and the rest of
// the query (priority:priform&_disableplugin=1&_execute=…) is still appended to
// priorityParams, so the requested form opens as usual.
async function getValidToken() {
  const { priority_token, priority_token_exp } =
    await chrome.storage.local.get(['priority_token', 'priority_token_exp']);
  if (!priority_token) return null;
  if (priority_token_exp && (priority_token_exp - Date.now()) < TOKEN_MIN_TTL_MS) return null;
  return priority_token;
}
function withJwt(url, token) {
  const u = new URL(url);
  const rest = u.search ? u.search.slice(1) : '';
  u.search = '?jwt=' + encodeURIComponent(token) + (rest ? '&' + rest : '');
  return u.toString();
}

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
// Tab policy (observed 2026-09-18): opening the JWT deep-link in a FRESH tab
// loads the form with no login, but navigating the ALREADY-RUNNING app tab
// to the same URL (chrome.tabs.update) re-ran the login — Priority_Scripts.js
// runs its own authenticate()/getUser() pass on load and behaves differently
// on a tab that already holds the previous app run's storage. So we never
// reuse the app tab: we close it and open a fresh one (exactly the
// "close all Priority tabs, then click" case that works), keeping a single
// Priority tab for the user.
async function openPriority(msg) {
  const plainUrl = msg?.url || (await getHome());
  if (!isAllowedUrl(plainUrl)) {
    return {
      success: false,
      error_code: 'BAD_URL',
      error: `Refusing to open a non-Priority URL: ${String(plainUrl).slice(0, 120)}`
    };
  }

  // With a valid synced token → "bring your own JWT" (no login). Without one
  // (user never logged in / token expired) → plain URL: Priority shows its
  // login ONCE, and the content script then captures the token for next time.
  const token = await getValidToken();
  const url = token ? withJwt(plainUrl, token) : plainUrl;
  const via = token ? 'jwt' : 'plain';

  try {
    const old = await findPriorityTab();
    let closed_tab_url = null;
    if (old && old.id != null) {
      closed_tab_url = old.url;
      // Close first (may show the app's own "leave site?" prompt if it has
      // unsaved changes — same prompt the user saw with in-place navigation).
      // Don't block on it: create the fresh tab either way.
      chrome.tabs.remove(old.id).catch(() => { /* user may cancel the prompt */ });
      await new Promise(r => setTimeout(r, 250));
    }
    const tab = await chrome.tabs.create({ url, active: true });
    return {
      success: true,
      tab_id: tab.id,
      tab_url: plainUrl,
      mode: closed_tab_url ? 'replaced' : 'created',
      closed_tab_url,
      via
    };
  } catch (e) {
    return { success: false, error_code: 'TAB_ERROR', error: e.message };
  }
}

// ─── Health check (for popup health cards) ───────────────────────
// No external dependency (no daemon, no token): healthy iff the tabs API is
// usable. We also report whether a Priority tab is currently open.
export async function getHealth() {
  try {
    const { priority_token, priority_token_exp, priority_token_updated_at } =
      await chrome.storage.local.get(['priority_token', 'priority_token_exp', 'priority_token_updated_at']);
    if (!priority_token) {
      return {
        ok: false,
        status: 'NO_TOKEN',
        message: 'אין טוקן',
        hint: 'פתח את Priority והתחבר — הטוקן יסונכרן אוטומטית'
      };
    }
    if (priority_token_exp && (priority_token_exp - Date.now()) < TOKEN_MIN_TTL_MS) {
      return {
        ok: false,
        status: 'TOKEN_EXPIRED',
        message: 'הטוקן פג',
        hint: 'רענן את טאב Priority (או התחבר מחדש) — הטוקן יסונכרן'
      };
    }
    const minutesAgo = Math.round((Date.now() - (priority_token_updated_at || 0)) / 60000);
    const minutesLeft = priority_token_exp ? Math.round((priority_token_exp - Date.now()) / 60000) : null;
    return {
      ok: true,
      status: 'CONNECTED',
      message: 'טוקן מסונכרן',
      detail: (minutesAgo > 0 ? `עודכן לפני ${minutesAgo} דקות` : 'עודכן הרגע')
            + (minutesLeft != null ? ` · תקף עוד ${minutesLeft} דקות` : '')
            + ' — קישורים ממגדל ייפתחו ללא התחברות'
    };
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
