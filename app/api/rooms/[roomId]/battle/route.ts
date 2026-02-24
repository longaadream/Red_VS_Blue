import { NextRequest, NextResponse } from "next/server"
import { roomStore } from "@/lib/game/room-store"
import {
  type BattleAction,
  type BattleState,
  applyBattleAction,
  BattleRuleError,
} from "@/lib/game/turn"
import { loadRuleById } from "@/lib/game/skills"

const rooms = roomStore

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
        // 只有当重新加载成功且有 effect 函数时才替换
        if (rehydrated && typeof rehydrated.effect === 'function') {
          return rehydrated
        }
        // 如果加载失败，保留原规则但添加一个空的 effect 函数防止报错
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
  const { roomId } = await params
  const room = rooms.getRoom(roomId)

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
  const { roomId } = await params
  const room = rooms.getRoom(roomId)

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
    // 从磁盘加载后规则的 effect 函数会丢失，需要在执行动作前重新注入
    rehydrateBattleRules(room.battleState)
    const nextState = applyBattleAction(room.battleState, body)
    room.battleState = nextState
    rooms.updateBattleState(room.id, nextState)

    return NextResponse.json(nextState)
  } catch (e) {
    if (e instanceof BattleRuleError) {
      // 检查是否是需要目标选择的错误
      if ((e as any).needsTargetSelection) {
        // 返回包含目标选择信息的响应
        return NextResponse.json({
          needsTargetSelection: true,
          targetType: (e as any).targetType || 'piece',
          range: (e as any).range || 5,
          filter: (e as any).filter || 'enemy'
        }, { status: 400 })
      }
      // 检查是否是需要选项选择的错误
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

