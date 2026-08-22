import { generateBotActions } from './ai'
import { aiEnvironmentV1 } from './ai-environment'
import { aiPlanTraceHash, planAiTurn, planNextAiAction } from './ai-planner'
import { resolveAiPlannerConfig } from './ai-profiles'
import { hashStable, stableJson } from './battle-trace'
import type {
  AIEnvironment,
  AiPlannerConfig,
  AiTurnPlan,
  CandidateAction,
} from './ai-types'
import type { BattleAction, BattleState } from './turn'

export const SELF_PLAY_SCHEMA_VERSION = 1 as const

export type SelfPlaySeedTier = 'training' | 'public-validation' | 'candidate-holdout'
export type SelfPlayAgentKind = 'simple' | 'planner' | 'legal-random'

export interface SelfPlayAgentArchive {
  schemaVersion: typeof SELF_PLAY_SCHEMA_VERSION
  agentId: string
  version: string
  kind: SelfPlayAgentKind
  historical?: boolean
  testOnly?: boolean
  config?: AiPlannerConfig
}

export interface SelfPlayRosterArchive {
  schemaVersion: typeof SELF_PLAY_SCHEMA_VERSION
  rosterId: string
  version: string
  faction: 'red' | 'blue'
  pieceIds: string[]
}

export interface SelfPlaySeedPartitions {
  schemaVersion: typeof SELF_PLAY_SCHEMA_VERSION
  training: number[]
  publicValidation: number[]
  candidateHoldout: {
    source: 'external'
    commitmentHash: string
  }
}

export interface SelfPlayBudgets {
  maxActionsPerMatch: number
  maxActionsPerTurn: number
  maxTurns: number
  maxDecisionNodesPerAction: number
}

export interface SelfPlayLineup {
  lineupId: string
  candidateRosterId: string
  opponentRosterId: string
}

export interface SelfPlaySuiteManifest {
  schemaVersion: typeof SELF_PLAY_SCHEMA_VERSION
  suiteId: string
  evaluationScope?: 'baseline' | 'smoke'
  seedTier: SelfPlaySeedTier
  candidateAgentId: string
  opponentAgentIds: string[]
  lineups: SelfPlayLineup[]
  budgets: SelfPlayBudgets
  rulesHash: string
  contentHash: string
  codeCommit: string
}

export interface SelfPlaySeat {
  agentId: string
  rosterId: string
}

export interface ScheduledSelfPlayMatch {
  matchId: string
  pairId: string
  suiteId: string
  rootSeed: number
  lineupId: string
  swapIndex: 0 | 1
  seats: Record<'player-red' | 'player-blue', SelfPlaySeat>
}

export interface SelfPlayExecutionModeInput {
  inProcessConcurrency?: number
  processCount?: number
}

export interface SelfPlayExecutionMode {
  inProcessConcurrency: 1
  processCount: number
  isolation: 'serial-in-process' | 'match-process-isolated'
  moduleStatePolicy: string
}

export interface SelfPlayProgressEvent {
  kind: 'match-started' | 'action-completed' | 'match-completed'
  matchId: string
  pairId: string
  rootSeed: number
  lineupId: string
  swapIndex: 0 | 1
  actionCount: number
  maxActions: number
  turnNumber: number
  status?: SelfPlayMatchRecord['status']
  failureKind?: SelfPlayFailureKind
  durationMs?: number
}

export interface SelfPlayActionRecord {
  actionIndex: number
  turnNumber: number
  playerId: string
  agentId: string
  action: BattleAction
  actionHash: string
  stateHash: string
  transitionHash: string
  traceHash: string
  decisionNodes: number
  decisionTraceHash: string
}

export type SelfPlayFailureKind =
  | 'rejected-action'
  | 'rule-exception'
  | 'state-loop'
  | 'action-budget'
  | 'turn-action-budget'
  | 'turn-budget'
  | 'node-budget'
  | 'no-action'

export interface SelfPlayReproduction {
  matchId: string
  pairId: string
  rootSeed: number
  lineupId: string
  swapIndex: 0 | 1
  actionIndex: number
  stateHash: string
  playerId: string
  agentId: string
  action?: BattleAction
  errorCode?: string
  errorMessage?: string
  errorStack?: string
}

export interface SelfPlayFailure {
  kind: SelfPlayFailureKind
  reproduction: SelfPlayReproduction
}

export interface SelfPlayMatchRecord extends ScheduledSelfPlayMatch {
  schemaVersion: typeof SELF_PLAY_SCHEMA_VERSION
  status: 'finished' | 'failed'
  winnerPlayerId: string | null
  winnerAgentId: string | null
  loserAgentId: string | null
  terminalReason?: string
  completedRounds: number
  actionCount: number
  decisionNodes: number
  rejectedActions: number
  actionTraceHash: string
  stateTraceHash: string
  finalStateHash: string
  agentConfigHashes: Record<'player-red' | 'player-blue', string>
  actions: SelfPlayActionRecord[]
  failure?: SelfPlayFailure
  durationMs: number
}

export interface SelfPlaySplitRow {
  key: string
  agentId: string
  games: number
  wins: number
  losses: number
  draws: number
  failures: number
}

export interface SelfPlayMatrixRow extends SelfPlaySplitRow {
  opponentAgentId: string
}

export interface SelfPlaySummary {
  totalMatches: number
  finishedMatches: number
  totalActions: number
  rejectedActions: number
  illegalActionRate: number
  loops: number
  budgetFailures: number
  exceptionFailures: number
  totalDecisionNodes: number
  maxDecisionNodes: number
  winMatrix: SelfPlayMatrixRow[]
  seatSplits: SelfPlaySplitRow[]
  rosterSplits: SelfPlaySplitRow[]
  seedSplits: SelfPlaySplitRow[]
  worstMatches: string[]
  failures: SelfPlayFailure[]
}

export interface SelfPlayReport {
  schemaVersion: typeof SELF_PLAY_SCHEMA_VERSION
  suiteId: string
  seedTier: SelfPlaySeedTier
  seeds: number[]
  rulesHash: string
  contentHash: string
  codeCommit: string
  manifest: SelfPlaySuiteManifest
  agentArchives: SelfPlayAgentArchive[]
  rosterArchives: SelfPlayRosterArchive[]
  agentConfigHashes: Record<string, string>
  execution: SelfPlayExecutionMode
  matches: SelfPlayMatchRecord[]
  summary: SelfPlaySummary
  promotionGate: {
    hardGatePassed: boolean
    status: 'eligible-for-human-review' | 'smoke-passed' | 'hard-gate-failed'
    competitiveEvidence: string[]
    note: string
  }
  performance: {
    hardware: string
    processCount: number
    elapsedMs: number
    transitionsPerSecond: number | null
    gamesPerMinute: number | null
    slowestFixture?: { matchId: string; durationMs: number }
    bottleneck: string
  }
}

