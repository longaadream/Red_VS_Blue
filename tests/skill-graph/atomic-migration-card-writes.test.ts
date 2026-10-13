import { runInThisContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicCardWriteRecipe } from '../../lib/skill-graph/atomic-migration-card-writes'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayJsonValue } from '../../lib/skill-graph/module-types'
import { makeState, makePiece } from '../helpers/minimal-state'

const fixture: GameplayModuleDescriptor = { id: 'fixture.player', version: '1', label: '玩家', allowedSurfaces: ['skill'],
  inputs: [], outputs: [{ name: 'player', type: 'player' }, { name: 'piece', type: 'piece' }], effects: { pure: true, previewSafe: true }, lower: () => '({player:"player-red",piece:"source"})' }
const registry = { get: (id: string, version?: string) => id === fixture.id ? fixture : GAMEPLAY_MODULE_REGISTRY.get(id, version) }
const parameters: Record<string, Record<string, GameplayJsonValue>> = {
  'card.set-presentation': { variant: 'enhanced', badge: '祝福', description: '强化说明' },
  'card.set-effect-modifier': { effect: 'damage', operation: 'multiply', value: 2, statusType: 'burn' },
  'card.set-content-record': { field: 'velenHolyProphecy' },
  'card.set-content-boolean': { field: 'velenHolyProphecyEnhanced' },
}

