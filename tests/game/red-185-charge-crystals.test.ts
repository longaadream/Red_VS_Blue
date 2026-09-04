/* eslint-disable @typescript-eslint/no-explicit-any -- focused engine fixtures use data-driven runtime shapes */
import { beforeEach, describe, expect, it } from 'vitest'

import { observeBattleForAIV2 } from '@/lib/game/ai-environment'
import { projectBattlePresentationEvents } from '@/lib/game/battle-presentation-events'
import { dropChargeCrystal } from '@/lib/game/charge-crystals'
import { dealDamage } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('RED-185 contested charge crystals', () => {
  beforeEach(() => globalTriggerSystem.clearRules())

  it('drops a neutral persistent crystal for a finalized core death without immediate CP', () => {
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    const victim = makePiece({
      instanceId: 'victim', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 3, maxHp: 3,
    }) as any
    victim.isCore = true
    const state = makeState({ pieces: [attacker, victim] }) as any
    const before = structuredClone(state)

    dealDamage(attacker, victim, 3, 'true', state, 'red185-drop')

    expect(state.players.map((player: any) => player.chargePoints)).toEqual([0, 0])
    expect(state.graveyard.map((piece: any) => piece.instanceId)).toContain('victim')
    expect(state.extensions.tileEffects).toEqual([
      expect.objectContaining({
        id: expect.stringContaining('charge-crystal:'),
        sourceId: 'victim',
        tileType: 'charge-crystal',
        x: 2,
        y: 0,
        visible: true,
      }),
    ])
    expect(state.actions).toContainEqual(expect.objectContaining({
      type: 'chargeCrystalDropped',
      playerId: 'neutral',
    }))
    expect(observeBattleForAIV2(state, 'player-red').boardEffects).toContainEqual(expect.objectContaining({
      type: 'charge-crystal', x: 2, y: 0,
    }))
    expect(projectBattlePresentationEvents({
      actionId: 'red185-drop',
      command: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'attacker', skillId: 'test' },
      beforeState: before,
      afterState: state,
    }).map(event => event.kind)).toContain('tileEffectAdded')
  })

  it.each([
    ['player-red', 'player-blue'],
    ['player-blue', 'player-red'],
  ] as const)('lets %s steal every crystal on a tile by ordinary movement', (collectorId, otherId) => {
    const collector = makePiece({
      instanceId: `collector-${collectorId}`,
      ownerPlayerId: collectorId,
      faction: collectorId === 'player-red' ? 'red' : 'blue',
      x: 0,
      y: 0,
    }) as any
    const state = makeState({ pieces: [collector], currentPlayerId: collectorId }) as any
    dropChargeCrystal(state, { id: 'crystal-a', sourcePieceId: 'fallen-a', x: 2, y: 0 })
    dropChargeCrystal(state, { id: 'crystal-b', sourcePieceId: 'fallen-b', x: 2, y: 0 })

    const next = applyBattleAction(state, {
      type: 'move', playerId: collectorId, pieceId: collector.instanceId, toX: 2, toY: 0,
    }) as any

    expect(next.players.find((player: any) => player.playerId === collectorId).chargePoints).toBe(2)
    expect(next.players.find((player: any) => player.playerId === otherId).chargePoints).toBe(0)
    expect(next.players.find((player: any) => player.playerId === collectorId).actionPoints).toBe(1)
    expect(next.extensions.tileEffects).toEqual([])
    expect(next.actions).toContainEqual(expect.objectContaining({
      type: 'chargeCrystalPickedUp',
      playerId: collectorId,
      payload: expect.objectContaining({ amount: 2, crystalIds: ['crystal-a', 'crystal-b'] }),
    }))
    const presentationKinds = projectBattlePresentationEvents({
      actionId: `collect-${collectorId}`,
      command: { type: 'move', playerId: collectorId, pieceId: collector.instanceId, toX: 2, toY: 0 },
      beforeState: state,
      afterState: next,
    }).map(event => event.kind)
    expect(presentationKinds).toContain('tileEffectRemoved')
    expect(presentationKinds).toContain('chargePoints')
  })

  it('does not passively collect on standing, summoning, or forced relocation', () => {
    const standing = makePiece({ instanceId: 'standing', x: 2, y: 0 }) as any
    let state = makeState({ pieces: [standing] }) as any
    dropChargeCrystal(state, { id: 'persistent', sourcePieceId: 'fallen', x: 2, y: 0 })

    state = applyBattleAction(state, { type: 'endTurn', playerId: 'player-red' }) as any
    state = applyBattleAction(state, { type: 'beginPhase' }) as any
    state = applyBattleAction(state, { type: 'beginPhase' }) as any
    state.pieces.push(makePiece({ instanceId: 'summoned', x: 2, y: 0 }) as any)
    standing.x = 1
    standing.y = 0
    standing.x = 2
    standing.y = 0

    expect(state.extensions.tileEffects).toEqual([
      expect.objectContaining({ id: 'persistent', tileType: 'charge-crystal', x: 2, y: 0 }),
    ])
    expect(state.players.map((player: any) => player.chargePoints)).toEqual([0, 0])
  })

  it('does not drop for non-core or noKillCharge deaths', () => {
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-red' }) as any
    const summon = makePiece({
      instanceId: 'summon', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 1, maxHp: 1,
    }) as any
    summon.isCore = false
    const excludedCore = makePiece({
      instanceId: 'excluded-core', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 1, maxHp: 1,
    }) as any
    excludedCore.isCore = true
    excludedCore.noKillCharge = true
    const state = makeState({ pieces: [attacker, summon, excludedCore] }) as any

    dealDamage(attacker, [summon, excludedCore], 1, 'true', state, 'red185-exclusions')

    expect(state.extensions.tileEffects ?? []).toEqual([])
    expect(state.players[0].chargePoints).toBe(0)
  })
})
