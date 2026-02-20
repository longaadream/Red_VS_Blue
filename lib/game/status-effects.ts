// 状态系统核心文件

import { globalTriggerSystem } from "./triggers";

// 状态类型
export enum StatusEffectType {
  BLEEDING = "bleeding",      // 流血
  POISON = "poison",          // 中毒
  BURN = "burn",              // 燃烧
  FREEZE = "freeze",          // 冰冻
  STUN = "stun",              // 眩晕
  BUFF_ATTACK = "buff_attack", // 攻击增益
  BUFF_DEFENSE = "buff_defense", // 防御增益
  DEBUFF_ATTACK = "debuff_attack", // 攻击减益
  DEBUFF_DEFENSE = "debuff_defense", // 防御减益
  INVULNERABLE = "invulnerable", // 无敌
  REGENERATION = "regeneration" // 生命恢复
}

// 状态效果接口
export interface StatusEffect {
  id: string;                 // 状态唯一ID
  type: StatusEffectType | string;     // 状态类型
  name: string;               // 状态名称
  description: string;        // 状态描述
  remainingDuration: number;  // 剩余持续时间
  intensity: number;          // 强度（用于计算效果数值）
  isDebuff: boolean;          // 是否为减益效果
  canStack: boolean;          // 是否可以叠加
  maxStacks: number;          // 最大叠加层数
  currentStacks: number;       // 当前叠加层数
  code?: string;              // 状态效果代码（字符串形式存储）
  sourcePieceId?: string;     // 来源棋子ID
  ruleId?: string;            // 对应的规则ID
}

// 状态效果定义接口（用于JSON文件）
export interface StatusEffectDefinition {
  id: string;                 // 状态唯一ID
  type: StatusEffectType | string;     // 状态类型
  name: string;               // 状态名称
  description: string;        // 状态描述
  intensity: number;          // 强度（用于计算效果数值）
  isDebuff: boolean;          // 是否为减益效果
  canStack: boolean;          // 是否可以叠加
  maxStacks: number;          // 最大叠加层数
  code: string;               // 状态效果代码（字符串形式存储）
}

// 状态效果上下文
export interface StatusEffectContext {
  piece: any;  // 棋子实例
  battleState: any;  // 战斗状态
  statusEffect: StatusEffect;  // 当前状态效果
  gameContext: any;  // 游戏上下文
}

// 棋子状态数据接口
export interface PieceStatusData {
  [statusId: string]: {
    remainingDuration: number;
    currentStacks: number;
    intensity: number;
  };
}

// 扩展棋子实例接口
declare global {
  interface PieceInstance {
    statusData?: PieceStatusData;
  }
}

// 状态系统类
export class StatusEffectSystem {
  private statusEffects: Map<string, StatusEffect[]> = new Map();  // 棋子ID -> 状态效果列表
  private statusDefinitions: Map<string, StatusEffectDefinition> = new Map();  // 状态定义缓存

