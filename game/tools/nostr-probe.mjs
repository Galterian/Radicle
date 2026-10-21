// Relay acceptance probe: connect to each relay, publish a burst of ephemeral
// events (what 4 peers on one box produce in a round), count OK/rejections.
//   node tools/nostr-probe.mjs [burst=12] [relay ...]
import { createNostrBus } from '../nostr-bus.mjs';
const argv = process.argv.slice(2);
const burst = Number(argv[0]) || 12;
const relays = argv.slice(1).length ? argv.slice(1) : [
  'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.damus.io', 'wss://relay.snort.social',
  'wss://nostr.wine', 'wss://relay.nostr.bg', 'wss://nostr.oxtr.dev', 'wss://relay.nostr.net', 'wss://nostr.bitcoiner.social',
  'wss://relay.nostrplebs.com', 'wss://nostr-pub.wellorder.net', 'wss://relay.mostr.pub', 'wss://purplepag.es', 'wss://nostr.land',
];
const dimId = `probe-${Math.random().toString(36).slice(2, 8)}`;
const results = await Promise.all(relays.map(async url => {
  let okCount = 0, rejects = [];
  const rx = { n: 0 };
  const bus = createNostrBus({ relays: [url], dimId, label: 'probe', log: () => {}, warn: (m) => { const r = m.match(/rejected event: (.*)$/); if (r) rejects.push(r[1].slice(0, 50)); }, onEvent: () => rx.n++ });
  // wait for connect
  for (let i = 0; i < 40 && bus.stats().open === 0; i++) await new Promise(r => setTimeout(r, 200));
  if (bus.stats().open === 0) { bus.close(); return `${url.padEnd(32)} UNREACHABLE`; }
  // second bus on same relay to see if our events come back
  const bus2 = createNostrBus({ relays: [url], dimId, label: 'probe2', log: () => {}, warn: () => {}, onEvent: () => rx.n++ });
  for (let i = 0; i < 40 && bus2.stats().open === 0; i++) await new Promise(r => setTimeout(r, 200));
  for (let i = 0; i < burst; i++) { bus.publish('env', { i, pad: 'x'.repeat(600) }); await new Promise(r => setTimeout(r, 120)); }
  await new Promise(r => setTimeout(r, 2500));
  const s = bus.stats(); okCount = s.sent - s.dropped;
  bus.close(); bus2.close();
  return `${url.padEnd(32)} delivered ${String(rx.n).padStart(2)}/${burst}  rejected ${s.dropped}${rejects.length ? `  (${[...new Set(rejects)].join(' | ')})` : ''}`;
}));
console.log(results.join('\n'));
process.exit(0);
