import { Hono } from 'hono'
import { store } from '../store'
import { db } from '../db/client'
import { validateStandaloneMapId, type Room, type StandaloneRosterPiece } from '../types'
import { claimRelayRoomSeat, createRelayRoomPlayer, ensureRelayRoomSeats } from '../room-seats'

export const roomsRouter = new Hono()

function publicRoom(room: Room) {
  const { lastStateBlob: _s, actionLog: _a, ...pub } = room
  return pub
}

function readAlignment(input: unknown): 'light' | 'dark' | null {
  return input === 'light' || input === 'dark' ? input : null
}

function readRoster(input: unknown): StandaloneRosterPiece[] | null {
  if (!Array.isArray(input) || input.length !== 8) return null
  const ids = input.map(piece => {
    if (typeof piece === 'string') return piece
    if (!piece || typeof piece !== 'object') return ''
    return typeof (piece as { templateId?: unknown }).templateId === 'string'
      ? (piece as { templateId: string }).templateId
      : ''
  })
  if (ids.some(id => id.length === 0) || new Set(ids).size !== ids.length) return null
  return input as StandaloneRosterPiece[]
}

async function persistPreBattleRoom(room: Room): Promise<boolean> {
  try {
    await store.persistRoom(room)
    return true
  } catch (error) {
    console.error(`[rooms] Failed to persist room ${room.id}`, error)
    return false
  }
}

// GET /api/rooms/:id
roomsRouter.get('/:id', c => {
  const room = store.getRoom(c.req.param('id'))
  if (!room) return c.json({ error: 'not found' }, 404)
  return c.json(publicRoom(room))
})

// DELETE /api/rooms/:id — host only
roomsRouter.delete('/:id', async c => {
  const roomId = c.req.param('id')
  return store.withRoomLock(roomId, async () => {
  const room = store.getRoom(roomId)
  if (!room) return c.json({ error: 'not found' }, 404)
  const playerId = c.req.header('x-player-id')?.trim().toLowerCase()
  if (!playerId || playerId !== room.hostId.trim().toLowerCase()) return c.json({ error: 'forbidden' }, 403)
  try {
    await store.deleteRoomPersisted(room.id)
  } catch (error) {
    console.error(`[rooms] Failed to persist room deletion ${room.id}`, error)
    return c.json({ error: 'room persistence failed' }, 500)
  }
  return c.json({ ok: true })
  })
})

