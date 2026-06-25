# PIBA Module

Integration with the Israeli Population and Immigration Authority (PIBA) for automated visa issuance.

## What it does

Fetches PDF visas from PIBA's web portal — both Employer Visas (require 2FA token) and Inter Visas (public endpoint, no auth).

## Files

- `module.json` — metadata + API contract
- `content.js` — runs on `inforhub.piba.gov.il`, syncs the JWT auth token from page localStorage to `chrome.storage`
- `handler.js` — runs in background, makes the actual API calls using the synced token

## Storage keys used

- `piba_token` — current Bearer token
- `piba_token_exp` — token expiry (epoch ms)
- `piba_token_updated_at` — last sync timestamp

## API

### `fetchPibaVisa(foreignKey)`

Fetch an Employer Visa PDF. Requires the user to be logged into PIBA in another tab (with 2FA completed). The token auto-syncs.

**Params:**
- `foreignKey` — Format `"{country_numeric_code}_{passport_no}"`. Example: `"140_ej6609447"`.

**Returns:**
```js
{ success: true, pdf_base64: "JVBERi0xLj...", byteLength: 12345, foreignKey: "140_ej6609447" }
// or
{ success: false, error_code: "TOKEN_EXPIRED", error: "..." }
```

### `fetchPibaInterVisa(foreignKey)`

Fetch an Inter Visa PDF. Does NOT require login — public endpoint.

**Params:** same as above. Passport portion is auto-lowercased.

**Returns:** same shape.

### `openPiba()`

Opens `https://inforhub.piba.gov.il` in a new tab so the user can complete 2FA login.

## Setup for new customers

1. Customer's `customer_modules` table in ARAD DB must have `piba` enabled
2. Extension auto-loads this module on next handshake
3. User must visit PIBA once and complete 2FA to populate the token
4. After that, calls work for ~30 minutes (token lifetime), then auto-refreshes when user re-visits

## Country codes

176 countries. See `piba_countries.json` in the repo root for the mapping (e.g., India=140, Sri Lanka=129, Thailand=143).

## Common errors

| error_code | meaning |
|---|---|
| `NO_TOKEN` | User hasn't logged into PIBA yet |
| `TOKEN_EXPIRED` | Token > 30 min old, needs re-login |
| `PIBA_ERROR` | PIBA returned an error (status + body included) |
| `NOT_PDF` | Response was something other than PDF — usually a redirect/HTML error page |
| `FETCH_ERROR` | Network failure |
