import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

function loadBrowserModule(relativePath: string, exportName: string) {
  const window: Record<string, unknown> = {}
  const context = createContext({ window, globalThis: window, console })
  const source = readFileSync(resolve(pagesDir, relativePath), 'utf8')
  new Script(source, { filename: relativePath }).runInContext(context)
  // Browser globals under test intentionally have no TypeScript declarations.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return window[exportName] as Record<string, any>
}

function fixtureSnapshot() {
  return {
    map: {
      id: 'test-map',
      width: 3,
      height: 2,
      tiles: [
        { id: '0,0', x: 0, y: 0, props: { type: 'floor', walkable: true } },
        { id: '1,0', x: 1, y: 0, props: { type: 'floor', walkable: true } },
      ],
    },
    pieces: [
      {
        instanceId: 'piece-red',
        templateId: 'red-warrior',
        name: 'Red Warrior',
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 0,
        y: 0,
        currentHp: 8,
        maxHp: 10,
        statusTags: [{ id: 'burn', name: 'Burn', stacks: 2, visible: true }],
      },
    ],
    players: [
      {
        playerId: 'player-red',
        name: 'A deliberately long tactical player name',
        actionPoints: 2,
        maxActionPoints: 3,
        chargePoints: 1,
        maxChargePoints: 4,
      },
    ],
    turn: { currentPlayerId: 'player-red', turnNumber: 2, phase: 'action', remainingSeconds: 89 },
    extensions: { tileEffects: [{ id: 'fire', tileType: 'amaterasu', x: 1, y: 0 }] },
  }
}

