import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayValueType,
  GameplayPort,
  GameplayParameter,
} from './module-types'

const SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
const PURE: GameplayEffectMetadata = { pure: true, previewSafe: true }
const recordType: GameplayValueType = 'record'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const listRecordType: GameplayValueType = { kind: 'list', element: recordType }

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

const define = (descriptor: GameplayModuleDescriptor): GameplayModuleDescriptor => descriptor

const input = (ctx: GameplayNativeLoweringContext, name: string): string => ctx.inputs[name]

const comparisonOperator = (ctx: GameplayNativeLoweringContext): '===' | '!==' => {
  const value = ctx.parameters.operator
  if (value === '==') return '==='
  if (value === '!=') return '!=='
  throw new Error(`module ${ctx.moduleId}: operator must be == or !=`)
}

/** Native generic value primitives.  Compatibility wrappers are deliberately
 * absent from this list; migration recipes lower those wrappers into these
 * descriptors before author graphs are compiled. */
export const GENERIC_VALUE_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'logic.select', version: '1', label: '按条件选择值',
    description: '在两个同类型值之间按布尔条件选择一个值；值类型由封闭类型描述参数确定。',
    inputs: [
      port('condition', booleanType, { label: '条件' }),
      port('whenTrue', recordType, { label: '条件成立值' }),
      port('whenFalse', recordType, { label: '条件不成立值' }),
    ],
    outputs: [port('value', recordType, { label: '选择值' })],
    inputValueTypeBindings: {
      whenTrue: { parameter: 'valueType' },
      whenFalse: { parameter: 'valueType' },
    },
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [parameter('valueType', stringType, { label: '值类型', default: 'string' })],
    allowedSurfaces: SURFACES,
    effects: PURE,
    lower: ctx => `(${input(ctx, 'condition')} ? ${input(ctx, 'whenTrue')} : ${input(ctx, 'whenFalse')})`,
    ui: { category: 'logic', authoring: 'standard' },
  }),
  define({
    id: 'value.coalesce', version: '1', label: '空值回退',
    description: '在可空值和同类型默认值之间选择；仅空值触发回退，零和空文本保持原值。',
    inputs: [
      port('value', recordType, { nullable: true, label: '可空值' }),
      port('defaultValue', recordType, { label: '默认值' }),
    ],
    outputs: [port('value', recordType, { label: '结果' })],
    inputValueTypeBindings: {
      value: { parameter: 'valueType', nullable: true },
      defaultValue: { parameter: 'valueType' },
    },
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [parameter('valueType', stringType, { label: '值类型' })],
    allowedSurfaces: SURFACES,
    effects: PURE,
    inspectReferences: ['value', 'defaultValue'],
    lower: ctx => `(function(value, defaultValue){if(value===__gameplayInvalid||defaultValue===__gameplayInvalid)return __gameplayInvalid;var result=value==null?defaultValue:value;return {value:result};})(${input(ctx, 'value')}, ${input(ctx, 'defaultValue')})`,
    ui: { category: 'value', authoring: 'standard' },
  }),
  define({
    id: 'compare.values', version: '1', label: '比较值',
    description: '按封闭值类型对两个值执行严格相等或不相等比较；不允许跨类型比较。',
    inputs: [
      port('left', recordType, { label: '左值' }),
      port('right', recordType, { label: '右值' }),
    ],
    outputs: [port('value', booleanType, { label: '比较结果' })],
    inspectReferences: ['left', 'right'],
    inputValueTypeBindings: {
      left: { parameter: 'valueType' },
      right: { parameter: 'valueType' },
    },
    parameters: [
      parameter('valueType', stringType, { label: '值类型', default: 'string' }),
      parameter('operator', stringType, { label: '运算符', enum: ['==', '!='], default: '==' }),
    ],
    allowedSurfaces: SURFACES,
    effects: PURE,
    lower: ctx => `(${input(ctx, 'left')} ${comparisonOperator(ctx)} ${input(ctx, 'right')})`,
    ui: { category: 'logic', authoring: 'standard' },
  }),
  define({
    id: 'text.starts-with', version: '1', label: '文本前缀匹配',
    description: '判断可空文本是否以给定文本开头；空值返回 false。',
    inputs: [port('text', stringType, { nullable: true, label: '文本' }), port('value', stringType, { label: '前缀' })],
    outputs: [port('value', booleanType, { label: '匹配结果' })],
    allowedSurfaces: SURFACES,
    effects: PURE,
    lower: ctx => `(${input(ctx, 'text')} != null && ${input(ctx, 'text')}.startsWith(${input(ctx, 'value')}))`,
    ui: { category: 'text', authoring: 'standard' },
  }),
  define({
    id: 'text.contains', version: '1', label: '文本包含匹配',
    description: '判断可空文本是否包含给定文本；空值返回 false。',
    inputs: [port('text', stringType, { nullable: true, label: '文本' }), port('value', stringType, { label: '查找文本' })],
    outputs: [port('value', booleanType, { label: '匹配结果' })],
    allowedSurfaces: SURFACES,
    effects: PURE,
    lower: ctx => `(${input(ctx, 'text')} != null && ${input(ctx, 'text')}.includes(${input(ctx, 'value')}))`,
    ui: { category: 'text', authoring: 'standard' },
  }),
  define({
    id: 'collection.distinct', version: '1', label: '集合去重',
    description: '按稳定的 SameValueZero 身份保留集合首次出现的值。',
    inputs: [port('items', listRecordType, { label: '集合' })],
    outputs: [port('value', listRecordType, { label: '去重集合' })],
    inputValueTypeBindings: { items: { parameter: 'valueType' } },
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [parameter('valueType', stringType, { label: '集合类型', default: '{"kind":"list","element":"string"}' })],
    allowedSurfaces: SURFACES,
    effects: PURE,
    lower: ctx => `(function(items){if(!Array.isArray(items))return [];var seen=new Set();var result=[];for(var index=0;index<items.length;index+=1){var value=items[index];if(!seen.has(value)){seen.add(value);result.push(value);}}return result;})(${input(ctx, 'items')})`,
    ui: { category: 'collection', authoring: 'standard' },
  }),
])

