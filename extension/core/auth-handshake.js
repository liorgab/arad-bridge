// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Auth & Handshake Logic
// ═══════════════════════════════════════════════════════════════════
//  Background-side handler for HANDSHAKE messages from the page.
//
//  Flow:
//   1. ARAD app calls window.__aradBridge.handshake({customer_id, ...})
//   2. This handler receives the message
//   3. Validates the customer & module list (currently trust-based)
//   4. Saves to chrome.storage (via storage.js)
//   5. Re-registers content scripts for the new module set
//   6. Returns active_modules to the page
//
//  Future hardening: server-signed JWT to prevent client-side tampering.
// ═══════════════════════════════════════════════════════════════════

import { getModule, getAllModuleIds, CORE } from './modules-registry.js';
import {
  setEnabledModules,
  setCustomerInfo,
  getEffectiveEnabledModules,
  markFirstRunDone
} from './storage.js';

/**
 * Handle HANDSHAKE message. Called from background.js.
 *
 * @param {object} payload  - { customer_id, app_origin, enabled_modules, user_id? }
 * @returns {Promise<{success, active_modules, version, missing_daemon?, error?}>}
 */
export async function handleHandshake(payload) {
  const { customer_id, app_origin, enabled_modules = [], user_id } = payload || {};

  // ─── Validate inputs ─────────────────────────────────────────
  if (!customer_id || typeof customer_id !== 'string') {
    return { success: false, error: 'customer_id is required' };
  }
  if (!Array.isArray(enabled_modules)) {
    return { success: false, error: 'enabled_modules must be an array' };
  }

  // ─── Filter to known modules only (reject unknown IDs) ───────
  const known = new Set(getAllModuleIds());
  const validRequested = enabled_modules.filter(id => known.has(id));
  const unknown = enabled_modules.filter(id => !known.has(id));

  if (unknown.length > 0) {
    console.warn('[ARAD Bridge] Unknown modules requested in handshake:', unknown);
  }

  // ─── Persist customer info + enabled modules ─────────────────
  await setCustomerInfo({
    customer_id,
    app_origin,
    user_id,
    last_handshake_at: Date.now()
  });
  await setEnabledModules(validRequested);
  await markFirstRunDone();

  // ─── Re-register content scripts for the new module set ──────
  // This is what makes module enable/disable take effect WITHOUT
  // a manifest change.
  await registerContentScriptsFor(validRequested);

  // ─── Compute effective modules (server set + any user overrides) ─
  const effective = await getEffectiveEnabledModules();

  // ─── Check for missing external requirements (daemon) ────────
  let missing_daemon = false;
  if (effective.includes('whatsapp_bulk')) {
    missing_daemon = !(await isDaemonReachable());
  }

  return {
    success: true,
    version: '2.0.0',
    active_modules: effective,
    requested_modules: enabled_modules,
    unknown_modules: unknown,
    missing_daemon,
    customer_id
  };
}

/**
 * Re-register content scripts based on CURRENT effective enabled modules
 * (server intent + user overrides). Called by the popup wizard when user
 * toggles a module on/off.
 *
 * @returns {Promise<{success, active_modules, missing_daemon}>}
 */
export async function reconfigureFromOverrides() {
  const effective = await getEffectiveEnabledModules();
  await registerContentScriptsFor(effective);

  let missing_daemon = false;
  if (effective.includes('whatsapp_bulk')) {
    missing_daemon = !(await isDaemonReachable());
  }

  return {
    success: true,
    active_modules: effective,
    missing_daemon
  };
}

/**
 * Dynamically register content scripts for enabled modules.
 * Removes scripts for modules that are no longer enabled.
 *
 * Uses chrome.scripting.registerContentScripts (MV3 API).
 */
async function registerContentScriptsFor(enabledModuleIds) {
  // First, get currently-registered scripts so we can update vs unregister
  const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const existingIds = new Set(existing.map(s => s.id));

  // Build target list from enabled modules
  const targets = [];
  for (const moduleId of enabledModuleIds) {
    const m = getModule(moduleId);
    if (!m) continue;
    for (let i = 0; i < (m.content_scripts || []).length; i++) {
      const cs = m.content_scripts[i];
      targets.push({
        id: `arad_module_${moduleId}_${i}`,
        js: [cs.file],
        matches: cs.matches,
        runAt: cs.run_at || 'document_idle',
        world: cs.world || 'ISOLATED'
      });
    }
  }
  const targetIds = new Set(targets.map(t => t.id));

  // Always include Core content scripts (they're not module-gated)
  for (let i = 0; i < (CORE.content_scripts || []).length; i++) {
    const cs = CORE.content_scripts[i];
    const id = `arad_core_${i}`;
    if (!targetIds.has(id)) {
      targets.push({
        id,
        js: [cs.file],
        matches: cs.matches,
        runAt: cs.run_at || 'document_start',
        world: cs.world || 'ISOLATED'
      });
      targetIds.add(id);
    }
  }

  // Compute diff
  const toUnregister = [...existingIds].filter(id => !targetIds.has(id));
  const toAdd = targets.filter(t => !existingIds.has(t.id));
  const toUpdate = targets.filter(t => existingIds.has(t.id));

  // Apply
  if (toUnregister.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: toUnregister }).catch(e =>
      console.warn('[ARAD Bridge] unregister failed:', e)
    );
  }
  if (toUpdate.length > 0) {
    await chrome.scripting.updateContentScripts(toUpdate).catch(e =>
      console.warn('[ARAD Bridge] update failed:', e)
    );
  }
  if (toAdd.length > 0) {
    await chrome.scripting.registerContentScripts(toAdd).catch(e =>
      console.error('[ARAD Bridge] register failed:', e)
    );
  }

  // ─── Inject into already-open matching tabs ────────────────────
  // registerContentScripts only runs on FUTURE page loads. For tabs
  // already open (very common: user installs ARAD while PIBA is open),
  // we manually executeScript to sync tokens immediately, without F5.
  for (const target of [...toAdd, ...toUpdate]) {
    try {
      const tabs = await chrome.tabs.query({ url: target.matches });
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: target.js
        }).catch(err => {
          // Common errors: tab discarded, no access. Silent.
          console.debug(`[ARAD Bridge] executeScript skipped for tab ${tab.id}:`, err?.message);
        });
      }
    } catch (e) {
      console.warn('[ARAD Bridge] tabs.query failed:', e);
    }
  }

  console.log(`[ARAD Bridge] content scripts: +${toAdd.length} ~${toUpdate.length} -${toUnregister.length}`);
}

/** Quick check if the bulk daemon is reachable on localhost:8766. */
async function isDaemonReachable() {
  try {
    const r = await fetch('http://127.0.0.1:8766/status', {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ─── On extension install/update, register Core scripts immediately ──
// This ensures the bridge is available even before first handshake.
export async function initializeOnInstall() {
  await registerContentScriptsFor([]);  // empty list = only Core scripts
}
