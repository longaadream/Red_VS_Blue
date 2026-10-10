import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Generic primitives used by declared summon content.
 *
 * These adapters deliberately do not know any skill, status, or rule id. They
 * only expose the existing option, position, lifecycle, and event boundaries
 * to a typed graph. Summoning is still validated by the content declaration
 * bound by executeSkillFunction; health-zero is deliberately limited to the
 * existing damage/death boundary and never writes coordinates.
 */

const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']

const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const choiceType: GameplayValueType = 'choice'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> & { enum?: readonly (string | number | boolean | null)[] } = {}) => ({ name, type, ...options })
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const literal = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string | boolean | number): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (value === undefined) throw new Error(`module ${ctx.moduleId}: missing parameter ${name}`)
  return ctx.emitLiteral(value)
}
const runtime = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE_SURFACES,
  ...value,
})

const CHOICE_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'choice.option-pair', label: '二选一选项',
    description: '用两个文本值构造既有单选协议；挂起、取消和选项校验仍由权威宿主负责。',
    inputs: [], outputs: [port('choice', choiceType)],
    parameters: [
      parameter('title', stringType, { optional: true }),
      parameter('firstLabel', stringType), parameter('firstValue', stringType),
      parameter('secondLabel', stringType), parameter('secondValue', stringType),
      parameter('canCancel', booleanType, { optional: true }),
    ],
    effects: { ...writes(['pending'], ['pendingOptionSelection']), pending: true },
    lower: ctx => {
      const title = Object.prototype.hasOwnProperty.call(ctx.parameters, 'title') ? `, title: ${literal(ctx, 'title')}` : ''
      const canCancel = Object.prototype.hasOwnProperty.call(ctx.parameters, 'canCancel') ? `, canCancel: ${literal(ctx, 'canCancel')}` : ''
      return `(${runtime(ctx)}.choice.option({options: [{label: ${literal(ctx, 'firstLabel')}, value: ${literal(ctx, 'firstValue')}}, {label: ${literal(ctx, 'secondLabel')}, value: ${literal(ctx, 'secondValue')}}]${title}${canCancel}}))`
    },
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.option-value', label: '读取选项值',
    description: '将权威宿主返回的已完成单选解析为文本值；挂起分支必须先返回。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })], outputs: [port('value', stringType)],
    effects: pure(['choice']),
    lower: ctx => {
      const value = input(ctx, 'choice')
      return `(function(value) { if (typeof value === "string") return value; if (value && typeof value.value === "string") return value.value; return ""; })(${value})`
    },
    ui: { category: 'choice' },
  }),
]

const SPATIAL_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'spatial.piece-position', label: '读取棋子位置',
    description: '读取经权威棋子查询验证后的当前位置快照；不暴露可写棋子对象。',
    inputs: [port('piece', pieceType)], outputs: [port('cell', cellType)],
    effects: pure(['pieces', 'position']),
    lower: ctx => `${runtime(ctx)}.query.piece(${input(ctx, 'piece')}) && {x: ${runtime(ctx)}.query.piece(${input(ctx, 'piece')}).x, y: ${runtime(ctx)}.query.piece(${input(ctx, 'piece')}).y}`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-distance', label: '地格曼哈顿距离',
    description: '读取两个已验证地格之间的曼哈顿距离。',
    inputs: [port('from', cellType), port('to', cellType)], outputs: [port('distance', numberType)],
    effects: pure(['position']),
    lower: ctx => `Math.abs((${input(ctx, 'to')}).x - (${input(ctx, 'from')}).x) + Math.abs((${input(ctx, 'to')}).y - (${input(ctx, 'from')}).y)`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-walkable', label: '检查地格可行走',
    description: '按当前地图读取地格和可行走属性；不判断棋子占位。',
    inputs: [port('cell', cellType)], outputs: [port('walkable', booleanType)],
    effects: pure(['map']),
    lower: ctx => {
      const state = battle(ctx)
      const cell = input(ctx, 'cell')
      return `(function(cell) { var tiles = ${state}.map && Array.isArray(${state}.map.tiles) ? ${state}.map.tiles : []; var tile = tiles.find(function(item) { return item && item.x === cell.x && item.y === cell.y; }); return Boolean(tile && tile.props && tile.props.walkable); })(${cell})`
    },
    ui: { category: 'position' },
  }),
]

const LIFECYCLE_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'lifecycle.queue-summon', label: '排队声明式召唤',
    description: '将一个来源棋子和地格交给当前内容声明的召唤队列；来源镜像能力、数量和变体由宿主声明验证。',
    inputs: [port('source', pieceType), port('destination', cellType), port('variant', stringType)],
    outputs: [port('queued', numberType)],
    effects: writes(['summon', 'queue'], ['summonQueued']),
    lower: ctx => {
      const destination = input(ctx, 'destination')
      return `${runtime(ctx)}.lifecycle.summon({sourceId: ${input(ctx, 'source')}, summons: [{x: (${destination}).x, y: (${destination}).y, variant: ${input(ctx, 'variant')}}]})`
    },
    ui: { category: 'lifecycle' },
  }),
  define({
    id: 'lifecycle.zero-health', label: '将棋子生命置零',
    description: '在伤害触发边界将已验证棋子的生命置零，让现有 DeathBatch 继续负责正式死亡和后续规则；不写入位置。',
    inputs: [port('target', pieceType)], outputs: [port('success', booleanType)],
    effects: writes(['health', 'damage']), allowedSurfaces: ['rule'],
    lower: ctx => {
      const target = input(ctx, 'target')
      const host = runtime(ctx)
      return `(function(pieceId) { if (${host}.event.read().type !== "afterDamageTaken") return false; if (pieceId == null || pieceId !== ${host}.refs.source() || !${host}.query.hasPiece(pieceId)) return false; ${host}.query.piece(pieceId).currentHp = 0; return true; })(${target})`
    },
    ui: { category: 'lifecycle' },
  }),
]

/** Registered by module-registry.ts after the migration is approved. */
export const SUMMON_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  ...CHOICE_PRIMITIVES,
  ...SPATIAL_PRIMITIVES,
  ...LIFECYCLE_PRIMITIVES,
])

