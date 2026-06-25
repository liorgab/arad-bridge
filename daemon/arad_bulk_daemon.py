#!/usr/bin/env python3
"""
ARAD Bulk WhatsApp Sender Daemon
====================================
HTTP server on localhost:8766 that uses Selenium + Chrome for Testing to send
WhatsApp messages in bulk, WITHOUT any user activation dialogs (unlike regular
Chrome). This is the same technique WhatsApp Blaster VBA uses.

Architecture:
  ARAD app (in regular Chrome) → Extension → POST localhost:8766/bulk_send
  → this daemon → Selenium → Chrome for Testing → WhatsApp Web

Key features:
  - Persistent Chrome Test session (QR scan once, stays logged in)
  - No file dialog interaction (Selenium's send_keys on <input type="file">)
  - Random delays 20-40s between messages (anti-ban)
  - Progress streaming via Server-Sent Events (SSE)
  - Graceful failure: one bad contact doesn't stop the batch

Endpoints:
  POST /bulk_send      start a bulk job, returns {job_id}
  GET  /progress/<id>  SSE stream of {index, phone, status, ...}
  GET  /status         daemon status + is WA logged in
  POST /shutdown       graceful shutdown (closes Chrome Test)

Requires: python 3.8+, selenium, flask, flask-cors, requests
"""

import os
import sys
import time
import json
import queue
import base64
import random
import threading
import tempfile
import traceback
import re
from urllib.parse import quote

try:
    from flask import Flask, request, jsonify, Response, stream_with_context
    from flask_cors import CORS
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException
    import requests
except ImportError as e:
    print(f"FATAL: missing Python package: {e}", file=sys.stderr)
    print("Run: pip install selenium flask flask-cors requests", file=sys.stderr)
    sys.exit(1)

# pyperclip is optional - if unavailable we fall back to character-by-character typing.
# It enables paste-from-clipboard which is ~10x faster than typing for long messages
# (matches the WA Blaster approach: instant message appearance, not typing animation).
try:
    import pyperclip
    HAS_PYPERCLIP = True
except ImportError:
    HAS_PYPERCLIP = False


# ─── Configuration ────────────────────────────────────────────────
DEFAULT_CHROME_PATH = r"C:\Users\liorg\AppData\Local\SeleniumBasic\chrome-win64\chrome.exe"
DEFAULT_PROFILE_DIR = os.path.join(
    os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
    'AradBulkDaemon', 'profile'
)
DEFAULT_CHROMEDRIVER = os.path.join(
    os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
    'AradBulkDaemon', 'chromedriver.exe'
)
LOG_FILE = os.path.join(tempfile.gettempdir(), 'arad_bulk_daemon.log')
CONFIG_FILE = os.path.join(
    os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
    'AradBulkDaemon', 'config.json'
)

DEFAULT_DELAY_MIN_S = 20            # min seconds between messages (random)
DEFAULT_DELAY_MAX_S = 40            # max seconds between messages (random)
DEFAULT_ATTACHMENT_UPLOAD_DELAY_S = 4   # wait after click_send for attachment upload
DEFAULT_ACTION_DELAY_S = 1.0        # wait after typing/before send (general)
DAILY_CAP = 150                     # anti-ban cap per 24h
PER_MINUTE_CAP = 3


# ─── Logging ────────────────────────────────────────────────────────
def log(msg, *args):
    line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {msg}'
    if args:
        line += ' ' + ' '.join(str(a) for a in args)
    print(line, flush=True)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


# ─── Config ─────────────────────────────────────────────────────────
def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            log(f'config load failed: {e}')
    return {}


def save_config(cfg):
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        log(f'config save failed: {e}')


CONFIG = load_config()
CHROME_PATH = CONFIG.get('chrome_path', DEFAULT_CHROME_PATH)
PROFILE_DIR = CONFIG.get('profile_dir', DEFAULT_PROFILE_DIR)
CHROMEDRIVER_PATH = CONFIG.get('chromedriver_path', DEFAULT_CHROMEDRIVER)


# ─── XPath / CSS Selectors (WA Blaster style) ───────────────────────
# WhatsApp Web changes its DOM frequently. Instead of hardcoding selectors
# in code, we keep them in config.json so the user can update them when
# WA Web changes - WITHOUT modifying any code.
#
# Each selector has a primary version + alt fallback. We try primary first;
# if not found, fall back to alt. This is exactly how WA Blaster handles
# DOM versioning (Version_A / Version_B).
#
# To update a selector when WA breaks: edit config.json and restart the daemon.
# To get fresh selectors: open WA Web, F12, find the element, copy XPath.

DEFAULT_SELECTORS = {
    # When the chat-loading modal popup is showing
    'CSSClassModalPopup':              '[data-animate-modal-popup]',
    'CSSClassModalPopup_Alt':          '[data-animate-modal-popup]',

    # The "OK" button on the invalid-phone-number popup
    'XPathInvalidPhoneNumber':         "//*[@id='app']/div/span[2]/div/span/div/div/div/div/div/div[2]/div/button",
    'XPathInvalidPhoneNumber_Alt':     "//*[@id='app']/div/span[2]/div/span/div/div/div/div/div/div[2]/div/button",

    # The message text input (in chat footer) - this <p> being present means chat is loaded
    'XPathTextInputField':             "//*[@id='main']/footer/div[1]/div/span/div/div/div/div[3]/div[1]/p",
    'XPathTextInputField_Alt':         "//*[@id='main']/footer/div[1]/div/span/div/div/div/div[3]/div[1]/p",

    # The search input at top of chat list (NOTE: it's an <input>, not contenteditable)
    'XPathSearchInputField':           "//input[@aria-label='Search or start a new chat']",
    'XPathSearchInputField_Alt':       "//input[@data-tab='3']",

    # "No contact found" message in search results
    'XPathNoContactFound':             "//*[@id='pane-side']/div[1]/div/span",
    'XPathNoContactFound_Alt':         "//*[@id='pane-side']/div[1]/div/span",

    # The "+" attachment button (modern WA)
    'XPathAttachmentButton':           "//span[@data-icon='plus-rounded']",
    'XPathAttachmentButton_Alt':       "//span[@data-icon='plus-rounded']",

    # The "+" multiple-attachment button (newer style)
    'XPathMultipleAttachmentButton':   "//span[@data-icon='plus']",
    'XPathMultipleAttachmentButton_Alt': "//span[@data-icon='plus']",

    # "Document" entry in attachment menu
    'XPathDocumentAttachmentButton':   "//span[contains(text(), 'Document')]",
    'XPathDocumentAttachmentButton_Alt': "//span[contains(text(), 'Document')]",

    # "Photos & videos" entry in attachment menu
    'XPathMediaAttachmentButton':      "//span[contains(text(), 'Photos & videos')]",
    'XPathMediaAttachmentButton_Alt':  "//span[contains(text(), 'Photos & videos')]",

    # First search result row (when typing in search)
    'XPathFirstSearchResult':          "//div[@aria-label='Search results.']//div[@role='gridcell'][@tabindex='0']",
    'XPathFirstSearchResult_Alt':      "//div[@id='pane-side']//div[@role='gridcell'][@tabindex='0']",
}

# Merge defaults with user overrides from config.json
SELECTORS = dict(DEFAULT_SELECTORS)
SELECTORS.update(CONFIG.get('selectors', {}))


def get_selector(name):
    """Get a selector by name. Returns the configured value or default."""
    return SELECTORS.get(name, DEFAULT_SELECTORS.get(name, ''))


def get_selector_pair(base_name):
    """Returns (primary, alt) selector strings for a given base name."""
    return get_selector(base_name), get_selector(f'{base_name}_Alt')


# ─── Selenium driver (singleton, persistent) ───────────────────────
_driver = None
_driver_lock = threading.Lock()
_last_activity = 0
_job_lock = threading.Lock()  # only one bulk job at a time


