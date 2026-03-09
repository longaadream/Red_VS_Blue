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
  | "gameStart"             // 战斗开始时（只触发一次，用于初始发牌等效果）

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

// 触发上下文 - 所有字段都可以通过引用被触发器修改
export interface TriggerContext {
  type: TriggerType
  /** 源棋子，可以被修改（如改变位置、属性等） */
  sourcePiece?: PieceInstance
  /** 目标棋子，可以被修改或替换 */
  targetPiece?: PieceInstance
  /** 技能ID，可以被修改以改变即将使用的技能 */
  skillId?: string
  /** 伤害值，可以在 beforeDamageDealt/beforeDamageTaken 中被修改 */
  damage?: number
  /** 治疗值，可以在 beforeHealDealt/beforeHealTaken 中被修改 */
  heal?: number
  /** 回合数 */
  turnNumber?: number
  /** 玩家ID */
  playerId?: string
  /** 数量（用于充能获得量、状态层数等数值事件），可以被修改 */
  amount?: number
  /** 状态 ID（用于 afterStatusApplied / afterStatusRemoved 事件） */
  statusId?: string
  /** 目标位置X坐标，可以在 beforeMove/beforePieceSummoned 中被修改 */
  targetX?: number
  /** 目标位置Y坐标，可以在 beforeMove/beforePieceSummoned 中被修改 */
  targetY?: number
  /** 伤害类型，可以在 beforeDamageDealt 中被修改 */
  damageType?: 'physical' | 'magical' | 'true' | 'toxin'
  /** 
   * 当前执行规则的棋子（规则绑定者）
   * 在全场扫描规则时，这个字段表示当前正在执行哪个棋子的规则
   * 用于区分事件源(sourcePiece)和规则拥有者
   */
  rulePiece?: PieceInstance
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

    // 2. 检查所有棋子实例的规则（对所有触发类型都扫描全部棋子）
    // 这样"移动后"、"技能使用后"等事件可以触发任意棋子上绑定的规则，而不仅限于事件发起者
    if (battle.pieces) {
      for (const piece of battle.pieces) {
        if (!piece.rules || piece.rules.length === 0) continue

        const pieceMatchingRules = piece.rules.filter((rule: any) => {
          if (!rule || !rule.trigger) return false
          if (rule.trigger.type !== context.type) return false
          const limits = rule.limits
          if (limits) {
            if (limits.currentCooldown && limits.currentCooldown > 0) return false
            if (limits.maxUses && (limits.uses || 0) >= limits.maxUses) return false
          }
          return true
        })

        for (const rule of pieceMatchingRules) {
          // 检查是否是默认函数（只返回 "xxx触发" 消息，尚未加载真实逻辑）
          const isDefaultEffect = typeof rule.effect === 'function' &&
            rule.effect.toString().includes('ruleData.name') &&
            rule.effect.toString().includes('触发') &&
            !rule.effect.toString().includes('checkToxin')

          if (typeof rule.effect !== 'function' || isDefaultEffect) {
            try {
              const { loadRuleById } = require('./skills')
              const reloadedRule = loadRuleById(rule.id, true)
              if (reloadedRule && typeof reloadedRule.effect === 'function') {
                rule.effect = reloadedRule.effect
              } else {
                continue
              }
            } catch {
              continue
            }
          }

          try {
            // 设置当前执行规则的棋子，让技能代码知道是哪个棋子的规则正在执行
            context.rulePiece = piece
            const result = rule.effect(battle, context)
            if (result.success) {
              success = true
              if (result.message) {
                triggeredEffects.push(result.message)
              }
              if (result.blocked) {
                blocked = true
              }
              if (rule.limits) {
                if (rule.limits.uses !== undefined) {
                  rule.limits.uses++
                } else {
                  rule.limits.uses = 1
                }
                if (rule.limits.cooldownTurns) {
                  rule.limits.currentCooldown = rule.limits.cooldownTurns
                }
              }
            }
          } catch (error) {
            console.error(`Error executing rule ${rule.id} on piece ${piece.instanceId}:`, error)
          }
        }
      }
    }

    // 3. 检查所有玩家的玩家级别规则（player.rules[]）
    if (battle.players) {
      for (const player of battle.players) {
        if (!(player as any).rules || (player as any).rules.length === 0) continue

        const playerMatchingRules = ((player as any).rules as any[]).filter((rule: any) => {
          if (!rule || !rule.trigger) return false
          if (rule.trigger.type !== context.type) return false
          const limits = rule.limits
          if (limits) {
            if (limits.currentCooldown && limits.currentCooldown > 0) return false
            if (limits.maxUses && (limits.uses || 0) >= limits.maxUses) return false
          }
          return true
        })

        for (const rule of playerMatchingRules) {
          // 如果 effect 是存根函数，重新加载
          const isDefaultEffect = typeof rule.effect === 'function' &&
            rule.effect.toString().includes('ruleData.name') &&
            rule.effect.toString().includes('触发') &&
            !rule.effect.toString().includes('checkToxin')

          if (typeof rule.effect !== 'function' || isDefaultEffect) {
            try {
              const { loadRuleById } = require('./skills')
              const reloadedRule = loadRuleById(rule.id, true)
              if (reloadedRule && typeof reloadedRule.effect === 'function') {
                rule.effect = reloadedRule.effect
              } else {
                continue
              }
            } catch {
              continue
            }
          }

          try {
            // 把玩家的 playerId 注入到 context，供 triggerSkill 技能读取
            const playerContext = { ...context, playerId: player.playerId }
            const result = rule.effect(battle, playerContext)
            if (result.success) {
              success = true
              if (result.message) triggeredEffects.push(result.message)
              if (result.blocked) blocked = true
              // 检查是否修改了伤害值
              if (rule.limits) {
                rule.limits.uses = (rule.limits.uses || 0) + 1
                if (rule.limits.cooldownTurns) rule.limits.currentCooldown = rule.limits.cooldownTurns
              }
            }
          } catch (error) {
            console.error(`Error executing player rule ${rule.id} for player ${player.playerId}:`, error)
          }
        }
      }
    }

    // 4. 检查所有玩家手牌中的 reactive 卡牌（全场两个玩家都扫描）
    if (battle.players) {
      for (const player of battle.players) {
        if (!player.hand || player.hand.length === 0) continue
        // 从后往前遍历，因为触发后可能弃牌（会 splice）
        for (let i = player.hand.length - 1; i >= 0; i--) {
          const cardInstance = player.hand[i]
          try {
            const { loadCardById, executeCardFunction } = require('./skills')
            const cardDef = loadCardById(cardInstance.cardId)
            if (!cardDef || cardDef.type !== 'reactive') continue
            if (!cardDef.trigger || cardDef.trigger.type !== context.type) continue

            const result = executeCardFunction(cardDef, player.playerId, battle, context)
            if (result && result.success) {
              success = true
              if (result.message) triggeredEffects.push(result.message)
              if (result.blocked) blocked = true
              // 弃牌
              if (!player.discardPile) player.discardPile = []
              player.hand.splice(i, 1)
              player.discardPile.push(cardInstance.cardId)
            }
          } catch (error) {
            console.error(`Error executing reactive card ${cardInstance.cardId}:`, error)
          }
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
