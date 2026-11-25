// Phone = desktop for GameModels bundles (2026-11-25): the same bundle published through the desktop git path
// (editor-publish.mjs commitGit) and through the phone bridge (publishGmBridge → ffi definition_commit) must give the
// same commit oid. This writes the CHAOSD6_DEFS_CROSS file the ffi test `definition_matches_desktop_git` replays:
//   node tools/gm-bridge-cross.mjs <out.json>     then (WSL)  CHAOSD6_DEFS_CROSS=<out.json> cargo test -p radicle-node-ffi
// Two cases: a first publish (parent main) and a changed bundle on top of it (fast-forward).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { GAMEMODELS_DIR, KINDS, defHash } from '../gamemodels.mjs';
import { generateDef } from '../effect-gen.mjs';
import { gmSpec, bundleDefs } from '../gm-gen.mjs';
import { publishGameModels, GAMEMODELS_RID } from '../editor-publish.mjs';
import { idFromRawPublicKey } from '../profile-auth.mjs';

const out = path.resolve(process.argv[2] || 'gm-bridge-cross.json');
if (!GAMEMODELS_DIR) { console.log('skip: no chaosD6-GameModels checkout'); process.exit(0); }
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-cross-'));
const remote = path.join(tmp, 'remote.git');
git(['clone', '-q', '--bare', GAMEMODELS_DIR, remote]);
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const identity = { id: idFromRawPublicKey(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
const team = { name: 'Sun Riders', slug: 'sun-riders' };
const now = () => new Date('2026-11-25T12:00:00Z');

const answer = { npc: { id: 'npc_empire_bard', name: 'Old Bard', race: 'race_empire', role: 'storyteller', home: 'bld_empire_library', persona: 'A travelling bard who sings of the Lion Throne.',
  lines: { greet: ['Sit, friend, and hear a song.'], lore: ['{lore}'] }, talk: [{ id: 'song_of_lions', ask: 'Sing me the Song of Lions.', say: ['Four lions, four gates, one throne.'] }],
  agenda: { uses: 'storyteller', params: {}, rules: [] }, quests: [], unit: { stats: { vitality: 9, world: 15, matter: 8, will: 16 }, actions_per_round: 2, deck_effects: ['effect_vision'] } },
  quests: [], place: { village: 'vil_empire', post: 'outside' } };
const g = await generateDef(gmSpec('npc'), { idea: 'a bard', cfg: { url: 'http://x', key: '', model: 'm', timeoutMs: 5000, attempts: 1, maxTokens: 1024 },
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { completion_tokens: 100 } }) }) });
if (!g.ok) { console.log(`bundle failed: ${g.problems.join('; ')}`); process.exit(2); }

const deskHooks = { profileFile: path.join(tmp, 'desk', 'profile.json'), remoteUrlFor: () => remote, radSync: false, nid: null, via: 'git', now };
const bridgeFile = path.join(tmp, 'bridge.json');
fs.writeFileSync(bridgeFile, JSON.stringify({ port: 1, token: 't', nid: identity.id, features: ['save', 'publish', 'defs', 'votes', 'gamemodels', 'fetch'] }));
const seen = [];
const phoneHooks = { profileFile: path.join(tmp, 'phone', 'profile.json'), via: 'bridge', bridgeFile, now,
  fetchImpl: async (url, o) => { seen.push(JSON.parse(o.body)); return { status: 200, json: async () => ({ ok: true, oid: '0'.repeat(40) }) }; } };
const main = git(['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
const cases = [];
let tip = null;
for (const b of [g.def, (() => { const c = structuredClone(g.def); c.npc.lines.greet.push('Mind the lions.'); return c; })()]) {
  const defs = bundleDefs(b).map(([k, def]) => [KINDS[k][0], def, defHash(def)]);
  const arg = { bundle: { id: b.id, name: b.name, version: b.version, kind: 'npc' }, defs, identity, team, message: 'npc: Old Bard' };
  const d = await publishGameModels(arg, deskHooks);
  if (d.publish.state !== 'published') { console.log(`desktop publish: ${d.publish.error}`); process.exit(2); }
  const p = await publishGameModels(arg, phoneHooks);
  if (p.publish.state !== 'published') { console.log(`phone publish: ${p.publish.error}`); process.exit(2); }
  cases.push({ body: seen.at(-1), main, tip, expect: d.ref.commit });
  tip = d.ref.commit;
}
const gitdir = path.join(tmp, 'desk', 'editor-defs-git', `${GAMEMODELS_RID.replace(/^rad:/, '')}.git`);
fs.writeFileSync(out, JSON.stringify({ gitdir, cases }, null, 2));
console.log(`${cases.length} cases → ${out} (gitdir ${gitdir}; files ${Object.keys(cases[0].body.files).join(', ')}; manifest ${cases[0].body.manifest.length} entries)`);
