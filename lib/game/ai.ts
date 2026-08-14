import type { BattleState } from './battle-types'
import { getSkillById } from './skill-repository'
import { getLegalNormalMoveTargets, manhattanDistance } from './spatial'

function getValidMoves(
  state: BattleState,
  piece: any,
): Array<{ x: number; y: number }> {
  return getLegalNormalMoveTargets(state, piece)
}

// Find valid skill targets for one piece and one skill definition
function findSkillTargets(
  state: BattleState,
  piece: any,
  skillDef: any,
  enemies: any[],
  allies: any[],
): any[] | null {
  const targetType = skillDef.targetType
  const filter = skillDef.filter
  const range: number = typeof skillDef.range === 'number' ? skillDef.range : 99

  if (!targetType || targetType === 'none') return [null] // no target needed

  if (targetType === 'piece') {
    const pool = filter === 'ally' ? allies : enemies
    const inRange = pool.filter(
      t => t.currentHp > 0 && t.x != null && t.y != null &&
        manhattanDistance(piece, t) <= range,
    )
    return inRange.length > 0 ? inRange : null
  }

  // grid / cell target — pick the enemy's cell
  if (targetType === 'grid' || targetType === 'cell') {
    const inRange = enemies.filter(
      e => e.currentHp > 0 && e.x != null && e.y != null &&
        manhattanDistance(piece, e) <= range,
    )
    return inRange.length > 0 ? inRange : null
  }

  return null
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
    if (piece.x == null || piece.y == null || ap < 1) continue

    const allies = botPieces.filter(p => p.instanceId !== piece.instanceId)
    let actedThisPiece = false

    // ── 1. Try to use a skill ──────────────────────────────────────────────
    if (piece.skills && piece.skills.length > 0) {
      for (const pieceSkill of piece.skills) {
        if (pieceSkill.currentCooldown && pieceSkill.currentCooldown > 0) continue

        const skillDef =
          ((state.skillsById as any)?.[pieceSkill.skillId]) ||
          getSkillById(pieceSkill.skillId)
        if (!skillDef) continue

        const apCost: number = skillDef.actionPointCost ?? 0
        if (ap < apCost) continue

        const chargeCost: number = skillDef.chargeCost ?? 0
        if (chargeCost > 0 && botMeta.chargePoints < chargeCost) continue

        // Skip skills that need user interaction (pending option/target)
        if (skillDef.needsOptionSelection || skillDef.interactive) continue

        const targets = findSkillTargets(state, piece, skillDef, enemies, allies)
        if (!targets) continue

        const actionType = chargeCost > 0 ? 'useChargeSkill' : 'useBasicSkill'

        if (targets[0] === null) {
          // Self or area — no explicit target needed
          actions.push({ type: actionType, playerId: botPlayerId, pieceId: piece.instanceId, skillId: pieceSkill.skillId })
        } else {
          // Pick the enemy with the lowest current HP (finish-off priority)
          const target = targets.reduce(
            (best: any, t: any) => (t.currentHp < best.currentHp ? t : best),
            targets[0],
          )
          actions.push({
            type: actionType,
            playerId: botPlayerId,
            pieceId: piece.instanceId,
            skillId: pieceSkill.skillId,
            targetPieceId: target.instanceId,
            targetX: target.x,
            targetY: target.y,
          })
        }

        ap -= apCost
        actedThisPiece = true
        break // one skill attempt per piece per turn
      }
    }

    // ── 2. Move toward nearest enemy if no skill was fired ─────────────────
    if (!actedThisPiece && ap >= 1) {
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
          ap -= 1
        }
      }
    }
  }

  actions.push(endTurnAction)
  return actions
}
