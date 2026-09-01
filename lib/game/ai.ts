import { listLegalAIActions } from './ai-environment'
import { stableJson } from './battle-trace'
import { getCurrentInputOwnerPlayerId } from './turn-timer'
import type { BattleAction, BattleState } from './turn'
import { getSkillById } from './skill-repository'
import { prepareAction } from './targeting'
import type { TargetRef } from './targeting'
import { getLegalNormalMoveTargetsForPlayer, manhattanDistance } from './spatial'
import { getEffectiveChargeCost } from './skills'

function getValidMoves(
  state: BattleState,
  piece: any,
): Array<{ x: number; y: number }> {
  return getLegalNormalMoveTargetsForPlayer(state, piece.ownerPlayerId, piece.instanceId)
}

function appendTargetRef(action: any, ref: TargetRef): any {
  const next = { ...action }
  const hasPrimary = next.targetPieceId || (next.targetX !== undefined && next.targetY !== undefined)
  if (!hasPrimary) {
    if (ref.type === 'piece') next.targetPieceId = ref.pieceId
    else { next.targetX = ref.x; next.targetY = ref.y }
    return next
  }
  const extraTargets = Array.isArray(next.extraTargets) ? [...next.extraTargets] : []
  extraTargets.push(ref.type === 'piece' ? { pieceId: ref.pieceId } : { x: ref.x, y: ref.y })
  next.extraTargets = extraTargets
  return next
}

function chooseTarget(state: BattleState, candidates: TargetRef[], enemies: any[]): TargetRef | undefined {
  const pieceCandidates = candidates
    .filter((ref): ref is Extract<TargetRef, { type: 'piece' }> => ref.type === 'piece')
    .map(ref => ({ ref, piece: state.pieces.find(piece => piece.instanceId === ref.pieceId) }))
    .filter(entry => entry.piece)
  if (pieceCandidates.length > 0) {
    return pieceCandidates.reduce((best, current) =>
      (current.piece!.currentHp < best.piece!.currentHp ? current : best), pieceCandidates[0]).ref
  }
  const lowestEnemy = enemies.length > 0
    ? enemies.reduce((best, enemy) => enemy.currentHp < best.currentHp ? enemy : best, enemies[0])
    : undefined
  if (lowestEnemy) {
    const enemyCell = candidates.find(ref => ref.type === 'cell' && ref.x === lowestEnemy.x && ref.y === lowestEnemy.y)
    if (enemyCell) return enemyCell
  }
  return candidates[0]
}

function prepareBotSkillAction(state: BattleState, draft: any, enemies: any[]): any | undefined {
  let action = { ...draft }
  for (let guard = 0; guard < 8; guard += 1) {
    const preparation = prepareAction(state, action)
    if (preparation.kind === 'invalid') return undefined
    if (preparation.kind === 'ready') return action
    if (preparation.kind === 'needOption') {
      const option = preparation.options[0]
      if (!option) return undefined
      action.selectionId = preparation.selectionId
      action.stateRevision = preparation.stateRevision
      action.selectedOption = option.value
      continue
    }
    const target = chooseTarget(state, preparation.candidates, enemies)
    if (!target) return undefined
    action.selectionId = preparation.selectionId
    action.stateRevision = preparation.stateRevision
    action = appendTargetRef(action, target)
  }
  return undefined
}

export function prepareBotAction(state: BattleState, draft: any, botPlayerId: string): any | undefined {
  const enemies = state.pieces.filter(piece => piece.ownerPlayerId !== botPlayerId && piece.currentHp > 0)
  return prepareBotSkillAction(state, draft, enemies)
}

