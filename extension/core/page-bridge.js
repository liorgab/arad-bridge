// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Page-side API (runs in the page's main world)
// ═══════════════════════════════════════════════════════════════════
//  Exposes window.__aradBridge to ARAD app's JS code.
//
//  Flow per call:
//    page code      → __aradBridge.fetchPibaVisa(...)
//    page-bridge.js → window.postMessage('ARAD_BRIDGE_REQUEST')
//    content-arad.js (content world) → chrome.runtime.sendMessage
//    background.js (service worker) → module router → handler
//    response flows back the same path
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // Don't double-install if both ARAD Bridge and (somehow) another version run.
  if (window.__aradBridge && window.__aradBridge.isInstalled) {
    return;
  }

  const VERSION = '2.0.0';
  const TIMEOUT_MS = 60_000;

  // Local cache of enabled modules — refreshed on every handshake.
  // Auto-restored on init from chrome.storage (via background) so we
  // survive page reloads without requiring a new handshake.
  let enabledModules = null;
  let handshakeDone = false;
  let autoRestorePromise = null;  // resolves when initial restore completes

  // ─── Request/response over window.postMessage ─────────────────
  function sendRequest(action, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = 'req_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => {
        window.removeEventListener('message', listener);
        reject(new Error(`ARAD Bridge: '${action}' timed out after ${TIMEOUT_MS/1000}s`));
      }, TIMEOUT_MS);

      function listener(event) {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.type !== 'ARAD_BRIDGE_RESPONSE') return;
        if (d.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        resolve(d.response);
      }
      window.addEventListener('message', listener);

      window.postMessage({
        type: 'ARAD_BRIDGE_REQUEST',
        requestId,
        action,
        payload
      }, window.location.origin);
    });
  }

  // ─── Auto-restore from chrome.storage on init ─────────────────
  // Runs once when page-bridge.js is injected. Restores enabledModules
  // so users don't need to call handshake() after every page reload.
  function startAutoRestore() {
    if (autoRestorePromise) return autoRestorePromise;
    autoRestorePromise = sendRequest('GET_ENABLED_MODULES')
      .then(r => {
        if (Array.isArray(r?.enabled_modules) && r.enabled_modules.length > 0) {
          enabledModules = r.enabled_modules;
          handshakeDone = true;
          console.log(`[ARAD Bridge] Auto-restored ${enabledModules.length} modules:`,
                      enabledModules);
        }
      })
      .catch(() => { /* silent — handshake() will surface the issue if needed */ });
    return autoRestorePromise;
  }

  // ─── Module gating helper ─────────────────────────────────────
  // Wraps a method so it throws if the required module isn't enabled.
  // ALWAYS awaits autoRestorePromise first to give init a chance to load
  // saved modules from chrome.storage.
  function gated(moduleId, method) {
    return async function (...args) {
      // Wait for auto-restore to complete (resolves immediately if done)
      await startAutoRestore();

      if (!enabledModules) {
        throw new Error(
          `ARAD Bridge: handshake() not called yet for this customer. ` +
          `Call window.__aradBridge.handshake({...}) first.`
        );
      }
      if (!enabledModules.includes(moduleId)) {
        const err = new Error(
          `ARAD Bridge: module '${moduleId}' is not enabled for this customer. ` +
          `Available modules: [${enabledModules.join(', ')}]`
        );
        err.code = 'MODULE_NOT_ENABLED';
        err.module = moduleId;
        throw err;
      }
      return method(...args);
    };
  }

  // ─── Public API: window.__aradBridge ──────────────────────────
  const bridge = {
    isInstalled: true,
    version: VERSION,

    // ─── Core (always available) ──────────────────────────────
    /**
     * Handshake with the extension. Tells it which customer is logged in
     * and which modules the customer should have enabled.
     *
     * @param {object} opts
     * @param {string} opts.customer_id  - your DB customer ID
     * @param {string} opts.app_origin   - typically window.location.origin
     * @param {string[]} opts.enabled_modules - list like ['piba','hopon','wa_single']
     * @param {string} [opts.user_id]    - optional user identifier
     * @returns {Promise<{success, active_modules, version, missing_daemon?}>}
     */
    async handshake(opts) {
      const result = await sendRequest('HANDSHAKE', opts);
      if (result?.success) {
        enabledModules = result.active_modules || [];
        handshakeDone = true;
      }
      return result;
    },

    /** Check if a module is enabled WITHOUT making a round-trip. */
    isModuleEnabled(moduleId) {
      return Array.isArray(enabledModules) && enabledModules.includes(moduleId);
    },

    /** Get the list of currently-enabled modules. */
    getEnabledModules() {
      return Array.isArray(enabledModules) ? [...enabledModules] : [];
    },

    /** Get bridge + all-modules health status. */
    getStatus() {
      return sendRequest('GET_BRIDGE_STATUS');
    },

    // ─── PIBA module ──────────────────────────────────────────
    fetchPibaVisa:      gated('piba', (foreignKey) => sendRequest('PIBA_FETCH_VISA', { foreignKey })),
    fetchPibaInterVisa: gated('piba', (foreignKey) => sendRequest('PIBA_FETCH_INTER_VISA', { foreignKey })),
    openPiba:           gated('piba', () => sendRequest('OPEN_PIBA')),

    // ─── HopOn module ─────────────────────────────────────────
    getHopOnToken: gated('hopon', () => sendRequest('GET_HOPON_TOKEN')),
    openHopOn:     gated('hopon', () => sendRequest('OPEN_HOPON')),

    // ─── WhatsApp Single module ───────────────────────────────
    openWhatsAppChat: gated('whatsapp_single', (phone, message, autoSend = false, options = null) =>
      sendRequest('WHATSAPP_OPEN_CHAT', { phone, message, autoSend, options })
    ),
    getWhatsAppStatus: gated('whatsapp_single', () => sendRequest('WHATSAPP_GET_STATUS')),
    openWhatsApp:      gated('whatsapp_single', () => sendRequest('OPEN_WHATSAPP')),

    // ─── WhatsApp Bulk module ─────────────────────────────────
    getBulkDaemonStatus: gated('whatsapp_bulk', () => sendRequest('BULK_DAEMON_STATUS')),
    openBulkWhatsApp:    gated('whatsapp_bulk', () => sendRequest('BULK_OPEN_WHATSAPP')),
    startBulkSend:       gated('whatsapp_bulk', (payload) => sendRequest('BULK_SEND_START', { payload })),
    stopBulkSend:        gated('whatsapp_bulk', (job_id) => sendRequest('BULK_SEND_STOP', { job_id })),
    pauseBulkSend:       gated('whatsapp_bulk', (job_id) => sendRequest('BULK_SEND_PAUSE', { job_id })),
    resumeBulkSend:      gated('whatsapp_bulk', (job_id) => sendRequest('BULK_SEND_RESUME', { job_id })),

    /**
     * Subscribe to SSE progress from a bulk job. Uses EventSource directly
     * to localhost:8766 (no message routing needed - both run in browser).
     */
    subscribeBulkProgress: gated('whatsapp_bulk', (job_id, onEvent, onComplete) => {
      const es = new EventSource('http://127.0.0.1:8766/progress/' + encodeURIComponent(job_id));
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (typeof onEvent === 'function') onEvent(data);
          if (data.type === 'complete' || data.type === 'stopped' || data.type === 'error') {
            es.close();
            if (typeof onComplete === 'function') onComplete(data);
          }
        } catch (e) {
          console.error('[ARAD Bridge] bulk progress parse error', e, ev.data);
        }
      };
      es.onerror = () => {
        es.close();
        if (typeof onComplete === 'function') {
          onComplete({ type: 'error', message: 'SSE disconnected' });
        }
      };
      return () => es.close();  // unsubscribe fn
    })
  };

  // Freeze top-level (methods can still be called, but the object can't be mutated)
  window.__aradBridge = Object.freeze(bridge);

  // Signal to content scripts AND app code that the bridge is ready.
  // We fire MULTIPLE event names for backward compatibility with code
  // written for the legacy D.Yohai/Base44 bridge:
  //   - 'arad-bridge-injected'  → ARAD-native
  //   - 'base44-bridge-ready'   → D.Yohai/Base44 compatibility (used by
  //                                ARAD app's waitForBridge in lib/aradBridge.ts)
  const detail = { version: VERSION, bridge: 'arad' };
  window.dispatchEvent(new CustomEvent('arad-bridge-injected', { detail }));
  window.dispatchEvent(new CustomEvent('arad-bridge-ready',    { detail }));
  window.dispatchEvent(new CustomEvent('base44-bridge-ready',  { detail }));

  // Kick off auto-restore in background. Module-gated methods will await it.
  startAutoRestore();

  console.log(`[ARAD Bridge] v${VERSION} injected. Auto-restoring modules from storage...`);
})();
