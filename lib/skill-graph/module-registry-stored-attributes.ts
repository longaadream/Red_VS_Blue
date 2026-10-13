import type { GameplayModuleDescriptor as Descriptor, GameplayNativeLoweringContext as Context } from './module-types'
const battle = (ctx: Context) => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'>): Descriptor => ({ version: '1', allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'], ...value })
export const STORED_ATTRIBUTE_MODULES: readonly Descriptor[] = [
  define({
    id: 'status.player-transfer-records', label: '读取玩家属性转移记录',
    inputs: [{ name: 'player', type: 'player', nullable: true }],
    outputs: [{ name: 'records', type: { kind: 'list', element: { kind: 'record', schema: 'attribute-transfer@1' } } }, { name: 'count', type: 'number' }, { name: 'exists', type: 'boolean' }],
    parameters: [{ name: 'statusType', type: 'string' }],
    effects: { pure: true, previewSafe: false, reads: ['players', 'statuses'] },
    lower: ctx => `(function(id){var player=(${battle(ctx)}.players||[]).find(function(p){return p.playerId===id;}),tags=player&&player.statusTags,records=(tags||[]).filter(function(tag){return tag.type===${ctx.emitLiteral(ctx.parameters.statusType)};}).map(function(tag){return {intensity:tag.intensity||0,sourceId:tag.sourceId||null,targetId:tag.targetId||null};});return {records:records,count:records.length,exists:Boolean(tags)};})(${ctx.inputs.player})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'attribute.read-stored', label: '读取在场或墓地棋子属性',
    inputs: [{ name: 'id', type: 'string', nullable: true }], outputs: [{ name: 'value', type: 'number' }, { name: 'exists', type: 'boolean' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange'] }],
    effects: { pure: true, previewSafe: false, reads: ['pieces', 'graveyard'] },
    lower: ctx => `(function(id){var piece=(${battle(ctx)}.pieces||[]).concat(${battle(ctx)}.graveyard||[]).find(function(p){return p.instanceId===id;});return {value:piece&&piece[${ctx.emitLiteral(ctx.parameters.attribute)}]||0,exists:Boolean(piece)};})(${ctx.inputs.id})`,
    ui: { category: 'attribute' },
  }),
  define({
    id: 'attribute.set-stored', label: '设置在场或墓地棋子属性',
    description: '仅写入封闭的非生命属性；不触发行动、复活或位置事件。',
    inputs: [{ name: 'id', type: 'string', nullable: true }, { name: 'value', type: 'number' }], outputs: [{ name: 'success', type: 'boolean' }],
    parameters: [{ name: 'attribute', type: 'string', enum: ['attack', 'defense', 'moveRange'] }],
    effects: { pure: false, previewSafe: false, writes: ['pieces', 'graveyard'] },
    lower: ctx => `(function(id,value){if(!Number.isFinite(value))throw new Error("Invalid stored attribute value");var piece=(${battle(ctx)}.pieces||[]).concat(${battle(ctx)}.graveyard||[]).find(function(p){return p.instanceId===id;});if(!piece)return false;piece[${ctx.emitLiteral(ctx.parameters.attribute)}]=value;return true;})(${ctx.inputs.id},${ctx.inputs.value})`,
    ui: { category: 'attribute' },
  }),
]