def _kill_orphan_chrome_test():
    """
    Kill any chrome.exe processes that are using our profile dir.
    Happens when the daemon was restarted but Chrome Test wasn't closed -
    Windows locks the user-data-dir and new webdriver.Chrome() fails.
    Uses wmic for compatibility with all Windows versions.
    """
    if os.name != 'nt':
        return
    import subprocess
    try:
        # wmic outputs in UTF-16 by default - use CSV format for robustness
        result = subprocess.run(
            ['wmic', 'process', 'where', "name='chrome.exe'",
             'get', 'ProcessId,CommandLine', '/format:csv'],
            capture_output=True, text=True, timeout=10
        )
        killed = []
        for line in result.stdout.splitlines():
            if PROFILE_DIR in line:
                # CSV format: Node,CommandLine,ProcessId
                parts = line.strip().split(',')
                if len(parts) >= 3:
                    pid = parts[-1].strip()
                    if pid.isdigit():
                        try:
                            subprocess.run(['taskkill', '/F', '/PID', pid],
                                           capture_output=True, timeout=5)
                            killed.append(pid)
                        except Exception as e:
                            log(f'failed to kill pid {pid}: {e}')
        if killed:
            log(f'killed {len(killed)} orphan chrome.exe PID(s): {killed}')
            time.sleep(1.0)  # let Windows release the profile lock
    except subprocess.TimeoutExpired:
        log('wmic query timed out')
    except FileNotFoundError:
        # wmic not available on newer Windows - try PowerShell
        try:
            ps_cmd = (
                "Get-WmiObject Win32_Process -Filter \"name='chrome.exe'\" | "
                "Where-Object { $_.CommandLine -like '*" + PROFILE_DIR.replace('\\', '\\\\') + "*' } | "
                "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
            )
            subprocess.run(['powershell', '-Command', ps_cmd],
                           capture_output=True, timeout=15)
            time.sleep(1.0)
            log('killed orphan chrome.exe via PowerShell')
        except Exception as e:
            log(f'PowerShell fallback failed: {e}')
    except Exception as e:
        log(f'kill orphan failed (non-fatal): {e}')


def get_driver():
    """Get or create the Selenium driver. Creates if needed, reuses if alive."""
    global _driver, _last_activity

    with _driver_lock:
        # Check if existing driver is still alive
        if _driver is not None:
            try:
                _ = _driver.current_url  # ping
                _last_activity = time.time()
                return _driver
            except Exception as e:
                log(f'existing driver is dead: {e}, recreating')
                try:
                    _driver.quit()
                except Exception:
                    pass
                _driver = None

        # Create new driver
        log(f'launching Chrome Test: {CHROME_PATH}')
        log(f'profile dir: {PROFILE_DIR}')
        os.makedirs(PROFILE_DIR, exist_ok=True)

        options = Options()
        options.binary_location = CHROME_PATH
        options.add_argument(f'--user-data-dir={PROFILE_DIR}')
        options.add_argument('--start-maximized')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-blink-features=AutomationControlled')
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option('useAutomationExtension', False)

        # Kill any orphan Chrome Test that may be locking our profile
        # (happens when daemon was restarted without closing Chrome Test)
        _kill_orphan_chrome_test()

        service = Service(CHROMEDRIVER_PATH)
        try:
            _driver = webdriver.Chrome(service=service, options=options)
            # Hide webdriver flag
            _driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', {
                'source': "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            })
        except Exception as e:
            log(f'driver creation FAILED: {e}')
            _driver = None
            raise

        _last_activity = time.time()
        _driver.get('https://web.whatsapp.com')
        log('navigated to web.whatsapp.com')
        return _driver


def shutdown_driver():
    global _driver
    with _driver_lock:
        if _driver is not None:
            try:
                _driver.quit()
                log('driver closed')
            except Exception as e:
                log(f'driver close error: {e}')
            _driver = None


# ─── WhatsApp helpers ───────────────────────────────────────────────
def is_logged_in(driver, timeout_s=5):
    """Check if logged into WhatsApp Web (no QR screen)."""
    end = time.time() + timeout_s
    while time.time() < end:
        try:
            # Logged-in markers
            if driver.find_elements(By.CSS_SELECTOR, '#pane-side, [data-testid="chat-list"]'):
                return True
            # QR / landing screen markers
            if driver.find_elements(By.CSS_SELECTOR, 'canvas[aria-label*="Scan"], [data-testid="qrcode"]'):
                return False
        except Exception:
            pass
        time.sleep(0.5)
    return False


def wait_for_login(driver, timeout_s=120):
    """Wait for user to scan QR. Returns True if logged in within timeout."""
    log(f'waiting up to {timeout_s}s for QR scan / login...')
    end = time.time() + timeout_s
    while time.time() < end:
        if is_logged_in(driver, timeout_s=1):
            log('logged in!')
            return True
        time.sleep(2)
    log('login timeout')
    return False


# ─── XPath / CSS helpers with A/B fallback (WA Blaster style) ───────

def _xpath_or_css(driver, selector):
    """Returns Selenium By tuple. Auto-detects XPath vs CSS by leading char."""
    if selector.startswith('//') or selector.startswith('('):
        return (By.XPATH, selector)
    return (By.CSS_SELECTOR, selector)


def is_present_with_fallback(driver, primary, alt):
    """Check if element exists matching primary OR alt selector."""
    for sel in (primary, alt):
        if not sel:
            continue
        try:
            by, value = _xpath_or_css(driver, sel)
            if driver.find_elements(by, value):
                return True
        except Exception:
            continue
    return False


def find_with_fallback(driver, primary, alt, timeout_ms=5000, poll_ms=200):
    """
    Find element matching primary OR alt selector. Polls until timeout.
    Returns the element or None.
    """
    end = time.time() + (timeout_ms / 1000.0)
    while time.time() < end:
        for sel in (primary, alt):
            if not sel:
                continue
            try:
                by, value = _xpath_or_css(driver, sel)
                elements = driver.find_elements(by, value)
                for el in elements:
                    try:
                        if el.is_displayed():
                            return el
                    except Exception:
                        continue
            except Exception:
                continue
        time.sleep(poll_ms / 1000.0)
    return None


def find_by_pair_name(driver, base_name, timeout_ms=5000):
    """Convenience: find by selector base name (e.g., 'XPathSearchInputField')."""
    primary, alt = get_selector_pair(base_name)
    return find_with_fallback(driver, primary, alt, timeout_ms)


def get_modal_popup_text(driver):
    """
    Returns the text content of the chat-loading modal popup, or empty string.
    WA shows '[data-animate-modal-popup]' during navigation, with text like:
      - "Starting chat" → still loading, keep waiting
      - "Phone number ... not on WhatsApp" → invalid number, give up
    """
    primary, alt = get_selector_pair('CSSClassModalPopup')
    for sel in (primary, alt):
        if not sel:
            continue
        try:
            by, value = _xpath_or_css(driver, sel)
            elements = driver.find_elements(by, value)
            for el in elements:
                try:
                    if el.is_displayed():
                        return (el.text or '').strip()
                except Exception:
                    continue
        except Exception:
            continue
    return ''


# ─── FAST PATH: Search-based navigation (no page reload) ────────────
# Mimics WhatsApp Blaster's approach: load WA Web ONCE, then use the
# internal search box to jump between chats. Saves 20-25 seconds per
# message vs the URL-based driver.get() approach.

def find_search_box(driver, debug=False):
    """
    Find the main WhatsApp Web search input using configured XPath selectors.
    Uses XPathSearchInputField with XPathSearchInputField_Alt fallback,
    matching WA Blaster's strategy. Selectors are loaded from config.json
    so they can be updated when WA Web changes - without code changes.
    """
    return find_by_pair_name(driver, 'XPathSearchInputField', timeout_ms=500)


def ensure_wa_web_loaded(driver, timeout_s=60):
    """
    Ensure WhatsApp Web is fully loaded. Navigate to root URL ONCE if needed.
    After this call, the search box must be findable and clickable.
    Idempotent - cheap if already loaded.
    """
    t_total = time.time()
    current_url = driver.current_url or ''

    # Need to navigate if not on WA Web, OR if on a /send URL (we want the main view)
    needs_navigate = (
        'web.whatsapp.com' not in current_url or '/send' in current_url
    )

    if needs_navigate:
        log(f'init: navigating to web.whatsapp.com root (was: {current_url[:80] if current_url else "(blank)"})')
        t_nav = time.time()
        driver.get('https://web.whatsapp.com/')
        log(f'  ⏱ [DIAG] init driver.get: {time.time() - t_nav:.2f}s')

    # Wait for search box to be visible (= app fully loaded)
    t_wait = time.time()
    last_debug_dump = 0
    while time.time() - t_wait < timeout_s:
        search = find_search_box(driver)
        if search:
            log(f'  ⏱ [DIAG] WA Web ready (search box visible): {time.time() - t_total:.2f}s')
            return search

        # Every 10s, dump debug info about what the DOM contains
        if time.time() - last_debug_dump > 10:
            try:
                debug_info = driver.execute_script("""
                    const all = document.querySelectorAll('[contenteditable="true"]');
                    return Array.from(all).map(el => ({
                        visible: el.offsetParent !== null,
                        inFooter: !!el.closest('footer'),
                        inDialog: !!el.closest('[role="dialog"]'),
                        rect: (() => { const r = el.getBoundingClientRect(); return {top: r.top, left: r.left, w: r.width, h: r.height}; })(),
                        placeholder: el.getAttribute('aria-placeholder') || '',
                        label: el.getAttribute('aria-label') || '',
                        role: el.getAttribute('role') || '',
                        dataTab: el.getAttribute('data-tab') || ''
                    }));
                """)
                log(f'  [DEBUG] all contenteditable on page: {debug_info}')
            except Exception as e:
                log(f'  [DEBUG] dump failed: {e}')
            last_debug_dump = time.time()

        time.sleep(0.5)

    raise Exception(f'WA Web did not finish loading within {timeout_s}s')


