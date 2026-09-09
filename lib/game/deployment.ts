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
  for (const player of projected.players) {
    if (viewerId && player.playerId.trim().toLowerCase() === viewerId) continue
    player.hand = player.hand.map((_card, index) => ({
      cardId: 'hidden',
      instanceId: `hidden-card-${index}`,
      ownerPlayerId: player.playerId,
    }))
  }
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
  for (const [key, value] of Object.entries(projected.extensions ?? {})) {
    if (!Array.isArray(value)) continue
    projected.extensions![key] = value.filter(entry => {
      if (!entry || typeof entry !== 'object' || entry.projectionVisibility !== 'owner') return true
      return String(entry.ownerPlayerId ?? '').trim().toLowerCase() === viewerId
    })
  }
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
  const mayReadTerminalTrace = !viewerId || projected.players.some(player => player.playerId.toLowerCase() === viewerId)
  if (!mayReadTerminalTrace && projected.extensions?.battleProfile) projected.extensions.battleProfile.rootSeed = 0
  if (!mayReadTerminalTrace) {
    delete projected.customCards
    projectSpectatorDisguises(projected)
  }
  const terminalTrace = projected.terminalResult && mayReadTerminalTrace
    ? readSanitizedBattleActionTrace(projected)
    : []
  const terminalReplay = projected.terminalResult && mayReadTerminalTrace
    ? readSanitizedBattleReplay(projected)
    : undefined
  if (debugBattle) {
    if (!mayReadTerminalTrace) delete projected.extensions!.debugBattle
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

/** Observers receive a display identity for source-mirror pieces. Raw ownership
 * references and executable attributes must not reveal a secret clone choice. */
function projectSpectatorDisguises(state: BattleState): void {
  const all = [...state.pieces, ...(state.graveyard ?? [])]
  const disguised = all.filter(piece => piece.templateId === 'blue-naruto')
  if (!disguised.length) return
  const references = new Map(disguised.map(piece => [piece.instanceId, `spectator-mirror-${piece.ownerPlayerId}`]))
  const display = (piece: BattleState['pieces'][number]): BattleState['pieces'][number] => {
    if (!references.has(piece.instanceId)) return piece
    const mirror = piece as typeof piece & {
      masterPieceId?: string; displayCurrentHp?: number; displayMaxHp?: number;
      displayAttack?: number; displayDefense?: number; displayMoveRange?: number;
      displaySkills?: typeof piece.skills; displayStatusTags?: typeof piece.statusTags;
    }
    const master = all.find(candidate => candidate.instanceId === mirror.masterPieceId && candidate.currentHp > 0)
    const source = master ?? piece
    return {
      instanceId: `spectator-mirror-${piece.ownerPlayerId}-${piece.x}-${piece.y}`,
      templateId: source.templateId, name: source.name, ownerPlayerId: piece.ownerPlayerId,
      faction: piece.faction, x: piece.x, y: piece.y, isCore: source.isCore,
      currentHp: piece.currentHp <= 0 ? 0 : master?.currentHp ?? mirror.displayCurrentHp ?? piece.currentHp,
      maxHp: master?.maxHp ?? mirror.displayMaxHp ?? piece.maxHp,
      attack: master?.attack ?? mirror.displayAttack ?? piece.attack,
      defense: master?.defense ?? mirror.displayDefense ?? piece.defense,
      moveRange: master?.moveRange ?? mirror.displayMoveRange ?? piece.moveRange,
      skills: master?.skills ?? mirror.displaySkills ?? piece.skills,
      statusTags: (master?.statusTags ?? mirror.displayStatusTags ?? piece.statusTags).filter(tag => tag.visible !== false),
      rules: [], buffs: [], debuffs: [], ruleTags: [],
    } as BattleState['pieces'][number]
  }
  state.pieces = state.pieces.map(display).sort((a, b) => a.instanceId.localeCompare(b.instanceId))
  state.graveyard = (state.graveyard ?? []).map(display).sort((a, b) => a.instanceId.localeCompare(b.instanceId))
  state.turn.actions = { hasMoved: false, hasUsedBasicSkill: false, hasUsedChargeSkill: false }
  if (state.deployment) { state.deployment.initialPositions = {}; delete state.deployment.finalPositions }
  state.actions = (state.actions ?? []).map(action => {
    const skill = state.skillsById?.[action.payload?.skillId]
    const secret = skill?.concealTargetInBattleLog || action.payload?.skillId === 'naruto-shadow-clone'
    return { type: action.type, playerId: action.playerId, turn: action.turn, payload: {
      message: secret ? `${skill?.name ?? '影分身之术'}（秘密选择）` : action.payload?.message,
    } }
  })
  // Group references stay meaningful without identifying which visible body
  // owns an internal status, flag, pending interaction or effect source.
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      for (const [id, group] of references) value = (value as string).split(id).join(group)
      return value
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [replace(key) as string, replace(item)]))
    return value
  }
  Object.assign(state, replace(state))
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'function' ? undefined : candidate,
  )) as T
}
