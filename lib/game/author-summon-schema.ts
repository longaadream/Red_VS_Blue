import type { Faction, PieceInstance, PieceSkill, PieceStatusTag } from './piece'
import { cloneAuthorInitialValue, requireAuthorValue } from './author-extension'
import type { GameplayPort, GameplayRecordSchema, GameplayValueType } from '../skill-graph/module-types'

/** Values are evaluated by the author program before entering the authoritative
 * lifecycle. No executable code or caller-chosen instance identity is accepted. */
export interface AuthoredPieceSnapshot {
  schemaVersion: 1
  kind: 'author-piece-instance/v1'
  sourcePieceId: string
  ownerPlayerId: string
  identity: {
    templateId: string
    name: string
    /** Stored snapshots use the persistence layer's string identity shape;
     * parseSnapshot narrows it to a supported Faction before resolution. */
    faction: string
    ownerPlayerId: string
    isCore?: boolean
  }
  fields: Record<string, unknown>
  flowState: unknown[]
}

/**
 * A template may be a complete independent piece or a detached snapshot plus
 * explicit overrides. The latter is the generic authoring shape used for
 * source based summons; it never stores a live PieceInstance reference.
 */
export interface AuthoredPieceTemplate {
  baseSnapshot?: AuthoredPieceSnapshot
  templateId?: string
  name?: string
  maxHp?: number
  currentHp?: number
  attack?: number
  defense?: number
  moveRange?: number
  ownerPlayerId?: string
  faction?: Faction
  isCore?: boolean
  skills?: PieceSkill[]
  rules?: string[]
  statusTags?: PieceStatusTag[]
  extension?: Record<string, unknown>
}

export interface ResolvedAuthoredPieceTemplate {
  templateId: string
  name: string
  maxHp: number
  currentHp: number
  attack: number
  defense: number
  moveRange: number
  ownerPlayerId: string
  faction: Faction
  isCore: boolean
  skills: PieceSkill[]
  rules: string[]
  statusTags: PieceStatusTag[]
  extension?: Record<string, unknown>
}

export type AuthoredDisplay = Partial<Pick<PieceInstance,
  'templateId' | 'name' | 'currentHp' | 'maxHp' | 'attack' | 'defense' |
  'moveRange' | 'shield' | 'skills' | 'statusTags' | 'isCore' | 'ownerPlayerId' | 'faction'>>

export type AuthoredDisplayAudience = 'public' | 'owner' | 'allies' | 'enemies' | 'spectators'

/** A display plan is a set of detached snapshots keyed by the existing
 * presentation audience. `public` is the fallback view for all viewers. */
export interface AuthoredDisplayPlan {
  audiences: Partial<Record<AuthoredDisplayAudience, AuthoredDisplay>>
}

export type AuthoredDisplaySpec = AuthoredDisplay | AuthoredDisplayPlan

export type AuthoredSummonSpec = {
  recipe?: undefined
  mode: 'new-instance'
  x: number
  y: number
  template: AuthoredPieceTemplate
  display?: AuthoredDisplaySpec
} | {
  recipe?: undefined
  mode: 'return-instance'
  x: number
  y: number
  instanceId: string
  currentHp?: number
}
export interface AuthoredSummonCapabilityDeclaration {
  version: 1
  recipe: 'authored-piece'
  maxSummons: number
  modes: readonly AuthoredSummonSpec['mode'][]
}

