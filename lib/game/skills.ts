import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"
import { globalTriggerSystem, type TriggerResult } from "./triggers"
import { rng } from "./rng"
import { getActiveRuleRuntime, getRuleDate, getRuleMath } from './rule-runtime'
import { getDataRoot, getUserDataDir } from '@/lib/app-paths'
import { manhattanDistance, traceProjectile as traceProjectilePath } from './spatial'
import { dynamicCodeRuntime } from './dynamic-code-runtime'
import { isSuspendableActionPending } from './suspendable-action-transaction'

const FORCE_RULE_RELOAD = process.env.RVB_FORCE_RULE_RELOAD === '1'
function battleDebugLog(...args: unknown[]): void {
  if (typeof process === 'undefined' || process.env?.RVB_BATTLE_DEBUG_LOGS !== '1') return
  console.log(...args)
}

function checkSynchronousTriggers(battle: BattleState, context: any): TriggerResult {
  const result = globalTriggerSystem.checkTriggers(battle, context)
  if (result.needsOptionSelection || result.needsTargetSelection) {
    const kind = result.needsOptionSelection ? 'option' : 'target'
    const error = new Error(`[${String(context?.type || 'unknown')}] interactive ${kind} trigger is unsupported at this call site`) as Error & { code?: string }
    error.name = 'InteractiveTriggerUnsupportedError'
    error.code = 'INTERACTIVE_TRIGGER_UNSUPPORTED'
    throw error
  }
  return result
}

// 简单的日志写入函数
function writeLog(message: string) {
  if (process.env.RVB_BATTLE_DEBUG_LOGS !== '1') return
  try {
    const fs = require('fs')
    const path = require('path')
    const logDir = path.join(getUserDataDir(), 'logs')
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
    currentCooldown?: number
    uses?: number
    remainingDuration?: number
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
    currentCooldown?: number
    uses?: number
    remainingDuration?: number
  }
}

// 规则加载缓存：同一个规则文件在服务器生命周期内只读一次磁盘
// 每次复用时返回浅拷贝，保持 effect 函数引用一致
const ruleCache = new Map<string, TriggerRule>()
const skillDefinitionCache = new Map<string, SkillDefinition>()
let allSkillDefinitionsCache: Record<string, SkillDefinition> | null = null

// 清除规则缓存的函数
export function clearRuleCache(): void {
  ruleCache.clear()
  clearSkillDefinitionCache()
}

/**
 * 辅助函数：向玩家手牌添加卡牌，并触发相关事件
 * @param battle 战斗状态
 * @param cardId 卡牌ID
 * @param targetPlayerId 目标玩家ID
 * @param sourcePiece 来源棋子（可选）
 * @returns 是否成功添加
 */
function addCardToHandWithTriggers(battle: BattleState, cardId: string, targetPlayerId: string, sourcePiece?: PieceInstance): boolean {
  const player = battle.players?.find((p: any) => p.playerId === targetPlayerId)
  if (!player) return false
  if (!player.hand) player.hand = []
  
  // 触发手牌加入手里前规则
  const beforeCardAddedResult = checkSynchronousTriggers(battle, {
    type: "beforeCardAdded",
    playerId: targetPlayerId,
    cardId: cardId,
    sourcePiece: sourcePiece
  });
  
  // 检查是否有规则阻止了添加手牌
  if (beforeCardAddedResult.blocked) {
    if (!battle.actions) battle.actions = []
    beforeCardAddedResult.messages.forEach(message => {
      battle.actions!.push({
        type: "triggerEffect",
        playerId: targetPlayerId,
        turn: battle.turn?.turnNumber ?? 0,
        payload: { message }
      });
    });
    return false;
  }
  
  if (player.hand.length >= 10) {
    const def = loadCardById(cardId)
    if (!battle.actions) battle.actions = []
    battle.actions.push({
      type: "cardOverflow",
      playerId: targetPlayerId,
      turn: battle.turn?.turnNumber ?? 0,
      payload: { message: `手牌已满（10张），${def?.name || cardId}被弃置` }
    })
    if (!player.discardPile) player.discardPile = []
    player.discardPile.push(cardId)
    return false
  }
  
  const runtime = getActiveRuleRuntime()
  const instanceId = runtime
    ? runtime.nextInstanceId('card', `ci-${cardId}`)
    : `ci-${cardId}-${Math.floor(rng() * 1e9)}`
  const staticCard = loadCardById(cardId)
  const customCard = (battle as any).customCards?.[cardId]
  const cardDef = staticCard || customCard
  player.hand.push({
    cardId, instanceId, ownerPlayerId: targetPlayerId,
    actionPointCost: cardDef?.actionPointCost ?? 0,
    ...(cardDef ? { name: cardDef.name, description: cardDef.description, icon: cardDef.icon, type: cardDef.type } : {})
  })
  
  // 触发手牌加入手里后规则
  const afterCardAddedResult = checkSynchronousTriggers(battle, {
    type: "afterCardAdded",
    playerId: targetPlayerId,
    cardId: cardId,
    cardInstanceId: instanceId,
    sourcePiece: sourcePiece
  });
  
  // 处理触发效果的消息
  if (afterCardAddedResult.success && afterCardAddedResult.messages.length > 0) {
    if (!battle.actions) battle.actions = []
    afterCardAddedResult.messages.forEach(message => {
      battle.actions!.push({
        type: "triggerEffect",
        playerId: targetPlayerId,
        turn: battle.turn?.turnNumber ?? 0,
        payload: { message }
      });
    });
  }
  
  return true
}

// ─── 卡牌系统类型 ─────────────────────────────────────────────────────────────

export interface SelectionOptionDefinition {
  label: string
  value: unknown
  description?: string
}

export type SelectionStepDefinition =
  | {
      kind: 'option'
      title: string
      options: SelectionOptionDefinition[]
      canCancel?: boolean
    }
  | {
      kind: 'target'
      type: 'piece' | 'grid' | 'cell'
      filter?: 'enemy' | 'ally' | 'all' | 'self'
      range?: number
      distanceMetric?: 'manhattan' | 'chebyshev'
      requireWalkable?: boolean
      requireUnoccupied?: boolean
      allowSourceOccupant?: boolean
      allowSourceOccupantOptions?: unknown[]
      sameRowOrColumn?: boolean
      excludeSourceCell?: boolean
      projectile?: { requiredCollision: 'piece-before-blocker' }
    }

export interface SelectionContractDefinition {
  source?: {
    templateId?: string
    boundInstanceField?: string
  }
  steps: SelectionStepDefinition[]
}

export interface CardDefinition {
  id: string
  name: string
  description: string
  /** active = 主动打出；reactive = 被动触发后自动弃牌 */
  type: "active" | "reactive"
  /** reactive 卡牌的触发时机，类型与 TriggerType 对应 */
  trigger?: { type: string }
  /** 卡牌效果代码，入口函数名为 executeCard(context) */
  code: string
  actionPointCost?: number
  icon?: string
  /** Pure, machine-readable source/option/target declaration (RED-59). */
  targeting?: SelectionContractDefinition
}

// 卡牌定义缓存
const cardCache = new Map<string, CardDefinition>()

/** 清除卡牌缓存（服务器热重载后调用） */
export function clearCardCache() {
  cardCache.clear()
}

/** 从 data/cards/{cardId}.json 加载卡牌定义（带缓存） */
export function loadCardById(cardId: string, forceReload = false): CardDefinition | null {
  const cached = cardCache.get(cardId)
  if (cached && !forceReload) return { ...cached }
  try {
    const fs = require('fs')
    const path = require('path')
    const cardPath = path.join(getDataRoot(), 'cards', `${cardId}.json`)
    if (fs.existsSync(cardPath)) {
      const cardData: CardDefinition = JSON.parse(fs.readFileSync(cardPath, 'utf8'))
      cardCache.set(cardId, cardData)
      return { ...cardData }
    }
    console.error(`[loadCardById] Card file not found: ${cardPath}`)
    return null
  } catch (error) {
    console.error(`[loadCardById] Error loading card ${cardId}:`, error)
    return null
  }
}

