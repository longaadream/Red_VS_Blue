import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"

export type SkillId = string

export type SkillKind = "active" | "passive"

export type SkillType = "normal" | "super"

export type SkillEffectType = 
  | "damage"        // 造成伤害
  | "heal"          // 治疗生命值
  | "move"          // 移动
  | "buff"          // 增益效果
  | "debuff"         // 减益效果
  | "shield"         // 护盾
  | "stun"          // 眩晕
  | "teleport"      // 传送
  | "summon"        // 召唤
  | "area"          // 范围效果
  | "special"        // 特殊效果

export interface SkillEffect {
  type: SkillEffectType
  value: number
  duration?: number  // 持续时间（回合数）
  target?: "self" | "enemy" | "all" | "allies" | "all-enemies"
  description?: string
}

/**
 * 技能执行上下文，提供给技能函数使用
 */
export interface SkillExecutionContext {
  piece: {
    instanceId: string
    templateId: string
    ownerPlayerId: string
    currentHp: number
    maxHp: number
    attack: number
    defense: number
    x: number
    y: number
    moveRange: number
  }
  target: {
    instanceId: string
    templateId: string
    ownerPlayerId: string
    currentHp: number
    maxHp: number
    attack: number
    defense: number
    x: number
    y: number
  } | null
  battle: {
    turn: number
    currentPlayerId: string
    phase: string
  }
  skill: {
    id: string
    name: string
    type: "normal" | "super"
    powerMultiplier: number
  }
}

/**
 * 技能执行结果，由技能函数返回
 */
export interface SkillExecutionResult {
  damage?: number
  heal?: number
  effects?: SkillEffect[]
  message: string
  success: boolean
}

/**
 * 技能的静态定义（模板）
 * 包含技能的元数据和函数代码
 */
export interface SkillDefinition {
  id: SkillId
  name: string
  description: string
  kind: SkillKind
  /** 技能类型：normal=普通技能, super=充能技能 */
  type: SkillType
  /** 冷却回合数（0 表示无冷却） */
  cooldownTurns: number
  /** 最大充能次数（例如 3 次用完就没了），0 表示不限次数，仅对super技能有效 */
  maxCharges: number
  /** 释放一次需要的充能点数，仅对super技能生效 */
  chargeCost?: number
  /** 技能基础威力系数，和攻击力等组合使用 */
  powerMultiplier: number
  /** 技能函数代码（字符串形式存储） */
  code: string
  /** 技能效果列表，支持多个效果 */
  effects: SkillEffect[]
  /** 技能范围：single=单体, area=范围, self=自身 */
  range: "single" | "area" | "self"
  /** 范围大小（仅对area类型有效） */
  areaSize?: number
  /** 是否需要目标 */
  requiresTarget: boolean
  /** 技能图标 */
  icon?: string
}

/**
 * 战局中某个棋子身上的技能状态（实例）
 */
export interface SkillState {
  skillId: SkillId
  /** 当前剩余冷却回合 */
  currentCooldown: number
  /** 当前剩余充能次数 */
  currentCharges: number
  /** 是否已解锁 / 学会 */
  unlocked: boolean
}

// 索敌模块 - 用于获取范围内的目标
export function getAllEnemiesInRange(context: SkillExecutionContext, range: number, battle: BattleState): Array<{
  instanceId: string
  templateId: string
  ownerPlayerId: string
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  x: number
  y: number
}> {
  const { piece } = context
  const enemies: Array<{
    instanceId: string
    templateId: string
    ownerPlayerId: string
    currentHp: number
    maxHp: number
    attack: number
    defense: number
    x: number
    y: number
  }> = []

  for (const p of battle.pieces) {
    // 只考虑存活的敌人
    if (p.currentHp > 0 && p.ownerPlayerId !== piece.ownerPlayerId) {
      const distance = Math.abs(p.x - piece.x) + Math.abs(p.y - piece.y)
      if (distance <= range) {
        enemies.push({
          instanceId: p.instanceId,
          templateId: p.templateId,
          ownerPlayerId: p.ownerPlayerId,
          currentHp: p.currentHp,
          maxHp: p.maxHp,
          attack: p.attack,
          defense: p.defense,
          x: p.x,
          y: p.y
        })
      }
    }
  }

  return enemies
}

