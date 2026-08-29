import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import {
  buildPairedMatchSchedule,
  runSelfPlayMatch,
  type SelfPlayAgentArchive,
  type SelfPlayRosterArchive,
  type SelfPlaySeedPartitions,
  type SelfPlaySuiteManifest,
} from '@/lib/game/ai-match-runner'
import { createSelfPlayInitialState } from '@/lib/game/ai-self-play-setup'
import type { AIEnvironment } from '@/lib/game/ai-types'
import { planZeroStageAction } from '@/lib/game/ai-zero-stage-agent'
import { installNativeBattleSha256 } from '@/lib/server/battle-hash'

const ZERO_AGENT_ID = 'rvb-ai-zimse-v1'
const PVE_AGENT_ID = 'simple-v1'
const SELF_PLAY_SEED = 1001
const PVE_SEEDS = [1001, 1002, 1003] as const

// Headless PvE mirrors the Node authority runtime instead of falling back to
// the deliberately portable pure-JS digest implementation for every transition.
installNativeBattleSha256()

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), path), 'utf8')) as T
}

const red = readJson<SelfPlayRosterArchive>('config/ai/rosters/red-alpha-v1.json')
const blue = readJson<SelfPlayRosterArchive>('config/ai/rosters/blue-alpha-v1.json')
const seedPartitions = readJson<SelfPlaySeedPartitions>('config/ai/seeds.v1.json')
const simple = readJson<SelfPlayAgentArchive>('config/ai/agents/simple-v1.json')
const zeroAdapter: SelfPlayAgentArchive = {
  schemaVersion: 1,
  agentId: ZERO_AGENT_ID,
  version: '1.0.0',
  kind: 'legal-random',
  historical: true,
  testOnly: true,
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function loadTraceTools() {
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/developer-tools/match-trace.js'),
    'utf8',
  )
  const context = createContext({
    window: {},
    Blob,
    URL: {
      createObjectURL: () => 'blob:trace',
      revokeObjectURL: () => undefined,
    },
    document: {
      createElement: () => ({ click: () => undefined, remove: () => undefined }),
      body: { appendChild: () => undefined },
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    setTimeout: (callback: () => void) => callback(),
  })
  new Script(source, { filename: 'match-trace.js' }).runInContext(context)
  return (context.window as any).RvBDeveloperTools
}

function projectStatus(status: any) {
  if (typeof status === 'string') return status
  if (!status || typeof status !== 'object') return null
  return Object.fromEntries([
    'id', 'name', 'type', 'currentDuration', 'currentUses', 'duration',
    'intensity', 'stacks', 'value', 'source', 'visible',
  ].flatMap(key => status[key] === undefined ? [] : [[key, structuredClone(status[key])]]))
}

function projectPiece(piece: any) {
  const projected = Object.fromEntries([
    'instanceId', 'id', 'templateId', 'name', 'image', 'portrait', 'faction',
    'ownerPlayerId', 'x', 'y', 'currentHp', 'maxHp', 'attack', 'defense',
    'moveRange', 'isCore', 'shield',
  ].flatMap(key => piece?.[key] === undefined ? [] : [[key, structuredClone(piece[key])]])) as any
  projected.skills = (piece?.skills ?? []).map((skill: any) => typeof skill === 'string' ? skill : Object.fromEntries([
    'skillId', 'id', 'currentCooldown', 'usesRemaining', 'currentCharges', 'unlocked',
  ].flatMap(key => skill?.[key] === undefined ? [] : [[key, structuredClone(skill[key])]])))
  projected.statusTags = (piece?.statusTags ?? []).map(projectStatus).filter(Boolean)
  projected.buffs = (piece?.buffs ?? []).map(projectStatus).filter(Boolean)
  projected.debuffs = (piece?.debuffs ?? []).map(projectStatus).filter(Boolean)
  return projected
}

function projectReplayState(state: any) {
  const projected: any = {
    map: structuredClone(state.map),
    pieces: (state.pieces ?? []).map(projectPiece),
    graveyard: (state.graveyard ?? []).map(projectPiece),
    players: (state.players ?? []).map((player: any) => ({
      playerId: player.playerId,
      name: player.name,
      faction: player.faction,
      chargePoints: player.chargePoints,
      actionPoints: player.actionPoints,
      maxActionPoints: player.maxActionPoints,
      hand: [],
      discardPile: structuredClone(player.discardPile ?? []),
      statusTags: (player.statusTags ?? []).map(projectStatus).filter(Boolean),
    })),
    turn: structuredClone(state.turn),
    pieceStatsByTemplateId: {},
    skillsById: {},
    extensions: {},
    _v: state._v,
  }
  for (const key of [
    'terminalResult', 'deployment', 'pendingOptionSelection',
    'pendingTargetSelection', 'targetingRevision', 'gameStartFired',
  ]) {
    if (state[key] !== undefined) projected[key] = structuredClone(state[key])
  }
  return projected
}

function compactReplayCheckpoints(finalState: any, tools: any) {
  const state = tools.sanitize(finalState)
  const replay = state.extensions?.debugBattle?.replay
  if (!replay) throw new Error('Cannot compact a final state without replay checkpoints')
  let previous = projectReplayState(replay.initialState)
  replay.initialState = previous
  replay.initialCheckpointHash = tools.hashStable(previous)
  for (const frame of replay.frames) {
    const materialized = frame.inheritsMap === true
      ? { ...frame.postState, map: previous.map }
      : frame.postState
    const next = projectReplayState(materialized)
    frame.preCheckpointHash = tools.hashStable(previous)
    frame.postCheckpointHash = tools.hashStable(next)
    frame.postState = structuredClone(next)
    if (frame.inheritsMap === true) delete frame.postState.map
    previous = next
  }
  return state
}

function zeroStageEnvironment(
  rootSeed: number,
  zeroSeats: ReadonlySet<string> = new Set(['player-red', 'player-blue']),
) {
  const durations: number[] = []
  let nodes = 0
  let candidates = 0
  let lastDecision: ReturnType<typeof planZeroStageAction> | undefined
  let activeTurnKey = ''
  let actionsTakenThisTurn = 0
  let lastAcceptedState: Parameters<AIEnvironment['simulate']>[0] | undefined
  const resourceUse = {
    'player-red': { actionPoints: 0, chargePoints: 0, decisions: 0, endTurns: 0 },
    'player-blue': { actionPoints: 0, chargePoints: 0, decisions: 0, endTurns: 0 },
  }
  const environment: AIEnvironment = {
    ...aiEnvironmentV1,
    listLegalActions(state, playerId) {
      if (!zeroSeats.has(playerId)) return aiEnvironmentV1.listLegalActions(state, playerId)
      const turnKey = `${state.turn.turnNumber}:${state.turn.currentPlayerId}`
      if (turnKey !== activeTurnKey) {
        activeTurnKey = turnKey
        actionsTakenThisTurn = 0
      }
      const started = performance.now()
      const decision = planZeroStageAction(state, playerId, rootSeed, { actionsTakenThisTurn })
      actionsTakenThisTurn += 1
      const playerMetrics = resourceUse[playerId as keyof typeof resourceUse]
      const selectedTrace = decision.trace.find(item => item.candidateId === decision.nextAction?.id)
      if (playerMetrics && selectedTrace) {
        playerMetrics.decisions += 1
        playerMetrics.actionPoints += selectedTrace.actionCost.actionPoints
        playerMetrics.chargePoints += selectedTrace.actionCost.chargePoints
        playerMetrics.endTurns += Number(decision.nextAction?.kind === 'end-turn')
      }
      lastDecision = decision
      durations.push(performance.now() - started)
      nodes += decision.nodesVisited
      candidates += decision.candidatesConsidered
      return decision.nextAction ? [decision.nextAction] : []
    },
    simulate(state, action, context) {
      const transition = aiEnvironmentV1.simulate(state, action, context)
      if (transition.accepted) lastAcceptedState = transition.state
      return transition
    },
  }
  return {
    environment,
    finalState: () => lastAcceptedState,
    metrics: () => ({
      decisions: durations.length,
      nodes,
      candidates,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: Math.max(0, ...durations),
      lastChoice: lastDecision?.nextAction?.action ?? null,
      lastChoiceScore: lastDecision?.trace.find(item => item.candidateId === lastDecision?.nextAction?.id)?.staticValue ?? null,
      lastEndScore: lastDecision?.trace.find(item => item.action.type === 'endTurn')?.staticValue ?? null,
      lastStateValue: lastDecision?.stateValue ?? null,
      resourceUse,
    }),
  }
}

function manifestFor(opponentAgentId = ZERO_AGENT_ID): SelfPlaySuiteManifest {
  return {
    schemaVersion: 1,
    suiteId: opponentAgentId === ZERO_AGENT_ID
      ? 'red-122-rvb-ai-zimse-v1-mirror-self-play'
      : 'red-122-rvb-ai-zimse-v1-vs-simple-v1',
    evaluationScope: 'smoke',
    seedTier: 'training',
    candidateAgentId: ZERO_AGENT_ID,
    opponentAgentIds: [opponentAgentId],
    lineups: [{
      lineupId: 'alpha',
      candidateRosterId: red.rosterId,
      opponentRosterId: blue.rosterId,
    }],
    budgets: {
      maxActionsPerMatch: 640,
      maxActionsPerTurn: 12,
      maxTurns: 80,
      maxDecisionNodesPerAction: 16,
    },
    rulesHash: 'working-tree-authoritative-rules',
    contentHash: 'working-tree-authoritative-content',
    codeCommit: 'working-tree-red-122',
  }
}

describe('RED-122 rvb-ai-zimse-v1 mirror self-play evaluation', () => {
  it('plays one fixed-seed game with the same zero-stage agent on both seats', async () => {
    const rootSeed = SELF_PLAY_SEED
    const manifest = manifestFor()
    const schedule = buildPairedMatchSchedule(manifest, [rootSeed])
    const scheduled = schedule[0]
    const zero = zeroStageEnvironment(rootSeed)
    const originalLog = console.log
    const originalInfo = console.info
    let match: Awaited<ReturnType<typeof runSelfPlayMatch>>
    console.log = () => undefined
    console.info = () => undefined
    try {
      match = await runSelfPlayMatch({
        manifest,
        seedPartitions,
        explicitSeeds: [rootSeed],
        agentArchives: [zeroAdapter],
        rosterArchives: [red, blue],
        createInitialState: createSelfPlayInitialState,
        environment: zero.environment,
      }, scheduled)
    } finally {
      console.log = originalLog
      console.info = originalInfo
    }
    const finalState = zero.finalState()
    const actionTypes = match.actions.reduce((counts, action) => {
      const player = counts[action.playerId as keyof typeof counts]
      if (player) player[action.action.type] = (player[action.action.type] ?? 0) + 1
      return counts
    }, {
      'player-red': {} as Record<string, number>,
      'player-blue': {} as Record<string, number>,
    })
    const result = {
      game: 1,
      rootSeed,
      zeroSeat: 'both',
      status: match.status,
      winnerAgentId: match.winnerAgentId,
      terminalReason: match.terminalReason ?? null,
      completedRounds: match.completedRounds,
      actionCount: match.actionCount,
      rejectedActions: match.rejectedActions,
      failure: match.failure?.kind ?? null,
      failureAgentId: match.failure?.reproduction.agentId ?? null,
      failureAction: match.failure?.reproduction.action ?? null,
      durationMs: match.durationMs,
      actionTypes,
      livingPieces: finalState?.pieces.filter(piece => piece.currentHp > 0).reduce((counts, piece) => {
        counts[piece.ownerPlayerId] = (counts[piece.ownerPlayerId] ?? 0) + 1
        return counts
      }, {} as Record<string, number>) ?? {},
      decisionMetrics: zero.metrics(),
      actionTraceHash: match.actionTraceHash,
      finalStateHash: match.finalStateHash,
    }
    const exportPath = process.env.RED122_EXPORT_PATH
    if (exportPath) {
      if (!finalState) throw new Error('Cannot export RED-122 replay without a final state')
      const tools = loadTraceTools()
      const exportState = compactReplayCheckpoints(finalState, tools)
      const trace = tools.createTraceRecord({
        state: exportState,
        stateHash: match.finalStateHash,
        roomId: 'red-122-rvb-ai-zimse-v1-self-play',
        seed: rootSeed,
        authorityVersion: finalState._v,
        source: {
          kind: 'red-122-rvb-ai-zimse-v1-self-play/v1',
          game: 1,
          rootSeed,
          zeroSeat: 'both',
          opponentAgentId: ZERO_AGENT_ID,
          actionTraceHash: match.actionTraceHash,
          finalStateHash: match.finalStateHash,
          checkpointProjection: 'visual-state-v1',
        },
      })
      expect(trace.frames).toHaveLength(match.actionCount)
      expect(trace.final.stateHash).toBe(match.finalStateHash)
      const serialized = `${tools.serializeTrace(trace)}\n`
      const parsed = tools.parseTraceText(serialized)
      expect(parsed.frames).toHaveLength(match.actionCount)
      writeFileSync(resolve(exportPath), serialized, { encoding: 'utf8', flag: 'wx' })
      process.stderr.write(`RED122_REPLAY_EXPORTED ${resolve(exportPath)}\n`)
    }
    process.stderr.write(`RED122_MATCH_RESULT ${JSON.stringify(result)}\n`)
    expect(result.rejectedActions).toBe(0)
  }, 20 * 60 * 1000)

  const pveThreeGameTest = process.env.RED122_RUN_PVE_3_GAME === '1' ? it : it.skip
  pveThreeGameTest('plays three fixed-seed games against the built-in PvE simple-v1 agent', async () => {
    const manifest = manifestFor(PVE_AGENT_ID)
    const results = []
    for (let gameIndex = 0; gameIndex < PVE_SEEDS.length; gameIndex += 1) {
      const rootSeed = PVE_SEEDS[gameIndex]
      const swapIndex = gameIndex % 2 as 0 | 1
      const scheduled = buildPairedMatchSchedule(manifest, [rootSeed])[swapIndex]
      const zeroSeat = scheduled.seats['player-red'].agentId === ZERO_AGENT_ID
        ? 'player-red'
        : 'player-blue'
      const zero = zeroStageEnvironment(rootSeed, new Set([zeroSeat]))
      const originalLog = console.log
      const originalInfo = console.info
      let match: Awaited<ReturnType<typeof runSelfPlayMatch>>
      console.log = () => undefined
      console.info = () => undefined
      try {
        match = await runSelfPlayMatch({
          manifest,
          seedPartitions,
          explicitSeeds: [rootSeed],
          agentArchives: [zeroAdapter, simple],
          rosterArchives: [red, blue],
          createInitialState: createSelfPlayInitialState,
          environment: zero.environment,
        }, scheduled)
      } finally {
        console.log = originalLog
        console.info = originalInfo
      }
      results.push({
        game: gameIndex + 1,
        rootSeed,
        zeroSeat,
        status: match.status,
        winnerAgentId: match.winnerAgentId,
        terminalReason: match.terminalReason ?? null,
        completedRounds: match.completedRounds,
        actionCount: match.actionCount,
        rejectedActions: match.rejectedActions,
        failure: match.failure?.kind ?? null,
        zeroDecisionMetrics: zero.metrics(),
        actionTraceHash: match.actionTraceHash,
        finalStateHash: match.finalStateHash,
      })
    }
    const summary = {
      games: results.length,
      zeroWins: results.filter(result => result.winnerAgentId === ZERO_AGENT_ID).length,
      pveWins: results.filter(result => result.winnerAgentId === PVE_AGENT_ID).length,
      draws: results.filter(result => result.status === 'finished' && result.winnerAgentId === null).length,
      failures: results.filter(result => result.status === 'failed').length,
      rejectedActions: results.reduce((total, result) => total + result.rejectedActions, 0),
    }
    process.stderr.write(`RED122_PVE_3_GAME_RESULT ${JSON.stringify({ summary, results })}\n`)
    expect(results).toHaveLength(3)
    expect(summary.failures).toBe(0)
    expect(summary.rejectedActions).toBe(0)
  }, 30 * 60 * 1000)
})
