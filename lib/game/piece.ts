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
