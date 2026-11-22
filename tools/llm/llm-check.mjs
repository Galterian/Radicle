// Smoke test + latency of the chaosD6 llama-server (the exact request game/llm-brain.mjs sends).
//   node tools/llm/llm-check.mjs [url] [n]      url default $LLM_URL or http://127.0.0.1:8095, n requests (default 6)
// Prints each answer and its time, then the median — a peer needs the answer inside its planning window
// (ROUND_SEC 6 s minus the handshake; LLM_TIMEOUT_MS 2500 by default).
import { llmConfig, askLlm, systemPrompt, userPrompt } from '../../game/llm-brain.mjs';

const cfg = llmConfig({ ...process.env, ...(process.argv[2] ? { LLM_URL: process.argv[2] } : {}) });
const n = Number(process.argv[3] || 6);
const health = await fetch(`${cfg.url}/health`).then(r => r.status).catch(e => e.cause?.code || e.message);
console.log(`${cfg.url}/health → ${health}`);

const roles = ['monster', 'team', 'rival', 'builder'];
const options = [
  { label: 'Attack Anna the Firestroker' },
  { label: 'Move toward Pride Guardian' },
  { label: 'Block' },
  { label: 'Posture (gather an element)' },
  { label: 'Cast Fireball at Anna the Firestroker (2 actions)' },
];
const times = [];
for (let i = 0; i < n; i++) {
  const role = roles[i % roles.length];
  const opts = role === 'builder' ? [...options.slice(2, 4), { label: 'Build a barricade between you and Ruinous Minotaur' }] : options;
  const user = userPrompt({
    turn: 3 + i, round: i % 3, roundsPerTurn: 3,
    me: { life: 4, lifeMax: 6, hand: 'A, M, P, Fireball' },
    foes: [{ name: 'Anna the Firestroker', life: 3, lifeMax: 5, dist: 1, recent: ['A', 'A', 'B'] }, { name: 'Pride Guardian', life: 6, lifeMax: 6, dist: 3, recent: ['M'] }],
    friends: [{ name: 'Ridge Runnet', life: 2, lifeMax: 4, dist: 2 }],
    options: opts,
  });
  const ans = await askLlm(cfg, { system: systemPrompt({ role, name: role === 'monster' ? 'Ruinous Minotaur' : `Test ${role}` }), user, n: opts.length, timeoutMs: 15000 });
  if (ans?.error) console.log(`${role.padEnd(8)} ✗ ${ans.error} (${ans.ms} ms)`);
  else if (ans) { times.push(ans.ms); console.log(`${role.padEnd(8)} #${ans.choice} ${opts[ans.choice - 1].label.padEnd(52)} "${ans.say}"  ${ans.ms} ms`); }
  else console.log(`${role.padEnd(8)} ✗ no answer`);
}
times.sort((a, b) => a - b);
if (times.length) console.log(`median ${times[Math.floor(times.length / 2)]} ms, max ${times[times.length - 1]} ms over ${times.length} answers`);
process.exit(times.length === n ? 0 : 1);
