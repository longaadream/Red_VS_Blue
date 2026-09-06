import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

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

function fixture() {
  const body = new Element()
  const state = { turn: { phase: 'action' } }
  const observe = vi.fn(() => [])
  const sandbox = { document: { body, createElement: () => new Element() }, setTimeout,
    RvBTutorialLessons: { all: [1, 2, 3, 4, 5, 6], observe } }
  runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lesson-runtime.js', 'utf8'), sandbox)
  const engine = { getCurrentInputOwnerPlayerId: () => 'human', planBotActions: vi.fn() }
  const hooks = { getState: () => state, engine: async () => engine, render() {}, setCue() {}, exit: vi.fn(), restart() {}, next() {} }
  const runtime = sandbox.RvBTutorialLessonRuntime.create({ id: 'one', number: 1, title: '练习', intro: '开场', help: '思路', player: { playerId: 'human' } }, hooks)
  const root = body.children[0]
  function click(label) { root.children[3].children.find(item => item.textContent === label).listeners.click() }
  return { state, runtime, root, click, observe, engine }
}

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
