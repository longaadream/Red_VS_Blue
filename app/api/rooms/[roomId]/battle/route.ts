import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import {
  type BattleAction,
  type BattleState,
  applyBattleAction,
  BattleRuleError,
} from "@/lib/game/turn"
import { loadRuleById } from "@/lib/game/skills"

/**
 * 重新为战斗状态中所有棋子的规则注入 effect 函数。
 * 规则对象保存到 JSON 文件时，函数会丢失，每次加载后需重新注入。
 */
function rehydrateBattleRules(battleState: BattleState): void {
  for (const piece of battleState.pieces) {
    if (!piece.rules || piece.rules.length === 0) continue
    piece.rules = piece.rules.map((rule: any) => {
      if (typeof rule.effect !== 'function' && rule.id) {
        const rehydrated = loadRuleById(rule.id)
        if (rehydrated && typeof rehydrated.effect === 'function') {
          return rehydrated
        }
        console.warn(`Failed to rehydrate rule ${rule.id}, adding default effect`)
        return {
          ...rule,
          effect: () => ({ success: false, message: '' })
        }
      }
      return rule
    })
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const room = await roomStore.getRoom(roomId)

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  if (!room.battleState) {
    return NextResponse.json(
      { error: "Battle has not started in this room" },
      { status: 400 },
    )
  }

  return NextResponse.json(room.battleState)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId: rawRoomId } = await params
  const roomId = rawRoomId.trim().toLowerCase()
  const room = await roomStore.getRoom(roomId)

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 })
  }

  if (!room.battleState) {
    return NextResponse.json(
      { error: "Battle has not started in this room" },
      { status: 400 },
    )
  }

  let body: BattleAction
  try {
    body = (await req.json()) as BattleAction
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    rehydrateBattleRules(room.battleState)
    const nextState = applyBattleAction(room.battleState, body)
    console.log('[Battle API] Players chargePoints after action:', nextState.players.map(p => ({ playerId: p.playerId, chargePoints: p.chargePoints })))
    const uniquePieces = nextState.pieces.filter((piece: any, index: number, self: any[]) =>
      index === self.findIndex((p: any) => p.instanceId === piece.instanceId)
    )
    if (uniquePieces.length !== nextState.pieces.length) {
      console.warn('[Battle API] Found duplicate pieces, deduplicating...')
      nextState.pieces = uniquePieces
    }
    room.battleState = nextState
    await roomStore.updateBattleState(room.id, nextState)

    return NextResponse.json(nextState)
  } catch (e) {
    if (e instanceof BattleRuleError) {
      if ((e as any).needsTargetSelection) {
        return NextResponse.json({
          needsTargetSelection: true,
          targetType: (e as any).targetType || 'piece',
          range: (e as any).range || 5,
          filter: (e as any).filter || 'enemy'
        }, { status: 400 })
      }
      if ((e as any).needsOptionSelection) {
        return NextResponse.json({
          needsOptionSelection: true,
          options: (e as any).options || [],
          title: (e as any).title || '请选择'
        }, { status: 400 })
      }
      return NextResponse.json({ error: e.message }, { status: 400 })
    }

    console.error("Unexpected battle error", e)
    return NextResponse.json(
      { error: "Unexpected error while applying battle action" },
      { status: 500 }
    )
  }
}
