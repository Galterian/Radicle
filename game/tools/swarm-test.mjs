// Swarm test: host a fresh dimension through a launcher, join extra players and
// monsters until there are 5 players + 4 monsters (+ the roster ally), drive
// every player with an autonomous agent for a while, and audit consistency:
// does every peer agree on where everyone is, how much life they have, and
// how big the map is — and did any peer log a STATE DIVERGENCE?
//
//   node tools/swarm-test.mjs [launcherUrl=http://127.0.0.1:7357] [minutes=4] [dimension=Swarm-<hhmm>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnownMap, initialBlock } from '../js/map.js';
import { hexDistance } from '../js/hex.js';
import { biomeFor } from '../js/biome.js';
import { featureAt as buildingFeatureAt, isBuildingFeature, isLabyrinthWallAt, setFeatureCatalog } from '../js/features.js';
import { setBigFeatureCatalog } from '../js/bigfeature.js';
import { fortressAt } from '../js/building-bonus.js';
import { parseClassState, anyChargeUsed } from '../class-state.mjs';
import { loadClassDefs, abilityRecordsOf } from '../class-engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = process.argv[2] || 'http://127.0.0.1:7357';
// Optional second launcher (identity B, separate clone — tools/start-b.sh). One
// player joins through it, which exercises Doors read across namespaces and
// the joiner map seeding from another clone.
const launcherC = process.env.LAUNCHER_C || '';
const minutes = Number(process.argv[3] || 4);
const now = new Date();
const DIM = process.argv[4] || `Swarm-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Teams as peer.mjs sideOf(): A = player/npc_a, B = npc_b, C = player_c/npc_c, D = player_d/npc_d.
const sideOf = a => (a === 'player' || a === 'npc_a') ? 'A' : a === 'npc_b' ? 'B' : (a === 'player_c' || a === 'npc_c') ? 'C' : (a === 'player_d' || a === 'npc_d') ? 'D' : a;
// Class colours (user ruling 2026-10-30): the agents strike an adjacent enemy's class colour by colour and use
// their own class ability, so the swarm exercises both resolver paths. Canonical data only.
const readData = (f) => JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'data', f), 'utf8'));
const canon = (e) => e.versions.find(v => v.status === 'canonical') || e.versions[e.versions.length - 1];
const ELEM_TO_STAT = Object.fromEntries(readData('elements.json').entries.map(e => [e.id, (canon(e).data?.stat || '').replace(/^stat_/, '')]));
const CLASS_COLOURS = Object.fromEntries(readData('classes.json').entries.map(e => { const cols = {}; for (const el of canon(e).data?.colors || []) { const st = ELEM_TO_STAT[el]; if (st) (cols[st] ||= []).push(el); } return [e.id, cols]; }));
// Building catalogues (same lookup as peer.mjs): the bots look for buildings / fortresses next to them
// (Animator source, Cleric / Rogue world traps) with the same pure (seed, q, r) functions the resolver uses.
for (const [rel, set] of [['features/feature_table.json', setFeatureCatalog], ['terrain_bigfeatures/bigfeature_table.json', setBigFeatureCatalog]]) {
  const hit = [path.resolve(here, '..', 'js', 'catalog', path.basename(rel)), path.resolve(here, '..', '..', 'assets', rel)].find(f => fs.existsSync(f));
  if (hit) { try { set(JSON.parse(fs.readFileSync(hit, 'utf8'))); } catch {} }
}
const hexesWithin = (c, R) => { const out = []; for (let dq = -R; dq <= R; dq++) for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) out.push({ q: c.q + dq, r: c.r + dr }); return out; };
const _bldMemo = new Map();
// 'b' plain building, 'f' standing fortress (blocks the hex), '' nothing.
const buildingKind = (seed, q, r) => {
  const k = `${seed}:${q},${r}`;
  if (!_bldMemo.has(k)) { const f = buildingFeatureAt(seed, q, r); _bldMemo.set(k, !isBuildingFeature(f) ? '' : fortressAt(seed, q, r) ? 'f' : 'b'); }
  return _bldMemo.get(k);
};
// Buildings within R of c, nearest first (fortress: only with withFortress).
const buildingsNear = (seed, c, R, withFortress = false) => hexesWithin(c, R).filter(h => { const b = buildingKind(seed, h.q, h.r); return b === 'b' || (withFortress && b === 'f'); })
  .map(h => ({ ...h, d: hexDistance(c, h) })).sort((x, y) => x.d - y.d || x.q - y.q || x.r - y.r);
const walkableAt = (seed, q, r) => { try { return biomeFor(seed).isWalkable(q, r) && !isLabyrinthWallAt(seed, q, r) && buildingKind(seed, q, r) !== 'f'; } catch { return false; } };
// Generic bot planner (class isolation phase 5, user ruling 2026-11-20 #2 — no per-class bot block): what a class
// wants is inferred from its definition: flags.needs, the data knobs (near, place_range, range, lure_range,
// disable_range), its hooks (step / dungeon_step = trap-aware, contact / combat_in = wants contact) and the ability
// records its program can give (copy_building, build, disable_traps, …: class-engine.mjs#abilityRecordsOf). A class
// outside the bundle (foreign) falls back to needs + kind. What took effect is counted from the peers'
// `[class-event] {"class", "kind"}` lines (peer.mjs classEventLine), not from a regex per class.
const CLASS_DEFS = (() => { try { return loadClassDefs(undefined, { lenient: true }).defs; } catch { return new Map(); } })();
const _profiles = new Map();
const classProfile = (cid) => {
  if (!_profiles.has(cid)) {
    const d = CLASS_DEFS.get(cid), hooks = new Set(d?.flags?.hooks || []), recs = new Set(d ? abilityRecordsOf(d) : []);
    _profiles.set(cid, { recs, data: d?.data || {},
      trapAware: hooks.has('step') || hooks.has('dungeon_step') || recs.has('disable_traps'),
      wantsContact: hooks.has('contact') || hooks.has('combat_in'),
      places: recs.has('copy_building') || recs.has('build') });   // a tile click where a building rises
  }
  return _profiles.get(cid);
};
// FORCE_CLASS round-robin (tools/swarm-run.sh exports FORCE_CLASS_LABELS; peer.mjs applies it). Logged once.
const FORCED_CLASSES = (process.env.FORCE_CLASS || '').split(',').map(s => s.trim()).filter(Boolean);
const FORCED_LABELS = (process.env.FORCE_CLASS_LABELS || '').split(',').map(s => s.trim()).filter(Boolean);

async function api(route, body, base = launcher) {
  const r = await fetch(`${base}${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return r.json();
}
async function status(port) {
  try { return await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()); } catch { return null; }
}

