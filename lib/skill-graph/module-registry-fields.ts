import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor as Descriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext as Context,
  GameplayValueType,
} from './module-types'

const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const statusType: GameplayValueType = 'status'
const recordType: GameplayValueType = 'record'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: pieceType }
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const stringListType: GameplayValueType = { kind: 'list', element: stringType }
const stringListValueType = JSON.stringify(stringListType)
const PIECE_WRITE_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  spentPassives: stringListType,
  momentum: numberType,
  currentHp: numberType,
  maxHp: numberType,
})
// Scoped numeric fields are intentionally narrower than PIECE_FIELDS.  The
// live/stored writer and the captured-source writer share one closed table so
// an author cannot turn an assignment into an arbitrary object-property write.
const SCOPED_NUMERIC_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  attack: numberType,
  defense: numberType,
  moveRange: numberType,
})
// Stored records use the same active-then-graveyard lookup as the legacy
// stored-field writer.  The presentation flag is deliberately available only
// through the stored scope; exposing it to the live writer would create a new
// path that is not part of the old contract.
const STORED_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  ...SCOPED_NUMERIC_FIELD_TYPES,
  showFreezeEffect: booleanType,
})
const PIECE_V2_WRITE_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  ...PIECE_WRITE_FIELD_TYPES,
  ...STORED_FIELD_TYPES,
})

const valueTypeParameter = (type: GameplayValueType): string => typeof type === 'string' ? type : JSON.stringify(type)

