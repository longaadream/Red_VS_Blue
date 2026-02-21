import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"

// 触发类型
export type TriggerType =
  | "afterSkillUsed"       // 技能使用后
  | "afterDamageDealt"      // 造成伤害后
  | "afterDamageTaken"      // 受到伤害后
  | "afterPieceKilled"      // 击杀棋子后
  | "beforePieceKilled"     // 即将击杀棋子前
  | "afterPieceSummoned"    // 召唤棋子后
  | "beforePieceSummoned"   // 即将召唤棋子前
  | "beginTurn"             // 回合开始时
  | "endTurn"               // 回合结束时
  | "afterMove"             // 移动后
  | "beforeMove"            // 即将移动前
  | "beforeSkillUse"        // 即将使用技能前
  | "beforeAttack"          // 即将攻击前
  | "whenever"              // 每一步行动后检测

// 条件类型
export type ConditionType =
  | "skillId"        // 特定技能
  | "minDamage"      // 最小伤害
  | "maxDamage"      // 最大伤害
  | "pieceType"      // 棋子类型
  | "faction"        // 阵营
  | "minAttack"      // 最小攻击力
  | "maxAttack"      // 最大攻击力
  | "minHp"          // 最小生命值
  | "maxHp"          // 最大生命值
  | "minDefense"     // 最小防御力
  | "maxDefense"     // 最大防御力
  | "pieceCount"     // 棋子数量
  | "turnNumber"     // 回合数
  | "phase"          // 回合阶段
  | "positionX"      // X位置
  | "positionY"      // Y位置
  | "distance"       // 距离

// 逻辑运算符
export type LogicalOperator = "AND" | "OR" | "NOT"

// 单个条件
export interface SingleCondition {
  type: ConditionType
  value: any
  target?: "source" | "target" | "all" // 条件应用的目标
}

// 复合条件
export interface CompoundCondition {
  operator: LogicalOperator
  conditions: (SingleCondition | CompoundCondition)[]
}

// 触发条件
export interface TriggerCondition {
  type: TriggerType
  // 可选的额外条件（支持单个条件对象或复合条件）
  conditions?: SingleCondition | CompoundCondition | {
    skillId?: string        // 特定技能
    minDamage?: number      // 最小伤害
    maxDamage?: number      // 最大伤害
    minAttack?: number      // 最小攻击力
    maxAttack?: number      // 最大攻击力
    minHp?: number          // 最小生命值
    maxHp?: number          // 最大生命值
    minDefense?: number     // 最小防御力
    maxDefense?: number     // 最大防御力
    pieceType?: string      // 棋子类型
    faction?: string        // 阵营
    pieceCount?: number     // 棋子数量
    turnNumber?: number     // 回合数
    phase?: string          // 回合阶段
    positionX?: number      // X位置
    positionY?: number      // Y位置
    distance?: number       // 距离
  }
}

// 效果执行函数类型
export type EffectFunction = (
  battle: BattleState,
  context: any
) => { success: boolean; message?: string }

// 触发-效果规则
export interface TriggerRule {
  id: string
  name: string
  description: string
  trigger: TriggerCondition
  effect: EffectFunction
  // 可选的限制条件
  limits?: {
    maxUses?: number        // 最大使用次数
    cooldownTurns?: number  // 冷却回合
    currentCooldown?: number // 当前冷却
    uses?: number           // 当前使用次数
    duration?: number       // 持续回合数
    remainingDuration?: number // 剩余持续回合数
  }
}

// 触发上下文
export interface TriggerContext {
  type: TriggerType
  sourcePiece?: PieceInstance
  targetPiece?: PieceInstance
  skillId?: string
  damage?: number
  turnNumber?: number
  playerId?: string
}

// 触发系统类
export class TriggerSystem {
  private rules: TriggerRule[] = []

  // 构造函数
  constructor() {
    // 初始化为空，不自动加载所有规则
  }

  // 加载指定的规则
  loadSpecificRules(ruleIds: string[]): void {
    try {
      // 清空现有规则
      this.clearRules()
      console.log(`Loaded 0 specific rules:`, ruleIds)
    } catch (error) {
      console.error('Error loading specific rules:', error)
    }
  }

  // 添加规则
  addRule(rule: TriggerRule): void {
    this.rules.push(rule)
  }

  // 添加多条规则
  addRules(rules: TriggerRule[]): void {
    this.rules.push(...rules)
  }

  // 移除规则
  removeRule(ruleId: string): void {
    this.rules = this.rules.filter(rule => rule.id !== ruleId)
  }

