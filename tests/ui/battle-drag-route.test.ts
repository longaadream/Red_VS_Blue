/* eslint-disable @typescript-eslint/no-explicit-any -- Executes the browser controller in a VM. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')
const controller = page.slice(page.indexOf('    function startMoveDrag('), page.indexOf('    function currentTargetSourceName('))
function harness() {
  const state = { pieces: [{ instanceId: 'p', x: 1, y: 1, currentHp: 10 }] }
  const ctx: any = {
    G: state, selectedPieceId: 'p', pendingMove: true, pendingActionFeedback: null,
    targetSubmissionPending: null, pendingSkill: null, pendingCardAction: null,
    moveDraft: null, movePreviewCoordinator: null, hoverMovePath: [], validMoves: new Set(['1,2', '2,1', '2,2']), myPlayerId: 'me',
    refreshBattleLegalActions() {}, waitingForOtherPending: () => false,
    closePieceContextMenu() {}, dismissedPieceContextId: null,
    BattleLegalActions: { getNormalMoveContinuationTargets: () => [] }, GameEngine: {},
    _use3d: false, battlePresentation: null,
    normalMoveRejectionForDraft: vi.fn((draft: any) => {
      const last = draft.path.length > 1 ? draft.path[draft.path.length - 2] : draft.origin
      return Math.abs(last.x - draft.target.x) + Math.abs(last.y - draft.target.y) === 1 ? null : { code: 'non-adjacent' }
    }), render: vi.fn(), doAction: vi.fn(), setStatusMsg: vi.fn(),
    clearMoveDraft() { ctx.moveDraft = null },
  }
  ctx.renderBoard = ctx.render
  runInNewContext(controller, ctx)
  ctx.startMoveDrag('p')
  return ctx
}
describe('drag route editing and release', () => {
  it('updates only route presentation when crossing a tile in the 3D board', () => {
    const ctx = harness()
    ctx._use3d = true
    ctx.battlePresentation = { updateMoveDraft: vi.fn(() => true) }
    ctx.render.mockClear()
    ctx.updateMoveDrag('p', [{ x: 2, y: 1 }])
    expect(ctx.battlePresentation.updateMoveDraft).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      movePath: [{ x: 2, y: 1 }], moveDraftActive: true,
    }), [])
    expect(ctx.render).not.toHaveBeenCalled()
    expect(ctx.setStatusMsg).toHaveBeenLastCalledWith('路线 1 格 · 回拖撤销 · 松手移动')
    ctx.updateMoveDrag('p', [null])
    expect(ctx.setStatusMsg).toHaveBeenLastCalledWith('路线不可用 · 拖回路线重画，或松手取消')
  })
  it('commits the drawn U-turn once and truncates a backtracked suffix', () => {
    const ctx = harness()
    ctx.updateMoveDrag('p', [{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }])
    ctx.updateMoveDrag('p', [{ x: 2, y: 2 }])
    expect(ctx.moveDraft.path).toEqual([{ x: 2, y: 1 }, { x: 2, y: 2 }])
    ctx.updateMoveDrag('p', [{ x: 1, y: 2 }])
    ctx.endMoveDrag({ pieceId: 'p', x: 1, y: 2 })
    expect(ctx.doAction).toHaveBeenCalledWith({ type: 'move', playerId: 'me', pieceId: 'p', toX: 1, toY: 2,
      path: [{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }] })
    ctx.endMoveDrag({ pieceId: 'p', x: 1, y: 2 })
    expect(ctx.doAction).toHaveBeenCalledTimes(1)
  })
  it('does no rule query or redraw when the pointer stays within the current tile', () => {
    const ctx = harness()
    ctx.updateMoveDrag('p', [{ x: 2, y: 1 }])
    ctx.render.mockClear(); ctx.normalMoveRejectionForDraft.mockClear()
    for (let i = 0; i < 100; i++) ctx.updateMoveDrag('p', [{ x: 2, y: 1 }])
    expect(ctx.render).not.toHaveBeenCalled()
    expect(ctx.normalMoveRejectionForDraft).not.toHaveBeenCalled()
  })
  it('uses the predicted status state for candidate highlights and ignores a replaced route result', () => {
    const ctx = harness()
    const request = vi.fn()
    ctx.GameEngine.previewBattleAction = vi.fn()
    ctx.BattleMovePreview = { create: () => ({ request, clear() {} }) }
    ctx.BattleStatusPresentation = { resolve: () => ({ label: '定身' }), detailText: () => '剩余：1回合' }
    ctx.BattleLegalActions.getNormalMoveContinuationTargets = vi.fn(() => [])
    ctx.updateMoveDrag('p', [{ x: 2, y: 1 }])
    const firstAccept = request.mock.calls[0][3]
    const predicted = { pieces: [{ instanceId: 'p', currentHp: 8, moveRange: 3,
      statusTags: [{ id: 'root', type: 'root', remainingDuration: 1 }] }] }
    firstAccept({ status: 'ready', snapshot: predicted, events: [] })
    expect(ctx.moveDraft.previewText).toContain('生命 10 → 8')
    expect(ctx.moveDraft.previewText).toContain('定身')
    expect(ctx.BattleLegalActions.getNormalMoveContinuationTargets).toHaveBeenLastCalledWith(expect.objectContaining({ previewSnapshot: predicted }))
    ctx.updateMoveDrag('p', [{ x: 2, y: 2 }])
    firstAccept({ status: 'ready', snapshot: predicted, events: [] })
    expect(ctx.moveDraft.previewText).toBe('')
  })
  it.each(['outside', 'origin', 'stale', 'cancel'])('cancels %s without executing a valid earlier prefix', reason => {
    const ctx = harness()
    ctx.updateMoveDrag('p', [{ x: 2, y: 1 }])
    if (reason === 'outside') ctx.updateMoveDrag('p', [null])
    if (reason === 'origin') ctx.updateMoveDrag('p', [{ x: 1, y: 1 }])
    if (reason === 'stale') ctx.G = { ...ctx.G }
    ctx.endMoveDrag({ pieceId: 'p', x: reason === 'origin' ? 1 : 2, y: 1, cancelled: reason === 'cancel' })
    expect(ctx.doAction).not.toHaveBeenCalled()
    expect(ctx.moveDraft).toBeNull()
  })
})
