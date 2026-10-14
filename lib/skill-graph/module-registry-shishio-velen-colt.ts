import type {
  GameplayModuleDescriptor as Descriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext as Context,
  GameplayValueType,
} from './module-types'

/**
 * Closed host facts used by the remaining RED-252 rule migrations.
 *
 * These descriptors deliberately expose IDs, cells, records and scalar
 * results.  Mutable pieces, statuses, cards and extension objects stay in the
 * host facade; an author graph never receives one of those objects directly.
 */

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const flow = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const context = (ctx: Context) => ctx.surface === 'pending' ? 'ctx' : 'context'
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): Descriptor => ({
  version: '1', allowedSurfaces: value.allowedSurfaces ?? surfaces, ...value,
})
const input = (ctx: Context, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const parameter = (ctx: Context, name: string): string => ctx.emitLiteral(ctx.parameters[name])

const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
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

const QUERY_MODULES: readonly Descriptor[] = [
  define({
    id: 'collection.single-piece-list', label: '构造单棋子集合',
    inputs: [{ name: 'piece', type: pieceType }], outputs: [{ name: 'pieces', type: pieceListType }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `[${input(ctx, 'piece')}]`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'collection.first-cell', label: '读取首个地格',
    inputs: [{ name: 'cells', type: cellListType }], outputs: [{ name: 'cell', type: cellType, nullable: true }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(Array.isArray(${input(ctx, 'cells')})&&${input(ctx, 'cells')}.length?${input(ctx, 'cells')}[0]:null)`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'collection.text-list-create', label: '创建文本集合',
    inputs: [], outputs: [{ name: 'items', type: stringListType }],
    effects: { pure: true, previewSafe: true },
    lower: () => '[]',
    ui: { category: 'collection' },
  }),
  define({
    id: 'collection.text-list-add', label: '追加文本集合项',
    description: '只修改 graph-local 文本集合；用于 foreach 中保留每个通用效果的可观察消息。',
    inputs: [{ name: 'items', type: stringListType }, { name: 'value', type: stringType }],
    outputs: [{ name: 'items', type: stringListType }, { name: 'count', type: numberType }],
    effects: { pure: false, previewSafe: true, writes: ['local'] },
    lower: ctx => `(function(items,value){if(!Array.isArray(items))return {items:[],count:0};items.push(String(value));return {items:items,count:items.length};})(${input(ctx, 'items')},${input(ctx, 'value')})`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'spatial.perpendicular-direction', label: '计算侧向正交方向',
    inputs: [{ name: 'dx', type: numberType }, { name: 'dy', type: numberType }, { name: 'side', type: stringType }], outputs: [{ name: 'direction', type: cellType }],
    parameters: [],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `((${input(ctx, 'side')}==='left')?{x:${input(ctx, 'dy')},y:-${input(ctx, 'dx')}}:{x:-${input(ctx, 'dy')},y:${input(ctx, 'dx')}})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-equal', label: '比较地格坐标',
    inputs: [{ name: 'left', type: cellType, nullable: true }, { name: 'right', type: cellType, nullable: true }], outputs: [{ name: 'value', type: booleanType }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(Boolean(${input(ctx, 'left')})&&Boolean(${input(ctx, 'right')})&&${input(ctx, 'left')}.x===${input(ctx, 'right')}.x&&${input(ctx, 'left')}.y===${input(ctx, 'right')}.y)`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.ray-cells', label: '读取正交射线地格',
    description: '从来源棋子沿已验证的正交方向读取存在于地图中的地格；不破坏地形、不查询目标。',
    inputs: [{ name: 'source', type: pieceType }, { name: 'direction', type: cellType }],
    outputs: [{ name: 'cells', type: cellListType }],
    parameters: [{ name: 'maxDistance', type: numberType, default: 6 }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'position', 'map'] },
    lower: ctx => `(function(sourceId,direction,maxDistance){if(sourceId==null||!direction||!Number.isInteger(direction.x)||!Number.isInteger(direction.y)||!${flow(ctx)}.query.hasPiece(sourceId))return [];var source=${flow(ctx)}.query.piece(sourceId),tiles=${battle(ctx)}.map&&Array.isArray(${battle(ctx)}.map.tiles)?${battle(ctx)}.map.tiles:[],result=[];for(var step=1;step<=Math.floor(maxDistance);step+=1){var cell={x:source.x+direction.x*step,y:source.y+direction.y*step};if(!tiles.some(function(tile){return tile&&tile.x===cell.x&&tile.y===cell.y;}))break;result.push(cell);}return result;})(${input(ctx, 'source')},${input(ctx, 'direction')},${parameter(ctx, 'maxDistance')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'projectile.events-from-cell', label: '读取地格射线事件',
    description: '读取一条地格起点射线的完整权威路径事件。',
    inputs: [{ name: 'origin', type: cellType }, { name: 'direction', type: cellType }],
    outputs: [{ name: 'events', type: eventListType }],
    parameters: [{ name: 'maxDistance', type: numberType, default: 128 }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'position', 'map'] },
    lower: ctx => `(function(origin,direction,maxDistance){if(!origin||!direction||!Number.isInteger(origin.x)||!Number.isInteger(origin.y)||!Number.isInteger(direction.x)||!Number.isInteger(direction.y))return [];return ${flow(ctx)}.query.path({x:origin.x,y:origin.y},{x:direction.x,y:direction.y},{maxDistance:Math.floor(maxDistance)})||[];})(${input(ctx, 'origin')},${input(ctx, 'direction')},${parameter(ctx, 'maxDistance')})`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.events-from-cell-bounded', label: '读取截至阻挡处的射线事件',
    description: '读取一条地格起点射线的权威路径事件；可在保留阻挡地格占用事件后截断后续路径。',
    inputs: [{ name: 'origin', type: cellType }, { name: 'direction', type: cellType }],
    outputs: [{ name: 'events', type: eventListType }],
    parameters: [{ name: 'maxDistance', type: numberType, default: 128 }, { name: 'stopAtBlockingTerrain', type: booleanType, default: true }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'position', 'map'] },
    lower: ctx => `(function(origin,direction,maxDistance,stopAtBlockingTerrain){if(!origin||!direction||!Number.isInteger(origin.x)||!Number.isInteger(origin.y)||!Number.isInteger(direction.x)||!Number.isInteger(direction.y))return [];var events=${flow(ctx)}.query.path({x:origin.x,y:origin.y},{x:direction.x,y:direction.y},{maxDistance:Math.floor(maxDistance)})||[];if(!stopAtBlockingTerrain)return events;var result=[];for(var index=0;index<events.length;index+=1){var event=events[index];result.push(event);if(event&&(event.type==='boundary'||event.type==='terrain'&&event.blocksProjectile))break;}return result;})(${input(ctx, 'origin')},${input(ctx, 'direction')},${parameter(ctx, 'maxDistance')},${parameter(ctx, 'stopAtBlockingTerrain')})`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'projectile.first-enemy-on-path', label: '读取射线首个敌人',
    description: '只观察来源棋子前方射线，友军或阻挡地形停止；伤害必须由作者图另行调用 effect.damage。',
    inputs: [{ name: 'source', type: pieceType }, { name: 'direction', type: cellType }],
    outputs: [{ name: 'target', type: pieceType, nullable: true }],
    parameters: [{ name: 'maxDistance', type: numberType, default: 6 }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'players', 'position', 'map'] },
    lower: ctx => `(function(sourceId,direction,maxDistance){if(sourceId==null||!direction||!${flow(ctx)}.query.hasPiece(sourceId))return null;var source=${flow(ctx)}.query.piece(sourceId),events=${flow(ctx)}.query.path({x:source.x,y:source.y},{x:direction.x,y:direction.y},{maxDistance:Math.floor(maxDistance),excludePieceId:sourceId})||[];for(var index=0;index<events.length;index+=1){var event=events[index];if(!event)continue;if(event.type==='boundary')break;if(event.type==='piece'){var target=event.piece;if(!target)break;if(arePlayersAllied(${battle(ctx)},target.ownerPlayerId,source.ownerPlayerId))break;return target.currentHp>0?target.instanceId:null;}if(event.type==='terrain'&&event.blocksProjectile)break;}return null;})(${input(ctx, 'source')},${input(ctx, 'direction')},${parameter(ctx, 'maxDistance')})`,
    ui: { category: 'projectile' },
  }),
  define({
    id: 'piece.by-template', label: '按模板查询棋子',
    description: '按模板、所属玩家和存活条件返回首个棋子 ID；不暴露可变棋子对象。',
    inputs: [{ name: 'owner', type: playerType, nullable: true, optional: true }],
    outputs: [{ name: 'piece', type: pieceType, nullable: true }],
    parameters: [
      { name: 'templateId', type: stringType },
      { name: 'alive', type: booleanType, default: true },
    ],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'players'] },
    lower: ctx => {
      const owner = ctx.inputs.owner ?? 'null'
      const alive = ctx.parameters.alive === false ? 'false' : 'true'
      return `(function(owner,templateId,alive){var pieces=${battle(ctx)}.pieces||[];for(var index=0;index<pieces.length;index+=1){var piece=pieces[index];if(!piece||piece.templateId!==templateId||(owner!=null&&piece.ownerPlayerId!==owner)||(alive&&Number(piece.currentHp||0)<=0))continue;return piece.instanceId;}return null;})(${owner},${parameter(ctx, 'templateId')},${alive})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.all-pieces', label: '查询战场与墓地记录标识',
    description: '依次读取战场、墓地的棋子记录标识，保留各区顺序。标识用于历史状态清理；它不是可行动棋子引用，不能直接用于伤害、移动或复活。',
    inputs: [], outputs: [{ name: 'pieces', type: stringListType, label: '记录标识元组' }],
    effects: { pure: true, previewSafe: false, reads: ['pieces'] },
    lower: ctx => `((${battle(ctx)}.pieces||[]).concat(${battle(ctx)}.graveyard||[])).map(function(piece){return piece&&piece.instanceId;}).filter(function(id){return typeof id==='string';})`,
    ui: { category: 'selection', authoring: 'standard' },
  }),
  define({
    id: 'query.pieces-on-cells-all', label: '查询地格上的存活棋子',
    inputs: [{ name: 'cells', type: cellListType }], outputs: [{ name: 'pieces', type: pieceListType }],
    parameters: [{ name: 'relation', type: stringType, enum: ['all', 'ally', 'enemy'], default: 'all' }, { name: 'owner', type: playerType, nullable: true, optional: true }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'players', 'position'] },
    lower: ctx => {
      const relation = String(ctx.parameters.relation ?? 'all')
      if (!['all', 'ally', 'enemy'].includes(relation)) throw new Error(`module ${ctx.moduleId}: invalid relation`)
      const owner = ctx.inputs.owner ?? 'null'
      const relationCode = relation === 'all' ? 'undefined' : ctx.emitLiteral(relation)
      return `(function(cells,owner,relation){if(!Array.isArray(cells))return [];var ids=${flow(ctx)}.query.pieces({ownerId:owner,relation:relation,includeDead:false});return ids.filter(function(id){var piece=${flow(ctx)}.query.piece(id);return piece&&cells.some(function(cell){return cell&&piece.x===cell.x&&piece.y===cell.y;});});})(${input(ctx, 'cells')},${owner},${relationCode})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.normal-move-cells', label: '查询普通移动落点',
    description: '按宿主普通移动规则读取合法落点；移动范围、地形、阻挡和落脚校验均由权威宿主处理。',
    inputs: [{ name: 'piece', type: pieceType, label: '棋子' }], outputs: [{ name: 'cells', type: cellListType, label: '合法落点' }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'position', 'map'] },
    lower: ctx => `((${flow(ctx)}.query.normalMoveTargets(${input(ctx, 'piece')})||[]).map(function(cell){return {x:cell.x,y:cell.y};}))`,
    ui: { category: 'position', authoring: 'standard' },
  }),
  define({
    id: 'query.piece-by-id', label: '按标识读取棋子',
    inputs: [{ name: 'id', type: stringType, nullable: true }], outputs: [{ name: 'piece', type: pieceType, nullable: true }],
    effects: { pure: true, previewSafe: false, reads: ['pieces'] },
    lower: ctx => `(${input(ctx, 'id')}!=null&&${flow(ctx)}.query.hasPiece(${input(ctx, 'id')})?${flow(ctx)}.query.piece(${input(ctx, 'id')}).instanceId:null)`,
    ui: { category: 'query' },
  }),
]

const EVENT_MODULES: readonly Descriptor[] = [
  define({
    id: 'event.read-string', label: '读取事件文本',
    inputs: [{ name: 'fallback', type: stringType }], outputs: [{ name: 'value', type: stringType }],
    parameters: [{ name: 'field', type: stringType, enum: ['skillId', 'playerId'] }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `(function(value){return value==null?${input(ctx, 'fallback')}:String(value);})(${context(ctx)}[${parameter(ctx, 'field')}])`,
    ui: { category: 'event' },
  }),
  define({
    id: 'event.has-field', label: '检查事件字段存在',
    inputs: [], outputs: [{ name: 'value', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['targetX', 'targetY', 'skillId', 'playerId', 'cancelled'] }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `Object.prototype.hasOwnProperty.call(${context(ctx)},${parameter(ctx, 'field')})&&${context(ctx)}[${parameter(ctx, 'field')}]!==undefined`,
    ui: { category: 'event' },
  }),
  define({
    id: 'event.selected-cells', label: '读取已选地格集合',
    inputs: [], outputs: [{ name: 'cells', type: cellListType }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `(Array.isArray(${context(ctx)}.selectedTargets)?${context(ctx)}.selectedTargets.filter(function(item){return item&&item.type==='cell'&&Number.isInteger(item.x)&&Number.isInteger(item.y);}).map(function(item){return {x:item.x,y:item.y};}):[])`,
    ui: { category: 'event' },
  }),

]

const TEXT_MODULES: readonly Descriptor[] = [
  define({
    id: 'text.strip-leading-comma', label: '去除文本首个逗号',
    inputs: [{ name: 'text', type: stringType }], outputs: [{ name: 'value', type: stringType }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(String(${input(ctx, 'text')}).indexOf('，')===0?String(${input(ctx, 'text')}).slice(1):String(${input(ctx, 'text')}))`,
    ui: { category: 'text' },
  }),
]

const RESULT_MODULES: readonly Descriptor[] = [
  define({
    id: 'result.blocked', label: '构造阻挡结果',
    inputs: [{ name: 'message', type: stringType }], outputs: [{ name: 'result', type: recordType }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `({success:true,blocked:true,message:${input(ctx, 'message')}})`,
    ui: { category: 'result' },
  }),
]

const STATUS_MODULES: readonly Descriptor[] = [
  define({
    id: 'status.has-skill-id', label: '检查状态技能标识',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }, { name: 'skillId', type: stringType, nullable: true }], outputs: [{ name: 'value', type: booleanType }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function(pieceId,statusId,skillId){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;});return Boolean(tag&&Array.isArray(tag.skillIds)&&tag.skillIds.indexOf(skillId)>=0);})(${input(ctx, 'piece')},${input(ctx, 'statusId')},${input(ctx, 'skillId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.has-skill-instance', label: '检查状态实例技能标识',
    description: '检查当前执行保留的精确状态实例；状态实例失效时不会按类型或标识重新匹配。',
    inputs: [{ name: 'status', type: 'status', nullable: true }, { name: 'skillId', type: stringType, nullable: true }], outputs: [{ name: 'value', type: booleanType }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context', 'statuses'] },
    lower: ctx => `${flow(ctx)}.status.hasSkillInstance(${input(ctx, 'status')}, ${input(ctx, 'skillId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-number-field', label: '读取状态登记数值',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }, { name: 'fallback', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'field', type: stringType, enum: ['dx', 'dy', 'damage', 'turns', 'intensity', 'stacks', 'createdTurnNumber', 'currentDuration', 'currentUses'] }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function(pieceId,statusId,fallback){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;}),value=tag&&tag[${parameter(ctx, 'field')}];return value==null?fallback:Number(value);})(${input(ctx, 'piece')},${input(ctx, 'statusId')},${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-text-field', label: '读取状态登记文本',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }, { name: 'fallback', type: stringType }], outputs: [{ name: 'value', type: stringType }],
    parameters: [{ name: 'field', type: stringType, enum: ['sourceId', 'kind', 'id'] }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function(pieceId,statusId,fallback){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;}),value=tag&&tag[${parameter(ctx, 'field')}];return value==null?fallback:String(value);})(${input(ctx, 'piece')},${input(ctx, 'statusId')},${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-cell-field', label: '读取状态登记地格',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }], outputs: [{ name: 'cell', type: cellType, nullable: true }],
    parameters: [{ name: 'field', type: stringType, enum: ['left', 'right'] }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function(pieceId,statusId){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;}),cell=tag&&tag[${parameter(ctx, 'field')}];return cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.y)?{x:cell.x,y:cell.y}:null;})(${input(ctx, 'piece')},${input(ctx, 'statusId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-cell-list', label: '读取状态地格集合',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }], outputs: [{ name: 'cells', type: cellListType }],
    parameters: [{ name: 'field', type: stringType, enum: ['pathCells'] }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function(pieceId,statusId){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;}),cells=tag&&tag[${parameter(ctx, 'field')}];return Array.isArray(cells)?cells.filter(function(cell){return cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.y);}).map(function(cell){return {x:cell.x,y:cell.y};}):[];})(${input(ctx, 'piece')},${input(ctx, 'statusId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.valid-side-cells', label: '查询仍在地图内的侧向地格',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }], outputs: [{ name: 'cells', type: cellListType }],
    effects: { pure: true, previewSafe: false, reads: ['statuses', 'map'] },
    lower: ctx => `(function(pieceId,statusId){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;}),tiles=${battle(ctx)}.map&&Array.isArray(${battle(ctx)}.map.tiles)?${battle(ctx)}.map.tiles:[],result=[];['left','right'].forEach(function(field){var cell=tag&&tag[field];if(cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.y)&&tiles.some(function(tile){return tile&&tile.x===cell.x&&tile.y===cell.y;}))result.push({x:cell.x,y:cell.y});});return result;})(${input(ctx, 'piece')},${input(ctx, 'statusId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.find-source-before-id', label: '查找来源回合前状态',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'source', type: pieceType }, { name: 'turn', type: numberType }], outputs: [{ name: 'id', type: stringType, nullable: true }],
    parameters: [{ name: 'statusType', type: stringType }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function(pieceId,sourceId,turn,type){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.type===type&&item.sourceId===sourceId&&Number(item.createdTurnNumber)<turn;});return tag&&typeof tag.id==='string'?tag.id:null;})(${input(ctx, 'piece')},${input(ctx, 'source')},${input(ctx, 'turn')},${parameter(ctx, 'statusType')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.remove-type-raw', label: '直接移除同类型状态',
    inputs: [{ name: 'piece', type: pieceType }], outputs: [{ name: 'count', type: numberType }],
    parameters: [{ name: 'statusType', type: stringType }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `(function(pieceId,type){var piece=${flow(ctx)}.query.piece(pieceId);if(!piece)return 0;var before=Array.isArray(piece.statusTags)?piece.statusTags.length:0;piece.statusTags=(piece.statusTags||[]).filter(function(tag){return !tag||tag.type!==type;});return before-piece.statusTags.length;})(${input(ctx, 'piece')},${parameter(ctx, 'statusType')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.remove-source-type-raw', label: '移除单棋子来源状态',
    description: '在一个棋子（包括墓地棋子）上移除指定来源和类型的状态；全局枚举必须由作者图显式 foreach。',
    inputs: [{ name: 'target', type: stringType }, { name: 'source', type: pieceType }], outputs: [{ name: 'count', type: numberType }],
    parameters: [{ name: 'statusType', type: stringType }],
    effects: { pure: false, previewSafe: false, reads: ['statuses', 'pieces'], writes: ['statuses'] },
    lower: ctx => `(function(targetId,sourceId,type){var all=(${battle(ctx)}.pieces||[]).concat(${battle(ctx)}.graveyard||[]),piece=all.find(function(item){return item&&item.instanceId===targetId;});if(!piece)return 0;var before=Array.isArray(piece.statusTags)?piece.statusTags.length:0;piece.statusTags=(piece.statusTags||[]).filter(function(tag){return !(tag&&tag.type===type&&tag.sourceId===sourceId);});return before-piece.statusTags.length;})(${input(ctx, 'target')},${input(ctx, 'source')},${parameter(ctx, 'statusType')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'rule.remove-id-raw', label: '移除记录中的规则',
    description: '按记录标识清理战场或墓地棋子的指定规则记录，不使离场棋子获得行动资格；用于已离场来源的遗留记录清理。正常在场能力增删使用规则生命周期入口。',
    inputs: [{ name: 'target', type: stringType, label: '棋子记录标识' }], outputs: [{ name: 'success', type: booleanType, label: '已移除' }],
    parameters: [{ name: 'ruleId', type: stringType, label: '规则' }],
    effects: { pure: false, previewSafe: false, reads: ['pieces'], writes: ['rules'] },
    lower: ctx => `(function(targetId,ruleId){var all=(${battle(ctx)}.pieces||[]).concat(${battle(ctx)}.graveyard||[]),piece=all.find(function(item){return item&&item.instanceId===targetId;});if(!piece||!Array.isArray(piece.rules))return false;var before=piece.rules.length;piece.rules=piece.rules.filter(function(rule){return (rule&&rule.id?rule.id:rule)!==ruleId;});return before!==piece.rules.length;})(${input(ctx, 'target')},${parameter(ctx, 'ruleId')})`,
    ui: { category: 'status-rule', authoring: 'standard' },
  }),
  {
    id: 'rule.remove-id-raw', version: '2', label: '移除记录中的规则',
    description: '按目标类型移除规则：字符串沿用记录标识清理，执行记录直接使用本次执行认证来源；无匹配规则仍返回成功，失效执行记录由宿主诊断。',
    inputs: [{ name: 'target', type: recordType, label: '目标' }],
    inputValueTypeBindings: { target: { parameter: 'targetType' } },
    outputs: [{ name: 'success', type: booleanType, label: '已移除' }],
    parameters: [
      { name: 'targetType', type: stringType, label: '目标类型', enum: [stringType, recordType], default: stringType },
      { name: 'ruleId', type: stringType, label: '规则' },
    ],
    allowedSurfaces: surfaces,
    effects: { pure: false, previewSafe: false, reads: ['pieces', 'execution-context'], writes: ['rules'] },
    lower: ctx => {
      const targetType = ctx.parameters.targetType
      if (targetType === recordType) return `${flow(ctx)}.effects.removeCapturedRule(${input(ctx, 'target')}, ${parameter(ctx, 'ruleId')})`
      if (targetType !== stringType) throw new Error(`module ${ctx.moduleId}: targetType must be string or record`)
      return `(function(targetId,ruleId){var all=(${battle(ctx)}.pieces||[]).concat(${battle(ctx)}.graveyard||[]),piece=all.find(function(item){return item&&item.instanceId===targetId;});if(!piece||!Array.isArray(piece.rules))return false;var before=piece.rules.length;piece.rules=piece.rules.filter(function(rule){return (rule&&rule.id?rule.id:rule)!==ruleId;});return before!==piece.rules.length;})(${input(ctx, 'target')},${parameter(ctx, 'ruleId')})`
    },
    ui: { category: 'status-rule', authoring: 'standard' },
  },
]

const EXTENSION_MODULES: readonly Descriptor[] = [
  define({
    id: 'extension.read-list', label: '读取扩展地格集合',
    inputs: [], outputs: [{ name: 'cells', type: recordListType }],
    parameters: [{ name: 'key', type: stringType, enum: ['shishioBurnTiles'] }],
    effects: { pure: true, previewSafe: false, reads: ['extensions'] },
    lower: ctx => `(Array.isArray(${battle(ctx)}.extensions&&${battle(ctx)}.extensions[${parameter(ctx, 'key')}])?${battle(ctx)}.extensions[${parameter(ctx, 'key')}]:[])`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.cells-for-source', label: '按来源筛选扩展地格',
    inputs: [{ name: 'cells', type: recordListType }, { name: 'source', type: pieceType }], outputs: [{ name: 'cells', type: cellListType }],
    effects: { pure: true, previewSafe: false, reads: ['extensions'] },
    lower: ctx => `(Array.isArray(${input(ctx, 'cells')})?${input(ctx, 'cells')}.filter(function(cell){return cell&&(!cell.sourcePieceId||cell.sourcePieceId===${input(ctx, 'source')});}).filter(function(cell){return Number.isInteger(cell.x)&&Number.isInteger(cell.y);}).map(function(cell){return {x:cell.x,y:cell.y};}):[])`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.read-owner-record', label: '读取棋子扩展记录',
    inputs: [{ name: 'owner', type: pieceType }], outputs: [{ name: 'record', type: recordType, nullable: true }],
    parameters: [{ name: 'key', type: stringType, enum: ['coltZones'] }],
    effects: { pure: true, previewSafe: false, reads: ['extensions'] },
    lower: ctx => `(function(ownerId){var ext=${battle(ctx)}.extensions&&${battle(ctx)}.extensions[${parameter(ctx, 'key')}];return ext&&ownerId!=null?ext[ownerId]||null:null;})(${input(ctx, 'owner')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.record-source', label: '读取扩展来源棋子',
    inputs: [{ name: 'record', type: recordType, nullable: true }], outputs: [{ name: 'piece', type: pieceType, nullable: true }],
    effects: { pure: true, previewSafe: false, reads: ['extensions', 'pieces'] },
    lower: ctx => `(function(record){var id=record&&record.sourceId;return id!=null&&${flow(ctx)}.query.hasPiece(id)?id:null;})(${input(ctx, 'record')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.read-number', label: '读取扩展数值',
    inputs: [{ name: 'record', type: recordType, nullable: true }, { name: 'fallback', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'field', type: stringType, enum: ['dx', 'dy', 'turns'] }],
    effects: { pure: true, previewSafe: false, reads: ['extensions'] },
    lower: ctx => `(function(record,fallback){var value=record&&record[${parameter(ctx, 'field')}];return value==null?fallback:Number(value);})(${input(ctx, 'record')},${input(ctx, 'fallback')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.read-text', label: '读取扩展文本',
    inputs: [{ name: 'record', type: recordType, nullable: true }, { name: 'fallback', type: stringType }], outputs: [{ name: 'value', type: stringType }],
    parameters: [{ name: 'field', type: stringType, enum: ['kind', 'sourceId'] }],
    effects: { pure: true, previewSafe: false, reads: ['extensions'] },
    lower: ctx => `(function(record,fallback){var value=record&&record[${parameter(ctx, 'field')}];return value==null?fallback:String(value);})(${input(ctx, 'record')},${input(ctx, 'fallback')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.remove-owner-record', label: '移除棋子扩展记录',
    inputs: [{ name: 'owner', type: pieceType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'key', type: stringType, enum: ['coltZones'] }],
    effects: { pure: false, previewSafe: false, writes: ['extensions'] },
    lower: ctx => `(function(ownerId){var ext=${battle(ctx)}.extensions&&${battle(ctx)}.extensions[${parameter(ctx, 'key')}];if(!ext||ownerId==null||!Object.prototype.hasOwnProperty.call(ext,ownerId))return false;delete ext[ownerId];return true;})(${input(ctx, 'owner')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.decrement-turns', label: '递减扩展持续回合',
    inputs: [{ name: 'record', type: recordType, nullable: true }], outputs: [{ name: 'value', type: numberType }],
    effects: { pure: false, previewSafe: false, writes: ['extensions'] },
    lower: ctx => `(function(record){if(!record)return 0;record.turns=Number(record.turns||0)-1;return record.turns;})(${input(ctx, 'record')})`,
    ui: { category: 'state' },
  }),
]

const EFFECT_MODULES: readonly Descriptor[] = [
  define({
    id: 'effect.force-defeat', label: '令棋子立即出局',
    description: '把已验证目标生命置零，由当前宿主继续处理正式死亡结算。',
    inputs: [{ name: 'target', type: pieceType }], outputs: [{ name: 'success', type: booleanType }],
    allowedSurfaces: ['rule'], effects: { pure: false, previewSafe: false, writes: ['health'] },
    lower: ctx => `(function(targetId){if(targetId==null||!${flow(ctx)}.query.hasPiece(targetId))return false;var target=${flow(ctx)}.query.piece(targetId);target.currentHp=0;return true;})(${input(ctx, 'target')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'effect.free-move', label: '执行免费移动',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'destination', type: cellType }], outputs: [{ name: 'result', type: recordType }, { name: 'success', type: booleanType }],
    effects: { pure: false, previewSafe: false, writes: ['position', 'events'], events: ['beforePiecePositionChange', 'afterPiecePositionChange'] },
    lower: ctx => `(function(value){return {result:value,success:Boolean(value&&value.success)};})(${flow(ctx)}.effects.freeMove(${input(ctx, 'piece')},${input(ctx, 'destination')}))`,
    ui: { category: 'effect' },
  }),
]

const CHOICE_MODULES: readonly Descriptor[] = [
  define({
    id: 'choice.option-pair-cancel', label: '可取消二选一',
    inputs: [], outputs: [{ name: 'choice', type: 'choice' }],
    parameters: [
      { name: 'title', type: stringType }, { name: 'firstLabel', type: stringType }, { name: 'firstValue', type: stringType },
      { name: 'firstDescription', type: stringType }, { name: 'secondLabel', type: stringType }, { name: 'secondValue', type: stringType },
      { name: 'secondDescription', type: stringType }, { name: 'cancelValue', type: stringType },
    ],
    effects: { pure: false, previewSafe: false, writes: ['pending'], pending: true },
    lower: ctx => `${flow(ctx)}.choice.option({title:${parameter(ctx, 'title')},options:[{label:${parameter(ctx, 'firstLabel')},value:${parameter(ctx, 'firstValue')},description:${parameter(ctx, 'firstDescription')}},{label:${parameter(ctx, 'secondLabel')},value:${parameter(ctx, 'secondValue')},description:${parameter(ctx, 'secondDescription')}}],canCancel:true,cancelValue:${parameter(ctx, 'cancelValue')}})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.grid-candidates', label: '构造地格选择结果',
    inputs: [{ name: 'player', type: playerType }, { name: 'candidates', type: cellListType }], outputs: [{ name: 'result', type: recordType }],
    parameters: [{ name: 'title', type: stringType }, { name: 'canCancel', type: booleanType, default: true }, { name: 'resumeOnCancel', type: booleanType, default: false }],
    effects: { pure: true, previewSafe: false },
    lower: ctx => `({needsTargetSelection:true,playerId:${input(ctx, 'player')},title:${parameter(ctx, 'title')},targetType:'grid',filter:'all',targetCandidates:(${input(ctx, 'candidates')}).map(function(cell){return {type:'cell',x:cell.x,y:cell.y};}),selectionMode:'single',minSelections:1,maxSelections:1,canCancel:${ctx.parameters.canCancel === false ? 'false' : 'true'},resumeOnCancel:${ctx.parameters.resumeOnCancel === true ? 'true' : 'false'}})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.piece-candidates', label: '构造棋子选择结果',
    inputs: [{ name: 'player', type: playerType }, { name: 'pieces', type: pieceListType }], outputs: [{ name: 'result', type: recordType }],
    parameters: [{ name: 'title', type: stringType }],
    effects: { pure: true, previewSafe: false },
    lower: ctx => `({needsTargetSelection:true,playerId:${input(ctx, 'player')},title:${parameter(ctx, 'title')},targetType:'piece',targetCandidates:(${input(ctx, 'pieces')}).map(function(pieceId){return {type:'piece',pieceId:pieceId};}),selectionMode:'single',minSelections:1,maxSelections:1,canCancel:true})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.option-selected', label: '读取已选选项',
    inputs: [{ name: 'choice', type: 'choice', nullable: true }], outputs: [{ name: 'value', type: stringType }],
    effects: { pure: true, previewSafe: false, reads: ['choice'] },
    lower: ctx => `(function(value){if(typeof value==='string')return value;return value&&typeof value.value==='string'?value.value:'';})(${input(ctx, 'choice')})`,
    ui: { category: 'choice' },
  }),
]

const CARD_MODULES: readonly Descriptor[] = [
  define({
    id: 'card.find-content-records', label: '查询手牌内容记录',
    inputs: [{ name: 'player', type: playerType }, { name: 'source', type: pieceType }, { name: 'turn', type: numberType }], outputs: [{ name: 'cards', type: stringListType }],
    parameters: [{ name: 'field', type: stringType, enum: ['velenHolyProphecy'] }],
    effects: { pure: true, previewSafe: false, reads: ['hand', 'content'] },
    lower: ctx => `(function(playerId,sourceId,turn,field){var hand=${flow(ctx)}.cards.hand(playerId),result=[];(Array.isArray(hand)?hand:[]).forEach(function(card){var value=card&&card.contentState&&card.contentState[field];if(value&&typeof value==='object'&&value.sourcePieceId===sourceId&&!(value.createdTurnNumber>=turn))result.push(card.instanceId);});return result;})(${input(ctx, 'player')},${input(ctx, 'source')},${input(ctx, 'turn')},${parameter(ctx, 'field')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'card.clear-content-records', label: '清除来源内容记录',
    inputs: [{ name: 'player', type: playerType }, { name: 'source', type: pieceType }], outputs: [{ name: 'count', type: numberType }],
    parameters: [{ name: 'field', type: stringType, enum: ['velenHolyProphecy'] }],
    effects: { pure: false, previewSafe: false, writes: ['hand', 'content'] },
    lower: ctx => `(function(playerId,sourceId,field){var hand=${flow(ctx)}.cards.hand(playerId),count=0;(Array.isArray(hand)?hand:[]).forEach(function(card){var state=card&&card.contentState,value=state&&state[field];if(value&&typeof value==='object'&&value.sourcePieceId===sourceId){delete state[field];count+=1;}});return count;})(${input(ctx, 'player')},${input(ctx, 'source')},${parameter(ctx, 'field')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'card.read-definition-id', label: '读取手牌定义标识',
    inputs: [{ name: 'player', type: playerType }, { name: 'card', type: stringType }], outputs: [{ name: 'cardId', type: stringType }],
    effects: { pure: true, previewSafe: false, reads: ['hand', 'content'] },
    lower: ctx => `(function(playerId,instanceId){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;});return card&&typeof card.cardId==='string'?card.cardId:'';})(${input(ctx, 'player')},${input(ctx, 'card')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'card.set-content-boolean', label: '写入手牌布尔声明',
    inputs: [{ name: 'player', type: playerType }, { name: 'card', type: stringType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['velenHolyProphecyEnhanced'] }],
    effects: { pure: false, previewSafe: false, writes: ['hand', 'content'] },
    lower: ctx => `(function(playerId,instanceId,field){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;});if(!card)return false;if(!card.contentState)card.contentState={};card.contentState[field]=true;return true;})(${input(ctx, 'player')},${input(ctx, 'card')},${parameter(ctx, 'field')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'card.clear-content-field', label: '删除手牌内容声明',
    inputs: [{ name: 'player', type: playerType }, { name: 'card', type: stringType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['velenHolyProphecy'] }],
    effects: { pure: false, previewSafe: false, writes: ['hand', 'content'] },
    lower: ctx => `(function(playerId,instanceId,field){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;});if(!card||!card.contentState||!Object.prototype.hasOwnProperty.call(card.contentState,field))return false;delete card.contentState[field];return true;})(${input(ctx, 'player')},${input(ctx, 'card')},${parameter(ctx, 'field')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'card.set-effect-modifier', label: '替换手牌效果修饰记录',
    inputs: [{ name: 'player', type: playerType }, { name: 'card', type: stringType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [
      { name: 'effect', type: stringType, enum: ['damage', 'heal', 'statusIntensity'] },
      { name: 'operation', type: stringType, enum: ['multiply'] },
      { name: 'value', type: numberType },
      { name: 'statusType', type: stringType, optional: true },
    ],
    effects: { pure: false, previewSafe: false, writes: ['hand', 'content'] },
    lower: ctx => {
      const statusType = Object.prototype.hasOwnProperty.call(ctx.parameters, 'statusType') ? `,statusType:${parameter(ctx, 'statusType')}` : ''
      return `(function(playerId,instanceId,effect,operation,value){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;});if(!card)return false;card.effectModifiers=[{effect:effect,operation:operation,value:value${statusType}}];return true;})(${input(ctx, 'player')},${input(ctx, 'card')},${parameter(ctx, 'effect')},${parameter(ctx, 'operation')},${parameter(ctx, 'value')})`
    },
    ui: { category: 'card' },
  }),
  define({
    id: 'card.set-presentation', label: '替换手牌展示记录',
    inputs: [{ name: 'player', type: playerType }, { name: 'card', type: stringType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'variant', type: stringType }, { name: 'badge', type: stringType }, { name: 'description', type: stringType }],
    effects: { pure: false, previewSafe: false, writes: ['hand', 'presentation'] },
    lower: ctx => `(function(playerId,instanceId,variant,badge,description){var hand=${flow(ctx)}.cards.hand(playerId),card=(Array.isArray(hand)?hand:[]).find(function(item){return item&&item.instanceId===instanceId;});if(!card)return false;card.presentation={variant:variant,badge:badge,description:description};return true;})(${input(ctx, 'player')},${input(ctx, 'card')},${parameter(ctx, 'variant')},${parameter(ctx, 'badge')},${parameter(ctx, 'description')})`,
    ui: { category: 'card' },
  }),
]

const SKILL_MODULES: readonly Descriptor[] = [
  define({
    id: 'skill.boolean-flag', label: '读取技能布尔标记',
    inputs: [{ name: 'skillId', type: stringType, nullable: true }], outputs: [{ name: 'value', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['momentumGainOnUse'] }],
    effects: { pure: true, previewSafe: false, reads: ['skills'] },
    lower: ctx => `Boolean(${battle(ctx)}.skillsById&&${battle(ctx)}.skillsById[${input(ctx, 'skillId')}]&&${battle(ctx)}.skillsById[${input(ctx, 'skillId')}][${parameter(ctx, 'field')}])`,
    ui: { category: 'skill' },
  }),
]

export const SHISHIO_VELEN_COLT_GAMEPLAY_MODULES: readonly Descriptor[] = Object.freeze([
  ...QUERY_MODULES,
  ...EVENT_MODULES,
  ...TEXT_MODULES,
  ...RESULT_MODULES,
  ...STATUS_MODULES,
  ...EXTENSION_MODULES,
  ...EFFECT_MODULES,
  ...CHOICE_MODULES,
  ...CARD_MODULES,
  ...SKILL_MODULES,
])

export const shishioVelenColtGameplayModuleDescriptors = SHISHIO_VELEN_COLT_GAMEPLAY_MODULES
