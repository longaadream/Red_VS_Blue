import { describe, expect, it } from 'vitest'

import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('player status identity persistence', () => {
  it('serializes a player status handle with an exact owner identity for pending flow', () => {
    const battle = makeState()
    const player = battle.players[0]
    player.statusTags = [{ id: 'mark', type: 'mark' }]
    const flow = createFlowRuntime(battle, { playerId: player.playerId }, 'skill', {})
    const handle = flow.status.instances(player.playerId, 'player').statuses[0]

    // Enumerating legacy statuses remains mutation-free until the reference is
    // actually persisted.
    expect(player.statusTags[0].instanceId).toBeUndefined()
    const serializedReference = JSON.parse(JSON.stringify(handle))
    expect(serializedReference).toEqual({
      scope: 'status-instance',
      ownerKind: 'player',
      playerId: player.playerId,
      instanceId: `${player.playerId}:status:0`,
    })

    const restored = JSON.parse(JSON.stringify(battle))
    const resumed = createFlowRuntime(restored, {}, 'pending', {})
    resumed.entityExtension.declare('status', serializedReference, 'content', 'uses', 'number', [], 1)
    resumed.entityExtension.write('status', serializedReference, 'content', 'uses', '', 'number', [], 2)

    expect(restored.players[0].statusTags[0].extension).toEqual({ uses: 2 })
    expect(restored.players[0].statusTags[0].instanceId).toBe(`${player.playerId}:status:0`)
  })

  it('does not rebind a retired player status reference after replacement and restore', () => {
    const battle = makeState()
    const player = battle.players[0]
    player.statusTags = [{ id: 'old-mark', type: 'mark' }]
    const flow = createFlowRuntime(battle, { playerId: player.playerId }, 'skill', {})
    const handle = flow.status.instances(player.playerId, 'player').statuses[0]
    const serializedReference = JSON.parse(JSON.stringify(handle))

    expect(flow.status.removeInstance(handle)).toBe(true)
    player.statusTags = [{ id: 'replacement-mark', type: 'mark' }]

    const restored = JSON.parse(JSON.stringify(battle))
    const resumed = createFlowRuntime(restored, {}, 'pending', {})
    expect(() => resumed.entityExtension.declare(
      'status', serializedReference, 'content', 'uses', 'number', [], 1,
    )).toThrow('已经失效')
    expect(restored.players[0].statusTags[0].instanceId).toBeUndefined()
    expect(restored.players[0].statusTags[0].extension).toBeUndefined()
  })

  it('reads piece status instances by stable id from active pieces and graveyard without minting ids', () => {
    const active = makeState({ pieces: [makePiece({ instanceId: 'active-piece', ownerPlayerId: 'player-red' })] })
    const activePiece = active.pieces[0]
    activePiece.statusTags = [{ id: 'active-mark', type: 'mark' }]
    active.graveyard = [{ ...activePiece, instanceId: 'departed', statusTags: [{ id: 'dead-mark', type: 'mark' }] }]
    const flow = createFlowRuntime(active, {}, 'skill', {})

    const activeResult = flow.status.instancesById(activePiece.instanceId)
    const graveyardResult = flow.status.instancesById('departed')
    const missingResult = flow.status.instancesById('missing')

    expect(activeResult.present).toBe(true)
    expect(activeResult.statuses).toHaveLength(1)
    expect(graveyardResult.present).toBe(true)
    expect(graveyardResult.statuses).toHaveLength(1)
    expect(missingResult).toEqual({ statuses: [], present: false })
    expect(activePiece.statusTags[0].instanceId).toBeUndefined()
    expect(active.graveyard[0].statusTags[0].instanceId).toBeUndefined()
  })
})
