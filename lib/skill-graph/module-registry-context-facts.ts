import type { GameplayModuleDescriptor as Descriptor, GameplayNativeLoweringContext as Context } from './module-types'
const state = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const context = (ctx: Context) => ctx.surface === 'pending' ? 'ctx' : 'context'
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: Descriptor['allowedSurfaces'] }): Descriptor => ({ version: '1', allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'], ...value })
export const CONTEXT_FACT_MODULES: readonly Descriptor[] = [
  define({
    id: 'choice.first-cell-reference', label: '读取首项选择的地格',
    inputs: [{ name: 'items', type: { kind: 'list', element: 'choice' } }], outputs: [{ name: 'cell', type: 'cell', nullable: true }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(function(items){var first=items[0];return first&&first.type==='cell'?{x:first.x,y:first.y}:null;})(${ctx.inputs.items})`, ui: { category: 'choice' },
  }),
  define({
    id: 'choice.first-piece-reference', label: '读取首项选择的棋子引用',
    inputs: [{ name: 'items', type: { kind: 'list', element: 'choice' } }], outputs: [{ name: 'piece', type: 'piece', nullable: true }],
    effects: { pure: true, previewSafe: true },
    lower: ctx => `(function(items){var first=items[0];return first&&first.type==='piece'?first.pieceId:null;})(${ctx.inputs.items})`, ui: { category: 'choice' },
  }),
  define({
    id: 'event.target-coordinate-cell', label: '读取事件目标坐标',
    inputs: [], outputs: [{ name: 'cell', type: 'cell' }],
    allowedSurfaces: ['rule', 'triggerSkill', 'pending'],
    effects: { pure: true, previewSafe: false, reads: ['event'] },
    lower: ctx => `({x:${context(ctx)}.targetX,y:${context(ctx)}.targetY})`, ui: { category: 'event' },
  }),
  define({
    id: 'choice.cell-options', label: '请求选择候选地格',
    inputs: [{ name: 'player', type: 'player' }, { name: 'cells', type: { kind: 'list', element: 'cell' } }, { name: 'title', type: 'string' }],
    outputs: [{ name: 'result', type: 'record' }],
    parameters: [
      { name: 'targetType', type: 'string', enum: ['cell', 'grid'] },
      { name: 'success', type: 'boolean', optional: true }, { name: 'range', type: 'number', optional: true },
      { name: 'filter', type: 'string', enum: ['all', 'ally', 'enemy'], optional: true },
      { name: 'selectionMode', type: 'string', enum: ['single', 'multi'], optional: true },
      { name: 'minSelections', type: 'number', optional: true }, { name: 'maxSelections', type: 'number', optional: true },
      { name: 'canCancel', type: 'boolean', optional: true }, { name: 'resumeOnCancel', type: 'boolean', optional: true },
    ],
    effects: { pure: true, previewSafe: false },
    lower: ctx => {
      const fields = ['targetType', 'success', 'range', 'filter', 'selectionMode', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel']
        .filter(key => Object.prototype.hasOwnProperty.call(ctx.parameters, key)).map(key => `${key}:${ctx.emitLiteral(ctx.parameters[key])}`).join(',')
      return `({needsTargetSelection:true,playerId:${ctx.inputs.player},title:${ctx.inputs.title},targetCandidates:(${ctx.inputs.cells}).map(function(cell){return {type:'cell',x:cell.x,y:cell.y};}),${fields}})`
    }, ui: { category: 'choice' },
  }),
  define({
    id: 'choice.context-piece-or-select', label: '使用已有目标或选择棋子',
    allowedSurfaces: ['skill', 'card', 'pending'],
    inputs: [], outputs: [{ name: 'choice', type: 'choice' }],
    parameters: [{ name: 'range', type: 'number' }, { name: 'filter', type: 'string', enum: ['enemy', 'ally', 'all'] }],
    effects: { pure: false, previewSafe: false, reads: ['execution-context'], writes: ['pending'], pending: true },
    lower: ctx => `(${context(ctx)}.target || ${ctx.surface === 'pending' ? 'ctx.flow.choice.target' : 'selectTarget'}({range:${ctx.emitLiteral(ctx.parameters.range)},filter:${ctx.emitLiteral(ctx.parameters.filter)}}))`, ui: { category: 'choice' },
  }),
  define({
    id: 'spatial.map-cells', label: '读取棋盘全部地格',
    inputs: [], outputs: [{ name: 'cells', type: { kind: 'list', element: 'cell' } }],
    effects: { pure: true, previewSafe: false, reads: ['map'] },
    lower: ctx => `${state(ctx)}.map.tiles.map(function(tile){return {x:tile.x,y:tile.y};})`, ui: { category: 'position' },
  }),
  define({
    id: 'ref.context-player', label: '上下文直接指定的玩家', description: '读取注入的玩家对象或玩家 ID，不回退到棋子所属玩家。',
    inputs: [], outputs: [{ name: 'player', type: 'player', nullable: true }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => `(${context(ctx)}.player ? ${context(ctx)}.player.playerId : ${context(ctx)}.playerId || null)`, ui: { category: 'context' },
  }),
  define({
    id: 'tile.remove-source-records', label: '移除指定来源的地格表现记录',
    inputs: [{ name: 'sourceId', type: 'string', nullable: true }], outputs: [{ name: 'success', type: 'boolean' }],
    effects: { pure: false, previewSafe: false, writes: ['tile-effects'] },
    lower: ctx => `(function(id){var extension=${state(ctx)}.extensions;if(!extension||!extension.tileEffects)return false;extension.tileEffects=extension.tileEffects.filter(function(item){return item.sourceId!==id;});return true;})(${ctx.inputs.sourceId})`, ui: { category: 'effect' },
  }),
  define({
    id: 'piece.set-stored-flag', label: '设置在场或墓地棋子表现标记',
    inputs: [{ name: 'id', type: 'string' }, { name: 'value', type: 'boolean' }], outputs: [{ name: 'success', type: 'boolean' }],
    parameters: [{ name: 'field', type: 'string', enum: ['showFreezeEffect'] }],
    effects: { pure: false, previewSafe: false, writes: ['pieces', 'graveyard'] },
    lower: ctx => `(function(id,value){var piece=(${state(ctx)}.pieces||[]).concat(${state(ctx)}.graveyard||[]).find(function(item){return item.instanceId===id;});if(!piece)return false;piece[${ctx.emitLiteral(ctx.parameters.field)}]=value;return true;})(${ctx.inputs.id},${ctx.inputs.value})`, ui: { category: 'presentation' },
  }),
]
