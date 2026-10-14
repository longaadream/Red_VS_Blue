import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  ATOMIC_EXTENSION_QUERY_MODULES,
  migrateExtensionQueryModules,
} from '../../lib/skill-graph/atomic-migration-extension-queries'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { RECORD_KEY_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-record-key'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayEffectMetadata,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayModuleSurface,
  type GameplayValue,
  type GameplayValueType,
} from '../../lib/skill-graph/module-types'

const version = '1'
const active: readonly GameplayModuleSurface[] = ['skill']
const recordType: GameplayValueType = 'record'
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullableNumberListType: GameplayValueType = { kind: 'nullable', value: { kind: 'list', element: 'number' } }
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: 'piece' }
const nullableCellType: GameplayValueType = { kind: 'nullable', value: 'cell' }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: 'record' }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
  callVersion = version,
): Extract<GameplayModuleGraph['body'][number], { kind: 'call' }> {
  return { kind: 'call', id, module, version: callVersion, inputs, parameters }
}

function descriptor(
  id: string,
  inputs: GameplayModuleDescriptor['inputs'],
  outputs: GameplayModuleDescriptor['outputs'],
  lower: GameplayModuleDescriptor['lower'],
  options: Partial<Pick<GameplayModuleDescriptor, 'parameters' | 'outputParameterTypeBindings'>> = {},
): GameplayModuleDescriptor {
  const effects: GameplayEffectMetadata = { pure: true, previewSafe: true, reads: ['test'] }
  return { id, version, label: id, inputs, outputs, allowedSurfaces: active, effects, lower, ...options }
}

function registryWith(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(item => [item.id + '@' + item.version, item]))
  return {
    get: (id, requestedVersion) => {
      const value = byKey.get(id + '@' + (requestedVersion ?? version))
        ?? GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion)
      return value
    },
  }
}

function testHostDescriptors(): GameplayModuleDescriptor[] {
  const records = descriptor('test.records', [], [{ name: 'value', type: recordListType }], () => 'context.records')
  const record = descriptor('test.record', [], [{ name: 'value', type: recordType, nullable: true }], () => 'context.record')
  const piece = descriptor('test.piece', [], [{ name: 'value', type: 'piece' }], () => 'context.piece')
  const nullablePiece = descriptor('test.nullable-piece', [], [{ name: 'value', type: nullablePieceType }], () => 'context.piece')
  const status = descriptor('test.status', [], [{ name: 'value', type: nullableStringType }], () => 'context.statusId')
  const cell = descriptor('test.cell', [], [{ name: 'value', type: nullableCellType }], () => 'context.cell')
  return [records, record, piece, nullablePiece, status, cell]
}

function graph(body: GameplayModuleGraph['body'], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs }
}

function execute(code: string, context: Record<string, unknown>, battle: Record<string, unknown>, flow: Record<string, unknown>): unknown {
  const scope = { battle, flow }
  const executeSkill = runInNewContext('(' + code + ')', scope) as (value: Record<string, unknown>) => unknown
  return executeSkill(context)
}

function compilePair(source: GameplayModuleGraph): { source: GameplayModuleGraph; migrated: GameplayModuleGraph; registry: GameplayModuleRegistry } {
  const migrated = migrateExtensionQueryModules(source)
  const registry = registryWith(...RECORD_KEY_GAMEPLAY_MODULES, ...testHostDescriptors())
  return { source, migrated, registry }
}

function runtime(context: Record<string, unknown>, pieces: Record<string, Record<string, unknown>> = {}): { context: Record<string, unknown>; battle: Record<string, unknown>; flow: Record<string, unknown> } {
  const piece = (context.piece ?? 'source') as string
  const query = {
    hasPiece: (id: string) => Object.prototype.hasOwnProperty.call(pieces, id),
    piece: (id: string) => pieces[id],
    pieces: () => Object.values(pieces).map(value => String(value.instanceId)),
  }
  const battle = {
    extensions: context.extensions,
    map: context.map ?? { tiles: [] },
    pieces: Object.values(pieces),
    turn: {},
  }
  const event = { contactCells: context.contactCells }
  const flow = { query, event: { read: () => event } }
  void piece
  return { context, battle, flow }
}

