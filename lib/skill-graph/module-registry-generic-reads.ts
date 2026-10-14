import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const PURE: readonly GameplayModuleSurface[] = [...ACTIVE, 'preview']
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const pieceType: GameplayValueType = 'piece'
const recordType: GameplayValueType = 'record'
const choiceType: GameplayValueType = 'choice'

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

const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({
  pure: true,
  previewSafe: true,
  ...(reads.length ? { reads } : {}),
})

const scalarTypeNames = ['string', 'number', 'boolean', 'piece', 'player'] as const
type ScalarTypeName = typeof scalarTypeNames[number]

const nullableScalarTypes = scalarTypeNames.map(value => JSON.stringify({ kind: 'nullable', value }))
const valueTypeEnum = [...scalarTypeNames, ...nullableScalarTypes]
const valueTypeBindings: Readonly<Record<string, GameplayValueType>> = Object.freeze(Object.fromEntries([
  ...scalarTypeNames.map(value => [value, value] as const),
  ...scalarTypeNames.map(value => [JSON.stringify({ kind: 'nullable', value }), { kind: 'nullable', value }] as const),
]))

function input(ctx: GameplayNativeLoweringContext, name: string): string {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function battle(ctx: GameplayNativeLoweringContext): string {
  return ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
}

function flow(ctx: GameplayNativeLoweringContext): string {
  return ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
}

type SelectedValueType = { readonly base: ScalarTypeName; readonly nullable: boolean }

function selectedValueType(ctx: GameplayNativeLoweringContext): SelectedValueType {
  const raw = ctx.parameters.valueType === undefined ? 'string' : ctx.parameters.valueType
  if (typeof raw === 'string' && (scalarTypeNames as readonly string[]).includes(raw)) {
    return { base: raw as ScalarTypeName, nullable: false }
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (record.kind === 'nullable' && typeof record.value === 'string' && (scalarTypeNames as readonly string[]).includes(record.value)) {
          return { base: record.value as ScalarTypeName, nullable: true }
        }
      }
    } catch {
      // The compiler validates the closed parameter enum before lowering. Keep
      // this guard for callers invoking a descriptor directly in tests.
    }
  }
  throw new Error(`module ${ctx.moduleId}: valueType must select a scalar or nullable scalar type`)
}

function recordFieldLowering(ctx: GameplayNativeLoweringContext): string {
  const field = ctx.parameters.field
  if (typeof field !== 'string' || field.length === 0 || ['__proto__', 'prototype', 'constructor'].includes(field)) {
    throw new Error(`module ${ctx.moduleId}: field must be a safe record key`)
  }
  const selected = selectedValueType(ctx)
  const record = input(ctx, 'record')
  const key = ctx.emitLiteral(field)
  const validation = selected.base === 'number'
    ? 'if (typeof value !== "number" || !Number.isFinite(value)) return __gameplayInvalid;'
    : selected.base === 'boolean'
      ? 'if (typeof value !== "boolean") return __gameplayInvalid;'
      : 'if (typeof value !== "string") return __gameplayInvalid;'
  return `(function(record){if(record===__gameplayInvalid)return __gameplayInvalid;if(record==null)return {value:null,defined:false};if(typeof record!=="object"||Array.isArray(record))return __gameplayInvalid;var defined=Object.prototype.hasOwnProperty.call(record,${key});var value=record[${key}];if(value===undefined||value===null)return {value:null,defined:defined};${validation}return {value:value,defined:defined};})(${record})`
}

function pieceOptionalFieldLowering(ctx: GameplayNativeLoweringContext): string {
  const field = ctx.parameters.field
  if (typeof field !== 'string' || field.length === 0 || ['__proto__', 'prototype', 'constructor'].includes(field)) {
    throw new Error(`module ${ctx.moduleId}: field must be a safe record key`)
  }
  const selected = selectedValueType(ctx)
  const piece = input(ctx, 'piece')
  const source = `${flow(ctx)}.query.piece(${piece})`
  const key = ctx.emitLiteral(field)
  // This optional reader intentionally leaves numeric values raw: the
  // position aliases must feed Number.isFinite themselves, preserving false
  // for strings, NaN, Infinity, and other malformed coordinates instead of
  // turning them into an invalid dependency before the predicate can observe
  // them.
  const validation = selected.base === 'number'
    ? ''
    : selected.base === 'boolean'
      ? 'if (typeof value !== "boolean") return __gameplayInvalid;'
      : 'if (typeof value !== "string") return __gameplayInvalid;'
  return `(function(piece){if(piece===__gameplayInvalid)return __gameplayInvalid;if(piece==null)return {value:null,defined:false};if(typeof piece!=="object"||Array.isArray(piece))return __gameplayInvalid;var defined=Object.prototype.hasOwnProperty.call(piece,${key});var value=piece[${key}];if(value===undefined||value===null)return {value:null,defined:defined};${validation}return {value:value,defined:defined};})(${source})`
}

/**
 * Small generic reads used when a legacy graph observes an untyped host
 * record.  They deliberately expose a single direct key, never a path or a
 * caller-provided JavaScript expression.  The battle extension read is kept
 * separate from author extension reads: a missing legacy key is an ordinary
 * nullable value, while missing author declarations continue to be invalid.
 */
