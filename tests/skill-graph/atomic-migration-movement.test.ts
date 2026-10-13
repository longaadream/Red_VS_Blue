import { describe, expect, it } from 'vitest'
import { migrateMovementModules } from '../../lib/skill-graph/atomic-migration-movement'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { getGameplayModuleCatalog, GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const literal = (value: string | number | boolean): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, string | number | boolean | readonly string[]> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function graph(body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs }
}

function execute(graphValue: GameplayModuleGraph, flow: unknown) {
  const compiled = compileGameplayModuleGraph(graphValue, GAMEPLAY_MODULE_REGISTRY)
  const run = new Function('flow', 'context', `return (${compiled.code})(context)`) as (flow: unknown, context: unknown) => unknown
  return run(flow, {})
}

type Position = { x: number; y: number }
type MovementState = {
  positions: Record<string, Position>
  occupants: Record<string, 'ally' | 'enemy'>
  terrain: Record<string, string>
}

function movementFlow(initial: MovementState, references: { holder: string; target: string } = { holder: 'source', target: 'second' }) {
  const state: MovementState = {
    positions: Object.fromEntries(Object.entries(initial.positions).map(([id, value]) => [id, { ...value }])),
    occupants: { ...initial.occupants },
    terrain: { ...initial.terrain },
  }
  const submissions: Array<{ kind: string; changes: unknown[]; path?: Record<string, unknown> }> = []
  const key = (cell: Position) => `${cell.x},${cell.y}`
  const submit = (changes: Array<{ pieceId: string; x: number; y: number }>, kind: string, path?: Record<string, unknown>) => {
    submissions.push({ kind, changes, path })
    const options = path ?? {}
    const resultChanges = changes.map(change => {
      const from = state.positions[change.pieceId]
      if (!from) return null
      if (kind === 'swap' || kind === 'teleport') return { ...change, path: [{ x: change.x, y: change.y }] }
      const dx = Math.sign(change.x - from.x), dy = Math.sign(change.y - from.y)
      const distance = Math.abs(change.x - from.x) + Math.abs(change.y - from.y)
      const cells: Position[] = []
      for (let index = 1; index <= distance; index += 1) cells.push({ x: from.x + dx * index, y: from.y + dy * index })
      for (const cell of cells) {
        const terrain = state.terrain[key(cell)]
        if (Array.isArray(options.blockedTerrainTypes) && options.blockedTerrainTypes.includes(terrain)) return null
        if (terrain && options.terrain === 'walkable' && terrain !== 'walkable') return null
        const occupant = Object.entries(state.positions).find(([id, position]) => id !== change.pieceId && key(position) === key(cell))
        if (occupant) {
          const relation = state.occupants[occupant[0]] ?? 'enemy'
          const allowed = relation === 'ally' ? options.passAllies : options.passEnemies
          if (!allowed) return null
        }
      }
      return { ...change, path: cells }
    })
    if (resultChanges.some(value => value === null)) return { success: false, changes: [] }
    const next = resultChanges as Array<{ pieceId: string; x: number; y: number }>
    for (const change of next) state.positions[change.pieceId] = { x: change.x, y: change.y }
    return { success: true, changes: resultChanges }
  }
  return {
    state,
    submissions,
    flow: {
      refs: { holder: () => references.holder, target: () => references.target },
      query: {
        hasPiece: (id: string) => Object.hasOwn(state.positions, id),
        piece: (id: string) => ({ instanceId: id, ...(state.positions[id] ?? {}) }),
      },
      effects: { move: submit, displace: submit },
    },
  }
}

function onePieceMovementGraph(module: string, parameters: Record<string, string | number | boolean | readonly string[]>): GameplayModuleGraph {
  return graph([
    call('holder', 'ref.holder'),
    call('piece', 'query.piece', { pieceId: output('holder', 'piece') }),
    call('destination', 'spatial.cell', { x: literal(2), y: literal(0) }),
    call('move', module, { piece: output('piece', 'piece'), destination: output('destination', 'cell') }, parameters),
    { kind: 'return', id: 'done', values: { success: output('move', 'success') } },
  ], [{ name: 'success', type: 'boolean' }])
}

