/**
 * The first author-facing gameplay module catalogue.
 *
 * Module definitions are deliberately boring data plus trusted host lowering.
 * A content document can name one of these descriptors and provide typed
 * literals/refs, but it cannot provide a function, an object path, or a
 * source-code fragment.  The lowerers below only call the existing flow
 * facade (or the existing rule queue writer for queued healing), so generated
 * modules remain on the current authoritative execution path.
 */

import type {
  GameplayEffectMetadata,
  GameplayJsonValue,
  GameplayLiteral,
  GameplayModuleDescriptor,
  GameplayModuleRegistry,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayNativeLoweringResult,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

export const GAMEPLAY_MODULE_VERSION = '1' as const

type Descriptor = GameplayModuleDescriptor
type Surface = GameplayModuleSurface
type Lowering = GameplayNativeLoweringContext

const ACTIVE_SURFACES: readonly Surface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const EFFECT_SURFACES: readonly Surface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const QUERY_SURFACES: readonly Surface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const PURE_SURFACES: readonly Surface[] = [...ACTIVE_SURFACES, 'preview']

const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const cellType: GameplayValueType = 'cell'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const recordType: GameplayValueType = 'record'
const choiceType: GameplayValueType = 'choice'

const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const stringListType: GameplayValueType = { kind: 'list', element: stringType }

const port = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayPort, 'name' | 'type'> = {},
): GameplayPort => ({ name, type, ...options })

const parameter = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayParameter, 'name' | 'type'> = {},
): GameplayParameter => ({ name, type, ...options })

const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({
  pure: true,
  previewSafe: true,
  reads,
})

const writes = (
  domains: readonly string[],
  extra: Omit<GameplayEffectMetadata, 'pure' | 'previewSafe' | 'writes'> = {},
): GameplayEffectMetadata => ({
  ...extra,
  pure: false,
  previewSafe: false,
  writes: domains,
})

function runtime(surface: Surface): string {
  // Pending continuation code receives `ctx`; all other SkillCode surfaces
  // expose the same facade as `flow`.  Preview never admits a native lowerer
  // that calls runtime, and is therefore rejected before this helper is used.
  return surface === 'pending' ? 'ctx.flow' : 'flow'
}

function context(surface: Surface): string {
  return surface === 'pending' ? 'ctx' : 'context'
}

function input(ctx: Lowering, name: string): string {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function literal(ctx: Lowering, name: string, fallback?: GameplayLiteral): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (value === undefined) throw new Error(`module ${ctx.moduleId}: missing parameter ${name}`)
  return ctx.emitLiteral(value)
}

function stringLiteral(ctx: Lowering, name: string, fallback?: string): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}

function enumLiteral<T extends string>(ctx: Lowering, name: string, values: readonly T[], fallback?: T): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`module ${ctx.moduleId}: parameter ${name} has an unsupported value`)
  }
  return ctx.emitLiteral(value)
}

function numberLiteral(ctx: Lowering, name: string, fallback?: number): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}

