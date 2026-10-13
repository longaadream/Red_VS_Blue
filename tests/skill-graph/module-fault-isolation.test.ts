import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  compileGameplayModuleGraph,
  compileGameplayModuleGraphV1,
} from '../../lib/skill-graph/module-compiler'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import {
  createGameplayModuleDiagnosticHost,
  installGameplayModuleDiagnosticHost,
} from '../../lib/game/gameplay-module-diagnostics'
import { EffectChainFatalError } from '../../lib/game/effect-batch'
import { PreviewReactionPendingError } from '../../lib/game/rule-runtime'
import { SuspendableActionPending, SuspendableActionReplayError } from '../../lib/game/suspendable-action-transaction'
import { calculateSkillPreview, type SkillDefinition } from '../../lib/game/skills'

const version = '1'

function registryOf(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(item => [item.id + '@' + item.version, item]))
  return { get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version)) }
}

function descriptor(
  id: string,
  inputs: GameplayModuleDescriptor['inputs'],
  outputs: GameplayModuleDescriptor['outputs'],
  expression: string,
  allowedSurfaces: GameplayModuleDescriptor['allowedSurfaces'] = ['skill'],
): GameplayModuleDescriptor {
  return {
    id,
    version,
    label: id,
    inputs,
    outputs,
    allowedSurfaces,
    effects: { pure: false, previewSafe: false, writes: ['test'] },
    lower: () => ({ expression }),
  }
}

function graph(body: GameplayModuleGraph['body'], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, ...extra }
}

function call(id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}) {
  return { kind: 'call' as const, id, module, version, inputs }
}

function execute(code: string, context: Record<string, unknown>): unknown {
  return (runInNewContext('(' + code + ')') as (value: Record<string, unknown>) => unknown)(context)
}

function withHost(context: Record<string, unknown>, surface = 'skill') {
  const host = createGameplayModuleDiagnosticHost(surface, {}, () => undefined)
  const restore = installGameplayModuleDiagnosticHost(context, host)
  return { host, restore }
}

