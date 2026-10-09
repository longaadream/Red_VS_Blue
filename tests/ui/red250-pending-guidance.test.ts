import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8').replace(/\r\n/g, '\n')

function source(name: string) {
  const start = page.indexOf(`function ${name}(`)
  const end = page.indexOf('\n    function ', start + 1)
  if (start < 0 || end < 0) throw new Error(`Missing function: ${name}`)
  return page.slice(start, end)
}

function pendingGuidanceSource() {
  const start = page.indexOf('    function waitingForOtherPending()')
  const end = page.indexOf("    ;['pointerdown'", start)
  if (start < 0 || end < 0) throw new Error('Missing pending guidance helpers')
  return page.slice(start, end)
}

function classList() {
  const values = new Set<string>()
  return {
    add: (...names: string[]) => names.forEach(name => values.add(name)),
    remove: (...names: string[]) => names.forEach(name => values.delete(name)),
    toggle: (name: string, force?: boolean) => {
      const next = force === undefined ? !values.has(name) : force
      if (next) values.add(name)
      else values.delete(name)
      return next
    },
    contains: (name: string) => values.has(name),
  }
}

function element() {
  return {
    classList: classList(),
    style: {} as Record<string, string>,
    hidden: false,
    disabled: false,
    textContent: '',
  }
}

function opponentPending(playerId: string) {
  const pending: Record<string, unknown> = { playerId }
  for (const key of ['title', 'source', 'candidates', 'candidateCount', 'choices', 'validTargets']) {
    Object.defineProperty(pending, key, {
      configurable: true,
      get: () => { throw new Error(`opponent pending leaked ${key}`) },
    })
  }
  return pending
}

function renderContext(key: 'pendingTargetSelection' | 'pendingOptionSelection') {
  const overlay = element()
  const prompt = element()
  const summary = element()
  const confirm = element()
  const cancel = element()
  const controls = element()
  const status = element()
  const body = { classList: classList() }
  const elements: Record<string, ReturnType<typeof element>> = {
    targetOverlay: overlay,
    targetPromptText: prompt,
    targetMultiSummary: summary,
    targetConfirmButton: confirm,
    targetCancelButton: cancel,
    targetSelectionControls: controls,
    statusMsg: status,
  }
  const context = createContext({
    document: { body, getElementById: (id: string) => elements[id] || null },
    window: {},
    G: {
      turn: { currentPlayerId: 'me' },
      pendingTargetSelection: key === 'pendingTargetSelection' ? opponentPending('other') : null,
      pendingOptionSelection: key === 'pendingOptionSelection' ? opponentPending('other') : null,
    },
    clientOwns: (id: string) => id === 'me',
    myPlayerId: 'me',
    pendingSkill: null,
    pendingCardAction: null,
    targetSubmissionPending: null,
    pendingBoardTargetSelection: { selectedPieceIds: [], selectedCells: [] },
    closePieceContextMenu: vi.fn(),
    placeTargetOverlayHost: vi.fn(),
    targetStepPrefix: () => '',
    targetTypeText: () => '选择一个目标',
    isPendingBoardMultiTarget: () => false,
    pendingBoardMultiLimits: () => ({ min: 1, max: 1 }),
    pendingBoardMultiSummary: () => '',
    showDmFeedback: vi.fn(),
  })
  new Script([
    pendingGuidanceSource(),
    source('cardNeedsTarget'),
    source('localCardTargetPrompt'),
    source('_targetPromptText'),
    source('renderTargetOverlay'),
    source('setStatusMsg'),
  ].join('\n')).runInContext(context)
  new Script('renderTargetOverlay()').runInContext(context)
  return { context, body, overlay, prompt, cancel, controls, status }
}

function actionBarContext() {
  const button = element()
  const statuses: string[] = []
  const context = createContext({
    G: {
      turn: { currentPlayerId: 'me', phase: 'action' },
      pendingTargetSelection: opponentPending('other'),
      pendingOptionSelection: null,
      deployment: null,
      pieces: [],
    },
    myPlayerId: 'me',
    clientOwns: (id: string) => id === 'me',
    document: { getElementById: (id: string) => id === 'btnEnd' ? button : null },
    refreshHandResourceCost: () => undefined,
    refreshLessonVisualCue: () => undefined,
    renderDeploymentStatus: () => undefined,
    renderTurnTimerStatus: () => undefined,
    scheduleDeadlineStatusRefresh: () => undefined,
    pendingOptionSelectionForMe: () => false,
    pendingTargetSelectionForMe: () => false,
    pendingOptionSelectionForOther: () => false,
    pendingActionFeedback: null,
    targetSubmissionPending: null,
    SPECTATE_MODE: false,
    progressiveDeploymentPending: () => false,
    setMoveButtonDisabled: () => undefined,
    pendingMove: false,
    validMoves: new Set(),
    selectedPieceId: null,
    setMoveButtonClass: () => undefined,
    clearMoveDraft: () => undefined,
    closePieceContextMenu: () => undefined,
    setStatusMsg: (message: string) => statuses.push(message),
    pendingSkill: null,
    pendingCardAction: null,
    moveDraft: null,
  })
  new Script(pendingGuidanceSource() + '\n' + source('renderActionBar')).runInContext(context)
  return { context, button, statuses }
}

