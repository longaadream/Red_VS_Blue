import { describe, expect, it } from 'vitest'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicStorageReadRecipe } from '../../lib/skill-graph/atomic-migration-storage-reads'
import { atomicExtensionQueryRecipe } from '../../lib/skill-graph/atomic-migration-extension-queries'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayValueType } from '../../lib/skill-graph/module-types'

const fixture: GameplayModuleDescriptor = { id: 'fixture.record', version: '1', label: 'fixture', inputs: [], outputs: [{ name: 'value', type: 'record', nullable: true }], allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => '({value:context.record})' }
const registry = { get: (id: string, version?: string) => id === fixture.id ? fixture : GAMEPLAY_MODULE_REGISTRY.get(id, version) }
function run(graph: GameplayModuleGraph, record: unknown, extensions = {}) {
  const code = compileGameplayModuleGraph(graph, registry).code
  return new Function('battle', 'return (' + code + ')')({ extensions })({ record })
}
describe('storage fields replace specialized extension readers', () => {
  it.each([
    ['extension.read-number', 'turns', 'number', 8, 0],
    ['extension.read-text', 'kind', 'string', 'burn', ''],
    ['record.read-text', 'message', 'string', '说明', '默认'],
  ] as const)('%s reads its field and retains the missing-field default', (module, field, type, value, fallback) => {
    const original: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'value', type }], body: [
      { kind: 'call', id: 'record', module: fixture.id, version: '1' },
      { kind: 'call', id: 'read', module, version: '1', parameters: { field }, inputs: { record: { kind: 'output', node: 'record', port: 'value' }, fallback: { kind: 'literal', value: fallback } } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'read', port: 'value' } },
    ] }
    const migrated = rewriteAtomicGraph(original, atomicStorageReadRecipe)
    for (const record of [null, {}, { [field]: value }, { [field]: null }]) expect(run(migrated, record)).toEqual(run(original, record))
    expect(rewriteAtomicGraph(migrated, atomicStorageReadRecipe)).toEqual(migrated)
  })
  it.each(['extension.read-list', 'extension.read-cell-records'])('%s preserves root layout, order and empty results', module => {
    const type: GameplayValueType = { kind: 'list', element: module === 'extension.read-list' ? 'record' : 'cell' }
    const original: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'value', type }], body: [
      { kind: 'call', id: 'read', module, version: '1', parameters: module === 'extension.read-list' ? { key: 'shishioBurnTiles' } : { storageKey: 'amaterasuCells' } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'read', port: 'cells' } },
    ] }
    const migrated = rewriteAtomicGraph(rewriteAtomicGraph(original, atomicStorageReadRecipe), atomicExtensionQueryRecipe)
    for (const extensions of [{}, { shishioBurnTiles: [{ x: 2, y: 3, sourcePieceId: 'a' }], amaterasuCells: [{ x: 2, y: 3, sourcePieceId: 'a' }] }]) expect(run(migrated, null, extensions)).toEqual(run(original, null, extensions))
  })
})
