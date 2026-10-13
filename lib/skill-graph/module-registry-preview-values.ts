import type { GameplayModuleDescriptor as Descriptor, GameplayModuleSurface } from './module-types'

const surfaces: readonly GameplayModuleSurface[] = Object.freeze(['preview'] as const)
const define = (item: Omit<Descriptor, 'version' | 'allowedSurfaces'>, allowedSurfaces = surfaces): Descriptor => ({ version: '1', allowedSurfaces, ...item })

/**
 * Pure preview readers and selectors used by the ordinary preview migration.
 *
 * Attribute parameters are closed enums. Preview authors cannot provide a
 * path, callback, or source expression; the lowerers are trusted host
 * adapters. Status types and numeric fallbacks remain typed scalar values.
 */
export const PREVIEW_VALUE_GAMEPLAY_MODULES: readonly Descriptor[] = [
  define({
    id: 'preview.piece-number-nan', label: '预览棋子数值（保留缺省数值）',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'], default: 'attack' }],
    effects: { pure: true, previewSafe: true, reads: ['preview-piece'] },
    // Number(undefined) intentionally preserves the legacy arithmetic result
    // (NaN) while keeping the author graph closed over attribute names.
    lower: ctx => `Number((${ctx.inputs.piece})[${ctx.emitLiteral(ctx.parameters.attribute)}])`,
    ui: { category: 'preview' },
  }),
  define({
    id: 'preview.piece-number-or-zero', label: '预览棋子数值（缺省为零）',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'], default: 'attack' }],
    effects: { pure: true, previewSafe: true, reads: ['preview-piece'] },
    lower: ctx => `(${ctx.inputs.piece})[${ctx.emitLiteral(ctx.parameters.attribute)}] || 0`,
    ui: { category: 'preview' },
  }),
  define({
    id: 'preview.piece-max-hp', label: '预览棋子生命上限',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'fallback', type: 'number', default: 18 }],
    effects: { pure: true, previewSafe: true, reads: ['preview-piece'] },
    lower: ctx => {
      const fallback = typeof ctx.parameters.fallback === 'number' ? ctx.parameters.fallback : 18
      return `(${ctx.inputs.piece})["maxHp"] || ((${ctx.inputs.piece})["stats"] && (${ctx.inputs.piece})["stats"]["maxHp"]) || ${ctx.emitLiteral(fallback)}`
    },
    ui: { category: 'preview' },
  }),
  define({
    id: 'preview.skill-text', label: '预览技能文本',
    inputs: [{ name: 'skill', type: 'content' }], outputs: [{ name: 'value', type: 'string' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['description'], default: 'description' }],
    effects: { pure: true, previewSafe: true, reads: ['preview-skill'] },
    lower: ctx => `(${ctx.inputs.skill})[${ctx.emitLiteral(ctx.parameters.attribute)}]`,
    ui: { category: 'preview' },
  }),
  define({
    id: 'preview.skill-number-nan', label: '预览技能数值（保留缺省数值）',
    inputs: [{ name: 'skill', type: 'content' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['powerMultiplier', 'actionPointCost', 'chargeCost', 'cooldown'], default: 'powerMultiplier' }],
    effects: { pure: true, previewSafe: true, reads: ['preview-skill'] },
    lower: ctx => `Number((${ctx.inputs.skill})[${ctx.emitLiteral(ctx.parameters.attribute)}])`,
    ui: { category: 'preview' },
  }),
  define({
    id: 'preview.piece-status-number', label: '预览棋子状态数值',
    inputs: [{ name: 'piece', type: 'piece' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [
      { name: 'statusType', type: 'string', default: 'shishio-kills' },
      { name: 'attribute', type: 'string', enum: ['intensity'], default: 'intensity' },
    ],
    effects: { pure: true, previewSafe: true, reads: ['preview-piece-status'] },
    lower: ctx => `(((${ctx.inputs.piece})["statusTags"] || []).find(function(tag) { return tag["type"] === ${ctx.emitLiteral(ctx.parameters.statusType)}; }) || {})[${ctx.emitLiteral(ctx.parameters.attribute)}] || 0`,
    ui: { category: 'preview' },
  }),
  define({
    id: 'logic.select-number', label: '按条件选择数值',
    inputs: [
      { name: 'condition', type: 'boolean' },
      { name: 'whenTrue', type: 'number', optional: true, nullable: true },
      { name: 'whenFalse', type: 'number', optional: true, nullable: true },
    ],
    outputs: [{ name: 'value', type: 'number' }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(${ctx.inputs.condition} ? ${ctx.inputs.whenTrue} : ${ctx.inputs.whenFalse})`,
    ui: { category: 'logic' },
  }, ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']),
]

export default PREVIEW_VALUE_GAMEPLAY_MODULES
