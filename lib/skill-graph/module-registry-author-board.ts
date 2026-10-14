import type { GameplayModuleDescriptor, GameplayModuleSurface } from './module-types'

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const board = (surface: GameplayModuleSurface) => surface === 'pending' ? 'ctx.battle' : 'battle'
const flow = (surface: GameplayModuleSurface) => surface === 'pending' ? 'ctx.flow' : 'flow'
const ui = { category: 'selection', authoring: 'standard' } as const
const effects = { pure: true, previewSafe: false, reads: ['pieces', 'map', 'tile-effects'] } as const

export const AUTHOR_BOARD_VALUE_MODULES: readonly GameplayModuleDescriptor[] = [
  ...(['pieces', 'cells'] as const).map(kind => ({
    id: `author.query.${kind}`, version: '1', label: kind === 'pieces' ? '查询范围棋子' : '查询范围地格',
    inputs: [{ name: 'center', type: 'cell' as const, label: '中心地格' }, { name: 'minimum', type: 'number' as const, label: '最小距离', optional: true }, { name: 'maximum', type: 'number' as const, label: '最大距离' }],
    outputs: [{ name: 'items', type: { kind: 'list' as const, element: kind === 'pieces' ? 'piece' as const : 'cell' as const } }],
    allowedSurfaces: surfaces, effects, ui,
    lower: (ctx: Parameters<GameplayModuleDescriptor['lower']>[0]) => `(function(center,min,max){if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<min)throw new Error("范围不合法");return ${board(ctx.surface)}.${kind === 'pieces' ? 'pieces' : 'map.tiles'}.filter(function(item){var distance=Math.abs(item.x-center.x)+Math.abs(item.y-center.y);return ${kind === 'pieces' ? 'item.currentHp>0&&item.x!=null&&item.y!=null&&' : ''}distance>=Math.floor(min)&&distance<=Math.floor(max);}).map(function(item){return ${kind === 'pieces' ? 'item.instanceId' : '{x:item.x,y:item.y}'};});})(${ctx.inputs.center},${ctx.inputs.minimum ?? '1'},${ctx.inputs.maximum})`,
  })),
  {
    id: 'cell.field', version: '1', label: '地格字段',
    inputs: [{ name: 'cell', type: 'cell', label: '地格' }], outputs: [{ name: 'value', type: 'unknown' }],
    parameters: [{ name: 'field', type: 'string', label: '字段', enum: ['walkable', 'occupied', 'tileEffects', 'terrainType'] }],
    outputParameterTypeBindings: { value: { parameter: 'field', types: {
      walkable: 'boolean', occupied: 'boolean', tileEffects: { kind: 'list', element: 'record' },
      terrainType: { kind: 'nullable', value: 'string' },
    } } },
    allowedSurfaces: surfaces, effects, ui,
    lower: ctx => {
      const battle = board(ctx.surface)
      const content = ctx.parameters.field === 'walkable'
        ? `var tile=${battle}.map.tiles.find(function(tile){return tile.x===cell.x&&tile.y===cell.y;});if(!tile)throw new Error("地格不存在");return Boolean(tile.props.walkable);`
        : ctx.parameters.field === 'occupied'
          ? `return ${battle}.pieces.some(function(piece){return piece.currentHp>0&&piece.x===cell.x&&piece.y===cell.y;});`
          : ctx.parameters.field === 'tileEffects'
            ? `return (${battle}.extensions?.tileEffects||[]).filter(function(effect){return effect.x===cell.x&&effect.y===cell.y;}).map(function(effect){return JSON.parse(JSON.stringify(effect));});`
            : `var tile=${battle}.map.tiles.find(function(tile){return tile.x===cell.x&&tile.y===cell.y;});return tile&&tile.props&&typeof tile.props.type==="string"?tile.props.type:null;`
      return `(function(cell){return {value:(function(){${content}})()};})(${ctx.inputs.cell})`
    },
  },
  {
    id: 'tile.effect-field', version: '1', label: '地格效果字段',
    inputs: [{ name: 'effect', type: 'record', label: '地格效果' }], outputs: [{ name: 'value', type: 'unknown' }],
    parameters: [{ name: 'field', type: 'string', enum: ['tileType', 'sourceId', 'ownerPlayerId', 'x', 'y'], label: '字段' }],
    outputParameterTypeBindings: { value: { parameter: 'field', types: { tileType: 'string', sourceId: { kind: 'nullable', value: 'string' }, ownerPlayerId: { kind: 'nullable', value: 'player' }, x: 'number', y: 'number' } } },
    allowedSurfaces: surfaces, effects, ui,
    lower: ctx => `(function(effect){var value=effect[${ctx.emitLiteral(ctx.parameters.field)}];return {value:${['sourceId', 'ownerPlayerId'].includes(String(ctx.parameters.field)) ? 'value==null?null:value' : 'value===undefined?__gameplayInvalid:value'}};})(${ctx.inputs.effect})`,
  },
  {
    id: 'status.strength', version: '1', label: '状态强度',
    inputs: [{ name: 'piece', type: 'piece', label: '棋子' }, { name: 'statusType', type: 'string', label: '状态类型' }], outputs: [{ name: 'value', type: 'number' }],
    allowedSurfaces: surfaces, effects: { pure: true, previewSafe: false, reads: ['statuses'] }, ui,
    lower: ctx => `(${flow(ctx.surface)}.query.piece(${ctx.inputs.piece}).statusTags||[]).filter(function(status){return status.type===${ctx.inputs.statusType};}).reduce(function(total,status){return total+Number(status.intensity??status.stacks??1);},0)`,
  },
]
