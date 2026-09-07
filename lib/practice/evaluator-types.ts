import type { AIObservation as BaseObservation, AIObservedPiece as BasePiece, AIObservedStatusTag } from '../game/ai-types'
export const ZERO_STAGE_AI_PROFILE_VERSION = 8 as const
export type PracticeStatus = AIObservedStatusTag & { sourcePlayerId?: string }
export type AIObservedPiece = Omit<BasePiece, 'statusTags'> & { statusTags: PracticeStatus[] }
export type AIObservation = Omit<BaseObservation, 'pieces' | 'graveyard'> & { pieces: AIObservedPiece[]; graveyard: AIObservedPiece[] }
export type ZeroStageStaticComponentKey =
  | 'coreSurvival'
  | 'survival'
  | 'graveyard'
  | 'health'
  | 'combatPower'
  | 'shield'
  | 'protection'
  | 'delayedDamage'
  | 'resources'
  | 'actionability'
  | 'deploymentReadiness'
  | 'turnProgress'
  | 'lethalOpportunity'
  | 'attackPressure'
  | 'status'
  | 'positionSafety'
  | 'strategicPosition'
  | 'enemyProximity'
  | 'futureAttackPotential'
  | 'supportPotential'
  | 'mobilityPotential'
  | 'terrainValue'

export interface ZeroStageConfig {
  version: typeof ZERO_STAGE_AI_PROFILE_VERSION
  candidateMode: 'all-legal'
  maxActionsPerTurn: number
  terminal: Readonly<{ win: number; loss: number; draw: number }>
  weights: Readonly<Record<ZeroStageStaticComponentKey, number>>
}

export interface ZeroStageStaticComponent {
  raw: number
  weight: number
  contribution: number
}

export interface ZeroStageStaticEvaluation {
  total: number
  terminalOutcome?: 'win' | 'loss' | 'draw'
  components: Readonly<Record<ZeroStageStaticComponentKey, ZeroStageStaticComponent>>
}
