import { afterEach, describe, expect, it, vi } from 'vitest'

const rooms = vi.hoisted(() => [] as Array<{
  id: string
  status: string
  players?: unknown[]
}>)

vi.mock('@/lib/game/room-store', () => ({
  getRoomStore: () => ({
    getAllRooms: async () => rooms,
  }),
}))

import { getProfileLeaseReportV1 } from '@/lib/content-pipeline/runtime/profile-runtime'

afterEach(() => {
  rooms.splice(0)
  delete (globalThis as typeof globalThis & {
    __rvbProfileLeaseOverrideV1?: unknown
  }).__rvbProfileLeaseOverrideV1
})

describe('RED-116 room Profile leases', () => {
  it('holds leases for occupied waiting/ready rooms and every in-progress battle', async () => {
    rooms.push(
      { id: 'empty-waiting', status: 'waiting', players: [] },
      { id: 'occupied-waiting', status: 'waiting', players: [{}] },
      { id: 'occupied-ready', status: 'ready', players: [{}, {}] },
      { id: 'active-battle', status: 'in-progress', players: [] },
      { id: 'finished-room', status: 'finished', players: [{}] },
    )

    await expect(getProfileLeaseReportV1()).resolves.toEqual({
      active: true,
      roomIds: ['active-battle', 'occupied-ready', 'occupied-waiting'],
    })
  })

  it('releases a waiting-room lease after every player leaves', async () => {
    rooms.push({ id: 'departing-room', status: 'waiting', players: [{}] })
    await expect(getProfileLeaseReportV1()).resolves.toEqual({
      active: true,
      roomIds: ['departing-room'],
    })

    rooms[0].players = []
    await expect(getProfileLeaseReportV1()).resolves.toEqual({
      active: false,
      roomIds: [],
    })
  })
})
