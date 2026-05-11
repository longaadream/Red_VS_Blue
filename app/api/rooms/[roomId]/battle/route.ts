import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import { broadcastToRoom } from "@/lib/ws-server"

// ── Types ────────────────────────────────────────────────────────────────────

interface ActionLogEntry {
  seq: number
  type: 'init' | 'action' | 'gameOver'
  playerId?: string
  payload?: unknown   // initial BattleState (type=init)
  action?: unknown    // BattleAction     (type=action)
  winner?: string     // winning faction  (type=gameOver)
  timestamp: number
}

interface ActionLog {
  type: 'action-log'
  seed: number
  actions: ActionLogEntry[]
}

// ── GET — return action log entries since N ──────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const room = await roomStore.getRoom(roomId)

  if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

  const log = room.battleState as unknown as ActionLog | undefined
  if (!log || log.type !== 'action-log') {
    return NextResponse.json({ error: 'Battle not started' }, { status: 400 })
  }

  const since = parseInt(req.nextUrl.searchParams.get('since') ?? '-1')
  const actions = log.actions.slice(since + 1)
  return NextResponse.json({ actions, total: log.actions.length, seed: log.seed })
}

// ── POST — append action to log (pure relay, no game logic) ──────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()

  let body: { type?: string; playerId?: string; action?: unknown; winner?: string } = {}
  try { body = await req.json() } catch {}

  const room = await roomStore.getRoom(roomId)
  if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

  const log = room.battleState as unknown as ActionLog | undefined
  if (!log || log.type !== 'action-log') {
    return NextResponse.json({ error: 'Battle not started' }, { status: 400 })
  }

  const { type = 'action', playerId, action, winner } = body
  const seq = log.actions.length
  const entry: ActionLogEntry = { seq, type: type as ActionLogEntry['type'], playerId, timestamp: Date.now() }
  if (action !== undefined) entry.action = action
  if (winner !== undefined) entry.winner = winner

  log.actions.push(entry)

  // Game over: create game record, mark room finished
  if (type === 'gameOver' && !room.gameRecord) {
    room.status = 'finished'
    room.gameRecord = {
      gameId: roomId + '-' + Date.now(),
      timestamp: Date.now(),
      roomId,
      players: room.players.map(p => ({ id: p.id, name: p.name, publicKey: (p as any).publicKey })),
      winner: winner ?? null,
      signatures: {},
    }
  }

  await roomStore.setRoom(roomId, room)

  // Notify WebSocket subscribers
  broadcastToRoom(roomId, { type: 'actionLog', entry })

  return NextResponse.json({ seq })
}
