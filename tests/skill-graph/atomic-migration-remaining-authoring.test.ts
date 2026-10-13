import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  migrateRemainingAuthoringModules,
} from '../../lib/skill-graph/atomic-migration-remaining-authoring'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createExecutionLocalRuntime } from '../../lib/game/execution-local-runtime'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayLiteral,
  type GameplayCompositeDefinition,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import {
  buildHidanUndyingSkillGraph,
  buildRafaamSampleCardGraph,
  buildReapSkillGraph,
  buildRuleReapGraph,
} from '../../scripts/migrate-semantic-modules'

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, string | number | boolean | null> = {}): GameplayStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

const flightComposite: GameplayCompositeDefinition = {
  id: 'shared.flight-move-one', version: '1',
  inputs: [{ name: 'piece', type: { kind: 'nullable', value: 'piece' } }],
  outputs: [{ name: 'moved', type: 'boolean' }],
  body: [{
    kind: 'if', id: 'guard', condition: literal(true),
    then: [{ kind: 'return', id: 'moved', values: { moved: literal(true) } }],
    else: [{ kind: 'return', id: 'not-moved', values: { moved: literal(false) } }],
  }],
}

const resultComposite: GameplayCompositeDefinition = {
  id: 'shared.result-message', version: '1',
  inputs: [{ name: 'message', type: 'string' }],
  outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
  body: [
    call('message', 'result.message', { message: input('message') }),
    { kind: 'return', id: 'done', values: { success: output('message', 'success'), message: output('message', 'message') } },
  ],
}

const earlyReturnComposite: GameplayCompositeDefinition = {
  id: 'shared.half-damage', version: '1',
  inputs: [{ name: 'damage', type: 'number' }],
  outputs: [{ name: 'amount', type: 'number' }],
  body: [
    {
      kind: 'if', id: 'early', condition: literal(true),
      then: [{ kind: 'return', id: 'one', values: { amount: literal(1) } }],
    },
    { kind: 'return', id: 'fallback', values: { amount: literal(2) } },
  ],
}

const tailBranchComposite: GameplayCompositeDefinition = {
  id: 'shared.flight-move-one', version: '1',
  inputs: [{ name: 'flag', type: 'boolean' }],
  outputs: [{ name: 'moved', type: 'boolean' }],
  body: [{
    kind: 'if', id: 'guard', condition: { kind: 'input', name: 'flag' },
    then: [{ kind: 'return', id: 'moved', values: { moved: literal(true) } }],
    else: [{ kind: 'return', id: 'not-moved', values: { moved: literal(false) } }],
  }],
}

const loopReturnComposite: GameplayCompositeDefinition = {
  id: 'shared.half-damage', version: '1',
  inputs: [{ name: 'damage', type: 'number' }],
  outputs: [{ name: 'amount', type: 'number' }],
  body: [
    {
      kind: 'foreach', id: 'loop', items: literal([1]), item: 'item',
      body: [{ kind: 'return', id: 'loop-return', values: { amount: literal(1) } }],
    },
    { kind: 'return', id: 'fallback', values: { amount: literal(2) } },
  ],
}

function graph(composite: GameplayCompositeDefinition, body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    inputs: [],
    outputs,
    body,
    composites: [composite],
  }
}

function executeGraph(graphValue: GameplayModuleGraph, flow: unknown, context: unknown): { result: unknown; context: unknown } {
  const compiled = compileGameplayModuleGraph(graphValue, GAMEPLAY_MODULE_REGISTRY)
  const source = graphValue.surface === 'rule'
    ? `return (function() { ${compiled.code} })()`
    : `return (${compiled.code})(context)`
  const run = new Function('flow', 'context', source) as (flow: unknown, context: unknown) => unknown
  return { result: run(flow, context), context }
}

function resultRuntime(): { flow: unknown; context: Record<string, never> } {
  return { flow: { execution: createExecutionLocalRuntime() }, context: {} }
}

