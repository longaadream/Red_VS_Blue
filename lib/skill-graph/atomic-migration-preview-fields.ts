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

/** Compatibility readers replaced by preview/battle field compositions. */
export const ATOMIC_PREVIEW_FIELD_MODULES = new Set([
  'preview.piece-number',
  'preview.skill-number',
  'preview.piece-number-nan',
  'preview.piece-number-or-zero',
  'preview.piece-max-hp',
  'preview.skill-text',
  'preview.skill-number-nan',
  'preview.piece-status-number',
  'event.battle-turn-number',
  'followup.turn-number-or-zero',
])

export const ATOMIC_PREVIEW_FIELD_MODULE_IDS = ATOMIC_PREVIEW_FIELD_MODULES

const nullableRecordListType: GameplayValueType = { kind: 'nullable', value: { kind: 'list', element: 'record' } }
const recordListType: GameplayValueType = { kind: 'list', element: 'record' }
const numberType: GameplayValueType = 'number'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

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

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

/** Keep source metadata on the final replacement statement. */
function replaceCall(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  const next: Record<string, unknown> = { ...original, module, version, inputs }
  if (parameters === undefined) delete next.parameters
  else next.parameters = parameters
  return next as GameplayCallStatement
}

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function fieldParameter(
  call: GameplayCallStatement,
  name: string,
  allowed: ReadonlySet<string>,
  fallback: string,
): string | undefined {
  const value = call.parameters?.[name]
  if (value === undefined) return fallback
  return typeof value === 'string' && allowed.has(value) ? value : undefined
}

function stringParameter(call: GameplayCallStatement, name: string, fallback: string): string | undefined {
  const value = call.parameters?.[name]
  if (value === undefined) return fallback
  return typeof value === 'string' ? value : undefined
}

function numericFallback(call: GameplayCallStatement, fallback = 18): number | undefined {
  const value = call.parameters?.fallback
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function previewPieceField(id: string, piece: GameplayValue, field: string, missing?: 'undefined' | 'null'): GameplayCallStatement {
  return generatedCall(id, 'preview.piece-field', { piece }, missing === undefined ? { field } : { field, missing })
}

function previewSkillField(id: string, skill: GameplayValue, field: string, missing?: 'undefined' | 'null'): GameplayCallStatement {
  return generatedCall(id, 'preview.skill-field', { skill }, missing === undefined ? { field } : { field, missing })
}

function previewRecordField(id: string, record: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, 'preview.record-field', { record }, { field })
}

function nullishNumberCoalesce(id: string, value: GameplayValue, defaultValue: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'value.coalesce', { value, defaultValue }, { valueType: valueTypeParameter(numberType) })
}

type TruthySelection = {
  readonly statements: readonly GameplayCallStatement[]
  readonly output: GameplayValue
}

function truthySelection(
  call: GameplayCallStatement | undefined,
  fresh: (suffix: string) => string,
  value: GameplayValue,
  defaultValue: GameplayValue,
): TruthySelection {
  const normalizedId = fresh('truthy-value')
  const truthyId = fresh('truthy')
  const normalized = nullishNumberCoalesce(normalizedId, value, defaultValue)
  const truthy = generatedCall(truthyId, 'value.to-boolean', { value: output(normalizedId) }, { valueType: valueTypeParameter(numberType) })
  const selected = call === undefined
    ? generatedCall(fresh('truthy-select'), 'logic.select', {
      condition: output(truthyId), whenTrue: output(normalizedId), whenFalse: defaultValue,
    }, { valueType: valueTypeParameter(numberType) }, '2')
    : replaceCall(call, 'logic.select', {
      condition: output(truthyId), whenTrue: output(normalizedId), whenFalse: defaultValue,
    }, { valueType: valueTypeParameter(numberType) }, '2')
  return { statements: [normalized, truthy, selected], output: output(selected.id) }
}

function nullableListCoalesce(id: string, value: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'value.coalesce', { value, defaultValue: literal([]) }, {
    valueType: valueTypeParameter(nullableRecordListType),
  })
}