export interface SelfPlayInitialStateInput extends ScheduledSelfPlayMatch {
  agents: Record<'player-red' | 'player-blue', SelfPlayAgentArchive>
  rosters: Record<'player-red' | 'player-blue', SelfPlayRosterArchive>
}

export interface RunSelfPlaySuiteInput {
  manifest: SelfPlaySuiteManifest
  seedPartitions: SelfPlaySeedPartitions
  explicitSeeds?: number[]
  agentArchives: SelfPlayAgentArchive[]
  rosterArchives: SelfPlayRosterArchive[]
  createInitialState(input: SelfPlayInitialStateInput): BattleState | Promise<BattleState>
  environment?: AIEnvironment
  execution?: SelfPlayExecutionModeInput
  now?: () => number
  hardware?: string
  onProgress?: (event: SelfPlayProgressEvent) => void
}

export interface BuildSelfPlayReportInput {
  manifest: SelfPlaySuiteManifest
  seeds: number[]
  agentArchives: SelfPlayAgentArchive[]
  rosterArchives: SelfPlayRosterArchive[]
  execution: SelfPlayExecutionMode
  matches: SelfPlayMatchRecord[]
  elapsedMs: number
  hardware?: string
}

export interface ReplaySelfPlayOptions {
  createInitialState(input: SelfPlayInitialStateInput): BattleState | Promise<BattleState>
  environment?: AIEnvironment
  now?: () => number
}

export class SelfPlayContractError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SelfPlayContractError'
    this.code = code
  }
}

type AgentRuntime = {
  turnKey?: string
  previousPlan?: AiTurnPlan
  decisions: number
}

type Decision = {
  action?: CandidateAction
  nodes: number
  traceHash: string
  countsTowardTurnBudget: boolean
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SelfPlayContractError('SELF_PLAY_SCHEMA_INVALID', `${field} must be a non-empty string`)
  }
}

function requirePositiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new SelfPlayContractError('SELF_PLAY_SCHEMA_INVALID', `${field} must be a positive safe integer`)
  }
}

function validateRootSeed(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 0xffff_ffff) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_INVALID', `${field} must be a uint32 integer`)
  }
  return Number(value) >>> 0
}

function unique<T>(values: T[], field: string): T[] {
  if (new Set(values).size !== values.length) {
    throw new SelfPlayContractError('SELF_PLAY_SCHEMA_INVALID', `${field} must not contain duplicates`)
  }
  return values
}

function cloneArchive<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function validateAgentArchive(archive: SelfPlayAgentArchive): SelfPlayAgentArchive {
  if (archive?.schemaVersion !== SELF_PLAY_SCHEMA_VERSION) {
    throw new SelfPlayContractError('SELF_PLAY_AGENT_SCHEMA_UNSUPPORTED', 'agent schemaVersion must be 1')
  }
  requireString(archive.agentId, 'agentId')
  requireString(archive.version, 'agent.version')
  if (!['simple', 'planner', 'legal-random'].includes(archive.kind)) {
    throw new SelfPlayContractError('SELF_PLAY_AGENT_KIND_UNSUPPORTED', `unsupported agent kind ${String(archive.kind)}`)
  }
  if (archive.kind === 'planner') {
    if (!archive.config || archive.config.version !== 1) {
      throw new SelfPlayContractError('SELF_PLAY_AGENT_CONFIG_REQUIRED', `planner ${archive.agentId} requires config version 1`)
    }
    resolveAiPlannerConfig(archive.config)
  }
  if (archive.kind === 'legal-random' && archive.testOnly !== true) {
    throw new SelfPlayContractError('SELF_PLAY_RANDOM_AGENT_TEST_ONLY', 'legal-random archives must be marked testOnly')
  }
  return archive
}

function canonicalAgentArchive(archive: SelfPlayAgentArchive): SelfPlayAgentArchive {
  validateAgentArchive(archive)
  return cloneArchive(archive.kind === 'planner'
    ? { ...archive, config: resolveAiPlannerConfig(archive.config) }
    : archive)
}

export function agentConfigHash(archive: SelfPlayAgentArchive): string {
  const canonical = canonicalAgentArchive(archive)
  return hashStable({
    schemaVersion: canonical.schemaVersion,
    agentId: canonical.agentId,
    version: canonical.version,
    kind: canonical.kind,
    testOnly: canonical.testOnly === true,
    config: canonical.config,
  })
}

function validateRosterArchive(roster: SelfPlayRosterArchive): SelfPlayRosterArchive {
  if (roster?.schemaVersion !== SELF_PLAY_SCHEMA_VERSION) {
    throw new SelfPlayContractError('SELF_PLAY_ROSTER_SCHEMA_UNSUPPORTED', 'roster schemaVersion must be 1')
  }
  requireString(roster.rosterId, 'rosterId')
  requireString(roster.version, 'roster.version')
  if (roster.faction !== 'red' && roster.faction !== 'blue') {
    throw new SelfPlayContractError('SELF_PLAY_ROSTER_INVALID', `${roster.rosterId} faction must be red or blue`)
  }
  if (!Array.isArray(roster.pieceIds) || roster.pieceIds.length === 0) {
    throw new SelfPlayContractError('SELF_PLAY_ROSTER_INVALID', `${roster.rosterId} must contain pieceIds`)
  }
  roster.pieceIds.forEach((pieceId, index) => requireString(pieceId, `${roster.rosterId}.pieceIds[${index}]`))
  unique(roster.pieceIds, `${roster.rosterId}.pieceIds`)
  return roster
}

