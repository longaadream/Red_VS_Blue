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
    for (const room of roomsToDelete) {
      await roomStore.removeRoom(room.id)
      deletedCount++
    }

    return NextResponse.json({
      success: true,
      deletedCount,
      roomsDeleted: roomsToDelete.map(r => r.id),
      config: {
        thresholdHours: config.thresholdHours,
        statuses: config.statuses,
        cutoffTime: cutoff.toISOString()
      }
    })
  } catch (error) {
    console.error('Cleanup error:', error)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
