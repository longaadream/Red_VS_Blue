import { Hono } from 'hono'
import { store } from '../store'
import { validateStandaloneMapId, type Room } from '../types'
import { createRelayRoomPlayer } from '../room-seats'

export const lobbyRouter = new Hono()

function publicRoom(room: Room) {
  const { lastStateBlob: _s, actionLog: _a, ...pub } = room
  return pub
}

// GET /api/lobby — pre-battle and spectatable rooms
lobbyRouter.get('/', c => {
  const rooms = store
    .listRooms()
    .filter(r => r.status === 'waiting' || r.status === 'selecting' || r.status === 'battle' || r.status === 'waiting_host')
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
    mapId?: unknown
  }>()
  const mapSelection = validateStandaloneMapId(body.mapId)
  if (!mapSelection.ok) {
    return c.json({ error: mapSelection.error, code: mapSelection.code }, 400)
  }

  if (!body.hostId || !body.name || !body.publicKey?.trim()) {
    return c.json({ error: 'missing hostId, name, or publicKey' }, 400)
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase()

  const room: Room = {
    id,
    hostId: body.hostId,
    name: body.name,
    mapId: mapSelection.mapId,
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

  try {
    await store.persistRoom(room)
  } catch (error) {
    console.error('[lobby] Failed to persist room creation', error)
    return c.json({ error: 'room persistence failed' }, 500)
  }
  return c.json({ id, inviteCode, mapId: mapSelection.mapId })
})
