import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayModuleGraph, GameplayStatement, GameplayValue } from './module-types'

const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

export const ATOMIC_DELAYED_DAMAGE_MODULES = new Set(['effect.damage-with-player-fallback', 'followup.damage-status', 'content.materialize-curse-template', 'effect.card-damage'])

/** Approved author semantics: independently scheduled damage belongs to the
 * player captured by its creation, never to a departed piece or another ally. */
export const atomicDelayedDamageRecipe: AtomicRecipe = (node, fresh, scope): AtomicReplacement | undefined => {
  if (node.module === 'effect.damage-with-killer-typed' && node.parameters?.skillId === 'curse-end-turn') {
    const visited = new Set<string>()
    function definition(value: GameplayValue | undefined): { record?: GameplayValue; cardId?: GameplayValue } | undefined {
      if (value?.kind !== 'output' || visited.has(value.node)) return undefined
      visited.add(value.node)
      const producer = scope?.getDefinition(value.node)
      if (producer?.kind !== 'call') return undefined
      if (producer.module === 'content.card-number') return { cardId: producer.inputs?.cardId }
      if (producer.module === 'data.read-key' && producer.parameters?.key === 'damageAmount') return { record: producer.inputs?.record }
      if (producer.module === 'value.coalesce') return definition(producer.inputs?.value)
      return undefined
    }
    const found = definition(node.inputs?.amount)
    if (!found) throw new Error('Cannot locate curse card data for ' + node.id)
    const statements: GameplayStatement[] = []
    let record = found.record
    if (!record && found.cardId) {
      const cards = fresh('cards'), card = fresh('card')
      statements.push(
        { kind: 'call', id: cards, module: 'content.field', version: '1', parameters: { field: 'customCards' } },
        { kind: 'call', id: card, module: 'data.read-key', version: '1', inputs: { record: out(cards), key: found.cardId }, parameters: { valueType: 'record' } },
      )
      record = out(card)
    }
    if (!record) throw new Error('Missing curse card record for ' + node.id)
    const extension = fresh('extension'), source = fresh('source-player')
    statements.push(
      { kind: 'call', id: extension, module: 'data.read-key', version: '1', inputs: { record }, parameters: { key: 'extension', valueType: 'record' } },
      { kind: 'call', id: source, module: 'data.read-key', version: '1', inputs: { record: out(extension) }, parameters: { key: 'sourcePlayerId', valueType: 'player' } },
      { ...node, module: 'effect.damage', inputs: { source: out(source), target: node.inputs!.target, amount: node.inputs!.amount }, parameters: { sourceType: 'player', damageType: 'normal', legacyNormalSpelling: 'magical', skillId: 'curse-end-turn', inputPolicy: 'host' } },
    )
    return { statements }
  }
  if (node.module === 'content.materialize-curse-template') {
    const player = fresh('creation-player'), extension = fresh('extension'), fields = fresh('fields'), empty = fresh('empty'), trigger = fresh('trigger'), bound = fresh('bound-fields')
    const { sourcePieceId, damageAmount, ...inputs } = node.inputs!
    return { statements: [
      { kind: 'call', id: player, module: 'piece.field', version: '1', inputs: { piece: sourcePieceId }, parameters: { field: 'ownerPlayerId' } },
      { kind: 'call', id: empty, module: 'record.empty', version: '1' },
      { kind: 'call', id: extension, module: 'record.set-key', version: '1', inputs: { record: out(empty, 'record'), key: { kind: 'literal', value: 'sourcePlayerId' }, value: out(player) }, parameters: { valueType: 'player' } },
      { kind: 'call', id: fields, module: 'record.set-key', version: '1', inputs: { record: out(empty, 'record'), key: { kind: 'literal', value: 'damageAmount' }, value: damageAmount }, parameters: { valueType: 'number' } },
      { kind: 'call', id: trigger, module: 'record.set-key', version: '1', inputs: { record: out(empty, 'record'), key: { kind: 'literal', value: 'type' }, value: { kind: 'literal', value: 'endTurn' } }, parameters: { valueType: 'string' } },
      { kind: 'call', id: bound, module: 'record.set-key', version: '1', inputs: { record: out(fields, 'record'), key: { kind: 'literal', value: 'trigger' }, value: out(trigger, 'record') }, parameters: { valueType: 'record' } },
      { ...node, module: 'content.materialize-template', inputs: { ...inputs, fields: out(bound, 'record'), extension: out(extension, 'record'), omitFields: { kind: 'literal', value: ['isSample', 'image', 'effectTags', 'targetText', 'keywords'] } }, parameters: { kind: 'card' } },
    ] }
  }
  if (node.module === 'effect.card-damage') {
    const cards = fresh('cards'), definition = fresh('definition'), extension = fresh('extension'), source = fresh('source-player')
    return { statements: [
      { kind: 'call', id: cards, module: 'content.field', version: '1', parameters: { field: 'customCards' } },
      { kind: 'call', id: definition, module: 'data.read-key', version: '1', inputs: { record: out(cards), key: node.inputs!.cardId }, parameters: { valueType: 'record' } },
      { kind: 'call', id: extension, module: 'data.read-key', version: '1', inputs: { record: out(definition) }, parameters: { key: 'extension', valueType: 'record' } },
      { kind: 'call', id: source, module: 'data.read-key', version: '1', inputs: { record: out(extension) }, parameters: { key: 'sourcePlayerId', valueType: 'player' } },
      { ...node, module: 'effect.damage', inputs: { source: out(source), target: node.inputs!.target, amount: node.inputs!.amount }, parameters: {
        sourceType: 'player', damageType: 'true', skillId: node.parameters!.skillId, inputPolicy: 'host', legacySkipBefore: true,
      } },
    ] }
  }
  if (node.module === 'effect.damage-with-player-fallback') {
    const { damageType, ...parameters } = node.parameters || {}
    return { statements: [{ ...node, module: 'effect.damage', inputs: {
      source: node.inputs!.playerSource, target: node.inputs!.target, amount: node.inputs!.amount,
    }, parameters: { ...parameters, inputPolicy: parameters.inputPolicy ?? 'floor', sourceType: 'player', damageType: damageType === 'true' ? 'true' : 'normal',
      ...(damageType === 'magical' ? { legacyNormalSpelling: 'magical' } : {}),
    } }] }
  }
  if (node.module !== 'followup.damage-status') return undefined
  const player = fresh('source-player'), amount = fresh('amount')
  return { statements: [
    { kind: 'call', id: player, module: 'data.read-key', version: '1', inputs: { record: node.inputs!.status }, parameters: { key: 'sourcePlayerId', valueType: 'player' } },
    { kind: 'call', id: amount, module: 'data.read-key', version: '1', inputs: { record: node.inputs!.status }, parameters: { key: 'delayedDamage', valueType: 'number' } },
    { ...node, module: 'effect.damage', inputs: { source: out(player), target: node.inputs!.target, amount: out(amount) }, parameters: {
      sourceType: 'player', damageType: node.parameters?.damageType === 'true' ? 'true' : 'normal',
      ...(node.parameters?.damageType === 'magical' ? { legacyNormalSpelling: 'magical' } : {}),
      skillId: node.parameters!.skillId, inputPolicy: 'host',
    } },
  ] }
}

