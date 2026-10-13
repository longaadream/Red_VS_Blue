/* eslint-disable @typescript-eslint/no-explicit-any -- adversarial compiled-script fixtures exercise opaque execution handles and invalid host inputs. */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { createFlowRuntime } from '@/lib/game/flow-runtime'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '@/lib/game/gameplay-module-diagnostics'
import { createSkillCodeFlow, dealDamage } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import {
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  GAMEPLAY_MODULE_REGISTRY,
} from '@/lib/skill-graph/module-document'
import { atomicCapturedEffectRecipe } from '@/lib/skill-graph/atomic-migration-captured-effects'
import { rewriteAtomicGraph } from '@/lib/skill-graph/atomic-graph-rewrite'
import type { GameplayModuleGraph, GameplayValue } from '@/lib/skill-graph/module-types'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: unknown): GameplayValue => ({ kind: 'literal', value: value as never })

function fixture(targetHp = 20) {
  const source = asPieceInstance(makePiece({ instanceId: 'captured-source', ownerPlayerId: 'player-red', currentHp: 20, maxHp: 20 }))
  const target = asPieceInstance(makePiece({ instanceId: 'captured-target', ownerPlayerId: 'player-blue', currentHp: targetHp, maxHp: 20 }))
  return { source, target, state: makeState({ pieces: [source, target] }) as any }
}

function capturedDamageGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    body: [
      { kind: 'call', id: 'source-piece', module: 'ref.source', version: '1' },
      { kind: 'call', id: 'target-piece', module: 'ref.target', version: '1' },
      { kind: 'call', id: 'source', module: 'source.capture', version: '1', inputs: { source: output('source-piece', 'piece') } },
      { kind: 'call', id: 'target', module: 'source.capture', version: '1', inputs: { source: output('target-piece', 'piece') } },
      {
        kind: 'call', id: 'damage', module: 'author.effect.damage', version: '2',
        inputs: { source: output('source', 'source'), target: output('target', 'source'), amount: literal(2) },
        parameters: {
          sourceType: 'record', targetType: 'record', amountType: 'number', resultType: 'record',
          damageType: 'true', attribution: 'current', skillId: 'captured-author-damage',
        },
      },
      { kind: 'return', id: 'return', value: output('damage', 'result') },
    ],
    outputs: [{ name: 'result', type: 'record' }],
  }
}

function oldQueueGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    body: [
      { kind: 'call', id: 'source-ref', module: 'ref.source', version: '1' },
      { kind: 'call', id: 'target-ref', module: 'ref.target', version: '1' },
      { kind: 'call', id: 'source', module: 'source.capture', version: '1', inputs: { source: output('source-ref', 'piece') } },
      { kind: 'call', id: 'target', module: 'source.capture', version: '1', inputs: { source: output('target-ref', 'piece') } },
      {
        kind: 'call', id: 'queue', module: 'effect.queue-damage-captured', version: '1',
        inputs: { source: output('source', 'source'), target: output('target', 'source'), amount: literal(2) },
        parameters: { damageType: 'true', skillId: 'legacy-queue' },
      },
      { kind: 'return', id: 'return', value: output('queue', 'success') },
    ],
    outputs: [{ name: 'success', type: 'boolean' }],
  }
}

function oldRemoveGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    body: [
      { kind: 'call', id: 'source-ref', module: 'ref.source', version: '1' },
      { kind: 'call', id: 'source', module: 'source.capture', version: '1', inputs: { source: output('source-ref', 'piece') } },
      { kind: 'call', id: 'remove', module: 'rule.remove-captured', version: '1', inputs: { source: output('source', 'source') }, parameters: { ruleId: 'legacy-rule' } },
      { kind: 'return', id: 'return', value: output('remove', 'success') },
    ],
    outputs: [{ name: 'success', type: 'boolean' }],
  }
}

function oldEventCaptureRemoveGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    body: [
      { kind: 'call', id: 'source', module: 'source.capture-event-piece', version: '1', parameters: { field: 'sourcePiece' } },
      { kind: 'call', id: 'remove', module: 'rule.remove-captured', version: '1', inputs: { source: output('source', 'source') }, parameters: { ruleId: 'legacy-rule' } },
      { kind: 'return', id: 'return', value: output('remove', 'success') },
    ],
    outputs: [{ name: 'success', type: 'boolean' }],
  }
}

function forgedRemoveWithTailGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    schemas: [{ id: 'forged-handle', version: '1', fields: [{ name: 'scope', type: 'string' }, { name: 'id', type: 'string' }] }],
    body: [
      { kind: 'record.create', id: 'forged', schema: 'forged-handle@1', fields: { scope: literal('execution-source'), id: literal('forged') } },
      { kind: 'call', id: 'remove', module: 'rule.remove-id-raw', version: '2', inputs: { target: output('forged', 'value') }, parameters: { targetType: 'record', ruleId: 'legacy-rule' } },
      { kind: 'call', id: 'tail', module: 'text.concat', version: '1', inputs: { left: literal('tail-'), right: literal('ran') } },
      { kind: 'return', id: 'return-tail', value: output('tail', 'text') },
    ],
    outputs: [{ name: 'tail', type: 'string' }],
  }
}

function oldQueueWithIndependentTailGraph(): GameplayModuleGraph {
  const graph = oldQueueGraph()
  return {
    ...graph,
    body: [
      ...graph.body.slice(0, -1),
      { kind: 'call', id: 'tail', module: 'text.concat', version: '1', inputs: { left: literal('continued-'), right: literal('after-fault') } },
      { kind: 'return', id: 'return-tail', value: output('tail', 'text') },
    ],
    outputs: [{ name: 'tail', type: 'string' }],
  }
}

