#!/usr/bin/env node
// Test a generated GameModels draft (a village NPC or building, gm-gen.mjs bundle) in a PRIVATE background game
// (2026-11-25, the editor's "test preview" for the npc / building kinds; user: "Test game + 8B review").
//   node tools/gm-gen-test.mjs <bundle.json> [--minutes 3] [--games 2] [--out result.json] [--review] [--every 10] [--llm-file <llm.json>]
// The repo's definitions with the bundle laid over them (gm-gen.mjs overlay) are compiled into a catalog of this test
// only (GAMEMODELS_CATALOG_FILE) — the repo and assets/gamemodels/catalog.json are never written. A launcher of its own
// (ui-server.mjs LAUNCHER_MODE=1, a free UI_PORT, a throw-away profile dir) starts a Test Random game whose spawn village
// is the bundle's village (GAMEMODELS_TEST_VILLAGE + TEST_NEAR_VILLAGE: the roster starts by it; a building: inside).
// An NPC: peer.mjs spawns one unit of it 5–7 hexes from player-1 (GAMEMODELS_TEST_NPC), and the swarm bot walks
// player-1 to it and asks each of its questions once (SWARM_VISIT_NPC; never "hire" or a build order).
// Pass (an NPC) = it spawned, answered at least one question, 0 engine errors, 0 state divergences; its agenda steps and
// quests handed in are counted and reported (a quest needs the right card in the archive — seldom in 3 minutes).
// Pass (a building) = its village was found with the building in its layout, 0 errors, 0 divergences (a building
// writes no log line of its own — the result says so).
// A monster: foe-1 is that creature (TEST_FOES, its card from the test's catalog); the bot hunts it. Pass = foe-1 booted
// with it ("monster deck: <id>"), it fought (a chase, a cast, a hit, a kill, or it died), 0 errors, 0 divergences.
// --review: the 8B (genConfig of --llm-file, default <profile dir>/llm.json: the desktop's own Qwen3-8B, else OCI's) reads the
// bundle + the conversation and returns a VERDICT (good | needs_work) + suggestions (gm-gen.mjs reviewGameModel). GameModels
// have no rebalance check — the GameModels check, this verdict and the players' votes are their gate.
// Status lines "[test] m:ss …" every --every seconds; the last line is "[test] RESULT <json>". Exit 0 pass, 1 fail, 2 could not run.
// Peers sit on 7801+ (LAUNCH_PORT_BASE), never 7357 / 7401 / 7392 / 7393; only the processes it started are stopped.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { genConfig, mmss } from '../effect-gen.mjs';
import { profileDir } from '../profile.mjs';
import { loadGameModels, compileCatalog, GAMEMODELS_DIR } from '../gamemodels.mjs';
import { overlay, BUNDLE_SCHEMA, reviewGameModel, checkBundle } from '../gm-gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = {}; const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); if (['minutes', 'out', 'every', 'games', 'llm-file'].includes(k)) opt[k] = args[++i]; else opt[k] = true; }
  else words.push(args[i]);
}
const t0 = Date.now();
const say = (t) => console.log(`[test] ${mmss(Date.now() - t0)} ${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bail = (t) => { console.log(`[test] ${t}`); console.log(`[test] RESULT ${JSON.stringify({ pass: false, why: [t], at: new Date().toISOString() })}`); process.exit(2); };

const bundleFile = path.resolve(words[0] || '');
let b;
try { b = JSON.parse(fs.readFileSync(bundleFile, 'utf8')); } catch (e) { bail(`cannot read the draft ${bundleFile}: ${e.message}`); }
if (b?.schema !== BUNDLE_SCHEMA || !(b.npc || b.building || b.monster)) bail('the draft is not a GameModels bundle (npc / building / monster)');
if (!GAMEMODELS_DIR) bail('no chaosD6-GameModels checkout on this node');
const KIND = b.npc ? 'npc' : b.building ? 'building' : 'monster';
const DEF = b.npc || b.building || b.monster;
const ID = String(DEF.id || '');
const VILLAGE = b.place?.village || '';
if (!VILLAGE && KIND !== 'monster') bail(`${ID} is placed in no village — nothing to test`);
const minutes = Math.max(1, Math.min(15, Number(opt.minutes) || 3));
const maxGames = Math.max(1, Math.min(4, Number(opt.games) || 2));
const everyMs = Math.max(2, Number(opt.every) || 10) * 1000;

// ---- the test's own catalog: the repo + the bundle ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-gmtest-'));
const catalogFile = path.join(tmp, 'catalog.json');
let catalog;
try {
  const m = overlay(loadGameModels(GAMEMODELS_DIR), b);
  catalog = compileCatalog(m);
  fs.writeFileSync(catalogFile, JSON.stringify(catalog) + '\n');
} catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); bail(`the catalog does not compile with the draft: ${e.message}`); }
if (KIND === 'monster' && !(catalog.creatures?.entries || []).some(x => x.id === ID)) { fs.rmSync(tmp, { recursive: true, force: true }); bail(`${ID} is not a creature of the compiled catalog`); }
if (KIND !== 'monster' && !catalog.villages?.[VILLAGE]) { fs.rmSync(tmp, { recursive: true, force: true }); bail(`no village template ${VILLAGE} in the catalog`); }
// a building: is it in its village's layout (the test village is that template)?
const inLayout = KIND === 'building' && JSON.stringify(catalog.villages[VILLAGE].layout || []).includes(`"${ID}"`);

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// ---- log scan (peer.mjs lines) ----
//   "test npc: <name> (<id>) of <team> at (q,r)"           player-1 spawned the unit of the draft
//   "talk with <name>: "<ask>" → "<text>""                  player-1 asked, the NPC answered (name = "<npc> of <village>")
//   "agenda (<role>): <rule> → <goal>"                       the NPC's own peer (label test_npc_<id>) chose a step
//   "quest done: <quest> for <giver> (<team>) — …"          a quest of the draft handed in
//   "village: <team> of the <race> found at …"               the spawn village came up
const ERR_RE = /Uncaught|UNCAUGHT|UNHANDLED|TypeError|ReferenceError|SyntaxError|RangeError|GAMEMODELS_TEST_NPC: no npc|GAMEMODELS_TEST_VILLAGE: no village|village tick: /;
const NAME = String(DEF.name || ID);
const QUEST_NAMES = (b.quests || []).map(q => q.name).filter(Boolean);
const NPC_LABEL = `test_npc_${ID.replace(/[^a-z0-9]+/gi, '_')}`;
const EMPTY = () => ({ spawned: false, talks: 0, agenda: 0, quests: 0, village: false, booted: false, chases: 0, casts: 0, hits: 0, kills: 0, monsterDied: false, errors: 0, divergences: 0, died: false, errorLines: [], lines: [], talk: [] });
function scan(logs) {
  const out = EMPTY();
  let files = [];
  try { files = fs.readdirSync(logs).filter(f => f.endsWith('.log') && !f.endsWith('.ui.log')); } catch { return out; }
  const talkRe = new RegExp(`\\] talk with ${esc(NAME)}\\b[^:]*: "(.*)" → "(.*)"$`);
  const agRe = new RegExp(`\\[${esc(NPC_LABEL)}\\] agenda \\(`);
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(logs, f), 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (ERR_RE.test(line)) { out.errors++; if (out.errorLines.length < 8) out.errorLines.push(`${f}: ${line.slice(0, 240)}`); }
      if (line.includes('STATE DIVERGENCE')) out.divergences++;
      if (line.includes('[player-1] DIED at')) out.died = true;
      const mine = line.includes('[player-1] ');
      if (KIND === 'monster') {
        const foe = line.includes('[foe-1] ');
        const keepM = () => { if (out.lines.length < 60) out.lines.push(line.slice(line.indexOf('['), line.indexOf('[') + 260)); };
        if (foe && line.includes(`] monster deck: ${ID} `)) { out.booted = true; keepM(); }
        else if (foe && line.includes('] chase: ')) { out.chases++; keepM(); }
        else if (foe && line.includes('] monster cast: start ')) { out.casts++; keepM(); }
        else if (foe && /\] cast \S+ \[.*peer:foe-1 → .*→ ([1-9]\d*) dmg/.test(line)) { out.hits++; keepM(); }
        else if (foe && line.includes('] DIED at ')) { out.monsterDied = true; keepM(); }
        else if (!foe && line.includes('] death cause: ') && line.includes(`from ${NAME}`)) { out.kills++; keepM(); }
        continue;
      }
      const keep = () => { if (out.lines.length < 60) out.lines.push(line.slice(line.indexOf('['), line.indexOf('[') + 260)); };
      if (mine && line.includes(`] test npc: `) && line.includes(`(${ID})`)) { out.spawned = true; keep(); continue; }
      if (/] village: .* found at /.test(line)) { if (!out.village) keep(); out.village = true; continue; }
      const t = mine ? talkRe.exec(line) : null;
      if (t) { out.talks++; if (out.talk.length < 24) out.talk.push({ ask: t[1].slice(0, 200), answer: t[2].slice(0, 500) }); keep(); continue; }
      if (agRe.test(line)) { out.agenda++; if (out.agenda <= 12) keep(); continue; }
      if (mine && line.includes('] quest done: ') && QUEST_NAMES.some(n => line.includes(`quest done: ${n} for`))) { out.quests++; keep(); }
    }
  }
  return out;
}
const add = (a, s) => ({ booted: a.booted || s.booted, chases: a.chases + s.chases, casts: a.casts + s.casts, hits: a.hits + s.hits, kills: a.kills + s.kills, monsterDied: a.monsterDied || s.monsterDied,
  spawned: a.spawned || s.spawned, talks: a.talks + s.talks, agenda: a.agenda + s.agenda, quests: a.quests + s.quests, village: a.village || s.village,
  errors: a.errors + s.errors, divergences: a.divergences + s.divergences, died: s.died,
  errorLines: [...a.errorLines, ...s.errorLines].slice(0, 8), lines: [...a.lines, ...s.lines].slice(0, 60), talk: [...a.talk, ...s.talk].slice(0, 24) });
const fought = (s) => s.chases + s.casts + s.hits + s.kills > 0 || s.monsterDied;
const brief = (s) => KIND === 'monster'
  ? `${s.booted ? 'in the game' : 'not in the game yet'} · chases ${s.chases}, casts ${s.casts}, hits ${s.hits}, kills ${s.kills}${s.monsterDied ? ', died' : ''} · errors ${s.errors} · divergences ${s.divergences}`
  : KIND === 'npc'
  ? `${s.spawned ? 'spawned' : 'not spawned yet'} · answers ${s.talks}, agenda steps ${s.agenda}, quests ${s.quests} · errors ${s.errors} · divergences ${s.divergences}`
  : `village ${s.village ? 'found' : 'not found yet'} · errors ${s.errors} · divergences ${s.divergences}`;

let live = null;   // { launcher, swarm, dim }
function stopGame() {
  if (!live) return;
  const { launcher, swarm, dim } = live; live = null;
  try { swarm?.kill('SIGTERM'); } catch {}
  try { process.kill(-launcher.pid, 'SIGTERM'); } catch {}
  for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('.mjs')) continue;
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`DIM_NAME=${dim}`)) process.kill(Number(pid), 'SIGTERM');
    } catch {}
  }
  setTimeout(() => { try { process.kill(-launcher.pid, 'SIGKILL'); } catch {} }, 3000).unref();
}
process.on('SIGINT', () => { stopGame(); process.exit(130); });
process.on('SIGTERM', () => { stopGame(); process.exit(143); });

async function runGame(n, before) {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const dim = `GenTest-${ID.replace(/^(npc|bld)_/, '').replace(/_/g, '-').slice(0, 30)}-${stamp}`;
  const logs = path.join(GAME, 'logs', slug(dim));
  const port = await freePort();
  const env = {
    ...process.env, LAUNCHER_MODE: '1', UI_PORT: String(port), CHAOSD6_PROFILE_DIR: path.join(tmp, `profile-${n}`),
    CHAOSD6_DEFS_CACHE_ROOT: path.join(tmp, `defs-${n}`),
    GAMEMODELS_CATALOG_FILE: catalogFile,
    ...(KIND === 'monster' ? { TEST_FOES: ID } : { GAMEMODELS_TEST_VILLAGE: VILLAGE, TEST_NEAR_VILLAGE: KIND === 'building' ? 'inside' : '1' }),
    ...(KIND === 'npc' ? { GAMEMODELS_TEST_NPC: ID, SWARM_VISIT_NPC: ID } : {}),
    AI_SKIRMISH: '0', NOSTR_ENABLED: '0',
    LAUNCH_PORT_BASE: process.env.GEN_TEST_PORT_BASE || '7801',
  };
  if (KIND !== 'monster') delete env.TEST_FOES;
  for (const k of ['FORCE_EFFECTS', 'FORCE_SKILLS', 'FORCE_CLASS', 'FOREIGN_REFUSERS', 'LLM_URL', 'FORCE_FOREIGN_EFFECT', 'FORCE_FOREIGN_SKILL', 'FORCE_FOREIGN_CLASS', 'SWARM_PREFER_EFFECT', 'SWARM_PREFER_SKILL']) delete env[k];
  if (KIND !== 'npc') { delete env.GAMEMODELS_TEST_NPC; delete env.SWARM_VISIT_NPC; }
  fs.mkdirSync(env.CHAOSD6_PROFILE_DIR, { recursive: true });
  const launcherLog = fs.openSync(path.join(tmp, `launcher-${n}.log`), 'a');
  const launcher = spawn(process.execPath, ['ui-server.mjs'], { cwd: GAME, env, detached: true, stdio: ['ignore', launcherLog, launcherLog] });
  live = { launcher, swarm: null, dim };
  say(`game ${n}/${maxGames}: starting a private test game ${dim} (launcher :${port}, ${minutes} min, ${KIND === 'npc' ? `${NAME} near player-1` : KIND === 'monster' ? `${NAME} as foe-1` : `${NAME} in the spawn village`})`);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try { up = (await fetch(`http://127.0.0.1:${port}/`)).status > 0; } catch {}
  }
  if (!up) { stopGame(); return { code: -1, s: EMPTY(), dim, logs, phase: 'launcher did not start', talksSent: 0 }; }
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
    const s = add(before, scan(logs));
    let p = phase;
    if (phase === 'playing' && playAt) { const el = Date.now() - playAt, tot = minutes * 60_000; p = `playing ${mmss(el)}/${mmss(tot)} (${Math.min(99, Math.round(100 * el / tot))}%)`; }
    say(`game ${n}/${maxGames} ${p} · ${brief(s)}`);
  }, everyMs);
  const code = await new Promise((resolve) => swarm.on('exit', (c) => resolve(c)));
  clearInterval(ticker);
  const agentLine = swarmOut.find(l => /agents stopped/.test(l)) || '';
  const talksSent = Number((/player-1 [^;]*? talks (\d+)/.exec(agentLine) || [])[1] || 0);
  stopGame();
  await sleep(1500);   // the last log lines
  return { code, s: scan(logs), dim, logs, phase, talksSent };
}

