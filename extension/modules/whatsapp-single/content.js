// content-whatsapp.js v4.8 (Full auto: helper performs OS-level click on Document)
// Multi-strategy send without page reload:
//   1. Saved contact search (if contact exists in WhatsApp)
//   2. New Chat → type unsaved number → click "Send to [number]" option
//   3. Fallback via URL (reloads - last resort)

(function () {
  'use strict';

  // Guard against double-load (when extension reloaded and injected on top of old)
  const VERSION = 'v4.8';
  if (window.__base44_wa_version === VERSION) {
    console.log('[ARAD Bridge/WA]', VERSION, 'already loaded, skipping');
    return;
  }
  window.__base44_wa_version = VERSION;

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
  const log = (...args) => console.log('[ARAD Bridge/WA]', ...args);

  // ─── Navigation detector (debug) ────────────────────────────────
  window.addEventListener('beforeunload', () => {
    console.warn('[ARAD Bridge/WA] 🚨 PAGE UNLOADING. URL=', location.href.substring(0, 80));
  });
  window.addEventListener('popstate', () => {
    console.warn('[ARAD Bridge/WA] 🔁 popstate event. URL=', location.href.substring(0, 80));
  });

  // ─── Robust click (for React-rendered elements) ─────────────────
  function robustClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // ─── Key/DOM helpers ────────────────────────────────────────────
  function pressKey(key, target = document.body) {
    const KEY_CODES = { Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38, Tab: 9 };
    const code = key === 'Escape' ? 'Escape' :
                 key === 'Enter' ? 'Enter' :
                 key === 'ArrowDown' ? 'ArrowDown' :
                 key === 'ArrowUp' ? 'ArrowUp' :
                 key.length === 1 ? `Key${key.toUpperCase()}` : undefined;
    const keyCode = KEY_CODES[key] || 0;
    const opts = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function waitFor(selectorFn, timeout = 5000, interval = 150) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = typeof selectorFn === 'function' ? selectorFn() : document.querySelector(selectorFn);
      if (el) return el;
      await wait(interval);
    }
    return null;
  }

  function typeIntoEditor(el, text) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text }));
  }

  // ─── Login detection ────────────────────────────────────────────
  function isLoggedIn() {
    return !!document.querySelector('#pane-side') ||
           !!document.querySelector('[data-testid="chat-list"]') ||
           !!document.querySelector('header[data-testid="chatlist-header"]') ||
           !!document.querySelector('[aria-label="Chat list"]') ||
           !!document.querySelector('[aria-label="רשימת צ\'אטים"]');
  }

  let lastState = null;
  async function syncStatus() {
    const loggedIn = isLoggedIn();
    if (loggedIn !== lastState) {
      lastState = loggedIn;
      try {
        await chrome.storage.local.set({
          whatsapp_logged_in: loggedIn,
          whatsapp_status_updated_at: Date.now()
        });
      } catch (e) { /* extension context invalidated */ }
    }
  }
  syncStatus();
  setInterval(syncStatus, 3000);

  // ─── Selector helpers (multiple fallbacks) ──────────────────────
  function findNewChatButton() {
    return document.querySelector('[aria-label="New chat"]') ||
           document.querySelector('[aria-label="צ\'אט חדש"]') ||
           document.querySelector('[aria-label="שיחה חדשה"]') ||
           document.querySelector('[data-testid="new-chat-btn"]') ||
           document.querySelector('[data-testid="new-chat-plus"]') ||
           document.querySelector('span[data-icon="new-chat-outline"]')?.closest('div[role="button"], button') ||
           document.querySelector('span[data-icon="compose"]')?.closest('div[role="button"], button');
  }

  function findActiveSearchInput() {
    // When "new chat" panel is open, there's a dedicated search input
    const candidates = [
      'div[contenteditable="true"][data-tab="3"]',
      'div[contenteditable="true"][role="textbox"][aria-label*="Search"]',
      'div[contenteditable="true"][role="textbox"][aria-label*="חיפוש"]',
      'div[contenteditable="true"][role="textbox"][aria-label*="Name or number"]',
      'div[contenteditable="true"][role="textbox"][aria-label*="שם או מספר"]',
      'input[type="text"][placeholder*="Search"]',
      'input[type="text"][placeholder*="חיפוש"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el; // visible
    }
    return null;
  }

  function findMessageInput() {
    return document.querySelector('footer div[contenteditable="true"][data-tab="10"]') ||
           document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
           document.querySelector('footer div[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"][aria-label*="Type a message"]') ||
           document.querySelector('div[contenteditable="true"][aria-label*="הקלד הודעה"]') ||
           document.querySelector('div[contenteditable="true"][aria-placeholder*="Type"]');
  }

  function findSendButton() {
    return document.querySelector('button[aria-label="Send"]') ||
           document.querySelector('button[aria-label="שלח"]') ||
           document.querySelector('button[data-tab="11"]') ||
           document.querySelector('span[data-icon="wds-ic-send-filled"]')?.closest('button') ||
           document.querySelector('span[data-icon="send"]')?.closest('button') ||
           document.querySelector('[data-testid="compose-btn-send"]') ||
           document.querySelector('[data-testid="send"]');
  }

  // ─── Media attachment helpers ─────────────────────────────────
  // Selectors based on WhatsApp Blaster XPaths (verified 24/04/2026)
  function findAttachButton() {
    // Primary: current WA Web icon is "plus-rounded" (per WA Blaster Version_A)
    const primary = document.querySelector('span[data-icon="plus-rounded"]');
    if (primary) return primary.closest('button, [role="button"], div[aria-disabled]') || primary;

    // Secondary: older icon names + aria labels + testids
    return document.querySelector('button[aria-label="Attach"]') ||
           document.querySelector('button[aria-label="צירוף"]') ||
           document.querySelector('[data-testid="clip"]') ||
           document.querySelector('[data-testid="attach-menu-plus"]') ||
           document.querySelector('span[data-icon="clip"]')?.closest('button') ||
           document.querySelector('span[data-icon="attach-menu-plus"]')?.closest('button') ||
           document.querySelector('span[data-icon="plus"]')?.closest('button');
  }

  function findFileInput(isImageOrVideo) {
    const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!allInputs.length) return null;

    // Detailed logging to understand what WhatsApp exposes
    log('📎 Found', allInputs.length, 'file inputs:',
        allInputs.map((i, idx) => `[${idx}] accept="${i.accept || '(none)'}"`).join(' | '));

    if (isImageOrVideo) {
      const match = allInputs.find(i => /image|video/i.test(i.accept || ''));
      if (match) { log('📎 Using image/video input:', match.accept); return match; }
      // Fallback to last
      const last = allInputs[allInputs.length - 1];
      log('📎 Fallback to last input for image/video:', last.accept || '(none)');
      return last;
    }

    // Document: try strict matches first, fallback to last input
    // 1. Wildcard accept (most document-like)
    let match = allInputs.find(i => i.accept === '*' || i.accept === '*/*');
    if (match) { log('📎 Using wildcard input:', match.accept); return match; }

    // 2. No accept attribute (accepts everything)
    match = allInputs.find(i => !i.accept || i.accept === '');
    if (match) { log('📎 Using no-accept input'); return match; }

    // 3. Accept mentions doc/pdf/application
    match = allInputs.find(i => /pdf|document|application/i.test(i.accept || ''));
    if (match) { log('📎 Using doc-match input:', match.accept); return match; }

    // 4. Accept does NOT start with only image/video/audio
    match = allInputs.find(i => {
      const a = (i.accept || '').trim();
      // e.g. "image/*,video/*" - strictly media → skip
      // e.g. "*/*" or "application/*,image/*" → ok
      if (!a) return true;
      const parts = a.split(',').map(s => s.trim());
      return !parts.every(p => /^(image|video|audio)/i.test(p));
    });
    if (match) { log('📎 Using non-strict-media input:', match.accept); return match; }

    // 5. LAST resort: use the last input (document input is typically rendered last)
    // Risk: if it's an image-only input, WhatsApp will reject PDF with "not supported"
    // But it's better than giving up - previous versions worked with this fallback
    const last = allInputs[allInputs.length - 1];
    log('📎 WARNING: fallback to LAST input for document - accept:', last.accept || '(none)');
    return last;
  }

  function findCaptionInput() {
    // Scan ALL contenteditables for placeholder/label that hints it's a caption
    const editables = document.querySelectorAll('div[contenteditable="true"]');
    const candidates = [];
    for (const el of editables) {
      if (el.offsetParent === null) continue; // skip hidden
      const ariaLabel = el.getAttribute('aria-label') || '';
      const ariaPlaceholder = el.getAttribute('aria-placeholder') || '';
      const dataPlaceholder = el.getAttribute('data-placeholder-text-rich') ||
                              el.getAttribute('data-lexical-editor-placeholder') || '';
      const all = `${ariaLabel} ${ariaPlaceholder} ${dataPlaceholder}`;
      const rect = el.getBoundingClientRect();
      candidates.push({ el, all, top: rect.top, width: rect.width });
      if (/caption|Type a message|Add a caption|הוסף כיתוב|הקלד הודעה/i.test(all)) {
        return el;
      }
    }
    // Fallback: pick the bottom-most visible editable (caption area is at bottom)
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.top - a.top);
      return candidates[0].el;
    }
    return null;
  }

  // Find the CURRENTLY ACTIVE send button (works in chat, media preview, etc.)
  function findActiveSendButton() {
    // Strategy 1: aria-label match (most stable across WA versions)
    const byAria = document.querySelectorAll(
      'button[aria-label="Send"], button[aria-label="שלח"], ' +
      '[role="button"][aria-label="Send"], [role="button"][aria-label="שלח"], ' +
      'button[aria-label*="Send" i], [role="button"][aria-label*="Send" i]'
    );
    for (const b of byAria) {
      if (b.offsetParent !== null && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return b;
    }
    // Strategy 2: By icon (data-icon)
    const sendIcons = document.querySelectorAll(
      'span[data-icon="send"], span[data-icon="wds-ic-send-filled"], ' +
      'span[data-icon="send-filled"], span[data-icon="send-light"], ' +
      'span[data-icon*="send" i]'
    );
    for (const icon of sendIcons) {
      const btn = icon.closest('button, [role="button"], div[role="button"], div[tabindex="0"]');
      if (btn && btn.offsetParent !== null && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return btn;
    }
    // Strategy 3: legacy data-testid
    const legacy = document.querySelector('[data-testid="send"]:not([disabled])') ||
                   document.querySelector('[data-testid="compose-btn-send"]:not([disabled])');
    if (legacy) return legacy;
    // Strategy 4: large green circular button in bottom-right of preview (new WA UI)
    // It's inside the preview dialog footer, has a distinctive green background
    const allButtons = document.querySelectorAll('button, [role="button"], div[tabindex="0"]');
    for (const b of allButtons) {
      if (b.offsetParent === null || b.disabled) continue;
      const rect = b.getBoundingClientRect();
      // Bottom-right area, roughly 40-80px square
      const inBottomRight = rect.top > window.innerHeight * 0.7 && rect.left > window.innerWidth * 0.6;
      const isCircularBtn = rect.width > 35 && rect.width < 90 && Math.abs(rect.width - rect.height) < 15;
      if (!inBottomRight || !isCircularBtn) continue;
      // Check if green-ish background
      const bg = window.getComputedStyle(b).backgroundColor;
      const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const r = +m[1], g = +m[2], bl = +m[3];
        // WA green: roughly (0-60, 180-220, 100-160)
        if (g > r + 50 && g > bl + 30 && g > 140) return b;
      }
      // Also check child svg/span with send icon
      if (b.querySelector('svg[viewBox*="24"], span[data-icon*="send" i]')) return b;
    }
    return null;
  }

  function base64ToFile(base64, filename, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: mimeType });
  }

  async function attachViaFileInput(file) {
    const attachBtn = findAttachButton();
    if (!attachBtn) return { ok: false, step: 'attach_btn_not_found' };
    log('📎 Clicking attach button');
    robustClick(attachBtn);
    // Longer wait - menu needs to render & file inputs need to be accessible
    await wait(900);

    const isImgVideo = /^(image|video)\//.test(file.type);
    let input = findFileInput(isImgVideo);
    // Retry once if not found
    if (!input) {
      await wait(500);
      input = findFileInput(isImgVideo);
    }
    if (!input) {
      log('❌ File input not found in DOM');
      return { ok: false, step: 'file_input_not_found' };
    }

    log('📎 Injecting file:', file.name, file.type, file.size);
    const dt = new DataTransfer();
    dt.items.add(file);
    try { input.files = dt.files; }
    catch (e) { Object.defineProperty(input, 'files', { value: dt.files, writable: false }); }
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // DO NOT press ESC here - it would dismiss the preview that's about to appear!
    // Instead, wait for the preview dialog to appear as confirmation of success
    log('📎 File injected, waiting for preview dialog...');
    const preview = await waitFor(() => {
      // Media preview markers
      return document.querySelector('[data-testid="media-preview"]') ||
             document.querySelector('[role="dialog"] img[src^="blob:"]') ||
             document.querySelector('[role="dialog"] video') ||
             // Document preview shows filename
             Array.from(document.querySelectorAll('[role="dialog"]'))
               .find(d => d.textContent.includes(file.name) ||
                          /\.(pdf|doc|docx|xls|xlsx)$/i.test(d.textContent));
    }, 5000);

    if (!preview) {
      log('❌ Preview did not appear after injection');
      return { ok: false, step: 'preview_did_not_appear' };
    }

    log('✅ Preview dialog appeared - attachment loaded');
    return { ok: true, via: 'file_input' };
  }

  async function attachViaPaste(file, targetEl) {
    try {
      targetEl.focus();
      await wait(200);
      const dt = new DataTransfer();
      dt.items.add(file);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true
      });
      targetEl.dispatchEvent(pasteEvent);
      await wait(1500);
      return { ok: true, via: 'paste' };
    } catch (e) {
      return { ok: false, step: 'paste_failed', error: e.message };
    }
  }

  // ─── Visual overlay to prompt user action ───────────────────────
  function showClickDocumentOverlay() {
    // Remove existing overlay if any
    hideClickDocumentOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'base44-bridge-overlay';
    overlay.style.cssText = [
      'position: fixed',
      'top: 20px',
      'left: 50%',
      'transform: translateX(-50%)',
      'background: #25d366',
      'color: white',
      'padding: 14px 24px',
      'border-radius: 12px',
      'box-shadow: 0 4px 16px rgba(0,0,0,0.3)',
      'z-index: 2147483647',
      'font-family: Arial, sans-serif',
      'font-size: 15px',
      'font-weight: 600',
      'direction: rtl',
      'pointer-events: none',
      'animation: base44-pulse 1s infinite alternate'
    ].join('; ');
    overlay.innerHTML =
      '👆 לחץ על <span style="color:#fff;text-decoration:underline">Document</span> בתפריט WhatsApp' +
      '<div style="font-size:12px;font-weight:400;margin-top:4px;opacity:0.9">⚠ פעם אחת בלבד — המתן ~2 שניות לסגירת הדיאלוג</div>';

    // Add pulse animation
    if (!document.getElementById('base44-bridge-style')) {
      const style = document.createElement('style');
      style.id = 'base44-bridge-style';
      style.textContent = '@keyframes base44-pulse { from { transform: translateX(-50%) scale(1); } to { transform: translateX(-50%) scale(1.05); } }';
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
  }

  function hideClickDocumentOverlay() {
    const el = document.getElementById('base44-bridge-overlay');
    if (el) el.remove();
  }

  function showProcessingOverlay() {
    hideClickDocumentOverlay();
    const overlay = document.createElement('div');
    overlay.id = 'base44-bridge-overlay';
    overlay.style.cssText = [
      'position: fixed',
      'top: 20px',
      'left: 50%',
      'transform: translateX(-50%)',
      'background: #25d366',
      'color: white',
      'padding: 14px 24px',
      'border-radius: 12px',
      'box-shadow: 0 4px 16px rgba(0,0,0,0.3)',
      'z-index: 2147483647',
      'font-family: Arial, sans-serif',
      'font-size: 15px',
      'font-weight: 600',
      'direction: rtl',
      'pointer-events: none'
    ].join('; ');
    overlay.textContent = '⏳ מצרף קובץ...';
    document.body.appendChild(overlay);
  }

  // Finds the Document menu item (button/row) in WhatsApp's attach menu,
  // used by v4.8 auto-click flow to compute screen coords for OS-level click.
  function findDocumentItemByText() {
    // Strategy A: span whose direct text is exactly "Document" or "מסמך"
    const allSpans = document.querySelectorAll('span');
    for (const span of allSpans) {
      if (span.offsetParent === null) continue;
      const ownText = Array.from(span.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join('');
      const fullText = (span.textContent || '').trim();
      if (ownText === 'Document' || ownText === 'מסמך' ||
          fullText === 'Document' || fullText === 'מסמך') {
        // Return the clickable ancestor (li/button) so getBoundingClientRect returns full row
        const clickable = span.closest('li, [role="button"], [role="menuitem"], button, div[tabindex]');
        return clickable || span;
      }
    }
    // Strategy B: data-icon
    const docIcon = document.querySelector('span[data-icon="document-filled-refreshed"], span[data-icon="document"], span[data-icon="document-filled"]');
    if (docIcon) {
      const btn = docIcon.closest('li, [role="button"], [role="menuitem"], button, div[tabindex]');
      if (btn && btn.offsetParent !== null) return btn;
    }
    return null;
  }

  // ─── Native Messaging approach for documents (like VBA Selenium) ──
  // This is the ONLY reliable way to attach PDFs through WhatsApp Web
  // because WA triggers an OS file dialog that Chrome Extensions can't reach.
  // The native helper (Python + pywin32) handles clipboard + SendKeys at OS level.
  function callBackground(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
  }

  // Concurrency guard: prevent double-invocation (e.g. Base44 re-triggering send)
  // which would cause 2 files to attach before user realizes.
  let __nativeHelperBusy = false;

  async function attachViaNativeHelper(file, filename) {
    if (__nativeHelperBusy) {
      log('⚠ attachViaNativeHelper rejected — another invocation is already running');
      return {
        ok: false,
        step: 'busy',
        error: 'פעולת צירוף קודמת עדיין רצה - המתן לסיומה',
        error_code: 'BUSY'
      };
    }
    __nativeHelperBusy = true;
    try {
      return await _attachViaNativeHelperInner(file, filename);
    } finally {
      __nativeHelperBusy = false;
    }
  }

  async function _attachViaNativeHelperInner(file, filename) {
    log('🔌 Native helper flow: start');

    // Step 1: Convert File → base64 and save via helper to TEMP
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    log('🔌 Asking helper to save', file.size, 'bytes to TEMP');
    const saved = await callBackground({
      type: 'NATIVE_SAVE_FILE',
      file_base64: base64,
      filename: filename
    });

    if (!saved?.success) {
      log('❌ Native save_file failed:', saved?.error);
      return {
        ok: false,
        step: 'native_save_failed',
        error: saved?.error || 'helper unreachable',
        error_code: saved?.error_code || 'NATIVE_SAVE_FAILED'
      };
    }
    log('🔌 File saved at:', saved.file_path);

    // Step 2: Click the attach button (menu opens - this is OK programmatically)
    const attachBtn = findAttachButton();
    if (!attachBtn) return { ok: false, step: 'attach_btn_not_found' };
    log('📎 Clicking attach button (menu will open)');
    robustClick(attachBtn);
    await wait(800);

    // Step 3: NEW APPROACH (v4.3) - instead of clicking Document programmatically
    // (which Chrome blocks due to user activation requirement), we show a visual
    // overlay telling the user to click Document, and the Native Helper polls
    // for the file dialog to appear.
    const useHybridUX = true;

    if (useHybridUX) {
      // v4.8: Try to locate Document menu item and have Native Helper click it
      // at OS level (real mouse click satisfies Chrome's user activation rule).
      // If we can't find it in DOM, fall back to showing overlay for manual click.
      let docItem = null;
      for (let attempt = 0; attempt < 15 && !docItem; attempt++) {
        docItem = findDocumentItemByText();
        if (!docItem) await wait(150);
      }

      let autoClickedDoc = false;
      if (docItem) {
        const rect = docItem.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Convert DOM coords -> SCREEN coords (still in CSS pixels).
          // Helper will scale by devicePixelRatio to get physical pixels.
          const chromeUiHeight = window.outerHeight - window.innerHeight;
          const screenX_css = window.screenX + rect.left + rect.width / 2;
          const screenY_css = window.screenY + chromeUiHeight + rect.top + rect.height / 2;
          const dpr = window.devicePixelRatio || 1;
          log('📎 Document rect (CSS):', JSON.stringify({
            rect_top: Math.round(rect.top), rect_left: Math.round(rect.left),
            width: Math.round(rect.width), height: Math.round(rect.height),
            screenX: window.screenX, screenY: window.screenY,
            chromeUiHeight, dpr, sendX: Math.round(screenX_css), sendY: Math.round(screenY_css)
          }));
          const clickResult = await callBackground({
            type: 'NATIVE_CLICK_AT_SCREEN',
            x: screenX_css,
            y: screenY_css,
            device_pixel_ratio: dpr,
            restore_cursor: true
          });
          if (clickResult?.success) {
            log('✅ Helper clicked Document (physical coords):', JSON.stringify(clickResult.clicked_physical));
            autoClickedDoc = true;
          } else {
            log('⚠ OS-level click failed:', clickResult?.error, '- falling back to manual overlay');
          }
        } else {
          log('⚠ Document item has zero size - falling back to manual overlay');
        }
      } else {
        log('⚠ Document item not found in DOM - falling back to manual overlay');
      }

      // SAFETY: if auto-click didn't open a dialog within 3s, promote overlay to manual.
      // We cannot detect dialog opening from JS (OS dialog is outside the tab),
      // so we rely on helper's wait_and_paste timeout. But if auto-click succeeded
      // and dialog DOES open, helper's first poll detects it quickly (~200ms).
      // If after 3s no dialog, we know auto-click missed and user needs to click manually.

      // If auto-click failed, show the overlay so user can click manually
      if (!autoClickedDoc) {
        log('📎 Showing overlay to user: please click Document');
        showClickDocumentOverlay();
      } else {
        showProcessingOverlay();
      }

      log('🔌 Native helper: waiting for file dialog to open + pasting path...');
      // Auto mode: short 5s timeout. If auto-click missed, we fallback to manual below.
      // Manual mode: 20s timeout for user to click Document.
      let waitResult = await callBackground({
        type: 'NATIVE_WAIT_AND_PASTE',
        file_path: saved.file_path,
        timeout_s: autoClickedDoc ? 5 : 20
      });

      // If auto-click's quick timeout expired without finding dialog, retry in manual mode
      if (autoClickedDoc && !waitResult?.success) {
        log('⚠ Auto-click did not open file dialog - switching to manual mode, re-opening menu');
        hideClickDocumentOverlay();
        // Re-open attach menu (previous click may have closed it)
        const attachBtn2 = findAttachButton();
        if (attachBtn2) {
          robustClick(attachBtn2);
          await wait(700);
        }
        showClickDocumentOverlay();
        waitResult = await callBackground({
          type: 'NATIVE_WAIT_AND_PASTE',
          file_path: saved.file_path,
          timeout_s: 20
        });
      }

      hideClickDocumentOverlay();

      if (!waitResult?.success) {
        log('❌ Native wait_and_paste failed:', waitResult?.error);
        pressKey('Escape');
        return {
          ok: false,
          step: 'native_wait_failed',
          error: waitResult?.error || 'timeout waiting for dialog',
          error_code: 'NATIVE_WAIT_FAILED'
        };
      }
      log('✅ Helper detected dialog + pasted:', waitResult.dialog_title, 'after', waitResult.waited_s, 's');

      log('🔌 Waiting for WhatsApp preview dialog after file selection...');
      const preview = await waitFor(() => {
        // Strategy 1: legacy data-testid
        if (document.querySelector('[data-testid="media-preview"]')) return true;
        // Strategy 2: role=dialog with file cues
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          if (d.textContent.includes(filename) ||
              d.querySelector('img[src^="blob:"]') ||
              d.querySelector('video') ||
              /\.pdf|\.doc|\.xls/i.test(d.textContent)) return true;
        }
        // Strategy 3: filename visible anywhere on page
        if (document.body && document.body.textContent && document.body.textContent.includes(filename)) return true;
        // Strategy 4: any blob image/pdf thumbnail (new WA UI)
        if (document.querySelector('img[src^="blob:"]')) return true;
        // Strategy 5: aria-label for preview
        if (document.querySelector('div[aria-label*="preview" i], div[aria-label*="תצוגה"]')) return true;
        return null;
      }, 8000);

      // CRITICAL: helper already confirmed file was pasted to dialog + BM_CLICK worked.
      // File IS attached - do NOT fall back to file input (causes double-attachment bug).
      // If preview detection fails, return success with warning so caption+send flow still runs.
      if (!preview) {
        log('⚠ Preview not detected, but helper confirmed file was attached. Proceeding to caption/send.');
        return { ok: true, via: 'native_helper_hybrid_no_preview', file_path: saved.file_path, warning: 'preview_not_detected' };
      }

      log('✅ Native helper flow succeeded - file attached');
      return { ok: true, via: 'native_helper_hybrid', file_path: saved.file_path };
    }

    // (Old code - programmatic Document click - kept as fallback if useHybridUX is false)
    // Step 3: Wait for menu to render + find "Document" menu item.
    // WA Blaster uses this exact XPath: //span[contains(text(), 'Document')]
    // So: look for a SPAN containing the word "Document" (or "מסמך")
    const findDocumentItem = () => {
      // Strategy A (PRIMARY, matches WA Blaster): span with Document text
      const allSpans = document.querySelectorAll('span');
      for (const span of allSpans) {
        if (span.offsetParent === null) continue;
        // Skip spans that are just containers with children - we want the leaf text span
        const ownText = Array.from(span.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .join('');
        const fullText = (span.textContent || '').trim();
        // Match: span with "Document" as its direct text OR entire text is "Document"
        if (ownText === 'Document' || ownText === 'מסמך' ||
            fullText === 'Document' || fullText === 'מסמך') {
          return { el: span, via: 'span-text' };
        }
      }

      // Strategy B: by data-icon (fallback if WA changes XPath pattern)
      const docIcon = document.querySelector('span[data-icon="document-filled-refreshed"], span[data-icon="document"], span[data-icon="document-filled"]');
      if (docIcon) {
        const btn = docIcon.closest('li, [role="button"], [role="menuitem"], button, div[tabindex]');
        if (btn && btn.offsetParent !== null) return { el: btn, via: 'data-icon' };
      }

      // Strategy C: menu role + permissive text match
      const candidates = document.querySelectorAll('[role="menuitem"], [role="button"], li, div[tabindex="0"]');
      for (const el of candidates) {
        if (el.offsetParent === null) continue;
        const txt = (el.textContent || '').trim();
        if (/^\s*(Document|מסמך)\s*$/i.test(txt)) return { el, via: 'menuitem-exact' };
      }
      for (const el of candidates) {
        if (el.offsetParent === null) continue;
        const txt = (el.textContent || '').trim();
        if (/\bDocument\b/i.test(txt) && txt.length < 30) return { el, via: 'menuitem-contains' };
        if (/^מסמך/.test(txt) && txt.length < 30) return { el, via: 'menuitem-contains-he' };
      }
      return null;
    };

    log('📎 Waiting for attach menu to render + finding Document item...');
    let docItem = null;
    for (let attempt = 0; attempt < 15 && !docItem; attempt++) {
      docItem = findDocumentItem();
      if (!docItem) await wait(200);
    }

    if (!docItem) {
      log('❌ Document menu item not found after 3s');
      const items = Array.from(document.querySelectorAll('[role="menuitem"], li'))
        .filter(el => el.offsetParent !== null)
        .map(el => (el.textContent || '').trim().substring(0, 30));
      log('❌ Visible menu items:', items);
      return { ok: false, step: 'doc_menu_item_not_found', visible_items: items };
    }

    log('📎 Found Document item via', docItem.via, '- clicking (will open OS file dialog)');
    robustClick(docItem.el);

    log('🔌 Calling native helper to paste path into file dialog');
    const pasted = await callBackground({
      type: 'NATIVE_PASTE_PATH',
      file_path: saved.file_path,
      pre_delay_ms: 700
    });

    if (!pasted?.success) {
      log('❌ Native paste_path failed:', pasted?.error);
      pressKey('Escape');
      return {
        ok: false,
        step: 'native_paste_failed',
        error: pasted?.error || 'paste failed',
        error_code: 'NATIVE_PASTE_FAILED'
      };
    }

    log('🔌 Waiting for WhatsApp preview dialog after file selection...');
    const preview = await waitFor(() => {
      if (document.querySelector('[data-testid="media-preview"]')) return true;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const d of dialogs) {
        if (d.textContent.includes(filename) ||
            d.querySelector('img[src^="blob:"]') ||
            d.querySelector('video') ||
            /\.pdf|\.doc|\.xls/i.test(d.textContent)) return true;
      }
      return null;
    }, 8000);

    if (!preview) {
      log('❌ Preview did not appear after native paste');
      return { ok: false, step: 'preview_did_not_appear_native' };
    }

    log('✅ Native helper succeeded - file attached');
    return { ok: true, via: 'native_helper', file_path: saved.file_path };
  }

  async function attachViaDragDrop(file) {
    const dropTarget = document.querySelector('#main') ||
                       document.querySelector('[id^="main"]') ||
                       document.querySelector('[data-testid="conversation-panel-wrapper"]') ||
                       document.querySelector('[role="application"]') ||
                       document.body;

    log('🗂️ Drag-drop target:', dropTarget.tagName, dropTarget.id || '(no id)');

    let dt;
    try {
      dt = new DataTransfer();
      dt.items.add(file);
    } catch (e) {
      return { ok: false, step: 'datatransfer_failed', error: e.message };
    }

    const rect = dropTarget.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const fireDragEvent = (type) => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX, clientY
      });
      try {
        Object.defineProperty(event, 'dataTransfer', { value: dt, writable: false });
      } catch (_) {}
      dropTarget.dispatchEvent(event);
    };

    log('🗂️ Dispatching drag sequence: dragenter → dragover → drop');
    fireDragEvent('dragenter');
    await wait(100);
    fireDragEvent('dragover');
    await wait(100);
    fireDragEvent('drop');

    log('🗂️ Waiting for preview dialog after drop...');
    const preview = await waitFor(() => {
      if (document.querySelector('[data-testid="media-preview"]')) return true;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      for (const d of dialogs) {
        if (d.textContent.includes(file.name) ||
            d.querySelector('img[src^="blob:"]') ||
            d.querySelector('video') ||
            /\.pdf|\.doc|\.xls/i.test(d.textContent)) return true;
      }
      return null;
    }, 6000);

    if (!preview) {
      log('❌ Drag-drop: no preview appeared');
      return { ok: false, step: 'drag_drop_no_preview' };
    }
    log('✅ Drag-drop succeeded');
    return { ok: true, via: 'drag_drop' };
  }

  function findFirstChatInList() {
    const pane = document.querySelector('#pane-side') ||
                 document.querySelector('[data-testid="chat-list"]') ||
                 document.querySelector('[aria-label="Chat list"]') ||
                 document.querySelector('[aria-label="רשימת צ\'אטים"]');
    if (!pane) return null;

    const items = pane.querySelectorAll('[role="listitem"]');
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 30) {
        return item.querySelector('div[role="button"]') ||
               item.querySelector('div[tabindex="0"]') ||
               item;
      }
    }
    return null;
  }

  function findSendToNumberOption() {
    const byText = Array.from(document.querySelectorAll('div[role="button"], [role="listitem"]'))
      .find(el => {
        const txt = el.textContent || '';
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 30 &&
               /שלח הודעה|Send message|Message \+|start chat/i.test(txt);
      });
    if (byText) return byText;
    return document.querySelector('[role="listbox"] [role="listitem"]') ||
           document.querySelector('[aria-label="Search results"] [role="button"]');
  }

  async function trySavedContactSearch({ phone }) {
    log('Strategy 1: keyboard search, phone=', phone);
    pressKey('Escape');
    pressKey('Escape');
    await wait(400);

    const searchInput = await waitFor(findActiveSearchInput, 2000);
    if (!searchInput) return { ok: false, step: 'search_not_found' };

    log('🔍 Clicking search input');
    robustClick(searchInput);
    searchInput.focus();
    await wait(200);
    log('⌨️ Typing phone:', phone);
    typeIntoEditor(searchInput, phone);
    log('⏳ Waiting 2000ms for WA to filter list...');
    await wait(2000);

    log('⌨️ Pressing Enter on search input');
    pressKey('Enter', searchInput);
    await wait(1500);

    let msgInput = findMessageInput();
    if (msgInput) {
      log('✅ Enter opened the chat directly');
      return { ok: true, via: 'saved_contact_enter' };
    }

    log('⌨️ Enter did not work, trying ArrowDown+Enter');
    pressKey('ArrowDown', searchInput);
    await wait(300);
    pressKey('Enter', searchInput);
    await wait(1500);

    msgInput = findMessageInput();
    if (msgInput) {
      log('✅ ArrowDown+Enter opened the chat');
      return { ok: true, via: 'saved_contact_arrow_enter' };
    }

    log('⌨️ Keyboard nav failed, trying DOM fallback');
    const row = findFirstChatInList();
    if (row) {
      const rowText = (row.textContent || '').substring(0, 60);
      log('👆 Found row via DOM, clicking:', rowText);
      robustClick(row);
      await wait(1500);
      msgInput = findMessageInput();
      if (msgInput) {
        log('✅ DOM click opened the chat');
        return { ok: true, via: 'saved_contact_dom' };
      }
    }

    log('❌ All approaches failed for saved contact');
    return { ok: false, step: 'no_chat_after_search' };
  }

  async function tryNewChatFlow({ phone }) {
    log('Strategy 2: new chat flow, phone=', phone);
    pressKey('Escape');
    pressKey('Escape');
    await wait(400);

    const newChatBtn = findNewChatButton();
    if (!newChatBtn) return { ok: false, step: 'new_chat_btn_not_found' };

    log('👆 Clicking New Chat button');
    robustClick(newChatBtn);
    await wait(800);

    const searchInput = await waitFor(findActiveSearchInput, 3000);
    if (!searchInput) return { ok: false, step: 'new_chat_search_not_found' };

    log('⌨️ Typing phone in new-chat search:', '+' + phone);
    robustClick(searchInput);
    searchInput.focus();
    await wait(200);
    typeIntoEditor(searchInput, '+' + phone);
    await wait(2000);

    log('⌨️ Pressing Enter in new-chat search');
    pressKey('Enter', searchInput);
    await wait(1500);

    let msgInput = findMessageInput();
    if (msgInput) {
      log('✅ Enter opened chat from new-chat');
      return { ok: true, via: 'new_chat_enter' };
    }

    log('⌨️ Trying ArrowDown+Enter in new-chat');
    pressKey('ArrowDown', searchInput);
    await wait(300);
    pressKey('Enter', searchInput);
    await wait(1500);

    msgInput = findMessageInput();
    if (msgInput) {
      log('✅ ArrowDown+Enter opened chat from new-chat');
      return { ok: true, via: 'new_chat_arrow_enter' };
    }

    log('⌨️ Keyboard nav failed in new-chat, trying DOM fallback');
    const result = findSendToNumberOption() || findFirstChatInList();
    if (result) {
      const rText = (result.textContent || '').substring(0, 60);
      log('👆 Clicking new-chat result via DOM:', rText);
      robustClick(result);
      await wait(1500);
      msgInput = findMessageInput();
      if (msgInput) {
        log('✅ DOM click opened chat from new-chat');
        return { ok: true, via: 'new_chat_dom' };
      }
    }

    log('❌ All approaches failed for new chat');
    return { ok: false, step: 'no_result_after_type' };
  }

  async function sendInPlace({ phone, message, autoSend, attachment }) {
    const stepLog = [];
    const addStep = (name, data) => { stepLog.push({ name, t: Date.now(), ...data }); log(name, data); };

    try {
      const digits = String(phone).replace(/\D/g, '');
      if (!digits) return { success: false, error_code: 'BAD_PHONE', error: 'מספר לא תקין', log: stepLog };
      const phoneLast9 = digits.slice(-9);
      addStep('start', { digits, phoneLast9 });

      if (!isLoggedIn()) {
        return { success: false, error_code: 'NOT_LOGGED_IN', error: 'WhatsApp לא מחובר - סרוק QR', log: stepLog };
      }

      const s1 = await trySavedContactSearch({ phone: digits });
      addStep('strategy_1', s1);

      let opened = s1.ok;
      let via = s1.via;

      if (!opened) {
        pressKey('Escape'); pressKey('Escape');
        await wait(300);
        const s2 = await tryNewChatFlow({ phone: digits });
        addStep('strategy_2', s2);
        opened = s2.ok;
        via = s2.via;
      }

      if (!opened) {
        pressKey('Escape');
        return {
          success: false,
          error_code: 'IN_PLACE_FAILED',
          error: 'לא הצליח לפתוח צ\'אט ללא טעינה מחדש - נופל ל-URL',
          log: stepLog
        };
      }

      const msgInput = await waitFor(findMessageInput, 3000);
      if (!msgInput) {
        addStep('msg_input_not_found');
        return { success: false, error_code: 'MSG_INPUT_NOT_FOUND', error: 'תיבת ההודעה לא נמצאה', log: stepLog };
      }

      if (attachment) {
        addStep('attaching_media', { filename: attachment.filename, type: attachment.mimeType });
        const file = base64ToFile(attachment.base64, attachment.filename, attachment.mimeType);
        const isImgVideo = /^(image|video)\//.test(file.type);

        let attachResult;
        if (isImgVideo) {
          attachResult = await attachViaFileInput(file);
          addStep('attach_file_input', attachResult);
        } else {
          attachResult = await attachViaNativeHelper(file, attachment.filename);
          addStep('attach_native', attachResult);
          // Only fall back to alternative methods if the native helper failed before
          // reaching the file dialog. If helper succeeded (even if preview detection
          // failed), the file is already attached - falling back would DOUBLE-ATTACH.
          const nativeDidReachDialog = attachResult.ok ||
                                       attachResult.step === 'preview_did_not_appear_native';
          if (!nativeDidReachDialog && attachResult.error_code === 'NATIVE_DISCONNECTED') {
            log('🔌 Native helper unavailable, trying drag-drop fallback');
            attachResult = await attachViaDragDrop(file);
            addStep('attach_drag_drop_fallback', attachResult);
          }
          if (!nativeDidReachDialog && !attachResult.ok) {
            log('📎 Trying file input as last resort for doc (helper did not run)');
            const fileInputResult = await attachViaFileInput(file);
            if (fileInputResult.ok) attachResult = fileInputResult;
            addStep('attach_file_input_last', fileInputResult);
          }
        }

        if (!attachResult.ok) {
          return {
            success: false,
            error_code: 'ATTACH_FAILED',
            error: 'לא הצליח לצרף את הקובץ: ' + (attachResult.step || 'unknown'),
            log: stepLog
          };
        }

        await wait(2000);

        if (message && message.trim()) {
          const captionInput = await waitFor(findCaptionInput, 4000);
          if (captionInput) {
            addStep('typing_caption', { length: message.length });
            captionInput.focus();
            await wait(300);
            typeIntoEditor(captionInput, message);
            await wait(600);
          } else {
            addStep('caption_input_not_found');
          }
        }

        if (autoSend) {
          const delay = rand(3000, 6000);
          addStep('pre_send_delay_media', { delay });
          await wait(delay);

          let sendBtn = null;
          for (let attempt = 0; attempt < 15 && !sendBtn; attempt++) {
            sendBtn = findActiveSendButton();
            if (!sendBtn) await wait(200);
          }
          addStep('send_btn_search', { found: !!sendBtn });

          if (sendBtn) {
            log('👆 Clicking send button for media');
            robustClick(sendBtn);
            await wait(2500);
            return { success: true, sent: true, attached: true, via, log: stepLog };
          }

          addStep('send_btn_not_found_media');
          return {
            success: true,
            sent: false,
            attached: true,
            via,
            warning: 'הקובץ צורף אבל כפתור השליחה לא נמצא. לחץ ידנית על הכפתור הירוק.',
            log: stepLog
          };
        }

        addStep('done_manual_media');
        return { success: true, sent: false, attached: true, via, log: stepLog };
      }

      addStep('typing_message', { length: message.length });
      typeIntoEditor(msgInput, message);
      await wait(500);

      if (autoSend) {
        const delay = rand(2000, 5000);
        addStep('pre_send_delay', { delay });
        await wait(delay);
        const sendBtn = findSendButton();
        if (!sendBtn) {
          addStep('send_btn_not_found');
          return { success: false, error_code: 'SEND_BUTTON_NOT_FOUND', error: 'כפתור השליחה לא נמצא', log: stepLog };
        }
        addStep('clicking_send');
        sendBtn.click();
        await wait(800);
        return { success: true, sent: true, via, log: stepLog };
      }

      addStep('done_manual');
      return { success: true, sent: false, via, log: stepLog };

    } catch (e) {
      addStep('exception', { message: e.message });
      return { success: false, error_code: 'EXCEPTION', error: e.message, log: stepLog };
    }
  }

  async function prepareUrlSend(autoSend) {
    const inputBox = await waitFor(findMessageInput, 15000);
    if (!inputBox) {
      const errorDialog = document.querySelector('[data-testid="popup-contents"]') ||
                          document.querySelector('div[role="dialog"]');
      if (errorDialog && /invalid|לא חוקי|not exist/i.test(errorDialog.textContent)) {
        return { success: false, error_code: 'INVALID_NUMBER', error: 'המספר לא רשום ב-WhatsApp' };
      }
      return { success: false, error_code: 'TIMEOUT', error: 'WhatsApp לא נטען תוך 15 שניות' };
    }
    if (autoSend) {
      const delay = rand(2000, 5000);
      await wait(delay);
      const sendBtn = findSendButton();
      if (!sendBtn) return { success: false, error_code: 'SEND_BUTTON_NOT_FOUND', error: 'כפתור השליחה לא נמצא' };
      sendBtn.click();
      await wait(800);
      return { success: true, sent: true };
    }
    return { success: true, sent: false };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'WHATSAPP_PING') {
      sendResponse({ pong: true, version: VERSION, loggedIn: isLoggedIn() });
      return false;
    }
    if (msg?.type === 'WHATSAPP_SEND_IN_PLACE') {
      sendInPlace(msg).then(sendResponse);
      return true;
    }
    if (msg?.type === 'WHATSAPP_PREPARE_URL_SEND') {
      prepareUrlSend(msg.autoSend).then(sendResponse);
      return true;
    }
    if (msg?.type === 'WHATSAPP_IS_LOGGED_IN') {
      sendResponse({ loggedIn: isLoggedIn() });
      return false;
    }
    if (msg?.type === 'WHATSAPP_WAIT_READY') {
      waitFor(findMessageInput, msg.timeoutMs || 15000).then(el => {
        sendResponse({ ready: !!el });
      });
      return true;
    }
    if (msg?.type === 'WHATSAPP_CLICK_SEND') {
      (async () => {
        await wait(rand(2000, 5000));
        const btn = findSendButton();
        if (!btn) { sendResponse({ sent: false, error: 'SEND_BUTTON_NOT_FOUND' }); return; }
        btn.click();
        await wait(500);
        sendResponse({ sent: true });
      })();
      return true;
    }
    return false;
  });

  log(VERSION, 'content script loaded');
})();