def _get_chat_header_text(driver):
    """
    Read the open chat's header (recipient name/number).
    Used to verify that we navigated to the right chat after search.
    Returns empty string if no chat is open.
    """
    try:
        return driver.execute_script("""
            // The chat header is in #main > header at the top of the chat pane
            const header = document.querySelector('#main header');
            if (!header) return '';
            // Try to grab the most prominent text (contact name/number)
            const titleEl = header.querySelector('span[dir="auto"][title], h1, [data-testid="conversation-info-header"] span');
            if (titleEl) return (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
            return (header.textContent || '').trim().slice(0, 200);
        """) or ''
    except Exception:
        return ''


def open_chat_via_search(driver, phone, timeout_s=15):
    """
    Open a chat by typing the phone number in WA Web's search box.
    NO page reload - much faster than driver.get(/send?phone=X).

    Returns the message input element on success, or None on failure.
    Caller should fall back to URL-based open_chat if this returns None.

    SAFETY: Verifies the chat actually changed by comparing header before/after.
    Without this verification, a failed search-and-enter could leave us in
    the previous chat, and we'd send the new message to the wrong person.
    """
    digits = re.sub(r'\D', '', str(phone))
    # WA Blaster searches with raw digits (no + prefix) - confirmed via video frame analysis.
    # Using just digits avoids the IME/symbol typing overhead and matches what WA Web's
    # search index actually keys on (E.164 stored without +).
    search_term = digits

    # Capture the chat header BEFORE search - we'll use this to verify navigation
    header_before = _get_chat_header_text(driver)

    # Locate search box
    search = find_search_box(driver)
    if not search:
        log('  search box not found - need URL fallback')
        return None

    t_search_start = time.time()

    # ─── Reset + focus the search box (3-layer reliability) ─────────
    # Layer 1: Click via Selenium (normal interaction)
    try:
        search.click()
    except Exception:
        pass
    # Layer 2: JS click in case Selenium click was blocked
    try:
        driver.execute_script('arguments[0].click();', search)
    except Exception:
        pass
    # Layer 3: Force focus directly via JS - this is what really matters
    try:
        driver.execute_script("""
            arguments[0].focus();
            arguments[0].value = '';
            arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
        """, search)
    except Exception as e:
        log(f'  ⚠ search box JS focus/clear failed: {e}')
        return None
    time.sleep(0.2)

    # NOTE: We don't strict-check focus here. WA Web's DOM is quirky and
    # document.activeElement may not exactly match `search` even when typing
    # actually goes to the search box. We rely on TWO downstream safety nets:
    #   (1) Click on FIRST RESULT explicitly via XPath (no Enter key)
    #   (2) Verify chat header CHANGED before returning the input
    # If either fails, we abort and fall back to URL navigation - safe.

    # Type the phone number with international + prefix
    ActionChains(driver).send_keys(search_term).perform()
    time.sleep(0.7)  # let WA render search results

    # ─── CRITICAL CHANGE: click the FIRST RESULT explicitly via XPath ────
    # Pressing Enter is unreliable - sometimes leaves us on the previous chat.
    # Using the configured XPathFirstSearchResult is what WA Blaster does.
    first_result = find_by_pair_name(driver, 'XPathFirstSearchResult', timeout_ms=3000)

    if first_result:
        try:
            first_result.click()
            log(f'  ⏱ [DIAG] clicked first search result: {time.time() - t_search_start:.2f}s')
        except Exception as e:
            # Try JS click
            try:
                driver.execute_script('arguments[0].click();', first_result)
                log(f'  ⏱ [DIAG] JS-clicked first search result: {time.time() - t_search_start:.2f}s')
            except Exception:
                log(f'  ⚠ failed to click search result: {e} - aborting')
                return None
    else:
        # No search result found - either number not in WA, or search didn't render
        log(f'  ⚠ no search result for {search_term} after {time.time() - t_search_start:.2f}s')
        return None

    # Wait for chat input AND verify chat header changed (= we're in the right chat)
    t_input_wait = time.time()
    chat_changed = False

    while time.time() - t_input_wait < timeout_s:
        # Check if chat header changed (= we navigated to a new chat)
        if not chat_changed:
            header_now = _get_chat_header_text(driver)
            if header_now and header_now != header_before:
                chat_changed = True
                log(f'  ✓ chat header changed: "{header_before[:40]}..." → "{header_now[:40]}..."')
                # Soft verify: does the new header contain digits from our phone?
                # (Not strict - WA may show display name instead of number)
                last_4 = digits[-4:] if len(digits) >= 4 else digits
                if last_4 and last_4 not in header_now:
                    log(f'  ⚠ header doesn\'t contain phone last-4 ({last_4}) - may be display name, continuing')

        # Find the chat input
        inputs = driver.find_elements(
            By.CSS_SELECTOR,
            'footer div[contenteditable="true"][role="textbox"]'
        )
        if not inputs:
            inputs = driver.find_elements(
                By.CSS_SELECTOR,
                'footer div[contenteditable="true"]'
            )
        for inp in inputs:
            try:
                if inp.is_displayed():
                    # Only return when chat header has changed AND input found
                    if chat_changed:
                        log(f'  ⏱ [DIAG] chat input ready (after search): {time.time() - t_input_wait:.2f}s')
                        return inp
            except Exception:
                continue
        time.sleep(0.2)

    # Timeout: chat header didn't change OR input never appeared
    if not chat_changed:
        log(f'  ⚠ chat header did NOT change within {timeout_s}s - search did NOT navigate. Aborting (will fallback to URL)')
    else:
        log(f'  ⚠ chat header changed but input did not appear within {timeout_s}s')
    return None


def _get_input_from_text_field_p(driver, p_element):
    """
    The XPathTextInputField points to a <p> element. Selenium can send_keys
    to it directly, but WA's contenteditable div is the proper interaction
    target. Try to climb up to it; fallback to the <p> itself.
    """
    if p_element is None:
        return None
    try:
        ancestor = p_element.find_element(
            By.XPATH, "./ancestor::div[@contenteditable='true']"
        )
        return ancestor or p_element
    except Exception:
        return p_element


def wait_for_chat_state(driver, max_wait_s=20, stop_event=None):
    """
    WA Blaster-style chat load detection. Watches the chat-loading modal popup
    AND the text input field simultaneously:
      - popup with "Starting chat..." → still loading, keep waiting
      - popup with any OTHER text     → invalid number, fail FAST (3-5s)
      - text input appears            → chat ready, return it
      - stop_event.is_set()           → aborted by user, raise to break loop

    Returns: (state, payload)
        state='ready'   → payload = text input element
        state='invalid' → payload = popup text describing the problem
        state='timeout' → payload = None
        state='aborted' → payload = None  (stop_event was set)
    """
    start = time.time()
    poll_interval = 0.15  # poll every 150ms - very responsive
    while time.time() - start < max_wait_s:
        # ─── 0. Check for user stop request FIRST ────────────────────
        # This makes stop near-instant even during slow chat loads.
        # Without this, stop can be delayed up to max_wait_s (45s) when
        # the worker is stuck waiting for WA Web to load a slow chat.
        if stop_event is not None and stop_event.is_set():
            return ('aborted', None)
        # ─── 1. Check for the modal popup (loading or error) ─────────
        popup_text = get_modal_popup_text(driver)
        if popup_text:
            # Hebrew/English variations of "Starting chat..."
            loading_markers = ('starting chat', 'מתחיל שיחה', 'cargando chat', 'iniciando')
            popup_lower = popup_text.lower()
            still_loading = any(m in popup_lower for m in loading_markers)
            if still_loading:
                time.sleep(poll_interval)
                continue
            # Popup with non-loading text = error (invalid number, etc.)
            return ('invalid', popup_text)

        # ─── 2. No popup - check if chat is ready (text input visible) ─
        p_element = find_by_pair_name(driver, 'XPathTextInputField', timeout_ms=100)
        if p_element:
            input_element = _get_input_from_text_field_p(driver, p_element)
            return ('ready', input_element)

        time.sleep(poll_interval)

    return ('timeout', None)