export function validateSeedPartitions(partitions: SelfPlaySeedPartitions): SelfPlaySeedPartitions {
  if (partitions?.schemaVersion !== SELF_PLAY_SCHEMA_VERSION) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_SCHEMA_UNSUPPORTED', 'seed schemaVersion must be 1')
  }
  if (!Array.isArray(partitions.training) || !Array.isArray(partitions.publicValidation)) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_INVALID', 'training and publicValidation must be arrays')
  }
  const training = unique(partitions.training.map((seed, index) => validateRootSeed(seed, `training[${index}]`)), 'training')
  const publicValidation = unique(
    partitions.publicValidation.map((seed, index) => validateRootSeed(seed, `publicValidation[${index}]`)),
    'publicValidation',
  )
  if (training.length === 0 || publicValidation.length === 0) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_TIER_EMPTY', 'training and publicValidation seed tiers must not be empty')
  }
  const overlap = training.filter(seed => publicValidation.includes(seed))
  if (overlap.length) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_OVERLAP', `training/public seed overlap: ${overlap.join(',')}`)
  }
  if (partitions.candidateHoldout?.source !== 'external') {
    throw new SelfPlayContractError('SELF_PLAY_HOLDOUT_MUST_BE_EXTERNAL', 'candidate holdout seeds must remain external')
  }
  requireString(partitions.candidateHoldout.commitmentHash, 'candidateHoldout.commitmentHash')
  return partitions
}

export function resolveSelfPlaySeeds(
  partitions: SelfPlaySeedPartitions,
  tier: SelfPlaySeedTier,
  externalCandidateSeeds?: number[],
): number[] {
  validateSeedPartitions(partitions)
  if (tier === 'training') return [...partitions.training]
  if (tier === 'public-validation') return [...partitions.publicValidation]
  if (!externalCandidateSeeds) {
    throw new SelfPlayContractError(
      'SELF_PLAY_HOLDOUT_EXTERNAL_REQUIRED',
      'External candidate holdout seeds are required and are never loaded by the optimization path',
    )
  }
  const holdout = unique(
    externalCandidateSeeds.map((seed, index) => validateRootSeed(seed, `candidateHoldout[${index}]`)),
    'candidateHoldout',
  )
  if (holdout.length === 0) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_TIER_EMPTY', 'candidate holdout seeds must not be empty')
  }
  const admitted = new Set([...partitions.training, ...partitions.publicValidation])
  const overlap = holdout.filter(seed => admitted.has(seed))
  if (overlap.length) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_OVERLAP', `candidate holdout overlap: ${overlap.join(',')}`)
  }
  if (hashStable(holdout) !== partitions.candidateHoldout.commitmentHash) {
    throw new SelfPlayContractError('SELF_PLAY_HOLDOUT_COMMITMENT_MISMATCH', 'candidate holdout commitment does not match')
  }
  return holdout
}

function validateManifest(manifest: SelfPlaySuiteManifest) {
  if (manifest?.schemaVersion !== SELF_PLAY_SCHEMA_VERSION) {
    throw new SelfPlayContractError('SELF_PLAY_MANIFEST_SCHEMA_UNSUPPORTED', 'suite schemaVersion must be 1')
  }
  requireString(manifest.suiteId, 'suiteId')
  if (manifest.evaluationScope !== undefined && !['baseline', 'smoke'].includes(manifest.evaluationScope)) {
    throw new SelfPlayContractError('SELF_PLAY_EVALUATION_SCOPE_INVALID', 'evaluationScope must be baseline or smoke')
  }
  requireString(manifest.candidateAgentId, 'candidateAgentId')
  requireString(manifest.rulesHash, 'rulesHash')
  requireString(manifest.contentHash, 'contentHash')
  requireString(manifest.codeCommit, 'codeCommit')
  if (!['training', 'public-validation', 'candidate-holdout'].includes(manifest.seedTier)) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_TIER_INVALID', `unsupported seed tier ${String(manifest.seedTier)}`)
  }
  if (!Array.isArray(manifest.opponentAgentIds) || manifest.opponentAgentIds.length === 0) {
    throw new SelfPlayContractError('SELF_PLAY_OPPONENT_REQUIRED', 'at least one opponent is required')
  }
  unique(manifest.opponentAgentIds, 'opponentAgentIds')
  if (!Array.isArray(manifest.lineups) || manifest.lineups.length === 0) {
    throw new SelfPlayContractError('SELF_PLAY_LINEUP_REQUIRED', 'at least one lineup is required')
  }
  unique(manifest.lineups.map(lineup => lineup.lineupId), 'lineupIds')
  for (const lineup of manifest.lineups) {
    requireString(lineup.lineupId, 'lineupId')
    requireString(lineup.candidateRosterId, `${lineup.lineupId}.candidateRosterId`)
    requireString(lineup.opponentRosterId, `${lineup.lineupId}.opponentRosterId`)
  }
  for (const [field, value] of Object.entries(manifest.budgets)) requirePositiveInteger(value, `budgets.${field}`)
}

export function validateSelfPlayExecutionMode(input: SelfPlayExecutionModeInput = {}): SelfPlayExecutionMode {
  const inProcessConcurrency = input.inProcessConcurrency ?? 1
  const processCount = input.processCount ?? 1
  requirePositiveInteger(inProcessConcurrency, 'inProcessConcurrency')
  requirePositiveInteger(processCount, 'processCount')
  if (inProcessConcurrency !== 1) {
    throw new SelfPlayContractError(
      'SELF_PLAY_IN_PROCESS_CONCURRENCY_UNSAFE',
      'In-process concurrency is unsafe because TriggerSystem, RuleRuntime, and dynamic-code cache state are module scoped',
    )
  }
  if (processCount !== 1) {
    throw new SelfPlayContractError(
      'SELF_PLAY_PROCESS_PARALLELISM_NOT_IMPLEMENTED',
      'Process-parallel orchestration is not implemented; run matches serially until the isolation blocker is resolved',
    )
  }
  return {
    inProcessConcurrency: 1,
    processCount: 1,
    isolation: 'serial-in-process',
    moduleStatePolicy: 'matches execute serially inside one process; process-parallel orchestration is a tracked blocker',
  }
}

export function createSelfPlayProcessExecutionMode(processCount = 1): SelfPlayExecutionMode {
  requirePositiveInteger(processCount, 'processCount')
  return {
    inProcessConcurrency: 1,
    processCount,
    isolation: 'match-process-isolated',
    moduleStatePolicy: processCount === 1
      ? 'each match executes serially in a fresh child process; the child exits before the next match starts'
      : `at most ${processCount} fresh child processes execute one serial match each; no process shares mutable rule runtime state`,
  }
}

