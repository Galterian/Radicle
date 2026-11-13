#!/usr/bin/env node
// Prune dimension artifacts whose last activity is older than N days (default 3).
// Dimension state lives in three roots, each with one directory per dim:
//   game/sessions/<DimName>/           (hashgraph.jsonl)
//   data/dimensions/dim-<slug>/        (map_autosave.tmj + .tmp)
//   game/logs/<slug>/                  (peer_*.log)
// "Activity" = mtime of the most recently-modified file inside the dir
// (recursive). Dry-run by default — pass --apply to actually delete.
//
// Usage:
//   node tools/clean-old-dimensions.mjs                  # dry run, 3-day threshold
//   node tools/clean-old-dimensions.mjs --days 7         # 7-day threshold
//   node tools/clean-old-dimensions.mjs --apply          # delete locally
//   node tools/clean-old-dimensions.mjs --apply --prune-radicle
//                                                        # also drop the
//                                                        # ActiveDimensions/<Name>
//                                                        # refs in LOCAL Radicle
//                                                        # storage so the next
//                                                        # push-to-oci.sh mirrors
//                                                        # the deletions to OCI
//                                                        # (that script already
//                                                        # runs rsync --delete)
//   node tools/clean-old-dimensions.mjs --keep ashfall-micro,oci-rulz1
//                                                       # protect specific dims
//   node tools/clean-old-dimensions.mjs --apply --purge-radicle-dims
//                                                       # the "wipe everything
//                                                       # the age sweep didn't
//                                                       # keep" mode: scans
//                                                       # EVERY namespace in
//                                                       # local Radicle storage
//                                                       # and deletes each
//                                                       # ActiveDimensions/<N>
//                                                       # ref whose dim isn't
//                                                       # in the live set. The
//                                                       # subsequent push-to-oci
//                                                       # --rsync-only mirrors
//                                                       # the mass deletion to
//                                                       # the OCI seeder.
//
// What "sync with other peers" actually means:
//   Radicle is signed per-namespace — you can only directly delete the refs
//   in YOUR namespace. Refs that other peers (e.g. the swarm-tester NID,
//   z6MkebNt…) wrote into their own namespaces are their own signed data;
//   if that peer re-connects to the seed and gossips, those refs come back.
//   What --purge-radicle-dims does: deletes those namespaces' local copies
//   from your Radicle storage, then rsync --delete propagates to OCI. If no
//   stale peer is still gossiping, the deletion sticks for everyone fetching
//   from OCI. If a stale peer re-syncs later, only its own namespace rows
//   reappear — never other peers'.
//
// OCI sync notes:
//   The three local artifact dirs (game/sessions, data/dimensions, game/logs)
//   are gitignored, so they never leave this machine. BUT every peer publishes
//   its door into a dim as a Radicle branch `ActiveDimensions/<DimName>`, and
//   those replicate across peers (including OCI) into
//   `refs/namespaces/<NID>/refs/heads/ActiveDimensions/<DimName>`.
//   --prune-radicle removes them from the dev-PC's own Radicle storage; the
//   existing `game/tools/oci/push-to-oci.sh --rsync-only` then does the OCI
//   side via its rsync --delete step (no new remote scripting here, we reuse
//   what you already have). Dim name = the CamelCase `game/sessions/<Dim>`
//   dir name (that's what peer.mjs publishes under).

import { readdirSync, statSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SELF = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SELF), '..')

const ROOTS = [
  { path: join(REPO, 'game', 'sessions'),   label: 'session' },
  { path: join(REPO, 'data', 'dimensions'), label: 'autosave' },
  { path: join(REPO, 'game', 'logs'),       label: 'logs'    },
]