def open_chat(driver, phone, message='', stop_event=None):
    """
    Open chat with phone number via URL navigation.
    Uses WA Blaster's popup-based detection for fast outcomes:
      - Invalid numbers fail in ~3-5s (popup text reveals it)
      - Valid numbers ready in ~5-15s (text input appears)

    stop_event: optional threading.Event - if set, wait_for_chat_state
                will abort early so user-requested stops take effect fast.
    """
    digits = re.sub(r'\D', '', str(phone))
    url = f'https://web.whatsapp.com/send?phone={digits}'
    if message:
        url += f'&text={quote(message)}'
    log(f'navigating: wa.me/send?phone={digits}')

    # ─── DIAGNOSTIC: measure navigation time ─────────────────────────
    t_nav_start = time.time()
    driver.get(url)
    nav_time = time.time() - t_nav_start
    log(f'  ⏱ [DIAG] navigate (driver.get): {nav_time:.2f}s')

    # ─── WA Blaster-style detection (popup + input watcher) ──────────
    # 45s handles WA Web reloads (when Chrome Test cycles WA the first
    # load after reload is 30-60s). Invalid numbers still resolve in 3-5s
    # via popup-text detection - no need to wait full timeout for those.
    CHAT_LOAD_TIMEOUT_S = 45
    t_wait_start = time.time()
    state, payload = wait_for_chat_state(driver, max_wait_s=CHAT_LOAD_TIMEOUT_S,
                                          stop_event=stop_event)
    elapsed = time.time() - t_wait_start

    if state == 'ready':
        log(f'  ⏱ [DIAG] chat_load (input ready): {elapsed:.2f}s')
        # Try to dismiss any post-navigation invalid-number popup just in case
        try:
            invalid_btn = find_by_pair_name(driver, 'XPathInvalidPhoneNumber', timeout_ms=100)
            if invalid_btn:
                invalid_btn.click()
                time.sleep(0.2)
        except Exception:
            pass
        return payload

    if state == 'invalid':
        log(f'  ⏱ [DIAG] invalid number detected in {elapsed:.2f}s: {payload[:120]}')
        # Try to dismiss the popup so next attempt has clean state
        try:
            ok_btn = find_by_pair_name(driver, 'XPathInvalidPhoneNumber', timeout_ms=500)
            if ok_btn:
                ok_btn.click()
                time.sleep(0.3)
        except Exception:
            pass
        # Reset to root URL so next message's search-based path has clean DOM
        # (without this, WA stays on /send?phone=X and search box gets weird)
        try:
            driver.get('https://web.whatsapp.com/')
            time.sleep(0.8)
        except Exception:
            pass
        raise Exception(f'invalid number: {digits} ({payload[:80]})')

    if state == 'aborted':
        log(f'  🛑 [STOP] chat load aborted by user stop request after {elapsed:.2f}s')
        # Reset URL so subsequent messages (if any) have clean DOM
        try:
            driver.get('https://web.whatsapp.com/')
            time.sleep(0.5)
        except Exception:
            pass
        raise Exception('aborted by user')

    # Timeout (state == 'timeout')
    log(f'  ⏱ [DIAG] chat_load TIMEOUT after {elapsed:.2f}s')
    # Reset URL on timeout so next message can use search
    try:
        driver.get('https://web.whatsapp.com/')
        time.sleep(0.8)
    except Exception:
        pass
    # Clearer error: explains the REAL cause (WA Web reload), not just symptom.
    # The frontend log line is built as "lang: X - error: Y" so the cause
    # text shows immediately and isn't masked by the language prefix.
    raise Exception(
        f'WhatsApp Web did not load chat for {digits} within '
        f'{CHAT_LOAD_TIMEOUT_S}s (WA Web may be reloading - try again)'
    )


def attach_files(driver, file_paths):
    """
    Attach ONE OR MORE files to the current WhatsApp chat in a single batch.
    Uses Selenium's send_keys('a\\nb\\nc') trick: passing newline-separated
    paths to <input type="file" multiple> selects them all at once. WA shows
    a single preview gallery with all files, and one Send action sends them
    all together as one logical message (caption applies to first file).
    """
    if not file_paths:
        raise Exception('attach_files called with empty list')
    paths = file_paths if isinstance(file_paths, (list, tuple)) else [file_paths]
    paths = [os.path.abspath(p) for p in paths]

    # Validate all files exist BEFORE clicking - cleaner failure
    for p in paths:
        if not os.path.exists(p):
            raise Exception(f'file not found: {p}')

    log(f'attaching {len(paths)} file(s):')
    for p in paths:
        log(f'   - {os.path.basename(p)} ({os.path.getsize(p)} bytes)')

    # Click attach button to render the file inputs (WA lazy-renders them)
    try:
        attach_btn = driver.find_element(By.CSS_SELECTOR, 'span[data-icon="plus-rounded"]')
    except NoSuchElementException:
        try:
            attach_btn = driver.find_element(
                By.CSS_SELECTOR, '[data-testid="clip"], button[aria-label*="Attach" i]'
            )
        except NoSuchElementException:
            raise Exception('attach button not found')

    # Ensure clickable
    clickable = attach_btn
    for _ in range(3):
        try:
            parent = clickable.find_element(By.XPATH, '..')
            if parent.tag_name in ('button',) or parent.get_attribute('role') == 'button':
                clickable = parent
                break
            clickable = parent
        except Exception:
            break
    try:
        clickable.click()
    except Exception:
        attach_btn.click()

    time.sleep(0.8)

    # Find ALL file inputs. With Chrome Test, we can send_keys directly to any.
    # Prefer the one that accepts "*" (document), fall back to first.
    file_inputs = driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]')
    log(f'found {len(file_inputs)} file inputs')
    if not file_inputs:
        raise Exception('no file input found in DOM')

    target = None
    for inp in file_inputs:
        accept = (inp.get_attribute('accept') or '').lower()
        log(f'  input accept="{accept}"')
        if '*' == accept.strip() or accept == '' or 'application' in accept:
            target = inp
            break
    if target is None:
        target = file_inputs[0]

    # CRITICAL: send_keys with newline-separated paths → multi-file selection
    # in a single shot. This is how WA Web's <input type="file" multiple> works.
    paths_concat = '\n'.join(paths)
    log(f'sending {len(paths)} path(s) to file input via newline-join')
    target.send_keys(paths_concat)

    # Wait for preview(s) to appear. For multi-file uploads WA shows a
    # gallery navigation; for single it shows the standard preview.
    wait = WebDriverWait(driver, max(20, 5 * len(paths)))  # more time for many files
    wait.until(
        lambda d: d.find_elements(By.CSS_SELECTOR, '[data-testid="media-preview"]') or
                  any(
                      os.path.basename(paths[0]) in (el.text or '')
                      for el in d.find_elements(By.CSS_SELECTOR, '[role="dialog"]')
                  ) or
                  d.find_elements(By.CSS_SELECTOR, 'img[src^="blob:"]')
    )
    log(f'preview appeared for {len(paths)} file(s)')


def attach_file(driver, file_path):
    """
    BACKWARD COMPATIBILITY shim: routes single file through attach_files.
    Existing callers continue to work unchanged.
    """
    return attach_files(driver, [file_path])


def _type_with_newlines(driver, text):
    """
    LEGACY (slow) typing path: types text character-by-character using Shift+Enter
    for newlines. Kept as a fallback when pyperclip is unavailable.

    WhatsApp treats Enter as SEND, so a plain ActionChains.send_keys('a\\nb') would
    send 'a' as one message and start typing 'b' in a new chat input — splitting
    a multi-line template into multiple separate messages.
    Shift+Enter inserts a soft line break without sending. Result: one message
    with internal newlines, exactly as the template intends.
    """
    if not text:
        return
    # Normalize newline conventions
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = text.split('\n')

    actions = ActionChains(driver)
    for i, line in enumerate(lines):
        if line:
            actions.send_keys(line)
        if i < len(lines) - 1:
            # Soft line break: Shift+Enter
            actions.key_down(Keys.SHIFT).send_keys(Keys.ENTER).key_up(Keys.SHIFT)
    actions.perform()


def _paste_with_newlines(driver, text):
    """
    PRIMARY (fast) input path: copies the text to the OS clipboard and pastes via
    Ctrl+V — same approach as WA Blaster (visible in their video: instant message
    appearance, no per-character typing animation).

    Why this is dramatically faster:
      - Typing 200 chars via ActionChains.send_keys: ~1.5–2.0 seconds
      - Pasting 200 chars via clipboard: ~50–100 ms (single keyboard event)
      Saving ~1.5s per message × 100 messages = ~2.5 minutes per batch.

    Multi-line handling: copies the FULL text once and pastes once. WhatsApp Web's
    contenteditable converts pasted '\\n' into soft line breaks correctly, so the
    message stays as ONE message (not multiple). If for some reason WA splits
    on newlines after paste, we fall back to per-line paste with explicit
    Shift+Enter between lines.

    Falls back to _type_with_newlines if pyperclip is not installed.
    """
    if not text:
        return

    if not HAS_PYPERCLIP:
        log('  pyperclip unavailable — falling back to typing (slower)')
        _type_with_newlines(driver, text)
        return

    # Normalize newline conventions
    text = text.replace('\r\n', '\n').replace('\r', '\n')

    # Strategy A: paste the whole multi-line text in one shot (preferred — fewer
    # keyboard events, less chance of focus drift between paste operations).
    try:
        pyperclip.copy(text)
        # Tiny pause — some clipboard managers take a few ms to commit
        time.sleep(0.05)
        ActionChains(driver).key_down(Keys.CONTROL).send_keys('v').key_up(Keys.CONTROL).perform()
        return
    except Exception as e:
        log(f'  full-text paste failed ({e}) — trying per-line paste')

    # Strategy B (fallback): paste line-by-line, with explicit Shift+Enter between.
    # Each paste needs its own perform() because we mutate the clipboard between calls.
    lines = text.split('\n')
    try:
        for i, line in enumerate(lines):
            if line:
                pyperclip.copy(line)
                time.sleep(0.03)
                ActionChains(driver).key_down(Keys.CONTROL).send_keys('v').key_up(Keys.CONTROL).perform()
            if i < len(lines) - 1:
                ActionChains(driver).key_down(Keys.SHIFT).send_keys(Keys.ENTER).key_up(Keys.SHIFT).perform()
        return
    except Exception as e:
        log(f'  per-line paste failed ({e}) — falling back to typing')

    # Strategy C (last resort): character-by-character typing
    _type_with_newlines(driver, text)


