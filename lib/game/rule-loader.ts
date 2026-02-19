import fs from 'fs'
import path from 'path'
import type { TriggerRule } from './triggers'
import { executeSkillFunction } from './skills'

// 效果类型
export type EffectType =
  | "modifyStats"      // 修改属性
  | "addChargePoints"  // 增加充能点
  | "heal"             // 治疗
  | "damage"           // 伤害
  | "buff"             // 增益
  | "debuff"           // 减益
  | "triggerSkill"     // 触发技能

// 效果操作类型
export type EffectOperation = "add" | "subtract" | "multiply" | "set"

// 修改属性效果
export interface ModifyStatsEffect {
  type: "modifyStats"
  target: "source" | "target" | "all"
  modifications: Array<{
    stat: "maxHp" | "currentHp" | "attack" | "defense" | "moveRange"
    operation: EffectOperation
    value: string | number
  }>
  message: string
}

// 增加充能点效果
export interface AddChargePointsEffect {
  type: "addChargePoints"
  amount: number
  message: string
}

// 治疗效果
export interface HealEffect {
  type: "heal"
  amount: number
  target: "source" | "target" | "all"
  message: string
}

// 伤害效果
export interface DamageEffect {
  type: "damage"
  amount: number | string
  target: "source" | "target" | "all" | "area"
  range?: number
  message: string
}

// 触发技能效果
export interface TriggerSkillEffect {
  type: "triggerSkill"
  skillId: string
  message: string
}

// 效果定义
export type RuleEffect =
  | ModifyStatsEffect
  | AddChargePointsEffect
  | HealEffect
  | DamageEffect
  | TriggerSkillEffect

// 规则定义（从JSON加载）
export interface RuleDefinition {
  id: string
  name: string
  description: string
  trigger: {
    type: string
    conditions?: any
  }
  effect: RuleEffect
  limits?: {
    cooldownTurns?: number
    maxUses?: number
  }
}

// 加载所有规则
export function loadRules(): RuleDefinition[] {
  const rulesDir = path.join(process.cwd(), 'data', 'rules')
  const rules: RuleDefinition[] = []

  try {
    // 检查规则目录是否存在
    if (!fs.existsSync(rulesDir)) {
      console.warn('Rules directory not found, using default rules')
      return []
    }

    // 读取规则目录中的所有JSON文件
    const ruleFiles = fs.readdirSync(rulesDir).filter(file => file.endsWith('.json'))

    // 加载每个规则文件
    for (const file of ruleFiles) {
      const filePath = path.join(rulesDir, file)
      try {
        const fileContent = fs.readFileSync(filePath, 'utf8')
        const rule = JSON.parse(fileContent) as RuleDefinition
        rules.push(rule)
        console.log(`Loaded rule: ${rule.name} (${rule.id})`)
      } catch (error) {
        console.error(`Error loading rule file ${file}:`, error)
      }
    }
  } catch (error) {
    console.error('Error loading rules:', error)
  }

  return rules
}

