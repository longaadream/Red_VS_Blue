import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

class Element {
  children = []
  textContent = ''
  classList = { toggle() {} }
  listeners = {}
  setAttribute() {}
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
  const sandbox = { document: { body, createElement: () => new Element() }, setTimeout,
    RvBTutorialLessons: { all: [1, 2, 3, 4, 5, 6], observe } }
  runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lesson-runtime.js', 'utf8'), sandbox)
  const engine = { getCurrentInputOwnerPlayerId: () => 'human', planBotActions: vi.fn() }
  const hooks = { getState: () => state, engine: async () => engine, render() {}, setCue() {}, exit: vi.fn(), restart() {}, next() {} }
  const runtime = sandbox.RvBTutorialLessonRuntime.create({ id: 'one', number: 1, title: '练习', intro: '开场', help: '思路', player: { playerId: 'human' }, ...lessonOverrides }, hooks)
  const root = body.children[0]
  function click(label) { root.children[3].children.find(item => item.textContent === label).listeners.click() }
  return { state, runtime, root, click, observe, engine, hooks }
}

afterEach(() => vi.useRealTimers())

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
  f.engine.prepareLegalBotAction = (_state, action) => action
  f.engine.planBotActions.mockReturnValue({ actions: [
    { type: 'useBasicSkill', pieceId: 'enemy', targetPieceId: 'ally', skillId: 'shot' },
    { type: 'endTurn' },
  ] })
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
    f.click('学习本回合首移')
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'human', pieceId: 'ally' }, current)
    f.click('学习使用手牌')
    await f.runtime.afterAcceptedAction({ type: 'playCard', playerId: 'human' }, current)
    f.click('学习争夺结晶')
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
      red50Evidence: { targetCommands: [] }, setStatusMsg() {}, renderTargetOverlay() {}, doAction: action => submitted.push(action) }
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
    expect(f.engine.planBotActions).not.toHaveBeenCalled()
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
    expect(f.root.children[1].textContent).toContain('这局失败了')
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
