import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

function loadBrowserModule(file: string) {
  const sandbox: Record<string, any> = { console, Date, Object, Array, Set, Map, Math }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  const context = createContext(sandbox)
  new Script(readFileSync(resolve(process.cwd(), 'data/pages/js/tutorial', file), 'utf8')).runInContext(context)
  return sandbox
}

describe('RED-95 tutorial controller', () => {
  it('allows only the current guided action and advances from accepted authoritative actions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const sandbox = loadBrowserModule('tutorial-controller.js')
    const controller = sandbox.RvBTutorialController.create({
      id: 'test',
      steps: [
        { id: 'welcome', advance: { type: 'continue' } },
        { id: 'move', advance: { type: 'action', actionType: 'move', templateId: 'anduin', to: { x: 6, y: 1 } } },
        { id: 'terrain', advance: { type: 'intent', intentType: 'activate-cell', cell: { x: 4, y: 8 } } },
        { id: 'done', advance: { type: 'complete' } },
      ],
    })
    const state = { pieces: [{ instanceId: 'anduin-1', templateId: 'anduin' }], players: [] }

    expect(controller.beforeAction({ type: 'endTurn' }, state).allowed).toBe(false)
    expect(controller.accept({ type: 'continue' }, state).accepted).toBe(true)
    expect(controller.beforeAction({ type: 'move', pieceId: 'anduin-1', toX: 5, toY: 1 }, state).allowed).toBe(false)
    expect(controller.beforeAction({ type: 'move', pieceId: 'anduin-1', toX: 6, toY: 1 }, state).allowed).toBe(true)
    expect(controller.accept({ type: 'action', action: { type: 'move', pieceId: 'anduin-1', toX: 6, toY: 1 } }, state).accepted).toBe(true)
    expect(controller.accept({ type: 'intent', intent: { type: 'activate-cell', x: 5, y: 8 } }, state).accepted).toBe(false)
    expect(controller.accept({ type: 'intent', intent: { type: 'activate-cell', x: 4, y: 8 } }, state).accepted).toBe(true)
    expect(controller.finish().accepted).toBe(true)
    expect(controller.snapshot()).toMatchObject({ status: 'completed', index: 3, total: 4 })
  })

  it('matches card and targeted skill templates by authoritative instance state', () => {
    const sandbox = loadBrowserModule('tutorial-controller.js')
    const matches = sandbox.RvBTutorialController.actionMatches
    const state = {
      pieces: [
        { instanceId: 'uther-1', templateId: 'uther' },
        { instanceId: 'anduin-1', templateId: 'anduin' },
      ],
      players: [{ playerId: 'red', hand: [{ instanceId: 'coin-1', cardId: 'lucky-coin' }] }],
    }
    expect(matches(
      { type: 'action', actionType: 'playCard', cardId: 'lucky-coin' },
      { type: 'playCard', playerId: 'red', cardInstanceId: 'coin-1' }, state,
    )).toBe(true)
    expect(matches(
      { type: 'action', actionType: 'useBasicSkill', templateId: 'anduin', skillId: 'light-of-the-light', targetTemplateId: 'uther' },
      { type: 'useBasicSkill', pieceId: 'anduin-1', skillId: 'light-of-the-light', targetPieceId: 'uther-1' }, state,
    )).toBe(true)
  })
})

describe('RED-95 tutorial scenario staging', () => {
  it('trims a normal battle into the staged board and opens the real reserve deployment', () => {
    const sandbox = loadBrowserModule('tutorial-scenario.js')
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/tutorial/first-session.json'), 'utf8'))
    const state: any = {
      pieces: [
        { instanceId: 'u1', templateId: 'uther', ownerPlayerId: 'training-red', currentHp: 10, maxHp: 10, x: 1, y: 1 },
        { instanceId: 'r1', templateId: 'reaper', ownerPlayerId: 'training-blue', currentHp: 10, maxHp: 10, x: 2, y: 2 },
        { instanceId: 'a1', templateId: 'anduin', ownerPlayerId: 'training-red', currentHp: 10, maxHp: 10, x: 3, y: 3 },
        { instanceId: 'w1', templateId: 'red-blackwidow', ownerPlayerId: 'training-blue', currentHp: 10, maxHp: 10, x: 4, y: 4 },
        { instanceId: 'j1', templateId: 'jaina', ownerPlayerId: 'training-red', currentHp: 10, maxHp: 10, x: 5, y: 5 },
        { instanceId: 'g1', templateId: 'guldan', ownerPlayerId: 'training-blue', currentHp: 10, maxHp: 10, x: 6, y: 6 },
      ],
    }
    sandbox.RvBTutorialScenario.prepareInitialState(state, definition)

    expect(state.pieces).toHaveLength(3)
    expect(state.pieces[0]).toMatchObject({ instanceId: 'u1', x: 6, y: 7 })
    expect(state.pieces[1]).toMatchObject({ instanceId: 'r1', x: 8, y: 7, currentHp: 1 })
    expect(state.deployment.reserves['training-red'].map((piece: any) => piece.templateId)).toEqual(['anduin'])
    expect(state.deployment.reserves['training-blue']).toEqual([])
    expect(state.pieces).toContainEqual(expect.objectContaining({ instanceId: 'w1', templateId: 'red-blackwidow', x: 17, y: 8 }))
    expect(state.deployment).toMatchObject({ mode: 'legacy-reroll-v1', status: 'complete' })
    expect(state.extensions.tutorial).toMatchObject({ scenarioId: definition.id, rootSeed: 188, staged: true })
    state.turn = { currentPlayerId: 'training-red', turnNumber: 2, phase: 'start' }
    sandbox.RvBTutorialScenario.openPlayerDeployment(state, definition)
    expect(state.deployment).toMatchObject({
      status: 'awaiting-reserve-deploy', activePlayerId: 'training-red', offerTurnNumber: 2,
      offerPieceIds: ['a1'], offerPieces: [{ instanceId: 'a1', templateId: 'anduin' }],
    })
    expect(sandbox.RvBTutorialScenario.resolveCellCue(state, definition, {
      templates: ['reaper'], terrainKeys: ['cover'], connectTemplateToCell: ['reaper', { x: 4, y: 8 }],
    })).toEqual({ cells: [{ x: 4, y: 8 }, { x: 8, y: 7 }], path: [{ x: 8, y: 7 }, { x: 4, y: 8 }] })
  })
})
