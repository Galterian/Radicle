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
    apply: false, days: 3, keep: new Set(), ociSync: false,
    ociHost: process.env.OCI_HOST || '92-5-138-121.sslip.io',
    ridDir: process.env.RID_DIR || 'zqZmP6itceBMqYwi1K1n8phQqCaj',
    sshKey: process.env.SSH_KEY || `${process.env.HOME || ''}/.ssh/id_rsa`,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--days') o.days = Number(argv[++i])
    else if (a === '--oci-sync') o.ociSync = true
    else if (a === '--keep') {
      for (const k of String(argv[++i] || '').split(',')) {
        if (k) o.keep.add(k.trim().toLowerCase().replace(/^dim-/, ''))
      }
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: node tools/clean-old-dimensions.mjs [--apply] [--days N] [--keep slug1,slug2] [--oci-sync]`)
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(o.days) || o.days <= 0) {
    console.error(`--days must be a positive number`)
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
