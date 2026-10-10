import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Small, reusable adapters for delayed position effects.
 *
 * These descriptors deliberately expose facts and bounded mutations only.  A
 * flight graph still owns its selection order, record schema, timing branches,
 * two independent movement requests, and cleanup.  Nothing here knows a skill
 * or rule id and there is no alternate state store: status writes go through
 * flow.status and tile marks go through flow.effects.tileBatch (or the narrow
 * flight-mark cleanup below).
 */

const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const recordType: GameplayValueType = 'record'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> & { enum?: readonly (string | number | boolean | null)[] } = {}) => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const literal = (ctx: GameplayNativeLoweringContext, name: string): string => ctx.emitLiteral(ctx.parameters[name])
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE_SURFACES,
  ...value,
})

const PIECE_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'piece.identifier', label: '棋子标识', description: '读取经查询验证的稳定棋子实例标识。',
    inputs: [port('piece', pieceType)], outputs: [port('id', stringType)], effects: pure(['pieces']),
    lower: ctx => `(${flow(ctx)}.query.piece(${input(ctx, 'piece')}).instanceId)`,
    ui: { category: 'query' },
  }),
  define({
    id: 'piece.alive', label: '棋子存活', description: '判断棋子引用仍在当前战斗且生命值大于零。',
    inputs: [port('piece', pieceType, { nullable: true, optional: true })], outputs: [port('alive', booleanType)],
    effects: pure(['pieces']),
    lower: ctx => `(${flow(ctx)}.query.hasPiece(${ctx.inputs.piece ?? 'null'}) && ${flow(ctx)}.query.piece(${ctx.inputs.piece ?? 'null'}).currentHp > 0)`,
    ui: { category: 'query' },
  }),
]

const SPATIAL_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'spatial.cell', label: '构造地格记录', description: '由两个有限坐标构造不透明地格值。',
    inputs: [port('x', numberType), port('y', numberType)], outputs: [port('cell', cellType)], effects: pure(),
    lower: ctx => `({x: ${input(ctx, 'x')}, y: ${input(ctx, 'y')}})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-adjacent', label: '相邻地格', description: '判断两个地格是否正交相邻。',
    inputs: [port('left', cellType), port('right', cellType)], outputs: [port('value', booleanType)], effects: pure(),
    lower: ctx => `(Math.abs((${input(ctx, 'left')}).x - (${input(ctx, 'right')}).x) + Math.abs((${input(ctx, 'left')}).y - (${input(ctx, 'right')}).y) === 1)`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-coordinates', label: '读取地格坐标', description: '读取已验证地格的两个坐标事实。',
    inputs: [port('cell', cellType)], outputs: [port('x', numberType), port('y', numberType)], effects: pure(),
    lower: ctx => `({x: (${input(ctx, 'cell')}).x, y: (${input(ctx, 'cell')}).y})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-landing-legal', label: '合法落点',
    description: '按既有落点约束重新验证地格、可行走地形和存活占位；可列出同次位移中将离开的棋子。',
    inputs: [
      port('cell', cellType),
      port('ignoreA', pieceType, { nullable: true, optional: true }),
      port('ignoreB', pieceType, { nullable: true, optional: true }),
    ],
    outputs: [port('legal', booleanType)],
    parameters: [parameter('terrainPolicy', stringType, { enum: ['floor-or-cover', 'walkable'] })],
    effects: pure(['position', 'pieces']),
    lower: ctx => {
      const target = input(ctx, 'cell')
      const ignoreA = ctx.inputs.ignoreA ?? 'null'
      const ignoreB = ctx.inputs.ignoreB ?? 'null'
      const state = battle(ctx)
      const terrainPolicy = literal(ctx, 'terrainPolicy')
      // Reservation marks intentionally do not participate in this check:
      // they are informational tileEffects and remain enterable.
      return `(function(cell, ignoreA, ignoreB, terrainPolicy) { var tile = ${state}.map && Array.isArray(${state}.map.tiles) ? ${state}.map.tiles.find(function(item) { return item && item.x === cell.x && item.y === cell.y; }) : null; if (!tile || !tile.props || !tile.props.walkable || (terrainPolicy === "floor-or-cover" && tile.props.type !== "floor" && tile.props.type !== "cover")) return false; var ignored = []; if (ignoreA != null) ignored.push(String(ignoreA)); if (ignoreB != null) ignored.push(String(ignoreB)); return !(Array.isArray(${state}.pieces) && ${state}.pieces.some(function(piece) { return piece && piece.currentHp > 0 && piece.x === cell.x && piece.y === cell.y && ignored.indexOf(String(piece.instanceId)) < 0; })); })(${target}, ${ignoreA}, ${ignoreB}, ${terrainPolicy})`
    },
    ui: { category: 'position' },
  }),
]

