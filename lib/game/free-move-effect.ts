import type { BattleState } from './turn'
import { BattleRuleError } from './battle-types'
import { getNormalMovePath, getNormalMoveRejection, type GridPosition } from './spatial'
import { changePiecePositions, type PositionChangeOptions, type PositionChangeResult } from './position-change'
import { settlePositionContacts } from './tile-contact'
import { globalTriggerSystem, type TriggerContext } from './triggers'
import { getRuleExecutionTriggerSystem } from './rule-runtime'

/** A content-granted ordinary move; action ownership and AP are not its cost. */
export function executeFreeMove(
  battle: BattleState,
  pieceId: string,
  destination: GridPosition,
  reservedCells?: PositionChangeOptions['reservedCells'],
): PositionChangeResult {
  const cancelled = (message: string): PositionChangeResult => ({ success: false, changes: [], message })
  const piece = battle.pieces.find(candidate => candidate.instanceId === pieceId && candidate.currentHp > 0)
  if (!piece || piece.x == null || piece.y == null) return cancelled('移动棋子已失效')
  if (!Number.isSafeInteger(destination.x) || !Number.isSafeInteger(destination.y)) {
    throw new BattleRuleError('移动落点必须是整数')
  }

  const rejection = getNormalMoveRejection(battle, piece, destination)
  if (rejection) return cancelled(rejection.message)

  const dispatch = (context: TriggerContext) => {
    const result = getRuleExecutionTriggerSystem(globalTriggerSystem).checkTriggers(battle, context)
    // Ordinary movement has the same non-interactive reaction boundary as a move action.
    if (result.needsOptionSelection || result.needsTargetSelection) {
      throw new BattleRuleError(`[${context.type}] interactive trigger is unsupported at this call site`, 'INTERACTIVE_TRIGGER_UNSUPPORTED')
    }
    battle.actions ??= []
    for (const message of result.messages) battle.actions.push({
      type: 'triggerEffect', playerId: piece.ownerPlayerId, turn: battle.turn.turnNumber, payload: { message },
    })
    return result
  }

  const fromX = piece.x
  const fromY = piece.y
  const context: TriggerContext = {
    type: 'beforeMove',
    sourcePiece: piece,
    playerId: piece.ownerPlayerId,
    movementKind: 'walk',
    fromX,
    fromY,
    targetX: destination.x,
    targetY: destination.y,
    reservedCells: reservedCells?.map(cell => ({ ...cell })),
  }
  const before = dispatch(context)
  if (before.blocked) return cancelled(before.messages.join('；') || '移动被阻止')

  const finalX = context.targetX
  const finalY = context.targetY
  if (typeof finalX !== 'number' || typeof finalY !== 'number'
    || !Number.isSafeInteger(finalX) || !Number.isSafeInteger(finalY)) {
    throw new BattleRuleError('移动反应产生了无效落点')
  }
  const normalPath = getNormalMovePath(battle, piece, { x: finalX, y: finalY })
  if (!normalPath) return cancelled('普通移动路径已失效')
  const finalRejection = getNormalMoveRejection(battle, piece, { x: finalX, y: finalY }, normalPath)
  if (finalRejection) return cancelled(finalRejection.message)

  const result = changePiecePositions(battle, [{ pieceId, x: finalX, y: finalY }], 'walk', {
    normalPath,
    reservedCells,
    deferContacts: true,
  })
  if (!result.success) return result
  const change = result.changes[0]
  battle.actions!.push({
    type: 'move',
    playerId: piece.ownerPlayerId,
    turn: battle.turn.turnNumber,
    payload: {
      pieceId,
      fromX: change.from.x,
      fromY: change.from.y,
      toX: change.to.x,
      toY: change.to.y,
      freeMove: true,
      message: `${piece.name || piece.templateId}进行了免费移动`,
    },
  })
  settlePositionContacts(battle, result.changes)
  dispatch({
    type: 'afterMove',
    sourcePiece: piece,
    playerId: piece.ownerPlayerId,
    movementKind: 'walk',
    fromX: change.from.x,
    fromY: change.from.y,
    targetX: change.to.x,
    targetY: change.to.y,
    pathCells: change.path,
    contactCells: change.path,
  })
  return result
}
