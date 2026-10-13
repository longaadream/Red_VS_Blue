import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Small author-facing interaction primitives.
 *
 * These descriptors deliberately do not expose the legacy `choice` result
 * envelope.  A choice node returns the selected value, and a target node
 * returns the selected entity directly.  The host still owns pending-session
 * creation and validation; the graph only declares the one interaction and
 * its constraints.
 */

const VERSION = '1' as const
const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = [
  'skill', 'card', 'rule', 'triggerSkill', 'pending',
]

const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const recordType: GameplayValueType = 'record'
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'

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

const writes = (
  domains: readonly string[],
  events: readonly string[] = [],
): GameplayEffectMetadata => ({
  pure: false,
  previewSafe: false,
  pending: true,
  writes: domains,
  events,
})

const flow = (ctx: GameplayNativeLoweringContext): string => (
  ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
)

const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  }
  return value
}

const stringLiteral = (
  ctx: GameplayNativeLoweringContext,
  name: string,
  fallback?: string,
): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name)
    ? ctx.parameters[name]
    : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}

const enumLiteral = <T extends string>(
  ctx: GameplayNativeLoweringContext,
  name: string,
  values: readonly T[],
  fallback: T,
): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name)
    ? ctx.parameters[name]
    : fallback
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`module ${ctx.moduleId}: parameter ${name} has an unsupported value`)
  }
  return ctx.emitLiteral(value)
}

const numberLiteral = (
  ctx: GameplayNativeLoweringContext,
  name: string,
  fallback: number,
): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name)
    ? ctx.parameters[name]
    : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  }
  return ctx.emitLiteral(value)
}

const booleanLiteral = (
  ctx: GameplayNativeLoweringContext,
  name: string,
  fallback: boolean,
): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name)
    ? ctx.parameters[name]
    : fallback
  if (typeof value !== 'boolean') {
    throw new Error(`module ${ctx.moduleId}: parameter ${name} must be boolean`)
  }
  return ctx.emitLiteral(value)
}

const optionalField = (
  ctx: GameplayNativeLoweringContext,
  name: string,
  render: () => string,
): string => Object.prototype.hasOwnProperty.call(ctx.parameters, name)
  ? `, ${name}: ${render()}`
  : ''

const define = (
  value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & {
    readonly allowedSurfaces?: readonly GameplayModuleSurface[]
  },
): GameplayModuleDescriptor => ({
  version: VERSION,
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE_SURFACES,
  ...value,
})

function targetLowering(
  ctx: GameplayNativeLoweringContext,
  targetType: 'piece' | 'grid',
  defaultFilter: 'enemy' | 'ally' | 'all',
): string {
  const range = numberLiteral(ctx, 'range', 5)
  const filter = enumLiteral(ctx, 'filter', ['enemy', 'ally', 'all'] as const, defaultFilter)
  const title = optionalField(ctx, 'title', () => stringLiteral(ctx, 'title'))
  const canCancel = optionalField(ctx, 'canCancel', () => booleanLiteral(ctx, 'canCancel', false))
  const cellConstraints = targetType === 'grid'
    ? `, requireWalkable: ${booleanLiteral(ctx, 'requireWalkable', true)}, requireUnoccupied: ${booleanLiteral(ctx, 'requireUnoccupied', true)}`
    : ''
  const selected = `${flow(ctx)}.choice.authorTarget({type: ${ctx.emitLiteral(targetType)}, range: ${range}, filter: ${filter}${title}${canCancel}${cellConstraints}}, ${ctx.emitLiteral(ctx.callId)})`
  if (targetType === 'piece') {
    // Piece ports are opaque instance IDs. The active selector returns a
    // PieceInstance, while pending host bindings already carry its ID.
    return `(function(value){var id = value && typeof value === "object" ? value.instanceId : value; return ${flow(ctx)}.values.require(id, "piece", []);})(${selected})`
  }
  return `(function(value){return ${flow(ctx)}.values.require(value, "cell", []);})(${selected})`
}

