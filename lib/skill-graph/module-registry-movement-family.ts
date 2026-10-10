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

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const stringLiteral = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}
const numberLiteral = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({ version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value })

const MOVEMENT_FAMILY_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
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
    id: 'lifecycle.remove-enemy', label: '强制移除敌方棋子',
    description: '通过主动技能生命周期入口移除仍存在的目标，不直接编辑棋子集合。',
    inputs: [port('target', pieceType, { nullable: true })], outputs: [port('success', booleanType)],
    inspectReferences: ['target'],
    effects: writes(['pieces', 'events']),
    lower: ctx => `(function(targetId) { if (targetId == null || !${flow(ctx)}.query.hasPiece(targetId)) return false; return Boolean(${flow(ctx)}.lifecycle.removeEnemy(targetId)); })(${input(ctx, 'target')})`,
    ui: { category: 'lifecycle' },
  }),
]

export const MOVEMENT_FAMILY_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze(MOVEMENT_FAMILY_PRIMITIVES)
