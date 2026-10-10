import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { applyBattleAction, type BattleState } from '../../lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'

function graph(surface: GameplayModuleGraph['surface'], body: GameplayModuleGraph['body'], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface, body, ...extra }
}

function literal(value: number | string | boolean | readonly (number | string | boolean)[]): GameplayValue {
  return { kind: 'literal', value }
}

function registryOf(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return { get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version)) }
}

function descriptor(
  id: string,
  inputs: GameplayModuleDescriptor['inputs'],
  outputs: GameplayModuleDescriptor['outputs'],
  lower: GameplayModuleDescriptor['lower'],
): GameplayModuleDescriptor {
  return { id, version, label: id, inputs, outputs, allowedSurfaces: ['skill', 'pending'], effects: { pure: true, previewSafe: true }, lower }
}

const add = descriptor(
  'math.add',
  [{ name: 'left', type: 'number' }, { name: 'right', type: 'number' }],
  [{ name: 'value', type: 'number' }],
  ({ inputs }) => ({ expression: '({value: (' + inputs.left + ' + ' + inputs.right + ')})' }),
)

describe('structured record and collection statements', () => {
  it('creates, reads, and updates a closed typed record', () => {
    const compiled = compileGameplayModuleGraph(graph('skill', [
      { kind: 'record.create', id: 'created', schema: 'payload@1', fields: { count: literal(2), label: literal('first') } },
      { kind: 'record.get', id: 'read', record: { kind: 'output', node: 'created', port: 'value' }, field: 'count' },
      { kind: 'record.with', id: 'updated', record: { kind: 'output', node: 'created', port: 'value' }, fields: { count: literal(5) } },
      { kind: 'record.get', id: 'readUpdated', record: { kind: 'output', node: 'updated', port: 'value' }, field: 'count' },
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'readUpdated', port: 'value' } } },
    ], {
      schemas: [{ id: 'payload', version: '1', fields: [{ name: 'count', type: 'number' }, { name: 'label', type: 'string', optional: true }] }],
      outputs: [{ name: 'result', type: 'number' }],
    }), registryOf())
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ result: 5 })
  })

  it('rejects unknown fields, schemas, and opaque host records in record.get', () => {
    const schema = { id: 'payload', version: '1', fields: [{ name: 'count', type: 'number' as const }] }
    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'record.create', id: 'created', schema: 'payload@1', fields: { extra: literal(1) } },
    ], { schemas: [schema] }), registryOf())).toThrow(/unknown record field/)
    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'record.create', id: 'created', schema: 'missing@1', fields: {} },
    ], { schemas: [schema] }), registryOf())).toThrow(/unknown record schema/)

    const opaque = descriptor('host.record', [], [{ name: 'value', type: 'record' }], () => ({ expression: '({value: {count: 1}})' }))
    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'call', id: 'raw', module: 'host.record', version, inputs: {} },
      { kind: 'record.get', id: 'read', record: { kind: 'output', node: 'raw', port: 'value' }, field: 'count' },
    ], { schemas: [schema] }), registryOf(opaque))).toThrow(/typed record/)

    const passthrough = compileGameplayModuleGraph(graph('skill', [
      { kind: 'call', id: 'raw', module: 'host.record', version, inputs: {} },
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'raw', port: 'value' } } },
    ], { outputs: [{ name: 'result', type: 'record' }] }), registryOf(opaque))
    const execute = runInNewContext('(' + passthrough.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ result: { count: 1 } })
  })

  it('runs bounded map, filter, and reduce bodies with explicit captures', () => {
    const mapped = compileGameplayModuleGraph(graph('skill', [
      {
        kind: 'collection', id: 'mapped', method: 'map', items: literal([1, 2, 3]), item: 'value', inputs: { captured: literal(9) },
        body: [{ kind: 'return', id: 'mapReturn', value: { kind: 'input', name: 'captured' } }],
      },
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'mapped', port: 'value' } } },
    ], { outputs: [{ name: 'result', type: { kind: 'list', element: 'number' } }] }), registryOf())
    const mapExecute = runInNewContext('(' + mapped.code + ')') as (context: unknown) => unknown
    expect(mapExecute({})).toEqual({ result: [9, 9, 9] })

    const filtered = compileGameplayModuleGraph(graph('skill', [
      {
        kind: 'collection.filter', id: 'filtered', items: literal([1, 2, 3]), item: 'value',
        body: [{ kind: 'return', id: 'filterReturn', value: literal(true) }],
      },
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'filtered', port: 'value' } } },
    ], { outputs: [{ name: 'result', type: { kind: 'list', element: 'number' } }] }), registryOf())
    const filterExecute = runInNewContext('(' + filtered.code + ')') as (context: unknown) => unknown
    expect(filterExecute({})).toEqual({ result: [1, 2, 3] })

    const reduced = compileGameplayModuleGraph(graph('skill', [
      {
        kind: 'collection.reduce', id: 'reduced', items: literal([1, 2, 3]), initial: literal(0), item: 'value', accumulator: 'total',
        body: [
          { kind: 'call', id: 'step', module: 'math.add', version, inputs: { left: { kind: 'input', name: 'total' }, right: { kind: 'input', name: 'value' } } },
          { kind: 'return', id: 'reduceReturn', value: { kind: 'output', node: 'step', port: 'value' } },
        ],
      },
      { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'reduced', port: 'value' } } },
    ], { outputs: [{ name: 'result', type: 'number' }] }), registryOf(add))
    const reduceExecute = runInNewContext('(' + reduced.code + ')') as (context: unknown) => unknown
    expect(reduceExecute({})).toEqual({ result: 6 })
  })

  it('rejects implicit collection captures and enforces the iteration budget', () => {
    const outer = graph('skill', [
      { kind: 'collection', id: 'mapped', method: 'map', items: literal([1]), body: [{ kind: 'return', id: 'bad', value: { kind: 'input', name: 'outer' } }] },
    ], { inputs: [{ name: 'outer', type: 'number' }], inputBindings: { outer: 3 } })
    expect(() => compileGameplayModuleGraph(outer, registryOf())).toThrow(/unknown input/)
    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'collection', id: 'mapped', method: 'map', items: literal([1, 2, 3]), body: [{ kind: 'return', id: 'done', value: { kind: 'input', name: 'item' } }] },
    ]), registryOf(), { maxCollectionIterations: 2 })).toThrow(/iteration budget/)
    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'collection', id: 'mapped', method: 'map', items: literal([1]), body: [{ kind: 'return', id: 'mapReturn', value: { kind: 'input', name: 'item' } }] },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'mapped', port: 'value' } },
    ], { outputs: [{ name: 'value', type: { kind: 'list', element: 'number' } }] }), registryOf(), { maxExpandedStatements: 3 })).not.toThrow()
  })

  it('rejects effectful, random, and pending modules from collection bodies but keeps foreach effects', () => {
    const effectModule = (id: string, effects: GameplayModuleDescriptor['effects']): GameplayModuleDescriptor => ({
      ...descriptor(id, [], [{ name: 'value', type: 'boolean' }], () => ({ expression: '({value: true})' })),
      effects,
    })
    const modules = [
      effectModule('test.collection-writes', { pure: false, writes: ['state'] }),
      effectModule('test.collection-random', { pure: false, random: true }),
      effectModule('test.collection-pending', { pure: false, pending: true }),
    ]
    for (const descriptor of modules) {
      for (const method of ['map', 'filter', 'reduce'] as const) {
        const collection: Record<string, unknown> = {
          kind: 'collection', id: 'blocked', method, items: literal([1, 2]),
          body: [
            { kind: 'call', id: 'effect', module: descriptor.id, version, inputs: {} },
            { kind: 'return', id: 'value', value: { kind: 'output', node: 'effect', port: 'value' } },
          ],
        }
        if (method === 'reduce') collection.initial = literal(false)
        expect(() => compileGameplayModuleGraph(graph('skill', [collection as never]), registryOf(descriptor))).toThrow(/collection body cannot call effectful module/)
      }
    }

    const wrapped = effectModule('test.collection-wrapped', { pure: false, writes: ['state'] })
    const compositeGraph = graph('skill', [{
      kind: 'collection', id: 'wrapped', method: 'map', items: literal([1]), body: [
        { kind: 'call', id: 'effect', module: 'test.collection-wrapper', version, inputs: {} },
        { kind: 'return', id: 'value', value: { kind: 'output', node: 'effect', port: 'value' } },
      ],
    }], {
      composites: [{
        id: 'test.collection-wrapper', version, inputs: [], outputs: [{ name: 'value', type: 'boolean' }],
        body: [{ kind: 'call', id: 'effect', module: wrapped.id, version, inputs: {} }, { kind: 'return', id: 'value', value: { kind: 'output', node: 'effect', port: 'value' } }],
      }],
    })
    expect(() => compileGameplayModuleGraph(compositeGraph, registryOf(wrapped))).toThrow(/collection body cannot call effectful module/)

    const foreachGraph = graph('skill', [{
      kind: 'foreach', id: 'loop', items: literal([1]), item: 'item', body: [
        { kind: 'call', id: 'effect', module: modules[0].id, version, inputs: {} },
      ],
    }])
    expect(() => compileGameplayModuleGraph(foreachGraph, registryOf(modules[0]))).not.toThrow()
  })
})