function booleanLiteral(ctx: Lowering, name: string, fallback?: boolean): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'boolean') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be boolean`)
  return ctx.emitLiteral(value)
}

function expression(expression: string): GameplayNativeLoweringResult {
  return { expression }
}

function flowCall(ctx: Lowering, member: string, args: readonly string[]): GameplayNativeLoweringResult {
  return expression(`${runtime(ctx.surface)}.${member}(${args.join(', ')})`)
}

function wrappedEffectResult(call: string, fields: readonly string[]): GameplayNativeLoweringResult {
  const entries = ['result: value', ...fields.map(field => `${field}: value.${field}`)]
  return expression(`(function(value){return {${entries.join(', ')}}})(${call})`)
}

function freezePort(value: GameplayPort): GameplayPort {
  return Object.freeze({ ...value })
}

function freezeParameter(value: GameplayParameter): GameplayParameter {
  return value.enum
    ? Object.freeze({ ...value, enum: Object.freeze([...value.enum]) })
    : Object.freeze({ ...value })
}

function freezeEffects(value: GameplayEffectMetadata): GameplayEffectMetadata {
  return Object.freeze({
    ...value,
    writes: value.writes ? Object.freeze([...value.writes]) : undefined,
    reads: value.reads ? Object.freeze([...value.reads]) : undefined,
    events: value.events ? Object.freeze([...value.events]) : undefined,
  })
}

function descriptor(
  value: Omit<Descriptor, 'version'> & { version?: string },
): Descriptor {
  return Object.freeze({
    version: value.version ?? GAMEPLAY_MODULE_VERSION,
    ...value,
    inputs: Object.freeze(value.inputs.map(freezePort)),
    outputs: Object.freeze(value.outputs.map(freezePort)),
    parameters: value.parameters ? Object.freeze(value.parameters.map(freezeParameter)) : undefined,
    inspectReferences: value.inspectReferences ? Object.freeze([...value.inspectReferences]) : undefined,
    allowedSurfaces: Object.freeze([...value.allowedSurfaces]),
    effects: freezeEffects(value.effects),
    ui: value.ui ? Object.freeze({ ...value.ui }) : undefined,
  })
}

const allRefs: readonly Descriptor[] = [
  descriptor({
    id: 'ref.holder', label: '持有者', description: '读取当前技能或规则的持有棋子引用。',
    inputs: [], outputs: [port('piece', pieceType, { label: '棋子引用', nullable: true })],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['context']),
    lower: ctx => expression(`${runtime(ctx.surface)}.refs.holder()`),
    ui: { category: 'context' },
  }),
  descriptor({
    id: 'ref.source', label: '来源棋子', description: '读取当前事件或效果的来源棋子引用。',
    inputs: [], outputs: [port('piece', pieceType, { label: '棋子引用', nullable: true })],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['context']),
    lower: ctx => expression(`${runtime(ctx.surface)}.refs.source()`),
    ui: { category: 'context' },
  }),
  descriptor({
    id: 'ref.target', label: '当前目标', description: '读取当前事件或选择流程的目标棋子引用。',
    inputs: [], outputs: [port('piece', pieceType, { label: '棋子引用', nullable: true })],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['context']),
    lower: ctx => expression(`${runtime(ctx.surface)}.refs.target()`),
    ui: { category: 'context' },
  }),
  descriptor({
    id: 'ref.player', label: '所属玩家', description: '读取持有者或当前内容所属玩家的不可变玩家 ID。',
    inputs: [], outputs: [port('player', playerType, { label: '玩家引用', nullable: true })],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['context']),
    lower: ctx => expression(`${runtime(ctx.surface)}.refs.player()`),
    ui: { category: 'context' },
  }),
  descriptor({
    id: 'ref.event-player', label: '事件玩家', description: '读取触发当前事件的玩家引用。',
    inputs: [], outputs: [port('player', playerType, { label: '玩家引用', nullable: true })],
    allowedSurfaces: ['rule', 'triggerSkill', 'pending'], effects: pure(['event']),
    lower: ctx => expression(`${runtime(ctx.surface)}.refs.eventPlayer()`),
    ui: { category: 'context' },
  }),
]

const queries: readonly Descriptor[] = [
  descriptor({
    id: 'query.piece', label: '验证棋子引用', description: '按不透明棋子 ID 验证并返回同一个不透明引用。',
    inputs: [port('pieceId', pieceType, { nullable: true, description: '可空棋子 ID；为空时由权威查询拒绝' })], outputs: [port('piece', pieceType)],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['pieces']),
    lower: ctx => {
      const pieceId = input(ctx, 'pieceId')
      return expression(`${runtime(ctx.surface)}.query.hasPiece(${pieceId}) ? ${runtime(ctx.surface)}.query.piece(${pieceId}).instanceId : null`)
    },
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'query.player', label: '验证玩家引用', description: '按不透明玩家 ID 验证并返回同一个不透明引用。',
    inputs: [port('playerId', playerType, { nullable: true, description: '可空玩家 ID；为空时由权威查询拒绝' })], outputs: [port('player', playerType)],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['players']),
    lower: ctx => {
      const playerId = input(ctx, 'playerId')
      return expression(`${runtime(ctx.surface)}.query.hasPlayer(${playerId}) ? ${runtime(ctx.surface)}.query.player(${playerId}).playerId : null`)
    },
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'query.has-piece', label: '判断棋子是否存在', description: '查询不透明棋子 ID 是否仍由权威战斗状态持有。',
    inputs: [port('pieceId', pieceType, { nullable: true })], outputs: [port('exists', booleanType)],
    inspectReferences: ['pieceId'],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['pieces']),
    lower: ctx => flowCall(ctx, 'query.hasPiece', [input(ctx, 'pieceId')]),
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'query.has-player', label: '判断玩家是否存在', description: '查询不透明玩家 ID 是否仍由权威战斗状态持有。',
    inputs: [port('playerId', playerType, { nullable: true })], outputs: [port('exists', booleanType)],
    inspectReferences: ['playerId'],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['players']),
    lower: ctx => flowCall(ctx, 'query.hasPlayer', [input(ctx, 'playerId')]),
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'query.pieces', label: '查询棋子集合', description: '按所属玩家、敌我关系、来源范围和存活条件查询有序棋子 ID 集合。',
    inputs: [
      port('originId', pieceType, { optional: true, nullable: true }),
      port('ownerId', playerType, { optional: true, nullable: true }),
    ],
    outputs: [port('pieces', pieceListType)],
    parameters: [
      parameter('relation', stringType, { enum: ['ally', 'enemy', 'all'], default: 'all' }),
      parameter('range', numberType, { optional: true, minimum: 0 }),
      parameter('includeDead', booleanType, { default: false }),
    ],
    allowedSurfaces: QUERY_SURFACES,
    effects: pure(['pieces', 'players', 'position']),
    lower: ctx => {
      const relation = enumLiteral(ctx, 'relation', ['ally', 'enemy', 'all'] as const, 'all')
      const range = Object.prototype.hasOwnProperty.call(ctx.parameters, 'range') ? numberLiteral(ctx, 'range') : 'undefined'
      const includeDead = booleanLiteral(ctx, 'includeDead', false)
      const options = [
        `originId: ${ctx.inputs.originId ?? 'undefined'}`,
        `ownerId: ${ctx.inputs.ownerId ?? 'undefined'}`,
        `relation: ${relation === '"all"' ? 'undefined' : relation}`,
        `range: ${range}`,
        `includeDead: ${includeDead}`,
      ]
      return expression(`${runtime(ctx.surface)}.query.pieces({${options.join(', ')}})`)
    },
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'query.distance', label: '棋子距离', description: '读取两个棋子之间的曼哈顿距离。',
    inputs: [port('from', pieceType), port('to', pieceType)], outputs: [port('distance', numberType)],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['pieces', 'position']),
    lower: ctx => flowCall(ctx, 'query.distance', [input(ctx, 'from'), input(ctx, 'to')]),
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'attribute.read', label: '读取棋子属性', description: '读取登记过的棋子属性；属性名是封闭枚举。',
    inputs: [port('piece', pieceType)], outputs: [port('value', numberType)],
    parameters: [parameter('attribute', stringType, {
      enum: ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp', 'x', 'y'],
    })],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['pieces']),
    lower: ctx => {
      const attr = Object.prototype.hasOwnProperty.call(ctx.parameters, 'attribute')
        ? ctx.parameters.attribute
        : undefined
      const allowed = new Set(['attack', 'defense', 'moveRange', 'currentHp', 'maxHp', 'x', 'y'])
      if (typeof attr !== 'string' || !allowed.has(attr)) throw new Error(`module ${ctx.moduleId}: invalid attribute`)
      return expression(`${runtime(ctx.surface)}.query.piece(${input(ctx, 'piece')})[${ctx.emitLiteral(attr)}]`)
    },
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'attribute.text', label: '读取棋子文本属性', description: '读取登记过的棋子文本属性；属性名是封闭枚举。',
    inputs: [port('piece', pieceType)], outputs: [port('text', stringType)],
    parameters: [parameter('attribute', stringType, { enum: ['name'] })],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['pieces']),
    lower: ctx => {
      const attr = enumLiteral(ctx, 'attribute', ['name'] as const)
      return expression(`String(${runtime(ctx.surface)}.query.piece(${input(ctx, 'piece')})[${attr}])`)
    },
    ui: { category: 'query' },
  }),
  descriptor({
    id: 'resource.read', label: '读取玩家资源', description: '读取登记过的行动点或充能点。',
    inputs: [port('player', playerType)], outputs: [port('value', numberType)],
    parameters: [parameter('resource', stringType, { enum: ['actionPoints', 'chargePoints'] })],
    allowedSurfaces: QUERY_SURFACES, effects: pure(['players', 'resources']),
    lower: ctx => {
      const resource = enumLiteral(ctx, 'resource', ['actionPoints', 'chargePoints'] as const)
      return expression(`${runtime(ctx.surface)}.query.player(${input(ctx, 'player')})[${resource}]`)
    },
    ui: { category: 'query' },
  }),
]

type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '**' | '===' | '!==' | '<' | '<=' | '>' | '>=' | '&&' | '||'

function binaryDescriptor(
  id: string,
  label: string,
  operator: BinaryOperator,
  inputType: GameplayValueType,
  outputType: GameplayValueType,
): Descriptor {
  return descriptor({
    id, label, description: `按固定顺序执行 ${operator} 运算。`,
    inputs: [port('left', inputType), port('right', inputType)], outputs: [port('value', outputType)],
    allowedSurfaces: PURE_SURFACES, effects: pure(),
    lower: ctx => expression(`(${input(ctx, 'left')} ${operator} ${input(ctx, 'right')})`),
    ui: { category: operator === '&&' || operator === '||' ? 'logic' : 'math' },
  })
}

const arithmetic: readonly Descriptor[] = [
  binaryDescriptor('math.add', '加法', '+', numberType, numberType),
  binaryDescriptor('math.subtract', '减法', '-', numberType, numberType),
  binaryDescriptor('math.multiply', '乘法', '*', numberType, numberType),
  binaryDescriptor('math.divide', '除法', '/', numberType, numberType),
  binaryDescriptor('math.modulo', '取余', '%', numberType, numberType),
  binaryDescriptor('math.power', '乘方', '**', numberType, numberType),
  binaryDescriptor('compare.equal', '数值相等', '===', numberType, booleanType),
  binaryDescriptor('compare.not-equal', '数值不相等', '!==', numberType, booleanType),
  binaryDescriptor('compare.equal-string', '文本相等', '===', stringType, booleanType),
  binaryDescriptor('compare.not-equal-string', '文本不相等', '!==', stringType, booleanType),
  binaryDescriptor('compare.equal-boolean', '布尔相等', '===', booleanType, booleanType),
  binaryDescriptor('compare.not-equal-boolean', '布尔不相等', '!==', booleanType, booleanType),
  binaryDescriptor('compare.equal-piece', '棋子相等', '===', pieceType, booleanType),
  binaryDescriptor('compare.not-equal-piece', '棋子不相等', '!==', pieceType, booleanType),
  binaryDescriptor('compare.equal-player', '玩家相等', '===', playerType, booleanType),
  binaryDescriptor('compare.not-equal-player', '玩家不相等', '!==', playerType, booleanType),
  binaryDescriptor('compare.less-than', '小于', '<', numberType, booleanType),
  binaryDescriptor('compare.less-or-equal', '小于等于', '<=', numberType, booleanType),
  binaryDescriptor('compare.greater-than', '大于', '>', numberType, booleanType),
  binaryDescriptor('compare.greater-or-equal', '大于等于', '>=', numberType, booleanType),
  binaryDescriptor('logic.and', '并且', '&&', booleanType, booleanType),
  binaryDescriptor('logic.or', '或者', '||', booleanType, booleanType),
]

const unary: readonly Descriptor[] = [
  descriptor({
    id: 'math.floor', label: '向下取整', description: '向负无穷取整。',
    inputs: [port('value', numberType)], outputs: [port('value', numberType)],
    allowedSurfaces: PURE_SURFACES, effects: pure(),
    lower: ctx => expression(`Math.floor(${input(ctx, 'value')})`), ui: { category: 'math' },
  }),
  descriptor({
    id: 'math.abs', label: '绝对值', description: '读取数值绝对值。',
    inputs: [port('value', numberType)], outputs: [port('value', numberType)],
    allowedSurfaces: PURE_SURFACES, effects: pure(),
    lower: ctx => expression(`Math.abs(${input(ctx, 'value')})`), ui: { category: 'math' },
  }),
  descriptor({
    id: 'logic.not', label: '非', description: '对布尔值取反。',
    inputs: [port('value', booleanType)], outputs: [port('value', booleanType)],
    allowedSurfaces: PURE_SURFACES, effects: pure(),
    lower: ctx => expression(`!(${input(ctx, 'value')})`), ui: { category: 'logic' },
  }),
  descriptor({
    id: 'text.concat', label: '拼接文本', description: '按输入顺序拼接两个文本值。',
    inputs: [port('left', stringType), port('right', stringType)], outputs: [port('text', stringType)],
    allowedSurfaces: PURE_SURFACES, effects: pure(),
    lower: ctx => expression(`(${input(ctx, 'left')} + ${input(ctx, 'right')})`), ui: { category: 'text' },
  }),
  descriptor({
    id: 'text.from-number', label: '数字转文本', description: '按宿主 JavaScript 数值文本规则返回字符串。',
    inputs: [port('value', numberType)], outputs: [port('text', stringType)],
    allowedSurfaces: PURE_SURFACES, effects: pure(),
    lower: ctx => expression(`String(${input(ctx, 'value')})`), ui: { category: 'text' },
  }),
  descriptor({
    id: 'value.number-or-zero', label: '数值下限为零', description: '将可空数值缺省为零，并归一为不小于零的数值。',
    inputs: [port('value', numberType, { nullable: true })], outputs: [port('value', numberType)],
    allowedSurfaces: PURE_SURFACES, effects: pure(),
    lower: ctx => expression(`Math.max(0, ${input(ctx, 'value')} ?? 0)`), ui: { category: 'math' },
  }),
]

const choices: readonly Descriptor[] = [
  descriptor({
    id: 'choice.target-piece', label: '选择棋子目标',
    description: '使用现有 selectTarget 协议选择一名棋子；挂起、取消和候选校验由权威宿主处理。',
    inputs: [], outputs: [port('choice', choiceType)],
    parameters: [
      parameter('range', numberType, { default: 5, minimum: 0 }),
      parameter('filter', stringType, { enum: ['enemy', 'ally', 'all'], default: 'enemy' }),
      parameter('title', stringType, { default: '请选择目标' }),
      parameter('canCancel', booleanType, { default: true }),
    ],
    allowedSurfaces: ['skill', 'card', 'pending'], effects: writes(['pending'], { pending: true }),
    lower: ctx => {
      const range = numberLiteral(ctx, 'range', 5)
      const filter = enumLiteral(ctx, 'filter', ['enemy', 'ally', 'all'] as const, 'enemy')
      const title = stringLiteral(ctx, 'title', '请选择目标')
      const canCancel = booleanLiteral(ctx, 'canCancel', true)
      // `type: "piece"`, `filter`, `range`, and the needsTargetSelection
      // result are intentionally kept in the generated shape.  Existing
      // targeting readers use this exact static form for previews and AI.
      if (ctx.surface === 'pending') return expression(`ctx.flow.choice.target({type: "piece", range: ${range}, filter: ${filter}, title: ${title}, canCancel: ${canCancel}})`)
      // Keep the legacy helper spelling on active surfaces.  The targeting
      // static analyzer recognizes this exact call and the host supplies the
      // needsTargetSelection descriptor when the action must suspend.
      return expression(`selectTarget({type: "piece", range: ${range}, filter: ${filter}, title: ${title}, canCancel: ${canCancel}})`)
    },
    ui: { category: 'choice' },
  }),
  descriptor({
    id: 'choice.target-cell', label: '选择地格目标',
    description: '使用现有 grid 目标协议选择一块地格；挂起、取消和候选校验由权威宿主处理。',
    inputs: [], outputs: [port('choice', choiceType)],
    parameters: [
      parameter('range', numberType, { default: 5, minimum: 0 }),
      parameter('filter', stringType, { enum: ['enemy', 'ally', 'all'], default: 'all' }),
      parameter('title', stringType, { default: '请选择地格' }),
      parameter('canCancel', booleanType, { default: true }),
    ],
    allowedSurfaces: ['skill', 'card', 'pending'], effects: writes(['pending'], { pending: true }),
    lower: ctx => {
      const range = numberLiteral(ctx, 'range', 5)
      const filter = enumLiteral(ctx, 'filter', ['enemy', 'ally', 'all'] as const, 'all')
      const title = stringLiteral(ctx, 'title', '请选择地格')
      const canCancel = booleanLiteral(ctx, 'canCancel', true)
      if (ctx.surface === 'pending') return expression(`ctx.flow.choice.target({type: "grid", range: ${range}, filter: ${filter}, title: ${title}, canCancel: ${canCancel}})`)
      return expression(`selectTarget({type: "grid", range: ${range}, filter: ${filter}, title: ${title}, canCancel: ${canCancel}})`)
    },
    ui: { category: 'choice' },
  }),
  descriptor({
    id: 'choice.is-pending', label: '检查选择是否挂起', description: '读取权威目标选择返回值中的挂起标记，供显式分支处理等待。',
    inputs: [port('choice', choiceType)], outputs: [port('pending', booleanType)],
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'], effects: pure(),
    lower: ctx => expression(`Boolean(${input(ctx, 'choice')} && ${input(ctx, 'choice')}.needsTargetSelection)`),
    ui: { category: 'choice' },
  }),
  descriptor({
    id: 'choice.piece', label: '读取已选棋子', description: '将已完成的棋子选择解析为不透明棋子 ID；挂起值应先由 choice.is-pending 分支拦截。',
    inputs: [port('choice', choiceType)], outputs: [port('piece', pieceType)],
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'], effects: pure(['pieces']),
    lower: ctx => {
      const choice = input(ctx, 'choice')
      const id = `(${choice} && ${choice}.instanceId)`
      return expression(`(${runtime(ctx.surface)}.query.hasPiece(${id}) ? ${runtime(ctx.surface)}.query.piece(${id}).instanceId : null)`)
    },
    ui: { category: 'choice' },
  }),
  descriptor({
    id: 'choice.cell', label: '读取已选地格', description: '将已完成的地格选择解析为受信地格记录；挂起值应先由 choice.is-pending 分支拦截。',
    inputs: [port('choice', choiceType)], outputs: [port('cell', cellType)],
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'], effects: pure(),
    lower: ctx => expression(`({x: (${input(ctx, 'choice')}).x, y: (${input(ctx, 'choice')}).y})`),
    ui: { category: 'choice' },
  }),
]

const effects: readonly Descriptor[] = [
  descriptor({
    id: 'effect.damage', label: '造成伤害', description: '通过现有 DamageBatch/queue 入口造成伤害并返回权威结果。',
    inputs: [port('source', pieceType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('result', recordType), port('success', booleanType), port('damage', numberType)],
    // Author content has one ordinary damage kind.  The legacy host still
    // receives its frozen `physical` spelling through this trusted adapter;
    // authors do not choose the obsolete physical/magical split.
    parameters: [parameter('damageType', stringType, { enum: ['normal', 'true', 'toxin'], default: 'normal' }), parameter('skillId', stringType, { optional: true })],
    allowedSurfaces: EFFECT_SURFACES, effects: writes(['damage', 'events'], { events: ['beforeDamageDealt', 'afterDamageDealt'] }),
    lower: ctx => {
      const kind = enumLiteral(ctx, 'damageType', ['normal', 'true', 'toxin'] as const, 'normal')
      const engineKind = kind === '"normal"' ? '"physical"' : kind
      const id = Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId') ? stringLiteral(ctx, 'skillId') : `${context(ctx.surface)}.skill?.id || ${context(ctx.surface)}.ruleId || "flow"`
      const call = `${runtime(ctx.surface)}.effects.damage(${input(ctx, 'source')}, ${input(ctx, 'target')}, ${input(ctx, 'amount')}, ${engineKind}, ${id})`
      return wrappedEffectResult(call, ['success', 'damage'])
    },
    ui: { category: 'effect' },
  }),
  descriptor({
    id: 'effect.heal', label: '治疗', description: '通过现有 HealBatch/queue 入口治疗并返回权威结果。',
    inputs: [port('source', pieceType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('result', recordType), port('success', booleanType), port('heal', numberType)],
    parameters: [parameter('skillId', stringType, { optional: true })],
    allowedSurfaces: EFFECT_SURFACES, effects: writes(['heal', 'events'], { events: ['beforeHealDealt', 'afterHealDealt'] }),
    lower: ctx => {
      const id = Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId') ? stringLiteral(ctx, 'skillId') : `${context(ctx.surface)}.skill?.id || ${context(ctx.surface)}.ruleId || "flow"`
      return wrappedEffectResult(`${runtime(ctx.surface)}.effects.heal(${input(ctx, 'source')}, ${input(ctx, 'target')}, ${input(ctx, 'amount')}, ${id})`, ['success', 'heal'])
    },
    ui: { category: 'effect' },
  }),
  descriptor({
    id: 'effect.queue-heal', label: '排队治疗', description: '在规则事件的获准 healQueue 中加入一个治疗请求；不提前改变 HP。',
    inputs: [port('healer', pieceType), port('target', pieceType), port('amount', numberType)],
    outputs: [port('queued', numberType)],
    parameters: [parameter('skillId', stringType, { optional: true })],
    allowedSurfaces: ['rule'], effects: writes(['heal', 'queue'], { events: ['afterHealDealt'] }),
    lower: ctx => {
      const id = Object.prototype.hasOwnProperty.call(ctx.parameters, 'skillId') ? stringLiteral(ctx, 'skillId') : 'context.skillId || context.ruleId || "flow"'
      const host = runtime(ctx.surface)
      return expression(`context.healQueue.push({healer: ${host}.query.piece(${input(ctx, 'healer')}), target: ${host}.query.piece(${input(ctx, 'target')}), heal: ${input(ctx, 'amount')}, skillId: ${id}})`)
    },
    ui: { category: 'effect' },
  }),
  descriptor({
    id: 'effect.teleport', label: '权威位移', description: '通过统一位置提交器传送一名棋子到地格。',
    inputs: [port('piece', pieceType), port('destination', cellType)],
    outputs: [port('result', recordType), port('success', booleanType)],
    parameters: [parameter('kind', stringType, { enum: ['teleport', 'dash', 'walk', 'push', 'pull', 'swap'], default: 'teleport' })],
    allowedSurfaces: EFFECT_SURFACES, effects: writes(['position', 'events'], { events: ['beforePiecePositionChange', 'afterPiecePositionChange', 'afterPiecePathContact'] }),
    lower: ctx => {
      const kind = enumLiteral(ctx, 'kind', ['teleport', 'dash', 'walk', 'push', 'pull', 'swap'] as const, 'teleport')
      const destination = input(ctx, 'destination')
      return wrappedEffectResult(`${runtime(ctx.surface)}.effects.move([{pieceId: ${input(ctx, 'piece')}, x: (${destination}).x, y: (${destination}).y}], ${kind})`, ['success'])
    },
    ui: { category: 'effect' },
  }),
  descriptor({
    id: 'resource.adjust', label: '调整资源', description: '通过资源边界校验调整行动点或充能点。',
    inputs: [port('player', playerType), port('amount', numberType)], outputs: [port('value', numberType)],
    parameters: [parameter('resource', stringType, { enum: ['actionPoints', 'chargePoints'] })],
    allowedSurfaces: EFFECT_SURFACES, effects: writes(['resources'], { events: ['resourceChanged'] }),
    lower: ctx => flowCall(ctx, 'resources.add', [input(ctx, 'player'), enumLiteral(ctx, 'resource', ['actionPoints', 'chargePoints'] as const), input(ctx, 'amount')]),
    ui: { category: 'effect' },
  }),
  descriptor({
    id: 'card.hand-add', label: '加入手牌', description: '沿用卡牌实例化、容量和事件处理加入指定玩家手牌。',
    inputs: [port('player', playerType)], outputs: [port('success', booleanType)],
    parameters: [parameter('cardId', stringType)],
    allowedSurfaces: EFFECT_SURFACES, effects: writes(['hand', 'events'], { events: ['cardAdded'] }),
    lower: ctx => flowCall(ctx, 'cards.add', [input(ctx, 'player'), stringLiteral(ctx, 'cardId')]),
    ui: { category: 'card' },
  }),
]

const statusAndRules: readonly Descriptor[] = [
  descriptor({
    id: 'status.apply-piece', label: '附加棋子状态', description: '按固定字段构造状态，并经现有 status lifecycle 安装关联规则。',
    inputs: [port('target', pieceType)], outputs: [port('success', booleanType)],
    parameters: [
      parameter('statusId', stringType), parameter('statusType', stringType),
      parameter('duration', numberType, { default: -1 }), parameter('uses', numberType, { default: -1 }),
      parameter('intensity', numberType, { default: 1 }), parameter('stacks', numberType, { default: 1 }),
      parameter('maxStacks', numberType, { optional: true }), parameter('visible', booleanType, { default: true }),
      parameter('relatedRules', stringListType, { default: [] }),
    ],
    allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['status', 'rule', 'events'], { events: ['afterStatusApplied'] }),
    lower: ctx => {
      const rules = literal(ctx, 'relatedRules', [])
      const maxStacks = Object.prototype.hasOwnProperty.call(ctx.parameters, 'maxStacks') ? `, maxStacks: ${numberLiteral(ctx, 'maxStacks')}` : ''
      const object = `{id: ${stringLiteral(ctx, 'statusId')}, type: ${stringLiteral(ctx, 'statusType')}, currentDuration: ${numberLiteral(ctx, 'duration', -1)}, remainingDuration: ${numberLiteral(ctx, 'duration', -1)}, currentUses: ${numberLiteral(ctx, 'uses', -1)}, remainingUses: ${numberLiteral(ctx, 'uses', -1)}, intensity: ${numberLiteral(ctx, 'intensity', 1)}, stacks: ${numberLiteral(ctx, 'stacks', 1)}${maxStacks}, visible: ${booleanLiteral(ctx, 'visible', true)}, relatedRules: ${rules}}`
      return expression(`${runtime(ctx.surface)}.status.add(${input(ctx, 'target')}, ${object}, 'piece')`)
    },
    ui: { category: 'status' },
  }),
  descriptor({
    id: 'status.apply-player', label: '附加玩家状态', description: '按固定字段构造玩家状态，并经现有 status lifecycle 安装关联规则。',
    inputs: [port('target', playerType)], outputs: [port('success', booleanType)],
    parameters: [
      parameter('statusId', stringType), parameter('statusType', stringType),
      parameter('duration', numberType, { default: -1 }), parameter('uses', numberType, { default: -1 }),
      parameter('intensity', numberType, { default: 1 }), parameter('stacks', numberType, { default: 1 }),
      parameter('maxStacks', numberType, { optional: true }), parameter('visible', booleanType, { default: true }),
      parameter('relatedRules', stringListType, { default: [] }),
    ],
    allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['status', 'rule', 'events'], { events: ['afterStatusApplied'] }),
    lower: ctx => {
      const rules = literal(ctx, 'relatedRules', [])
      const maxStacks = Object.prototype.hasOwnProperty.call(ctx.parameters, 'maxStacks') ? `, maxStacks: ${numberLiteral(ctx, 'maxStacks')}` : ''
      const object = `{id: ${stringLiteral(ctx, 'statusId')}, type: ${stringLiteral(ctx, 'statusType')}, currentDuration: ${numberLiteral(ctx, 'duration', -1)}, remainingDuration: ${numberLiteral(ctx, 'duration', -1)}, currentUses: ${numberLiteral(ctx, 'uses', -1)}, remainingUses: ${numberLiteral(ctx, 'uses', -1)}, intensity: ${numberLiteral(ctx, 'intensity', 1)}, stacks: ${numberLiteral(ctx, 'stacks', 1)}${maxStacks}, visible: ${booleanLiteral(ctx, 'visible', true)}, relatedRules: ${rules}}`
      return expression(`${runtime(ctx.surface)}.status.add(${input(ctx, 'target')}, ${object}, 'player')`)
    },
    ui: { category: 'status' },
  }),
  descriptor({
    id: 'status.remove-piece', label: '移除棋子状态', description: '通过现有 status lifecycle 移除棋子状态。',
    inputs: [port('target', pieceType)], outputs: [port('success', booleanType)],
    parameters: [parameter('statusId', stringType)], allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['status', 'rule', 'events'], { events: ['afterStatusRemoved'] }),
    lower: ctx => flowCall(ctx, 'status.remove', [input(ctx, 'target'), stringLiteral(ctx, 'statusId'), '"piece"']),
    ui: { category: 'status' },
  }),
  descriptor({
    id: 'status.remove-player', label: '移除玩家状态', description: '通过现有 status lifecycle 移除玩家状态。',
    inputs: [port('target', playerType)], outputs: [port('success', booleanType)],
    parameters: [parameter('statusId', stringType)], allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['status', 'rule', 'events'], { events: ['afterStatusRemoved'] }),
    lower: ctx => flowCall(ctx, 'status.remove', [input(ctx, 'target'), stringLiteral(ctx, 'statusId'), '"player"']),
    ui: { category: 'status' },
  }),
  descriptor({
    id: 'rule.apply-piece', label: '附加棋子规则', description: '通过规则宿主安装已登记规则定义。',
    inputs: [port('target', pieceType)], outputs: [port('success', booleanType)],
    parameters: [parameter('ruleId', stringType)], allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['rule', 'events'], { events: ['ruleAdded'] }),
    lower: ctx => flowCall(ctx, 'rules.add', [input(ctx, 'target'), stringLiteral(ctx, 'ruleId'), '"piece"']),
    ui: { category: 'rule' },
  }),
  descriptor({
    id: 'rule.apply-player', label: '附加玩家规则', description: '通过规则宿主安装已登记玩家规则定义。',
    inputs: [port('target', playerType)], outputs: [port('success', booleanType)],
    parameters: [parameter('ruleId', stringType)], allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['rule', 'events'], { events: ['ruleAdded'] }),
    lower: ctx => flowCall(ctx, 'rules.add', [input(ctx, 'target'), stringLiteral(ctx, 'ruleId'), '"player"']),
    ui: { category: 'rule' },
  }),
  descriptor({
    id: 'rule.remove-piece', label: '移除棋子规则', description: '通过规则宿主移除已登记棋子规则。',
    inputs: [port('target', pieceType)], outputs: [port('success', booleanType)],
    parameters: [parameter('ruleId', stringType)], allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['rule', 'events'], { events: ['ruleRemoved'] }),
    lower: ctx => flowCall(ctx, 'rules.remove', [input(ctx, 'target'), stringLiteral(ctx, 'ruleId'), '"piece"']),
    ui: { category: 'rule' },
  }),
  descriptor({
    id: 'rule.remove-player', label: '移除玩家规则', description: '通过规则宿主移除已登记玩家规则。',
    inputs: [port('target', playerType)], outputs: [port('success', booleanType)],
    parameters: [parameter('ruleId', stringType)], allowedSurfaces: EFFECT_SURFACES,
    effects: writes(['rule', 'events'], { events: ['ruleRemoved'] }),
    lower: ctx => flowCall(ctx, 'rules.remove', [input(ctx, 'target'), stringLiteral(ctx, 'ruleId'), '"player"']),
    ui: { category: 'rule' },
  }),
]

const eventFacts: readonly Descriptor[] = [
  descriptor({
    id: 'event.read', label: '读取事件事实', description: '读取由宿主白名单化的不可变事件事实记录。',
    inputs: [], outputs: [port('event', recordType)], allowedSurfaces: ['rule', 'triggerSkill', 'pending'],
    effects: pure(['event']), lower: ctx => flowCall(ctx, 'event.read', []), ui: { category: 'event' },
  }),
  ...([
    ['event.type', '事件类型', 'type', stringType],
    ['event.player', '事件玩家 ID', 'playerId', playerType],
    ['event.damage', '事件伤害', 'damage', numberType],
    ['event.actual-damage', '实际伤害', 'actualDamage', numberType],
    ['event.heal', '事件治疗', 'heal', numberType],
    ['event.amount', '事件数量', 'amount', numberType],
    ['event.turn-number', '事件回合', 'turnNumber', numberType],
    ['event.target-x', '目标 X', 'targetX', numberType],
    ['event.target-y', '目标 Y', 'targetY', numberType],
    ['event.movement-kind', '位移类型', 'movementKind', stringType],
    ['event.from-x', '起点 X', 'fromX', numberType],
    ['event.from-y', '起点 Y', 'fromY', numberType],
  ] as const).map(([id, label, field, type]) => descriptor({
    id, label, description: `读取事件事实 ${field}；事件不存在该字段时返回空值。`,
    inputs: [], outputs: [port('value', type, { nullable: true })],
    allowedSurfaces: ['rule', 'triggerSkill', 'pending'], effects: pure(['event']),
    lower: ctx => expression(`(${runtime(ctx.surface)}.event.read())[${ctx.emitLiteral(field)}]`),
    ui: { category: 'event' },
  })),
]

const results: readonly Descriptor[] = [
  descriptor({
    id: 'result.message', label: '返回消息', description: '构造原有 success/message 结果，不引入可执行字段。',
    inputs: [port('message', stringType)], outputs: [port('success', booleanType), port('message', stringType)],
    parameters: [parameter('success', booleanType, { default: true })], allowedSurfaces: PURE_SURFACES,
    effects: { ...pure(), description: '返回结果，不改变战斗状态' },
    lower: ctx => expression(`{success: ${booleanLiteral(ctx, 'success', true)}, message: ${input(ctx, 'message')}}`),
    ui: { category: 'result' },
  }),
  descriptor({
    id: 'result.text', label: '返回文本', description: '返回一个类型明确的文本结果。',
    inputs: [port('text', stringType)], outputs: [port('text', stringType)],
    allowedSurfaces: PURE_SURFACES, effects: { ...pure(), description: '返回文本，不改变战斗状态' },
    lower: ctx => expression(input(ctx, 'text')),
    ui: { category: 'result' },
  }),
  descriptor({
    id: 'result.structured', label: '返回结构化结果', description: '构造固定 success/message/value 结果；value 必须是已类型化记录。',
    inputs: [port('success', booleanType), port('message', stringType), port('value', recordType)],
    outputs: [port('success', booleanType), port('message', stringType), port('value', recordType)],
    allowedSurfaces: PURE_SURFACES, effects: { ...pure(), description: '返回结构化结果，不改变战斗状态' },
    lower: ctx => expression(`{success: ${input(ctx, 'success')}, message: ${input(ctx, 'message')}, value: ${input(ctx, 'value')}}`),
    ui: { category: 'result' },
  }),
  descriptor({
    id: 'result.value', label: '返回结构化值', description: '将已类型化的值作为结果字段返回；不接受作者对象或源码。',
    inputs: [port('value', recordType)], outputs: [port('value', recordType)],
    allowedSurfaces: PURE_SURFACES, effects: { ...pure(), description: '返回类型化值，不改变战斗状态' },
    lower: ctx => expression(`{success: true, value: ${input(ctx, 'value')}}`),
    ui: { category: 'result' },
  }),
]

const ALL_DESCRIPTORS: readonly Descriptor[] = [
  ...allRefs,
  ...queries,
  ...arithmetic,
  ...unary,
  ...choices,
  ...effects,
  ...statusAndRules,
  ...eventFacts,
  ...results,
]

const descriptorById = new Map<string, Descriptor>()
for (const item of ALL_DESCRIPTORS) {
  if (descriptorById.has(item.id)) throw new Error(`duplicate gameplay module id: ${item.id}`)
  descriptorById.set(item.id, item)
}

/**
 * Trusted registry used by the semantic compiler.  Direct ID properties are
 * useful to editor integrations, while get/resolve/descriptors satisfy the
 * structural registry contract without forcing consumers to know this shape.
 */
export type GameplayModuleCatalog = Readonly<Record<string, Descriptor>> & {
  readonly descriptors: readonly Descriptor[]
  readonly get: (id: string, version?: string) => Descriptor | undefined
  readonly resolve: (id: string, version?: string) => Descriptor | undefined
} & GameplayModuleRegistry

const directEntries = Object.fromEntries(ALL_DESCRIPTORS.map(item => [item.id, item])) as Record<string, Descriptor>
export const GAMEPLAY_MODULE_REGISTRY: GameplayModuleCatalog = Object.freeze({
  ...directEntries,
  descriptors: Object.freeze(ALL_DESCRIPTORS),
  get: (id: string, version?: string) => {
    const item = descriptorById.get(id)
    return item && (version === undefined || version === item.version) ? item : undefined
  },
  resolve: (id: string, version?: string) => {
    const item = descriptorById.get(id)
    return item && (version === undefined || version === item.version) ? item : undefined
  },
}) as GameplayModuleCatalog

export default GAMEPLAY_MODULE_REGISTRY

export type GameplayModuleCatalogEntry = Omit<Descriptor, 'lower'>

function serializable(value: unknown): GameplayJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => serializable(item))
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, GameplayJsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'function' || item === undefined) continue
      output[key] = serializable(item)
    }
    return output
  }
  throw new Error('gameplay module metadata is not JSON serializable')
}

/**
 * Metadata for editor/catalog consumers.  Lowering functions are deliberately
 * omitted, and every returned object is a fresh JSON-safe snapshot.
 */
export function getGameplayModuleCatalog(): readonly GameplayModuleCatalogEntry[] {
  return ALL_DESCRIPTORS.map(item => serializable({
    id: item.id,
    version: item.version,
    label: item.label,
    description: item.description,
    uiDescription: item.uiDescription,
    inputs: item.inputs,
    outputs: item.outputs,
    parameters: item.parameters,
    inspectReferences: item.inspectReferences,
    allowedSurfaces: item.allowedSurfaces,
    effects: item.effects,
    ui: item.ui,
  }) as GameplayModuleCatalogEntry)
}

export function getGameplayModule(id: string, version?: string): Descriptor | undefined {
  const item = descriptorById.get(id)
  return item && (version === undefined || version === item.version) ? item : undefined
}

// Keep this export strongly typed for editor/test consumers.  The structural
// registry contract intentionally permits several lookup shapes, so reading
// `GAMEPLAY_MODULE_REGISTRY.descriptors` directly would expose its union type
// even though this concrete registry always supplies the complete list.
export const gameplayModuleDescriptors: readonly Descriptor[] = ALL_DESCRIPTORS