// 获取范围内的所有盟友
export function getAllAlliesInRange(context: SkillExecutionContext, range: number, battle: BattleState): Array<{
  instanceId: string
  templateId: string
  ownerPlayerId: string
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  x: number
  y: number
}> {
  const { piece } = context
  const allies: Array<{
    instanceId: string
    templateId: string
    ownerPlayerId: string
    currentHp: number
    maxHp: number
    attack: number
    defense: number
    x: number
    y: number
  }> = []

  for (const p of battle.pieces) {
    // 只考虑存活的盟友
    if (p.currentHp > 0 && p.ownerPlayerId === piece.ownerPlayerId) {
      const distance = Math.abs(p.x - piece.x) + Math.abs(p.y - piece.y)
      if (distance <= range) {
        allies.push({
          instanceId: p.instanceId,
          templateId: p.templateId,
          ownerPlayerId: p.ownerPlayerId,
          currentHp: p.currentHp,
          maxHp: p.maxHp,
          attack: p.attack,
          defense: p.defense,
          x: p.x,
          y: p.y
        })
      }
    }
  }

  return allies
}

// 计算两点之间的距离
export function calculateDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2)
}

// 检查目标是否在范围内
export function isTargetInRange(context: SkillExecutionContext, target: any, range: number): boolean {
  if (!target) return false
  const distance = calculateDistance(
    context.piece.x, context.piece.y,
    target.x, target.y
  )
  return distance <= range
}

// 执行技能函数
export function executeSkillFunction(skillDef: SkillDefinition, context: SkillExecutionContext, battle: BattleState): SkillExecutionResult {
  try {
    // 创建技能执行环境，包含辅助函数
    const skillEnvironment = {
      context,
      battle,
      getAllEnemiesInRange: (range: number) => getAllEnemiesInRange(context, range, battle),
      getAllAlliesInRange: (range: number) => getAllAlliesInRange(context, range, battle),
      calculateDistance,
      isTargetInRange: (target: any, range: number) => isTargetInRange(context, target, range)
    }

    // 构建技能执行函数
    const skillCode = `
      (function() {
        ${skillDef.code}
        return executeSkill(context);
      })()
    `

    // 执行技能函数
    const result = eval(skillCode)
    return result
  } catch (error) {
    console.error('Error executing skill:', error)
    return {
      message: '技能执行失败: ' + (error instanceof Error ? error.message : 'Unknown error'),
      success: false
    }
  }
}

// 应用技能效果
export function applySkillEffects(battle: BattleState, effects: SkillEffect[], sourcePiece: PieceInstance): void {
  for (const effect of effects) {
    switch (effect.type) {
      case 'damage':
        // 处理伤害效果
        if (effect.target === 'enemy') {
          // 伤害单个敌人
          // 这里需要知道具体的目标，暂时跳过
        } else if (effect.target === 'all-enemies') {
          // 伤害所有敌人
          for (const piece of battle.pieces) {
            if (piece.ownerPlayerId !== sourcePiece.ownerPlayerId && piece.currentHp > 0) {
              piece.currentHp = Math.max(0, piece.currentHp - effect.value)
            }
          }
        }
        break
      case 'heal':
        // 处理治疗效果
        if (effect.target === 'self') {
          sourcePiece.currentHp = Math.min(sourcePiece.maxHp, sourcePiece.currentHp + effect.value)
        } else if (effect.target === 'allies') {
          for (const piece of battle.pieces) {
            if (piece.ownerPlayerId === sourcePiece.ownerPlayerId && piece.currentHp > 0) {
              piece.currentHp = Math.min(piece.maxHp, piece.currentHp + effect.value)
            }
          }
        }
        break
      case 'buff':
        // 处理增益效果
        if (effect.target === 'self') {
          if (!sourcePiece.buffs) {
            sourcePiece.buffs = []
          }
          sourcePiece.buffs.push({
            type: 'attack',
            value: effect.value,
            duration: effect.duration || 3,
            source: 'skill'
          })
          // 直接提升攻击力，简化实现
          sourcePiece.attack += effect.value
        }
        break
      case 'debuff':
        // 处理减益效果
        // 需要实现 debuff 系统
        break
      case 'shield':
        // 处理护盾效果
        if (effect.target === 'self') {
          if (!sourcePiece.shield) {
            sourcePiece.shield = 0
          }
          sourcePiece.shield += effect.value
        }
        break
      case 'teleport':
        // 处理传送效果
        if (effect.target === 'self') {
          // 这里需要接收目标位置参数，暂时保留随机传送作为 fallback
          // 实际的目标选择会在战斗页面中实现
          const walkableTiles = battle.map.tiles.filter(tile => tile.props.walkable)
          if (walkableTiles.length > 0) {
            const randomTile = walkableTiles[Math.floor(Math.random() * walkableTiles.length)]
            sourcePiece.x = randomTile.x
            sourcePiece.y = randomTile.y
          }
        }
        break
      default:
        break
    }
  }
}
