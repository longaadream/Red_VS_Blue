#!/usr/bin/env node
// Explicitly re-freeze the same content inventory from an approved Git baseline.
// Never read implementation outputs as expected behavior.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const sha = args.find(arg => arg.startsWith('--base-sha='))?.slice('--base-sha='.length)
if (!sha || !/^[a-f0-9]{40}$/.test(sha) || args.some(arg => arg !== '--write' && arg !== `--base-sha=${sha}`)) {
  throw new Error('Usage: node scripts/refresh-semantic-baseline.mjs --base-sha=<approved full SHA> [--write]')
}
const git = (...arguments_) => execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
if (git('rev-parse', `${sha}^{commit}`).trim() !== sha) throw new Error('Baseline is not an exact commit')
git('merge-base', '--is-ancestor', sha, 'origin/main')
const file = resolve(root, 'tests/game/fixtures/RED-252-legacy-content.json')
const previous = JSON.parse(readFileSync(file, 'utf8'))
const entries = {}
const changed = []
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keys = Object.keys(previous.entries)
for (const key of keys) {
  if (!/^(pieces|skills|rules|cards)\/[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error(`Invalid baseline key: ${key}`)
}
const objects = execFileSync('git', ['cat-file', '--batch'], {
  cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  input: keys.map(key => `${sha}:data/${key}.json\n`).join(''),
})
let offset = 0
for (const [key, old] of Object.entries(previous.entries)) {
  const end = objects.indexOf(10, offset)
  const header = objects.subarray(offset, end).toString('utf8')
  const match = /^[a-f0-9]{40} blob (\d+)$/.exec(header)
  if (end < 0 || !match) throw new Error(`Missing baseline blob ${key}: ${header}`)
  const size = Number(match[1]), start = end + 1
  if (objects[start + size] !== 10) throw new Error(`Invalid baseline blob length: ${key}`)
  const current = JSON.parse(objects.subarray(start, start + size).toString('utf8'))
  offset = start + size + 1
  entries[key] = current
  if (JSON.stringify(old) !== JSON.stringify(current)) changed.push({ key, beforeSha256: hash(old), afterSha256: hash(current) })
}
const report = { previousBaseSha: previous.baseSha, baseSha: sha, entries: Object.keys(entries).length, changed, mode: args.includes('--write') ? 'written' : 'dry-run' }
if (args.includes('--write')) writeFileSync(file, JSON.stringify({ ...previous, baseSha: sha, entries }, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
