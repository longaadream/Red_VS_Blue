import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers, DEMO_FIXED_MAP_ID } from "@/lib/game/battle-setup"
import { getPieceById } from "@/lib/game/piece-repository"
import type { PieceTemplate } from "@/lib/game/piece"
import { createRootSeed } from "@/lib/game/rule-runtime"
import { hashBattleState } from "@/lib/game/battle-runner"
import { stampPendingDeploymentAuthorityVersion } from "@/lib/game/battle-trace"

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

  const players: Array<{ id: string; faction: 'red' | 'blue'; pieces: Array<{ templateId: string }> }> =
    body.players
  const redPlayers = players.filter(player => player.faction === 'red')
  const bluePlayers = players.filter(player => player.faction === 'blue')
  if (redPlayers.length !== 1 || bluePlayers.length !== 1) {
    return NextResponse.json({ error: "players must contain exactly one red and one blue seat" }, { status: 400 })
  }
  const firstPlayerId = redPlayers[0].id

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
    DEMO_FIXED_MAP_ID,
    {
      firstPlayerId,
      rootSeed: seed,
      deploymentEnabled: true,
      deploymentStartedAt: Date.now(),
    },
  )

  if (!state) {
    return NextResponse.json({ error: "Failed to create battle state" }, { status: 500 })
  }

  const authorityVersion = 1
  stampPendingDeploymentAuthorityVersion(state, authorityVersion)
  return NextResponse.json({
    state, seed, stateHash: hashBattleState(state), authorityVersion,
  })
}