export function buildPairedMatchSchedule(
  manifest: SelfPlaySuiteManifest,
  seeds: number[],
): ScheduledSelfPlayMatch[] {
  validateManifest(manifest)
  const stableSeeds = unique(seeds.map((seed, index) => validateRootSeed(seed, `seeds[${index}]`)), 'seeds')
  const schedule: ScheduledSelfPlayMatch[] = []
  for (const opponentAgentId of manifest.opponentAgentIds) {
    for (const lineup of manifest.lineups) {
      for (const rootSeed of stableSeeds) {
        const pairId = `pair-${hashStable({
          schemaVersion: SELF_PLAY_SCHEMA_VERSION,
          suiteId: manifest.suiteId,
          opponentAgentId,
          lineup,
          rootSeed,
        }).slice(0, 24)}`
        const candidateSeat: SelfPlaySeat = {
          agentId: manifest.candidateAgentId,
          rosterId: lineup.candidateRosterId,
        }
        const opponentSeat: SelfPlaySeat = {
          agentId: opponentAgentId,
          rosterId: lineup.opponentRosterId,
        }
        schedule.push({
          matchId: `${pairId}-seat-0`, pairId, suiteId: manifest.suiteId, rootSeed,
          lineupId: lineup.lineupId, swapIndex: 0,
          seats: { 'player-red': candidateSeat, 'player-blue': opponentSeat },
        })
        schedule.push({
          matchId: `${pairId}-seat-1`, pairId, suiteId: manifest.suiteId, rootSeed,
          lineupId: lineup.lineupId, swapIndex: 1,
          seats: { 'player-red': opponentSeat, 'player-blue': candidateSeat },
        })
      }
    }
  }
  return schedule
}

function chooseSimpleAction(state: BattleState, playerId: string, legal: CandidateAction[]): CandidateAction | undefined {
  const preparedState = state.skillsById ? state : { ...state, skillsById: {} }
  const preferred = generateBotActions(preparedState, playerId)
  for (const draft of preferred) {
    const exact = legal.find(item => stableJson(item.action) === stableJson(draft))
    if (exact) return exact
  }
  return legal.find(item => item.kind === 'phase-advance' || item.kind === 'pending-option' || item.kind === 'pending-target')
    ?? legal.find(item => item.kind === 'end-turn')
    ?? legal[0]
}

function chooseRandomAction(
  archive: SelfPlayAgentArchive,
  state: BattleState,
  playerId: string,
  rootSeed: number,
  legal: CandidateAction[],
  decisionIndex: number,
): CandidateAction | undefined {
  if (!legal.length) return undefined
  const token = hashStable({
    stream: 'agent/legal-random', rootSeed, playerId, state: hashStable(state),
    agentConfigHash: agentConfigHash(archive), decisionIndex,
  })
  const index = Number.parseInt(token.slice(0, 8), 16) % legal.length
  return legal[index]
}

function forcedStructuralAction(legal: CandidateAction[]): CandidateAction | undefined {
  const deploymentLock = legal.find(item => item.kind === 'deployment-lock')
  if (deploymentLock) return deploymentLock
  const structuralKinds = new Set<CandidateAction['kind']>([
    'phase-advance', 'pending-option', 'pending-target', 'cancel-selection',
  ])
  return legal.length === 1 && structuralKinds.has(legal[0].kind) ? legal[0] : undefined
}

function activeSelfPlayPlayer(state: BattleState): 'player-red' | 'player-blue' {
  const deploymentPlayer = state.deployment?.status === 'awaiting-locks'
    ? state.deployment.playerIds.find(playerId => state.deployment?.locks[playerId]?.locked !== true)
    : undefined
  return (deploymentPlayer ?? state.pendingOptionSelection?.playerId
    ?? state.pendingTargetSelection?.ownerPlayerId ?? state.pendingTargetSelection?.playerId
    ?? state.turn.currentPlayerId) as 'player-red' | 'player-blue'
}

function chooseAgentAction(
  archive: SelfPlayAgentArchive,
  runtime: AgentRuntime,
  state: BattleState,
  playerId: string,
  rootSeed: number,
  environment: AIEnvironment,
  actionsUsedThisTurn: number,
  maxActionsPerTurn: number,
): Decision {
  const turnKey = `${state.turn.turnNumber}:${playerId}`
  if (runtime.turnKey !== turnKey) {
    runtime.turnKey = turnKey
    runtime.previousPlan = undefined
  }
  runtime.decisions += 1
  const legal = environment.listLegalActions(state, playerId)
  const forced = forcedStructuralAction(legal)
  if (forced) {
    return {
      action: forced, nodes: 0,
      traceHash: hashStable({ kind: archive.kind, forced: forced.kind, action: forced.action }),
      countsTowardTurnBudget: false,
    }
  }
  const budgetSafetyEnd = archive.kind !== 'planner' && actionsUsedThisTurn + 1 >= maxActionsPerTurn
    ? legal.find(item => item.kind === 'end-turn')
    : undefined
  if (archive.kind === 'planner') {
    const config = archive.config!
    const plan = runtime.previousPlan
      ? planNextAiAction(state, playerId, rootSeed, runtime.previousPlan, { environment, config })
      : planAiTurn(state, playerId, rootSeed, { environment, config })
    runtime.previousPlan = plan
    return {
      action: plan.nextAction, nodes: plan.nodesVisited, traceHash: aiPlanTraceHash(plan),
      countsTowardTurnBudget: true,
    }
  }
  const action = archive.kind === 'simple'
    ? budgetSafetyEnd ?? chooseSimpleAction(state, playerId, legal)
    : budgetSafetyEnd ?? chooseRandomAction(archive, state, playerId, rootSeed, legal, runtime.decisions - 1)
  return {
    action,
    nodes: 0,
    traceHash: hashStable({ kind: archive.kind, decision: runtime.decisions - 1, action: action?.action, legal: legal.map(item => item.id) }),
    countsTowardTurnBudget: true,
  }
}

function completedRounds(state: BattleState) {
  if (state.terminalResult?.settledAt) return state.terminalResult.settledAt.completedRound
  return state.turn.phase === 'end'
    ? Math.floor(state.turn.turnNumber / 2)
    : Math.floor((state.turn.turnNumber - 1) / 2)
}

