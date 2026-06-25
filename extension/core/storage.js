// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Storage Wrapper
// ═══════════════════════════════════════════════════════════════════
//  Thin wrapper around chrome.storage.local for the extension's state:
//    • enabled_modules: array of module IDs the customer purchased
//    • customer_info:   { customer_id, app_origin, last_handshake_at }
//    • wa_history:      array of timestamps for WA single rate-limiting
//    • daemon_status_cache: last known daemon health (TTL'd)
//
//  All keys are namespaced ('arad_*') so we don't conflict with the
//  legacy D.Yohai bridge if both are installed.
// ═══════════════════════════════════════════════════════════════════

const NS = 'arad_';
const KEYS = {
  ENABLED_MODULES:     NS + 'enabled_modules',
  CUSTOMER_INFO:       NS + 'customer_info',
  WA_HISTORY:          NS + 'wa_history',
  DAEMON_CACHE:        NS + 'daemon_status_cache',
  FIRST_RUN_DONE:      NS + 'first_run_done',
  USER_OVERRIDES:      NS + 'user_overrides'  // manual toggles in popup
};

// ─── Enabled modules ─────────────────────────────────────────────

/**
 * Get the list of currently-enabled module IDs.
 * Returns [] until handshake completes for the first time.
 */
export async function getEnabledModules() {
  const r = await chrome.storage.local.get([KEYS.ENABLED_MODULES]);
  return r[KEYS.ENABLED_MODULES] || [];
}

/**
 * Replace the enabled modules list. Called after successful handshake
 * with ARAD app. Triggers content-script re-registration upstream.
 */
export async function setEnabledModules(moduleIds) {
  if (!Array.isArray(moduleIds)) {
    throw new Error('setEnabledModules: expected array, got ' + typeof moduleIds);
  }
  await chrome.storage.local.set({ [KEYS.ENABLED_MODULES]: moduleIds });
}

/** Quick boolean check for a single module. */
export async function isModuleEnabled(id) {
  const list = await getEnabledModules();
  return list.includes(id);
}

// ─── Customer info ───────────────────────────────────────────────

export async function getCustomerInfo() {
  const r = await chrome.storage.local.get([KEYS.CUSTOMER_INFO]);
  return r[KEYS.CUSTOMER_INFO] || null;
}

export async function setCustomerInfo(info) {
  await chrome.storage.local.set({
    [KEYS.CUSTOMER_INFO]: {
      ...info,
      last_handshake_at: Date.now()
    }
  });
}

// ─── First-run flag (for showing wizard) ─────────────────────────

export async function isFirstRunDone() {
  const r = await chrome.storage.local.get([KEYS.FIRST_RUN_DONE]);
  return !!r[KEYS.FIRST_RUN_DONE];
}

export async function markFirstRunDone() {
  await chrome.storage.local.set({ [KEYS.FIRST_RUN_DONE]: true });
}

// ─── WhatsApp send history (rate limiting) ───────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function getWaHistory() {
  const r = await chrome.storage.local.get([KEYS.WA_HISTORY]);
  const hist = r[KEYS.WA_HISTORY] || [];
  // auto-prune to last 24h
  const cutoff = Date.now() - ONE_DAY_MS;
  return hist.filter(t => t > cutoff);
}

export async function addWaSendTimestamp() {
  const fresh = await getWaHistory();
  fresh.push(Date.now());
  await chrome.storage.local.set({ [KEYS.WA_HISTORY]: fresh });
}

// ─── Daemon status cache (TTL 30s) ───────────────────────────────

const DAEMON_CACHE_TTL_MS = 30 * 1000;

export async function getCachedDaemonStatus() {
  const r = await chrome.storage.local.get([KEYS.DAEMON_CACHE]);
  const c = r[KEYS.DAEMON_CACHE];
  if (!c) return null;
  if (Date.now() - c.cached_at > DAEMON_CACHE_TTL_MS) return null;
  return c.status;
}

export async function setCachedDaemonStatus(status) {
  await chrome.storage.local.set({
    [KEYS.DAEMON_CACHE]: { status, cached_at: Date.now() }
  });
}

// ─── User manual overrides ───────────────────────────────────────
// In the wizard, user can manually disable a module the server enabled,
// or vice versa. These overrides are tracked separately so we don't
// lose server intent.

export async function getUserOverrides() {
  const r = await chrome.storage.local.get([KEYS.USER_OVERRIDES]);
  return r[KEYS.USER_OVERRIDES] || {};
}

export async function setUserOverride(moduleId, enabled) {
  const overrides = await getUserOverrides();
  overrides[moduleId] = enabled;
  await chrome.storage.local.set({ [KEYS.USER_OVERRIDES]: overrides });
}

export async function clearUserOverrides() {
  await chrome.storage.local.remove([KEYS.USER_OVERRIDES]);
}

// ─── Compute effective enabled modules (server intent + overrides) ─

/**
 * Combine server-provided modules + user manual overrides
 * to compute the effective enabled list.
 */
export async function getEffectiveEnabledModules() {
  const serverEnabled = await getEnabledModules();
  const overrides = await getUserOverrides();

  // Start with server set, apply overrides
  const result = new Set(serverEnabled);
  for (const [moduleId, enabled] of Object.entries(overrides)) {
    if (enabled) result.add(moduleId);
    else result.delete(moduleId);
  }
  return Array.from(result);
}

// ─── Reset everything (for debugging / re-install) ───────────────

export async function resetAllState() {
  await chrome.storage.local.remove(Object.values(KEYS));
}
