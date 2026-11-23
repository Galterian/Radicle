#!/usr/bin/env node
// Test a generated effect draft in a PRIVATE background game (2026-11-23, the editor's "test preview").
//   node tools/effect-gen-test.mjs <draft.json> [--minutes 3] [--games 2] [--out result.json] [--review] [--min-casts 2]
// A launcher of its own (ui-server.mjs LAUNCHER_MODE=1 on a free UI_PORT, a throw-away profile dir and defs cache, so the
// player's profile, game and launcher are never touched) starts a Test Random game — loopback, no Door, no bus — with
// three copies of the draft in player-1's deck (FORCE_FOREIGN_EFFECT + FORCE_FOREIGN_COPIES, FOREIGN_HOLDERS=player-1).
// tools/swarm-test.mjs (SWARM_MODE=test-random, SWARM_PREFER_EFFECT) drives player-1 with its bot; ally-1 and the
// monsters play by the rules. Peers sit on 7801+ / 7901+ (LAUNCH_PORT_BASE), never 7357 / 7401 / 7392 / 7393.
// When player-1 dies before it cast enough, another game follows (up to --games); the counts add up.
// Pass = cast ≥ --min-casts times, landed at least once, 0 engine errors, 0 state divergences.
// A skill draft (id skill_…): FORCE_FOREIGN_SKILL + FORCE_FOREIGN_SKILL_COPIES=3; the bot plays skill cards on every
// matching action. "cast" = player-1 played it (the tape's reveals), "landed" = an instant that did not come back to
// the hand without benefit (Rule 8), a permanent that went up, or a "skill fx:" line of it.
// --review: the big model (genConfig: LLM_BIG_URL / <profile dir>/llm.json) reads the draft + the cast lines and
// returns suggestions only — it never decides pass / fail.
// Status: "[test] m:ss <phase> … · casts n, lands n · errors n · divergences n" every --every seconds (10);
// the last line is "[test] RESULT <json>". Exit 0 = pass, 1 = fail, 2 = could not run.
// Only the processes it started are stopped (its launcher's process group, then any peer with its DIM_NAME).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { genConfig, complete, mmss } from '../effect-gen.mjs';
import { profileDir } from '../profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = {}; const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); if (['minutes', 'out', 'min-casts', 'every', 'games'].includes(k)) opt[k] = args[++i]; else opt[k] = true; }
  else words.push(args[i]);
}
const draftFile = path.resolve(words[0] || '');
let def;
try { def = JSON.parse(fs.readFileSync(draftFile, 'utf8')); } catch (e) { console.log(`[test] cannot read the draft ${draftFile}: ${e.message}`); process.exit(2); }
const ID = String(def.id || '');
const KIND = /^skill_[a-z0-9_]+$/.test(ID) ? 'skill' : /^effect_[a-z0-9_]+$/.test(ID) ? 'effect' : '';
if (!KIND) { console.log(`[test] the draft has no effect or skill id`); process.exit(2); }
const verb = KIND === 'skill' ? 'played' : 'cast';
const minutes = Math.max(1, Math.min(15, Number(opt.minutes) || 3));
const maxGames = Math.max(1, Math.min(4, Number(opt.games) || 2));
const minCasts = Math.max(1, Number(opt['min-casts']) || 2);
const everyMs = Math.max(2, Number(opt.every) || 10) * 1000;
const t0 = Date.now();
const say = (t) => console.log(`[test] ${mmss(Date.now() - t0)} ${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// ---- log scan: the draft's lines in the peers' logs ----
// + a skill program's error / limit (skills.mjs: neutral value + stderr) and a forced draft the peer refused
const ERR_RE = /Uncaught|UNCAUGHT|UNHANDLED|TypeError|ReferenceError|SyntaxError|RangeError|\[skills\] data hook|FORCE_FOREIGN_\w+ \S+: refused/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// player-1's own lines ("[player-1] …"; the wild lurkers it spawns write into the same file under their own label):
//   "effect <id> by …: a token(s), b stat token(s), c lock(s), d zone hexes" = one resolved cast (peer.mjs, every done cast)
//   "cast <id> [elems] … → n dmg"   = a hit of it;   "cast <id> <status>: …" = a cast that did not resolve
// lands = resolved casts that changed something (a token, lock, zone, or damage > 0 since the previous resolution).
// The other peers' lines about the id go to the review (they show the same cast seen from the receiving side).
const EMPTY = () => ({ casts: 0, resolved: 0, failed: 0, lands: 0, errors: 0, divergences: 0, died: false, errorLines: [], lines: [] });
function scan(logs) {
  if (KIND === 'skill') return scanSkill(logs);
  const out = EMPTY();
  let files = [];
  try { files = fs.readdirSync(logs).filter(f => f.endsWith('.log') && !f.endsWith('.ui.log')); } catch { return out; }
  const res = new RegExp(`\\] effect ${esc(ID)} by \\S+: (\\d+) token\\(s\\), (\\d+) stat token\\(s\\), (\\d+) lock\\(s\\), (\\d+) zone`);
  const fail = new RegExp(`\\] cast ${esc(ID)} (?!\\[)(\\w+):`), hit = new RegExp(`\\] cast ${esc(ID)} \\[.*→ (\\d+) dmg`);
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(logs, f), 'utf8'); } catch { continue; }
    let dmg = 0;
    for (const line of txt.split('\n')) {
      if (ERR_RE.test(line)) { out.errors++; if (out.errorLines.length < 8) out.errorLines.push(`${f}: ${line.slice(0, 240)}`); }
      if (line.includes('STATE DIVERGENCE')) out.divergences++;
      if (line.includes('[player-1] DIED at')) out.died = true;
      if (!line.includes(ID) || /\] fx: /.test(line)) continue;
      if (out.lines.length < 60) out.lines.push(line.slice(line.indexOf('['), line.indexOf('[') + 220));
      if (!line.includes('[player-1] ')) continue;
      const h = hit.exec(line);
      if (h) { dmg += Number(h[1]); continue; }
      const m = res.exec(line);
      if (m) { out.resolved++; if (dmg > 0 || m.slice(1).some(x => Number(x) > 0)) out.lands++; dmg = 0; continue; }
      if (fail.test(line)) out.failed++;
    }
  }
  out.casts = out.resolved + out.failed;
  return out;
}
// A skill: the plays come from the game's tape (playsOf); here player-1's verdict lines:
//   "instants without benefit return to hand: <ids>" (Rule 8) · "my <ids> stripped from T…" · "permanent <id> up: die n"
//   "skill fx: ✦ your <name>: …" (peer.mjs skName: the skill's name, or its id without skill_ and with spaces)
//   "skill fx: ✦ <foe>'s Counter spell countered your <name> — discarded" (not returned, but no pay-off)
const SK_NAMES = [String(def.name || ''), ID.replace(/^skill_/, '').replace(/_/g, ' ')].filter(Boolean).map(n => n.toLowerCase());
function scanSkill(logs) {
  const out = { ...EMPTY(), returned: 0, perms: 0, fx: 0 };
  let files = [];
  try { files = fs.readdirSync(logs).filter(f => f.endsWith('.log') && !f.endsWith('.ui.log')); } catch { return out; }
  const idRe = new RegExp(`\\b${esc(ID)}\\b`, 'g');
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(logs, f), 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (ERR_RE.test(line)) { out.errors++; if (out.errorLines.length < 8) out.errorLines.push(`${f}: ${line.slice(0, 240)}`); }
      if (line.includes('STATE DIVERGENCE')) out.divergences++;
      if (line.includes('[player-1] DIED at')) out.died = true;
      const low = line.toLowerCase();
      if (!line.includes(ID) && !(/skill fx: /.test(line) && SK_NAMES.some(n => low.includes(n)))) continue;
      if (out.lines.length < 60) out.lines.push(line.slice(line.indexOf('['), line.indexOf('[') + 220));
      if (!line.includes('[player-1] ')) continue;
      if (/instants without benefit return to hand: | stripped from T\d+/.test(line)) out.returned += (line.match(idRe) || []).length;
      else if (line.includes(`permanent ${ID} up:`)) out.perms++;
      else if (/skill fx: ✦ your /.test(line)) out.fx++;
      else if (/skill fx: ✦ .* countered your /.test(line)) out.returned++;   // a foe's Counter Spell discarded it: no pay-off either
    }
  }
  return out;
}
// The skill in the reveals on the game's tape (sessions/<dim>/hashgraph.jsonl, + the rotated .1) = its plays.
function playsOf(dim) {
  const tape = path.join(GAME, 'sessions', dim, 'hashgraph.jsonl');
  let txt = '';
  for (const f of [tape.replace(/\.jsonl$/, '.1.jsonl'), tape]) { try { txt += fs.readFileSync(f, 'utf8') + '\n'; } catch {} }
  let n = 0;
  for (const l of txt.split('\n')) {
    if (!l.includes(ID) || !l.includes('evt_action_reveal')) continue;
    try { const r = JSON.parse(l); if (r.type === 'evt_action_reveal') n += (r.payload?.skills || []).filter(s => s === ID).length; } catch {}   // two copies on one action = 2 plays
  }
  return n;
}
// A skill game's counts: casts = plays; lands = permanents that went up / fx lines, or instants that paid off.
const settle = (s, dim) => {
  if (KIND !== 'skill') return s;
  const plays = playsOf(dim);
  const lands = def.is_permanent ? Math.max(s.perms, s.fx) : Math.min(plays, Math.max(s.fx, plays - s.returned));
  return { ...s, casts: plays, resolved: plays, lands };
};
const add = (a, b) => ({ casts: a.casts + b.casts, resolved: a.resolved + b.resolved, failed: a.failed + b.failed, lands: a.lands + b.lands,
  errors: a.errors + b.errors, divergences: a.divergences + b.divergences, died: b.died,
  errorLines: [...a.errorLines, ...b.errorLines].slice(0, 8), lines: [...a.lines, ...b.lines].slice(0, 60) });
const brief = (s) => `${KIND === 'skill' ? 'plays' : 'casts'} ${s.casts}, lands ${s.lands} · errors ${s.errors} · divergences ${s.divergences}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-gentest-'));
const draftCopy = path.join(tmp, `${ID}.json`);
fs.writeFileSync(draftCopy, JSON.stringify(def, null, 2) + '\n');
let live = null;   // { launcher, swarm, dim } of the running game
function stopGame() {
  if (!live) return;
  const { launcher, swarm, dim } = live; live = null;
  try { swarm?.kill('SIGTERM'); } catch {}
  try { process.kill(-launcher.pid, 'SIGTERM'); } catch {}
  // peers that left the group (none today) — matched on this game's DIM_NAME only
  for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('.mjs')) continue;
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`DIM_NAME=${dim}`)) process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
  setTimeout(() => { try { process.kill(-launcher.pid, 'SIGKILL'); } catch {} }, 3000).unref();   // whatever ignored the SIGTERM
}
process.on('SIGINT', () => { stopGame(); process.exit(130); });
process.on('SIGTERM', () => { stopGame(); process.exit(143); });

