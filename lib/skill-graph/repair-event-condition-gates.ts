import type { GameplayModuleGraph, GameplayStatement } from './module-types'

const EVENT_REFERENCES = new Set(['ref.event-piece', 'ref.source', 'ref.target', 'ref.event-player'])

/**
 * Legacy recipes emitted `if (!eventCondition) return failure; effect...`.
 * Once absent references propagate invalid values, skipping that negative if
 * must not accidentally authorize its effects. Express the actual gameplay
 * condition positively, so its continuation keeps the same control dependency.
 * This only recognizes the generated `<branch>-not` + scalar failure pattern;
 * ordinary independent statements and authored non-returning branches stay put.
 */
export function repairEventConditionGates(graph: GameplayModuleGraph): GameplayModuleGraph {
  function depends(value: unknown, nodes: ReadonlySet<string>): boolean {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(item => depends(item, nodes))
    const item = value as Record<string, unknown>
    if (item.kind === 'literal') return false
    if (item.kind === 'output') return typeof item.node === 'string' && nodes.has(item.node)
    return Object.values(item).some(child => depends(child, nodes))
  }
  function body(statements: readonly GameplayStatement[], inherited: ReadonlySet<string> = new Set()): GameplayStatement[] {
    const nodes = new Set(inherited)
    const result: GameplayStatement[] = []
    for (let index = 0; index < statements.length; index++) {
      const node = statements[index]
      nodes.delete(node.id)
      if (node.kind === 'call' && (EVENT_REFERENCES.has(node.module)
        || node.module === 'context.field' && ['sourcePiece', 'targetPiece', 'piece', 'playerId'].includes(String(node.parameters?.field))
        || depends(node.inputs, nodes))) nodes.add(node.id)
      else if (node.kind !== 'call' && depends(node, nodes)) nodes.add(node.id)

      const branch = statements[index + 1]
      const failure = branch?.kind === 'if' && branch.then.length === 1 ? branch.then[0] : undefined
      if (node.kind === 'call' && node.module === 'logic.not' && node.version === '1'
        && branch?.kind === 'if' && node.id === branch.id + '-not'
        && branch.condition.kind === 'output' && branch.condition.node === node.id && branch.condition.port === 'value'
        && !branch.else?.length && node.inputs?.value && depends(node.inputs.value, nodes)
        && failure?.kind === 'return' && failure.values?.success?.kind === 'literal' && failure.values.success.value === false
        && Object.values(failure.values).every(value => value.kind === 'literal')
        && index + 2 < statements.length) {
        // Retain the pure negation: author-added references to its result remain valid.
        result.push(node, { ...branch, condition: node.inputs.value,
          then: body(statements.slice(index + 2), nodes), else: branch.then })
        return result
      }
      if (node.kind === 'if') result.push({ ...node, then: body(node.then, nodes), ...(node.else ? { else: body(node.else, nodes) } : {}) })
      else if (node.kind === 'foreach') result.push({ ...node, body: body(node.body, nodes) })
      else if (node.kind === 'while') result.push({ ...node, condition: { ...node.condition, body: body(node.condition.body) }, body: body(node.body, nodes) })
      else if (node.kind === 'collection' || node.kind.startsWith('collection.')) {
        // Collection callbacks have explicit captures and a separate lexical scope.
        result.push('body' in node ? { ...node, body: body(node.body) } : node)
      } else result.push(node)
    }
    return result
  }
  return { ...graph, body: body(graph.body),
    ...(graph.composites ? { composites: graph.composites.map(composite => ({ ...composite, body: body(composite.body) })) } : {}),
    ...(graph.continuations ? { continuations: graph.continuations.map(continuation => ({ ...continuation, graph: repairEventConditionGates(continuation.graph) })) } : {}),
  }
}
