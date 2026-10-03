import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

class Element {
  children = []
  textContent = ''
  hidden = false
  classList = { toggle() {} }
  listeners = {}
  attributes = {}
  setAttribute(name, value) { this.attributes[name] = value }
  append(...items) { this.children.push(...items) }
  appendChild(item) { this.append(item) }
  replaceChildren(...items) { this.children = items }
  addEventListener(name, callback) { this.listeners[name] = callback }
  remove() { this.removed = true }
}

function fixture({ practiceOnly = false, owner = 'human', phase = 'action', deployment = undefined } = {}) {
  let current = {
    turn: { phase, turnNumber: 1, currentPlayerId: owner },
    owner,
    players: [
      { playerId: 'human', actionPoints: 3, chargePoints: 1, maxActionPoints: 3 },
      { playerId: 'opponent', actionPoints: 0, chargePoints: 0, maxActionPoints: 0 },
    ],
    pieces: [
      { instanceId: 'ally', ownerPlayerId: 'human', name: '核心', currentHp: 10, maxHp: 10, x: 1, y: 1 },
      { instanceId: 'enemy', ownerPlayerId: 'opponent', name: '敌人', currentHp: 10, maxHp: 10, x: 3, y: 1 },
    ],
    ...(deployment ? { deployment } : {}),
  }
  const body = new Element()
  const sandbox = {
    document: { body, createElement: () => new Element() },
    setTimeout,
    performance: { now: () => 0 },
    RvBTutorialLessons: { all: [], observe: () => [] },
  }
  runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lesson-runtime.js', 'utf8'), sandbox)
  const lesson = {
    id: 'tactical-intuition', number: 7, title: '战术直觉',
    tactical: true, rootSeed: 18707, intro: '正常生命', help: '按需帮助',
    player: { playerId: 'human' }, opponent: { playerId: 'opponent' },
  }
  const engine = {
    getCurrentInputOwnerPlayerId: state => state.owner,
    getBattleRootSeed: () => lesson.rootSeed,
    hashBattleState: state => JSON.stringify(state),
    planTutorialAiAction: vi.fn(),
    planBotActions: vi.fn(),
  }
  const hooks = {
    practiceOnly,
    getState: () => current,
    engine: async () => engine,
    search: vi.fn(async ({ state: searchState, playerId, rootSeed, continuation, actionsTakenThisTurn }) =>
      engine.planTutorialAiAction(searchState, playerId, rootSeed, { continuation, actionsTakenThisTurn })),
    commit: vi.fn(async action => {
      if (action.type === 'endTurn') current = { ...current, owner: 'human' }
      if (action.type === 'beginPhase') current = { ...current, owner: 'human', turn: { ...current.turn, phase: 'action' } }
    }),
    render() {}, setCue() {}, exit: vi.fn(), restart: vi.fn(), next: vi.fn(),
  }
  const runtime = sandbox.RvBTutorialLessonRuntime.create(lesson, hooks)
  const root = body.children[0]
  const button = label => root.children[3].children.find(item => item.textContent === label)
  const click = label => button(label).listeners.click()
  return {
    lesson, engine, hooks, runtime, root,
    state: () => current,
    setState: next => { current = next },
    button, click,
  }
}

afterEach(() => vi.useRealTimers())