def type_caption(driver, text):
    """Type caption in preview mode. Falls back to main message input."""
    if not text:
        return

    # Strategy 1: Caption-specific input (visible in preview mode)
    candidates = driver.find_elements(
        By.CSS_SELECTOR,
        'div[contenteditable="true"][aria-label*="caption" i], '
        'div[contenteditable="true"][aria-placeholder*="caption" i], '
        'div[contenteditable="true"][aria-label*="הוסף כיתוב" i], '
        'div[contenteditable="true"][aria-placeholder*="הוסף כיתוב" i], '
        'div[contenteditable="true"][data-lexical-editor]'
    )

    # Strategy 2: any visible contenteditable that's NOT search and NOT the main msg footer
    if not candidates:
        all_editables = driver.find_elements(By.CSS_SELECTOR, 'div[contenteditable="true"]')
        log(f'fallback: found {len(all_editables)} contenteditable elements')
        for el in all_editables:
            try:
                if not el.is_displayed():
                    continue
                aria = (el.get_attribute('aria-label') or '').lower()
                placeholder = (el.get_attribute('aria-placeholder') or '').lower()
                if 'search' in aria or 'חיפוש' in aria:
                    continue
                # Prefer caption-like, avoid main footer message input
                if 'caption' in aria or 'כיתוב' in aria or 'caption' in placeholder:
                    candidates = [el]
                    break
                # Otherwise track as fallback
                if not candidates:
                    candidates = [el]
            except Exception:
                continue

    if not candidates:
        log('no caption input found - skipping caption')
        return

    target = candidates[0]
    try:
        target.click()
        time.sleep(0.4)
        # Clear any existing content first
        target.send_keys(Keys.CONTROL, 'a')
        target.send_keys(Keys.DELETE)
        time.sleep(0.1)
        # Paste (with Shift+Enter for newlines) so multi-line caption stays as ONE caption
        _paste_with_newlines(driver, text)
        log(f'pasted caption ({len(text)} chars): "{text[:50]}"')
    except Exception as e:
        log(f'caption type failed: {e}')


def click_send(driver):
    """Find and click the Send button (for preview mode or text mode)."""
    log('looking for send button...')

    # Strategy 1: aria-label Send (most stable)
    candidates = list(driver.find_elements(
        By.CSS_SELECTOR,
        'button[aria-label="Send"], button[aria-label="שלח"], '
        '[role="button"][aria-label="Send"], [role="button"][aria-label="שלח"], '
        'button[aria-label*="Send" i], [role="button"][aria-label*="Send" i]'
    ))
    log(f'  aria-label matches: {len(candidates)}')

    # Strategy 2: data-icon containing "send"
    if not candidates:
        send_icons = driver.find_elements(
            By.CSS_SELECTOR,
            'span[data-icon="send"], span[data-icon="wds-ic-send-filled"], '
            'span[data-icon="send-filled"], span[data-icon*="send" i]'
        )
        for icon in send_icons:
            try:
                btn = icon.find_element(
                    By.XPATH,
                    './ancestor::button[1] | ./ancestor::*[@role="button"][1] | ./ancestor::div[@tabindex="0"][1]'
                )
                candidates.append(btn)
            except Exception:
                candidates.append(icon)
        log(f'  data-icon matches: {len(candidates)}')

    # Strategy 3: tell-tale green circular button at bottom-right
    if not candidates:
        all_buttons = driver.find_elements(
            By.CSS_SELECTOR, 'button, [role="button"], div[tabindex="0"]'
        )
        for b in all_buttons:
            try:
                if not b.is_displayed() or not b.is_enabled():
                    continue
                rect = b.rect
                if not rect or rect.get('width', 0) < 30 or rect.get('width', 0) > 90:
                    continue
                # Check if it has a send-ish SVG or icon
                svgs = b.find_elements(By.CSS_SELECTOR, 'svg, span[data-icon*="send"]')
                if svgs:
                    candidates.append(b)
            except Exception:
                continue
        log(f'  visual matches: {len(candidates)}')

    if not candidates:
        # Last resort: Ctrl+Enter keyboard shortcut
        log('no send button found, trying Ctrl+Enter')
        ActionChains(driver).key_down(Keys.CONTROL).send_keys(Keys.ENTER).key_up(Keys.CONTROL).perform()
        return

    # Pick the first visible + enabled candidate
    btn = None
    for c in candidates:
        try:
            if c.is_displayed() and c.is_enabled():
                aria_dis = c.get_attribute('aria-disabled')
                if aria_dis == 'true':
                    continue
                btn = c
                break
        except Exception:
            continue
    if not btn:
        btn = candidates[0]

    try:
        btn.click()
        log('send clicked via element')
    except Exception as e:
        log(f'btn.click() failed: {e}, trying JS click')
        driver.execute_script('arguments[0].click();', btn)
        log('send clicked via JS')


def send_single_message(driver, phone, message,
                        file_path=None,
                        file_paths=None,
                        attachment_upload_delay=DEFAULT_ATTACHMENT_UPLOAD_DELAY_S,
                        action_delay=DEFAULT_ACTION_DELAY_S,
                        stop_event=None):
    """
    Complete flow: open chat, (attach files), type caption, send.

    Attachments:
      file_path:   legacy single-file param (backward compatible)
      file_paths:  list of paths for multi-file (preferred for new code)

    Tunable delays (defaults match WhatsApp Blaster's recommendations):
      attachment_upload_delay - seconds to wait after click_send. PDFs and
                                large galleries need more. Range: 2-15s.
      action_delay            - seconds between sub-actions (typing → click).
                                Range: 0.3-2s.

    stop_event - optional threading.Event from caller. If set during
                 chat-load wait, the operation aborts fast (raises
                 'aborted by user') so user stop requests don't have
                 to wait up to 45s for the WA Web load timeout.
    """
    t_msg_start = time.time()

    # Normalize attachments to a list
    attachments = []
    if file_paths:
        attachments = list(file_paths)
    elif file_path:
        attachments = [file_path]
    has_attachments = len(attachments) > 0

    # FAST PATH: try search-based navigation first (no page reload)
    msg_input = open_chat_via_search(driver, phone)

    # SLOW FALLBACK: if search failed (e.g. number not on WA / new contact),
    # fall back to URL-based navigation which causes a full page reload.
    if msg_input is None:
        log('  ⚠ falling back to URL-based open_chat (slow path)')
        msg_input = open_chat(driver, phone, message='' if has_attachments else '',
                              stop_event=stop_event)

    if has_attachments:
        # ─── ATTACHMENT FLOW ─────────────────────────────────────────
        t_attach_start = time.time()
        attach_files(driver, attachments)
        time.sleep(min(action_delay * 2, 3.0))  # let preview fully render (capped at 3s)

        # CRITICAL: After file attach, the attach menu may still be open.
        try:
            body = driver.find_element(By.TAG_NAME, 'body')
            ActionChains(driver).move_to_element(body).click().perform()
            time.sleep(0.3)
        except Exception as e:
            log(f'body click skipped: {e}')
        log(f'  ⏱ [DIAG] attach+preview: {time.time() - t_attach_start:.2f}s')

        t_caption_start = time.time()
        type_caption(driver, message or '')
        time.sleep(action_delay)
        log(f'  ⏱ [DIAG] caption_type: {time.time() - t_caption_start:.2f}s')

        t_send_start = time.time()
        click_send(driver)
        time.sleep(attachment_upload_delay)  # PDFs take longer to upload
        log(f'  ⏱ [DIAG] click_send + upload_wait: {time.time() - t_send_start:.2f}s')
    else:
        # ─── TEXT-ONLY FLOW ──────────────────────────────────────────
        if message:
            t_type_start = time.time()
            msg_input.click()
            time.sleep(0.2)
            # Paste via clipboard (Ctrl+V) — ~10x faster than typing for long messages.
            # Shift+Enter for embedded newlines so multi-line template stays as ONE message.
            _paste_with_newlines(driver, message)
            time.sleep(min(action_delay * 0.5, 1.0))  # short pause after paste
            log(f'  ⏱ [DIAG] paste ({len(message)} chars): {time.time() - t_type_start:.2f}s')

        t_send_start = time.time()
        ActionChains(driver).send_keys(Keys.ENTER).perform()
        time.sleep(min(action_delay * 1.5, 3.0))  # let WA process the send
        log(f'  ⏱ [DIAG] enter+wait: {time.time() - t_send_start:.2f}s')

    # ─── TOTAL MESSAGE TIME ─────────────────────────────────────────
    total_time = time.time() - t_msg_start
    log(f'  ⏱ [DIAG] ═══ TOTAL MESSAGE: {total_time:.2f}s ═══')


