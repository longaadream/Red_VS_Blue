// 从 battle-types 导入类型（避免客户端导入时加载服务器端代码）
import type {
  TurnPhase,
  PlayerId,
  PlayerTurnMeta,
  PerTurnActionFlags,
  TurnState,
  BattleActionLog,
  BattleState,
  BattleAction,
  BattleRuleError as BattleRuleErrorType
} from "./battle-types"

// 简单的日志写入函数
function writeLog(message: string) {
  try {
    const fs = require('fs')
    const path = require('path')
    const logDir = path.join(process.cwd(), 'logs')
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    const logFile = path.join(logDir, 'game.log')
    const timestamp = new Date().toISOString()
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`)
  } catch {
    // 忽略日志写入错误
  }
}

// 重新导出类型，保持向后兼容
export type {
  TurnPhase,
  PlayerId,
  PlayerTurnMeta,
  PerTurnActionFlags,
  TurnState,
  BattleActionLog,
  BattleState,
  BattleAction
}

import type { BoardMap } from "./map"
import type { PieceInstance, PieceStats } from "./piece"
import type { SkillDefinition } from "./skills"
import { dealDamage, healDamage, loadRuleById } from "./skills"
import type { DamageType } from "./skills"
import { globalTriggerSystem } from "./triggers"
import { getSkillById } from "./skill-repository"

// ─── 辅助函数：恢复棋子规则的 effect 函数（用于 API 传输后重新加载）────────────────
function restorePieceRules(state: BattleState): void {
  state.pieces.forEach(piece => {
    // 确保 rules 数组存在
    if (!piece.rules) {
      piece.rules = []
    }

    // 1. 恢复现有规则的 effect 函数
    if (piece.rules.length > 0) {
      piece.rules.forEach((rule: any) => {
        // 如果 effect 不是函数，尝试重新加载
        if (typeof rule.effect !== 'function' && rule.id) {
          try {
            const reloadedRule = loadRuleById(rule.id)
            if (reloadedRule && typeof reloadedRule.effect === 'function') {
              rule.effect = reloadedRule.effect
            }
          } catch {
            // 忽略规则重载错误
          }
        }
      })
    }

    // 2. 根据状态标签重新添加丢失的规则
    if (piece.statusTags && piece.statusTags.length > 0) {
      piece.statusTags.forEach((statusTag: any) => {
        // 检查状态标签是否有关联的规则
        if (statusTag.relatedRules && statusTag.relatedRules.length > 0) {
          statusTag.relatedRules.forEach((ruleId: string) => {
            // 检查规则是否已存在
            const existingRule = piece.rules!.find((r: any) => r.id === ruleId)
            if (!existingRule) {
              // 规则不存在，重新添加
              try {
                const reloadedRule = loadRuleById(ruleId)
                if (reloadedRule && typeof reloadedRule.effect === 'function') {
                  piece.rules!.push(reloadedRule)
                }
              } catch {
                // 忽略规则重载错误
              }
            }
          })
        }

        // 注意：规则应该通过 statusTag.relatedRules 来关联
        // 不要在这里硬编码状态到规则的映射
        // 每个技能在添加状态时应该自行设置 relatedRules
      })
    }
  })
}

// ─── 辅助函数：恢复玩家规则的 effect 函数（用于 API 传输后重新加载）────────────────
function restorePlayerRules(state: BattleState): void {
  state.players.forEach(player => {
    // 确保 rules 数组存在
    if (!player.rules) {
      player.rules = []
    }

    // 恢复现有规则的 effect 函数
    if (player.rules.length > 0) {
      player.rules.forEach((rule: any) => {
        // 如果 effect 不是函数，尝试重新加载
        if (typeof rule.effect !== 'function' && rule.id) {
          try {
            const reloadedRule = loadRuleById(rule.id)
            if (reloadedRule && typeof reloadedRule.effect === 'function') {
              rule.effect = reloadedRule.effect
            }
          } catch {
            // 忽略规则重载错误
          }
        }
      })
    }
  })
}

// ─── 辅助函数：安全地克隆 BattleState（处理函数无法克隆的问题）────────────────
function safeCloneBattleState(state: BattleState): BattleState {
  // 临时存储所有棋子的规则函数
  const pieceRulesFunctions: Map<number, any[]> = new Map()
  // 临时存储所有玩家的规则函数
  const playerRulesFunctions: Map<number, any[]> = new Map()

  // 提取棋子规则函数
  state.pieces.forEach((piece, index) => {
    if (piece.rules && piece.rules.length > 0) {
      pieceRulesFunctions.set(index, piece.rules.map(rule => rule.effect))
      // 移除函数以便克隆
      piece.rules.forEach((rule: any) => {
        delete rule.effect
      })
    }
  })

  // 提取玩家规则函数
  state.players.forEach((player, index) => {
    const playerRules = (player as any).rules
    if (playerRules && Array.isArray(playerRules) && playerRules.length > 0) {
      const effects = playerRules.map((rule: any) => rule.effect)
      playerRulesFunctions.set(index, effects)
      // 移除函数以便克隆
      playerRules.forEach((rule: any) => {
        delete rule.effect
      })
    }
  })

  // 克隆状态
  const cloned = structuredClone(state) as BattleState
   
  // 恢复棋子规则函数到原始状态
  state.pieces.forEach((piece, index) => {
    if (piece.rules && piece.rules.length > 0) {
      const functions = pieceRulesFunctions.get(index)
      if (functions) {
        piece.rules.forEach((rule: any, ruleIndex: number) => {
          rule.effect = functions[ruleIndex]
        })
        // 同时恢复克隆对象中的函数
        if (cloned.pieces[index].rules) {
          cloned.pieces[index].rules.forEach((rule: any, ruleIndex: number) => {
            rule.effect = functions[ruleIndex]
          })
        }
      }
    }
  })

  // 恢复玩家规则函数到原始状态
  state.players.forEach((player, index) => {
    if ((player as any).rules && (player as any).rules.length > 0) {
      const functions = playerRulesFunctions.get(index)
      if (functions) {
        (player as any).rules.forEach((rule: any, ruleIndex: number) => {
          rule.effect = functions[ruleIndex]
        })
        // 同时恢复克隆对象中的函数
        if ((cloned.players[index] as any).rules) {
          (cloned.players[index] as any).rules.forEach((rule: any, ruleIndex: number) => {
            rule.effect = functions[ruleIndex]
          })
        }
      }
    }
  })

  return cloned
}

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
  /** 当前手牌（最多 10 张） */
  hand: { cardId: string; instanceId: string; ownerPlayerId: string }[]
  /** 弃牌堆（只记 cardId） */
  discardPile: string[]
  /** 玩家级别规则（挂在玩家身上而非棋子上的被动触发器） */
  rules?: any[]
  /** 玩家级别状态标签（如时空扭曲等阵营buff） */
  statusTags?: any[]
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
  /** 扩展数据 - 角色特定的数据存储在这里 */
  extensions?: Record<string, any>
  /** gameStart 触发器是否已触发过 */
  gameStartFired?: boolean
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
  | {
      type: "playCard"
      playerId: PlayerId
      cardInstanceId: string
      targetPieceId?: string
      targetX?: number
      targetY?: number
      selectedOption?: any
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
  // 使用大小写不敏感的比较
  return state.turn.currentPlayerId.toLowerCase() === playerId.toLowerCase()
}

// 辅助函数：大小写不敏感地比较两个玩家ID
function isSamePlayer(playerId1: PlayerId, playerId2: PlayerId): boolean {
  return playerId1.toLowerCase() === playerId2.toLowerCase()
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

  const maxRange = piece.moveRange
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
  // 恢复棋子和玩家规则的 effect 函数（API 传输后函数会丢失）
  restorePieceRules(state)
  restorePlayerRules(state)

  switch (action.type) {
    case "beginPhase": {
      const next = safeCloneBattleState(state)
      writeLog('[beginPhase] Current phase: ' + next.turn.phase + ', gameStartFired: ' + next.gameStartFired + ', turnNumber: ' + next.turn.turnNumber)
      if (next.turn.phase === "start") {
        // ── 游戏开始时触发一次 gameStart 规则（第一回合第一个 beginPhase）────
        if (!next.gameStartFired && next.turn.turnNumber === 1) {
          writeLog('[beginPhase] Triggering gameStart rules...')
          next.gameStartFired = true
          const gameStartResult = globalTriggerSystem.checkTriggers(next, {
            type: "gameStart",
            playerId: next.turn.currentPlayerId,
            turnNumber: 1
          })
          writeLog('[beginPhase] gameStart result: ' + JSON.stringify(gameStartResult))
          if (gameStartResult.success && gameStartResult.messages.length > 0) {
            if (!next.actions) next.actions = []
            gameStartResult.messages.forEach(message => {
              next.actions!.push({ type: "triggerEffect", playerId: next.turn.currentPlayerId, turn: 1, payload: { message } })
            })
          }
        }

        // 触发回合开始效果（只调用一次，checkTriggers会扫描所有棋子和玩家的规则）
        const beginTurnResult = globalTriggerSystem.checkTriggers(next, {
          type: "beginTurn",
          turnNumber: next.turn.turnNumber,
          playerId: next.turn.currentPlayerId
        });

        // 处理触发效果的消息
        if (beginTurnResult.success && beginTurnResult.messages.length > 0) {
          if (!next.actions) {
            next.actions = [];
          }
          beginTurnResult.messages.forEach(message => {
            next.actions!.push({
              type: "triggerEffect",
              playerId: next.turn.currentPlayerId,
              turn: next.turn.turnNumber,
              payload: {
                message
              }
            });
          });
        }

        // 更新冷却
        globalTriggerSystem.updateCooldowns();
        
        // 行动点已经在回合切换时设置，这里不再重复增加
        // 确保当前玩家有行动点属性
        const currentPlayerMeta = next.players.find(p => p.playerId === next.turn.currentPlayerId)
        if (currentPlayerMeta) {
          console.log(`Player ${currentPlayerMeta.playerId} has ${currentPlayerMeta.actionPoints}/${currentPlayerMeta.maxActionPoints} action points for this turn`)
        }

        // 更新当前玩家棋子技能的冷却时间
        next.pieces.forEach(piece => {
          // 只减少当前玩家棋子的技能冷却
          if (isSamePlayer(piece.ownerPlayerId, next.turn.currentPlayerId) && piece.skills) {
            piece.skills.forEach(skill => {
              if (skill.currentCooldown && skill.currentCooldown > 0) {
                skill.currentCooldown--
              }
            })
          }
        })

        // 触发whenever规则（每一步行动后检测）
        const wheneverResult = globalTriggerSystem.checkTriggers(next, {
          type: "whenever",
          playerId: next.turn.currentPlayerId,
          turnNumber: next.turn.turnNumber
        });

        // 处理whenever触发效果的消息
        if (wheneverResult.success && wheneverResult.messages.length > 0) {
          if (!next.actions) {
            next.actions = [];
          }
          wheneverResult.messages.forEach(message => {
            next.actions!.push({
              type: "triggerEffect",
              playerId: next.turn.currentPlayerId,
              turn: next.turn.turnNumber,
              payload: {
                message
              }
            });
          });
        }

        // ── 特殊地形效果（每回合开始时，对当前玩家的棋子生效）────────────────
        // 快照避免熔岩致死后影响当前遍历
        const tileEffectPieces = next.pieces.filter(
          (p) => isSamePlayer(p.ownerPlayerId, next.turn.currentPlayerId) && p.currentHp > 0,
        )
        for (const piece of tileEffectPieces) {
          if (piece.x == null || piece.y == null) continue
          const tile = next.map.tiles.find((t) => t.x === piece.x && t.y === piece.y)
          if (!tile) continue

          // 熔岩伤害：调用 dealDamage（true 伤害），完整联动触发器和护盾等效果
          if (tile.props.damagePerTurn && tile.props.damagePerTurn > 0) {
            dealDamage(piece, piece, tile.props.damagePerTurn, "true", next, "lava-terrain")
          }

          // 治愈泉回复：调用 healDamage，完整联动触发器和反治疗等效果
          // 伤害结算后再检查存活，避免对已死棋子治疗
          if (tile.props.healPerTurn && tile.props.healPerTurn > 0 && piece.currentHp > 0) {
            healDamage(piece, piece, tile.props.healPerTurn, next, "spring-terrain")
          }

          // 充能台：直接给玩家加充能点（无护盾/触发器概念，简单累加）
          if (tile.props.chargePerTurn && tile.props.chargePerTurn > 0 && piece.currentHp > 0) {
            const playerMeta = next.players.find((p) => isSamePlayer(p.playerId, piece.ownerPlayerId))
            if (playerMeta) {
              playerMeta.chargePoints += tile.props.chargePerTurn
              if (!next.actions) next.actions = []
              next.actions.push({
                type: "tileEffect",
                playerId: piece.ownerPlayerId,
                turn: next.turn.turnNumber,
                payload: {
                  message: `${piece.name || piece.templateId} 在充能台上获得了 ${tile.props.chargePerTurn} 充能点`,
                  pieceId: piece.instanceId,
                },
              })
            }
          }
        }

        next.turn.phase = "action"
        return next
      }
      if (next.turn.phase === "end") {
        // 下一个玩家的回合开始
        const currentIndex = next.players.findIndex(
          (p) => isSamePlayer(p.playerId, next.turn.currentPlayerId),
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
        
        // 确保新回合的玩家有初始行动点和最大行动点
        const nextPlayerMeta = next.players[nextIndex]
        if (nextPlayerMeta) {
          // 实现类似炉石传说的法力水晶机制
          // 每回合开始时，最大行动点+1（最多10点），当前行动点充满
          if (nextPlayerMeta.maxActionPoints === undefined) {
            nextPlayerMeta.maxActionPoints = 1 // 初始最大行动点
          } else if (nextPlayerMeta.maxActionPoints < 10) {
            nextPlayerMeta.maxActionPoints += 1 // 每回合增长1点
          }
          // 充满行动点
          nextPlayerMeta.actionPoints = nextPlayerMeta.maxActionPoints
        }
        
        // 获取当前玩家的所有棋子
        // 触发回合开始效果（只调用一次，checkTriggers会扫描所有棋子和玩家的规则）
        const beginTurnResult = globalTriggerSystem.checkTriggers(next, {
          type: "beginTurn",
          turnNumber: next.turn.turnNumber,
          playerId: next.turn.currentPlayerId
        });

        // 处理触发效果的消息
        if (beginTurnResult.success && beginTurnResult.messages.length > 0) {
          if (!next.actions) {
            next.actions = [];
          }
          beginTurnResult.messages.forEach(message => {
            next.actions!.push({
              type: "triggerEffect",
              playerId: next.turn.currentPlayerId,
              turn: next.turn.turnNumber,
              payload: {
                message
              }
            });
          });
        }

        // 更新冷却
        globalTriggerSystem.updateCooldowns();
        
        // 更新当前玩家棋子技能的冷却时间
        next.pieces.forEach(piece => {
          // 只减少当前玩家棋子的技能冷却
          if (isSamePlayer(piece.ownerPlayerId, next.turn.currentPlayerId) && piece.skills) {
            piece.skills.forEach(skill => {
              if (skill.currentCooldown && skill.currentCooldown > 0) {
                skill.currentCooldown--
              }
            })
          }
        })

        // 触发whenever规则（每一步行动后检测）
        const wheneverResult = globalTriggerSystem.checkTriggers(next, {
          type: "whenever",
          playerId: next.turn.currentPlayerId,
          turnNumber: next.turn.turnNumber
        });

        // 处理whenever触发效果的消息
        if (wheneverResult.success && wheneverResult.messages.length > 0) {
          if (!next.actions) {
            next.actions = [];
          }
          wheneverResult.messages.forEach(message => {
            next.actions!.push({
              type: "triggerEffect",
              playerId: next.turn.currentPlayerId,
              turn: next.turn.turnNumber,
              payload: {
                message
              }
            });
          });
        }
        
        // 特殊地形效果（每回合开始时，对当前玩家的棋子生效）
        const tileEffectPieces = next.pieces.filter(
          (p) => isSamePlayer(p.ownerPlayerId, next.turn.currentPlayerId) && p.currentHp > 0,
        )
        for (const piece of tileEffectPieces) {
          if (piece.x == null || piece.y == null) continue
          const tile = next.map.tiles.find((t) => t.x === piece.x && t.y === piece.y)
          if (!tile) continue

          // 熔岩伤害
          if (tile.props.damagePerTurn && tile.props.damagePerTurn > 0) {
            dealDamage(piece, piece, tile.props.damagePerTurn, "true", next, "lava-terrain")
          }

          // 治愈泉回复
          if (tile.props.healPerTurn && tile.props.healPerTurn > 0 && piece.currentHp > 0) {
            healDamage(piece, piece, tile.props.healPerTurn, next, "spring-terrain")
          }

          // 充能台
          if (tile.props.chargePerTurn && tile.props.chargePerTurn > 0 && piece.currentHp > 0) {
            const playerMeta = next.players.find((p) => isSamePlayer(p.playerId, piece.ownerPlayerId))
            if (playerMeta) {
              playerMeta.chargePoints += tile.props.chargePerTurn
              if (!next.actions) next.actions = []
              next.actions.push({
                type: "tileEffect",
                playerId: piece.ownerPlayerId,
                turn: next.turn.turnNumber,
                payload: {
                  message: `${piece.name || piece.templateId} 在充能台上获得了 ${tile.props.chargePerTurn} 充能点`,
                  pieceId: piece.instanceId,
                },
              })
            }
          }
        }
        
        // 直接进入action阶段，不需要前端再次发送beginPhase
        next.turn.phase = "action"
        
        return next
      }
      return next
    }

    case "grantChargePoints": {
      const next = safeCloneBattleState(state)
      const meta = getPlayerMeta(next, action.playerId)
      meta.chargePoints += action.amount

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = globalTriggerSystem.checkTriggers(next, {
        type: "whenever",
        playerId: action.playerId
      });

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "move": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }

      // 检查行动点是否足够
      const playerMetaCheck = getPlayerMeta(state, action.playerId)
      if (playerMetaCheck.actionPoints < 1) {
        throw new BattleRuleError("Not enough action points to move")
      }

      const next = safeCloneBattleState(state)
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          isSamePlayer(p.ownerPlayerId, action.playerId) &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      // 触发即将移动前的规则（检查冰冻等状态）
      // 使用可修改的上下文对象，触发器可以修改 targetX/targetY 来改变移动目标
      const moveContext = {
        type: "beforeMove" as const,
        sourcePiece: piece,
        playerId: action.playerId,
        targetX: action.toX,
        targetY: action.toY
      };
      const beforeMoveResult = globalTriggerSystem.checkTriggers(next, moveContext);

      // 检查是否有规则触发了效果
      if (beforeMoveResult.success) {
        // 初始化actions数组
        if (!next.actions) {
          next.actions = [];
        }
        beforeMoveResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // 检查是否有规则明确阻止了行动（在添加消息之后检查）
      if (beforeMoveResult.blocked) {
        return next; // 返回包含消息的状态，不执行移动
      }

      // 触发器可能修改了目标位置，使用修改后的值
      const finalToX = moveContext.targetX;
      const finalToY = moveContext.targetY;

      validateMove(next, piece, finalToX, finalToY)

      // 记录移动前的位置
      const fromX = piece.x
      const fromY = piece.y

      // 执行移动（使用触发器可能修改后的目标位置）
      piece.x = finalToX
      piece.y = finalToY
      
      // 消耗行动点
      const playerMeta = getPlayerMeta(next, action.playerId)
      playerMeta.actionPoints -= 1
      
      // 初始化actions数组（如果不存在）
      if (!next.actions) {
        next.actions = []
      }
      
      // 记录移动信息到战斗日志
      const pieceName = piece.name || piece.templateId;
      const moveMessage = `${pieceName}从(${fromX}, ${fromY})移动到(${finalToX}, ${finalToY})`;

      next.actions.push({
        type: "move",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: moveMessage,
          pieceId: action.pieceId,
          fromX,
          fromY,
          toX: finalToX,
          toY: finalToY
        }
      })

      // 触发移动后的规则
      const moveResult = globalTriggerSystem.checkTriggers(next, {
        type: "afterMove",
        sourcePiece: piece,
        playerId: action.playerId
      });

      // 处理触发效果的消息
      if (moveResult.success && moveResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        moveResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = globalTriggerSystem.checkTriggers(next, {
        type: "whenever",
        sourcePiece: piece,
        playerId: action.playerId
      });

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "useBasicSkill": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }
      // 取消一回合只能用一个技能的限制
      // if (state.turn.actions.hasUsedBasicSkill) {
      //   throw new BattleRuleError("Basic skill already used this turn")
      // }

      const next = safeCloneBattleState(state)
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          isSamePlayer(p.ownerPlayerId, action.playerId) &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      // 触发即将使用技能前的规则（检查冰冻等状态）
      // 使用可修改的上下文对象，触发器可以修改 skillId 来改变使用的技能
      const skillUseContext = {
        type: "beforeSkillUse" as const,
        sourcePiece: piece,
        playerId: action.playerId,
        skillId: action.skillId
      };
      const beforeSkillUseResult = globalTriggerSystem.checkTriggers(next, skillUseContext);

      // 检查是否有规则阻止了技能使用
      if (beforeSkillUseResult.success) {
        // 初始化actions数组
        if (!next.actions) {
          next.actions = [];
        }
        beforeSkillUseResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // 检查是否有规则明确阻止了行动（在添加消息之后检查）
      if (beforeSkillUseResult.blocked) {
        return next; // 返回包含消息的状态，不执行技能
      }

      // 检查施法者是否还活着（可能被 beforeSkillUse 触发器杀死）
      const currentPiece = next.pieces.find(p => p.instanceId === piece.instanceId)
      if (!currentPiece || currentPiece.currentHp <= 0) {
        writeLog(`[applyBattleAction] Caster ${piece.name} was killed by beforeSkillUse trigger, aborting skill execution`)
        return next; // 施法者已死亡，不执行技能
      }

      // 触发器可能修改了技能ID，使用修改后的值
      const finalSkillId = skillUseContext.skillId;

      // 优先使用战局中已加载的技能定义，回退到模块缓存
      // 使用触发器可能修改后的技能ID
      let skillDef = next.skillsById[finalSkillId] || getSkillById(finalSkillId)

      // 检查行动点是否足够
      const playerMeta = getPlayerMeta(state, action.playerId)
      if (playerMeta.actionPoints < skillDef.actionPointCost) {
        throw new BattleRuleError(`Not enough action points to use ${skillDef.name}`)
      }

      // 检查技能是否在冷却中
      if (piece.skills) {
        const skillState = piece.skills.find(s => s.skillId === finalSkillId)
        if (skillState && skillState.currentCooldown && skillState.currentCooldown > 0) {
          throw new BattleRuleError(
            `Skill ${finalSkillId} is on cooldown for ${skillState.currentCooldown} more turns`,
          )
        }

        // 检查限定技的使用次数
        if (skillState && skillDef.type === "ultimate" && skillState.usesRemaining <= 0) {
          throw new BattleRuleError(`Ultimate skill ${finalSkillId} has already been used`)
        }
      }

      // 执行技能（使用触发器可能修改后的技能ID）
      const { executeSkillFunction } = require('./skills')
      
      // 构建目标信息
      let targetInfo = null;
      let targetPositionInfo = null;
      if (action.targetPieceId) {
        const targetPiece = next.pieces.find(p => p.instanceId === action.targetPieceId);
        if (targetPiece) {
          targetInfo = {
            instanceId: targetPiece.instanceId,
            templateId: targetPiece.templateId,
            ownerPlayerId: targetPiece.ownerPlayerId,
            currentHp: targetPiece.currentHp,
            maxHp: targetPiece.maxHp,
            attack: targetPiece.attack,
            defense: targetPiece.defense,
            x: targetPiece.x || 0,
            y: targetPiece.y || 0,
          };
          // 如果选择了棋子，也将其位置作为目标位置
          targetPositionInfo = {
            x: targetPiece.x || 0,
            y: targetPiece.y || 0,
          };
        }
      } else if (action.targetX !== undefined && action.targetY !== undefined) {
        // 如果选择了格子，设置目标位置
        targetPositionInfo = {
          x: action.targetX,
          y: action.targetY,
        };
      }
      
      const context = {
        piece: piece,
        target: targetInfo,
        targetPosition: targetPositionInfo,
        selectedOption: (action as any).selectedOption,
        battle: next,
        skill: {
          id: skillDef.id,
          name: skillDef.name,
          type: skillDef.type,
          powerMultiplier: skillDef.powerMultiplier,
        },
      }

      writeLog('[useChargeSkill] Calling executeSkillFunction...')
      let result;
      try {
        result = executeSkillFunction(skillDef, context, next)
        writeLog('[useChargeSkill] executeSkillFunction result: ' + JSON.stringify({success: result.success, needsTargetSelection: result.needsTargetSelection, targetType: result.targetType}))
      } catch (err) {
        writeLog('[useChargeSkill] executeSkillFunction ERROR: ' + (err instanceof Error ? err.message : String(err)))
        throw err
      }

      // 检查是否需要目标选择
      if (result.needsTargetSelection) {
        // 创建一个包含目标选择信息的错误对象
        const targetSelectionError = new BattleRuleError('需要选择目标') as any
        targetSelectionError.needsTargetSelection = true
        targetSelectionError.targetType = result.targetType || 'piece'
        targetSelectionError.range = result.range || 5
        targetSelectionError.filter = result.filter || 'enemy'
        throw targetSelectionError
      }

      // 检查是否需要选项选择
      if (result.needsOptionSelection) {
        const optionSelectionError = new BattleRuleError('需要选择选项') as any
        optionSelectionError.needsOptionSelection = true
        optionSelectionError.options = result.options || []
        optionSelectionError.title = result.title || '请选择'
        throw optionSelectionError
      }
      
      if (result.success) {
        // 效果已经在技能执行时直接应用，这里只需要处理返回的消息
        
        // 消耗行动点
        const playerMeta = getPlayerMeta(next, action.playerId)
        playerMeta.actionPoints -= skillDef.actionPointCost
        
        // 设置技能冷却
        if (skillDef.cooldownTurns > 0 || skillDef.type === "ultimate") {
          // 找到棋子的技能状态并设置冷却
          if (piece.skills) {
            const skillIndex = piece.skills.findIndex(s => s.skillId === finalSkillId)
            if (skillIndex !== -1) {
              // 设置冷却
              if (skillDef.cooldownTurns > 0) {
                piece.skills[skillIndex].currentCooldown = skillDef.cooldownTurns
              }

              // 减少限定技使用次数
              if (skillDef.type === "ultimate") {
                piece.skills[skillIndex].usesRemaining -= 1
              }
            }
            // 注意：不在此处重新添加技能，规则系统可能已在技能执行期间移除了该技能
          } else {
            // 如果棋子没有skills属性，初始化它
            const usesRemaining = skillDef.type === "ultimate" ? 0 : -1 // 限定技使用后剩余0次，其他技能无限制
            piece.skills = [{
              skillId: finalSkillId,
              level: 1,
              currentCooldown: skillDef.cooldownTurns,
              usesRemaining: usesRemaining
            }]
          }
        }
      }

      // 初始化actions数组
      if (!next.actions) {
        next.actions = []
      }

      // 存储技能执行消息到战斗日志
      // 构建更详细的技能释放消息
      const pieceName = piece.name || piece.templateId;
      let skillMessage = `${pieceName}使用了${skillDef.name || finalSkillId}`;
      
      // 如果有目标，添加目标信息
      if (action.targetPieceId) {
        const targetPiece = next.pieces.find(p => p.instanceId === action.targetPieceId);
        if (targetPiece) {
          const targetName = targetPiece.name || targetPiece.templateId;
          skillMessage += `，目标是${targetName}`;
        }
      } else if (action.targetX !== undefined && action.targetY !== undefined) {
        skillMessage += `，目标位置是(${action.targetX}, ${action.targetY})`;
      }
      
      // 添加技能执行结果消息
      if (result.message) {
        skillMessage += `，${result.message}`;
      }
      
      next.actions.push({
        type: "useBasicSkill",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: skillMessage,
          skillId: action.skillId,
          pieceId: action.pieceId
        }
      })

      // 不再设置 hasUsedBasicSkill，允许一回合使用多个技能

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = globalTriggerSystem.checkTriggers(next, {
        type: "whenever",
        sourcePiece: piece,
        playerId: action.playerId,
        skillId: action.skillId
      });

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "useChargeSkill": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }
      // 取消一回合只能用一个技能的限制
      // if (state.turn.actions.hasUsedChargeSkill) {
      //   throw new BattleRuleError("Charge skill already used this turn")
      // }

      const next = safeCloneBattleState(state)
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          isSamePlayer(p.ownerPlayerId, action.playerId) &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      // 触发即将使用技能前的规则（检查冰冻等状态）
      // 使用可修改的上下文对象，触发器可以修改 skillId 来改变使用的技能
      const skillUseContext = {
        type: "beforeSkillUse" as const,
        sourcePiece: piece,
        playerId: action.playerId,
        skillId: action.skillId
      };
      const beforeSkillUseResult = globalTriggerSystem.checkTriggers(next, skillUseContext);

      // 触发器可能修改了技能ID，使用修改后的值
      const finalSkillId = skillUseContext.skillId;

      let skillDef = next.skillsById[finalSkillId]

      // 如果技能定义找不到，使用默认技能定义
      if (!skillDef) {
        skillDef = {
          id: finalSkillId,
          name: finalSkillId,
          description: "Default skill",
          kind: "active",
          type: "super",
          cooldownTurns: 0,
          maxCharges: 0,
          chargeCost: 1,
          powerMultiplier: 1,
          code: "function executeSkill(context) { return { message: 'Skill executed', success: true } }",
          range: "self",
          requiresTarget: false,
          actionPointCost: 2
        }
      }

      // 检查行动点是否足够
      const playerMeta = getPlayerMeta(state, action.playerId)
      if (playerMeta.actionPoints < skillDef.actionPointCost) {
        throw new BattleRuleError(`Not enough action points to use ${skillDef.name}`)
      }

      // 检查技能是否在冷却中
      if (piece.skills) {
        const skillState = piece.skills.find(s => s.skillId === finalSkillId)
        if (skillState && skillState.currentCooldown && skillState.currentCooldown > 0) {
          throw new BattleRuleError(
            `Skill ${finalSkillId} is on cooldown for ${skillState.currentCooldown} more turns`,
          )
        }

        // 检查限定技的使用次数
        if (skillState && skillDef.type === "ultimate" && skillState.usesRemaining <= 0) {
          throw new BattleRuleError(`Ultimate skill ${finalSkillId} has already been used`)
        }
      }

      // 检查是否有规则阻止了技能使用
      if (beforeSkillUseResult.success) {
        // 初始化actions数组
        if (!next.actions) {
          next.actions = [];
        }
        beforeSkillUseResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }
      
      // 检查是否有规则明确阻止了行动（在添加消息之后检查）
      if (beforeSkillUseResult.blocked) {
        return next; // 返回包含消息的状态，不执行技能
      }

      const cost = skillDef.chargeCost ?? 0
      // 从 next 状态获取 playerMeta，确保修改能正确保存
      const nextPlayerMeta = getPlayerMeta(next, action.playerId)
      if (cost > 0 && nextPlayerMeta.chargePoints < cost) {
        throw new BattleRuleError("Not enough charge points to use this skill")
      }

      // 消耗充能点
      if (cost > 0) {
        nextPlayerMeta.chargePoints -= cost
      }

      // 执行技能
      const skillsModule = require('./skills')
      const { executeSkillFunction } = skillsModule
      console.log('[useChargeSkill] executeSkillFunction imported: ' + typeof executeSkillFunction)
      console.log('[useChargeSkill] skillsModule keys:', Object.keys(skillsModule).join(', '))
      console.log('[useChargeSkill] executeSkillFunction toString:', executeSkillFunction.toString().substring(0, 500))
      console.log('[useChargeSkill] skillDef id: ' + skillDef.id)
      console.log('[useChargeSkill] skillDef has code: ' + !!skillDef.code)
      console.log('[useChargeSkill] About to build target info...')
      
      // 构建目标信息
      let targetInfo = null;
      let targetPositionInfo = null;
      if (action.targetPieceId) {
        const targetPiece = next.pieces.find(p => p.instanceId === action.targetPieceId);
        if (targetPiece) {
          targetInfo = {
            instanceId: targetPiece.instanceId,
            templateId: targetPiece.templateId,
            ownerPlayerId: targetPiece.ownerPlayerId,
            currentHp: targetPiece.currentHp,
            maxHp: targetPiece.maxHp,
            attack: targetPiece.attack,
            defense: targetPiece.defense,
            x: targetPiece.x || 0,
            y: targetPiece.y || 0,
          };
          // 如果选择了棋子，也将其位置作为目标位置
          targetPositionInfo = {
            x: targetPiece.x || 0,
            y: targetPiece.y || 0,
          };
        }
      } else if (action.targetX !== undefined && action.targetY !== undefined) {
        // 如果选择了格子，设置目标位置
        targetPositionInfo = {
          x: action.targetX,
          y: action.targetY,
        };
      }
      
      const context = {
        piece: piece,
        target: targetInfo,
        targetPosition: targetPositionInfo,
        selectedOption: (action as any).selectedOption,
        battle: next,
        skill: {
          id: skillDef.id,
          name: skillDef.name,
          type: skillDef.type,
          powerMultiplier: skillDef.powerMultiplier,
        },
      }

      writeLog('[useChargeSkill] Calling executeSkillFunction...')
      let result;
      try {
        result = executeSkillFunction(skillDef, context, next)
        writeLog('[useChargeSkill] executeSkillFunction result: ' + JSON.stringify({success: result.success, needsTargetSelection: result.needsTargetSelection, targetType: result.targetType}))
      } catch (err) {
        writeLog('[useChargeSkill] executeSkillFunction ERROR: ' + (err instanceof Error ? err.message : String(err)))
        throw err
      }

      // 检查是否需要目标选择
      if (result.needsTargetSelection) {
        // 创建一个包含目标选择信息的错误对象
        const targetSelectionError = new BattleRuleError('需要选择目标') as any
        targetSelectionError.needsTargetSelection = true
        targetSelectionError.targetType = result.targetType || 'piece'
        targetSelectionError.range = result.range || 5
        targetSelectionError.filter = result.filter || 'enemy'
        throw targetSelectionError
      }

      // 检查是否需要选项选择
      if (result.needsOptionSelection) {
        const optionSelectionError = new BattleRuleError('需要选择选项') as any
        optionSelectionError.needsOptionSelection = true
        optionSelectionError.options = result.options || []
        optionSelectionError.title = result.title || '请选择'
        throw optionSelectionError
      }
      
      if (result.success) {
        // 效果已经在技能执行时直接应用，这里只需要处理返回的消息

        // 消耗行动点
        const playerMeta = getPlayerMeta(next, action.playerId)
        playerMeta.actionPoints -= skillDef.actionPointCost

        // 设置技能冷却
        if (skillDef.cooldownTurns > 0 || skillDef.type === "ultimate") {
          // 找到棋子的技能状态并设置冷却
          if (piece.skills) {
            const skillIndex = piece.skills.findIndex(s => s.skillId === finalSkillId)
            if (skillIndex !== -1) {
              // 设置冷却
              if (skillDef.cooldownTurns > 0) {
                piece.skills[skillIndex].currentCooldown = skillDef.cooldownTurns
              }

              // 减少限定技使用次数
              if (skillDef.type === "ultimate") {
                piece.skills[skillIndex].usesRemaining -= 1
              }
            }
            // 注意：不在此处重新添加技能，规则系统可能已在技能执行期间移除了该技能
          } else {
            // 如果棋子没有skills属性，初始化它
            const usesRemaining = skillDef.type === "ultimate" ? 0 : -1 // 限定技使用后剩余0次，其他技能无限制
            piece.skills = [{
              skillId: finalSkillId,
              level: 1,
              currentCooldown: skillDef.cooldownTurns,
              usesRemaining: usesRemaining
            }]
          }
        }
      }

      // 初始化actions数组
      if (!next.actions) {
        next.actions = []
      }

      // 存储技能执行消息到战斗日志
      // 构建更详细的技能释放消息
      const pieceName = piece.name || piece.templateId;
      let skillMessage = `${pieceName}使用了${skillDef.name || finalSkillId}（充能技能，消耗${cost}点充能）`;
      
      // 如果有目标，添加目标信息
      if (action.targetPieceId) {
        const targetPiece = next.pieces.find(p => p.instanceId === action.targetPieceId);
        if (targetPiece) {
          const targetName = targetPiece.name || targetPiece.templateId;
          skillMessage += `，目标是${targetName}`;
        }
      } else if (action.targetX !== undefined && action.targetY !== undefined) {
        skillMessage += `，目标位置是(${action.targetX}, ${action.targetY})`;
      }
      
      // 添加技能执行结果消息
      if (result.message) {
        skillMessage += `，${result.message}`;
      }
      
      next.actions.push({
        type: "useChargeSkill",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: skillMessage,
          skillId: action.skillId,
          pieceId: action.pieceId,
          chargeCost: cost
        }
      })

      // 不再设置 hasUsedChargeSkill，允许一回合使用多个技能

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = globalTriggerSystem.checkTriggers(next, {
        type: "whenever",
        sourcePiece: piece,
        playerId: action.playerId,
        skillId: action.skillId
      });

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "endTurn": {
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("Only the current player can end the turn")
      }

      const next = safeCloneBattleState(state)

      // 触发所有回合结束效果：一次调用，checkTriggers 内部自行迭代棋子规则、玩家规则、手牌 reactive 卡牌
      // context.playerId = 当前结束回合的玩家，供暴风雪等规则判断"是否是对方回合"
      const endTurnResult = globalTriggerSystem.checkTriggers(next, {
        type: "endTurn",
        turnNumber: next.turn.turnNumber,
        playerId: action.playerId
      });

      if (endTurnResult.success && endTurnResult.messages.length > 0) {
        if (!next.actions) next.actions = [];
        endTurnResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: { message }
          });
        });
      }

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = globalTriggerSystem.checkTriggers(next, {
        type: "whenever",
        playerId: action.playerId,
        turnNumber: next.turn.turnNumber
      });

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // 在回合结束阶段的最后时刻，处理当前玩家棋子的状态效果持续时间扣除和规则移除
      next.pieces.forEach(piece => {
        // 只处理当前玩家棋子的状态效果
        if (isSamePlayer(piece.ownerPlayerId, action.playerId) && piece.statusTags) {
          // 遍历所有状态标签
          for (let i = piece.statusTags.length - 1; i >= 0; i--) {
            const statusTag = piece.statusTags[i];
            // 检查状态标签是否有持续时间属性（支持 currentDuration 和 remainingDuration）
            const currentDuration = statusTag.remainingDuration ?? statusTag.currentDuration;
            if (currentDuration !== undefined && currentDuration > 0) {
              // 减少持续时间
              const newDuration = currentDuration - 1;
              if (statusTag.remainingDuration !== undefined) {
                statusTag.remainingDuration = newDuration;
              } else {
                statusTag.currentDuration = newDuration;
              }
              // 如果持续时间为0，清除状态标签
              if (newDuration === 0) {
                
                // 检查并清理相关规则
                if (statusTag.relatedRules && statusTag.relatedRules.length > 0) {
                  statusTag.relatedRules.forEach(ruleId => {
                    // 检查是否有其他状态标签关联此规则
                    let hasOtherRelatedStatus = false;
                    
                    piece.statusTags.forEach(otherStatusTag => {
                      if (otherStatusTag !== statusTag && 
                          otherStatusTag.relatedRules && 
                          otherStatusTag.relatedRules.includes(ruleId)) {
                        hasOtherRelatedStatus = true;
                      }
                    });
                    
                    // 如果没有其他状态标签关联此规则，移除规则
                    if (!hasOtherRelatedStatus && piece.rules) {
                      const ruleIndex = piece.rules.findIndex(rule => rule.id === ruleId);
                      if (ruleIndex !== -1) {
                        piece.rules.splice(ruleIndex, 1);
                      }
                    }
                  });
                }
                
                // 从状态标签数组中移除
                piece.statusTags.splice(i, 1);
              }
            }
          }
        }
      });

      next.turn.phase = "end"
      return next
    }

    case "surrender": {
      // 投降逻辑：将投降玩家的所有棋子设置为阵亡状态
      const next = safeCloneBattleState(state)

      // 找到投降玩家的所有棋子并设置为阵亡
      next.pieces.forEach(piece => {
        if (isSamePlayer(piece.ownerPlayerId, action.playerId)) {
          piece.currentHp = 0
        }
      })
      
      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = globalTriggerSystem.checkTriggers(next, {
        type: "whenever",
        playerId: action.playerId
      });

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }
      
      return next
    }

    case "playCard": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }

      const next = safeCloneBattleState(state)
      const playerMeta = getPlayerMeta(next, action.playerId)

      // 找到手牌
      if (!playerMeta.hand) playerMeta.hand = []
      const cardIdx = playerMeta.hand.findIndex(c => c.instanceId === action.cardInstanceId)
      if (cardIdx === -1) throw new BattleRuleError("手牌中找不到该卡牌")
      const cardInstance = playerMeta.hand[cardIdx]

      // 加载卡牌定义（先查文件，再查战局自定义卡）
      const { loadCardById, executeCardFunction } = require('./skills')
      const cardDef = loadCardById(cardInstance.cardId) ?? next.customCards?.[cardInstance.cardId] ?? null
      if (!cardDef) throw new BattleRuleError(`卡牌定义找不到: ${cardInstance.cardId}`)
      if (cardDef.type !== 'active' && cardDef.type !== 'reactive') throw new BattleRuleError("该卡牌为被动卡，无法手动打出")

      // AP 消耗：优先取手牌实例上的 actionPointCost（可被运行时效果修改），fallback 到卡牌定义
      const cardApCost = (cardInstance as any).actionPointCost ?? cardDef.actionPointCost ?? 0
      if (playerMeta.actionPoints < cardApCost) {
        throw new BattleRuleError(`行动点不足，打出 ${cardDef.name} 需要 ${cardApCost} 点，当前 ${playerMeta.actionPoints} 点`)
      }

      // 触发手牌使用前规则
      const beforeCardPlayResult = globalTriggerSystem.checkTriggers(next, {
        type: "beforeCardPlay",
        playerId: action.playerId,
        cardId: cardInstance.cardId,
        cardInstanceId: cardInstance.instanceId
      });

      // 检查是否有规则阻止了卡牌使用
      if (beforeCardPlayResult.blocked) {
        if (!next.actions) next.actions = []
        beforeCardPlayResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: { message }
          });
        });
        return next;
      }

      // 构建目标信息
      let targetPiece = undefined
      let targetPosition = undefined
      if (action.targetPieceId) {
        targetPiece = next.pieces.find(p => p.instanceId === action.targetPieceId)
      }
      if (action.targetX !== undefined && action.targetY !== undefined) {
        targetPosition = { x: action.targetX, y: action.targetY }
      }

      // 执行卡牌
      const result = executeCardFunction(cardDef, action.playerId, next, undefined, targetPiece, targetPosition, action.selectedOption)

      // 处理目标选择
      if (result.needsTargetSelection) {
        const err = new BattleRuleError('需要选择目标') as any
        err.needsTargetSelection = true
        err.targetType = result.targetType || 'piece'
        err.range = result.range || 999
        err.filter = result.filter || 'all'
        throw err
      }

      // 处理选项选择
      if (result.needsOptionSelection) {
        const err = new BattleRuleError('需要选择选项') as any
        err.needsOptionSelection = true
        err.options = result.options || []
        err.title = result.title || '请选择'
        throw err
      }

      if (!result.success) {
        throw new BattleRuleError(result.message || "卡牌效果执行失败")
      }

      // 扣除行动点
      playerMeta.actionPoints -= cardApCost

      // 弃牌
      if (!playerMeta.discardPile) playerMeta.discardPile = []
      playerMeta.hand.splice(cardIdx, 1)
      playerMeta.discardPile.push(cardInstance.cardId)

      // 写入战斗日志
      if (!next.actions) next.actions = []
      next.actions.push({
        type: "playCard",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: { message: result.message || `使用了卡牌：${cardDef.name}`, cardId: cardInstance.cardId }
      })

      // 触发手牌使用后规则
      const afterCardPlayResult = globalTriggerSystem.checkTriggers(next, {
        type: "afterCardPlay",
        playerId: action.playerId,
        cardId: cardInstance.cardId,
        cardInstanceId: cardInstance.instanceId
      });

      // 处理触发效果的消息
      if (afterCardPlayResult.success && afterCardPlayResult.messages.length > 0) {
        afterCardPlayResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: { message }
          });
        });
      }

      // 触发 whenever
      globalTriggerSystem.checkTriggers(next, { type: "whenever", playerId: action.playerId })

      return next
    }

    default:
      return state
  }
}

// 召唤棋子接口
export interface SummonPieceOptions {
  templateId: string
  faction: "red" | "blue"
  ownerPlayerId: string
  x: number
  y: number
  index?: number
}

// 召唤棋子结果
export interface SummonPieceResult {
  success: boolean
  piece?: PieceInstance
  message?: string
  blocked?: boolean
}

/**
 * 召唤棋子到棋盘
 * 触发 beforePieceSummon 和 afterPieceSummon 触发器
 */
export function summonPiece(
  battle: BattleState,
  options: SummonPieceOptions,
  getPieceById: (id: string) => any,
  createPieceInstance: (template: any, ownerPlayerId: string, faction: "red" | "blue", x: number, y: number, index: number) => PieceInstance
): SummonPieceResult {
  const { templateId, faction, ownerPlayerId, x, y, index = 1 } = options

  // 获取棋子模板
  const template = getPieceById(templateId)
  if (!template) {
    return { success: false, message: `棋子模板未找到: ${templateId}` }
  }

  // 触发召唤前触发器
  const beforeSummonResult = globalTriggerSystem.checkTriggers(battle, {
    type: "beforePieceSummon",
    playerId: ownerPlayerId,
    targetPosition: { x, y },
    pieceTemplateId: templateId,
    faction
  })

  if (beforeSummonResult.blocked) {
    return { success: false, message: "召唤被阻止", blocked: true }
  }

  // 创建棋子实例
  const newPiece = createPieceInstance(template, ownerPlayerId, faction, x, y, index)

  // 将棋子添加到棋盘
  battle.pieces.push(newPiece)

  // 将棋子的规则加载到全局触发器系统
  if (template.rules && Array.isArray(template.rules)) {
    template.rules.forEach((ruleId: string) => {
      const rule = loadRuleById(ruleId)
      if (rule) {
        globalTriggerSystem.addRule(rule)
      }
    })
  }

  // 触发召唤后触发器
  const afterSummonResult = globalTriggerSystem.checkTriggers(battle, {
    type: "afterPieceSummon",
    playerId: ownerPlayerId,
    piece: newPiece,
    pieceTemplateId: templateId,
    faction
  })

  // 处理触发效果的消息
  if (afterSummonResult.success && afterSummonResult.messages.length > 0) {
    afterSummonResult.messages.forEach(message => {
      if (!battle.actions) battle.actions = []
      battle.actions.push({
        type: "triggerEffect",
        playerId: ownerPlayerId,
        turn: battle.turn.turnNumber,
        payload: { message }
      })
    })
  }

  return {
    success: true,
    piece: newPiece,
    message: `${newPiece.name} 被召唤到 (${x}, ${y})`
  }
}

