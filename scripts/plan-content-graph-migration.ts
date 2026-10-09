import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importContentGraph } from '../electron-editor/content-graph-import'
import { applyContentGraph, assertContentGraphArtifact, type ContentGraphSurface } from '../electron-editor/content-graph-document'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const coverage = JSON.parse(fs.readFileSync(path.join(root, 'docs/qa/RED-252-content-coverage.json'), 'utf8'))
const results: Array<Record<string, unknown>> = []
const additionalEntries: Array<Record<string, unknown>> = []
for (const item of coverage.nodes as Array<{group: string; sourcePath: string; scope: string; nodeKey: string; reachability: {status: string}}>) {
  if (item.scope !== 'ordinary' || item.group === 'pieces' || item.reachability.status !== 'reachable') continue
  const document = JSON.parse(fs.readFileSync(path.join(root, item.sourcePath), 'utf8'))
  // A compiled primary must not conceal an unmigrated preview or continuation.
  for (const [field, surface] of [['previewCode', 'preview'], ['effectCode', 'pending']] as const) {
    if (typeof document[field] !== 'string') continue
    try {
      if (document.contentGraphField === field || document.contentGraphEntries?.[field]) {
        assertContentGraphArtifact(document)
        additionalEntries.push({id:item.nodeKey, field, status:'compiled'})
      } else {
        const graph = importContentGraph(document[field], surface)
        additionalEntries.push({id:item.nodeKey, field, status:'importable-not-migrated', nodes:graph.nodes.length})
      }
    } catch (error) {
      additionalEntries.push({id:item.nodeKey, field, status:'unsupported', reason:(error as Error).message})
    }
  }
  if (document.contentGraph) {
    try { assertContentGraphArtifact(document); results.push({ id: item.nodeKey, status: 'compiled', field: document.contentGraphField }) }
    catch (error) { results.push({ id: item.nodeKey, status: 'invalid-artifact', reason: (error as Error).message }) }
    continue
  }
  const field = item.group === 'rules' ? 'skillCode' : 'code'
  if (typeof document[field] !== 'string') {
    results.push({ id: item.nodeKey, status: 'declarative-or-linked', reason: 'No inline primary code; referenced content must be checked separately.' })
    continue
  }
  const surface: ContentGraphSurface = item.group === 'rules' ? 'rule' : item.group === 'cards' ? 'card' : document.kind === 'passive' ? 'triggerSkill' : 'skill'
  try {
    const graph = importContentGraph(document[field], surface)
    const next = applyContentGraph(document, graph, field)
    assertContentGraphArtifact(next)
    results.push({ id: item.nodeKey, status: 'importable-not-migrated', field, nodes: graph.nodes.length,
      preservedMetadata: Object.keys(document).filter(key => key !== field).every(key => JSON.stringify(document[key]) === JSON.stringify(next[key])) })
  } catch (error) {
    results.push({ id: item.nodeKey, status: 'unsupported', field, reason: (error as Error).message })
  }
}
const counts: Record<string, number> = {}
for (const result of results) counts[String(result.status)] = (counts[String(result.status)] || 0) + 1
const additionalCounts: Record<string, number> = {}
for (const entry of additionalEntries) additionalCounts[String(entry.status)] = (additionalCounts[String(entry.status)] || 0) + 1
const report = { schemaVersion: 1, baseSha: coverage.baseSha, policy: 'Importable is not migrated or behavior-verified. No content is changed by this command. Nested pending source remains a separate coverage obligation.', counts, results, additionalCounts, additionalEntries }
fs.writeFileSync(path.join(root, 'docs/qa/RED-252-migration-plan.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(counts, null, 2))
