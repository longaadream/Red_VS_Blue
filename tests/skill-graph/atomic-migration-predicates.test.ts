import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicPredicateRecipe } from '../../lib/skill-graph/atomic-migration-predicates'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })

const call = (
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
): GameplayCallStatement => ({
  kind: 'call', id, module, version, inputs,
  ...(parameters === undefined ? {} : { parameters }),
})

const graph = (body: readonly GameplayStatement[], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph => ({
  version: GAMEPLAY_MODULE_GRAPH_VERSION,
  surface: 'skill',
  body,
  ...extra,
})

function callsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  const visit = (statements: readonly GameplayStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'call') result.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        if (statement.else) visit(statement.else)
      } else if (statement.kind === 'foreach' || statement.kind === 'while' || statement.kind === 'collection') {
        visit(statement.body)
        if (statement.kind === 'while') visit(statement.condition.body)
      }
    }
  }
  visit(body)
  return result
}

function execute(
  source: GameplayModuleGraph,
  globals: Readonly<Record<string, unknown>> = {},
  registry: GameplayModuleRegistry = GAMEPLAY_MODULE_REGISTRY,
): { compiled: ReturnType<typeof compileGameplayModuleGraph>; value: unknown } {
  const compiled = compileGameplayModuleGraph(source, registry)
  const run = runInNewContext('(' + compiled.code + ')', globals) as (context: unknown) => unknown
  return { compiled, value: run({}) }
}

const DEFAULT_RESULT_ROWS = [
  { targetId: 'dead-target', damage: 7, heal: 2, success: true },
  { targetId: 'dead-target', damage: 3, heal: 1, success: false },
  { targetId: 'other', damage: 99, heal: 99, success: true },
]

function resultRegistry(rows: readonly Record<string, unknown>[] = DEFAULT_RESULT_ROWS): GameplayModuleRegistry {
  const encodedRows = JSON.stringify(rows) ?? '[]'
  const descriptor: GameplayModuleDescriptor = {
    id: 'test.result',
    version,
    label: 'test.result',
    inputs: [],
    outputs: [{ name: 'result', type: 'record' }],
    allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true },
    lower: () => ({ expression: `({damage:7,isKilled:false,results:${encodedRows}})` }),
  }
  return {
    get: (id, requestedVersion) => id === descriptor.id && (requestedVersion ?? version) === version
      ? descriptor
      : GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
    resolve: (id, requestedVersion) => id === descriptor.id && (requestedVersion ?? version) === version
      ? descriptor
      : GAMEPLAY_MODULE_REGISTRY.resolve(id, requestedVersion),
    descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, descriptor],
  }
}

function flowForTest() {
  const pieces: Record<string, Record<string, unknown>> = {
    target: {
      instanceId: 'target', isCore: true, currentHp: 4, maxHp: 10, attack: 7, defense: 3, moveRange: 2,
      statusTags: [
        { id: 'status-1', type: 'mark', sourceId: 'source', stacks: 2, lastDamageTurn: 3, skillIds: ['skill-a'] },
        { type: 'missing-id', skillIds: ['skill-b'] },
      ],
      rules: [{ id: 'rule-1' }],
    },
    source: { instanceId: 'source', isCore: false, statusTags: [] },
  }
  const players: Record<string, Record<string, unknown>> = {
    player: { playerId: 'player', statusTags: [{ type: 'mark' }] },
  }
  const flow = {
    refs: {
      target: () => 'target',
      source: () => 'source',
      player: () => 'player',
    },
    query: {
      hasPiece: (id: unknown) => typeof id === 'string' && Boolean(pieces[id]),
      piece: (id: unknown) => pieces[String(id)] ?? null,
      hasPlayer: (id: unknown) => typeof id === 'string' && Boolean(players[id]),
      player: (id: unknown) => players[String(id)] ?? null,
      pieceText: (id: unknown, field: string) => String(pieces[String(id)]?.[field] ?? ''),
      playerText: (id: unknown, field: string) => String(players[String(id)]?.[field] ?? ''),
    },
    effects: {
      captureEventPiece: () => ({ scope: 'execution-source', id: 'source' }),
      capturedFields: () => ({
        instanceId: 'source', noKillCharge: true, attack: 7, defense: 3, moveRange: 2, currentHp: 5, maxHp: 9,
        statusTags: [{ type: 'mark' }],
      }),
      capturedNoKillCharge: () => true,
      capturedNumber: (_source: unknown, field: string) => ({ attack: 7, defense: 3, moveRange: 2, currentHp: 5, maxHp: 9 }[field]),
      capturedHasStatus: () => true,
    },
    status: {
      fields: (status: unknown) => status,
      hasSkillInstance: () => true,
    },
  }
  const battle = { players: Object.values(players) }
  return { flow, battle }
}

