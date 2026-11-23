// Generation drafts + their background jobs (2026-11-23, the editor's "Generate from a description…" flow).
// A draft = <profile dir>/gen-drafts/<draft_id>.json — never in the repo:
//   { draft_id, kind, idea, extras[], state, fails, def, verdict, problems[], check, test, suggestions[], status,
//     status_at, log[], published, created_at, updated_at }
// state: generating → preview (a def; verdict says if the validator rates it ok) | no draft (the model gave nothing usable)
//        → testing → "testing failed <n>" | "testing success" → publishing → published.  A retry goes back to generating.
// One job at a time per node (the 8B serves one request at a time; a test game is ~4 min of CPU). The job writes its
// status line every 10 s in the CLI's "[gen] …" / "[test] …" format; the editor polls GET /rules/api/gen/drafts/<id>.
// Generation runs in this process (effect-gen.mjs); a test runs tools/effect-gen-test.mjs as a child process.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { genConfig, generateEffect, saveDraft, formatStatus, checkDraft, validatorReport } from './effect-gen.mjs';
import { generateSkill } from './skill-gen.mjs';
import { tagsPrompt, tagProblems, cleanTags } from './gen-tags.mjs';
import { profileDir } from './profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GEN_KINDS = ['effect', 'skill'];   // classes follow (user order: effects → phone → skills → classes)
const generateOf = (o) => (o.kind === 'skill' ? generateSkill(o) : generateEffect(o));

// The resource picks { sprite, sound } (paths of game/gen-resources.json, checked by gen-api) → the def: an effect's
// card.resources, a skill's resources (/1, skill-engine validateResources). Same shape as the built-ins' card.resources.
export function applyResources(kind, def, pick) {
  if (!def || !pick || (!pick.sprite && !pick.sound)) return def;
  const r = { ...(pick.sprite ? { sprites: { effect: { path: pick.sprite, usage: 'effect animation strip (cols = frames; grid in assets/frames.json), play once at the target hex' } } } : {}),
    ...(pick.sound ? { sounds: { fx: [{ path: pick.sound, usage: 'play when it resolves' }] } } : {}) };
  if (kind === 'skill') def.resources = r;
  else if (def.card) def.card.resources = { source: 'warlords3_battlecry', match_reason: 'picked by the player', ...r };
  return def;
}
export const DRAFT_ID_RE = /^gen_[a-z0-9]{6,20}$/;
export const STATUS_EVERY_MS = 10_000;
export const isFailed = (s) => /^testing failed \d+$/.test(String(s || ''));
const nowIso = () => new Date().toISOString();

