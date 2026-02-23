// 训练营专用类型定义
// 避免导入使用服务器端模块的文件

import type { BoardMap } from "./map"
import type { PieceInstance, PieceStats } from "./piece"

// 从 skills.ts 复制的类型定义
export type SkillId = string
export type SkillKind = "active" | "passive"
export type SkillType = "normal" | "super" | "ultimate"
export type DamageType = "physical" | "magical" | "true"

export interface SkillExecutionContext {
  piece: PieceInstance
  target?: PieceInstance
  targetPosition?: { x: number; y: number }
  battle: {
    turn: number
    currentPlayerId: string
    phase: string
  }
  skill: {
    id: string
    name: string
    type: SkillType
    powerMultiplier: number
  }
  damage?: number
}

export interface SkillExecutionResult {
  success: boolean
  message?: string
  damage?: number
  healed?: number
  statusEffects?: Array<{
    targetId: string
    type: string
    duration: number
    intensity: number
  }>
}

export type SkillForm = "melee" | "ranged" | "magic" | "projectile" | "area" | "self"

export interface SkillDefinition {
  id: string
  name: string
  description: string
  kind: SkillKind
  type: SkillType
  form: SkillForm
  range: number
  areaSize?: number
  actionPointCost: number
  cooldownTurns: number
  maxCharges: number
  powerMultiplier: number
  damageType?: DamageType
  code?: string
}

export interface SkillState {
  skillId: string
  currentCooldown: number
  currentCharges: number
  unlocked: boolean
}

// 从 turn.ts 复制的类型定义
export type TurnPhase = "start" | "action" | "end"
export type PlayerId = string

export interface PlayerTurnMeta {
  playerId: PlayerId
  name?: string
  chargePoints: number
  actionPoints: number
  maxActionPoints: number
}

export interface PerTurnActionFlags {
  hasMoved: boolean
  hasUsedBasicSkill: boolean
  hasUsedChargeSkill: boolean
}

export interface TurnState {
  currentPlayerId: PlayerId
  turnNumber: number
  phase: TurnPhase
  actions: PerTurnActionFlags
}

export interface BattleActionLog {
  type: string
  playerId: PlayerId
  turn: number
  payload?: {
    message?: string
    pieceId?: string
    [key: string]: any
  }
}

export interface BattleState {
  map: BoardMap
  pieces: PieceInstance[]
  graveyard: PieceInstance[]
  pieceStatsByTemplateId: Record<string, PieceStats>
  skillsById: Record<string, SkillDefinition>
  players: PlayerTurnMeta[]
  turn: TurnState
  actions?: BattleActionLog[]
}

export type BattleAction =
  | { type: "beginPhase" }
  | {
      type: "move"
      playerId: PlayerId
      pieceId: string
      toX: number
      toY: number
    }
  | {
      type: "useBasicSkill"
      playerId: PlayerId
      pieceId: string
      skillId: string
      targetX?: number
      targetY?: number
      targetPieceId?: string
    }
  | {
      type: "useChargeSkill"
      playerId: PlayerId
      pieceId: string
      skillId: string
      targetX?: number
      targetY?: number
      targetPieceId?: string
    }
  | {
      type: "endTurn"
      playerId: PlayerId
    }
