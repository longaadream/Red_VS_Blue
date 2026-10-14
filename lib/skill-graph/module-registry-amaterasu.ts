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
 * Closed, reusable primitives for persistent cell records and tile markers.
 * Skill/rule graphs provide the fixed field/type parameters; these adapters do
 * not accept arbitrary extension paths or executable content.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const numberType: GameplayValueType = 'number'
const stringType: GameplayValueType = 'string'
const booleanType: GameplayValueType = 'boolean'
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const recordType: GameplayValueType = 'record'
const cellListType: GameplayValueType = { kind: 'list', element: cellType }

const CELL_STORAGE_KEYS = ['amaterasuCells'] as const
const OWNER_STORAGE_KEYS = ['amaterasuOwnerPlayerId'] as const
const TILE_TYPES = ['amaterasu'] as const
const MARKER_ICONS = ['🌑'] as const
const MARKER_POSITIONS = ['bottom-right'] as const
const PRESENTATIONS = ['expand'] as const

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
const numberLiteral = (ctx: Context, name: string, fallback: number): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}
const stringLiteral = (ctx: Context, name: string, fallback?: string): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be a string`)
  return ctx.emitLiteral(value)
}
const stringParameter = (ctx: Context, name: string, fallback?: string): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be a string`)
  return value
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): Descriptor => ({ version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value })

