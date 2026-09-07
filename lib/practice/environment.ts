import { aiEnvironmentV1 } from '../game/ai-environment'
import type { AIEnvironment } from '../game/ai-types'
import type { BattleState } from '../game/turn'
import type { AIObservation, PracticeStatus } from './evaluator-types'

/** v8's only extra label is the source of an already-public status. No private tags are added. */
export function observePractice(state: BattleState, playerId: string): AIObservation {
  const observation: AIObservation = aiEnvironmentV1.observe(state, playerId)
  for (const [projected, source] of [[observation.pieces, state.pieces], [observation.graveyard, state.graveyard]] as const) {
    projected.forEach(piece => {
      const original = source.find(item => item.instanceId === piece.instanceId)
      piece.statusTags.forEach((tag: PracticeStatus) => {
        const match = original?.statusTags?.find(item => item.id === tag.id && item.visible !== false)
        if (typeof match?.sourcePlayerId === 'string') tag.sourcePlayerId = match.sourcePlayerId
      })
    })
  }
  return observation
}

// Current main's official isolated reducer. RED-184's unmerged training fast path is deliberately
// not a runtime dependency; browser timing must be measured independently.
export const practiceEnvironment: AIEnvironment = { ...aiEnvironmentV1, observe: observePractice }
