import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  ATOMIC_RAW_STATUS_REMOVAL_MODULES,
  migrateRawStatusRemovalModules,
} from '../../lib/skill-graph/atomic-migration-raw-status-removal'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { removePlayerStatusWithEvents } from '../../lib/game/skills'
import { makeState as makeBattle, makePiece as makeBattlePiece } from '../helpers/minimal-state'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayPort,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })

const fixtures = [
  {
    id: 'test.status-player', version: '1', label: 'status owner', inputs: [],
    outputs: [{ name: 'player', type: 'player' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: '"player-red"' }),
  },
  {
    id: 'test.status-piece', version: '1', label: 'status target', inputs: [],
    outputs: [{ name: 'piece', type: 'piece' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: '"active"' }),
  },
  {
    id: 'test.status-source', version: '1', label: 'status source', inputs: [],
    outputs: [{ name: 'piece', type: 'piece' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: '"source"' }),
  },
  {
    id: 'test.invalid-number', version: '1', label: 'invalid number', inputs: [],
    outputs: [{ name: 'value', type: 'number' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: '__gameplayInvalid' }),
  },
  {
    id: 'test.invalid-piece', version: '1', label: 'invalid piece', inputs: [],
    outputs: [{ name: 'piece', type: 'piece' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => ({ expression: '__gameplayInvalid' }),
  },
] as const

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

const registry: GameplayModuleRegistry = {
  get: (id, version) => fixtures.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id, version) => fixtures.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...fixtures],
}

type Status = { id?: unknown; type?: unknown; sourceId?: unknown; turnNumber?: unknown; [key: string]: unknown }
type Piece = { instanceId: string; currentHp: number; statusTags: Array<Status | null | string | number> }
type RawState = { pieces: Piece[]; graveyard: Piece[] }

function graphFor(module: string, parameters: Record<string, GameplayJsonValue>, invalidTurn = false, invalidSource = false): GameplayModuleGraph {
  let inputs: readonly GameplayPort[]
  let callInputs: Readonly<Record<string, GameplayValue>>
  let outputPort: string
  let setup: GameplayStatement[]
  if (module === 'status.remove-player-records') {
    inputs = []
    setup = [call('owner', 'test.status-player')]
    callInputs = { player: output('owner', 'player') }
    outputPort = 'count'
  } else if (module === 'status.remove-type-raw') {
    inputs = []
    setup = [call('piece', 'test.status-piece')]
    callInputs = { piece: output('piece', 'piece') }
    outputPort = 'count'
  } else if (module === 'status.remove-source-type-raw') {
    inputs = [{ name: 'target', type: 'string' }]
    setup = [call('source', invalidSource ? 'test.invalid-piece' : 'test.status-source')]
    callInputs = { target: input('target'), source: output('source', 'piece') }
    outputPort = 'count'
  } else {
    inputs = [{ name: 'turn', type: 'number' }]
    setup = [call('target', 'test.status-piece'), ...(invalidTurn ? [call('turn-value', 'test.invalid-number')] : [])]
    callInputs = { target: output('target', 'piece'), turn: invalidTurn ? output('turn-value', 'value') : input('turn') }
    outputPort = 'success'
  }
  const outputType = outputPort === 'count' ? 'number' : 'boolean'
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    inputs,
    inputBindings: Object.fromEntries(inputs.map(port => [port.name, port.name === 'turn' ? 3 : 'grave'])),
    body: [
      ...setup,
      call('remove', module, callInputs, parameters),
      { kind: 'return', id: 'done', values: { value: output('remove', outputPort) } },
    ],
    outputs: [{ name: 'value', type: outputType }],
  }
}

