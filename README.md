# ARAD Bridge

Modular Chrome Extension for the ARAD foreign-worker management system.

> **גרסה:** 2.0.0 (פיתוח)
> **מצב:** Phase 1 — בבנייה

---

## מה זה ARAD Bridge?

Chrome Extension מודולרי שמחבר את אפליקציית ARAD לשירותים חיצוניים:
- **PIBA** — הנפקה אוטומטית של ויזות מרשות האוכלוסין
- **HopOn** — אינטגרציה עם פלטפורמת ניהול נסיעות
- **WhatsApp Single** — שליחת הודעה יחידה מהדפדפן
- **WhatsApp Bulk** — שליחה המונית עם Daemon חיצוני

**יחודיות:** רק המודולים שהלקוח רכש מותקנים ופועלים. הקונפיגורציה מגיעה אוטומטית ממסד הנתונים של ARAD.

---

## מבנה הריפו

```
arad-bridge/
├── extension/          ← ה-Chrome Extension (MV3)
│   ├── manifest.json
│   ├── background.js   ← message router דינמי
│   ├── popup.{html,js} ← wizard + ניהול מודולים
│   ├── core/           ← תשתית קבועה (תמיד פעילה)
│   │   ├── modules-registry.js  ← קטלוג כל המודולים
│   │   ├── storage.js           ← state management
│   │   ├── page-bridge.js       ← window.__aradBridge
│   │   ├── content-arad.js      ← bridge injector ל-ARAD app
│   │   └── auth-handshake.js    ← סנכרון עם ARAD DB
│   └── modules/        ← תוכן דינמי - רק enabled נטענים
│       ├── piba/
│       ├── hopon/
│       ├── whatsapp-single/
│       └── whatsapp-bulk/
│
├── daemon/             ← Python service ל-WhatsApp Bulk (אופציונלי)
│   ├── arad_bulk_daemon.py
│   └── install/setup.iss   ← Inno Setup לbuild installer.exe
│
├── installer/          ← PowerShell scripts (GitHub fallback)
│   ├── install.ps1
│   ├── update.ps1
│   └── doctor.ps1
│
└── docs/
    ├── ARCHITECTURE.md
    ├── DEVELOPER_GUIDE.md  ← איך מוסיפים מודול חדש
    └── USER_GUIDE_HE.md
```

---

## למפתחים: הוספת מודול חדש

ראה `docs/DEVELOPER_GUIDE.md`. בקצרה:
1. צור תיקייה ב-`modules/<new-module>/`
2. כתוב `module.json` עם metadata
3. כתוב `handler.js` עם הלוגיקה
4. (אופציונלי) `content.js` אם המודול דורש הזרקה לדומיין חיצוני
5. רשום ב-`core/modules-registry.js`
6. הוסף host_permission ב-`manifest.json`

**שום שינוי בליבה.** ה-router יזהה את המודול אוטומטית.

---

## הקשר ל-D.Yohai Bridge

ARAD Bridge הוא extension נפרד מ-D.Yohai Bridge. שניהם יכולים לרוץ במקביל ב-Chrome.

| | D.Yohai Bridge | ARAD Bridge |
|---|---|---|
| API namespace | `window.__base44Bridge` | `window.__aradBridge` |
| Daemon פורט | 8765 | 8766 |
| LOCALAPPDATA dir | `Base44BulkSender` | `AradBulkDaemon` |
| לקוחות יעד | Base44 (ד.יוחאי) | ARAD app (כל לקוח) |

---

## רישיון

Proprietary © Lior Gabay 2026
