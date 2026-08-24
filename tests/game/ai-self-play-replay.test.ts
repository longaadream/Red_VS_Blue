import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import {
  SELF_PLAY_SCHEMA_VERSION,
  agentConfigHash,
  buildPairedMatchSchedule,
  buildSelfPlayReport,
  createSelfPlayProcessExecutionMode,
  type SelfPlayAgentArchive,
  type SelfPlayMatchRecord,
  type SelfPlayReport,
  type SelfPlayRosterArchive,
  type SelfPlaySuiteManifest,
} from '@/lib/game/ai-match-runner'
import {
  createSelfPlayTraceSource,
  listSelfPlayMatches,
  replayRecordedSelfPlayMatch,
  resolveSelfPlayMatch,
} from '@/lib/game/ai-self-play-replay'
import { createSelfPlayInitialState } from '@/lib/game/ai-self-play-setup'
import { hashStable } from '@/lib/game/battle-trace'
import type { BattleAction } from '@/lib/game/turn'

const CODE_COMMIT = '0123456789abcdef0123456789abcdef01234567'
const RULES_HASH = '1'.repeat(64)
const CONTENT_HASH = '2'.repeat(64)

const PLANNER = readArchive<SelfPlayAgentArchive>('config/ai/agents/planner-candidate-v1.json')
const SIMPLE = readArchive<SelfPlayAgentArchive>('config/ai/agents/simple-v1.json')
const RED_ROSTER = readArchive<SelfPlayRosterArchive>('config/ai/rosters/red-beta-v1.json')
const BLUE_ROSTER = readArchive<SelfPlayRosterArchive>('config/ai/rosters/blue-beta-v1.json')

function readArchive<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as T
}

function manifest(): SelfPlaySuiteManifest {
  return {
    schemaVersion: SELF_PLAY_SCHEMA_VERSION,
    suiteId: 'trace-export-fixture-v1',
    evaluationScope: 'smoke',
    seedTier: 'public-validation',
    candidateAgentId: PLANNER.agentId,
    opponentAgentIds: [SIMPLE.agentId],
    lineups: [{
      lineupId: 'beta',
      candidateRosterId: RED_ROSTER.rosterId,
      opponentRosterId: BLUE_ROSTER.rosterId,
    }],
    budgets: {
      maxActionsPerMatch: 8,
      maxActionsPerTurn: 4,
      maxTurns: 4,
      maxDecisionNodesPerAction: 16,
    },
    rulesHash: RULES_HASH,
    contentHash: CONTENT_HASH,
    codeCommit: CODE_COMMIT,
  }
}

async function createRecordedReport(): Promise<SelfPlayReport> {
  const suite = manifest()
  const agents = [PLANNER, SIMPLE]
  const rosters = [RED_ROSTER, BLUE_ROSTER]
  const agentsById = new Map(agents.map(agent => [agent.agentId, agent]))
  const rostersById = new Map(rosters.map(roster => [roster.rosterId, roster]))
  const schedule = buildPairedMatchSchedule(suite, [2001])
  const matches: SelfPlayMatchRecord[] = []

  for (const scheduled of schedule) {
    const archives = {
      'player-red': agentsById.get(scheduled.seats['player-red'].agentId)!,
      'player-blue': agentsById.get(scheduled.seats['player-blue'].agentId)!,
    }
    const selectedRosters = {
      'player-red': rostersById.get(scheduled.seats['player-red'].rosterId)!,
      'player-blue': rostersById.get(scheduled.seats['player-blue'].rosterId)!,
    }
    const initial = await createSelfPlayInitialState({
      ...scheduled,
      agents: archives,
      rosters: selectedRosters,
    })
    const action: BattleAction = {
      type: 'surrender',
      playerId: 'player-blue',
      reason: 'voluntary',
    }
    const transition = aiEnvironmentV1.simulate(initial, action, { rootSeed: scheduled.rootSeed })
    if (!transition.accepted) throw new Error(transition.error.message)
    const traceHash = hashStable(transition.trace)
    const actionHash = hashStable(action)
    const actionRecord = {
      actionIndex: 0,
      turnNumber: initial.turn.turnNumber,
      playerId: 'player-blue',
      agentId: scheduled.seats['player-blue'].agentId,
      action,
      actionHash,
      stateHash: transition.stateHash,
      transitionHash: transition.transitionHash,
      traceHash,
      decisionNodes: 0,
      decisionTraceHash: hashStable({ fixture: scheduled.matchId }),
    }
    const terminal = transition.state.terminalResult!
    matches.push({
      ...scheduled,
      schemaVersion: SELF_PLAY_SCHEMA_VERSION,
      status: 'finished',
      winnerPlayerId: terminal.winnerPlayerId,
      winnerAgentId: scheduled.seats[terminal.winnerPlayerId as 'player-red' | 'player-blue'].agentId,
      loserAgentId: scheduled.seats[terminal.loserPlayerId as 'player-red' | 'player-blue'].agentId,
      terminalReason: terminal.reason,
      completedRounds: terminal.settledAt.completedRound,
      actionCount: 1,
      decisionNodes: 0,
      rejectedActions: 0,
      actionTraceHash: hashStable([{ actionHash, traceHash }]),
      stateTraceHash: hashStable([transition.stateHash]),
      finalStateHash: aiEnvironmentV1.stateKey(transition.state, { kind: 'full' }),
      agentConfigHashes: {
        'player-red': agentConfigHash(archives['player-red']),
        'player-blue': agentConfigHash(archives['player-blue']),
      },
      actions: [actionRecord],
      durationMs: 0,
    })
  }

  return buildSelfPlayReport({
    manifest: suite,
    seeds: [2001],
    agentArchives: agents,
    rosterArchives: rosters,
    execution: createSelfPlayProcessExecutionMode(1),
    matches,
    elapsedMs: 0,
    hardware: 'test',
  })
}

