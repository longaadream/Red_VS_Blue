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

// 目标选择器函数类型定义
export interface TargetSelectors {
  // 获取所有敌人
  getAllEnemies: () => PieceInstance[];
  // 获取所有盟友
  getAllAllies: () => PieceInstance[];
  // 获取单个敌人（最近的）
  getNearestEnemy: () => PieceInstance | null;
  // 获取单个敌人（血量最低的）
  getLowestHpEnemy: () => PieceInstance | null;
  // 获取单个敌人（攻击力最高的）
  getHighestAttackEnemy: () => PieceInstance | null;
  // 获取单个敌人（防御力最低的）
  getLowestDefenseEnemy: () => PieceInstance | null;
  // 获取单个盟友（血量最低的）
  getLowestHpAlly: () => PieceInstance | null;
  // 获取单个盟友（攻击力最高的）
  getHighestAttackAlly: () => PieceInstance | null;
  // 根据位置获取棋子
  getPieceAt: (x: number, y: number) => PieceInstance | null;
  // 获取指定范围内的敌人
  getEnemiesInRange: (range: number) => PieceInstance[];
  // 获取指定范围内的盟友
  getAlliesInRange: (range: number) => PieceInstance[];
}

// 目标选择器函数
function createTargetSelectors(battle: BattleState, sourcePiece: PieceInstance): TargetSelectors {
  return {
    // 获取所有敌人
    getAllEnemies: () => {
      return battle.pieces.filter(p => 
        p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0
      );
    },
    
    // 获取所有盟友
    getAllAllies: () => {
      return battle.pieces.filter(p => 
        p.ownerPlayerId === sourcePiece.ownerPlayerId && p.currentHp > 0
      );
    },
    
    // 获取单个敌人（最近的）
    getNearestEnemy: () => {
      const enemies = battle.pieces.filter(p => 
        p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0
      );
      if (enemies.length === 0) return null;
      
      return enemies.reduce((nearest, current) => {
        const nearestDistance = Math.abs(nearest.x! - sourcePiece.x!) + Math.abs(nearest.y! - sourcePiece.y!);
        const currentDistance = Math.abs(current.x! - sourcePiece.x!) + Math.abs(current.y! - sourcePiece.y!);
        return currentDistance < nearestDistance ? current : nearest;
      });
    },
    
    // 获取单个敌人（血量最低的）
    getLowestHpEnemy: () => {
      const enemies = battle.pieces.filter(p => 
        p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0
      );
      if (enemies.length === 0) return null;
      
      return enemies.reduce((lowest, current) => {
        return current.currentHp < lowest.currentHp ? current : lowest;
      });
    },
    
    // 获取单个敌人（攻击力最高的）
    getHighestAttackEnemy: () => {
      const enemies = battle.pieces.filter(p => 
        p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0
      );
      if (enemies.length === 0) return null;
      
      return enemies.reduce((highest, current) => {
        return current.attack > highest.attack ? current : highest;
      });
    },
    
    // 获取单个敌人（防御力最低的）
    getLowestDefenseEnemy: () => {
      const enemies = battle.pieces.filter(p => 
        p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0
      );
      if (enemies.length === 0) return null;
      
      return enemies.reduce((lowest, current) => {
        return current.defense < lowest.defense ? current : lowest;
      });
    },
    
    // 获取单个盟友（血量最低的）
    getLowestHpAlly: () => {
      const allies = battle.pieces.filter(p => 
        p.ownerPlayerId === sourcePiece.ownerPlayerId && p.currentHp > 0
      );
      if (allies.length === 0) return null;
      
      return allies.reduce((lowest, current) => {
        return current.currentHp < lowest.currentHp ? current : lowest;
      });
    },
    
    // 获取单个盟友（攻击力最高的）
    getHighestAttackAlly: () => {
      const allies = battle.pieces.filter(p => 
        p.ownerPlayerId === sourcePiece.ownerPlayerId && p.currentHp > 0
      );
      if (allies.length === 0) return null;
      
      return allies.reduce((highest, current) => {
        return current.attack > highest.attack ? current : highest;
      });
    },
    
    // 根据位置获取棋子
    getPieceAt: (x: number, y: number) => {
      return battle.pieces.find(p => p.x === x && p.y === y && p.currentHp > 0) || null;
    },
    
    // 获取指定范围内的敌人
    getEnemiesInRange: (range: number) => {
      return battle.pieces.filter(p => {
        if (p.ownerPlayerId === sourcePiece.ownerPlayerId || p.currentHp <= 0) {
          return false;
        }
        const distance = Math.abs(p.x! - sourcePiece.x!) + Math.abs(p.y! - sourcePiece.y!);
        return distance <= range;
      });
    },
    
    // 获取指定范围内的盟友
    getAlliesInRange: (range: number) => {
      return battle.pieces.filter(p => {
        if (p.ownerPlayerId !== sourcePiece.ownerPlayerId || p.currentHp <= 0) {
          return false;
        }
        const distance = Math.abs(p.x! - sourcePiece.x!) + Math.abs(p.y! - sourcePiece.y!);
        return distance <= range;
      });
    }
  };
}

