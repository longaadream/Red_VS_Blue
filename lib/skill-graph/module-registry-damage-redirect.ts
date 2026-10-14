import type { GameplayModuleDescriptor } from './module-types'

/** Event identity and the existing redirect queue; eligibility remains in author graphs. */
export const DAMAGE_REDIRECT_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = [
  {
    id: 'ref.rule-piece', version: '1', label: '当前规则持有棋子', allowedSurfaces: ['rule'],
    inputs: [], outputs: [{ name: 'piece', type: 'piece', nullable: true }],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: () => '(context.rulePiece ? context.rulePiece.instanceId : null)', ui: { category: 'context' },
  },
  {
    id: 'spatial.has-position', version: '1', label: '棋子具有棋盘坐标',
    allowedSurfaces: ['skill', 'rule', 'card', 'triggerSkill', 'pending'],
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'boolean' }],
    effects: { pure: true, previewSafe: false, reads: ['position'] },
    lower: ctx => `(function(piece) { return piece.x != null && piece.y != null; })(${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.query.piece(${ctx.inputs.piece}))`,
    ui: { category: 'position' },
  },
  {
    id: 'event.enqueue-damage-redirect', version: '1', label: '修改伤害承受者', allowedSurfaces: ['rule'],
    description: '在伤害转移前事件中修改承受棋子，沿用权威转移队列。已转移、目标失效或当前阶段不可改写时返回未接受，不改变后事件事实。',
    inputs: [{ name: 'target', type: 'piece', label: '承受棋子' }], outputs: [{ name: 'accepted', type: 'boolean', label: '已接受' }],
    effects: { pure: false, previewSafe: false, writes: ['damage-redirect-queue'] },
    lower: ctx => `Boolean(context.damageRedirectQueue && context.damageRedirectQueue.push({target: flow.query.piece(${ctx.inputs.target})}))`,
    ui: { category: 'status-rule', authoring: 'standard' },
  },
]