function parseArgs(argv) {
  const o = {
    apply: false, days: 3, keep: new Set(),
    pruneRadicle: false, purgeRadicleDims: false,
    radHome: process.env.RAD_HOME || `${process.env.HOME || ''}/.radicle`,
    ridDir: process.env.RID_DIR || 'zqZmP6itceBMqYwi1K1n8phQqCaj',
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--days') o.days = Number(argv[++i])
    else if (a === '--prune-radicle') o.pruneRadicle = true
    else if (a === '--purge-radicle-dims') o.purgeRadicleDims = true
    else if (a === '--keep') {
      for (const k of String(argv[++i] || '').split(',')) {
        if (k) o.keep.add(k.trim().toLowerCase().replace(/^dim-/, ''))
      }
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: node tools/clean-old-dimensions.mjs [--apply] [--days N] [--keep slug1,slug2] [--prune-radicle] [--purge-radicle-dims]`)
      console.log(`  --days 0 sweeps everything regardless of age (combine with --keep to protect specific dims)`)
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(o.days) || o.days < 0) {
    console.error(`--days must be >= 0 (0 = sweep everything regardless of age)`)
    process.exit(2)
  }
  return o
}

// Walk a directory and return the max mtime (ms) of any file within. Returns
// the dir's own mtime for an empty dir so freshly-created shells still look
// "young" instead of being swept on the first run.
function lastActivity(dir) {
  let latest = 0
  try {
    latest = statSync(dir).mtimeMs
  } catch { return 0 }
  const walk = (p) => {
    let entries
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(p, e.name)
      try {
        const s = statSync(full)
        if (s.mtimeMs > latest) latest = s.mtimeMs
        if (e.isDirectory()) walk(full)
      } catch { /* ignore unreadable */ }
    }
  }
  walk(dir)
  return latest
}

function fmtAge(ms) {
  const d = ms / 86_400_000
  if (d < 1) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${d.toFixed(1)}d`
}

function fmtSize(dir) {
  let bytes = 0
  const walk = (p) => {
    let entries
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(p, e.name)
      try {
        const s = statSync(full)
        if (s.isFile()) bytes += s.size
        else if (e.isDirectory()) walk(full)
      } catch { /* ignore */ }
    }
  }
  walk(dir)
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${(bytes / 1024 / 1024).toFixed(1)}M`
}

const opts = parseArgs(process.argv)
const nowMs = Date.now()
const cutoffMs = nowMs - opts.days * 86_400_000

let totalScanned = 0
let totalFreedBytes = 0
let totalDeleted = 0
const kept = []
const removed = []

for (const { path: root, label } of ROOTS) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) }
  catch { continue /* missing root is fine */ }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    totalScanned++
    const full = join(root, e.name)
    const slug = e.name.toLowerCase().replace(/^dim-/, '')
    const activity = lastActivity(full)
    const ageMs = nowMs - activity
    const row = {
      label, path: full, name: e.name, slug,
      activity, ageMs, size: fmtSize(full),
    }
    if (opts.keep.has(slug)) {
      kept.push({ ...row, reason: 'protected (--keep)' })
      continue
    }
    if (activity > cutoffMs) {
      kept.push({ ...row, reason: `active (${fmtAge(ageMs)} old)` })
      continue
    }
    removed.push(row)
  }
}

// Report, oldest first for visual sanity.
removed.sort((a, b) => a.activity - b.activity)
kept.sort((a, b) => b.activity - a.activity)

console.log(`chaosD6 dimension sweep — threshold ${opts.days}d, mode ${opts.apply ? 'APPLY (will delete)' : 'DRY RUN'}`)
console.log(`scanned ${totalScanned} dim dirs across ${ROOTS.length} roots\n`)

if (removed.length === 0) {
  console.log(`nothing is older than ${opts.days}d — nothing to do.`)
} else {
  console.log(`${removed.length} dir(s) past the threshold:`)
  for (const r of removed) {
    console.log(`  [${r.label.padEnd(8)}] ${r.name.padEnd(28)} age ${fmtAge(r.ageMs).padStart(6)}  size ${r.size.padStart(6)}  ${r.path}`)
  }
}

if (opts.apply && removed.length > 0) {
  console.log(`\ndeleting…`)
  for (const r of removed) {
    try {
      // Final guard: never nuke anything outside our known roots.
      const okRoot = ROOTS.some(root => r.path.startsWith(root.path + '/') || r.path.startsWith(root.path + '\\'))
      if (!okRoot) {
        console.log(`  SKIP (outside known roots) ${r.path}`)
        continue
      }
      // Size tally before rm — accurate for the summary line.
      const bytes = (() => {
        let b = 0
        const walk = (p) => {
          try {
            for (const e of readdirSync(p, { withFileTypes: true })) {
              const f = join(p, e.name)
              try {
                const s = statSync(f)
                if (s.isFile()) b += s.size
                else if (e.isDirectory()) walk(f)
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
        walk(r.path)
        return b
      })()
      rmSync(r.path, { recursive: true, force: true })
      totalFreedBytes += bytes
      totalDeleted++
      console.log(`  rm -rf ${r.path}`)
    } catch (err) {
      console.error(`  FAILED ${r.path}: ${err.message}`)
    }
  }
  const mb = (totalFreedBytes / 1024 / 1024).toFixed(1)
  console.log(`\ndeleted ${totalDeleted} dir(s) · freed ${mb} MB`)
} else if (!opts.apply && removed.length > 0) {
  console.log(`\n(dry run — pass --apply to actually delete)`)
}

if (kept.length > 0) {
  console.log(`\n${kept.length} kept:`)
  for (const r of kept) {
    console.log(`  [${r.label.padEnd(8)}] ${r.name.padEnd(28)} ${r.reason}`)
  }
}

// ---------------------------------------------------------------------------
// --prune-radicle: delete the matching `ActiveDimensions/<DimName>` refs in
// LOCAL Radicle storage (~/.radicle/storage/<RID>/). We never touch OCI — the
// user's existing `game/tools/oci/push-to-oci.sh --rsync-only` already runs
// rsync with --delete, so the next push mirrors the deletions over there.
//
// Dim name comes from `game/sessions/<DimName>/` only — the autosave and logs
// roots have slugified names that don't match the published branch casing.
// Operations are purely local (git-cli on a path under $HOME), no SSH.
// ---------------------------------------------------------------------------
if (opts.pruneRadicle && removed.length > 0) {
  const dimNames = [...new Set(removed.filter(r => r.label === 'session').map(r => r.name))]
  if (dimNames.length === 0) {
    console.log(`\n(--prune-radicle: no session dirs in the removal set, nothing to prune)`)
  } else {
    const store = `${opts.radHome}/storage/${opts.ridDir}`
    console.log(`\n=== Radicle ref prune (local only) ===`)
    console.log(`  storage: ${store}`)
    // Early-exit with a useful hint when the storage dir isn't where we
    // guessed. Common case: running from Windows node, where $HOME is
    // C:\Users\<user> but the real storage lives under WSL.
    try { statSync(store) } catch {
      console.log(`  ! that path doesn't exist. Override with the RAD_HOME env var, e.g.`)
      console.log(`      RAD_HOME=/home/galt/.radicle node tools/clean-old-dimensions.mjs --apply --prune-radicle`)
      console.log(`    or run the script from inside WSL so $HOME resolves to the Linux home.`)
      process.exit(3)
    }
    let totalRefs = 0
    const refsToDelete = []
    for (const name of dimNames) {
      // for-each-ref prints the full ref path for every match across every
      // namespace. We collect across all names first so the dry-run report is
      // honest about scope before any ref is actually touched.
      const r = spawnSync('git', [
        '-C', store, 'for-each-ref', '--format=%(refname)',
        `refs/namespaces/*/refs/heads/ActiveDimensions/${name}`,
      ], { encoding: 'utf8' })
      if (r.status !== 0) {
        console.log(`  ! git for-each-ref failed for ${name}: ${(r.stderr || '').trim()}`)
        continue
      }
      const refs = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
      for (const ref of refs) refsToDelete.push({ dim: name, ref })
      totalRefs += refs.length
      if (refs.length === 0) {
        console.log(`  [${name}] (no refs found — maybe published only on another peer)`)
      } else {
        console.log(`  [${name}] ${refs.length} ref(s)`)
      }
    }
    if (!opts.apply) {
      console.log(`  (dry run — rerun with --apply --prune-radicle to delete)`)
    } else if (totalRefs === 0) {
      console.log(`  nothing to prune.`)
    } else {
      let deleted = 0
      for (const { ref } of refsToDelete) {
        const r = spawnSync('git', ['-C', store, 'update-ref', '-d', ref], { encoding: 'utf8' })
        if (r.status === 0) deleted++
        else console.log(`  ! update-ref -d ${ref} failed: ${(r.stderr || '').trim()}`)
      }
      console.log(`  pruned ${deleted}/${totalRefs} local Radicle ref(s)`)
      console.log(`\n  next step — propagate to OCI (reuses push-to-oci.sh):`)
      console.log(`    bash game/tools/oci/push-to-oci.sh --rsync-only`)
      console.log(`  (its rsync --delete step mirrors the ref removals; its`)
      console.log(`   post-rsync fsck + repack cleans up any dangling objects)`)
    }
  }
} else if (opts.pruneRadicle) {
  console.log(`\n(--prune-radicle: nothing was removed, so nothing to prune)`)
}