describe('RED-250 pending guidance', () => {
  it.each(['pendingTargetSelection', 'pendingOptionSelection'] as const)(
    'shows the same private-safe opponent guidance for %s', key => {
      const result = renderContext(key)

      expect(result.overlay.classList.contains('show')).toBe(true)
      expect(result.prompt.textContent).toBe('你的行动触发了对方响应，请等待对方完成选择')
      expect(result.controls.classList.contains('show')).toBe(false)
      expect(result.body.classList.contains('target-mode-active')).toBe(false)
      expect(result.body.classList.contains('pending-response-waiting')).toBe(true)
      expect(result.cancel.hidden).toBe(true)
      expect(result.cancel.disabled).toBe(true)

      result.context.G.turn.currentPlayerId = 'other'
      new Script('renderTargetOverlay()').runInContext(result.context)
      expect(result.prompt.textContent).toBe('等待对方完成选择')
      expect(result.status.textContent).toBe('')
      new Script("setStatusMsg('本地尝试')").runInContext(result.context)
      expect(result.status.textContent).toBe('等待对方完成选择')

      result.context.G.pendingTargetSelection = null
      result.context.G.pendingOptionSelection = null
      new Script('renderTargetOverlay()').runInContext(result.context)
      expect(result.overlay.classList.contains('show')).toBe(false)
      expect(result.body.classList.contains('pending-response-waiting')).toBe(false)
      expect(result.controls.classList.contains('show')).toBe(false)
      expect(result.body.classList.contains('target-mode-active')).toBe(false)
    },
  )

  it('restores local target mode after an opponent pending session ends', () => {
    const result = renderContext('pendingTargetSelection')
    result.context.G.pendingTargetSelection = null
    result.context.pendingSkill = { skillId: 'skill-a', preparation: { targetType: 'piece' } }
    new Script('renderTargetOverlay()').runInContext(result.context)

    expect(result.overlay.classList.contains('show')).toBe(true)
    expect(result.controls.classList.contains('show')).toBe(true)
    expect(result.body.classList.contains('target-mode-active')).toBe(true)
    expect(result.body.classList.contains('pending-response-waiting')).toBe(false)
    expect(result.cancel.hidden).toBe(false)
    expect(result.cancel.disabled).toBe(false)
  })

  it('uses the same guidance in the action bar and updates it when turn ownership changes', () => {
    const result = actionBarContext()
    new Script('renderActionBar()').runInContext(result.context)
    expect(result.button.textContent).toBe('等待对方响应')
    expect(result.statuses.at(-1)).toBe('你的行动触发了对方响应，请等待对方完成选择')

    result.context.G.turn.currentPlayerId = 'other'
    new Script('renderActionBar()').runInContext(result.context)
    expect(result.button.textContent).toBe('等待对方响应')
    expect(result.statuses.at(-1)).toBe('等待对方完成选择')
  })

  it('derives continuation context from public card name and preparation title', () => {
    const context = createContext({
      cardsById: { 'holy-smite': { name: '圣光惩击' } },
      targetStepPrefix: (step: number) => step === 1 ? '第二步：' : '',
      targetTypeText: () => '选择一个目标',
    })
    new Script(source('localCardTargetPrompt')).runInContext(context)

    const firstStage = new Script(`localCardTargetPrompt(
      { cardId: 'holy-smite' },
      { continuation: true, step: 0, title: '圣铸进军：选择一名友方角色', canCancel: true },
      [],
    )`).runInContext(context)
    expect(firstStage).toBe('圣光惩击触发了圣铸进军：选择一名友方角色（可取消本次附加选择）')

    const secondStage = new Script(`localCardTargetPrompt(
      { cardId: 'holy-smite' },
      { continuation: true, step: 1, title: '圣铸进军：选择移动落点', canCancel: true },
      ['piece-1'],
    )`).runInContext(context)
    expect(secondStage).toBe('圣铸进军：选择移动落点（可取消本次附加选择）')

    const mandatory = new Script(`localCardTargetPrompt(
      { cardId: 'holy-smite' },
      { continuation: true, step: 1, title: '圣铸进军：选择移动落点', canCancel: false },
      ['piece-1'],
    )`).runInContext(context)
    expect(mandatory).toBe('圣铸进军：选择移动落点')

    const fallback = new Script(`localCardTargetPrompt(
      { pendingTargetIndex: 1, pendingTargetType: 'piece' },
      { step: 1, targetType: 'piece' },
      [],
    )`).runInContext(context)
    expect(fallback).toBe('第二步：选择一个目标')
  })
})