function reproduction(
  scheduled: ScheduledSelfPlayMatch,
  stateHash: string,
  actionIndex: number,
  playerId: string,
  agentId: string,
  extra: Partial<Pick<SelfPlayReproduction, 'action' | 'errorCode' | 'errorMessage' | 'errorStack'>> = {},
): SelfPlayReproduction {
  return {
    matchId: scheduled.matchId,
    pairId: scheduled.pairId,
    rootSeed: scheduled.rootSeed,
    lineupId: scheduled.lineupId,
    swapIndex: scheduled.swapIndex,
    actionIndex,
    stateHash,
    playerId,
    agentId,
    ...extra,
  }
}

function failMatch(
  scheduled: ScheduledSelfPlayMatch,
  state: BattleState,
  environment: AIEnvironment,
  archives: Record<'player-red' | 'player-blue', SelfPlayAgentArchive>,
  startedAt: number,
  now: () => number,
  actions: SelfPlayActionRecord[],
  decisionNodes: number,
  rejectedActions: number,
  failure: SelfPlayFailure,
): SelfPlayMatchRecord {
  const finalStateHash = environment.stateKey(state, { kind: 'full' })
  return {
    ...scheduled,
    schemaVersion: SELF_PLAY_SCHEMA_VERSION,
    status: 'failed',
    winnerPlayerId: null,
    winnerAgentId: null,
    loserAgentId: null,
    completedRounds: completedRounds(state),
    actionCount: actions.length,
    decisionNodes,
    rejectedActions,
    actionTraceHash: hashStable(actions.map(item => ({ actionHash: item.actionHash, traceHash: item.traceHash }))),
    stateTraceHash: hashStable(actions.map(item => item.stateHash)),
    finalStateHash,
    agentConfigHashes: {
      'player-red': agentConfigHash(archives['player-red']),
      'player-blue': agentConfigHash(archives['player-blue']),
    },
    actions,
    failure,
    durationMs: Math.max(0, now() - startedAt),
  }
}

async function runScheduledMatch(
  scheduled: ScheduledSelfPlayMatch,
  manifest: SelfPlaySuiteManifest,
  archivesById: Map<string, SelfPlayAgentArchive>,
  rostersById: Map<string, SelfPlayRosterArchive>,
  createInitialState: RunSelfPlaySuiteInput['createInitialState'],
  environment: AIEnvironment,
  now: () => number,
  onProgress?: RunSelfPlaySuiteInput['onProgress'],
): Promise<SelfPlayMatchRecord> {
  const startedAt = now()
  const archives = {
    'player-red': archivesById.get(scheduled.seats['player-red'].agentId)!,
    'player-blue': archivesById.get(scheduled.seats['player-blue'].agentId)!,
  }
  const rosters = {
    'player-red': rostersById.get(scheduled.seats['player-red'].rosterId)!,
    'player-blue': rostersById.get(scheduled.seats['player-blue'].rosterId)!,
  }
  let state = await createInitialState({ ...scheduled, agents: archives, rosters })
  onProgress?.({
    kind: 'match-started',
    matchId: scheduled.matchId, pairId: scheduled.pairId,
    rootSeed: scheduled.rootSeed, lineupId: scheduled.lineupId, swapIndex: scheduled.swapIndex,
    actionCount: 0,
    maxActions: manifest.budgets.maxActionsPerMatch,
    turnNumber: state.turn.turnNumber,
  })
  const runtime: Record<'player-red' | 'player-blue', AgentRuntime> = {
    'player-red': { decisions: 0 },
    'player-blue': { decisions: 0 },
  }
  const actions: SelfPlayActionRecord[] = []
  const turnActions = new Map<string, number>()
  const visited = new Set([environment.stateKey(state, { kind: 'full' })])
  let decisionNodes = 0
  let rejectedActions = 0

  while (!environment.isTerminal(state)) {
    const playerId = activeSelfPlayPlayer(state)
    const archive = archives[playerId]
    const stateHash = environment.stateKey(state, { kind: 'full' })
    const actionIndex = actions.length
    const makeFailure = (
      kind: SelfPlayFailureKind,
      extra: Partial<Pick<SelfPlayReproduction, 'action' | 'errorCode' | 'errorMessage' | 'errorStack'>> = {},
    ) => failMatch(
      scheduled, state, environment, archives, startedAt, now, actions, decisionNodes, rejectedActions,
      { kind, reproduction: reproduction(scheduled, stateHash, actionIndex, playerId, archive.agentId, extra) },
    )

    if (actionIndex >= manifest.budgets.maxActionsPerMatch) return makeFailure('action-budget')
    if (state.turn.turnNumber > manifest.budgets.maxTurns) return makeFailure('turn-budget')
    const turnKey = `${state.turn.turnNumber}:${playerId}`
    const usedThisTurn = turnActions.get(turnKey) ?? 0

    let decision: Decision
    try {
      decision = chooseAgentAction(
        archive, runtime[playerId], state, playerId, scheduled.rootSeed, environment,
        usedThisTurn, manifest.budgets.maxActionsPerTurn,
      )
    } catch (error) {
      return makeFailure('rule-exception', {
        errorCode: (error as { code?: string }).code ?? (error as Error).name,
        errorMessage: (error as Error).message,
        errorStack: (error as Error).stack,
      })
    }
    if (decision.countsTowardTurnBudget && usedThisTurn >= manifest.budgets.maxActionsPerTurn) {
      return makeFailure('turn-action-budget', { action: decision.action?.action })
    }
    decisionNodes += decision.nodes
    if (decision.nodes > manifest.budgets.maxDecisionNodesPerAction) {
      return makeFailure('node-budget', { action: decision.action?.action })
    }
    if (!decision.action) return makeFailure('no-action')

    let transition
    try {
      transition = environment.simulate(state, decision.action, { rootSeed: scheduled.rootSeed })
    } catch (error) {
      return makeFailure('rule-exception', {
        action: decision.action.action,
        errorCode: (error as { code?: string }).code ?? (error as Error).name,
        errorMessage: (error as Error).message,
        errorStack: (error as Error).stack,
      })
    }
    if (!transition.accepted) {
      rejectedActions += 1
      return makeFailure('rejected-action', {
        action: decision.action.action,
        errorCode: transition.error.code,
        errorMessage: transition.error.message,
      })
    }

    const traceHash = hashStable(transition.trace)
    actions.push({
      actionIndex,
      turnNumber: state.turn.turnNumber,
      playerId,
      agentId: archive.agentId,
      action: cloneArchive(decision.action.action),
      actionHash: hashStable(decision.action.action),
      stateHash: transition.stateHash,
      transitionHash: transition.transitionHash,
      traceHash,
      decisionNodes: decision.nodes,
      decisionTraceHash: decision.traceHash,
    })
    turnActions.set(turnKey, usedThisTurn + (decision.countsTowardTurnBudget ? 1 : 0))
    state = transition.state
    onProgress?.({
      kind: 'action-completed',
      matchId: scheduled.matchId, pairId: scheduled.pairId,
      rootSeed: scheduled.rootSeed, lineupId: scheduled.lineupId, swapIndex: scheduled.swapIndex,
      actionCount: actions.length,
      maxActions: manifest.budgets.maxActionsPerMatch,
      turnNumber: state.turn.turnNumber,
    })
    const nextStateHash = environment.stateKey(state, { kind: 'full' })
    if (!environment.isTerminal(state) && visited.has(nextStateHash)) {
      return failMatch(
        scheduled, state, environment, archives, startedAt, now, actions, decisionNodes, rejectedActions,
        {
          kind: 'state-loop',
          reproduction: reproduction(
            scheduled, nextStateHash, actions.length, activeSelfPlayPlayer(state),
            scheduled.seats[activeSelfPlayPlayer(state)].agentId,
            { action: decision.action.action },
          ),
        },
      )
    }
    visited.add(nextStateHash)
  }

  const finalStateHash = environment.stateKey(state, { kind: 'full' })
  const winnerPlayerId = state.terminalResult?.winnerPlayerId ?? null
  const loserPlayerId = state.terminalResult?.loserPlayerId ?? null
  return {
    ...scheduled,
    schemaVersion: SELF_PLAY_SCHEMA_VERSION,
    status: 'finished',
    winnerPlayerId,
    winnerAgentId: winnerPlayerId
      ? scheduled.seats[winnerPlayerId as 'player-red' | 'player-blue']?.agentId ?? null
      : null,
    loserAgentId: loserPlayerId
      ? scheduled.seats[loserPlayerId as 'player-red' | 'player-blue']?.agentId ?? null
      : null,
    terminalReason: state.terminalResult?.reason,
    completedRounds: completedRounds(state),
    actionCount: actions.length,
    decisionNodes,
    rejectedActions,
    actionTraceHash: hashStable(actions.map(item => ({ actionHash: item.actionHash, traceHash: item.traceHash }))),
    stateTraceHash: hashStable(actions.map(item => item.stateHash)),
    finalStateHash,
    agentConfigHashes: {
      'player-red': agentConfigHash(archives['player-red']),
      'player-blue': agentConfigHash(archives['player-blue']),
    },
    actions,
    durationMs: Math.max(0, now() - startedAt),
  }
}