// ---------------------------------------------------------------------------
// --purge-radicle-dims: nuclear wipe of EVERY `ActiveDimensions/<Name>` ref
// across ALL namespaces in local Radicle storage, regardless of whether the
// age sweep touched a matching session dir. Use this to reset the dims corpus
// before the chaosD6-Dimensions repo split so neither dev-PC nor OCI carries
// stale branches into the new RID. --keep still protects named dims (handy if
// you want to retain one in-progress session). Local-only; propagation to OCI
// goes through the usual push-to-oci.sh --rsync-only call afterwards.
// ---------------------------------------------------------------------------
if (opts.purgeRadicleDims) {
  const store = `${opts.radHome}/storage/${opts.ridDir}`
  console.log(`\n=== Radicle dims purge (all namespaces, local only) ===`)
  console.log(`  storage: ${store}`)
  try { statSync(store) } catch {
    console.log(`  ! that path doesn't exist. Override with RAD_HOME, e.g.`)
    console.log(`      RAD_HOME=/home/galt/.radicle node tools/clean-old-dimensions.mjs --apply --purge-radicle-dims`)
    process.exit(3)
  }
  const r = spawnSync('git', [
    '-C', store, 'for-each-ref', '--format=%(refname)',
    'refs/namespaces/*/refs/heads/ActiveDimensions/*',
  ], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.log(`  ! for-each-ref failed: ${(r.stderr || '').trim()}`)
  } else {
    const allRefs = String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
    const byName = new Map()
    const victims = []
    for (const ref of allRefs) {
      const m = ref.match(/\/ActiveDimensions\/(.+)$/)
      if (!m) continue
      const name = m[1]
      if (opts.keep.has(name.toLowerCase())) continue
      victims.push(ref)
      byName.set(name, (byName.get(name) || 0) + 1)
    }
    console.log(`  ${allRefs.length} total ActiveDimensions refs across namespaces`)
    console.log(`  ${allRefs.length - victims.length} kept (--keep)   ·   ${victims.length} queued for delete across ${byName.size} dims`)
    const preview = [...byName.entries()].slice(0, 20)
    for (const [name, n] of preview) console.log(`    - ${name.padEnd(28)} ${n} ref(s)`)
    if (byName.size > preview.length) console.log(`    … (+${byName.size - preview.length} more dims)`)
    if (!opts.apply) {
      console.log(`  (dry run — rerun with --apply --purge-radicle-dims to delete)`)
    } else if (victims.length === 0) {
      console.log(`  nothing to purge.`)
    } else {
      let deleted = 0
      for (const ref of victims) {
        const d = spawnSync('git', ['-C', store, 'update-ref', '-d', ref])
        if (d.status === 0) deleted++
      }
      console.log(`  purged ${deleted}/${victims.length} refs across all namespaces`)
      console.log(`\n  next step — mirror the wipe to OCI:`)
      console.log(`    bash game/tools/oci/push-to-oci.sh --rsync-only`)
    }
  }
}
