/* eslint-disable @typescript-eslint/no-explicit-any -- the page controller runs in a minimal browser VM. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const battlePage = readFileSync(resolve('data/pages/battle.html'), 'utf8')

function readFunction(name: string, asynchronous = false) {
  const marker = `${asynchronous ? 'async ' : ''}function ${name}(`
  const start = battlePage.indexOf(marker)
  if (start < 0) throw new Error(`Missing ${name}`)
  const next = [
    battlePage.indexOf('\n    function ', start + marker.length),
    battlePage.indexOf('\n    async function ', start + marker.length),
  ].filter(index => index >= 0)
  const end = Math.min(...next)
  if (!Number.isFinite(end)) throw new Error(`Could not isolate ${name}`)
  return battlePage.slice(start, end)
}

function baseContext() {
  const statusMessages: string[] = []
  const clearTargetInteraction = vi.fn((reason: string) => {
    context.pendingSkill = null
    context.pendingCardAction = null
    context.pendingMove = false
    context.clearReasons.push(reason)
  })
  const doAction = vi.fn(async (action: unknown) => action)
  const context = createContext({
    G: { pieces: [{ instanceId: 'source', templateId: 'source' }], pendingTargetSelection: null, pendingOptionSelection: null },
    selectedPieceId: 'source',
    myPlayerId: 'player-a',
    pendingSkill: null,
    pendingCardAction: null,
    pendingMove: false,
    targetSubmissionPending: null,
    pendingActionFeedback: false,
    progressiveDeploymentPending: () => false,
    waitingForOtherPending: () => false,
    skillDefOf: () => ({ type: 'normal', name: '新技能' }),
    skillUsesCharge: () => false,
    resolveSkillAvailability: () => ({ available: true }),
    tutorialActionAllowed: () => true,
    clearTargetInteraction,
    clearReasons: [] as string[],
    setMoveButtonClass: vi.fn(),
    closePieceContextMenu: vi.fn(),
    renderBoard: vi.fn(),
    renderActionBar: vi.fn(),
    renderTargetOverlay: vi.fn(),
    setStatusMsg: (message: string) => statusMessages.push(message),
    statusMessages,
    _targetPromptText: () => '选择目标',
    cancelTargetSelection: vi.fn(),
    doAction,
  }) as unknown as Record<string, any>
  return { context, doAction, clearTargetInteraction }
}

describe('RED-227 skill preview selection switching', () => {
  it('promotes a hovered target preview on the first click instead of cancelling it', async () => {
    const h = baseContext()
    h.context.pendingSkill = {
      skillId: 'skill-target',
      previewOrigin: 'hover',
      previewOnly: false,
      baseAction: { type: 'useBasicSkill', pieceId: 'source', skillId: 'skill-target' },
    }
    new Script(readFunction('selectSkillCard', true)).runInContext(h.context)

    await new Script("selectSkillCard('skill-target')").runInContext(h.context)

    expect(h.context.pendingSkill.previewOrigin).toBe('click')
    expect(h.context.cancelTargetSelection).not.toHaveBeenCalled()
    expect(h.doAction).not.toHaveBeenCalled()
    expect(h.context.renderTargetOverlay).toHaveBeenCalledOnce()
  })

  it('formally releases a hovered no-target preview once on the first click', async () => {
    const h = baseContext()
    h.context.pendingSkill = {
      skillId: 'skill-no-target',
      previewOrigin: 'hover',
      previewOnly: true,
      baseAction: { type: 'useBasicSkill', pieceId: 'source', skillId: 'skill-no-target' },
    }
    new Script(readFunction('selectSkillCard', true)).runInContext(h.context)

    await new Script("selectSkillCard('skill-no-target')").runInContext(h.context)

    expect(h.context.clearReasons).toEqual(['skill-preview-clicked'])
    expect(h.doAction).toHaveBeenCalledOnce()
    expect(h.doAction.mock.calls[0][0]).toEqual({
      type: 'useBasicSkill',
      pieceId: 'source',
      skillId: 'skill-no-target',
    })
  })

  it('replaces a local hover preview with the latest skill and keeps the dock mounted', () => {
    const h = baseContext()
    const entered: unknown[] = []
    h.context.pendingSkill = {
      skillId: 'skill-old',
      previewOrigin: 'hover',
      previewOnly: false,
    }
    h.context.window = {
      BattleLegalActions: {
        probeSkillTarget: () => ({
          needsTarget: true,
          preparation: { kind: 'needTarget', selectionId: 's2', stateRevision: 2, candidates: [] },
        }),
      },
    }
    h.context.BattleLegalActions = h.context.window.BattleLegalActions
    h.context.GameEngine = {}
    h.context.skillsById = {}
    h.context.enterActionTargetMode = vi.fn((action: any, preparation: any, options: any) => {
      entered.push({ action, preparation, options })
      h.context.pendingSkill = { skillId: action.skillId, previewOrigin: 'hover', preparation }
      return true
    })
    h.context.window.refreshTargetSkillButtonState = vi.fn()
    new Script([readFunction('skillSelectionSwitchBlocked'), readFunction('previewSkillCard')].join('\n'))
      .runInContext(h.context)

    const result = new Script("previewSkillCard('skill-new')").runInContext(h.context)

    expect(result).toBe(true)
    expect(h.context.clearReasons).toEqual(['skill-hover-switch'])
    expect(h.context.pendingSkill).toMatchObject({ skillId: 'skill-new', previewOrigin: 'hover' })
    expect(entered).toHaveLength(1)
    expect((entered[0] as any).options).toEqual({ preserveDock: true })
    expect(h.context.window.refreshTargetSkillButtonState).toHaveBeenCalledOnce()
    expect(h.doAction).not.toHaveBeenCalled()
  })

  it('blocks hover replacement while an authoritative pending selection exists', () => {
    const h = baseContext()
    h.context.G.pendingTargetSelection = { selectionId: 'authority-1', canCancel: true }
    h.context.window = { BattleLegalActions: { probeSkillTarget: vi.fn() } }
    h.context.BattleLegalActions = h.context.window.BattleLegalActions
    h.context.GameEngine = {}
    h.context.skillsById = {}
    new Script([readFunction('skillSelectionSwitchBlocked'), readFunction('previewSkillCard')].join('\n'))
      .runInContext(h.context)

    const result = new Script("previewSkillCard('skill-new')").runInContext(h.context)

    expect(result).toBe(false)
    expect(h.context.clearTargetInteraction).not.toHaveBeenCalled()
    expect(h.context.BattleLegalActions.probeSkillTarget).not.toHaveBeenCalled()
  })
})
