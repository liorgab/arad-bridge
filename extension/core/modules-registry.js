// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — Modules Registry
// ═══════════════════════════════════════════════════════════════════
//  Central catalog of every module the extension knows about.
//
//  Adding a new module = add an entry here + create modules/<id>/
//  with module.json, handler.js, (optional) content.js.
//
//  The router (background.js) reads this to know which handlers to
//  load and which content scripts to register dynamically.
// ═══════════════════════════════════════════════════════════════════

export const MODULES = {
  // ─── PIBA — Visa issuance from Israel Population Authority ─────
  piba: {
    id: 'piba',
    name: 'PIBA — הנפקת ויזות',
    description: 'הנפקה אוטומטית של אישורי שהייה ואישורי כניסה מאתר רשות האוכלוסין',
    icon: 'icons/module-piba.svg',
    version: '1.0.0',
    category: 'government',
    sku: 'PIBA_001',
    required: false,

    // Permissions this module needs (declared in manifest, used when enabled)
    host_permissions: [
      'https://inforhub.piba.gov.il/*'
    ],

    // Content scripts registered dynamically when module is enabled
    content_scripts: [
      {
        file: 'modules/piba/content.js',
        matches: ['https://inforhub.piba.gov.il/*'],
        run_at: 'document_idle'
      }
    ],

    // Background handler — receives messages of these types
    handler: 'modules/piba/handler.js',
    message_types: [
      'PIBA_FETCH_VISA',
      'PIBA_FETCH_INTER_VISA',
      'OPEN_PIBA'
    ],

    // API methods exposed via window.__aradBridge
    api: [
      { method: 'fetchPibaVisa',      message: 'PIBA_FETCH_VISA' },
      { method: 'fetchPibaInterVisa', message: 'PIBA_FETCH_INTER_VISA' },
      { method: 'openPiba',           message: 'OPEN_PIBA' }
    ],

    requires_external: null
  },

  // ─── HopOn — Travel management integration ─────────────────────
  hopon: {
    id: 'hopon',
    name: 'HopOn — ניהול נסיעות',
    description: 'אינטגרציה עם פלטפורמת HopOn לניהול נסיעות עובדים — סנכרון tokens אוטומטי',
    icon: 'icons/module-hopon.svg',
    version: '1.0.0',
    category: 'transport',
    sku: 'HOPON_001',
    required: false,

    host_permissions: [
      'https://b2b-dashboard.hopon.co/*',
      'https://api-gateway.hopon.co/*'
    ],

    content_scripts: [
      {
        file: 'modules/hopon/content.js',
        matches: ['https://b2b-dashboard.hopon.co/*'],
        run_at: 'document_idle'
      }
    ],

    handler: 'modules/hopon/handler.js',
    message_types: [
      'GET_HOPON_TOKEN',
      'OPEN_HOPON'
    ],

    api: [
      { method: 'getHopOnToken', message: 'GET_HOPON_TOKEN' },
      { method: 'openHopOn',     message: 'OPEN_HOPON' }
    ],

    requires_external: null
  },

  // ─── WhatsApp Single — Single message send via regular Chrome ──
  whatsapp_single: {
    id: 'whatsapp_single',
    name: 'WhatsApp — שליחה יחידה',
    description: 'שליחת הודעה יחידה לעובד דרך הדפדפן הרגיל. לא מתאים לשליחה המונית.',
    icon: 'icons/module-wa-single.svg',
    version: '1.0.0',
    category: 'messaging',
    sku: 'WA_SINGLE_001',
    required: false,

    host_permissions: [
      'https://web.whatsapp.com/*'
    ],

    content_scripts: [
      {
        file: 'modules/whatsapp-single/content.js',
        matches: ['https://web.whatsapp.com/*'],
        run_at: 'document_idle'
      }
    ],

    handler: 'modules/whatsapp-single/handler.js',
    message_types: [
      'WHATSAPP_OPEN_CHAT',
      'WHATSAPP_AUTO_SEND',
      'WHATSAPP_GET_STATUS',
      'OPEN_WHATSAPP',
      // Native helper for PDF dialog (optional sub-feature)
      'NATIVE_PING',
      'NATIVE_SAVE_FILE',
      'NATIVE_PASTE_PATH',
      'NATIVE_WAIT_AND_PASTE',
      'NATIVE_CLICK_AT_SCREEN',
      'NATIVE_CLEANUP'
    ],

    api: [
      { method: 'openWhatsAppChat',   message: 'WHATSAPP_OPEN_CHAT' },
      { method: 'getWhatsAppStatus',  message: 'WHATSAPP_GET_STATUS' },
      { method: 'openWhatsApp',       message: 'OPEN_WHATSAPP' }
    ],

    requires_external: null
  },

  // ─── WhatsApp Bulk — Bulk send via external Python daemon ──────
  whatsapp_bulk: {
    id: 'whatsapp_bulk',
    name: 'WhatsApp — שליחה המונית',
    description: 'שליחה מרוכזת של מאות הודעות עם השהיות אנטי-באן. דורש התקנת ARAD Bulk Daemon נפרד.',
    icon: 'icons/module-wa-bulk.svg',
    version: '1.0.0',
    category: 'messaging',
    sku: 'WA_BULK_001',
    required: false,

    host_permissions: [
      'http://127.0.0.1:8766/*',
      'http://localhost:8766/*'
    ],

    // No content scripts — this module only talks to the local daemon over HTTP
    content_scripts: [],

    handler: 'modules/whatsapp-bulk/handler.js',
    message_types: [
      'BULK_DAEMON_STATUS',
      'BULK_OPEN_WHATSAPP',
      'BULK_SEND_START',
      'BULK_SEND_STOP',
      'BULK_SEND_PAUSE',
      'BULK_SEND_RESUME'
    ],

    api: [
      { method: 'getBulkDaemonStatus', message: 'BULK_DAEMON_STATUS' },
      { method: 'openBulkWhatsApp',    message: 'BULK_OPEN_WHATSAPP' },
      { method: 'startBulkSend',       message: 'BULK_SEND_START' },
      { method: 'stopBulkSend',        message: 'BULK_SEND_STOP' },
      { method: 'pauseBulkSend',       message: 'BULK_SEND_PAUSE' },
      { method: 'resumeBulkSend',      message: 'BULK_SEND_RESUME' }
      // subscribeBulkProgress is implemented in page-bridge directly (EventSource)
    ],

    requires_external: {
      type: 'daemon',
      name: 'ARAD Bulk Daemon',
      port: 8766,
      download_url: 'https://github.com/liorgab/arad-bridge/releases/latest/arad-bulk-daemon-setup.exe',
      installer_size_mb: 250,
      check_url: 'http://127.0.0.1:8766/status'
    }
  }
};

