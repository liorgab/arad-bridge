// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Priority Module: Content Script
// ═══════════════════════════════════════════════════════════════════
//  Runs on https://p.priority-connect.online/webui/*  (the Priority Web app).
//  Syncs the app's OIDC access token to chrome.storage — exactly like the
//  HopOn module syncs its bearer token.
//
//  Priority Web authenticates with oidc-client-js (client_id 'priority-web',
//  authority <origin>/auth/). The library keeps the signed-in user in the tab's
//  sessionStorage under  oidc.user:<authority>:<client_id>  as JSON:
//    { access_token, token_type, expires_at (unix seconds), profile, ... }
//  We mirror access_token + expiry to chrome.storage so the background
//  handler can open deep-links with Priority's own "bring your own JWT"
//  entry (/webui/<tenant>/?jwt=<token>&…) — which loads the form directly,
//  no OIDC round-trip, no login page.
//
//  The token only ever flows to p.priority-connect.online (the handler
//  refuses any other URL). It is never exposed to the ARAD/TOWER page.
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const SYNC_INTERVAL_MS = 5000;
  const USER_KEY_PREFIX = 'oidc.user:';
  let lastToken = null;

  function findUserJson() {
    // sessionStorage is where oidc-client-js keeps the user by default;
    // check localStorage too in case the deployment configured it that way.
    for (const store of [window.sessionStorage, window.localStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key && key.startsWith(USER_KEY_PREFIX)) {
            const raw = store.getItem(key);
            if (raw) return raw;
          }
        }
      } catch { /* storage may be blocked — try the next one */ }
    }
    return null;
  }

  async function syncToken() {
    try {
      const raw = findUserJson();
      if (!raw) {
        if (lastToken) {
          lastToken = null;
          await chrome.storage.local.remove(['priority_token', 'priority_token_exp', 'priority_token_updated_at']);
          console.log('[ARAD Bridge/Priority] Token cleared');
        }
        return;
      }
      const user = JSON.parse(raw);
      const token = user && user.access_token;
      if (!token) return;
      if (token === lastToken) return;
      lastToken = token;
      await chrome.storage.local.set({
        priority_token: token,
        // expires_at is unix seconds → store milliseconds for easy comparison
        priority_token_exp: user.expires_at ? Number(user.expires_at) * 1000 : null,
        priority_token_updated_at: Date.now()
      });
      console.log('[ARAD Bridge/Priority] Token synced');
    } catch (e) {
      console.warn('[ARAD Bridge/Priority] Sync failed', e);
    }
  }

  syncToken();
  setInterval(syncToken, SYNC_INTERVAL_MS);   // also picks up silent renews

  console.log('[ARAD Bridge/Priority] Content script loaded');
})();
