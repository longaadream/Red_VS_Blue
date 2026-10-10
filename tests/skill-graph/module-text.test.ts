import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph, applyGameplayModuleTextBindings, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-document'

const graph = (gain = 1): GameplayModuleGraph => ({
  version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'card',
  inputs: [{ name: 'gain', type: 'number' }], inputBindings: { gain },
  outputs: [{ name: 'value', type: 'number' }],
  body: [{ kind: 'return', id: 'return', value: { kind: 'input', name: 'gain' } }],
})
const binding = { description: { template: '获得{{amount}}点行动点。', values: { amount: { entry: 'code', input: 'gain' } } } } as const

describe('module text shares execution inputs', () => {
  it('preserves wording then synchronizes text when the same execution parameter changes', () => {
    const original = applyGameplayModuleGraph({ description: '获得1点行动点。', targetText: '自身' }, graph())
    const bound = applyGameplayModuleTextBindings(original, binding)
    expect(bound.description).toBe(original.description)
    const changed = applyGameplayModuleGraph(bound, graph(3))
    expect(changed.description).toBe('获得3点行动点。')
    expect(changed.targetText).toBe('自身')
    expect(Function('return (' + changed.code + ')')()({})).toBe(3)
    expect(() => assertGameplayModuleDocument({ ...changed, description: '获得1点行动点。' })).toThrow('text binding')
  })
  it('rejects missing inputs, runtime guesses, state paths and unsupported target fields', () => {
    const doc = applyGameplayModuleGraph({}, graph())
    expect(() => applyGameplayModuleTextBindings(doc, { description: { template: '{{x}}', values: { x: { entry: 'code', input: 'battle.turn' } } } })).toThrow('missing bound input')
    expect(() => applyGameplayModuleTextBindings(doc, { description: { template: '{{missing}}', values: {} } })).toThrow('unbound placeholder')
    expect(() => applyGameplayModuleTextBindings(doc, { description: { template: '固定文字', values: binding.description.values } })).toThrow('unused')
    expect(() => applyGameplayModuleTextBindings(doc, { code: binding.description } as never)).toThrow('unsupported text field')
    expect(() => applyGameplayModuleTextBindings(doc, { description: { ...binding.description, values: { amount: { entry: 'code', input: 'gain', path: 'G.players' } } } } as never)).toThrow('invalid source')
  })
  it('rejects deleting a text-bound execution input and snapshots caller bindings', () => {
    const source = JSON.parse(JSON.stringify(binding))
    const doc = applyGameplayModuleTextBindings(applyGameplayModuleGraph({}, graph()), source)
    source.description.template = 'changed'
    expect(() => assertGameplayModuleDocument(doc)).not.toThrow()
    expect(() => applyGameplayModuleGraph(doc, { ...graph(), inputs: [], inputBindings: {}, body: [{ kind: 'return', id: 'return', value: { kind: 'literal', value: 0 } }] })).toThrow('missing bound input')
  })
})
