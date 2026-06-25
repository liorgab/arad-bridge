# בדיקת התקנת ARAD Bridge מאפס

מסמך זה מציע 3 דרכים לוודא שההתקנה מ-0 עובדת לפני שאתה מפיץ ללקוחות.

---

## אופציה 1 — Windows Sandbox (הכי מומלץ — קל ונקי)

**מה זה:** סביבת Windows חד-פעמית שמתנקה לבד אחרי סגירה. אין שום residue ממה שעשית קודם — בדיוק כמו מחשב חדש.

### דרישות (פעם אחת)
1. Windows 10/11 **Pro** או **Enterprise** (לא Home).
2. וודא ש-Virtualization מופעל ב-BIOS.
3. Settings → Optional features → "Windows Sandbox" → אישר → Restart.

### השימוש
1. דאבל-קליק על `test\TestInSandbox.wsb`.
2. Sandbox יעלה, הריפו ייפתח במיפוי, ו-`install.bat` יקפוץ אוטומטית.
3. עקוב אחר ההתקנה כאילו אתה לקוח חדש. בסוף — בדוק שה-extension נטען וה-daemon רץ על 8766.
4. סגור את ה-Sandbox — הכל נמחק. אם הצלחת → הקוד מוכן לשחרור.

### יתרונות
- **בדיוק** סביבה ריקה (אין Python, אין Chrome, אין משתנים מ-D.Yohai).
- חוזרים על הבדיקה כמה פעמים שרוצים — כל פעם נקי.
- לא מסכן את המחשב שלך.

### מגבלות
- Windows Sandbox לא מאפשר login ל-WhatsApp/Google בקלות (הוא ארעי).
- כלומר נבדוק שהכל **מותקן ועולה**, אבל לא נשלח הודעה אמיתית.

---

## אופציה 2 — Hyper-V VM (אם אתה רוצה גם להריץ end-to-end עם WA)

יתרון: VM נמשך, אפשר לעשות snapshot לפני התקנה ולחזור אליו.

1. הקם VM של Windows 10/11 ב-Hyper-V (Quick Create יוצר אחד מ-ISO).
2. עשה **Checkpoint** ב-Hyper-V לפני שאתה נוגע במשהו (זה ה-baseline).
3. העתק את `arad-bridge-v2.0.1.zip` ל-VM, חלץ, הרץ `install.bat`.
4. עברת? → תיעוד. נכשל? → Revert ל-Checkpoint, תקן את הקוד, נסה שוב.

---

## אופציה 3 — חשבון Windows שני בלפטופ (הכי דומה ללקוח אמיתי)

אם אין לך Pro/Enterprise ואין VM, צור משתמש חדש בלפטופ:

1. Settings → Accounts → Family & other users → "Add account" → קרא לו "TestUser".
2. הכנס למשתמש החדש (sign out → sign in as TestUser).
3. הורד את ה-ZIP מ-GitHub, חלץ, הרץ `install.bat`.
4. אם עובד → התקנה מהקצה לקצה תקינה.
5. כשסיימת — Settings → Accounts → מחק את TestUser כדי לנקות.

הבעיה: ב-LOCALAPPDATA של TestUser אין שום דבר, אבל **ChromeDriver/Python ברמת המכונה** עדיין שם אם הותקנו באופן גלובלי. ההתקנה שלנו user-level, אז זה בסדר, אבל פחות נקי מ-Sandbox.

---

## checklist בדיקה לאחר ההתקנה

לאחר שההתקנה הסתיימה (לא משנה איזו אופציה), בדוק:

```
[ ] Chrome נפתח אוטומטית ל-chrome://extensions/
[ ] טען extension idor מ-arad-bridge\extension\
[ ] ה-extension מופיע ב-toolbar עם אייקון "A"
[ ] קליק על האייקון פותח popup עם 4 כרטיסיות (PIBA / HopOn / WA / Bulk)
[ ] הכרטיסיה "Bulk Sender" מראה ירוק (daemon פעיל)
[ ] curl/Browser: http://127.0.0.1:8766/status מחזיר JSON
[ ] קיצור דרך "ARAD Bulk Daemon" קיים בשולחן עבודה
[ ] קיצור דרך "ARAD Daemon" קיים ב-Startup folder
   (בדיקה: shell:startup)
[ ] reboot → daemon עולה אוטומטית
[ ] פתח arad-admin.vercel.app — הבאנר התכלת "ARAD Bridge לא מותקן"
   לא צריך להופיע (כי כן מותקן)
```

---

## אם משהו נכשל

1. בדוק את `%TEMP%\arad_install.log` בסבסטה/VM/חשבון — שם רשום מה קרה בכל שלב.
2. אם זה service worker — Chrome → chrome://extensions → ARAD Bridge → "Inspect views: service worker".
3. אם זה ה-daemon — `%TEMP%\arad_bulk_daemon.log`.
4. תקן את הקוד בריפו שלך → `installer\release.ps1 -ZipOnly` → בדוק שוב.

---

## תזכורת — תאם את התקנת D.Yohai ו-ARAD שיוכלו לחיות ביחד

- D.Yohai: port 8765, LOCALAPPDATA\DYohaiBridge / DYohaiBulkSender / DYohaiChromeTest
- ARAD:    port 8766, LOCALAPPDATA\AradBridge   / AradBulkDaemon  / AradChromeTest

אין התנגשות. שני התוספים מותקנים במקביל; שני ה-daemons רצים על פורטים שונים; שני profiles נפרדים לחלוטין ל-WhatsApp Web.
