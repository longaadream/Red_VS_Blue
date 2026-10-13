import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '../../lib/game/gameplay-module-diagnostics'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  ATOMIC_PLAYER_BUFF_MODULES,
  LEGACY_PLAYER_BUFF_NAMESPACE,
  migratePlayerBuffExtensionModules,
} from '../../lib/skill-graph/atomic-migration-player-buff-extension'
import { migrateFollowupCompositionModules } from '../../lib/skill-graph/atomic-migration-followup-compositions'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import { makeState } from '../helpers/minimal-state'

type LegacyBuffPlayer = ReturnType<typeof makeState>['players'][number] & {
  buffs?: Record<string, { uses: number; multiplier: number }>
}

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: unknown): GameplayValue => ({ kind: 'literal', value: value as never })
const buffSchema = {
  id: 'test-player-buff', version: '1', fields: [
    { name: 'uses', type: 'number' as const },
    { name: 'multiplier', type: 'number' as const },
  ],
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, unknown>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters: parameters as GameplayCallStatement['parameters'] }
}

function callsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  const visit = (statements: readonly GameplayStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'call') result.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        if (statement.else) visit(statement.else)
      } else if ('body' in statement && Array.isArray(statement.body)) visit(statement.body)
    }
  }
  visit(body)
  return result
}

function graph(body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs'] = [], surface: GameplayModuleGraph['surface'] = 'skill'): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface, body, outputs, schemas: [buffSchema] }
}

function executeGraph(source: GameplayModuleGraph, state: ReturnType<typeof makeState>): { value: unknown; flow: ReturnType<typeof createFlowRuntime> } {
  const runtimeSurface = source.surface === 'preview' ? 'skill' : source.surface
  const flow = createFlowRuntime(state, { playerId: 'player-red' }, runtimeSurface, {})
  const compiled = compileGameplayModuleGraph(migratePlayerBuffExtensionModules(source), GAMEPLAY_MODULE_REGISTRY)
  const execute = new Function('flow', 'return (' + compiled.code + ')')(flow) as (context: unknown) => unknown
  return { flow, value: execute({ playerId: 'player-red' }) }
}

function runGraph(source: GameplayModuleGraph): { state: ReturnType<typeof makeState>; value: unknown; flow: ReturnType<typeof createFlowRuntime> } {
  const state = makeState()
  const result = executeGraph(source, state)
  return { state, ...result }
}

function playerReference(): GameplayStatement[] {
  return [
    call('player-ref', 'ref.player'),
    call('player', 'query.player', { playerId: output('player-ref', 'player') }),
  ]
}

const player = output('player', 'player')

