import { assertSelectableMapId } from '@/lib/game/map-selection'
import { getDefaultDemoRosterSelection } from '@/lib/game/roster-contract'
import { loadCardById } from '@/lib/game/skills'
import {
  createPveRuntimeRegistryV1,
  type PveRuntimeRegistryV1,
} from './runtime-registry'

export const PROTOTYPE_PLAYER_ROSTER_ID_V1 = 'prototype-player-roster' as const
export const PROTOTYPE_ENEMY_ROSTER_ID_V1 = 'prototype-enemy-roster' as const
export const PROTOTYPE_AI_PROFILE_ID_V1 = 'prototype-basic-ai' as const
export const PROTOTYPE_OBJECTIVE_ID_V1 = 'defeat-all-enemies' as const
export const PROTOTYPE_MAP_ID_V1 = 'large-hole-arena' as const
export const PROTOTYPE_REWARD_TABLE_ID_V1 = 'prototype-card-reward-table' as const

const PROTOTYPE_REWARD_CARD_IDS_V1 = [
  'holy-heal',
  'holy-smite',
  'lucky-coin',
] as const

/**
 * Code-owned closure for the deliberately narrow RED-117 Prototype. Roster
 * entries are resolved from the active Profile's registered Demo manifests;
 * missing 8x8 content therefore fails before any Run is admitted.
 */
export function createPrototypePveRegistryV1(): Readonly<PveRuntimeRegistryV1> {
  assertSelectableMapId(PROTOTYPE_MAP_ID_V1)
  const playerPieces = getDefaultDemoRosterSelection('light')
    .map(piece => piece.templateId)
  const enemyPieces = getDefaultDemoRosterSelection('dark')
    .map(piece => piece.templateId)
  for (const cardId of PROTOTYPE_REWARD_CARD_IDS_V1) {
    if (!loadCardById(cardId)) {
      throw new Error(`Prototype reward card ${cardId} is unavailable in the active Profile`)
    }
  }

  return createPveRuntimeRegistryV1({
    maps: [PROTOTYPE_MAP_ID_V1],
    objectives: [PROTOTYPE_OBJECTIVE_ID_V1],
    rosters: [
      {
        rosterId: PROTOTYPE_PLAYER_ROSTER_ID_V1,
        pieceIds: playerPieces,
        initialDeck: [],
      },
      {
        rosterId: PROTOTYPE_ENEMY_ROSTER_ID_V1,
        pieceIds: enemyPieces,
      },
    ],
    aiProfiles: [PROTOTYPE_AI_PROFILE_ID_V1],
    effects: [
      {
        effectId: 'prototype-heal-party-small',
        apply: run => ({
          flags: {
            ...run.flags,
            'prototype-rested': true,
          },
        }),
      },
      {
        effectId: 'prototype-prepare-party',
        apply: run => ({
          flags: {
            ...run.flags,
            'prototype-prepared': true,
          },
        }),
      },
      {
        effectId: 'prototype-grant-card-reward',
        apply: (run, context) => ({
          deck: [...run.deck, context.subjectId],
        }),
      },
    ],
    rewardTables: [{
      rewardTableId: PROTOTYPE_REWARD_TABLE_ID_V1,
      subjectIds: PROTOTYPE_REWARD_CARD_IDS_V1,
    }],
    conditions: [],
  })
}
