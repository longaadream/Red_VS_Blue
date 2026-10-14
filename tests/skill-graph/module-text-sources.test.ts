import { describe, expect, it } from 'vitest'
import { getGameplayModuleTextSources, renderGameplayModuleText } from '../../lib/skill-graph/module-text'
import { applyGameplayModuleGraph, applyGameplayModuleTextBindings, assertGameplayModuleDocument, createGameplayModuleGraph } from '../../lib/skill-graph/module-document'

function entries() {
  return { code: { graph: {
    inputs: [{ name: 'amount', type: 'number' }], inputBindings: { amount: 5 },
    body: [{ kind: 'call', id: 'select', module: 'target.select', parameters: { range: 5 }, inputs: {} },
      { kind: 'if', id: 'condition', then: [{ kind: 'call', id: 'scale', module: 'math.multiply',
        inputs: { a: { kind: 'output', node: 'attack', port: 'value' }, b: { kind: 'literal', value: 1.5 } } }] }],
  } } }
}

describe('author text sources', () => {
  it('updates the description from the same selected range and multiplier literals', () => {
    const data = entries()
    const binding = { description: { template: '选择敌人（{{range}}），造成{{scale}}倍伤害。', values: {
      range: { entry: 'code', node: 'select', parameter: 'range' },
      scale: { entry: 'code', node: 'scale', input: 'b' },
    } } }
    expect(renderGameplayModuleText(data, binding).description).toBe('选择敌人（5），造成1.5倍伤害。')
    data.code.graph.body[0].parameters!.range = 7
    expect(renderGameplayModuleText(data, binding).description).toBe('选择敌人（7），造成1.5倍伤害。')
  })

  it('retains existing declared input bindings and enumerates only actual primitive values', () => {
    const data = entries()
    expect(renderGameplayModuleText(data, { targetText: { template: '{{amount}}', values: { amount: { entry: 'code', input: 'amount' } } } })).toEqual({ targetText: '5' })
    expect(getGameplayModuleTextSources(data).map(item => item.source)).toEqual([
      { entry: 'code', input: 'amount' }, { entry: 'code', node: 'select', parameter: 'range' }, { entry: 'code', node: 'scale', input: 'b' },
    ])
  })

  it('refuses runtime references, removed statements, ambiguous sources and unknown keys', () => {
    for (const source of [
      { entry: 'code', node: 'scale', input: 'a' },
      { entry: 'code', node: 'deleted', input: 'b' },
      { entry: 'code', node: 'select', parameter: 'range', input: 'b' },
      { entry: 'code', node: 'select', parameter: 'range', source: 'arbitrary' },
      { entry: '__proto__', input: 'amount' },
    ]) expect(() => renderGameplayModuleText(entries(), { description: { template: '{{value}}', values: { value: source } } })).toThrow()
  })

  it('can repair an invalid text draft while still rejecting altered executable code', () => {
    const original = applyGameplayModuleGraph({ id: 'repair', extension: { preserve: true } }, createGameplayModuleGraph('skill'))
    const modules = original.gameplayModules as Record<string, unknown>
    const invalid = { ...original, gameplayModules: { ...modules, textBindings: {
      description: { template: '{{missing}}', values: {} },
    } } }
    expect(() => assertGameplayModuleDocument(invalid)).toThrow('unbound placeholder')
    const bindings = { description: { template: '修复后的说明', values: {} } }
    const repaired = applyGameplayModuleTextBindings(invalid, bindings)
    expect(repaired.description).toBe('修复后的说明')
    expect(repaired.extension).toEqual({ preserve: true })
    expect(() => assertGameplayModuleDocument(repaired)).not.toThrow()
    expect(() => applyGameplayModuleTextBindings({ ...invalid, code: 'return 1' }, bindings)).toThrow('does not match')
  })
})
