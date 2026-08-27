import { beforeEach, describe, expect, it, vi } from 'vitest'

const relayHarness = vi.hoisted(() => {
  const rooms = new Map()
  const roomMutationTails = new Map()
  const withRoomLock = vi.fn(async (id, operation) => {
    const key = id.toLowerCase()
    const previous = roomMutationTails.get(key) ?? Promise.resolve()
    let release = () => {}
    const gate = new Promise(resolve => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    roomMutationTails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (roomMutationTails.get(key) === tail) roomMutationTails.delete(key)
    }
  })
  return {
    rooms,
    roomMutationTails,
    store: {
      getRoom: vi.fn(id => rooms.get(id.toLowerCase())),
      setRoom: vi.fn(room => { rooms.set(room.id.toLowerCase(), room) }),
      persistRoom: vi.fn(async room => { rooms.set(room.id.toLowerCase(), structuredClone(room)) }),
      deleteRoomPersisted: vi.fn(async id => { rooms.delete(id.toLowerCase()) }),
      deleteRoom: vi.fn(id => { rooms.delete(id.toLowerCase()) }),
      listRooms: vi.fn(() => [...rooms.values()]),
      broadcastToRoom: vi.fn(),
      withRoomLock,
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
import { STANDALONE_SELECTABLE_MAP_IDS } from '../relay-server/src/types'

describe('Relay HTTP route seat authority', () => {
  beforeEach(() => {
    relayHarness.rooms.clear()
    relayHarness.roomMutationTails.clear()
    vi.clearAllMocks()
  })

  it.each(STANDALONE_SELECTABLE_MAP_IDS)('executes POST lobby creation for %s with a persisted server-assigned host seat', async mapId => {
    const response = await lobbyRouter.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Route Test',
        hostId: 'HostABC',
        hostName: 'Host',
        publicKey: 'public-key-host',
        mapId,
      }),
    })
    const payload = await response.json()
    const room = relayHarness.rooms.get(payload.id.toLowerCase())

    expect(response.status).toBe(200)
    expect(payload.inviteCode).toMatch(/^[A-Z0-9]{6}$/)
    expect(payload.mapId).toBe(mapId)
    expect(room.hostId).toBe('HostABC')
    expect(room.mapId).toBe(mapId)
    expect(room.players).toHaveLength(1)
    expect(room.players[0]).toMatchObject({
      id: 'HostABC',
      publicKey: 'public-key-host',
      connected: false,
    })
    expect(['red', 'blue']).toContain(room.players[0].faction)
    expect(relayHarness.store.persistRoom).toHaveBeenCalledWith(room)
  })

  it.each([
    { mapId: undefined, code: 'MAP_ID_REQUIRED' },
    { mapId: 'unknown-map', code: 'MAP_NOT_SELECTABLE' },
    { mapId: 'large-battlefield', code: 'MAP_NOT_SELECTABLE' },
    { mapId: '../large-hole-arena', code: 'MAP_NOT_SELECTABLE' },
  ])('rejects invalid lobby map $mapId without writing a room', async ({ mapId, code }) => {
    const response = await lobbyRouter.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Rejected Route Test',
        hostId: 'HostABC',
        hostName: 'Host',
        publicKey: 'public-key-host',
        mapId,
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String), code })
    expect(relayHarness.rooms.size).toBe(0)
    expect(relayHarness.store.persistRoom).not.toHaveBeenCalled()
  })
  it('does not publish a created room when persistence fails', async () => {
    relayHarness.store.persistRoom.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await lobbyRouter.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Persistence Failure',
        hostId: 'HostABC',
        hostName: 'Host',
        publicKey: 'public-key-host',
        mapId: 'large-hole-arena',
      }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: 'room persistence failed' })
    expect(relayHarness.rooms.size).toBe(0)
  })


  it('executes POST join and legacy claim without allowing a client seat override', async () => {
    const room = {
      id: 'room-1',
      hostId: 'host',
      name: 'Route Test',
      mapId: 'winding-pass',
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
        alignment: 'light',
      }),
        mapId: 'large-battlefield',
    })
    expect(joinResponse.status).toBe(200)
    await expect(joinResponse.json()).resolves.toMatchObject({ ok: true, faction: 'blue', alignment: 'light' })
    expect(relayHarness.rooms.get(room.id).players[1].faction).toBe('blue')
    expect(relayHarness.rooms.get(room.id).players[1].alignment).toBe('light')
    expect(relayHarness.store.broadcastToRoom).toHaveBeenCalledOnce()

    const claimResponse = await roomsRouter.request('/room-1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim-faction', playerId: 'guest', faction: 'red', alignment: 'light', mapId: 'open-expanse' }),
    })
    expect(claimResponse.status).toBe(200)
    await expect(claimResponse.json()).resolves.toMatchObject({ ok: true, faction: 'blue', alignment: 'light' })
    expect(relayHarness.rooms.get(room.id).players[1].faction).toBe('blue')
    expect(relayHarness.rooms.get(room.id).players[1].alignment).toBe('light')
    expect(relayHarness.store.persistRoom).toHaveBeenCalledTimes(2)
    expect(relayHarness.rooms.get(room.id).mapId).toBe('winding-pass')
  })
  it('records the already-created host alignment without adding a duplicate seat', async () => {
    const room = {
      id: 'host-room',
      hostId: 'host',
      name: 'Host Route Test',
      mapId: 'large-hole-arena',
      status: 'waiting',
      players: [{ id: 'host', name: 'Host', publicKey: 'host-key', faction: 'red', connected: false }],
      inviteCode: 'HOST01',
      actionLog: [],
      createdAt: Date.now(),
    }
    relayHarness.rooms.set(room.id, room)

    const response = await roomsRouter.request('/host-room/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim-faction', playerId: 'host', alignment: 'dark' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      faction: 'red',
      alignment: 'dark',
      room: { status: 'waiting' },
    })
    expect(relayHarness.rooms.get(room.id).players).toHaveLength(1)
    expect(relayHarness.rooms.get(room.id).players[0].alignment).toBe('dark')
    expect(relayHarness.store.persistRoom).toHaveBeenCalledOnce()
  })

  it('persists the second valid selection without advertising prohibited battle authority', async () => {
    const hostPieces = Array.from({ length: 8 }, (_, index) => ({ templateId: `host-${index}`, faction: 'good' }))
    const guestPieces = Array.from({ length: 8 }, (_, index) => ({ templateId: `guest-${index}`, faction: 'evil' }))
    const room = {
      id: 'selection-room',
      hostId: 'host',
      name: 'Selection Route Test',
      mapId: 'large-hole-arena',
      status: 'selecting',
      players: [
        { id: 'host', name: 'Host', publicKey: 'host-key', faction: 'red', alignment: 'light', pieces: hostPieces, connected: false },
        { id: 'guest', name: 'Guest', publicKey: 'guest-key', faction: 'blue', alignment: 'dark', connected: false },
      ],
      inviteCode: 'SELECT',
      actionLog: [],
      createdAt: Date.now(),
    }
    relayHarness.rooms.set(room.id, room)

    const response = await roomsRouter.request('/selection-room/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'select-pieces', playerId: 'guest', pieces: guestPieces }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      room: { status: 'selecting' },
      battleAuthorityUnavailable: true,
      code: 'BATTLE_AUTHORITY_UNAVAILABLE',
    })
    expect(room.status).toBe('selecting')
    expect(room.players[1].pieces).toBeUndefined()
    expect(relayHarness.rooms.get(room.id)).toMatchObject({
      status: 'selecting',
      players: [{ pieces: hostPieces }, { pieces: guestPieces }],
    })
    expect(relayHarness.store.persistRoom).toHaveBeenCalledOnce()
    expect(relayHarness.store.broadcastToRoom).toHaveBeenCalledOnce()
  })

  it('leaves the room unchanged and surfaces a persistence failure on the second selection', async () => {
    const hostPieces = Array.from({ length: 8 }, (_, index) => ({ templateId: `host-failed-${index}` }))
    const guestPieces = Array.from({ length: 8 }, (_, index) => ({ templateId: `guest-failed-${index}` }))
    const room = {
      id: 'failed-selection-room',
      hostId: 'host',
      name: 'Failed Selection Route Test',
      mapId: 'large-hole-arena',
      status: 'selecting',
      players: [
        { id: 'host', name: 'Host', publicKey: 'host-key', faction: 'red', alignment: 'light', pieces: hostPieces, connected: false },
        { id: 'guest', name: 'Guest', publicKey: 'guest-key', faction: 'blue', alignment: 'dark', connected: false },
      ],
      inviteCode: 'FAILED',
      actionLog: [],
      createdAt: Date.now(),
    }
    const originalRoom = structuredClone(room)
    relayHarness.rooms.set(room.id, room)
    relayHarness.store.persistRoom.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await roomsRouter.request('/failed-selection-room/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'select-pieces', playerId: 'guest', pieces: guestPieces }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: 'room persistence failed' })
    expect(relayHarness.rooms.get(room.id)).toEqual(originalRoom)
    expect(relayHarness.store.broadcastToRoom).not.toHaveBeenCalled()
  })

  it('serializes concurrent selections and keeps the frozen map and both rosters', async () => {
    const hostPieces = Array.from({ length: 8 }, (_, index) => ({ templateId: 'host-concurrent-' + index }))
    const guestPieces = Array.from({ length: 8 }, (_, index) => ({ templateId: 'guest-concurrent-' + index }))
    const room = {
      id: 'concurrent-selection-room',
      hostId: 'host',
      name: 'Concurrent Selection',
      mapId: 'winding-pass',
      status: 'selecting',
      players: [
        { id: 'host', name: 'Host', publicKey: 'host-key', faction: 'red', alignment: 'light', connected: false },
        { id: 'guest', name: 'Guest', publicKey: 'guest-key', faction: 'blue', alignment: 'dark', connected: false },
      ],
      inviteCode: 'SERIAL',
      actionLog: [],
      createdAt: Date.now(),
    }
    relayHarness.rooms.set(room.id, room)

    let markFirstPersisted
    const firstPersisted = new Promise(resolve => {
      markFirstPersisted = resolve
    })
    let releaseFirstPersist
    const firstPersistGate = new Promise(resolve => {
      releaseFirstPersist = resolve
    })
    relayHarness.store.persistRoom.mockImplementationOnce(async snapshot => {
      markFirstPersisted()
      await firstPersistGate
      relayHarness.rooms.set(snapshot.id.toLowerCase(), structuredClone(snapshot))
    })

    const hostRequest = roomsRouter.request('/' + room.id + '/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'select-pieces',
        playerId: 'host',
        alignment: 'light',
        pieces: hostPieces,
        mapId: 'large-battlefield',
      }),
    })
    await firstPersisted

    const guestRequest = roomsRouter.request('/' + room.id + '/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'select-pieces',
        playerId: 'guest',
        alignment: 'dark',
        pieces: guestPieces,
        mapId: 'open-expanse',
      }),
    })
    await Promise.resolve()
    expect(relayHarness.store.persistRoom).toHaveBeenCalledOnce()

    releaseFirstPersist()
    const [hostResponse, guestResponse] = await Promise.all([hostRequest, guestRequest])
    const hostPayload = await hostResponse.json()
    const guestPayload = await guestResponse.json()

    expect(hostResponse.status).toBe(200)
    expect(guestResponse.status).toBe(200)
    expect(hostPayload).not.toHaveProperty('battleAuthorityUnavailable')
    expect(guestPayload).toMatchObject({
      battleAuthorityUnavailable: true,
      code: 'BATTLE_AUTHORITY_UNAVAILABLE',
    })
    expect(relayHarness.rooms.get(room.id)).toMatchObject({
      mapId: 'winding-pass',
      status: 'selecting',
      players: [{ pieces: hostPieces }, { pieces: guestPieces }],
    })
    expect(relayHarness.store.persistRoom).toHaveBeenCalledTimes(2)
  })

  it('serializes deletion after an in-flight action so the room cannot be resurrected', async () => {
    const room = {
      id: 'delete-race-room',
      hostId: 'host',
      name: 'Delete Race',
      mapId: 'winding-pass',
      status: 'waiting',
      players: [
        { id: 'host', name: 'Host', publicKey: 'host-key', faction: 'red', connected: false },
      ],
      inviteCode: 'DELETE',
      actionLog: [],
      createdAt: Date.now(),
    }
    relayHarness.rooms.set(room.id, room)

    let markPersistStarted
    const persistStarted = new Promise(resolve => {
      markPersistStarted = resolve
    })
    let releasePersist
    const persistGate = new Promise(resolve => {
      releasePersist = resolve
    })
    relayHarness.store.persistRoom.mockImplementationOnce(async snapshot => {
      markPersistStarted()
      await persistGate
      relayHarness.rooms.set(snapshot.id.toLowerCase(), structuredClone(snapshot))
    })

    const actionRequest = roomsRouter.request('/' + room.id + '/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim-faction', playerId: 'host', alignment: 'light' }),
    })
    await persistStarted
    const deleteRequest = roomsRouter.request('/' + room.id, {
      method: 'DELETE',
      headers: { 'x-player-id': 'host' },
    })
    await Promise.resolve()
    expect(relayHarness.store.deleteRoomPersisted).not.toHaveBeenCalled()

    releasePersist()
    const [actionResponse, deleteResponse] = await Promise.all([actionRequest, deleteRequest])
    expect(actionResponse.status).toBe(200)
    expect(deleteResponse.status).toBe(200)
    expect(relayHarness.rooms.has(room.id)).toBe(false)
    expect(relayHarness.store.deleteRoomPersisted).toHaveBeenCalledOnce()
  })

  it.each([
    { mapId: undefined, code: 'MAP_ID_REQUIRED' },
    { mapId: 'unknown-map', code: 'MAP_NOT_SELECTABLE' },
    { mapId: 'large-battlefield', code: 'MAP_NOT_SELECTABLE' },
  ])('rejects every pre-battle write for an invalid legacy room map $mapId without mutation', async ({ mapId, code }) => {
    const room = {
      id: 'legacy-room',
      hostId: 'host',
      name: 'Legacy Route Test',
      ...(mapId === undefined ? {} : { mapId }),
      status: 'selecting',
      players: [
        { id: 'host', name: 'Host', publicKey: 'host-key', pieces: ['ana'], connected: false },
        { id: 'guest', name: 'Guest', publicKey: 'guest-key', connected: false },
      ],
      inviteCode: 'ABC123',
      actionLog: [],
      createdAt: Date.now(),
    }
    const originalRoom = structuredClone(room)
    relayHarness.rooms.set(room.id, room)

    for (const body of [
      { action: 'join', playerId: 'new-guest', alignment: 'light' },
      { action: 'claim-faction', playerId: 'host', alignment: 'dark' },
      { action: 'select-pieces', playerId: 'guest', pieces: Array.from({ length: 8 }, (_, index) => `piece-${index}`) },
    ]) {
      vi.clearAllMocks()
      const response = await roomsRouter.request('/legacy-room/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: expect.any(String), code })
      expect(relayHarness.rooms.get(room.id)).toEqual(originalRoom)
      expect(relayHarness.store.persistRoom).not.toHaveBeenCalled()
      expect(relayHarness.store.broadcastToRoom).not.toHaveBeenCalled()
    }
  })
})
