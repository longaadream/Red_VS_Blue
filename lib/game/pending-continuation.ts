import type { BattleState } from './turn'
import type { TriggerContext, TriggerResult } from './triggers'
import type { SuspendableInteractionInput } from './suspendable-action-transaction'
import { createSkillCodeFlow, getRuleDynamicCodeRuntime, addStatusWithEvents, addPlayerStatusWithEvents } from './skills'
import { getRuleMath, getRuleDate } from './rule-runtime'
import { changePiecePositions } from './position-change'
import { withPositionWriteGuard } from './position-write-guard'
import type { PieceStatusTag } from './piece'
import { getActiveEffectChain } from './effect-batch'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from './gameplay-module-diagnostics'

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
  const answerTargets = answer.selectedTargets ?? (answer.targetPieceId
    ? [{ type: 'piece', pieceId: answer.targetPieceId }]
    : answer.targetX !== undefined && answer.targetY !== undefined ? [{ type: 'cell', x: answer.targetX, y: answer.targetY }] : [])
  // The transaction runner folds every answer received for this consumer into
  // the trigger context before invoking the continuation. Keep that complete
  // ordered selection here: a later stage (for example a destination cell)
  // still needs the earlier stage's mover piece when its generated code reads
  // pending.selectedTargets.
  const selectedTargets = Array.isArray(context.selectedTargets) && context.selectedTargets.length > 0
    ? context.selectedTargets
    : answerTargets
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
  const runtimeContext = { ...pendingContext }
  const flowContext = {
    ...context, ...runtimeContext, type: 'pendingEffect' as const,
    rulePiece: battle.pieces.find(piece => piece.instanceId === sourceId),
    sourcePiece: context.sourcePiece,
    triggerPlayerId: context.triggerPlayerId ?? context.playerId,
  }
  const executionContext = {
    ...runtimeContext,
    flow: createSkillCodeFlow(battle, flowContext, 'pending'),
  }
  const chain = getActiveEffectChain(battle)
  const restoreGameplayModuleDiagnosticHost = installGameplayModuleDiagnosticHost(
    executionContext,
    createGameplayModuleDiagnosticHost('pending', {
      contentId: ruleId,
      ...(context.playerId ? { actorPlayerId: context.playerId } : {}),
      ...(Number.isSafeInteger(battle.turn?.turnNumber) ? { turn: battle.turn.turnNumber } : {}),
      ...(typeof battle.turn?.phase === 'string' ? { phase: battle.turn.phase } : {}),
      ...(chain?.rootSeed !== null && chain?.rootSeed !== undefined ? { rootSeed: chain.rootSeed } : {}),
      ...(chain?.actionId ? { actionId: chain.actionId } : {}),
      ...(chain?.chainId ? { chainId: chain.chainId } : {}),
    }),
  )
  try {
    return withPositionWriteGuard(battle, () => execute(executionContext)) || { success: true, messages: [], blocked: false }
  } finally {
    restoreGameplayModuleDiagnosticHost()
  }
}
