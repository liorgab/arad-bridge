// ═══════════════════════════════════════════════════════════════════
//  ARAD Bridge — OneDrive Module: Background Handler
// ═══════════════════════════════════════════════════════════════════
//  Browse the company's OneDrive/SharePoint folders and pull a document into
//  ARAD — through the session the browser ALREADY has.
//
//  WHY THIS EXISTS, and why it is not Microsoft Graph:
//  Graph would need an app registration in Entra ID, an admin consent and a
//  secret to rotate, and the permission that makes it work unattended
//  (Files.Read.All, application) reads every private drive in the tenant. The
//  extension already runs inside the browser where someone is authenticated,
//  so it inherits exactly their view and nothing more. That boundary is the
//  feature: there is no credential of ours that could ever reach another
//  person's drive.
//
//  Measured on 18/10/26 against shayyazamut-my.sharepoint.com before this was
//  written: the SharePoint REST API answers from the browser session
//  (`/_api/web/GetFolderByServerRelativeUrl(…)/Folders` returned the 19
//  project folders), while the same URL from a server with no cookies is 403.
//  So the cookie jar IS the access, and the extension is where it lives.
//
//  READ-ONLY, deliberately: three message types, all GET. There is no upload,
//  no rename, no delete, and no code path that writes to SharePoint.
//
//  Bytes do not travel through the TOWER page. ONEDRIVE_FETCH downloads the
//  file here and PUTs it straight to a signed URL that ARAD issued; the page
//  only ever sees the result. A 20MB PDF crossing postMessage would be both
//  slow and pointless.
// ═══════════════════════════════════════════════════════════════════

const ALLOWED_HOST = /^https:\/\/[a-z0-9-]+(-my)?\.sharepoint\.com$/i;
const MAX_BYTES = 64 * 1024 * 1024;        // a project document, not a video
const TIMEOUT_MS = 60_000;

