import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext as Context,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const PREVIEW_SURFACES: readonly GameplayModuleSurface[] = ['preview']
const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const VALUE_SURFACES: readonly GameplayModuleSurface[] = [...ACTIVE_SURFACES, 'preview']

const numberType: GameplayValueType = 'number'
const stringType: GameplayValueType = 'string'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: 'record' }
const nullableRecordListType: GameplayValueType = { kind: 'nullable', value: { kind: 'list', element: 'record' } }
const unknownType: GameplayValueType = 'unknown'

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

const purePreview: GameplayEffectMetadata = { pure: true, previewSafe: true }
const pureValue: GameplayEffectMetadata = { pure: true, previewSafe: true }

/**
 * Fields exposed by the preview host.  The host passes immutable preview
 * objects, so these readers never resolve a piece reference through the
 * active battle state.
 */
export const PREVIEW_PIECE_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  attack: numberType,
  defense: numberType,
  moveRange: numberType,
  currentHp: numberType,
  maxHp: numberType,
  stats: nullableRecordType,
  statusTags: nullableRecordListType,
})

export const PREVIEW_SKILL_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  powerMultiplier: numberType,
  actionPointCost: numberType,
  chargeCost: numberType,
  cooldown: numberType,
  description: stringType,
})

/** Record fields needed by preview compositions (status tags and stats). */
export const PREVIEW_RECORD_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  type: nullableStringType,
  intensity: nullableNumberType,
  maxHp: nullableNumberType,
})

const BATTLE_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  turnNumber: nullableNumberType,
})

function selectedField(ctx: Context, fields: Readonly<Record<string, GameplayValueType>>): string {
  const value = ctx.parameters.field
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(fields, value)) {
    throw new Error(`module ${ctx.moduleId}: unsupported field`)
  }
  return value
}