# ─── Bulk job runner ────────────────────────────────────────────────
_jobs = {}  # job_id -> { queue, thread, status }


def _resolve_attachment_to_path(attachment_meta, employee_idx, att_idx):
    """
    Convert an attachment meta dict to a local file path.

    attachment_meta supports two forms:
      { 'url':    'https://...', 'filename': 'doc.pdf' }   ← preferred (smaller payload)
      { 'base64': '...',         'filename': 'doc.pdf' }   ← inline data

    Returns the path to a freshly-saved file in tmp dir, or None on failure.
    Caller is responsible for deleting the file when done.
    """
    if not attachment_meta:
        return None

    filename = attachment_meta.get('filename') or f'attachment_{employee_idx}_{att_idx}.bin'
    # Sanitize filename - prevent path traversal
    filename = os.path.basename(filename).replace('\\', '_')
    if not filename:
        filename = f'attachment_{employee_idx}_{att_idx}.bin'

    # Make filename unique within tmp dir to avoid collisions across batch
    safe_filename = f'{employee_idx}_{att_idx}_{filename}'
    tmp_dir = os.path.join(tempfile.gettempdir(), 'base44_bulk')
    os.makedirs(tmp_dir, exist_ok=True)
    out_path = os.path.join(tmp_dir, safe_filename)

    try:
        if 'url' in attachment_meta and attachment_meta['url']:
            url = attachment_meta['url']
            log(f'    ⬇ downloading: {url[:80]}...')
            r = requests.get(url, timeout=30, allow_redirects=True)
            r.raise_for_status()
            with open(out_path, 'wb') as f:
                f.write(r.content)
            log(f'    ✓ saved {len(r.content)} bytes to {os.path.basename(out_path)}')
            return out_path

        if 'base64' in attachment_meta and attachment_meta['base64']:
            data_bytes = base64.b64decode(attachment_meta['base64'])
            with open(out_path, 'wb') as f:
                f.write(data_bytes)
            log(f'    ✓ decoded {len(data_bytes)} bytes to {os.path.basename(out_path)}')
            return out_path

        log(f'    ✗ attachment has neither url nor base64: {list(attachment_meta.keys())}')
        return None

    except requests.RequestException as e:
        log(f'    ✗ download failed: {e}')
        return None
    except Exception as e:
        log(f'    ✗ resolve failed: {e}')
        return None


def run_bulk_job(job_id, employees, template, attachment_path,
                 delay_min, delay_max,
                 attachment_upload_delay, action_delay,
                 stop_event):
    """Runs in its own thread. Pushes progress to jobs[job_id]['queue']."""
    q = _jobs[job_id]['queue']
    def push(event):
        # CRITICAL: include job_id in EVERY event so the client can capture
        # it for stop/pause/resume control via /stop/<id>, /pause/<id>, /resume/<id>
        event['job_id'] = job_id
        try:
            q.put_nowait(event)
        except Exception:
            pass

    log(f'═══ JOB {job_id} STARTED with {len(employees)} messages ═══')
    push({'type': 'start', 'total': len(employees), 'timestamp': time.time()})

    try:
        driver = get_driver()
        if not is_logged_in(driver):
            push({'type': 'need_login', 'message': 'WhatsApp not logged in. Scan QR in Chrome Test.'})
            if not wait_for_login(driver, timeout_s=180):
                push({'type': 'error', 'message': 'login timeout'})
                return
            push({'type': 'logged_in'})

        # ─── QUICK WA Web check (don't wait long) ────────────────────
        # Don't waste time waiting for full WA Web load - it can take 1-3
        # minutes on accounts with many chats. The first URL navigation
        # will trigger full load anyway, and subsequent messages can use
        # search-based fast path if/when WA finishes loading in background.
        try:
            quick_search = find_search_box(driver)
            if quick_search:
                log('═══ WA Web already loaded - search path will be fast ═══')
                push({'type': 'wa_ready'})
            else:
                log('═══ WA Web not fully loaded yet - first msg will use URL ═══')
                push({'type': 'wa_loading'})
        except Exception as e:
            log(f'  search check failed (non-fatal): {e}')
            push({'type': 'wa_loading'})
    except Exception as e:
        push({'type': 'error', 'message': f'driver/login failed: {e}', 'trace': traceback.format_exc()})
        return

    sent, failed = 0, 0
    msg_timings = []  # ─── DIAG: collect per-message totals

    # Helper for pause - blocks while paused, with timeout safety
    PAUSE_AUTO_RESUME_AFTER_S = 30 * 60  # 30 min - if forgotten, auto-resume
    pause_event = _jobs[job_id].get('pause_event')

    def wait_while_paused():
        """If paused, sleep until unpaused or timeout. Returns True if continued, False if stopped."""
        if not pause_event or not pause_event.is_set():
            return True
        log(f'⏸ ENTERING PAUSED state at message {idx + 1}/{len(employees)}')
        push({'type': 'paused', 'at_index': idx, 'message': f'Paused before message {idx + 1}'})
        pause_start = time.time()
        last_log_at = pause_start
        while pause_event.is_set():
            if stop_event.is_set():
                log(f'   pause interrupted by STOP - exiting')
                return False
            elapsed = time.time() - pause_start
            if elapsed > PAUSE_AUTO_RESUME_AFTER_S:
                log(f'⚠ pause exceeded {PAUSE_AUTO_RESUME_AFTER_S}s - auto-stopping (avoid stale Chrome Test session)')
                push({'type': 'pause_timeout_stopping',
                      'message': f'Pause exceeded {PAUSE_AUTO_RESUME_AFTER_S//60} min - stopping job to avoid session expiry'})
                stop_event.set()
                return False
            # Periodic log every 60s while paused
            if time.time() - last_log_at > 60:
                log(f'   still paused ({int(elapsed)}s elapsed, auto-stop at {PAUSE_AUTO_RESUME_AFTER_S}s)')
                last_log_at = time.time()
            time.sleep(0.1)  # poll every 100ms for responsive resume
        log(f'▶ RESUMING from paused state at message {idx + 1}/{len(employees)}')
        push({'type': 'resumed', 'at_index': idx, 'message': f'Resumed at message {idx + 1}'})
        return True

    for idx, emp in enumerate(employees):
        if stop_event.is_set():
            push({'type': 'stopped', 'at_index': idx})
            break

        # Check for pause BEFORE each message
        if not wait_while_paused():
            push({'type': 'stopped', 'at_index': idx})
            break

        phone = emp.get('phone', '')
        name = emp.get('name', '') or emp.get('first_name_he', '') or phone

        # ─── PER-EMPLOYEE MESSAGE OVERRIDE (locale-first support, 29/04/2026) ─────
        # The Universal Messaging Hub orchestrator selects the right localized
        # template per recipient (MessageTemplateLocale) BEFORE calling the daemon.
        # It passes the resolved content as `message` (or `rendered_message`) on
        # each employee object. The daemon must use that override instead of the
        # base `template`, otherwise locale-first is silently bypassed and every
        # recipient gets the Hebrew template regardless of their language.
        #
        # Backward compatible: legacy callers that don't set per-employee message
        # still work — we fall back to the base `template` exactly like before.
        emp_msg_override = emp.get('message') or emp.get('rendered_message')
        if emp_msg_override:
            rendered = emp_msg_override
            log(f'  📨 using per-employee message override ({len(rendered)} chars)')
        else:
            rendered = template
        # Substitute {{placeholders}} from emp fields, regardless of source.
        # Skip control fields that aren't meant to be substituted.
        _SKIP_KEYS = {'message', 'rendered_message', 'attachments', 'attachment',
                      'localeUsed', 'locale_used', 'lang', 'language'}
        for k, v in emp.items():
            if k in _SKIP_KEYS:
                continue
            rendered = rendered.replace(f'{{{{{k}}}}}', str(v or ''))

        push({
            'type': 'sending', 'index': idx, 'total': len(employees),
            'phone': phone, 'name': name
        })

        # ─── DIAG: separator + outer timing ─────────────────────────
        log(f'─── MESSAGE {idx + 1}/{len(employees)} → {phone} ({name}) ───')
        t_outer_start = time.time()

        # ─── Resolve per-employee attachments (URL or base64 → local path) ─
        # Per-employee `attachments` array overrides the batch-level single attachment.
        # Each item: { url, filename } OR { base64, filename }
        emp_attachments_meta = emp.get('attachments') or []
        emp_file_paths = []
        emp_temp_files = []  # to cleanup after this message
        try:
            for att_idx, att in enumerate(emp_attachments_meta):
                resolved = _resolve_attachment_to_path(att, idx, att_idx)
                if resolved:
                    emp_file_paths.append(resolved)
                    emp_temp_files.append(resolved)

            # If employee has no per-msg attachments, fall back to batch-level (if any)
            file_paths_to_send = emp_file_paths if emp_file_paths else (
                [attachment_path] if attachment_path else None
            )

            send_single_message(driver, phone, rendered,
                                file_paths=file_paths_to_send,
                                attachment_upload_delay=attachment_upload_delay,
                                action_delay=action_delay,
                                stop_event=stop_event)
            outer_time = time.time() - t_outer_start
            msg_timings.append(outer_time)
            sent += 1
            push({
                'type': 'sent', 'index': idx, 'phone': phone, 'name': name,
                'sent_count': sent,
                'attachments_count': len(file_paths_to_send) if file_paths_to_send else 0
            })
        except Exception as e:
            outer_time = time.time() - t_outer_start
            msg_timings.append(outer_time)
            err = str(e)[:300]
            # ─── Handle user stop mid-chat-load specially ────────────────
            # When user presses Stop while we're waiting for a slow WA Web
            # chat to load, wait_for_chat_state aborts and raises
            # "aborted by user". This should NOT count as a failure - the
            # user explicitly asked to halt, the message just hadn't been
            # sent yet. Treat it as a clean stop and exit the loop.
            if 'aborted by user' in err or stop_event.is_set():
                log(f'  🛑 STOP detected mid-message for {phone} (after {outer_time:.2f}s) - halting loop')
                push({'type': 'stopped', 'at_index': idx})
                # Cleanup any temp files this iteration created before we leave
                for tmp in emp_temp_files:
                    try:
                        if os.path.exists(tmp):
                            os.remove(tmp)
                    except Exception:
                        pass
                break
            failed += 1
            log(f'  FAIL {phone} (after {outer_time:.2f}s): {err}')
            push({
                'type': 'failed', 'index': idx, 'phone': phone, 'name': name,
                'error': err, 'failed_count': failed
            })
        finally:
            # Cleanup per-employee temp files (don't touch batch-level attachment_path)
            for tmp in emp_temp_files:
                try:
                    if os.path.exists(tmp):
                        os.remove(tmp)
                except Exception:
                    pass

        # Delay before next send (unless last or stopped)
        if idx < len(employees) - 1 and not stop_event.is_set():
            delay_s = random.uniform(delay_min, delay_max)
            push({'type': 'delay', 'seconds': round(delay_s, 1), 'next_at': time.time() + delay_s})
            # Sleep in small chunks to allow stop/pause to interrupt
            end = time.time() + delay_s
            while time.time() < end and not stop_event.is_set():
                # If paused mid-delay, exit the delay loop and let pause handler take over next iter
                if pause_event and pause_event.is_set():
                    break
                time.sleep(0.5)

    # ─── DIAG: final timing summary ─────────────────────────────────
    if msg_timings:
        avg_t = sum(msg_timings) / len(msg_timings)
        min_t = min(msg_timings)
        max_t = max(msg_timings)
        total_t = sum(msg_timings)
        log('═══════════════════════════════════════════════════════════')
        log(f'⏱  [DIAG] TIMING SUMMARY for job {job_id}')
        log(f'   Messages: {len(msg_timings)} (sent={sent}, failed={failed})')
        log(f'   Per-message: avg={avg_t:.2f}s, min={min_t:.2f}s, max={max_t:.2f}s')
        log(f'   Total send time: {total_t:.2f}s ({total_t/60:.1f} min)')
        log('═══════════════════════════════════════════════════════════')

    push({'type': 'complete', 'sent': sent, 'failed': failed, 'total': len(employees)})
    _jobs[job_id]['status'] = 'complete'


