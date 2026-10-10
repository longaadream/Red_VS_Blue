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
 * Shared projectile facts and effects.
 *
 * These descriptors expose the small facts that the existing projectile host
 * already knows: a cardinal line, an observed trace event, a bounded cell
 * set, and the authoritative wall/damage entry points.  Skill graphs retain
 * all selection, branching, ordering, and messages.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const eventType: GameplayValueType = 'event'
const recordType: GameplayValueType = 'record'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const eventListType: GameplayValueType = { kind: 'list', element: eventType }
const numberListType: GameplayValueType = { kind: 'list', element: numberType }
const stringListType: GameplayValueType = { kind: 'list', element: stringType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const input = (ctx: Context, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const flow = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const literal = (ctx: Context, name: string, fallback?: unknown): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (value === undefined) throw new Error(`module ${ctx.moduleId}: missing parameter ${name}`)
  return ctx.emitLiteral(value as never)
}
const numberLiteral = (ctx: Context, name: string, fallback?: number): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}
const booleanLiteral = (ctx: Context, name: string, fallback?: boolean): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'boolean') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be boolean`)
  return ctx.emitLiteral(value)
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): Descriptor => ({ version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value })

const PROJECTILE_FACTS: readonly Descriptor[] = [
  define({
    id: 'event.skill-cast-count',
    label: '读取本回合技能释放次数',
    description: '按权威动作记录统计当前回合、当前棋子和指定技能的未中断释放次数。',
    inputs: [port('piece', pieceType)], outputs: [port('count', numberType)],
    parameters: [parameter('skillId', stringType)],
    effects: pure(['actions', 'turn']),
    lower: ctx => {
      const skillId = literal(ctx, 'skillId')
      const state = battle(ctx)
      return `(function(pieceId,skillId){var turn=${state}.turn&&${state}.turn.turnNumber;return(Array.isArray(${state}.actions)?${state}.actions:[]).filter(function(action){var payload=action&&action.payload;return action&&action.type==="useBasicSkill"&&Number(action.turn)===Number(turn)&&payload&&payload.pieceId===pieceId&&payload.skillId===skillId&&payload.interrupted!==true;}).length;})(${input(ctx, 'piece')},${skillId})`
    },
    ui: { category: 'event' },
  }),
  define({
    id: 'status.read-turn-number',
    label: '读取状态回合编号',
    description: '读取迁移登记状态中的固定 turnNumber 字段，不开放任意状态路径。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true }), port('fallback', numberType)], outputs: [port('value', numberType)],
    effects: pure(['statuses']),
    lower: ctx => `(function(pieceId,statusId,fallback){if(statusId==null||!${flow(ctx)}.query.hasPiece(pieceId))return fallback;var tags=${flow(ctx)}.query.piece(pieceId).statusTags||[],tag=tags.find(function(item){return item&&item.id===statusId;}),value=tag&&tag.turnNumber;return value==null?fallback:Number(value);})(${input(ctx, 'piece')},${input(ctx, 'statusId')},${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'projectile.line-cells',
    label: '生成正向地格线',
    description: '由来源棋子与已选地格计算正交方向，并按固定距离生成地格实例；可选择在地图边界停止。',
    inputs: [port('source', pieceType), port('target', cellType)],
    outputs: [port('cells', cellListType), port('dx', numberType), port('dy', numberType), port('valid', booleanType), port('sameCell', booleanType), port('distance', numberType)],
    parameters: [parameter('maxDistance', numberType, { default: 6, minimum: 0, maximum: 128 }), parameter('clipToBoard', booleanType, { default: false })],
    effects: pure(['pieces', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const state = battle(ctx)
      const query = flow(ctx)
      const maxDistance = numberLiteral(ctx, 'maxDistance', 6)
      const clipToBoard = booleanLiteral(ctx, 'clipToBoard', false)
      return `(function(sourceId,targetCell,maxDistance,clipToBoard){if(sourceId==null||!targetCell||!Number.isInteger(targetCell.x)||!Number.isInteger(targetCell.y)||!${query}.query.hasPiece(sourceId))return {cells:[],dx:0,dy:0,valid:false,sameCell:false,distance:0};var source=${query}.query.piece(sourceId),dx=targetCell.x-source.x,dy=targetCell.y-source.y,sameCell=dx===0&&dy===0,valid=(dx===0)!==(dy===0),sx=dx===0?0:(dx>0?1:-1),sy=dy===0?0:(dy>0?1:-1),cells=[];if(valid){for(var i=1;i<=Math.floor(maxDistance);i+=1){var cell={x:source.x+sx*i,y:source.y+sy*i};if(clipToBoard&&!(${state}.map&&Array.isArray(${state}.map.tiles)&&${state}.map.tiles.some(function(tile){return tile&&tile.x===cell.x&&tile.y===cell.y;})))break;cells.push(cell);}}return {cells:cells,dx:sx,dy:sy,valid:valid,sameCell:sameCell,distance:Math.max(Math.abs(dx),Math.abs(dy))};})(${source},${target},${maxDistance},${clipToBoard})`
    },
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.trace',
    label: '记录正向弹道',
    description: '沿正交方向调用现有弹道观察入口；事件中的棋子、地格和阻挡事实由后续模块读取。',
    inputs: [port('source', pieceType), port('target', cellType)],
    outputs: [port('events', eventListType), port('dx', numberType), port('dy', numberType), port('valid', booleanType), port('sameCell', booleanType), port('distance', numberType)],
    parameters: [parameter('maxDistance', numberType, { default: 99, minimum: 0, maximum: 128 })],
    effects: pure(['pieces', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const query = flow(ctx)
      const maxDistance = numberLiteral(ctx, 'maxDistance', 99)
      return `(function(sourceId,targetCell,maxDistance){if(sourceId==null||!targetCell||!Number.isInteger(targetCell.x)||!Number.isInteger(targetCell.y)||!${query}.query.hasPiece(sourceId))return {events:[],dx:0,dy:0,valid:false,sameCell:false,distance:0};var source=${query}.query.piece(sourceId),dx=targetCell.x-source.x,dy=targetCell.y-source.y,sameCell=dx===0&&dy===0,valid=(dx===0)!==(dy===0),sx=dx===0?0:(dx>0?1:-1),sy=dy===0?0:(dy>0?1:-1);return {events:valid?${query}.query.path({x:source.x,y:source.y},{x:sx,y:sy},{maxDistance:Math.floor(maxDistance),excludePieceId:sourceId}):[],dx:sx,dy:sy,valid:valid,sameCell:sameCell,distance:Math.max(Math.abs(dx),Math.abs(dy))};})(${source},${target},${maxDistance})`
    },
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.trace-enemies',
    label: '记录可穿越弹道敌人',
    description: '沿正交方向以可穿越友军、敌人和地形的路径读取敌人实例，保留路径事件顺序。',
    inputs: [port('source', pieceType), port('target', cellType)],
    outputs: [port('pieces', pieceListType), port('valid', booleanType), port('sameCell', booleanType), port('distance', numberType)],
    parameters: [parameter('maxDistance', numberType, { default: 6, minimum: 0, maximum: 128 })],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const query = flow(ctx)
      const maxDistance = numberLiteral(ctx, 'maxDistance', 6)
      return `(function(sourceId,targetCell,maxDistance){if(sourceId==null||!targetCell||!Number.isInteger(targetCell.x)||!Number.isInteger(targetCell.y)||!${query}.query.hasPiece(sourceId))return {pieces:[],valid:false,sameCell:false,distance:0};var source=${query}.query.piece(sourceId),dx=targetCell.x-source.x,dy=targetCell.y-source.y,sameCell=dx===0&&dy===0,valid=(dx===0)!==(dy===0),sx=dx===0?0:(dx>0?1:-1),sy=dy===0?0:(dy>0?1:-1),trace=valid?${query}.query.tracePath({x:source.x,y:source.y},{x:sx,y:sy},{excludePieceId:sourceId,maxDistance:Math.floor(maxDistance),passAllies:true,passEnemies:true,terrain:"any"}):{encounters:[]},enemyIds=valid?${query}.query.pieces({originId:sourceId,relation:"enemy",includeDead:false}):[];return {pieces:(trace.encounters||[]).filter(function(encounter){return encounter&&encounter.type==="piece"&&enemyIds.indexOf(encounter.pieceId)>=0;}).map(function(encounter){return encounter.pieceId;}),valid:valid,sameCell:sameCell,distance:Math.max(Math.abs(dx),Math.abs(dy))};})(${source},${target},${maxDistance})`
    },
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.event-kind',
    label: '读取弹道事件类型',
    description: '读取观察事件的封闭类型标识。',
    inputs: [port('event', eventType)], outputs: [port('kind', stringType)],
    effects: pure(['position']),
    lower: ctx => `String((${input(ctx, 'event')}&&${input(ctx, 'event')}.type)||'')`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.event-piece',
    label: '读取命中棋子',
    description: '将命中事件中的棋子转换为不透明实例 ID；调用方应先判断事件类型。',
    inputs: [port('event', eventType)], outputs: [port('piece', pieceType)],
    effects: pure(['pieces']),
    lower: ctx => `(${input(ctx, 'event')}&&${input(ctx, 'event')}.piece?${input(ctx, 'event')}.piece.instanceId:null)`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.event-distance',
    label: '读取弹道距离',
    description: '读取命中或地形事件距来源的整数距离。',
    inputs: [port('event', eventType)], outputs: [port('distance', numberType)],
    effects: pure(['position']),
    lower: ctx => `Number((${input(ctx, 'event')}&&${input(ctx, 'event')}.distance)||0)`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.event-cell',
    label: '读取弹道地格',
    description: '读取观察事件的坐标地格记录。',
    inputs: [port('event', eventType)], outputs: [port('cell', cellType)],
    effects: pure(['position']),
    lower: ctx => `({x:Number(${input(ctx, 'event')}.x),y:Number(${input(ctx, 'event')}.y)})`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.event-blocks',
    label: '读取弹道阻挡事实',
    description: '读取地形事件是否阻挡弹道。',
    inputs: [port('event', eventType)], outputs: [port('blocks', booleanType)],
    effects: pure(['position']),
    lower: ctx => `Boolean(${input(ctx, 'event')}&&${input(ctx, 'event')}.blocksProjectile)`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'query.pieces-in-square',
    label: '查询方形范围棋子',
    description: '在来源棋子周围的方形范围内查询存活棋子，并按权威棋子顺序保留实例 ID。',
    inputs: [port('origin', pieceType)], outputs: [port('pieces', pieceListType)],
    parameters: [parameter('relation', stringType, { enum: ['all', 'ally', 'enemy'], default: 'enemy' }), parameter('halfExtent', numberType, { default: 2, minimum: 0, maximum: 32 })],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const origin = input(ctx, 'origin')
      const query = flow(ctx)
      const relation = ctx.parameters.relation === undefined ? 'enemy' : ctx.parameters.relation
      if (!['all', 'ally', 'enemy'].includes(String(relation))) throw new Error(`module ${ctx.moduleId}: invalid relation`)
      const relationCode = ctx.emitLiteral(relation as string)
      const halfExtent = numberLiteral(ctx, 'halfExtent', 2)
      return `(function(originId,halfExtent){if(originId==null||!${query}.query.hasPiece(originId))return [];var origin=${query}.query.piece(originId),ids=${query}.query.pieces({originId:originId,relation:${relationCode}==='all'?undefined:${relationCode},includeDead:false});return ids.filter(function(id){var piece=${query}.query.piece(id);return Math.max(Math.abs(piece.x-origin.x),Math.abs(piece.y-origin.y))<=halfExtent;});})(${origin},${halfExtent})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.same-relation',
    label: '判断棋子敌我关系',
    description: '使用现有敌我关系查询判断两个棋子是否属于指定关系，兼容队伍映射而非比较玩家字符串。',
    inputs: [port('source', pieceType), port('target', pieceType)], outputs: [port('value', booleanType)],
    parameters: [parameter('relation', stringType, { enum: ['ally', 'enemy'], default: 'enemy' })],
    effects: pure(['pieces', 'players']),
    lower: ctx => {
      const relation = ctx.parameters.relation === undefined ? 'enemy' : ctx.parameters.relation
      if (relation !== 'ally' && relation !== 'enemy') throw new Error(`module ${ctx.moduleId}: invalid relation`)
      return `(function(sourceId,targetId){if(sourceId==null||targetId==null||!${flow(ctx)}.query.hasPiece(sourceId)||!${flow(ctx)}.query.hasPiece(targetId))return false;return ${flow(ctx)}.query.pieces({originId:sourceId,relation:${ctx.emitLiteral(relation)},includeDead:true}).indexOf(targetId)>=0;})(${input(ctx, 'source')},${input(ctx, 'target')})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.enemies-on-cells',
    label: '查询地格线敌人',
    description: '按来源敌我关系筛选占据给定地格集合的存活敌人，保持权威棋子顺序。',
    inputs: [port('source', pieceType), port('cells', cellListType)], outputs: [port('pieces', pieceListType)],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source'), cells = input(ctx, 'cells'), query = flow(ctx)
      return `(function(sourceId,cells){if(sourceId==null||!Array.isArray(cells)||!${query}.query.hasPiece(sourceId))return [];return ${query}.query.pieces({originId:sourceId,relation:"enemy",includeDead:false}).filter(function(id){var piece=${query}.query.piece(id);return cells.some(function(cell){return cell&&piece.x===cell.x&&piece.y===cell.y;});});})(${source},${cells})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.faction-enemies-on-cells',
    label: '按阵营查询地格线敌人',
    description: '保留旧弹道按 faction 不相等判定敌人的语义，并按战斗棋子顺序返回存活目标。',
    inputs: [port('source', pieceType), port('cells', cellListType)], outputs: [port('pieces', pieceListType)],
    effects: pure(['pieces', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source'), cells = input(ctx, 'cells'), state = battle(ctx), query = flow(ctx)
      return `(function(sourceId,cells){if(sourceId==null||!Array.isArray(cells)||!${query}.query.hasPiece(sourceId))return [];var source=${query}.query.piece(sourceId);return (${state}.pieces||[]).filter(function(piece){return piece&&piece.currentHp>0&&piece.faction!==source.faction&&cells.some(function(cell){return cell&&piece.x===cell.x&&piece.y===cell.y;});}).map(function(piece){return piece.instanceId;});})(${source},${cells})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.enemies-on-cell',
    label: '查询单格敌人',
    description: '按来源敌我关系筛选占据单个地格的存活敌人，保持权威棋子顺序。',
    inputs: [port('source', pieceType), port('cell', cellType)], outputs: [port('pieces', pieceListType)],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source'), cell = input(ctx, 'cell'), query = flow(ctx)
      return `(function(sourceId,cell){if(sourceId==null||!cell||!${query}.query.hasPiece(sourceId))return [];return ${query}.query.pieces({originId:sourceId,relation:"enemy",includeDead:false}).filter(function(id){var piece=${query}.query.piece(id);return piece.x===cell.x&&piece.y===cell.y;});})(${source},${cell})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.enemies-on-index',
    label: '查询地格线序号敌人',
    description: '读取有限地格线指定序号上的存活敌人；越过地图边界时返回空集合。',
    inputs: [port('source', pieceType, { nullable: true, optional: true }), port('owner', 'player', { nullable: true, optional: true }), port('cells', cellListType), port('index', numberType)], outputs: [port('pieces', pieceListType)],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const source = ctx.inputs.source ?? 'null', owner = ctx.inputs.owner ?? 'null', cells = input(ctx, 'cells'), index = input(ctx, 'index'), query = flow(ctx)
      return `(function(sourceId,ownerId,cells,index){if(!Array.isArray(cells)||!Number.isInteger(index)||index<0||index>=cells.length||sourceId==null&&ownerId==null||sourceId!=null&&!${query}.query.hasPiece(sourceId)&&ownerId==null)return [];var cell=cells[index],ids=ownerId!=null?${query}.query.pieces({ownerId:ownerId,relation:"enemy",includeDead:false}):${query}.query.pieces({originId:sourceId,relation:"enemy",includeDead:false});return ids.filter(function(id){var piece=${query}.query.piece(id);return piece.x===cell.x&&piece.y===cell.y;});})(${source},${owner},${cells},${index})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.piece-names',
    label: '读取棋子名称集合',
    description: '按给定棋子实例顺序读取名称文本，供弹道结果消息保留旧命中顺序。',
    inputs: [port('pieces', pieceListType)], outputs: [port('names', stringListType)],
    effects: pure(['pieces']),
    lower: ctx => `(Array.isArray(${input(ctx, 'pieces')}) ? ${input(ctx, 'pieces')} : []).map(function(pieceId) { var piece = ${flow(ctx)}.query.piece(pieceId); return piece ? String(piece.name) : ''; })`,
    ui: { category: 'query' },
  }),
  define({
    id: 'query.hand-card-instances',
    label: '查询手牌实例',
    description: '按玩家手牌顺序读取指定卡牌的稳定实例标识，不把可变卡牌对象暴露给作者图。',
    inputs: [port('player', 'player')], outputs: [port('cards', stringListType)],
    parameters: [parameter('cardId', stringType)],
    effects: pure(['hand', 'players']),
    lower: ctx => `(function(playerId,cardId){var hand = ${flow(ctx)}.cards.hand(playerId); return (Array.isArray(hand) ? hand : []).filter(function(card) { return card && card.cardId === cardId; }).map(function(card) { return card.instanceId; });})(${input(ctx, 'player')},${literal(ctx, 'cardId')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'projectile.distance-multiplier',
    label: '按距离读取倍率',
    description: '从作者提供的有限距离倍率表读取当前距离值；用于保留不同弹道的距离衰减。',
    inputs: [port('distance', numberType)], outputs: [port('value', numberType)],
    parameters: [parameter('values', numberListType)],
    effects: pure(),
    lower: ctx => {
      const values = ctx.parameters.values
      if (!Array.isArray(values) || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`module ${ctx.moduleId}: values must be finite numbers`)
      const table = ctx.emitLiteral(values as never)
      return `(function(distance,values){var index=Math.floor(distance)-1;return index>=0&&index<values.length&&Number.isFinite(values[index])?values[index]:0;})(${input(ctx, 'distance')},${table})`
    },
    ui: { category: 'math' },
  }),
]

const PROJECTILE_EFFECTS: readonly Descriptor[] = [
  define({
    id: 'effect.displace',
    label: '按路径位移棋子',
    description: '通过统一位移入口提交一个棋子，并保留作者指定的可穿越路径策略。',
    inputs: [port('piece', pieceType), port('destination', cellType)],
    outputs: [port('result', recordType), port('success', booleanType)],
    parameters: [
      parameter('kind', stringType, { enum: ['dash', 'teleport'], default: 'dash' }),
      parameter('passAllies', booleanType, { default: true }),
      parameter('passEnemies', booleanType, { default: true }),
      parameter('terrain', stringType, { enum: ['walkable', 'projectile', 'any'], default: 'any' }),
    ],
    effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => {
      const kind = literal(ctx, 'kind', 'dash')
      const passAllies = booleanLiteral(ctx, 'passAllies', true)
      const passEnemies = booleanLiteral(ctx, 'passEnemies', true)
      const terrain = literal(ctx, 'terrain', 'any')
      const destination = input(ctx, 'destination')
      const request = `[{pieceId:${input(ctx, 'piece')},x:(${destination}).x,y:(${destination}).y}]`
      return `(function(value){return {result:value,success:Boolean(value&&value.success)};})(${flow(ctx)}.effects.displace(${request},${kind},{passAllies:${passAllies},passEnemies:${passEnemies},terrain:${terrain}}))`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'effect.damage-without-skill-id',
    label: '造成无技能标识伤害',
    description: '沿用旧技能直接调用伤害入口时省略 skillId 的事件语义；伤害类型仍由图显式声明。',
    inputs: [port('source', pieceType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('result', recordType), port('success', booleanType), port('damage', numberType)],
    parameters: [parameter('damageType', stringType, { enum: ['physical', 'magical', 'true'], default: 'physical' })],
    effects: writes(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const damageType = ctx.parameters.damageType === undefined ? 'physical' : ctx.parameters.damageType
      if (damageType !== 'physical' && damageType !== 'magical' && damageType !== 'true') throw new Error(`module ${ctx.moduleId}: invalid damageType`)
      const source = `${flow(ctx)}.query.piece(${input(ctx, 'source')})`
      const target = `${flow(ctx)}.query.piece(${input(ctx, 'target')})`
      return `(function(value){return {result:value,success:Boolean(value&&value.success),damage:value&&value.damage};})(dealDamage(${source},${target},${input(ctx, 'amount')},${ctx.emitLiteral(damageType)},${battle(ctx)}))`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'card.discard-instance',
    label: '弃置手牌实例',
    description: '通过现有卡牌生命周期按稳定实例标识弃置手牌并写入弃牌堆。',
    inputs: [port('card', stringType)], outputs: [port('success', booleanType)],
    effects: writes(['hand', 'events'], ['cardDiscarded']),
    lower: ctx => `Boolean(${flow(ctx)}.cards.discard(${input(ctx, 'card')}))`,
    ui: { category: 'card' },
  }),
  define({
    id: 'skill.reset-cooldown',
    label: '重置技能冷却',
    description: '沿用现有技能生命周期入口，将指定棋子技能冷却重置为零。',
    inputs: [port('piece', pieceType), port('skillId', stringType, { nullable: true })], outputs: [port('success', booleanType)],
    effects: writes(['skills'], ['skillCooldownChanged']),
    lower: ctx => `(function(pieceId,skillId){if(pieceId==null||skillId==null||!${flow(ctx)}.query.hasPiece(pieceId))return false;${flow(ctx)}.skills.resetCooldown(pieceId,[skillId]);return true;})(${input(ctx, 'piece')},${input(ctx, 'skillId')})`,
    ui: { category: 'skill' },
  }),
  define({
    id: 'effect.destroy-walls',
    label: '破坏地格墙体',
    description: '经现有 flow.effects.destroyWalls 入口破坏给定地格中的墙和可选掩体，并返回实际变化数量。',
    inputs: [port('cells', cellListType)], outputs: [port('result', recordType), port('changed', numberType)],
    parameters: [parameter('includeCover', booleanType, { default: true })],
    effects: writes(['terrain', 'events'], ['terrainChanged']),
    lower: ctx => `(function(value){return {result:value,changed:Array.isArray(value&&value.changedCells)?value.changedCells.length:0};})(${flow(ctx)}.effects.destroyWalls(${input(ctx, 'cells')},{includeCover:${booleanLiteral(ctx, 'includeCover', true)}}))`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'projectile.zone-set',
    label: '写入弹道区域记录',
    description: '写入现有战斗扩展中的结构化弹道区域记录；状态生命周期仍由同一作者图显式调用。',
    inputs: [port('source', pieceType), port('dx', numberType), port('dy', numberType)],
    outputs: [port('success', booleanType)],
    parameters: [parameter('storageKey', stringType, { default: 'coltZones' }), parameter('kind', stringType, { default: 'revolver' }), parameter('turns', numberType, { default: 2, minimum: 0, maximum: 32 })],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx)
      const storageKey = literal(ctx, 'storageKey', 'coltZones')
      const kind = literal(ctx, 'kind', 'revolver')
      const turns = numberLiteral(ctx, 'turns', 2)
      return `(function(sourceId,dx,dy,storageKey,kind,turns){if(typeof sourceId!=="string"||typeof storageKey!=="string"||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(storageKey)||!Number.isInteger(dx)||!Number.isInteger(dy)||Math.abs(dx)+Math.abs(dy)!==1||!Number.isFinite(turns))return false;${state}.extensions=${state}.extensions||{};${state}.extensions[storageKey]=${state}.extensions[storageKey]||{};${state}.extensions[storageKey][sourceId]={sourceId:sourceId,kind:kind,dx:dx,dy:dy,turns:turns};return true;})(${input(ctx, 'source')},${input(ctx, 'dx')},${input(ctx, 'dy')},${storageKey},${kind},${turns})`
    },
    ui: { category: 'effect' },
  }),
]

export const PROJECTILE_GAMEPLAY_MODULES: readonly Descriptor[] = Object.freeze([
  ...PROJECTILE_FACTS,
  ...PROJECTILE_EFFECTS,
])

export const projectileGameplayModuleDescriptors = PROJECTILE_GAMEPLAY_MODULES