const AUTHOR_CHOICE_MODULES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'author.choice.option',
    label: '选择选项值',
    description: '按“显示文本→值”映射打开单选器并直接返回声明类型的选项值。显示文本只用于界面，业务分支使用返回值。',
    inputs: [port('options', recordType, { label: '选项映射' }), port('cancelValue', recordType, { label: '取消后继续并返回', optional: true })],
    inputValueTypeBindings: { cancelValue: { parameter: 'valueType' } },
    outputs: [port('value', recordType, { label: '选中值' })],
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [
      parameter('valueType', stringType, { label: '返回值类型', default: 'string' }),
      parameter('title', stringType, { label: '选择提示', optional: true }),
      parameter('canCancel', booleanType, { label: '允许取消', default: false }),
    ],
    effects: writes(['pending'], ['pendingOptionSelection']),
    lower: ctx => {
      const options = input(ctx, 'options')
      const title = optionalField(ctx, 'title', () => stringLiteral(ctx, 'title'))
      const canCancel = `, canCancel: ${booleanLiteral(ctx, 'canCancel', false)}`
      // The map key is presentation text.  Values are passed through without
      // string coercion so booleans, numbers, records, and entity references
      // retain the declared output type.
      const mapped = `(function(values){return Object.keys(values || {}).map(function(label){return {label: label, value: values[label]};});})(${options})`
      const cancelValue = ctx.inputs.cancelValue === undefined ? '' : `, cancelValue: ${ctx.inputs.cancelValue}`
      const selected = `${flow(ctx)}.choice.authorOption({options: ${mapped}${title}${canCancel}${cancelValue}}, ${ctx.emitLiteral(ctx.callId)})`
      const declaredType = stringLiteral(ctx, 'valueType', 'string')
      const type = `(function(raw){return typeof raw === "string" && raw.trim().startsWith("{") ? JSON.parse(raw) : raw;})(${declaredType})`
      const schemas = JSON.stringify(ctx.recordSchemas ?? [])
      // Selection markers are control values owned by the suspendable host.
      // Throw before the next authored statement so the host can suspend and
      // replay the graph without executing later side effects. Validate only a
      // completed answer so a failed answer cannot masquerade as the declared
      // author type.
      // The compiler uses the single-output `value` envelope when a native
      // result is consumed through a port. Keep the envelope explicit so a
      // legitimate selected record that itself owns a `value` field is not
      // mistaken for the module result wrapper.
      return `(function(value){return {value: ${flow(ctx)}.values.require(value, ${type}, ${schemas})};})(${selected})`
    },
    ui: { category: 'choice', authoring: 'standard' },
  }),
  define({
    id: 'author.choice.target-piece',
    label: '选择棋子目标',
    description: '按一次声明的范围、阵营和取消约束选择一个棋子；目标失效时由权威目标引擎拒绝本次语句。',
    inputs: [],
    outputs: [port('piece', pieceType, { label: '棋子目标' })],
    parameters: [
      parameter('range', numberType, { label: '范围（格）', default: 5, minimum: 0 }),
      parameter('filter', stringType, { label: '阵营筛选', enum: ['enemy', 'ally', 'all'], default: 'enemy' }),
      parameter('title', stringType, { label: '选择提示', optional: true }),
      parameter('canCancel', booleanType, { label: '允许取消', default: false }),
    ],
    effects: writes(['pending'], ['pendingTargetSelection']),
    lower: ctx => targetLowering(ctx, 'piece', 'enemy'),
    ui: { category: 'choice', authoring: 'standard' },
  }),
  define({
    id: 'author.choice.target-cell',
    label: '选择地格目标',
    description: '按一次声明的范围、筛选和取消约束选择一个地格；坐标和占用合法性由权威目标引擎校验。',
    inputs: [],
    outputs: [port('cell', cellType, { label: '地格目标' })],
    parameters: [
      parameter('range', numberType, { label: '范围（格）', default: 5, minimum: 0 }),
      parameter('filter', stringType, { label: '地格筛选', enum: ['enemy', 'ally', 'all'], default: 'all' }),
      parameter('requireWalkable', booleanType, { label: '必须可行走', default: true }),
      parameter('requireUnoccupied', booleanType, { label: '必须为空地', default: true }),
      parameter('title', stringType, { label: '选择提示', optional: true }),
      parameter('canCancel', booleanType, { label: '允许取消', default: false }),
    ],
    effects: writes(['pending'], ['pendingTargetSelection']),
    lower: ctx => targetLowering(ctx, 'grid', 'all'),
    ui: { category: 'choice', authoring: 'standard' },
  }),
]

