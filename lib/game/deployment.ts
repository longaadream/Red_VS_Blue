import type { BattleState } from './turn'
import type { PieceInstance } from './piece'
export { DEPLOYMENT_FIRST_MOVE_FREE_STATUS } from './piece'
import { readSanitizedBattleActionTrace, readSanitizedBattleReplay } from './battle-trace'
import { manhattanDistance } from './spatial'
import {
  systemAuthoritativeRuleClock,
  type AuthoritativeRuleClock,
} from './turn-timer'

export const DEPLOYMENT_DURATION_MS = 45_000

export type DeploymentRuleClock = AuthoritativeRuleClock
export const systemDeploymentRuleClock: DeploymentRuleClock = systemAuthoritativeRuleClock

export const PROGRESSIVE_DEPLOYMENT_MODE = 'progressive-reserve-v1' as const
export const DEPLOYMENT_SAFE_DISTANCE = 5
export function isProgressiveDeployment(
  state: Pick<BattleState, 'deployment'>,
): boolean {
  return state.deployment?.mode === PROGRESSIVE_DEPLOYMENT_MODE
}

export function getEmptyWalkableDeploymentPositions(
  state: Pick<BattleState, 'map' | 'pieces'>,
): Array<{ x: number; y: number }> {
  const occupied = new Set(
    state.pieces
      .filter(piece => piece.currentHp > 0 && piece.x !== null && piece.y !== null)
      .map(piece => `${piece.x},${piece.y}`),
  )
  return state.map.tiles
    .filter(tile => tile.props.walkable === true && !occupied.has(`${tile.x},${tile.y}`))
    .map(tile => ({ x: tile.x, y: tile.y }))
    .sort((left, right) => left.y - right.y || left.x - right.x)
}

export function getSafeDeploymentPositions(
  state: Pick<BattleState, 'map' | 'pieces'>,
): Array<{ x: number; y: number }> {
  const livingPieces = state.pieces.filter(
    piece => piece.currentHp > 0 && piece.x !== null && piece.y !== null,
  )
  return getEmptyWalkableDeploymentPositions(state).filter(position =>
    livingPieces.every(piece => manhattanDistance(position, piece) > DEPLOYMENT_SAFE_DISTANCE),
  )
}

export function reservePiecesForPlayer(
  state: Pick<BattleState, 'deployment'>,
  playerId: string,
): PieceInstance[] {
  const reserves = state.deployment?.reserves ?? {}
  const stableId = Object.keys(reserves).find(
    candidate => candidate.trim().toLowerCase() === playerId.trim().toLowerCase(),
  )
  return stableId ? reserves[stableId] ?? [] : []
}

/**
 * Legacy final positions are public after both locks. Progressive offers and
 * legal placement cells are projected only to the active owner; opponents,
 * spectators and viewer-less persistence projections receive the same redacted
 * public phase/count information.
 */
export function toPublicBattleState(
  state: BattleState,
  viewerPlayerId?: string,
): BattleState {
  const projected = cloneSerializable(state)
  const viewerId = String(viewerPlayerId ?? '').trim().toLowerCase()
  const redactPrivatePieceStatus = (piece: BattleState['pieces'][number]) => {
    const owner = String(piece.ownerPlayerId ?? '').trim().toLowerCase() === viewerId
    if (!owner) {
      piece.statusTags = Array.isArray(piece.statusTags)
        ? piece.statusTags.filter(tag => tag.visible !== false)
        : []
    }
  }
  projected.pieces.forEach(redactPrivatePieceStatus)
  ;(projected.graveyard ?? []).forEach(redactPrivatePieceStatus)
  Object.values(projected.deployment?.reserves ?? {}).flat().forEach(redactPrivatePieceStatus)
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
      ...(owner ? {
        selectionMode: option.selectionMode,
        presentation: option.presentation,
        minSelections: option.minSelections,
        maxSelections: option.maxSelections,
      } : {}),
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
        selectionMode: target.selectionMode,
        minSelections: target.minSelections,
        maxSelections: target.maxSelections,
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

  if (projected.deployment.mode === PROGRESSIVE_DEPLOYMENT_MODE) {
    const activePlayerId = String(projected.deployment.activePlayerId ?? '').trim().toLowerCase()
    const owner = !!viewerId && activePlayerId === viewerId
    const sourceDeployment = state.deployment!
    const sourceReservePieces = reservePiecesForPlayer(state, sourceDeployment.activePlayerId ?? '')
    const offeredIds = sourceDeployment.offerPieceIds ?? []
    projected.deployment.reserveCounts = Object.fromEntries(
      projected.deployment.playerIds.map(playerId => [
        playerId,
        reservePiecesForPlayer(state, playerId).length,
      ]),
    )
    projected.deployment.reserves = {}
    projected.deployment.offerPieceIds = owner ? [...offeredIds] : []
    projected.deployment.offerPieces = owner
      ? offeredIds.flatMap(instanceId => {
          const piece = sourceReservePieces.find(candidate => candidate.instanceId === instanceId)
          return piece ? [{
            instanceId: piece.instanceId,
            templateId: piece.templateId,
            name: piece.name,
          }] : []
        })
      : []
    projected.deployment.legalPositions = owner
      ? (sourceDeployment.legalPositions ?? []).map(position => ({ ...position }))
      : []
    projected.deployment.choices = {}
    projected.deployment.locks = {}
    delete projected.deployment.finalPositions
    return projected
  }

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
