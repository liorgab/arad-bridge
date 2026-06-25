# ARAD Bridge — Developer Guide

> איך לפתח/לתחזק את ה-extension. אם אתה מוסיף מודול חדש או מתקן באג ב-Core — זה המסמך שלך.

---

## ארכיטקטורה ב-2 דקות

```
ARAD app (Vercel)              window.__aradBridge.fetchPibaVisa('...')
       ↓                                    ↓
   page-bridge.js  ──── postMessage ───→  content-arad.js
                                            ↓ chrome.runtime.sendMessage
   background.js (router)
       ↓ findModuleByMessageType()
       ↓ isModuleEnabled() ?
       ↓ dynamic import('modules/piba/handler.js')
   handler('PIBA_FETCH_VISA', msg, sender)
       ↓ uses piba_token from chrome.storage (synced by content.js)
       ↓ fetch('inforhub.piba.gov.il/...')
       ↓ returns { success, pdf_base64, ... }
```

3 worlds:
- **Page main world** — ARAD app's React/JS code. Has `window.__aradBridge`.
- **Isolated content world** — `content-arad.js`, `content-piba.js`, etc. Has `chrome.*`.
- **Background service worker** — `background.js` + module handlers. Has full API.

`page-bridge.js` is the only file that lives in the page's main world. The others all run in content/background.

---

## הוספת מודול חדש (דוגמה: "mahanet")

### שלב 1 — צור את התיקייה

```
extension/modules/mahanet/
├── module.json         ← required
├── handler.js          ← required
├── content.js          ← optional (only if injecting to a foreign domain)
└── README.md           ← strongly recommended
```

### שלב 2 — module.json (חוזה המודול)

```json
{
  "id": "mahanet",
  "name": "מאחנט — דוחות נוכחות",
  "version": "1.0.0",
  "description": "סנכרון דוחות נוכחות יומיים מ-Mahanet",
  "category": "attendance",
  "sku": "MAHANET_001",
  "host_permissions": ["https://mahanet.co.il/*"],
  "content_scripts": [
    {
      "file": "modules/mahanet/content.js",
      "matches": ["https://mahanet.co.il/*"],
      "run_at": "document_idle"
    }
  ],
  "handler": "modules/mahanet/handler.js",
  "message_types": ["MAHANET_FETCH_REPORT", "MAHANET_LIST_EMPLOYEES"],
  "storage_keys": ["mahanet_token", "mahanet_token_exp"]
}
```

### שלב 3 — handler.js (background logic)

```javascript
// modules/mahanet/handler.js
async function fetchReport(date) {
  const { mahanet_token } = await chrome.storage.local.get(['mahanet_token']);
  if (!mahanet_token) return { success: false, error_code: 'NO_TOKEN' };

  const resp = await fetch(`https://mahanet.co.il/api/reports?date=${date}`, {
    headers: { 'Authorization': `Bearer ${mahanet_token}` }
  });
  if (!resp.ok) return { success: false, error_code: 'API_ERROR', status: resp.status };
  return { success: true, data: await resp.json() };
}

