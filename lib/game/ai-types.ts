/** Versioned, rule-independent vocabulary consumed by AI observers and planners. */
export const AI_SEMANTICS_SCHEMA_VERSION = 1 as const

export type AiMechanic =
  | 'damage' | 'heal' | 'control' | 'cleanse' | 'protect' | 'move'
  | 'summon' | 'transform' | 'resource' | 'delayed' | 'status' | 'combo'

export type AiCompatibility = 'automatic' | 'metadata-required' | 'evaluator-required' | 'unsupported'

export interface AiStatusFeature {
  type: string
  stacks: number
  duration?: number
  dispellable?: boolean
  visible: boolean
}

export interface AiObservation {
  schemaVersion: typeof AI_SEMANTICS_SCHEMA_VERSION
  observationScope: 'public-state'
  rulesHash: string
  contentHash: string
  allies: Array<{ id: string; hp: number; maxHp: number; x: number; y: number; statuses: AiStatusFeature[] }>
  enemies: Array<{ id: string; hp: number; maxHp: number; x: number; y: number; statuses: AiStatusFeature[] }>
}

export interface AiTransitionFeatures {
  mechanics: AiMechanic[]
  hpDelta: number
  piecesSummoned: number
  piecesRemoved: number
  statusAdded: number
  statusRemoved: number
  resourceDelta: number
}

export interface AiCandidateActionFeatures {
  schemaVersion: typeof AI_SEMANTICS_SCHEMA_VERSION
  actionType: string
  contentId?: string
  targetCount: number
  mechanics: AiMechanic[]
  compatibility: AiCompatibility
  diagnostics?: string
}
