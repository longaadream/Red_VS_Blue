import type { GameplayModuleDescriptor as Descriptor, GameplayModuleSurface, GameplayNativeLoweringContext as Context } from './module-types'
const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const flow = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'>): Descriptor => ({ version: '1', allowedSurfaces: surfaces, ...value })
const pieces = { kind: 'list', element: 'piece' } as const

export const AREA_EFFECT_GAMEPLAY_MODULES: readonly Descriptor[] = [
  define({
    id: 'source.capture', label: '保留本次结算来源',
    description: '仅为当前执行保留来源归属；来源离场后已开始的效果可继续结算，不允许来源重新行动。句柄不能跨执行使用。',
    inputs: [{ name: 'source', type: 'piece' }], outputs: [{ name: 'source', type: 'record' }],
    effects: { pure: false, previewSafe: false, reads: ['pieces'], writes: ['execution-context'] }, lower: ctx => `${flow(ctx)}.effects.captureSource(${ctx.inputs.source})`, ui: { category: 'context' },
  }),
  ...(['damage', 'heal'] as const).map(kind => define({
    id: `effect.${kind}-many-captured`, label: kind === 'damage' ? '使用已保留来源批量伤害' : '使用已保留来源批量治疗',
    inputs: [{ name: 'source', type: 'record' }, { name: 'targets', type: pieces }, { name: 'amount', type: 'number' }], outputs: [{ name: 'result', type: 'record' }],
    parameters: kind === 'damage' ? [{ name: 'damageType', type: 'string', enum: ['physical', 'magical', 'true'], default: 'physical' }] : [],
    effects: { pure: false, previewSafe: false, reads: ['execution-context'], writes: [kind, 'events'] },
    lower: ctx => `${flow(ctx)}.effects.${kind}ManyCaptured(${ctx.inputs.source}, ${ctx.inputs.targets}, ${ctx.inputs.amount}${kind === 'damage' ? ', ' + ctx.emitLiteral(ctx.parameters.damageType) : ''})`, ui: { category: 'effect' },
  })),
  define({
    id: 'query.pieces-around-cell', label: '查询地格周围棋子',
    inputs: [{ name: 'center', type: 'cell' }, { name: 'owner', type: 'player' }], outputs: [{ name: 'pieces', type: pieces }],
    parameters: [{ name: 'relation', type: 'string', enum: ['all', 'ally', 'enemy'], default: 'all' }, { name: 'metric', type: 'string', enum: ['manhattan', 'chebyshev'], default: 'manhattan' }, { name: 'minimum', type: 'number', default: 0, minimum: 0 }, { name: 'maximum', type: 'number', default: 1, minimum: 0 }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'position', 'players'] },
    lower: ctx => {
      const relation = ctx.parameters.relation === 'all' ? '' : `ownerId: ${ctx.inputs.owner}, relation: ${ctx.emitLiteral(ctx.parameters.relation)}`
      const distance = ctx.parameters.metric === 'chebyshev' ? 'Math.max(dx, dy)' : 'dx + dy'
      return `${flow(ctx)}.query.pieces({${relation}}).filter(function(id) { var p = ${flow(ctx)}.query.piece(id), dx = Math.abs(p.x - ${ctx.inputs.center}.x), dy = Math.abs(p.y - ${ctx.inputs.center}.y), distance = ${distance}; return distance >= ${ctx.emitLiteral(ctx.parameters.minimum)} && distance <= ${ctx.emitLiteral(ctx.parameters.maximum)}; })`
    }, ui: { category: 'query' },
  }),
  define({
    id: 'collection.piece-count', label: '棋子集合数量', inputs: [{ name: 'pieces', type: pieces }], outputs: [{ name: 'value', type: 'number' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `${ctx.inputs.pieces}.length`, ui: { category: 'collection' },
  }),
  ...(['damage', 'heal'] as const).map(kind => define({
    id: `effect.${kind}-many`, label: kind === 'damage' ? '同时伤害多个目标' : '同时治疗多个目标',
    inputs: [{ name: 'source', type: 'piece' }, { name: 'targets', type: pieces }, { name: 'amount', type: 'number' }], outputs: [{ name: 'result', type: 'record' }],
    parameters: [...(kind === 'damage' ? [{ name: 'damageType', type: 'string' as const, enum: ['normal', 'true'], default: 'normal' }, { name: 'legacyNormalSpelling', type: 'string' as const, enum: ['physical', 'magical'], default: 'physical', label: '旧日志伤害名称' }] : []), { name: 'skillId', type: 'string', optional: true }],
    effects: { pure: false, previewSafe: false, writes: [kind, 'events'] },
    lower: ctx => `${flow(ctx)}.effects.${kind}Many(${ctx.inputs.source}, ${ctx.inputs.targets}, ${ctx.inputs.amount}${kind === 'damage' ? ', ' + ctx.emitLiteral(ctx.parameters.damageType === 'true' ? 'true' : ctx.parameters.legacyNormalSpelling) : ''}${ctx.parameters.skillId === undefined ? '' : ', ' + ctx.emitLiteral(ctx.parameters.skillId)})`, ui: { category: 'effect' },
  })),
  define({
    id: 'damage.batch-kill-count', label: '本批伤害击杀数量', inputs: [{ name: 'result', type: 'record' }], outputs: [{ name: 'value', type: 'number' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `(${ctx.inputs.result}.results || []).filter(function(item) { return item.isKilled; }).length`, ui: { category: 'effect' },
  }),
  define({
    id: 'damage.batch-amount-at', label: '本批指定目标伤害', inputs: [{ name: 'result', type: 'record' }, { name: 'index', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `(${ctx.inputs.result}.results && ${ctx.inputs.result}.results[${ctx.inputs.index}] ? ${ctx.inputs.result}.results[${ctx.inputs.index}].damage : 0)`, ui: { category: 'effect' },
  }),
  define({
    id: 'text.join-list', label: '连接文本集合', inputs: [{ name: 'items', type: { kind: 'list', element: 'string' } }], outputs: [{ name: 'text', type: 'string' }],
    parameters: [{ name: 'separator', type: 'string', default: '' }], effects: { pure: true, previewSafe: false }, lower: ctx => `${ctx.inputs.items}.join(${ctx.emitLiteral(ctx.parameters.separator)})`, ui: { category: 'text' },
  }),
]
