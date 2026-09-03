import { describe, expect, it } from 'vitest'
import { planBotActions } from '@/lib/game/ai'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { planZeroStageAction } from '@/lib/game/ai-zero-stage-agent'
import { getPveAiProfile, planPveBotAction, pveBotTurnKey } from '@/lib/game/pve-ai'
import { hashBattleState } from '@/lib/game/battle-trace'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('PvE difficulty routing', () => {
  it('defaults legacy rooms to sample and restricts difficulty to the two server profiles', () => {
    expect(getPveAiProfile()).toEqual({ difficulty: 'easy', agentId: 'simple-v1', name: '简单 · sample-v1' })
    expect(getPveAiProfile('normal')).toEqual({ difficulty: 'normal', agentId: 'rvb-ai-zimse-v1', name: '普通 · zimse-v1' })
    for (const value of ['hard', 'rvb-ai-zimse-v1', '', null, 1, {}]) {
      expect(() => getPveAiProfile(value)).toThrow('PVE_DIFFICULTY_INVALID')
    }
  })

  it('keeps easy plans unchanged and normal returns only the current zero-stage choice', () => {
    const state = makeState({ pieces: [
      makePiece({ instanceId: 'red', ownerPlayerId: 'player-red', x: 0, y: 1 }),
      makePiece({ instanceId: 'blue', ownerPlayerId: 'player-blue', x: 5, y: 1 }),
    ] })
    const before = hashBattleState(state)
    expect(planPveBotAction(state, 'player-red', 122, 'easy', 0)).toEqual(planBotActions(state, 'player-red'))
    const plan = planPveBotAction(state, 'player-red', 122, 'normal', 0)
    expect(plan?.actions).toEqual([planZeroStageAction(state, 'player-red', 122).nextAction?.action])
    expect(hashBattleState(state)).toBe(before)
    const next = aiEnvironmentV1.simulate(state, planZeroStageAction(state, 'player-red', 122).nextAction!, { rootSeed: 122 })
    expect(next.accepted).toBe(true)
    expect(planPveBotAction(next.state, 'player-red', 122, 'normal', 7)?.actions).toEqual([
      { type: 'endTurn', playerId: 'player-red' },
    ])
    expect(planPveBotAction(state, 'player-blue', 122, 'normal', 0)).toBeUndefined()
  })

  it('keeps the same guard key across phases and pending interruptions, but not across turns', () => {
    const state = makeState()
    const key = pveBotTurnKey(state, 122)
    expect(pveBotTurnKey({ ...state, turn: { ...state.turn, phase: 'start' } }, 122)).toBe(key)
    expect(pveBotTurnKey({ ...state, turn: { ...state.turn, currentPlayerId: 'player-blue' } }, 122)).not.toBe(key)
    expect(pveBotTurnKey({ ...state, turn: { ...state.turn, turnNumber: 2 } }, 122)).not.toBe(key)
    expect(pveBotTurnKey(state, 123)).not.toBe(key)
  })
})
