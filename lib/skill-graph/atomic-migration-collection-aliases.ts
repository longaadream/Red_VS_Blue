import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayValue } from './module-types'

export const ATOMIC_COLLECTION_ALIASES = new Set(['query.random-string', 'query.random-item', 'query.random-cell', 'list.sort-string', 'list.sort-pieces'])
const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

/** Collection element type follows the input instead of naming a separate module per type. */
export const atomicCollectionAliasRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_COLLECTION_ALIASES.has(node.module)) return undefined
  const items = node.inputs!.items
  if (node.module.startsWith('query.random-')) {
    const port = node.module === 'query.random-string' ? 'value' : node.module === 'query.random-cell' ? 'cell' : 'item'
    return { statements: [{ ...node, module: 'collection.random', version: '1', inputs: { items }, parameters: {} }], outputs: { [port]: out(node.id) } }
  }
  if (node.module === 'list.sort-string') return { statements: [{ ...node, module: 'collection.sort', version: '2', inputs: { items, keys: items }, parameters: { comparison: 'text', order: 'ascending' } }], outputs: { sorted: out(node.id, 'items') } }
  const keys = fresh('sort-keys'), key = fresh('sort-key')
  return { statements: [
    { kind: 'collection', id: keys, method: 'map', items, item: 'item', body: [
      { kind: 'call', id: key, module: 'text.from-value', version: '1', inputs: { value: { kind: 'input', name: 'item' } }, parameters: { valueType: 'piece' } },
      { kind: 'return', id: fresh('key'), value: out(key, 'text') },
    ] },
    { ...node, module: 'collection.sort', version: '2', inputs: { items, keys: out(keys) }, parameters: { comparison: 'locale', order: 'ascending' } },
  ], outputs: { sorted: out(node.id, 'items') } }
}