/** 为卡牌效果构建执行环境（没有 sourcePiece，用 playerId 判断阵营） */
function createCardEffectFunctions(battle: BattleState, playerId: string, context: any) {
  return {
    context,
    battle,
    playerId,

    // 目标选择：无 sourcePiece，无距离限制过滤
    selectTarget: (options?: { type?: 'piece' | 'grid'; range?: number; filter?: 'enemy' | 'ally' | 'all' }) => {
      const opts = { type: 'piece' as const, filter: 'all' as const, ...options }
      const source = context.piece || context.sourcePiece || context.rulePiece
      if (!context._selectTargetCallCount) context._selectTargetCallCount = 0
      const callIdx = context._selectTargetCallCount++
      const targetSlot = Array.isArray(context.targets) ? context.targets[callIdx] : null
      const selectedTarget = targetSlot?.info ?? (callIdx === 0 ? context.target : null)
      const selectedPosition = targetSlot?.pos ?? (callIdx === 0 ? context.targetPosition : null)
      const needsTargetSelection = () => ({ needsTargetSelection: true, targetType: opts.type, range: opts.range, filter: opts.filter, targetIndex: callIdx })
      const isInRange = (x: number, y: number) => {
        if (opts.range === undefined || !source) return true
        return manhattanDistance({ x: source.x ?? 0, y: source.y ?? 0 }, { x, y }) <= opts.range
      }
      if (opts.type === 'piece' && selectedTarget) {
        const isAlly = selectedTarget.ownerPlayerId === playerId
        if (opts.filter === 'ally' && !isAlly)
          return needsTargetSelection()
        if (opts.filter === 'enemy' && isAlly)
          return needsTargetSelection()
        if (selectedTarget.x !== undefined && selectedTarget.y !== undefined && !isInRange(selectedTarget.x, selectedTarget.y))
          return needsTargetSelection()
        if (selectedTarget.instanceId) {
          const found = battle.pieces.find((p: PieceInstance) => p.instanceId === selectedTarget.instanceId)
          if (found && isInRange(found.x || 0, found.y || 0)) return found
        }
        return selectedTarget
      }
      if (opts.type === 'grid' && selectedPosition) {
        if (!isInRange(selectedPosition.x, selectedPosition.y))
          return needsTargetSelection()
        return selectedPosition
      }
      if (opts.type === 'grid' && selectedTarget?.x !== undefined)
        return isInRange(selectedTarget.x, selectedTarget.y)
          ? { x: selectedTarget.x, y: selectedTarget.y }
          : needsTargetSelection()
      return needsTargetSelection()
    },

    selectOption: (config: any) => {
      if (context.selectedOption !== undefined) return context.selectedOption
      return {
        needsOptionSelection: true,
        options: config.options,
        title: config.title || '请选择',
        playerId: config.playerId,
        canCancel: config.canCancel,
        cancelValue: config.cancelValue,
      }
    },

    dealDamage: (attacker: PieceInstance, target: PieceInstance | PieceInstance[], baseDamage: number, damageType: DamageType = 'true', _battleState?: BattleState, skillId?: string) => {
      if (
        context.cardInstance?.holyProphecyEnhanced &&
        context.card?.id === 'holy-smite'
      ) {
        baseDamage = Math.round(baseDamage * 1.6)
      }
      return dealDamage(attacker, target, baseDamage, damageType, battle, skillId, false, undefined, context.selectedOption)
    },

    healDamage: (healer: PieceInstance, target: PieceInstance | PieceInstance[], baseHeal: number, _battleState?: BattleState, skillId?: string) => {
      if (
        context.cardInstance?.holyProphecyEnhanced &&
        context.card?.id === 'holy-heal'
      ) {
        baseHeal = Math.round(baseHeal * 1.5)
      }
      return healDamage(healer, target, baseHeal, battle, skillId)
    },

    /** 向某玩家手牌加一张卡（超上限时弃置并写日志） */
    addCardToHand: (cardId: string, targetPlayerId?: string) => {
      const pid = targetPlayerId || playerId
      return addCardToHandWithTriggers(battle, cardId, pid)
    },

    /** 按 instanceId 从手牌移除并加入弃牌堆 */
    discardCard: (instanceId: string) => {
      for (const player of battle.players as any[]) {
        if (!player.hand) continue
        const idx = player.hand.findIndex((c: any) => c.instanceId === instanceId)
        if (idx !== -1) {
          const [removed] = player.hand.splice(idx, 1)
          if (!player.discardPile) player.discardPile = []
          player.discardPile.push(removed.cardId)
          return true
        }
      }
      return false
    },

    /** 获取某玩家当前手牌 */
    getHand: (targetPlayerId?: string) => {
      const pid = targetPlayerId || playerId
      const player = battle.players.find((p: any) => p.playerId === pid) as any
      return player?.hand || []
    },

    addStatusEffectById: (targetPieceId: string, statusObject: any) => {
      let resolvedStatusObject = statusObject
      if (
        context.cardInstance?.holyProphecyEnhanced &&
        context.card?.id === 'holy-charge' &&
        statusObject.type === 'damage-buff'
      ) {
        resolvedStatusObject = {
          ...resolvedStatusObject,
          intensity: Math.round((statusObject.intensity || 2) * 1.5),
        }
      }
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId)
      if (targetPiece) {
        if (!targetPiece.statusTags) targetPiece.statusTags = []
        targetPiece.statusTags.push({
          ...resolvedStatusObject,
          name: statusObject.name || statusObject.type,
          remainingDuration: statusObject.currentDuration ?? statusObject.remainingDuration,
          remainingUses: statusObject.currentUses ?? statusObject.remainingUses,
          relatedRules: statusObject.relatedRules || []
        })
        return true
      }
      return false
    },

    removeStatusEffectById: (targetPieceId: string, statusId: string) => {
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId)
      if (targetPiece?.statusTags) {
        const idx = targetPiece.statusTags.findIndex((t: any) => t.id === statusId)
        if (idx !== -1) { targetPiece.statusTags.splice(idx, 1); return true }
      }
      return false
    },

    addRuleById: (targetPieceId: string, ruleId: string) => {
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId)
      if (targetPiece) {
        const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
        if (rule) {
          if (!targetPiece.rules) targetPiece.rules = []
          targetPiece.rules.push(rule)
          return true
        }
      }
      return false
    },

    removeRuleById: (targetPieceId: string, ruleId: string) => {
      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId)
      if (targetPiece?.rules) {
        targetPiece.rules = targetPiece.rules.filter((r: any) => r.id !== ruleId)
        return true
      }
      return false
    },

    /** 为玩家绑定一个玩家级别规则（不挂在棋子上） */
    addPlayerRuleById: (targetPlayerId: string, ruleId: string) => {
      const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
      if (!player) return false
      const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
      if (!rule) return false
      if (!player.rules) player.rules = []
      if (player.rules.some((r: any) => r.id === ruleId)) return false // 已存在则跳过
      player.rules.push(rule)
      return true
    },

    /** 从玩家移除一个玩家级别规则 */
    removePlayerRuleById: (targetPlayerId: string, ruleId: string) => {
      const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
      if (!player?.rules) return false
      player.rules = player.rules.filter((r: any) => r.id !== ruleId)
      return true
    },

    /** 为玩家添加技能 */
    addPlayerSkillById: (targetPlayerId: string, skillId: string) => {
      const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
      if (!player) return false
      if (!player.skills) player.skills = []
      if (player.skills.some((s: any) => s.skillId === skillId)) return false
      player.skills.push({ skillId, currentCooldown: 0 })
      return true
    },

    /** 从玩家移除技能 */
    removePlayerSkillById: (targetPlayerId: string, skillId: string) => {
      const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
      if (!player?.skills) return false
      player.skills = player.skills.filter((s: any) => s.skillId !== skillId)
      return true
    },

    /** 为玩家添加状态标签 */
    addPlayerStatusEffectById: (targetPlayerId: string, statusObject: any) => {
      const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
      if (!player) return false
      if (!player.statusTags) player.statusTags = []
      player.statusTags.push({
        ...statusObject,
        name: statusObject.name || statusObject.type,
        remainingDuration: statusObject.currentDuration ?? statusObject.remainingDuration,
        remainingUses: statusObject.currentUses ?? statusObject.remainingUses,
        relatedRules: statusObject.relatedRules || []
      })
      return true
    },

    /** 从玩家移除一个状态标签 */
    removePlayerStatusEffectById: (targetPlayerId: string, statusId: string) => {
      const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
      if (!player?.statusTags) return false
      const idx = player.statusTags.findIndex((t: any) => t.id === statusId)
      if (idx !== -1) { player.statusTags.splice(idx, 1); return true }
      return false
    },

    Math: getRuleMath(),
    Date: getRuleDate(),
    console
  }
}

/**
 * 执行卡牌效果代码
 * 卡牌没有 sourcePiece，通过 playerId 确定归属；入口函数名为 executeCard(context)
 */
export function executeCardFunction(
  cardDef: CardDefinition,
  playerId: string,
  battle: BattleState,
  triggerContext?: any,
  targetPiece?: PieceInstance,
  targetPosition?: { x: number; y: number },
  selectedOption?: any,
  extraTargets?: Array<{ pieceId?: string; x?: number; y?: number }>,
  cardInstance?: any,
): SkillExecutionResult {
  try {
    // 卡牌执行上下文：优先使用 triggerContext 作为基础（保持引用），然后添加卡牌相关字段
    // 这样 reactive 卡牌可以修改原始事件的参数（如 damage、heal 等）
    const context = triggerContext || {}
    context.card = { id: cardDef.id, name: cardDef.name, type: cardDef.type }
    context.playerId = playerId
    context.battle = battle
    context.piece = context.piece || null
    context.target = targetPiece || context.target || null
    context.targetPosition = targetPosition || context.targetPosition || null
    context.targets = [
      { info: context.target, pos: context.targetPosition },
      ...((extraTargets || []).map((target: any) => {
        const piece = target.pieceId
          ? battle.pieces.find(p => p.instanceId === target.pieceId)
          : (target.x !== undefined && target.y !== undefined
            ? battle.pieces.find(p => p.x === target.x && p.y === target.y && p.currentHp > 0)
            : undefined)
        const pos = piece ? { x: piece.x, y: piece.y } : (target.x !== undefined && target.y !== undefined ? { x: target.x, y: target.y } : null)
        return { info: piece || null, pos }
      }))
    ]
    context._selectTargetCallCount = 0
    context.selectedOption = selectedOption
    context.cardInstance = cardInstance || context.cardInstance || null

    const env = createCardEffectFunctions(battle, playerId, context)

    const fullCode = `
      (function(env) {
        const context = env.context;
        const battle = env.battle;
        const playerId = env.playerId;
        const selectTarget = env.selectTarget;
        const selectOption = env.selectOption;
        const dealDamage = env.dealDamage;
        const healDamage = env.healDamage;
        const addCardToHand = env.addCardToHand;
        const discardCard = env.discardCard;
        const getHand = env.getHand;
        const addStatusEffectById = env.addStatusEffectById;
        const removeStatusEffectById = env.removeStatusEffectById;
        const addRuleById = env.addRuleById;
        const removeRuleById = env.removeRuleById;
        const addPlayerRuleById = env.addPlayerRuleById;
        const removePlayerRuleById = env.removePlayerRuleById;
        const Math = env.Math;
        const Date = env.Date;
        const console = env.console;

        ${cardDef.code}

        return executeCard(context);
      })
    `
    const executeCard = dynamicCodeRuntime.compileExpression<(environment: typeof env) => SkillExecutionResult>({
      surface: 'cardCode', contentId: cardDef.id, code: fullCode, entry: 'executeCard(context)',
    })
    const result = executeCard(env)
    return result || { success: false, message: '卡牌效果无返回值' }
  } catch (error: any) {
    if (isSuspendableActionPending(error)) throw error
    if (error?.needsTargetSelection) return error as SkillExecutionResult
    if (error?.needsOptionSelection) return error as SkillExecutionResult
    console.error(`[executeCardFunction] Error executing card ${cardDef.id}:`, error)
    return { success: false, message: `卡牌执行失败: ${error?.message || error}` }
  }
}

// 从文件中加载技能定义（用于 addSkillById 同步到 battle.skillsById）
function loadSkillById(skillId: string): SkillDefinition | null {
  const cached = skillDefinitionCache.get(skillId)
  if (cached && !FORCE_RULE_RELOAD) return cached
  try {
    const fs = require('fs')
    const path = require('path')
    const skillPath = path.join(getDataRoot(), 'skills', `${skillId}.json`)
    const content = fs.readFileSync(skillPath, 'utf-8')
    const loaded = JSON.parse(content) as SkillDefinition
    skillDefinitionCache.set(skillId, loaded)
    return loaded
  } catch (e) {
    console.warn(`[loadSkillById] Failed to load skill: ${skillId}`, e)
    return null
  }
}

export function clearSkillDefinitionCache(): void {
  skillDefinitionCache.clear()
  allSkillDefinitionsCache = null
}

// 加载所有技能定义（服务端用，用于重新填充 battle.skillsById）
export function loadAllSkillsById(): Record<string, SkillDefinition> {
  if (allSkillDefinitionsCache && !FORCE_RULE_RELOAD) return allSkillDefinitionsCache
  try {
    const fs = require('fs')
    const path = require('path')
    const skillsDir = path.join(getDataRoot(), 'skills')
    const files: string[] = fs.readdirSync(skillsDir).filter((file: string) => file.endsWith('.json'))
    const result: Record<string, SkillDefinition> = {}
    for (const file of files) {
      const skillId = file.replace('.json', '')
      const skill = loadSkillById(skillId)
      if (skill) result[skillId] = skill
    }
    allSkillDefinitionsCache = result
    return result
  } catch (e) {
    console.warn('[loadAllSkillsById] Failed to load skills', e)
    return {}
  }
}

// 从文件中加载规则的函数（导出以便在需要时重新注入 effect 函数）
function instantiateRuleForBattle(rule: TriggerRule): TriggerRule {
  return {
    ...rule,
    limits: rule.limits
      ? { ...rule.limits, uses: 0, currentCooldown: 0, remainingDuration: undefined }
      : undefined,
  }
}

