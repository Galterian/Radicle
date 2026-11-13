#!/usr/bin/env node
// Spin up N local Radicle seed nodes (default 3) on consecutive ports, each
// with its own RAD_HOME, identity, ssh-agent and node config. Every seed is
// pointed at the project's RID with --scope all, so pushes from the main peer
// land in at least three independent namespaces on this box and have a fast,
// always-reachable rendezvous even when public seeds (rosa, etc) are flaky.
//
//   node tools/local-seeds.mjs start [N=3] [--port=8776] [--rid=rad:...]
//   node tools/local-seeds.mjs stop
//   node tools/local-seeds.mjs status
//   node tools/local-seeds.mjs apply   # re-patch host config from the json
//
// Outputs:
//   game/tools/local-seeds.json       — the live roster (nid, port, home, pid)
//   ~/.radicle/config.json            — preferredSeeds + node.connect updated
//   ~/.radicle/config.json.bak-<ts>   — one backup per `apply`
//
// Must run on WSL (where `rad` is installed):
//   wsl bash -lc 'cd ~/repo_radicle_clone2/chaosD6/game && node tools/local-seeds.mjs start'
//
// `rad auth` for a brand-new identity is run with inherited stdio so you can
// answer passphrase / principal prompts directly in the terminal. Everything
// else runs quietly.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pexec = promisify(execFile);
const HOME = os.homedir();
const RAD_BIN = path.join(HOME, '.radicle', 'bin');
const RAD = path.join(RAD_BIN, 'rad');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const ROSTER_PATH = path.join(PROJECT_ROOT, 'game', 'tools', 'local-seeds.json');
const HOST_CONFIG = path.join(HOME, '.radicle', 'config.json');

const DEFAULT_RID = 'rad:zqZmP6itceBMqYwi1K1n8phQqCaj';
const DEFAULT_N = 3;
const DEFAULT_BASE_PORT = 8776;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v = 'true'] = a.slice(2).split('=');
      flags[k] = v;
    } else positional.push(a);
  }
  return { positional, flags };
}

function envFor(home) {
  return {
    ...process.env,
    RAD_HOME: home,
    PATH: `${RAD_BIN}${path.delimiter}${process.env.PATH || ''}`,
    SSH_AUTH_SOCK: path.join(home, 'agent.sock'),
  };
}

async function run(cmd, args, { env, cwd, timeout = 30_000, allowFail = false } = {}) {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { env, cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    const msg = ((e.stderr || '') + (e.stdout || '') + (e.message || '')).toString();
    if (allowFail) return { ok: false, stdout: (e.stdout || '').toString().trim(), stderr: msg.trim() };
    throw new Error(`${cmd} ${args.join(' ')}: ${msg.split('\n').slice(0, 4).join(' | ')}`);
  }
}

async function runInherit(cmd, args, { env } = {}) {
  await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: 'inherit' });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)));
    p.on('error', reject);
  });
}

async function ensureSshAgent(home) {
  const sock = path.join(home, 'agent.sock');
  const env = envFor(home);
  const check = await run('ssh-add', ['-l'], { env, allowFail: true, timeout: 5000 });
  if (check.ok) return sock;
  await fs.rm(sock, { force: true });
  await run('ssh-agent', ['-a', sock], { env, allowFail: true });
  const keyPath = path.join(home, 'keys', 'radicle');
  if (existsSync(keyPath)) await run('ssh-add', [keyPath], { env, allowFail: true, timeout: 10_000 });
  return sock;
}

async function ensureIdentity(home, alias) {
  const keyPath = path.join(home, 'keys', 'radicle');
  if (existsSync(keyPath)) return;
  await fs.mkdir(home, { recursive: true });
  const env = envFor(home);
  // rad auth may prompt for passphrase, alias confirmation, principal name,
  // etc depending on the build. Attach the user's terminal so they can answer;
  // piping stdio hits EOF and the auth aborts (and the common failure mode is
  // "Enter at least one principal"). Pre-seed alias via flag; if the user has
  // set RAD_PASSPHRASE_SEED they can skip the passphrase prompt.
  const envWithPass = process.env.RAD_PASSPHRASE_SEED !== undefined
    ? { ...env, RAD_PASSPHRASE: process.env.RAD_PASSPHRASE_SEED }
    : env;
  console.log(`[local-seeds] running: rad auth --alias ${alias}  (answer any prompts in this terminal)`);
  await runInherit(RAD, ['auth', '--alias', alias], { env: envWithPass });
  if (!existsSync(keyPath)) throw new Error(`rad auth did not create ${keyPath}`);
}