const factions = ['red', 'blue', 'neutral', 'good', 'evil', 'light', 'dark'] as const
const audiences: readonly AuthoredDisplayAudience[] = ['public', 'owner', 'allies', 'enemies', 'spectators']
const fail = (message: string): never => { throw new Error('召唤：' + message) }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('需要结构体')
  return value as Record<string, unknown>
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('包含未声明字段')
}
function numeric(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.floor(value) < minimum || value > 1e9) fail('数值不合法')
  return Math.floor(value as number)
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 160) fail('名称或引用不合法')
  return value as string
}
function skills(value: unknown): PieceSkill[] {
  if (!Array.isArray(value) || value.length > 64) fail('技能列表不合法')
  const result = (value as unknown[]).map(item => {
    const entry = record(item)
    only(entry, ['skillId', 'instanceId', 'level', 'currentCooldown', 'usesRemaining', 'extension', 'abilityGroupIds', 'authorExtensionDeclarations'])
    const skill = { skillId: text(entry.skillId),
      ...(entry.instanceId === undefined ? {} : { instanceId: text(entry.instanceId) }),
      ...(entry.level === undefined ? {} : { level: numeric(entry.level, 1) }),
      ...(entry.currentCooldown === undefined ? {} : { currentCooldown: numeric(entry.currentCooldown) }),
      ...(entry.usesRemaining === undefined ? {} : { usesRemaining: numeric(entry.usesRemaining, -1) }) }
    if (entry.extension !== undefined) record(entry.extension)
    if (entry.abilityGroupIds !== undefined && (!Array.isArray(entry.abilityGroupIds) || entry.abilityGroupIds.some(item => typeof item !== 'string'))) fail('技能能力组引用不合法')
    if (entry.authorExtensionDeclarations !== undefined) record(entry.authorExtensionDeclarations)
    return { ...entry, ...skill } as PieceSkill
  })
  return result
}
function statuses(value: unknown): PieceStatusTag[] {
  if (!Array.isArray(value) || value.length > 256) fail('状态列表不合法')
  return (value as unknown[]).map(item => {
    const entry = record(item)
    text(entry.id); text(entry.type)
    for (const key of ['instanceId', 'name', 'stacking', 'lifetime']) if (entry[key] !== undefined) text(entry[key])
    for (const key of ['intensity', 'stacks', 'value']) if (entry[key] !== undefined) entry[key] = numeric(entry[key])
    for (const key of ['currentDuration', 'remainingDuration', 'currentUses', 'remainingUses', 'appliedTurn', 'lastDurationTickTurn']) if (entry[key] !== undefined) entry[key] = numeric(entry[key], -1)
    if (entry.expiresAfterTurn !== undefined && entry.expiresAfterTurn !== null) entry.expiresAfterTurn = numeric(entry.expiresAfterTurn, -1)
    for (const key of ['relatedRules', 'statusAliases']) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].some(item => typeof item !== 'string'))) fail('状态引用列表不合法')
    }
    if (entry.extension !== undefined) record(entry.extension)
    if (entry.authorExtensionDeclarations !== undefined) record(entry.authorExtensionDeclarations)
    if (entry.visible !== undefined && typeof entry.visible !== 'boolean') fail('状态可见性不合法')
    return entry as unknown as PieceStatusTag
  })
}
function parseSnapshot(value: unknown): AuthoredPieceSnapshot {
  const entry = record(value)
  only(entry, ['schemaVersion', 'kind', 'sourcePieceId', 'ownerPlayerId', 'identity', 'fields', 'flowState'])
  if (entry.schemaVersion !== 1 || entry.kind !== 'author-piece-instance/v1') fail('实例副本版本不受支持')
  const sourcePieceId = text(entry.sourcePieceId)
  const ownerPlayerId = text(entry.ownerPlayerId)
  const identity = record(entry.identity)
  only(identity, ['templateId', 'name', 'faction', 'ownerPlayerId', 'isCore'])
  text(identity.templateId); text(identity.name); text(identity.ownerPlayerId)
  if (identity.ownerPlayerId !== ownerPlayerId) fail('实例副本所属玩家不一致')
  if (!factions.includes(String(identity.faction) as Faction)) fail('实例副本阵营不合法')
  if (identity.isCore !== undefined && typeof identity.isCore !== 'boolean') fail('实例副本核心标识不合法')
  const fields = record(entry.fields)
  if (Object.keys(fields).some(key => key === 'instanceId' || key === 'x' || key === 'y')) fail('实例副本不能携带身份或坐标')
  const flowState = Array.isArray(entry.flowState)
    ? entry.flowState as unknown[]
    : fail('实例副本流程状态不合法')
  const snapshot: AuthoredPieceSnapshot = {
    schemaVersion: 1,
    kind: 'author-piece-instance/v1',
    sourcePieceId,
    ownerPlayerId,
    identity: {
      templateId: text(identity.templateId),
      name: text(identity.name),
      faction: identity.faction as Faction,
      ownerPlayerId,
      ...(identity.isCore === undefined ? {} : { isCore: identity.isCore as boolean }),
    },
    fields,
    flowState,
  }
  requireAuthorValue(snapshot, recordType(AUTHOR_PIECE_INSTANCE_SCHEMA_ID), AUTHOR_SUMMON_RECORD_SCHEMAS)
  return snapshot
}

