import { rewriteAtomicGraph, type AtomicRecipe } from './atomic-graph-rewrite'
import type { GameplayJsonValue, GameplayModuleGraph, GameplayStatement, GameplayValue } from './module-types'

export const ATOMIC_OPTION_CHOICE_MODULES = new Set([
  'choice.required-option-pair', 'choice.option-pair-cancel', 'choice.binary-option',
  'choice.string-options', 'choice.multi-string',
])
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })

/** Fixed option helpers are ordinary option data passed to one interaction. */
export const atomicOptionChoiceRecipe: AtomicRecipe = (node, fresh) => {
  if (!ATOMIC_OPTION_CHOICE_MODULES.has(node.module)) return undefined
  const p = node.parameters ?? {}
  const inputs: Record<string, GameplayValue> = {}
  const statements: GameplayStatement[] = []
  let options: GameplayJsonValue[]
  if (node.module === 'choice.string-options' || node.module === 'choice.multi-string') {
    if (!Array.isArray(p.options)) throw new Error('Missing option list: ' + node.id)
    const labels = Array.isArray(p.labels) ? p.labels : p.options
    options = p.options.map((value, index) => ({ value, label: labels[index] ?? value }))
    for (const key of ['title', 'selectionMode', 'minSelections', 'maxSelections', 'canCancel']) {
      if (p[key] !== undefined) inputs[key] = literal(p[key])
    }
    if (node.module === 'choice.multi-string') {
      inputs.selectionMode = literal('multi')
      inputs.minSelections ??= literal(1)
      inputs.maxSelections ??= literal(1)
      inputs.canCancel ??= literal(false)
    }
  } else {
    const binary = node.module === 'choice.binary-option'
    const required = node.module === 'choice.required-option-pair'
    const first = binary ? { value: p.yesValue ?? 'yes', label: p.yesLabel } : { value: p.firstValue, label: p.firstLabel }
    const second = binary ? { value: p.noValue ?? 'no', label: p.noLabel } : { value: p.secondValue, label: p.secondLabel }
    if (required) {
      options = [{ id: first.value!, label: first.label! }, { id: second.value!, label: second.label! }]
      inputs.title = node.inputs!.title
    } else {
      options = [first as GameplayJsonValue, second as GameplayJsonValue]
      inputs.title = literal(p.title)
      if (!binary) {
        options = [{ ...first, description: p.firstDescription }, { ...second, description: p.secondDescription }] as GameplayJsonValue[]
      }
      inputs.cancelValue = literal(binary ? p.noValue ?? 'no' : p.cancelValue)
    }
    inputs.canCancel = literal(!required)
    if (binary || required) {
      if (node.inputs?.player) inputs.playerId = node.inputs.player
      else {
        const id = fresh('player')
        // Keep the legacy context.playerId fallback, while normalizing an
        // absent field to nullable null.  The preserve-missing form exposes
        // undefined to choice.options and invalidates an otherwise valid
        // optional-player request.
        statements.push({ kind: 'call', id, module: 'context.field', version: '4', parameters: { field: 'playerId' } })
        inputs.playerId = { kind: 'output', node: id, port: 'value' }
      }
    }
  }
  const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
  let items: GameplayValue = literal([])
  for (const option of options) {
    const empty = fresh('option-record')
    statements.push({ kind: 'call', id: empty, module: 'record.empty', version: '1' })
    let record = out(empty, 'record')
    for (const [key, value] of Object.entries(option as Record<string, GameplayJsonValue>)) {
      const field = fresh('option-field')
      statements.push({ kind: 'call', id: field, module: 'record.set-key', version: '1',
        inputs: { record, key: literal(key), value: literal(value) }, parameters: { valueType: 'string' } })
      record = out(field, 'record')
    }
    const single = fresh('single-option'), concat = fresh('append-option')
    statements.push(
      { kind: 'call', id: single, module: 'collection.singleton', version: '1', inputs: { value: record }, parameters: { valueType: 'record' } },
      { kind: 'call', id: concat, module: 'collection.concat', version: '1', inputs: { left: items, right: out(single, 'items') }, parameters: { valueType: JSON.stringify({ kind: 'list', element: 'record' }) } },
    )
    items = out(concat, 'items')
  }
  inputs.options = items
  const id = fresh('options')
  statements.push({ kind: 'call', id, module: 'choice.options', version: '1', inputs })
  return { statements, outputs: { choice: { kind: 'output', node: id, port: 'choice' } } }
}
export const migrateOptionChoices = (graph: GameplayModuleGraph): GameplayModuleGraph => rewriteAtomicGraph(graph, atomicOptionChoiceRecipe)
