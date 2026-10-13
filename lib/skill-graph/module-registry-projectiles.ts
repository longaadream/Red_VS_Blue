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
const context = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx' : 'context'
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
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { version?: string; allowedSurfaces?: readonly GameplayModuleSurface[] }): Descriptor => ({ ...value, version: value.version ?? '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE })

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
    id: 'query.pieces-in-rectangle',
    label: '按地格顺序查询矩形棋子',
    description: '按旧选择器的 dx 外层、dy 内层顺序读取每个地格的首个存活棋子，并按来源玩家筛选敌我关系。',
    inputs: [port('origin', cellType), port('owner', 'player')], outputs: [port('pieces', pieceListType)],
    parameters: [
      parameter('relation', stringType, { enum: ['all', 'ally', 'enemy'], default: 'all' }),
      parameter('width', numberType, { default: 2, minimum: 1, maximum: 32 }),
      parameter('height', numberType, { default: 2, minimum: 1, maximum: 32 }),
    ],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const origin = input(ctx, 'origin'), owner = input(ctx, 'owner'), state = battle(ctx), query = flow(ctx)
      const relation = ctx.parameters.relation === undefined ? 'all' : ctx.parameters.relation
      if (!['all', 'ally', 'enemy'].includes(String(relation))) throw new Error(`module ${ctx.moduleId}: invalid relation`)
      const relationCode = literal(ctx, 'relation', 'all')
      const width = numberLiteral(ctx, 'width', 2), height = numberLiteral(ctx, 'height', 2)
      return `(function(origin,owner,relation,width,height){if(!origin||!Number.isInteger(origin.x)||!Number.isInteger(origin.y)||typeof owner!=="string")return [];var ids=[];for(var dx=0;dx<Math.floor(width);dx+=1){for(var dy=0;dy<Math.floor(height);dy+=1){var piece=(${state}.pieces||[]).find(function(candidate){return candidate&&candidate.currentHp>0&&candidate.x===origin.x+dx&&candidate.y===origin.y+dy;});if(!piece)continue;var allied=${query}.query.alliedPlayers(piece.ownerPlayerId,owner);if(relation==="ally"&&!allied||relation==="enemy"&&allied)continue;ids.push(piece.instanceId);}}return ids;})(${origin},${owner},${relationCode},${width},${height})`
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
    ui: { category: 'query', authoring: 'compatibility' },
  }),
  define({
    id: 'query.same-relation',
    version: '2',
    label: '判断棋子敌我关系',
    description: '使用现有敌我关系查询判断两个仍在场且存活的棋子是否属于指定关系，兼容队伍映射而非比较玩家字符串。',
    inputs: [port('source', pieceType), port('target', pieceType)], outputs: [port('value', booleanType)],
    livingReferences: ['source', 'target'],
    parameters: [parameter('relation', stringType, { enum: ['ally', 'enemy'], default: 'enemy' })],
    effects: pure(['pieces', 'players']),
    lower: ctx => {
      const relation = ctx.parameters.relation === undefined ? 'enemy' : ctx.parameters.relation
      if (relation !== 'ally' && relation !== 'enemy') throw new Error(`module ${ctx.moduleId}: invalid relation`)
      return `(function(sourceId,targetId){if(sourceId==null||targetId==null||!${flow(ctx)}.query.hasPiece(sourceId)||!${flow(ctx)}.query.hasPiece(targetId))return false;return ${flow(ctx)}.query.pieces({originId:sourceId,relation:${ctx.emitLiteral(relation)},includeDead:true}).indexOf(targetId)>=0;})(${input(ctx, 'source')},${input(ctx, 'target')})`
    },
    ui: { category: 'query', authoring: 'compatibility' },
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
    id: 'query.enemies-on-ordered-cells',
    label: '按地格顺序查询敌人',
    description: '按输入地格顺序、再按权威棋子顺序读取每格存活敌人，并去除重复实例。',
    inputs: [port('source', pieceType), port('cells', cellListType)], outputs: [port('pieces', pieceListType)],
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source'), cells = input(ctx, 'cells'), state = battle(ctx), query = flow(ctx)
      return `(function(sourceId,cells){if(sourceId==null||!Array.isArray(cells)||!${query}.query.hasPiece(sourceId))return [];var source=${query}.query.piece(sourceId),seen={};var ids=[];(cells||[]).forEach(function(cell){if(!cell)return;(${state}.pieces||[]).forEach(function(piece){if(!piece||piece.currentHp<=0||piece.x!==cell.x||piece.y!==cell.y||seen[piece.instanceId]||${query}.query.alliedPlayers(piece.ownerPlayerId,source.ownerPlayerId))return;seen[piece.instanceId]=true;ids.push(piece.instanceId);});});return ids;})(${source},${cells})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'projectile.cardinal-cells',
    label: '生成四向顺序地格',
    description: '以右、左、下、上四个方向和递增距离生成固定顺序的正交地格。',
    inputs: [port('source', pieceType)], outputs: [port('cells', cellListType)],
    parameters: [parameter('maxDistance', numberType, { default: 3, minimum: 0, maximum: 128 })],
    effects: pure(['pieces', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source'), query = flow(ctx), maxDistance = numberLiteral(ctx, 'maxDistance', 3)
      return `(function(sourceId,maxDistance){if(sourceId==null||!${query}.query.hasPiece(sourceId))return [];var source=${query}.query.piece(sourceId),directions=[[1,0],[-1,0],[0,1],[0,-1]],cells=[];directions.forEach(function(direction){for(var distance=1;distance<=Math.floor(maxDistance);distance+=1)cells.push({x:source.x+direction[0]*distance,y:source.y+direction[1]*distance});});return cells;})(${source},${maxDistance})`
    },
    ui: { category: 'projectile' },
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
    id: 'status.find-player-id',
    label: '查找玩家状态标识',
    description: '按固定状态类型读取玩家状态的稳定标识，不把可变状态对象暴露给作者图。',
    inputs: [port('player', 'player')],
    outputs: [port('id', stringType, { nullable: true })],
    parameters: [parameter('statusType', stringType)],
    effects: pure(['statuses', 'players']),
    lower: ctx => `(function(playerId){var tags=${flow(ctx)}.query.player(playerId).statusTags||[],tag=tags.find(function(item){return item&&item.type===${literal(ctx, 'statusType')};});return tag&&typeof tag.id==='string'?tag.id:null;})(${input(ctx, 'player')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-player-number',
    label: '读取玩家状态数值',
    description: '从暴风雪等登记玩家状态读取固定数值字段。',
    inputs: [port('player', 'player'), port('statusId', stringType, { nullable: true }), port('fallback', numberType)],
    outputs: [port('value', numberType)],
    parameters: [parameter('field', stringType, { enum: ['centerX', 'centerY', 'damage'] })],
    effects: pure(['statuses', 'players']),
    lower: ctx => `(function(playerId,statusId,fallback){if(statusId==null)return fallback;var tags=${flow(ctx)}.query.player(playerId).statusTags||[],tag=tags.find(function(item){return item&&item.id===statusId;}),value=tag&&tag[${literal(ctx, 'field')}];return value==null?fallback:Number(value);})(${input(ctx, 'player')},${input(ctx, 'statusId')},${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.has-source-turn',
    label: '检查来源回合状态',
    description: '按固定类型、来源棋子和当前回合读取追击标记，避免开放任意状态路径。',
    inputs: [port('source', pieceType), port('target', pieceType), port('turn', numberType)],
    outputs: [port('value', booleanType)],
    parameters: [parameter('statusType', stringType)],
    effects: pure(['statuses', 'pieces', 'turn']),
    lower: ctx => `(function(sourceId,targetId,turn){if(sourceId==null||targetId==null||!${flow(ctx)}.query.hasPiece(targetId))return false;var tags=${flow(ctx)}.query.piece(targetId).statusTags||[];return tags.some(function(tag){return tag&&tag.type===${literal(ctx, 'statusType')}&&tag.sourceId===sourceId&&Number(tag.lastDamageTurn)===Number(turn);});})(${input(ctx, 'source')},${input(ctx, 'target')},${input(ctx, 'turn')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.remove-player-id',
    label: '按标识移除玩家状态',
    description: '通过现有玩家状态生命周期移除一个动态标识，不复用棋子状态端口。',
    inputs: [port('player', 'player'), port('statusId', stringType, { nullable: true })],
    outputs: [port('success', booleanType)],
    effects: writes(['statuses', 'events'], ['afterStatusRemoved']),
    lower: ctx => `(${input(ctx, 'statusId')}==null?false:Boolean(${flow(ctx)}.status.remove(${input(ctx, 'player')},${input(ctx, 'statusId')},"player")))`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.clear-piece-tags',
    label: '清空棋子状态',
    description: '通过受控状态生命周期前置清空目标棋子已有状态标签，复用少数旧技能的替换语义。',
    inputs: [port('piece', pieceType)],
    outputs: [port('success', booleanType)],
    effects: writes(['statuses', 'events'], ['afterStatusRemoved']),
    lower: ctx => `(function(pieceId){if(pieceId==null||!${flow(ctx)}.query.hasPiece(pieceId))return false;${flow(ctx)}.query.piece(pieceId).statusTags=[];return true;})(${input(ctx, 'piece')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'piece.set-freeze-effect',
    label: '显示冻结表现',
    description: '设置冻结命中后的受控表现标记，保留旧技能的 UI 状态字段。',
    inputs: [port('piece', pieceType)],
    outputs: [port('success', booleanType)],
    effects: writes(['presentation']),
    lower: ctx => `(function(id){if(!${flow(ctx)}.query.hasPiece(id))return false;${flow(ctx)}.query.piece(id).showFreezeEffect=true;return true;})(${input(ctx, 'piece')})`,
    ui: { category: 'presentation' },
  }),
  define({
    id: 'damage.batch-succeeded-at',
    label: '读取本批指定目标成功',
    description: '读取批量伤害结果中与目标顺序对应的成功事实。',
    inputs: [port('result', recordType), port('index', numberType)],
    outputs: [port('value', booleanType)],
    effects: pure(['damage']),
    lower: ctx => `Boolean(${input(ctx, 'result')}&&Array.isArray(${input(ctx, 'result')}.results)&&${input(ctx, 'result')}.results[${input(ctx, 'index')}]&&${input(ctx, 'result')}.results[${input(ctx, 'index')}].success)`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'effect.batch-succeeded-for',
    label: '读取本批指定目标成功',
    description: '按稳定目标实例标识读取批量伤害或治疗结果的成功事实；目标离场后仍可读取结果记录。',
    inputs: [port('result', recordType), port('target', pieceType)],
    outputs: [port('value', booleanType)],
    effects: pure(['damage', 'heal']),
    lower: ctx => `(function(result,targetId){return Boolean(result&&Array.isArray(result.results)&&result.results.some(function(item){return item&&item.targetId===targetId&&item.success===true;}));})(${input(ctx, 'result')},${input(ctx, 'target')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'effect.batch-number-for',
    label: '读取本批指定目标数值',
    description: '按稳定目标实例标识读取批量伤害或治疗结果中的伤害或治疗量。',
    inputs: [port('result', recordType), port('target', pieceType)],
    outputs: [port('value', numberType)],
    parameters: [parameter('field', stringType, { enum: ['damage', 'heal'], default: 'damage' })],
    effects: pure(['damage', 'heal']),
    lower: ctx => {
      const field = literal(ctx, 'field', 'damage')
      return `(function(result,targetId,field){if(!result||!Array.isArray(result.results))return 0;var item=result.results.find(function(entry){return entry&&entry.targetId===targetId;});var value=item&&item[field];return Number.isFinite(Number(value))?Number(value):0;})(${input(ctx, 'result')},${input(ctx, 'target')},${field})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'result.action-ui',
    label: '构造带表现提示的行动结果',
    description: '保留旧技能成功结果中的 showUIEffects 标记，消息和成功字段仍由图提供。',
    inputs: [port('success', booleanType), port('message', stringType)],
    outputs: [port('result', recordType)],
    effects: pure(),
    lower: ctx => `({success:${input(ctx, 'success')},message:${input(ctx, 'message')},showUIEffects:true})`,
    ui: { category: 'result' },
  }),
  define({
    id: 'skill.add-player',
    label: '玩家获得技能',
    description: '通过现有玩家技能生命周期入口添加技能；技能定义和去重仍由宿主校验。',
    inputs: [port('player', 'player')],
    outputs: [port('success', booleanType)],
    parameters: [parameter('skillId', stringType)],
    effects: writes(['skills'], ['skillAdded']),
    lower: ctx => `Boolean(addPlayerSkillById(${input(ctx, 'player')},${literal(ctx, 'skillId')}))`,
    ui: { category: 'skill' },
  }),
  define({
    id: 'skill.remove-player',
    label: '玩家移除技能',
    description: '通过现有玩家技能生命周期入口移除技能。',
    inputs: [port('player', 'player')],
    outputs: [port('success', booleanType)],
    parameters: [parameter('skillId', stringType)],
    effects: writes(['skills'], ['skillRemoved']),
    lower: ctx => `Boolean(removePlayerSkillById(${input(ctx, 'player')},${literal(ctx, 'skillId')}))`,
    ui: { category: 'skill' },
  }),
  define({
    id: 'tile.add-markers',
    label: '批量添加地格标记',
    description: '使用现有地格批次入口提交一组表现标记，并保留固定展开动画来源。',
    inputs: [port('cells', cellListType), port('origin', cellType), port('sourceId', stringType), port('ownerPlayerId', 'player', { nullable: true, optional: true })],
    outputs: [port('success', booleanType)],
    parameters: [
      parameter('effectType', stringType), parameter('icon', stringType), parameter('bgColor', stringType),
      parameter('boxShadow', stringType), parameter('iconPosition', stringType),
    ],
    effects: writes(['tile-effects']),
    lower: ctx => {
      const cells = input(ctx, 'cells'), origin = input(ctx, 'origin'), sourceId = input(ctx, 'sourceId')
      const hasOwner = typeof ctx.inputs.ownerPlayerId === 'string' && ctx.inputs.ownerPlayerId.length > 0
      const owner = hasOwner ? input(ctx, 'ownerPlayerId') : 'null'
      const ownerField = hasOwner ? ', ownerPlayerId: ownerPlayerId' : ''
      const effect = `{x: cell.x, y: cell.y, sourceId: sourceId, tileType: ${literal(ctx, 'effectType')}, icon: ${literal(ctx, 'icon')}, bgColor: ${literal(ctx, 'bgColor')}, boxShadow: ${literal(ctx, 'boxShadow')}, iconPosition: ${literal(ctx, 'iconPosition')}${ownerField}}`
      return `(function(cells,origin,sourceId,ownerPlayerId){var effects=(Array.isArray(cells)?cells:[]).map(function(cell){return ${effect};});return effects.length>0&&${flow(ctx)}.effects.tileBatch(effects,{presentation:"expand",origin:{x:origin.x,y:origin.y}}).length>0;})(${cells},${origin},${sourceId},${owner})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'tile.add-persistent-markers',
    label: '添加永久地格标记',
    description: '按已计算地格集合写入去重的永久地格效果和来源记录，并沿用地格表现批次。',
    inputs: [port('source', pieceType), port('cells', cellListType), port('tileSourceId', stringType)],
    outputs: [port('added', numberType)],
    parameters: [
      parameter('effectType', stringType), parameter('icon', stringType), parameter('iconPosition', stringType),
      parameter('storageKey', stringType, { enum: ['amaterasuCells'], default: 'amaterasuCells' }),
    ],
    effects: writes(['tile-effects', 'extensions']),
    lower: ctx => {
      const state = battle(ctx), runtimeContext = context(ctx)
      const effectType = literal(ctx, 'effectType'), icon = literal(ctx, 'icon'), iconPosition = literal(ctx, 'iconPosition')
      const storageKey = literal(ctx, 'storageKey', 'amaterasuCells')
      return `(function(sourceId,cells,tileSourceId){var added=0,apply=function(){${state}.extensions=${state}.extensions||{};${state}.extensions.tileEffects=Array.isArray(${state}.extensions.tileEffects)?${state}.extensions.tileEffects:[];${state}.extensions[${storageKey}]=Array.isArray(${state}.extensions[${storageKey}])?${state}.extensions[${storageKey}]:[];var source=${flow(ctx)}.query.hasPiece(sourceId)?${flow(ctx)}.query.piece(sourceId):null;(Array.isArray(cells)?cells:[]).forEach(function(cell){if(!cell||!Number.isInteger(cell.x)||!Number.isInteger(cell.y))return;var tile=${state}.map&&Array.isArray(${state}.map.tiles)?${state}.map.tiles.find(function(item){return item&&item.x===cell.x&&item.y===cell.y;}):null;if(!tile)return;var effectExists=${state}.extensions.tileEffects.some(function(effect){return effect&&effect.tileType===${effectType}&&effect.x===cell.x&&effect.y===cell.y;});if(!effectExists)${state}.extensions.tileEffects.push({x:cell.x,y:cell.y,sourceId:tileSourceId,tileType:${effectType},icon:${icon},iconPosition:${iconPosition}});var recordExists=${state}.extensions[${storageKey}].some(function(record){return record&&record.x===cell.x&&record.y===cell.y;});if(!recordExists){${state}.extensions[${storageKey}].push({x:cell.x,y:cell.y,sourcePieceId:source&&source.instanceId||sourceId,ownerPlayerId:source&&source.ownerPlayerId});added+=1;}})};if(${runtimeContext}.presentationQueue&&typeof ${runtimeContext}.presentationQueue.push==="function")${runtimeContext}.presentationQueue.push("tileEffectAdded",apply);else apply();return added;})(${input(ctx, 'source')},${input(ctx, 'cells')},${input(ctx, 'tileSourceId')})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'extension.set-owner-if-empty',
    label: '设置扩展归属玩家',
    description: '当扩展归属尚未登记时写入来源玩家；已有归属保持不变。',
    inputs: [port('player', 'player')],
    outputs: [port('success', booleanType)],
    parameters: [parameter('storageKey', stringType, { enum: ['amaterasuOwnerPlayerId'], default: 'amaterasuOwnerPlayerId' })],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx), key = literal(ctx, 'storageKey', 'amaterasuOwnerPlayerId')
      return `(function(playerId,key){if(typeof playerId!=="string"||typeof key!=="string")return false;${state}.extensions=${state}.extensions||{};if(${state}.extensions[key]==null)${state}.extensions[key]=playerId;return true;})(${input(ctx, 'player')},${key})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'attribute.adjust-max-hp',
    label: '调整生命上限',
    description: '受控调整棋子生命上限，拒绝低于当前生命的结果并返回实际生命上限。',
    inputs: [port('piece', pieceType), port('amount', numberType)],
    outputs: [port('value', numberType)],
    effects: writes(['attributes']),
    lower: ctx => {
      const query = flow(ctx)
      return `(function(pieceId,amount){if(pieceId==null||!${query}.query.hasPiece(pieceId))return 0;var piece=${query}.query.piece(pieceId),current=Number(piece.currentHp)||0,next=Number(piece.maxHp)+Number(amount);if(!Number.isFinite(next)||next<=0||next<current)return Number(piece.maxHp);piece.maxHp=next;return next;})(${input(ctx, 'piece')},${input(ctx, 'amount')})`
    },
    ui: { category: 'effect' },
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
    id: 'effect.heal-captured',
    label: '治疗已保留来源棋子',
    description: '通过已保留来源句柄治疗单个已保留棋子，允许来源在前一步离场后继续完成当前效果。',
    inputs: [port('source', recordType), port('target', recordType), port('amount', numberType)],
    outputs: [port('result', recordType)],
    parameters: [parameter('skillId', stringType)],
    effects: writes(['heal', 'events'], ['beforeHealDealt', 'afterHealDealt']),
    lower: ctx => `${flow(ctx)}.effects.healManyCaptured(${input(ctx, 'source')},[${flow(ctx)}.effects.capturedIdentifier(${input(ctx, 'target')})],${input(ctx, 'amount')},${literal(ctx, 'skillId')})`,
    ui: { category: 'effect' },
  }),
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
      const path = ctx.parameters.kind === 'teleport' ? '' : `,{passAllies:${passAllies},passEnemies:${passEnemies},terrain:${terrain}}`
      return `(function(value){return {result:value,success:Boolean(value&&value.success)};})(${flow(ctx)}.effects.displace(${request},${kind}${path}))`
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
    parameters: [parameter('storageKey', stringType, { enum: ['coltZones'], default: 'coltZones' }), parameter('kind', stringType, { default: 'revolver' }), parameter('turns', numberType, { default: 2, minimum: 0, maximum: 32 })],
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
