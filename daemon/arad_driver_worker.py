#!/usr/bin/env python3
"""
ARAD WhatsApp Driver Worker
===========================
A standalone subprocess that OWNS the Selenium WebDriver and the Chrome for
Testing session. It exists for one reason: creating webdriver.Chrome() from
inside a Flask request handler reliably fails on Windows with
"session not created: Chrome instance exited". The root cause is Flask/werkzeug
mutating the process state (signal handlers, threading, inherited handles) in a
way that breaks chromedriver's child-process bootstrap.

The fix is architectural: keep ALL Selenium code in a process that NEVER runs
Flask. arad_bulk_daemon.py (the Flask server) spawns this worker once and talks
to it over a tiny line-delimited JSON-RPC protocol on stdin/stdout:

    stdin  : one JSON request per line  -> {"id": 7, "cmd": "send_message", ...}
    stdout : one JSON response per line  -> {"id": 7, "success": true}
    stderr : human-readable log lines (redirected to the daemon log file)

stdout carries ONLY JSON responses (one per request, echoing the request id).
Everything human-readable goes to stderr so the channel stays clean.

This process is single-threaded: it reads one command, runs it to completion,
writes one response, and loops. The daemon serializes its calls, so there is
never more than one command in flight. That means webdriver.Chrome() is always
created on this process's main thread, with no Flask anywhere in sight.
"""

import os
import sys
import json
import time
import re
import tempfile
import traceback
import subprocess
from urllib.parse import quote

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC  # noqa: F401
from selenium.common.exceptions import (
    TimeoutException,  # noqa: F401
    NoSuchElementException,
    WebDriverException,  # noqa: F401
)

# pyperclip is optional - enables fast paste-from-clipboard instead of typing.
try:
    import pyperclip
    HAS_PYPERCLIP = True
except ImportError:
    HAS_PYPERCLIP = False


# ─── Configuration ────────────────────────────────────────────────
# These paths mirror arad_bulk_daemon.py. Both processes read the same
# config.json (the daemon owns writes via the /selectors endpoint, which forwards
# a set_selectors command to this worker so the on-disk copy stays authoritative).
DEFAULT_CHROME_PATH = r"C:\Users\liorg\AppData\Local\SeleniumBasic\chrome-win64\chrome.exe"
DEFAULT_PROFILE_DIR = os.path.join(
    os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
    'AradBulkDaemon', 'profile'
)
DEFAULT_CHROMEDRIVER = os.path.join(
    os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
    'AradBulkDaemon', 'chromedriver.exe'
)
CONFIG_FILE = os.path.join(
    os.environ.get('LOCALAPPDATA', tempfile.gettempdir()),
    'AradBulkDaemon', 'config.json'
)

DEFAULT_ATTACHMENT_UPLOAD_DELAY_S = 4   # wait after click_send for attachment upload
DEFAULT_ACTION_DELAY_S = 1.0            # wait after typing/before send (general)


# ─── Logging (stderr only - stdout is reserved for JSON responses) ──
def log(msg, *args):
    line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] [worker] {msg}'
    if args:
        line += ' ' + ' '.join(str(a) for a in args)
    try:
        sys.stderr.write(line + '\n')
        sys.stderr.flush()
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
# WhatsApp Web changes its DOM frequently. Selectors live in config.json so the
# user can update them when WA Web changes - WITHOUT modifying code. Each selector
# has a primary version + alt fallback; we try primary first, then alt.
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
# No lock needed: this process handles one command at a time on the main thread.
_driver = None


def _kill_orphan_chrome_test():
    """
    Kill any chrome.exe / chromedriver.exe processes that are using our profile dir
    OR running from our Chrome Test installation.

    Happens when the daemon was restarted (or crashed) but Chrome Test wasn't closed -
    Windows locks the user-data-dir and new webdriver.Chrome() fails with
    "session not created: Chrome instance exited". This is THE most common cause
    of failed bulk-send attempts after a daemon restart.

    Uses PowerShell + Get-CimInstance (wmic is deprecated on Win11). Matches on
    BOTH ExecutablePath and CommandLine so we catch orphan Chrome whose command
    line doesn't include --user-data-dir (renderers, GPU helpers, etc.).
    """
    if os.name != 'nt':
        return

    # Pre-compute path fragments that uniquely identify OUR processes
    chrome_test_dir = os.path.dirname(os.path.dirname(CHROME_PATH))  # ...\chrome-win64 parent
    chromedriver_dir = os.path.dirname(CHROMEDRIVER_PATH)            # ...\AradBulkDaemon
    profile_dir = PROFILE_DIR

    # Escape single quotes for PowerShell single-quoted string
    def esc(p): return p.replace("'", "''")

    ps_cmd = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -in @('chrome.exe', 'chromedriver.exe') -and ( "
        f"($_.ExecutablePath -like '*{esc(chrome_test_dir)}*') -or "
        f"($_.ExecutablePath -like '*{esc(chromedriver_dir)}*') -or "
        f"($_.CommandLine -like '*{esc(profile_dir)}*') -or "
        f"($_.CommandLine -like '*{esc(chrome_test_dir)}*') "
        ") } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId } catch {} }"
    )
    killed = []
    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps_cmd],
            capture_output=True, text=True, timeout=15
        )
        for line in result.stdout.splitlines():
            pid = line.strip()
            if pid.isdigit():
                killed.append(pid)
    except Exception as e:
        log(f'_kill_orphan_chrome_test failed: {e}')

    if killed:
        log(f'killed {len(killed)} orphan chrome/chromedriver PID(s): {killed}')
        time.sleep(1.5)  # let Windows release the profile lock


