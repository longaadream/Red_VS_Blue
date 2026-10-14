import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileContentGraph, assertContentGraphArtifact } from '../electron-editor/content-graph-document'

// Explicitly rebuild generated fields after a compiler change. Never import or
// rewrite graph definitions here. Preflight the entire batch before any writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const write = args.includes('--write')
const ids = args.filter(value => value !== '--write')
if (!ids.length || ids.some(id => !/^(skills|cards|rules)\/[a-z0-9][a-z0-9-]*$/.test(id))) throw new Error('Usage: recompile-content-graphs.ts [--write] skills/id cards/id rules/id')
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8'))
const changes = [...new Set(ids)].map(id => {
  const file = path.join(root, 'data', `${id}.json`)
  const document = JSON.parse(fs.readFileSync(file, 'utf8'))
  const original = baseline.entries[id]
  if (!original || !document.contentGraph) throw new Error(`${id}: not a migrated frozen definition`)
  const fields = [document.contentGraphField, ...Object.keys(document.contentGraphEntries ?? {})]
  if (fields.some(field => !['code', 'skillCode', 'previewCode', 'effectCode'].includes(field))) throw new Error(`${id}: unsupported generated field`)
  for (const key of Object.keys(original)) {
    if (!fields.includes(key) && JSON.stringify(document[key]) !== JSON.stringify(original[key])) throw new Error(`${id}: non-generated baseline field changed: ${key}`)
  }
  const primary = compileContentGraph(document.contentGraph)
  document[document.contentGraphField] = primary.code
  document.contentGraphCompilerVersion = primary.compilerVersion
  for (const field of Object.keys(document.contentGraphEntries ?? {})) {
    const entry = document.contentGraphEntries[field]
    const compiled = compileContentGraph(entry.graph)
    document[field] = compiled.code
    entry.compilerVersion = compiled.compilerVersion
  }
  assertContentGraphArtifact(document)
  return {file, document}
})
if (write) for (const {file, document} of changes) fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n')
console.log(JSON.stringify({mode:write ? 'written' : 'dry-run', definitions:changes.length}))
