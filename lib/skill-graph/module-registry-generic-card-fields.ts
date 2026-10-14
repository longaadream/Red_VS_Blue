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
 * Generic read-only views over a player's hand.  These descriptors deliberately
 * stop at card records and closed field selectors: author graphs never receive
 * the mutable hand or an arbitrary host property path.
 *
 * The hand view returns instance records in host order.  The migration recipe
 * maps those records back to the stable instance/definition ids required by
 * the retired card helpers.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const PURE: GameplayEffectMetadata = { pure: true, previewSafe: false }
const playerType: GameplayValueType = 'player'
const recordType: GameplayValueType = 'record'
const stringType: GameplayValueType = 'string'
const booleanType: GameplayValueType = 'boolean'
const pieceType: GameplayValueType = 'piece'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: pieceType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: recordType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: 'number' }
const handType: GameplayValueType = { kind: 'list', element: recordType }

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

const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>): GameplayModuleDescriptor => ({
  version: '1', allowedSurfaces: ACTIVE, ...value,
})

const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

const field = (ctx: GameplayNativeLoweringContext): string => {
  const value = ctx.parameters.field
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: field must be text`)
  return value
}

const literal = (ctx: GameplayNativeLoweringContext, value: string): string => ctx.emitLiteral(value)

const fieldBinding = (types: Readonly<Record<string, GameplayValueType>>) => ({
  value: { parameter: 'field', types },
})

const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'

const cardStringField = (record: string, selected: string): string =>
  `(function(value){if(value===undefined||value===null)return null;if(typeof value!=="string")return __gameplayInvalid;return value;})(${record}[${JSON.stringify(selected)}])`

const cardRecordField = (record: string, selected: string): string =>
  `(function(value){if(value===undefined||value===null)return null;if(typeof value!=="object"||Array.isArray(value))return __gameplayInvalid;return JSON.parse(JSON.stringify(value));})(${record}[${JSON.stringify(selected)}])`

function handLowering(ctx: GameplayNativeLoweringContext): string {
  const owner = input(ctx, 'player')
  const state = battle(ctx)
  return `(function(owner){var players=(${state}.players||[]);var player=owner==null?null:players.find(function(item){return item&&item.playerId===owner;});var hand=player&&Array.isArray(player.hand)?player.hand:null;if(!hand)return {cards:[],hasHand:false};return {cards:hand.map(function(card){return card;}),hasHand:true};})(${owner})`
}

function instanceFieldLowering(ctx: GameplayNativeLoweringContext): string {
  const record = input(ctx, 'card')
  const selected = field(ctx)
  const key = literal(ctx, selected)
  let read: string
  if (selected === 'contentState' || selected === 'extension') read = cardRecordField(record, selected)
  else if (selected === 'cardId' || selected === 'instanceId' || selected === 'name') read = cardStringField(record, selected)
  else if (selected === 'boundPieceInstanceId') read = `(function(value){if(value===undefined||value===null)return null;if(typeof value!=="string")return __gameplayInvalid;return value?value:null;})(${record}[${key}])`
  else throw new Error(`module ${ctx.moduleId}: unsupported card instance field`)
  return `(function(card){if(card===__gameplayInvalid)return __gameplayInvalid;if(card==null||typeof card!=="object"||Array.isArray(card))return {value:null,defined:false};var defined=Object.prototype.hasOwnProperty.call(card,${key});var value=${read};if(value===__gameplayInvalid)return __gameplayInvalid;return {value:value,defined:defined};})(${record})`
}

function definitionFieldLowering(ctx: GameplayNativeLoweringContext): string {
  const record = input(ctx, 'card')
  const selected = field(ctx)
  const read = selected === 'id'
    ? `(function(value){return typeof value==="string"?value:"";})(${record}.cardId)`
    : `(function(value){return value?String(value):null;})(${record}.name)`
  return `(function(card){if(card===__gameplayInvalid)return __gameplayInvalid;if(card==null||typeof card!=="object"||Array.isArray(card))return {value:${selected === 'id' ? '""' : 'null'}};return {value:${read}};})(${record})`
}

function contentFieldLowering(ctx: GameplayNativeLoweringContext): string {
  const record = input(ctx, 'record')
  const selected = field(ctx)
  const key = literal(ctx, selected)
  if (selected === 'velenHolyProphecy') {
    const read = `(function(value){if(value===undefined||value===null)return null;if(typeof value!=="object"||Array.isArray(value))return __gameplayInvalid;return JSON.parse(JSON.stringify(value));})(${record}[${key}])`
    return `(function(state){if(state===__gameplayInvalid)return __gameplayInvalid;if(state==null)return {value:null};if(typeof state!=="object"||Array.isArray(state))return __gameplayInvalid;var value=${read};return value===__gameplayInvalid?__gameplayInvalid:{value:value};})(${record})`
  }
  if (selected === 'velenHolyProphecyEnhanced') {
    return `(function(state){if(state===__gameplayInvalid)return __gameplayInvalid;if(state==null)return {value:false};if(typeof state!=="object"||Array.isArray(state))return __gameplayInvalid;return {value:Boolean(state[${key}])};})(${record})`
  }
  if (selected === 'sourcePieceId') {
    return `(function(state){if(state===__gameplayInvalid)return __gameplayInvalid;if(state==null)return {value:null};if(typeof state!=="object"||Array.isArray(state))return __gameplayInvalid;var value=state[${key}];if(value===undefined||value===null)return {value:null};return typeof value==="string"?{value:value}:__gameplayInvalid;})(${record})`
  }
  if (selected === 'createdTurnNumber') {
    return `(function(state){if(state===__gameplayInvalid)return __gameplayInvalid;if(state==null)return {value:null};if(typeof state!=="object"||Array.isArray(state))return __gameplayInvalid;var value=state[${key}];if(value===undefined||value===null)return {value:null};return typeof value==="number"&&Number.isFinite(value)?{value:value}:__gameplayInvalid;})(${record})`
  }
  throw new Error(`module ${ctx.moduleId}: unsupported card content field`)
}

const CARD_INSTANCE_FIELDS: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  cardId: stringType,
  instanceId: stringType,
  name: nullableStringType,
  boundPieceInstanceId: nullablePieceType,
  contentState: nullableRecordType,
  extension: nullableRecordType,
})

const CARD_DEFINITION_FIELDS: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  id: stringType,
  name: nullableStringType,
})

const CARD_CONTENT_FIELDS: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  velenHolyProphecy: nullableRecordType,
  velenHolyProphecyEnhanced: booleanType,
  sourcePieceId: nullableStringType,
  createdTurnNumber: nullableNumberType,
})

export const GENERIC_CARD_FIELD_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'card.remove-field', label: '移除手牌实例字段',
    inputs: [port('player', playerType, { label: '玩家' }), port('card', stringType, { label: '手牌实例标识' })],
    parameters: [parameter('field', stringType, { label: '字段', enum: ['contentState', 'effectModifiers', 'presentation', 'boundPieceInstanceId'] }), parameter('subfield', stringType, { label: '记录字段', optional: true })],
    outputs: [port('success', booleanType)], effects: { pure: false, previewSafe: false, writes: ['hand', 'content', 'presentation'] },
    lower: ctx => `${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.cards.removeField(${input(ctx, 'player')},${input(ctx, 'card')},${ctx.emitLiteral(field(ctx))}${ctx.parameters.subfield === undefined ? '' : ',' + ctx.emitLiteral(ctx.parameters.subfield)})`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'card.write-field', label: '手牌实例字段赋值',
    description: '只修改指定玩家的一个手牌实例，同名的其他手牌保持独立。',
    inputs: [port('player', playerType, { label: '玩家' }), port('card', stringType, { label: '手牌实例标识' }), port('value', recordType, { label: '值' })],
    parameters: [parameter('field', stringType, { label: '字段', enum: ['contentState', 'effectModifiers', 'presentation', 'boundPieceInstanceId'] }),
      parameter('subfield', stringType, { label: '记录字段', optional: true }), parameter('valueType', stringType, { label: '值类型', default: 'record' })],
    inputValueTypeBindings: { value: { parameter: 'valueType' } }, outputs: [port('success', booleanType)],
    effects: { pure: false, previewSafe: false, writes: ['hand', 'content', 'presentation'] },
    lower: ctx => `${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.cards.writeField(${input(ctx, 'player')},${input(ctx, 'card')},${ctx.emitLiteral(field(ctx))},${input(ctx, 'value')}${ctx.parameters.subfield === undefined ? '' : ',' + ctx.emitLiteral(ctx.parameters.subfield)})`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'card.hand-records', label: '读取手牌记录',
    description: '按权威手牌顺序读取不可变卡牌记录，并显式报告手牌是否存在。',
    inputs: [port('player', playerType, { nullable: true, optional: true })],
    outputs: [port('cards', handType), port('hasHand', booleanType)],
    effects: { ...PURE, reads: ['hand', 'players'] },
    lower: handLowering,
    ui: { category: 'card', authoring: 'standard' },
  }),
  define({
    id: 'card.instance-field', label: '读取卡牌实例字段',
    description: '从手牌实例记录读取封闭字段；字段类型由登记表决定，缺失通过 defined 端口保留。',
    inputs: [port('card', recordType, { nullable: true })],
    outputs: [port('value', 'unknown', { nullable: true }), port('defined', booleanType)],
    parameters: [parameter('field', stringType, { enum: Object.keys(CARD_INSTANCE_FIELDS) })],
    outputParameterTypeBindings: fieldBinding(CARD_INSTANCE_FIELDS),
    effects: { ...PURE, reads: ['hand', 'content'] },
    lower: instanceFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'card.definition-field', label: '读取卡牌定义字段',
    description: '读取手牌实例对应的封闭卡牌定义标识或名称；不解析动态对象路径。',
    inputs: [port('card', recordType, { nullable: true })],
    outputs: [port('value', 'unknown', { nullable: true })],
    parameters: [parameter('field', stringType, { enum: Object.keys(CARD_DEFINITION_FIELDS) })],
    outputParameterTypeBindings: fieldBinding(CARD_DEFINITION_FIELDS),
    effects: { ...PURE, reads: ['hand', 'content'] },
    lower: definitionFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'card.content-field', label: '读取卡牌内容字段',
    description: '读取登记过的卡牌内容字段；结构化预言记录与布尔声明保持各自类型。',
    inputs: [port('record', recordType, { nullable: true })],
    outputs: [port('value', 'unknown', { nullable: true })],
    parameters: [parameter('field', stringType, { enum: Object.keys(CARD_CONTENT_FIELDS) })],
    outputParameterTypeBindings: fieldBinding(CARD_CONTENT_FIELDS),
    effects: { ...PURE, reads: ['content'] },
    lower: contentFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
])

export const GENERIC_CARD_FIELD_MODULES = GENERIC_CARD_FIELD_GAMEPLAY_MODULES
