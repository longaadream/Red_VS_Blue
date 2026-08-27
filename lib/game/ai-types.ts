import type { BoardMap } from './map'
import type { PieceInstance, PieceSkill } from './piece'
import type { BattleAction, BattleActionLog, BattleState, TurnState } from './turn'
import type { TerminalResult } from './terminal'
import type { TargetRef } from './targeting'
import type { BattleActionTrace } from './battle-trace'

export const AI_ENVIRONMENT_PROTOCOL_VERSION = 1 as const

export type AIEnvironmentProtocolVersion = typeof AI_ENVIRONMENT_PROTOCOL_VERSION

export type CandidateActionKind =
  | 'deployment-choice'
  | 'deployment-lock'
  | 'phase-advance'
  | 'pending-option'
  | 'pending-target'
  | 'cancel-selection'
  | 'move'
  | 'basic-skill'
  | 'charge-skill'
  | 'card'
  | 'end-turn'

export interface CandidateAction {
  protocolVersion: AIEnvironmentProtocolVersion
  id: string
  kind: CandidateActionKind
  action: BattleAction
}

export type AIUnsupportedActionType =
  | 'deploymentTimeout'
  | 'grantChargePoints'
  | 'surrender'

export interface AIEnvironmentCapabilities {
  protocolVersion: AIEnvironmentProtocolVersion
  supportedActionTypes: readonly BattleAction['type'][]
  unsupportedActionTypes: ReadonlyArray<{
    type: AIUnsupportedActionType
    reason: string
  }>
}

export interface AIObservedPlayer {
  playerId: string
  name?: string
  mangekyoDeathCount?: number
  chargePoints: number
  actionPoints: number
  maxActionPoints: number
  handCount: number
  hand?: BattleState['players'][number]['hand']
  discardPile: string[]
  statusTags?: AIObservedStatusTag[]
  skills?: Array<{ skillId: string; currentCooldown?: number }>
}

export interface AIObservedStatusTag {
  id: string
  type: string
  name?: string
  currentDuration?: number
  remainingDuration?: number
  currentUses?: number
  intensity?: number
  stacks?: number
  value?: number
  extraValue?: number
  centerX?: number
  centerY?: number
  damage?: number
  visible?: boolean
}

export interface AIObservedPiece {
  instanceId: string
  isCore?: boolean
  templateId: string
  name: string
  ownerPlayerId: string
  faction: PieceInstance['faction']
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  x: number | null
  y: number | null
  moveRange: number
  skills: PieceSkill[]
  displaySkills?: PieceSkill[]
  buffs: PieceInstance['buffs']
  debuffs: PieceInstance['debuffs']
  shield?: number
  statusTags: AIObservedStatusTag[]
}

export interface AIObservation {
  protocolVersion: AIEnvironmentProtocolVersion
  playerId: string
  stateRevision: number
  map: BoardMap
  pieces: AIObservedPiece[]
  graveyard: AIObservedPiece[]
  players: AIObservedPlayer[]
  turn: TurnState
  terminalResult?: TerminalResult
  deployment?: {
    status: 'awaiting-locks' | 'complete'
    playerIds: string[]
    locks: Record<string, { locked: boolean }>
    deadlineAt: number
    revision: number
    initialPositions: Record<string, { x: number; y: number }>
    finalPositions?: Record<string, { x: number; y: number }>
  }
  pendingOptionSelection?: {
    playerId: string
    title: string
    options: unknown[]
    selectionId?: string
    stateRevision?: number
    canCancel: boolean
    selectionMode?: 'single' | 'multi'
    presentation?: 'picker' | 'hand'
    minSelections?: number
    maxSelections?: number
  }
  pendingTargetSelection?: {
    playerId: string
    title?: string
    targetType: 'piece' | 'cell' | 'grid'
    selectionId?: string
    stateRevision?: number
    step: number
    candidates: TargetRef[]
    selectedTargets: TargetRef[]
    canCancel: boolean
    selectionMode?: 'single' | 'multi'
    minSelections?: number
    maxSelections?: number
  }
}

export interface AIStateDiffEntry {
  path: string
  before?: unknown
  after?: unknown
}

export interface AITransitionTrace {
  actionTrace?: BattleActionTrace
  actionLog: BattleActionLog[]
  stateChanges: AIStateDiffEntry[]
}

export interface AIEnvironmentError {
  code: string
  name: string
  message: string
  determinism?: {
    rootSeed: number
    streamName: string
    cursor: number
    turn: number
    playerId: string
    actionId: string
  }
}

export type TransitionResult =
  | {
      protocolVersion: AIEnvironmentProtocolVersion
      accepted: true
      state: BattleState
      stateHash: string
      transitionHash: string
      trace: AITransitionTrace
    }
  | {
      protocolVersion: AIEnvironmentProtocolVersion
      accepted: false
      state: BattleState
      stateHash: string
      transitionHash: string
      error: AIEnvironmentError
      trace: AITransitionTrace
    }

export interface AISimulationContext {
  rootSeed?: number
}

