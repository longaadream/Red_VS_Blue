import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayLiteral,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * Compatibility writers migrated to the closed field readers and setters.
 * The old modules remain registered for loading old resources; this recipe is
 * the only place that removes them from author graphs.
 */
export const ATOMIC_FIELD_WRITE_MODULES = new Set([
  'attribute.adjust-max-hp',
  'attribute.set-current-hp',
  'status.set-record-number',
  'status.set-record-text',
  'status.set-record-boolean',
  'status.clear-record-field',
])
export const ATOMIC_FIELD_WRITE_MODULE_IDS = ATOMIC_FIELD_WRITE_MODULES

const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: 'number' }
const valueTypeParameter = (type: GameplayValueType): GameplayLiteral => typeof type === 'string' ? type : JSON.stringify(type)
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  type: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType: valueTypeParameter(type), operator })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.and', { left, right })
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

const STATUS_NUMBER_FIELDS = new Set([
  'currentDuration', 'remainingDuration', 'currentUses', 'remainingUses', 'lastDamageTurn',
  'stacks', 'intensity', 'hitCount', 'readyCharges', 'remainingTurns', 'grantedTurnNumber',
  'createdTurnNumber', 'turnNumber', 'value',
])
const STATUS_TEXT_FIELDS = new Set(['type', 'sourceId', 'name', 'stacking'])
const STATUS_BOOLEAN_FIELDS = new Set(['visible'])

function statusSelection(
  node: GameplayCallStatement,
  fresh: (suffix: string) => string,
): { statements: GameplayStatement[]; selected: GameplayValue } | undefined {
  const piece = node.inputs?.piece
  const statusId = node.inputs?.statusId
  if (!piece || !statusId) return undefined
  const statuses = fresh('status-instances')
  const selected = fresh('selected-status')
  const statusIdValue = fresh('status-id')
  const idDefined = fresh('status-id-defined')
  const idMatches = fresh('status-id-matches')
  const matches = fresh('status-id-match')
  const body: GameplayStatement[] = [
    call(statusIdValue, 'status.instance-field', { status: input('item') }, { field: 'id' }),
    compare(idDefined, output(statusIdValue, 'defined'), literal(true), 'boolean'),
    compare(idMatches, output(statusIdValue), input('statusId'), nullableStringType),
    and(matches, output(idDefined), output(idMatches)),
    returnValue(fresh('status-match-return'), output(matches)),
  ]
  return {
    statements: [
      call(statuses, 'status.instances', { piece }),
      { kind: 'collection', id: selected, method: 'find', items: output(statuses, 'statuses'), item: 'item', inputs: { statusId }, body },
    ],
    selected: output(selected),
  }
}

function statusWriteReplacement(
  node: GameplayCallStatement,
  fresh: (suffix: string) => string,
  fieldType: GameplayValueType,
  field: string,
  value: GameplayValue,
): AtomicReplacement | undefined {
  const selection = statusSelection(node, fresh)
  if (!selection) return undefined
  const write = call(fresh('write-status-field'), 'status.write-field', {
    status: selection.selected,
    value,
  }, { field, valueType: valueTypeParameter(fieldType) })
  return {
    statements: [...selection.statements, write],
    outputs: { success: output(write.id, 'success') },
  }
}

function replaceStatusWriter(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const field = node.parameters?.field
  if (typeof field !== 'string') return undefined
  if (node.module === 'status.set-record-number') {
    if (!STATUS_NUMBER_FIELDS.has(field)) return undefined
    const value = node.inputs?.value
    if (!value) return undefined
    return statusWriteReplacement(node, fresh, 'number', field, value)
  }
  if (node.module === 'status.set-record-text') {
    if (!STATUS_TEXT_FIELDS.has(field)) return undefined
    const value = node.inputs?.value
    if (!value) return undefined
    return statusWriteReplacement(node, fresh, 'string', field, value)
  }
  if (node.module === 'status.set-record-boolean') {
    if (!STATUS_BOOLEAN_FIELDS.has(field)) return undefined
    const value = node.inputs?.value
    if (!value) return undefined
    return statusWriteReplacement(node, fresh, 'boolean', field, value)
  }
  if (node.module === 'status.clear-record-field') {
    if (field !== 'expiresAfterTurn') return undefined
    return statusWriteReplacement(node, fresh, nullableNumberType, field, literal(null))
  }
  return undefined
}

function replaceCurrentHp(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = node.inputs?.piece
  const value = node.inputs?.value
  if (!piece || !value) return undefined
  const write = fresh('write-current-hp')
  const read = fresh('read-current-hp')
  return {
    statements: [
      call(write, 'piece.write-field', { piece, value }, { field: 'currentHp', valueType: 'number' }),
      call(read, 'piece.field', { piece }, { field: 'currentHp' }),
    ],
    outputs: { value: output(read) },
  }
}

function replaceMaxHp(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = node.inputs?.piece
  const amount = node.inputs?.amount
  if (!piece || !amount) return undefined
  const current = fresh('read-max-hp')
  const next = fresh('next-max-hp')
  const write = fresh('write-max-hp')
  const result = fresh('read-written-max-hp')
  return {
    statements: [
      call(current, 'piece.field', { piece }, { field: 'maxHp' }),
      call(next, 'math.add', { left: output(current), right: amount }),
      call(write, 'piece.write-field', { piece, value: output(next) }, { field: 'maxHp', valueType: 'number' }),
      call(result, 'piece.field', { piece }, { field: 'maxHp' }),
    ],
    outputs: { value: output(result) },
  }
}

/** Replace legacy HP and status record assignments with typed public primitives. */
export const atomicFieldWriteRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (node.module === 'attribute.set-current-hp') return replaceCurrentHp(node, fresh)
  if (node.module === 'attribute.adjust-max-hp') return replaceMaxHp(node, fresh)
  if (ATOMIC_FIELD_WRITE_MODULES.has(node.module)) return replaceStatusWriter(node, fresh)
  return undefined
}

export function migrateFieldWriteModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicFieldWriteRecipe)
}