export const GENERIC_READ_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  {
    id: 'piece.optional-field', version: '1', label: '读取可空棋子字段',
    description: '从当前棋子读取可空直接字段；缺失和空值返回空，数值内容保留原始值供调用方自行判断。',
    inputs: [port('piece', pieceType)], outputs: [port('value', 'unknown', { nullable: true }), port('defined', booleanType)],
    parameters: [
      parameter('field', stringType),
      parameter('valueType', stringType, { default: 'number', enum: valueTypeEnum }),
    ],
    outputParameterTypeBindings: { value: { parameter: 'valueType', types: valueTypeBindings } },
    allowedSurfaces: ACTIVE, effects: pure(['pieces']),
    lower: pieceOptionalFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
  {
    id: 'battle.field', version: '4', label: '读取战斗扩展字段',
    description: '从战斗扩展记录读取一个类型封闭的直接字段；缺失和空值返回空，错误类型保持无效依赖。',
    inputs: [], outputs: [port('value', 'unknown', { nullable: true }), port('defined', booleanType)],
    parameters: [
      parameter('field', stringType),
      parameter('valueType', stringType, { default: 'string', enum: valueTypeEnum }),
    ],
    outputParameterTypeBindings: { value: { parameter: 'valueType', types: valueTypeBindings } },
    allowedSurfaces: ACTIVE, effects: pure(['extensions']),
    lower: ctx => {
      const field = ctx.parameters.field
      if (typeof field !== 'string' || field.length === 0 || ['__proto__', 'prototype', 'constructor'].includes(field)) {
        throw new Error(`module ${ctx.moduleId}: field must be a safe record key`)
      }
      const selected = selectedValueType(ctx)
      const state = battle(ctx)
      const key = ctx.emitLiteral(field)
      const validation = selected.base === 'number'
        ? 'if (typeof value !== "number" || !Number.isFinite(value)) return __gameplayInvalid;'
        : selected.base === 'boolean'
          ? 'if (typeof value !== "boolean") return __gameplayInvalid;'
          : 'if (typeof value !== "string") return __gameplayInvalid;'
      return `(function(battle){if(battle===__gameplayInvalid)return __gameplayInvalid;var extensions=battle&&battle.extensions;if(extensions==null)return {value:null,defined:false};if(typeof extensions!=="object"||Array.isArray(extensions))return __gameplayInvalid;var defined=Object.prototype.hasOwnProperty.call(extensions,${key});var value=extensions[${key}];if(value===undefined||value===null)return {value:null,defined:defined};${validation}return {value:value,defined:defined};})(${state})`
    },
    ui: { category: 'field', authoring: 'standard' },
  },
  {
    id: 'battle.extensions', version: '1', label: '读取战斗扩展记录',
    description: '读取战斗状态中的只读扩展记录；扩展容器缺失时返回空值。',
    inputs: [], outputs: [port('record', recordType, { nullable: true })],
    allowedSurfaces: ACTIVE, effects: pure(['extensions']),
    lower: ctx => {
      const state = battle(ctx)
      return `(function(battle){var extensions=battle&&battle.extensions;return {record:extensions&&typeof extensions==="object"&&!Array.isArray(extensions)?extensions:null};})(${state})`
    },
    ui: { category: 'field', authoring: 'standard' },
  },
  {
    id: 'record.optional-field', version: '1', label: '按键读取可空记录字段',
    description: '从可空记录读取一个类型封闭的直接字段；缺失和空值返回空，错误类型保持无效依赖。',
    inputs: [port('record', recordType, { nullable: true })],
    outputs: [port('value', 'unknown', { nullable: true }), port('defined', booleanType)],
    parameters: [
      parameter('field', stringType),
      parameter('valueType', stringType, { default: 'string', enum: valueTypeEnum }),
    ],
    outputParameterTypeBindings: { value: { parameter: 'valueType', types: valueTypeBindings } },
    allowedSurfaces: ACTIVE, effects: pure(['records']),
    lower: recordFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
  {
    id: 'choice.as-array', version: '1', label: '读取原始选择数组',
    description: '将已完成的原始多选数组交给通用集合原语；非数组值按旧选择协议归一为空集合。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('items', { kind: 'list', element: choiceType })],
    allowedSurfaces: PURE, effects: pure(['choice']),
    lower: ctx => `(function(value){return Array.isArray(value)?value:[];})(${input(ctx, 'choice')})`,
    ui: { category: 'choice', authoring: 'standard' },
  },
  {
    id: 'collection.singleton', version: '1', label: '构造单项集合',
    description: '把一个值放入新的单项元组，元素类型由该值决定。',
    inputs: [port('value', recordType)], outputs: [port('items', { kind: 'list', element: 'any' })],
    parameters: [parameter('valueType', stringType, { default: 'piece', label: '元素类型' })],
    inputValueTypeBindings: { value: { parameter: 'valueType' } },
    outputTypeBindings: { items: { input: 'value', projection: 'singleton' } },
    allowedSurfaces: PURE, effects: pure(),
    lower: ctx => `[${input(ctx, 'value')}]`,
    ui: { category: 'collection', authoring: 'standard' },
  },
  {
    id: 'text.slice', version: '1', label: '截取文本',
    description: '按起点和可选终点截取文本；不执行额外规范化。',
    inputs: [port('text', stringType), port('start', numberType), port('end', numberType, { optional: true })],
    outputs: [port('value', stringType)],
    allowedSurfaces: PURE, effects: pure(),
    lower: ctx => `${input(ctx, 'text')}.slice(${input(ctx, 'start')}${ctx.inputs.end === undefined ? '' : `,${input(ctx, 'end')}`})`,
    ui: { category: 'text', authoring: 'standard' },
  },
])

export const GENERIC_READ_MODULES = GENERIC_READ_GAMEPLAY_MODULES
