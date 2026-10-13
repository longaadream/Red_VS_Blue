import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayStatement, GameplayValue, GameplayValueType } from './module-types'

export const ATOMIC_STORAGE_READ_MODULES = new Set([
  'extension.read-list', 'extension.read-cell-records', 'extension.read-number', 'extension.read-text', 'record.read-text',
])
const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const list: GameplayValueType = { kind: 'list', element: 'record' }

/** Content-specific storage names remain authored data, not distinct modules. */
export const atomicStorageReadRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_STORAGE_READ_MODULES.has(node.module)) return undefined
  const array = ['extension.read-list', 'extension.read-cell-records'].includes(node.module)
  const type = array ? list : node.module === 'extension.read-number' ? 'number' : 'string'
  const read = fresh('field'), value = fresh('value'), root = fresh('extensions')
  const statements: GameplayStatement[] = []
  if (array) statements.push({ kind: 'call', id: root, module: 'battle.field', version: '5', parameters: { field: 'extensions' } })
  statements.push({ kind: 'call', id: read, module: 'data.read-key', version: '1', inputs: { record: array ? out(root) : node.inputs!.record }, parameters: {
    key: array ? node.parameters?.key ?? node.parameters?.storageKey ?? 'amaterasuCells' : node.parameters!.field,
    valueType: typeof type === 'string' ? type : JSON.stringify(type),
  } } as GameplayCallStatement)
  statements.push({ kind: 'call', id: value, module: 'value.coalesce', version: '1', inputs: { value: out(read), defaultValue: array ? { kind: 'literal', value: [] } : node.inputs!.fallback }, parameters: { valueType: typeof type === 'string' ? type : JSON.stringify(type) } })
  if (node.module === 'extension.read-cell-records') {
    statements.push({ kind: 'call', id: node.id, module: 'extension.records-to-cells', version: '1', inputs: { records: out(value) } })
    return { statements, outputs: { cells: out(node.id, 'cells') } }
  }
  return { statements, outputs: { [array ? 'cells' : 'value']: out(value) } }
}
