import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { listLegalAIActions } from '@/lib/game/ai-environment'
import { runBattleAction, hashBattleState } from '@/lib/game/battle-runner'
import { getPieceById } from '@/lib/game/piece-repository'
import { getCurrentInputOwnerPlayerId } from '@/lib/game/turn-timer'
import type { BattleState } from '@/lib/game/turn'

interface Lesson {
  id: string
  number: number
  tactical?: boolean
  standard?: boolean
  normalHealth?: boolean
  firstPlayerId?: string
  rootSeed: number
  size: number
  opponentSize: number
  opponentHp: number | null
  player: { playerId: string; roster: string[] }
  opponent: { playerId: string; roster: string[] }
}

interface LessonModule {
  all: Lesson[]
  get(id: string): Lesson | null
  createBattle(engine: object, lesson: Lesson): Promise<BattleState>
  PLAYER: string
  OPPONENT: string
}

const sandbox = {} as { RvBTutorialLessons: LessonModule }
runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lessons.js', 'utf8'), sandbox)
const lessons = sandbox.RvBTutorialLessons
const engine = { createInitialBattleForPlayers, getPieceById }

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await loadMaps()
})

describe('RED-230 tactical tutorial scenario', () => {
  it('defines a separate standard, full-roster lesson without changing the legacy six', () => {
    const lesson = lessons.get('tactical-intuition')!
    expect(lesson).toMatchObject({
      id: 'tactical-intuition', number: 7, tactical: true, standard: true, normalHealth: true,
      firstPlayerId: lessons.PLAYER, rootSeed: 18707, size: 8, opponentSize: 8, opponentHp: null,
    })
    expect(lesson.player.roster).toHaveLength(8)
    expect(lesson.opponent.roster).toHaveLength(8)
    expect(lessons.all.filter(candidate => !candidate.tactical).map(candidate => candidate.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(lessons.get('full-match')).toMatchObject({ number: 6, enabled: false, opponentSize: 4, opponentHp: 6 })
  })

  it('uses authoritative standard deployment with normal template health and player first', async () => {
    const lesson = lessons.get('tactical-intuition')!
    const state = await lessons.createBattle(engine, lesson)
    const allPieces = Object.values(state.deployment?.reserves ?? {}).flat().concat(state.pieces)

    expect(state.turn.currentPlayerId).toBe(lessons.PLAYER)
    expect(getCurrentInputOwnerPlayerId(state)).toBe(lessons.PLAYER)
    expect(allPieces.filter(piece => piece.ownerPlayerId === lessons.PLAYER).every(piece => piece.faction === 'red')).toBe(true)
    expect(allPieces.filter(piece => piece.ownerPlayerId === lessons.OPPONENT).every(piece => piece.faction === 'blue')).toBe(true)
    expect(state.deployment).toMatchObject({ mode: 'progressive-reserve-v1', openingVanguardsInitialized: true })
    expect(state.deployment?.status).toBe('awaiting-reserve-deploy')
    expect(state.extensions?.tutorialLesson).toMatchObject({ id: lesson.id, rootSeed: lesson.rootSeed, scenario: true })
    for (const playerId of [lessons.PLAYER, lessons.OPPONENT]) {
      const pieces = allPieces.filter(piece => piece.ownerPlayerId === playerId)
      expect(pieces).toHaveLength(8)
      expect(pieces.every(piece => piece.isCore && piece.currentHp === piece.maxHp)).toBe(true)
      expect(pieces.every(piece => piece.maxHp === getPieceById(piece.templateId)!.stats.maxHp)).toBe(true)
    }
    expect(state.pieces).toHaveLength(2)
    expect(Object.values(state.deployment?.reserves ?? {}).map(pieces => pieces.length)).toEqual([7, 7])
    expect(state.pieces.every(piece => Number.isInteger(piece.x) && Number.isInteger(piece.y))).toBe(true)
    expect(Object.values(state.deployment?.reserves ?? {}).flat().every(piece => piece.x === null && piece.y === null)).toBe(true)
  })

  it('accepts a real player deployment command and produces the same deterministic start for both entry modes', async () => {
    const lesson = lessons.get('tactical-intuition')!
    const guided = await lessons.createBattle(engine, lesson)
    const practice = await lessons.createBattle(engine, lesson)
    expect(hashBattleState(guided)).toBe(hashBattleState(practice))

    const candidate = listLegalAIActions(guided, lessons.PLAYER).find(item => item.action.type === 'deployReservePiece')
    expect(candidate).toBeDefined()
    const next = runBattleAction(guided, candidate!.action, { rootSeed: lesson.rootSeed }).state
    expect(next.pieces).toHaveLength(3)
    expect(next.pieces.filter(piece => piece.ownerPlayerId === lessons.PLAYER)).toHaveLength(2)
    expect(next.deployment?.reserveCounts?.[lessons.PLAYER]).toBe(6)
    expect(next.pieces.filter(piece => piece.ownerPlayerId === lessons.PLAYER).every(piece => piece.currentHp === piece.maxHp)).toBe(true)
  })

  it('exposes the tactical card and keeps it outside legacy grid progress', () => {
    const page = readFileSync('data/pages/tutorial.html', 'utf8')
    expect(page).toContain('class="tactical-feature"')
    expect(page).toContain('href="battle.html?mode=tutorial&lesson=tactical-intuition"')
    expect(page).toContain('href="battle.html?mode=tutorial&lesson=tactical-intuition&practice=1"')
    expect(page).toContain('const progressLessons = RvBTutorialLessons.all.filter(function (lesson) { return !lesson.tactical })')
    expect(page).toContain('const enabledLessons = progressLessons.filter(function (lesson) { return lesson.enabled !== false })')
    expect(page).not.toContain('完成五局即可开始真人对战')
  })
})
