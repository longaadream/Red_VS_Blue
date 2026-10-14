import { expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicMessageBufferRecipe } from '../../lib/skill-graph/atomic-migration-message-buffer'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makeState } from '../helpers/minimal-state'

it('composes scoped message accumulation from a local tuple and ordinary text operations', () => {
  for (const items of [[], ['伤害1'], ['伤害1', '', '伤害2']]) {
    const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'text', type: 'string' }, { name: 'count', type: 'number' }], body: [
      { kind: 'call', id: 'start', module: 'followup.message-buffer-start', version: '1' },
      { kind: 'foreach', id: 'each', items: { kind: 'literal', value: items }, item: 'message', body: [
        { kind: 'call', id: 'append', module: 'followup.message-buffer-add', version: '1', inputs: { message: { kind: 'input', name: 'message' } } },
      ] },
      { kind: 'call', id: 'read', module: 'followup.message-buffer-read', version: '1' },
      { kind: 'return', id: 'done', values: { text: { kind: 'output', node: 'read', port: 'text' }, count: { kind: 'output', node: 'read', port: 'count' } } },
    ] }
    const migrated = rewriteAtomicGraph(graph, atomicMessageBufferRecipe)
    const execute = (source: GameplayModuleGraph) => {
      const battle = makeState(), context = {}
      const flow = createFlowRuntime(battle, context, 'skill', {})
      const code = compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY).code
      const value = new Function('flow', 'battle', 'return (' + code + ')')(flow, battle)(context)
      expect(context).not.toHaveProperty('__rvbFollowupMessages')
      return value
    }
    expect(execute(migrated)).toEqual(execute(graph))
    expect(execute(migrated)).toEqual({ text: items.join('；'), count: items.length })
    expect(rewriteAtomicGraph(migrated, atomicMessageBufferRecipe)).toEqual(migrated)
  }
})

it('refuses an unbound implicit buffer rather than creating hidden host state', () => {
  const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
    { kind: 'call', id: 'read', module: 'followup.message-buffer-read', version: '1' },
  ] }
  expect(() => rewriteAtomicGraph(graph, atomicMessageBufferRecipe)).toThrow('no preceding declaration')
})
