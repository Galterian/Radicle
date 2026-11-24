// Device-signed requests to the OCI model / test services (user 2026-11-23: "the other mobile users should not know
// the key"). No shared secret on a phone: each device signs a request with its own key (<profile dir>/radicle/
// identity.pem, the z6Mk… id the team branches list as `owners`) and infra/oci/llm-gate.mjs lets it through when that
// id owns a team branch of chaosD6-Profiles. The master key (llm.json big_key / remote_key) still works where it is
// set (the user's desktop); a device without one signs.
//
//   X-Chaos-Device: base64(JSON { id, ts, nonce, sha, sig })
//   sig = ed25519 over "chaosd6-oci/1\n<id>\n<METHOD>\n<path + query>\n<sha256 hex of the body>\n<ts>\n<nonce>"
// The gate checks the signature, |now − ts| ≤ 5 min, a nonce once, the body's sha — then the owner list.
// Deployed beside profile-auth.mjs on OCI (infra/oci/llm-gate-setup.sh); in the repo both live in game/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const { idFromPrivateKeyPem, rawPublicKeyFromId } = await import('./profile-auth.mjs');

export const DEVICE_HEADER = 'x-chaos-device';
export const DEVICE_MAX_SKEW_MS = 5 * 60 * 1000;
/** The OCI host every build knows (the Radicle seed's: profile-sync.mjs SEED_HOST). */
export const OCI_HOST = process.env.RADICLE_SEED_HOST || '92-5-138-121.sslip.io';
export const OCI_URLS = Object.freeze({ llm: `https://${OCI_HOST}/llm`, big: `https://${OCI_HOST}/llm-big`, test: `https://${OCI_HOST}/gen-test` });
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const sha256 = (b) => crypto.createHash('sha256').update(b ?? '').digest('hex');
const message = ({ id, method, target, sha, ts, nonce }) => Buffer.from(`chaosd6-oci/1\n${id}\n${String(method).toUpperCase()}\n${target}\n${sha}\n${ts}\n${nonce}`);
const targetOf = (url) => { const u = new URL(url); return u.pathname + u.search; };

/** This device's signer ({ id, sign(method, url, body) → header value }) from <dir of profileFile>/radicle/identity.pem, or null. */
export function deviceSigner(profileFile) {
  if (!profileFile) return null;
  try {
    const pem = fs.readFileSync(path.join(path.dirname(profileFile), 'radicle', 'identity.pem'), 'utf8');
    const id = idFromPrivateKeyPem(pem), key = crypto.createPrivateKey(pem);
    return {
      id,
      sign(method, url, body = '') {
        const f = { id, method, target: targetOf(url), sha: sha256(body), ts: Date.now(), nonce: crypto.randomBytes(12).toString('hex') };
        const sig = crypto.sign(null, message(f), key).toString('base64');
        return Buffer.from(JSON.stringify({ id, ts: f.ts, nonce: f.nonce, sha: f.sha, sig })).toString('base64');
      },
    };
  } catch { return null; }
}

/**
 * The auth headers of one request: the key when the config has one AND the device signature on https (2026-11-24: a
 * phone with an old key after the master key was rotated still gets in — the gate takes a valid signature when the key
 * is wrong). Plain http (a local llama-server) never gets the signature.
 */
export function authHeaders(cfg, method, url, body = '') {
  const h = cfg?.key ? { Authorization: `Bearer ${cfg.key}` } : {};
  if (cfg?.signer?.sign && /^https:\/\//.test(String(url))) h[DEVICE_HEADER] = cfg.signer.sign(method, url, body);
  return h;
}

/**
 * The gate's check. → { id } or throws Error (client-safe message, .status 401).
 * seen(nonceKey) → true when already used (the caller keeps the cache); target = path + query as the client sent it.
 */
export function verifyDeviceRequest(header, { method, target, body = '' }, { now = Date.now(), seen = () => false } = {}) {
  const fail = (m) => { throw Object.assign(new Error(m), { status: 401 }); };
  if (!header) fail('missing X-Chaos-Device (or the API key)');
  let a;
  try { a = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { fail('malformed X-Chaos-Device'); }
  let raw;
  try { raw = rawPublicKeyFromId(String(a.id)); } catch { fail('not a device id'); }
  if (!Number.isFinite(a.ts) || Math.abs(now - a.ts) > DEVICE_MAX_SKEW_MS) fail('X-Chaos-Device expired (check the device clock)');
  if (!/^[0-9a-f]{16,64}$/.test(String(a.nonce))) fail('bad nonce');
  const sha = sha256(body);
  if (a.sha !== sha) fail('the body does not match the signature');
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  let ok = false;
  try { ok = crypto.verify(null, message({ id: a.id, method, target, sha, ts: a.ts, nonce: a.nonce }), key, Buffer.from(String(a.sig || ''), 'base64')); } catch {}
  if (!ok) fail('bad signature');
  if (seen(`${a.id} ${a.nonce}`)) fail('replayed request');
  return { id: a.id };
}
