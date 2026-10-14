import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GENERIC_VALUE_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-generic-values'
import { OPTIONAL_DATA_FIELD_TYPES, OPTIONAL_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-optional-fields'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const call = (
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayStatement => ({ kind: 'call', id, module, version, inputs, parameters })

function graph(body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs }
}

function recordDescriptor(id: string, expression: string): GameplayModuleDescriptor {
  return {
    id, version, label: id, inputs: [], outputs: [{ name: 'record', type: 'record' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true },
    lower: () => expression,
  }
}

function registryWith(...extra: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const descriptors = [...GENERIC_VALUE_GAMEPLAY_MODULES, ...OPTIONAL_FIELD_GAMEPLAY_MODULES, ...extra]
  const local = new Map(descriptors.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return {
    get: (id, requestedVersion) => local.get(id + '@' + (requestedVersion ?? version)) ?? GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
    resolve: (id, requestedVersion) => local.get(id + '@' + (requestedVersion ?? version)) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, requestedVersion),
    descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...descriptors],
  }
}

function execute(source: GameplayModuleGraph, registry: GameplayModuleRegistry): unknown {
  const compiled = compileGameplayModuleGraph(source, registry)
  const run = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
  return run({})
}

describe('generic optional data and value operations', () => {
  it('publishes a closed nullable field map with semantic types', () => {
    const descriptor = OPTIONAL_FIELD_GAMEPLAY_MODULES[0]
    expect(descriptor.id).toBe('data.optional-field')
    expect(descriptor.inputs).toEqual([expect.objectContaining({ name: 'record', type: 'record', nullable: true })])
    expect(descriptor.outputs).toEqual([
      expect.objectContaining({ name: 'value', type: 'unknown', nullable: true }),
      expect.objectContaining({ name: 'defined', type: 'boolean' }),
    ])
    expect(descriptor.parameters?.[0]).toMatchObject({ name: 'field', type: 'string' })
    expect(descriptor.parameters?.[0]?.enum).toEqual(Object.keys(OPTIONAL_DATA_FIELD_TYPES))
    expect(descriptor.outputParameterTypeBindings?.value.types.value).toEqual({ kind: 'nullable', value: 'number' })
    expect(descriptor.outputParameterTypeBindings?.value.types.ownerPlayerId).toEqual({ kind: 'nullable', value: 'player' })
    expect(descriptor.outputParameterTypeBindings?.value.types.pathCells).toEqual({
      kind: 'nullable', value: { kind: 'list', element: 'cell' },
    })
    expect(descriptor.outputParameterTypeBindings?.value.types.skillIds).toEqual({
      kind: 'nullable', value: { kind: 'list', element: 'string' },
    })
    expect(descriptor.outputParameterTypeBindings?.value.types.stats).toEqual({ kind: 'nullable', value: 'record' })
  })

  it('coalesces only nullish values while preserving falsy values and type bindings', () => {
    const coalesce = GENERIC_VALUE_GAMEPLAY_MODULES.find(descriptor => descriptor.id === 'value.coalesce')!
    expect(coalesce.inputs).toEqual([
      expect.objectContaining({ name: 'value', type: 'record', nullable: true }),
      expect.objectContaining({ name: 'defaultValue', type: 'record' }),
    ])
    expect(coalesce.inputs[1]).not.toHaveProperty('nullable')
    expect(coalesce.outputs).toEqual([expect.objectContaining({ name: 'value', type: 'record' })])
    expect(coalesce.outputs[0]).not.toHaveProperty('nullable')
    expect(coalesce.inputValueTypeBindings).toEqual({
      value: { parameter: 'valueType', nullable: true }, defaultValue: { parameter: 'valueType' },
    })
    expect(coalesce.outputValueTypeBindings).toEqual({ value: { parameter: 'valueType' } })

    const nullableNumber = JSON.stringify({ kind: 'nullable', value: 'number' })
    const source = graph([
      call('zero-record', 'test.zero-record'),
      call('empty-record', 'test.empty-record'),
      call('missing-record', 'test.missing-record'),
      call('zero', 'data.optional-field', { record: output('zero-record', 'record') }, { field: 'value' }),
      call('empty', 'data.optional-field', { record: output('empty-record', 'record') }, { field: 'name' }),
      call('missing', 'data.optional-field', { record: output('missing-record', 'record') }, { field: 'value' }),
      call('fallback', 'value.coalesce', { value: output('missing'), defaultValue: literal(9) }, { valueType: nullableNumber }),
      call('keep-zero', 'value.coalesce', { value: output('zero'), defaultValue: literal(9) }, { valueType: nullableNumber }),
      { kind: 'return', id: 'done', values: {
        zero: output('zero'), empty: output('empty'), missing: output('missing'),
        fallback: output('fallback'), keepZero: output('keep-zero'),
      } },
    ], [
      { name: 'zero', type: { kind: 'nullable', value: 'number' } },
      { name: 'empty', type: { kind: 'nullable', value: 'string' } },
      { name: 'missing', type: { kind: 'nullable', value: 'number' } },
      { name: 'fallback', type: { kind: 'nullable', value: 'number' } },
      { name: 'keepZero', type: { kind: 'nullable', value: 'number' } },
    ])
    const registry = registryWith(
      recordDescriptor('test.zero-record', '({value:0,name:""})'),
      recordDescriptor('test.empty-record', '({name:""})'),
      recordDescriptor('test.missing-record', '({})'),
    )
    expect(execute(source, registry)).toEqual({ zero: 0, empty: '', missing: null, fallback: 9, keepZero: 0 })
  })

  it('keeps a raw record intact when the selected record field owns value', () => {
    const source = graph([
      call('record', 'test.record-with-value'),
      call('default-record', 'test.default-record'),
      call('read', 'data.optional-field', { record: output('record', 'record') }, { field: 'stats' }),
      call('coalesced', 'value.coalesce', {
        value: output('read'), defaultValue: output('default-record', 'record'),
      }, { valueType: JSON.stringify({ kind: 'nullable', value: 'record' }) }),
      { kind: 'return', id: 'done', values: {
        value: output('read'), coalesced: output('coalesced'),
      } },
    ], [
      { name: 'value', type: { kind: 'nullable', value: 'record' } },
      { name: 'coalesced', type: { kind: 'nullable', value: 'record' } },
    ])
    expect(execute(source, registryWith(
      recordDescriptor('test.record-with-value', '({stats:{value:7, maxHp:12}})'),
      recordDescriptor('test.default-record', '({value:99})'),
    ))).toEqual({
      value: { value: 7, maxHp: 12 }, coalesced: { value: 7, maxHp: 12 },
    })

  })

  it('distinguishes an explicit null field from an absent field', () => {
    const source = graph([
      call('null-record', 'test.null-name-record'),
      call('absent-record', 'test.absent-name-record'),
      call('null-name', 'data.optional-field', { record: output('null-record', 'record') }, { field: 'name' }),
      call('absent-name', 'data.optional-field', { record: output('absent-record', 'record') }, { field: 'name' }),
      { kind: 'return', id: 'done', values: {
        nullValue: output('null-name', 'value'), nullDefined: output('null-name', 'defined'),
        absentValue: output('absent-name', 'value'), absentDefined: output('absent-name', 'defined'),
      } },
    ], [
      { name: 'nullValue', type: { kind: 'nullable', value: 'string' } },
      { name: 'nullDefined', type: 'boolean' },
      { name: 'absentValue', type: { kind: 'nullable', value: 'string' } },
      { name: 'absentDefined', type: 'boolean' },
    ])
    expect(execute(source, registryWith(
      recordDescriptor('test.null-name-record', '({name:null})'),
      recordDescriptor('test.absent-name-record', '({})'),
    ))).toEqual({ nullValue: null, nullDefined: true, absentValue: null, absentDefined: false })
  })

  it('returns null for absent records and propagates invalid typed fields', () => {
    const nullableNumber = JSON.stringify({ kind: 'nullable', value: 'number' })
    const nullRecord = graph([
      call('record', 'test.null-record'),
      call('read', 'data.optional-field', { record: output('record', 'record') }, { field: 'value' }),
      { kind: 'return', id: 'done', value: output('read') },
    ], [{ name: 'value', type: { kind: 'nullable', value: 'number' } }])
    expect(execute(nullRecord, registryWith({
      ...recordDescriptor('test.null-record', 'null'),
      outputs: [{ name: 'record', type: 'record', nullable: true }],
    }))).toBe(null)

    const optional = OPTIONAL_FIELD_GAMEPLAY_MODULES[0]
    const lower = optional.lower({
      surface: 'skill', callId: 'read', moduleId: optional.id, moduleVersion: version,
      inputs: { record: '({value:"not-a-number"})' }, parameters: { field: 'value' }, outputPorts: optional.outputs,
      emitLiteral: value => JSON.stringify(value),
    })
    const invalid = { invalid: true }
    const executeLowered = runInNewContext('(' + String(lower) + ')', {
      __gameplayInvalid: invalid,
    })
    expect(executeLowered).toBe(invalid)

    const coalesce = GENERIC_VALUE_GAMEPLAY_MODULES.find(descriptor => descriptor.id === 'value.coalesce')!
    const coalesceLowered = coalesce.lower({
      surface: 'skill', callId: 'coalesce', moduleId: coalesce.id, moduleVersion: version,
      inputs: { value: '__gameplayInvalid', defaultValue: '7' }, parameters: { valueType: nullableNumber },
      outputPorts: coalesce.outputs, emitLiteral: value => JSON.stringify(value),
    })
    const coalesceInvalid = { invalid: true }
    expect(runInNewContext('(' + String(coalesceLowered) + ')', { __gameplayInvalid: coalesceInvalid })).toBe(coalesceInvalid)
  })

  it('rejects fields outside the closed map', () => {
    const source = graph([
      call('record', 'test.record'),
      call('read', 'data.optional-field', { record: output('record', 'record') }, { field: 'arbitraryPath' }),
    ], [])
    expect(() => compileGameplayModuleGraph(source, registryWith(recordDescriptor('test.record', '({})')))).toThrow(/outside its enum|unknown field|field/)
  })
})
