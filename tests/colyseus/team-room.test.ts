import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { Client, type Room } from '@colyseus/sdk'
import { expect, it } from 'vitest'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { FakeAuthorityRepository } from './fake-authority-repository'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } from '@/lib/game/battle-public-patch'

function nextMessage(room: Room, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Missing ${type}`)) }, 10000)
    const unsubscribe = room.onMessage(type, data => { clearTimeout(timer); unsubscribe(); resolve(data) })
  })
}
async function snapshot(room: Room) {
  const result = nextMessage(room, 'battleSnapshot')
  room.send('battleResync', {})
  return result
}
it('four real clients lock rosters and only unanimous team surrender settles for both winning players', async () => {
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const candidate = createColyseusBattleServer({ repository: new FakeAuthorityRepository() })
  await candidate.server.listen(port, '127.0.0.1')
  const client = new Client(`ws://127.0.0.1:${port}`)
  const profileIdentity = getServerGameProfileIdentityV1()
  const rooms: Room[] = []
  try {
    for (let i = 0; i < 4; i++) {
      const options = { product: true, mode: '2v2', playerId: `team-p${i}`, playerName: `P${i}`, alignment: 'light', profileIdentity }
      rooms.push(i === 0 ? await client.create('battle', options) : await client.joinById(rooms[0].roomId, options))
    }
    const room = await rooms[0].request('roomRpc', { method: 'rooms.get', data: {} }) as any
    expect(room.players.map((p: any) => p.seat)).toEqual(['blue', 'red', 'red', 'blue'])
    expect(room.maxPlayers).toBe(4)
    await expect(client.joinById(room.id, { playerId: 'fifth', profileIdentity })).rejects.toThrow()
    const pieces = getDemoPieceIds().map(id => getPieceById(id)!).filter(p => p.faction === 'good').slice(0, 8).map(p => ({ templateId: p.id, faction: p.faction }))
    for (let i = 0; i < 4; i++) await rooms[i].request('roomRpc', { method: 'rooms.action', data: { action: 'select-pieces', playerId: `team-p${i}`, alignment: 'light', pieces, profileIdentity } })
    const initial = await snapshot(rooms[0])
    expect(initial.state.players.map((p: any) => p.playerId)).toEqual(['team-p0', 'team-p1', 'team-p2', 'team-p3'])
    expect(initial.state.players.map((p: any) => p.teamId)).toEqual(['blue', 'red', 'red', 'blue'])
    expect(initial.state.turn.currentPlayerId).toBe('team-p0')
    async function surrender(index: number) {
      const current = await snapshot(rooms[index])
      const receipt = nextMessage(rooms[index], 'battleReceipt')
      const playerId = `team-p${index}`
      const clientActionId = `vote-${index}`
      rooms[index].send('battleCommand', { protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION, authorityBuildId: BATTLE_AUTHORITY_BUILD_ID, roomId: room.id, playerId, expectedAuthorityVersion: current.authorityVersion, clientActionId, command: { type: 'surrender', playerId, clientActionId } })
      expect(await receipt).toMatchObject({ kind: 'applied' })
    }
    await surrender(0)
    expect((await snapshot(rooms[0])).state.terminalResult).toBeUndefined()
    await surrender(3)
    expect((await snapshot(rooms[1])).state.terminalResult).toMatchObject({ winnerTeamId: 'red', winnerPlayerIds: ['team-p1', 'team-p2'], loserPlayerIds: ['team-p0', 'team-p3'] })
  } finally {
    for (const room of rooms) await room.leave()
    await candidate.server.gracefullyShutdown(false)
  }
}, 60000)