describe('structured pending continuations', () => {
  const schema = { id: 'payload', version: '1', fields: [{ name: 'value', type: 'number' as const }] }

  function child(overrides: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
    return graph('pending', [{ kind: 'return', id: 'done', value: literal(true) }], {
      schemas: [schema],
      hostBindings: {
        payload: { kind: 'record', schema: 'payload@1' },
        selectedTargets: { kind: 'list', element: 'choice' },
        targetCell: { kind: 'nullable', value: 'cell' },
        targetPiece: 'piece',
        sourcePiece: 'piece',
        player: 'player',
      },
      outputs: [{ name: 'value', type: 'boolean' }],
      ...overrides,
    })
  }

  it('uses the fixed pending host binding allowlist and rejects wrong types', () => {
    expect(() => compileGameplayModuleGraph(child(), registryOf())).not.toThrow()
    expect(() => compileGameplayModuleGraph(graph('pending', [], { hostBindings: { payload: 'record' } }), registryOf())).toThrow(/typed record/)
    expect(() => compileGameplayModuleGraph(graph('pending', [], { hostBindings: { targetCell: 'cell' } }), registryOf())).toThrow(/wrong type|incompatible type/)
    expect(() => compileGameplayModuleGraph(graph('pending', [], { hostBindings: { code: 'string' } as never }), registryOf())).toThrow(/host binding/)
  })

  it('emits a complete legacy pending envelope and typed continuation payload', () => {
    const parent = graph('skill', [
      { kind: 'record.create', id: 'payload', schema: 'payload@1', fields: { value: literal(7) } },
      {
        kind: 'defer-choice', id: 'wait', graph: 'choose@1', payload: { kind: 'output', node: 'payload', port: 'value' },
        title: literal('Choose'), targetType: literal('piece'), selectionMode: literal('single'), min: literal(1), max: literal(1), canCancel: literal(false),
        message: literal('First effect resolved'), resumeOnCancel: literal(true),
      },
    ], {
      schemas: [schema],
      continuations: [{ id: 'choose', version: '1', graph: child() }],
    })
    const compiled = compileGameplayModuleGraph(parent, registryOf())
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    const result = execute({}) as { success: boolean; message: string; pendingTargetSelection: Record<string, unknown> }
    expect(result.success).toBe(true)
    expect(result.message).toBe('First effect resolved')
    expect(result.pendingTargetSelection.resumeOnCancel).toBe(true)
    expect(result.pendingTargetSelection).toMatchObject({ playerId: undefined, title: 'Choose', targetType: 'piece', selectionMode: 'single', min: 1, max: 1, minSelections: 1, maxSelections: 1, canCancel: false, payload: { value: 7 } })
    expect(result.pendingTargetSelection.candidates).toBeUndefined()
    expect(result.pendingTargetSelection.effectCode).toEqual(expect.stringContaining('function(ctx)'))
  })

  it('maps pending host bindings to the real continuation context shape', () => {
    const capture = descriptor(
      'pending.capture',
      [
        { name: 'payload', type: 'record' },
        { name: 'selectedTargets', type: { kind: 'list', element: 'choice' } },
        { name: 'targetCell', type: { kind: 'nullable', value: 'cell' } },
        { name: 'targetPiece', type: 'piece' },
        { name: 'sourcePiece', type: 'piece' },
        { name: 'player', type: 'player' },
      ],
      [{ name: 'value', type: 'record' }],
      ({ inputs }) => ({ expression: '({value: {payload: ' + inputs.payload + ', selectedTargets: ' + inputs.selectedTargets + ', targetCell: ' + inputs.targetCell + ', targetPiece: ' + inputs.targetPiece + ', sourcePiece: ' + inputs.sourcePiece + ', player: ' + inputs.player + '}})' }),
    )
    const pendingChild = child({
      outputs: [{ name: 'result', type: 'record' }],
      body: [
        { kind: 'call', id: 'capture', module: 'pending.capture', version, inputs: {
          payload: { kind: 'input', name: 'payload' },
          selectedTargets: { kind: 'input', name: 'selectedTargets' },
          targetCell: { kind: 'input', name: 'targetCell' },
          targetPiece: { kind: 'input', name: 'targetPiece' },
          sourcePiece: { kind: 'input', name: 'sourcePiece' },
          player: { kind: 'input', name: 'player' },
        } },
        { kind: 'return', id: 'done', values: { result: { kind: 'output', node: 'capture', port: 'value' } } },
      ],
    })
    const parent = graph('skill', [
      { kind: 'record.create', id: 'payload', schema: 'payload@1', fields: { value: literal(7) } },
      { kind: 'defer-choice', id: 'wait', graph: 'choose@1', payload: { kind: 'output', node: 'payload', port: 'value' } },
    ], { schemas: [schema], continuations: [{ id: 'choose', version: '1', graph: pendingChild }] })
    const compiled = compileGameplayModuleGraph(parent, registryOf(capture))
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => { success: boolean; pendingTargetSelection: { effectCode: string } }
    const pending = execute({}).pendingTargetSelection
    const continuation = runInNewContext('(' + pending.effectCode + ')') as (context: unknown) => { result: Record<string, unknown> }
    expect(continuation({
      playerId: 'player-a',
      targetPiece: { instanceId: 'target-a' },
      targetX: 2,
      targetY: 3,
      pending: { selectedTargets: ['choice-a'], source: { pieceId: 'source-a' }, triggerContext: {} },
      payload: { value: 7 },
    })).toEqual({ result: { payload: { value: 7 }, selectedTargets: ['choice-a'], targetCell: { x: 2, y: 3 }, targetPiece: 'target-a', sourcePiece: 'source-a', player: 'player-a' } })
  })

  for (const nested of [false, true]) it(`resumes ${nested ? 'nested' : 'single'} compiled continuations through applyBattleAction`, () => {
    const capture = descriptor(
      'pending.capture-real-action',
      [
        { name: 'payload', type: 'record' },
        { name: 'selectedTargets', type: { kind: 'list', element: 'choice' } },
        { name: 'targetCell', type: { kind: 'nullable', value: 'cell' } },
        { name: 'targetPiece', type: 'piece' },
        { name: 'sourcePiece', type: 'piece' },
        { name: 'player', type: 'player' },
      ],
      [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
      ({ inputs }) => ({ expression: '((ctx.battle.extensions.pendingCapture = { payload: ' + inputs.payload + ', selectedTargets: ' + inputs.selectedTargets + ', targetCell: ' + inputs.targetCell + ', targetPiece: ' + inputs.targetPiece + ', sourcePiece: ' + inputs.sourcePiece + ', player: ' + inputs.player + ' }), {success: true, message: "continued"})' }),
    )
    const pendingChild = child({
      outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
      body: [
        { kind: 'call', id: 'capture', module: 'pending.capture-real-action', version, inputs: {
          payload: { kind: 'input', name: 'payload' },
          selectedTargets: { kind: 'input', name: 'selectedTargets' },
          targetCell: { kind: 'input', name: 'targetCell' },
          targetPiece: { kind: 'input', name: 'targetPiece' },
          sourcePiece: { kind: 'input', name: 'sourcePiece' },
          player: { kind: 'input', name: 'player' },
        } },
        { kind: 'return', id: 'done', values: {
          success: { kind: 'output', node: 'capture', port: 'success' },
          message: { kind: 'output', node: 'capture', port: 'message' },
        } },
      ],
    })
    const parent = graph('skill', [
      { kind: 'record.create', id: 'payload', schema: 'payload@1', fields: { value: literal(7) } },
      { kind: 'defer-choice', id: 'wait', graph: 'choose@1', payload: { kind: 'output', node: 'payload', port: 'value' } },
    ], { schemas: [schema], continuations: [{ id: 'choose', version: '1', graph: nested ? child({ outputs: [], continuations: [{ id: 'second', version: '1', graph: pendingChild }], body: [{ kind: 'defer-choice', id: 'second-choice', graph: 'second@1', payload: { kind: 'input', name: 'payload' }, player: { kind: 'input', name: 'player' }, title: literal('Second selection') }] }) : pendingChild }] })
    const compiled = compileGameplayModuleGraph(parent, registryOf(capture))
    const skillId = 'structured-pending-real-action'
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }] })
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0 })
    const state = makeState({ pieces: [caster, target], currentPlayerId: 'player-red', phase: 'action', width: 4, height: 3 }) as BattleState & { skillsById: Record<string, unknown> }
    state.skillsById[skillId] = {
      id: skillId,
      name: 'Structured pending fixture',
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 0,
      range: 'self',
      requiresTarget: false,
      code: compiled.code,
    }

    const first = applyBattleAction(state, { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId })
    const pending = first.pendingTargetSelection
    expect(pending).toBeDefined()
    if (!pending?.selectionId || pending.stateRevision === undefined) throw new Error('expected a stamped pending target')
    let resumed = applyBattleAction(first, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'target',
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })
    if (nested) {
      const second = resumed.pendingTargetSelection
      expect(second?.title).toBe('Second selection')
      if (!second?.selectionId || second.stateRevision === undefined) throw new Error('expected second stamped selection')
      resumed = applyBattleAction(resumed, { type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'target', selectionId: second.selectionId, stateRevision: second.stateRevision })
    }
    expect(resumed.pendingTargetSelection).toBeUndefined()
    expect(resumed.extensions?.pendingCapture).toEqual({
      payload: { value: 7 },
      selectedTargets: [{ type: 'piece', pieceId: 'target' }],
      targetCell: null,
      targetPiece: 'target',
      sourcePiece: 'caster',
      player: 'player-red',
    })
  })

  it('rejects missing or cyclic continuations and wrong payload schemas', () => {
    expect(() => compileGameplayModuleGraph(graph('skill', [{ kind: 'defer-choice', id: 'wait', graph: 'choose@1', payload: literal(1), effectCode: 'return 1' } as never]), registryOf())).toThrow(/unknown field/)
    expect(() => compileGameplayModuleGraph(graph('skill', [{ kind: 'defer-choice', id: 'wait', graph: 'missing@1', payload: literal(1) }]), registryOf())).toThrow(/unknown continuation|payload/)
    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'record.create', id: 'payload', schema: 'payload@1', fields: { value: literal(1) } },
      { kind: 'defer-choice', id: 'wait', graph: 'choose@1', payload: { kind: 'output', node: 'payload', port: 'value' } },
    ], { schemas: [schema], continuations: [{ id: 'choose', version: '1', graph: child({ hostBindings: { payload: { kind: 'record', schema: 'other@1' } } }) }] }), registryOf())).toThrow(/payload|schema/)

    const cyclic: Record<string, unknown> = graph('pending', []) as unknown as Record<string, unknown>
    cyclic.continuations = [{ id: 'loop', version: '1', graph: cyclic }]
    expect(() => compileGameplayModuleGraph(cyclic, registryOf())).toThrow(/cycle/)

    expect(() => compileGameplayModuleGraph(graph('skill', [
      { kind: 'record.create', id: 'payload', schema: 'payload@1', fields: { value: literal(1) } },
      { kind: 'defer-choice', id: 'wait', graph: 'choose@1', payload: { kind: 'output', node: 'payload', port: 'value' }, min: literal(2) },
    ], { schemas: [schema], continuations: [{ id: 'choose', version: '1', graph: child() }] }), registryOf())).toThrow(/minimum cannot exceed maximum/)
  })

  it('rejects a pending choice nested in a composite before it can be swallowed', () => {
    const nested = graph('skill', [
      { kind: 'record.create', id: 'payload', schema: 'payload@1', fields: { value: literal(1) } },
      { kind: 'call', id: 'wrapper', module: 'pending.wrapper', version, inputs: { payload: { kind: 'output', node: 'payload', port: 'value' } } },
      { kind: 'return', id: 'done', value: literal(true) },
    ], {
      schemas: [schema],
      composites: [{
        id: 'pending.wrapper', version,
        inputs: [{ name: 'payload', type: { kind: 'record', schema: 'payload@1' } }],
        outputs: [],
        body: [{ kind: 'defer-choice', id: 'wait', graph: 'choose@1', payload: { kind: 'input', name: 'payload' } }],
      }],
      continuations: [{ id: 'choose', version: '1', graph: child() }],
      outputs: [{ name: 'value', type: 'boolean' }],
    })
    expect(() => compileGameplayModuleGraph(nested, registryOf())).toThrow(/cannot be nested/)
  })
})
