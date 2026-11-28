// chaosD6-GameModels proposals (user 2026-11-25: "Team first, then vote"; the vote in the editor AND in Test Random
// games). Another team's NPC / building / monster lives on players/<team>/<id> of chaosD6-GameModels (editor-publish.mjs
// publishGameModels: one signed commit of several definition files + index.json on top of main). Nobody meets it in a
// normal game (the game catalog is main only), so the editor lists them from the LOCAL Radicle storage of the repo:
//   await listGmProposals({ storageDir, profileFile, me }) → [{ kind, id, name, team, branch, ns, commit, sha256, author,
//     signature_ok, at, subject, bundle, files[], votes: {n, mean, review}, mine, own }]
// read-only (refs / diff / show on the storage; no network) — the git CLI on a desktop, isomorphic-git on the phone (no
// git binary there; its in-app node keeps the storage at <dirname of bridge.json>/storage, the GameModels repo seeded
// with scope all — RadicleBoot.gd). refreshGmProposals() = `rad sync <rid> --fetch --seed <OCI seed>` on a desktop, the
// node bridge POST /fetch on the phone — the OCI seed ONLY, never a public seed. A proposal's bundle is rebuilt from the
// files its commit changes (gm-gen.mjs bundle shape), so the editor's card, the private test game and the vote all see
// the same thing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { KINDS as DEF_KINDS, defHash } from './gamemodels.mjs';
import { BUNDLE_SCHEMA } from './gm-gen.mjs';
// the version a vote names = sha256 of the signed content (editor-publish.mjs defSha), the same as the publish ref
import { gmSignedOf, verifyDefinitionSignature, trailersOf, defSha, GAMEMODELS_RID } from './editor-publish.mjs';
import { OCI_SEED_NID, collectionOf, normalizeTarget, authorConflict, loadVotes, votesFile } from './proposal-votes.mjs';

const isPhone = () => process.env.CHAOSD6_MOBILE === '1';
// The phone's node: RAD_HOME = the directory of its bridge.json (RadicleBoot.gd bridge_file()).
const radHome = () => (process.env.CHAOSD6_RADICLE_BRIDGE ? path.dirname(process.env.CHAOSD6_RADICLE_BRIDGE) : process.env.RAD_HOME || path.join(os.homedir(), '.radicle'));
export const gmStorageDir = (rid = GAMEMODELS_RID) => path.join(radHome(), 'storage', String(rid).replace(/^rad:/, ''));
const SUB_KIND = Object.fromEntries(Object.entries(DEF_KINDS).map(([k, [sub]]) => [sub, k]));   // npcs → npc
const MAIN_KIND = { npc: 'npc', building: 'building', monster: 'monster' };
const DEF_FILE_RE = /^[a-z]+\/[a-z0-9_]+\.json$/;

