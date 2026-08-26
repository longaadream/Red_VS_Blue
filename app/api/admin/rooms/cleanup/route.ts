import { NextRequest, NextResponse } from 'next/server'
import { getRoomStore } from '@/lib/game/room-store'
import { getCleanupCutoff, getCleanupConfig } from '@/lib/game/room-cleanup-config'

export async function POST(req: NextRequest) {
  try {
    const adminKey = req.headers.get('x-admin-key')
    const expectedAdminKey = process.env.ROOM_ADMIN_KEY || 'admin-secret-key'

    if (adminKey !== expectedAdminKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const roomStore = getRoomStore()
    const cutoff = getCleanupCutoff()
    const config = getCleanupConfig()

    const allRooms = await roomStore.getAllRooms()
    const roomsToDelete = allRooms.filter(room => {
      if (!config.statuses.includes(room.status)) return false
      if (!room.createdAt) return false
      return new Date(room.createdAt) < cutoff
    })

    let deletedCount = 0
    const roomsDeleted: string[] = []
    const roomsFailed: string[] = []
    for (const room of roomsToDelete) {
      const removed = await roomStore.removeRoom(room.id)
      if (removed) {
        deletedCount += 1
        roomsDeleted.push(room.id)
      } else {
        roomsFailed.push(room.id)
      }
    }

    const success = roomsFailed.length === 0
    return NextResponse.json({
      success,
      deletedCount,
      roomsDeleted,
      roomsFailed,
      ...(!success ? { error: 'One or more rooms could not be deleted' } : {}),
      config: {
        thresholdHours: config.thresholdHours,
        statuses: config.statuses,
        cutoffTime: cutoff.toISOString()
      }
    }, { status: success ? 200 : 503 })
  } catch (error) {
    console.error('Cleanup error:', error)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