// One game: its own launcher (one dimension per launcher process), the swarm bot on player-1, the scan.
async function runGame(n, before) {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const dim = `GenTest-${ID.replace(/^(effect|skill)_/, '').replace(/_/g, '-').slice(0, 30)}-${stamp}`;
  const logs = path.join(GAME, 'logs', slug(dim));
  const port = await freePort();
  const env = {
    ...process.env, LAUNCHER_MODE: '1', UI_PORT: String(port), CHAOSD6_PROFILE_DIR: path.join(tmp, `profile-${n}`),
    CHAOSD6_DEFS_CACHE_ROOT: path.join(tmp, `defs-${n}`), FOREIGN_HOLDERS: 'player-1',
    // A skill needs many actions of player-1 AND a foe that strikes (a reactive skill pays off only then): the Minotaur
    // kills a life-4 hero in a round or two, the Nacatl only postures (2026-11-23 trials) → Rhox Brute (ui-server TEST_FOES).
    ...(KIND === 'skill' ? { FORCE_FOREIGN_SKILL: draftCopy, FORCE_FOREIGN_SKILL_COPIES: '3', SWARM_PREFER_SKILL: ID, TEST_FOES: process.env.GEN_TEST_FOES || 'mon_rhox_brute' }
      : { FORCE_FOREIGN_EFFECT: draftCopy, FORCE_FOREIGN_COPIES: '3', SWARM_PREFER_EFFECT: ID }),
    AI_SKIRMISH: '0', NOSTR_ENABLED: '0',
    LAUNCH_PORT_BASE: process.env.GEN_TEST_PORT_BASE || '7801',
  };
  for (const k of ['FORCE_EFFECTS', 'FORCE_SKILLS', 'FORCE_FOREIGN_CLASS', 'FOREIGN_REFUSERS', 'LLM_URL', KIND === 'skill' ? 'FORCE_FOREIGN_EFFECT' : 'FORCE_FOREIGN_SKILL']) delete env[k];
  fs.mkdirSync(env.CHAOSD6_PROFILE_DIR, { recursive: true });
  const launcherLog = fs.openSync(path.join(tmp, `launcher-${n}.log`), 'a');
  const launcher = spawn(process.execPath, ['ui-server.mjs'], { cwd: GAME, env, detached: true, stdio: ['ignore', launcherLog, launcherLog] });
  live = { launcher, swarm: null, dim };
  say(`game ${n}/${maxGames}: starting a private test game ${dim} (launcher :${port}, ${minutes} min, the draft in player-1's deck)`);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try { up = (await fetch(`http://127.0.0.1:${port}/`)).status > 0; } catch {}
  }
  if (!up) { stopGame(); return { code: -1, s: EMPTY(), dim, logs, botCasts: 0, phase: 'launcher did not start' }; }
  let phase = 'starting the game', playAt = 0;
  const swarmOut = [];
  const swarm = spawn(process.execPath, ['tools/swarm-test.mjs', `http://127.0.0.1:${port}`, String(minutes), dim], {
    cwd: GAME, env: { ...env, SWARM_MODE: 'test-random' }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.swarm = swarm;
  const onLine = (l) => {
    swarmOut.push(l); if (swarmOut.length > 400) swarmOut.shift();
    if (/hosted /.test(l)) { phase = 'playing'; playAt = Date.now(); }
    else if (/agents stopped/.test(l)) phase = 'settling';
    else if (/host failed/.test(l)) phase = 'host failed';
  };
  let buf = '';
  const feed = (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); } };
  swarm.stdout.setEncoding('utf8'); swarm.stdout.on('data', feed);
  swarm.stderr.setEncoding('utf8'); swarm.stderr.on('data', feed);
  const ticker = setInterval(() => {
    const s = add(before, settle(scan(logs), dim));
    let p = phase;
    if (phase === 'playing' && playAt) { const el = Date.now() - playAt, tot = minutes * 60_000; p = `playing ${mmss(el)}/${mmss(tot)} (${Math.min(99, Math.round(100 * el / tot))}%)`; }
    say(`game ${n}/${maxGames} ${p} · ${brief(s)}`);
  }, everyMs);
  const code = await new Promise((resolve) => swarm.on('exit', (c) => resolve(c)));
  clearInterval(ticker);
  const agentLine = swarmOut.find(l => /agents stopped/.test(l)) || '';
  const botCasts = Number((new RegExp(`player-1 [^,]*?${KIND === 'skill' ? 'skills' : 'effects'} (\\d+)`).exec(agentLine) || [])[1] || 0);
  stopGame();
  return { code, s: settle(scan(logs), dim), dim, logs, botCasts, phase };
}

