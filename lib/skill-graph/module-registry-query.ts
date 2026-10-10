import type { GameplayModuleDescriptor as Descriptor, GameplayModuleSurface, GameplayNativeLoweringContext as Lowering, GameplayPort } from './module-types'

const active: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const port = (name: string, type: GameplayPort['type']): GameplayPort => ({ name, type })
const flow = (ctx: Lowering) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const context = (ctx: Lowering) => ctx.surface === 'pending' ? 'ctx' : 'context'
const battle = (ctx: Lowering) => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const read = (domains: string[]) => ({ pure: true, previewSafe: false, reads: domains })
function define(value: Omit<Descriptor, 'version' | 'allowedSurfaces'>): Descriptor {
  return { version: '1', allowedSurfaces: active, ...value }
}

/** Closed-domain facts used by reusable guards, not arbitrary field lookup. */
export const QUERY_GAMEPLAY_MODULES: readonly Descriptor[] = [
  define({ id: 'skill.power-multiplier', label: '技能威力倍率', inputs: [], outputs: [port('value', 'number')], effects: read(['skill']),
    lower: ctx => `${context(ctx)}.skill.powerMultiplier`, ui: { category: 'query' } }),
  define({ id: 'choice.is-unresolved', label: '选择未完成或已取消', inputs: [{ name: 'choice', type: 'choice', nullable: true, optional: true }], outputs: [port('value', 'boolean')], effects: read(['choice']),
    lower: ctx => `(!${ctx.inputs.choice} || Boolean(${ctx.inputs.choice}.needsTargetSelection) || Boolean(${ctx.inputs.choice}.needsOptionSelection))`, ui: { category: 'choice' } }),
  define({ id: 'choice.as-result', label: '返回权威选择结果', inputs: [{ name: 'choice', type: 'choice', nullable: true, optional: true }], outputs: [{ name: 'result', type: 'record', nullable: true }], effects: read(['choice']),
    lower: ctx => ctx.inputs.choice, ui: { category: 'choice' } }),
  define({ id: 'result.action', label: '构造行动结果', inputs: [port('success', 'boolean'), { name: 'message', type: 'string', optional: true }], outputs: [port('result', 'record')], effects: { pure: true, previewSafe: true },
    lower: ctx => `({success: ${ctx.inputs.success}${ctx.inputs.message === undefined ? '' : ', message: ' + ctx.inputs.message}})`, ui: { category: 'result' } }),
  define({ id: 'turn.number', label: '当前回合编号', inputs: [], outputs: [port('value', 'number')], effects: read(['turn']),
    lower: ctx => `${battle(ctx)}.turn.turnNumber`, ui: { category: 'query' } }),
  define({ id: 'turn.current-player', label: '当前回合玩家', inputs: [], outputs: [port('player', 'player')], effects: read(['turn']),
    lower: ctx => `${battle(ctx)}.turn.currentPlayerId`, ui: { category: 'query' } }),
  define({ id: 'ref.event-piece', label: '当前事件棋子', inputs: [], outputs: [port('piece', 'piece')], effects: read(['event']),
    lower: ctx => `(${context(ctx)}.piece ? ${context(ctx)}.piece.instanceId : null)`, ui: { category: 'context' } }),
  define({ id: 'piece.owner', label: '棋子所属玩家', inputs: [port('piece', 'piece')], outputs: [port('player', 'player')], effects: read(['pieces']),
    lower: ctx => `${flow(ctx)}.query.piece(${ctx.inputs.piece}).ownerPlayerId`, ui: { category: 'query' } }),
  ...(['has', 'count'] as const).map(operation => define({
    id: `status.${operation}-piece`, label: operation === 'has' ? '棋子具有状态类型' : '棋子状态数量',
    inputs: [port('piece', 'piece')], outputs: [port('value', operation === 'has' ? 'boolean' : 'number')],
    parameters: [{ name: 'statusType', type: 'string' }], effects: read(['statuses']),
    lower: ctx => `((${flow(ctx)}.query.piece(${ctx.inputs.piece}).statusTags || []).${operation === 'has' ? 'some' : 'filter'}(function(tag) { return tag.type === ${ctx.emitLiteral(ctx.parameters.statusType)}; })${operation === 'count' ? '.length' : ''})`,
    ui: { category: 'status' },
  })),
  define({ id: 'attribute.adjust', label: '增加棋子属性', inputs: [port('piece', 'piece'), port('amount', 'number')], outputs: [port('value', 'number')],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange'], default: 'attack' }],
    effects: { pure: false, previewSafe: false, writes: ['attributes'] },
    lower: ctx => `${flow(ctx)}.attributes.add(${ctx.inputs.piece}, ${ctx.emitLiteral(ctx.parameters.attribute)}, ${ctx.inputs.amount})`, ui: { category: 'effect' } }),
  define({ id: 'event.block', label: '阻挡当前事件', inputs: [port('message', 'string')], outputs: [port('success', 'boolean'), port('blocked', 'boolean'), port('message', 'string')],
    effects: { pure: false, previewSafe: false, writes: ['event-result'] },
    lower: ctx => `({success: true, blocked: true, message: ${ctx.inputs.message}})`, ui: { category: 'event' } }),
]
