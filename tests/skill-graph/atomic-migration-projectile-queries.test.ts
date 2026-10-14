/* eslint-disable @typescript-eslint/no-explicit-any -- graph fixtures intentionally use the minimal battle shape. */
import { runInThisContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import {
  ATOMIC_PROJECTILE_QUERY_MODULES,
  migrateProjectileQueryModules,
} from '../../lib/skill-graph/atomic-migration-projectile-queries'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayPort,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function fixture(
  id: string,
  outputName: string,
  type: GameplayPort['type'],
  expression: string,
): GameplayModuleDescriptor {
  return {
    id,
    version: '1',
    label: id,
    inputs: [],
    outputs: [{ name: outputName, type }],
    allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true },
    lower: () => expression,
  }
}

const fixtures: readonly GameplayModuleDescriptor[] = [
  fixture('test.piece', 'piece', 'piece', 'context.piece'),
  fixture('test.target', 'cell', 'cell', 'context.target'),
  fixture('test.direction', 'cell', 'cell', 'context.direction'),
  fixture('test.events', 'events', { kind: 'list', element: 'event' }, 'context.events'),
  fixture('test.cells', 'cells', { kind: 'list', element: 'cell' }, 'context.cells'),
  fixture('test.index', 'index', 'number', 'context.index'),
  fixture('test.owner', 'owner', { kind: 'nullable', value: 'player' }, 'context.owner'),
  fixture('test.source-id', 'sourceId', 'string', 'context.sourceId'),
  fixture('test.excluded', 'excluded', { kind: 'list', element: 'string' }, 'context.excluded'),
  fixture('test.range', 'range', 'number', 'context.range'),
]

function registry(): GameplayModuleRegistry {
  const descriptors = [
    ...GAMEPLAY_MODULE_REGISTRY.descriptors,
    ...fixtures,
  ]
  const local = new Map(descriptors.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor] as const))
  return {
    get: (id, version) => local.get(id + '@' + (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
    resolve: (id, version) => local.get(id + '@' + (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
    descriptors,
  }
}

function graph(setup: readonly GameplayCallStatement[], statement: GameplayCallStatement, outputPort: string, outputType: GameplayPort['type']): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      ...setup,
      statement,
      { kind: 'return', id: 'done', values: { value: output(statement.id, outputPort) } },
    ],
    outputs: [{ name: 'value', type: outputType }],
  }
}

function multiGraph(
  setup: readonly GameplayCallStatement[],
  statement: GameplayCallStatement,
  outputs: Readonly<Record<string, { port: string; type: GameplayPort['type'] }>>,
): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      ...setup,
      statement,
      { kind: 'return', id: 'done', values: Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, output(statement.id, value.port)])) },
    ],
    outputs: Object.entries(outputs).map(([name, value]) => ({ name, type: value.type })),
  }
}

function callsIn(statements: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  for (const statement of statements) {
    if (statement.kind === 'call') result.push(statement)
    if (statement.kind === 'if') {
      result.push(...callsIn(statement.then))
      if (statement.else) result.push(...callsIn(statement.else))
    } else if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'while') {
      result.push(...callsIn(statement.body))
      if (statement.kind === 'while') result.push(...callsIn(statement.condition.body))
    }
  }
  return result
}

function execute(source: GameplayModuleGraph, battle: any, context: Record<string, unknown>, seed = 252): unknown {
  const compiled = compileGameplayModuleGraph(migrateProjectileQueryModules(source), registry())
  const flow = createFlowRuntime(battle, {}, 'skill', {})
  const factory = runInThisContext(`(function(battle,flow){return (${compiled.code})})`) as (battle: unknown, flow: unknown) => (context: unknown) => unknown
  return withRuleRuntime(new RuleRuntime({ rootSeed: seed, tick: 1 }), () => factory(battle, flow)(context))
}

