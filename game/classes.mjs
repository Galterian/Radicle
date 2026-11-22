// game/classes.mjs — PURE class rules (chaosD6-Classes milestone C1, user request 2026-11-16: "Now do the same
// split for the CLASSES as well. Make a new repo chaosD6-Classes and extract there the skills as jsonlogic and the
// tools and validator").
//
// Since class isolation phase 6 (2026-11-20) this module is the class-oblivious DISPATCHER: the bundled definitions
// (classes-data/classes/*.json — the chaosD6-Classes content, the pre-seeded cache of built-ins by reference) give
// `CLASS_RULES` (their flags) and every hook answer through class-engine.mjs (CLASS_ENGINE=data, the default); foreign
// classes register here too (registerForeignClass). The JS reference hooks and the class configs are TEST ORACLES in
// classes-data/oracle/ (chaosD6-Classes) — CLASS_ENGINE=js | shadow load them with installClassOracle(); the generic
// primitives the resolver applies class results with live in world-prims.mjs / contact-prims.mjs. No class id appears
// here as code (tools/class-engine-check.mjs grep gate). Hook inventory, inputs / outputs, call sites: classes-data/HOOKS.md.
//
// Resolver ctx (`clCtx`) — fields a hook may read (all optional unless the hook needs them):
//   self, label                          my peer id, PEER_LABEL
//   view(id), viewIds(), viewValues()    snapshot of one unit / [...view.keys()] / [...view.values()] (view order)
//   lifeOf(id), dist(a, b)               life as the resolver sees it; hex distance of the snapshot tiles (Infinity if unknown)
//   enemyOf(a, b), hasPerm(id, p)        hostility; permanents (snapshot / entity)
//   statOf(id, stat)                     effective stat (tokens / penalties folded in)
//   sideOf(alliance)                     'A' | 'B' | 'C' | …
//   classData(id)                        the active data/classes.json version's `data` (or undefined)
//   skillAction(skillId)                 data/skills.json action_type of a skill (Bard)
//   skillIsTrance(skillId)               true for the trance skill (skills.mjs TRANCE, flags.trance) (Bard; JS oracle)
//   library()                            [{effect_id, elements}] — the Library (Alchemist)
//   turn, action                         hg.turn, hg.action
//   sha(s)                               sha256 hex (peer.mjs sha256Hex)
import * as CE from './class-engine.mjs';   // C2 data hooks (pure; loads classes-data/ only when used)

export const STATS = ['vitality', 'world', 'matter', 'will'];
export const TRAP_POWER = 20;          // = effects.mjs TRAP_POWER (tools/classes-check.mjs asserts it)
export const STRIKE_DIE = 6;           // a class colour falls to a die of 6 (user ruling 2026-10-30)
export const ILLUSION_RANGE = 10;      // Illusionist: allies within 10 hexes (user ruling 2026-11-12)
// (TRANCE left, skill isolation 2026-11-22: classes.mjs names no skill id — the Bard oracle asks ctx.skillIsTrance.)
// = peer.mjs ELEM_TO_STAT (data/elements.json stat of each element) — used when the ctx has no elemStat.
export const ELEM_TO_STAT = Object.freeze({ elem_vitality: 'vitality', elem_souls: 'world', elem_time: 'world', elem_space: 'world', elem_air: 'matter', elem_water: 'matter', elem_earth: 'matter', elem_fire: 'matter', elem_concentration: 'will', elem_harmony: 'will' });