// POST /api/rooms/:id/actions — join / claim-faction / select-pieces
roomsRouter.post('/:id/actions', async c => {
  const roomId = c.req.param('id')
  const body = await c.req.json<{
    action: string
    playerId: string
    playerName?: string
    publicKey?: string
    alignment?: unknown
    pieces?: StandaloneRosterPiece[]
    payload?: unknown
    signature?: string
  }>()

  return store.withRoomLock(roomId, async () => {
  const storedRoom = store.getRoom(roomId)
  if (!storedRoom) return c.json({ error: 'not found' }, 404)
  const room = structuredClone(storedRoom)

  const mapSelection = validateStandaloneMapId(room.mapId)
  if (!mapSelection.ok) {
    return c.json({ error: mapSelection.error, code: mapSelection.code }, 400)
  }
  const normalizedPlayerId = String(body.playerId ?? '').trim().toLowerCase()
  if (!normalizedPlayerId) return c.json({ error: 'playerId is required' }, 400)

  switch (body.action) {
    case 'join': {
      if (room.status !== 'waiting') return c.json({ error: 'room not open' }, 400)
      if (room.players.length >= 2) return c.json({ error: 'room full' }, 400)
      if (room.players.some(player => player.id.trim().toLowerCase() === normalizedPlayerId)) {
        return c.json({ error: 'already joined' }, 400)
      }
      const alignment = readAlignment(body.alignment)
      if (!alignment) return c.json({ error: 'alignment must be light or dark' }, 400)

      let player
      try {
        player = createRelayRoomPlayer(room.players, {
          id: normalizedPlayerId,
          name: body.playerName ?? 'Player',
          publicKey: body.publicKey ?? '',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return c.json({ error: message }, message.includes('duplicate') ? 409 : 400)
      }

      player.alignment = alignment
      room.players.push(player)
      room.status = 'selecting'
      if (!await persistPreBattleRoom(room)) return c.json({ error: 'room persistence failed' }, 500)
      store.broadcastToRoom(room.id, { type: 'roomUpdate', room: publicRoom(room) })
      return c.json({
        ok: true,
        faction: player.faction,
        alignment: player.alignment,
        inviteCode: room.inviteCode,
        room: publicRoom(room),
      })
    }

    case 'claim-faction': {
      if (room.status === 'battle' || room.status === 'waiting_host' || room.status === 'finished') {
        return c.json({ error: 'room is not in pre-battle' }, 409)
      }
      const alignment = readAlignment(body.alignment)
      if (!alignment) return c.json({ error: 'alignment must be light or dark' }, 400)
      const player = room.players.find(candidate => candidate.id.trim().toLowerCase() === normalizedPlayerId)
      if (!player) return c.json({ error: 'not in room' }, 403)
      if (player.pieces?.length && player.alignment && player.alignment !== alignment) {
        return c.json({ error: 'alignment is locked after roster selection' }, 409)
      }

      let faction
      try {
        faction = claimRelayRoomSeat(room.players, player.id)
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
      }
      player.alignment = alignment
      if (!await persistPreBattleRoom(room)) return c.json({ error: 'room persistence failed' }, 500)
      store.broadcastToRoom(room.id, { type: 'roomUpdate', room: publicRoom(room) })
      return c.json({ ok: true, faction, alignment: player.alignment, room: publicRoom(room) })
    }

    case 'select-pieces': {
      if (room.status === 'battle' || room.status === 'waiting_host' || room.status === 'finished') {
        return c.json({ error: 'room is not in pre-battle' }, 409)
      }
      const player = room.players.find(candidate => candidate.id.trim().toLowerCase() === normalizedPlayerId)
      if (!player) return c.json({ error: 'not in room' }, 403)
      const roster = readRoster(body.pieces)
      if (!roster) return c.json({ error: 'exactly eight unique pieces are required' }, 400)
      const alignment = body.alignment === undefined ? player.alignment ?? null : readAlignment(body.alignment)
      if (!alignment) return c.json({ error: 'alignment must be light or dark' }, 400)
      if (player.alignment && player.alignment !== alignment) {
        return c.json({ error: 'alignment does not match the claimed alignment' }, 409)
      }
      try {
        ensureRelayRoomSeats(room.players)
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
      }

      player.alignment = alignment
      player.pieces = roster
      if (!await persistPreBattleRoom(room)) return c.json({ error: 'room persistence failed' }, 500)
      const allReady = room.players.length === 2
        && room.players.every(candidate => Array.isArray(candidate.pieces) && candidate.pieces.length === 8)
      store.broadcastToRoom(room.id, { type: 'roomUpdate', room: publicRoom(room) })
      return c.json({
        ok: true,
        room: publicRoom(room),
        ...(allReady
          ? {
              battleAuthorityUnavailable: true,
              code: 'BATTLE_AUTHORITY_UNAVAILABLE',
            }
          : {}),
      })
    }

    default:
      return c.json({ error: 'unknown action' }, 400)
  }
  })
})

// POST /api/rooms/:id/spectate
roomsRouter.post('/:id/spectate', async c => {
  const room = store.getRoom(c.req.param('id'))
  if (!room) return c.json({ error: 'not found' }, 404)
  if (room.status !== 'battle' && room.status !== 'waiting_host') {
    return c.json({ error: 'room is not spectatable' }, 400)
  }
  const body = await c.req.json<{ spectatorId?: string }>()
  const spectatorId = String(body.spectatorId ?? '').trim().toLowerCase()
  if (!spectatorId) return c.json({ error: 'spectatorId is required' }, 400)
  if (room.players.some(player => player.id.trim().toLowerCase() === spectatorId)) {
    return c.json({ error: 'player is already in this room' }, 409)
  }
  return c.json({ ok: true, room: publicRoom(room) })
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