const AUTHOR_DAMAGE_MODULES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'author.effect.damage',
    label: '造成伤害',
    description: '通过权威伤害流程造成普通或真实伤害并返回本次结算结果；毒素及其他历史分类不属于新的作者接口。',
    inputs: [port('source', pieceType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('result', recordType), port('success', booleanType), port('damage', numberType)],
    parameters: [
      parameter('damageType', stringType, { label: '伤害类型', enum: ['normal', 'true'], default: 'normal' }),
      parameter('skillId', stringType, { label: '技能标识', optional: true }),
    ],
    effects: {
      pure: false,
      previewSafe: false,
      writes: ['damage', 'events'],
      events: ['beforeDamageDealt', 'afterDamageDealt'],
    },
    lower: ctx => {
      const kind = enumLiteral(ctx, 'damageType', ['normal', 'true'] as const, 'normal')
      const engineKind = kind === '"normal"' ? '"physical"' : '"true"'
      const skill = Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId')
        ? stringLiteral(ctx, 'skillId')
        : `${ctx.surface === 'pending' ? 'ctx' : 'context'}.skill?.id || ${ctx.surface === 'pending' ? 'ctx' : 'context'}.ruleId || "flow"`
      const target = input(ctx, 'target')
      // Active selectors return a PieceInstance while pending host bindings
      // carry an instance id. Normalize both at this trusted boundary before
      // entering the engine's target-id API.
      const targetId = `((${target}) && typeof (${target}) === "object" ? (${target}).instanceId : (${target}))`
      const call = `${flow(ctx)}.effects.damage(${input(ctx, 'source')}, ${targetId}, ${input(ctx, 'amount')}, ${engineKind}, ${skill})`
      return `(function(value){return {result: value, success: Boolean(value && value.success === true), damage: value && Number.isFinite(Number(value.damage)) ? Number(value.damage) : 0};})(${call})`
    },
    ui: { category: 'effect', authoring: 'standard' },
  }),
]

