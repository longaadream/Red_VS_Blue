import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import { broadcastToRoom } from "@/lib/ws-server"
import {
  createPublicBattleSnapshot,
  dispatchRoomBattleAction,
} from "@/lib/game/room-battle-actions"
import { verifyBattleActionAuth } from "@/lib/game/identity-verify"
import { getClientTerminalSubmissionError } from "@/lib/server/battle-terminal"

// ── GET — return current authoritative battle state ──────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const room = await roomStore.getRoom(roomId)
  if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

  const viewerPlayerId = req.headers.get('x-player-id')
    ?? req.nextUrl.searchParams.get('viewerPlayerId')
    ?? undefined
  try {
    return NextResponse.json(createPublicBattleSnapshot(room, viewerPlayerId))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

// ── POST — apply action authoritatively, broadcast new state via WS ──────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()

  let body: {
    type?: string
    playerId?: string
    viewerPlayerId?: string
    action?: unknown
    auth?: unknown
    winner?: unknown
    terminalResult?: unknown
  } = {}
  try { body = await req.json() } catch {}

  const terminalSubmissionError = getClientTerminalSubmissionError(body)
  if (terminalSubmissionError) {
    return NextResponse.json({ error: terminalSubmissionError.message, code: terminalSubmissionError.code }, { status: 400 })
  }

  // ── regular battle action: apply on server ──
  const action = body.action
  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 })

  let verifiedPlayerId: string
  try {
    verifiedPlayerId = (await verifyBattleActionAuth(body.auth, { roomId, action })).playerId
  } catch (error) {
    const authError = error as { code?: string; message?: string }
    return NextResponse.json({
      error: authError.message ?? 'Battle action authentication failed',
      code: authError.code ?? 'BATTLE_AUTH_INVALID',
    }, { status: 401 })
  }

  const headerViewer = req.headers.get('x-player-id')?.trim().toLowerCase()
  const bodyViewer = (body.viewerPlayerId ?? body.playerId)?.trim().toLowerCase()
  if (
    (headerViewer && headerViewer !== verifiedPlayerId)
    || (bodyViewer && bodyViewer !== verifiedPlayerId)
  ) {
    return NextResponse.json({
      error: 'Request player identity does not match the authenticated viewer.',
      code: 'ACTION_PLAYER_MISMATCH',
    }, { status: 403 })
  }
  const viewerPlayerId = verifiedPlayerId

  let result: Awaited<ReturnType<typeof dispatchRoomBattleAction>>
  try {
    result = await dispatchRoomBattleAction(roomStore, roomId, viewerPlayerId, action as any)
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
        context: errAny.context ?? undefined,
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
        context: errAny.context ?? undefined,
      }, { status: 400 })
    }
    const status = errAny?.code === 'VIEWER_FORBIDDEN' || errAny?.code === 'ACTION_PLAYER_MISMATCH'
      ? 403
      : errAny?.code === 'ROOM_VERSION_CONFLICT'
      ? 409
      : 400
    return NextResponse.json({
      error: msg,
      code: errAny?.code,
      determinism: errAny?.determinism ?? undefined,
      context: errAny?.context ?? undefined,
    }, { status })
  }

  const stateUpdate = {
    type: 'stateUpdate',
    ...result.snapshot,
    duplicate: result.kind === 'duplicate',
  }
  if (result.kind !== 'duplicate') broadcastToRoom(roomId, stateUpdate)
  if (result.kind === 'expired') {
    return NextResponse.json({
      error: 'Deployment deadline elapsed; the authoritative timeout was committed instead.',
      code: 'DEPLOYMENT_EXPIRED',
      ...result.snapshot,
    }, { status: 409 })
  }

  return NextResponse.json({
    ok: true,
    ...result.snapshot,
    actionHash: result.actionResult.actionHash,
    duplicate: result.kind === 'duplicate',
  })
}
