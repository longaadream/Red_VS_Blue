import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayJsonValue, GameplayStatement, GameplayValue } from './module-types'

export const ATOMIC_CARD_WRITE_MODULES = new Set(['card.set-presentation', 'card.set-effect-modifier', 'card.set-content-record', 'card.clear-content-field', 'card.clear-content-records', 'card.bind-latest-unbound', 'card.set-content-boolean'])
const lit = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port = 'record'): GameplayValue => ({ kind: 'output', node, port })

export const atomicCardWriteRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_CARD_WRITE_MODULES.has(node.module)) return undefined
  if (node.module === 'card.set-content-boolean') return { statements: [{ ...node, module: 'card.write-field', inputs: { ...node.inputs, value: lit(true) }, parameters: { field: 'contentState', subfield: node.parameters!.field, valueType: 'boolean' } }] }
  if (node.module === 'card.bind-latest-unbound') {
    const hand = fresh('hand'), reverse = fresh('reverse'), selected = fresh('selected'), definition = fresh('definition'), bound = fresh('bound'), wanted = fresh('wanted'), unbound = fresh('unbound'), matches = fresh('matches'), id = fresh('id'), safeId = fresh('id-or-empty'), write = fresh('bind')
    const item: GameplayValue = { kind: 'input', name: 'item' }
    return { statements: [
      { kind: 'call', id: hand, module: 'card.hand-records', version: '1', inputs: { player: node.inputs!.player } },
      { kind: 'call', id: reverse, module: 'collection.reverse', version: '1', inputs: { items: out(hand, 'cards') } },
      { kind: 'collection', id: selected, method: 'find', items: out(reverse, 'items'), item: 'item', body: [
        { kind: 'call', id: definition, module: 'card.instance-field', version: '1', inputs: { card: item }, parameters: { field: 'cardId' } },
        { kind: 'call', id: wanted, module: 'compare.values', version: '1', inputs: { left: out(definition, 'value'), right: lit(node.parameters!.cardId) }, parameters: { valueType: 'string', operator: '==' } },
        { kind: 'call', id: bound, module: 'card.instance-field', version: '1', inputs: { card: item }, parameters: { field: 'boundPieceInstanceId' } },
        { kind: 'call', id: unbound, module: 'compare.values', version: '1', inputs: { left: out(bound, 'value'), right: lit(null) }, parameters: { valueType: JSON.stringify({ kind: 'nullable', value: 'piece' }), operator: '==' } },
        { kind: 'call', id: matches, module: 'logic.and', version: '1', inputs: { left: out(wanted, 'value'), right: out(unbound, 'value') } },
        { kind: 'return', id: fresh('match'), value: out(matches, 'value') },
      ] },
      { kind: 'call', id, module: 'card.instance-field', version: '1', inputs: { card: out(selected, 'value') }, parameters: { field: 'instanceId' } },
      { kind: 'call', id: safeId, module: 'value.coalesce', version: '1', inputs: { value: out(id, 'value'), defaultValue: lit('') }, parameters: { valueType: 'string' } },
      { kind: 'call', id: write, module: 'card.write-field', version: '1', inputs: { player: node.inputs!.player, card: out(safeId, 'value'), value: node.inputs!.piece }, parameters: { field: 'boundPieceInstanceId', valueType: 'piece' } },
    ], outputs: { success: out(write, 'success') } }
  }
  if (node.module === 'card.clear-content-field') return { statements: [{ ...node, module: 'card.remove-field', parameters: { field: 'contentState', subfield: node.parameters!.field } }] }
  if (node.module === 'card.clear-content-records') {
    const hand = fresh('hand'), source = fresh('source'), matches = fresh('matches'), state = fresh('state'), content = fresh('content'), owner = fresh('source-id'), same = fresh('same-source'), cardId = fresh('card-id'), count = fresh('count')
    const item: GameplayValue = { kind: 'input', name: 'item' }
    return { statements: [
      { kind: 'call', id: hand, module: 'card.hand-records', version: '1', inputs: { player: node.inputs!.player } },
      { kind: 'call', id: source, module: 'piece.identifier', version: '1', inputs: { piece: node.inputs!.source } },
      { kind: 'collection', id: matches, method: 'filter', items: out(hand, 'cards'), item: 'item', inputs: { source: out(source, 'id') }, body: [
        { kind: 'call', id: state, module: 'card.instance-field', version: '1', inputs: { card: item }, parameters: { field: 'contentState' } },
        { kind: 'call', id: content, module: 'data.read-key', version: '1', inputs: { record: out(state, 'value') }, parameters: { key: node.parameters!.field, valueType: 'record' } },
        { kind: 'call', id: owner, module: 'data.read-key', version: '1', inputs: { record: out(content, 'value') }, parameters: { key: 'sourcePieceId', valueType: 'string' } },
        { kind: 'call', id: same, module: 'compare.values', version: '1', inputs: { left: out(owner, 'value'), right: { kind: 'input', name: 'source' } }, parameters: { valueType: JSON.stringify({ kind: 'nullable', value: 'string' }), operator: '==' } },
        { kind: 'return', id: fresh('matches-return'), value: out(same, 'value') },
      ] },
      { kind: 'foreach', id: fresh('each'), items: out(matches, 'value'), item: 'item', body: [
        { kind: 'call', id: cardId, module: 'card.instance-field', version: '1', inputs: { card: item }, parameters: { field: 'instanceId' } },
        { kind: 'call', id: fresh('remove'), module: 'card.remove-field', version: '1', inputs: { player: node.inputs!.player, card: out(cardId, 'value') }, parameters: { field: 'contentState', subfield: node.parameters!.field } },
      ] },
      { kind: 'call', id: count, module: 'collection.length', version: '1', inputs: { items: out(matches, 'value') } },
    ], outputs: { count: out(count, 'value') } }
  }
  const statements: GameplayStatement[] = []
  const empty = fresh('record')
  statements.push({ kind: 'call', id: empty, module: 'record.empty', version: '1' })
  let record = out(empty)
  const p = node.parameters ?? {}
  const fields = node.module === 'card.set-presentation' ? ['variant', 'badge', 'description']
    : node.module === 'card.set-content-record' ? ['sourcePieceId', 'createdTurnNumber']
      : ['effect', 'operation', 'value', ...(p.statusType === undefined ? [] : ['statusType'])]
  for (const field of fields) {
    let value = lit(p[field])
    const valueType = field === 'value' || field === 'createdTurnNumber' ? 'number' : 'string'
    if (node.module === 'card.set-content-record') {
      const read = fresh('read-field')
      statements.push({ kind: 'record.get', id: read, record: node.inputs!.record, field })
      value = out(read, 'value')
    }
    const write = fresh('field')
    statements.push({ kind: 'call', id: write, module: 'record.set-key', version: '1', inputs: { record, key: lit(field), value }, parameters: { valueType } })
    record = out(write)
  }
  const modifiers = node.module === 'card.set-effect-modifier'
  if (modifiers) {
    const single = fresh('modifiers')
    statements.push({ kind: 'call', id: single, module: 'collection.singleton', version: '1', inputs: { value: record }, parameters: { valueType: 'record' } })
    record = out(single, 'items')
  }
  const write = fresh('write')
  statements.push({ kind: 'call', id: write, module: 'card.write-field', version: '1', inputs: { player: node.inputs!.player, card: node.inputs!.card, value: record },
    parameters: { field: modifiers ? 'effectModifiers' : node.module === 'card.set-presentation' ? 'presentation' : 'contentState',
      valueType: modifiers ? JSON.stringify({ kind: 'list', element: 'record' }) : 'record',
      ...(node.module === 'card.set-content-record' ? { subfield: p.field } : {}) } })
  return { statements, outputs: { success: out(write, 'success') } }
}