let total = EMPTY(), games = [], lastCode = 0, lastPhase = '', talksSent = 0;
for (let n = 1; n <= maxGames; n++) {
  const g = await runGame(n, total);
  total = add(total, g.s); lastCode = g.code; lastPhase = g.phase; talksSent += g.talksSent;
  games.push({ dimension: g.dim, logs: path.relative(GAME, g.logs), talks: g.s.talks, died: g.s.died, code: g.code });
  if (g.code !== 0 || total.errors || total.divergences) break;
  if (KIND === 'building' || (total.spawned && total.talks >= 1) || (KIND === 'monster' && total.booted && fought(total))) break;
  if (!g.s.died) break;   // alive the whole game and still nothing: another game would not be fairer
  if (n < maxGames) say(`player-1 died before it ${KIND === 'monster' ? `met ${NAME}` : `talked with ${NAME}`} — another game`);
}
const s = total;
const why = [];
if (lastCode !== 0) why.push(`the test game ended with code ${lastCode}${lastPhase === 'host failed' || lastPhase === 'launcher did not start' ? ` (${lastPhase === 'host failed' ? 'the game did not start' : lastPhase})` : ''}`);
if (KIND === 'npc') {
  if (!s.spawned) why.push(`${NAME} never spawned near player-1 (no "test npc:" line)`);
  else if (!s.talks) why.push(`${NAME} answered no question${talksSent ? ` (player-1 asked ${talksSent} time(s))` : ' — player-1 never got within talk range'}${s.died ? '; player-1 died' : ''}`);
} else if (KIND === 'monster') {
  if (!s.booted) why.push(`foe-1 did not start as ${ID} (no "monster deck: ${ID}" line)`);
  else if (!fought(s)) why.push(`${NAME} never fought (no chase, cast, hit or death)${s.died ? ' — player-1 died first' : ''}`);
} else {
  if (!inLayout) why.push(`${ID} is not in the layout of ${VILLAGE}`);
  if (!s.village) why.push(`the spawn village (${VILLAGE}) never came up (no "village: … found" line)`);
}
if (s.errors) why.push(`${s.errors} engine error line(s)`);
if (s.divergences) why.push(`${s.divergences} state divergence(s)`);
const pass = lastCode === 0 && s.errors === 0 && s.divergences === 0 && (KIND === 'npc' ? s.spawned && s.talks >= 1 : KIND === 'monster' ? s.booted && fought(s) : inLayout && s.village);
const notes = [];
if (KIND === 'npc' && pass && !s.agenda) notes.push('no agenda step seen (the NPC stood still)');
if (KIND === 'npc' && (b.quests || []).length && !s.quests) notes.push('no quest handed in (it needs the right card in the archive — not part of the pass)');
if (KIND === 'building') notes.push('a building writes no log line of its own — placed in the layout, the village came up, 0 errors and 0 divergences are what this test can show');
say(`${pass ? 'PASS' : 'FAIL'} · ${brief(s)}${why.length ? ` — ${why.join('; ')}` : ''}${notes.length ? ` (${notes.join('; ')})` : ''}`);

