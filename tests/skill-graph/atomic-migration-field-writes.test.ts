import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { atomicFieldWriteRecipe, migrateFieldWriteModules } from '../../lib/skill-graph/atomic-migration-field-writes'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayCallStatement, type GameplayModuleGraph, type GameplayValue } from '../../lib/skill-graph/module-types'
import { GAMEPLAY_MODULE_REGISTRY, getGameplayModule } from '../../lib/skill-graph/module-registry'
import { makePiece, makeState } from '../helpers/minimal-state'

const version = '1'
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: unknown): GameplayValue => ({ kind: 'literal', value: value as never })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, unknown> = {},
): GameplayCallStatement => ({ kind: 'call', id, module, version, inputs, parameters: parameters as Record<string, never> })

function lower(id: string, inputs: Record<string, string>, parameters: Record<string, unknown>) {
  const descriptor = getGameplayModule(id)
  if (!descriptor) throw new Error(`missing module ${id}`)
  return descriptor.lower({
    surface: 'skill', callId: 'field-write-test', moduleId: id, moduleVersion: descriptor.version,
    inputs, parameters: parameters as Record<string, never>, outputPorts: descriptor.outputs,
    emitLiteral: value => JSON.stringify(value),
  })
}

function modules(graph: GameplayModuleGraph): string[] {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const record = value as Record<string, unknown>
    if (record.kind === 'call' && typeof record.module === 'string') found.push(record.module)
    Object.values(record).forEach(visit)
  }
  visit(graph.body)
  return found
}

function adjustmentGraph(amount: number): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      call('holder', 'ref.holder'),
      call('adjust', 'attribute.adjust-max-hp', { piece: output('holder', 'piece'), amount: literal(amount) }),
      // This independent effect must still run when the max-HP write rejects
      // its candidate value in the migrated graph.
      call('momentum', 'attribute.set-momentum', { piece: output('holder', 'piece'), value: literal(-2.5) }),
      { kind: 'return', id: 'done', values: { momentum: output('momentum', 'value') } },
    ],
    outputs: [{ name: 'momentum', type: 'number' }],
  }
}

function duplicateStatusGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      call('holder', 'ref.holder'),
      call('write', 'status.set-record-number', {
        piece: output('holder', 'piece'), statusId: literal('same'), value: literal(9),
      }, { field: 'hitCount' }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ],
    outputs: [{ name: 'success', type: 'boolean' }],
  }
}

function executeGraph(graph: GameplayModuleGraph, target: ReturnType<typeof makePiece>, diagnosticHost?: Record<string, unknown>): unknown {
  const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
  const flow = createFlowRuntime(makeState({ pieces: [target] }), { piece: target }, 'skill', {})
  const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (context: unknown) => unknown
  return execute(diagnosticHost ? { __gameplayModuleDiagnosticHost: diagnosticHost } : {})
}

