// chaosD6-GameModels proposals (user 2026-11-25: "Team first, then vote"; the vote in the editor AND in Test Random
// games). Another team's NPC / building / monster lives on players/<team>/<id> of chaosD6-GameModels (editor-publish.mjs
// publishGameModels: one signed commit of several definition files + index.json on top of main). Nobody meets it in a
// normal game (the game catalog is main only), so the editor lists them from the LOCAL Radicle storage of the repo:
//   listGmProposals({ storageDir, profileFile, me }) → [{ kind, id, name, team, branch, ns, commit, sha256, author,
//     signature_ok, at, subject, bundle, files[], votes: {n, mean, review}, mine, own }]
// read-only (git for-each-ref / diff / show on the storage; no network). refreshGmProposals() = `rad sync <rid> --fetch
// --seed <OCI seed>` — the OCI seed ONLY, never a public seed. A proposal's bundle is rebuilt from the files its commit
// changes (gm-gen.mjs bundle shape), so the editor's card, the private test game and the vote all see the same thing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { KINDS as DEF_KINDS, defHash } from './gamemodels.mjs';
import { BUNDLE_SCHEMA } from './gm-gen.mjs';
// the version a vote names = sha256 of the signed content (editor-publish.mjs defSha), the same as the publish ref
import { gmSignedOf, verifyDefinitionSignature, trailersOf, defSha, GAMEMODELS_RID } from './editor-publish.mjs';
import { OCI_SEED_NID, collectionOf, normalizeTarget, authorConflict, loadVotes, votesFile } from './proposal-votes.mjs';

const radHome = () => process.env.RAD_HOME || path.join(os.homedir(), '.radicle');
export const gmStorageDir = (rid = GAMEMODELS_RID) => path.join(radHome(), 'storage', String(rid).replace(/^rad:/, ''));
const SUB_KIND = Object.fromEntries(Object.entries(DEF_KINDS).map(([k, [sub]]) => [sub, k]));   // npcs → npc
const MAIN_KIND = { npc: 'npc', building: 'building', monster: 'monster' };
const git = (gitdir, args) => execFileSync('git', ['--git-dir', gitdir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20 }).trim();

/** The canonical main of the storage: refs/heads/main, else the first delegate namespace's main. */
function mainOf(gitdir, refs) {
  if (refs.includes('refs/heads/main')) return git(gitdir, ['rev-parse', 'refs/heads/main']);
  const r = refs.find(x => /^refs\/namespaces\/[^/]+\/refs\/heads\/main$/.test(x));
  return r ? git(gitdir, ['rev-parse', r]) : null;
}

/** One proposal commit → the bundle it carries (or null): the files it changes against its merge base with main. */
export function bundleOfCommit(gitdir, main, tip) {
  const base = (() => { try { return git(gitdir, ['merge-base', main, tip]); } catch { return main; } })();
  const changed = git(gitdir, ['diff', '--name-only', base, tip]).split('\n').filter(f => /^[a-z]+\/[a-z0-9_]+\.json$/.test(f));
  const defs = [];
  for (const f of changed) {
    const [sub] = f.split('/');
    const kind = SUB_KIND[sub];
    if (!kind) continue;
    try { defs.push([kind, sub, JSON.parse(git(gitdir, ['show', `${tip}:${f}`]))]); } catch { /* deleted / unreadable: not part of the bundle */ }
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
export function listGmProposals({ storageDir = gmStorageDir(), profileFile = '', me = null } = {}) {
  if (!fs.existsSync(storageDir)) return { available: false, why: `chaosD6-GameModels is not in this node's Radicle storage (${GAMEMODELS_RID})`, proposals: [] };
  const refs = git(storageDir, ['for-each-ref', '--format=%(refname)', 'refs/namespaces/', 'refs/heads/']).split('\n').filter(Boolean);
  const main = mainOf(storageDir, refs);
  if (!main) return { available: false, why: 'no main branch in the storage yet', proposals: [] };
  const mine = new Map(loadVotes(votesFile(profileFile)).map(v => [v.key, v]));
  const out = [];
  for (const r of refs) {
    const m = /^(?:refs\/namespaces\/([^/]+)\/)?refs\/heads\/(players\/([^/]+)\/[^/]+)$/.exec(r);
    if (!m) continue;
    const [, ns, branch, team] = m;
    let tip, info;
    try { tip = git(storageDir, ['rev-parse', r]); info = bundleOfCommit(storageDir, main, tip); } catch { continue; }
    if (!info) continue;
    const msg = git(storageDir, ['log', '-1', '--format=%B', tip]);
    const at = git(storageDir, ['log', '-1', '--format=%cI', tip]);
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
/** Fetch the latest proposals from the OCI seed into the local storage (desktop; `rad` CLI). → { ok, out|error } */
export function refreshGmProposals({ timeoutSec = 60 } = {}) {
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
 *  first NPC / monster, the c2 test hooks (GAMEMODELS_TEST_VILLAGE + _TEST_NPC + TEST_NEAR_VILLAGE, or TEST_FOES). */
export async function proposalTestCatalog({ storageDir = gmStorageDir(), profileFile = '', me = null, max = 3, outDir }) {
  const { loadGameModels, compileCatalog, GAMEMODELS_DIR } = await import('./gamemodels.mjs');
  const { overlay, checkBundle } = await import('./gm-gen.mjs');
  const l = listGmProposals({ storageDir, profileFile, me });
  const base = loadGameModels(GAMEMODELS_DIR);
  let m = base;
  const used = [];
  for (const p of l.proposals) {
    if (used.length >= max || p.own || !p.signature_ok || used.some(u => u.id === p.id)) continue;
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
  const nb = npc && l.proposals.find(p => p.id === npc.id)?.bundle;
  if (nb?.place?.village) Object.assign(env, { GAMEMODELS_TEST_VILLAGE: nb.place.village, GAMEMODELS_TEST_NPC: npc.id, TEST_NEAR_VILLAGE: '1' });
  else { const bld = used.find(u => u.kind === 'building'); const bb = bld && l.proposals.find(p => p.id === bld.id)?.bundle; if (bb?.place?.village) Object.assign(env, { GAMEMODELS_TEST_VILLAGE: bb.place.village, TEST_NEAR_VILLAGE: 'inside' }); }
  if (mon) env.TEST_FOES = mon.id;
  return { file, proposals: used, env };
}
