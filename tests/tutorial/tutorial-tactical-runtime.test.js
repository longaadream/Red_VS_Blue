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

function fixture({ practiceOnly = false, owner = 'human', phase = 'action', deployment = undefined, captureAiReplay = false } = {}) {
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
    captureAiReplay,
    getState: () => current,
    engine: async () => engine,
    search: vi.fn(async ({ state: searchState, playerId, rootSeed, continuation, actionsTakenThisTurn }) =>
      engine.planTutorialAiAction(searchState, playerId, rootSeed, { continuation, actionsTakenThisTurn })),
    commit: vi.fn(async action => {
      if (action.type === 'endTurn') current = { ...current, owner: 'human' }
      if (action.type === 'beginPhase') current = { ...current, owner: 'human', turn: { ...current.turn, phase: 'action' } }
    }),
    onAiDecisionResult: vi.fn(),
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

  it('forwards bounded AI diagnostics without sharing worker trace objects', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent' })
      const trace = [
        { depth: 0, candidateId: 'root-end', rootId: 'root-end', score: 1.25, reason: 'evaluated' },
        { depth: 1, candidateId: 'child-private', rootId: 'root-end', score: 99, reason: 'evaluated' },
        { depth: 0, candidateId: 'root-rejected', rootId: 'root-rejected', reason: 'rejected', error: 'ILLEGAL' },
        { depth: 0, candidateId: 'root-limited', rootId: 'root-limited', reason: 'candidate-limit' },
        { depth: 0, candidateId: 'root-blocked', rootId: 'root-blocked', reason: 'blocked' },
        { depth: 0, candidateId: 'root-duplicate', rootId: 'root-duplicate', reason: 'duplicate' },
      ]
      f.engine.planTutorialAiAction.mockReturnValue({
        nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
        score: 3.5,
        nodes: 7,
        considered: 9,
        elapsedMs: 275,
        overTurnBudget: true,
        overDecisionBudget: true,
        stopReason: 'time-budget',
        continuation: { turnKey: 'opponent:1:opponent', nodes: 12, elapsedMs: 275 },
        trace,
      })

      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(3000)

      const details = f.hooks.onAiDecisionResult.mock.calls[0][0]
      expect(details).toMatchObject({
        score: 3.5,
        overTurnBudget: true,
        overDecisionBudget: true,
        continuation: { turnKey: 'opponent:1:opponent', nodes: 12, elapsedMs: 275 },
        actionsTakenThisTurn: 0,
        trace: [
          { depth: 0, candidateId: 'root-end', rootId: 'root-end', score: 1.25, reason: 'evaluated' },
          { depth: 0, candidateId: 'root-rejected', rootId: 'root-rejected', reason: 'rejected', error: 'ILLEGAL' },
          { depth: 0, candidateId: 'root-limited', rootId: 'root-limited', reason: 'candidate-limit' },
          { depth: 0, candidateId: 'root-blocked', rootId: 'root-blocked', reason: 'blocked' },
          { depth: 0, candidateId: 'root-duplicate', rootId: 'root-duplicate', reason: 'duplicate' },
        ],
        traceCounts: {
          total: 6,
          roots: 5,
          reasons: { evaluated: 1, rejected: 1, blocked: 1, duplicate: 1, 'candidate-limit': 1 },
          returned: 5,
          truncated: false,
        },
      })
      expect(details.trace).not.toBe(trace)
      expect(details.trace[0]).not.toBe(trace[0])
      expect(details.continuation).not.toBe(f.engine.planTutorialAiAction.mock.results[0].value.continuation)
      trace[0].candidateId = 'mutated'
      expect(details.trace[0].candidateId).toBe('root-end')
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures the decision input before a zero-action end turn when opted in', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent', captureAiReplay: true })
      const outputContinuation = { turnKey: 'opponent:1:opponent', nodes: 9, elapsedMs: 18 }
      f.engine.planTutorialAiAction.mockReturnValue({
        nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
        continuation: outputContinuation,
        nodes: 2, considered: 3, elapsedMs: 5, stopReason: 'selected',
      })
      const before = f.state()
      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(3000)
      const details = f.hooks.onAiDecisionResult.mock.calls[0][0]
      expect(details.replayInput).toMatchObject({
        rootSeed: 18707,
        playerId: 'opponent',
        actionsTakenThisTurn: 0,
        continuation: null,
        state: before,
      })
      expect(details.replayInput.continuation).not.toBe(outputContinuation)
      expect(details.replayResult).toMatchObject({ action: { type: 'endTurn', playerId: 'opponent' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('copies the incoming continuation before capturing the end-turn result', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent', captureAiReplay: true })
      const firstContinuation = { turnKey: 'opponent:1:opponent', nodes: 4, elapsedMs: 8 }
      const outputContinuation = { turnKey: 'opponent:1:opponent', nodes: 9, elapsedMs: 18 }
      f.engine.planTutorialAiAction
        .mockReturnValueOnce({
          nextAction: { action: { type: 'deployReservePiece', playerId: 'opponent', pieceId: 'enemy' } },
          continuation: firstContinuation,
          nodes: 2, considered: 3, elapsedMs: 5, stopReason: 'selected',
        })
        .mockReturnValueOnce({
          nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
          continuation: outputContinuation,
          nodes: 1, considered: 1, elapsedMs: 3, stopReason: 'selected',
        })
      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(6000)
      const details = f.hooks.onAiDecisionResult.mock.calls[1][0]
      expect(details.replayInput.continuation).toEqual(firstContinuation)
      expect(details.replayInput.continuation).not.toBe(firstContinuation)
      expect(details.replayInput.continuation).not.toEqual(outputContinuation)
      firstContinuation.nodes = 99
      expect(details.replayInput.continuation.nodes).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not attach replay input to ordinary actions or an end turn after an accepted action', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent', captureAiReplay: true })
      f.engine.planTutorialAiAction
        .mockReturnValueOnce({
          nextAction: { action: { type: 'move', playerId: 'opponent', pieceId: 'enemy', toX: 4, toY: 1 } },
          continuation: { turnKey: 'opponent:1:opponent', nodes: 2, elapsedMs: 4 },
          nodes: 2, considered: 3, elapsedMs: 4, stopReason: 'selected',
        })
        .mockReturnValueOnce({
          nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
          continuation: { turnKey: 'opponent:1:opponent', nodes: 3, elapsedMs: 8 },
          nodes: 1, considered: 1, elapsedMs: 4, stopReason: 'selected',
        })
      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(6000)
      expect(f.hooks.onAiDecisionResult.mock.calls[0][0].replayInput).toBeUndefined()
      expect(f.hooks.onAiDecisionResult.mock.calls[1][0].replayInput).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures a budget exhausted end turn with remaining AP after prior actions', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent', captureAiReplay: true })
      f.setState({
        ...f.state(),
        players: f.state().players.map(player => player.playerId === 'opponent'
          ? { ...player, actionPoints: 1 }
          : player),
      })
      f.engine.planTutorialAiAction
        .mockReturnValueOnce({
          nextAction: { action: { type: 'move', playerId: 'opponent', pieceId: 'enemy', toX: 4, toY: 1 } },
          continuation: { turnKey: 'opponent:1:opponent', nodes: 2, elapsedMs: 4 },
          nodes: 2, considered: 3, elapsedMs: 4, stopReason: 'selected',
        })
        .mockReturnValueOnce({
          nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
          continuation: { turnKey: 'opponent:1:opponent', nodes: 3, elapsedMs: 9 },
          nodes: 0, considered: 10, elapsedMs: 5, stopReason: 'time-budget', overTurnBudget: true,
        })
      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(6000)
      expect(f.hooks.onAiDecisionResult.mock.calls[1][0].replayInput).toMatchObject({ actionsTakenThisTurn: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures a partial time-budget end turn with remaining AP after prior actions', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent', captureAiReplay: true })
      f.setState({
        ...f.state(),
        players: f.state().players.map(player => player.playerId === 'opponent'
          ? { ...player, actionPoints: 4 }
          : player),
      })
      f.engine.planTutorialAiAction
        .mockReturnValueOnce({
          nextAction: { action: { type: 'move', playerId: 'opponent', pieceId: 'enemy', toX: 4, toY: 1 } },
          continuation: { turnKey: 'opponent:1:opponent', nodes: 2, elapsedMs: 4 },
          nodes: 2, considered: 3, elapsedMs: 4, stopReason: 'selected',
        })
        .mockReturnValueOnce({
          nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
          continuation: { turnKey: 'opponent:1:opponent', nodes: 3, elapsedMs: 9 },
          nodes: 1, considered: 10, elapsedMs: 5, stopReason: 'time-budget', overTurnBudget: false,
        })
      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(6000)
      expect(f.hooks.onAiDecisionResult.mock.calls[1][0].replayInput).toMatchObject({
        actionsTakenThisTurn: 1,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the deployment then end-turn opening flow while carrying cumulative diagnostics', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent', phase: 'start' })
      const deploymentDecision = {
        nextAction: { action: { type: 'deployReservePiece', playerId: 'opponent', pieceId: 'enemy' } },
        nodes: 3,
        considered: 3,
        elapsedMs: 100,
        overTurnBudget: false,
        overDecisionBudget: false,
        stopReason: 'selected',
        continuation: { turnKey: 'opponent:1:opponent', nodes: 3, elapsedMs: 100 },
        trace: [],
      }
      const endTurnDecision = {
        nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
        nodes: 1,
        considered: 1,
        elapsedMs: 75,
        overTurnBudget: true,
        overDecisionBudget: false,
        stopReason: 'time-budget',
        continuation: { turnKey: 'opponent:1:opponent', nodes: 4, elapsedMs: 175 },
        trace: [],
      }
      f.engine.planTutorialAiAction
        .mockReturnValueOnce(deploymentDecision)
        .mockReturnValueOnce(endTurnDecision)

      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(7000)

      expect(f.hooks.search.mock.calls.map(call => call[0].actionsTakenThisTurn)).toEqual([0, 0])
      expect(f.hooks.search.mock.calls[1][0].continuation).toEqual(deploymentDecision.continuation)
      expect(f.hooks.onAiDecisionResult.mock.calls.map(call => call[0].action.type)).toEqual([
        'deployReservePiece', 'endTurn',
      ])
      expect(f.hooks.onAiDecisionResult.mock.calls[1][0]).toMatchObject({
        overTurnBudget: true,
        continuation: endTurnDecision.continuation,
        actionsTakenThisTurn: 0,
      })
      expect(f.hooks.commit.mock.calls.map(call => call[0].type)).toEqual([
        'deployReservePiece', 'endTurn', 'beginPhase',
      ])
      expect(f.state().owner).toBe('human')
      expect(f.state().turn.phase).toBe('action')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds root trace entries while retaining counts for omitted reasons', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ practiceOnly: true, owner: 'opponent' })
      const trace = [
        ...Array.from({ length: 60 }, (_, index) => ({
          depth: 0, candidateId: 'evaluated-' + index, rootId: 'evaluated-' + index,
          score: index, reason: 'evaluated',
        })),
        { depth: 0, candidateId: 'rejected', rootId: 'rejected', reason: 'rejected', error: 'ILLEGAL' },
        ...Array.from({ length: 10 }, (_, index) => ({
          depth: 0, candidateId: 'blocked-' + index, rootId: 'blocked-' + index, reason: 'blocked',
        })),
      ]
      f.engine.planTutorialAiAction.mockReturnValue({
        nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
        nodes: 64,
        considered: trace.length,
        elapsedMs: 250,
        stopReason: 'time-budget',
        continuation: { turnKey: 'opponent:1:opponent', nodes: 64, elapsedMs: 250 },
        trace,
      })

      f.click('开始实战')
      await vi.advanceTimersByTimeAsync(3000)

      const details = f.hooks.onAiDecisionResult.mock.calls[0][0]
      expect(details.trace).toHaveLength(64)
      expect(details.trace[60]).toMatchObject({ candidateId: 'rejected', reason: 'rejected' })
      expect(details.trace.slice(61).every(entry => entry.reason === 'blocked')).toBe(true)
      expect(details.traceCounts).toEqual({
        total: 71,
        roots: 71,
        reasons: { evaluated: 60, rejected: 1, blocked: 10, duplicate: 0, 'candidate-limit': 0 },
        returned: 64,
        truncated: true,
      })
    } finally {
      vi.useRealTimers()
    }
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
