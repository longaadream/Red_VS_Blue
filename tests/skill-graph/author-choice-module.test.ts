import { describe, expect, it, vi } from 'vitest'
import type {
  GameplayLiteral,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringResult,
} from '../../lib/skill-graph/module-types'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '../../lib/skill-graph/module-types'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import {
  GAMEPLAY_MODULE_REGISTRY,
  GAMEPLAY_MODULE_VERSION,
  getGameplayModule,
} from '../../lib/skill-graph/module-registry'

function descriptor(id: string): GameplayModuleDescriptor {
  const value = getGameplayModule(id)
  if (!value) throw new Error(`missing author choice module ${id}`)
  return value
}

function lower(
  id: string,
  surface: GameplayModuleSurface,
  inputs: Record<string, string> = {},
  parameters: Record<string, GameplayLiteral> = {},
): string {
  const entry = descriptor(id)
  const value: GameplayNativeLoweringResult = entry.lower({
    surface,
    callId: 'test-call',
    moduleId: entry.id,
    moduleVersion: entry.version,
    inputs,
    parameters,
    outputPorts: entry.outputs,
    emitLiteral: item => JSON.stringify(item),
  })
  return typeof value === 'string'
    ? value
    : 'expression' in value
      ? value.expression
      : `${value.statements};${value.result ?? ''}`
}

function lowerV2(
  parameters: Record<string, GameplayLiteral> = {},
  inputs: Record<string, string> = { source: 'source', target: 'target', amount: 'amount' },
): string {
  const entry = getGameplayModule('author.effect.damage', '2')
  if (!entry) throw new Error('missing author effect damage v2 module')
  const effectiveParameters: Record<string, GameplayLiteral> = {
    sourceType: 'piece', targetType: 'piece', amountType: 'number', resultType: 'record', damageType: 'normal',
    ...parameters,
  }
  const value: GameplayNativeLoweringResult = entry.lower({
    surface: 'skill', callId: 'test-v2-damage', moduleId: entry.id, moduleVersion: entry.version,
    inputs, parameters: effectiveParameters, outputPorts: entry.outputs, emitLiteral: item => JSON.stringify(item),
  })
  return typeof value === 'string' ? value : 'expression' in value ? value.expression : `${value.statements};${value.result ?? ''}`
}

function lowerV3(
  parameters: Record<string, GameplayLiteral> = {},
  inputs: Record<string, string> = { source: 'source', target: 'target', amount: 'amount' },
): string {
  const entry = getGameplayModule('author.effect.damage', '3')
  if (!entry) throw new Error('missing author effect damage v3 module')
  const effectiveParameters: Record<string, GameplayLiteral> = {
    sourceType: 'piece', targetType: 'piece', amountType: 'number', resultType: 'record', damageType: 'normal',
    ...parameters,
  }
  const value: GameplayNativeLoweringResult = entry.lower({
    surface: 'skill', callId: 'test-v3-damage', moduleId: entry.id, moduleVersion: entry.version,
    inputs, parameters: effectiveParameters, outputPorts: entry.outputs, emitLiteral: item => JSON.stringify(item),
  })
  return typeof value === 'string' ? value : 'expression' in value ? value.expression : `${value.statements};${value.result ?? ''}`
}

function runExpression(source: string, scope: Record<string, unknown> = {}): unknown {
  const names = Object.keys(scope)
  const values = names.map(name => scope[name])
  return new Function(...names, `return (${source})`)(...values)
}

