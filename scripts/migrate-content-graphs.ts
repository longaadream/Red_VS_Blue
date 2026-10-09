import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importContentGraph } from '../electron-editor/content-graph-import'
import { applyContentGraph, assertContentGraphArtifact, type ContentGraphSurface } from '../electron-editor/content-graph-document'

// Explicit IDs only. A failed preflight writes nothing; this is never a fallback-to-script importer.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const write = args.includes('--write')
const refresh = args.includes('--refresh')
const fieldOption = args.find(argument => argument.startsWith('--field='))?.slice('--field='.length)
if (fieldOption !== undefined && fieldOption !== 'previewCode') throw new Error('Only --field=previewCode is supported as a secondary entry')
const ids = args.filter(argument => argument !== '--write' && argument !== '--refresh' && !argument.startsWith('--field='))
if (!ids.length || ids.some(id => !/^(skills|cards|rules)\/[a-z0-9][a-z0-9-]*$/.test(id))) {
  throw new Error('Usage: node --import tsx scripts/migrate-content-graphs.ts [--write] [--field=previewCode] skills/id cards/id rules/id')
}
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8'))
const changes = [...new Set(ids)].map(id => {
  const original = baseline.entries[id]
  if (!original) throw new Error(`${id}: not in frozen ordinary-match baseline`)
  const file = path.join(root, 'data', `${id}.json`)
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  assertContentGraphArtifact(current)
  if (!fieldOption && !refresh && JSON.stringify(current) !== JSON.stringify(original)) throw new Error(`${id}: differs from frozen baseline; inspect before migration`)
  if (fieldOption || refresh) {
    if (!current.contentGraph) throw new Error(`${id}: migrate primary entry first`)
    const generated = new Set([current.contentGraphField, ...Object.keys(current.contentGraphEntries ?? {})])
    for (const key of Object.keys(original)) {
      if (!generated.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: baseline field changed: ${key}`)
    }
    if (!refresh && fieldOption && current.contentGraphEntries?.[fieldOption]) throw new Error(`${id}: secondary entry already migrated`)
  }
  const group = id.split('/')[0]
  const field = fieldOption ?? (group === 'rules' ? 'skillCode' : 'code')
  const surface: ContentGraphSurface = field === 'previewCode' ? 'preview' : group === 'rules' ? 'rule' : group === 'cards' ? 'card' : original.kind === 'passive' ? 'triggerSkill' : 'skill'
  if (typeof original[field] !== 'string') throw new Error(`${id}: no inline primary field`)
  const graph = importContentGraph(original[field], surface)
  const document = applyContentGraph(current, graph, field)
  assertContentGraphArtifact(document)
  for (const key of Object.keys(current)) {
    if (key !== field && !['contentGraph','contentGraphField','contentGraphCompilerVersion','contentGraphEntries'].includes(key) && JSON.stringify(current[key]) !== JSON.stringify(document[key])) throw new Error(`${id}: changed compatibility field ${key}`)
  }
  return { id, file, document, field, nodes: graph.nodes.length }
})
if (write) for (const change of changes) fs.writeFileSync(change.file, JSON.stringify(change.document, null, 2) + '\n')
console.log(JSON.stringify({
  mode: write ? 'written' : 'dry-run', baseSha: baseline.baseSha,
  notice: 'Compilation is not behavior verification. Other inline fields remain unmigrated.',
  changes: changes.map(({ id, field, nodes }) => ({ id, field, nodes })),
}, null, 2))
