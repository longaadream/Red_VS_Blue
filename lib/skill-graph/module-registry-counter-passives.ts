import type { GameplayModuleDescriptor as Descriptor, GameplayNativeLoweringContext as Context, GameplayModuleSurface, GameplayValueType } from './module-types'

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const flow = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const context = (ctx: Context) => ctx.surface === 'pending' ? 'ctx' : 'context'
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): Descriptor => ({
  version: '1', ...value, allowedSurfaces: value.allowedSurfaces ?? surfaces,
})
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const recordType: GameplayValueType = 'record'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const input = (ctx: Context, name: string): string => ctx.inputs[name]

/**
 * Generic, closed compatibility primitives used by the counter/passive rule
 * migrations.  The author-facing side only carries opaque IDs and scalar
 * values.  Legacy direct status writes stay behind these registered lowerings
 * so a graph cannot receive a mutable piece or status object.
 */
export const COUNTER_PASSIVE_GAMEPLAY_MODULES: readonly Descriptor[] = [
  define({
    id: 'event.read-coordinate', label: '读取移动事件坐标',
    inputs: [{ name: 'fallback', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'field', type: stringType, enum: ['fromX', 'fromY'] }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `(function() { var value = ${context(ctx)}[${ctx.emitLiteral(ctx.parameters.field)}]; return value == null ? ${input(ctx, 'fallback')} : Number(value); })()`,
    ui: { category: 'event' },
  }),
  define({
    id: 'event.last-move-distance', label: '读取最近移动距离',
    inputs: [{ name: 'piece', type: pieceType }], outputs: [{ name: 'distance', type: numberType }],
    effects: { pure: true, previewSafe: false, reads: ['event', 'actions'] },
    lower: ctx => `(function() { var actions = Array.isArray(${battle(ctx)}.actions) ? ${battle(ctx)}.actions.slice().reverse() : []; var action = actions.find(function(item) { return item && item.type === 'move' && item.payload && item.payload.pieceId === ${input(ctx, 'piece')}; }); if (!action || !action.payload) return 0; return Math.abs(Number(action.payload.toX || 0) - Number(action.payload.fromX || 0)) + Math.abs(Number(action.payload.toY || 0) - Number(action.payload.fromY || 0)); })()`,
    ui: { category: 'event' },
  }),
  define({
    id: 'collection.contains-piece', label: '检查棋子是否在集合中',
    inputs: [{ name: 'items', type: pieceListType }, { name: 'value', type: pieceType }], outputs: [{ name: 'contains', type: booleanType }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(${input(ctx, 'items')}.indexOf(${input(ctx, 'value')}) >= 0)`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'piece.reference-present', label: '检查棋子引用存在',
    inputs: [{ name: 'piece', type: pieceType, nullable: true }], outputs: [{ name: 'value', type: booleanType }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `(${input(ctx, 'piece')} != null)`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'compare.equal-piece-nullable', label: '比较可空棋子引用',
    inputs: [{ name: 'left', type: pieceType, nullable: true }, { name: 'right', type: pieceType, nullable: true }], outputs: [{ name: 'value', type: booleanType }],
    effects: { pure: true, previewSafe: false },
    lower: ctx => `(${input(ctx, 'left')} === ${input(ctx, 'right')})`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'piece.name-by-id', label: '读取棋子名称',
    inputs: [{ name: 'piece', type: pieceType, nullable: true }, { name: 'fallback', type: stringType }], outputs: [{ name: 'text', type: stringType }],
    effects: { pure: true, previewSafe: false, reads: ['pieces'] },
    lower: ctx => `(function() { var id = ${input(ctx, 'piece')}; var all = (${battle(ctx)}.pieces || []).concat(${battle(ctx)}.graveyard || []); var item = all.find(function(candidate) { return candidate && candidate.instanceId === id; }); return item ? String(item.name || item.templateId || ${input(ctx, 'fallback')}) : ${input(ctx, 'fallback')}; })()`,
    ui: { category: 'query' },
  }),
  define({
    id: 'status.has-id', label: '检查状态标识',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }], outputs: [{ name: 'value', type: booleanType }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `((${flow(ctx)}.query.piece(${input(ctx, 'piece')}).statusTags || []).some(function(tag) { return tag && tag.id === ${input(ctx, 'statusId')}; }))`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-record-number', label: '读取登记状态数值',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }, { name: 'fallback', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'field', type: stringType, enum: ['stacks', 'intensity', 'hitCount', 'readyCharges'] }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function() { var tag = (${flow(ctx)}.query.piece(${input(ctx, 'piece')}).statusTags || []).find(function(item) { return item && item.id === ${input(ctx, 'statusId')}; }); var value = tag && tag[${ctx.emitLiteral(ctx.parameters.field)}]; return value == null ? ${input(ctx, 'fallback')} : Number(value); })()`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.set-record-number', label: '兼容性更新状态数值字段',
    description: '更新迁移登记的有限状态数值字段；不触发状态生命周期事件，不接受任意对象路径。',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }, { name: 'value', type: numberType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['currentDuration', 'remainingDuration', 'lastDamageTurn', 'stacks', 'intensity', 'hitCount', 'readyCharges'] }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `(function() { var tag = (${flow(ctx)}.query.piece(${input(ctx, 'piece')}).statusTags || []).find(function(item) { return item && item.id === ${input(ctx, 'statusId')}; }); if (!tag) return false; tag[${ctx.emitLiteral(ctx.parameters.field)}] = ${input(ctx, 'value')}; return true; })()`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.set-record-text', label: '兼容性更新状态文本字段',
    description: '更新迁移登记的有限状态文本字段；不触发状态生命周期事件。',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }, { name: 'value', type: stringType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['type', 'sourceId', 'name', 'stacking'] }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `(function() { var tag = (${flow(ctx)}.query.piece(${input(ctx, 'piece')}).statusTags || []).find(function(item) { return item && item.id === ${input(ctx, 'statusId')}; }); if (!tag) return false; tag[${ctx.emitLiteral(ctx.parameters.field)}] = ${input(ctx, 'value')}; return true; })()`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.set-record-boolean', label: '兼容性更新状态布尔字段',
    description: '更新迁移登记的有限状态布尔字段；不触发状态生命周期事件。',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }, { name: 'value', type: booleanType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['visible'] }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `(function() { var tag = (${flow(ctx)}.query.piece(${input(ctx, 'piece')}).statusTags || []).find(function(item) { return item && item.id === ${input(ctx, 'statusId')}; }); if (!tag) return false; tag[${ctx.emitLiteral(ctx.parameters.field)}] = ${input(ctx, 'value')}; return true; })()`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.clear-record-field', label: '清空兼容性状态字段',
    description: '清空迁移登记的有限可空状态字段；不触发状态生命周期事件。',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'statusId', type: stringType, nullable: true }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, enum: ['expiresAfterTurn'] }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `(function() { var tag = (${flow(ctx)}.query.piece(${input(ctx, 'piece')}).statusTags || []).find(function(item) { return item && item.id === ${input(ctx, 'statusId')}; }); if (!tag) return false; tag[${ctx.emitLiteral(ctx.parameters.field)}] = null; return true; })()`,
    ui: { category: 'status' },
  }),
  define({
    id: 'attribute.set-momentum', label: '设定动能',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'value', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    effects: { pure: false, previewSafe: false, writes: ['attributes'] },
    lower: ctx => `(function() { var piece = ${flow(ctx)}.query.piece(${input(ctx, 'piece')}); piece.momentum = ${input(ctx, 'value')}; return piece.momentum; })()`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'skill.adjust-all-cooldowns', label: '调整全部技能冷却',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'amount', type: numberType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'mode', type: stringType, enum: ['add', 'atLeast'], default: 'atLeast' }],
    effects: { pure: false, previewSafe: false, writes: ['skills'] },
    lower: ctx => `(function() { var piece = ${flow(ctx)}.query.piece(${input(ctx, 'piece')}); var skills = Array.isArray(piece.skills) ? piece.skills : []; if (!skills.length) return false; skills.forEach(function(skill) { var current = Number(skill.currentCooldown || 0); skill.currentCooldown = ${ctx.emitLiteral(ctx.parameters.mode)} === 'add' ? current + ${input(ctx, 'amount')} : Math.max(current, ${input(ctx, 'amount')}); }); return true; })()`,
    ui: { category: 'skill' },
  }),
  define({
    id: 'event.battle-turn-number', label: '读取战斗回合编号',
    inputs: [], outputs: [{ name: 'value', type: numberType }],
    effects: { pure: true, previewSafe: false, reads: ['turn'] },
    lower: ctx => `Number(${battle(ctx)}.turn && ${battle(ctx)}.turn.turnNumber)`,
    ui: { category: 'event' },
  }),
  define({
    id: 'value.is-finite', label: '检查有限数值',
    inputs: [{ name: 'value', type: numberType }], outputs: [{ name: 'value', type: booleanType }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `Number.isFinite(${input(ctx, 'value')})`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'event.actions', label: '读取战斗动作记录',
    inputs: [], outputs: [{ name: 'actions', type: recordListType }],
    effects: { pure: true, previewSafe: false, reads: ['actions'] },
    lower: ctx => `(Array.isArray(${battle(ctx)}.actions) ? ${battle(ctx)}.actions : [])`,
    ui: { category: 'event' },
  }),
  define({
    id: 'event.action-text', label: '读取动作文本字段',
    inputs: [{ name: 'action', type: recordType }, { name: 'fallback', type: stringType }], outputs: [{ name: 'value', type: stringType }],
    parameters: [{ name: 'field', type: stringType, enum: ['type'] }],
    effects: { pure: true, previewSafe: false, reads: ['actions'] },
    lower: ctx => `(function(action) { var value = action && action[${ctx.emitLiteral(ctx.parameters.field)}]; return value == null ? ${input(ctx, 'fallback')} : String(value); })(${input(ctx, 'action')})`,
    ui: { category: 'event' },
  }),
  define({
    id: 'event.action-number', label: '读取动作数值字段',
    inputs: [{ name: 'action', type: recordType }, { name: 'fallback', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'field', type: stringType, enum: ['turn', 'payload.finalDamage'] }],
    effects: { pure: true, previewSafe: false, reads: ['actions'] },
    lower: ctx => `(function(action) { var value = ${ctx.emitLiteral(ctx.parameters.field)} === 'turn' ? action && action.turn : action && action.payload && action.payload.finalDamage; return value == null ? ${input(ctx, 'fallback')} : Number(value); })(${input(ctx, 'action')})`,
    ui: { category: 'event' },
  }),
  define({
    id: 'event.action-piece', label: '读取动作棋子字段',
    inputs: [{ name: 'action', type: recordType }, { name: 'fallback', type: pieceType, nullable: true }], outputs: [{ name: 'value', type: pieceType, nullable: true }],
    parameters: [{ name: 'field', type: stringType, enum: ['payload.targetId'] }],
    effects: { pure: true, previewSafe: false, reads: ['actions'] },
    lower: ctx => `(function(action) { var value = action && action.payload && action.payload.targetId; return typeof value === 'string' ? value : ${input(ctx, 'fallback')}; })(${input(ctx, 'action')})`,
    ui: { category: 'event' },
  }),
  define({
    id: 'state.read-piece-number', label: '读取棋子兼容计数',
    description: '按封闭的内容状态字段读取棋子计数；不接受任意命名空间或字段。',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'fallback', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'namespace', type: stringType, enum: ['muzan-flesh-regeneration'] }, { name: 'name', type: stringType, enum: ['lastDamageTurn', 'lastCheckTurn', 'successfulHeals'] }],
    effects: { pure: true, previewSafe: false, reads: ['state'] },
    lower: ctx => `(function() { var value = ${flow(ctx)}.state.get('piece', ${input(ctx, 'piece')}, ${ctx.emitLiteral(ctx.parameters.namespace)}, ${ctx.emitLiteral(ctx.parameters.name)}); return value == null ? ${input(ctx, 'fallback')} : Number(value); })()`,
    ui: { category: 'state' },
  }),
  define({
    id: 'state.write-piece-number', label: '写入棋子兼容计数',
    description: '按封闭的内容状态字段写入棋子计数；不接受任意命名空间或字段。',
    inputs: [{ name: 'piece', type: pieceType }, { name: 'value', type: numberType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'namespace', type: stringType, enum: ['muzan-flesh-regeneration'] }, { name: 'name', type: stringType, enum: ['lastDamageTurn', 'lastCheckTurn', 'successfulHeals'] }],
    effects: { pure: false, previewSafe: false, writes: ['state'] },
    lower: ctx => `(function() { ${flow(ctx)}.state.set('piece', ${input(ctx, 'piece')}, ${ctx.emitLiteral(ctx.parameters.namespace)}, ${ctx.emitLiteral(ctx.parameters.name)}, ${input(ctx, 'value')}, 'battle'); return true; })()`,
    ui: { category: 'state' },
  }),
  define({
    id: 'state.read-player-number', label: '读取玩家兼容计数',
    description: '按受限的兼容路径读取玩家编号计数；宿主负责路径校验与状态镜像。',
    inputs: [{ name: 'player', type: playerType }, { name: 'fallback', type: numberType }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'path', type: stringType }],
    effects: { pure: true, previewSafe: false, reads: ['state'] },
    lower: ctx => `Number(${flow(ctx)}.state.getPlayerNumber(${ctx.emitLiteral(ctx.parameters.path)}, ${input(ctx, 'player')}) || ${input(ctx, 'fallback')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'state.write-player-number', label: '写入玩家兼容计数',
    description: '按受限的兼容路径写入玩家编号计数；宿主负责路径校验与状态镜像。',
    inputs: [{ name: 'player', type: playerType }, { name: 'value', type: numberType }], outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'path', type: stringType }],
    effects: { pure: false, previewSafe: false, writes: ['state'] },
    lower: ctx => `${flow(ctx)}.state.setPlayerNumber(${ctx.emitLiteral(ctx.parameters.path)}, ${input(ctx, 'player')}, ${input(ctx, 'value')})`,
    ui: { category: 'state' },
  }),
  define({
    id: 'effect.queue-damage', label: '排队伤害',
    description: '在当前规则事件的获准 damageQueue 中加入一个结构化伤害请求；不提前改变生命值。',
    inputs: [{ name: 'attacker', type: pieceType }, { name: 'target', type: pieceType }, { name: 'amount', type: numberType }], outputs: [{ name: 'queued', type: booleanType }],
    parameters: [{ name: 'damageType', type: stringType, enum: ['physical', 'magical', 'true', 'toxin'], default: 'physical' }, { name: 'skillId', type: stringType }],
    allowedSurfaces: ['rule'],
    effects: { pure: false, previewSafe: false, writes: ['damage-queue'], events: ['beforeDamageDealt', 'afterDamageDealt'] },
    lower: ctx => `(function() { if (!${context(ctx)}.damageQueue || typeof ${context(ctx)}.damageQueue.push !== 'function') throw new Error('effect.queue-damage requires context.damageQueue'); ${context(ctx)}.damageQueue.push({attacker: ${flow(ctx)}.query.piece(${input(ctx, 'attacker')}), target: ${flow(ctx)}.query.piece(${input(ctx, 'target')}), damage: ${input(ctx, 'amount')}, damageType: ${ctx.emitLiteral(ctx.parameters.damageType)}, skillId: ${ctx.emitLiteral(ctx.parameters.skillId)}}); return true; })()`,
    ui: { category: 'effect' },
  }),
]

