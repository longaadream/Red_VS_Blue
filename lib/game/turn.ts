// 当序列化格式出现不兼容变化时递增此值（旧状态会被 applyBattleAction 拒绝）
export const BATTLE_STATE_VERSION = 1
function battleDebugLog(...args: unknown[]): void {
  if (typeof process === 'undefined' || process.env?.RVB_BATTLE_DEBUG_LOGS !== '1') return
  console.log(...args)
}

// 从 battle-types 导入类型（避免客户端导入时加载服务器端代码）
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

// 重新导出类型，保持向后兼容
import type { BoardMap } from "./map"
import {
  DEPLOYMENT_FIRST_MOVE_FREE_STATUS,
  type PieceInstance,
  type PieceStats,
  type PieceStatusTag,
} from "./piece"
import type { SkillDefinition } from "./skills"
import { dealDamage, healDamage, loadRuleById, loadCardById, executeCardFunction, executeSkillFunction, getEffectiveChargeCost, getRuleDynamicCodeRuntime } from "./skills"
import { globalTriggerSystem, type TriggerResult } from "./triggers"
import { getSkillById } from "./skill-repository"
import {
  RANDOM_STREAM_NAMES,
  RuleRuntime,
  getActiveRuleRuntime,
  getRuleExecutionTriggerSystem,
  getRuleDate,
  getRuleMath,
  withRuleRuntime,
  withRuleRuntimeCheckpoint,
} from "./rule-runtime"

const getActiveTriggerSystem = () => getRuleExecutionTriggerSystem(globalTriggerSystem)
import {
  SUSPENDABLE_ACTION_TRANSACTION_PROTOCOL_VERSION,
  SuspendableActionRuntime,
  isSuspendableActionPending,
  withSuspendableActionRuntime,
  type SuspendableActionTransaction,
  type SuspendableInteractionInput,
  type SuspendableInteractionPrompt,
} from './suspendable-action-transaction'
import { getNormalMoveRejection, manhattanDistance } from "./spatial"
import {
  PROGRESSIVE_DEPLOYMENT_MODE,
  getEmptyWalkableDeploymentPositions,
  getSafeDeploymentPositions,
  isProgressiveDeployment,
  reservePiecesForPlayer,
} from './deployment'
import {
  TargetingRuleError,
  advancePendingTargetSession,
  finalizePendingTargetSession,
  assertActionTargetingReady,
  assertPendingTargetCancellation,
  stampTargetingRevision,
  validatePendingTargetSubmissions,
} from "./targeting"
import type { PendingTargetSelectionSession, TargetSelectionCredential } from "./targeting"
import {
  assertPendingOptionCancellation,
  finalizePendingOptionSession,
  validatePendingOptionSubmission,
  type PendingOptionSelectionSession,
  type PendingReactiveCardRef,
  type PendingRuleConsumerRef,
} from './pending-interaction'
import { finalizeBattleTerminal, type TerminalResult } from "./terminal"
import {
  TURN_TIMEOUT_FORFEIT_STREAK,
  isTurnTimerSystemAction,
  markTurnTimerBurning,
  recordTurnTimeout,
  syncTurnTimerAfterAcceptedAction,
  type TurnTimerState,
} from "./turn-timer"

const FORCE_RULE_RELOAD = process.env.RVB_FORCE_RULE_RELOAD === '1'

// ─── 辅助函数：恢复棋子规则的 effect 函数（用于 API 传输后重新加载）────────────────
function restorePieceRules(state: BattleState): void {
  const reservePieces = Object.values(state.deployment?.reserves ?? {}).flat()
  ;[...state.pieces, ...reservePieces].forEach(piece => {
    // 确保 rules 数组存在
    if (!piece.rules) {
      piece.rules = []
    }

    // 1. 恢复现有规则（全量替换，确保 trigger/effect 都是最新版本）
    if (piece.rules.length > 0) {
      piece.rules = piece.rules.map((rule: any) => {
        if (rule.id) {
          try {
            const reloadedRule = loadRuleById(rule.id, FORCE_RULE_RELOAD)
            if (reloadedRule && typeof reloadedRule.effect === 'function') {
              return reloadedRule
            }
          } catch {
            // 忽略规则重载错误
          }
        }
        return rule
      })
    }

    // 2. 根据状态标签重新添加丢失的规则
    if (piece.statusTags && piece.statusTags.length > 0) {
      piece.statusTags.forEach((statusTag: any) => {
        // 检查状态标签是否有关联的规则
        if (statusTag.relatedRules && statusTag.relatedRules.length > 0) {
          statusTag.relatedRules.forEach((ruleId: string) => {
            // 检查规则是否已存在
            const existingRule = piece.rules!.find((r: any) => r.id === ruleId)
            if (!existingRule) {
              // 规则不存在，重新添加
              try {
                const reloadedRule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
                if (reloadedRule && typeof reloadedRule.effect === 'function') {
                  piece.rules!.push(reloadedRule)
                }
              } catch {
                // 忽略规则重载错误
              }
            }
          })
        }

        // 注意：规则应该通过 statusTag.relatedRules 来关联
        // 不要在这里硬编码状态到规则的映射
        // 每个技能在添加状态时应该自行设置 relatedRules
      })
    }
  })
}

// ─── 辅助函数：恢复玩家规则的 effect 函数（用于 API 传输后重新加载）────────────────
function restorePlayerRules(state: BattleState): void {
  state.players.forEach(player => {
    // 确保 rules 数组存在
    if (!player.rules) {
      player.rules = []
    }

    // 恢复现有规则（全量替换，确保 trigger/effect 都是最新版本）
    if (player.rules.length > 0) {
      player.rules = player.rules.map((rule: any) => {
        if (rule.id) {
          try {
            const reloadedRule = loadRuleById(rule.id, FORCE_RULE_RELOAD)
            if (reloadedRule && typeof reloadedRule.effect === 'function') {
              return reloadedRule
            }
          } catch {
            // 忽略规则重载错误
          }
        }
        return rule
      })
    }
  })
}

// ─── 辅助函数：安全地克隆 BattleState（处理函数无法克隆的问题）────────────────
export function safeCloneBattleState(state: BattleState): BattleState {
  // 收集所有规则的 effect 函数（pieces + graveyard + players）
  type RuleFnMap = Map<number, any[]>
  const collectRuleFns = (list: any[]): RuleFnMap => {
    const map: RuleFnMap = new Map()
    list.forEach((item, i) => {
      const rules = item.rules
      if (rules && rules.length > 0) map.set(i, rules.map((r: any) => r.effect))
    })
    return map
  }
  const pieceFns   = collectRuleFns(state.pieces)
  const graveFns   = collectRuleFns((state as any).graveyard || [])
  const playerFns  = collectRuleFns(state.players)
  const reserveFns = Object.fromEntries(
    Object.entries(state.deployment?.reserves ?? {}).map(([playerId, pieces]) => [
      playerId,
      collectRuleFns(pieces),
    ]),
  )

  // JSON 序列化/反序列化：自动剥离所有函数（编译缓存、effect 等），不需要临时删除
  const cloned = JSON.parse(JSON.stringify(state)) as BattleState

  // 恢复 effect 函数到克隆对象
  const restoreRuleFns = (clonedList: any[], fnMap: RuleFnMap) => {
    fnMap.forEach((fns, i) => {
      const rules = clonedList[i]?.rules
      if (rules) rules.forEach((r: any, j: number) => { r.effect = fns[j] })
    })
  }
  restoreRuleFns(cloned.pieces, pieceFns)
  restoreRuleFns((cloned as any).graveyard || [], graveFns)
  restoreRuleFns(cloned.players, playerFns)
  for (const [playerId, fnMap] of Object.entries(reserveFns)) {
    restoreRuleFns(cloned.deployment?.reserves?.[playerId] ?? [], fnMap)
  }

  cloned._v = BATTLE_STATE_VERSION
  return cloned
}

export type TurnPhase = "start" | "action" | "end"

export type PlayerId = string

export interface PlayerTurnMeta {
  playerId: PlayerId
  /** 玩家昵称 */
  name?: string
  /** 当前累计的充能点数（用于释放充能技能） */
  chargePoints: number
  /** 当前行动点 */
  actionPoints: number
  /** 最大行动点 */
  maxActionPoints: number
  /** 当前手牌（最多 10 张） */
  hand: {
    cardId: string
    instanceId: string
    ownerPlayerId: string
    actionPointCost?: number
    baseActionPointCost?: number
    temporaryCostReductionTurnNumber?: number
    contentState?: Record<string, unknown>
    presentation?: {
      variant?: string
      badge?: string
      description?: string
    }
    effectModifiers?: Array<{
      effect: 'damage' | 'heal' | 'statusIntensity'
      operation: 'add' | 'multiply'
      value: number
      statusType?: string
    }>
    name?: string
    description?: string
    icon?: string
    type?: string
  }[]
  /** 弃牌堆（只记 cardId） */
  discardPile: string[]
  /** 玩家级别规则（挂在玩家身上而非棋子上的被动触发器） */
  rules?: any[]
  /** 玩家级别状态标签（如时空扭曲等阵营buff） */
  statusTags?: any[]
  /** 玩家级别技能（如暴风雪等持续效果技能） */
  skills?: { skillId: string; currentCooldown?: number }[]
}

export interface PerTurnActionFlags {
  hasMoved: boolean
  hasUsedBasicSkill: boolean
  hasUsedChargeSkill: boolean
}

export interface TurnState {
  /** 当前处于回合中的玩家 */
  currentPlayerId: PlayerId
  /** 当前是第几个整回合（从 1 开始） */
  turnNumber: number
  phase: TurnPhase
  actions: PerTurnActionFlags
}

export interface BattleActionLog {
  type: string
  playerId: PlayerId
  turn: number
  payload?: {
    message?: string
    [key: string]: any
  }
}

export interface DeploymentPosition {
  x: number
  y: number
}

export interface DeploymentChoice {
  pieceId: string | null
}

export interface DeploymentLock {
  locked: boolean
  reason?: 'player' | 'timeout'
}

export type DeploymentMode = 'legacy-reroll-v1' | 'progressive-reserve-v1'

export type DeploymentStatus =
  | 'awaiting-locks'
  | 'awaiting-reserve-deploy'
  | 'turn-ready'
  | 'complete'

export interface DeploymentOfferPiece {
  instanceId: string
  templateId: string
  name: string
}

export interface DeploymentState {
  /** Missing on RED-29 saved states, which are interpreted as legacy-reroll-v1. */
  mode?: DeploymentMode
  status: DeploymentStatus
  playerIds: PlayerId[]
  choices: Record<PlayerId, DeploymentChoice>
  locks: Record<PlayerId, DeploymentLock>
  startedAt: number
  deadlineAt: number
  revision: number
  /** Set only after both seeded opening summons and their trigger queues finish. */
  openingVanguardsInitialized?: boolean
  initialPositions: Record<string, DeploymentPosition>
  finalPositions?: Record<string, DeploymentPosition>
  /** Server-only stable core instances that have not entered the board. */
  reserves?: Record<PlayerId, PieceInstance[]>
  /** Public count only; reserve identities and order remain server-private. */
  reserveCounts?: Record<PlayerId, number>
  activePlayerId?: PlayerId
  offerTurnNumber?: number
  /** Server-private IDs. The public projection exposes them only to activePlayerId. */
  offerPieceIds?: string[]
  /** Projection-only summaries for the active player. */
  offerPieces?: DeploymentOfferPiece[]
  /** Server-authoritative safe cells, exposed only to activePlayerId. */
  legalPositions?: DeploymentPosition[]
  lastDeployedPieceId?: string
}

export interface BattleState {
  map: BoardMap
  pieces: PieceInstance[]
  /** 墓地 - 存放死亡的棋子信息 */
  graveyard: PieceInstance[]
  /** 按棋子模板 ID 存储基础数值，供移动范围等逻辑使用 */
  pieceStatsByTemplateId: Record<string, PieceStats>
  /** 技能静态定义 */
  skillsById: Record<string, SkillDefinition>
  /** 两个玩家的资源状态（充能点等） */
  players: PlayerTurnMeta[]
  turn: TurnState
  /** RED-34 authoritative terminal result committed exactly once by the server. */
  terminalResult?: TerminalResult
  /** RED-36 server-authoritative growing turn clock and per-player no-op streaks. */
  turnTimer?: TurnTimerState
  /** RED-29 同时部署状态；完成前普通战斗命令均被拒绝。 */
  deployment?: DeploymentState
  /** 战斗日志 */
  actions?: BattleActionLog[]
  /** 扩展数据 - 角色特定的数据存储在这里 */
  extensions?: Record<string, any>
  customCards?: Record<string, any>
  /** gameStart 触发器是否已触发过 */
  gameStartFired?: boolean
  /** 任意时机挂起的玩家选项选择 */
  pendingOptionSelection?: PendingOptionSelectionSession
  /** 任意时机挂起的可版本化玩家目标选择会话。 */
  pendingTargetSelection?: PendingTargetSelectionSession
  /** 仅用于目标查询/提交的新旧状态判定；每个成功动作单调递增。 */
  targetingRevision?: number
  /** 状态序列化版本号，升级时不兼容的旧状态会被拒绝 */
  _v?: number
}

type TargetedActionFields = TargetSelectionCredential & {
  targetX?: number
  targetY?: number
  targetPieceId?: string
  extraTargets?: Array<{ pieceId?: string; x?: number; y?: number }>
}

export type BattleAction =
  | { type: "beginPhase" } // 用于从 start -> action 或 end -> 下个回合的 start
  | {
      type: "deploymentChoice"
      playerId: PlayerId
      pieceId?: string | null
      clientActionId?: string
    }
  | {
      type: "deploymentLock"
      playerId: PlayerId
      clientActionId?: string
    }
  | {
      type: "deploymentTimeout"
      now: number
      clientActionId?: string
    }
  | {
      type: "deployReservePiece"
      playerId: PlayerId
      expectedDeploymentRevision: number
      pieceId: string
      toX?: number
      toY?: number
      clientActionId?: string
    }
  | {
      type: "turnTimerSync"
      receivedAt: number
      now: number
      actorPlayerId?: PlayerId
      acceptedActionType?: BattleAction['type']
      clientActionId?: string
    }
  | {
      type: "turnTimerBurn"
      now: number
      clientActionId?: string
    }
  | {
      type: "turnTimeout"
      now: number
      clientActionId?: string
      expectedTurnNumber?: number
      expectedDeadlineAt?: number
      expectedInputOwnerPlayerId?: PlayerId
      expectedPendingOwnerPlayerId?: PlayerId | null
      expectedPendingSelectionId?: string | null
      expectedPendingStateRevision?: number | null
    }
  | {
      type: "move"
      playerId: PlayerId
      pieceId: string
      toX: number
      toY: number
    }
  | ({
      type: "useBasicSkill"
      playerId: PlayerId
      pieceId: string
      skillId: string
      /** 用户通过选项选择器选择的值 */
      selectedOption?: any
    } & TargetedActionFields)
  | ({
      type: "useChargeSkill"
      playerId: PlayerId
      pieceId: string
      skillId: string
      /** 用户通过选项选择器选择的值 */
      selectedOption?: any
    } & TargetedActionFields)
  | {
      type: "endTurn"
      playerId: PlayerId
    }
  | {
      type: "grantChargePoints"
      playerId: PlayerId
      amount: number
    }
  | {
      type: "surrender"
      playerId: PlayerId
      reason?: "voluntary" | "timeout"
    }
  | ({
      type: "playCard"
      playerId: PlayerId
      cardInstanceId: string
      selectedOption?: any
    } & TargetedActionFields)
  | {
      type: "pendingOptionSelect"
      playerId: PlayerId
      selectedOption: any
    } & TargetSelectionCredential
  | ({
      type: "pendingTargetSelect"
      playerId: PlayerId
    } & TargetedActionFields)
  | ({
      type: "cancelPendingSelection"
      playerId: PlayerId
    } & TargetSelectionCredential)

export class BattleRuleError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
    this.name = "BattleRuleError"
  }
}

function getPlayerMeta(state: BattleState, playerId: PlayerId): PlayerTurnMeta {
  const meta = state.players.find((p) => p.playerId === playerId)
  if (!meta) {
    throw new BattleRuleError("Player not found in battle state")
  }
  return meta
}

function isCurrentPlayer(state: BattleState, playerId: PlayerId): boolean {
  // 使用大小写不敏感的比较
  return state.turn.currentPlayerId.toLowerCase() === playerId.toLowerCase()
}