let total = EMPTY(), botCasts = 0, games = [], lastCode = 0, lastPhase = '';
for (let n = 1; n <= maxGames; n++) {
  const g = await runGame(n, total);
  total = add(total, g.s); botCasts += g.botCasts; lastCode = g.code; lastPhase = g.phase;
  games.push({ dimension: g.dim, logs: path.relative(GAME, g.logs), casts: g.s.casts, died: g.s.died, code: g.code });
  if (g.code !== 0 || total.errors || total.divergences) break;
  if (total.casts >= minCasts && total.lands >= 1) break;
  if (!g.s.died) break;   // alive the whole game and still short: another game would not be fairer
  if (n < maxGames) say(`player-1 died after ${g.s.casts} cast(s) — another game`);
}
const s = total;
const pass = lastCode === 0 && s.casts >= minCasts && s.lands >= 1 && s.errors === 0 && s.divergences === 0;
const why = [];
if (lastCode !== 0) why.push(`the test game ended with code ${lastCode}${lastPhase === 'host failed' || lastPhase === 'launcher did not start' ? ` (${lastPhase === 'host failed' ? 'the game did not start' : lastPhase})` : ''}`);
if (s.casts < minCasts) why.push(`${verb} ${s.casts} time(s) in ${games.length} game(s), needs ${minCasts}${botCasts > s.casts ? ` (the bot queued ${KIND === 'skill' ? 'skills' : 'it'} ${botCasts} times)` : ''}${s.died ? ' — player-1 died' : ''}`);
if (s.lands < 1) why.push(KIND === 'skill' && s.casts ? (def.is_permanent ? 'it never went up as a permanent' : 'it never paid off — every play came back to the hand without benefit') : 'it never landed');
if (s.errors) why.push(`${s.errors} engine error line(s)`);
if (s.divergences) why.push(`${s.divergences} state divergence(s)`);
say(`${pass ? 'PASS' : 'FAIL'} · ${brief(s)}${why.length ? ` — ${why.join('; ')}` : ''}`);

