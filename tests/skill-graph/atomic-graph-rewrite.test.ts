import { describe, expect, it } from 'vitest'
import { rewriteAtomicGraph, type AtomicRecipe } from '../../lib/skill-graph/atomic-graph-rewrite'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayValue } from '../../lib/skill-graph/module-types'

const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const recipe: AtomicRecipe = call => call.module === 'old.count' ? {
  statements: [{ ...call, module: 'collection.length' }], outputs: { count: out(call.id, 'value') },
} : undefined

describe('atomic author graph rewrites', () => {
  it('renames consumed ports through branches without interpreting literal payloads', () => {
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'count', module: 'old.count', version: '1', inputs: { items: { kind: 'literal', value: [] } } },
      { kind: 'if', id: 'branch', condition: { kind: 'literal', value: true }, then: [
        { kind: 'return', id: 'done', values: { value: out('count', 'count'), payload: { kind: 'literal', value: { kind: 'output', node: 'count', port: 'count' } } } },
      ] },
    ] }
    const result = rewriteAtomicGraph(graph, recipe)
    expect(result.body[1]).toMatchObject({ then: [{ values: { value: out('count', 'value'), payload: { kind: 'literal', value: out('count', 'count') } } }] })
    expect(graph.body[0]).toMatchObject({ module: 'old.count' })
    expect(rewriteAtomicGraph(result, recipe)).toEqual(result)
  })

  it('keeps explicit collection captures and local outputs in separate scopes', () => {
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'same', module: 'old.count', version: '1', inputs: { items: { kind: 'literal', value: [] } } },
      { kind: 'collection', id: 'mapped', method: 'map', items: { kind: 'literal', value: [1] }, inputs: { previous: out('same', 'count') }, body: [
        { kind: 'call', id: 'same', module: 'other', version: '1' },
        { kind: 'return', id: 'done', value: out('same', 'count') },
      ] },
    ] }
    expect(rewriteAtomicGraph(graph, recipe).body[1]).toMatchObject({ inputs: { previous: out('same', 'value') }, body: [{ module: 'other' }, { value: out('same', 'count') }] })
  })
})
