import type { AtomicRecipe } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayStatement, GameplayValue } from './module-types'

export const ATOMIC_UNIQUE_SUMMON_MODULES = new Set(['summon.unique-template-available'])
const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const lit = (value: string | null): GameplayValue => ({ kind: 'literal', value })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const nullable = (value: string) => JSON.stringify({ kind: 'nullable', value })

export const atomicUniqueSummonRecipe: AtomicRecipe = (node, fresh) => {
  if (!ATOMIC_UNIQUE_SUMMON_MODULES.has(node.module)) return undefined
  const body: GameplayStatement[] = []
  const push = (module: string, inputs: Record<string, GameplayValue> = {}, parameters?: Record<string, string>, port = 'value', target = body, version = '1'): GameplayValue => {
    const id = fresh(module.replaceAll('.', '-'))
    target.push({ kind: 'call', id, module, version, inputs, ...(parameters ? { parameters } : {}) } as GameplayCallStatement)
    return out(id, port)
  }
  const normalizeOwner = (value: GameplayValue, valueType: string, target = body) => {
    const present = push('value.to-boolean', { value }, { valueType }, 'value', target)
    const text = push('text.from-value', { value }, { valueType }, 'text', target)
    const selected = push('logic.select', { condition: present, whenTrue: text, whenFalse: lit('') }, { valueType: 'string' }, 'value', target, '2')
    const trimmed = push('text.trim', { text: selected }, undefined, 'text', target)
    return push('text.lowercase', { text: trimmed }, undefined, 'text', target)
  }
  const read = (record: GameplayValue, key: string, type: string, target = body) => push('data.read-key', { record }, { key, valueType: nullable(type) }, 'value', target)
  const owner = normalizeOwner(node.inputs!.owner, nullable('player'))
  const extensions = push('battle.extensions', {}, undefined, 'record')
  const scoped = read(extensions, String(node.parameters!.ownerScopedStorageExtensionKey), 'record')
  const scopedRecord = push('data.read-key', { record: scoped, key: owner }, { valueType: nullable('record') })
  const legacy = read(extensions, String(node.parameters!.storageExtensionKey), 'record')
  const legacyOwner = normalizeOwner(read(legacy, 'ownerPlayerId', 'player'), nullable('player'))
  const legacyOwned = push('compare.values', { left: legacyOwner, right: owner }, { valueType: 'string', operator: '==' })
  const selectedLegacy = push('logic.select', { condition: legacyOwned, whenTrue: legacy, whenFalse: lit(null) }, { valueType: nullable('record') }, 'value', body, '2')
  const scopedPresent = push('value.to-boolean', { value: scopedRecord }, { valueType: nullable('record') })
  const legacyPresent = push('value.to-boolean', { value: selectedLegacy }, { valueType: nullable('record') })
  const stored = push('logic.or', { left: scopedPresent, right: legacyPresent })
  const pieces = push('query.pieces', {}, undefined, 'pieces')
  const predicate: GameplayStatement[] = []
  const pieceOwner = push('piece.field', { piece: input('item') }, { field: 'ownerPlayerId' }, 'value', predicate, '2')
  const key = normalizeOwner(pieceOwner, 'player', predicate)
  const sameOwner = push('compare.values', { left: key, right: input('owner') }, { valueType: 'string', operator: '==' }, 'value', predicate)
  const template = push('piece.field', { piece: input('item') }, { field: 'templateId' }, 'value', predicate, '2')
  const id = push('text.from-value', { value: input('item') }, { valueType: 'piece' }, 'text', predicate)
  const sameTemplate = push('compare.values', { left: template, right: lit(String(node.parameters!.templateId)) }, { valueType: 'string', operator: '==' }, 'value', predicate)
  const sameId = push('compare.values', { left: id, right: lit(String(node.parameters!.templateId)) }, { valueType: 'string', operator: '==' }, 'value', predicate)
  const matching = push('logic.or', { left: sameTemplate, right: sameId }, undefined, 'value', predicate)
  const match = push('logic.and', { left: sameOwner, right: matching }, undefined, 'value', predicate)
  predicate.push({ kind: 'return', id: fresh('match'), value: match })
  const exists = fresh('already-on-board')
  body.push({ kind: 'collection', id: exists, method: 'find', items: pieces, inputs: { owner }, body: predicate })
  const absent = push('compare.values', { left: out(exists), right: lit(null) }, { valueType: nullable('piece'), operator: '==' })
  const available = push('logic.or', { left: stored, right: absent })
  return { statements: body, outputs: { available } }
}
