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
      { playerId: 'player-red', actionPoints: 2, maxActionPoints: 3, chargePoints: 1, maxChargePoints: 4 },
    ],
    turn: { currentPlayerId: 'player-red', turnNumber: 2, phase: 'action' },
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
      legal: { moveCells: [{ x: 1, y: 0 }], targetCells: [{ x: 1, y: 0 }], placementCells: [] },
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

  it('renders only special statuses and clears stale status content through the DOM boundary', () => {
    const domUi = loadBrowserModule('js/battle-ui/battle-dom-ui.js', 'BattleDomUI')
    const selectedPieceStatus = {
      className: '',
      textContent: '',
      innerHTML: '',
      dataset: {},
      setAttribute: vi.fn(),
      querySelectorAll: vi.fn(() => []),
    }
    const document = {
      getElementById: vi.fn((id: string) => id === 'selectedPieceStatus' ? selectedPieceStatus : null),
    }
    const ui = domUi.create({ document })
    const model = {
      selection: {
        mode: 'inspect',
        piece: {
          id: 'piece-red', name: 'Red Warrior', portraitSrc: 'images/red-warrior.jpg', readOnly: false,
          health: { current: 8, max: 10 }, stats: { attack: 4, defense: 2, moveRange: 3 },
          statuses: [{
            id: 'burn', label: 'Burn', description: 'Takes damage each turn.',
            stacks: 2, duration: 3, uses: 0, intensity: 0,
          }],
          skills: [{
            id: 'cooldown-skill', name: 'Cooling', description: 'Not ready.', icon: 'S',
            kind: 'active', type: 'normal', actionCost: 1, chargeCost: 0,
            cooldown: { current: 2, max: 3 }, available: false,
            unavailableReason: '冷却中（剩余 2 回合）',
          }],
        },
      },
      turn: { currentPlayerId: 'player-red', isViewerTurn: true, number: 2, phase: 'action' },
      players: [],
      viewer: null,
    }

    ui.update(model)

    expect(selectedPieceStatus.className).toContain('has-selection')
    expect(selectedPieceStatus.innerHTML).toContain('特殊状态')
    expect(selectedPieceStatus.innerHTML).toContain('Burn')
    expect(selectedPieceStatus.innerHTML).toContain('2 层')
    expect(selectedPieceStatus.innerHTML).toContain('剩余 3 回合')
    expect(selectedPieceStatus.innerHTML).toContain('Takes damage each turn.')
    expect(selectedPieceStatus.innerHTML).not.toContain('Red Warrior')
    expect(selectedPieceStatus.innerHTML).not.toContain('生命')
    expect(selectedPieceStatus.innerHTML).not.toContain('攻击')
    expect(selectedPieceStatus.innerHTML).not.toContain('Cooling')
    expect(selectedPieceStatus.innerHTML).not.toContain('selected-skill-item')
    expect(selectedPieceStatus.setAttribute).toHaveBeenCalledWith('aria-label', '特殊状态，共 1 个')

    model.selection.piece.statuses = []
    ui.update(model)

    expect(selectedPieceStatus.innerHTML).toContain('无特殊状态')
    expect(selectedPieceStatus.innerHTML).not.toContain('Burn')
  })

  it('sends the identical model to Three.js and DOM and owns repeatable mount/dispose', () => {
    const presentation = loadBrowserModule('js/battle-ui/battle-presentation.js', 'BattlePresentation')
    const renderer = {
      init: vi.fn(),
      update: vi.fn(),
      resize: vi.fn(),
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
    boundary.resize()
    boundary.dispose()

    expect(renderer.dispose).toHaveBeenCalledTimes(2)
    expect(domUi.dispose).toHaveBeenCalledTimes(2)
    expect(renderer.update).toHaveBeenCalledWith(model)
    expect(domUi.update).toHaveBeenCalledWith(model)
    expect(onIntent).toHaveBeenCalledWith({ type: 'select-piece', pieceId: 'piece-red' })
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
    expect(renderer).toMatch(/function projectCell\b/)
    expect(renderer).toMatch(/function screenToCell\b/)
    expect(renderer).toMatch(/function dispose\b/)
    expect(renderer).not.toContain('syncState(G)')
    expect(() => new Script(renderer, { filename: 'battle-renderer-3d.js' })).not.toThrow()
  })
})
