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
    prepareLocalSkillAction: vi.fn(() => ({ status: 'ready' })),
    localSkillChoices: vi.fn(() => []),
    localSkillRootAction: vi.fn((skill: Record<string, any>) => skill.baseAction || {}),
    installLocalSkillDraft: vi.fn(() => false),
    localSkillInitialOptionPreparation: vi.fn(() => null),
    cancelTargetSelection: vi.fn(),
    doAction,
  }) as unknown as Record<string, any>
  return { context, doAction, clearTargetInteraction }
}

describe('RED-227 skill preview selection switching', () => {
  it.each(['click', 'drag', undefined])('keeps an activated target draft when hovering another skill (%s)', origin => {
    const h = baseContext()
    const draft = { skillId: 'skill-old', previewOrigin: origin, localChoiceDraft: true,
      preparation: { kind: 'needTarget' }, validTargets: new Set(['2,3']) }
    h.context.pendingSkill = draft
    h.context.prepareLocalSkillAction = vi.fn(() => ({ status: 'needs-input' }))
    new Script([readFunction('skillSelectionSwitchBlocked'), readFunction('previewSkillCard')].join('\n')).runInContext(h.context)
    expect(new Script("previewSkillCard('skill-new')").runInContext(h.context)).toBe(false)
    expect(h.context.pendingSkill).toBe(draft)
    expect(h.context.clearTargetInteraction).not.toHaveBeenCalled()
    expect(h.context.prepareLocalSkillAction).not.toHaveBeenCalled()
    expect(h.doAction).not.toHaveBeenCalled()
  })

  it('ends only the matching hover preview when leaving a skill card', () => {
    const h = baseContext()
    new Script([readFunction('skillSelectionSwitchBlocked'), readFunction('endSkillCardPreview')].join('\n')).runInContext(h.context)
    h.context.renderBoard = vi.fn()
    h.context.renderActionBar = vi.fn()
    for (const origin of ['click', 'drag']) {
      h.context.pendingSkill = { skillId: 'no-target', previewOnly: true, previewOrigin: origin }
      expect(new Script("endSkillCardPreview('no-target')").runInContext(h.context)).toBe(false)
    }
    h.context.pendingSkill = { skillId: 'no-target', previewOnly: true, previewOrigin: 'hover' }
    expect(new Script("endSkillCardPreview('other')").runInContext(h.context)).toBe(false)
    h.context.targetSubmissionPending = {}
    expect(new Script("endSkillCardPreview('no-target')").runInContext(h.context)).toBe(false)
    h.context.targetSubmissionPending = null
    expect(new Script("endSkillCardPreview('no-target')").runInContext(h.context)).toBe(true)
    expect(h.context.pendingSkill).toBeNull()
    expect(h.context.clearReasons).toEqual(['skill-hover-leave'])
  })

  it('promotes an existing hover draft before drag leaves the card', () => {
    const h = baseContext()
    const start = battlePage.indexOf('arm: context => {') + 'arm: '.length
    const end = battlePage.indexOf('\n        cellAt:', start)
    new Script([readFunction('skillSelectionSwitchBlocked'), readFunction('endSkillCardPreview'),
      'var arm = ' + battlePage.slice(start, end).trim().replace(/,$/, '')].join('\n')).runInContext(h.context)
    h.context.pendingSkill = { skillId: 'no-target', previewOnly: true, previewOrigin: 'hover' }
    expect(new Script("arm({pieceId: 'source', skillId: 'no-target'})").runInContext(h.context)).toBe(true)
    expect(h.context.pendingSkill.previewOrigin).toBe('drag')
    expect(new Script("endSkillCardPreview('no-target')").runInContext(h.context)).toBe(false)
    expect(h.context.clearReasons).toEqual([])
  })

  it('replays no-target hover after layout changes but never resurrects a cancelled draft', () => {
    const h = baseContext()
    const frames: Array<() => void> = []
    h.context.pendingSkill = { skillId: 'no-target', previewOnly: true, previewOrigin: 'hover' }
    h.context.hoverSkillPreviewReplayScheduled = false
    h.context.battlePageDisposed = false
    h.context.requestAnimationFrame = vi.fn((callback: () => void) => frames.push(callback))
    h.context.previewSkillTarget = vi.fn()
    new Script(readFunction('replayHoverSkillPreviewAfterViewport')).runInContext(h.context)

    new Script('replayHoverSkillPreviewAfterViewport(); replayHoverSkillPreviewAfterViewport()').runInContext(h.context)
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(h.context.previewSkillTarget).toHaveBeenCalledWith(null, null)

    h.context.previewSkillTarget.mockClear()
    new Script('replayHoverSkillPreviewAfterViewport()').runInContext(h.context)
    h.context.pendingSkill = null
    frames.shift()!()
    expect(h.context.previewSkillTarget).not.toHaveBeenCalled()
  })

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
    expect(h.context.prepareLocalSkillAction).toHaveBeenCalledOnce()
    expect(h.doAction.mock.calls[0][0]).toEqual({
      type: 'useBasicSkill',
      pieceId: 'source',
      skillId: 'skill-no-target',
    })
  })

  it('does not probe or enter target mode while hovering a declared-target skill', () => {
    const h = baseContext()
    h.context.pendingSkill = {
      skillId: 'skill-old',
      previewOrigin: 'hover',
      previewOnly: false,
    }
    h.context.window = {
      BattleLegalActions: {
        probeSkillTarget: vi.fn(() => ({ needsTarget: true })),
      },
    }
    h.context.BattleLegalActions = h.context.window.BattleLegalActions
    h.context.GameEngine = { preparePublicSkillAction: vi.fn() }
    h.context.skillsById = {}
    h.context.prepareLocalSkillAction = vi.fn(() => ({
      status: 'needs-input',
      preparation: { kind: 'needTarget', continuation: false },
    }))
    h.context.skillDefOf = vi.fn(() => ({
      type: 'normal',
      targeting: { steps: [{ kind: 'target', type: 'piece' }] },
    }))
    h.context.enterActionTargetMode = vi.fn()
    h.context.enterPreviewOnlySkillMode = vi.fn()
    new Script([readFunction('skillSelectionSwitchBlocked'), readFunction('previewSkillCard')].join('\n'))
      .runInContext(h.context)

    const result = new Script("previewSkillCard('skill-new')").runInContext(h.context)

    expect(result).toBe(false)
    expect(h.context.clearReasons).toEqual(['skill-hover-switch'])
    expect(h.context.pendingSkill).toBeNull()
    expect(h.context.BattleLegalActions.probeSkillTarget).not.toHaveBeenCalled()
    expect(h.context.prepareLocalSkillAction).toHaveBeenCalledOnce()
    expect(h.context.enterActionTargetMode).not.toHaveBeenCalled()
    expect(h.context.enterPreviewOnlySkillMode).not.toHaveBeenCalled()
    expect(h.doAction).not.toHaveBeenCalled()
  })

  it('allows a no-target hover to create only the local preview draft', () => {
    const h = baseContext()
    h.context.skillDefOf = vi.fn(() => ({
      type: 'normal',
      name: '新技能',
      targeting: { steps: [] },
    }))
    h.context.window = { BattleLegalActions: { probeSkillTarget: vi.fn(() => ({ needsTarget: false })) } }
    h.context.BattleLegalActions = h.context.window.BattleLegalActions
    h.context.GameEngine = { preparePublicSkillAction: vi.fn() }
    h.context.skillsById = {}
    h.context.prepareLocalSkillAction = vi.fn(() => ({ status: 'ready' }))
    h.context.enterPreviewOnlySkillMode = vi.fn(() => true)
    new Script([readFunction('skillSelectionSwitchBlocked'), readFunction('previewSkillCard')].join('\n'))
      .runInContext(h.context)

    const result = new Script("previewSkillCard('skill-new')").runInContext(h.context)

    expect(result).toBe(true)
    expect(h.context.enterPreviewOnlySkillMode).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: 'skill-new' }),
      expect.objectContaining({ type: 'normal' }),
      'hover',
    )
    expect(h.context.BattleLegalActions.probeSkillTarget).not.toHaveBeenCalled()
    expect(h.context.prepareLocalSkillAction).toHaveBeenCalledOnce()
  })

  it('prepares a root action before releasing an initially un-targeted skill', async () => {
    const h = baseContext()
    h.context.prepareLocalSkillAction = vi.fn(() => ({ status: 'ready' }))
    new Script(readFunction('selectSkillCard', true)).runInContext(h.context)

    await new Script("selectSkillCard('skill-no-target')").runInContext(h.context)

    expect(h.context.prepareLocalSkillAction).toHaveBeenCalledOnce()
    expect(h.context.installLocalSkillDraft).not.toHaveBeenCalled()
    expect(h.doAction).toHaveBeenCalledOnce()
  })

  it('installs a public root prompt before any authority submission', async () => {
    const h = baseContext()
    const preparation = {
      kind: 'needOption',
      continuation: false,
      source: { type: 'skill', id: 'skill-option', pieceId: 'source' },
      selectionId: 'root-option',
      stateRevision: 7,
      options: [{ label: 'First', value: 'first' }],
    }
    h.context.prepareLocalSkillAction = vi.fn(() => ({ status: 'needs-input', preparation }))
    h.context.installLocalSkillDraft = vi.fn(() => true)
    new Script(readFunction('selectSkillCard', true)).runInContext(h.context)

    await new Script("selectSkillCard('skill-option')").runInContext(h.context)

    expect(h.context.prepareLocalSkillAction).toHaveBeenCalledOnce()
    expect(h.context.installLocalSkillDraft).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: 'skill-option' }),
      expect.anything(),
      preparation,
      'click',
    )
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
