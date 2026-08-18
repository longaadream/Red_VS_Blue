import { beforeEach, describe, expect, it, vi } from 'vitest'

const relayHarness = vi.hoisted(() => {
  const rooms = new Map()
  return {
    rooms,
    store: {
      getRoom: vi.fn(id => rooms.get(id.toLowerCase())),
      setRoom: vi.fn(room => { rooms.set(room.id.toLowerCase(), room) }),
      deleteRoom: vi.fn(id => { rooms.delete(id.toLowerCase()) }),
      listRooms: vi.fn(() => [...rooms.values()]),
      broadcastToRoom: vi.fn(),
    },
  }
})

vi.mock('../relay-server/src/store', () => ({ store: relayHarness.store }))
vi.mock('../relay-server/src/db/client', () => ({
  db: {
    battleRecord: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { lobbyRouter } from '../relay-server/src/routes/lobby'
import { roomsRouter } from '../relay-server/src/routes/rooms'

describe('Relay HTTP route seat authority', () => {
  beforeEach(() => {
    relayHarness.rooms.clear()
    vi.clearAllMocks()
  })

  it('executes POST lobby creation with a persisted server-assigned host seat', async () => {
    const response = await lobbyRouter.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Route Test',
        hostId: 'HostABC',
        hostName: 'Host',
        publicKey: 'public-key-host',
      }),
    })
    const payload = await response.json()
    const room = relayHarness.rooms.get(payload.id.toLowerCase())

    expect(response.status).toBe(200)
    expect(payload.inviteCode).toMatch(/^[A-Z0-9]{6}$/)
    expect(room.hostId).toBe('HostABC')
    expect(room.players).toHaveLength(1)
    expect(room.players[0]).toMatchObject({
      id: 'HostABC',
      publicKey: 'public-key-host',
      connected: false,
    })
    expect(['red', 'blue']).toContain(room.players[0].faction)
    expect(relayHarness.store.setRoom).toHaveBeenCalledWith(room)
  })

  it('executes POST join and legacy claim without allowing a client seat override', async () => {
    const room = {
      id: 'room-1',
      hostId: 'host',
      name: 'Route Test',
      status: 'waiting',
      players: [{
        id: 'host',
        name: 'Host',
        publicKey: 'public-key-host',
        faction: 'red',
        connected: false,
      }],
      inviteCode: 'ABC123',
      actionLog: [],
      createdAt: Date.now(),
    }
    relayHarness.rooms.set(room.id, room)

    const joinResponse = await roomsRouter.request('/room-1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        playerId: 'guest',
        playerName: 'Guest',
        publicKey: 'public-key-guest',
        faction: 'red',
      }),
    })
    expect(joinResponse.status).toBe(200)
    await expect(joinResponse.json()).resolves.toMatchObject({ ok: true, faction: 'blue' })
    expect(relayHarness.rooms.get(room.id).players[1].faction).toBe('blue')
    expect(relayHarness.store.broadcastToRoom).toHaveBeenCalledOnce()

    const claimResponse = await roomsRouter.request('/room-1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim-faction', playerId: 'guest', faction: 'red' }),
    })
    expect(claimResponse.status).toBe(200)
    await expect(claimResponse.json()).resolves.toMatchObject({ ok: true, faction: 'blue' })
    expect(relayHarness.rooms.get(room.id).players[1].faction).toBe('blue')
    expect(relayHarness.store.setRoom).toHaveBeenCalledTimes(2)
  })
})
