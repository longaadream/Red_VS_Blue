import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const roomStore = vi.hoisted(() => ({
  getRoom: vi.fn(),
  getAllRooms: vi.fn(),
  removeRoom: vi.fn(),
}))

vi.mock('@/lib/game/room-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/game/room-store')>()
  return { ...actual, getRoomStore: () => roomStore }
})

vi.mock('@/lib/game/room-cleanup-config', () => ({
  getCleanupCutoff: () => new Date('2026-01-01T00:00:00.000Z'),
  getCleanupConfig: () => ({ thresholdHours: 24, statuses: ['finished'] }),
}))

vi.mock('@/lib/ws-server', () => ({ broadcastToRoom: vi.fn() }))

import { POST as cleanupRooms } from '@/app/api/admin/rooms/cleanup/route'
import { DELETE } from '@/app/api/rooms/[roomId]/route'

describe('room deletion transport failures', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    roomStore.getRoom.mockReset()
    roomStore.getAllRooms.mockReset()
    roomStore.removeRoom.mockReset()
    roomStore.getRoom.mockResolvedValue({
      id: 'room-delete-failure',
      name: 'Delete failure room',
      status: 'waiting',
      players: [{ id: 'host', name: 'Host' }],
      spectators: [],
      hostId: 'host',
      currentTurnIndex: 0,
      actions: [],
    })
    roomStore.getAllRooms.mockResolvedValue([{
      id: 'room-delete-failure',
      name: 'Delete failure room',
      status: 'finished',
      players: [],
      spectators: [],
      createdAt: '2025-01-01T00:00:00.000Z',
    }])
  })

  test.each([
    ['admin', { 'x-admin-key': 'admin-secret-key' }],
    ['host', { 'x-player-id': 'host' }],
  ])('returns an explicit error when %s deletion is refused', async (_role, headers) => {
    roomStore.removeRoom.mockResolvedValue(false)
    const response = await DELETE(
      new NextRequest('http://localhost/api/rooms/room-delete-failure', {
        method: 'DELETE',
        headers,
      }),
      { params: Promise.resolve({ roomId: 'room-delete-failure' }) },
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Room could not be deleted',
    })
  })

  test('does not disguise an unexpected deletion exception as success', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    roomStore.removeRoom.mockRejectedValue(new Error('journal drain failed'))
    const response = await DELETE(
      new NextRequest('http://localhost/api/rooms/room-delete-failure', {
        method: 'DELETE',
        headers: { 'x-admin-key': 'admin-secret-key' },
      }),
      { params: Promise.resolve({ roomId: 'room-delete-failure' }) },
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'journal drain failed',
    })
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  test('reports a failed admin cleanup without claiming the room was deleted', async () => {
    roomStore.removeRoom.mockResolvedValue(false)
    const response = await cleanupRooms(new NextRequest('http://localhost/api/admin/rooms/cleanup', {
      method: 'POST',
      headers: { 'x-admin-key': 'admin-secret-key' },
    }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      deletedCount: 0,
      roomsDeleted: [],
      roomsFailed: ['room-delete-failure'],
      error: 'One or more rooms could not be deleted',
    })
  })
})