describe('battle presentation boundary', () => {
  it('projects training and relay snapshots through one source-agnostic view model', () => {
    const viewModel = loadBrowserModule('js/battle-ui/battle-view-model.js', 'BattleViewModel')
    const legal = {
      moveCells: new Set(['1,0']),
      targetCells: [{ x: 1, y: 0 }],
      placementCells: [],
    }
    const input = {
      snapshot: fixtureSnapshot(),
      viewerId: 'player-red',
      selectedPieceId: 'piece-red',
      interactionMode: 'move',
      legal,
    }

    const trainingModel = viewModel.create({ ...input, source: 'training' })
    const relayModel = viewModel.create({ ...input, source: 'relay' })

    expect(trainingModel).toEqual(relayModel)
    expect(trainingModel).toMatchObject({
      board: { id: 'test-map', width: 3, height: 2 },
      pieces: [
        {
          id: 'piece-red',
          x: 0,
          y: 0,
          faction: 'red',
          health: { current: 8, max: 10 },
          statusSummary: [{ id: 'burn', label: 'Burn', stacks: 2 }],
        },
      ],
      selection: { pieceId: 'piece-red', mode: 'move' },
      players: [{ name: 'A deliberately long tactical player name' }],
      turn: { remainingSeconds: 89 },
      legal: { moveCells: [{ x: 1, y: 0 }], targetCells: [{ x: 1, y: 0 }], placementCells: [] },
    })
  })

  it('projects the template-declared portrait asset for pieces added after training starts', () => {
    const viewModel = loadBrowserModule('js/battle-ui/battle-view-model.js', 'BattleViewModel')
    const snapshot = fixtureSnapshot()
    snapshot.pieces[0].templateId = 'red-training-piece'

    const model = viewModel.create({
      snapshot,
      source: 'training',
      viewerId: 'player-red',
      pieceTemplates: {
        'red-training-piece': { image: 'training-piece-portrait.webp' },
      },
    })

    expect(model.pieces[0]).toMatchObject({
      id: 'piece-red',
      templateId: 'red-training-piece',
      portraitId: 'training-piece-portrait.webp',
    })
  })

  it('projects all visible selected-piece statuses and never carries the previous selection forward', () => {
    const viewModel = loadBrowserModule('js/battle-ui/battle-view-model.js', 'BattleViewModel')
    const baseSnapshot = fixtureSnapshot()
    const snapshot = {
      ...baseSnapshot,
      pieces: [{
        ...baseSnapshot.pieces[0],
        buffs: [{ id: 'guard', name: 'Guard', currentDuration: 2, intensity: 1, visible: true }],
        debuffs: [{ id: 'slow', name: 'Slow', remainingDuration: 1, stacks: 1, visible: true }],
      }],
    }

    const selected = viewModel.create({
      snapshot,
      viewerId: 'player-red',
      selectedPieceId: 'piece-red',
      pieceTemplates: { 'red-warrior': { image: 'red-warrior.jpg' } },
    })

    expect(selected.selection.piece).toMatchObject({
      id: 'piece-red',
    })
    expect(selected.selection.piece).not.toHaveProperty('portraitSrc')
    expect(selected.selection.piece).not.toHaveProperty('stats')
    expect(selected.selection.piece).not.toHaveProperty('readOnly')
    expect(selected.selection.piece).not.toHaveProperty('skills')
    expect(selected.selection.piece.statuses.map((status: { id: string }) => status.id)).toEqual([
      'burn', 'guard', 'slow',
    ])
    expect(selected.selection.piece.statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'guard', duration: 2, intensity: 1 }),
      expect.objectContaining({ id: 'slow', duration: 1, stacks: 1 }),
    ]))

    const cleared = viewModel.create({
      snapshot,
      viewerId: 'player-red',
      selectedPieceId: 'missing-piece',
    })
    expect(cleared.selection).toMatchObject({ pieceId: null, piece: null })
  })

  it('keeps enemy visible statuses readable without projecting duplicate skill details', () => {
    const viewModel = loadBrowserModule('js/battle-ui/battle-view-model.js', 'BattleViewModel')
    const baseSnapshot = fixtureSnapshot()
    const snapshot = {
      ...baseSnapshot,
      pieces: [{
        ...baseSnapshot.pieces[0],
        ownerPlayerId: 'player-blue',
        debuffs: [{ id: 'slow', name: 'Slow', remainingDuration: 1, visible: true }],
      }],
    }

    const model = viewModel.create({
      snapshot,
      viewerId: 'player-red',
      selectedPieceId: 'piece-red',
    })

    expect(model.selection.piece).toMatchObject({ name: 'Red Warrior' })
    expect(model.selection.piece.statuses.map((status: { id: string }) => status.id)).toEqual(['burn', 'slow'])
    expect(model.selection.piece).not.toHaveProperty('skills')
  })

  it('keeps the DOM boundary focused on HUD and read-only selected status', () => {
    const domUi = loadBrowserModule('js/battle-ui/battle-dom-ui.js', 'BattleDomUI')
    const document = {
      getElementById: vi.fn(() => null),
    }
    const ui = domUi.create({ document })
    const model = {
      selection: {
        mode: 'inspect',
        piece: {
          id: 'piece-red',
          name: 'Red Warrior',
          statuses: [{ id: 'burn', label: 'Burn' }],
        },
      },
      turn: {
        currentPlayerId: 'player-red',
        isViewerTurn: true,
        number: 2,
        phase: 'action',
        remainingSeconds: 89,
      },
      players: [],
      viewer: null,
    }

    ui.update(model)

    expect(document.getElementById).toHaveBeenCalledWith('turnBadge')
    expect(document.getElementById).toHaveBeenCalledWith('playerResCards')
    expect(document.getElementById).not.toHaveBeenCalledWith('selectedPieceStatus')
  })


  it('renders every selected-piece status in a non-blocking overlay and hides it outside inspect mode', () => {
    const domUi = loadBrowserModule('js/battle-ui/battle-dom-ui.js', 'BattleDomUI')
    const overlay = {
      hidden: true,
      dataset: {} as Record<string, string>,
      innerHTML: '',
      setAttribute: vi.fn(),
    }
    const document = {
      getElementById: vi.fn((id: string) => id === 'selectedStatusOverlay' ? overlay : null),
    }
    const ui = domUi.create({ document })
    const model = {
      selection: {
        mode: 'inspect',
        piece: {
          id: 'piece-red',
          name: 'Red Warrior',
          statuses: [{ id: 'freeze', label: '冰冻', duration: 2, description: '无法行动' }],
        },
      },
      turn: {
        currentPlayerId: 'player-red',
        isViewerTurn: true,
        number: 2,
        phase: 'action',
        remainingSeconds: 89,
      },
      players: [],
      viewer: null,
    }

    ui.update(model)

    expect(document.getElementById).toHaveBeenCalledWith('selectedStatusOverlay')
    expect(overlay.hidden).toBe(false)
    expect(overlay.dataset.pieceId).toBe('piece-red')
    expect(overlay.innerHTML).toContain('Red Warrior')
    expect(overlay.innerHTML).toContain('冰冻')
    expect(overlay.innerHTML).toContain('2回合')
    expect(overlay.setAttribute).toHaveBeenCalledWith('aria-live', 'polite')

    ui.update({
      ...model,
      selection: { ...model.selection, mode: 'move' },
    })
    expect(overlay.hidden).toBe(true)
  })

  it('sends the identical model to Three.js and DOM and owns repeatable mount/dispose', () => {
    const presentation = loadBrowserModule('js/battle-ui/battle-presentation.js', 'BattlePresentation')
    const renderer = {
      init: vi.fn(),
      update: vi.fn(),
      resize: vi.fn(),
      resetView: vi.fn(),
      projectCell: vi.fn(() => ({ left: 20, top: 30 })),
      screenToCell: vi.fn(() => ({ x: 1, y: 0 })),
      dispose: vi.fn(),
      animateAction: vi.fn(),
    }
    const domUi = { update: vi.fn(), dispose: vi.fn() }
    const onIntent = vi.fn()
    const boundary = presentation.create({ renderer, domUi, onIntent })
    const mount = { boardContainer: {}, floatLayer: {} }
    const model = { board: { width: 3, height: 2 }, pieces: [], legal: {} }

    boundary.mount(mount)
    boundary.mount(mount)
    boundary.update(model)
    boundary.dispatch({ type: 'select-piece', pieceId: 'piece-red' })
    boundary.dispatch({ type: 'viewport-change' })
    boundary.resize()
    boundary.resetView()
    boundary.dispose()

    expect(renderer.dispose).toHaveBeenCalledTimes(2)
    expect(domUi.dispose).toHaveBeenCalledTimes(2)
    expect(renderer.update).toHaveBeenCalledWith(model)
    expect(domUi.update).toHaveBeenCalledWith(model)
    expect(onIntent).toHaveBeenCalledWith({ type: 'select-piece', pieceId: 'piece-red' })
    expect(onIntent).toHaveBeenCalledWith({ type: 'viewport-change' })
    expect(renderer.resetView).toHaveBeenCalledTimes(1)
    expect(boundary.projectCell(1, 0)).toEqual({ left: 20, top: 30 })
    expect(boundary.screenToCell(20, 30)).toEqual({ x: 1, y: 0 })
  })

  it('obtains move and target cells by probing the rule adapter instead of duplicating range math', () => {
    const legalActions = loadBrowserModule('js/battle-ui/battle-legal-actions.js', 'BattleLegalActions')
    const snapshot = fixtureSnapshot()
    const applyBattleAction = vi.fn((_state, action) => {
      if (action.type === 'move' && action.toX === 1 && action.toY === 0) {
        const next = structuredClone(_state)
        next.pieces[0].x = 1
        next.pieces[0].y = 0
        return next
      }
      if (action.type === 'move') return _state
      if (action.type === 'pendingTargetSelect' && action.targetX === 0 && action.targetY === 0) return _state
      throw new Error('rejected by rules')
    })
    const engine = {
      safeCloneBattleState: vi.fn((state) => structuredClone(state)),
      applyBattleAction,
    }

    const moves = legalActions.queryMoveCells({
      snapshot,
      playerId: 'player-red',
      pieceId: 'piece-red',
      engine,
    })
    const pendingTargets = legalActions.queryPendingTargetCells({
      snapshot: { ...snapshot, pendingTargetSelection: { playerId: 'player-red' } },
      playerId: 'player-red',
      engine,
    })

    expect(Array.from(moves)).toEqual(['1,0'])
    expect(Array.from(pendingTargets)).toEqual(['0,0'])
    expect(applyBattleAction).toHaveBeenCalled()
  })

  it('does not highlight a move when a rule returns normally but blocks movement', () => {
    const legalActions = loadBrowserModule('js/battle-ui/battle-legal-actions.js', 'BattleLegalActions')
    const snapshot = fixtureSnapshot()
    const engine = {
      getLegalNormalMoveTargetsForPlayer: vi.fn(() => [{ x: 1, y: 0 }]),
      safeCloneBattleState: (state: unknown) => structuredClone(state),
      applyBattleAction: vi.fn((state) => state),
    }

    const moves = legalActions.queryMoveCells({
      snapshot,
      playerId: 'player-red',
      pieceId: 'piece-red',
      engine,
    })

    expect(Array.from(moves)).toEqual([])
    expect(engine.getLegalNormalMoveTargetsForPlayer).toHaveBeenCalledWith(snapshot, 'player-red', 'piece-red')
  })

  it('does not treat a repeated same-step target request as a legal skill target', () => {
    const legalActions = loadBrowserModule('js/battle-ui/battle-legal-actions.js', 'BattleLegalActions')
    const snapshot = fixtureSnapshot()
    const validateSkillActionByDryRun = vi.fn((_state, action) => {
      const error = Object.assign(new Error('needs target'), {
        needsTargetSelection: true,
        targetIndex: action.targetX === 1 ? 1 : 0,
      })
      throw error
    })
    const targets = legalActions.querySkillTargetCells({
      snapshot,
      baseAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'piece-red', skillId: 'test' },
      targetIndex: 0,
      engine: {
        safeCloneBattleState: (state: unknown) => structuredClone(state),
        validateSkillActionByDryRun,
      },
    })

    expect(Array.from(targets)).toEqual(['1,0'])
  })

  it('uses rule-provided target metadata to avoid probing irrelevant empty cells', () => {
    const legalActions = loadBrowserModule('js/battle-ui/battle-legal-actions.js', 'BattleLegalActions')
    const snapshot = fixtureSnapshot()
    const validateSkillActionByDryRun = vi.fn(() => true)

    const targets = legalActions.querySkillTargetCells({
      snapshot,
      baseAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'piece-red', skillId: 'test' },
      targetType: 'piece',
      engine: {
        safeCloneBattleState: (state: unknown) => structuredClone(state),
        validateSkillActionByDryRun,
      },
    })

    expect(Array.from(targets)).toEqual(['0,0'])
    expect(validateSkillActionByDryRun).toHaveBeenCalledTimes(1)
  })

  it('keeps renderer and DOM responsibilities behind explicit modules', () => {
    const battlePage = readFileSync(resolve(pagesDir, 'battle.html'), 'utf8')
    const renderer = readFileSync(resolve(pagesDir, 'js/battle-renderer-3d.js'), 'utf8')

    expect(battlePage).toContain('js/battle-ui/battle-view-model.js')
    expect(battlePage).toContain('js/battle-ui/battle-legal-actions.js')
    expect(battlePage).toContain('js/battle-ui/battle-dom-ui.js')
    expect(battlePage).toContain('js/battle-ui/battle-presentation.js')
    expect(battlePage).toContain('dispatchBattleIntent')
    expect(battlePage).not.toMatch(/function _computeValidSkillTargetsHeuristic\b/)
    expect(battlePage).not.toMatch(/for \(const \[dx, dy\] of \[\[1,0\]/)
    expect(battlePage).not.toMatch(/(?:cardTargets|turnTargets|vt)\s*&&\s*(?:cardTargets|turnTargets|vt)\.size > 0/)
    expect(renderer).toMatch(/function init\b/)
    expect(renderer).toMatch(/function update\b/)
    expect(renderer).toMatch(/function resize\b/)
    expect(renderer).toMatch(/function resetView\b/)
    expect(renderer).toMatch(/function _preferredInitialZoom\b[\s\S]*?widthCoverageZoom/)
    expect(renderer.match(/_camera\.zoom = _preferredInitialZoom/g)).toHaveLength(2)
    expect(renderer).toMatch(/function projectCell\b/)
    expect(renderer).toMatch(/function screenToCell\b/)
    expect(renderer).toMatch(/function dispose\b/)
    expect(renderer).toContain("_renderer.domElement.getBoundingClientRect().width")
    expect(renderer).toMatch(/\(_camera\.right - _camera\.left\) \/ _camera\.zoom/)
    expect(renderer).not.toContain('syncState(G)')
    expect(renderer).toContain("_onIntent({ type: 'viewport-change' })")
    expect(renderer).not.toContain('_updateHpBarPositions')
    expect(() => new Script(renderer, { filename: 'battle-renderer-3d.js' })).not.toThrow()
  })
})