function input(ctx: Context, name: string): string {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function battle(ctx: Context): string {
  return ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
}

function missingMode(ctx: Context): 'undefined' | 'null' {
  const value = ctx.parameters.missing === undefined ? 'undefined' : ctx.parameters.missing
  if (value !== 'undefined' && value !== 'null') throw new Error(`module ${ctx.moduleId}: unsupported missing mode`)
  return value
}

function previewPieceFieldLowering(ctx: Context): string {
  const selected = selectedField(ctx, PREVIEW_PIECE_FIELD_TYPES)
  const piece = input(ctx, 'piece')
  const key = ctx.emitLiteral(selected)
  const missing = missingMode(ctx)
  // Collection/record fields use null for a missing container so generic
  // coalesce can supply an empty collection or fallback record. Scalar fields
  // deliberately retain direct-property undefined and NaN behavior.
  if (selected === 'stats' || selected === 'statusTags') {
    return `(function(value){var result=value[${key}];return result===undefined?null:result;})(${piece})`
  }
  if (missing === 'null') return `(function(value){var result=value[${key}];return result===undefined?null:result;})(${piece})`
  return `(${piece})[${key}]`
}

function previewSkillFieldLowering(ctx: Context): string {
  const selected = selectedField(ctx, PREVIEW_SKILL_FIELD_TYPES)
  const missing = missingMode(ctx)
  const skill = input(ctx, 'skill')
  const key = ctx.emitLiteral(selected)
  if (missing === 'null') return `(function(value){var result=value[${key}];return result===undefined?null:result;})(${skill})`
  return `(${skill})[${key}]`
}

function previewRecordFieldLowering(ctx: Context): string {
  const selected = selectedField(ctx, PREVIEW_RECORD_FIELD_TYPES)
  const record = input(ctx, 'record')
  return `(function(value){if(value===null||value===undefined)return null;var result=value[${ctx.emitLiteral(selected)}];return result===undefined?null:result;})(${record})`
}

/** Raw battle turn read used by compatibility aliases before generic coercion. */
function battleTurnFieldLowering(ctx: Context): string {
  const selected = selectedField(ctx, BATTLE_FIELD_TYPES)
  const state = battle(ctx)
  const missing = missingMode(ctx)
  // Keep the exact legacy `turn && turn.turnNumber` raw value.  In
  // particular, a null turn becomes null (and Number(null) is zero), while an
  // absent turn becomes undefined (and Number(undefined) is NaN).
  const raw = `turn&&turn[key]`
  const value = missing === 'null' ? `((${raw})===undefined?null:(${raw}))` : raw
  return `(function(turn,key){var defined=turn!=null&&Object.prototype.hasOwnProperty.call(turn,key)&&turn[key]!==undefined;return {value:${value},defined:defined};})(((${state}).turn),${ctx.emitLiteral(selected)})`
}

/**
 * Generic scalar conversion.  The optional nullable input is intentional:
 * Number(undefined) and Number(null) are observable values in the legacy
 * preview and turn readers, so those values must reach the lowerer.
 */
function toNumberLowering(ctx: Context): string {
  return `Number(${input(ctx, 'value')})`
}

/** Generic JavaScript truthiness conversion for a closed author value. */
function toBooleanLowering(ctx: Context): string {
  return `Boolean(${input(ctx, 'value')})`
}

const fieldDescriptor = (
  id: string,
  label: string,
  inputName: string,
  inputType: GameplayValueType,
  fields: Readonly<Record<string, GameplayValueType>>,
  lower: (ctx: Context) => string,
  includeMissingMode = false,
): GameplayModuleDescriptor => ({
  id,
  version: '1',
  label,
  inputs: [port(inputName, inputType)],
  outputs: [port('value', unknownType)],
  parameters: [
    parameter('field', stringType, { enum: Object.keys(fields) }),
    ...(includeMissingMode ? [parameter('missing', stringType, { enum: ['undefined', 'null'], default: 'undefined' })] : []),
  ],
  outputParameterTypeBindings: { value: { parameter: 'field', types: fields } },
  allowedSurfaces: PREVIEW_SURFACES,
  effects: { ...purePreview, reads: ['preview-input'] },
  lower,
  ui: { category: 'preview', authoring: 'standard' },
})

/** Preview field views, generic scalar conversion, and the versioned turn view. */
export const PREVIEW_FIELD_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  fieldDescriptor('preview.piece-field', '读取预览棋子字段', 'piece', 'piece', PREVIEW_PIECE_FIELD_TYPES, previewPieceFieldLowering, true),
  fieldDescriptor('preview.skill-field', '读取预览技能字段', 'skill', 'content', PREVIEW_SKILL_FIELD_TYPES, previewSkillFieldLowering, true),
  {
    ...fieldDescriptor('preview.record-field', '读取预览记录字段', 'record', nullableRecordType, PREVIEW_RECORD_FIELD_TYPES, previewRecordFieldLowering),
    inputs: [port('record', 'record', { nullable: true, optional: true })],
  },
  {
    id: 'battle.field',
    version: '2',
    label: '读取战斗原始字段',
    description: '读取战斗回合的封闭原始字段并保留字段存在性；转换由通用值原子完成。',
    inputs: [],
    outputs: [port('value', unknownType), port('defined', 'boolean')],
    parameters: [
      parameter('field', stringType, { enum: Object.keys(BATTLE_FIELD_TYPES) }),
      parameter('missing', stringType, { enum: ['undefined', 'null'], default: 'undefined' }),
    ],
    outputParameterTypeBindings: { value: { parameter: 'field', types: BATTLE_FIELD_TYPES } },
    allowedSurfaces: ACTIVE_SURFACES,
    effects: { pure: true, previewSafe: false, reads: ['turn'] },
    lower: battleTurnFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
  {
    id: 'value.to-number',
    version: '1',
    label: '转换为数值',
    description: '使用 JavaScript Number 语义转换可空标量。',
    inputs: [port('value', numberType, { nullable: true, optional: true })],
    outputs: [port('value', numberType)],
    allowedSurfaces: VALUE_SURFACES,
    effects: pureValue,
    lower: toNumberLowering,
    ui: { category: 'value', authoring: 'standard' },
  },
  {
    id: 'value.to-boolean',
    version: '1',
    label: '转换为布尔值',
    description: '将封闭类型的值转换为布尔值；空值、零、空文本为假，记录和元组为真。类型由通用类型编辑器确定。',
    inputs: [port('value', 'record', { nullable: true, optional: true })],
    outputs: [port('value', 'boolean')],
    inputValueTypeBindings: { value: { parameter: 'valueType', nullable: true } },
    parameters: [parameter('valueType', stringType, { default: 'number' })],
    inspectReferences: ['value'],
    allowedSurfaces: VALUE_SURFACES,
    effects: pureValue,
    lower: toBooleanLowering,
    ui: { category: 'value', authoring: 'standard' },
  },
])

export const PREVIEW_FIELD_MODULE_IDS = Object.freeze(PREVIEW_FIELD_GAMEPLAY_MODULES.map(module => `${module.id}@${module.version}`))

export { BATTLE_FIELD_TYPES }