describe('RED-230 tactical tutorial runtime', () => {
  it.each([
    ['保护核心', 'protect', '撤退'],
    ['发起进攻', 'attack', '集中火力'],
    ['调整站位', 'reposition', '掩体'],
  ])('allows the %s intent without gating free actions', async (label, intent, idea) => {
    const f = fixture()
    f.click('开始学习')
    await vi.waitFor(() => expect(f.runtime.snapshot().busy).toBe(false))
    expect(f.button(label)).toBeDefined()
    f.click(label)
    expect(f.runtime.snapshot().goalIntent).toBe(intent)
    expect(f.root.children[1].textContent).toContain(idea)
    expect(f.runtime.beforeAction({ type: 'move', playerId: 'human' }).allowed).toBe(true)
  })

  it('records actual AP, CP, health, and position changes for replay', async () => {
    const f = fixture()
    f.click('开始学习')
    await vi.waitFor(() => expect(f.runtime.snapshot().busy).toBe(false))
    f.click('保护核心')
    const before = f.state()
    const after = {
      ...before,
      players: before.players.map(player => player.playerId === 'human'
        ? { ...player, actionPoints: 2 }
        : player),
      pieces: before.pieces.map(piece => piece.instanceId === 'ally'
        ? { ...piece, x: 2, currentHp: 8 }
        : piece.instanceId === 'enemy' ? { ...piece, currentHp: 7 } : piece),
    }
    f.setState(after)
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'human', pieceId: 'ally', toX: 2, toY: 1 }, before)
    const snapshot = f.runtime.snapshot()
    expect(snapshot.notices.at(-1).text).toContain('AP 3→2')
    expect(snapshot.notices.at(-1).text).toContain('CP 1→1')
    expect(snapshot.notices.at(-1).text).toContain('核心生命 10→8')
    expect(snapshot.notices.at(-1).text).toContain('敌人生命 10→7')
    expect(snapshot.notices.at(-1).text).toContain('核心位置 (1, 1)→(2, 1)')
    expect(f.root.children[4].children[1].children.map(item => item.textContent).join(' ')).toContain('本次行动实际结果')
  })

  it('skips goal teaching in direct practice and still gives the enemy the tutorial planner', async () => {
    vi.useFakeTimers()
    const f = fixture({ practiceOnly: true, owner: 'opponent' })
    f.engine.planTutorialAiAction.mockReturnValue({
      nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
      continuation: { turnKey: 'opponent:1:opponent', nodes: 1, elapsedMs: 0 },
      elapsedMs: 0, stopReason: 'selected',
    })
    f.click('开始实战')
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.runtime.snapshot().practiceOnly).toBe(true)
    expect(f.runtime.snapshot().activeTips).toBe(false)
    expect(f.button('保护核心')).toBeUndefined()
    expect(f.button('发起进攻')).toBeUndefined()
    expect(f.engine.planTutorialAiAction).toHaveBeenCalled()
    expect(f.engine.planBotActions).not.toHaveBeenCalled()
  })

  it('reports removal, reserve placement, and enemy healing as observed state changes', async () => {
    const f = fixture()
    f.click('开始学习')
    await vi.waitFor(() => expect(f.runtime.snapshot().busy).toBe(false))
    f.click('保护核心')
    const before = f.state()
    const after = {
      ...before,
      pieces: [{ ...before.pieces[1], currentHp: 12 }],
    }
    f.setState(after)
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'human', pieceId: 'ally' }, before)
    const removalText = f.runtime.snapshot().notices.at(-1).text
    expect(removalText).toContain('核心离场（离场前生命 10）')
    expect(removalText).toContain('核心位置 (1, 1)→离场')
    expect(removalText).toContain('敌人生命 10→12')
    expect(removalText).not.toContain('生命未变化')

    const beforeReserve = {
      ...after,
      pieces: [...after.pieces, { instanceId: 'ally2', ownerPlayerId: 'human', name: '支援', currentHp: 6, x: 4, y: 4 }],
    }
    const afterReserve = {
      ...beforeReserve,
      pieces: after.pieces,
      deployment: { reserves: { human: [{ instanceId: 'ally2', ownerPlayerId: 'human', name: '支援', currentHp: 6 }] } },
    }
    f.setState(afterReserve)
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'human', pieceId: 'ally2' }, beforeReserve)
    expect(f.runtime.snapshot().notices.at(-1).text).toContain('支援位置 (4, 4)→预备区')
  })

  it('waits for a human standard reserve choice instead of taking it over', async () => {
    const f = fixture({ phase: 'start', deployment: {
      mode: 'progressive-reserve-v1', status: 'awaiting-reserve-deploy', activePlayerId: 'human',
      offerPieces: [{ instanceId: 'ally', name: '核心', currentHp: 10 }], legalPositions: [],
    } })
    f.click('开始学习')
    await vi.waitFor(() => expect(f.runtime.snapshot().busy).toBe(false))
    expect(f.engine.planBotActions).not.toHaveBeenCalled()
    expect(f.engine.planTutorialAiAction).not.toHaveBeenCalled()
    expect(f.runtime.beforeAction({ type: 'deployReservePiece', playerId: 'human', pieceId: 'ally' }).allowed).toBe(true)
  })

  it('advances only a tactical human structural phase and never asks an AI to deploy', async () => {
    const f = fixture({ phase: 'start' })
    f.click('开始学习')
    await vi.waitFor(() => expect(f.runtime.snapshot().busy).toBe(false))
    expect(f.hooks.commit).toHaveBeenCalledWith({ type: 'beginPhase' })
    expect(f.engine.planBotActions).not.toHaveBeenCalled()
    expect(f.engine.planTutorialAiAction).not.toHaveBeenCalled()
    expect(f.state().turn.phase).toBe('action')
  })
})
