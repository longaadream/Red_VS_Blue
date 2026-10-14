import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ATOMIC_STATUS_FIELD_MODULES, migrateStatusFieldModules } from '../../lib/skill-graph/atomic-migration-status-fields'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { RECORD_KEY_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-record-key'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'

const registry = {
  get: (id: string, requestedVersion?: string) => {
    if (id === 'data.read-key' && (requestedVersion === undefined || requestedVersion === '1')) return RECORD_KEY_GAMEPLAY_MODULES[0]
    return GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion)
  },
}

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayLiteral>>,
  extra: Partial<GameplayCallStatement> = {},
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
    ...extra,
  }
}

function graph(body: readonly GameplayStatement[], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, ...extra }
}

function callsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  const visit = (statements: readonly GameplayStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'call') result.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        if (statement.else) visit(statement.else)
      } else if (statement.kind === 'while') {
        visit(statement.condition.body)
        visit(statement.body)
      } else if (statement.kind === 'foreach') {
        visit(statement.body)
      } else if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') {
        visit(statement.body)
      }
    }
  }
  visit(body)
  return result
}

function execute(source: GameplayModuleGraph, context: Record<string, unknown> = {}): { compiled: ReturnType<typeof compileGameplayModuleGraph>; value: unknown } {
  const compiled = compileGameplayModuleGraph(source, registry)
  const run = runInNewContext('(' + compiled.code + ')', context) as (globals: unknown) => unknown
  return { compiled, value: run({}) }
}

const pieces: Record<string, Record<string, unknown>> = {
  target: {
    instanceId: 'target',
    statusTags: [
      { id: 'mark-1', type: 'mark', turnNumber: 3, intensity: 0, damage: 0, sourceId: 'source' },
      { id: 'mark-2', type: 'mark', turnNumber: 7, intensity: 4, damage: 12, sourceId: 'source', createdTurnNumber: 5 },
      { id: 'other', type: 'other', turnNumber: 7, intensity: 8 },
      { id: 'before', type: 'mark', sourceId: 'source', createdTurnNumber: 2 },
    ],
  },
  source: { instanceId: 'source', statusTags: [] },
}

const players: Record<string, Record<string, unknown>> = {
  red: {
    playerId: 'red',
    statusTags: [
      { id: 'storm', type: 'lethal-toxin', value: 0, extraValue: 4, centerX: 0, centerY: 2, sourceId: '' },
      { id: 'storm-2', type: 'lethal-toxin', value: 3, extraValue: 4, sourceId: 'source' },
    ],
  },
}

function runtime(
  statusRecords: Record<string, Record<string, unknown>> = {},
  world: { pieces?: Record<string, Record<string, unknown>>; players?: Record<string, Record<string, unknown>> } = {},
): Record<string, unknown> {
  const worldPieces = world.pieces ?? pieces
  const worldPlayers = world.players ?? players
  const localValues = new WeakMap<object, unknown>()
  return {
    flow: {
      execution: {
        declare: (_type: unknown, _schemas: unknown, initial: unknown) => {
          const handle = Object.freeze(Object.create(null)) as object
          localValues.set(handle, structuredClone(initial))
          return { handle, success: true }
        },
        read: (handle: object) => {
          if (!localValues.has(handle)) throw new Error('local handle expired')
          return { value: structuredClone(localValues.get(handle)), success: true }
        },
        write: (handle: object, _type: unknown, _schemas: unknown, value: unknown) => {
          if (!localValues.has(handle)) throw new Error('local handle expired')
          localValues.set(handle, structuredClone(value))
          return { success: true }
        },
      },
      query: {
        pieces: () => Object.keys(worldPieces),
        piece: (id: string) => worldPieces[id] ?? null,
        hasPiece: (id: string) => worldPieces[id] !== undefined,
        player: (id: string) => worldPlayers[id] ?? null,
        hasPlayer: (id: string) => worldPlayers[id] !== undefined,
      },
      refs: { target: () => 'target', source: () => 'source', player: () => 'red' },
      status: {
        findInstance: () => 'status-1',
        fields: (status: string | null) => {
          if (status === null) throw new Error('status instance expired')
          return statusRecords[status] ?? null
        },
        readNumberInstance: (status: string | null, field: string, fallback: number) => {
          const value = status === null ? undefined : statusRecords[status]?.[field]
          return value == null ? fallback : Number(value)
        },
      },
    },
  }
}