function parseDisplayRecord(value: unknown): AuthoredDisplay {
  const entry = record(value)
  only(entry, ['templateId', 'name', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'shield', 'skills', 'statusTags', 'isCore', 'ownerPlayerId', 'faction'])
  for (const key of ['templateId', 'name', 'ownerPlayerId']) if (entry[key] !== undefined) text(entry[key])
  for (const key of ['currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'shield']) if (entry[key] !== undefined) entry[key] = numeric(entry[key])
  if (entry.faction !== undefined && !factions.includes(String(entry.faction) as Faction)) fail('显示阵营不合法')
  if (entry.isCore !== undefined && typeof entry.isCore !== 'boolean') fail('显示核心标识不合法')
  if (entry.skills !== undefined) entry.skills = skills(entry.skills)
  if (entry.statusTags !== undefined) entry.statusTags = statuses(entry.statusTags)
  return entry as AuthoredDisplay
}

export function cloneAuthoredData(value: unknown): Record<string, unknown> {
  return cloneAuthorInitialValue({ type: 'record', schemas: [], value })
}

export function parseAuthoredDisplay(value: unknown): AuthoredDisplay {
  return parseDisplayRecord(cloneAuthoredData(value))
}

export function parseAuthoredDisplaySpec(value: unknown): AuthoredDisplaySpec {
  const entry = cloneAuthoredData(value)
  if (Object.hasOwn(entry, 'audiences')) {
    only(entry, ['audiences'])
    const audienceValues = record(entry.audiences)
    const result: Partial<Record<AuthoredDisplayAudience, AuthoredDisplay>> = {}
    for (const key of Object.keys(audienceValues)) {
      if (!audiences.includes(key as AuthoredDisplayAudience)) fail('显示可见对象不合法')
      result[key as AuthoredDisplayAudience] = parseDisplayRecord(audienceValues[key])
    }
    return { audiences: result }
  }
  return parseDisplayRecord(entry)
}

/** Stable order makes a public fallback deterministic before an audience
 * specific override is applied by the existing projection map. */
export function authoredDisplayEntries(value: AuthoredDisplaySpec): readonly [AuthoredDisplayAudience, AuthoredDisplay][] {
  if (!Object.hasOwn(value, 'audiences')) return [['public', value as AuthoredDisplay]]
  const audienceValues = (value as AuthoredDisplayPlan).audiences
  return audiences.filter(audience => audienceValues[audience] !== undefined)
    .map(audience => [audience, audienceValues[audience]!] as [AuthoredDisplayAudience, AuthoredDisplay])
}

function snapshotField(snapshot: AuthoredPieceSnapshot | undefined, key: string): unknown {
  return snapshot?.fields[key]
}

/** Resolve source-based templates at summon preparation time. Only stable base
 * fields are inherited; skills, statuses, and rules remain empty unless the
 * author explicitly supplies them. */
export function resolveAuthoredPieceTemplate(template: AuthoredPieceTemplate, source?: PieceInstance, ownerFaction?: Faction): ResolvedAuthoredPieceTemplate {
  const snapshot = template.baseSnapshot
  const identity = snapshot?.identity
  const base = (key: string, fallback: unknown): unknown => snapshotField(snapshot, key) ?? fallback
  const templateId = template.templateId ?? identity?.templateId ?? source?.templateId
  const name = template.name ?? identity?.name ?? source?.name
  const maxHp = template.maxHp ?? base('maxHp', source?.maxHp)
  const currentHp = template.currentHp ?? (snapshot ? base('currentHp', source?.currentHp ?? maxHp) : maxHp)
  const attack = template.attack ?? base('attack', source?.attack)
  const defense = template.defense ?? base('defense', source?.defense)
  const moveRange = template.moveRange ?? base('moveRange', source?.moveRange)
  const ownerPlayerId = template.ownerPlayerId ?? snapshot?.ownerPlayerId ?? source?.ownerPlayerId
  const faction = template.faction ?? ownerFaction ?? identity?.faction ?? source?.faction
  if (typeof templateId !== 'string' || !templateId.length || typeof name !== 'string' || !name.length) fail('模板缺少名称或模板引用')
  const values = { maxHp, currentHp, attack, defense, moveRange }
  for (const [key, value] of Object.entries(values)) if (typeof value !== 'number' || !Number.isFinite(value)) fail('模板缺少' + key)
  const normalizedMaxHp = numeric(maxHp, 1)
  const normalizedCurrentHp = numeric(currentHp, 1)
  if (normalizedCurrentHp > normalizedMaxHp) fail('生命值超过生命上限')
  if (typeof ownerPlayerId !== 'string' || !ownerPlayerId.length) fail('模板缺少所属玩家')
  if (!factions.includes(String(faction) as Faction)) fail('模板阵营不合法')
  return {
    templateId: text(templateId), name: text(name), maxHp: normalizedMaxHp, currentHp: normalizedCurrentHp,
    attack: numeric(attack), defense: numeric(defense), moveRange: numeric(moveRange),
    ownerPlayerId: text(ownerPlayerId), faction: faction as Faction,
    isCore: template.isCore ?? false,
    skills: template.skills ? skills(template.skills) : [],
    rules: template.rules ? [...template.rules] : [],
    statusTags: template.statusTags ? statuses(template.statusTags) : [],
    ...(template.extension ? { extension: cloneAuthoredData(template.extension) } : {}),
  }
}

/** Named schemas shared by the compiler, editor catalog, and runtime author
 * value validator. They are generic piece/display records, not content or
 * character-specific declarations. */
const port = (name: string, type: GameplayValueType, optional = false, label?: string): GameplayPort => ({ name, type, ...(optional ? { optional: true } : {}), ...(label ? { label } : {}) })
const nullablePort = (name: string, type: GameplayValueType, label?: string): GameplayPort => ({ ...port(name, type, true, label), nullable: true })
const recordType = (schema: string): GameplayValueType => ({ kind: 'record', schema })
const listType = (element: GameplayValueType): GameplayValueType => ({ kind: 'list', element })

export const AUTHOR_PIECE_SKILL_SCHEMA_ID = 'author.piece-skill@1'
export const AUTHOR_PIECE_STATUS_SCHEMA_ID = 'author.piece-status@1'
export const AUTHOR_PIECE_RULE_SCHEMA_ID = 'author.piece-rule@1'
export const AUTHOR_PIECE_BUFF_SCHEMA_ID = 'author.piece-buff@1'
export const AUTHOR_PIECE_DEBUFF_SCHEMA_ID = 'author.piece-debuff@1'
export const AUTHOR_PIECE_IDENTITY_SCHEMA_ID = 'author.piece-identity@1'
export const AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID = 'author.piece-snapshot-fields@1'
export const AUTHOR_PIECE_FLOW_STATE_SCHEMA_ID = 'author.piece-flow-state@1'
export const AUTHOR_PIECE_INSTANCE_SCHEMA_ID = 'author.piece-instance@1'
export const AUTHOR_PIECE_DISPLAY_SCHEMA_ID = 'author.piece-display@1'
export const AUTHOR_PIECE_DISPLAY_AUDIENCES_SCHEMA_ID = 'author.piece-display-audiences@1'
export const AUTHOR_PIECE_DISPLAY_PLAN_SCHEMA_ID = 'author.piece-display-plan@1'
export const AUTHOR_PIECE_TEMPLATE_SCHEMA_ID = 'author.piece-template@1'

const schema = (id: string, fields: readonly GameplayPort[], additionalFields?: GameplayValueType): GameplayRecordSchema => ({
  id: id.slice(0, id.lastIndexOf('@')),
  version: id.slice(id.lastIndexOf('@') + 1),
  fields,
  ...(additionalFields === undefined ? {} : { additionalFields }),
})

export const AUTHOR_SUMMON_RECORD_SCHEMAS: readonly GameplayRecordSchema[] = Object.freeze([
  schema(AUTHOR_PIECE_SKILL_SCHEMA_ID, [
    port('skillId', 'string', false, '技能引用'), port('instanceId', 'string', true, '技能实例'), port('level', 'number', true, '等级'),
    port('currentCooldown', 'number', true, '当前冷却'), port('usesRemaining', 'number', true, '剩余次数'), port('extension', 'record', true, '技能扩展'),
    port('abilityGroupIds', listType('string'), true, '能力组'), port('authorExtensionDeclarations', 'record', true, '扩展声明'),
  ]),
  schema(AUTHOR_PIECE_STATUS_SCHEMA_ID, [
    port('id', 'string', false, '状态定义引用'), port('type', 'string', false, '状态类型'), port('name', 'string', true, '名称'),
    port('instanceId', 'string', true, '状态实例'), port('intensity', 'number', true, '强度'), port('stacks', 'number', true, '层数'),
    port('value', 'number', true, '数值'), port('currentDuration', 'number', true, '当前持续'), port('remainingDuration', 'number', true, '剩余持续'),
    port('currentUses', 'number', true, '当前次数'), port('remainingUses', 'number', true, '剩余次数'), port('visible', 'boolean', true, '可见'),
    port('stacking', 'string', true, '叠加方式'), port('lifetime', 'string', true, '生命周期'), port('appliedTurn', 'number', true, '施加回合'),
    nullablePort('expiresAfterTurn', 'number', '过期回合'), port('lastDurationTickTurn', 'number', true, '上次持续更新回合'),
    port('relatedRules', listType('string'), true, '关联规则'), port('statusAliases', listType('string'), true, '状态别名'),
    port('extension', 'record', true, '状态扩展'), port('authorExtensionDeclarations', 'record', true, '扩展声明'),
  ], 'json'),
  schema(AUTHOR_PIECE_RULE_SCHEMA_ID, [port('id', 'string', false, '规则引用')], 'json'),
  schema(AUTHOR_PIECE_BUFF_SCHEMA_ID, [
    port('type', 'string', false, '增益类型'), port('value', 'number', false, '增益数值'), port('duration', 'number', false, '持续时间'), port('source', 'string', false, '来源'),
  ], 'json'),
  schema(AUTHOR_PIECE_DEBUFF_SCHEMA_ID, [
    port('type', 'string', false, '减益类型'), port('value', 'number', false, '减益数值'), port('duration', 'number', false, '持续时间'), port('source', 'string', false, '来源'),
  ], 'json'),
  schema(AUTHOR_PIECE_IDENTITY_SCHEMA_ID, [
    port('templateId', 'string', false, '模板引用'), port('name', 'string', false, '名称'), port('faction', 'string', false, '阵营'),
    port('ownerPlayerId', 'string', false, '所属玩家'), port('isCore', 'boolean', true, '核心棋子'),
  ]),
  schema(AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID, [
    port('templateId', 'string', true, '模板引用'), port('name', 'string', true, '名称'), port('ownerPlayerId', 'string', true, '所属玩家'),
    port('faction', 'string', true, '阵营'), port('isCore', 'boolean', true, '核心棋子'), port('currentHp', 'number', true, '当前生命'),
    port('maxHp', 'number', true, '最大生命'), port('attack', 'number', true, '攻击力'), port('defense', 'number', true, '防御力'),
    port('moveRange', 'number', true, '移动力'), port('skills', listType(recordType(AUTHOR_PIECE_SKILL_SCHEMA_ID)), true, '技能'),
    port('displaySkills', listType(recordType(AUTHOR_PIECE_SKILL_SCHEMA_ID)), true, '显示技能'),
    port('buffs', listType(recordType(AUTHOR_PIECE_BUFF_SCHEMA_ID)), true, '增益'), port('debuffs', listType(recordType(AUTHOR_PIECE_DEBUFF_SCHEMA_ID)), true, '减益'),
    port('shield', 'number', true, '护盾'), port('ruleTags', listType('string'), true, '规则标签'),
    port('statusTags', listType(recordType(AUTHOR_PIECE_STATUS_SCHEMA_ID)), true, '状态'), port('rules', listType(recordType(AUTHOR_PIECE_RULE_SCHEMA_ID)), true, '规则'),
    port('extension', 'record', true, '扩展'),
  ], 'json'),
  schema(AUTHOR_PIECE_FLOW_STATE_SCHEMA_ID, [
    port('schemaVersion', 'number', false, '版本'), port('scope', 'string', false, '所属范围'), port('entityId', 'string', false, '所属实例'), port('ownerPlayerId', 'string', false, '所属玩家'),
    port('namespace', 'string', false, '变量分组'), port('name', 'string', false, '变量名'), port('value', 'json', false, '存储内容'), port('lifetime', 'string', false, '保留时长'), port('projectionVisibility', 'string', false, '可见范围'),
  ], 'json'),
  schema(AUTHOR_PIECE_INSTANCE_SCHEMA_ID, [
    port('schemaVersion', 'number', false, '版本'), port('kind', 'string', false, '类型'), port('sourcePieceId', 'string', false, '来源实例'),
    port('ownerPlayerId', 'string', false, '所属玩家'), port('identity', recordType(AUTHOR_PIECE_IDENTITY_SCHEMA_ID), false, '身份'),
    port('fields', recordType(AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID), false, '字段副本'), port('flowState', listType(recordType(AUTHOR_PIECE_FLOW_STATE_SCHEMA_ID)), false, '流程状态'),
  ]),
  schema(AUTHOR_PIECE_DISPLAY_SCHEMA_ID, [
    port('templateId', 'string', true, '模板引用'), port('name', 'string', true, '名称'), port('currentHp', 'number', true, '当前生命'),
    port('maxHp', 'number', true, '最大生命'), port('attack', 'number', true, '攻击力'), port('defense', 'number', true, '防御力'),
    port('moveRange', 'number', true, '移动力'), port('shield', 'number', true, '护盾'), port('skills', listType(recordType(AUTHOR_PIECE_SKILL_SCHEMA_ID)), true, '技能'),
    port('statusTags', listType(recordType(AUTHOR_PIECE_STATUS_SCHEMA_ID)), true, '状态'), port('isCore', 'boolean', true, '核心棋子'),
    port('ownerPlayerId', 'string', true, '所属玩家'), port('faction', 'string', true, '阵营'),
  ]),
  schema(AUTHOR_PIECE_DISPLAY_AUDIENCES_SCHEMA_ID, [
    port('public', recordType(AUTHOR_PIECE_DISPLAY_SCHEMA_ID), true, '公开'), port('owner', recordType(AUTHOR_PIECE_DISPLAY_SCHEMA_ID), true, '所属玩家'),
    port('allies', recordType(AUTHOR_PIECE_DISPLAY_SCHEMA_ID), true, '友方'), port('enemies', recordType(AUTHOR_PIECE_DISPLAY_SCHEMA_ID), true, '敌方'),
    port('spectators', recordType(AUTHOR_PIECE_DISPLAY_SCHEMA_ID), true, '观战者'),
  ]),
  schema(AUTHOR_PIECE_DISPLAY_PLAN_SCHEMA_ID, [port('audiences', recordType(AUTHOR_PIECE_DISPLAY_AUDIENCES_SCHEMA_ID), false, '可见对象')]),
  schema(AUTHOR_PIECE_TEMPLATE_SCHEMA_ID, [
    port('baseSnapshot', recordType(AUTHOR_PIECE_INSTANCE_SCHEMA_ID), true, '基础副本'), port('templateId', 'string', true, '模板引用'), port('name', 'string', true, '名称'),
    port('maxHp', 'number', true, '最大生命'), port('currentHp', 'number', true, '当前生命'), port('attack', 'number', true, '攻击力'),
    port('defense', 'number', true, '防御力'), port('moveRange', 'number', true, '移动力'), port('ownerPlayerId', 'string', true, '所属玩家'),
    port('faction', 'string', true, '阵营'), port('isCore', 'boolean', true, '核心棋子'), port('skills', listType(recordType(AUTHOR_PIECE_SKILL_SCHEMA_ID)), true, '初始技能'),
    port('rules', listType('string'), true, '初始规则'), port('statusTags', listType(recordType(AUTHOR_PIECE_STATUS_SCHEMA_ID)), true, '初始状态'), port('extension', 'record', true, '扩展'),
  ]),
])

export function parseAuthoredSummonSpec(value: unknown): AuthoredSummonSpec {
  const entry = cloneAuthoredData(value)
  if (!Number.isSafeInteger(entry.x) || !Number.isSafeInteger(entry.y)) fail('地格坐标必须是整数')
  if (entry.mode === 'return-instance') {
    only(entry, ['mode', 'x', 'y', 'instanceId', 'currentHp'])
    text(entry.instanceId)
    if (entry.currentHp !== undefined) entry.currentHp = numeric(entry.currentHp, 1)
    return entry as unknown as AuthoredSummonSpec
  }
  if (entry.mode !== 'new-instance') fail('召唤方式不合法')
  only(entry, ['mode', 'x', 'y', 'template', 'display'])
  const template = record(entry.template)
  only(template, ['baseSnapshot', 'templateId', 'name', 'maxHp', 'currentHp', 'attack', 'defense', 'moveRange', 'ownerPlayerId', 'faction', 'isCore', 'skills', 'rules', 'statusTags', 'extension'])
  if (template.baseSnapshot !== undefined) template.baseSnapshot = parseSnapshot(template.baseSnapshot)
  for (const key of ['templateId', 'name', 'ownerPlayerId']) if (template[key] !== undefined) text(template[key])
  for (const key of ['maxHp', 'currentHp', 'attack', 'defense', 'moveRange']) if (template[key] !== undefined) template[key] = numeric(template[key], key === 'maxHp' || key === 'currentHp' ? 1 : 0)
  if (template.currentHp !== undefined && template.maxHp !== undefined && Number(template.currentHp) > Number(template.maxHp)) fail('生命值超过生命上限')
  if (template.faction !== undefined && !factions.includes(String(template.faction) as Faction)) fail('阵营不合法')
  if (template.isCore !== undefined && typeof template.isCore !== 'boolean') fail('核心标识不合法')
  if (template.skills !== undefined) template.skills = skills(template.skills)
  if (template.rules !== undefined && (!Array.isArray(template.rules) || template.rules.length > 64 || template.rules.some(item => typeof item !== 'string' || !item.length))) fail('规则引用列表不合法')
  if (template.statusTags !== undefined) template.statusTags = statuses(template.statusTags)
  if (template.extension !== undefined) record(template.extension)
  if (entry.display !== undefined) entry.display = parseAuthoredDisplaySpec(entry.display)
  return entry as unknown as AuthoredSummonSpec
}