function normalizeStablePlayerId(playerId: string): string {
  return playerId.trim().toLowerCase()
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function resolveDeploymentChoices(state: BattleState, deployment: DeploymentState): void {
  const runtime = getActiveRuleRuntime()
  if (!runtime) throw new BattleRuleError('Deployment resolution requires a deterministic rule runtime')

  for (const playerId of [...deployment.playerIds].sort(compareStableText)) {
    const pieceId = deployment.choices[playerId]?.pieceId
    if (!pieceId) continue

    const piece = state.pieces.find(candidate => candidate.instanceId === pieceId)
    if (!piece || piece.x === null || piece.y === null) {
      throw new BattleRuleError(`Deployment piece ${pieceId} is unavailable during resolution`)
    }
    const original = deployment.initialPositions[pieceId]
    if (!original) throw new BattleRuleError(`Deployment piece ${pieceId} has no initial position`)

    const occupied = new Set(state.pieces
      .filter(candidate => candidate.currentHp > 0 && candidate.instanceId !== pieceId && candidate.x !== null && candidate.y !== null)
      .map(candidate => `${candidate.x},${candidate.y}`))
    const candidates = state.map.tiles
      .filter(tile => (
        tile.props.walkable === true
        && tile.props.type === 'floor'
        && (tile.x !== original.x || tile.y !== original.y)
        && !occupied.has(`${tile.x},${tile.y}`)
      ))
      .sort((left, right) => left.y - right.y || left.x - right.x)
    if (candidates.length === 0) throw new BattleRuleError(`No legal reroll position exists for ${pieceId}`)

    const streamName = `${RANDOM_STREAM_NAMES.deploymentReroll}/${playerId}`
    const target = candidates[runtime.nextInt(streamName, candidates.length)]
    piece.x = target.x
    piece.y = target.y
  }

  deployment.status = 'complete'
  deployment.finalPositions = Object.fromEntries(state.pieces
    .filter(piece => piece.isCore === true && piece.x !== null && piece.y !== null)
    .map(piece => [piece.instanceId, { x: piece.x as number, y: piece.y as number }]))
}

function progressiveReserveEntry(
  deployment: DeploymentState,
  playerId: string,
): { playerId: string; pieces: PieceInstance[] } | undefined {
  const normalized = normalizeStablePlayerId(playerId)
  const stablePlayerId = Object.keys(deployment.reserves ?? {}).find(
    candidate => normalizeStablePlayerId(candidate) === normalized,
  )
  return stablePlayerId
    ? { playerId: stablePlayerId, pieces: deployment.reserves?.[stablePlayerId] ?? [] }
    : undefined
}

function updateProgressiveReserveCounts(deployment: DeploymentState): void {
  deployment.reserveCounts = Object.fromEntries(
    deployment.playerIds.map(playerId => [
      playerId,
      progressiveReserveEntry(deployment, playerId)?.pieces.length ?? 0,
    ]),
  )
}

function allProgressiveReservesEmpty(deployment: DeploymentState): boolean {
  return deployment.playerIds.every(
    playerId => (progressiveReserveEntry(deployment, playerId)?.pieces.length ?? 0) === 0,
  )
}

function clearProgressiveTurnInput(deployment: DeploymentState): void {
  delete deployment.activePlayerId
  delete deployment.offerTurnNumber
  delete deployment.offerPieceIds
  delete deployment.offerPieces
  delete deployment.legalPositions
}

function isCurrentTurnDeploymentFirstMoveFree(
  statusTag: PieceStatusTag,
  turnNumber: number,
): boolean {
  return statusTag.type === DEPLOYMENT_FIRST_MOVE_FREE_STATUS
    && statusTag.grantedTurnNumber === turnNumber
    && statusTag.currentUses === 1
}

function grantDeploymentFirstMoveFree(piece: PieceInstance, turnNumber: number): void {
  piece.statusTags = (piece.statusTags ?? []).filter(
    statusTag => statusTag.type !== DEPLOYMENT_FIRST_MOVE_FREE_STATUS,
  )
  piece.statusTags.push({
    id: DEPLOYMENT_FIRST_MOVE_FREE_STATUS,
    type: DEPLOYMENT_FIRST_MOVE_FREE_STATUS,
    name: '本回合首次移动免费',
    visible: true,
    grantedTurnNumber: turnNumber,
    currentDuration: 1,
    currentUses: 1,
  })
}

function consumeDeploymentFirstMoveFree(piece: PieceInstance, turnNumber: number): boolean {
  const statusIndex = (piece.statusTags ?? []).findIndex(
    statusTag => isCurrentTurnDeploymentFirstMoveFree(statusTag, turnNumber),
  )
  if (statusIndex < 0) return false
  piece.statusTags.splice(statusIndex, 1)
  return true
}

function clearDeploymentFirstMoveFree(state: BattleState): void {
  const candidates = [
    ...state.pieces,
    ...(state.graveyard ?? []),
    ...Object.values(state.deployment?.reserves ?? {}).flat(),
  ]
  const seen = new Set<PieceInstance>()
  for (const piece of candidates) {
    if (seen.has(piece)) continue
    seen.add(piece)
    piece.statusTags = (piece.statusTags ?? []).filter(
      statusTag => statusTag.type !== DEPLOYMENT_FIRST_MOVE_FREE_STATUS,
    )
  }
}

function assertExpectedProgressiveDeploymentRevision(
  state: BattleState,
  expectedDeploymentRevision: number,
): DeploymentState {
  const deployment = state.deployment
  if (!Number.isSafeInteger(expectedDeploymentRevision)
    || !deployment
    || !Number.isSafeInteger(deployment.revision)
    || expectedDeploymentRevision !== deployment.revision) {
    throw new BattleRuleError(
      'Progressive deployment command revision is stale or invalid',
      'PROGRESSIVE_DEPLOYMENT_STALE_REVISION',
    )
  }
  return deployment
}

function startProgressiveDeploymentTurn(state: BattleState): boolean {
  const deployment = state.deployment
  if (!deployment || deployment.mode !== PROGRESSIVE_DEPLOYMENT_MODE) return false

  updateProgressiveReserveCounts(deployment)
  const currentPlayerId = state.turn.currentPlayerId
  const reserve = progressiveReserveEntry(deployment, currentPlayerId)?.pieces ?? []
  if (reserve.length === 0) {
    clearProgressiveTurnInput(deployment)
    deployment.status = allProgressiveReservesEmpty(deployment) ? 'complete' : 'turn-ready'
    return false
  }

  const runtime = getActiveRuleRuntime()
  if (!runtime) {
    throw new BattleRuleError(
      'Progressive deployment offer requires a deterministic rule runtime',
      'PROGRESSIVE_DEPLOYMENT_RUNTIME_REQUIRED',
    )
  }
  const pool = [...reserve].sort((left, right) => compareStableText(left.instanceId, right.instanceId))
  const offerCount = Math.min(3, pool.length)
  const streamName = `${RANDOM_STREAM_NAMES.progressiveDeploymentOffer}/${normalizeStablePlayerId(currentPlayerId)}`
  for (let index = 0; index < offerCount; index += 1) {
    const selectedIndex = index + runtime.nextInt(streamName, pool.length - index)
    const selected = pool[selectedIndex]
    pool[selectedIndex] = pool[index]
    pool[index] = selected
  }

  deployment.status = 'awaiting-reserve-deploy'
  deployment.activePlayerId = currentPlayerId
  deployment.offerTurnNumber = state.turn.turnNumber
  deployment.offerPieceIds = pool.slice(0, offerCount).map(piece => piece.instanceId)
  deployment.legalPositions = getSafeDeploymentPositions(state)
  deployment.revision += 1
  return true
}

function appendTriggerMessages(
  state: BattleState,
  playerId: string,
  result: TriggerResult,
): void {
  if (!result.success || result.messages.length === 0) return
  if (!state.actions) state.actions = []
  result.messages.forEach(message => {
    state.actions!.push({
      type: 'triggerEffect',
      playerId,
      turn: state.turn.turnNumber,
      payload: { message },
    })
  })
}

function assertSynchronousSummonTrigger(result: TriggerResult, eventType: string): void {
  if (!result.needsOptionSelection && !result.needsTargetSelection) return
  throw new BattleRuleError(
    `[${eventType}] interactive trigger is unsupported at this summon boundary`,
    'INTERACTIVE_TRIGGER_UNSUPPORTED',
  )
}

function commitReservePieceSummon(
  state: BattleState,
  playerId: string,
  pieceId: string,
  position: DeploymentPosition,
  positionPolicy: 'safe' | 'fallback',
): PieceInstance {
  const deployment = state.deployment
  if (!deployment || deployment.mode !== PROGRESSIVE_DEPLOYMENT_MODE) {
    throw new BattleRuleError('Progressive deployment is unavailable')
  }
  const reserveEntry = progressiveReserveEntry(deployment, playerId)
  const reserveIndex = reserveEntry?.pieces.findIndex(piece => piece.instanceId === pieceId) ?? -1
  const piece = reserveIndex >= 0 ? reserveEntry!.pieces[reserveIndex] : undefined
  if (!piece || piece.isCore !== true || piece.currentHp <= 0) {
    throw new BattleRuleError('Reserve core is unavailable')
  }

  const beforeContext = {
    type: 'beforePieceSummoned' as const,
    playerId,
    targetPosition: { ...position },
    pieceTemplateId: piece.templateId,
    faction: piece.faction,
  }
  const beforeResult = getActiveTriggerSystem().checkTriggers(state, beforeContext)
  assertSynchronousSummonTrigger(beforeResult, 'beforePieceSummoned')
  appendTriggerMessages(state, playerId, beforeResult)
  if (beforeResult.blocked) {
    throw new BattleRuleError(
      beforeResult.messages.join('；') || 'Reserve summon was blocked',
      'PROGRESSIVE_DEPLOYMENT_SUMMON_BLOCKED',
    )
  }

  const finalPosition = beforeContext.targetPosition
  const legalFinalPositions = positionPolicy === 'safe'
    ? getSafeDeploymentPositions(state)
    : getEmptyWalkableDeploymentPositions(state)
  if (!finalPosition || !legalFinalPositions.some(candidate =>
    candidate.x === finalPosition.x && candidate.y === finalPosition.y)) {
    throw new BattleRuleError(
      positionPolicy === 'safe'
        ? 'Summon trigger changed the deployment outside the authoritative safe cells'
        : 'Summon trigger changed the fallback deployment to an invalid position',
      'PROGRESSIVE_DEPLOYMENT_TRIGGER_POSITION_INVALID',
    )
  }

  reserveEntry!.pieces.splice(reserveIndex, 1)
  piece.x = finalPosition.x
  piece.y = finalPosition.y
  const deployedPosition = { x: finalPosition.x, y: finalPosition.y }
  state.pieces.push(piece)
  updateProgressiveReserveCounts(deployment)

  const afterResult = getActiveTriggerSystem().checkTriggers(state, {
    type: 'afterPieceSummoned',
    playerId,
    sourcePiece: piece,
    pieceTemplateId: piece.templateId,
    faction: piece.faction,
  })
  assertSynchronousSummonTrigger(afterResult, 'afterPieceSummoned')
  appendTriggerMessages(state, playerId, afterResult)

  if (!state.actions) state.actions = []
  state.actions.push({
    type: 'deployReservePiece',
    playerId,
    turn: state.turn.turnNumber,
    payload: {
      message: `${piece.name || piece.templateId} entered the board at (${deployedPosition.x}, ${deployedPosition.y})`,
      pieceId: piece.instanceId,
      toX: deployedPosition.x,
      toY: deployedPosition.y,
    },
  })
  return piece
}

function finishProgressiveDeploymentTurn(state: BattleState): BattleState {
  const deployment = state.deployment
  if (!deployment || deployment.mode !== PROGRESSIVE_DEPLOYMENT_MODE) return state
  clearProgressiveTurnInput(deployment)
  updateProgressiveReserveCounts(deployment)
  deployment.status = allProgressiveReservesEmpty(deployment) ? 'complete' : 'turn-ready'
  deployment.revision += 1
  return applyBattleActionInternal(state, { type: 'beginPhase' }, {
    skipProgressiveDeployment: true,
  })
}

// 辅助函数：大小写不敏感地比较两个玩家ID
function isSamePlayer(playerId1: PlayerId, playerId2: PlayerId): boolean {
  return playerId1.toLowerCase() === playerId2.toLowerCase()
}

/**
 * 普通移动统一使用 spatial.ts 的纯规则：直线、moveRange、地形与存活棋子阻挡。
 */
function validateMove(
  state: BattleState,
  piece: PieceInstance,
  toX: number,
  toY: number,
): void {
  const rejection = getNormalMoveRejection(state, piece, { x: toX, y: toY })
  if (rejection) throw new BattleRuleError(rejection.message)
}

function getSkillDefinitionOrThrow(state: BattleState, skillId: string): SkillDefinition {
  const skillDef = state.skillsById[skillId] || getSkillById(skillId)
  if (!skillDef) {
    throw new BattleRuleError(`Skill ${skillId} not found`)
  }
  return skillDef
}

function validateDeclaredSkillTarget(
  state: BattleState,
  piece: PieceInstance,
  skillDef: SkillDefinition,
  action: { targetPieceId?: string; targetX?: number; targetY?: number },
): void {
  const targetType = (skillDef as any).targetType
  const filter = (skillDef as any).filter
  const range = (skillDef as any).range
  if (!targetType || (action.targetPieceId === undefined && (action.targetX === undefined || action.targetY === undefined))) {
    return
  }

  if (targetType === "piece") {
    const target = action.targetPieceId
      ? state.pieces.find(p => p.instanceId === action.targetPieceId && p.currentHp > 0)
      : state.pieces.find(p => p.x === action.targetX && p.y === action.targetY && p.currentHp > 0)
    if (!target) {
      throw new BattleRuleError("Invalid skill target")
    }
    const isAlly = isSamePlayer(target.ownerPlayerId, piece.ownerPlayerId)
    if (filter === "ally" && !isAlly) throw new BattleRuleError("Skill target must be an ally")
    if (filter === "enemy" && isAlly) throw new BattleRuleError("Skill target must be an enemy")
    if (typeof range === "number") {
      if (piece.x == null || piece.y == null || target.x == null || target.y == null) {
        throw new BattleRuleError("Skill target is out of range")
      }
      const distance = manhattanDistance(piece, target)
      if (distance > range) throw new BattleRuleError("Skill target is out of range")
    }
    return
  }

  if ((targetType === "grid" || targetType === "cell") && action.targetX !== undefined && action.targetY !== undefined) {
    const tile = state.map.tiles.find(t => t.x === action.targetX && t.y === action.targetY)
    if (!tile) throw new BattleRuleError("Skill target is outside of the board")
    if (typeof range === "number") {
      if (piece.x == null || piece.y == null) {
        throw new BattleRuleError("Skill target is out of range")
      }
      const distance = manhattanDistance(piece, { x: action.targetX, y: action.targetY })
      if (distance > range) throw new BattleRuleError("Skill target is out of range")
    }
  }
}

function validateSkillActionBasics(
  state: BattleState,
  piece: PieceInstance,
  playerId: PlayerId,
  skillId: string,
  action: { targetPieceId?: string; targetX?: number; targetY?: number },
  isChargeAction: boolean,
): SkillDefinition {
  const skillDef = getSkillDefinitionOrThrow(state, skillId)
  const playerMeta = getPlayerMeta(state, playerId)
  const isChargeSkill = (skillDef.chargeCost ?? 0) > 0
  if (isChargeAction !== isChargeSkill) {
    throw new BattleRuleError(isChargeSkill
      ? 'Charge skills must use the useChargeSkill action'
      : 'Basic skills must use the useBasicSkill action')
  }
  if (playerMeta.actionPoints < (skillDef.actionPointCost || 0)) {
    throw new BattleRuleError(`Not enough action points to use ${skillDef.name}`)
  }
  const chargeCost = getEffectiveChargeCost(state, playerId, skillDef)
  if (isChargeAction && playerMeta.chargePoints < chargeCost) {
    throw new BattleRuleError("Not enough charge points to use this skill")
  }
  if (piece.skills) {
    const skillState = piece.skills.find(s => s.skillId === skillId)
    if (skillState && skillState.currentCooldown && skillState.currentCooldown > 0) {
      throw new BattleRuleError(`Skill ${skillId} is on cooldown for ${skillState.currentCooldown} more turns`)
    }
    if (skillState && skillDef.type === "ultimate" && (skillState.usesRemaining ?? 0) <= 0) {
      throw new BattleRuleError(`Ultimate skill ${skillId} has already been used`)
    }
  }
  validateDeclaredSkillTarget(state, piece, skillDef, action)
  return skillDef
}

function applySkillPayment(
  state: BattleState,
  piece: PieceInstance,
  playerId: PlayerId,
  skillId: string,
  skillDef: SkillDefinition,
  chargeCost = 0,
): void {
  const playerMeta = getPlayerMeta(state, playerId)
  playerMeta.actionPoints -= skillDef.actionPointCost || 0

  if (chargeCost > 0) {
    playerMeta.chargePoints -= chargeCost
  }

  if (skillDef.cooldownTurns > 0 || skillDef.type === "ultimate") {
    if (piece.skills) {
      const skillIndex = piece.skills.findIndex(s => s.skillId === skillId)
      if (skillIndex !== -1) {
        if (skillDef.cooldownTurns > 0) {
          piece.skills[skillIndex].currentCooldown = skillDef.cooldownTurns
        }
        if (skillDef.type === "ultimate") {
          piece.skills[skillIndex].usesRemaining = (piece.skills[skillIndex].usesRemaining ?? 0) - 1
        }
      }
    } else {
      piece.skills = [{
        skillId,
        level: 1,
        currentCooldown: skillDef.cooldownTurns,
        usesRemaining: skillDef.type === "ultimate" ? 0 : -1,
      }]
    }
  }
}

function pushInterruptedSkillLog(
  state: BattleState,
  actionType: "useBasicSkill" | "useChargeSkill",
  playerId: PlayerId,
  piece: PieceInstance,
  skillId: string,
  skillDef: SkillDefinition,
): void {
  if (!state.actions) {
    state.actions = []
  }
  const pieceName = piece.name || piece.templateId
  state.actions.push({
    type: actionType,
    playerId,
    turn: state.turn.turnNumber,
    payload: {
      message: `${pieceName} used ${skillDef.name || skillId}, but the release was interrupted`,
      skillId,
      pieceId: piece.instanceId,
      interrupted: true,
    },
  } as any)
}

function validateDeclaredCardTarget(
  state: BattleState,
  action: { targetPieceId?: string; targetX?: number; targetY?: number },
): void {
  if (action.targetPieceId) {
    const target = state.pieces.find(p => p.instanceId === action.targetPieceId && p.currentHp > 0)
    if (!target) {
      throw new BattleRuleError("Invalid card target")
    }
  }
  if (action.targetX !== undefined && action.targetY !== undefined) {
    const tile = state.map.tiles.find(t => t.x === action.targetX && t.y === action.targetY)
    if (!tile) {
      throw new BattleRuleError("Card target is outside of the board")
    }
  }
}

function getCardTargetArgs(
  state: BattleState,
  action: { targetPieceId?: string; targetX?: number; targetY?: number },
): { targetPiece?: PieceInstance; targetPosition?: { x: number; y: number } } {
  const targetPiece = action.targetPieceId
    ? state.pieces.find(p => p.instanceId === action.targetPieceId && p.currentHp > 0)
    : undefined
  const targetPosition = action.targetX !== undefined && action.targetY !== undefined
    ? { x: action.targetX, y: action.targetY }
    : undefined
  return { targetPiece, targetPosition }
}

function assertCardDryRunResult(result: any): void {
  if (result.needsTargetSelection) {
    const err = new BattleRuleError('需要选择目标') as any
    err.needsTargetSelection = true
    err.targetType = result.targetType || 'piece'
    err.range = result.range || 999
    err.filter = result.filter || 'all'
    err.targetIndex = result.targetIndex
    throw err
  }
  if (result.needsOptionSelection) {
    const err = new BattleRuleError('需要选择选项') as any
    err.needsOptionSelection = true
    err.options = result.options || []
    err.title = result.title || '请选择'
    throw err
  }
  if (!result.success) {
    throw new BattleRuleError(result.message || "卡牌效果执行失败")
  }
}

function dryRunCardAction(
  state: BattleState,
  action: any,
  cardDef: any,
  executeCardFunction: Function,
): void {
  withRuleRuntimeCheckpoint(() => {
    const dryState = safeCloneBattleState(state)
    const { targetPiece, targetPosition } = getCardTargetArgs(dryState, action)
    const cardInstance = dryState.players
      .find(player => player.playerId === action.playerId)
      ?.hand.find(card => card.instanceId === action.cardInstanceId)
    const result = executeCardFunction(
      cardDef,
      action.playerId,
      dryState,
      undefined,
      targetPiece,
      targetPosition,
      action.selectedOption,
      action.extraTargets,
      cardInstance,
    )
    assertCardDryRunResult(result)
  })
}

function buildSkillTargetSlot(
  state: BattleState,
  pieceId: string | undefined,
  tx: number | undefined,
  ty: number | undefined,
) {
  if (pieceId) {
    const tp = state.pieces.find(p => p.instanceId === pieceId)
    if (tp) {
      return {
        info: {
          instanceId: tp.instanceId,
          templateId: tp.templateId,
          ownerPlayerId: tp.ownerPlayerId,
          currentHp: tp.currentHp,
          maxHp: tp.maxHp,
          attack: tp.attack,
          defense: tp.defense,
          x: tp.x || 0,
          y: tp.y || 0,
        },
        pos: { x: tp.x || 0, y: tp.y || 0 },
      }
    }
  } else if (tx !== undefined && ty !== undefined) {
    return { info: null, pos: { x: tx, y: ty } }
  }
  return { info: null, pos: null }
}

function buildSkillExecutionContext(
  state: BattleState,
  piece: PieceInstance,
  action: any,
  skillDef: SkillDefinition,
) {
  const t1 = buildSkillTargetSlot(state, action.targetPieceId, action.targetX, action.targetY)
  const extraTargets: Array<{pieceId?: string; x?: number; y?: number}> = action.extraTargets || []
  const targets = [
    t1,
    ...extraTargets.map(et => buildSkillTargetSlot(state, et.pieceId, et.x, et.y)),
  ]
  return {
    piece,
    target: t1.info,
    targetPosition: t1.pos,
    targets,
    selectedOption: action.selectedOption,
    playerId: action.playerId,
    battle: state,
    skill: {
      id: skillDef.id,
      name: skillDef.name,
      type: skillDef.type,
      powerMultiplier: skillDef.powerMultiplier,
    },
  }
}

function assertSkillDryRunResult(
  result: any,
  allowOptionSelection = false,
): void {
  if (result.needsTargetSelection) {
    const err = new BattleRuleError('需要选择目标') as any
    err.needsTargetSelection = true
    err.targetType = result.targetType || 'piece'
    err.range = result.range || 5
    err.filter = result.filter || 'enemy'
    err.targetIndex = result.targetIndex
    throw err
  }
  if (result.needsOptionSelection) {
    if (allowOptionSelection) return
    const err = new BattleRuleError('需要选择选项') as any
    err.needsOptionSelection = true
    err.options = result.options || []
    err.title = result.title || '请选择'
    throw err
  }
  if (!result.success) {
    throw new BattleRuleError(result.message || '技能预检失败')
  }
}
function dryRunSkillAction(
  state: BattleState,
  piece: PieceInstance,
  action: any,
  skillDef: SkillDefinition,
): void {
  withRuleRuntimeCheckpoint(() => {
    const dryState = safeCloneBattleState(state)
    if (!(dryState as any).extensions) (dryState as any).extensions = {}
    ;(dryState as any).extensions.__dryRunSkillPreflight = true
    const dryPiece = dryState.pieces.find(p => p.instanceId === piece.instanceId && p.currentHp > 0)
    if (!dryPiece) {
      throw new BattleRuleError("Piece not found or is defeated")
    }
    const drySkillDef = dryState.skillsById[skillDef.id] || skillDef
    const result = executeSkillFunction(
      drySkillDef,
      buildSkillExecutionContext(dryState, dryPiece, action, drySkillDef),
      dryState,
    )
    assertSkillDryRunResult(
      result,
      action.selectedOption === undefined,
    )
  })
}
export function validateSkillActionByDryRun(state: BattleState, action: any, skipTargetingValidation = false): void {
  if (action.type !== "useBasicSkill" && action.type !== "useChargeSkill") {
    throw new BattleRuleError("Action is not a skill action")
  }
  const piece = state.pieces.find(
    (p) =>
      p.instanceId === action.pieceId &&
      isSamePlayer(p.ownerPlayerId, action.playerId) &&
      p.currentHp > 0,
  )
  if (!piece) {
    throw new BattleRuleError(
      "Piece not found or does not belong to current player",
    )
  }
  if (!skipTargetingValidation) assertActionTargetingReady(state, action)
  validateSkillActionBasics(
    state,
    piece,
    action.playerId,
    action.skillId,
    action,
    action.type === "useChargeSkill",
  )
}

function applyCardPayment(
  playerMeta: PlayerTurnMeta,
  cardIdx: number,
  cardApCost: number,
): any {
  playerMeta.actionPoints -= cardApCost
  const [cardInstance] = (playerMeta.hand as any[]).splice(cardIdx, 1)
  if (!playerMeta.discardPile) playerMeta.discardPile = []
  ;(playerMeta.discardPile as any[]).push(cardInstance.cardId)
  return cardInstance
}

function pushInterruptedCardLog(
  state: BattleState,
  playerId: PlayerId,
  cardInstance: any,
  cardDef: any,
): void {
  if (!state.actions) {
    state.actions = []
  }
  state.actions.push({
    type: "playCard",
    playerId,
    turn: state.turn.turnNumber,
    payload: {
      message: `Used card ${cardDef.name || cardInstance.cardId}, but the effect was interrupted`,
      cardId: cardInstance.cardId,
      cardInstanceId: cardInstance.instanceId,
      interrupted: true,
    },
  } as any)
}

function requireActionPhase(state: BattleState) {
  if (state.turn.phase !== "action") {
    throw new BattleRuleError("Action can only be performed during action phase")
  }
}

type InternalContinuation = {
  skipTargetingValidation?: boolean
  skipBeginTurn?: boolean
  skipProgressiveDeployment?: boolean
  skipEndTurnTrigger?: boolean
  skipBeforeSkillUse?: boolean
  skipBeforeCardPlay?: boolean
}

function applyBattleActionInternal(
  state: BattleState,
  action: BattleAction,
  continuation: InternalContinuation = {},
): BattleState {
  // 版本检查：若状态已有版本号且与当前不兼容，拒绝处理
  if (state._v !== undefined && state._v !== BATTLE_STATE_VERSION) {
    throw new Error(
      `BattleState version mismatch: state has _v=${state._v}, expected _v=${BATTLE_STATE_VERSION}. ` +
      `The room may be running an outdated game state.`
    )
  }

  const isDeploymentCommand = action.type === 'deploymentChoice'
    || action.type === 'deploymentLock'
    || action.type === 'deploymentTimeout'
    || action.type === 'deployReservePiece'
  const isTimerCommand = isTurnTimerSystemAction(action)
  const isPendingInteractionCommand = action.type === 'pendingOptionSelect'
    || action.type === 'pendingTargetSelect'
    || action.type === 'cancelPendingSelection'
  if (
    state.deployment?.status === 'awaiting-locks'
    && !isDeploymentCommand
    && action.type !== 'surrender'
    && !isPendingInteractionCommand
  ) {
    throw new BattleRuleError('Battle actions are unavailable until deployment is complete')
  }
  if (
    state.deployment?.mode === PROGRESSIVE_DEPLOYMENT_MODE
    && state.deployment.status === 'awaiting-reserve-deploy'
    && !isDeploymentCommand
    && action.type !== 'surrender'
    && !isPendingInteractionCommand
    && !isTimerCommand
  ) {
    throw new BattleRuleError(
      'Resolve the current reserve deployment before taking normal battle actions',
      'PROGRESSIVE_DEPLOYMENT_REQUIRED',
    )
  }

  // RED-59: all target discovery and final target validation happen before
  // cloning, triggers, payment, logging, or effect execution.
  if (action.type !== 'surrender' && !isTimerCommand && !continuation.skipTargetingValidation) {
    assertActionTargetingReady(state, action)
  }
  const validatedPendingTargets = action.type === 'pendingTargetSelect'
    ? validatePendingTargetSubmissions(state, action)
    : undefined
  if (action.type === 'pendingOptionSelect') {
    validatePendingOptionSubmission(state, action)
  }
  if (action.type === 'cancelPendingSelection') {
    if (state.pendingTargetSelection) {
      assertPendingTargetCancellation(state, action)
    } else if (state.pendingOptionSelection) {
      assertPendingOptionCancellation(state, action)
    } else {
      assertPendingTargetCancellation(state, action)
    }
  }

  // 规则恢复会补充数组和 effect 函数；先克隆，确保非法动作不会污染权威输入状态。
  const hydratedState = safeCloneBattleState(state)
  restorePieceRules(hydratedState)
  restorePlayerRules(hydratedState)
  state = hydratedState

  // 飞雷神等被动触发待选择时，禁止非选择动作（防止攻击方绕过等待）
  if (state.pendingOptionSelection && action.type !== 'pendingOptionSelect' && action.type !== 'cancelPendingSelection' && action.type !== 'surrender' && !isTimerCommand) {
    throw new BattleRuleError('请等待对方选择完成后再行动')
  }
  if (state.pendingTargetSelection && action.type !== 'pendingTargetSelect' && action.type !== 'cancelPendingSelection' && action.type !== 'surrender' && !isTimerCommand) {
    throw new TargetingRuleError({
      kind: 'invalid',
      code: 'PENDING_SELECTION_ACTIVE',
      message: '请等待目标选择完成后再行动',
    })
  }

  type PendingSession = PendingOptionSelectionSession | PendingTargetSelectionSession
  type PendingSeed = Partial<PendingSession> & {
    continuationContext?: any
    pendingQueue?: PendingRuleConsumerRef[]
    pendingReactiveCards?: PendingReactiveCardRef[]
    pendingAction?: any
    rollbackOnCancel?: boolean
  }

  const appendTriggerMessages = (next: BattleState, result: TriggerResult, playerId: string) => {
    if (!result.messages?.length) return
    if (!next.actions) next.actions = []
    result.messages.forEach(message => next.actions!.push({
      type: 'triggerEffect',
      playerId,
      turn: next.turn.turnNumber,
      payload: { message },
    }))
  }

  const assertNoUnhandledInteraction = (result: TriggerResult, eventType: string) => {
    if (!result.needsOptionSelection && !result.needsTargetSelection) return
    const kind = result.needsOptionSelection ? 'option' : 'target'
    throw new BattleRuleError(
      `[${eventType}] interactive ${kind} trigger is unsupported at this call site`,
      'INTERACTIVE_TRIGGER_UNSUPPORTED',
    )
  }

  const setPendingInteraction = (
    next: BattleState,
    result: TriggerResult,
    currentContext: any,
    seed: PendingSeed = {},
  ): boolean => {
    if (!result.needsOptionSelection && !result.needsTargetSelection) return false
    const currentRuleId = result.pendingRuleId || currentContext.pendingRuleId
    const currentRuleSourceId = result.pendingRuleSourceId || currentContext.pendingRuleSourceId
    const triggerContext = {
      ...currentContext,
      pendingRuleId: currentRuleId,
      pendingRuleSourceId: currentRuleSourceId,
    }
    const continuationContext = seed.continuationContext || currentContext
    const pendingQueue = result.pendingQueue ?? seed.pendingQueue
    const pendingReactiveCards = result.pendingReactiveCards ?? seed.pendingReactiveCards
    const pendingAction = seed.pendingAction
    next.pendingOptionSelection = undefined
    next.pendingTargetSelection = undefined
    if (result.needsOptionSelection) {
      next.pendingOptionSelection = {
        playerId: result.playerId || next.turn.currentPlayerId,
        options: result.options || [],
        title: result.title || '请选择',
        source: {
          type: currentRuleId ? 'rule' : 'pending',
          id: currentRuleId || 'pending-option',
          pieceId: currentRuleSourceId,
        },
        triggerContext,
        continuationContext,
        pendingQueue,
        pendingReactiveCards,
        pendingAction,
        canCancel: result.canCancel,
        cancelValue: result.cancelValue,
        selectionMode: result.selectionMode,
        presentation: result.presentation,
        minSelections: result.minSelections,
        maxSelections: result.maxSelections,
      }
      return true
    }
    next.pendingTargetSelection = {
      playerId: result.playerId || next.turn.currentPlayerId,
      ownerPlayerId: result.playerId || next.turn.currentPlayerId,
      title: result.title || '请选择目标',
      targetType: (result.targetType || 'piece') as 'piece' | 'cell' | 'grid',
      range: result.range,
      filter: result.filter,
      source: {
        type: currentRuleId ? 'rule' : 'pending',
        id: currentRuleId || 'pending-target',
        pieceId: currentRuleSourceId,
      },
      triggerContext,
      continuationContext,
      pendingQueue,
      pendingReactiveCards,
      pendingAction,
      canCancel: result.canCancel,
      selectionMode: result.selectionMode,
      minSelections: result.minSelections,
      maxSelections: result.maxSelections,
      min: result.minSelections,
      max: result.maxSelections,
      candidates: result.targetCandidates as PendingTargetSelectionSession['candidates'],
      fixedCandidates: Array.isArray(result.targetCandidates),
      effectCode: result.effectCode,
      payload: result.payload,
      resumeOnCancel: result.resumeOnCancel,
      rollbackOnCancel: result.rollbackOnCancel ?? seed.rollbackOnCancel,
    }
    return true
  }

  const setPendingActionOption = (
    next: BattleState,
    result: Pick<TriggerResult,
      'needsOptionSelection' | 'options' | 'title' | 'playerId'
      | 'canCancel' | 'cancelValue' | 'pendingRuleId' | 'pendingRuleSourceId'
      | 'selectionMode' | 'presentation' | 'minSelections' | 'maxSelections'
    >,
    pendingAction: BattleAction,
    fallbackSource: { type: 'skill' | 'card'; id: string; pieceId?: string },
    continuationMode: 'skillReleaseOption' | 'cardReleaseOption',
  ): BattleState => {
    const canResolveCancellation = result.canCancel === true
    next.pendingTargetSelection = undefined
    next.pendingOptionSelection = {
      playerId: result.playerId || ('playerId' in pendingAction ? pendingAction.playerId : next.turn.currentPlayerId),
      title: result.title || '请选择',
      options: result.options || [],
      selectionMode: result.selectionMode,
      presentation: result.presentation,
      minSelections: result.minSelections,
      maxSelections: result.maxSelections,
      source: result.pendingRuleId
        ? {
            type: 'rule',
            id: result.pendingRuleId,
            pieceId: result.pendingRuleSourceId,
          }
        : fallbackSource,
      pendingAction: {
        ...pendingAction,
        __pendingContinuationMode: continuationMode,
      },
      canCancel: canResolveCancellation,
      cancelValue: result.cancelValue,
    }
    return next
  }

  const resumeDeferredAction = (
    next: BattleState,
    pending: PendingSession,
    input: Record<string, unknown>,
    eventBlocked = false,
  ): BattleState => {
    if (!pending.pendingAction) return next
    const resumeAction = { ...pending.pendingAction }
    const mode = resumeAction.__pendingContinuationMode as string | undefined
    delete resumeAction.__pendingContinuationMode
    // begin/end trigger blockers stop the event consumer queue, not the phase
    // settlement. A blocked before-skill/card event still cancels its core action.
    if (eventBlocked && mode !== 'beginPhaseAfterTrigger' && mode !== 'endTurnAfterTrigger') return next
    if (input.selectedOption !== undefined) resumeAction.selectedOption = input.selectedOption
    const trustedContinuation: InternalContinuation = {}
    if (mode === 'beginPhaseAfterTrigger') trustedContinuation.skipBeginTurn = true
    if (mode === 'endTurnAfterTrigger') trustedContinuation.skipEndTurnTrigger = true
    if (mode === 'skillAfterBeforeTrigger' || mode === 'skillReleaseOption') {
      trustedContinuation.skipTargetingValidation = true
      trustedContinuation.skipBeforeSkillUse = true
    }
    if (mode === 'cardReleaseOption') {
      trustedContinuation.skipTargetingValidation = true
      trustedContinuation.skipBeforeCardPlay = true
    }
    return applyBattleActionInternal(next, resumeAction, trustedContinuation)
  }

  const resumePendingInteraction = (
    next: BattleState,
    pending: PendingSession,
    actorPlayerId: string,
    input: Record<string, unknown> = {},
    skipCurrentConsumer = false,
  ): BattleState => {
    const continuationContext = pending.continuationContext || pending.triggerContext || {}
    if (!skipCurrentConsumer && pending.triggerContext) {
      const currentContext = {
        ...pending.triggerContext,
        ...input,
        __deferReactiveCards: true,
        __pendingReactiveCards: pending.pendingReactiveCards,
      }
      const result = getActiveTriggerSystem().checkTriggers(next, currentContext)
      appendTriggerMessages(next, result, actorPlayerId)
      if (result.blocked) return resumeDeferredAction(next, pending, input, true)
      if (setPendingInteraction(next, result, currentContext, {
        continuationContext,
        pendingQueue: result.pendingQueue ?? pending.pendingQueue,
        pendingReactiveCards: result.pendingReactiveCards ?? pending.pendingReactiveCards,
        pendingAction: pending.pendingAction,
      })) return next
    }

    const remaining = [...(pending.pendingQueue || [])]
    while (remaining.length > 0) {
      const item = remaining.shift()!
      const currentContext = {
        ...continuationContext,
        pendingRuleId: item.ruleId,
        pendingRuleSourceId: item.sourceId,
        __deferReactiveCards: true,
        __pendingReactiveCards: pending.pendingReactiveCards,
      }
      const result = getActiveTriggerSystem().checkTriggers(next, currentContext)
      appendTriggerMessages(next, result, actorPlayerId)
      if (result.blocked) return resumeDeferredAction(next, pending, input, true)
      if (setPendingInteraction(next, result, currentContext, {
        continuationContext,
        pendingQueue: remaining,
        pendingReactiveCards: pending.pendingReactiveCards,
        pendingAction: pending.pendingAction,
      })) return next
    }

    if (pending.pendingReactiveCards?.length) {
      const reactiveResult = getActiveTriggerSystem().checkTriggers(next, {
        ...continuationContext,
        __reactiveCardsOnly: true,
        __pendingReactiveCards: pending.pendingReactiveCards,
      })
      appendTriggerMessages(next, reactiveResult, actorPlayerId)
      if (reactiveResult.blocked) return resumeDeferredAction(next, pending, input, true)
    }

    return resumeDeferredAction(next, pending, input)
  }
  const stableTimeoutCandidateKey = (value: unknown): string => {
    if (value === undefined) return 'undefined'
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableTimeoutCandidateKey).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${stableTimeoutCandidateKey(record[key])}`
    )).join(',')}}`
  }

  const uniqueTimeoutCandidates = <T>(values: T[]): T[] => {
    const seen = new Set<string>()
    return values.filter(value => {
      const key = stableTimeoutCandidateKey(value)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const finalizeTimedOutPending = (next: BattleState): PendingSession | undefined => {
    const revision = Number.isSafeInteger(next.targetingRevision) ? next.targetingRevision! : 0
    if (next.pendingOptionSelection) {
      next.pendingOptionSelection = finalizePendingOptionSession(next.pendingOptionSelection, revision)
      return next.pendingOptionSelection
    }
    if (next.pendingTargetSelection) {
      next.pendingTargetSelection = finalizePendingTargetSession(
        next,
        next.pendingTargetSelection,
        revision,
      )
      return next.pendingTargetSelection
    }
    return undefined
  }

  const recordPendingTimeoutResolution = (
    next: BattleState,
    pending: PendingSession,
    resolution: 'cancel' | 'candidate' | 'invariant-skip',
  ): void => {
    if (!next.actions) next.actions = []
    next.actions.push({
      type: 'triggerEffect',
      playerId: pending.playerId,
      turn: next.turn.turnNumber,
      payload: {
        message: `Pending selection timed out: ${resolution}`,
        phase: next.turn.phase,
        selectionId: pending.selectionId,
        stateRevision: pending.stateRevision,
        source: pending.source,
        resolution,
      },
    } as any)
  }

  const skipInvalidTimedOutPending = (
    next: BattleState,
    pending: PendingSession,
  ): BattleState => {
    const context = {
      phase: next.turn.phase,
      callSite: 'applyBattleActionInternal.turnTimeout.resolveTimedOutPending',
      turnNumber: next.turn.turnNumber,
      ownerPlayerId: pending.playerId,
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision,
      source: pending.source,
    }
    const message = `Timed-out mandatory pending has no legal candidates: ${JSON.stringify(context)}`
    const invariant = new BattleRuleError(message, 'PENDING_TIMEOUT_NO_CANDIDATES')
    if (process.env.NODE_ENV !== 'production') {
      throw invariant
    }
    const productionContext = { ...context, stack: invariant.stack }
    console.error('[pending-timeout] invariant', productionContext)
    recordPendingTimeoutResolution(next, pending, 'invariant-skip')
    next.pendingOptionSelection = undefined
    next.pendingTargetSelection = undefined
    return resumePendingInteraction(next, pending, pending.playerId, {}, true)
  }

  const resolveOneTimedOutPending = (next: BattleState): BattleState => {
    const pending = finalizeTimedOutPending(next)
    if (!pending) return next

    if (pending.canCancel !== false) {
      recordPendingTimeoutResolution(next, pending, 'cancel')
      return applyBattleActionInternal(next, {
        type: 'cancelPendingSelection',
        playerId: pending.playerId,
        selectionId: pending.selectionId,
        stateRevision: pending.stateRevision,
      })
    }

    const runtime = getActiveRuleRuntime()
    if (!runtime) {
      throw new BattleRuleError(
        'Mandatory pending timeout resolution requires a deterministic rule runtime',
        'PENDING_TIMEOUT_RUNTIME_REQUIRED',
      )
    }

    if ('options' in pending) {
      const candidates = uniqueTimeoutCandidates((pending.options || []).map(option => {
        if (!option || typeof option !== 'object') return option
        if ('value' in option) return option.value
        if ('id' in option) return option.id
        return option
      }))
      if (candidates.length === 0) return skipInvalidTimedOutPending(next, pending)
      let selectedOption: unknown
      if (pending.selectionMode === 'multi') {
        const minSelections = Number.isSafeInteger(pending.minSelections)
          ? Math.max(0, pending.minSelections!)
          : 1
        if (candidates.length < minSelections) return skipInvalidTimedOutPending(next, pending)
        selectedOption = candidates.slice(0, minSelections)
      } else {
        selectedOption = candidates[runtime.nextInt(
          `${RANDOM_STREAM_NAMES.skillEffect}/pending-timeout`,
          candidates.length,
        )]
      }
      recordPendingTimeoutResolution(next, pending, 'candidate')
      return applyBattleActionInternal(next, {
        type: 'pendingOptionSelect',
        playerId: pending.playerId,
        selectedOption,
        selectionId: pending.selectionId,
        stateRevision: pending.stateRevision,
      })
    }

    const candidates = uniqueTimeoutCandidates(pending.candidates || [])
    if (candidates.length === 0) return skipInvalidTimedOutPending(next, pending)
    const target = candidates[runtime.nextInt(
      `${RANDOM_STREAM_NAMES.skillEffect}/pending-timeout`,
      candidates.length,
    )]
    recordPendingTimeoutResolution(next, pending, 'candidate')
    return applyBattleActionInternal(next, target.type === 'piece'
      ? {
          type: 'pendingTargetSelect',
          playerId: pending.playerId,
          targetPieceId: target.pieceId,
          selectionId: pending.selectionId,
          stateRevision: pending.stateRevision,
        }
      : {
          type: 'pendingTargetSelect',
          playerId: pending.playerId,
          targetX: target.x,
          targetY: target.y,
          selectionId: pending.selectionId,
          stateRevision: pending.stateRevision,
        })
  }

  const resolveTimedOutPendingChain = (input: BattleState): BattleState => {
    let resolved = input
    for (let count = 0; count < 100; count += 1) {
      if (!resolved.pendingOptionSelection && !resolved.pendingTargetSelection) return resolved
      resolved = resolveOneTimedOutPending(resolved)
    }
    throw new BattleRuleError(
      'Timed-out pending interaction chain exceeded the safety limit',
      'PENDING_INTERACTION_TIMEOUT_LOOP',
    )
  }


  if (action.type === 'cancelPendingSelection') {
    const next = safeCloneBattleState(state)
    const pending = (next.pendingOptionSelection || next.pendingTargetSelection) as PendingSession
    next.pendingOptionSelection = undefined
    next.pendingTargetSelection = undefined
    if (!next.actions) next.actions = []
    next.actions.push({
      type: 'cancelPendingSelection',
      playerId: action.playerId,
      turn: next.turn.turnNumber,
      payload: { message: 'Selection cancelled' },
    } as any)
    if (pending.transaction) {
      if ('resumeOnCancel' in pending && pending.resumeOnCancel) {
        return resumeSuspendableActionTransaction(next, pending.transaction, {
          cancelled: true,
          resumeConsumerOnCancel: true,
        })
      }
      if ('options' in pending && pending.cancelValue !== undefined) {
        return resumeSuspendableActionTransaction(next, pending.transaction, {
          selectedOption: pending.cancelValue,
        })
      }
      if (
        (pending.transaction.currentInteraction?.consumerOrdinal ?? 0) <= -2
        || pending.transaction.currentInteraction?.consumerKind === 'rule'
        || pending.transaction.currentInteraction?.consumerKind === 'reactiveCard'
      ) {
        return resumeSuspendableActionTransaction(next, pending.transaction, { cancelled: true })
      }
      return next
    }
    if ('options' in pending && pending.cancelValue !== undefined) {
      return resumePendingInteraction(next, pending, action.playerId, {
        selectedOption: pending.cancelValue,
      })
    }
    return resumePendingInteraction(next, pending, action.playerId, {}, true)
  }

  switch (action.type) {
    case "turnTimerSync": {
      const next = safeCloneBattleState(state)
      const timer = syncTurnTimerAfterAcceptedAction(next, {
        receivedAt: action.receivedAt,
        resumedAt: action.now,
        actorPlayerId: action.actorPlayerId,
        acceptedActionType: action.acceptedActionType,
      })
      if (timer) next.turnTimer = timer
      else delete next.turnTimer
      if (!next.actions) next.actions = []
      if (timer) {
        next.actions.push({
          type: 'turnTimerSync',
          playerId: timer.ownerPlayerId,
          turn: next.turn.turnNumber,
          payload: {
            phase: next.turn.phase,
            fullRound: timer.fullRound,
            deadlineAt: timer.deadlineAt,
            acceptedGameplayAction: timer.acceptedGameplayAction,
            noOpStreak: timer.noOpStreaks[timer.ownerPlayerId] ?? 0,
          },
        })
      }
      return next
    }

    case "turnTimerBurn": {
      const next = safeCloneBattleState(state)
      if (next.turnTimer?.burnPhase === 'burning') return next
      try {
        next.turnTimer = markTurnTimerBurning(next, action.now)
      } catch (error) {
        throw new BattleRuleError(error instanceof Error ? error.message : String(error), 'TURN_TIMER_BURN_REJECTED')
      }
      if (!next.actions) next.actions = []
      next.actions.push({
        type: 'turnTimerBurn',
        playerId: next.turnTimer.ownerPlayerId,
        turn: next.turn.turnNumber,
        payload: {
          message: 'Turn timer entered the final 15-second burn phase',
          fullRound: next.turnTimer.fullRound,
          deadlineAt: next.turnTimer.deadlineAt,
          fast: next.turnTimer.fast,
        },
      })
      return next
    }

    case "turnTimeout": {
      const next = safeCloneBattleState(state)
      try {
        next.turnTimer = recordTurnTimeout(next, action.now)
      } catch (error) {
        throw new BattleRuleError(error instanceof Error ? error.message : String(error), 'TURN_TIMEOUT_REJECTED')
      }
      const timeout = next.turnTimer.lastTimeout!
      if (!next.actions) next.actions = []
      next.actions.push({
        type: 'turnTimeout',
        playerId: timeout.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: timeout.noAcceptedGameplayAction
            ? timeout.countsTowardNoOpStreak
              ? `Own turn timed out without an accepted gameplay action (streak ${timeout.streak})`
              : 'Pending input timed out outside the input owner\'s active turn'
            : 'Turn timed out after an accepted gameplay action',
          fullRound: timeout.fullRound,
          deadlineAt: next.turnTimer.deadlineAt,
          noAcceptedGameplayAction: timeout.noAcceptedGameplayAction,
          countsTowardNoOpStreak: timeout.countsTowardNoOpStreak,
          noOpStreak: timeout.streak,
          timeoutReason: timeout.reason,
        },
      })

      if (timeout.countsTowardNoOpStreak && timeout.streak >= TURN_TIMEOUT_FORFEIT_STREAK) {
        next.pendingOptionSelection = undefined
        next.pendingTargetSelection = undefined
        return next
      }

      // Resolve the expired interaction through the same validated reducers used
      // by a player command. Cancellable sessions cancel; mandatory sessions
      // consume one deterministic candidate. The expired budget is never reset.
      let progressed = resolveTimedOutPendingChain(next)
      finalizeBattleTerminal(progressed, action)
      if (progressed.terminalResult) return progressed
      if (isProgressiveDeployment(progressed)) {
        const deployment = progressed.deployment!
        if (deployment.status === 'awaiting-reserve-deploy') {
          const pieceId = deployment.offerPieceIds?.[0]
          if (!pieceId) {
            throw new BattleRuleError(
              'Progressive deployment timeout has no authoritative offer',
              'PROGRESSIVE_DEPLOYMENT_OFFER_REQUIRED',
            )
          }
          if (getEmptyWalkableDeploymentPositions(progressed).length === 0) {
            throw new BattleRuleError(
              'No empty walkable deployment position exists',
              'PROGRESSIVE_DEPLOYMENT_NO_EMPTY_CELL',
            )
          }
          const safePosition = deployment.legalPositions?.[0]
          progressed = applyBattleActionInternal(progressed, {
            type: 'deployReservePiece',
            playerId: progressed.turn.currentPlayerId,
            expectedDeploymentRevision: deployment.revision,
            pieceId,
            ...(safePosition ? { toX: safePosition.x, toY: safePosition.y } : {}),
          })
          if (progressed.terminalResult) return progressed
        }
      }
      const endTurnAlreadySettled = progressed.turn.phase === 'end'
      if (!endTurnAlreadySettled) {
        progressed = applyBattleActionInternal(progressed, {
          type: 'endTurn',
          playerId: progressed.turn.currentPlayerId,
        })
        progressed = resolveTimedOutPendingChain(progressed)
        finalizeBattleTerminal(progressed, action)
        if (progressed.terminalResult) return progressed
      }
      return applySuspendableChildAction(progressed, { type: 'beginPhase' })
    }

    case 'deployReservePiece': {
      assertExpectedProgressiveDeploymentRevision(state, action.expectedDeploymentRevision)
      const next = safeCloneBattleState(state)
      const deployment = next.deployment
      if (!deployment || deployment.mode !== PROGRESSIVE_DEPLOYMENT_MODE
        || deployment.status !== 'awaiting-reserve-deploy') {
        throw new BattleRuleError('Reserve deployment is not awaiting a piece')
      }
      if (!isCurrentPlayer(next, action.playerId)
        || !isSamePlayer(deployment.activePlayerId ?? '', action.playerId)
        || deployment.offerTurnNumber !== next.turn.turnNumber) {
        throw new BattleRuleError('Reserve deployment belongs to another player or turn')
      }
      if (!(deployment.offerPieceIds ?? []).includes(action.pieceId)) {
        throw new BattleRuleError('Selected piece is not in the authoritative reserve offer')
      }

      const safePositions = getSafeDeploymentPositions(next)
      let position: DeploymentPosition
      if (safePositions.length > 0) {
        if (!Number.isSafeInteger(action.toX) || !Number.isSafeInteger(action.toY)) {
          throw new BattleRuleError('A safe deployment position is required')
        }
        const requested = safePositions.find(candidate =>
          candidate.x === action.toX && candidate.y === action.toY)
        if (!requested) {
          throw new BattleRuleError('Deployment position is outside the authoritative safe cells')
        }
        position = requested
      } else {
        const fallbackPositions = getEmptyWalkableDeploymentPositions(next)
        if (fallbackPositions.length === 0) {
          throw new BattleRuleError(
            'No empty walkable deployment position exists',
            'PROGRESSIVE_DEPLOYMENT_NO_EMPTY_CELL',
          )
        }
        const runtime = getActiveRuleRuntime()
        if (!runtime) {
          throw new BattleRuleError(
            'Fallback deployment requires a deterministic rule runtime',
            'PROGRESSIVE_DEPLOYMENT_RUNTIME_REQUIRED',
          )
        }
        const streamName = `${RANDOM_STREAM_NAMES.progressiveDeploymentFallback}/${normalizeStablePlayerId(action.playerId)}`
        position = fallbackPositions[runtime.nextInt(streamName, fallbackPositions.length)]
      }

      const deployedPiece = commitReservePieceSummon(
        next,
        action.playerId,
        action.pieceId,
        position,
        safePositions.length > 0 ? 'safe' : 'fallback',
      )

      deployment.lastDeployedPieceId = deployedPiece.instanceId
      delete deployment.offerPieceIds
      delete deployment.offerPieces
      delete deployment.legalPositions
      if (finalizeBattleTerminal(next, action)) {
        clearProgressiveTurnInput(deployment)
        updateProgressiveReserveCounts(deployment)
        deployment.status = allProgressiveReservesEmpty(deployment) ? 'complete' : 'turn-ready'
        deployment.revision += 1
        return next
      }
      const livingDeployedPiece = next.pieces.find(piece =>
        piece.instanceId === deployedPiece.instanceId
        && piece.currentHp > 0
        && piece.x !== null
        && piece.y !== null)
      if (livingDeployedPiece) {
        grantDeploymentFirstMoveFree(livingDeployedPiece, next.turn.turnNumber)
      }
      return finishProgressiveDeploymentTurn(next)
    }

    case "deploymentChoice": {
      const next = safeCloneBattleState(state)
      const deployment = next.deployment
      if (!deployment || deployment.status !== 'awaiting-locks') {
        throw new BattleRuleError('Deployment choice is only available during deployment')
      }
      const playerId = normalizeStablePlayerId(action.playerId)
      const stablePlayerId = deployment.playerIds.find(candidate => normalizeStablePlayerId(candidate) === playerId)
      if (!stablePlayerId) throw new BattleRuleError('Player is not part of this deployment')
      if (deployment.locks[stablePlayerId]?.locked) throw new BattleRuleError('Deployment choice is locked')
      if (action.pieceId !== undefined && action.pieceId !== null && typeof action.pieceId !== 'string') {
        throw new BattleRuleError('Deployment choice accepts at most one piece ID')
      }

      const pieceId = typeof action.pieceId === 'string' && action.pieceId.trim()
        ? action.pieceId.trim()
        : null
      if (pieceId) {
        const piece = next.pieces.find(candidate => candidate.instanceId === pieceId)
        if (!piece) throw new BattleRuleError('Deployment piece was not found')
        if (normalizeStablePlayerId(piece.ownerPlayerId) !== playerId) {
          throw new BattleRuleError('Deployment piece belongs to another player')
        }
        if (piece.isCore !== true) throw new BattleRuleError('Only a core piece may be rerolled')
        if (piece.currentHp <= 0 || piece.x === null || piece.y === null) {
          throw new BattleRuleError('A defeated or unplaced piece cannot be rerolled')
        }
      }

      deployment.choices[stablePlayerId] = { pieceId }
      deployment.revision += 1
      return next
    }

    case "deploymentLock": {
      const next = safeCloneBattleState(state)
      const deployment = next.deployment
      if (!deployment || deployment.status !== 'awaiting-locks') {
        throw new BattleRuleError('Deployment lock is only available during deployment')
      }
      const playerId = normalizeStablePlayerId(action.playerId)
      const stablePlayerId = deployment.playerIds.find(candidate => normalizeStablePlayerId(candidate) === playerId)
      if (!stablePlayerId) throw new BattleRuleError('Player is not part of this deployment')
      if (deployment.locks[stablePlayerId]?.locked) throw new BattleRuleError('Deployment is already locked for this player')

      deployment.locks[stablePlayerId] = { locked: true, reason: 'player' }
      deployment.revision += 1
      if (deployment.playerIds.every(candidate => deployment.locks[candidate]?.locked === true)) {
        resolveDeploymentChoices(next, deployment)
        return applyBattleActionInternal(next, { type: 'beginPhase' })
      }
      return next
    }

    case "deploymentTimeout": {
      const next = safeCloneBattleState(state)
      const deployment = next.deployment
      if (!deployment || deployment.status !== 'awaiting-locks') {
        throw new BattleRuleError('Deployment timeout is only available during deployment')
      }
      if (!Number.isSafeInteger(action.now) || action.now < deployment.deadlineAt) {
        throw new BattleRuleError('Deployment timeout cannot run before the deadline')
      }

      const timedOutPlayerIds = deployment.playerIds
        .filter(playerId => deployment.locks[playerId]?.locked !== true)
        .sort(compareStableText)
      if (timedOutPlayerIds.length === 0) throw new BattleRuleError('Deployment is already locked')
      for (const playerId of timedOutPlayerIds) {
        deployment.choices[playerId] = { pieceId: null }
        deployment.locks[playerId] = { locked: true, reason: 'timeout' }
      }
      deployment.revision += 1
      resolveDeploymentChoices(next, deployment)
      return applyBattleActionInternal(next, { type: 'beginPhase' })
    }

    case "beginPhase": {
      const next = safeCloneBattleState(state)
      writeLog('[beginPhase] Current phase: ' + next.turn.phase + ', gameStartFired: ' + next.gameStartFired + ', turnNumber: ' + next.turn.turnNumber)
      if (next.turn.phase === "start") {
        if (!continuation.skipBeginTurn) {
        // ── 游戏开始时触发一次 gameStart 规则（第一回合第一个 beginPhase）────
        if (!next.gameStartFired && next.turn.turnNumber === 1) {
          writeLog('[beginPhase] Triggering gameStart rules...')
          next.gameStartFired = true
          // Legacy/no-deployment battles still treat their initial board as summoned.
          // Progressive reserve pieces emit this event only when actually entering play.
          if (!isProgressiveDeployment(next)) {
            for (const piece of next.pieces) {
              const initialSummonResult = getActiveTriggerSystem().checkTriggers(next, {
                type: "afterPieceSummoned",
                playerId: piece.ownerPlayerId,
                sourcePiece: piece,
                pieceTemplateId: piece.templateId,
                faction: piece.faction
              })
              assertNoUnhandledInteraction(initialSummonResult, 'afterPieceSummoned')
            }
          }
          const gameStartResult = getActiveTriggerSystem().checkTriggers(next, {
            type: "gameStart",
            playerId: next.turn.currentPlayerId,
            turnNumber: 1
          })
          assertNoUnhandledInteraction(gameStartResult, 'gameStart')
          writeLog('[beginPhase] gameStart result: ' + JSON.stringify(gameStartResult))
          if (gameStartResult.success && gameStartResult.messages.length > 0) {
            if (!next.actions) next.actions = []
            gameStartResult.messages.forEach(message => {
              next.actions!.push({ type: "triggerEffect", playerId: next.turn.currentPlayerId, turn: 1, payload: { message } })
            })
          }
        }

        // gameStart may settle the board. Do not generate a private offer or
        // consume its random stream after either side has lost its last core.
        if (finalizeBattleTerminal(next, action)) return next

        if (!continuation.skipProgressiveDeployment
          && startProgressiveDeploymentTurn(next)) {
          return next
        }

        // 触发回合开始效果（只调用一次，checkTriggers会扫描所有棋子和玩家的规则）
        const beginTurnContext = {
          type: "beginTurn",
          turnNumber: next.turn.turnNumber,
          playerId: next.turn.currentPlayerId
        }
        const beginTurnResult = getActiveTriggerSystem().checkTriggers(next, beginTurnContext);

        // 处理触发效果的消息
        if (beginTurnResult.success && beginTurnResult.messages.length > 0) {
          if (!next.actions) {
            next.actions = [];
          }
          beginTurnResult.messages.forEach(message => {
            next.actions!.push({
              type: "triggerEffect",
              playerId: next.turn.currentPlayerId,
              turn: next.turn.turnNumber,
              payload: {
                message
              }
            });
          });
        }

        if (setPendingInteraction(next, beginTurnResult, beginTurnContext, {
          continuationContext: beginTurnContext,
          pendingAction: { type: 'beginPhase', __pendingContinuationMode: 'beginPhaseAfterTrigger' },
        })) return next
        }

        // 更新冷却
        getActiveTriggerSystem().updateCooldowns();

        // 行动点已经在回合切换时设置，这里不再重复增加
        // 确保当前玩家有行动点属性
        const currentPlayerMeta = next.players.find(p => p.playerId === next.turn.currentPlayerId)
        if (currentPlayerMeta) {
          battleDebugLog(`Player ${currentPlayerMeta.playerId} has ${currentPlayerMeta.actionPoints}/${currentPlayerMeta.maxActionPoints} action points for this turn`)
        }

        // 更新当前玩家棋子技能的冷却时间
        next.pieces.forEach(piece => {
          // 只减少当前玩家棋子的技能冷却
          if (isSamePlayer(piece.ownerPlayerId, next.turn.currentPlayerId) && piece.skills) {
            piece.skills.forEach(skill => {
              if (skill.currentCooldown && skill.currentCooldown > 0) {
                skill.currentCooldown--
              }
            })
          }
        })

        // 触发whenever规则（每一步行动后检测）
        const wheneverResult = getActiveTriggerSystem().checkTriggers(next, {
          type: "whenever",
          playerId: next.turn.currentPlayerId,
          turnNumber: next.turn.turnNumber
        });
        assertNoUnhandledInteraction(wheneverResult, 'whenever')

        // 处理whenever触发效果的消息
        if (wheneverResult.success && wheneverResult.messages.length > 0) {
          if (!next.actions) {
            next.actions = [];
          }
          wheneverResult.messages.forEach(message => {
            next.actions!.push({
              type: "triggerEffect",
              playerId: next.turn.currentPlayerId,
              turn: next.turn.turnNumber,
              payload: {
                message
              }
            });
          });
        }

        // ── 特殊地形效果（每回合开始时，对当前玩家的棋子生效）────────────────
        // 快照避免熔岩致死后影响当前遍历
        const tileEffectPieces = next.pieces.filter(
          (p) => isSamePlayer(p.ownerPlayerId, next.turn.currentPlayerId) && p.currentHp > 0,
        )
        for (const piece of tileEffectPieces) {
          if (piece.x == null || piece.y == null) continue
          const tile = next.map.tiles.find((t) => t.x === piece.x && t.y === piece.y)
          if (!tile) continue

          // 熔岩伤害：调用 dealDamage（true 伤害），完整联动触发器和护盾等效果
          if (tile.props.damagePerTurn && tile.props.damagePerTurn > 0) {
            dealDamage(piece, piece, tile.props.damagePerTurn, "true", next, "lava-terrain")
          }

          // 治愈泉回复：调用 healDamage，完整联动触发器和反治疗等效果
          // 伤害结算后再检查存活，避免对已死棋子治疗
          if (tile.props.healPerTurn && tile.props.healPerTurn > 0 && piece.currentHp > 0) {
            healDamage(piece, piece, tile.props.healPerTurn, next, "spring-terrain")
          }

          // 充能台：直接给玩家加充能点（无护盾/触发器概念，简单累加）
          if (tile.props.chargePerTurn && tile.props.chargePerTurn > 0 && piece.currentHp > 0) {
            const playerMeta = next.players.find((p) => isSamePlayer(p.playerId, piece.ownerPlayerId))
            if (playerMeta) {
              playerMeta.chargePoints += tile.props.chargePerTurn
              if (!next.actions) next.actions = []
              next.actions.push({
                type: "tileEffect",
                playerId: piece.ownerPlayerId,
                turn: next.turn.turnNumber,
                payload: {
                  message: `${piece.name || piece.templateId} 在充能台上获得了 ${tile.props.chargePerTurn} 充能点`,
                  pieceId: piece.instanceId,
                },
              })
            }
          }
        }

        next.turn.phase = "action"
        return next
      }
      if (next.turn.phase === "end") {
        // 下一个玩家的回合开始
        const currentIndex = next.players.findIndex(
          (p) => isSamePlayer(p.playerId, next.turn.currentPlayerId),
        )
        const nextIndex =
          currentIndex === -1
            ? 0
            : (currentIndex + 1) % Math.max(next.players.length, 1)
        next.turn.currentPlayerId = next.players[nextIndex]!.playerId
        next.turn.turnNumber += 1
        next.turn.phase = "start"
        next.turn.actions = {
          hasMoved: false,
          hasUsedBasicSkill: false,
          hasUsedChargeSkill: false,
        }
        
        // 确保新回合的玩家有初始行动点和最大行动点
        const nextPlayerMeta = next.players[nextIndex]
        if (nextPlayerMeta) {
          // 实现类似炉石传说的法力水晶机制
          // 每回合开始时，最大行动点+1（最多10点），当前行动点充满
          if (nextPlayerMeta.maxActionPoints === undefined) {
            nextPlayerMeta.maxActionPoints = 1 // 初始最大行动点
          } else if (nextPlayerMeta.maxActionPoints < 10) {
            nextPlayerMeta.maxActionPoints += 1 // 每回合增长1点
          }
          // 充满行动点
          nextPlayerMeta.actionPoints = nextPlayerMeta.maxActionPoints
        }
        
        // Reuse the authoritative start-phase path so suspension and settlement cannot diverge.
        return applyBattleActionInternal(next, { type: 'beginPhase' })
      }
      return next
    }

    case "grantChargePoints": {
      const next = safeCloneBattleState(state)
      const meta = getPlayerMeta(next, action.playerId)
      meta.chargePoints += action.amount

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = getActiveTriggerSystem().checkTriggers(next, {
        type: "whenever",
        playerId: action.playerId
      });
      assertNoUnhandledInteraction(wheneverResult, 'whenever')

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "move": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }

      // Preserve the old side-effect-free AP rejection before cloning or firing
      // beforeMove. The current-turn deployment tag is the sole exception.
      const sourcePieceCheck = state.pieces.find(
        p => p.instanceId === action.pieceId
          && isSamePlayer(p.ownerPlayerId, action.playerId)
          && p.currentHp > 0,
      )
      const hasDeploymentFirstMoveFree = !!sourcePieceCheck?.statusTags?.some(
        statusTag => isCurrentTurnDeploymentFirstMoveFree(statusTag, state.turn.turnNumber),
      )
      const playerMetaCheck = getPlayerMeta(state, action.playerId)
      if (!hasDeploymentFirstMoveFree && playerMetaCheck.actionPoints < 1) {
        throw new BattleRuleError("Not enough action points to move")
      }

      const next = safeCloneBattleState(state)
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          isSamePlayer(p.ownerPlayerId, action.playerId) &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      // 触发即将移动前的规则（检查冰冻等状态）
      // 使用可修改的上下文对象，触发器可以修改 targetX/targetY 来改变移动目标
      validateMove(next, piece, action.toX, action.toY)

      const moveContext = {
        type: "beforeMove" as const,
        sourcePiece: piece,
        playerId: action.playerId,
        targetX: action.toX,
        targetY: action.toY
      };
      const beforeMoveResult = getActiveTriggerSystem().checkTriggers(next, moveContext);
      assertNoUnhandledInteraction(beforeMoveResult, 'beforeMove')

      // 检查是否有规则触发了效果
      if (beforeMoveResult.success) {
        // 初始化actions数组
        if (!next.actions) {
          next.actions = [];
        }
        beforeMoveResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // 检查是否有规则明确阻止了行动（在添加消息之后检查）
      if (beforeMoveResult.blocked) {
        // A blocked deployment-free move is an authority rejection, so the
        // runner discards this clone together with trigger effects and RNG reads.
        if (hasDeploymentFirstMoveFree) {
          throw new BattleRuleError(
            beforeMoveResult.messages.join('；') || 'Deployment first move was blocked',
            'DEPLOYMENT_FIRST_MOVE_BLOCKED',
          )
        }
        return next; // 返回包含消息的状态，不执行移动
      }

      // 触发器可能修改了目标位置，使用修改后的值
      const finalToX = moveContext.targetX;
      const finalToY = moveContext.targetY;

      validateMove(next, piece, finalToX, finalToY)

      const deploymentFirstMoveFree = consumeDeploymentFirstMoveFree(
        piece,
        next.turn.turnNumber,
      )
      const playerMeta = getPlayerMeta(next, action.playerId)
      if (!deploymentFirstMoveFree && playerMeta.actionPoints < 1) {
        throw new BattleRuleError("Not enough action points to move")
      }

      // 记录移动前的位置
      const fromX = piece.x
      const fromY = piece.y

      // 执行移动（使用触发器可能修改后的目标位置）
      piece.x = finalToX
      piece.y = finalToY
      
      // 消耗行动点
      if (!deploymentFirstMoveFree) playerMeta.actionPoints -= 1
      
      // 初始化actions数组（如果不存在）
      if (!next.actions) {
        next.actions = []
      }
      
      // 记录移动信息到战斗日志
      const pieceName = piece.name || piece.templateId;
      const moveMessage = `${pieceName}从(${fromX}, ${fromY})移动到(${finalToX}, ${finalToY})`;

      next.actions.push({
        type: "move",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: moveMessage,
          pieceId: action.pieceId,
          fromX,
          fromY,
          toX: finalToX,
          toY: finalToY,
          deploymentFirstMoveFree,
        }
      })

      // 触发移动后的规则
      const moveResult = getActiveTriggerSystem().checkTriggers(next, {
        type: "afterMove",
        sourcePiece: piece,
        playerId: action.playerId
      });
      assertNoUnhandledInteraction(moveResult, 'afterMove')

      // 处理触发效果的消息
      if (moveResult.success && moveResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        moveResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = getActiveTriggerSystem().checkTriggers(next, {
        type: "whenever",
        sourcePiece: piece,
        playerId: action.playerId
      });
      assertNoUnhandledInteraction(wheneverResult, 'whenever')

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "useBasicSkill": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }
      // 取消一回合只能用一个技能的限制
      // if (state.turn.actions.hasUsedBasicSkill) {
      //   throw new BattleRuleError("Basic skill already used this turn")
      // }

      const next = safeCloneBattleState(state)
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          isSamePlayer(p.ownerPlayerId, action.playerId) &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      // 触发即将使用技能前的规则（检查冰冻等状态）
      // 使用可修改的上下文对象，触发器可以修改 skillId 来改变使用的技能
      validateSkillActionByDryRun(next, action, continuation.skipTargetingValidation)

      const skillUseContext = {
        type: "beforeSkillUse" as const,
        sourcePiece: piece,
        targetPiece: action.targetPieceId
          ? next.pieces.find(p => p.instanceId === action.targetPieceId && p.currentHp > 0)
          : (action.targetX !== undefined && action.targetY !== undefined
            ? next.pieces.find(p => p.x === action.targetX && p.y === action.targetY && p.currentHp > 0)
            : undefined),
        targetX: action.targetX,
        targetY: action.targetY,
        playerId: action.playerId,
        skillId: action.skillId,
        selectedOption: (action as any).selectedOption,
      };
      const beforeSkillUseResult = continuation.skipBeforeSkillUse
        ? { success: true, messages: [], blocked: false } as any
        : getActiveTriggerSystem().checkTriggers(next, skillUseContext);

      // 检查是否有规则阻止了技能使用
      if (beforeSkillUseResult.success) {
        // 初始化actions数组
        if (!next.actions) {
          next.actions = [];
        }
        beforeSkillUseResult.messages.forEach((message: string) => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // 检查是否有规则明确阻止了行动（在添加消息之后检查）
      if (beforeSkillUseResult.blocked) {
        return next; // 返回包含消息的状态，不执行技能
      }
      if (beforeSkillUseResult.needsOptionSelection || beforeSkillUseResult.needsTargetSelection) {
        // 存入状态，由正确的玩家客户端响应（不 throw，避免路由给错误的客户端）
        setPendingInteraction(next, beforeSkillUseResult, skillUseContext, {
          continuationContext: skillUseContext,
          pendingAction: { ...action, __pendingContinuationMode: 'skillAfterBeforeTrigger' },
        })
        return next
      }

      // 触发器可能修改了技能ID，使用修改后的值
      const finalSkillId = skillUseContext.skillId;

      // 优先使用战局中已加载的技能定义，回退到模块缓存
      // 使用触发器可能修改后的技能ID
      let skillDef = next.skillsById[finalSkillId] || getSkillById(finalSkillId)

      // 检查行动点是否足够
      const playerMeta = getPlayerMeta(state, action.playerId)
      if (playerMeta.actionPoints < skillDef.actionPointCost) {
        throw new BattleRuleError(`Not enough action points to use ${skillDef.name}`)
      }

      // 检查技能是否在冷却中
      if (piece.skills) {
        const skillState = piece.skills.find(s => s.skillId === finalSkillId)
        if (skillState && skillState.currentCooldown && skillState.currentCooldown > 0) {
          throw new BattleRuleError(
            `Skill ${finalSkillId} is on cooldown for ${skillState.currentCooldown} more turns`,
          )
        }

        // 检查限定技的使用次数
        if (skillState && skillDef.type === "ultimate" && (skillState.usesRemaining ?? 0) <= 0) {
          throw new BattleRuleError(`Ultimate skill ${finalSkillId} has already been used`)
        }
      }

      // 执行技能（使用触发器可能修改后的技能ID）
      const releaseState = safeCloneBattleState(next)
      const releaseRuntime = getActiveRuleRuntime()
      const releaseRuntimeSnapshot = releaseRuntime?.snapshot()
      applySkillPayment(next, piece, action.playerId, finalSkillId, skillDef)

      // Payment happens before the actual release. If a beforeSkillUse effect killed
      // the caster or removed the target, the skill is consumed but has no effect.
      const currentPiece = next.pieces.find(p => p.instanceId === piece.instanceId)
      if (!currentPiece || currentPiece.currentHp <= 0) {
        writeLog(`[applyBattleAction] Caster ${piece.name} was killed by beforeSkillUse trigger, interrupting skill execution after payment`)
        pushInterruptedSkillLog(next, "useBasicSkill", action.playerId, piece, finalSkillId, skillDef)
        return next
      }
      if (skillUseContext.targetPiece) {
        const currentTarget = next.pieces.find(p => p.instanceId === skillUseContext.targetPiece!.instanceId)
        if (!currentTarget || currentTarget.currentHp <= 0) {
          writeLog(`[applyBattleAction] Target was killed by beforeSkillUse trigger, interrupting skill execution after payment`)
          pushInterruptedSkillLog(next, "useBasicSkill", action.playerId, piece, finalSkillId, skillDef)
          return next
        }
      }

      // 构建目标信息（支持 N 次 selectTarget 调用）
      const buildTargetSlot = (pieceId: string | undefined, tx: number | undefined, ty: number | undefined) => {
        if (pieceId) {
          const tp = next.pieces.find(p => p.instanceId === pieceId);
          if (tp) return { info: { instanceId: tp.instanceId, templateId: tp.templateId, ownerPlayerId: tp.ownerPlayerId, currentHp: tp.currentHp, maxHp: tp.maxHp, attack: tp.attack, defense: tp.defense, x: tp.x || 0, y: tp.y || 0 }, pos: { x: tp.x || 0, y: tp.y || 0 } };
        } else if (tx !== undefined && ty !== undefined) {
          return { info: null, pos: { x: tx, y: ty } };
        }
        return { info: null, pos: null };
      };
      const _t1 = buildTargetSlot(action.targetPieceId, action.targetX, action.targetY);
      const _actAny = action as any;
      const _extraTargets: Array<{pieceId?: string; x?: number; y?: number}> = _actAny.extraTargets || [];
      const targets = [
        _t1,
        ..._extraTargets.map((et: {pieceId?: string; x?: number; y?: number}) => buildTargetSlot(et.pieceId, et.x, et.y))
      ];

      const context = {
        piece: piece,
        target: _t1.info,
        targetPosition: _t1.pos,
        targets,
        selectedOption: _actAny.selectedOption,
        battle: next,
        skill: {
          id: skillDef.id,
          name: skillDef.name,
          type: skillDef.type,
          powerMultiplier: skillDef.powerMultiplier,
          targeting: skillDef.targeting,
        },
      }

      writeLog('[useChargeSkill] Calling executeSkillFunction...')
      let result;
      try {
        result = executeSkillFunction(skillDef, context, next)
        writeLog('[useChargeSkill] executeSkillFunction result: ' + JSON.stringify({success: result.success, needsTargetSelection: result.needsTargetSelection, targetType: result.targetType}))
      } catch (err) {
        writeLog('[useChargeSkill] executeSkillFunction ERROR: ' + (err instanceof Error ? err.message : String(err)))
        throw err
      }

      // 检查是否需要目标选择
      if (result.needsTargetSelection) {
        // 创建一个包含目标选择信息的错误对象
        const targetSelectionError = new BattleRuleError('需要选择目标') as any
        targetSelectionError.needsTargetSelection = true
        targetSelectionError.targetType = result.targetType || 'piece'
        targetSelectionError.range = result.range || 5
        targetSelectionError.filter = result.filter || 'enemy'
        targetSelectionError.targetIndex = (result as any).targetIndex
        throw targetSelectionError
      }

      // 检查是否需要选项选择
      if (result.needsOptionSelection) {
        if (releaseRuntime && releaseRuntimeSnapshot) releaseRuntime.restore(releaseRuntimeSnapshot)
        return setPendingActionOption(
          releaseState, result, action,
          { type: 'skill', id: finalSkillId, pieceId: piece.instanceId },
          'skillReleaseOption',
        )
      }
      
      // 技能失败：当 success === false 时，视作无效操作，抛出错误不写日志
      if (!result.success) {
        throw new BattleRuleError(result.message || '技能施放失败')
      }

      if (result.success) {
        // 效果已经在技能执行时直接应用，这里只需要处理返回的消息
        const pendingTarget = (result as any).pendingTargetSelection
        battleDebugLog('[STAGE1] skill result.pendingTargetSelection:', pendingTarget ? { playerId: pendingTarget.playerId, targetType: pendingTarget.targetType, hasEffectCode: !!pendingTarget.effectCode, effectCodeLen: pendingTarget.effectCode ? pendingTarget.effectCode.length : 0 } : null)
        if (pendingTarget) {
          next.pendingTargetSelection = {
            playerId: pendingTarget.playerId || action.playerId,
            ownerPlayerId: pendingTarget.playerId || action.playerId,
            title: pendingTarget.title || '请选择目标',
            targetType: pendingTarget.targetType || 'cell',
            range: pendingTarget.range || 99,
            filter: pendingTarget.filter || 'all',
            effectCode: pendingTarget.effectCode,
            payload: pendingTarget.payload,
            source: { type: 'skill', id: finalSkillId, pieceId: piece.instanceId },
            candidates: pendingTarget.targetCandidates || pendingTarget.candidates,
            fixedCandidates: Array.isArray(pendingTarget.targetCandidates || pendingTarget.candidates),
            selectionMode: pendingTarget.selectionMode,
            minSelections: pendingTarget.minSelections,
            maxSelections: pendingTarget.maxSelections,
            min: pendingTarget.minSelections,
            max: pendingTarget.maxSelections,
            canCancel: pendingTarget.canCancel,
            resumeOnCancel: pendingTarget.resumeOnCancel,
            rollbackOnCancel: pendingTarget.rollbackOnCancel ?? skillDef.rollbackPendingTargetOnCancel,
          }
          battleDebugLog('[STAGE2] next.pendingTargetSelection stored:', { playerId: next.pendingTargetSelection.playerId, hasEffectCode: !!next.pendingTargetSelection.effectCode, effectCodeLen: next.pendingTargetSelection.effectCode ? next.pendingTargetSelection.effectCode.length : 0 })
        }

      }

      // 初始化actions数组
      if (!next.actions) {
        next.actions = []
      }

      // 存储技能执行消息到战斗日志
      // 构建更详细的技能释放消息
      const pieceName = piece.name || piece.templateId;
      let skillMessage = `${pieceName}使用了${skillDef.name || finalSkillId}`;
      
      // 如果有目标，添加目标信息
      if (action.targetPieceId) {
        const targetPiece = next.pieces.find(p => p.instanceId === action.targetPieceId);
        if (targetPiece) {
          const targetName = targetPiece.name || targetPiece.templateId;
          skillMessage += `，目标是${targetName}`;
        }
      } else if (action.targetX !== undefined && action.targetY !== undefined) {
        skillMessage += `，目标位置是(${action.targetX}, ${action.targetY})`;
      }
      
      // 添加技能执行结果消息
      if (result.message) {
        skillMessage += `，${result.message}`;
      }
      
      next.actions.push({
        type: "useBasicSkill",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: skillMessage,
          skillId: action.skillId,
          pieceId: action.pieceId
        }
      })

      // 不再设置 hasUsedBasicSkill，允许一回合使用多个技能

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = getActiveTriggerSystem().checkTriggers(next, {
        type: "whenever",
        sourcePiece: piece,
        playerId: action.playerId,
        skillId: action.skillId
      });
      assertNoUnhandledInteraction(wheneverResult, 'whenever')

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "useChargeSkill": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }
      // 取消一回合只能用一个技能的限制
      // if (state.turn.actions.hasUsedChargeSkill) {
      //   throw new BattleRuleError("Charge skill already used this turn")
      // }

      const next = safeCloneBattleState(state)
      const piece = next.pieces.find(
        (p) =>
          p.instanceId === action.pieceId &&
          isSamePlayer(p.ownerPlayerId, action.playerId) &&
          p.currentHp > 0,
      )
      if (!piece) {
        throw new BattleRuleError(
          "Piece not found or does not belong to current player",
        )
      }

      // 触发即将使用技能前的规则（检查冰冻等状态）
      // 使用可修改的上下文对象，触发器可以修改 skillId 来改变使用的技能
      validateSkillActionByDryRun(next, action, continuation.skipTargetingValidation)

      const skillUseContext = {
        type: "beforeSkillUse" as const,
        sourcePiece: piece,
        targetPiece: action.targetPieceId
          ? next.pieces.find(p => p.instanceId === action.targetPieceId && p.currentHp > 0)
          : (action.targetX !== undefined && action.targetY !== undefined
            ? next.pieces.find(p => p.x === action.targetX && p.y === action.targetY && p.currentHp > 0)
            : undefined),
        targetX: action.targetX,
        targetY: action.targetY,
        playerId: action.playerId,
        skillId: action.skillId,
        selectedOption: (action as any).selectedOption,
      };
      const beforeSkillUseResult = continuation.skipBeforeSkillUse
        ? { success: true, messages: [], blocked: false } as any
        : getActiveTriggerSystem().checkTriggers(next, skillUseContext);

      // 触发器可能修改了技能ID，使用修改后的值
      const finalSkillId = skillUseContext.skillId;

      let skillDef = next.skillsById[finalSkillId]

      // 如果技能定义找不到，使用默认技能定义
      if (!skillDef) {
        skillDef = {
          id: finalSkillId,
          name: finalSkillId,
          description: "Default skill",
          kind: "active",
          type: "super",
          cooldownTurns: 0,
          maxCharges: 0,
          chargeCost: 1,
          powerMultiplier: 1,
          code: "function executeSkill(context) { return { message: 'Skill executed', success: true } }",
          range: "self",
          requiresTarget: false,
          actionPointCost: 2
        }
      }

      // 检查行动点是否足够
      const playerMeta = getPlayerMeta(state, action.playerId)
      if (playerMeta.actionPoints < skillDef.actionPointCost) {
        throw new BattleRuleError(`Not enough action points to use ${skillDef.name}`)
      }

      // 检查技能是否在冷却中
      if (piece.skills) {
        const skillState = piece.skills.find(s => s.skillId === finalSkillId)
        if (skillState && skillState.currentCooldown && skillState.currentCooldown > 0) {
          throw new BattleRuleError(
            `Skill ${finalSkillId} is on cooldown for ${skillState.currentCooldown} more turns`,
          )
        }

        // 检查限定技的使用次数
        if (skillState && skillDef.type === "ultimate" && (skillState.usesRemaining ?? 0) <= 0) {
          throw new BattleRuleError(`Ultimate skill ${finalSkillId} has already been used`)
        }
      }

      // 检查是否有规则阻止了技能使用
      if (beforeSkillUseResult.success) {
        // 初始化actions数组
        if (!next.actions) {
          next.actions = [];
        }
        beforeSkillUseResult.messages.forEach((message: string) => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }
      
      // 检查是否有规则明确阻止了行动（在添加消息之后检查）
      if (beforeSkillUseResult.blocked) {
        return next; // 返回包含消息的状态，不执行技能
      }
      if (beforeSkillUseResult.needsOptionSelection || beforeSkillUseResult.needsTargetSelection) {
        setPendingInteraction(next, beforeSkillUseResult, skillUseContext, {
          continuationContext: skillUseContext,
          pendingAction: { ...action, __pendingContinuationMode: 'skillAfterBeforeTrigger' },
        })
        return next
      }

      const cost = getEffectiveChargeCost(next, action.playerId, skillDef)
      // 从 next 状态获取 playerMeta，确保修改能正确保存
      const nextPlayerMeta = getPlayerMeta(next, action.playerId)
      if (cost > 0 && nextPlayerMeta.chargePoints < cost) {
        throw new BattleRuleError("Not enough charge points to use this skill")
      }

      // 消耗充能点
      const releaseState = safeCloneBattleState(next)
      const releaseRuntime = getActiveRuleRuntime()
      const releaseRuntimeSnapshot = releaseRuntime?.snapshot()
      applySkillPayment(next, piece, action.playerId, finalSkillId, skillDef, cost)

      // Payment happens before the actual release. If a beforeSkillUse effect killed
      // the caster or removed the target, the skill is consumed but has no effect.
      const currentPiece = next.pieces.find(p => p.instanceId === piece.instanceId)
      if (!currentPiece || currentPiece.currentHp <= 0) {
        writeLog(`[applyBattleAction] Caster ${piece.name} was killed by beforeSkillUse trigger, interrupting charge skill execution after payment`)
        pushInterruptedSkillLog(next, "useChargeSkill", action.playerId, piece, finalSkillId, skillDef)
        return next
      }
      if (skillUseContext.targetPiece) {
        const currentTarget = next.pieces.find(p => p.instanceId === skillUseContext.targetPiece!.instanceId)
        if (!currentTarget || currentTarget.currentHp <= 0) {
          writeLog(`[applyBattleAction] Target was killed by beforeSkillUse trigger, interrupting charge skill execution after payment`)
          pushInterruptedSkillLog(next, "useChargeSkill", action.playerId, piece, finalSkillId, skillDef)
          return next
        }
      }

      // 执行技能
      battleDebugLog('[useChargeSkill] executeSkillFunction imported: ' + typeof executeSkillFunction)
      battleDebugLog('[useChargeSkill] skillDef id: ' + skillDef.id)
      battleDebugLog('[useChargeSkill] skillDef has code: ' + !!skillDef.code)
      battleDebugLog('[useChargeSkill] About to build target info...')
      
      // 构建目标信息（支持 N 次 selectTarget 调用）
      const buildTargetSlot = (pieceId: string | undefined, tx: number | undefined, ty: number | undefined) => {
        if (pieceId) {
          const tp = next.pieces.find(p => p.instanceId === pieceId);
          if (tp) return { info: { instanceId: tp.instanceId, templateId: tp.templateId, ownerPlayerId: tp.ownerPlayerId, currentHp: tp.currentHp, maxHp: tp.maxHp, attack: tp.attack, defense: tp.defense, x: tp.x || 0, y: tp.y || 0 }, pos: { x: tp.x || 0, y: tp.y || 0 } };
        } else if (tx !== undefined && ty !== undefined) {
          return { info: null, pos: { x: tx, y: ty } };
        }
        return { info: null, pos: null };
      };
      const _t1 = buildTargetSlot(action.targetPieceId, action.targetX, action.targetY);
      const _actAny = action as any;
      const _extraTargets: Array<{pieceId?: string; x?: number; y?: number}> = _actAny.extraTargets || [];
      const targets = [
        _t1,
        ..._extraTargets.map((et: {pieceId?: string; x?: number; y?: number}) => buildTargetSlot(et.pieceId, et.x, et.y))
      ];

      const context = {
        piece: piece,
        target: _t1.info,
        targetPosition: _t1.pos,
        targets,
        selectedOption: _actAny.selectedOption,
        battle: next,
        skill: {
          id: skillDef.id,
          name: skillDef.name,
          type: skillDef.type,
          powerMultiplier: skillDef.powerMultiplier,
          targeting: skillDef.targeting,
        },
      }

      writeLog('[useChargeSkill] Calling executeSkillFunction...')
      let result;
      try {
        result = executeSkillFunction(skillDef, context, next)
        writeLog('[useChargeSkill] executeSkillFunction result: ' + JSON.stringify({success: result.success, needsTargetSelection: result.needsTargetSelection, targetType: result.targetType}))
      } catch (err) {
        writeLog('[useChargeSkill] executeSkillFunction ERROR: ' + (err instanceof Error ? err.message : String(err)))
        throw err
      }

      // 检查是否需要目标选择
      if (result.needsTargetSelection) {
        // 创建一个包含目标选择信息的错误对象
        const targetSelectionError = new BattleRuleError('需要选择目标') as any
        targetSelectionError.needsTargetSelection = true
        targetSelectionError.targetType = result.targetType || 'piece'
        targetSelectionError.range = result.range || 5
        targetSelectionError.filter = result.filter || 'enemy'
        targetSelectionError.targetIndex = (result as any).targetIndex
        throw targetSelectionError
      }

      // 检查是否需要选项选择
      if (result.needsOptionSelection) {
        if (releaseRuntime && releaseRuntimeSnapshot) releaseRuntime.restore(releaseRuntimeSnapshot)
        return setPendingActionOption(
          releaseState, result, action,
          { type: 'skill', id: finalSkillId, pieceId: piece.instanceId },
          'skillReleaseOption',
        )
      }

      // 技能失败：视作无效操作，抛出错误不写日志（充能已在 next 中扣减，throw 后 next 被丢弃，自动回滚）
      if (!result.success) {
        throw new BattleRuleError(result.message || '技能施放失败')
      }

      if (result.success) {
        // 效果已经在技能执行时直接应用，这里只需要处理返回的消息
        const pendingTarget = (result as any).pendingTargetSelection
        battleDebugLog('[STAGE1] skill result.pendingTargetSelection:', pendingTarget ? { playerId: pendingTarget.playerId, targetType: pendingTarget.targetType, hasEffectCode: !!pendingTarget.effectCode, effectCodeLen: pendingTarget.effectCode ? pendingTarget.effectCode.length : 0 } : null)
        if (pendingTarget) {
          next.pendingTargetSelection = {
            playerId: pendingTarget.playerId || action.playerId,
            ownerPlayerId: pendingTarget.playerId || action.playerId,
            title: pendingTarget.title || '请选择目标',
            targetType: pendingTarget.targetType || 'cell',
            range: pendingTarget.range || 99,
            filter: pendingTarget.filter || 'all',
            effectCode: pendingTarget.effectCode,
            payload: pendingTarget.payload,
            source: { type: 'skill', id: finalSkillId, pieceId: piece.instanceId },
            candidates: pendingTarget.targetCandidates || pendingTarget.candidates,
            fixedCandidates: Array.isArray(pendingTarget.targetCandidates || pendingTarget.candidates),
            selectionMode: pendingTarget.selectionMode,
            minSelections: pendingTarget.minSelections,
            maxSelections: pendingTarget.maxSelections,
            min: pendingTarget.minSelections,
            max: pendingTarget.maxSelections,
            canCancel: pendingTarget.canCancel,
            resumeOnCancel: pendingTarget.resumeOnCancel,
            rollbackOnCancel: pendingTarget.rollbackOnCancel ?? skillDef.rollbackPendingTargetOnCancel,
          }
          battleDebugLog('[STAGE2] next.pendingTargetSelection stored:', { playerId: next.pendingTargetSelection.playerId, hasEffectCode: !!next.pendingTargetSelection.effectCode, effectCodeLen: next.pendingTargetSelection.effectCode ? next.pendingTargetSelection.effectCode.length : 0 })
        }

      }

      // 初始化actions数组
      if (!next.actions) {
        next.actions = []
      }

      // 存储技能执行消息到战斗日志
      // 构建更详细的技能释放消息
      const pieceName = piece.name || piece.templateId;
      let skillMessage = `${pieceName}使用了${skillDef.name || finalSkillId}（充能技能，消耗${cost}点充能）`;
      
      // 如果有目标，添加目标信息
      if (action.targetPieceId) {
        const targetPiece = next.pieces.find(p => p.instanceId === action.targetPieceId);
        if (targetPiece) {
          const targetName = targetPiece.name || targetPiece.templateId;
          skillMessage += `，目标是${targetName}`;
        }
      } else if (action.targetX !== undefined && action.targetY !== undefined) {
        skillMessage += `，目标位置是(${action.targetX}, ${action.targetY})`;
      }
      
      // 添加技能执行结果消息
      if (result.message) {
        skillMessage += `，${result.message}`;
      }
      
      next.actions.push({
        type: "useChargeSkill",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: {
          message: skillMessage,
          skillId: action.skillId,
          pieceId: action.pieceId,
          chargeCost: cost
        }
      })

      // 不再设置 hasUsedChargeSkill，允许一回合使用多个技能

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = getActiveTriggerSystem().checkTriggers(next, {
        type: "whenever",
        sourcePiece: piece,
        playerId: action.playerId,
        skillId: action.skillId
      });
      assertNoUnhandledInteraction(wheneverResult, 'whenever')

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      return next
    }

    case "endTurn": {
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("Only the current player can end the turn")
      }

      const next = safeCloneBattleState(state)

      if (!continuation.skipEndTurnTrigger) {
      // 触发所有回合结束效果：一次调用，checkTriggers 内部自行迭代棋子规则、玩家规则、手牌 reactive 卡牌
      // context.playerId = 当前结束回合的玩家，供暴风雪等规则判断"是否是对方回合"
      const endTurnContext = {
        type: "endTurn",
        turnNumber: next.turn.turnNumber,
        playerId: action.playerId
      }
      const endTurnResult = getActiveTriggerSystem().checkTriggers(next, endTurnContext);

      appendTriggerMessages(next, endTurnResult, action.playerId)
      if (setPendingInteraction(next, endTurnResult, endTurnContext, {
        continuationContext: endTurnContext,
        pendingAction: { ...action, __pendingContinuationMode: 'endTurnAfterTrigger' },
      })) return next
      }

      // 触发whenever规则（每一步行动后检测）
      const wheneverResult = getActiveTriggerSystem().checkTriggers(next, {
        type: "whenever",
        playerId: action.playerId,
        turnNumber: next.turn.turnNumber
      });
      assertNoUnhandledInteraction(wheneverResult, 'whenever')

      // 处理whenever触发效果的消息
      if (wheneverResult.success && wheneverResult.messages.length > 0) {
        if (!next.actions) {
          next.actions = [];
        }
        wheneverResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: {
              message
            }
          });
        });
      }

      // This tag is scoped to the placement turn even when it was never used.
      // Clear every storage location before handing authority to the next turn.
      clearDeploymentFirstMoveFree(next)

      // 在回合结束阶段的最后时刻，处理当前玩家棋子的状态效果持续时间扣除和规则移除
      next.pieces.forEach(piece => {
        // 只处理当前玩家棋子的状态效果
        if (isSamePlayer(piece.ownerPlayerId, action.playerId) && piece.statusTags) {
          // 遍历所有状态标签
          for (let i = piece.statusTags.length - 1; i >= 0; i--) {
            const statusTag = piece.statusTags[i];
            // 检查状态标签是否有持续时间属性（支持 currentDuration 和 remainingDuration）
            const currentDuration = statusTag.remainingDuration ?? statusTag.currentDuration;
            if (currentDuration !== undefined && currentDuration > 0) {
              // 减少持续时间
              const newDuration = currentDuration - 1;
              if (statusTag.remainingDuration !== undefined) {
                statusTag.remainingDuration = newDuration;
              } else {
                statusTag.currentDuration = newDuration;
              }
              // 如果持续时间为0，清除状态标签
              if (newDuration === 0) {
                
                // 检查并清理相关规则
                if (statusTag.relatedRules && statusTag.relatedRules.length > 0) {
                  statusTag.relatedRules.forEach(ruleId => {
                    // 检查是否有其他状态标签关联此规则
                    let hasOtherRelatedStatus = false;
                    
                    piece.statusTags.forEach(otherStatusTag => {
                      if (otherStatusTag !== statusTag && 
                          otherStatusTag.relatedRules && 
                          otherStatusTag.relatedRules.includes(ruleId)) {
                        hasOtherRelatedStatus = true;
                      }
                    });
                    
                    // 如果没有其他状态标签关联此规则，移除规则
                    if (!hasOtherRelatedStatus && piece.rules) {
                      const ruleIndex = piece.rules.findIndex(rule => rule.id === ruleId);
                      if (ruleIndex !== -1) {
                        piece.rules.splice(ruleIndex, 1);
                      }
                    }
                  });
                }
                
                // 从状态标签数组中移除
                piece.statusTags.splice(i, 1);
              }
            }
          }
        }
      });

      const endingPlayer = next.players.find(
        player => isSamePlayer(player.playerId, action.playerId),
      )
      for (const card of endingPlayer?.hand || []) {
        if (card.temporaryCostReductionTurnNumber !== next.turn.turnNumber) continue
        if (card.baseActionPointCost !== undefined) {
          card.actionPointCost = card.baseActionPointCost
        }
        delete card.baseActionPointCost
        delete card.temporaryCostReductionTurnNumber
      }
      next.turn.phase = "end"
      return next
    }

    case "surrender": {
      const next = safeCloneBattleState(state)
      if (next.players.length !== 2) {
        throw new BattleRuleError('Surrender requires exactly two battle players', 'INVALID_SURRENDER_PLAYER')
      }
      getPlayerMeta(next, action.playerId)
      return next
    }

    case "pendingOptionSelect": {
      const next = safeCloneBattleState(state)
      const pending = next.pendingOptionSelection
      if (!pending) throw new BattleRuleError('[pendingOptionSelect] validated pending session disappeared')
      if (pending.transaction) {
        return resumeSuspendableActionTransaction(next, pending.transaction, {
          selectedOption: action.selectedOption,
        })
      }
      next.pendingOptionSelection = undefined
      return resumePendingInteraction(next, pending, action.playerId, {
        selectedOption: action.selectedOption,
      })
    }

    case "pendingTargetSelect": {
      const next = safeCloneBattleState(state)
      const pending = next.pendingTargetSelection
      if (!pending) {
        throw new BattleRuleError('[pendingTargetSelect] validated pending session disappeared')
      }
      const submittedTargets = validatedPendingTargets || []
      if (pending.transaction) {
        const firstTarget = submittedTargets[0]
        const targetInput: SuspendableInteractionInput = firstTarget?.type === 'piece'
          ? {
              targetPieceId: firstTarget.pieceId,
              selectedTargets: submittedTargets,
            }
          : {
              targetX: firstTarget?.type === 'cell' ? firstTarget.x : undefined,
              targetY: firstTarget?.type === 'cell' ? firstTarget.y : undefined,
              selectedTargets: submittedTargets,
            }
        return resumeSuspendableActionTransaction(next, pending.transaction, targetInput)
      }
      const validatedPendingTarget = submittedTargets[0]
      const x = validatedPendingTarget?.type === 'cell'
        ? validatedPendingTarget.x
        : (action as any).targetX
      const y = validatedPendingTarget?.type === 'cell'
        ? validatedPendingTarget.y
        : (action as any).targetY
      const targetPieceId = validatedPendingTarget?.type === 'piece'
        ? validatedPendingTarget.pieceId
        : (action as any).targetPieceId
      const targetPiece = targetPieceId
        ? next.pieces.find(p => p.instanceId === targetPieceId && p.currentHp > 0)
        : undefined
      const resolvedPending = {
        ...pending,
        selectedTargets: [...(pending.selectedTargets || []), ...submittedTargets],
      }
      const advancedPending = submittedTargets.length === 1
        ? advancePendingTargetSession(pending, validatedPendingTarget!)
        : undefined
      if (advancedPending) {
        next.pendingTargetSelection = advancedPending
        return next
      }
      next.pendingTargetSelection = undefined
      if (!pending.effectCode) {
        return resumePendingInteraction(next, pending, action.playerId, {
          targetPieceId,
          targetX: x,
          targetY: y,
          selectedTargets: resolvedPending.selectedTargets,
          pendingTargetSelection: resolvedPending,
        })
      }

      let result: any = { success: true }
      if (pending.effectCode) {
        let fn: any
        try {
          const compileEffect = getRuleDynamicCodeRuntime().compileExpression<(math: Math, date: DateConstructor) => unknown>({
            surface: 'pendingEffectCode', contentId: pending.selectionId || 'pending-target',
            contentVersion: String(pending.stateRevision ?? 0),
            code: '(function(Math, Date) { return (' + pending.effectCode + '); })', entry: 'serialized function(ctx)',
          })
          fn = compileEffect(getRuleMath(), getRuleDate())
        } catch (evalErr) {
          throw new BattleRuleError('[STAGE6] effectCode dynamic compilation failed: ' + (evalErr instanceof Error ? evalErr.message : String(evalErr)))
        }
        if (typeof fn !== 'function') {
          throw new BattleRuleError('[STAGE6] effectCode did not compile to a function, got: ' + typeof fn)
        }
        try {
          result = fn({
            battle: next,
            playerId: action.playerId,
            targetPiece,
            targetX: x,
            targetY: y,
            pending: resolvedPending,
            payload: pending.payload,
          }) || { success: true }
        } catch (execErr) {
          if (isSuspendableActionPending(execErr)) throw execErr
          throw new BattleRuleError('[STAGE6] effectCode execution error: ' + (execErr instanceof Error ? execErr.message : String(execErr)))
        }
      }
      if (!next.actions) next.actions = []
      if (result.message) {
        next.actions.push({ type: 'triggerEffect', playerId: action.playerId, turn: next.turn.turnNumber, payload: { message: result.message } })
      }
      appendTriggerMessages(next, result, action.playerId)
      if (setPendingInteraction(next, result, pending.triggerContext || {}, {
        continuationContext: pending.continuationContext,
        pendingQueue: pending.pendingQueue,
          pendingReactiveCards: pending.pendingReactiveCards,
          pendingAction: pending.pendingAction,
          rollbackOnCancel: pending.rollbackOnCancel,
        })) {
        return next
      }
      return resumePendingInteraction(next, pending, action.playerId, {}, true)
    }

    case "playCard": {
      requireActionPhase(state)
      if (!isCurrentPlayer(state, action.playerId)) {
        throw new BattleRuleError("It is not this player's turn")
      }

      const next = safeCloneBattleState(state)
      const playerMeta = getPlayerMeta(next, action.playerId)

      // 找到手牌
      if (!playerMeta.hand) playerMeta.hand = []
      const cardIdx = playerMeta.hand.findIndex(c => c.instanceId === action.cardInstanceId)
      if (cardIdx === -1) throw new BattleRuleError("手牌中找不到该卡牌")
      const cardInstance = playerMeta.hand[cardIdx]

      // 加载卡牌定义（先查文件，再查战局自定义卡）
      const cardDef = loadCardById(cardInstance.cardId, true) ?? next.customCards?.[cardInstance.cardId] ?? null
      if (!cardDef) throw new BattleRuleError(`卡牌定义找不到: ${cardInstance.cardId}`)
      if (cardDef.type !== 'active' && cardDef.type !== 'reactive') throw new BattleRuleError("该卡牌为被动卡，无法手动打出")

      // AP 消耗：优先取手牌实例上的 actionPointCost（可被运行时效果修改），fallback 到卡牌定义
      const cardApCost = (cardInstance as any).actionPointCost ?? cardDef.actionPointCost ?? 0
      if (playerMeta.actionPoints < cardApCost) {
        throw new BattleRuleError(`行动点不足，打出 ${cardDef.name} 需要 ${cardApCost} 点，当前 ${playerMeta.actionPoints} 点`)
      }

      validateDeclaredCardTarget(next, action)
      // 触发手牌使用前规则
      const beforeCardPlayContext = {
        type: "beforeCardPlay" as const,
        playerId: action.playerId,
        cardId: cardInstance.cardId,
        cardInstanceId: cardInstance.instanceId,
      }
      const beforeCardPlayResult = continuation.skipBeforeCardPlay
        ? { success: true, messages: [], blocked: false } as TriggerResult
        : getActiveTriggerSystem().checkTriggers(next, beforeCardPlayContext);
      assertNoUnhandledInteraction(beforeCardPlayResult, 'beforeCardPlay')

      // 检查是否有规则阻止了卡牌使用
      if (beforeCardPlayResult.blocked) {
        if (!next.actions) next.actions = []
        beforeCardPlayResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: { message }
          });
        });
        return next;
      }

      const releaseState = safeCloneBattleState(next)
      const releaseRuntime = getActiveRuleRuntime()
      const releaseRuntimeSnapshot = releaseRuntime?.snapshot()
      const paidCardInstance = applyCardPayment(playerMeta, cardIdx, cardApCost)

      // 构建目标信息
      let { targetPiece, targetPosition } = getCardTargetArgs(next, action)
      if (action.targetPieceId && !targetPiece) {
        writeLog(`[applyBattleAction] Card target was removed by beforeCardPlay trigger, interrupting card effect after payment`)
        pushInterruptedCardLog(next, action.playerId, paidCardInstance, cardDef)
        return next
      }

      // 执行卡牌
      const result = executeCardFunction(
        cardDef,
        action.playerId,
        next,
        undefined,
        targetPiece,
        targetPosition,
        action.selectedOption,
        (action as any).extraTargets,
        paidCardInstance,
      )

      // 处理目标选择
      if (result.needsTargetSelection) {
        const err = new BattleRuleError('需要选择目标') as any
        err.needsTargetSelection = true
        err.targetType = result.targetType || 'piece'
        err.range = result.range || 999
        err.filter = result.filter || 'all'
        err.targetIndex = (result as any).targetIndex
        throw err
      }

      // 处理选项选择
      if (result.needsOptionSelection) {
        if (releaseRuntime && releaseRuntimeSnapshot) releaseRuntime.restore(releaseRuntimeSnapshot)
        return setPendingActionOption(
          releaseState, result, action,
          { type: 'card', id: cardInstance.cardId },
          'cardReleaseOption',
        )
      }

      if (!result.success) {
        throw new BattleRuleError(result.message || "卡牌效果执行失败")
      }

      // 扣除行动点
      // Card payment was already applied before release.

      // 弃牌
      // Card was already moved from hand to discard before release.

      // 写入战斗日志
      if (!next.actions) next.actions = []
      next.actions.push({
        type: "playCard",
        playerId: action.playerId,
        turn: next.turn.turnNumber,
        payload: { message: result.message || `使用了卡牌：${cardDef.name}`, cardId: cardInstance.cardId }
      })

      // 触发手牌使用后规则
      const afterCardPlayContext = {
        type: "afterCardPlay" as const,
        playerId: action.playerId,
        cardId: cardInstance.cardId,
        cardInstanceId: cardInstance.instanceId,
      }
      const afterCardPlayResult = getActiveTriggerSystem().checkTriggers(next, afterCardPlayContext)
      assertNoUnhandledInteraction(afterCardPlayResult, 'afterCardPlay')

      // 处理触发效果的消息
      if (afterCardPlayResult.success && afterCardPlayResult.messages.length > 0) {
        afterCardPlayResult.messages.forEach(message => {
          next.actions!.push({
            type: "triggerEffect",
            playerId: action.playerId,
            turn: next.turn.turnNumber,
            payload: { message }
          });
        });
      }

      // 触发 whenever
      const wheneverResult = getActiveTriggerSystem().checkTriggers(next, { type: "whenever", playerId: action.playerId })
      assertNoUnhandledInteraction(wheneverResult, 'whenever')

      return next
    }

    default:
      throw new BattleRuleError(`Unknown battle action: ${String((action as any)?.type || '')}`)
  }
}

