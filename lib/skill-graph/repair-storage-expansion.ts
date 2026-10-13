import { isDeepStrictEqual } from 'node:util'
import type { GameplayModuleGraph, GameplayStatement, GameplayValue } from './module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const nullablePlayer = JSON.stringify({ kind: 'nullable', value: 'player' })
const literal = (value: null): GameplayValue => ({ kind: 'literal', value })

/** Repair only the exact first storage expansion, preserving all surrounding author edits. */
export function repairStorageExpansion(graph: GameplayModuleGraph): GameplayModuleGraph {
  // A removed intermediate result may have become useful to the author after
  // migration. In that case preserve the entire block rather than guessing.
  function externallyUsed(block: readonly GameplayStatement[], removed: Set<string>, allowed?: string): boolean {
    const excluded = new Set<unknown>(block)
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== 'object' || excluded.has(value)) return false
      if (Array.isArray(value)) return value.some(visit)
      const record = value as Record<string, unknown>
      if (record.kind === 'literal') return false
      if (typeof record.id === 'string' && removed.has(record.id)) return true
      if (record.kind === 'output' && typeof record.node === 'string' && removed.has(record.node)) {
        return record.node !== allowed || record.port !== 'value'
      }
      return Object.values(record).some(visit)
    }
    return visit(graph)
  }
  function refs<T>(value: T, renamed: Map<string, GameplayValue>): T {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(item => refs(item, renamed)) as T
    const record = value as Record<string, unknown>
    if (record.kind === 'literal') return value
    if (record.kind === 'output' && typeof record.node === 'string' && record.port === 'value' && renamed.has(record.node)) return renamed.get(record.node) as T
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, refs(item, renamed)])) as T
  }
  const call = (node: GameplayStatement | undefined, module: string) => node?.kind === 'call' && node.module === module ? node : undefined
  function body(nodes: readonly GameplayStatement[], inherited = new Map<string, GameplayValue>()): GameplayStatement[] {
    const renamed = new Map(inherited)
    const result: GameplayStatement[] = []
    for (let index = 0; index < nodes.length; index++) {
      const original = nodes[index]
      const node = refs(original, renamed)
      renamed.delete(node.id)
      const declare = call(node, 'extension.declare-battle')
      if (declare?.version === '2' && declare.parameters?.namespace === '' && declare.parameters?.name === 'amaterasuOwnerPlayerId' && declare.id.endsWith('--owner') && declare.inputs?.value.kind === 'literal' && declare.inputs.value.value === null) {
        const id = declare.id.slice(0, -'--owner'.length)
        const compare = call(nodes[index + 1], 'compare.values'), branch = nodes[index + 2]
        const write = branch?.kind === 'if' && branch.then.length === 1 ? call(branch.then[0], 'extension.write-battle') : undefined
        const parameters = { namespace: '', name: 'amaterasuOwnerPlayerId', valueType: nullablePlayer }
        const expected = [
          { kind: 'call', id: id + '--owner', module: 'extension.declare-battle', version: '2', inputs: { value: literal(null) }, parameters },
          { kind: 'call', id: id + '--empty', module: 'compare.values', version: '1', inputs: { left: output(id + '--owner'), right: literal(null) }, parameters: { valueType: nullablePlayer, operator: '==' } },
          { kind: 'if', id: id + '--assign-if-empty', condition: output(id + '--empty'), then: [
            { kind: 'call', id: id + '--write-owner', module: 'extension.write-battle', version: '2', inputs: { value: write?.inputs?.value }, parameters },
          ] },
        ]
        const block = nodes.slice(index, index + 3)
        if (compare && write?.inputs?.value && isDeepStrictEqual(block, expected) && !externallyUsed(block, new Set([id, id + '--owner', id + '--empty', id + '--write-owner']))) {
          result.push({ kind: 'call', id, module: 'extension.set-owner-if-empty', version: '1', inputs: { player: refs(write.inputs.value, renamed) }, parameters: { storageKey: declare.parameters!.name } })
          index += 2
          continue
        }
      }
      const owner = call(node, 'text.from-value')
      if (owner?.id.endsWith('--owner-key')) {
        const id = owner.id.slice(0, -'--owner-key'.length)
        const path = call(nodes[index + 1], 'collection.singleton'), root = call(nodes[index + 2], 'extension.read-battle')
        const omit = call(nodes[index + 3], 'data.omit-key'), write = call(nodes[index + 4], 'extension.write-battle'), committed = call(nodes[index + 5], 'value.to-boolean')
        const parameters = { namespace: '', name: 'coltZones', valueType: 'record' }
        const expected = [
          { kind: 'call', id: id + '--owner-key', module: 'text.from-value', version: '1', inputs: { value: call(original, 'text.from-value')?.inputs?.value }, parameters: { valueType: 'piece' } },
          { kind: 'call', id: id + '--owner-path', module: 'collection.singleton', version: '1', inputs: { value: output(id + '--owner-key', 'text') }, parameters: { valueType: 'string' } },
          { kind: 'call', id: id + '--records', module: 'extension.read-battle', version: '2', parameters },
          { kind: 'call', id: id + '--remaining-records', module: 'data.omit-key', version: '1', inputs: { record: output(id + '--records'), key: output(id + '--owner-key', 'text') } },
          { kind: 'call', id, module: 'extension.write-battle', version: '2', inputs: { value: output(id + '--remaining-records') }, parameters },
        ]
        const expectedCommitted = { kind: 'call', id: id + '--committed', module: 'value.to-boolean', version: '1', inputs: { value: output(id) }, parameters: { valueType: 'record' } }
        const hasCommitted = isDeepStrictEqual(committed, expectedCommitted)
        const block = nodes.slice(index, index + (hasCommitted ? 6 : 5))
        const removed = new Set([id + '--owner-key', id + '--owner-path', id + '--records', id + '--remaining-records', id, ...(hasCommitted ? [id + '--committed'] : [])])
        if (path && root && omit && write && owner.inputs?.value && isDeepStrictEqual(block, hasCommitted ? [...expected, expectedCommitted] : expected) && !externallyUsed(block, removed, hasCommitted ? id + '--committed' : undefined)) {
          result.push({ kind: 'call', id, module: 'extension.remove-owner-record', version: '1', inputs: { owner: owner.inputs!.value }, parameters: { key: root.parameters!.name } })
          if (hasCommitted) renamed.set(id + '--committed', { kind: 'output', node: id, port: 'success' })
          index += block.length - 1
          continue
        }
      }
      if (node.kind === 'if' && original.kind === 'if') result.push({ ...node, then: body(original.then, renamed), ...(original.else ? { else: body(original.else, renamed) } : {}) })
      else if (node.kind === 'foreach' && original.kind === 'foreach') result.push({ ...node, body: body(original.body, renamed) })
      else if (node.kind === 'while' && original.kind === 'while') result.push({ ...node, condition: { ...node.condition, body: body(original.condition.body) }, body: body(original.body, renamed) })
      else if (node.kind === 'collection' && original.kind === 'collection') result.push({ ...node, body: body(original.body) })
      else result.push(node)
    }
    return result
  }
  return { ...graph, body: body(graph.body), ...(graph.composites ? { composites: graph.composites.map(composite => ({ ...composite, body: body(composite.body) })) } : {}), ...(graph.continuations ? { continuations: graph.continuations.map(continuation => ({ ...continuation, graph: repairStorageExpansion(continuation.graph) })) } : {}) }
}
