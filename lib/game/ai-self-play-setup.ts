import { createInitialBattleForPlayers, DEMO_DEPLOYMENT_MAP_ID } from './battle-setup'
import type { SelfPlayInitialStateInput } from './ai-match-runner'
import { getPieceById } from './piece-repository'
import type { BattleState } from './turn'

/**
 * Build the authoritative deterministic initial state shared by self-play runs
 * and recorded-action replay exports.
 */
export async function createSelfPlayInitialState(
  input: SelfPlayInitialStateInput,
): Promise<BattleState> {
  const playerIds = ['player-red', 'player-blue'] as const
  const playerSelectedPieces = playerIds.map(playerId => {
    const roster = input.rosters[playerId]
    const pieces = roster.pieceIds.map(pieceId => {
      const piece = getPieceById(pieceId)
      if (!piece) throw new Error(`Unknown roster piece ${pieceId} in ${roster.rosterId}`)
      return piece
    })
    if (pieces.length !== 8) throw new Error(`${roster.rosterId} must contain exactly eight pieces`)
    return { playerId, faction: roster.faction, pieces }
  })
  const selectedPieces = playerSelectedPieces.flatMap(entry => entry.pieces)
  const state = await createInitialBattleForPlayers(
    [...playerIds],
    selectedPieces,
    playerSelectedPieces,
    DEMO_DEPLOYMENT_MAP_ID,
    {
      firstPlayerId: 'player-red',
      rootSeed: input.rootSeed,
      deploymentEnabled: true,
      deploymentStartedAt: 0,
    },
  )
  if (!state) throw new Error('Battle setup returned null')
  return state
}
