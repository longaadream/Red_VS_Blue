import { describe, expect, it } from 'vitest'

import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { migrateStructuredActionLogModules } from '../../lib/skill-graph/atomic-migration-structured-action-log'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { STRUCTURED_ACTION_LOG_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-followup-structured-log'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayRecordSchema,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import { makeState } from '../helpers/minimal-state'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: unknown): GameplayValue => ({ kind: 'literal', value: value as never })

const payloadSchema: GameplayRecordSchema = {
  id: 'followup-mangekyo-action-payload', version: '1', fields: [
    { name: 'message', type: 'string' },
    { name: 'pieceId', type: 'string' },
    { name: 'pieceTemplateId', type: 'string' },
    { name: 'mangekyoDeathCount', type: 'number' },
  ],
}
const actionSchema: GameplayRecordSchema = {
  id: 'followup-mangekyo-action', version: '1', fields: [
    { name: 'type', type: 'string' },
    { name: 'playerId', type: 'player' },
    { name: 'turn', type: 'number' },
    { name: 'payload', type: { kind: 'record', schema: `${payloadSchema.id}@${payloadSchema.version}` } },
  ],
}

const fixtures: readonly GameplayModuleDescriptor[] = [
  {
    id: 'test.log-player', version: '1', label: 'log player', inputs: [],
    outputs: [{ name: 'player', type: 'player' }], allowedSurfaces: ['rule'],
    effects: { pure: true, previewSafe: true }, lower: () => 'context.player',
  },
  {
    id: 'test.log-turn', version: '1', label: 'log turn', inputs: [],
    outputs: [{ name: 'value', type: 'number' }], allowedSurfaces: ['rule'],
    effects: { pure: true, previewSafe: true }, lower: () => 'context.turn',
  },
]

const structuredLog = STRUCTURED_ACTION_LOG_GAMEPLAY_MODULES[0]
const registry: GameplayModuleRegistry = {
  get: (id, version) => id === structuredLog.id && (version ?? '1') === structuredLog.version
    ? structuredLog
    : fixtures.find(item => item.id === id && item.version === (version ?? '1'))
      ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id, version) => id === structuredLog.id && (version ?? '1') === structuredLog.version
    ? structuredLog
    : fixtures.find(item => item.id === id && item.version === (version ?? '1'))
      ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, structuredLog, ...fixtures],
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, unknown>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters: parameters as GameplayCallStatement['parameters'] }
}

function historicalGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    schemas: [payloadSchema, actionSchema],
    body: [
      call('player', 'test.log-player'),
      call('turn', 'test.log-turn'),
      { kind: 'record.create', id: 'payload', schema: payloadSchema.id, fields: {
        message: literal('天照命中'), pieceId: literal('piece-1'), pieceTemplateId: literal('mangekyo'), mangekyoDeathCount: literal(2),
      } },
      { kind: 'record.create', id: 'action', schema: actionSchema.id, fields: {
        type: literal('mangekyoDeath'), playerId: output('player', 'player'), turn: output('turn'), payload: output('payload'),
      } },
      call('append', 'followup.action.append', { action: output('action') }),
      { kind: 'return', id: 'result', value: output('append', 'success') },
    ],
    outputs: [{ name: 'result', type: 'boolean' }],
  }
}

describe('generic structured follow-up action logging', () => {
  it('expands the historical Mangekyo action record into typed fields and payload', () => {
    const migrated = migrateStructuredActionLogModules(historicalGraph())
    const calls = migrated.body.filter((statement): statement is GameplayCallStatement => statement.kind === 'call')
    expect(calls.find(statement => statement.id === 'append')).toMatchObject({
      module: 'followup.action.append',
      version: '2',
      inputs: { type: output('append--action-type'), playerId: output('append--action-player'), turn: output('append--action-turn'), payload: output('append--action-payload') },
      parameters: { payloadSchema: payloadSchema.id },
    })
    expect(JSON.stringify(migrated)).not.toContain('"action":{"kind":"output"')
    expect(migrated.body.filter(statement => statement.kind === 'record.get')).toHaveLength(4)

    const state = makeState()
    const flow = createFlowRuntime(state, {}, 'rule', {})
    const code = compileGameplayModuleGraph(migrated, registry).code
    const execute = new Function('context', 'flow', code) as (context: unknown, runtime: unknown) => unknown
    expect(execute({ player: 'player-red', turn: 7 }, flow)).toBe(true)
    expect(state.actions?.at(-1)).toEqual({
      type: 'mangekyoDeath', playerId: 'player-red', turn: 7,
      payload: { message: '天照命中', pieceId: 'piece-1', pieceTemplateId: 'mangekyo', mangekyoDeathCount: 2 },
    })
  })

  it('upgrades a previously emitted generic shape to the additive v2 descriptor', () => {
    const source = historicalGraph()
    const graph = { ...source, body: source.body.map(statement => statement.id === 'append'
      ? { ...statement, inputs: { type: output('payload', 'type'), playerId: output('player', 'player'), turn: output('turn'), payload: output('payload') } }
      : statement) }
    const migrated = migrateStructuredActionLogModules(graph)
    const append = migrated.body.find(statement => statement.id === 'append') as GameplayCallStatement
    expect(append).toMatchObject({ module: 'followup.action.append', version: '2', inputs: { type: output('payload', 'type') } })
  })

  it('validates declared payload fields and protects authoritative damage entries', () => {
    const state = makeState()
    const flow = createFlowRuntime(state, {}, 'rule', {})
    const schema = payloadSchema
    const valid = { message: '天照命中', pieceId: 'piece-1', pieceTemplateId: 'mangekyo', mangekyoDeathCount: 2 }
    expect(flow.log.appendStructured({ type: 'mangekyoDeath', playerId: 'player-red', turn: 1, payload: valid }, schema)).toBe(true)
    const before = structuredClone(state.actions)
    expect(() => flow.log.appendStructured({ type: 'damage', playerId: 'player-red', turn: 1, payload: valid }, schema)).toThrow(/受权威动作保护/)
    expect(state.actions).toEqual(before)
    expect(() => flow.log.appendStructured({ type: 'mangekyoDeath', playerId: 'player-red', turn: 1, payload: { ...valid, extra: true } }, schema)).toThrow(/未声明字段/)
    expect(() => flow.log.appendStructured({ type: 'mangekyoDeath', playerId: 'player-red', turn: 1, payload: { ...valid, mangekyoDeathCount: '2' } }, schema)).toThrow(/字段类型错误/)
    expect(() => flow.log.appendStructured({ type: 'mangekyoDeath', playerId: 'player-red', turn: 1, payload: { message: 'x' } }, schema)).toThrow(/缺少字段/)
  })
})
