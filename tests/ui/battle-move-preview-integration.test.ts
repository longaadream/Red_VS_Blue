/* eslint-disable @typescript-eslint/no-explicit-any -- Runs the untyped browser controller with real rule previews. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { previewBattleAction } from '@/lib/game/skill-preview'
import { applyBattleAction } from '@/lib/game/turn'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const page = readFileSync('data/pages/battle.html', 'utf8')
function readNamedFunction(html: string, name: string) {
  const marker = `function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${name} in battle.html`)
  const nextFunction = html.indexOf('\n    function ', start + marker.length)
  if (nextFunction === -1) throw new Error(`Could not isolate ${name} in battle.html`)
  return html.slice(start, nextFunction)
}
const controller = [
  page.slice(page.indexOf('    function startMoveDrag('), page.indexOf('    function currentTargetSourceName(')),
  readNamedFunction(page, 'renderResourcePreview'),
].join('\n')

function harness(terrain: 'amaterasu' | 'toxin' = 'amaterasu') {
  const mover = asPieceInstance(makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 4 }))
  const enemy = asPieceInstance(makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 2 }))
  const state = makeState({ pieces: [mover, enemy], width: 5, height: 3 })
  state.pieces = [mover, enemy]
  state.players[0].actionPoints = 2
  state.players[1].rules = [{ id: 'rule-sasuke-amaterasu-move' } as never]
  state.extensions = { amaterasuOwnerPlayerId: 'player-blue', amaterasuCells: [{ x: 0, y: 1, ownerPlayerId: 'player-blue', sourcePieceId: 'enemy' }],
    tileEffects: [{ id: 'flame', x: 0, y: 1, tileType: 'amaterasu' }] }
  if (terrain === 'toxin') {
    state.players[1].rules = [{ id: 'rule-blackwidow-toxin-player' } as never]
    state.players[1].statusTags = [{ id: 'toxin', type: 'lethal-toxin', intensity: 4, value: 1, extraValue: 1, sourceId: 'enemy', currentDuration: -1 }]
    state.extensions = { tileEffects: [{ id: 'toxin', sourceId: 'toxin', tileType: 'lethal-toxin', x: 1, y: 1, ownerPlayerId: 'player-blue' }] }
  }
  const renderer = { showPreviewBoard: vi.fn(), clearPreviewBoard: vi.fn(), spawnFloater: vi.fn() }
  const model = (snapshot: typeof state) => ({ pieces: snapshot.pieces.map(piece => ({ id: piece.instanceId,
    x: piece.x, y: piece.y, health: { current: piece.currentHp }, statusSummary: piece.statusTags })), interaction: {}, legal: {} })
  const ctx: any = createContext({
    G: state, selectedPieceId: 'mover', pendingMove: true, pendingActionFeedback: null,
    targetSubmissionPending: null, pendingSkill: null, pendingCardAction: null,
    moveDraft: null, movePreviewCoordinator: null, movePreviewVisible: false, hoverMovePath: [], myPlayerId: 'player-red',
    currentBattleViewModel: model(state), createBattlePresentationModel: model,
    window: { BattleRenderer3D: renderer }, setTimeout, clearTimeout,
    document: { getElementById: () => null },
    refreshBattleLegalActions() {}, waitingForOtherPending: () => false,
    closePieceContextMenu() {}, render() {},
    normalMoveRejectionForDraft: () => null,
    BattleLegalActions: { getNormalMoveContinuationTargets: () => [] },
    GameEngine: { previewBattleAction: (snapshot: typeof state, action: Parameters<typeof previewBattleAction>[1], viewer: string) =>
      previewBattleAction(snapshot, JSON.parse(JSON.stringify(action)), viewer) }, _use3d: true,
    battlePresentation: { updateMoveDraft: () => true }, setStatusMsg() {}, renderBoard() {},
  })
  // Real debounce and page binding; only actual WebGL drawing is replaced.
  new Script(readFileSync('data/pages/js/battle-ui/battle-move-preview.js', 'utf8')).runInContext(ctx)
  ctx.BattleMovePreview = ctx.window.BattleMovePreview
  new Script(controller).runInContext(ctx)
  ctx.startMoveDrag('mover')
  return { ctx, state, renderer }
}

afterEach(() => vi.useRealTimers())
describe('drag path through public terrain uses the real rule preview', () => {
  it('shows poison damage and consumption without committing the drag', () => {
    vi.useFakeTimers()
    const { ctx, state, renderer } = harness('toxin')
    const before = JSON.stringify(state)
    const actual = applyBattleAction(structuredClone(state), { type: 'move', playerId: 'player-red', pieceId: 'mover',
      toX: 1, toY: 1, path: [{ x: 0, y: 1 }, { x: 1, y: 1 }] })
    expect(actual.pieces.find(piece => piece.instanceId === 'mover')?.currentHp).toBe(96)
    ctx.updateMoveDrag('mover', [{ x: 0, y: 1 }, { x: 1, y: 1 }])
    vi.advanceTimersByTime(90)
    expect(renderer.showPreviewBoard).toHaveBeenCalledOnce()
    const [predicted, authority] = renderer.showPreviewBoard.mock.calls[0]
    expect(predicted.pieces.find((piece: { id: string }) => piece.id === 'mover').health.current).toBe(96)
    expect(authority.pieces.find((piece: { id: string }) => piece.id === 'mover').health.current).toBe(100)
    expect(renderer.spawnFloater).toHaveBeenCalledWith(1, 1, '−4', '#f87171', false, { kind: 'damage', preview: true })
    expect(ctx.moveDraft.previewSnapshot.extensions?.tileEffects ?? []).toHaveLength(0)
    expect(JSON.stringify(state)).toBe(before)
    ctx.showMoveBoardPreview(ctx.moveDraft.previewSnapshot)
    expect(renderer.showPreviewBoard).toHaveBeenCalledTimes(2)
    expect(renderer.spawnFloater).toHaveBeenCalledTimes(1)
    ctx.updateMoveDrag('mover', [{ x: 1, y: 1 }])
    vi.advanceTimersByTime(100)
    expect(renderer.spawnFloater).toHaveBeenCalledTimes(1)
    ctx.updateMoveDrag('mover', [{ x: 0, y: 0 }])
    expect(renderer.clearPreviewBoard).toHaveBeenCalledOnce()
    expect(renderer.spawnFloater).toHaveBeenCalledTimes(1)
  })
  it('shows enemy terrain status after the pause and restores the authoritative board on backtracking', () => {
    vi.useFakeTimers()
    const { ctx, state, renderer } = harness()
    const before = JSON.stringify(state)
    ctx.updateMoveDrag('mover', [{ x: 0, y: 1 }, { x: 1, y: 1 }])
    vi.advanceTimersByTime(89)
    expect(renderer.showPreviewBoard).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(renderer.showPreviewBoard).toHaveBeenCalledOnce()
    const [predicted, authority] = renderer.showPreviewBoard.mock.calls[0]
    const predictedMover = predicted.pieces.find((piece: { id: string }) => piece.id === 'mover')
    expect(predictedMover.statusSummary).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 })]))
    expect(predictedMover).toMatchObject({ x: 1, y: 1 })
    expect(authority.pieces.find((piece: { id: string }) => piece.id === 'mover')).toMatchObject({ x: 0, y: 0, statusSummary: [] })
    expect(JSON.stringify(state)).toBe(before)
    ctx.updateMoveDrag('mover', [{ x: 0, y: 0 }])
    expect(renderer.clearPreviewBoard).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(100)
    expect(renderer.showPreviewBoard).toHaveBeenCalledOnce()
    expect(renderer.spawnFloater).not.toHaveBeenCalled()
  })

  it('shows positive healing from a movement preview as a green floater', () => {
    vi.useFakeTimers()
    const { ctx, state, renderer } = harness()
    const snapshot = structuredClone(state)
    snapshot.pieces[0].x = 1
    snapshot.pieces[0].y = 1
    ctx.GameEngine.previewBattleAction = () => ({
      status: 'ready',
      snapshot,
      events: [
        { kind: 'heal', targetPieceIds: ['mover'], result: { amount: 7, value: 107 } },
        { kind: 'damage', targetPieceIds: ['mover'], result: { amount: 0, value: 100 } },
      ],
    })

    ctx.updateMoveDrag('mover', [{ x: 0, y: 1 }, { x: 1, y: 1 }])
    vi.advanceTimersByTime(90)

    expect(renderer.spawnFloater).toHaveBeenCalledWith(1, 1, '+7', '#4ade80', false, { kind: 'heal', preview: true })
    expect(renderer.spawnFloater).toHaveBeenCalledTimes(1)
  })
})
