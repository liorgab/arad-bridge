// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Content script for ARAD app
// ═══════════════════════════════════════════════════════════════════
//  Runs in the ISOLATED world of the ARAD web app (e.g., arad-admin.vercel.app).
//
//  Responsibilities:
//   1. Inject page-bridge.js into the page's main world so it can
//      expose window.__aradBridge to the React/Vue/whatever app code.
//   2. Relay ARAD_BRIDGE_REQUEST window messages from the page → background
//      via chrome.runtime.sendMessage.
//   3. Relay background responses → page via window.postMessage.
//
//  Why two worlds: Chrome MV3 isolates content scripts. window.__aradBridge
//  must live in the page's main world to be reachable by the app's JS, but
//  only content scripts can talk to background. This file is the bridge.
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── 1. Inject page-bridge.js into the main world ─────────────
  function injectBridge() {
    if (document.documentElement.dataset.aradBridgeInjected === '1') return;
    document.documentElement.dataset.aradBridgeInjected = '1';

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('core/page-bridge.js');
    script.onload = () => script.remove();
    script.onerror = (e) => console.error('[ARAD Bridge] page-bridge.js inject failed', e);
    (document.head || document.documentElement).appendChild(script);
  }

  // Run as early as possible
  injectBridge();

  // ─── 2. Listen for requests from the page (main world) ────────
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.type !== 'ARAD_BRIDGE_REQUEST') return;

    const { requestId, action, payload } = d;

    try {
      const response = await chrome.runtime.sendMessage({
        type: action,
        ...payload
      });
      window.postMessage({
        type: 'ARAD_BRIDGE_RESPONSE',
        requestId,
        response
      }, window.location.origin);
    } catch (err) {
      window.postMessage({
        type: 'ARAD_BRIDGE_RESPONSE',
        requestId,
        response: {
          success: false,
          error_code: 'EXT_COMM_ERROR',
          error: err.message,
          hint: 'נסה לרענן את הextension ב-chrome://extensions/ ואת הטאב'
        }
      }, window.location.origin);
    }
  });

  // ─── 3. Diagnostic — tell the page when bridge is fully ready ─
  window.addEventListener('arad-bridge-injected', () => {
    // Page-bridge confirmed it's installed itself in the main world.
    // Send a "ready" event the app can listen for to auto-call handshake.
    window.postMessage({ type: 'ARAD_BRIDGE_READY' }, window.location.origin);
  });

  console.log('[ARAD Bridge] content script loaded on', window.location.host);
})();
