import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/** Compatibility module IDs routed through the closed context/skill readers. */
export const ATOMIC_CONTEXT_FIELD_MODULES = new Set([
  'event.type',
  'event.player',
  'event.actual-damage',
  'event.movement-kind',
  'event.single-piece-target-action',
  'event.reserved-cells',
  'event.selected-targets',
  'event.selected-option',
  'event.read-coordinate',
  'turn.number',
  'turn.current-player',
  'event.read-number',
  'event.read-string',
  'event.status-text',
  'event.card-id',
  'event.skill-id',
  'event.cancelled',
  'event.has-field',
  'skill.power-multiplier',
  'card.current-id',
  'card.current-type',
  'rule.source-player-fallback',
])

/** Alias used by catalogs that expose retired compatibility IDs. */
export const ATOMIC_CONTEXT_FIELD_MODULE_IDS = ATOMIC_CONTEXT_FIELD_MODULES

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const nullablePlayerType: GameplayValueType = { kind: 'nullable', value: 'player' }

function isValue(value: unknown): value is GameplayValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value')
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0
  return record.kind === 'output' && typeof record.node === 'string' && typeof record.port === 'string'
}

function requiredInput(call: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = call.inputs?.[name]
  return isValue(value) ? value : undefined
}

function replaceCall(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  return { ...original, module, version, inputs, parameters }
}

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function fieldParameter(call: GameplayCallStatement, fields: ReadonlySet<string>): string | undefined {
  const field = call.parameters?.field
  return typeof field === 'string' && fields.has(field) ? field : undefined
}

function directContextField(
  call: GameplayCallStatement,
  field: string,
  sourcePort = 'value',
  outputPort = 'value',
  version = '1',
): AtomicReplacement {
  const rewritten = replaceCall(call, 'context.field', {}, { field }, version)
  return { statements: [rewritten], outputs: { [outputPort]: output(call.id, sourcePort) } }
}

function directEventField(call: GameplayCallStatement, field: string, outputPort = 'value'): AtomicReplacement {
  const rewritten = replaceCall(call, 'event.field', {}, { field }, '2')
  return { statements: [rewritten], outputs: { [outputPort]: output(call.id, 'value') } }
}

function directBattleField(call: GameplayCallStatement, field: string, outputPort = 'value'): AtomicReplacement {
  const rewritten = replaceCall(call, 'battle.field', {}, { field }, '3')
  return { statements: [rewritten], outputs: { [outputPort]: output(call.id, 'value') } }
}

function sourcePlayerFallback(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const storageKey = call.parameters?.storageKey
  if (storageKey !== 'amaterasuOwnerPlayerId') return undefined

  const ruleOwnerId = fresh('rule-owner-player')
  const eventPlayerId = fresh('event-player')
  const extensionOwnerId = fresh('extension-owner-player')
  const ruleOwnerTruthyId = fresh('rule-owner-present')
  const eventPlayerTruthyId = fresh('event-player-present')
  const eventOrExtensionId = fresh('event-or-extension-player')
  const result = replaceCall(call, 'logic.select', {
    condition: output(ruleOwnerTruthyId),
    whenTrue: output(ruleOwnerId),
    whenFalse: output(eventOrExtensionId),
  }, { valueType: JSON.stringify(nullablePlayerType) }, '2')

  return {
    statements: [
      generatedCall(ruleOwnerId, 'context.field', {}, { field: 'ruleOwnerPlayerId' }, '4'),
      generatedCall(eventPlayerId, 'context.field', {}, { field: 'playerId' }, '4'),
      generatedCall(extensionOwnerId, 'battle.field', {}, {
        field: storageKey,
        valueType: JSON.stringify(nullablePlayerType),
      }, '4'),
      generatedCall(ruleOwnerTruthyId, 'value.to-boolean', { value: output(ruleOwnerId) }, {
        valueType: JSON.stringify(nullablePlayerType),
      }),
      generatedCall(eventPlayerTruthyId, 'value.to-boolean', { value: output(eventPlayerId) }, {
        valueType: JSON.stringify(nullablePlayerType),
      }),
      generatedCall(eventOrExtensionId, 'logic.select', {
        condition: output(eventPlayerTruthyId),
        whenTrue: output(eventPlayerId),
        whenFalse: output(extensionOwnerId),
      }, { valueType: JSON.stringify(nullablePlayerType) }, '2'),
      result,
    ],
    outputs: { player: output(call.id, 'value') },
  }
}