# ─── Flask app ──────────────────────────────────────────────────────
app = Flask(__name__)

# CORS: allow all origins since daemon only binds to 127.0.0.1 (localhost-only,
# not exposed to the internet). Flask-CORS doesn't handle glob wildcards in
# origins strings, so we explicitly open it and add headers to every response
# (especially needed for SSE streams which bypass flask-cors sometimes).
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=False)


@app.after_request
def _ensure_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Cache-Control'
    response.headers['Access-Control-Expose-Headers'] = 'Content-Type'
    return response


@app.route('/status', methods=['GET'])
def status():
    """Daemon status + WA login state."""
    global _driver
    driver_alive = False
    logged_in = False
    try:
        if _driver is not None:
            _ = _driver.current_url
            driver_alive = True
            logged_in = is_logged_in(_driver, timeout_s=1)
    except Exception:
        pass

    return jsonify({
        'daemon': 'running',
        'version': '1.0.0',
        'driver_alive': driver_alive,
        'wa_logged_in': logged_in,
        'active_jobs': [jid for jid, j in _jobs.items() if j['status'] == 'running'],
        'config': {
            'chrome_path': CHROME_PATH,
            'profile_dir': PROFILE_DIR,
            'chromedriver_path': CHROMEDRIVER_PATH,
        }
    })


