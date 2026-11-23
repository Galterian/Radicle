#!/usr/bin/env node
// Generate an effect definition from a description with the big model, test it, keep it as a local draft.
//   node tools/effect-gen.mjs "a frost nova that locks every adjacent enemy for one action" [--url URL] [--key KEY]
//        [--attempts N] [--out DIR] [--prompt]
//   --url   default $LLM_BIG_URL or http://127.0.0.1:8096 (desktop: LLM_TIER=big tools/llm/llm-desktop.sh install;
//           OCI: https://<host>/llm-big with --key = the OCI API key)
//   --out   default <profile dir>/effect-drafts (desktop ~/.local/share/chaosd6/effect-drafts)
//   --prompt  print the system prompt's size and exit (no model call)
//   --save-key [--url URL]  store the OCI key (asked, not echoed) in <profile dir>/llm.json (mode 600); later runs need no --key/--url
//   --ssh user@host  read the model server's CPU / memory over your SSH (OCI: --ssh ubuntu@92.5.138.121; key $SSH_KEY or
//                    ~/.ssh/id_rsa). Without it: this machine's when --url is local, else none.
//   --every N        status line every N seconds (default 5); --quiet: none
// Exit 0 = a draft the validator rates ok; 1 = best draft kept but refused / out of band; 2 = no draft.
import { genConfig, generateEffect, saveDraft, systemPrompt, readLlmFile, formatStatus } from '../effect-gen.mjs';
import fs from 'node:fs';
import { profileDir } from '../profile.mjs';
import { startStats } from './machine-stats.mjs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = {}; const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); if (['url', 'key', 'attempts', 'out', 'ssh', 'every'].includes(k)) opt[k] = args[++i]; else opt[k] = true; }
  else words.push(args[i]);
}
if (opt.prompt) { const p = systemPrompt(); console.log(`system prompt: ${p.length} chars (~${Math.round(p.length / 3.6)} tokens)`); process.exit(0); }
const LLM_FILE = path.join(profileDir(), 'llm.json');
// --save-key [--url URL]: ask for the key without echoing it, store it (and the url) in <profile dir>/llm.json, mode 600.
if (opt['save-key']) {
  const key = await new Promise((resolve) => {
    process.stdout.write('OCI LLM key (not shown): ');
    let s = '';
    const tty = process.stdin.isTTY;
    if (tty) process.stdin.setRawMode(true);
    process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') { if (tty) process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(s.trim()); return; }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    });
  });
  if (!key) { console.error('no key entered — nothing saved'); process.exit(2); }
  const f = readLlmFile(LLM_FILE);
  if (!f.remote_key || f.remote_key === f.big_key) f.remote_key = key;   // a rotated OCI key replaces the old one for /llm too
  f.big_key = key;
  f.big_url = (opt.url || f.big_url || 'https://92-5-138-121.sslip.io/llm-big').replace(/\/+$/, '');
  // (the same OCI key serves /llm — team bots' fallback, llm-route.mjs — set above)
  f.remote_url ||= f.big_url.replace(/\/llm-big$/, '/llm');
  fs.mkdirSync(path.dirname(LLM_FILE), { recursive: true });
  fs.writeFileSync(LLM_FILE, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(LLM_FILE, 0o600);
  console.log(`saved to ${LLM_FILE} (only you can read it): big_url ${f.big_url}, remote_url ${f.remote_url}`);
  process.exit(0);
}
const cfg = genConfig({ ...process.env, ...(opt.url ? { LLM_BIG_URL: opt.url } : {}), ...(opt.key ? { LLM_BIG_KEY: opt.key } : {}), ...(opt.attempts ? { GEN_ATTEMPTS: opt.attempts } : {}) }, { file: LLM_FILE });
const idea = words.join(' ');
const t0 = Date.now();
// Status line: the attempt's phase and % (prompt read → answer written → validator), the server's CPU / memory.
const everyMs = Math.max(1, Number(opt.every) || 5) * 1000;
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.url);
const sshKey = process.env.SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa');
const stats = opt.quiet ? null : opt.ssh ? startStats({ ssh: opt.ssh, sshKey, everyMs }) : local ? startStats({ everyMs }) : null;
const where = opt.ssh ? opt.ssh.replace(/^.*@/, '') : 'local';
let state = { attempt: 1, of: cfg.attempts, phase: 'wait' };
function statusLine() {
  if (state) console.log(formatStatus(state, { elapsedMs: Date.now() - t0, sample: stats?.latest() || null, statsError: stats?.error() || '', where }));
}
const ticker = opt.quiet ? null : setInterval(statusLine, everyMs);
if (!stats && !opt.quiet && !local) console.log(`[gen] (server CPU / memory: add --ssh ubuntu@<host>)`);
const r = await generateEffect({ idea, cfg, log: (t) => console.log(`[gen] ${t}`), onProgress: (x) => { state = x; } });
if (ticker) clearInterval(ticker);
stats?.stop();
if (r.error) { console.error(`[gen] ${r.error}`); process.exit(2); }
for (const [i, t] of r.tries.entries()) {
  const u = t.usage ? `, ${t.usage.prompt_tokens} prompt + ${t.usage.completion_tokens} answer tokens` : '';
  const tm = t.timings ? `, ${Math.round(t.timings.prompt_per_second || 0)} / ${Math.round(t.timings.predicted_per_second || 0)} tok/s` : '';
  console.log(`[gen] try ${i + 1}: ${t.error || t.verdict} in ${Math.round(t.ms / 1000)} s${u}${tm}`);
}
if (!r.def) { console.error('[gen] no usable draft'); process.exit(2); }
const file = saveDraft(r.def, opt.out || path.join(profileDir(), 'effect-drafts'));
console.log(`[gen] ${r.verdict === 'ok' ? 'OK' : r.verdict.toUpperCase()}: "${r.def.name}" (${r.def.id}, ${r.def.elements.join(' ')}) → ${file}`);
if (r.check?.power) console.log(`[gen] power ${r.check.power.value} for ${r.check.power.cost.actions} actions, ratio ${r.check.judged_ratio} (band ${r.check.band.low}–${r.check.band.high})`);
for (const p of r.problems) console.log(`[gen]   - ${p}`);
console.log(`[gen] total ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(r.verdict === 'ok' ? 0 : 1);
