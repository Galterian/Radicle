// LLM controller for bot units (AI skirmish, 2026-11-22): a local llama-server (Qwen3-1.7B Q4_K_M, OpenAI-compatible
// /v1/chat/completions) picks ONE of the plans peer.mjs already judged legal, and a short in-character line.
//
// - Never part of the resolver: the pick is this unit's private plan, committed / revealed like any other (the
//   weighted npcPlan pick already used Math.random), so it cannot cause a STATE DIVERGENCE.
// - Asked when the planning window opens, read at the deadline (npcPlan): a late / failed / malformed answer
//   simply leaves the deterministic npcPlan plan in place.
// - The model answers {"choice": n, "say": "..."} under a JSON-schema grammar whose `choice` is an enum of the
//   offered option numbers — it cannot name an illegal card, target or hex.
// - `say` travels in evt_action_reveal only (never the commit: a line said before the cards are locked would
//   give the plan away) and is cleaned again by every receiver (cleanSay).
//
// Roles (AI_ROLE env, set by the launcher for AI skirmish dimensions — see ui-server.mjs startDimension):
//   team    — my side's bots (npc_a allies)
//   rival   — the rival team (npc_c heroes, hostile to everyone)
//   monster — wild creatures (npc_b)
//   builder — NPC builders on my side: raise Barricades (resolver: peer.mjs "NPC builders"), fight only when cornered

import { authHeaders } from './oci-auth.mjs';   // OCI: the key where set, else this device's signature (infra/oci/llm-gate.mjs)
export const AI_ROLES = ['team', 'rival', 'monster', 'builder'];
export const SAY_MAX = 60;

// Env → config. LLM_URL '' or '0' turns the model off (deterministic npcPlan only).
export function llmConfig(env = {}) {
  const raw = env.LLM_URL ?? 'http://127.0.0.1:8095';
  const url = raw === '0' ? '' : String(raw).replace(/\/+$/, '');
  return {
    url,
    key: env.LLM_KEY || '',
    model: env.LLM_MODEL || 'qwen3-1.7b',
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 4500),   // capped by the planning window (peer.mjs llmKick)
    temperature: Number(env.LLM_TEMPERATURE || 0.7),
    sayEvery: Math.max(1, Number(env.LLM_SAY_EVERY || 2)),   // at most one line per this many actions
    // A bot asks the model every `every`-th action (its own offset, askThisAction), the rules play the others: one
    // CPU llama-server reads ≈130 prompt tokens/s, so 7 bots asking every 6 s action would all time out.
    every: Math.max(1, Number(env.LLM_EVERY || 3)),
  };
}

// Whether a unit asks the model at this action: every `every`-th action, offset by a hash of its id so the bots of a
// dimension spread their requests over the actions.
export function askThisAction(action, id, every) {
  if (every <= 1) return true;
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (action + h) % every === 0;
}

// The role a unit plays. An explicit AI_ROLE wins; humans never get one; anything else gets none (no model).
export function aiRoleFor({ role, isHuman }) {
  if (isHuman) return '';
  return AI_ROLES.includes(role) ? role : '';
}

// The action matrix as the resolver applies it (peer.mjs doResolution edgeDmg, user ruling 2026-11-05) — keep in step.
export const COMBAT_HINT = 'Damage: A hits 1 vs all but B; B reflects 1 to A; P hits 1 vs M/EM/EP; M hits 1 vs B.';

// Persona + sample lines (the samples keep the small model from reading its option back as its line).
const PERSONA = {
  team: ['You fight beside the human hero: protect the hero, finish wounded enemies.', 'Covering you! | On your flank! | Hold the line!'],
  rival: ['You lead a rival team; every other unit is your enemy. Read their habits and counter them.', 'Predictable! | This land is ours. | Too slow!'],
  monster: ['You are a wild monster: charge the nearest prey, strike hard, never retreat.', 'GRAAAH! | Fresh meat! | *snarls*'],
  builder: ['You are an NPC builder allied with the hero: raise barricades, avoid fights, defend when cornered.', 'Wall going up! | Mind the stones. | Hold them off, I build!'],
};

// The system prompt is the same for every call of a unit (llama-server reuses its cached prefix).
export function systemPrompt({ role, name }) {
  const [who, lines] = PERSONA[role] || PERSONA.team;
  return [
    `You are "${name}" in a hex card game. ${who}`,
    `Cards: A attack (adjacent), M move, B block, P posture (casts need it). ${COMBAT_HINT}`,
    'Pick one numbered option. Reply JSON {"choice": n, "say": "..."}.',
    `"say": a short in-character shout, max 6 words, never naming the card or the option (like: ${lines}), or "".`,
  ].join('\n');
}

