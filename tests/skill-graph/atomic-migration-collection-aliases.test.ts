import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicCollectionAliasRecipe } from '../../lib/skill-graph/atomic-migration-collection-aliases'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayValueType } from '../../lib/skill-graph/module-types'

function fixture(module: string, port: string, element: GameplayValueType, random = false): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'value', type: random ? { kind: 'nullable', value: element } : { kind: 'list', element } }], body: [
    { kind: 'call', id: 'items', module: 'fixture.items', version: '1' },
    { kind: 'call', id: 'result', module, version: '1', inputs: { items: { kind: 'output', node: 'items', port: 'value' } } },
    { kind: 'return', id: 'done', value: { kind: 'output', node: 'result', port } },
  ] }
}
function run(graph: GameplayModuleGraph, element: GameplayValueType, items: unknown[], draws: number[]) {
  const descriptor: GameplayModuleDescriptor = { id: 'fixture.items', version: '1', label: 'fixture', inputs: [], outputs: [{ name: 'value', type: { kind: 'list', element } }], allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: false }, lower: () => '({value:context.items})' }
  const code = compileGameplayModuleGraph(graph, { get: (id, version) => id === descriptor.id ? descriptor : GAMEPLAY_MODULE_REGISTRY.get(id, version) }).code
  const flow = { query: { random: (values: unknown[]) => { if (!values.length) return null; draws.push(0.67); return values[Math.floor(0.67 * values.length)] }, hasPiece: () => true } }
  return runInNewContext('(' + code + ')', { flow })({ items })
}
describe('generic collection aliases', () => {
  it.each([['list.sort-string', 'string'], ['list.sort-pieces', 'piece']] as const)('retains %s ordering, ties, empty input and original collection', (module, element) => {
    const original = fixture(module, 'sorted', element)
    const migrated = rewriteAtomicGraph(original, atomicCollectionAliasRecipe)
    for (const items of [[], ['z', 'a', 'a', 'Z', '10', '2', '中']]) {
      const before = [...items]
      expect(run(migrated, element, items, [])).toEqual(run(original, element, items, []))
      expect(items).toEqual(before)
    }
    expect(rewriteAtomicGraph(migrated, atomicCollectionAliasRecipe)).toEqual(migrated)
  })
  it.each([
    ['query.random-string', 'value', 'string', ['a', 'b', 'c']],
    ['query.random-item', 'item', 'piece', ['p1', 'p2', 'p3']],
    ['query.random-cell', 'cell', 'cell', [{ x: 1, y: 2 }, { x: 3, y: 4 }]],
  ] as const)('retains %s selection and entropy use', (module, port, element, items) => {
    const original = fixture(module, port, element, true)
    const migrated = rewriteAtomicGraph(original, atomicCollectionAliasRecipe)
    const oldDraws: number[] = [], newDraws: number[] = []
    expect(run(migrated, element, [...items], newDraws)).toEqual(run(original, element, [...items], oldDraws))
    expect(newDraws).toEqual(oldDraws)
    const emptyDraws: number[] = []
    expect(run(migrated, element, [], emptyDraws)).toBeNull()
    expect(emptyDraws).toEqual([])
  })
})
