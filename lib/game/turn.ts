import type { BoardMap } from "./map"
import type { PieceInstance, PieceStats } from "./piece"
import type { SkillDefinition } from "./skills"
import { globalTriggerSystem } from "./triggers"
import { statusEffectSystem, StatusEffectType } from "./status-effects"

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
  /** 按棋子模板 ID 存储基础数值，供移动范围等逻辑使用 */
  pieceStatsByTemplateId: Record<string, PieceStats>
  /** 技能静态定义 */
  skillsById: Record<string, SkillDefinition>
  /** 两个玩家的资源状态（充能点等） */
  players: PlayerTurnMeta[]
  turn: TurnState
  /** 战斗日志 */
  actions?: BattleActionLog[]
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
  switch (action.type) {
    case "beginPhase": {
      const next = structuredClone(state) as BattleState
      if (next.turn.phase === "start") {
        // 触发回合开始效果
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

        // 更新所有棋子技能的冷却时间
        next.pieces.forEach(piece => {
          if (piece.skills) {
            piece.skills.forEach(skill => {
              if (skill.currentCooldown && skill.currentCooldown > 0) {
                skill.currentCooldown--
                console.log(`Reduced cooldown for skill ${skill.skillId} on piece ${piece.instanceId}: ${skill.currentCooldown} turns remaining`)
              }
            })
          }
        })

        // 更新所有状态效果
        statusEffectSystem.setBattleState(next);
        statusEffectSystem.updateStatusEffects()

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
          console.log(`Player ${nextPlayerMeta.playerId} now has ${nextPlayerMeta.actionPoints}/${nextPlayerMeta.maxActionPoints} action points (turn ${next.turn.turnNumber})`)
        }
        
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
        
        return next
      }
      return next
    }

    case "grantChargePoints": {
      const next = structuredClone(state) as BattleState
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
      
      // 消耗行动点
      const playerMeta = getPlayerMeta(next, action.playerId)
      playerMeta.actionPoints -= 1

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

      console.log('Executing skill with ID:', action.skillId)
      console.log('Available skills:', Object.keys(next.skillsById))
      
      let skillDef = next.skillsById[action.skillId]
      
      // 如果技能定义找不到，使用默认技能定义
      if (!skillDef) {
        console.warn(`Skill definition not found for ID: ${action.skillId}, using default skill`)
        skillDef = {
          id: action.skillId,
          name: action.skillId,
          description: "Default skill",
          kind: "active",
          type: "normal",
          cooldownTurns: 0,
          maxCharges: 0,
          powerMultiplier: 1,
          code: "function executeSkill(context) { return { message: 'Skill executed', success: true } }",
          range: "self",
          requiresTarget: false,
          actionPointCost: 1
        }
      }
      
      // 检查行动点是否足够
      const playerMeta = getPlayerMeta(state, action.playerId)
      if (playerMeta.actionPoints < skillDef.actionPointCost) {
        throw new BattleRuleError(`Not enough action points to use ${skillDef.name}`)
      }

      // 检查技能是否在冷却中
      if (piece.skills) {
        const skillState = piece.skills.find(s => s.skillId === action.skillId)
        if (skillState && skillState.currentCooldown && skillState.currentCooldown > 0) {
          throw new BattleRuleError(
            `Skill ${action.skillId} is on cooldown for ${skillState.currentCooldown} more turns`,
          )
        }
        
        // 检查限定技的使用次数
        if (skillState && skillDef.type === "ultimate" && skillState.usesRemaining <= 0) {
          throw new BattleRuleError(`Ultimate skill ${action.skillId} has already been used`)
        }
      }
      
      console.log('Skill definition used:', skillDef)

      // 执行技能
      const { executeSkillFunction, applySkillEffects } = require('./skills')
      
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
        target: targetInfo,
        targetPosition: targetPositionInfo,
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
      if (result.success) {
        // 效果已经在技能执行时直接应用，这里只需要处理返回的消息
        console.log('Skill executed:', result.message)
        
        // 检查技能执行后棋子的属性是否被正确修改
        const updatedPiece = next.pieces.find(p => p.instanceId === piece.instanceId)
        console.log('Updated piece after skill:', updatedPiece);
        
        // 消耗行动点
        const playerMeta = getPlayerMeta(next, action.playerId)
        playerMeta.actionPoints -= skillDef.actionPointCost
        
        // 设置技能冷却
        if (skillDef.cooldownTurns > 0 || skillDef.type === "ultimate") {
          // 找到棋子的技能状态并设置冷却
          if (piece.skills) {
            const skillIndex = piece.skills.findIndex(s => s.skillId === action.skillId)
            if (skillIndex !== -1) {
              // 设置冷却
              if (skillDef.cooldownTurns > 0) {
                piece.skills[skillIndex].currentCooldown = skillDef.cooldownTurns
                console.log(`Set cooldown for skill ${action.skillId}: ${skillDef.cooldownTurns} turns`)
              }
              
              // 减少限定技使用次数
              if (skillDef.type === "ultimate") {
                piece.skills[skillIndex].usesRemaining -= 1
                console.log(`Used ultimate skill ${action.skillId}, ${piece.skills[skillIndex].usesRemaining} uses remaining`)
              }
            } else {
              // 如果技能不在棋子的技能列表中，添加它
              const usesRemaining = skillDef.type === "ultimate" ? 0 : -1 // 限定技使用后剩余0次，其他技能无限制
              piece.skills.push({ 
                skillId: action.skillId, 
                level: 1, 
                currentCooldown: skillDef.cooldownTurns, 
                usesRemaining: usesRemaining
              })
              console.log(`Added skill ${action.skillId} to piece with cooldown: ${skillDef.cooldownTurns} turns, uses remaining: ${usesRemaining}`)
            }
          } else {
            // 如果棋子没有skills属性，初始化它
            const usesRemaining = skillDef.type === "ultimate" ? 0 : -1 // 限定技使用后剩余0次，其他技能无限制
            piece.skills = [{ 
              skillId: action.skillId, 
              level: 1, 
              currentCooldown: skillDef.cooldownTurns,
              usesRemaining: usesRemaining
            }]
            console.log(`Initialized skills for piece and added cooldown for ${action.skillId}: ${skillDef.cooldownTurns} turns, uses remaining: ${usesRemaining}`)
          }
        }
      }

      // 处理传送技能的目标位置（作为备用机制）
      if (skillDef.id === "teleport" && action.targetX !== undefined && action.targetY !== undefined) {
        // 检查目标位置是否有效
        const targetTile = next.map.tiles.find(t => t.x === action.targetX && t.y === action.targetY)
        if (targetTile && targetTile.props.walkable) {
          // 检查目标位置是否被占用
          const isOccupied = next.pieces.some(p => p.x === action.targetX && p.y === action.targetY && p.currentHp > 0)
          if (!isOccupied) {
            // 计算曼哈顿距离，使用技能配置中的 areaSize 作为传送范围
            const distance = Math.abs(action.targetX - (piece.x || 0)) + Math.abs(action.targetY - (piece.y || 0))
            const teleportRange = skillDef.areaSize || 5 // 默认5格范围
            if (distance <= teleportRange) {
              piece.x = action.targetX
              piece.y = action.targetY
            }
          }
        }
      }

      // 初始化actions数组
      if (!next.actions) {
        next.actions = []
      }

      // 存储技能执行消息到战斗日志
      next.actions.push({
        type: "useBasicSkill",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: result.message || "使用了普通技能",
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

      console.log('Executing skill with ID:', action.skillId)
      console.log('Available skills:', Object.keys(next.skillsById))
      
      let skillDef = next.skillsById[action.skillId]
      
      // 如果技能定义找不到，使用默认技能定义
      if (!skillDef) {
        console.warn(`Skill definition not found for ID: ${action.skillId}, using default skill`)
        skillDef = {
          id: action.skillId,
          name: action.skillId,
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
        const skillState = piece.skills.find(s => s.skillId === action.skillId)
        if (skillState && skillState.currentCooldown && skillState.currentCooldown > 0) {
          throw new BattleRuleError(
            `Skill ${action.skillId} is on cooldown for ${skillState.currentCooldown} more turns`,
          )
        }
        
        // 检查限定技的使用次数
        if (skillState && skillDef.type === "ultimate" && skillState.usesRemaining <= 0) {
          throw new BattleRuleError(`Ultimate skill ${action.skillId} has already been used`)
        }
      }
      
      console.log('Skill definition used:', skillDef)

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
        target: targetInfo,
        targetPosition: targetPositionInfo,
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
      
      // 检查是否需要目标选择
      if (result.needsTargetSelection) {
        // 抛出一个特殊的错误，指示需要目标选择
        const error = new Error(result.message) as any
        error.needsTargetSelection = true
        error.targetType = result.targetType
        error.range = result.range
        error.filter = result.filter
        throw error
      }
      
      if (result.success) {
        // 效果已经在技能执行时直接应用，这里只需要处理返回的消息
        console.log('Skill executed:', result.message)
        
        // 消耗行动点
        const playerMeta = getPlayerMeta(next, action.playerId)
        playerMeta.actionPoints -= skillDef.actionPointCost
        
        // 设置技能冷却
        if (skillDef.cooldownTurns > 0 || skillDef.type === "ultimate") {
          // 找到棋子的技能状态并设置冷却
          if (piece.skills) {
            const skillIndex = piece.skills.findIndex(s => s.skillId === action.skillId)
            if (skillIndex !== -1) {
              // 设置冷却
              if (skillDef.cooldownTurns > 0) {
                piece.skills[skillIndex].currentCooldown = skillDef.cooldownTurns
                console.log(`Set cooldown for skill ${action.skillId}: ${skillDef.cooldownTurns} turns`)
              }
              
              // 减少限定技使用次数
              if (skillDef.type === "ultimate") {
                piece.skills[skillIndex].usesRemaining -= 1
                console.log(`Used ultimate skill ${action.skillId}, ${piece.skills[skillIndex].usesRemaining} uses remaining`)
              }
            } else {
              // 如果技能不在棋子的技能列表中，添加它
              const usesRemaining = skillDef.type === "ultimate" ? 0 : -1 // 限定技使用后剩余0次，其他技能无限制
              piece.skills.push({ 
                skillId: action.skillId, 
                level: 1, 
                currentCooldown: skillDef.cooldownTurns, 
                usesRemaining: usesRemaining
              })
              console.log(`Added skill ${action.skillId} to piece with cooldown: ${skillDef.cooldownTurns} turns, uses remaining: ${usesRemaining}`)
            }
          } else {
            // 如果棋子没有skills属性，初始化它
            const usesRemaining = skillDef.type === "ultimate" ? 0 : -1 // 限定技使用后剩余0次，其他技能无限制
            piece.skills = [{ 
              skillId: action.skillId, 
              level: 1, 
              currentCooldown: skillDef.cooldownTurns,
              usesRemaining: usesRemaining
            }]
            console.log(`Initialized skills for piece and added cooldown for ${action.skillId}: ${skillDef.cooldownTurns} turns, uses remaining: ${usesRemaining}`)
          }
        }
      }

      // 初始化actions数组
      if (!next.actions) {
        next.actions = []
      }

      // 存储技能执行消息到战斗日志
      next.actions.push({
        type: "useChargeSkill",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: result.message || "使用了充能技能",
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

      const next = structuredClone(state) as BattleState
      // 触发回合结束效果
      const endTurnResult = globalTriggerSystem.checkTriggers(next, {
        type: "endTurn",
        turnNumber: next.turn.turnNumber,
        playerId: action.playerId
      });

      // 处理触发效果的消息
      if (endTurnResult.success && endTurnResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        endTurnResult.messages.forEach(message => {
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

    default:
      return state
  }
}