function listCoalesce(id: string, value: GameplayValue): GameplayCallStatement {
  return generatedCall(id, 'value.coalesce', { value, defaultValue: literal([]) }, {
    valueType: valueTypeParameter(recordListType),
  })
}

function directPreviewField(
  call: GameplayCallStatement,
  module: 'preview.piece-field' | 'preview.skill-field',
  sourceName: 'piece' | 'skill',
  attribute: string,
): AtomicReplacement | undefined {
  const source = requiredInput(call, sourceName)
  if (!source) return undefined
  const rewritten = replaceCall(call, module, { [sourceName]: source }, { field: attribute })
  return { statements: [rewritten], outputs: { value: output(call.id) } }
}

function convertedPreviewField(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  module: 'preview.piece-field' | 'preview.skill-field',
  sourceName: 'piece' | 'skill',
  attribute: string,
): AtomicReplacement | undefined {
  const source = requiredInput(call, sourceName)
  if (!source) return undefined
  const fieldId = fresh('preview-field')
  const read = module === 'preview.piece-field'
    ? previewPieceField(fieldId, source, attribute)
    : previewSkillField(fieldId, source, attribute)
  const converted = replaceCall(call, 'value.to-number', { value: output(fieldId) })
  return { statements: [read, converted], outputs: { value: output(call.id) } }
}

function zeroPreviewField(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  module: 'preview.piece-field' | 'preview.skill-field',
  sourceName: 'piece' | 'skill',
  attribute: string,
): AtomicReplacement | undefined {
  const source = requiredInput(call, sourceName)
  if (!source) return undefined
  const fieldId = fresh('preview-field')
  const read = module === 'preview.piece-field'
    ? previewPieceField(fieldId, source, attribute, 'null')
    : previewSkillField(fieldId, source, attribute, 'null')
  const selected = truthySelection(call, fresh, output(fieldId), literal(0))
  return { statements: [read, ...selected.statements], outputs: { value: selected.output } }
}

function pieceMaxHp(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const fallback = numericFallback(call)
  if (!piece || fallback === undefined) return undefined

  const directId = fresh('piece-max-hp')
  const statsId = fresh('piece-stats')
  const statsMaxId = fresh('stats-max-hp')
  const direct = previewPieceField(directId, piece, 'maxHp', 'null')
  const stats = previewPieceField(statsId, piece, 'stats', 'null')
  const statsMax = previewRecordField(statsMaxId, output(statsId), 'maxHp')
  const statsDefault = truthySelection(undefined, fresh, output(statsMaxId), literal(fallback))
  const directDefault = truthySelection(call, fresh, output(directId), statsDefault.output)
  // Nullish normalization plus boolean selection preserves the old
  // `piece.maxHp || (piece.stats && piece.stats.maxHp) || fallback` ordering,
  // including zero, NaN, explicit null, missing fields, and truthy raw strings.
  return {
    statements: [direct, stats, statsMax, ...statsDefault.statements, ...directDefault.statements],
    outputs: { value: directDefault.output },
  }
}

function statusNumber(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const statusType = stringParameter(call, 'statusType', 'shishio-kills')
  const attribute = fieldParameter(call, 'attribute', new Set(['intensity']), 'intensity')
  if (!piece || !statusType || !attribute) return undefined

  const tagsRawId = fresh('status-tags-raw')
  const tagsNullableId = fresh('status-tags-nullable')
  const tagsId = fresh('status-tags')
  const findId = fresh('status')
  const tagTypeId = fresh('status-type')
  const tagMatchId = fresh('status-match')
  const intensityId = fresh('status-intensity')
  const tagsRaw = previewPieceField(tagsRawId, piece, 'statusTags')
  const tagsNullable = nullableListCoalesce(tagsNullableId, output(tagsRawId))
  const tags = listCoalesce(tagsId, output(tagsNullableId))
  const find: GameplayStatement = {
    kind: 'collection', id: findId, method: 'find', items: output(tagsId), item: 'item',
    body: [
      previewRecordField(tagTypeId, input('item'), 'type'),
      generatedCall(tagMatchId, 'compare.values', {
        left: output(tagTypeId), right: literal(statusType),
      }, { valueType: valueTypeParameter(nullableStringType), operator: '==' }),
      { kind: 'return', id: fresh('status-return'), value: output(tagMatchId) },
    ],
  }
  const intensity = previewRecordField(intensityId, output(findId), attribute)
  const result = truthySelection(call, fresh, output(intensityId), literal(0))
  return {
    statements: [tagsRaw, tagsNullable, tags, find, intensity, ...result.statements],
    outputs: { value: result.output },
  }
}