// ---- the 8B's review: a verdict (good | needs_work) + suggestions (gm-gen.mjs reviewGameModel) ----
let review = null;
if (opt.review) {
  const cfg = genConfig(process.env, { file: opt['llm-file'] ? path.resolve(String(opt['llm-file'])) : path.join(profileDir(), 'llm.json') });
  say(`asking the 8B (${cfg.model}${cfg.url ? '' : ', not configured'}) for its review`);
  let check = null;
  try { check = checkBundle(b).check; } catch {}
  review = await reviewGameModel(b, { cfg, check, test: { pass, why, ...s, error_lines: s.errorLines } });
  say(review.error ? `review: ${review.error}` : `review: ${review.verdict === 'good' ? 'GOOD' : 'NEEDS WORK'} — ${review.summary}`);
}
const last = games.at(-1) || {};
finish({ kind: KIND, pass, why, notes, ...s, in_layout: KIND === 'building' ? inLayout : undefined, talks_sent: talksSent, minutes, games, dimension: last.dimension, logs: last.logs, review }, pass ? 0 : lastCode === -1 ? 2 : 1);

function finish(result, exit) {
  const out = { id: ID, at: new Date().toISOString(), ms: Date.now() - t0, ...result };
  if (opt.out) { try { fs.writeFileSync(opt.out, JSON.stringify(out, null, 2) + '\n'); } catch {} }
  console.log(`[test] RESULT ${JSON.stringify(out)}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(exit), 3200);
}
