/* eslint-disable @typescript-eslint/no-explicit-any -- The page controller is exercised in a small browser VM. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

type PreviewHarness = {
  context: Record<string, any>
  renderer: Record<string, ReturnType<typeof vi.fn>>
  engine: { previewBattleAction: ReturnType<typeof vi.fn>; applyBattleAction: ReturnType<typeof vi.fn> }
  document: { badges: any[]; createElement: ReturnType<typeof vi.fn> }
  pendingSkill: Record<string, any>
  authority: Record<string, any>
  hypothetical: Record<string, any>
  transport: ReturnType<typeof vi.fn>
  skillPreviewDisplayTimings: any[]
  requestAnimationFrame: ReturnType<typeof vi.fn>
  flushNextAnimationFrame: () => void
  flushAnimationFrames: () => void
}

function readPage() {
  return readFileSync(resolve('data/pages/battle.html'), 'utf8')
}

function readNamedFunction(html: string, name: string) {
  const marker = `function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${name} in battle.html`)
  const nextFunction = html.indexOf('\n    function ', start + marker.length)
  if (nextFunction === -1) throw new Error(`Could not isolate ${name} in battle.html`)
  return html.slice(start, nextFunction)
}

function createHarness(
  result: Record<string, any> = { status: 'ready', snapshot: {} },
  options: { deferFrames?: boolean } = {},
): PreviewHarness {
  const html = readPage()
  const badges: any[] = []
  const bodyClasses = new Set<string>()
  const document = {
    badges,
    getElementById: vi.fn(() => null),
    createElement: vi.fn(() => {
      const badge = {
        className: '',
        hidden: false,
        textContent: '',
        attributes: new Map<string, string>(),
        setAttribute(name: string, value: string) {
          this.attributes.set(name, value)
        },
      }
      badges.push(badge)
      return badge
    }),
    body: {
      appendChild: vi.fn(),
      classList: {
        contains: (name: string) => bodyClasses.has(name),
        add: (name: string) => bodyClasses.add(name),
        remove: (name: string) => bodyClasses.delete(name),
      },
    },
  }
  const renderer = {
    clearPreviewBoard: vi.fn(),
    showPreviewBoard: vi.fn(),
    spawnFloater: vi.fn(),
    showPresentationPath: vi.fn(),
    showPresentationPaths: vi.fn(),
    setHistoryHighlight: vi.fn(),
  }
  const engine = {
    previewBattleAction: vi.fn(() => result),
    applyBattleAction: vi.fn(),
  }
  const hypothetical = {
    snapshot: true,
    pieces: [{ id: 'target', x: 2, y: 3 }],
    selection: { mode: 'hypothetical' },
    interaction: { pendingCommandId: 'hypothetical' },
    legal: { moveCells: [], targetCells: [{ x: 2, y: 3 }], placementCells: [] },
    interactionPieces: [],
  }
  const authority = {
    board: { tiles: [], width: 3, height: 3 },
    pieces: [{ id: 'target', x: 2, y: 3 }],
    selection: { mode: 'target', pieceId: 'source' },
    interaction: { pendingCommandId: 'authority-command' },
    legal: { moveCells: [], targetCells: [{ x: 2, y: 3 }], placementCells: [] },
  }
  const transport = vi.fn()
  const skillPreviewDisplayTimings: any[] = []
  const performance = { now: vi.fn(() => 0) }
  const frameQueue: Array<() => void> = []
  const requestAnimationFrame = vi.fn((callback: () => void) => {
    if (options.deferFrames) frameQueue.push(callback)
    else callback()
    return 1
  })
  const flushNextAnimationFrame = () => { frameQueue.shift()?.() }
  const flushAnimationFrames = () => {
    while (frameQueue.length) flushNextAnimationFrame()
  }
  const windowObject: Record<string, any> = {
    BattleRenderer3D: renderer,
  }
  const context = createContext({
    window: windowObject,
    globalThis: windowObject,
    document,
    console,
    Date,
    performance,
    requestAnimationFrame,
    skillPreviewDisplayTimings,
  }) as unknown as Record<string, any>
  new Script(readFileSync(resolve('data/pages/js/battle-ui/battle-skill-preview.js'), 'utf8'), {
    filename: 'battle-skill-preview.js',
  }).runInContext(context as any)
  const pendingSkill = {
    skillId: 'skill-a',
    baseAction: {
      type: 'useBasicSkill',
      playerId: 'player-a',
      pieceId: 'source',
      skillId: 'skill-a',
      stateRevision: 7,
    },
    preparation: { targetType: 'piece' },
    validTargets: new Set(['2,3']),
  }
  const game = {
    map: { tiles: [] },
    targetingRevision: 7,
    pieces: [
      { instanceId: 'source', x: 1, y: 1, currentHp: 8 },
      { instanceId: 'target', x: 2, y: 3, currentHp: 5 },
    ],
  }
  const script = [
    'var _use3d = true',
    'var pendingSkill = null',
    'var pendingCardAction = null',
    'var moveDraft = null',
    'var movePreviewVisible = false',
    'var targetSubmissionPending = null',
    'var G = null',
    'var selectedPieceId = "source"',
    'var myPlayerId = "player-a"',
    'var currentBattleViewModel = null',
    'var battlePageDisposed = false',
    'var deploymentHoverCell = null',
    'var updateDeploymentGhost = function () {}',
    'var skillPreviewController = null',
    'var hoverSkillPreviewReplayScheduled = false',
    'var skillPreviewReplayScheduled = false',
    'var skillPreviewReplayContext = null',
    'var skillPreviewReplayGeneration = 0',
    'var bindBattlePlayerAvatars = function () {}',
    'var waitingForOtherPending = function () { return false }',
    'var skillSelectionSwitchBlocked = function () { return false }',
    'var clearTargetInteraction = function () { clearSkillPreview(); pendingSkill = null; pendingCardAction = null }',
    'var renderActionBar = function () {}',
    'var createBattlePresentationModel = function () { return null }',
    'var prepareCurrentBattlePresentationModel = function () { return currentBattleViewModel }',
    'var battlePresentation = { update: function () {} }',
    'var recalcCellSize = function () {}',
    'var _actionHasFirstTarget = function (action) { return !!(action && (action.targetPieceId || action.targetX != null || action.targetY != null)) }',
    readNamedFunction(html, '_targetPayloadFromCell'),
    readNamedFunction(html, '_appendTargetToAction'),
    readNamedFunction(html, 'cloneLocalSkillValue'),
    readNamedFunction(html, 'cardNeedsTarget'),
    readNamedFunction(html, 'cardPreviewAction'),
    readNamedFunction(html, 'cardRootAction'),
    readNamedFunction(html, 'localCardSource'),
    readNamedFunction(html, 'localCardChoices'),
    readNamedFunction(html, 'localCardUsesRootInput'),
    readNamedFunction(html, 'localCardTargetChoice'),
    readNamedFunction(html, 'localCardBatchAction'),
    readNamedFunction(html, 'activeBattlePreviewDraft'),
    readNamedFunction(html, 'battlePreviewDraftAction'),
    readNamedFunction(html, 'invalidateSkillPreviewReplay'),
    readNamedFunction(html, 'clearSkillPreview'),
    readNamedFunction(html, 'renderResourcePreview'),
    readNamedFunction(html, 'clearMoveBoardPreview'),
    readNamedFunction(html, 'skillPreviewViewportCell'),
    readNamedFunction(html, 'skillPreviewAuthorityRevision'),
    readNamedFunction(html, 'skillPreviewPendingStateRevision'),
    readNamedFunction(html, 'skillPreviewHistoryViewActive'),
    readNamedFunction(html, 'skillPreviewReplayIsCurrent'),
    readNamedFunction(html, 'scheduleSkillPreviewReplayAfterRedraw'),
    readNamedFunction(html, 'replayHoverSkillPreviewAfterViewport'),
    readNamedFunction(html, 'previewSkillTarget'),
    readNamedFunction(html, 'endSkillCardPreview'),
    'var schedulePieceContextMenuPosition = function () {}',
    'var updateMoveHoverPath = function () {}',
    readNamedFunction(html, 'handleBattleIntent'),
    readNamedFunction(html, 'renderBoard'),
  ].join('\n')
  new Script(script, { filename: 'battle.html:skill-preview' }).runInContext(context as any)

  context.window = windowObject
  context.document = document
  context.GameEngine = engine
  context.BattleSkillPreview = windowObject.BattleSkillPreview
  context.doAction = transport
  context._use3d = true
  context.G = game
  context.pendingSkill = pendingSkill
  context.currentBattleViewModel = authority
  context.createBattlePresentationModel = vi.fn(() => structuredClone(hypothetical))

  return {
    context,
    renderer,
    engine,
    document,
    pendingSkill,
    authority,
    hypothetical,
    transport,
    skillPreviewDisplayTimings,
    requestAnimationFrame,
    flushNextAnimationFrame,
    flushAnimationFrames,
  }
}

function preview(harness: PreviewHarness, x: number | null, y: number | null) {
  return new Script(`previewSkillTarget(${x === null ? 'null' : x}, ${y === null ? 'null' : y})`)
    .runInContext(harness.context as any)
}

type CardClickHarness = {
  context: Record<string, any>
  prepare: ReturnType<typeof vi.fn>
  doAction: ReturnType<typeof vi.fn>
  submitTargetAction: ReturnType<typeof vi.fn>
  statusMessages: string[]
  renderTargetOverlay: ReturnType<typeof vi.fn>
}

function createCardClickHarness(preparation: Record<string, any> | null | Array<Record<string, any> | null>): CardClickHarness {
  const statusMessages: string[] = []
  const renderTargetOverlay = vi.fn()
  const doAction = vi.fn()
  const harness: { context: Record<string, any> | null } = { context: null }
  const submitTargetAction = vi.fn((action: Record<string, any>) => {
    harness.context!.targetSubmissionPending = {
      clientActionId: 'card-test-action',
      type: action.type,
      draft: harness.context!.targetSubmissionDraft,
    }
    harness.context!.targetSubmissionDraft = null
    doAction(action)
    return true
  })
  const preparationQueue = Array.isArray(preparation) ? preparation : [preparation]
  let preparationIndex = 0
  const prepare = vi.fn(() => {
    const current = preparationQueue[Math.min(preparationIndex++, preparationQueue.length - 1)]
    if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, 'status')) return current
    return current ? { status: 'needs-input', preparation: current } : { status: 'ready' }
  })
  const context = createContext({
    G: {
      turn: { currentPlayerId: 'player-a' },
      players: [{
        playerId: 'player-a', actionPoints: 5,
        hand: [{ cardId: 'card-a', instanceId: 'card-instance-a' }],
      }],
      pieces: [{ instanceId: 'target', x: 2, y: 3, currentHp: 5 }],
      pendingTargetSelection: null,
      pendingOptionSelection: null,
    },
    myPlayerId: 'player-a',
    cardsById: { 'card-a': { id: 'card-a', name: 'Card A', type: 'active', actionPointCost: 1 } },
    pendingCardAction: null,
    pendingSkill: null,
    pendingMove: false,
    targetSubmissionPending: null,
    targetSubmissionDraft: null,
    pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [], selectedCells: [] },
    pendingActionFeedback: null,
    ADVENTURE_MODE: false,
    TRAINING_MODE: false,
    SPECTATE_MODE: false,
    placingMode: false,
    selectedPieceId: null,
    isPendingHandSelection: () => false,
    progressiveDeploymentPending: () => false,
    tutorialActionAllowed: () => true,
    pendingOptionSelectionForOther: () => false,
    clearSkillPreview: vi.fn(),
    prepareLocalCardAction: undefined,
    setStatusMsg: (message: string) => statusMessages.push(message),
    setMoveButtonClass: vi.fn(),
    renderPieceContextMenu: vi.fn(),
    renderHand: vi.fn(),
    renderBoard: vi.fn(),
    renderActionBar: vi.fn(),
    renderTargetOverlay,
    previewSkillTarget: vi.fn(),
    doAction,
    submitTargetAction,
    refreshBattleLegalActions: vi.fn(),
    restoreTargetInteractionDraft: undefined,
    document: {
      body: {
        classList: {
          add: vi.fn(),
          remove: vi.fn(),
        },
      },
      getElementById: vi.fn(() => null),
    },
    currentTargetSourceName: () => 'Card A',
    window: {},
  }) as unknown as Record<string, any>
  harness.context = context
  context.GameEngine = { preparePublicSkillAction: prepare }
  const html = readPage()
  context.prepareLocalCardAction = undefined
  new Script([
    readNamedFunction(html, 'cloneLocalSkillValue'),
    readNamedFunction(html, '_actionHasFirstTarget'),
    readNamedFunction(html, '_appendTargetToAction'),
    readNamedFunction(html, 'clearCardPrimaryTarget'),
    readNamedFunction(html, 'cardNeedsTarget'),
    readNamedFunction(html, 'cardPreviewAction'),
    readNamedFunction(html, 'cardRootAction'),
    readNamedFunction(html, 'localCardSource'),
    readNamedFunction(html, 'localCardChoices'),
    readNamedFunction(html, 'localCardUsesRootInput'),
    readNamedFunction(html, 'localCardTargetChoice'),
    readNamedFunction(html, 'localCardBatchAction'),
    readNamedFunction(html, 'isLocalCardDraft'),
    readNamedFunction(html, 'cardCandidateSet'),
    readNamedFunction(html, 'normalizeLocalCardPreparation'),
    readNamedFunction(html, 'installLocalCardDraft'),
    readNamedFunction(html, 'renderLocalCardPreparation'),
    readNamedFunction(html, 'commitLocalCardAction'),
    readNamedFunction(html, 'continueLocalCardPreparation'),
    readNamedFunction(html, 'advanceLocalCardTarget'),
    readNamedFunction(html, 'snapshotTargetInteraction'),
    readNamedFunction(html, 'rememberTargetInteraction'),
    readNamedFunction(html, 'restoreTargetInteractionDraft'),
    readNamedFunction(html, 'releaseTargetSubmissionForRetry'),
    readNamedFunction(html, 'prepareCardTargetRetry'),
    readNamedFunction(html, 'prepareLocalCardAction'),
    readNamedFunction(html, 'targetTypeText'),
    readNamedFunction(html, 'targetStepPrefix'),
    readNamedFunction(html, 'onCardClick'),
  ].join('\n'), { filename: 'battle.html:card-click' }).runInContext(context as any)
  return { context, prepare, doAction, submitTargetAction, statusMessages, renderTargetOverlay }
}

type DeploymentGhostHarness = {
  context: Record<string, any>
  candidate: Record<string, any>
  images: any[]
  appendChild: ReturnType<typeof vi.fn>
  projectCell: ReturnType<typeof vi.fn>
}

function createDeploymentGhostHarness(): DeploymentGhostHarness {
  const candidate = {
    instanceId: 'reserve-1',
    templateId: 'hero-template',
    name: 'Hero',
    x: null,
    y: null,
  }
  const images: any[] = []
  const appendChild = vi.fn()
  const projectCell = vi.fn(() => ({ clientX: 128, clientY: 256 }))
  const document = {
    createElement: vi.fn((tagName: string) => {
      const attributes = new Map<string, string>()
      const image = {
        tagName,
        className: '',
        alt: '',
        hidden: true,
        src: '',
        style: { left: '', top: '' },
        onerror: null as null | (() => void),
        setAttribute(name: string, value: string) { attributes.set(name, value) },
        getAttribute(name: string) { return attributes.get(name) ?? null },
      }
      images.push(image)
      return image
    }),
    body: { appendChild },
  }
  const context = createContext({
    document,
    console,
    G: {
      deployment: {
        mode: 'progressive-reserve-v1',
        status: 'awaiting-reserve-deploy',
        activePlayerId: 'PLAYER-RED',
        offerPieces: [candidate],
        legalPositions: [{ x: 4, y: 2 }],
      },
    },
    myPlayerId: 'player-red',
    SPECTATE_MODE: false,
    pendingActionFeedback: null,
    localDeploymentChoiceId: 'reserve-1',
    PIECES_BY_ID: { 'hero-template': { image: 'hero.png' } },
    battlePresentation: { projectCell },
  }) as unknown as Record<string, any>
  const script = [
    'var deploymentHoverCell = null',
    'var deploymentGhost = null',
    'var presentedDeployment = function () { return G && G.deployment }',
    readNamedFunction(readPage(), 'updateDeploymentGhost'),
  ].join('\n')
  new Script(script, { filename: 'battle.html:updateDeploymentGhost' }).runInContext(context as any)
  return { context, candidate, images, appendChild, projectCell }
}

describe('RED-224 battle page skill preview binding', () => {
  it('restores a stationary target preview after a pure board redraw', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })

    preview(h, 2, 3)
    h.renderer.showPreviewBoard.mockClear()

    new Script('renderBoard()', { filename: 'battle.html:renderBoard' }).runInContext(h.context as any)

    expect(h.renderer.showPreviewBoard).toHaveBeenCalledOnce()
  })

  it('replays a stationary targeted preview after a viewport change', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })

    preview(h, 2, 3)
    h.flushAnimationFrames()
    h.renderer.showPreviewBoard.mockClear()

    new Script("handleBattleIntent({ type: 'viewport-change', hoveredCell: { x: 2, y: 3 } })", { filename: 'battle.html:viewport-change' })
      .runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).toHaveBeenCalledOnce()
  })

  it('replays a targeted preview against the pointer cell remapped by the viewport', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })
    h.pendingSkill.validTargets.add('1,2')
    h.context.G.pieces.push({ instanceId: 'target-b', x: 1, y: 2, currentHp: 5 })

    preview(h, 2, 3)
    h.flushAnimationFrames()
    h.renderer.showPreviewBoard.mockClear()
    h.engine.previewBattleAction.mockClear()

    new Script("handleBattleIntent({ type: 'viewport-change', hoveredCell: { x: 1, y: 2 } })", { filename: 'battle.html:viewport-remap' })
      .runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.engine.previewBattleAction).toHaveBeenCalledOnce()
    expect(h.engine.previewBattleAction.mock.calls[0][1]).toMatchObject({ targetPieceId: 'target-b' })
    expect(h.renderer.showPreviewBoard).toHaveBeenCalledOnce()
  })

  it('clears a targeted preview when a viewport change has no current pointer cell', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })

    preview(h, 2, 3)
    h.flushAnimationFrames()
    h.renderer.showPreviewBoard.mockClear()
    h.renderer.clearPreviewBoard.mockClear()
    const pendingBefore = h.context.pendingSkill

    new Script("handleBattleIntent({ type: 'viewport-change', hoveredCell: null })", { filename: 'battle.html:viewport-offboard' })
      .runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
    expect(h.renderer.clearPreviewBoard).toHaveBeenCalledOnce()
    expect(h.context.pendingSkill).toBe(pendingBefore)
  })

  it('does not resurrect a targeted preview after pointer leave before a viewport change', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })

    preview(h, 2, 3)
    h.flushAnimationFrames()
    h.context.pendingMove = false
    new Script("handleBattleIntent({ type: 'hover-cell', x: null, y: null })", { filename: 'battle.html:pointer-leave' })
      .runInContext(h.context as any)
    h.renderer.showPreviewBoard.mockClear()
    h.renderer.clearPreviewBoard.mockClear()

    new Script("handleBattleIntent({ type: 'viewport-change', hoveredCell: null })", { filename: 'battle.html:viewport-after-leave' })
      .runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
    expect(h.renderer.clearPreviewBoard).not.toHaveBeenCalled()
  })

  it('preserves a no-target hover preview across a viewport change', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })
    h.pendingSkill.previewOnly = true
    h.pendingSkill.previewEligible = true
    h.pendingSkill.previewOrigin = 'hover'

    preview(h, null, null)
    h.flushAnimationFrames()
    h.renderer.showPreviewBoard.mockClear()

    new Script("handleBattleIntent({ type: 'viewport-change' })", { filename: 'battle.html:viewport-hover' })
      .runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).toHaveBeenCalledOnce()
  })

  it('does not resurrect a preview after explicit cancel before redraw restoration', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })

    preview(h, 2, 3)
    h.flushNextAnimationFrame()
    h.renderer.showPreviewBoard.mockClear()
    new Script('renderBoard()', { filename: 'battle.html:renderBoard' }).runInContext(h.context as any)
    new Script('clearSkillPreview()', { filename: 'battle.html:clearSkillPreview' }).runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
  })

  it('does not resurrect a hover preview after card leave before redraw restoration', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })
    h.context.pendingSkill.previewOnly = true
    h.context.pendingSkill.previewEligible = true
    h.context.pendingSkill.previewOrigin = 'hover'

    preview(h, null, null)
    h.flushNextAnimationFrame()
    h.renderer.showPreviewBoard.mockClear()
    new Script('renderBoard()', { filename: 'battle.html:renderBoard' }).runInContext(h.context as any)
    new Script("endSkillCardPreview('skill-a')", { filename: 'battle.html:endSkillCardPreview' }).runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
  })

  it('does not restore a preview after history view activates before redraw restoration', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })

    preview(h, 2, 3)
    h.flushNextAnimationFrame()
    h.renderer.showPreviewBoard.mockClear()
    new Script('renderBoard()', { filename: 'battle.html:renderBoard' }).runInContext(h.context as any)
    h.context.document.body.classList.add('is-viewing-history')
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
  })

  it.each([
    ['a replaced authority snapshot', (h: PreviewHarness) => { h.context.G = { ...h.context.G, map: h.context.G.map } }],
    ['an in-place authority revision change', (h: PreviewHarness) => { h.context.G.targetingRevision += 1 }],
    ['a changed skill', (h: PreviewHarness) => {
      h.context.pendingSkill = { ...h.context.pendingSkill, skillId: 'skill-b', baseAction: { ...h.context.pendingSkill.baseAction, skillId: 'skill-b' } }
    }],
  ])('does not restore a stale preview after %s', (_label, change) => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] }, { deferFrames: true })

    preview(h, 2, 3)
    h.flushNextAnimationFrame()
    h.renderer.showPreviewBoard.mockClear()
    change(h)
    new Script('renderBoard()', { filename: 'battle.html:renderBoard' }).runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
  })

  it('previews only a legal root target through the real target payload helper', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })

    preview(h, 2, 3)

    expect(h.engine.previewBattleAction).toHaveBeenCalledOnce()
    expect(h.engine.previewBattleAction).toHaveBeenCalledWith(
      h.context.G,
      expect.objectContaining({
        type: 'useBasicSkill',
        targetPieceId: 'target',
      }),
      'player-a',
    )
    const action = h.engine.previewBattleAction.mock.calls[0][1]
    expect(action).not.toHaveProperty('targetX')
    expect(action).not.toHaveProperty('targetY')
    expect(h.pendingSkill.baseAction).not.toHaveProperty('targetPieceId')
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.engine.applyBattleAction).not.toHaveBeenCalled()
  })

  it('keeps a no-target preview root free of hovered coordinates', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })
    h.pendingSkill.previewOnly = true
    h.pendingSkill.previewEligible = true

    preview(h, 2, 3)

    expect(h.engine.previewBattleAction).toHaveBeenCalledOnce()
    const action = h.engine.previewBattleAction.mock.calls[0][1]
    expect(action).toMatchObject({
      type: 'useBasicSkill',
      pieceId: 'source',
      skillId: 'skill-a',
    })
    expect(action).not.toHaveProperty('targetPieceId')
    expect(action).not.toHaveProperty('targetX')
    expect(action).not.toHaveProperty('targetY')
    expect(h.transport).not.toHaveBeenCalled()
  })

  it('releases a no-target preview through one root action on board activation', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })
    h.pendingSkill.previewOnly = true
    Object.assign(h.context, {
      ADVENTURE_MODE: false,
      TRAINING_MODE: false,
      placingMode: false,
      selectedPieceId: 'source',
      pendingCardAction: null,
      pendingMove: false,
      refreshBattleLegalActions: vi.fn(),
      adventureOpenCell: vi.fn(() => false),
      pendingOptionSelectionForOther: vi.fn(() => false),
      skillDefOf: vi.fn(() => ({ type: 'normal' })),
      skillUsesCharge: vi.fn(() => false),
      renderBoard: vi.fn(),
      renderActionBar: vi.fn(),
      renderTargetOverlay: vi.fn(),
      setStatusMsg: vi.fn(),
    })
    new Script(readNamedFunction(readPage(), 'onCellClick'), { filename: 'battle.html:onCellClick' })
      .runInContext(h.context as any)

    new Script('onCellClick(2, 3)').runInContext(h.context as any)

    expect(h.transport).toHaveBeenCalledOnce()
    expect(h.transport.mock.calls[0][0]).toMatchObject({
      type: 'useBasicSkill',
      pieceId: 'source',
      skillId: 'skill-a',
    })
    expect(h.transport.mock.calls[0][0]).not.toHaveProperty('targetX')
    expect(h.transport.mock.calls[0][0]).not.toHaveProperty('targetY')
    expect(h.context.pendingSkill).toBeNull()
  })

  it('appends a legal target to an existing root without mutating the pending action', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })
    h.pendingSkill.baseAction.targetPieceId = 'first-target'
    h.pendingSkill.baseAction.extraTargets = [{ pieceId: 'already-selected' }]
    const originalExtraTargets = h.pendingSkill.baseAction.extraTargets

    preview(h, 2, 3)

    const action = h.engine.previewBattleAction.mock.calls[0][1]
    expect(action).toMatchObject({ targetPieceId: 'first-target' })
    expect(action.extraTargets).toEqual([
      { pieceId: 'already-selected' },
      { pieceId: 'target', x: 2, y: 3 },
    ])
    expect(action.extraTargets).not.toBe(originalExtraTargets)
    expect(h.pendingSkill.baseAction.extraTargets).toBe(originalExtraTargets)
    expect(h.pendingSkill.baseAction.extraTargets).toEqual([{ pieceId: 'already-selected' }])
    expect(h.transport).not.toHaveBeenCalled()
  })

  it.each([
    ['outside the authoritative target set', 9, 9],
    ['a leave target with no cell', null, null],
  ])('does not compute %s, clears the previous preview, and keeps pending skill state', (_label, x, y) => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })
    preview(h, 2, 3)
    h.engine.previewBattleAction.mockClear()
    h.renderer.clearPreviewBoard.mockClear()
    const pendingBefore = h.context.pendingSkill

    preview(h, x, y)

    expect(h.engine.previewBattleAction).not.toHaveBeenCalled()
    expect(h.renderer.clearPreviewBoard).toHaveBeenCalledOnce()
    expect(h.context.pendingSkill).toBe(pendingBefore)
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.engine.applyBattleAction).not.toHaveBeenCalled()
  })

  it('renders a ready hypothetical model while reusing authority interaction input', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })
    const factory = h.context.createBattlePresentationModel as ReturnType<typeof vi.fn>

    preview(h, 2, 3)

    const predicted = factory.mock.results[0].value
    expect(factory).toHaveBeenCalledWith({ revision: 8 })
    expect(predicted.selection).toBe(h.authority.selection)
    expect(predicted.interaction).toBe(h.authority.interaction)
    expect(predicted.legal).toBe(h.authority.legal)
    expect(predicted.interactionPieces).toBe(h.authority.pieces)
    expect(h.renderer.showPreviewBoard).toHaveBeenCalledWith(predicted, h.authority)
    expect(h.renderer.spawnFloater).not.toHaveBeenCalled()
    expect(h.skillPreviewDisplayTimings).toEqual([{ durationMs: 0, nextFrameMs: 0 }])
    expect(h.requestAnimationFrame).toHaveBeenCalledOnce()
  })

  it('groups every preview presentation path into one renderer batch', () => {
    const h = createHarness({
      status: 'ready',
      snapshot: { revision: 8 },
      events: [
        { presentation: { pathCells: [{ x: 1, y: 1 }, { x: 2, y: 2 }], endPoint: { x: 2, y: 2 } } },
        { presentation: { pathCells: [{ x: 2, y: 2 }, { x: 3, y: 2 }], endPoint: { x: 3, y: 2 } } },
        { presentation: { pathCells: [{ x: 1, y: 1 }, { x: 1, y: 3 }], endPoint: { x: 1, y: 3 } } },
      ],
    })

    preview(h, 2, 3)

    expect(h.renderer.showPresentationPaths).toHaveBeenCalledOnce()
    expect(h.renderer.showPresentationPaths.mock.calls[0][0]).toHaveLength(3)
    expect(h.renderer.showPresentationPath).not.toHaveBeenCalled()
  })

  it('does not compute a multi-target pending skill and clears any existing preview', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })
    preview(h, 2, 3)
    h.engine.previewBattleAction.mockClear()
    h.renderer.clearPreviewBoard.mockClear()
    h.pendingSkill.preparation.selectionMode = 'multi'
    const pendingBefore = h.context.pendingSkill

    preview(h, 2, 3)

    expect(h.engine.previewBattleAction).not.toHaveBeenCalled()
    expect(h.renderer.clearPreviewBoard).toHaveBeenCalledOnce()
    expect(h.context.pendingSkill).toBe(pendingBefore)
    expect(h.skillPreviewDisplayTimings).toHaveLength(1)
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.engine.applyBattleAction).not.toHaveBeenCalled()
  })

  it('shows an unavailable notice without fabricating a hypothetical renderer state', () => {
    const h = createHarness({ status: 'unavailable', reason: 'unsupported' })
    const factory = h.context.createBattlePresentationModel as ReturnType<typeof vi.fn>

    preview(h, 2, 3)

    expect(h.document.badges).toHaveLength(1)
    expect(h.document.badges[0].textContent).toBe('此效果暂不预演')
    expect(factory).not.toHaveBeenCalled()
    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
    expect(h.renderer.spawnFloater).not.toHaveBeenCalled()
    expect(h.renderer.showPresentationPath).not.toHaveBeenCalled()
    expect(h.renderer.setHistoryHighlight).not.toHaveBeenCalled()
    expect(h.context.pendingSkill).toBe(h.pendingSkill)
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.engine.applyBattleAction).not.toHaveBeenCalled()
  })

  it('restores an unavailable notice after a pure board redraw', () => {
    const h = createHarness({ status: 'unavailable', reason: 'unsupported' })

    preview(h, 2, 3)
    h.renderer.clearPreviewBoard.mockClear()
    new Script('renderBoard()', { filename: 'battle.html:renderBoard' }).runInContext(h.context as any)

    expect(h.document.badges).toHaveLength(1)
    expect(h.document.badges[0].hidden).toBe(false)
    expect(h.document.badges[0].textContent).toBe('此效果暂不预演')
    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
  })
})

describe('RED-241 hand card preview binding', () => {
  it('prepares a targeted card locally and keeps transport untouched until a board target', () => {
    const preparation = {
      kind: 'needTarget',
      selectionId: 'card-selection',
      stateRevision: 8,
      step: 0,
      targetType: 'piece',
      filter: 'enemy',
      candidates: [{ type: 'piece', pieceId: 'target' }],
    }
    const h = createCardClickHarness(preparation)

    new Script("onCardClick('card-instance-a', 'card-a')", { filename: 'battle.html:card-first-click' })
      .runInContext(h.context as any)

    expect(h.prepare).toHaveBeenCalledWith(
      h.context.G,
      { type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a' },
      'player-a',
    )
    expect(h.context.pendingCardAction).toMatchObject({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      pendingTargetIndex: 0, pendingTargetType: 'piece',
      selectionId: 'card-selection', stateRevision: 8,
    })
    expect(Array.from(h.context.pendingCardAction.validTargets)).toEqual(['2,3'])
    expect(h.doAction).not.toHaveBeenCalled()
    expect(h.renderTargetOverlay).toHaveBeenCalled()
  })

  it('keeps a deterministic two-target card local until both targets are prepared', () => {
    const h = createCardClickHarness([
      {
        kind: 'needTarget', selectionId: 'card-selection', stateRevision: 8, step: 0,
        targetType: 'piece', filter: 'ally', candidates: [{ type: 'piece', pieceId: 'target' }],
      },
      {
        kind: 'needTarget', selectionId: 'card-selection', stateRevision: 8, step: 1,
        targetType: 'cell', filter: 'all', candidates: [{ type: 'cell', x: 4, y: 4 }],
      },
      null,
    ])

    new Script("onCardClick('card-instance-a', 'card-a')", { filename: 'battle.html:card-multi-first' })
      .runInContext(h.context as any)
    const firstDraft = h.context.pendingCardAction
    expect(firstDraft.localCardDraft).toBe(true)
    expect(firstDraft.rootAction).not.toHaveProperty('targetPieceId')

    new Script([
      readNamedFunction(readPage(), '_targetPayloadFromCell'),
      readNamedFunction(readPage(), 'onCellClick'),
    ].join('\n'), { filename: 'battle.html:card-multi-target-one' }).runInContext(h.context as any)
    new Script('onCellClick(2, 3)').runInContext(h.context as any)

    expect(h.submitTargetAction).not.toHaveBeenCalled()
    expect(h.context.pendingCardAction.rootAction).toMatchObject({ targetPieceId: 'target' })
    expect(h.context.pendingCardAction.preparation).toMatchObject({ step: 1, targetType: 'cell' })
    expect(Array.from(h.context.pendingCardAction.validTargets)).toEqual(['4,4'])

    new Script('onCellClick(4, 4)').runInContext(h.context as any)

    expect(h.prepare).toHaveBeenCalledTimes(3)
    expect(h.submitTargetAction).toHaveBeenCalledOnce()
    expect(h.submitTargetAction.mock.calls[0][0]).toEqual({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      selectionId: 'card-selection', stateRevision: 8,
      targetPieceId: 'target', targetX: 2, targetY: 3,
      extraTargets: [{ x: 4, y: 4 }],
    })
    expect(h.context.pendingCardAction).toBeNull()
  })

  it('falls back to one guarded authority submission when a legal card continuation is unavailable', () => {
    const h = createCardClickHarness([
      {
        kind: 'needTarget', selectionId: 'card-selection', stateRevision: 8, step: 0,
        targetType: 'piece', filter: 'enemy', candidates: [{ type: 'piece', pieceId: 'target' }],
      },
      { status: 'unavailable', reason: 'dynamic-effect' },
    ])

    new Script("onCardClick('card-instance-a', 'card-a')", { filename: 'battle.html:card-unavailable-first' })
      .runInContext(h.context as any)
    new Script([
      readNamedFunction(readPage(), '_targetPayloadFromCell'),
      readNamedFunction(readPage(), 'onCellClick'),
    ].join('\n'), { filename: 'battle.html:card-unavailable-target' }).runInContext(h.context as any)
    new Script('onCellClick(2, 3)', { filename: 'battle.html:card-unavailable-cell' }).runInContext(h.context as any)

    expect(h.prepare).toHaveBeenCalledTimes(2)
    expect(h.submitTargetAction).toHaveBeenCalledOnce()
    expect(h.submitTargetAction.mock.calls[0][0]).toEqual({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      selectionId: 'card-selection', stateRevision: 8,
      targetPieceId: 'target', targetX: 2, targetY: 3,
    })
    expect(h.context.pendingCardAction).toBeNull()
  })

  it('previews a ready no-target card without target UI or hovered coordinates', () => {
    const h = createCardClickHarness(null)

    new Script("onCardClick('card-instance-a', 'card-a')", { filename: 'battle.html:card-no-target' })
      .runInContext(h.context as any)

    expect(h.context.pendingCardAction).toMatchObject({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      previewOnly: true, previewOrigin: 'click',
    })
    expect(h.context.previewSkillTarget).toHaveBeenCalledWith(null, null)
    expect(h.doAction).not.toHaveBeenCalled()
  })

  it('submits a confirmed no-target card through the guarded retry path without coordinates', () => {
    const h = createCardClickHarness(null)

    new Script("onCardClick('card-instance-a', 'card-a')", { filename: 'battle.html:card-no-target-first' })
      .runInContext(h.context as any)
    new Script("onCardClick('card-instance-a', 'card-a')", { filename: 'battle.html:card-no-target-confirm' })
      .runInContext(h.context as any)

    expect(h.submitTargetAction).toHaveBeenCalledOnce()
    expect(h.submitTargetAction.mock.calls[0][0]).toEqual({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
    })
    expect(h.submitTargetAction.mock.calls[0][0]).not.toHaveProperty('targetX')
    expect(h.submitTargetAction.mock.calls[0][0]).not.toHaveProperty('targetY')
    expect(h.context.pendingCardAction).toBeNull()
    expect(h.context.targetSubmissionPending).toMatchObject({
      type: 'playCard',
      draft: { card: { type: 'playCard', cardInstanceId: 'card-instance-a', previewOnly: true } },
    })

    const released = new Script('releaseTargetSubmissionForRetry(targetSubmissionPending)', {
      filename: 'battle.html:card-no-target-rejected',
    }).runInContext(h.context as any)
    expect(released).toBe(true)
    expect(h.context.pendingCardAction).toMatchObject({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      previewOnly: true, previewOrigin: 'click',
    })
  })

  it('uses the shared preview controller for legal card hover and clears illegal hover without mutating the draft', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 9 }, events: [] })
    h.context.pendingSkill = null
    h.context.pendingCardAction = {
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      cardId: 'card-a', selectionId: 'selection', stateRevision: 7,
      previewOrigin: 'click',
      preparation: {
        kind: 'needTarget', targetType: 'piece', filter: 'enemy',
        candidates: [{ type: 'piece', pieceId: 'target' }],
      },
      validTargets: new Set(['2,3']),
    }
    const draft = h.context.pendingCardAction

    preview(h, 2, 3)

    expect(h.engine.previewBattleAction).toHaveBeenCalledWith(
      h.context.G,
      expect.objectContaining({
        type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
        targetPieceId: 'target',
      }),
      'player-a',
    )
    const previewAction = h.engine.previewBattleAction.mock.calls[0][1]
    expect(previewAction).not.toHaveProperty('cardId')
    expect(previewAction).not.toHaveProperty('preparation')
    expect(previewAction).not.toHaveProperty('validTargets')
    expect(h.transport).not.toHaveBeenCalled()

    h.engine.previewBattleAction.mockClear()
    h.renderer.clearPreviewBoard.mockClear()
    preview(h, 9, 9)

    expect(h.engine.previewBattleAction).not.toHaveBeenCalled()
    expect(h.renderer.clearPreviewBoard).toHaveBeenCalledOnce()
    expect(h.context.pendingCardAction).toBe(draft)
    expect(h.context.pendingCardAction).not.toHaveProperty('targetPieceId')
  })

  it('keeps a targeted card preview replayable across redraw, but drops a stale cancelled draft', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 9 }, events: [] }, { deferFrames: true })
    h.context.pendingSkill = null
    h.context.pendingCardAction = {
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      selectionId: 'selection', stateRevision: 7, previewOrigin: 'click',
      preparation: { kind: 'needTarget', targetType: 'piece', candidates: [{ type: 'piece', pieceId: 'target' }] },
      validTargets: new Set(['2,3']),
    }
    preview(h, 2, 3)
    h.flushAnimationFrames()
    h.renderer.showPreviewBoard.mockClear()

    new Script('renderBoard()', { filename: 'battle.html:card-redraw' }).runInContext(h.context as any)
    h.context.pendingCardAction = null
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).not.toHaveBeenCalled()
    expect(h.transport).not.toHaveBeenCalled()
  })

  it('replays a targeted card preview after a scheduled board redraw', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 9 }, events: [] }, { deferFrames: true })
    h.context.pendingSkill = null
    h.context.pendingCardAction = {
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      selectionId: 'selection', stateRevision: 7, previewOrigin: 'click',
      preparation: { kind: 'needTarget', targetType: 'piece', candidates: [{ type: 'piece', pieceId: 'target' }] },
      validTargets: new Set(['2,3']),
    }

    preview(h, 2, 3)
    h.flushAnimationFrames()
    h.renderer.showPreviewBoard.mockClear()
    h.engine.previewBattleAction.mockClear()

    new Script('renderBoard()', { filename: 'battle.html:card-redraw-targeted' }).runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).toHaveBeenCalledOnce()
    const diagnostics = new Script('skillPreviewController.getDiagnostics()').runInContext(h.context as any)
    expect(diagnostics.requestCount).toBe(2)
    expect(JSON.parse(diagnostics.requests.at(-1).key)).toMatchObject({
      type: 'playCard', cardInstanceId: 'card-instance-a', targetPieceId: 'target',
    })
  })

  it('replays a no-target card preview after a scheduled board redraw without adding a target', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 9 }, events: [] }, { deferFrames: true })
    h.context.pendingSkill = null
    h.context.pendingCardAction = {
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      stateRevision: 7, previewOnly: true, previewEligible: true, previewOrigin: 'click',
    }

    preview(h, null, null)
    h.flushAnimationFrames()
    h.renderer.showPreviewBoard.mockClear()
    h.engine.previewBattleAction.mockClear()

    new Script('renderBoard()', { filename: 'battle.html:card-redraw-no-target' }).runInContext(h.context as any)
    h.flushAnimationFrames()

    expect(h.renderer.showPreviewBoard).toHaveBeenCalledOnce()
    const diagnostics = new Script('skillPreviewController.getDiagnostics()').runInContext(h.context as any)
    expect(diagnostics.requestCount).toBe(2)
    const replayAction = JSON.parse(diagnostics.requests.at(-1).key)
    expect(replayAction).toEqual({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a', stateRevision: 7,
    })
    expect(replayAction).not.toHaveProperty('targetX')
    expect(replayAction).not.toHaveProperty('targetY')
    expect(h.renderer.showPreviewBoard).toHaveBeenCalledOnce()
  })

  it('submits one sanitized targeted card action when a legal cell is activated', () => {
    const h = createCardClickHarness([{
      kind: 'needTarget', selectionId: 'selection', stateRevision: 8, step: 0,
      targetType: 'piece', filter: 'enemy', candidates: [{ type: 'piece', pieceId: 'target' }],
    }, null])
    new Script("onCardClick('card-instance-a', 'card-a')", { filename: 'battle.html:card-target-prep' })
      .runInContext(h.context as any)
    h.submitTargetAction.mockClear()

    new Script([
      readNamedFunction(readPage(), '_targetPayloadFromCell'),
      readNamedFunction(readPage(), 'onCellClick'),
    ].join('\n'), { filename: 'battle.html:card-target-submit' }).runInContext(h.context as any)
    new Script('onCellClick(2, 3)', { filename: 'battle.html:card-target-cell' }).runInContext(h.context as any)

    expect(h.submitTargetAction).toHaveBeenCalledOnce()
    expect(h.submitTargetAction.mock.calls[0][0]).toEqual({
      type: 'playCard', playerId: 'player-a', cardInstanceId: 'card-instance-a',
      selectionId: 'selection', stateRevision: 8, targetPieceId: 'target', targetX: 2, targetY: 3,
    })
    expect(h.context.pendingCardAction).toBeNull()
  })
})

describe('RED-241 deployment placement ghost binding', () => {
  it('renders the selected private candidate on an authoritative legal cell without writing coordinates', () => {
    const h = createDeploymentGhostHarness()
    const before = structuredClone(h.candidate)

    new Script('updateDeploymentGhost(4, 2)').runInContext(h.context as any)

    expect(h.appendChild).toHaveBeenCalledOnce()
    expect(h.images).toHaveLength(1)
    expect(h.images[0]).toMatchObject({
      className: 'deployment-placement-ghost',
      alt: '',
      hidden: false,
      src: 'images/hero.png',
      style: { left: '128px', top: '256px' },
    })
    expect(h.images[0].getAttribute('aria-hidden')).toBe('true')
    expect(h.projectCell).toHaveBeenCalledWith(4, 2, 0.15)
    expect(h.candidate).toEqual(before)
  })

  it('keeps the ghost private to the active owner and hides it for an opponent or spectator', () => {
    const h = createDeploymentGhostHarness()

    new Script('updateDeploymentGhost(4, 2)').runInContext(h.context as any)
    expect(h.images[0].hidden).toBe(false)

    h.context.myPlayerId = 'player-blue'
    new Script('updateDeploymentGhost(4, 2)').runInContext(h.context as any)
    expect(h.images[0].hidden).toBe(true)

    h.context.myPlayerId = 'player-red'
    h.context.SPECTATE_MODE = true
    new Script('updateDeploymentGhost(4, 2)').runInContext(h.context as any)
    expect(h.images[0].hidden).toBe(true)
    expect(h.projectCell).toHaveBeenCalledOnce()
  })

  it('hides an existing ghost when the pointer leaves the board without changing the candidate', () => {
    const h = createDeploymentGhostHarness()
    const before = structuredClone(h.candidate)

    new Script('updateDeploymentGhost(4, 2)').runInContext(h.context as any)
    new Script('updateDeploymentGhost(null, null)').runInContext(h.context as any)

    expect(h.images[0].hidden).toBe(true)
    expect(h.projectCell).toHaveBeenCalledOnce()
    expect(h.candidate).toEqual(before)
  })
})