function makeState(): RawState {
  return {
    pieces: [
      { instanceId: 'active', currentHp: 10, statusTags: [
        { id: 'same', type: 'mark', sourceId: 'source', turnNumber: 3 },
        { id: 'same', type: 'mark', sourceId: 'other', turnNumber: 2 },
        { type: 'mark', sourceId: 'source', turnNumber: 2 },
        { id: 'keep', type: 'other', sourceId: 'source', turnNumber: 2 },
      ] },
      { instanceId: 'source', currentHp: 10, statusTags: [] },
    ],
    graveyard: [{ instanceId: 'grave', currentHp: 0, statusTags: [
      { id: 'grave-a', type: 'mark', sourceId: 'source', turnNumber: 2 },
      { id: 'grave-b', type: 'mark', sourceId: 'other', turnNumber: 2 },
      { id: 'grave-no-id', type: 'mark', sourceId: 'source', turnNumber: 2 },
      { id: 42, type: 'mark', sourceId: 'source', turnNumber: 2 },
    ] }],
  }
}

function makeExpiredState(): RawState {
  return {
    pieces: [{ instanceId: 'active', currentHp: 10, statusTags: [
      { id: 'same', type: 'mark', sourceId: 'source', turnNumber: 2 },
      { id: 'same', type: 'mark', sourceId: 'other', turnNumber: 1 },
      { type: 'mark', sourceId: 'source', turnNumber: 2 },
      { id: 42, type: 'mark', sourceId: 'source', turnNumber: 1 },
      { id: 'missing-turn', type: 'mark', sourceId: 'source' },
      { id: 'current-string', type: 'mark', sourceId: 'source', turnNumber: '3' },
      { id: 'keep', type: 'other', sourceId: 'source', turnNumber: 1 },
    ] }],
    graveyard: [],
  }
}

function runtime(state: RawState) {
  let rawRemovals = 0
  let lifecycleRemovals = 0
  const localValues = new WeakMap<object, unknown>()
  const findActive = (id: unknown) => typeof id === 'string' ? state.pieces.find(piece => piece.instanceId === id) : undefined
  const findAny = (id: unknown) => typeof id === 'string'
    ? state.pieces.find(piece => piece.instanceId === id) ?? state.graveyard.find(piece => piece.instanceId === id)
    : undefined
  const handle = (piece: Piece, tag: Status) => ({ piece, tag })
  const flow = {
    execution: {
      declare: (_type: unknown, _schemas: unknown, initial: unknown) => {
        const handle = Object.freeze(Object.create(null)) as object
        localValues.set(handle, initial)
        return { handle, success: true }
      },
      read: (handle: object) => {
        if (!localValues.has(handle)) throw new Error('local handle expired')
        return { value: localValues.get(handle), success: true }
      },
    },
    query: {
      piece: (id: string) => findActive(id),
      hasPiece: (id: string) => Boolean(findActive(id)),
    },
    status: {
      instances: (id: string) => {
        const piece = findActive(id)
        if (!piece) return { statuses: [], present: false }
        return { statuses: piece.statusTags.filter(tag => tag !== null && typeof tag === 'object').map(tag => handle(piece, tag as Status)), present: true }
      },
      instancesById: (id: string) => {
        const piece = findAny(id)
        if (!piece) return { statuses: [], present: false }
        return { statuses: piece.statusTags.filter(tag => tag !== null && typeof tag === 'object').map(tag => handle(piece, tag as Status)), present: true }
      },
      fields: (selected: { piece: Piece; tag: Status }) => {
        if (!selected.piece.statusTags.includes(selected.tag)) throw new Error('status instance expired')
        return { ...selected.tag }
      },
      removeInstance: (selected: { piece: Piece; tag: Status }) => {
        const index = selected.piece.statusTags.indexOf(selected.tag)
        if (index < 0) throw new Error('status instance expired')
        selected.piece.statusTags.splice(index, 1)
        rawRemovals += 1
        return true
      },
      remove: (id: string, statusId: string) => {
        lifecycleRemovals += 1
        const piece = findActive(id)
        const index = piece?.statusTags.findIndex(tag => tag !== null && typeof tag === 'object' && tag.id === statusId) ?? -1
        if (!piece || index < 0) return false
        piece.statusTags.splice(index, 1)
        return true
      },
    },
  }
  return {
    state,
    flow,
    battle: state,
    get rawRemovals() { return rawRemovals },
    get lifecycleRemovals() { return lifecycleRemovals },
  }
}

