#!/usr/bin/env node
// tools/resolve_merge.mjs
// Resolve merge conflicts for 7 data/*.json files by combining
// the OURS side (feature/godot-use: resources blocks) with
// the THEIRS side (godot-use/master: rules/logic/game fields).
//
// Strategy per entry:
//   - start from theirs (so its new logic/rule fields win on collisions)
//   - shallow-overlay ours's `resources` key only if ours has one and theirs doesn't
//   - versions: pick the one with the max created_at timestamp
//   - tags: union preserving theirs's order
// Reorder entries to match theirs; ours-only ids appended at the end.
// Top-level: keep theirs's `collection` and `notes`, unless ours's notes
// contains the substring "resources" (then keep ours).

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..');

const FILES = [
  'data/actions.json',
  'data/characters.json',
  'data/classes.json',
  'data/effects.json',
  'data/elements.json',
  'data/skills.json',
  'data/terrain_items.json',
];

const LOGIC_FIELDS = ['rules', 'rule', 'strike', 'strikes', 'golem', 'elemental',
                      'logic', 'logic_name', 'logicDesc', 'source_rule'];

function readStage(stage, file) {
  try {
    const buf = execSync(`git show :${stage}:${file}`, {
      cwd: REPO,
      maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`Failed to read :${stage}:${file} — ${e.message}`);
  }
}

function readHeadJson(file) {
  try {
    const buf = execSync(`git show HEAD:${file}`, {
      cwd: REPO,
      maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function indexById(obj) {
  const m = new Map();
  const entries = Array.isArray(obj.entries) ? obj.entries : [];
  for (const e of entries) {
    if (e && typeof e.id === 'string') m.set(e.id, e);
  }
  return m;
}

function pickVersions(oursV, theirsV) {
  // If only one side has versions, use it.
  if (!Array.isArray(oursV) && !Array.isArray(theirsV)) return undefined;
  if (!Array.isArray(oursV)) return theirsV;
  if (!Array.isArray(theirsV)) return oursV;

  // Both sides have arrays. Pick the array whose max created_at timestamp
  // is newer. (The task says "use the newer `versions` timestamp when they
  // diverge (max of the two)" — interpret as: keep the newer side's full
  // versions array; this preserves consistency within the block.)
  const maxTs = (arr) => {
    let best = '';
    for (const v of arr) {
      const t = v && typeof v.created_at === 'string' ? v.created_at : '';
      if (t > best) best = t;
    }
    return best;
  };
  const oM = maxTs(oursV);
  const tM = maxTs(theirsV);
  // Prefer theirs on tie (newer side).
  return tM >= oM ? theirsV : oursV;
}

function unionTags(oursTags, theirsTags) {
  const o = Array.isArray(oursTags) ? oursTags : [];
  const t = Array.isArray(theirsTags) ? theirsTags : [];
  const seen = new Set();
  const out = [];
  for (const x of t) if (!seen.has(x)) { seen.add(x); out.push(x); }
  for (const x of o) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

function mergeEntry(oursE, theirsE, file, unresolved) {
  // Start from theirs.
  const merged = { ...theirsE };

  // Resources: overlay ours's only when theirs doesn't have one.
  if (oursE && oursE.resources && !theirsE.resources) {
    merged.resources = oursE.resources;
  }
  // If both have resources, keep theirs (task says ours overlays only if
  // theirs lacks). But if ours has one and theirs has one too, we still
  // prefer theirs — explicit noop here, kept for clarity.

  // Versions
  const vMerged = pickVersions(oursE?.versions, theirsE?.versions);
  if (vMerged !== undefined) merged.versions = vMerged;
  else delete merged.versions;

  // Tags union
  if (oursE?.tags || theirsE?.tags) {
    merged.tags = unionTags(oursE?.tags, theirsE?.tags);
  }

  // Detect & log unresolved non-resources field conflicts (same key, different
  // scalar values). We stay conservative: only report true scalar divergence.
  if (oursE) {
    const skip = new Set(['resources', 'versions', 'tags', 'id']);
    for (const k of Object.keys(oursE)) {
      if (skip.has(k)) continue;
      if (!(k in theirsE)) continue;
      const a = oursE[k];
      const b = theirsE[k];
      const aScalar = (typeof a !== 'object' || a === null);
      const bScalar = (typeof b !== 'object' || b === null);
      if (aScalar && bScalar && a !== b) {
        unresolved.push(
          `[conflict unresolved] ${file} id=${theirsE.id} field=${k} ours=${JSON.stringify(a)} theirs=${JSON.stringify(b)}`
        );
      }
    }
  }

  return merged;
}

function hasLogicFields(entry) {
  for (const k of LOGIC_FIELDS) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, k)) return true;
  }
  // Also check inside versions[].data / versions[].logic.
  if (Array.isArray(entry?.versions)) {
    for (const v of entry.versions) {
      if (v && (v.logic || v.rules || v.rule)) return true;
      if (v && v.data) {
        for (const k of LOGIC_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(v.data, k)) return true;
        }
      }
    }
  }
  return false;
}

function hasResources(entry) {
  return !!(entry && entry.resources && typeof entry.resources === 'object');
}

const report = [];
const unresolvedAll = [];

for (const file of FILES) {
  const ours = readStage(2, file);
  const theirs = readStage(3, file);
  const headPre = readHeadJson(file); // ours's pre-merge snapshot

  const oursById = indexById(ours);
  const theirsById = indexById(theirs);

  // Reorder: theirs order first, append ours-only ids at the end.
  const seen = new Set();
  const orderedIds = [];
  for (const e of theirs.entries || []) {
    if (e && typeof e.id === 'string' && !seen.has(e.id)) {
      seen.add(e.id);
      orderedIds.push(e.id);
    }
  }
  for (const e of ours.entries || []) {
    if (e && typeof e.id === 'string' && !seen.has(e.id)) {
      seen.add(e.id);
      orderedIds.push(e.id);
    }
  }

  const unresolved = [];
  const mergedEntries = [];
  for (const id of orderedIds) {
    const o = oursById.get(id);
    const t = theirsById.get(id);
    if (o && t) {
      mergedEntries.push(mergeEntry(o, t, file, unresolved));
    } else if (t) {
      mergedEntries.push(t);
    } else if (o) {
      mergedEntries.push(o);
    }
  }

  // Top-level fields
  const merged = { collection: theirs.collection ?? ours.collection };
  merged.entries = mergedEntries;

  // notes handling
  const oursNotes = typeof ours.notes === 'string' ? ours.notes : undefined;
  const theirsNotes = typeof theirs.notes === 'string' ? theirs.notes : undefined;
  if (oursNotes !== undefined && oursNotes.includes('resources')) {
    merged.notes = oursNotes;
  } else if (theirsNotes !== undefined) {
    merged.notes = theirsNotes;
  } else if (oursNotes !== undefined) {
    merged.notes = oursNotes;
  }

  // Copy over any OTHER top-level keys (theirs first, then ours fill-ins).
  for (const k of Object.keys(theirs)) {
    if (k === 'collection' || k === 'entries' || k === 'notes') continue;
    merged[k] = theirs[k];
  }
  for (const k of Object.keys(ours)) {
    if (k in merged) continue;
    if (k === 'collection' || k === 'entries' || k === 'notes') continue;
    merged[k] = ours[k];
  }

  // Write file
  const abs = resolve(REPO, file);
  writeFileSync(abs, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  const entries_count = mergedEntries.length;
  const resources_coverage = mergedEntries.filter(hasResources).length;
  const has_logic_fields = mergedEntries.filter(hasLogicFields).length;

  // Compare resources coverage to ours's pre-merge state.
  let prevResources = null;
  if (headPre && Array.isArray(headPre.entries)) {
    prevResources = headPre.entries.filter(hasResources).length;
  }

  report.push({
    file,
    entries_count,
    resources_coverage,
    has_logic_fields,
    unresolved_count: unresolved.length,
    prev_resources_coverage: prevResources,
    regression: prevResources !== null && resources_coverage < prevResources,
  });
  unresolvedAll.push(...unresolved);
}

// JSON parse re-check (sanity)
const parseResults = [];
for (const file of FILES) {
  const abs = resolve(REPO, file);
  try {
    JSON.parse(readFileSync(abs, 'utf8'));
    parseResults.push({ file, ok: true });
  } catch (e) {
    parseResults.push({ file, ok: false, err: e.message });
  }
}

// git add
const addResults = [];
for (const file of FILES) {
  try {
    execSync(`git add -- ${file}`, { cwd: REPO });
    addResults.push({ file, ok: true });
  } catch (e) {
    addResults.push({ file, ok: false, err: e.message });
  }
}

// Report
console.log('=== RESOLVE MERGE REPORT ===');
for (const r of report) {
  console.log(
    `${r.file}: entries=${r.entries_count} resources=${r.resources_coverage}` +
    (r.prev_resources_coverage !== null ? ` (prev=${r.prev_resources_coverage})` : '') +
    ` logic=${r.has_logic_fields} unresolved=${r.unresolved_count}` +
    (r.regression ? '  !! RESOURCES REGRESSION !!' : '')
  );
}
console.log('--- unresolved conflicts ---');
if (unresolvedAll.length === 0) console.log('(none)');
else for (const line of unresolvedAll) console.log(line);
console.log('--- json parse ---');
for (const r of parseResults) console.log(`${r.file}: ${r.ok ? 'OK' : 'FAIL ' + r.err}`);
console.log('--- git add ---');
for (const r of addResults) console.log(`${r.file}: ${r.ok ? 'added' : 'FAIL ' + r.err}`);

const anyRegression = report.some(r => r.regression);
if (anyRegression) {
  console.error('\nREGRESSION DETECTED — resources_coverage shrank on at least one file.');
  process.exit(2);
}
