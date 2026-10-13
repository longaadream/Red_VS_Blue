import type { GameplayModuleDescriptor, GameplayValueType } from './module-types'
const decode = (value: unknown): GameplayValueType => typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : value as GameplayValueType
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const AUTHOR_SUMMON_MODULES: readonly GameplayModuleDescriptor[] = [{
  id: 'author.effect.summon', version: '1', label: '召唤',
  description: '模板或原实例与落点逐项对应；单个模板应用于所有落点。显示配置在召唤事件前一次完成，省略字段保持原显示。',
  inputs: [{ name: 'source', type: 'piece', label: '来源' }, { name: 'template', type: 'record', label: '棋子' }, { name: 'destination', type: 'cell', label: '落点' }, { name: 'display', type: 'record', label: '显示选项', optional: true }],
  inputValueTypeBindings: { source: { parameter: 'sourceType' }, template: { parameter: 'templateType' }, destination: { parameter: 'destinationType' }, display: { parameter: 'displayType' } },
  outputs: [{ name: 'result', type: 'record', label: '召唤结果' }],
  parameters: [
    { name: 'mode', type: 'string', label: '召唤方式', enum: ['new-instance', 'return-instance'], default: 'new-instance' },
    { name: 'sourceType', type: 'string', label: '来源类型', enum: ['piece', 'record'], default: 'piece' },
    { name: 'templateType', type: 'string', default: 'record', label: '棋子类型' },
    { name: 'destinationType', type: 'string', default: 'cell', label: '落点类型' },
    { name: 'displayType', type: 'string', default: 'record', label: '显示类型' },
    { name: 'currentHp', type: 'number', optional: true, label: '回场生命值' },
  ],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: false, previewSafe: false, writes: ['summon'], events: ['beforePieceSummoned', 'afterPieceSummoned'] },
  ui: { category: 'lifecycle', authoring: 'standard' },
  lower: ctx => {
    const sourceType = ctx.parameters.sourceType ?? 'piece'
    if (sourceType !== 'piece' && sourceType !== 'record') throw new Error('召唤来源类型不正确')
    const cell = decode(ctx.parameters.destinationType), piece = decode(ctx.parameters.templateType), display = decode(ctx.parameters.displayType)
    const atom = typeof piece === 'object' && piece.kind === 'list' ? piece.element : piece
    if (!same(cell, 'cell') && !same(cell, { kind: 'list', element: 'cell' })) throw new Error('召唤落点须为地格或地格元组')
    if (ctx.parameters.mode === 'return-instance' ? atom !== 'piece' : atom !== 'record' && !(typeof atom === 'object' && atom.kind === 'record')) throw new Error('召唤棋子类型不正确')
    if (display !== 'record' && !(typeof display === 'object' && display.kind === 'record')) throw new Error('显示选项须为结构体')
    const flow = ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
    return `({result:${flow}.lifecycle.summonAuthored(${ctx.inputs.source},${ctx.inputs.template},${ctx.inputs.destination},${ctx.inputs.display ?? '{}'},${ctx.emitLiteral(ctx.parameters.mode)},${ctx.parameters.currentHp === undefined ? 'undefined' : ctx.emitLiteral(ctx.parameters.currentHp)})})`
  },
}, {
  id: 'author.effect.summon', version: '2', label: '召唤',
  description: '统一召唤入口：可新建棋子、让原实例回场，或使用当前内容声明按已验证能力排队召唤。声明模式不填写模板和显示选项。',
  inputs: [
    { name: 'source', type: 'piece', label: '来源' },
    { name: 'template', type: 'record', label: '棋子', optional: true },
    { name: 'destination', type: 'cell', label: '落点' },
    { name: 'display', type: 'record', label: '显示选项', optional: true },
  ],
  inputValueTypeBindings: { source: { parameter: 'sourceType' }, template: { parameter: 'templateType' }, destination: { parameter: 'destinationType' }, display: { parameter: 'displayType' } },
  outputs: [{ name: 'result', type: 'record', label: '召唤结果' }],
  parameters: [
    { name: 'mode', type: 'string', label: '召唤方式', enum: ['new-instance', 'return-instance', 'declaration'], default: 'new-instance' },
    { name: 'sourceType', type: 'string', label: '来源类型', enum: ['piece', 'record'], default: 'piece' },
    { name: 'templateType', type: 'string', default: 'record', label: '棋子类型' },
    { name: 'destinationType', type: 'string', default: 'cell', label: '落点类型' },
    { name: 'displayType', type: 'string', default: 'record', label: '显示类型' },
    { name: 'currentHp', type: 'number', optional: true, label: '回场生命值' },
  ],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: false, previewSafe: false, writes: ['summon'], events: ['beforePieceSummoned', 'afterPieceSummoned'] },
  ui: { category: 'lifecycle', authoring: 'standard' },
  lower: ctx => {
    const sourceType = ctx.parameters.sourceType ?? 'piece'
    if (sourceType !== 'piece' && sourceType !== 'record') throw new Error('召唤来源类型不正确')
    const mode = ctx.parameters.mode ?? 'new-instance'
    if (mode !== 'new-instance' && mode !== 'return-instance' && mode !== 'declaration') throw new Error('召唤方式不正确')
    const cell = decode(ctx.parameters.destinationType)
    if (!same(cell, 'cell') && !same(cell, { kind: 'list', element: 'cell' })) throw new Error('召唤落点须为地格或地格元组')
    const flow = ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
    if (mode === 'declaration') {
      if (ctx.inputs.template !== undefined || ctx.inputs.display !== undefined) throw new Error('使用当前内容声明时不填写棋子模板或显示选项')
      return `({result:${flow}.lifecycle.summonDeclared(${ctx.inputs.source},${ctx.inputs.destination})})`
    }
    if (typeof ctx.inputs.template !== 'string' || ctx.inputs.template.length === 0) throw new Error('召唤棋子不能为空')
    const piece = decode(ctx.parameters.templateType)
    const display = decode(ctx.parameters.displayType)
    const atom = typeof piece === 'object' && piece.kind === 'list' ? piece.element : piece
    if (mode === 'return-instance' ? atom !== 'piece' : atom !== 'record' && !(typeof atom === 'object' && atom.kind === 'record')) throw new Error('召唤棋子类型不正确')
    if (display !== 'record' && !(typeof display === 'object' && display.kind === 'record')) throw new Error('显示选项须为结构体')
    return `({result:${flow}.lifecycle.summonAuthored(${ctx.inputs.source},${ctx.inputs.template},${ctx.inputs.destination},${ctx.inputs.display ?? '{}'},${ctx.emitLiteral(mode)},${ctx.parameters.currentHp === undefined ? 'undefined' : ctx.emitLiteral(ctx.parameters.currentHp)})})`
  },
}, {
  id: 'author.piece.display', version: '1', label: '设置棋子显示', description: '按同名字段更新显示快照；不改变真实规则或数值。',
  inputs: [{ name: 'target', type: 'piece', label: '棋子' }, { name: 'display', type: 'record', label: '显示选项' }],
  inputValueTypeBindings: { display: { parameter: 'displayType' } },
  outputs: [{ name: 'reference', type: 'string', label: '显示引用' }],
  parameters: [{ name: 'displayType', type: 'string', default: 'record', label: '显示类型' }, { name: 'audience', type: 'string', label: '可见对象', default: 'public', enum: ['public', 'owner', 'allies', 'enemies', 'spectators'] }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: false, previewSafe: false, writes: ['presentation'] }, ui: { category: 'presentation', authoring: 'standard' },
  lower: ctx => `${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.presentation.setDisplay(${ctx.inputs.target},${ctx.inputs.display},${ctx.emitLiteral(ctx.parameters.audience)})`,
}]