type OutcomeCounter = { games: number; wins: number; losses: number; draws: number; failures: number }

function addOutcome(counter: OutcomeCounter, match: SelfPlayMatchRecord, agentId: string) {
  counter.games += 1
  if (match.status === 'failed') counter.failures += 1
  else if (!match.winnerAgentId) counter.draws += 1
  else if (match.winnerAgentId === agentId) counter.wins += 1
  else counter.losses += 1
}

function splitRows(
  matches: SelfPlayMatchRecord[],
  keyFor: (match: SelfPlayMatchRecord, playerId: 'player-red' | 'player-blue') => string,
): SelfPlaySplitRow[] {
  const rows = new Map<string, SelfPlaySplitRow>()
  for (const match of matches) {
    for (const playerId of ['player-red', 'player-blue'] as const) {
      const agentId = match.seats[playerId].agentId
      const key = keyFor(match, playerId)
      const rowKey = `${key}\u0000${agentId}`
      const row = rows.get(rowKey) ?? { key, agentId, games: 0, wins: 0, losses: 0, draws: 0, failures: 0 }
      addOutcome(row, match, agentId)
      rows.set(rowKey, row)
    }
  }
  return [...rows.values()].sort((left, right) => compareText(left.key, right.key) || compareText(left.agentId, right.agentId))
}

function summarize(matches: SelfPlayMatchRecord[]): SelfPlaySummary {
  const matrix = new Map<string, SelfPlayMatrixRow>()
  for (const match of matches) {
    for (const playerId of ['player-red', 'player-blue'] as const) {
      const other = playerId === 'player-red' ? 'player-blue' : 'player-red'
      const agentId = match.seats[playerId].agentId
      const opponentAgentId = match.seats[other].agentId
      const rowKey = `${agentId}\u0000${opponentAgentId}`
      const row = matrix.get(rowKey) ?? {
        key: `${agentId} vs ${opponentAgentId}`, agentId, opponentAgentId,
        games: 0, wins: 0, losses: 0, draws: 0, failures: 0,
      }
      addOutcome(row, match, agentId)
      matrix.set(rowKey, row)
    }
  }
  const failures = matches.flatMap(match => match.failure ? [match.failure] : [])
  const totalActions = matches.reduce((total, match) => total + match.actionCount, 0)
  const rejectedActions = matches.reduce((total, match) => total + match.rejectedActions, 0)
  const worstMatches = [...matches]
    .sort((left, right) => Number(right.status === 'failed') - Number(left.status === 'failed')
      || Number(right.winnerAgentId === null) - Number(left.winnerAgentId === null)
      || compareText(left.matchId, right.matchId))
    .slice(0, 10)
    .map(match => match.matchId)
  return {
    totalMatches: matches.length,
    finishedMatches: matches.filter(match => match.status === 'finished').length,
    totalActions,
    rejectedActions,
    illegalActionRate: totalActions + rejectedActions === 0 ? 0 : rejectedActions / (totalActions + rejectedActions),
    loops: failures.filter(failure => failure.kind === 'state-loop').length,
    budgetFailures: failures.filter(failure => failure.kind.includes('budget')).length,
    exceptionFailures: failures.filter(failure => failure.kind === 'rule-exception').length,
    totalDecisionNodes: matches.reduce((total, match) => total + match.decisionNodes, 0),
    maxDecisionNodes: Math.max(0, ...matches.flatMap(match => match.actions.map(action => action.decisionNodes))),
    winMatrix: [...matrix.values()].sort((left, right) => compareText(left.agentId, right.agentId)
      || compareText(left.opponentAgentId, right.opponentAgentId)),
    seatSplits: splitRows(matches, (_match, playerId) => playerId),
    rosterSplits: splitRows(matches, (match, playerId) => match.seats[playerId].rosterId),
    seedSplits: splitRows(matches, match => String(match.rootSeed)),
    worstMatches,
    failures,
  }
}

