#!/usr/bin/env python3
"""
ARAD Bulk WhatsApp Sender Daemon
================================
HTTP server on localhost:8766 that sends WhatsApp messages in bulk via a
persistent Chrome for Testing session, WITHOUT any user activation dialogs.

Architecture (two processes):

    ┌─────────────────────────┐        line-delimited JSON-RPC        ┌──────────────────────────┐
    │  arad_bulk_daemon.py     │   stdin  ──{"cmd":"send_message"}──▶  │  arad_driver_worker.py   │
    │  (THIS FILE)             │   stdout ◀──{"success": true}────────  │  (Selenium subprocess)   │
    │                          │   stderr ──(logs)──▶ daemon log file  │                          │
    │  • Flask HTTP server     │                                       │  • OWNS the WebDriver    │
    │  • job orchestration     │                                       │  • Chrome for Testing    │
    │  • SSE progress / pause  │                                       │  • all WA Web automation │
    │  • NO Selenium at all    │                                       │  • all XPath selectors   │
    └─────────────────────────┘                                       └──────────────────────────┘

Why two processes? Creating webdriver.Chrome() from inside a Flask request
handler reliably fails on Windows with "session not created: Chrome instance
exited" — Flask/werkzeug mutate process state in a way that breaks chromedriver's
bootstrap. The cure is to keep ALL Selenium code in a process that never runs
Flask. See arad_driver_worker.py for the worker side.

The daemon keeps everything that does NOT touch Selenium: HTTP endpoints, the
bulk-send loop (delays, pause/stop, SSE progress), attachment download/decode,
and the worker subprocess lifecycle. Each driver operation is a one-line RPC.

Architecture (the request path that the ARAD extension depends on):
  ARAD app (in regular Chrome) → Extension → POST localhost:8766/bulk_send
  → this daemon → worker subprocess → Selenium → Chrome for Testing → WA Web

Endpoints (unchanged contract — the extension depends on these):
  GET  /status              daemon status + driver/login state
  POST /open_whatsapp       open Chrome Test + WhatsApp (first-time QR scan)
  POST /bulk_send           start a bulk job, returns {job_id}
  GET  /progress/<id>       SSE stream of progress events
  POST /stop/<id>           stop a running job
  POST /pause/<id>          pause a running job
  POST /resume/<id>         resume a paused job
  GET  /selectors           inspect current XPath/CSS selectors
  POST /selectors           update selectors at runtime (persisted to config.json)
  POST /diagnostics         test every selector against current WA Web state
  POST /shutdown            close Chrome Test + shut the daemon down

Requires: python 3.8+, flask, flask-cors, requests, selenium (in the worker)
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
import subprocess

try:
    from flask import Flask, request, jsonify, Response, stream_with_context
    from flask_cors import CORS
    import requests
except ImportError as e:
    print(f"FATAL: missing Python package: {e}", file=sys.stderr)
    print("Run: pip install flask flask-cors requests", file=sys.stderr)
    sys.exit(1)


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

# The Selenium worker lives next to this file. install.ps1 copies BOTH files to
# the runtime dir, so this sibling lookup resolves in production too.
WORKER_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             'arad_driver_worker.py')

DEFAULT_DELAY_MIN_S = 20            # min seconds between messages (random)
DEFAULT_DELAY_MAX_S = 40            # max seconds between messages (random)
DEFAULT_ATTACHMENT_UPLOAD_DELAY_S = 4   # wait after click_send for attachment upload
DEFAULT_ACTION_DELAY_S = 1.0        # wait after typing/before send (general)
DAILY_CAP = 150                     # anti-ban cap per 24h
PER_MINUTE_CAP = 3

# RPC timeouts (seconds). A single message can take up to ~45s for chat load
# plus attachment upload, so send_message gets generous headroom.
RPC_TIMEOUT_DEFAULT = 30
RPC_TIMEOUT_SEND = 120
RPC_TIMEOUT_LOGIN = 200


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


# ─── Config (daemon only needs the paths for /status + startup checks) ─
def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            log(f'config load failed: {e}')
    return {}


CONFIG = load_config()
CHROME_PATH = CONFIG.get('chrome_path', DEFAULT_CHROME_PATH)
PROFILE_DIR = CONFIG.get('profile_dir', DEFAULT_PROFILE_DIR)
CHROMEDRIVER_PATH = CONFIG.get('chromedriver_path', DEFAULT_CHROMEDRIVER)


# ─── Worker RPC client ──────────────────────────────────────────────
# Talks to arad_driver_worker.py over its stdin/stdout. The protocol is
# request/response: every command carries a monotonically increasing id and the
# worker echoes it back. A background reader thread drains the worker's stdout
# into a queue so we can apply per-call timeouts (Windows can't select() on
# pipes). All calls are serialized by a lock, so only one command is ever in
# flight; the id check discards any stale response left over from a timed-out
# earlier call, keeping the channel from desyncing.

class WorkerError(Exception):
    pass


class WorkerBusy(Exception):
    """Raised by try_call when the worker is busy with another command."""
    pass


_DEAD = object()  # sentinel pushed onto the response queue when the worker dies


class WorkerClient:
    def __init__(self, script_path):
        self._script = script_path
        self._lock = threading.Lock()
        self._proc = None
        self._responses = None
        self._reader = None
        self._stderr_f = None
        self._next_id = 1

    # ── lifecycle ──────────────────────────────────────────────────
    def _spawn(self):
        """(Re)spawn the worker subprocess and its stdout reader thread."""
        self._close_proc()

        # Worker stderr → daemon log file (the worker writes its human-readable
        # logs there; stdout stays clean for JSON responses).
        try:
            self._stderr_f = open(LOG_FILE, 'a', encoding='utf-8', errors='replace')
        except Exception:
            self._stderr_f = subprocess.DEVNULL

        creationflags = 0
        if os.name == 'nt':
            # Don't pop a console window for the worker.
            creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

        log(f'spawning worker: {self._script}')
        self._proc = subprocess.Popen(
            [sys.executable, self._script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_f,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,  # line-buffered
            creationflags=creationflags,
        )

        # Fresh queue per spawn so stale responses / _DEAD sentinels from a
        # previous worker can't poison the new one.
        self._responses = queue.Queue()
        q = self._responses
        proc = self._proc
        self._reader = threading.Thread(
            target=self._read_loop, args=(proc, q), daemon=True
        )
        self._reader.start()

    def _read_loop(self, proc, q):
        """Drain the worker's stdout, putting each parsed JSON line on q."""
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    q.put(json.loads(line))
                except Exception:
                    # Non-JSON on stdout shouldn't happen (worker logs to
                    # stderr); log and ignore so it can't break a call.
                    log(f'worker emitted non-JSON on stdout: {line[:200]}')
        except Exception as e:
            log(f'worker reader error: {e}')
        finally:
            q.put(_DEAD)

    def _close_proc(self):
        if self._proc is not None:
            try:
                if self._proc.poll() is None:
                    self._proc.terminate()
            except Exception:
                pass
            self._proc = None
        if self._stderr_f not in (None, subprocess.DEVNULL):
            try:
                self._stderr_f.close()
            except Exception:
                pass
        self._stderr_f = None

    def _ensure_alive(self):
        if self._proc is None or self._proc.poll() is not None:
            self._spawn()

    def start(self):
        with self._lock:
            self._ensure_alive()

    def stop(self):
        """Best-effort: ask the worker to quit, then terminate the process."""
        with self._lock:
            proc = self._proc
            if proc is not None and proc.poll() is None:
                try:
                    proc.stdin.write(json.dumps({'id': -1, 'cmd': 'shutdown'}) + '\n')
                    proc.stdin.flush()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=10)
                except Exception:
                    pass
            self._close_proc()

    # ── calls ──────────────────────────────────────────────────────
    def _call_locked(self, cmd, timeout):
        """Send a command and wait for its response. Caller holds self._lock."""
        self._ensure_alive()
        req_id = self._next_id
        self._next_id += 1
        payload = dict(cmd)
        payload['id'] = req_id
        try:
            self._proc.stdin.write(json.dumps(payload, ensure_ascii=True) + '\n')
            self._proc.stdin.flush()
        except Exception as e:
            raise WorkerError(f'failed to send command {cmd.get("cmd")}: {e}')

        deadline = time.time() + timeout
        q = self._responses
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise WorkerError(
                    f'worker timeout after {timeout}s for cmd {cmd.get("cmd")}'
                )
            try:
                resp = q.get(timeout=remaining)
            except queue.Empty:
                raise WorkerError(
                    f'worker timeout after {timeout}s for cmd {cmd.get("cmd")}'
                )
            if resp is _DEAD:
                raise WorkerError('worker process died')
            if resp.get('id') == req_id:
                return resp
            # Stale response from an earlier (timed-out) call — discard.
            log(f'discarding stale worker response id={resp.get("id")} '
                f'(waiting for {req_id})')

    def call(self, cmd, timeout=RPC_TIMEOUT_DEFAULT):
        with self._lock:
            return self._call_locked(cmd, timeout)

    def try_call(self, cmd, timeout=RPC_TIMEOUT_DEFAULT):
        """Like call(), but raises WorkerBusy instead of blocking if the worker
        is already handling another command. Used by /status so it stays snappy
        during a bulk send."""
        if not self._lock.acquire(blocking=False):
            raise WorkerBusy()
        try:
            return self._call_locked(cmd, timeout)
        finally:
            self._lock.release()


