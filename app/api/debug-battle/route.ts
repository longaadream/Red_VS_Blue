import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import {
  applyBattleAction,
  BattleRuleError,
  type BattleState,
  type BattleAction,
} from "@/lib/game/turn"
import { loadJsonFilesServer } from "@/lib/game/file-loader"
import { loadRuleById } from "@/lib/game/skills"
import type { PieceTemplate } from "@/lib/game/piece"

// 单个调试会话的内存状态（开发专用）
let debugState: BattleState | null = null

/**
 * 重新注入战斗状态中所有棋子规则的 effect 函数。
 * 与正式战斗路由保持完全一致的逻辑。
 */
function rehydrateBattleRules(battleState: BattleState): void {
  for (const piece of battleState.pieces) {
    if (!piece.rules || piece.rules.length === 0) continue
    piece.rules = piece.rules.map((rule: any) => {
      if (typeof rule.effect !== "function" && rule.id) {
        const rehydrated = loadRuleById(rule.id)
        return rehydrated || rule
      }
      return rule
    })
  }
}

/** GET — 返回可用棋子列表和当前调试状态 */
export async function GET() {
  const pieces = loadJsonFilesServer<PieceTemplate>("data/pieces")
  return NextResponse.json({
    availablePieces: Object.values(pieces),
    battleState: debugState,
  })
}

/** POST — 初始化战斗 or 执行战斗动作 */
export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // ── 初始化调试战局 ────────────────────────────────────────────────────────
  if (body.type === "init") {
    const { redPieceIds, bluePieceIds } = body as {
      redPieceIds: string[]
      bluePieceIds: string[]
    }
    const allPieces = loadJsonFilesServer<PieceTemplate>("data/pieces")

    const redPieces = (redPieceIds ?? [])
      .map((id) => allPieces[id])
      .filter(Boolean)
    const bluePieces = (bluePieceIds ?? [])
      .map((id) => allPieces[id])
      .filter(Boolean)

    if (redPieces.length === 0 || bluePieces.length === 0) {
      return NextResponse.json(
        { error: "双方各需至少选择一个棋子" },
        { status: 400 },
      )
    }

    const selectedPieces = [...redPieces, ...bluePieces]
    const playerSelectedPieces = [
      { playerId: "debug-red", pieces: redPieces },
      { playerId: "debug-blue", pieces: bluePieces },
    ]

    debugState = await createInitialBattleForPlayers(
      ["debug-red", "debug-blue"],
      selectedPieces,
      playerSelectedPieces,
    )

    return NextResponse.json({ battleState: debugState })
  }

  // ── 执行战斗动作（使用真实进程代码）────────────────────────────────────────
  if (!debugState) {
    return NextResponse.json(
      { error: "尚未初始化调试战局，请先 init" },
      { status: 400 },
    )
  }

  try {
    rehydrateBattleRules(debugState)
    const nextState = applyBattleAction(debugState, body as BattleAction)
    debugState = nextState
    return NextResponse.json({ battleState: debugState })
  } catch (e) {
    if (e instanceof BattleRuleError) {
      if ((e as any).needsTargetSelection) {
        return NextResponse.json(
          {
            needsTargetSelection: true,
            targetType: (e as any).targetType ?? "piece",
            range: (e as any).range ?? 5,
            filter: (e as any).filter ?? "enemy",
          },
          { status: 400 },
        )
      }
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    console.error("Debug battle unexpected error:", e)
    return NextResponse.json(
      {
        error:
          "Unexpected error: " +
          (e instanceof Error ? e.message : String(e)),
      },
      { status: 500 },
    )
  }
}