function validateArchives(
  manifest: SelfPlaySuiteManifest,
  agentArchives: SelfPlayAgentArchive[],
  rosterArchives: SelfPlayRosterArchive[],
) {
  const canonicalAgents = agentArchives.map(canonicalAgentArchive)
  const canonicalRosters = rosterArchives.map(roster => cloneArchive(validateRosterArchive(roster)))
  unique(canonicalAgents.map(agent => agent.agentId), 'agent archive IDs')
  unique(canonicalRosters.map(roster => roster.rosterId), 'roster archive IDs')
  const agentsById = new Map(canonicalAgents.map(agent => [agent.agentId, agent]))
  const rostersById = new Map(canonicalRosters.map(roster => [roster.rosterId, roster]))
  for (const agentId of [manifest.candidateAgentId, ...manifest.opponentAgentIds]) {
    if (!agentsById.has(agentId)) {
      throw new SelfPlayContractError('SELF_PLAY_AGENT_ARCHIVE_MISSING', `missing agent archive ${agentId}`)
    }
  }
  if (!manifest.opponentAgentIds.some(agentId => agentsById.get(agentId)?.historical === true)) {
    throw new SelfPlayContractError('SELF_PLAY_HISTORICAL_OPPONENT_REQUIRED', 'evaluation must include a historical opponent archive')
  }
  for (const lineup of manifest.lineups) {
    for (const rosterId of [lineup.candidateRosterId, lineup.opponentRosterId]) {
      if (!rostersById.has(rosterId)) {
        throw new SelfPlayContractError('SELF_PLAY_ROSTER_ARCHIVE_MISSING', `missing roster archive ${rosterId}`)
      }
    }
  }
  return { canonicalAgents, canonicalRosters, agentsById, rostersById }
}

function selectedSeeds(input: RunSelfPlaySuiteInput): number[] {
  const tierSeeds = resolveSelfPlaySeeds(
    input.seedPartitions,
    input.manifest.seedTier,
    input.manifest.seedTier === 'candidate-holdout' ? input.explicitSeeds : undefined,
  )
  if (!input.explicitSeeds || input.manifest.seedTier === 'candidate-holdout') return tierSeeds
  const explicit = unique(
    input.explicitSeeds.map((seed, index) => validateRootSeed(seed, `explicitSeeds[${index}]`)),
    'explicitSeeds',
  )
  const admitted = new Set(tierSeeds)
  const unknown = explicit.filter(seed => !admitted.has(seed))
  if (unknown.length) {
    throw new SelfPlayContractError('SELF_PLAY_SEED_NOT_IN_TIER', `explicit seeds are outside ${input.manifest.seedTier}: ${unknown.join(',')}`)
  }
  return explicit
}

function prepareSelfPlayRun(input: RunSelfPlaySuiteInput) {
  validateManifest(input.manifest)
  validateSeedPartitions(input.seedPartitions)
  const execution = validateSelfPlayExecutionMode(input.execution)
  const seeds = selectedSeeds(input)
  const archives = validateArchives(
    input.manifest, input.agentArchives, input.rosterArchives,
  )
  return { execution, seeds, ...archives }
}

function emitMatchCompleted(
  onProgress: RunSelfPlaySuiteInput['onProgress'],
  match: SelfPlayMatchRecord,
  maxActions: number,
) {
  onProgress?.({
    kind: 'match-completed',
    matchId: match.matchId, pairId: match.pairId,
    rootSeed: match.rootSeed, lineupId: match.lineupId, swapIndex: match.swapIndex,
    actionCount: match.actionCount,
    maxActions,
    turnNumber: match.actions.at(-1)?.turnNumber ?? 0,
    status: match.status,
    failureKind: match.failure?.kind,
    durationMs: match.durationMs,
  })
}

export async function runSelfPlayMatch(
  input: RunSelfPlaySuiteInput,
  scheduled: ScheduledSelfPlayMatch,
): Promise<SelfPlayMatchRecord> {
  const prepared = prepareSelfPlayRun(input)
  const expected = buildPairedMatchSchedule(input.manifest, prepared.seeds)
    .find(match => match.matchId === scheduled.matchId)
  if (!expected || hashStable(expected) !== hashStable(scheduled)) {
    throw new SelfPlayContractError(
      'SELF_PLAY_SCHEDULE_MISMATCH',
      `scheduled match ${scheduled.matchId} is not part of the selected deterministic suite schedule`,
    )
  }
  const environment = input.environment ?? aiEnvironmentV1
  const now = input.now ?? (() => performance.now())
  const match = await runScheduledMatch(
    expected, input.manifest, prepared.agentsById, prepared.rostersById,
    input.createInitialState, environment, now, input.onProgress,
  )
  emitMatchCompleted(input.onProgress, match, input.manifest.budgets.maxActionsPerMatch)
  return match
}

function scheduledMatchProjection(match: ScheduledSelfPlayMatch): ScheduledSelfPlayMatch {
  return {
    matchId: match.matchId,
    pairId: match.pairId,
    suiteId: match.suiteId,
    rootSeed: match.rootSeed,
    lineupId: match.lineupId,
    swapIndex: match.swapIndex,
    seats: cloneArchive(match.seats),
  }
}

