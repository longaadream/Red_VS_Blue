import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { migrateScopedFieldModules, ATOMIC_SCOPED_FIELD_MODULES } from '../../lib/skill-graph/atomic-migration-scoped-fields'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY, getGameplayModule, type GameplayModuleCatalog } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_COMPILER_V3_VERSION, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayCallStatement, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayValue } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, unknown> = {},
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters: parameters as Record<string, never> }
}

function execute(graph: GameplayModuleGraph, context: Record<string, unknown>, battle?: unknown, flow?: unknown, registry = GAMEPLAY_MODULE_REGISTRY): unknown {
  const compiled = compileGameplayModuleGraph(graph, registry)
  const run = runInNewContext('(' + compiled.code + ')', { battle, flow }) as (value: unknown) => unknown
  return run(context)
}

function capturedAdjustmentGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    inputs: [{ name: 'amount', type: 'number' }],
    inputBindings: { amount: 1.25 },
    outputs: [{ name: 'value', type: 'number' }],
    body: [
      call('holder', 'ref.holder'),
      call('source', 'source.capture', { source: output('holder', 'piece') }),
      call('adjust', 'attribute.adjust-captured', { source: output('source', 'source'), amount: input('amount') }, { attribute: 'attack' }),
      { kind: 'return', id: 'done', value: output('adjust') },
    ],
  }
}

function storedAssignmentGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    inputs: [{ name: 'id', type: 'string' }, { name: 'value', type: 'number' }],
    inputBindings: { id: 'stored', value: 0 },
    outputs: [{ name: 'success', type: 'boolean' }],
    body: [
      call('set', 'attribute.set-stored', { id: input('id'), value: input('value') }, { attribute: 'defense' }),
      { kind: 'return', id: 'done', value: output('set', 'success') },
    ],
  }
}

function storedPresentationFlagGraph(field = 'showFreezeEffect'): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    inputs: [{ name: 'id', type: 'string' }, { name: 'value', type: 'boolean' }],
    inputBindings: { id: 'duplicate', value: true },
    outputs: [{ name: 'success', type: 'boolean' }],
    body: [
      call('set', 'piece.set-stored-flag', { id: input('id'), value: input('value') }, { field }),
      { kind: 'return', id: 'done', value: output('set', 'success') },
    ],
  }
}

function lower(id: string, inputs: Record<string, string>, parameters: Record<string, unknown>) {
  const descriptor = getGameplayModule(id, id === 'piece.write-field' ? '2' : undefined)
  if (!descriptor) throw new Error(`missing module ${id}`)
  return descriptor.lower({
    surface: 'skill', callId: 'scoped-field-test', moduleId: id, moduleVersion: descriptor.version,
    inputs, parameters: parameters as Record<string, never>, outputPorts: descriptor.outputs,
    emitLiteral: value => JSON.stringify(value),
  })
}

