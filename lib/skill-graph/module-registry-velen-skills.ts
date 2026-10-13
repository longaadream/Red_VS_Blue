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
 * Small, typed card and choice adapters used by Velen's three hand skills.
 *
 * The skill graphs own the ordinary-card branches, labels, limits and content
 * records.  These descriptors only expose stable card ids and the explicitly
 * registered content fields; no card object or arbitrary content path escapes
 * into an author graph.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const PURE: readonly GameplayModuleSurface[] = [...ACTIVE, 'preview']
const playerType: GameplayValueType = 'player'
const stringType: GameplayValueType = 'string'
const booleanType: GameplayValueType = 'boolean'
const numberType: GameplayValueType = 'number'
const choiceType: GameplayValueType = 'choice'
const stringListType: GameplayValueType = { kind: 'list', element: stringType }
const prophecyRecordType: GameplayValueType = { kind: 'record', schema: 'velen-holy-prophecy@1' }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const literal = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (value === undefined) throw new Error(`module ${ctx.moduleId}: missing parameter ${name}`)
  return ctx.emitLiteral(value)
}
const optionalLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback: string): string =>
  Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? literal(ctx, name) : fallback
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value,
})

export const VELEN_SKILLS_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'card.hand-instances',
    label: '查询玩家手牌实例',
    description: '按当前手牌顺序返回稳定实例标识；不把可变卡牌对象暴露给作者图。可选卡牌定义标识用于受限筛选。',
    inputs: [port('player', playerType)],
    outputs: [port('cards', stringListType)],
    parameters: [parameter('cardId', stringType, { optional: true })],
    allowedSurfaces: ACTIVE,
    effects: pure(['hand', 'players']),
    lower: ctx => {
      const cardId = optionalLiteral(ctx, 'cardId', 'null')
      return `(function(playerId,cardId){var hand=${flow(ctx)}.cards.hand(playerId);return(Array.isArray(hand)?hand:[]).filter(function(card){return card&&(cardId===null||card.cardId===cardId);}).map(function(card){return card.instanceId;});})(${input(ctx, 'player')},${cardId})`
    },
    ui: { category: 'card' },
  }),
  define({
    id: 'card.read-definition-name',
    label: '读取手牌名称',
    description: '读取手牌实例的显示名称；缺少或空名称时返回空值，由作者图决定回退文本。',
    inputs: [port('player', playerType), port('card', stringType)],
    outputs: [port('name', stringType, { nullable: true })],
    allowedSurfaces: ACTIVE,
    effects: pure(['hand', 'content']),
    lower: ctx => `(function(playerId,instanceId){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;});return card&&card.name?String(card.name):null;})(${input(ctx, 'player')},${input(ctx, 'card')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'card.read-content-boolean',
    label: '读取手牌内容声明',
    description: '读取登记过的手牌 contentState 布尔声明；字段集合封闭，不能访问任意对象路径。',
    inputs: [port('player', playerType), port('card', stringType)],
    outputs: [port('value', booleanType)],
    parameters: [parameter('field', stringType, { enum: ['velenHolyProphecy', 'velenHolyProphecyEnhanced'] })],
    allowedSurfaces: ACTIVE,
    effects: pure(['hand', 'content']),
    lower: ctx => `(function(playerId,instanceId,field){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;}),state=card&&card.contentState;return Boolean(state&&state[field]);})(${input(ctx, 'player')},${input(ctx, 'card')},${literal(ctx, 'field')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'card.set-content-record',
    label: '写入手牌内容记录',
    description: '写入一个登记过的结构化内容声明；只复制声明 schema 中的来源与回合字段。',
    inputs: [port('player', playerType), port('card', stringType), port('record', prophecyRecordType)],
    outputs: [port('success', booleanType)],
    parameters: [parameter('field', stringType, { enum: ['velenHolyProphecy'] })],
    allowedSurfaces: ACTIVE,
    effects: writes(['hand', 'content']),
    lower: ctx => `(function(playerId,instanceId,field,record){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;});if(!card)return false;if(!card.contentState)card.contentState={};card.contentState[field]={sourcePieceId:record.sourcePieceId,createdTurnNumber:record.createdTurnNumber};return true;})(${input(ctx, 'player')},${input(ctx, 'card')},${literal(ctx, 'field')},${input(ctx, 'record')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'choice.hand-cards',
    label: '选择手牌实例',
    description: '使用现有手牌选项协议呈现稳定实例标识和作者图提供的标签；选择恢复与校验仍由权威宿主处理。',
    inputs: [port('player', playerType), port('cards', stringListType), port('labels', stringListType)],
    outputs: [port('choice', choiceType, { nullable: true, optional: true })],
    parameters: [
      parameter('title', stringType),
      parameter('selectionMode', stringType, { enum: ['single', 'multi'] }),
      parameter('minSelections', numberType, { minimum: 1 }),
      parameter('maxSelections', numberType, { minimum: 1 }),
    ],
    allowedSurfaces: ['skill', 'card', 'pending'],
    effects: writes(['pending'], ['pendingOptionSelection']),
    lower: ctx => {
      const selectionMode = literal(ctx, 'selectionMode')
      const canCancel = optionalLiteral(ctx, 'canCancel', 'undefined')
      return `${flow(ctx)}.choice.option({title:${literal(ctx, 'title')},options:(${input(ctx, 'cards')}).map(function(value,index){return{label:${input(ctx, 'labels')}[index]===undefined?value:${input(ctx, 'labels')}[index],value:value};}),selectionMode:${selectionMode},presentation:"hand",minSelections:${literal(ctx, 'minSelections')},maxSelections:${literal(ctx, 'maxSelections')}${canCancel === 'undefined' ? '' : `,canCancel:${canCancel}`}})`
    },
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.is-strict-string-list',
    label: '检查严格文本多选',
    description: '判断多选结果是否为元素全部是原始字符串的数组，不接受对象包装、数字或混合元素。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('value', booleanType)],
    allowedSurfaces: PURE,
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(Array.isArray(${input(ctx, 'choice')})&&${input(ctx, 'choice')}.every(function(item){return typeof item === "string";}))`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.strict-string',
    label: '读取严格文本选项',
    description: '只接受原始字符串选项；对象、数字和其他包装值保持无效，不自动解包或转文本。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('text', stringType)],
    allowedSurfaces: PURE,
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(typeof ${input(ctx, 'choice')} === "string" ? ${input(ctx, 'choice')} : "")`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.strict-string-list',
    label: '读取严格文本多选',
    description: '只接受元素全部为原始字符串的数组；对象、数字、混合数组和包装数组保持无效。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('values', stringListType)],
    allowedSurfaces: PURE,
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(function(value){return Array.isArray(value)&&value.every(function(item){return typeof item === "string";})?value:[];})(${input(ctx, 'choice')})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.is-array',
    label: '检查多选数组',
    description: '严格判断选项结果是否为数组，保留旧多选技能对非数组结果的失败分支。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('value', booleanType)],
    allowedSurfaces: PURE,
    effects: { pure: true, previewSafe: true },
    lower: ctx => `Array.isArray(${input(ctx, 'choice')})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'collection.contains-string',
    label: '检查文本集合成员',
    description: '按严格文本标识判断集合是否包含一个值。',
    inputs: [port('items', stringListType), port('value', stringType)],
    outputs: [port('contains', booleanType)],
    allowedSurfaces: PURE,
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(Array.isArray(${input(ctx, 'items')})&&${input(ctx, 'items')}.indexOf(${input(ctx, 'value')})!==-1)`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'collection.all-in-strings',
    label: '检查文本集合均在允许集合中',
    description: '按严格文本标识判断每个选择是否仍属于当前有效候选集合。',
    inputs: [port('items', stringListType), port('allowed', stringListType)],
    outputs: [port('valid', booleanType)],
    allowedSurfaces: PURE,
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(Array.isArray(${input(ctx, 'items')})&&Array.isArray(${input(ctx, 'allowed')})&&${input(ctx, 'items')}.every(function(value){return ${input(ctx, 'allowed')}.indexOf(value)!==-1;}))`,
    ui: { category: 'collection' },
  }),
])
