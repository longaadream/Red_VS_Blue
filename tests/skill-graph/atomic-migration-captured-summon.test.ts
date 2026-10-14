import { describe, expect, it } from 'vitest'

import { atomicCapturedSummonRecipe } from '../../lib/skill-graph/atomic-migration-captured-summon'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'

const output = (node: string, port: string) => ({ kind: 'output' as const, node, port })
const literal = (value: unknown) => ({ kind: 'literal' as const, value: value as never })

function legacyGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
      { kind: 'call', id: 'capture', module: 'source.capture', version: '1', inputs: { source: output('source', 'piece') } },
      { kind: 'call', id: 'cell', module: 'spatial.cell', version: '1', inputs: { x: literal(2), y: literal(1) } },
      { kind: 'call', id: 'queue', module: 'lifecycle.summon-captured', version: '1', inputs: { source: output('capture', 'source'), cell: output('cell', 'cell') } },
      { kind: 'return', id: 'done', value: output('queue', 'queued') },
    ],
    outputs: [{ name: 'queued', type: 'number' }],
  }
}

describe('captured summon atomic migration', () => {
  it('lowers the old queue adapter to declaration mode plus a queueCount read', () => {
    const migrated = rewriteAtomicGraph(legacyGraph(), atomicCapturedSummonRecipe)
    const summon = migrated.body.find(statement => statement.kind === 'call' && statement.id === 'queue')
    const queueCount = migrated.body.find(statement => statement.kind === 'call' && statement.id === 'queue--queue-count')
    expect(summon).toMatchObject({
      module: 'author.effect.summon', version: '2',
      inputs: { source: output('capture', 'source'), destination: output('cell', 'cell') },
      parameters: { mode: 'declaration', sourceType: 'record', destinationType: 'cell' },
    })
    expect(queueCount).toMatchObject({
      module: 'result.field', version: '1',
      inputs: { record: output('queue', 'result') },
      parameters: { field: 'queueCount' },
    })
    expect(migrated.body.at(-1)).toMatchObject({ value: output('queue--queue-count', 'value') })
    expect(compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY).diagnostics).toEqual([])
  })

  it('leaves malformed compatibility calls untouched', () => {
    const graph = legacyGraph()
    const queue = graph.body.find(statement => statement.kind === 'call' && statement.id === 'queue')
    if (queue?.kind !== 'call') throw new Error('legacy queue fixture is missing')
    const invalidGraph: GameplayModuleGraph = {
      ...graph,
      body: graph.body.map(statement => statement === queue
        ? { ...queue, inputs: { source: output('capture', 'source') } }
        : statement),
    }
    const migrated = rewriteAtomicGraph(invalidGraph, atomicCapturedSummonRecipe)
    expect(migrated.body.find(statement => statement.kind === 'call' && statement.id === 'queue')).toMatchObject({ module: 'lifecycle.summon-captured', version: '1' })
    expect(migrated.body.some(statement => statement.kind === 'call' && statement.module === 'author.effect.summon')).toBe(false)
  })
})
