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
 * Generic position/status lifecycle adapters used by delayed movement skills.
 * The graph owns selection, validation order, messages, and branching; these
 * descriptors only cross existing flow boundaries and never expose mutable
 * battle records to author content.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const recordType: GameplayValueType = 'record'
const eventType: GameplayValueType = 'event'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const stringListType: GameplayValueType = { kind: 'list', element: stringType }
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const eventListType: GameplayValueType = { kind: 'list', element: eventType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const stringLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string => {
  const value = ctx.parameters[name] === undefined ? fallback : ctx.parameters[name]
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}
const numberLiteral = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}
const booleanLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback?: boolean): string => {
  const value = ctx.parameters[name] === undefined ? fallback : ctx.parameters[name]
  if (typeof value !== 'boolean') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be boolean`)
  return ctx.emitLiteral(value)
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, ...(reads.length ? { reads } : {}) })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({ version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value })

const MOVEMENT_FAMILY_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'choice.target-cell-by-range', label: '按计算范围选择地格',
    description: '复用现有地格选择协议，但让技能图先计算合法范围；挂起结果保留宿主的原始 range。',
    inputs: [port('range', numberType)], outputs: [port('choice', 'choice')],
    parameters: [parameter('filter', stringType, { enum: ['enemy', 'ally', 'all'], default: 'all' })],
    effects: { pure: false, previewSafe: false, writes: ['pending'], pending: true },
    lower: ctx => {
      const filter = stringLiteral(ctx, 'filter', 'all')
      const choice = `{type: "grid", range: ${input(ctx, 'range')}, filter: ${filter}}`
      return ctx.surface === 'pending' ? `ctx.flow.choice.target(${choice})` : `selectTarget(${choice})`
    },
    ui: { category: 'choice' },
  }),
  define({
    id: 'spatial.cardinal-direction', label: '计算正交方向',
    description: '由两个地格计算固定单位正交方向、距离和同格事实；图负责决定非法选择的结果。',
    inputs: [port('from', cellType), port('to', cellType)],
    outputs: [port('direction', cellType), port('valid', booleanType), port('sameCell', booleanType), port('distance', numberType)],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(function(from,to){var dx=to.x-from.x,dy=to.y-from.y,same=dx===0&&dy===0,valid=(dx===0)!==(dy===0);return {direction:{x:dx===0?0:(dx>0?1:-1),y:dy===0?0:(dy>0?1:-1)},valid:valid,sameCell:same,distance:Math.max(Math.abs(dx),Math.abs(dy))};})(${input(ctx, 'from')},${input(ctx, 'to')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'value.select-cell', label: '按条件选择地格',
    description: '在两个已计算地格之间按布尔条件选择一个，不改变地格或棋子状态。',
    inputs: [port('condition', booleanType), port('whenTrue', cellType), port('whenFalse', cellType)], outputs: [port('cell', cellType)],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(${input(ctx, 'condition')}?${input(ctx, 'whenTrue')}:${input(ctx, 'whenFalse')})`,
    ui: { category: 'value' },
  }),
  define({
    id: 'spatial.random-cardinal-landing', label: '随机正交相邻落点',
    description: '按旧追踪攻击的上、右、下、左顺序读取可行走且无存活占位的相邻地格，并交给权威随机源；所有存活棋子都占据地格。',
    inputs: [port('target', pieceType)],
    outputs: [port('cell', cellType, { nullable: true })],
    effects: { pure: true, previewSafe: false, reads: ['position', 'pieces', 'random'], random: true },
    lower: ctx => {
      const state = ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
      const runtime = flow(ctx)
      return `(function(targetId){var target=(${state}.pieces||[]).find(function(piece){return piece&&piece.instanceId===targetId;});if(!target)return null;var offsets=[[0,-1],[1,0],[0,1],[-1,0]],cells=offsets.map(function(offset){return {x:target.x+offset[0],y:target.y+offset[1]};}).filter(function(cell){var tile=(${state}.map&&${state}.map.tiles||[]).find(function(item){return item&&item.x===cell.x&&item.y===cell.y;});if(!tile||!tile.props||!tile.props.walkable)return false;return !(${state}.pieces||[]).some(function(piece){return piece&&piece.currentHp>0&&piece.x===cell.x&&piece.y===cell.y;});});return ${runtime}.query.random(cells);})(${input(ctx, 'target')})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.square-cells', label: '生成方形范围地格',
    description: '按固定 y 外层、x 内层顺序生成以中心为基准的有界方形地格集合。',
    inputs: [port('center', cellType)], outputs: [port('cells', cellListType)],
    parameters: [parameter('radius', numberType, { default: 1, minimum: 0, maximum: 32 })],
    effects: { pure: true, previewSafe: true },
    lower: ctx => {
      const radiusValue = ctx.parameters.radius === undefined ? 1 : ctx.parameters.radius
      if (typeof radiusValue !== 'number' || !Number.isInteger(radiusValue) || radiusValue < 0 || radiusValue > 32) throw new Error(`module ${ctx.moduleId}: radius must be a bounded integer`)
      const radius = ctx.emitLiteral(radiusValue)
      return `(function(center,radius){var cells=[];for(var dx=-radius;dx<=radius;dx+=1)for(var dy=-radius;dy<=radius;dy+=1)cells.push({x:center.x+dx,y:center.y+dy});return cells;})(${input(ctx, 'center')},${radius})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.perpendicular-cells', label: '计算正交两侧地格',
    description: '由冲刺终点和单位方向计算左、右两侧的地格记录。',
    inputs: [port('center', cellType), port('direction', cellType)],
    outputs: [port('left', cellType), port('right', cellType)],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(function(center,direction){return {left:{x:center.x+direction.y,y:center.y-direction.x},right:{x:center.x-direction.y,y:center.y+direction.x}};})(${input(ctx, 'center')},${input(ctx, 'direction')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'context.primary-target-rewritten', label: '读取规则改写目标事实',
    description: '只判断当前技能上下文是否把指定棋子作为规则改写的主目标，不暴露任意上下文字段。',
    inputs: [port('target', pieceType)], outputs: [port('value', booleanType)],
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => {
      const current = ctx.surface === 'pending' ? 'ctx' : 'context'
      return `(${current}.ruleRewrittenPrimaryTargetPieceId===${input(ctx, 'target')})`
    },
    ui: { category: 'context' },
  }),
  define({
    id: 'movement.trace', label: '读取正交位移路径事实',
    description: '通过统一移动路径观察器读取逐格落点、阻挡、首个敌人和可落脚地格；只返回不透明集合及标量事实，位移提交仍由 effect.displace-policy 完成。',
    inputs: [
      port('source', pieceType), port('direction', cellType), port('maxDistance', numberType),
    ],
    outputs: [
      port('cells', cellListType), port('encounters', recordListType), port('lastLandable', cellType, { nullable: true }), port('hasNewLandable', booleanType),
      port('blocked', booleanType), port('reachedTarget', booleanType), port('firstEnemy', pieceType, { nullable: true }),
      port('enemyPieces', pieceListType), port('beforeFirstEnemy', cellType), port('firstEnemyDistance', numberType),
    ],
    parameters: [
      parameter('passAllies', booleanType, { default: true }),
      parameter('passEnemies', booleanType, { default: true }),
      parameter('terrain', stringType, { enum: ['walkable', 'projectile', 'any'], default: 'walkable' }),
      parameter('blockedTerrainTypes', stringListType, { default: [] }),
    ],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'players', 'position', 'map'] },
    lower: ctx => {
      const source = input(ctx, 'source')
      const direction = input(ctx, 'direction')
      const maxDistance = input(ctx, 'maxDistance')
      const passAllies = booleanLiteral(ctx, 'passAllies', true)
      const passEnemies = booleanLiteral(ctx, 'passEnemies', true)
      const terrain = stringLiteral(ctx, 'terrain', 'walkable')
      const blocked = ctx.parameters.blockedTerrainTypes === undefined ? '[]' : ctx.emitLiteral(ctx.parameters.blockedTerrainTypes as never)
      const query = flow(ctx)
      return `(function(sourceId,direction,maxDistance,passAllies,passEnemies,terrain,blockedTerrainTypes){
        if(sourceId==null||!${query}.query.hasPiece(sourceId)||!direction||!Number.isInteger(direction.x)||!Number.isInteger(direction.y)||!Number.isSafeInteger(maxDistance)||maxDistance<0)return {cells:[],encounters:[],lastLandable:null,hasNewLandable:false,blocked:true,reachedTarget:false,firstEnemy:null,enemyPieces:[],beforeFirstEnemy:${query}.query.hasPiece(sourceId)?{x:${query}.query.piece(sourceId).x,y:${query}.query.piece(sourceId).y}:{x:0,y:0},firstEnemyDistance:0};
        var source=${query}.query.piece(sourceId),trace=${query}.query.tracePath({x:source.x,y:source.y},{x:direction.x,y:direction.y},{excludePieceId:sourceId,maxDistance:Math.floor(maxDistance),passAllies:passAllies,passEnemies:passEnemies,terrain:terrain,blockedTerrainTypes:Array.isArray(blockedTerrainTypes)?blockedTerrainTypes:[]})||{},enemyIds=${query}.query.pieces({originId:sourceId,relation:"enemy",includeDead:false})||[],firstEnemy=null,firstEnemyDistance=0,beforeFirstEnemy={x:source.x,y:source.y},seenEnemy={},enemyPieces=[];
        var firstEnemyEncounter=Array.isArray(trace.encounters)?trace.encounters.find(function(encounter){return encounter&&encounter.type==="piece"&&enemyIds.indexOf(encounter.pieceId)>=0;}):null;
        if(firstEnemyEncounter){firstEnemy=firstEnemyEncounter.pieceId;firstEnemyDistance=Math.max(Math.abs(Number(firstEnemyEncounter.x)-source.x),Math.abs(Number(firstEnemyEncounter.y)-source.y));}
        (Array.isArray(trace.encounters)?trace.encounters:[]).forEach(function(encounter){if(!encounter||encounter.type!=="piece"||enemyIds.indexOf(encounter.pieceId)<0||seenEnemy[encounter.pieceId])return;seenEnemy[encounter.pieceId]=true;enemyPieces.push(encounter.pieceId);});
        if(firstEnemyEncounter){(Array.isArray(trace.cells)?trace.cells:[]).forEach(function(cell){if(cell&&cell.x===firstEnemyEncounter.x&&cell.y===firstEnemyEncounter.y)return;if(firstEnemyDistance&&Math.max(Math.abs(cell.x-source.x),Math.abs(cell.y-source.y))>=firstEnemyDistance)return;var occupied=(${query}.query.pieces({includeDead:false})||[]).some(function(id){var piece=${query}.query.piece(id);return piece&&piece.x===cell.x&&piece.y===cell.y;});if(!occupied)beforeFirstEnemy={x:cell.x,y:cell.y};});}
        var last=trace.lastLandableCell||null,hasNew=Boolean(last&&((last.x!==source.x)||(last.y!==source.y)));
        return {cells:Array.isArray(trace.cells)?trace.cells:[],encounters:Array.isArray(trace.encounters)?trace.encounters:[],lastLandable:last,hasNewLandable:hasNew,blocked:Boolean(trace.blocked),reachedTarget:Boolean(trace.reachedTarget),firstEnemy:firstEnemy,enemyPieces:enemyPieces,beforeFirstEnemy:beforeFirstEnemy,firstEnemyDistance:firstEnemyDistance};
      })(${source},${direction},${maxDistance},${passAllies},${passEnemies},${terrain},${blocked})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'movement.actual-path-enemies', label: '按实际位移路径查询敌人',
    description: '从权威位移结果的实际路径逐格读取敌方棋子并按首次接触去重；目标集合只读，后续伤害仍由图逐项提交。',
    inputs: [port('source', recordType), port('movement', recordType)],
    outputs: [port('pieces', pieceListType)],
    effects: { pure: true, previewSafe: false, reads: ['execution-context', 'pieces', 'players', 'position'] },
    lower: ctx => {
      const runtime = flow(ctx)
      return `(function(source,movement){var sourceId=${runtime}.effects.capturedIdentifier(source),ownerId=${runtime}.effects.capturedOwner(source),enemyIds=${runtime}.query.pieces({ownerId:ownerId,relation:"enemy",includeDead:false})||[],changes=movement&&Array.isArray(movement.changes)?movement.changes:[],change=changes.find(function(item){return item&&item.pieceId===sourceId;}),path=change&&Array.isArray(change.path)?change.path:[],seen={},result=[];for(var pathIndex=0;pathIndex<path.length;pathIndex+=1){var cell=path[pathIndex];if(!cell)continue;for(var enemyIndex=0;enemyIndex<enemyIds.length;enemyIndex+=1){var enemyId=enemyIds[enemyIndex];if(seen[enemyId])continue;var enemy=${runtime}.query.piece(enemyId);if(enemy&&enemy.currentHp>0&&enemy.x===cell.x&&enemy.y===cell.y){seen[enemyId]=true;result.push(enemyId);}}}return result;})(${input(ctx, 'source')},${input(ctx, 'movement')})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'effect.displace-policy', label: '按路径策略提交位移',
    description: '调用统一 flow.effects.displace/flow.effects.move 路径提交器，并开放有限可穿越和地形策略；不直接写入坐标。',
    inputs: [port('piece', pieceType, { label: '棋子' }), port('destination', cellType, { label: '目标地格' })],
    outputs: [port('result', recordType), port('success', booleanType), port('changed', booleanType), port('steps', numberType)],
    parameters: [
      parameter('kind', stringType, { label: '位移方式', description: '传送（teleport）、冲刺（dash）或拉拽（pull）；图中保留稳定英文标识。', enum: ['dash', 'teleport', 'pull'], default: 'dash' }),
      parameter('passAllies', booleanType, { label: '可穿越友方', default: true }),
      parameter('passEnemies', booleanType, { label: '可穿越敌方', default: true }),
      parameter('terrain', stringType, { label: '地形策略', description: '可通行（walkable）、弹道（projectile）或任意（any）；图中保留稳定英文标识。', enum: ['walkable', 'projectile', 'any'], default: 'any' }),
      parameter('blockedTerrainTypes', stringListType, { label: '屏蔽地形类型', description: '填写需要阻挡路径的稳定地形标识列表。', default: [] }),
    ],
    effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => {
      const destination = input(ctx, 'destination')
      const kind = stringLiteral(ctx, 'kind', 'dash')
      const passAllies = booleanLiteral(ctx, 'passAllies', true)
      const passEnemies = booleanLiteral(ctx, 'passEnemies', true)
      const terrain = stringLiteral(ctx, 'terrain', 'any')
      const blockedTerrainTypes = ctx.parameters.blockedTerrainTypes === undefined ? '[]' : ctx.emitLiteral(ctx.parameters.blockedTerrainTypes as never)
      const request = `[ {pieceId:${input(ctx, 'piece')},x:(${destination}).x,y:(${destination}).y} ]`
      const query = flow(ctx)
      const options = `{passAllies:${passAllies},passEnemies:${passEnemies},terrain:${terrain},blockedTerrainTypes:Array.isArray(${blockedTerrainTypes})?${blockedTerrainTypes}:[]}`
      const submit = `(${kind} === "teleport" ? ${query}.effects.move(${request},${kind}) : ${query}.effects.displace(${request},${kind},${options}))`
      return `(function(value){var changes=Array.isArray(value&&value.changes)?value.changes:[];return {result:value,success:Boolean(value&&value.success),changed:changes.length>0,steps:changes.filter(function(change){return change&&change.pieceId===${input(ctx, 'piece')};}).reduce(function(total,change){return total+(Array.isArray(change.path)?change.path.length:0);},0)};})${submit}`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'effect.swap-pieces', label: '原子交换棋子位置',
    description: '在提交前读取双方当前位置快照，再以一次统一 swap 位移批次交换位置；触发器、阻挡和回滚全部由权威位移生命周期处理。',
    inputs: [port('first', pieceType, { label: '第一枚棋子' }), port('second', pieceType, { label: '第二枚棋子' })],
    outputs: [port('result', recordType), port('success', booleanType), port('changed', booleanType)],
    effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => {
      const first = input(ctx, 'first')
      const second = input(ctx, 'second')
      const query = flow(ctx)
      return `(function(firstId,secondId){if(firstId==null||secondId==null||!${query}.query.hasPiece(firstId)||!${query}.query.hasPiece(secondId))return {result:{success:false,changes:[]},success:false,changed:false};var first=${query}.query.piece(firstId),second=${query}.query.piece(secondId),changes=[{pieceId:firstId,x:second.x,y:second.y},{pieceId:secondId,x:first.x,y:first.y}],value=${query}.effects.displace(changes,"swap");return {result:value,success:Boolean(value&&value.success),changed:Boolean(value&&Array.isArray(value.changes)&&value.changes.length)};})(${first},${second})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'projectile.trace-strict', label: '严格正交弹道观察',
    description: '复用宿主 traceProjectile 的严格方向校验；非法斜向输入保留旧内容的 RangeError，而事件读取仍由后续原子完成。',
    inputs: [port('source', pieceType), port('target', cellType)],
    outputs: [port('events', eventListType), port('dx', numberType), port('dy', numberType), port('valid', booleanType), port('sameCell', booleanType), port('distance', numberType)],
    parameters: [parameter('maxDistance', numberType, { default: 99, minimum: 0, maximum: 128 })],
    effects: pure(['pieces', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const query = flow(ctx)
      const maxDistance = numberLiteral(ctx, 'maxDistance')
      return `(function(sourceId,targetCell,maxDistance){if(sourceId==null||!targetCell||!Number.isInteger(targetCell.x)||!Number.isInteger(targetCell.y)||!${query}.query.hasPiece(sourceId))return {events:[],dx:0,dy:0,valid:false,sameCell:false,distance:0};var source=${query}.query.piece(sourceId),dx=targetCell.x-source.x,dy=targetCell.y-source.y,sameCell=dx===0&&dy===0,valid=(dx===0)!==(dy===0),sx=dx===0?0:(dx>0?1:-1),sy=dy===0?0:(dy>0?1:-1),events=${query}.query.path({x:source.x,y:source.y},{x:sx,y:sy},{maxDistance:Math.floor(maxDistance),excludePieceId:sourceId});return {events:events,dx:sx,dy:sy,valid:valid,sameCell:sameCell,distance:Math.max(Math.abs(dx),Math.abs(dy))};})(${source},${target},${maxDistance})`
    },
    ui: { category: 'projectile' },
  }),
  define({
    id: 'movement.first-piece-on-trace', label: '读取射线首个棋子',
    description: '从既有逐格路径事件读取首个棋子及敌我事实；障碍或边界在首个棋子前终止观察，不改变棋盘状态。',
    inputs: [port('source', pieceType), port('events', eventListType)],
    outputs: [
      port('piece', pieceType, { nullable: true }), port('enemy', booleanType), port('distance', numberType),
      port('cell', cellType, { nullable: true }), port('present', booleanType),
    ],
    effects: { pure: true, previewSafe: false, reads: ['event', 'pieces', 'players', 'position'] },
    lower: ctx => {
      const source = input(ctx, 'source')
      const events = input(ctx, 'events')
      const query = flow(ctx)
      return `(function(sourceId,events){if(sourceId==null||!${query}.query.hasPiece(sourceId))return {piece:null,enemy:false,distance:0,cell:null,present:false};var source=${query}.query.piece(sourceId),list=Array.isArray(events)?events:[];for(var index=0;index<list.length;index+=1){var event=list[index];if(!event)continue;if(event.type==='boundary')break;if(event.type==='terrain'&&event.blocksProjectile)break;if(event.type!=='piece')continue;var id=event.pieceId||(event.piece&&event.piece.instanceId),piece=id!=null&&${query}.query.hasPiece(id)?${query}.query.piece(id):null;if(!piece)return {piece:null,enemy:false,distance:Number(event.distance||0),cell:{x:Number(event.x),y:Number(event.y)},present:false};return {piece:piece.instanceId,enemy:!${query}.query.alliedPlayers(piece.ownerPlayerId,source.ownerPlayerId),distance:Number(event.distance||0),cell:{x:Number(event.x),y:Number(event.y)},present:true};}return {piece:null,enemy:false,distance:0,cell:null,present:false};})(${source},${events})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'movement.first-trace-obstruction', label: '读取射线首个阻挡',
    description: '按事件顺序读取射线上的首个地形或棋子阻挡，并在命中棋子时返回敌我事实；不修改棋盘。',
    inputs: [port('source', pieceType), port('events', eventListType)],
    outputs: [
      port('piece', pieceType, { nullable: true }), port('enemy', booleanType), port('ally', booleanType),
      port('distance', numberType), port('cell', cellType, { nullable: true }), port('present', booleanType), port('terrainBlocked', booleanType),
    ],
    effects: pure(['event', 'pieces', 'players', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const events = input(ctx, 'events')
      const query = flow(ctx)
      return `(function(sourceId,events){if(sourceId==null||!${query}.query.hasPiece(sourceId))return {piece:null,enemy:false,ally:false,distance:0,cell:null,present:false,terrainBlocked:false};var source=${query}.query.piece(sourceId),list=Array.isArray(events)?events:[];for(var index=0;index<list.length;index+=1){var event=list[index];if(!event)continue;if(event.type==='boundary')break;if(event.type==='terrain'){if(event.blocksProjectile)return {piece:null,enemy:false,ally:false,distance:Number(event.distance||0),cell:{x:Number(event.x),y:Number(event.y)},present:false,terrainBlocked:true};continue;}if(event.type!=='piece')continue;var id=event.pieceId||(event.piece&&event.piece.instanceId),piece=id!=null&&${query}.query.hasPiece(id)?${query}.query.piece(id):null;if(!piece)return {piece:null,enemy:false,ally:false,distance:Number(event.distance||0),cell:{x:Number(event.x),y:Number(event.y)},present:false,terrainBlocked:false};var ally=${query}.query.alliedPlayers(piece.ownerPlayerId,source.ownerPlayerId);return {piece:piece.instanceId,enemy:!ally,ally:ally,distance:Number(event.distance||0),cell:{x:Number(event.x),y:Number(event.y)},present:true,terrainBlocked:false};}return {piece:null,enemy:false,ally:false,distance:0,cell:null,present:false,terrainBlocked:false};})(${source},${events})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'query.has-piece-id', label: '按文本标识判断棋子存在',
    description: '给图循环使用的稳定实例标识提供存在性检查；不返回或修改棋盘对象。',
    inputs: [port('id', stringType, { nullable: true })], outputs: [port('exists', booleanType)],
    effects: { pure: true, previewSafe: false, reads: ['pieces'] },
    lower: ctx => `(${input(ctx, 'id')} != null && ${flow(ctx)}.query.hasPiece(${input(ctx, 'id')}))`,
    ui: { category: 'query' },
  }),
  define({
    id: 'movement.bounce-candidates', label: '查询 bounce 候选敌人',
    description: '按来源当前位置、敌我关系、存活事实、范围和已命中标识查询下一组候选；随机选择由图中的 query.random-item 完成。',
    inputs: [port('sourceId', stringType), port('excluded', stringListType), port('range', numberType)],
    outputs: [port('pieces', pieceListType)],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'players', 'position'] },
    lower: ctx => {
      const runtime = flow(ctx)
      return `(function(sourceId,excluded,range){if(sourceId==null||!${runtime}.query.hasPiece(sourceId)||!Number.isFinite(range)||range<0)return [];var source=${runtime}.query.piece(sourceId),excludedIds=Array.isArray(excluded)?excluded:[],ids=${runtime}.query.pieces({originId:sourceId,relation:"enemy",includeDead:false})||[];return ids.filter(function(id){if(id==null||excludedIds.indexOf(id)>=0)return false;var target=${runtime}.query.piece(id);return Boolean(target&&Math.abs(target.x-source.x)+Math.abs(target.y-source.y)<=range);});})(${input(ctx, 'sourceId')},${input(ctx, 'excluded')},${input(ctx, 'range')})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'collection.piece-at', label: '读取棋子集合项',
    description: '按本次执行的有界索引读取棋子集合项；越界返回空引用，不改变集合或棋盘状态。',
    inputs: [port('items', pieceListType), port('index', numberType)],
    outputs: [port('piece', pieceType, { nullable: true })],
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => `(Array.isArray(${input(ctx, 'items')})&&Number.isInteger(${input(ctx, 'index')})&&${input(ctx, 'index')}>=0&&${input(ctx, 'index')}<${input(ctx, 'items')}.length?${input(ctx, 'items')}[${input(ctx, 'index')}]:null)`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'local.string-list-create', label: '创建本次执行文本集合',
    description: '在当前技能图执行中创建可变的局部文本集合；不写入棋盘或可保存状态。',
    inputs: [port('items', stringListType)], outputs: [port('list', recordType)],
    effects: { pure: false, previewSafe: false, writes: ['execution-context'] },
    lower: ctx => `(function(items){return {values:Array.isArray(items)?items.slice():[]};})(${input(ctx, 'items')})`,
    ui: { category: 'flow' },
  }),
  define({
    id: 'local.string-list-read', label: '读取本次执行文本集合',
    description: '读取局部文本集合的当前快照供查询原子使用。',
    inputs: [port('list', recordType)], outputs: [port('items', stringListType)],
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => `(Array.isArray(${input(ctx, 'list')}&&${input(ctx, 'list')}.values)?${input(ctx, 'list')}.values:[])`,
    ui: { category: 'flow' },
  }),
  define({
    id: 'local.string-list-append', label: '追加本次执行文本集合',
    description: '向局部文本集合追加一个稳定标识；仅改变本次图执行的局部值。',
    inputs: [port('list', recordType), port('value', stringType)], outputs: [port('success', booleanType)],
    effects: { pure: false, previewSafe: false, writes: ['execution-context'] },
    lower: ctx => `(function(list,value){if(!list||!Array.isArray(list.values))return false;list.values.push(value);return true;})(${input(ctx, 'list')},${input(ctx, 'value')})`,
    ui: { category: 'flow' },
  }),
  define({
    id: 'status.remove-expired-turn-type', label: '移除过期回合状态',
    description: '按封闭状态类型和回合编号经 status lifecycle 移除已过期棋子状态，保留当前回合状态。',
    inputs: [port('target', pieceType), port('turn', numberType)], outputs: [port('success', booleanType)],
    parameters: [parameter('statusType', stringType)],
    effects: writes(['status', 'rule', 'events'], ['afterStatusRemoved']),
    lower: ctx => {
      const target = input(ctx, 'target')
      const turn = input(ctx, 'turn')
      const type = stringLiteral(ctx, 'statusType')
      const runtime = flow(ctx)
      return `(function(pieceId,currentTurn){if(pieceId==null||!${runtime}.query.hasPiece(pieceId))return false;var piece=${runtime}.query.piece(pieceId),tags=Array.isArray(piece&&piece.statusTags)?piece.statusTags.slice():[];tags.forEach(function(tag){if(tag&&tag.type===${type}&&Number(tag.turnNumber)!==Number(currentTurn)&&typeof tag.id==='string')${runtime}.status.remove(pieceId,tag.id,"piece");});return true;})(${target},${turn})`
    },
    ui: { category: 'status' },
  }),
  define({
    id: 'source.capture-list', label: '按路径顺序保留棋子集合',
    description: '按既有执行来源句柄逐项保留有限棋子集合；供位移提交前固定路径目标，不能跨执行复用。',
    inputs: [port('pieces', pieceListType)], outputs: [port('sources', recordListType)],
    effects: writes(['execution-context']),
    lower: ctx => {
      const runtime = flow(ctx)
      return `(function(pieces){return (Array.isArray(pieces)?pieces:[]).map(function(pieceId){return ${runtime}.effects.captureSource(pieceId);});})(${input(ctx, 'pieces')})`
    },
    ui: { category: 'context' },
  }),
  define({
    id: 'effect.damage-captured-list', label: '使用已保留目标批量伤害',
    description: '把已保留的目标句柄按图中顺序转换为权威伤害批次；来源或目标随后离场时仍沿用本次结算句柄。',
    inputs: [port('source', recordType), port('targets', recordListType), port('amount', numberType)],
    outputs: [port('result', recordType)],
    parameters: [parameter('damageType', stringType, { enum: ['physical', 'magical', 'true'], default: 'physical' }), parameter('skillId', stringType)],
    effects: writes(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const runtime = flow(ctx)
      return `(function(source,targets){var ids=(Array.isArray(targets)?targets:[]).map(function(target){return ${runtime}.effects.capturedIdentifier(target);});return ${runtime}.effects.damageManyCaptured(source,ids,${input(ctx, 'amount')},${stringLiteral(ctx, 'damageType', 'physical')},${stringLiteral(ctx, 'skillId')});})(${input(ctx, 'source')},${input(ctx, 'targets')})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'damage.batch-total', label: '读取本批总伤害',
    description: '按权威批量结果的实际伤害字段求和，保留目标离场后的消息数值。',
    inputs: [port('result', recordType)], outputs: [port('value', numberType)],
    effects: { pure: true, previewSafe: false },
    lower: ctx => `((Array.isArray(${input(ctx, 'result')}.results) ? ${input(ctx, 'result')}.results : []).reduce(function(total,item){return total + Number(item&&item.damage||0);},0))`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'status.refresh-position', label: '刷新位置状态',
    description: '通过状态宿主更新已有位置载荷和剩余持续时间，不创建第二份状态记录。',
    inputs: [port('target', pieceType), port('x', numberType), port('y', numberType)],
    outputs: [port('success', booleanType)],
    parameters: [parameter('statusType', stringType), parameter('duration', numberType)],
    effects: writes(['status']),
    lower: ctx => `${flow(ctx)}.status.refreshPosition(${input(ctx, 'target')}, ${stringLiteral(ctx, 'statusType')}, ${input(ctx, 'x')}, ${input(ctx, 'y')}, ${numberLiteral(ctx, 'duration')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'tile.add-marker', label: '添加地格标记',
    description: '通过既有 tileBatch 入口添加不阻挡进入的来源地格表现，并保留旧记录字段。',
    inputs: [port('cell', cellType), port('sourceId', stringType)],
    outputs: [port('success', booleanType)],
    parameters: [
      parameter('effectType', stringType), parameter('icon', stringType), parameter('bgColor', stringType),
      parameter('boxShadow', stringType), parameter('iconPosition', stringType),
    ],
    effects: writes(['tile-effects']),
    lower: ctx => {
      const cell = input(ctx, 'cell'), sourceId = input(ctx, 'sourceId')
      const effect = `{x: (${cell}).x, y: (${cell}).y, sourceId: ${sourceId}, tileType: ${stringLiteral(ctx, 'effectType')}, icon: ${stringLiteral(ctx, 'icon')}, bgColor: ${stringLiteral(ctx, 'bgColor')}, boxShadow: ${stringLiteral(ctx, 'boxShadow')}, iconPosition: ${stringLiteral(ctx, 'iconPosition')}}`
      return `(function(effect) { var committed = ${flow(ctx)}.effects.tileBatch([effect]); if (!committed.length) return false; var keys = Object.keys(effect); Object.keys(committed[0]).forEach(function(key) { if (keys.indexOf(key) < 0) delete committed[0][key]; }); return true; })(${effect})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'tile.clear-marker', label: '清理来源地格标记',
    description: '按地格类型和不透明来源标识清理既有地格表现。',
    inputs: [port('sourceId', stringType)], outputs: [port('success', booleanType)],
    parameters: [parameter('effectType', stringType)],
    effects: writes(['tile-effects']),
    lower: ctx => `${flow(ctx)}.effects.clearTileMarkers(${stringLiteral(ctx, 'effectType')}, ${input(ctx, 'sourceId')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'effect.teleport-with-change', label: '读取传送实际位移',
    description: '沿用权威传送提交器，并暴露是否提交了实际坐标变化以保留旧内容的无位移分支。',
    inputs: [port('piece', pieceType), port('destination', cellType)],
    outputs: [port('result', recordType), port('success', booleanType), port('changed', booleanType)],
    parameters: [parameter('kind', stringType, { enum: ['teleport', 'dash', 'walk', 'push', 'pull', 'swap'], default: 'teleport' })],
    effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => {
      const destination = input(ctx, 'destination')
      const kind = stringLiteral(ctx, 'kind')
      const move = `${flow(ctx)}.effects.move([{pieceId: ${input(ctx, 'piece')}, x: (${destination}).x, y: (${destination}).y}], ${kind})`
      return `(function(value){return {result: value, success: value.success, changed: Boolean(value.changes && value.changes.length)}})(${move})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'lifecycle.remove-enemy', label: '使目标敌方棋子出局',
    description: '通过主动技能生命周期入口使当前仍存在的敌方目标出局；宿主校验当前敌方关系与技能入口，不直接编辑棋子集合。',
    inputs: [port('target', pieceType, { nullable: true })], outputs: [port('success', booleanType)],
    inspectReferences: ['target'],
    effects: writes(['pieces', 'events']),
    lower: ctx => `(function(targetId) { if (targetId == null || !${flow(ctx)}.query.hasPiece(targetId)) return false; return Boolean(${flow(ctx)}.lifecycle.removeEnemy(targetId)); })(${input(ctx, 'target')})`,
    ui: { category: 'lifecycle', authoring: 'standard' },
  }),
]

export const MOVEMENT_FAMILY_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze(MOVEMENT_FAMILY_PRIMITIVES)
