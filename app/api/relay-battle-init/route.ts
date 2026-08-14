import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getPieceById } from "@/lib/game/piece-repository"
import type { Faction, PieceTemplate } from "@/lib/game/piece"
import { createRootSeed } from "@/lib/game/rule-runtime"

/**
 * POST /api/relay-battle-init
 *
 * Called by the relay HOST CLIENT on their LOCAL server (localhost:7878 or :3001).
 * Creates an initial BattleState from the relay room's player/piece selections
 * and returns it — no room is stored server-side.
 *
 * Body:
 * {
 *   players: [
 *     { id: string, faction: 'red'|'blue', pieces: Array<{ templateId: string }> }
 *   ],
 *   mapId?: string
 * }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.players) || body.players.length < 2) {
    return NextResponse.json({ error: "players array with at least 2 entries required" }, { status: 400 })
  }

  const players: Array<{ id: string; faction: Faction; pieces: Array<{ templateId: string }> }> =
    body.players

  const playerIds = players.map(p => p.id)

  // Build per-player piece template arrays
  const playerSelectedPieces = players.map(player => {
    const pieces = (player.pieces ?? [])
      .map(p => {
        const tpl = getPieceById(p.templateId)
        if (!tpl) return null
        return { ...tpl, faction: player.faction } as PieceTemplate
      })
      .filter((p): p is PieceTemplate => p !== null)
    return { playerId: player.id, pieces }
  })

  // Flat list for the overloaded first arg
  const allPieces = playerSelectedPieces.flatMap(p => p.pieces)

  const seed = createRootSeed()
  const state = await createInitialBattleForPlayers(
    playerIds,
    allPieces,
    playerSelectedPieces,
    body.mapId,
    { rootSeed: seed },
  )

  if (!state) {
    return NextResponse.json({ error: "Failed to create battle state" }, { status: 500 })
  }

  return NextResponse.json({ state, seed })
}
