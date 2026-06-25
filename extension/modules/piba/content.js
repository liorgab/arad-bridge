// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — PIBA Module: Content Script
// ═══════════════════════════════════════════════════════════════════
//  Runs on https://inforhub.piba.gov.il/*
//  Syncs the authToken from page localStorage to chrome.storage so the
//  background handler can use it for API calls (which require Bearer token).
//
//  Token decode: it's a JWT — we parse the exp claim so we know when
//  it expires (PIBA tokens are valid ~30 minutes).
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const SYNC_INTERVAL_MS = 5000;
  let lastToken = null;

  function decodeJwt(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) {
      return null;
    }
  }

  async function syncToken() {
    const token = localStorage.getItem('authToken');

    if (token && token !== lastToken) {
      const payload = decodeJwt(token);
      if (!payload?.exp) {
        console.warn('[ARAD Bridge/PIBA] Token missing exp claim');
        return;
      }
      lastToken = token;
      await chrome.storage.local.set({
        piba_token: token,
        piba_token_exp: payload.exp * 1000,
        piba_token_updated_at: Date.now()
      });
      const remainingMin = Math.round((payload.exp * 1000 - Date.now()) / 60000);
      console.log(`[ARAD Bridge/PIBA] Token synced (${remainingMin} min remaining)`);
    } else if (!token && lastToken) {
      lastToken = null;
      await chrome.storage.local.remove(['piba_token', 'piba_token_exp', 'piba_token_updated_at']);
      console.log('[ARAD Bridge/PIBA] Token cleared');
    }
  }

  // Initial sync + periodic
  syncToken();
  setInterval(syncToken, SYNC_INTERVAL_MS);

  // Also sync when localStorage is changed by the page (login/logout)
  window.addEventListener('storage', (e) => {
    if (e.key === 'authToken') syncToken();
  });

  console.log('[ARAD Bridge/PIBA] Content script loaded');
})();
