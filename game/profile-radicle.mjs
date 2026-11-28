// Player profile ⇄ chaosD6-Profiles on Radicle (user ruling 2026-11-13), desktop (ui-server.mjs) and phone
// (mobile-entry.mjs) alike. profile.json on the device stays the working copy every game writes (deaths,
// kills, deck edits); this keeps it in step with the team branch:
//
//   refs/heads/teams/<Team>   the whole profile, cloned --single-branch --depth 1 (profile-sync.mjs).
//                             First claim wins: the first push lists this device's key in `owners`;
//                             the push service lets only listed keys move the branch afterwards.
//   refs/heads/profiles/<id>  this device's own branch: { kind: 'join-request', join_team, label } when the
//                             team already belongs to other keys. An owner device approves it by id
//                             (adds it to `owners`); no private key ever leaves a device.
//
// Sync = fetch the tip → merge per character (higher `rev`, then later `updated_at`; `deleted` tombstones;
// owners are a union) → write profile.json if it changed → push a fast-forward commit if the branch differs.
// Runs at start, ~2 s after any write to profile.json (so a game's death / kill lands on Radicle while the
// game goes on), every minute, and on demand (/api/profile/sync). Offline: the local file keeps everything
// and the next sync pushes it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, saveProfile, profilePath } from './profile.mjs';
import { openProfileStore, listDeviceBranches, loadIdentity, extraCa, DEFAULTS } from './profile-sync.mjs';
import { teamRef, teamSlug, ownerIds } from './profile-auth.mjs';

function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canon(x[k])]));
  return x;
}
const stable = (x) => JSON.stringify(canon(x));
const shortId = (id) => `${String(id).slice(0, 8)}…${String(id).slice(-4)}`;
const ownerObj = (o) => (typeof o === 'string' ? { id: o } : o);

