import { describe, expect, it } from 'vitest'
import { lowerAuthorExpression } from '../../lib/skill-graph/author-expression-graph'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makeState } from '../helpers/minimal-state'
import type { GameplayModuleGraph } from '../../lib/skill-graph/module-types'

describe('named author variables', () => {
  it('reads the current local value each time an expression is evaluated after assignment', () => {
    const local = { value: { kind: 'output', node: 'declare', port: 'handle' } as const, type: 'number' as const, local: true }
    const first = lowerAuthorExpression('amount * 2', { surface: 'skill', bindings: { amount: local }, prefix: 'before' })
    const second = lowerAuthorExpression('amount * 2', { surface: 'skill', bindings: { amount: local }, prefix: 'after' })
    const graph: GameplayModuleGraph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'before', type: 'number' }, { name: 'after', type: 'number' }], body: [
      { kind: 'call', id: 'declare', module: 'local.declare', version: '2', parameters: { name: 'amount', valueType: 'number' }, inputs: { initial: { kind: 'literal', value: 3 } } },
      ...first.statements,
      { kind: 'call', id: 'assign', module: 'local.write', version: '1', parameters: { valueType: 'number' }, inputs: { handle: local.value, value: { kind: 'literal', value: 5 } } },
      ...second.statements,
      { kind: 'return', id: 'done', values: { before: first.value, after: second.value } },
    ] }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const battle = makeState(), context = {}, flow = createFlowRuntime(battle, context, 'skill', {})
    expect(Function('flow', 'context', `return (${compiled.code})(context)`)(flow, context)).toEqual({ before: 6, after: 10 })
  })
})