// ---- the big model's review (suggestions only) ----
let review = null;
if (opt.review) {
  const cfg = genConfig(process.env, { file: path.join(profileDir(), 'llm.json') });
  if (!cfg.url) review = { error: 'no big model configured' };
  else {
    say('asking the big model for a review of the test log');
    const schema = { type: 'object', properties: { summary: { type: 'string' }, suggestions: { type: 'array', items: { type: 'string' }, maxItems: 5 } }, required: ['summary', 'suggestions'] };
    const ask = [
      { role: 'system', content: KIND === 'skill'
        ? 'You review a test game of a new chaosD6 skill card (it rides on an Attack, Move, Block or Posture and changes how that action resolves). Read the definition and the log lines, say in one or two sentences what happened, and give at most 5 short, concrete suggestions (each one change to the skill: action type, permanent or instant, its bonus, its condition, text) that would make it work as its text says or make it more fun. "return to hand without benefit" means the skill did nothing that action. Answer JSON {"summary": "...", "suggestions": ["..."]}. /no_think'
        : 'You review a test game of a new chaosD6 card effect. Read the definition and the log lines, say in one or two sentences what happened, and give at most 5 short, concrete suggestions (each one change to the effect: cost, elements, scope, range, lock, damage, text) that would make it work as its text says or make it more fun. Answer JSON {"summary": "...", "suggestions": ["..."]}. /no_think' },
      { role: 'user', content: `Definition:\n${JSON.stringify(KIND === 'skill' ? { id: def.id, name: def.name, action_type: def.action_type, is_permanent: def.is_permanent, text: def.text, flags: def.flags }
        : { id: def.id, name: def.name, elements: def.elements, kind: def.kind, duration: def.duration, text: def.text, flags: def.flags })}\n\nResult: ${pass ? 'passed' : `failed — ${why.join('; ')}`}; ${brief(s)}.\n\nLog lines:\n${s.lines.slice(0, 40).join('\n') || `(none — it was never ${verb})`}\n${s.errorLines.length ? `\nErrors:\n${s.errorLines.join('\n')}` : ''}\n/no_think` },
    ];
    const r = await complete(cfg, ask, { schema, maxTokens: 500, temperature: 0.3 });
    if (r.error) review = { error: r.error };
    else {
      try { const j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); review = { summary: String(j.summary || '').slice(0, 600), suggestions: (Array.isArray(j.suggestions) ? j.suggestions : []).map(x => String(x).slice(0, 300)).slice(0, 5) }; }
      catch { review = { error: 'the review is not JSON' }; }
    }
    say(review.error ? `review: ${review.error}` : `review: ${review.summary}`);
  }
}
const last = games.at(-1) || {};
finish({ pass, why, ...s, bot_casts: botCasts, minutes, games, dimension: last.dimension, logs: last.logs, review }, pass ? 0 : lastCode === -1 ? 2 : 1);

function finish(result, exit) {
  const out = { id: ID, at: new Date().toISOString(), ms: Date.now() - t0, ...result };
  if (opt.out) { try { fs.writeFileSync(opt.out, JSON.stringify(out, null, 2) + '\n'); } catch {} }
  console.log(`[test] RESULT ${JSON.stringify(out)}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(exit), 3200);   // let stopGame's SIGKILL sweep run first
}
