import { describe, expect, it } from 'vitest'
import { migrateAuthorGuards } from '../../lib/skill-graph/atomic-migration-guards'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: string | number | boolean): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters?: Record<string, string | number | boolean>, version = '1'): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, ...(parameters ? { parameters } : {}) } as GameplayCallStatement
}

function graph(body: readonly GameplayStatement[], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body,
    ...extra,
  }
}

function missingGuard(prefix: string, module: 'query.has-piece' | 'query.has-player' | 'piece.alive', reference: GameplayValue): GameplayStatement[] {
  const inputName = module === 'query.has-piece' ? 'pieceId' : module === 'query.has-player' ? 'playerId' : 'piece'
  const port = module === 'piece.alive' ? 'alive' : 'exists'
  return [
    call(`${prefix}-guard`, module, { [inputName]: reference }),
    call(`${prefix}-missing`, 'logic.not', { value: output(`${prefix}-guard`, port) }),
    {
      kind: 'if',
      id: `${prefix}-check`,
      condition: output(`${prefix}-missing`),
      then: [
        call(`${prefix}-failure`, 'result.action', { success: literal(false), message: literal('失效引用') }),
        { kind: 'return', id: `${prefix}-failure-return`, value: output(`${prefix}-failure`, 'result') },
      ],
      else: [],
    },
    call(`${prefix}-tail`, 'result.action', { success: literal(true), message: literal('尾部继续') }),
  ]
}