// 将规则定义转换为TriggerRule
export function convertToTriggerRule(ruleDef: RuleDefinition): TriggerRule {
  return {
    id: ruleDef.id,
    name: ruleDef.name,
    description: ruleDef.description,
    trigger: ruleDef.trigger,
    effect: (battle, context) => {
      try {
        let success = false
        let message = ''

        switch (ruleDef.effect.type) {
          case 'modifyStats': {
            const effect = ruleDef.effect as ModifyStatsEffect
            const targets: any[] = []

            // 确定目标
            if (effect.target === 'source' || effect.target === 'all') {
              if (context.sourcePiece) {
                targets.push({ ...context.sourcePiece, type: 'source' })
              }
            }
            if (effect.target === 'target' || effect.target === 'all') {
              if (context.targetPiece) {
                targets.push({ ...context.targetPiece, type: 'target' })
              }
            }

            // 应用修改
            for (const target of targets) {
              for (const modification of effect.modifications) {
                let value = modification.value

                // 解析动态值
                if (typeof value === 'string') {
                  value = resolveDynamicValue(value, context)
                }

                // 应用操作
                switch (modification.operation) {
                  case 'add':
                    target[modification.stat] += value
                    break
                  case 'subtract':
                    target[modification.stat] -= value
                    break
                  case 'multiply':
                    target[modification.stat] *= value
                    break
                  case 'set':
                    target[modification.stat] = value
                    break
                }

                // 确保生命值不超过最大值
                if (modification.stat === 'currentHp' && target.maxHp !== undefined) {
                  target.currentHp = Math.min(target.currentHp, target.maxHp)
                }

                // 确保生命值不为负数
                if (modification.stat === 'currentHp') {
                  target.currentHp = Math.max(target.currentHp, 0)
                }
              }

              // 更新battle.pieces中的对应棋子
              if (target.type === 'source' && context.sourcePiece) {
                const index = battle.pieces.findIndex(p => p.instanceId === context.sourcePiece.instanceId)
                if (index !== -1) {
                  battle.pieces[index] = target
                }
              } else if (target.type === 'target' && context.targetPiece) {
                const index = battle.pieces.findIndex(p => p.instanceId === context.targetPiece.instanceId)
                if (index !== -1) {
                  battle.pieces[index] = target
                }
              }
            }

            // 生成消息
            message = resolveMessage(effect.message, context)
            success = targets.length > 0
            break
          }

          case 'addChargePoints': {
            const effect = ruleDef.effect as AddChargePointsEffect
            if (context.sourcePiece) {
              const playerMeta = battle.players.find(p => p.playerId === context.sourcePiece.ownerPlayerId)
              if (playerMeta) {
                playerMeta.chargePoints += effect.amount
                message = resolveMessage(effect.message, context)
                success = true
              }
            }
            break
          }

          case 'heal': {
            const effect = ruleDef.effect as HealEffect
            const targets: any[] = []

            // 确定目标
            if (effect.target === 'source' || effect.target === 'all') {
              if (context.sourcePiece) {
                targets.push({ ...context.sourcePiece, type: 'source' })
              }
            }
            if (effect.target === 'target' || effect.target === 'all') {
              if (context.targetPiece) {
                targets.push({ ...context.targetPiece, type: 'target' })
              }
            }

            // 应用治疗
            for (const target of targets) {
              const healAmount = Math.min(effect.amount, target.maxHp - target.currentHp)
              target.currentHp += healAmount

              // 更新battle.pieces中的对应棋子
              if (target.type === 'source' && context.sourcePiece) {
                const index = battle.pieces.findIndex(p => p.instanceId === context.sourcePiece.instanceId)
                if (index !== -1) {
                  battle.pieces[index] = target
                }
              } else if (target.type === 'target' && context.targetPiece) {
                const index = battle.pieces.findIndex(p => p.instanceId === context.targetPiece.instanceId)
                if (index !== -1) {
                  battle.pieces[index] = target
                }
              }
            }

            message = resolveMessage(effect.message, context)
            success = targets.length > 0
            break
          }

          case 'damage': {
            const effect = ruleDef.effect as DamageEffect
            const targets: any[] = []

            // 解析伤害值
            let damageAmount = effect.amount
            if (typeof damageAmount === 'string') {
              damageAmount = resolveDynamicValue(damageAmount, context)
            }

            // 确定目标
            if (effect.target === 'source' || effect.target === 'all') {
              if (context.sourcePiece) {
                targets.push({ ...context.sourcePiece, type: 'source' })
              }
            }
            if (effect.target === 'target' || effect.target === 'all') {
              if (context.targetPiece) {
                targets.push({ ...context.targetPiece, type: 'target' })
              }
            }
            if (effect.target === 'area' && context.sourcePiece && effect.range) {
              // 找到范围内的所有敌方棋子
              const range = effect.range
              battle.pieces.forEach(piece => {
                // 只选择敌方棋子，并且在范围内
                if (piece.ownerPlayerId !== context.sourcePiece.ownerPlayerId && piece.currentHp > 0) {
                  const distance = Math.abs(piece.x - context.sourcePiece.x) + Math.abs(piece.y - context.sourcePiece.y)
                  if (distance <= range) {
                    targets.push({ ...piece, type: 'area' })
                  }
                }
              })
            }

            // 应用伤害
            for (const target of targets) {
              target.currentHp = Math.max(0, target.currentHp - damageAmount)

              // 更新battle.pieces中的对应棋子
              if (target.type === 'source' && context.sourcePiece) {
                const index = battle.pieces.findIndex(p => p.instanceId === context.sourcePiece.instanceId)
                if (index !== -1) {
                  battle.pieces[index] = target
                }
              } else if (target.type === 'target' && context.targetPiece) {
                const index = battle.pieces.findIndex(p => p.instanceId === context.targetPiece.instanceId)
                if (index !== -1) {
                  battle.pieces[index] = target
                }
              } else if (target.type === 'area') {
                const index = battle.pieces.findIndex(p => p.instanceId === target.instanceId)
                if (index !== -1) {
                  battle.pieces[index] = target
                }
              }
            }

            message = resolveMessage(effect.message, context)
            success = targets.length > 0
            break
          }

          case 'triggerSkill': {
            const effect = ruleDef.effect as TriggerSkillEffect
            if (context.sourcePiece) {
              // 查找技能定义
              const skillDef = battle.skillsById[effect.skillId]
              if (skillDef) {
                // 创建技能执行上下文
                const skillContext = {
                  piece: {
                    instanceId: context.sourcePiece.instanceId,
                    templateId: context.sourcePiece.templateId,
                    ownerPlayerId: context.sourcePiece.ownerPlayerId,
                    currentHp: context.sourcePiece.currentHp,
                    maxHp: context.sourcePiece.maxHp,
                    attack: context.sourcePiece.attack,
                    defense: context.sourcePiece.defense,
                    x: context.sourcePiece.x,
                    y: context.sourcePiece.y,
                    moveRange: context.sourcePiece.moveRange
                  },
                  target: context.targetPiece ? {
                    instanceId: context.targetPiece.instanceId,
                    templateId: context.targetPiece.templateId,
                    ownerPlayerId: context.targetPiece.ownerPlayerId,
                    currentHp: context.targetPiece.currentHp,
                    maxHp: context.targetPiece.maxHp,
                    attack: context.targetPiece.attack,
                    defense: context.targetPiece.defense,
                    x: context.targetPiece.x,
                    y: context.targetPiece.y
                  } : null,
                  battle: {
                    turn: battle.turn.turnNumber,
                    currentPlayerId: battle.turn.currentPlayerId,
                    phase: battle.turn.phase
                  },
                  skill: {
                    id: skillDef.id,
                    name: skillDef.name,
                    type: skillDef.type,
                    powerMultiplier: skillDef.powerMultiplier
                  }
                }

                // 执行技能代码
                const skillResult = executeSkillFunction(skillDef, skillContext, battle)
                if (skillResult.success) {
                  message = skillResult.message || resolveMessage(effect.message, context)
                  success = true
                }
              } else {
                console.warn(`Skill not found: ${effect.skillId}`)
                success = false
                message = `技能 ${effect.skillId} 未找到`
              }
            }
            break
          }

          default:
            console.warn(`Unknown effect type: ${ruleDef.effect.type}`)
            break
        }

        return { success, message }
      } catch (error) {
        console.error('Error executing rule effect:', error)
        return { success: false, message: '效果执行失败' }
      }
    },
    limits: ruleDef.limits
  }
}