// Flags per class = the `flags` of its definition (class isolation phase 1, 2026-11-20: the definitions in
// game/classes-data/classes/*.json — or CLASS_DEFS_DIR — are the only source; a new class needs no edit here).
// Key order = sorted class id (every iteration over CLASS_RULES is per held class or commutative).
//   phase       where its clicked ability resolves: 'pre' (simulate pre-pass, before casts), 'post' (post-pass
//               switch), 'local' (planning, this peer only — CLASS_LOCAL), null (no click: static / passive)
//   needs       what the click must carry (peer.mjs CLASS_NEEDS): tile | ally_or_self | enemy_near | monster_near | attach_effect
//   local       planning-time deck operation (CLASS_LOCAL): {op: recover, kind, what} | {op: draw, n} | {op: grant, effect_id}
//   passiveTurn fires by itself once per turn (peer.mjs PASSIVE_TURN_CLASSES)
//   perAction   CR 2026-11-17 (Elementalist): the passive fires at most once per ACTION — the use never spends the turn
//   handDefaults  fallbacks for hand classes (peer.mjs HAND_CLASS_DEFAULTS)
//   stance      code → code the action fights as (Reaver EP/EM → A, Barbarian EP/EM → B — CR 2026-11-18 (a); the Monk's
//               EP-as-Move stance was dropped, CR 2026-11-17)
//   emits       action codes that emit an element: true = every site, [sites] = only there (user rulings 2026-11-16:
//               Barbarian B and Monk M / EM emit at every site — planning, Rule 24, Manipulator, element badge;
//               CR 2026-11-18 (b): the Enchanter's A / B / M at every site, static)
//   planEmits   (legacy, no built-in uses it since CR 2026-11-18) these codes emit once per turn while a cast is queued
//   hooks       the hook points it acts in (HOOKS.md); 'peer:<name>' = behaviour that stays in peer.mjs
// The bundled class set: every definition is a built-in class (JS markers allowed, travels by name for now).
// Lenient: an invalid file is left out (a staged chaosD6-Classes tree is judged file by file by its validator);
// peer.mjs refuses to start while classBundleErrors() is not empty.
const BUNDLE = CE.loadClassDefs(undefined, { lenient: true });
export const classBundleErrors = () => [...BUNDLE.errors];
export const CLASS_RULES = Object.fromEntries([...BUNDLE.defs.keys()].sort().map(id => [id, JSON.parse(JSON.stringify(BUNDLE.defs.get(id).flags || {}))]));
export const CLASSES_IMPLEMENTED = Object.keys(CLASS_RULES);
// Class isolation phase 3: no ability resolves in peer.mjs any more — the map-bound ones (Animator, Priest, Cleric,
// Seeker, Warrior) return engine REQUESTS (class-engine.mjs ABILITY_REQUESTS) that simulate() resolves.
export const ABILITY_REQUESTS = CE.ABILITY_REQUESTS;
export const CLASS_NEEDS = Object.fromEntries(CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].needs).map(id => [id, CLASS_RULES[id].needs]));
export const PASSIVE_TURN_CLASSES = new Set(CLASSES_IMPLEMENTED.filter(id => CLASS_RULES[id].passiveTurn));

// ---- small shared helpers (= the peer.mjs closures they replace) ---------------------------------------------
const elemStatOf = (ctx) => (el) => (ctx && typeof ctx.elemStat === 'function' ? ctx.elemStat(el) : ELEM_TO_STAT[el]);
const pickBySalt = (seed, list, sha) => list.length ? list[parseInt(sha(seed).slice(0, 8), 16) % list.length] : null;   // = effects.mjs#pickBySalt
const parseJsonList = (s, dflt) => { try { const v = JSON.parse(s || ''); return Array.isArray(v) ? v : dflt; } catch { return dflt; } };   // = simulate()#parseJson
// The data of a class: the caller's data/classes.json view, else the bundled definition (a foreign class — always its definition).
const cdOf = (ctx, id) => {
  if (suspended.has(id)) return {};   // CH: a dormant foreign class has no data this resolution
  if (ctx && typeof ctx.classData === 'function' && !foreignIds.has(id)) return ctx.classData(id) || {};
  return defOf(id)?.data || {};
};
const rulesOf = (id) => CLASS_RULES[id] || {};

