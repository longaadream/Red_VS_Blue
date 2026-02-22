import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"
import { globalTriggerSystem } from "./triggers"
import { statusEffectSystem, StatusEffect } from "./status-effects"

// 效果函数类型
type EffectFunction = (battle: BattleState, context: any) => { success: boolean; message?: string; blocked?: boolean }

// 规则定义类型
interface RuleDefinition {
  id: string
  name: string
  description: string
  trigger: {
    type: string
    conditions?: any
  }
  effect: any
  limits?: {
    cooldownTurns?: number
    maxUses?: number
  }
}

// 触发器规则类型
interface TriggerRule {
  id: string
  name: string
  description: string
  trigger: {
    type: string
    conditions?: any
  }
  effect: EffectFunction
  limits?: {
    cooldownTurns?: number
    maxUses?: number
  }
}

// 规则加载缓存：同一个规则文件在服务器生命周期内只读一次磁盘
// 每次复用时返回浅拷贝，保持 effect 函数引用一致
const ruleCache = new Map<string, TriggerRule>()

// 从文件中加载规则的函数（导出以便在需要时重新注入 effect 函数）
export function loadRuleById(ruleId: string): TriggerRule | null {
  // 命中缓存时直接返回浅拷贝（保留 effect 函数引用，避免重复读文件）
  const cached = ruleCache.get(ruleId)
  if (cached) {
    return { ...cached }
  }
  try {
    const fs = require('fs');
    const path = require('path');
    
    // 尝试使用process.cwd()来获取当前工作目录，确保路径正确
    const rulePath = path.join(process.cwd(), 'data', 'rules', `${ruleId}.json`);
    
    if (fs.existsSync(rulePath)) {
      console.log(`Loading rule from: ${rulePath}`);
      const ruleContent = fs.readFileSync(rulePath, 'utf8');
      const ruleData = JSON.parse(ruleContent);
      
      // 转换effect为函数
      let effectFunction: EffectFunction;
      
      if (ruleData.effect) {
        if (ruleData.effect.type === 'triggerSkill') {
          // 触发技能的效果
          effectFunction = (battle: BattleState, context: any) => {
            const skillId = ruleData.effect.skillId;
            if (skillId) {
              console.log(`Triggering skill: ${skillId} for rule: ${ruleId}`);
              // 直接从文件加载技能定义，使用process.cwd()确保路径正确
              const skillPath = path.join(process.cwd(), 'data', 'skills', `${skillId}.json`);
              if (fs.existsSync(skillPath)) {
                try {
                  const skillContent = fs.readFileSync(skillPath, 'utf8');
                  const skillDef = JSON.parse(skillContent);
                  
                  // 保存全局的dealDamage和healDamage函数，避免递归调用
                  const globalDealDamage = dealDamage;
                  const globalHealDamage = healDamage;
                  
                  // 构建技能执行上下文
                  const skillContext = {
                    piece: context.sourcePiece,
                    target: context.targetPiece,
                    targetPosition: null,
                    battle: {
                      turn: battle.turn.turnNumber,
                      currentPlayerId: battle.turn.currentPlayerId,
                      phase: battle.turn.phase
                    },
                    skill: {
                      id: skillId,
                      name: skillDef.name,
                      type: skillDef.type,
                      powerMultiplier: skillDef.powerMultiplier
                    },
                    damage: context.damage
                  };
                  
                  // 构建技能执行环境
                  const skillEnvironment = {
                    context: skillContext,
                    sourcePiece: context.sourcePiece,
                    battle: battle,
                    select: {
                      getAllEnemies: () => [],
                      getAllAllies: () => [],
                      getNearestEnemy: () => null,
                      getLowestHpEnemy: () => null,
                      getHighestAttackEnemy: () => null,
                      getLowestDefenseEnemy: () => null,
                      getLowestHpAlly: () => null,
                      getHighestAttackAlly: () => null,
                      getPieceAt: () => null,
                      getEnemiesInRange: () => [],
                      getAlliesInRange: () => []
                    },
                    selectTarget: () => null,
                    teleport: () => ({ success: false }),
                    dealDamage: (attacker, target, damage, type, battleState, skillId) => {
                      // 直接调用全局的dealDamage函数，确保使用正确的实现
                      return globalDealDamage(attacker, target, damage, type, battle, skillId);
                    },
                    healDamage: (healer, target, heal, battleState, skillId) => {
                      // 直接调用全局的healDamage函数，确保使用正确的实现
                      return globalHealDamage(healer, target, heal, battle, skillId);
                    },
                    statusEffectSystem: statusEffectSystem,
                    addStatusEffect: (targetPiece, statusEffect) => {
                      return statusEffectSystem.addStatusEffect(targetPiece.instanceId, statusEffect);
                    },
                    addStatusEffectById: (targetPieceId, statusObject) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece) {
                        if (!targetPiece.statusTags) {
                          targetPiece.statusTags = [];
                        }
                        const newStatus = {
                          id: statusObject.id,
                          type: statusObject.type,
                          currentDuration: statusObject.currentDuration,
                          currentUses: statusObject.currentUses,
                          intensity: statusObject.intensity,
                          stacks: statusObject.stacks,
                          value: statusObject.value,
                          relatedRules: []
                        };
                        targetPiece.statusTags.push(newStatus);
                        return true;
                      }
                      return false;
                    },
                    removeStatusEffectById: (targetPieceId, statusId) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece && targetPiece.statusTags) {
                        const statusTagIndex = targetPiece.statusTags.findIndex(tag => tag.id === statusId);
                        if (statusTagIndex !== -1) {
                          targetPiece.statusTags.splice(statusTagIndex, 1);
                          return true;
                        }
                      }
                      return false;
                    },
                    addRuleById: (targetPieceId, ruleId) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece) {
                        const rule = loadRuleById(ruleId);
                        if (rule) {
                          if (!targetPiece.rules) {
                            targetPiece.rules = [];
                          }
                          targetPiece.rules.push(rule);
                          return true;
                        }
                      }
                      return false;
                    },
                    removeRuleById: (targetPieceId, ruleId) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece && targetPiece.rules) {
                        targetPiece.rules = targetPiece.rules.filter(rule => rule.id !== ruleId);
                        return true;
                      }
                      return false;
                    },
                    getAllEnemiesInRange: (range) => [],
                    getAllAlliesInRange: (range) => [],
                    calculateDistance: (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2),
                    isTargetInRange: (target, range) => false,
                    Math: Math,
                    console: console
                  };
                  
                  // 构建技能执行代码
                  const fullSkillCode = `
                    (function(environment) {
                      const context = environment.context;
                      const sourcePiece = environment.sourcePiece;
                      const battle = environment.battle;
                      const select = environment.select;
                      const selectTarget = environment.selectTarget;
                      const teleport = environment.teleport;
                      const statusEffectSystem = environment.statusEffectSystem;
                      const addStatusEffect = environment.addStatusEffect;
                      const addStatusEffectById = environment.addStatusEffectById;
                      const getAllEnemiesInRange = environment.getAllEnemiesInRange;
                      const getAllAlliesInRange = environment.getAllAlliesInRange;
                      const calculateDistance = environment.calculateDistance;
                      const isTargetInRange = environment.isTargetInRange;
                      const dealDamage = environment.dealDamage;
                      const healDamage = environment.healDamage;
                      const addRuleById = environment.addRuleById;
                      const removeRuleById = environment.removeRuleById;
                      const removeStatusEffectById = environment.removeStatusEffectById;
                      const Math = environment.Math;
                      const console = environment.console;
                      
                      ${skillDef.code}
                      
                      return executeSkill(context);
                    })(skillEnvironment)
                  `;
                  
                  // 执行技能代码
                  const result = eval(fullSkillCode);
                  console.log(`Skill execution result:`, result);
                  return result;
                } catch (error) {
                  console.error('Error executing skill in rule effect:', error);
                  return { success: false, message: '技能执行失败' };
                }
              } else {
                console.error(`Skill file not found: ${skillPath}`);
              }
            }
            return { success: true, message: `${ruleData.name}触发` };
          };
        } else {
          // 默认效果函数
          effectFunction = (battle: BattleState, context: any) => {
            return { success: true, message: `${ruleData.name}触发` };
          };
        }
      } else {
        // 默认效果函数
        effectFunction = (battle: BattleState, context: any) => {
          return { success: true, message: `${ruleData.name}触发` };
        };
      }
      
      // 创建规则对象
      const rule: TriggerRule = {
        id: ruleData.id,
        name: ruleData.name,
        description: ruleData.description,
        trigger: ruleData.trigger,
        effect: effectFunction,
        limits: ruleData.limits
      };
      
      console.log(`Loaded rule successfully: ${ruleId}`);
      // 写入缓存，后续复用时无需再读文件
      ruleCache.set(ruleId, rule)
      return rule;
    } else {
      console.error(`Rule file not found: ${rulePath}`);
    }
    
    return null;
  } catch (error) {
    console.error('Error loading rule:', error);
    return null;
  }
};