function compatibility(report: SelfPlayReport) {
  return {
    schemaVersion: SELF_PLAY_SCHEMA_VERSION,
    codeCommit: report.codeCommit,
    rulesHash: report.rulesHash,
    contentHash: report.contentHash,
  }
}

function replay(report: SelfPlayReport, selector: string | number = 1) {
  return replayRecordedSelfPlayMatch(report, selector, {
    compatibility: compatibility(report),
    createInitialState: createSelfPlayInitialState,
    environment: aiEnvironmentV1,
  })
}

function cloneReport(report: SelfPlayReport): SelfPlayReport {
  return JSON.parse(JSON.stringify(report)) as SelfPlayReport
}

function rebuildReport(report: SelfPlayReport, matches: SelfPlayMatchRecord[]): SelfPlayReport {
  return buildSelfPlayReport({
    manifest: report.manifest,
    seeds: report.seeds,
    agentArchives: report.agentArchives,
    rosterArchives: report.rosterArchives,
    execution: report.execution,
    matches,
    elapsedMs: report.performance.elapsedMs,
    hardware: report.performance.hardware,
  })
}

function loadTraceTools() {
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/developer-tools/match-trace.js'),
    'utf8',
  )
  const context = createContext({ window: {} })
  new Script(source, { filename: 'match-trace.js' }).runInContext(context)
  return (context.window as any).RvBDeveloperTools
}