// ---- the JS reference hooks (class isolation phase 6, 2026-11-20) -------------------------------------------------
// They moved to classes-data/oracle/classes-js.mjs (a TEST ORACLE in chaosD6-Classes): the game runs the definitions
// only. CLASS_ENGINE=js | shadow need the oracle installed first: installClassOracle(await import(…classes-js.mjs)).
// oracleSupport = the class-data helpers the oracle shares with the data path (never used by peer.mjs).
export const REANIMATED_ELEMS = Object.freeze(['elem_harmony', 'elem_concentration']);
export const oracleSupport = Object.freeze({ elemStatOf, pickBySalt, parseJsonList, cdOf, rulesOf });
let ORACLE = null;
export function installClassOracle(o) {
  if (!o || typeof o.jsHook !== 'function' || !o.HOOKS) throw new Error('installClassOracle: not the classes-js.mjs oracle');
  ORACLE = o;
}
export const classOracle = () => ORACLE;
const needOracle = () => { if (!ORACLE) throw new Error(`CLASS_ENGINE=${CLASS_ENGINE} needs the JS oracle: call installClassOracle() with the module classes-data/oracle/classes-js.mjs first`); return ORACLE; };   // (no import() text here: classes-repo-sync's closure scan would copy the oracle into tools/engine)
const jsHook = (hookName, id, ctx, args) => needOracle().jsHook(hookName, id, ctx, args);
export const HOOK_NAMES = [...CE.HOOK_NAMES];
export function classHook(hookName, classId, ctx, args = {}) {
  if (!CE.HOOK_SPECS[hookName]) throw new Error(`classes.mjs: unknown hook ${hookName}`);
  if (foreignIds.has(classId)) return dataHook(hookName, classId, ctx, args);   // CH: dormant → as an unknown class (no definition: std programs / neutral)
  if (CLASS_ENGINE === 'js') return jsHook(hookName, classId, ctx, args);
  if (CLASS_ENGINE === 'data') return dataHook(hookName, classId, ctx, args);
  return shadowHook(hookName, classId, ctx, args);
}
// Convenience wrappers peer.mjs uses where the old code called a closure.
export const classColours = (ctx, id) => classHook('colours', id, ctx);
export const classKindOf = (ctx, id) => classHook('kind', id, ctx);
// builtinClassEntries() → { id: {id, name, tags, data} } of the bundled definitions, sorted by id — what peer.mjs
// reads as data.classes (class isolation phase 1: one class-data source; tools/class-engine-check.mjs keeps
// data/classes.json, still the rebalance / proposals collection, equal to it).
export const builtinClassEntries = () => Object.fromEntries([...BUNDLE.defs.keys()].sort().map(id => { const d = BUNDLE.defs.get(id); return [id, { id, name: d.name, tags: [], data: JSON.parse(JSON.stringify(d.data || {})) }]; }));