def get_driver():
    """
    Get or create the Selenium driver. Creates if needed, reuses if alive.
    Because this runs on the worker's main thread (never inside Flask), the
    webdriver.Chrome() bootstrap succeeds reliably.
    """
    global _driver
    if _driver is not None:
        try:
            _ = _driver.current_url  # ping
            return _driver
        except Exception as e:
            log(f'existing driver is dead: {e}, recreating')
            try:
                _driver.quit()
            except Exception:
                pass
            _driver = None

    log(f'launching Chrome Test: {CHROME_PATH}')
    log(f'profile dir: {PROFILE_DIR}')
    os.makedirs(PROFILE_DIR, exist_ok=True)

    options = Options()
    options.binary_location = CHROME_PATH
    options.add_argument(f'--user-data-dir={PROFILE_DIR}')
    options.add_argument('--no-sandbox')
    # NOTE: prefs dict with protocol_handler.excluded_schemes crashed Chrome 150
    # at startup ("session not created: Chrome instance exited"). Removed.

    # Kill any orphan Chrome Test that may be locking our profile
    # (happens when daemon was restarted without closing Chrome Test)
    _kill_orphan_chrome_test()

    service = Service(CHROMEDRIVER_PATH, log_output=subprocess.DEVNULL)
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

    _driver.get('https://web.whatsapp.com')
    log('navigated to web.whatsapp.com')
    return _driver


def shutdown_driver():
    global _driver
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
    Uses XPathSearchInputField with XPathSearchInputField_Alt fallback.
    Selectors are loaded from config.json so they can be updated when WA Web
    changes - without code changes.
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

    stop_event - optional threading.Event. If set during chat-load wait, the
                 operation aborts fast (raises 'aborted by user').
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


# ─── Diagnostics ────────────────────────────────────────────────────
def run_diagnostics(driver):
    """
    WA Blaster-style diagnostic test. Tests each XPath/CSS selector against the
    current WA Web state and reports which are FOUND / NOT FOUND.
    Returns the full result dict (same shape the daemon returns to the extension).
    """
    results = []
    base_names = sorted(set(k.replace('_Alt', '') for k in SELECTORS.keys()))
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

    wa_version = ''
    try:
        wa_version = driver.execute_script(
            "return window.Debug && window.Debug.VERSION ? window.Debug.VERSION : 'unknown';"
        )
    except Exception:
        pass

    return {
        'wa_web_version': wa_version,
        'results': results,
        'summary': {
            'total': len(results),
            'primary_ok': sum(1 for r in results if r['primary_found']),
            'alt_ok': sum(1 for r in results if r['alt_found']),
            'either_ok': sum(1 for r in results if r['primary_found'] or r['alt_found']),
        }
    }


# ─── Command handlers (JSON-RPC over stdin/stdout) ──────────────────
# Each handler takes the request dict and returns a response dict. The 'id' is
# added by the main loop. A '_exit' key in the response signals the loop to stop.

def cmd_ping(req):
    return {'ok': True, 'pong': True}


def cmd_status(req):
    """Lightweight status probe: is the driver alive and is WA logged in."""
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
    return {'ok': True, 'driver_alive': driver_alive, 'wa_logged_in': logged_in}


def cmd_ensure_chrome_open(req):
    """Open Chrome Test + WhatsApp (creates the driver if needed)."""
    driver = get_driver()
    return {'ok': True, 'success': True,
            'logged_in': is_logged_in(driver, timeout_s=2)}


def cmd_is_logged_in(req):
    driver = get_driver()
    return {'ok': True, 'logged_in': is_logged_in(driver, timeout_s=req.get('timeout_s', 5))}


