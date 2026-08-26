import type { BattleState } from './turn'
import { readSanitizedBattleActionTrace, readSanitizedBattleReplay } from './battle-trace'
import {
  systemAuthoritativeRuleClock,
  type AuthoritativeRuleClock,
} from './turn-timer'

export const DEPLOYMENT_DURATION_MS = 45_000

export type DeploymentRuleClock = AuthoritativeRuleClock
export const systemDeploymentRuleClock: DeploymentRuleClock = systemAuthoritativeRuleClock

/**
 * Deployment positions are public to players and spectators. Pending reroll
 * inputs are server-private until the atomic confirmation, so every viewer
 * receives the same projection with choices removed.
 */
export function toPublicBattleState(
  state: BattleState,
  viewerPlayerId?: string,
): BattleState {
  const projected = cloneSerializable(state)
  const viewerId = String(viewerPlayerId ?? '').trim().toLowerCase()
  const option = projected.pendingOptionSelection
  if (option) {
    const owner = String(option.playerId ?? '').trim().toLowerCase() === viewerId
    projected.pendingOptionSelection = omitUndefined({
      playerId: option.playerId,
      title: option.title,
      options: owner && Array.isArray(option.options) ? option.options : [],
      source: option.source,
      selectionId: option.selectionId,
      stateRevision: option.stateRevision,
      canCancel: option.canCancel,
    }) as typeof option
  }
  const target = projected.pendingTargetSelection
  if (target) {
    const owner = String(target.playerId ?? '').trim().toLowerCase() === viewerId
    projected.pendingTargetSelection = omitUndefined({
      playerId: target.playerId,
      ownerPlayerId: target.ownerPlayerId,
      title: target.title,
      targetType: target.targetType,
      source: target.source,
      selectionId: target.selectionId,
      stateRevision: target.stateRevision,
      step: target.step,
      canCancel: target.canCancel,
      ...(owner ? {
        range: target.range,
        filter: target.filter,
        steps: target.steps,
        min: target.min,
        max: target.max,
        selectedTargets: target.selectedTargets,
        candidates: Array.isArray(target.candidates) ? target.candidates : [],
      } : { candidates: [] }),
    }) as typeof target
  }
  const debugBattle = projected.extensions?.debugBattle
  const terminalTrace = projected.terminalResult
    ? readSanitizedBattleActionTrace(projected)
    : []
  const terminalReplay = projected.terminalResult
    ? readSanitizedBattleReplay(projected)
    : undefined
  if (debugBattle) {
    debugBattle.appliedActionIds = []
    debugBattle.actionLog = terminalTrace
    if (terminalReplay) debugBattle.replay = terminalReplay
    else delete debugBattle.replay
    delete debugBattle.commandLog
  }

  if (!projected.deployment) return projected

  projected.deployment.choices = {}
  projected.deployment.locks = Object.fromEntries(
    projected.deployment.playerIds.map(playerId => [
      playerId,
      { locked: projected.deployment?.locks[playerId]?.locked === true },
    ]),
  )
  if (projected.deployment.status !== 'complete') {
    delete projected.deployment.finalPositions
  }


  return projected
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'function' ? undefined : candidate,
  )) as T
}
