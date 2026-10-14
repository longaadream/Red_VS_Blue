import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayLiteral,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
} from './module-types'

/** Compatibility status writers expanded into generic instance operations. */
export const ATOMIC_RAW_STATUS_REMOVAL_MODULES = new Set([
  'status.remove-type-raw',
  'status.remove-source-type-raw',
  'status.remove-expired-turn-type',
  'status.remove-player-records',
])
export const ATOMIC_RAW_STATUS_REMOVAL_MODULE_IDS = ATOMIC_RAW_STATUS_REMOVAL_MODULES

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

const nullableStringType = /* @__PURE__ */ JSON.stringify({ kind: 'nullable', value: 'string' })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function statusField(
  id: string,
  status: GameplayValue,
  field: 'id' | 'type' | 'sourceId' | 'turnNumber',
): GameplayCallStatement {
  return call(id, 'status.instance-field', { status }, { field })
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  valueType: GameplayLiteral,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType, operator })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.and', { left, right })
}

function or(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.or', { left, right })
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function filter(
  id: string,
  items: GameplayValue,
  body: readonly GameplayStatement[],
  inputs?: Readonly<Record<string, GameplayValue>>,
): GameplayStatement {
  return {
    kind: 'collection', id, method: 'filter', items, item: 'item',
    ...(inputs === undefined ? {} : { inputs }), body,
  }
}

function foreach(id: string, items: GameplayValue, body: readonly GameplayStatement[]): GameplayStatement {
  return { kind: 'foreach', id, items, item: 'item', body }
}

function length(id: string, items: GameplayValue): GameplayCallStatement {
  return call(id, 'collection.length', { items })
}

function removeEach(fresh: (suffix: string) => string, items: GameplayValue): GameplayStatement {
  return foreach(fresh('remove-each'), items, [
    call(fresh('remove-instance'), 'status.remove-instance', { status: input('item') }),
  ])
}

function typeMatchBody(
  statusType: GameplayJsonValue,
  fresh: (suffix: string) => string,
  extra?: (status: GameplayValue, statements: GameplayStatement[]) => GameplayValue,
): readonly GameplayStatement[] {
  const typeField = fresh('status-type')
  const typeMatches = fresh('type-match')
  const statements: GameplayStatement[] = [
    statusField(typeField, input('item'), 'type'),
    compare(typeMatches, output(typeField), literal(statusType), nullableStringType),
  ]
  const result = extra?.(output(typeMatches), statements)
  statements.push(returnValue(fresh('status-filter-return'), result ?? output(typeMatches)))
  return statements
}

function removeTypeReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const piece = node.inputs?.piece ?? literal(null)
  const statuses = fresh('status-instances')
  const matching = fresh('matching-statuses')
  const count = fresh('removed-count')
  const statements: GameplayStatement[] = [
    node.module === 'status.remove-player-records'
      ? { ...call(statuses, 'status.instances', { owner: node.inputs?.player ?? literal(null) }, { ownerType: 'player' }), version: '2' }
      : { ...call(statuses, 'status.instances', { owner: piece }, { ownerType: 'piece' }), version: '2' },
    filter(matching, output(statuses, 'statuses'), typeMatchBody(node.parameters?.statusType ?? null, fresh)),
    removeEach(fresh, output(matching)),
    length(count, output(matching)),
  ]
  if (node.module === 'status.remove-player-records') {
    const existing = fresh('player-status-field'), missing = fresh('missing-status-field')
    statements.push(
      call(existing, 'player.field', { player: node.inputs!.player }, { field: 'statusTags' }),
      call(missing, 'logic.not', { value: output(existing, 'exists') }),
      { kind: 'if', id: fresh('initialize-missing-status-field'), condition: output(missing), then: [
        call(fresh('assign-empty-statuses'), 'player.write-field', { player: node.inputs!.player, value: literal([]) }, { field: 'statusTags' }),
      ] },
    )
  }
  return { statements, outputs: { count: output(count) } }
}

function removeSourceTypeReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const target = node.inputs?.target ?? literal(null)
  const source = node.inputs?.source ?? literal(null)
  const sourceId = fresh('source-id')
  const statuses = fresh('status-instances-by-id')
  const matching = fresh('matching-statuses')
  const count = fresh('removed-count')
  const sourceMatch = fresh('source-match')
  const statements: GameplayStatement[] = [
    call(sourceId, 'piece.identifier', { piece: source }),
    call(statuses, 'status.instances-by-id', { target }),
    filter(matching, output(statuses, 'statuses'), typeMatchBody(node.parameters?.statusType ?? null, fresh, (_typeMatch, body) => {
      const sourceField = fresh('status-source')
      body.push(
        statusField(sourceField, input('item'), 'sourceId'),
        compare(sourceMatch, output(sourceField), input('sourceId'), nullableStringType),
      )
      const result = fresh('type-and-source-match')
      body.push(and(result, _typeMatch, output(sourceMatch)))
      return output(result)
    }), { sourceId: output(sourceId, 'id') }),
    removeEach(fresh, output(matching)),
    length(count, output(matching)),
  ]
  return { statements, outputs: { count: output(count) } }
}

function removeExpiredTurnReplacement(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const target = node.inputs?.target ?? literal(null)
  const turn = node.inputs?.turn ?? literal(null)
  const turnLocal = fresh('turn-local')
  const turnRead = fresh('turn-read')
  const statuses = fresh('status-instances')
  const matching = fresh('expired-statuses')
  const statements: GameplayStatement[] = [call(statuses, 'status.instances', { piece: target })]
  const filterBody: GameplayStatement[] = []
  const typeField = fresh('status-type')
  const typeMatches = fresh('type-match')
  const turnField = fresh('status-turn')
  const turnValue = fresh('status-turn-value')
  const turnNumber = fresh('status-turn-number')
  const turnMissing = fresh('turn-missing')
  const turnDiffers = fresh('turn-differs')
  const turnExpired = fresh('turn-expired')
  const idField = fresh('status-id')
  const idText = fresh('status-id-text')
  const idIsString = fresh('status-id-is-string')
  const typeAndTurn = fresh('type-and-turn')
  const allMatch = fresh('expired-match')
  const result = fresh('expired-result')

  filterBody.push(
    statusField(typeField, input('item'), 'type'),
    compare(typeMatches, output(typeField), literal(node.parameters?.statusType ?? null), nullableStringType),
    statusField(turnField, input('item'), 'turnNumber'),
    compare(turnMissing, output(turnField, 'defined'), literal(false), 'boolean'),
    call(turnValue, 'value.coalesce', { value: output(turnField), defaultValue: literal(0) }, { valueType: 'number' }),
    call(turnNumber, 'math.subtract', { left: output(turnValue), right: literal(0) }),
    compare(turnDiffers, output(turnNumber), input('turn'), 'number', '!='),
    or(turnExpired, output(turnMissing), output(turnDiffers)),
    and(typeAndTurn, output(typeMatches), output(turnExpired)),
    statusField(idField, input('item'), 'id'),
    call(idText, 'text.from-value', { value: output(idField) }, { valueType: nullableStringType }),
    // Comparing the raw field with its text conversion is a closed generic
    // way to retain the legacy `typeof id === "string"` boundary.  Numbers,
    // booleans, null and missing ids therefore never pass this predicate.
    compare(idIsString, output(idField), output(idText, 'text'), nullableStringType),
    and(allMatch, output(typeAndTurn), output(idIsString)),
    returnValue(fresh('status-filter-return'), output(allMatch)),
  )
  statements.unshift(
    call(turnLocal, 'local.declare', { initial: turn }, { valueType: 'number' }),
    call(turnRead, 'local.read', { handle: output(turnLocal, 'handle') }, { valueType: 'number' }),
  )
  statements.push(filter(matching, output(statuses, 'statuses'), filterBody, { turn: output(turnRead, 'value') }))
  statements.push(removeEach(fresh, output(matching)))
  statements.push(and(result, output(turnRead, 'success'), output(statuses, 'present')))
  return {
    statements,
    // The native success result is the target-presence fact, independent of
    // whether any status matched or was removed.  The local declaration/read
    // keeps an invalid required turn input on the result dependency chain.
    outputs: { success: output(result) },
  }
}

/** Expand raw status cleanup wrappers into generic field reads and handles. */
export const atomicRawStatusRemovalRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (node.module === 'status.remove-type-raw') return removeTypeReplacement(node, fresh)
  if (node.module === 'status.remove-player-records') return removeTypeReplacement(node, fresh)
  if (node.module === 'status.remove-source-type-raw') return removeSourceTypeReplacement(node, fresh)
  if (node.module === 'status.remove-expired-turn-type') return removeExpiredTurnReplacement(node, fresh)
  return undefined
}

export function migrateRawStatusRemovalModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicRawStatusRemovalRecipe)
}

export const migrateAtomicRawStatusRemovalGraph = migrateRawStatusRemovalModules