export default async function handle(type, msg, sender) {
  switch (type) {
    case 'MAHANET_FETCH_REPORT':
      return fetchReport(msg.date);
    case 'MAHANET_LIST_EMPLOYEES':
      // ... etc
      return { success: false, error: 'not implemented' };
    default:
      return { success: false, error: `Unknown type: ${type}` };
  }
}
```

### שלב 4 — content.js (only if needed)

```javascript
// modules/mahanet/content.js
// Runs on https://mahanet.co.il/*
// Syncs token from page localStorage to chrome.storage
(function () {
  setInterval(async () => {
    const token = localStorage.getItem('userToken');
    if (token) await chrome.storage.local.set({ mahanet_token: token });
  }, 5000);
})();
```

### שלב 5 — רשום ב-core/modules-registry.js

הוסף את המודול לאובייקט `MODULES`:

```javascript
mahanet: {
  id: 'mahanet',
  name: 'מאחנט — דוחות נוכחות',
  // ... copy fields from module.json ...
  api: [
    { method: 'fetchMahanetReport', message: 'MAHANET_FETCH_REPORT' },
    { method: 'listMahanetEmployees', message: 'MAHANET_LIST_EMPLOYEES' }
  ]
}
```

### שלב 6 — חשוף ב-core/page-bridge.js

הוסף את המתודות לבריג':

```javascript
fetchMahanetReport: gated('mahanet', (date) =>
  sendRequest('MAHANET_FETCH_REPORT', { date })
),
listMahanetEmployees: gated('mahanet', () =>
  sendRequest('MAHANET_LIST_EMPLOYEES')
),
```

### שלב 7 — עדכן manifest.json

הוסף את ה-host_permission:

```json
"host_permissions": [
  ...,
  "https://mahanet.co.il/*"
]
```

### שלב 8 — בדיקה

```powershell
# 1. Reload extension in chrome://extensions
# 2. Update ARAD DB: insert customer_modules row with module_id='mahanet'
# 3. In ARAD app console:
window.__aradBridge.handshake({...})
window.__aradBridge.isModuleEnabled('mahanet')  // should be true
window.__aradBridge.fetchMahanetReport('2026-06-20')  // should work
```

**זהו.** שום שינוי בליבה. שום קובץ עוד שצריך לערוך.

---

## בעיות נפוצות

### "Module not enabled for this customer"

```
Uncaught (in promise) Error: ARAD Bridge: module 'piba' is not enabled
```

**הסיבה:** קראת ל-method של מודול לפני שהבצעת handshake.
**הפתרון:** הוסף `await window.__aradBridge.handshake({...})` בtop-level של ה-app.

### "ARAD Bridge: handshake() not called yet"

**הסיבה:** ה-app טוען לפני שהbridge הספיק לאתחל.
**הפתרון:**
```javascript
// Wait for the bridge to inject
await new Promise(resolve => {
  if (window.__aradBridge) resolve();
  else window.addEventListener('arad-bridge-injected', resolve, { once: true });
});
await window.__aradBridge.handshake({...});
```

### Dynamic content script registration fails

**הסיבה:** ייתכן שה-host_permission חסר ב-manifest.json
**הפתרון:** ודא שכל ה-host_permissions של כל המודולים מוכרזים ב-manifest

### "UNKNOWN_MESSAGE_TYPE"

**הסיבה:** ה-message type לא רשום ב-`message_types` של אף module.json
**הפתרון:** הוסף את ה-type לcorresponding module.json + reload extension

---

## Debugging

### Background service worker DevTools

```
chrome://extensions/ → ARAD Bridge → "service worker" link
```

צפה ב-console - שם תראה את כל הלוגים של background.js וhandlers.

### Content script DevTools

פתח את הדף שעליו ה-content script רץ (למשל inforhub.piba.gov.il), F12, Console. הלוגים יופיעו עם prefix `[ARAD Bridge/XXX]`.

### Storage inspector

```javascript
// In any content script's console:
chrome.storage.local.get(null, (data) => console.log(data));
```

יראה לך את כל הstate של ה-extension.

### Reset everything

```javascript
chrome.storage.local.clear();
location.reload();
```

---

## Test checklist לפני release

- [ ] כל ה-JSON files passes `JSON.parse`
- [ ] כל ה-JS files passes `node -c`
- [ ] manifest.json — version עלתה
- [ ] handshake עובד עם רשימת מודולים ריקה (active_modules: [])
- [ ] handshake עובד עם רשימה מלאה (כל המודולים)
- [ ] handshake דוחה module IDs לא חוקיים (unknown_modules)
- [ ] gating: קריאה ל-fetchPibaVisa כשpiba לא enabled → MODULE_NOT_ENABLED error
- [ ] daemon check: כש-wa_bulk enabled אבל daemon לא רץ → missing_daemon: true
- [ ] content scripts נרשמים דינמית ולא נטענים למודולים disabled
- [ ] popup מציג את הסטטוס נכון

---

## פיתוח עתידי

- שדרוג ל-signed JWT handshake (למנוע client-side tampering)
- Multi-tenant module variants (אותו module, configs שונים פר customer)
- Module marketplace UI ב-ARAD app
- Telemetry (פר-קריאה: latency, errors) להבנת איך משתמשים