describe('generic author choice and target atoms', () => {
  it('maps presentation labels to typed option values and validates completed answers', () => {
    const entry = descriptor('author.choice.option')
    expect(entry.outputs).toEqual([{ name: 'value', type: 'record', label: '选中值' }])
    expect(entry.outputValueTypeBindings).toEqual({ value: { parameter: 'valueType' } })
    const source = lower('author.choice.option', 'skill', { options: 'choices' }, { valueType: 'number' })
    expect(source).toContain('flow.choice.authorOption')
    expect(source).toContain('{label: label, value: values[label]}')
    expect(source).toContain('flow.values.require')
    expect(source).not.toContain('needsOptionSelection')
    expect(source).not.toContain('needsTargetSelection')
  })

  it('suspends before later authored work and preserves completed false/number/object values', () => {
    const source = lower('author.choice.option', 'skill', { options: 'choices' }, { valueType: 'boolean' })
    const pending = new Error('suspendable pending')
    const require = vi.fn((value: unknown) => value)
    expect(() => runExpression(source, {
      choices: { No: false },
      flow: { choice: { authorOption: () => { throw pending } }, values: { require } },
    })).toThrow(pending)
    expect(require).not.toHaveBeenCalled()

    for (const [value, valueType] of [[false, 'boolean'], [7, 'number'], [{ kind: 'object-value', value: 42, needsOptionSelection: true }, 'record']] as const) {
      const typedSource = lower('author.choice.option', 'skill', { options: 'choices' }, { valueType })
      const completedRequire = vi.fn((selected: unknown) => selected)
      const result = runExpression(typedSource, {
        choices: { Answer: value },
        flow: { choice: { authorOption: () => value }, values: { require: completedRequire } },
      }) as { value: unknown }
      expect(result).toEqual({ value })
      expect(completedRequire).toHaveBeenCalledWith(value, valueType, [])
    }
  })

  it('normalizes selected piece references and declares cell occupancy constraints once', () => {
    const piece = lower('author.choice.target-piece', 'skill', {}, { range: 4, filter: 'ally' })
    expect(piece).toContain('type: "piece"')
    expect(piece).toContain('range: 4')
    expect(piece).toContain('filter: "ally"')
    expect(piece).toContain('value.instanceId')
    expect(piece).toContain('flow.values.require')
    expect(piece).not.toContain('needsOptionSelection')
    expect(piece).not.toContain('needsTargetSelection')

    const cell = lower('author.choice.target-cell', 'skill', {}, { range: 2 })
    expect(cell).toContain('type: "grid"')
    expect(cell).toContain('requireWalkable: true')
    expect(cell).toContain('requireUnoccupied: true')
    expect(cell).toContain('flow.values.require')
    expect(cell).not.toContain('needsOptionSelection')
    expect(cell).not.toContain('needsTargetSelection')
  })

  it('returns opaque piece IDs and keeps completed cell coordinates typed', () => {
    const pieceRequire = vi.fn((value: unknown) => value)
    const piece = runExpression(lower('author.choice.target-piece', 'skill'), {
      flow: { choice: { authorTarget: () => ({ instanceId: 'piece-1', needsTargetSelection: true }) }, values: { require: pieceRequire } },
    })
    expect(piece).toBe('piece-1')
    expect(pieceRequire).toHaveBeenCalledWith('piece-1', 'piece', [])

    const cellRequire = vi.fn((value: unknown) => value)
    const cell = runExpression(lower('author.choice.target-cell', 'skill'), {
      flow: { choice: { authorTarget: () => ({ x: 2, y: 3 }) }, values: { require: cellRequire } },
    })
    expect(cell).toEqual({ x: 2, y: 3 })
    expect(cellRequire).toHaveBeenCalledWith({ x: 2, y: 3 }, 'cell', [])
  })

  it('exposes only normal and true damage while preserving typed piece inputs', () => {
    const entry = descriptor('author.effect.damage')
    expect(entry.parameters?.find(parameter => parameter.name === 'damageType')?.enum).toEqual(['normal', 'true'])
    expect(entry.parameters?.some(parameter => parameter.name === 'inputPolicy')).toBe(false)
    const normal = lower('author.effect.damage', 'skill', { source: 'source', target: 'target', amount: 'amount' })
    expect(normal).toContain('flow.effects.damage')
    expect(normal).toContain('"physical"')
    expect(normal).toContain('target).instanceId')
    const trueDamage = lower('author.effect.damage', 'skill', { source: 'source', target: 'target', amount: 'amount' }, { damageType: 'true' })
    expect(trueDamage).toContain('"true"')

    const damage = vi.fn((source: unknown, target: unknown, amount: number, type: string) => ({
      success: true,
      damage: amount,
      source,
      target,
      type,
    }))
    const result = runExpression(normal, {
      source: 'source-1',
      target: { instanceId: 'target-1' },
      amount: 4,
      flow: { effects: { damage } },
      context: { skill: { id: 'author-damage' } },
    }) as { result: unknown; success: boolean; damage: number }
    expect(result.success).toBe(true)
    expect(result.damage).toBe(4)
    expect(damage).toHaveBeenCalledWith('source-1', 'target-1', 4, 'physical', 'author-damage')
  })

  it('keeps v2 default attribution bytes, preserves empty ids, and forwards explicit absence', () => {
    const entry = getGameplayModule('author.effect.damage', '2')
    expect(entry?.parameters?.find(parameter => parameter.name === 'attribution')).toMatchObject({
      label: '归属方式', enum: ['current', 'unattributed'], default: 'current',
    })
    const defaultLower = lowerV2()
    expect(defaultLower).toBe('({result:flow.effects.apply("damage",source,"piece",target,amount,"normal",String(context.skill?.id||context.card?.id||context.ruleId||"flow"))})')

    const unattributedLower = lowerV2({ attribution: 'unattributed' })
    expect(unattributedLower).toContain('flow.effects.apply("damage",source,"piece",target,amount,"normal",undefined)')
    expect(() => lowerV2({ attribution: 'legacy-no-skill' })).toThrow('伤害归属方式不合法')
    const emptyIdLower = lowerV2({ attribution: 'current', skillId: '' })
    expect(emptyIdLower).toContain('amount,"normal",""')

    const apply = vi.fn(() => ({ success: true }))
    runExpression(unattributedLower, { flow: { effects: { apply } }, context: { skill: { id: 'should-not-leak' } }, source: 'source-1', target: 'target-1', amount: 2 })
    expect(apply).toHaveBeenCalledWith('damage', 'source-1', 'piece', 'target-1', 2, 'normal', undefined)
    runExpression(emptyIdLower, { flow: { effects: { apply } }, context: { skill: { id: 'should-not-replace-empty' } }, source: 'source-1', target: 'target-1', amount: 2 })
    expect(apply).toHaveBeenLastCalledWith('damage', 'source-1', 'piece', 'target-1', 2, 'normal', '')
  })

  it('passes the unattributed policy through the captured host shape', () => {
    const lower = lowerV2({
      sourceType: 'record', targetType: { kind: 'list', element: 'piece' }, amountType: 'number', resultType: 'record', attribution: 'unattributed',
    }, { source: 'sourceHandle', target: 'targetIds', amount: 'amount' })
    expect(lower).toContain('flow.effects.damageManyCaptured(sourceHandle,targetIds,amount,"physical",undefined,"unattributed")')
    const captured = vi.fn(() => ({ results: [] }))
    runExpression(lower, { flow: { effects: { damageManyCaptured: captured } }, sourceHandle: {}, targetIds: [], amount: 1 })
    expect(captured).toHaveBeenCalledWith({}, [], 1, 'physical', undefined, 'unattributed')
  })

  it('uses a typed current Cluster for v3 attribution without exposing a skill ID parameter', () => {
    const entry = getGameplayModule('author.effect.damage', '3')
    expect(entry?.inputs.find(input => input.name === 'abilityGroup')).toMatchObject({ type: 'record', optional: true })
    expect(entry?.parameters?.some(parameter => parameter.name === 'skillId')).toBe(false)

    const source = lowerV3()
    expect(source).toContain('flow.clusters.current().group')
    expect(source).toContain('flow.clusters.attribution')
    const apply = vi.fn(() => ({ success: true, damage: 4 }))
    const attribution = vi.fn(() => 'group-attribution')
    runExpression(source, {
      source: 'source-1', target: 'target-1', amount: 4,
      flow: { clusters: { current: () => ({ group: {} }), attribution }, effects: { apply } },
    })
    expect(attribution).toHaveBeenCalledWith({})
    expect(apply).toHaveBeenCalledWith('damage', 'source-1', 'piece', 'target-1', 4, 'normal', 'group-attribution')

    const explicit = lowerV3({}, { source: 'source', target: 'target', amount: 'amount', abilityGroup: 'group' })
    expect(explicit).toContain('flow.clusters.attribution(group)')
    expect(explicit).not.toContain('clusters.current')
  })

  it('keeps card and player-rule v3 damage executable without inventing a current group', () => {
    const entry = getGameplayModule('author.effect.damage', '3')!
    const parameters = { sourceType: 'piece', targetType: 'piece', amountType: 'number', resultType: 'record', damageType: 'normal', attribution: 'current' } as const
    const lowered = entry.lower({
      surface: 'card', callId: 'test-v3-card', moduleId: entry.id, moduleVersion: entry.version,
      inputs: { source: 'source', target: 'target', amount: 'amount' }, parameters,
      outputPorts: entry.outputs, emitLiteral: value => JSON.stringify(value),
    }) as string
    expect(lowered).toContain('undefined)')
    expect(lowered).not.toContain('clusters.current')

    const explicit = entry.lower({
      surface: 'rule', callId: 'test-v3-rule', moduleId: entry.id, moduleVersion: entry.version,
      inputs: { source: 'source', target: 'target', amount: 'amount', abilityGroup: 'group' }, parameters,
      outputPorts: entry.outputs, emitLiteral: value => JSON.stringify(value),
    }) as string
    expect(explicit).toContain('flow.clusters.attribution(group)')
  })

  it('keeps v3 captured and unattributed queue lowering shapes', () => {
    const captured = lowerV3({
      sourceType: 'record', targetType: { kind: 'list', element: 'piece' }, amountType: 'number', resultType: 'record',
    }, { source: 'sourceHandle', target: 'targetIds', amount: 'amount' })
    expect(captured).toContain('flow.effects.damageManyCaptured(sourceHandle,targetIds,amount,"physical",flow.clusters.attribution(flow.clusters.current().group))')

    const unattributed = lowerV3({
      attribution: 'unattributed', sourceType: 'record', targetType: { kind: 'list', element: 'piece' }, amountType: 'number', resultType: 'record',
    }, { source: 'sourceHandle', target: 'targetIds', amount: 'amount' })
    expect(unattributed).toContain('flow.effects.damageManyCaptured(sourceHandle,targetIds,amount,"physical",undefined,"unattributed")')
    expect(unattributed).not.toContain('clusters.current')
  })

  it('compiles a dynamic option output and atomic target output through the public registry', () => {
    const optionGraph = compileGameplayModuleGraph({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'pending',
      inputs: [{ name: 'payload', type: { kind: 'record', schema: 'option-map' } }],
      hostBindings: { payload: { kind: 'record', schema: 'option-map' } },
      schemas: [{ id: 'option-map', version: '1', fields: [{ name: 'No', type: 'boolean' }] }],
      outputs: [{ name: 'value', type: 'number' }],
      body: [
        { kind: 'call', id: 'pick', module: 'author.choice.option', version: GAMEPLAY_MODULE_VERSION,
          inputs: { options: { kind: 'input', name: 'payload' } }, parameters: { valueType: 'number' } },
        { kind: 'return', id: 'done', values: { value: { kind: 'output', node: 'pick', port: 'value' } } },
      ],
    }, GAMEPLAY_MODULE_REGISTRY)
    expect(optionGraph.code).toContain('flow.choice.authorOption')

    const targetGraph = compileGameplayModuleGraph({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      outputs: [{ name: 'piece', type: 'piece' }],
      body: [
        { kind: 'call', id: 'pick', module: 'author.choice.target-piece', version: GAMEPLAY_MODULE_VERSION, parameters: { filter: 'enemy' } },
        { kind: 'return', id: 'done', values: { piece: { kind: 'output', node: 'pick', port: 'piece' } } },
      ],
    }, GAMEPLAY_MODULE_REGISTRY)
    expect(targetGraph.code).toContain('type: "piece"')
  })

})
