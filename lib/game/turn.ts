import type { BoardMap } from "./map"
import type { PieceInstance, PieceStats } from "./piece"
import type { SkillDefinition } from "./skills"

export type TurnPhase = "start" | "action" | "end"

export type PlayerId = string

export interface PlayerTurnMeta {
  playerId: PlayerId
  /** 当前累计的充能点数（用于释放充能技能） */
  chargePoints: number
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

export interface BattleState {
  map: BoardMap
  pieces: PieceInstance[]
  /** 按棋子模板 ID 存储基础数值，供移动范围等逻辑使用 */
  pieceStatsByTemplateId: Record<string, PieceStats>
  /** 技能静态定义 */
  skillsById: Record<string, SkillDefinition>
  /** 两个玩家的资源状态（充能点等） */
  players: PlayerTurnMeta[]
  turn: TurnState
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
    }
  | {
      type: "useChargeSkill"
      playerId: PlayerId
      pieceId: string
      skillId: string
      targetX?: number
      targetY?: number
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

function getPlayerMeta(state: BattleState, playerId: PlayerId): PlayerTurnMeta {
  const meta = state.players.find((p) => p.playerId === playerId)
  if (!meta) {
    throw new BattleRuleError("Player not found in battle state")
  }
  return meta
}

function isCurrentPlayer(state: BattleState, playerId: PlayerId): boolean {
  return state.turn.currentPlayerId === playerId
}

function isCellOccupied(state: BattleState, x: number, y: number): boolean {
  return state.pieces.some((p) => p.x === x && p.y === y && p.currentHp > 0)
}

/**
 * 简化版移动规则：
 * - 直线移动（水平或垂直），类似象棋车。
 * - 距离不能超过棋子的 moveRange（如果未设置，则视为无限制）。
 * - 起点终点必须在地图范围内。
 * - 终点格必须可通行且没有其它棋子占据。
 * - 暂时不检查“路径被阻挡”，以后可以按需要增加。
 */
function validateMove(
  state: BattleState,
  piece: PieceInstance,
  toX: number,
  toY: number,
): void {
  if (piece.x == null || piece.y == null) {
    throw new BattleRuleError("Piece is not on the board")
  }

  const { width, height, tiles } = state.map
  if (toX < 0 || toX >= width || toY < 0 || toY >= height) {
    throw new BattleRuleError("Target position is outside of the board")
  }

  if (piece.x !== toX && piece.y !== toY) {
    throw new BattleRuleError("Move must be in a straight line (rook-style)")
  }

  const stats = state.pieceStatsByTemplateId[piece.templateId]
  const maxRange = stats?.moveRange
  const distance = Math.abs(piece.x - toX) + Math.abs(piece.y - toY)
  if (maxRange != null && maxRange > 0 && distance > maxRange) {
    throw new BattleRuleError("Move distance exceeds piece moveRange")
  }

  const targetTile = tiles.find((t) => t.x === toX && t.y === toY)
  if (!targetTile || !targetTile.props.walkable) {
    throw new BattleRuleError("Target tile is not walkable")
  }

  if (isCellOccupied(state, toX, toY)) {
    throw new BattleRuleError("Target tile is already occupied")
  }
}

function requireActionPhase(state: BattleState) {
  if (state.turn.phase !== "action") {
    throw new BattleRuleError("Action can only be performed during action phase")
  }
}

export function applyBattleAction(
  state: BattleState,
  action: BattleAction,
): BattleState {
  switch (action.type) {
    case "beginPhase": {
      const next = structuredClone(state) as BattleState
      if (next.turn.phase === "start") {
        // TODO：在这里触发“开始阶段效果”
        next.turn.phase = "action"
        return next
      }
      if (next.turn.phase === "end") {
        // 下一个玩家的回合开始
        const currentIndex = next.players.findIndex(
          (p) => p.playerId === next.turn.currentPlayerId,
        )
        const nextIndex =
          currentIndex === -1
            ? 0
            : (currentIndex + 1) % Math.max(next.players.length, 1)
        next.turn.currentPlayerId = next.players[nextIndex]!.playerId
        next.turn.turnNumber += 1
        next.turn.phase = "start"
        next.turn.actions = {
          hasMoved: false,
          hasUsedBasicSkill: false,
          hasUsedChargeSkill: false,
        }
        return next
      }
      return next
    }

    case "grantChargePoints": {
      const next = structuredClone(state) as BattleState
      const meta = getPlayerMeta(next, action.playerId)
      meta.chargePoints += action.amount
      return next
    }

    case "move": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }
      if (state.turn.actions.hasMoved) {
        throw new BattleRuleError("Move action already used this turn")
      }

      const next = structuredClone(state) as BattleState
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          p.ownerPlayerId === action.playerId &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      validateMove(next, piece, action.toX, action.toY)

      piece.x = action.toX
      piece.y = action.toY
      next.turn.actions.hasMoved = true
      return next
    }

    case "useBasicSkill": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }
      if (state.turn.actions.hasUsedBasicSkill) {
        throw new BattleRuleError("Basic skill already used this turn")
      }