/** Two copies of a profile → one. Per character the higher rev wins (tie: later updated_at, then `local`). */
export function mergeProfiles(local, remote) {
  const L = local || {}, R = remote;
  if (!R) return structuredClone(L);
  const deleted = { ...(R.deleted || {}) };
  for (const [id, t] of Object.entries(L.deleted || {})) if (!deleted[id] || t > deleted[id]) deleted[id] = t;
  const newer = (a, b) => ((a.rev | 0) !== (b.rev | 0) ? (a.rev | 0) > (b.rev | 0) : String(a.updated_at || '') >= String(b.updated_at || ''));
  const by = new Map();
  for (const c of [...(R.characters || []), ...(L.characters || [])]) { const o = by.get(c.id); if (!o || newer(c, o)) by.set(c.id, c); }
  for (const [id, t] of Object.entries(deleted)) { const c = by.get(id); if (c && String(c.updated_at || '') <= t) by.delete(id); }
  const localOrder = String(L.order_at || '') >= String(R.order_at || '');
  const [first, second] = localOrder ? [L, R] : [R, L];
  const order = [...(first.team_order || []), ...(second.team_order || [])].filter((id, i, a) => by.has(id) && a.indexOf(id) === i);
  for (const id of by.keys()) if (!order.includes(id)) order.push(id);
  const owners = [];
  for (const o of [...(R.owners || []), ...(L.owners || [])].map(ownerObj)) if (o?.id && !owners.some(x => x.id === o.id)) owners.push(o);
  const out = { ...R, ...L, version: Math.max(L.version | 0, R.version | 0) || 1, team_name: L.team_name ?? R.team_name ?? '',
    team_order: order, characters: order.map(id => structuredClone(by.get(id))), deleted, owners };
  // the team's published custom classes (profile.mjs addCustomClass): a union by id, the later `at` wins
  const cls = new Map();
  for (const x of [...(R.custom_classes || []), ...(L.custom_classes || [])]) if (x?.id && (!cls.has(x.id) || String(x.at || '') >= String(cls.get(x.id).at || ''))) cls.set(x.id, structuredClone(x));
  if (cls.size) out.custom_classes = [...cls.values()].sort((a, b) => a.id.localeCompare(b.id));
  // met proposals (profile.mjs addMetClass / addMetGameModel, 2026-11-28): a union per proposal branch, the later `at` wins
  for (const k of ['met_classes', 'met_gamemodels']) {
    const m = new Map(), keyOf = (x) => `${x.id}:${x.ref?.branch || x.ref?.sha256 || x.ref?.commit || ''}`;
    for (const x of [...(R[k] || []), ...(L[k] || [])]) if (x?.id && (!m.has(keyOf(x)) || String(x.at || '') >= String(m.get(keyOf(x)).at || ''))) m.set(keyOf(x), structuredClone(x));
    if (m.size) out[k] = [...m.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }
  const orderAt = first.order_at || second.order_at;
  if (orderAt) out.order_at = orderAt;
  for (const c of out.characters) c.team = out.team_name;
  return out;
}

/**
 * Start syncing `file` (default profile.json). Returns { id, status(), syncNow({requests}), approve(id), stop() }.
 * `dir` holds identity.pem (this device's key) and the shallow clones.
 */
export function startProfileSync({ file = profilePath(), dir = path.join(path.dirname(file), 'radicle'), label = os.hostname(),
  readUrl = DEFAULTS.readUrl, pushUrl = DEFAULTS.pushUrl, namespace,
  intervalMs = 60_000, requestsEveryMs = 5 * 60_000, watchMs = 2000, log = (m) => console.log(`[profile-sync] ${m}`) } = {}) {
  const { id } = loadIdentity(dir);
  const st = { state: 'starting', message: '', id, label, team: '', ref: '', oid: null, last_sync: null, owners: [], requests: [], is_owner: false };
  const set = (state, message, extra = {}) => {
    const changed = st.state !== state || st.message !== message;
    Object.assign(st, { state, message }, extra);
    if (changed) log(`${state}: ${message}`);
    return status();
  };
  const status = () => structuredClone({ ...st, readUrl, pushUrl });
  const stores = new Map();
  const storeFor = async (ref, name) => {
    if (!stores.has(ref)) stores.set(ref, await openProfileStore({ dir, readUrl, pushUrl, namespace, ref, name }));
    return stores.get(ref);
  };
  let lastPushed = null;        // stable() of what the branch holds after our last sync
  let lastRequests = 0;

  async function requestJoin(slug) {
    const own = await storeFor(null, 'device');
    const { oid, profile } = await own.fetch();
    if (profile?.kind === 'join-request' && profile.join_team === slug) return;
    await own.commit({ kind: 'join-request', join_team: slug, label, ts: new Date().toISOString() }, oid);
    log(`join request for teams/${slug} pushed on profiles/${shortId(id)}`);
  }

  async function refreshRequests(slug, owners) {
    const branches = await listDeviceBranches({ dir, readUrl, namespace, skip: (x) => owners.includes(x) || x === id });
    st.requests = branches.filter(b => b.profile?.kind === 'join-request' && b.profile.join_team === slug)
      .map(b => ({ id: b.id, label: String(b.profile.label || '').slice(0, 40), ts: b.profile.ts || null }));
    lastRequests = Date.now();
  }

  async function syncOnce({ requests = false } = {}) {
    await extraCa(dir);   // a proxy CA dropped in later (extra-ca.pem) is picked up without a restart
    if (!readUrl) return set('not-configured', 'No chaosD6-Profiles repo configured (RADICLE_PROFILES_RID).');
    let local = loadProfile(file);
    const slug = teamSlug(local.team_name);
    if (!slug) return set('no-team', 'Set a team name: the profile is saved on Radicle on the branch teams/<team name>.', { team: '', ref: '' });
    const ref = teamRef(local.team_name);
    if (ref !== st.ref) { lastPushed = null; st.requests = []; lastRequests = 0; }
    Object.assign(st, { team: slug, ref });
    const store = await storeFor(ref);
    let { oid, profile: remote } = await store.fetch();
    for (let attempt = 0; attempt < 3; attempt++) {
      const owners = remote ? ownerIds(remote) : [];
      if (remote && !owners.includes(id)) {
        await requestJoin(slug);
        return set('awaiting-approval', `Team "${slug}" is already on Radicle under other device keys. If it is your team, approve this device (${shortId(id)}) on a device that owns it; otherwise pick another team name.`,
          { oid, owners: (remote.owners || []).map(ownerObj), is_owner: false, last_sync: new Date().toISOString() });
      }
      let merged = mergeProfiles(local, remote);
      if (!remote) merged.owners = [{ id, label, added_at: new Date().toISOString() }, ...(merged.owners || []).map(ownerObj).filter(o => o.id !== id)];
      // Re-read right before writing: a game may have written a death / kill meanwhile (its rev is higher).
      const fresh = loadProfile(file);
      merged = mergeProfiles(fresh, merged);
      if (stable(merged) !== stable(fresh)) saveProfile(merged, file);
      local = merged;
      const common = { owners: merged.owners, is_owner: true };
      if (remote && stable(merged) === stable(remote)) {
        lastPushed = stable(merged);
        if (requests || Date.now() - lastRequests > requestsEveryMs) await refreshRequests(slug, ownerIds(merged)).catch(e => log(`requests: ${e.message}`));
        return set('synced', `Up to date on teams/${slug}.`, { ...common, oid, last_sync: new Date().toISOString() });
      }
      try {
        oid = await store.commit(merged, oid);
        lastPushed = stable(merged);
        if (requests || Date.now() - lastRequests > requestsEveryMs) await refreshRequests(slug, ownerIds(merged)).catch(e => log(`requests: ${e.message}`));
        return set('synced', `${remote ? 'Saved' : 'Claimed'} teams/${slug} (${oid.slice(0, 8)}).`, { ...common, oid, last_sync: new Date().toISOString() });
      } catch (e) {
        const m = e.message || String(e);
        if (/team name taken/i.test(m) || /not an owner/i.test(m)) {
          ({ oid, profile: remote } = await store.fetch());   // someone claimed it first: next loop asks to join
          continue;
        }
        if (/fast-forward|stale|failed to update|fetch first|rejected/i.test(m)) {
          ({ oid, profile: remote } = await store.fetch());   // another device pushed meanwhile: merge again
          local = loadProfile(file);
          continue;
        }
        throw e;
      }
    }
    return set('error', 'The team branch kept moving; will retry.');
  }

  // One sync at a time; a request during a sync runs once more afterwards.
  let running = null, again = false, againOpts = {};
  function syncNow(opts = {}) {
    if (running) { again = true; againOpts = { ...againOpts, ...opts }; return running; }
    running = (async () => {
      let o = opts;
      do {
        again = false;
        try { await syncOnce(o); } catch (e) {
          const m = e.message || String(e);
          const offline = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network/i.test(m) || e.code === 'HttpError' && /50\d/.test(m);
          const tlsBad = /local issuer certificate|self[- ]signed|CERT_|certificate/i.test(m);
          set(offline ? 'offline' : 'error', offline ? 'Radicle seed unreachable: saved on this device, it goes up on the next sync.'
            : tlsBad ? `HTTPS to the seed is not trusted here (${m}); a proxy re-signs it? Put its root CA in ${path.join(dir, 'extra-ca.pem')} (or PROFILES_CA_FILE) and restart. Saved on this device meanwhile.` : m);
        }
        o = againOpts; againOpts = {};
      } while (again);
      running = null;
      return status();
    })();
    return running;
  }

  async function approve(devId) {
    if (!/^z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(devId)) throw Object.assign(new Error('not a device id (z6Mk…)'), { status: 400 });
    if (!st.is_owner) throw Object.assign(new Error('this device does not own the team branch yet'), { status: 400 });
    const req = st.requests.find(r => r.id === devId);
    const p = loadProfile(file);
    if (!ownerIds(p).includes(devId)) {
      p.owners = [...(p.owners || []).map(ownerObj), { id: devId, label: req?.label || '', added_at: new Date().toISOString() }];
      saveProfile(p, file);
    }
    st.requests = st.requests.filter(r => r.id !== devId);
    log(`approved device ${shortId(devId)} for teams/${st.team}`);
    return syncNow();
  }

  // Triggers: profile.json writes (debounced), a timer, and the first sync now.
  let debounce = null;
  const onChange = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try { if (lastPushed && stable(loadProfile(file)) === lastPushed) return; } catch { /* sync decides */ }
      syncNow();
    }, 1500);
    debounce.unref?.();
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.watchFile(file, { interval: watchMs, persistent: false }, onChange);
  const timer = setInterval(() => syncNow(), intervalMs);
  timer.unref?.();
  syncNow({ requests: true });

  return {
    id, status, syncNow, approve,
    stop() { clearInterval(timer); clearTimeout(debounce); fs.unwatchFile(file, onChange); return running || Promise.resolve(); },
  };
}
