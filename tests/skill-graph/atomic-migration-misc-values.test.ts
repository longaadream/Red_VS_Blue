import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicMiscValuesRecipe } from '../../lib/skill-graph/atomic-migration-misc-values'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayValueType } from '../../lib/skill-graph/module-types'

function evaluate(module: string, port: string, sourceType: GameplayValueType, source: unknown, input: string, type: GameplayValueType, parameters: Record<string, string | number[]> = {}, flow: unknown = {}) {
  const fixture: GameplayModuleDescriptor = {
    id: 'fixture.value', version: '1', label: 'fixture', allowedSurfaces: ['skill'],
    inputs: [], outputs: [{ name: 'value', type: sourceType }], effects: { pure: true, previewSafe: false },
    lower: () => '({value:context.fixture})',
  }
  const registry = { get: (id: string, version?: string) => id === fixture.id ? fixture : GAMEPLAY_MODULE_REGISTRY.get(id, version) }
  const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'value', type }], body: [
    { kind: 'call', id: 'source', module: fixture.id, version: '1' },
    { kind: 'call', id: 'read', module, version: '1', inputs: { [input]: { kind: 'output', node: 'source', port: 'value' } }, parameters },
    { kind: 'return', id: 'done', value: { kind: 'output', node: 'read', port } },
  ] }
  const migrated = rewriteAtomicGraph(graph, atomicMiscValuesRecipe)
  const execute = (value: GameplayModuleGraph) => runInNewContext('(' + compileGameplayModuleGraph(value, registry).code + ')', { flow })({ fixture: source })
  expect(execute(migrated), module + ' input=' + JSON.stringify(source)).toEqual(execute(graph))
  expect(rewriteAtomicGraph(migrated, atomicMiscValuesRecipe)).toEqual(migrated)
  return execute(migrated)
}

describe('generic observation fields and values', () => {
  it('reads movement changes from the authoritative result, including successful no-op movement', () => {
    const fixture: GameplayModuleDescriptor = { id: 'fixture.piece', version: '1', label: '棋子', allowedSurfaces: ['skill'],
      inputs: [], outputs: [{ name: 'piece', type: 'piece' }, { name: 'cell', type: 'cell' }], effects: { pure: true, previewSafe: true }, lower: () => '({piece:"self",cell:{x:1,y:2}})' }
    const registry = { get: (id: string, version?: string) => id === fixture.id ? fixture : GAMEPLAY_MODULE_REGISTRY.get(id, version) }
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'piece', module: fixture.id, version: '1' },
      { kind: 'call', id: 'move', module: 'effect.teleport-with-change', version: '1', parameters: { kind: 'teleport' }, inputs: {
        piece: { kind: 'output', node: 'piece', port: 'piece' }, destination: { kind: 'output', node: 'piece', port: 'cell' },
      } },
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'move', port: 'result' }, success: { kind: 'output', node: 'move', port: 'success' }, changed: { kind: 'output', node: 'move', port: 'changed' } } },
    ], outputs: [{ name: 'result', type: 'record' }, { name: 'success', type: 'boolean' }, { name: 'changed', type: 'boolean' }] }
    const migrated = rewriteAtomicGraph(graph, atomicMiscValuesRecipe)
    for (const result of [{ success: true, changes: [] }, { success: false, changes: [] }, { success: true, changes: [{ pieceId: 'self' }] }, { success: false }]) {
      const calls: unknown[] = []
      const flow = { effects: { move: (...args: unknown[]) => { calls.push(args); return result } } }
      const execute = (source: GameplayModuleGraph) => runInNewContext('(' + compileGameplayModuleGraph(source, registry).code + ')', { flow })({})
      expect(execute(migrated)).toEqual(execute(graph))
      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual(calls[1])
    }
  })
  it('composes player display names without a dedicated fallback helper', () => {
    const players: Record<string, { playerId: string; name?: string }> = { red: { playerId: 'red', name: '红方' }, blue: { playerId: 'blue', name: '' }, unnamed: { playerId: 'unnamed' } }
    const flow = { query: { players: () => Object.keys(players), hasPlayer: (id: string) => Boolean(players[id]), player: (id: string) => players[id], playerText: (id: string) => players[id]?.name ?? '' } }
    for (const [id, expected] of [['red', '红方'], ['blue', 'blue'], ['unnamed', 'unnamed'], ['missing', undefined], [null, '']] as const) {
      expect(evaluate('player.display-name', 'text', { kind: 'nullable', value: 'player' }, id, 'player', 'string', {}, flow)).toBe(expected)
    }
  })
  it('preserves legacy nullable coordinate reads using ordinary coalescing', () => {
    for (const source of [null, { x: 0, y: 0 }, { x: 2, y: -3 }]) {
      for (const field of ['x', 'y'] as const) {
        expect(evaluate('spatial.cell-coordinates-safe', field, { kind: 'nullable', value: 'cell' }, source, 'cell', 'number')).toBe(source?.[field] ?? 0)
      }
    }
  })
  it.each([
    ['projectile.event-kind', 'kind', 'string'], ['projectile.event-distance', 'distance', 'number'],
    ['projectile.event-blocks', 'blocks', 'boolean'], ['projectile.event-piece', 'piece', { kind: 'nullable', value: 'piece' }],
  ] as const)('preserves %s observations without requiring the historical piece to exist', (module, port, type) => {
    for (const source of [{}, { type: 'piece', distance: 0, piece: { instanceId: 'departed' }, blocksProjectile: false }, { type: 'terrain', distance: 5, blocksProjectile: true }]) {
      evaluate(module, port, 'event', source, 'event', type)
    }
  })
  it('keeps null and empty strings distinct from invalid references', () => {
    for (const source of [null, '', '内容']) expect(evaluate('value.string-or-empty', 'text', { kind: 'nullable', value: 'string' }, source, 'value', 'string')).toEqual(source ?? '')
  })
  it('preserves lowest-health ties, zero health and the empty collection', () => {
    const pieces = new Map([['first', { instanceId: 'first', currentHp: 3 }], ['tie', { instanceId: 'tie', currentHp: 3 }], ['zero', { instanceId: 'zero', currentHp: 0 }]])
    const flow = { query: { piece: (id: string) => pieces.get(id), hasPiece: (id: string) => pieces.has(id) } }
    for (const [items, expected] of [[[], null], [['first', 'tie'], 'first'], [['tie', 'first'], 'tie'], [['first', 'zero'], 'zero']] as const) {
      expect(evaluate('query.lowest-hp', 'piece', { kind: 'list', element: 'piece' }, items, 'pieces', { kind: 'nullable', value: 'piece' }, {}, flow)).toBe(expected)
    }
  })
  it('looks up distance multipliers using first-index and null semantics', () => {
    for (const distance of [-1, 0, 1, 1.5, 2, 3, 7]) evaluate('projectile.distance-multiplier', 'value', 'number', distance, 'distance', 'number', { values: [1, 0, 0.5] })
  })
})
