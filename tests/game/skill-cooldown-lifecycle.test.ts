import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBattleAction } from '@/lib/game/battle-runner'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makePlayer, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 20613
function step(state: BattleState, action: BattleAction) {
  const next = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
  // The runner omits the presentation cache; rehydrate this test-only definition.
  next.skillsById = state.skillsById
  return next
}

function fixture(cooldownTurns = 2) {
  const red = makePiece({ instanceId: 'red', ownerPlayerId: 'player-red', skills: [
    { skillId: 'cooldown-probe', currentCooldown: 0 },
  ] })
  const blue = makePiece({ instanceId: 'blue', ownerPlayerId: 'player-blue', x: 3, skills: [
    { skillId: 'cooldown-probe', currentCooldown: 3 },
  ] })
  const state = makeState({ pieces: [red, blue], turnNumber: 5 })
  state.skillsById['cooldown-probe'] = {
    id: 'cooldown-probe', name: 'Cooldown probe', description: '', icon: '',
    kind: 'active', type: 'normal', cooldownTurns, maxCharges: 0,
    powerMultiplier: 1, actionPointCost: 0, range: 'self', requiresTarget: false,
    code: 'function executeSkill() { return { success: true }; }',
  }
  return state
}

describe('RED-206 owner end-turn skill cooldowns', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it.each([1, 2])('preserves the recast interval of a %i-turn skill', cooldownTurns => {
    let state = fixture(cooldownTurns)
    const cast: BattleAction = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'red', skillId: 'cooldown-probe' }
    state = step(state, cast)
    expect(state.pieces[0].skills[0].currentCooldown).toBe(cooldownTurns)
    expect(() => step(state, cast)).toThrow(/cooldown/)
    state = step(state, { type: 'endTurn', playerId: 'player-red' })
    expect(state.pieces.map(piece => piece.skills[0].currentCooldown)).toEqual([cooldownTurns - 1, 3])
    for (let ownTurn = 1; ownTurn <= cooldownTurns; ownTurn++) {
      state = step(state, { type: 'beginPhase' })
      expect(state.pieces[0].skills[0].currentCooldown).toBe(cooldownTurns - ownTurn)
      state = step(state, { type: 'endTurn', playerId: 'player-blue' })
      state = step(state, { type: 'beginPhase' })
      expect(state.pieces[0].skills[0].currentCooldown).toBe(cooldownTurns - ownTurn)
      if (ownTurn < cooldownTurns) {
        expect(() => step(state, cast)).toThrow(/cooldown/)
        state = step(state, { type: 'endTurn', playerId: 'player-red' })
      }
    }
    expect(step(state, cast).pieces[0].skills[0].currentCooldown).toBe(cooldownTurns)
  })

  it('does not refresh skills during beginPhase and never decrements zero below zero', () => {
    let state = fixture()
    state.turn.phase = 'start'
    state.pieces[0].skills[0].currentCooldown = 2
    state.pieces[0].skills.push({ skillId: 'ready', currentCooldown: 0 }, { skillId: 'unset' })
    state = step(state, { type: 'beginPhase' })
    state = step(state, { type: 'beginPhase' })
    expect(state.pieces[0].skills.map(skill => skill.currentCooldown)).toEqual([2, 0, undefined])
    state = step(state, { type: 'endTurn', playerId: 'player-red' })
    expect(state.pieces[0].skills.map(skill => skill.currentCooldown)).toEqual([1, 0, undefined])
    expect(state.pieces[1].skills[0].currentCooldown).toBe(3)
  })

  it('rejects repeated endTurn without refreshing cooldowns or replaying end effects', () => {
    const initial = fixture()
    initial.pieces[0].skills[0].currentCooldown = 3
    const ended = step(initial, { type: 'endTurn', playerId: 'player-red' })
    const before = JSON.stringify(ended)
    expect(() => step(ended, { type: 'endTurn', playerId: 'player-red' })).toThrow(/already ended/)
    expect(JSON.stringify(ended)).toBe(before)
    expect(ended.pieces[0].skills[0].currentCooldown).toBe(2)
  })

  it('only refreshes the ending owner in a four-player match, including allied pieces', () => {
    const initial = fixture()
    initial.players.push(makePlayer('red-ally', 'red'), makePlayer('blue-ally', 'blue'))
    for (const player of initial.players) player.teamId = player.playerId.includes('red') ? 'red' : 'blue'
    for (const player of initial.players.slice(2)) {
      const piece = makePiece({ instanceId: player.playerId, ownerPlayerId: player.playerId, faction: player.teamId,
        x: initial.pieces.length, skills: [{ skillId: 'cooldown-probe', currentCooldown: 2 }] })
      initial.pieces.push({ ...piece, buffs: [], debuffs: [], ruleTags: [] } as BattleState['pieces'][number])
    }
    initial.pieces[0].skills[0].currentCooldown = 2
    const ended = step(initial, { type: 'endTurn', playerId: 'player-red' })
    expect(ended.pieces.map(piece => piece.skills[0].currentCooldown)).toEqual([1, 3, 2, 2])
  })
})
