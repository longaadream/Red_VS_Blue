import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"
import {
  applyEffectToPiece,
  buildSelfObject,
  getEffectOnPiece,
  removeEffectFromPiece,
} from './attached-effect'
import { getActiveRuleRuntime, getRuleDate, getRuleMath } from './rule-runtime'

const FORCE_RULE_RELOAD = process.env.NODE_ENV !== 'production'

// 简单的日志写入函数
function writeLog(message: string) {
  try {
    const fs = require('fs')
    const path = require('path')
    const logDir = path.join(process.env.USER_DATA_DIR ?? process.cwd(), 'logs')
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
  type: string
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
  priority?: number
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
  /** 事件名。内置事件使用 TriggerType 字符串；技能代码可用 fireEvent 触发任意自定义字符串事件。 */
  type: string
  /** 源棋子，可以被修改（如改变位置、属性等） */
  sourcePiece?: PieceInstance
  /** 目标棋子，可以被修改或替换 */
  targetPiece?: PieceInstance
  /** 技能ID，可以被修改以改变即将使用的技能 */
  skillId?: string
  cardId?: string
  cardInstanceId?: string
  pieceTemplateId?: string
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
  targetPosition?: { x: number; y: number } | null
  targetPieceId?: string
  /** 伤害类型，可以在 beforeDamageDealt 中被修改 */
  damageType?: 'physical' | 'magical' | 'true' | 'toxin'
  /** 
   * 当前执行规则的棋子（规则绑定者）
   * 在全场扫描规则时，这个字段表示当前正在执行哪个棋子的规则
   * 用于区分事件源(sourcePiece)和规则拥有者
   */
  rulePiece?: PieceInstance
  piece?: PieceInstance
  selectedOption?: any
  /** Identifies this dispatch within a synchronous fireEvent chain. */
  eventId?: string
  /** The dispatch that synchronously fired this event, when applicable. */
  parentEventId?: string
  /** The root dispatch for this chain. */
  rootEventId?: string
  /** Zero for a root event; incremented by fireEvent. */
  eventDepth?: number
  /** Internal chain state, returned as an immutable snapshot in TriggerResult. */
  eventChain?: EventChainState
  [key: string]: any
}

export const MAX_EVENT_CHAIN_DEPTH = 20
export const MAX_EVENT_CHAIN_DISPATCHES = 100

export interface EventChainEntry {
  eventId: string
  parentEventId?: string
  type: string
  depth: number
}

export interface EventChainState {
  rootEventId: string
  dispatches: EventChainEntry[]
}

export interface TriggerResult {
  success: boolean
  messages: string[]
  blocked: boolean
  error?: {
    code: 'EVENT_CHAIN_DEPTH_EXCEEDED' | 'EVENT_CHAIN_BUDGET_EXCEEDED'
    message: string
    eventChain: EventChainEntry[]
  }
  eventChain?: EventChainEntry[]
  needsOptionSelection?: boolean
  options?: any[]
  title?: string
  needsTargetSelection?: boolean
  targetType?: string
  range?: number
  filter?: string
  pendingQueue?: Array<{ruleId: string, sourceId?: string}>
}

// 触发系统类
export class TriggerSystem {
  private rules: TriggerRule[] = []
  private nextRootEventId = 0

  /**
   * Dispatch a child event while preserving the current synchronous event chain.
   * All skill-code environments use this entry point instead of calling
   * checkTriggers directly so recursive fireEvent calls cannot lose ancestry.
   */
  fireEvent(battle: BattleState, parentContext: TriggerContext, eventName: string, childContext: any = {}): TriggerResult {
    return this.checkTriggers(battle, {
      ...childContext,
      type: eventName,
      parentEventId: parentContext.eventId,
      rootEventId: parentContext.rootEventId,
      eventDepth: (parentContext.eventDepth ?? 0) + 1,
      eventChain: parentContext.eventChain,
    })
  }

  private prepareEventContext(context: TriggerContext): TriggerResult | undefined {
    const chain = context.eventChain ?? {
      rootEventId: `event-${++this.nextRootEventId}`,
      dispatches: [],
    }
    const depth = context.eventDepth ?? 0
    const rootEventId = context.rootEventId ?? chain.rootEventId

    context.eventChain = chain
    context.rootEventId = rootEventId
    context.eventDepth = depth
    context.eventId = context.eventId ?? `${rootEventId}:${chain.dispatches.length + 1}`

    const limit = depth >= MAX_EVENT_CHAIN_DEPTH
      ? { code: 'EVENT_CHAIN_DEPTH_EXCEEDED' as const, message: `Event chain depth exceeded ${MAX_EVENT_CHAIN_DEPTH}` }
      : chain.dispatches.length >= MAX_EVENT_CHAIN_DISPATCHES
        ? { code: 'EVENT_CHAIN_BUDGET_EXCEEDED' as const, message: `Event chain dispatch budget exceeded ${MAX_EVENT_CHAIN_DISPATCHES}` }
        : undefined

    if (limit) {
      const eventChain = chain.dispatches.map(entry => ({ ...entry }))
      writeLog(`[checkTriggers] ${limit.code}: ${limit.message}; chain=${JSON.stringify(eventChain)}`)
      return { success: false, messages: [limit.message], blocked: true, error: { ...limit, eventChain }, eventChain }
    }

    chain.dispatches.push({ eventId: context.eventId, parentEventId: context.parentEventId, type: context.type, depth })
    return undefined
  }

  private withEventChain(result: TriggerResult, context: TriggerContext): TriggerResult {
    return { ...result, eventChain: context.eventChain?.dispatches.map(entry => ({ ...entry })) }
  }

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
  checkTriggers(battle: BattleState, context: TriggerContext): TriggerResult {
    const triggeredEffects: string[] = []
    let success = false
    let blocked = false
    let needsOptionSelection = false
    let pendingOptions: any[] | undefined
    let pendingTitle: string | undefined
    let pendingPlayerId: string | undefined
    let needsTargetSelection = false
    let pendingTargetType: string | undefined
    let pendingRange: number | undefined
    let pendingFilter: string | undefined
    let pendingRuleId: string | undefined
    let pendingRuleSourceId: string | undefined
    let pendingQueue: Array<{ruleId: string, sourceId?: string}> = []

    if ((battle as any).extensions?.__dryRunSkillPreflight) {
      return { success: false, messages: [], blocked: false } as any
    }

    const rejectedEvent = this.prepareEventContext(context)
    if (rejectedEvent) return rejectedEvent

    // 从 context 中读取恢复状态（用于从 pendingTargetSelect/pendingOptionSelect 恢复执行）
    const ctxPendingRuleId = (context as any).pendingRuleId as string | undefined
    const ctxPendingSourceId = (context as any).pendingRuleSourceId as string | undefined

    writeLog('[checkTriggers] Checking triggers for: ' + context.type + ', global rules count: ' + this.rules.length + ', players: ' + JSON.stringify(battle.players?.map(p => ({ playerId: p.playerId, rulesCount: (p as any).rules?.length || 0 }))))
    writeLog('[checkTriggers] Context: ' + JSON.stringify({ type: context.type, statusId: (context as any).statusId, playerId: context.playerId }));

    // 辅助函数：确保规则的 effect 已加载（不是存根函数）
    function ensureRuleEffect(rule: any): boolean {
      const isDefaultEffect = typeof rule.effect === 'function' &&
        rule.effect.toString().length < 120 &&
        rule.effect.toString().includes('ruleData.name') &&
        rule.effect.toString().includes('触发') &&
        !rule.effect.toString().includes('checkToxin')
      if (typeof rule.effect !== 'function' || isDefaultEffect) {
        try {
          const { loadRuleById } = require('./skills')
          const reloaded = loadRuleById(rule.id, FORCE_RULE_RELOAD)
          if (reloaded && typeof reloaded.effect === 'function') {
            rule.effect = reloaded.effect
            return true
          }
        } catch { }
        return false
      }
      return true
    }

    // ── 阶段一：按顺序收集所有待执行规则 ──────────────────────────────────────
    // 每个 RuleItem 携带规则对象、标识符、以及一个 buildCtx 函数用于构建执行上下文
    type RuleItem = {
      rule: any
      ruleId: string
      sourceId?: string
      buildCtx: (ctx: TriggerContext) => TriggerContext
    }
    const allRuleItems: RuleItem[] = []
    const globalCollectedIds = new Set<string>()  // 已加入全局区的规则ID，避免棋子区重复

    // 1. 全局规则（含棋子所有权检测）
    writeLog('[checkTriggers] Global rules count: ' + this.rules.length);
    const globalMatchingRules = this.rules.filter(rule => {
      if (ctxPendingRuleId && rule.id !== ctxPendingRuleId) return false
      if (rule.trigger.type !== context.type) return false
      const limits = rule.limits
      if (limits) {
        if (limits.currentCooldown && limits.currentCooldown > 0) return false
        if (limits.maxUses && (limits.uses || 0) >= limits.maxUses) return false
      }
      return true
    })
    globalMatchingRules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    writeLog('[checkTriggers] Global matching rules for ' + context.type + ': ' + JSON.stringify(globalMatchingRules.map(r => r.id)));

    for (const rule of globalMatchingRules) {
      globalCollectedIds.add(rule.id)
      const owningPieces = battle.pieces?.filter((p: any) =>
        p.rules?.some((r: any) => r.id === rule.id) &&
        (!ctxPendingSourceId || p.instanceId === ctxPendingSourceId)
      ) || []
      if (owningPieces.length === 0) {
        allRuleItems.push({ rule, ruleId: rule.id, buildCtx: ctx => ctx })
      } else {
        for (const op of owningPieces) {
          allRuleItems.push({
            rule, ruleId: rule.id, sourceId: op.instanceId,
            buildCtx: ctx => ({ ...ctx, triggerPlayerId: ctx.playerId, ruleOwnerPlayerId: op.ownerPlayerId, piece: ctx.sourcePiece, rulePiece: op })
          })
        }
      }
    }

    // 2. 棋子实例规则（跳过已在全局区收集的规则）
    writeLog('[checkTriggers] Checking piece rules, pieces count: ' + (battle.pieces?.length || 0));
    if (battle.pieces) {
      for (const piece of battle.pieces) {
        if (!piece.rules || piece.rules.length === 0) continue
        writeLog('[checkTriggers] Piece ' + piece.name + ' has ' + piece.rules.length + ' rules: ' + JSON.stringify(piece.rules.map((r: any) => r.id)));
        const pieceMatchingRules = piece.rules.filter((rule: any) => {
          if (!rule || !rule.trigger) return false
          if (rule.trigger.type !== context.type) return false
          if (ctxPendingRuleId && rule.id !== ctxPendingRuleId) return false
          if (ctxPendingSourceId && piece.instanceId !== ctxPendingSourceId) return false
          if (globalCollectedIds.has(rule.id)) return false  // 已在全局区收集，跳过
          const limits = rule.limits
          if (limits) {
            if (limits.currentCooldown && limits.currentCooldown > 0) return false
            if (limits.maxUses && (limits.uses || 0) >= limits.maxUses) return false
          }
          return true
        })
        pieceMatchingRules.sort((a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0))
        for (const rule of pieceMatchingRules) {
          allRuleItems.push({
            rule, ruleId: rule.id, sourceId: piece.instanceId,
            buildCtx: ctx => ({ ...ctx, triggerPlayerId: ctx.playerId, ruleOwnerPlayerId: piece.ownerPlayerId, piece: ctx.sourcePiece, rulePiece: piece })
          })
        }
      }
    }

    // 3. 玩家级规则
    if (battle.players) {
      writeLog('[checkTriggers] Checking player rules, players count: ' + battle.players.length)
      for (const player of battle.players) {
        if (!(player as any).rules || (player as any).rules.length === 0) continue
        const playerMatchingRules = ((player as any).rules as any[]).filter((rule: any) => {
          if (!rule || !rule.trigger) return false
          if (rule.trigger.type !== context.type) return false
          if (ctxPendingRuleId && rule.id !== ctxPendingRuleId) return false
          if (ctxPendingSourceId && player.playerId !== ctxPendingSourceId) return false
          const limits = rule.limits
          if (limits) {
            if (limits.currentCooldown && limits.currentCooldown > 0) return false
            if (limits.maxUses && (limits.uses || 0) >= limits.maxUses) return false
          }
          return true
        })
        for (const rule of playerMatchingRules) {
          allRuleItems.push({
            rule, ruleId: rule.id, sourceId: player.playerId,
            buildCtx: ctx => ({ ...ctx, triggerPlayerId: ctx.playerId, ruleOwnerPlayerId: player.playerId, playerId: player.playerId, player })
          })
        }
      }
    }

    // ── 阶段二：按顺序执行，遇到需要玩家交互的规则立即停止 ──────────────────────
    // 若 ctxPendingRuleId 指定了恢复点，从该规则开始执行（跳过其之前的规则）
    let startIdx = 0
    if (ctxPendingRuleId) {
      const idx = allRuleItems.findIndex(r =>
        r.ruleId === ctxPendingRuleId && (!ctxPendingSourceId || r.sourceId === ctxPendingSourceId)
      )
      if (idx !== -1) startIdx = idx
    }

    let interactionNeeded = false
    for (let i = startIdx; i < allRuleItems.length; i++) {
      if (blocked) break
      const item = allRuleItems[i]
      writeLog('[checkTriggers] Executing rule: ' + item.ruleId + ' sourceId: ' + (item.sourceId || 'none'))

      if (!ensureRuleEffect(item.rule)) {
        writeLog('[checkTriggers] Failed to load effect for rule: ' + item.ruleId)
        continue
      }

      try {
        const ruleCtx = item.buildCtx(context)
        const ruleOwnerPlayerId = (ruleCtx as any).ruleOwnerPlayerId || (ruleCtx as any).playerId || context.playerId
        const result = item.rule.effect(battle, ruleCtx)
        // 回写 damage
        if ((ruleCtx as any).damage !== (context as any).damage) {
          (context as any).damage = (ruleCtx as any).damage
        }
        if ((context as any).damage !== undefined && (context as any).damage <= 0) {
          blocked = true
        }

        if (result && result.needsOptionSelection) {
          needsOptionSelection = true
          pendingOptions = result.options
          pendingTitle = result.title
          pendingPlayerId = result.playerId || ruleOwnerPlayerId
          pendingRuleId = item.ruleId
          pendingRuleSourceId = item.sourceId
          // 收集后续未执行的规则作为队列
          pendingQueue = allRuleItems.slice(i + 1).map(r => ({ ruleId: r.ruleId, sourceId: r.sourceId }))
          interactionNeeded = true
          break
        }
        if (result && result.needsTargetSelection) {
          needsTargetSelection = true
          pendingTargetType = result.targetType
          pendingRange = result.range
          pendingFilter = result.filter
          pendingTitle = result.title
          pendingPlayerId = result.playerId || ruleOwnerPlayerId
          pendingRuleId = item.ruleId
          pendingRuleSourceId = item.sourceId
          pendingQueue = allRuleItems.slice(i + 1).map(r => ({ ruleId: r.ruleId, sourceId: r.sourceId }))
          interactionNeeded = true
          break
        }
        if (result && result.success) {
          success = true
          if (result.message) triggeredEffects.push(result.message)
          if (result.blocked) blocked = true
          if (item.rule.limits) {
            item.rule.limits.uses = (item.rule.limits.uses || 0) + 1
            if (item.rule.limits.cooldownTurns) item.rule.limits.currentCooldown = item.rule.limits.cooldownTurns
          }
        }
      } catch (error) {
        writeLog('Error executing rule ' + item.ruleId + ': ' + error)
      }
    }

    // 只在没有挂起交互时才执行手牌/附加效果（避免乱序）
    if (interactionNeeded) {
      return this.withEventChain({ success, messages: triggeredEffects, blocked, needsOptionSelection: needsOptionSelection || undefined, options: pendingOptions, title: pendingTitle, playerId: pendingPlayerId, pendingRuleId, pendingRuleSourceId, needsTargetSelection: needsTargetSelection || undefined, targetType: pendingTargetType, range: pendingRange, filter: pendingFilter, pendingQueue: pendingQueue.length > 0 ? pendingQueue : undefined } as any, context)
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

    // 5. 处理 AttachedEffect 触发器（新统一系统，替代分散的 rule + statusTag）
    if (battle.pieces) {
      let skillsModule: any = null
      const getSkillsModule = () => {
        if (!skillsModule) skillsModule = require('./skills')
        return skillsModule
      }

      // 构建注入到 effectCode / filterCode 的辅助函数（与 rule skillCode 环境对齐）
      const _dealDamage = (src: any, tgt: any, dmg: number, type: string, sid?: string, skipBefore?: boolean, killerPlayerId?: string) =>
        getSkillsModule().dealDamage(src, tgt, dmg, type, battle, sid, skipBefore, killerPlayerId)
      const _healDamage = (healer: any, tgt: any, heal: number, sid?: string) =>
        getSkillsModule().healDamage(healer, tgt, heal, battle, sid)
      const _removeStatusEffectById = (pieceId: string, statusId: string) => {
        const p = battle.pieces.find((x: any) => x.instanceId === pieceId)
        if (p?.statusTags) {
          const idx = p.statusTags.findIndex((t: any) => t.id === statusId)
          if (idx !== -1) p.statusTags.splice(idx, 1)
        }
      }
      const _addStatusEffectById = (pieceId: string, status: any) => {
        const p = battle.pieces.find((x: any) => x.instanceId === pieceId)
        if (p) {
          if (!p.statusTags) p.statusTags = []
          if (!p.statusTags.some((t: any) => t.id === status.id)) p.statusTags.push({ ...status })
        }
      }
      const _addRuleById = (pieceId: string, ruleId: string) => {
        const p = battle.pieces.find((x: any) => x.instanceId === pieceId)
        if (p) {
          const rule = getSkillsModule().loadRuleById(ruleId, FORCE_RULE_RELOAD)
          if (rule) {
            if (!p.rules) p.rules = []
            if (!p.rules.some((r: any) => r.id === ruleId)) p.rules.push(rule)
          }
        }
      }
      const _removeRuleById = (pieceId: string, ruleId: string) => {
        const p = battle.pieces.find((x: any) => x.instanceId === pieceId)
        if (p?.rules) p.rules = p.rules.filter((r: any) => r.id !== ruleId)
      }
      const _applyEffect = (pieceId: string, effectId: string, data?: any) =>
        applyEffectToPiece(battle, pieceId, effectId, data)
      const _removeEffect = (pieceId: string, effectId: string) =>
        removeEffectFromPiece(battle, pieceId, effectId)
      const _getPieceEffect = (pieceId: string, effectId: string) =>
        getEffectOnPiece(battle, pieceId, effectId)
      const _fireEvent = (eventName: string, ctx: any) =>
        this.fireEvent(battle, context, eventName, ctx)
      const _addCardToHand = (cardId: string, targetPlayerId: string) => {
        const player = battle.players?.find((p: any) => p.playerId === targetPlayerId)
        if (!player) return false
        if (!player.hand) player.hand = []
        const runtime = getActiveRuleRuntime()
        const instanceId = runtime
          ? runtime.nextInstanceId('card', `ci-${cardId}`)
          : `${cardId}-${getRuleDate().now()}`
        player.hand.push({ cardId, instanceId, ownerPlayerId: targetPlayerId })
        return true
      }

      /** 将辅助函数注入到 effectCode/filterCode 的 eval 作用域中 */
      const wrapCode = (code: string) => {
        // eslint-disable-next-line no-eval
        return eval(
          `(function(dealDamage,healDamage,removeStatusEffectById,addStatusEffectById,addRuleById,removeRuleById,applyEffect,removeEffect,getPieceEffect,fireEvent,addCardToHand,Math,Date){ return (${code}); })`
        )(_dealDamage, _healDamage, _removeStatusEffectById, _addStatusEffectById, _addRuleById, _removeRuleById, _applyEffect, _removeEffect, _getPieceEffect, _fireEvent, _addCardToHand, getRuleMath(), getRuleDate())
      }

      const piecesSnap = [...battle.pieces]
      for (const piece of piecesSnap) {
        if (blocked) break
        if (!piece.attachedEffects || piece.attachedEffects.length === 0) continue
        const effectsSnap = [...piece.attachedEffects]
        for (const effect of effectsSnap) {
          if (blocked) break
          if (!effect.triggers || effect.triggers.length === 0) continue
          const matching = effect.triggers
            .filter((t: any) => t.on === context.type)
            .sort((a: any, b: any) => (a.priority ?? 50) - (b.priority ?? 50))
          if (matching.length === 0) continue
          const selfObj = buildSelfObject(effect, piece, battle)
          for (const trigger of matching) {
            if (blocked) break
            try {
              const filterFn = wrapCode(trigger.filterCode)
              if (!filterFn(context, battle, selfObj)) continue
              const effectFn = wrapCode(trigger.effectCode)
              const result = effectFn(context, battle, selfObj)
              if (result) {
                if (result.success) success = true
                if (result.message) triggeredEffects.push(result.message)
                if (result.blocked) blocked = true
                if (result.needsOptionSelection) {
                  needsOptionSelection = true
                  pendingOptions = result.options
                  pendingTitle = result.title
                  pendingPlayerId = (result as any).playerId
                  pendingRuleId = effect.id || effect.effectId
                  pendingRuleSourceId = piece.instanceId
                }
                if (result.needsTargetSelection && !needsTargetSelection) {
                  needsTargetSelection = true
                  pendingTargetType = result.targetType
                  pendingRange = result.range
                  pendingFilter = result.filter
                  pendingTitle = result.title
                  pendingPlayerId = (result as any).playerId
                  pendingRuleId = effect.id || effect.effectId
                  pendingRuleSourceId = piece.instanceId
                }
              }
            } catch (e) {
              writeLog('[checkTriggers] AttachedEffect error in ' + effect.instanceId + ': ' + e)
            }
          }
        }
      }
    }

    return this.withEventChain({ success, messages: triggeredEffects, blocked, needsOptionSelection: needsOptionSelection || undefined, options: pendingOptions, title: pendingTitle, playerId: pendingPlayerId, pendingRuleId, pendingRuleSourceId, needsTargetSelection: needsTargetSelection || undefined, targetType: pendingTargetType, range: pendingRange, filter: pendingFilter, pendingQueue: undefined } as any, context)
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
