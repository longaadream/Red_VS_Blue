import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { dealDamage } from '../../lib/game/skills'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicLocalAliasRecipe, migrateAtomicTextListGraph } from '../../lib/skill-graph/atomic-migration-local-aliases'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayLiteral, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'
import { AMATERASU_RULE_IDS, buildAmaterasuRuleGraph } from '../../scripts/migrate-semantic-amaterasu'
import { buildRafaamCurseCardGraph, buildRafaamCurseEndTurnGraph, buildRafaamCurseWardGraph } from '../../scripts/migrate-semantic-rafaam-curse'
import { SHISHIO_VELEN_COLT_RULE_IDS, buildShishioVelenColtGraph } from '../../scripts/migrate-semantic-shishio-velen-colt'

const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters?: Record<string, GameplayLiteral>): GameplayStatement => ({
  kind: 'call', id, module, version: '1', inputs,
  ...(parameters === undefined ? {} : { parameters }),
})

const stringListType = { kind: 'list' as const, element: 'string' as const }

function execute(graph: GameplayModuleGraph): unknown {
  const battle = makeState()
  const context = {}
  const flow = createFlowRuntime(battle, context, 'skill', {})
  const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
  return new Function('flow', 'battle', 'return (' + code + ')')(flow, battle)(context)
}

function executeRuleGraph(graph: GameplayModuleGraph): { result: unknown; battle: unknown } {
  const shishio = makePiece({ instanceId: 'shishio', templateId: 'red-shishio', ownerPlayerId: 'player-red', name: '志志雄真实', x: 0, y: 0, currentHp: 100, attack: 7 })
  const target = makePiece({ instanceId: 'target', templateId: 'target', ownerPlayerId: 'player-blue', name: '目标', x: 1, y: 0, currentHp: 9, maxHp: 20 })
  const battle = makeState({ pieces: [shishio, target] })
  battle.extensions!.shishioBurnTiles = [{ x: target.x, y: target.y, sourcePieceId: shishio.instanceId }]
  const context = { type: 'endTurn', playerId: 'player-red', triggerPlayerId: 'player-blue', rulePiece: shishio }
  const flow = createFlowRuntime(battle, context, 'rule', { dealDamage })
  const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
  const run = new Function('flow', 'battle', 'context', code) as (flow: unknown, battle: unknown, context: unknown) => unknown
  return { result: run(flow, battle, context), battle }
}

function graph(body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs }
}

function migrate(source: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(migrateAtomicTextListGraph(source), atomicLocalAliasRecipe)
}

function modulesIn(statements: readonly GameplayStatement[]): string[] {
  const result: string[] = []
  for (const statement of statements) {
    if (statement.kind === 'call') result.push(statement.module)
    if (statement.kind === 'if') {
      result.push(...modulesIn(statement.then))
      if (statement.else) result.push(...modulesIn(statement.else))
    } else if (statement.kind === 'foreach' || statement.kind === 'while' || statement.kind === 'collection' || statement.kind.startsWith('collection.')) {
      if ('body' in statement) result.push(...modulesIn(statement.body))
    }
  }
  return result
}

