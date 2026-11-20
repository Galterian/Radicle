// game/class-state.mjs — the generic class-state store (class isolation phase 2, 2026-11-20).
//
// Every unit keeps ONE store, namespaced by class id:
//   { <class_id>: { charges: { <name>: { turn, n } }, <key>: <JSON value>, … }, … }
// It travels as ONE snapshot field, `class_state_json`: canonical JSON (object keys sorted at every depth, empty
// namespaces dropped), '' while the store is empty. It replaces the per-class snapshot fields (stealth_turn,
// rogue_trap_turn / rogue_trap_n, chase_bonus, chasers_csv, reanimated_csv, reanim_down_csv); peer.mjs wrote them
// beside it for one phase each (gone: phase 4, reanim_down_csv phase 5). The resolver reads other units' class state only
// through parseClassState(snapshot.class_state_json); class programs through the class_state ctx op (class-engine.mjs).
// Pure: no peer globals, no I/O.

// Canonical JSON (= defs-repo.mjs#canonicalJson for the values a store holds: objects, arrays, strings, finite
// numbers, booleans, null). Kept local so the class engine's import closure stays free of node: modules.
export function canonicalStateJson(value) {
  const out = (v) => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string': return JSON.stringify(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'number': if (!Number.isFinite(v)) throw new TypeError('class state: non-finite number'); return JSON.stringify(v);
      case 'object':
        if (Array.isArray(v)) return `[${v.map(out).join(',')}]`;
        return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${out(v[k])}`).join(',')}}`;
      default: throw new TypeError(`class state: unsupported ${typeof v}`);
    }
  };
  return out(value);
}
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isEmpty = (v) => v === undefined || v === null || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).some(k => !isEmpty(v[k])));

// classStateJson(store) → the snapshot string ('' for an empty store). Empty values / namespaces are left out, so
// a unit that never touched its class state publishes nothing.
export function classStateJson(store) {
  if (!isObj(store)) return '';
  const prune = (v) => {
    if (!isObj(v)) return v;
    const o = {};
    for (const k of Object.keys(v)) { const x = prune(v[k]); if (!isEmpty(x)) o[k] = x; }
    return o;
  };
  const p = prune(store);
  return Object.keys(p).length ? canonicalStateJson(p) : '';
}

// parseClassState(s) → the (deep-frozen) store of a snapshot string; {} for '' / bad JSON / a non-object.
const cache = new Map();
const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const EMPTY = Object.freeze({});
export function parseClassState(s) {
  if (isObj(s)) return s;   // already a store (a local entity)
  if (typeof s !== 'string' || !s) return EMPTY;
  let v = cache.get(s);
  if (v === undefined) {
    try { v = JSON.parse(s); } catch { v = null; }
    v = isObj(v) ? freeze(v) : EMPTY;
    if (cache.size >= 512) cache.delete(cache.keys().next().value);
    cache.set(s, v);
  }
  return v;
}

// The namespace of one class: nsOf (read, {} when absent) / nsFor (write, created on demand).
export const nsOf = (store, cls) => (isObj(store) && isObj(store[cls]) ? store[cls] : EMPTY);
export function nsFor(store, cls) {
  if (!isObj(store[cls])) store[cls] = {};
  return store[cls];
}

// ---- per-turn charges: { turn, n } = the last turn the charge was used and how often in it -----------------------
export const chargeOf = (store, cls, name) => { const c = nsOf(store, cls).charges?.[name]; return isObj(c) ? c : null; };
// Uses of the charge in `turn`.
export const chargeUsed = (store, cls, name, turn) => { const c = chargeOf(store, cls, name); return c && c.turn === turn ? Math.max(0, Number(c.n) || 0) : 0; };
// Uses left of `perTurn` in `turn` (= class-traps.mjs#chargesLeft over the record).
export const chargeLeft = (store, cls, name, perTurn, turn) => Math.max(0, perTurn - chargeUsed(store, cls, name, turn));
// spendCharge: `n` more uses in `turn` (a record of an older turn starts over). Returns the uses in `turn`.
export function spendCharge(store, cls, name, turn, n = 1) {
  const ns = nsFor(store, cls);
  if (!isObj(ns.charges)) ns.charges = {};
  const c = ns.charges[name];
  ns.charges[name] = { turn, n: (isObj(c) && c.turn === turn ? Math.max(0, Number(c.n) || 0) : 0) + n };
  return ns.charges[name].n;
}
// The turn a charge was last used (-1 if never) — the old single-field snapshot form (stealth_turn, rogue_trap_turn).
export const chargeTurn = (store, cls, name) => { const c = chargeOf(store, cls, name); return c && Number.isInteger(c.turn) ? c.turn : -1; };
// Was a charge of this name used in `turn` by ANY class of the unit (class ids in code-unit order)?
export const anyChargeUsed = (store, name, turn) => isObj(store) && Object.keys(store).sort().some(cls => chargeUsed(store, cls, name, turn) > 0);

// ---- keyed values ------------------------------------------------------------------------------------------------
export const stateGet = (store, cls, key, dflt) => { const v = nsOf(store, cls)[key]; return v === undefined ? dflt : v; };
export function stateSet(store, cls, key, value) { nsFor(store, cls)[key] = value; return value; }
// A list value of every class namespace of every store, as a Set (e.g. every unit any class has raised).
export function unionOf(stores, key) {
  const out = new Set();
  for (const s of stores) {
    const st = parseClassState(s);
    for (const cls of Object.keys(st).sort()) { const v = st[cls]?.[key]; if (Array.isArray(v)) for (const x of v) out.add(x); }
  }
  return out;
}
