// Dev helper: read a dimension's map blocks (and member keys) straight from a
// peer's Gun relay. usage: node tools/gun-probe.mjs http://IP:7501/gun dim-ashfall-micro [seconds]
import Gun from 'gun';
const [url, dimId, secs = '6'] = process.argv.slice(2);
if (!url || !dimId) { console.error('usage: node tools/gun-probe.mjs <gun-url> <dim-id> [seconds]'); process.exit(2); }
const gun = Gun({ peers: [url], radisk: false, localStorage: false, axe: false, multicast: false });
const root = gun.get('chaosd6').get('dimensions').get(dimId);
const seen = new Map();
root.get('map').get('blocks').map().on((b, k) => { seen.set(k, b); console.log(`block ${k}:`, JSON.stringify({ ...b, _: undefined })); });
root.get('doors').get('door-primary').get('members').map().on((m, k) => console.log(`member ${k}: tile (${m?.tile_q},${m?.tile_r}) last_seen ${m?.last_seen}`));
setTimeout(() => { console.log(`done: ${seen.size} blocks`); process.exit(0); }, Number(secs) * 1000);
