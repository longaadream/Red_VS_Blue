import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayValueType } from '../../lib/skill-graph/module-types'

const nullableStrings: GameplayValueType = { kind: 'list', element: { kind: 'nullable', value: 'string' } }
function graph(type: GameplayValueType): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'items', type }], body: [
    { kind: 'call', id: 'joined', module: 'collection.concat', version: '1', parameters: { valueType: JSON.stringify(nullableStrings) }, inputs: {
      left: { kind: 'literal', value: ['a'] }, right: { kind: 'literal', value: [null] },
    } },
    { kind: 'return', id: 'done', value: { kind: 'output', node: 'joined', port: 'items' } },
  ] }
}
describe('tuple concatenation preserves both input types', () => {
  it('rejects a nonnullable return when the second tuple can contain null', () => {
    expect(() => compileGameplayModuleGraph(graph({ kind: 'list', element: 'string' }), GAMEPLAY_MODULE_REGISTRY)).toThrow()
  })
  it('returns the entire tuple under its declared nullable type', () => {
    const compiled = compileGameplayModuleGraph(graph(nullableStrings), GAMEPLAY_MODULE_REGISTRY)
    expect(new Function('return (' + compiled.code + ')')()({})).toEqual(['a', null])
  })
})
