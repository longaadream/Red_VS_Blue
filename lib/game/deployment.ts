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
  void viewerPlayerId
  const projected = cloneSerializable(state)
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

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'function' ? undefined : candidate,
  )) as T
}