describe('atomic predicate migrations', () => {
  it('rewrites the remaining field, comparison, and collection predicates and is idempotent', () => {
    const source = graph([
      call('core', 'piece.is-core', { piece: input('target') }),
      call('mark', 'status.has-source-mark', { target: input('target'), source: input('source') }, { statusType: 'mark' }),
      call('skill-id', 'status.has-skill-id', { piece: input('target'), statusId: input('statusId'), skillId: input('skillId') }),
      call('batch-success', 'effect.batch-succeeded-for', { result: input('result'), target: input('target') }),
      call('batch-number', 'effect.batch-number-for', { result: input('result'), target: input('target') }, { field: 'damage' }),
      call('prefix', 'followup.card-has-prefix', { cardId: literal('card-fire-1') }, { prefix: 'card-fire-' }),
      call('transfer', 'status.player-transfer-records', { player: input('player') }, { statusType: 'transfer' }),
      call('source-number', 'source.captured-number', { source: input('captured') }, { field: 'attack' }),
      call('source-no-kill', 'source.captured-no-kill-charge', { source: input('captured') }),
    ])
    const migrated = rewriteAtomicGraph(source, atomicPredicateRecipe)
    const modules = callsIn(migrated.body).map(statement => statement.module)
    expect(modules).not.toEqual(expect.arrayContaining([
      'piece.is-core', 'status.has-source-mark', 'status.has-skill-id', 'effect.batch-succeeded-for',
      'effect.batch-number-for', 'followup.card-has-prefix', 'status.player-transfer-records',
      'source.captured-number', 'source.captured-no-kill-charge',
    ]))
    expect(modules).toEqual(expect.arrayContaining([
      'piece.field', 'player.field', 'source.fields', 'data.field', 'result.field',
      'compare.values', 'text.starts-with',
    ]))
    expect(JSON.stringify(migrated.body)).toContain('"kind":"record.create"')
    expect(rewriteAtomicGraph(migrated, atomicPredicateRecipe)).toEqual(migrated)
  })

  it('preserves direct predicate behavior against the old native helpers', () => {
    const direct = graph([
      call('target', 'ref.target'),
      call('source', 'ref.source'),
      call('player', 'ref.player'),
      call('core', 'piece.is-core', { piece: output('target', 'piece') }),
      call('mark', 'status.has-source-mark', { target: output('target', 'piece'), source: output('source', 'piece') }, { statusType: 'mark' }),
      call('skill-id', 'status.has-skill-id', { piece: output('target', 'piece'), statusId: literal('status-1'), skillId: literal('skill-a') }),
      call('prefix', 'followup.card-has-prefix', { cardId: literal('card-fire-1') }, { prefix: 'card-fire-' }),
      call('captured', 'source.capture-event-piece', {}, { field: 'piece' }),
      call('source-number', 'source.captured-number', { source: output('captured', 'source') }, { field: 'attack' }),
      call('source-no-kill', 'source.captured-no-kill-charge', { source: output('captured', 'source') }),
      {
        kind: 'return', id: 'done', values: {
          core: output('core'), mark: output('mark'), skillId: output('skill-id'), prefix: output('prefix'),
          sourceNumber: output('source-number'), sourceNoKill: output('source-no-kill'),
        },
      },
    ], {
      outputs: [
        { name: 'core', type: 'boolean' }, { name: 'mark', type: 'boolean' }, { name: 'skillId', type: 'boolean' },
        { name: 'prefix', type: 'boolean' }, { name: 'sourceNumber', type: 'number' }, { name: 'sourceNoKill', type: 'boolean' },
      ],
    })
    const globals = flowForTest()
    const original = execute(direct, globals)
    const migrated = execute(rewriteAtomicGraph(direct, atomicPredicateRecipe), globals)
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({ core: true, mark: true, skillId: true, prefix: true, sourceNumber: 7, sourceNoKill: true })
  })

  it('preserves source mark stack fallback and zero truthiness', () => {
    const source = graph([
      call('target', 'ref.target'),
      call('source', 'ref.source'),
      call('mark', 'status.has-source-mark', {
        target: output('target', 'piece'), source: output('source', 'piece'),
      }, { statusType: 'mark' }),
      { kind: 'return', id: 'done', value: output('mark') },
    ], { outputs: [{ name: 'value', type: 'boolean' }] })
    for (const stacks of [undefined, null, 0]) {
      const pieces: Record<string, Record<string, unknown>> = {
        target: { statusTags: [{ type: 'mark', sourceId: 'source', stacks }] },
        source: { instanceId: 'source' },
      }
      const globals = {
        flow: {
          refs: { target: () => 'target', source: () => 'source' },
          query: { piece: (id: unknown) => pieces[String(id)] ?? null },
        },
      }
      const original = execute(source, globals)
      const migrated = execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals)
      expect(original.value).toBe(true)
      expect(migrated.value).toBe(original.value)
    }
  })

  it('matches result records by stable identity without resolving a dead target and keeps first number semantics', () => {
    const source = graph([
      call('result', 'test.result'),
      call('target', 'ref.target'),
      call('success', 'effect.batch-succeeded-for', { result: output('result', 'result'), target: output('target', 'piece') }),
      call('number', 'effect.batch-number-for', { result: output('result', 'result'), target: output('target', 'piece') }, { field: 'damage' }),
      { kind: 'return', id: 'done', values: { success: output('success'), number: output('number') } },
    ], {
      outputs: [{ name: 'success', type: 'boolean' }, { name: 'number', type: 'number' }],
    })
    let refetches = 0
    let identityChecks = 0
    const globals = {
      flow: {
        refs: { target: () => 'dead-target' },
        query: {
          // The input is deliberately a historical/dead identity.  Migrated
          // predicates must compare this opaque identity without live lookup.
          hasPiece: () => { identityChecks += 1; return true },
          piece: () => { refetches += 1; throw new Error('dead target must not be refetched') },
        },
      },
    }
    const registry = resultRegistry()
    const original = execute(source, globals, registry)
    identityChecks = 0
    refetches = 0
    const migrated = execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals, registry)
    expect(original.value).toEqual({ success: true, number: 7 })
    expect(migrated.value).toEqual(original.value)
    expect(identityChecks).toBe(0)
    expect(refetches).toBe(0)
  })

  it('keeps negative and duplicate-zero first batch amounts', () => {
    const source = graph([
      call('result', 'test.result'),
      call('target', 'ref.target'),
      call('number', 'effect.batch-number-for', {
        result: output('result', 'result'), target: output('target', 'piece'),
      }, { field: 'damage' }),
      { kind: 'return', id: 'done', value: output('number') },
    ], { outputs: [{ name: 'value', type: 'number' }] })
    const cases: ReadonlyArray<{ rows: ReadonlyArray<Record<string, unknown>>; expected: number }> = [
      {
        rows: [
          { targetId: 'dead-target', damage: -1, success: true },
          { targetId: 'dead-target', damage: 0, success: true },
        ],
        expected: -1,
      },
      {
        rows: [
          { targetId: 'dead-target', damage: 0, success: true },
          { targetId: 'dead-target', damage: 7, success: true },
        ],
        expected: 0,
      },
    ]
    for (const testCase of cases) {
      const globals = {
        flow: {
          refs: { target: () => 'dead-target' },
          query: { hasPiece: () => true },
        },
      }
      const original = execute(source, globals, resultRegistry(testCase.rows))
      const migrated = execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals, resultRegistry(testCase.rows))
      expect(original.value).toBe(testCase.expected)
      expect(migrated.value).toBe(original.value)
    }
  })

  it('keeps transfer records, numeric fallback, empty-string normalization, and field presence', () => {
    const source = graph([
      call('player', 'ref.player'),
      call('records', 'status.player-transfer-records', { player: output('player', 'player') }, { statusType: 'transfer' }),
      { kind: 'return', id: 'done', values: {
        records: output('records', 'records'), count: output('records', 'count'), exists: output('records', 'exists'),
      } },
    ], {
      outputs: [
        { name: 'records', type: { kind: 'list', element: { kind: 'record', schema: 'attribute-transfer@1' } } },
        { name: 'count', type: 'number' }, { name: 'exists', type: 'boolean' },
      ],
      schemas: [{
        id: 'attribute-transfer', version: '1', fields: [
          { name: 'intensity', type: 'number' },
          { name: 'sourceId', type: 'string', nullable: true },
          { name: 'targetId', type: 'string', nullable: true },
        ],
      }],
    })
    const tags = [
      { type: 'transfer', sourceId: '', targetId: '', intensity: undefined },
      { type: 'transfer', sourceId: 'source', targetId: 'target', intensity: 4 },
      { type: 'other', sourceId: 'ignored', targetId: 'ignored', intensity: 9 },
    ]
    const globals = {
      flow: {
        refs: { player: () => 'player' },
        query: {
          hasPlayer: () => true,
          player: () => ({ playerId: 'player', statusTags: tags }),
          playerText: () => 'player',
        },
      },
      battle: { players: [{ playerId: 'player', statusTags: tags }] },
    }
    const original = execute(source, globals)
    const migrated = execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals)
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({
      records: [
        { intensity: 0, sourceId: null, targetId: null },
        { intensity: 4, sourceId: 'source', targetId: 'target' },
      ],
      count: 2,
      exists: true,
    })
  })

  it('does not turn a missing status id into a match when the requested id is null', () => {
    const source = graph([
      call('target', 'ref.target'),
      call('has-id', 'status.has-id', { piece: output('target', 'piece'), statusId: literal(null) }),
      { kind: 'return', id: 'done', value: output('has-id') },
    ], { outputs: [{ name: 'value', type: 'boolean' }] })
    const globals = {
      flow: {
        refs: { target: () => 'target' },
        query: {
          hasPiece: () => true,
          piece: () => ({ statusTags: [{ type: 'mark' }] }),
        },
      },
    }
    expect(execute(source, globals).value).toBe(false)
    expect(execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals).value).toBe(false)
  })

  it('keeps the first matching status id authoritative for skill lookup', () => {
    const source = graph([
      call('target', 'ref.target'),
      call('has-skill', 'status.has-skill-id', {
        piece: output('target', 'piece'), statusId: literal('status-1'), skillId: literal('skill-b'),
      }),
      { kind: 'return', id: 'done', value: output('has-skill') },
    ], { outputs: [{ name: 'value', type: 'boolean' }] })
    const globals = flowForTest()
    const original = execute(source, globals)
    const migrated = execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals)
    expect(original.value).toBe(false)
    expect(migrated.value).toBe(original.value)
  })

  it('a missing status has no granted skills and still takes the false branch', () => {
    const source = graph([
      call('has-skill', 'status.has-skill-instance', { status: literal(null), skillId: literal('skill-a') }),
      { kind: 'if', id: 'skill-condition', condition: output('has-skill'),
        then: [{ kind: 'return', id: 'yes', values: { value: literal(true) } }],
        else: [{ kind: 'return', id: 'no', values: { value: literal(false) } }],
      },
      { kind: 'return', id: 'unexpected-fallthrough', values: { value: literal(true) } },
    ], { outputs: [{ name: 'value', type: 'boolean' }] })
    const globals = { flow: { status: { hasSkillInstance: () => false } } }
    expect(execute(source, globals).value).toEqual({ value: false })
    expect(execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals).value).toEqual({ value: false })
  })

  it('keeps representative existing collection and result recipes equivalent', () => {
    const source = graph([
      call('target', 'ref.target'),
      call('source', 'ref.source'),
      call('player', 'ref.player'),
      call('has-piece', 'status.has-piece', { piece: output('target', 'piece') }, { statusType: 'mark' }),
      call('count-piece', 'status.count-piece', { piece: output('target', 'piece') }, { statusType: 'mark' }),
      call('has-player', 'status.has-player', { player: output('player', 'player') }, { statusType: 'mark' }),
      call('has-rule', 'rule.has-piece', { piece: output('target', 'piece') }, { ruleId: 'rule-1' }),
      call('captured', 'source.capture-event-piece', {}, { field: 'piece' }),
      call('captured-status', 'source.captured-has-status', { source: output('captured', 'source') }, { statusType: 'mark' }),
      call('source-turn', 'status.has-source-turn', { source: output('source', 'piece'), target: output('target', 'piece'), turn: literal(3) }, { statusType: 'mark' }),
      call('result', 'test.result'),
      call('killed', 'effect.result-killed', { result: output('result', 'result') }),
      call('result-number', 'effect.result-number', { result: output('result', 'result') }, { field: 'damage' }),
      call('batch-amount', 'damage.batch-amount-at', { result: output('result', 'result'), index: literal(0) }),
      call('batch-success', 'damage.batch-succeeded-at', { result: output('result', 'result'), index: literal(0) }),
      call('matches-type', 'status.matches-type', { piece: output('target', 'piece') }, { statusType: 'mark', legacyStrings: 'contains' }),
      call('batch-total', 'damage.batch-total', { result: output('result', 'result') }),
      { kind: 'return', id: 'done', values: {
        hasPiece: output('has-piece'), countPiece: output('count-piece'), hasPlayer: output('has-player'), hasRule: output('has-rule'),
        capturedStatus: output('captured-status'), sourceTurn: output('source-turn'), killed: output('killed', 'killed'),
        resultNumber: output('result-number'), batchAmount: output('batch-amount'), batchSuccess: output('batch-success'),
        matchesType: output('matches-type'), batchTotal: output('batch-total'),
      } },
    ], {
      outputs: [
        { name: 'hasPiece', type: 'boolean' }, { name: 'countPiece', type: 'number' }, { name: 'hasPlayer', type: 'boolean' },
        { name: 'hasRule', type: 'boolean' }, { name: 'capturedStatus', type: 'boolean' }, { name: 'sourceTurn', type: 'boolean' },
        { name: 'killed', type: 'boolean' }, { name: 'resultNumber', type: 'number' }, { name: 'batchAmount', type: 'number' },
        { name: 'batchSuccess', type: 'boolean' }, { name: 'matchesType', type: 'boolean' }, { name: 'batchTotal', type: 'number' },
      ],
    })
    const globals = flowForTest()
    const registry = resultRegistry()
    const original = execute(source, globals, registry)
    const migrated = execute(rewriteAtomicGraph(source, atomicPredicateRecipe), globals, registry)
    expect(migrated.value).toEqual(original.value)
    expect(migrated.value).toEqual({
      hasPiece: true, countPiece: 1, hasPlayer: true, hasRule: true, capturedStatus: true, sourceTurn: true,
      killed: false, resultNumber: 7, batchAmount: 7, batchSuccess: true, matchesType: true, batchTotal: 109,
    })
  })
})