export type SkillId = string

export type SkillKind = "active" | "passive"

export type SkillType = "normal" | "super" | "ultimate"

/**
 * 伤害类型
 */
export type DamageType = "physical" | "magical" | "true"



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
  targetPosition: {
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
  needsTargetSelection?: boolean
  targetType?: 'piece' | 'grid'
  range?: number
  filter?: 'enemy' | 'ally' | 'all'
}

/**
 * 技能形态类型
 */
export type SkillForm = "melee" | "ranged" | "magic" | "projectile" | "area" | "self"

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
  /** 技能形态：melee=近战, ranged=远程, magic=魔法, projectile=飞行物, area=范围, self=自身 */
  form?: SkillForm
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
  requiresTarget?: boolean
  /** 行动点消耗 */
  actionPointCost: number
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
  /** 剩余使用次数，限定技为1，其他技能为-1（无限制） */
  usesRemaining: number
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
function createEffectFunctions(battle: BattleState, sourcePiece: PieceInstance, target?: { x: number, y: number }, context?: SkillExecutionContext) {
  const selectors = createTargetSelectors(battle, sourcePiece);
  
  return {
    // 目标选择器
    select: selectors,
    
    // 目标选择函数 - 用于在技能代码中唤起目标选择
    selectTarget: (options?: {
      type: 'piece' | 'grid';
      range?: number;
      filter?: 'enemy' | 'ally' | 'all';
    }) => {
      const defaultOptions = {
        type: 'piece' as const,
        range: 5,
        filter: 'enemy' as const,
        ...options
      };
      
      // 检查是否已经有目标信息（用户已经选择了目标）
      // 使用context参数来获取目标信息
      if (defaultOptions.type === 'piece' && context && context.target) {
        // 检查目标是否符合filter要求
        const isAlly = context.target.ownerPlayerId === sourcePiece.ownerPlayerId;
        const isEnemy = !isAlly;
        
        // 根据filter参数检查目标是否符合要求
        if (defaultOptions.filter === 'ally' && !isAlly) {
          // 目标是敌方，但filter要求是友方，返回需要重新选择目标
          return {
            needsTargetSelection: true,
            targetType: defaultOptions.type,
            range: defaultOptions.range,
            filter: defaultOptions.filter
          };
        } else if (defaultOptions.filter === 'enemy' && !isEnemy) {
          // 目标是友方，但filter要求是敌方，返回需要重新选择目标
          return {
            needsTargetSelection: true,
            targetType: defaultOptions.type,
            range: defaultOptions.range,
            filter: defaultOptions.filter
          };
        }
        
        // 尝试从battle.pieces中查找原始目标实例
        const targetInstanceId = context.target.instanceId;
        console.log('=== selectTarget debug ===');
        console.log('Target instance ID from context:', targetInstanceId);
        console.log('Number of pieces in battle.pieces:', battle.pieces.length);
        console.log('Pieces in battle.pieces:', battle.pieces.map(p => ({ instanceId: p.instanceId, templateId: p.templateId })));
        console.log('Context target:', context.target);
        
        if (targetInstanceId) {
          // 遍历battle.pieces，确保找到正确的实例
          for (let i = 0; i < battle.pieces.length; i++) {
            const piece = battle.pieces[i];
            console.log(`Checking piece ${i}:`, piece.instanceId, 'vs target:', targetInstanceId);
            console.log(`Type comparison: ${typeof piece.instanceId} vs ${typeof targetInstanceId}`);
            console.log(`Strict equality: ${piece.instanceId === targetInstanceId}`);
            console.log(`Loose equality: ${piece.instanceId == targetInstanceId}`);
            
            if (piece.instanceId === targetInstanceId) {
              console.log('Found original target piece by direct comparison:', piece);
              // 返回原始实例，这样修改会影响到battle.pieces中的对象
              console.log('Returning original target piece');
              return piece;
            }
          }
        }
        
        // 如果通过instanceId找不到，尝试通过位置查找
        if (context.target.x !== undefined && context.target.y !== undefined) {
          console.log('Attempting to find target by position:', context.target.x, context.target.y);
          const targetByPosition = battle.pieces.find(p => {
            const match = p.x === context.target.x && p.y === context.target.y;
            console.log(`Checking piece at ${p.x},${p.y}: ${match}`);
            return match;
          });
          if (targetByPosition) {
            console.log('Found target piece by position:', targetByPosition);
            return targetByPosition;
          }
        }
        
        // 如果仍然找不到，尝试创建一个新的目标实例并添加到battle.pieces中
        // 这是一个极端的备用方案，确保我们总是能修改一个会被保存的实例
        console.warn('Creating new target piece instance as last resort');
        const newTargetPiece = {
          instanceId: targetInstanceId || `temp_${Date.now()}`,
          templateId: context.target.templateId,
          name: context.target.name || context.target.templateId,
          ownerPlayerId: context.target.ownerPlayerId,
          faction: context.target.faction || 'neutral',
          currentHp: context.target.currentHp,
          maxHp: context.target.maxHp,
          attack: context.target.attack,
          defense: context.target.defense,
          x: context.target.x || 0,
          y: context.target.y || 0,
          moveRange: context.target.moveRange || 1,
          skills: context.target.skills || [],
          buffs: context.target.buffs || [],
          debuffs: context.target.debuffs || [],
          ruleTags: context.target.ruleTags || [],
          statusTags: context.target.statusTags || [],
          rules: context.target.rules || []
        };
        
        // 将新创建的目标实例添加到battle.pieces中
        battle.pieces.push(newTargetPiece);
        console.log('Added new target piece to battle.pieces:', newTargetPiece);
        
        return newTargetPiece;
      } else if (defaultOptions.type === 'grid' && context) {
        // 如果需要选择格子，检查context中的目标信息
        if (context.targetPosition) {
          // 如果有targetPosition，使用它
          return context.targetPosition;
        } else if (context.target && context.target.x !== undefined && context.target.y !== undefined) {
          // 如果只有target，使用其位置
          return {
            x: context.target.x,
            y: context.target.y
          };
        }
      }
      
      // 没有目标信息，返回需要目标选择的结果
      // 这会触发前端显示目标选择界面
      return {
        needsTargetSelection: true,
        targetType: defaultOptions.type,
        range: defaultOptions.range,
        filter: defaultOptions.filter
      };
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
    },
    
    // 造成伤害
    dealDamage: (attacker: PieceInstance, targetPiece: PieceInstance, baseDamage: number, damageType: DamageType = "physical", battleState?: BattleState, skillId?: string) => {
      // 忽略传入的 battleState，使用闭包中的 battle，确保修改的是正确的实例
      return dealDamage(attacker, targetPiece, baseDamage, damageType, battle, skillId);
    },
    
    // 治疗
    healDamage: (healer: PieceInstance, targetPiece: PieceInstance, baseHeal: number, battleState?: BattleState, skillId?: string) => {
      // 忽略传入的 battleState，使用闭包中的 battle，确保修改的是正确的实例
      return healDamage(healer, targetPiece, baseHeal, battle, skillId);
    }
  };
}

