import { describe, expect, it } from 'vitest'
import { repairEventConditionGates } from '../../lib/skill-graph/repair-event-condition-gates'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../../lib/skill-graph/module-types'

const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: boolean): GameplayValue => ({ kind: 'literal', value })
const call = (id: string, module: string, inputs = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs })
const source: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', body: [
  call('before', 'ref.holder'), call('event', 'ref.event-piece'),
  call('same', 'compare.equal-piece', { left: out('before', 'piece'), right: out('event', 'piece') }),
  call('require-same-not', 'logic.not', { value: out('same') }),
  { kind: 'if', id: 'require-same', condition: out('require-same-not'), then: [{ kind: 'return', id: 'failure', values: { success: literal(false) } }] },
  call('apply', 'status.apply-piece', { target: out('before', 'piece') }),
  { kind: 'return', id: 'success', values: { success: literal(true) } },
] }

describe('preserve event conditions after removing reference fallbacks', () => {
  it('places the effect continuation inside the positive event condition', () => {
    const repaired = repairEventConditionGates(source)
    expect(repaired.body.slice(0, 4)).toEqual(source.body.slice(0, 4))
    expect(repaired.body[4]).toEqual({ ...source.body[4], condition: out('same'), then: source.body.slice(5), else: (source.body[4] as Extract<GameplayStatement, { kind: 'if' }>).then })
    expect(repaired.body).toHaveLength(5)
    expect(repairEventConditionGates(repaired)).toEqual(repaired)
  })
  it('preserves unrelated negative conditions, success returns and non-returning branches', () => {
    for (const replacement of [
      { ...source.body[2], inputs: { left: literal(true), right: literal(false) } },
    ]) {
      const edited = { ...source, body: source.body.map((node, index) => index === 2 ? replacement : node) } as GameplayModuleGraph
      expect(repairEventConditionGates(edited)).toEqual(edited)
    }
    for (const then of [[{ kind: 'return', id: 'success', values: { success: literal(true) } }], [call('inspect', 'ref.holder')]] as GameplayStatement[][]) {
      const edited = { ...source, body: source.body.map(node => node.kind === 'if' ? { ...node, then } : node) }
      expect(repairEventConditionGates(edited)).toEqual(edited)
    }
  })
  it('preserves independent outer work and repairs nested event gates', () => {
    const graph: GameplayModuleGraph = { ...source, body: [{ kind: 'if', id: 'outer', condition: literal(true), then: source.body }, call('independent', 'ref.holder')] }
    const repaired = repairEventConditionGates(graph)
    expect(repaired.body[1]).toEqual(graph.body[1])
    expect(repaired.body[0].kind === 'if' && repaired.body[0].then).toEqual(repairEventConditionGates(source).body)
  })
})