describe('v2 gameplay module fault isolation', () => {
  it.each(['map', 'filter', 'reduce'] as const)('invalid captures invalidate the whole %s, including an empty collection, while the independent tail runs', method => {
    const invalid: GameplayModuleDescriptor = { ...descriptor('test.invalid', [], [{ name: 'value', type: 'number' }], '__gameplayInvalid'), effects: { pure: true, previewSafe: true } }
    const flag = descriptor('test.flag', [], [], 'context.values.push("dependent")')
    const tail = descriptor('test.tail', [], [], 'context.values.push("independent")')
    for (const items of [[], [1]]) {
      const collection = { kind: 'collection' as const, id: 'collection', method, items: { kind: 'literal' as const, value: items }, inputs: { missing: { kind: 'output' as const, node: 'invalid', port: 'value' } },
        ...(method === 'reduce' ? { initial: { kind: 'literal' as const, value: 0 } } : {}),
        body: [{ kind: 'return' as const, id: 'return', value: { kind: 'literal' as const, value: method === 'filter' ? true : 1 } }] }
      const compiled = compileGameplayModuleGraph(graph([
        call('invalid', 'test.invalid'), collection,
        { kind: 'foreach', id: 'consume', items: method === 'reduce' ? { kind: 'literal', value: [1] } : { kind: 'output', node: 'collection', port: 'value' }, body: method === 'reduce' ? [] : [call('flag', 'test.flag')] },
        { kind: 'return', id: 'dependent-return', value: { kind: 'output', node: 'collection', port: 'value' } },
        call('tail', 'test.tail'),
      ], { outputs: [{ name: 'value', type: method === 'reduce' ? 'number' : { kind: 'list', element: 'number' } }] }), registryOf(invalid, flag, tail))
      const context = { values: [] as string[] }
      expect(execute(compiled.code, context)).toBeUndefined()
      expect(context.values).toEqual(['independent'])
    }
  })

  it('does not let a reduce body replace an invalid initial value', () => {
    const invalid: GameplayModuleDescriptor = { ...descriptor('test.invalid', [], [{ name: 'value', type: 'number' }], '__gameplayInvalid'), effects: { pure: true, previewSafe: true } }
    const compiled = compileGameplayModuleGraph(graph([
      call('invalid', 'test.invalid'),
      { kind: 'collection', id: 'reduced', method: 'reduce', items: { kind: 'literal', value: [1] }, initial: { kind: 'output', node: 'invalid', port: 'value' }, body: [{ kind: 'return', id: 'inside', value: { kind: 'literal', value: 42 } }] },
      { kind: 'return', id: 'dependent', value: { kind: 'output', node: 'reduced', port: 'value' } },
      { kind: 'return', id: 'independent', value: { kind: 'literal', value: 7 } },
    ], { outputs: [{ name: 'value', type: 'number' }] }), registryOf(invalid))
    expect(execute(compiled.code, {})).toBe(7)
  })
  it('records a native throw, invalidates dependents, and continues independent statements', () => {
    const fail = descriptor('test.fail', [], [{ name: 'value', type: 'number' }], 'context.fail()')
    const dependent = descriptor('test.dependent', [{ name: 'value', type: 'number' }], [], 'context.dependent()')
    const independent = descriptor('test.independent', [], [], 'context.values.push("independent")')
    const compiled = compileGameplayModuleGraph(graph([
      call('failed', 'test.fail'),
      call('dependent', 'test.dependent', { value: { kind: 'output', node: 'failed', port: 'value' } }),
      call('independent', 'test.independent'),
    ]), registryOf(fail, dependent, independent))
    const context = {
      values: [] as string[],
      fail: () => { throw new Error('native failure') },
      dependent: () => { throw new Error('dependent should be skipped') },
    }
    const { host, restore } = withHost(context)
    try {
      expect(execute(compiled.code, context)).toBeUndefined()
    } finally {
      restore()
    }
    expect(context.values).toEqual(['independent'])
    expect(host.diagnostics.some(item => item.statementId === 'failed' && item.moduleId === 'test.fail' && item.message === 'native failure')).toBe(true)
  })

  it('unwinds nested loops at the shared budget and runs the independent tail', () => {
    const visit: GameplayModuleDescriptor = {
      ...descriptor('test.visit', [{ name: 'item', type: 'number' }], [], ''),
      lower: ({ inputs }) => ({ expression: 'context.visits.push(' + inputs.item + ')' }),
    }
    const tail = descriptor('test.tail', [], [], 'context.values.push("tail")')
    const inner = {
      kind: 'foreach' as const,
      id: 'inner',
      items: { kind: 'literal' as const, value: [1, 2] },
      item: 'item',
      body: [call('visit-inner', 'test.visit', { item: { kind: 'input' as const, name: 'item' } })],
    }
    const compiled = compileGameplayModuleGraph(graph([
      {
        kind: 'foreach', id: 'outer', items: { kind: 'literal', value: [1, 2] }, item: 'outerItem',
        body: [inner],
      },
      call('tail', 'test.tail'),
    ]), registryOf(visit, tail), { maxCollectionIterations: 2 })
    const context = { visits: [] as number[], values: [] as string[] }
    const { host, restore } = withHost(context)
    try {
      expect(execute(compiled.code, context)).toBeUndefined()
    } finally {
      restore()
    }
    expect(context.values).toEqual(['tail'])
    expect(context.visits.length).toBe(1)
    expect(host.diagnostics.some(item => item.statementId === 'outer' && item.message.includes('shared iteration budget'))).toBe(true)
  })

  it('keeps v1 emission and behavior available for existing artifacts', () => {
    const valueModule = descriptor('test.value', [], [{ name: 'value', type: 'number' }], '({ value: 7 })')
    const input = graph([call('value', 'test.value'), { kind: 'return', id: 'done', value: { kind: 'output', node: 'value', port: 'value' } }], { outputs: [{ name: 'value', type: 'number' }] })
    const v1 = compileGameplayModuleGraphV1(input, registryOf(valueModule))
    expect(v1.compilerVersion).toBe('rvb-gameplay-module-compiler/v1')
    expect(execute(v1.code, {})).toBe(7)
    expect(v1.code).not.toContain('__gameplayRecordFault')
  })

  it.each([
    new SuspendableActionPending({ consumerKind: 'skill', consumerId: 'test', consumerOrdinal: 0 }, { kind: 'option', options: [] }),
    new EffectChainFatalError('RVB_EFFECT_CHAIN_BATCH_REJECTED', 'fatal signal', {} as never),
    new SuspendableActionReplayError('replay signal'),
    new PreviewReactionPendingError('rule', 'test', undefined, 'preview'),
  ])('rethrows control signal %s unchanged', signal => {
    const raise = descriptor('test.raise', [], [], 'context.raise()')
    const compiled = compileGameplayModuleGraph(graph([call('raise', 'test.raise')]), registryOf(raise))
    const context = { raise: () => { throw signal } }
    const { restore } = withHost(context)
    try {
      let thrown: unknown
      try {
        execute(compiled.code, context)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(signal)
    } finally {
      restore()
    }
  })

  it('carries the diagnostic host through pending and preview wrappers', () => {
    const pendingRaise = descriptor('test.pendingRaise', [], [], 'ctx.raise()', ['pending'])
    const pending = compileGameplayModuleGraph(graph([call('raise', 'test.pendingRaise')], { surface: 'pending' }), registryOf(pendingRaise))
    const pendingContext = { raise: () => { throw new Error('pending failure') } }
    const pendingHost = withHost(pendingContext, 'pending')
    try {
      const executePending = runInNewContext('(' + pending.code + ')') as (context: Record<string, unknown>) => unknown
      expect(executePending(pendingContext)).toBeUndefined()
    } finally {
      pendingHost.restore()
    }
    expect(pendingHost.host.diagnostics[0]).toMatchObject({ statementId: 'raise', surface: 'pending', message: 'pending failure' })

    const previewDescriptor = (id: string, expression: string): GameplayModuleDescriptor => ({
      ...descriptor(id, [], [], expression, ['preview']),
      effects: { pure: true, previewSafe: true, writes: [] },
    })
    const previewFail = previewDescriptor('test.previewFail', 'context.skillDef.fail()')
    const previewTail = previewDescriptor('test.previewTail', 'context.skillDef.values.push("tail")')
    const preview = compileGameplayModuleGraph(graph([
      call('fail', 'test.previewFail'),
      call('tail', 'test.previewTail'),
    ], { surface: 'preview' }), registryOf(previewFail, previewTail))
    const skillDef = { fail: () => { throw new Error('preview failure') }, values: [] as string[] }
    const previewHost = withHost(skillDef, 'preview')
    try {
      const calculatePreview = runInNewContext('(' + preview.code + ')') as (piece: unknown, skillDef: unknown, currentCooldown: number) => unknown
      expect(calculatePreview({}, skillDef, 0)).toBeUndefined()
    } finally {
      previewHost.restore()
    }
    expect(skillDef.values).toEqual(['tail'])
    expect(previewHost.host.diagnostics[0]).toMatchObject({ statementId: 'fail', surface: 'preview', message: 'preview failure' })
  })

  it('injects the host at the real preview execution boundary with content metadata', () => {
    const fail = {
      ...descriptor('test.previewFail', [], [], 'context.skillDef.fail()', ['preview']),
      effects: { pure: true, previewSafe: true, writes: [] },
    }
    const independent = {
      ...descriptor('test.previewTail', [], [], 'context.skillDef.values.push("tail")', ['preview']),
      effects: { pure: true, previewSafe: true, writes: [] },
    }
    const compiled = compileGameplayModuleGraph(graph([
      call('fail', 'test.previewFail'),
      call('tail', 'test.previewTail'),
    ], { surface: 'preview' }), registryOf(fail, independent))
    const previewState = {
      fail: () => { throw new Error('preview boundary failure') },
      values: [] as string[],
    }
    const skillDef = {
      id: 'test-preview-skill',
      name: 'Test preview skill',
      description: 'test',
      kind: 'active' as const,
      type: 'normal' as const,
      form: 'self' as const,
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      code: 'function executeSkill() { return { success: true } }',
      previewCode: compiled.code,
      range: 'self' as const,
      actionPointCost: 0,
      ...previewState,
    } as unknown as SkillDefinition
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let diagnostic: unknown
    try {
      expect(calculateSkillPreview(skillDef, { instanceId: 'piece', ownerPlayerId: 'player-1' } as never)).toMatchObject({ cooldown: 0 })
      diagnostic = errorSpy.mock.calls.find(call => call[0] === '[gameplay-module-diagnostic]')?.[1]
    } finally {
      errorSpy.mockRestore()
    }
    expect(previewState.values).toEqual(['tail'])
    expect(diagnostic).toMatchObject({
      statementId: 'fail',
      moduleId: 'test.previewFail',
      surface: 'preview',
      contentId: 'test-preview-skill',
      actorPlayerId: 'player-1',
      message: 'preview boundary failure',
    })
  })

  it('invalidates a partial map result when nested work exhausts the shared budget', () => {
    const dependent = descriptor('test.dependent', [{ name: 'value', type: { kind: 'list', element: 'number' } }], [], 'context.values.push("dependent")')
    const tail = descriptor('test.tail', [], [], 'context.values.push("tail")')
    const compiled = compileGameplayModuleGraph(graph([
      {
        kind: 'collection', id: 'mapped', method: 'map', items: { kind: 'literal', value: [1, 2] }, item: 'item',
        body: [
          { kind: 'foreach', id: 'inner', items: { kind: 'literal', value: [1, 2] }, item: 'innerItem', body: [] },
          { kind: 'return', id: 'mapReturn', value: { kind: 'input', name: 'item' } },
        ],
      },
      call('dependent', 'test.dependent', { value: { kind: 'output', node: 'mapped', port: 'value' } }),
      call('tail', 'test.tail'),
    ]), registryOf(dependent, tail), { maxCollectionIterations: 3 })
    const context = { values: [] as string[] }
    const { host, restore } = withHost(context)
    try {
      expect(execute(compiled.code, context)).toBeUndefined()
    } finally {
      restore()
    }
    expect(context.values).toEqual(['tail'])
    expect(host.diagnostics.some(item => item.statementId === 'mapped' && item.message.includes('shared iteration budget'))).toBe(true)
  })

  it('skips a while condition with an invalid capture even when its body does not read it', () => {
    const missing = descriptor('test.missing', [], [{ name: 'value', type: 'number' }], '__gameplayInvalid')
    const hit = descriptor('test.hit', [], [], 'context.values.push("loop")')
    const tail = descriptor('test.tail', [], [], 'context.values.push("tail")')
    const compiled = compileGameplayModuleGraph(graph([
      call('missing', 'test.missing'),
      { kind: 'while', id: 'loop', budget: 3, condition: {
        inputs: { dependency: { kind: 'output', node: 'missing', port: 'value' } },
        body: [{ kind: 'return', id: 'condition', value: { kind: 'literal', value: true } }],
      }, body: [call('hit', 'test.hit')] },
      call('tail', 'test.tail'),
    ]), registryOf(missing, hit, tail), { maxCollectionIterations: 3 })
    const context = { values: [] as string[] }
    const { host, restore } = withHost(context)
    try { execute(compiled.code, context) } finally { restore() }
    expect(context.values).toEqual(['tail'])
    expect(host.diagnostics).toEqual([])
  })

  it('caps repeated diagnostics from a failing loop', () => {
    const fail = descriptor('test.fail', [], [], 'context.fail()')
    const compiled = compileGameplayModuleGraph(graph([{
      kind: 'foreach', id: 'loop', items: { kind: 'literal', value: Array.from({ length: 100 }, (_, index) => index) }, item: 'item',
      body: [call('fail', 'test.fail')],
    }]), registryOf(fail), { maxCollectionIterations: 100 })
    const context = { fail: () => { throw new Error('loop failure') } }
    const { host, restore } = withHost(context)
    try {
      execute(compiled.code, context)
    } finally {
      restore()
    }
    expect(host.diagnostics.length).toBe(65)
    expect(host.suppressedCount).toBe(36)
  })
})