/**
 * 处理伤害计算和应用的函数
 * @param attacker 攻击者棋子
 * @param target 目标棋子
 * @param baseDamage 基础伤害值
 * @param damageType 伤害类型
 * @param battle 战斗状态
 * @param skillId 技能ID（可选）
 * @returns 伤害结果
 */
export function dealDamage(attacker: PieceInstance, target: PieceInstance, baseDamage: number, damageType: DamageType, battle: BattleState, skillId?: string) {
  // 触发即将造成伤害前的触发器
  const beforeDamageDealtResult = globalTriggerSystem.checkTriggers(battle, {
    type: "beforeDamageDealt",
    sourcePiece: attacker,
    targetPiece: target,
    damage: baseDamage,
    skillId
  });
  
  // 检查是否有规则阻止了伤害
  if (beforeDamageDealtResult.blocked) {
    // 记录阻止信息到战斗日志
    const attackerName = attacker.name || attacker.templateId;
    const targetName = target.name || target.templateId;
    
    if (!battle.actions) {
      battle.actions = [];
    }
    
    battle.actions.push({
      type: "triggerEffect",
      playerId: attacker.ownerPlayerId,
      turn: battle.turn.turnNumber,
      payload: {
        message: `${attackerName}的攻击被规则阻止`
      }
    });
    
    return {
      success: false,
      damage: 0,
      isKilled: false,
      targetHp: target.currentHp,
      message: "攻击被规则阻止"
    };
  }
  
  // 触发即将受到伤害前的触发器
  const beforeDamageTakenResult = globalTriggerSystem.checkTriggers(battle, {
    type: "beforeDamageTaken",
    sourcePiece: target,
    targetPiece: attacker,
    damage: baseDamage,
    skillId
  });
  
  // 检查是否有规则阻止了伤害
  if (beforeDamageTakenResult.blocked) {
    const targetName = target.name || target.templateId;

    if (!battle.actions) battle.actions = [];
    battle.actions.push({
      type: "triggerEffect",
      playerId: attacker.ownerPlayerId,
      turn: battle.turn.turnNumber,
      payload: { message: `${targetName}受到的伤害被规则阻止` }
    });

    // 触发格挡后事件（死亡者视角：target 是被保护的棋子）
    globalTriggerSystem.checkTriggers(battle, {
      type: "afterDamageBlocked",
      sourcePiece: target,
      targetPiece: attacker,
      damage: baseDamage,
      skillId
    });

    return {
      success: false,
      damage: 0,
      isKilled: false,
      targetHp: target.currentHp,
      message: "伤害被规则阻止"
    };
  }
  
  // 计算最终伤害（考虑防御力）
  let finalDamage: number;
  
  // 确保baseDamage和target.defense都是有效的数字
  const validBaseDamage = Number(baseDamage) || 0;
  const validDefense = Number(target.defense) || 0;
  
  switch (damageType) {
    case "physical":
      // 物理伤害：受到防御力影响
      finalDamage = Math.max(1, Math.round(validBaseDamage - validDefense)); // 至少造成1点伤害
      break;
    case "magical":
      // 法术伤害：受到魔法抗性影响（暂时使用防御力代替）
      finalDamage = Math.max(1, Math.round(validBaseDamage - validDefense)); // 至少造成1点伤害
      break;
    case "true":
      // 真实伤害：不受防御力影响
      finalDamage = Math.max(1, Math.round(validBaseDamage)); // 至少造成1点伤害
      break;
   }
  
  // 记录原始生命值
  const originalHp = target.currentHp;
  
  // 应用伤害
  target.currentHp = Math.max(0, target.currentHp - finalDamage);
  
  // 触发伤害相关的触发器
  // 1. 攻击者的伤害触发
  globalTriggerSystem.checkTriggers(battle, {
    type: "afterDamageDealt",
    sourcePiece: attacker,
    targetPiece: target,
    damage: finalDamage,
    skillId
  });
  
  // 2. 目标的伤害触发
  globalTriggerSystem.checkTriggers(battle, {
    type: "afterDamageTaken",
    sourcePiece: target,
    targetPiece: attacker,
    damage: finalDamage,
    skillId
  });
  
  // 检查是否击杀了目标
  let isKilled = false;
  if (originalHp > 0 && target.currentHp === 0) {
    isKilled = true;
    
    // 触发即将击杀的触发器
    globalTriggerSystem.checkTriggers(battle, {
      type: "beforePieceKilled",
      sourcePiece: target,
      targetPiece: attacker,
      skillId
    });
    
    // 触发击杀相关的触发器（击杀者视角）
    globalTriggerSystem.checkTriggers(battle, {
      type: "afterPieceKilled",
      sourcePiece: attacker,
      targetPiece: target,
      skillId
    });

    // 触发死亡事件（死亡棋子自身视角，用于"我死亡时做X"效果）
    // 在移出棋盘前触发，此时棋子仍在 battle.pieces 中
    globalTriggerSystem.checkTriggers(battle, {
      type: "onPieceDied",
      sourcePiece: target,
      targetPiece: attacker,
      damage: finalDamage,
      skillId
    });

    // 击杀敌人后，为击杀者添加充能点
    const playerMeta = battle.players.find(p => p.playerId === attacker.ownerPlayerId);
    if (playerMeta) {
      playerMeta.chargePoints += 1; // 每次击杀获得1点充能
      // 触发充能获得事件（可用于"获得充能时做X"效果）
      globalTriggerSystem.checkTriggers(battle, {
        type: "afterChargeGained",
        sourcePiece: attacker,
        amount: 1,
        playerId: attacker.ownerPlayerId
      });
    }

    // 从棋盘上移除死亡的棋子，并将其移到墓地中
    const targetIndex = battle.pieces.findIndex(p => p.instanceId === target.instanceId);
    if (targetIndex !== -1) {
      // 确保墓地数组存在
      if (!battle.graveyard) {
        battle.graveyard = [];
      }
      
      // 将死亡的棋子移到墓地中
      const killedPiece = battle.pieces.splice(targetIndex, 1)[0];
      battle.graveyard.push(killedPiece);
      console.log(`Moved killed piece ${target.instanceId} to graveyard`);
    }
  }
  
  // 尝试获取攻击者和目标的名字
  const attackerName = attacker.name || attacker.templateId;
  const targetName = target.name || target.templateId;
  
  return {
    success: true,
    damage: finalDamage,
    isKilled,
    targetHp: target.currentHp,
    message: `${attackerName}对${targetName}造成${finalDamage}点${damageType === 'physical' ? '物理' : damageType === 'magical' ? '魔法' : '真实'}伤害${isKilled ? '，击杀敌人获得1点充能' : ''}`
  };
}