  // 清空规则
  clearRules(): void {
    this.rules = []
  }

  // 获取所有规则
  getRules(): TriggerRule[] {
    return this.rules
  }



  // 检查并触发规则
  checkTriggers(battle: BattleState, context: TriggerContext): { success: boolean; messages: string[] } {
    const triggeredEffects: string[] = []
    let success = false

    // 过滤出符合触发条件的规则
    const matchingRules = this.rules.filter(rule => {
      // 检查触发类型是否匹配
      if (rule.trigger.type !== context.type) {
        return false
      }

      // 检查额外条件
      const conditions = rule.trigger.conditions
      if (conditions) {
        if (!this.evaluateCondition(conditions, battle, context)) {
          return false
        }
      }

      // 检查限制条件
      const limits = rule.limits
      if (limits) {
        // 检查冷却
        if (limits.currentCooldown && limits.currentCooldown > 0) {
          return false
        }

        // 检查使用次数
        if (limits.maxUses && (limits.uses || 0) >= limits.maxUses) {
          return false
        }
      }

      return true
    })

    // 执行匹配的规则
    for (const rule of matchingRules) {
      const result = rule.effect(battle, context)
      if (result.success) {
        success = true
        if (result.message) {
          triggeredEffects.push(result.message)
        }

        // 更新规则的限制状态
        if (rule.limits) {
          // 增加使用次数
          if (rule.limits.uses !== undefined) {
            rule.limits.uses++
          } else {
            rule.limits.uses = 1
          }

          // 设置冷却
          if (rule.limits.cooldownTurns) {
            rule.limits.currentCooldown = rule.limits.cooldownTurns
          }
        }
      }
    }

    return { success, messages: triggeredEffects }
  }

  // 评估条件
  private evaluateCondition(condition: any, battle: BattleState, context: TriggerContext): boolean {
    // 处理复合条件
    if (condition.operator && condition.conditions) {
      return this.evaluateCompoundCondition(condition, battle, context)
    }

    // 处理单个条件对象
    if (condition.type) {
      return this.evaluateSingleCondition(condition, battle, context)
    }

    // 处理旧格式的条件对象
    return this.evaluateOldFormatCondition(condition, battle, context)
  }

  // 评估复合条件
  private evaluateCompoundCondition(condition: CompoundCondition, battle: BattleState, context: TriggerContext): boolean {
    const { operator, conditions } = condition

    switch (operator) {
      case "AND":
        return conditions.every(subCondition => 
          this.evaluateCondition(subCondition, battle, context)
        )
      case "OR":
        return conditions.some(subCondition => 
          this.evaluateCondition(subCondition, battle, context)
        )
      case "NOT":
        return !conditions.every(subCondition => 
          this.evaluateCondition(subCondition, battle, context)
        )
      default:
        return false
    }
  }

  // 评估单个条件
  private evaluateSingleCondition(condition: SingleCondition, battle: BattleState, context: TriggerContext): boolean {
    const { type, value, target = "all" } = condition

    switch (type) {
      case "skillId":
        return context.skillId === value
      
      case "minDamage":
        return context.damage !== undefined && context.damage >= value
      
      case "maxDamage":
        return context.damage !== undefined && context.damage <= value
      
      case "pieceType":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.templateId === value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.templateId === value) {
            return true
          }
        }
        return false
      