export function buildSelfPlayReport(input: BuildSelfPlayReportInput): SelfPlayReport {
  validateManifest(input.manifest)
  const seeds = unique(
    input.seeds.map((seed, index) => validateRootSeed(seed, `seeds[${index}]`)),
    'seeds',
  )
  const { canonicalAgents, canonicalRosters } = validateArchives(
    input.manifest, input.agentArchives, input.rosterArchives,
  )
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) {
    throw new SelfPlayContractError('SELF_PLAY_ELAPSED_INVALID', 'elapsedMs must be a finite non-negative number')
  }
  if (input.execution.inProcessConcurrency !== 1) {
    throw new SelfPlayContractError(
      'SELF_PLAY_IN_PROCESS_CONCURRENCY_UNSAFE',
      'Report execution must preserve inProcessConcurrency=1',
    )
  }
  requirePositiveInteger(input.execution.processCount, 'execution.processCount')
  if (!['serial-in-process', 'match-process-isolated'].includes(input.execution.isolation)) {
    throw new SelfPlayContractError('SELF_PLAY_EXECUTION_MODE_INVALID', 'unsupported report execution isolation')
  }

  const schedule = buildPairedMatchSchedule(input.manifest, seeds)
  const matchesById = new Map<string, SelfPlayMatchRecord>()
  for (const match of input.matches) {
    if (matchesById.has(match.matchId)) {
      throw new SelfPlayContractError('SELF_PLAY_MATCH_DUPLICATE', `duplicate match record ${match.matchId}`)
    }
    matchesById.set(match.matchId, match)
  }
  if (matchesById.size !== schedule.length) {
    throw new SelfPlayContractError(
      'SELF_PLAY_MATCH_SET_INCOMPLETE',
      `report has ${matchesById.size} matches but deterministic schedule requires ${schedule.length}`,
    )
  }
  const matches = schedule.map(scheduled => {
    const match = matchesById.get(scheduled.matchId)
    if (!match || hashStable(scheduledMatchProjection(match)) !== hashStable(scheduled)) {
      throw new SelfPlayContractError(
        'SELF_PLAY_MATCH_SCHEDULE_MISMATCH',
        `match record ${scheduled.matchId} does not match the deterministic schedule`,
      )
    }
    return match
  })

  const summary = summarize(matches)
  const hardGatePassed = summary.failures.length === 0 && summary.finishedMatches === summary.totalMatches
  const smokeOnly = input.manifest.evaluationScope === 'smoke'
  const slowest = [...matches].sort((left, right) => right.durationMs - left.durationMs)[0]
  return {
    schemaVersion: SELF_PLAY_SCHEMA_VERSION,
    suiteId: input.manifest.suiteId,
    seedTier: input.manifest.seedTier,
    seeds,
    rulesHash: input.manifest.rulesHash,
    contentHash: input.manifest.contentHash,
    codeCommit: input.manifest.codeCommit,
    manifest: cloneArchive(input.manifest),
    agentArchives: canonicalAgents,
    rosterArchives: canonicalRosters,
    agentConfigHashes: Object.fromEntries(canonicalAgents.map(agent => [agent.agentId, agentConfigHash(agent)])),
    execution: cloneArchive(input.execution),
    matches,
    summary,
    promotionGate: {
      hardGatePassed,
      status: hardGatePassed
        ? smokeOnly ? 'smoke-passed' : 'eligible-for-human-review'
        : 'hard-gate-failed',
      competitiveEvidence: [
        'win-matrix', 'seat-splits', 'roster-splits', 'seed-splits',
        'worst-match', 'illegal-action-rate', 'termination-and-budget-gates', 'decision-node-stats',
      ],
      note: hardGatePassed
        ? smokeOnly
          ? 'Smoke legality and termination gates passed; this paired sample is not a full baseline or promotion evidence.'
          : 'Legality and termination gates passed; competitive results require multi-split human review and do not auto-promote by Elo.'
        : 'At least one legality, termination, loop, budget, or exception gate failed; competitive comparison is blocked.',
    },
    performance: {
      hardware: input.hardware ?? 'not-recorded',
      processCount: input.execution.processCount,
      elapsedMs: input.elapsedMs,
      transitionsPerSecond: input.elapsedMs > 0 ? summary.totalActions / (input.elapsedMs / 1_000) : null,
      gamesPerMinute: input.elapsedMs > 0 ? matches.length / (input.elapsedMs / 60_000) : null,
      slowestFixture: slowest ? { matchId: slowest.matchId, durationMs: slowest.durationMs } : undefined,
      bottleneck: input.execution.isolation === 'match-process-isolated'
        ? 'each child process runs one match; peak memory and throughput scale with --processes'
        : 'module-scoped TriggerSystem/RuleRuntime/cache require serial matches inside a process',
    },
  }
}

export async function runSelfPlaySuite(input: RunSelfPlaySuiteInput): Promise<SelfPlayReport> {
  const prepared = prepareSelfPlayRun(input)
  const environment = input.environment ?? aiEnvironmentV1
  const now = input.now ?? (() => performance.now())
  const suiteStartedAt = now()
  const matches: SelfPlayMatchRecord[] = []
  for (const scheduled of buildPairedMatchSchedule(input.manifest, prepared.seeds)) {
    const match = await runScheduledMatch(
      scheduled, input.manifest, prepared.agentsById, prepared.rostersById,
      input.createInitialState, environment, now, input.onProgress,
    )
    matches.push(match)
    emitMatchCompleted(input.onProgress, match, input.manifest.budgets.maxActionsPerMatch)
  }
  const elapsedMs = Math.max(0, now() - suiteStartedAt)
  return buildSelfPlayReport({
    manifest: input.manifest,
    seeds: prepared.seeds,
    agentArchives: prepared.canonicalAgents,
    rosterArchives: prepared.canonicalRosters,
    execution: prepared.execution,
    matches,
    elapsedMs,
    hardware: input.hardware,
  })
}

export async function replaySelfPlayMatch(
  report: SelfPlayReport,
  matchId: string,
  options: ReplaySelfPlayOptions,
): Promise<SelfPlayMatchRecord> {
  if (report.schemaVersion !== SELF_PLAY_SCHEMA_VERSION) {
    throw new SelfPlayContractError('SELF_PLAY_REPORT_SCHEMA_UNSUPPORTED', 'report schemaVersion must be 1')
  }
  const archived = report.matches.find(match => match.matchId === matchId)
  if (!archived) throw new SelfPlayContractError('SELF_PLAY_MATCH_NOT_FOUND', `match ${matchId} is not in report`)
  const scheduled: ScheduledSelfPlayMatch = {
    matchId: archived.matchId,
    pairId: archived.pairId,
    suiteId: archived.suiteId,
    rootSeed: archived.rootSeed,
    lineupId: archived.lineupId,
    swapIndex: archived.swapIndex,
    seats: cloneArchive(archived.seats),
  }
  const agentsById = new Map(report.agentArchives.map(agent => [agent.agentId, canonicalAgentArchive(agent)]))
  const rostersById = new Map(report.rosterArchives.map(roster => [roster.rosterId, validateRosterArchive(roster)]))
  return runScheduledMatch(
    scheduled,
    report.manifest,
    agentsById,
    rostersById,
    options.createInitialState,
    options.environment ?? aiEnvironmentV1,
    options.now ?? (() => performance.now()),
    undefined,
  )
}