  // 从JSON文件加载状态定义
  loadStatusDefinitionFromFile(filePath: string): StatusEffectDefinition | null {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(filePath, 'utf8');
      const definition = JSON.parse(content) as StatusEffectDefinition;
      this.statusDefinitions.set(definition.id, definition);
      return definition;
    } catch (error) {
      console.error('Error loading status definition from file:', error);
      return null;
    }
  }

  // 从ID获取状态定义
  getStatusDefinition(id: string): StatusEffectDefinition | null {
    return this.statusDefinitions.get(id) || null;
  }

  // 添加状态效果到棋子
  addStatusEffect(pieceId: string, effect: StatusEffect): StatusEffect {
    const piece = this.getPieceById(pieceId);
    if (!piece) {
      console.error(`Piece not found: ${pieceId}`);
      return effect;
    }

    // 初始化棋子的状态数据
    if (!piece.statusData) {
      piece.statusData = {};
    }

    // 检查是否可以叠加
    if (effect.canStack) {
      const existingEffect = this.statusEffects.get(pieceId)?.find(e => e.type === effect.type);
      if (existingEffect) {
        // 叠加效果
        existingEffect.currentStacks = Math.min(existingEffect.currentStacks + 1, existingEffect.maxStacks);
        existingEffect.remainingDuration = effect.remainingDuration;
        
        // 更新棋子状态数据
        if (piece.statusData[existingEffect.id]) {
          piece.statusData[existingEffect.id].remainingDuration = effect.remainingDuration;
          piece.statusData[existingEffect.id].currentStacks = existingEffect.currentStacks;
        }
        
        return existingEffect;
      }
    }

    // 创建新状态效果
    const newEffect = {
      ...effect,
      id: `${effect.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      currentStacks: 1
    };

    // 存储状态效果
    if (!this.statusEffects.has(pieceId)) {
      this.statusEffects.set(pieceId, []);
    }
    this.statusEffects.get(pieceId)!.push(newEffect);

    // 存储状态数据到棋子实例
    piece.statusData[newEffect.id] = {
      remainingDuration: effect.remainingDuration,
      currentStacks: 1,
      intensity: effect.intensity
    };

    // 将状态标签添加到棋子的statusTags数组中
    if (!piece.statusTags) {
      piece.statusTags = [];
    }
    // 添加状态类型标签
    const statusTypeTag = `${effect.type}`;
    if (!piece.statusTags.includes(statusTypeTag)) {
      piece.statusTags.push(statusTypeTag);
    }
    // 添加状态持续时间标签
    const statusDurationTag = `${effect.type}-duration-${effect.id}`;
    piece.statusTags.push(statusDurationTag);

    // 创建并添加规则
    const ruleId = this.createStatusRule(pieceId, newEffect);
    newEffect.ruleId = ruleId;

    console.log(`Added status effect ${newEffect.name} to piece ${piece.templateId}`);
    return newEffect;
  }

  // 添加状态效果通过ID
  addStatusEffectById(pieceId: string, statusId: string): StatusEffect | null {
    const definition = this.getStatusDefinition(statusId);
    if (!definition) {
      console.error(`Status effect definition not found: ${statusId}`);
      return null;
    }

    // 创建状态效果，默认持续时间为3回合
    const defaultDuration = 3;
    const effect: StatusEffect = {
      id: '',
      type: definition.type,
      name: definition.name,
      description: definition.description,
      remainingDuration: defaultDuration,
      intensity: definition.intensity,
      isDebuff: definition.isDebuff,
      canStack: definition.canStack,
      maxStacks: definition.maxStacks,
      currentStacks: 1,
      code: definition.code
    };

    return this.addStatusEffect(pieceId, effect);
  }

  // 创建状态效果对应的规则
  private createStatusRule(pieceId: string, effect: StatusEffect): string {
    const ruleId = `status-rule-${effect.id}`;
    
    // 创建规则
    const rule = {
      id: ruleId,
      name: `${effect.name}规则`,
      description: `${effect.description}的触发规则`,
      trigger: {
        type: "beginTurn" // 回合开始时触发
      },
      effect: (battle, context) => {
        const piece = this.getPieceById(pieceId);
        if (!piece || !piece.statusData || !piece.statusData[effect.id]) {
          // 从棋子的ruleTags中移除规则ID
          if (piece && piece.ruleTags) {
            piece.ruleTags = piece.ruleTags.filter(tag => tag !== ruleId);
          }
          // 移除规则
          globalTriggerSystem.removeRule(ruleId);
          return { success: false };
        }

        const statusData = piece.statusData[effect.id];
        
        // 检查持续时间
        if (statusData.remainingDuration > 0) {
          // 执行状态效果代码
          if (effect.code) {
            const context = {
              piece,
              battleState: battle,
              statusEffect: {
                ...effect,
                remainingDuration: statusData.remainingDuration,
                currentStacks: statusData.currentStacks,
                intensity: statusData.intensity
              },
              gameContext: null
            };

            // 执行代码
            try {
              const code = `
                (function() {
                  ${effect.code}
                  return typeof EffectTrigger === 'function' ? EffectTrigger(context) : { success: false };
                })()
              `;
              
              const result = eval(code);
              console.log(`Status effect ${effect.name} executed:`, result);
            } catch (error) {
              console.error(`Error executing status effect code for ${effect.name}:`, error);
            }
          }

          // 减少持续时间
          statusData.remainingDuration--;
          effect.remainingDuration--;
        }

        // 检查是否结束
        if (statusData.remainingDuration <= 0) {
          // 移除状态效果
          this.removeStatusEffect(pieceId, effect.id);
          // 从棋子的ruleTags中移除规则ID
          if (piece.ruleTags) {
            piece.ruleTags = piece.ruleTags.filter(tag => tag !== ruleId);
          }
          // 移除规则
          globalTriggerSystem.removeRule(ruleId);
          console.log(`Status effect ${effect.name} expired on piece ${piece.templateId}`);
        }

        return { success: true, message: `${piece.templateId}的${effect.name}效果触发` };
      }
    };

    // 添加规则到触发系统
    globalTriggerSystem.addRule(rule);
    
    // 将规则ID添加到棋子的ruleTags数组中
    const piece = this.getPieceById(pieceId);
    if (piece) {
      if (!piece.ruleTags) {
        piece.ruleTags = [];
      }
      piece.ruleTags.push(ruleId);
    }
    
    console.log(`Created rule ${ruleId} for status effect ${effect.name}`);
    return ruleId;
  }

  // 移除状态效果
  removeStatusEffect(pieceId: string, effectId: string): boolean {
    const effects = this.statusEffects.get(pieceId);
    if (!effects) return false;

    const index = effects.findIndex(e => e.id === effectId);
    if (index === -1) return false;

    const effect = effects[index];
    
    // 移除对应的规则
    if (effect.ruleId) {
      globalTriggerSystem.removeRule(effect.ruleId);
      // 从棋子的ruleTags中移除规则ID
      const piece = this.getPieceById(pieceId);
      if (piece && piece.ruleTags) {
        piece.ruleTags = piece.ruleTags.filter(tag => tag !== effect.ruleId);
      }
    }

    // 从棋子状态数据中移除
    const piece = this.getPieceById(pieceId);
    if (piece && piece.statusData) {
      delete piece.statusData[effectId];
      
      // 从棋子的statusTags数组中移除相应的标签
      if (piece.statusTags) {
        // 移除状态持续时间标签
        piece.statusTags = piece.statusTags.filter(tag => !tag.includes(`${effect.type}-duration-`));
        
        // 检查是否还有同类型的状态效果
        const hasSameType = this.statusEffects.get(pieceId)?.some(e => e.type === effect.type);
        if (!hasSameType) {
          // 移除状态类型标签
          piece.statusTags = piece.statusTags.filter(tag => tag !== `${effect.type}`);
        }
      }
    }

    // 从状态效果列表中移除
    effects.splice(index, 1);
    console.log(`Removed status effect ${effect.name} from piece ${piece?.templateId}`);
    return true;
  }

  // 移除所有状态效果
  removeAllStatusEffects(pieceId: string): void {
    const effects = this.statusEffects.get(pieceId);
    if (!effects) return;

    // 移除所有对应的规则
    const ruleIdsToRemove = effects.map(effect => effect.ruleId).filter((id): id is string => id !== undefined);
    ruleIdsToRemove.forEach(ruleId => {
      globalTriggerSystem.removeRule(ruleId);
    });

    // 清除棋子状态数据
    const piece = this.getPieceById(pieceId);
    if (piece) {
      if (piece.statusData) {
        piece.statusData = {};
      }
      // 从棋子的ruleTags中移除所有相关规则ID
      if (piece.ruleTags) {
        piece.ruleTags = piece.ruleTags.filter(tag => !ruleIdsToRemove.includes(tag));
      }
      // 从棋子的statusTags中移除所有状态相关标签
      if (piece.statusTags) {
        // 获取所有状态类型
        const statusTypes = Array.from(this.statusDefinitions.keys());
        // 移除所有状态相关标签
        piece.statusTags = piece.statusTags.filter(tag => {
          // 检查是否是状态类型标签或状态持续时间标签
          return !statusTypes.includes(tag) && !tag.includes('-duration-');
        });
      }
    }

    // 清空状态效果列表
    this.statusEffects.set(pieceId, []);
  }

  // 获取棋子的所有状态效果
  getStatusEffects(pieceId: string): StatusEffect[] {
    return this.statusEffects.get(pieceId) || [];
  }

  // 检查棋子是否有特定类型的状态效果
  hasStatusEffect(pieceId: string, type: StatusEffectType): boolean {
    const effects = this.statusEffects.get(pieceId);
    if (!effects) return false;
    return effects.some(e => e.type === type);
  }

  // 存储当前战斗状态
  private currentBattleState: any = null;

  // 更新战斗状态引用
  setBattleState(battleState: any): void {
    this.currentBattleState = battleState;
  }

  // 辅助方法 - 获取棋子实例
  private getPieceById(pieceId: string): any {
    if (!this.currentBattleState) return undefined;
    return this.currentBattleState.pieces.find((piece: any) => piece.instanceId === pieceId);
  }

  // 辅助方法 - 获取战斗状态
  private getBattleState(): any {
    return this.currentBattleState;
  }

  // 辅助方法 - 获取游戏上下文
  private getGameContext(): any {
    // 这里需要获取游戏上下文
    // 暂时返回undefined，需要在集成时实现
    return undefined;
  }

  // 更新所有状态效果
  updateStatusEffects(): void {
    // 遍历所有棋子的状态效果
    for (const [pieceId, effects] of this.statusEffects.entries()) {
      const piece = this.getPieceById(pieceId);
      if (!piece || !piece.statusData) continue;

      // 检查每个状态效果
      for (const effect of effects) {
        const statusData = piece.statusData[effect.id];
        if (!statusData) continue;

        // 检查持续时间
        if (statusData.remainingDuration > 0) {
          // 减少持续时间
          statusData.remainingDuration--;
          effect.remainingDuration--;
        }

        // 检查是否结束
        if (statusData.remainingDuration <= 0) {
          // 移除状态效果
          this.removeStatusEffect(pieceId, effect.id);
        }
      }
    }
  }
}

// 预定义状态效果
export const predefinedStatusEffects = {
  // 流血状态
  bleeding: (intensity: number = 5): StatusEffect => ({
    id: '',
    type: StatusEffectType.BLEEDING,
    name: "流血",
    description: `每回合受到${intensity}点伤害`,
    remainingDuration: 3, // 默认持续3回合
    intensity,
    isDebuff: true,
    canStack: true,
    maxStacks: 5,
    currentStacks: 1,
    code: "function EffectTrigger(context) {\n  const damage = context.statusEffect.intensity * context.statusEffect.currentStacks;\n  context.piece.currentHp = Math.max(0, context.piece.currentHp - damage);\n  console.log(context.piece.templateId + '受到流血伤害，失去' + damage + '点生命值');\n  return { success: true, message: context.piece.templateId + '受到流血伤害' };\n}"
  }),

  // 中毒状态
  poison: (intensity: number = 3): StatusEffect => ({
    id: '',
    type: StatusEffectType.POISON,
    name: "中毒",
    description: `每回合受到${intensity}点伤害`,
    remainingDuration: 4, // 默认持续4回合
    intensity,
    isDebuff: true,
    canStack: true,
    maxStacks: 3,
    currentStacks: 1,
    code: "function EffectTrigger(context) {\n  const damage = context.statusEffect.intensity * context.statusEffect.currentStacks;\n  context.piece.currentHp = Math.max(0, context.piece.currentHp - damage);\n  console.log(context.piece.templateId + '受到中毒伤害，失去' + damage + '点生命值');\n  return { success: true, message: context.piece.templateId + '受到中毒伤害' };\n}"
  }),

  // 燃烧状态
  burn: (intensity: number = 8): StatusEffect => ({
    id: '',
    type: StatusEffectType.BURN,
    name: "燃烧",
    description: `每回合受到${intensity}点伤害`,
    remainingDuration: 2, // 默认持续2回合
    intensity,
    isDebuff: true,
    canStack: false,
    maxStacks: 1,
    currentStacks: 1,
    code: "function EffectTrigger(context) {\n  const damage = context.statusEffect.intensity;\n  context.piece.currentHp = Math.max(0, context.piece.currentHp - damage);\n  console.log(context.piece.templateId + '受到燃烧伤害，失去' + damage + '点生命值');\n  return { success: true, message: context.piece.templateId + '受到燃烧伤害' };\n}"
  }),

  // 攻击增益
  buffAttack: (intensity: number = 2): StatusEffect => ({
    id: '',
    type: StatusEffectType.BUFF_ATTACK,
    name: "力量增幅",
    description: `攻击力+${intensity}`,
    remainingDuration: 3, // 默认持续3回合
    intensity,
    isDebuff: false,
    canStack: false,
    maxStacks: 1,
    currentStacks: 1,
    code: "function EffectTrigger(context) {\n  // 增益效果在应用时已经生效，这里只需要处理持续时间\n  return { success: true, message: context.piece.templateId + '的力量增幅效果持续' };\n}"
  }),

  // 防御增益
  buffDefense: (intensity: number = 2): StatusEffect => ({
    id: '',
    type: StatusEffectType.BUFF_DEFENSE,
    name: "守护光环",
    description: `防御力+${intensity}`,
    remainingDuration: 3, // 默认持续3回合
    intensity,
    isDebuff: false,
    canStack: false,
    maxStacks: 1,
    currentStacks: 1,
    code: "function EffectTrigger(context) {\n  // 增益效果在应用时已经生效，这里只需要处理持续时间\n  return { success: true, message: context.piece.templateId + '的守护光环效果持续' };\n}"
  }),

  // 生命恢复
  regeneration: (intensity: number = 4): StatusEffect => ({
    id: '',
    type: StatusEffectType.REGENERATION,
    name: "生命恢复",
    description: `每回合恢复${intensity}点生命值`,
    remainingDuration: 3, // 默认持续3回合
    intensity,
    isDebuff: false,
    canStack: true,
    maxStacks: 3,
    currentStacks: 1,
    code: "function EffectTrigger(context) {\n  const healAmount = context.statusEffect.intensity * context.statusEffect.currentStacks;\n  const newHp = Math.min(context.piece.currentHp + healAmount, context.piece.maxHp);\n  const actualHeal = newHp - context.piece.currentHp;\n  context.piece.currentHp = newHp;\n  console.log(context.piece.templateId + '受到生命恢复效果，恢复' + actualHeal + '点生命值');\n  return { success: true, message: context.piece.templateId + '恢复生命值' };\n}"
  }),

  // 眩晕状态
  stun: (): StatusEffect => ({
    id: '',
    type: StatusEffectType.STUN,
    name: "眩晕",
    description: `无法行动`,
    remainingDuration: 1, // 默认持续1回合
    intensity: 1,
    isDebuff: true,
    canStack: false,
    maxStacks: 1,
    currentStacks: 1,
    code: "function EffectTrigger(context) {\n  console.log(context.piece.templateId + '处于眩晕状态，无法行动');\n  return { success: true, message: context.piece.templateId + '处于眩晕状态' };\n}"
  })
};



// 导出默认实例
export const statusEffectSystem = new StatusEffectSystem();