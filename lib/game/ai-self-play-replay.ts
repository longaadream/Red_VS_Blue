import { aiEnvironmentV1 } from './ai-environment'
import {
  SELF_PLAY_SCHEMA_VERSION,
  agentConfigHash,
  buildSelfPlayReport,
  type SelfPlayAgentArchive,
  type SelfPlayInitialStateInput,
  type SelfPlayMatchRecord,
  type SelfPlayReport,
  type SelfPlayRosterArchive,
} from './ai-match-runner'
import { hashStable, readSanitizedBattleReplay, type BattleReplayFrame } from './battle-trace'
import type { AIEnvironment } from './ai-types'
import type { BattleState } from './turn'

const PLAYER_IDS = ['player-red', 'player-blue'] as const
type SelfPlayPlayerId = (typeof PLAYER_IDS)[number]

export interface SelfPlayReplayCompatibility {
  schemaVersion: number
  codeCommit: string
  rulesHash: string
  contentHash: string
}

export interface ReplayRecordedSelfPlayOptions {
  compatibility: SelfPlayReplayCompatibility
  createInitialState(input: SelfPlayInitialStateInput): BattleState | Promise<BattleState>
  environment?: AIEnvironment
}

export interface SelfPlayMatchListEntry {
  index: number
  matchId: string
  pairId: string
  swapIndex: 0 | 1
  rootSeed: number
  lineupId: string
  seats: SelfPlayMatchRecord['seats']
  status: SelfPlayMatchRecord['status']
  result: {
    winnerPlayerId: string | null
    winnerAgentId: string | null
    loserAgentId: string | null
    terminalReason?: string
  }
  completedRounds: number
  actionCount: number
}

export interface RecordedSelfPlayReplayResult {
  match: SelfPlayMatchRecord
  initialStateHash: string
  finalState: BattleState
  finalStateHash: string
  actionsApplied: number
  frames: BattleReplayFrame[]
}

export class SelfPlayReplayError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SelfPlayReplayError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new SelfPlayReplayError(code, message)
}

function canonicalReport(report: SelfPlayReport): SelfPlayReport {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail('SELF_PLAY_REPLAY_REPORT_INVALID', 'Self-play report must be a JSON object')
  }
  if (report.schemaVersion !== SELF_PLAY_SCHEMA_VERSION) {
    fail(
      'SELF_PLAY_REPLAY_SCHEMA_UNSUPPORTED',
      `Self-play report schemaVersion ${String(report.schemaVersion)} is unsupported`,
    )
  }

  let rebuilt: SelfPlayReport
  try {
    rebuilt = buildSelfPlayReport({
      manifest: report.manifest,
      seeds: report.seeds,
      agentArchives: report.agentArchives,
      rosterArchives: report.rosterArchives,
      execution: report.execution,
      matches: report.matches,
      elapsedMs: report.performance?.elapsedMs,
      hardware: report.performance?.hardware,
    })
  } catch (error) {
    fail(
      'SELF_PLAY_REPLAY_REPORT_INVALID',
      `Self-play report contract is invalid: ${(error as Error).message}`,
    )
  }
  if (hashStable(rebuilt) !== hashStable(report)) {
    fail(
      'SELF_PLAY_REPLAY_REPORT_INTEGRITY_MISMATCH',
      'Self-play report summary, manifest, archive, schedule, or performance evidence mismatch',
    )
  }
  return rebuilt
}

function selectMatch(report: SelfPlayReport, selector: string | number): SelfPlayMatchRecord {
  const numericIndex = typeof selector === 'number'
    ? selector
    : /^[1-9]\d*$/.test(selector) ? Number(selector) : undefined
  if (numericIndex !== undefined) {
    if (!Number.isSafeInteger(numericIndex) || numericIndex < 1 || numericIndex > report.matches.length) {
      fail('SELF_PLAY_REPLAY_MATCH_NOT_FOUND', `Self-play match index ${String(selector)} was not found`)
    }
    return report.matches[numericIndex - 1]
  }
  if (typeof selector !== 'string' || !selector) {
    fail('SELF_PLAY_REPLAY_MATCH_NOT_FOUND', 'Self-play match selector must be a 1-based index or matchId')
  }
  const matches = report.matches.filter(match => match.matchId === selector)
  if (matches.length !== 1) {
    fail('SELF_PLAY_REPLAY_MATCH_NOT_FOUND', `Self-play match ${selector} was not found uniquely`)
  }
  return matches[0]
}

