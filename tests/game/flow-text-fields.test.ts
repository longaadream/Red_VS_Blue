import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '@/lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('flow text attribute authority', () => {
  it('uses team identity for 2v2 and normalized ownership for unteamed players', () => {
    const battle = makeState({
      pieces: [
        makePiece({ instanceId: 'red-a-piece', ownerPlayerId: 'red-a', faction: 'good' }),
        makePiece({ instanceId: 'red-b-piece', ownerPlayerId: 'red-b', faction: 'evil' }),
        makePiece({ instanceId: 'blue-piece', ownerPlayerId: 'blue-a', faction: 'good' }),
      ],
    })
    Object.assign(battle.pieces[0], { name: 'A' })
    Object.assign(battle.pieces[1], { name: 'B' })
    Object.assign(battle.pieces[2], { name: 'C' })
    battle.players[0].playerId = 'red-a'
    battle.players[0].teamId = 'red'
    battle.players[0].name = 'Red A'
    battle.players[1].playerId = 'red-b'
    battle.players[1].teamId = 'red'
    battle.players[1].name = 'Red B'
    battle.players.push({ ...battle.players[1], playerId: 'blue-a', teamId: 'blue', name: 'Blue A' })
    const flow = createFlowRuntime(battle, {}, 'rule', {})

    expect(flow.query.pieceText('red-a-piece', 'name')).toBe('A')
    expect(flow.query.pieceText('red-a-piece', 'faction')).toBe('team:red')
    expect(flow.query.pieceText('red-b-piece', 'faction')).toBe('team:red')
    expect(flow.query.pieceText('blue-piece', 'faction')).toBe('team:blue')
    expect(flow.query.playerText('red-a', 'name')).toBe('Red A')
    expect(flow.query.playerText('red-a', 'faction')).toBe('team:red')

    battle.players = [
      { ...battle.players[0], playerId: 'Owner-A', teamId: undefined, name: 'Owner A' },
      { ...battle.players[1], playerId: 'owner-b', teamId: undefined, name: 'Owner B' },
    ]
    expect(flow.query.pieceText('red-a-piece', 'faction')).toBe('owner:red-a')
    expect(flow.query.playerText('Owner-A', 'faction')).toBe('owner:owner-a')
    expect(flow.query.pieceText('red-a-piece', 'faction')).not.toBe('team:red')
    expect(() => flow.query.pieceText('red-a-piece', 'unknown')).toThrow('文本字段')
  })
})
