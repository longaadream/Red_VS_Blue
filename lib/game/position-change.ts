import type { BattleState } from './turn'
import { BattleRuleError } from './battle-types'
import { globalTriggerSystem } from './triggers'
import { getRuleExecutionTriggerSystem } from './rule-runtime'
import { getNormalMoveRejection, getPositionChangeRejection, isLegalSkillLanding, type PositionChangeKind } from './spatial'

export interface PiecePositionChange { pieceId: string; x: number; y: number }

/** Atomic board relocation. Death/removal and summon placement use their own lifecycles. */
export function changePiecePositions(battle: BattleState, changes: readonly PiecePositionChange[], kind: PositionChangeKind): void {
  const ids = changes.map(change => change.pieceId)
  if (new Set(ids).size !== ids.length) throw new BattleRuleError('A piece can move only once in a position-change batch')
  const prepared = changes.map(change => {
    const piece = battle.pieces.find(piece => piece.instanceId === change.pieceId && piece.currentHp > 0)
    if (!piece || piece.x == null || piece.y == null) throw new BattleRuleError('Position change requires a living board piece')
    const reason = getPositionChangeRejection(piece, kind)
    if (reason) throw new BattleRuleError(reason)
    const context = { type: 'beforePiecePositionChange', sourcePiece: piece, playerId: piece.ownerPlayerId,
      movementKind: kind, targetX: change.x, targetY: change.y }
    const result = getRuleExecutionTriggerSystem(globalTriggerSystem).checkTriggers(battle, context)
    if (result.blocked || result.needsOptionSelection || result.needsTargetSelection) {
      throw new BattleRuleError(result.messages.join('；') || 'Position change was blocked')
    }
    return { piece, x: context.targetX, y: context.targetY }
  })
  const cells = new Set<string>()
  for (const entry of prepared) {
    const key = `${entry.x},${entry.y}`
    const reason = getPositionChangeRejection(entry.piece, kind)
    if (reason) throw new BattleRuleError(reason)
    if (kind === 'walk') {
      const rejection = getNormalMoveRejection(battle, entry.piece, entry)
      if (rejection) throw new BattleRuleError(rejection.message)
    }
    if (!Number.isSafeInteger(entry.x) || !Number.isSafeInteger(entry.y) || cells.has(key)
      || !isLegalSkillLanding(battle, entry, { movingPieceIds: ids })) throw new BattleRuleError('Position change has an illegal landing')
    cells.add(key)
  }
  for (const entry of prepared) { entry.piece.x = entry.x; entry.piece.y = entry.y }
}

/** Legacy trusted scripts still mutate coordinates; authority must enforce the same restriction. */
export function assertRestrictedPositionsUnchanged(before: BattleState, after: BattleState): void {
  for (const piece of before.pieces) {
    if (!getPositionChangeRejection(piece, 'teleport')) continue
    const current = after.pieces.find(candidate => candidate.instanceId === piece.instanceId && candidate.currentHp > 0)
    if (current && current.x != null && current.y != null && piece.x != null && piece.y != null
      && (current.x !== piece.x || current.y !== piece.y)) throw new BattleRuleError('An imprisoned piece cannot change its board position')
  }
}