function assertCompatibility(report: SelfPlayReport, actual: SelfPlayReplayCompatibility) {
  if (actual.schemaVersion !== SELF_PLAY_SCHEMA_VERSION) {
    fail('SELF_PLAY_REPLAY_SCHEMA_INCOMPATIBLE', 'Current self-play replay schema is incompatible')
  }
  for (const field of ['codeCommit', 'rulesHash', 'contentHash'] as const) {
    if (report[field] !== actual[field]) {
      fail(
        `SELF_PLAY_REPLAY_${field.toUpperCase()}_INCOMPATIBLE`,
        `Self-play report ${field} is incompatible with the authoritative replay runtime`,
      )
    }
    if (report.manifest[field] !== report[field]) {
      fail(
        `SELF_PLAY_REPLAY_${field.toUpperCase()}_MISMATCH`,
        `Self-play report manifest ${field} does not match its top-level evidence`,
      )
    }
  }
}

function archivesForMatch(report: SelfPlayReport, match: SelfPlayMatchRecord) {
  const agentMap = uniqueArchives(report.agentArchives, archive => archive.agentId, 'agent')
  const rosterMap = uniqueArchives(report.rosterArchives, archive => archive.rosterId, 'roster')
  const agents = {} as Record<SelfPlayPlayerId, SelfPlayAgentArchive>
  const rosters = {} as Record<SelfPlayPlayerId, SelfPlayRosterArchive>

  for (const playerId of PLAYER_IDS) {
    const seat = match.seats[playerId]
    const agent = agentMap.get(seat.agentId)
    const roster = rosterMap.get(seat.rosterId)
    if (!agent || !roster) {
      fail(
        'SELF_PLAY_REPLAY_ARCHIVE_MISSING',
        `Self-play match ${match.matchId} is missing the ${playerId} agent or roster archive`,
      )
    }
    const expectedAgentHash = agentConfigHash(agent)
    if (report.agentConfigHashes[agent.agentId] !== expectedAgentHash
      || match.agentConfigHashes[playerId] !== expectedAgentHash) {
      fail(
        'SELF_PLAY_REPLAY_AGENT_HASH_MISMATCH',
        `Self-play match ${match.matchId} ${playerId} agent config hash mismatch`,
      )
    }
    agents[playerId] = agent
    rosters[playerId] = roster
  }
  return { agents, rosters }
}

function uniqueArchives<T>(archives: T[], idFor: (archive: T) => string, label: string) {
  const result = new Map<string, T>()
  for (const archive of archives) {
    const id = idFor(archive)
    if (result.has(id)) fail('SELF_PLAY_REPLAY_ARCHIVE_DUPLICATE', `Duplicate ${label} archive ${id}`)
    result.set(id, archive)
  }
  return result
}

function mismatch(match: SelfPlayMatchRecord, field: string, actionIndex?: number): never {
  const at = actionIndex === undefined ? '' : ` at action ${actionIndex}`
  fail(
    'SELF_PLAY_REPLAY_EVIDENCE_MISMATCH',
    `Self-play match ${match.matchId} ${field} mismatch${at}`,
  )
}

export function listSelfPlayMatches(report: SelfPlayReport): SelfPlayMatchListEntry[] {
  return canonicalReport(report).matches.map((match, index) => ({
    index: index + 1,
    matchId: match.matchId,
    pairId: match.pairId,
    swapIndex: match.swapIndex,
    rootSeed: match.rootSeed,
    lineupId: match.lineupId,
    seats: match.seats,
    status: match.status,
    result: {
      winnerPlayerId: match.winnerPlayerId,
      winnerAgentId: match.winnerAgentId,
      loserAgentId: match.loserAgentId,
      terminalReason: match.terminalReason,
    },
    completedRounds: match.completedRounds,
    actionCount: match.actionCount,
  }))
}

