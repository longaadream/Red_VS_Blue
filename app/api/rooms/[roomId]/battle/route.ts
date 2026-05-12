import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import { applyBattleAction } from "@/lib/game/turn"
import { loadAllSkillsById } from "@/lib/game/skills"
import { broadcastToRoom } from "@/lib/ws-server"

interface ServerBattleState {
  type: 'server-state'
  seed: number
  state: unknown  // BattleState JSON-safe (functions stripped by DB serialization)
}

function getBattleStorage(room: any): ServerBattleState | null {
  const bs = room.battleState as any
  if (!bs) return null
  // support both new 'server-state' and legacy 'action-log' formats
  if (bs.type === 'server-state') return bs as ServerBattleState
  // legacy: extract initial state from first init entry
  if (bs.type === 'action-log' && Array.isArray(bs.actions)) {
    const init = bs.actions.find((a: any) => a.type === 'init')
    if (init?.payload) return { type: 'server-state', seed: bs.seed ?? 0, state: init.payload }
  }
  return null
}

function withServerSkills(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  return {
    ...(state as Record<string, unknown>),
    skillsById: loadAllSkillsById(),
  }
}

function withoutServerSkills(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const { skillsById: _skillsById, ...rest } = state as Record<string, unknown>
  return rest
}

// ── GET — return current authoritative battle state ──────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const room = await roomStore.getRoom(roomId)
  if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

  const storage = getBattleStorage(room)
  if (!storage) return NextResponse.json({ error: 'Battle not started' }, { status: 400 })

  return NextResponse.json({ state: storage.state, seed: storage.seed })
}

// ── POST — apply action authoritatively, broadcast new state via WS ──────────

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

  // ── gameOver: mark room finished, broadcast ──
  if (body.type === 'gameOver') {
    if (!room.gameRecord) {
      room.status = 'finished'
      room.gameRecord = {
        gameId: roomId + '-' + Date.now(),
        timestamp: Date.now(),
        roomId,
        players: room.players.map((p: any) => ({ id: p.id, name: p.name, publicKey: p.publicKey })),
        winner: body.winner ?? null,
        signatures: {},
      }
      await roomStore.setRoom(roomId, room)
    }
    broadcastToRoom(roomId, { type: 'gameOver', winner: body.winner })
    return NextResponse.json({ ok: true })
  }

  // ── regular battle action: apply on server ──
  const storage = getBattleStorage(room)
  if (!storage) return NextResponse.json({ error: 'Battle not started' }, { status: 400 })

  const action = body.action
  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 })

  let newState: unknown
  try {
    // applyBattleAction internally calls restorePieceRules/restorePlayerRules
    const hydratedState = withServerSkills(storage.state)
    newState = applyBattleAction(hydratedState as any, action as any)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errAny = err as any
    if (errAny?.needsTargetSelection) {
      return NextResponse.json({
        error: msg,
        needsTargetSelection: true,
        targetType: errAny.targetType ?? '',
        range: errAny.range ?? 10,
        filter: errAny.filter ?? '',
      }, { status: 400 })
    }
    if (errAny?.needsOptionSelection) {
      return NextResponse.json({
        error: msg,
        needsOptionSelection: true,
        title: errAny.title ?? '请选择',
        options: errAny.options ?? [],
      }, { status: 400 })
    }
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  storage.state = withoutServerSkills(newState)
  room.battleState = storage as any
  await roomStore.setRoom(roomId, room)

  broadcastToRoom(roomId, { type: 'stateUpdate', state: storage.state })

  return NextResponse.json({ ok: true })
}
