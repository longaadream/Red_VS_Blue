import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8').replace(/\r\n/g, '\n')
function source(name: string) {
  const start = page.indexOf(`function ${name}(`)
  const end = page.indexOf('\n    function ', start + 1)
  if (start < 0 || end < 0) throw new Error(`Missing function: ${name}`)
  return page.slice(start, end)
}

function retry(error: Record<string, unknown>) {
  const context = createContext({
    targetSubmissionPending: {
      clientActionId: 'action-1',
      draft: { skill: { skillId: 'active-skill' }, card: null },
    },
    error,
  })
  new Script(source('targetRejectionCanRetry') + '\n' + source('shouldRetainTargetAfterRejection')).runInContext(context)
  return new Script("shouldRetainTargetAfterRejection({type:'useBasicSkill'}, error)").runInContext(context)
}

function transportScenario(kind: string) {
  let sent = 0, recovered = 0
  const context = createContext({
    pendingSkill: null, pendingCardAction: null, targetSubmissionDraft: null,
    targetSubmissionPending: { clientActionId: 'transport-1', draft: { skill: { skillId: 'active-skill' } } },
    G: { pieces: [] }, PRACTICE_MODE: false, ADVENTURE_MODE: false, TRAINING_MODE: false,
    SPECTATE_MODE: false, TUTORIAL_MODE: false, colyseusConnected: true,
    waitingForOtherPending: () => false,
    withClientActionId: (action: unknown) => action,
    getServerUrl: () => 'http://localhost',
    document: { body: { classList: { add: () => undefined } }, getElementById: () => ({ disabled: false }) },
    renderTargetOverlay: () => undefined, renderActionBar: () => undefined,
    setMoveButtonDisabled: () => undefined, setStatusMsg: () => undefined, addLog: () => undefined,
    rejectPendingActionFeedback: (_reason: string, _message: string, options?: { preserveTargetInteraction: boolean }) => {
      if (!options?.preserveTargetInteraction) context.pendingSkill = null
    },
    requestAuthorityRecovery: () => { recovered++ },
    createBattleActionAuth: async () => {
      if (kind === 'authentication') throw new Error('authentication failed')
      return {}
    },
    battleAuthorityCommandMessage: (action: unknown) => action,
    RvBColyseus: {
      isAuthoritySyncing: () => kind === 'sync',
      isConnected: () => true,
      send: () => {
        sent++
        if (kind === 'unknown') throw new Error('transport outcome unknown')
        return false
      },
    },
  })
  for (const name of ['restoreTargetInteractionDraft', 'releaseTargetSubmissionForRetry', 'rejectUnsentTargetSubmission']) {
    new Script(source(name)).runInContext(context)
  }
  new Script('async ' + source('doAction')).runInContext(context)
  return { context, counts: () => ({ sent, recovered }) }
}

