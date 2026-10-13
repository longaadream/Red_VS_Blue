import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const recordType: GameplayValueType = 'record'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: recordType }

const port = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayPort, 'name' | 'type'> = {},
): GameplayPort => ({ name, type, ...options })

const parameter = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayParameter, 'name' | 'type'> = {},
): GameplayParameter => ({ name, type, ...options })

const pure = (reads: readonly string[]): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({
  pure: false, previewSafe: false, writes: domains, ...(events.length ? { events } : {}),
})

const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

const storedFieldTypes: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  name: nullableStringType,
  templateId: nullableStringType,
  attack: nullableNumberType,
  defense: nullableNumberType,
  moveRange: nullableNumberType,
})

/**
 * Read a closed field from an active or historical piece without exposing the
 * host object. The identity is still an opaque author reference; only the
 * declared field crosses the boundary and the value is copied as a scalar.
 */
const storedFieldLowering = (ctx: GameplayNativeLoweringContext): string => {
  const field = ctx.parameters.field
  if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(storedFieldTypes, field)) {
    throw new Error(`module ${ctx.moduleId}: unsupported stored field`)
  }
  const state = battle(ctx)
  const id = input(ctx, 'id')
  const fieldLiteral = ctx.emitLiteral(field)
  const valueType = storedFieldTypes[field]
  const scalarCheck = valueType === nullableNumberType
    ? 'typeof value === "number" && Number.isFinite(value)'
    : 'typeof value === "string"'
  return `(function(id){if(id===__gameplayInvalid)return __gameplayInvalid;var all=(Array.isArray(${state}.pieces)?${state}.pieces:[]).concat(Array.isArray(${state}.graveyard)?${state}.graveyard:[]);var piece=all.find(function(item){return item&&item.instanceId===id;});if(!piece)return {value:null,exists:false};var value=piece[${fieldLiteral}];if(value===undefined||value===null)return {value:null,exists:true};if(!(${scalarCheck}))return __gameplayInvalid;return {value:value,exists:true};})(${id})`
}

/** Read a player's declared buff record as a detached, nullable record. */
const buffRecordLowering = (ctx: GameplayNativeLoweringContext): string => {
  const player = input(ctx, 'player')
  const buffId = ctx.parameters.buffId
  if (typeof buffId !== 'string' || buffId.length === 0) throw new Error(`module ${ctx.moduleId}: buffId must be text`)
  const runtime = flow(ctx)
  return `(function(playerId){if(playerId===__gameplayInvalid)return __gameplayInvalid;var player=${runtime}.query.player(playerId);var buffs=player&&player.buffs;var buff=buffs&&typeof buffs==="object"?buffs[${ctx.emitLiteral(buffId)}]:null;if(!buff||typeof buff!=="object"||Array.isArray(buff))return {record:null};return {record:JSON.parse(JSON.stringify(buff))};})(${player})`
}

/** Write only the bounded uses counter of a declared player buff. */
const buffUsesLowering = (ctx: GameplayNativeLoweringContext): string => {
  const player = input(ctx, 'player')
  const uses = input(ctx, 'uses')
  const buffId = ctx.parameters.buffId
  if (typeof buffId !== 'string' || buffId.length === 0) throw new Error(`module ${ctx.moduleId}: buffId must be text`)
  const runtime = flow(ctx)
  return `(function(playerId,nextUses){if(playerId===__gameplayInvalid||!Number.isSafeInteger(nextUses)||nextUses<0)return false;var player=${runtime}.query.player(playerId);var buffs=player&&player.buffs;var buff=buffs&&typeof buffs==="object"?buffs[${ctx.emitLiteral(buffId)}]:null;if(!buff||typeof buff!=="object"||Array.isArray(buff)||!Number.isFinite(Number(buff.uses))||Number(buff.uses)<=0)return false;buff.uses=nextUses;return true;})(${player},${uses})`
}

/**
 * Preserve the legacy raw rule-reference list semantics. This is intentionally
 * a generic write boundary: rule lifecycle installation belongs to rule.apply
 * and is not part of this compatibility record.
 */
const writeRulesLowering = (ctx: GameplayNativeLoweringContext): string =>
  `(function(pieceId,rules){if(pieceId===__gameplayInvalid||rules===__gameplayInvalid||!Array.isArray(rules))return false;var target=${flow(ctx)}.query.piece(pieceId);if(!target)return false;target.rules=rules.slice();return true;})(${input(ctx, 'piece')},${input(ctx, 'rules')})`

const definitions: readonly GameplayModuleDescriptor[] = [
  {
    id: 'piece.stored-field', version: '1', label: '读取在场或历史棋子字段',
    description: '按稳定棋子标识读取登记的标量字段；当前棋子和墓地均可读，缺失字段返回空值。',
    inputs: [port('id', stringType, { nullable: true })],
    outputs: [port('value', 'unknown', { nullable: true }), port('exists', booleanType)],
    parameters: [parameter('field', stringType, { enum: Object.keys(storedFieldTypes) })],
    outputParameterTypeBindings: { value: { parameter: 'field', types: storedFieldTypes } },
    allowedSurfaces: SURFACES,
    effects: pure(['pieces', 'graveyard']),
    lower: storedFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
  {
    id: 'player.buff-record', version: '1', label: '读取玩家增益记录',
    description: '读取指定玩家的单个增益记录快照；玩家或增益缺失返回空记录值。',
    inputs: [port('player', playerType)], outputs: [port('record', recordType, { nullable: true })],
    parameters: [parameter('buffId', stringType)],
    allowedSurfaces: SURFACES,
    effects: pure(['players', 'player-buffs']),
    lower: buffRecordLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
  {
    id: 'player.write-buff-uses', version: '1', label: '写入玩家增益次数',
    description: '只更新已声明玩家增益的剩余次数；缺失或已耗尽的增益不会创建新记录。',
    inputs: [port('player', playerType), port('uses', numberType)], outputs: [port('success', booleanType)],
    parameters: [parameter('buffId', stringType)],
    allowedSurfaces: SURFACES,
    effects: writes(['player-buffs']),
    lower: buffUsesLowering,
    ui: { category: 'field', authoring: 'compatibility' },
  },
  {
    id: 'piece.write-rules', version: '1', label: '写入棋子规则引用记录',
    description: '替换棋子的原始规则引用元组；不安装或移除规则生命周期。',
    inputs: [port('piece', pieceType), port('rules', recordListType)], outputs: [port('success', booleanType)],
    allowedSurfaces: SURFACES,
    effects: writes(['rules']),
    lower: writeRulesLowering,
    ui: { category: 'rule', authoring: 'compatibility' },
  },
]

export const FOLLOWUP_COMPOSITION_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze(definitions)