function execute(source: GameplayModuleGraph, migrated: boolean, state: ReturnType<typeof runtime>): unknown {
  const graph = migrated ? migrateRawStatusRemovalModules(source) : source
  const compiled = compileGameplayModuleGraph(graph, registry)
  const run = runInNewContext('(' + compiled.code + ')', {
    flow: state.flow,
    battle: state.battle,
  }) as (context: unknown) => unknown
  const result = run({})
  return result
}

function tags(state: RawState, id: string): Array<unknown> {
  return (state.pieces.find(piece => piece.instanceId === id) ?? state.graveyard.find(piece => piece.instanceId === id))?.statusTags ?? []
}

describe('atomic raw status-removal migrations', () => {
  it('preserves empty player status storage after raw removal from an owner with no status field', () => {
    for (const migrate of [false, true]) {
      const battle = makeBattle(), owner = battle.players[0]!
      delete owner.statusTags
      const flow = createFlowRuntime(battle, {}, 'rule', {})
      const source = graphFor('status.remove-player-records', { statusType: 'mark' })
      const graph = migrate ? migrateRawStatusRemovalModules(source) : source
      const run = runInNewContext('(' + compileGameplayModuleGraph(graph, registry).code + ')', { flow, battle }) as (context: unknown) => unknown
      expect(run({})).toEqual({ value: 0 })
      expect(owner).toHaveProperty('statusTags', [])
    }
  })
  it('keeps player handles exact through local values and delegates lifecycle removal', () => {
    const battle = makeBattle()
    const owner = battle.players[0]!
    const sibling = battle.players[1]!
    owner.statusTags = [
      { id: 'owner-mark', type: 'mark', sourceId: owner.playerId },
      { id: 'same', type: 'mark', sourceId: 'left' },
      { id: 'same', type: 'mark', sourceId: 'right' },
      { type: 'mark', sourceId: 'no-id' },
      { id: 'keep', type: 'other' },
    ] as typeof owner.statusTags
    sibling.statusTags = [{ id: 'owner-mark', type: 'mark' }] as typeof sibling.statusTags

    const lifecycleCalls: Array<[string, string]> = []
    const flow = createFlowRuntime(battle, {}, 'rule', {
      removePlayerStatusEffectById: (playerId: string, statusId: string) => {
        lifecycleCalls.push([playerId, statusId])
        return removePlayerStatusWithEvents(battle, playerId, statusId)
      },
    })
    const handles = flow.status.instances(owner.playerId, 'player').statuses
    expect(handles).toHaveLength(5)

    const local = flow.execution.declare('status', [], handles[3])
    const read = flow.execution.read(local.handle, 'status', [])
    expect(read.value).toBe(handles[3])
    flow.entityExtension.declare('status', read.value as object, 'player-status', 'value', 'number', [], 1)
    flow.entityExtension.write('status', read.value as object, 'player-status', 'value', '', 'number', [], 2)
    expect(owner.statusTags?.[3]?.extension).toEqual({ __authorNamespaces: { 'player-status': { value: 2 } } })

    expect(() => flow.status.removeInstanceLifecycle(handles[1]!)).toThrow('不唯一')
    expect(() => flow.status.removeInstanceLifecycle(handles[3]!)).toThrow('缺少生命周期标识')
    expect(lifecycleCalls).toEqual([])

    expect(flow.status.removeInstanceLifecycle(handles[0]!)).toBe(true)
    expect(lifecycleCalls).toEqual([[owner.playerId, 'owner-mark']])
    expect(owner.statusTags?.some(tag => tag.id === 'owner-mark')).toBe(false)
    expect(sibling.statusTags).toEqual([{ id: 'owner-mark', type: 'mark' }])
    expect(() => flow.status.fields(handles[0]!)).toThrow('失效')

    expect(flow.status.removeInstance(handles[3]!)).toBe(true)
    expect(lifecycleCalls).toEqual([[owner.playerId, 'owner-mark']])
    const foreignFlow = createFlowRuntime(battle, {}, 'rule', {})
    expect(() => foreignFlow.status.fields(handles[2]!)).toThrow('失效')
    expect(() => foreignFlow.status.removeInstance(handles[2]!)).toThrow('失效')
    expect(owner.statusTags?.filter(tag => tag.id === 'same')).toHaveLength(2)
  })

  it('uses explicit owners for raw cleanup without changing the living-only v1 contract', () => {
    const piece = migrateRawStatusRemovalModules(graphFor('status.remove-type-raw', { statusType: 'mark' }))
      .body.find(statement => statement.kind === 'call' && statement.module === 'status.instances') as GameplayCallStatement
    expect(piece.version).toBe('2')
    expect(piece.inputs).toHaveProperty('owner')
    expect(piece.parameters).toEqual({ ownerType: 'piece' })
    expect(GAMEPLAY_MODULE_REGISTRY.get('status.instances', '1')?.livingReferences).toEqual(['piece'])

    const player = migrateRawStatusRemovalModules(graphFor('status.remove-player-records', { statusType: 'mark' }))
      .body.find(statement => statement.kind === 'call' && statement.module === 'status.instances') as GameplayCallStatement
    expect(player.version).toBe('2')
    expect(player.inputs).toHaveProperty('owner')
    expect(player.inputs).not.toHaveProperty('piece')
    expect(player.parameters).toEqual({ ownerType: 'player' })
  })

  it('cleans a deceased holder through raw instance removal and keeps unrelated statuses', () => {
    const source = graphFor('status.remove-type-raw', { statusType: 'mark' })
    const battle = makeBattle({ pieces: [makeBattlePiece({ instanceId: 'active', currentHp: 0, statusTags: [{ type: 'mark' }, { id: 'keep', type: 'other' }] })] })
    const flow = createFlowRuntime(battle, {}, 'skill', {})
    const compiled = compileGameplayModuleGraph(migrateRawStatusRemovalModules(source), registry)
    runInNewContext('(' + compiled.code + ')', { flow })({})
    expect(battle.pieces[0]!.statusTags).toEqual([{ id: 'keep', type: 'other' }])
  })

  it('removes player statuses by exact instance without touching sibling players or lifecycle events', () => {
    const battle = makeBattle()
    const owner = battle.players[0]!
    owner.statusTags = [{ id: 'same', type: 'mark' }, { id: 'same', type: 'mark' }, { type: 'mark' }, { type: 'keep' }] as typeof owner.statusTags
    battle.players[1]!.statusTags = [{ type: 'mark' }] as typeof owner.statusTags
    const flow = createFlowRuntime(battle, {}, 'rule', {})
    const handle = flow.status.instances(owner.playerId, 'player').statuses[0]!
    const source = graphFor('status.remove-player-records', { statusType: 'mark' })
    const graph = migrateRawStatusRemovalModules(source)
    const code = compileGameplayModuleGraph(graph, registry).code
    const run = runInNewContext('(' + code + ')', { flow, battle }) as (context: unknown) => unknown
    expect(run({})).toEqual({ value: 3 })
    expect(owner.statusTags).toEqual([{ type: 'keep' }])
    expect(battle.players[1]!.statusTags).toEqual([{ type: 'mark' }])
    expect(() => flow.status.fields(handle)).toThrow('失效')
    expect(() => flow.status.removeInstance(handle)).toThrow('失效')
  })
  it('retires every raw status wrapper and is idempotent', () => {
    for (const moduleId of ATOMIC_RAW_STATUS_REMOVAL_MODULES) {
      const source = graphFor(moduleId, { statusType: 'mark' })
      const migrated = migrateRawStatusRemovalModules(source)
      const modules: string[] = []
      const visit = (items: readonly GameplayStatement[]): void => items.forEach(statement => {
        if (statement.kind === 'call') modules.push(statement.module)
        if (statement.kind === 'foreach' || statement.kind === 'collection') visit(statement.body)
      })
      visit(migrated.body)
      expect(modules).not.toContain(moduleId)
      expect(migrateRawStatusRemovalModules(migrated)).toEqual(migrated)
    }
  })

  it('removes every matching type by exact handle, including duplicate and no-id records', () => {
    const source = graphFor('status.remove-type-raw', { statusType: 'mark' })
    const oldState = runtime(structuredClone(makeState()))
    const newState = runtime(structuredClone(makeState()))
    expect(execute(source, false, oldState)).toEqual(execute(source, true, newState))
    expect(tags(oldState.state, 'active')).toEqual(tags(newState.state, 'active'))
    expect(tags(newState.state, 'active')).toEqual([{ id: 'keep', type: 'other', sourceId: 'source', turnNumber: 2 }])
    expect(newState.rawRemovals).toBe(3)
    expect(newState.lifecycleRemovals).toBe(0)
  })

  it('keeps source filtering and the active plus graveyard target boundary', () => {
    const source = graphFor('status.remove-source-type-raw', { statusType: 'mark' })
    const oldState = runtime(structuredClone(makeState()))
    const newState = runtime(structuredClone(makeState()))
    expect(execute(source, false, oldState)).toEqual(execute(source, true, newState))
    expect(tags(oldState.state, 'grave')).toEqual(tags(newState.state, 'grave'))
    expect(tags(newState.state, 'grave')).toEqual([
      { id: 'grave-b', type: 'mark', sourceId: 'other', turnNumber: 2 },
    ])
    expect(newState.rawRemovals).toBe(3)
    expect(newState.lifecycleRemovals).toBe(0)
  })

  it('keeps an absent source target as a successful zero-count operation', () => {
    const source = graphFor('status.remove-source-type-raw', { statusType: 'mark' })
    const oldState = runtime({ ...structuredClone(makeState()), graveyard: [] })
    const newState = runtime({ ...structuredClone(makeState()), graveyard: [] })
    expect(execute(source, false, oldState)).toEqual({ value: 0 })
    expect(execute(source, true, newState)).toEqual({ value: 0 })
    expect(newState.rawRemovals).toBe(0)
    expect(newState.lifecycleRemovals).toBe(0)
  })

  it('removes only expired typed statuses with string ids and does not emit lifecycle work', () => {
    const source = graphFor('status.remove-expired-turn-type', { statusType: 'mark' })
    const oldState = runtime(structuredClone(makeExpiredState()))
    const newState = runtime(structuredClone(makeExpiredState()))
    expect(execute(source, false, oldState)).toEqual(execute(source, true, newState))
    expect(tags(oldState.state, 'active')).toEqual(tags(newState.state, 'active'))
    expect(tags(newState.state, 'active')).toEqual([
      { type: 'mark', sourceId: 'source', turnNumber: 2 },
      { id: 42, type: 'mark', sourceId: 'source', turnNumber: 1 },
      { id: 'current-string', type: 'mark', sourceId: 'source', turnNumber: '3' },
      { id: 'keep', type: 'other', sourceId: 'source', turnNumber: 1 },
    ])
    expect(newState.rawRemovals).toBe(3)
    expect(newState.lifecycleRemovals).toBe(0)
  })

  it('propagates an invalid required turn without turning the target into a success', () => {
    const source = graphFor('status.remove-expired-turn-type', { statusType: 'mark' }, true)
    const oldState = runtime(structuredClone(makeExpiredState()))
    const newState = runtime(structuredClone(makeExpiredState()))
    expect(execute(source, false, oldState)).toBeUndefined()
    expect(execute(source, true, newState)).toBeUndefined()
    expect(tags(newState.state, 'active')).toEqual(tags(oldState.state, 'active'))
    expect(newState.rawRemovals).toBe(0)
    expect(newState.lifecycleRemovals).toBe(0)
  })

  it('propagates an invalid source identity instead of returning an empty count', () => {
    const source = graphFor('status.remove-source-type-raw', { statusType: 'mark' }, false, true)
    const oldState = runtime(structuredClone(makeState()))
    const newState = runtime(structuredClone(makeState()))
    expect(execute(source, false, oldState)).toBeUndefined()
    expect(execute(source, true, newState)).toBeUndefined()
    expect(tags(newState.state, 'grave')).toEqual(tags(oldState.state, 'grave'))
    expect(newState.rawRemovals).toBe(0)
    expect(newState.lifecycleRemovals).toBe(0)
  })
})
