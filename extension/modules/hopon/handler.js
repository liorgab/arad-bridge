// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — HopOn Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  Handles message types declared in module.json:
//    GET_HOPON_TOKEN — return cached JWT token from chrome.storage
//    OPEN_HOPON      — open b2b-dashboard.hopon.co in new tab
//
//  The token itself is synced by content.js when user visits HopOn.
//  This handler just retrieves it for ARAD app to make API calls.
// ═══════════════════════════════════════════════════════════════════

const HOPON_BASE = 'https://b2b-dashboard.hopon.co';

async function getValidHopOnToken() {
  const { hopon_token, hopon_token_updated_at } = await chrome.storage.local.get([
    'hopon_token', 'hopon_token_updated_at'
  ]);
  if (!hopon_token) {
    return {
      success: false,
      error_code: 'NO_TOKEN',
      error: 'אין טוקן HopOn. פתח את b2b-dashboard.hopon.co והתחבר.'
    };
  }
  return {
    success: true,
    token: hopon_token,
    updated_at: hopon_token_updated_at
  };
}

async function openHopOn() {
  await chrome.tabs.create({ url: HOPON_BASE, active: true });
  return { success: true };
}

// ─── Health check ─────────────────────────────────────────────────
export async function getHealth() {
  const { hopon_token, hopon_token_updated_at } = await chrome.storage.local.get([
    'hopon_token', 'hopon_token_updated_at'
  ]);
  if (!hopon_token) {
    return {
      ok: false,
      status: 'NO_TOKEN',
      message: 'אין טוקן',
      hint: 'פתח את HopOn והתחבר'
    };
  }
  const minutesAgo = Math.round((Date.now() - (hopon_token_updated_at || 0)) / 60000);
  return {
    ok: true,
    status: 'CONNECTED',
    message: 'טוקן מסונכרן',
    detail: minutesAgo > 0 ? `עודכן לפני ${minutesAgo} דקות` : 'עודכן הרגע'
  };
}

export default async function handle(type, msg, sender) {
  switch (type) {
    case 'GET_HOPON_TOKEN':
      return getValidHopOnToken();
    case 'OPEN_HOPON':
      return openHopOn();
    default:
      return { success: false, error: `HopOn handler: unknown type '${type}'` };
  }
}