describe('atomic status reader migrations', () => {
  it('rewrites every bounded status alias through typed generic primitives, including nested scopes', () => {
    const source = graph([
      call('find', 'status.find-id', { piece: input('piece') }, { statusType: 'mark' }, { layout: { x: 1 } }),
      call('find-by-id', 'status.find-id-by-id', { piece: input('piece'), statusId: input('statusId') }),
      call('find-by-prefix', 'status.find-id-by-prefix', { piece: input('piece') }, { prefix: 'mark-' }),
      call('find-by-number', 'status.find-id-by-number', { piece: input('piece'), value: input('value') }, { statusType: 'mark', field: 'turnNumber' }),
      call('list', 'status.list-ids', { piece: input('piece') }, { statusType: 'mark' }),
      call('read', 'status.read-number', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'intensity' }),
      call('record-read', 'status.read-record-number', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'hitCount' }),
      call('field-read', 'status.read-number-field', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'damage' }),
      call('instance-read', 'status.read-number-instance', { status: input('status'), fallback: input('fallback') }, { field: 'intensity' }),
      call('truthy-read', 'status.read-number-truthy', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'intensity' }),
      call('duration', 'status.read-duration', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('uses', 'status.read-uses', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('uses-fallback', 'status.read-uses-fallback', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('turn', 'status.read-turn-number', { piece: input('piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('player-number', 'status.read-player-number', { player: input('player'), statusId: input('statusId') , fallback: input('fallback') }, { field: 'centerX' }),
      call('player-truthy', 'status.read-player-number-truthy', { player: input('player'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'value' }),
      call('player-text', 'status.read-player-text-field', { player: input('player'), statusId: input('statusId') }, { field: 'sourceId' }),
      call('text', 'status.read-text-field', { piece: input('piece'), statusId: input('statusId'), fallback: input('textFallback') }, { field: 'kind' }),
      call('player-id', 'status.find-player-id', { player: input('player') }, { statusType: 'lethal-toxin' }),
      call('player-id-at', 'status.find-player-id-at', { player: input('player'), x: input('x'), y: input('y') }, { statusType: 'lethal-toxin' }),
      call('source-before', 'status.find-source-before-id', { piece: input('piece'), source: input('source'), turn: input('turn') }, { statusType: 'mark' }),
      call('cell', 'status.read-cell-field', { piece: input('piece'), statusId: input('statusId') }, { field: 'left' }),
      call('cells', 'status.read-cell-list', { piece: input('piece'), statusId: input('statusId') }, { field: 'pathCells' }),
    ], {
      inputs: [
        { name: 'piece', type: 'piece' }, { name: 'source', type: 'piece' }, { name: 'player', type: 'player' },
        { name: 'status', type: 'status', nullable: true }, { name: 'statusId', type: 'string', nullable: true },
        { name: 'value', type: 'number' }, { name: 'fallback', type: 'number' }, { name: 'x', type: 'number' },
        { name: 'y', type: 'number' }, { name: 'turn', type: 'number' }, { name: 'textFallback', type: 'string' },
      ],
      composites: [{ id: 'nested', version, inputs: [], outputs: [], body: [call('nested-find', 'status.find-id', { piece: input('piece') }, { statusType: 'mark' })] }],
      continuations: [{ id: 'later', version, graph: graph([call('later-list', 'status.list-ids', { piece: input('piece') }, { statusType: 'mark' })]) }],
    })
    const migrated = migrateStatusFieldModules(source)
    const modules = callsIn(migrated.body).map(statement => statement.module)
    expect(modules).not.toEqual(expect.arrayContaining([...ATOMIC_STATUS_FIELD_MODULES]))
    expect(modules).toEqual(expect.arrayContaining([
      'piece.field', 'player.field', 'data.optional-field', 'value.coalesce', 'compare.values',
      'logic.select', 'logic.and', 'status.fields',
    ]))
    expect(callsIn(migrated.body).find(statement => statement.id === 'find')?.layout).toEqual({ x: 1 })
    expect(migrateStatusFieldModules(migrated)).toEqual(migrated)
    expect(callsIn(migrated.composites![0].body).map(statement => statement.module)).not.toContain('status.find-id')
    expect(callsIn(migrated.continuations![0].graph.body).map(statement => statement.module)).not.toContain('status.list-ids')
  })

  it('rewrites the captured status owner into a nullable typed player field', () => {
    const source = graph([
      call('piece-ref', 'ref.target'),
      call('piece', 'query.piece', { pieceId: output('piece-ref', 'piece') }),
      call('owner', 'status.read-player-field', { piece: output('piece', 'piece'), statusId: input('statusId') }, { field: 'ownerPlayerId' }),
      { kind: 'return', id: 'done', values: { owner: output('owner', 'player') } },
    ], {
      inputs: [{ name: 'statusId', type: 'string', nullable: true }],
      inputBindings: { statusId: 'burn' },
      outputs: [{ name: 'owner', type: 'player', nullable: true }],
    })
    const world = { pieces: {
      target: { instanceId: 'target', statusTags: [{ id: 'burn', type: 'amaterasu-burn', ownerPlayerId: 'red' }] },
    } }
    const context = runtime({}, world)
    const original = execute(source, context)
    const migrated = execute(migrateStatusFieldModules(source), context)
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({ owner: 'red' })
    expect(callsIn(migrateStatusFieldModules(source).body).map(statement => statement.module)).not.toContain('status.read-player-field')

    const missing = execute(migrateStatusFieldModules({ ...source, inputBindings: { statusId: 'missing' } }), context)
    expect(missing.value).toEqual({ owner: null })
  })

  it('preserves first-match IDs, empty IDs, numeric zero, and null fallback behavior', () => {
    const source = graph([
      call('piece-ref', 'ref.target'),
      call('piece', 'query.piece', { pieceId: output('piece-ref', 'piece') }),
      call('find', 'status.find-id', { piece: output('piece', 'piece') }, { statusType: 'mark' }),
      call('find-by-id', 'status.find-id-by-id', { piece: output('piece', 'piece'), statusId: input('statusId') }),
      call('find-by-prefix', 'status.find-id-by-prefix', { piece: output('piece', 'piece') }, { prefix: 'mark-' }),
      call('find-by-number', 'status.find-id-by-number', { piece: output('piece', 'piece'), value: input('value') }, { statusType: 'mark', field: 'turnNumber' }),
      call('list', 'status.list-ids', { piece: output('piece', 'piece') }, { statusType: 'mark' }),
      call('number', 'status.read-number', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'intensity' }),
      call('record-number', 'status.read-record-number', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'hitCount' }),
      call('number-field', 'status.read-number-field', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'intensity' }),
      call('truthy', 'status.read-number-truthy', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }, { field: 'intensity' }),
      call('turn', 'status.read-turn-number', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('text', 'status.read-text-field', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('textFallback') }, { field: 'kind' }),
      { kind: 'return', id: 'done', values: {
        find: output('find', 'id'), findById: output('find-by-id', 'id'), findByPrefix: output('find-by-prefix', 'id'), findByNumber: output('find-by-number', 'id'),
        list: output('list', 'ids'), number: output('number'), recordNumber: output('record-number'),
        numberField: output('number-field'), truthy: output('truthy'), turn: output('turn'), text: output('text'),
      } },
    ], {
      inputs: [
        { name: 'statusId', type: 'string', nullable: true }, { name: 'value', type: 'number' }, { name: 'fallback', type: 'number' }, { name: 'textFallback', type: 'string' },
      ],
      inputBindings: { statusId: 'mark-1', value: 7, fallback: 9, textFallback: 'missing-kind' },
      outputs: [
        { name: 'find', type: 'string', nullable: true }, { name: 'findById', type: 'string', nullable: true },
        { name: 'findByPrefix', type: 'string', nullable: true }, { name: 'findByNumber', type: 'string', nullable: true },
        { name: 'list', type: { kind: 'list', element: 'string' } },
        { name: 'number', type: 'number' }, { name: 'recordNumber', type: 'number' }, { name: 'numberField', type: 'number' },
        { name: 'truthy', type: 'number' }, { name: 'turn', type: 'number' }, { name: 'text', type: 'string' },
      ],
    })
    const original = execute(source, runtime())
    const migrated = execute(migrateStatusFieldModules(source), runtime())
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({
      find: 'mark-1', findById: 'mark-1', findByPrefix: 'mark-1', findByNumber: 'mark-2', list: ['mark-1', 'mark-2', 'before'],
      number: 0, recordNumber: 9, numberField: 0, truthy: 9, turn: 3, text: 'missing-kind',
    })

    const emptyIdWorld = { pieces: { ...pieces, target: {
      ...pieces.target,
      statusTags: [
        { id: '', type: 'mark', turnNumber: 0, intensity: 0 },
        { id: 'later', type: 'mark', turnNumber: 0, intensity: 2 },
      ],
    } } }
    const emptyIdSource = {
      ...source,
      inputBindings: { ...source.inputBindings, statusId: '', value: 0 },
    }
    const emptyIdOriginal = execute(emptyIdSource, runtime({}, emptyIdWorld))
    const emptyIdMigrated = execute(migrateStatusFieldModules(emptyIdSource), runtime({}, emptyIdWorld))
    expect(emptyIdMigrated.value).toEqual(emptyIdOriginal.value)
    expect(emptyIdMigrated.value).toMatchObject({
      find: '', findById: '', findByPrefix: null, findByNumber: '', list: ['', 'later'], number: 0, numberField: 0, truthy: 9, turn: 0, text: 'missing-kind',
    })
  })

  it('preserves lifecycle precedence, player status readers, source ordering, and cell snapshots', () => {
    const source = graph([
      call('piece-ref', 'ref.target'), call('piece', 'query.piece', { pieceId: output('piece-ref', 'piece') }),
      call('source-ref', 'ref.source'), call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
      call('player-ref', 'ref.player'), call('player', 'query.player', { playerId: output('player-ref', 'player') }),
      call('duration', 'status.read-duration', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('uses', 'status.read-uses', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('uses-fallback', 'status.read-uses-fallback', { piece: output('piece', 'piece'), statusId: input('statusId'), fallback: input('fallback') }),
      call('player-number', 'status.read-player-number', { player: output('player', 'player'), statusId: input('playerStatusId'), fallback: input('fallback') }, { field: 'centerX' }),
      call('player-truthy', 'status.read-player-number-truthy', { player: output('player', 'player'), statusId: input('playerStatusId'), fallback: input('fallback') }, { field: 'value' }),
      call('player-text', 'status.read-player-text-field', { player: output('player', 'player'), statusId: input('playerStatusId') }, { field: 'sourceId' }),
      call('player-id', 'status.find-player-id', { player: output('player', 'player') }, { statusType: 'lethal-toxin' }),
      call('player-id-at', 'status.find-player-id-at', { player: output('player', 'player'), x: input('x'), y: input('y') }, { statusType: 'lethal-toxin' }),
      call('source-before', 'status.find-source-before-id', { piece: output('piece', 'piece'), source: output('source', 'piece'), turn: input('turn') }, { statusType: 'mark' }),
      call('cell', 'status.read-cell-field', { piece: output('piece', 'piece'), statusId: input('cellStatusId') }, { field: 'left' }),
      call('cells', 'status.read-cell-list', { piece: output('piece', 'piece'), statusId: input('cellStatusId') }, { field: 'pathCells' }),
      { kind: 'return', id: 'done', values: {
        duration: output('duration'), uses: output('uses'), usesFallback: output('uses-fallback'), playerNumber: output('player-number'),
        playerTruthy: output('player-truthy'), playerText: output('player-text'), playerId: output('player-id', 'id'),
        playerIdAt: output('player-id-at', 'id'), sourceBefore: output('source-before', 'id'), cell: output('cell', 'cell'), cells: output('cells', 'cells'),
      } },
    ], {
      inputs: [
        { name: 'statusId', type: 'string', nullable: true }, { name: 'playerStatusId', type: 'string', nullable: true },
        { name: 'cellStatusId', type: 'string', nullable: true }, { name: 'fallback', type: 'number' },
        { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'turn', type: 'number' },
      ],
      inputBindings: {
        statusId: 'mark-1', playerStatusId: 'storm', cellStatusId: 'cell',
        fallback: 8, x: 0, y: 4, turn: 4,
      },
      outputs: [
        { name: 'duration', type: 'number' }, { name: 'uses', type: 'number' }, { name: 'usesFallback', type: 'number' },
        { name: 'playerNumber', type: 'number' }, { name: 'playerTruthy', type: 'number' }, { name: 'playerText', type: 'string', nullable: true },
        { name: 'playerId', type: 'string', nullable: true }, { name: 'playerIdAt', type: 'string', nullable: true },
        { name: 'sourceBefore', type: 'string', nullable: true }, { name: 'cell', type: 'cell', nullable: true }, { name: 'cells', type: { kind: 'list', element: 'cell' } },
      ],
    })
    const world = { pieces: { ...pieces, target: {
      ...pieces.target,
      statusTags: [
      { id: 'cell', type: 'path', left: { x: -1, y: 3 }, pathCells: [{ x: -1, y: 3 }, { x: 0, y: 4 }] },
      { id: 'mark-1', type: 'mark', currentUses: 0, currentDuration: 6, sourceId: 'source', createdTurnNumber: 2 },
      { id: 'before', type: 'mark', sourceId: 'source', createdTurnNumber: 3 },
      ],
    } } }
    const original = execute(source, runtime({}, world))
    const migrated = execute(migrateStatusFieldModules(source), runtime({}, world))
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({
      duration: 6, uses: 0, usesFallback: 8, playerNumber: 0, playerTruthy: 8, playerText: '',
      playerId: 'storm', playerIdAt: 'storm', sourceBefore: 'mark-1', cell: { x: -1, y: 3 }, cells: [{ x: -1, y: 3 }, { x: 0, y: 4 }],
    })

  })

  it('rewrites status instance number reads through status.fields while retaining fallback behavior', () => {
    const sourceWithRead = graph([
      call('piece-ref', 'ref.target'),
      call('piece', 'query.piece', { pieceId: output('piece-ref', 'piece') }),
      call('status', 'status.find-instance', { piece: output('piece', 'piece') }, { statusType: 'mark' }),
      call('read', 'status.read-number-instance', { status: output('status', 'status'), fallback: input('fallback') }, { field: 'intensity' }),
      { kind: 'return', id: 'done', values: { result: output('read') } },
    ], {
      inputs: [{ name: 'fallback', type: 'number' }],
      inputBindings: { fallback: 11 },
      outputs: [{ name: 'result', type: 'number' }],
    })
    const context = runtime({ 'status-1': { intensity: 0 } })
    expect(execute(migrateStatusFieldModules(sourceWithRead), context).value).toEqual(execute(sourceWithRead, context).value)
    expect(execute(migrateStatusFieldModules(sourceWithRead), context).value).toEqual({ result: 0 })

    const missingFieldContext = runtime({ 'status-1': {} })
    expect(execute(migrateStatusFieldModules(sourceWithRead), missingFieldContext).value).toEqual(execute(sourceWithRead, missingFieldContext).value)
    expect(execute(migrateStatusFieldModules(sourceWithRead), missingFieldContext).value).toEqual({ result: 11 })
  })

  it('keeps a missing status-instance read on its fallback path without calling status.fields', () => {
    const sourceWithRead = graph([
      call('piece-ref', 'ref.target'),
      call('piece', 'query.piece', { pieceId: output('piece-ref', 'piece') }),
      call('status', 'status.find-instance', { piece: output('piece', 'piece') }, { statusType: 'momentum-core' }),
      call('read', 'status.read-number-instance', { status: output('status', 'status'), fallback: input('fallback') }, { field: 'stacks' }),
      { kind: 'return', id: 'done', values: { result: output('read') } },
    ], {
      inputs: [{ name: 'fallback', type: 'number' }],
      inputBindings: { fallback: 4 },
      outputs: [{ name: 'result', type: 'number' }],
    })
    const context = runtime({})
    ;(context.flow as { status: { findInstance: () => string | null } }).status.findInstance = () => null

    const migrated = execute(migrateStatusFieldModules(sourceWithRead), context)
    expect(migrated.value).toEqual({ result: 4 })
    expect(migrated.compiled.code).toContain('status.fields')
  })

  it('keeps instance reads legal inside collection bodies without execution locals', () => {
    const source = graph([
      {
        kind: 'collection', id: 'reads', method: 'map', items: input('statuses'), item: 'item',
        body: [
          call('read', 'status.read-number-instance', {
            status: input('item'), fallback: { kind: 'literal', value: 9 },
          }, { field: 'stacks' }),
          { kind: 'return', id: 'read-return', value: output('read') },
        ],
      },
      { kind: 'return', id: 'done', values: { values: output('reads') } },
    ], {
      inputs: [{ name: 'statuses', type: { kind: 'list', element: 'status' } }],
      inputBindings: { statuses: [] },
      outputs: [{ name: 'values', type: { kind: 'list', element: 'number' } }],
    })

    const migrated = migrateStatusFieldModules(source)
    expect(() => compileGameplayModuleGraph(migrated, registry)).not.toThrow()
    expect(callsIn(migrated.body).map(statement => statement.module)).not.toContain('local.declare')
  })

  it('rewrites flight and live-source readers through first-match records and typed queries', () => {
    const source = graph([
      call('target', 'ref.target'),
      call('piece', 'query.piece', { pieceId: output('target', 'piece') }),
      call('flight', 'status.find-flight', { target: output('piece', 'piece') }, { statusType: 'flight' }),
      call('live', 'status.read-live-source', { piece: output('piece', 'piece'), statusId: input('statusId') }),
      { kind: 'return', id: 'done', values: {
        found: output('flight', 'found'), id: output('flight', 'id'), flightId: output('flight', 'flightId'),
        allyId: output('flight', 'allyId'), x: output('flight', 'x'), y: output('flight', 'y'),
        allyX: output('flight', 'allyX'), allyY: output('flight', 'allyY'), appliedTurn: output('flight', 'appliedTurn'),
        currentDuration: output('flight', 'currentDuration'), source: output('live', 'source'),
      } },
    ], {
      inputs: [{ name: 'statusId', type: 'string', nullable: true }],
      inputBindings: { statusId: 'source-status' },
      outputs: [
        { name: 'found', type: 'boolean' }, { name: 'id', type: 'string' }, { name: 'flightId', type: 'string' },
        { name: 'allyId', type: 'piece', nullable: true }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' },
        { name: 'allyX', type: 'number' }, { name: 'allyY', type: 'number' }, { name: 'appliedTurn', type: 'number' },
        { name: 'currentDuration', type: 'number' }, { name: 'source', type: 'piece', nullable: true },
      ],
    })
    const world = {
      pieces: {
        target: {
          instanceId: 'target',
          statusTags: [
            { id: 'first', type: 'flight', ownerId: 'other', flightId: 'ignored' },
            {
              id: 'flight-1', type: 'flight', ownerId: 'target', flightId: 'flight-a', allyId: 'ally',
              x: 2, y: 3, allyX: 4, allyY: 5, appliedTurn: 6, currentDuration: 7,
            },
            { id: 'flight-2', type: 'flight', ownerId: 'target', flightId: 'later', x: 99 },
            { id: 'source-status', type: 'source', sourcePieceId: 'source' },
          ],
        },
        ally: { instanceId: 'ally', currentHp: 5, statusTags: [] },
        source: { instanceId: 'source', currentHp: 5, statusTags: [] },
      },
    }
    const context = runtime({}, world)
    const original = execute(source, context)
    const migrated = execute(migrateStatusFieldModules(source), context)
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({
      found: true, id: 'flight-1', flightId: 'flight-a', allyId: 'ally', x: 2, y: 3,
      allyX: 4, allyY: 5, appliedTurn: 6, currentDuration: 7, source: 'source',
    })

    const emptyWorld = { pieces: {
      target: { instanceId: 'target', statusTags: [] },
    } }
    const empty = execute(migrateStatusFieldModules(source), runtime({}, emptyWorld))
    expect(empty.value).toEqual({
      found: false, id: '', flightId: '', allyId: null, x: 0, y: 0,
      allyX: 0, allyY: 0, appliedTurn: -1, currentDuration: 0, source: null,
    })
  })

  it('rewrites status reference readers through first-match keys and live piece validation', () => {
    const source = graph([
      call('target', 'ref.target'),
      call('piece', 'query.piece', { pieceId: output('target', 'piece') }),
      call('target-ref', 'status.read-reference', { piece: output('piece', 'piece'), statusId: input('statusId') }, { field: 'targetId' }),
      call('source-ref', 'status.read-reference', { piece: output('piece', 'piece'), statusId: input('statusId') }, { field: 'sourceId' }),
      call('piece-ref', 'status.read-piece-reference', { piece: output('piece', 'piece'), statusId: input('statusId') }, { field: 'targetPieceId' }),
      { kind: 'return', id: 'done', values: {
        target: output('target-ref', 'reference'), source: output('source-ref', 'reference'), piece: output('piece-ref', 'reference'),
      } },
    ], {
      inputs: [{ name: 'statusId', type: 'string', nullable: true }],
      inputBindings: { statusId: 'reference' },
      outputs: [
        { name: 'target', type: 'piece', nullable: true }, { name: 'source', type: 'piece', nullable: true },
        { name: 'piece', type: 'piece', nullable: true },
      ],
    })
    const world = { pieces: {
      target: {
        instanceId: 'target',
        statusTags: [
          { id: 'other', targetId: 'source', sourceId: 'source', targetPieceId: 'source' },
          { id: 'reference', targetId: 'ally', sourceId: 'source', targetPieceId: 'ally' },
          { id: 'reference', targetId: 'later', sourceId: 'later', targetPieceId: 'later' },
        ],
      },
      ally: { instanceId: 'ally', currentHp: 0, statusTags: [] },
      source: { instanceId: 'source', currentHp: 5, statusTags: [] },
    } }
    const context = runtime({}, world)
    const original = execute(source, context)
    const migrated = execute(migrateStatusFieldModules(source), context)
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({ target: 'ally', source: 'source', piece: 'ally' })

    const missing = execute(migrateStatusFieldModules({ ...source, inputBindings: { statusId: 'missing' } }), context)
    expect(missing.value).toEqual({ target: null, source: null, piece: null })
    const nullId = execute(migrateStatusFieldModules({ ...source, inputBindings: { statusId: null } }), context)
    expect(nullId.value).toEqual({ target: null, source: null, piece: null })
  })
})
