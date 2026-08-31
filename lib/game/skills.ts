import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"
import { globalTriggerSystem, type TriggerResult } from "./triggers"
import { rng } from "./rng"
import {
  getActiveRuleExecutionContext,
  getActiveRuleRuntime,
  getRuleExecutionTriggerSystem,
  getRuleDate,
  getRuleMath,
} from './rule-runtime'

const getActiveTriggerSystem = () => getRuleExecutionTriggerSystem(globalTriggerSystem)
import { getDataRoot, getUserDataDir } from '@/lib/app-paths'
import { manhattanDistance, traceProjectile as traceProjectilePath } from './spatial'
import { DynamicCodeRuntime, dynamicCodeRuntime as globalDynamicCodeRuntime } from './dynamic-code-runtime'
import { isSuspendableActionPending } from './suspendable-action-transaction'
import {
  EffectChain,
  EffectChainFatalError,
  createDamageQueueWriter,
  createDeclaredSummonQueueWriter,
  createEffectChain,
  createHealQueueWriter,
  getActiveEffectChain,
  installEffectChain,
  isEffectChainFatalError,
  isTrustedDeclaredSummonCapability,
  rejectEffectBatch,
  type DamageRequest,
  type DeathRequest,
  type DeclaredSummonCapability,
  type DeclaredSummonSpec,
  type EffectBatchContext,
  type EffectExecution,
  type SourceMirrorSummonCapabilityDeclaration,
  type StoredOrDeclaredPieceSummonCapabilityDeclaration,
  type SummonCapabilityDeclaration,
  type SummonRequest,
} from './effect-batch'

const FORCE_RULE_RELOAD = process.env.RVB_FORCE_RULE_RELOAD === '1'
function battleDebugLog(...args: unknown[]): void {
  if (typeof process === 'undefined' || process.env?.RVB_BATTLE_DEBUG_LOGS !== '1') return
  console.log(...args)
}

export interface ChargeCostModifierDefinition {
  source: 'battleExtensionPlayerNumber'
  path: string
  operation: 'add' | 'subtract'
  minimum?: number
}