describe('atomic player buff extension migration', () => {
  it('replaces every legacy buff module with generic extension operations', () => {
    const source = graph([
      ...playerReference(),
      { kind: 'record.create', id: 'buff', schema: buffSchema.id, fields: { uses: literal(2), multiplier: literal(3) } },
      call('set', 'player.set-buff-record', { player, record: output('buff') }, { buffId: 'holy' }),
      call('read', 'player.buff-record', { player }, { buffId: 'holy' }),
      call('write', 'player.write-buff-uses', { player, uses: literal(1) }, { buffId: 'holy' }),
      call('consume', 'player.consume-buff', { player }, { buffId: 'holy' }),
    ])

    const migrated = migratePlayerBuffExtensionModules(source)
    expect(callsIn(migrated.body).map(statement => statement.module)).not.toEqual(
      expect.arrayContaining([...ATOMIC_PLAYER_BUFF_MODULES]),
    )
    expect(callsIn(migrated.body).map(statement => statement.module)).toEqual(
      expect.arrayContaining(['extension.declare-player', 'extension.read-optional-player', 'extension.write-player']),
    )
    expect(JSON.stringify(migrated)).toContain(LEGACY_PLAYER_BUFF_NAMESPACE)
    expect(() => compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
  })

  it('uses an execution-local default without materializing player.buffs or flowState', () => {
    const result = runGraph(graph([
      ...playerReference(),
      call('read', 'player.buff-record', { player }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: { record: output('read', 'record') } },
    ], [{ name: 'record', type: 'record' }]))

    expect(result.value).toEqual({ record: null })
    expect((result.state.players[0] as LegacyBuffPlayer).buffs).toBeUndefined()
    expect(result.state.extensions?.flowState).toBeUndefined()
  })

  it('keeps a missing pure read optional inside collection.map', () => {
    const source = graph([
      { kind: 'call', id: 'players', module: 'query.players', version: '1', inputs: {}, parameters: {} },
      {
        kind: 'collection', id: 'records', method: 'map', items: output('players', 'players'), item: 'owner', body: [
          call('read', 'player.buff-record', { player: { kind: 'input', name: 'owner' } }, { buffId: 'missing' }),
          { kind: 'return', id: 'record-result', value: output('read', 'record') },
        ],
      },
      { kind: 'return', id: 'done', values: { records: output('records', 'value') } },
    ], [{ name: 'records', type: { kind: 'list', element: { kind: 'nullable', value: 'record' } } }])
    const migrated = migratePlayerBuffExtensionModules(source)
    const migratedCalls = callsIn(migrated.body)
    expect(migratedCalls.map(statement => statement.module)).toContain('extension.read-optional-player')
    expect(migratedCalls.map(statement => statement.module)).not.toContain('extension.declare-player')
    expect(() => compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
    const result = runGraph(migrated)
    expect(result.value).toEqual({ records: [null, null] })
    expect((result.state.players[0] as LegacyBuffPlayer).buffs).toBeUndefined()
    expect((result.state.players[1] as LegacyBuffPlayer).buffs).toBeUndefined()
  })

  it('keeps a missing consume default local before a later nullable read', () => {
    const source = graph([
      ...playerReference(),
      call('consume', 'player.consume-buff', { player }, { buffId: 'holy' }),
      call('read', 'player.buff-record', { player }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: {
        applied: output('consume', 'applied'),
        multiplier: output('consume', 'multiplier'),
        record: output('read', 'record'),
      } },
    ], [
      { name: 'applied', type: 'boolean' },
      { name: 'multiplier', type: 'number' },
      { name: 'record', type: { kind: 'nullable', value: 'record' } },
    ])
    const migrated = migratePlayerBuffExtensionModules(source)
    const modules = callsIn(migrated.body).map(statement => statement.module)
    expect(modules).toContain('extension.read-optional-player')
    expect(modules).not.toContain('extension.declare-player')

    // Compile and execute the same migrated graph through the real flow host:
    // the consume fallback must not become a shared declaration visible to the
    // following pure player.buff-record read.
    const result = runGraph(source)
    expect(result.value).toEqual({ applied: false, multiplier: 1, record: null })
    expect((result.state.players[0] as LegacyBuffPlayer).buffs).toBeUndefined()
    expect(result.state.extensions?.flowState).toBeUndefined()
  })

  it('writes the legacy record once and consumes it through the same generic path', () => {
    const result = runGraph(graph([
      ...playerReference(),
      { kind: 'record.create', id: 'buff', schema: buffSchema.id, fields: { uses: literal(2), multiplier: literal(3) } },
      call('set', 'player.set-buff-record', { player, record: output('buff') }, { buffId: 'holy' }),
      call('consume', 'player.consume-buff', { player }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: { applied: output('consume', 'applied'), multiplier: output('consume', 'multiplier') } },
    ], [{ name: 'applied', type: 'boolean' }, { name: 'multiplier', type: 'number' }]))

    expect(result.value).toEqual({ applied: true, multiplier: 3 })
    expect((result.state.players[0] as LegacyBuffPlayer).buffs).toEqual({ holy: { uses: 1, multiplier: 3 } })
    expect(result.state.extensions?.flowState).toBeUndefined()
  })

  it('rejects exhausted or non-integer use updates without changing the old record', () => {
    const exhausted = runGraph(graph([
      ...playerReference(),
      { kind: 'record.create', id: 'buff', schema: buffSchema.id, fields: { uses: literal(0), multiplier: literal(2) } },
      call('set', 'player.set-buff-record', { player, record: output('buff') }, { buffId: 'holy' }),
      call('consume', 'player.consume-buff', { player }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: { applied: output('consume', 'applied'), multiplier: output('consume', 'multiplier') } },
    ], [{ name: 'applied', type: 'boolean' }, { name: 'multiplier', type: 'number' }]))
    expect(exhausted.value).toEqual({ applied: false, multiplier: 1 })
    expect((exhausted.state.players[0] as LegacyBuffPlayer).buffs).toEqual({ holy: { uses: 0, multiplier: 2 } })

    const fractional = runGraph(graph([
      ...playerReference(),
      { kind: 'record.create', id: 'buff', schema: buffSchema.id, fields: { uses: literal(2), multiplier: literal(2) } },
      call('set', 'player.set-buff-record', { player, record: output('buff') }, { buffId: 'holy' }),
      call('write', 'player.write-buff-uses', { player, uses: literal(0.5) }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ], [{ name: 'success', type: 'boolean' }]))
    expect(fractional.value).toEqual({ success: false })
    expect((fractional.state.players[0] as LegacyBuffPlayer).buffs).toEqual({ holy: { uses: 2, multiplier: 2 } })
  })

  it('rejects prototype buff names before touching the legacy container', () => {
    const state = makeState()
    const flow = createFlowRuntime(state, { playerId: 'player-red' }, 'skill', {})
    expect(() => flow.extension.declareValue(
      'player', 'player-red', LEGACY_PLAYER_BUFF_NAMESPACE, '__proto__', 'record', [], {},
    )).toThrow('无效标识符')
    expect((state.players[0] as LegacyBuffPlayer).buffs).toBeUndefined()
    expect(state.extensions?.flowState).toBeUndefined()
  })

  it('rejects an unsafe legacy uses write at the host boundary without changing state', () => {
    const state = makeState()
    ;(state.players[0] as LegacyBuffPlayer).buffs = { holy: { uses: 2, multiplier: 3 } }
    const flow = createFlowRuntime(state, { playerId: 'player-red' }, 'skill', {})
    const before = JSON.parse(JSON.stringify((state.players[0] as LegacyBuffPlayer).buffs))
    const rejected = flow.extension.writeValue(
      'player', 'player-red', LEGACY_PLAYER_BUFF_NAMESPACE, 'holy', '', 'record', [], { uses: 1.5, multiplier: 3 },
    )
    expect(rejected).toBeNull()
    expect((state.players[0] as LegacyBuffPlayer).buffs).toEqual(before)
  })

  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1])('does not expose a rejected new buff with uses %s to later reads', (uses) => {
    const state = makeState()
    const flow = createFlowRuntime(state, { playerId: 'player-red' }, 'skill', {})
    expect(() => flow.extension.declareValue(
      'player', 'player-red', LEGACY_PLAYER_BUFF_NAMESPACE, 'holy', 'record', [], { uses, multiplier: 3 },
    )).toThrow()
    expect(flow.extension.readValueOrNull(
      'player', 'player-red', LEGACY_PLAYER_BUFF_NAMESPACE, 'holy', '', 'record', [],
    )).toBeNull()
    expect((state.players[0] as LegacyBuffPlayer).buffs).toBeUndefined()
    expect(state.extensions?.flowState).toBeUndefined()

    // A rejected declaration must not reserve the name or poison later work.
    expect(flow.extension.declareValue(
      'player', 'player-red', LEGACY_PLAYER_BUFF_NAMESPACE, 'holy', 'record', [], { uses: 2, multiplier: 4 },
    )).toEqual({ uses: 2, multiplier: 4 })
    expect(flow.extension.readValueOrNull(
      'player', 'player-red', LEGACY_PLAYER_BUFF_NAMESPACE, 'holy', '', 'record', [],
    )).toEqual({ uses: 2, multiplier: 4 })
  })

  it('skips an invalid buff statement and continues with an independent read', () => {
    const source = graph([
      ...playerReference(),
      { kind: 'record.create', id: 'buff', schema: buffSchema.id, fields: { uses: literal(1.5), multiplier: literal(3) } },
      call('set', 'player.set-buff-record', { player, record: output('buff') }, { buffId: 'holy' }),
      call('read', 'player.buff-record', { player }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: { record: output('read', 'record') } },
    ], [{ name: 'record', type: { kind: 'nullable', value: 'record' } }])
    const state = makeState()
    const context = { playerId: 'player-red' }
    const diagnostics = createGameplayModuleDiagnosticHost('skill', {}, () => undefined)
    installGameplayModuleDiagnosticHost(context, diagnostics)
    const flow = createFlowRuntime(state, context, 'skill', {})
    const compiled = compileGameplayModuleGraph(migratePlayerBuffExtensionModules(source), GAMEPLAY_MODULE_REGISTRY)
    const execute = new Function('flow', 'return (' + compiled.code + ')')(flow) as (context: unknown) => unknown
    expect(execute(context)).toEqual({ record: null })
    expect(diagnostics.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ moduleId: 'extension.declare-player', message: expect.stringContaining('非负安全整数') }),
    ]))
    expect((state.players[0] as LegacyBuffPlayer).buffs).toBeUndefined()
    expect(state.extensions?.flowState).toBeUndefined()
  })

  it('does not report a successful declaration when the host rejects an existing legacy value', () => {
    const state = makeState()
    const flow = createFlowRuntime(state, { playerId: 'player-red' }, 'skill', {})
    flow.cards.setPlayerBuff('player-red', 'holy', { uses: 1.5, multiplier: 3 })
    expect(() => flow.extension.declareValue(
      'player', 'player-red', LEGACY_PLAYER_BUFF_NAMESPACE, 'holy', 'record', [], { uses: 2, multiplier: 4 },
    )).toThrow('声明被存储拒绝')
    expect((state.players[0] as LegacyBuffPlayer).buffs).toEqual({ holy: { uses: 1.5, multiplier: 3 } })
    expect(state.extensions?.flowState).toBeUndefined()
  })

  it('reads a persisted legacy buff through a fresh flow facade after JSON roundtrip', () => {
    const state = makeState()
    executeGraph(graph([
      ...playerReference(),
      { kind: 'record.create', id: 'buff', schema: buffSchema.id, fields: { uses: literal(2), multiplier: literal(4) } },
      call('set', 'player.set-buff-record', { player, record: output('buff') }, { buffId: 'holy' }),
    ]), state)
    const restored = JSON.parse(JSON.stringify(state)) as ReturnType<typeof makeState>
    const result = executeGraph(graph([
      ...playerReference(),
      call('consume', 'player.consume-buff', { player }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: { applied: output('consume', 'applied'), multiplier: output('consume', 'multiplier') } },
    ], [{ name: 'applied', type: 'boolean' }, { name: 'multiplier', type: 'number' }], 'skill'), restored)

    expect(result.value).toEqual({ applied: true, multiplier: 4 })
    expect((restored.players[0] as LegacyBuffPlayer).buffs).toEqual({ holy: { uses: 1, multiplier: 4 } })
    expect(restored.extensions?.flowState).toBeUndefined()
  })

  it('composes after the follow-up recipe that expands consume-buff into legacy helpers', () => {
    const source = graph([
      ...playerReference(),
      call('consume', 'player.consume-buff', { player }, { buffId: 'holy' }),
      { kind: 'return', id: 'done', values: { applied: output('consume', 'applied'), multiplier: output('consume', 'multiplier') } },
    ], [{ name: 'applied', type: 'boolean' }, { name: 'multiplier', type: 'number' }])
    const followup = migrateFollowupCompositionModules(source)
    const migrated = migratePlayerBuffExtensionModules(followup)
    expect(callsIn(migrated.body).map(statement => statement.module)).not.toEqual(
      expect.arrayContaining([...ATOMIC_PLAYER_BUFF_MODULES]),
    )
    const state = makeState()
    ;(state.players[0] as LegacyBuffPlayer).buffs = { holy: { uses: 2, multiplier: 4 } }
    const result = executeGraph(followup, state)
    expect(result.value).toEqual({ applied: true, multiplier: 4 })
    expect((state.players[0] as LegacyBuffPlayer).buffs).toEqual({ holy: { uses: 1, multiplier: 4 } })
  })
})
