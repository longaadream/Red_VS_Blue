import { withServerSkills } from '@/lib/game/battle-storage'
import {
  safeCloneBattleState,
  validateSkillActionByDryRun,
  type BattleAction,
  type BattleState,
} from '@/lib/game/turn'
import { prepareAction } from '@/lib/game/targeting'

export type Red43ScenarioId = 'light-light' | 'dark-dark'

interface Red43Scenario {
  id: Red43ScenarioId
  alignment: 'light' | 'dark'
  seed: number
  roster: string[]
  casterTemplateId: string
  skillId: string
  actionType: 'useBasicSkill' | 'useChargeSkill'
  expectedFilter: 'ally' | 'enemy'
  requiredChargePoints?: number
}

export interface Red43TargetEvidence {
  casterPieceId: string
  casterOwnerPlayerId: string
  casterTemplateId: string
  skillId: string
  expectedFilter: 'ally' | 'enemy'
  acceptedTargetPieceIds: string[]
  rejectedTargetPieceIds: string[]
  rejectionReasons: Record<string, string>
}

type Red43TargetAction = Extract<
  BattleAction,
  { type: 'useBasicSkill' | 'useChargeSkill' }
>

export const RED43_SCENARIOS: Record<Red43ScenarioId, Red43Scenario> = {
  'light-light': {
    id: 'light-light',
    alignment: 'light',
    seed: 4301,
    roster: [
      'blue-kenshin',
      'tracer',
      'anduin',
      'hashirama-edo',
      'jaina',
      'ana',
      'blue-tirion-fordring',
      'uther',
    ],
    casterTemplateId: 'blue-kenshin',
    skillId: 'kenshin-amakakeru',
    actionType: 'useChargeSkill',
    expectedFilter: 'enemy',
    requiredChargePoints: 3,
  },
  'dark-dark': {
    id: 'dark-dark',
    alignment: 'dark',
    seed: 4302,
    roster: [
      'guldan',
      'arthas',
      'red-sasuke',
      'red-blackwidow',
      'red-doomsday-fist',
      'red-hidan',
      'red-illidan',
      'reaper',
    ],
    casterTemplateId: 'guldan',
    skillId: 'fel-blessing',
    actionType: 'useBasicSkill',
    expectedFilter: 'ally',
  },
}

export function getRed43Scenario(value: unknown): Red43Scenario | undefined {
  if (value === 'light-light' || value === 'dark-dark') return RED43_SCENARIOS[value]
  return undefined
}

export function prepareRed43State(
  state: BattleState,
  playerId: string,
  scenario: Red43Scenario,
): BattleState {
  const player = state.players.find(candidate => candidate.playerId === playerId)
  if (!player) throw new Error(`RED-43 QA player not found: ${playerId}`)

  // The fixture is for target-set acceptance, so resource gating must not hide an
  // otherwise valid owner-based candidate during the first low-AP turn.
  player.actionPoints = Math.max(player.actionPoints || 0, 10)
  player.maxActionPoints = Math.max(player.maxActionPoints || 0, 10)

  if (scenario.requiredChargePoints) {
    player.chargePoints = Math.max(player.chargePoints || 0, scenario.requiredChargePoints)
    const playerWithLegacyChargeCap = player as typeof player & { maxChargePoints?: number }
    playerWithLegacyChargeCap.maxChargePoints = Math.max(
      playerWithLegacyChargeCap.maxChargePoints || 0,
      scenario.requiredChargePoints,
    )
  }

  return state
}

export function collectRed43TargetEvidence(
  state: BattleState,
  playerId: string,
  scenario: Red43Scenario,
): Red43TargetEvidence {
  const caster = state.pieces.find(piece =>
    piece.ownerPlayerId === playerId && piece.templateId === scenario.casterTemplateId,
  )
  if (!caster) {
    throw new Error(`RED-43 QA caster not found: ${scenario.casterTemplateId}`)
  }

  const acceptedTargetPieceIds: string[] = []
  const rejectedTargetPieceIds: string[] = []
  const rejectionReasons: Record<string, string> = {}

  for (const candidate of state.pieces.filter(piece => piece.currentHp > 0)) {
    const draftAction: Red43TargetAction = {
      type: scenario.actionType,
      playerId,
      pieceId: caster.instanceId,
      skillId: scenario.skillId,
    }

    try {
      const candidateState = withServerSkills(safeCloneBattleState(state)) as BattleState
      const preparation = prepareAction(candidateState, draftAction)
      if (preparation.kind === 'invalid') {
        throw new Error(preparation.message || preparation.code)
      }
      const action: Red43TargetAction = {
        ...draftAction,
        targetPieceId: candidate.instanceId,
      }
      if (preparation.kind === 'needTarget') {
        action.selectionId = preparation.selectionId
        action.stateRevision = preparation.stateRevision
      }
      validateSkillActionByDryRun(candidateState, action)
      acceptedTargetPieceIds.push(candidate.instanceId)
    } catch (error) {
      rejectedTargetPieceIds.push(candidate.instanceId)
      rejectionReasons[candidate.instanceId] = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    casterPieceId: caster.instanceId,
    casterOwnerPlayerId: caster.ownerPlayerId,
    casterTemplateId: scenario.casterTemplateId,
    skillId: scenario.skillId,
    expectedFilter: scenario.expectedFilter,
    acceptedTargetPieceIds: acceptedTargetPieceIds.sort(),
    rejectedTargetPieceIds: rejectedTargetPieceIds.sort(),
    rejectionReasons,
  }
}