describe('bounded HP/status field write migration', () => {
  it('binds every piece writer field to its value type and preserves spent-passive code shape', () => {
    const descriptor = getGameplayModule('piece.write-field')!
    expect(descriptor.parameters?.find(parameter => parameter.name === 'field')?.enum).toEqual([
      'spentPassives', 'momentum', 'currentHp', 'maxHp',
    ])
    expect(descriptor.ui?.parameterTypeBindings?.valueType).toEqual(expect.objectContaining({
      parameter: 'field', types: expect.objectContaining({ momentum: 'number', currentHp: 'number', maxHp: 'number' }),
    }))
    expect(String(lower('piece.write-field', { piece: 'pieceId', value: 'value' }, { field: 'momentum', valueType: 'number' }))).toContain('setMomentum')
    expect(String(lower('piece.write-field', { piece: 'pieceId', value: 'value' }, { field: 'currentHp', valueType: 'number' }))).toContain('setCurrentHp')
    expect(String(lower('piece.write-field', { piece: 'pieceId', value: 'value' }, { field: 'maxHp', valueType: 'number' }))).toContain('setMaxHp')
    expect(String(lower('piece.write-field', { piece: 'pieceId', value: 'value' }, { field: 'spentPassives', valueType: JSON.stringify({ kind: 'list', element: 'string' }) }))).toContain('target["spentPassives"]=value.slice()')
    expect(() => lower('piece.write-field', { piece: 'pieceId', value: 'value' }, { field: 'momentum', valueType: JSON.stringify({ kind: 'list', element: 'string' }) })).toThrow(/momentum requires/)
    expect(() => lower('piece.write-field', { piece: 'pieceId', value: 'value' }, { field: 'currentHp', valueType: 'string' })).toThrow(/currentHp requires/)
  })

  it('publishes status field/value bindings and rejects identity writes', () => {
    const descriptor = getGameplayModule('status.write-field')!
    const fields = descriptor.parameters?.find(parameter => parameter.name === 'field')?.enum
    expect(fields).toEqual(expect.arrayContaining([
      'type', 'sourceId', 'name', 'stacking', 'visible', 'expiresAfterTurn', 'hitCount', 'readyCharges', 'lastDamageTurn',
    ]))
    expect(fields).not.toContain('id')
    expect(descriptor.inputValueTypeBindings?.value).toEqual({ parameter: 'valueType' })
    expect(descriptor.ui?.parameterTypeBindings?.valueType.types.expiresAfterTurn).toEqual({ kind: 'nullable', value: 'number' })
    expect(String(lower('status.write-field', { status: 'statusRef', value: 'value' }, { field: 'hitCount', valueType: 'number' }))).toContain('writeField(statusRef, "hitCount", value)')
    expect(String(lower('status.write-field', { status: 'statusRef', value: 'value' }, { field: 'expiresAfterTurn', valueType: JSON.stringify({ kind: 'nullable', value: 'number' }) }))).toContain('writeField(statusRef, "expiresAfterTurn", value)')
    expect(() => lower('status.write-field', { status: 'statusRef', value: 'value' }, { field: 'visible', valueType: 'number' })).toThrow(/visible requires/)
    expect(() => lower('status.write-field', { status: 'statusRef', value: 'value' }, { field: 'id', valueType: 'string' })).toThrow(/supported value type/)
  })

  it('rewrites HP and status assignments through a typed instance selection chain', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        call('target', 'ref.holder'),
        call('adjust', 'attribute.adjust-max-hp', { piece: output('target', 'piece'), amount: literal(5) }),
        call('record', 'status.set-record-number', { piece: output('target', 'piece'), statusId: literal('same'), value: literal(-2.5) }, { field: 'hitCount' }),
        { kind: 'return', id: 'done', values: { hp: output('adjust'), changed: output('record', 'success') } },
      ],
      outputs: [{ name: 'hp', type: 'number' }, { name: 'changed', type: 'boolean' }],
    }
    const migrated = migrateFieldWriteModules(graph)
    const used = modules(migrated)
    expect(used).not.toEqual(expect.arrayContaining([
      'attribute.adjust-max-hp', 'status.set-record-number',
    ]))
    expect(used).toEqual(expect.arrayContaining([
      'piece.field', 'math.add', 'piece.write-field', 'status.instances', 'status.instance-field', 'compare.values', 'logic.and', 'status.write-field',
    ]))
    const compiled = compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('status.writeField')
    const target = makePiece({ instanceId: 'target', currentHp: 40, maxHp: 100, statusTags: [{ id: 'same', type: 'mark', hitCount: 2 }] })
    const flow = createFlowRuntime(makeState({ pieces: [target] }), { piece: target }, 'skill', {})
    const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (context: unknown) => unknown
    expect(execute({})).toEqual({ hp: 105, changed: true })
    expect(target.maxHp).toBe(105)
    expect(target.statusTags[0]?.hitCount).toBe(-2.5)
    expect(atomicFieldWriteRecipe(call('invalid', 'status.set-record-number', { piece: input('piece'), statusId: input('statusId'), value: literal(1) }, { field: 'not-registered' }), () => 'fresh')).toBeUndefined()
  })

  it('matches the legacy max-HP lower for legal and rejected negative adjustments while continuing', () => {
    for (const [amount, expectedMaxHp, rejected] of [[-10, 90, false], [-70, 100, true], [-110, 100, true]] as const) {
      const legacyTarget = makePiece({ instanceId: 'target', currentHp: 40, maxHp: 100 })
      const legacyResult = executeGraph(adjustmentGraph(amount), legacyTarget)
      const migratedTarget = makePiece({ instanceId: 'target', currentHp: 40, maxHp: 100 })
      const diagnostics: Array<{ statementId: string; moduleId: string }> = []
      const migratedResult = executeGraph(
        migrateFieldWriteModules(adjustmentGraph(amount)),
        migratedTarget,
        {
          shouldRethrow: () => false,
          record: (statementId: string, _error: unknown, moduleId: string) => diagnostics.push({ statementId, moduleId }),
        },
      )

      expect(migratedResult).toEqual(legacyResult)
      expect(legacyResult).toEqual({ momentum: -2.5 })
      expect(legacyTarget.maxHp).toBe(expectedMaxHp)
      expect(migratedTarget.maxHp).toBe(expectedMaxHp)
      expect(legacyTarget.momentum).toBe(-2.5)
      expect(migratedTarget.momentum).toBe(-2.5)
      expect(rejected ? diagnostics : []).toEqual(rejected
        ? [expect.objectContaining({ moduleId: 'piece.write-field' })]
        : [])
    }
  })

  it('migrates duplicate status IDs with the same first-match target as the old lower', () => {
    const statuses = [
      { id: 'same', type: 'mark', hitCount: 1 },
      { id: 'same', type: 'mark', hitCount: 2 },
    ]
    const legacyTarget = makePiece({ instanceId: 'target', statusTags: statuses.map(status => ({ ...status })) })
    const migratedTarget = makePiece({ instanceId: 'target', statusTags: statuses.map(status => ({ ...status })) })
    const legacyResult = executeGraph(duplicateStatusGraph(), legacyTarget)
    const migratedResult = executeGraph(migrateFieldWriteModules(duplicateStatusGraph()), migratedTarget)
    expect(migratedResult).toEqual(legacyResult)
    expect(legacyResult).toEqual({ success: true })
    expect(legacyTarget.statusTags.map(tag => tag.hitCount)).toEqual([9, 2])
    expect(migratedTarget.statusTags.map(tag => tag.hitCount)).toEqual([9, 2])
  })

  it('writes exact status handles, validates fields before mutation, and preserves old first-match behavior', () => {
    const target = makePiece({ instanceId: 'target' })
    target.statusTags = [
      { id: 'same', type: 'mark', hitCount: 1 },
      { id: 'same', type: 'mark', hitCount: 2 },
      { type: 'mark', hitCount: 3 },
    ]
    const flow = createFlowRuntime(makeState({ pieces: [target] }), { piece: target }, 'skill', {})
    const handles = flow.status.instances('target').statuses
    expect(flow.status.writeField(handles[1]!, 'hitCount', -2.5)).toBe(true)
    expect(target.statusTags.map(tag => tag.hitCount)).toEqual([1, -2.5, 3])
    expect(flow.status.writeField(handles[1]!, 'sourceId', 'akaza')).toBe(true)
    expect(flow.status.writeField(handles[1]!, 'visible', false)).toBe(true)
    expect(flow.status.writeField(handles[1]!, 'expiresAfterTurn', null)).toBe(true)
    expect(() => flow.status.writeField(handles[1]!, 'hitCount', Infinity)).toThrow('无效状态实例字段')
    expect(() => flow.status.writeField(handles[1]!, 'visible', 0)).toThrow('无效状态实例字段')
    expect(() => flow.status.writeField(handles[1]!, 'id', 'other')).toThrow('无效状态实例字段')
    expect(target.statusTags[1]).toMatchObject({ hitCount: -2.5, sourceId: 'akaza', visible: false, expiresAfterTurn: null })

    // A missing/expired execution-local handle is a no-op only after the value
    // has passed the complete field validator.
    expect(flow.status.writeField(null, 'hitCount', 0)).toBe(false)
    expect(() => flow.status.writeField(null, 'hitCount', 'bad')).toThrow('无效状态实例字段')
    flow.status.removeInstance(handles[1]!)
    expect(flow.status.writeField(handles[1]!, 'hitCount', 7)).toBe(false)
    expect(target.statusTags.map(tag => tag.hitCount)).toEqual([1, 3])
  })

  it('keeps HP and momentum boundaries finite and prevents death/revival bypasses', () => {
    const target = makePiece({ instanceId: 'target', currentHp: 10, maxHp: 20 })
    const flow = createFlowRuntime(makeState({ pieces: [target] }), { piece: target }, 'skill', {})
    expect(flow.attributes.setMomentum('target', -1.25)).toBe(-1.25)
    expect(flow.attributes.setMomentum('target', 0)).toBe(0)
    expect(() => flow.attributes.setMomentum('target', Infinity)).toThrow('动能无效')
    expect(flow.attributes.setMaxHp('target', 25)).toBe(25)
    expect(() => flow.attributes.setMaxHp('target', 9)).toThrow('生命上限无效')
    expect(() => flow.attributes.setMaxHp('target', 0)).toThrow('生命上限无效')
    expect(flow.attributes.setCurrentHp('target', 5)).toBe(5)
    target.currentHp = 0
    expect(() => flow.attributes.setCurrentHp('target', 1)).toThrow('不能执行死亡或复活')
  })
})
