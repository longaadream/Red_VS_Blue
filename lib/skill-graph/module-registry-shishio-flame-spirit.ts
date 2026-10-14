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
 * Small, reusable adapters for the flame-spirit skill graph.
 *
 * The graph owns the four-cell order, duplicate predicate, messages, enemy
 * query and damage branch.  These descriptors only expose the two existing
 * host boundaries involved in that flow: a closed extension record and the
 * authoritative tileBatch presentation path.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const recordListType: GameplayValueType = { kind: 'list', element: 'record' }
const recordType: GameplayValueType = 'record'
const numberType: GameplayValueType = 'number'
const stringType: GameplayValueType = 'string'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({ version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value })
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const parameterLiteral = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })

export const SHISHIO_FLAME_SPIRIT_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'spatial.cardinal-cells-ordered',
    label: '按指定冻结顺序生成正交地格',
    description: '按作者声明的封闭正交顺序生成目标周围四格；地图边界和重复判断由作者图处理。',
    inputs: [port('target', pieceType)],
    outputs: [port('cells', cellListType)],
    parameters: [parameter('order', stringType, { enum: ['up-down-left-right', 'up-right-down-left'] })],
    effects: pure(['position']),
    lower: ctx => {
      const target = input(ctx, 'target')
      const order = parameterLiteral(ctx, 'order')
      return `(function(targetId,order){var target=${flow(ctx)}.query.piece(targetId);if(!target||!Number.isFinite(target.x)||!Number.isFinite(target.y))return [];var offsets=order==="up-down-left-right"?[[0,-1],[0,1],[-1,0],[1,0]]:[[0,-1],[1,0],[0,1],[-1,0]];return offsets.map(function(offset){return {x:target.x+offset[0],y:target.y+offset[1]};});})(${target},${order})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'extension.records-to-cells',
    label: '记录投影为地格',
    description: '将已登记的记录按原顺序投影为坐标地格，不读取或写入开放对象路径。',
    inputs: [port('records', recordListType)],
    outputs: [port('cells', cellListType)],
    effects: pure(['extensions']),
    lower: ctx => `(Array.isArray(${input(ctx, 'records')})?${input(ctx, 'records')}.map(function(record){return {x:record.x,y:record.y};}):[])`,
    ui: { category: 'state' },
  }),
  define({
    id: 'extension.append-cell-records-ordered',
    label: '追加封闭地格记录',
    description: '将图已去重的地格按输入顺序追加到 shishioBurnTiles，并记录来源棋子与玩家。',
    inputs: [port('source', pieceType), port('cells', cellListType)],
    outputs: [port('added', numberType)],
    parameters: [parameter('key', stringType, { enum: ['shishioBurnTiles'] })],
    effects: writes(['extensions']),
    lower: ctx => {
      const key = parameterLiteral(ctx, 'key')
      const source = input(ctx, 'source')
      const cells = input(ctx, 'cells')
      const state = battle(ctx)
      const runtime = flow(ctx)
      return `(function(sourceId,cells){${state}.extensions=${state}.extensions||{};${state}.extensions[${key}]=Array.isArray(${state}.extensions[${key}])?${state}.extensions[${key}]:[];var source=${runtime}.query.hasPiece(sourceId)?${runtime}.query.piece(sourceId):null,added=0;(Array.isArray(cells)?cells:[]).forEach(function(cell){if(!cell||!Number.isFinite(cell.x)||!Number.isFinite(cell.y))return;${state}.extensions[${key}].push({x:cell.x,y:cell.y,sourcePieceId:source&&source.instanceId||sourceId,ownerPlayerId:source&&source.ownerPlayerId});added+=1;});return added;})(${source},${cells})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'effect.damage-pieces-unattributed',
    label: '以棋子引用造成无技能归属伤害',
    description: '把已经解析的来源和目标棋子交给旧 damage facade；省略可选 skillId 以保留未归属的旧内容事件形状。',
    inputs: [port('source', pieceType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('result', recordType)],
    parameters: [parameter('damageType', stringType, { enum: ['true', 'physical', 'magical'] })],
    allowedSurfaces: ['skill'],
    effects: writes(['damage', 'events'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const amount = input(ctx, 'amount')
      const type = parameterLiteral(ctx, 'damageType')
      const runtime = flow(ctx)
      return `(function(sourceId,targetId,amount){var source=${runtime}.query.piece(sourceId),target=${runtime}.query.piece(targetId);return dealDamage(source,target,amount,${type});})(${source},${target},${amount})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'tile.batch-effect-markers',
    label: '批量提交燃烧表现',
    description: '按输入地格顺序通过权威 tileBatch 提交燃烧表现，保留地图外地格与空批次调用语义。',
    inputs: [port('cells', cellListType)],
    outputs: [port('count', numberType)],
    parameters: [
      parameter('sourceId', stringType, { enum: ['shishio-burn'] }),
      parameter('tileType', stringType, { enum: ['shishio-burn'] }),
      parameter('icon', stringType, { enum: ['♨️'] }),
      parameter('iconPosition', stringType, { enum: ['bottom-right'] }),
    ],
    effects: writes(['tile-effects'], ['tileEffectAdded']),
    lower: ctx => {
      const cells = input(ctx, 'cells')
      const runtime = flow(ctx)
      const sourceId = parameterLiteral(ctx, 'sourceId')
      const tileType = parameterLiteral(ctx, 'tileType')
      const icon = parameterLiteral(ctx, 'icon')
      const iconPosition = parameterLiteral(ctx, 'iconPosition')
      return `(function(cells){var effects=(Array.isArray(cells)?cells:[]).map(function(cell){return {x:cell.x,y:cell.y,sourceId:${sourceId},tileType:${tileType},icon:${icon},iconPosition:${iconPosition}};});return ${runtime}.effects.tileBatch(effects).length;})(${cells})`
    },
    ui: { category: 'position' },
  }),
])
