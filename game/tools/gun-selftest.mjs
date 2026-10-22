// Dev helper: does a put on relay A become readable through relay B with the
// exact Gun options peer.mjs uses? usage: node tools/gun-selftest.mjs
import http from 'node:http';
import Gun from 'gun';
const MODE = process.argv[2] || 'mem';
const mk = (port, peers) => {
  const web = http.createServer((q, s) => { s.writeHead(200); s.end('gun'); });
  web.listen(port, '127.0.0.1');
  if (MODE === 'radisk') return Gun({ web, peers, file: `/tmp/gun-selftest-${port}`, localStorage: false, axe: false, multicast: false });
  if (MODE === 'noaxe') return Gun({ web, peers, radisk: false, localStorage: false, multicast: false });
  if (MODE === 'plain') return Gun({ web, peers });
  return Gun({ web, peers, radisk: false, localStorage: false, axe: false, multicast: false });
};
const A = mk(7901, []);
const B = mk(7902, ['http://127.0.0.1:7901/gun']);
A.get('t').get('blocks').get('disc:1,2,10').put({ id: 'disc:1,2,10', kind: 'disc', q: 1, r: 2, radius: 10, by: 'peer:x', at: 'now' });
A.get('t').get('blocks').get('rect').put({ id: 'rect', kind: 'rect', q: 0, r: 0, w: 5, h: 5, by: 'genesis', at: null });
setTimeout(() => {
  B.get('t').get('blocks').map().on((b, k) => console.log('B sees', k, JSON.stringify({ ...b, _: undefined })));
  B.get('t').get('blocks').get('disc:1,2,10').once(b => console.log('B once', JSON.stringify({ ...b, _: undefined })));
}, 1500);
setTimeout(() => {
  // Late writer: C comes up after A/B and reads what they hold.
  const C = mk(7903, ['http://127.0.0.1:7901/gun', 'http://127.0.0.1:7902/gun']);
  C.get('t').get('blocks').map().on((b, k) => console.log('C sees', k, JSON.stringify({ ...b, _: undefined })));
}, 4000);
setTimeout(() => process.exit(0), 9000);
