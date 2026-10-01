import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')
const battlePage = readFileSync(resolve(pagesDir, 'battle.html'), 'utf8')

function readNamedFunction(html: string, name: string) {
  const marker = `function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${name}`)
  const nextFunction = html.indexOf('\n    function ', start + marker.length)
  if (nextFunction === -1) throw new Error(`Could not isolate ${name}`)
  return html.slice(start, nextFunction)
}

describe('RED-221 selection retry', () => {
  it('keeps the active caster and skill draft when an occupied cell is not a legal target', () => {
    const messages: string[] = []
    const context = createContext({
      ADVENTURE_MODE: false,
      TRAINING_MODE: false,
      SPECTATE_MODE: false,
      G: {
        turn: { currentPlayerId: 'player-red' },
        pieces: [
          { instanceId: 'caster', x: 1, y: 1, currentHp: 10 },
          { instanceId: 'friendly-invalid', x: 2, y: 2, currentHp: 10 },
        ],
      },
      myPlayerId: 'player-red',
      selectedPieceId: 'caster',
      pendingMove: false,
      pendingCardAction: null,
      pendingSkill: {
        skillId: 'skill-a',
        skillType: 'normal',
        validTargets: new Set(['3,3']),
        preparation: { targetType: 'piece' },
      },
      targetSubmissionPending: null,
      adventureDeployPieceId: null,
      adventureOpenCell: () => false,
      pendingOptionSelectionForOther: () => false,
      refreshBattleLegalActions: () => undefined,
      setStatusMsg: (message: string) => messages.push(message),
      selectPiece: (instanceId: string) => {
        context.selectedPieceId = instanceId
        context.pendingSkill = null
      },
    })
    new Script(readNamedFunction(battlePage, 'onCellClick')).runInContext(context)

    new Script('onCellClick(2, 2)').runInContext(context)

    expect(context.selectedPieceId).toBe('caster')
    expect(context.pendingSkill).toMatchObject({ skillId: 'skill-a' })
    expect(messages.at(-1)).toBe('目标不在技能范围内')
  })

  it('keeps a submitted target draft attached to the single-flight lock until authority responds', () => {
    const sent: unknown[] = []
    const context = createContext({
      targetSubmissionPending: null,
      pendingSkill: { skillId: 'skill-a', preparation: { selectionId: 'sel-1', stateRevision: 4 } },
      pendingCardAction: null,
      pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [] },
      pendingMove: false,
      red50Evidence: { targetCommands: [], rejections: [] },
      prepareFreshSelectionAction: (action: unknown) => action,
      withClientActionId: (action: Record<string, unknown>) => ({ ...action, clientActionId: 'target-1' }),
      tutorialActionAllowed: () => true,
      currentTargetSourceName: () => 'Skill A',
      doAction: (action: unknown) => sent.push(action),
      setStatusMsg: () => undefined,
      renderTargetOverlay: () => undefined,
      addLog: () => undefined,
    })
    new Script([
      readNamedFunction(battlePage, 'snapshotTargetInteraction'),
      readNamedFunction(battlePage, 'submitTargetAction'),
    ].join('\n')).runInContext(context)

    const accepted = new Script("submitTargetAction({ type: 'useBasicSkill', selectionId: 'sel-1', stateRevision: 4 }, 'Skill A')").runInContext(context)

    expect(accepted).toBe(true)
    expect(sent).toHaveLength(1)
    expect(context.targetSubmissionPending).toMatchObject({
      clientActionId: 'target-1',
      draft: { skill: { skillId: 'skill-a' } },
    })
  })

  it('releases only the matching rejected command and restores its draft for retry', () => {
    const statuses: string[] = []
    const context = createContext({
      G: null,
      targetSubmissionPending: {
        clientActionId: 'target-1',
        draft: { skill: { skillId: 'skill-a' }, card: null, board: null },
      },
      pendingActionFeedback: { clientActionId: 'target-1', startedAt: 0, type: 'useBasicSkill' },
      pendingActionFeedbackTimer: null,
      pendingSkill: null,
      pendingCardAction: null,
      pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [] },
      recordAuthorityPerformance: () => undefined,
      renderTargetOverlay: () => undefined,
      renderActionBar: () => undefined,
      setStatusMsg: (message: string) => statuses.push(message),
      requestAuthorityRecovery: () => undefined,
      clearTimeout: () => undefined,
      document: { body: { classList: { add: () => undefined } } },
    })
    new Script([
      readNamedFunction(battlePage, 'clearPendingActionFeedback'),
      readNamedFunction(battlePage, 'restoreTargetInteractionDraft'),
      readNamedFunction(battlePage, 'targetRejectionCanRetry'),
      readNamedFunction(battlePage, 'applyAuthorityReceipt'),
    ].join('\n')).runInContext(context)

    expect(new Script("targetRejectionCanRetry('PENDING_OPTION_STALE')").runInContext(context)).toBe(false)
    expect(new Script("targetRejectionCanRetry('TARGET_OCCUPIED')").runInContext(context)).toBe(true)

    const accepted = new Script("applyAuthorityReceipt({ clientActionId: 'target-1', status: 'rejected', code: 'TARGET_OCCUPIED' })").runInContext(context)

    expect(accepted).toBe(true)
    expect(context.targetSubmissionPending).toBeNull()
    expect(context.pendingSkill).toMatchObject({ skillId: 'skill-a' })

    context.targetSubmissionPending = {
      clientActionId: 'target-2',
      draft: { skill: { skillId: 'skill-b' }, card: null, board: null },
    }
    context.pendingSkill = null
    const stale = new Script("applyAuthorityReceipt({ clientActionId: 'target-1', status: 'rejected', code: 'TARGET_OCCUPIED' })").runInContext(context)
    expect(stale).toBe(false)
    expect(context.targetSubmissionPending.clientActionId).toBe('target-2')
    expect(context.pendingSkill).toBeNull()
    expect(statuses).toEqual([])
  })

  it('clears a detached draft when the authoritative targeting revision changes', () => {
    const clearEvents: string[] = []
    const context = createContext({
      locallyCancelledSelectionId: null,
      targetSubmissionDraft: null,
      targetSubmissionPending: {
        clientActionId: 'target-1',
        draft: {
          skill: { skillId: 'skill-a', preparation: { stateRevision: 4 } },
          card: null,
          board: null,
        },
      },
      pendingSkill: null,
      pendingCardAction: null,
      pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [] },
      pendingMove: false,
      selectedPieceId: 'caster',
      myPlayerId: 'player-red',
      validMoves: new Set(),
      recordTargetClear: (reason: string) => clearEvents.push(reason),
      renderTargetOverlay: () => undefined,
      setStatusMsg: () => undefined,
      document: { body: { classList: { remove: () => undefined } } },
    })
    new Script([
      readNamedFunction(battlePage, 'clearTargetInteraction'),
      readNamedFunction(battlePage, 'reconcileBattleInteractionState'),
    ].join('\n')).runInContext(context)

    const feedback = new Script(`reconcileBattleInteractionState(
      { turn: { currentPlayerId: 'player-red' } },
      { turn: { currentPlayerId: 'player-red' }, targetingRevision: 5, pieces: [{ instanceId: 'caster', currentHp: 10 }] },
    )`).runInContext(context)

    expect(feedback).toBe('战局状态已更新，请重新选择技能目标')
    expect(context.targetSubmissionPending).toBeNull()
    expect(clearEvents).toEqual(['targeting-revision-changed'])
  })
})
