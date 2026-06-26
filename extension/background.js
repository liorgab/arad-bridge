// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Background Service Worker (Module Router)
// ═══════════════════════════════════════════════════════════════════
//  This is the heart of the extension. It's intentionally THIN:
//   • Receives ALL messages from content scripts (via chrome.runtime)
//   • Looks up which module owns each message type (from registry)
//   • Dispatches to the module's handler.js
//   • Returns the handler's response back
//
//  Adding a new module = add the module dir + register here + add
//  module entry to modules-registry.js. ~10 lines total.
//
//  IMPLEMENTATION NOTE — why static imports instead of dynamic:
//  MV3 service workers don't reliably support `import()` of extension
//  URLs (chrome-extension://[id]/...). We tried, hit HANDLER_LOAD_FAILED.
//  Static imports work universally. The cost (handlers parsed even if
//  module disabled) is negligible — they only EXECUTE when called via
//  the router, which gates on isModuleEnabled().
// ═══════════════════════════════════════════════════════════════════

import {
  MODULES,
  CORE,
  findModuleByMessageType,
  getModule
} from './core/modules-registry.js';
import {
  isModuleEnabled,
  getEffectiveEnabledModules,
  getCustomerInfo
} from './core/storage.js';
import {
  handleHandshake,
  initializeOnInstall,
  reconfigureFromOverrides
} from './core/auth-handshake.js';
import {
  setUserOverride,
  getUserOverrides,
  clearUserOverrides
} from './core/storage.js';

// ─── Static handler imports (MV3-compatible) ─────────────────────
// Adding a new module = add one import + one HANDLERS entry below.
import pibaHandler,           { getHealth as pibaHealth }     from './modules/piba/handler.js';
import hoponHandler,          { getHealth as hoponHealth }    from './modules/hopon/handler.js';
import waSingleHandler,       { getHealth as waSingleHealth } from './modules/whatsapp-single/handler.js';
import waBulkHandler,         { getHealth as waBulkHealth }   from './modules/whatsapp-bulk/handler.js';

const HANDLERS = {
  piba:            pibaHandler,
  hopon:           hoponHandler,
  whatsapp_single: waSingleHandler,
  whatsapp_bulk:   waBulkHandler
};

const HEALTH_CHECKS = {
  piba:            pibaHealth,
  hopon:           hoponHealth,
  whatsapp_single: waSingleHealth,
  whatsapp_bulk:   waBulkHealth
};

function getHandler(moduleId) {
  return HANDLERS[moduleId] || null;
}