// ---- 3. agents ----
// Agents start the moment their peer is up (a player left idle for two minutes
// while the others join just gets eaten by the monsters at spawn).
const agents = [];
function startAgent(peerId, port, attempt = 0) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const a = { peerId, port, ws, map: createKnownMap('0x0', [initialBlock()]), peers: new Map(), me: null, hand: [], rounds: 0, attacks: 0, moves: 0, skillsPlayed: 0, trances: 0, dest: null };
  const send = o => { try { ws.send(JSON.stringify(o)); } catch {} };
  ws.onclose = () => { if (!a.me && attempt < 10) setTimeout(() => startAgent(peerId, port, attempt + 1), 2000); };
  const isAction = c => !!c && c.kind === 'action';
  const isSkill = c => !!c && c.kind === 'skill';
  // Skill indices riding on the given action codes (trance itself excluded).
  const skillsFor = (...codes) => a.hand.map((c, i) => isSkill(c) && !c.is_trance && codes.includes(c.requires) ? i : -1).filter(i => i >= 0);
  // a.reserved: the card id the Seeker attached this action — no other pick may cast it.
  const isEffect = c => !!c && c.kind === 'effect' && c.card_id !== a.reserved;
  const queue = (slot, skills = [], extra = null, effect = null) => {
    send({ kind: 'queue', slots: [slot], skills, extra, effect });
    a.skillsPlayed += skills.filter(i => !a.hand[i]?.is_trance).length;
    if (effect !== null) a.effectsCast = (a.effectsCast || 0) + 1;
  };
  // ---- My class ability (2026-11-15): use it whenever it is ready and its precondition holds ----
  // The reveal's classAbility carries the action's raw target, so only the classes whose click raises a building on a tile
  // shape the action; every other class just clicks and lets the normal pick below decide the action.
  // Returns { goal, goalP, act }: goal = a hex worth walking to for the precondition (taken with chance goalP
  // by the movement code), act = this action is already queued + locked. Skips are counted per class+reason
  // (a.classSkip) and printed in the summary.
  const skipClass = (cid, why) => { const k = `${String(cid).replace('class_', '')}:${why}`; (a.classSkip ||= {})[k] = (a.classSkip[k] || 0) + 1; };
  const useClass = (cid, extra = {}) => {
    if (extra.attach !== undefined) send({ kind: 'attach', slot: extra.attach });
    send({ kind: 'class_ability' });
    a.queuedClass = true;
    a.classUses = (a.classUses || 0) + 1;
    (a.classUseBy ||= {})[cid] = (a.classUseBy[cid] || 0) + 1;
  };
  // A free hex for a new building (Animator: next to me, Priest: ≤ 2), farthest band first so an Empty Move
  // toward it does not end on it. Known, walkable, no building, nobody standing there.
  const buildHexNear = (me, R) => {
    const seed = a.map.seed, here = { q: me.tile_q, r: me.tile_r };
    const occ = new Set([...a.peers.values()].filter(p => (p.life ?? 1) > 0 && Number.isInteger(p.tile_q)).map(p => `${p.tile_q},${p.tile_r}`));
    const c = hexesWithin(here, R).filter(h => { const d = hexDistance(here, h); return d >= 1 && a.map.has?.(h.q, h.r) !== false && walkableAt(seed, h.q, h.r) && !buildingKind(seed, h.q, h.r) && !occ.has(`${h.q},${h.r}`); });
    if (!c.length) return null;
    const far = c.filter(h => hexDistance(here, h) === R);
    const pool = far.length ? far : c;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const botClassPolicy = (turn, me, enemies, foeTraps, dist) => {
    const cs = a.classState, cid = cs?.class_id;
    const out = { goal: null, goalP: 0, act: false };
    if (!cid) return out;
    const seed = a.map.seed, here = { q: me.tile_q, r: me.tile_r };
    const hexD = (t) => hexDistance(here, t);
    const slotOf = code => a.hand.findIndex(c => isAction(c) && c.code === code);
    const wild = [...a.peers.values()].filter(p => p.peer_id !== peerId && sideOf(p.alliance) !== sideOf(me.alliance) && (p.life ?? 0) > 0 && Number.isInteger(p.tile_q)
      && (p.monster_state === 'sleeping' || p.monster_state === 'awake') && !p.owner_peer_id).sort((x, y) => dist(x) - dist(y));
    // Steering goals (also for passive classes and while not ready — the walk sets the precondition up).
    const pf = classProfile(cid), D = pf.data, needs = cs.needs;
    if (pf.recs.has('copy_building')) { const b = buildingsNear(seed, here, 12, true).find(b => b.d > (D.near ?? 2)); if (b) { out.goal = b; out.goalP = 0.7; } }
    else if (pf.recs.has('disable_traps')) { const R = D.disable_range ?? 3, t = foeTraps.find(t => t.d > R && t.d <= 10) || buildingsNear(seed, here, 10).find(b => b.d > R); if (t) { out.goal = { q: t.q, r: t.r }; out.goalP = 0.6; } }
    else if (pf.trapAware) { const t = foeTraps.find(t => t.d >= 1 && t.d <= 8) || buildingsNear(seed, here, 8).find(b => b.d >= 1); if (t) { out.goal = { q: t.q, r: t.r }; out.goalP = 0.5; } }
    if (needs === 'monster_near' && (!wild.length || dist(wild[0]) > (D.lure_range ?? 10))) { const w = wild.find(p => dist(p) <= 25); if (w) { out.goal = { q: w.tile_q, r: w.tile_r }; out.goalP = 0.6; } }
    if ((needs === 'enemy_near' || pf.wantsContact) && enemies[0] && dist(enemies[0]) > 1) { out.goal = { q: enemies[0].tile_q, r: enemies[0].tile_r }; out.goalP = 0.8; }
    // Readiness.
    if (cs.kind === 'passive' || cs.kind === 'static') return out;   // fires by itself
    if (cs.archived) { skipClass(cid, 'archived'); return out; }
    if (cs.kind === 'tap' ? cs.tapped : cs.used_turn === turn) { skipClass(cid, cs.kind === 'tap' ? 'tapped' : 'used_this_turn'); return out; }
    if (cs.blocked) { skipClass(cid, 'blocked'); return out; }
    if (a.queuedClass) { skipClass(cid, 'already_queued'); return out; }
    // Preconditions.
    if (needs === 'enemy_near') {
      const R = D.range ?? 3;
      if (!enemies.some(p => dist(p) <= R)) { skipClass(cid, `no_enemy_${R}`); return out; }
      useClass(cid); return out;
    }
    if (needs === 'monster_near') {
      const R = D.lure_range ?? 10;
      if (!wild.some(p => dist(p) <= R)) { skipClass(cid, `no_wild_${R}`); return out; }
      useClass(cid); return out;
    }
    if (pf.recs.has('disable_traps')) {
      // Laid enemy traps are in the snapshots; world traps hide in buildings / dungeons (unknown to the bot) — try there too.
      const R = D.disable_range ?? 3;
      if (!foeTraps.some(t => t.d <= R) && !buildingsNear(seed, here, R).length) { skipClass(cid, `no_trap_${R}`); return out; }
      useClass(cid); return out;
    }
    if (needs === 'attach_effect' || needs === 'attach_nonaction') {
      const busy = new Set(a.casting?.card_ids || []);
      const ok = (c) => !!c && !busy.has(c.card_id) && (needs === 'attach_effect' ? c.kind === 'effect' : c.kind !== 'action');
      let i = a.hand.findIndex(c => ok(c) && c.effect_id !== 'effect_invisibility');
      if (i < 0) i = a.hand.findIndex(ok);
      if (i < 0) { skipClass(cid, 'no_effect_card'); return out; }
      useClass(cid, { attach: i }); a.reserved = a.hand[i].card_id; return out;
    }
    if (pf.recs.has('copy_building') && !buildingsNear(seed, here, D.near ?? 2, true).length) { skipClass(cid, `no_building_${D.near ?? 2}`); return out; }
    if (needs === 'tile' && pf.places) {
      useClass(cid);
      if (a.casting?.card_ids?.length) return out;   // keep the cast going (Rule 19); the peer picks a random free hex
      const R = D.place_range ?? 1;
      const t = buildHexNear(me, R);
      const p = slotOf('P');
      // A Posture keeps me in place and carries the tile as the ability target; without one an Empty Move toward
      // a hex R ≥ 2 away still leaves it free; else an Empty Posture (no target → a random free hex).
      if (t && p >= 0) { queue(p, skillsFor('P')); send({ kind: 'target', target: { q: t.q, r: t.r } }); a.animatorPicks = (a.animatorPicks || 0) + 1; }
      else if (t && R >= 2 && hexD(t) === R) { queue('EMPTY', skillsFor('M', 'P')); send({ kind: 'target', target: { q: t.q, r: t.r } }); a.animatorPicks = (a.animatorPicks || 0) + 1; }
      else { queue('EMPTY', skillsFor('P')); send({ kind: 'target', target: null }); }
      send({ kind: 'lock' });
      out.act = true; return out;
    }
    // Everything else (no needs the bot can check) — just click.
    useClass(cid); return out;
  };
  // Fortress stat buy (2026-11-14): standing within reach of a fortress (hand msg `fortresses`) → emit its stat
  // (the peer stages the Posture). BOT_FORTRESS=1: always, and walk to the nearest fortress when no enemy is close.
  const botFortressBuy = (me, near, dist) => {
    const fz = (a.fortresses || [])[0];
    if (!fz) return false;
    const keen = process.env.BOT_FORTRESS === '1';
    if (fz.near && (!near || dist(near) > 1) && Math.random() < (keen ? 0.95 : 0.4)) {
      send({ kind: 'destroy', stat: fz.stat, building: fz.building }); send({ kind: 'lock' });
      a.fortressBuys = (a.fortressBuys || 0) + 1;
      return true;
    }
    if (keen && !fz.near && (!near || dist(near) > 3)) {
      // The fortress hex itself blocks: walk to its neighbour nearest to me.
      const step = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map(([dq, dr]) => ({ q: fz.q + dq, r: fz.r + dr }))
        .sort((x, y) => hexDistance({ q: me.tile_q, r: me.tile_r }, x) - hexDistance({ q: me.tile_q, r: me.tile_r }, y))[0];
      queue('EMPTY', skillsFor('M', 'P'));
      send({ kind: 'target', target: step }); send({ kind: 'lock' });
      a.moves++;
      return true;
    }
    return false;
  };
  // Rule 24 stat of each natural permanent (its element_cost, data/effects.json): what an emission against it must use.
  const NATURAL_STAT = { effect_earthquake: 'matter', effect_creation: 'matter', effect_spirit_link: 'world', effect_love: 'matter', effect_awe: 'matter', effect_fear: 'matter', effect_anger: 'matter', effect_domination: 'world', effect_petrify: 'vitality', effect_mists: 'matter' };
  const plan = (turn, round) => {
    const me = a.peers.get(peerId);
    if (!me || (me.life ?? 1) <= 0) return;
    // Phylactery (user ruling 2026-11-17): click it as soon as the peer reports an enemy permanent in reach.
    if (a.phylTarget && !a.queuedPhyl) { send({ kind: 'phylactery' }); a.queuedPhyl = true; a.phylClicks = (a.phylClicks || 0) + 1; console.log(`[swarm] ${peerId.slice(0, 14)} clicks the Phylactery → ${a.phylTarget.name}'s ${a.phylTarget.perm}`); }
    // Dimension Out running (SWARM_DIMOUT): hold still with Empty Posture — a move, attack or cast would cancel it.
    if (Number(me.dim_out_until_turn ?? -1) >= 0) { queue('EMPTY', []); send({ kind: 'target', target: null }); a.dimOutHolds = (a.dimOutHolds || 0) + 1; return; }
    a.reserved = null;
    const dist = p => hexDistance({ q: me.tile_q, r: me.tile_r }, { q: p.tile_q, r: p.tile_r });
    // A Rogue who spent the threat charge this turn (stealth_turn) is not chased unless already adjacent (user ruling 2026-11-14).
    // Invisibility (user ruling 2026-11-14): an invisible enemy is not seen (unless I am invisible too).
    const invisOf = p => String(p?.permanents_csv || '').split(',').includes('effect_invisibility');
    const amInvis = invisOf(me);
    const enemies = [...a.peers.values()].filter(p => p.peer_id !== peerId && sideOf(p.alliance) !== sideOf(me.alliance) && p.life > 0 && Number.isInteger(p.tile_q) && !(anyChargeUsed(parseClassState(p.class_state_json), 'threat', turn) && dist(p) > 1) && !(invisOf(p) && !amInvis));
    // Rogue / Cleric (user rulings 2026-11-14): enemy enter-traps the bot can see in the peers' snapshots.
    const myClass = a.classState?.class_id || null, myProfile = myClass ? classProfile(myClass) : null;
    const foeTraps = myProfile?.trapAware ? [...a.peers.values()].filter(p => p.peer_id !== peerId && sideOf(p.alliance) !== sideOf(me.alliance))
      .flatMap(p => { try { return JSON.parse(p.traps_json || '[]'); } catch { return []; } }).filter(t => Number.isInteger(t.q) && Number.isInteger(t.r))
      .map(t => ({ ...t, d: hexDistance({ q: me.tile_q, r: me.tile_r }, { q: t.q, r: t.r }) })).sort((x, y) => x.d - y.d) : [];
    enemies.sort((x, y) => dist(x) - dist(y));
    const near = enemies[0];
    const slotOf = code => a.hand.findIndex(c => isAction(c) && c.code === code);
    const actionIdx = a.hand.map((c, i) => isAction(c) ? i : -1).filter(i => i >= 0);
    // Recast / untap my own class when it is owed (a Posture emission — Invisibility survives it). A tapped
    // ability is what keeps a tap class from firing again, so untap eagerly.
    const cs = a.classState || null;
    if (cs && (cs.archived || cs.tapped) && !a.casting?.card_ids?.length && Math.random() < (cs.archived ? 0.5 : 0.8)) {
      const owed = Object.keys(cs.colours || {}).filter(s => !(cs.progress?.done || []).includes(s));
      if (owed.length) { send({ kind: 'destroy', stat: owed[0], ...(cs.archived ? { recast: true } : { untap: true }) }); if (near) send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' }); a.classRecasts = (a.classRecasts || 0) + 1; return; }
    }
    // My class ability whenever it is ready (also while invisible — a class ability does not break it).
    const cp = botClassPolicy(turn, me, enemies, foeTraps, dist);
    if (cp.act) return;
    const classGoal = cp.goal && Math.random() < cp.goalP && hexDistance({ q: me.tile_q, r: me.tile_r }, cp.goal) >= 1 ? cp.goal : null;
    if (classGoal) a.classWalks = (a.classWalks || 0) + 1;
    // Invisible: keep moving (Move / Empty Move toward the nearest enemy, else wander); in contact, now and
    // then break it with an Attack / Block so the drop path is exercised. A fortress in reach is still
    // stat-bought (a Posture emission does not break Invisibility).
    if (amInvis && !a.casting?.card_ids?.length && botFortressBuy(me, near, dist)) return;
    if (amInvis && !a.casting?.card_ids?.length) {
      const s = slotOf('A') >= 0 ? slotOf('A') : slotOf('B');
      if (near && dist(near) <= 1 && s >= 0 && Math.random() < 0.3) {
        queue(s, skillsFor(a.hand[s].code)); send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' });
        a.attacks++; a.invisBreaks = (a.invisBreaks || 0) + 1; return;
      }
      if (classGoal) a.dest = { q: classGoal.q, r: classGoal.r };
      else if (near && dist(near) > 1) a.dest = { q: near.tile_q, r: near.tile_r };
      else if (!a.dest || (a.dest.q === me.tile_q && a.dest.r === me.tile_r) || Math.random() < 0.3) {
        const cands = [...a.map.tiles()].filter(t => { const d = hexDistance({ q: me.tile_q, r: me.tile_r }, t); return d >= 2 && d <= 6; });
        a.dest = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
      }
      if (!a.dest) return;
      const mv = slotOf('M');
      if (mv >= 0 && Math.random() < 0.5) queue(mv, skillsFor('M')); else queue('EMPTY', skillsFor('M'));
      send({ kind: 'target', target: { q: a.dest.q, r: a.dest.r } }); send({ kind: 'lock' });
      a.moves++; a.invisMoves = (a.invisMoves || 0) + 1; return;
    }
    // Haste holder: commit a bonus round first (Attack on the nearest enemy in
    // contact, else an Empty Move toward it) — the peer keeps those cards out of
    // the normal pick that follows.
    const allowance = a.bonusMax || 0;   // live allowance from the hand message (Haste 1, Balefire +3)
    if (allowance > 0 && near) {
      const ai = slotOf('A');
      const plans = [];
      // Plans carry instants (skills riding the code, an instant effect on the
      // Empty Posture) so the Rule 8 bonus-round judgment gets exercised.
      const instIdx = a.hand.findIndex(c => isEffect(c) && c.is_instant);
      for (let k = 0; k < allowance; k++) {
        if (k === 0 && dist(near) <= 1 && ai >= 0) plans.push({ slots: [ai], skills: skillsFor('A'), effect: null, target: near.peer_id });
        else if (dist(near) <= 1 && instIdx >= 0 && k <= 1) plans.push({ slots: ['EMPTY'], skills: skillsFor('P'), effect: instIdx, target: near.peer_id });
        else plans.push({ slots: ['EMPTY'], skills: skillsFor('M'), effect: null, target: { q: near.tile_q, r: near.tile_r } });
      }
      send({ kind: 'bonus', plans });
      a.hastes = (a.hastes || 0) + plans.length;
    }
    // Class strike (user ruling 2026-10-30): an adjacent enemy with a standing class colour — emit that colour
    // on a Posture against it (needs a die of 6). (Recast / untap of my own class: above, before Invisibility.)
    if (near && dist(near) <= 1 && near.class_id && !near.class_archived && Math.random() < 0.3) {
      const down = String(near.class_down_csv || '').split(',').filter(Boolean);
      const stat = Object.keys(CLASS_COLOURS[near.class_id] || {}).find(s => !down.includes(s));
      if (stat) { send({ kind: 'destroy', stat, class: near.peer_id, elem: CLASS_COLOURS[near.class_id][stat][0] }); send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' }); a.classStrikes = (a.classStrikes || 0) + 1; return; }
    }
    // Monster natural permanents (user rulings 2026-11-15, rule_monster_natural_permanents): an adjacent monster's
    // natural copies (perm_copies_json, power 6 each) — emit the stat of the effect's element against them (Rule 24
    // takes one copy at a time). The "cannot damage" afflictions are enforced by the resolver (my hits just do 0);
    // a hero afflicted by Fear (or Love / Awe of the monster next to it) mostly walks back to its tower to lift it.
    const natCopies = p => { try { return JSON.parse(p?.perm_copies_json || '{}') || {}; } catch { return {}; } };
    if (near && dist(near) <= 1 && Object.keys(natCopies(near)).length && Math.random() < 0.35) {
      const nid = Object.keys(natCopies(near)).sort()[0];
      send({ kind: 'destroy', stat: NATURAL_STAT[nid] || 'matter' }); send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' });
      a.natStrikes = (a.natStrikes || 0) + 1; return;
    }
    let myAffl = []; try { myAffl = JSON.parse(me.afflictions_json || '[]').filter(x => x?.natural); } catch {}
    const homeBound = myAffl.some(x => x.effect_id === 'effect_fear' || ((x.effect_id === 'effect_love' || x.effect_id === 'effect_awe') && near && x.by === near.peer_id));
    if (homeBound && Number.isInteger(me.entry_q) && Number.isInteger(me.entry_r) && !(me.tile_q === me.entry_q && me.tile_r === me.entry_r) && Math.random() < 0.5) {
      a.dest = { q: me.entry_q, r: me.entry_r };
      queue('EMPTY', skillsFor('M', 'P')); send({ kind: 'target', target: { q: a.dest.q, r: a.dest.r } }); send({ kind: 'lock' });
      a.towerWalks = (a.towerWalks || 0) + 1; a.moves++; return;
    }
    // (My class ability: botClassPolicy above, before Invisibility.)
    if (botFortressBuy(me, near, dist)) return;
    const tranceIdx = a.hand.findIndex(c => isSkill(c) && c.is_trance);
    // Battle Trance: two options (Attack + a different code, Block preferred).
    if (tranceIdx >= 0 && actionIdx.length >= 2 && near && dist(near) <= 3 && Math.random() < 0.6) {
      const primary = slotOf('A') >= 0 ? slotOf('A') : actionIdx[0];
      const pCode = a.hand[primary].code;
      const others = actionIdx.filter(i => i !== primary && a.hand[i].code !== pCode);
      const extra = others.find(i => a.hand[i].code === 'B') ?? others[0] ?? null;
      const codes = [pCode, extra !== null ? a.hand[extra].code : null].filter(Boolean);
      queue(primary, [tranceIdx, ...skillsFor(...codes)], extra);
      send({ kind: 'target', target: near.peer_id });
      send({ kind: 'lock' });
      a.trances++; a.attacks++;
      return;
    }
    // A cast in progress (multi-Posture effect, Summoning's stat buy): keep
    // emitting on a Posture until it lands instead of interrupting it (Rule 19).
    if (a.casting?.card_ids?.length) {
      const ci = a.hand.findIndex(c => c.card_id === a.casting.card_ids[0]);
      if (ci >= 0) {
        const p = slotOf('P');
        queue(p >= 0 ? p : 'EMPTY', skillsFor('P'), null, ci);
        if (near) send({ kind: 'target', target: near.peer_id });
        send({ kind: 'lock' });
        a.continued = (a.continued || 0) + 1;
        return;
      }
    }
    // Invisibility in hand and not invisible yet: cast it (Posture / Empty Posture, 2 emissions), mostly.
    const invIdx = amInvis ? -1 : a.hand.findIndex(c => isEffect(c) && c.effect_id === 'effect_invisibility');
    if (invIdx >= 0 && Math.random() < 0.7) {
      const p = slotOf('P');
      queue(p >= 0 ? p : 'EMPTY', skillsFor('P'), null, invIdx);
      send({ kind: 'lock' });
      a.invisCasts = (a.invisCasts || 0) + 1;
      return;
    }
    // Awake (2026-11-17): cast it now and then on a Posture / Empty Posture — ~35% with a clicked hex 1–4 away,
    // ~15% clicking my own hex (I am the one to move), else no click (the resolver picks the most beneficial move).
    const awIdx = a.hand.findIndex(c => isEffect(c) && c.effect_id === 'effect_awake');
    if (awIdx >= 0 && Math.random() < 0.4) {
      const p = slotOf('P');
      queue(p >= 0 ? p : 'EMPTY', skillsFor('P'), null, awIdx);
      const ring = [...a.map.tiles()].filter(t => { const d = hexDistance({ q: me.tile_q, r: me.tile_r }, t); return d >= 1 && d <= 4; });
      const roll = Math.random();
      const pick = roll < 0.35 && ring.length ? ring[Math.floor(Math.random() * ring.length)] : roll < 0.5 ? { q: me.tile_q, r: me.tile_r } : null;
      send({ kind: 'target', target: pick ? { q: pick.q, r: pick.r } : null }); send({ kind: 'lock' });
      a.awakeCasts = (a.awakeCasts || 0) + 1; a.awakePicks = (a.awakePicks || 0) + (pick ? 1 : 0);
      return;
    }
    // Adjacent with an effect in hand: cast it on a Posture (explicit P card
    // or the Empty Posture) half the time — this is what exercises the
    // Rule 21 effect-damage path in the resolver. A Summoning needs no enemy
    // in reach — start it whenever one is in sight.
    const effIdx = a.hand.findIndex(isEffect);
    // Stat buys (Summoning, Golems, Elementals): start whenever an enemy is in sight.
    // Resurrect only with a fallen unit or an ally next to me (else it has nothing to aim at).
    const nextToMe = [...a.peers.values()].filter(p => p.peer_id !== peerId && Number.isInteger(p.tile_q) && dist(p) <= 1);
    const canRaise = nextToMe.some(p => (p.life ?? 1) <= 0 || (sideOf(p.alliance) === sideOf(me.alliance) && p.life > 0));
    const sumIdx = a.hand.findIndex(c => isEffect(c) && (c.effect_types || []).includes('stat_buy') && (c.effect_id !== 'effect_resurrect_death_ward' || canRaise));
    if (sumIdx >= 0 && near && Math.random() < 0.5) {
      const p = slotOf('P');
      const dead = nextToMe.find(p => (p.life ?? 1) <= 0);
      queue(p >= 0 ? p : 'EMPTY', skillsFor('P'), null, sumIdx);
      send({ kind: 'target', target: (a.hand[sumIdx].effect_id === 'effect_resurrect_death_ward' && dead) ? dead.peer_id : near.peer_id }); send({ kind: 'lock' });
      a.summons = (a.summons || 0) + 1;
      return;
    }
    // A channel just cast (Harm, The Void, …): hold the Posture a couple of actions so it ticks
    // instead of breaking on the next move (general_ux_channeling).
    if (a.holdFor > 0) {
      a.holdFor--;
      const p = slotOf('P');
      queue(p >= 0 ? p : 'EMPTY', skillsFor('P'));
      if (near) send({ kind: 'target', target: near.peer_id });
      send({ kind: 'lock' });
      return;
    }
    const castEffect = (idx) => {
      const p = slotOf('P');
      queue(p >= 0 ? p : 'EMPTY', skillsFor('P'), null, idx);
      if ((a.hand[idx].effect_types || []).includes('channeling')) a.holdFor = 2;
      send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' });
    };
    if (near && dist(near) <= 1 && effIdx >= 0 && Math.random() < 0.5) { castEffect(effIdx); return; }
    // Set-up effects (traps, permanents, relocations — anything not aimed at a target) go out
    // while the enemy is still a few hexes off.
    const setupIdx = a.hand.findIndex(c => isEffect(c) && c.scope !== 'target' && !(c.effect_types || []).includes('stat_buy'));
    if (near && dist(near) > 1 && setupIdx >= 0 && Math.random() < 0.35) { castEffect(setupIdx); return; }
    if (near && dist(near) <= 1 && Math.random() < 0.75) {
      const s = slotOf('A') >= 0 ? slotOf('A') : slotOf('B');
      if (s >= 0) { queue(s, skillsFor(a.hand[s].code)); send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' }); a.attacks++; return; }
    }
    if (near && dist(near) <= 1) {
      // Adjacent without Attack/Block: hold the Posture (an explicit P card or
      // the Empty Posture) rather than walking into the monster's hex.
      const p = slotOf('P');
      if (p >= 0) queue(p, skillsFor('P')); else queue('EMPTY', skillsFor('M', 'P'));
      send({ kind: 'target', target: near.peer_id }); send({ kind: 'lock' });
      return;
    }
    // Hunt the nearest living monster (that is what stresses the resolver);
    // wander 3–9 hexes only when none is known.
    // Holding Resurrect with a corpse in view: walk to it (the raise needs contact).
    const corpse = a.hand.some(c => isEffect(c) && c.effect_id === 'effect_resurrect_death_ward')
      ? [...a.peers.values()].filter(p => p.peer_id !== peerId && (p.life ?? 1) <= 0 && Number.isInteger(p.tile_q) && dist(p) <= 8).sort((x, y) => dist(x) - dist(y))[0] : null;
    // A trap-aware class without a disable ability (a trap charge): walk onto a visible enemy trap within 8 hexes —
    // hunting monsters exercises the threat charge.
    const trapGoal = myProfile?.trapAware && !myProfile.recs.has('disable_traps') && Math.random() < 0.6 ? foeTraps.find(t => t.d >= 1 && t.d <= 8) : null;
    if (trapGoal) { a.dest = { q: trapGoal.q, r: trapGoal.r }; a.trapWalks = (a.trapWalks || 0) + 1; }
    // Class precondition walk (botClassPolicy goal): a building / trap, a wild monster or an enemy (classProfile).
    else if (classGoal) a.dest = { q: classGoal.q, r: classGoal.r };
    else if (corpse) a.dest = { q: corpse.tile_q, r: corpse.tile_r };
    else if (near) a.dest = { q: near.tile_q, r: near.tile_r };
    else if (!a.dest || (a.dest.q === me.tile_q && a.dest.r === me.tile_r) || Math.random() < 0.15) {
      const cands = [...a.map.tiles()].filter(t => { const d = hexDistance({ q: me.tile_q, r: me.tile_r }, t); return d >= 3 && d <= 9; });
      a.dest = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
    }
    if (!a.dest) return;
    // 30%: an explicit Move card (with its skills) instead of the Empty Move.
    const mv = slotOf('M');
    if (mv >= 0 && Math.random() < 0.3) queue(mv, skillsFor('M'));
    else queue('EMPTY', skillsFor('M', 'P'));   // Move/Posture skills ride on Empty too
    send({ kind: 'target', target: { q: a.dest.q, r: a.dest.r } });
    send({ kind: 'lock' });
    a.moves++;
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.kind === 'hello') { a.me = m.peer_id; a.hand = m.hand || []; if (m.map) { a.map = createKnownMap(m.map.seed, [initialBlock()]); a.map.addBlocks(m.map.blocks); } for (const p of m.peers || []) a.peers.set(p.peer_id, p); log(`  ${peerId} hello: map ${a.map.size()} hexes / ${a.map.blockCount()} blocks`); }
    if (m.kind === 'map') { if (m.map.seed !== a.map.seed) a.map = createKnownMap(m.map.seed, [initialBlock()]); a.map.addBlocks(m.map.blocks); }
    if (m.kind === 'hand') { a.hand = m.hand || a.hand; if (m.bonus) a.bonusMax = m.bonus.max || 0; if (m.casting !== undefined) a.casting = m.casting || null; if (m.class_state) a.classState = m.class_state; if (m.queued_class_ability !== undefined) a.queuedClass = !!m.queued_class_ability; if (Array.isArray(m.fortresses)) a.fortresses = m.fortresses; if (m.phylactery_target !== undefined) a.phylTarget = m.phylactery_target || null; if (m.queued_phylactery !== undefined) a.queuedPhyl = !!m.queued_phylactery; }
    if (m.kind === 'peers') for (const p of m.peers || []) a.peers.set(p.peer_id, { ...(a.peers.get(p.peer_id) || {}), ...p });
    if (m.kind === 'phase' && m.name === 'planning') { a.rounds++; a.queuedClass = false;setTimeout(() => plan(m.turn, m.round), 300 + Math.random() * 1500); }
  };
  ws.onerror = () => {};
  const idx = agents.findIndex(x => x.peerId === peerId);
  if (idx >= 0) agents[idx] = a; else agents.push(a);
}

// ---- 1. host ----
const host = await api('/api/launch', { mode: 'host', dimensionName: DIM });
if (!host.ok) { console.error('host failed', host); process.exit(1); }
log(`hosted ${DIM}: player-1 on :${host.peerPort}`);
// PS: partial foreign swarms — FOREIGN_HOLDERS / FOREIGN_REFUSERS reach every peer through the launcher's env (foreign-select.mjs).
{
  const fsel = await import('../foreign-select.mjs');
  const fk = ['FORCE_FOREIGN_EFFECT', 'FORCE_FOREIGN_SKILL', 'FORCE_FOREIGN_CLASS'].filter(k => process.env[k]).map(k => `${k.slice(14).toLowerCase()} ${path.basename(process.env[k])}`);
  if (fk.length) log(`foreign: ${fk.join(', ')} — holders ${(fsel.foreignHolders() || ['every peer']).join(',')}; refusers ${fsel.foreignRefusers().join(',') || 'none'}; cache ${process.env.CHAOSD6_DEFS_CACHE_ROOT ? `per peer under ${process.env.CHAOSD6_DEFS_CACHE_ROOT}` : 'shared (~/.local/share/chaosd6)'}`);
}
// NOGUN=1 reaches every peer through the launcher's env (tools/swarm-run.sh exports it before start-all.mjs).
log(`gun: ${process.env.NOGUN === '1' ? 'OFF (NOGUN=1) — clock via libp2p/bus clock frames, directory via Door + bus who' : 'on (default)'}`);
if (FORCED_CLASSES.length > 1 && FORCED_LABELS.length) log(`force-class: ${FORCED_LABELS.map((l, i) => `${l}=${FORCED_CLASSES[i % FORCED_CLASSES.length]}`).join(', ')}${process.env.FORCE_CLASS_MONSTERS === '1' ? ' (+ wild lurkers by label hash)' : ''}`);
else if (FORCED_CLASSES.length > 1) log(`force-class: ${FORCED_CLASSES.join(',')} by label hash (no FORCE_CLASS_LABELS — not every class is guaranteed a holder)`);
else if (FORCED_CLASSES.length === 1) log(`force-class: every peer = ${FORCED_CLASSES[0]}`);
const ports = new Map([['peer:player-1', host.peerPort], ['peer:ally-1', host.peerPort + 1], ['peer:foe-1', host.peerPort + 2], ['peer:foe-2', host.peerPort + 3]]);
await sleep(3000);
startAgent('peer:player-1', host.peerPort);

// ---- 2. wait until the Doors are on Radicle, then join the rest ----
for (let i = 0; i < 40; i++) {
  const d = await api('/api/dimensions');
  const mine = (d.items || []).find(x => x.dimension_name === DIM);
  if (mine && mine.doors?.length >= 1) { log(`Doors published (${mine.doors.length})`); break; }
  await sleep(5000);
}
// Monsters the bots meet (foe-1 is always the Ruinous Minotaur — natural Earthquake). SWARM_MONSTERS=mon_a,mon_b[,…]
// pins M-Foe3 / M-Foe4 (and adds M-Foe5…); by default M-Foe3 rotates per run over the monsters with a natural permanent
// (rule_monster_natural_permanents) and M-Foe4 is the Tangle Spider (natural Creation).
const NATURAL_POOL = ['mon_etherium_abomination', 'mon_rakewalk_gargantuan', 'mon_bant_battlemage_3p', 'mon_angel_of_mercy', 'mon_selftower_sphynx', 'mon_greater_basilisk', 'mon_nacatl_hunt_pride', 'mon_loxodon_mystic', 'mon_infectious_horror', 'mon_summit_apes'];
const SWARM_MONSTERS = (process.env.SWARM_MONSTERS || '').split(',').map(x => x.trim()).filter(Boolean);
if (!SWARM_MONSTERS[0]) SWARM_MONSTERS[0] = NATURAL_POOL[Math.floor(Date.now() / 60000) % NATURAL_POOL.length];
if (!SWARM_MONSTERS[1]) SWARM_MONSTERS[1] = 'mon_tangle_spider_2b';
log(`monsters: foe-1 mon_ruinous_minotaur, foe-2 mon_ridge_runnet_3a, ${SWARM_MONSTERS.map((m, i) => `M-Foe${3 + i} ${m}`).join(', ')}`);
const joins = [
  { label: 'P-Agent2', side: 'player', characterId: 'char_oran_rief' },
  { label: 'P-Agent3', side: 'player', characterId: 'char_cynder_pyromancer' },
  { label: 'P-Agent4', side: 'player', characterId: 'char_rhox_bodyguard' },
  { label: 'P-Agent5', side: 'player', characterId: 'char_godtracker_jund' },
  { label: 'M-Foe3',   side: 'npc_b',  creatureId: SWARM_MONSTERS[0] },
  { label: 'M-Foe4',   side: 'npc_b',  creatureId: SWARM_MONSTERS[1] },
  ...SWARM_MONSTERS.slice(2).map((creatureId, i) => ({ label: `M-Foe${5 + i}`, side: 'npc_b', creatureId })),
];
// TEAM_C=1: one human-driven bot on the third team (hostile to A and B).
if (process.env.TEAM_C === '1') joins.push({ label: 'C-Agent6', side: 'player_c', characterId: 'char_akki_coalfinger' });
// TEAM_D=1: one human-driven bot on the fourth team (player_d, hostile to A, B and C — user ruling 2026-11-15).
if (process.env.TEAM_D === '1') joins.push({ label: 'D-Agent7', side: 'player_d', characterId: 'char_oran_rief' });
for (const j of joins) {
  let base = launcher;
  if (launcherC && j.label === 'P-Agent5') {
    // The other identity only sees the dimension once the seeds have replicated our Doors.
    for (let i = 0; i < 24; i++) {
      const d = await api('/api/dimensions', null, launcherC).catch(() => ({}));
      if ((d.items || []).some(x => x.dimension_name === DIM && x.doors?.length)) { base = launcherC; break; }
      await sleep(5000);
    }
    log(base === launcherC ? `launcher C sees ${DIM} — joining ${j.label} through it` : `launcher C never saw ${DIM}; joining ${j.label} through A`);
  }
  const out = await api('/api/launch', { mode: 'join', dimensionName: DIM, doorId: null, placement: j.side === 'player' ? 'nearby' : 'random', ...j, entityName: j.label }, base);
  if (!out.ok) { console.error('join failed', j.label, out.error); continue; }
  ports.set(`peer:${j.label}`, out.peerPort);
  log(`joined ${j.label} (${j.side}) at (${out.startTile.q},${out.startTile.r}) on :${out.peerPort}${base === launcherC ? ' via launcher C' : ''}`);
  await sleep(1500);
  if (j.side === 'player' || j.side === 'player_c' || j.side === 'player_d') startAgent(`peer:${j.label}`, out.peerPort);
}
log(`agents driving: ${agents.map(a => a.peerId).join(', ')}`);

// ---- 4. audit ----
async function audit(label) {
  const snaps = new Map();
  for (const [id, port] of ports) { const s = await status(port); if (s) snaps.set(id, s); }
  let mismatches = [], mapSizes = new Map(), alive = 0, regions = [];
  for (const [id, s] of snaps) {
    mapSizes.set(id, s.map?.tiles);
    regions.push(s.region?.strong?.length ?? '?');
    if (s.entity.life > 0) alive++;
    for (const [oid, os] of snaps) {
      if (oid === id) continue;
      const v = (os.peers || []).find(p => p.peer_id === id);
      if (!v) { mismatches.push(`${oid} has no entry for ${id}`); continue; }
      if (v.tile_q !== s.entity.tile.q || v.tile_r !== s.entity.tile.r || v.life !== s.entity.life)
        mismatches.push(`${oid} sees ${id} at (${v.tile_q},${v.tile_r}) hp${v.life}, truth (${s.entity.tile.q},${s.entity.tile.r}) hp${s.entity.life}`);
    }
  }
  const turns = [...snaps.values()].map(s => `${s.turn}.${s.round}`);
  const sizes = [...new Set(mapSizes.values())];
  log(`[${label}] peers up ${snaps.size}/${ports.size}, alive ${alive}, clocks ${[...new Set(turns)].join('|')}, map sizes ${sizes.join('|')}, strong-region sizes ${regions.join(',')}, view mismatches ${mismatches.length}`);
  for (const m of mismatches.slice(0, 6)) log('   ', m);
  return { mismatches, sizes };
}

const endAt = Date.now() + minutes * 60_000;
// SWARM_SHADOW=1 (rule_hero_shadow, 2026-11-16): a third of the way in, one bot hero's game "closes" — its peer
// process is SIGKILLed (SWARM_SHADOW_LABEL, default P-Agent4) and its agent stops. After the silence (SHADOW_MS,
// 120 s unless the launcher env shortens it) one live hero's game starts its shadow; the log scan counts them.
const SHADOW_KILL = process.env.SWARM_SHADOW === '1' ? (process.env.SWARM_SHADOW_LABEL || 'P-Agent4') : null;
const shadowKillAt = Date.now() + minutes * 60_000 / 3;
let shadowKilled = false;
function killHeroPeer(label) {
  for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('peer.mjs')) continue;
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (env.includes(`PEER_LABEL=${label}`) && env.includes(`DIM_NAME=${DIM}`) && !env.some(e => e.startsWith('SHADOW_OF=') && e.length > 10)) { process.kill(Number(pid), 'SIGKILL'); return Number(pid); }
    } catch {}
  }
  return null;
}
while (Date.now() < endAt) {
  await sleep(30_000);
  if (SHADOW_KILL && !shadowKilled && Date.now() >= shadowKillAt) {
    shadowKilled = true;
    const ag = agents.find(a => a.peerId === `peer:${SHADOW_KILL}`);
    if (ag) { try { ag.ws.onclose = null; ag.ws.close(); } catch {} agents.splice(agents.indexOf(ag), 1); }
    ports.delete(`peer:${SHADOW_KILL}`);
    const pid = killHeroPeer(SHADOW_KILL);
    log(`shadow test: ${SHADOW_KILL} ${pid ? `killed (pid ${pid})` : 'not found'} — its shadow should stand in after the silence`);
  }
  await audit('live');
}
for (const a of agents) { try { a.ws.onclose = null; a.ws.close(); } catch {} }
log(`agents stopped: ${agents.map(a => `${a.peerId.replace('peer:', '')} rounds ${a.rounds} moves ${a.moves} attacks ${a.attacks} skills ${a.skillsPlayed} trances ${a.trances} effects ${a.effectsCast || 0} hastes ${a.hastes || 0} summons ${a.summons || 0} continued ${a.continued || 0} class-uses ${a.classUses || 0} class-strikes ${a.classStrikes || 0} class-recasts ${a.classRecasts || 0} class-walks ${a.classWalks || 0} trap-walks ${a.trapWalks || 0} invis-casts ${a.invisCasts || 0} invis-moves ${a.invisMoves || 0} invis-breaks ${a.invisBreaks || 0} natural-strikes ${a.natStrikes || 0} tower-walks ${a.towerWalks || 0}`).join('; ')}`);
await sleep(20_000);
const fin = await audit('settled');

