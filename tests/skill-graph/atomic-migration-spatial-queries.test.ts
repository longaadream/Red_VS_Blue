import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import {
  ATOMIC_SPATIAL_QUERY_MODULES,
  atomicSpatialQueryRecipe,
  migrateSpatialQueryModules,
} from '../../lib/skill-graph/atomic-migration-spatial-queries'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

const nullablePiece = { kind: 'nullable', value: 'piece' } as const
const nullablePlayer = { kind: 'nullable', value: 'player' } as const
const nullableCell = { kind: 'nullable', value: 'cell' } as const
const cellList = { kind: 'list', element: 'cell' } as const
const pieceList = { kind: 'list', element: 'piece' } as const

const fixtures: readonly GameplayModuleDescriptor[] = [
  {
    id: 'test.target-piece', version: '1', label: 'target piece', inputs: [],
    outputs: [{ name: 'piece', type: 'piece' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.target' }),
  },
  {
    id: 'test.nullable-piece', version: '1', label: 'nullable piece', inputs: [],
    outputs: [{ name: 'piece', type: nullablePiece }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.source' }),
  },
  {
    id: 'test.owner', version: '1', label: 'owner', inputs: [],
    outputs: [{ name: 'player', type: nullablePlayer }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.owner' }),
  },
  {
    id: 'test.reference', version: '1', label: 'reference', inputs: [],
    outputs: [{ name: 'cell', type: nullableCell }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.reference' }),
  },
  {
    id: 'test.cell', version: '1', label: 'cell', inputs: [],
    outputs: [{ name: 'cell', type: nullableCell }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.cell' }),
  },
]

const registry: GameplayModuleRegistry = {
  get: (id, version) => fixtures.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id, version) => fixtures.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...fixtures],
}

type Piece = {
  instanceId: string
  ownerPlayerId: string
  templateId: string
  faction: string
  x: number
  y: number
  currentHp: number
}

type Player = { playerId: string; faction: string }
type Tile = { x: number; y: number; props: { walkable: boolean; type?: string } }
type State = { pieces: Piece[]; players: Player[]; map: { tiles: Tile[] } }

function runtime(state: State, draws: { count: number }) {
  const piece = (id: unknown): Piece | null => typeof id === 'string' ? state.pieces.find(item => item.instanceId === id) ?? null : null
  const player = (id: unknown): Player | null => typeof id === 'string' ? state.players.find(item => item.playerId === id) ?? null : null
  const holder = 'source'
  const allied = (left: string, right: string): boolean => {
    const leftPlayer = player(left), rightPlayer = player(right)
    return Boolean(leftPlayer && rightPlayer && leftPlayer.faction === rightPlayer.faction)
  }
  const flow = {
    query: {
      piece,
      hasPiece: (id: unknown) => piece(id) !== null,
      player,
      hasPlayer: (id: unknown) => player(id) !== null,
      pieceText: (id: unknown, field: string) => {
        const value = piece(id)
        return value && typeof value[field as keyof Piece] === 'string' ? value[field as keyof Piece] : ''
      },
      playerText: () => '',
      pieces: (options: { ownerId?: string | null; relation?: 'ally' | 'enemy'; originId?: string | null; includeDead?: boolean } = {}) => {
        const origin = options.originId ? piece(options.originId) : piece(holder)
        const owner = options.ownerId || origin?.ownerPlayerId
        if (options.relation && !owner) throw new Error('flow: relation requires owner')
        return state.pieces.filter(candidate =>
          (options.includeDead || candidate.currentHp > 0)
          && (!options.ownerId || options.relation || candidate.ownerPlayerId === options.ownerId)
          && (!options.relation || (options.relation === 'ally' ? allied(candidate.ownerPlayerId, owner!) : !allied(candidate.ownerPlayerId, owner!)))
        ).map(candidate => candidate.instanceId)
      },
      random: <T>(items: readonly T[]): T | null => {
        if (!items.length) return null
        draws.count += 1
        return items[items.length - 1]
      },
    },
  }
  return { flow, battle: state }
}

type QueryId =
  | 'spatial.walkable-cells'
  | 'spatial.nearest-adjacent-landing'
  | 'spatial.random-adjacent-landing'
  | 'marker.anchor-candidates'
  | 'marker.nearby-enemies'
  | 'query.living-template'
  | 'query.living-template-faction'
  | 'piece.by-template'
  | 'spatial.cell-terrain-in'

function graphFor(module: QueryId): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  let resultPort: string
  let outputType: typeof cellList | typeof pieceList | typeof nullableCell | typeof nullablePiece | 'boolean'
  const add = (id: string, fixture: string, port: string) => {
    body.push(call(id, fixture))
    return output(id, port)
  }
  switch (module) {
    case 'spatial.walkable-cells':
      body.push(call('result', module)); resultPort = 'cells'; outputType = cellList; break
    case 'spatial.nearest-adjacent-landing': {
      const target = add('target', 'test.target-piece', 'piece')
      const reference = add('reference', 'test.reference', 'cell')
      body.push(call('result', module, { target, reference }, { diagonal: true })); resultPort = 'cell'; outputType = nullableCell; break
    }
    case 'spatial.random-adjacent-landing': {
      const target = add('target', 'test.target-piece', 'piece')
      body.push(call('result', module, { target }, {})); resultPort = 'cell'; outputType = nullableCell; break
    }
    case 'marker.anchor-candidates': {
      const source = add('source', 'test.nullable-piece', 'piece')
      body.push(call('result', module, { source }, { range: 3, order: 'yx' })); resultPort = 'cells'; outputType = cellList; break
    }
    case 'marker.nearby-enemies': {
      const source = add('source', 'test.nullable-piece', 'piece')
      const cell = add('cell', 'test.cell', 'cell')
      body.push(call('result', module, { source, cell }, { range: 2 })); resultPort = 'pieces'; outputType = pieceList; break
    }
    case 'query.living-template': {
      const owner = add('owner', 'test.owner', 'player')
      body.push(call('result', module, { owner }, { templateId: 'wolf' })); resultPort = 'piece'; outputType = nullablePiece; break
    }
    case 'query.living-template-faction': {
      const target = add('target', 'test.nullable-piece', 'piece')
      body.push(call('result', module, { target }, { templateId: 'wolf' })); resultPort = 'piece'; outputType = nullablePiece; break
    }
    case 'piece.by-template': {
      const owner = add('owner', 'test.owner', 'player')
      body.push(call('result', module, { owner }, { templateId: 'wolf', alive: true })); resultPort = 'piece'; outputType = nullablePiece; break
    }
    case 'spatial.cell-terrain-in': {
      const cell = add('cell', 'test.cell', 'cell')
      body.push(call('result', module, { cell }, { types: ['floor', 'cover'] })); resultPort = 'value'; outputType = 'boolean'; break
    }
  }
  body.push({ kind: 'return', id: 'done', value: output('result', resultPort!) })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs: [{ name: 'value', type: outputType! }] }
}

function execute(graph: GameplayModuleGraph, state: State, context: Record<string, unknown>, draws: { count: number }): unknown {
  const compiled = compileGameplayModuleGraph(graph, registry)
  const run = runInNewContext('(' + compiled.code + ')', runtime(state, draws)) as (value: unknown) => unknown
  return run(context)
}

function board(): State {
  return {
    players: [
      { playerId: 'red', faction: 'red' },
      { playerId: 'red-ally', faction: 'red' },
      { playerId: 'blue', faction: 'blue' },
    ],
    pieces: [
      { instanceId: 'source', ownerPlayerId: 'red', templateId: 'source', faction: 'red', x: 2, y: 2, currentHp: 10 },
      { instanceId: 'red-wolf', ownerPlayerId: 'red', templateId: 'wolf', faction: 'red', x: 0, y: 0, currentHp: 4 },
      { instanceId: 'ally-wolf', ownerPlayerId: 'red-ally', templateId: 'wolf', faction: 'red', x: 1, y: 0, currentHp: 4 },
      { instanceId: 'dead-wolf', ownerPlayerId: 'blue', templateId: 'wolf', faction: 'blue', x: 4, y: 4, currentHp: 0 },
      { instanceId: 'blue-wolf', ownerPlayerId: 'blue', templateId: 'wolf', faction: 'blue', x: 3, y: 2, currentHp: 4 },
      { instanceId: 'blue-cat', ownerPlayerId: 'blue', templateId: 'cat', faction: 'blue', x: 3, y: 3, currentHp: 4 },
    ],
    map: { tiles: [
      { x: 3, y: 1, props: { walkable: true } },
      { x: 0, y: 0, props: { walkable: false } },
      { x: 2, y: 2, props: { walkable: true } },
      { x: 1, y: 0, props: { walkable: true } },
      { x: 0, y: 1, props: { walkable: true } },
      { x: 3, y: 2, props: { walkable: true } },
      { x: 4, y: 4, props: { walkable: true } },
      { x: 2, y: 1, props: { walkable: true } },
      { x: 1, y: 2, props: { walkable: true } },
      { x: 3, y: 3, props: { walkable: true } },
      { x: 2, y: 3, props: { walkable: true } },
    ] },
  }
}

describe('atomic spatial and template query migrations', () => {
  it('retires every compatibility wrapper and is idempotent', () => {
    for (const moduleId of ATOMIC_SPATIAL_QUERY_MODULES) {
      const migrated = migrateSpatialQueryModules(graphFor(moduleId as QueryId))
      const calls: GameplayCallStatement[] = []
      const visit = (statements: readonly GameplayStatement[]): void => statements.forEach(statement => {
        if (statement.kind === 'call') calls.push(statement)
        if (statement.kind === 'collection' || statement.kind === 'foreach' || statement.kind === 'while') visit(statement.body)
        if (statement.kind === 'if') { visit(statement.then); if (statement.else) visit(statement.else) }
      })
      visit(migrated.body)
      expect(calls.some(statement => ATOMIC_SPATIAL_QUERY_MODULES.has(statement.module))).toBe(false)
      expect(rewriteAtomicGraph(migrated, atomicSpatialQueryRecipe)).toEqual(migrated)
    }
  })

  it('keeps walkable sorting, nearest tie order, and nullable reference behavior', () => {
    const state = board()
    const walkable = graphFor('spatial.walkable-cells')
    expect(execute(migrateSpatialQueryModules(walkable), state, {}, { count: 0 })).toEqual(execute(walkable, state, {}, { count: 0 }))

    const nearest = graphFor('spatial.nearest-adjacent-landing')
    const context = { target: 'source', reference: { x: 4, y: 4 } }
    expect(execute(migrateSpatialQueryModules(nearest), state, context, { count: 0 })).toEqual(execute(nearest, state, context, { count: 0 }))
    expect(execute(migrateSpatialQueryModules(nearest), state, { target: 'source', reference: null }, { count: 0 })).toBeNull()
  })

  it('keeps random candidate order, reserved/occupied filtering, and empty no-draw behavior', () => {
    const state = board()
    const graph = graphFor('spatial.random-adjacent-landing')
    const context = { target: 'source', reservedCells: [{ x: 3, y: 2 }] }
    const oldDraws = { count: 0 }, newDraws = { count: 0 }
    expect(execute(migrateSpatialQueryModules(graph), state, context, newDraws)).toEqual(execute(graph, state, context, oldDraws))
    expect(newDraws.count).toBe(oldDraws.count)
    const empty = { target: 'source', reservedCells: [{ x: 3, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 1 }, { x: 2, y: 3 }] }
    const draws = { count: 0 }
    expect(execute(migrateSpatialQueryModules(graph), state, empty, draws)).toBeNull()
    expect(draws.count).toBe(0)
  })

  it('keeps terrain membership and missing-tile behavior through the generic cell field', () => {
    const state = board()
    for (const tile of state.map.tiles) tile.props = { ...tile.props, type: tile.x === 2 && tile.y === 2 ? 'cover' : 'wall' }
    const graph = graphFor('spatial.cell-terrain-in')
    for (const cell of [{ x: 2, y: 2 }, { x: 3, y: 1 }, { x: 99, y: 99 }]) {
      const context = { cell }
      const oldValue = execute(graph, state, context, { count: 0 })
      const newValue = execute(migrateSpatialQueryModules(graph), state, context, { count: 0 })
      expect(newValue).toEqual(oldValue)
    }
    expect(execute(migrateSpatialQueryModules(graph), state, { cell: { x: 2, y: 2 } }, { count: 0 })).toBe(true)
    expect(execute(migrateSpatialQueryModules(graph), state, { cell: { x: 3, y: 1 } }, { count: 0 })).toBe(false)
    expect(execute(migrateSpatialQueryModules(graph), state, { cell: { x: 99, y: 99 } }, { count: 0 })).toBe(false)
  })

  it('keeps anchor ordering and null source, nearby enemy range, and template ownership rules', () => {
    const state = board()
    const anchor = graphFor('marker.anchor-candidates')
    expect(execute(migrateSpatialQueryModules(anchor), state, { source: 'source' }, { count: 0 })).toEqual(execute(anchor, state, { source: 'source' }, { count: 0 }))
    expect(execute(migrateSpatialQueryModules(anchor), state, { source: null }, { count: 0 })).toEqual([])

    const nearby = graphFor('marker.nearby-enemies')
    const nearbyContext = { source: 'source', cell: { x: 2, y: 2 } }
    expect(execute(migrateSpatialQueryModules(nearby), state, nearbyContext, { count: 0 })).toEqual(execute(nearby, state, nearbyContext, { count: 0 }))
    expect(execute(migrateSpatialQueryModules(nearby), state, { source: 'source', cell: null }, { count: 0 })).toEqual([])

    const living = graphFor('query.living-template')
    expect(execute(migrateSpatialQueryModules(living), state, { owner: 'red' }, { count: 0 })).toBe(execute(living, state, { owner: 'red' }, { count: 0 }))
    const faction = graphFor('query.living-template-faction')
    expect(execute(migrateSpatialQueryModules(faction), state, { source: 'blue-wolf' }, { count: 0 })).toBe(execute(faction, state, { source: 'blue-wolf' }, { count: 0 }))
    const byTemplate = graphFor('piece.by-template')
    expect(execute(migrateSpatialQueryModules(byTemplate), state, { owner: null }, { count: 0 })).toBe(execute(byTemplate, state, { owner: null }, { count: 0 }))
  })
})
