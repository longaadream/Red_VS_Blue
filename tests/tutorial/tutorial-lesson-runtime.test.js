import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

class Element {
  children = []
  textContent = ''
  classList = { toggle() {} }
  listeners = {}
  attributes = {}
  setAttribute(name, value) { this.attributes[name] = value }
  append(...items) { this.children.push(...items) }
  appendChild(item) { this.append(item) }
  replaceChildren() { this.children = [] }
  addEventListener(name, callback) { this.listeners[name] = callback }
  remove() { this.removed = true }
}

function fixture(lessonOverrides = {}) {
  const body = new Element()
  const state = { turn: { phase: 'action' } }
  const observe = vi.fn(() => [])
  const clock = { now: 0 }
  const sandbox = { document: { body, createElement: () => new Element() }, setTimeout,
    performance: { now: () => clock.now },
    RvBTutorialLessons: { all: [1, 2, 3, 4, 5, 6], observe } }
  runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lesson-runtime.js', 'utf8'), sandbox)
  const lesson = { id: 'one', number: 1, title: '练习', intro: '开场', help: '思路', rootSeed: 228,
    player: { playerId: 'human' }, ...lessonOverrides }
  const engine = { getCurrentInputOwnerPlayerId: () => 'human', getBattleRootSeed: () => lesson.rootSeed,
    hashBattleState: value => JSON.stringify(value), planTutorialAiAction: vi.fn(), planBotActions: vi.fn() }
  const hooks = { getState: () => state, engine: async () => engine,
    search: vi.fn(async ({ state: searchState, playerId, rootSeed, continuation, actionsTakenThisTurn }) =>
      engine.planTutorialAiAction(searchState, playerId, rootSeed, { continuation, actionsTakenThisTurn })),
    render() {}, setCue() {}, exit: vi.fn(), restart() {}, next() {} }
  const runtime = sandbox.RvBTutorialLessonRuntime.create(lesson, hooks)
  const root = body.children[0]
  function click(label) { root.children[3].children.find(item => item.textContent === label).listeners.click() }
  return { state, runtime, root, click, observe, engine, hooks, clock }
}

afterEach(() => vi.useRealTimers())

describe('collapsible tutorial', () => {
  it('keeps the objective and teaching state while collapsed, including after a render', async () => {
    const f = fixture()
    const toggle = f.root.children[0].children[1]
    const before = f.runtime.snapshot()
    f.root.classList.toggle = vi.fn()
    expect(toggle.attributes['aria-expanded']).toBe('false')
    expect(toggle.textContent).toBe('说明')
    expect(f.runtime.snapshot()).toEqual(before)
    expect(f.root.children[2].textContent).toBeTruthy()
    f.click('开始本局')
    await Promise.resolve()
    expect(f.root.classList.toggle).toHaveBeenCalledWith('is-collapsed', true)
    expect(toggle.attributes['aria-expanded']).toBe('false')
    expect(f.root.children[2].textContent).toBeTruthy()
    toggle.listeners.click()
    expect(toggle.attributes['aria-expanded']).toBe('true')
    expect(f.root.classList.toggle).toHaveBeenCalledWith('is-collapsed', false)
    expect(f.runtime.snapshot().started).toBe(true)
  })
})

function pacedFixture() {
  vi.useFakeTimers()
  const f = fixture()
  let current = { turn: { phase: 'action' }, owner: 'opponent', pieces: [
    { instanceId: 'enemy', name: '死神', currentHp: 13, x: 2, y: 2 },
    { instanceId: 'ally', name: '乌瑟尔', currentHp: 15, x: 3, y: 2 },
  ], skillsById: { shot: { name: '射击' } } }
  f.hooks.getState = () => current
  f.hooks.setCue = vi.fn()
  f.engine.getCurrentInputOwnerPlayerId = state => state.owner
  f.engine.getBattleRootSeed = () => 228
  f.engine.hashBattleState = value => JSON.stringify(value)
  f.engine.prepareLegalBotAction = (_state, action) => action
  f.engine.planTutorialAiAction.mockImplementation(state => ({
    nextAction: { action: state.pieces[1].currentHp === 15
      ? { type: 'useBasicSkill', playerId: 'opponent', pieceId: 'enemy', targetPieceId: 'ally', skillId: 'shot' }
      : { type: 'endTurn', playerId: 'opponent' } },
    continuation: { turnKey: 'opponent:1:opponent', nodes: 1, elapsedMs: 0 },
    elapsedMs: 0, stopReason: 'selected',
  }))
  f.hooks.commit = vi.fn(async action => {
    current = action.type === 'endTurn' ? { ...current, owner: 'human' } : {
      ...current, pieces: current.pieces.map(p => p.instanceId === 'ally' ? { ...p, currentHp: 12 } : p),
    }
  })
  return f
}

