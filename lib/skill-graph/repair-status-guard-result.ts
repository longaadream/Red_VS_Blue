import type { GameplayModuleGraph, GameplayStatement } from './module-types'

/** An inactive guard is a valid negative result, not a missing output dependency. */
export function repairStatusGuardResult(graph: GameplayModuleGraph): GameplayModuleGraph {
  function body(nodes: readonly GameplayStatement[]): GameplayStatement[] {
    return nodes.map(node => {
      if (node.kind === 'return' && node.values?.success?.kind === 'literal' && node.values.success.value === false && !Object.hasOwn(node.values, 'blocked')) return { ...node, values: { ...node.values, blocked: { kind: 'literal', value: false } } }
      if (node.kind === 'if') return { ...node, then: body(node.then), ...(node.else ? { else: body(node.else) } : {}) }
      return node
    })
  }
  return { ...graph, ...(graph.composites ? { composites: graph.composites.map(composite => composite.id === 'shared.status-event-guard' && composite.outputs.some(port => port.name === 'blocked' && port.type === 'boolean') ? { ...composite, body: body(composite.body) } : composite) } : {}), ...(graph.continuations ? { continuations: graph.continuations.map(continuation => ({ ...continuation, graph: repairStatusGuardResult(continuation.graph) })) } : {}) }
}
