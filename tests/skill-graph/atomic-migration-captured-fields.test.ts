import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  ATOMIC_CAPTURED_FIELD_MODULES,
  migrateCapturedFieldModules,
} from '../../lib/skill-graph/atomic-migration-captured-fields'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import type {
  GameplayCallStatement,
  GameplayLiteral,
  GameplayModuleDescriptor,
  GameplayModuleGraph,
  GameplayModuleRegistry,
  GameplayStatement,
  GameplayValue,
} from '../../lib/skill-graph/module-types'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '../../lib/skill-graph/module-types'

const version = '1'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayLiteral>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
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
        visit(statement.else ?? [])
      } else if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') {
        visit(statement.body)
      } else if (statement.kind === 'while') {
        visit(statement.body)
        visit(statement.condition.body)
      }
    }
  }
  visit(body)
  return result
}

function sourceDescriptor(): GameplayModuleDescriptor {
  return {
    id: 'test.source', version, label: 'test source',
    inputs: [], outputs: [{ name: 'record', type: 'record' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true },
    lower: () => 'flow.testSource()',
  }
}

function registryWithSource(): GameplayModuleRegistry {
  const source = sourceDescriptor()
  const key = source.id + '@' + source.version
  return {
    get: (id, requestedVersion) => id + '@' + (requestedVersion ?? version) === key
      ? source
      : GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
    resolve: (id, requestedVersion) => id + '@' + (requestedVersion ?? version) === key
      ? source
      : GAMEPLAY_MODULE_REGISTRY.resolve(id, requestedVersion),
    descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, source],
  }
}

function execute(source: GameplayModuleGraph, context: Record<string, unknown>): unknown {
  const compiled = compileGameplayModuleGraph(source, registryWithSource())
  const run = runInNewContext('(' + compiled.code + ')', context) as (globals: unknown) => unknown
  return run(context)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type Snapshot = {
  readonly instanceId?: string | null
  readonly ownerPlayerId?: string | null
  readonly name?: string | null
  readonly templateId?: string | null
  readonly maxHp?: number | null
  readonly stats?: { readonly maxHp?: number | null } | null
}

function runtime(snapshot: Snapshot, eventSource: Record<string, unknown> | null, piece: Record<string, unknown> = {
  instanceId: 'target', ownerPlayerId: 'blue', name: 'Live name', templateId: 'live-template', momentum: 0,
}): Record<string, unknown> {
  const sourceHandle = { source: 'captured-source' }
  const capturedName = (_handle: unknown, fallback: string): string => {
    const value = fallback === 'templateId' ? (snapshot.name || snapshot.templateId) : snapshot.name
    return String(value)
  }
  const capturedMaxHp = (_handle: unknown, fallback: number): number => Number(snapshot.maxHp || snapshot.stats?.maxHp || fallback)
  const capturedFields = (): Record<string, unknown> => clone({
    instanceId: snapshot.instanceId,
    ownerPlayerId: snapshot.ownerPlayerId,
    name: snapshot.name,
    templateId: snapshot.templateId,
    maxHp: snapshot.maxHp,
    stats: snapshot.stats,
  })
  return {
    flow: {
      testSource: () => sourceHandle,
      refs: { target: () => 'target' },
      query: {
        hasPiece: (id: unknown) => id === 'target',
        piece: (id: unknown) => id === 'target' ? piece : null,
        pieceText: (id: unknown, field: string) => id === 'target' ? String(piece[field] ?? '') : null,
      },
      effects: {
        capturedName,
        capturedOwner: () => snapshot.ownerPlayerId,
        capturedIdentifier: () => snapshot.instanceId,
        capturedMaxHp,
        capturedFields,
      },
      event: {
        pieceFields: () => eventSource === null ? null : clone(eventSource),
      },
    },
    sourcePiece: eventSource,
  }
}

function allCapturedFieldCalls(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source', 'test.source'),
    call('captured-name', 'piece.captured-name', { source: output('source', 'record') }, { fallback: 'none' }),
    call('captured-name-template', 'piece.captured-name', { source: output('source', 'record') }, { fallback: 'templateId' }),
    call('captured-owner', 'source.captured-owner', { source: output('source', 'record') }),
    call('captured-identifier', 'source.captured-identifier', { source: output('source', 'record') }),
    call('captured-max-hp', 'source.captured-max-hp', { source: output('source', 'record'), fallback: literal(18) }),
    call('target', 'ref.target'),
    call('name-or', 'piece.name-or', { piece: output('target', 'piece'), fallback: literal('fallback') }),
    call('display-name', 'piece.display-name', { piece: output('target', 'piece') }, { fallback: 'none' }),
    call('display-name-template', 'piece.display-name', { piece: output('target', 'piece') }, { fallback: 'templateId' }),
    call('momentum', 'piece.momentum', { piece: output('target', 'piece') }),
    call('source-owner', 'recall.source-owner'),
    call('source-present', 'recall.source-present'),
    call('owner-id', 'piece.owner-id', { piece: output('target', 'piece') }),
    call('owner-id-text', 'piece.owner-id-text', { piece: output('target', 'piece') }),
    {
      kind: 'return', id: 'done', values: {
        capturedName: output('captured-name'),
        capturedNameTemplate: output('captured-name-template'),
        capturedOwner: output('captured-owner', 'player'),
        capturedIdentifier: output('captured-identifier'),
        capturedMaxHp: output('captured-max-hp'),
        nameOr: output('name-or', 'text'),
        displayName: output('display-name'),
        displayNameTemplate: output('display-name-template'),
        momentum: output('momentum'),
        sourceOwner: output('source-owner', 'player'),
        sourcePresent: output('source-present'),
        ownerId: output('owner-id', 'playerId'),
        ownerIdText: output('owner-id-text', 'playerId'),
      },
    },
  ]
  return graph(body, {
    outputs: [
      { name: 'capturedName', type: 'string' },
      { name: 'capturedNameTemplate', type: 'string' },
      { name: 'capturedOwner', type: 'player', nullable: true },
      { name: 'capturedIdentifier', type: 'string', nullable: true },
      { name: 'capturedMaxHp', type: 'number' },
      { name: 'nameOr', type: 'string' },
      { name: 'displayName', type: 'string' },
      { name: 'displayNameTemplate', type: 'string' },
      { name: 'momentum', type: 'number' },
      { name: 'sourceOwner', type: 'player', nullable: true },
      { name: 'sourcePresent', type: 'boolean' },
      { name: 'ownerId', type: 'string', nullable: true },
      { name: 'ownerIdText', type: 'string', nullable: true },
    ],
  })
}