def cmd_wait_for_login(req):
    driver = get_driver()
    ok = wait_for_login(driver, timeout_s=req.get('timeout_s', 120))
    return {'ok': True, 'logged_in': ok}


def cmd_prepare_bulk(req):
    """
    Ensure the driver exists and report login + WA-Web-ready state.
    Called once at the start of a bulk job so the daemon can decide whether to
    prompt for QR and whether the fast search path is immediately available.
    """
    driver = get_driver()
    logged_in = is_logged_in(driver)
    wa_ready = False
    if logged_in:
        try:
            wa_ready = bool(find_search_box(driver))
        except Exception:
            wa_ready = False
    return {'ok': True, 'success': True, 'logged_in': logged_in, 'wa_ready': wa_ready}


def cmd_send_message(req):
    """Send ONE message. The daemon's bulk loop calls this per recipient."""
    driver = get_driver()
    try:
        send_single_message(
            driver,
            req.get('phone', ''),
            req.get('message', ''),
            file_paths=req.get('file_paths'),
            attachment_upload_delay=req.get('attachment_upload_delay', DEFAULT_ATTACHMENT_UPLOAD_DELAY_S),
            action_delay=req.get('action_delay', DEFAULT_ACTION_DELAY_S),
            stop_event=None,
        )
        return {'ok': True, 'success': True}
    except Exception as e:
        return {'ok': True, 'success': False, 'error': str(e)[:300]}


def cmd_get_selectors(req):
    return {'ok': True, 'selectors': SELECTORS, 'config_file': CONFIG_FILE}


def cmd_set_selectors(req):
    """Update selectors at runtime + persist to config.json."""
    global SELECTORS
    new_sel = req.get('selectors', {})
    if not isinstance(new_sel, dict):
        return {'ok': False, 'error': 'selectors must be a dict'}
    SELECTORS.update(new_sel)
    cfg = load_config()
    cfg['selectors'] = SELECTORS
    save_config(cfg)
    log(f'selectors updated: {list(new_sel.keys())}')
    return {'ok': True, 'success': True, 'selectors': SELECTORS}


def cmd_diagnostics(req):
    driver = get_driver()
    if not is_logged_in(driver):
        return {'ok': False, 'code': 400, 'error': 'WhatsApp not logged in'}
    return dict(ok=True, **run_diagnostics(driver))


def cmd_shutdown(req):
    shutdown_driver()
    return {'ok': True, 'success': True, '_exit': True}


HANDLERS = {
    'ping': cmd_ping,
    'status': cmd_status,
    'ensure_chrome_open': cmd_ensure_chrome_open,
    'is_logged_in': cmd_is_logged_in,
    'wait_for_login': cmd_wait_for_login,
    'prepare_bulk': cmd_prepare_bulk,
    'send_message': cmd_send_message,
    'get_selectors': cmd_get_selectors,
    'set_selectors': cmd_set_selectors,
    'diagnostics': cmd_diagnostics,
    'shutdown': cmd_shutdown,
}


def _write_response(resp):
    """Write a single JSON response line to stdout and flush."""
    try:
        sys.stdout.write(json.dumps(resp, ensure_ascii=True) + '\n')
        sys.stdout.flush()
    except Exception as e:
        # If we can't write to stdout the daemon will time out and respawn us.
        log(f'failed to write response: {e}')


def main():
    # Force UTF-8 on both channels (Hebrew logs on stderr; JSON is ASCII-safe).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    log('=' * 60)
    log('ARAD WhatsApp Driver Worker started')
    log(f'Chrome Test:   {CHROME_PATH}')
    log(f'Profile:       {PROFILE_DIR}')
    log(f'ChromeDriver:  {CHROMEDRIVER_PATH}')
    log('=' * 60)

    # Read one JSON command per line until stdin closes (daemon exits) or a
    # shutdown command arrives.
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:
            _write_response({'id': None, 'ok': False, 'error': f'bad json: {e}'})
            continue

        rid = req.get('id')
        cmd = req.get('cmd')
        handler = HANDLERS.get(cmd)
        if handler is None:
            _write_response({'id': rid, 'ok': False, 'error': f'unknown cmd: {cmd}'})
            continue

        try:
            resp = handler(req)
        except Exception as e:
            log(f'command {cmd} crashed: {e}')
            log(traceback.format_exc())
            resp = {'ok': False, 'error': str(e), 'trace': traceback.format_exc()}

        exit_after = bool(resp.pop('_exit', False))
        resp['id'] = rid
        _write_response(resp)
        if exit_after:
            break

    shutdown_driver()
    log('worker exiting')


if __name__ == '__main__':
    main()