describe('atomic author guard migration', () => {
  it('removes missing-reference fallbacks in every graph scope while keeping independent tails', () => {
    const original = graph([
      ...missingGuard('piece', 'query.has-piece', input('piece')),
    ], {
      inputs: [
        { name: 'piece', type: 'piece' },
        { name: 'player', type: 'player' },
      ],
      composites: [{
        id: 'composite',
        version: '1',
        inputs: [],
        outputs: [],
        body: missingGuard('piece', 'query.has-piece', input('piece')),
      }, {
        id: 'player-composite',
        version: '1',
        inputs: [],
        outputs: [],
        body: missingGuard('player', 'query.has-player', input('player')),
      }],
      continuations: [{
        id: 'continuation',
        version: '1',
        graph: graph(missingGuard('dead', 'piece.alive', input('piece')), { surface: 'pending' }),
      }],
    })
    const snapshot = JSON.stringify(original)

    const result = migrateAuthorGuards(original)

    expect(JSON.stringify(original)).toBe(snapshot)
    expect(result.changes).toHaveLength(3)
    expect(result.changes.map(change => change.kind)).toEqual([
      'remove-defensive-fallback',
      'remove-defensive-fallback',
      'remove-defensive-fallback',
    ])
    expect(result.retained).toEqual([expect.objectContaining({
      callId: 'dead-guard',
      module: 'piece.alive',
      ifId: 'dead-check',
      reason: 'alive-boundary-not-proven',
    })])
    expect(result.report).toMatchObject({
      scannedGuardCalls: 4,
      guardedIfs: 4,
      missingChecks: 4,
      validChecks: 0,
      unboundGuards: 0,
    })
    expect(result.graph.body.map(statement => statement.id)).toEqual(['piece-tail'])
    expect(result.graph.composites?.[0].body.map(statement => statement.id)).toEqual(['piece-tail'])
    expect(result.graph.composites?.[1].body.map(statement => statement.id)).toEqual(['player-tail'])
    expect(result.graph.continuations?.[0].graph.body.map(statement => statement.id)).toEqual(['dead-guard', 'dead-missing', 'dead-check', 'dead-tail'])

    const twice = migrateAuthorGuards(result.graph)
    expect(twice.graph).toEqual(result.graph)
    expect(twice.changes).toEqual([])
    expect(twice.retained).toEqual([expect.objectContaining({
      callId: 'dead-guard',
      ifId: 'dead-check',
      reason: 'alive-boundary-not-proven',
    })])
  })

  it('retains a survival guard when only pure reads depend on the reference', () => {
    const body: GameplayStatement[] = [
      call('alive', 'piece.alive', { piece: input('piece') }),
      {
        kind: 'if',
        id: 'alive-branch',
        condition: output('alive', 'alive'),
        then: [
          call('owner', 'piece.owner', { piece: input('piece') }),
          call('name', 'attribute.player-text', { player: output('owner', 'player') }, { attribute: 'name' }),
          call('message', 'text.concat', { left: output('name', 'text'), right: literal('继续') }),
          call('success', 'result.action', { success: literal(true), message: output('message', 'text') }),
          { kind: 'return', id: 'return-success', value: output('success', 'result') },
        ],
      },
      call('after', 'result.action', { success: literal(true), message: literal('独立尾部') }),
    ]
    const result = migrateAuthorGuards(graph(body, { inputs: [{ name: 'piece', type: 'piece' }] }))

    expect(result.changes).toEqual([])
    expect(result.retained).toEqual([expect.objectContaining({
      callId: 'alive',
      ifId: 'alive-branch',
      reason: 'alive-boundary-not-proven',
    })])
    expect(result.graph.body.map(statement => statement.id)).toEqual(['alive', 'alive-branch', 'after'])
  })

  it('unwraps a valid guard when a dependent module declares the living boundary', () => {
    const result = migrateAuthorGuards(graph([
      call('alive', 'piece.alive', { piece: input('piece') }),
      {
        kind: 'if',
        id: 'alive-branch',
        condition: output('alive', 'alive'),
        then: [
          call('relation', 'query.same-relation', {
            source: input('piece'),
            target: input('target'),
          }, { relation: 'ally' }, '2'),
          call('success', 'result.action', {
            success: output('relation', 'value'),
            message: literal('继续'),
          }),
          { kind: 'return', id: 'return-success', value: output('success', 'result') },
        ],
      },
      call('after', 'result.action', { success: literal(true), message: literal('独立尾部') }),
    ], {
      inputs: [
        { name: 'piece', type: 'piece' },
        { name: 'target', type: 'piece' },
      ],
    }))

    expect(result.changes).toEqual([expect.objectContaining({
      kind: 'unwrap-dependent-guard',
      callId: 'alive',
      ifId: 'alive-branch',
    })])
    expect(result.retained).toEqual([])
    expect(result.graph.body.map(statement => statement.id)).toEqual(['relation', 'success', 'return-success', 'after'])
  })

  it('retains a survival guard when a dependent stateful operation lacks a living-reference contract', () => {
    const result = migrateAuthorGuards(graph([
      call('alive', 'piece.alive', { piece: input('piece') }),
      {
        kind: 'if',
        id: 'alive-branch',
        condition: output('alive', 'alive'),
        then: [
          call('damage', 'effect.damage', {
            source: input('piece'),
            target: input('target'),
            amount: literal(1),
          }),
        ],
      },
      call('after', 'result.action', { success: literal(true), message: literal('独立尾部') }),
    ], {
      inputs: [
        { name: 'piece', type: 'piece' },
        { name: 'target', type: 'piece' },
      ],
    }))

    expect(result.changes).toEqual([])
    expect(result.retained).toEqual([expect.objectContaining({
      callId: 'alive',
      ifId: 'alive-branch',
      reason: 'alive-boundary-not-proven',
    })])
    expect(result.graph.body.map(statement => statement.id)).toEqual(['alive', 'alive-branch', 'after'])
  })

  it('promotes both reversed fallback orientations while retaining reused guard outputs', () => {
    const validWrapper = migrateAuthorGuards(graph([
      call('exists', 'query.has-piece', { pieceId: input('piece') }),
      {
        kind: 'if',
        id: 'valid-wrapper',
        condition: output('exists', 'exists'),
        then: [
          call('success', 'result.action', { success: literal(true) }),
          { kind: 'return', id: 'success-return', value: output('success', 'result') },
        ],
        else: [
          call('failure', 'result.message', { message: literal('') }, { success: false }),
          { kind: 'return', id: 'failure-return', values: { success: output('failure', 'success') } },
        ],
      },
    ]))
    const missingWrapper = migrateAuthorGuards(graph([
      call('exists', 'query.has-player', { playerId: input('player') }),
      call('missing', 'logic.not', { value: output('exists', 'exists') }),
      {
        kind: 'if',
        id: 'missing-wrapper',
        condition: output('missing'),
        then: [
          call('failure', 'result.action', { success: literal(false) }),
          { kind: 'return', id: 'failure-return', value: output('failure', 'result') },
        ],
        else: [
          call('success', 'result.action', { success: literal(true) }),
          { kind: 'return', id: 'success-return', value: output('success', 'result') },
        ],
      },
    ]))
    const reusedOutput = migrateAuthorGuards(graph([
      call('exists', 'query.has-piece', { pieceId: input('piece') }),
      {
        kind: 'if',
        id: 'reused-wrapper',
        condition: output('exists', 'exists'),
        then: [call('reuse', 'logic.not', { value: output('exists', 'exists') })],
        else: [
          call('failure', 'result.action', { success: literal(false) }),
          { kind: 'return', id: 'failure-return', value: output('failure', 'result') },
        ],
      },
    ]))

    expect(validWrapper.changes).toEqual([expect.objectContaining({ kind: 'promote-valid-branch', ifId: 'valid-wrapper' })])
    expect(validWrapper.graph.body.map(statement => statement.id)).toEqual(['success', 'success-return'])
    expect(missingWrapper.changes).toEqual([expect.objectContaining({ kind: 'promote-valid-branch', ifId: 'missing-wrapper' })])
    expect(missingWrapper.graph.body.map(statement => statement.id)).toEqual(['success', 'success-return'])
    expect(reusedOutput.changes).toEqual([])
    expect(reusedOutput.retained).toEqual([expect.objectContaining({
      callId: 'exists',
      ifId: 'reused-wrapper',
      reason: 'guard-output-used-elsewhere',
    })])
  })

  it('retains meaningful or unproven conditions with concrete reasons', () => {
    const independent = graph([
      call('owner-exists', 'query.has-player', { playerId: input('player') }),
      { kind: 'if', id: 'owner-branch', condition: output('owner-exists', 'exists'), then: [
        call('constant', 'math.add', { left: literal(1), right: literal(2) }),
      ] },
    ])
    const withElse = graph([
      call('piece-exists', 'query.has-piece', { pieceId: input('piece') }),
      { kind: 'if' as const, id: 'piece-branch', condition: output('piece-exists', 'exists'), then: [
        call('tail', 'result.action', { success: literal(true) }),
      ], else: [{ kind: 'return' as const, id: 'else-return', values: { success: literal(false) } }] },
    ])
    const nonPureFallback = graph([
      ...[
        call('guard', 'query.has-piece', { pieceId: input('piece') }),
        call('missing', 'logic.not', { value: output('guard', 'exists') }),
        {
          kind: 'if' as const,
          id: 'check',
          condition: output('missing'),
          then: [
            call('write', 'effect.damage-captured', { source: input('piece'), target: input('piece'), amount: literal(1) }),
            { kind: 'return' as const, id: 'failure-return', values: { success: literal(false) } },
          ],
        },
        call('tail', 'result.action', { success: literal(true) }),
      ],
    ])

    const first = migrateAuthorGuards(independent)
    const second = migrateAuthorGuards(withElse)
    const third = migrateAuthorGuards(nonPureFallback)

    expect(first.changes).toEqual([])
    expect(first.retained).toEqual([expect.objectContaining({ callId: 'owner-exists', ifId: 'owner-branch', reason: 'body-has-independent-work' })])
    expect(second.changes).toEqual([expect.objectContaining({
      kind: 'promote-valid-branch',
      callId: 'piece-exists',
      ifId: 'piece-branch',
    })])
    expect(second.retained).toEqual([])
    expect(second.graph.body.map(statement => statement.id)).toEqual(['tail'])
    expect(third.changes).toEqual([])
    expect(third.retained).toEqual([expect.objectContaining({ callId: 'guard', ifId: 'check', reason: 'fallback-has-non-pure-call' })])
  })
})