// The few reads a proposal needs, on a bare repo: engine 'git' (the CLI) | 'iso' (isomorphic-git, the phone).
function gitReader(gitdir) {
  const git = (args) => execFileSync('git', ['--git-dir', gitdir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20 }).trim();
  return {
    refs: async () => git(['for-each-ref', '--format=%(refname)', 'refs/namespaces/', 'refs/heads/']).split('\n').filter(Boolean),
    resolve: async (ref) => git(['rev-parse', ref]),
    mergeBase: async (a, b) => git(['merge-base', a, b]),
    changed: async (base, tip) => git(['diff', '--name-only', base, tip]).split('\n').filter(f => DEF_FILE_RE.test(f)),
    show: async (tip, f) => git(['show', `${tip}:${f}`]),
    meta: async (tip) => ({ message: git(['log', '-1', '--format=%B', tip]), at: git(['log', '-1', '--format=%cI', tip]) }),
  };
}
async function isoReader(gitdir) {
  const iso = (await import('isomorphic-git')).default;
  const o = { fs, gitdir };
  const tree = async (oid, filepath) => { try { return (await iso.readTree({ ...o, oid, ...(filepath ? { filepath } : {}) })).tree; } catch { return []; } };
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  return {
    // every ref under refs/heads/ and refs/namespaces/ (loose + packed)
    refs: async () => [...(await iso.listRefs({ ...o, filepath: 'refs/heads' }).catch(() => [])).map(r => `refs/heads/${r}`),
      ...(await iso.listRefs({ ...o, filepath: 'refs/namespaces' }).catch(() => [])).map(r => `refs/namespaces/${r}`)],
    resolve: (ref) => iso.resolveRef({ ...o, ref }),
    mergeBase: async (a, b) => { const m = await iso.findMergeBase({ ...o, oids: [a, b] }); if (!m.length) throw new Error('no merge base'); return m[0]; },
    // the definition files (<subdir>/<id>.json) whose blob differs between the two trees (git diff --name-only, depth 2)
    changed: async (base, tip) => {
      const out = [];
      const [bt, tt] = [await tree(base), await tree(tip)];
      for (const d of tt.filter(e => e.type === 'tree')) {
        const was = bt.find(e => e.path === d.path);
        if (was?.oid === d.oid) continue;
        const [bf, tf] = [was ? await tree(base, d.path) : [], await tree(tip, d.path)];
        const names = new Set([...bf, ...tf].filter(e => e.type === 'blob').map(e => e.path));
        for (const n of names) if (bf.find(e => e.path === n)?.oid !== tf.find(e => e.path === n)?.oid) out.push(`${d.path}/${n}`);
      }
      for (const d of bt.filter(e => e.type === 'tree' && !tt.some(t => t.path === e.path))) {
        for (const f of (await tree(base, d.path)).filter(e => e.type === 'blob')) out.push(`${d.path}/${f.path}`);
      }
      return out.filter(f => DEF_FILE_RE.test(f)).sort();
    },
    show: async (tip, f) => Buffer.from((await iso.readBlob({ ...o, oid: tip, filepath: f })).blob).toString('utf8'),
    meta: async (tip) => {
      const { commit: c } = await iso.readCommit({ ...o, oid: tip });
      const off = -c.committer.timezoneOffset, t = new Date((c.committer.timestamp + off * 60) * 1000).toISOString().slice(0, 19);
      return { message: c.message.replace(/\n+$/, ''), at: `${t}${off < 0 ? '-' : '+'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}` };
    },
  };
}
const readerOf = async (gitdir, engine = isPhone() ? 'iso' : 'git') => (engine === 'iso' ? isoReader(gitdir) : gitReader(gitdir));

/** The canonical main of the storage: refs/heads/main, else the first delegate namespace's main. */
async function mainOf(rd, refs) {
  if (refs.includes('refs/heads/main')) return rd.resolve('refs/heads/main');
  const r = refs.find(x => /^refs\/namespaces\/[^/]+\/refs\/heads\/main$/.test(x));
  return r ? rd.resolve(r) : null;
}

/** One proposal commit → the bundle it carries (or null): the files it changes against its merge base with main. */
export async function bundleOfCommit(gitdir, main, tip, { engine, rd = null } = {}) {
  rd = rd || await readerOf(gitdir, engine);
  let base = main;
  try { base = await rd.mergeBase(main, tip); } catch { base = main; }
  const changed = await rd.changed(base, tip);
  const defs = [];
  for (const f of changed) {
    const [sub] = f.split('/');
    const kind = SUB_KIND[sub];
    if (!kind) continue;
    try { defs.push([kind, sub, JSON.parse(await rd.show(tip, f))]); } catch { /* deleted / unreadable: not part of the bundle */ }
  }
  const main0 = defs.find(([k]) => MAIN_KIND[k]);
  if (!main0) return null;
  const [kind, , def] = main0;
  const b = { schema: BUNDLE_SCHEMA, kind, id: def.id, name: def.name, version: def.version, source: { collection: 'gamemodels-proposal' }, place: null, touches: {} };
  b[kind] = def;
  if (kind === 'npc') b.quests = defs.filter(([k]) => k === 'quest').map(([, , d]) => d);
  for (const [k, , d] of defs) if (k === 'village' || k === 'race') b.touches[k] = d;
  // where it stands (the editor card / the test game read place)
  if (kind === 'npc') {
    const v = b.touches.village;
    const r = v?.residents?.find(x => x.npc === def.id);
    if (v) b.place = { village: v.id, post: (v.wanderers?.npcs || []).includes(def.id) ? 'wanderer' : r?.post === 'outside' ? 'outside' : 'resident', ...(r?.at ? { at: r.at } : {}) };
  } else if (kind === 'building') {
    const v = b.touches.village, l = v?.layout?.find(x => x.building === def.id);
    if (v) b.place = { village: v.id, ...(l?.at ? { at: l.at } : {}) };
  }
  return { bundle: b, defs: defs.map(([, sub, d]) => [sub, d, defHash(d)]), files: changed };
}

