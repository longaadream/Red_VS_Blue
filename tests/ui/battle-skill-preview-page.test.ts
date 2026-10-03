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
    'var targetSubmissionPending = null',
    'var G = null',
    'var selectedPieceId = "source"',
    'var myPlayerId = "player-a"',
    'var currentBattleViewModel = null',
    'var battlePageDisposed = false',
    'var skillPreviewController = null',
    'var skillPreviewReplayScheduled = false',
    'var skillPreviewReplayContext = null',
    'var skillPreviewReplayGeneration = 0',
    'var waitingForOtherPending = function () { return false }',
    'var skillSelectionSwitchBlocked = function () { return false }',
    'var clearTargetInteraction = function () { clearSkillPreview(); pendingSkill = null }',
    'var renderActionBar = function () {}',
    'var createBattlePresentationModel = function () { return null }',
    'var prepareCurrentBattlePresentationModel = function () { return currentBattleViewModel }',
    'var battlePresentation = { update: function () {} }',
    'var recalcCellSize = function () {}',
    'var _actionHasFirstTarget = function (action) { return !!(action && (action.targetPieceId || action.targetX != null || action.targetY != null)) }',
    readNamedFunction(html, '_targetPayloadFromCell'),
    readNamedFunction(html, '_appendTargetToAction'),
    readNamedFunction(html, 'invalidateSkillPreviewReplay'),
    readNamedFunction(html, 'clearSkillPreview'),
    readNamedFunction(html, 'skillPreviewAuthorityRevision'),
    readNamedFunction(html, 'skillPreviewPendingStateRevision'),
    readNamedFunction(html, 'skillPreviewHistoryViewActive'),
    readNamedFunction(html, 'skillPreviewReplayIsCurrent'),
    readNamedFunction(html, 'scheduleSkillPreviewReplayAfterRedraw'),
    readNamedFunction(html, 'previewSkillTarget'),
    readNamedFunction(html, 'endSkillCardPreview'),
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

describe('RED-224 battle page skill preview binding', () => {
  it('restores a stationary target preview after a pure board redraw', () => {
    const h = createHarness({ status: 'ready', snapshot: { revision: 8 }, events: [] })

    preview(h, 2, 3)
    h.renderer.showPreviewBoard.mockClear()

    new Script('renderBoard()', { filename: 'battle.html:renderBoard' }).runInContext(h.context as any)

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
