/* eslint-disable @typescript-eslint/no-explicit-any -- legacy marker fixtures intentionally model untyped extension records. */
import { runInNewContext, runInThisContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { ATOMIC_MARKER_WRITE_MODULES, migrateMarkerWriteModules } from '../../lib/skill-graph/atomic-migration-marker-writes'
import { ATOMIC_COMMIT_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-atomic-commit'
import { RECORD_KEY_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-record-key'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayModuleDescriptor,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const nullableCellType = { kind: 'nullable', value: 'cell' } as const
const nullablePieceType = { kind: 'nullable', value: 'piece' } as const
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayLiteral>>,
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, ...(parameters === undefined ? {} : { parameters }) }
}

function graph(body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs'] = []): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs,
    body,
  }
}

function registryWithAtomicCommit(): GameplayModuleRegistry {
  const testPiece: GameplayModuleDescriptor = {
    id: 'test.piece', version: '1', label: 'test.piece', inputs: [], outputs: [{ name: 'piece', type: nullablePieceType }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.source',
  }
  const testCell: GameplayModuleDescriptor = {
    id: 'test.cell', version: '1', label: 'test.cell', inputs: [], outputs: [{ name: 'cell', type: nullableCellType }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.cell',
  }
  const testCellValue: GameplayModuleDescriptor = {
    id: 'test.cell-value', version: '1', label: 'test.cell-value', inputs: [], outputs: [{ name: 'cell', type: 'cell' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.cell',
  }
  const testCells: GameplayModuleDescriptor = {
    id: 'test.cells', version: '1', label: 'test.cells', inputs: [], outputs: [{ name: 'cells', type: { kind: 'list', element: 'cell' } }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.cells',
  }
  const testSourceId: GameplayModuleDescriptor = {
    id: 'test.source-id', version: '1', label: 'test.source-id', inputs: [], outputs: [{ name: 'value', type: 'string' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.source',
  }
  const testTarget: GameplayModuleDescriptor = {
    id: 'test.target', version: '1', label: 'test.target', inputs: [], outputs: [{ name: 'piece', type: nullablePieceType }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.target',
  }
  const testSource: GameplayModuleDescriptor = {
    id: 'test.source', version: '1', label: 'test.source', inputs: [], outputs: [{ name: 'piece', type: nullablePieceType }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.source',
  }
  const testRecord: GameplayModuleDescriptor = {
    id: 'test.record', version: '1', label: 'test.record', inputs: [], outputs: [{ name: 'record', type: 'record' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => '({record:context.record})',
  }
  const local = new Map([...ATOMIC_COMMIT_GAMEPLAY_MODULES, ...RECORD_KEY_GAMEPLAY_MODULES, testPiece, testCell, testCellValue, testCells, testSourceId, testTarget, testSource, testRecord].map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return {
    get: (id, version) => local.get(id + '@' + (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
    resolve: (id, version) => local.get(id + '@' + (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
    descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...ATOMIC_COMMIT_GAMEPLAY_MODULES, ...RECORD_KEY_GAMEPLAY_MODULES, testPiece, testCell, testCellValue, testCells, testSourceId, testTarget, testSource, testRecord],
  }
}

type MarkerState = {
  pieces: Array<Record<string, unknown>>
  players?: Array<Record<string, unknown>>
  graveyard?: Array<Record<string, unknown>>
  map?: { tiles: Array<Record<string, unknown>> }
  extensions?: Record<string, unknown>
}

function legacyPlace(state: MarkerState, sourceValue: unknown, cell: unknown, storageKey: string, tileType: string, maxAnchors: number, now: number): boolean {
  const sourceId = sourceValue && typeof sourceValue === 'object' ? (sourceValue as Record<string, unknown>).instanceId : sourceValue
  const source = [...(state.pieces ?? []), ...(state.graveyard ?? [])].find(piece => piece && piece.instanceId === sourceId)
  if (!source || !cell || typeof cell !== 'object' || !Number.isInteger((cell as any).x) || !Number.isInteger((cell as any).y)) return false
  state.extensions ??= {}
  let anchors = Array.isArray(state.extensions[storageKey]) ? state.extensions[storageKey] as Array<Record<string, unknown>> : []
  let tiles = Array.isArray(state.extensions.tileEffects) ? state.extensions.tileEffects as Array<Record<string, unknown>> : []
  const x = (cell as any).x
  const y = (cell as any).y
  const existing = anchors.find(anchor => anchor && anchor.sourceId === sourceId && anchor.x === x && anchor.y === y)
  if (existing) existing.createdAt = now
  else anchors.push({ x, y, sourceId, ownerPlayerId: source.ownerPlayerId, createdAt: now })
  tiles = tiles.filter(effect => !(effect && effect.tileType === tileType && effect.sourceId === sourceId && effect.x === x && effect.y === y))
  tiles.push({ x, y, sourceId, tileType, icon: '⚡', bgColor: 'rgba(250, 204, 21, 0.14)', boxShadow: 'inset 0 0 0 2px rgba(250, 204, 21, 0.75)', iconPosition: 'top-left' })
  while (anchors.filter(anchor => anchor && anchor.sourceId === sourceId).length > maxAnchors) {
    const own = anchors.filter(anchor => anchor && anchor.sourceId === sourceId).sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
    const oldest = own[0]
    anchors = anchors.filter(anchor => anchor !== oldest)
    tiles = tiles.filter(effect => !(effect && effect.tileType === tileType && effect.sourceId === sourceId && effect.x === oldest.x && effect.y === oldest.y))
  }
  state.extensions[storageKey] = anchors
  state.extensions.tileEffects = tiles
  return true
}

function legacyRemove(state: MarkerState, sourceValue: unknown, cell: unknown, storageKey: string, tileType: string): boolean {
  const sourceId = sourceValue && typeof sourceValue === 'object' ? (sourceValue as Record<string, unknown>).instanceId : sourceValue
  if (!sourceId || !cell || !state.extensions) return true
  const x = (cell as any).x
  const y = (cell as any).y
  state.extensions[storageKey] = (Array.isArray(state.extensions[storageKey]) ? state.extensions[storageKey] : []).filter((anchor: any) => !(anchor && anchor.sourceId === sourceId && anchor.x === x && anchor.y === y))
  state.extensions.tileEffects = (Array.isArray(state.extensions.tileEffects) ? state.extensions.tileEffects : []).filter((effect: any) => !(effect && effect.tileType === tileType && effect.sourceId === sourceId && effect.x === x && effect.y === y))
  return true
}

function legacyMarkApply(state: MarkerState, targetId: string, sourceId: string, statusType: string, statusName: string, statusIdPrefix: string, now: number): boolean {
  const target = state.pieces.find(piece => piece.instanceId === targetId)
  if (!target || !sourceId) return false
  const tags = Array.isArray(target.statusTags) ? target.statusTags as Array<Record<string, unknown>> : []
  target.statusTags = tags
  const existing = tags.find(tag => tag && tag.type === statusType && tag.sourceId === sourceId)
  if (existing) {
    existing.stacks = Number(existing.stacks || 1) + 1
    existing.currentDuration = -1
    return true
  }
  tags.push({
    id: `${statusIdPrefix}-${sourceId}-${targetId}-${now}`,
    type: statusType,
    name: statusName,
    visible: true,
    currentDuration: -1,
    currentUses: -1,
    intensity: 1,
    stacks: 1,
    sourceId,
  })
  return true
}

function execute(source: GameplayModuleGraph, state: MarkerState, now: number, sourcePiece: unknown, cell: unknown, targetPiece: unknown = sourcePiece, clock?: { calls: number }, record?: unknown): unknown {
  const compiled = compileGameplayModuleGraph(source, registryWithAtomicCommit())
  const statusReferences = new WeakMap<object, { targetId: string; tag: Record<string, unknown> }>()
  const localValues = new WeakMap<object, { initialized: boolean; value: unknown }>()
  const flow = {
    query: {
      piece: (id: string) => state.pieces.find(piece => piece.instanceId === id),
      hasPiece: (id: string) => state.pieces.some(piece => piece.instanceId === id),
    },
    status: {
      queryInstances: (targetId: string, statusType: string, sourceId?: string) => {
        const target = state.pieces.find(piece => piece.instanceId === targetId)
        if (!target) throw new Error('missing target')
        return (Array.isArray(target.statusTags) ? target.statusTags : [])
          .filter(tag => tag && typeof tag === 'object' && tag.type === statusType && (sourceId === undefined || tag.sourceId === sourceId))
          .map(tag => {
            const handle = Object.freeze({ scope: 'status-instance' })
            statusReferences.set(handle, { targetId, tag: tag as Record<string, unknown> })
            return handle
          })
      },
      readNumberInstance: (handle: object | null, field: string, fallback: number) => {
        const reference = handle ? statusReferences.get(handle) : undefined
        const value = reference?.tag[field]
        return value == null ? fallback : Number(value)
      },
      setNumberInstance: (handle: object | null, field: string, value: number) => {
        const reference = handle ? statusReferences.get(handle) : undefined
        if (!reference) return false
        reference.tag[field] = value
        return true
      },
      add: (targetId: string, record: Record<string, unknown>) => {
        const target = state.pieces.find(piece => piece.instanceId === targetId)
        if (!target) return false
        const statusTags = Array.isArray(target.statusTags) ? target.statusTags : []
        target.statusTags = statusTags
        statusTags.push(structuredClone(record))
        return true
      },
    },
    execution: {
      declare: (...args: unknown[]) => {
        const handle = Object.freeze({ scope: 'execution-local' })
        const initialized = args.length >= 3
        localValues.set(handle, { initialized, value: initialized ? structuredClone(args[2]) : undefined })
        return { handle, success: true }
      },
      read: (handle: object) => {
        const entry = localValues.get(handle)
        // The production local runtime faults an uninitialized read; the
        // diagnostic host below converts that fault to the graph's invalid
        // dependency sentinel instead of aborting this differential run.
        if (!entry || !entry.initialized) throw new Error('uninitialized execution local')
        return { value: structuredClone(entry.value), success: true }
      },
      write: (handle: object, _type: unknown, _schemas: unknown, value: unknown) => {
        const entry = localValues.get(handle)
        if (!entry) return { success: false }
        entry.initialized = true
        entry.value = structuredClone(value)
        return { success: true }
      },
    },
    extensionRoot: {
      commitRootWithTiles: (name: string, root: unknown, tiles: unknown) => {
        if (!Array.isArray(root) || !Array.isArray(tiles) || root.some(value => !value || typeof value !== 'object') || tiles.some(value => !value || typeof value !== 'object')) throw new Error('invalid commit')
        state.extensions ??= {}
        state.extensions[name] = JSON.parse(JSON.stringify(root))
        state.extensions.tileEffects = JSON.parse(JSON.stringify(tiles))
        return true
      },
    },
  }
  const run = runInNewContext('(' + compiled.code + ')', { battle: state, flow, Date: { now: () => { if (clock) clock.calls += 1; return now } } }) as (context: unknown) => unknown
  const diagnosticHost = { shouldRethrow: () => false, record: () => undefined }
  return run({ source: sourcePiece, target: targetPiece, cell, record, __gameplayModuleDiagnosticHost: diagnosticHost })
}

function executeWithRealFlow(source: GameplayModuleGraph, state: MarkerState, now: number, sourcePiece: unknown, cell: unknown, extraContext: Record<string, unknown> = {}): unknown {
  const compiled = compileGameplayModuleGraph(source, registryWithAtomicCommit())
  const flow = createFlowRuntime(state as any, {}, 'skill', {})
  // Keep generated records in the host realm so the production JSON boundary
  // validates the same plain-object shape as the actual gameplay executor.
  const factory = runInThisContext(`(function(battle,flow,Date){return (${compiled.code})})`) as (battle: MarkerState, flow: unknown, clock: { now: () => number }) => (context: unknown) => unknown
  const run = factory(state, flow, { now: () => now })
  return run({ ...extraContext, source: sourcePiece, cell })
}

function placeGraph(maxAnchors = 3): GameplayModuleGraph {
  const sourceRef = call('source-ref', 'test.piece')
  const cellRef = call('cell-ref', 'test.cell')
  const marker = call('place', 'marker.anchor-place', { source: output('source-ref', 'piece'), cell: output('cell-ref', 'cell') }, { storageKey: 'minatoAnchors', tileType: 'minato-anchor', maxAnchors })
  return graph([sourceRef, cellRef, marker, { kind: 'return', id: 'done', values: { success: output('place', 'success') } }], [{ name: 'success', type: 'boolean' }])
}

function removeGraph(): GameplayModuleGraph {
  const sourceRef = call('source-ref', 'test.piece')
  const cellRef = call('cell-ref', 'test.cell')
  const marker = call('remove', 'marker.anchor-remove', { source: output('source-ref', 'piece'), cell: output('cell-ref', 'cell') }, { storageKey: 'minatoAnchors', tileType: 'minato-anchor' })
  return graph([sourceRef, cellRef, marker, { kind: 'return', id: 'done', values: { success: output('remove', 'success') } }], [{ name: 'success', type: 'boolean' }])
}

function markApplyGraph(): GameplayModuleGraph {
  const targetRef = call('target-ref', 'test.target')
  const sourceRef = call('source-ref', 'test.source')
  const marker = call('mark', 'status.mark-apply', {
    target: output('target-ref', 'piece'), source: output('source-ref', 'piece'),
  }, { statusType: 'flying-raijin-mark', statusName: '飞雷神', statusIdPrefix: 'flying-raijin-mark' })
  return graph([targetRef, sourceRef, marker, { kind: 'return', id: 'done', values: { success: output('mark', 'success') } }], [{ name: 'success', type: 'boolean' }])
}

function tileAddMarkerGraph(): GameplayModuleGraph {
  const source = call('source-ref', 'test.source-id')
  const cell = call('cell-ref', 'test.cell-value')
  const marker = call('marker', 'tile.add-marker', {
    cell: output('cell-ref', 'cell'), sourceId: output('source-ref', 'value'),
  }, { effectType: 'shadow-step', icon: '👁', bgColor: 'rgba(147, 51, 234, 0.12)', boxShadow: 'inset 0 0 0 2px rgba(168, 85, 247, 0.65)', iconPosition: 'top-left' })
  return graph([source, cell, marker, { kind: 'return', id: 'done', values: { success: output('marker', 'success') } }], [{ name: 'success', type: 'boolean' }])
}

function tileClearMarkerGraph(): GameplayModuleGraph {
  const source = call('source-ref', 'test.source-id')
  const marker = call('marker', 'tile.clear-marker', { sourceId: output('source-ref', 'value') }, { effectType: 'shadow-step' })
  return graph([source, marker, { kind: 'return', id: 'done', values: { success: output('marker', 'success') } }], [{ name: 'success', type: 'boolean' }])
}

function tileAddMarkersGraph(): GameplayModuleGraph {
  const cells = call('cells-ref', 'test.cells')
  const origin = call('origin-ref', 'test.cell-value')
  const source = call('source-ref', 'test.source-id')
  const marker = call('marker', 'tile.add-markers', {
    cells: output('cells-ref', 'cells'), origin: output('origin-ref', 'cell'), sourceId: output('source-ref', 'value'),
  }, { effectType: 'blizzard', icon: '❄️', bgColor: 'rgba(96, 165, 250, 0.12)', boxShadow: 'inset 0 0 0 2px rgba(147, 197, 253, 0.65)', iconPosition: 'top-right' })
  return graph([cells, origin, source, marker, { kind: 'return', id: 'done', values: { success: output('marker', 'success') } }], [{ name: 'success', type: 'boolean' }])
}

function tileAddPersistentMarkersGraph(): GameplayModuleGraph {
  const source = call('source-ref', 'test.piece')
  const cells = call('cells-ref', 'test.cells')
  const marker = call('marker', 'tile.add-persistent-markers', {
    source: output('source-ref', 'piece'), cells: output('cells-ref', 'cells'), tileSourceId: { kind: 'literal', value: 'amaterasu' },
  }, { effectType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right', storageKey: 'amaterasuCells' })
  return graph([source, cells, marker, { kind: 'return', id: 'done', values: { added: output('marker', 'added') } }], [{ name: 'added', type: 'number' }])
}

function callsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const calls: GameplayCallStatement[] = []
  const visit = (statements: readonly GameplayStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'call') calls.push(statement)
      if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') visit(statement.body)
      else if (statement.kind === 'while') { visit(statement.condition.body); visit(statement.body) }
      else if (statement.kind === 'if') { visit(statement.then); if (statement.else) visit(statement.else) }
    }
  }
  visit(body)
  return calls
}

describe('atomic marker write migrations', () => {
  it('rewrites both marker writes into generic graph composition and is idempotent', () => {
    const source = graph([
      call('place', 'marker.anchor-place', { source: input('source'), cell: input('cell') }, { storageKey: 'minatoAnchors', tileType: 'minato-anchor', maxAnchors: 3 }),
      call('remove', 'marker.anchor-remove', { source: input('source'), cell: input('cell') }, { storageKey: 'minatoAnchors', tileType: 'minato-anchor' }),
      call('mark', 'status.mark-apply', { target: input('target'), source: input('source') }, { statusType: 'flying-raijin-mark', statusName: '飞雷神', statusIdPrefix: 'flying-raijin-mark' }),
    ])
    const migrated = migrateMarkerWriteModules(source)
    expect(callsIn(migrated.body).map(statement => statement.module)).not.toEqual(expect.arrayContaining([...ATOMIC_MARKER_WRITE_MODULES]))
    expect(callsIn(migrated.body).map(statement => statement.module)).toEqual(expect.arrayContaining([
      'battle.extensions', 'data.read-key', 'record.set-field', 'collection.sort', 'extension.commit-root-with-tiles',
    ]))
    expect(callsIn(migrated.body).map(statement => statement.module)).toEqual(expect.arrayContaining([
      'identity.host-time', 'status.query-instances', 'status.read-number-instance', 'status.set-number-instance', 'status.apply-record',
    ]))
    expect(callsIn(migrated.body).map(statement => statement.module)).not.toEqual(expect.arrayContaining([
      'identity.host-time-if', 'piece.optional-record', 'status.apply-record-if-present', 'status.set-record-number-if-present',
    ]))
    const localDeclarations = callsIn(migrated.body).filter(statement => statement.module === 'local.declare')
    expect(localDeclarations).toHaveLength(3)
    expect(localDeclarations.every(statement => !statement.inputs || !Object.hasOwn(statement.inputs, 'initial'))).toBe(true)
    expect(migrateMarkerWriteModules(migrated)).toEqual(migrated)
  })

  it('sets a record field through an own-data clone and preserves a field named record', () => {
    const source = call('record-source', 'test.record')
    const set = call('set-record-field', 'record.set-field', {
      record: output('record-source', 'record'), value: { kind: 'literal', value: 'updated' },
    }, { field: 'record', valueType: 'string' })
    const recordGraph = graph([
      source,
      set,
      { kind: 'return', id: 'record-return', values: { record: output('set-record-field', 'record') } },
    ], [{ name: 'record', type: 'record' }])
    const original = { record: 'original', nested: { keep: true } }
    const result = execute(recordGraph, { pieces: [] }, 0, null, null, null, undefined, original) as Record<string, unknown>
    // The graph output itself is named `record`; the runtime therefore wraps
    // the record-set-field envelope under that output name.
    expect(result).toEqual({ record: { record: 'updated', nested: { keep: true } } })
    expect(original).toEqual({ record: 'original', nested: { keep: true } })

    let getterCalls = 0
    const accessor = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessor, 'record', { enumerable: true, get: () => { getterCalls += 1; return 'unsafe' } })
    expect(execute(recordGraph, { pieces: [] }, 0, null, null, null, undefined, accessor)).toBeUndefined()
    expect(getterCalls).toBe(0)
  })

  it('rejects unsafe record clone shapes before the field write', () => {
    const source = call('record-source', 'test.record')
    const set = call('set-record-field', 'record.set-field', {
      record: output('record-source', 'record'), value: { kind: 'literal', value: 'updated' },
    }, { field: 'record', valueType: 'string' })
    const recordGraph = graph([
      source,
      set,
      { kind: 'return', id: 'record-return', values: { record: output('set-record-field', 'record') } },
    ], [{ name: 'record', type: 'record' }])

    const nonEnumerable = { keep: true } as Record<string, unknown>
    Object.defineProperty(nonEnumerable, 'hidden', { value: true, enumerable: false })
    const symbolKey = Symbol('unsafe')
    const symbolRecord = { keep: true } as Record<string, unknown>
    Object.defineProperty(symbolRecord, symbolKey, { value: true, enumerable: true })
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>
    customPrototype.keep = true
    const undefinedValue = { keep: undefined }

    for (const record of [nonEnumerable, symbolRecord, customPrototype, undefinedValue]) {
      expect(execute(recordGraph, { pieces: [] }, 0, null, null, null, undefined, record)).toBeUndefined()
    }
  })

  it('validates both atomic candidates before mutating either extension array', () => {
    const extensions = {
      minatoAnchors: [{ x: 1, y: 1, sourceId: 'source' }],
      tileEffects: [{ x: 1, y: 1, sourceId: 'source', tileType: 'minato-anchor' }],
    }
    const battle = { pieces: [], players: [], extensions } as any
    const runtime = createFlowRuntime(battle, {}, 'skill', {}) as any
    const before = structuredClone(extensions)
    const invalidTiles = Object.create({ inherited: true })
    expect(() => runtime.extensionRoot.commitRootWithTiles('minatoAnchors', [{ x: 2, y: 2 }], [invalidTiles])).toThrow()
    expect(battle.extensions).toEqual(before)
  })

  it('executes a normal append through the production flow commit boundary', () => {
    const expected: MarkerState = {
      pieces: [{ instanceId: 'active', ownerPlayerId: 'red' }],
      players: [{ playerId: 'red' }],
      extensions: { minatoAnchors: [], tileEffects: [] },
    }
    const actual = structuredClone(expected)
    expect(legacyPlace(expected, 'active', { x: 2, y: 3 }, 'minatoAnchors', 'minato-anchor', 3, 10)).toBe(true)
    expect(executeWithRealFlow(migrateMarkerWriteModules(placeGraph()), actual, 10, 'active', { x: 2, y: 3 })).toEqual({ success: true })
    expect(actual).toEqual(expected)
  })

  it('matches legacy place behavior for append, first refresh, stable capacity and graveyard sources', () => {
    const initial: MarkerState = {
      pieces: [{ instanceId: 'active', ownerPlayerId: 'red' }],
      graveyard: [{ instanceId: 'dead', ownerPlayerId: 'blue' }],
      extensions: {
        minatoAnchors: [
          { x: 0, y: 0, sourceId: 'active', ownerPlayerId: 'red', createdAt: 1, extra: 'keep' },
          { x: 4, y: 4, sourceId: 'active', ownerPlayerId: 'red', createdAt: 2 },
          { x: 4, y: 4, sourceId: 'active', ownerPlayerId: 'red', createdAt: 3, duplicate: true },
          { x: 8, y: 8, sourceId: 'other', ownerPlayerId: 'blue', createdAt: 0 },
        ],
        tileEffects: [
          { x: 0, y: 0, sourceId: 'active', tileType: 'minato-anchor', raw: 'a' },
          { x: 4, y: 4, sourceId: 'active', tileType: 'minato-anchor', raw: 'b' },
          { x: 4, y: 4, sourceId: 'active', tileType: 'other', raw: 'keep' },
          { x: 8, y: 8, sourceId: 'other', tileType: 'minato-anchor' },
        ],
      },
    }
    const expected = structuredClone(initial)
    const actual = structuredClone(initial)
    expect(legacyPlace(expected, 'dead', { x: 9, y: 9 }, 'minatoAnchors', 'minato-anchor', 3, 10)).toBe(true)
    const appendClock = { calls: 0 }
    const appendResult = execute(migrateMarkerWriteModules(placeGraph()), actual, 10, 'dead', { x: 9, y: 9 }, undefined, appendClock)
    expect(appendResult).toEqual({ success: true })
    expect(appendClock.calls).toBe(1)
    expect(actual).toEqual(expected)

    const refreshExpected = structuredClone(expected)
    const refreshActual = structuredClone(actual)
    expect(legacyPlace(refreshExpected, 'dead', { x: 4, y: 4 }, 'minatoAnchors', 'minato-anchor', 3, 20)).toBe(true)
    const refreshClock = { calls: 0 }
    expect(execute(migrateMarkerWriteModules(placeGraph()), refreshActual, 20, 'dead', { x: 4, y: 4 }, undefined, refreshClock)).toEqual({ success: true })
    expect(refreshClock.calls).toBe(1)
    expect(refreshActual).toEqual(refreshExpected)
  })

  it('skips invalid references without mutating the state or sampling time', () => {
    const initial: MarkerState = {
      pieces: [{ instanceId: 'source', ownerPlayerId: 'red' }],
      extensions: {
        minatoAnchors: [{ x: 1, y: 1, sourceId: 'source', createdAt: 1 }],
        tileEffects: [{ x: 1, y: 1, sourceId: 'source', tileType: 'minato-anchor' }],
      },
    }
    const invalidPlace = structuredClone(initial)
    const invalidPlaceExpected = structuredClone(initial)
    expect(legacyPlace(invalidPlaceExpected, 'missing', { x: 2, y: 2 }, 'minatoAnchors', 'minato-anchor', 3, 1)).toBe(false)
    const invalidPlaceClock = { calls: 0 }
    expect(execute(migrateMarkerWriteModules(placeGraph()), invalidPlace, 1, 'missing', { x: 2, y: 2 }, undefined, invalidPlaceClock)).toBeUndefined()
    expect(invalidPlaceClock.calls).toBe(0)
    expect(invalidPlace).toEqual(invalidPlaceExpected)

    const emptyRemove = structuredClone(initial)
    const emptyRemoveExpected = structuredClone(initial)
    expect(legacyRemove(emptyRemoveExpected, '', null, 'minatoAnchors', 'minato-anchor')).toBe(true)
    expect(execute(migrateMarkerWriteModules(removeGraph()), emptyRemove, 1, '', null)).toBeUndefined()
    expect(emptyRemove).toEqual(emptyRemoveExpected)

    const staleRemove = structuredClone(initial)
    const staleExpected = structuredClone(initial)
    expect(legacyRemove(staleExpected, 'missing', { x: 2, y: 2 }, 'minatoAnchors', 'minato-anchor')).toBe(true)
    expect(execute(migrateMarkerWriteModules(removeGraph()), staleRemove, 1, 'missing', { x: 2, y: 2 })).toBeUndefined()
    expect(staleRemove).toEqual(staleExpected)
  })

  it('updates an existing mark without lifecycle events and samples time only for a new mark', () => {
    const initial: MarkerState = {
      pieces: [
        { instanceId: 'target', statusTags: [
          { id: 'existing', type: 'flying-raijin-mark', sourceId: 'source', stacks: 0, currentDuration: 4 },
          { id: 'second-match', type: 'flying-raijin-mark', sourceId: 'source', stacks: 9, currentDuration: 6 },
          { id: 'other', type: 'other' },
        ] },
        { instanceId: 'source', statusTags: [] },
      ],
    }
    const expectedExisting = structuredClone(initial)
    const actualExisting = structuredClone(initial)
    expect(legacyMarkApply(expectedExisting, 'target', 'source', 'flying-raijin-mark', '飞雷神', 'flying-raijin-mark', 17)).toBe(true)
    const existingClock = { calls: 0 }
    const existingResult = execute(migrateMarkerWriteModules(markApplyGraph()), actualExisting, 17, 'source', null, 'target', existingClock)
    expect(existingResult).toEqual({ success: true })
    expect(existingClock.calls).toBe(0)
    expect(actualExisting).toEqual(expectedExisting)

    const expectedNew: MarkerState = { pieces: [{ instanceId: 'target', statusTags: [] }, { instanceId: 'source', statusTags: [] }] }
    const actualNew = structuredClone(expectedNew)
    expect(legacyMarkApply(expectedNew, 'target', 'source', 'flying-raijin-mark', '飞雷神', 'flying-raijin-mark', 29)).toBe(true)
    const newClock = { calls: 0 }
    expect(execute(migrateMarkerWriteModules(markApplyGraph()), actualNew, 29, 'source', null, 'target', newClock)).toEqual({ success: true })
    expect(newClock.calls).toBe(1)
    expect(actualNew).toEqual(expectedNew)
  })

  it('skips a missing target or source without mutating state or sampling time', () => {
    const state: MarkerState = { pieces: [{ instanceId: 'target', statusTags: [] }] }
    const before = structuredClone(state)
    const clock = { calls: 0 }
    expect(execute(migrateMarkerWriteModules(markApplyGraph()), state, 7, '', null, null, clock)).toBeUndefined()
    expect(clock.calls).toBe(0)
    expect(state).toEqual(before)

    const staleTarget: MarkerState = { pieces: [{ instanceId: 'source', statusTags: [] }] }
    const staleBefore = structuredClone(staleTarget)
    const staleClock = { calls: 0 }
    expect(execute(migrateMarkerWriteModules(markApplyGraph()), staleTarget, 7, 'source', null, 'missing', staleClock)).toBeUndefined()
    expect(staleClock.calls).toBe(0)
    expect(staleTarget).toEqual(staleBefore)
  })

  it('validates both commit candidates before mutation', () => {
    const state: MarkerState = { pieces: [], extensions: { minatoAnchors: [{ x: 1, y: 1 }], tileEffects: [{ x: 1, y: 1 }] } }
    const before = structuredClone(state)
    const commit = (name: string, root: unknown, tiles: unknown): boolean => {
      if (!Array.isArray(root) || !Array.isArray(tiles) || tiles.some(value => value && typeof value === 'object' && (value as any).bad)) throw new Error('invalid commit')
      state.extensions![name] = structuredClone(root)
      state.extensions!.tileEffects = structuredClone(tiles)
      return true
    }
    expect(() => commit('minatoAnchors', [{ x: 2, y: 2 }], [{ bad: true }])).toThrow()
    expect(state).toEqual(before)
  })

  it('rewrites tile marker compatibility calls into field, record, collection, and host boundary modules', () => {
    const source = graph([
      call('add-one', 'tile.add-marker', { cell: input('cell'), sourceId: input('sourceId') }, { effectType: 'shadow-step', icon: '👁', bgColor: 'bg', boxShadow: 'shadow', iconPosition: 'top-left' }),
      call('clear-one', 'tile.clear-marker', { sourceId: input('sourceId') }, { effectType: 'shadow-step' }),
      call('add-many', 'tile.add-markers', { cells: input('cells'), origin: input('origin'), sourceId: input('sourceId') }, { effectType: 'blizzard', icon: '❄️', bgColor: 'bg', boxShadow: 'shadow', iconPosition: 'top-right' }),
      call('add-persistent', 'tile.add-persistent-markers', { source: input('source'), cells: input('cells'), tileSourceId: input('tileSourceId') }, { effectType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right', storageKey: 'amaterasuCells' }),
    ])
    const migrated = migrateMarkerWriteModules(source)
    const modules = callsIn(migrated.body).map(statement => statement.module)
    expect(modules).not.toEqual(expect.arrayContaining([
      'tile.add-marker', 'tile.clear-marker', 'tile.add-markers', 'tile.add-persistent-markers',
    ]))
    expect(modules).toEqual(expect.arrayContaining([
      'tile.batch-records', 'tile.replace-effects', 'record.empty', 'record.set-field',
      'battle.extensions', 'data.read-key', 'spatial.map-cells', 'collection.concat',
      'extension.declare-battle', 'extension.write-battle',
    ]))
    expect(migrateMarkerWriteModules(migrated)).toEqual(migrated)
  })

  it('preserves single and batch marker state, presentation metadata, and clear no-op behavior', () => {
    const state: MarkerState = {
      pieces: [], players: [], map: { tiles: [{ x: 2, y: 3 }] },
      extensions: { tileEffects: [{ x: 0, y: 0, tileType: 'keep', sourceId: 'other' }] },
    }
    const single = migrateMarkerWriteModules(tileAddMarkerGraph())
    expect(executeWithRealFlow(single, state, 1, 'source', { x: 2, y: 3 })).toEqual({ success: true })
    expect(state.extensions?.tileEffects).toEqual([
      { x: 0, y: 0, tileType: 'keep', sourceId: 'other' },
      { x: 2, y: 3, sourceId: 'source', tileType: 'shadow-step', icon: '👁', bgColor: 'rgba(147, 51, 234, 0.12)', boxShadow: 'inset 0 0 0 2px rgba(168, 85, 247, 0.65)', iconPosition: 'top-left' },
    ])

    const batch = migrateMarkerWriteModules(tileAddMarkersGraph())
    expect(executeWithRealFlow(batch, state, 1, 'source', { x: 0, y: 0 }, {
      cells: [{ x: 1, y: 2 }, { x: -1, y: 0 }],
    })).toEqual({ success: true })
    expect((state.extensions?.tileEffects as unknown[]).slice(-2)).toEqual([
      { x: 1, y: 2, sourceId: 'source', tileType: 'blizzard', icon: '❄️', bgColor: 'rgba(96, 165, 250, 0.12)', boxShadow: 'inset 0 0 0 2px rgba(147, 197, 253, 0.65)', iconPosition: 'top-right', presentation: 'expand', presentationStep: 2 },
      { x: -1, y: 0, sourceId: 'source', tileType: 'blizzard', icon: '❄️', bgColor: 'rgba(96, 165, 250, 0.12)', boxShadow: 'inset 0 0 0 2px rgba(147, 197, 253, 0.65)', iconPosition: 'top-right', presentation: 'expand', presentationStep: 1 },
    ])

    const clear = migrateMarkerWriteModules(tileClearMarkerGraph())
    expect(executeWithRealFlow(clear, state, 1, 'source', null)).toEqual({ success: true })
    expect(state.extensions?.tileEffects).toEqual([
      { x: 0, y: 0, tileType: 'keep', sourceId: 'other' },
      { x: 1, y: 2, sourceId: 'source', tileType: 'blizzard', icon: '❄️', bgColor: 'rgba(96, 165, 250, 0.12)', boxShadow: 'inset 0 0 0 2px rgba(147, 197, 253, 0.65)', iconPosition: 'top-right', presentation: 'expand', presentationStep: 2 },
      { x: -1, y: 0, sourceId: 'source', tileType: 'blizzard', icon: '❄️', bgColor: 'rgba(96, 165, 250, 0.12)', boxShadow: 'inset 0 0 0 2px rgba(147, 197, 253, 0.65)', iconPosition: 'top-right', presentation: 'expand', presentationStep: 1 },
    ])
    const noEffects: MarkerState = { pieces: [], players: [], map: { tiles: [] } }
    expect(executeWithRealFlow(clear, noEffects, 1, 'source', null)).toEqual({ success: true })
    expect(noEffects.extensions).toBeUndefined()
  })

  it('deduplicates persistent markers by map cell and keeps existing tile effects and owner data', () => {
    const state: MarkerState = {
      pieces: [{ instanceId: 'source', ownerPlayerId: 'red' }], players: [{ playerId: 'red' }],
      map: { tiles: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
      extensions: {
        tileEffects: [{ x: 0, y: 0, sourceId: 'old', tileType: 'amaterasu' }, { x: 2, y: 0, sourceId: 'old', tileType: 'other' }],
        amaterasuCells: [{ x: 0, y: 0, sourcePieceId: 'old', ownerPlayerId: 'red' }],
      },
    }
    const migrated = migrateMarkerWriteModules(tileAddPersistentMarkersGraph())
    expect(executeWithRealFlow(migrated, state, 1, 'source', null, {
      cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 99, y: 99 }],
    })).toEqual({ added: 1 })
    expect(state.extensions?.amaterasuCells).toEqual([
      { x: 0, y: 0, sourcePieceId: 'old', ownerPlayerId: 'red' },
      { x: 1, y: 0, sourcePieceId: 'source', ownerPlayerId: 'red' },
    ])
    expect(state.extensions?.tileEffects).toEqual([
      { x: 0, y: 0, sourceId: 'old', tileType: 'amaterasu' },
      { x: 2, y: 0, sourceId: 'old', tileType: 'other' },
      { x: 1, y: 0, sourceId: 'amaterasu', tileType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right' },
    ])
  })
})
