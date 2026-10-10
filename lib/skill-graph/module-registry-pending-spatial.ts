import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayParameter,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Reusable facts and effects for the delayed spatial content batch.
 *
 * These descriptors intentionally describe capabilities (a formation, an
 * anchor, a mark, a once-per-turn flag), rather than any character or skill.
 * The only extension keys they touch are the existing, schema-less spatial
 * marker and turn-flag records owned by the legacy host.  Content graphs still
 * own all ordering, validation branches, messages, and pending envelopes.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const choiceType: GameplayValueType = 'choice'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const choiceListType: GameplayValueType = { kind: 'list', element: choiceType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}) => ({ name, type, ...options })
const input = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) {
    if (fallback !== undefined) return fallback
    throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  }
  return value
}
const runtime = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const host = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx' : 'context'
const literal = (ctx: GameplayNativeLoweringContext, name: string, fallback?: unknown): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (value === undefined) throw new Error(`module ${ctx.moduleId}: missing parameter ${name}`)
  return ctx.emitLiteral(value as never)
}
const stringLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}
const numberLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback?: number): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}
const booleanLiteral = (ctx: GameplayNativeLoweringContext, name: string, fallback?: boolean): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'boolean') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be boolean`)
  return ctx.emitLiteral(value)
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE,
  ...value,
})

const CONTEXT_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'event.selected-targets', label: '已选目标集合', description: '读取宿主已经验证的多目标选择集合。',
    inputs: [], outputs: [port('targets', choiceListType)], effects: pure(['event', 'choice']),
    lower: ctx => `(Array.isArray(${host(ctx)}.selectedTargets) ? ${host(ctx)}.selectedTargets : [])`,
    ui: { category: 'context' },
  }),
  define({
    id: 'event.selected-option', label: '已选选项', description: '读取宿主已经验证的选项值；尚未选择时返回空值。',
    inputs: [], outputs: [port('value', stringType, { nullable: true })], effects: pure(['event', 'choice']),
    lower: ctx => `(${host(ctx)}.selectedOption === undefined || ${host(ctx)}.selectedOption === null ? null : String(${host(ctx)}.selectedOption))`,
    ui: { category: 'context' },
  }),
  define({
    id: 'event.card-id', label: '事件卡牌标识', description: '读取当前卡牌事件的稳定标识。',
    inputs: [], outputs: [port('value', stringType, { nullable: true })], effects: pure(['event']),
    allowedSurfaces: ['rule', 'triggerSkill', 'pending'],
    lower: ctx => `(${host(ctx)}.cardId === undefined || ${host(ctx)}.cardId === null ? null : String(${host(ctx)}.cardId))`,
    ui: { category: 'context' },
  }),
  define({
    id: 'event.skill-id', label: '事件技能标识', description: '读取当前技能事件的稳定标识。',
    inputs: [], outputs: [port('value', stringType, { nullable: true })], effects: pure(['event']),
    allowedSurfaces: ['rule', 'triggerSkill', 'pending'],
    lower: ctx => `(${host(ctx)}.skillId === undefined || ${host(ctx)}.skillId === null ? null : String(${host(ctx)}.skillId))`,
    ui: { category: 'context' },
  }),
  define({
    id: 'event.cancelled', label: '事件已取消', description: '读取宿主的取消事实。',
    inputs: [], outputs: [port('value', booleanType)], effects: pure(['event']),
    allowedSurfaces: ['rule', 'triggerSkill', 'pending'],
    lower: ctx => `Boolean(${host(ctx)}.cancelled)`,
    ui: { category: 'context' },
  }),
  define({
    id: 'event.reserved-cells', label: '事件预留地格', description: '读取当前位移事件提供的预留地格集合。',
    inputs: [], outputs: [port('cells', cellListType)], effects: pure(['event', 'position']),
    allowedSurfaces: ['rule', 'triggerSkill', 'pending'],
    lower: ctx => `(Array.isArray(${host(ctx)}.reservedCells) ? ${host(ctx)}.reservedCells : [])`,
    ui: { category: 'context' },
  }),
]

const CHOICE_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'choice.from-pieces', label: '棋子候选集合', description: '把已查询并按实例标识排序的棋子集合转换为目标候选。',
    inputs: [port('pieces', pieceListType)], outputs: [port('choices', choiceListType)], effects: pure(['pieces']),
    lower: ctx => `((${input(ctx, 'pieces')} || []).map(function(id) { return {type: "piece", pieceId: id}; }).sort(function(a, b) { return String(a.pieceId).localeCompare(String(b.pieceId)); }))`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.from-cells', label: '地格候选集合', description: '把地格集合按 y、x 的稳定顺序转换为目标候选。',
    inputs: [port('cells', cellListType)], outputs: [port('choices', choiceListType)], effects: pure(['position']),
    lower: ctx => `((${input(ctx, 'cells')} || []).map(function(cell) { return {type: "cell", x: cell.x, y: cell.y}; }).sort(function(a, b) { return a.y - b.y || a.x - b.x; }))`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.selected-pieces', label: '读取已选棋子', description: '从宿主目标集合中读取仍然存在的棋子并按实例标识排序。',
    inputs: [port('targets', choiceListType)], outputs: [port('pieces', pieceListType)], effects: pure(['pieces', 'choice']),
    lower: ctx => `(function(values) { var seen = {}; return (values || []).filter(function(value) { return value && value.type === "piece" && typeof value.pieceId === "string" && !seen[value.pieceId] && ${runtime(ctx)}.query.hasPiece(value.pieceId) && ${runtime(ctx)}.query.piece(value.pieceId).currentHp > 0 && (seen[value.pieceId] = true); }).map(function(value) { return value.pieceId; }).sort(function(a, b) { return String(a).localeCompare(String(b)); }); })(${input(ctx, 'targets')})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.selected-cell', label: '读取已选地格', description: '从宿主目标集合中读取首个合法地格。',
    inputs: [port('targets', choiceListType)], outputs: [port('cell', cellType, { nullable: true })], effects: pure(['choice']),
    lower: ctx => `(function(values) { var cell = (values || []).find(function(value) { return value && value.type === "cell" && Number.isInteger(value.x) && Number.isInteger(value.y); }); return cell ? {x: cell.x, y: cell.y} : null; })(${input(ctx, 'targets')})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.binary-option', label: '二元选项', description: '使用现有选项协议呈现一个可取消的二元选择。',
    inputs: [port('player', 'player', { nullable: true, optional: true })],
    outputs: [port('choice', choiceType)],
    parameters: [
      parameter('title', stringType), parameter('yesLabel', stringType), parameter('noLabel', stringType),
      parameter('yesValue', stringType, { default: 'yes' }), parameter('noValue', stringType, { default: 'no' }),
    ], effects: writes(['pending'], ['pendingOptionSelection']),
    lower: ctx => {
      const player = input(ctx, 'player', `${host(ctx)}.playerId`)
      const options = `[{label: ${stringLiteral(ctx, 'yesLabel')}, value: ${stringLiteral(ctx, 'yesValue', 'yes')}}, {label: ${stringLiteral(ctx, 'noLabel')}, value: ${stringLiteral(ctx, 'noValue', 'no')}}]`
      const config = `{title: ${stringLiteral(ctx, 'title')}, options: ${options}, playerId: ${player}, canCancel: true, cancelValue: ${stringLiteral(ctx, 'noValue', 'no')}}`
      return `${runtime(ctx)}.choice.option(${config})`
    },
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.raw-string-value', label: '已选选项值', description: '读取已完成二元选项的原始值；待选择或取消时返回空值。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })], outputs: [port('value', stringType, { nullable: true })], effects: pure(['choice']),
    lower: ctx => `(typeof ${input(ctx, 'choice')} === "string" ? ${input(ctx, 'choice')} : null)`,
    ui: { category: 'choice' },
  }),
]

const QUERY_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'piece.is-core', label: '核心棋子', description: '读取内容数据声明的核心棋子标记。',
    inputs: [port('piece', pieceType)], outputs: [port('value', booleanType)], effects: pure(['pieces']),
    lower: ctx => `Boolean(${runtime(ctx)}.query.piece(${input(ctx, 'piece')}).isCore === true)`,
    ui: { category: 'query' },
  }),
  define({
    id: 'piece.has-position', label: '棋子具有地格', description: '判断棋子当前具有可用于移动的有限地格坐标。',
    inputs: [port('piece', pieceType)], outputs: [port('value', booleanType)], effects: pure(['pieces', 'position']),
    lower: ctx => `(function(pieceId) { var piece = ${runtime(ctx)}.query.piece(pieceId); return Boolean(piece && Number.isFinite(piece.x) && Number.isFinite(piece.y)); })(${input(ctx, 'piece')})`,
    ui: { category: 'query' },
  }),
  define({
    id: 'piece.require', label: '解析可空棋子', description: '把已经通过存活或存在检查的可空棋子引用解析为统一棋子 ID。',
    inputs: [port('piece', pieceType, { nullable: true })], outputs: [port('piece', pieceType)], effects: pure(['pieces']),
    lower: ctx => `(function(pieceId) { return pieceId && ${runtime(ctx)}.query.hasPiece(pieceId) ? pieceId : null; })(${input(ctx, 'piece')})`,
    ui: { category: 'query' },
  }),
  define({
    id: 'spatial.cell-in-list', label: '地格属于候选', description: '按坐标判断地格是否仍属于一组已计算候选。',
    inputs: [port('cell', cellType, { nullable: true }), port('cells', cellListType)], outputs: [port('value', booleanType)], effects: pure(['position']),
    lower: ctx => `(function(cell, cells) { return Boolean(cell) && (cells || []).some(function(candidate) { return candidate && candidate.x === cell.x && candidate.y === cell.y; }); })(${input(ctx, 'cell')}, ${input(ctx, 'cells')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.walkable-cells', label: '可行走地格集合', description: '按地图顺序返回所有可行走地格。',
    inputs: [], outputs: [port('cells', cellListType)], effects: pure(['position']),
    lower: ctx => `((${battle(ctx)}.map && Array.isArray(${battle(ctx)}.map.tiles) ? ${battle(ctx)}.map.tiles : []).filter(function(tile) { return tile && tile.props && tile.props.walkable; }).sort(function(a, b) { return a.y - b.y || a.x - b.x; }).map(function(tile) { return {x:tile.x,y:tile.y}; }))`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.formation-selection-valid', label: '编队选择有效', description: '验证编队选择数量、存活、友方关系和核心标记。',
    inputs: [port('source', pieceType), port('selected', pieceListType)], outputs: [port('value', booleanType)], effects: pure(['pieces', 'players']),
    lower: ctx => {
      const source = input(ctx, 'source'), selected = input(ctx, 'selected'), state = battle(ctx), query = runtime(ctx)
      return `(function(sourceId, selectedIds) { if (!Array.isArray(selectedIds) || selectedIds.length < 1 || selectedIds.length > 3 || new Set(selectedIds.map(String)).size !== selectedIds.length) return false; var allies = ${query}.query.pieces({originId:sourceId, relation:"ally", includeDead:false}); return selectedIds.every(function(id) { var piece = (${state}.pieces || []).find(function(candidate) { return candidate && candidate.instanceId === id; }); return Boolean(piece && allies.indexOf(id) >= 0 && piece.isCore === true && piece.currentHp > 0); }); })(${source}, ${selected})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'list.count-pieces', label: '棋子集合数量', description: '读取有界棋子列表的数量。',
    inputs: [port('items', pieceListType)], outputs: [port('value', numberType)], effects: pure(),
    lower: ctx => `Array.isArray(${input(ctx, 'items')}) ? ${input(ctx, 'items')}.length : 0`,
    ui: { category: 'query' },
  }),
  define({
    id: 'list.first-piece', label: '棋子集合首项', description: '读取稳定排序棋子集合的首个实例；空集合返回空引用。',
    inputs: [port('items', pieceListType)], outputs: [port('piece', pieceType, { nullable: true })], effects: pure(['pieces']),
    lower: ctx => `(Array.isArray(${input(ctx, 'items')}) && ${input(ctx, 'items')}.length > 0 ? ${input(ctx, 'items')}[0] : null)`,
    ui: { category: 'query' },
  }),
  define({
    id: 'list.count-cells', label: '地格集合数量', description: '读取有界地格列表的数量。',
    inputs: [port('items', cellListType)], outputs: [port('value', numberType)], effects: pure(),
    lower: ctx => `Array.isArray(${input(ctx, 'items')}) ? ${input(ctx, 'items')}.length : 0`,
    ui: { category: 'query' },
  }),
  define({
    id: 'list.count-choices', label: '候选集合数量', description: '读取有界候选列表的数量。',
    inputs: [port('items', choiceListType)], outputs: [port('value', numberType)], effects: pure(),
    lower: ctx => `Array.isArray(${input(ctx, 'items')}) ? ${input(ctx, 'items')}.length : 0`,
    ui: { category: 'query' },
  }),
  define({
    id: 'value.present-cell', label: '地格存在', description: '判断一个延迟选择或位移结果中的可空地格是否存在。',
    inputs: [port('value', cellType, { nullable: true })], outputs: [port('present', booleanType)], effects: pure(),
    lower: ctx => `(${input(ctx, 'value')} !== null && ${input(ctx, 'value')} !== undefined)`,
    ui: { category: 'logic' },
  }),
  define({
    id: 'compare.equal-string-nullable', label: '可空文本相等', description: '比较可空事件文本与稳定文本标识。',
    inputs: [port('left', stringType, { nullable: true }), port('right', stringType)], outputs: [port('value', booleanType)], effects: pure(),
    lower: ctx => `(${input(ctx, 'left')} === ${input(ctx, 'right')})`,
    ui: { category: 'logic' },
  }),
  define({
    id: 'player.require', label: '解析可空玩家', description: '把延迟宿主上下文中的可空玩家引用解析为选择协议需要的玩家 ID。',
    inputs: [port('player', 'player', { nullable: true })], outputs: [port('player', 'player')], effects: pure(['context']),
    lower: ctx => `(${input(ctx, 'player')} || ${host(ctx)}.playerId)`,
    ui: { category: 'context' },
  }),
  define({
    id: 'query.random-item', label: '确定性随机棋子', description: '通过规则随机源选择一个棋子集合项。',
    inputs: [port('items', pieceListType)], outputs: [port('item', pieceType)], effects: { ...pure(['random']), random: true },
    lower: ctx => `${runtime(ctx)}.query.random(${input(ctx, 'items')})`,
    ui: { category: 'query' },
  }),
  define({
    id: 'status.has-source-mark', label: '来源标记存在', description: '查询目标身上由指定来源施加的状态标记。',
    inputs: [port('target', pieceType, { nullable: true }), port('source', pieceType, { nullable: true })], outputs: [port('value', booleanType)],
    parameters: [parameter('statusType', stringType)], effects: pure(['statuses']),
    lower: ctx => `(function(targetId, sourceId) { if (!targetId || !sourceId) return false; return ((${runtime(ctx)}.query.piece(targetId).statusTags || []).some(function(tag) { return tag && tag.type === ${stringLiteral(ctx, 'statusType')} && tag.sourceId === sourceId.toString() && (tag.stacks || 1) > 0; })); })(${input(ctx, 'target')}, ${input(ctx, 'source')})`,
    ui: { category: 'status' },
  }),
]

const CELL_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'spatial.cell-walkable-safe', label: '地格可行走（可空）', description: '按地图地形读取可行走事实，并在延迟目标失效时返回 false。',
    inputs: [port('cell', cellType, { nullable: true })], outputs: [port('value', booleanType)], effects: pure(['position']),
    lower: ctx => `(function(cell) { if (!cell) return false; var tile = ${battle(ctx)}.map && Array.isArray(${battle(ctx)}.map.tiles) ? ${battle(ctx)}.map.tiles.find(function(item) { return item && item.x === cell.x && item.y === cell.y; }) : null; return Boolean(tile && tile.props && tile.props.walkable); })(${input(ctx, 'cell')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-coordinates-safe', label: '读取可空地格坐标', description: '读取延迟选择仍可能失效的地格坐标。',
    inputs: [port('cell', cellType, { nullable: true })], outputs: [port('x', numberType), port('y', numberType)], effects: pure(),
    lower: ctx => `({x: (${input(ctx, 'cell')}) ? (${input(ctx, 'cell')}).x : 0, y: (${input(ctx, 'cell')}) ? (${input(ctx, 'cell')}).y : 0})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-require', label: '解析可空地格', description: '把已经通过合法性检查的可空地格解析为统一坐标记录。',
    inputs: [port('cell', cellType, { nullable: true })], outputs: [port('cell', cellType)], effects: pure(['position']),
    lower: ctx => `(function(cell) { return cell && Number.isInteger(cell.x) && Number.isInteger(cell.y) ? {x:cell.x, y:cell.y} : null; })(${input(ctx, 'cell')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.cell-unoccupied', label: '地格无存活棋子', description: '读取地格是否没有存活占位，可忽略一个棋子。',
    inputs: [port('cell', cellType, { nullable: true }), port('ignore', pieceType, { nullable: true, optional: true })], outputs: [port('value', booleanType)], effects: pure(['position', 'pieces']),
    lower: ctx => `(function(cell, ignore) { if (!cell) return false; return !(${battle(ctx)}.pieces || []).some(function(piece) { return piece && piece.currentHp > 0 && piece.x === cell.x && piece.y === cell.y && String(piece.instanceId) !== String(ignore || ""); }); })(${input(ctx, 'cell')}, ${input(ctx, 'ignore', 'null')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.formation-candidates', label: '编队集结点', description: '按中心及四个正交偏移计算满足编队容量的集结点。',
    inputs: [port('source', pieceType), port('selected', pieceListType)], outputs: [port('cells', cellListType)],
    parameters: [parameter('range', numberType, { default: 6, minimum: 0 })], effects: pure(['position', 'pieces']),
    lower: ctx => {
      const source = input(ctx, 'source'), selected = input(ctx, 'selected'), radius = numberLiteral(ctx, 'range', 6), state = battle(ctx)
      return `(function(sourceId, selectedIds, radius) { var source = (${state}.pieces || []).find(function(piece) { return piece && piece.instanceId === sourceId; }); if (!source) return []; var chosen = Array.isArray(selectedIds) ? selectedIds.map(String) : []; var livingAt = function(x, y) { return (${state}.pieces || []).find(function(piece) { return piece && piece.currentHp > 0 && piece.x === x && piece.y === y; }); }; var slots = function(x, y) { var offsets = [[0,0],[0,-1],[-1,0],[1,0],[0,1]]; return offsets.map(function(offset) { return {x:x + offset[0], y:y + offset[1]}; }).filter(function(cell) { var tile = (${state}.map && ${state}.map.tiles || []).find(function(item) { return item && item.x === cell.x && item.y === cell.y; }); if (!tile || !tile.props || !tile.props.walkable) return false; var occupant = livingAt(cell.x, cell.y); return !occupant || chosen.indexOf(String(occupant.instanceId)) >= 0; }); }; return ((${state}.map && ${state}.map.tiles) || []).filter(function(tile) { return tile && tile.props && tile.props.walkable && !livingAt(tile.x, tile.y) && Math.abs(tile.x - source.x) + Math.abs(tile.y - source.y) <= radius && slots(tile.x, tile.y).length >= chosen.length; }).sort(function(a, b) { return a.y - b.y || a.x - b.x; }).map(function(tile) { return {x:tile.x, y:tile.y}; }); })(${source}, ${selected}, ${radius})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.formation-slots', label: '编队落脚格', description: '按固定中心、上、左、右、下顺序返回可用编队落脚格。',
    inputs: [port('center', cellType), port('selected', pieceListType)], outputs: [port('cells', cellListType)], effects: pure(['position', 'pieces']),
    lower: ctx => {
      const center = input(ctx, 'center'), selected = input(ctx, 'selected'), state = battle(ctx)
      return `(function(center, selectedIds) { var chosen = (selectedIds || []).map(String); var offsets = [[0,0],[0,-1],[-1,0],[1,0],[0,1]]; var livingAt = function(x, y) { return (${state}.pieces || []).find(function(piece) { return piece && piece.currentHp > 0 && piece.x === x && piece.y === y; }); }; return offsets.map(function(offset) { return {x:center.x + offset[0], y:center.y + offset[1]}; }).filter(function(cell) { var tile = (${state}.map && ${state}.map.tiles || []).find(function(item) { return item && item.x === cell.x && item.y === cell.y; }); if (!tile || !tile.props || !tile.props.walkable) return false; var occupant = livingAt(cell.x, cell.y); return !occupant || chosen.indexOf(String(occupant.instanceId)) >= 0; }).slice(0, chosen.length); })(${center}, ${selected})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'movement.adventure-destinations', label: '远征移动落点', description: '沿四个正交方向追踪可经过友军的远征路径并读取合法落点。',
    inputs: [port('mover', pieceType)], outputs: [port('cells', cellListType)], effects: pure(['position', 'pieces']),
    lower: ctx => {
      const mover = input(ctx, 'mover'), query = runtime(ctx), state = battle(ctx)
      return `(function(moverId) { var mover = ${query}.query.piece(moverId); if (!mover) return []; var maxDistance = Math.min(((${state}.map && ${state}.map.width) || 0) + ((${state}.map && ${state}.map.height) || 0), Math.max(0, Math.floor((mover.moveRange || 0) + 2))); var directions = [{x:0,y:-1},{x:-1,y:0},{x:1,y:0},{x:0,y:1}]; var result = []; var seen = {}; directions.forEach(function(direction) { var trace = ${query}.query.tracePath(mover, direction, {excludePieceId:mover.instanceId, maxDistance:maxDistance, passAllies:true}); ${query}.query.landingCells(trace.cells, [mover.instanceId]).forEach(function(cell) { var key = cell.x + "," + cell.y; if (!seen[key]) { seen[key] = true; result.push({x:cell.x,y:cell.y}); } }); }); return result; })(${mover})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.nearest-adjacent-landing', label: '最近相邻落点', description: '按既有相邻偏移顺序读取距参考地格最近的合法落点。',
    inputs: [port('target', pieceType), port('reference', cellType, { nullable: true }), port('ignore', pieceType, { nullable: true, optional: true })], outputs: [port('cell', cellType, { nullable: true })],
    parameters: [parameter('diagonal', booleanType, { default: true })], effects: pure(['position', 'pieces']),
    lower: ctx => {
      const target = input(ctx, 'target'), reference = input(ctx, 'reference'), ignore = input(ctx, 'ignore', 'null'), state = battle(ctx), diagonal = booleanLiteral(ctx, 'diagonal', true)
      return `(function(targetId, reference, ignore, diagonal) { var target = (${state}.pieces || []).find(function(piece) { return piece && piece.instanceId === targetId; }); if (!target || !reference) return null; var offsets = diagonal ? [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]] : [[1,0],[-1,0],[0,1],[0,-1]]; var best = null; var bestDistance = Infinity; offsets.forEach(function(offset) { var cell = {x:target.x + offset[0], y:target.y + offset[1]}; var tile = (${state}.map && ${state}.map.tiles || []).find(function(item) { return item && item.x === cell.x && item.y === cell.y; }); if (!tile || !tile.props || !tile.props.walkable) return; var occupied = (${state}.pieces || []).some(function(piece) { return piece && piece.currentHp > 0 && piece.x === cell.x && piece.y === cell.y && String(piece.instanceId) !== String(ignore || ""); }); if (occupied) return; var distance = Math.abs(cell.x - reference.x) + Math.abs(cell.y - reference.y); if (distance < bestDistance) { bestDistance = distance; best = cell; } }); return best; })(${target}, ${reference}, ${ignore}, ${diagonal})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.random-adjacent-landing', label: '随机相邻落点', description: '按权威随机源从目标的正交合法落点中选择一格。',
    inputs: [port('target', pieceType), port('ignore', pieceType, { nullable: true, optional: true })], outputs: [port('cell', cellType, { nullable: true })], effects: { ...pure(['position', 'pieces', 'random']), random: true },
    lower: ctx => {
      const target = input(ctx, 'target'), ignore = input(ctx, 'ignore', 'null'), state = battle(ctx), query = runtime(ctx), context = host(ctx)
      return `(function(targetId, ignoreId) { var target = (${state}.pieces || []).find(function(piece) { return piece && piece.instanceId === targetId; }); if (!target) return null; var reserved = Array.isArray(${context}.reservedCells) ? ${context}.reservedCells : []; var offsets = [[1,0],[-1,0],[0,1],[0,-1]]; var cells = offsets.map(function(offset) { return {x:target.x + offset[0], y:target.y + offset[1]}; }).filter(function(cell) { var tile = (${state}.map && ${state}.map.tiles || []).find(function(item) { return item && item.x === cell.x && item.y === cell.y; }); if (!tile || !tile.props || !tile.props.walkable || reserved.some(function(reservedCell) { return reservedCell && reservedCell.x === cell.x && reservedCell.y === cell.y; })) return false; return !(${state}.pieces || []).some(function(piece) { return piece && piece.currentHp > 0 && String(piece.instanceId) !== String(ignoreId || "") && piece.x === cell.x && piece.y === cell.y; }); }); return ${query}.query.random(cells); })(${target}, ${ignore})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'movement.adventure-move', label: '远征位移', description: '按远征动作提交一名棋子的统一位移。',
    inputs: [port('mover', pieceType), port('destination', cellType, { nullable: true })], outputs: [port('success', booleanType)],
    effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => `(function(destination) { return destination ? ${runtime(ctx)}.effects.move([{pieceId:${input(ctx, 'mover')}, x:destination.x, y:destination.y}], "dash").success : false; })(${input(ctx, 'destination')})`,
    ui: { category: 'effect' },
  }),
]

const EFFECT_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'effect.displace-many', label: '批量位移', description: '把一组棋子按固定顺序提交给统一位移入口。',
    inputs: [port('pieces', pieceListType), port('destinations', cellListType)], outputs: [port('success', booleanType)],
    parameters: [parameter('kind', stringType, { enum: ['teleport', 'dash'], default: 'teleport' })], effects: writes(['position', 'events'], ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact']),
    lower: ctx => {
      const pieces = input(ctx, 'pieces'), destinations = input(ctx, 'destinations'), kind = literal(ctx, 'kind', 'teleport'), query = runtime(ctx)
      return `(function(pieces, destinations) { if (!Array.isArray(pieces) || !Array.isArray(destinations) || pieces.length !== destinations.length || pieces.length === 0) return false; var changes = pieces.map(function(pieceId, index) { return {pieceId:pieceId, x:destinations[index].x, y:destinations[index].y}; }); return Boolean(${query}.effects.displace(changes, ${kind}).success); })(${pieces}, ${destinations})`
    },
    ui: { category: 'effect' },
  }),
]

const MARKER_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'marker.anchor-cells', label: '现有锚点地格', description: '读取指定来源仍存在的空间锚点。',
    inputs: [port('source', pieceType)], outputs: [port('cells', cellListType)], parameters: [parameter('storageKey', stringType)], effects: pure(['extensions', 'position']),
    lower: ctx => `(function(sourceId, storageKey) { var records = ${battle(ctx)}.extensions && Array.isArray(${battle(ctx)}.extensions[storageKey]) ? ${battle(ctx)}.extensions[storageKey] : []; return records.filter(function(anchor) { return anchor && anchor.sourceId === sourceId; }).map(function(anchor) { return {x:anchor.x, y:anchor.y}; }).sort(function(a, b) { return a.y - b.y || a.x - b.x; }); })(${input(ctx, 'source')}, ${stringLiteral(ctx, 'storageKey')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'marker.anchor-exists', label: '锚点存在', description: '查询指定来源在指定地格是否有空间锚点。',
    inputs: [port('source', pieceType, { nullable: true }), port('cell', cellType, { nullable: true })], outputs: [port('value', booleanType)], parameters: [parameter('storageKey', stringType)], effects: pure(['extensions']),
    lower: ctx => `(function(sourceId, cell, storageKey) { return Boolean(cell) && (${battle(ctx)}.extensions && Array.isArray(${battle(ctx)}.extensions[storageKey]) ? ${battle(ctx)}.extensions[storageKey] : []).some(function(anchor) { return anchor && anchor.sourceId === sourceId && anchor.x === cell.x && anchor.y === cell.y; }); })(${input(ctx, 'source')}, ${input(ctx, 'cell')}, ${stringLiteral(ctx, 'storageKey')})`,
    ui: { category: 'position' },
  }),
  define({
    id: 'marker.anchor-candidates', label: '可标记锚点地格', description: '读取范围内、可行走且无存活占位的锚点候选。',
    inputs: [port('source', pieceType, { nullable: true })], outputs: [port('cells', cellListType)], parameters: [parameter('range', numberType, { default: 7, minimum: 0 })], effects: pure(['extensions', 'position', 'pieces']),
    lower: ctx => {
      const source = input(ctx, 'source'), state = battle(ctx), radius = numberLiteral(ctx, 'range', 7)
      return `(function(sourceId, radius) { var source = (${state}.pieces || []).find(function(piece) { return piece && piece.instanceId === sourceId; }); if (!source) return []; return ((${state}.map && ${state}.map.tiles) || []).filter(function(tile) { if (!tile || !tile.props || !tile.props.walkable || Math.abs(tile.x - source.x) + Math.abs(tile.y - source.y) > radius) return false; return !(${state}.pieces || []).some(function(piece) { return piece && piece.currentHp > 0 && piece.x === tile.x && piece.y === tile.y; }); }).sort(function(a, b) { return a.y - b.y || a.x - b.x; }).map(function(tile) { return {x:tile.x, y:tile.y}; }); })(${source}, ${radius})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'marker.anchor-place', label: '放置空间锚点', description: '写入既有空间锚点和对应地格表现，并按来源保留最近三个。',
    inputs: [port('source', pieceType, { nullable: true }), port('cell', cellType, { nullable: true })], outputs: [port('success', booleanType)], parameters: [parameter('storageKey', stringType), parameter('tileType', stringType), parameter('maxAnchors', numberType, { default: 3, minimum: 1 })],
    effects: writes(['extensions', 'tile-effects'], ['tileEffectAdded', 'tileEffectRemoved']),
    lower: ctx => {
      const source = input(ctx, 'source'), cell = input(ctx, 'cell'), state = battle(ctx), storageKey = stringLiteral(ctx, 'storageKey'), tileType = stringLiteral(ctx, 'tileType'), max = numberLiteral(ctx, 'maxAnchors', 3)
      return `(function(sourceId, cell, storageKey, tileType, maxAnchors) { var source = (${state}.pieces || []).concat(${state}.graveyard || []).find(function(piece) { return piece && piece.instanceId === sourceId; }); if (!source || !cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) return false; ${state}.extensions = ${state}.extensions || {}; var anchors = Array.isArray(${state}.extensions[storageKey]) ? ${state}.extensions[storageKey] : []; var tileEffects = Array.isArray(${state}.extensions.tileEffects) ? ${state}.extensions.tileEffects : []; var now = Date.now(); var existing = anchors.find(function(anchor) { return anchor && anchor.sourceId === sourceId && anchor.x === cell.x && anchor.y === cell.y; }); if (existing) existing.createdAt = now; else anchors.push({x:cell.x, y:cell.y, sourceId:sourceId, ownerPlayerId:source.ownerPlayerId, createdAt:now}); tileEffects = tileEffects.filter(function(effect) { return !(effect && effect.tileType === tileType && effect.sourceId === sourceId && effect.x === cell.x && effect.y === cell.y); }); tileEffects.push({x:cell.x, y:cell.y, sourceId:sourceId, tileType:tileType, icon:"⚡", bgColor:"rgba(250, 204, 21, 0.14)", boxShadow:"inset 0 0 0 2px rgba(250, 204, 21, 0.75)", iconPosition:"top-left"}); while (anchors.filter(function(anchor) { return anchor && anchor.sourceId === sourceId; }).length > maxAnchors) { var own = anchors.filter(function(anchor) { return anchor && anchor.sourceId === sourceId; }).sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }); var oldest = own[0]; anchors = anchors.filter(function(anchor) { return anchor !== oldest; }); tileEffects = tileEffects.filter(function(effect) { return !(effect && effect.tileType === tileType && effect.sourceId === sourceId && effect.x === oldest.x && effect.y === oldest.y); }); } ${state}.extensions[storageKey] = anchors; ${state}.extensions.tileEffects = tileEffects; return true; })(${source}, ${cell}, ${storageKey}, ${tileType}, ${max})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'marker.anchor-remove', label: '移除空间锚点', description: '移除指定来源和地格的锚点及其地格表现。',
    inputs: [port('source', pieceType, { nullable: true }), port('cell', cellType, { nullable: true })], outputs: [port('success', booleanType)], parameters: [parameter('storageKey', stringType), parameter('tileType', stringType)], effects: writes(['extensions', 'tile-effects'], ['tileEffectRemoved']),
    lower: ctx => {
      const source = input(ctx, 'source'), cell = input(ctx, 'cell'), state = battle(ctx)
      const storageKey = stringLiteral(ctx, 'storageKey'), tileType = stringLiteral(ctx, 'tileType')
      return `(function(sourceId, cell, storageKey, tileType) { if (!sourceId || !cell || !${state}.extensions) return true; ${state}.extensions[storageKey] = (Array.isArray(${state}.extensions[storageKey]) ? ${state}.extensions[storageKey] : []).filter(function(anchor) { return !(anchor && anchor.sourceId === sourceId && anchor.x === cell.x && anchor.y === cell.y); }); ${state}.extensions.tileEffects = (Array.isArray(${state}.extensions.tileEffects) ? ${state}.extensions.tileEffects : []).filter(function(effect) { return !(effect && effect.tileType === tileType && effect.sourceId === sourceId && effect.x === cell.x && effect.y === cell.y); }); return true; })(${source}, ${cell}, ${storageKey}, ${tileType})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'marker.nearby-enemies', label: '锚点附近敌人', description: '按锚点地格和来源棋子的敌我关系读取宿主顺序敌人集合。',
    inputs: [port('source', pieceType, { nullable: true }), port('cell', cellType, { nullable: true })], outputs: [port('pieces', pieceListType)], parameters: [parameter('range', numberType, { default: 3, minimum: 0 })], effects: pure(['pieces', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source'), cell = input(ctx, 'cell'), radius = numberLiteral(ctx, 'range', 3), state = battle(ctx)
      return `(function(sourceId, cell, radius) { if (!cell) return []; var candidates = ${runtime(ctx)}.query.pieces({originId: sourceId, relation: "enemy", includeDead: false}); return candidates.filter(function(id) { var piece = (${state}.pieces || []).find(function(item) { return item && item.instanceId === id; }); return piece && Math.abs(piece.x - cell.x) + Math.abs(piece.y - cell.y) <= radius; }); })(${source}, ${cell}, ${radius})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'marker.trigger-target', label: '飞雷神触发目标', description: '按标记者的敌我关系解析施法者或被指向目标。',
    inputs: [port('source', pieceType, { nullable: true }), port('marked', pieceType, { nullable: true }), port('origin', pieceType, { nullable: true })], outputs: [port('target', pieceType, { nullable: true })], effects: pure(['pieces', 'players']),
    lower: ctx => {
      const source = input(ctx, 'source'), marked = input(ctx, 'marked'), origin = input(ctx, 'origin'), query = runtime(ctx)
      return `(function(sourceId, markedId, originId) { if (!sourceId || !markedId || !originId) return null; var allies = ${query}.query.pieces({originId:originId, relation:"ally", includeDead:false}); var enemies = ${query}.query.pieces({originId:originId, relation:"enemy", includeDead:false}); if (allies.indexOf(markedId) >= 0) return enemies.indexOf(sourceId) >= 0 ? sourceId : null; return enemies.indexOf(markedId) >= 0 ? markedId : null; })(${source}, ${marked}, ${origin})`
    },
    ui: { category: 'query' },
  }),
]

const MARK_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'status.mark-apply', label: '应用来源标记', description: '递增已有来源标记，或经 status lifecycle 安装新的来源标记。',
    inputs: [port('target', pieceType, { nullable: true }), port('source', pieceType, { nullable: true })], outputs: [port('success', booleanType)],
    parameters: [parameter('statusType', stringType), parameter('statusName', stringType), parameter('statusIdPrefix', stringType)],
    effects: writes(['status', 'events'], ['afterStatusApplied']),
    lower: ctx => {
      const target = input(ctx, 'target'), source = input(ctx, 'source'), query = runtime(ctx), state = battle(ctx)
      const type = stringLiteral(ctx, 'statusType'), name = stringLiteral(ctx, 'statusName'), prefix = stringLiteral(ctx, 'statusIdPrefix')
      return `(function(targetId, sourceId) { var target = (${state}.pieces || []).find(function(piece) { return piece && piece.instanceId === targetId; }); if (!target || !sourceId) return false; target.statusTags = Array.isArray(target.statusTags) ? target.statusTags : []; var existing = target.statusTags.find(function(tag) { return tag && tag.type === ${type} && tag.sourceId === sourceId; }); if (existing) { existing.stacks = (existing.stacks || 1) + 1; existing.currentDuration = -1; return true; } var id = ${prefix} + "-" + sourceId + "-" + targetId + "-" + Date.now(); return Boolean(${query}.status.add(targetId, {id:id, type:${type}, name:${name}, visible:true, currentDuration:-1, currentUses:-1, intensity:1, stacks:1, sourceId:sourceId}, "piece", "host")); })(${target}, ${source})`
    },
    ui: { category: 'status' },
  }),
  define({
    id: 'status.mark-remove', label: '移除来源标记', description: '移除目标身上指定来源的标记。',
    inputs: [port('target', pieceType, { nullable: true }), port('source', pieceType, { nullable: true })], outputs: [port('success', booleanType)], parameters: [parameter('statusType', stringType)],
    effects: writes(['status'], ['afterStatusRemoved']),
    lower: ctx => {
      const target = input(ctx, 'target'), source = input(ctx, 'source'), state = battle(ctx), type = stringLiteral(ctx, 'statusType')
      return `(function(targetId, sourceId) { var target = (${state}.pieces || []).find(function(piece) { return piece && piece.instanceId === targetId; }); if (!target || !sourceId) return false; target.statusTags = (target.statusTags || []).filter(function(tag) { return !(tag && tag.type === ${type} && tag.sourceId === sourceId); }); return true; })(${target}, ${source})`
    },
    ui: { category: 'status' },
  }),
]

const TURN_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'turn.once-read', label: '回合旗标查询', description: '读取指定棋子在当前回合是否已经使用过一次性事件。',
    inputs: [port('source', pieceType), port('turn', numberType)], outputs: [port('used', booleanType)], parameters: [parameter('storageKey', stringType)], effects: pure(['extensions', 'turn']),
    lower: ctx => `(function(sourceId, turn, storageKey) { if (typeof sourceId !== "string" || !Number.isSafeInteger(turn) || typeof storageKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(storageKey)) return false; return Boolean(${battle(ctx)}.extensions && ${battle(ctx)}.extensions[storageKey] && ${battle(ctx)}.extensions[storageKey][sourceId] === turn); })(${input(ctx, 'source')}, ${input(ctx, 'turn')}, ${stringLiteral(ctx, 'storageKey')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'turn.once-mark', label: '记录回合旗标', description: '记录指定棋子在当前回合的一次性事件。',
    inputs: [port('source', pieceType), port('turn', numberType)], outputs: [port('success', booleanType)], parameters: [parameter('storageKey', stringType)], effects: writes(['extensions', 'turn']),
    lower: ctx => `(function(sourceId, turn, storageKey) { if (typeof sourceId !== "string" || !Number.isSafeInteger(turn) || typeof storageKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(storageKey)) return false; ${battle(ctx)}.extensions = ${battle(ctx)}.extensions || {}; ${battle(ctx)}.extensions[storageKey] = ${battle(ctx)}.extensions[storageKey] || {}; ${battle(ctx)}.extensions[storageKey][sourceId] = turn; return true; })(${input(ctx, 'source')}, ${input(ctx, 'turn')}, ${stringLiteral(ctx, 'storageKey')})`,
    ui: { category: 'state' },
  }),
]

export const PENDING_SPATIAL_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  ...CONTEXT_PRIMITIVES,
  ...CHOICE_PRIMITIVES,
  ...QUERY_PRIMITIVES,
  ...CELL_PRIMITIVES,
  ...EFFECT_PRIMITIVES,
  ...MARKER_PRIMITIVES,
  ...MARK_PRIMITIVES,
  ...TURN_PRIMITIVES,
])