describe('tutorial opponent pacing', () => {
  it('restores the crystal collection cue after an opponent turn without collecting it', async () => {
    vi.useFakeTimers()
    const f = fixture({ guidedOpening: { kind: 'charge', templateId: 'uther', targetTemplateId: 'reaper' } })
    let current = { turn: { phase: 'action' }, owner: 'human', players: [{ playerId: 'human', actionPoints: 3, chargePoints: 0 }], pieces: [
      { instanceId: 'ally', templateId: 'uther', ownerPlayerId: 'human', name: '乌瑟尔', x: 3, y: 2, currentHp: 15 },
      { instanceId: 'enemy', templateId: 'reaper', ownerPlayerId: 'opponent', name: '死神', x: 8, y: 2, currentHp: 13 },
    ] }
    f.hooks.getState = () => current
    f.hooks.setCue = vi.fn()
    f.engine.getCurrentInputOwnerPlayerId = state => state.owner
    f.engine.prepareLegalBotAction = (_state, action) => action
    f.engine.planBotActions.mockReturnValue({ actions: [
      { type: 'move', playerId: 'opponent', pieceId: 'enemy', toX: 7, toY: 2 },
      { type: 'endTurn', playerId: 'opponent' },
    ] })
    f.hooks.commit = vi.fn(async action => {
      current = action.type === 'endTurn' ? { ...current, owner: 'human' } : {
        ...current, pieces: current.pieces.map(p => p.instanceId === 'enemy' ? { ...p, x: action.toX, y: action.toY } : p),
      }
    })
    f.click('开始学习')
    await vi.advanceTimersByTimeAsync(0)
    await f.runtime.afterAcceptedAction({ type: 'deployReservePiece', playerId: 'human', pieceId: 'ally' }, current)
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'human', pieceId: 'ally' }, current)
    await f.runtime.afterAcceptedAction({ type: 'playCard', playerId: 'human' }, current)
    const beforeCrystal = current
    const crystals = [{ tileType: 'charge-crystal', x: 6, y: 2 }]
    current = { ...current, extensions: { tileEffects: crystals } }
    await f.runtime.afterAcceptedAction({ type: 'useBasicSkill', playerId: 'human', pieceId: 'ally' }, beforeCrystal)
    expect(f.runtime.snapshot().openingStep).toBe('collect')
    expect(f.hooks.setCue).toHaveBeenLastCalledWith({ cells: crystals })

    const beforeTurn = current
    current = { ...current, owner: 'opponent' }
    const playback = f.runtime.afterAcceptedAction({ type: 'endTurn', playerId: 'human' }, beforeTurn)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.hooks.setCue).toHaveBeenLastCalledWith({ cells: [{ x: 8, y: 2 }, { x: 7, y: 2 }] })
    await vi.runAllTimersAsync()
    await playback
    expect(f.hooks.commit).toHaveBeenCalledTimes(2)
    expect(f.runtime.snapshot().openingStep).toBe('collect')
    expect(f.runtime.snapshot().busy).toBe(false)
    expect(f.hooks.setCue).toHaveBeenLastCalledWith({ cells: crystals })
  })

  it('announces and highlights each action, holds its result, then hands control back', async () => {
    const f = pacedFixture()
    f.click('开始本局')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.root.children[1].textContent).toContain('死神使用射击 → 乌瑟尔')
    expect(f.hooks.setCue).toHaveBeenLastCalledWith({ cells: [{ x: 2, y: 2 }, { x: 3, y: 2 }] })
    await vi.advanceTimersByTimeAsync(999)
    expect(f.hooks.commit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.hooks.commit).toHaveBeenCalledTimes(1)
    expect(f.root.children[1].textContent).toContain('乌瑟尔受到 3 点伤害')
    expect(f.runtime.beforeAction({ type: 'move' }).allowed).toBe(false)
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.root.children[1].textContent).toContain('受到 3 点伤害')
    expect(f.hooks.commit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.root.children[1].textContent).toContain('看这里：对手结束回合')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.hooks.commit).toHaveBeenCalledTimes(2)
    expect(f.runtime.snapshot().busy).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.runtime.snapshot().busy).toBe(false)
    expect(f.runtime.beforeAction({ type: 'move' }).allowed).toBe(true)
    expect(f.engine.planTutorialAiAction).toHaveBeenCalledTimes(2)
    expect(f.engine.planTutorialAiAction.mock.calls[1][0].pieces[1].currentHp).toBe(12)
  })

  it('carries the search continuation through an opponent pending response and resets on a new turn', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let current = {
      turn: { phase: 'action', turnNumber: 3, currentPlayerId: 'opponent' }, owner: 'opponent',
      players: [{ playerId: 'human', actionPoints: 3, maxActionPoints: 3, chargePoints: 0 },
        { playerId: 'opponent', actionPoints: 3, maxActionPoints: 3, chargePoints: 0 }],
      pieces: [{ instanceId: 'enemy', ownerPlayerId: 'opponent', currentHp: 10, maxHp: 10, x: 2, y: 2 },
        { instanceId: 'ally', ownerPlayerId: 'human', currentHp: 10, maxHp: 10, x: 3, y: 2 }],
    }
    f.hooks.getState = () => current
    f.hooks.setCue = vi.fn()
    f.engine.getCurrentInputOwnerPlayerId = state => state.owner
    f.engine.getBattleRootSeed = () => 228
    f.engine.hashBattleState = state => JSON.stringify(state)
    let calls = 0
    f.engine.planTutorialAiAction.mockImplementation((_state, _player, _seed, options) => {
      calls += 1
      return {
        nextAction: { action: calls === 1
          ? { type: 'useBasicSkill', playerId: 'opponent', pieceId: 'enemy', skillId: 'shot' }
          : { type: 'endTurn', playerId: 'opponent' } },
        continuation: { turnKey: 'opponent:3:opponent', nodes: calls * 4, elapsedMs: calls * 5 },
        elapsedMs: 5, stopReason: 'selected',
        receivedOptions: options,
      }
    })
    f.hooks.commit = vi.fn(async action => {
      if (action.type === 'useBasicSkill') {
        current = { ...current, pendingOptionSelection: { playerId: 'human', selectionId: 'choice', stateRevision: 1 },
          owner: 'human' }
      } else {
        current = { ...current, owner: 'human', turn: { ...current.turn, turnNumber: 4, currentPlayerId: 'human' },
          pendingOptionSelection: undefined }
      }
    })
    f.click('开始本局')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.runtime.snapshot().busy).toBe(false)

    // Resolve the pending response while the same current player's turn is
    // still active. The continuation and accepted ordinary action count stay.
    const beforeChoice = current
    current = { ...current, pendingOptionSelection: undefined, owner: 'opponent' }
    const pendingPlayback = f.runtime.afterAcceptedAction({ type: 'pendingOptionSelect', playerId: 'human' }, beforeChoice)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await pendingPlayback
    expect(f.runtime.snapshot().busy).toBe(false)
    const secondOptions = f.engine.planTutorialAiAction.mock.calls[1][3]
    expect(secondOptions.continuation).toMatchObject({ nodes: 4, elapsedMs: 5 })
    expect(secondOptions.actionsTakenThisTurn).toBe(1)

    // Ending that turn changes both authority player and turn number, so the
    // next decision starts with a fresh budget.
    current = { ...current, owner: 'opponent', turn: { ...current.turn, turnNumber: 5, currentPlayerId: 'opponent' } }
    const nextTurnPlayback = f.runtime.afterAcceptedAction({ type: 'move', playerId: 'human' }, current)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await nextTurnPlayback
    const thirdOptions = f.engine.planTutorialAiAction.mock.calls[2][3]
    expect(thirdOptions.continuation).toBe(null)
    expect(thirdOptions.actionsTakenThisTurn).toBe(0)
  })

  it('replans after a stale opponent owner and reports planner or authority errors', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let current = { turn: { phase: 'action', turnNumber: 1, currentPlayerId: 'opponent' }, owner: 'opponent',
      players: [], pieces: [{ instanceId: 'enemy', ownerPlayerId: 'opponent', name: '敌人', currentHp: 10, maxHp: 10, x: 2, y: 2 }] }
    f.hooks.getState = () => current
    f.hooks.setCue = vi.fn()
    f.engine.getCurrentInputOwnerPlayerId = state => state.owner
    f.engine.getBattleRootSeed = () => 228
    f.engine.hashBattleState = state => JSON.stringify(state)
    f.engine.planTutorialAiAction.mockReturnValue({
      nextAction: { action: { type: 'move', playerId: 'opponent', pieceId: 'enemy', toX: 3, toY: 2 } },
      continuation: { turnKey: 'opponent:1:opponent', nodes: 1, elapsedMs: 0 }, elapsedMs: 0, stopReason: 'selected',
    })
    f.hooks.commit = vi.fn()
    f.click('开始本局')
    await vi.advanceTimersByTimeAsync(0)
    current = { ...current, owner: 'human' }
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.hooks.commit).not.toHaveBeenCalled()
    expect(f.runtime.snapshot().failure).toBe('')
    expect(f.runtime.snapshot().busy).toBe(false)

    const errorFixture = fixture()
    errorFixture.state.turn.currentPlayerId = 'opponent'
    errorFixture.hooks.getState = () => ({ turn: { phase: 'action', turnNumber: 1, currentPlayerId: 'opponent' }, owner: 'opponent', players: [], pieces: [] })
    errorFixture.engine.getCurrentInputOwnerPlayerId = state => state.owner
    errorFixture.engine.getBattleRootSeed = () => 228
    errorFixture.engine.hashBattleState = state => JSON.stringify(state)
    errorFixture.engine.planTutorialAiAction.mockImplementation(() => { throw new Error('搜索失败') })
    errorFixture.click('开始本局')
    await vi.waitFor(() => expect(errorFixture.runtime.snapshot().failure).toContain('搜索失败'))

    const rejectedFixture = fixture()
    let rejectedState = { turn: { phase: 'action', turnNumber: 1, currentPlayerId: 'opponent' }, owner: 'opponent', players: [], pieces: [] }
    rejectedFixture.hooks.getState = () => rejectedState
    rejectedFixture.engine.getCurrentInputOwnerPlayerId = state => state.owner
    rejectedFixture.engine.getBattleRootSeed = () => 228
    rejectedFixture.engine.hashBattleState = state => JSON.stringify(state)
    rejectedFixture.engine.planTutorialAiAction.mockReturnValue({
      nextAction: { action: { type: 'endTurn', playerId: 'opponent' } },
      continuation: { turnKey: 'opponent:1:opponent', nodes: 1, elapsedMs: 0 }, elapsedMs: 0, stopReason: 'selected',
    })
    rejectedFixture.hooks.commit = vi.fn(async () => { const error = new Error('规则拒绝'); error.code = 'RULE_REJECTED'; throw error })
    rejectedFixture.click('开始本局')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(rejectedFixture.runtime.snapshot().failure).toContain('权威拒绝'))
  })

  it('carries measured planning and stale authority-check time into the next plan', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let current = { turn: { phase: 'action', turnNumber: 1, currentPlayerId: 'opponent' }, owner: 'opponent',
      players: [], pieces: [{ instanceId: 'enemy', ownerPlayerId: 'opponent', name: '敌人', currentHp: 10, maxHp: 10, x: 2, y: 2 }] }
    f.hooks.getState = () => current
    f.hooks.setCue = vi.fn()
    f.engine.getCurrentInputOwnerPlayerId = state => state.owner
    f.engine.getBattleRootSeed = () => 228
    let hashCalls = 0
    f.engine.hashBattleState = state => {
      hashCalls += 1
      if (hashCalls === 2) f.clock.now += 7
      return JSON.stringify(state)
    }
    let calls = 0
    f.engine.planTutorialAiAction.mockImplementation((_state, owner, _seed, options) => {
      calls += 1
      if (calls === 1) {
        f.clock.now += 37
        return {
          nextAction: { action: { type: 'move', playerId: owner, pieceId: 'enemy', toX: 3, toY: 2 } },
          continuation: { turnKey: 'opponent:1:opponent', nodes: 1, elapsedMs: 0 }, elapsedMs: 5, stopReason: 'selected',
        }
      }
      return {
        nextAction: { action: { type: 'endTurn', playerId: owner } },
        continuation: { turnKey: 'opponent-2:1:opponent', nodes: 1, elapsedMs: 0 }, elapsedMs: 0, stopReason: 'selected',
        receivedOptions: options,
      }
    })
    f.click('开始本局')
    await vi.advanceTimersByTimeAsync(0)
    current = { ...current, owner: 'opponent-2' }
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.engine.planTutorialAiAction).toHaveBeenCalledTimes(2)
    expect(f.engine.planTutorialAiAction.mock.calls[1][3].continuation).toMatchObject({
      nodes: 1, elapsedMs: 39,
    })
    f.runtime.dispose()
    await vi.runAllTimersAsync()
  })

  it.each([500, 1500])('does not execute remaining actions after exit at %i ms', async time => {
    const f = pacedFixture()
    f.click('开始本局')
    await vi.advanceTimersByTimeAsync(time)
    const accepted = f.hooks.commit.mock.calls.length
    f.runtime.dispose()
    await vi.runAllTimersAsync()
    expect(f.hooks.commit).toHaveBeenCalledTimes(accepted)
    expect(f.hooks.setCue).toHaveBeenLastCalledWith(null)
  })
})

