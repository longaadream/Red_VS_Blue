import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { getPieceById } from '@/lib/game/piece-repository'
import { runBattleAction } from '@/lib/game/battle-runner'
import { listLegalAIActions } from '@/lib/game/ai-environment'
import { planBotActions, prepareLegalBotAction } from '@/lib/game/ai'
import { getCurrentInputOwnerPlayerId } from '@/lib/game/turn-timer'
import { dropChargeCrystal } from '@/lib/game/charge-crystals'

class Element {
  children = []; textContent = ''; listeners = {}; classList = { toggle() {} }
  setAttribute() {}
  append(...items) { this.children.push(...items) }
  appendChild(item) { this.append(item) }
  replaceChildren() { this.children = [] }
  addEventListener(name, callback) { this.listeners[name] = callback }
  remove() {}
}
beforeAll(async () => { vi.spyOn(console, 'log').mockImplementation(() => {}); await loadMaps() })

async function fixture(id) {
  const body = new Element()
  const sandbox = { document: { body, createElement: () => new Element() }, setTimeout: callback => callback() }
  for (const file of ['tutorial-lessons.js', 'tutorial-lesson-runtime.js']) runInNewContext(readFileSync('data/pages/js/tutorial/' + file, 'utf8'), sandbox)
  const lesson = sandbox.RvBTutorialLessons.get(id)
  let state = await sandbox.RvBTutorialLessons.createBattle({ createInitialBattleForPlayers, getPieceById }, lesson)
  let selected = null
  const engine = { getCurrentInputOwnerPlayerId, planBotActions, prepareLegalBotAction }
  function commit(action) {
    const skills = state.skillsById
    state = runBattleAction(state, action, { rootSeed: lesson.rootSeed }).state
    state.skillsById = skills
  }
  const runtime = sandbox.RvBTutorialLessonRuntime.create(lesson, { getState: () => state, getSelectedPieceId: () => selected,
    engine: async () => engine, commit, render() {}, setCue() {}, exit() {}, restart() {}, next() {} })
  const root = body.children[0]
  function labels() { return root.children[3].children.map(item => item.textContent) }
  async function settle() { await vi.waitFor(() => expect(runtime.snapshot().busy).toBe(false)); expect(runtime.snapshot().failure).toBe('') }
  async function click(label) { const button = root.children[3].children.find(item => item.textContent === label); expect(button, labels().join(',')).toBeDefined(); button.listeners.click(); await settle() }
  function select(templateId) { selected = state.pieces.find(p => p.templateId === templateId && p.ownerPlayerId === lesson.player.playerId).instanceId; runtime.afterIntent({ type: 'select-piece', pieceId: selected }) }
  async function act(action) { expect(runtime.beforeAction(action).allowed, runtime.snapshot().openingStep + ': ' + JSON.stringify(action)).toBe(true); const before = state; commit(action); await runtime.afterAcceptedAction(action, before); await settle() }
  async function legal(predicate) { const candidate = listLegalAIActions(state, lesson.player.playerId).find(c => predicate(c.action)); expect(candidate, 'legal candidate for ' + runtime.snapshot().openingStep).toBeDefined(); await act(candidate.action) }
  async function skill(skillId, targetTemplateId) { const target = state.pieces.find(p => p.templateId === targetTemplateId); await legal(a => a.skillId === skillId && a.targetPieceId === target.instanceId) }
  return { lesson, runtime, root, labels, click, select, act, legal, skill, state: () => state }
}

