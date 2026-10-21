// Two independent buses (as if two machines) on one dimension tag; A publishes,
// B must receive via the public relays. Prints latency per message.
import { createNostrBus } from '../nostr-bus.mjs';
const dimId = `rt-${Math.random().toString(36).slice(2, 8)}`;
let got = 0;
const B = createNostrBus({ dimId, label: 'B', onEvent: (type, payload, meta) => { got++; console.log(`B got ${type} #${payload.n} from ${meta.from} via ${meta.relay} in ${Date.now() - payload.t} ms`); } });
const A = createNostrBus({ dimId, label: 'A', onEvent: () => {} });
await new Promise(r => setTimeout(r, 3000));
for (let n = 1; n <= 5; n++) { console.log(`A → ${A.publish('ping', { n, t: Date.now() })} relays`); await new Promise(r => setTimeout(r, 1200)); }
await new Promise(r => setTimeout(r, 3000));
console.log('A stats', JSON.stringify(A.stats()), '\nB stats', JSON.stringify(B.stats()), `\nreceived ${got}/5 (dedupe across relays expected)`);
A.close(); B.close(); process.exit(got >= 4 ? 0 : 1);
