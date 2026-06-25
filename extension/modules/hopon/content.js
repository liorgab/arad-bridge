// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — HopOn Module: Content Script
// ═══════════════════════════════════════════════════════════════════
//  Runs on https://b2b-dashboard.hopon.co/*
//  Syncs the bearer token from page localStorage to chrome.storage.
//  HopOn stores its login state under key 'currentUserLogin' as JSON
//  with shape { user: { token, ... }, ... }
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const SYNC_INTERVAL_MS = 5000;
  let lastToken = null;

  async function syncToken() {
    try {
      const loginData = localStorage.getItem('currentUserLogin');
      if (!loginData) {
        if (lastToken) {
          lastToken = null;
          await chrome.storage.local.remove(['hopon_token', 'hopon_token_updated_at']);
          console.log('[ARAD Bridge/HopOn] Token cleared');
        }
        return;
      }
      const parsed = JSON.parse(loginData);
      const token = parsed?.user?.token;
      if (!token) return;
      if (token === lastToken) return;
      lastToken = token;
      await chrome.storage.local.set({
        hopon_token: token,
        hopon_token_updated_at: Date.now()
      });
      console.log('[ARAD Bridge/HopOn] Token synced');
    } catch (e) {
      console.warn('[ARAD Bridge/HopOn] Sync failed', e);
    }
  }

  syncToken();
  setInterval(syncToken, SYNC_INTERVAL_MS);

  window.addEventListener('storage', (e) => {
    if (e.key === 'currentUserLogin') syncToken();
  });

  console.log('[ARAD Bridge/HopOn] Content script loaded');
})();
