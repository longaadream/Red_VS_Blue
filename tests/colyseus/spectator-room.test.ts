import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { Client, type Room } from '@colyseus/sdk'
import { expect, it, vi } from 'vitest'
import { matchMaker, type Client as ServerClient } from 'colyseus'
import type { Room as GameRoom } from '@/lib/game/room-model'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { FakeAuthorityRepository } from './fake-authority-repository'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { openHostTunnel } from '@/lib/server/relay/host-tunnel'
import { createRelay } from '../../multiplayer-relay/relay.mjs'
import type { PublicBattleSnapshot } from '@/lib/game/room-battle-actions'
import { guestIdentity } from '../helpers/guest-identity'
import { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } from '@/lib/game/battle-public-patch'

async function port() {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const value = (socket.address() as AddressInfo).port; await new Promise<void>(resolve => socket.close(() => resolve())); return value
}
function next<T = unknown>(room: Room, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Missing ${type}`)) }, 5000)
    const unsubscribe = room.onMessage(type, data => { clearTimeout(timer); unsubscribe(); resolve(data as T) })
  })
}
async function snapshot(room: Room) { const result = next<PublicBattleSnapshot>(room, 'battleSnapshot'); room.send('battleResync', {}); return result }
type RoomView = { id: string; inviteCode?: string; spectatorCount: number; players: Array<{ id: string }> }
const rpc = (room: Room, method: string, data = {}): Promise<RoomView> => room.request('roomRpc', { method, data }) as Promise<RoomView>

it.each(['1v1', '2v2'] as const)('%s admits eight read-only spectators through relay without consuming seats; privacy, reconnect and host closure hold', async mode => {
  const localUrl = `http://127.0.0.1:${await port()}`, relayUrl = `http://127.0.0.1:${await port()}`
  const authority = createColyseusBattleServer({ repository: Object.assign(new FakeAuthorityRepository(), { readBattleReport: async () => undefined }), requireIdentityProof: true })
  await authority.server.listen(Number(new URL(localUrl).port), '127.0.0.1')
  const relay = createRelay({ publicOrigin: relayUrl }); await new Promise<void>(resolve => relay.server.listen(Number(new URL(relayUrl).port), '127.0.0.1', resolve))
  const tunnel = await openHostTunnel({ relayUrl, localOrigin: localUrl, name: 'spectator test' })
  const local = new Client(localUrl), remote = new Client(tunnel.published.url), identities = Array.from({ length: 14 }, guestIdentity), clients: Room[] = []
  const profileIdentity = getServerGameProfileIdentityV1()
  async function options(index: number, roomId: string, spectator = false, inviteCode?: string, origin = tunnel.published.url) {
    const { nonce } = await fetch(origin + '/admission/challenge').then(r => r.json())
    return { product: true, mode, visibility: 'private', playerId: identities[index].playerId, playerName: `P${index}`, alignment: 'light', profileIdentity, spectator, inviteCode, auth: identities[index].proof(nonce, roomId) }
  }
  try {
    const host = await local.create('battle', await options(0, 'create', false, undefined, localUrl)); clients.push(host)
    const roomId = host.roomId, detail = await rpc(host, 'rooms.get')
    expect(detail.inviteCode).toMatch(/^[A-F0-9]{12}$/)
    const code = detail.inviteCode!
    expect((await fetch(tunnel.published.url + '/room-invites/' + code).then(r => r.json())).room.id).toBe(roomId)
    expect((await fetch(tunnel.published.url + '/room-invites/000000000000')).status).toBe(404)
    expect(JSON.stringify(await fetch(tunnel.published.url + '/rooms/' + roomId).then(r => r.json()))).not.toContain(code)
    await expect(remote.joinById(roomId, await options(4, roomId, true, 'WRONG'))).rejects.toThrow()
    const watchers: Room[] = []
    for (let i = 4; i < 12; i++) { const watcher = await remote.joinById(roomId, await options(i, roomId, true, code)); watchers.push(watcher); clients.push(watcher) }
    expect((await rpc(host, 'rooms.get')).players).toHaveLength(1)
    expect((await rpc(host, 'rooms.get')).spectatorCount).toBe(8)
    await expect(remote.joinById(roomId, await options(12, roomId, true, code))).rejects.toThrow()
    await expect(remote.joinById(roomId, await options(4, roomId, true, code))).rejects.toThrow()
    const players = [host]
    for (let i = 1; i < (mode === '2v2' ? 4 : 2); i++) { const player = await remote.joinById(roomId, await options(i, roomId, false, code)); clients.push(player); players.push(player) }
    expect((await rpc(host, 'rooms.get')).players).toHaveLength(players.length)
    expect((await rpc(watchers[0], 'rooms.get')).inviteCode).toBeUndefined()
    const roster = getDemoPieceIds().map(id => getPieceById(id)!).filter(p => p.faction === 'good').slice(0, 8).map(p => ({ templateId: p.id, faction: p.faction }))
    for (let i = 0; i < players.length; i++) await rpc(players[i], 'rooms.action', { action: 'select-pieces', playerId: identities[i].playerId, alignment: 'light', pieces: roster, profileIdentity })
    let view = await snapshot(watchers[0])
    expect(view.state.players.every(p => p.hand.every(c => c.cardId === 'hidden'))).toBe(true)
    expect(view.state.deployment?.offerPieceIds || []).toHaveLength(0)
    await expect(rpc(watchers[0], 'rooms.action', { action: 'spectating', enabled: false, playerId: identities[0].playerId, profileIdentity })).rejects.toThrow()
    await expect(watchers[0].request('battleReceiptRequest', { clientActionId: 'private-receipt' })).rejects.toThrow()
    const rejected = next(watchers[0], 'battleReceipt'); watchers[0].send('battleCommand', { clientActionId: 'viewer-forgery', playerId: identities[0].playerId, command: { type: 'endTurn' } }); expect(await rejected).toMatchObject({ kind: 'rejected' })
    expect((await snapshot(host)).authorityVersion).toBe(view.authorityVersion)
    const watcher = watchers[0], session = watcher.sessionId
    watcher.reconnection.minUptime = 0; watcher.reconnection.minDelay = 10; watcher.reconnection.maxDelay = 50
    const recovered = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('spectator reconnect timeout')), 3000); watcher.onReconnect.once(() => { clearTimeout(timer); resolve() }) })
    void watcher.leave(false); await recovered
    expect(watcher.sessionId).toBe(session); expect((await rpc(host, 'rooms.get')).spectatorCount).toBe(8)
    expect((await snapshot(watcher)).stateHash).toBe(view.stateHash)
    for (const index of mode === '2v2' ? [0, 3] : [0]) {
      const current = await snapshot(players[index]), receipt = next(players[index], 'battleReceipt')
      const playerId = identities[index].playerId, clientActionId = `spectator-end-${index}`
      players[index].send('battleCommand', { protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION, authorityBuildId: BATTLE_AUTHORITY_BUILD_ID, roomId, playerId, expectedAuthorityVersion: current.authorityVersion, clientActionId, command: { type: 'surrender', playerId, clientActionId } })
      expect(await receipt).toMatchObject({ kind: 'applied' })
    }
    view = await snapshot(watcher)
    expect(view.state.terminalResult).toMatchObject({ status: 'finished' })
    expect(view.state.extensions?.debugBattle?.replay).toBeUndefined()
    expect(view.state.extensions?.debugBattle?.actionLog || []).toHaveLength(0)
    expect(view.state.players.every(p => p.hand.every(c => c.cardId === 'hidden'))).toBe(true)
    expect((await fetch(tunnel.published.url + '/battle-reports/' + roomId)).status).toBe(401)
    const reportProof = (await options(4, 'report:' + roomId)).auth
    expect((await fetch(tunnel.published.url + '/battle-reports/' + roomId, { headers: { 'X-RvB-Auth': JSON.stringify(reportProof) } })).status).toBe(403)
    const staleToken = watcher.reconnectionToken
    const recoveredAgain = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('second reconnect timeout')), 3000); watcher.onReconnect.once(() => { clearTimeout(timer); resolve() }) })
    void watcher.leave(false); await recoveredAgain
    await snapshot(watcher)
    const roomInstance = matchMaker.getLocalRoomById(roomId) as unknown as { clients: ServerClient[]; requireGameRoom(): Promise<GameRoom>; sendBattleSnapshot(client: ServerClient): Promise<void> }
    const serverWatcher = roomInstance.clients.find(client => client.sessionId === watcher.sessionId)!
    const originalRead = roomInstance.requireGameRoom.bind(roomInstance)
    let releaseRead!: () => void
    const blockedRead = new Promise<void>(resolve => { releaseRead = resolve })
    const read = vi.spyOn(roomInstance, 'requireGameRoom').mockImplementationOnce(async () => { const state = await originalRead(); await blockedRead; return state })
    const sent = vi.spyOn(serverWatcher, 'send')
    const pendingSnapshot = roomInstance.sendBattleSnapshot(serverWatcher)
    const closed = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('current spectator socket did not close')), 3000); watcher.onLeave.once(() => { clearTimeout(timer); resolve() }) })
    await rpc(host, 'rooms.action', { action: 'spectating', enabled: false, playerId: identities[0].playerId, profileIdentity })
    releaseRead(); await pendingSnapshot; await closed
    read.mockRestore()
    expect(sent.mock.calls.some(([type]) => type === 'battleSnapshot')).toBe(false)
    sent.mockRestore()
    expect(watcher.connection.isOpen).toBe(false)
    expect((await rpc(host, 'rooms.get')).spectatorCount).toBe(0)
    await expect(remote.joinById(roomId, await options(12, roomId, true, code))).rejects.toThrow()
    await expect(remote.reconnect(staleToken)).rejects.toThrow()
    await rpc(host, 'rooms.action', { action: 'spectating', enabled: true, playerId: identities[0].playerId, profileIdentity })
    const late = await remote.joinById(roomId, await options(12, roomId, true, code)); clients.push(late)
    const ended = await snapshot(late)
    expect(ended.state.terminalResult).toMatchObject({ status: 'finished' })
    expect(ended.state.extensions?.debugBattle?.replay).toBeUndefined()
  } finally {
    for (const room of clients) { room.reconnection.enabled = false; if (room.connection?.isOpen) await room.leave().catch(() => undefined) }
    tunnel.close(); await relay.close(); await authority.server.gracefullyShutdown(false)
  }
}, 40000)