function readExtensionPath(extensions: Record<string, unknown> | undefined, path: string): unknown {
  if (!extensions || !path) return undefined
  let value: unknown = extensions
  for (const segment of path.split('.')) {
    if (!segment || !value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

function readPlayerNumber(value: unknown, playerId: string): number {
  if (!value || typeof value !== 'object') return 0
  const match = Object.entries(value as Record<string, unknown>)
    .find(([key]) => key.toLowerCase() === playerId.toLowerCase())
  const number = Number(match?.[1])
  return Number.isFinite(number) ? number : 0
}

export function getEffectiveChargeCost(
  state: BattleState,
  playerId: string,
  skill: Pick<SkillDefinition, 'chargeCost' | 'chargeCostModifiers'> | undefined,
): number {
  let cost = Math.max(0, Number.isFinite(skill?.chargeCost) ? Number(skill?.chargeCost) : 0)
  for (const modifier of skill?.chargeCostModifiers || []) {
    if (modifier.source !== 'battleExtensionPlayerNumber') continue
    const value = readPlayerNumber(readExtensionPath(state.extensions, modifier.path), playerId)
    cost = modifier.operation === 'add' ? cost + value : cost - value
    cost = Math.max(Number.isFinite(modifier.minimum) ? Number(modifier.minimum) : 0, cost)
  }
  return Math.max(0, cost)
}

function checkSynchronousTriggers(battle: BattleState, context: any): TriggerResult {
  const result = getActiveTriggerSystem().checkTriggers(battle, context)
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

interface SkillExecutionCaches {
  ruleCache: Map<string, TriggerRule>
  skillDefinitionCache: Map<string, SkillDefinition>
  allSkillDefinitionsCache: Record<string, SkillDefinition> | null
  cardCache: Map<string, CardDefinition>
  dynamicCodeRuntime: DynamicCodeRuntime
}

const SKILL_EXECUTION_CACHES = Symbol.for('rvb.rule-execution.skill-caches.v1')
const globalSkillExecutionCaches: SkillExecutionCaches = {
  ruleCache: new Map(),
  skillDefinitionCache: new Map(),
  allSkillDefinitionsCache: null,
  cardCache: new Map(),
  dynamicCodeRuntime: globalDynamicCodeRuntime,
}

function getSkillExecutionCaches(): SkillExecutionCaches {
  const context = getActiveRuleExecutionContext()
  if (!context) return globalSkillExecutionCaches
  const existing = context.cache.get(SKILL_EXECUTION_CACHES)
  if (existing) return existing as SkillExecutionCaches
  const caches: SkillExecutionCaches = {
    ruleCache: new Map(),
    skillDefinitionCache: new Map(),
    allSkillDefinitionsCache: null,
    cardCache: new Map(),
    dynamicCodeRuntime: new DynamicCodeRuntime(),
  }
  context.cache.set(SKILL_EXECUTION_CACHES, caches)
  return caches
}

export function getRuleDynamicCodeRuntime(): DynamicCodeRuntime {
  return getSkillExecutionCaches().dynamicCodeRuntime
}

// 清除规则缓存的函数
export function clearRuleCache(): void {
  getSkillExecutionCaches().ruleCache.clear()
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

export type ActionAvailabilityDefinition =
  | {
      kind: 'sourceStatus'
      statusType: string
      present: boolean
      message?: string
    }
  | {
      kind: 'battleExtensionArray'
      path: string
      minLength: number
      message?: string
    }
  | {
      kind: 'livingPieceAbsent'
      templateId: string
      unlessExtensionPath?: string
      message?: string
    }

export interface ExtensionCellRequirementDefinition {
  path: string
  sourceIdField?: string
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
      minRange?: number
      distanceMetric?: 'manhattan' | 'chebyshev'
      requireWalkable?: boolean
      requireUnoccupied?: boolean
      allowSourceOccupant?: boolean
      allowSourceOccupantOptions?: unknown[]
      sameRowOrColumn?: boolean
      excludeSourceCell?: boolean
      excludeSourcePiece?: boolean
      forbiddenColumns?: number[]
      forbiddenTargetStatuses?: string[]
      requiredTargetStatuses?: string[]
      requireOpenCardinalLanding?: boolean
      requireTraversableFirstStep?: boolean
      requireExtensionCell?: ExtensionCellRequirementDefinition
      ignoreOccupantSelectedTargetIndex?: number
      requireEnemyWithinRange?: number
      projectile?: { requiredCollision: 'piece-before-blocker' }
    }

export interface SelectionContractDefinition {
  source?: {
    templateId?: string
    boundInstanceField?: string
  }
  availability?: ActionAvailabilityDefinition[]
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
  /** Trusted, closed declaration that binds a sealed summon writer for this content. */
  summonCapability?: SummonCapabilityDeclaration
}

/** 清除卡牌缓存（服务器热重载后调用） */
export function clearCardCache() {
  getSkillExecutionCaches().cardCache.clear()
}

/** 从 data/cards/{cardId}.json 加载卡牌定义（带缓存） */
export function loadCardById(cardId: string, forceReload = false): CardDefinition | null {
  const cardCache = getSkillExecutionCaches().cardCache
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
function applyCardEffectModifiers(
  cardInstance: any,
  effect: 'damage' | 'heal' | 'statusIntensity',
  baseValue: number,
  statusType?: string,
): number {
  let value = baseValue
  for (const modifier of cardInstance?.effectModifiers || []) {
    if (modifier?.effect !== effect) continue
    if (modifier.statusType && modifier.statusType !== statusType) continue
    const operand = Number(modifier.value)
    if (!Number.isFinite(operand)) continue
    value = modifier.operation === 'add' ? value + operand : value * operand
  }
  return Math.floor(value)
}


/** 为卡牌效果构建执行环境（没有 sourcePiece，用 playerId 判断阵营） */
function createCardEffectFunctions(
  battle: BattleState,
  playerId: string,
  context: any,
) {
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
        selectionMode: config.selectionMode,
        presentation: config.presentation,
        minSelections: config.minSelections,
        maxSelections: config.maxSelections,
      }
    },

    dealDamage: (attacker: PieceInstance, target: PieceInstance | PieceInstance[], baseDamage: number, damageType: DamageType = 'true', _battleState?: BattleState, skillId?: string) => {
      baseDamage = applyCardEffectModifiers(context.cardInstance, 'damage', baseDamage)
      return dealDamage(attacker, target, baseDamage, damageType, battle, skillId, false, undefined, context.selectedOption)
    },

    healDamage: (healer: PieceInstance, target: PieceInstance | PieceInstance[], baseHeal: number, _battleState?: BattleState, skillId?: string) => {
      baseHeal = applyCardEffectModifiers(context.cardInstance, 'heal', baseHeal)
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
      const resolvedStatusObject = {
        ...statusObject,
        intensity: applyCardEffectModifiers(
          context.cardInstance,
          'statusIntensity',
          Number(statusObject.intensity || 0),
          statusObject.type,
        ),
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
  const sealedContent = beginSealedContentExecution(battle, cardDef)
  let restoreSummonQueueContext: (() => void) | undefined
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
    restoreSummonQueueContext = bindDeclaredSummonQueueContext(context, sealedContent)

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
    const executeCard = getSkillExecutionCaches().dynamicCodeRuntime.compileExpression<(environment: typeof env) => SkillExecutionResult>({
      surface: 'cardCode', contentId: cardDef.id, code: fullCode, entry: 'executeCard(context)',
    })
    const result = executeCard(env)
    finishSealedContentExecution(battle, sealedContent)
    return result || { success: false, message: '卡牌效果无返回值' }
  } catch (error: any) {
    if (isSuspendableActionPending(error)) throw error
    if (error?.needsTargetSelection) return error as SkillExecutionResult
    if (error?.needsOptionSelection) return error as SkillExecutionResult
    if (isEffectChainFatalError(error)) throw error
    console.error(`[executeCardFunction] Error executing card ${cardDef.id}:`, error)
    return { success: false, message: `卡牌执行失败: ${error?.message || error}` }
  } finally {
    restoreSummonQueueContext?.()
    sealedContent.cleanup?.()
  }
}

// 从文件中加载技能定义（用于 addSkillById 同步到 battle.skillsById）
function loadSkillById(skillId: string): SkillDefinition | null {
  const skillDefinitionCache = getSkillExecutionCaches().skillDefinitionCache
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
  const caches = getSkillExecutionCaches()
  caches.skillDefinitionCache.clear()
  caches.allSkillDefinitionsCache = null
}

// 加载所有技能定义（服务端用，用于重新填充 battle.skillsById）
export function loadAllSkillsById(): Record<string, SkillDefinition> {
  const caches = getSkillExecutionCaches()
  if (caches.allSkillDefinitionsCache && !FORCE_RULE_RELOAD) return caches.allSkillDefinitionsCache
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
    caches.allSkillDefinitionsCache = result
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
  const ruleCache = getSkillExecutionCaches().ruleCache
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
                  const removedStatus = targetPiece.statusTags[idx];
                  targetPiece.statusTags.splice(idx, 1);
                  checkSynchronousTriggers(battle, {
                    type: "afterStatusRemoved",
                    sourcePiece: targetPiece,
                    statusId: statusId,
                    statusType: removedStatus.type,
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
                selectionMode: config.selectionMode,
                presentation: config.presentation,
                minSelections: config.minSelections,
                maxSelections: config.maxSelections,
              };
            };

            const fireEvent = (eventName: string, ctx: any) => {
              return getActiveTriggerSystem().fireEvent(battle, context, eventName, ctx);
            };

            const codeEnvironment = `
              (function(battle, context, dealDamage, healDamage, addCardToHand, checkToxin, addStatusEffectById, removeStatusEffectById, addPlayerRuleById, removePlayerRuleById, addRuleById, removeRuleById, addPlayerStatusEffectById, removePlayerStatusEffectById, addPlayerSkillById, removePlayerSkillById, selectOption, fireEvent, Math, Date) {
                ${ruleData.skillCode}
              })
            `;
            const executeRuleCode = getSkillExecutionCaches().dynamicCodeRuntime.compileExpression<any>({
              surface: 'ruleSkillCode', contentId: ruleId, code: codeEnvironment, entry: 'rule skillCode body',
            });
            const result = executeRuleCode(battle, context, globalDealDamage, globalHealDamage, addCardToHand, checkToxin, addStatusEffectById, removeStatusEffectById, addPlayerRuleById, removePlayerRuleById, addRuleById, removeRuleById, addPlayerStatusEffectById, removePlayerStatusEffectById, addPlayerSkillById, removePlayerSkillById, selectOption, fireEvent, getRuleMath(), getRuleDate());
            if (result && result.needsOptionSelection) return result;
            return result || { success: false, message: '' };
          } catch (error) {
            if (isSuspendableActionPending(error)) throw error
            if (isEffectChainFatalError(error)) throw error
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
                const sealedContent = beginSealedContentExecution(battle, skillDef)
                let restoreSummonQueueContext: (() => void) | undefined
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
                  restoreSummonQueueContext = bindDeclaredSummonQueueContext(context, sealedContent)
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
                        const newStatus = {
                          ...statusObject,
                          name: statusObject.name || statusObject.type,
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
                          const removedStatus = targetPiece.statusTags[statusTagIndex];
                          targetPiece.statusTags.splice(statusTagIndex, 1);
                          // 触发状态移除后事件
                          checkSynchronousTriggers(battle, {
                            type: "afterStatusRemoved",
                            sourcePiece: targetPiece,
                            statusId: statusId,
                            statusType: removedStatus.type,
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
                  const executeTriggeredSkill = getSkillExecutionCaches().dynamicCodeRuntime.compileExpression<(environment: typeof skillEnvironment) => SkillExecutionResult>({
                    surface: 'ruleTriggerSkill', contentId: skillId, code: fullSkillCode, entry: 'executeSkill(context)',
                  });
                  const result = executeTriggeredSkill(skillEnvironment);
                  finishSealedContentExecution(battle, sealedContent)
                  writeLog(`[triggerSkill] Skill execution result for ${skillId}: ${JSON.stringify(result)}`);
                  battleDebugLog(`Skill execution result:`, result);
                  return result;
                } catch (error) {
                  if (isSuspendableActionPending(error)) throw error
                  if (isEffectChainFatalError(error)) throw error
                  console.error('Error executing skill in rule effect:', error);
                  return { success: false, message: '技能执行失败' };
                } finally {
                  restoreSummonQueueContext?.()
                  sealedContent.cleanup?.()
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
  selectionMode?: 'single' | 'multi'
  presentation?: 'picker' | 'hand'
  minSelections?: number
  maxSelections?: number
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
  /** 玩家可见的机制关键词。 */
  keywords?: string[]
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
  /** 数据声明的通用充能消耗修正；核心只解释来源和算术，不识别内容关键词。 */
  chargeCostModifiers?: ChargeCostModifierDefinition[]
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
  /** Trusted, closed declaration that binds a sealed summon writer for this content. */
  summonCapability?: SummonCapabilityDeclaration
  /** When true, cancelling any synthetic post-effect target rolls back the entire skill transaction. */
  rollbackPendingTargetOnCancel?: boolean
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
      selectionMode?: 'single' | 'multi';
      presentation?: 'picker' | 'hand';
      minSelections?: number;
      maxSelections?: number;
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
        selectionMode: config.selectionMode,
        presentation: config.presentation,
        minSelections: config.minSelections,
        maxSelections: config.maxSelections,
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
  depth?: number
  enqueueSequence?: number
  deathBatchId?: string
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

export interface HealResult {
  success: boolean
  batchId: string
  chainId: string
  parentBatchId?: string
  sourceId: string
  targetId: string
  skillId?: string
  rawHeal: number
  modifiedHeal: number
  heal: number
  blocked: boolean
  targetHp: number
  message: string
  depth: number
  enqueueSequence?: number
}

export interface HealBatchResult {
  success: boolean
  batchId?: string
  chainId?: string
  heals: number[]
  totalHeal: number
  results: HealResult[]
  message: string
  blocked?: boolean
}

interface PreparedDamage {
  target: PieceInstance
  hpBefore: number
  result: DamageResult
  emitBlocked: boolean
}

interface PreparedHeal {
  target: PieceInstance
  hpBefore: number
  nextHp: number
  result: HealResult
}

interface DeathBatchResolution {
  batchId: string
  chainId: string
  killedIds: readonly string[]
  revivedIds: readonly string[]
}

const DAMAGE_TYPES = new Set<DamageType>(['physical', 'magical', 'true', 'toxin'])

export class DamagePipelineError extends Error {
  readonly code: string
  readonly context: Record<string, unknown>

  constructor(code: string, message: string, context: Record<string, unknown>) {
    super(message + '; context=' + JSON.stringify(context))
    this.name = 'DamagePipelineError'
    this.code = code
    this.context = context
  }
}

export class HealPipelineError extends Error {
  readonly code: string
  readonly context: Record<string, unknown>

  constructor(code: string, message: string, context: Record<string, unknown>) {
    super(message + '; context=' + JSON.stringify(context))
    this.name = 'HealPipelineError'
    this.code = code
    this.context = context
  }
}

function compareEffectTarget(left: PieceInstance, right: PieceInstance): number {
  if (left.instanceId === right.instanceId) return 0
  return left.instanceId < right.instanceId ? -1 : 1
}

function effectMetadata(context: EffectBatchContext): Record<string, unknown> {
  return {
    effectChainId: context.chainId,
    effectBatchId: context.batchId,
    parentEffectBatchId: context.parentBatchId,
    effectBatchKind: context.kind,
    effectDepth: context.depth,
    effectEnqueueSequence: context.parentBatchId === undefined ? undefined : context.enqueueSequence,
    originStage: context.originStage,
  }
}

function damageMetadata(context: EffectBatchContext): Record<string, unknown> {
  return {
    damageBatchId: context.kind === 'damage' ? context.batchId : context.parentBatchId,
    damageChainId: context.chainId,
    parentDamageBatchId: context.kind === 'damage' ? context.parentBatchId : undefined,
  }
}

function queueContext(chain: EffectChain, context: EffectBatchContext): Record<string, unknown> {
  return {
    ...effectMetadata(context),
    damageQueue: createDamageQueueWriter(chain),
    healQueue: createHealQueueWriter(chain),
  }
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

function healContext(
  battle: BattleState,
  healer: PieceInstance,
  skillId: string | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const runtime = getActiveRuleRuntime()
  return {
    sourceId: healer?.instanceId,
    playerId: healer?.ownerPlayerId,
    skillId,
    turn: battle?.turn?.turnNumber ?? 0,
    rootSeed: runtime?.rootSeed ?? null,
    ...extra,
  }
}

function validateDamageTargets(
  attacker: PieceInstance,
  targets: readonly PieceInstance[],
  baseDamage: number,
  damageType: DamageType,
  battle: BattleState,
  skillId: string | undefined,
  allowUnavailable: boolean,
): PieceInstance[] {
  if (!attacker || typeof attacker.instanceId !== 'string' || !attacker.instanceId) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_SOURCE_INVALID',
      'Damage source must have a stable instanceId',
      damageContext(battle, attacker, skillId),
    )
  }
  if (!Number.isFinite(baseDamage) || baseDamage < 0) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_VALUE_INVALID',
      'Damage must be a finite non-negative number; received ' + String(baseDamage),
      damageContext(battle, attacker, skillId, { baseDamage }),
    )
  }
  if (!DAMAGE_TYPES.has(damageType)) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_TYPE_INVALID',
      'Unsupported damage type ' + String(damageType),
      damageContext(battle, attacker, skillId, { damageType }),
    )
  }
  const seen = new Set<string>()
  const canonicalTargets: PieceInstance[] = []
  for (const requestedTarget of targets) {
    const targetId = requestedTarget?.instanceId
    if (!targetId) {
      throw new DamagePipelineError(
        'RVB_DAMAGE_TARGET_INVALID',
        'Damage target must have a stable instanceId',
        damageContext(battle, attacker, skillId),
      )
    }
    if (seen.has(targetId)) {
      throw new DamagePipelineError(
        'RVB_DAMAGE_TARGET_DUPLICATE',
        'Damage batch contains duplicate target ' + targetId,
        damageContext(battle, attacker, skillId, { targetId }),
      )
    }
    seen.add(targetId)
    const canonical = battle.pieces.find(piece => piece.instanceId === targetId)
    if (!canonical || canonical.currentHp <= 0) {
      const wasInvalidated = (canonical?.currentHp ?? requestedTarget.currentHp) <= 0
        || (battle.graveyard ?? []).some(piece => piece.instanceId === targetId)
      if (allowUnavailable && wasInvalidated) continue
      throw new DamagePipelineError(
        'RVB_DAMAGE_TARGET_UNAVAILABLE',
        'Damage target ' + targetId + ' is not an active living piece',
        damageContext(battle, attacker, skillId, { targetId }),
      )
    }
    canonicalTargets.push(canonical)
  }
  return canonicalTargets
}

function validateHealTargets(
  healer: PieceInstance,
  targets: readonly PieceInstance[],
  baseHeal: number,
  battle: BattleState,
  skillId: string | undefined,
  allowUnavailable: boolean,
): PieceInstance[] {
  if (!healer || typeof healer.instanceId !== 'string' || !healer.instanceId) {
    throw new HealPipelineError(
      'RVB_HEAL_SOURCE_INVALID',
      'Heal source must have a stable instanceId',
      healContext(battle, healer, skillId),
    )
  }
  if (!Number.isFinite(baseHeal) || baseHeal < 0) {
    throw new HealPipelineError(
      'RVB_HEAL_VALUE_INVALID',
      'Heal must be a finite non-negative number; received ' + String(baseHeal),
      healContext(battle, healer, skillId, { baseHeal }),
    )
  }
  const seen = new Set<string>()
  const canonicalTargets: PieceInstance[] = []
  for (const requestedTarget of targets) {
    const targetId = requestedTarget?.instanceId
    if (!targetId) {
      throw new HealPipelineError(
        'RVB_HEAL_TARGET_INVALID',
        'Heal target must have a stable instanceId',
        healContext(battle, healer, skillId),
      )
    }
    if (seen.has(targetId)) {
      throw new HealPipelineError(
        'RVB_HEAL_TARGET_DUPLICATE',
        'Heal batch contains duplicate target ' + targetId,
        healContext(battle, healer, skillId, { targetId }),
      )
    }
    seen.add(targetId)
    const canonical = battle.pieces.find(piece => piece.instanceId === targetId)
    if (!canonical || canonical.currentHp <= 0) {
      const wasInvalidated = (canonical?.currentHp ?? requestedTarget.currentHp) <= 0
        || (battle.graveyard ?? []).some(piece => piece.instanceId === targetId)
      if (allowUnavailable && wasInvalidated) continue
      throw new HealPipelineError(
        'RVB_HEAL_TARGET_UNAVAILABLE',
        'Heal target ' + targetId + ' is not an active living piece',
        healContext(battle, healer, skillId, { targetId }),
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

function appendHealBlockedMessage(battle: BattleState, healer: PieceInstance, message: string): void {
  battle.actions ??= []
  battle.actions.push({
    type: 'triggerEffect',
    playerId: healer.ownerPlayerId,
    turn: battle.turn?.turnNumber ?? 0,
    payload: { message },
  })
}

function finiteNonNegativeDamage(
  value: unknown,
  battle: BattleState,
  attacker: PieceInstance,
  skillId: string | undefined,
  batchId: string,
  targetId?: string,
): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new DamagePipelineError(
      'RVB_DAMAGE_MODIFIER_INVALID',
      'Damage trigger produced invalid value ' + String(value),
      damageContext(battle, attacker, skillId, { batchId, targetId }),
    )
  }
  return number
}

function finiteNonNegativeHeal(
  value: unknown,
  battle: BattleState,
  healer: PieceInstance,
  skillId: string | undefined,
  batchId: string,
  targetId?: string,
): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new HealPipelineError(
      'RVB_HEAL_MODIFIER_INVALID',
      'Heal trigger produced invalid finite non-negative value ' + String(value),
      healContext(battle, healer, skillId, { batchId, targetId }),
    )
  }
  return number
}

function rethrowInvalidEffectRequest(
  error: unknown,
  request: DamageRequest | import('./effect-batch').HealRequest,
  context: EffectBatchContext<'damage' | 'heal'>,
  chain: EffectChain,
): never {
  if (isEffectChainFatalError(error) || chain.detached || context.enqueueSequence === undefined) {
    throw error
  }
  const source = request.kind === 'damage' ? request.attacker : request.healer
  const targetIds = request.targets.map(target => target?.instanceId).filter(Boolean) as string[]
  throw new EffectChainFatalError(
    'RVB_EFFECT_CHAIN_STATE_INVALID',
    'Invalid queued ' + request.kind + ' batch request',
    {
      actionId: chain.actionId,
      chainId: chain.chainId,
      batchId: context.batchId,
      parentBatchId: context.parentBatchId,
      kind: request.kind,
      depth: context.depth,
      enqueueSequence: context.enqueueSequence,
      originStage: context.originStage,
      processed: chain.processedBatches,
      limit: chain.limits.maxBatches,
      turn: chain.turn,
      rootSeed: chain.rootSeed,
      sourceId: source?.instanceId,
      skillId: request.skillId,
      targetId: targetIds[0],
      targetIds,
      detached: false,
      budget: 'state',
    },
    error,
  )
}


function prepareDamageTarget(
  request: DamageRequest,
  target: PieceInstance,
  sourceDamage: number,
  sourceBlocked: boolean,
  context: EffectBatchContext<'damage'>,
  chain: EffectChain,
  battle: BattleState,
): PreparedDamage {
  const queues = queueContext(chain, context)
  const beforeDamageTakenContext = {
    type: 'beforeDamageTaken' as const,
    piece: target,
    sourcePiece: target,
    targetPiece: request.attacker,
    target: request.attacker,
    damage: sourceDamage,
    damageType: request.damageType,
    skillId: request.skillId,
    selectedOption: request.selectedOption,
    rawDamage: request.baseDamage,
    ...damageMetadata(context),
    ...queues,
  }
  const beforeTaken: TriggerResult = sourceBlocked
    ? { success: false, blocked: true, messages: [] }
    : checkSynchronousTriggers(battle, beforeDamageTakenContext)
  appendDamageMessages(battle, request.attacker.ownerPlayerId, beforeTaken.messages || [])
  const modifiedDamage = finiteNonNegativeDamage(
    beforeDamageTakenContext.damage,
    battle,
    request.attacker,
    request.skillId,
    context.batchId,
    target.instanceId,
  )
  let blocked = sourceBlocked || Boolean(beforeTaken.blocked)
  const defense = request.damageType === 'physical' || request.damageType === 'magical'
    ? Number(target.defense) || 0
    : 0
  let defendedDamage = 0
  if (!blocked && modifiedDamage > 0) defendedDamage = Math.max(1, Math.floor(modifiedDamage - defense))

  let shieldAbsorbed = 0
  let damageAfterShield = defendedDamage
  if (!blocked && damageAfterShield > 0) {
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
      rawDamage: request.baseDamage,
      modifiedDamage,
      defenseApplied: defense,
      ...damageMetadata(context),
      ...queues,
    }
    const shieldResult = checkSynchronousTriggers(battle, shieldContext)
    appendDamageMessages(battle, request.attacker.ownerPlayerId, shieldResult.messages || [])
    const ruleShieldDamage = finiteNonNegativeDamage(
      shieldContext.damage,
      battle,
      request.attacker,
      request.skillId,
      context.batchId,
      target.instanceId,
    )
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
      rawDamage: request.baseDamage,
      modifiedDamage,
      defenseApplied: defense,
      shieldAbsorbed,
      ...damageMetadata(context),
      ...queueContext(chain, context),
    }
    const appliedResult = checkSynchronousTriggers(battle, appliedContext)
    appendDamageMessages(battle, request.attacker.ownerPlayerId, appliedResult.messages || [])
    damageAfterShield = finiteNonNegativeDamage(
      appliedContext.damage,
      battle,
      request.attacker,
      request.skillId,
      context.batchId,
      target.instanceId,
    )
    blocked = Boolean(appliedResult.blocked) || damageAfterShield === 0
  }

  const finalDamage = blocked ? 0 : damageAfterShield
  const hpBefore = target.currentHp
  const targetName = target.name || target.templateId
  const attackerName = request.attacker.name || request.attacker.templateId
  const typeName = request.damageType === 'physical'
    ? '物理'
    : request.damageType === 'magical'
      ? '魔法'
      : request.damageType === 'toxin'
        ? '毒素'
        : '真实'
  return {
    target,
    hpBefore,
    emitBlocked: blocked && sourceDamage > 0,
    result: {
      success: !blocked,
      batchId: context.batchId,
      chainId: context.chainId,
      parentBatchId: context.parentBatchId,
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
        ? targetName + '受到的伤害被完整抵挡'
        : attackerName + '对' + targetName + '造成' + finalDamage + '点' + typeName + '伤害',
      depth: context.depth,
      enqueueSequence: context.parentBatchId === undefined ? undefined : context.enqueueSequence,
    },
  }
}

function resolveDeathBatch(
  request: DeathRequest,
  context: EffectBatchContext<'death'>,
  chain: EffectChain,
  battle: BattleState,
): DeathBatchResolution {
  const seen = new Set<string>()
  const frozen = request.candidates
    .map(candidate => {
      const targetId = candidate.piece?.instanceId
      if (!targetId || seen.has(targetId)) return undefined
      seen.add(targetId)
      const canonical = battle.pieces.find(piece => piece.instanceId === targetId)
      if (!canonical || canonical.currentHp > 0) return undefined
      return { ...candidate, piece: canonical }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => compareEffectTarget(left.piece, right.piece))
  const queues = queueContext(chain, context)
  const legacy = damageMetadata(context)

  for (const candidate of frozen) {
    checkSynchronousTriggers(battle, {
      type: 'beforePieceKilled',
      piece: candidate.piece,
      sourcePiece: candidate.piece,
      targetPiece: candidate.attacker,
      skillId: candidate.skillId,
      ...legacy,
      ...queues,
    })
    checkSynchronousTriggers(battle, {
      type: 'afterPieceKilled',
      piece: candidate.attacker,
      sourcePiece: candidate.attacker,
      targetPiece: candidate.piece,
      skillId: candidate.skillId,
      ...legacy,
      ...queues,
    })
    checkSynchronousTriggers(battle, {
      type: 'onPieceDied',
      piece: candidate.piece,
      sourcePiece: candidate.piece,
      targetPiece: candidate.attacker,
      skillId: candidate.skillId,
      ...legacy,
      ...queues,
    })
  }

  const finalizable = frozen.filter(candidate => (
    candidate.piece.currentHp <= 0
    && battle.pieces.some(piece => piece.instanceId === candidate.piece.instanceId)
  ))
  const removedIds = new Set(finalizable.map(candidate => candidate.piece.instanceId))
  const removedById = new Map(
    battle.pieces
      .filter(piece => removedIds.has(piece.instanceId))
      .map(piece => [piece.instanceId, piece]),
  )
  battle.pieces.splice(
    0,
    battle.pieces.length,
    ...battle.pieces.filter(piece => !removedIds.has(piece.instanceId)),
  )
  battle.graveyard ??= []
  for (const candidate of finalizable) {
    const removed = removedById.get(candidate.piece.instanceId)
    if (removed) battle.graveyard.push(removed)
  }

  const chargeEvents: Array<{ attacker?: PieceInstance; playerId: string }> = []
  for (const candidate of finalizable) {
    const killCreditId = candidate.killerPlayerId || candidate.attacker?.ownerPlayerId
    if (!killCreditId) continue
    const grantsKillCharge = !(candidate.piece as PieceInstance & { noKillCharge?: boolean }).noKillCharge
    if (candidate.piece.ownerPlayerId === killCreditId || !grantsKillCharge) continue
    const player = battle.players.find(entry => entry.playerId === killCreditId)
    if (!player) continue
    player.chargePoints += 1
    chargeEvents.push({ attacker: candidate.attacker, playerId: killCreditId })
  }
  for (const charge of chargeEvents) {
    checkSynchronousTriggers(battle, {
      type: 'afterChargeGained',
      piece: charge.attacker,
      sourcePiece: charge.attacker,
      amount: 1,
      playerId: charge.playerId,
      ...legacy,
      ...queues,
    })
  }
  return {
    batchId: context.batchId,
    chainId: context.chainId,
    killedIds: finalizable.map(candidate => candidate.piece.instanceId),
    revivedIds: frozen
      .filter(candidate => candidate.piece.currentHp > 0)
      .map(candidate => candidate.piece.instanceId),
  }
}

function resolveDamageBatch(
  request: DamageRequest,
  context: EffectBatchContext<'damage'>,
  chain: EffectChain,
  battle: BattleState,
): DamageBatchResult {
  let canonicalTargets: PieceInstance[]
  try {
    canonicalTargets = validateDamageTargets(
      request.attacker,
      request.targets,
      request.baseDamage,
      request.damageType,
      battle,
      request.skillId,
      context.depth > 0,
    )
  } catch (error) {
    rethrowInvalidEffectRequest(error, request, context, chain)
  }
  const stableTargets = [...canonicalTargets].sort(compareEffectTarget)
  if (stableTargets.length === 0) {
    return {
      success: false,
      batchId: context.batchId,
      chainId: context.chainId,
      damages: [],
      totalDamage: 0,
      results: [],
      message: '没有目标',
    }
  }

  const queues = queueContext(chain, context)
  let sourceDamage = request.baseDamage
  let sourceBlocked = false
  if (!request.skipBeforeTrigger) {
    const beforeDamageDealtContext = {
      type: 'beforeDamageDealt' as const,
      piece: request.attacker,
      sourcePiece: request.attacker,
      targetPiece: stableTargets[0],
      target: stableTargets[0],
      damage: request.baseDamage,
      damageType: request.damageType,
      skillId: request.skillId,
      selectedOption: request.selectedOption,
      rawDamage: request.baseDamage,
      ...damageMetadata(context),
      ...queues,
    }
    const sourceResult = checkSynchronousTriggers(battle, beforeDamageDealtContext)
    appendDamageMessages(battle, request.attacker.ownerPlayerId, sourceResult.messages || [])
    sourceDamage = finiteNonNegativeDamage(
      beforeDamageDealtContext.damage,
      battle,
      request.attacker,
      request.skillId,
      context.batchId,
    )
    sourceBlocked = Boolean(sourceResult.blocked)
  }

  const prepared = stableTargets.map(target => prepareDamageTarget(
    request,
    target,
    sourceDamage,
    sourceBlocked,
    context,
    chain,
    battle,
  ))
  for (const entry of prepared) {
    if (entry.result.damage <= 0) continue
    entry.target.currentHp = Math.max(0, entry.hpBefore - entry.result.damage)
    entry.result.targetHp = entry.target.currentHp
  }

  for (const entry of prepared) {
    const shared = {
      piece: request.attacker,
      sourcePiece: request.attacker,
      targetPiece: entry.target,
      damage: entry.result.damage,
      damageType: request.damageType,
      skillId: request.skillId,
      rawDamage: request.baseDamage,
      modifiedDamage: entry.result.modifiedDamage,
      defenseApplied: entry.result.defense,
      shieldAbsorbed: entry.result.shieldAbsorbed,
      ...damageMetadata(context),
      ...queues,
    }
    if (entry.emitBlocked) {
      const blockedResult = checkSynchronousTriggers(battle, {
        ...shared,
        type: 'afterDamageBlocked',
        piece: entry.target,
        sourcePiece: entry.target,
        targetPiece: request.attacker,
      })
      appendDamageMessages(battle, request.attacker.ownerPlayerId, blockedResult.messages || [])
      continue
    }
    if (entry.result.damage <= 0) continue
    const dealtResult = checkSynchronousTriggers(battle, { ...shared, type: 'afterDamageDealt' })
    const takenResult = checkSynchronousTriggers(battle, {
      ...shared,
      type: 'afterDamageTaken',
      piece: entry.target,
      sourcePiece: entry.target,
      targetPiece: request.attacker,
    })
    appendDamageMessages(
      battle,
      entry.target.ownerPlayerId,
      [...(dealtResult.messages || []), ...(takenResult.messages || [])],
    )
  }

  const deathCandidates = prepared
    .filter(entry => (
      entry.hpBefore > 0
      && entry.target.currentHp === 0
      && battle.pieces.some(piece => piece.instanceId === entry.target.instanceId)
    ))
    .map(entry => ({
      piece: entry.target,
      attacker: request.attacker,
      killerPlayerId: request.killerPlayerId,
      skillId: request.skillId,
    }))
  let deathResolution: DeathBatchResolution | undefined
  if (deathCandidates.length > 0) {
    deathResolution = chain.runEndogenousDeath(
      { kind: 'death', candidates: deathCandidates },
      'damage:death',
      (deathRequest, deathContext, activeChain) => (
        resolveDeathBatch(deathRequest, deathContext, activeChain, battle)
      ),
    )
  }

  const killedIds = new Set(deathResolution?.killedIds || [])
  const deathCandidateIds = new Set(deathCandidates.map(candidate => candidate.piece.instanceId))
  for (const entry of prepared) {
    entry.result.targetHp = entry.target.currentHp
    entry.result.isKilled = killedIds.has(entry.target.instanceId)
    if (deathResolution && deathCandidateIds.has(entry.target.instanceId)) {
      entry.result.deathBatchId = deathResolution.batchId
    }
  }

  battle.actions ??= []
  for (const entry of prepared) {
    battle.actions.push({
      type: 'damage',
      playerId: request.attacker.ownerPlayerId,
      turn: battle.turn?.turnNumber ?? 0,
      payload: {
        batchId: context.batchId,
        chainId: context.chainId,
        parentBatchId: context.parentBatchId,
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

  const byTargetId = new Map(prepared.map(entry => [entry.target.instanceId, entry.result]))
  const orderedResults = canonicalTargets
    .map(target => byTargetId.get(target.instanceId))
    .filter((result): result is DamageResult => Boolean(result))
  const damages = orderedResults.map(result => result.damage)
  const totalDamage = damages.reduce((sum, damage) => sum + damage, 0)
  return {
    success: orderedResults.some(result => result.success),
    batchId: context.batchId,
    chainId: context.chainId,
    damages,
    totalDamage,
    results: orderedResults,
    message: '对' + orderedResults.length + '个目标共造成' + totalDamage + '点伤害',
  }
}

function resolveHealBatch(
  request: import('./effect-batch').HealRequest,
  context: EffectBatchContext<'heal'>,
  chain: EffectChain,
  battle: BattleState,
): HealBatchResult {
  let canonicalTargets: PieceInstance[]
  try {
    canonicalTargets = validateHealTargets(
      request.healer,
      request.targets,
      request.baseHeal,
      battle,
      request.skillId,
      context.depth > 0,
    )
  } catch (error) {
    rethrowInvalidEffectRequest(error, request, context, chain)
  }
  const stableTargets = [...canonicalTargets].sort(compareEffectTarget)
  if (stableTargets.length === 0) {
    return {
      success: false,
      batchId: context.batchId,
      chainId: context.chainId,
      heals: [],
      totalHeal: 0,
      results: [],
      message: '没有目标',
    }
  }

  const queues = queueContext(chain, context)
  const beforeHealDealtContext = {
    type: 'beforeHealDealt' as const,
    piece: request.healer,
    sourcePiece: request.healer,
    targetPiece: stableTargets[0],
    target: stableTargets[0],
    heal: request.baseHeal,
    skillId: request.skillId,
    ...queues,
  }
  const sourceResult = checkSynchronousTriggers(battle, beforeHealDealtContext)
  const sourceHeal = finiteNonNegativeHeal(
    beforeHealDealtContext.heal,
    battle,
    request.healer,
    request.skillId,
    context.batchId,
  )

  if (sourceResult.blocked) {
    const message = (request.healer.name || request.healer.templateId) + '的治疗被规则阻止'
    appendHealBlockedMessage(battle, request.healer, message)
    const stableResults: HealResult[] = stableTargets.map(target => ({
      success: false,
      batchId: context.batchId,
      chainId: context.chainId,
      parentBatchId: context.parentBatchId,
      sourceId: request.healer.instanceId,
      targetId: target.instanceId,
      skillId: request.skillId,
      rawHeal: request.baseHeal,
      modifiedHeal: sourceHeal,
      heal: 0,
      blocked: true,
      targetHp: target.currentHp,
      message: '治疗被规则阻止',
      depth: context.depth,
      enqueueSequence: context.parentBatchId === undefined ? undefined : context.enqueueSequence,
    }))
    const byTargetId = new Map(stableResults.map(result => [result.targetId, result]))
    const results = canonicalTargets.map(target => byTargetId.get(target.instanceId)!)
    return {
      success: false,
      batchId: context.batchId,
      chainId: context.chainId,
      heals: results.map(() => 0),
      totalHeal: 0,
      results,
      message: '治疗被规则阻止',
      blocked: true,
    }
  }

  const prepared: PreparedHeal[] = stableTargets.map(target => {
    const beforeHealTakenContext = {
      type: 'beforeHealTaken' as const,
      piece: target,
      sourcePiece: target,
      targetPiece: request.healer,
      target: request.healer,
      heal: sourceHeal,
      skillId: request.skillId,
      ...queues,
    }
    const beforeTaken = checkSynchronousTriggers(battle, beforeHealTakenContext)
    const modifiedHeal = finiteNonNegativeHeal(
      beforeHealTakenContext.heal,
      battle,
      request.healer,
      request.skillId,
      context.batchId,
      target.instanceId,
    )
    const blocked = Boolean(beforeTaken.blocked)
    const hpBefore = target.currentHp
    const requestedHeal = blocked ? 0 : Math.max(0, Math.floor(modifiedHeal))
    const nextHp = blocked ? hpBefore : Math.min(target.maxHp, hpBefore + requestedHeal)
    const actualHeal = nextHp - hpBefore
    const healerName = request.healer.name || request.healer.templateId
    const targetName = target.name || target.templateId
    return {
      target,
      hpBefore,
      nextHp,
      result: {
        success: !blocked,
        batchId: context.batchId,
        chainId: context.chainId,
        parentBatchId: context.parentBatchId,
        sourceId: request.healer.instanceId,
        targetId: target.instanceId,
        skillId: request.skillId,
        rawHeal: request.baseHeal,
        modifiedHeal,
        heal: actualHeal,
        blocked,
        targetHp: nextHp,
        message: blocked
          ? '治疗被规则阻止'
          : healerName + '为' + targetName + '回复' + actualHeal + '点生命值',
        depth: context.depth,
        enqueueSequence: context.parentBatchId === undefined ? undefined : context.enqueueSequence,
      },
    }
  })

  for (const entry of prepared) entry.target.currentHp = entry.nextHp
  for (const entry of prepared) {
    if (entry.result.blocked) {
      appendHealBlockedMessage(
        battle,
        request.healer,
        (entry.target.name || entry.target.templateId) + '受到的治疗被规则阻止',
      )
      checkSynchronousTriggers(battle, {
        type: 'afterHealBlocked',
        piece: entry.target,
        sourcePiece: entry.target,
        targetPiece: request.healer,
        heal: entry.result.modifiedHeal,
        skillId: request.skillId,
        ...queues,
      })
      continue
    }
    checkSynchronousTriggers(battle, {
      type: 'afterHealDealt',
      piece: request.healer,
      sourcePiece: request.healer,
      targetPiece: entry.target,
      heal: entry.result.heal,
      skillId: request.skillId,
      ...queues,
    })
    checkSynchronousTriggers(battle, {
      type: 'afterHealTaken',
      piece: entry.target,
      sourcePiece: entry.target,
      targetPiece: request.healer,
      heal: entry.result.heal,
      skillId: request.skillId,
      ...queues,
    })
  }

  const byTargetId = new Map(prepared.map(entry => [entry.target.instanceId, entry.result]))
  const results = canonicalTargets.map(target => byTargetId.get(target.instanceId)!)
  const heals = results.map(result => result.heal)
  const totalHeal = heals.reduce((sum, heal) => sum + heal, 0)
  return {
    success: results.some(result => result.success),
    batchId: context.batchId,
    chainId: context.chainId,
    heals,
    totalHeal,
    results,
    message: '为' + results.length + '个目标共回复' + totalHeal + '点生命值',
    blocked: results.length > 0 && results.every(result => result.blocked),
  }
}

interface IndexedDeclaredSummon {
  readonly inputIndex: number
  readonly spec: DeclaredSummonSpec
}

type ValidatedDeclaredSummon =
  | {
      readonly kind: 'source-mirror'
      readonly inputIndex: number
      readonly spec: DeclaredSummonSpec
      readonly source: PieceInstance
      readonly capability: SourceMirrorSummonCapabilityDeclaration
    }
  | {
      readonly kind: 'stored-piece'
      readonly inputIndex: number
      readonly spec: DeclaredSummonSpec
      readonly source: PieceInstance
      readonly capability: StoredOrDeclaredPieceSummonCapabilityDeclaration
      readonly stored?: PieceInstance
    }

interface PreparedDeclaredSummon {
  readonly inputIndex: number
  readonly recipe: DeclaredSummonCapability['recipe']
  readonly piece: PieceInstance
  readonly ownerPlayerId: string
  readonly sourceId?: string
  readonly insertBeforeSource?: boolean
  readonly storageExtensionKey?: string
  finalX: number
  finalY: number
}

interface SummonCapabilityDefinition {
  readonly id: string
  readonly summonCapability?: SummonCapabilityDeclaration
}

interface SealedContentExecution {
  readonly chain?: EffectChain
  readonly summonQueue?: ReturnType<typeof createDeclaredSummonQueueWriter>
  readonly cleanup?: () => void
}

function cloneEffectTransactionValue<T>(
  value: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (value === null || typeof value !== 'object') return value
  const objectValue = value as object
  const known = seen.get(objectValue)
  if (known !== undefined) return known as T
  if (value instanceof Date) return new Date(value.getTime()) as T

  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(objectValue, copy)
    for (const entry of value) copy.push(cloneEffectTransactionValue(entry, seen))
    return copy as T
  }

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>
  seen.set(objectValue, copy)
  for (const key of Object.keys(value)) {
    copy[key] = cloneEffectTransactionValue(
      (value as Record<string, unknown>)[key],
      seen,
    )
  }
  return copy as T
}

function restoreEffectBattleSnapshot(battle: BattleState, snapshot: BattleState): void {
  const mutableBattle = battle as unknown as Record<string, unknown>
  for (const key of Object.keys(mutableBattle)) delete mutableBattle[key]
  Object.assign(mutableBattle, snapshot as unknown as Record<string, unknown>)
}

function declaredSummonRequestKey(spec: DeclaredSummonSpec): string {
  return [String(spec.x), String(spec.y), spec.variant ?? ''].join(':')
}

function compareIndexedDeclaredSummons(
  left: IndexedDeclaredSummon,
  right: IndexedDeclaredSummon,
): number {
  return declaredSummonRequestKey(left.spec).localeCompare(declaredSummonRequestKey(right.spec))
}

function comparePreparedDeclaredSummons(
  left: PreparedDeclaredSummon,
  right: PreparedDeclaredSummon,
): number {
  return left.piece.instanceId.localeCompare(right.piece.instanceId)
}

function validateDeclaredSummonPosition(
  battle: BattleState,
  x: number,
  y: number,
  reservations: Set<string>,
  fatal: (message: string, cause?: unknown) => never,
): void {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    fatal('Summon position must use integer coordinates')
  }
  const tile = battle.map?.tiles?.find(candidate => candidate.x === x && candidate.y === y)
  if (!tile) fatal('Summon position is outside the map')
  if (!tile.props?.walkable) fatal('Summon position must be walkable')
  if (battle.pieces.some(piece => (
    piece.currentHp > 0 && piece.x === x && piece.y === y
  ))) {
    fatal('Summon position is occupied')
  }
  const key = String(x) + ':' + String(y)
  if (reservations.has(key)) fatal('Summon batch reserves the same cell more than once')
  reservations.add(key)
}

function validateDeclaredSummonSpec(
  capability: DeclaredSummonCapability,
  value: unknown,
  fatal: (message: string, cause?: unknown) => never,
): DeclaredSummonSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fatal('Declared summon spec must be a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fatal('Declared summon spec must use a plain object prototype')
  }
  const record = value as Record<string, unknown>
  if (!Object.keys(record).every(key => ['x', 'y', 'variant'].includes(key))) {
    fatal('Declared summon spec contains fields outside its sealed call schema')
  }
  if (!Number.isSafeInteger(record.x) || !Number.isSafeInteger(record.y)) {
    fatal('Declared summon spec coordinates must be finite integers')
  }
  if (capability.recipe === 'source-mirror') {
    if (
      typeof record.variant !== 'string'
      || !capability.allowedVariants.includes(record.variant)
    ) {
      fatal('Declared summon variant is not allowed by its bound capability')
    }
  } else if (record.variant !== undefined) {
    fatal('Stored-piece summon does not accept a variant')
  }
  return value as DeclaredSummonSpec
}

function validateSourceMirrorSummon(
  entry: IndexedDeclaredSummon,
  source: PieceInstance,
  capability: SourceMirrorSummonCapabilityDeclaration,
): ValidatedDeclaredSummon {
  return {
    kind: 'source-mirror',
    inputIndex: entry.inputIndex,
    spec: entry.spec,
    source,
    capability,
  }
}

function validateStoredPieceSummon(
  battle: BattleState,
  entry: IndexedDeclaredSummon,
  source: PieceInstance,
  capability: StoredOrDeclaredPieceSummonCapabilityDeclaration,
  fatal: (message: string, cause?: unknown) => never,
): ValidatedDeclaredSummon {
  const activePiece = battle.pieces.find(piece => (
    piece.currentHp > 0
    && (
      piece.templateId === capability.uniqueTemplateId
      || piece.instanceId === capability.uniqueTemplateId
    )
  ))
  if (activePiece) fatal('The bound unique summon is already active on the board')

  const storedValue = battle.extensions?.[capability.storageExtensionKey]
  if (storedValue !== undefined) {
    if (!storedValue || typeof storedValue !== 'object' || Array.isArray(storedValue)) {
      fatal('Stored summon piece must be a plain object')
    }
    const prototype = Object.getPrototypeOf(storedValue)
    const storedRecord = storedValue as Record<string, unknown>
    if (
      (prototype !== Object.prototype && prototype !== null)
      || storedRecord.templateId !== capability.uniqueTemplateId
      || typeof storedRecord.instanceId !== 'string'
      || storedRecord.instanceId.length === 0
      || typeof storedRecord.name !== 'string'
      || !Number.isFinite(storedRecord.maxHp)
      || Number(storedRecord.maxHp) <= 0
      || !Number.isFinite(storedRecord.attack)
      || !Number.isFinite(storedRecord.defense)
      || !Number.isFinite(storedRecord.moveRange)
    ) {
      fatal('Stored summon piece does not match its bound stable Piece schema')
    }
  }
  return {
    kind: 'stored-piece',
    inputIndex: entry.inputIndex,
    spec: entry.spec,
    source,
    capability,
    stored: storedValue as PieceInstance | undefined,
  }
}
function copyPieceSkills(value: PieceInstance['skills'] | undefined): PieceInstance['skills'] {
  return cloneEffectTransactionValue(Array.isArray(value) ? value : [])
}

function copyVisibleStatusTags(piece: PieceInstance): PieceInstance['statusTags'] {
  return cloneEffectTransactionValue(
    (piece.statusTags || []).filter(status => status.visible !== false),
  )
}

function prepareSourceMirrorSummon(
  entry: Extract<ValidatedDeclaredSummon, { kind: 'source-mirror' }>,
  contentId: string,
  fatal: (message: string, cause?: unknown) => never,
): PreparedDeclaredSummon {
  // ADR-0021 freezes this exact deterministic consumption order.
  const createdAt = getRuleDate().now()
  const insertBeforeSource = getRuleMath().random() < 0.5
  const instanceId = entry.capability.instanceIdPrefix + String(createdAt)
  const rules = entry.capability.rules.map(ruleId => {
    let rule: ReturnType<typeof loadRuleById>
    try {
      rule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
    } catch (error) {
      fatal('Declared source-mirror rule failed to load: ' + ruleId, error)
    }
    if (!rule) fatal('Declared source-mirror rule was not found: ' + ruleId)
    return rule
  })
  const status = entry.capability.status
  const statusTag = {
    id: status.idPrefix + instanceId,
    name: status.name,
    type: status.type,
    visible: status.visible,
    remainingDuration: status.remainingDuration,
    remainingUses: status.remainingUses,
    intensity: status.intensity,
    stacks: status.stacks,
    relatedRules: [...status.relatedRules],
  }
  const source = entry.source
  const displaySkills = copyPieceSkills(source.skills)
  if (entry.capability.resetBoundSkillCooldown) {
    const boundSkill = displaySkills.find(skill => skill.skillId === contentId)
    if (boundSkill) boundSkill.currentCooldown = 0
  }
  const piece = {
    instanceId,
    isCore: false,
    templateId: source.templateId,
    name: source.name,
    ownerPlayerId: source.ownerPlayerId,
    faction: source.faction,
    x: entry.spec.x,
    y: entry.spec.y,
    maxHp: entry.capability.maxHp,
    currentHp: entry.capability.maxHp,
    displayMaxHp: source.maxHp,
    displayCurrentHp: source.currentHp,
    displayAttack: source.attack,
    displayDefense: source.defense || 0,
    displayMoveRange: source.moveRange,
    displaySkills,
    displayStatusTags: copyVisibleStatusTags(source),
    attack: entry.capability.attack,
    defense: entry.capability.defense,
    moveRange: entry.capability.moveRange,
    masterPieceId: source.instanceId,
    noKillCharge: entry.capability.noKillCharge,
    skills: [],
    buffs: [],
    debuffs: [],
    ruleTags: [],
    rules,
    statusTags: [statusTag],
  } as unknown as PieceInstance
  return {
    inputIndex: entry.inputIndex,
    recipe: entry.capability.recipe,
    piece,
    ownerPlayerId: source.ownerPlayerId,
    sourceId: source.instanceId,
    insertBeforeSource,
    finalX: entry.spec.x,
    finalY: entry.spec.y,
  }
}

function normalizePreparedPieceArrays(piece: PieceInstance): void {
  piece.skills = Array.isArray(piece.skills) ? piece.skills : []
  piece.displaySkills = Array.isArray(piece.displaySkills)
    ? piece.displaySkills
    : copyPieceSkills(piece.skills)
  piece.buffs = Array.isArray(piece.buffs) ? piece.buffs : []
  piece.debuffs = Array.isArray(piece.debuffs) ? piece.debuffs : []
  piece.ruleTags = Array.isArray(piece.ruleTags) ? piece.ruleTags : []
  piece.rules = Array.isArray(piece.rules) ? piece.rules : []
  piece.statusTags = Array.isArray(piece.statusTags) ? piece.statusTags : []
}

function prepareStoredPieceSummon(
  entry: Extract<ValidatedDeclaredSummon, { kind: 'stored-piece' }>,
): PreparedDeclaredSummon {
  const stored = entry.stored
  const fallback = entry.capability.fallback
  let piece: PieceInstance
  if (stored) {
    piece = cloneEffectTransactionValue(stored)
  } else {
    const createdAt = getRuleDate().now()
    const skills = fallback.skills.map(skill => ({
      skillId: skill.skillId,
      level: skill.level,
      currentCooldown: skill.currentCooldown,
    }))
    piece = {
      instanceId: fallback.instanceIdPrefix + entry.source.ownerPlayerId + '-' + String(createdAt),
      isCore: false,
      templateId: fallback.templateId,
      name: fallback.name,
      ownerPlayerId: entry.source.ownerPlayerId,
      faction: entry.source.faction || fallback.faction,
      maxHp: fallback.maxHp,
      currentHp: fallback.maxHp,
      attack: fallback.attack,
      defense: fallback.defense,
      moveRange: fallback.moveRange,
      x: entry.spec.x,
      y: entry.spec.y,
      skills,
      displaySkills: copyPieceSkills(skills),
      rules: [],
      statusTags: [],
      buffs: [],
      debuffs: [],
      ruleTags: [],
    }
  }
  normalizePreparedPieceArrays(piece)
  piece.isCore = false
  piece.x = entry.spec.x
  piece.y = entry.spec.y
  piece.ownerPlayerId = entry.source.ownerPlayerId
  piece.faction = piece.faction || entry.source.faction || fallback.faction
  piece.currentHp = piece.maxHp || fallback.maxHp
  return {
    inputIndex: entry.inputIndex,
    recipe: entry.capability.recipe,
    piece,
    ownerPlayerId: entry.source.ownerPlayerId,
    storageExtensionKey: stored === undefined
      ? undefined
      : entry.capability.storageExtensionKey,
    finalX: entry.spec.x,
    finalY: entry.spec.y,
  }
}

function declaredSummonTriggerContext(
  request: SummonRequest,
  context: EffectBatchContext<'summon'>,
  chain: EffectChain,
  entry: PreparedDeclaredSummon,
  type: 'beforePieceSummoned' | 'afterPieceSummoned',
): Record<string, unknown> {
  return {
    type,
    piece: entry.piece,
    playerId: entry.ownerPlayerId,
    sourcePiece: entry.piece,
    targetPiece: entry.piece,
    target: entry.piece,
    skillId: request.skillId,
    targetPosition: type === 'beforePieceSummoned'
      ? { x: entry.finalX, y: entry.finalY }
      : undefined,
    targetX: type === 'beforePieceSummoned' ? entry.finalX : undefined,
    targetY: type === 'beforePieceSummoned' ? entry.finalY : undefined,
    pieceTemplateId: entry.piece.templateId,
    faction: entry.piece.faction,
    ...queueContext(chain, context),
    // Root content summons are still queued and must retain their ledger sequence.
    effectEnqueueSequence: context.enqueueSequence,
  }
}

function resolvedDeclaredSummonPosition(
  triggerContext: Record<string, unknown>,
  initialX: number,
  initialY: number,
): { x: number; y: number } {
  const position = triggerContext.targetPosition
  if (
    position
    && typeof position === 'object'
    && Number.isSafeInteger((position as { x?: unknown }).x)
    && Number.isSafeInteger((position as { y?: unknown }).y)
    && (
      (position as { x: number }).x !== initialX
      || (position as { y: number }).y !== initialY
    )
  ) {
    return {
      x: (position as { x: number }).x,
      y: (position as { y: number }).y,
    }
  }
  return {
    x: Number(triggerContext.targetX ?? initialX),
    y: Number(triggerContext.targetY ?? initialY),
  }
}

function appendDeclaredSummonMessages(
  battle: BattleState,
  playerId: string,
  messages: readonly string[],
): void {
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
export function resolveDeclaredContentSummonBatch(
  request: SummonRequest,
  context: EffectBatchContext<'summon'>,
  chain: EffectChain,
  battle: BattleState,
): unknown {
  const battleSnapshot = cloneEffectTransactionValue(battle)
  const triggerSystem = getActiveTriggerSystem()
  const triggerSnapshot = triggerSystem.snapshotTransactionState()
  const runtime = getActiveRuleRuntime()
  const runtimeSnapshot = runtime?.snapshot()
  const rejection = (message: string, cause?: unknown) => rejectEffectBatch(
    chain,
    context,
    message,
    cause,
    {
      sourceId: request.sourceId,
      skillId: request.skillId,
      targetIds: request.sourceId ? [request.sourceId] : [],
    },
  )
  const fatal = (message: string, cause?: unknown): never => {
    throw rejection(message, cause)
  }

  try {
    const capability = isTrustedDeclaredSummonCapability(request.capability)
      ? request.capability
      : fatal('Summon request does not carry a trusted declared capability')
    if (
      typeof request.contentId !== 'string'
      || request.contentId.length === 0
      || request.skillId !== request.contentId
    ) {
      fatal('Summon request is not bound to its declaring content')
    }
    if (
      !Array.isArray(request.summons)
      || request.summons.length === 0
      || request.summons.length > capability.maxSummons
    ) {
      fatal('Declared SummonBatch exceeds its bound batch size')
    }
    if (typeof request.sourceId !== 'string' || request.sourceId.length === 0) {
      fatal('Declared SummonBatch requires a bound source')
    }
    const source = battle.pieces.find(piece => (
      piece.instanceId === request.sourceId && piece.currentHp > 0
    )) ?? fatal('Declared summon source is not an active living piece')
    if (!battle.players.some(player => player.playerId === source.ownerPlayerId)) {
      fatal('Declared summon source owner player was not found')
    }

    const indexed = request.summons
      .map((unsafeSpec, inputIndex) => ({
        spec: validateDeclaredSummonSpec(capability, unsafeSpec, fatal),
        inputIndex,
      }))
      .sort(compareIndexedDeclaredSummons)
    const requestKeys = new Set<string>()
    for (const entry of indexed) {
      const key = declaredSummonRequestKey(entry.spec)
      if (requestKeys.has(key)) fatal('Duplicate declared summon request')
      requestKeys.add(key)
    }

    // Phase 1: validate every request and reserve every initial position.
    const initialReservations = new Set<string>()
    const validated: ValidatedDeclaredSummon[] = indexed.map(entry => {
      validateDeclaredSummonPosition(
        battle,
        entry.spec.x,
        entry.spec.y,
        initialReservations,
        fatal,
      )
      return capability.recipe === 'source-mirror'
        ? validateSourceMirrorSummon(entry, source, capability)
        : validateStoredPieceSummon(battle, entry, source, capability, fatal)
    })

    // Phase 2: build complete instances, including rules/statuses, off-board.
    const prepared = validated.map(entry => (
      entry.kind === 'source-mirror'
        ? prepareSourceMirrorSummon(entry, request.contentId, fatal)
        : prepareStoredPieceSummon(entry)
    ))
    const existingIds = new Set([
      ...battle.pieces.map(piece => piece.instanceId),
      ...(battle.graveyard || []).map(piece => piece.instanceId),
    ])
    for (const entry of prepared) {
      if (!entry.piece.instanceId || existingIds.has(entry.piece.instanceId)) {
        fatal('Summon instanceId is not unique: ' + String(entry.piece.instanceId))
      }
      existingIds.add(entry.piece.instanceId)
    }
    const stablePrepared = prepared.slice().sort(comparePreparedDeclaredSummons)

    // Phase 3: stable before events. Rules may redirect positions, never instances.
    for (const entry of stablePrepared) {
      const beforeContext = declaredSummonTriggerContext(
        request,
        context,
        chain,
        entry,
        'beforePieceSummoned',
      )
      const beforeResult = checkSynchronousTriggers(battle, beforeContext)
      if (beforeResult.blocked) {
        const message = beforeResult.messages?.[0] || 'Summon was blocked'
        fatal('Queued declared summon was blocked: ' + message, new Error(message))
      }
      appendDeclaredSummonMessages(
        battle,
        entry.ownerPlayerId,
        beforeResult.messages || [],
      )
      const finalPosition = resolvedDeclaredSummonPosition(
        beforeContext,
        entry.finalX,
        entry.finalY,
      )
      entry.finalX = finalPosition.x
      entry.finalY = finalPosition.y
      entry.piece.x = finalPosition.x
      entry.piece.y = finalPosition.y
    }

    // Phase 4: revalidate every redirected position as one reservation set.
    const finalReservations = new Set<string>()
    for (const entry of stablePrepared) {
      validateDeclaredSummonPosition(
        battle,
        entry.finalX,
        entry.finalY,
        finalReservations,
        fatal,
      )
    }

    // Phase 5: one commit window. All complete pieces exist before any after event.
    const committedPieces = battle.pieces.slice()
    for (const entry of stablePrepared) {
      if (entry.recipe === 'source-mirror') {
        const sourceIndex = committedPieces.findIndex(piece => (
          piece.instanceId === entry.sourceId && piece.currentHp > 0
        ))
        if (sourceIndex < 0) fatal('Source-mirror summon source disappeared before commit')
        committedPieces.splice(
          entry.insertBeforeSource ? sourceIndex : sourceIndex + 1,
          0,
          entry.piece,
        )
      } else {
        committedPieces.push(entry.piece)
      }
    }
    battle.pieces.splice(0, battle.pieces.length, ...committedPieces)
    for (const storageExtensionKey of new Set(
      stablePrepared
        .map(entry => entry.storageExtensionKey)
        .filter((key): key is string => typeof key === 'string'),
    )) {
      if (battle.extensions) delete battle.extensions[storageExtensionKey]
    }

    // Phase 6: stable after events observe the whole committed batch.
    for (const entry of stablePrepared) {
      const afterResult = checkSynchronousTriggers(
        battle,
        declaredSummonTriggerContext(
          request,
          context,
          chain,
          entry,
          'afterPieceSummoned',
        ),
      )
      appendDeclaredSummonMessages(
        battle,
        entry.ownerPlayerId,
        afterResult.messages || [],
      )
    }

    const metadata = {
      batchId: context.batchId,
      chainId: context.chainId,
      parentBatchId: context.parentBatchId,
      depth: context.depth,
      enqueueSequence: context.enqueueSequence,
    }
    const results = new Array(prepared.length)
    for (const entry of prepared) {
      results[entry.inputIndex] = {
        success: true,
        inputIndex: entry.inputIndex,
        piece: entry.piece,
        message: entry.piece.name + '\u88ab\u53ec\u5524\u5230('
          + String(entry.finalX) + ',' + String(entry.finalY) + ')',
        ...metadata,
      }
    }
    return {
      success: true,
      pieces: stablePrepared.map(entry => entry.piece),
      results,
      message: results.length === 1
        ? results[0].message
        : String(results.length) + ' pieces were summoned',
      ...metadata,
    }
  } catch (error) {
    restoreEffectBattleSnapshot(battle, battleSnapshot)
    triggerSystem.restoreTransactionState(triggerSnapshot)
    if (runtime && runtimeSnapshot) runtime.restore(runtimeSnapshot)
    if (isEffectChainFatalError(error)) throw error
    throw rejection('Declared content SummonBatch failed', error)
  }
}
function beginSealedContentExecution(
  battle: BattleState,
  definition: SummonCapabilityDefinition,
): SealedContentExecution {
  if (definition.summonCapability === undefined) return {}

  const active = getActiveEffectChain(battle)
  const chain = active ?? createDetachedEffectChain(battle, 'summon')
  const cleanup = active ? undefined : installEffectChain(battle, chain)
  try {
    return {
      chain,
      summonQueue: createDeclaredSummonQueueWriter(
        chain,
        definition.id,
        definition.summonCapability,
      ),
      cleanup,
    }
  } catch (error) {
    cleanup?.()
    throw error
  }
}

function bindDeclaredSummonQueueContext(
  context: Record<string, unknown>,
  execution: SealedContentExecution,
): () => void {
  const hadOwnValue = Object.prototype.hasOwnProperty.call(context, 'summonQueue')
  const previousValue = context.summonQueue
  context.summonQueue = execution.summonQueue
  return () => {
    if (hadOwnValue) context.summonQueue = previousValue
    else delete context.summonQueue
  }
}

function finishSealedContentExecution(
  battle: BattleState,
  execution: SealedContentExecution,
): void {
  const chain = execution.chain
  if (!chain || chain.state !== 'idle' || chain.pendingCount === 0) return
  drainBattleEffectChain(battle, chain)
}
export type BattleSummonBatchHandler = (
  request: SummonRequest,
  context: EffectBatchContext<'summon'>,
  chain: EffectChain,
  battle: BattleState,
) => unknown

function rejectUnsupportedSummonBatch(
  request: SummonRequest,
  context: EffectBatchContext<'summon'>,
  chain: EffectChain,
): never {
  throw new EffectChainFatalError(
    'RVB_EFFECT_CHAIN_SUMMON_CAPABILITY',
    'No sealed SummonBatch handler was installed for ' + request.contentId,
    {
      actionId: chain.actionId,
      chainId: chain.chainId,
      batchId: context.batchId,
      parentBatchId: context.parentBatchId,
      kind: 'summon',
      depth: context.depth,
      enqueueSequence: context.enqueueSequence,
      originStage: context.originStage,
      processed: chain.processedBatches,
      limit: 1,
      turn: chain.turn,
      rootSeed: chain.rootSeed,
      sourceId: request.sourceId,
      skillId: request.skillId,
      detached: chain.detached,
      budget: 'binding',
    },
  )
}

export function drainBattleEffectChain(
  battle: BattleState,
  chain: EffectChain,
  summonHandler?: BattleSummonBatchHandler,
): readonly EffectExecution[] {
  return chain.drain({
    damage: (request, context, activeChain) => resolveDamageBatch(request, context, activeChain, battle),
    heal: (request, context, activeChain) => resolveHealBatch(request, context, activeChain, battle),
    summon: (request, context, activeChain) => (
      request.capability !== undefined
        ? resolveDeclaredContentSummonBatch(request, context, activeChain, battle)
        : summonHandler
          ? summonHandler(request, context, activeChain, battle)
          : rejectUnsupportedSummonBatch(request, context, activeChain)
    ),
    death: (request, context, activeChain) => resolveDeathBatch(request, context, activeChain, battle),
  })
}

function createDetachedEffectChain(battle: BattleState, rootKind: 'damage' | 'heal' | 'summon'): EffectChain {
  const runtime = getActiveRuleRuntime()
  const turn = battle.turn?.turnNumber ?? 0
  const fallbackBase = {
    damage: (battle.actions || []).filter(action => action.type === 'damage').length,
    heal: 0,
    summon: 0,
    death: 0,
  }
  const fallbackSequence = { damage: 0, heal: 0, summon: 0, death: 0 }
  const nextId = (kind: 'damage' | 'heal' | 'summon' | 'death') => {
    const prefix = kind + '-batch'
    if (runtime) return runtime.nextInstanceId(prefix, prefix)
    const sequence = fallbackSequence[kind]
    fallbackSequence[kind] += 1
    return prefix + '-' + turn + '-' + (fallbackBase[kind] + sequence)
  }
  const chainId = nextId(rootKind)
  let firstBatch = true
  return createEffectChain({
    actionId: chainId + ':action',
    chainId,
    turn,
    rootSeed: runtime?.rootSeed ?? null,
    detached: true,
    createBatchId: input => {
      if (firstBatch) {
        firstBatch = false
        return chainId
      }
      return nextId(input.kind)
    },
  })
}

function findExecutionResult<TResult>(
  executions: readonly EffectExecution[],
  kind: 'damage' | 'heal',
  enqueueSequence: number,
): TResult {
  const execution = executions.find(entry => (
    entry.kind === kind && entry.context.enqueueSequence === enqueueSequence
  ))
  if (!execution) {
    throw new Error(
      'EffectChain did not execute root ' + kind + ' request at sequence ' + enqueueSequence,
    )
  }
  return execution.result as TResult
}

function translateDetachedDamageError(error: unknown, chain: EffectChain): never {
  if (!chain.detached || !isEffectChainFatalError(error)) throw error
  if (error.code === 'RVB_EFFECT_CHAIN_DEPTH_LIMIT') {
    throw new DamagePipelineError(
      'RVB_DAMAGE_CHAIN_DEPTH',
      'Damage chain exceeded depth ' + chain.limits.maxDepth,
      { ...error.context },
    )
  }
  if (error.code === 'RVB_EFFECT_CHAIN_BATCH_LIMIT') {
    throw new DamagePipelineError(
      'RVB_DAMAGE_CHAIN_BUDGET',
      'Damage chain exceeded ' + chain.limits.maxBatches + ' batches',
      { ...error.context },
    )
  }
  throw error
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
    return {
      success: false,
      damages: [],
      totalDamage: 0,
      results: [],
      message: '没有目标',
    } as DamageBatchResult
  }

  const active = getActiveEffectChain(battle)
  if (active?.state === 'processing') {
    const current = active.currentBatch
    throw new DamagePipelineError(
      'RVB_DAMAGE_REENTRANT_CALL',
      'Nested dealDamage calls must enqueue follow-up damage through context.damageQueue',
      damageContext(battle, attacker, skillId, {
        chainId: active.chainId,
        parentBatchId: current?.batchId,
        depth: (current?.depth ?? 0) + 1,
      }),
    )
  }
  const chain = active ?? createDetachedEffectChain(battle, 'damage')
  chain.assertFacadeAllowed('damage', {
    sourceId: attacker?.instanceId,
    skillId,
    targetIds: targets.map(entry => entry?.instanceId),
  })
  const cleanup = active ? undefined : installEffectChain(battle, chain)
  try {
    const ledgerEntry = chain.enqueue({
      kind: 'damage',
      attacker,
      targets,
      baseDamage,
      damageType,
      skillId,
      skipBeforeTrigger,
      killerPlayerId,
      selectedOption,
    })
    const executions = drainBattleEffectChain(battle, chain)
    const result = findExecutionResult<DamageBatchResult>(
      executions,
      'damage',
      ledgerEntry.enqueueSequence,
    )
    return Array.isArray(target) ? result : result.results[0]
  } catch (error) {
    translateDetachedDamageError(error, chain)
  } finally {
    cleanup?.()
  }
}

export function healDamage(
  healer: PieceInstance,
  target: PieceInstance | PieceInstance[],
  baseHeal: number,
  battle: BattleState,
  skillId?: string,
): any {
  const targets = Array.isArray(target) ? target : [target]
  if (targets.length === 0) {
    return {
      success: false,
      heals: [],
      totalHeal: 0,
      results: [],
      message: '没有目标',
    } as HealBatchResult
  }

  const active = getActiveEffectChain(battle)
  const chain = active ?? createDetachedEffectChain(battle, 'heal')
  chain.assertFacadeAllowed('heal', {
    sourceId: healer?.instanceId,
    skillId,
    targetIds: targets.map(entry => entry?.instanceId),
  })
  const cleanup = active ? undefined : installEffectChain(battle, chain)
  try {
    const ledgerEntry = chain.enqueue({
      kind: 'heal',
      healer,
      targets,
      baseHeal,
      skillId,
    })
    const executions = drainBattleEffectChain(battle, chain)
    const result = findExecutionResult<HealBatchResult>(
      executions,
      'heal',
      ledgerEntry.enqueueSequence,
    )
    return Array.isArray(target) ? result : result.results[0]
  } finally {
    cleanup?.()
  }
}

// 执行技能函数
export function executeSkillFunction(skillDef: SkillDefinition, context: SkillExecutionContext, battle: BattleState): SkillExecutionResult {
  const sealedContent = beginSealedContentExecution(battle, skillDef)
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

    const forceRemoveEnemyPieceById = (targetPieceId: string) => {
      const targetIndex = battle.pieces.findIndex(piece =>
        piece.instanceId === targetPieceId &&
        piece.currentHp > 0 &&
        piece.ownerPlayerId !== sourcePiece.ownerPlayerId)
      if (targetIndex === -1) return false

      const [removed] = battle.pieces.splice(targetIndex, 1)
      battle.extensions ??= {}
      const removedPieces = Array.isArray(battle.extensions.removedPieces)
        ? battle.extensions.removedPieces
        : []
      battle.extensions.removedPieces = removedPieces
      removedPieces.push({
        instanceId: removed.instanceId,
        templateId: removed.templateId,
        ownerPlayerId: removed.ownerPlayerId,
        name: removed.name,
        isCore: removed.isCore === true,
        removedBySkillId: skillDef.id,
      })
      battle.actions ??= []
      battle.actions.push({
        type: 'forceRemovePiece',
        playerId: sourcePiece.ownerPlayerId,
        turn: battle.turn?.turnNumber ?? 0,
        payload: {
          message: `${sourcePiece.name || sourcePiece.templateId}将${removed.name || removed.templateId}强制移出战场`,
          pieceId: removed.instanceId,
          pieceTemplateId: removed.templateId,
          removedBySkillId: skillDef.id,
        },
      })
      return true
    }

    // 创建技能执行环境，包含辅助函数和效果函数
    const skillEnvironment = {
      // 上下文
      context: {
        ...context,
        forceRemoveEnemyPieceById,
        summonQueue: sealedContent.summonQueue,
      },
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

          // 创建状态对象
          const newStatus = {
            ...statusObject,
            id: statusObject.id,
            type: statusObject.type,
            name: statusObject.name || statusObject.type,
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
            statusType: statusTag.type,
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
        return getActiveTriggerSystem().fireEvent(battle, context as any, eventName, ctx)
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
          const executeSkill = getSkillExecutionCaches().dynamicCodeRuntime.compileExpression<(environment: typeof skillEnvironment) => SkillExecutionResult>({
            surface: 'skillCode', contentId: skillDef.id, code: fullSkillCode, entry: 'executeSkill(context)',
          });
          let result = executeSkill(skillEnvironment);
          finishSealedContentExecution(battle, sealedContent)
          
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
              title: result.title || '请选择',
              playerId: result.playerId,
              canCancel: result.canCancel,
              cancelValue: result.cancelValue,
              selectionMode: result.selectionMode,
              presentation: result.presentation,
              minSelections: result.minSelections,
              maxSelections: result.maxSelections,
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
        if (isEffectChainFatalError(error)) throw error
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
  } finally {
    sealedContent.cleanup?.()
  }
}

// 检查技能执行后是否造成伤害或击杀
function checkForDamageAndKill(_battle: BattleState, _beforeState: any, _sourcePiece: PieceInstance, _skillId: string) {
  // afterDamageDealt and afterPieceKilled are already fired inside dealDamage() for each hit.
  // Firing them again here would cause double-counting in content-authored damage rules.
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
      const calculatePreview = getSkillExecutionCaches().dynamicCodeRuntime.compileExpression<(environment: typeof previewEnvironment) => any>({
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