describe('selection rejection session boundaries', () => {
  it.each(['sync', 'authentication', 'send-false'])('releases the target lock when %s confirms no command was sent', async kind => {
    const { context, counts } = transportScenario(kind)
    await new Script("doAction({type:'useBasicSkill',clientActionId:'transport-1'})").runInContext(context)
    expect(context.targetSubmissionPending).toBeNull()
    expect(context.pendingSkill).toEqual({ skillId: 'active-skill' })
    expect(counts()).toEqual({ sent: kind === 'send-false' ? 1 : 0, recovered: 0 })
  })

  it('keeps the single-flight lock and requests authority recovery when delivery is uncertain', async () => {
    const { context, counts } = transportScenario('unknown')
    await new Script("doAction({type:'useBasicSkill',clientActionId:'transport-1'})").runInContext(context)
    expect(context.targetSubmissionPending.clientActionId).toBe('transport-1')
    expect(context.pendingSkill).toBeNull()
    expect(counts()).toEqual({ sent: 1, recovered: 1 })
  })

  it('keeps an unsent draft when both the transport event and send result reject it', () => {
    const context = createContext({
      targetSubmissionPending: { clientActionId: 'unsent', draft: { skill: { skillId: 'active-skill' } } },
      targetSubmissionDraft: null,
      pendingSkill: null,
      pendingCardAction: null,
      document: { body: { classList: { add: () => undefined } } },
      renderTargetOverlay: () => undefined,
      rejectPendingActionFeedback: (_reason: string, _message: string, options: { preserveTargetInteraction: boolean }) => {
        if (!options.preserveTargetInteraction) context.pendingSkill = null
      },
    })
    for (const name of ['restoreTargetInteractionDraft', 'releaseTargetSubmissionForRetry', 'rejectUnsentTargetSubmission']) {
      new Script(source(name)).runInContext(context)
    }
    new Script("rejectUnsentTargetSubmission('sync','not sent'); rejectUnsentTargetSubmission('sync','not sent')").runInContext(context)
    expect(context.targetSubmissionPending).toBeNull()
    expect(context.pendingSkill).toEqual({ skillId: 'active-skill' })
  })

  it('ignores an old rejected receipt after a new target draft is armed but not yet submitted', () => {
    const marker = "} else if (msg.type === 'actionError') {"
    const start = page.indexOf(marker) + marker.length
    const end = page.indexOf('\n        }\n      })', start)
    expect(start).toBeGreaterThan(marker.length)
    expect(end).toBeGreaterThan(start)
    const context = createContext({
      pendingActionFeedback: null,
      targetSubmissionPending: null,
      pendingSkill: { skillId: 'new-skill' },
      pendingCardAction: null,
      red50Evidence: { rejections: [] },
      G: null,
      addLog: () => undefined,
      applyAuthorityReceipt: () => false,
      shouldRetainTargetAfterRejection: () => false,
      render: () => undefined,
      setStatusMsg: () => undefined,
      rejectPendingActionFeedback: () => { context.pendingSkill = null },
    })
    new Script(`function handleOldRejection(msg) { ${page.slice(start, end)} }`).runInContext(context)
    new Script("handleOldRejection({type:'actionError', receipt:{status:'rejected',clientActionId:'old-action'}, error:'illegal target'})").runInContext(context)
    expect(context.pendingSkill).toEqual({ skillId: 'new-skill' })
  })

  it('permits correcting an illegal target without retrying an expired authority session', () => {
    expect(retry({ code: 'TARGET_OUT_OF_RANGE' })).toBe(true)
    expect(retry({ code: 'TARGET_SELECTION_COUNT_INVALID' })).toBe(true)
    for (const code of [
      'TARGET_SELECTION_STALE', 'TARGET_SELECTION_ID_MISMATCH',
      'TARGET_SELECTION_PLAYER_MISMATCH', 'TARGET_SELECTION_ALREADY_RESOLVED',
      'TARGET_SOURCE_MISSING', 'PENDING_TARGET_SELECTION_NOT_FOUND',
      'PENDING_OPTION_STALE', 'PENDING_OPTION_ALREADY_RESOLVED',
      'PENDING_OPTION_NOT_FOUND', 'VERSION_CONFLICT', 'TURN_EXPIRED', 'BATTLE_RECEIPT_UNKNOWN',
    ]) {
      expect(retry({ code }), code).toBe(false)
    }
  })

  it('reads rejection codes from authority receipts and never restores a superseded step', () => {
    expect(retry({ receipt: { status: 'rejected', code: 'TARGET_OUT_OF_RANGE' } })).toBe(true)
    expect(retry({ receipt: { status: 'rejected', code: 'TARGET_SELECTION_STALE' } })).toBe(false)
    expect(retry({ receipt: { status: 'resyncRequired' } })).toBe(false)
    expect(retry({ needsTargetSelection: true })).toBe(false)
    expect(retry({ needsOptionSelection: true })).toBe(false)
  })

  it('does not reset target mode when clicking either the caster or another piece through piece selection', () => {
    const context = createContext({
      selectedPieceId: 'caster',
      pendingActionFeedback: null,
      targetSubmissionPending: null,
      pendingSkill: { skillId: 'active-skill' },
      pendingCardAction: null,
      setStatusMsg: () => undefined,
    })
    new Script(source('selectPiece')).runInContext(context)
    new Script("selectPiece('caster'); selectPiece('another-piece')").runInContext(context)
    expect(context.selectedPieceId).toBe('caster')
    expect(context.pendingSkill).toEqual({ skillId: 'active-skill' })
  })
})
