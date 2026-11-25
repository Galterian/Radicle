// /rules/api/gen/* — the editor's "Generate from a description…" flow (editor/gen.js; 2026-11-23).
// Mounted by editor-api.mjs#handleEditorRequest AFTER its guard() (Host check; POST needs X-Editor-Token, same origin).
// Every state change is POST + readJsonBody (JSON only, size cap) + requireLogin (team owner); GET only reads.
//   GET  drafts                → { busy, model, drafts: [summary] }
//   GET  drafts/<draft_id>     → { draft }   (def, state, status line, test result, suggestions, log)
//   GET  vocab?kind=effect|skill|class → { groups: [{ id, label, values }] }   the tag chips (gen-tags.mjs)
//   GET  resources             → { sprites: [{path, name, in_pack, grid}], sounds, units: [{race, unit, sounds}] }   game/gen-resources.json
//   GET  gm                    → { available, edit: [{kind, id, name, race, role}], looks: {npc: [...], building: [...], monster: [...]}, races, villages }
//                                  the GameModels kinds (npc, building, monster; gm-gen.mjs): what to start from, whose art to borrow
//   POST create   { kind, idea, tags[], resources: {sprite, sound} | {unit: "<race>/<unit>"} (a class) | {npc|building: id}
//                   (a GameModels look; monster: {monster: id}), base?: an NPC / building / monster id to change (GameModels kinds) }  → { draft }   starts the generation
//   POST retry    { draft_id, extra, suggestions[], tags?, resources? } → { draft }   regenerates from the preview + the changes
//   POST media    { draft_id, resources }                → { draft }   the picture / sound only (not priced, no regeneration)
//   POST test     { draft_id }                       → { draft }   starts the private background test game
//   POST publish  { draft_id, message }                → { draft, ref, publish, granted }  only in "testing success"
//                  (an npc / building / monster: the bundle on players/<team>/<id> of chaosD6-GameModels, then the vote)
//   POST delete   { draft_id }
//   GET  proposals             → { available, proposals: [{ kind, id, name, team, branch, commit, sha256, author, signature_ok, bundle, votes, mine, own }] }
//   POST proposals/refresh     → rad sync <GameModels rid> --fetch --seed <OCI>   (the OCI seed only)
//   POST proposals/try   { branch, commit }            → { draft }   another team's proposal as a draft (test it; not publishable)
//   POST proposals/vote  { branch, commit, value, comment } → { key, mine, publish }   −6..+6, a comment on a minus vote; not the author
//   POST key      { url: https://<host>/llm-big, key }  → the phone's OCI model + test service (llm.json, mode 600)
// On the phone (CHAOSD6_MOBILE=1) generation calls the OCI 8B and the test runs on OCI's gen-test service
// (tools/gen-test-server.mjs); publish goes through the radicle bridge (editor-publish.mjs publishVia 'bridge').
// publish = the editor's own path (validateDefinition + editor-publish.mjs publishDefinition: players/<team>/<slug>
// branch of chaosD6-Effects, signed, voting as for any player branch), then the card goes into the archive of every
// character of the team (new: true → the game shows "New effect type is added"), like a card won by a kill.
import fs from 'node:fs';
import path from 'node:path';
import { createGenJobs, GEN_KINDS } from './gen-jobs.mjs';
import { genConfig } from './effect-gen.mjs';
import { publishDefinition, publishGameModels } from './editor-publish.mjs';
import { loadProfile, addArchivedCard, addCustomClass } from './profile.mjs';
import { vocab } from './gen-tags.mjs';
import { GM_KINDS, catalogForEdit, checkBundle, bundleDefs, models as gmModels } from './gm-gen.mjs';
import { GAMEMODELS_DIR, KINDS as GM_DEF_KINDS, defHash } from './gamemodels.mjs';
import { fileURLToPath } from 'node:url';
import { listGmProposals, refreshGmProposals } from './gm-proposals.mjs';
import { whoAmI, recordVote, schedulePublish, VoteError, VALUE_MIN as VOTE_MIN, VALUE_MAX as VOTE_MAX, COMMENT_MAX } from './proposal-votes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const jobsByDir = new Map();
/** Tests: the jobs object (a fake model / runner) for the profile file's dir. */
export function useGenJobs(profileFile, jobs) { jobsByDir.set(path.dirname(profileFile), jobs); }
export function jobsFor(ctx) {
  const dir = path.dirname(ctx.profileFile);
  if (!jobsByDir.has(dir)) jobsByDir.set(dir, createGenJobs({ dir: path.join(dir, 'gen-drafts'), draftsDir: path.join(dir, 'effect-drafts'), llmFile: path.join(dir, 'llm.json'), log: (t) => console.log(`[gen] ${t}`) }));
  return jobsByDir.get(dir);
}

