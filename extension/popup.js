// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Popup (Wizard + Health Cards)
// ═══════════════════════════════════════════════════════════════════
//  Three views: welcome / modules / status
//  Status view shows one card per ENABLED module with live health.
//
//  URL params:
//    ?firstrun=1 → start wizard from welcome
//    ?wizard=1   → start wizard from modules (reopen wizard)
//    (none)      → show status (default)
// ═══════════════════════════════════════════════════════════════════

import { MODULES } from './core/modules-registry.js';

// ─── Update check configuration ──────────────────────────────────
const GITHUB_REPO = 'liorgab/arad-bridge';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;  // every 6 hours
const UPDATE_STORAGE_KEY = 'arad_last_update_check';

const VIEWS = ['welcome', 'modules', 'status'];
let currentView = 'status';
let selectedModules = new Set();
let bridgeStatus = null;
let healthCache = null;

// ─── Module display config (icons, action button text/color) ─────
const MODULE_CONFIG = {
  piba: {
    title: 'PIBA — הנפקת ויזות',
    emoji: '🪪',
    actionLabel: 'פתח את PIBA',
    actionClass: 'primary',
    actionMessage: 'OPEN_PIBA'
  },
  hopon: {
    title: 'HopOn — נסיעות',
    emoji: '🚌',
    actionLabel: 'פתח את HopOn',
    actionClass: 'gray',
    actionMessage: 'OPEN_HOPON'
  },
  whatsapp_single: {
    title: 'WhatsApp — שליחה יחידה',
    emoji: '💬',
    actionLabel: 'פתח WhatsApp Web',
    actionClass: 'success',
    actionMessage: 'OPEN_WHATSAPP'
  },
  whatsapp_bulk: {
    title: 'WhatsApp Bulk — שליחה המונית',
    emoji: '📤',
    actionLabel: 'פתח Chrome Test לסריקת QR',
    actionClass: 'success',
    actionMessage: 'BULK_OPEN_WHATSAPP'
  }
};

// ─── View routing ────────────────────────────────────────────────
function showView(name) {
  if (!VIEWS.includes(name)) return;
  currentView = name;
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).classList.toggle('active', v === name);
  }
  if (name === 'modules') renderModulesWizard();
  if (name === 'status')  renderStatusView();
}

// ─── Init: pick initial view from URL params ─────────────────────
async function init() {
  try {
    bridgeStatus = await chrome.runtime.sendMessage({ type: 'GET_BRIDGE_STATUS' });
  } catch (e) {
    bridgeStatus = { installed: false, error: e.message };
  }

  if (bridgeStatus?.enabled_modules) {
    selectedModules = new Set(bridgeStatus.enabled_modules);
  }

  const params = new URLSearchParams(window.location.search);
  if (params.has('firstrun'))    showView('welcome');
  else if (params.has('wizard')) showView('modules');
  else                           showView('status');
}

// ─── VIEW: Modules wizard ────────────────────────────────────────
function renderModulesWizard() {
  const container = document.getElementById('modules-list');
  container.innerHTML = '';

  for (const [id, m] of Object.entries(MODULES)) {
    const isOn = selectedModules.has(id);
    const row = document.createElement('div');
    row.className = 'module-row' + (isOn ? ' enabled' : '');

    const info = document.createElement('div');
    info.className = 'module-info';
    info.innerHTML = `
      <div class="module-name">${escape(m.name)}</div>
      <div class="module-desc">${escape(m.description)}</div>
      <div class="module-meta">${escape(m.sku)} · v${escape(m.version)}</div>
    `;
    row.appendChild(info);

    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    toggle.innerHTML = `<input type="checkbox" ${isOn ? 'checked' : ''}><span class="slider"></span>`;
    const cb = toggle.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) selectedModules.add(id);
      else            selectedModules.delete(id);
      renderModulesWizard();
    });
    row.appendChild(toggle);

    container.appendChild(row);
  }
}

// ─── VIEW: Status — card per module with health ─────────────────
async function renderStatusView() {
  // Refresh bridge status
  try {
    bridgeStatus = await chrome.runtime.sendMessage({ type: 'GET_BRIDGE_STATUS' });
  } catch (e) {
    bridgeStatus = { installed: false, error: e.message };
  }

  const customerLabel = document.getElementById('customer-label');
  const cardsEl = document.getElementById('health-cards');

  if (bridgeStatus?.customer?.customer_id) {
    customerLabel.textContent = `לקוח: ${bridgeStatus.customer.customer_id}`;
  } else {
    customerLabel.textContent = 'ממתין ל-handshake';
  }

  const enabled = new Set(bridgeStatus?.enabled_modules || []);

  if (enabled.size === 0) {
    cardsEl.innerHTML = `
      <div class="empty-state">
        לא הופעלו מודולים עדיין
        <div class="hint">
          היכנס ל-ARAD app כדי לבצע handshake אוטומטי,<br/>
          או לחץ "הגדרות מודולים" למטה לבחירה ידנית.
        </div>
      </div>
    `;
    return;
  }

  // Fetch health for all modules in one call
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_MODULE_HEALTH' });
    healthCache = r?.health || {};
  } catch (e) {
    healthCache = {};
  }

  cardsEl.innerHTML = '';
  for (const id of enabled) {
    const cfg = MODULE_CONFIG[id];
    if (!cfg) continue;
    const health = healthCache[id] || { ok: false, status: 'UNKNOWN', message: 'לא ידוע' };
    cardsEl.appendChild(renderHealthCard(id, cfg, health));
  }
}

