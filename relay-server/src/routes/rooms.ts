import { Hono } from 'hono'
import { store } from '../store'
import { db } from '../db/client'
import type { Room } from '../types'

export const roomsRouter = new Hono()

function publicRoom(room: Room) {
  const { lastStateBlob: _s, actionLog: _a, ...pub } = room
  return pub
}

// GET /api/rooms/:id
roomsRouter.get('/:id', c => {
  const room = store.getRoom(c.req.param('id'))
  if (!room) return c.json({ error: 'not found' }, 404)
  return c.json(publicRoom(room))
})

// DELETE /api/rooms/:id — host only
roomsRouter.delete('/:id', c => {
  const room = store.getRoom(c.req.param('id'))
  if (!room) return c.json({ error: 'not found' }, 404)
  const playerId = c.req.header('x-player-id')
  if (playerId !== room.hostId) return c.json({ error: 'forbidden' }, 403)
  store.deleteRoom(room.id)
  return c.json({ ok: true })
})

// POST /api/rooms/:id/actions — join / claim-faction / select-pieces
roomsRouter.post('/:id/actions', async c => {
  const room = store.getRoom(c.req.param('id'))
  if (!room) return c.json({ error: 'not found' }, 404)

  const body = await c.req.json<{
    action: string
    playerId: string
    playerName?: string
    publicKey?: string
    faction?: string
    pieces?: string[]
    payload?: unknown
    signature?: string
  }>()

  switch (body.action) {
    case 'join': {
      if (room.status !== 'waiting') return c.json({ error: 'room not open' }, 400)
      if (room.players.length >= 2) return c.json({ error: 'room full' }, 400)
      if (room.players.find(p => p.id === body.playerId)) return c.json({ error: 'already joined' }, 400)

      room.players.push({
        id: body.playerId,
        name: body.playerName ?? 'Player',
        publicKey: body.publicKey ?? '',
        connected: false,
      })
      room.status = 'selecting'
      store.setRoom(room)
      store.broadcastToRoom(room.id, { type: 'roomUpdate', room: publicRoom(room) })
      return c.json({ ok: true, faction: null, inviteCode: room.inviteCode })
    }

    case 'claim-faction': {
      const player = room.players.find(p => p.id === body.playerId)
      if (!player) return c.json({ error: 'not in room' }, 403)
      player.faction = body.faction
      store.setRoom(room)
      store.broadcastToRoom(room.id, { type: 'roomUpdate', room: publicRoom(room) })
      return c.json({ ok: true, faction: body.faction })
    }

    case 'select-pieces': {
      const player = room.players.find(p => p.id === body.playerId)
      if (!player) return c.json({ error: 'not in room' }, 403)
      player.pieces = body.pieces
      store.setRoom(room)

      // Both players selected → start battle
      const allReady = room.players.length === 2 && room.players.every(p => p.pieces?.length)
      if (allReady) {
        room.status = 'battle'
        store.setRoom(room)
      }
      store.broadcastToRoom(room.id, { type: 'roomUpdate', room: publicRoom(room) })
      return c.json({ ok: true })
    }

    default:
      return c.json({ error: 'unknown action' }, 400)
  }
})

// POST /api/rooms/:id/spectate
roomsRouter.post('/:id/spectate', async c => {
  const room = store.getRoom(c.req.param('id'))
  if (!room) return c.json({ error: 'not found' }, 404)
  // Spectators just get the public room info; WS subscription handles the rest
  return c.json(publicRoom(room))
})

// GET /api/rooms/:id/game-record
roomsRouter.get('/:id/game-record', async c => {
  const record = await db.battleRecord.findFirst({
    where: { roomId: c.req.param('id') },
    orderBy: { createdAt: 'desc' },
  })
  if (!record) return c.json({ error: 'not found' }, 404)
  return c.json(record)
})

// POST /api/rooms/:id/game-record — host submits signed record
roomsRouter.post('/:id/game-record', async c => {
  const roomId = c.req.param('id')
  const room = store.getRoom(roomId)

  const body = await c.req.json<{
    winnerId: string
    loserId: string
    hostSignature: string
    actionChainHash: string
  }>()

  if (!body.winnerId || !body.loserId || !body.hostSignature) {
    return c.json({ error: 'missing fields' }, 400)
  }

  // Host-only submission
  if (room && body.winnerId !== room.hostId && body.loserId !== room.hostId) {
    return c.json({ error: 'submitter must be host' }, 403)
  }

  const actionLog = room?.actionLog ?? []

  const record = await db.battleRecord.create({
    data: {
      id: crypto.randomUUID(),
      roomId,
      winnerId: body.winnerId,
      loserId: body.loserId,
      actionLog: actionLog as any,
      hostSignature: body.hostSignature,
      verified: false,
    },
  })

  return c.json({ id: record.id, verified: false })
})
