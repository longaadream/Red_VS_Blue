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
 * Closed host boundaries used by Rafaam's generated curse cards.
 *
 * A curse rule may create a card only from the registered semantic sample.
 * The binding is deliberately limited to the two values that the old card
 * stored on the generated definition: damageAmount and sourcePieceId.  The
 * card graph reads those values through the same closed facade and delegates
 * damage attribution/source fallback to the host.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['rule', 'card']
const ruleAndCard: readonly GameplayModuleSurface[] = ACTIVE
const numberType: GameplayValueType = 'number'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const booleanType: GameplayValueType = 'boolean'
const recordType: GameplayValueType = 'record'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const write = (writes: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes, events })
const read = (reads: readonly string[]): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const runtime = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || !value) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const text = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}
const number = (ctx: GameplayNativeLoweringContext, name: string, fallback?: number): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}
const enumText = <T extends string>(ctx: GameplayNativeLoweringContext, name: string, values: readonly T[], fallback?: T): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`module ${ctx.moduleId}: parameter ${name} has an unsupported value`)
  return ctx.emitLiteral(value)
}

const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? ruleAndCard,
  ...value,
})

export const RAFAAM_CURSE_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'content.card-number',
    label: '读取生成卡牌数值',
    description: '读取受信动态卡牌模板登记的数值字段；字段名只能使用 Rafaam 模板登记的 damageAmount。',
    inputs: [port('cardId', stringType)],
    outputs: [port('value', numberType)],
    parameters: [parameter('field', stringType, { enum: ['damageAmount'] }), parameter('fallback', numberType, { default: 0 })],
    allowedSurfaces: ruleAndCard,
    effects: read(['content']),
    lower: ctx => `${runtime(ctx)}.content.cardNumber(${input(ctx, 'cardId')}, ${enumText(ctx, 'field', ['damageAmount'] as const)}, ${number(ctx, 'fallback', 0)})`,
    ui: { category: 'content' },
  }),
  define({
    id: 'content.materialize-curse-template',
    label: '实例化诅咒卡模板',
    description: '从已验证的 Rafaam 诅咒样本图创建动态卡牌，并仅绑定伤害值与来源棋子。',
    inputs: [
      port('templateId', stringType), port('cardId', stringType), port('name', stringType),
      port('description', stringType), port('owner', playerType, { nullable: true, optional: true }),
      port('damageAmount', numberType), port('sourcePieceId', pieceType, { nullable: true }),
    ],
    outputs: [port('cardId', stringType), port('success', booleanType)],
    allowedSurfaces: ['rule'],
    effects: write(['content'], ['contentCardMaterialized']),
    lower: ctx => `${runtime(ctx)}.content.materializeCurseTemplate({templateId:${input(ctx, 'templateId')},cardId:${input(ctx, 'cardId')},name:${input(ctx, 'name')},description:${input(ctx, 'description')},owner:${ctx.inputs.owner ?? 'null'},damageAmount:${input(ctx, 'damageAmount')},sourcePieceId:${input(ctx, 'sourcePieceId')}})`,
    ui: { category: 'content' },
  }),
  define({
    id: 'card.current-id',
    label: '读取当前动态卡牌标识',
    description: '读取当前卡牌执行上下文中的不透明定义标识。',
    inputs: [],
    outputs: [port('cardId', stringType)],
    allowedSurfaces: ['card'],
    effects: read(['context']),
    lower: ctx => `${runtime(ctx)}.cards.currentId()`,
    ui: { category: 'context' },
  }),
  define({
    id: 'card.current-type',
    label: '读取当前卡牌触发类型',
    description: '读取卡牌执行上下文的触发类型，供使用时弃置与回合结束效果分流。',
    inputs: [],
    outputs: [port('type', stringType)],
    allowedSurfaces: ['card'],
    effects: read(['context']),
    lower: ctx => `${runtime(ctx)}.cards.currentType()`,
    ui: { category: 'context' },
  }),
  define({
    id: 'effect.card-damage',
    label: '结算生成卡牌伤害',
    description: '用动态卡牌登记的来源；来源离场时由宿主按冻结规则退化为目标棋子，并保留跳过前置事件的旧卡牌语义。',
    inputs: [port('cardId', stringType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('result', recordType), port('success', booleanType), port('damage', numberType)],
    parameters: [parameter('damageType', stringType, { enum: ['true'] }), parameter('skillId', stringType)],
    allowedSurfaces: ['card'],
    effects: write(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const call = `${runtime(ctx)}.effects.cardDamage(${input(ctx, 'cardId')}, ${input(ctx, 'target')}, ${input(ctx, 'amount')}, ${enumText(ctx, 'damageType', ['true'] as const)}, ${text(ctx, 'skillId')})`
      return `(function(value){return {result:value,success:value&&value.success,damage:value&&(value.damage===undefined?value.totalDamage:value.damage)}})(${call})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'effect.damage-with-killer-typed',
    label: '以指定归属提交类型伤害',
    description: '保留规则旧内容的伤害类型拼写和击杀归属；类型和输入策略均为封闭参数。',
    inputs: [port('source', pieceType), port('target', pieceType), port('amount', numberType), port('killerPlayer', playerType, { nullable: true })],
    outputs: [port('result', recordType), port('success', booleanType), port('damage', numberType)],
    parameters: [parameter('damageType', stringType, { enum: ['physical', 'magical', 'true', 'toxin'], default: 'physical' }), parameter('skillId', stringType), parameter('inputPolicy', stringType, { enum: ['floor', 'host'], default: 'floor' })],
    allowedSurfaces: ['rule'],
    effects: write(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const call = `${runtime(ctx)}.effects.damageWithKillerTyped(${input(ctx, 'source')},${input(ctx, 'target')},${input(ctx, 'amount')},${enumText(ctx, 'damageType', ['physical', 'magical', 'true', 'toxin'] as const, 'physical')},${text(ctx, 'skillId')},${input(ctx, 'killerPlayer')},${enumText(ctx, 'inputPolicy', ['floor', 'host'] as const, 'floor')})`
      return `(function(value){return {result:value,success:value&&value.success,damage:value&&(value.damage===undefined?value.totalDamage:value.damage)}})(${call})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'result.card-action',
    label: '构造卡牌行动结果',
    description: '构造 success/message，并在回合结束触发时显式保留动态诅咒卡。',
    inputs: [port('success', booleanType), port('message', stringType, { optional: true })],
    outputs: [port('result', recordType)],
    parameters: [parameter('keepInHand', booleanType, { default: false })],
    allowedSurfaces: ['card'],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `({success:${input(ctx, 'success')}${ctx.inputs.message === undefined ? '' : `,message:${input(ctx, 'message')}`}${ctx.parameters.keepInHand === true ? ',keepInHand:true' : ''}})`,
    ui: { category: 'result' },
  }),
])
