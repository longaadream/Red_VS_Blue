import type { AtomicRecipe } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayValue } from './module-types'

type FieldAlias = { module: string; field: string; input: string; oldInput: string; output: string }
const aliases: Readonly<Record<string, FieldAlias>> = {
  'piece.owner': { module: 'piece.field', field: 'ownerPlayerId', input: 'piece', oldInput: 'piece', output: 'player' },
  'piece.identifier': { module: 'piece.field', field: 'instanceId', input: 'piece', oldInput: 'piece', output: 'id' },
  'piece.is-core': { module: 'piece.field', field: 'isCore', input: 'piece', oldInput: 'piece', output: 'value' },
  'resource.limit': { module: 'player.field', field: 'maxActionPoints', input: 'player', oldInput: 'player', output: 'value' },
}
export const ATOMIC_FIELD_ALIASES = new Set([...Object.keys(aliases), 'attribute.read', 'attribute.text', 'attribute.player-text', 'resource.read', 'compare.text', 'recall.opposed-players'])

/** Consolidate one-field adapters under typed, closed field access. */
export const atomicFieldRecipe: AtomicRecipe = (node, fresh) => {
  if (node.module === 'compare.text') return { statements: [{ ...node, module: 'compare.equal-string-nullable', version: '2' }] }
  if (node.module === 'recall.opposed-players') {
    const actor = fresh('actor-faction'), owner = fresh('owner-faction')
    return { statements: [
      { kind: 'call', id: actor, module: 'player.field', version: '1', inputs: { player: node.inputs!.actor }, parameters: { field: 'faction' } },
      { kind: 'call', id: owner, module: 'player.field', version: '1', inputs: { player: node.inputs!.owner }, parameters: { field: 'faction' } },
      { ...node, module: 'compare.not-equal-string', version: '1', parameters: {}, inputs: { left: { kind: 'output', node: actor, port: 'value' }, right: { kind: 'output', node: owner, port: 'value' } } },
    ] }
  }
  const alias = aliases[node.module]
    || (node.module === 'attribute.read' ? { module: 'piece.field', field: String(node.parameters?.attribute), input: 'piece', oldInput: 'piece', output: 'value' } : undefined)
    || (node.module === 'attribute.text' ? { module: 'piece.field', field: String(node.parameters?.attribute), input: 'piece', oldInput: 'piece', output: 'text' } : undefined)
    || (node.module === 'attribute.player-text' ? { module: 'player.field', field: String(node.parameters?.attribute), input: 'player', oldInput: 'player', output: 'text' } : undefined)
    || (node.module === 'resource.read' ? { module: 'player.field', field: String(node.parameters?.resource), input: 'player', oldInput: 'player', output: 'value' } : undefined)
  if (!alias) return undefined
  const rewritten: GameplayCallStatement = {
    ...node, module: alias.module, version: node.module === 'attribute.text' && node.version === '2' ? '2' : '1', inputs: { [alias.input]: node.inputs![alias.oldInput] }, parameters: { field: alias.field },
  }
  return { statements: [rewritten], outputs: { [alias.output]: { kind: 'output', node: node.id, port: 'value' } as GameplayValue } }
}