function executeLegacy(source: GameplayModuleGraph, battle: any, context: Record<string, unknown>, seed = 252): unknown {
  const compiled = compileGameplayModuleGraph(source, registry())
  const flow = createFlowRuntime(battle, {}, 'skill', {})
  const factory = runInThisContext(`(function(battle,flow){return (${compiled.code})})`) as (battle: unknown, flow: unknown) => (context: unknown) => unknown
  return withRuleRuntime(new RuleRuntime({ rootSeed: seed, tick: 1 }), () => factory(battle, flow)(context))
}

describe('atomic projectile/query migrations', () => {
  it('expands every selected compatibility module and is idempotent', () => {
    const cases: GameplayModuleGraph[] = [
      graph([call('piece', 'test.piece'), call('target', 'test.target')], call('trace', 'projectile.trace-enemies', { source: output('piece', 'piece'), target: output('target', 'cell') }), 'pieces', { kind: 'list', element: 'piece' }),
      graph([call('piece', 'test.piece'), call('cells', 'test.cells')], call('faction', 'query.faction-enemies-on-cells', { source: output('piece', 'piece'), cells: output('cells', 'cells') }), 'pieces', { kind: 'list', element: 'piece' }),
      graph([call('cells', 'test.cells'), call('index', 'test.index')], call('index-query', 'query.enemies-on-index', { cells: output('cells', 'cells'), index: output('index', 'index') }), 'pieces', { kind: 'list', element: 'piece' }),
      graph([call('piece', 'test.piece')], call('landing', 'spatial.random-cardinal-landing', { target: output('piece', 'piece') }), 'cell', { kind: 'nullable', value: 'cell' }),
      graph([call('piece', 'test.piece'), call('events', 'test.events')], call('first', 'movement.first-piece-on-trace', { source: output('piece', 'piece'), events: output('events', 'events') }), 'present', 'boolean'),
      graph([call('source-id', 'test.source-id'), call('excluded', 'test.excluded'), call('range', 'test.range')], call('bounce', 'movement.bounce-candidates', { sourceId: output('source-id', 'sourceId'), excluded: output('excluded', 'excluded'), range: output('range', 'range') }), 'pieces', { kind: 'list', element: 'piece' }),
      graph([call('piece', 'test.piece'), call('direction', 'test.direction')], call('first-enemy', 'projectile.first-enemy-on-path', { source: output('piece', 'piece'), direction: output('direction', 'cell') }), 'target', { kind: 'nullable', value: 'piece' }),
      graph([call('piece', 'test.piece')], call('shuffle', 'spatial.shuffle-cardinal-cells', { target: output('piece', 'piece') }), 'cells', { kind: 'list', element: 'cell' }),
      graph([call('origin', 'test.target'), call('direction', 'test.direction')], call('bounded', 'projectile.events-from-cell-bounded', { origin: output('origin', 'cell'), direction: output('direction', 'cell') }), 'events', { kind: 'list', element: 'event' }),
      multiGraph([call('piece', 'test.piece'), call('target', 'test.target')], call('blocker', 'projectile.trace-until-blocker', { source: output('piece', 'piece'), target: output('target', 'cell') }), {
        enemyPieces: { port: 'enemyPieces', type: { kind: 'list', element: 'piece' } },
        firstCell: { port: 'firstCell', type: { kind: 'nullable', value: 'cell' } },
        valid: { port: 'valid', type: 'boolean' },
        sameCell: { port: 'sameCell', type: 'boolean' },
        distance: { port: 'distance', type: 'number' },
      }),
    ]
    for (const source of cases) {
      const migrated = migrateProjectileQueryModules(source)
      expect(callsIn(migrated.body).map(item => item.module)).not.toEqual(expect.arrayContaining([...ATOMIC_PROJECTILE_QUERY_MODULES]))
      expect(migrateProjectileQueryModules(migrated)).toEqual(migrated)
      expect(() => compileGameplayModuleGraph(migrated, registry())).not.toThrow()
    }
  })

  it('preserves trace enemy ordering and unrestricted terrain traversal', () => {
    const sourcePiece = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 2, y: 1 })
    const enemyA = makePiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1 })
    const enemyB = makePiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1 })
    const battle = makeState({ pieces: [sourcePiece, ally, enemyA, enemyB], width: 6, height: 3 }) as any
    battle.map.tiles.find((tile: any) => tile.x === 2 && tile.y === 1).props.walkable = false
    const source = graph([call('piece', 'test.piece'), call('target', 'test.target')], call('trace', 'projectile.trace-enemies', { source: output('piece', 'piece'), target: output('target', 'cell') }), 'pieces', { kind: 'list', element: 'piece' })
    const context = { piece: 'source', target: { x: 5, y: 1 } }
    expect(execute(source, battle, context)).toEqual(executeLegacy(source, battle, context))
    expect(execute(source, battle, context)).toEqual({ value: ['enemy-a', 'enemy-b'] })
  })

  it('keeps raw faction and owner-precedence index queries', () => {
    const sourcePiece = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    const sameRaw = makePiece({ instanceId: 'same', ownerPlayerId: 'player-blue', x: 2, y: 0 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 0 }) as any
    sourcePiece.faction = 'custom-red'
    sameRaw.faction = 'custom-red'
    enemy.faction = 'custom-blue'
    const battle = makeState({ pieces: [sourcePiece, sameRaw, enemy], width: 5, height: 2 }) as any
    const cells = [{ x: 2, y: 0 }, { x: 3, y: 0 }]
    const faction = graph([call('piece', 'test.piece'), call('cells', 'test.cells')], call('faction', 'query.faction-enemies-on-cells', { source: output('piece', 'piece'), cells: output('cells', 'cells') }), 'pieces', { kind: 'list', element: 'piece' })
    expect(execute(faction, battle, { piece: 'source', cells })).toEqual({ value: ['enemy'] })

    const index = graph([
      call('piece', 'test.piece'),
      call('cells', 'test.cells'),
      call('index', 'test.index'),
      call('owner', 'test.owner'),
    ], call('index-query', 'query.enemies-on-index', {
      source: output('piece', 'piece'), owner: output('owner', 'owner'), cells: output('cells', 'cells'), index: output('index', 'index'),
    }), 'pieces', { kind: 'list', element: 'piece' })
    expect(execute(index, battle, { piece: 'source', owner: 'player-red', cells, index: 1 })).toEqual({ value: ['enemy'] })
    expect(execute(index, battle, { piece: 'source', owner: 'player-red', cells, index: 99 })).toEqual({ value: [] })
  })

  it('matches landing and shuffle RNG behavior while filtering cells in the graph', () => {
    const target = makePiece({ instanceId: 'target', x: 2, y: 2 })
    const blocker = makePiece({ instanceId: 'blocker', x: 3, y: 2 })
    const battle = makeState({ pieces: [target, blocker], width: 5, height: 5 }) as any
    const landing = graph([call('piece', 'test.piece')], call('landing', 'spatial.random-cardinal-landing', { target: output('piece', 'piece') }), 'cell', { kind: 'nullable', value: 'cell' })
    const shuffle = graph([call('piece', 'test.piece')], call('shuffle', 'spatial.shuffle-cardinal-cells', { target: output('piece', 'piece') }), 'cells', { kind: 'list', element: 'cell' })
    expect(execute(landing, battle, { piece: 'target' }, 99)).toEqual(executeLegacy(landing, battle, { piece: 'target' }, 99))
    expect(execute(shuffle, battle, { piece: 'target' }, 99)).toEqual(executeLegacy(shuffle, battle, { piece: 'target' }, 99))
  })

  it('selects the first obstruction and first enemy without fabricating dead references', () => {
    const sourcePiece = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 2, y: 1 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1 })
    const battle = makeState({ pieces: [sourcePiece, ally, enemy], width: 5, height: 3 }) as any
    const events = [
      { type: 'piece', piece: { instanceId: 'ally' }, x: 2, y: 1, distance: 1 },
      { type: 'piece', piece: { instanceId: 'enemy' }, x: 3, y: 1, distance: 2 },
    ]
    const first = graph([call('piece', 'test.piece'), call('events', 'test.events')], call('first', 'movement.first-piece-on-trace', { source: output('piece', 'piece'), events: output('events', 'events') }), 'present', 'boolean')
    expect(execute(first, battle, { piece: 'source', events })).toEqual(executeLegacy(first, battle, { piece: 'source', events }))
    expect(execute(first, battle, { piece: 'source', events })).toEqual({ value: true })

    const firstEnemy = graph([call('piece', 'test.piece'), call('direction', 'test.direction')], call('first-enemy', 'projectile.first-enemy-on-path', { source: output('piece', 'piece'), direction: output('direction', 'cell') }), 'target', { kind: 'nullable', value: 'piece' })
    expect(execute(firstEnemy, battle, { piece: 'source', direction: { x: 1, y: 0 } })).toEqual({ value: null })
  })

  it('preserves bounce candidates and invalid index/source behavior', () => {
    const sourcePiece = makePiece({ instanceId: 'source', x: 1, y: 1, ownerPlayerId: 'player-red', faction: 'red' })
    const near = makePiece({ instanceId: 'near', x: 2, y: 1, ownerPlayerId: 'player-blue', faction: 'blue' })
    const far = makePiece({ instanceId: 'far', x: 4, y: 1, ownerPlayerId: 'player-blue', faction: 'blue' })
    const battle = makeState({ pieces: [sourcePiece, near, far], width: 6, height: 3 }) as any
    const bounce = graph([call('source-id', 'test.source-id'), call('excluded', 'test.excluded'), call('range', 'test.range')], call('bounce', 'movement.bounce-candidates', { sourceId: output('source-id', 'sourceId'), excluded: output('excluded', 'excluded'), range: output('range', 'range') }), 'pieces', { kind: 'list', element: 'piece' })
    expect(execute(bounce, battle, { sourceId: 'source', excluded: [], range: 2 })).toEqual(executeLegacy(bounce, battle, { sourceId: 'source', excluded: [], range: 2 }))
    expect(execute(bounce, battle, { sourceId: 'missing', excluded: [], range: 2 })).toEqual({ value: [] })
    expect(execute(bounce, battle, { sourceId: 'source', excluded: ['near'], range: 2 })).toEqual({ value: [] })

    const deadSource = makePiece({ instanceId: 'dead-source', currentHp: 0, x: 1, y: 1, ownerPlayerId: 'player-red', faction: 'red' })
    const liveEnemy = makePiece({ instanceId: 'live-enemy', x: 2, y: 1, ownerPlayerId: 'player-blue', faction: 'blue' })
    const deadSourceBattle = makeState({ pieces: [deadSource, liveEnemy], width: 6, height: 3 }) as any
    const deadSourceContext = { sourceId: 'dead-source', excluded: [], range: 2 }
    expect(execute(bounce, deadSourceBattle, deadSourceContext)).toEqual(executeLegacy(bounce, deadSourceBattle, deadSourceContext))
    expect(execute(bounce, deadSourceBattle, deadSourceContext)).toEqual({ value: ['live-enemy'] })
  })

  it('keeps canonical piece-by-id results as opaque IDs for downstream consumers', () => {
    const source = graph(
      [call('source-id', 'test.source-id')],
      call('resolved', 'query.piece-by-id', { id: output('source-id', 'sourceId') }),
      'piece',
      { kind: 'nullable', value: 'piece' },
    )
    const battle = makeState({ pieces: [makePiece({ instanceId: 'source' })] }) as any

    expect(execute(source, battle, { sourceId: 'source' })).toEqual({ value: 'source' })
    expect(execute(source, battle, { sourceId: 'missing' })).toEqual({ value: null })
  })

  it('truncates bounded path events at and including the first blocking fact', () => {
    const battle = makeState({ width: 6, height: 3 }) as any
    const blocked = battle.map.tiles.find((tile: any) => tile.x === 3 && tile.y === 1)
    blocked.props.type = 'wall'
    blocked.props.walkable = false
    const source = graph(
      [call('origin', 'test.target'), call('direction', 'test.direction')],
      call('bounded', 'projectile.events-from-cell-bounded', { origin: output('origin', 'cell'), direction: output('direction', 'cell') }, { maxDistance: 8 }),
      'events', { kind: 'list', element: 'event' },
    )
    const context = { target: { x: 1, y: 1 }, direction: { x: 1, y: 0 } }
    expect(execute(source, battle, context)).toEqual(executeLegacy(source, battle, context))
    const clipped = execute(source, battle, context) as { value: Array<{ type: string; x: number; y: number }> }
    expect(clipped.value.at(-1)).toMatchObject({ type: 'terrain', x: 3, y: 1 })
    expect(clipped.value.some(event => event.x > 3)).toBe(false)

    const unrestricted = graph(
      [call('origin', 'test.target'), call('direction', 'test.direction')],
      call('bounded', 'projectile.events-from-cell-bounded', { origin: output('origin', 'cell'), direction: output('direction', 'cell') }, { maxDistance: 8, stopAtBlockingTerrain: false }),
      'events', { kind: 'list', element: 'event' },
    )
    expect(execute(unrestricted, battle, context)).toEqual(executeLegacy(unrestricted, battle, context))
    expect((execute(unrestricted, battle, context) as { value: unknown[] }).value.length).toBeGreaterThan(clipped.value.length)
  })

  it('preserves blocker stopping, enemy order, first cell, and validity aggregates', () => {
    const sourcePiece = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 })
    const enemyA = makePiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1 })
    const enemyB = makePiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1 })
    const battle = makeState({ pieces: [sourcePiece, enemyA, enemyB], width: 6, height: 3 }) as any
    const sourceGraph = multiGraph(
      [call('piece', 'test.piece'), call('target', 'test.target')],
      call('blocker', 'projectile.trace-until-blocker', { source: output('piece', 'piece'), target: output('target', 'cell') }, { maxDistance: 99 }),
      {
        enemyPieces: { port: 'enemyPieces', type: { kind: 'list', element: 'piece' } },
        firstCell: { port: 'firstCell', type: { kind: 'nullable', value: 'cell' } },
        valid: { port: 'valid', type: 'boolean' },
        sameCell: { port: 'sameCell', type: 'boolean' },
        distance: { port: 'distance', type: 'number' },
      },
    )
    const context = { piece: 'source', target: { x: 5, y: 1 } }
    expect(execute(sourceGraph, battle, context)).toEqual(executeLegacy(sourceGraph, battle, context))
    expect(execute(sourceGraph, battle, context)).toEqual({
      enemyPieces: ['enemy-a', 'enemy-b'], firstCell: { x: 2, y: 1 }, valid: true, sameCell: false, distance: 4,
    })

    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 2, y: 1 })
    const blockedBattle = makeState({ pieces: [sourcePiece, ally, enemyA], width: 6, height: 3 }) as any
    expect(execute(sourceGraph, blockedBattle, context)).toEqual(executeLegacy(sourceGraph, blockedBattle, context))
    expect(execute(sourceGraph, blockedBattle, context)).toMatchObject({ enemyPieces: [], firstCell: null, valid: true, sameCell: false, distance: 4 })

    const wallBattle = makeState({ pieces: [sourcePiece, enemyA, enemyB], width: 6, height: 3 }) as any
    const wall = wallBattle.map.tiles.find((tile: any) => tile.x === 3 && tile.y === 1)
    wall.props = { ...wall.props, walkable: false, bulletPassable: false }
    enemyB.x = 4
    expect(execute(sourceGraph, wallBattle, context)).toEqual(executeLegacy(sourceGraph, wallBattle, context))
    expect(execute(sourceGraph, wallBattle, context)).toMatchObject({ enemyPieces: ['enemy-a'] })

    expect(execute(sourceGraph, battle, { piece: 'missing', target: { x: 5, y: 1 } })).toEqual({
      enemyPieces: [], firstCell: null, valid: false, sameCell: false, distance: 0,
    })
  })
})
