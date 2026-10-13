import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor as Descriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext as Context,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Closed adapters for the legacy Recall extension.
 *
 * Recall's author graphs own the record schema, field reads, filtering,
 * counting, movement and cleanup. These descriptors only bridge the fixed
 * legacy `recallData` storage shape and the few piece fields that do not yet
 * have a shared attribute adapter. In particular, there is no atomic
 * capture/restore operation here: every saved field is independently visible
 * in the graph and independently writable at resolution time.
 */

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'triggerSkill']
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const recordValueListType: GameplayValueType = { kind: 'list', element: 'record' }
const recallRecordType: GameplayValueType = { kind: 'record', schema: 'recall-record@1' }
const recallRecordListType: GameplayValueType = { kind: 'list', element: recallRecordType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[]): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains })
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'>): Descriptor => ({ version: '1', allowedSurfaces: surfaces, ...value })
const flow = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const context = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx' : 'context'
const battle = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const input = (ctx: Context, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

const recallData = (ctx: Context): string => `(${battle(ctx)}.extensions&&${battle(ctx)}.extensions.recallData)`

/**
 * Return a flat, typed view of both the current adapter format and records
 * written by the pre-module legacy implementation. The returned objects are
 * deliberately detached from the extension array: record.with and field
 * reads cannot mutate storage behind the graph's back.
 */
const normalizedRecords = (ctx: Context): string => `(function(data){return (Array.isArray(data)?data:[]).slice().reverse().map(function(raw){var snapshot=raw&&raw.snapshot&&typeof raw.snapshot==='object'?raw.snapshot:null;return {pieceId:raw&&raw.pieceId,ownerPlayerId:raw&&raw.ownerPlayerId,projectionVisibility:raw&&raw.projectionVisibility,targetCount:raw&&raw.targetCount,actionCount:raw&&raw.actionCount,x:raw&&raw.x!==undefined?raw.x:(snapshot&&snapshot.x),y:raw&&raw.y!==undefined?raw.y:(snapshot&&snapshot.y),hp:raw&&raw.hp!==undefined?raw.hp:(snapshot&&snapshot.hp),shield:raw&&Object.prototype.hasOwnProperty.call(raw,'shield')?raw.shield:(snapshot&&snapshot.shield),statusTags:Array.isArray(raw&&raw.statusTags)?raw.statusTags:(snapshot&&Array.isArray(snapshot.statusTags)?snapshot.statusTags:undefined),buffs:Array.isArray(raw&&raw.buffs)?raw.buffs:(snapshot&&Array.isArray(snapshot.buffs)?snapshot.buffs:undefined),debuffs:Array.isArray(raw&&raw.debuffs)?raw.debuffs:(snapshot&&Array.isArray(snapshot.debuffs)?snapshot.debuffs:undefined)};});})(${recallData(ctx)})`

export const RECALL_GAMEPLAY_MODULES: readonly Descriptor[] = [
  define({
    id: 'recall.selected-count',
    label: '读取回溯次数',
    description: '读取宿主已确认的回溯操作数并转为数值；未确认或非法选项由图上的范围条件拒绝。',
    inputs: [], outputs: [port('value', numberType)],
    effects: pure(['context', 'choice']),
    lower: ctx => `Number(${context(ctx)}.selectedOption)`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'recall.piece-reference',
    label: '保存棋子引用',
    description: '把已查询棋子的稳定实例标识保存到回溯记录；不会复制可变棋子对象。',
    inputs: [port('piece', pieceType)], outputs: [port('piece', pieceType)],
    effects: pure(['pieces']),
    lower: ctx => `(${flow(ctx)}.query.piece(${input(ctx, 'piece')}).instanceId)`,
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.read-shield',
    label: '读取护盾',
    description: '读取记录允许保存的护盾字段；缺少护盾时保留空值。',
    inputs: [port('piece', pieceType)], outputs: [port('value', numberType, { nullable: true })],
    effects: pure(['pieces']),
    lower: ctx => `${flow(ctx)}.query.piece(${input(ctx, 'piece')}).shield`,
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.read-status-tags',
    label: '读取状态标签',
    description: '读取并复制登记的状态标签列表；字段集合由回溯记录 schema 固定。',
    inputs: [port('piece', pieceType)], outputs: [port('value', recordValueListType)],
    effects: pure(['pieces', 'statuses']),
    lower: ctx => `(function(piece){return Array.isArray(piece&&piece.statusTags)?JSON.parse(JSON.stringify(piece.statusTags)):[];})(${flow(ctx)}.query.piece(${input(ctx, 'piece')}))`,
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.read-buffs',
    label: '读取增益',
    description: '读取并复制登记的增益列表；字段集合由回溯记录 schema 固定。',
    inputs: [port('piece', pieceType)], outputs: [port('value', recordValueListType)],
    effects: pure(['pieces', 'statuses']),
    lower: ctx => `(function(piece){return Array.isArray(piece&&piece.buffs)?JSON.parse(JSON.stringify(piece.buffs)):[];})(${flow(ctx)}.query.piece(${input(ctx, 'piece')}))`,
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.read-debuffs',
    label: '读取减益',
    description: '读取并复制登记的减益列表；字段集合由回溯记录 schema 固定。',
    inputs: [port('piece', pieceType)], outputs: [port('value', recordValueListType)],
    effects: pure(['pieces', 'statuses']),
    lower: ctx => `(function(piece){return Array.isArray(piece&&piece.debuffs)?JSON.parse(JSON.stringify(piece.debuffs)):[];})(${flow(ctx)}.query.piece(${input(ctx, 'piece')}))`,
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.store-record',
    label: '保存回溯记录',
    description: '把图中已构造的固定字段记录写入旧 recallData 适配器；只序列化登记字段，不接受任意对象路径。',
    inputs: [port('record', recallRecordType)], outputs: [port('success', booleanType)],
    effects: writes(['extensions']),
    lower: ctx => `(function(record){if(!record||record.pieceId==null||!Number.isInteger(record.targetCount)||record.targetCount<1||record.targetCount>10)return false;${battle(ctx)}.extensions=${battle(ctx)}.extensions||{};var data=Array.isArray(${battle(ctx)}.extensions.recallData)?${battle(ctx)}.extensions.recallData:[];data=data.filter(function(item){return !item||item.pieceId!==record.pieceId;});data.push({pieceId:record.pieceId,ownerPlayerId:record.ownerPlayerId,projectionVisibility:record.projectionVisibility,targetCount:record.targetCount,actionCount:record.actionCount,snapshot:{x:record.x,y:record.y,hp:record.hp,shield:record.shield,statusTags:record.statusTags?JSON.parse(JSON.stringify(record.statusTags)):[],buffs:record.buffs?JSON.parse(JSON.stringify(record.buffs)):[],debuffs:record.debuffs?JSON.parse(JSON.stringify(record.debuffs)):[]}});${battle(ctx)}.extensions.recallData=data;return true;})(${input(ctx, 'record')})`,
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.records',
    label: '读取回溯记录',
    description: '按旧触发器的逆序读取固定回溯记录，并将旧嵌套快照转换为图可编辑的扁平记录。',
    inputs: [], outputs: [port('records', recallRecordListType)],
    effects: pure(['extensions']),
    lower: ctx => normalizedRecords(ctx),
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.record-for-holder',
    label: '检查记录所属棋子',
    description: '按固定 pieceId 字段过滤当前触发规则持有的记录。',
    inputs: [port('record', recallRecordType), port('holder', pieceType)], outputs: [port('value', booleanType)],
    effects: pure(['extensions', 'pieces']),
    lower: ctx => `(function(record,holderId){return Boolean(record&&holderId!=null&&record.pieceId===holderId);})(${input(ctx, 'record')},${input(ctx, 'holder')})`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'recall.record-opposed',
    label: '检查触发者敌对',
    description: '按登记的记录归属和当前事件玩家判断敌对关系，使用队伍映射而非字符串比较。',
    inputs: [port('record', recallRecordType), port('actor', playerType, { nullable: true, optional: true })], outputs: [port('value', booleanType)],
    effects: pure(['extensions', 'players']),
    lower: ctx => `(function(record,actor){if(!record||actor==null||record.ownerPlayerId==null)return false;return !${flow(ctx)}.query.alliedPlayers(actor,record.ownerPlayerId);})(${input(ctx, 'record')},${input(ctx, 'actor')})`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'recall.source-owner',
    label: '读取事件来源归属',
    description: '读取事件上下文来源棋子的归属；来源离场后仍保留事件句柄，缺少来源时返回空值。',
    inputs: [], outputs: [port('player', playerType, { nullable: true })],
    effects: pure(['context']),
    lower: ctx => `(${context(ctx)}.sourcePiece?${context(ctx)}.sourcePiece.ownerPlayerId:null)`,
    ui: { category: 'context' },
  }),
  define({
    id: 'recall.source-present',
    label: '检查事件来源存在',
    description: '检查当前事件是否带有来源棋子句柄；来源可能已死亡但仍由事件上下文保留。',
    inputs: [], outputs: [port('value', booleanType)],
    effects: pure(['context']),
    lower: ctx => `Boolean(${context(ctx)}.sourcePiece)`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'recall.opposed-players',
    label: '检查两个归属敌对',
    description: '用权威队伍关系判断两个玩家归属是否敌对，允许事件来源已离场。',
    inputs: [port('actor', playerType, { nullable: true }), port('owner', playerType, { nullable: true })],
    outputs: [port('value', booleanType)],
    effects: pure(['players']),
    lower: ctx => `(function(actor,owner){return Boolean(actor!=null&&owner!=null&&!${flow(ctx)}.query.alliedPlayers(actor,owner));})(${input(ctx, 'actor')},${input(ctx, 'owner')})`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'recall.record-piece-present',
    label: '检查回溯棋子存在',
    description: '判断记录中的棋子仍在权威战斗棋子集合中；正式离场的棋子不会被重新创建。',
    inputs: [port('record', recallRecordType)], outputs: [port('value', booleanType)],
    effects: pure(['extensions', 'pieces']),
    lower: ctx => `(function(record){return Boolean(record&&record.pieceId!=null&&${flow(ctx)}.query.hasPiece(record.pieceId));})(${input(ctx, 'record')})`,
    ui: { category: 'condition' },
  }),
  define({
    id: 'recall.replace-count',
    label: '更新回溯动作计数',
    description: '只更新旧适配器中的 actionCount 字段；其他记录字段由 graph record.with 保留。',
    inputs: [port('record', recallRecordType)], outputs: [port('success', booleanType)],
    effects: writes(['extensions']),
    lower: ctx => `(function(record){var data=${recallData(ctx)};if(!Array.isArray(data)||!record||record.pieceId==null)return false;for(var index=0;index<data.length;index+=1){if(data[index]&&data[index].pieceId===record.pieceId){data[index].actionCount=record.actionCount;return true;}}return false;})(${input(ctx, 'record')})`,
    ui: { category: 'record' },
  }),
  define({
    id: 'recall.restore-hp',
    label: '恢复生命',
    description: '在权威位移成功后只恢复记录中的生命字段，并按棋子最大生命上限裁剪。',
    inputs: [port('piece', pieceType), port('value', numberType)], outputs: [port('success', booleanType)],
    effects: writes(['pieces']),
    lower: ctx => `(function(pieceId,value){var piece=pieceId!=null&&${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId):null;if(!piece||typeof value!=='number'||!Number.isFinite(value))return false;piece.currentHp=Math.min(value,piece.maxHp);return true;})(${input(ctx, 'piece')},${input(ctx, 'value')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'recall.restore-shield',
    label: '恢复护盾',
    description: '在权威位移成功后只恢复记录中的护盾字段；缺少该字段时不写入。',
    inputs: [port('piece', pieceType), port('value', numberType, { nullable: true, optional: true })], outputs: [port('success', booleanType)],
    effects: writes(['pieces']),
    lower: ctx => `(function(pieceId,value){var piece=pieceId!=null&&${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId):null;if(!piece||value===undefined)return false;piece.shield=value;return true;})(${input(ctx, 'piece')},${input(ctx, 'value')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'recall.restore-status-tags',
    label: '恢复状态标签',
    description: '在权威位移成功后只替换记录中的状态标签列表。',
    inputs: [port('piece', pieceType), port('value', recordValueListType, { nullable: true, optional: true })], outputs: [port('success', booleanType)],
    effects: writes(['statuses']),
    lower: ctx => `(function(pieceId,value){var piece=pieceId!=null&&${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId):null;if(!piece||!Array.isArray(value))return false;piece.statusTags=JSON.parse(JSON.stringify(value));return true;})(${input(ctx, 'piece')},${input(ctx, 'value')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'recall.restore-buffs',
    label: '恢复增益',
    description: '在权威位移成功后只替换记录中的增益列表。',
    inputs: [port('piece', pieceType), port('value', recordValueListType, { nullable: true, optional: true })], outputs: [port('success', booleanType)],
    effects: writes(['statuses']),
    lower: ctx => `(function(pieceId,value){var piece=pieceId!=null&&${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId):null;if(!piece||!Array.isArray(value))return false;piece.buffs=JSON.parse(JSON.stringify(value));return true;})(${input(ctx, 'piece')},${input(ctx, 'value')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'recall.restore-debuffs',
    label: '恢复减益',
    description: '在权威位移成功后只替换记录中的减益列表。',
    inputs: [port('piece', pieceType), port('value', recordValueListType, { nullable: true, optional: true })], outputs: [port('success', booleanType)],
    effects: writes(['statuses']),
    lower: ctx => `(function(pieceId,value){var piece=pieceId!=null&&${flow(ctx)}.query.hasPiece(pieceId)?${flow(ctx)}.query.piece(pieceId):null;if(!piece||!Array.isArray(value))return false;piece.debuffs=JSON.parse(JSON.stringify(value));return true;})(${input(ctx, 'piece')},${input(ctx, 'value')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'recall.remove',
    label: '移除回溯记录',
    description: '按固定 pieceId 从 recallData 集合移除当前记录，不改变其他棋子的记录。',
    inputs: [port('record', recallRecordType)], outputs: [port('success', booleanType)],
    effects: writes(['extensions']),
    lower: ctx => `(function(record){var data=${recallData(ctx)};if(!Array.isArray(data)||!record||record.pieceId==null)return false;var index=data.findIndex(function(item){return item&&item.pieceId===record.pieceId;});if(index<0)return false;data.splice(index,1);return true;})(${input(ctx, 'record')})`,
    ui: { category: 'record' },
  }),
]

export default RECALL_GAMEPLAY_MODULES