// One user message: the situation and the options (each option's `label` is plain text built by peer.mjs). Kept
// compact: prompt reading is the cost on a CPU box (≈130 tokens/s on the desktop node), the reply is ~15 tokens.
export function userPrompt({ turn, round, roundsPerTurn, me, foes, friends, options }) {
  const unit = (u) => `${u.name} ${u.life}/${u.lifeMax ?? '?'} d${u.dist}${u.recent?.length ? ` (played ${u.recent.join(',')})` : ''}`;
  return [
    `Turn ${turn} action ${round + 1}/${roundsPerTurn}. Me: life ${me.life}/${me.lifeMax}, hand ${me.hand || 'empty'}.`,
    foes.length ? `Foes (life, d=hexes): ${foes.slice(0, 4).map(unit).join('; ')}.` : 'No foe in sight.',
    friends.length ? `Friends: ${friends.slice(0, 3).map(unit).join('; ')}.` : '',
    'Options:',
    ...options.map((o, i) => `${i + 1}. ${o.label}`),
  ].filter(Boolean).join('\n');
}

// The JSON schema llama-server turns into a grammar: choice ∈ {1..n}, say a short string.
export function answerSchema(n) {
  return {
    type: 'object',
    properties: {
      choice: { type: 'integer', enum: Array.from({ length: n }, (_, i) => i + 1) },
      say: { type: 'string', maxLength: SAY_MAX },
    },
    required: ['choice', 'say'],
    additionalProperties: false,
  };
}

// A line as it may be shown: one line, printable, at most SAY_MAX characters. Used by the sender AND every receiver.
export function cleanSay(s) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > SAY_MAX ? `${t.slice(0, SAY_MAX - 1)}…` : t;
}

// Parse the model's answer → { choice (1-based), say } | null.
export function parseAnswer(text, n) {
  if (typeof text !== 'string') return null;
  const m = text.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  const choice = Number(o?.choice);
  if (!Number.isInteger(choice) || choice < 1 || choice > n) return null;
  return { choice, say: cleanSay(o.say) };
}

