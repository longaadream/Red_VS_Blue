import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeSkillFunction } from '@/lib/game/skills'
import { runBattleAction } from '@/lib/game/battle-runner'
import { compactBattleTraceForAuthority, recordBattleInitialization } from '@/lib/game/battle-trace'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'
import { pinTestBattleState } from './profile-test-identity'
import { prepareAction } from '@/lib/game/targeting'

describe('hand instance identity after authority trace compaction', () => {
  it.each([false, true])('keeps generated duplicate cards distinct with compaction=%s', (compact) => {
    const definition = JSON.parse(readFileSync(join(process.cwd(), 'data/skills/turalyon-expedition-order.json'), 'utf8'))
    const caster = makePiece({ instanceId: 'turalyon', templateId: 'turalyon', skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }] })
    const lament = JSON.parse(readFileSync('data/skills/muru-lament.json', 'utf8'))
    const liadrin = makePiece({ instanceId: 'liadrin', templateId: 'liadrin', x: 1,
      skills: [{ skillId: lament.id, currentCooldown: 0, usesRemaining: -1 }] })
    let state = makeState({ pieces: [caster, liadrin, makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4 })] })
    state.skillsById[definition.id] = definition
    pinTestBattleState(state as unknown as Record<string, unknown>, 109)
    const runtime = new RuleRuntime({ rootSeed: 109 })
    // Model an opening effect that already consumes the card ID stream.
    const opening = withRuleRuntime(runtime, () => executeSkillFunction(definition, {
      piece: caster, battle: state, playerId: caster.ownerPlayerId,
      selectedOption: 'holy-charge', skill: definition,
    } as never, state))
    expect(opening.success).toBe(true)
    recordBattleInitialization(state, runtime, ['player-red', 'player-blue'])
    for (let ownTurn = 0; ownTurn < 2; ownTurn += 1) {
      // Supply the next own-turn state without coupling this identity regression
      // to the turn scheduler or the skill's two-turn cooldown.
      state.turn.turnNumber = 1 + ownTurn * 4
      state.players[0].actionPoints = 2
      state.pieces[0].skills[0].currentCooldown = 0
      state.skillsById = { [definition.id]: definition }
      const action = {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId,
        skillId: definition.id,
      }
      const prepared = prepareAction(state, action as never)
      expect(prepared.kind).toBe('needOption')
      if (prepared.kind !== 'needOption') throw new Error('Expected hand type selection')
      state = runBattleAction(state, {
        ...action, selectedOption: 'holy-charge', selectionId: prepared.selectionId,
        stateRevision: prepared.stateRevision,
      } as never).state
      if (compact) state = compactBattleTraceForAuthority(state)
    }
    const hand = state.players[0].hand
    expect(hand).toHaveLength(3)
    expect(new Set(hand.map(card => card.instanceId)).size).toBe(hand.length)

    state.skillsById = { [lament.id]: lament }
    state.players[0].actionPoints = 3
    state.players[0].chargePoints = 3
    state = runBattleAction(state, { type: 'useChargeSkill', playerId: 'player-red',
      pieceId: liadrin.instanceId, skillId: lament.id }).state
    const pending = state.pendingOptionSelection!
    expect(pending.options).toHaveLength(3)
    const selectedOption = hand.slice(0, 2).map(card => card.instanceId)
    state = runBattleAction(state, { type: 'pendingOptionSelect', playerId: 'player-red',
      selectionId: pending.selectionId, stateRevision: pending.stateRevision, selectedOption }).state
    expect(state.pendingOptionSelection).toBeUndefined()
    expect(state.players[0].hand.map(card => card.instanceId)).toEqual([hand[2].instanceId])
    expect(state.players[0].discardPile).toEqual(['holy-charge', 'holy-charge'])
  })
})
