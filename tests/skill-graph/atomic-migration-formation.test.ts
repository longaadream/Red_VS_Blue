import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import {
  ATOMIC_FORMATION_MODULES,
  atomicFormationRecipe,
  migrateFormationModules,
} from '../../lib/skill-graph/atomic-migration-formation'
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

const fixtures: readonly GameplayModuleDescriptor[] = [
  {
    id: 'test.formation-source', version: '1', label: 'formation source', inputs: [],
    outputs: [{ name: 'piece', type: 'piece' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.source' }),
  },
  {
    id: 'test.formation-selected', version: '1', label: 'formation selected', inputs: [],
    outputs: [{ name: 'pieces', type: { kind: 'list', element: 'piece' } }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.selected' }),
  },
  {
    id: 'test.formation-center', version: '1', label: 'formation center', inputs: [],
    outputs: [{ name: 'cell', type: 'cell' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: 'context.center' }),
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
  x: number
  y: number
  currentHp: number
  isCore: boolean
}

type FormationState = {
  pieces: Piece[]
  map: { tiles: Array<{ x: number; y: number; props: { walkable: boolean } }> }
}

function runtime(state: FormationState) {
  const piece = (id: unknown): Piece | null => typeof id === 'string' ? state.pieces.find(item => item.instanceId === id) ?? null : null
  const flow = {
    query: {
      piece,
      hasPiece: (id: unknown) => piece(id) !== null,
      pieces: (options: { originId?: string; relation?: 'ally' | 'enemy'; includeDead?: boolean } = {}) => {
        const origin = options.originId === undefined ? null : piece(options.originId)
        return state.pieces.filter(item => {
          if (!options.includeDead && item.currentHp <= 0) return false
          if (!options.relation) return true
          if (!origin) return false
          const ally = item.ownerPlayerId === origin.ownerPlayerId
          return options.relation === 'ally' ? ally : !ally
        }).map(item => item.instanceId)
      },
      pieceText: () => '',
    },
  }
  return { flow, battle: state }
}

function graphFor(module: 'spatial.formation-selection-valid' | 'spatial.formation-candidates' | 'spatial.formation-slots'): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  if (module !== 'spatial.formation-slots') {
    body.push(call('source', 'test.formation-source'))
    body.push(call('selected', 'test.formation-selected'))
    body.push(call('result', module, {
      source: output('source', 'piece'), selected: output('selected', 'pieces'),
    }, module === 'spatial.formation-candidates' ? { range: 3 } : {}))
    body.push({ kind: 'return', id: 'done', value: output('result', module === 'spatial.formation-candidates' ? 'cells' : 'value') })
  } else {
    body.push(call('center', 'test.formation-center'))
    body.push(call('selected', 'test.formation-selected'))
    body.push(call('result', module, { center: output('center', 'cell'), selected: output('selected', 'pieces') }))
    body.push({ kind: 'return', id: 'done', value: output('result', 'cells') })
  }
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs: [{ name: 'value', type: module === 'spatial.formation-selection-valid' ? 'boolean' : { kind: 'list', element: 'cell' } }] }
}

function execute(graph: GameplayModuleGraph, state: FormationState, context: { source: string; selected: string[]; center?: { x: number; y: number } }): unknown {
  const compiled = compileGameplayModuleGraph(graph, registry)
  const run = runInNewContext('(' + compiled.code + ')', runtime(state)) as (value: unknown) => unknown
  return run(context)
}

function board(width = 5, height = 5): FormationState {
  return {
    pieces: [],
    map: { tiles: Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), props: { walkable: true } })) },
  }
}

