import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { Client, type Room } from '@colyseus/sdk'
import { expect, it } from 'vitest'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { FakeAuthorityRepository } from './fake-authority-repository'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } from '@/lib/game/battle-public-patch'
import { openHostTunnel } from '@/lib/server/relay/host-tunnel'
import { createRelay } from '../../multiplayer-relay/relay.mjs'
import { guestIdentity } from '../helpers/guest-identity'

async function port() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return value
}
function next(room: Room, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Missing ${type}`)) }, 8000)
    const unsubscribe = room.onMessage(type, data => { clearTimeout(timer); unsubscribe(); resolve(data) })
  })
}
async function snapshot(room: Room) { const value = next(room, 'battleSnapshot'); room.send('battleResync', {}); return value }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

it('authenticates real relay SDK guests, protects private hands, takes over after grace and returns control on rejoin', async () => {
  const authorityPort = await port(), relayPort = await port()
  const localUrl = `http://127.0.0.1:${authorityPort}`, relayUrl = `http://127.0.0.1:${relayPort}`
  const candidate = createColyseusBattleServer({ repository: new FakeAuthorityRepository(), requireIdentityProof: true, reconnectGraceMs: 100 })
  await candidate.server.listen(authorityPort, '127.0.0.1')
  const relay = createRelay({ publicOrigin: relayUrl })
  await new Promise<void>(resolve => relay.server.listen(relayPort, '127.0.0.1', resolve))
  const tunnel = await openHostTunnel({ relayUrl, localOrigin: localUrl, name: 'SDK authority', visible: false })
  const local = new Client(localUrl), remote = new Client(tunnel.published.url)
  const identities = Array.from({ length: 4 }, guestIdentity), rooms: Room[] = []
  const profileIdentity = getServerGameProfileIdentityV1()
  async function options(index: number, roomId: string, url = tunnel.published.url) {
    const { nonce } = await fetch(url + '/admission/challenge').then(r => r.json())
    return { product: true, mode: '2v2', playerId: identities[index].playerId, playerName: `P${index}`, alignment: 'light', profileIdentity, auth: identities[index].proof(nonce, roomId) }
  }
  try {
    await expect(local.create('battle', { product: true, playerId: identities[0].playerId, profileIdentity })).rejects.toThrow()
    await expect(local.create('battle', { restore: true, product: true, battleId: 'stolen' })).rejects.toThrow()
    rooms.push(await local.create('battle', await options(0, 'create', localUrl)))
    const roomId = rooms[0].roomId
    await expect(remote.joinById(roomId, { playerId: identities[1].playerId, profileIdentity })).rejects.toThrow()
    for (let index = 1; index < 4; index++) rooms.push(await remote.joinById(roomId, await options(index, roomId)))
    const pieces = getDemoPieceIds().map(id => getPieceById(id)!).filter(p => p.faction === 'good').slice(0, 8).map(p => ({ templateId: p.id, faction: p.faction }))
    for (let index = 0; index < 4; index++) await rooms[index].request('roomRpc', { method: 'rooms.action', data: { action: 'select-pieces', playerId: identities[index].playerId, alignment: 'light', pieces, profileIdentity } })
    for (let viewer = 0; viewer < 4; viewer++) {
      const current = await snapshot(rooms[viewer])
      expect(current.state.map).toMatchObject({ width: 24, height: 20 })
      for (let index = 0; index < 4; index++) {
        const player = current.state.players.find((p: any) => p.playerId === identities[index].playerId)
        if (index === viewer) expect(player.hand.filter((c: any) => c.cardId === 'lucky-coin')).toHaveLength(index === 3 ? 1 : 0)
        else expect(player.hand.every((c: any) => c.cardId === 'hidden')).toBe(true)
      }
      if (viewer !== 0) expect(current.state.deployment.offerPieceIds || []).toHaveLength(0)
    }
    const before = await snapshot(rooms[1])
    await rooms[0].leave()
    let advanced = before
    const deadline = Date.now() + 10000
    while (advanced.authorityVersion === before.authorityVersion && Date.now() < deadline) { await delay(150); advanced = await snapshot(rooms[1]) }
    expect(advanced.authorityVersion).toBeGreaterThan(before.authorityVersion)
    rooms[0] = await remote.joinById(roomId, await options(0, roomId))
    const restored = await snapshot(rooms[0])
    await delay(1200)
    expect((await snapshot(rooms[0])).authorityVersion).toBe(restored.authorityVersion)
    for (const index of [0, 3]) {
      const current = await snapshot(rooms[index]), receipt = next(rooms[index], 'battleReceipt')
      const playerId = identities[index].playerId, clientActionId = `relay-vote-${index}`
      rooms[index].send('battleCommand', { protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION, authorityBuildId: BATTLE_AUTHORITY_BUILD_ID, roomId, playerId, expectedAuthorityVersion: current.authorityVersion, clientActionId, command: { type: 'surrender', playerId, clientActionId } })
      expect(await receipt).toMatchObject({ kind: 'applied' })
    }
    expect((await snapshot(rooms[2])).state.terminalResult).toMatchObject({ winnerTeamId: 'red', winnerPlayerIds: identities.slice(1, 3).map(p => p.playerId) })
  } finally {
    for (const room of rooms) await room.leave()
    tunnel.close(); await relay.close(); await candidate.server.gracefullyShutdown(false)
  }
}, 40000)