export type AIObservationScope =
  | { kind: 'full' }
  | { kind: 'player'; playerId: string }

export interface AIEnvironment {
  readonly protocolVersion: AIEnvironmentProtocolVersion
  readonly capabilities: AIEnvironmentCapabilities
  observe(state: BattleState, playerId: string): AIObservation
  listLegalActions(state: BattleState, playerId: string): CandidateAction[]
  simulate(
    state: BattleState,
    action: CandidateAction | BattleAction,
    context?: AISimulationContext,
  ): TransitionResult
  isTerminal(state: BattleState): boolean
  stateKey(state: BattleState, scope: AIObservationScope): string
}

export interface AIActionResourceCost {
  actionPoints: number
  chargePoints: number
}

/** A formal candidate revalidated after adding only its exact public resource shortfall. */
export interface AIPotentialCandidate {
  candidate: CandidateAction
  cost: AIActionResourceCost
  shortfall: AIActionResourceCost
  costBreakthrough: boolean
}

export interface AIPotentialTransition extends AIPotentialCandidate {
  transition: TransitionResult
}

export interface AIPotentialEnvironment {
  readonly protocolVersion: AIEnvironmentProtocolVersion
  listPotentialActions(state: BattleState, playerId: string): AIPotentialCandidate[]
  simulatePotential(
    state: BattleState,
    candidate: AIPotentialCandidate,
    context?: AISimulationContext,
  ): AIPotentialTransition
}

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

/** Stable, versioned configuration for the generic turn planner. */
export interface AiPlannerConfig {
  version: 1
  nodeBudget: number
  beamWidth: number
  maxActions: number
  candidateLimit: number
  /** Non-structural actions at or below this immediate utility are not expanded. */
  minActionScore: number
  weights: Readonly<Record<string, number>>
}

export type AiTurnGoalKind = 'eliminate' | 'protect' | 'control' | 'reposition' | 'conserve'

export interface AiTurnGoal {
  kind: AiTurnGoalKind
  targetId?: string
  rationale: string
}

/** Caller-owned guard state carried only across accepted actions in one authoritative turn. */
export interface AiPlannerContinuation {
  version: 1
  playerId: string
  rootSeed: number
  turnNumber: number
  actionsTaken: number
  visitedStateKeys: readonly string[]
}

export interface AiPlannerScore {
  total: number
  components: Readonly<Record<string, number>>
}

export interface AiPlannerTraceEntry {
  candidateId: string
  action: BattleAction
  score: AiPlannerScore
  depth: number
  candidateRank: number
  compatibility: AiCompatibility
  contentId?: string
  pruned?: string
  pruneDetail?: string
  rejected?: string
}

export type AiPlannerStopReason =
  | 'completed-turn'
  | 'terminal'
  | 'no-legal-actions'
  | 'budget-exhausted'
  | 'action-limit'

export interface AiTurnPlan {
  configVersion: number
  goal: AiTurnGoal
  goalChanged: boolean
  continuation: AiPlannerContinuation
  actions: CandidateAction[]
  /** The only action an authoritative caller may submit. Undefined means stop safely. */
  nextAction?: CandidateAction
  nodesVisited: number
  candidatesConsidered: number
  stateDuplicates: number
  stopReason: AiPlannerStopReason
  trace: AiPlannerTraceEntry[]
}

export const ZERO_STAGE_AI_PROFILE_VERSION = 1 as const

export type ZeroStageStaticComponentKey =
  | 'coreSurvival'
  | 'survival'
  | 'graveyard'
  | 'health'
  | 'combatPower'
  | 'shield'
  | 'resources'
  | 'actionability'
  | 'lethalOpportunity'
  | 'attackPressure'
  | 'status'
  | 'formation'
  | 'mapControl'

export interface ZeroStageConfig {
  version: typeof ZERO_STAGE_AI_PROFILE_VERSION
  nodeBudget: number
  lambda: number
  topWeights: readonly [number, number, number]
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

export interface ZeroStageFollowUpTrace {
  candidateId: string
  value?: number
  staticValue?: number
  costBreakthrough: boolean
  cost: AIActionResourceCost
  shortfall: AIActionResourceCost
  penalty: number
  compatibility: AiCompatibility
  pruned?: string
  rejected?: string
}

export interface ZeroStageCandidateTrace {
  candidateId: string
  action: BattleAction
  staticValue?: number
  potentialValue?: number
  topValues: number[]
  outerCost: AIActionResourceCost
  compatibility: AiCompatibility
  followUps: ZeroStageFollowUpTrace[]
  pruned?: string
  rejected?: string
}

export type ZeroStageStopReason = 'selected' | 'terminal' | 'no-legal-actions' | 'budget-exhausted'

export interface ZeroStageDecision {
  configVersion: typeof ZERO_STAGE_AI_PROFILE_VERSION
  playerId: string
  stateValue: number
  nextAction?: CandidateAction
  nodesVisited: number
  candidatesConsidered: number
  budgetExhausted: boolean
  stopReason: ZeroStageStopReason
  trace: ZeroStageCandidateTrace[]
}
