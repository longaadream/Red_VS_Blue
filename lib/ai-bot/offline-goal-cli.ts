import { searchGoalRoute, type GoalSearchBounds, type GoalSearchResult } from '@/lib/game/ai-goal-search'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { createOfflineDemonGoalFixture, type OfflineGoalFixture } from './offline-goal-fixture'
import type { BattleState } from '@/lib/game/turn'

export interface OfflineGoalCliOptions {
  state?: BattleState
  smoke?: boolean
  playerId: string
  rootSeed: number
  goalTemplateId: string
  bounds: GoalSearchBounds
}

export interface OfflineGoalCliRun {
  result: GoalSearchResult
  fixture?: OfflineGoalFixture
}

function samePlayer(left: unknown, right: unknown): boolean {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

/** Caller-owned goal template projection; the generic search has no content list. */
export function goalForTemplate(templateId: string, playerId: string) {
  return (state: BattleState) => state.pieces.some(piece => (
    piece.templateId === templateId
    && samePlayer(piece.ownerPlayerId, playerId)
    && piece.currentHp > 0
  ))
}

export function progressForTemplate(templateId: string, playerId: string) {
  return (state: BattleState) => state.pieces.filter(piece => (
    piece.templateId === templateId
    && samePlayer(piece.ownerPlayerId, playerId)
    && piece.currentHp > 0
  )).length
}

/**
 * Run one offline search.  The smoke fixture is optional; callers can provide
 * a complete serialized BattleState for arbitrary content and goals.
 */
export async function runOfflineGoalSearch(options: OfflineGoalCliOptions): Promise<OfflineGoalCliRun> {
  let state = options.state
  let fixture: OfflineGoalFixture | undefined
  if (options.smoke) {
    fixture = await createOfflineDemonGoalFixture({
      rootSeed: options.rootSeed,
      goalTemplateId: options.goalTemplateId,
    })
    state = fixture.state
  }
  if (!state) throw new Error('Offline goal search requires a BattleState or smoke fixture')
  return {
    result: searchGoalRoute(state, options.playerId, {
      environment: aiEnvironmentV1,
      rootSeed: options.rootSeed,
      goal: goalForTemplate(options.goalTemplateId, options.playerId),
      progress: progressForTemplate(options.goalTemplateId, options.playerId),
      bounds: options.bounds,
    }),
    fixture,
  }
}

export function projectOfflineGoalResult(run: OfflineGoalCliRun, options: OfflineGoalCliOptions) {
  const { result, fixture } = run
  return {
    schemaVersion: 1,
    mode: options.smoke ? 'smoke' : 'input',
    playerId: options.playerId,
    seed: options.rootSeed,
    goalTemplateId: options.goalTemplateId,
    bounds: result.bounds,
    status: result.status,
    reason: 'reason' in result ? result.reason : undefined,
    route: 'route' in result ? result.route.map(candidate => ({
      id: candidate.id, kind: candidate.kind, action: candidate.action,
    })) : undefined,
    firstAction: 'firstAction' in result && result.firstAction ? {
      id: result.firstAction.id, kind: result.firstAction.kind, action: result.firstAction.action,
    } : undefined,
    stats: result.stats,
    bestProgress: result.bestProgress ? {
      value: result.bestProgress.value,
      depth: result.bestProgress.depth,
      route: result.bestProgress.route.map(candidate => ({
        id: candidate.id, kind: candidate.kind, action: candidate.action,
      })),
      stateKey: result.bestProgress.stateKey,
    } : undefined,
    error: 'error' in result ? result.error : undefined,
    fixture: fixture ? {
      expectedCardIds: fixture.expectedCardIds,
      expectedActionPointCost: fixture.expectedActionPointCost,
    } : undefined,
  }
}
