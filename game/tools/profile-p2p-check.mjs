// Cross-checks game/profile-sync.mjs against the in-app node's Rust side
// (godot/android/radicle-node/ffi): the same identity.pem gives the same
// z6Mk… id, and git2 rebuilds the exact commit isomorphic-git makes. Prints
// the env for the Rust test; run inside WSL (needs the heartwood checkout
// godot/android/radicle-node/build.sh makes, or HEARTWOOD=<dir>):
//   node tools/profile-p2p-check.mjs --cargo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadIdentity } from '../profile-sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-p2p-'));
const { default: git } = await import('isomorphic-git');
const { id } = loadIdentity(tmp);
const gitdir = path.join(tmp, 'c.git');
await git.init({ fs, gitdir, bare: true });
const content = JSON.stringify({ team_name: 'Gold', owners: [{ id }], characters: [{ id: 'pc_ä', name: 'Ünïcode' }] }, null, 2) + '\n';
const blob = await git.writeBlob({ fs, gitdir, blob: Buffer.from(content) });
const tree = await git.writeTree({ fs, gitdir, tree: [{ mode: '100644', path: 'profile.json', oid: blob, type: 'blob' }] });
const ts = Math.floor(Date.now() / 1000);
const who = { name: id.slice(0, 16), email: `${id}@profiles.chaosd6`, timestamp: ts, timezoneOffset: 0 };
const oid = await git.writeCommit({ fs, gitdir, commit: { tree, parent: [], author: who, committer: who, message: 'profile\n' } });
const env = { CHAOSD6_ISOGIT_OID: oid, CHAOSD6_ISOGIT_CONTENT: content, CHAOSD6_ISOGIT_TS: String(ts), CHAOSD6_ISOGIT_ID: id, CHAOSD6_ISOGIT_PEM: path.join(tmp, 'identity.pem') };
let code = 0;
if (process.argv.includes('--cargo')) {
  const hw = process.env.HEARTWOOD || path.join(here, '../../godot/android/radicle-node/src');
  try {
    execFileSync('cargo', ['test', '-q', '-p', 'radicle-node-ffi', '--lib'], { cwd: hw, env: { ...process.env, ...env }, stdio: 'inherit' });
    console.log('ok   git2 commit == isomorphic-git commit, identity.pem → same id');
  } catch { code = 1; console.log('FAIL rust side differs'); }
} else console.log(env);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(code);