function battleTurn(call: GameplayCallStatement, fresh: (suffix: string) => string, fallbackFalsy: boolean): AtomicReplacement {
  const field = generatedCall(fresh('battle-field'), 'battle.field', {}, { field: 'turnNumber', ...(fallbackFalsy ? { missing: 'null' } : {}) }, '2')
  if (!fallbackFalsy) {
    const converted = replaceCall(call, 'value.to-number', { value: output(field.id) })
    return { statements: [field, converted], outputs: { value: output(call.id) } }
  }
  const selected = truthySelection(undefined, fresh, output(field.id), literal(0))
  const converted = replaceCall(call, 'value.to-number', { value: selected.output })
  return { statements: [field, ...selected.statements, converted], outputs: { value: output(call.id) } }
}

/** Recipe consumed by `rewriteAtomicGraph` for preview and turn aliases. */
export const atomicPreviewFieldRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  switch (call.module) {
    case 'preview.piece-number': {
      const attribute = fieldParameter(call, 'attribute', new Set(['attack', 'defense', 'moveRange', 'currentHp', 'maxHp']), 'attack')
      return attribute ? directPreviewField(call, 'preview.piece-field', 'piece', attribute) : undefined
    }
    case 'preview.skill-number': {
      const attribute = fieldParameter(call, 'attribute', new Set(['powerMultiplier', 'actionPointCost', 'chargeCost', 'cooldown']), 'powerMultiplier')
      return attribute ? directPreviewField(call, 'preview.skill-field', 'skill', attribute) : undefined
    }
    case 'preview.piece-number-nan': {
      const attribute = fieldParameter(call, 'attribute', new Set(['attack', 'defense', 'moveRange', 'currentHp', 'maxHp']), 'attack')
      return attribute ? convertedPreviewField(call, fresh, 'preview.piece-field', 'piece', attribute) : undefined
    }
    case 'preview.piece-number-or-zero': {
      const attribute = fieldParameter(call, 'attribute', new Set(['attack', 'defense', 'moveRange', 'currentHp', 'maxHp']), 'attack')
      return attribute ? zeroPreviewField(call, fresh, 'preview.piece-field', 'piece', attribute) : undefined
    }
    case 'preview.piece-max-hp': return pieceMaxHp(call, fresh)
    case 'preview.skill-text': {
      const attribute = fieldParameter(call, 'attribute', new Set(['description']), 'description')
      return attribute ? directPreviewField(call, 'preview.skill-field', 'skill', attribute) : undefined
    }
    case 'preview.skill-number-nan': {
      const attribute = fieldParameter(call, 'attribute', new Set(['powerMultiplier', 'actionPointCost', 'chargeCost', 'cooldown']), 'powerMultiplier')
      return attribute ? convertedPreviewField(call, fresh, 'preview.skill-field', 'skill', attribute) : undefined
    }
    case 'preview.piece-status-number': return statusNumber(call, fresh)
    case 'event.battle-turn-number': return battleTurn(call, fresh, false)
    case 'followup.turn-number-or-zero': return battleTurn(call, fresh, true)
    default: return undefined
  }
}

export function createPreviewFieldMigrationRecipe(): AtomicRecipe {
  return atomicPreviewFieldRecipe
}

export function migratePreviewFieldModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicPreviewFieldRecipe)
}

export const migrateAtomicPreviewFieldGraph = migratePreviewFieldModules
