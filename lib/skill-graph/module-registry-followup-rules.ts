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
 * Small host adapters shared by the six RED-252 follow-up rules.  These are
 * intentionally content-neutral: the rule graphs own the ordering, guards,
 * messages, and record shapes, while these adapters only cross an existing
 * host boundary that cannot currently be expressed by the public flow facade.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const recordType = (schema: string): GameplayValueType => ({ kind: 'record', schema })
const stringListType: GameplayValueType = { kind: 'list', element: stringType }
const statusListType: GameplayValueType = { kind: 'list', element: recordType('followup-status@1') }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const host = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx' : 'context'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || !value) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const literal = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (value === undefined) throw new Error(`module ${ctx.moduleId}: missing parameter ${name}`)
  return ctx.emitLiteral(value)
}
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({
  pure: false,
  previewSafe: false,
  writes: domains,
  events,
})
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE,
  ...value,
})

export const FOLLOWUP_RULE_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'followup.status-records',
    label: '按类型读取状态记录',
    description: '读取棋子当前拥有的结构化状态记录，保留宿主顺序；可排除本回合刚施加的记录。',
    inputs: [port('piece', pieceType), port('turn', numberType, { optional: true })],
    outputs: [port('records', statusListType)],
    parameters: [parameter('statusType', stringType)],
    effects: pure(['statuses', 'pieces']),
    lower: ctx => `(function(pieceId, statusType, currentTurn) { var piece = ${flow(ctx)}.query.piece(pieceId); return ((piece && piece.statusTags) || []).filter(function(tag) { return tag && tag.type === statusType && (currentTurn === undefined || tag.appliedTurn !== currentTurn); }); })(${input(ctx, 'piece')}, ${literal(ctx, 'statusType')}, ${ctx.inputs.turn ?? 'undefined'})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'followup.status-player-field',
    label: '读取状态玩家引用',
    description: '从已找到的状态记录读取一个声明过的玩家引用字段。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true })],
    outputs: [port('player', playerType, { nullable: true })],
    parameters: [parameter('field', stringType, { enum: ['opponentPlayerId'] })],
    effects: pure(['statuses', 'pieces']),
    lower: ctx => `(function(pieceId,statusId) { var piece = ${flow(ctx)}.query.piece(pieceId); var tag = ((piece && piece.statusTags) || []).find(function(item) { return item && item.id === statusId; }); var value = tag && tag[${literal(ctx, 'field')}]; return typeof value === "string" ? value : null; })(${input(ctx, 'piece')}, ${input(ctx, 'statusId')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'followup.remove-status-types',
    label: '移除多种状态类型',
    description: '按显式类型列表直接移除状态记录，不隐式安装或清理规则。',
    inputs: [port('piece', pieceType), port('types', stringListType)],
    outputs: [port('success', booleanType)],
    effects: writes(['statuses']),
    lower: ctx => `(function(pieceId,types) { var piece = ${flow(ctx)}.query.piece(pieceId); piece.statusTags = (piece.statusTags || []).filter(function(tag) { return !tag || types.indexOf(tag.type) < 0; }); return true; })(${input(ctx, 'piece')}, ${input(ctx, 'types')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'followup.damage-status',
    label: '结算状态延迟伤害',
    description: '从状态来源解析棋子，并通过现有 dealDamage 权威入口结算延迟伤害。',
    inputs: [port('status', recordType('followup-status@1')), port('target', pieceType)],
    outputs: [port('result', 'record'), port('success', booleanType), port('damage', numberType)],
    parameters: [parameter('damageType', stringType, { enum: ['physical', 'magical', 'true'] }), parameter('skillId', stringType)],
    effects: writes(['damage', 'statuses'], ['beforeDamageDealt', 'afterDamageDealt']),
    lower: ctx => {
      const state = battle(ctx)
      const query = flow(ctx)
      const status = input(ctx, 'status')
      return `(function(tag,targetId) { var source = ((${state}.pieces || []).concat(${state}.graveyard || [])).find(function(piece) { return piece && piece.instanceId === tag.sourceId; }); if (!source) throw new Error("Black coffin damage source is unavailable"); var value = dealDamage(source, ${query}.query.piece(targetId), tag.delayedDamage, ${literal(ctx, 'damageType')}, ${state}, ${literal(ctx, 'skillId')}); return {result:value, success:true, damage:value.damage}; })(${status}, ${input(ctx, 'target')})`
    },
    ui: { category: 'effect' },
  }),
  define({
    id: 'followup.card-has-prefix',
    label: '卡牌标识前缀匹配',
    description: '判断当前卡牌标识是否以指定前缀开头。',
    inputs: [port('cardId', stringType, { nullable: true })],
    outputs: [port('value', booleanType)],
    parameters: [parameter('prefix', stringType)],
    effects: pure(['event']),
    lower: ctx => `Boolean(${input(ctx, 'cardId')} && ${input(ctx, 'cardId')}.startsWith(${literal(ctx, 'prefix')}))`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'followup.message-buffer-start',
    label: '开始消息集合',
    description: '创建当前规则执行内的临时消息集合。',
    inputs: [],
    outputs: [port('started', booleanType)],
    effects: writes(['execution-context']),
    lower: ctx => `(${host(ctx)}.__rvbFollowupMessages = [], true)`,
    ui: { category: 'flow' },
  }),
  define({
    id: 'followup.message-buffer-add',
    label: '追加规则消息',
    description: '向当前规则执行内的临时消息集合追加一条文本。',
    inputs: [port('message', stringType)],
    outputs: [port('count', numberType)],
    effects: writes(['execution-context']),
    lower: ctx => `(${host(ctx)}.__rvbFollowupMessages || (${host(ctx)}.__rvbFollowupMessages = [])).push(${input(ctx, 'message')}), ${host(ctx)}.__rvbFollowupMessages.length`,
    ui: { category: 'flow' },
  }),
  define({
    id: 'followup.message-buffer-read',
    label: '读取规则消息',
    description: '读取并清理当前规则执行内的消息集合。',
    inputs: [],
    outputs: [port('text', stringType), port('count', numberType)],
    effects: writes(['execution-context']),
    lower: ctx => `(function() { var values = Array.isArray(${host(ctx)}.__rvbFollowupMessages) ? ${host(ctx)}.__rvbFollowupMessages : []; var text = values.join("；"); delete ${host(ctx)}.__rvbFollowupMessages; return {text:text,count:values.length}; })()`,
    ui: { category: 'flow' },
  }),
  define({
    id: 'followup.counter.increment-player',
    label: '递增玩家内容计数',
    description: '递增声明过的玩家内容计数器，并返回新值。',
    inputs: [port('player', playerType)],
    outputs: [port('next', numberType)],
    parameters: [parameter('counter', stringType, { enum: ['mangekyoDeaths'] })],
    effects: writes(['extensions']),
    lower: ctx => `(function(playerId) { battle.extensions = battle.extensions || {}; battle.extensions.contentCounters = battle.extensions.contentCounters || {}; battle.extensions.contentCounters[${literal(ctx, 'counter')}] = battle.extensions.contentCounters[${literal(ctx, 'counter')}] || {}; var values = battle.extensions.contentCounters[${literal(ctx, 'counter')}]; var next = (Number(values[playerId]) || 0) + 1; values[playerId] = next; return next; })(${input(ctx, 'player')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'followup.piece-name-with-template',
    label: '读取棋子名称并回退模板',
    description: '按棋子引用读取展示名称，缺少名称时回退模板标识。',
    inputs: [port('piece', pieceType)],
    outputs: [port('text', stringType)],
    effects: pure(['pieces']),
    lower: ctx => `(function(value) { var id = value && typeof value === "object" ? value.instanceId : value; var piece = ((${battle(ctx)}.pieces || []).concat(${battle(ctx)}.graveyard || [])).find(function(item) { return item && item.instanceId === id; }); return String((piece && (piece.name || piece.templateId)) || id || ""); })(${input(ctx, 'piece')})`,
    ui: { category: 'text' },
  }),
  define({
    id: 'followup.piece-template-id',
    label: '读取棋子模板标识',
    description: '读取棋子的稳定模板标识。',
    inputs: [port('piece', pieceType)],
    outputs: [port('text', stringType)],
    effects: pure(['pieces']),
    lower: ctx => `(function(value) { var id = value && typeof value === "object" ? value.instanceId : value; var piece = ((${battle(ctx)}.pieces || []).concat(${battle(ctx)}.graveyard || [])).find(function(item) { return item && item.instanceId === id; }); return String((piece && piece.templateId) || ""); })(${input(ctx, 'piece')})`,
    ui: { category: 'text' },
  }),
  define({
    id: 'followup.primary-mangekyo-witness',
    label: '万花筒首位见证者',
    description: '按实例标识稳定排序判断当前见证者是否为该玩家的首个见证者。',
    inputs: [port('witness', pieceType)],
    outputs: [port('value', booleanType)],
    effects: pure(['pieces', 'statuses']),
    lower: ctx => `(function(value) { var id = value && typeof value === "object" ? value.instanceId : value; var pieces = ${battle(ctx)}.pieces || []; var current = pieces.find(function(item) { return item && item.instanceId === id; }); if (!current) return false; var witnesses = pieces.filter(function(item) { return item && item.ownerPlayerId === current.ownerPlayerId && (item.statusTags || []).some(function(tag) { return tag && tag.type === "mangekyo-witness"; }); }).sort(function(left,right) { return String(left.instanceId).localeCompare(String(right.instanceId)); }); return witnesses.length > 0 && witnesses[0].instanceId === id; })(${input(ctx, 'witness')})`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'followup.turn-number-or-zero',
    label: '读取回合编号',
    description: '读取当前战斗回合编号，缺少回合时回退为零。',
    inputs: [],
    outputs: [port('value', numberType)],
    effects: pure(['turn']),
    lower: ctx => `Number((${battle(ctx)}.turn && ${battle(ctx)}.turn.turnNumber) || 0)`,
    ui: { category: 'context' },
  }),
  define({
    id: 'followup.action.append',
    label: '追加动作记录',
    description: '追加已声明结构化动作记录，保留原有日志序列。',
    inputs: [port('action', recordType('followup-mangekyo-action@1'))],
    outputs: [port('success', booleanType)],
    effects: writes(['actions']),
    lower: ctx => `(${battle(ctx)}.actions = ${battle(ctx)}.actions || [], ${battle(ctx)}.actions.push(${input(ctx, 'action')}), true)`,
    ui: { category: 'log' },
  }),
])
