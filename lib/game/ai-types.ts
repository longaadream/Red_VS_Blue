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
  /** Authority accepted the command, but a public before-action rule blocked its core effect. */
  blocked?: boolean
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
  /**
   * Evaluation mode preserves gameplay/RNG semantics while omitting historical
   * replay diagnostics from the isolated input used for speculative scoring.
   */
  simulationMode?: 'full' | 'evaluation'
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

export const AI_ENVIRONMENT_V2_PROTOCOL_VERSION = 2 as const

export type AIEnvironmentV2ProtocolVersion = typeof AI_ENVIRONMENT_V2_PROTOCOL_VERSION

export interface CandidateActionV2 {
  protocolVersion: AIEnvironmentV2ProtocolVersion
  id: string
  kind: CandidateActionKind
  action: BattleAction
}

export interface AIObservedBoardEffect {
  id: string
  type: string
  icon?: string
  x: number
  y: number
}

export interface AIObservationV2 extends Omit<AIObservation, 'protocolVersion'> {
  protocolVersion: AIEnvironmentV2ProtocolVersion
  boardEffects: AIObservedBoardEffect[]
}

export interface AIEnvironmentV2Capabilities {
  protocolVersion: AIEnvironmentV2ProtocolVersion
  supportedActionTypes: readonly BattleAction['type'][]
  unsupportedActionTypes: AIEnvironmentCapabilities['unsupportedActionTypes']
  structuredPendingDecisionSpace: true
  publicBoardEffects: true
}

export interface AIDecisionSpaceBaseV2 {
  protocolVersion: AIEnvironmentV2ProtocolVersion
  id: string
  playerId: string
  stateRevision: number
}

export interface AIActionDecisionSpaceV2 extends AIDecisionSpaceBaseV2 {
  kind: 'actions'
  candidates: CandidateActionV2[]
}

export interface AIPendingOptionAtomV2 {
  id: string
  value: unknown
  label?: string
  description?: string
}

export interface AIPendingOptionDecisionSpaceV2 extends AIDecisionSpaceBaseV2 {
  kind: 'pending-option'
  selectionId: string
  title: string
  selectionMode: 'single' | 'multi'
  presentation: 'picker' | 'hand'
  minSelections: number
  maxSelections: number
  canCancel: boolean
  options: AIPendingOptionAtomV2[]
}

export interface AIPendingTargetAtomV2 {
  id: string
  ref: TargetRef
}

export interface AIPendingTargetDecisionSpaceV2 extends AIDecisionSpaceBaseV2 {
  kind: 'pending-target'
  selectionId: string
  title?: string
  targetType: 'piece' | 'cell' | 'grid'
  range?: number
  filter?: string
  selectionMode: 'single' | 'multi'
  minSelections: number
  maxSelections: number
  selectedTargets: TargetRef[]
  canCancel: boolean
  candidates: AIPendingTargetAtomV2[]
}

export type AIDecisionSpaceV2 =
  | AIActionDecisionSpaceV2
  | AIPendingOptionDecisionSpaceV2
  | AIPendingTargetDecisionSpaceV2

export type AIMaterializationChoiceV2 =
  | {
      kind: 'pending-option'
      selectionId: string
      stateRevision: number
      selected: unknown[]
    }
  | {
      kind: 'pending-target'
      selectionId: string
      stateRevision: number
      selected: TargetRef[]
    }
  | {
      kind: 'cancel-selection'
      selectionId: string
      stateRevision: number
    }

export type TransitionResultV2 =
  | {
      protocolVersion: AIEnvironmentV2ProtocolVersion
      accepted: true
      state: BattleState
      stateHash: string
      transitionHash: string
      trace: AITransitionTrace
    }
  | {
      protocolVersion: AIEnvironmentV2ProtocolVersion
      accepted: false
      state: BattleState
      stateHash: string
      transitionHash: string
      error: AIEnvironmentError
      trace: AITransitionTrace
    }

export interface AIEnvironmentV2 {
  readonly protocolVersion: AIEnvironmentV2ProtocolVersion
  readonly capabilities: AIEnvironmentV2Capabilities
  observe(state: BattleState, playerId: string): AIObservationV2
  decisionSpace(state: BattleState, playerId: string): AIDecisionSpaceV2
  materialize(state: BattleState, playerId: string, choice: AIMaterializationChoiceV2): CandidateActionV2
  simulate(
    state: BattleState,
    action: CandidateActionV2 | BattleAction,
    context?: AISimulationContext,
  ): TransitionResultV2
  isTerminal(state: BattleState): boolean
  stateKey(state: BattleState, scope: AIObservationScope): string
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

export const ZERO_STAGE_AI_PROFILE_VERSION = 3 as const

export type ZeroStageStaticComponentKey =
  | 'coreSurvival'
  | 'survival'
  | 'graveyard'
  | 'health'
  | 'combatPower'
  | 'shield'
  | 'resources'
  | 'actionability'
  | 'deploymentReadiness'
  | 'turnProgress'
  | 'lethalOpportunity'
  | 'attackPressure'
  | 'status'
  | 'positionSafety'
  | 'strategicPosition'
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

export interface ZeroStageCandidateTrace {
  candidateId: string
  action: BattleAction
  staticValue?: number
  evaluation?: ZeroStageStaticEvaluation
  actionCost: AIActionResourceCost
  compatibility: AiCompatibility
  blocked?: boolean
  pruned?: string
  rejected?: string
}

export type ZeroStageStopReason = 'selected' | 'terminal' | 'no-legal-actions' | 'budget-exhausted'
export type ZeroStageSelectionReason =
  | 'only-scored-candidate'
  | 'terminal-outcome'
  | 'static-value'
  | 'resource-cost'
  | 'end-turn'
  | 'stable-action'
  | 'candidate-id'

export interface ZeroStageDecision {
  configVersion: typeof ZERO_STAGE_AI_PROFILE_VERSION
  playerId: string
  stateValue: number
  nextAction?: CandidateAction
  nodesVisited: number
  candidatesConsidered: number
  budgetExhausted: boolean
  stopReason: ZeroStageStopReason
  selectionReason?: ZeroStageSelectionReason
  trace: ZeroStageCandidateTrace[]
}
