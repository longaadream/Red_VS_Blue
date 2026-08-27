import { NextRequest, NextResponse } from "next/server"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { getPieceById } from "@/lib/game/piece-repository"
import type { PieceTemplate } from "@/lib/game/piece"
import { createRootSeed } from "@/lib/game/rule-runtime"
import { hashBattleState } from "@/lib/game/battle-runner"
import { stampPendingDeploymentAuthorityVersion } from "@/lib/game/battle-trace"
import { assertSelectableMapId, isMapSelectionError } from "@/lib/game/map-selection"

/**
 * POST /api/relay-battle-init
 *
 * Called by the relay HOST CLIENT on its same-origin local server.
 * Creates an initial BattleState from the relay room's player/piece selections
 * and returns it — no room is stored server-side.
 *
 * Body:
 * {
 *   players: [
 *     { id: string, faction: 'red'|'blue', alignment?: 'light'|'dark', pieces: Array<{ templateId: string }> }
 *   ],
 *   mapId: string
 * }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.players) || body.players.length < 2) {
    return NextResponse.json({ error: "players array with at least 2 entries required" }, { status: 400 })
  }

  const players: Array<{ id: string; faction: 'red' | 'blue'; alignment?: 'light' | 'dark'; pieces: Array<{ templateId: string }> }> =
    body.players
  const redPlayers = players.filter(player => player.faction === 'red')
  const bluePlayers = players.filter(player => player.faction === 'blue')
  if (redPlayers.length !== 1 || bluePlayers.length !== 1) {
    return NextResponse.json({ error: "players must contain exactly one red and one blue seat" }, { status: 400 })
  }
  let mapId: string
  try {
    mapId = assertSelectableMapId(body.mapId)
  } catch (error) {
    if (!isMapSelectionError(error)) throw error
    return NextResponse.json(
      { error: error.message, code: error.code, context: error.context },
      { status: 400 },
    )
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
    return { playerId: player.id, faction: player.faction, alignment: player.alignment, pieces }
  })

  // Flat list for the overloaded first arg
  const allPieces = playerSelectedPieces.flatMap(p => p.pieces)

  const seed = createRootSeed()
  const state = await createInitialBattleForPlayers(
    playerIds,
    allPieces,
    playerSelectedPieces,
    mapId,
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