// ─── Core — always active, never disabled ────────────────────────
// Provides infrastructure: window.__aradBridge factory, message router,
// handshake with ARAD app, module gating.
export const CORE = {
  id: 'core',
  name: 'Core — תשתית',
  description: 'התשתית של ה-Extension. תמיד פעילה.',
  version: '1.0.0',
  required: true,

  // ARAD app domains where we inject window.__aradBridge
  host_permissions: [
    'https://arad-admin.vercel.app/*',
    'https://*.vercel.app/*'  // preview URLs
  ],

  content_scripts: [
    {
      file: 'core/content-arad.js',
      matches: [
        'https://arad-admin.vercel.app/*',
        'https://*.vercel.app/*'
      ],
      run_at: 'document_start'
    }
  ],

  web_accessible_resources: [
    'core/page-bridge.js'
  ],

  message_types: [
    'GET_BRIDGE_STATUS',
    'HANDSHAKE',
    'GET_ENABLED_MODULES',
    'SET_ENABLED_MODULES',
    'CHECK_MODULE_REQUIREMENTS',
    'TOGGLE_MODULE',
    'GET_USER_OVERRIDES',
    'CLEAR_USER_OVERRIDES',
    'RECONFIGURE_MODULES',
    'GET_MODULE_HEALTH'
  ]
};

// ─── Helpers ─────────────────────────────────────────────────────

/** Get list of all module IDs (excluding core). */
export function getAllModuleIds() {
  return Object.keys(MODULES);
}

/** Get module definition by ID, or null. */
export function getModule(id) {
  return MODULES[id] || null;
}

/** Get module that owns a given message type (or null). */
export function findModuleByMessageType(type) {
  for (const m of Object.values(MODULES)) {
    if (m.message_types.includes(type)) return m;
  }
  return null;
}

/**
 * Build a flat map of method → module for fast api lookups in page-bridge.
 * { fetchPibaVisa: { module: 'piba', message: 'PIBA_FETCH_VISA' }, ... }
 */
export function buildApiMap() {
  const map = {};
  for (const m of Object.values(MODULES)) {
    for (const a of m.api) {
      map[a.method] = { module: m.id, message: a.message };
    }
  }
  return map;
}