export function resolveSelfPlayMatch(
  report: SelfPlayReport,
  selector: string | number,
): SelfPlayMatchRecord {
  return selectMatch(canonicalReport(report), selector)
}

export async function replayRecordedSelfPlayMatch(
  reportInput: SelfPlayReport,
  selector: string | number,
  options: ReplayRecordedSelfPlayOptions,
): Promise<RecordedSelfPlayReplayResult> {
  const report = canonicalReport(reportInput)
  assertCompatibility(report, options.compatibility)
  const match = selectMatch(report, selector)
  if (match.status !== 'finished' || match.failure) {
    fail('SELF_PLAY_REPLAY_MATCH_NOT_FINISHED', `Self-play match ${match.matchId} is not a successful finished match`)
  }
  if (!Array.isArray(match.actions) || match.actionCount !== match.actions.length) {
    mismatch(match, 'actionCount')
  }
  if (match.rejectedActions !== 0) mismatch(match, 'rejectedActions')

  const environment = options.environment ?? aiEnvironmentV1
  const { agents, rosters } = archivesForMatch(report, match)
  let state = await options.createInitialState({ ...match, agents, rosters })
  const initialReplay = readSanitizedBattleReplay(state)
  if (!initialReplay) {
    fail('SELF_PLAY_REPLAY_INITIAL_TRACE_MISSING', `Self-play match ${match.matchId} has no initial Trace v2 checkpoint`)
  }
  const initialStateHash = initialReplay.initialStateHash
  if (environment.isTerminal(state)) {
    fail('SELF_PLAY_REPLAY_INITIAL_STATE_TERMINAL', `Self-play match ${match.matchId} starts terminal`)
  }

  const actualActionEvidence: Array<{ actionHash: string; traceHash: string }> = []
  const actualStateHashes: string[] = []
  for (let index = 0; index < match.actions.length; index += 1) {
    const recorded = match.actions[index]
    if (recorded.actionIndex !== index) mismatch(match, 'actionIndex', index)
    if (!recorded.action || typeof recorded.action !== 'object') mismatch(match, 'action', index)
    if (recorded.turnNumber !== state.turn.turnNumber) mismatch(match, 'turnNumber', index)
    const seat = match.seats[recorded.playerId as SelfPlayPlayerId]
    if (!seat || seat.agentId !== recorded.agentId) mismatch(match, 'player/agent seat', index)

    const actionHash = hashStable(recorded.action)
    if (actionHash !== recorded.actionHash) mismatch(match, 'actionHash', index)
    const transition = environment.simulate(state, recorded.action, { rootSeed: match.rootSeed })
    if (!transition.accepted) {
      fail(
        'SELF_PLAY_REPLAY_ACTION_REJECTED',
        `Self-play match ${match.matchId} recorded action ${index} was rejected: ${transition.error.code}`,
      )
    }
    const traceHash = hashStable(transition.trace)
    const fullStateHash = environment.stateKey(transition.state, { kind: 'full' })
    if (transition.stateHash !== recorded.stateHash || fullStateHash !== recorded.stateHash) {
      mismatch(match, 'stateHash', index)
    }
    if (transition.transitionHash !== recorded.transitionHash) mismatch(match, 'transitionHash', index)
    if (traceHash !== recorded.traceHash) mismatch(match, 'traceHash', index)
    if (transition.trace.actionTrace?.actionHash !== recorded.actionHash) mismatch(match, 'trace actionHash', index)
    if (transition.trace.actionTrace?.playerId !== recorded.playerId) mismatch(match, 'trace playerId', index)

    actualActionEvidence.push({ actionHash, traceHash })
    actualStateHashes.push(fullStateHash)
    state = transition.state
  }

  if (!environment.isTerminal(state) || !state.terminalResult) {
    fail('SELF_PLAY_REPLAY_MATCH_NON_TERMINAL', `Self-play match ${match.matchId} does not reach a terminal state`)
  }
  const finalStateHash = environment.stateKey(state, { kind: 'full' })
  if (hashStable(actualActionEvidence) !== match.actionTraceHash) mismatch(match, 'actionTraceHash')
  if (hashStable(actualStateHashes) !== match.stateTraceHash) mismatch(match, 'stateTraceHash')
  if (finalStateHash !== match.finalStateHash) mismatch(match, 'finalStateHash')

  const terminal = state.terminalResult
  const expectedWinnerAgent = terminal.winnerPlayerId
    ? match.seats[terminal.winnerPlayerId as SelfPlayPlayerId]?.agentId ?? null
    : null
  const expectedLoserAgent = terminal.loserPlayerId
    ? match.seats[terminal.loserPlayerId as SelfPlayPlayerId]?.agentId ?? null
    : null
  if (terminal.winnerPlayerId !== match.winnerPlayerId) mismatch(match, 'winnerPlayerId')
  if (expectedWinnerAgent !== match.winnerAgentId) mismatch(match, 'winnerAgentId')
  if (expectedLoserAgent !== match.loserAgentId) mismatch(match, 'loserAgentId')
  if (terminal.reason !== match.terminalReason) mismatch(match, 'terminalReason')
  if (terminal.settledAt.completedRound !== match.completedRounds) mismatch(match, 'completedRounds')

  const replay = readSanitizedBattleReplay(state)
  if (!replay || replay.frames.length !== match.actionCount) mismatch(match, 'Trace v2 frame count')
  if (replay.initialStateHash !== initialStateHash) mismatch(match, 'initial replay state hash')
  if (replay.frames[0]?.preStateHash !== initialStateHash) mismatch(match, 'initial replay frame hash')
  if (replay.frames.at(-1)?.postStateHash !== finalStateHash) mismatch(match, 'final replay frame hash')

  return {
    match,
    initialStateHash,
    finalState: state,
    finalStateHash,
    actionsApplied: match.actions.length,
    frames: replay.frames,
  }
}