function reapRuntime(damage: number, sameHolder: boolean): { flow: unknown; context: { healQueue: unknown[]; ruleId: string } } {
  const piece = { instanceId: 'reap-piece', name: '收割者', currentHp: 10 }
  const other = { instanceId: 'other-piece', name: '其他棋子', currentHp: 10 }
  const sourceId = piece.instanceId
  const holderId = sameHolder ? piece.instanceId : other.instanceId
  const pieces = new Map([[piece.instanceId, piece], [other.instanceId, other]])
  const context = { healQueue: [] as unknown[], ruleId: 'reap' }
  const flow = {
    execution: createExecutionLocalRuntime(),
    refs: { source: () => sourceId, holder: () => holderId },
    query: {
      hasPiece: (id: string) => pieces.has(id),
      piece: (id: string) => {
        const value = pieces.get(id)
        if (!value) throw new Error(`missing piece: ${id}`)
        return value
      },
    },
    event: { read: () => ({ damage }) },
  }
  return { flow, context }
}

function collectStatementIds(statements: readonly GameplayStatement[], result: string[] = []): string[] {
  for (const statement of statements) {
    result.push(statement.id)
    if (statement.kind === 'if') {
      collectStatementIds(statement.then, result)
      collectStatementIds(statement.else ?? [], result)
    } else if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') {
      collectStatementIds(statement.body, result)
    } else if (statement.kind === 'while') {
      collectStatementIds(statement.condition.body, result)
      collectStatementIds(statement.body, result)
    }
  }
  return result
}

