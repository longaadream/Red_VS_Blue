import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { getPieceById } from '@/lib/game/piece-repository'
import { runBattleAction, hashBattleState } from '@/lib/game/battle-runner'
import { listLegalAIActions } from '@/lib/game/ai-environment'
import { planBotActions, prepareLegalBotAction } from '@/lib/game/ai'
import { getCurrentInputOwnerPlayerId } from '@/lib/game/turn-timer'
import { toPublicBattleState } from '@/lib/game/deployment'
import type { BattleState, BattleAction } from '@/lib/game/turn'

interface Lesson { id: string; size: number; opponentSize: number; opponentHp: number; rootSeed: number }
interface LessonModule {
  all: Lesson[]
  get(id: string): Lesson
  PLAYER: string
  OPPONENT: string
  createBattle(engine: object, lesson: Lesson): Promise<BattleState>
  observe(lesson: Lesson, before: BattleState, after: BattleState, action: BattleAction, seen: Set<string>): unknown[]
}
const sandbox = {} as { RvBTutorialLessons: LessonModule }
runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lessons.js', 'utf8'), sandbox)
const lessons = sandbox.RvBTutorialLessons
const engine = { createInitialBattleForPlayers, getPieceById }
beforeAll(async () => { vi.spyOn(console, 'log').mockImplementation(() => undefined); await loadMaps() })

describe('six independent tutorial scenarios', () => {
  it.each(lessons.all.map(l => [l.id, l] as const))('stages %s with real cores and can accept authoritative actions', async (_id, lesson) => {
    const state = await lessons.createBattle(engine, lesson) as BattleState
    expect(state.terminalResult).toBeUndefined()
    for (const player of state.players) {
      const board = state.pieces.filter(p => p.ownerPlayerId === player.playerId)
      const reserve = state.deployment?.reserves?.[player.playerId] ?? []
      expect(board.length + reserve.length).toBe(player.playerId === lessons.OPPONENT ? lesson.opponentSize : lesson.size)
      if (player.playerId === lessons.OPPONENT) {
        for (const piece of board.concat(reserve)) {
          expect(piece.currentHp).toBe(lesson.opponentHp)
          expect(piece.maxHp).toBe(getPieceById(piece.templateId)!.stats.maxHp)
          expect(piece.attack).toBe(getPieceById(piece.templateId)!.stats.attack)
        }
      }
      expect(board.every(p => p.isCore && p.currentHp > 0)).toBe(true)
      expect(new Set(board.map(p => `${p.x},${p.y}`)).size).toBe(board.length)
    }
    const owner = getCurrentInputOwnerPlayerId(state)!
    const legal = listLegalAIActions(state, owner)
    expect(legal.length).toBeGreaterThan(0)
    const next = runBattleAction(state, legal[0].action, { rootSeed: lesson.rootSeed }).state
    expect(next).toBeDefined()
    expect(hashBattleState(await lessons.createBattle(engine, lesson))).toBe(hashBattleState(state))
  })

  it('keeps terminal victory independent of remaining educational events', async () => {
    const lesson = lessons.get('first-victory')
    let state = await lessons.createBattle(engine, lesson) as BattleState
    // An alternative legal route: surrender is a real terminal result, never a tutorial completion.
    const result = runBattleAction(state, { type: 'surrender', playerId: lessons.PLAYER }, { rootSeed: lesson.rootSeed }).state
    expect(result.terminalResult?.reason).toBe('surrender')
    expect(lessons.observe(lesson, state, result, { type: 'surrender', playerId: lessons.PLAYER }, new Set())).toEqual([])
    state = result
    expect(planBotActions(state, lessons.OPPONENT)).toBeUndefined()
  })

  it('projects local reserve candidates for the owning viewer without changing authority', async () => {
    let state = await lessons.createBattle(engine, lessons.get('full-match'))
    state = runBattleAction(state, { type: 'beginPhase' }, { rootSeed: lessons.get('full-match').rootSeed }).state
    const playerId = getCurrentInputOwnerPlayerId(state)!
    const beforeHash = hashBattleState(state)
    const page = readFileSync('data/pages/battle.html', 'utf8')
    const source = page.match(/let tutorialDeploymentViewCache = null[\s\S]*?\n    function resolveDeploymentOfferPiece/)![0].replace(/\n    function resolveDeploymentOfferPiece$/, '')
    const context = { TUTORIAL_MODE: true, params: new URLSearchParams('lesson=full-match'), G: state, myPlayerId: playerId,
      window: { GameEngine: { toPublicBattleState } } } as { TUTORIAL_MODE: boolean; params: URLSearchParams; G: BattleState; myPlayerId: string; window: object; presentedDeployment(): BattleState['deployment'] }
    runInNewContext(source, context)
    expect(context.presentedDeployment()?.offerPieces?.length).toBeGreaterThan(0)
    context.myPlayerId = state.players.find(p => p.playerId !== playerId)!.playerId
    expect(context.presentedDeployment()?.offerPieces).toEqual([])
    expect(hashBattleState(state)).toBe(beforeHash)
  })

  it.each(['first-victory', 'reinforcements', 'protect-cores', 'terrain', 'charge', 'full-match'])('runs %s to a real terminal using existing bot policies', async id => {
    const lesson = lessons.get(id)
    let state = await lessons.createBattle(engine, lesson) as BattleState
    let commands = 0
    while (!state.terminalResult && commands < 1600) {
      const owner = getCurrentInputOwnerPlayerId(state)!
      const plan = planBotActions(state, owner)
      expect(plan, `no plan at turn ${state.turn.turnNumber}, phase ${state.turn.phase}`).toBeDefined()
      let applied = 0
      for (const draft of plan!.actions) {
        if (state.terminalResult || getCurrentInputOwnerPlayerId(state) !== owner) break
        const action = prepareLegalBotAction(state, draft, owner)
        if (!action) continue
        const skills = state.skillsById
        const beforeHash = hashBattleState(state)
        try {
          state = runBattleAction(state, action, { rootSeed: lesson.rootSeed }).state
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'BattleRuleError') throw error
          expect(hashBattleState(state)).toBe(beforeHash)
          continue
        }
        state.skillsById = skills
        applied++; commands++
      }
      expect(applied, 'bot must make progress').toBeGreaterThan(0)
    }
    expect(state.terminalResult, `no terminal after ${commands} commands`).toBeDefined()
    console.info(`[tutorial-length] ${id}: ${commands} commands, turn ${state.turn.turnNumber}, winner ${state.terminalResult?.winnerPlayerId}`)
  }, 120000)
})
