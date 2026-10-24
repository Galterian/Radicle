// Dev probe: drive a peer's hero through its UI socket so that every planning
// phase commits a skill card riding on its matching action (when the hand
// allows it), aimed at the nearest living enemy. Prints the reveals that carry
// skills and the damage each round so the resolver's skill branches can be
// watched live.
//
//   node tools/skill-probe.mjs [peerPort=7401] [seconds=120]
const port = Number(process.argv[2] || 7401);
const seconds = Number(process.argv[3] || 120);
const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
const send = o => ws.send(JSON.stringify(o));
let me = null, hand = [], peers = [], alliance = null;
const side = a => a === 'npc_b' ? 'B' : 'A';
const dist = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((-a.q - a.r) - (-b.q - b.r)));
const nameOf = id => peers.find(p => p.peer_id === id)?.name || id;

function plan(m) {
  const self = peers.find(p => p.peer_id === me);
  const enemies = peers.filter(p => p.peer_id !== me && p.life > 0 && side(p.alliance) !== side(alliance));
  if (!self || !enemies.length) return console.log(`T${m.turn}.${m.round + 1}: no enemies`);
  enemies.sort((a, b) => dist({ q: self.tile_q, r: self.tile_r }, { q: a.tile_q, r: a.tile_r }) - dist({ q: self.tile_q, r: self.tile_r }, { q: b.tile_q, r: b.tile_r }));
  const foe = enemies[0];
  const d = dist({ q: self.tile_q, r: self.tile_r }, { q: foe.tile_q, r: foe.tile_r });
  const skills = hand.map((c, i) => ({ c, i })).filter(x => x.c.kind === 'skill');
  const label = c => c.skill_id ? c.skill_id.slice(6) : c.code;
  const trance = skills.find(x => x.c.is_trance);
  const actions = hand.map((c, i) => ({ c, i })).filter(x => x.c.kind !== 'skill');
  if (trance && actions.length) {
    const primary = actions.find(x => x.c.code === 'A') || actions[0];
    const extra = actions.find(x => x.i !== primary.i && x.c.code !== primary.c.code) || actions.find(x => x.i !== primary.i) || null;
    const codes = new Set([primary.c.code, extra?.c.code]);
    const sk = [trance.i, ...skills.filter(x => !x.c.is_trance && codes.has(x.c.requires)).map(x => x.i)];
    send({ kind: 'queue', slots: [primary.i], skills: sk, extra: extra ? extra.i : null });
    send({ kind: 'target', target: d <= 1 ? foe.peer_id : { q: foe.tile_q, r: foe.tile_r } });
    send({ kind: 'lock' });
    console.log(`T${m.turn}.${m.round + 1}: BT[${primary.c.code}|${extra ? extra.c.code : 'EP'}]+${sk.length - 1} skills → ${foe.name} (d=${d}) hand=[${hand.map(label).join(' ')}]`);
    return;
  }
  let pick = null;
  for (const s of skills) {
    const a = hand.findIndex(c => c.kind !== 'skill' && c.code === s.c.requires);
    if (a >= 0) { pick = { action: a, skill: s.i, code: s.c.requires, name: s.c.name }; break; }
  }
  if (pick) {
    send({ kind: 'queue', slots: [pick.action], skills: [pick.skill] });
    if (pick.code === 'A' || pick.code === 'M') send({ kind: 'target', target: foe.peer_id });
    send({ kind: 'lock' });
    console.log(`T${m.turn}.${m.round + 1}: ${pick.code}+${pick.name} → ${foe.name} (d=${d}) hand=[${hand.map(c => c.skill_id ? c.skill_id.slice(6) : c.code).join(' ')}]`);
  } else {
    // Walk toward the foe so contact happens; in contact Attack, else Block.
    const a = hand.findIndex(c => c.kind !== 'skill' && c.code === 'A');
    const b = hand.findIndex(c => c.kind !== 'skill' && c.code === 'B');
    let tag = 'EM';
    if (d <= 1 && a >= 0) { tag = 'A'; send({ kind: 'queue', slots: [a] }); send({ kind: 'target', target: foe.peer_id }); }
    else if (d <= 1 && b >= 0) { tag = 'B'; send({ kind: 'queue', slots: [b] }); send({ kind: 'target', target: null }); }
    else { send({ kind: 'queue', slots: ['EMPTY'] }); send({ kind: 'target', target: { q: foe.tile_q, r: foe.tile_r } }); }
    send({ kind: 'lock' });
    console.log(`T${m.turn}.${m.round + 1}: ${tag} → ${foe.name} (d=${d}) hand=[${hand.map(c => c.skill_id ? c.skill_id.slice(6) : c.code).join(' ')}]`);
  }
}

const seenDmg = new Set();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.kind === 'hello') { me = m.peer_id; alliance = m.alliance; hand = m.hand || []; peers = m.peers || []; console.log(`hello ${me} (${alliance}) hand ${hand.length}`); }
  if (m.kind === 'hand') hand = m.hand || hand;
  if (m.kind === 'peers') for (const p of m.peers || []) { const i = peers.findIndex(x => x.peer_id === p.peer_id); if (i >= 0) peers[i] = { ...peers[i], ...p }; else peers.push(p); }
  if (m.kind === 'phase' && m.name === 'planning') plan(m);
  if (m.kind === 'evt' && m.env.type === 'evt_action_reveal' && m.env.payload.skills?.length) {
    const act = m.env.payload.action === 'BT' ? `BT[${(m.env.payload.trance || []).join('|')}]` : m.env.payload.action;
    console.log(`  REVEAL ${nameOf(m.env.actor_peer_id)} T${m.env.turn}.${m.env.round + 1}: ${act}+${m.env.payload.skill_names.join('+')} → ${m.env.payload.target?.ref?.q !== undefined ? JSON.stringify(m.env.payload.target.ref) : nameOf(m.env.payload.target?.ref)}`);
  }
  if (m.kind === 'hand' && m.turn_end === undefined && Array.isArray(m.queued)) {
    // Echo of our queue message — shows what the server accepted.
    console.log(`  queue ack: slots=${JSON.stringify(m.queued)} skills=${JSON.stringify(m.queued_skills)} extra=${JSON.stringify(m.queued_extra)}`);
  }
  if (m.kind === 'evt' && m.env.type === 'evt_state_hash' && !m.from_peer) {
    for (const d of m.env.payload.damage_applied || []) {
      const k = `${m.env.turn}:${m.env.round}:${d.target}:${d.attacker}`;
      if (seenDmg.has(k)) continue; seenDmg.add(k);
      console.log(`  DMG T${m.env.turn}.${m.env.round + 1}: ${nameOf(d.attacker)} → ${nameOf(d.target)} ${d.amount}`);
    }
    for (const a of m.env.payload.actions || []) if (a.skills?.length) console.log(`  ACT T${m.env.turn}.${m.env.round + 1}: ${nameOf(a.actor)} ${a.action}+${a.skills.map(s => s.slice(6)).join('+')}`);
  }
  if (m.kind === 'contact') for (const c of m.contacts) console.log(`  contact: ${c.a.name}[${c.a.action}] × ${c.b.name}[${c.b.action}]${c.a.vetoed ? ' veto:' + c.a.vetoed : ''}${c.b.vetoed ? ' veto:' + c.b.vetoed : ''}`);
};
ws.onclose = () => { console.log('socket closed'); process.exit(0); };
setTimeout(() => process.exit(0), seconds * 1000);