describe('captured author damage queue', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('compiles record source and record target through the public damage sentence', () => {
    const compiled = compileGameplayModuleGraph(capturedDamageGraph(), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('authorDamageCaptured')
    expect(compiled.code).not.toContain('damageManyCaptured')
  })

  it('queues once in processing and settles after the current hit without re-entry', () => {
    const { state, source, target } = fixture()
    const compiled = compileGameplayModuleGraph(capturedDamageGraph(), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])
    const results: unknown[] = []
    globalTriggerSystem.addRule({
      id: 'captured-author-processing', name: 'captured-author-processing', description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (_battle: unknown, context: any) => {
        if (context.skillId === 'root-captured-test') {
          const flow = createSkillCodeFlow(state, context, 'rule')
          const execute = new Function('flow', 'context', compiled.code) as (runtime: unknown, value: unknown) => unknown
          results.push(execute(flow, context))
        }
        return { success: true }
      },
    } as any)

    expect(() => withRuleRuntime(new RuleRuntime({ rootSeed: 252 }), () => dealDamage(source, target, 1, 'true', state, 'root-captured-test'))).not.toThrow()
    expect(results).toEqual([{ queued: true, targetId: target.instanceId }])
    expect(target.currentHp).toBe(17)
    expect(state.actions.filter((action: any) => action.type === 'damage').map((action: any) => action.payload.skillId))
      .toEqual(['root-captured-test', 'captured-author-damage'])
  })

  it('keeps a captured source usable after it is queued to leave, while a finalized target is skipped', () => {
    const sourceRun = fixture()
    sourceRun.source.currentHp = 1
    const sourceResults: unknown[] = []
    globalTriggerSystem.addRule({
      id: 'captured-author-departure', name: 'captured-author-departure', description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (_battle: unknown, context: any) => {
        if (context.skillId !== 'departure-root') return { success: true }
        const flow = createSkillCodeFlow(sourceRun.state, context, 'rule')
        const sourceHandle = flow.effects.captureEventPiece('sourcePiece')
        const targetHandle = flow.effects.captureEventPiece('targetPiece')
        context.damageQueue.push({ attacker: sourceRun.target, target: sourceRun.source, damage: 1, damageType: 'true', skillId: 'departure-kill' })
        sourceResults.push(flow.effects.authorDamageCaptured(sourceHandle, targetHandle, 2, 'true', 'departure-followup'))
        return { success: true }
      },
    } as any)
    withRuleRuntime(new RuleRuntime({ rootSeed: 252 }), () => dealDamage(sourceRun.source, sourceRun.target, 1, 'true', sourceRun.state, 'departure-root'))
    expect(sourceResults).toEqual([{ queued: true, targetId: sourceRun.target.instanceId }])
    expect(sourceRun.state.graveyard.map((piece: any) => piece.instanceId)).toContain(sourceRun.source.instanceId)
    expect(sourceRun.target.currentHp).toBe(17)
    expect(sourceRun.state.actions.filter((action: any) => action.type === 'damage').map((action: any) => action.payload.skillId))
      .toEqual(['departure-root', 'departure-kill', 'departure-followup'])

    const targetRun = fixture(1)
    const targetResults: unknown[] = []
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule({
      id: 'captured-author-finalized-target', name: 'captured-author-finalized-target', description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (_battle: unknown, context: any) => {
        if (context.skillId !== 'finalize-root') return { success: true }
        const flow = createSkillCodeFlow(targetRun.state, context, 'rule')
        targetResults.push(flow.effects.authorDamageCaptured(
          flow.effects.captureEventPiece('sourcePiece'),
          flow.effects.captureEventPiece('targetPiece'),
          2,
          'true',
          'finalize-followup',
        ))
        return { success: true }
      },
    } as any)
    withRuleRuntime(new RuleRuntime({ rootSeed: 252 }), () => dealDamage(targetRun.source, targetRun.target, 1, 'true', targetRun.state, 'finalize-root'))
    expect(targetResults).toEqual([{ queued: true, targetId: targetRun.target.instanceId }])
    expect(targetRun.state.graveyard.map((piece: any) => piece.instanceId)).toContain(targetRun.target.instanceId)
    expect(targetRun.state.actions.filter((action: any) => action.type === 'damage').map((action: any) => action.payload.skillId))
      .toEqual(['finalize-root'])
  })

  it('rejects invalid, forged, cross-execution and missing-queue requests before mutation', () => {
    const { state, source, target } = fixture()
    const queue: any[] = []
    const first = createFlowRuntime(state, { sourcePiece: source, targetPiece: target, damageQueue: queue }, 'rule', {}) as any
    const sourceHandle = first.effects.captureEventPiece('sourcePiece')
    const targetHandle = first.effects.captureEventPiece('targetPiece')
    expect(() => first.effects.authorDamageCaptured(sourceHandle, targetHandle, Number.NaN, 'true', 'invalid')).toThrow('无效队列伤害')
    expect(queue).toHaveLength(0)
    expect(() => first.effects.authorDamageCaptured({ ...sourceHandle }, targetHandle, 1, 'true', 'forged')).toThrow('不属于当前执行')
    expect(queue).toHaveLength(0)
    const second = createFlowRuntime(state, { sourcePiece: source, targetPiece: target, damageQueue: queue }, 'rule', {}) as any
    const secondTarget = second.effects.captureEventPiece('targetPiece')
    expect(() => second.effects.authorDamageCaptured(sourceHandle, secondTarget, 1, 'true', 'cross')).toThrow('不属于当前执行')
    expect(queue).toHaveLength(0)
    const noQueue = createFlowRuntime(state, { sourcePiece: source, targetPiece: target }, 'rule', {}) as any
    expect(() => noQueue.effects.authorDamageCaptured(
      noQueue.effects.captureEventPiece('sourcePiece'),
      noQueue.effects.captureEventPiece('targetPiece'),
      1,
      'true',
      'no-queue',
    )).toThrow('当前事件不支持伤害队列')
    expect(queue).toHaveLength(0)
  })

  it('does not expose success when a migrated queue is fault-isolated, and runs an independent tail', () => {
    const graph = rewriteAtomicGraph(oldQueueWithIndependentTailGraph(), atomicCapturedEffectRecipe)
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])

    const { state, source, target } = fixture()
    const context: any = { sourcePiece: source, targetPiece: target }
    const flow = createFlowRuntime(state, context, 'rule', {})
    const host = createGameplayModuleDiagnosticHost('rule', {}, () => undefined)
    const restore = installGameplayModuleDiagnosticHost(context, host)
    try {
      const execute = new Function('flow', 'battle', 'context', compiled.code) as (runtime: unknown, battle: unknown, value: unknown) => unknown
      expect(execute(flow, state, context)).toBe('continued-after-fault')
    } finally {
      restore()
    }

    expect(host.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ statementId: 'queue', moduleId: 'author.effect.damage' }),
    ]))
    expect(source.currentHp).toBe(20)
    expect(target.currentHp).toBe(20)
  })

  it('rewrites captured queue and rule removal to public atomic combinations', () => {
    const queue = rewriteAtomicGraph(oldQueueGraph(), atomicCapturedEffectRecipe)
    expect(queue.body.some(statement => statement.kind === 'call' && statement.module === 'effect.queue-damage-captured')).toBe(false)
    expect(queue.body.find(statement => statement.id === 'queue')).toMatchObject({ module: 'author.effect.damage', version: '2', parameters: { sourceType: 'record', targetType: 'record', damageType: 'true' } })
    const queueReturn = (queue.body.find(statement => statement.kind === 'return') as any).value
    expect(queueReturn).toMatchObject({ kind: 'output', port: 'value' })
    expect(queue.body.some(statement => statement.kind === 'call' && statement.module === 'result.field' && statement.parameters?.field === 'queued')).toBe(true)
    expect(compileGameplayModuleGraph(queue, GAMEPLAY_MODULE_REGISTRY).diagnostics).toEqual([])

    const remove = rewriteAtomicGraph(oldRemoveGraph(), atomicCapturedEffectRecipe)
    expect(remove.body.some(statement => statement.kind === 'call' && statement.module === 'rule.remove-captured')).toBe(false)
    expect(remove.body.map(statement => statement.kind === 'call' ? statement.module : statement.kind)).toEqual([
      'ref.source', 'source.capture', 'rule.remove-id-raw', 'return',
    ])
    expect(remove.body.find(statement => statement.kind === 'call' && statement.module === 'rule.remove-id-raw')).toMatchObject({
      version: '2', parameters: { targetType: 'record', ruleId: 'legacy-rule' },
    })
    expect(compileGameplayModuleGraph(remove, GAMEPLAY_MODULE_REGISTRY).diagnostics).toEqual([])
  })

  it('preserves captured rule removal success for both a match and a valid no-match source', () => {
    const legacy = compileGameplayModuleGraph(oldRemoveGraph(), GAMEPLAY_MODULE_REGISTRY)
    const migrated = compileGameplayModuleGraph(rewriteAtomicGraph(oldRemoveGraph(), atomicCapturedEffectRecipe), GAMEPLAY_MODULE_REGISTRY)
    expect(legacy.diagnostics).toEqual([])
    expect(migrated.diagnostics).toEqual([])

    for (const rules of [[], [{ id: 'legacy-rule' }]]) {
      const oldSource = asPieceInstance(makePiece({ instanceId: 'old-remove-source', rules }))
      const oldState = makeState({ pieces: [oldSource] })
      const oldContext: any = { sourcePiece: oldSource }
      const oldFlow = createFlowRuntime(oldState, oldContext, 'rule', {})
      const runOld = new Function('flow', 'battle', 'context', legacy.code) as (flow: unknown, battle: unknown, context: unknown) => unknown

      const newSource = asPieceInstance(makePiece({ instanceId: 'new-remove-source', rules }))
      const newState = makeState({ pieces: [newSource] })
      const newContext: any = { sourcePiece: newSource }
      const newFlow = createFlowRuntime(newState, newContext, 'rule', {})
      const runNew = new Function('flow', 'battle', 'context', migrated.code) as (flow: unknown, battle: unknown, context: unknown) => unknown

      expect(runOld(oldFlow, oldState, oldContext)).toBe(true)
      expect(runNew(newFlow, newState, newContext)).toBe(true)
      expect(oldSource.rules).toEqual([])
      expect(newSource.rules).toEqual([])
    }
  })

  it('keeps the v2 string target path equivalent to the legacy record-id remover', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'rule',
      body: [
        { kind: 'call', id: 'remove', module: 'rule.remove-id-raw', version: '2', inputs: { target: literal('string-source') }, parameters: { targetType: 'string', ruleId: 'legacy-rule' } },
        { kind: 'return', id: 'return', value: output('remove', 'success') },
      ],
      outputs: [{ name: 'success', type: 'boolean' }],
    }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])
    const source = asPieceInstance(makePiece({ instanceId: 'string-source', rules: [{ id: 'legacy-rule' }] }))
    const state = makeState({ pieces: [source] })
    const context: any = {}
    const flow = createFlowRuntime(state, context, 'rule', {})
    const run = new Function('flow', 'battle', 'context', compiled.code) as (runtime: unknown, battle: unknown, value: unknown) => unknown
    expect(run(flow, state, context)).toBe(true)
    expect(source.rules).toEqual([])
  })

  it('removes rules from the captured object after departure, never from a replacement with the same id', () => {
    const migrated = compileGameplayModuleGraph(rewriteAtomicGraph(oldEventCaptureRemoveGraph(), atomicCapturedEffectRecipe), GAMEPLAY_MODULE_REGISTRY)
    const departed = asPieceInstance(makePiece({ instanceId: 'same-instance-id', rules: [{ id: 'legacy-rule' }] }))
    const replacement = asPieceInstance(makePiece({ instanceId: 'same-instance-id', rules: [{ id: 'legacy-rule' }] }))
    const state = makeState({ pieces: [replacement] })
    const context: any = { sourcePiece: departed }
    const flow = createFlowRuntime(state, context, 'rule', {})
    const run = new Function('flow', 'battle', 'context', migrated.code) as (runtime: unknown, battle: unknown, value: unknown) => unknown

    expect(run(flow, state, context)).toBe(true)
    expect(departed.rules).toEqual([])
    expect(replacement.rules).toEqual([{ id: 'legacy-rule' }])
  })

  it('rejects forged and cross-execution removal handles without mutating the source', () => {
    const { state, source } = fixture()
    source.rules = [{ id: 'legacy-rule' } as any]
    const first = createFlowRuntime(state, { sourcePiece: source }, 'rule', {}) as any
    const handle = first.effects.captureEventPiece('sourcePiece')
    expect(() => first.effects.removeCapturedRule({ ...handle }, 'legacy-rule')).toThrow('不属于当前执行')
    expect(source.rules).toEqual([{ id: 'legacy-rule' }])

    const second = createFlowRuntime(state, { sourcePiece: source }, 'rule', {}) as any
    expect(() => second.effects.removeCapturedRule(handle, 'legacy-rule')).toThrow('不属于当前执行')
    expect(source.rules).toEqual([{ id: 'legacy-rule' }])
  })

  it('fault-isolates an invalid removal handle and keeps a dependent-free tail running', () => {
    const compiled = compileGameplayModuleGraph(forgedRemoveWithTailGraph(), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])
    const { state } = fixture()
    const context: any = {}
    const flow = createFlowRuntime(state, context, 'rule', {})
    const host = createGameplayModuleDiagnosticHost('rule', {}, () => undefined)
    const restore = installGameplayModuleDiagnosticHost(context, host)
    try {
      const run = new Function('flow', 'battle', 'context', compiled.code) as (runtime: unknown, battle: unknown, value: unknown) => unknown
      expect(run(flow, state, context)).toBe('tail-ran')
    } finally {
      restore()
    }
    expect(host.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ statementId: 'remove', moduleId: 'rule.remove-id-raw' }),
    ]))
  })
})