const DESCRIPTORS: readonly Descriptor[] = [
  define({
    id: 'spatial.clip-cells', label: '截取地图内地格',
    description: '按地图已有地格顺序过滤坐标，保留输入顺序并拒绝地图外地格。',
    inputs: [port('cells', cellListType)], outputs: [port('cells', cellListType)],
    effects: pure(['position', 'map']),
    lower: ctx => {
      const state = battle(ctx)
      return `(function(cells){var tiles=${state}.map&&Array.isArray(${state}.map.tiles)?${state}.map.tiles:[];return (Array.isArray(cells)?cells:[]).filter(function(cell){return cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.y)&&tiles.some(function(tile){return tile&&tile.x===cell.x&&tile.y===cell.y;});}).map(function(cell){return {x:cell.x,y:cell.y};});})(${input(ctx, 'cells')})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cells-within-range', label: '按距离筛选地格',
    description: '从已计算地格中按曼哈顿或切比雪夫距离筛选目标范围。',
    inputs: [port('origin', cellType), port('cells', cellListType)], outputs: [port('cells', cellListType)],
    parameters: [parameter('range', numberType, { default: 0, minimum: 0, maximum: 64 }), parameter('metric', stringType, { enum: ['manhattan', 'chebyshev'], default: 'manhattan' })],
    effects: pure(['position']),
    lower: ctx => {
      const range = numberLiteral(ctx, 'range', 0)
      const metric = stringParameter(ctx, 'metric', 'manhattan')
      const metricLiteral = stringLiteral(ctx, 'metric', 'manhattan')
      if (metric !== 'manhattan' && metric !== 'chebyshev') throw new Error(`module ${ctx.moduleId}: invalid metric`)
      const origin = input(ctx, 'origin'), cells = input(ctx, 'cells')
      return `(function(origin,cells,range,metric){if(!origin)return [];return (Array.isArray(cells)?cells:[]).filter(function(cell){if(!cell||!Number.isInteger(cell.x)||!Number.isInteger(cell.y))return false;var dx=Math.abs(cell.x-origin.x),dy=Math.abs(cell.y-origin.y);return (metric==="manhattan"?dx+dy:Math.max(dx,dy))<=range;}).map(function(cell){return {x:cell.x,y:cell.y};});})(${origin},${cells},${range},${metricLiteral})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'tile.append-dedup-markers', label: '去重添加地格表现',
    description: '按固定 tile 类型和表现字段追加去重地格效果；记录登记由独立扩展原子完成。',
    inputs: [port('cells', cellListType), port('origin', cellType)], outputs: [port('added', numberType)],
    parameters: [
      parameter('tileType', stringType, { enum: TILE_TYPES }),
      parameter('icon', stringType, { enum: MARKER_ICONS }),
      parameter('iconPosition', stringType, { enum: MARKER_POSITIONS }),
      parameter('presentation', stringType, { enum: PRESENTATIONS, default: 'expand' }),
      parameter('presentationBatch', stringType, { enum: ['queue', 'direct'], default: 'queue' }),
    ],
    effects: writes(['tile-effects'], ['tileEffectAdded']),
    lower: ctx => {
      const state = battle(ctx), runtimeContext = context(ctx), cells = input(ctx, 'cells'), origin = input(ctx, 'origin')
      const tileType = stringLiteral(ctx, 'tileType'), icon = stringLiteral(ctx, 'icon'), iconPosition = stringLiteral(ctx, 'iconPosition')
      const presentation = stringLiteral(ctx, 'presentation', 'expand'), presentationBatch = stringParameter(ctx, 'presentationBatch', 'queue')
      if (!(TILE_TYPES as readonly string[]).includes(ctx.parameters.tileType as string)) throw new Error(`module ${ctx.moduleId}: invalid tileType`)
      if (!(MARKER_ICONS as readonly string[]).includes(ctx.parameters.icon as string)) throw new Error(`module ${ctx.moduleId}: invalid icon`)
      if (!(MARKER_POSITIONS as readonly string[]).includes(ctx.parameters.iconPosition as string)) throw new Error(`module ${ctx.moduleId}: invalid iconPosition`)
      if (!(PRESENTATIONS as readonly string[]).includes(ctx.parameters.presentation === undefined ? 'expand' : ctx.parameters.presentation as string)) throw new Error(`module ${ctx.moduleId}: invalid presentation`)
      if (presentationBatch !== 'queue' && presentationBatch !== 'direct') throw new Error(`module ${ctx.moduleId}: invalid presentationBatch`)
      const effect = `{x:cell.x,y:cell.y,sourceId:${tileType},tileType:${tileType},presentation:${presentation},presentationStep:Math.max(Math.abs(cell.x-origin.x),Math.abs(cell.y-origin.y)),icon:${icon},iconPosition:${iconPosition}}`
      const enqueue = presentationBatch === 'direct'
        ? 'apply();'
        : `if(${runtimeContext}.presentationQueue&&typeof ${runtimeContext}.presentationQueue.push==="function")${runtimeContext}.presentationQueue.push("tileEffectAdded",apply);else apply();`
      return `(function(cells,origin){var added=0;${state}.extensions=${state}.extensions||{};${state}.extensions.tileEffects=Array.isArray(${state}.extensions.tileEffects)?${state}.extensions.tileEffects:[];var apply=function(){(Array.isArray(cells)?cells:[]).forEach(function(cell){if(!cell||!Number.isInteger(cell.x)||!Number.isInteger(cell.y))return;var exists=${state}.extensions.tileEffects.some(function(item){return item&&item.tileType===${tileType}&&item.x===cell.x&&item.y===cell.y;});if(!exists){${state}.extensions.tileEffects.push(${effect});added+=1;}});};${enqueue}return added;})(${cells},${origin})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'extension.append-cell-records', label: '登记地格来源记录',
    description: '把来源棋子和归属玩家登记到封闭扩展地格集合；重复坐标不重复登记。',
    inputs: [port('source', pieceType), port('cells', cellListType)], outputs: [port('added', numberType)],
    parameters: [parameter('storageKey', stringType, { enum: CELL_STORAGE_KEYS, default: 'amaterasuCells' })],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx), source = input(ctx, 'source'), cells = input(ctx, 'cells'), key = stringLiteral(ctx, 'storageKey', 'amaterasuCells')
      if (!(CELL_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuCells' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      return `(function(sourceId,cells){var added=0;${state}.extensions=${state}.extensions||{};${state}.extensions[${key}]=Array.isArray(${state}.extensions[${key}])?${state}.extensions[${key}]:[];var source=sourceId!=null&&${flow(ctx)}.query.hasPiece(sourceId)?${flow(ctx)}.query.piece(sourceId):null;(Array.isArray(cells)?cells:[]).forEach(function(cell){if(!cell||!Number.isInteger(cell.x)||!Number.isInteger(cell.y))return;var exists=${state}.extensions[${key}].some(function(record){return record&&record.x===cell.x&&record.y===cell.y;});if(!exists){${state}.extensions[${key}].push({x:cell.x,y:cell.y,sourcePieceId:source&&source.instanceId||sourceId,ownerPlayerId:source&&source.ownerPlayerId});added+=1;}});return added;})(${source},${cells})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.set-owner', label: '设置扩展归属玩家',
    description: '以封闭归属字段写入玩家标识；可选择保留既有归属或按旧规则覆盖。',
    inputs: [port('player', 'player')], outputs: [port('success', booleanType)],
    parameters: [parameter('storageKey', stringType, { enum: OWNER_STORAGE_KEYS, default: 'amaterasuOwnerPlayerId' }), parameter('overwrite', booleanType, { default: false })],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx), key = stringLiteral(ctx, 'storageKey', 'amaterasuOwnerPlayerId'), overwrite = ctx.parameters.overwrite === true ? 'true' : 'false'
      if (!(OWNER_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuOwnerPlayerId' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      return `(function(playerId){if(typeof playerId!=="string")return false;${state}.extensions=${state}.extensions||{};if(${overwrite}||${state}.extensions[${key}]==null)${state}.extensions[${key}]=playerId;return true;})(${input(ctx, 'player')})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.read-cell-records', label: '读取扩展地格记录',
    inputs: [], outputs: [port('cells', cellListType)],
    parameters: [parameter('storageKey', stringType, { enum: CELL_STORAGE_KEYS, default: 'amaterasuCells' })],
    effects: pure(['extensions']),
    lower: ctx => {
      const state = battle(ctx), key = stringLiteral(ctx, 'storageKey', 'amaterasuCells')
      if (!(CELL_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuCells' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      return `(Array.isArray(${state}.extensions&&${state}.extensions[${key}])?${state}.extensions[${key}].filter(function(record){return record&&Number.isInteger(record.x)&&Number.isInteger(record.y);}).map(function(record){return {x:record.x,y:record.y};}):[])`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.remove-cell-records', label: '移除扩展地格记录',
    description: '按图中明确传入的地格集合删除封闭扩展记录和对应 tile 表现，并保留批次表现事件。',
    inputs: [port('cells', cellListType)], outputs: [port('removed', numberType)],
    parameters: [
      parameter('storageKey', stringType, { enum: CELL_STORAGE_KEYS, default: 'amaterasuCells' }),
      parameter('tileType', stringType, { enum: TILE_TYPES, default: 'amaterasu' }),
      parameter('presentationBatch', stringType, { enum: ['queue', 'direct'], default: 'queue' }),
    ],
    effects: writes(['extensions', 'tile-effects'], ['tileEffectRemoved']),
    lower: ctx => {
      const state = battle(ctx), runtimeContext = context(ctx), cells = input(ctx, 'cells')
      const key = stringLiteral(ctx, 'storageKey', 'amaterasuCells'), tileType = stringLiteral(ctx, 'tileType', 'amaterasu'), batch = stringParameter(ctx, 'presentationBatch', 'queue')
      if (!(CELL_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuCells' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      if (!(TILE_TYPES as readonly string[]).includes(ctx.parameters.tileType === undefined ? 'amaterasu' : ctx.parameters.tileType as string)) throw new Error(`module ${ctx.moduleId}: invalid tileType`)
      if (batch !== 'queue' && batch !== 'direct') throw new Error(`module ${ctx.moduleId}: invalid presentationBatch`)
      const enqueue = batch === 'direct'
        ? 'apply();'
        : `if(${runtimeContext}.presentationQueue&&typeof ${runtimeContext}.presentationQueue.push==="function")${runtimeContext}.presentationQueue.push("tileEffectRemoved",apply);else apply();`
      return `(function(cells){var selected=Array.isArray(cells)?cells.filter(function(cell){return cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.y);}):[];var matches=function(cell){return selected.some(function(candidate){return candidate.x===cell.x&&candidate.y===cell.y;});};${state}.extensions=${state}.extensions||{};var records=Array.isArray(${state}.extensions[${key}])?${state}.extensions[${key}]:[],removed=records.filter(matches).length;var apply=function(){${state}.extensions[${key}]=records.filter(function(record){return !matches(record);});if(Array.isArray(${state}.extensions.tileEffects))${state}.extensions.tileEffects=${state}.extensions.tileEffects.filter(function(effect){return !(effect&&effect.tileType===${tileType}&&matches(effect));});};${enqueue}return removed;})(${cells})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'extension.cell-record-source', label: '读取地格来源棋子',
    inputs: [port('piece', pieceType)], outputs: [port('sourceId', stringType, { nullable: true }), port('ownerPlayerId', 'player', { nullable: true })],
    parameters: [parameter('storageKey', stringType, { enum: CELL_STORAGE_KEYS, default: 'amaterasuCells' })],
    effects: pure(['extensions', 'position']),
    lower: ctx => {
      const state = battle(ctx), key = stringLiteral(ctx, 'storageKey', 'amaterasuCells')
      if (!(CELL_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuCells' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      return `(function(pieceId){var piece=${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId):null,records=Array.isArray(${state}.extensions&&${state}.extensions[${key}])?${state}.extensions[${key}]:[],record=piece&&records.find(function(item){return item&&item.x===piece.x&&item.y===piece.y;}),source=record&&record.sourcePieceId,owner=record&&record.ownerPlayerId;return {sourceId:typeof source==="string"?source:null,ownerPlayerId:typeof owner==="string"?owner:null};})(${input(ctx, 'piece')})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'event.path-cell-record-hits', label: '统计路径地格命中',
    description: '按接触路径顺序统计地格记录命中，重复经过同一地格重复计数，并返回首个来源。',
    inputs: [], outputs: [port('hits', numberType), port('sourceId', stringType, { nullable: true }), port('ownerPlayerId', 'player', { nullable: true })],
    parameters: [parameter('storageKey', stringType, { enum: CELL_STORAGE_KEYS, default: 'amaterasuCells' })],
    effects: pure(['extensions', 'event']),
    lower: ctx => {
      const state = battle(ctx), event = context(ctx), key = stringLiteral(ctx, 'storageKey', 'amaterasuCells')
      if (!(CELL_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuCells' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      return `(function(path,records){var hits=0,source=null,owner=null;(Array.isArray(path)?path:[]).forEach(function(cell){var found=Array.isArray(records)?records.find(function(record){return record&&cell&&record.x===cell.x&&record.y===cell.y;}):null;if(!found)return;if(source===null&&typeof found.sourcePieceId==="string")source=found.sourcePieceId;if(owner===null&&typeof found.ownerPlayerId==="string")owner=found.ownerPlayerId;hits+=1;});return {hits:hits,sourceId:source,ownerPlayerId:owner};})(${event}.contactCells,Array.isArray(${state}.extensions&&${state}.extensions[${key}])?${state}.extensions[${key}]:[])`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'rule.authorized-by-owner', label: '检查扩展规则归属',
    inputs: [], outputs: [port('authorized', booleanType)],
    parameters: [parameter('storageKey', stringType, { enum: OWNER_STORAGE_KEYS, default: 'amaterasuOwnerPlayerId' })],
    effects: pure(['extensions', 'event']),
    lower: ctx => {
      const state = battle(ctx), event = context(ctx), key = stringLiteral(ctx, 'storageKey', 'amaterasuOwnerPlayerId')
      if (!(OWNER_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuOwnerPlayerId' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      return `(function(){var owner=${state}.extensions&&${state}.extensions[${key}];return !owner||${event}.playerId===owner;})()`
    },
    allowedSurfaces: ['rule', 'pending'],
    ui: { category: 'rule' },
  }),
  define({
    id: 'rule.source-player-fallback', label: '读取规则来源玩家',
    inputs: [], outputs: [port('player', 'player', { nullable: true })],
    parameters: [parameter('storageKey', stringType, { enum: OWNER_STORAGE_KEYS, default: 'amaterasuOwnerPlayerId' })],
    effects: pure(['extensions', 'event', 'players']),
    lower: ctx => {
      const state = battle(ctx), event = context(ctx), key = stringLiteral(ctx, 'storageKey', 'amaterasuOwnerPlayerId')
      if (!(OWNER_STORAGE_KEYS as readonly string[]).includes(ctx.parameters.storageKey === undefined ? 'amaterasuOwnerPlayerId' : ctx.parameters.storageKey as string)) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      return `(function(){var owner=${state}.extensions&&${state}.extensions[${key}];return ${event}.ruleOwnerPlayerId||${event}.playerId||owner||null;})()`
    },
    allowedSurfaces: ['rule', 'pending'],
    ui: { category: 'rule' },
  }),
  define({
    id: 'status.read-live-source', label: '读取存活状态来源',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true })], outputs: [port('source', pieceType, { nullable: true })],
    effects: pure(['statuses', 'pieces']),
    lower: ctx => `(function(pieceId,statusId){if(statusId==null||!${flow(ctx)}.query.hasPiece(pieceId))return null;var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;}),sourceId=tag&&tag.sourcePieceId;if(typeof sourceId!=="string"||!${flow(ctx)}.query.hasPiece(sourceId))return null;var source=${flow(ctx)}.query.piece(sourceId);return source&&source.currentHp>0?source.instanceId:null;})(${input(ctx, 'piece')},${input(ctx, 'statusId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'record.read-text', label: '读取登记文本',
    inputs: [port('record', recordType, { nullable: true }), port('fallback', stringType)], outputs: [port('value', stringType)],
    parameters: [parameter('field', stringType, { enum: ['message'] })],
    effects: pure(),
    lower: ctx => {
      const field = stringLiteral(ctx, 'field')
      if (ctx.parameters.field !== 'message') throw new Error(`module ${ctx.moduleId}: invalid field`)
      return `(function(record,fallback){var value=record&&record[${field}];return typeof value==="string"?value:fallback;})(${input(ctx, 'record')},${input(ctx, 'fallback')})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'collection.live-piece-count', label: '读取现役棋子数量',
    description: '读取当前权威棋子数组长度；用于保留旧版实时 forEach 的初始长度语义。',
    inputs: [], outputs: [port('count', numberType)],
    effects: pure(['pieces']),
    lower: ctx => {
      const state = battle(ctx)
      return `(function(pieces){return Array.isArray(pieces)?pieces.length:0;})(${state}.pieces)`
    },
    ui: { category: 'collection' },
  }),
  define({
    id: 'collection.live-piece-at', label: '读取现役棋子项',
    description: '按当前权威棋子数组索引读取不透明棋子标识；每次读取都观察实时数组。',
    inputs: [port('index', numberType)], outputs: [port('piece', pieceType, { nullable: true })],
    effects: pure(['pieces']),
    lower: ctx => {
      const state = battle(ctx), index = input(ctx, 'index')
      return `(function(pieces,index){if(!Array.isArray(pieces)||!Number.isInteger(index)||index<0||index>=pieces.length)return null;var piece=pieces[index];return piece&&typeof piece.instanceId==="string"?piece.instanceId:null;})(${state}.pieces,${index})`
    },
    ui: { category: 'collection' },
  }),
]

export const AMATERASU_GAMEPLAY_MODULES: readonly Descriptor[] = Object.freeze(DESCRIPTORS)
export const amaterasuGameplayModuleDescriptors = AMATERASU_GAMEPLAY_MODULES