const TILE_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'tile.has-effect', label: '地格具有附着', description: '查询白名单地格附着类型在指定坐标是否存在。',
    inputs: [port('cell', cellType)], outputs: [port('exists', booleanType)],
    parameters: [parameter('effectType', stringType)],
    effects: pure(['tile-effects']),
    lower: ctx => {
      const state = battle(ctx)
      return `(Array.isArray(${state}.extensions && ${state}.extensions.tileEffects) && ${state}.extensions.tileEffects.some(function(effect) { return effect && effect.type === ${literal(ctx, 'effectType')} && effect.x === (${input(ctx, 'cell')}).x && effect.y === (${input(ctx, 'cell')}).y; }))`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'tile.add-reservation', label: '添加地格预留标记',
    description: '通过权威 tileBatch 添加不阻挡进入的双尾飞行预留记录。',
    inputs: [port('cell', cellType), port('id', stringType), port('flightId', stringType)], outputs: [port('success', booleanType)],
    parameters: [parameter('effectType', stringType)],
    effects: writes(['tile-effects'], ['tileEffectAdded']),
    lower: ctx => {
      const effect = `{id: ${input(ctx, 'id')}, type: ${literal(ctx, 'effectType')}, x: (${input(ctx, 'cell')}).x, y: (${input(ctx, 'cell')}).y, flightId: ${input(ctx, 'flightId')}}`
      // tileBatch is still the authoritative append/duplicate-ID path.  Its
      // presentation normalizer adds animation metadata that the frozen
      // legacy push never stored, so strip only those newly-added keys from
      // the committed object to preserve the existing tileEffects shape.
      return `(function(effect) { var committed = ${flow(ctx)}.effects.tileBatch([effect]); if (!committed.length) return false; var sourceKeys = Object.keys(effect); Object.keys(committed[0]).forEach(function(key) { if (sourceKeys.indexOf(key) < 0) delete committed[0][key]; }); return true; })(${effect})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'tile.clear-flight-reservations', label: '清理飞行预留',
    description: '只移除指定 flightId 的双尾飞行预留，保留其他地格效果。',
    inputs: [port('flightId', stringType)], outputs: [port('success', booleanType)],
    parameters: [parameter('effectType', stringType)],
    effects: writes(['tile-effects'], ['tileEffectRemoved']),
    lower: ctx => {
      const state = battle(ctx)
      const flightId = input(ctx, 'flightId')
      return `(function(flightId, effectType) { if (${state}.extensions && Array.isArray(${state}.extensions.tileEffects)) ${state}.extensions.tileEffects = ${state}.extensions.tileEffects.filter(function(effect) { return !(effect && effect.type === effectType && effect.flightId === flightId); }); return true; })(${flightId}, ${literal(ctx, 'effectType')})`
    },
    ui: { category: 'position' },
  }),
]

const EFFECT_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'effect.teleport-if-present', label: '按存在性传送',
    description: '棋子引用有效时通过现有 flow.effects.move 传送；无效引用返回失败，不旁路修改坐标。',
    inputs: [port('piece', pieceType, { nullable: true }), port('destination', cellType)], outputs: [port('success', booleanType)],
    effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => {
      const piece = input(ctx, 'piece')
      const destination = input(ctx, 'destination')
      const query = flow(ctx)
      return `(function(pieceId, cell) { if (pieceId == null || !${query}.query.hasPiece(pieceId)) return false; return Boolean(${query}.effects.move([{pieceId: pieceId, x: cell.x, y: cell.y}], "teleport").success); })(${piece}, ${destination})`
    },
    ui: { category: 'effect' },
  }),
]

const STATUS_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'status.apply-record', label: '附加结构化棋子状态',
    description: '将 graph-local typed record 交给现有 status lifecycle；不建立第二份状态存储。',
    inputs: [port('target', pieceType), port('record', recordType)], outputs: [port('success', booleanType)],
    parameters: [{ name: 'inputPolicy', type: 'string', enum: ['flow', 'host'], default: 'flow' }],
    effects: writes(['status', 'rule', 'events'], ['afterStatusApplied']),
    lower: ctx => `${flow(ctx)}.status.add(${input(ctx, 'target')}, ${input(ctx, 'record')}, "piece"${ctx.parameters.inputPolicy === 'host' ? ', "host"' : ''})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.find-flight', label: '读取飞行记录',
    description: '从持有棋子的 statusTags 中读取指定独立飞行记录的白名单字段。',
    inputs: [port('target', pieceType)],
    outputs: [
      port('found', booleanType), port('id', stringType), port('flightId', stringType),
      port('allyId', pieceType, { nullable: true }), port('x', numberType), port('y', numberType),
      port('allyX', numberType), port('allyY', numberType), port('appliedTurn', numberType), port('currentDuration', numberType),
    ],
    parameters: [parameter('statusType', stringType)],
    effects: pure(['statuses', 'pieces']),
    lower: ctx => {
      const target = input(ctx, 'target')
      const type = literal(ctx, 'statusType')
      const query = flow(ctx)
      return `(function(pieceId, statusType) { var piece = ${query}.query.piece(pieceId); var tag = ((piece && piece.statusTags) || []).find(function(item) { return item && item.type === statusType && item.ownerId === pieceId; }); var allyId = tag && typeof tag.allyId === "string" && ${query}.query.hasPiece(tag.allyId) && ${query}.query.piece(tag.allyId).currentHp > 0 ? tag.allyId : null; return {found: Boolean(tag), id: tag && typeof tag.id === "string" ? tag.id : "", flightId: tag && typeof tag.flightId === "string" ? tag.flightId : "", allyId: allyId, x: tag && Number.isFinite(tag.x) ? tag.x : 0, y: tag && Number.isFinite(tag.y) ? tag.y : 0, allyX: tag && Number.isFinite(tag.allyX) ? tag.allyX : 0, allyY: tag && Number.isFinite(tag.allyY) ? tag.allyY : 0, appliedTurn: tag && Number.isFinite(tag.appliedTurn) ? tag.appliedTurn : -1, currentDuration: tag && Number.isFinite(tag.currentDuration) ? tag.currentDuration : 0}; })(${target}, ${type})`
    },
    ui: { category: 'status' },
  }),
  define({
    id: 'status.remove-by-flight', label: '按飞行标识移除状态',
    description: '枚举指定棋子的独立飞行状态，并逐条经 status lifecycle 移除。',
    inputs: [port('target', pieceType, { nullable: true, optional: true }), port('flightId', stringType)], outputs: [port('success', booleanType)],
    effects: writes(['status', 'rule', 'events'], ['afterStatusRemoved']),
    lower: ctx => {
      const target = ctx.inputs.target ?? 'null'
      const flightId = input(ctx, 'flightId')
      const query = flow(ctx)
      return `(function(pieceId, flightId) { if (pieceId == null || !${query}.query.hasPiece(pieceId)) return true; var piece = ${query}.query.piece(pieceId); var tags = ((piece && piece.statusTags) || []).filter(function(tag) { return tag && tag.flightId === flightId; }); tags.forEach(function(tag) { if (tag && typeof tag.id === "string") ${query}.status.remove(pieceId, tag.id, "piece"); }); return true; })(${target}, ${flightId})`
    },
    ui: { category: 'status' },
  }),
]

/** Descriptors are registered by module-registry.ts, which owns freezing and lookup. */
export const FLIGHT_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  ...PIECE_PRIMITIVES,
  ...SPATIAL_PRIMITIVES,
  ...TILE_PRIMITIVES,
  ...EFFECT_PRIMITIVES,
  ...STATUS_PRIMITIVES,
])

