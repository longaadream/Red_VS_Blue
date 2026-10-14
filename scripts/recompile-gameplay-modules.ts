/** Rebuild generated fields from their sole authoring source; never infer graphs from code. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyGameplayModuleGraph, assertGameplayModuleDocument } from '../lib/skill-graph/module-document'

export function recompileGameplayDocuments(root: string, write = false): { documents: number; entries: number; changed: string[] } {
  let documents = 0
  let entries = 0
  const changes: Array<{ file: string; content: string }> = []
  for (const group of ['pieces', 'skills', 'rules', 'cards']) {
    const directory = path.join(root, 'data', group)
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'manifest.json').sort()) {
      const file = path.join(directory, name)
      const original = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!original.gameplayModules?.entries) continue
      // Validate the old version first. Recompilation must not launder a
      // mismatching executable field into an apparently valid document.
      try { assertGameplayModuleDocument(original) }
      catch (cause) { throw new Error(`${path.relative(root, file)}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }) }
      let next = original
      for (const [field, entry] of Object.entries(original.gameplayModules.entries) as Array<[string, { graph: unknown }]>) {
        next = applyGameplayModuleGraph(next, entry.graph, field)
        entries++
      }
      assertGameplayModuleDocument(next)
      documents++
      if (JSON.stringify(original) !== JSON.stringify(next)) changes.push({ file, content: JSON.stringify(next, null, 2) + '\n' })
    }
  }
  // Finish validation of the complete batch before replacing any source file.
  if (write) for (const change of changes) fs.writeFileSync(change.file, change.content, 'utf8')
  return { documents, entries, changed: changes.map(change => path.relative(root, change.file).split(path.sep).join('/')) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const write = process.argv.includes('--write')
  console.log(JSON.stringify({ write, ...recompileGameplayDocuments(root, write) }, null, 2))
}