export const AUTHOR_CHOICE_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  ...AUTHOR_CHOICE_MODULES,
  define({
    id: 'choice.options', label: '显示选项',
    description: '将有序选项记录交给选择宿主；未提供的约束保持宿主默认值。选项数量不限于两个。',
    inputs: [port('options', { kind: 'list', element: recordType }, { label: '选项' }),
      port('title', stringType, { label: '提示', optional: true }),
      port('playerId', 'player', { label: '选择玩家', nullable: true, optional: true }),
      port('selectionMode', stringType, { label: '选择形式', optional: true }),
      port('minSelections', numberType, { label: '最少数量', optional: true }),
      port('maxSelections', numberType, { label: '最多数量', optional: true }),
      port('canCancel', booleanType, { label: '允许中止', optional: true }),
      port('cancelValue', stringType, { label: '中止返回值', optional: true })],
    outputs: [port('choice', 'choice', { label: '选择结果' })],
    effects: writes(['pending'], ['pendingOptionSelection']),
    lower: ctx => `${flow(ctx)}.choice.option({${Object.entries(ctx.inputs).map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}})`,
    ui: { category: 'choice', authoring: 'standard' },
  }),
  {
    id: 'author.choice.option', version: '2', label: '选择选项值',
    description: '从显示文本与值的映射选择，数量统一使用最少与最多；多选按点击顺序返回元组，允许不同选项具有相同值。',
    inputs: [port('options', recordType, { label: '选项映射' }), port('player', 'player', { label: '选择玩家', optional: true }), port('minSelections', numberType, { label: '最少数量', optional: true }), port('maxSelections', numberType, { label: '最多数量', optional: true }), port('cancelValue', recordType, { label: '取消后继续并返回', optional: true })],
    inputValueTypeBindings: { cancelValue: { parameter: 'valueType' } },
    outputs: [port('value', recordType, { label: '选中值' })],
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [parameter('valueType', stringType, { label: '返回值类型', default: 'string' }), parameter('selectionMode', stringType, { label: '返回形式', enum: ['single', 'multi'], default: 'single' }), parameter('title', stringType, { label: '选择提示', default: '请选择' }), parameter('canCancel', booleanType, { label: '允许中止本次效果', default: false })],
    allowedSurfaces: ACTIVE_SURFACES, effects: writes(['pending'], ['pendingOptionSelection']), ui: { category: 'selection', authoring: 'standard' },
    lower: ctx => {
      const raw = ctx.parameters.valueType ?? 'string'
      const type = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) as GameplayValueType : raw as GameplayValueType
      const multi = ctx.parameters.selectionMode === 'multi'
      if (multi && (typeof type !== 'object' || type.kind !== 'list')) throw new Error('多选返回值必须是元组类型')
      const config = `{ options: Object.keys(${ctx.inputs.options}).map(function(label){return {label:label,value:${ctx.inputs.options}[label]};}), indexed:true, selectionMode:${ctx.emitLiteral(multi ? 'multi' : 'single')}, minSelections:${ctx.inputs.minSelections ?? '1'}, maxSelections:${ctx.inputs.maxSelections ?? '1'}, title:${ctx.emitLiteral(ctx.parameters.title ?? '请选择')}, canCancel:${ctx.emitLiteral(ctx.parameters.canCancel ?? false)}${ctx.inputs.player ? `,playerId:${ctx.inputs.player}` : ''}${ctx.inputs.cancelValue === undefined ? '' : `,cancelValue:${ctx.inputs.cancelValue}`} }`
      return `({value:${flow(ctx)}.values.require(${flow(ctx)}.choice.authorOption(${config},${ctx.emitLiteral(ctx.callId)}),${JSON.stringify(type)},${JSON.stringify(ctx.recordSchemas ?? [])})})`
    },
  },
  ...AUTHOR_DAMAGE_MODULES,
  {
    id: 'author.choice.option', version: '3', label: '选择选项值',
    description: '从映射中选择：文本键作为显示文字，值作为返回结果。多选按点击顺序返回元组，数量由最少和最多共同限制。',
    inputs: [port('options', recordType, { label: '选项映射' }), port('player', 'player', { label: '选择玩家', optional: true }), port('minSelections', numberType, { label: '最少数量', optional: true }), port('maxSelections', numberType, { label: '最多数量', optional: true }), port('cancelValue', recordType, { label: '取消后继续并返回', optional: true })],
    inputValueTypeBindings: { options: { parameter: 'optionsType' }, cancelValue: { parameter: 'valueType' } },
    outputs: [port('value', recordType, { label: '选中值' })],
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [parameter('optionsType', stringType, { label: '选项映射类型', default: '{"kind":"map","key":"string","value":"string"}' }), parameter('valueType', stringType, { label: '返回值类型', default: 'string' }), parameter('selectionMode', stringType, { label: '返回形式', enum: ['single', 'multi'], default: 'single' }), parameter('title', stringType, { label: '选择提示', default: '请选择' }), parameter('canCancel', booleanType, { label: '允许中止本次效果', default: false })],
    allowedSurfaces: ACTIVE_SURFACES, effects: writes(['pending'], ['pendingOptionSelection']), ui: { category: 'selection', authoring: 'standard' },
    lower: ctx => {
      const parse = (raw: unknown): GameplayValueType => typeof raw === 'string' && raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw as GameplayValueType
      const optionsType = parse(ctx.parameters.optionsType ?? '{"kind":"map","key":"string","value":"string"}')
      if (typeof optionsType !== 'object' || optionsType.kind !== 'map' || optionsType.key !== 'string') throw new Error('选项必须是以文本为键的映射')
      const multi = ctx.parameters.selectionMode === 'multi'
      const type = parse(ctx.parameters.valueType ?? 'string')
      const expected: GameplayValueType = multi ? { kind: 'list', element: optionsType.value } : optionsType.value
      const canonical = (value: GameplayValueType): string => {
        if (typeof value === 'string') return value
        if (value.kind === 'list' || value.kind === 'set') return value.kind + '<' + canonical(value.element) + '>'
        if (value.kind === 'map') return 'map<' + canonical(value.key) + ',' + canonical(value.value) + '>'
        if (value.kind === 'nullable') return 'nullable<' + canonical(value.value) + '>'
        return 'record<' + value.schema + '>'
      }
      if (canonical(type) !== canonical(expected)) throw new Error('选择返回值类型必须与选项映射和返回形式一致')
      const checked = `${flow(ctx)}.values.require(${ctx.inputs.options},${JSON.stringify(optionsType)},${JSON.stringify(ctx.recordSchemas ?? [])})`
      const options = `${flow(ctx)}.containers.authorMapItems(${checked}).map(function(entry){return {label:entry[0],value:entry[1]};})`
      const config = `{options:${options},indexed:true,selectionMode:${ctx.emitLiteral(multi ? 'multi' : 'single')},minSelections:${ctx.inputs.minSelections ?? '1'},maxSelections:${ctx.inputs.maxSelections ?? '1'},title:${ctx.emitLiteral(ctx.parameters.title ?? '请选择')},canCancel:${ctx.emitLiteral(ctx.parameters.canCancel ?? false)}${ctx.inputs.player ? `,playerId:${ctx.inputs.player}` : ''}${ctx.inputs.cancelValue === undefined ? '' : `,cancelValue:${ctx.inputs.cancelValue}`}}`
      return `({value:${flow(ctx)}.values.require(${flow(ctx)}.choice.authorOption(${config},${ctx.emitLiteral(ctx.callId)}),${JSON.stringify(type)},${JSON.stringify(ctx.recordSchemas ?? [])})})`
    },
  },
])

export const authorChoiceGameplayModuleDescriptors = AUTHOR_CHOICE_GAMEPLAY_MODULES
