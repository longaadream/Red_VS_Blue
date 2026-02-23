export type PieceId = string

export type Faction = "red" | "blue" | "neutral"

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
  isDefault?: boolean
}

export interface PieceInstance {
  instanceId: string
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
  buffs: PieceBuff[]
  debuffs: PieceDebuff[]
  shield?: number
  ruleTags: string[] // 存储相关的规则ID数组
  statusTags: Array<{
    id: string
    type: string
    currentDuration?: number
    currentUses?: number
    intensity?: number
    stacks?: number
    value?: number
    relatedRules?: string[]
    visible?: boolean
  }> // 存储状态变量的标签数组，如"bleeding-duration"
  rules: any[] // 存储对该棋子生效的规则
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
