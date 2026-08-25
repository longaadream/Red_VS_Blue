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
  const terminalTrace = state.terminalResult
    ? readSanitizedBattleActionTrace(state)
    : []
  const terminalReplay = state.terminalResult
    ? readSanitizedBattleReplay(state)
    : undefined

  // Active matches can accumulate hundreds of kilobytes of server-only trace
  // data. Remove it before the serializable clone instead of cloning it and
  // immediately throwing it away for every player and spectator snapshot.
  const sourceDebugBattle = state.extensions?.debugBattle
  let cloneInput = state
  if (sourceDebugBattle) {
    const publicDebugBattle = {
      ...sourceDebugBattle,
      appliedActionIds: [],
      actionLog: terminalTrace,
    }
    delete publicDebugBattle.commandLog
    if (terminalReplay) publicDebugBattle.replay = terminalReplay
    else delete publicDebugBattle.replay

    cloneInput = {
      ...state,
      extensions: {
        ...state.extensions,
        debugBattle: publicDebugBattle,
      },
    }
  }

  const projected = cloneSerializable(cloneInput)

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
