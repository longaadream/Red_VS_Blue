import type { BattleState } from "./turn"
import type { PieceInstance } from "./piece"
import { executeCardFunction, loadCardForBattle, loadRuleForBattle } from './skills'
import type { PendingReactiveCardRef } from './pending-interaction'
import {
  getActiveSuspendableActionRuntime,
  type SuspendableInteractionInput,
} from './suspendable-action-transaction'
import { getRuleExecutionTriggerSystem } from './rule-runtime'
import {
  EffectChainFatalError,
  getActiveEffectChain,
  isEffectChainFatalError,
  isEffectChainPendingSignal,
  rejectEffectBatch,
  type DamageQueueWriter,
  type HealQueueWriter,
} from './effect-batch'

export type {
  DamageQueueRequest,
  EffectQueueWriter,
  HealQueueRequest,
} from './effect-batch'

function isFatalEffectChainError(error: unknown): boolean {
  if (isEffectChainFatalError(error)) return true
  try {
    if (!error || typeof error !== 'object') return false
    const candidate = error as {
      fatal?: unknown
      isFatal?: unknown
    }
    return candidate.fatal === true
      || candidate.isFatal === true
  } catch {
    return false
  }
}

function throwAttachedTriggerBoundaryFailure(
  battle: BattleState,
  error: unknown,
  message: string,
  metadata: { sourceId?: string; skillId?: string } = {},
): never {
  const chain = getActiveEffectChain(battle)
  if (isEffectChainPendingSignal(error)) {
    throw chain && !chain.detached ? chain.latchPending(error) : error
  }
  if (isFatalEffectChainError(error)) {
    if (!chain || chain.detached) throw error
    if (isEffectChainFatalError(error)) throw chain.latchFatal(error)
    throw chain.latchFatal(new EffectChainFatalError(
      'RVB_EFFECT_CHAIN_STATE_INVALID',
      message + ' reported a fatal marker',
      {
        actionId: chain.actionId,
        chainId: chain.chainId,
        kind: null,
        depth: null,
        processed: chain.processedBatches,
        limit: chain.limits.maxBatches,
        turn: chain.turn,
        rootSeed: chain.rootSeed,
        sourceId: metadata.sourceId,
        skillId: metadata.skillId,
        detached: false,
        budget: 'state',
      },
      error,
    ))
  }
  if (!chain || chain.detached) throw error
  const batch = chain.currentBatch
  if (batch) {
    throw rejectEffectBatch(chain, batch, message, error, metadata)
  }
  throw chain.latchFatal(new EffectChainFatalError(
    'RVB_EFFECT_CHAIN_STATE_INVALID',
    message,
    {
      actionId: chain.actionId,
      chainId: chain.chainId,
      kind: null,
      depth: null,
      processed: chain.processedBatches,
      limit: chain.limits.maxBatches,
      turn: chain.turn,
      rootSeed: chain.rootSeed,
      sourceId: metadata.sourceId,
      skillId: metadata.skillId,
      detached: false,
      budget: 'state',
    },
    error,
  ))
}

