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
 * Small, closed adapters used by the remaining Ichigo migrations.
 *
 * The graphs still own the skill/rule ordering and all branching. These
 * descriptors expose only generic projectile facts, typed adjacent cells, and
 * a namespaced owner-to-cell-list extension adapter.
 */
const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'rule', 'pending']
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const recordType: GameplayValueType = 'record'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const cellListType: GameplayValueType = { kind: 'list', element: cellType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const context = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx' : 'context'
const input = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) {
    if (fallback !== undefined) return fallback
    throw new Error('module ' + ctx.moduleId + ': missing input ' + name)
  }
  return value
}
const literal = (ctx: GameplayNativeLoweringContext, name: string, fallback?: unknown): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (value === undefined) throw new Error('module ' + ctx.moduleId + ': missing parameter ' + name)
  return ctx.emitLiteral(value as never)
}
const numberLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback?: number): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('module ' + ctx.moduleId + ': parameter ' + name + ' must be finite')
  return ctx.emitLiteral(value)
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[]): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({ version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value })

const EXTENSION_KEY = 'ichigoBlackGetsugaTeleportByCaster'

export const ICHIGO_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'projectile.trace-until-blocker',
    label: '读取阻挡前敌人弹道',
    description: '沿正交方向按顺序读取敌人，友军或阻挡地形停止；只返回敌人集合和首个命中地格，伤害由作者图另行提交。',
    inputs: [port('source', pieceType), port('target', cellType)],
    outputs: [port('enemyPieces', pieceListType), port('firstCell', cellType, { nullable: true }), port('valid', booleanType), port('sameCell', booleanType), port('distance', numberType)],
    parameters: [parameter('maxDistance', numberType, { default: 99, minimum: 0, maximum: 128 })],
    effects: pure(['pieces', 'players', 'position', 'map']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const query = flow(ctx)
      const maxDistance = numberLiteral(ctx, 'maxDistance', 99)
      const code = '(function(sourceId,targetCell,maxDistance){' +
        'if(sourceId==null||!targetCell||!Number.isInteger(targetCell.x)||!Number.isInteger(targetCell.y)||!' + query + '.query.hasPiece(sourceId))return {enemyPieces:[],firstCell:null,valid:false,sameCell:false,distance:0};' +
        'var source=' + query + '.query.piece(sourceId),dx=targetCell.x-source.x,dy=targetCell.y-source.y,sameCell=dx===0&&dy===0,valid=(dx===0)!==(dy===0),distance=Math.max(Math.abs(dx),Math.abs(dy));' +
        'if(!valid)return {enemyPieces:[],firstCell:null,valid:valid,sameCell:sameCell,distance:distance};' +
        'var sx=dx===0?0:(dx>0?1:-1),sy=dy===0?0:(dy>0?1:-1),events=' + query + '.query.path({x:source.x,y:source.y},{x:sx,y:sy},{maxDistance:Math.floor(maxDistance),excludePieceId:sourceId})||[],enemyIds=' + query + '.query.pieces({originId:sourceId,relation:"enemy",includeDead:false})||[],seen={},enemyPieces=[],firstCell=null;' +
        'for(var index=0;index<events.length;index+=1){var event=events[index];if(!event)continue;if(event.type==="boundary")break;if(event.type==="terrain"){if(event.blocksProjectile)break;continue;}if(event.type!=="piece")continue;var pieceId=event.pieceId||(event.piece&&event.piece.instanceId);if(!pieceId||enemyIds.indexOf(pieceId)<0)break;if(!seen[pieceId]){seen[pieceId]=true;enemyPieces.push(pieceId);}if(!firstCell){var hit=event.piece;firstCell={x:Number.isInteger(event.x)?event.x:Number(hit&&hit.x),y:Number.isInteger(event.y)?event.y:Number(hit&&hit.y)};}}' +
        'return {enemyPieces:enemyPieces,firstCell:firstCell,valid:valid,sameCell:sameCell,distance:distance};})(' + source + ',' + target + ',' + maxDistance + ')'
      return code
    },
    ui: { category: 'projectile' },
  }),
  define({
    id: 'spatial.adjacent-cells-ordered',
    label: '生成正交相邻地格',
    description: '按右、左、下、上的冻结顺序生成一个地格的四个正交相邻地格；合法性由作者图逐格判断。',
    inputs: [port('center', cellType, { nullable: true })],
    outputs: [port('cells', cellListType)],
    effects: pure(['position']),
    lower: ctx => '(function(center){if(!center||!Number.isInteger(center.x)||!Number.isInteger(center.y))return [];return [{x:center.x+1,y:center.y},{x:center.x-1,y:center.y},{x:center.x,y:center.y+1},{x:center.x,y:center.y-1}];})(' + input(ctx, 'center') + ')',
    ui: { category: 'position' },
  }),
  define({
    id: 'effect.damage-many-ordered',
    label: '批量造成伤害',
    description: '把作者图提供的有序目标集合交给统一批量伤害入口，并返回实际总伤害。',
    inputs: [port('source', pieceType), port('targets', pieceListType), port('amount', numberType)],
    outputs: [port('result', recordType), port('success', booleanType), port('totalDamage', numberType)],
    parameters: [parameter('damageType', stringType, { enum: ['normal', 'true'], default: 'normal' }), parameter('legacyNormalSpelling', stringType, { enum: ['physical', 'magical'], optional: true }), parameter('skillId', stringType)],
    effects: { ...writes(['damage', 'events']), events: ['beforeDamageDealt', 'afterDamageDealt'] },
    lower: ctx => {
      const kind = ctx.parameters.damageType === 'true' ? ctx.emitLiteral('true') : ctx.emitLiteral(ctx.parameters.legacyNormalSpelling ?? 'physical')
      const skillId = literal(ctx, 'skillId')
      const runtime = flow(ctx)
      return '(function(value){var results=Array.isArray(value&&value.results)?value.results:[],total=results.reduce(function(sum,item){return sum+Number(item&&item.damage||0);},0);return {result:value,success:Boolean(value&&value.success),totalDamage:total};})(' +
        runtime + '.effects.damageMany(' + input(ctx, 'source') + ',' + input(ctx, 'targets') + ',' + input(ctx, 'amount') + ',' + kind + ',' + skillId + '))'
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'event.target-cell',
    label: '读取事件目标地格',
    description: '读取宿主已经验证或恢复的目标坐标；没有目标时返回空地格。',
    inputs: [], outputs: [port('cell', cellType, { nullable: true })],
    allowedSurfaces: ['rule', 'pending'],
    effects: pure(['event']),
    lower: ctx => {
      const current = context(ctx)
      return '(function(value,x,y){if(value&&Number.isInteger(value.x)&&Number.isInteger(value.y))return {x:value.x,y:value.y};return Number.isInteger(x)&&Number.isInteger(y)?{x:x,y:y}:null;})(' +
        current + '.targetPosition,' + current + '.targetX,' + current + '.targetY)'
    },
    ui: { category: 'event' },
  }),
  define({
    id: 'extension.read-piece-cells',
    label: '读取棋子扩展地格',
    description: '从封闭的来源棋子地格扩展记录中读取有序地格，不暴露任意对象路径。',
    inputs: [port('owner', pieceType, { nullable: true })],
    outputs: [port('cells', cellListType)],
    parameters: [parameter('key', stringType, { enum: [EXTENSION_KEY] })],
    effects: pure(['extensions', 'position']),
    lower: ctx => {
      const state = battle(ctx), key = literal(ctx, 'key')
      return '(function(ownerId){var store=' + state + '.extensions&&' + state + '.extensions[' + key + '],values=store&&ownerId!=null?store[ownerId]:null;return Array.isArray(values)?values.filter(function(cell){return cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.y);}).map(function(cell){return {x:cell.x,y:cell.y};}):[];})(' + input(ctx, 'owner') + ')'
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.set-piece-cells',
    label: '写入棋子扩展地格',
    description: '按封闭扩展键保存来源棋子的有序地格候选；候选内容只由作者图提供。',
    inputs: [port('owner', pieceType, { nullable: true }), port('cells', cellListType)],
    outputs: [port('success', booleanType)],
    parameters: [parameter('key', stringType, { enum: [EXTENSION_KEY] })],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx), key = literal(ctx, 'key')
      return '(function(ownerId,cells){if(ownerId==null||!Array.isArray(cells))return false;' + state + '.extensions=' + state + '.extensions||{};var store=' + state + '.extensions[' + key + '];if(!store||typeof store!=="object"||Array.isArray(store))store={};store[ownerId]=(cells||[]).filter(function(cell){return cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.y);}).map(function(cell){return {type:"cell",x:cell.x,y:cell.y};});' + state + '.extensions[' + key + ']=store;return true;})(' + input(ctx, 'owner') + ',' + input(ctx, 'cells') + ')'
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.clear-piece-cells',
    label: '清理棋子扩展地格',
    description: '删除封闭扩展键下指定来源的地格条目；空容器清理由单独模块负责。',
    inputs: [port('owner', pieceType, { nullable: true })],
    outputs: [port('success', booleanType)],
    parameters: [parameter('key', stringType, { enum: [EXTENSION_KEY] })],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx), key = literal(ctx, 'key')
      return '(function(ownerId){var store=' + state + '.extensions&&' + state + '.extensions[' + key + '];if(!store||ownerId==null||!Object.prototype.hasOwnProperty.call(store,ownerId))return false;delete store[ownerId];return true;})(' + input(ctx, 'owner') + ')'
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.remove-empty-piece-store',
    label: '清理空棋子扩展容器',
    description: '仅在封闭扩展容器不再有来源条目时删除容器，与条目清理保持独立。',
    inputs: [], outputs: [port('success', booleanType)],
    parameters: [parameter('key', stringType, { enum: [EXTENSION_KEY] })],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx), key = literal(ctx, 'key')
      return '(function(){var extensions=' + state + '.extensions,store=extensions&&extensions[' + key + '];if(!store||typeof store!=="object"||Array.isArray(store))return false;if(Object.keys(store).length!==0)return false;delete extensions[' + key + '];return true;})()'
    },
    ui: { category: 'state' },
  }),
])
