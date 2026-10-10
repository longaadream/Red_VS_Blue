import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildContentGraphWithPending } from '../electron-editor/content-graph-pending'
import { applyContentGraph, assertContentGraphArtifact } from '../electron-editor/content-graph-document'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PENDING_CONTENT_IDS = ['skills/minato-spiral-barrage', 'skills/turalyon-grand-crusade'] as const
const same = (left:unknown,right:unknown) => JSON.stringify(left) === JSON.stringify(right)
const hash = (text:string) => createHash('sha256').update(text).digest('hex')

/** Explicit frozen migrations only. A valid but manually edited graph is still
 * a conflict, never permission to replace the author's changes. */
export function buildPendingContentMigration(id:string, current?:Record<string,unknown>) {
  if (!(PENDING_CONTENT_IDS as readonly string[]).includes(id)) throw new Error(`${id}: unsupported pending migration ID`)
  const fixture = JSON.parse(fs.readFileSync(path.join(root,'tests/game/fixtures/RED-252-legacy-content.json'),'utf8'))
  const legacy:Record<string,unknown> = fixture.entries[id]
  const document = current ?? JSON.parse(fs.readFileSync(path.join(root,'data',`${id}.json`),'utf8'))
  assertContentGraphArtifact(document)
  const built = buildContentGraphWithPending(String(legacy.code),'skill',`${id}.js`)
  if (!built.sourcePairs.length) throw new Error(`${id}: expected pending subgraphs`)
  const expected = applyContentGraph(legacy,built.graph,'code')
  if (document.contentGraph) {
    for (const field of ['code','contentGraph','contentGraphField','contentGraphCompilerVersion']) {
      if (!same(document[field],expected[field])) throw new Error(`${id}: existing graph differs from the recognized frozen migration (${field})`)
    }
  } else if (!same(document.code,legacy.code)) throw new Error(`${id}: source differs from frozen baseline`)
  for (const field of Object.keys(legacy)) {
    // Validated secondary entries are independently authored and preserved.
    // Re-running the primary migration must not replace their compiled source.
    if (field !== 'code' && !(document.contentGraphEntries as Record<string, unknown> | undefined)?.[field] && !same(document[field],legacy[field])) throw new Error(`${id}: baseline field changed: ${field}`)
  }
  const migrated = applyContentGraph(document,built.graph,'code')
  assertContentGraphArtifact(migrated)
  return {id,document:migrated,sourcePairs:built.sourcePairs,baseSha:fixture.baseSha}
}

function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const ids = [...new Set(args.filter(arg=>arg !== '--write'))]
  if (!ids.length) throw new Error('Usage: node --import tsx scripts/migrate-pending-content-graphs.ts [--write] skills/id ...')
  // Preflight every item before the first write.
  const changes = ids.map(id=>buildPendingContentMigration(id))
  if (write) for (const change of changes) fs.writeFileSync(path.join(root,'data',`${change.id}.json`),JSON.stringify(change.document,null,2)+'\n')
  console.log(JSON.stringify({mode:write?'written':'dry-run',baseSha:changes[0].baseSha,changes:changes.map(change=>({
    id:change.id,sourcePairs:change.sourcePairs.map(pair=>({legacySha256:hash(pair.legacy),compiledSha256:hash(pair.compiled)})),
  }))},null,2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