// Every call carries the site (the OneDrive/SharePoint web root). Refuse
// anything that is not a SharePoint origin: the page must never be able to
// aim this module at an arbitrary host and have it send the user's cookies.
function checkSite(site) {
  let u;
  try { u = new URL(site); } catch { return null; }
  if (!ALLOWED_HOST.test(u.origin)) return null;
  // keep the path (a personal drive lives at /personal/<upn>), drop the tail
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

async function spFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',                 // the user's own session — the whole point
    headers: { Accept: 'application/json;odata=nometadata', ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

function restPath(site, serverRelativeUrl, tail) {
  // SharePoint wants the path single-quoted, and a quote inside a name is
  // escaped by doubling it. A folder called "it's" is rare and a 500 is ugly.
  const p = String(serverRelativeUrl).replace(/'/g, "''");
  return `${site}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(p)}')${tail}`;
}

// ─── WHOAMI — which identity are we acting as? ────────────────────
// This is the first call of every flow and it is not ceremony. The access may
// come from an "anyone with the link" share, in which case SharePoint answers
// as `urn:spo:tenantanon` and we can see ONLY what that link exposes. That is
// a legitimate way to work — it is how this drive is shared today — but the
// screen has to say so, because a partial listing that looks like a complete
// one is the failure nobody notices.
async function whoami(site) {
  const res = await spFetch(`${site}/_api/web/currentuser`);
  if (!res.ok) return { success: false, error_code: 'HTTP_' + res.status, status: res.status };
  const j = await res.json().catch(() => ({}));
  const login = j.LoginName || '';
  const anonymous = /tenantanon|anonymous/i.test(login);
  const out = {
    success: true,
    anonymous,
    login_name: login,
    title: j.Title || null,
    email: j.Email || null,
    upn: j.UserPrincipalName || null,
  };
  await chrome.storage.local.set({ onedrive_last_whoami: { ...out, at: Date.now(), site } });
  return out;
}

// ─── LIST — folders and files at a path ───────────────────────────
// A path that does not exist answers 200 with an EMPTY collection, exactly
// like a folder that is empty. Caught on the first live run: asking for
// "הסכמי קבלנים" returned success/0 while the real folder is spelled
// "הסכמי קלבנים" — a typo on the drive that would have read as "this project
// has no agreements". So existence is checked, and a missing folder says so.
async function list({ site, path }) {
  const ex = await spFetch(restPath(site, path, '/Exists'));
  if (ex.ok) {
    const j = await ex.json().catch(() => ({}));
    const exists = (j && (j.value ?? j.Exists));
    if (exists === false) return { success: false, error_code: 'NOT_FOUND', path };
  }
  const [fRes, dRes] = await Promise.all([
    spFetch(restPath(site, path, "/Folders?$select=Name,ItemCount,TimeLastModified,ServerRelativeUrl&$top=500")),
    spFetch(restPath(site, path, "/Files?$select=Name,Length,TimeLastModified,ServerRelativeUrl,UniqueId&$top=500")),
  ]);
  if (!fRes.ok && !dRes.ok) {
    return { success: false, error_code: 'HTTP_' + fRes.status, status: fRes.status };
  }
  const fj = fRes.ok ? await fRes.json().catch(() => ({})) : {};
  const dj = dRes.ok ? await dRes.json().catch(() => ({})) : {};
  const folders = (fj.value || []).map((f) => ({
    kind: 'folder', name: f.Name, path: f.ServerRelativeUrl,
    items: f.ItemCount ?? null, modified: f.TimeLastModified || null,
  }));
  const files = (dj.value || []).map((f) => ({
    kind: 'file', name: f.Name, path: f.ServerRelativeUrl,
    size: f.Length ? Number(f.Length) : null, modified: f.TimeLastModified || null,
    uid: f.UniqueId || null,
  }));
  // Folders first, then files; both alphabetical. The drive's own order is
  // not meaningful and a stable order makes a list diffable between runs.
  const coll = new Intl.Collator('he');
  folders.sort((a, b) => coll.compare(a.name, b.name));
  files.sort((a, b) => coll.compare(a.name, b.name));
  return { success: true, path, folders, files, count: folders.length + files.length };
}

// ─── PREVIEW — the bytes back to the page, for looking only ───────
// Lior, 19/10/26: "כפתור הצג … מציג ולא מושך". Viewing and importing are two
// different decisions and the screen must not force the second to allow the
// first — a person looking for the right contract should not leave five copies
// of the wrong ones in ARAD's storage.
//
// So this one returns the bytes to the page as base64 and keeps NOTHING: no
// upload, no storage row, no record. The page turns it into a blob URL for the
// viewer and drops it when the modal closes. Capped well below the import
// limit, because this crosses postMessage and a 60MB drawing would freeze the
// tab — a file above the cap can still be imported, just not previewed.
const PREVIEW_MAX = 15 * 1024 * 1024;

async function previewFile({ site, path }) {
  const p = String(path).replace(/'/g, "''");
  const url = `${site}/_api/web/GetFileByServerRelativeUrl('${encodeURIComponent(p)}')/$value`;
  const res = await spFetch(url, { headers: { Accept: '*/*' } });
  if (!res.ok) return { success: false, error_code: 'HTTP_' + res.status, status: res.status };
  const buf = await res.arrayBuffer();
  if (buf.byteLength > PREVIEW_MAX) {
    return { success: false, error_code: 'TOO_LARGE_TO_PREVIEW', size: buf.byteLength, max: PREVIEW_MAX };
  }
  // chunked, because String.fromCharCode(...bytes) on a 10MB file blows the
  // argument limit and throws RangeError
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return {
    success: true,
    name: path.split('/').pop(),
    size: buf.byteLength,
    content_type: res.headers.get('content-type') || 'application/octet-stream',
    base64: btoa(bin),
  };
}

// ─── FETCH — one file, straight into ARAD's storage ───────────────
// `upload_url` is a signed URL ARAD issued for exactly this object; the bridge
// never learns an ARAD credential and never keeps the bytes.
async function fetchFile({ site, path, upload_url, content_type }) {
  if (!upload_url || !/^https:\/\//i.test(upload_url)) {
    return { success: false, error_code: 'BAD_UPLOAD_URL' };
  }
  const p = String(path).replace(/'/g, "''");
  const url = `${site}/_api/web/GetFileByServerRelativeUrl('${encodeURIComponent(p)}')/$value`;
  const res = await spFetch(url, { headers: { Accept: '*/*' } });
  if (!res.ok) return { success: false, error_code: 'HTTP_' + res.status, status: res.status };

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return { success: false, error_code: 'TOO_LARGE', size: buf.byteLength, max: MAX_BYTES };
  }
  const up = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': content_type || res.headers.get('content-type') || 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!up.ok) {
    const body = await up.text().catch(() => '');
    return { success: false, error_code: 'UPLOAD_FAILED', status: up.status, detail: body.slice(0, 200) };
  }
  return { success: true, name: path.split('/').pop(), size: buf.byteLength, path };
}

// ═══ dispatch ═══════════════════════════════════════════════════════
export default async function onedriveHandler(type, payload = {}) {
  const site = checkSite(payload.site || '');
  if (!site) return { success: false, error_code: 'BAD_SITE' };

  // The path must live under the site we were given. Without this a caller
  // could walk out of the shared subtree by asking for "/personal/someone-else".
  const underSite = (p) => {
    const sitePath = new URL(site).pathname.replace(/\/+$/, '');
    return typeof p === 'string' && p.startsWith(sitePath + '/');
  };

  try {
    switch (type) {
      case 'ONEDRIVE_WHOAMI':
        return await whoami(site);

      case 'ONEDRIVE_LIST':
        if (!underSite(payload.path)) return { success: false, error_code: 'PATH_OUTSIDE_SITE' };
        return await list({ site, path: payload.path });

      case 'ONEDRIVE_PREVIEW':
        if (!underSite(payload.path)) return { success: false, error_code: 'PATH_OUTSIDE_SITE' };
        return await previewFile({ site, path: payload.path });

      case 'ONEDRIVE_FETCH':
        if (!underSite(payload.path)) return { success: false, error_code: 'PATH_OUTSIDE_SITE' };
        return await fetchFile({
          site, path: payload.path,
          upload_url: payload.upload_url, content_type: payload.content_type,
        });

      default:
        return { success: false, error_code: 'UNKNOWN_TYPE', type };
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    return { success: false, error_code: /timeout|abort/i.test(msg) ? 'TIMEOUT' : 'FETCH_FAILED', error: msg };
  }
}

// Health card in the popup: say which identity the browser holds, and say
// plainly when it is the anonymous link rather than a person.
export async function getHealth() {
  const { onedrive_last_whoami: w } = await chrome.storage.local.get(['onedrive_last_whoami']);
  if (!w) return { ok: true, status: 'idle', message: 'טרם נבדק — ייבדק בפעולה הראשונה' };
  if (w.anonymous) {
    return {
      ok: true, status: 'anonymous',
      message: 'מחובר דרך קישור שיתוף אנונימי',
      hint: 'רואים רק את מה שהקישור חושף. להרחבה — להתחבר לחשבון הארגוני באותו דפדפן.',
    };
  }
  return { ok: true, status: 'ready', message: w.upn || w.title || 'מחובר' };
}