// 解析动态值
function resolveDynamicValue(value: string, context: any): number {
  // 解析目标属性
  if (value === 'target.maxHp' && context.targetPiece) {
    return context.targetPiece.maxHp
  }
  if (value === 'target.currentHp' && context.targetPiece) {
    return context.targetPiece.currentHp
  }
  if (value === 'target.attack' && context.targetPiece) {
    return context.targetPiece.attack
  }
  if (value === 'target.defense' && context.targetPiece) {
    return context.targetPiece.defense
  }
  if (value === 'source.maxHp' && context.sourcePiece) {
    return context.sourcePiece.maxHp
  }
  if (value === 'source.currentHp' && context.sourcePiece) {
    return context.sourcePiece.currentHp
  }
  if (value === 'source.attack' && context.sourcePiece) {
    return context.sourcePiece.attack
  }
  if (value === 'source.defense' && context.sourcePiece) {
    return context.sourcePiece.defense
  }
  if (value === 'damage' && context.damage) {
    return context.damage
  }

  // 尝试解析为数字
  const numValue = parseFloat(value)
  if (!isNaN(numValue)) {
    return numValue
  }

  return 0
}

// 解析消息
function resolveMessage(message: string, context: any): string {
  let resolvedMessage = message

  // 替换源棋子信息
  if (context.sourcePiece) {
    resolvedMessage = resolvedMessage.replace(/\${source\.templateId}/g, context.sourcePiece.templateId)
    resolvedMessage = resolvedMessage.replace(/\${source\.name}/g, context.sourcePiece.name || context.sourcePiece.templateId)
  }

  // 替换目标棋子信息
  if (context.targetPiece) {
    resolvedMessage = resolvedMessage.replace(/\${target\.templateId}/g, context.targetPiece.templateId)
    resolvedMessage = resolvedMessage.replace(/\${target\.name}/g, context.targetPiece.name || context.targetPiece.templateId)
    if (context.targetPiece.maxHp) {
      resolvedMessage = resolvedMessage.replace(/\${target\.maxHp}/g, context.targetPiece.maxHp.toString())
    }
  }

  // 替换伤害信息
  if (context.damage) {
    resolvedMessage = resolvedMessage.replace(/\${damage}/g, context.damage.toString())
  }

  return resolvedMessage
}