/**
 * 处理治疗计算和应用的函数
 * @param healer 治疗者棋子
 * @param target 目标棋子
 * @param baseHeal 基础治疗值
 * @param battle 战斗状态
 * @param skillId 技能ID（可选）
 * @returns 治疗结果
 */
export function healDamage(healer: PieceInstance, target: PieceInstance, baseHeal: number, battle: BattleState, skillId?: string) {
  // 触发即将造成治疗前的触发器
  const beforeHealDealtResult = globalTriggerSystem.checkTriggers(battle, {
    type: "beforeHealDealt",
    sourcePiece: healer,
    targetPiece: target,
    heal: baseHeal,
    skillId
  });
  
  // 检查是否有规则阻止了治疗
  if (beforeHealDealtResult.blocked) {
    // 记录阻止信息到战斗日志
    const healerName = healer.name || healer.templateId;
    const targetName = target.name || target.templateId;
    
    if (!battle.actions) {
      battle.actions = [];
    }
    
    battle.actions.push({
      type: "triggerEffect",
      playerId: healer.ownerPlayerId,
      turn: battle.turn.turnNumber,
      payload: {
        message: `${healerName}的治疗被规则阻止`
      }
    });
    
    return {
      success: false,
      heal: 0,
      targetHp: target.currentHp,
      message: "治疗被规则阻止"
    };
  }
  
  // 触发即将受到治疗前的触发器
  const beforeHealTakenResult = globalTriggerSystem.checkTriggers(battle, {
    type: "beforeHealTaken",
    sourcePiece: target,
    targetPiece: healer,
    heal: baseHeal,
    skillId
  });
  
  // 检查是否有规则阻止了治疗
  if (beforeHealTakenResult.blocked) {
    const targetName = target.name || target.templateId;

    if (!battle.actions) battle.actions = [];
    battle.actions.push({
      type: "triggerEffect",
      playerId: healer.ownerPlayerId,
      turn: battle.turn.turnNumber,
      payload: { message: `${targetName}受到的治疗被规则阻止` }
    });

    // 触发治疗格挡后事件
    globalTriggerSystem.checkTriggers(battle, {
      type: "afterHealBlocked",
      sourcePiece: target,
      targetPiece: healer,
      heal: baseHeal,
      skillId
    });

    return {
      success: false,
      heal: 0,
      targetHp: target.currentHp,
      message: "治疗被规则阻止"
    };
  }
  
  // 计算最终治疗值
  const finalHeal = Math.max(0, Math.round(baseHeal));
  
  // 记录原始生命值
  const originalHp = target.currentHp;
  
  // 应用治疗
  target.currentHp = Math.min(target.maxHp, target.currentHp + finalHeal);
  
  // 计算实际治疗量
  const actualHeal = target.currentHp - originalHp;
  
  // 触发治疗相关的触发器
  globalTriggerSystem.checkTriggers(battle, {
    type: "afterHealDealt",
    sourcePiece: healer,
    targetPiece: target,
    heal: actualHeal,
    skillId
  });
  
  globalTriggerSystem.checkTriggers(battle, {
    type: "afterHealTaken",
    sourcePiece: target,
    targetPiece: healer,
    heal: actualHeal,
    skillId
  });
  
  // 尝试获取治疗者和目标的名字
  const healerName = healer.name || healer.templateId;
  const targetName = target.name || target.templateId;
  
  return {
    success: true,
    heal: actualHeal,
    targetHp: target.currentHp,
    message: `${healerName}为${targetName}回复${actualHeal}点生命值`
  };
}

