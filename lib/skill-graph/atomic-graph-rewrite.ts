import type { GameplayCallStatement, GameplayModuleGraph, GameplayStatement, GameplayValue } from './module-types'

export type AtomicReplacement = {
  statements: readonly GameplayStatement[]
  outputs?: Readonly<Record<string, GameplayValue>>
}
export type AtomicRecipe = (call: GameplayCallStatement, fresh: (suffix: string) => string, scope?: { getDefinition(id: string): GameplayStatement | undefined; definitions(): readonly GameplayStatement[] }) => AtomicReplacement | undefined

/** Rewrite author ASTs, preserving lexical scope and every unrelated JSON field. */
export function rewriteAtomicGraph(graph: GameplayModuleGraph, recipe: AtomicRecipe): GameplayModuleGraph {
  const ids = new Set<string>()
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(collect); return }
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string') ids.add(record.id)
    Object.values(record).forEach(collect)
  }
  collect(graph)
  type Bindings = Map<string, Readonly<Record<string, GameplayValue>>>
  function refs<T>(value: T, bindings: Bindings): T {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(item => refs(item, bindings)) as T
    const record = value as Record<string, unknown>
    // Literal payloads and schemas are data, not author references.
    if (record.kind === 'literal') return value
    if (record.kind === 'output' && typeof record.node === 'string' && typeof record.port === 'string') {
      return (bindings.get(record.node)?.[record.port] ?? value) as T
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, refs(item, bindings)])) as T
  }
  function body(statements: readonly GameplayStatement[], inherited: Bindings, inheritedDefinitions = new Map<string, GameplayStatement>()): GameplayStatement[] {
    const bindings = new Map(inherited)
    const definitions = new Map(inheritedDefinitions)
    const result: GameplayStatement[] = []
    for (const original of statements) {
      // A collection/while condition explicitly captures inputs; its locals
      // must never inherit a same-named output mapping from an outer scope.
      let node = refs(original, bindings)
      if (original.kind === 'if') node = { ...node, then: body(original.then, bindings, definitions), ...(original.else ? { else: body(original.else, bindings, definitions) } : {}) } as GameplayStatement
      else if (original.kind === 'foreach') node = { ...node, body: body(original.body, bindings, definitions) } as GameplayStatement
      else if (original.kind === 'while') node = { ...node, condition: { ...original.condition, inputs: refs(original.condition.inputs, bindings), body: body(original.condition.body, new Map()) }, body: body(original.body, bindings, definitions) } as GameplayStatement
      else if (original.kind === 'collection' || original.kind.startsWith('collection.')) {
        const collection = original as Extract<GameplayStatement, {kind: 'collection'}>
        node = { ...node, body: body(collection.body, new Map()) } as GameplayStatement
      }
      // The old binding is shadowed only after the new statement's inputs.
      bindings.delete(original.id)
      const scope = { getDefinition: (id: string) => definitions.get(id), definitions: () => [...definitions.values()] }
      if (node.kind !== 'call') { definitions.set(node.id, node); result.push(node); continue }
      const fresh = (suffix: string): string => {
        const base = node.id + '--' + suffix
        let id = base, index = 2
        while (ids.has(id)) id = base + '-' + index++
        ids.add(id)
        return id
      }
      const replacement = recipe(node, fresh, scope)
      definitions.set(node.id, node)
      if (replacement) for (const statement of replacement.statements) if (!definitions.has(statement.id)) definitions.set(statement.id, statement)
      if (!replacement) { result.push(node); continue }
      result.push(...replacement.statements)
      if (replacement.outputs) bindings.set(node.id, replacement.outputs)
    }
    return result
  }
  return {
    ...graph,
    body: body(graph.body, new Map()),
    ...(graph.composites ? { composites: graph.composites.map(composite => ({ ...composite, body: body(composite.body, new Map()) })) } : {}),
    ...(graph.continuations ? { continuations: graph.continuations.map(continuation => ({ ...continuation, graph: rewriteAtomicGraph(continuation.graph, recipe) })) } : {}),
  }
}
