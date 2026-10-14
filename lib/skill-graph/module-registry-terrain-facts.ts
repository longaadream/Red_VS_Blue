import type { GameplayModuleDescriptor } from './module-types'

export const TERRAIN_FACT_MODULES: readonly GameplayModuleDescriptor[] = [{
  id: 'spatial.cell-terrain-in', version: '1', label: '地格属于允许的地形',
  inputs: [{ name: 'cell', type: 'cell' }], outputs: [{ name: 'value', type: 'boolean' }],
  parameters: [{ name: 'types', type: { kind: 'list', element: 'string' } }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
  effects: { pure: true, previewSafe: true, reads: ['map'] },
  lower: ctx => `(function(cell){var tile=(${ctx.surface === 'pending' ? 'ctx.battle' : 'battle'}.map.tiles||[]).find(function(t){return t.x===cell.x&&t.y===cell.y;});return Boolean(tile&&tile.props&&${ctx.emitLiteral(ctx.parameters.types)}.indexOf(tile.props.type)>=0);})(${ctx.inputs.cell})`,
  ui: { category: 'position' },
}]