/** Every GameModels proposal in the local storage (newest first). me = { voter, nid, handles } for the author check. */
export async function listGmProposals({ storageDir = gmStorageDir(), profileFile = '', me = null, engine } = {}) {
  if (!fs.existsSync(storageDir)) return { available: false, why: `chaosD6-GameModels is not in this node's Radicle storage yet (${GAMEMODELS_RID})${isPhone() ? ' — the app seeds it; try Refresh' : ''}`, proposals: [] };
  const rd = await readerOf(storageDir, engine);
  const refs = await rd.refs();
  const main = await mainOf(rd, refs);
  if (!main) return { available: false, why: 'no main branch in the storage yet', proposals: [] };
  const mine = new Map(loadVotes(votesFile(profileFile)).map(v => [v.key, v]));
  const out = [];
  for (const r of refs) {
    const m = /^(?:refs\/namespaces\/([^/]+)\/)?refs\/heads\/(players\/([^/]+)\/[^/]+)$/.exec(r);
    if (!m) continue;
    const [, ns, branch, team] = m;
    let tip, info;
    try { tip = await rd.resolve(r); info = await bundleOfCommit(storageDir, main, tip, { rd }); } catch { continue; }
    if (!info) continue;
    const { message: msg, at } = await rd.meta(tip);
    const tr = trailersOf(msg);
    const signed = gmSignedOf(info.bundle.id, info.defs);
    const author = tr['Chaosd6-Author'] || '';
    const ref = { kind: 'gamemodels', id: info.bundle.id, branch, commit: tip, sha256: defSha(signed), ...(ns ? { ns } : {}), ...(author ? { author: author.slice(0, 60) } : {}) };
    let key = null; try { key = normalizeTarget(ref).key; } catch {}
    out.push({ kind: info.bundle.kind, id: info.bundle.id, name: info.bundle.name, team, branch, ns: ns || null, commit: tip, sha256: ref.sha256, author,
      signature_ok: !!author && verifyDefinitionSignature(signed, tr['Chaosd6-Signature'], author), at, subject: msg.split('\n')[0].slice(0, 200),
      bundle: info.bundle, files: info.files, ref, key, votes: collectionOf(ref, profileFile), mine: key && mine.get(key) ? { value: mine.get(key).value, comment: mine.get(key).comment } : null,
      own: me ? !!authorConflict(ref, me) : false });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { available: true, rid: GAMEMODELS_RID, main, proposals: out };
}

/** Fetch the latest proposals from the OCI seed into the local storage: a desktop's `rad` CLI, the phone's node bridge
 *  POST /fetch (feature "fetch"). → { ok, out|error } */
export async function refreshGmProposals({ timeoutSec = 60, bridgeFile = isPhone() ? process.env.CHAOSD6_RADICLE_BRIDGE || '' : '', fetchImpl = globalThis.fetch } = {}) {
  if (bridgeFile || isPhone()) {
    let b = null;
    try { b = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch { return { ok: false, error: 'the phone Radicle node is not running (no bridge.json)' }; }
    if (!Array.isArray(b?.features) || !b.features.includes('fetch')) return { ok: false, error: 'the phone Radicle node cannot fetch on demand yet (update the app) — it still syncs on its own' };
    try {
      const r = await fetchImpl(`http://127.0.0.1:${b.port}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': b.token },
        body: JSON.stringify({ rid: GAMEMODELS_RID, seed: OCI_SEED_NID }), signal: AbortSignal.timeout((timeoutSec + 15) * 1000) });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      return j.ok ? { ok: true, out: `${j.updated ?? 0} refs updated from the OCI seed` } : { ok: false, error: String(j.error || 'fetch failed').slice(0, 300) };
    } catch (e) { return { ok: false, error: `bridge: ${e.name === 'TimeoutError' ? 'timeout' : e.message}` }; }
  }
  const env = { ...process.env };
  const radBin = path.join(os.homedir(), '.radicle', 'bin');
  if (fs.existsSync(radBin) && !String(env.PATH || '').includes(radBin)) env.PATH = `${radBin}${path.delimiter}${env.PATH || ''}`;
  try {
    const out = execFileSync('rad', ['sync', GAMEMODELS_RID, '--fetch', '--seed', OCI_SEED_NID, '--timeout', String(timeoutSec)], { encoding: 'utf8', env, timeout: (timeoutSec + 30) * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim().split('\n').slice(-3).join(' | ') };
  } catch (e) { return { ok: false, error: String(e.stderr || e.message || e).trim().split('\n').slice(-3).join(' | ').slice(0, 300) }; }
}

/** Test Random with other teams' proposals (user 2026-11-25 "Both": vote in the editor AND in Test Random games): the
 *  repo + up to `max` proposals that are not mine (newest first, signed, passing the check against main) compiled into
 *  <outDir>/catalog.json — the launcher passes it as GAMEMODELS_CATALOG_FILE. → { file, proposals: [{ kind, id, name,
 *  team, ref }], env } where env = { GAMEMODELS_CATALOG_FILE, GAMEMODELS_PROPOSALS (JSON of the refs) } plus, for the
 *  first NPC / monster, the c2 test hooks (GAMEMODELS_TEST_VILLAGE + _TEST_NPC + TEST_NEAR_VILLAGE, or TEST_FOES).
 *  The phone: the GameModels definitions staged in the bundle (gamemodels.mjs candidate <game>/gamemodels-repo). */
export async function proposalTestCatalog({ storageDir = gmStorageDir(), profileFile = '', me = null, max = 3, outDir, engine }) {
  const { loadGameModels, compileCatalog, GAMEMODELS_DIR } = await import('./gamemodels.mjs');
  const { overlay, checkBundle } = await import('./gm-gen.mjs');
  const l = await listGmProposals({ storageDir, profileFile, me, engine });
  if (!l.available || !GAMEMODELS_DIR) return { file: null, proposals: [], env: {} };
  const base = loadGameModels(GAMEMODELS_DIR);
  let m = base;
  const used = [];
  // user 2026-11-28: the ones I met in a game come first (profile met_gamemodels, by branch — the branch tip is the
  // latest version); a version whose votes say "needs rework" is not played until its author updates it
  let met = new Set();
  try { met = new Set((JSON.parse(fs.readFileSync(profileFile, 'utf8')).met_gamemodels || []).map(x => `${x.id}:${x.ref?.branch || ''}`)); } catch {}
  const order = [...l.proposals.filter(p => met.has(`${p.id}:${p.branch}`)), ...l.proposals.filter(p => !met.has(`${p.id}:${p.branch}`))];
  for (const p of order) {
    if (used.length >= max || p.own || !p.signature_ok || p.votes?.review || used.some(u => u.id === p.id)) continue;
    if (!checkBundle(p.bundle, { m: base }).ok) continue;   // one that no longer fits main is skipped
    m = overlay(m, p.bundle);
    used.push({ kind: p.kind, id: p.id, name: p.name, team: p.team, ref: p.ref });
  }
  if (!used.length) return { file: null, proposals: [], env: {} };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(compileCatalog(m)) + '\n');
  const env = { GAMEMODELS_CATALOG_FILE: file, GAMEMODELS_PROPOSALS: JSON.stringify(used.map(u => u.ref)) };
  const npc = used.find(u => u.kind === 'npc'), mon = used.find(u => u.kind === 'monster');
  const nb = npc && order.find(p => p.id === npc.id)?.bundle;
  if (nb?.place?.village) Object.assign(env, { GAMEMODELS_TEST_VILLAGE: nb.place.village, GAMEMODELS_TEST_NPC: npc.id, TEST_NEAR_VILLAGE: '1' });
  else { const bld = used.find(u => u.kind === 'building'); const bb = bld && l.proposals.find(p => p.id === bld.id)?.bundle; if (bb?.place?.village) Object.assign(env, { GAMEMODELS_TEST_VILLAGE: bb.place.village, TEST_NEAR_VILLAGE: 'inside' }); }
  if (mon) env.TEST_FOES = mon.id;
  return { file, proposals: used, env };
}