// 效果函数
function createEffectFunctions(battle: BattleState, sourcePiece: PieceInstance, target?: { x: number, y: number }) {
  const selectors = createTargetSelectors(battle, sourcePiece);
  
  return {
    // 目标选择器
    select: selectors,
    
    // 伤害效果
    damage: (params: { value: number, target: "self" | "enemy" | "all-enemies" | PieceInstance } | number, targetTypeOrPiece?: "self" | "enemy" | "all-enemies" | PieceInstance) => {
      // 支持多种调用方式
      let value: number;
      let target: "self" | "enemy" | "all-enemies" | PieceInstance;
      
      if (typeof params === "object" && params !== null) {
        if ('value' in params) {
          value = params.value;
          target = params.target;
        } else {
          // 如果直接传入棋子对象
          value = params as any;
          target = targetTypeOrPiece as PieceInstance;
        }
      } else {
        value = params;
        target = targetTypeOrPiece || "enemy";
      }
      
      if (target === "self") {
        sourcePiece.currentHp = Math.max(0, sourcePiece.currentHp - value);
      } else if (target === "all-enemies") {
        for (const piece of battle.pieces) {
          if (piece.ownerPlayerId !== sourcePiece.ownerPlayerId && piece.currentHp > 0) {
            piece.currentHp = Math.max(0, piece.currentHp - value);
          }
        }
      } else if (target === "enemy") {
        // 默认攻击最近的敌人
        const nearestEnemy = selectors.getNearestEnemy();
        if (nearestEnemy) {
          nearestEnemy.currentHp = Math.max(0, nearestEnemy.currentHp - value);
        }
      } else if (typeof target === "object" && target.currentHp > 0) {
        // 直接攻击指定的棋子
        target.currentHp = Math.max(0, target.currentHp - value);
      }
      
      return { type: "damage", value, success: true };
    },

    // 治疗效果
    heal: (params: { value: number, target: "self" | "allies" | PieceInstance } | number, targetTypeOrPiece?: "self" | "allies" | PieceInstance) => {
      let value: number;
      let target: "self" | "allies" | PieceInstance;
      
      if (typeof params === "object" && params !== null) {
        if ('value' in params) {
          value = params.value;
          target = params.target;
        } else {
          value = params as any;
          target = targetTypeOrPiece as PieceInstance;
        }
      } else {
        value = params;
        target = targetTypeOrPiece || "self";
      }
      
      if (target === "self") {
        sourcePiece.currentHp = Math.min(sourcePiece.maxHp, sourcePiece.currentHp + value);
      } else if (target === "allies") {
        for (const piece of battle.pieces) {
          if (piece.ownerPlayerId === sourcePiece.ownerPlayerId && piece.currentHp > 0) {
            piece.currentHp = Math.min(piece.maxHp, piece.currentHp + value);
          }
        }
      } else if (typeof target === "object" && target.currentHp > 0) {
        // 直接治疗指定的棋子
        target.currentHp = Math.min(target.maxHp, target.currentHp + value);
      }
      
      return { type: "heal", value, success: true };
    },

    // 增益效果
    buff: (params: { value: number, duration?: number, target: "self" | "allies" | PieceInstance, type?: "attack" | "defense" } | number, duration?: number, targetTypeOrPiece?: "self" | "allies" | PieceInstance) => {
      let value: number;
      let durationVal: number = 3;
      let target: "self" | "allies" | PieceInstance;
      let buffType: "attack" | "defense" = "attack";
      
      if (typeof params === "object" && params !== null) {
        if ('value' in params) {
          value = params.value;
          durationVal = params.duration || 3;
          target = params.target;
          buffType = params.type || "attack";
        } else {
          value = params as any;
          durationVal = duration || 3;
          target = targetTypeOrPiece as PieceInstance;
        }
      } else {
        value = params;
        durationVal = duration || 3;
        target = targetTypeOrPiece || "self";
      }
      
      const applyBuff = (piece: PieceInstance) => {
        if (!piece.buffs) {
          piece.buffs = [];
        }
        piece.buffs.push({
          type: buffType,
          value,
          duration: durationVal,
          source: 'skill'
        });
        if (buffType === "attack") {
          piece.attack += value;
        } else if (buffType === "defense") {
          piece.defense += value;
        }
      };
      
      if (target === "self") {
        applyBuff(sourcePiece);
      } else if (target === "allies") {
        for (const piece of battle.pieces) {
          if (piece.ownerPlayerId === sourcePiece.ownerPlayerId && piece.currentHp > 0) {
            applyBuff(piece);
          }
        }
      } else if (typeof target === "object" && target.currentHp > 0) {
        // 直接增益指定的棋子
        applyBuff(target);
      }
      
      return { type: "buff", value, duration: durationVal, success: true };
    },

    // 减益效果
    debuff: (params: { value: number, duration?: number, target: "enemy" | "all-enemies" | PieceInstance, type?: "attack" | "defense" } | number, duration?: number, targetTypeOrPiece?: "enemy" | "all-enemies" | PieceInstance) => {
      let value: number;
      let durationVal: number = 3;
      let target: "enemy" | "all-enemies" | PieceInstance;
      let debuffType: "attack" | "defense" = "defense";
      
      if (typeof params === "object" && params !== null) {
        if ('value' in params) {
          value = params.value;
          durationVal = params.duration || 3;
          target = params.target;
          debuffType = params.type || "defense";
        } else {
          value = params as any;
          durationVal = duration || 3;
          target = targetTypeOrPiece as PieceInstance;
        }
      } else {
        value = params;
        durationVal = duration || 3;
        target = targetTypeOrPiece || "enemy";
      }
      
      const applyDebuff = (piece: PieceInstance) => {
        if (!piece.debuffs) {
          piece.debuffs = [];
        }
        piece.debuffs.push({
          type: debuffType,
          value,
          duration: durationVal,
          source: 'skill'
        });
        if (debuffType === "attack") {
          piece.attack = Math.max(0, piece.attack - value);
        } else if (debuffType === "defense") {
          piece.defense = Math.max(0, piece.defense - value);
        }
      };
      
      if (target === "all-enemies") {
        for (const piece of battle.pieces) {
          if (piece.ownerPlayerId !== sourcePiece.ownerPlayerId && piece.currentHp > 0) {
            applyDebuff(piece);
          }
        }
      } else if (target === "enemy") {
        // 默认减益最近的敌人
        const nearestEnemy = selectors.getNearestEnemy();
        if (nearestEnemy) {
          applyDebuff(nearestEnemy);
        }
      } else if (typeof target === "object" && target.currentHp > 0) {
        // 直接减益指定的棋子
        applyDebuff(target);
      }
      
      return { type: "debuff", value, duration: durationVal, success: true };
    },

    // 护盾效果
    shield: (params: { value: number, target: "self" | "allies" | PieceInstance } | number, targetTypeOrPiece?: "self" | "allies" | PieceInstance) => {
      let value: number;
      let target: "self" | "allies" | PieceInstance;
      
      if (typeof params === "object" && params !== null) {
        if ('value' in params) {
          value = params.value;
          target = params.target;
        } else {
          value = params as any;
          target = targetTypeOrPiece as PieceInstance;
        }
      } else {
        value = params;
        target = targetTypeOrPiece || "self";
      }
      
      const applyShield = (piece: PieceInstance) => {
        if (!piece.shield) {
          piece.shield = 0;
        }
        piece.shield += value;
      };
      
      if (target === "self") {
        applyShield(sourcePiece);
      } else if (target === "allies") {
        for (const piece of battle.pieces) {
          if (piece.ownerPlayerId === sourcePiece.ownerPlayerId && piece.currentHp > 0) {
            applyShield(piece);
          }
        }
      } else if (typeof target === "object" && target.currentHp > 0) {
        // 直接为指定的棋子添加护盾
        applyShield(target);
      }
      
      return { type: "shield", value, success: true };
    },

    // 传送效果
    teleport: (x: number, y?: number) => {
      let targetPos: { x: number, y: number } | undefined;
      
      if (typeof x === "object" && x !== null) {
        // 如果传入对象格式 {x, y}
        targetPos = x as { x: number, y: number };
      } else if (typeof x === "number" && typeof y === "number") {
        // 如果传入两个参数 x, y
        targetPos = { x, y };
      } else {
        // 使用默认目标位置
        targetPos = target;
      }
      
      if (targetPos) {
        // 验证目标位置是否在地图范围内
        const targetTile = battle.map.tiles.find(t => t.x === targetPos.x && t.y === targetPos.y);
        if (targetTile) {
          // 验证目标位置是否可行走
          if (targetTile.props.walkable) {
            // 验证目标位置是否被占用
            const isOccupied = battle.pieces.some(p => p.x === targetPos.x && p.y === targetPos.y && p.currentHp > 0);
            if (!isOccupied) {
              // 执行传送
              sourcePiece.x = targetPos.x;
              sourcePiece.y = targetPos.y;
              return { type: "teleport", target: targetPos, success: true };
            } else {
              console.warn(`Teleport failed: Position ${targetPos.x},${targetPos.y} is occupied`);
            }
          } else {
            console.warn(`Teleport failed: Position ${targetPos.x},${targetPos.y} is not walkable`);
          }
        } else {
          console.warn(`Teleport failed: Position ${targetPos.x},${targetPos.y} is out of bounds`);
        }
      } else {
        // 随机传送作为 fallback
        const walkableTiles = battle.map.tiles.filter(tile => tile.props.walkable);
        if (walkableTiles.length > 0) {
          // 过滤掉已被占用的位置
          const availableTiles = walkableTiles.filter(tile => {
            return !battle.pieces.some(p => p.x === tile.x && p.y === tile.y && p.currentHp > 0);
          });
          
          if (availableTiles.length > 0) {
            const randomTile = availableTiles[Math.floor(Math.random() * availableTiles.length)];
            sourcePiece.x = randomTile.x;
            sourcePiece.y = randomTile.y;
            return { type: "teleport", target: randomTile, success: true };
          } else {
            console.warn("Teleport failed: No available walkable positions");
          }
        } else {
          console.warn("Teleport failed: No walkable positions on map");
        }
      }
      return { type: "teleport", success: false };
    }
  };
}