export function generateBotActions(state: BattleState, botPlayerId: string): any[] {
  const actions: any[] = []
  const endTurnAction = { type: 'endTurn', playerId: botPlayerId }

  const botMeta = state.players.find(p => p.playerId === botPlayerId)
  if (!botMeta) return [endTurnAction]

  const botPieces = state.pieces.filter(p => p.ownerPlayerId === botPlayerId && p.currentHp > 0)
  const enemies = state.pieces.filter(p => p.ownerPlayerId !== botPlayerId && p.currentHp > 0)

  if (enemies.length === 0 || botPieces.length === 0) return [endTurnAction]

  let ap = botMeta.actionPoints

  for (const piece of botPieces) {
    if (piece.x == null || piece.y == null) continue

    let actedThisPiece = false

    // ── 1. Try to use a skill ──────────────────────────────────────────────
    if (ap >= 1 && piece.skills && piece.skills.length > 0) {
      for (const pieceSkill of piece.skills) {
        if (pieceSkill.currentCooldown && pieceSkill.currentCooldown > 0) continue

        const skillDef =
          ((state.skillsById as any)?.[pieceSkill.skillId]) ||
          getSkillById(pieceSkill.skillId)
        if (!skillDef) continue

        const apCost: number = skillDef.actionPointCost ?? 0
        if (ap < apCost) continue

        const baseChargeCost: number = skillDef.chargeCost ?? 0
        const chargeCost = getEffectiveChargeCost(state, botPlayerId, skillDef)
        if (chargeCost > 0 && botMeta.chargePoints < chargeCost) continue

        // Skip skills that need user interaction (pending option/target)
        if (skillDef.needsOptionSelection || skillDef.interactive) continue

        const actionType = baseChargeCost > 0 ? 'useChargeSkill' : 'useBasicSkill'
        const action = prepareBotSkillAction(state, {
          type: actionType,
          playerId: botPlayerId,
          pieceId: piece.instanceId,
          skillId: pieceSkill.skillId,
        }, enemies)
        if (!action) continue
        actions.push(action)

        ap -= apCost
        actedThisPiece = true
        break // one skill attempt per piece per turn
      }
    }

    // ── 2. Move toward nearest enemy if no skill was fired ─────────────────
    if (!actedThisPiece) {
      const validMoves = getValidMoves(state, piece)
      const liveEnemies = enemies.filter(e => e.x != null && e.y != null)
      if (validMoves.length > 0 && liveEnemies.length > 0) {
        const nearestEnemy = liveEnemies.reduce((best, e) => {
          return manhattanDistance(piece, e) <
            manhattanDistance(piece, best)
            ? e
            : best
        }, liveEnemies[0])

        const bestMove = validMoves.reduce((best, m) => {
          return manhattanDistance(m, nearestEnemy) <
            manhattanDistance(best, nearestEnemy)
            ? m
            : best
        }, validMoves[0])

        const currentDist = manhattanDistance(piece, nearestEnemy)
        const newDist = manhattanDistance(bestMove, nearestEnemy)

        if (newDist < currentDist) {
          actions.push({ type: 'move', playerId: botPlayerId, pieceId: piece.instanceId, toX: bestMove.x, toY: bestMove.y })
          // The authority owns move cost. At 0 AP, the player-aware spatial
          // query can only return an explicitly free normal move; at positive
          // AP this conservative local estimate preserves the existing policy.
          if (ap >= 1) ap -= 1
        }
      }
    }
  }

  actions.push(endTurnAction)
  return actions
}

export interface BotActionPlan {
  kind: 'structural' | 'action'
  actions: BattleAction[]
}

function samePlayer(left: string | undefined, right: string): boolean {
  return typeof left === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase()
}

/**
 * Produces a deterministic, side-effect-free plan for the bot's current input.
 * Structural inputs are deliberately one command at a time so callers can
 * reload the authoritative state before deciding again. The action phase keeps
 * the existing tactical generator as one batch to avoid repeatedly selecting
 * the same zero-AP action.
 */
export function planBotActions(state: BattleState, botPlayerId: string): BotActionPlan | undefined {
  if (state.terminalResult || !samePlayer(getCurrentInputOwnerPlayerId(state), botPlayerId)) {
    return undefined
  }

  const legal = listLegalAIActions(state, botPlayerId)
  if (legal.length === 0) return undefined

  // Summon triggers can hand a pending interaction to either player while the
  // deployment state still names its original owner. Resolve that interaction
  // first; getCurrentInputOwnerPlayerId already selected the pending owner.
  if (state.pendingOptionSelection || state.pendingTargetSelection) {
    return { kind: 'structural', actions: [legal[0].action] }
  }

  if (state.deployment?.status === 'awaiting-reserve-deploy') {
    const deployment = legal.find(candidate => candidate.kind === 'reserve-deployment')
    return deployment ? { kind: 'structural', actions: [deployment.action] } : undefined
  }

  if (state.turn.phase === 'action') {
    return {
      kind: 'action',
      actions: generateBotActions(state, botPlayerId) as BattleAction[],
    }
  }

  return { kind: 'structural', actions: [legal[0].action] }
}

/** Revalidates a previously planned command against the latest authority state. */
export function prepareLegalBotAction(
  state: BattleState,
  draft: BattleAction,
  botPlayerId: string,
): BattleAction | undefined {
  if (state.terminalResult || !samePlayer(getCurrentInputOwnerPlayerId(state), botPlayerId)) {
    return undefined
  }

  const prepared = draft.type === 'useBasicSkill' || draft.type === 'useChargeSkill'
    ? prepareBotAction(state, {
        type: draft.type,
        playerId: draft.playerId,
        pieceId: draft.pieceId,
        skillId: draft.skillId,
      }, botPlayerId) as BattleAction | undefined
    : draft
  if (!prepared) return undefined

  const preparedKey = stableJson(prepared)
  return listLegalAIActions(state, botPlayerId)
    .find(candidate => stableJson(candidate.action) === preparedKey)
    ?.action
}