      const next = structuredClone(state) as BattleState
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          p.ownerPlayerId === action.playerId &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      const skillDef = next.skillsById[action.skillId]
      if (!skillDef) {
        throw new BattleRuleError("Skill definition not found")
      }

      // 执行技能
      const { executeSkillFunction, applySkillEffects } = require('./skills')
      const context = {
        piece: {
          instanceId: piece.instanceId,
          templateId: piece.templateId,
          ownerPlayerId: piece.ownerPlayerId,
          currentHp: piece.currentHp,
          maxHp: piece.maxHp,
          attack: piece.attack,
          defense: piece.defense,
          x: piece.x || 0,
          y: piece.y || 0,
          moveRange: piece.moveRange,
        },
        target: null,
        battle: {
          turn: next.turn.turnNumber,
          currentPlayerId: next.turn.currentPlayerId,
          phase: next.turn.phase,
        },
        skill: {
          id: skillDef.id,
          name: skillDef.name,
          type: skillDef.type,
          powerMultiplier: skillDef.powerMultiplier,
        },
      }

      const result = executeSkillFunction(skillDef, context, next)
      if (result.success && result.effects) {
        applySkillEffects(next, result.effects, piece)
      }

      // 处理传送技能的目标位置
      if (skillDef.id === "teleport" && action.targetX !== undefined && action.targetY !== undefined) {
        // 检查目标位置是否有效
        const targetTile = next.map.tiles.find(t => t.x === action.targetX && t.y === action.targetY)
        if (targetTile && targetTile.props.walkable) {
          // 检查目标位置是否被占用
          const isOccupied = next.pieces.some(p => p.x === action.targetX && p.y === action.targetY && p.currentHp > 0)
          if (!isOccupied) {
            // 计算曼哈顿距离，确保在5格范围内
            const distance = Math.abs(action.targetX - (piece.x || 0)) + Math.abs(action.targetY - (piece.y || 0))
            if (distance <= 5) {
              piece.x = action.targetX
              piece.y = action.targetY
            }
          }
        }
      }

      next.turn.actions.hasUsedBasicSkill = true
      return next
    }

    case "useChargeSkill": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }
      if (state.turn.actions.hasUsedChargeSkill) {
        throw new BattleRuleError("Charge skill already used this turn")
      }

      const next = structuredClone(state) as BattleState
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          p.ownerPlayerId === action.playerId &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      const skillDef = next.skillsById[action.skillId]
      if (!skillDef) {
        throw new BattleRuleError("Skill definition not found")
      }

      const playerMeta = getPlayerMeta(next, action.playerId)
      const cost = skillDef.chargeCost ?? 0
      if (cost > 0 && playerMeta.chargePoints < cost) {
        throw new BattleRuleError("Not enough charge points to use this skill")
      }

      // 消耗充能点
      if (cost > 0) {
        playerMeta.chargePoints -= cost
      }

      // 执行技能
      const { executeSkillFunction, applySkillEffects } = require('./skills')
      const context = {
        piece: {
          instanceId: piece.instanceId,
          templateId: piece.templateId,
          ownerPlayerId: piece.ownerPlayerId,
          currentHp: piece.currentHp,
          maxHp: piece.maxHp,
          attack: piece.attack,
          defense: piece.defense,
          x: piece.x || 0,
          y: piece.y || 0,
          moveRange: piece.moveRange,
        },
        target: null,
        battle: {
          turn: next.turn.turnNumber,
          currentPlayerId: next.turn.currentPlayerId,
          phase: next.turn.phase,
        },
        skill: {
          id: skillDef.id,
          name: skillDef.name,
          type: skillDef.type,
          powerMultiplier: skillDef.powerMultiplier,
        },
      }

      const result = executeSkillFunction(skillDef, context, next)
      if (result.success && result.effects) {
        applySkillEffects(next, result.effects, piece)
      }

      next.turn.actions.hasUsedChargeSkill = true
      return next
    }

    case "endTurn": {
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("Only the current player can end the turn")
      }

      const next = structuredClone(state) as BattleState
      // TODO：在这里触发“结束阶段效果”，例如 DOT、buff 结算等。
      next.turn.phase = "end"
      return next
    }

    case "surrender": {
      // 投降逻辑：将投降玩家的所有棋子设置为阵亡状态
      const next = structuredClone(state) as BattleState
      
      // 找到投降玩家的所有棋子并设置为阵亡
      next.pieces.forEach(piece => {
        if (piece.ownerPlayerId === action.playerId) {
          piece.currentHp = 0
        }
      })
      
      return next
    }

    default:
      return state
  }
}