/** The reference a peer needs to fetch + verify the published def (effects-handshake makeFxRef / skills-handshake makeSkRef). */
async function refOf(kind, def, ref, verdict) {
  const o = { repo: ref.repo || '', branch: ref.branch || '', commit: ref.commit || '', verdict };
  if (kind === 'skill') { const hs = await import('./skills-handshake.mjs'); return hs.makeSkRef(def, hs.bundledSkillSet().libs, o); }
  if (kind === 'class') { const hs = await import('./classes-handshake.mjs'); return hs.makeClRef(def, hs.bundledClassSet().libs, o); }
  const hs = await import('./effects-handshake.mjs');
  return hs.makeFxRef(def, hs.bundledEffectSet().libs, o);
}

let catalogue = null;
function resourceCatalogue() {
  if (catalogue) return catalogue;
  try { const c = JSON.parse(fs.readFileSync(path.join(HERE, 'gen-resources.json'), 'utf8')); catalogue = { source: c.source, generated_at: c.generated_at, sprites: c.sprites || [], sounds: c.sounds || [], units: c.units || [] }; }
  catch { catalogue = { source: null, sprites: [], sounds: [], units: [] }; }
  return catalogue;
}

export async function handleGenApi(req, res, url, sub, ctx, { readJsonBody, requireLogin, validateDefinition, fail, sendJson }) {
  const jobs = jobsFor(ctx);
  // { sprite, sound } → only paths of the catalogue (null = none picked); a class: { unit: "<race>/<unit>" } → that
  // unit's whole voice set from the catalogue (user 2026-11-23)
  const pickOf = (r, kind = 'effect') => {
    if (!r || typeof r !== 'object') return null;
    if (GM_KINDS.includes(kind)) {   // a look-alike: an NPC / building of the GameModels repo whose art the draft borrows
      const k = kind, id = r[k] ? String(r[k]) : '';
      if (!id) return null;
      if (!gmModels()[k]?.[id]) fail(400, `no ${k} ${id} in chaosD6-GameModels`);
      return { [k]: id };
    }
    const c = resourceCatalogue();
    if (kind === 'class') {
      if (!r.unit) return null;
      const u = c.units.find(x => `${x.race}/${x.unit}` === String(r.unit));
      if (!u) fail(400, 'that unit is not in the chaosD6-Resources catalogue');
      return { unit: { race: u.race, unit: u.unit, sounds: u.sounds.slice(0, 16).map(s => ({ path: s.path, kind: s.kind, line: s.line, in_pack: s.in_pack })) } };
    }
    const sprite = r.sprite ? String(r.sprite) : null, sound = r.sound ? String(r.sound) : null;
    if (sprite && !c.sprites.some(s => s.path === sprite)) fail(400, 'that picture is not in the chaosD6-Resources catalogue');
    if (sound && !c.sounds.some(s => s.path === sound)) fail(400, 'that sound is not in the chaosD6-Resources catalogue');
    return sprite || sound ? { sprite, sound } : null;
  };
  const call = (fn) => { try { return fn(); } catch (e) { if (e.status) fail(e.status, e.message); throw e; } };
  const draftOf = (b) => { const d = jobs.get(b.draft_id); if (!d) fail(404, 'no such draft'); return d; };
  const route = `${req.method} ${sub}`;
  const m = /^GET drafts\/(gen_[a-z0-9]{6,20})$/.exec(route);
  if (m) { const d = jobs.get(m[1]); if (!d) fail(404, 'no such draft'); return sendJson(res, 200, { ok: true, busy: jobs.busy(), draft: d }); }
  switch (route) {
    case 'GET drafts': {
      try { await jobs.adoptFiles?.(); } catch (e) { console.warn(`[gen] adopting CLI drafts: ${e.message}`); }
      const cfg = genConfig(process.env, { file: path.join(path.dirname(ctx.profileFile), 'llm.json') });
      let host = '';
      try { host = cfg.url ? new URL(cfg.url).host : ''; } catch {}
      let fallback = '';   // the desktop: its own 8B first, this OCI host when that is not reachable
      try { fallback = cfg.fallback?.url ? new URL(cfg.fallback.url).host : ''; } catch {}
      const rt = jobs.remoteTest?.() || null;
      let testHost = '';
      try { testHost = rt?.url ? new URL(rt.url).host : ''; } catch {}
      return sendJson(res, 200, { ok: true, kinds: GEN_KINDS, busy: jobs.busy(),
        model: { configured: !!cfg.url, host, ...(fallback ? { fallback } : {}), name: cfg.model, key_set: !!(cfg.key || cfg.fallback?.key), device: !!cfg.signer && !cfg.key, mobile: process.env.CHAOSD6_MOBILE === '1' },
        test: rt ? { where: 'oci', host: testHost } : { where: 'local' }, drafts: jobs.list() });
    }
    case 'POST key': {
      // The phone's OCI model URL + key (the desktop: tools/effect-gen.mjs --save-key). Never sent back.
      requireLogin(ctx);
      const b = await readJsonBody(req);
      const url = String(b.url || '').trim().replace(/\/+$/, '');
      const key = String(b.key || '').trim();
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/llm-big$/i.test(url)) fail(400, 'url must be https://<host>/llm-big');
      if (key.length < 16 || key.length > 200 || /\s/.test(key)) fail(400, 'that does not look like the key');
      const file = path.join(path.dirname(ctx.profileFile), 'llm.json');
      let f = {};
      try { f = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
      if (!f.remote_key || f.remote_key === f.big_key) f.remote_key = key;
      f.big_key = key; f.big_url = url;
      f.remote_url ||= url.replace(/\/llm-big$/, '/llm');
      f.test_url = url.replace(/\/llm-big$/, '/gen-test');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return sendJson(res, 200, { ok: true, model: { configured: true, host: new URL(url).host, key_set: true } });
    }
    case 'GET vocab': {   // the tag chips of the form (gen-tags.mjs; read-only)
      const kind = String(url.searchParams.get('kind') || 'effect');
      if (!GEN_KINDS.includes(kind)) fail(400, `kind must be ${GEN_KINDS.join('|')}`);
      return sendJson(res, 200, { ok: true, ...vocab(kind) });
    }
    case 'GET resources':   // the picker's lists: game/gen-resources.json (staged from chaosD6-Resources' manifest; no network)
      return sendJson(res, 200, { ok: true, ...resourceCatalogue() });
    case 'POST create': {
      requireLogin(ctx);
      const b = await readJsonBody(req);
      const kind = String(b.kind || 'effect');
      return sendJson(res, 200, { ok: true, draft: call(() => jobs.create({ kind, idea: typeof b.idea === 'string' ? b.idea : '', tags: Array.isArray(b.tags) ? b.tags : [], resources: pickOf(b.resources, kind),
        base: GM_KINDS.includes(kind) && typeof b.base === 'string' && /^(npc|bld|mon)_[a-z0-9_]+$/.test(b.base) ? b.base : null })) });
    }
    case 'GET gm': {   // read-only: the GameModels checkout on this node (the phone: the copy staged in its bundle)
      if (!GAMEMODELS_DIR) return sendJson(res, 200, { ok: true, available: false, edit: [], looks: { npc: [], building: [], monster: [] }, races: [], villages: [] });
      const m = gmModels();
      const sprite = (p) => (p?.path || p || null);
      return sendJson(res, 200, { ok: true, available: true, edit: catalogForEdit({ m }),
        looks: {
          npc: Object.values(m.npc).map(n => ({ id: n.id, name: n.name, race: n.race, role: n.role, info: sprite(n.card?.resources?.sprites?.info), idle: sprite(n.card?.resources?.sprites?.idle), wbc3: n.card?.resources?.wbc3_name || '' })),
          building: Object.values(m.building).map(x => ({ id: x.id, name: x.name, race: x.race, role: x.role, base: sprite(x.card?.resources?.sprites?.base), info: sprite(x.card?.resources?.sprites?.info) })),
          monster: Object.values(m.monster).filter(x => x.card?.resources?.sprites).map(x => ({ id: x.id, name: x.name, race: x.race, role: (x.card.tags || []).join(', '), info: sprite(x.card.resources.sprites.info), idle: sprite(x.card.resources.sprites.idle), wbc3: x.card.resources.wbc3_name || '' })),
        },
        races: Object.values(m.race).map(r => ({ id: r.id, name: r.name, temper: r.temper || '' })),
        villages: Object.entries(m.village).map(([id, v]) => ({ id, race: v.race, size: v.size || 'village', walled: !!v.wall })) });
    }
    // ---- other teams' GameModels proposals (gm-proposals.mjs): list (local Radicle storage), fetch from the OCI seed,
    // try one in the private test game (imported as a draft), vote on it (proposal-votes.mjs, signed, published to the seed)
    case 'GET proposals': {
      let me = null;
      try { const s = requireLogin(ctx); me = whoAmI({ profileFile: ctx.profileFile, team: s.team?.name || '' }); } catch { me = whoAmI({ profileFile: ctx.profileFile }); }
      const l = await listGmProposals({ profileFile: ctx.profileFile, me });
      return sendJson(res, 200, { ok: true, ...l, proposals: l.proposals.map(({ ref, ...p }) => p), limits: { min: VOTE_MIN, max: VOTE_MAX, comment_max: COMMENT_MAX } });
    }
    case 'POST proposals/refresh': {
      requireLogin(ctx);
      await readJsonBody(req);
      const r = await refreshGmProposals();   // desktop: rad sync; the phone: its node's bridge POST /fetch
      return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, ...(r.ok ? { out: r.out } : { error: `fetch from the OCI seed failed: ${r.error}` }) });
    }
    case 'POST proposals/try':
    case 'POST proposals/vote': {
      const s = requireLogin(ctx);
      const b = await readJsonBody(req);
      const p = (await listGmProposals({ profileFile: ctx.profileFile })).proposals.find(x => x.branch === String(b.branch || '') && x.commit === String(b.commit || ''));
      if (!p) fail(404, 'no such proposal in the local storage (refresh first)');
      if (route === 'POST proposals/try') return sendJson(res, 200, { ok: true, draft: call(() => jobs.importProposal({ kind: p.kind, bundle: p.bundle, proposal: p })) });
      const value = Number(b.value);
      if (!Number.isInteger(value) || value < VOTE_MIN || value > VOTE_MAX) fail(400, `a vote is an integer ${VOTE_MIN}..${VOTE_MAX}`);
      let r;
      try { r = recordVote({ ref: p.ref, value, comment: typeof b.comment === 'string' ? b.comment : '', profileFile: ctx.profileFile, team: s.team?.name || '' }); }
      catch (e) { if (e instanceof VoteError) fail(400, e.message); throw e; }
      const publish = r.vote.sig ? schedulePublish({ profileFile: ctx.profileFile }) : 'local';
      return sendJson(res, 200, { ok: true, key: r.vote.key, mine: { value: r.vote.value, comment: r.vote.comment }, publish });
    }
    case 'POST retry': {
      requireLogin(ctx);
      const b = await readJsonBody(req);
      draftOf(b);
      return sendJson(res, 200, { ok: true, draft: call(() => jobs.retry(b.draft_id, { extra: typeof b.extra === 'string' ? b.extra : '', suggestions: Array.isArray(b.suggestions) ? b.suggestions : [],
        tags: Array.isArray(b.tags) ? b.tags : undefined, resources: b.resources === undefined ? undefined : pickOf(b.resources, jobs.get(b.draft_id).kind) })) });
    }
    case 'POST media': {   // { draft_id, resources: {sprite, sound} | null } — the picture / sound only, no regeneration
      requireLogin(ctx);
      const b = await readJsonBody(req);
      draftOf(b);
      return sendJson(res, 200, { ok: true, draft: call(() => jobs.setResources(b.draft_id, pickOf(b.resources, jobs.get(b.draft_id).kind))) });
    }
    case 'POST test': {
      requireLogin(ctx);
      const b = await readJsonBody(req);
      draftOf(b);
      return sendJson(res, 200, { ok: true, draft: call(() => jobs.test(b.draft_id)) });
    }
    case 'POST delete': {
      requireLogin(ctx);
      const b = await readJsonBody(req);
      draftOf(b);
      return sendJson(res, 200, call(() => jobs.remove(b.draft_id)));
    }
    case 'POST publish': {
      const s = requireLogin(ctx);
      const b = await readJsonBody(req);
      draftOf(b);
      const d = call(() => jobs.beginPublish(b.draft_id));
      const kind = d.kind;
      if (GM_KINDS.includes(kind)) {
        // a GameModels bundle: checked again against the repo as it is now (main may have moved since the test), then one
        // commit on players/<team>/<id> of chaosD6-GameModels (editor-publish.mjs publishGameModels); no archive grant —
        // an NPC / building / monster is not a card; it enters the game when the vote merges it into main
        let r;
        try {
          const c = checkBundle(d.def);
          if (!c.ok) { jobs.endPublish(d.draft_id, { ok: false, error: c.problems.slice(0, 3).join('; ') }); return sendJson(res, 400, { ok: false, error: 'the draft no longer passes the GameModels check', errors: c.problems }); }
          const defs = bundleDefs(d.def).map(([k, def]) => [GM_DEF_KINDS[k][0], def, defHash(def)]);
          r = await publishGameModels({ bundle: { id: d.def.id, name: d.def.name, version: d.def.version, kind }, defs, identity: s.identity, team: s.team,
            message: (typeof b.message === 'string' && b.message.trim() ? b.message : `${kind}: ${d.def.name}`).slice(0, 200) }, ctx.publish || {});
        } catch (e) { jobs.endPublish(d.draft_id, { ok: false, error: e.message }); throw e; }
        const done = jobs.endPublish(d.draft_id, { ok: true, info: { ...(r.ref || {}), state: r.publish?.state || null, error: r.publish?.error || null, granted: 0 } });
        return sendJson(res, 200, { ok: true, draft: done, ref: r.ref, publish: r.publish, granted: [] });
      }
      let v, r;
      try {
        v = await validateDefinition(kind, d.def, ctx);
        if (!v.ok) { jobs.endPublish(d.draft_id, { ok: false, error: v.errors.slice(0, 3).join('; ') }); return sendJson(res, 400, { ok: false, error: 'the definition does not validate', errors: v.errors, verdict: v.verdict }); }
        r = await publishDefinition({ kind, def: d.def, identity: s.identity, team: s.team, message: (typeof b.message === 'string' && b.message.trim() ? b.message : `custom ${kind}: ${d.def.name}`).slice(0, 200) }, ctx.publish || {});
      } catch (e) { jobs.endPublish(d.draft_id, { ok: false, error: e.message }); throw e; }
      // Every character of the team gets the card in its archive (not a kill: kill false).
      const granted = [];
      let clRef = null;   // a class: the handshake ref a character needs to hold it (profile class_ref)
      try {
        const ref = await refOf(kind, d.def, r.ref || {}, v.verdict);
        if (kind === 'class') { clRef = ref; addCustomClass(ctx.profileFile, d.def, ref); }   // a NEW character of the team may take it (user 2026-11-23)
        // a class is not a card (profile cards are skills + effects): no archive grant — profile.custom_classes instead
        if (kind !== 'class') for (const c of loadProfile(ctx.profileFile).characters || []) {
          const x = addArchivedCard(ctx.profileFile, c.id, { kind, id: d.def.id, ref }, s.team.name, { kill: false, custom: true });
          if (x) granted.push({ character: c.id, name: c.name, uid: x.uid });
        }
      } catch (e) { console.warn(`[gen] archive grant failed: ${e.message}`); }
      const done = jobs.endPublish(d.draft_id, { ok: true, info: { ...(r.ref || {}), state: r.publish?.state || null, error: r.publish?.error || null, granted: granted.length, ...(clRef ? { class_ref: clRef } : {}) } });
      return sendJson(res, 200, { ok: true, draft: done, ref: r.ref, publish: r.publish, verdict: v.verdict, granted });
    }
    default: fail(404, `no gen API ${route}`);
  }
}
