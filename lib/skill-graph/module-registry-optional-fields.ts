import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayParameter,
  GameplayValueType,
} from './module-types'

const SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
const PURE: GameplayEffectMetadata = { pure: true, previewSafe: true }
const recordType: GameplayValueType = 'record'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const playerType: GameplayValueType = 'player'
const cellType: GameplayValueType = 'cell'
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const stringListType: GameplayValueType = { kind: 'list', element: stringType }

const port = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayPort, 'name' | 'type'> = {},
): GameplayPort => ({ name, type, ...options })

const parameter = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayParameter, 'name' | 'type'> = {},
): GameplayParameter => ({ name, type, ...options })

const nullable = (value: GameplayValueType): GameplayValueType => ({ kind: 'nullable', value })

/**
 * Raw data fields that may be read by generic author graphs.  The map is
 * intentionally closed: a content graph can select one of these semantic
 * fields, but it cannot supply an arbitrary host property path.
 */
export const OPTIONAL_DATA_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  id: stringType,
  type: stringType,
  kind: stringType,
  name: stringType,
  templateId: stringType,
  instanceId: stringType,
  sourceId: stringType,
  targetId: stringType,
  skillId: stringType,
  // Runtime player references are serialized as player ids, while the graph
  // type remains `player` so downstream reference comparisons stay typed.
  ownerPlayerId: playerType,
  stacks: numberType,
  intensity: numberType,
  value: numberType,
  currentDuration: numberType,
  remainingDuration: numberType,
  currentUses: numberType,
  remainingUses: numberType,
  turnNumber: numberType,
  createdTurnNumber: numberType,
  lastDamageTurn: numberType,
  turns: numberType,
  extraValue: numberType,
  hitCount: numberType,
  readyCharges: numberType,
  dx: numberType,
  dy: numberType,
  centerX: numberType,
  centerY: numberType,
  damage: numberType,
  maxHp: numberType,
  attack: numberType,
  defense: numberType,
  moveRange: numberType,
  currentHp: numberType,
  momentum: numberType,
  left: cellType,
  right: cellType,
  statusTags: recordListType,
  pathCells: cellListType,
  skillIds: stringListType,
  stats: recordType,
})

const fieldTypes: Readonly<Record<string, GameplayValueType>> = Object.fromEntries(
  Object.entries(OPTIONAL_DATA_FIELD_TYPES).map(([name, type]) => [name, nullable(type)]),
)

const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function optionalFieldLowering(ctx: GameplayNativeLoweringContext): string {
  const selected = ctx.parameters.field
  if (typeof selected !== 'string' || !Object.hasOwn(OPTIONAL_DATA_FIELD_TYPES, selected)) {
    throw new Error(`module ${ctx.moduleId}: unsupported field`)
  }
  const record = input(ctx, 'record')
  const field = ctx.emitLiteral(selected)
  const type = OPTIONAL_DATA_FIELD_TYPES[selected]
  let read: string
  if (type === stringType || type === playerType) {
    read = 'if (typeof value !== "string") return __gameplayInvalid; return value;'
  } else if (type === numberType) {
    read = 'if (typeof value !== "number" || !Number.isFinite(value)) return __gameplayInvalid; return value;'
  } else if (type === cellType) {
    read = 'if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isInteger(value.x) || !Number.isInteger(value.y)) return __gameplayInvalid; return {x:value.x,y:value.y};'
  } else if (type === cellListType) {
    read = 'if (!Array.isArray(value)) return __gameplayInvalid; var cells = []; for (var index = 0; index < value.length; index += 1) { var cell = value[index]; if (!cell || typeof cell !== "object" || Array.isArray(cell) || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) return __gameplayInvalid; cells.push({x: cell.x, y: cell.y}); } return cells;'
  } else if (type === stringListType) {
    read = 'if (!Array.isArray(value)) return __gameplayInvalid; var strings = []; for (var index = 0; index < value.length; index += 1) { if (typeof value[index] !== "string") return __gameplayInvalid; strings.push(value[index]); } return strings;'
  } else if (type === recordListType) {
    read = 'if (!Array.isArray(value)) return __gameplayInvalid; var records = []; for (var index = 0; index < value.length; index += 1) { var item = value[index]; if (!item || typeof item !== "object" || Array.isArray(item)) return __gameplayInvalid; records.push(JSON.parse(JSON.stringify(item))); } return records;'
  } else if (type === recordType) {
    read = 'if (typeof value !== "object" || Array.isArray(value)) return __gameplayInvalid; return JSON.parse(JSON.stringify(value));'
  } else {
    throw new Error(`module ${ctx.moduleId}: unsupported field type`)
  }
  // Native module results with one output are unwrapped by the compiler when
  // the result object owns that output name.  Keep the raw record intact when
  // reading a field named `value` by returning the output envelope explicitly.
  return `(function(record){if(record===__gameplayInvalid)return __gameplayInvalid;if(record==null)return {value:null,defined:false};if(typeof record!=="object"||Array.isArray(record))return __gameplayInvalid;var defined=Object.prototype.hasOwnProperty.call(record,${field});var value=(function(record){var value=record[${field}];if(value===undefined||value===null)return null;${read}})(record);if(value===__gameplayInvalid)return __gameplayInvalid;return {value:value,defined:defined};})(${record})`
}

/** Generic closed optional data read.  Null means absent; malformed typed
 * data remains the compiler's invalid sentinel instead of being defaulted.
 * `defined` distinguishes an explicit null from an absent property. */
export const OPTIONAL_FIELD_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  {
    id: 'data.optional-field', version: '1', label: '读取可空记录字段',
    description: '从可空记录读取封闭字段；缺失或空值返回空，字段类型错误保持无效依赖。',
    inputs: [port('record', recordType, { nullable: true })],
    outputs: [port('value', 'unknown', { nullable: true }), port('defined', 'boolean')],
    outputParameterTypeBindings: { value: { parameter: 'field', types: fieldTypes } },
    parameters: [parameter('field', stringType, { enum: Object.keys(OPTIONAL_DATA_FIELD_TYPES) })],
    allowedSurfaces: SURFACES,
    effects: PURE,
    lower: optionalFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
])

export const GENERIC_OPTIONAL_FIELD_GAMEPLAY_MODULES = OPTIONAL_FIELD_GAMEPLAY_MODULES
