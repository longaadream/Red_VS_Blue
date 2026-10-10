import type { BattleState } from './turn'
import type { TriggerContext, TriggerResult } from './triggers'
import type { SuspendableInteractionInput } from './suspendable-action-transaction'
import { createSkillCodeFlow, getRuleDynamicCodeRuntime, addStatusWithEvents, addPlayerStatusWithEvents } from './skills'
import { getRuleMath, getRuleDate } from './rule-runtime'
import { changePiecePositions } from './position-change'
import { withPositionWriteGuard } from './position-write-guard'
import type { PieceStatusTag } from './piece'

/** Execute one compiled rule continuation within the current transaction.
 * It uses the same authority, seeded runtime, and position guard as a pending
 * action; no independent state or command transaction is created. */
export function executeRuleContinuation(battle: BattleState, prompt: TriggerResult, answer: SuspendableInteractionInput, context: TriggerContext, sourceId: string | undefined, ruleId: string): TriggerResult {
  if (!prompt.effectCode) throw new Error('Rule continuation requires generated effect code')
  const compile = getRuleDynamicCodeRuntime().compileExpression<(math: Math, date: DateConstructor) => unknown>({
    surface: 'pendingEffectCode', contentId: ruleId,
    code: '(function(Math, Date) { return (' + prompt.effectCode + '); })', entry: 'serialized function(ctx)',
  })
  const execute = compile(getRuleMath(), getRuleDate())
  if (typeof execute !== 'function') throw new Error('Rule continuation did not compile to a function')
  const selectedTargets = answer.selectedTargets ?? (answer.targetPieceId
    ? [{ type: 'piece', pieceId: answer.targetPieceId }]
    : answer.targetX !== undefined && answer.targetY !== undefined ? [{ type: 'cell', x: answer.targetX, y: answer.targetY }] : [])
  const pending = { source: { type: 'rule', id: ruleId, pieceId: sourceId }, triggerContext: context, selectedTargets, payload: prompt.payload }
  const targetPiece = answer.targetPieceId ? battle.pieces.find(piece => piece.instanceId === answer.targetPieceId && piece.currentHp > 0) : undefined
  const pendingContext = {
    battle, playerId: prompt.playerId ?? context.playerId,
    targetPiece, targetX: answer.targetX, targetY: answer.targetY,
    pending, payload: prompt.payload, cancelled: answer.cancelled,
    addStatusEffectById: (pieceId: string, status: PieceStatusTag) => addStatusWithEvents(battle, pieceId, status),
    addPlayerStatusEffectById: (playerId: string, status: PieceStatusTag) => addPlayerStatusWithEvents(battle, playerId, status),
    changePositions: (changes: Parameters<typeof changePiecePositions>[1], kind: Parameters<typeof changePiecePositions>[2]) => changePiecePositions(battle, changes, kind),
  }
  return withPositionWriteGuard(battle, () => execute({ ...pendingContext, flow: createSkillCodeFlow(battle, {
    ...context, ...pendingContext, type: 'pendingEffect',
    rulePiece: battle.pieces.find(piece => piece.instanceId === sourceId),
    sourcePiece: context.sourcePiece,
    triggerPlayerId: context.triggerPlayerId ?? context.playerId,
  }, 'pending') })) || { success: true, messages: [], blocked: false }
}
