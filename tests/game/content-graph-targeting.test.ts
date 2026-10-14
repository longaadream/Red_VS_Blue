import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importContentGraph } from '../../electron-editor/content-graph-import'
import { compileContentGraph } from '../../electron-editor/content-graph'
import { extractTargetSpecsFromCode } from '../../lib/game/targeting'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as {
  entries: Record<string, {code?: string; targeting?: unknown}>
}
const supported: Array<{id:string; kind:'skill'|'card'; original:string; compiled:string}> = []
for (const [id, content] of Object.entries(frozen.entries)) {
  if (!content.code || (!id.startsWith('skills/') && !id.startsWith('cards/'))) continue
  const kind = id.startsWith('skills/') ? 'skill' : 'card'
  const production = JSON.parse(readFileSync(`data/${id}.json`, 'utf8'))
  if (production.contentGraphField === 'code') {
    supported.push({id, kind, original:content.code, compiled:production.code})
    continue
  }
  // Unsupported content remains explicit migration debt. Every accepted import
  // must preserve the parser contract, including skills with declared targeting.
  let graph
  try { graph = importContentGraph(content.code, kind) } catch { continue }
  supported.push({id, kind, original:content.code, compiled:compileContentGraph(graph).code})
}

describe('legacy static targeting compatibility', () => {
  it('checks a nonempty corpus from the frozen migration baseline', () => {
    expect(supported.length).toBeGreaterThan(40)
  })
  for (const entry of supported) it(entry.id, () => {
    expect(extractTargetSpecsFromCode(entry.compiled, entry.kind)).toEqual(extractTargetSpecsFromCode(entry.original, entry.kind))
  })
})