worker = WorkerClient(WORKER_SCRIPT)

# Last known driver/login state, refreshed on every successful status probe so
# /status can answer instantly (from cache) while a bulk job monopolizes the
# worker channel.
_last_known = {'driver_alive': False, 'wa_logged_in': False}

_job_lock = threading.Lock()  # only one bulk job at a time


# ─── Attachment resolution (daemon-side I/O; no Selenium needed) ─────
def _resolve_attachment_to_path(attachment_meta, employee_idx, att_idx):
    """
    Convert an attachment meta dict to a local file path the worker can upload.

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


# ─── Bulk job runner ────────────────────────────────────────────────
_jobs = {}  # job_id -> { queue, thread, status }


def run_bulk_job(job_id, employees, template, attachment_path,
                 delay_min, delay_max,
                 attachment_upload_delay, action_delay,
                 stop_event):
    """
    Runs in its own thread. Drives the per-recipient loop and pushes progress to
    jobs[job_id]['queue']. Each actual WhatsApp send is delegated to the worker
    via a single send_message RPC; everything else (delays, pause, stop, SSE) is
    handled here. Stop takes effect between messages.
    """
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

    # ─── Ensure driver + login + WA Web readiness (all via worker) ───
    try:
        prep = worker.call({'cmd': 'prepare_bulk'}, timeout=RPC_TIMEOUT_LOGIN)
        if not prep.get('success'):
            push({'type': 'error', 'message': f'driver init failed: {prep.get("error", "unknown")}'})
            return
        _last_known['driver_alive'] = True
        _last_known['wa_logged_in'] = bool(prep.get('logged_in'))

        if not prep.get('logged_in'):
            push({'type': 'need_login', 'message': 'WhatsApp not logged in. Scan QR in Chrome Test.'})
            login = worker.call({'cmd': 'wait_for_login', 'timeout_s': 180},
                                timeout=RPC_TIMEOUT_LOGIN)
            if not login.get('logged_in'):
                push({'type': 'error', 'message': 'login timeout'})
                return
            _last_known['wa_logged_in'] = True
            push({'type': 'logged_in'})

        # ─── QUICK WA Web check (don't wait long) ────────────────────
        # The first message will trigger a full WA Web load anyway; subsequent
        # messages use the fast search path once WA finishes loading.
        if prep.get('wa_ready'):
            log('═══ WA Web already loaded - search path will be fast ═══')
            push({'type': 'wa_ready'})
        else:
            log('═══ WA Web not fully loaded yet - first msg will use URL ═══')
            push({'type': 'wa_loading'})
    except WorkerError as e:
        push({'type': 'error', 'message': f'driver/login failed: {e}'})
        return
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

            # Delegate the actual WhatsApp send to the worker (one RPC).
            result = worker.call({
                'cmd': 'send_message',
                'phone': phone,
                'message': rendered,
                'file_paths': file_paths_to_send,
                'attachment_upload_delay': attachment_upload_delay,
                'action_delay': action_delay,
            }, timeout=RPC_TIMEOUT_SEND)

            if not result.get('success'):
                raise Exception(result.get('error', 'send failed'))

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
            # ─── Handle user stop mid-message specially ──────────────────
            # If the user pressed Stop while the worker was mid-send, treat the
            # "aborted by user" error (or a set stop flag) as a clean stop, not
            # a failure, and exit the loop.
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
    """Daemon status + WA login state. Stays responsive during a bulk job by
    falling back to the last-known state when the worker channel is busy."""
    driver_alive = _last_known['driver_alive']
    logged_in = _last_known['wa_logged_in']
    try:
        st = worker.try_call({'cmd': 'status'}, timeout=10)
        driver_alive = bool(st.get('driver_alive'))
        logged_in = bool(st.get('wa_logged_in'))
        _last_known['driver_alive'] = driver_alive
        _last_known['wa_logged_in'] = logged_in
    except WorkerBusy:
        # A job is using the worker — report cached state instead of blocking.
        pass
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
        result = worker.call({'cmd': 'ensure_chrome_open'}, timeout=RPC_TIMEOUT_LOGIN)
        if not result.get('success'):
            return jsonify({'success': False, 'error': result.get('error', 'unknown'),
                            'trace': result.get('trace', '')}), 500
        _last_known['driver_alive'] = True
        _last_known['wa_logged_in'] = bool(result.get('logged_in'))
        return jsonify({
            'success': True,
            'logged_in': bool(result.get('logged_in'))
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

        def worker_thread():
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

        t = threading.Thread(target=worker_thread, daemon=True)
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
    try:
        result = worker.call({'cmd': 'get_selectors'}, timeout=RPC_TIMEOUT_DEFAULT)
        return jsonify({
            'selectors': result.get('selectors', {}),
            'config_file': result.get('config_file', CONFIG_FILE),
            'note': ('To update selectors when WA Web changes, edit config.json '
                     'and add a "selectors" object. The daemon merges it with defaults.')
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/selectors', methods=['POST'])
def update_selectors():
    """Update XPath/CSS selectors at runtime + persist to config.json."""
    try:
        data = request.get_json(force=True)
        new_sel = data.get('selectors', {})
        if not isinstance(new_sel, dict):
            return jsonify({'error': 'selectors must be a dict'}), 400
        result = worker.call({'cmd': 'set_selectors', 'selectors': new_sel},
                             timeout=RPC_TIMEOUT_DEFAULT)
        if not result.get('success'):
            return jsonify({'error': result.get('error', 'update failed')}), 500
        log(f'selectors updated: {list(new_sel.keys())}')
        return jsonify({'success': True, 'selectors': result.get('selectors', {})})
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
        result = worker.call({'cmd': 'diagnostics'}, timeout=RPC_TIMEOUT_LOGIN)
        if result.get('code') == 400:
            return jsonify({'error': result.get('error', 'WhatsApp not logged in')}), 400
        if not result.get('ok', False) and result.get('error'):
            return jsonify({'error': result.get('error'), 'trace': result.get('trace', '')}), 500
        return jsonify({
            'wa_web_version': result.get('wa_web_version', ''),
            'results': result.get('results', []),
            'summary': result.get('summary', {}),
        })
    except Exception as e:
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/shutdown', methods=['POST'])
def shutdown():
    """Gracefully close Chrome Test and shut down the daemon."""
    try:
        worker.stop()  # tells worker to quit the driver, then terminates it
    except Exception as e:
        log(f'worker shutdown error: {e}')
    # Shut down the werkzeug server from a background thread so this request can
    # return cleanly first.
    srv = _server
    if srv is not None:
        threading.Thread(target=lambda: (time.sleep(0.3), srv.shutdown()),
                         daemon=True).start()
    return jsonify({'success': True})


# ─── Main ───────────────────────────────────────────────────────────
_server = None  # werkzeug server instance (set in main, used by /shutdown)


def main():
    global _server
    log('=' * 60)
    log('ARAD Bulk WhatsApp Sender Daemon')
    log('=' * 60)
    log(f'Chrome Test:   {CHROME_PATH}')
    log(f'Profile:       {PROFILE_DIR}')
    log(f'ChromeDriver:  {CHROMEDRIVER_PATH}')
    log(f'Worker script: {WORKER_SCRIPT}')
    log(f'Log file:      {LOG_FILE}')
    log(f'Listening on:  http://127.0.0.1:8766')
    log('=' * 60)

    if not os.path.exists(CHROME_PATH):
        log(f'⚠ Chrome Test not found at: {CHROME_PATH}')
        log('  Edit config.json or set CHROME_PATH env var')
    if not os.path.exists(CHROMEDRIVER_PATH):
        log(f'⚠ ChromeDriver not found at: {CHROMEDRIVER_PATH}')
        log('  Run install.ps1 to download it automatically')
    if not os.path.exists(WORKER_SCRIPT):
        log(f'⚠ Worker script not found at: {WORKER_SCRIPT}')
        log('  The daemon cannot drive Chrome without it - reinstall.')

    # Spawn the worker subprocess up-front (cheap - no Chrome yet). Chrome opens
    # on demand when /open_whatsapp or the first bulk send arrives.
    try:
        log('starting driver worker subprocess...')
        worker.start()
        # Confirm the worker is alive and answering on the RPC channel.
        worker.call({'cmd': 'ping'}, timeout=15)
        log('worker ready')
    except Exception as e:
        log(f'worker startup failed (will retry on first request): {e}')

    try:
        from werkzeug.serving import make_server
        # threaded=True so SSE progress streams don't block control endpoints
        # (/stop, /pause, /status) and concurrent requests. The Selenium "session
        # not created" bug that previously forced single-threaded mode is gone:
        # all driver work happens in the isolated worker process now.
        _server = make_server('127.0.0.1', 8766, app, threaded=True)
        log('serving via werkzeug.make_server (threaded)')
        _server.serve_forever()
    except KeyboardInterrupt:
        log('shutting down...')
    finally:
        try:
            worker.stop()
        except Exception:
            pass
        log('daemon stopped')


if __name__ == '__main__':
    main()
