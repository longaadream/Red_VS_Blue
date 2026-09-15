import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')
const legal = page.slice(page.indexOf('    function refreshBattleLegalActions()'), page.indexOf('    function refreshBattleLegalActions()') + page.slice(page.indexOf('    function refreshBattleLegalActions()')).indexOf('\n    function ', 10))
const move = page.slice(page.indexOf('    function moveSelectedPieceToCell('), page.indexOf('    function onCellClick('))

describe('selected piece movement recovery', () => {
  it('requeries stale movement state without reselecting, while preserving action locks', () => {
    const query = vi.fn(() => new Set(['2,3']))
    const action = vi.fn()
    const context = {
      G: { pieces: [{ instanceId: 'piece', currentHp: 10, ownerPlayerId: 'me' }], turn: { currentPlayerId: 'me', phase: 'action' } },
      selectedPieceId: 'piece', myPlayerId: 'me', pendingMove: false, validMoves: new Set(),
      ADVENTURE_MODE: false, SPECTATE_MODE: false, TRAINING_MODE: false,
      pendingSkill: null, pendingCardAction: null, pendingActionFeedback: null as unknown, targetSubmissionPending: null,
      window: { BattleLegalActions: {} }, BattleLegalActions: { queryMoveCells: query }, GameEngine: {},
      progressiveDeploymentPending: () => false, setMoveButtonClass() {}, closePieceContextMenu() {}, setStatusMsg() {}, doAction: action,
    }
    runInNewContext(legal + move + '\nmoveSelectedPieceToCell("piece", 2, 3)', context)
    expect(action).toHaveBeenCalledWith({ type: 'move', playerId: 'me', pieceId: 'piece', toX: 2, toY: 3 })
    action.mockClear()
    context.pendingActionFeedback = { clientActionId: 'waiting' }
    runInNewContext('moveSelectedPieceToCell("piece", 2, 3)', context)
    expect(action).not.toHaveBeenCalled()
  })
})