// 执行技能函数
export function executeSkillFunction(skillDef: SkillDefinition, context: SkillExecutionContext, battle: BattleState): SkillExecutionResult {
  try {
    // 找到源棋子
    const sourcePiece = battle.pieces.find(p => p.instanceId === context.piece.instanceId)
    if (!sourcePiece) {
      throw new Error('Source piece not found')
    }

    // 创建效果函数
    const effects = createEffectFunctions(battle, sourcePiece)

    // 创建技能执行环境，包含辅助函数和效果函数
    const skillEnvironment = {
      context,
      battle,
      getAllEnemiesInRange: (range: number) => getAllEnemiesInRange(context, range, battle),
      getAllAlliesInRange: (range: number) => getAllAlliesInRange(context, range, battle),
      calculateDistance,
      isTargetInRange: (target: any, range: number) => isTargetInRange(context, target, range),
      // 目标选择器
      select: effects.select,
      // 效果函数
      damage: effects.damage,
      heal: effects.heal,
      buff: effects.buff,
      debuff: effects.debuff,
      shield: effects.shield,
      teleport: effects.teleport
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
export function applySkillEffects(battle: BattleState, effects: SkillEffect[], sourcePiece: PieceInstance, target?: { x: number, y: number }): void {
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
        } else if (effect.target === 'self') {
          // 自残效果
          sourcePiece.currentHp = Math.max(0, sourcePiece.currentHp - effect.value)
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
        } else if (effect.target === 'allies') {
          // 增益所有盟友
          for (const piece of battle.pieces) {
            if (piece.ownerPlayerId === sourcePiece.ownerPlayerId && piece.currentHp > 0) {
              if (!piece.buffs) {
                piece.buffs = []
              }
              piece.buffs.push({
                type: 'attack',
                value: effect.value,
                duration: effect.duration || 3,
                source: 'skill'
              })
              piece.attack += effect.value
            }
          }
        }
        break
      case 'debuff':
        // 处理减益效果
        if (effect.target === 'enemy') {
          // 需要实现 debuff 系统
        } else if (effect.target === 'all-enemies') {
          // 减益所有敌人
          for (const piece of battle.pieces) {
            if (piece.ownerPlayerId !== sourcePiece.ownerPlayerId && piece.currentHp > 0) {
              if (!piece.debuffs) {
                piece.debuffs = []
              }
              piece.debuffs.push({
                type: 'defense',
                value: effect.value,
                duration: effect.duration || 3,
                source: 'skill'
              })
              // 直接降低防御力，简化实现
              piece.defense = Math.max(0, piece.defense - effect.value)
            }
          }
        }
        break
      case 'shield':
        // 处理护盾效果
        if (effect.target === 'self') {
          if (!sourcePiece.shield) {
            sourcePiece.shield = 0
          }
          sourcePiece.shield += effect.value
        } else if (effect.target === 'allies') {
          // 为所有盟友添加护盾
          for (const piece of battle.pieces) {
            if (piece.ownerPlayerId === sourcePiece.ownerPlayerId && piece.currentHp > 0) {
              if (!piece.shield) {
                piece.shield = 0
              }
              piece.shield += effect.value
            }
          }
        }
        break
      case 'teleport':
        // 处理传送效果
        if (effect.target === 'self') {
          if (target) {
            // 使用指定的目标位置
            const targetTile = battle.map.tiles.find(t => t.x === target.x && t.y === target.y)
            if (targetTile && targetTile.props.walkable) {
              // 检查目标位置是否被占用
              const isOccupied = battle.pieces.some(p => p.x === target.x && p.y === target.y && p.currentHp > 0)
              if (!isOccupied) {
                sourcePiece.x = target.x
                sourcePiece.y = target.y
              }
            }
          } else {
            // 随机传送作为 fallback
            const walkableTiles = battle.map.tiles.filter(tile => tile.props.walkable)
            if (walkableTiles.length > 0) {
              const randomTile = walkableTiles[Math.floor(Math.random() * walkableTiles.length)]
              sourcePiece.x = randomTile.x
              sourcePiece.y = randomTile.y
            }
          }
        }
        break
      default:
        break
    }
  }
}
