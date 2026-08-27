import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { SELECTABLE_MAP_IDS } from '@/lib/game/map-selection'

const lobbyStore = vi.hoisted(() => {
  const rooms: Array<Record<string, unknown>> = []
  return {
    reset() {
      rooms.length = 0
    },
    rooms,
    store: {
      async getAllRooms() {
        return rooms
      },
      async setRoom(_roomId: string, room: Record<string, unknown>) {
        rooms.push(JSON.parse(JSON.stringify(room)) as Record<string, unknown>)
      },
    },
  }
})

vi.mock('@/lib/game/room-store', () => ({
  getRoomStore: () => lobbyStore.store,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    room: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}))

import { POST } from '@/app/api/lobby/route'

function createRequest(mapId: unknown) {
  return new NextRequest('http://localhost/api/lobby', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Map contract room',
      hostId: 'host-a',
      mapId,
      visibility: 'public',
    }),
  })
}

describe('RED-119 legacy lobby REST map boundary', () => {
  beforeEach(() => {
    lobbyStore.reset()
  })

  it.each(SELECTABLE_MAP_IDS)('persists selectable map %s without rewriting it', async mapId => {
    const response = await POST(createRequest(mapId))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.mapId).toBe(mapId)
    expect(lobbyStore.rooms).toHaveLength(1)
    expect(lobbyStore.rooms[0].mapId).toBe(mapId)
  })

  it.each([
    { mapId: undefined, code: 'MAP_ID_REQUIRED' },
    { mapId: '', code: 'MAP_ID_REQUIRED' },
    { mapId: 'large-battlefield', code: 'MAP_NOT_SELECTABLE' },
    { mapId: 'large-trap-arena', code: 'MAP_NOT_SELECTABLE' },
    { mapId: '../large-hole-arena', code: 'MAP_NOT_SELECTABLE' },
    { mapId: ' large-hole-arena ', code: 'MAP_NOT_SELECTABLE' },
  ])('rejects invalid map $mapId before any room write', async ({ mapId, code }) => {
    const response = await POST(createRequest(mapId))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ success: false, code })
    expect(lobbyStore.rooms).toHaveLength(0)
  })
})
