// Deploy-time config.
//
// You normally do NOT need to edit this. The Signer URL travels inside the SIGNED
// course link (see tools/gen-url.js --signer), so `web/` is generic: deploy it once
// and never touch it again, even when the Worker URL changes. Because the value is
// inside the HMAC-signed token, it cannot be tampered with in a shared link.
//
// Resolution order: ?signer=... (dev override) -> signed course token -> this default.
const params = new URLSearchParams(location.search);

let resolved = (params.get('signer') || window.ORALSCALE_SIGNER || 'http://localhost:8787')
  .replace(/\/+$/, '');
let pinnedByQuery = !!params.get('signer');

/** Called at boot with the verified-by-signature course token payload. */
export function adoptSignerFromToken(payload) {
  if (pinnedByQuery) return resolved;            // explicit ?signer= always wins (local dev)
  if (payload && typeof payload.signerUrl === 'string' && /^https?:\/\//.test(payload.signerUrl)) {
    resolved = payload.signerUrl.replace(/\/+$/, '');
  }
  return resolved;
}

export const signerUrl = () => resolved;

// Cosmetic only; the Signer is the source of truth for all policy.
export const APP_NAME = 'OralScale';