export const GENERIC_VALUE_MODULES = GENERIC_VALUE_GAMEPLAY_MODULES
export const genericValueGameplayModuleDescriptors = GENERIC_VALUE_GAMEPLAY_MODULES

/** Compatibility IDs retired by atomic-migration-values. */
export const ATOMIC_VALUE_MODULES = new Set([
  'list.count', 'list.count-pieces', 'list.count-cells', 'list.count-choices', 'collection.piece-count',
  'list.join', 'value.select-number', 'logic.select-number', 'value.select-text', 'text.optional-fragment',
  'collection.contains-piece', 'collection.contains-string', 'list.has-duplicate', 'list.all-in', 'collection.all-in-strings',
  'compare.equal', 'compare.not-equal', 'compare.equal-string', 'compare.not-equal-string',
  'compare.equal-boolean', 'compare.not-equal-boolean', 'compare.equal-piece', 'compare.not-equal-piece',
  'compare.equal-player', 'compare.not-equal-player', 'compare.equal-string-nullable', 'compare.equal-piece-nullable',
  'compare.text', 'compare.player-reference', 'value.present-string', 'value.present-cell', 'piece.reference-present',
  'source.is-present', 'card.piece-present', 'card.string-present',
  'spatial.cell-in-list', 'spatial.cell-adjacent', 'spatial.cell-equal', 'spatial.cell-delta',
  'list.first-piece', 'collection.first-cell', 'collection.piece-at',
])
export const ATOMIC_VALUE_MODULE_IDS = ATOMIC_VALUE_MODULES