function cloneActionEnvelope(action: BattleAction): BattleAction {
  return JSON.parse(JSON.stringify(action)) as BattleAction
}

function createSuspendableActionTransaction(
  state: BattleState,
  action: BattleAction,
): SuspendableActionTransaction {
  const runtime = getActiveRuleRuntime()
  return {
    protocolVersion: SUSPENDABLE_ACTION_TRANSACTION_PROTOCOL_VERSION,
    rootAction: cloneActionEnvelope(action),
    baseTargetingRevision: Number.isSafeInteger(state.targetingRevision)
      ? state.targetingRevision!
      : 0,
    answers: [],
    runtimeCheckpoint: runtime
      ? {
          rootSeed: runtime.rootSeed,
          tick: runtime.clock.tick,
          snapshot: runtime.snapshot(),
        }
      : undefined,
  }
}

function applySuspendableChildAction(state: BattleState, action: BattleAction): BattleState {
  return runSuspendableActionTransaction(
    state,
    state,
    createSuspendableActionTransaction(state, action),
  )
}

function transactionReplayState(
  state: BattleState,
  transaction: SuspendableActionTransaction,
): BattleState {
  const replay = safeCloneBattleState(state)
  replay.pendingOptionSelection = undefined
  replay.pendingTargetSelection = undefined
  replay.targetingRevision = transaction.baseTargetingRevision
  return replay
}

