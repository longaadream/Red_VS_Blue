import type { GameplayModuleDescriptor } from './module-types'

/** Preview host values are read-only and have a fixed, closed attribute set. */
export const PREVIEW_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = [
  {
    id: 'preview.piece-number', version: '1', label: '预览棋子数值',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'], default: 'attack' }],
    allowedSurfaces: ['preview'], effects: { pure: true, previewSafe: true, reads: ['preview-piece'] },
    lower: ctx => `(${ctx.inputs.piece})[${ctx.emitLiteral(ctx.parameters.attribute)}]`, ui: { category: 'preview' },
  },
  {
    id: 'preview.skill-number', version: '1', label: '预览技能数值',
    inputs: [{ name: 'skill', type: 'content' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['powerMultiplier', 'actionPointCost', 'chargeCost', 'cooldown'], default: 'powerMultiplier' }],
    allowedSurfaces: ['preview'], effects: { pure: true, previewSafe: true, reads: ['preview-skill'] },
    lower: ctx => `(${ctx.inputs.skill})[${ctx.emitLiteral(ctx.parameters.attribute)}]`, ui: { category: 'preview' },
  },
  {
    id: 'preview.result', version: '1', label: '技能预览结果',
    inputs: [{ name: 'description', type: 'string' }, ...['damage', 'heal', 'attackBonus', 'selfDamage'].map(name => ({ name, type: 'number' as const, optional: true }))],
    outputs: [{ name: 'result', type: 'record' }], allowedSurfaces: ['preview'], effects: { pure: true, previewSafe: true },
    lower: ctx => `({description: ${ctx.inputs.description}, expectedValues: {${['damage', 'heal', 'attackBonus', 'selfDamage'].filter(name => ctx.inputs[name] !== undefined).map(name => `${name}: ${ctx.inputs[name]}`).join(', ')}}})`,
    ui: { category: 'preview' },
  },
]