describe('scoped field authoring migrations', () => {
  it('publishes the v2 live superset while constraining stored scope', () => {
    const descriptor = getGameplayModule('piece.write-field', '2')!
    expect(descriptor.parameters?.find(parameter => parameter.name === 'field')?.enum).toEqual([
      'spentPassives', 'momentum', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'showFreezeEffect',
    ])
    expect(descriptor.ui?.parameterTypeBindings?.valueType.types).toEqual(expect.objectContaining({
      spentPassives: { kind: 'list', element: 'string' },
      momentum: 'number', currentHp: 'number', maxHp: 'number',
      attack: 'number', defense: 'number', moveRange: 'number',
      showFreezeEffect: 'boolean',
    }))
    expect(String(lower('piece.write-field', { piece: 'piece-id', value: 'value' }, { scope: 'live', field: 'attack', valueType: 'number' }))).toContain('attributes.set')
    expect(String(lower('piece.write-field', { piece: 'piece-id', value: 'value' }, { scope: 'live', field: 'currentHp', valueType: 'number' }))).toContain('setCurrentHp')
    expect(String(lower('piece.write-field', { piece: 'piece-id', value: 'value' }, { scope: 'live', field: 'spentPassives', valueType: JSON.stringify({ kind: 'list', element: 'string' }) }))).toContain('spentPassives')
    expect(String(lower('piece.write-field', { id: 'piece-id', value: 'value' }, { scope: 'stored', field: 'moveRange', valueType: 'number' }))).toContain('setStored')
    expect(String(lower('piece.write-field', { id: 'piece-id', value: 'value' }, { scope: 'stored', field: 'showFreezeEffect', valueType: 'boolean' }))).toContain('setStored')
    expect(() => lower('piece.write-field', { id: 'piece-id', value: 'value' }, { scope: 'stored', field: 'showFreezeEffect', valueType: 'number' })).toThrow(/showFreezeEffect requires/)
    expect(() => lower('piece.write-field', { piece: 'piece-id', value: 'value' }, { scope: 'live', field: 'showFreezeEffect', valueType: 'boolean' })).toThrow(/showFreezeEffect requires stored scope/)
    expect(() => lower('piece.write-field', { id: 'piece-id', value: 'value' }, { scope: 'stored', field: 'not-a-stored-field', valueType: 'boolean' })).toThrow(/not-a-stored-field requires/)
    expect(() => lower('piece.write-field', { id: 'piece-id', value: 'value' }, { scope: 'stored', field: 'currentHp', valueType: 'number' })).toThrow(/stored scope only supports/)
    expect(getGameplayModule('source.write-field')?.outputs).toEqual([
      { name: 'success', type: 'boolean' }, { name: 'value', type: 'number' },
    ])
    expect(String(lower('source.write-field', { source: 'handle', value: 'next' }, { field: 'attack', valueType: 'number' }))).toContain('value:success?value:__gameplayInvalid')
  })

  it('infers stored presentation booleans and keeps the legacy active-first target order', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      inputs: [{ name: 'id', type: 'string' }, { name: 'enabled', type: 'boolean' }],
      inputBindings: { id: 'duplicate', enabled: true },
      outputs: [{ name: 'success', type: 'boolean' }],
      body: [
        call('write', 'piece.write-field', { id: input('id'), value: input('enabled') }, {
          scope: 'stored', field: 'showFreezeEffect', valueType: 'boolean',
        }, '2'),
        { kind: 'return', id: 'done', value: output('write', 'success') },
      ],
    }
    const writes: unknown[][] = []
    const battle = {
      pieces: [{ instanceId: 'duplicate', showFreezeEffect: false }],
      graveyard: [{ instanceId: 'duplicate', showFreezeEffect: false }],
    }
    const flow = {
      attributes: {
        setStored: (id: string, field: string, value: boolean) => {
          writes.push([id, field, value])
          const target = battle.pieces.find(piece => piece.instanceId === id) ?? battle.graveyard.find(piece => piece.instanceId === id)
          if (!target) return false
          target.showFreezeEffect = value
          return true
        },
      },
    }
    expect(execute(graph, {}, battle, flow)).toBe(true)
    expect(writes).toEqual([['duplicate', 'showFreezeEffect', true]])
    expect(battle.pieces[0].showFreezeEffect).toBe(true)
    expect(battle.graveyard[0].showFreezeEffect).toBe(false)

    const legacyLowering = String(lower('piece.set-stored-flag', { id: 'duplicate', value: 'enabled' }, { field: 'showFreezeEffect' }))
    const legacyBattle = {
      pieces: [{ instanceId: 'duplicate', showFreezeEffect: false }],
      graveyard: [{ instanceId: 'duplicate', showFreezeEffect: false }],
    }
    const legacyResult = runInNewContext('(' + legacyLowering + ')', {
      battle: legacyBattle, duplicate: 'duplicate', enabled: true,
    })
    expect(legacyResult).toBe(true)
    expect(legacyBattle.pieces[0].showFreezeEffect).toBe(true)
    expect(legacyBattle.graveyard[0].showFreezeEffect).toBe(false)
  })

  it('keeps source adjustment and stored assignment behavior across migration', () => {
    expect(ATOMIC_SCOPED_FIELD_MODULES).toEqual(new Set(['attribute.adjust-captured', 'attribute.set-stored', 'piece.set-stored-flag']))

    const originalCaptured = capturedAdjustmentGraph()
    const migratedCaptured = migrateScopedFieldModules(originalCaptured)
    expect(migratedCaptured.body.map(statement => statement.kind === 'call' ? statement.module : statement.kind)).toEqual([
      'ref.holder', 'source.capture', 'source.field', 'math.add', 'source.write-field', 'return',
    ])
    expect(migrateScopedFieldModules(migratedCaptured)).toEqual(migratedCaptured)

    const originalSource = makePiece({ instanceId: 'source', attack: 7.5 })
    const originalBattle = makeState({ pieces: [originalSource] })
    const originalFlow = createFlowRuntime(originalBattle, { piece: originalSource }, 'skill', {})
    const originalResult = execute(originalCaptured, {}, originalBattle, originalFlow)

    const migratedSource = makePiece({ instanceId: 'source', attack: 7.5 })
    const migratedBattle = makeState({ pieces: [migratedSource] })
    const migratedFlow = createFlowRuntime(migratedBattle, { piece: migratedSource }, 'skill', {})
    const migratedHandle = migratedFlow.effects.captureSource('source')
    const migratedResult = execute(migratedCaptured, {}, migratedBattle, migratedFlow)

    expect(migratedResult).toEqual(originalResult)
    expect(originalResult).toBe(8.75)
    expect(migratedSource.attack).toBe(8.75)
    const foreignFlow = createFlowRuntime(makeState({ pieces: [makePiece({ instanceId: 'source' })] }), {}, 'skill', {})
    const foreignHandle = foreignFlow.effects.captureSource('source')
    expect(() => migratedFlow.effects.setCapturedAttribute(foreignHandle, 'attack', 2)).toThrow(/不属于当前执行/)
    expect(() => migratedFlow.effects.setCapturedAttribute(migratedHandle, 'attack', Infinity)).toThrow(/无效结算属性/)
    expect(migratedSource.attack).toBe(8.75)

    migratedBattle.pieces.splice(0, 1)
    expect(migratedFlow.effects.capturedNumber(migratedHandle, 'attack')).toBe(8.75)
    expect(migratedFlow.effects.setCapturedAttribute(migratedHandle, 'attack', 9.5)).toBe(true)
    expect(migratedFlow.effects.capturedNumber(migratedHandle, 'attack')).toBe(9.5)

    const legacyInvalidSource = makePiece({ instanceId: 'source', attack: 7.5 })
    Object.defineProperty(legacyInvalidSource, 'attack', { configurable: true, enumerable: true, value: undefined, writable: true })
    const legacyInvalidBattle = makeState({ pieces: [legacyInvalidSource] })
    const legacyInvalidFlow = createFlowRuntime(legacyInvalidBattle, { piece: legacyInvalidSource }, 'skill', {})
    const legacyInvalidHandle = legacyInvalidFlow.effects.captureSource('source')
    expect(legacyInvalidFlow.effects.capturedAttribute(legacyInvalidHandle, 'attack', 1)).toBeNaN()
    expect(legacyInvalidSource.attack).toBeNaN()

    const rejectedSource = makePiece({ instanceId: 'source', attack: 7.5 })
    Object.defineProperty(rejectedSource, 'attack', { configurable: true, enumerable: true, value: undefined, writable: true })
    const rejectedBattle = makeState({ pieces: [rejectedSource] })
    const rejectedFlow = createFlowRuntime(rejectedBattle, { piece: rejectedSource }, 'skill', {})
    const rejectedHandle = rejectedFlow.effects.captureSource('source')
    expect(() => rejectedFlow.effects.setCapturedAttribute(rejectedHandle, 'attack', NaN)).toThrow(/无效结算属性/)
    expect(rejectedSource.attack).toBeUndefined()
    expect(() => execute(migratedCaptured, {}, rejectedBattle, rejectedFlow)).toThrow(/无效结算属性/)
    expect(rejectedSource.attack).toBeUndefined()

    const originalStored = storedAssignmentGraph()
    const migratedStored = migrateScopedFieldModules(originalStored)
    expect(migratedStored.body[0]).toMatchObject({ module: 'piece.write-field', version: '2', parameters: { scope: 'stored', field: 'defense', valueType: 'number' } })
    expect(migrateScopedFieldModules(migratedStored)).toEqual(migratedStored)

    const oldPiece = makePiece({ instanceId: 'stored' })
    oldPiece.defense = 4
    const oldBattle = makeState({ pieces: [oldPiece] })
    const oldFlow = createFlowRuntime(oldBattle, {}, 'skill', {})
    const oldResult = execute(originalStored, {}, oldBattle, oldFlow)
    const newPiece = makePiece({ instanceId: 'stored' })
    newPiece.defense = 4
    const newBattle = makeState({ pieces: [newPiece] })
    const newFlow = createFlowRuntime(newBattle, {}, 'skill', {})
    const newResult = execute(migratedStored, {}, newBattle, newFlow)
    expect(newResult).toEqual(oldResult)
    expect(oldResult).toBe(true)
    expect(newPiece.defense).toBe(0)

    const missingPiece = makePiece({ instanceId: 'other' })
    missingPiece.defense = 9
    const missingBattle = makeState({ pieces: [missingPiece] })
    const missingFlow = createFlowRuntime(missingBattle, {}, 'skill', {})
    expect(execute({ ...migratedStored, inputBindings: { id: 'missing', value: 0 } }, {}, missingBattle, missingFlow)).toBe(false)
    expect(missingBattle.pieces[0]?.defense).toBe(9)
  })

  it('migrates the legacy stored presentation flag without changing success or lookup behavior', () => {
    const original = storedPresentationFlagGraph()
    const migrated = migrateScopedFieldModules(original)
    expect(migrated.body[0]).toMatchObject({
      kind: 'call', module: 'piece.write-field', version: '2',
      inputs: { id: input('id'), value: input('value') },
      parameters: { scope: 'stored', field: 'showFreezeEffect', valueType: 'boolean' },
    })
    expect(migrateScopedFieldModules(migrated)).toEqual(migrated)

    const oldBattle = {
      pieces: [{ instanceId: 'duplicate', showFreezeEffect: false }],
      graveyard: [{ instanceId: 'duplicate', showFreezeEffect: false }],
    }
    const oldResult = execute(original, {}, oldBattle)
    expect(oldResult).toBe(true)
    expect(oldBattle.pieces[0].showFreezeEffect).toBe(true)
    expect(oldBattle.graveyard[0].showFreezeEffect).toBe(false)

    const newBattle = {
      pieces: [{ instanceId: 'duplicate', showFreezeEffect: false }],
      graveyard: [{ instanceId: 'duplicate', showFreezeEffect: false }],
    }
    const newFlow = {
      attributes: {
        setStored: (id: string, field: string, value: boolean) => {
          const target = newBattle.pieces.find(piece => piece.instanceId === id) ?? newBattle.graveyard.find(piece => piece.instanceId === id)
          if (!target || field !== 'showFreezeEffect' || typeof value !== 'boolean') return false
          target.showFreezeEffect = value
          return true
        },
      },
    }
    const newResult = execute(migrated, {}, newBattle, newFlow)
    expect(newResult).toBe(oldResult)
    expect(newBattle.pieces[0].showFreezeEffect).toBe(true)
    expect(newBattle.graveyard[0].showFreezeEffect).toBe(false)

    const missing = { ...migrated, inputBindings: { id: 'missing', value: true } }
    const missingBattle = {
      pieces: [{ instanceId: 'other', showFreezeEffect: false }],
      graveyard: [{ instanceId: 'other-dead', showFreezeEffect: false }],
    }
    const missingFlow = {
      attributes: { setStored: () => false },
    }
    expect(execute(missing, {}, missingBattle, missingFlow)).toBe(false)
    expect(missingBattle.pieces[0].showFreezeEffect).toBe(false)
    expect(migrateScopedFieldModules(storedPresentationFlagGraph('otherField'))).toEqual(storedPresentationFlagGraph('otherField'))
  })

  it('treats nullable captured sources as invalid statements in production v3 and continues independently', () => {
    const tail: GameplayModuleDescriptor = {
      id: 'test.scoped-field-tail', version: '1', label: 'test tail',
      inputs: [], outputs: [], allowedSurfaces: ['skill'],
      effects: { pure: false, previewSafe: false, writes: ['events'] },
      lower: () => 'context.events.push("tail")',
    }
    const resolve = (id: string, version?: string) => id === tail.id && version === tail.version
      ? tail
      : GAMEPLAY_MODULE_REGISTRY.get(id, version)
    const directEntries = Object.fromEntries(
      GAMEPLAY_MODULE_REGISTRY.descriptors.map(descriptor => [descriptor.id, descriptor]),
    ) as Record<string, GameplayModuleDescriptor>
    const registry = {
      ...directEntries,
      descriptors: GAMEPLAY_MODULE_REGISTRY.descriptors,
      get: resolve,
      resolve,
    } as GameplayModuleCatalog
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        call('event-source', 'source.capture-event-piece', {}, { field: 'sourcePiece' }),
        call('read', 'source.field', { source: output('event-source', 'source') }, { field: 'attack' }),
        call('write', 'source.write-field', { source: { kind: 'literal', value: null }, value: { kind: 'literal', value: 4 } }, { field: 'attack', valueType: 'number' }),
        call('tail', tail.id),
      ],
    }
    const faults: Array<{ statementId: string; moduleId?: string }> = []
    const context: Record<string, unknown> = {
      events: [],
      __gameplayModuleDiagnosticHost: {
        shouldRethrow: () => false,
        record: (statementId: string, _error: unknown, moduleId?: string) => faults.push({ statementId, moduleId }),
      },
    }
    const compiled = compileGameplayModuleGraph(graph, registry)
    expect(compiled.compilerVersion).toBe(GAMEPLAY_MODULE_COMPILER_V3_VERSION)
    expect(execute(graph, context, {}, { effects: { captureEventPiece: () => null, capturedNumber: () => { throw new Error('flow: 无效结算来源句柄') }, setCapturedAttribute: () => { throw new Error('flow: 无效结算来源句柄') } } }, registry)).toBeUndefined()
    expect(context.events).toEqual(['tail'])
    expect(faults).toEqual([
      { statementId: 'read', moduleId: 'source.field' },
      { statementId: 'write', moduleId: 'source.write-field' },
    ])
  })

  it('does not expose a value when the captured writer reports a rejected write', () => {
    const invalid = {}
    const source = {}
    const expression = String(lower('source.write-field', { source: 'handle', value: 'next' }, { field: 'attack', valueType: 'number' }))
    const result = runInNewContext('(' + expression + ')', {
      __gameplayInvalid: invalid,
      flow: { effects: { setCapturedAttribute: () => false } },
      handle: source,
      next: 8,
    }) as { success: boolean; value: unknown }
    expect(result.success).toBe(false)
    expect(result.value).toBe(invalid)
    expect(source).toEqual({})
  })
})
