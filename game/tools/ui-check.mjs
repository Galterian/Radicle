// Puppeteer audit of the browser UI against live peers. Runs on the WINDOWS
// side (that's where Chrome + the npx-cached puppeteer live); the WSL peers are
// reached through tools/wsl-proxy.mjs (174xx → 74xx).
//
//   node tools/ui-check.mjs <uiBase> <peerPort...>
//   node tools/ui-check.mjs http://localhost:7358 17401 17402
//
// Per peer: load ?peer=<port>, wait for the hand, audit roster/slots/log,
// exercise the skill slots, screenshot to tools/out/ui-<port>.png.
// Exit code 1 when any page produced console errors / uncaught exceptions.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUPPETEER_DIR = process.env.PUPPETEER_DIR || 'C:\\Users\\grozdevg\\AppData\\Local\\npm-cache\\_npx\\ab5cd9f6d13a2312\\node_modules\\puppeteer';
const puppeteer = createRequire(import.meta.url)(PUPPETEER_DIR);

const [uiBase = 'http://localhost:7358', ...portArgs] = process.argv.slice(2);
const ports = portArgs.length ? portArgs : ['17401'];
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1400, height: 900 }, args: ['--window-size=1400,900'] });
let totalErrors = 0, totalMissingStats = 0, totalSkillSlots = 0;

for (const port of ports) {
  const page = await browser.newPage();
  const errors = [];
  // 404s surface as a generic "Failed to load resource" console error; the
  // response hook names the URL instead (and a missing favicon isn't a bug).
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`http ${r.status()}: ${r.url()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  const url = `${uiBase}/?peer=${port}`;
  console.log(`\n=== peer ${port} — ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(4000);

    const audit = () => page.evaluate(() => {
      const txt = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
      const roster = [...document.querySelectorAll('#roster .ros')].map(r => {
        const pills = [...r.querySelectorAll('.stats .pill:not(.perm)')].map(p => txt(p));
        return { name: txt(r.querySelector('.nm')), st: txt(r.querySelector('.st')), pills, missing: pills.length < 4 || pills.some(p => p.includes('—')) };
      });
      const slots = [...document.querySelectorAll('#slots .slot')].map(s => ({ slot: s.dataset.slot, cls: s.className.replace('slot', '').trim(), code: s.dataset.code || '', text: txt(s), title: s.title || '' }));
      const canvas = document.getElementById('stage');
      return {
        phase: txt(document.getElementById('phase')),
        turn: txt(document.getElementById('turn')),
        mainVisible: !document.querySelector('main').hidden,
        canvasOk: !!canvas && canvas.width > 0 && canvas.height > 0,
        roster, slots,
        log: [...document.querySelectorAll('#log li')].slice(0, 5).map(txt),
      };
    });

    let a = await audit();
    // Wait a little longer for the hand if the hello hasn't landed yet.
    for (let i = 0; i < 6 && !a.slots.some(s => s.text && !s.text.includes('—') && s.slot !== 'EMPTY'); i++) { await sleep(1000); a = await audit(); }

    console.log(`phase: ${a.phase} · ${a.turn} · main visible: ${a.mainVisible} · canvas ok: ${a.canvasOk}`);
    for (const r of a.roster) console.log(`  roster: ${r.name} | ${r.st} | ${r.pills.join(' ')}${r.missing ? '  <-- MISSING STATS' : ''}`);
    for (const s of a.slots) console.log(`  slot ${s.slot}: [${s.cls}] ${s.code} ${s.text}`);
    for (const l of a.log) console.log(`  log: ${l}`);
    totalMissingStats += a.roster.filter(r => r.missing).length;
    const skillSlots = a.slots.filter(s => s.cls.includes('skill'));
    totalSkillSlots += skillSlots.length;

    // ---- interactive: skills, a disabled skill, hotkeys ----
    const slotCls = () => page.evaluate(() => [...document.querySelectorAll('#slots .slot')].map(s => `${s.dataset.slot}:${s.className.replace('slot', '').trim() || '-'}`).join('  '));
    const logTop = () => page.evaluate(() => [...document.querySelectorAll('#log li')].slice(0, 6).map(l => (l.innerText || '').trim()));
    // The hand changes every ~6 s round, so re-read each slot right before clicking it.
    const liveSkills = () => page.evaluate(() => [...document.querySelectorAll('#slots .slot.skill')].map(s => ({ slot: s.dataset.slot, cls: s.className, text: s.innerText.replace(/\n/g, ' ') })));
    for (const s of (await liveSkills()).filter(s => !s.cls.includes('disabled'))) {
      await page.click(`#slots .slot[data-slot="${s.slot}"]`);
      await sleep(300);
      console.log(`  click enabled skill ${s.slot} (${s.text}) → ${await slotCls()}`);
    }
    const disabled = (await liveSkills()).find(s => s.cls.includes('disabled'));
    if (disabled) {
      // Count "needs … card in hand" lines anywhere in the log — in a 10-peer
      // game the handshake rows push new lines down within a second.
      const needsCount = () => page.evaluate(() => [...document.querySelectorAll('#log li')].filter(l => /needs .* card in hand/i.test(l.innerText)).length);
      const before = await needsCount();
      await page.click(`#slots .slot[data-slot="${disabled.slot}"]`);
      await sleep(300);
      const ok = (await needsCount()) > before;
      console.log(`  click disabled skill ${disabled.slot} (${disabled.text}) → ${ok ? 'logged "needs …" OK' : '<-- expected a "needs …" line'}`);
      if (!ok) errors.push('disabled skill click did not log a "needs" line');
    }
    await page.keyboard.press('8'); await sleep(200);
    console.log(`  key 8 → ${await slotCls()}`);
    await page.keyboard.press('1'); await sleep(200);
    console.log(`  key 1 → ${await slotCls()}`);

    const shot = path.join(outDir, `ui-${port}.png`);
    await page.screenshot({ path: shot });
    console.log(`  screenshot: ${shot}`);
  } catch (e) {
    errors.push(`script: ${e.message}`);
  }
  if (errors.length) { console.log(`  ERRORS (${errors.length}):`); for (const e of errors.slice(0, 10)) console.log(`    ${e}`); }
  totalErrors += errors.length;
  await page.close();
}

await browser.close();
console.log(`\nUI-RESULT: ${totalErrors} console errors, ${totalMissingStats} roster rows with missing stats, ${totalSkillSlots} skill slots seen`);
process.exit(totalErrors ? 1 : 0);