describe('atomic formation migrations', () => {
  it('retires all three native formation helpers and is idempotent', () => {
    for (const moduleId of ATOMIC_FORMATION_MODULES) {
      const migrated = migrateFormationModules(graphFor(moduleId as 'spatial.formation-selection-valid' | 'spatial.formation-candidates' | 'spatial.formation-slots'))
      const calls: GameplayCallStatement[] = []
      const visit = (statements: readonly GameplayStatement[]): void => statements.forEach(statement => {
        if (statement.kind === 'call') calls.push(statement)
        if (statement.kind === 'collection' || statement.kind === 'foreach' || statement.kind === 'while') visit(statement.body)
      })
      visit(migrated.body)
      expect(calls.some(statement => ATOMIC_FORMATION_MODULES.has(statement.module))).toBe(false)
      expect(rewriteAtomicGraph(migrated, atomicFormationRecipe)).toEqual(migrated)
    }
  })

  it('preserves selection validity for bounds, duplicate, ally, core, and HP rules', () => {
    const state = board()
    state.pieces.push(
      { instanceId: 'source', ownerPlayerId: 'red', x: 2, y: 2, currentHp: 10, isCore: true },
      { instanceId: 'ally-a', ownerPlayerId: 'red', x: 0, y: 0, currentHp: 10, isCore: true },
      { instanceId: 'ally-b', ownerPlayerId: 'red', x: 0, y: 1, currentHp: 10, isCore: true },
      { instanceId: 'dead', ownerPlayerId: 'red', x: 0, y: 2, currentHp: 0, isCore: true },
      { instanceId: 'non-core', ownerPlayerId: 'red', x: 0, y: 3, currentHp: 10, isCore: false },
      { instanceId: 'enemy', ownerPlayerId: 'blue', x: 0, y: 4, currentHp: 10, isCore: true },
    )
    const graph = graphFor('spatial.formation-selection-valid')
    const migrated = migrateFormationModules(graph)
    for (const selected of [['ally-a'], ['ally-a', 'ally-b'], [], ['ally-a', 'ally-a'], ['dead'], ['non-core'], ['enemy']]) {
      expect(execute(migrated, state, { source: 'source', selected })).toBe(execute(graph, state, { source: 'source', selected }))
    }
  })

  it('preserves fixed slot order, selected side occupancy, and empty center', () => {
    const state = board()
    state.pieces.push(
      { instanceId: 'selected-up', ownerPlayerId: 'red', x: 2, y: 1, currentHp: 10, isCore: true },
      { instanceId: 'selected-left', ownerPlayerId: 'red', x: 1, y: 2, currentHp: 10, isCore: true },
      { instanceId: 'unselected-right', ownerPlayerId: 'red', x: 3, y: 2, currentHp: 10, isCore: true },
    )
    const graph = graphFor('spatial.formation-slots')
    const migrated = migrateFormationModules(graph)
    const context = { source: 'selected-up', selected: ['selected-up', 'selected-left'], center: { x: 2, y: 2 } }
    expect(execute(migrated, state, context)).toEqual(execute(graph, state, context))
    expect(execute(migrated, state, context)).toEqual([{ x: 2, y: 2 }, { x: 2, y: 1 }])
  })

  it('preserves candidate center exclusion, side occupancy, range, and y/x ordering', () => {
    const state = board()
    state.pieces.push(
      { instanceId: 'source', ownerPlayerId: 'red', x: 2, y: 2, currentHp: 10, isCore: true },
      { instanceId: 'selected-up', ownerPlayerId: 'red', x: 1, y: 0, currentHp: 10, isCore: true },
      { instanceId: 'selected-left', ownerPlayerId: 'red', x: 0, y: 1, currentHp: 10, isCore: true },
      { instanceId: 'blocker', ownerPlayerId: 'red', x: 3, y: 1, currentHp: 10, isCore: true },
    )
    const graph = graphFor('spatial.formation-candidates')
    const migrated = migrateFormationModules(graph)
    const context = { source: 'source', selected: ['selected-up', 'selected-left'] }
    expect(execute(migrated, state, context)).toEqual(execute(graph, state, context))
  })

  it('does not count walls or off-board slots toward a multi-piece corner formation', () => {
    const state = board(3, 3)
    // The corner has only its center and the diagonal-free right/down
    // neighbours on the board.  Turn both in-board side cells into walls so
    // a two-piece selection has no legal capacity there.
    state.map.tiles.find(tile => tile.x === 1 && tile.y === 0)!.props.walkable = false
    state.map.tiles.find(tile => tile.x === 0 && tile.y === 1)!.props.walkable = false
    state.pieces.push(
      { instanceId: 'source', ownerPlayerId: 'red', x: 1, y: 1, currentHp: 10, isCore: true },
      { instanceId: 'selected-a', ownerPlayerId: 'red', x: 2, y: 2, currentHp: 10, isCore: true },
      { instanceId: 'selected-b', ownerPlayerId: 'red', x: 2, y: 1, currentHp: 10, isCore: true },
    )

    const slots = graphFor('spatial.formation-slots')
    const slotContext = { source: 'source', selected: ['selected-a', 'selected-b'], center: { x: 0, y: 0 } }
    expect(execute(migrateFormationModules(slots), state, slotContext)).toEqual(execute(slots, state, slotContext))
    expect(execute(migrateFormationModules(slots), state, slotContext)).toEqual([{ x: 0, y: 0 }])

    const candidates = graphFor('spatial.formation-candidates')
    const candidateContext = { source: 'source', selected: ['selected-a', 'selected-b'] }
    expect(execute(migrateFormationModules(candidates), state, candidateContext)).toEqual(execute(candidates, state, candidateContext))
    expect(execute(migrateFormationModules(candidates), state, candidateContext)).not.toContainEqual({ x: 0, y: 0 })
  })
})
