import type { AttachedEffectInstance } from './attached-effect'

export type PieceId = string

export type Faction = "red" | "blue" | "neutral" | "good" | "evil" | "light" | "dark"

export type PieceRarity = "common" | "rare" | "epic" | "legendary"

export interface PieceStats {
  maxHp: number
  attack: number
  defense: number
  moveRange: number
  speed?: number
  criticalRate?: number
}

export interface PieceSkill {
  skillId: string
  level?: number
  currentCooldown?: number
  /** 剩余使用次数，限定技为1，其他技能为-1（无限制） */
  usesRemaining?: number
}

export interface PieceTemplate {
  id: PieceId
  name: string
  faction: Faction
  description?: string
  rarity: PieceRarity
  image?: string
  stats: PieceStats
  skills: PieceSkill[]
  rules?: string[]
  /** 战斗开始时自动应用的效果 ID 列表（新统一效果系统） */
  initialEffects?: string[]
  isDefault?: boolean
  relatedCards?: string[]
}

export interface PieceInstance {
  instanceId: string
  /** Demo 初始阵容身份；召唤物不得继承。 */
  isCore?: boolean
  templateId: PieceId
  name: string
  ownerPlayerId: string
  faction: Faction
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  x: number | null
  y: number | null
  moveRange: number
  skills: PieceSkill[]
  displaySkills?: PieceSkill[]
  buffs: PieceBuff[]
  debuffs: PieceDebuff[]
  shield?: number
  ruleTags: string[] // 存储相关的规则ID数组
  statusTags: Array<{
    id: string
    type: string
    currentDuration?: number
    remainingDuration?: number
    currentUses?: number
    intensity?: number
    stacks?: number
    value?: number
    relatedRules?: string[]
    visible?: boolean
  }> // 存储状态变量的标签数组，如"bleeding-duration"
  rules: any[] // 存储对该棋子生效的规则（旧系统，迁移期间保留）
  /** 新统一效果系统：被动触发器 + 视觉状态合一 */
  attachedEffects?: AttachedEffectInstance[]
}

export interface PieceBuff {
  type: string
  value: number
  duration: number
  source: string
}

export interface PieceDebuff {
  type: string
  value: number
  duration: number
  source: string
}
