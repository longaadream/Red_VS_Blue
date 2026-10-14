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
 * Closed host adapters for the Black Widow toxin graphs.
 *
 * The graph owns the selection, validation, ordering, messages and cleanup
 * branches.  These adapters only expose the two existing state shapes that
 * the legacy content uses: player status records and tileEffects records.
 * No arbitrary extension key or object path is author controlled here.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const cellType: GameplayValueType = 'cell'
const recordType: GameplayValueType = 'record'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE,
  ...value,
})
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const input = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string => {
  const value = ctx.inputs[name]
  if (typeof value === 'string' && value.length > 0) return value
  if (fallback !== undefined) return fallback
  throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
}
const stringLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}
const pieceId = (ctx: GameplayNativeLoweringContext, name: string, fallback = 'null'): string => {
  const value = input(ctx, name, fallback)
  return `(function(value) { return value && typeof value === "object" ? value.instanceId : value; })(${value})`
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })

const TILE_EFFECT_TYPES = ['lethal-toxin'] as const
const STATUS_TYPES = ['lethal-toxin'] as const

const STATUS_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'status.find-player-id-at',
    label: '按坐标查找玩家状态',
    description: '从玩家状态中按固定坐标字段读取首个指定类型的状态标识。',
    inputs: [port('player', playerType), port('x', numberType), port('y', numberType)],
    outputs: [port('id', stringType, { nullable: true })],
    parameters: [parameter('statusType', stringType, { enum: STATUS_TYPES })],
    effects: pure(['statuses', 'players']),
    lower: ctx => {
      const type = stringLiteral(ctx, 'statusType')
      return `(function(playerId,x,y){var owner=${flow(ctx)}.query.player(playerId),tags=owner&&Array.isArray(owner.statusTags)?owner.statusTags:[],tag=tags.find(function(item){return item&&item.type===${type}&&item.value===x&&item.extraValue===y;});return tag&&typeof tag.id==="string"?tag.id:null;})(${input(ctx, 'player')},${input(ctx, 'x')},${input(ctx, 'y')})`
    },
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-player-number-truthy',
    label: '读取玩家状态真值数值',
    description: '读取登记玩家状态的有限数值字段；旧内容的假值字段回退由宿主适配器保留。',
    inputs: [port('player', playerType), port('statusId', stringType, { nullable: true }), port('fallback', numberType)],
    outputs: [port('value', numberType)],
    parameters: [parameter('field', stringType, { enum: ['intensity', 'value', 'extraValue'] })],
    effects: pure(['statuses', 'players']),
    lower: ctx => {
      const field = stringLiteral(ctx, 'field')
      return `(function(playerId,statusId,fallback){if(statusId==null)return fallback;var owner=${flow(ctx)}.query.player(playerId),tags=owner&&Array.isArray(owner.statusTags)?owner.statusTags:[],tag=tags.find(function(item){return item&&item.id===statusId;}),value=tag&&tag[${field}];return value?Number(value):fallback;})(${input(ctx, 'player')},${input(ctx, 'statusId')},${input(ctx, 'fallback')})`
    },
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-player-text-field',
    label: '读取玩家状态文本字段',
    description: '读取登记玩家状态的有限来源字段，不开放任意状态路径。',
    inputs: [port('player', playerType), port('statusId', stringType, { nullable: true })],
    outputs: [port('value', stringType, { nullable: true })],
    parameters: [parameter('field', stringType, { enum: ['sourceId'] })],
    effects: pure(['statuses', 'players']),
    lower: ctx => {
      const field = stringLiteral(ctx, 'field')
      return `(function(playerId,statusId){if(statusId==null)return null;var owner=${flow(ctx)}.query.player(playerId),tags=owner&&Array.isArray(owner.statusTags)?owner.statusTags:[],tag=tags.find(function(item){return item&&item.id===statusId;}),value=tag&&tag[${field}];return typeof value==="string"?value:null;})(${input(ctx, 'player')},${input(ctx, 'statusId')})`
    },
    ui: { category: 'status' },
  }),
]

const QUERY_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'query.piece-by-identifier',
    label: '按状态来源解析棋子',
    description: '按受信的字符串实例标识解析仍在场的棋子；离场来源返回空引用。',
    inputs: [port('pieceId', stringType, { nullable: true })],
    outputs: [port('piece', pieceType, { nullable: true })],
    effects: pure(['pieces']),
    lower: ctx => `(function(pieceId){return pieceId!=null&&${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId).instanceId:null;})(${input(ctx, 'pieceId')})`,
    ui: { category: 'query' },
  }),
]