export function loadRuleById(ruleId: string, forceReload: boolean = false): TriggerRule | null {
  battleDebugLog(`[loadRuleById] Called with ruleId: ${ruleId}, forceReload: ${forceReload}`);
  // 命中缓存时返回拷贝（深拷贝 limits，避免跨游戏共享 uses/currentCooldown 计数）
  const cached = ruleCache.get(ruleId)
  if (cached && !forceReload) {
    battleDebugLog(`[loadRuleById] Cache hit for rule: ${ruleId}`);
    return instantiateRuleForBattle(cached)
  }
  if (forceReload && cached) {
    battleDebugLog(`[loadRuleById] Force reloading rule: ${ruleId}`);
  }
  try {
    const fs = require('fs');
    const path = require('path');
    
    const rulePath = path.join(getDataRoot(), 'rules', `${ruleId}.json`);
    battleDebugLog(`[loadRuleById] Looking for rule at: ${rulePath}`);
    
    if (fs.existsSync(rulePath)) {
      battleDebugLog(`[loadRuleById] Found rule file: ${rulePath}`);
      const ruleContent = fs.readFileSync(rulePath, 'utf8');
      const ruleData = JSON.parse(ruleContent);
      
      // 转换effect为函数 - 优先处理 skillCode
      let effectFunction: EffectFunction = () => ({ success: false, message: 'Rule effect not initialized' });
      
      // 优先处理 skillCode（新的简化方式）
      if (ruleData.skillCode) {
        effectFunction = (battle: BattleState, context: any) => {
          try {
            const globalDealDamage = dealDamage;
            const globalHealDamage = healDamage;

            // 构建辅助函数
            const addCardToHand = (cardId: string, targetPlayerId?: string) => {
              const pid = targetPlayerId || context.sourcePiece?.ownerPlayerId || context.playerId;
              if (!pid) return false;
              return addCardToHandWithTriggers(battle, cardId, pid, context.sourcePiece);
            };

            // 构建 checkToxin 辅助函数
            const checkToxin = (battleState: BattleState, ctx: any) => {
              // 简单的毒素检查逻辑，如果需要可以扩展
              return { success: true };
            };

            // 构建 addStatusEffectById 辅助函数
            const addStatusEffectById = (targetPieceId: string, status: any) => {
              const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
              if (targetPiece) {
                if (!targetPiece.statusTags) targetPiece.statusTags = [];
                // 检查是否已存在相同ID的状态
                const existingIndex = targetPiece.statusTags.findIndex((t: any) => t.id === status.id);
                if (existingIndex >= 0) {
                  targetPiece.statusTags[existingIndex] = { ...status, currentDuration: status.currentDuration || -1, currentUses: status.currentUses || -1 };
                } else {
                  targetPiece.statusTags.push({ ...status, currentDuration: status.currentDuration || -1, currentUses: status.currentUses || -1 });
                }
                return true;
              }
              return false;
            };

            // 构建 removeStatusEffectById 辅助函数
            const removeStatusEffectById = (targetPieceId: string, statusId: string) => {
              const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
              if (targetPiece?.statusTags) {
                const idx = targetPiece.statusTags.findIndex((t: any) => t.id === statusId);
                if (idx !== -1) {
                  targetPiece.statusTags.splice(idx, 1);
                  checkSynchronousTriggers(battle, {
                    type: "afterStatusRemoved",
                    sourcePiece: targetPiece,
                    statusId: statusId,
                    playerId: targetPiece.ownerPlayerId
                  });
                  return true;
                }
              }
              return false;
            };

            // 补充 context.battle，供 skillCode 中的 const battle = context.battle 使用
            if (!context.battle) {
              context.battle = { turn: battle.turn, players: battle.players, pieces: battle.pieces };
            }

            const addPlayerRuleById = (targetPlayerId: string, ruleId: string) => {
              const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
              if (!player) return false
              const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
              if (!rule) return false
              if (!player.rules) player.rules = []
              if (player.rules.some((r: any) => r.id === ruleId)) return false
              player.rules.push(rule)
              return true
            };

            const addRuleById = (targetPieceId: string, ruleId: string) => {
              const targetPiece = battle.pieces.find((p: any) => p.instanceId === targetPieceId)
              if (targetPiece) {
                const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
                if (rule) {
                  if (!targetPiece.rules) targetPiece.rules = []
                  targetPiece.rules.push(rule)
                  return true
                }
              }
              return false
            };

            const removeRuleById = (targetPieceId: string, ruleId: string) => {
              const targetPiece = battle.pieces.find((p: any) => p.instanceId === targetPieceId)
              if (targetPiece?.rules) {
                targetPiece.rules = targetPiece.rules.filter((r: any) => r.id !== ruleId)
                return true
              }
              return false
            };

            const removePlayerRuleById = (targetPlayerId: string, ruleId: string) => {
              const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
              if (!player?.rules) return false
              player.rules = player.rules.filter((r: any) => r.id !== ruleId)
              return true
            };

            const addPlayerSkillById = (targetPlayerId: string, skillId: string) => {
              const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
              if (!player) return false
              if (!player.skills) player.skills = []
              if (player.skills.some((s: any) => s.skillId === skillId)) return false
              player.skills.push({ skillId, currentCooldown: 0 })
              return true
            };

            const removePlayerSkillById = (targetPlayerId: string, skillId: string) => {
              const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
              if (!player?.skills) return false
              player.skills = player.skills.filter((s: any) => s.skillId !== skillId)
              return true
            };

            const addPlayerStatusEffectById = (targetPlayerId: string, statusObject: any) => {
              const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
              if (!player) return false
              if (!player.statusTags) player.statusTags = []
              player.statusTags.push({
                ...statusObject,
                name: statusObject.name || statusObject.type,
                remainingDuration: statusObject.currentDuration ?? statusObject.remainingDuration,
                remainingUses: statusObject.currentUses ?? statusObject.remainingUses,
                relatedRules: statusObject.relatedRules || []
              })
              return true
            };

            const removePlayerStatusEffectById = (targetPlayerId: string, statusId: string) => {
              const player = battle.players.find((p: any) => p.playerId === targetPlayerId) as any
              if (!player?.statusTags) return false
              const idx = player.statusTags.findIndex((t: any) => t.id === statusId)
              if (idx !== -1) { player.statusTags.splice(idx, 1); return true }
              return false
            };

            const selectOption = (config: any) => {
              if (context.selectedOption !== undefined) return context.selectedOption;
              return {
                needsOptionSelection: true,
                options: config.options,
                title: config.title || '请选择',
                playerId: config.playerId,
                canCancel: config.canCancel,
                cancelValue: config.cancelValue,
              };
            };

            const fireEvent = (eventName: string, ctx: any) => {
              return globalTriggerSystem.fireEvent(battle, context, eventName, ctx);
            };

            const codeEnvironment = `
              (function(battle, context, dealDamage, healDamage, addCardToHand, checkToxin, addStatusEffectById, removeStatusEffectById, addPlayerRuleById, removePlayerRuleById, addRuleById, removeRuleById, addPlayerStatusEffectById, removePlayerStatusEffectById, addPlayerSkillById, removePlayerSkillById, selectOption, fireEvent, Math, Date) {
                ${ruleData.skillCode}
              })
            `;

            if (ruleId === 'rule-shishio-combustion') {
              const ctr = (context.rulePiece?.statusTags ?? []).find((t: any) => t.type === 'shishio-dmg-counter');
              battleDebugLog(`[combustion-debug] skillId="${context.skillId ?? 'undefined'}" damage=${context.damage} src=${context.sourcePiece?.name} tgt=${context.targetPiece?.name} counter_before=${ctr?.intensity ?? 0}`);
            }
            const executeRuleCode = dynamicCodeRuntime.compileExpression<any>({
              surface: 'ruleSkillCode', contentId: ruleId, code: codeEnvironment, entry: 'rule skillCode body',
            });
            const result = executeRuleCode(battle, context, globalDealDamage, globalHealDamage, addCardToHand, checkToxin, addStatusEffectById, removeStatusEffectById, addPlayerRuleById, removePlayerRuleById, addRuleById, removeRuleById, addPlayerStatusEffectById, removePlayerStatusEffectById, addPlayerSkillById, removePlayerSkillById, selectOption, fireEvent, getRuleMath(), getRuleDate());
            if (result && result.needsOptionSelection) return result;
            return result || { success: false, message: '' };
          } catch (error) {
            if (isSuspendableActionPending(error)) throw error
            if (error instanceof DamagePipelineError) throw error;
            console.error('[Rule] Error executing skillCode:', error);
            return { success: false, message: '规则执行失败' };
          }
        };
      } else if (ruleData.effect) {
        if (ruleData.effect.type === 'triggerSkill') {
          // 触发技能的效果（原有逻辑）
          effectFunction = (battle: BattleState, context: any) => {
            const skillId = ruleData.effect.skillId;
            writeLog(`[triggerSkill] Triggering skill: ${skillId} for rule: ${ruleId}, context.playerId: ${context.playerId}`);
            if (skillId) {
              battleDebugLog(`Triggering skill: ${skillId} for rule: ${ruleId}`);
              // 优先从 battle.skillsById 获取（Android 内联数据 / 已缓存），回退到文件系统
              let skillDef = (battle as any).skillsById?.[skillId];
              if (!skillDef) {
                const skillPath = path.join(getDataRoot(), 'skills', `${skillId}.json`);
                if (fs.existsSync(skillPath)) {
                  try { skillDef = JSON.parse(fs.readFileSync(skillPath, 'utf8')); } catch {}
                }
              }
              if (skillDef) {
                try {
                  
                  // 保存全局的dealDamage和healDamage函数，避免递归调用
                  const globalDealDamage = dealDamage;
                  const globalHealDamage = healDamage;
                  
                  // 直接使用传入的 context，确保修改能反映到原始对象上
                  // 添加技能相关的字段到 context
                  context.piece = context.piece || context.sourcePiece || context.rulePiece;
                  context.target = context.target || context.targetPiece;
                  context.targetPosition = context.targetPosition || null;
                  context.skill = {
                    id: skillId,
                    name: skillDef.name,
                    type: skillDef.type,
                    powerMultiplier: skillDef.powerMultiplier
                  };
                  // 为玩家级规则触发的技能补充 context.battle
                  if (!context.battle) {
                    context.battle = battle;
                  }
                  // 使用 context 作为 skillContext，确保引用传递
                  const skillContext = context;
                  
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
                    dealDamage: (attacker: any, target: any, damage: any, type: any, battleState: any, skillId: any) => {
                      return globalDealDamage(attacker, target, damage, type, battle, skillId);
                    },
                    healDamage: (healer: any, target: any, heal: any, battleState: any, skillId: any) => {
                      return globalHealDamage(healer, target, heal, battle, skillId);
                    },
                    addStatusEffectById: (targetPieceId: any, statusObject: any) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece) {
                        if (!targetPiece.statusTags) {
                          targetPiece.statusTags = [];
                        }
                        // 状态名称映射表
                        const statusNameMap: Record<string, string> = {
                          'anti-heal': '禁疗',
                          'sleep': '睡眠',
                          'freeze': '冰冻',
                          'bleeding': '流血',
                          'divine-shield': '圣盾',
                          'nano-boost': '纳米强化',
                          'immobilize': '定身',
                          'hardy-block': '悍猛格挡',
                          'bone-storm': '白骨风暴',
                        };
                        const newStatus = {
                          ...statusObject,
                          name: statusObject.name || statusNameMap[statusObject.type] || statusObject.type,
                          remainingDuration: statusObject.currentDuration ?? statusObject.remainingDuration,
                          remainingUses: statusObject.currentUses ?? statusObject.remainingUses,
                          relatedRules: statusObject.relatedRules || []
                        };
                        targetPiece.statusTags.push(newStatus);
                        return true;
                      }
                      return false;
                    },
                    removeStatusEffectById: (targetPieceId: any, statusId: any) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece && targetPiece.statusTags) {
                        const statusTagIndex = targetPiece.statusTags.findIndex(tag => tag.id === statusId);
                        if (statusTagIndex !== -1) {
                          targetPiece.statusTags.splice(statusTagIndex, 1);
                          // 触发状态移除后事件
                          checkSynchronousTriggers(battle, {
                            type: "afterStatusRemoved",
                            sourcePiece: targetPiece,
                            statusId: statusId,
                            playerId: targetPiece.ownerPlayerId
                          });
                          return true;
                        }
                      }
                      return false;
                    },
                    addRuleById: (targetPieceId: any, ruleId: any) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece) {
                        const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD);
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
                    removeRuleById: (targetPieceId: any, ruleId: any) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece && targetPiece.rules) {
                        targetPiece.rules = targetPiece.rules.filter(rule => rule.id !== ruleId);
                        return true;
                      }
                      return false;
                    },
                    addPlayerRuleById: (targetPlayerId: string, ruleId: string) => {
                      const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
                      if (!player) return false;
                      const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD);
                      if (!rule) return false;
                      if (!player.rules) player.rules = [];
                      if (player.rules.some((r: any) => r.id === ruleId)) return false;
                      player.rules.push(rule);
                      return true;
                    },
                    removePlayerRuleById: (targetPlayerId: string, ruleId: string) => {
                      const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
                      if (!player?.rules) return false;
                      player.rules = player.rules.filter((r: any) => r.id !== ruleId);
                      return true;
                    },
                    addPlayerSkillById: (targetPlayerId: string, skillId: string) => {
                      const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
                      if (!player) return false;
                      if (!player.skills) player.skills = [];
                      if (player.skills.some((s: any) => s.skillId === skillId)) return false;
                      player.skills.push({ skillId, currentCooldown: 0 });
                      return true;
                    },
                    removePlayerSkillById: (targetPlayerId: string, skillId: string) => {
                      const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
                      if (!player?.skills) return false;
                      player.skills = player.skills.filter((s: any) => s.skillId !== skillId);
                      return true;
                    },
                    addPlayerStatusEffectById: (targetPlayerId: string, statusObject: any) => {
                      const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
                      if (!player) return false;
                      if (!player.statusTags) player.statusTags = [];
                      player.statusTags.push({
                        ...statusObject,
                        name: statusObject.name || statusObject.type,
                        remainingDuration: statusObject.currentDuration ?? statusObject.remainingDuration,
                        remainingUses: statusObject.currentUses ?? statusObject.remainingUses,
                        relatedRules: statusObject.relatedRules || []
                      });
                      return true;
                    },
                    removePlayerStatusEffectById: (targetPlayerId: string, statusId: string) => {
                      const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
                      if (!player?.statusTags) return false;
                      const idx = player.statusTags.findIndex((t: any) => t.id === statusId);
                      if (idx !== -1) { player.statusTags.splice(idx, 1); return true; }
                      return false;
                    },
                    addSkillById: (targetPieceId: any, skillId: any) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece) {
                        if (!targetPiece.skills) targetPiece.skills = [];
                        const existingSkill = targetPiece.skills.find(skill => skill.skillId === skillId);
                        if (!existingSkill) {
                          const newSkill = { skillId: skillId, currentCooldown: 0 };
                          targetPiece.skills.push(newSkill);
                          if (targetPiece.displaySkills !== undefined) {
                            const alreadyInDisplay = targetPiece.displaySkills.some((s: any) =>
                              (typeof s === 'string' ? s : s.skillId) === skillId);
                            if (!alreadyInDisplay) targetPiece.displaySkills.push(newSkill);
                          }
                          if (!battle.skillsById[skillId]) {
                            const loaded = loadSkillById(skillId);
                            if (loaded) battle.skillsById[skillId] = loaded;
                          }
                          return true;
                        }
                      }
                      return false;
                    },
                    removeSkillById: (targetPieceId: any, skillId: any) => {
                      const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
                      if (targetPiece && targetPiece.skills) {
                        const originalLength = targetPiece.skills.length;
                        targetPiece.skills = targetPiece.skills.filter(skill => skill.skillId !== skillId);
                        if (targetPiece.displaySkills !== undefined) {
                          targetPiece.displaySkills = targetPiece.displaySkills.filter((s: any) =>
                            (typeof s === 'string' ? s : s.skillId) !== skillId);
                        }
                        return targetPiece.skills.length < originalLength;
                      }
                      return false;
                    },
                    addCardToHand: (cardId: string, targetPlayerId?: string) => {
                      const pid = targetPlayerId || context.sourcePiece?.ownerPlayerId || context.playerId
                      if (!pid) return false
                      return addCardToHandWithTriggers(battle, cardId, pid, context.sourcePiece)
                    },
                    discardCard: (instanceId: string) => {
                      if (!battle.players) return false
                      for (const player of battle.players) {
                        if (!player.hand) continue
                        const idx = player.hand.findIndex(c => c.instanceId === instanceId)
                        if (idx !== -1) {
                          const [card] = player.hand.splice(idx, 1)
                          if (!player.discardPile) player.discardPile = []
                          player.discardPile.push(card.cardId)
                          return true
                        }
                      }
                      return false
                    },
                    getHand: (targetPlayerId?: string) => {
                      const pid = targetPlayerId || context.sourcePiece?.ownerPlayerId
                      const player = battle.players?.find(p => p.playerId === pid)
                      return player?.hand ?? []
                    },
                    getAllEnemiesInRange: (range: any) => [],
                    getAllAlliesInRange: (range: any) => [],
                    calculateDistance: (x1: any, y1: any, x2: any, y2: any) => manhattanDistance({ x: x1, y: y1 }, { x: x2, y: y2 }),
                    isTargetInRange: (target: any, range: any) => false,
                    Math: getRuleMath(),
                    Date: getRuleDate(),
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
                      const addCardToHand = environment.addCardToHand;
                      const discardCard = environment.discardCard;
                      const getHand = environment.getHand;
                      const addPlayerRuleById = environment.addPlayerRuleById;
                      const removePlayerRuleById = environment.removePlayerRuleById;
                      const addPlayerSkillById = environment.addPlayerSkillById;
                      const removePlayerSkillById = environment.removePlayerSkillById;
                      const addPlayerStatusEffectById = environment.addPlayerStatusEffectById;
                      const removePlayerStatusEffectById = environment.removePlayerStatusEffectById;
                      const Math = environment.Math;
                      const Date = environment.Date;
                      const console = environment.console;

                      ${skillDef.code}

                      return executeSkill(context);
                    })
                  `;
                  
                  // 执行技能代码
                  writeLog(`[triggerSkill] Executing skill code for ${skillId}...`);
                  const executeTriggeredSkill = dynamicCodeRuntime.compileExpression<(environment: typeof skillEnvironment) => SkillExecutionResult>({
                    surface: 'ruleTriggerSkill', contentId: skillId, code: fullSkillCode, entry: 'executeSkill(context)',
                  });
                  const result = executeTriggeredSkill(skillEnvironment);
                  writeLog(`[triggerSkill] Skill execution result for ${skillId}: ${JSON.stringify(result)}`);
                  battleDebugLog(`Skill execution result:`, result);
                  return result;
                } catch (error) {
                  if (isSuspendableActionPending(error)) throw error
                  console.error('Error executing skill in rule effect:', error);
                  return { success: false, message: '技能执行失败' };
                }
              } else {
                console.error(`Skill not found: ${skillId}`);
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
      
      battleDebugLog(`Loaded rule successfully: ${ruleId}`);
      // 写入缓存，后续复用时无需再读文件
      ruleCache.set(ruleId, rule)
      return instantiateRuleForBattle(rule);
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
export type DamageType = "physical" | "magical" | "true" | "toxin"



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
    x: number | null
    y: number | null
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
    x: number | null
    y: number | null
  } | null
  targetPosition: {
    x: number
    y: number
  } | null
  /** 用户通过选项选择器选择的值，未选择时为 undefined */
  selectedOption?: any
  /**
   * 多步目标选择结果数组（通用 N 目标支持）。
   * targets[0] 与 target/targetPosition 相同（向后兼容）。
   * targets[1] 为第二次 selectTarget，targets[2] 为第三次，以此类推。
   * 每项：{ info: PieceInfo|null, pos: {x,y}|null }
   */
  targets?: Array<{
    info: {
      instanceId: string
      templateId: string
      ownerPlayerId: string
      currentHp: number
      maxHp: number
      attack: number
      defense: number
      x: number | null
      y: number | null
    } | null
    pos: { x: number; y: number } | null
  }>
  /** selectTarget 调用计数（内部使用，追踪多次目标选择） */
  _selectTargetCallCount?: number
  battle: any
  skill: {
    id: string
    name: string
    type: SkillType
    powerMultiplier: number
    targeting?: SelectionContractDefinition
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
  targetIndex?: number
  needsOptionSelection?: boolean
  options?: { label: string; value: any; description?: string }[]
  title?: string
  playerId?: string
  canCancel?: boolean
  cancelValue?: any
  pendingRuleId?: string
  pendingRuleSourceId?: string
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
  /** Pure, machine-readable option/target declaration (RED-59). */
  targeting?: SelectionContractDefinition
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
  if (piece.x == null || piece.y == null) return []
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
      if (p.x == null || p.y == null) continue
      const distance = manhattanDistance(piece, p)
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
  if (piece.x == null || piece.y == null) return []
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
      if (p.x == null || p.y == null) continue
      const distance = manhattanDistance(piece, p)
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
  return manhattanDistance({ x: x1, y: y1 }, { x: x2, y: y2 })
}

// 检查目标是否在范围内
export function isTargetInRange(context: SkillExecutionContext, target: any, range: number): boolean {
  if (!target) return false
  if (context.piece.x == null || context.piece.y == null || target.x == null || target.y == null) return false
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
        const nearestDistance = manhattanDistance(nearest, sourcePiece);
        const currentDistance = manhattanDistance(current, sourcePiece);
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
        const distance = manhattanDistance(p, sourcePiece);
        return distance <= range;
      });
    },
    
    // 获取指定范围内的盟友
    getAlliesInRange: (range: number) => {
      return battle.pieces.filter(p => {
        if (p.ownerPlayerId !== sourcePiece.ownerPlayerId || p.currentHp <= 0) {
          return false;
        }
        const distance = manhattanDistance(p, sourcePiece);
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
    
    // 选项选择函数 - 用于在技能代码中唤起选项选择器
    selectOption: (config: {
      title?: string;
      options: { label: string; value: any; description?: string }[];
      playerId?: string;
      canCancel?: boolean;
      cancelValue?: any;
    }) => {
      battleDebugLog('selectOption called, config:', config, 'context.selectedOption:', context && context.selectedOption);
      // 如果已有选项值（用户已选择），直接返回该值
      if (context && context.selectedOption !== undefined) {
        return context.selectedOption;
      }
      // 否则触发前端选项选择器
      return {
        needsOptionSelection: true,
        options: config.options,
        title: config.title || '请选择',
        playerId: config.playerId,
        canCancel: config.canCancel,
        cancelValue: config.cancelValue,
      };
    },

    // 目标选择函数 - 用于在技能代码中唤起目标选择（支持顺序 N 次调用）
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
      const ctx = context || {} as any;

      // 追踪本次技能执行中 selectTarget 的调用次数
      if (!ctx._selectTargetCallCount) ctx._selectTargetCallCount = 0;
      const callIdx = ctx._selectTargetCallCount;
      ctx._selectTargetCallCount = callIdx + 1;

      // 从 targets[] 数组中取出本次调用对应的目标槽（支持任意次数）
      const targetsArr = ctx.targets || [];
      const activeSlot = callIdx < targetsArr.length ? targetsArr[callIdx] : null;
      const activeTarget = activeSlot?.info || null;
      const activePos = activeSlot?.pos ||
        (callIdx === 0 ? ctx.targetPosition : null);
      const declaredTargetStep = ctx.skill?.targeting?.steps
        ?.filter((step: SelectionStepDefinition) => step.kind === 'target')[callIdx] as
          | Extract<SelectionStepDefinition, { kind: 'target' }>
          | undefined;
      const needsTargetSelection = () => ({
        needsTargetSelection: true,
        targetType: defaultOptions.type,
        range: defaultOptions.range,
        filter: defaultOptions.filter,
        targetIndex: callIdx
      });

      // 检查是否已经有目标信息（用户已经选择了目标）
      if (defaultOptions.type === 'piece' && context && activeTarget) {
        // 检查目标是否符合filter要求
        const isAlly = activeTarget.ownerPlayerId === sourcePiece.ownerPlayerId;
        const isEnemy = !isAlly;

        // 根据filter参数检查目标是否符合要求
        if (defaultOptions.filter === 'ally' && !isAlly) {
          return needsTargetSelection();
        } else if (defaultOptions.filter === 'enemy' && !isEnemy) {
          return needsTargetSelection();
        }

        // 检查目标是否在范围内
        if (defaultOptions.range !== undefined && activeTarget.x != null && activeTarget.y != null && sourcePiece.x != null && sourcePiece.y != null) {
          const distance = declaredTargetStep?.distanceMetric === 'chebyshev'
            ? Math.max(Math.abs(sourcePiece.x - activeTarget.x), Math.abs(sourcePiece.y - activeTarget.y))
            : manhattanDistance(sourcePiece, activeTarget);
          if (distance > defaultOptions.range) {
            return needsTargetSelection();
          }
        }

        // 尝试从battle.pieces中查找原始目标实例
        const targetInstanceId = activeTarget.instanceId;
        if (targetInstanceId) {
          for (let i = 0; i < battle.pieces.length; i++) {
            const piece = battle.pieces[i];
            if (piece.instanceId === targetInstanceId) {
              return piece;
            }
          }
        }

        // 如果通过instanceId找不到，尝试通过位置查找
        if (activeTarget.x !== undefined && activeTarget.y !== undefined) {
          const targetByPosition = battle.pieces.find(p => p.x === activeTarget.x && p.y === activeTarget.y);
          if (targetByPosition) return targetByPosition;
        }

        // 目标找不到，请求重新选择目标
        return needsTargetSelection();
      } else if (defaultOptions.type === 'grid' && context) {
        // 如果需要选择格子，从 targets[] 或 targetPosition 中取坐标
        const gridPos = activePos;
        if (gridPos) {
          // Execution uses the same declared distance metric as prepareAction.
          if (defaultOptions.range !== undefined && sourcePiece.x != null && sourcePiece.y != null) {
            const dist = declaredTargetStep?.distanceMetric === 'chebyshev'
              ? Math.max(Math.abs(sourcePiece.x - gridPos.x), Math.abs(sourcePiece.y - gridPos.y))
              : manhattanDistance(sourcePiece, gridPos);
            if (dist > defaultOptions.range) {
              return needsTargetSelection();
            }
          }
          return gridPos;
        }
      }
      
      // 没有目标信息，返回需要目标选择的结果
      // 这会触发前端显示目标选择界面
      return needsTargetSelection();
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
            const randomTile = availableTiles[Math.floor(rng() * availableTiles.length)];
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
    
    // 造成伤害（支持单目标或目标数组；传入数组时 beforeDamageDealt 只触发一次）
    dealDamage: (attacker: PieceInstance, targetPiece: PieceInstance | PieceInstance[], baseDamage: number, damageType: DamageType = "physical", battleState?: BattleState, skillId?: string, skipBefore = false, killerPlayerId?: string) => {
      return dealDamage(attacker, targetPiece, baseDamage, damageType, battle, skillId, skipBefore, killerPlayerId, context?.selectedOption);
    },

    // 治疗（支持单目标或目标数组；传入数组时 beforeHealDealt 只触发一次）
    healDamage: (healer: PieceInstance, targetPiece: PieceInstance | PieceInstance[], baseHeal: number, battleState?: BattleState, skillId?: string) => {
      // 忽略传入的 battleState，使用闭包中的 battle，确保修改的是正确的实例
      return healDamage(healer, targetPiece, baseHeal, battle, skillId);
    }
  };
}

/** RED-33 result for one target inside a deterministic damage batch. */
export interface DamageResult {
  success: boolean
  batchId: string
  chainId: string
  parentBatchId?: string
  sourceId: string
  targetId: string
  skillId?: string
  damageType: DamageType
  rawDamage: number
  modifiedDamage: number
  defense: number
  shieldAbsorbed: number
  damage: number
  blocked: boolean
  isKilled: boolean
  targetHp: number
  message: string
}

export interface DamageBatchResult {
  success: boolean
  batchId?: string
  chainId?: string
  damages: number[]
  totalDamage: number
  results: DamageResult[]
  message: string
}

interface DamageBatchRequest {
  attacker: PieceInstance
  targets: PieceInstance[]
  baseDamage: number
  damageType: DamageType
  skillId?: string
  skipBeforeTrigger: boolean
  killerPlayerId?: string
  selectedOption?: any
  parentBatchId?: string
  depth: number
}

interface DamageChain {
  chainId?: string
  pending: DamageBatchRequest[]
  processedBatches: number
  fallbackStart: number
  sequence: number
  currentBatchId?: string
  currentDepth?: number
}

interface PreparedDamage {
  target: PieceInstance
  hpBefore: number
  result: DamageResult
  emitBlocked: boolean
}

const MAX_DAMAGE_CHAIN_DEPTH = 20
const MAX_DAMAGE_CHAIN_BATCHES = 100
const DAMAGE_TYPES = new Set<DamageType>(['physical', 'magical', 'true', 'toxin'])
const activeDamageChains = new WeakMap<BattleState, DamageChain>()

export class DamagePipelineError extends Error {
  readonly code: string
  readonly context: Record<string, unknown>

  constructor(code: string, message: string, context: Record<string, unknown>) {
    super(`${message}; context=${JSON.stringify(context)}`)
    this.name = 'DamagePipelineError'
    this.code = code
    this.context = context
  }
}

function compareDamageTarget(left: PieceInstance, right: PieceInstance): number {
  if (left.instanceId === right.instanceId) return 0
  return left.instanceId < right.instanceId ? -1 : 1
}

function damageContext(
  battle: BattleState,
  attacker: PieceInstance,
  skillId: string | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const runtime = getActiveRuleRuntime()
  return {
    sourceId: attacker?.instanceId,
    playerId: attacker?.ownerPlayerId,
    skillId,
    turn: battle?.turn?.turnNumber ?? 0,
    rootSeed: runtime?.rootSeed ?? null,
    ...extra,
  }
}

function validateDamageRequest(
  attacker: PieceInstance,
  targets: PieceInstance[],
  baseDamage: number,
  damageType: DamageType,
  battle: BattleState,
  skillId?: string,
): PieceInstance[] {
  if (!attacker || typeof attacker.instanceId !== 'string' || !attacker.instanceId) {
    throw new DamagePipelineError('RVB_DAMAGE_SOURCE_INVALID', 'Damage source must have a stable instanceId', damageContext(battle, attacker, skillId))
  }
  if (!Number.isFinite(baseDamage) || baseDamage < 0) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_VALUE_INVALID',
      `Damage must be a finite non-negative number; received ${String(baseDamage)}`,
      damageContext(battle, attacker, skillId, { baseDamage }),
    )
  }
  if (!DAMAGE_TYPES.has(damageType)) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_TYPE_INVALID',
      `Unsupported damage type ${String(damageType)}`,
      damageContext(battle, attacker, skillId, { damageType }),
    )
  }

  const seen = new Set<string>()
  const canonicalTargets: PieceInstance[] = []
  for (const requestedTarget of targets) {
    const targetId = requestedTarget?.instanceId
    if (!targetId) {
      throw new DamagePipelineError('RVB_DAMAGE_TARGET_INVALID', 'Damage target must have a stable instanceId', damageContext(battle, attacker, skillId))
    }
    if (seen.has(targetId)) {
      throw new DamagePipelineError(
        'RVB_DAMAGE_TARGET_DUPLICATE',
        `Damage batch contains duplicate target ${targetId}`,
        damageContext(battle, attacker, skillId, { targetId }),
      )
    }
    seen.add(targetId)
    const canonical = battle.pieces.find(piece => piece.instanceId === targetId)
    if (!canonical || canonical.currentHp <= 0) {
      throw new DamagePipelineError(
        'RVB_DAMAGE_TARGET_UNAVAILABLE',
        `Damage target ${targetId} is not an active living piece`,
        damageContext(battle, attacker, skillId, { targetId }),
      )
    }
    canonicalTargets.push(canonical)
  }
  return canonicalTargets
}

function appendDamageMessages(battle: BattleState, playerId: string, messages: string[]): void {
  if (messages.length === 0) return
  battle.actions ??= []
  for (const message of messages) {
    battle.actions.push({
      type: 'triggerEffect',
      playerId,
      turn: battle.turn?.turnNumber ?? 0,
      payload: { message },
    })
  }
}

function nextDamageBatchId(battle: BattleState, chain: DamageChain): string {
  const runtime = getActiveRuleRuntime()
  if (runtime) return runtime.nextInstanceId('damage-batch', 'damage-batch')
  const id = `damage-batch-${battle.turn?.turnNumber ?? 0}-${chain.fallbackStart + chain.sequence}`
  chain.sequence += 1
  return id
}

function collectFollowUpDamage(
  queue: NonNullable<import('./triggers').TriggerContext['damageQueue']>,
  chain: DamageChain,
  parentBatchId: string,
  depth: number,
  battle: BattleState,
): void {
  for (const request of queue) {
    if (depth > MAX_DAMAGE_CHAIN_DEPTH) {
      throw new DamagePipelineError('RVB_DAMAGE_CHAIN_DEPTH', `Damage chain exceeded depth ${MAX_DAMAGE_CHAIN_DEPTH}`, {
        chainId: chain.chainId,
        parentBatchId,
        depth,
        turn: battle.turn?.turnNumber ?? 0,
        rootSeed: getActiveRuleRuntime()?.rootSeed ?? null,
      })
    }
    const targets = Array.isArray(request.target) ? request.target : [request.target]
    chain.pending.push({
      attacker: request.attacker,
      targets,
      baseDamage: request.damage,
      damageType: request.damageType,
      skillId: request.skillId,
      skipBeforeTrigger: false,
      killerPlayerId: request.killerPlayerId,
      parentBatchId,
      depth,
    })
  }
}

function prepareTargetDamage(
  request: DamageBatchRequest,
  target: PieceInstance,
  sourceDamage: number,
  sourceBlocked: boolean,
  batchId: string,
  chain: DamageChain,
  queuedDamage: NonNullable<import('./triggers').TriggerContext['damageQueue']>,
  battle: BattleState,
): PreparedDamage {
  const beforeTakenQueue: NonNullable<import('./triggers').TriggerContext['damageQueue']> = []
  const beforeTakenContext = {
    type: 'beforeDamageTaken' as const,
    piece: target,
    sourcePiece: target,
    targetPiece: request.attacker,
    target: request.attacker,
    damage: sourceDamage,
    damageType: request.damageType,
    skillId: request.skillId,
    selectedOption: request.selectedOption,
    damageBatchId: batchId,
    damageChainId: chain.chainId,
    parentDamageBatchId: request.parentBatchId,
    rawDamage: request.baseDamage,
    damageQueue: beforeTakenQueue,
  }
  const beforeTaken: TriggerResult = sourceBlocked
    ? { success: false, blocked: true, messages: [] }
    : globalTriggerSystem.checkTriggers(battle, beforeTakenContext)
  if (beforeTaken.needsOptionSelection) throw beforeTaken
  if (beforeTaken.needsTargetSelection) throw beforeTaken
  appendDamageMessages(battle, request.attacker.ownerPlayerId, beforeTaken.messages || [])
  queuedDamage.push(...beforeTakenQueue)

  const modifiedDamage = Number(beforeTakenContext.damage)
  if (!Number.isFinite(modifiedDamage) || modifiedDamage < 0) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_MODIFIER_INVALID',
      `Damage trigger produced invalid value ${String(beforeTakenContext.damage)}`,
      damageContext(battle, request.attacker, request.skillId, { batchId, targetId: target.instanceId }),
    )
  }

  let blocked = sourceBlocked || Boolean(beforeTaken.blocked)
  const defense = request.damageType === 'physical' || request.damageType === 'magical'
    ? Number(target.defense) || 0
    : 0
  let defendedDamage = 0
  if (!blocked && modifiedDamage > 0) {
    defendedDamage = Math.max(1, Math.floor(modifiedDamage - defense))
  }

  let shieldAbsorbed = 0
  let damageAfterShield = defendedDamage
  if (!blocked && damageAfterShield > 0) {
    const shieldQueue: NonNullable<import('./triggers').TriggerContext['damageQueue']> = []
    const shieldContext = {
      type: 'beforeDamageShield' as const,
      piece: target,
      sourcePiece: target,
      targetPiece: request.attacker,
      target: request.attacker,
      damage: damageAfterShield,
      damageType: request.damageType,
      skillId: request.skillId,
      selectedOption: request.selectedOption,
      damageBatchId: batchId,
      damageChainId: chain.chainId,
      parentDamageBatchId: request.parentBatchId,
      rawDamage: request.baseDamage,
      modifiedDamage,
      defenseApplied: defense,
      damageQueue: shieldQueue,
    }
    const shieldResult = globalTriggerSystem.checkTriggers(battle, shieldContext)
    if (shieldResult.needsOptionSelection) throw shieldResult
    if (shieldResult.needsTargetSelection) throw shieldResult
    appendDamageMessages(battle, request.attacker.ownerPlayerId, shieldResult.messages)
    queuedDamage.push(...shieldQueue)
    const ruleShieldDamage = Math.max(0, Number(shieldContext.damage) || 0)
    shieldAbsorbed += Math.max(0, damageAfterShield - ruleShieldDamage)
    damageAfterShield = ruleShieldDamage
    blocked = Boolean(shieldResult.blocked) || damageAfterShield === 0

    if (!blocked && damageAfterShield > 0 && Number(target.shield) > 0) {
      const availableShield = Math.max(0, Number(target.shield) || 0)
      const absorbed = Math.min(availableShield, damageAfterShield)
      target.shield = availableShield - absorbed
      shieldAbsorbed += absorbed
      damageAfterShield -= absorbed
      blocked = damageAfterShield === 0
    }
  }

  if (!blocked && damageAfterShield > 0) {
    const appliedQueue: NonNullable<import('./triggers').TriggerContext['damageQueue']> = []
    const appliedContext = {
      type: 'beforeDamageApplied' as const,
      piece: target,
      sourcePiece: target,
      targetPiece: request.attacker,
      target: request.attacker,
      damage: damageAfterShield,
      damageType: request.damageType,
      skillId: request.skillId,
      selectedOption: request.selectedOption,
      damageBatchId: batchId,
      damageChainId: chain.chainId,
      parentDamageBatchId: request.parentBatchId,
      rawDamage: request.baseDamage,
      modifiedDamage,
      defenseApplied: defense,
      shieldAbsorbed,
      damageQueue: appliedQueue,
    }
    const appliedResult = globalTriggerSystem.checkTriggers(battle, appliedContext)
    if (appliedResult.needsOptionSelection) throw appliedResult
    if (appliedResult.needsTargetSelection) throw appliedResult
    appendDamageMessages(battle, request.attacker.ownerPlayerId, appliedResult.messages)
    queuedDamage.push(...appliedQueue)
    damageAfterShield = Math.max(0, Number(appliedContext.damage) || 0)
    blocked = Boolean(appliedResult.blocked) || damageAfterShield === 0
  }

  const finalDamage = blocked ? 0 : damageAfterShield
  const hpBefore = target.currentHp
  const targetName = target.name || target.templateId
  const attackerName = request.attacker.name || request.attacker.templateId
  const typeName = request.damageType === 'physical' ? '物理' : request.damageType === 'magical' ? '魔法' : request.damageType === 'toxin' ? '毒素' : '真实'
  return {
    target,
    hpBefore,
    emitBlocked: blocked && sourceDamage > 0,
    result: {
      success: !blocked,
      batchId,
      chainId: chain.chainId || batchId,
      parentBatchId: request.parentBatchId,
      sourceId: request.attacker.instanceId,
      targetId: target.instanceId,
      skillId: request.skillId,
      damageType: request.damageType,
      rawDamage: request.baseDamage,
      modifiedDamage,
      defense,
      shieldAbsorbed,
      damage: finalDamage,
      blocked,
      isKilled: false,
      targetHp: target.currentHp,
      message: blocked
        ? `${targetName}受到的伤害被完整抵挡`
        : `${attackerName}对${targetName}造成${finalDamage}点${typeName}伤害`,
    },
  }
}

function resolveDamageBatch(request: DamageBatchRequest, battle: BattleState, chain: DamageChain): DamageBatchResult {
  chain.processedBatches += 1
  if (chain.processedBatches > MAX_DAMAGE_CHAIN_BATCHES) {
    throw new DamagePipelineError('RVB_DAMAGE_CHAIN_BUDGET', `Damage chain exceeded ${MAX_DAMAGE_CHAIN_BATCHES} batches`, {
      chainId: chain.chainId,
      parentBatchId: request.parentBatchId,
      depth: request.depth,
      turn: battle.turn?.turnNumber ?? 0,
      rootSeed: getActiveRuleRuntime()?.rootSeed ?? null,
    })
  }

  const canonicalTargets = validateDamageRequest(
    request.attacker,
    request.targets,
    request.baseDamage,
    request.damageType,
    battle,
    request.skillId,
  )
  const stableTargets = [...canonicalTargets].sort(compareDamageTarget)
  const batchId = nextDamageBatchId(battle, chain)
  chain.chainId ??= batchId
  chain.currentBatchId = batchId
  chain.currentDepth = request.depth
  const queuedDamage: NonNullable<import('./triggers').TriggerContext['damageQueue']> = []

  let sourceDamage = request.baseDamage
  let sourceBlocked = false
  if (!request.skipBeforeTrigger) {
    const sourceQueue: NonNullable<import('./triggers').TriggerContext['damageQueue']> = []
    const sourceContext = {
      type: 'beforeDamageDealt' as const,
      piece: request.attacker,
      sourcePiece: request.attacker,
      targetPiece: stableTargets[0],
      target: stableTargets[0],
      damage: request.baseDamage,
      damageType: request.damageType,
      skillId: request.skillId,
      selectedOption: request.selectedOption,
      damageBatchId: batchId,
      damageChainId: chain.chainId,
      parentDamageBatchId: request.parentBatchId,
      rawDamage: request.baseDamage,
      damageQueue: sourceQueue,
    }
    const sourceResult = globalTriggerSystem.checkTriggers(battle, sourceContext)
    if (sourceResult.needsOptionSelection) throw sourceResult
    if (sourceResult.needsTargetSelection) throw sourceResult
    appendDamageMessages(battle, request.attacker.ownerPlayerId, sourceResult.messages)
    queuedDamage.push(...sourceQueue)
    sourceDamage = Number(sourceContext.damage)
    sourceBlocked = Boolean(sourceResult.blocked)
  }
  if (!Number.isFinite(sourceDamage) || sourceDamage < 0) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_MODIFIER_INVALID',
      `Source damage trigger produced invalid value ${String(sourceDamage)}`,
      damageContext(battle, request.attacker, request.skillId, { batchId }),
    )
  }

  const prepared = stableTargets.map(target => prepareTargetDamage(
    request,
    target,
    sourceDamage,
    sourceBlocked,
    batchId,
    chain,
    queuedDamage,
    battle,
  ))

  // Commit every target's HP before any after-damage or lifecycle event can observe the batch.
  for (const entry of prepared) {
    if (entry.result.damage > 0) {
      entry.target.currentHp = Math.max(0, entry.hpBefore - entry.result.damage)
      entry.result.targetHp = entry.target.currentHp
    }
  }

  for (const entry of prepared) {
    const sharedContext = {
      sourcePiece: request.attacker,
      targetPiece: entry.target,
      damage: entry.result.damage,
      damageType: request.damageType,
      skillId: request.skillId,
      damageBatchId: batchId,
      damageChainId: chain.chainId,
      parentDamageBatchId: request.parentBatchId,
      rawDamage: request.baseDamage,
      modifiedDamage: entry.result.modifiedDamage,
      defenseApplied: entry.result.defense,
      shieldAbsorbed: entry.result.shieldAbsorbed,
      damageQueue: queuedDamage,
    }
    if (entry.emitBlocked) {
      const blockedResult = checkSynchronousTriggers(battle, {
        ...sharedContext,
        type: 'afterDamageBlocked',
        sourcePiece: entry.target,
        targetPiece: request.attacker,
      })
      appendDamageMessages(battle, request.attacker.ownerPlayerId, blockedResult.messages)
      continue
    }
    if (entry.result.damage <= 0) continue
    const dealtResult = checkSynchronousTriggers(battle, { ...sharedContext, type: 'afterDamageDealt' })
    const takenResult = checkSynchronousTriggers(battle, {
      ...sharedContext,
      type: 'afterDamageTaken',
      sourcePiece: entry.target,
      targetPiece: request.attacker,
    })
    appendDamageMessages(battle, entry.target.ownerPlayerId, [...dealtResult.messages, ...takenResult.messages])
  }

  for (const entry of prepared) {
    if (entry.hpBefore <= 0 || entry.target.currentHp !== 0) {
      entry.result.targetHp = entry.target.currentHp
      continue
    }
    if (!battle.pieces.some(piece => piece.instanceId === entry.target.instanceId)) continue

    checkSynchronousTriggers(battle, {
      type: 'beforePieceKilled',
      sourcePiece: entry.target,
      targetPiece: request.attacker,
      skillId: request.skillId,
      damageBatchId: batchId,
      damageChainId: chain.chainId,
    })
    checkSynchronousTriggers(battle, {
      type: 'afterPieceKilled',
      sourcePiece: request.attacker,
      targetPiece: entry.target,
      skillId: request.skillId,
      damageBatchId: batchId,
      damageChainId: chain.chainId,
    })
    checkSynchronousTriggers(battle, {
      type: 'onPieceDied',
      sourcePiece: entry.target,
      targetPiece: request.attacker,
      damage: entry.result.damage,
      skillId: request.skillId,
      damageBatchId: batchId,
      damageChainId: chain.chainId,
    })

    // A death consumer may revive the target before graveyard/charge finalization.
    if (entry.target.currentHp > 0) {
      entry.result.targetHp = entry.target.currentHp
      continue
    }

    const killCreditId = request.killerPlayerId || request.attacker.ownerPlayerId
    const isEnemyKill = entry.target.ownerPlayerId !== killCreditId
    if (isEnemyKill && !(entry.target as any).noKillCharge) {
      const playerMeta = battle.players.find(player => player.playerId === killCreditId)
      if (playerMeta) {
        playerMeta.chargePoints += 1
        checkSynchronousTriggers(battle, {
          type: 'afterChargeGained',
          sourcePiece: request.attacker,
          amount: 1,
          playerId: killCreditId,
          damageBatchId: batchId,
          damageChainId: chain.chainId,
        })
      }
    }

    const targetIndex = battle.pieces.findIndex(piece => piece.instanceId === entry.target.instanceId)
    if (targetIndex !== -1) {
      battle.graveyard ??= []
      battle.graveyard.push(battle.pieces.splice(targetIndex, 1)[0])
      entry.result.isKilled = true
      entry.result.targetHp = 0
    }
  }

  battle.actions ??= []
  for (const entry of prepared) {
    battle.actions.push({
      type: 'damage',
      playerId: request.attacker.ownerPlayerId,
      turn: battle.turn?.turnNumber ?? 0,
      payload: {
        batchId,
        chainId: chain.chainId,
        parentBatchId: request.parentBatchId,
        sourceId: request.attacker.instanceId,
        skillId: request.skillId,
        targetId: entry.target.instanceId,
        damageType: request.damageType,
        rawDamage: request.baseDamage,
        modifiedDamage: entry.result.modifiedDamage,
        defense: entry.result.defense,
        shieldAbsorbed: entry.result.shieldAbsorbed,
        finalDamage: entry.result.damage,
        blocked: entry.result.blocked,
        killed: entry.result.isKilled,
      },
    })
  }

  collectFollowUpDamage(queuedDamage, chain, batchId, request.depth + 1, battle)

  const byTargetId = new Map(prepared.map(entry => [entry.target.instanceId, entry.result]))
  const orderedResults = canonicalTargets.map(target => byTargetId.get(target.instanceId)!)
  const damages = orderedResults.map(result => result.damage)
  const totalDamage = damages.reduce((sum, damage) => sum + damage, 0)
  return {
    success: orderedResults.some(result => result.success),
    batchId,
    chainId: chain.chainId,
    damages,
    totalDamage,
    results: orderedResults,
    message: `对${orderedResults.length}个目标共造成${totalDamage}点伤害`,
  }
}

/**
 * Shared single- and multi-target damage entry point. A single target is a
 * one-target batch; arrays preserve result alignment while resolving by stable ID.
 */
export function dealDamage(
  attacker: PieceInstance,
  target: PieceInstance | PieceInstance[],
  baseDamage: number,
  damageType: DamageType,
  battle: BattleState,
  skillId?: string,
  skipBeforeTrigger = false,
  killerPlayerId?: string,
  selectedOption?: any,
): any {
  const targets = Array.isArray(target) ? target : [target]
  if (targets.length === 0) {
    return { success: false, damages: [], totalDamage: 0, results: [], message: '没有目标' } as DamageBatchResult
  }

  const activeChain = activeDamageChains.get(battle)
  if (activeChain) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_REENTRANT_CALL',
      'Nested dealDamage calls must enqueue follow-up damage through context.damageQueue',
      damageContext(battle, attacker, skillId, {
        chainId: activeChain.chainId,
        parentBatchId: activeChain.currentBatchId,
        depth: (activeChain.currentDepth ?? 0) + 1,
      }),
    )
  }

  const chain: DamageChain = {
    pending: [],
    processedBatches: 0,
    fallbackStart: (battle.actions || []).filter(action => action.type === 'damage').length,
    sequence: 0,
  }
  const rootRequest: DamageBatchRequest = {
    attacker,
    targets,
    baseDamage,
    damageType,
    skillId,
    skipBeforeTrigger,
    killerPlayerId,
    selectedOption,
    depth: 0,
  }
  activeDamageChains.set(battle, chain)
  try {
    const rootResult = resolveDamageBatch(rootRequest, battle, chain)
    while (chain.pending.length > 0) {
      const followUp = chain.pending.shift()!
      // A prior batch may already have removed a reflected target. That follow-up
      // has no remaining state to affect and is deterministically skipped.
      followUp.targets = followUp.targets.filter(candidate => battle.pieces.some(piece => (
        piece.instanceId === candidate.instanceId && piece.currentHp > 0
      )))
      if (followUp.targets.length === 0) continue
      resolveDamageBatch(followUp, battle, chain)
    }

    return Array.isArray(target) ? rootResult : rootResult.results[0]
  } finally {
    activeDamageChains.delete(battle)
  }
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
export function healDamage(healer: PieceInstance, target: PieceInstance | PieceInstance[], baseHeal: number, battle: BattleState, skillId?: string): any {
  // 支持传入目标数组：beforeHealDealt 只触发一次，buff 只消耗一次，对所有目标生效
  if (Array.isArray(target)) {
    if (target.length === 0) {
      return { success: false, heals: [], totalHeal: 0, results: [], message: '没有目标' };
    }
    const healCtx = {
      type: "beforeHealDealt" as const,
      piece: healer,
      sourcePiece: healer,
      targetPiece: target[0],
      target: target[0],
      heal: baseHeal,
      skillId
    };
    const beforeRes = checkSynchronousTriggers(battle, healCtx);
    if (beforeRes.blocked) {
      if (!battle.actions) battle.actions = [];
      battle.actions.push({
        type: "triggerEffect",
        playerId: healer.ownerPlayerId,
        turn: battle.turn.turnNumber,
        payload: { message: `${healer.name || healer.templateId}的治疗被规则阻止` }
      });
      return { success: false, heals: [], totalHeal: 0, results: [], message: '治疗被规则阻止' };
    }
    const modifiedHeal = healCtx.heal;
    const results = target.map(t => healDamage(healer, t, modifiedHeal, battle, skillId));
    const heals = results.map((r: any) => r.heal || 0);
    const totalHeal = heals.reduce((sum: number, h: number) => sum + h, 0);
    return { success: true, heals, totalHeal, results, message: `为${target.length}个目标共回复${totalHeal}点生命值` };
  }

  // 创建一个可修改的上下文对象，触发器可以直接修改其中的值
  // piece = 治疗者（事件源），target = 被治疗者（事件目标）
  const healContext = {
    type: "beforeHealDealt" as const,
    piece: healer,
    sourcePiece: healer,
    targetPiece: target,
    target: target,
    heal: baseHeal,
    skillId
  };

  // 触发即将造成治疗前的触发器
  const beforeHealDealtResult = checkSynchronousTriggers(battle, healContext);

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

  // 触发器可能已经修改了 healContext.heal，使用修改后的值
  const modifiedBaseHeal = healContext.heal;

  // 触发即将受到治疗前的触发器
  // piece = 被治疗者（事件源），target = 治疗者（事件目标）
  const beforeHealTakenResult = checkSynchronousTriggers(battle, {
    type: "beforeHealTaken",
    piece: target,
    sourcePiece: target,
    targetPiece: healer,
    target: healer,
    heal: modifiedBaseHeal,
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
    checkSynchronousTriggers(battle, {
      type: "afterHealBlocked",
      sourcePiece: target,
      targetPiece: healer,
      heal: modifiedBaseHeal,
      skillId
    });

    return {
      success: false,
      heal: 0,
      targetHp: target.currentHp,
      message: "治疗被规则阻止"
    };
  }

  // 计算最终治疗值（使用触发器可能修改后的值）
  const finalHeal = Math.max(0, Math.floor(modifiedBaseHeal));
  
  // 记录原始生命值
  const originalHp = target.currentHp;
  
  // 应用治疗
  target.currentHp = Math.min(target.maxHp, target.currentHp + finalHeal);
  
  // 计算实际治疗量
  const actualHeal = target.currentHp - originalHp;
  
  // 触发治疗相关的触发器
  checkSynchronousTriggers(battle, {
    type: "afterHealDealt",
    sourcePiece: healer,
    targetPiece: target,
    heal: actualHeal,
    skillId
  });
  
  checkSynchronousTriggers(battle, {
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
    battleDebugLog('=== executeSkillFunction called ===');
    battleDebugLog('Skill ID:', skillDef.id);
    battleDebugLog('Context piece instanceId:', context.piece.instanceId);
    battleDebugLog('Battle pieces count:', battle.pieces.length);
    battleDebugLog('Context target:', context.target);
    
    // 找到源棋子
    const pieceIndex = battle.pieces.findIndex(p => p.instanceId === context.piece.instanceId);
    battleDebugLog('Piece index in battle.pieces:', pieceIndex);
    
    if (pieceIndex === -1) {
      throw new Error('Source piece not found')
    }
    
    // 直接使用battle.pieces中的元素，确保是直接引用
    const sourcePiece = battle.pieces[pieceIndex];
    battleDebugLog('Found source piece:', sourcePiece);
    
    battleDebugLog('Source piece before skill:', {
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
      selectOption: effects.selectOption,
      
      // 效果函数
      teleport: effects.teleport,
      dealDamage: effects.dealDamage,
      healDamage: effects.healDamage,
      traceProjectile: (
        origin: { x: number; y: number },
        direction: { x: number; y: number },
        options?: { excludePieceId?: string; maxDistance?: number },
      ) => traceProjectilePath(battle, origin, direction, options),

      // 状态效果函数
      addStatusEffectById: (targetPieceId: string, statusObject: any) => {
        // 找到目标棋子
        const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
        if (targetPiece) {
          // 确保statusTags数组存在
          if (!targetPiece.statusTags) {
            targetPiece.statusTags = [];
          }

          // 状态名称映射表
          const statusNameMap: Record<string, string> = {
            'anti-heal': '禁疗',
            'sleep': '睡眠',
            'freeze': '冰冻',
            'bleeding': '流血',
            'divine-shield': '圣盾',
            'nano-boost': '纳米强化',
            'immobilize': '定身',
            'hardy-block': '悍猛格挡',
            'bone-storm': '白骨风暴',
          };

          // 创建状态对象
          const newStatus = {
            ...statusObject,
            id: statusObject.id,
            type: statusObject.type,
            name: statusObject.name || statusNameMap[statusObject.type] || statusObject.type,
            remainingDuration: statusObject.currentDuration ?? statusObject.remainingDuration,
            remainingUses: statusObject.currentUses ?? statusObject.remainingUses,
            intensity: statusObject.intensity,
            stacks: statusObject.stacks,
            value: statusObject.value, // 添加数值属性值
            extraValue: statusObject.extraValue, // 添加额外数值属性（如暴风雪的Y坐标）
            damage: statusObject.damage, // 添加伤害值（如暴风雪的伤害）
            relatedRules: statusObject.relatedRules || [] // 使用传入的关联规则数组，如果没有则默认为空数组
          };

          // 添加到状态标签数组
          targetPiece.statusTags.push(newStatus);
          // 触发状态施加后事件
          checkSynchronousTriggers(battle, {
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
        writeLog('[removeStatusEffectById] Called with targetPieceId: ' + targetPieceId + ', statusId: ' + statusId);
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
                  battleDebugLog(`Removing rule ${ruleId} because no other status tags are related to it`);
                  targetPiece.rules.splice(ruleIndex, 1);
                }
              }
            });
          }
          
          // 从状态标签数组中移除指定状态
          targetPiece.statusTags.splice(statusTagIndex, 1);
          writeLog('[removeStatusEffectById] Status ' + statusId + ' removed from ' + targetPiece.name + ', triggering afterStatusRemoved');
          // 触发状态移除后事件
          const triggerResult = checkSynchronousTriggers(battle, {
            type: "afterStatusRemoved",
            sourcePiece: targetPiece,
            statusId: statusId,
            playerId: targetPiece.ownerPlayerId
          });
          writeLog('[removeStatusEffectById] afterStatusRemoved trigger result: ' + JSON.stringify(triggerResult));
          return true;
        }
        return false;
      },
      // 规则管理函数
      addRuleById: (targetPieceId: string, ruleId: string) => {
        battleDebugLog(`[addRuleById] Called with targetPieceId: ${targetPieceId}, ruleId: ${ruleId}`);
        // 找到目标棋子
        const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
        if (targetPiece) {
          battleDebugLog(`[addRuleById] Found target piece: ${targetPiece.name}`);
          // 从文件中加载规则
          const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD);
          if (rule) {
            battleDebugLog(`[addRuleById] Loaded rule: ${rule.id}, effect is function: ${typeof rule.effect === 'function'}`);
            // 创建规则对象的副本并添加关联状态标签数组
            const newRule = {
              ...rule,
              relatedStatusTags: [] as string[] // 添加关联状态标签数组
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
            battleDebugLog(`[addRuleById] Rule added successfully. Piece now has ${targetPiece.rules.length} rules`);
            return true;
          } else {
            console.error(`[addRuleById] Failed to load rule: ${ruleId}`);
          }
        } else {
          console.error(`[addRuleById] Target piece not found: ${targetPieceId}`);
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
      /** 触发任意字符串名称的事件（包括自定义事件，其他效果可通过 "on" 字段监听） */
      fireEvent: (eventName: string, ctx: any) => {
        return globalTriggerSystem.fireEvent(battle, context as any, eventName, ctx)
      },
      // 技能管理函数
      addSkillById: (targetPieceId: string, skillId: string) => {
        const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
        if (targetPiece) {
          if (!targetPiece.skills) targetPiece.skills = [];
          const existingSkill = targetPiece.skills.find(skill => skill.skillId === skillId);
          if (!existingSkill) {
            const newSkill = { skillId: skillId, currentCooldown: 0 };
            targetPiece.skills.push(newSkill);
            if ((targetPiece as any).displaySkills !== undefined) {
              const alreadyInDisplay = (targetPiece as any).displaySkills.some((s: any) =>
                (typeof s === 'string' ? s : s.skillId) === skillId);
              if (!alreadyInDisplay) (targetPiece as any).displaySkills.push(newSkill);
            }
            if (!battle.skillsById[skillId]) {
              const loaded = loadSkillById(skillId);
              if (loaded) battle.skillsById[skillId] = loaded;
            }
            return true;
          }
        }
        return false;
      },
      removeSkillById: (targetPieceId: string, skillId: string) => {
        const targetPiece = battle.pieces.find(p => p.instanceId === targetPieceId);
        if (targetPiece && targetPiece.skills) {
          const originalLength = targetPiece.skills.length;
          targetPiece.skills = targetPiece.skills.filter(skill => skill.skillId !== skillId);
          if ((targetPiece as any).displaySkills !== undefined) {
            (targetPiece as any).displaySkills = (targetPiece as any).displaySkills.filter((s: any) =>
              (typeof s === 'string' ? s : s.skillId) !== skillId);
          }
          return targetPiece.skills.length < originalLength;
        }
        return false;
      },
      // 手牌管理函数
      addCardToHand: (cardId: string, targetPlayerId?: string) => {
        const pid = targetPlayerId || sourcePiece.ownerPlayerId
        return addCardToHandWithTriggers(battle, cardId, pid, sourcePiece)
      },
      discardCard: (instanceId: string) => {
        if (!battle.players) return false
        for (const player of battle.players) {
          if (!player.hand) continue
          const idx = player.hand.findIndex(c => c.instanceId === instanceId)
          if (idx !== -1) {
            const [card] = player.hand.splice(idx, 1)
            if (!player.discardPile) player.discardPile = []
            player.discardPile.push(card.cardId)
            return true
          }
        }
        return false
      },
      getHand: (targetPlayerId?: string) => {
        const pid = targetPlayerId || sourcePiece.ownerPlayerId
        const player = battle.players?.find(p => p.playerId === pid)
        return player?.hand ?? []
      },
      // 辅助函数
      getAllEnemiesInRange: (range: number) => getAllEnemiesInRange(context, range, battle),
      getAllAlliesInRange: (range: number) => getAllAlliesInRange(context, range, battle),
      calculateDistance,
      isTargetInRange: (target: any, range: number) => isTargetInRange(context, target, range),
      
      // 玩家规则管理函数
      addPlayerRuleById: (targetPlayerId: string, ruleId: string) => {
        battleDebugLog(`[addPlayerRuleById] Called with targetPlayerId: ${targetPlayerId}, ruleId: ${ruleId}`);
        const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
        if (!player) {
          battleDebugLog(`[addPlayerRuleById] Player not found: ${targetPlayerId}`);
          return false;
        }
        battleDebugLog(`[addPlayerRuleById] Found player: ${player.playerId}`);
        const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD);
        if (!rule) {
          battleDebugLog(`[addPlayerRuleById] Rule not found: ${ruleId}`);
          return false;
        }
        battleDebugLog(`[addPlayerRuleById] Loaded rule: ${(rule as any).id}`);
        if (!player.rules) player.rules = [];
        if (player.rules.some((r: any) => r.id === ruleId)) {
          battleDebugLog(`[addPlayerRuleById] Rule already exists: ${ruleId}`);
          return false;
        }
        player.rules.push(rule);
        battleDebugLog(`[addPlayerRuleById] Rule added successfully. Player now has ${player.rules.length} rules`);
        return true;
      },
      removePlayerRuleById: (targetPlayerId: string, ruleId: string) => {
        const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
        if (!player?.rules) return false;
        player.rules = player.rules.filter((r: any) => r.id !== ruleId);
        return true;
      },
      addPlayerSkillById: (targetPlayerId: string, skillId: string) => {
        const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
        if (!player) return false;
        if (!player.skills) player.skills = [];
        if (player.skills.some((s: any) => s.skillId === skillId)) return false;
        player.skills.push({ skillId, currentCooldown: 0 });
        return true;
      },
      removePlayerSkillById: (targetPlayerId: string, skillId: string) => {
        const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
        if (!player?.skills) return false;
        player.skills = player.skills.filter((s: any) => s.skillId !== skillId);
        return true;
      },
      addPlayerStatusEffectById: (targetPlayerId: string, statusObject: any) => {
        const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
        if (!player) return false;
        if (!player.statusTags) player.statusTags = [];
        player.statusTags.push({
          ...statusObject,
          name: statusObject.name || statusObject.type,
          remainingDuration: statusObject.currentDuration ?? statusObject.remainingDuration,
          remainingUses: statusObject.currentUses ?? statusObject.remainingUses,
          relatedRules: statusObject.relatedRules || []
        });
        return true;
      },
      removePlayerStatusEffectById: (targetPlayerId: string, statusId: string) => {
        const player = battle.players?.find(p => p.playerId === targetPlayerId) as any;
        if (!player?.statusTags) return false;
        const idx = player.statusTags.findIndex((t: any) => t.id === statusId);
        if (idx !== -1) { player.statusTags.splice(idx, 1); return true; }
        return false;
      },

      // 工具函数
      Math: getRuleMath(),
      Date: getRuleDate(),
      console
    }

    // 记录技能执行前的状态
    const beforeState = {
      enemies: battle.pieces.filter(p => p.ownerPlayerId !== sourcePiece.ownerPlayerId && p.currentHp > 0).map(p => ({ instanceId: p.instanceId, currentHp: p.currentHp }))
    };

    // 执行技能定义中的代码（所有技能统一走动态代码运行时，不存在硬编码分支）
    if (skillDef.code) {
      try {
        battleDebugLog('Executing skill code via dynamic runtime, skillId:', skillDef.id);
        battleDebugLog('Skill code:', skillDef.code.substring(0, 100) + '...');
        {
          // 所有技能经统一动态代码运行时执行，确保效果完全由 code 字段控制
          const fullSkillCode = `
            (function(environment) {
              // 定义全局变量
              const context = environment.context;
              const sourcePiece = environment.sourcePiece;
              const battle = environment.battle;
              const select = environment.select;
              const selectTarget = environment.selectTarget;
              const selectOption = environment.selectOption;
              const teleport = environment.teleport;
              const addStatusEffectById = environment.addStatusEffectById;
              const getAllEnemiesInRange = environment.getAllEnemiesInRange;
              const getAllAlliesInRange = environment.getAllAlliesInRange;
              const calculateDistance = environment.calculateDistance;
              const isTargetInRange = environment.isTargetInRange;
              const dealDamage = environment.dealDamage;
              const healDamage = environment.healDamage;
              const addRuleById = environment.addRuleById;
              const traceProjectile = environment.traceProjectile;
              const removeRuleById = environment.removeRuleById;
              const addPlayerRuleById = environment.addPlayerRuleById;
              const removePlayerRuleById = environment.removePlayerRuleById;
              const addPlayerSkillById = environment.addPlayerSkillById;
              const removePlayerSkillById = environment.removePlayerSkillById;
              const addPlayerStatusEffectById = environment.addPlayerStatusEffectById;
              const removePlayerStatusEffectById = environment.removePlayerStatusEffectById;
              const removeStatusEffectById = environment.removeStatusEffectById;
              const addSkillById = environment.addSkillById;
              const removeSkillById = environment.removeSkillById;
              const addCardToHand = environment.addCardToHand;
              const discardCard = environment.discardCard;
              const getHand = environment.getHand;
              const fireEvent = environment.fireEvent;
              const Math = environment.Math;
              const Date = environment.Date;
              const console = environment.console;

              // 定义技能执行函数
              ${skillDef.code}
              
              // 执行技能
              return executeSkill(context);
            })
          `;

          // 调试：检查 skillEnvironment 中是否包含 addPlayerRuleById
          battleDebugLog('[executeSkillFunction] skillEnvironment.addPlayerRuleById:', typeof skillEnvironment.addPlayerRuleById);
          
          // 执行技能代码
          const executeSkill = dynamicCodeRuntime.compileExpression<(environment: typeof skillEnvironment) => SkillExecutionResult>({
            surface: 'skillCode', contentId: skillDef.id, code: fullSkillCode, entry: 'executeSkill(context)',
          });
          let result = executeSkill(skillEnvironment);
          
          battleDebugLog('Skill execution result:', result);
          battleDebugLog('result.needsOptionSelection:', result && result.needsOptionSelection);
          
          // 检查是否需要目标选择
          if (result && result.needsTargetSelection) {
            battleDebugLog('Need target selection:', result);
            // 直接返回需要目标选择的结果
            // 目标选择完全由selectTarget函数控制
            // 当用户选择目标后，前端会重新发送请求，selectTarget函数会处理目标信息
            return {
              message: '需要选择目标',
              success: false,
              needsTargetSelection: true,
              targetType: result.targetType || 'piece',
              range: result.range || 5,
              filter: result.filter || 'enemy',
              targetIndex: result.targetIndex
            };
          }

          // 检查是否需要选项选择
          battleDebugLog('Checking for option selection, result:', result);
          if (result && result.needsOptionSelection) {
            battleDebugLog('Need option selection:', result);
            return {
              message: '需要选择选项',
              success: false,
              needsOptionSelection: true,
              options: result.options || [],
              title: result.title || '请选择'
            };
          }
          
          battleDebugLog('Source piece after skill:', {
            instanceId: sourcePiece.instanceId,
            attack: sourcePiece.attack,
            maxHp: sourcePiece.maxHp,
            currentHp: sourcePiece.currentHp
          });
          
          // sourcePiece 是 battle.pieces[pieceIndex] 的直接引用，技能执行期间对它的所有修改
          // 已经直接反映到 battle.pieces 中，无需重新赋值。
          // 注意：如果技能执行期间有棋子被击杀（从 battle.pieces splice 移除），pieceIndex 会失效，
          // 重新赋值会覆盖错误的位置并导致棋子重复。因此移除该赋值。

          // 检查是否有伤害和击杀
          checkForDamageAndKill(battle, beforeState, sourcePiece, skillDef.id);

          // 仅在技能成功时触发 afterSkillUsed（失败技能不计入"释放技能"次数）
          if (result && result.success && !(battle as any).extensions?.__dryRunSkillPreflight) {
            const skillUsedResult = checkSynchronousTriggers(battle, {
              type: "afterSkillUsed",
              sourcePiece,
              skillId: skillDef.id
            });

            // 处理触发效果的消息
            if (skillUsedResult.success && skillUsedResult.messages.length > 0) {
              result.message = (result.message || '') + "。" + skillUsedResult.messages.join("。");
            }
          }

          return result;
        }
      } catch (error) {
        if (isSuspendableActionPending(error)) throw error
        if ((error as any)?.needsOptionSelection || (error as any)?.needsTargetSelection) {
          return error as SkillExecutionResult
        }
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
function checkForDamageAndKill(_battle: BattleState, _beforeState: any, _sourcePiece: PieceInstance, _skillId: string) {
  // afterDamageDealt and afterPieceKilled are already fired inside dealDamage() for each hit.
  // Firing them again here would cause double-counting in rules like rule-shishio-combustion.
  // This function is intentionally left as a no-op.
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
        (function(environment) {
          const piece = environment.piece;
          const skillDef = environment.skillDef;
          const currentCooldown = environment.currentCooldown;
          const calculateDistance = environment.calculateDistance;
          const Math = environment.Math;
          ${skillDef.previewCode}
          return calculatePreview(piece, skillDef, currentCooldown);
        })
      `

      // 执行预览函数
      const calculatePreview = dynamicCodeRuntime.compileExpression<(environment: typeof previewEnvironment) => any>({
        surface: 'previewCode', contentId: skillDef.id, code: previewCode, entry: 'calculatePreview(piece, skillDef, currentCooldown)',
      })
      const result = calculatePreview(previewEnvironment)
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

  // 无 previewCode 时的通用 fallback：仅展示静态描述，不硬编码任何技能逻辑
  return {
    description: skillDef.description,
    expectedValues: {},
    cooldown: skillDef.cooldownTurns,
    currentCooldown,
    chargeCost: skillDef.chargeCost
  }
}
