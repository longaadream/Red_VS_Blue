import type { GameplayModuleDescriptor as Descriptor, GameplayModuleSurface, GameplayNativeLoweringContext as Context } from './module-types'

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const flow = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const define = (item: Omit<Descriptor, 'version' | 'allowedSurfaces'>): Descriptor => ({ version: '1', allowedSurfaces: surfaces, ...item })

/** Closed ability operations; no arbitrary field names or executable payloads. */
export const ABILITY_GAMEPLAY_MODULES: readonly Descriptor[] = [
  define({
    id: 'compare.allied-players', label: '玩家是否为队友',
    inputs: [{ name: 'left', type: 'player' }, { name: 'right', type: 'player' }], outputs: [{ name: 'value', type: 'boolean' }],
    effects: { pure: true, previewSafe: false, reads: ['players'] },
    lower: ctx => `${flow(ctx)}.query.alliedPlayers(${ctx.inputs.left}, ${ctx.inputs.right})`, ui: { category: 'condition' },
  }),
  define({
    id: 'skill.identifiers', label: '读取棋子技能列表',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'ids', type: { kind: 'list', element: 'string' } }],
    effects: { pure: true, previewSafe: false, reads: ['skills'] },
    lower: ctx => `${flow(ctx)}.query.piece(${ctx.inputs.piece}).skills.map(function(skill) { return skill.skillId; })`, ui: { category: 'skill' },
  }),
  ...(['read', 'mark'] as const).map(operation => define({
    id: operation === 'read' ? 'ability.was-spent' : 'ability.mark-spent', label: operation === 'read' ? '能力已消耗本局次数' : '记录能力已消耗',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: operation === 'read' ? [{ name: 'value', type: 'boolean' }] : [],
    parameters: [{ name: 'abilityId', type: 'string' }],
    effects: { pure: operation === 'read', previewSafe: false, ...(operation === 'read' ? { reads: ['skills'] } : { writes: ['skills'] }) },
    lower: ctx => `${flow(ctx)}.skills.${operation === 'read' ? 'wasSpent' : 'markSpent'}(${ctx.inputs.piece}, ${ctx.emitLiteral(ctx.parameters.abilityId)})`, ui: { category: 'skill' },
  })),
  define({
    id: 'spatial.cell-delta', label: '计算地格位移',
    inputs: [{ name: 'from', type: 'cell' }, { name: 'to', type: 'cell' }], outputs: [{ name: 'dx', type: 'number' }, { name: 'dy', type: 'number' }, { name: 'chebyshev', type: 'number' }, { name: 'orthogonal', type: 'boolean' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `(function(from, to) { var dx = to.x - from.x, dy = to.y - from.y; return {dx: dx, dy: dy, chebyshev: Math.max(Math.abs(dx), Math.abs(dy)), orthogonal: (dx === 0) !== (dy === 0)}; })(${ctx.inputs.from}, ${ctx.inputs.to})`, ui: { category: 'position' },
  }),
  define({
    id: 'piece.name-or', label: '读取可选棋子名称',
    inputs: [{ name: 'piece', type: 'piece', nullable: true }, { name: 'fallback', type: 'string' }], outputs: [{ name: 'text', type: 'string' }],
    effects: { pure: true, previewSafe: false, reads: ['pieces'] }, lower: ctx => `(${flow(ctx)}.query.hasPiece(${ctx.inputs.piece}) ? String(${flow(ctx)}.query.piece(${ctx.inputs.piece}).name) : ${ctx.inputs.fallback})`, ui: { category: 'query' },
  }),
  define({
    id: 'resource.limit', label: '读取资源上限',
    inputs: [{ name: 'player', type: 'player' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'resource', type: 'string', enum: ['actionPoints'] }],
    effects: { pure: true, previewSafe: false, reads: ['players', 'resources'] },
    lower: ctx => `${flow(ctx)}.query.player(${ctx.inputs.player})[${ctx.emitLiteral('maxActionPoints')}]`, ui: { category: 'query' },
  }),
  define({
    id: 'compare.text', label: '比较文本是否相同',
    inputs: [{ name: 'left', type: 'string', nullable: true }, { name: 'right', type: 'string', nullable: true }], outputs: [{ name: 'value', type: 'boolean' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `(${ctx.inputs.left} === ${ctx.inputs.right})`, ui: { category: 'condition' },
  }),
  define({
    id: 'value.select-text', label: '按条件选择文本',
    inputs: [{ name: 'condition', type: 'boolean' }, { name: 'whenTrue', type: 'string' }, { name: 'whenFalse', type: 'string' }], outputs: [{ name: 'text', type: 'string' }],
    effects: { pure: true, previewSafe: false }, lower: ctx => `(${ctx.inputs.condition} ? ${ctx.inputs.whenTrue} : ${ctx.inputs.whenFalse})`, ui: { category: 'logic' },
  }),
  ...(['min', 'max'] as const).map(operation => ({
    ...define({
      id: `math.${operation}`, label: operation === 'min' ? '取较小值' : '取较大值',
      inputs: [{ name: 'left', type: 'number' }, { name: 'right', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
      effects: { pure: true, previewSafe: true },
      lower: ctx => `Math.${operation}(${ctx.inputs.left}, ${ctx.inputs.right})`, ui: { category: 'value' },
    }), allowedSurfaces: [...surfaces, 'preview' as const],
  })),
  ...(['add', 'remove'] as const).map(operation => define({
    id: `skill.${operation}`, label: operation === 'add' ? '获得技能' : '移除技能',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'success', type: 'boolean' }],
    parameters: [{ name: 'skillId', type: 'string' }],
    effects: { writes: ['skills'], pure: false, previewSafe: false },
    lower: ctx => `Boolean(${flow(ctx)}.skills.${operation}(${ctx.inputs.piece}, ${ctx.emitLiteral(ctx.parameters.skillId)}))`,
    ui: { category: 'skill' },
  })),
  define({
    id: 'rule.has-piece', label: '棋子具有规则',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'boolean' }],
    parameters: [{ name: 'ruleId', type: 'string' }], effects: { reads: ['rules'], pure: true, previewSafe: false },
    lower: ctx => `(${flow(ctx)}.query.piece(${ctx.inputs.piece}).rules || []).some(function(rule) { return rule.id === ${ctx.emitLiteral(ctx.parameters.ruleId)}; })`,
    ui: { category: 'rule' },
  }),
  define({
    id: 'attribute.set', label: '设定棋子属性',
    inputs: [{ name: 'piece', type: 'piece' }, { name: 'value', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange'] }],
    effects: { writes: ['attributes'], pure: false, previewSafe: false },
    lower: ctx => `${flow(ctx)}.attributes.set(${ctx.inputs.piece}, ${ctx.emitLiteral(ctx.parameters.attribute)}, ${ctx.inputs.value})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'identity.host-time', label: '宿主标识时间',
    description: '读取现役 SkillCode 宿主绑定的 Date.now，保持既有标识生成及回放语义；不访问外部时钟。',
    inputs: [], outputs: [{ name: 'value', type: 'number' }], effects: { reads: ['runtime-identity'], pure: false, previewSafe: false },
    lower: () => 'Date.now()', ui: { category: 'context' },
  }),
]
