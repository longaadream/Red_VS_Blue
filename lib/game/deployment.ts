import type { BattleState } from './turn'
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

  const debugBattle = projected.extensions?.debugBattle
  if (debugBattle) {
    debugBattle.appliedActionIds = []
    debugBattle.actionLog = []
  }

  return projected
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'function' ? undefined : candidate,
  )) as T
}
