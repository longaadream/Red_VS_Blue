/* eslint-disable @typescript-eslint/no-explicit-any -- graph/runtime fixtures use minimal battle-shaped records. */
import { runInThisContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { removeStatusWithEvents } from '../../lib/game/skills'
import {
  ATOMIC_FLIGHT_STATUS_MODULES,
  migrateFlightStatusModules,
} from '../../lib/skill-graph/atomic-migration-flight-status'
import { FLIGHT_STATUS_HOST_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-flight-status'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayPort,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function fixture(
  id: string,
  outputName: string,
  type: GameplayPort['type'],
  expression: string,
): GameplayModuleDescriptor {
  return {
    id,
    version: '1',
    label: id,
    inputs: [],
    outputs: [{ name: outputName, type }],
    allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true },
    lower: () => expression,
  }
}

const fixtures: readonly GameplayModuleDescriptor[] = [
  fixture('test.cell', 'cell', 'cell', 'context.cell'),
  fixture('test.piece', 'piece', 'piece', 'context.piece'),
  fixture('test.nullable-piece', 'piece', { kind: 'nullable', value: 'piece' }, 'context.piece'),
  fixture('test.text', 'text', 'string', 'context.value'),
  fixture('test.flight', 'text', 'string', 'context.flightId'),
  fixture('test.status-id', 'statusId', { kind: 'nullable', value: 'string' }, 'context.statusId'),
  fixture('test.turn', 'turn', 'number', 'context.turn'),
]

function graph(setup: readonly GameplayCallStatement[], statement: GameplayCallStatement, outputPort: string, outputType: GameplayPort['type']): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      ...setup,
      statement,
      { kind: 'return', id: 'done', values: { value: output(statement.id, outputPort) } },
    ],
    outputs: [{ name: 'value', type: outputType }],
  }
}

