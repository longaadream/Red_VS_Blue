import type { GameplayModuleDescriptor as Descriptor, GameplayModuleSurface, GameplayNativeLoweringContext as Context } from './module-types'

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const flow = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const context = (ctx: Context) => ctx.surface === 'pending' ? 'ctx' : 'context'
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'>): Descriptor => ({ version: '1', allowedSurfaces: surfaces, ...value })
const fields = ['stacks', 'intensity', 'currentDuration', 'remainingDuration', 'currentUses', 'remainingUses', 'value']

/** Status IDs remain immutable values; mutable host status objects never escape. */
export const STATUS_EVENT_GAMEPLAY_MODULES: readonly Descriptor[] = [
  define({
    id: 'status.has-player', label: '玩家具有状态类型',
    inputs: [{ name: 'player', type: 'player' }], outputs: [{ name: 'value', type: 'boolean' }],
    parameters: [{ name: 'statusType', type: 'string' }],
    effects: { pure: true, previewSafe: false, reads: ['statuses', 'players'] },
    lower: ctx => `(${flow(ctx)}.query.player(${ctx.inputs.player}).statusTags || []).some(function(tag) { return tag.type === ${ctx.emitLiteral(ctx.parameters.statusType)}; })`, ui: { category: 'status' },
  }),
  define({
    id: 'status.apply-player-record', label: '附加结构化玩家状态',
    inputs: [{ name: 'player', type: 'player' }, { name: 'record', type: 'record' }], outputs: [{ name: 'success', type: 'boolean' }],
    effects: { pure: false, previewSafe: false, writes: ['statuses', 'events'] },
    lower: ctx => `${flow(ctx)}.status.add(${ctx.inputs.player}, ${ctx.inputs.record}, "player", "host")`, ui: { category: 'status' },
  }),
  define({
    id: 'status.remove-player-records', label: '移除玩家状态记录（不触发事件）',
    inputs: [{ name: 'player', type: 'player' }], outputs: [{ name: 'count', type: 'number' }],
    parameters: [{ name: 'statusType', type: 'string' }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `${flow(ctx)}.status.removePlayerRecords(${ctx.inputs.player}, ${ctx.emitLiteral(ctx.parameters.statusType)})`, ui: { category: 'status' },
  }),
  define({
    id: 'event.status-text', label: '读取事件状态标识',
    inputs: [], outputs: [{ name: 'value', type: 'string', nullable: true }],
    parameters: [{ name: 'field', type: 'string', enum: ['statusId', 'statusType'] }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `(${context(ctx)}[${ctx.emitLiteral(ctx.parameters.field)}] ?? null)`,
    ui: { category: 'event' },
  }),
  define({
    id: 'status.remove-record', label: '直接移除首个匹配状态记录',
    description: '保留既有直接删除状态记录的语义，不触发移除事件或清理关联能力。',
    inputs: [{ name: 'piece', type: 'piece' }, { name: 'value', type: 'string', nullable: true }], outputs: [{ name: 'removed', type: 'boolean' }],
    parameters: [{ name: 'selector', type: 'string', enum: ['id', 'type'] }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `(${ctx.inputs.value} == null ? false : ${flow(ctx)}.status.removeRaw(${ctx.inputs.piece}, ${ctx.emitLiteral(ctx.parameters.selector)}, ${ctx.inputs.value}))`, ui: { category: 'status' },
  }),
  define({
    id: 'status.matches-type', label: '检查状态类型',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'boolean' }],
    parameters: [{ name: 'statusType', type: 'string' }, { name: 'legacyStrings', type: 'string', enum: ['ignore', 'exact', 'contains'], default: 'ignore' }],
    effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => {
      const type = ctx.emitLiteral(ctx.parameters.statusType)
      const stringMatch = ctx.parameters.legacyStrings === 'exact' ? `tag === ${type}` : ctx.parameters.legacyStrings === 'contains' ? `tag.includes(${type})` : 'false'
      return `(${flow(ctx)}.query.piece(${ctx.inputs.piece}).statusTags || []).some(function(tag) { return typeof tag === 'string' ? ${stringMatch} : Boolean(tag && tag.type === ${type}); })`
    }, ui: { category: 'status' },
  }),
  ...(['blocked', 'isKilled'] as const).map(field => define({
    id: field === 'blocked' ? 'damage.was-blocked' : 'damage.killed', label: field === 'blocked' ? '伤害已被阻挡' : '伤害造成击杀',
    inputs: [{ name: 'result', type: 'record' }], outputs: [{ name: 'value', type: 'boolean' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `Boolean(${ctx.inputs.result} && ${ctx.inputs.result}.${field})`, ui: { category: 'effect' },
  })),
  define({
    id: 'status.list-ids', label: '查询同类型状态标识集合',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'ids', type: { kind: 'list', element: 'string' } }],
    parameters: [{ name: 'statusType', type: 'string' }], effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(${flow(ctx)}.query.piece(${ctx.inputs.piece}).statusTags || []).filter(function(tag) { return tag.type === ${ctx.emitLiteral(ctx.parameters.statusType)}; }).map(function(tag) { return tag.id; })`, ui: { category: 'status' },
  }),
  define({
    id: 'compare.player-reference', label: '比较可空玩家引用',
    inputs: [{ name: 'left', type: 'player', nullable: true }, { name: 'right', type: 'player', nullable: true }], outputs: [{ name: 'value', type: 'boolean' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `(${ctx.inputs.left} === ${ctx.inputs.right})`, ui: { category: 'condition' },
  }),
  define({
    id: 'status.find-id', label: '查找首个状态标识',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'id', type: 'string', nullable: true }],
    parameters: [{ name: 'statusType', type: 'string' }], effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function() { var tag = (${flow(ctx)}.query.piece(${ctx.inputs.piece}).statusTags || []).find(function(tag) { return tag.type === ${ctx.emitLiteral(ctx.parameters.statusType)}; }); return tag ? tag.id : null; })()`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.read-number', label: '读取状态数值',
    inputs: [{ name: 'piece', type: 'piece' }, { name: 'statusId', type: 'string', nullable: true }, { name: 'fallback', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'field', type: 'string', enum: fields }], effects: { pure: true, previewSafe: false, reads: ['statuses'] },
    lower: ctx => `(function() { var tag = (${flow(ctx)}.query.piece(${ctx.inputs.piece}).statusTags || []).find(function(tag) { return tag.id === ${ctx.inputs.statusId}; }); var value = tag && tag[${ctx.emitLiteral(ctx.parameters.field)}]; return value == null ? ${ctx.inputs.fallback} : Number(value); })()`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.set-number', label: '设定状态数值',
    inputs: [{ name: 'piece', type: 'piece' }, { name: 'statusId', type: 'string', nullable: true }, { name: 'value', type: 'number' }], outputs: [{ name: 'success', type: 'boolean' }],
    parameters: [{ name: 'field', type: 'string', enum: ['stacks', 'intensity', 'value'] }], effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `${flow(ctx)}.status.setNumber(${ctx.inputs.piece}, ${ctx.inputs.statusId}, ${ctx.emitLiteral(ctx.parameters.field)}, ${ctx.inputs.value})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.remove-id', label: '按标识移除状态',
    inputs: [{ name: 'piece', type: 'piece' }, { name: 'statusId', type: 'string', nullable: true }], outputs: [{ name: 'success', type: 'boolean' }],
    effects: { pure: false, previewSafe: false, writes: ['statuses', 'rules'], events: ['afterStatusRemoved'] },
    lower: ctx => `(${ctx.inputs.statusId} == null ? false : Boolean(${flow(ctx)}.status.remove(${ctx.inputs.piece}, ${ctx.inputs.statusId})))`,
    ui: { category: 'status' },
  }),
  define({
    id: 'event.read-number', label: '读取事件数值',
    inputs: [{ name: 'fallback', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'field', type: 'string', enum: ['damage', 'actualDamage', 'heal', 'amount', 'targetX', 'targetY', 'turnNumber'] }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `(function() { var value = ${context(ctx)}[${ctx.emitLiteral(ctx.parameters.field)}]; return value == null ? ${ctx.inputs.fallback} : Number(value); })()`,
    ui: { category: 'event' },
  }),
  define({
    id: 'event.write-number', label: '改写结算前事件数值',
    inputs: [{ name: 'value', type: 'number' }], outputs: [],
    parameters: [{ name: 'field', type: 'string', enum: ['damage', 'heal', 'amount', 'targetX', 'targetY'] }, { name: 'inputPolicy', type: 'string', enum: ['floor', 'host'], default: 'floor' }],
    effects: { pure: false, previewSafe: false, writes: ['event'] },
    lower: ctx => `${flow(ctx)}.event.modify(${ctx.emitLiteral(ctx.parameters.field)}, ${ctx.inputs.value}, ${ctx.emitLiteral(ctx.parameters.inputPolicy)})`,
    ui: { category: 'event' },
  }),
]
