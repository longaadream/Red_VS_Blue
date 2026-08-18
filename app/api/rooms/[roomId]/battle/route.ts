import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import { getBattleStorage } from "@/lib/game/battle-storage"
import { broadcastToRoom } from "@/lib/ws-server"
import { getClientTerminalSubmissionError } from "@/lib/server/battle-terminal"
import { commitAuthoritativeBattleAction } from "@/lib/server/battle-command"

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

  let body: { type?: string; playerId?: string; action?: unknown; winner?: unknown; terminalResult?: unknown } = {}
  try { body = await req.json() } catch {}

  const terminalSubmissionError = getClientTerminalSubmissionError(body)
  if (terminalSubmissionError) {
    return NextResponse.json({ error: terminalSubmissionError.message, code: terminalSubmissionError.code }, { status: 400 })
  }

  const action = body.action
  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 })

  try {
    const { storage, result } = await commitAuthoritativeBattleAction({
      roomId,
      playerId: body.playerId as any,
      action: action as any,
    })

    broadcastToRoom(roomId, { type: 'stateUpdate', state: storage.state as any, seed: storage.seed, stateHash: result.stateHash, duplicate: result.duplicate })

    return NextResponse.json({
      ok: true,
      state: storage.state as any,
      seed: storage.seed,
      stateHash: result.stateHash,
      actionHash: result.actionHash,
      duplicate: result.duplicate === true,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errAny = err as any
    if (errAny?.needsTargetSelection) {
      return NextResponse.json({
        error: msg,
        code: errAny.code,
        needsTargetSelection: true,
        preparation: errAny.preparation,
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
        code: errAny.code,
        needsOptionSelection: true,
        preparation: errAny.preparation,
        title: errAny.title ?? '请选择',
        options: errAny.options ?? [],
        determinism: errAny.determinism ?? undefined,
      }, { status: 400 })
    }
    return NextResponse.json(
      { error: msg, code: errAny?.code, determinism: errAny?.determinism ?? undefined },
      { status: errAny?.status ?? 400 },
    )
  }
}
