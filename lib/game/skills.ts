import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"

export type SkillId = string

export type SkillKind = "active" | "passive"

export type SkillType = "normal" | "super"



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
  /** 技能预览函数代码（字符串形式存储），用于计算和显示技能效果预览 */
  previewCode?: string
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
      // 上下文
      context,
      // 源棋子（直接引用，可读写）
      sourcePiece,
      battle,
      
      // 目标选择器
      select: effects.select,
      
      // 效果函数
      teleport: effects.teleport,
      
      // 辅助函数
      getAllEnemiesInRange: (range: number) => getAllEnemiesInRange(context, range, battle),
      getAllAlliesInRange: (range: number) => getAllAlliesInRange(context, range, battle),
      calculateDistance,
      isTargetInRange: (target: any, range: number) => isTargetInRange(context, target, range),
      
      // 工具函数
      Math,
      console
    }

    // 尝试执行技能定义中的代码
    if (skillDef.code) {
      try {
        // 构建完整的技能执行代码
        const fullSkillCode = `
          (function(environment) {
            // 定义全局变量
            const context = environment.context;
            const sourcePiece = environment.sourcePiece;
            const battle = environment.battle;
            const select = environment.select;
            const teleport = environment.teleport;
            const getAllEnemiesInRange = environment.getAllEnemiesInRange;
            const getAllAlliesInRange = environment.getAllAlliesInRange;
            const calculateDistance = environment.calculateDistance;
            const isTargetInRange = environment.isTargetInRange;
            const Math = environment.Math;
            const console = environment.console;
            
            // 定义技能执行函数
            ${skillDef.code}
            
            // 执行技能
            return executeSkill(context);
          })(skillEnvironment)
        `;

        // 执行技能代码
        const result = eval(fullSkillCode);
        return result;
      } catch (error) {
        console.error('Error executing skill code:', error);
        // 执行失败时，使用默认技能逻辑
      }
    }

    // 默认技能逻辑（作为fallback）
    // 找到最近的敌人
    const nearestEnemy = effects.select.getNearestEnemy();
    if (nearestEnemy) {
      // 计算伤害值
      const damageValue = sourcePiece.attack * skillDef.powerMultiplier;
      // 应用伤害
      const originalHp = nearestEnemy.currentHp;
      nearestEnemy.currentHp = Math.max(0, nearestEnemy.currentHp - damageValue);
      
      // 检查是否击杀了敌人
      if (originalHp > 0 && nearestEnemy.currentHp === 0) {
        // 击杀敌人后，为击杀者添加充能点
        const playerMeta = battle.players.find(p => p.playerId === sourcePiece.ownerPlayerId);
        if (playerMeta) {
          playerMeta.chargePoints += 1; // 每次击杀获得1点充能
        }
        return {
          message: `对最近的敌人造成${Math.round(damageValue)}点伤害，击杀敌人获得1点充能`,
          success: true
        };
      }
      
      return {
        message: `对最近的敌人造成${Math.round(damageValue)}点伤害`,
        success: true
      };
    } else {
      return {
        message: '范围内没有可攻击的敌人',
        success: false
      };
    }
  } catch (error) {
    console.error('Error executing skill:', error)
    return {
      message: '技能执行失败: ' + (error instanceof Error ? error.message : 'Unknown error'),
      success: false
    }
  }
}

// 计算技能的预期效果（用于显示）
export function calculateSkillPreview(skillDef: SkillDefinition, piece: PieceInstance, currentCooldown?: number): {
  description: string
  expectedValues: {
    damage?: number
    heal?: number
    buff?: number
    debuff?: number
  }
  cooldown?: number
  currentCooldown?: number
  chargeCost?: number
} {
  // 如果技能定义中包含预览函数代码，使用它来计算效果
  if (skillDef.previewCode) {
    try {
      // 创建预览函数执行环境
      const previewEnvironment = {
        piece,
        skillDef,
        currentCooldown,
        calculateDistance,
        Math
      }

      // 构建预览函数执行代码
      const previewCode = `
        (function() {
          ${skillDef.previewCode}
          return calculatePreview(piece, skillDef, currentCooldown);
        })()
      `

      // 执行预览函数
      const result = eval(previewCode)
      // 添加冷却信息和充能点数信息
      return {
        ...result,
        cooldown: skillDef.cooldownTurns,
        currentCooldown,
        chargeCost: skillDef.chargeCost
      }
    } catch (error) {
      console.error('Error executing skill preview:', error)
      // 如果预览函数执行失败，使用默认计算
    }
  }

  // 默认计算逻辑（作为fallback）
  const expectedValues: {
    damage?: number
    heal?: number
    buff?: number
    debuff?: number
  } = {}

  // 根据技能ID和powerMultiplier计算预期效果
  if (skillDef.id === 'basic-attack') {
    expectedValues.damage = Math.round(piece.attack * skillDef.powerMultiplier)
  } else if (skillDef.id === 'fireball') {
    expectedValues.damage = Math.round(piece.attack * skillDef.powerMultiplier)
  } else if (skillDef.id === 'buff-attack') {
    expectedValues.buff = 10 // 固定值
  } else if (skillDef.id === 'arcane-burst') {
    expectedValues.damage = Math.round(piece.attack * 2.5)
    expectedValues.buff = 15 // 固定值
  } else if (skillDef.id === 'arcane-combination') {
    expectedValues.damage = 50 // 固定值
    expectedValues.buff = 10 // 固定值
  }

  // 生成包含计算值的描述
  let calculatedDescription = skillDef.description

  // 替换描述中的占位符为实际计算值
  if (expectedValues.damage !== undefined) {
    calculatedDescription = calculatedDescription.replace(/造成.*?点伤害/, `造成${expectedValues.damage}点伤害`)
    calculatedDescription = calculatedDescription.replace(/造成相当于攻击力.*?%的伤害/, `造成${expectedValues.damage}点伤害（相当于攻击力${Math.round((expectedValues.damage / piece.attack) * 100)}%）`)
  }
  if (expectedValues.buff !== undefined) {
    calculatedDescription = calculatedDescription.replace(/提升自身攻击力.*?点/, `提升自身攻击力${expectedValues.buff}点`)
  }

  return {
    description: calculatedDescription,
    expectedValues,
    cooldown: skillDef.cooldownTurns,
    currentCooldown,
    chargeCost: skillDef.chargeCost
  }
}


