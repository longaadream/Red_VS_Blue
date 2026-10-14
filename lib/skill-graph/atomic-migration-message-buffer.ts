import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayValue } from './module-types'

export const ATOMIC_MESSAGE_BUFFER_MODULES = new Set(['followup.message-buffer-start', 'followup.message-buffer-add', 'followup.message-buffer-read'])
const type = /* @__PURE__ */ JSON.stringify({ kind: 'list', element: 'string' })
const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue>, parameters?: Record<string, string>): GameplayCallStatement => ({ kind: 'call', id, module, version: '1', inputs, ...(parameters ? { parameters } : {}) })

/** Messages are an ordinary local tuple, never an implicit property on the host. */
export const atomicMessageBufferRecipe: AtomicRecipe = (node, fresh, scope): AtomicReplacement | undefined => {
  if (!ATOMIC_MESSAGE_BUFFER_MODULES.has(node.module)) return undefined
  if (node.module === 'followup.message-buffer-start') return {
    statements: [call(node.id, 'local.declare', { initial: { kind: 'literal', value: [] } }, { valueType: type })],
    outputs: { started: out(node.id, 'success') },
  }
  const start = [...(scope?.definitions() ?? [])].reverse().find(entry => entry.kind === 'call' && entry.module === 'followup.message-buffer-start')
  if (!start) throw new Error('Message buffer operation has no preceding declaration: ' + node.id)
  const values = fresh('messages'), count = fresh('count')
  const statements: GameplayCallStatement[] = [call(values, 'local.read', { handle: out(start.id, 'handle') }, { valueType: type })]
  if (node.module === 'followup.message-buffer-add') {
    const item = fresh('message'), appended = fresh('appended')
    statements.push(
      call(item, 'collection.singleton', { value: node.inputs!.message }, { valueType: 'string' }),
      call(appended, 'collection.concat', { left: out(values), right: out(item, 'items') }),
      call(node.id, 'local.write', { handle: out(start.id, 'handle'), value: out(appended, 'items') }, { valueType: type }),
      call(count, 'collection.length', { items: out(appended, 'items') }),
    )
    return { statements, outputs: { count: out(count) } }
  }
  const text = fresh('text')
  statements.push(
    call(text, 'text.join-list', { items: out(values) }, { separator: '；' }),
    call(count, 'collection.length', { items: out(values) }),
    call(node.id, 'local.write', { handle: out(start.id, 'handle'), value: { kind: 'literal', value: [] } }, { valueType: type }),
  )
  return { statements, outputs: { text: out(text, 'text'), count: out(count) } }
}