const TILE_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'tile.add-source-effect',
    label: '添加来源地格效果',
    description: '向现有 tileEffects 列表追加固定字段的来源地格效果。',
    inputs: [port('id', stringType), port('sourceId', stringType), port('owner', playerType), port('cell', cellType)],
    outputs: [port('success', booleanType)],
    parameters: [parameter('tileType', stringType, { enum: TILE_EFFECT_TYPES })],
    effects: writes(['tile-effects']),
    lower: ctx => {
      const state = battle(ctx), type = stringLiteral(ctx, 'tileType')
      return `(function(id,sourceId,ownerId,cell){if(typeof id!=="string"||typeof sourceId!=="string"||typeof ownerId!=="string"||!cell||!Number.isFinite(cell.x)||!Number.isFinite(cell.y))return false;${state}.extensions=${state}.extensions||{};${state}.extensions.tileEffects=Array.isArray(${state}.extensions.tileEffects)?${state}.extensions.tileEffects:[];${state}.extensions.tileEffects.push({id:id,sourceId:sourceId,tileType:${type},x:cell.x,y:cell.y,ownerPlayerId:ownerId});return true;})(${input(ctx, 'id')},${input(ctx, 'sourceId')},${input(ctx, 'owner')},${input(ctx, 'cell')})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'tile.remove-source-effects',
    label: '清理来源地格效果',
    description: '按固定效果类型和来源标识清理现有 tileEffects 列表。',
    inputs: [port('sourceId', stringType, { nullable: true })],
    outputs: [port('success', booleanType)],
    parameters: [parameter('tileType', stringType, { enum: TILE_EFFECT_TYPES })],
    effects: writes(['tile-effects']),
    lower: ctx => {
      const state = battle(ctx), type = stringLiteral(ctx, 'tileType')
      return `(function(sourceId){if(typeof sourceId!=="string")return false;if(!${state}.extensions||!Array.isArray(${state}.extensions.tileEffects))return true;${state}.extensions.tileEffects=${state}.extensions.tileEffects.filter(function(effect){return !(effect&&effect.tileType===${type}&&effect.sourceId===sourceId);});return true;})(${input(ctx, 'sourceId')})`
    },
    ui: { category: 'position' },
  }),
]

const EFFECT_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'effect.displace-one',
    label: '统一单棋子位移',
    description: '通过现有 displace 提交器提交一名棋子的位移。',
    inputs: [port('piece', pieceType, { label: '棋子' }), port('destination', cellType, { label: '目标地格' })],
    outputs: [port('result', recordType), port('success', booleanType)],
    parameters: [parameter('kind', stringType, { label: '位移方式', description: '传送（teleport）、冲刺（dash）、步行（walk）、推（push）、拉拽（pull）或交换（swap）；图中保留稳定英文标识。', enum: ['teleport', 'dash', 'walk', 'push', 'pull', 'swap'], default: 'teleport' })],
    effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => {
      const kind = stringLiteral(ctx, 'kind', 'teleport'), destination = input(ctx, 'destination')
      return `(function(pieceId,cell){var value=${flow(ctx)}.effects.displace([{pieceId:pieceId,x:cell.x,y:cell.y}],${kind});return {result:value,success:Boolean(value&&value.success)};})(${pieceId(ctx, 'piece')},${destination})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'effect.damage-with-player-fallback',
    label: '按棋子或玩家来源造成伤害',
    description: '来源棋子存活时保留棋子归因，否则构造受控玩家来源并走统一伤害入口。',
    inputs: [port('pieceSource', pieceType, { nullable: true }), port('playerSource', playerType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('result', recordType), port('success', booleanType), port('damage', numberType)],
    parameters: [parameter('damageType', stringType, { enum: ['true', 'physical', 'magical', 'toxin'], default: 'true' }), parameter('skillId', stringType), parameter('inputPolicy', stringType, { enum: ['floor', 'host'], default: 'floor' })],
    effects: writes(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const source = input(ctx, 'pieceSource'), player = input(ctx, 'playerSource'), target = pieceId(ctx, 'target')
      const kind = stringLiteral(ctx, 'damageType', 'true'), skillId = stringLiteral(ctx, 'skillId'), policy = stringLiteral(ctx, 'inputPolicy', 'floor')
      return `(function(pieceId,playerId,targetId,amount){var owner=${flow(ctx)}.query.player(playerId),piece=pieceId!=null&&${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId):null,source=piece&&piece.currentHp>0?piece:{kind:"player",instanceId:owner.playerId,ownerPlayerId:owner.playerId,name:owner.playerId},value=${flow(ctx)}.effects.damage(source,targetId,amount,${kind},${skillId},${policy});return {result:value,success:Boolean(value&&value.success),damage:value&&Number(value.damage||0)};})(${source},${player},${target},${input(ctx, 'amount')})`
    },
    ui: { category: 'effect' },
  }),
]

export const TOXIN_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  ...QUERY_PRIMITIVES,
  ...STATUS_PRIMITIVES,
  ...TILE_PRIMITIVES,
  ...EFFECT_PRIMITIVES,
])