// ---- 5. log scan ----
const dirs = [path.join(here, '..', 'logs', slug(DIM))];
if (process.env.LOGS_C) dirs.push(path.join(process.env.LOGS_C, slug(DIM)));
const counts = {};
for (const dir of dirs) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (!f.endsWith('.log') || f.endsWith('.ui.log')) continue;
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  const c = k => (txt.match(k) || []).length;
  counts[f] = { divergence: c(/STATE DIVERGENCE/g), heal: c(/mesh heal:/g), relink: c(/closed — will re-dial/g), catchup: c(/clock catch-up/g), uncaught: c(/UNCAUGHT|UNHANDLED/g), died: c(/DIED at/g), mapBlocks: c(/map \+/g), mapSync: c(/map sync/g), natural: c(/\] natural /g), shadow: c(/\] shadow: /g) };
  const gs = [...txt.matchAll(/gossip state: topics=\d+ totalPeers=(\d+) subscribersOnStrong=(\d+)/g)].at(-1);
  counts[f].lastPubsubPeers = gs ? `${gs[2]}/${gs[1]}` : '?';
  const bus = [...txt.matchAll(/bus: (\d+)\/(\d+) relays, sent (\d+), received (\d+)/g)].at(-1);
  counts[f].bus = bus ? `sent ${bus[3]} rx ${bus[4]} (${bus[1]}/${bus[2]} relays)` : '?';
}
console.table(counts);
// Awake (FORCE_EFFECTS=effect_awake): bot casts / clicked, and the resolver's move lines across every peer log.
{
  let units = 0, blds = 0, dropped = 0, fizzled = 0;
  for (const dir of dirs) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.log') || f.endsWith('.ui.log')) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    units += (txt.match(/\] awake: \S+ moves (itself|\S+) to \(/g) || []).length;
    blds += (txt.match(/\] awake: \S+ moves the .* → \(/g) || []).length;
    dropped += (txt.match(/\] awake: .* dropped/g) || []).length;
    fizzled += (txt.match(/cast effect_awake fizzled/g) || []).length;
  }
  const casts = agents.reduce((s, a) => s + (a.awakeCasts || 0), 0);
  if (casts || units || blds) log(`awake: bot casts ${casts} (clicked ${agents.reduce((s, a) => s + (a.awakePicks || 0), 0)}) · unit moves ${units} / building moves ${blds} (lines, all peers) · dropped ${dropped} · fizzled (caster) ${fizzled}`);
}
// Swaps (Manipulator): every peer logs `<class>: <A> forces <B> to swap <old>→<new>`.
{
  const seen = new Map();   // swap text → number of peer logs that carry it
  for (const dir of dirs) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.log') || f.endsWith('.ui.log')) continue;
    for (const m of new Set([...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\] \S+: (\S+ forces \S+ to swap \S+)/g)].map(x => x[1]))) seen.set(m, (seen.get(m) || 0) + 1);
  }
  if (seen.size) log(`swaps: ${seen.size} distinct (${[...seen].slice(0, 6).map(([k, n]) => `${k} ×${n} logs`).join('; ')})`);
}
// Invisibility (FORCE_EFFECTS=effect_invisibility): landed / shown (every peer) / broken (holder) / area hits.
{
  const inv = { up: 0, shows: 0, broken: 0, area: 0 };
  for (const dir of dirs) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.log') || f.endsWith('.ui.log')) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    inv.up += (txt.match(/permanent effect_invisibility up/g) || []).length;
    inv.shows += (txt.match(/invisibility: \S+ shows itself/g) || []).length;
    inv.broken += (txt.match(/invisibility broken:/g) || []).length;
    inv.area += (txt.match(/area hits the invisible/g) || []).length;
  }
  if (inv.up || inv.shows) log(`invisibility: ${inv.up} landed, ${inv.shows} show-lines (all peers), ${inv.broken} broken (holder), ${inv.area} area hits`);
}
// Fortress stat buy + what the building / trap classes left on the map (2026-11-14; BOT_FORTRESS=1). Per class: the
// [class-event] counts below.
{
  const k = { banked: 0, broken: 0, trapVision: 0 };
  for (const dir of dirs) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.log') || f.endsWith('.ui.log')) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    k.banked += (txt.match(/\] fortress bld:\S+: banked/g) || []).length;
    k.broken += (txt.match(/\] fortress bld:\S+ broken/g) || []).length;
    k.fzTokens = (k.fzTokens || 0) + (txt.match(/\] fortress bld:\S+ broken .* bonus token \+\d+ \(elem_/g) || []).length;
    k.fzTokenLost = (k.fzTokenLost || 0) + (txt.match(/\] my stat \S+#fz\d+ (destroyed|taken) by /g) || []).length;
    k.made = (k.made || 0) + (txt.match(/\] building made: /g) || []).length;
    k.trapVision += (txt.match(/seeker vision: /g) || []).length;
  }
  log(`fortress: bot stat-buys ${agents.reduce((s, a) => s + (a.fortressBuys || 0), 0)}, banked ${k.banked}, broken ${k.broken} (bonus tokens ${k.fzTokens || 0}, destroyed by Rule 24 ${k.fzTokenLost || 0}) · tile picks (bot) ${agents.reduce((s, a) => s + (a.animatorPicks || 0), 0)} · building-made lines (all peers) ${k.made || 0} · trap-vision lines ${k.trapVision}`);
}
// Per class (2026-11-15): who held it (every agent's peer view + the agent itself), bot uses and skip reasons
// (botClassPolicy), the clicker's own `class class_x:` lines and the [class-event] kinds across every peer log.
{
  const holders = new Map();   // label → class id
  for (const a of agents) {
    for (const p of a.peers.values()) if (p?.peer_id && p.class_id) holders.set(p.peer_id.replace('peer:', ''), p.class_id);
    if (a.classState?.class_id) holders.set(a.peerId.replace('peer:', ''), a.classState.class_id);
  }
  const bots = new Set(agents.map(a => a.peerId.replace('peer:', '')));
  const txts = [];
  for (const dir of dirs) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.endsWith('.log') && !f.endsWith('.ui.log')) txts.push(fs.readFileSync(path.join(dir, f), 'utf8'));
  const n = (re) => txts.reduce((s, t) => s + (t.match(re) || []).length, 0);
  const events = {};   // class → kind → lines (all peers)
  for (const tx of txts) for (const m of tx.matchAll(/\[class-event\] (\{[^\n]*\})/g)) { try { const e = JSON.parse(m[1]); ((events[e.class] ||= {})[e.kind] = (events[e.class][e.kind] || 0) + 1); } catch {} }
  const classes = [...new Set([...FORCED_CLASSES, ...agents.map(a => a.classState?.class_id).filter(Boolean)])].sort();
  log(`force-class actual: ${[...holders].sort((x, y) => x[0].localeCompare(y[0])).map(([l, c]) => `${l}${bots.has(l) ? '*' : ''}=${c.replace('class_', '')}`).join(', ')} (* = bot-driven)`);
  for (const cid of classes) {
    const short = cid.replace('class_', '');
    const who = [...holders].filter(([, c]) => c === cid).map(([l]) => `${l}${bots.has(l) ? '*' : ''}`);
    const uses = agents.reduce((s, a) => s + (a.classUseBy?.[cid] || 0), 0);
    const skips = {};
    for (const a of agents) for (const [k, v] of Object.entries(a.classSkip || {})) if (k.startsWith(`${short}:`)) skips[k.slice(short.length + 1)] = (skips[k.slice(short.length + 1)] || 0) + v;
    const fired = n(new RegExp(`\\] class ${cid}: `, 'g'));
    const ev = Object.entries(events[cid] || {}).sort().map(([k, v]) => `${k}=${v}`).join(' ');
    log(`class ${short}: holders ${who.join(',') || 'none'} · bot uses ${uses} · class skip ${Object.entries(skips).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(' ') || '-'} · fired (clicker log) ${fired}${ev ? ` · events (all peers) ${ev}` : ''}`);
  }
}
const divergences = Object.values(counts).reduce((s, c) => s + c.divergence, 0);

