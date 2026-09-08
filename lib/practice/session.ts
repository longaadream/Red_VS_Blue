import { planShortSearchAction, type ShortSearchContinuation } from '../game/ai-short-search'
import { runBattleActionIsolated } from '../game/battle-runner'
import { recordBattlePresentation } from '../game/battle-presentation-recording'
import { toPublicBattleState } from '../game/deployment'
import { getCurrentInputOwnerPlayerId } from '../game/turn-timer'
import type { BattleAction, BattleState } from '../game/turn'
import { projectBattlePresentationEvents, projectBattlePresentationEventsForViewer } from '../game/battle-presentation-events'
import { evaluateZeroStageState } from './evaluator'
import { practiceEnvironment } from './environment'
import { AI_ID, HUMAN_ID } from './setup'

const humanCommands = new Set(['move', 'useBasicSkill', 'useChargeSkill', 'playCard', 'endTurn', 'beginPhase',
  'deployReservePiece', 'deploymentChoose', 'deploymentLock', 'pendingOptionSelect', 'pendingTargetSelect', 'cancelPendingSelection', 'surrender'])
const ordinary = new Set(['move', 'useBasicSkill', 'useChargeSkill', 'playCard', 'endTurn'])
export function publicPracticeAction(action: BattleAction): Partial<BattleAction> {
  if ('playerId' in action && action.playerId === HUMAN_ID) return action
  // Pending selections can reveal private cards or owner-only effects even when the state is redacted.
  const keys = ['type', 'playerId', ...(['move', 'deployReservePiece', 'useBasicSkill', 'useChargeSkill'].includes(action.type)
    ? ['pieceId', 'skillId', 'toX', 'toY'] : [])]
  return Object.fromEntries(Object.entries(action).filter(([key]) => keys.includes(key))) as Partial<BattleAction>
}
export interface PracticeTiming { turn: number; computeMs: number; actions: number; complete: boolean }

/** One worker, one state owner. Never accepts a state supplied by the page. */
export class PracticeSession {
  private revision = 0
  private continuation?: ShortSearchContinuation
  private ordinaryActions = 0
  private turnKey = ''
  private timing?: PracticeTiming
  private timings: PracticeTiming[] = []
  private paused?: string
  constructor(private state: BattleState, private readonly seed: number, private readonly now = () => performance.now()) {}

  private checkRevision(revision: number) {
    if (revision !== this.revision) throw new Error('指令已过期，请使用当前战局重试')
    if (this.state.terminalResult) throw new Error('本局已经结束')
    if (this.paused) throw new Error(this.paused)
  }

  snapshot() {
    const state = toPublicBattleState(this.state, HUMAN_ID)
    // The full replay carries private state snapshots. It must stay inside the worker.
    if (state.extensions) delete state.extensions.debugBattle
    // Raw rule logs can contain private card names. The page receives viewer-filtered events instead.
    state.actions = []
    state.skillsById = {}
    return { state, revision: this.revision, inputOwner: getCurrentInputOwnerPlayerId(this.state),
      humanPlayerId: HUMAN_ID, aiPlayerId: AI_ID, paused: this.paused,
      timings: this.timings.map(item => ({ ...item })) }
  }

  private commit(action: BattleAction) {
    const before = this.state
    const result = recordBattlePresentation(before,
      () => runBattleActionIsolated(before, action, { rootSeed: this.seed }), result => result.state)
    this.state = result.state
    this.revision++
    const events = projectBattlePresentationEventsForViewer(projectBattlePresentationEvents({
      actionId: `practice-${this.revision}`, command: action, beforeState: before, afterState: this.state,
    }), HUMAN_ID)
    if (this.timing && (this.state.terminalResult || this.state.turn.turnNumber !== this.timing.turn)) this.timing.complete = true
    return { ...this.snapshot(), action: publicPracticeAction(action), events }
  }

  human(action: BattleAction, revision: number) {
    this.checkRevision(revision)
    if (!action || !humanCommands.has(action.type)) throw new Error('练习不允许管理指令')
    if ('playerId' in action && action.playerId !== undefined && action.playerId !== HUMAN_ID) throw new Error('只能操作自己的棋组')
    if (action.type !== 'surrender' && getCurrentInputOwnerPlayerId(this.state) !== HUMAN_ID) throw new Error('等待 AI 行动')
    return this.commit({ ...action, playerId: HUMAN_ID } as BattleAction)
  }

  step(revision: number) {
    this.checkRevision(revision)
    if (getCurrentInputOwnerPlayerId(this.state) !== AI_ID) throw new Error('正在等待玩家选择')
    const started = this.now()
    const key = `${this.state.turn.turnNumber}:${this.state.turn.currentPlayerId}`
    if (this.turnKey !== key) {
      this.turnKey = key; this.continuation = undefined; this.ordinaryActions = 0
      this.timing = { turn: this.state.turn.turnNumber, computeMs: 0, actions: 0, complete: false }
      this.timings.push(this.timing)
    }
    const timing = this.timing!
    try {
      const decision = planShortSearchAction(this.state, AI_ID, this.seed, {
        environment: practiceEnvironment, evaluate: o => evaluateZeroStageState(o).total,
        continuation: this.continuation, actionsTakenThisTurn: this.ordinaryActions, now: this.now,
      })
      this.continuation = decision.continuation
      if (!decision.nextAction) throw new Error('AI 未找到可执行指令，练习已暂停')
      const action = decision.nextAction.action
      const result = this.commit(action)
      if (ordinary.has(action.type)) this.ordinaryActions++
      timing.actions++
      timing.computeMs += this.now() - started
      // Include dispatch, public projection and official submission in the accumulated budget.
      this.continuation.elapsedMs = timing.computeMs
      if (timing.computeMs >= 10000 && !timing.complete) this.paused = 'AI 本回合计算超过10秒，练习已暂停，可重新开局或返回'
      if (timing.actions >= 40 && !timing.complete) this.paused = 'AI 规则选择次数异常，练习已暂停'
      return { ...result, paused: this.paused, timings: this.timings.map(item => ({ ...item })),
        diagnostics: { turn: timing.turn, nodes: decision.nodes, stopReason: decision.stopReason } }
    } catch (error) {
      timing.computeMs += this.now() - started
      this.paused = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
}