describe('remaining authoring migrations', () => {
  it('captures composite branch returns in generic local/record statements', () => {
    const source = graph(flightComposite, [
      call('move', 'shared.flight-move-one', { piece: literal(null) }),
      { kind: 'return', id: 'done', values: { moved: output('move', 'moved') } },
    ], [{ name: 'moved', type: 'boolean' }])
    const migrated = migrateRemainingAuthoringModules(source)
    const serialized = JSON.stringify(migrated)
    expect(serialized).not.toContain('shared.flight-move-one')
    expect(migrated.composites).toEqual([])
    expect(migrated.schemas?.map(schema => schema.id)).toEqual(['atomic-inline-move'])
    expect(migrated.body.map(statement => statement.kind)).toEqual(['call', 'if', 'call', 'record.get', 'return'])

    const compiled = compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY)
    const run = new Function('flow', 'context', `return (${compiled.code})(context)`) as (flow: unknown, context: unknown) => unknown
    expect(run({ execution: createExecutionLocalRuntime() }, { piece: null })).toEqual({ moved: true })
    expect(migrateRemainingAuthoringModules(migrated)).toEqual(migrated)
  })

  it('keeps both tail branches, caller effects, and colliding local IDs independent', () => {
    const sourceFor = (flag: boolean) => graph(tailBranchComposite, [
      call('tail', 'shared.flight-move-one', { flag: literal(flag) }),
      // These IDs intentionally collide with names the inliner would choose
      // for the composite guard and result handle.
      call('tail--guard', 'local.declare', {}, { valueType: 'boolean' }),
      call('tail--result-handle', 'local.declare', {}, { valueType: 'boolean' }),
      call('tail--result-write', 'local.write', {
        handle: output('tail--result-handle', 'handle'),
        value: literal(true),
      }, { valueType: 'boolean' }),
      call('tail--result-read', 'local.read', {
        handle: output('tail--result-handle', 'handle'),
      }, { valueType: 'boolean' }),
      {
        kind: 'return', id: 'done', values: {
          moved: output('tail', 'moved'),
          after: output('tail--result-read', 'value'),
        },
      },
    ], [{ name: 'moved', type: 'boolean' }, { name: 'after', type: 'boolean' }])

    for (const flag of [true, false]) {
      const source = sourceFor(flag)
      const before = JSON.stringify(source)
      const migrated = migrateRemainingAuthoringModules(source)
      expect(JSON.stringify(source)).toBe(before)
      expect(migrated.composites).toEqual([])
      const ids = collectStatementIds(migrated.body)
      expect(new Set(ids).size).toBe(ids.length)

      const executed = executeGraph(migrated, { execution: createExecutionLocalRuntime() }, {})
      expect(executed.result).toEqual({ moved: flag, after: true })
    }
  })

  it('preserves a generic result-message call and exact text output', () => {
    const source = graph(resultComposite, [
      call('result', 'shared.result-message', { message: literal('') }),
      { kind: 'return', id: 'done', values: { success: output('result', 'success'), message: output('result', 'message') } },
    ], [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }])
    const migrated = migrateRemainingAuthoringModules(source)
    expect(JSON.stringify(migrated)).not.toContain('shared.result-message')
    expect(migrated.body.some(statement => statement.kind === 'call' && statement.module === 'result.message')).toBe(true)
    const compiled = compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY)
    const run = new Function('flow', 'context', `return (${compiled.code})(context)`) as (flow: unknown, context: unknown) => unknown
    expect(run({ execution: createExecutionLocalRuntime() }, {})).toEqual({ success: true, message: '' })
  })

  it('rejects an early composite return instead of leaking into the caller', () => {
    const source = graph(earlyReturnComposite, [
      call('half', 'shared.half-damage', { damage: literal(7) }),
      call('plus', 'math.add', { left: output('half', 'amount'), right: literal(10) }),
      { kind: 'return', id: 'done', values: { amount: output('plus', 'value') } },
    ], [{ name: 'amount', type: 'number' }])
    const before = JSON.stringify(source)
    expect(() => migrateRemainingAuthoringModules(source)).toThrow(/return must terminate its branch/)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('rejects a composite return inside a loop without mutating the input graph', () => {
    const source = graph(loopReturnComposite, [
      call('half', 'shared.half-damage', { damage: literal(7) }),
      { kind: 'return', id: 'done', values: { amount: output('half', 'amount') } },
    ], [{ name: 'amount', type: 'number' }])
    const before = JSON.stringify(source)
    expect(() => migrateRemainingAuthoringModules(source)).toThrow(/return must terminate its branch/)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('maps momentum writes to the generic canonical field writer and readback', () => {
    const source: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      inputs: [{ name: 'piece', type: 'piece' }, { name: 'value', type: 'number' }],
      outputs: [{ name: 'value', type: 'number' }],
      body: [
        call('set', 'attribute.set-momentum', { piece: input('piece'), value: input('value') }),
        { kind: 'return', id: 'done', values: { value: output('set', 'value') } },
      ],
    }
    const migrated = migrateRemainingAuthoringModules(source)
    const calls = migrated.body.filter((statement): statement is Extract<GameplayStatement, { kind: 'call' }> => statement.kind === 'call')
    expect(calls.map(statement => statement.module)).toEqual(['piece.write-field', 'piece.field'])
    expect(calls[0].parameters).toEqual({ field: 'momentum', valueType: 'number' })
    expect(migrated.body.at(-1)).toMatchObject({ values: { value: output('set--read-momentum', 'value') } })
    expect(migrateRemainingAuthoringModules(migrated)).toEqual(migrated)
  })

  it('keeps momentum numeric behavior while delegating writes to the host boundary', () => {
    const sourceFor = (value: number, pieceId = 'piece-1'): GameplayModuleGraph => ({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      inputs: [],
      outputs: [{ name: 'value', type: 'number' }],
      body: [
        call('holder', pieceId === 'piece-1' ? 'ref.holder' : 'ref.target'),
        call('set', 'attribute.set-momentum', {
          piece: output('holder', 'piece'),
          value: literal(value),
        }),
        call('read', 'piece.field', { piece: output('holder', 'piece') }, { field: 'momentum' }),
        { kind: 'return', id: 'done', values: { value: output('read', 'value') } },
      ],
    })
    const execute = (source: GameplayModuleGraph, piece: { instanceId: string; momentum: number }, holderId = piece.instanceId) => {
      const compiled = compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY)
      const setMomentum = (id: string, value: number) => {
        const target = id === piece.instanceId ? piece : undefined
        if (!target) throw new Error('missing piece: ' + String(id))
        if (!Number.isFinite(value)) throw new Error('invalid momentum')
        target.momentum = value
        return value
      }
      const flow = {
        execution: createExecutionLocalRuntime(),
        query: {
          piece: (id: string) => {
            if (id !== piece.instanceId) throw new Error('missing piece')
            return piece
          },
        },
        refs: { holder: () => holderId, target: () => holderId },
        attributes: { setMomentum },
      }
      const run = new Function('flow', 'context', `return (${compiled.code})(context)`) as (flow: unknown, context: unknown) => unknown
      return run(flow, {})
    }

    for (const value of [-2, 1.25, 0]) {
      const oldPiece = { instanceId: 'piece-1', momentum: 0 }
      const migratedPiece = { instanceId: 'piece-1', momentum: 0 }
      execute(sourceFor(value), oldPiece)
      execute(migrateRemainingAuthoringModules(sourceFor(value)), migratedPiece)
      expect(migratedPiece.momentum).toBe(oldPiece.momentum)
      expect(migratedPiece.momentum).toBe(value)
    }

    const missingPiece = { instanceId: 'piece-1', momentum: 3 }
    expect(() => execute(migrateRemainingAuthoringModules(sourceFor(-4, 'missing')), missingPiece, 'missing')).toThrow(/missing piece/)
    expect(missingPiece.momentum).toBe(3)
  })

  it('executes four real factory graphs before and after migration with identical behavior', () => {
    const factories = [
      { name: 'Reap triggerSkill', build: buildReapSkillGraph, runtime: resultRuntime },
      { name: 'Hidan Undying triggerSkill', build: buildHidanUndyingSkillGraph, runtime: resultRuntime },
      { name: 'Rafaam sample card', build: buildRafaamSampleCardGraph, runtime: resultRuntime },
      { name: 'Reap rule', build: () => buildRuleReapGraph(), runtime: () => reapRuntime(5, true) },
    ] as const

    for (const sample of factories) {
      const legacy = sample.build()
      const before = JSON.stringify(legacy)
      expect(legacy.composites?.some(composite => composite.id.startsWith('shared.'))).toBe(true)
      const migrated = migrateRemainingAuthoringModules(legacy)
      expect(JSON.stringify(legacy)).toBe(before)
      expect(JSON.stringify(migrated)).not.toMatch(/shared\.(flight-move-one|half-damage|result-message|status-event-guard)/)

      const legacyRuntime = sample.runtime()
      const migratedRuntime = sample.runtime()
      const legacyExecution = executeGraph(legacy, legacyRuntime.flow, legacyRuntime.context)
      const migratedExecution = executeGraph(migrated, migratedRuntime.flow, migratedRuntime.context)
      expect(migratedExecution).toEqual(legacyExecution)
    }

    for (const scenario of [
      { damage: 0, sameHolder: true },
      { damage: 5, sameHolder: false },
    ]) {
      const legacy = buildRuleReapGraph()
      const migrated = migrateRemainingAuthoringModules(buildRuleReapGraph())
      const legacyRuntime = reapRuntime(scenario.damage, scenario.sameHolder)
      const migratedRuntime = reapRuntime(scenario.damage, scenario.sameHolder)
      expect(executeGraph(migrated, migratedRuntime.flow, migratedRuntime.context)).toEqual(
        executeGraph(legacy, legacyRuntime.flow, legacyRuntime.context),
      )
    }
  })

  it('migrates and compiles the active shared composite documents', () => {
    const files = [
      'data/rules/rule-chidori-immobile.json',
      'data/rules/rule-naruto-sage-block-skill.json',
      'data/rules/rule-naruto-sage-immobile.json',
      'data/rules/rule-silenced-block.json',
      'data/rules/rule-tails-flight-immune-target.json',
      'data/rules/rule-tails-flight-immune.json',
      'data/rules/rule-tails-flight-inoperable-skill.json',
      'data/rules/rule-tails-flight-inoperable.json',
      'data/rules/rule-venom-corrosion-immobile.json',
      'data/rules/rule-reap.json',
      'data/rules/rule-tails-flight-resolve.json',
      'data/skills/hidan-undying.json',
      'data/skills/reap.json',
      'data/skills/shadow-ride-sweep.json',
      'data/skills/sonic-spin-dash.json',
      'data/cards/lucky-coin.json',
      'data/rules/rule-momentum-gain.json',
      'data/rules/rule-momentum-consume.json',
    ]
    for (const relative of files) {
      const document = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8')) as {
        gameplayModules: { entries: Record<string, { graph: GameplayModuleGraph }> }
      }
      for (const entry of Object.values(document.gameplayModules.entries)) {
        // These documents are checked after the one-time data migration.  A
        // graph-local pass over them must therefore be stable and leave no
        // target composite call or definition behind.
        const migrated = migrateRemainingAuthoringModules(entry.graph)
        expect(JSON.stringify(migrated)).not.toMatch(/shared\.(flight-move-one|half-damage|result-message|status-event-guard)/)
        expect(() => compileGameplayModuleGraph(migrated, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
      }
    }
  })
})
