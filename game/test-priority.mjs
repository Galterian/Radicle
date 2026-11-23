// "Test Random character" (user 2026-11-23): the random hero tries MY work first —
//   1. my drafts (editor "Generate…": <profile dir>/gen-drafts/*.json, newest first): the class, skills, effects;
//   2. what my team published: profile.custom_classes (newest) and the cards with custom: true (profile archive grants);
//   3. then the built-ins fill the rest (peer.mjs deals them as before; TEST_PRIORITY=1 trims them to the slot counts).
// Slots as a dealt hero: 1 class, 4 skills, 3 effects. Only the hero (player-1 / the phone's own peer) gets this env;
// companions blank it (peer.mjs spawnCompanion). The test harnesses (FORCE_FOREIGN_* already set) are left alone.
import fs from 'node:fs';
import path from 'node:path';

export const TEST_SLOTS = Object.freeze({ class: 1, skill: 4, effect: 3 });
const BUSY = new Set(['generating', 'publishing', 'published']);
const ENV_KEYS = ['FORCE_FOREIGN_CLASS', 'FOREIGN_CLASS_REF_JSON', 'FORCE_FOREIGN_SKILL', 'FORCE_FOREIGN_EFFECT', 'FOREIGN_CARD_REFS_JSON', 'TEST_PRIORITY'];

/** True when a harness already forces foreign defs / built-ins (tools/effect-gen-test.mjs, swarm runs): keep out. */
export const forcedByHarness = (env = process.env) => ['FORCE_FOREIGN_CLASS', 'FORCE_FOREIGN_SKILL', 'FORCE_FOREIGN_EFFECT', 'FORCE_CLASS', 'FORCE_SKILLS', 'FORCE_EFFECTS']
  .some(k => String(env[k] || '').trim());

/** My drafts with a def file on disk, newest first: [{ kind, id, name, file }]. */
export function draftDefs(profileFile) {
  const dir = path.join(path.dirname(profileFile), 'gen-drafts');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!d?.def?.id || !d.file || BUSY.has(d.state) || d.published) continue;
    const file = path.isAbsolute(d.file) ? d.file : path.resolve(path.dirname(profileFile), d.file);
    if (!fs.existsSync(file)) continue;
    const kind = d.kind || 'effect';
    if (!TEST_SLOTS[kind]) continue;
    out.push({ kind, id: d.def.id, name: d.def.name || d.def.id, file, at: String(d.updated_at || d.created_at || '') });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** What my team published: { classes: [{id, name, ref}], cards: [{kind, id, ref}] } (newest class first, cards by id). */
export function publishedOfTeam(p) {
  const valid = (x) => x?.ref && x.ref.id === x.id && /^[0-9a-f]{64}$/.test(String(x.ref.sha256 || ''));
  const classes = (Array.isArray(p?.custom_classes) ? p.custom_classes : []).filter(valid)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).map(x => ({ id: x.id, name: x.name || x.id, ref: x.ref }));
  const cards = new Map();
  for (const c of p?.characters || []) for (const x of c.cards || []) {
    if (!x.custom || !valid(x) || !['skill', 'effect'].includes(x.kind) || cards.has(`${x.kind}:${x.id}`)) continue;
    cards.set(`${x.kind}:${x.id}`, { kind: x.kind, id: x.id, ref: x.ref });
  }
  return { classes, cards: [...cards.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * The hero's env for a Test Random game: { env, summary } (env {} when there is nothing of mine, or a harness forces).
 * env: FORCE_FOREIGN_CLASS=<draft file> | FOREIGN_CLASS_REF_JSON; FORCE_FOREIGN_SKILL / _EFFECT = comma lists of draft
 * files; FOREIGN_CARD_REFS_JSON = [{kind, id, ref}] (published); TEST_PRIORITY=1.
 */
export function testPriorityEnv(profileFile, { env = process.env, loadProfile = null } = {}) {
  if (env.TEST_PRIORITY === '0') return { env: {}, summary: 'TEST_PRIORITY=0 — built-ins only' };
  if (forcedByHarness(env)) return { env: {}, summary: 'a test harness forces the defs — no draft priority' };
  let p = null;
  try { p = loadProfile ? loadProfile(profileFile) : JSON.parse(fs.readFileSync(profileFile, 'utf8')); } catch { p = null; }
  const drafts = draftDefs(profileFile), pub = publishedOfTeam(p);
  const out = {}, said = [];
  const dc = drafts.find(d => d.kind === 'class');
  if (dc) { out.FORCE_FOREIGN_CLASS = dc.file; said.push(`class ${dc.name} (draft)`); }
  else if (pub.classes[0]) { out.FOREIGN_CLASS_REF_JSON = JSON.stringify(pub.classes[0].ref); said.push(`class ${pub.classes[0].name} (published)`); }
  const refs = [];
  for (const kind of ['skill', 'effect']) {
    const mine = drafts.filter(d => d.kind === kind).slice(0, TEST_SLOTS[kind]);
    if (mine.length) out[kind === 'skill' ? 'FORCE_FOREIGN_SKILL' : 'FORCE_FOREIGN_EFFECT'] = mine.map(d => d.file).join(',');
    const theirs = pub.cards.filter(x => x.kind === kind && !mine.some(d => d.id === x.id)).slice(0, TEST_SLOTS[kind] - mine.length);
    refs.push(...theirs);
    if (mine.length || theirs.length) said.push(`${kind}s ${[...mine.map(d => `${d.id} (draft)`), ...theirs.map(x => `${x.id} (published)`)].join(', ')}`);
  }
  if (refs.length) out.FOREIGN_CARD_REFS_JSON = JSON.stringify(refs);
  if (!said.length) return { env: {}, summary: 'no drafts or published custom defs — built-ins only' };
  out.TEST_PRIORITY = '1';
  return { env: out, summary: said.join('; ') };
}

/** The blank values a companion / ally / monster worker must get (it never inherits the hero's test priority). */
export const TEST_PRIORITY_BLANK = Object.freeze(Object.fromEntries(ENV_KEYS.map(k => [k, ''])));