export function createSelfPlayTraceSource(reportInput: SelfPlayReport, selected: SelfPlayMatchRecord) {
  const report = canonicalReport(reportInput)
  const match = selectMatch(report, selected.matchId)
  const agentMap = new Map(report.agentArchives.map(agent => [agent.agentId, agent]))
  const rosterMap = new Map(report.rosterArchives.map(roster => [roster.rosterId, roster]))
  const seats = Object.fromEntries(PLAYER_IDS.map(playerId => {
    const seat = match.seats[playerId]
    const agent = agentMap.get(seat.agentId)!
    const roster = rosterMap.get(seat.rosterId)!
    return [playerId, {
      agentId: agent.agentId,
      agentVersion: agent.version,
      agentConfigHash: match.agentConfigHashes[playerId],
      rosterId: roster.rosterId,
      rosterVersion: roster.version,
    }]
  }))

  return {
    kind: 'rvb-ai-self-play-report/v1',
    report: {
      schemaVersion: report.schemaVersion,
      reportHash: hashStable(report),
      suiteId: report.suiteId,
      seedTier: report.seedTier,
      codeCommit: report.codeCommit,
      rulesHash: report.rulesHash,
      contentHash: report.contentHash,
    },
    match: {
      matchId: match.matchId,
      pairId: match.pairId,
      lineupId: match.lineupId,
      swapIndex: match.swapIndex,
      rootSeed: match.rootSeed,
      seats,
    },
    originalTerminal: {
      status: match.status,
      winnerPlayerId: match.winnerPlayerId,
      winnerAgentId: match.winnerAgentId,
      loserAgentId: match.loserAgentId,
      terminalReason: match.terminalReason,
      completedRounds: match.completedRounds,
      actionCount: match.actionCount,
      actionTraceHash: match.actionTraceHash,
      stateTraceHash: match.stateTraceHash,
      finalStateHash: match.finalStateHash,
    },
  }
}