function registry(): GameplayModuleRegistry {
  const descriptors = [
    ...GAMEPLAY_MODULE_REGISTRY.descriptors,
    ...FLIGHT_STATUS_HOST_GAMEPLAY_MODULES,
    ...fixtures,
  ]
  const local = new Map(descriptors.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor] as const))
  return {
    get: (id, version) => local.get(id + '@' + (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
    resolve: (id, version) => local.get(id + '@' + (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
    descriptors,
  }
}

function callsIn(statements: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  for (const statement of statements) {
    if (statement.kind === 'call') result.push(statement)
    if (statement.kind === 'if') {
      result.push(...callsIn(statement.then))
      if (statement.else) result.push(...callsIn(statement.else))
    } else if (statement.kind === 'foreach' || statement.kind === 'collection') {
      result.push(...callsIn(statement.body))
    }
  }
  return result
}

function execute(source: GameplayModuleGraph, battle: any, context: Record<string, unknown>): unknown {
  const compiled = compileGameplayModuleGraph(migrateFlightStatusModules(source), registry())
  const flow = createFlowRuntime(battle, {}, 'skill', {
    removeStatusEffectById: (pieceId: string, statusId: string) => removeStatusWithEvents(battle, pieceId, statusId),
  })
  const factory = runInThisContext(`(function(battle,flow){return (${compiled.code})})`) as (battle: unknown, flow: unknown) => (context: unknown) => unknown
  return factory(battle, flow)(context)
}

function reservationGraph(): GameplayModuleGraph {
  const setup = [
    call('cell', 'test.cell'),
    call('id', 'test.text'),
    call('flight', 'test.flight'),
  ]
  return graph(setup, call('add', 'tile.add-reservation', {
    cell: output('cell', 'cell'), id: output('id', 'text'), flightId: output('flight', 'text'),
  }, { effectType: 'reservation' }), 'success', 'boolean')
}

function clearGraph(): GameplayModuleGraph {
  return graph([call('flight', 'test.flight')], call('clear', 'tile.clear-flight-reservations', {
    flightId: output('flight', 'text'),
  }, { effectType: 'reservation' }), 'success', 'boolean')
}

function teleportGraph(): GameplayModuleGraph {
  return graph([call('piece', 'test.nullable-piece'), call('cell', 'test.cell')], call('teleport', 'effect.teleport-if-present', {
    piece: output('piece', 'piece'), destination: output('cell', 'cell'),
  }), 'success', 'boolean')
}

function removeGraph(): GameplayModuleGraph {
  return graph([call('piece', 'test.nullable-piece'), call('flight', 'test.flight')], call('remove', 'status.remove-by-flight', {
    target: output('piece', 'piece'), flightId: output('flight', 'text'),
  }), 'success', 'boolean')
}

function consumeGraph(): GameplayModuleGraph {
  return graph([call('piece', 'test.piece'), call('status-id', 'test.status-id')], call('consume', 'status.consume-counter', {
    piece: output('piece', 'piece'), statusId: output('status-id', 'statusId'),
  }, { field: 'remainingTurns', fallback: 1 }), 'value', 'number')
}

function refreshGraph(): GameplayModuleGraph {
  return graph([call('piece', 'test.piece'), call('turn', 'test.turn')], call('refresh', 'status.refresh-temporary', {
    target: output('piece', 'piece'), turn: output('turn', 'turn'),
  }, { statusType: 'temporary', name: 'temporary', idPrefix: 'temporary-', duration: 3, uses: 2, visible: true }), 'success', 'boolean')
}

describe('atomic flight/status migrations', () => {
  it('expands all six compatibility calls and remains idempotent', () => {
    const cases = [reservationGraph(), clearGraph(), teleportGraph(), removeGraph(), consumeGraph(), refreshGraph()]
    for (const source of cases) {
      const migrated = migrateFlightStatusModules(source)
      expect(callsIn(migrated.body).map(item => item.module)).not.toEqual(expect.arrayContaining([...ATOMIC_FLIGHT_STATUS_MODULES]))
      expect(migrateFlightStatusModules(migrated)).toEqual(migrated)
      expect(() => compileGameplayModuleGraph(migrated, registry())).not.toThrow()
    }
  })

  it('constructs the reservation record and clears only the matching flight', () => {
    const battle = makeState({ width: 5, height: 5 }) as any
    expect(execute(reservationGraph(), battle, { cell: { x: 1, y: 2 }, value: 'flight-a', flightId: 'flight-a' })).toEqual({ value: true })
    expect(battle.extensions?.tileEffects).toEqual([{ id: 'flight-a', type: 'reservation', x: 1, y: 2, flightId: 'flight-a' }])

    battle.extensions.tileEffects.push(
      { id: 'flight-b', type: 'reservation', x: 2, y: 2, flightId: 'flight-b' },
      { id: 'keep', type: 'other', x: 0, y: 0, flightId: 'flight-a' },
    )
    expect(execute(clearGraph(), battle, { flightId: 'flight-a' })).toEqual({ value: true })
    expect(battle.extensions.tileEffects).toEqual([
      { id: 'flight-b', type: 'reservation', x: 2, y: 2, flightId: 'flight-b' },
      { id: 'keep', type: 'other', x: 0, y: 0, flightId: 'flight-a' },
    ])
  })

  it('keeps legacy clear behavior when the tile-effect extension is absent', () => {
    const battle = makeState({ width: 5, height: 5 }) as any
    delete battle.extensions
    expect(execute(clearGraph(), battle, { flightId: 'flight-a' })).toEqual({ value: true })
    expect(battle.extensions).toBeUndefined()
  })

  it('uses generic teleport and invalidates a missing piece without mutating state', () => {
    const piece = makePiece({ instanceId: 'piece-a', x: 0, y: 0 })
    const battle = makeState({ pieces: [piece], width: 4, height: 4 }) as any
    expect(execute(teleportGraph(), battle, { piece: 'piece-a', cell: { x: 2, y: 2 } })).toEqual({ value: true })
    expect(battle.pieces[0]).toMatchObject({ x: 2, y: 2 })
    const before = structuredClone(battle)
    expect(execute(teleportGraph(), battle, { piece: 'missing', cell: { x: 1, y: 1 } })).toBeUndefined()
    expect(battle).toEqual(before)
  })

  it('removes duplicate flight statuses by exact handle and preserves other statuses', () => {
    const holder = makePiece({ instanceId: 'holder', rules: [{ id: 'flight-rule' }], statusTags: [
      { id: 'a', type: 'flight', flightId: 'flight-a', relatedRules: ['flight-rule'] },
      { type: 'flight', flightId: 'flight-a' },
      { id: 'b', type: 'other', flightId: 'flight-b' },
      { id: 'c', type: 'flight', flightId: 'flight-a' },
      { id: 'd', type: 'flight', flightId: 'flight-a' },
    ] })
    const battle = makeState({ pieces: [holder] }) as any
    expect(execute(removeGraph(), battle, { piece: 'holder', flightId: 'flight-a' })).toEqual({ value: true })
    expect(battle.pieces[0].statusTags.map(({ instanceId, ...tag }: any) => tag)).toEqual([
      { type: 'flight', flightId: 'flight-a' },
      { id: 'b', type: 'other', flightId: 'flight-b' },
    ])
    expect(battle.pieces[0].rules).toEqual([])
    expect(execute(removeGraph(), battle, { piece: 'holder', flightId: 'missing' })).toEqual({ value: true })
  })

  it('moves counter subtraction/fallback into the graph and refreshes first matching temporary status', () => {
    const holder = makePiece({ instanceId: 'holder', statusTags: [
      { id: 'counter', type: 'counter', remainingTurns: 2 },
      { id: 'temporary-a', type: 'temporary', name: 'old-a', visible: false, grantedTurnNumber: 1, currentDuration: 7, currentUses: 8, remainingUses: 8, createdTurnNumber: 1 },
      { id: 'temporary-b', type: 'temporary', name: 'old-b', visible: true, grantedTurnNumber: 2, currentDuration: 9, currentUses: 9, remainingUses: 9, createdTurnNumber: 2 },
    ] })
    const battle = makeState({ pieces: [holder] }) as any
    expect(execute(consumeGraph(), battle, { piece: 'holder', statusId: 'counter' })).toEqual({ value: 1 })
    expect(battle.pieces[0].statusTags[0]).toMatchObject({ id: 'counter', remainingTurns: 1 })
    expect(execute(consumeGraph(), battle, { piece: 'holder', statusId: 'missing' })).toEqual({ value: 1 })
    expect(execute(refreshGraph(), battle, { piece: 'holder', turn: 5 })).toEqual({ value: true })
    expect(battle.pieces[0].statusTags.map(({ instanceId, ...tag }: any) => tag)).toEqual([
      { id: 'counter', type: 'counter', remainingTurns: 1 },
      { id: 'temporary-a', type: 'temporary', name: 'old-a', visible: false, grantedTurnNumber: 5, currentDuration: 3, currentUses: 2, remainingUses: 2, createdTurnNumber: 5 },
      { id: 'temporary-b', type: 'temporary', name: 'old-b', visible: true, grantedTurnNumber: 2, currentDuration: 9, currentUses: 9, remainingUses: 9, createdTurnNumber: 2 },
    ])

    const empty = makePiece({ instanceId: 'empty' })
    battle.pieces.push(empty)
    expect(execute(refreshGraph(), battle, { piece: 'empty', turn: 7 })).toEqual({ value: true })
    expect(battle.pieces.find((item: any) => item.instanceId === 'empty')?.statusTags).toEqual([{
      id: 'temporary-empty', type: 'temporary', name: 'temporary', visible: true,
      grantedTurnNumber: 7, currentDuration: 3, currentUses: 2, remainingUses: 2, createdTurnNumber: 7,
    }])
  })
})
