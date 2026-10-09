/* eslint-disable @typescript-eslint/no-explicit-any -- battle.html runs in a browser VM. */
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

function renderScenario(input: {
  pendingSkill?: Record<string, unknown> | null
  pendingCardAction?: Record<string, unknown> | null
  targetSubmissionPending?: Record<string, unknown> | null
  authoritativeSelection?: Record<string, unknown> | null
  skillSheetVisible?: boolean
} = {}) {
  const overlay = element()
  const prompt = element()
  const summary = element()
  const confirm = element()
  const cancel = element()
  const controls = element()
  const modal = element()
  modal.classList.add('character-dock')
  modal.style.display = input.skillSheetVisible ? 'flex' : 'none'
  const skillButton = { dataset: { skillId: 'skill-a', targetMode: 'cancel' } }
  const body = { classList: classList() }
  if (input.skillSheetVisible) body.classList.add('character-dock-open')
  const elements: Record<string, ReturnType<typeof element>> = {
    targetOverlay: overlay,
    targetPromptText: prompt,
    targetMultiSummary: summary,
    targetConfirmButton: confirm,
    targetCancelButton: cancel,
    targetSelectionControls: controls,
    pieceInfoModal: modal,
  }
  const context = createContext({
    document: {
      body,
      getElementById: (id: string) => elements[id] || null,
      querySelectorAll: () => input.skillSheetVisible ? [skillButton] : [],
    },
    window: {},
    pendingSkill: input.pendingSkill === undefined
      ? { skillId: 'skill-a', preparation: { targetType: 'piece' } }
      : input.pendingSkill,
    pendingCardAction: input.pendingCardAction ?? null,
    targetSubmissionPending: input.targetSubmissionPending ?? null,
    pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [], selectedCells: [] },
    G: { pendingTargetSelection: input.authoritativeSelection ?? null, pendingOptionSelection: null },
    currentPieceInfoSource: 'board',
    closePieceContextMenu: () => undefined,
    placeTargetOverlayHost: () => undefined,
    targetStepPrefix: () => '',
    targetTypeText: () => '选择一个目标',
    isPendingBoardMultiTarget: () => false,
    pendingBoardMultiLimits: () => ({ min: 1, max: 1 }),
    pendingBoardMultiSummary: () => '',
  }) as unknown as Record<string, any>
  new Script([
    source('cardNeedsTarget'),
    source('_targetPromptText'),
    source('renderTargetOverlay'),
  ].join('\n')).runInContext(context)
  new Script('renderTargetOverlay()').runInContext(context)
  return { context, cancel, controls, body, prompt }
}

function cancellationContext(overrides: Record<string, unknown> = {}) {
  const doAction = vi.fn()
  const setStatusMsg = vi.fn()
  const clearTargetInteraction = vi.fn()
  const optionOverlay = { classList: { remove: vi.fn() } }
  const context = createContext(Object.assign({
    document: { getElementById: () => optionOverlay },
    G: {
      pendingTargetSelection: {
        playerId: 'player-red',
        selectionId: 'target-session-1',
        stateRevision: 17,
        canCancel: true,
      },
      pendingOptionSelection: null,
      pieces: [],
    },
    myPlayerId: 'player-red',
    pendingSkill: { skillId: 'skill-a' },
    pendingCardAction: null,
    pendingOptionAction: null,
    targetSubmissionPending: null,
    targetSubmissionDraft: null,
    moveDraft: null,
    pendingMove: false,
    selectedPieceId: null,
    pendingTargetSelectionForMe: () => true,
    pendingOptionSelectionForMe: () => false,
    cancelLocalCardContinuation: () => false,
    isLocalSkillDraft: () => false,
    doAction,
    clearTargetInteraction,
    renderTargetOverlay: vi.fn(),
    setMoveButtonClass: vi.fn(),
    renderBoard: vi.fn(),
    renderPieceContextMenu: vi.fn(),
    renderActionBar: vi.fn(),
    setStatusMsg,
  }, overrides)) as unknown as Record<string, any>
  new Script(source('cancelTargetSelection')).runInContext(context)
  return { context, doAction, setStatusMsg, clearTargetInteraction }
}

describe('RED-250 pending cancellation affordances', () => {
  it('keeps a shared explicit cancel button visible beside an active skill', () => {
    const result = renderScenario({ skillSheetVisible: true })

    expect(result.controls.classList.contains('show')).toBe(true)
    expect(result.cancel.hidden).toBe(false)
    expect(result.cancel.disabled).toBe(false)
  })

  it('still hides cancellation when the authoritative session forbids it', () => {
    const result = renderScenario({
      skillSheetVisible: true,
      authoritativeSelection: { selectionId: 'target-session-1', canCancel: false },
    })

    expect(result.cancel.hidden).toBe(true)
  })

  it('forwards the authoritative selection credentials exactly once', () => {
    const result = cancellationContext()

    new Script('cancelTargetSelection()').runInContext(result.context)

    expect(result.doAction).toHaveBeenCalledOnce()
    expect(result.doAction).toHaveBeenCalledWith({
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: 'target-session-1',
      stateRevision: 17,
    })
  })

  it('does not submit a second command while a target command is awaiting authority', () => {
    const result = cancellationContext({
      targetSubmissionPending: { clientActionId: 'action-1' },
    })

    new Script('cancelTargetSelection(); cancelTargetSelection()').runInContext(result.context)

    expect(result.doAction).not.toHaveBeenCalled()
    expect(result.setStatusMsg).toHaveBeenCalledWith('目标指令已提交，正在等待权威确认')
    expect(result.clearTargetInteraction).not.toHaveBeenCalled()
  })

  it('cancels a local skill draft without submitting an authority action', () => {
    const result = cancellationContext({
      G: { pendingTargetSelection: null, pendingOptionSelection: null, pieces: [] },
      pendingSkill: { skillId: 'skill-a', localChoiceDraft: true },
      pendingTargetSelectionForMe: () => false,
      isLocalSkillDraft: () => true,
    })

    new Script('cancelTargetSelection()').runInContext(result.context)

    expect(result.doAction).not.toHaveBeenCalled()
    expect(result.clearTargetInteraction).toHaveBeenCalledWith('user-cancelled')
  })
})
