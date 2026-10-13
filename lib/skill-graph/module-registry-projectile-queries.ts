import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Small generic host boundaries used by projectile/query compatibility
 * rewrites.  Traversal remains owned by flow-runtime; these descriptors only
 * expose an opaque path observation, an ID-to-reference validation, and a
 * deterministic Fisher-Yates operation to the graph compiler.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const eventType: GameplayValueType = 'event'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const eventListType: GameplayValueType = { kind: 'list', element: eventType }
const anyListType: GameplayValueType = { kind: 'list', element: 'any' }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>): GameplayModuleDescriptor => ({
  version: '1', allowedSurfaces: ACTIVE, ...value,
})

export const PROJECTILE_QUERY_HOST_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'piece.raw-faction',
    label: '读取棋子登记阵营',
    description: '读取棋子记录本身的 faction 字段；用于保留旧查询的字段不相等语义，不替换为玩家队伍映射。',
    inputs: [port('piece', pieceType)],
    outputs: [port('faction', nullableStringType)],
    effects: pure(['pieces']),
    lower: ctx => `((function(pieceId){var piece=${flow(ctx)}.query.piece(pieceId);return piece&&piece.faction==null?null:piece?String(piece.faction):null;})(${input(ctx, 'piece')}))`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'projectile.event-piece-id',
    label: '读取弹道事件棋子标识',
    description: '从标准弹道事件或移动追踪 encounter 读取棋子实例标识；不验证或制造棋子对象。',
    inputs: [port('event', eventType)],
    outputs: [port('piece', pieceType)],
    effects: pure(['pieces']),
    lower: ctx => `(function(event){if(!event)return null;if(event.piece&&typeof event.piece.instanceId==='string')return event.piece.instanceId;return typeof event.pieceId==='string'?event.pieceId:null;})(${input(ctx, 'event')})`,
    ui: { category: 'projectile', authoring: 'standard' },
  }),
  define({
    id: 'projectile.trace-to-cell',
    label: '读取可穿越弹道事件',
    description: '调用权威移动路径观察器的全穿越模式；图只负责投影其中的棋子事件。',
    inputs: [port('source', pieceType), port('target', cellType)],
    outputs: [
      port('events', eventListType),
      port('dx', numberType),
      port('dy', numberType),
      port('valid', 'boolean'),
      port('sameCell', 'boolean'),
      port('distance', numberType),
    ],
    parameters: [{ name: 'maxDistance', type: numberType, default: 6, minimum: 0, maximum: 128 }],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const maxDistance = Object.prototype.hasOwnProperty.call(ctx.parameters, 'maxDistance')
        ? ctx.parameters.maxDistance
        : 6
      if (typeof maxDistance !== 'number' || !Number.isFinite(maxDistance)) throw new Error(`module ${ctx.moduleId}: maxDistance must be finite`)
      const runtime = flow(ctx)
      const max = ctx.emitLiteral(maxDistance)
      return `(function(sourceId,targetCell,maxDistance){if(sourceId==null||!targetCell||!Number.isInteger(targetCell.x)||!Number.isInteger(targetCell.y)||!${runtime}.query.hasPiece(sourceId))return {events:[],dx:0,dy:0,valid:false,sameCell:false,distance:0};var source=${runtime}.query.piece(sourceId),dx=targetCell.x-source.x,dy=targetCell.y-source.y,sameCell=dx===0&&dy===0,valid=(dx===0)!==(dy===0),sx=dx===0?0:(dx>0?1:-1),sy=dy===0?0:(dy>0?1:-1),trace=valid?${runtime}.query.tracePath({x:source.x,y:source.y},{x:sx,y:sy},{excludePieceId:sourceId,maxDistance:Math.floor(maxDistance),passAllies:true,passEnemies:true,terrain:"any"}):{encounters:[]},encounters=Array.isArray(trace&&trace.encounters)?trace.encounters:[],events=encounters.map(function(item){if(item&&item.type==="piece"){return {type:"piece",x:item.x,y:item.y,pieceId:item.pieceId,piece:{instanceId:item.pieceId},distance:Math.max(Math.abs(Number(item.x)-source.x),Math.abs(Number(item.y)-source.y))};}return item;});return {events:events,dx:sx,dy:sy,valid:valid,sameCell:sameCell,distance:Math.max(Math.abs(dx),Math.abs(dy))};})(${source},${target},${max})`
    },
    ui: { category: 'projectile', authoring: 'standard' },
  }),
  define({
    id: 'projectile.trace-from-cell',
    label: '读取地格射线事件',
    description: '调用权威弹道观察器读取从地格沿单位方向的事件序列；图只负责后续筛选和截断。',
    inputs: [
      port('origin', cellType),
      port('direction', cellType),
      port('maxDistance', 'number'),
      port('excludePiece', pieceType, { nullable: true, optional: true }),
    ],
    outputs: [port('events', eventListType)],
    effects: pure(['pieces', 'position']),
    lower: ctx => {
      const origin = input(ctx, 'origin')
      const direction = input(ctx, 'direction')
      const maxDistance = input(ctx, 'maxDistance')
      const excludePiece = ctx.inputs.excludePiece ?? 'null'
      const runtime = flow(ctx)
      return `(function(origin,direction,maxDistance,excludePiece){if(!origin||!direction||!Number.isInteger(origin.x)||!Number.isInteger(origin.y)||!Number.isInteger(direction.x)||!Number.isInteger(direction.y))return [];var options={maxDistance:Math.floor(maxDistance)};if(excludePiece!=null)options.excludePieceId=excludePiece;return ${runtime}.query.path({x:origin.x,y:origin.y},{x:direction.x,y:direction.y},options)||[];})(${origin},${direction},${maxDistance},${excludePiece})`
    },
    ui: { category: 'projectile', authoring: 'standard' },
  }),
  define({
    id: 'collection.shuffle',
    label: '按权威随机源洗牌',
    description: '复制输入集合并执行 Fisher-Yates 洗牌；每个交换位置恰好消耗一次权威随机抽样。',
    inputs: [port('items', anyListType)],
    outputs: [port('items', anyListType)],
    outputTypeBindings: { items: { input: 'items', projection: 'same' } },
    effects: { ...pure(['random']), random: true },
    lower: ctx => {
      const items = input(ctx, 'items')
      const runtime = flow(ctx)
      return `(function(items){if(!Array.isArray(items))return [];var result=items.slice();for(var d=result.length-1;d>0;d-=1){var indices=[];for(var index=0;index<=d;index+=1)indices.push(index);var pick=${runtime}.query.random(indices);var j=Number(pick);var temp=result[d];result[d]=result[j];result[j]=temp;}return result;})(${items})`
    },
    ui: { category: 'collection', authoring: 'standard' },
  }),
])

export const PROJECTILE_QUERY_HOST_GAMEPLAY_MODULE_IDS = new Set(
  PROJECTILE_QUERY_HOST_GAMEPLAY_MODULES.map(descriptor => `${descriptor.id}@${descriptor.version}`),
)
