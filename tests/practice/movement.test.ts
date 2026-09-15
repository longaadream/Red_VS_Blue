import fs from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

function pageFunction(name: string) {
  const html = fs.readFileSync('data/pages/battle.html', 'utf8')
  const start = html.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`Missing function ${name}`)
  let depth = 0
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1)
  }
  throw new Error(`Unclosed function ${name}`)
}

function fixture(block: 'none' | 'pending' | 'no-moves' | 'other-turn' = 'none') {
  const initial = { pieces: [{ instanceId: 'runner', ownerPlayerId: 'practice-human', currentHp: 12, x: 1, y: 1 }],
    players: [{ playerId: 'practice-human', faction: 'red' }], turn: { currentPlayerId: 'practice-human', phase: 'action' } }
  const submitted: Array<Record<string, unknown>> = []
  const rejections: string[] = []
  const queryMoveCells = ({ snapshot }: { snapshot: typeof initial }) => new Set(block === 'no-moves' ? [] : [`${snapshot.pieces[0].x + 1},1`])
  const context = vm.createContext({ window: { BattleLegalActions: { queryMoveCells } }, BattleLegalActions: { queryMoveCells }, GameEngine: {},
    console: { info() {} }, document: { getElementById: () => null }, G: initial, skillsById: {}, myPlayerId: 'practice-human', myFaction: 'red',
    selectedPieceId: 'runner', pendingMove: true, validMoves: new Set(['2,1']), dismissedPieceContextId: null,
    pendingSkill: null, pendingCardAction: null, pendingActionFeedback: null, targetSubmissionPending: null,
    SPECTATE_MODE: false, TRAINING_MODE: false, ADVENTURE_MODE: false, _use3d: false, latestBattlePresentationEvents: [],
    withClientActionId: (action: unknown) => action, clearTimeout() {}, beginPendingActionFeedback: () => true,
    applyAuthorityReceipt() {}, spawnStateFloaters() {}, reconcileBattleInteractionState() {}, clearPendingActionFeedback() {},
    rejectPendingActionFeedback: (_reason: string, message: string) => rejections.push(message),
    renderPieceContextMenu() {}, setMoveButtonClass() {}, closePieceContextMenu() {}, setStatusMsg() {},
    request: async (_type: string, payload: { action: Record<string, unknown>; revision: number }) => {
      submitted.push(payload.action)
      const state = structuredClone(initial)
      state.pieces[0].x = Number(payload.action.toX)
      if (block === 'other-turn') state.turn.currentPlayerId = 'practice-ai'
      return { state: { ...state, ...(block === 'pending' ? { pendingOptionSelection: { playerId: 'practice-human' } } : {}) },
        revision: payload.revision + 1, action: payload.action, humanPlayerId: 'practice-human', aiPlayerId: 'practice-ai', inputOwner: state.turn.currentPlayerId, timings: [] }
    } })
  new vm.Script(fs.readFileSync('data/pages/js/practice/battle-controller.js', 'utf8') + `
    ${pageFunction('restoreSelectedPieceMenu')}
    ${pageFunction('progressiveDeploymentPending')}
    ${pageFunction('refreshBattleLegalActions')}
    ${pageFunction('moveSelectedPieceToCell')}
    function render() { refreshBattleLegalActions() }
    function doAction(action) { window.lastAction = practiceDoAction(action) }
    practiceSnapshot = { revision: 0 };
    practiceClient = { request };
    schedulePracticeAI = () => {};
  `).runInContext(context)
  return { context, submitted, rejections }
}

describe('practice selected-piece movement after an authority receipt', () => {
  it('accepts two consecutive cell clicks without selecting the piece again', async () => {
    const { context, submitted, rejections } = fixture()
    expect(context.moveSelectedPieceToCell('runner', 2, 1)).toBe(true)
    await context.window.lastAction
    expect(context.selectedPieceId).toBe('runner')
    expect(context.moveSelectedPieceToCell('runner', 3, 1)).toBe(true)
    await context.window.lastAction
    expect(submitted.map(action => action.toX)).toEqual([2, 3])
    expect(rejections).toEqual([])
  })
  it.each(['pending', 'no-moves', 'other-turn'] as const)('keeps movement blocked for %s', async block => {
    const { context, submitted, rejections } = fixture(block)
    expect(context.moveSelectedPieceToCell('runner', 2, 1)).toBe(true)
    await context.window.lastAction
    expect(context.moveSelectedPieceToCell('runner', 3, 1)).toBe(false)
    expect(submitted).toHaveLength(1)
    expect(rejections).toEqual([])
  })
})
