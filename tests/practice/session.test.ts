import { describe, expect, it } from 'vitest'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { getCurrentInputOwnerPlayerId } from '@/lib/game/turn-timer'
import { hashBattleState, runBattleActionIsolated } from '@/lib/game/battle-runner'
import { AI_ID, HUMAN_ID, choosePracticeRoster, createPracticeState, validateRoster } from '@/lib/practice/setup'
import { PracticeSession, publicPracticeAction } from '@/lib/practice/session'
import { observePractice } from '@/lib/practice/environment'
import type { BattleAction } from '@/lib/game/turn'

async function fixture(humanFirst = true) {
  const setup = { human: choosePracticeRoster('good', 7), ai: choosePracticeRoster('evil', 8), humanFirst, mapId: 'large-hole-arena', seed: 2003 }
  const state = await createPracticeState(setup, getServerGameProfileIdentityV1())
  return { setup, state }
}
describe('PVP practice authority and roster boundaries', () => {
  it('does not leak AI private choice values through the presentation command', () => {
    expect(publicPracticeAction({ type: 'pendingOptionSelect', playerId: AI_ID, selectedOption: 'secret-card' })).toEqual({ type: 'pendingOptionSelect', playerId: AI_ID })
    expect(publicPracticeAction({ type: 'useBasicSkill', playerId: AI_ID, pieceId: 'p1', skillId: 'recall', selectedOption: 3 })).not.toHaveProperty('selectedOption')
  })
  it('chooses deterministic legal rosters and prefers valid presets; rejects invalid explicit rosters', () => {
    const roster = choosePracticeRoster('evil', 1)
    expect(choosePracticeRoster('evil', 1)).toEqual(roster)
    expect(new Set(roster.pieceIds).size).toBe(8)
    expect(choosePracticeRoster('evil', 888, [roster])).toEqual(roster)
    expect(() => validateRoster({ ...roster, pieceIds: roster.pieceIds.slice(1) })).toThrow()
    expect(() => validateRoster({ ...roster, pieceIds: Array(8).fill(roster.pieceIds[0]) })).toThrow()
    expect(() => validateRoster({ ...roster, alignment: 'good' })).toThrow()
    expect(choosePracticeRoster('evil', 1, [{ ...roster, pieceIds: ['missing'] }])).toEqual(roster)
  })
  it.each([true, false])('creates normal progressive PVP resources with humanFirst=%s', async humanFirst => {
    const { state } = await fixture(humanFirst)
    expect(state.deployment?.mode).toBe('progressive-reserve-v1')
    expect(state.players.find(p => p.playerId === (humanFirst ? HUMAN_ID : AI_ID))?.actionPoints).toBe(1)
    expect(state.players.every(p => p.maxActionPoints !== 10)).toBe(true)
    expect(getCurrentInputOwnerPlayerId(state)).toBe(humanFirst ? HUMAN_ID : AI_ID)
    expect(state.pieces.length + Object.values(state.deployment?.reserves ?? {}).flat().length).toBe(16)
  })
  it('rejects wrong owners, management commands and stale revisions without changing state', async () => {
    const { state, setup } = await fixture()
    const hash = hashBattleState(state)
    const session = new PracticeSession(state, setup.seed)
    expect(() => session.human({ type: 'grantChargePoints', playerId: HUMAN_ID, amount: 50 } as BattleAction, 0)).toThrow()
    expect(() => session.human({ type: 'endTurn', playerId: AI_ID }, 0)).toThrow()
    expect(() => session.human({ type: 'endTurn', playerId: HUMAN_ID }, 12)).toThrow()
    expect(() => session.step(0)).toThrow('玩家')
    expect(hashBattleState(state)).toBe(hash)
    expect(session.snapshot().revision).toBe(0)
    const candidate = aiEnvironmentV1.listLegalActions(state, HUMAN_ID)[0]
    const accepted = session.human(candidate.action, 0)
    expect(accepted.revision).toBe(1)
    expect(hashBattleState(state)).toBe(hash)
    expect(() => session.human(candidate.action, 0)).toThrow('过期')
  })
  it('projects human-only offers and hands; snapshots cannot modify the authority', async () => {
    const { state, setup } = await fixture(false)
    const session = new PracticeSession(state, setup.seed)
    const result = session.snapshot()
    expect(result.state.deployment?.offerPieces).toEqual([])
    expect(result.state.deployment?.reserves).toEqual({})
    expect(result.state.players.find(p => p.playerId === AI_ID)?.hand.every(c => c.cardId === 'hidden')).toBe(true)
    expect(result.state.extensions?.debugBattle).toBeUndefined()
    expect(result.state.actions).toEqual([])
    result.state.pieces[0].currentHp = -1
    expect(session.snapshot().state.pieces[0].currentHp).toBeGreaterThan(0)
    const observation = observePractice(state, AI_ID)
    expect(observation.players.find(p => p.playerId === HUMAN_ID)?.hand).toBeUndefined()
  })
  it('hands an AI-turn human pending back to the human and does not reset the real turn', async () => {
    const { state, setup } = await fixture(false)
    // Public owner routing must take pending over active turn/deployment.
    state.pendingOptionSelection = { playerId: HUMAN_ID, title: 'response', options: [] } as NonNullable<typeof state.pendingOptionSelection>
    const session = new PracticeSession(state, setup.seed)
    expect(session.snapshot().inputOwner).toBe(HUMAN_ID)
    expect(() => session.step(0)).toThrow('玩家')
    expect(session.snapshot().state.turn.currentPlayerId).toBe(AI_ID)
  })
  it('uses the exact official reducer for a valid human deployment and surrender terminal', async () => {
    const { state, setup } = await fixture()
    const candidate = aiEnvironmentV1.listLegalActions(state, HUMAN_ID)[0]
    const expected = runBattleActionIsolated(state, { ...candidate.action, playerId: HUMAN_ID } as BattleAction, { rootSeed: setup.seed }).state
    const session = new PracticeSession(state, setup.seed)
    const result = session.human(candidate.action, 0)
    expect(result.state.pieces.map(p => [p.instanceId, p.x, p.y, p.currentHp])).toEqual(expected.pieces.map(p => [p.instanceId, p.x, p.y, p.currentHp]))
    const ended = session.human({ type: 'surrender', playerId: HUMAN_ID }, result.revision)
    expect(ended.state.terminalResult?.winnerPlayerId).toBe(AI_ID)
    expect(() => session.step(ended.revision)).toThrow('结束')
  })
})