const flow = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const context = (ctx: Context): string => ctx.surface === 'pending' ? 'ctx' : 'context'
const input = (ctx: Context, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const field = (ctx: Context): string => {
  const value = ctx.parameters.field
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: field must be text`)
  return value
}
const outputValue = (expression: string): string => `{value:(${expression})}`
const withFieldExistence = (expression: string, record: string, field: string): string =>
  `(function(record){var result=(${expression});result.exists=record[${field}]!==undefined&&record[${field}]!==null;return result;})(${record})`
const pure = (reads: readonly string[]): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const define = (value: Omit<Descriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): Descriptor => ({
  version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE_SURFACES, ...value,
})

const fieldBinding = (types: Readonly<Record<string, GameplayValueType>>) => ({
  value: { parameter: 'field', types },
})

const PIECE_FIELDS = {
  ownerPlayerId: playerType,
  instanceId: stringType,
  templateId: stringType,
  isCore: booleanType,
  currentHp: numberType,
  maxHp: numberType,
  attack: numberType,
  defense: numberType,
  moveRange: numberType,
  momentum: numberType,
  x: numberType,
  y: numberType,
  name: stringType,
  faction: stringType,
  statusTags: recordListType,
  rules: recordListType,
  /** Immutable snapshots used by generic skill/ability readers. */
  skills: recordListType,
  spentPassives: stringListType,
} as const satisfies Readonly<Record<string, GameplayValueType>>

const PLAYER_FIELDS = {
  name: stringType,
  faction: stringType,
  actionPoints: numberType,
  chargePoints: numberType,
  maxActionPoints: numberType,
  statusTags: recordListType,
} as const satisfies Readonly<Record<string, GameplayValueType>>

const EVENT_FIELDS = {
  sourcePiece: { kind: 'nullable', value: recordType },
  targetPiece: { kind: 'nullable', value: recordType },
  piece: { kind: 'nullable', value: recordType },
  rulePiece: { kind: 'nullable', value: recordType },
  type: { kind: 'nullable', value: stringType },
  playerId: { kind: 'nullable', value: playerType },
  skillId: nullableStringType,
  damage: { kind: 'nullable', value: numberType },
  actualDamage: { kind: 'nullable', value: numberType },
  heal: { kind: 'nullable', value: numberType },
  amount: { kind: 'nullable', value: numberType },
  targetX: { kind: 'nullable', value: numberType },
  targetY: { kind: 'nullable', value: numberType },
  turnNumber: { kind: 'nullable', value: numberType },
  movementKind: { kind: 'nullable', value: stringType },
  fromX: { kind: 'nullable', value: numberType },
  fromY: { kind: 'nullable', value: numberType },
  pathCells: { kind: 'nullable', value: recordListType },
  contactCells: { kind: 'nullable', value: recordListType },
} as const satisfies Readonly<Record<string, GameplayValueType>>

const DATA_FIELDS = {
  attack: numberType,
  defense: numberType,
  moveRange: numberType,
  currentHp: numberType,
  maxHp: numberType,
  id: nullableStringType,
  type: nullableStringType,
  name: nullableStringType,
  sourceId: nullableStringType,
  sourcePieceId: nullableStringType,
  ownerPlayerId: nullableStringType,
  // Status/extension records retain stable identity text; unlike effect
  // results this is not a live piece reference and must remain comparable
  // after the piece has left the board.
  targetId: nullableStringType,
  skillId: nullableStringType,
  flightId: nullableStringType,
  legacyText: nullableStringType,
  lastDamageTurn: numberType,
  stacks: numberType,
  intensity: numberType,
  currentDuration: numberType,
  remainingDuration: numberType,
  currentUses: numberType,
  remainingUses: numberType,
  value: numberType,
  amount: numberType,
  damage: numberType,
  actualDamage: numberType,
  rawDamage: numberType,
  modifiedDamage: numberType,
  resolvedDamage: numberType,
  targetHp: numberType,
  x: numberType,
  y: numberType,
  heal: numberType,
  rawHeal: numberType,
  modifiedHeal: numberType,
  totalDamage: numberType,
  totalHeal: numberType,
  blocked: booleanType,
  isKilled: booleanType,
  success: booleanType,
  noKillCharge: booleanType,
  statusTags: recordListType,
  rules: recordListType,
  results: recordListType,
  skillIds: stringListType,
} as const satisfies Readonly<Record<string, GameplayValueType>>

function copiedField(source: string, fieldExpression: string): string {
  return `(function(value){if(value===__gameplayInvalid||value===undefined)return __gameplayInvalid;if(value===null||typeof value!=="object")return value;return JSON.parse(JSON.stringify(value));})(${source}[${fieldExpression}])`
}

function copiedBoolean(source: string, fieldExpression: string): string {
  return `(function(value){if(value===__gameplayInvalid)return __gameplayInvalid;return Boolean(value);})(${source}[${fieldExpression}])`
}

function copiedRecordList(source: string, fieldExpression: string, legacyStrings = false): string {
  const normalize = legacyStrings
    ? 'if(typeof item==="string"){result.push({_legacyText:item});continue;}'
    : ''
  return `(function(value){if(value===__gameplayInvalid)return __gameplayInvalid;if(value===undefined)return [];if(!Array.isArray(value))return __gameplayInvalid;var result=[];for(var index=0;index<value.length;index+=1){var item=value[index];${normalize}if(!item||typeof item!=="object")return __gameplayInvalid;result.push(JSON.parse(JSON.stringify(item)));}return result;})(${source}[${fieldExpression}])`
}

function copiedStringList(source: string, fieldExpression: string): string {
  return `(function(value){if(value===__gameplayInvalid)return __gameplayInvalid;if(value===undefined||value===null)return [];if(!Array.isArray(value))return __gameplayInvalid;var result=[];for(var index=0;index<value.length;index+=1){var item=value[index];if(typeof item!=="string")return __gameplayInvalid;result.push(item);}return result;})(${source}[${fieldExpression}])`
}

function pieceFieldLowering(ctx: Context): string {
  const selected = field(ctx)
  const pieceId = input(ctx, 'piece')
  const runtime = flow(ctx)
  const fieldExpression = ctx.emitLiteral(selected)
  if (selected === 'name' || selected === 'faction') return outputValue(`${runtime}.query.pieceText(${pieceId}, ${fieldExpression})`)
  const source = `${runtime}.query.piece(${pieceId})`
  if (selected === 'statusTags') return outputValue(copiedRecordList(source, fieldExpression, true))
  if (selected === 'rules') return outputValue(copiedRecordList(source, fieldExpression))
  if (selected === 'skills') return outputValue(copiedRecordList(source, fieldExpression))
  if (selected === 'spentPassives') return outputValue(copiedStringList(source, fieldExpression))
  if (selected === 'isCore') return outputValue(copiedBoolean(source, fieldExpression))
  if (selected === 'momentum') return outputValue(`Number(${source}.momentum || 0)`)
  return outputValue(copiedField(source, fieldExpression))
}

function playerFieldLowering(ctx: Context): string {
  const selected = field(ctx)
  const playerId = input(ctx, 'player')
  const runtime = flow(ctx)
  const fieldExpression = ctx.emitLiteral(selected)
  const source = `${runtime}.query.player(${playerId})`
  const expression = selected === 'name' || selected === 'faction'
    ? outputValue(`${runtime}.query.playerText(${playerId}, ${fieldExpression})`)
    : selected === 'statusTags' ? outputValue(copiedRecordList('record', fieldExpression, true)) : outputValue(copiedField('record', fieldExpression))
  return withFieldExistence(expression, source, fieldExpression)
}

function eventFieldLowering(ctx: Context): string {
  const selected = field(ctx)
  const runtime = flow(ctx)
  const host = context(ctx)
  const fieldExpression = ctx.emitLiteral(selected)
  if (['sourcePiece', 'targetPiece', 'piece', 'rulePiece'].includes(selected)) return outputValue(`${runtime}.event.pieceFields(${fieldExpression})`)
  const skillFallback = selected === 'skillId'
    ? `((value===undefined||value===null)&&${host}&&typeof ${host}==="object" ? (${host}.skillId ?? (${host}.skill&&${host}.skill.id) ?? ${host}.ruleId) : value)`
    : 'value'
  return outputValue(`(function(record){var value=record[${fieldExpression}];value=${skillFallback};return value===undefined?null:(value!==null&&typeof value==="object"?JSON.parse(JSON.stringify(value)):value);})(${runtime}.event.read())`)
}

const DATA_STRING_FIELDS = new Set(['id', 'type', 'name', 'sourceId', 'sourcePieceId', 'ownerPlayerId', 'targetId', 'skillId', 'flightId'])
// Preserve the existing result readers' Boolean(undefined) semantics while
// keeping the conversion closed to the trusted result fields.
const DATA_BOOLEAN_FIELDS = new Set(['blocked', 'isKilled', 'success', 'noKillCharge'])
const DATA_LIST_FIELDS = new Set(['statusTags', 'rules', 'results', 'skillIds'])

function dataFieldLowering(ctx: Context): string {
  const selected = field(ctx)
  const data = input(ctx, 'record')
  const fieldExpression = ctx.emitLiteral(selected)
  if (ctx.moduleVersion === '2' && ['ownerPlayerId', 'instanceId'].includes(selected)) {
    return withFieldExistence(outputValue(`(function(value){return typeof value==="string"?value:__gameplayInvalid;})(record[${fieldExpression}])`), data, fieldExpression)
  }
  const stringField = DATA_STRING_FIELDS.has(selected)
  const listField = DATA_LIST_FIELDS.has(selected)
  const statusList = selected === 'statusTags'
  const stringList = selected === 'skillIds'
  const expected = stringField
    ? `return value===undefined||value===null?null:(typeof value==="string"?value:__gameplayInvalid);`
    : stringList
      ? `if(value===undefined)return [];if(!Array.isArray(value))return __gameplayInvalid;var result=[];for(var index=0;index<value.length;index+=1){var item=value[index];if(typeof item!=="string")return __gameplayInvalid;result.push(item);}return result;`
    : listField
      ? `if(value===undefined)return [];if(!Array.isArray(value))return __gameplayInvalid;var result=[];for(var index=0;index<value.length;index+=1){var item=value[index];if(${statusList ? 'typeof item===\"string\"' : 'false'}){result.push({_legacyText:item});continue;}if(!item||typeof item!=="object")return __gameplayInvalid;result.push(JSON.parse(JSON.stringify(item)));}return result;`
      : DATA_BOOLEAN_FIELDS.has(selected)
        ? `return value===__gameplayInvalid?__gameplayInvalid:Boolean(value);`
        : `return value===undefined||value===null||typeof value!=="number"||!Number.isFinite(value)?__gameplayInvalid:value;`
  const legacyText = selected === 'legacyText'
    ? `return typeof record._legacyText==="string"?record._legacyText:null;`
    : expected
  return withFieldExistence(outputValue(`(function(record){if(record===__gameplayInvalid||record===null||typeof record!=="object")return __gameplayInvalid;var value=record[${fieldExpression}];${legacyText}})(record)`), data, fieldExpression)
}

const BATTLE_FIELDS = {
  tileEffects: recordListType,
  turnNumber: numberType,
  currentPlayerId: playerType,
} as const satisfies Readonly<Record<string, GameplayValueType>>

const RESULT_FIELDS = {
  success: booleanType,
  queued: booleanType,
  queueCount: numberType,
  blocked: booleanType,
  isKilled: booleanType,
  damage: numberType,
  heal: numberType,
  totalDamage: numberType,
  totalHeal: numberType,
  results: recordListType,
  // Result records carry a stable piece identity.  The value is still the
  // opaque instance id at runtime, but keeping the semantic port type as a
  // piece lets result filters compare it against a piece reference without
  // resolving the piece again after it has died.
  targetId: nullablePieceType,
} as const satisfies Readonly<Record<string, GameplayValueType>>

function battleFieldLowering(ctx: Context): string {
  const selected = field(ctx)
  const state = battle(ctx)
  const fieldExpression = ctx.emitLiteral(selected)
  if (selected === 'tileEffects') {
    return outputValue(copiedRecordList(`(${state}.extensions || {})`, fieldExpression))
  }
  return outputValue(copiedField(`(${state}.turn || {})`, fieldExpression))
}

const RESULT_STRING_FIELDS = new Set(['targetId'])
const RESULT_BOOLEAN_FIELDS = new Set(['success', 'queued', 'blocked', 'isKilled'])
const RESULT_LIST_FIELDS = new Set(['results'])

function resultFieldLowering(ctx: Context): string {
  const selected = field(ctx)
  const record = input(ctx, 'record')
  const fieldExpression = ctx.emitLiteral(selected)
  const value = RESULT_STRING_FIELDS.has(selected)
    ? `return value===undefined||value===null?null:(typeof value==="string"?value:__gameplayInvalid);`
    : RESULT_BOOLEAN_FIELDS.has(selected)
      ? `return value===__gameplayInvalid?__gameplayInvalid:Boolean(value);`
      : RESULT_LIST_FIELDS.has(selected)
        ? `if(value===undefined)return [];if(!Array.isArray(value))return __gameplayInvalid;var result=[];for(var index=0;index<value.length;index+=1){var item=value[index];if(!item||typeof item!=="object")return __gameplayInvalid;result.push(JSON.parse(JSON.stringify(item)));}return result;`
        : `return value===undefined||value===null?0:(typeof value==="number"&&Number.isFinite(value)?value:__gameplayInvalid);`
  return outputValue(`(function(record){if(record===__gameplayInvalid||record===null||typeof record!=="object")return __gameplayInvalid;var value=record[${fieldExpression}];${value}})(${record})`)
}

export const FIELD_GAMEPLAY_MODULES: readonly Descriptor[] = Object.freeze([
  define({
    id: 'piece.field', label: '读取棋子字段',
    description: '读取已验证且仍在场棋子的封闭字段；HP 为零仍可读取身份、数值和历史结算所需事实。',
    inputs: [{ name: 'piece', type: pieceType }], outputs: [{ name: 'value', type: 'unknown' }],
    parameters: [{ name: 'field', type: stringType, enum: Object.keys(PIECE_FIELDS) }],
    outputParameterTypeBindings: fieldBinding(PIECE_FIELDS),
    effects: pure(['pieces', 'players']),
    lower: pieceFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  {
    id: 'piece.field', version: '2', label: '读取棋子字段',
    description: '读取存活棋子的封闭字段；死亡事件的已保留数据通过事件记录读取。',
    inputs: [{ name: 'piece', type: pieceType }], outputs: [{ name: 'value', type: 'unknown' }],
    parameters: [{ name: 'field', type: stringType, enum: Object.keys(PIECE_FIELDS) }],
    outputParameterTypeBindings: fieldBinding(PIECE_FIELDS), livingReferences: ['piece'],
    allowedSurfaces: ACTIVE_SURFACES, effects: pure(['pieces', 'players']), lower: pieceFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
  define({
    id: 'battle.field', label: '读取战斗字段',
    description: '读取战斗上下文的封闭只读字段；集合返回不可变快照。',
    inputs: [], outputs: [{ name: 'value', type: 'unknown' }],
    parameters: [{ name: 'field', type: stringType, enum: Object.keys(BATTLE_FIELDS) }],
    outputParameterTypeBindings: fieldBinding(BATTLE_FIELDS),
    effects: pure(['turn', 'tile-effects', 'players']),
    lower: battleFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'result.field', label: '读取效果结果字段',
    description: '读取权威效果结果的封闭字段；结果数值缺失沿用旧结果读取的零值语义。',
    inputs: [{ name: 'record', type: recordType }], outputs: [{ name: 'value', type: 'unknown' }],
    parameters: [{ name: 'field', type: stringType, enum: Object.keys(RESULT_FIELDS) }],
    outputParameterTypeBindings: fieldBinding(RESULT_FIELDS),
    effects: pure(['damage', 'heal', 'event']),
    lower: resultFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'piece.write-field', label: '棋子字段赋值',
    description: '给棋子的可写记账字段赋值；动能写入委托权威属性边界，已用被动列表使用新元组。',
    inputs: [{ name: 'piece', type: pieceType, label: '棋子' }, { name: 'value', type: recordType, label: '值' }],
    inputValueTypeBindings: { value: { parameter: 'valueType' } },
    outputs: [{ name: 'success', type: booleanType }],
    parameters: [
      { name: 'field', type: stringType, label: '字段', enum: Object.keys(PIECE_WRITE_FIELD_TYPES) },
      { name: 'valueType', type: stringType, label: '值类型', enum: [stringListValueType, 'number'], default: stringListValueType },
    ],
    effects: { pure: false, previewSafe: false, writes: ['skills', 'attributes'] },
    lower: ctx => {
      const selected = field(ctx)
      const pieceId = input(ctx, 'piece')
      const value = input(ctx, 'value')
      const expectedType = PIECE_WRITE_FIELD_TYPES[selected]
      const suppliedType = ctx.parameters.valueType ?? (expectedType ? valueTypeParameter(expectedType) : undefined)
      if (!expectedType || suppliedType !== valueTypeParameter(expectedType)) {
        throw new Error(`module ${ctx.moduleId}: ${selected} requires ${expectedType ? valueTypeParameter(expectedType) : 'a supported value type'}`)
      }
      if (selected === 'spentPassives') {
        return `(function(target,value){target[${ctx.emitLiteral(selected)}]=value.slice();return true;})(${flow(ctx)}.query.piece(${pieceId}),${value})`
      }
      if (selected === 'momentum') {
        return `(function(runtime,id,value){if(typeof value!=="number"||!Number.isFinite(value))throw new Error("flow: 动能无效");if(!runtime.attributes||typeof runtime.attributes.setMomentum!=="function")throw new Error("flow: 动能属性写入入口缺失");runtime.attributes.setMomentum(id,value);return true;})(${flow(ctx)},${pieceId},${value})`
      }
      if (selected === 'currentHp') return `(function(runtime,id,value){if(!runtime.attributes||typeof runtime.attributes.setCurrentHp!=="function")throw new Error("flow: 当前生命写入入口缺失");runtime.attributes.setCurrentHp(id,value);return true;})(${flow(ctx)},${pieceId},${value})`
      if (selected === 'maxHp') return `(function(runtime,id,value){if(!runtime.attributes||typeof runtime.attributes.setMaxHp!=="function")throw new Error("flow: 生命上限写入入口缺失");runtime.attributes.setMaxHp(id,value);return true;})(${flow(ctx)},${pieceId},${value})`
      throw new Error(`module ${ctx.moduleId}: unsupported writable field`)
    },
    ui: {
      category: 'field', authoring: 'standard',
      parameterTypeBindings: { valueType: { parameter: 'field', types: PIECE_WRITE_FIELD_TYPES } },
    },
  }),
  {
    id: 'piece.write-field', version: '2', label: '棋子字段赋值', allowedSurfaces: ACTIVE_SURFACES,
    description: '用统一赋值句式写入封闭战斗属性；当前棋子走实时权威属性入口，已保存棋子记录走在场或墓地记录入口，其中 showFreezeEffect 为布尔表现标记；值类型由字段推断。',
    inputs: [
      { name: 'piece', type: pieceType, label: '当前棋子', optional: true },
      { name: 'id', type: stringType, label: '已保存棋子标识', optional: true },
      { name: 'value', type: recordType, label: '值' },
    ],
    inputValueTypeBindings: { value: { parameter: 'valueType' } },
    outputs: [{ name: 'success', type: booleanType }],
    parameters: [
      { name: 'scope', type: stringType, label: '目标范围', enum: ['live', 'stored'], default: 'live' },
      { name: 'field', type: stringType, label: '字段', enum: Object.keys(PIECE_V2_WRITE_FIELD_TYPES) },
      { name: 'valueType', type: stringType, label: '值类型', enum: [stringListValueType, 'number', 'boolean'], default: 'number' },
    ],
    effects: { pure: false, previewSafe: false, writes: ['attributes', 'pieces', 'graveyard'] },
    lower: ctx => {
      const selected = field(ctx)
      const expectedType = PIECE_V2_WRITE_FIELD_TYPES[selected]
      const suppliedType = ctx.parameters.valueType ?? (expectedType ? valueTypeParameter(expectedType) : undefined)
      if (!expectedType || suppliedType !== valueTypeParameter(expectedType)) {
        throw new Error(`module ${ctx.moduleId}: ${selected} requires ${expectedType ? valueTypeParameter(expectedType) : 'a supported value type'}`)
      }
      const scope = ctx.parameters.scope === undefined ? 'live' : ctx.parameters.scope
      if (scope !== 'live' && scope !== 'stored') throw new Error(`module ${ctx.moduleId}: scope must be live or stored`)
      if (scope === 'stored' && !Object.hasOwn(STORED_FIELD_TYPES, selected)) {
        throw new Error(`module ${ctx.moduleId}: stored scope only supports attack, defense, moveRange, and showFreezeEffect`)
      }
      if (scope === 'live' && selected === 'showFreezeEffect') {
        throw new Error(`module ${ctx.moduleId}: showFreezeEffect requires stored scope`)
      }
      const value = input(ctx, 'value')
      const selectedField = ctx.emitLiteral(selected)
      if (scope === 'stored') {
        const id = input(ctx, 'id')
        return `(function(runtime,id,value){if(!runtime.attributes||typeof runtime.attributes.setStored!=="function")throw new Error("flow: 已保存属性写入入口缺失");return runtime.attributes.setStored(id,${selectedField},value);})(${flow(ctx)},${id},${value})`
      }
      const piece = input(ctx, 'piece')
      if (selected === 'spentPassives') {
        return `(function(target,value){if(!Array.isArray(value))throw new Error("flow: 已消耗被动列表无效");target[${selectedField}]=value.slice();return true;})(${flow(ctx)}.query.piece(${piece}),${value})`
      }
      if (selected === 'momentum') {
        return `(function(runtime,id,value){if(typeof value!=="number"||!Number.isFinite(value))throw new Error("flow: 动能无效");if(!runtime.attributes||typeof runtime.attributes.setMomentum!=="function")throw new Error("flow: 动能属性写入入口缺失");runtime.attributes.setMomentum(id,value);return true;})(${flow(ctx)},${piece},${value})`
      }
      if (selected === 'currentHp') {
        return `(function(runtime,id,value){if(!runtime.attributes||typeof runtime.attributes.setCurrentHp!=="function")throw new Error("flow: 当前生命写入入口缺失");runtime.attributes.setCurrentHp(id,value);return true;})(${flow(ctx)},${piece},${value})`
      }
      if (selected === 'maxHp') {
        return `(function(runtime,id,value){if(!runtime.attributes||typeof runtime.attributes.setMaxHp!=="function")throw new Error("flow: 生命上限写入入口缺失");runtime.attributes.setMaxHp(id,value);return true;})(${flow(ctx)},${piece},${value})`
      }
      // The host setter owns numeric validation and all live-piece identity
      // checks.  Return a semantic success flag even when the value is 0.
      return `(function(runtime,id,value){if(!runtime.attributes||typeof runtime.attributes.set!=="function")throw new Error("flow: 属性写入入口缺失");runtime.attributes.set(id,${selectedField},value);return true;})(${flow(ctx)},${piece},${value})`
    },
    ui: {
      category: 'field', authoring: 'standard',
      parameterTypeBindings: { valueType: { parameter: 'field', types: PIECE_V2_WRITE_FIELD_TYPES } },
    },
  },
  define({
    id: 'player.write-field', label: '玩家字段赋值',
    description: '给玩家可写的状态记录字段赋值；状态添加和驱散事件由对应效果语句处理。',
    inputs: [{ name: 'player', type: playerType, label: '玩家' }, { name: 'value', type: recordListType, label: '值' }],
    outputs: [{ name: 'success', type: booleanType }],
    parameters: [{ name: 'field', type: stringType, label: '字段', enum: ['statusTags'] }],
    effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    lower: ctx => `(function(target,value){target[${ctx.emitLiteral(field(ctx))}]=value.slice();return true;})(${flow(ctx)}.query.player(${input(ctx, 'player')}),${input(ctx, 'value')})`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'player.field', label: '读取玩家字段',
    description: '读取玩家的封闭只读字段；阵营字段使用权威可比较阵营键。',
    inputs: [{ name: 'player', type: playerType }], outputs: [{ name: 'value', type: 'unknown' }, { name: 'exists', type: booleanType, label: '原字段已定义' }],
    parameters: [{ name: 'field', type: stringType, enum: Object.keys(PLAYER_FIELDS) }],
    outputParameterTypeBindings: fieldBinding(PLAYER_FIELDS),
    effects: pure(['players']),
    lower: playerFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'event.field', label: '读取事件字段',
    description: '读取事件快照中的封闭历史字段；棋子离场不影响已记录事实。',
    inputs: [], outputs: [{ name: 'value', type: 'unknown' }],
    parameters: [{ name: 'field', type: stringType, enum: Object.keys(EVENT_FIELDS) }],
    outputParameterTypeBindings: fieldBinding(EVENT_FIELDS),
    effects: pure(['event']),
    lower: eventFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'data.field', label: '读取记录字段',
    description: '读取受信记录视图的封闭字段；只返回不可变快照或不可变标量。',
    inputs: [{ name: 'record', type: recordType }], outputs: [{ name: 'value', type: 'unknown' }, { name: 'exists', type: booleanType, label: '原字段已定义' }],
    parameters: [{ name: 'field', type: stringType, enum: Object.keys(DATA_FIELDS) }],
    outputParameterTypeBindings: fieldBinding(DATA_FIELDS),
    effects: pure(['records']),
    lower: dataFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'source.fields', label: '读取已保留来源字段',
    description: '读取执行期间保留的来源快照；来源离场后仍可读取历史身份事实。',
    inputs: [{ name: 'source', type: recordType }], outputs: [{ name: 'record', type: recordType }],
    effects: pure(['execution-context']),
    lower: ctx => `{record:${flow(ctx)}.effects.capturedFields(${input(ctx, 'source')})}`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'source.field', label: '读取来源数值字段',
    description: '按封闭字段读取执行期间保留的来源数值；来源离场后仍使用同一认证来源句柄。',
    inputs: [{ name: 'source', type: { kind: 'nullable', value: recordType }, label: '来源' }], outputs: [{ name: 'value', type: numberType }],
    parameters: [{ name: 'field', type: stringType, label: '字段', enum: Object.keys(SCOPED_NUMERIC_FIELD_TYPES) }],
    outputParameterTypeBindings: fieldBinding(SCOPED_NUMERIC_FIELD_TYPES),
    effects: pure(['execution-context', 'pieces']),
    lower: ctx => `${flow(ctx)}.effects.capturedNumber(${input(ctx, 'source')},${ctx.emitLiteral(field(ctx))})`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'source.write-field', label: '来源字段赋值',
    description: '将封闭来源数值字段写回认证来源；不暴露来源对象路径或任意字段。',
    inputs: [{ name: 'source', type: { kind: 'nullable', value: recordType }, label: '来源' }, { name: 'value', type: recordType, label: '值' }],
    inputValueTypeBindings: { value: { parameter: 'valueType' } },
    outputs: [{ name: 'success', type: booleanType }, { name: 'value', type: numberType }],
    parameters: [
      { name: 'field', type: stringType, label: '字段', enum: Object.keys(SCOPED_NUMERIC_FIELD_TYPES) },
      { name: 'valueType', type: stringType, label: '值类型', enum: ['number'], default: 'number' },
    ],
    effects: { pure: false, previewSafe: false, writes: ['attributes'] },
    lower: ctx => {
      const selected = field(ctx)
      const expectedType = SCOPED_NUMERIC_FIELD_TYPES[selected]
      const suppliedType = ctx.parameters.valueType ?? (expectedType ? valueTypeParameter(expectedType) : undefined)
      if (!expectedType || suppliedType !== valueTypeParameter(expectedType)) {
        throw new Error(`module ${ctx.moduleId}: ${selected} requires ${expectedType ? valueTypeParameter(expectedType) : 'a supported value type'}`)
      }
      const value = input(ctx, 'value')
      return `(function(runtime,handle,value){if(!runtime.effects||typeof runtime.effects.setCapturedAttribute!=="function")throw new Error("flow: 来源属性写入入口缺失");var success=Boolean(runtime.effects.setCapturedAttribute(handle,${ctx.emitLiteral(selected)},value));return {success:success,value:success?value:__gameplayInvalid};})(${flow(ctx)},${input(ctx, 'source')},${value})`
    },
    ui: {
      category: 'field', authoring: 'standard',
      parameterTypeBindings: { valueType: { parameter: 'field', types: SCOPED_NUMERIC_FIELD_TYPES } },
    },
  }),
  {
    id: 'data.field', version: '2', label: '读取记录字段',
    description: '读取封闭字段；实例标识保留文本，所属玩家保留玩家引用类型。',
    inputs: [{ name: 'record', type: recordType }], outputs: [{ name: 'value', type: 'unknown' }, { name: 'exists', type: booleanType, label: '原字段已定义' }],
    parameters: [{ name: 'field', type: stringType, enum: [...Object.keys(DATA_FIELDS), 'instanceId'] }],
    outputParameterTypeBindings: fieldBinding({ ...DATA_FIELDS, ownerPlayerId: playerType, instanceId: stringType }),
    allowedSurfaces: ACTIVE_SURFACES, effects: pure(['records']), lower: dataFieldLowering,
    ui: { category: 'field', authoring: 'standard' },
  },
  define({
    id: 'status.fields', label: '读取状态字段',
    description: '读取当前执行保留的状态记录快照；无效状态由宿主报告为无效依赖。',
    inputs: [{ name: 'status', type: statusType, nullable: true }], outputs: [{ name: 'record', type: recordType }],
    effects: pure(['execution-context', 'statuses']),
    // A nullable legacy status reader must remain a pure query so it can be
    // used in collection bodies.  Missing handles are represented as a null
    // record and are consumed by data.optional-field's fallback semantics;
    // live handles still go through the authoritative host snapshot reader.
    lower: ctx => `{record:((${input(ctx, 'status')} == null) ? null : ${flow(ctx)}.status.fields(${input(ctx, 'status')}))}`,
    ui: { category: 'field', authoring: 'standard' },
  }),
])
