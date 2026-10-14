import { importContentGraph } from '../electron-editor/content-graph-import'
import { compileContentGraph, type ContentGraphSurface } from '../electron-editor/content-graph'

/** Recognize the frozen source or its exact compatibility compilation, never arbitrary author edits. */
export function assertFrozenExecutable(current: Record<string, unknown>, original: Record<string, unknown>, field: string, surface: ContentGraphSurface, id: string): void {
  const source = original[field]
  if (typeof source !== 'string' || typeof current[field] !== 'string') throw new Error(`${id}: missing executable ${field}`)
  if (current[field] === source) return
  const graph = importContentGraph(source, surface)
  if (current[field] === compileContentGraph(graph).code) return
  // Earlier imports saved the receiver of array.forEach instead of binding
  // its method. Rebuild that historical artifact from the frozen source only;
  // the candidate must still match the entire executable byte for byte.
  const receivers = new Map<string, { name: string; method: string }>()
  const visitBindings = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visitBindings); return }
    const node = value as Record<string, unknown>, expr = node.expr as Record<string, unknown> | undefined
    if (node.kind === 'bind' && typeof node.name === 'string' && /^__rvb_import_bound_method_\d+$/.test(node.name) && expr?.kind === 'boundMethod' && expr.method === 'forEach') {
      receivers.set(node.name, { name: node.name.replace('_bound_method_', '_operand_'), method: 'forEach' })
    }
    Object.values(node).forEach(visitBindings)
  }
  visitBindings(graph)
  const receiverForm = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(receiverForm)
    if (!value || typeof value !== 'object') return value
    const node = value as Record<string, unknown>
    const renamed = typeof node.name === 'string' ? receivers.get(node.name) : undefined
    if (node.kind === 'bind' && renamed) return { ...node, name: renamed.name, expr: receiverForm((node.expr as Record<string, unknown>).object) }
    const ref = node.value as Record<string, unknown> | undefined
    const target = node.kind === 'function' && ref?.kind === 'ref' && typeof ref.name === 'string' ? receivers.get(ref.name) : undefined
    if (target) return { kind: 'array', object: { kind: 'ref', name: target.name }, method: target.method }
    return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, receiverForm(item)]))
  }
  if (receivers.size && current[field] === compileContentGraph(receiverForm(graph) as typeof graph).code) return
  // The frozen compatibility importer predated lexical binding names. Accept
  // that exact compilation too, only when removing prefixes cannot merge two
  // different bindings. This is a provenance check, never executable rewriting.
  const bindings = new Map<string, string>()
  let collision = false
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if ((key === 'name' || key === 'result') && typeof item === 'string') {
        const match = /^__rvb_lexical_\d+_(.+)$/.exec(item)
        if (match) {
          if (bindings.has(match[1]) && bindings.get(match[1]) !== item) collision = true
          bindings.set(match[1], item)
          return [key, match[1]]
        }
      }
      return [key, normalize(item)]
    }))
  }
  const legacyGraph = normalize(graph) as typeof graph
  if (!collision && bindings.size) {
    try {
      if (current[field] === compileContentGraph(legacyGraph).code) return
    } catch (cause) {
      throw new Error(`${id}: author executable differs from frozen baseline: ${field}; legacy binding compilation failed`, { cause })
    }
  }
  throw new Error(`${id}: author executable differs from frozen baseline: ${field}`)
}