describe('atomic movement author migrations', () => {
  it('publishes the generic path policy and atomic swap sentences', () => {
    const catalog = getGameplayModuleCatalog()
    const policy = catalog.find(entry => entry.id === 'effect.displace-policy')
    const swap = catalog.find(entry => entry.id === 'effect.swap-pieces')
    expect(policy?.ui?.authoring).toBe('standard')
    expect(swap?.ui?.authoring).toBe('standard')
    expect(policy?.parameters?.find(parameter => parameter.name === 'kind')).toMatchObject({ label: '位移方式', description: expect.stringContaining('teleport') })
    expect(policy?.parameters?.find(parameter => parameter.name === 'terrain')).toMatchObject({ label: '地形策略', description: expect.stringContaining('walkable') })
    expect(swap?.inputs?.find(input => input.name === 'first')?.label).toBe('第一枚棋子')
  })

  it('maps teleport and direct teleport to displace-one without changing ports or references', () => {
    const source = onePieceMovementGraph('effect.teleport', { kind: 'teleport' })
    const withResult = { ...source, outputs: [{ name: 'success', type: 'boolean' as const }, { name: 'result', type: 'record' as const }], body: [
      ...source.body.slice(0, -1),
      { kind: 'return' as const, id: 'done', values: { success: output('move', 'success'), result: output('move', 'result') } },
    ] }
    const before = JSON.stringify(withResult)
    const migrated = migrateMovementModules(withResult)
    expect(JSON.stringify(withResult)).toBe(before)
    expect(migrated.body.find(statement => statement.kind === 'call' && statement.id === 'move')).toMatchObject({ id: 'move', module: 'effect.displace-one', version: '1', parameters: { kind: 'teleport' } })
    expect(migrated.body.at(-1)).toMatchObject({ values: { success: output('move', 'success'), result: output('move', 'result') } })
    expect(migrateMovementModules(migrated)).toEqual(migrated)

    const directTeleport = migrateMovementModules(onePieceMovementGraph('effect.displace', { kind: 'teleport' }))
    expect(directTeleport.body.find(statement => statement.kind === 'call' && statement.id === 'move')).toMatchObject({
      module: 'effect.displace-one',
      parameters: { kind: 'teleport' },
    })

    const initial = { positions: { source: { x: 0, y: 0 } }, occupants: {}, terrain: {} }
    const legacyHost = movementFlow(initial)
    const migratedHost = movementFlow(initial)
    expect(execute(withResult, legacyHost.flow)).toEqual(
      execute(migrated, migratedHost.flow),
    )
    expect(migratedHost.state.positions.source).toEqual({ x: 2, y: 0 })
    expect(migratedHost.submissions[0]).toMatchObject({ kind: 'teleport' })
  })

  it('maps dash to policy with explicit defaults and preserves blocker, path, moved and success behavior', () => {
    const source = onePieceMovementGraph('effect.displace', {
      kind: 'dash', passAllies: true, passEnemies: true, terrain: 'walkable',
    })
    const migrated = migrateMovementModules(source)
    expect(migrated.body.find(statement => statement.kind === 'call' && statement.id === 'move')).toMatchObject({
      module: 'effect.displace-policy',
      parameters: { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'walkable', blockedTerrainTypes: [] },
    })

    const defaults = migrateMovementModules(onePieceMovementGraph('effect.displace', {}))
    expect(defaults.body.find(statement => statement.kind === 'call' && statement.id === 'move')).toMatchObject({
      module: 'effect.displace-policy',
      parameters: { kind: 'dash', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] },
    })

    for (const scenario of [
      { name: 'clear', occupants: {}, expectedSuccess: true, expectedPosition: { x: 2, y: 0 } },
      { name: 'blocked terrain', occupants: {}, expectedSuccess: false, expectedPosition: { x: 0, y: 0 } },
    ]) {
      const initial: MovementState = {
        positions: { source: { x: 0, y: 0 } },
        occupants: scenario.occupants,
        terrain: scenario.name === 'blocked terrain' ? { '1,0': 'wall' } : {},
      }
      const legacyHost = movementFlow(initial)
      const migratedHost = movementFlow(initial)
      expect(execute(migrated, migratedHost.flow)).toEqual(execute(source, legacyHost.flow))
      expect(execute(migrated, migratedHost.flow)).toEqual({ success: scenario.expectedSuccess })
      expect(migratedHost.state.positions.source).toEqual(scenario.expectedPosition)
    }

    const enemyBlockedSource = onePieceMovementGraph('effect.displace', {
      kind: 'dash', passAllies: true, passEnemies: false, terrain: 'any',
    })
    const enemyBlocked = migrateMovementModules(enemyBlockedSource)
    const enemyInitial: MovementState = {
      positions: { source: { x: 0, y: 0 }, enemy: { x: 1, y: 0 } },
      occupants: { enemy: 'enemy' }, terrain: {},
    }
    const enemyLegacyHost = movementFlow(enemyInitial)
    const enemyMigratedHost = movementFlow(enemyInitial)
    expect(execute(enemyBlocked, enemyMigratedHost.flow)).toEqual(execute(enemyBlockedSource, enemyLegacyHost.flow))
    expect(execute(enemyBlocked, enemyMigratedHost.flow)).toEqual({ success: false })
    expect(enemyMigratedHost.state.positions.source).toEqual({ x: 0, y: 0 })

    const host = movementFlow({ positions: { source: { x: 0, y: 0 } }, occupants: {}, terrain: {} })
    const policy = graph([
      call('holder', 'ref.holder'),
      call('piece', 'query.piece', { pieceId: output('holder', 'piece') }),
      call('destination', 'spatial.cell', { x: literal(2), y: literal(0) }),
      call('move', 'effect.displace-policy', { piece: output('piece', 'piece'), destination: output('destination', 'cell') }, {
        kind: 'dash', passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [],
      }),
      { kind: 'return', id: 'done', values: { success: output('move', 'success'), changed: output('move', 'changed'), steps: output('move', 'steps') } },
    ], [{ name: 'success', type: 'boolean' }, { name: 'changed', type: 'boolean' }, { name: 'steps', type: 'number' }])
    expect(execute(policy, host.flow)).toEqual({ success: true, changed: true, steps: 2 })
    expect(host.submissions[0]).toMatchObject({ kind: 'dash', path: { passAllies: true, passEnemies: true, terrain: 'any', blockedTerrainTypes: [] } })
  })

  it('keeps swap as one atomic two-piece submission', () => {
    const source = graph([
      call('first-ref', 'ref.holder'),
      call('first', 'query.piece', { pieceId: output('first-ref', 'piece') }),
      call('second-ref', 'ref.target'),
      call('second', 'query.piece', { pieceId: output('second-ref', 'piece') }),
      call('swap', 'effect.swap-pieces', { first: output('first', 'piece'), second: output('second', 'piece') }),
      { kind: 'return', id: 'done', values: { success: output('swap', 'success'), changed: output('swap', 'changed') } },
    ], [{ name: 'success', type: 'boolean' }, { name: 'changed', type: 'boolean' }])
    const host = movementFlow({
      positions: { first: { x: 0, y: 0 }, second: { x: 1, y: 0 } }, occupants: {}, terrain: {},
    }, { holder: 'first', target: 'second' })
    expect(execute(source, host.flow)).toEqual({ success: true, changed: true })
    expect(host.state.positions).toEqual({ first: { x: 1, y: 0 }, second: { x: 0, y: 0 } })
    expect(host.submissions).toHaveLength(1)
    expect(host.submissions[0]).toMatchObject({ kind: 'swap', changes: expect.arrayContaining([
      expect.objectContaining({ pieceId: 'first', x: 1, y: 0 }),
      expect.objectContaining({ pieceId: 'second', x: 0, y: 0 }),
    ]) })
  })
})
