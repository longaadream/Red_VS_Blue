import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayValue } from './module-types'

export const ATOMIC_MISC_VALUE_MODULES = new Set([
  'value.string-or-empty', 'value.coalesce-record', 'query.piece-names',
  'projectile.event-kind', 'projectile.event-distance', 'projectile.event-blocks', 'projectile.event-piece',
  'collection.live-piece-count',
  'query.lowest-hp', 'projectile.distance-multiplier',
  'spatial.cell-coordinates-safe',
  'player.display-name',
  'effect.teleport-with-change',
])
const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
export const atomicMiscValuesRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_MISC_VALUE_MODULES.has(node.module)) return undefined
  const inputs = node.inputs || {}
  if (node.module === 'effect.teleport-with-change') {
    const moved = fresh('move'), changes = fresh('changes'), items = fresh('changes-or-empty'), length = fresh('change-count'), changed = fresh('changed')
    const listType = JSON.stringify({ kind: 'list', element: 'record' })
    return { statements: [
      { ...node, id: moved, module: 'effect.teleport' },
      { kind: 'call', id: changes, module: 'data.read-key', version: '1', inputs: { record: out(moved, 'result') }, parameters: { key: 'changes', valueType: listType } },
      { kind: 'call', id: items, module: 'value.coalesce', version: '1', inputs: { value: out(changes), defaultValue: { kind: 'literal', value: [] } }, parameters: { valueType: listType } },
      { kind: 'call', id: length, module: 'collection.length', version: '1', inputs: { items: out(items) } },
      { kind: 'call', id: changed, module: 'compare.values', version: '1', inputs: { left: out(length), right: { kind: 'literal', value: 0 } }, parameters: { valueType: 'number', operator: '!=' } },
    ], outputs: { result: out(moved, 'result'), success: out(moved, 'success'), changed: out(changed) } }
  }
  if (node.module === 'player.display-name') {
    const players = fresh('players'), validated = fresh('player'), requested = fresh('requested-text'), candidate = fresh('candidate-text'), selected = fresh('selected'), matches = fresh('matches'), names = fresh('names'), name = fresh('name'), hasName = fresh('has-name'), idText = fresh('id-text'), text = fresh('text'), first = fresh('first')
    return { statements: [
      { kind: 'call', id: players, module: 'query.players', version: '1' },
      { kind: 'call', id: validated, module: 'query.player', version: '1', inputs: { playerId: inputs.player } },
      { kind: 'call', id: requested, module: 'text.from-value', version: '1', inputs: { value: out(validated, 'player') }, parameters: { valueType: JSON.stringify({ kind: 'nullable', value: 'player' }) } },
      { kind: 'collection', id: selected, method: 'filter', items: out(players, 'players'), item: 'player', inputs: { requested: out(requested, 'text') }, body: [
        { kind: 'call', id: candidate, module: 'text.from-value', version: '1', inputs: { value: { kind: 'input', name: 'player' } }, parameters: { valueType: 'player' } },
        { kind: 'call', id: matches, module: 'compare.values', version: '1', inputs: { left: out(candidate, 'text'), right: { kind: 'input', name: 'requested' } }, parameters: { valueType: 'string', operator: '==' } },
        { kind: 'return', id: fresh('matches-result'), value: out(matches) },
      ] },
      { kind: 'collection', id: names, method: 'map', items: out(selected), item: 'player', body: [
        { kind: 'call', id: name, module: 'player.field', version: '1', inputs: { player: { kind: 'input', name: 'player' } }, parameters: { field: 'name' } },
        { kind: 'call', id: hasName, module: 'value.to-boolean', version: '1', inputs: { value: out(name) }, parameters: { valueType: 'string' } },
        { kind: 'call', id: idText, module: 'text.from-value', version: '1', inputs: { value: { kind: 'input', name: 'player' } }, parameters: { valueType: 'player' } },
        { kind: 'call', id: text, module: 'logic.select', version: '2', inputs: { condition: out(hasName), whenTrue: out(name), whenFalse: out(idText, 'text') }, parameters: { valueType: 'string' } },
        { kind: 'return', id: fresh('name-result'), value: out(text) },
      ] },
      { kind: 'collection', id: first, method: 'find', items: out(names), item: 'name', body: [{ kind: 'return', id: fresh('first-result'), value: { kind: 'literal', value: true } }] },
      { ...node, module: 'value.coalesce', version: '1', inputs: { value: out(first), defaultValue: { kind: 'literal', value: '' } }, parameters: { valueType: 'string' } },
    ], outputs: { text: out(node.id) } }
  }
  if (node.module === 'spatial.cell-coordinates-safe') {
    const origin = fresh('origin'), cell = fresh('cell')
    return { statements: [
      { kind: 'call', id: origin, module: 'spatial.cell', version: '1', inputs: { x: { kind: 'literal', value: 0 }, y: { kind: 'literal', value: 0 } } },
      { kind: 'call', id: cell, module: 'value.coalesce', version: '1', inputs: { value: inputs.cell, defaultValue: out(origin, 'cell') }, parameters: { valueType: 'cell' } },
      { ...node, module: 'spatial.cell-coordinates', version: '1', inputs: { cell: out(cell) }, parameters: {} },
    ] }
  }
  if (node.module === 'projectile.distance-multiplier') {
    const values = node.parameters?.values
    if (!Array.isArray(values) || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) return undefined
    const distance = fresh('distance'), index = fresh('index'), found = fresh('entry'), same = fresh('same-index')
    return { statements: [
      { kind: 'call', id: distance, module: 'math.floor', version: '1', inputs: { value: inputs.distance } },
      { kind: 'call', id: index, module: 'math.subtract', version: '1', inputs: { left: out(distance), right: { kind: 'literal', value: 1 } } },
      { kind: 'collection', id: found, method: 'find', items: { kind: 'literal', value: values }, item: 'item', index: 'index', inputs: { requestedIndex: out(index) }, body: [
        { kind: 'call', id: same, module: 'compare.values', version: '1', inputs: { left: { kind: 'input', name: 'index' }, right: { kind: 'input', name: 'requestedIndex' } }, parameters: { valueType: 'number', operator: '==' } },
        { kind: 'return', id: fresh('index-result'), value: out(same) },
      ] },
      { ...node, module: 'value.coalesce', version: '1', inputs: { value: out(found), defaultValue: { kind: 'literal', value: 0 } }, parameters: { valueType: 'number' } },
    ] }
  }
  if (node.module === 'query.lowest-hp') {
    const keys = fresh('health-values'), hp = fresh('hp'), sorted = fresh('sorted')
    return { statements: [
      { kind: 'collection', id: keys, method: 'map', items: inputs.pieces, item: 'item', body: [
        { kind: 'call', id: hp, module: 'piece.field', version: '1', inputs: { piece: { kind: 'input', name: 'item' } }, parameters: { field: 'currentHp' } },
        { kind: 'return', id: fresh('health-value'), value: out(hp) },
      ] },
      { kind: 'call', id: sorted, module: 'collection.sort', version: '1', inputs: { items: inputs.pieces, keys: out(keys) }, parameters: { order: 'ascending' } },
      { kind: 'collection', id: node.id, method: 'find', items: out(sorted, 'items'), item: 'item', body: [{ kind: 'return', id: fresh('first'), value: { kind: 'literal', value: true } }] },
    ], outputs: { piece: out(node.id) } }
  }
  if (node.module === 'collection.live-piece-count') {
    const pieces = fresh('pieces')
    return { statements: [
      { kind: 'call', id: pieces, module: 'query.pieces', version: '1', parameters: { relation: 'all', includeDead: true } },
      { ...node, module: 'collection.length', version: '1', inputs: { items: out(pieces, 'pieces') }, parameters: {} },
    ], outputs: { count: out(node.id) } }
  }
  if (node.module === 'value.string-or-empty' || node.module === 'value.coalesce-record') {
    const text = node.module === 'value.string-or-empty'
    return {
      statements: [{ ...node, module: 'value.coalesce', version: '1', inputs: {
        value: inputs[text ? 'value' : 'first'], defaultValue: text ? { kind: 'literal', value: '' } : inputs.fallback,
      }, parameters: { valueType: text ? 'string' : JSON.stringify({ kind: 'nullable', value: 'record' }) } }],
      outputs: { [text ? 'text' : 'value']: out(node.id) },
    }
  }
  if (node.module === 'query.piece-names') {
    const name = fresh('name')
    return {
      statements: [{ kind: 'collection', id: node.id, method: 'map', items: inputs.pieces, item: 'item', body: [
        { kind: 'call', id: name, module: 'piece.field', version: '1', inputs: { piece: { kind: 'input', name: 'item' } }, parameters: { field: 'name' } },
        { kind: 'return', id: fresh('name-return'), value: out(name) },
      ] }], outputs: { names: out(node.id) },
    }
  }
  const mapping: Record<string, [string, string]> = {
    'projectile.event-kind': ['type', 'kind'], 'projectile.event-distance': ['distance', 'distance'],
    'projectile.event-blocks': ['blocksProjectile', 'blocks'], 'projectile.event-piece': ['piece', 'piece'],
  }
  const [field, port] = mapping[node.module]
  return { statements: [{ ...node, module: 'observation.field', version: '1', inputs: { record: inputs.event }, parameters: { field } }], outputs: { [port]: out(node.id) } }
}