function replayActionEnvelope(transaction: SuspendableActionTransaction): BattleAction {
  const action = cloneActionEnvelope(transaction.rootAction as BattleAction)
  for (const answer of transaction.answers) {
    if (answer.key.consumerOrdinal !== -1) continue
    if (answer.input.selectedOption !== undefined) {
      ;(action as any).selectedOption = answer.input.selectedOption
    }
  }
  return action
}

function setSuspendableTransactionPending(
  authorityState: BattleState,
  transaction: SuspendableActionTransaction,
  pendingError: {
    key: SuspendableActionTransaction['currentInteraction']
    prompt: SuspendableInteractionPrompt
  },
): BattleState {
  if (!pendingError.key) {
    throw new BattleRuleError(
      'Suspendable transaction did not provide an interaction key',
      'SUSPENDABLE_ACTION_KEY_MISSING',
    )
  }
  const next = safeCloneBattleState(authorityState)
  next.pendingOptionSelection = undefined
  next.pendingTargetSelection = undefined
  const pendingTransaction: SuspendableActionTransaction = {
    ...transaction,
    currentInteraction: pendingError.key,
  }
  const sourceType = pendingError.key.consumerKind === 'reactiveCard'
    ? 'card'
    : pendingError.key.consumerKind
  const source = {
    type: sourceType as 'skill' | 'card' | 'rule',
    id: pendingError.key.consumerId,
    pieceId: pendingError.prompt.sourcePieceId || pendingError.key.sourceId,
  }
  if (pendingError.prompt.kind === 'option') {
    next.pendingOptionSelection = {
      playerId: pendingError.prompt.playerId || next.turn.currentPlayerId,
      title: pendingError.prompt.title || 'Choose an option',
      options: pendingError.prompt.options || [],
      source,
      canCancel: pendingError.prompt.canCancel,
      cancelValue: pendingError.prompt.cancelValue,
      selectionMode: pendingError.prompt.selectionMode,
      presentation: pendingError.prompt.presentation,
      minSelections: pendingError.prompt.minSelections,
      maxSelections: pendingError.prompt.maxSelections,
      transaction: pendingTransaction,
      suspendedTurn: pendingError.prompt.suspendedTurn,
    }
    return next
  }
  next.pendingTargetSelection = {
    playerId: pendingError.prompt.playerId || next.turn.currentPlayerId,
    ownerPlayerId: pendingError.prompt.playerId || next.turn.currentPlayerId,
    title: pendingError.prompt.title || 'Choose a target',
    targetType: (pendingError.prompt.targetType || 'piece') as 'piece' | 'cell' | 'grid',
    range: pendingError.prompt.range,
    filter: pendingError.prompt.filter,
    candidates: pendingError.prompt.candidates as PendingTargetSelectionSession['candidates'],
    fixedCandidates: Array.isArray(pendingError.prompt.candidates),
    selectionMode: pendingError.prompt.selectionMode,
    minSelections: pendingError.prompt.minSelections,
    maxSelections: pendingError.prompt.maxSelections,
    min: pendingError.prompt.minSelections,
    max: pendingError.prompt.maxSelections,
    resumeOnCancel: pendingError.prompt.resumeOnCancel,
    rollbackOnCancel: pendingError.prompt.rollbackOnCancel,
    candidateState: pendingError.prompt.candidateState as BattleState | undefined,
    source,
    canCancel: pendingError.prompt.canCancel,
    transaction: pendingTransaction,
    suspendedTurn: pendingError.prompt.suspendedTurn,
  }
  return next
}