// generate({ kind, idea, cfg, prior, changes, onProgress, log }) → generateDef's result (tests pass a fake one).
// The def files: effects in <profile dir>/effect-drafts (shared with the CLI), skills in <profile dir>/skill-drafts.
export function createGenJobs({ dir = path.join(profileDir(), 'gen-drafts'), draftsDir = path.join(profileDir(), 'effect-drafts'),
  skillDraftsDir = path.join(path.dirname(draftsDir), 'skill-drafts'),
  llmFile = path.join(profileDir(), 'llm.json'), env = process.env, generate = generateOf, spawnImpl = spawn, statsImpl = null, fetchImpl = (...a) => globalThis.fetch(...a),
  everyMs = STATUS_EVERY_MS, testMinutes = Number(env.GEN_TEST_MINUTES) || 3, log = () => {} } = {}) {
  let current = null;   // { draft_id, what: 'generate' | 'test', child? }
  const defsDir = (kind) => (kind === 'skill' ? skillDraftsDir : draftsDir);
  const file = (id) => path.join(dir, `${id}.json`);
  const read = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
  const write = (d) => { fs.mkdirSync(dir, { recursive: true }); d.updated_at = nowIso(); const t = `${file(d.draft_id)}.tmp`; fs.writeFileSync(t, JSON.stringify(d, null, 2) + '\n'); fs.renameSync(t, file(d.draft_id)); return d; };
  const note = (d, line) => { d.log = [...(d.log || []), `${nowIso().slice(11, 19)} ${line}`].slice(-200); };
  // the test game + the big model's review of it, into the conversation (the next retry answers it)
  const talkTest = (x) => {
    const t = x.test || {};
    const head = `${t.pass ? 'PASS' : 'FAIL'} · ${x.kind === 'skill' ? 'plays' : 'casts'} ${t.casts ?? 0}, lands ${t.lands ?? 0} · errors ${t.errors ?? 0} · divergences ${t.divergences ?? 0}${t.why?.length ? ` — ${t.why.join('; ')}` : ''}`;
    const rv = t.review ? (t.review.error ? `review: ${t.review.error}` : [`review: ${t.review.summary || ''}`, ...(t.review.suggestions || []).map(s => `  → ${s}`)].join('\n')) : '';
    x.talk = [...(x.talk || []), { role: 'test', at: nowIso(), text: [head, rv].filter(Boolean).join('\n').slice(0, 3000) }].slice(-120);
  };
  const setState = (d, state, why = '') => { d.state = state; note(d, `state: ${state}${why ? ` — ${why}` : ''}`); };

  // A node restart mid-job: the job is gone, the draft goes back to what it was.
  const resumable = [];
  try {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const d = read(f.slice(0, -5));
      if (!d || !['generating', 'testing', 'publishing'].includes(d.state)) continue;
      if (d.state === 'testing' && d.remote_test) { resumable.push(d.draft_id); continue; }   // the OCI game went on: poll it again (below)
      setState(d, d.state === 'publishing' ? 'testing success' : d.def ? 'preview' : 'no draft', 'interrupted (the node restarted)');
      d.status = ''; write(d);
    }
  } catch {}

  const summary = (d) => ({ draft_id: d.draft_id, kind: d.kind, idea: d.idea, state: d.state, fails: d.fails | 0, name: d.def?.name || '',
    id: d.def?.id || '', verdict: d.verdict || null, status: d.status || '', updated_at: d.updated_at, published: d.published || null });
  const busy = () => (current ? { draft_id: current.draft_id, what: current.what } : null);
  const refuseBusy = () => { if (current) throw Object.assign(new Error(`busy: ${current.what === 'test' ? 'a test game' : 'a generation'} is running (${current.draft_id}) — one at a time`), { status: 409 }); };

  function statsFor(cfg) {
    if (statsImpl) return statsImpl(cfg);
    const f = (() => { try { return JSON.parse(fs.readFileSync(llmFile, 'utf8')); } catch { return {}; } })();
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.url);
    const ssh = String(env.GEN_STATS_SSH || f.stats_ssh || '');
    if (!local && !ssh) return null;
    return import('./tools/machine-stats.mjs').then(m => ({ s: m.startStats({ ssh: local ? '' : ssh, sshKey: env.SSH_KEY || path.join(env.HOME || '', '.ssh', 'id_rsa'), everyMs: Math.min(everyMs, 5000) }), where: local ? 'local' : ssh.replace(/^.*@/, '') })).catch(() => null);
  }

  // ---- generation (create / retry) ----
  async function runGenerate(d, { prior = null, changes = '' } = {}) {
    const cfg = genConfig(env, { file: llmFile });
    const t0 = Date.now();
    let prog = null;
    const st = await statsFor(cfg);
    const tick = () => {
      const x = read(d.draft_id) || d;
      x.status = prog ? formatStatus(prog, { elapsedMs: Date.now() - t0, sample: st?.s.latest() || null, statsError: st?.s.error() || '', where: st?.where || 'server' })
        : `[gen] ${Math.floor((Date.now() - t0) / 60000)}:${String(Math.floor((Date.now() - t0) / 1000) % 60).padStart(2, '0')} waiting for the server`;
      x.status_at = nowIso(); write(x);
    };
    const timer = setInterval(tick, everyMs);
    let r;
    try {
      const kind = d.kind || 'effect';
      r = await generate({ kind, idea: [d.idea, ...(d.extras || []), tagsPrompt(kind, d.tags)].filter(Boolean).join('\n'), cfg, prior, changes,
        tagCheck: d.tags?.length ? (def) => tagProblems(kind, def, d.tags) : null,
        onProgress: (p) => { prog = p; }, log: (t) => { const x = read(d.draft_id) || d; note(x, `[gen] ${t}`); write(x); } });
    } catch (e) { r = { ok: false, error: e.message, tries: [] }; }
    finally { clearInterval(timer); st?.s.stop(); }
    const x = read(d.draft_id) || d;
    x.status = '';
    // The conversation (the player's words, each answer, the validator's report on it) — one round per create / retry.
    if (r.talk?.length) x.talk = [...(x.talk || []), { role: 'round', text: prior ? `retry ${(x.talk || []).filter(t => t.role === 'round').length}` : 'create', at: nowIso() }, ...r.talk].slice(-120);
    if (r.def) {
      applyResources(x.kind, r.def, x.resources);   // the player's picture / sound (not priced: the verdict stands)
      x.def = r.def; x.verdict = r.verdict; x.problems = r.problems || [];
      x.tag_problems = r.tag_problems || [];
      for (const p of x.tag_problems) note(x, `[tags] ${p}`);
      x.check = r.check?.power ? { ratio: r.check.judged_ratio ?? null, band: r.check.band || null } : null;
      x.report = validatorReport(r.check);   // the rebalance script's output on the def shown
      for (const l of x.report) note(x, `[rebalance] ${l}`);
      const old = x.file;
      x.file = saveDraft(r.def, defsDir(x.kind));
      // A retry whose model answer took another id: drop this draft's old file (else GET drafts would adopt it as a new draft).
      if (old && old !== x.file && path.dirname(old) === defsDir(x.kind)) { try { fs.rmSync(old, { force: true }); } catch {} }
      x.tries = (x.tries | 0) + (r.tries?.length || 0);
      setState(x, 'preview', `${r.verdict}${r.problems?.length ? `: ${r.problems.slice(0, 2).join('; ')}` : ''} in ${Math.round((Date.now() - t0) / 1000)} s`);
    } else {
      setState(x, prior ? 'preview' : 'no draft', r.error || 'the model gave no usable definition');   // a failed retry keeps the old def
    }
    write(x);
    return x;
  }

  function start(d, what, fn) {
    current = { draft_id: d.draft_id, what };
    Promise.resolve().then(fn).catch((e) => {
      const x = read(d.draft_id) || d; note(x, `error: ${e.message}`); x.status = '';
      if (['generating', 'testing'].includes(x.state)) setState(x, x.def ? 'preview' : 'no draft', e.message);
      write(x); log(`gen ${d.draft_id}: ${e.message}`);
    }).finally(() => { if (current?.draft_id === d.draft_id) current = null; });
  }

  // ---- test ----
  function runTest(d) {
    return new Promise((resolve) => {
      const out = path.join(dir, `${d.draft_id}.test.json`);
      try { fs.rmSync(out, { force: true }); } catch {}
      const child = spawnImpl(process.execPath, [path.join(HERE, 'tools', 'effect-gen-test.mjs'), d.file, '--minutes', String(testMinutes), '--every', String(Math.round(everyMs / 1000)), '--out', out, '--review'],
        { cwd: HERE, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      if (current) current.child = child;
      let buf = '';
      const onLine = (l) => {
        if (!l.startsWith('[test] ') || l.startsWith('[test] RESULT ')) return;
        const x = read(d.draft_id) || d; x.status = l; x.status_at = nowIso();
        if (/ (PASS|FAIL) · |review: |starting a private/.test(l)) note(x, l);
        write(x);
      };
      const feed = (c) => { buf += c; let k; while ((k = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, k)); buf = buf.slice(k + 1); } };
      child.stdout?.setEncoding('utf8'); child.stdout?.on('data', feed);
      child.stderr?.setEncoding('utf8'); child.stderr?.on('data', feed);
      child.on('exit', (code) => {
        let res = null;
        try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
        const x = read(d.draft_id) || d;
        x.status = '';
        x.test = res ? { pass: !!res.pass, why: res.why || [], casts: res.casts, lands: res.lands, errors: res.errors, divergences: res.divergences,
          lines: (res.lines || []).slice(0, 40), error_lines: res.errorLines || [], review: res.review || null, at: res.at, ms: res.ms, dimension: res.dimension }
          : { pass: false, why: [`the test runner exited with code ${code} and no result`] };
        x.suggestions = res?.review?.suggestions || [];
        talkTest(x);
        if (x.test.pass) setState(x, 'testing success', `cast ${res.casts}×, landed ${res.lands}×`);
        else { x.fails = (x.fails | 0) + 1; setState(x, `testing failed ${x.fails}`, x.test.why.join('; ')); }
        write(x);
        resolve(x);
      });
    });
  }

  // Drafts the CLI made (tools/effect-gen.mjs → <profile dir>/effect-drafts/<id>.json) become editor drafts in "preview",
  // judged again by the validator (an older CLI draft gets the custom mark it lacked). Called by GET drafts.
  // Idempotent (8a): one run at a time (concurrent GETs share it); a file whose id OR path belongs to a draft is skipped;
  // it only ever creates new records — never rewrites an existing draft, never starts a job or a publish.
  let adopting = null;
  function adoptFiles() {
    adopting ||= adoptOnce().finally(() => { adopting = null; });
    return adopting;
  }
  async function adoptOnce() {
    let files = [];
    try { files = fs.readdirSync(draftsDir).filter(f => /^effect_[a-z0-9_]+\.json$/.test(f)); } catch { return 0; }
    const known = new Set();
    try { for (const f of fs.readdirSync(dir).filter(f => /^gen_[a-z0-9]+\.json$/.test(f))) { const d = read(f.slice(0, -5)); if (d?.def?.id) known.add(d.def.id); if (d?.file) known.add(path.basename(d.file, '.json')); } } catch {}
    let n = 0;
    for (const f of files) {
      const id = f.slice(0, -5);
      if (known.has(id)) continue;
      let def;
      try { def = JSON.parse(fs.readFileSync(path.join(draftsDir, f), 'utf8')); } catch { continue; }
      if (def?.id !== id) continue;
      def.source = { collection: 'generated', ...(def.source || {}), custom: true };
      let res = { verdict: null, problems: [] };
      try { res = await checkDraft(def); } catch (e) { res = { verdict: 'reject', problems: [e.message] }; }
      const at = (() => { try { return fs.statSync(path.join(draftsDir, f)).mtime.toISOString(); } catch { return nowIso(); } })();
      const d = { draft_id: `gen_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, kind: 'effect', idea: String(def.source.idea || def.name || id).slice(0, 1000),
        extras: [], state: 'preview', fails: 0, def, verdict: res.verdict, problems: res.problems || [],
        check: res.check?.power ? { ratio: res.check.judged_ratio ?? null, band: res.check.band || null } : null,
        suggestions: [], status: '', log: [], created_at: at, file: saveDraft(def, draftsDir), imported: true };
      note(d, `state: preview — taken over from the command-line draft ${f} (validator: ${res.verdict})`);
      write(d); known.add(id); n++;
    }
    return n;
  }

  // ---- test on the OCI gen-test service (the phone: CHAOSD6_MOBILE=1, or GEN_TEST_REMOTE=1 / llm.json test_remote) ----
  // llm.json { test_url (default: big_url with /llm-big → /gen-test), big_key }. The same result shape as a local run.
  function remoteTest() {
    const f = (() => { try { return JSON.parse(fs.readFileSync(llmFile, 'utf8')); } catch { return {}; } })();
    const on = env.CHAOSD6_MOBILE === '1' || env.GEN_TEST_REMOTE === '1' || f.test_remote === true;
    if (!on) return null;
    const big = String(env.LLM_BIG_URL || f.big_url || '');
    const url = String(env.GEN_TEST_URL || f.test_url || (/\/llm-big\/?$/.test(big) ? big.replace(/\/llm-big\/?$/, '/gen-test') : '')).replace(/\/+$/, '');
    return { url, key: String(env.LLM_BIG_KEY || f.big_key || '') };
  }
  const finishRemote = (d, res) => {
    const x = read(d.draft_id) || d;
    x.status = ''; delete x.remote_test;
    x.test = { pass: !!res.pass, why: res.why || [], casts: res.casts, lands: res.lands, errors: res.errors, divergences: res.divergences,
      lines: (res.lines || []).slice(0, 40), error_lines: res.errorLines || [], review: res.review || null, at: res.at, ms: res.ms ?? null, where: 'oci' };
    x.suggestions = res.review?.suggestions || [];
    talkTest(x);
    if (x.test.pass) setState(x, 'testing success', `on OCI: cast ${res.casts}×, landed ${res.lands}×`);
    else { x.fails = (x.fails | 0) + 1; setState(x, `testing failed ${x.fails}`, x.test.why.join('; ')); }
    return write(x);
  };
  const badRemote = (d, why) => { const x = read(d.draft_id) || d; x.status = ''; delete x.remote_test; setState(x, 'preview', `the OCI test did not run: ${why}`); return write(x); };
  async function runTestRemote(d, rt) {
    const hdr = { 'Content-Type': 'application/json', ...(rt.key ? { Authorization: `Bearer ${rt.key}` } : {}) };
    const finish = (res) => finishRemote(d, res), bad = (why) => badRemote(d, why);
    if (!rt.url) return bad('no test service configured (set the model key first)');
    let r;
    try { r = await fetchImpl(`${rt.url}/tests`, { method: 'POST', headers: hdr, body: JSON.stringify({ def: d.def }) }); }
    catch (e) { return bad(e?.cause?.code || e.message); }
    const j = await r.json().catch(() => ({}));
    if (r.status !== 202 || !j.id) return bad(j.error ? `${r.status} ${j.error}${j.problems?.length ? `: ${j.problems.slice(0, 2).join('; ')}` : ''}` : `http ${r.status}`);
    { const x = read(d.draft_id) || d; x.remote_test = j.id; note(x, `[test] on OCI as ${j.id}`); write(x); }
    return pollRemote(d, rt, j.id, finish, bad);
  }
  // Also after a node restart (the phone's menu process): the OCI game went on, the draft keeps its remote_test id.
  async function pollRemote(d, rt, tid, finish, bad) {
    const hdr = rt.key ? { Authorization: `Bearer ${rt.key}` } : {};
    for (let misses = 0; ;) {
      await new Promise(res => setTimeout(res, everyMs));
      let s = null;
      try { const q = await fetchImpl(`${rt.url}/tests/${tid}`, { headers: hdr }); s = q.ok ? await q.json() : null; if (q.status === 404) return bad('the OCI test was lost (its server restarted)'); } catch {}
      if (!s) { if (++misses > 30) return bad('OCI stopped answering'); continue; }
      misses = 0;
      if (s.state === 'done') return finish(s.result || {});
      const x = read(d.draft_id) || d;
      x.status = `${s.status || '[test] running'} · on OCI`; x.status_at = nowIso(); write(x);
    }
  }

  for (const id of resumable.slice(0, 1)) {   // one job at a time; any other one goes back to preview
    const d = read(id), rt = remoteTest();
    if (!rt?.url) { badRemote(d, 'the node restarted and no test service is configured'); continue; }
    note(d, `[test] resumed polling ${d.remote_test} after a node restart`); write(d);
    start(d, 'test', () => pollRemote(d, rt, d.remote_test, (res) => finishRemote(d, res), (why) => badRemote(d, why)));
  }
  for (const id of resumable.slice(1)) badRemote(read(id), 'interrupted (the node restarted)');

  return {
    dir, busy, adoptFiles, remoteTest,
    list: () => { try { return fs.readdirSync(dir).filter(f => /^gen_[a-z0-9]+\.json$/.test(f)).map(f => read(f.slice(0, -5))).filter(Boolean).map(summary).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))); } catch { return []; } },
    get: (id) => (DRAFT_ID_RE.test(String(id)) ? read(id) : null),
    // tags: ["group:value"] (gen-tags.mjs — checked on the draft); resources: { sprite, sound } paths (gen-api checks them)
    create({ kind = 'effect', idea, tags = [], resources = null }) {
      if (!GEN_KINDS.includes(kind)) throw Object.assign(new Error(`generation of ${kind}s is not built yet (${GEN_KINDS.join(', ')} are)`), { status: 400 });
      const text = String(idea || '').trim();
      const picked = cleanTags(kind, tags);
      if (text.length < 8 && !(picked.length && text.length >= 3)) throw Object.assign(new Error('describe it in a sentence or two'), { status: 400 });
      refuseBusy();
      const d = { draft_id: `gen_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, kind, idea: text.slice(0, 1000), tags: picked, resources: resources || null, extras: [], state: 'generating', fails: 0,
        def: null, verdict: null, problems: [], suggestions: [], status: '[gen] 0:00 starting', status_at: nowIso(), log: [], created_at: nowIso() };
      note(d, 'state: generating'); write(d);
      start(d, 'generate', () => runGenerate(d));
      return d;
    },
    retry(id, { extra = '', suggestions = [], tags = undefined, resources = undefined } = {}) {
      const d = read(id);
      if (!d) throw Object.assign(new Error('no such draft'), { status: 404 });
      if (!['preview', 'no draft', 'testing success'].includes(d.state) && !isFailed(d.state)) throw Object.assign(new Error(`cannot retry while ${d.state}`), { status: 409 });
      refuseBusy();
      const add = String(extra || '').trim().slice(0, 1000);
      const picked = (Array.isArray(suggestions) ? suggestions : []).map(s => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, 5);
      const changes = [add, ...picked.map(s => `- ${s}`), ...(d.test && !d.test.pass ? [`The test game found: ${d.test.why.join('; ')}`] : [])].filter(Boolean).join('\n');
      if (add) d.extras = [...(d.extras || []), add].slice(-6);
      if (tags !== undefined) d.tags = cleanTags(d.kind, tags);   // the tag chips may change on a retry
      if (resources !== undefined) d.resources = resources || null;
      setState(d, 'generating', changes ? changes.split('\n')[0].slice(0, 120) : 'again');
      d.status = '[gen] 0:00 starting'; d.status_at = nowIso(); write(d);
      start(d, 'generate', () => runGenerate(d, { prior: d.def, changes }));
      return d;
    },
    test(id) {
      const d = read(id);
      if (!d) throw Object.assign(new Error('no such draft'), { status: 404 });
      if (!d.def || !d.file) throw Object.assign(new Error('no preview to test yet'), { status: 409 });
      if (d.verdict !== 'ok') throw Object.assign(new Error(`the validator rates it "${d.verdict}" — retry first (peers would refuse it)`), { status: 409 });
      if (d.tag_problems?.length) throw Object.assign(new Error(`it does not match the tags you picked — retry first: ${d.tag_problems.join('; ')}`), { status: 409 });
      if (!(d.state === 'preview' || isFailed(d.state) || d.state === 'testing success')) throw Object.assign(new Error(`cannot test while ${d.state}`), { status: 409 });
      refuseBusy();
      saveDraft(d.def, defsDir(d.kind));   // the file the runner reads = the def shown
      const rt = remoteTest();
      setState(d, 'testing', rt ? 'on OCI' : ''); d.status = `[test] 0:00 starting${rt ? ' · on OCI' : ''}`; d.status_at = nowIso(); write(d);
      start(d, 'test', () => (rt ? runTestRemote(d, rt) : runTest(d)));
      return d;
    },
    /** publish step bookkeeping (gen-api.mjs does the validate + publishDefinition). */
    beginPublish(id) {
      const d = read(id);
      if (!d) throw Object.assign(new Error('no such draft'), { status: 404 });
      if (d.state !== 'testing success') throw Object.assign(new Error(`publish needs "testing success" (now: ${d.state})`), { status: 409 });
      refuseBusy();
      setState(d, 'publishing'); write(d);
      return d;
    },
    endPublish(id, { ok, info = null, error = '' }) {
      const d = read(id);
      if (!d) return null;
      if (ok) { d.published = { ...info, at: nowIso() }; setState(d, 'published', info?.branch || ''); }
      else setState(d, 'testing success', `publish failed: ${error}`);
      return write(d);
    },
    remove(id) {
      const d = read(id);
      if (!d) throw Object.assign(new Error('no such draft'), { status: 404 });
      if (current?.draft_id === id) throw Object.assign(new Error('a job is running on it'), { status: 409 });
      fs.rmSync(file(id), { force: true }); fs.rmSync(path.join(dir, `${id}.test.json`), { force: true });
      if (d.file && path.dirname(d.file) === defsDir(d.kind)) fs.rmSync(d.file, { force: true });   // else GET drafts would take it over again
      return { ok: true };
    },
    stop() { try { current?.child?.kill('SIGTERM'); } catch {} },
  };
}
