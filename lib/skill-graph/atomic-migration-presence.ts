import type { AtomicRecipe } from './atomic-graph-rewrite'
import type { GameplayStatement, GameplayValue } from './module-types'

/** Only surviving gameplay conditions reach this pass; defensive guards are removed first. */
export const atomicPresenceRecipe: AtomicRecipe = (node, fresh) => {
  if (!['query.has-piece', 'query.has-piece-id', 'query.has-player', 'piece.alive'].includes(node.module)) return undefined
  const isPlayer = node.module === 'query.has-player'
  const textIdentity = node.module === 'query.has-piece-id'
  const target = node.inputs?.[textIdentity ? 'id' : isPlayer ? 'playerId' : node.module === 'piece.alive' ? 'piece' : 'pieceId'] || { kind: 'literal' as const, value: null }
  const items = fresh('items'), matches = fresh('matches'), compare = fresh('compare'), count = fresh('count')
  const out = (id: string, port = 'value'): GameplayValue => ({ kind: 'output', node: id, port })
  const checked = fresh('reference')
  const itemId = fresh('item-id')
  // The legacy alive port required a resolvable non-null reference. Keep that
  // compiler boundary: a stale ID invalidates the condition, a null ID is false.
  const validation: GameplayStatement[] = node.module === 'piece.alive' ? [
    { kind: 'call', id: checked, module: 'query.piece', version: '1', inputs: { pieceId: target } },
  ] : []
  return {
    statements: [
      ...validation,
      { kind: 'call', id: items, module: isPlayer ? 'query.players' : 'query.pieces', version: '1', inputs: {}, parameters: isPlayer ? {} : { relation: 'all', includeDead: node.module !== 'piece.alive' } },
      { kind: 'collection', id: matches, method: 'filter', items: out(items, isPlayer ? 'players' : 'pieces'), inputs: { target: validation.length ? out(checked, 'piece') : target }, body: [
        ...(textIdentity ? [{ kind: 'call' as const, id: itemId, module: 'piece.field', version: '1', inputs: { piece: { kind: 'input' as const, name: 'item' } }, parameters: { field: 'instanceId' } }] : []),
        { kind: 'call', id: compare, module: 'compare.values', version: '1', inputs: { left: textIdentity ? out(itemId) : { kind: 'input', name: 'item' }, right: { kind: 'input', name: 'target' } }, parameters: { valueType: JSON.stringify({ kind: 'nullable', value: textIdentity ? 'string' : isPlayer ? 'player' : 'piece' }), operator: '==' } },
        { kind: 'return', id: fresh('return'), value: out(compare) },
      ] },
      { kind: 'call', id: count, module: 'collection.length', version: '1', inputs: { items: out(matches) } },
      { kind: 'call', id: node.id, module: 'compare.greater-than', version: '1', inputs: { left: out(count), right: { kind: 'literal', value: 0 } } },
    ],
    outputs: { [node.module === 'piece.alive' ? 'alive' : 'exists']: out(node.id) },
  }
}
