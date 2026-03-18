import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"

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
  | "beforeCardPlay"        // 手牌使用前
  | "afterCardPlay"         // 手牌使用后
  | "beforeCardAdded"       // 手牌加入手里前
  | "afterCardAdded"        // 手牌加入手里后

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
  loadSpecificRules(ruleIds: string[], forceReload: boolean = false): void {
    try {
      // 清空现有规则
      this.clearRules()
      
      writeLog('[loadSpecificRules] Loading rules: ' + JSON.stringify(ruleIds) + ', forceReload: ' + forceReload)
      
      // 加载指定的规则
      const { loadRuleById } = require('./skills')
      for (const ruleId of ruleIds) {
        const rule = loadRuleById(ruleId, forceReload)
        if (rule) {
          this.addRule(rule)
          writeLog('[loadSpecificRules] Loaded rule: ' + ruleId)
        } else {
          writeLog('[loadSpecificRules] Failed to load rule: ' + ruleId)
        }
      }
      
      writeLog('[loadSpecificRules] Loaded ' + this.rules.length + ' specific rules: ' + JSON.stringify(ruleIds))
    } catch (error) {
      writeLog('Error loading specific rules: ' + error)
    }
  }

  // 添加规则
  addRule(rule: TriggerRule): void {
    // 检查规则是否已经存在，避免重复添加
    const exists = this.rules.some(r => r.id === rule.id)
    if (!exists) {
      this.rules.push(rule)
    }
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

    writeLog('[checkTriggers] Checking triggers for: ' + context.type + ', global rules count: ' + this.rules.length + ', players: ' + JSON.stringify(battle.players?.map(p => ({ playerId: p.playerId, rulesCount: (p as any).rules?.length || 0 }))))
    writeLog('[checkTriggers] Context: ' + JSON.stringify({ type: context.type, statusId: (context as any).statusId, playerId: context.playerId }));

    // 1. 检查全局规则
    writeLog('[checkTriggers] Global rules count: ' + this.rules.length);
    writeLog('[checkTriggers] Global rules: ' + JSON.stringify(this.rules.map(r => r.id)));
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
    
    globalMatchingRules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    writeLog('[checkTriggers] Global matching rules for ' + context.type + ': ' + JSON.stringify(globalMatchingRules.map(r => r.id)));

    // 跟踪已执行的规则ID，避免重复执行
    const executedRuleIds = new Set<string>();

    // 执行全局匹配的规则
    for (const rule of globalMatchingRules) {
      if (blocked) break
      // 记录已执行的规则
      executedRuleIds.add(rule.id);
      // 检查规则对象是否有效
      writeLog('[checkTriggers] Checking global rule: ' + rule?.id + ', effect type: ' + typeof rule?.effect);
      if (!rule || typeof rule.effect !== 'function') {
        writeLog('Skipping invalid global rule: rule or rule.effect is not a function, ruleId: ' + rule?.id)
        continue
      }
      
      try {
        // 找到拥有该规则的所有棋子，为每个棋子执行规则
        const owningPieces = battle.pieces?.filter((p: any) => 
          p.rules?.some((r: any) => r.id === rule.id)
        ) || [];
        
        if (owningPieces.length === 0) {
          // 如果没有棋子拥有该规则，直接执行（兼容旧逻辑）
          const result = rule.effect(battle, context)
          if (result.success) {
            success = true
            if (result.message) {
              triggeredEffects.push(result.message)
            }
            if (result.blocked) {
              blocked = true
            }
          }
        } else {
          // 为每个拥有该规则的棋子执行
          for (const owningPiece of owningPieces) {
            if (blocked) break
            const pieceContext = { ...context, piece: context.sourcePiece, rulePiece: owningPiece }
            const result = rule.effect(battle, pieceContext)
            // 回写 damage，使后续规则看到修改后的值
            if (pieceContext.damage !== context.damage) {
              context.damage = pieceContext.damage;
            }
            if (context.damage !== undefined && context.damage <= 0) {
              blocked = true;
            }
            if (result.success) {
              success = true
              if (result.message) {
                triggeredEffects.push(result.message)
              }
              if (result.blocked) {
                blocked = true
              }

              // 更新规则的限制状态
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
          }
        }
      } catch (error) {
        writeLog('Error executing global rule ' + rule.id + ': ' + error)
      }
    }

    // 2. 检查所有棋子实例的规则（对所有触发类型都扫描全部棋子）
    // 这样"移动后"、"技能使用后"等事件可以触发任意棋子上绑定的规则，而不仅限于事件发起者
    writeLog('[checkTriggers] Checking piece rules, pieces count: ' + (battle.pieces?.length || 0));
    if (battle.pieces) {
      for (const piece of battle.pieces) {
        if (blocked) break
        if (!piece.rules || piece.rules.length === 0) continue
        writeLog('[checkTriggers] Piece ' + piece.name + ' has ' + piece.rules.length + ' rules: ' + JSON.stringify(piece.rules.map((r: any) => r.id)));

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

        pieceMatchingRules.sort((a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0))
        for (const rule of pieceMatchingRules) {
          if (blocked) break
          // 跳过已在全局规则中执行过的规则
          if (executedRuleIds.has(rule.id)) {
            writeLog('[checkTriggers] Skipping already executed rule: ' + rule.id);
            continue;
          }

          // 检查是否是默认函数（只返回 "xxx触发" 消息，尚未加载真实逻辑）
          const isDefaultEffect = typeof rule.effect === 'function' &&
            rule.effect.toString().includes('ruleData.name') &&
            rule.effect.toString().includes('触发') &&
            !rule.effect.toString().includes('checkToxin')

          if (typeof rule.effect !== 'function' || isDefaultEffect) {
            writeLog('[checkTriggers] Reloading rule effect for: ' + rule.id + ', isDefaultEffect: ' + isDefaultEffect)
            try {
              const { loadRuleById } = require('./skills')
              const reloadedRule = loadRuleById(rule.id)
              writeLog('[checkTriggers] Reloaded rule: ' + rule.id + ', effect type: ' + typeof reloadedRule?.effect)
              if (reloadedRule && typeof reloadedRule.effect === 'function') {
                rule.effect = reloadedRule.effect
                writeLog('[checkTriggers] Rule effect reloaded successfully: ' + rule.id)
              } else {
                writeLog('[checkTriggers] Failed to reload rule effect for: ' + rule.id)
                continue
              }
            } catch (e) {
              writeLog('[checkTriggers] Error reloading rule: ' + rule.id + ', error: ' + e)
              continue
            }
          }

          try {
            // 设置当前执行规则的棋子，让技能代码知道是哪个棋子的规则正在执行
            // 同时设置 piece 字段，用于检查事件发起者是否为当前规则绑定者
            context.piece = context.sourcePiece
            context.rulePiece = piece
            const result = rule.effect(battle, context)
            // damage 直接通过引用传递，检查是否归零
            if (context.damage !== undefined && context.damage <= 0) {
              blocked = true;
            }
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
            writeLog('Error executing rule ' + rule.id + ' on piece ' + piece.instanceId + ': ' + error)
          }
        }
      }
    }

    // 3. 检查所有玩家的玩家级别规则（player.rules[]）
    if (battle.players) {
      writeLog('[checkTriggers] Checking player rules, players count: ' + battle.players.length)
      for (const player of battle.players) {
        if (blocked) break
        writeLog('[checkTriggers] Checking player: ' + player.playerId + ', rules: ' + ((player as any).rules?.length || 0))
        if (!(player as any).rules || (player as any).rules.length === 0) {
          writeLog('[checkTriggers] Player has no rules, skipping')
          continue
        }

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
        
        writeLog('[checkTriggers] Found matching rules for player: ' + player.playerId + ', count: ' + playerMatchingRules.length)

        for (const rule of playerMatchingRules) {
          if (blocked) break
          writeLog('[checkTriggers] Executing rule: ' + rule.id + ' for player: ' + player.playerId)
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
            // 把玩家的 playerId 和 player 对象注入到 context，供 triggerSkill 技能读取
            const playerContext = { ...context, playerId: player.playerId, player: player }
            writeLog('[checkTriggers] Calling rule.effect for: ' + rule.id + ', effect type: ' + typeof rule.effect)
            const result = rule.effect(battle, playerContext)
            writeLog('[checkTriggers] Rule effect result for ' + rule.id + ': ' + JSON.stringify(result))
            // 回写 damage，使后续规则看到修改后的值
            if (playerContext.damage !== context.damage) {
              context.damage = playerContext.damage;
            }
            if (context.damage !== undefined && context.damage <= 0) {
              blocked = true;
            }
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
            writeLog('[checkTriggers] Error executing player rule ' + rule.id + ' for player ' + player.playerId + ': ' + error)
            writeLog('Error executing player rule ' + rule.id + ' for player ' + player.playerId + ': ' + error)
          }
        }
      }
    }

    // 4. 检查所有玩家手牌中的 reactive 卡牌（全场两个玩家都扫描）
    if (battle.players) {
      for (const player of battle.players) {
        if (blocked) break
        if (!player.hand || player.hand.length === 0) continue
        // 从后往前遍历，因为触发后可能弃牌（会 splice）
        for (let i = player.hand.length - 1; i >= 0; i--) {
          const cardInstance = player.hand[i]
          try {
            const { loadCardById, executeCardFunction } = require('./skills')
            const cardDef = loadCardById(cardInstance.cardId) || (battle as any).customCards?.[cardInstance.cardId]
            if (!cardDef || cardDef.type !== 'reactive') continue
            if (!cardDef.trigger || cardDef.trigger.type !== context.type) continue

            const result = executeCardFunction(cardDef, player.playerId, battle, context)
            if (result && result.success) {
              success = true
              if (result.message) triggeredEffects.push(result.message)
              if (result.blocked) blocked = true
              // 弃牌（keepInHand=true 时保留在手牌中）
              if (!result.keepInHand) {
                if (!player.discardPile) player.discardPile = []
                player.hand.splice(i, 1)
                player.discardPile.push(cardInstance.cardId)
              }
            }
          } catch (error) {
            writeLog('Error executing reactive card ' + cardInstance.cardId + ': ' + error)
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
            writeLog('Rule ' + rule.id + ' (' + rule.name + ') expired and was removed');
          }
        }
      }
    }
  }
  
  
}

// 全局触发系统实例
export const globalTriggerSystem = new TriggerSystem()
