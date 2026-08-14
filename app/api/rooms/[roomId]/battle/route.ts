import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import { getBattleStorage } from "@/lib/game/battle-storage"
import { runBattleAction } from "@/lib/game/battle-runner"
import { broadcastToRoom } from "@/lib/ws-server"

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

  let result: ReturnType<typeof runBattleAction>
  try {
    result = runBattleAction(storage.state as any, action as any, { rootSeed: storage.seed })
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
        targetIndex: errAny.targetIndex ?? undefined,
        determinism: errAny.determinism ?? undefined,
      }, { status: 400 })
    }
    if (errAny?.needsOptionSelection) {
      return NextResponse.json({
        error: msg,
        needsOptionSelection: true,
        title: errAny.title ?? '请选择',
        options: errAny.options ?? [],
        determinism: errAny.determinism ?? undefined,
      }, { status: 400 })
    }
    return NextResponse.json({ error: msg, determinism: errAny.determinism ?? undefined }, { status: 400 })
  }

  storage.state = result.state
  room.battleState = storage as any
  await roomStore.setRoom(roomId, room)

  broadcastToRoom(roomId, { type: 'stateUpdate', state: storage.state, seed: storage.seed, stateHash: result.stateHash, duplicate: result.duplicate })

  return NextResponse.json({
    ok: true,
    state: storage.state,
    seed: storage.seed,
    stateHash: result.stateHash,
    actionHash: result.actionHash,
    duplicate: result.duplicate === true,
  })
}
