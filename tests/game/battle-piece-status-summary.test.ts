import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

function loadBrowserModule(relativePath: string, exportName: string, window: Record<string, unknown> = {}) {
  const context = createContext({ window, globalThis: window, console })
  const source = readFileSync(resolve(pagesDir, relativePath), 'utf8')
  new Script(source, { filename: relativePath }).runInContext(context)
  // Browser globals under test intentionally have no TypeScript declarations.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return window[exportName] as Record<string, any>
}

function fixtureSnapshot(statusTags: Array<Record<string, unknown>>) {
  return {
    map: { id: 'large-battlefield', width: 20, height: 16, tiles: [] },
    pieces: [{
      instanceId: 'piece-red',
      templateId: 'red-warrior',
      name: 'Red Warrior',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 9,
      y: 7,
      currentHp: 8,
      maxHp: 12,
      statusTags,
    }],
    players: [{ playerId: 'player-red' }],
    turn: { currentPlayerId: 'player-red', turnNumber: 2, phase: 'action' },
  }
}

describe('battle piece health and negative-status summary', () => {
  it('keeps every authoritative status in detail while selecting at most two negative summaries', () => {
    const window: Record<string, unknown> = {}
    const statusPresentation = loadBrowserModule(
      'js/battle-ui/battle-status-presentation.js',
      'BattleStatusPresentation',
      window,
    )
    const viewModel = loadBrowserModule('js/battle-ui/battle-view-model.js', 'BattleViewModel', window)
    const rawStatuses = [
      { id: 'bleeding-1', type: 'bleeding', name: 'Bleeding', remainingDuration: 2, stacks: 3, visible: true },
      { id: 'calm-shield-1', type: 'calm-shield', name: 'Calm Shield', currentDuration: 2, stacks: 1, visible: true },
      { id: 'anti-heal-1', type: 'anti-heal', name: 'Anti-heal', duration: 3, stacks: 1, visible: true },
      { id: 'sleep-1', type: 'sleep', name: 'Sleep', currentDuration: 2, stacks: 1, visible: true },
      { id: 'freeze-1', type: 'freeze', name: 'Freeze', remainingDuration: 1, stacks: 1, visible: true },
    ]
    const inputBefore = structuredClone(rawStatuses)

    const model = viewModel.create({
      snapshot: fixtureSnapshot(rawStatuses),
      viewerId: 'player-red',
      selectedPieceId: 'piece-red',
    })
    const details = model.selection.piece.statusSummary
    const board = statusPresentation.boardSummary(details)

    expect(details).toHaveLength(5)
    expect(details[0]).toMatchObject({
      id: 'bleeding-1',
      label: 'Bleeding',
      stacks: 3,
      duration: 2,
      description: '',
      uses: 0,
      intensity: 0,
    })
    expect(details.map((status: { duration: number }) => status.duration)).toEqual([2, 2, 3, 2, 1])
    expect(board.map((entry: { status: { id: string } }) => entry.status.id)).toEqual(['sleep-1', 'freeze-1'])
    expect(board).toHaveLength(statusPresentation.MAX_BOARD_STATUSES)
    expect(rawStatuses).toEqual(inputBefore)
  })

  it('renders 0/1/2/3+ negative states without empty markers or horizontal overflow', () => {
    const statusPresentation = loadBrowserModule(
      'js/battle-ui/battle-status-presentation.js',
      'BattleStatusPresentation',
    )
    const negatives = [
      { id: 'sleep', label: 'Sleep', stacks: 1, duration: 2 },
      { id: 'freeze', label: 'Freeze', stacks: 1, duration: 1 },
      { id: 'anti-heal', label: 'Anti-heal', stacks: 1, duration: 3 },
      { id: 'bleeding', label: 'Bleeding', stacks: 3, duration: 2 },
    ]

    expect([
      statusPresentation.boardSummary([]).length,
      statusPresentation.boardSummary(negatives.slice(0, 1)).length,
      statusPresentation.boardSummary(negatives.slice(0, 2)).length,
      statusPresentation.boardSummary(negatives).length,
    ]).toEqual([0, 1, 2, 2])
    expect(statusPresentation.detailText(negatives[3])).toContain('3层')
    expect(statusPresentation.detailText(negatives[3])).toContain('2回合')
  })

  it('wires the shared presentation config into Three.js, fallback tokens, and full DOM detail', () => {
    const battlePage = readFileSync(resolve(pagesDir, 'battle.html'), 'utf8')
    const renderer = readFileSync(resolve(pagesDir, 'js/battle-renderer-3d.js'), 'utf8')
    const domUi = readFileSync(resolve(pagesDir, 'js/battle-ui/battle-dom-ui.js'), 'utf8')

    expect(battlePage).toContain('js/battle-ui/battle-status-presentation.js')
    expect(battlePage).toContain('BattleStatusPresentation.boardSummary')
    expect(battlePage).toContain('piece-status-dot')
    expect(battlePage).toContain('tok-health-number')
    expect(renderer).toContain('BattleStatusPresentation')
    expect(renderer).toContain('piece-board-summary')
    expect(renderer).not.toContain('_createHpBarEl')
    expect(renderer).toContain('_findPieceFromPointer(e.clientX, e.clientY)')
    expect(renderer).toContain("if (e.pointerType === 'mouse' && e.button !== 0) return")
    expect(renderer).toContain('_resetPointerState(canvas)')
    expect(renderer).toContain('const obj = _pieceObjects.get(piece.id)')
    expect(renderer).toContain('_projectedCellSpan(x, y) * 0.55')
    expect(domUi).toContain('selected-status-row')
    expect(domUi).toContain('detailText(status)')
  })
})