// ---- 6. tape scan: did skills / Battle Trance actually get played? ----
// The host's hashgraph tape holds every envelope it saw (own + received). Only
// rows after the last evt_genesis belong to this run of the dimension.
try {
  const tape = path.join(here, '..', 'sessions', DIM, 'hashgraph.jsonl');
  // swarm-run.sh caps the tape (TAPE_MAX_BYTES): the older part, if rotated, is in hashgraph.1.jsonl.
  const older = tape.replace(/\.jsonl$/, '.1.jsonl');
  const rows = ((fs.existsSync(older) ? fs.readFileSync(older, 'utf8') + '\n' : '') + fs.readFileSync(tape, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const gi = rows.map((r, i) => r.type === 'evt_genesis' ? i : -1).filter(i => i >= 0).at(-1) ?? 0;
  const run = rows.slice(gi);
  const reveals = run.filter(r => r.type === 'evt_action_reveal');
  const withSkills = reveals.filter(r => Array.isArray(r.payload?.skills) && r.payload.skills.length);
  const trances = reveals.filter(r => r.payload?.action === 'BT');
  const perSkill = {};
  for (const r of withSkills) for (const s of r.payload.skills) perSkill[s] = (perSkill[s] || 0) + 1;
  const hashesWithDmg = run.filter(r => r.type === 'evt_state_hash' && (r.payload?.damage_applied || []).length).length;
  log(`tape: ${reveals.length} reveals, ${withSkills.length} with skills, ${trances.length} Battle Trance (${trances.map(r => `${r.actor_peer_id.replace('peer:', '')}:${(r.payload.trance || []).join('|')}`).slice(0, 8).join(' ')}), ${hashesWithDmg} state hashes with damage`);
  log(`tape skills: ${Object.entries(perSkill).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k.replace('skill_', '')}=${v}`).join(' ') || 'none'}`);
} catch (e) { log(`tape scan skipped: ${e.message}`); }
log(`RESULT: ${fin.mismatches.length} settled view mismatches, ${fin.sizes.length === 1 ? 'map consistent' : 'MAP SIZES DIFFER ' + fin.sizes.join('|')}, ${divergences} state divergences logged`);
process.exit(0);
