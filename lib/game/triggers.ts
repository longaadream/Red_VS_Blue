import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"

// 触发类型
export type TriggerType =
  | "afterSkillUsed"       // 技能使用后
  | "afterDamageDealt"      // 造成伤害后
  | "afterDamageTaken"      // 受到伤害后
  | "beforeDamageDealt"     // 即将造成伤害前
  | "beforeDamageTaken"     // 即将受到伤害前
  | "afterPieceKilled"      // 击杀棋子后
  | "beforePieceKilled"     // 即将击杀棋子前
  | "afterPieceSummoned"    // 召唤棋子后
  | "beforePieceSummoned"   // 即将召唤棋子前
  | "beginTurn"             // 回合开始时
  | "endTurn"               // 回合结束时
  | "afterMove"             // 移动后
  | "beforeMove"            // 即将移动前
  | "beforeSkillUse"        // 即将使用技能前
  | "afterHealDealt"        // 造成治疗后
  | "afterHealTaken"        // 受到治疗后
  | "beforeHealDealt"       // 即将造成治疗前
  | "beforeHealTaken"       // 即将受到治疗前
  | "whenever"              // 每一步行动后检测
  | "onPieceDied"           // 棋子死亡时（死亡者自身视角，可用于"我死亡时做X"效果）
  | "afterStatusApplied"    // 状态效果被施加到棋子后
  | "afterStatusRemoved"    // 状态效果从棋子移除后
  | "afterChargeGained"     // 充能点获得后
  | "afterDamageBlocked"    // 伤害被规则/护盾格挡后（如圣盾）
  | "afterHealBlocked"      // 治疗被规则格挡后

// 条件类型定义已移除，所有条件判断都在技能代码中通过if语句实现

// 触发条件
export interface TriggerCondition {
  type: TriggerType
  // 移除额外条件，所有条件判断都在技能代码中通过if语句实现
}

// 效果执行函数类型
export type EffectFunction = (
  battle: BattleState,
  context: any
) => { success: boolean; message?: string; blocked?: boolean }

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
  heal?: number
  turnNumber?: number
  playerId?: string
  /** 数量（用于充能获得量、状态层数等数值事件） */
  amount?: number
  /** 状态 ID（用于 afterStatusApplied / afterStatusRemoved 事件） */
  statusId?: string
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
  checkTriggers(battle: BattleState, context: TriggerContext): { success: boolean; messages: string[]; blocked: boolean } {
    const triggeredEffects: string[] = []
    let success = false
    let blocked = false

    // 1. 检查全局规则
    const globalMatchingRules = this.rules.filter(rule => {
      // 只检查触发类型是否匹配
      if (rule.trigger.type !== context.type) {
        return false
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

    // 执行全局匹配的规则
    for (const rule of globalMatchingRules) {
      // 检查规则对象是否有效
      if (!rule || typeof rule.effect !== 'function') {
        console.warn(`Skipping invalid global rule: rule or rule.effect is not a function`, rule?.id)
        continue
      }
      
      try {
        const result = rule.effect(battle, context)
        if (result.success) {
          success = true
          if (result.message) {
            triggeredEffects.push(result.message)
          }
          // 检查是否阻止行动
          if (result.blocked) {
            blocked = true
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
      } catch (error) {
        console.error(`Error executing global rule ${rule.id}:`, error)
      }
    }

    // 2. 检查棋子实例的规则
    if (context.sourcePiece && context.sourcePiece.rules) {
      const pieceMatchingRules = context.sourcePiece.rules.filter((rule: any) => {
        // 检查规则对象是否有效
        if (!rule || !rule.trigger) {
          console.warn(`Skipping invalid rule on piece ${context.sourcePiece?.instanceId}: rule or rule.trigger is undefined`)
          return false
        }
        
        // 只检查触发类型是否匹配
        if (rule.trigger.type !== context.type) {
          return false
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

      // 执行棋子匹配的规则
      for (const rule of pieceMatchingRules) {
        if (typeof rule.effect !== 'function') {
          console.warn(`Skipping rule ${rule.id}: effect is not a function (may have been lost during JSON serialization)`)
          continue
        }
        
        try {
          const result = rule.effect(battle, context)
          if (result.success) {
            success = true
            if (result.message) {
              triggeredEffects.push(result.message)
            }
            // 检查是否阻止行动
            if (result.blocked) {
              blocked = true
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
        } catch (error) {
          console.error(`Error executing piece rule ${rule.id}:`, error)
        }
      }
    }

    return { success, messages: triggeredEffects, blocked }
  }

  // 条件评估方法已移除，所有条件判断都在技能代码中通过if语句实现

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