// ---- C2: engine switch, data hooks, foreign classes --------------------------------------------------------------
// CLASS_ENGINE=data (default since class isolation phase 1): every hook runs the program of the class's definition
// (game/classes-data/classes/<id>.json, or CLASS_DEFS_DIR; std hooks fall back to lib classes_std); an ability marked
// {"engine":"js","impl":"peer.mjs#…"} returns null (peer.mjs resolves it). shadow: both run, results must be
// JSON-identical; a mismatch goes to stderr, CLASS_SHADOW_STRICT=1 throws; the JS result is returned.
// js: the JS reference hooks (classes-data/oracle/classes-js.mjs, installClassOracle — phase 6).
// CLASS_SHADOW_REPORT=1 prints a tally at exit.
const ENGINE_ENV = (typeof process !== 'undefined' && process.env) || {};
export const CLASS_ENGINE = ['js', 'shadow'].includes(ENGINE_ENV.CLASS_ENGINE) ? ENGINE_ENV.CLASS_ENGINE : 'data';
export const classShadowStats = { compared: 0, mismatches: 0, errors: 0, byHook: {} };
const BUILTIN_IDS = new Set(CLASSES_IMPLEMENTED);
export const classBundle = () => BUNDLE;
// Class isolation phase 5: what the UI shows of a class, from its definition (built-in or foreign) — the `ui` block
// (chaosd6.class/2) + `reanim` = the elements a unit it raised loses to a `die` (data.destroy_reanimated). js/main.js
// renders these without knowing class ids (peer.mjs hello / class_catalog `class_ui`).
export const classUiOf = (id) => {
  const d = foreignClassDef(id) || BUNDLE.defs.get(id);
  if (!d) return {};
  const dr = d.data?.destroy_reanimated;
  return { ...CE.classUi(d), ...(dr ? { reanim: { elements: Array.isArray(dr.elements) && dr.elements.length ? [...dr.elements] : [...REANIMATED_ELEMS], die: Number.isInteger(dr.die) ? dr.die : STRIKE_DIE } } : {}) };
};
const foreignByKey = new Map(), foreignById = new Map(), foreignIds = new Set();
const suspended = new Map();   // CH: foreign id → its CLASS_RULES entry while the class is dormant (suspendForeignClasses)
function defOf(id) {
  if (suspended.has(id)) return undefined;
  if (foreignById.has(id)) return foreignById.get(id);
  if (!BUILTIN_IDS.has(id)) return undefined;
  try { return classBundle().defs.get(id); } catch { return undefined; }
}
// The W the programs' queries see (class-engine.mjs CLASS_CTX_OPS). `own` = a definition being run directly.
const wrap = (ctx, own) => ({
  c: ctx,
  cd: (id) => (own && id === own.id && !(ctx && typeof ctx.classData === 'function')) ? (own.data || {}) : cdOf(ctx, id),
  flag: (id, k) => { const d = own && id === own.id ? own : defOf(id); return d ? d.flags?.[k] : CLASS_RULES[id]?.[k]; },
  sha: (s) => ctx.sha(s),
  elemStat: elemStatOf(ctx),
});
let noted = 0;
const note = (msg) => { classShadowStats.errors++; if (noted++ < 20) console.error(`[classes] data hook: ${msg}`); };
function dataHook(hookName, classId, ctx, args, own = null) {
  const d = own && classId === own.id ? own : defOf(classId);
  const prog = CE.programOf(d, hookName, classBundle().std);
  if (!prog) return CE.neutralOf(hookName, args);
  if (prog.js) return prog.js.impl.startsWith('classes.mjs') && d && BUILTIN_IDS.has(d.id) && ORACLE ? ORACLE.HOOKS[hookName](classId, ctx, args) : null;   // phase 3: no markers left
  try {
    const v = CE.runHookProgram(prog, hookName, classId, wrap(ctx, own), args);
    const out = CE.unmarshal(hookName, v);
    if (CE.resultOk(hookName, out)) return out;
    note(`${classId} ${hookName}: bad result ${JSON.stringify(v)}`);
  } catch (e) {
    if (!(e instanceof CE.EffectEngineLimit || e instanceof CE.EffectProgramError)) throw e;   // a ctx query threw: as JS
    note(`${classId} ${hookName}: ${e.message}`);
  }
  return CE.neutralOf(hookName, args);
}
function shadowHook(hookName, classId, ctx, args) {
  const js = jsHook(hookName, classId, ctx, args);
  const want = JSON.stringify(js);
  let got;
  try { got = JSON.stringify(dataHook(hookName, classId, ctx, args)); } catch (e) { got = `throws ${e?.message}`; }
  // A peer-resolved ability is null on both sides by construction.
  classShadowStats.compared++;
  classShadowStats.byHook[hookName] = (classShadowStats.byHook[hookName] || 0) + 1;
  if (got !== want) {
    classShadowStats.mismatches++;
    console.error(`[classes] SHADOW MISMATCH ${hookName} ${classId}\n  js:   ${want}\n  data: ${got}`);
    if (ENGINE_ENV.CLASS_SHADOW_STRICT === '1') throw new Error(`classes shadow mismatch in ${hookName} (${classId})`);
  }
  return js;
}
{
  if (ENGINE_ENV.CLASS_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[classes] ${CLASS_ENGINE}: ${BUNDLE.defs.size} data classes; shadow compared ${classShadowStats.compared}, mismatches ${classShadowStats.mismatches}, errors ${classShadowStats.errors} ${JSON.stringify(classShadowStats.byHook)}`));
}

// validateClassDef(def, {libs, libMap}) → [errors] — a definition file (chaosd6.class/1). JS markers only for built-ins.
export function validateClassDef(def, opts = {}) {
  return CE.validateClassDef(def, { ...opts, builtin: BUILTIN_IDS.has(def?.id) && !foreignIds.has(def?.id) });
}
const prepared = new WeakMap();
// resolveClassProgram(def, hookName, ctx, args) → what classHook(hookName, def.id, ctx, args) returns with only this
// definition answering (its program, else the std default, else the neutral value). An invalid definition throws.
export function resolveClassProgram(def, hookName, ctx, args = {}) {
  if (!CE.HOOK_SPECS[hookName]) throw new Error(`classes.mjs: unknown hook ${hookName}`);
  let own = def.$subs ? def : prepared.get(def);
  if (!own) {
    const errs = validateClassDef(def);
    if (errs.length) throw new Error(`class ${def?.id}: ${errs.join('; ')}`);
    own = CE.bindClassDef(JSON.parse(JSON.stringify(def)));
    prepared.set(def, own);
  }
  return dataHook(hookName, own.id, ctx, args, own);
}
// registerForeignClass(key, def) → the bound definition (a player-branch class, for the C4 handshake). Its flags join
// CLASS_RULES (not CLASSES_IMPLEMENTED: the class pool a peer draws from is unchanged). Throws on a built-in id or
// an invalid definition (a foreign class needs a program for every hook it declares — no JS markers).
export function registerForeignClass(key, def0, opts = {}) {
  const def = JSON.parse(JSON.stringify(def0));
  if (BUILTIN_IDS.has(def?.id)) throw new Error(`registerForeignClass: ${def?.id} is a built-in class`);
  const libs = opts.libs || CE.defaultLibs();
  const errs = CE.validateClassDef(def, { libs, builtin: false });
  if (errs.length) throw new Error(`registerForeignClass ${def?.id}: ${errs.join('; ')}`);
  CE.bindClassDef(def, libs);
  if (foreignById.has(def.id)) throw new Error(`registerForeignClass: another ${def.id} is already registered (one definition per id)`);
  foreignByKey.set(key, def); foreignById.set(def.id, def); foreignIds.add(def.id);
  CLASS_RULES[def.id] = JSON.parse(JSON.stringify(def.flags || {}));
  sortForeignRules();
  return def;
}
// CH: the foreign entries of CLASS_RULES always follow the built-ins in code-unit id order, whatever order a peer
// learned them in (clWith(h) iterates CLASS_RULES — every peer must see the same order).
function sortForeignRules() {
  const ids = [...foreignIds].filter(id => Object.prototype.hasOwnProperty.call(CLASS_RULES, id)).sort();
  const saved = ids.map(id => [id, CLASS_RULES[id]]);
  for (const [id] of saved) delete CLASS_RULES[id];
  for (const [id, r] of saved) CLASS_RULES[id] = r;
}
export const isForeignClassId = (id) => foreignIds.has(id);
export const foreignClassDef = (keyOrId) => foreignByKey.get(keyOrId) || foreignById.get(keyOrId) || null;
export function clearForeignClasses() {
  suspended.clear();
  for (const id of foreignIds) delete CLASS_RULES[id];
  foreignByKey.clear(); foreignById.clear(); foreignIds.clear();
}
// CH (classes-handshake.mjs): a foreign class some revealer could not load is DORMANT for that resolution on every
// peer — no flags (out of CLASS_RULES), no data, every hook answers as for an unknown class (= what a peer lacking
// it computes). suspendForeignClasses(ids) first resumes any earlier suspension; resumeForeignClasses() undoes it.
export function suspendForeignClasses(ids = []) {
  resumeForeignClasses();
  for (const id of ids) if (foreignIds.has(id) && !suspended.has(id)) { suspended.set(id, CLASS_RULES[id]); delete CLASS_RULES[id]; }
  return [...suspended.keys()].sort();
}
export function resumeForeignClasses() {
  if (!suspended.size) return;
  for (const [id, r] of suspended) CLASS_RULES[id] = r;
  suspended.clear();
  sortForeignRules();
}
export const isClassSuspended = (id) => suspended.has(id);
