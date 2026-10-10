import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor as Descriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext as Context,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Generic status/rule primitives used by turn based status consumers.
 *
 * These adapters deliberately expose only typed status identifiers and
 * lifecycle operations.  In particular, duration/use fields are never
 * writable through a generic number setter; the host owns their lifecycle
 * accounting.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const PURE: readonly GameplayModuleSurface[] = ACTIVE
const PURE_VALUE: readonly GameplayModuleSurface[] = [...ACTIVE, 'preview']
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const choiceType: GameplayValueType = 'choice'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const pureValue = (): GameplayEffectMetadata => ({ pure: true, previewSafe: true })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): Descriptor => ({ version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value })
const flow = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'

const input = (ctx: Context, name: string, fallback?: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) {
    if (fallback !== undefined) return fallback
    throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  }
  return value
}

const stringLiteral = (ctx: Context, name: string, fallback?: string): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}

const numberLiteral = (ctx: Context, name: string, fallback?: number): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}

const enumLiteral = <T extends string>(ctx: Context, name: string, allowed: readonly T[], fallback?: T): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`module ${ctx.moduleId}: parameter ${name} has an unsupported value`)
  return ctx.emitLiteral(value)
}

const descriptors: readonly Descriptor[] = [
  define({
    id: 'value.present-string', label: '文本存在',
    description: '判断一个可空文本句柄是否存在。',
    inputs: [port('value', stringType, { nullable: true })], outputs: [port('present', booleanType)],
    allowedSurfaces: PURE_VALUE,
    effects: pureValue(),
    lower: ctx => `(${input(ctx, 'value')} !== null && ${input(ctx, 'value')} !== undefined)`,
    ui: { category: 'logic' },
  }),
  define({
    id: 'value.string-or-empty', label: '可空文本转空文本',
    description: '把缺失的登记文本值归一为空文本，供后续封闭模块处理。',
    inputs: [port('value', stringType, { nullable: true })], outputs: [port('text', stringType)],
    allowedSurfaces: PURE_VALUE,
    effects: pureValue(),
    lower: ctx => `((${input(ctx, 'value')}) == null ? "" : String(${input(ctx, 'value')}))`,
    ui: { category: 'value' },
  }),
  define({
    id: 'choice.option-id-value', label: '已选选项标识',
    description: '读取既有选项协议返回的字符串、id 或 value，归一为文本标识。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })], outputs: [port('text', stringType)],
    allowedSurfaces: PURE_VALUE,
    effects: pureValue(),
    lower: ctx => `(function(value) { if (typeof value === "string") return value; if (value && typeof value.id === "string") return value.id; if (value && typeof value.value === "string") return value.value; return ""; })(${input(ctx, 'choice')})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'status.find-id-by-id', label: '按标识查找状态',
    description: '按稳定状态标识读取状态句柄，不把可变状态对象暴露给作者图。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true, optional: true })], outputs: [port('id', stringType, { nullable: true })],
    parameters: [parameter('statusId', stringType, { optional: true })],
    allowedSurfaces: PURE,
    effects: pure(['statuses']),
    lower: ctx => {
      const statusId = ctx.inputs.statusId ?? (Object.prototype.hasOwnProperty.call(ctx.parameters, 'statusId') ? stringLiteral(ctx, 'statusId') : 'null')
      return `(function(pieceId, statusId) { var tags = (${flow(ctx)}.query.piece(pieceId).statusTags || []); var tag = tags.find(function(item) { return item && item.id === statusId; }); return tag ? tag.id : null; })(${input(ctx, 'piece')}, ${statusId})`
    },
    ui: { category: 'status' },
  }),
  define({
    id: 'status.find-id-by-prefix', label: '按标识前缀查找状态',
    description: '按稳定标识前缀读取首个状态句柄。',
    inputs: [port('piece', pieceType)], outputs: [port('id', stringType, { nullable: true })],
    parameters: [parameter('prefix', stringType)],
    allowedSurfaces: PURE,
    effects: pure(['statuses']),
    lower: ctx => `(function(pieceId, prefix) { var tags = (${flow(ctx)}.query.piece(pieceId).statusTags || []); var tag = tags.find(function(item) { return item && typeof item.id === "string" && item.id.indexOf(prefix) === 0; }); return tag ? tag.id : null; })(${input(ctx, 'piece')}, ${stringLiteral(ctx, 'prefix')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.find-id-by-number', label: '按状态数值查找状态',
    description: '按状态类型和登记的数值字段读取首个匹配状态句柄。',
    inputs: [port('piece', pieceType), port('value', numberType)], outputs: [port('id', stringType, { nullable: true })],
    parameters: [parameter('statusType', stringType), parameter('field', stringType, { enum: ['turnNumber'] })],
    allowedSurfaces: PURE,
    effects: pure(['statuses']),
    lower: ctx => `(function(pieceId, expected) { var tags = (${flow(ctx)}.query.piece(pieceId).statusTags || []); var field = ${enumLiteral(ctx, 'field', ['turnNumber'] as const)}; var tag = tags.find(function(item) { return item && item.type === ${stringLiteral(ctx, 'statusType')} && Number(item[field]) === Number(expected); }); return tag ? tag.id : null; })(${input(ctx, 'piece')}, ${input(ctx, 'value')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-reference', label: '读取状态关联棋子',
    description: '读取状态中登记的目标或来源棋子引用，并重新经过宿主存在性校验。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true })], outputs: [port('reference', pieceType, { nullable: true })],
    parameters: [parameter('field', stringType, { enum: ['targetId', 'sourceId'] })],
    allowedSurfaces: PURE,
    effects: pure(['statuses', 'pieces']),
    lower: ctx => `(function(pieceId, statusId) { if (statusId == null) return null; var tags = (${flow(ctx)}.query.piece(pieceId).statusTags || []); var tag = tags.find(function(item) { return item && item.id === statusId; }); var reference = tag && tag[${enumLiteral(ctx, 'field', ['targetId', 'sourceId'] as const)}]; return ${flow(ctx)}.query.hasPiece(reference) ? ${flow(ctx)}.query.piece(reference).instanceId : null; })(${input(ctx, 'piece')}, ${input(ctx, 'statusId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-number-truthy', label: '按旧规则真值读取状态数值',
    description: '保留旧规则的 `value || fallback` 语义；零值和其它假值使用回退值。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true }), port('fallback', numberType)], outputs: [port('value', numberType)],
    parameters: [parameter('field', stringType, { enum: ['intensity', 'stacks'] })],
    allowedSurfaces: PURE,
    effects: pure(['statuses']),
    lower: ctx => `(function(pieceId, statusId, fallback) { var tag = (${flow(ctx)}.query.piece(pieceId).statusTags || []).find(function(item) { return item && item.id === statusId; }); var raw = tag && tag[${enumLiteral(ctx, 'field', ['intensity', 'stacks'] as const)}]; return Number(raw || fallback); })(${input(ctx, 'piece')}, ${input(ctx, 'statusId')}, ${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-uses', label: '读取状态使用次数',
    description: '保留旧规则先读 remainingUses、缺失时再读 currentUses 的生命周期读取顺序。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true }), port('fallback', numberType)], outputs: [port('value', numberType)],
    allowedSurfaces: PURE,
    effects: pure(['statuses']),
    lower: ctx => `(function(pieceId, statusId, fallback) { var tag = (${flow(ctx)}.query.piece(pieceId).statusTags || []).find(function(item) { return item && item.id === statusId; }); var raw = tag && (tag.remainingUses !== undefined ? tag.remainingUses : (tag.currentUses !== undefined ? tag.currentUses : fallback)); return Number(raw); })(${input(ctx, 'piece')}, ${input(ctx, 'statusId')}, ${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-duration', label: '读取状态持续时间',
    description: '保留旧规则 remainingDuration 仅在 undefined 时回退 currentDuration 的生命周期读取顺序。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true }), port('fallback', numberType)], outputs: [port('value', numberType)],
    allowedSurfaces: PURE,
    effects: pure(['statuses']),
    lower: ctx => `(function(pieceId, statusId, fallback) { var tag = (${flow(ctx)}.query.piece(pieceId).statusTags || []).find(function(item) { return item && item.id === statusId; }); var raw = tag && (tag.remainingDuration === undefined ? tag.currentDuration : tag.remainingDuration); return raw === undefined ? Number(fallback) : Number(raw); })(${input(ctx, 'piece')}, ${input(ctx, 'statusId')}, ${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.consume-counter', label: '推进状态生命周期计数',
    description: '由状态宿主推进一个登记的生命周期计数，并返回推进后的数值。持续时间和使用次数不能通过通用状态数值设定器写入。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true })], outputs: [port('value', numberType)],
    parameters: [parameter('field', stringType, { enum: ['remainingTurns'] }), parameter('fallback', numberType, { default: 1 })],
    allowedSurfaces: ACTIVE,
    effects: writes(['statuses'], ['statusTicked']),
    lower: ctx => `${flow(ctx)}.status.consumeCounter(${input(ctx, 'piece')}, ${input(ctx, 'statusId')}, ${enumLiteral(ctx, 'field', ['remainingTurns'] as const)}, ${numberLiteral(ctx, 'fallback', 1)})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'skill.adjust-cooldown', label: '调整技能冷却',
    description: '通过技能生命周期按增加或至少设为两种语义调整已持有技能的冷却。',
    inputs: [port('piece', pieceType), port('skillId', stringType, { nullable: true }), port('amount', numberType)], outputs: [port('success', booleanType)],
    parameters: [parameter('mode', stringType, { enum: ['add', 'atLeast'] })],
    allowedSurfaces: ACTIVE,
    effects: writes(['skills'], ['skillCooldownChanged']),
    lower: ctx => `Boolean(${flow(ctx)}.skills.adjustCooldown(${input(ctx, 'piece')}, ${input(ctx, 'skillId')}, ${input(ctx, 'amount')}, ${enumLiteral(ctx, 'mode', ['add', 'atLeast'] as const)}))`,
    ui: { category: 'skill' },
  }),
  define({
    id: 'effect.damage-with-killer', label: '以指定归属提交伤害',
    description: '通过权威伤害批次提交伤害，并保留旧内容的击杀归属玩家。',
    inputs: [port('source', pieceType), port('target', pieceType), port('amount', numberType), port('killerPlayer', playerType, { nullable: true })],
    outputs: [port('result', 'record'), port('success', booleanType), port('damage', numberType)],
    parameters: [parameter('damageType', stringType, { enum: ['normal', 'true', 'toxin'], default: 'normal' }), parameter('skillId', stringType, { optional: true }), parameter('inputPolicy', stringType, { enum: ['floor', 'host'], optional: true })],
    allowedSurfaces: ACTIVE,
    effects: writes(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const type = enumLiteral(ctx, 'damageType', ['normal', 'true', 'toxin'] as const, 'normal')
      const engineType = type === '"normal"' ? '"physical"' : type
      const skillId = Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId') ? stringLiteral(ctx, 'skillId') : `${ctx.surface === 'pending' ? 'ctx' : 'context'}.skill?.id || ${ctx.surface === 'pending' ? 'ctx' : 'context'}.ruleId || "flow"`
      const policy = Object.prototype.hasOwnProperty.call(ctx.parameters, 'inputPolicy') ? `, ${enumLiteral(ctx, 'inputPolicy', ['floor', 'host'] as const)}` : ''
      const call = `${flow(ctx)}.effects.damageWithKiller(${input(ctx, 'source')}, ${input(ctx, 'target')}, ${input(ctx, 'amount')}, ${engineType}, ${skillId}, ${input(ctx, 'killerPlayer')}${policy})`
      return `(function(value){return {result: value, success: value && value.success, damage: value && (value.damage === undefined ? value.totalDamage : value.damage)}})(${call})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'choice.required-option-pair', label: '必选二元选项',
    description: '使用既有选项协议呈现一个不可取消的二元选择，并保留指定玩家。',
    inputs: [port('player', playerType, { nullable: true, optional: true }), port('title', stringType)], outputs: [port('choice', choiceType)],
    parameters: [parameter('firstLabel', stringType), parameter('firstValue', stringType), parameter('secondLabel', stringType), parameter('secondValue', stringType)],
    allowedSurfaces: ACTIVE,
    effects: writes(['pending'], ['pendingOptionSelection']),
    lower: ctx => `${flow(ctx)}.choice.option({title: ${input(ctx, 'title')}, options: [{id: ${stringLiteral(ctx, 'firstValue')}, label: ${stringLiteral(ctx, 'firstLabel')}}, {id: ${stringLiteral(ctx, 'secondValue')}, label: ${stringLiteral(ctx, 'secondLabel')}}], playerId: ${input(ctx, 'player', `${ctx.surface === 'pending' ? 'ctx' : 'context'}.playerId`)}, canCancel: false})`,
    ui: { category: 'choice' },
  }),
]

/** Registered by module-registry.ts after the migration is integrated. */
export const STATUS_TIMER_GAMEPLAY_MODULES: readonly Descriptor[] = Object.freeze(descriptors)

