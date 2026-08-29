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

export interface PieceStatusTag {
  id: string
  type: string
  name?: string
  currentDuration?: number
  remainingDuration?: number
  currentUses?: number
  intensity?: number
  stacks?: number
  value?: number
  relatedRules?: string[]
  visible?: boolean
  [key: string]: unknown
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
  initialStatusTags?: PieceStatusTag[]
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
  statusTags: PieceStatusTag[] // 存储状态变量的标签数组，如"bleeding-duration"
  rules: any[] // 对该棋子生效的可执行规则；显示状态由 statusTags 表达
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
