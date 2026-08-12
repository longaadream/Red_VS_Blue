import { createInitialBattleForPlayers } from './battle-setup'
import { withoutServerSkills } from './battle-storage'
import { hashStable, runBattleAction } from './battle-runner'
import { loadJsonFilesServer } from './file-loader'
import type { PieceTemplate } from './piece'
import { alignmentToPieceFaction, normalizePlayerAlignment } from './room-store'
import { mulberry32, setRng } from './rng'
import type { BattleState } from './turn'

export const DEBUG_FIRST_PLAYER_ID = 'debug-red'
export const DEBUG_SECOND_PLAYER_ID = 'debug-blue'
export const DEBUG_PIECES_PER_PLAYER = 8

export interface DebugDuelPlayerConfig {
  playerId?: string
  seat?: 'red' | 'blue'
  alignment?: 'light' | 'dark' | 'good' | 'evil'
  templateIds?: string[]
}

export interface DebugDuelConfig {
  mapId?: string
  seed?: number
  first?: DebugDuelPlayerConfig
  second?: DebugDuelPlayerConfig
  piecesPerPlayer?: number
  beginPhase?: boolean
}

export interface DebugDuelResult {
  state: BattleState
  seed: number
  stateHash: string
  players: Array<{
    playerId: string
    seat: 'red' | 'blue'
    alignment: 'light' | 'dark'
    templateIds: string[]
  }>
}

export async function createDebugDuel(config: DebugDuelConfig = {}): Promise<DebugDuelResult> {
  const seed = Number.isInteger(config.seed) ? config.seed! : Math.floor(Math.random() * 4294967296)
  const piecesPerPlayer = config.piecesPerPlayer ?? DEBUG_PIECES_PER_PLAYER
  const firstAlignment = normalizePlayerAlignment(config.first?.alignment) ?? 'dark'
  const secondAlignment = normalizePlayerAlignment(config.second?.alignment) ?? 'light'
  const firstPlayerId = config.first?.playerId || DEBUG_FIRST_PLAYER_ID
  const secondPlayerId = config.second?.playerId || DEBUG_SECOND_PLAYER_ID

  const firstPieces = resolveDebugPieces(firstAlignment, config.first?.templateIds, piecesPerPlayer)
  const secondPieces = resolveDebugPieces(secondAlignment, config.second?.templateIds, piecesPerPlayer)
  const previousRng = Math.random.bind(Math)

  setRng(mulberry32(seed))
  try {
    const battle = await createInitialBattleForPlayers(
      [firstPlayerId, secondPlayerId],
      [...firstPieces, ...secondPieces],
      [
        { playerId: firstPlayerId, pieces: firstPieces, faction: config.first?.seat || 'red' },
        { playerId: secondPlayerId, pieces: secondPieces, faction: config.second?.seat || 'blue' },
      ],
      config.mapId || 'large-battlefield',
      { firstPlayerId },
    )

    if (!battle) {
      throw new Error('Failed to create debug duel battle state')
    }

    let state = withoutServerSkills(battle) as BattleState
    if (config.beginPhase !== false) {
      state = runBattleAction(state, { type: 'beginPhase' }).state
    }

    return {
      state,
      seed,
      stateHash: hashStable(state),
      players: [
        { playerId: firstPlayerId, seat: config.first?.seat || 'red', alignment: firstAlignment, templateIds: firstPieces.map(p => p.id) },
        { playerId: secondPlayerId, seat: config.second?.seat || 'blue', alignment: secondAlignment, templateIds: secondPieces.map(p => p.id) },
      ],
    }
  } finally {
    setRng(previousRng)
  }
}

function resolveDebugPieces(
  alignment: 'light' | 'dark',
  requestedTemplateIds: string[] | undefined,
  count: number,
): PieceTemplate[] {
  const requested = (requestedTemplateIds || [])
    .map(id => loadDebugPieces()[id])
    .filter((piece): piece is PieceTemplate => Boolean(piece))

  const seen = new Set(requested.map(piece => piece.id))
  const pieceFaction = alignmentToPieceFaction(alignment)
  const allPieces = Object.values(loadDebugPieces())
  const preferred = allPieces.filter(piece => piece.faction === pieceFaction && !seen.has(piece.id))
  const fallback = allPieces.filter(piece => !seen.has(piece.id) && !preferred.some(preferredPiece => preferredPiece.id === piece.id))

  return [...requested, ...preferred, ...fallback].slice(0, count)
}

function loadDebugPieces(): Record<string, PieceTemplate> {
  return loadJsonFilesServer<PieceTemplate>('data/pieces')
}