describe('six hands-on lessons', () => {
  it.each(['first-victory', 'reinforcements', 'protect-cores', 'terrain', 'charge', 'full-match'])('%s has no skip-to-battle or dismiss-guidance path', async id => {
    const f = await fixture(id)
    expect(f.labels()).toEqual(['开始学习', '返回课程'])
    await f.click('开始学习')
    expect(f.labels()).not.toContain('直接开打')
    expect(f.labels()).not.toContain('收起指导')
    expect(f.runtime.beforeAction({ type: 'endTurn', playerId: f.lesson.player.playerId }).allowed).toBe(false)
  })

  it.each(['first-victory', 'terrain'])('%s requires real selection, movement, skill and turn observation', async id => {
    const f = await fixture(id)
    await f.click('开始学习')
    if (id === 'terrain') f.runtime.afterIntent({ type: 'activate-cell', ...f.lesson.guidedOpening.moveTo })
    f.select('uther')
    expect(f.runtime.snapshot().openingStep).toBe('move')
    const position = f.lesson.guidedOpening.moveTo
    await f.legal(a => a.type === 'move' && a.toX === position.x && a.toY === position.y)
    expect(f.runtime.snapshot().openingStep).toBe('move-result')
    expect(f.runtime.beforeAction({ type: 'endTurn', playerId: f.lesson.player.playerId }).allowed).toBe(false)
    await f.click('学习使用技能')
    await f.skill('blessed-hammer', f.lesson.guidedOpening.targetTemplateId)
    expect(f.runtime.snapshot().openingStep).toBe('attack-result')
    await f.click('学习结束回合')
    await f.legal(a => a.type === 'endTurn')
    expect(f.runtime.snapshot().openingStep).toBe('review')
    await f.click('继续本局练习')
    expect(f.runtime.snapshot().openingStep).toBe('free')
    expect(f.labels()).not.toContain('收起指导')
  })

  it('protect-cores teaches healing and shield before moving and attacking', async () => {
    const f = await fixture('protect-cores')
    await f.click('开始学习')
    await f.skill('light-of-the-light', 'uther')
    expect(f.root.children[1].textContent).toContain('5 点生命')
    await f.click('学习圣光盾')
    await f.skill('shield-of-light', 'uther')
    await f.click('学习移动与反击')
    await f.legal(a => a.type === 'move' && a.toX === 7 && a.toY === 7 && a.pieceId === f.state().pieces.find(p => p.templateId === 'uther').instanceId)
    await f.click('学习使用技能')
    await f.skill('blessed-hammer', 'reaper')
    expect(f.runtime.snapshot().openingStep).toBe('attack-result')
  })

  it.each(['reinforcements', 'charge', 'full-match'])('%s teaches deployment, movement and playing a card in order', async id => {
    const f = await fixture(id)
    await f.click('开始学习')
    await f.legal(a => a.type === 'deployReservePiece')
    await f.click('学习本回合首移')
    await f.legal(a => a.type === 'move')
    await f.click('学习使用手牌')
    await f.legal(a => a.type === 'playCard')
    expect(f.runtime.snapshot().openingStep).toBe('card-result')
    const next = id === 'charge' ? '学习争夺结晶' : id === 'full-match' ? '学习安排技能' : '学习结束回合'
    await f.click(next)
    expect(f.runtime.snapshot().openingStep).toBe(id === 'charge' ? 'fight-crystal' : id === 'full-match' ? 'practice-skill' : 'end-turn')
  })

  it('charge handles contested crystals, actual pickup and a real charge skill, with terminal taking priority', async () => {
    const f = await fixture('charge')
    await f.click('开始学习')
    await f.legal(a => a.type === 'deployReservePiece')
    await f.click('学习本回合首移')
    await f.legal(a => a.type === 'move')
    await f.click('学习使用手牌')
    await f.legal(a => a.type === 'playCard')
    await f.click('学习争夺结晶')
    // Arrange the post-death crystal fixture; pickup and charge below use real rules.
    const move = listLegalAIActions(f.state(), f.lesson.player.playerId).find(c => c.action.type === 'move').action
    function crystal(id) { dropChargeCrystal(f.state(), { id, sourcePieceId: 'fallen-core-fixture', x: move.toX, y: move.toY }) }
    crystal('stolen')
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'training-blue' }, f.state())
    expect(f.runtime.snapshot().openingStep).toBe('collect')
    f.state().extensions.tileEffects = []
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'training-blue' }, f.state())
    expect(f.runtime.snapshot().openingStep).toBe('fight-crystal')
    crystal('available')
    await f.runtime.afterAcceptedAction({ type: 'move', playerId: 'training-blue' }, f.state())
    await f.act(move)
    expect(f.runtime.snapshot().openingStep).toBe('collect-result')
    await f.click('学习充能技能')
    // A normal turn restores AP when the pickup used the last point.
    await f.legal(a => a.type === 'endTurn')
    if (f.state().deployment.status === 'awaiting-reserve-deploy') await f.legal(a => a.type === 'deployReservePiece')
    await f.legal(a => a.type === 'useChargeSkill' && a.skillId === 'divine-blessing')
    expect(f.runtime.snapshot().openingStep).toBe('charge-result')
    await f.click('学习结束回合')
    await f.legal(a => a.type === 'endTurn')
    expect(f.runtime.snapshot().openingStep).toBe('review')
    f.state().terminalResult = { winnerPlayerId: 'training-blue', reason: 'core-eliminated' }
    f.runtime.showResult()
    expect(f.labels()).toContain('再试一次')
    expect(f.labels()).not.toContain('继续本局练习')
    expect(f.runtime.beforeAction(move).allowed).toBe(false)
  })
})
