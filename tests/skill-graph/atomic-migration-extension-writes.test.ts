import { runInThisContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'
import { migrateExtensionWriteModules, ATOMIC_EXTENSION_WRITE_MODULES } from '../../lib/skill-graph/atomic-migration-extension-writes'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import { createFlowRuntime } from '../../lib/game/flow-runtime'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function execute(graph: GameplayModuleGraph, initial: ReturnType<typeof makeState>, contextPiece = initial.pieces[0]) {
  const battle = structuredClone(initial)
  const piece = battle.pieces.find(value => value.instanceId === contextPiece?.instanceId)
  const context = { piece, playerId: piece?.ownerPlayerId }
  const flow = createFlowRuntime(battle, context, 'skill', {})
  const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
  const factory = runInThisContext(`(function(battle,flow){return (${code})})`) as (battle: unknown, flow: unknown) => (value: unknown) => unknown
  const run = factory(battle, flow)
  return { result: run(context), battle }
}

function graph(body: GameplayModuleGraph['body'], output: GameplayValue, type: 'boolean' | 'number' = 'boolean'): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [...body, { kind: 'return', id: 'done', value: output }],
    outputs: [{ name: 'value', type }],
  }
}

function sourcePiece() {
  return asPieceInstance(makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' }))
}

describe('ordinary extension write migrations', () => {
  function cellList(statements: GameplayCallStatement[], cells: Array<[number, number]>) {
    let list: GameplayValue | undefined
    cells.forEach(([x, y], index) => {
      const cell = `cell-${index}`
      const singleton = `cell-singleton-${index}`
      statements.push(call(cell, 'spatial.cell', { x: literal(x), y: literal(y) }))
      statements.push(call(singleton, 'collection.singleton', { value: output(cell, 'cell') }, { valueType: 'cell' }))
      if (list === undefined) list = output(singleton, 'items')
      else {
        const joined = `cell-list-${index}`
        statements.push(call(joined, 'collection.concat', { left: list, right: output(singleton, 'items') }, { valueType: JSON.stringify({ kind: 'list', element: 'cell' }) }))
        list = output(joined, 'items')
      }
    })
    return list ?? literal([])
  }

  it('uses the root extension record for projectile zones and keeps invalid writes atomic', () => {
    const holder = call('holder', 'ref.holder')
    const source: GameplayModuleGraph = graph([
      holder,
      call('zone', 'projectile.zone-set', {
        source: output('holder', 'piece'), dx: literal(1), dy: literal(0),
      }, { storageKey: 'coltZones', kind: 'revolver', turns: 2 }),
    ], output('zone', 'success'))
    const migrated = migrateExtensionWriteModules(source)
    expect([...ATOMIC_EXTENSION_WRITE_MODULES]).toEqual(expect.arrayContaining(['projectile.zone-set', 'extension.store-piece']))
    expect(JSON.stringify(migrated.body)).not.toContain('projectile.zone-set')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = { coltZones: { existing: { sourceId: 'existing', turns: 8 } } }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
    expect(next.battle.extensions?.coltZones).toEqual({
      existing: { sourceId: 'existing', turns: 8 },
      source: { sourceId: 'source', kind: 'revolver', dx: 1, dy: 0, turns: 2 },
    })

    const invalidSource: GameplayModuleGraph = graph([
      holder,
      call('zone', 'projectile.zone-set', {
        source: output('holder', 'piece'), dx: literal(2), dy: literal(0),
      }, { storageKey: 'coltZones', kind: 'revolver', turns: 2 }),
    ], output('zone', 'success'))
    const invalidMigrated = migrateExtensionWriteModules(invalidSource)
    const invalidInitial = makeState({ pieces: [sourcePiece()] })
    invalidInitial.extensions = { coltZones: { existing: { sourceId: 'existing', turns: 8 } } }
    const invalidResult = execute(invalidMigrated, invalidInitial)
    expect(invalidResult.result).toBe(false)
    expect(invalidResult.battle.extensions).toEqual(invalidInitial.extensions)
  })

  it('normalizes owner keys for store-piece while preserving global first-write semantics', () => {
    const holder = call('holder', 'ref.holder')
    const snapshot = call('snapshot', 'instance.copy-piece', { piece: output('holder', 'piece') })
    const source: GameplayModuleGraph = graph([
      holder,
      snapshot,
      call('owner', 'piece.owner-id', { piece: output('holder', 'piece') }),
      call('store', 'extension.store-piece', {
        owner: output('owner', 'playerId'), piece: output('snapshot', 'snapshot'),
      }, { storageKey: 'kiljaedanPiece', ownerScopedStorageKey: 'kiljaedanPiecesByPlayerId' }),
    ], output('store', 'success'))
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('extension.store-piece')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = {
      kiljaedanPiece: { instanceId: 'existing', templateId: 'old' },
      kiljaedanPiecesByPlayerId: { other: { instanceId: 'other' } },
    }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(true)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
    expect(next.battle.extensions?.kiljaedanPiece).toEqual(initial.extensions.kiljaedanPiece)
    expect(next.battle.extensions?.kiljaedanPiecesByPlayerId).toEqual(expect.objectContaining({
      other: { instanceId: 'other' },
      'player-red': old.battle.extensions?.kiljaedanPiecesByPlayerId['player-red'],
    }))

    const invalidContextGraph: GameplayModuleGraph = graph([
      holder,
      snapshot,
      call('store', 'extension.store-piece', {
        owner: literal('__proto__'), piece: output('snapshot', 'snapshot'),
      }, { storageKey: 'kiljaedanPiece', ownerScopedStorageKey: 'kiljaedanPiecesByPlayerId' }),
    ], output('store', 'success'))
    const invalidInitial = makeState({ pieces: [sourcePiece()] })
    invalidInitial.extensions = { kiljaedanPiecesByPlayerId: { other: { instanceId: 'other' } } }
    const invalidResult = execute(invalidContextGraph, invalidInitial)
    expect(invalidResult.result).toBe(false)
    expect(invalidResult.battle.extensions).toEqual(invalidInitial.extensions)
  })

  it('appends integer Amaterasu records once per coordinate while preserving sibling records', () => {
    const holder = call('holder', 'ref.holder')
    const statements: GameplayCallStatement[] = [holder]
    const cells = cellList(statements, [[1, 1], [1, 1], [2, 1], [1.5, 2]])
    const source: GameplayModuleGraph = graph([
      ...statements,
      call('append', 'extension.append-cell-records', {
        source: output('holder', 'piece'), cells,
      }, { storageKey: 'amaterasuCells' }),
    ], output('append', 'added'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('extension.append-cell-records')
    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = {
      amaterasuCells: [
        { x: 1, y: 1, sourcePieceId: 'existing', ownerPlayerId: 'player-blue' },
        { x: 9, y: 9, sourcePieceId: 'other', ownerPlayerId: 'player-red' },
      ],
    }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
    expect(next.result).toBe(1)
    expect(next.battle.extensions?.amaterasuCells).toEqual([
      { x: 1, y: 1, sourcePieceId: 'existing', ownerPlayerId: 'player-blue' },
      { x: 9, y: 9, sourcePieceId: 'other', ownerPlayerId: 'player-red' },
      { x: 2, y: 1, sourcePieceId: 'source', ownerPlayerId: 'player-red' },
    ])
  })

  it('preserves ordered Shishio records and allows repeated coordinates', () => {
    const holder = call('holder', 'ref.holder')
    const statements: GameplayCallStatement[] = [holder]
    const cells = cellList(statements, [[1, 1], [1, 1], [1.5, 2]])
    const source: GameplayModuleGraph = graph([
      ...statements,
      call('append', 'extension.append-cell-records-ordered', {
        source: output('holder', 'piece'), cells,
      }, { key: 'shishioBurnTiles' }),
    ], output('append', 'added'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('extension.append-cell-records-ordered')
    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = { shishioBurnTiles: [{ x: 0, y: 0, sourcePieceId: 'old', ownerPlayerId: 'player-blue' }] }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
    expect(next.result).toBe(3)
    expect(next.battle.extensions?.shishioBurnTiles).toHaveLength(4)
  })

  it('maps piece counter compatibility state to typed per-piece extensions', () => {
    const holder = call('holder', 'ref.holder')
    const source: GameplayModuleGraph = graph([
      holder,
      call('write', 'state.write-piece-number', {
        piece: output('holder', 'piece'), value: literal(4),
      }, { namespace: 'muzan-flesh-regeneration', name: 'successfulHeals' }),
      call('read', 'state.read-piece-number', {
        piece: output('holder', 'piece'), fallback: literal(0),
      }, { namespace: 'muzan-flesh-regeneration', name: 'successfulHeals' }),
    ], output('read', 'value'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('state.write-piece-number')
    expect(JSON.stringify(migrated.body)).not.toContain('state.read-piece-number')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = {
      flowState: [{
        schemaVersion: 1, scope: 'piece', entityId: 'source', ownerPlayerId: 'player-red',
        namespace: 'muzan-flesh-regeneration', name: 'successfulHeals', value: 2,
        lifetime: 'battle', projectionVisibility: 'owner',
      }],
    }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(old.result).toBe(4)
    expect(next.result).toBe(old.result)
    type StateRecord = { name?: string; value?: unknown; ownerPlayerId?: string }
    const oldRecord = (old.battle.extensions?.flowState as StateRecord[] | undefined)?.find(record => record.name === 'successfulHeals')
    const nextRecord = (next.battle.extensions?.flowState as StateRecord[] | undefined)?.find(record => record.name === 'successfulHeals')
    expect(nextRecord?.value).toBe(oldRecord?.value)
    expect(nextRecord?.ownerPlayerId).toBe('player-red')
  })

  it('maps registered player counter paths to the root contentCounters extension', () => {
    const source: GameplayModuleGraph = graph([
      call('player-ref', 'ref.player'),
      call('player', 'query.player', { playerId: output('player-ref', 'player') }),
      call('write-direct', 'state.write-player-number', {
        player: output('player', 'player'), value: literal(7),
      }, { path: 'contentCounters' }),
      call('read-direct', 'state.read-player-number', {
        player: output('player', 'player'), fallback: literal(0),
      }, { path: 'contentCounters' }),
      call('write-nested', 'state.write-player-number', {
        player: output('player', 'player'), value: literal(3),
      }, { path: 'contentCounters.elPrimoChargeDiscount' }),
      call('read-nested', 'state.read-player-number', {
        player: output('player', 'player'), fallback: literal(0),
      }, { path: 'contentCounters.elPrimoChargeDiscount' }),
    ], output('read-nested', 'value'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('state.write-player-number')
    expect(JSON.stringify(migrated.body)).not.toContain('state.read-player-number')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = {
      contentCounters: {
        'player-blue': 11,
        elPrimoChargeDiscount: { 'player-blue': 5 },
      },
    }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(old.result).toBe(3)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions?.contentCounters).toEqual({
      'player-blue': 11,
      'player-red': 7,
      elPrimoChargeDiscount: { 'player-blue': 5, 'player-red': 3 },
    })
  })

  it('keeps a missing piece compatibility read side-effect free', () => {
    const holder = call('holder', 'ref.holder')
    const source: GameplayModuleGraph = graph([
      holder,
      call('read', 'state.read-piece-number', {
        piece: output('holder', 'piece'), fallback: literal(6),
      }, { namespace: 'muzan-flesh-regeneration', name: 'successfulHeals' }),
    ], output('read', 'value'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    const initial = makeState({ pieces: [sourcePiece()] })
    const next = execute(migrated, initial)

    expect(next.result).toBe(6)
    expect(next.battle.extensions).toEqual({})
  })

  it('keeps a missing player compatibility read side-effect free', () => {
    const source: GameplayModuleGraph = graph([
      call('player-ref', 'ref.player'),
      call('player', 'query.player', { playerId: output('player-ref', 'player') }),
      call('read', 'state.read-player-number', {
        player: output('player', 'player'), fallback: literal(9),
      }, { path: 'contentCounters.elPrimoChargeDiscount' }),
    ], output('read', 'value'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    const initial = makeState({ pieces: [sourcePiece()] })
    const next = execute(migrated, initial)

    expect(next.result).toBe(9)
    expect(next.battle.extensions).toEqual({})
  })

  it('leaves unregistered compatibility state paths for the legacy host', () => {
    const source: GameplayModuleGraph = graph([
      call('player-ref', 'ref.player'),
      call('player', 'query.player', { playerId: output('player-ref', 'player') }),
      call('read', 'state.read-player-number', {
        player: output('player', 'player'), fallback: literal(0),
      }, { path: 'contentCounters.mangekyoDeaths' }),
    ], output('read', 'value'), 'number')
    expect(migrateExtensionWriteModules(source).body).toEqual(source.body)
  })

  function cells(statements: GameplayCallStatement[], values: Array<[number, number]>, prefix: string) {
    let list: GameplayValue | undefined
    values.forEach(([x, y], index) => {
      const cell = `${prefix}-cell-${index}`
      const singleton = `${prefix}-singleton-${index}`
      statements.push(call(cell, 'spatial.cell', { x: literal(x), y: literal(y) }))
      statements.push(call(singleton, 'collection.singleton', { value: output(cell, 'cell') }, { valueType: 'cell' }))
      list = list === undefined
        ? output(singleton, 'items')
        : (() => {
          const joined = `${prefix}-list-${index}`
          statements.push(call(joined, 'collection.concat', {
            left: list as GameplayValue, right: output(singleton, 'items'),
          }, { valueType: JSON.stringify({ kind: 'list', element: 'cell' }) }))
          return output(joined, 'items')
        })()
    })
    return list ?? literal([])
  }

  it('migrates source cleanup without creating a missing tile-effects array', () => {
    const source: GameplayModuleGraph = graph([
      call('remove', 'tile.remove-source-records', { sourceId: literal('source') }),
    ], output('remove', 'success'))
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('tile.remove-source-records')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = {
      tileEffects: [
        { x: 1, y: 1, sourceId: 'source', tileType: 'amaterasu' },
        { x: 2, y: 1, sourceId: 'other', tileType: 'shishio-burn' },
      ],
    }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions).toEqual(old.battle.extensions)

    const absent = makeState({ pieces: [sourcePiece()] })
    const absentResult = execute(migrated, absent)
    expect(absentResult.result).toBe(false)
    expect(absentResult.battle.extensions).toEqual({})
  })

  it('migrates Amaterasu marker deduplication and preserves presentation fields', () => {
    const statements: GameplayCallStatement[] = []
    const cellList = cells(statements, [[1, 1], [1, 1], [2, 1], [1.5, 2]], 'dedup')
    statements.push(call('origin', 'spatial.cell', { x: literal(0), y: literal(0) }))
    const source: GameplayModuleGraph = graph([
      ...statements,
      call('append', 'tile.append-dedup-markers', {
        cells: cellList, origin: output('origin', 'cell'),
      }, { tileType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right', presentation: 'expand', presentationBatch: 'queue' }),
    ], output('append', 'added'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('tile.append-dedup-markers')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = {
      tileEffects: [
        { x: 1, y: 1, sourceId: 'amaterasu', tileType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right', presentation: 'expand', presentationStep: 1 },
        { x: 9, y: 9, sourceId: 'other', tileType: 'other' },
      ],
    }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
    expect(next.result).toBe(1)
    expect(next.battle.extensions?.tileEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 2, y: 1, tileType: 'amaterasu', presentation: 'expand', presentationStep: 2 }),
    ]))
  })

  it('migrates Shishio batch markers through the authoritative tile batch host', () => {
    const statements: GameplayCallStatement[] = []
    const cellList = cells(statements, [[1, 1], [2, 1]], 'batch')
    const source: GameplayModuleGraph = graph([
      ...statements,
      call('batch', 'tile.batch-effect-markers', { cells: cellList }, {
        sourceId: 'shishio-burn', tileType: 'shishio-burn', icon: '♨️', iconPosition: 'bottom-right',
      }),
    ], output('batch', 'count'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('tile.batch-effect-markers')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = { tileEffects: [{ x: 9, y: 9, sourceId: 'other', tileType: 'other' }] }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
    expect(next.result).toBe(2)
    expect(next.battle.extensions?.tileEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 1, y: 1, sourceId: 'shishio-burn', tileType: 'shishio-burn', presentation: 'simultaneous', presentationStep: 0 }),
    ]))
  })

  it('migrates extension cell removal atomically with matching tile effects', () => {
    const statements: GameplayCallStatement[] = []
    const cellList = cells(statements, [[1, 1]], 'remove')
    const source: GameplayModuleGraph = graph([
      ...statements,
      call('remove', 'extension.remove-cell-records', { cells: cellList }, {
        storageKey: 'amaterasuCells', tileType: 'amaterasu', presentationBatch: 'queue',
      }),
    ], output('remove', 'removed'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('extension.remove-cell-records')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = {
      amaterasuCells: [
        { x: 1, y: 1, sourcePieceId: 'source', ownerPlayerId: 'player-red' },
        { x: 2, y: 2, sourcePieceId: 'keep', ownerPlayerId: 'player-blue' },
      ],
      tileEffects: [
        { x: 1, y: 1, sourceId: 'amaterasu', tileType: 'amaterasu' },
        { x: 1, y: 1, sourceId: 'other', tileType: 'other' },
        { x: 2, y: 2, sourceId: 'amaterasu', tileType: 'amaterasu' },
      ],
    }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
    expect(next.result).toBe(1)
  })

  it('migrates the player follow-up counter without a second state source', () => {
    const source: GameplayModuleGraph = graph([
      call('player', 'ref.player'),
      call('increment', 'followup.counter.increment-player', { player: output('player', 'player') }, { counter: 'mangekyoDeaths' }),
    ], output('increment', 'next'), 'number')
    const migrated = migrateExtensionWriteModules(source)
    expect(JSON.stringify(migrated.body)).not.toContain('followup.counter.increment-player')

    const initial = makeState({ pieces: [sourcePiece()] })
    initial.extensions = { contentCounters: { mangekyoDeaths: { 'player-red': 2 } } }
    const old = execute(source, initial)
    const next = execute(migrated, initial)
    expect(next.result).toBe(old.result)
    expect(next.result).toBe(3)
    expect(next.battle.extensions).toEqual(old.battle.extensions)
  })
})