// One request. Resolves { choice, say, ms } or null (timeout, refused, unreachable, malformed) — never throws.
export async function askLlm(cfg, { system, user, n, timeoutMs, fetchImpl = globalThis.fetch }) {
  if (!cfg.url || !n || typeof fetchImpl !== 'function') return null;
  const t0 = Date.now();
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: cfg.temperature,
    max_tokens: 48,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },   // Qwen3: no <think> block
    response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: answerSchema(n) } },
  };
  try {
    const r = await fetchImpl(`${cfg.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg, 'POST', `${cfg.url}/v1/chat/completions`, JSON.stringify(body)) },   // key, else the device signs (oci-auth)
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(200, timeoutMs ?? cfg.timeoutMs)),
    });
    if (!r.ok) return { error: `http ${r.status}`, ms: Date.now() - t0 };
    const j = await r.json();
    const ans = parseAnswer(j?.choices?.[0]?.message?.content, n);
    return ans ? { ...ans, ms: Date.now() - t0 } : { error: 'malformed answer', ms: Date.now() - t0 };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.message || 'error'), ms: Date.now() - t0 };
  }
}


// A line that only reads the chosen option back ("Attack Anna!" for "Attack Anna the Firestroker") is dropped — the
// unit stays silent rather than announce its card. True when ≥ 75 % of the line's words are in the option label.
export function echoesOption(say, label) {
  const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const w = words(say);
  if (!w.length) return false;
  const lab = new Set(words(label));
  return w.filter(x => lab.has(x)).length / w.length >= 0.75;
}

// ---- Banter (user 2026-11-23): "funny fantasy world lines for the units I see … conversation balloons between the
// units", generated in BULK — one request writes a short scene for every unit in sight, off the planning path (no
// 4.5 s deadline, never part of a plan or the state hash). Asked by the hero's peer for its own UI (peer.mjs
// banterFor); the UI plays the lines one after another as speech balloons.
export const BANTER_MAX_UNITS = 6;
export const BANTER_SAY_MAX = 90;   // a banter balloon holds 3 lines of ~30 characters (a reveal shout: SAY_MAX)
export const BANTER_LINES = 6;   // short scene: ~200 tokens, it shares the server with the bots' picks
const ROLE_WORDS = { hero: 'the human hero', team: "the hero's ally", builder: "the hero's builder (raises barricades, grumbles a lot)",
  rival: 'a rival team hero (boastful)', monster: 'a wild monster (growls, hungry)', unit: 'a wanderer' };
export function banterSystemPrompt() {
  return [
    'You write funny banter for a fantasy hex battle game, like a comic fantasy novel.',
    'Rules: every line is SHORT (4 to 9 words) and different; speakers tease, threaten, joke and answer each other;',
    'call the OTHER units by name, never yourself; monsters growl or speak broken words; builders grumble about walls and stones.',
    'Never mention cards, dice, numbers, turns or the game. Reply JSON {"lines": [{"who": n, "line": "..."}]}.',
    'Example (other names): Grok: "Me smash tiny wall!" / Mira: "That wall cost me three fingernails, Grok." / Sir Hob: "Stand back, Mira, I shall bravely watch." / Grok: "Knight smell like soup."',
  ].join('\n');
}
// units: [{ name, what (creature / class name or ''), role (hero|team|builder|rival|monster), friend (bool, from the hero's side) }]
export function banterUserPrompt({ units, place = '', mood = '' }) {
  return [
    `Scene${place ? ` in ${place}` : ''}${mood ? `: ${mood}` : ''}. Speakers:`,
    ...units.map((u, i) => `${i + 1}. ${u.name}${u.what ? ` (${u.what})` : ''} — ${ROLE_WORDS[u.role] || ROLE_WORDS.unit}, ${u.friend ? "on the hero's side" : 'an enemy of the hero'}`),
    `Write ${BANTER_LINES} lines of conversation between them; each line answers the one before; no speaker twice in a row; everyone speaks at least once.`,
  ].join('\n');
}
export function banterSchema(n) {
  return {
    type: 'object',
    properties: { lines: { type: 'array', minItems: 3, maxItems: BANTER_LINES, items: {
      type: 'object', properties: { who: { type: 'integer', enum: Array.from({ length: n }, (_, i) => i + 1) }, line: { type: 'string', minLength: 8, maxLength: BANTER_SAY_MAX + 20 } },
      required: ['who', 'line'], additionalProperties: false } } },
    required: ['lines'],
    additionalProperties: false,
  };
}
// A long line is cut at a word (never mid-word) to fit a balloon: SAY_MAX characters with its "…".
function shortLine(s) {
  const t = String(s ?? '').replace(/[*_]/g, '').replace(/[ -<>`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= BANTER_SAY_MAX) return t;
  const cut = t.slice(0, BANTER_SAY_MAX - 1).replace(/[\s,;:—-]+\S*$/, '');
  return `${cut || t.slice(0, BANTER_SAY_MAX - 1)}…`;
}
// The 1.7B often makes a unit call ITSELF by name ("Rhox, your alchemy…" said by Rhox): the line is meant for the unit
// that spoke before, so that one's name goes in front instead (no previous line: the vocative is dropped).
export function fixSelfAddress(lines, names) {
  const first = (n) => String(n || '').split(/[\s,—-]+/).filter(Boolean)[0]?.toLowerCase() || '';
  return lines.map((l, i) => {
    const own = first(names[l.who]);
    const m = own && l.line.match(/^([^,!?]{1,40})[,!]\s*(.+)$/);
    if (!m || first(m[1]) !== own) return l;
    const prev = i > 0 ? names[lines[i - 1].who] : '';
    const rest = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return { ...l, line: prev ? `${String(prev).split(/\s+/).slice(0, 2).join(' ')}, ${m[2]}` : rest };
  });
}
// → [{ who (0-based index), line }] — cleaned, empty / repeated lines and a speaker answering itself dropped.
export function parseBanter(text, n) {
  if (typeof text !== 'string') return null;
  const m = text.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(o?.lines)) return null;
  const out = [], seen = new Set();
  for (const l of o.lines.slice(0, BANTER_LINES)) {
    const who = Number(l?.who);
    const line = shortLine(l?.line);
    const key = line.toLowerCase().replace(/[^a-z]+/g, '');
    if (!Number.isInteger(who) || who < 1 || who > n || !line || seen.has(key)) continue;
    if (out.length && out[out.length - 1].who === who - 1) continue;
    seen.add(key);
    out.push({ who: who - 1, line });
  }
  return out.length ? out : null;
}
// One bulk request → { lines, ms } | { error, ms } | null (model off). Never throws.
export async function askBanter(cfg, { units, place = '', mood = '', timeoutMs = 60000, fetchImpl = globalThis.fetch }) {   // off the planning path: a busy server may take long
  const us = (units || []).slice(0, BANTER_MAX_UNITS);
  if (!cfg.url || us.length < 2 || typeof fetchImpl !== 'function') return null;
  const t0 = Date.now();
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: banterSystemPrompt() }, { role: 'user', content: banterUserPrompt({ units: us, place, mood }) }],
    temperature: Math.max(cfg.temperature, 0.9),
    max_tokens: 320,
    frequency_penalty: 0.6, presence_penalty: 0.4, repeat_penalty: 1.15,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'banter', strict: true, schema: banterSchema(us.length) } },
  };
  try {
    const r = await fetchImpl(`${cfg.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg, 'POST', `${cfg.url}/v1/chat/completions`, JSON.stringify(body)) },   // key, else the device signs (oci-auth)
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
    if (!r.ok) return { error: `http ${r.status}`, ms: Date.now() - t0 };
    const j = await r.json();
    const lines = parseBanter(j?.choices?.[0]?.message?.content, us.length);
    return lines ? { lines, ms: Date.now() - t0 } : { error: 'malformed answer', ms: Date.now() - t0 };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.message || 'error'), ms: Date.now() - t0 };
  }
}