describe('extension query alias migration', () => {
  it('migrates the two coordinate projections and preserves source filtering/order', () => {
    const source = graph([
      call('records', 'test.records'),
      call('source', 'test.piece'),
      call('filtered', 'extension.cells-for-source', { cells: output('records'), source: output('source') }),
      call('projected', 'extension.records-to-cells', { records: output('records') }),
      { kind: 'return', id: 'done', values: { filtered: output('filtered', 'cells'), projected: output('projected', 'cells') } },
    ], [
      { name: 'filtered', type: { kind: 'list', element: 'cell' } },
      { name: 'projected', type: { kind: 'list', element: 'cell' } },
    ])
    const pair = compilePair(source)
    const host = runtime({
      piece: 'source',
      records: [
        { x: 1, y: 2, sourcePieceId: 'source' },
        { x: 3, y: 4 },
        { x: 5, y: 6, sourcePieceId: 'other' },
        { x: 7.5, y: 8, sourcePieceId: 'source' },
      ],
    }, { source: { instanceId: 'source' } })
    const oldResult = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)
    const newResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, host.context, host.battle, host.flow)
    expect(newResult).toEqual(oldResult)
    expect(newResult).toEqual({ filtered: [{ x: 1, y: 2 }, { x: 3, y: 4 }], projected: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7.5, y: 8 }] })

    const emptyHost = runtime({ piece: 'source', records: [] }, { source: { instanceId: 'source' } })
    expect(execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, emptyHost.context, emptyHost.battle, emptyHost.flow)).toEqual({ filtered: [], projected: [] })
  })

  it('keeps first matching record semantics and nullable no-match source', () => {
    const source = graph([
      call('records', 'test.records'),
      call('piece', 'test.piece'),
      call('source', 'extension.cell-record-source', { piece: output('piece') }, { storageKey: 'amaterasuCells' }),
      { kind: 'return', id: 'done', values: { sourceId: output('source', 'sourceId') } },
    ], [{ name: 'sourceId', type: nullableStringType }])
    const pair = compilePair(source)
    const host = runtime({
      piece: 'piece',
      extensions: { amaterasuCells: [{ x: 2, y: 3, sourcePieceId: 'first' }, { x: 2, y: 3, sourcePieceId: 'second' }] },
    }, { piece: { x: 2, y: 3 } })
    const oldResult = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)
    const newResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, host.context, host.battle, host.flow)
    expect(newResult).toEqual(oldResult)
    expect(newResult).toEqual({ sourceId: 'first' })

    const emptyHost = runtime({ piece: 'piece', extensions: { amaterasuCells: [] } }, { piece: { x: 2, y: 3 } })
    const emptyResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, emptyHost.context, emptyHost.battle, emptyHost.flow)
    expect(emptyResult).toEqual({ sourceId: null })
  })

  it('resolves nullable extension record sources through the authoritative piece query', () => {
    const source = graph([
      call('record', 'test.record'),
      call('source', 'extension.record-source', { record: output('record') }),
      { kind: 'return', id: 'done', values: { piece: output('source', 'piece') } },
    ], [{ name: 'piece', type: nullablePieceType }])
    const pair = compilePair(source)
    const host = runtime({ record: { sourceId: 'source' } }, { source: { instanceId: 'source' } })
    const oldResult = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)
    const newResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, host.context, host.battle, host.flow)
    expect(newResult).toEqual(oldResult)
    expect(newResult).toEqual({ piece: 'source' })
    expect(JSON.stringify(pair.migrated.body)).not.toContain('extension.record-source')
    expect(JSON.stringify(pair.migrated.body)).toContain('query.piece-by-id')

    const staleHost = runtime({ record: { sourceId: 'removed' } }, { source: { instanceId: 'source' } })
    expect(execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, staleHost.context, staleHost.battle, staleHost.flow)).toEqual({ piece: null })
  })

  it('counts duplicate path occurrences and selects the first string source', () => {
    const source = graph([
      call('hits', 'event.path-cell-record-hits', {}, { storageKey: 'amaterasuCells' }),
      { kind: 'return', id: 'done', values: { hits: output('hits', 'hits'), sourceId: output('hits', 'sourceId') } },
    ], [{ name: 'hits', type: 'number' }, { name: 'sourceId', type: nullableStringType }])
    const pair = compilePair(source)
    const host = runtime({
      contactCells: [{ x: 1, y: 2 }, { x: 1, y: 2 }, { x: 3, y: 4 }, { x: 9, y: 9 }],
      extensions: {
        amaterasuCells: [
          { x: 1, y: 2 },
          { x: 1, y: 2, sourcePieceId: 'ignored-after-first-match' },
          { x: 3, y: 4, sourcePieceId: 'first' },
        ],
      },
    })
    const oldResult = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)
    const newResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, host.context, host.battle, host.flow)
    expect(newResult).toEqual(oldResult)
    expect(newResult).toEqual({ hits: 3, sourceId: 'first' })

    const emptyHost = runtime({ contactCells: [], extensions: { amaterasuCells: [] } })
    expect(execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, emptyHost.context, emptyHost.battle, emptyHost.flow)).toEqual({ hits: 0, sourceId: null })
  })

  it('keeps left-to-right valid side cells and map coordinate checks', () => {
    const source = graph([
      call('piece', 'test.piece'),
      call('status', 'test.status'),
      call('cells', 'status.valid-side-cells', { piece: output('piece'), statusId: output('status') }),
      { kind: 'return', id: 'done', values: { cells: output('cells', 'cells') } },
    ], [{ name: 'cells', type: { kind: 'list', element: 'cell' } }])
    const pair = compilePair(source)
    const host = runtime({
      piece: 'piece', statusId: 'tracked', map: { tiles: [{ x: 1, y: 1 }, { x: 3, y: 3 }] },
    }, { piece: { statusTags: [{ id: 'tracked', left: { x: 1, y: 1 }, right: { x: 2, y: 2 } }] } })
    const oldResult = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)
    const newResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, host.context, host.battle, host.flow)
    expect(newResult).toEqual(oldResult)
    expect(newResult).toEqual({ cells: [{ x: 1, y: 1 }] })

    const emptyHost = runtime({ piece: 'piece', statusId: 'tracked', map: { tiles: [] } }, { piece: { statusTags: [] } })
    expect(execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, emptyHost.context, emptyHost.battle, emptyHost.flow)).toEqual({ cells: [] })
  })

  it('migrates anchor existence through first-match extension records', () => {
    const source = graph([
      call('source', 'test.nullable-piece'),
      call('cell', 'test.cell'),
      call('exists', 'marker.anchor-exists', { source: output('source'), cell: output('cell') }, { storageKey: 'minatoAnchors' }),
      { kind: 'return', id: 'done', value: output('exists') },
    ], [{ name: 'value', type: 'boolean' }])
    const pair = compilePair(source)
    const host = runtime({
      piece: 'source', cell: { x: 2, y: 2 }, extensions: { minatoAnchors: [{ sourceId: 'source', x: 2, y: 2 }] },
    }, { source: { instanceId: 'source' } })
    const oldResult = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)
    const newResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, host.context, host.battle, host.flow)
    expect(newResult).toEqual(oldResult)
    expect(newResult).toEqual(true)

    const emptyHost = runtime({ piece: null, cell: null, extensions: { minatoAnchors: [] } })
    expect(execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, emptyHost.context, emptyHost.battle, emptyHost.flow)).toEqual(false)
  })

  it('includes dead pieces, filters witnesses by owner and tag, then uses locale order', () => {
    const source = graph([
      call('witness', 'test.piece'),
      call('result', 'followup.primary-mangekyo-witness', { witness: output('witness') }),
      { kind: 'return', id: 'done', value: output('result') },
    ], [{ name: 'value', type: 'boolean' }])
    const pair = compilePair(source)
    const pieces = {
      alpha: { instanceId: 'alpha', ownerPlayerId: 'red', currentHp: 0, statusTags: [{ type: 'mangekyo-witness' }] },
      zeta: { instanceId: 'zeta', ownerPlayerId: 'red', currentHp: 5, statusTags: [{ type: 'mangekyo-witness' }] },
      other: { instanceId: 'other', ownerPlayerId: 'blue', currentHp: 5, statusTags: [{ type: 'mangekyo-witness' }] },
      plain: { instanceId: 'plain', ownerPlayerId: 'red', currentHp: 5, statusTags: [] },
    }
    const host = runtime({ piece: 'alpha' }, pieces)
    const oldResult = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)
    const newResult = execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, host.context, host.battle, host.flow)
    expect(newResult).toEqual(oldResult)
    expect(newResult).toEqual(true)

    const laterHost = runtime({ piece: 'zeta' }, pieces)
    expect(execute(compileGameplayModuleGraph(pair.migrated, pair.registry).code, laterHost.context, laterHost.battle, laterHost.flow)).toEqual(false)
  })

  it('uses the merged record-key descriptor for null, missing, and immutable values', () => {
    const readKey = call('read', 'data.read-key', { record: output('record') }, {
      key: 'nested', valueType: JSON.stringify(nullableRecordType),
    })
    const source = graph([
      call('record', 'test.record'),
      readKey,
      { kind: 'return', id: 'done', values: { value: output('read'), defined: output('read', 'defined') } },
    ], [{ name: 'value', type: nullableRecordType }, { name: 'defined', type: 'boolean' }])
    const pair = compilePair(source)
    const record = { nested: { x: 2, list: [{ y: 3 }] } }
    const host = runtime({ record })
    const result = execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow) as { value: Record<string, unknown>; defined: boolean }
    expect(result).toEqual({ value: record.nested, defined: true })
    expect(result.value).not.toBe(record.nested)
    expect((result.value.list as unknown[])[0]).not.toBe(record.nested.list[0])

    const missing = graph([
      call('record', 'test.record'),
      call('read', 'data.read-key', { record: output('record') }, { key: 'missing', valueType: JSON.stringify(nullableStringType) }),
      { kind: 'return', id: 'done', values: { value: output('read'), defined: output('read', 'defined') } },
    ], [{ name: 'value', type: nullableStringType }, { name: 'defined', type: 'boolean' }])
    const missingPair = compilePair(missing)
    expect(execute(compileGameplayModuleGraph(missingPair.migrated, missingPair.registry).code, host.context, host.battle, host.flow)).toEqual({ value: null, defined: false })

    const explicitNull = { nested: null }
    const nullHost = runtime({ record: explicitNull })
    expect(execute(compileGameplayModuleGraph(pair.source, pair.registry).code, nullHost.context, nullHost.battle, nullHost.flow)).toEqual({ value: null, defined: true })

    const recordOnly = graph([
      call('record', 'test.record'),
      call('read', 'data.read-key', { record: output('record') }, { key: 'nested', valueType: 'record' }),
      { kind: 'return', id: 'done', values: { value: output('read'), defined: output('read', 'defined') } },
    ], [{ name: 'value', type: { kind: 'nullable', value: 'record' } }, { name: 'defined', type: 'boolean' }])
    const recordOnlyPair = compilePair(recordOnly)
    expect(execute(
      compileGameplayModuleGraph(recordOnlyPair.migrated, recordOnlyPair.registry).code,
      runtime({ record: { nested: 1 } }).context,
      runtime({ record: { nested: 1 } }).battle,
      runtime({ record: { nested: 1 } }).flow,
    )).toEqual({ value: undefined, defined: undefined })
    const listRecordHost = runtime({ record: { nested: [1] } })
    expect(execute(
      compileGameplayModuleGraph(recordOnlyPair.migrated, recordOnlyPair.registry).code,
      listRecordHost.context,
      listRecordHost.battle,
      listRecordHost.flow,
    )).toEqual({ value: undefined, defined: undefined })

    let getterReads = 0
    const accessorRecord: Record<string, unknown> = {}
    Object.defineProperty(accessorRecord, 'nested', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1
        return { safe: true }
      },
    })
    const accessorHost = runtime({ record: accessorRecord })
    expect(execute(
      compileGameplayModuleGraph(pair.migrated, pair.registry).code,
      accessorHost.context,
      accessorHost.battle,
      accessorHost.flow,
    )).toEqual({ value: undefined, defined: undefined })
    expect(getterReads).toBe(0)

    let cellGetterReads = 0
    const cellValue: Record<string, unknown> = {}
    Object.defineProperty(cellValue, 'x', {
      configurable: true,
      enumerable: true,
      get: () => {
        cellGetterReads += 1
        return 2
      },
    })
    Object.defineProperty(cellValue, 'y', { configurable: true, enumerable: true, value: 3, writable: true })
    const cellRead = graph([
      call('record', 'test.record'),
      call('read', 'data.read-key', { record: output('record') }, { key: 'cell', valueType: JSON.stringify({ kind: 'nullable', value: 'cell' }) }),
      { kind: 'return', id: 'done', values: { value: output('read'), defined: output('read', 'defined') } },
    ], [{ name: 'value', type: { kind: 'nullable', value: 'cell' } }, { name: 'defined', type: 'boolean' }])
    const cellHost = runtime({ record: { cell: cellValue } })
    expect(execute(
      compileGameplayModuleGraph(cellRead, pair.registry).code,
      cellHost.context,
      cellHost.battle,
      cellHost.flow,
    )).toEqual({ value: undefined, defined: undefined })
    expect(cellGetterReads).toBe(0)

    const invalidList = graph([
      call('record', 'test.record'),
      call('read', 'data.read-key', { record: output('record') }, { key: 'nested', valueType: JSON.stringify(nullableNumberListType) }),
      { kind: 'return', id: 'done', values: { value: output('read'), defined: output('read', 'defined') } },
    ], [{ name: 'value', type: nullableNumberListType }, { name: 'defined', type: 'boolean' }])
    const invalidListPair = compilePair(invalidList)
    const invalidListHost = runtime({ record: { nested: [1, null] } })
    expect(execute(
      compileGameplayModuleGraph(invalidListPair.migrated, invalidListPair.registry).code,
      invalidListHost.context,
      invalidListHost.battle,
      invalidListHost.flow,
    )).toEqual({ value: undefined, defined: undefined })
    expect(() => compileGameplayModuleGraph(graph([
      call('record', 'test.record'),
      call('read', 'data.read-key', { record: output('record') }, { key: '__proto__', valueType: JSON.stringify(nullableStringType) }),
      { kind: 'return', id: 'done', value: output('read') },
    ], [{ name: 'value', type: nullableStringType }]), pair.registry)).toThrow(/safe direct record key/)
  })

  it('accepts a dynamic direct key while keeping the static key form compatible', () => {
    const dynamic = graph([
      call('record', 'test.record'),
      call('read', 'data.read-key', { record: output('record'), key: { kind: 'input', name: 'key' } }, {
        key: 'fallback', valueType: JSON.stringify(nullableStringType),
      }),
      { kind: 'return', id: 'done', values: { value: output('read'), defined: output('read', 'defined') } },
    ], [
      { name: 'value', type: nullableStringType },
      { name: 'defined', type: 'boolean' },
    ])
    const withDynamicInput: GameplayModuleGraph = {
      ...dynamic,
      inputs: [{ name: 'key', type: 'string' }],
      inputBindings: { key: 'nested' },
    }
    const pair = compilePair(withDynamicInput)
    const host = runtime({ record: { nested: 'dynamic', fallback: 'static' } })
    expect(execute(compileGameplayModuleGraph(pair.source, pair.registry).code, host.context, host.battle, host.flow)).toEqual({ value: 'dynamic', defined: true })

    const unsafe: GameplayModuleGraph = { ...withDynamicInput, inputBindings: { key: '__proto__' } }
    expect(execute(compileGameplayModuleGraph(unsafe, pair.registry).code, host.context, host.battle, host.flow)).toEqual({ value: undefined, defined: undefined })
  })

  it('exports only the bounded aliases and removes them from migrated graphs', () => {
    expect([...ATOMIC_EXTENSION_QUERY_MODULES]).toEqual(expect.arrayContaining([
      'extension.cells-for-source', 'extension.records-to-cells', 'extension.cell-record-source', 'extension.record-source',
      'event.path-cell-record-hits', 'status.valid-side-cells', 'marker.anchor-exists',
      'followup.primary-mangekyo-witness',
    ]))
    const source = graph([
      call('records', 'test.records'),
      call('source', 'test.piece'),
      call('cells', 'extension.cells-for-source', { cells: output('records'), source: output('source') }),
      { kind: 'return', id: 'done', value: output('cells', 'cells') },
    ], [{ name: 'value', type: { kind: 'list', element: 'cell' } }])
    const migrated = migrateExtensionQueryModules(source)
    const serialized = JSON.stringify(migrated.body)
    expect(serialized).not.toContain('extension.cells-for-source')
    expect(serialized).toContain('collection')
  })
})
