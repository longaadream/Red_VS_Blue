// 战斗系统类型定义
// 此文件只包含类型定义，不包含任何运行时代码
// 可以被客户端和服务器端安全导入

import type { BoardMap } from "./map"
import type { PieceInstance, PieceStats } from "./piece"
import type { SkillDefinition } from "./skills"

export type TurnPhase = "start" | "action" | "end"

export type PlayerId = string

export interface PlayerTurnMeta {
  playerId: PlayerId
  /** 玩家昵称 */
  name?: string
  /** 当前累计的充能点数（用于释放充能技能） */
  chargePoints: number
  /** 当前行动点 */
  actionPoints: number
  /** 最大行动点 */
  maxActionPoints: number
}

export interface PerTurnActionFlags {
  hasMoved: boolean
  hasUsedBasicSkill: boolean
  hasUsedChargeSkill: boolean
}

export interface TurnState {
  /** 当前处于回合中的玩家 */
  currentPlayerId: PlayerId
  /** 当前是第几个整回合（从 1 开始） */
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
    [key: string]: any
  }
}

export interface BattleState {
  map: BoardMap
  pieces: PieceInstance[]
  /** 墓地 - 存放死亡的棋子信息 */
  graveyard: PieceInstance[]
  /** 按棋子模板 ID 存储基础数值，供移动范围等逻辑使用 */
  pieceStatsByTemplateId: Record<string, PieceStats>
  /** 技能静态定义 */
  skillsById: Record<string, SkillDefinition>
  /** 两个玩家的资源状态（充能点等） */
  players: PlayerTurnMeta[]
  turn: TurnState
  /** 战斗日志 */
  actions?: BattleActionLog[]
  /** 毒素列表 - 存放黑百合等技能放置的毒素 */
  toxins?: Array<{ x: number; y: number; damage: number; casterOwnerId: string }>
}

export type BattleAction =
  | { type: "beginPhase" } // 用于从 start -> action 或 end -> 下个回合的 start
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
      /** 用户通过选项选择器选择的值 */
      selectedOption?: any
    }
  | {
      type: "useChargeSkill"
      playerId: PlayerId
      pieceId: string
      skillId: string
      targetX?: number
      targetY?: number
      targetPieceId?: string
      /** 用户通过选项选择器选择的值 */
      selectedOption?: any
    }
  | {
      type: "endTurn"
      playerId: PlayerId
    }
  | {
      type: "grantChargePoints"
      playerId: PlayerId
      amount: number
    }
  | {
      type: "surrender"
      playerId: PlayerId
    }

export class BattleRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BattleRuleError"
  }
}
