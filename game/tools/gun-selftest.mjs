// Dev helper: does a put on relay A become readable through relay B with the
// exact Gun options peer.mjs uses? usage: node tools/gun-selftest.mjs
import http from 'node:http';
import Gun from 'gun';
const MODE = process.argv[2] || 'mem';
const mk = (port, peers) => {
  const web = http.createServer((q, s) => { s.writeHead(200); s.end('gun'); });
  web.listen(port, '127.0.0.1');
  if (MODE === 'radisk') return Gun({ web, peers, file: `/tmp/gun-selftest-${port}`, localStorage: false, axe: false, multicast: false });
  if (MODE === 'nofaith') return Gun({ web, peers, file: `/tmp/gun-selftest-${port}`, localStorage: false, axe: false, multicast: false, faith: false });
  if (MODE === 'noaxe') return Gun({ web, peers, radisk: false, localStorage: false, multicast: false });
  if (MODE === 'plain') return Gun({ web, peers });
  return Gun({ web, peers, radisk: false, localStorage: false, axe: false, multicast: false });
};
process.on('uncaughtException', e => { console.log('CRASH', String(e.message).split('\n')[0], String(e.stack).split('\n')[1]?.trim()); process.exit(1); });
const A = mk(7901, []);
const B = mk(7902, ['http://127.0.0.1:7901/gun']);
A.get('t').get('blocks').get('disc:1,2,10').put({ id: 'disc:1,2,10', kind: 'disc', q: 1, r: 2, radius: 10, by: 'peer:x', at: 'now' });
A.get('t').get('blocks').get('rect').put({ id: 'rect', kind: 'rect', q: 0, r: 0, w: 5, h: 5, by: 'genesis', at: null });
A.get('t').get('members').get('peer:x').put({ peer_id: 'peer:x', multiaddrs_csv: '/ip4/1.2.3.4/tcp/7410/p2p/12D3KooWabc,/ip4/5.6.7.8/tcp/7411/p2p/12D3KooWdef', nostr_relays_csv: 'wss://a,wss://b', last_seen: new Date().toISOString() });
setTimeout(() => {
  B.get('t').get('blocks').map().on((b, k) => console.log('B sees', k, JSON.stringify({ ...b, _: undefined })));
  B.get('t').get('blocks').get('disc:1,2,10').once(b => console.log('B once', JSON.stringify({ ...b, _: undefined })));
  B.get('t').get('members').map().on((m, k) => console.log('B member', k, m?.multiaddrs_csv));
}, 1500);
setTimeout(() => {
  // Late writer: C comes up after A/B and reads what they hold.
  const C = mk(7903, ['http://127.0.0.1:7901/gun', 'http://127.0.0.1:7902/gun']);
  C.get('t').get('blocks').map().on((b, k) => console.log('C sees', k, JSON.stringify({ ...b, _: undefined })));
}, 4000);
setTimeout(() => process.exit(0), 9000);
