// Dev helper (run in WSL): expose the WSL game ports under +10000 so a Windows
// browser can reach them. On this box the Windows side already holds
// 127.0.0.1:7357 and 7401-7404 (another checkout's peers), and WSL2 only
// forwards localhost ports that no Windows process owns — so the UI must be
// opened as http://localhost:17357 (or a UI_PORT of its own) with ?peer=174xx.
//
//   node tools/wsl-proxy.mjs            # 17357→7357, 17401..17440→7401..7440
import net from 'node:net';

const pairs = [[17357, 7357]];
for (let n = 1; n <= 40; n++) pairs.push([17400 + n, 7400 + n]);

for (const [from, to] of pairs) {
  net.createServer(client => {
    const up = net.connect(to, '127.0.0.1');
    client.pipe(up).pipe(client);
    const drop = () => { client.destroy(); up.destroy(); };
    up.on('error', drop);      // ECONNREFUSED when that peer isn't running — just hang up
    client.on('error', drop);
  }).on('error', e => console.error(`proxy ${from}: ${e.code || e.message}`))
    .listen(from, '127.0.0.1');
}
console.log(`proxying ${pairs.map(([f, t]) => `${f}→${t}`).join(' ')}`);