// 执行技能函数
export function executeSkillFunction(skillDef: SkillDefinition, context: SkillExecutionContext, battle: BattleState): SkillExecutionResult {
  try {
    console.log('=== executeSkillFunction called ===');
    console.log('Skill ID:', skillDef.id);
    console.log('Context piece instanceId:', context.piece.instanceId);
    console.log('Battle pieces count:', battle.pieces.length);
    console.log('Context target:', context.target);
    
    // 找到源棋子
    const pieceIndex = battle.pieces.findIndex(p => p.instanceId === context.piece.instanceId);
    console.log('Piece index in battle.pieces:', pieceIndex);
    
    if (pieceIndex === -1) {
      throw new Error('Source piece not found')
    }
    
    // 直接使用battle.pieces中的元素，确保是直接引用
    const sourcePiece = battle.pieces[pieceIndex];
    console.log('Found source piece:', sourcePiece);
    
    console.log('Source piece before skill:', {
      instanceId: sourcePiece.instanceId,
      attack: sourcePiece.attack,
      maxHp: sourcePiece.maxHp,
      currentHp: sourcePiece.currentHp
    });

    // 创建效果函数
    const effects = createEffectFunctions(battle, sourcePiece, undefined, context)

    // 创建技能执行环境，包含辅助函数和效果函数
    const skillEnvironment = {
      // 上下文
      context,
      // 源棋子（直接引用，可读写）
      sourcePiece,
      battle,
      
      // 目标选择器
      select: effects.select,
      selectTarget: effects.selectTarget,
      
      // 效果函数
    teleport: effects.teleport,
    dealDamage: effects.dealDamage,
    healDamage: effects.healDamage,
    
    // 状态效果函数
    statusEffectSystem: statusEffectSystem,
    addStatusEffect: (targetPiece: PieceInstance, statusEffect: StatusEffect) => {
      return statusEffectSystem.addStatusEffect(targetPiece.instanceId, statusEffect);
    },
    addStatusEffectById: (targetPieceId: string, statusObject: any) => {
      // 找到目标棋子
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
      if (targetPiece) {
        // 确保statusTags数组存在
        if (!targetPiece.statusTags) {
          targetPiece.statusTags = [];
        }
        
        // 创建状态对象
        const newStatus = {
          id: statusObject.id,
          type: statusObject.type,
          currentDuration: statusObject.currentDuration,
          currentUses: statusObject.currentUses,
          intensity: statusObject.intensity,
          stacks: statusObject.stacks,
          value: statusObject.value, // 添加数值属性值
          relatedRules: [] // 添加关联规则数组
        };
        
        // 添加到状态标签数组
        targetPiece.statusTags.push(newStatus);
        // 触发状态施加后事件
        globalTriggerSystem.checkTriggers(battle, {
          type: "afterStatusApplied",
          sourcePiece: targetPiece,
          statusId: statusObject.id,
          playerId: targetPiece.ownerPlayerId
        });
        return true;
      }
      return false;
    },
    removeStatusEffectById: (targetPieceId: string, statusId: string) => {
      // 找到目标棋子
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
      if (targetPiece && targetPiece.statusTags) {
        // 找到要移除的状态标签
        const statusTagIndex = targetPiece.statusTags.findIndex(tag => tag.id === statusId);
        if (statusTagIndex === -1) {
          return false;
        }
        
        const statusTag = targetPiece.statusTags[statusTagIndex];
        
        // 检查并清理相关规则
        if (statusTag.relatedRules && statusTag.relatedRules.length > 0) {
          statusTag.relatedRules.forEach(ruleId => {
            // 检查是否有其他状态标签关联此规则
            let hasOtherRelatedStatus = false;
            
            targetPiece.statusTags.forEach(otherStatusTag => {
              if (otherStatusTag.id !== statusId && 
                  otherStatusTag.relatedRules && 
                  otherStatusTag.relatedRules.includes(ruleId)) {
                hasOtherRelatedStatus = true;
              }
            });
            
            // 如果没有其他状态标签关联此规则，移除规则
            if (!hasOtherRelatedStatus && targetPiece.rules) {
              const ruleIndex = targetPiece.rules.findIndex(rule => rule.id === ruleId);
              if (ruleIndex !== -1) {
                console.log(`Removing rule ${ruleId} because no other status tags are related to it`);
                targetPiece.rules.splice(ruleIndex, 1);
              }
            }
          });
        }
        
        // 从状态标签数组中移除指定状态
        targetPiece.statusTags.splice(statusTagIndex, 1);
        // 触发状态移除后事件
        globalTriggerSystem.checkTriggers(battle, {
          type: "afterStatusRemoved",
          sourcePiece: targetPiece,
          statusId: statusId,
          playerId: targetPiece.ownerPlayerId
        });
        return true;
      }
      return false;
    },
    // 规则管理函数
    addRuleById: (targetPieceId: string, ruleId: string) => {
      // 找到目标棋子
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
      if (targetPiece) {
        // 从文件中加载规则
        const rule = loadRuleById(ruleId);
        if (rule) {
          // 创建规则对象的副本并添加关联状态标签数组
          const newRule = {
            ...rule,
            relatedStatusTags: [] // 添加关联状态标签数组
          };
          
          // 找到相关的状态标签并建立关联
          if (targetPiece.statusTags) {
            targetPiece.statusTags.forEach(statusTag => {
              // 根据规则ID和状态类型判断关联关系
              if (ruleId.includes(statusTag.type) || statusTag.id.includes(ruleId)) {
                // 添加关联关系
                newRule.relatedStatusTags.push(statusTag.id);
                if (!statusTag.relatedRules) {
                  statusTag.relatedRules = [];
                }
                statusTag.relatedRules.push(ruleId);
              }
            });
          }
          
          // 添加到棋子的规则列表
          if (!targetPiece.rules) {
            targetPiece.rules = [];
          }
          targetPiece.rules.push(newRule);
          return true;
        }
      }
      return false;
    },
    removeRuleById: (targetPieceId: string, ruleId: string) => {
      // 找到目标棋子
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
      if (targetPiece && targetPiece.rules) {
        // 从棋子的规则列表中移除
        targetPiece.rules = targetPiece.rules.filter(rule => rule.id !== ruleId);
        return true;
      }
      return false;
    },
    // 技能管理函数
    addSkillById: (targetPieceId: string, skillId: string) => {
      // 找到目标棋子
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
      if (targetPiece) {
        // 确保skills数组存在
        if (!targetPiece.skills) {
          targetPiece.skills = [];
        }
        // 检查技能是否已经存在
        const existingSkill = targetPiece.skills.find(skill => skill.skillId === skillId);
        if (!existingSkill) {
          // 创建新技能对象
          const newSkill = {
            skillId: skillId,
            currentCooldown: 0
          };
          // 添加到棋子的技能列表
          targetPiece.skills.push(newSkill);
          return true;
        }
      }
      return false;
    },
    removeSkillById: (targetPieceId: string, skillId: string) => {
      // 找到目标棋子
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
      if (targetPiece && targetPiece.skills) {
        // 从棋子的技能列表中移除
        const originalLength = targetPiece.skills.length;
        targetPiece.skills = targetPiece.skills.filter(skill => skill.skillId !== skillId);
        return targetPiece.skills.length < originalLength;
      }
      return false;
    },
    // 状态效果添加函数已移除，现在使用addStatusEffectById函数添加状态效果
    // 所有状态效果都通过JSON文件定义，不再使用硬编码的预定义状态效果
    
    
    // 辅助函数
    getAllEnemiesInRange: (range: number) => getAllEnemiesInRange(context, range, battle),
    getAllAlliesInRange: (range: number) => getAllAlliesInRange(context, range, battle),
    calculateDistance,
    isTargetInRange: (target: any, range: number) => isTargetInRange(context, target, range),
    
    // 工具函数
    Math,
    console
    }

    // 记录技能执行前的状态
    const beforeState = {
      enemies: battle.pieces.filter(p => p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0).map(p => ({ instanceId: p.instanceId, currentHp: p.currentHp }))
    };

    // 尝试执行技能定义中的代码
    if (skillDef.code) {
      try {
        // 直接执行技能代码，不使用eval，而是手动解析和执行
        console.log('Executing skill code directly');
        
        // 手动执行buff-attack技能的逻辑
        if (skillDef.id === 'buff-attack') {
          // 直接修改sourcePiece的攻击力
          sourcePiece.attack = sourcePiece.attack + 1;
          console.log('Directly modified sourcePiece.attack to:', sourcePiece.attack);
          
          // 显式更新battle.pieces中的对应元素
          battle.pieces[pieceIndex] = sourcePiece;
          console.log('Updated battle.pieces[' + pieceIndex + '].attack to:', battle.pieces[pieceIndex].attack);
          
          const result = {
            message: sourcePiece.templateId + '的攻击力提升至' + sourcePiece.attack + '点',
            success: true
          };
          
          console.log('Source piece after skill:', {
            instanceId: sourcePiece.instanceId,
            attack: sourcePiece.attack,
            maxHp: sourcePiece.maxHp,
            currentHp: sourcePiece.currentHp
          });

          // 触发技能使用后的规则
          const skillUsedResult = globalTriggerSystem.checkTriggers(battle, {
            type: "afterSkillUsed",
            sourcePiece,
            skillId: skillDef.id
          });

          // 处理触发效果的消息
          if (skillUsedResult.success && skillUsedResult.messages.length > 0) {
            result.message += "。" + skillUsedResult.messages.join("。");
          }
          
          return result;
        } else {
          // 对于其他技能，使用eval执行
          const fullSkillCode = `
            (function(environment) {
              // 定义全局变量
              const context = environment.context;
              const sourcePiece = environment.sourcePiece;
              const battle = environment.battle;
              const select = environment.select;
              const selectTarget = environment.selectTarget;
              const teleport = environment.teleport;
              const statusEffectSystem = environment.statusEffectSystem;
              const addStatusEffect = environment.addStatusEffect;
              const addStatusEffectById = environment.addStatusEffectById;
              const getAllEnemiesInRange = environment.getAllEnemiesInRange;
              const getAllAlliesInRange = environment.getAllAlliesInRange;
              const calculateDistance = environment.calculateDistance;
              const isTargetInRange = environment.isTargetInRange;
              const dealDamage = environment.dealDamage;
              const healDamage = environment.healDamage;
              const addRuleById = environment.addRuleById;
              const removeRuleById = environment.removeRuleById;
              const removeStatusEffectById = environment.removeStatusEffectById;
              const addSkillById = environment.addSkillById;
              const removeSkillById = environment.removeSkillById;
              const Math = environment.Math;
              const console = environment.console;
              
              // 定义技能执行函数
              ${skillDef.code}
              
              // 执行技能
              return executeSkill(context);
            })(skillEnvironment)
          `;

          // 执行技能代码
          let result = eval(fullSkillCode);
          
          console.log('Skill execution result:', result);
          
          // 检查是否需要目标选择
          if (result && result.needsTargetSelection) {
            console.log('Need target selection:', result);
            // 直接返回需要目标选择的结果
            // 目标选择完全由selectTarget函数控制
            // 当用户选择目标后，前端会重新发送请求，selectTarget函数会处理目标信息
            return {
              message: '需要选择目标',
              success: false,
              needsTargetSelection: true,
              targetType: result.targetType || 'piece',
              range: result.range || 5,
              filter: result.filter || 'enemy'
            };
          }
          
          console.log('Source piece after skill:', {
            instanceId: sourcePiece.instanceId,
            attack: sourcePiece.attack,
            maxHp: sourcePiece.maxHp,
            currentHp: sourcePiece.currentHp
          });
          
          // 显式更新battle.pieces中的对应元素，确保修改能够正确反映到battle状态中
          battle.pieces[pieceIndex] = sourcePiece;
          console.log('Updated battle.pieces[' + pieceIndex + ']:', battle.pieces[pieceIndex]);

          // 检查是否有伤害和击杀
          checkForDamageAndKill(battle, beforeState, sourcePiece, skillDef.id);

          // 触发技能使用后的规则
          const skillUsedResult = globalTriggerSystem.checkTriggers(battle, {
            type: "afterSkillUsed",
            sourcePiece,
            skillId: skillDef.id
          });

          // 处理触发效果的消息
          if (skillUsedResult.success && skillUsedResult.messages.length > 0) {
            result.message += "。" + skillUsedResult.messages.join("。");
          }
          
          return result;
        }
      } catch (error) {
        console.error('Error executing skill code:', error);
        // 执行失败时，直接报错，不使用默认技能
        throw new Error('技能执行失败: ' + (error instanceof Error ? error.message : '未知错误'));
      }
    }

    // 没有默认技能逻辑，技能必须有有效的代码
    throw new Error('技能没有有效的执行代码');
    
  } catch (error) {
    console.error('Error executing skill:', error)
    throw error;
  }
}

// 检查技能执行后是否造成伤害或击杀
function checkForDamageAndKill(battle: BattleState, beforeState: any, sourcePiece: PieceInstance, skillId: string) {
  // 检查每个敌人的状态变化
  for (const beforeEnemy of beforeState.enemies) {
    const afterEnemy = battle.pieces.find(p => p.instanceId === beforeEnemy.instanceId);
    if (afterEnemy && afterEnemy.currentHp < beforeEnemy.currentHp) {
      // 造成了伤害
      const damage = beforeEnemy.currentHp - afterEnemy.currentHp;
      
      // 触发伤害规则
      globalTriggerSystem.checkTriggers(battle, {
        type: "afterDamageDealt",
        sourcePiece,
        targetPiece: afterEnemy,
        damage,
        skillId
      });

      // 检查是否击杀
      if (afterEnemy.currentHp === 0 && beforeEnemy.currentHp > 0) {
        // 触发击杀规则
        globalTriggerSystem.checkTriggers(battle, {
          type: "afterPieceKilled",
          sourcePiece,
          targetPiece: afterEnemy,
          skillId
        });
      }
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
    expectedValues.buff = 1 // 固定值
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