function coalescedContextField(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  field: string,
  fallback: GameplayValue,
  valueType: GameplayValueType,
): AtomicReplacement {
  const fieldId = fresh('context-field')
  const contextRead: GameplayCallStatement = {
    kind: 'call', id: fieldId, module: 'context.field', version: '1', inputs: {}, parameters: { field },
  }
  // The generic coalesce input binding explicitly accepts nullable values, so
  // one typed coalesce preserves both the nullable read and the old fallback.
  const result = replaceCall(call, 'value.coalesce', {
    value: output(fieldId, 'value'), defaultValue: fallback,
  }, { valueType: typeof valueType === 'string' ? valueType : JSON.stringify(valueType) })
  void fresh
  return { statements: [contextRead, result], outputs: { value: output(call.id, 'value') } }
}

const NUMBER_FIELDS = new Set(['damage', 'actualDamage', 'heal', 'amount', 'targetX', 'targetY', 'turnNumber'])
const STRING_FIELDS = new Set(['skillId', 'playerId'])
const STATUS_FIELDS = new Set(['statusId', 'statusType'])
const HAS_FIELD_FIELDS = new Set(['targetX', 'targetY', 'skillId', 'playerId', 'cancelled'])
const COORDINATE_FIELDS = new Set(['fromX', 'fromY'])
const EVENT_FIELD_ALIASES = new Map([
  ['event.type', 'type'],
  ['event.player', 'playerId'],
  ['event.actual-damage', 'actualDamage'],
  ['event.movement-kind', 'movementKind'],
])

/** Recipe consumed by `rewriteAtomicGraph` for context and skill aliases. */
export const atomicContextFieldRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  const eventField = EVENT_FIELD_ALIASES.get(call.module)
  if (eventField) return directEventField(call, eventField)
  switch (call.module) {
    case 'event.single-piece-target-action': return directContextField(call, 'isSinglePieceTargetAction', 'value', 'value', '2')
    case 'event.reserved-cells': return directContextField(call, 'reservedCells', 'value', 'cells', '2')
    case 'event.selected-targets': return directContextField(call, 'selectedTargets', 'value', 'targets', '2')
    case 'event.selected-option': return directContextField(call, 'selectedOption', 'value', 'value', '2')
    case 'event.read-coordinate': {
      const field = fieldParameter(call, COORDINATE_FIELDS)
      const fallback = requiredInput(call, 'fallback')
      return field && fallback ? coalescedContextField(call, fresh, field, fallback, 'number') : undefined
    }
    case 'turn.number': return directBattleField(call, 'turnNumber')
    case 'turn.current-player': return directBattleField(call, 'currentPlayerId', 'player')
    case 'event.read-number': {
      const field = fieldParameter(call, NUMBER_FIELDS)
      const fallback = requiredInput(call, 'fallback')
      return field && fallback ? coalescedContextField(call, fresh, field, fallback, 'number') : undefined
    }
    case 'event.read-string': {
      const field = fieldParameter(call, STRING_FIELDS)
      const fallback = requiredInput(call, 'fallback')
      return field && fallback ? coalescedContextField(call, fresh, field, fallback, 'string') : undefined
    }
    case 'event.status-text': {
      const field = fieldParameter(call, STATUS_FIELDS)
      return field ? directContextField(call, field) : undefined
    }
    case 'event.card-id': return directContextField(call, 'cardId')
    // Keep the legacy event.skill-id source exact: context.skillId only.  The
    // event.field skillId adapter intentionally has additional fallbacks.
    case 'event.skill-id': return directContextField(call, 'skillId')
    case 'event.cancelled': return directContextField(call, 'cancelled')
    case 'event.has-field': {
      const field = fieldParameter(call, HAS_FIELD_FIELDS)
      return field ? directContextField(call, field, 'defined') : undefined
    }
    case 'skill.power-multiplier': {
      const rewritten = replaceCall(call, 'skill.field', {}, { field: 'powerMultiplier' })
      return { statements: [rewritten], outputs: { value: output(call.id, 'value') } }
    }
    case 'card.current-id': return directContextField(call, 'currentCardId', 'value', 'cardId', '3')
    case 'card.current-type': return directContextField(call, 'currentCardType', 'value', 'type', '3')
    case 'rule.source-player-fallback': return sourcePlayerFallback(call, fresh)
    default: return undefined
  }
}

/** Backwards-compatible factory form for callers composing migration recipes. */
export function createContextFieldMigrationRecipe(): AtomicRecipe {
  return atomicContextFieldRecipe
}

/** Rewrite every graph scope, including branches, composites, and continuations. */
export function migrateContextFieldModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicContextFieldRecipe)
}

export const migrateAtomicContextFieldGraph = migrateContextFieldModules