function renderHealthCard(id, cfg, health) {
  const card = document.createElement('div');
  card.className = 'module-card';

  // Status pill class
  let pillClass = 'bad';
  let pillIcon = '✗';
  if (health.ok) { pillClass = 'ok'; pillIcon = '✓'; }
  else if (health.status === 'DAEMON_NO_WA' || health.status === 'EXPIRED' ||
           health.status === 'NOT_LOGGED_IN' || health.status === 'NO_TAB') {
    pillClass = 'warn'; pillIcon = '⚠';
  }

  card.innerHTML = `
    <div class="module-title">${cfg.emoji} ${escape(cfg.title)}</div>
    <div class="health-pill ${pillClass}">
      <div class="icon">${pillIcon}</div>
      <div class="body">
        <div class="msg">${escape(health.message || health.status || 'לא ידוע')}</div>
        ${health.hint ? `<div class="hint">${escape(health.hint)}</div>` : ''}
        ${health.detail ? `<div class="hint">${escape(health.detail)}</div>` : ''}
      </div>
    </div>
    <button class="action-btn ${cfg.actionClass}" data-open-module="${id}">
      ${escape(cfg.actionLabel)}
    </button>
  `;
  return card;
}

// ─── Helpers ─────────────────────────────────────────────────────
function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function applySelectedModules() {
  for (const id of Object.keys(MODULES)) {
    await chrome.runtime.sendMessage({
      type: 'TOGGLE_MODULE',
      module_id: id,
      enabled: selectedModules.has(id)
    });
  }
}

// ─── Action handlers ─────────────────────────────────────────────
document.body.addEventListener('click', async (e) => {
  // Wizard action
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action) {
    switch (action) {
      case 'skip-to-status':       showView('status'); return;
      case 'next-to-modules':      showView('modules'); return;
      case 'back-to-welcome':      showView('welcome'); return;
      case 'modules-to-status':
        await applySelectedModules();
        showView('status');
        return;
    }
  }

  // Module action button
  const openModule = e.target.closest('[data-open-module]')?.dataset.openModule;
  if (openModule) {
    const cfg = MODULE_CONFIG[openModule];
    if (cfg?.actionMessage) {
      try {
        await chrome.runtime.sendMessage({ type: cfg.actionMessage });
        // Refresh health after a short delay
        setTimeout(() => renderStatusView(), 1500);
      } catch (err) {
        alert('שגיאה: ' + err.message);
      }
    }
  }
});

document.getElementById('open-wizard').addEventListener('click', (e) => {
  e.preventDefault();
  selectedModules = new Set(bridgeStatus?.enabled_modules || []);
  showView('modules');
});

document.getElementById('refresh-health').addEventListener('click', (e) => {
  e.preventDefault();
  renderStatusView();
});

// ─── Check for updates from GitHub Releases ──────────────────────
async function checkForUpdates(force = false) {
  // Throttle - don't hammer GitHub
  if (!force) {
    const r = await chrome.storage.local.get([UPDATE_STORAGE_KEY]);
    const last = r[UPDATE_STORAGE_KEY] || 0;
    if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json' }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    const current = chrome.runtime.getManifest().version;

    await chrome.storage.local.set({ [UPDATE_STORAGE_KEY]: Date.now() });

    if (latest && current && versionCompare(latest, current) > 0) {
      showUpdateBanner(latest, data.html_url);
    }
  } catch (e) {
    console.warn('[ARAD Bridge] update check failed:', e);
  }
}

function versionCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function showUpdateBanner(latestVersion, url) {
  const existing = document.getElementById('update-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = `
    background: linear-gradient(135deg, #f59e0b, #d97706);
    color: white; padding: 8px 16px;
    font-size: 12px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
    cursor: pointer;
  `;
  banner.innerHTML = `
    <span>⬆️ גרסה חדשה זמינה: v${escape(latestVersion)}</span>
    <a href="${escape(url)}" target="_blank" style="margin-right: auto; color: white; text-decoration: underline;">
      צפה בעדכון
    </a>
  `;
  banner.addEventListener('click', () => {
    chrome.tabs.create({ url });
  });
  document.body.insertBefore(banner, document.body.firstChild);
}

// Run on popup open
checkForUpdates();

init();