async function patchConfig(home, port, alias) {
  const cfgPath = path.join(home, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')); } catch {}
  cfg.node = cfg.node || {};
  cfg.node.alias = alias;
  cfg.node.listen = [`0.0.0.0:${port}`];
  cfg.node.externalAddresses = [`127.0.0.1:${port}`];
  cfg.node.seedingPolicy = { default: 'allow' };
  cfg.preferredSeeds = cfg.preferredSeeds || [];
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
}

async function nodeStatus(home) {
  const env = envFor(home);
  const r = await run(RAD, ['node', 'status'], { env, allowFail: true, timeout: 5000 });
  if (!r.ok) return { running: false, info: r.stderr };
  const running = /running/i.test(r.stdout);
  return { running, info: r.stdout };
}

async function startNode(home) {
  const env = envFor(home);
  await run(RAD, ['node', 'start'], { env, allowFail: true, timeout: 20_000 });
  for (let i = 0; i < 20; i++) {
    const st = await nodeStatus(home);
    if (st.running) return st;
    await new Promise(r => setTimeout(r, 500));
  }
  return nodeStatus(home);
}

async function stopNode(home) {
  const env = envFor(home);
  await run(RAD, ['node', 'stop'], { env, allowFail: true, timeout: 10_000 });
}

async function seedRid(home, rid) {
  const env = envFor(home);
  await run(RAD, ['seed', rid, '--scope', 'all'], { env, allowFail: true, timeout: 15_000 });
}

async function readNid(home) {
  const env = envFor(home);
  const r = await run(RAD, ['self', '--nid'], { env, allowFail: true, timeout: 5000 });
  return r.ok ? r.stdout.trim() : null;
}

async function readPid(home) {
  const pidPath = path.join(home, 'node.pid');
  try { return parseInt((await fs.readFile(pidPath, 'utf8')).trim(), 10) || null; } catch { return null; }
}

async function applyHostConfig(roster) {
  if (!existsSync(HOST_CONFIG)) {
    console.warn(`[local-seeds] host config ${HOST_CONFIG} not found — skipping auto-wire`);
    return;
  }
  const original = await fs.readFile(HOST_CONFIG, 'utf8');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(`${HOST_CONFIG}.bak-${ts}`, original);
  const cfg = JSON.parse(original);
  cfg.node = cfg.node || {};
  const preferred = roster.map(s => `${s.alias}@${s.host}:${s.port}`);
  const connect   = roster.map(s => `${s.nid}@${s.host}:${s.port}`);
  const stripLocal = (list) => (list || []).filter(e => !/@127\.0\.0\.1:/.test(e) && !/@localhost:/.test(e));
  cfg.preferredSeeds = [...preferred, ...stripLocal(cfg.preferredSeeds)];
  cfg.node.connect   = [...connect,   ...stripLocal(cfg.node.connect)];
  await fs.writeFile(HOST_CONFIG, JSON.stringify(cfg, null, 2));
  console.log(`[local-seeds] host ${HOST_CONFIG} updated (backup: ${path.basename(HOST_CONFIG)}.bak-${ts})`);
}

async function cmdStart({ positional, flags }) {
  const n = parseInt(positional[0] || flags.n || DEFAULT_N, 10);
  const basePort = parseInt(flags.port || DEFAULT_BASE_PORT, 10);
  const rid = flags.rid || DEFAULT_RID;
  if (!existsSync(RAD)) throw new Error(`rad binary not found at ${RAD}`);

  const roster = [];
  for (let i = 0; i < n; i++) {
    const idx = i + 1;
    const alias = `chaos-seed-${idx}`;
    const home = path.join(HOME, `.radicle-seed-${idx}`);
    const port = basePort + i;
    console.log(`\n== seed ${idx} (${alias}) on 127.0.0.1:${port} home=${home}`);
    await ensureIdentity(home, alias);
    await patchConfig(home, port, alias);
    await ensureSshAgent(home);
    const before = await nodeStatus(home);
    if (before.running) await stopNode(home);
    const after = await startNode(home);
    await seedRid(home, rid);
    const nid = await readNid(home);
    const pid = await readPid(home);
    if (!nid) { console.warn(`[local-seeds] seed ${idx} started but NID unreadable — skipping`); continue; }
    const entry = { alias, nid, host: '127.0.0.1', port, home, pid, running: after.running };
    roster.push(entry);
    console.log(`  nid: ${nid}`);
    console.log(`  address: ${nid}@127.0.0.1:${port}`);
    console.log(`  preferred: ${alias}@127.0.0.1:${port}`);
    console.log(`  rad node status: ${after.info.split('\n')[0]}`);
  }

  await fs.writeFile(ROSTER_PATH, JSON.stringify({ rid, started_at: new Date().toISOString(), seeds: roster }, null, 2));
  console.log(`\n[local-seeds] roster written to ${ROSTER_PATH}`);
  await applyHostConfig(roster);

  console.log('\n== summary ==');
  for (const s of roster) console.log(`  ${s.alias}  ${s.nid}  ${s.host}:${s.port}`);
}

async function cmdStop() {
  if (!existsSync(ROSTER_PATH)) { console.log('[local-seeds] no roster — nothing to stop'); return; }
  const { seeds } = JSON.parse(await fs.readFile(ROSTER_PATH, 'utf8'));
  for (const s of seeds) {
    console.log(`== stop ${s.alias} (${s.home})`);
    await stopNode(s.home);
  }
}

async function cmdStatus() {
  if (!existsSync(ROSTER_PATH)) { console.log('[local-seeds] no roster yet — run `start`'); return; }
  const { seeds, rid } = JSON.parse(await fs.readFile(ROSTER_PATH, 'utf8'));
  console.log(`RID: ${rid}`);
  for (const s of seeds) {
    const st = await nodeStatus(s.home);
    console.log(`  ${s.alias}  ${s.host}:${s.port}  ${st.running ? 'running' : 'stopped'}  nid=${s.nid}`);
  }
}

async function cmdApply() {
  if (!existsSync(ROSTER_PATH)) throw new Error('no roster — run `start` first');
  const { seeds } = JSON.parse(await fs.readFile(ROSTER_PATH, 'utf8'));
  await applyHostConfig(seeds);
}

const COMMANDS = { start: cmdStart, stop: cmdStop, status: cmdStatus, apply: cmdApply };

async function main() {
  const [, , cmd = 'status', ...rest] = process.argv;
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error('usage: node tools/local-seeds.mjs {start [N] [--port=P] [--rid=rad:...] | stop | status | apply}');
    process.exit(2);
  }
  await fn(parseArgs(rest));
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