function graph(moduleId: string, id: string): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill',
    schemas: [{ id: 'velen-holy-prophecy', version: '1', fields: [{ name: 'sourcePieceId', type: 'string' }, { name: 'createdTurnNumber', type: 'number' }] }],
    body: [
      { kind: 'call', id: 'player', module: fixture.id, version: '1' },
      { kind: 'record.create', id: 'record', schema: 'velen-holy-prophecy@1', fields: { sourcePieceId: { kind: 'literal', value: 'source' }, createdTurnNumber: { kind: 'literal', value: 3 } } },
      { kind: 'call', id: 'write', module: moduleId, version: '1', parameters: parameters[moduleId], inputs: {
        player: { kind: 'output', node: 'player', port: 'player' }, card: { kind: 'literal', value: id },
        ...(moduleId === 'card.set-content-record' ? { record: { kind: 'output' as const, node: 'record', port: 'value' } } : {}),
      } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'write', port: 'success' } },
    ], outputs: [{ name: 'success', type: 'boolean' }] }
}
describe('card instance field composition', () => {
  it.each([
    [{ effect: 'damage', operation: 'typo', value: 2 }],
    [{ effect: 'unknown', operation: 'add', value: 2 }],
    [{ effect: 'heal', operation: 'multiply', value: '2' }],
    [{ effect: 'statusIntensity', operation: 'add', value: 2, statusType: 3 }],
    [null],
  ])('rejects invalid card modifiers without partially changing the instance: %j', modifier => {
    const battle = makeState()
    const original = [{ effect: 'damage' as const, operation: 'add' as const, value: 1 }]
    battle.players[0]!.hand = [{ instanceId: 'one', cardId: 'same', ownerPlayerId: 'player-red', effectModifiers: original }]
    const flow = createFlowRuntime(battle, {}, 'skill', {})
    expect(() => flow.cards.writeField('player-red', 'one', 'effectModifiers', [...original, modifier])).toThrow('手牌效果修正')
    expect(battle.players[0]!.hand[0].effectModifiers).toEqual(original)
  })
  it('validates presentation fields before replacing existing presentation', () => {
    const battle = makeState()
    battle.players[0]!.hand = [{ instanceId: 'one', cardId: 'same', ownerPlayerId: 'player-red', presentation: { badge: '保留' } }]
    const flow = createFlowRuntime(battle, {}, 'skill', {})
    expect(() => flow.cards.writeField('player-red', 'one', 'presentation', { badge: 4 })).toThrow('手牌显示')
    expect(battle.players[0]!.hand[0].presentation).toEqual({ badge: '保留' })
    expect(flow.cards.writeField('player-red', 'one', 'presentation', { description: '更新' })).toBe(true)
    expect(battle.players[0]!.hand[0].presentation).toEqual({ description: '更新' })
  })
  it('binds the last unbound instance of the requested definition only', () => {
    const source: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'refs', module: fixture.id, version: '1' },
      { kind: 'call', id: 'bind', module: 'card.bind-latest-unbound', version: '1', inputs: { player: { kind: 'output', node: 'refs', port: 'player' }, piece: { kind: 'output', node: 'refs', port: 'piece' } }, parameters: { cardId: 'wanted' } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'bind', port: 'success' } },
    ], outputs: [{ name: 'success', type: 'boolean' }] }
    for (const hasMatch of [true, false]) {
      const states: unknown[] = []
      for (const migrate of [false, true]) {
        const battle = makeState({ pieces: [makePiece({ instanceId: 'source' })] })
        battle.players[0]!.hand = ['wanted', hasMatch ? 'wanted' : 'other', 'wanted', 'other'].map((cardId, index) => ({ cardId, instanceId: String(index), ownerPlayerId: 'player-red', ...(index === 2 || !hasMatch ? { boundPieceInstanceId: 'already' } : {}) }))
        const flow = createFlowRuntime(battle, {}, 'skill', {})
        const compiled = compileGameplayModuleGraph(migrate ? rewriteAtomicGraph(source, atomicCardWriteRecipe) : source, registry)
        expect(runInThisContext('(function(flow,battle){return (' + compiled.code + ');})')(flow, battle)({})).toBe(hasMatch)
        if (hasMatch) expect(battle.players[0]!.hand[1]).toMatchObject({ boundPieceInstanceId: 'source' })
        states.push(battle)
      }
      expect(states[0]).toEqual(states[1])
    }
  })
  it('clears every matching source record while retaining other card data and returning its count', () => {
    const source: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      { kind: 'call', id: 'refs', module: fixture.id, version: '1' },
      { kind: 'call', id: 'clear', module: 'card.clear-content-records', version: '1', inputs: { player: { kind: 'output', node: 'refs', port: 'player' }, source: { kind: 'output', node: 'refs', port: 'piece' } }, parameters: { field: 'velenHolyProphecy' } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'clear', port: 'count' } },
    ], outputs: [{ name: 'count', type: 'number' }] }
    const states: unknown[] = []
    for (const migrate of [false, true]) {
      const battle = makeState({ pieces: [makePiece({ instanceId: 'source' })] })
      battle.players[0]!.hand = ['source', 'other', 'source', undefined].map((sourcePieceId, index) => ({ instanceId: String(index), cardId: 'same', ownerPlayerId: 'player-red', contentState: { untouched: true, ...(sourcePieceId ? { velenHolyProphecy: { sourcePieceId, createdTurnNumber: 10 } } : {}) } })) as typeof battle.players[0]['hand']
      const flow = createFlowRuntime(battle, {}, 'skill', {})
      const compiled = compileGameplayModuleGraph(migrate ? rewriteAtomicGraph(source, atomicCardWriteRecipe) : source, registry)
      expect(runInThisContext('(function(flow,battle){return (' + compiled.code + ');})')(flow, battle)({})).toBe(2)
      states.push(battle)
    }
    expect(states[0]).toEqual(states[1])
  })
  for (const moduleId of Object.keys(parameters)) it('preserves ' + moduleId + ' and changes only one same-name card instance', () => {
    for (const id of ['second', 'missing']) {
      const states: unknown[] = []
      for (const migrate of [false, true]) {
        const battle = makeState()
        battle.players[0]!.hand = ['first', 'second'].map(instanceId => ({ instanceId, cardId: 'same-card', ownerPlayerId: 'player-red', contentState: { untouched: true } })) as typeof battle.players[0]['hand']
        const before = structuredClone(battle.players[0]!.hand[0])
        const flow = createFlowRuntime(battle, {}, 'skill', {})
        const source = graph(moduleId, id), migrated = rewriteAtomicGraph(source, atomicCardWriteRecipe)
        expect(rewriteAtomicGraph(migrated, atomicCardWriteRecipe)).toEqual(migrated)
        const compiled = compileGameplayModuleGraph(migrate ? migrated : source, registry)
        const result = runInThisContext('(function(flow){return (' + compiled.code + ');})')(flow)({})
        expect(result).toBe(id !== 'missing')
        expect(battle.players[0]!.hand[0]).toEqual(before)
        states.push(battle)
      }
      expect(states[0]).toEqual(states[1])
    }
  })
})