/** Capture ownership in the skill graph. Historical sourceId remains available
 * for grouping; damage must not derive attribution from it at settlement. */
export function captureBlackCoffinPlayer(graph: GameplayModuleGraph): GameplayModuleGraph {
  let changed = false
  function body(statements: readonly GameplayStatement[]): GameplayStatement[] {
    return statements.flatMap((statement): GameplayStatement[] => {
      if (statement.kind === 'record.create' && statement.schema === 'aizen-black-coffin@1' && !statement.fields?.sourcePlayerId) {
        changed = true
        const source = statement.id + '--creation-source', owner = statement.id + '--creation-player'
        return [
          { kind: 'call', id: source, module: 'ref.holder', version: '1' },
          { kind: 'call', id: owner, module: 'piece.field', version: '1', inputs: { piece: out(source, 'piece') }, parameters: { field: 'ownerPlayerId' } },
          { ...statement, fields: { ...statement.fields, sourcePlayerId: out(owner) } },
        ]
      }
      if (statement.kind === 'if') return [{ ...statement, then: body(statement.then), ...(statement.else ? { else: body(statement.else) } : {}) }]
      if (statement.kind === 'foreach' || statement.kind === 'while' || statement.kind === 'collection') return [{ ...statement, body: body(statement.body) }]
      return [statement]
    })
  }
  const nextBody = body(graph.body)
  if (!changed) return graph
  return { ...graph, body: nextBody, schemas: graph.schemas?.map(schema => schema.id === 'aizen-black-coffin@1' || schema.id === 'aizen-black-coffin'
    ? { ...schema, fields: [...schema.fields.filter(field => field.name !== 'sourcePlayerId'), { name: 'sourcePlayerId', type: 'player' }] }
    : schema) }
}