// ─── Core message handlers (always available) ────────────────────
const coreHandlers = {
  GET_BRIDGE_STATUS: async () => {
    // EFFECTIVE = server (handshake) ∪ user overrides (popup toggles).
    // Reading getEnabledModules() here was the bug: it returns the empty
    // server-set list until handshake succeeds, so manual toggles never
    // showed up in the status view ("לא הופעלו מודולים").
    const enabled = await getEffectiveEnabledModules();
    const customer = await getCustomerInfo();

    // ─── Legacy compatibility: per-module health in flat shape ──────
    // The ARAD admin app (lib/aradBridge.ts) checks status.piba.valid,
    // status.hopon.valid, etc — matching the D.Yohai/Base44 contract.
    // We compute them here from chrome.storage so existing app code
    // works without changes.
    const piba   = await chrome.storage.local.get(['piba_token', 'piba_token_exp']);
    const hopon  = await chrome.storage.local.get(['hopon_token', 'hopon_token_updated_at']);
    const wa     = await chrome.storage.local.get(['whatsapp_logged_in', 'arad_wa_history']);
    const now = Date.now();

    return {
      installed: true,
      version: '2.0.0',
      enabled_modules: enabled,
      customer,

      // ─── Legacy per-module shape ─────────────────────────────────
      piba: {
        valid: !!(piba.piba_token && (piba.piba_token_exp || 0) > now + 30_000),
        exp: piba.piba_token_exp || null,
        minutes_remaining: piba.piba_token_exp
          ? Math.max(0, Math.round((piba.piba_token_exp - now) / 60000))
          : 0
      },
      hopon: {
        valid: !!hopon.hopon_token,
        updated_at: hopon.hopon_token_updated_at || null
      },
      whatsapp: {
        valid: !!wa.whatsapp_logged_in,
        sent_today: (wa.arad_wa_history || []).filter(t => now - t < 86_400_000).length
      }
    };
  },

  HANDSHAKE: async (payload) => handleHandshake(payload),

  GET_ENABLED_MODULES: async () => {
    return { enabled_modules: await getEffectiveEnabledModules() };
  },

  CHECK_MODULE_REQUIREMENTS: async ({ module_id }) => {
    const m = getModule(module_id);
    if (!m) return { ok: false, error: 'unknown module' };
    if (!m.requires_external) return { ok: true, required: false };

    const req = m.requires_external;
    if (req.type === 'daemon') {
      try {
        const r = await fetch(req.check_url, { signal: AbortSignal.timeout(2000) });
        return { ok: r.ok, required: true, type: 'daemon', name: req.name };
      } catch {
        return {
          ok: false,
          required: true,
          type: 'daemon',
          name: req.name,
          download_url: req.download_url,
          installer_size_mb: req.installer_size_mb
        };
      }
    }
    return { ok: true, required: false };
  },

  // ─── Wizard / Manage Modules support ─────────────────────────
  TOGGLE_MODULE: async ({ module_id, enabled }) => {
    if (!getModule(module_id)) {
      return { success: false, error: `unknown module: ${module_id}` };
    }
    await setUserOverride(module_id, !!enabled);
    return reconfigureFromOverrides();
  },

  GET_USER_OVERRIDES: async () => {
    return { overrides: await getUserOverrides() };
  },

  CLEAR_USER_OVERRIDES: async () => {
    await clearUserOverrides();
    return reconfigureFromOverrides();
  },

  RECONFIGURE_MODULES: async () => {
    return reconfigureFromOverrides();
  },

  // ─── Per-module health check (for popup health cards) ────────
  // Returns: { piba: {ok, status, message, hint?, detail?}, hopon: {...}, ... }
  // Includes ALL modules (even disabled ones, marked as 'DISABLED').
  GET_MODULE_HEALTH: async () => {
    const enabled = new Set(await getEffectiveEnabledModules());
    const result = {};
    for (const [id, healthFn] of Object.entries(HEALTH_CHECKS)) {
      if (!enabled.has(id)) {
        result[id] = { ok: false, status: 'DISABLED', message: 'מודול לא פעיל' };
        continue;
      }
      try {
        result[id] = await healthFn();
      } catch (e) {
        result[id] = { ok: false, status: 'ERROR', message: e.message };
      }
    }
    return { health: result };
  }
};

// ─── Message router (the only chrome.runtime.onMessage listener) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { type } = msg || {};
  if (!type) {
    sendResponse({ success: false, error: 'message missing type' });
    return false;
  }

  // Core message?
  if (coreHandlers[type]) {
    coreHandlers[type](msg)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // Module message?
  const owner = findModuleByMessageType(type);
  if (!owner) {
    sendResponse({
      success: false,
      error_code: 'UNKNOWN_MESSAGE_TYPE',
      error: `No module handles message type '${type}'`
    });
    return false;
  }

  // Module owns this message — check if enabled
  isModuleEnabled(owner.id).then(enabled => {
    if (!enabled) {
      sendResponse({
        success: false,
        error_code: 'MODULE_NOT_ENABLED',
        error: `Module '${owner.id}' (${owner.name}) is not enabled for this customer`,
        module: owner.id
      });
      return;
    }

    // Module enabled — dispatch to its handler
    const handler = getHandler(owner.id);
    if (!handler) {
      sendResponse({
        success: false,
        error_code: 'HANDLER_NOT_REGISTERED',
        error: `Module '${owner.id}' is enabled but no handler is registered in background.js HANDLERS map`
      });
      return;
    }
    Promise.resolve(handler(type, msg, sender))
      .then(sendResponse)
      .catch(e => sendResponse({
        success: false,
        error_code: 'HANDLER_ERROR',
        error: e.message,
        stack: e.stack
      }));
  });

  return true;  // keep sendResponse channel open for async
});

// ─── Install/update lifecycle ────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[ARAD Bridge] Installed/updated:', details.reason);

  // Always register Core content scripts (needed for handshake)
  await initializeOnInstall();

  // Open the wizard on first install
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?firstrun=1') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[ARAD Bridge] Service worker started');
});

console.log('[ARAD Bridge] Background service worker loaded with 4 module handlers');
