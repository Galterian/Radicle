// Player identity + push authorisation for chaosD6-Profiles. No dependencies
// (node:crypto only, works on nodejs-mobile's Node 18) so the OCI push service
// (infra/oci/profiles-push.mjs) can import this same file.
//
// A player is an ed25519 key. Its id is the Radicle-style did:key multibase
// (`z6Mk…`, i.e. base58btc(0xed01 ‖ pubkey)), so it reads like a Radicle NID.
// Each player owns exactly one branch: refs/heads/profiles/<z6Mk…>.
//
// A push is authorised by an X-Profile-Auth header signed over the single
// receive-pack command it will carry (ref, old oid, new oid) plus a timestamp;
// the server re-reads that command from the pack request and compares.

import crypto from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
// DER prefix of an ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const AUTH_HEADER = 'x-profile-auth';
export const AUTH_MAX_SKEW_MS = 10 * 60 * 1000;

function b58encode(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}

function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const lead = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(n ? hex : '', 'hex')]);
}

/** Raw 32-byte public key → `z6Mk…` id (did:key without the `did:key:` prefix). */
export function idFromRawPublicKey(raw) {
  return 'z' + b58encode(Buffer.concat([ED25519_MULTICODEC, Buffer.from(raw)]));
}

export function rawPublicKeyFromId(id) {
  if (!/^z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(id)) throw new Error(`not an ed25519 did:key id: ${id}`);
  const bytes = b58decode(id.slice(1));
  if (bytes.length !== 34 || !bytes.subarray(0, 2).equals(ED25519_MULTICODEC)) throw new Error(`not an ed25519 did:key id: ${id}`);
  return bytes.subarray(2);
}

export function profileRef(id) {
  return `refs/heads/profiles/${id}`;
}

// Team branches (user ruling 2026-11-13): the whole player profile lives on `teams/<Team>`, the branch named
// by the team. First claim wins — the creating push lists its key in profile.json `owners`, and only a listed
// key may move the branch afterwards (other devices are approved by id). `profiles/<id>` stays as each
// device's own branch (an approval request: { join_team, label }).
export const TEAM_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** Team name → branch-safe slug ("Gold Team!" → "Gold-Team"); '' when nothing usable is left. */
export function teamSlug(team) {
  return String(team || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40);
}
export function teamRef(team) {
  const s = teamSlug(team);
  if (!TEAM_SLUG_RE.test(s)) throw new Error(`team name "${team}" has no usable letters or digits`);
  return `refs/heads/teams/${s}`;
}
export const isTeamRef = (ref) => /^refs\/heads\/teams\/[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(ref);
/** Owner ids listed in a profile.json (`owners: [{ id, label, added_at }]`). */
export const ownerIds = (profile) => (Array.isArray(profile?.owners) ? profile.owners : []).map(o => (typeof o === 'string' ? o : o?.id)).filter(Boolean);

/** { id, privateKeyPem } — a fresh player identity. */
export function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  return { id: idFromRawPublicKey(raw), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
}

export function idFromPrivateKeyPem(pem) {
  const pub = crypto.createPublicKey(crypto.createPrivateKey(pem));
  return idFromRawPublicKey(pub.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length));
}

function authMessage({ id, ref, oldOid, newOid, ts }) {
  return Buffer.from(`chaosd6-profile-push\n${id}\n${ref}\n${oldOid}\n${newOid}\n${ts}`);
}

/** Header value authorising exactly one ref update. */
export function signPush(privateKeyPem, { ref, oldOid, newOid, ts = Date.now() }) {
  const id = idFromPrivateKeyPem(privateKeyPem);
  const fields = { id, ref, oldOid, newOid, ts };
  const sig = crypto.sign(null, authMessage(fields), crypto.createPrivateKey(privateKeyPem));
  return Buffer.from(JSON.stringify({ ...fields, sig: sig.toString('base64') })).toString('base64');
}

/**
 * Check a header against the command the pack request actually carries.
 * Returns the player id; throws with a client-safe message otherwise.
 * `mayPush(id, ref)` decides which refs the signer may move (default: only its own profiles/<id>; the push
 * service passes the team-owner check for teams/<Team>).
 */
export function verifyPush(header, { ref, oldOid, newOid }, now = Date.now(), { mayPush = (id, r) => r === profileRef(id) } = {}) {
  if (!header) throw new Error('missing X-Profile-Auth');
  let a;
  try { a = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')); } catch { throw new Error('malformed X-Profile-Auth'); }
  const raw = rawPublicKeyFromId(String(a.id));
  if (!mayPush(a.id, ref)) throw new Error(isTeamRef(ref) ? `${a.id} is not an owner of ${ref}` : `${a.id} may only push ${profileRef(a.id)}`);
  if (a.ref !== ref || a.oldOid !== oldOid || a.newOid !== newOid) throw new Error('signed command does not match the push');
  if (!Number.isFinite(a.ts) || Math.abs(now - a.ts) > AUTH_MAX_SKEW_MS) throw new Error('X-Profile-Auth expired');
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, authMessage(a), key, Buffer.from(String(a.sig), 'base64'))) throw new Error('bad signature');
  return a.id;
}
