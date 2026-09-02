import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

function readPage(relativePath: string) {
  return readFileSync(resolve(pagesDir, relativePath), 'utf8')
}

function readNamedFunction(html: string, name: string) {
  const marker = `function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${name} in battle.html`)
  const nextFunction = html.indexOf('\n    function ', start + marker.length)
  if (nextFunction === -1) throw new Error(`Could not isolate ${name} in battle.html`)
  return html.slice(start, nextFunction)
}

describe('RED-69 battle motion contract', () => {
  it('shares the named motion tokens between CSS and Three.js without long interaction segments', () => {
    const css = readPage('css/battle-tactical-table.css')
    const renderer = readPage('js/battle-renderer-3d.js')

    for (const token of [
      '--motion-press: 100ms',
      '--motion-fast: 140ms',
      '--motion-action: 240ms',
      '--motion-result: 280ms',
      '--ease-out: cubic-bezier(0.22, 1, 0.36, 1)',
      '--ease-in: cubic-bezier(0.4, 0, 1, 1)',
      '--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)',
    ]) expect(css).toContain(token)

    expect(renderer).toContain('MOTION_TOKENS')
    expect(renderer).toContain('press: 100')
    expect(renderer).toContain('fast: 140')
    expect(renderer).toContain('action: 240')
    expect(renderer).toContain('result: 280')
    expect(renderer).not.toMatch(/duration:\s*0\.[4-9]/)
  })

  it('keeps target and status feedback short, simultaneous, and reduced-motion safe', () => {
    const css = readPage('css/battle-tactical-table.css')
    const renderer = readPage('js/battle-renderer-3d.js')

    expect(css).toContain('.piece-board-status-dot.is-entering')
    expect(css).toContain('.piece-board-status-dot.is-exiting')
    expect(css).toMatch(/\.dmg-float[\s\S]*?--floater-duration:\s*600ms/)
    expect(css).toContain('.dmg-float.is-heal')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).not.toContain('animation:targetPulse')
    expect(css).toMatch(/@keyframes rvbStatusEnter\s*\{\s*from \{ opacity: 0; transform: scale\(0\.92\); \}/)
    expect(css).toMatch(/\.piece-board-status-dot\.is-exiting\s*\{[\s\S]*?animation-name: rvbResultFadeOut !important/)
    expect(css).toMatch(/\.dmg-float\s*\{[\s\S]*?animation-duration: var\(--motion-fast\) !important/)
    expect(renderer).toContain("_syncHighlightGroup('skill'")
    expect(renderer).not.toContain('items.forEach((item, index)')
  })

  it('keeps timeout and disconnect recovery correlated without discarding pending presentation state', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('pendingActionFeedback')
    expect(battlePage).toContain('PENDING_ACTION_TIMEOUT_MS')
    expect(battlePage).toContain("rejectPendingActionFeedback('server-rejected'")
    expect(battlePage).not.toContain("rejectPendingActionFeedback('action-timeout'")
    expect(battlePage).not.toContain("rejectPendingActionFeedback('disconnect'")
    expect(battlePage).toContain("requestAuthorityRecovery('action-timeout', action.clientActionId)")
    expect(battlePage).toContain("requestAuthorityRecovery('pending-action-reconnect', pendingActionFeedback.clientActionId)")
    expect(battlePage).toMatch(/function disposeBattlePage\(\)[\s\S]*?clearPendingActionFeedback\('page-dispose'/)
    expect(battlePage).toMatch(/interaction:\s*\{[\s\S]*?pendingPieceId:/)
  })

  it('keeps one pending command until an exact receipt and preserves it across timeout recovery', () => {
    const battlePage = readPage('battle.html')
    const statusMessages: string[] = []
    const clearReasons: string[] = []
    const recoveryRequests: string[][] = []
    let timeoutCallback: (() => void) | null = null
    let context: ReturnType<typeof createContext>
    context = createContext({
      pendingActionFeedback: null,
      pendingActionFeedbackTimer: null,
      authorityPerformanceSamples: [],
      targetSubmissionPending: { clientActionId: 'move-1' },
      locallyCancelledSelectionId: null,
      pendingSkill: null,
      pendingCardAction: null,
      PENDING_ACTION_TIMEOUT_MS: 8000,
      selectedPieceId: 'piece-a',
      battlePresentation: null,
      G: null,
      setTimeout: (callback: () => void) => {
        timeoutCallback = callback
        return 1
      },
      clearTimeout: () => undefined,
      setStatusMsg: (message: string) => statusMessages.push(message),
      requestAuthorityRecovery: (...args: string[]) => recoveryRequests.push(args),
      renderBoard: () => undefined,
      renderActionBar: () => undefined,
      render: () => undefined,
      clearTargetInteraction: (reason: string) => {
        clearReasons.push(reason)
        context.targetSubmissionPending = null
      },
      validMoves: new Set(),
      JSON,
      Number,
      Set,
    })
    for (const name of [
      'clearPendingActionFeedback',
      'beginPendingActionFeedback',
      'rejectPendingActionFeedback',
      'battleStateMotionKey',
      'recordAuthorityPerformance',
      'applyAuthorityReceipt',
      'reconcileBattleInteractionState',
    ]) {
      new Script(readNamedFunction(battlePage, name)).runInContext(context)
    }

    let transportCount = 0
    for (let index = 0; index < 10; index += 1) {
      const accepted = new Script("beginPendingActionFeedback({ type: 'move', pieceId: 'piece-a', clientActionId: 'move-1' })").runInContext(context)
      if (accepted) transportCount += 1
    }
    expect(transportCount).toBe(1)
    expect(new Script('pendingActionFeedback.clientActionId').runInContext(context)).toBe('move-1')

    const previousState = {
      turn: { turnNumber: 1, phase: 'action', currentPlayerId: 'red' },
      actions: [],
      pieces: [{ instanceId: 'piece-a', x: 1, y: 1, currentHp: 10, visible: true, statuses: [] }],
    }
    context.previousState = previousState
    context.duplicateState = structuredClone(previousState)
    expect(new Script('reconcileBattleInteractionState(previousState, duplicateState)').runInContext(context)).toBe('')
    expect(new Script('pendingActionFeedback.clientActionId').runInContext(context)).toBe('move-1')
    expect(new Script('targetSubmissionPending.clientActionId').runInContext(context)).toBe('move-1')
    expect(clearReasons).toEqual([])

    context.unrelatedState = { ...structuredClone(previousState), transportDiagnostic: { serverNow: 1234 } }
    expect(new Script('reconcileBattleInteractionState(previousState, unrelatedState)').runInContext(context)).toBe('')
    context.unrelatedReceipt = { clientActionId: 'older-action', status: 'applied', authorityVersion: 2 }
    expect(new Script('applyAuthorityReceipt(unrelatedReceipt)').runInContext(context)).toBe(false)
    expect(new Script('pendingActionFeedback.clientActionId').runInContext(context)).toBe('move-1')

    context.matchingReceipt = { clientActionId: 'move-1', status: 'applied', authorityVersion: 2 }
    expect(new Script('applyAuthorityReceipt(matchingReceipt)').runInContext(context)).toBe(true)
    expect(new Script('pendingActionFeedback').runInContext(context)).toBeNull()
    expect(new Script('targetSubmissionPending').runInContext(context)).toBeNull()
    expect(clearReasons).toContain('authority-receipt-applied')
    expect(context.authorityPerformanceSamples).toHaveLength(1)
new Script("beginPendingActionFeedback({ type: 'move', pieceId: 'piece-a', clientActionId: 'move-2' })").runInContext(context)
    new Script("rejectPendingActionFeedback('server-rejected')").runInContext(context)
    expect(new Script('pendingActionFeedback').runInContext(context)).toBeNull()
    expect(clearReasons).toContain('server-rejected')

    const clearCountBeforePreservedRejection = clearReasons.length
    context.targetSubmissionPending = { clientActionId: 'target-1' }
    new Script("beginPendingActionFeedback({ type: 'pendingTargetSelect', pieceId: 'piece-a', clientActionId: 'target-1' })").runInContext(context)
    new Script("rejectPendingActionFeedback('server-rejected', null, { preserveTargetInteraction: true })").runInContext(context)
    expect(new Script('pendingActionFeedback').runInContext(context)).toBeNull()
    expect(new Script('targetSubmissionPending.clientActionId').runInContext(context)).toBe('target-1')
    expect(clearReasons).toHaveLength(clearCountBeforePreservedRejection)
    new Script("beginPendingActionFeedback({ type: 'move', pieceId: 'piece-a', clientActionId: 'move-3' })").runInContext(context)
    expect(timeoutCallback).not.toBeNull()
    ;(timeoutCallback as unknown as () => void)()
    expect(new Script('pendingActionFeedback.clientActionId').runInContext(context)).toBe('move-3')
    expect(new Script('pendingActionFeedback.timedOut').runInContext(context)).toBe(true)
    expect(clearReasons).not.toContain('action-timeout')
    expect(recoveryRequests).toEqual([['action-timeout', 'move-3']])
    expect(statusMessages).toContain('上一条指令仍在等待权威确认')
    expect(statusMessages).toContain('指令回执延迟，正在同步服务端状态，请勿重复操作')
  })

  it('blocks piece switching while a RED-69 command remains pending', () => {
    const battlePage = readPage('battle.html')
    const selectPiece = readNamedFunction(battlePage, 'selectPiece')
    expect(selectPiece).toMatch(/if \(pendingActionFeedback\)[\s\S]*?暂不能切换棋子[\s\S]*?return/)
  })
})