function uniqueSuspendableTimeoutCandidates<T>(values: T[]): T[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = JSON.stringify(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function mandatoryTimeoutTargetInput(
  authorityState: BattleState,
  transaction: SuspendableActionTransaction,
  key: NonNullable<SuspendableActionTransaction['currentInteraction']>,
  prompt: SuspendableInteractionPrompt,
  runtime: RuleRuntime,
): SuspendableInteractionInput {
  const pendingState = setSuspendableTransactionPending(authorityState, transaction, { key, prompt })
  const pending = pendingState.pendingTargetSelection
  if (!pending) throw new BattleRuleError('Timed-out target interaction did not produce a target session')
  const finalized = finalizePendingTargetSession(
    pending.candidateState || pendingState,
    pending,
    transaction.baseTargetingRevision,
  )
  const candidates = uniqueSuspendableTimeoutCandidates(finalized.candidates || [])
  if (candidates.length === 0) {
    throw new BattleRuleError(
      'Timed-out mandatory transaction target has no legal candidates',
      'PENDING_TIMEOUT_NO_CANDIDATES',
    )
  }
  if (prompt.selectionMode === 'multi') {
    const minSelections = Number.isSafeInteger(prompt.minSelections)
      ? Math.max(0, prompt.minSelections!)
      : 1
    if (candidates.length < minSelections) {
      throw new BattleRuleError(
        'Timed-out mandatory transaction multi-target has too few legal candidates',
        'PENDING_TIMEOUT_NO_CANDIDATES',
      )
    }
    const selectedTargets = candidates.slice(0, minSelections)
    const first = selectedTargets[0]
    return first?.type === 'piece'
      ? { targetPieceId: first.pieceId, selectedTargets }
      : { targetX: first?.x, targetY: first?.y, selectedTargets }
  }
  const index = runtime.nextInt(`${RANDOM_STREAM_NAMES.skillEffect}/pending-timeout`, candidates.length)
  const target = candidates[index]
  return target.type === 'piece'
    ? { targetPieceId: target.pieceId, selectedTargets: [target], timeoutRandomBound: candidates.length }
    : { targetX: target.x, targetY: target.y, selectedTargets: [target], timeoutRandomBound: candidates.length }
}

function runSuspendableActionTransaction(
  authorityState: BattleState,
  replayState: BattleState,
  transaction: SuspendableActionTransaction,
): BattleState {
  if (transaction.protocolVersion !== SUSPENDABLE_ACTION_TRANSACTION_PROTOCOL_VERSION) {
    throw new BattleRuleError(
      'Suspendable action transaction protocol mismatch',
      'SUSPENDABLE_ACTION_PROTOCOL_MISMATCH',
    )
  }
  const runtimeAnswers = transaction.answers.filter(answer => answer.key.consumerOrdinal !== -1)
  const transactionRuntime = new SuspendableActionRuntime(runtimeAnswers)
  const outerRuleRuntime = getActiveRuleRuntime()
  const outerRuntimeSnapshot = outerRuleRuntime?.snapshot()
  const triggerSnapshot = getActiveTriggerSystem().snapshotTransactionState()
  let replayRuleRuntime = outerRuleRuntime
  if (transaction.runtimeCheckpoint) {
    replayRuleRuntime = new RuleRuntime({
      rootSeed: transaction.runtimeCheckpoint.rootSeed,
      cursors: transaction.runtimeCheckpoint.snapshot.cursors,
      tick: transaction.runtimeCheckpoint.tick,
    })
    replayRuleRuntime.restore(transaction.runtimeCheckpoint.snapshot)
  }
  for (const answer of transaction.answers) {
    const bound = answer.input.timeoutRandomBound
    if (!replayRuleRuntime || !Number.isSafeInteger(bound) || Number(bound) <= 0) continue
    replayRuleRuntime.nextInt(
      `${RANDOM_STREAM_NAMES.skillEffect}/pending-timeout`,
      Number(bound),
    )
  }
  const execute = () => withSuspendableActionRuntime(transactionRuntime, () => {
    let reduced = applyBattleActionInternal(replayState, replayActionEnvelope(transaction))
    const directPending = reduced.pendingOptionSelection
    if (directPending?.pendingAction && !directPending.transaction) {
      const directSource = directPending.source
      transactionRuntime.suspend({
        consumerKind: directSource?.type === 'card' ? 'card' : 'skill',
        consumerId: directSource?.id || 'direct-option',
        sourceId: directSource?.pieceId,
        consumerOrdinal: -1,
      }, {
        kind: 'option',
        playerId: directPending.playerId,
        title: directPending.title,
        options: directPending.options,
        canCancel: directPending.canCancel,
        cancelValue: directPending.cancelValue,
        selectionMode: directPending.selectionMode,
        presentation: directPending.presentation,
        minSelections: directPending.minSelections,
        maxSelections: directPending.maxSelections,
        suspendedTurn: { ...reduced.turn },
      })
    }
    let directTarget = reduced.pendingTargetSelection
    let directTargetStage = 0
    while (directTarget && !directTarget.transaction) {
      const rootAction = transaction.rootAction as BattleAction
      const directSource = directTarget.source
      const key: NonNullable<SuspendableActionTransaction['currentInteraction']> = {
        consumerKind: (rootAction.type === 'playCard' ? 'card' : 'skill') as 'card' | 'skill',
        consumerId: directSource?.id
          || ('skillId' in rootAction ? rootAction.skillId : undefined)
          || ('cardInstanceId' in rootAction ? rootAction.cardInstanceId : undefined)
          || 'direct-target',
        sourceId: directSource?.pieceId || ('pieceId' in rootAction ? rootAction.pieceId : undefined) || undefined,
        consumerOrdinal: -2 - directTargetStage,
      }
      const input = transactionRuntime.takeAnswer(key)
      if (!input) {
        transactionRuntime.suspend(key, {
          kind: 'target',
          playerId: directTarget.playerId,
          title: directTarget.title,
          targetType: directTarget.targetType,
          range: directTarget.range,
          filter: directTarget.filter,
          candidates: directTarget.candidates,
          selectionMode: directTarget.selectionMode,
          minSelections: directTarget.minSelections,
          maxSelections: directTarget.maxSelections,
          canCancel: directTarget.canCancel !== false,
          rollbackOnCancel: directTarget.rollbackOnCancel,
          suspendedTurn: { ...reduced.turn },
          sourcePieceId: key.sourceId,
          candidateState: reduced,
        })
      }
      const resolvedInput = input!
      if (resolvedInput.cancelled) {
        if (directTarget.rollbackOnCancel) {
          transactionRuntime.assertReplayComplete()
          return safeCloneBattleState(authorityState)
        }
        reduced.pendingTargetSelection = undefined
      } else {
        const selectedTargets = (resolvedInput.selectedTargets || []) as Array<{
          type: 'piece' | 'cell'; pieceId?: string; x?: number; y?: number
        }>
        const selectedTarget = selectedTargets[0]
        const targetPieceId = resolvedInput.targetPieceId
          || (selectedTarget?.type === 'piece' ? selectedTarget.pieceId : undefined)
        const targetX = resolvedInput.targetX
          ?? (selectedTarget?.type === 'cell' ? selectedTarget.x : undefined)
        const targetY = resolvedInput.targetY
          ?? (selectedTarget?.type === 'cell' ? selectedTarget.y : undefined)
        if (!targetPieceId && (!Number.isInteger(targetX) || !Number.isInteger(targetY))) {
          throw new BattleRuleError(
            'Suspendable direct target replay is missing its selected target',
            'SUSPENDABLE_ACTION_REPLAY_MISMATCH',
          )
        }
        const finalized = finalizePendingTargetSession(
          reduced,
          directTarget,
          transaction.baseTargetingRevision,
        )
        reduced.pendingTargetSelection = finalized
        reduced = applyBattleActionInternal(reduced, {
          type: 'pendingTargetSelect',
          playerId: directTarget.playerId,
          targetPieceId,
          targetX,
          targetY,
          selectionId: finalized.selectionId,
          stateRevision: finalized.stateRevision,
          extraTargets: selectedTargets.slice(1).map(target => target.type === 'piece'
            ? { pieceId: target.pieceId }
            : { x: target.x, y: target.y }),
        })
      }
      directTargetStage += 1
      directTarget = reduced.pendingTargetSelection
    }
    transactionRuntime.assertReplayComplete()
    return reduced
  })
  try {
    const reduced = replayRuleRuntime && replayRuleRuntime !== outerRuleRuntime
      ? withRuleRuntime(replayRuleRuntime, execute)
      : execute()
    if (outerRuleRuntime && replayRuleRuntime && replayRuleRuntime !== outerRuleRuntime) {
      outerRuleRuntime.restore(replayRuleRuntime.snapshot())
    }
    return reduced
  } catch (error) {
    if (outerRuleRuntime && outerRuntimeSnapshot) outerRuleRuntime.restore(outerRuntimeSnapshot)
    getActiveTriggerSystem().restoreTransactionState(triggerSnapshot)
    if (!isSuspendableActionPending(error)) throw error
    const rootActionType = (transaction.rootAction as { type?: string } | undefined)?.type
    // A timeout owns the complete forced progression, including deployment,
    // summon, free-move skipping, end-turn and the next begin-turn chain.
    // Never return an already-expired interactive session from that root action.
    const shouldAutoResolveTimeout = rootActionType === 'turnTimeout'
    if (shouldAutoResolveTimeout) {
      let input: SuspendableInteractionInput
      if (error.prompt.canCancel !== false) {
        input = error.prompt.kind === 'option' && error.prompt.cancelValue !== undefined
          ? { selectedOption: error.prompt.cancelValue }
          : { cancelled: true }
      } else {
        if (!replayRuleRuntime) {
          throw new BattleRuleError(
            'Mandatory timeout transaction requires a deterministic rule runtime',
            'PENDING_TIMEOUT_RUNTIME_REQUIRED',
          )
        }
        if (error.prompt.kind === 'option') {
          const candidates = uniqueSuspendableTimeoutCandidates(
            (error.prompt.options || []).map(option => {
              if (!option || typeof option !== 'object') return option
              if ('value' in option) return (option as { value: unknown }).value
              if ('id' in option) return (option as { id: unknown }).id
              return option
            }),
          )
          if (candidates.length === 0) {
            throw new BattleRuleError(
              'Timed-out mandatory transaction option has no legal candidates',
              'PENDING_TIMEOUT_NO_CANDIDATES',
            )
          }
          if (error.prompt.selectionMode === 'multi') {
            const minSelections = Number.isSafeInteger(error.prompt.minSelections)
              ? Math.max(0, error.prompt.minSelections!)
              : 1
            if (candidates.length < minSelections) {
              throw new BattleRuleError(
                'Timed-out mandatory transaction multi-select has too few legal candidates',
                'PENDING_TIMEOUT_NO_CANDIDATES',
              )
            }
            input = { selectedOption: candidates.slice(0, minSelections) }
          } else {
            const index = replayRuleRuntime.nextInt(
              `${RANDOM_STREAM_NAMES.skillEffect}/pending-timeout`,
              candidates.length,
            )
            input = { selectedOption: candidates[index], timeoutRandomBound: candidates.length }
          }
        } else {
          input = mandatoryTimeoutTargetInput(authorityState, transaction, error.key, error.prompt, replayRuleRuntime)
        }
      }
      const resumed = {
        ...transaction,
        answers: [...transaction.answers, { key: error.key, input }],
        currentInteraction: undefined,
      }
      return runSuspendableActionTransaction(
        authorityState,
        transactionReplayState(authorityState, resumed),
        resumed,
      )
    }
    return setSuspendableTransactionPending(authorityState, transaction, {
      key: error.key,
      prompt: error.prompt,
    })
  }
}

function resumeSuspendableActionTransaction(
  state: BattleState,
  transaction: SuspendableActionTransaction,
  input: SuspendableInteractionInput,
): BattleState {
  if (!transaction.currentInteraction) {
    throw new BattleRuleError(
      'Suspendable action has no current interaction',
      'SUSPENDABLE_ACTION_KEY_MISSING',
    )
  }
  const resumed: SuspendableActionTransaction = {
    ...transaction,
    answers: [
      ...transaction.answers,
      { key: transaction.currentInteraction, input: { ...input } },
    ],
    currentInteraction: undefined,
  }
  return runSuspendableActionTransaction(
    state,
    transactionReplayState(state, resumed),
    resumed,
  )
}

export function assertBattleNotTerminal(state: BattleState): void {
  if (state.terminalResult) {
    throw new BattleRuleError(
      'Battle is already terminal; gameplay commands are no longer accepted',
      'BATTLE_ALREADY_TERMINAL',
    )
  }
}

/**
 * Public reducer wrapper. A successful command advances the target-query
 * revision exactly once, including commands that create a pending session.
 */
export function applyBattleAction(
  state: BattleState,
  action: BattleAction,
): BattleState {
  assertBattleNotTerminal(state)
  const actionIndex = Array.isArray(state.extensions?.debugBattle?.actionLog)
    ? state.extensions.debugBattle.actionLog.length
    : 0
  const hasPending = !!state.pendingOptionSelection || !!state.pendingTargetSelection
  const reduced = hasPending
    ? applyBattleActionInternal(state, action)
    : runSuspendableActionTransaction(
        state,
        state,
        createSuspendableActionTransaction(state, action),
      )
  const advancesTargetingRevision = !isTurnTimerSystemAction(action)
    || action.type === 'turnTimeout'
  let next = advancesTargetingRevision
    ? stampTargetingRevision(state, reduced)
    : reduced
  if (advancesTargetingRevision && next.pendingOptionSelection) {
    const revision = Number.isSafeInteger(next.targetingRevision) ? next.targetingRevision! : 0
    next = { ...next, pendingOptionSelection: finalizePendingOptionSession(next.pendingOptionSelection, revision) }
  }
  finalizeBattleTerminal(next, action, { actionIndex })
  return next
}

// 召唤棋子接口
export interface SummonPieceOptions {
  templateId: string
  faction: "red" | "blue"
  ownerPlayerId: string
  x: number
  y: number
  index?: number
}

// 召唤棋子结果
export interface SummonPieceResult {
  success: boolean
  piece?: PieceInstance
  message?: string
  blocked?: boolean
}

/**
 * 召唤棋子到棋盘
 * 触发 beforePieceSummoned 和 afterPieceSummoned 触发器
 */
export function summonPiece(
  battle: BattleState,
  options: SummonPieceOptions,
  getPieceById: (id: string) => any,
  createPieceInstance: (template: any, ownerPlayerId: string, faction: "red" | "blue", x: number, y: number, index: number) => PieceInstance
): SummonPieceResult {
  const { templateId, faction, ownerPlayerId, x, y, index = 1 } = options

  // 获取棋子模板
  const template = getPieceById(templateId)
  if (!template) {
    return { success: false, message: `棋子模板未找到: ${templateId}` }
  }

  // 触发召唤前触发器
  const beforeSummonResult = getActiveTriggerSystem().checkTriggers(battle, {
    type: "beforePieceSummoned",
    playerId: ownerPlayerId,
    targetPosition: { x, y },
    pieceTemplateId: templateId,
    faction
  })
  if (beforeSummonResult.needsOptionSelection || beforeSummonResult.needsTargetSelection) {
    throw new BattleRuleError('[beforePieceSummoned] interactive trigger is unsupported at this call site', 'INTERACTIVE_TRIGGER_UNSUPPORTED')
  }

  if (beforeSummonResult.blocked) {
    return { success: false, message: "召唤被阻止", blocked: true }
  }

  // 创建棋子实例
  const newPiece = createPieceInstance(template, ownerPlayerId, faction, x, y, index)
  newPiece.isCore = false

  // 将棋子添加到棋盘
  battle.pieces.push(newPiece)

  // 将棋子的规则加载到全局触发器系统
  if (template.rules && Array.isArray(template.rules)) {
    template.rules.forEach((ruleId: string) => {
      const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
      if (rule) {
        if (!newPiece.rules) newPiece.rules = []
        if (!newPiece.rules.some((r: any) => r.id === rule.id)) {
          newPiece.rules.push(rule)
        }
      }
    })
  }

  // 触发召唤后触发器
  const afterSummonResult = getActiveTriggerSystem().checkTriggers(battle, {
    type: "afterPieceSummoned",
    playerId: ownerPlayerId,
    sourcePiece: newPiece,
    pieceTemplateId: templateId,
    faction
  })
  if (afterSummonResult.needsOptionSelection || afterSummonResult.needsTargetSelection) {
    throw new BattleRuleError('[afterPieceSummoned] interactive trigger is unsupported at this call site', 'INTERACTIVE_TRIGGER_UNSUPPORTED')
  }

  // 处理触发效果的消息
  if (afterSummonResult.success && afterSummonResult.messages.length > 0) {
    afterSummonResult.messages.forEach(message => {
      if (!battle.actions) battle.actions = []
      battle.actions.push({
        type: "triggerEffect",
        playerId: ownerPlayerId,
        turn: battle.turn.turnNumber,
        payload: { message }
      })
    })
  }

  return {
    success: true,
    piece: newPiece,
    message: `${newPiece.name} 被召唤到 (${x}, ${y})`
  }
}