// 简单的日志写入函数
function writeLog(message: string) {
  if (process.env.RVB_BATTLE_DEBUG_LOGS !== '1') return
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
  | "beforeDamageShield"    // 防御结算后、数值护盾吸收前
  | "beforeDamageApplied"   // 数值护盾结算后、生命扣减前
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
  /** Removed status type when a tag ID differs from its semantic type. */
  statusType?: string
  /** 目标位置X坐标，可以在 beforeMove/beforePieceSummoned 中被修改 */
  targetX?: number
  /** 目标位置Y坐标，可以在 beforeMove/beforePieceSummoned 中被修改 */
  targetY?: number
  targetPosition?: { x: number; y: number } | null
  targetPieceId?: string
  /** 伤害类型，可以在 beforeDamageDealt 中被修改 */
  damageType?: 'physical' | 'magical' | 'true' | 'toxin'
  /** RED-33 deterministic damage-chain metadata. */
  damageBatchId?: string
  damageChainId?: string
  parentDamageBatchId?: string
  rawDamage?: number
  modifiedDamage?: number
  defenseApplied?: number
  shieldAbsorbed?: number
  /** Follow-up damage drained after the parent batch has committed. */
  damageQueue?: DamageQueueWriter
  healQueue?: HealQueueWriter
  effectChainId?: string
  effectBatchId?: string
  parentEffectBatchId?: string
  effectBatchKind?: 'damage' | 'heal' | 'summon' | 'death'
  effectDepth?: number
  effectEnqueueSequence?: number
  originStage?: string
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

interface MutableTriggerContextSnapshot {
  damage: unknown
  heal: unknown
  targetPosition: unknown
  targetPositionX: unknown
  targetPositionY: unknown
  targetX: unknown
  targetY: unknown
}

function mutableTriggerContextSnapshot(context: TriggerContext): MutableTriggerContextSnapshot {
  const position = context.targetPosition as { x?: unknown; y?: unknown } | null | undefined
  return {
    damage: context.damage,
    heal: context.heal,
    targetPosition: position,
    targetPositionX: position && typeof position === 'object' ? position.x : undefined,
    targetPositionY: position && typeof position === 'object' ? position.y : undefined,
    targetX: context.targetX,
    targetY: context.targetY,
  }
}

function writeBackMutableTriggerContext(
  source: TriggerContext,
  target: TriggerContext,
  before: MutableTriggerContextSnapshot,
): void {
  if (source.damage !== before.damage) target.damage = source.damage
  if (source.heal !== before.heal) target.heal = source.heal
  const position = source.targetPosition as { x?: unknown; y?: unknown } | null | undefined
  const positionX = position && typeof position === 'object' ? position.x : undefined
  const positionY = position && typeof position === 'object' ? position.y : undefined
  const positionChanged = position !== before.targetPosition
    || positionX !== before.targetPositionX
    || positionY !== before.targetPositionY
  const targetXChanged = source.targetX !== before.targetX
  const targetYChanged = source.targetY !== before.targetY

  if (positionChanged) {
    target.targetPosition = source.targetPosition
    if (Number.isSafeInteger(positionX) && Number.isSafeInteger(positionY)) {
      if (!targetXChanged) target.targetX = positionX as number
      if (!targetYChanged) target.targetY = positionY as number
    }
  }
  if (targetXChanged) target.targetX = source.targetX
  if (targetYChanged) target.targetY = source.targetY
  if (!positionChanged && (targetXChanged || targetYChanged)) {
    if (Number.isSafeInteger(target.targetX) && Number.isSafeInteger(target.targetY)) {
      target.targetPosition = { x: target.targetX as number, y: target.targetY as number }
    }
  }
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
  playerId?: string
  canCancel?: boolean
  cancelValue?: any
  selectionMode?: 'single' | 'multi'
  presentation?: 'picker' | 'hand'
  minSelections?: number
  maxSelections?: number
  needsTargetSelection?: boolean
  targetType?: string
  range?: number
  filter?: string
  targetCandidates?: unknown[]
  resumeOnCancel?: boolean
  rollbackOnCancel?: boolean
  effectCode?: string
  payload?: any
  pendingRuleId?: string
  pendingRuleSourceId?: string
  pendingQueue?: Array<{ruleId: string, sourceId?: string}>
  pendingReactiveCards?: PendingReactiveCardRef[]
}

// 触发系统类
export class TriggerSystem {
  private rules: TriggerRule[] = []
  private nextRootEventId = 0

  snapshotTransactionState(): {
    nextRootEventId: number
    rules: TriggerRule[]
    ruleLimits: Array<TriggerRule['limits']>
  } {
    return {
      nextRootEventId: this.nextRootEventId,
      rules: [...this.rules],
      ruleLimits: this.rules.map(rule => rule.limits ? { ...rule.limits } : undefined),
    }
  }

  restoreTransactionState(snapshot: {
    nextRootEventId: number
    rules: TriggerRule[]
    ruleLimits: Array<TriggerRule['limits']>
  }): void {
    this.nextRootEventId = snapshot.nextRootEventId
    this.rules = [...snapshot.rules]
    snapshot.rules.forEach((rule, index) => {
      const limits = snapshot.ruleLimits[index]
      if (limits) rule.limits = { ...limits }
      else delete rule.limits
    })
  }

  /**
   * Dispatch a child event while preserving the current synchronous event chain.
   * All skill-code environments use this entry point instead of calling
   * checkTriggers directly so recursive fireEvent calls cannot lose ancestry.
   */
  fireEvent(battle: BattleState, parentContext: TriggerContext, eventName: string, childContext: any = {}): TriggerResult {
    try {
      return this.checkTriggers(battle, {
        ...childContext,
        type: eventName,
        parentEventId: parentContext.eventId,
        rootEventId: parentContext.rootEventId,
        eventDepth: (parentContext.eventDepth ?? 0) + 1,
        eventChain: parentContext.eventChain,
      })
    } catch (error) {
      throwAttachedTriggerBoundaryFailure(
        battle,
        error,
        'Attached EffectChain fireEvent boundary failed',
      )
    }
  }

  private prepareEventContext(battle: BattleState, context: TriggerContext): TriggerResult | undefined {
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
    const effectChain = getActiveEffectChain(battle)
    effectChain?.recordDispatch({
      kind: context.effectBatchKind,
      batchId: context.effectBatchId,
      parentBatchId: context.parentEffectBatchId,
      depth: context.effectDepth,
      enqueueSequence: context.effectEnqueueSequence,
      originStage: context.originStage,
      sourceId: context.sourcePiece?.instanceId || context.piece?.instanceId,
      skillId: context.skillId,
      targetId: context.targetPiece?.instanceId,
    })


    if (limit) {
      const eventChain = chain.dispatches.map(entry => ({ ...entry }))
      if (effectChain && !effectChain.detached) {
        const current = effectChain.currentBatch
        throw effectChain.latchFatal(new EffectChainFatalError(
          'RVB_EFFECT_CHAIN_DISPATCH_LIMIT',
          limit.message,
          {
            actionId: effectChain.actionId,
            chainId: effectChain.chainId,
            batchId: current?.batchId,
            parentBatchId: current?.parentBatchId,
            kind: current?.kind ?? context.effectBatchKind ?? null,
            depth: current?.depth ?? context.effectDepth ?? null,
            enqueueSequence: current?.enqueueSequence ?? context.effectEnqueueSequence,
            originStage: current?.originStage ?? context.originStage,
            processed: depth >= MAX_EVENT_CHAIN_DEPTH ? depth : chain.dispatches.length + 1,
            limit: depth >= MAX_EVENT_CHAIN_DEPTH ? MAX_EVENT_CHAIN_DEPTH : MAX_EVENT_CHAIN_DISPATCHES,
            turn: effectChain.turn,
            rootSeed: effectChain.rootSeed,
            sourceId: context.sourcePiece?.instanceId || context.piece?.instanceId,
            skillId: context.skillId,
            targetId: context.targetPiece?.instanceId,
            detached: false,
            budget: 'dispatches',
          },
        ))
      }
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
      if (isFatalEffectChainError(error)) throw error
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
    const ruleLimitSnapshots = this.rules.map(rule => ({
      rule,
      limits: rule.limits ? { ...rule.limits } : undefined,
    }))
    const restoreRuleLimits = () => {
      for (const snapshot of ruleLimitSnapshots) {
        if (snapshot.limits) snapshot.rule.limits = { ...snapshot.limits }
        else delete snapshot.rule.limits
      }
    }
    const rethrowTriggerError = (error: unknown, consumerKind: string, consumerId: string): never => {
      restoreRuleLimits()
      if (isEffectChainPendingSignal(error) || isFatalEffectChainError(error)) {
        throwAttachedTriggerBoundaryFailure(
          battle,
          error,
          `Attached EffectChain ${consumerKind} consumer ${consumerId} failed`,
          { sourceId: consumerId, skillId: consumerId },
        )
      }
      const chain = getActiveEffectChain(battle)
      if (chain?.detached) throw error
      const details = {
        eventType: context.type,
        eventId: context.eventId,
        consumerKind,
        consumerId,
        rootEventId: context.rootEventId,
        eventDepth: context.eventDepth,
      }
      let originalMessage = 'Trigger consumer threw a non-Error value'
      try {
        if (error instanceof Error && typeof error.message === 'string') {
          originalMessage = error.message
        }
      } catch {
        // Hostile thrown values must not interrupt rollback/latching.
      }
      const cause = Object.assign(new Error(
        `${originalMessage} [event=${context.type} eventId=${context.eventId ?? 'unknown'} consumer=${consumerKind}:${consumerId}]`,
      ), { triggerContext: details })
      throw cause
    }
    const failClosedDefinitionLoad = (
      consumerKind: 'rule' | 'reactiveCard',
      consumerId: string,
      cause?: unknown,
      sourceId?: string,
    ): void => {
      const chain = getActiveEffectChain(battle)
      const batch = chain?.currentBatch
      if (!chain || chain.detached) return
      const definitionError = cause instanceof Error
        ? cause
        : new Error(`${consumerKind} definition ${consumerId} is unavailable`)
      if (batch) {
        throw rejectEffectBatch(
          chain,
          batch,
          `Attached EffectChain could not load ${consumerKind} definition ${consumerId}`,
          definitionError,
          {
            sourceId,
            skillId: consumerId,
          },
        )
      }
      throw chain.latchFatal(new EffectChainFatalError(
        'RVB_EFFECT_CHAIN_STATE_INVALID',
        `Attached EffectChain could not load ${consumerKind} definition ${consumerId}`,
        {
          actionId: chain.actionId,
          chainId: chain.chainId,
          kind: null,
          depth: null,
          processed: chain.processedBatches,
          limit: chain.limits.maxBatches,
          turn: chain.turn,
          rootSeed: chain.rootSeed,
          sourceId,
          skillId: consumerId,
          detached: false,
          budget: 'state',
        },
        definitionError,
      ))
    }
    const resolveCardDefinition = (
      cardId: string,
      sourceId?: string,
    ): { cardDef: any; loadError?: unknown } => {
      try {
        return {
          cardDef: loadCardForBattle(battle, cardId, {
            metadata: { sourceId, skillId: cardId },
          }),
        }
      } catch (error) {
        if (isFatalEffectChainError(error)) throw error
        return { cardDef: null, loadError: error }
      }
    }
    const triggeredEffects: string[] = []
    let success = false
    let blocked = false
    const transactionRuntime = getActiveSuspendableActionRuntime()
    let needsOptionSelection = false
    let pendingOptions: any[] | undefined
    let pendingTitle: string | undefined
    let pendingPlayerId: string | undefined
    let pendingCanCancel: boolean | undefined
    let pendingCancelValue: any
    let pendingSelectionMode: 'single' | 'multi' | undefined
    let pendingPresentation: 'picker' | 'hand' | undefined
    let pendingMinSelections: number | undefined
    let pendingMaxSelections: number | undefined
    let needsTargetSelection = false
    let pendingTargetType: string | undefined
    const candidateStateSnapshot = () => (
      JSON.parse(JSON.stringify(battle)) as BattleState
    )

    let pendingRange: number | undefined
    let pendingFilter: string | undefined
    let pendingRuleId: string | undefined
    let pendingRuleSourceId: string | undefined
    let pendingQueue: Array<{ruleId: string, sourceId?: string}> = []

    if ((battle as any).extensions?.__dryRunSkillPreflight) {
      return { success: false, messages: [], blocked: false } as any
    }

    const rejectedEvent = this.prepareEventContext(battle, context)
    if (rejectedEvent) return rejectedEvent

    // 从 context 中读取恢复状态（用于从 pendingTargetSelect/pendingOptionSelect 恢复执行）
    const ctxPendingRuleId = (context as any).pendingRuleId as string | undefined
    const ctxPendingSourceId = (context as any).pendingRuleSourceId as string | undefined
    const reactiveOnly = (context as any).__reactiveCardsOnly === true
    const deferredReactiveCards = (context as any).__deferReactiveCards === true
    const suppliedReactiveCards = (context as any).__pendingReactiveCards as PendingReactiveCardRef[] | undefined
    const pendingReactiveCards: PendingReactiveCardRef[] = suppliedReactiveCards
      ? suppliedReactiveCards.map(card => ({ ...card }))
      : (battle.players || []).flatMap(player => (player.hand || []).flatMap(cardInstance => {
          const { cardDef, loadError } = resolveCardDefinition(
            cardInstance.cardId,
            cardInstance.instanceId,
          )
          if (!cardDef) {
            failClosedDefinitionLoad('reactiveCard', cardInstance.cardId, loadError, cardInstance.instanceId)
            return []
          }
          if (cardDef.type !== 'reactive' || cardDef.trigger?.type !== context.type) return []
          return [{
            playerId: player.playerId,
            cardInstanceId: cardInstance.instanceId,
            cardId: cardInstance.cardId,
          }]
        }))

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
          const reloaded = loadRuleForBattle(battle, String(rule?.id || ''), {
            sourceId: String((rule as any)?.sourceId || ''),
          })
          if (reloaded && typeof reloaded.effect === 'function') {
            rule.effect = reloaded.effect
            return true
          }
        } catch (error) {
          if (isFatalEffectChainError(error)) throw error
          failClosedDefinitionLoad('rule', String(rule?.id || 'unknown'), error)
        }
        failClosedDefinitionLoad('rule', String(rule?.id || 'unknown'))
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
        playerMatchingRules.sort((a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0))
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
    let startIdx = reactiveOnly ? allRuleItems.length : 0
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
        const interactionKey = transactionRuntime?.enterConsumer({
          consumerKind: 'rule',
          consumerId: item.ruleId,
          sourceId: item.sourceId,
          eventType: context.type,
        })
        let transactionInput = interactionKey
          ? transactionRuntime?.takeAnswer(interactionKey)
          : undefined
        if (transactionInput?.cancelled && !transactionInput.resumeConsumerOnCancel) continue
        const transactionInputs = transactionInput ? [transactionInput] : []
        let ruleCtx: TriggerContext
        let result: any
        let damageBeforeEffect = 0
        let ruleOwnerPlayerId: string | undefined
        while (true) {
          ruleCtx = item.buildCtx(context)
          const mutableBeforeEffect = mutableTriggerContextSnapshot(ruleCtx)
          applyTransactionInputs(ruleCtx, transactionInputs, battle)
          damageBeforeEffect = Number((ruleCtx as any).damage)
          ruleOwnerPlayerId = (ruleCtx as any).ruleOwnerPlayerId
            || (ruleCtx as any).playerId
            || context.playerId
          result = item.rule.effect(battle, ruleCtx)
          writeBackMutableTriggerContext(ruleCtx, context, mutableBeforeEffect)
          if (!result?.needsOptionSelection && !result?.needsTargetSelection) break
          if (!transactionRuntime || !interactionKey) break
          const nextInput = transactionRuntime.takeAnswer(interactionKey)
          if (nextInput) {
            transactionInput = nextInput
            transactionInputs.push(nextInput)
            continue
          }
          transactionRuntime.suspend(interactionKey, result.needsOptionSelection
            ? {
                kind: 'option',
                playerId: result.playerId || ruleOwnerPlayerId,
                title: result.title,
                options: result.options || [],
                canCancel: result.canCancel,
                cancelValue: result.cancelValue,
                selectionMode: result.selectionMode,
                presentation: result.presentation,
                minSelections: result.minSelections,
                maxSelections: result.maxSelections,
                suspendedTurn: { ...battle.turn },
              }
            : {
                kind: 'target',
                playerId: result.playerId || ruleOwnerPlayerId,
                title: result.title,
                targetType: result.targetType,
                range: result.range,
                filter: result.filter,
                candidates: result.targetCandidates,
                selectionMode: result.selectionMode,
                minSelections: result.minSelections,
                maxSelections: result.maxSelections,
                resumeOnCancel: result.resumeOnCancel,
                rollbackOnCancel: result.rollbackOnCancel,
                canCancel: result.canCancel,
                suspendedTurn: { ...battle.turn },
                sourcePieceId: (ruleCtx as any).sourcePiece?.instanceId || item.sourceId,
                candidateState: candidateStateSnapshot(),
              })
        }
        if (Number.isFinite(damageBeforeEffect)
          && damageBeforeEffect > 0
          && Number((context as any).damage) <= 0) {
          blocked = true
        }

        if (result && result.needsOptionSelection) {
          needsOptionSelection = true
          pendingOptions = result.options
          pendingTitle = result.title
          pendingPlayerId = result.playerId || ruleOwnerPlayerId
          pendingCanCancel = result.canCancel
          pendingCancelValue = result.cancelValue
          pendingSelectionMode = result.selectionMode
          pendingPresentation = result.presentation
          pendingMinSelections = result.minSelections
          pendingMaxSelections = result.maxSelections
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
          pendingCanCancel = result.canCancel
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
        writeLog('Error executing rule ' + item.ruleId)
        rethrowTriggerError(error, 'rule', item.ruleId)
      }
    }

    // 只在没有挂起交互时才执行响应卡（避免乱序）
    if (interactionNeeded) {
      return this.withEventChain({ success, messages: triggeredEffects, blocked, needsOptionSelection: needsOptionSelection || undefined, options: pendingOptions, title: pendingTitle, playerId: pendingPlayerId, canCancel: pendingCanCancel, cancelValue: pendingCancelValue, selectionMode: pendingSelectionMode, presentation: pendingPresentation, minSelections: pendingMinSelections, maxSelections: pendingMaxSelections, pendingRuleId, pendingRuleSourceId, needsTargetSelection: needsTargetSelection || undefined, targetType: pendingTargetType, range: pendingRange, filter: pendingFilter, pendingQueue: pendingQueue.length > 0 ? pendingQueue : undefined, pendingReactiveCards } as any, context)
    }

    // 4. 按事件开始时冻结的快照执行 reactive 卡牌，恢复规则队列时不得重复扫描。
    if (!deferredReactiveCards) {
      for (const cardRef of pendingReactiveCards) {
        if (blocked) break
        const player = battle.players?.find(candidate => candidate.playerId === cardRef.playerId)
        const cardInstance = player?.hand?.find(card => card.instanceId === cardRef.cardInstanceId)
        if (!player || !cardInstance || cardInstance.cardId !== cardRef.cardId) continue
        try {
          const { cardDef, loadError } = resolveCardDefinition(
            cardRef.cardId,
            cardRef.cardInstanceId,
          )
          if (!cardDef) {
            failClosedDefinitionLoad('reactiveCard', cardRef.cardId, loadError, cardRef.cardInstanceId)
            continue
          }
          if (cardDef.type !== 'reactive' || cardDef.trigger?.type !== context.type) {
            failClosedDefinitionLoad(
              'reactiveCard',
              cardRef.cardId,
              new Error(`Frozen reactive-card definition ${cardRef.cardId} changed before ${context.type}`),
              cardRef.cardInstanceId,
            )
            continue
          }
          const interactionKey = transactionRuntime?.enterConsumer({
            consumerKind: 'reactiveCard',
            consumerId: cardRef.cardId,
            sourceId: cardRef.cardInstanceId,
            eventType: context.type,
          })
          let transactionInput = interactionKey
            ? transactionRuntime?.takeAnswer(interactionKey)
            : undefined
          if (transactionInput?.cancelled && !transactionInput.resumeConsumerOnCancel) continue
          const transactionInputs = transactionInput ? [transactionInput] : []
          let result: any
          let cardContext: TriggerContext
          while (true) {
            cardContext = { ...context }
            const mutableBeforeEffect = mutableTriggerContextSnapshot(cardContext)
            applyTransactionInputs(cardContext, transactionInputs, battle)
            result = executeCardFunction(cardDef, player.playerId, battle, cardContext) as any
            writeBackMutableTriggerContext(cardContext, context, mutableBeforeEffect)
            if (!result?.needsOptionSelection && !result?.needsTargetSelection) break
            if (!transactionRuntime || !interactionKey) {
              throw new Error(`Reactive card ${cardRef.cardId} requested unsupported interaction during ${context.type}`)
            }
            const nextInput = transactionRuntime.takeAnswer(interactionKey)
            if (nextInput) {
              transactionInput = nextInput
              transactionInputs.push(nextInput)
              continue
            }
            transactionRuntime.suspend(interactionKey, result.needsOptionSelection
              ? {
                  kind: 'option',
                  playerId: result.playerId || player.playerId,
                  title: result.title,
                  options: result.options || [],
                  canCancel: result.canCancel,
                  cancelValue: result.cancelValue,
                  selectionMode: result.selectionMode,
                  presentation: result.presentation,
                  minSelections: result.minSelections,
                  maxSelections: result.maxSelections,
                  suspendedTurn: { ...battle.turn },
                }
              : {
                  kind: 'target',
                  playerId: result.playerId || player.playerId,
                  title: result.title,
                  targetType: result.targetType,
                  range: result.range,
                  filter: result.filter,
                  candidates: result.targetCandidates,
                  selectionMode: result.selectionMode,
                  minSelections: result.minSelections,
                  maxSelections: result.maxSelections,
                  resumeOnCancel: result.resumeOnCancel,
                  rollbackOnCancel: result.rollbackOnCancel,
                  canCancel: result.canCancel,
                  suspendedTurn: { ...battle.turn },
                  sourcePieceId: (context as any).sourcePiece?.instanceId,
                  candidateState: candidateStateSnapshot(),
                })
          }
          if (result?.needsOptionSelection || result?.needsTargetSelection) {
            throw new Error(`Reactive card ${cardRef.cardId} requested unsupported interaction during ${context.type}`)
          }
          if (result && result.success) {
            success = true
            if (result.message) triggeredEffects.push(result.message)
            if (result.blocked) blocked = true
            if (!result.keepInHand) {
              if (!player.discardPile) player.discardPile = []
              const handIndex = player.hand.findIndex((card: any) => card.instanceId === cardRef.cardInstanceId)
              if (handIndex !== -1) {
                player.hand.splice(handIndex, 1)
                player.discardPile.push(cardRef.cardId)
              }
            }
          }
        } catch (error) {
          writeLog('Error executing reactive card ' + cardRef.cardId)
          rethrowTriggerError(error, 'reactiveCard', cardRef.cardId)
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

function applyTransactionInputs(
  context: TriggerContext,
  inputs: SuspendableInteractionInput[],
  battle: BattleState,
): void {
  if (inputs.length === 0) return
  for (const input of inputs) Object.assign(context, input)
  const selectedTargets = inputs.flatMap(input => input.selectedTargets || [])
  if (selectedTargets.length > 0) (context as any).selectedTargets = selectedTargets
  const latestPieceInput = [...inputs].reverse().find(input => input.targetPieceId)
  if (latestPieceInput?.targetPieceId) {
    context.targetPiece = battle.pieces.find(piece => (
      piece.instanceId === latestPieceInput.targetPieceId && piece.currentHp > 0
    ))
  }
  const latestCellInput = [...inputs].reverse().find(input => (
    input.targetX !== undefined && input.targetY !== undefined
  ))
  if (latestCellInput?.targetX !== undefined && latestCellInput.targetY !== undefined) {
    context.targetPosition = { x: latestCellInput.targetX, y: latestCellInput.targetY }
  }
}

// 全局触发系统实例
export const globalTriggerSystem = new TriggerSystem()

/**
 * Offline/browser callers retain the historical singleton fallback. Online
 * room execution always installs an explicit RuleExecutionContext, making the
 * room-owned TriggerSystem the only mutable truth for that transition.
 */
export function getActiveTriggerSystem(): TriggerSystem {
  return getRuleExecutionTriggerSystem(globalTriggerSystem)
}