it('public spectators need no invitation; closure releases dropped seats and restart requires host permission again', async () => {
  const repository = new FakeAuthorityRepository(), serverPort = await port(), url = `http://127.0.0.1:${serverPort}`
  let authority = createColyseusBattleServer({ repository })
  await authority.server.listen(serverPort, '127.0.0.1')
  const client = new Client(url), profileIdentity = getServerGameProfileIdentityV1(), clients: Room[] = []
  try {
    const host = await client.create('battle', { product: true, visibility: 'public', playerId: 'host', alignment: 'light', profileIdentity }); clients.push(host)
    const roomId = host.roomId
    const guest = await client.joinById(roomId, { playerId: 'guest', alignment: 'light', profileIdentity }); clients.push(guest)
    const pieces = getDemoPieceIds().map(id => getPieceById(id)!).filter(p => p.faction === 'good').slice(0, 8).map(p => ({ templateId: p.id }))
    for (const [room, playerId] of [[host, 'host'], [guest, 'guest']] as const) await rpc(room, 'rooms.action', { action: 'select-pieces', playerId, alignment: 'light', pieces, profileIdentity })
    for (let i = 0; i < 8; i++) {
      const watcher = await client.joinById(roomId, { spectator: true, playerId: `dropped-${i}`, profileIdentity }); clients.push(watcher)
      watcher.reconnection.enabled = false
      await watcher.leave(false)
    }
    const instance = matchMaker.getLocalRoomById(roomId) as unknown as { spectatorReconnections: Map<string, unknown> }
    await vi.waitFor(() => expect(instance.spectatorReconnections.size).toBe(8))
    await rpc(host, 'rooms.action', { action: 'spectating', enabled: false, playerId: 'host', profileIdentity })
    await rpc(host, 'rooms.action', { action: 'spectating', enabled: true, playerId: 'host', profileIdentity })
    for (let i = 0; i < 8; i++) clients.push(await client.joinById(roomId, { spectator: true, playerId: `fresh-${i}`, profileIdentity }))
    expect((await rpc(host, 'rooms.get')).spectatorCount).toBe(8)
    await rpc(host, 'rooms.action', { action: 'spectating', enabled: false, playerId: 'host', profileIdentity })
    for (const room of clients) { room.reconnection.enabled = false; if (room.connection?.isOpen) await room.leave() }
    await authority.server.gracefullyShutdown(false)
    authority = createColyseusBattleServer({ repository })
    const restoredPort = await port()
    await authority.server.listen(restoredPort, '127.0.0.1')
    expect(await authority.restoreProductRooms()).toContain(roomId)
    await expect(new Client(`http://127.0.0.1:${restoredPort}`).joinById(roomId, { spectator: true, playerId: 'after-restart', profileIdentity })).rejects.toThrow('关闭观战')
  } finally {
    for (const room of clients) { room.reconnection.enabled = false; if (room.connection?.isOpen) await room.leave().catch(() => undefined) }
    await authority.server.gracefullyShutdown(false)
  }
}, 20000)