      case "faction":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.faction === value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.faction === value) {
            return true
          }
        }
        return false
      
      case "minAttack":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.attack >= value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.attack >= value) {
            return true
          }
        }
        return false
      
      case "maxAttack":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.attack <= value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.attack <= value) {
            return true
          }
        }
        return false
      
      case "minHp":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.currentHp >= value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.currentHp >= value) {
            return true
          }
        }
        return false
      
      case "maxHp":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.currentHp <= value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.currentHp <= value) {
            return true
          }
        }
        return false
      
      case "minDefense":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.defense >= value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.defense >= value) {
            return true
          }
        }
        return false
      
      case "maxDefense":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.defense <= value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.defense <= value) {
            return true
          }
        }
        return false
      
      case "pieceCount":
        const pieceCount = battle.pieces.filter(p => p.currentHp > 0).length
        return pieceCount === value
      
      case "turnNumber":
        return context.turnNumber === value
      
      case "phase":
        return battle.turn.phase === value
      
      case "positionX":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.x === value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.x === value) {
            return true
          }
        }
        return false
      
      case "positionY":
        if (target === "source" || target === "all") {
          if (context.sourcePiece && context.sourcePiece.y === value) {
            return true
          }
        }
        if (target === "target" || target === "all") {
          if (context.targetPiece && context.targetPiece.y === value) {
            return true
          }
        }
        return false
      
      case "distance":
        if (context.sourcePiece && context.targetPiece) {
          const distance = Math.abs(context.sourcePiece.x - context.targetPiece.x) + 
                          Math.abs(context.sourcePiece.y - context.targetPiece.y)
          return distance === value
        }
        return false
      
      default:
        return false
    }
  }

  // 评估旧格式的条件对象
  private evaluateOldFormatCondition(condition: any, battle: BattleState, context: TriggerContext): boolean {
    // 检查技能ID
    if (condition.skillId && context.skillId !== condition.skillId) {
      return false
    }

    // 检查伤害范围
    if (context.damage !== undefined) {
      if (condition.minDamage !== undefined && context.damage < condition.minDamage) {
        return false
      }
      if (condition.maxDamage !== undefined && context.damage > condition.maxDamage) {
        return false
      }
    }

    // 检查棋子类型
    if (condition.pieceType) {
      if (context.sourcePiece && context.sourcePiece.templateId !== condition.pieceType) {
        return false
      }
      if (context.targetPiece && context.targetPiece.templateId !== condition.pieceType) {
        return false
      }
    }

    // 检查阵营
    if (condition.faction) {
      if (context.sourcePiece && context.sourcePiece.faction !== condition.faction) {
        return false
      }
      if (context.targetPiece && context.targetPiece.faction !== condition.faction) {
        return false
      }
    }

    // 检查攻击力范围
    if (context.sourcePiece) {
      if (condition.minAttack !== undefined && context.sourcePiece.attack < condition.minAttack) {
        return false
      }
      if (condition.maxAttack !== undefined && context.sourcePiece.attack > condition.maxAttack) {
        return false
      }
    }

    // 检查生命值范围
    if (context.sourcePiece) {
      if (condition.minHp !== undefined && context.sourcePiece.currentHp < condition.minHp) {
        return false
      }
      if (condition.maxHp !== undefined && context.sourcePiece.currentHp > condition.maxHp) {
        return false
      }
    }

    // 检查防御力范围
    if (context.sourcePiece) {
      if (condition.minDefense !== undefined && context.sourcePiece.defense < condition.minDefense) {
        return false
      }
      if (condition.maxDefense !== undefined && context.sourcePiece.defense > condition.maxDefense) {
        return false
      }
    }

    // 检查棋子数量
    if (condition.pieceCount !== undefined) {
      const pieceCount = battle.pieces.filter(p => p.currentHp > 0).length
      if (pieceCount !== condition.pieceCount) {
        return false
      }
    }

    // 检查回合数
    if (condition.turnNumber !== undefined && context.turnNumber !== condition.turnNumber) {
      return false
    }

    // 检查回合阶段
    if (condition.phase !== undefined && battle.turn.phase !== condition.phase) {
      return false
    }

    // 检查位置
    if (context.sourcePiece) {
      if (condition.positionX !== undefined && context.sourcePiece.x !== condition.positionX) {
        return false
      }
      if (condition.positionY !== undefined && context.sourcePiece.y !== condition.positionY) {
        return false
      }
    }

    // 检查距离
    if (condition.distance !== undefined && context.sourcePiece && context.targetPiece) {
      const distance = Math.abs(context.sourcePiece.x - context.targetPiece.x) + 
                      Math.abs(context.sourcePiece.y - context.targetPiece.y)
      if (distance !== condition.distance) {
        return false
      }
    }

    return true
  }

  // 更新冷却
  updateCooldowns(): void {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i];
      if (rule.limits) {
        // 处理冷却
        if (rule.limits.currentCooldown && rule.limits.currentCooldown > 0) {
          rule.limits.currentCooldown--;
        }
        
        // 处理持续时间
        if (rule.limits.duration !== undefined) {
          // 初始化剩余持续时间
          if (rule.limits.remainingDuration === undefined) {
            rule.limits.remainingDuration = rule.limits.duration;
          }
          
          // 减少持续时间
          rule.limits.remainingDuration--;
          
          // 如果持续时间结束，移除规则
          if (rule.limits.remainingDuration <= 0) {
            this.rules.splice(i, 1);
            console.log(`Rule ${rule.id} (${rule.name}) expired and was removed`);
          }
        }
      }
    }
  }
  
  
}

// 全局触发系统实例
export const globalTriggerSystem = new TriggerSystem()