@app.route('/open_whatsapp', methods=['POST'])
def open_whatsapp():
    """Open Chrome Test with WhatsApp (for first-time QR scan)."""
    try:
        driver = get_driver()
        return jsonify({
            'success': True,
            'logged_in': is_logged_in(driver, timeout_s=2)
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/bulk_send', methods=['POST'])
def bulk_send():
    """Start a bulk send job. Returns immediately with job_id."""
    if not _job_lock.acquire(blocking=False):
        return jsonify({'error': 'another bulk job is running', 'error_code': 'BUSY'}), 409

    try:
        data = request.get_json(force=True)
        employees = data.get('employees', [])
        template = data.get('template', '')
        attachment_b64 = data.get('attachment_base64')
        attachment_filename = data.get('attachment_filename', 'attachment.bin')
        delay_min = float(data.get('delay_min_s', DEFAULT_DELAY_MIN_S))
        delay_max = float(data.get('delay_max_s', DEFAULT_DELAY_MAX_S))
        attachment_upload_delay = float(data.get('attachment_upload_delay_s', DEFAULT_ATTACHMENT_UPLOAD_DELAY_S))
        action_delay = float(data.get('action_delay_s', DEFAULT_ACTION_DELAY_S))

        # Sanity clamps - prevent footgun values
        delay_min = max(0.5, min(delay_min, 600))           # 0.5s - 10min
        delay_max = max(delay_min, min(delay_max, 600))
        attachment_upload_delay = max(0.5, min(attachment_upload_delay, 60))
        action_delay = max(0.1, min(action_delay, 10))

        log(f'delays: between={delay_min}-{delay_max}s, '
            f'attach_upload={attachment_upload_delay}s, action={action_delay}s')

        if not employees:
            _job_lock.release()
            return jsonify({'error': 'empty employees list'}), 400
        if len(employees) > DAILY_CAP:
            _job_lock.release()
            return jsonify({'error': f'batch too large: {len(employees)} > {DAILY_CAP} daily cap'}), 400

        # Save attachment to temp if provided
        attachment_path = None
        if attachment_b64:
            try:
                data_bytes = base64.b64decode(attachment_b64)
                tmp_dir = os.path.join(tempfile.gettempdir(), 'base44_bulk')
                os.makedirs(tmp_dir, exist_ok=True)
                safe_filename = os.path.basename(attachment_filename).replace('\\', '').replace('/', '')
                attachment_path = os.path.join(tmp_dir, safe_filename)
                with open(attachment_path, 'wb') as f:
                    f.write(data_bytes)
                log(f'saved attachment: {attachment_path} ({len(data_bytes)} bytes)')
            except Exception as e:
                _job_lock.release()
                return jsonify({'error': f'attachment save failed: {e}'}), 400

        job_id = f'job_{int(time.time() * 1000)}'
        stop_event = threading.Event()
        pause_event = threading.Event()  # set = paused, clear = running
        _jobs[job_id] = {
            'queue': queue.Queue(maxsize=1000),
            'status': 'running',
            'stop_event': stop_event,
            'pause_event': pause_event,
            'total': len(employees),
            'started_at': time.time()
        }

        def worker():
            try:
                run_bulk_job(job_id, employees, template, attachment_path,
                             delay_min, delay_max,
                             attachment_upload_delay, action_delay,
                             stop_event)
            except Exception as e:
                log(f'worker crashed: {e}')
                log(traceback.format_exc())
                try:
                    _jobs[job_id]['queue'].put_nowait({'type': 'error', 'message': str(e)})
                except Exception:
                    pass
                _jobs[job_id]['status'] = 'failed'
            finally:
                _job_lock.release()
        log(f"[/bulk_send 500] {type(e).__name__}: {e}")
        log(traceback.format_exc())

        t = threading.Thread(target=worker, daemon=True)
        _jobs[job_id]['thread'] = t
        t.start()

        return jsonify({
            'success': True,
            'job_id': job_id,
            'total': len(employees),
            'sse_url': f'/progress/{job_id}'
        })
    except Exception as e:
        _job_lock.release()
        log(f"[/bulk_send 500] {type(e).__name__}: {e}")
        log(traceback.format_exc())
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/progress/<job_id>', methods=['GET'])
def progress(job_id):
    """SSE stream of job progress events."""
    if job_id not in _jobs:
        return jsonify({'error': 'unknown job_id'}), 404

    def generate():
        job = _jobs[job_id]
        q = job['queue']
        while True:
            try:
                event = q.get(timeout=30)
            except queue.Empty:
                # Heartbeat
                yield f': ping\n\n'
                if job['status'] != 'running':
                    break
                continue
            yield f'data: {json.dumps(event)}\n\n'
            if event.get('type') in ('complete', 'stopped', 'error'):
                break

    return Response(stream_with_context(generate()),
                    mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/stop/<job_id>', methods=['POST'])
def stop_job(job_id):
    log(f'🛑 STOP requested for job {job_id}')
    if job_id not in _jobs:
        log(f'   FAIL: unknown job_id (active: {list(_jobs.keys())})')
        return jsonify({'error': 'unknown job_id', 'active_jobs': list(_jobs.keys())}), 404
    _jobs[job_id]['stop_event'].set()
    # Also clear pause if set, so the worker thread doesn't stay stuck in pause
    pe = _jobs[job_id].get('pause_event')
    if pe and pe.is_set():
        log(f'   clearing pause flag so stop can take effect immediately')
        pe.clear()
    # Push event to SSE queue for immediate UI feedback
    try:
        _jobs[job_id]['queue'].put_nowait({
            'type': 'stop_requested', 'job_id': job_id,
            'message': 'Stop requested - will halt before next message'
        })
    except Exception:
        pass
    log(f'   stop_event SET for {job_id}')
    return jsonify({'success': True, 'job_id': job_id, 'action': 'stop'})


@app.route('/pause/<job_id>', methods=['POST'])
def pause_job(job_id):
    """Pause a running job. Worker will block before next message until resumed.
    After 30 minutes of pause, the job will auto-stop to avoid stale Chrome Test session."""
    log(f'⏸ PAUSE requested for job {job_id}')
    if job_id not in _jobs:
        log(f'   FAIL: unknown job_id (active: {list(_jobs.keys())})')
        return jsonify({'error': 'unknown job_id', 'active_jobs': list(_jobs.keys())}), 404
    pe = _jobs[job_id].get('pause_event')
    if pe is None:
        log(f'   FAIL: pause not supported (job has no pause_event)')
        return jsonify({'error': 'pause not supported for this job'}), 400
    pe.set()
    log(f'   pause_event SET for {job_id} (will take effect before next msg)')
    # Push event to SSE queue for immediate UI feedback
    try:
        _jobs[job_id]['queue'].put_nowait({
            'type': 'pause_requested', 'job_id': job_id,
            'message': 'Pause requested - will halt before next message'
        })
    except Exception:
        pass
    return jsonify({'success': True, 'job_id': job_id, 'action': 'pause',
                    'auto_stop_after_minutes': 30})


@app.route('/resume/<job_id>', methods=['POST'])
def resume_job(job_id):
    """Resume a paused job."""
    log(f'▶ RESUME requested for job {job_id}')
    if job_id not in _jobs:
        log(f'   FAIL: unknown job_id (active: {list(_jobs.keys())})')
        return jsonify({'error': 'unknown job_id', 'active_jobs': list(_jobs.keys())}), 404
    pe = _jobs[job_id].get('pause_event')
    if pe is None:
        return jsonify({'error': 'pause not supported for this job'}), 400
    was_paused = pe.is_set()
    pe.clear()
    log(f'   pause_event CLEARED for {job_id} (was_paused={was_paused})')
    return jsonify({'success': True, 'job_id': job_id, 'action': 'resume',
                    'was_paused': was_paused})


@app.route('/selectors', methods=['GET'])
def get_selectors():
    """Return current XPath/CSS selectors so user can inspect/edit."""
    return jsonify({
        'selectors': SELECTORS,
        'config_file': CONFIG_FILE,
        'note': ('To update selectors when WA Web changes, edit config.json '
                 'and add a "selectors" object. The daemon merges it with defaults.')
    })


@app.route('/selectors', methods=['POST'])
def update_selectors():
    """Update XPath/CSS selectors at runtime + persist to config.json."""
    global SELECTORS
    try:
        data = request.get_json(force=True)
        new_sel = data.get('selectors', {})
        if not isinstance(new_sel, dict):
            return jsonify({'error': 'selectors must be a dict'}), 400
        # Merge with current
        SELECTORS.update(new_sel)
        # Persist
        cfg = load_config()
        cfg['selectors'] = SELECTORS
        save_config(cfg)
        log(f'selectors updated: {list(new_sel.keys())}')
        return jsonify({'success': True, 'selectors': SELECTORS})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/diagnostics', methods=['POST'])
def diagnostics():
    """
    WA Blaster-style diagnostic test. Tests each XPath/CSS selector against the
    current WA Web state and reports which are FOUND / NOT FOUND.
    The user is expected to be on a chat with text input visible for full test.
    """
    try:
        driver = get_driver()
        if not is_logged_in(driver):
            return jsonify({'error': 'WhatsApp not logged in'}), 400

        results = []
        # Test each selector pair
        base_names = sorted(set(
            k.replace('_Alt', '') for k in SELECTORS.keys()
        ))
        for base in base_names:
            primary, alt = get_selector_pair(base)
            primary_found = False
            alt_found = False
            tag_info = ''
            try:
                if primary:
                    by, value = _xpath_or_css(driver, primary)
                    elements = driver.find_elements(by, value)
                    if elements:
                        primary_found = True
                        try:
                            tag = elements[0].tag_name
                            cls = (elements[0].get_attribute('class') or '')[:80]
                            tag_info = f'<{tag}> class="{cls}"'
                        except Exception:
                            pass
            except Exception as e:
                tag_info = f'error: {e}'
            try:
                if alt and alt != primary:
                    by, value = _xpath_or_css(driver, alt)
                    if driver.find_elements(by, value):
                        alt_found = True
            except Exception:
                pass

            results.append({
                'name': base,
                'primary': primary,
                'primary_found': primary_found,
                'alt': alt,
                'alt_found': alt_found,
                'tag_info': tag_info,
            })

        # Get WA Web version
        wa_version = ''
        try:
            wa_version = driver.execute_script(
                "return window.Debug && window.Debug.VERSION ? window.Debug.VERSION : 'unknown';"
            )
        except Exception:
            pass

        return jsonify({
            'wa_web_version': wa_version,
            'results': results,
            'summary': {
                'total': len(results),
                'primary_ok': sum(1 for r in results if r['primary_found']),
                'alt_ok': sum(1 for r in results if r['alt_found']),
                'either_ok': sum(1 for r in results if r['primary_found'] or r['alt_found']),
            }
        })
    except Exception as e:
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Gracefully close Chrome Test and shut down the daemon."""
    shutdown_driver()
    # Flask dev server shutdown
    func = request.environ.get('werkzeug.server.shutdown')
    if func:
        func()
    return jsonify({'success': True})


# ─── Main ───────────────────────────────────────────────────────────
def main():
    log('=' * 60)
    log('ARAD Bulk WhatsApp Sender Daemon')
    log('=' * 60)
    log(f'Chrome Test:   {CHROME_PATH}')
    log(f'Profile:       {PROFILE_DIR}')
    log(f'ChromeDriver:  {CHROMEDRIVER_PATH}')
    log(f'Log file:      {LOG_FILE}')
    log(f'Listening on:  http://127.0.0.1:8766')
    log('=' * 60)

    if not os.path.exists(CHROME_PATH):
        log(f'⚠ Chrome Test not found at: {CHROME_PATH}')
        log('  Edit config.json or set CHROME_PATH env var')
    if not os.path.exists(CHROMEDRIVER_PATH):
        log(f'⚠ ChromeDriver not found at: {CHROMEDRIVER_PATH}')
        log('  Run install.ps1 to download it automatically')

    try:
        app.run(host='127.0.0.1', port=8766, debug=False, threaded=True, use_reloader=False)
    except KeyboardInterrupt:
        log('shutting down...')
    finally:
        shutdown_driver()
        log('daemon stopped')


if __name__ == '__main__':
    main()
