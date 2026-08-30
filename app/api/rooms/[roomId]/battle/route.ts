import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import {
  broadcastBattleTransition,
  broadcastToRoom,
  queueBotTurnIfReady,
} from "@/lib/ws-server"
import {
  createPublicBattleSnapshot,
  createPublicBattleTransitionUpdate,
  dispatchRoomBattleAction,
  scheduleRoomBattleTimeout,
} from "@/lib/game/room-battle-actions"
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from "@/lib/game/battle-public-patch"
import { parseBattleAuthorityEnvelope, roomBattleAuthorityVersion } from "@/lib/game/battle-transition"
import { verifyBattleActionAuth } from "@/lib/game/identity-verify"
import { getClientTerminalSubmissionError } from "@/lib/server/battle-terminal"

// Full snapshots are recovery/checkpoint responses only. Normal commands return
// an exact receipt plus an ordered public patch.
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()

  let body: Record<string, any> = {}
  try { body = await req.json() } catch {}
  const terminalSubmissionError = getClientTerminalSubmissionError(body)
  if (terminalSubmissionError) {
    return NextResponse.json({ error: terminalSubmissionError.message, code: terminalSubmissionError.code }, { status: 400 })
  }

  const command = body.command ?? body.action
  if (!command) return NextResponse.json({ error: 'command is required' }, { status: 400 })
  const room = await roomStore.getRoom(roomId)
  if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

  let verifiedPlayerId: string
  try {
    verifiedPlayerId = (await verifyBattleActionAuth(body.auth, { roomId, action: command })).playerId
  } catch (error) {
    const authError = error as { code?: string; message?: string }
    return NextResponse.json({
      error: authError.message ?? 'Battle action authentication failed',
      code: authError.code ?? 'BATTLE_AUTH_INVALID',
    }, { status: 401 })
  }

  let envelope
  try {
    envelope = parseBattleAuthorityEnvelope({
      protocolVersion: body.protocolVersion ?? BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: body.authorityBuildId ?? BATTLE_AUTHORITY_BUILD_ID,
      roomId,
      clientActionId: body.clientActionId ?? command.clientActionId,
      expectedAuthorityVersion: Number.isSafeInteger(body.expectedAuthorityVersion)
        ? body.expectedAuthorityVersion
        : roomBattleAuthorityVersion(room),
      playerId: body.playerId ?? body.viewerPlayerId ?? verifiedPlayerId,
      command,
      selectionId: body.selectionId ?? command.selectionId,
      stateRevision: body.stateRevision ?? command.stateRevision,
    }, roomId)
  } catch (error) {
    const envelopeError = error as { code?: string; message?: string }
    return NextResponse.json({
      error: envelopeError.message ?? 'Invalid battle command envelope',
      code: envelopeError.code ?? 'BATTLE_ENVELOPE_INVALID',
    }, { status: 400 })
  }

  const headerViewer = req.headers.get('x-player-id')?.trim().toLowerCase()
  if (
    envelope.playerId !== verifiedPlayerId
    || (headerViewer && headerViewer !== verifiedPlayerId)
  ) {
    return NextResponse.json({
      error: 'Request player identity does not match the authenticated viewer.',
      code: 'ACTION_PLAYER_MISMATCH',
    }, { status: 403 })
  }

  try {
    const result = await dispatchRoomBattleAction(
      roomStore,
      roomId,
      verifiedPlayerId,
      envelope.command,
      { expectedAuthorityVersion: envelope.expectedAuthorityVersion },
    )

    if (result.transition) broadcastBattleTransition(roomId, result)
    else if (result.kind === 'applied' || result.kind === 'expired') {
      broadcastToRoom(roomId, { type: 'stateUpdate', ...result.snapshot })
    }
    await scheduleRoomBattleTimeout(roomStore, roomId, {
      onCommitted: snapshot => broadcastToRoom(roomId, { type: 'stateUpdate', ...snapshot }),
      onTransitionCommitted: timerResult => broadcastBattleTransition(roomId, timerResult),
      onBotTurnReady: snapshot => { void queueBotTurnIfReady(roomId, snapshot.state) },
    })
    queueBotTurnIfReady(roomId, result.actionResult.state)

    if (result.kind === 'resyncRequired') {
      return NextResponse.json({
        ok: false,
        receipt: result.receipt,
        snapshot: result.snapshot,
      }, { status: 409 })
    }
    const transition = createPublicBattleTransitionUpdate(result, roomId, verifiedPlayerId)
    if (result.kind === 'expired') {
      return NextResponse.json({
        ok: false,
        receipt: result.receipt,
        transition,
        ...(!transition ? { snapshot: result.snapshot } : {}),
        error: result.receipt?.message,
        code: result.receipt?.code,
      }, { status: 409 })
    }
    return NextResponse.json({
      ok: true,
      receipt: result.receipt,
      transition,
      ...(!transition ? result.snapshot : {}),
      actionHash: result.submittedActionResult?.actionHash ?? result.actionResult.actionHash,
      duplicate: result.kind === 'duplicate',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const errAny = err as any
    const status = errAny?.code === 'VIEWER_FORBIDDEN' || errAny?.code === 'ACTION_PLAYER_MISMATCH'
      ? 403
      : errAny?.code === 'ROOM_VERSION_CONFLICT'
        ? 409
        : 400
    return NextResponse.json({
      error: message,
      code: errAny?.code,
      receipt: errAny?.receipt,
      preparation: errAny?.preparation,
      needsTargetSelection: errAny?.needsTargetSelection || undefined,
      targetType: errAny?.targetType,
      range: errAny?.range,
      filter: errAny?.filter,
      targetIndex: errAny?.targetIndex,
      needsOptionSelection: errAny?.needsOptionSelection || undefined,
      title: errAny?.title,
      options: errAny?.options,
      determinism: errAny?.determinism,
      context: errAny?.context,
    }, { status })
  }
}