describe('local and text-list atomic migrations', () => {
  it('lowers counter aliases to typed locals and preserves negative, fractional, repeated updates', () => {
    const source = graph([
      call('counter', 'local.counter-create', { initial: literal(-2.5) }),
      call('first-add', 'local.counter-add', { counter: out('counter', 'counter'), amount: literal(-1.25) }),
      call('second-add', 'local.counter-add', { counter: out('counter', 'counter'), amount: literal(3.75) }),
      call('read', 'local.counter-read', { counter: out('counter', 'counter') }),
      { kind: 'return', id: 'done', values: { first: out('first-add', 'value'), second: out('second-add', 'value'), read: out('read', 'value') } },
    ], [{ name: 'first', type: 'number' }, { name: 'second', type: 'number' }, { name: 'read', type: 'number' }])
    const migrated = migrate(source)
    expect(execute(migrated)).toEqual(execute(source))
    expect(execute(migrated)).toEqual({ first: -3.75, second: 0, read: 0 })
    expect(migrated.body.filter(statement => statement.kind === 'call').map(statement => statement.module)).not.toEqual(expect.arrayContaining([
      'local.counter-create', 'local.counter-add', 'local.counter-read',
    ]))
    expect(rewriteAtomicGraph(migrated, atomicLocalAliasRecipe)).toEqual(migrated)
  })

  it('retains counter finite-number rejection at declaration and overflow boundaries', () => {
    const declaration = graph([
      call('counter', 'local.counter-create', { initial: literal(Number.POSITIVE_INFINITY) }),
      { kind: 'return', id: 'done', value: out('counter', 'counter') },
    ], [{ name: 'value', type: 'record' }])
    expect(() => execute(declaration)).toThrow()
    expect(() => execute(migrate(declaration))).toThrow()

    const overflow = graph([
      call('counter', 'local.counter-create', { initial: literal(Number.MAX_VALUE) }),
      call('add', 'local.counter-add', { counter: out('counter', 'counter'), amount: literal(Number.MAX_VALUE) }),
      { kind: 'return', id: 'done', value: out('add', 'value') },
    ], [{ name: 'value', type: 'number' }])
    expect(() => execute(overflow)).toThrow()
    expect(() => execute(migrate(overflow))).toThrow()
  })

  it('keeps a local string list scoped to one handle across nested loops, including duplicates and empty input', () => {
    const makeGraph = (initial: readonly string[], additions: readonly string[]): GameplayModuleGraph => graph([
      call('list', 'local.string-list-create', { items: literal(initial) }),
      {
        kind: 'foreach', id: 'outer', items: literal(additions), item: 'outerItem', body: [
          {
            kind: 'foreach', id: 'inner', items: literal(['inner']), item: 'innerItem', body: [
              call('append-inner', 'local.string-list-append', { list: out('list', 'list'), value: input('outerItem') }),
            ],
          },
        ],
      },
      call('read', 'local.string-list-read', { list: out('list', 'list') }),
      { kind: 'return', id: 'done', value: out('read', 'items') },
    ], [{ name: 'value', type: stringListType }])

    for (const [initial, additions] of [[[], []], [[], ['same', 'same']], [['seed', 'seed'], ['first', 'second']] as const]) {
      const source = makeGraph(initial, additions)
      expect(execute(migrate(source))).toEqual(execute(source))
    }
    const successSource = graph([
      call('list', 'local.string-list-create', { items: literal(['seed']) }),
      call('append', 'local.string-list-append', { list: out('list', 'list'), value: literal('seed') }),
      call('read', 'local.string-list-read', { list: out('list', 'list') }),
      { kind: 'return', id: 'done', values: { success: out('append', 'success'), items: out('read', 'items') } },
    ], [{ name: 'success', type: 'boolean' }, { name: 'items', type: stringListType }])
    expect(execute(migrate(successSource))).toEqual(execute(successSource))
    expect(execute(migrate(successSource))).toEqual({ success: true, items: ['seed', 'seed'] })
    const migrated = migrate(makeGraph([], ['a']))
    const modules = modulesIn(migrated.body)
    expect(modules).toEqual(expect.arrayContaining(['local.declare', 'local.read', 'local.write', 'collection.singleton', 'collection.concat']))
    expect(modules).not.toEqual(expect.arrayContaining(['local.string-list-create', 'local.string-list-append', 'local.string-list-read']))
  })

  it('keeps collection text-list order, duplicates, count, and empty creation without a hidden handle', () => {
    const source = graph([
      call('items', 'collection.text-list-create'),
      call('first', 'collection.text-list-add', { items: out('items', 'items'), value: literal('same') }),
      call('second', 'collection.text-list-add', { items: out('first', 'items'), value: literal('same') }),
      call('third', 'collection.text-list-add', { items: out('second', 'items'), value: literal('last') }),
      { kind: 'return', id: 'done', values: {
        items: out('third', 'items'), firstItems: out('first', 'items'), firstCount: out('first', 'count'), count: out('third', 'count'),
      } },
    ], [{ name: 'items', type: stringListType }, { name: 'firstItems', type: stringListType }, { name: 'firstCount', type: 'number' }, { name: 'count', type: 'number' }])
    const migrated = migrate(source)
    expect(execute(migrated)).toEqual(execute(source))
    expect(execute(migrated)).toEqual({ items: ['same', 'same', 'last'], firstItems: ['same', 'same', 'last'], firstCount: 1, count: 3 })
    expect(migrated.body.filter(statement => statement.kind === 'call').map(statement => statement.module)).not.toEqual(expect.arrayContaining([
      'collection.text-list-create', 'collection.text-list-add',
    ]))

    const empty = graph([
      call('items', 'collection.text-list-create'),
      { kind: 'return', id: 'done', value: out('items', 'items') },
    ], [{ name: 'items', type: stringListType }])
    expect(execute(migrate(empty))).toEqual(execute(empty))
    expect(execute(migrate(empty))).toEqual([])
  })

  it('preserves shared create accumulation in a real burn-shaped loop and reads the latest value at return', () => {
    const source = graph([
      call('messages', 'collection.text-list-create'),
      {
        kind: 'foreach', id: 'burn-loop', items: literal(['first', 'second']), item: 'item', body: [
          {
            kind: 'foreach', id: 'nested-burn-loop', items: literal(['same-tile', 'same-tile']), item: 'nestedItem', body: [
              call('append', 'collection.text-list-add', { items: out('messages', 'items'), value: out('burn-loop', 'item') }),
            ],
          },
        ],
      },
      call('joined', 'text.join-list', { items: out('messages', 'items') }, { separator: '；' }),
      call('count', 'list.count', { items: out('messages', 'items') }),
      { kind: 'return', id: 'done', values: {
        items: out('messages', 'items'), text: out('joined', 'text'), count: out('count', 'count'),
      } },
    ], [{ name: 'items', type: stringListType }, { name: 'text', type: 'string' }, { name: 'count', type: 'number' }])

    expect(execute(source)).toEqual({ items: ['first', 'first', 'second', 'second'], text: 'first；first；second；second', count: 4 })
    expect(execute(migrate(source))).toEqual(execute(source))

    const real = buildShishioVelenColtGraph('rule-shishio-burn-endturn')
    const realMigrated = migrate(real)
    expect(real.body.some(statement => statement.kind === 'call' && statement.module === 'collection.text-list-create')).toBe(true)
    expect(JSON.stringify(realMigrated)).not.toContain('collection.text-list-')
    expect(() => compileGameplayModuleGraph(realMigrated, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()

    const legacyExecution = executeRuleGraph(real)
    const migratedExecution = executeRuleGraph(migrateAtomicTextListGraph(real))
    expect(migratedExecution).toEqual(legacyExecution)
  })

  it('migrates the other active shared text-list factories without relying on edited data', () => {
    const factories = [
      () => buildRafaamCurseEndTurnGraph(),
      () => buildRafaamCurseWardGraph(),
      () => buildRafaamCurseCardGraph(),
      ...AMATERASU_RULE_IDS.map(id => () => buildAmaterasuRuleGraph(id)),
      ...SHISHIO_VELEN_COLT_RULE_IDS.map(id => () => buildShishioVelenColtGraph(id)),
    ]
    for (const build of factories) {
      const source = build()
      const before = JSON.stringify(source)
      const migrated = migrate(source)
      expect(JSON.stringify(source)).toBe(before)
      expect(JSON.stringify(migrated)).not.toContain('collection.text-list-')
      expect(() => compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
    }
  })

  it('rejects a text-list add without a create-backed handle before changing the graph', () => {
    const source = graph([
      call('broken', 'collection.text-list-add', { items: literal([]), value: literal('x') }),
      { kind: 'return', id: 'done', value: literal([]) },
    ], [{ name: 'items', type: stringListType }])
    const before = JSON.stringify(source)
    expect(() => migrateAtomicTextListGraph(source)).toThrow(/create-backed items reference/)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('does not rewrite malformed alias calls and preserves nested generated ids', () => {
    const malformed = graph([
      call('broken', 'local.counter-add', { amount: literal(1) }),
      { kind: 'return', id: 'done', value: literal(null) },
    ], [{ name: 'value', type: 'null' }])
    expect(migrate(malformed)).toEqual(malformed)

    const source = graph([
      call('counter', 'local.counter-create', { initial: literal(0) }),
      {
        kind: 'foreach', id: 'each', items: literal([1, 2]), item: 'item', body: [
          call('add', 'local.counter-add', { counter: out('counter', 'counter'), amount: input('item') }),
        ],
      },
      call('read', 'local.counter-read', { counter: out('counter', 'counter') }),
      { kind: 'return', id: 'done', value: out('read', 'value') },
    ], [{ name: 'value', type: 'number' }])
    const migrated = migrate(source)
    const generatedIds = new Set<string>()
    for (const statement of migrated.body) if (statement.kind === 'call') generatedIds.add(statement.id)
    const inner = migrated.body.find(statement => statement.kind === 'foreach')
    if (inner?.kind === 'foreach') for (const statement of inner.body) if (statement.kind === 'call') generatedIds.add(statement.id)
    expect(generatedIds.size).toBe(6)
    expect(execute(migrated)).toBe(3)
  })
})
