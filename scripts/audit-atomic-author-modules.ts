/** Full catalog inventory. Compatibility entries are not silently called atomic. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getGameplayModuleCatalog } from '../lib/skill-graph/module-registry'
import { RETIRED_AUTHOR_MODULES } from '../lib/skill-graph/author-module-catalog'
import { assertGameplayModuleDocument } from '../lib/skill-graph/module-document'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const usages = new Map<string, { calls: number; entries: Set<string> }>()
const composites = new Set<string>()
let documents = 0, entries = 0
function visit(value: unknown, entry: string): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach(item => visit(item, entry)); return }
  const record = value as Record<string, unknown>
  // Literal objects may describe data that happens to contain kind/module.
  if (record.kind === 'literal') return
  if (Array.isArray(record.composites)) for (const item of record.composites) {
    if (item && typeof item.id === 'string' && typeof item.version === 'string' && Array.isArray(item.body)) composites.add(item.id + '@' + item.version)
  }
  if (record.kind === 'call' && typeof record.module === 'string' && typeof record.version === 'string') {
    const key = record.module + '@' + record.version
    const usage = usages.get(key) ?? { calls: 0, entries: new Set<string>() }
    usage.calls++; usage.entries.add(entry); usages.set(key, usage)
  }
  Object.values(record).forEach(item => visit(item, entry))
}
for (const group of ['pieces', 'skills', 'rules', 'cards']) {
  for (const name of fs.readdirSync(path.join(root, 'data', group)).filter(name => name.endsWith('.json') && name !== 'manifest.json').sort()) {
    const relative = `data/${group}/${name}`
    const document = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
    if (!document.gameplayModules?.entries) continue
    assertGameplayModuleDocument(document); documents++
    for (const [field, entry] of Object.entries(document.gameplayModules.entries)) {
      entries++
      visit((entry as { graph: unknown }).graph, `${relative}#${field}`)
    }
  }
}
const catalog = getGameplayModuleCatalog().map(module => {
  const key = module.id + '@' + module.version
  const usage = usages.get(key)
  const classification = RETIRED_AUTHOR_MODULES.has(module.id) ? 'retired-compatibility'
    : module.ui?.authoring === 'standard' ? 'public-primitive'
      : usage ? 'compatibility-still-used' : 'compatibility-unused'
  usages.delete(key)
  return { key, label: module.label, classification, pure: module.effects.pure,
    calls: usage?.calls ?? 0, entries: [...(usage?.entries ?? [])].sort(),
    inputs: module.inputs, outputs: module.outputs, parameters: module.parameters }
})
const report = {
  documents, entries, descriptors: catalog.length,
  retiredCalls: catalog.filter(module => module.classification === 'retired-compatibility').reduce((sum, module) => sum + module.calls, 0),
  unresolvedCompatibility: catalog.filter(module => module.classification === 'compatibility-still-used').map(({ key, label, calls, entries }) => ({ key, label, calls, entries })),
  graphComposites: [...usages].filter(([key]) => composites.has(key)).map(([key, usage]) => ({ key, calls: usage.calls, entries: [...usage.entries] })),
  unknown: [...usages].filter(([key]) => !composites.has(key)).map(([key, usage]) => ({ key, calls: usage.calls, entries: [...usage.entries] })),
  catalog,
}
const destination = path.join(root, 'docs/qa/RED-252-studio-v1/atomic-catalog-audit.json')
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, catalog: report.catalog.length, unresolvedCompatibility: report.unresolvedCompatibility.length }, null, 2))
if (report.retiredCalls || report.unknown.length) process.exitCode = 1
