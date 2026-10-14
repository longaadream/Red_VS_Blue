import { describe, expect, it } from 'vitest'
import {
  migrateRelationModules,
  type RelationMigrationOptions,
} from '../../lib/skill-graph/atomic-migration-relations'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  version: string,
  inputs: Record<string, GameplayValue> = {},
  parameters?: Record<string, string>,
  extra: Record<string, unknown> = {},
): GameplayCallStatement {
  return {
    kind: 'call',
    id,
    module,
    version,
    inputs,
    ...(parameters ? { parameters } : {}),
    ...extra,
  } as GameplayCallStatement
}

function graph(body: readonly GameplayStatement[], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body,
    ...extra,
  }
}

function statementsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  const walk = (statements: readonly GameplayStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'call') result.push(statement)
      if (statement.kind === 'if') {
        walk(statement.then)
        if (statement.else) walk(statement.else)
      } else if (statement.kind === 'foreach' || statement.kind === 'while') {
        walk(statement.body)
      } else if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.reduce') {
        walk((statement as { readonly body: readonly GameplayStatement[] }).body)
      }
    }
  }
  walk(body)
  return result
}

describe('atomic relation graph migration', () => {
  it('rewrites relation predicates to faction fields in branches, composites, and continuations', () => {
    const source = input('source')
    const target = input('target')
    const player = input('leftPlayer')
    const otherPlayer = input('rightPlayer')
    const original = graph([
      call('ally', 'query.same-relation', '2', { source, target }, { relation: 'ally' }, { layout: { keep: 'relation-layout' } }),
      {
        kind: 'if',
        id: 'branch',
        condition: output('ally'),
        then: [call('enemy', 'query.same-relation', '2', { source, target }, { relation: 'enemy' })],
        else: [],
      },
      call('use-ally', 'logic.not', '1', { value: output('ally') }),
    ], {
      inputs: [
        { name: 'source', type: 'piece' },
        { name: 'target', type: 'piece' },
        { name: 'leftPlayer', type: 'player' },
        { name: 'rightPlayer', type: 'player' },
      ],
      composites: [{
        id: 'nested-composite',
        version: '1',
        inputs: [],
        outputs: [],
        body: [call('composite-relation', 'compare.allied-players', '1', { left: player, right: otherPlayer })],
      }],
      continuations: [{
        id: 'nested-continuation',
        version: '1',
        graph: graph([call('continuation-relation', 'query.same-relation', '2', { source, target }, { relation: 'ally' })], { surface: 'pending' }),
      }],
    })

    const result = migrateRelationModules(original)
    expect(result.conflicts).toEqual([])
    expect(result.changes).toHaveLength(4)
    expect(original.body[0]).toMatchObject({ module: 'query.same-relation', version: '2' })

    const rootCalls = statementsIn(result.graph.body)
    expect(rootCalls.map(statement => statement.id)).toEqual([
      'ally--source-faction', 'ally--target-faction', 'ally',
      'enemy--source-faction', 'enemy--target-faction', 'enemy--compare', 'enemy',
      'use-ally',
    ])
    expect(rootCalls.find(statement => statement.id === 'ally')).toMatchObject({ module: 'compare.text', version: '1' })
    expect(rootCalls.find(statement => statement.id === 'enemy--compare')).toMatchObject({ module: 'compare.text', version: '1' })
    expect(rootCalls.find(statement => statement.id === 'enemy')).toMatchObject({ module: 'logic.not', version: '1' })
    expect(rootCalls.find(statement => statement.id === 'use-ally')?.inputs?.value).toEqual(output('ally'))
    expect(result.graph.body.find(statement => statement.id === 'branch')).toMatchObject({ condition: output('ally') })

    const allyLeft = rootCalls.find(statement => statement.id === 'ally--source-faction')!
    const allyRight = rootCalls.find(statement => statement.id === 'ally--target-faction')!
    expect(allyLeft).toMatchObject({ module: 'attribute.text', version: '2', inputs: { piece: source }, parameters: { attribute: 'faction' } })
    expect(allyRight).toMatchObject({ module: 'attribute.text', version: '2', inputs: { piece: target }, parameters: { attribute: 'faction' } })
    expect(allyLeft.layout?.sentenceExpression).toEqual({ owner: 'ally', input: 'left' })
    expect(allyRight.layout?.sentenceExpression).toEqual({ owner: 'ally', input: 'right' })
    expect(allyLeft.layout?.keep).toBeUndefined()
    expect(rootCalls.find(statement => statement.id === 'ally')?.layout).toEqual({ keep: 'relation-layout' })

    const compositeCalls = statementsIn(result.graph.composites![0].body)
    expect(compositeCalls.map(statement => statement.id)).toEqual([
      'composite-relation--left-faction', 'composite-relation--right-faction', 'composite-relation',
    ])
    expect(compositeCalls.find(statement => statement.id === 'composite-relation--left-faction')).toMatchObject({ module: 'attribute.player-text', version: '1', parameters: { attribute: 'faction' } })
    expect(compositeCalls.find(statement => statement.id === 'composite-relation--left-faction')?.layout?.sentenceExpression).toEqual({ owner: 'composite-relation', input: 'left' })

    const continuationCalls = statementsIn(result.graph.continuations![0].graph.body)
    expect(continuationCalls.map(statement => statement.id)).toEqual([
      'continuation-relation--source-faction', 'continuation-relation--target-faction', 'continuation-relation',
    ])
  })

  it('uses a dead-safe owner faction path for v1 and reports explicit preservation', () => {
    const legacy = call('legacy', 'query.same-relation', '1', { source: input('source'), target: input('target') }, { relation: 'enemy' })
    const alliedPlayers = call('players', 'compare.allied-players', '1', { left: input('left'), right: input('right') })
    const source = graph([legacy, alliedPlayers])

    const migrated = migrateRelationModules(source)
    expect(migrated.conflicts).toEqual([])
    expect(migrated.changes).toHaveLength(2)
    expect(statementsIn(migrated.graph.body).find(statement => statement.id === 'legacy')).toMatchObject({ module: 'logic.not', version: '1' })
    expect(statementsIn(migrated.graph.body).find(statement => statement.id === 'legacy--source-owner')).toMatchObject({ module: 'piece.owner', version: '1' })
    expect(statementsIn(migrated.graph.body).find(statement => statement.id === 'legacy--source-faction')).toMatchObject({ module: 'attribute.player-text', version: '1', inputs: { player: output('legacy--source-owner', 'player') } })
    expect(migrated.changes.find(change => change.callId === 'legacy')?.fieldStrategy).toBe('owner-player-faction')

    const preserved = migrateRelationModules(source, { legacyV1: 'preserve' })
    expect(preserved.conflicts).toEqual([{
      callId: 'legacy',
      module: 'query.same-relation',
      version: '1',
      reason: 'legacy-v1-preserves-dead-references',
    }])
    expect(preserved.changes).toHaveLength(1)
    expect(preserved.graph.body[0]).toMatchObject({ id: 'legacy', module: 'query.same-relation', version: '1' })
    expect(statementsIn(preserved.graph.body).map(statement => statement.id)).toContain('players--left-faction')

    const callbackApproved = migrateRelationModules(source, {
      shouldMigrateLegacyV1: statement => statement.id === 'legacy',
    })
    expect(callbackApproved.conflicts).toEqual([])
    expect(callbackApproved.changes).toHaveLength(2)
  })

  it('keeps self relation identity, output ports, collision safety, and migration metadata', () => {
    const source = input('piece')
    const relation = call('self', 'query.same-relation', '2', { source, target: source }, { relation: 'ally' }, {
      layout: { sentenceExpression: { owner: 'consumer', input: 'value' }, editor: 'keep' }, futureMetadata: { keep: true },
    })
    const consumer = {
      kind: 'if' as const,
      id: 'consumer',
      condition: output('self'),
      then: [],
      else: [],
    }
    const sourceGraph = graph([
      call('self--source-faction', 'math.add', '1', { left: input('unused'), right: input('unused') }),
      relation,
      consumer,
    ])
    const result = migrateRelationModules(sourceGraph)
    const calls = statementsIn(result.graph.body)
    const left = calls.find(statement => statement.id === 'self--source-faction-2')!
    const right = calls.find(statement => statement.id === 'self--target-faction')!
    expect(left).toBeDefined()
    expect(left.inputs?.piece).toEqual(source)
    expect(right.inputs?.piece).toEqual(source)
    expect(calls.find(statement => statement.id === 'self')).toMatchObject({ module: 'compare.text', version: '1' })
    expect(calls.find(statement => statement.id === 'self')?.layout).toEqual({ sentenceExpression: { owner: 'consumer', input: 'value' }, editor: 'keep' })
    expect((calls.find(statement => statement.id === 'self') as unknown as Record<string, unknown>).futureMetadata).toEqual({ keep: true })
    expect(result.graph.body.find(statement => statement.id === 'consumer')).toMatchObject({ condition: output('self') })
  })

  it('compiles the migrated field/compare graph and is idempotent', () => {
    const source = graph([
      call('source-ref', 'ref.source', '1'),
      call('target-ref', 'ref.target', '1'),
      call('same', 'query.same-relation', '2', { source: output('source-ref', 'piece'), target: output('target-ref', 'piece') }, { relation: 'ally' }),
      { kind: 'return', id: 'done', values: { value: output('same') } },
    ], {
      outputs: [{ name: 'value', type: 'boolean' }],
    })
    const once = migrateRelationModules(source)
    expect(once.conflicts).toEqual([])
    const compiled = compileGameplayModuleGraph(once.graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('pieceText')
    expect(compiled.code).toContain('===')
    expect(compiled.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'attribute.text', version: '2' }),
      expect.objectContaining({ id: 'compare.text', version: '1' }),
    ]))

    const legacy = graph([
      call('source-ref', 'ref.source', '1'),
      call('target-ref', 'ref.target', '1'),
      call('legacy', 'query.same-relation', '1', { source: output('source-ref', 'piece'), target: output('target-ref', 'piece') }, { relation: 'enemy' }),
      { kind: 'return', id: 'done', values: { value: output('legacy') } },
    ], { outputs: [{ name: 'value', type: 'boolean' }] })
    const legacyCompiled = compileGameplayModuleGraph(migrateRelationModules(legacy).graph, GAMEPLAY_MODULE_REGISTRY)
    expect(legacyCompiled.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'piece.owner', version: '1' }),
      expect.objectContaining({ id: 'attribute.player-text', version: '1' }),
      expect.objectContaining({ id: 'logic.not', version: '1' }),
    ]))

    const twice = migrateRelationModules(once.graph)
    expect(twice.graph).toEqual(once.graph)
    expect(twice.changes).toEqual([])
    expect(twice.conflicts).toEqual([])
  })

  it('reports invalid relation inputs without producing an invalid graph', () => {
    const invalidRelation = call('bad-relation', 'query.same-relation', '2', { source: input('source'), target: input('target') }, { relation: 'neutral' })
    const missingInput = call('missing', 'compare.allied-players', '1', { left: input('left') })
    const result = migrateRelationModules(graph([invalidRelation, missingInput]))
    expect(result.changes).toEqual([])
    expect(result.conflicts).toEqual([
      { callId: 'bad-relation', module: 'query.same-relation', version: '2', reason: 'invalid-relation' },
      { callId: 'missing', module: 'compare.allied-players', version: '1', reason: 'missing-input' },
    ])
    expect(result.graph.body).toEqual([invalidRelation, missingInput])
  })

  it('accepts an explicit policy object without mutating the input graph', () => {
    const original = graph([call('relation', 'query.same-relation', '1', { source: input('source'), target: input('target') })])
    const snapshot = JSON.stringify(original)
    const options: RelationMigrationOptions = { legacyV1: 'migrate' }
    const result = migrateRelationModules(original, options)
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(result.changes[0]).toMatchObject({ callId: 'relation', fromVersion: '1', relation: 'enemy', referenceKind: 'piece', fieldStrategy: 'owner-player-faction' })
  })
})