describe('autonomous tutorial runtime', () => {
  it('rejects the wrong teaching target before marking submission pending, allowing a corrected target', () => {
    const page = readFileSync('data/pages/battle.html', 'utf8')
    const source = page.match(/function submitTargetAction\(action, label\) \{[\s\S]*?\n    \}/)[0]
    const submitted = []
    const context = { targetSubmissionPending: null, tutorialActionAllowed: action => action.targetPieceId === 'uther',
      withClientActionId: action => ({ ...action, clientActionId: 'test' }), prepareFreshSelectionAction: action => action,
      red50Evidence: { targetCommands: [] }, pendingSkill: null, pendingCardAction: null,
      clearSkillPreview() {}, setStatusMsg() {}, renderTargetOverlay() {}, doAction: action => submitted.push(action) }
    runInNewContext(source, context)
    expect(context.submitTargetAction({ type: 'useBasicSkill', targetPieceId: 'jaina' }, '治疗')).toBe(false)
    expect(context.targetSubmissionPending).toBe(null)
    expect(context.submitTargetAction({ type: 'useBasicSkill', targetPieceId: 'uther' }, '治疗')).toBe(true)
    expect(submitted).toHaveLength(1)
  })
  it('accepts arbitrary actions after starting and releases no bot input on the human turn', async () => {
    const f = fixture()
    expect(f.runtime.beforeAction({ type: 'move' }).allowed).toBe(false)
    f.click('开始本局')
    expect(f.runtime.beforeAction({ type: 'endTurn' }).allowed).toBe(false)
    await vi.waitFor(() => expect(f.runtime.snapshot().busy).toBe(false))
    expect(f.runtime.beforeAction({ type: 'move' }).allowed).toBe(true)
    expect(f.runtime.beforeAction({ type: 'endTurn' }).allowed).toBe(true)
    expect(f.engine.planTutorialAiAction).not.toHaveBeenCalled()
    f.runtime.dispose()
    expect(f.runtime.beforeAction({ type: 'move' }).allowed).toBe(false)
  })

  it('keeps every simultaneous tip available in the visible review control', async () => {
    const f = fixture()
    f.click('开始本局')
    await vi.waitFor(() => expect(f.runtime.snapshot().busy).toBe(false))
    f.observe.mockReturnValue([{ key: 'move', text: '移动' }, { key: 'charge-gained', text: '充能' }, { key: 'crystal', text: '结晶' }])
    await f.runtime.afterAcceptedAction({ type: 'move' }, {})
    const review = f.root.children[4]
    expect(review.hidden).toBe(false)
    expect(review.children[0].textContent).toBe('本局提示回看')
    expect(review.children[1].children.map(item => item.textContent)).toEqual(['移动', '充能', '结晶'])
  })

  it('honors a real loss without waiting for educational actions', () => {
    const f = fixture()
    f.state.terminalResult = { winnerPlayerId: 'opponent', reason: 'core-eliminated' }
    f.runtime.showResult()
    expect(f.root.children[1].textContent).toContain('本局失败')
    expect(f.runtime.beforeAction({ type: 'move' }).allowed).toBe(false)
  })

  it('keeps AI deployment ownership distinct from ordinary two-sided training', () => {
    const page = readFileSync('data/pages/battle.html', 'utf8')
    const source = page.match(/function clientOwns\(pid\) \{[\s\S]*?\n    \}/)[0]
    const context = { TRAINING_MODE: true, TUTORIAL_MODE: true, params: new URLSearchParams('lesson=full-match'), myPlayerId: 'human' }
    runInNewContext(source, context)
    expect(context.clientOwns('human')).toBe(true)
    expect(context.clientOwns('opponent')).toBe(false)
    context.params = new URLSearchParams()
    expect(context.clientOwns('opponent')).toBe(true)
  })
})
