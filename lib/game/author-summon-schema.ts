import type { Faction, PieceInstance, PieceSkill, PieceStatusTag } from './piece'
import { cloneAuthorInitialValue } from './author-extension'

/** Values are evaluated by the author program before entering the authoritative
 * lifecycle. No executable code or caller-chosen instance identity is accepted. */
export interface AuthoredPieceTemplate {
  templateId: string
  name: string
  maxHp: number
  currentHp?: number
  attack: number
  defense: number
  moveRange: number
  ownerPlayerId?: string
  faction?: Faction
  isCore?: boolean
  skills?: PieceSkill[]
  rules?: string[]
  statusTags?: PieceStatusTag[]
  extension?: Record<string, unknown>
}
export type AuthoredDisplay = Partial<Pick<PieceInstance,
  'templateId' | 'name' | 'currentHp' | 'maxHp' | 'attack' | 'defense' |
  'moveRange' | 'skills' | 'statusTags' | 'isCore' | 'ownerPlayerId' | 'faction'>>
export type AuthoredSummonSpec = {
  recipe?: undefined
  mode: 'new-instance'
  x: number
  y: number
  template: AuthoredPieceTemplate
  display?: AuthoredDisplay
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

const factions = ['red', 'blue', 'neutral', 'good', 'evil', 'light', 'dark']
const fail = (message: string): never => { throw new Error('召唤：' + message) }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('需要结构体')
  return value as Record<string, unknown>
}
function only(value: Record<string, unknown>, keys: string[]) {
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
    only(entry, ['skillId', 'level', 'currentCooldown', 'usesRemaining'])
    return { skillId: text(entry.skillId),
      ...(entry.level === undefined ? {} : { level: numeric(entry.level, 1) }),
      ...(entry.currentCooldown === undefined ? {} : { currentCooldown: numeric(entry.currentCooldown) }),
      ...(entry.usesRemaining === undefined ? {} : { usesRemaining: numeric(entry.usesRemaining, -1) }) }
  })
  if (new Set(result.map(item => item.skillId)).size !== result.length) fail('技能引用重复')
  return result
}
function statuses(value: unknown): PieceStatusTag[] {
  if (!Array.isArray(value) || value.length > 256) fail('状态列表不合法')
  return (value as unknown[]).map(item => {
    const entry = record(item)
    text(entry.id); text(entry.type)
    for (const key of ['intensity', 'stacks']) if (entry[key] !== undefined) entry[key] = numeric(entry[key])
    for (const key of ['currentDuration', 'remainingDuration', 'currentUses', 'remainingUses']) if (entry[key] !== undefined) entry[key] = numeric(entry[key], -1)
    if (entry.visible !== undefined && typeof entry.visible !== 'boolean') fail('状态可见性不合法')
    return entry as unknown as PieceStatusTag
  })
}
export function cloneAuthoredData(value: unknown): Record<string, unknown> {
  return cloneAuthorInitialValue({ type: 'record', schemas: [], value })
}
export function parseAuthoredDisplay(value: unknown): AuthoredDisplay {
  const entry = cloneAuthoredData(value)
  only(entry, ['templateId', 'name', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'skills', 'statusTags', 'isCore', 'ownerPlayerId', 'faction'])
  for (const key of ['templateId', 'name', 'ownerPlayerId']) if (entry[key] !== undefined) text(entry[key])
  for (const key of ['currentHp', 'maxHp', 'attack', 'defense', 'moveRange']) if (entry[key] !== undefined) entry[key] = numeric(entry[key])
  if (entry.faction !== undefined && !factions.includes(String(entry.faction))) fail('显示阵营不合法')
  if (entry.isCore !== undefined && typeof entry.isCore !== 'boolean') fail('显示核心标识不合法')
  if (entry.skills !== undefined) entry.skills = skills(entry.skills)
  if (entry.statusTags !== undefined) entry.statusTags = statuses(entry.statusTags)
  return entry as AuthoredDisplay
}
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
  only(template, ['templateId', 'name', 'maxHp', 'currentHp', 'attack', 'defense', 'moveRange', 'ownerPlayerId', 'faction', 'isCore', 'skills', 'rules', 'statusTags', 'extension'])
  text(template.templateId); text(template.name)
  template.maxHp = numeric(template.maxHp, 1)
  for (const key of ['attack', 'defense', 'moveRange']) template[key] = numeric(template[key])
  if (template.currentHp !== undefined) {
    template.currentHp = numeric(template.currentHp, 1)
    if (Number(template.currentHp) > Number(template.maxHp)) fail('生命值超过生命上限')
  }
  if (template.ownerPlayerId !== undefined) text(template.ownerPlayerId)
  if (template.faction !== undefined && !factions.includes(String(template.faction))) fail('阵营不合法')
  if (template.isCore !== undefined && typeof template.isCore !== 'boolean') fail('核心标识不合法')
  if (template.skills !== undefined) template.skills = skills(template.skills)
  if (template.rules !== undefined && (!Array.isArray(template.rules) || template.rules.length > 64 || template.rules.some(item => typeof item !== 'string' || !item.length))) fail('规则引用列表不合法')
  if (template.statusTags !== undefined) template.statusTags = statuses(template.statusTags)
  if (template.extension !== undefined) record(template.extension)
  if (entry.display !== undefined) entry.display = parseAuthoredDisplay(entry.display)
  return entry as unknown as AuthoredSummonSpec
}
