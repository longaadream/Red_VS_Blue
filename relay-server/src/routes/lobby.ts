import { Hono } from 'hono'
import { store } from '../store'
import type { Room } from '../types'
import { createRelayRoomPlayer } from '../room-seats'

export const lobbyRouter = new Hono()

function publicRoom(room: Room) {
  const { lastStateBlob: _s, actionLog: _a, ...pub } = room
  return pub
}

// GET /api/lobby — room list (only waiting/selecting rooms)
lobbyRouter.get('/', c => {
  const rooms = store
    .listRooms()
    .filter(r => r.status === 'waiting' || r.status === 'selecting')
    .map(publicRoom)
  return c.json({ rooms })
})

// POST /api/lobby — create room, creator becomes host
lobbyRouter.post('/', async c => {
  const body = await c.req.json<{
    name: string
    hostId: string
    hostName: string
    publicKey: string
  }>()

  if (!body.hostId || !body.name || !body.publicKey?.trim()) {
    return c.json({ error: 'missing hostId, name, or publicKey' }, 400)
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase()

  const room: Room = {
    id,
    hostId: body.hostId,
    name: body.name,
    status: 'waiting',
    players: [createRelayRoomPlayer([], {
      id: body.hostId,
      name: body.hostName ?? 'Host',
      publicKey: body.publicKey,
    })],
    inviteCode,
    actionLog: [],
    createdAt: Date.now(),
  }

  store.setRoom(room)
  return c.json({ id, inviteCode })
})