describe('AI self-play recorded-action Trace v2 export', () => {
  it('lists and selects matches by 1-based index or exact matchId', async () => {
    const report = await createRecordedReport()
    const listed = listSelfPlayMatches(report)

    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({
      index: 1,
      matchId: report.matches[0].matchId,
      swapIndex: 0,
      actionCount: 1,
      status: 'finished',
      result: expect.objectContaining({ winnerPlayerId: 'player-red' }),
      seats: report.matches[0].seats,
    })
    expect(resolveSelfPlayMatch(report, 1).matchId).toBe(report.matches[0].matchId)
    expect(resolveSelfPlayMatch(report, report.matches[1].matchId).matchId).toBe(report.matches[1].matchId)
    expect(() => resolveSelfPlayMatch(report, 'missing-match')).toThrow(/not found|unknown/i)
  })

  it('replays only recorded actions and creates a Trace v2 accepted by the existing importer', async () => {
    const report = await createRecordedReport()
    const first = await replay(report)
    const second = await replay(report)
    const tools = loadTraceTools()
    const source = createSelfPlayTraceSource(report, first.match)
    const trace = tools.createTraceRecord({
      state: first.finalState,
      roomId: `ai-${first.match.matchId}`,
      seed: first.match.rootSeed,
      authorityVersion: first.finalState._v,
      exportedAt: '2026-08-24T00:00:00.000Z',
      source,
    })
    const parsed = tools.parseTraceText(tools.serializeTrace(trace))
    const materialized = tools.materializeTraceState(parsed, parsed.frames.length)

    expect(first.actionsApplied).toBe(first.match.actionCount)
    expect(first.finalStateHash).toBe(first.match.finalStateHash)
    expect(first.finalState.terminalResult).toMatchObject({ reason: 'surrender' })
    expect(trace).toMatchObject({
      format: 'rvb-match-trace/v2',
      seed: 2001,
      summary: { commandCount: first.match.actionCount },
      source: {
        kind: 'rvb-ai-self-play-report/v1',
        report: { suiteId: report.suiteId, codeCommit: report.codeCommit },
        match: { matchId: first.match.matchId, seats: expect.any(Object) },
        originalTerminal: { finalStateHash: first.match.finalStateHash },
      },
    })
    expect(materialized.terminalResult).toEqual(first.finalState.terminalResult)
    expect(first.initialStateHash).toBe(second.initialStateHash)
    expect(first.frames).toEqual(second.frames)
    expect(createSelfPlayTraceSource(report, first.match)).toEqual(createSelfPlayTraceSource(report, second.match))
  })

  it.each([
    ['actionHash', (report: SelfPlayReport) => { report.matches[0].actions[0].actionHash = 'a'.repeat(64) }],
    ['stateHash', (report: SelfPlayReport) => { report.matches[0].actions[0].stateHash = 'b'.repeat(64) }],
    ['transitionHash', (report: SelfPlayReport) => { report.matches[0].actions[0].transitionHash = 'c'.repeat(64) }],
    ['traceHash', (report: SelfPlayReport) => { report.matches[0].actions[0].traceHash = 'd'.repeat(64) }],
    ['actionTraceHash', (report: SelfPlayReport) => { report.matches[0].actionTraceHash = 'e'.repeat(64) }],
    ['stateTraceHash', (report: SelfPlayReport) => { report.matches[0].stateTraceHash = 'f'.repeat(64) }],
    ['finalStateHash', (report: SelfPlayReport) => { report.matches[0].finalStateHash = '0'.repeat(64) }],
  ])('fails closed when %s differs from the recorded evidence', async (_field, mutate) => {
    const report = await createRecordedReport()
    mutate(report)
    await expect(replay(report)).rejects.toThrow(/mismatch/i)
  })

  it.each(['codeCommit', 'rulesHash', 'contentHash'] as const)(
    'rejects incompatible %s evidence before executing actions',
    async field => {
      const report = await createRecordedReport()
      const evidence = { ...compatibility(report), [field]: `different-${field}` }
      await expect(replayRecordedSelfPlayMatch(report, 1, {
        compatibility: evidence,
        createInitialState: createSelfPlayInitialState,
      })).rejects.toThrow(/incompatible|mismatch/i)
    },
  )

  it('rejects unsupported schema, rejected actions, failed matches, and non-terminal evidence', async () => {
    const original = await createRecordedReport()

    const unsupported = cloneReport(original) as unknown as { schemaVersion: number }
    unsupported.schemaVersion = 99
    await expect(replay(unsupported as SelfPlayReport)).rejects.toThrow(/schema|version/i)

    const rejected = cloneReport(original)
    const rejectedAction = { type: 'beginPhase' } as BattleAction
    rejected.matches[0].actions[0].action = rejectedAction
    rejected.matches[0].actions[0].actionHash = hashStable(rejectedAction)
    rejected.matches[0].actionTraceHash = hashStable([{
      actionHash: rejected.matches[0].actions[0].actionHash,
      traceHash: rejected.matches[0].actions[0].traceHash,
    }])
    await expect(replay(rejected)).rejects.toThrow(/rejected/i)

    const failedMatch = cloneReport(original).matches[0]
    failedMatch.status = 'failed'
    failedMatch.winnerPlayerId = null
    failedMatch.winnerAgentId = null
    failedMatch.loserAgentId = null
    failedMatch.terminalReason = undefined
    failedMatch.failure = {
      kind: 'no-action',
      reproduction: {
        matchId: failedMatch.matchId,
        pairId: failedMatch.pairId,
        rootSeed: failedMatch.rootSeed,
        lineupId: failedMatch.lineupId,
        swapIndex: failedMatch.swapIndex,
        actionIndex: 0,
        stateHash: failedMatch.finalStateHash,
        playerId: 'player-red',
        agentId: failedMatch.seats['player-red'].agentId,
      },
    }
    const failed = rebuildReport(original, [failedMatch, original.matches[1]])
    await expect(replay(failed)).rejects.toThrow(/finished|failed/i)

    const nonTerminalMatch = cloneReport(original).matches[0]
    const scheduled = buildPairedMatchSchedule(original.manifest, original.seeds)[0]
    const agentsById = new Map(original.agentArchives.map(agent => [agent.agentId, agent]))
    const rostersById = new Map(original.rosterArchives.map(roster => [roster.rosterId, roster]))
    const initial = await createSelfPlayInitialState({
      ...scheduled,
      agents: {
        'player-red': agentsById.get(scheduled.seats['player-red'].agentId)!,
        'player-blue': agentsById.get(scheduled.seats['player-blue'].agentId)!,
      },
      rosters: {
        'player-red': rostersById.get(scheduled.seats['player-red'].rosterId)!,
        'player-blue': rostersById.get(scheduled.seats['player-blue'].rosterId)!,
      },
    })
    nonTerminalMatch.actions = []
    nonTerminalMatch.actionCount = 0
    nonTerminalMatch.decisionNodes = 0
    nonTerminalMatch.actionTraceHash = hashStable([])
    nonTerminalMatch.stateTraceHash = hashStable([])
    nonTerminalMatch.finalStateHash = aiEnvironmentV1.stateKey(initial, { kind: 'full' })
    nonTerminalMatch.winnerPlayerId = null
    nonTerminalMatch.winnerAgentId = null
    nonTerminalMatch.loserAgentId = null
    nonTerminalMatch.terminalReason = undefined
    nonTerminalMatch.completedRounds = 0
    const nonTerminal = rebuildReport(original, [nonTerminalMatch, original.matches[1]])
    await expect(replay(nonTerminal)).rejects.toThrow(/terminal/i)
  })

  it('does not overwrite an existing output file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rvb-self-play-trace-test-'))
    const output = join(directory, 'existing.json')
    writeFileSync(output, 'keep-me')
    try {
      const { writeTraceFileExclusive } = await import('../../scripts/ai/export-self-play-replay.mjs')
      expect(() => writeTraceFileExclusive(output, '{"valid":true}')).toThrow(/exist|overwrite/i)
      expect(readFileSync(output, 'utf8')).toBe('keep-me')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