describe('atomic captured/name field migrations', () => {
  it('rewrites the bounded aliases into source, event, piece, optional, and generic field calls', () => {
    const source = allCapturedFieldCalls()
    const migrated = migrateCapturedFieldModules(source)
    const modules = callsIn(migrated.body).map(statement => statement.module)
    expect(modules).not.toEqual(expect.arrayContaining([...ATOMIC_CAPTURED_FIELD_MODULES]))
    expect(modules).toEqual(expect.arrayContaining([
      'source.fields', 'data.optional-field', 'data.field', 'piece.field', 'event.field',
      'compare.values', 'logic.select', 'logic.and', 'value.coalesce', 'text.from-value',
    ]))
    expect(callsIn(migrated.body).filter(statement => statement.module === 'data.field').every(statement => statement.version === '2')).toBe(true)
    expect(migrateCapturedFieldModules(migrated)).toEqual(migrated)
  })

  it('preserves captured values, living fields, zero fallback rules, and nullable event source behavior', () => {
    const source = allCapturedFieldCalls()
    const normal = runtime({
      instanceId: 'captured-1', ownerPlayerId: 'red', name: 'Captured name', templateId: 'captured-template',
      maxHp: 25, stats: { maxHp: 40 },
    }, { instanceId: 'event-source', ownerPlayerId: 'red' })
    const normalOriginal = execute(source, normal)
    const normalMigrated = execute(migrateCapturedFieldModules(source), normal)
    expect(normalMigrated).toEqual(normalOriginal)
    expect(normalMigrated).toMatchObject({
      capturedName: 'Captured name', capturedNameTemplate: 'Captured name', capturedOwner: 'red',
      capturedIdentifier: 'captured-1', capturedMaxHp: 25, nameOr: 'Live name',
      displayName: 'Live name', displayNameTemplate: 'Live name', momentum: 0,
      sourceOwner: 'red', sourcePresent: true, ownerId: 'blue', ownerIdText: 'blue',
    })

    const zero = runtime({
      instanceId: 'captured-zero', ownerPlayerId: 'red', name: '', templateId: 'captured-template',
      maxHp: 0, stats: { maxHp: 0 },
    }, { instanceId: 'event-source', ownerPlayerId: 'red' }, {
      instanceId: 'target', ownerPlayerId: 'blue', name: '', templateId: 'live-template', momentum: 0,
    })
    const zeroOriginal = execute(source, zero)
    const zeroMigrated = execute(migrateCapturedFieldModules(source), zero)
    expect(zeroMigrated).toEqual(zeroOriginal)
    expect(zeroMigrated).toMatchObject({
      capturedName: '', capturedNameTemplate: 'captured-template', capturedMaxHp: 18,
      displayName: '', displayNameTemplate: 'live-template', momentum: 0,
    })

    const nullable = runtime({
      instanceId: 'captured-null', ownerPlayerId: 'red', name: null, templateId: 'captured-template',
      maxHp: null, stats: null,
    }, null)
    const nullableOriginal = execute(source, nullable)
    const nullableMigrated = execute(migrateCapturedFieldModules(source), nullable)
    expect(nullableMigrated).toEqual(nullableOriginal)
    expect(nullableMigrated).toMatchObject({ capturedName: 'null', capturedNameTemplate: 'captured-template', capturedMaxHp: 18, sourceOwner: null, sourcePresent: false })

    const absent = runtime({
      instanceId: 'captured-absent', ownerPlayerId: 'red', templateId: 'captured-template',
      maxHp: null, stats: null,
    }, null)
    const absentOriginal = execute(source, absent)
    const absentMigrated = execute(migrateCapturedFieldModules(source), absent)
    expect(absentMigrated).toEqual(absentOriginal)
    expect(absentMigrated).toMatchObject({ capturedName: 'undefined', capturedNameTemplate: 'captured-template' })
  })
})
