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
const DEFAULT_PVE_CASES = [
  { game: 1, rootSeed: 1001 },
  { game: 2, rootSeed: 1002 },
  { game: 3, rootSeed: 1003 },
] as const

function resolvePveCases() {
  const input = process.env.RED122_PVE_CASES?.trim()
  if (!input) return [...DEFAULT_PVE_CASES]
  return input.split(',').map((entry, index) => {
    const [gameText, seedText] = entry.split(':')
    const game = Number(gameText)
    const rootSeed = Number(seedText)
    if (!Number.isSafeInteger(game) || game < 1 || game > 3 || !Number.isSafeInteger(rootSeed)) {
      throw new RangeError(`RED122_PVE_CASES[${index}] must use game:seed with game 1..3`)
    }
    return { game, rootSeed }
  })
}

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
  let lastActionableEndDecision: ReturnType<typeof planZeroStageAction> | undefined
  let lastActionableEndPieces: Array<{
    instanceId: string
    ownerPlayerId: string
    x: number | null
    y: number | null
    currentHp: number
    shield: number
    buffs: string[]
    debuffs: string[]
  }> | undefined
  let lastEndOnlyContext: Record<string, unknown> | undefined
  let activeTurnKey = ''
  let actionsTakenThisTurn = 0
  let lastAcceptedState: Parameters<AIEnvironment['simulate']>[0] | undefined
  const resourceUse = {
    'player-red': { actionPoints: 0, chargePoints: 0, decisions: 0, endTurns: 0 },
    'player-blue': { actionPoints: 0, chargePoints: 0, decisions: 0, endTurns: 0 },
  }
  const visitedPositions = new Map<string, Set<string>>()
  const lastMoves = new Map<string, { from: string; to: string }>()
  const movement = { moves: 0, repeatedDestinations: 0, immediateReversals: 0 }
  const requestedOpponentGuard = Number(process.env.RED122_PVE_OPPONENT_ACTION_GUARD ?? 0)
  if (!Number.isSafeInteger(requestedOpponentGuard) || requestedOpponentGuard < 0) {
    throw new RangeError('RED122_PVE_OPPONENT_ACTION_GUARD must be a non-negative safe integer')
  }
  let opponentTurnKey = ''
  let opponentActionsThisTurn = 0
  const environment: AIEnvironment = {
    ...aiEnvironmentV1,
    listLegalActions(state, playerId) {
      if (!zeroSeats.has(playerId)) {
        const legal = aiEnvironmentV1.listLegalActions(state, playerId)
        const turnKey = `${state.turn.turnNumber}:${state.turn.currentPlayerId}`
        if (turnKey !== opponentTurnKey) {
          opponentTurnKey = turnKey
          opponentActionsThisTurn = 0
        }
        if (requestedOpponentGuard > 0 && opponentActionsThisTurn >= requestedOpponentGuard) {
          const endTurn = legal.find(candidate => candidate.kind === 'end-turn')
          if (endTurn) return [endTurn]
        }
        return legal
      }
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
      const selectedAction = decision.nextAction?.action
      if (selectedAction?.type === 'move') {
        const piece = state.pieces.find(item => item.instanceId === selectedAction.pieceId)
        if (piece?.x != null && piece.y != null) {
          const from = `${piece.x},${piece.y}`
          const to = `${selectedAction.toX},${selectedAction.toY}`
          const visited = visitedPositions.get(piece.instanceId) ?? new Set([from])
          movement.moves += 1
          movement.repeatedDestinations += Number(visited.has(to))
          const previous = lastMoves.get(piece.instanceId)
          movement.immediateReversals += Number(previous?.from === to && previous.to === from)
          visited.add(to)
          visitedPositions.set(piece.instanceId, visited)
          lastMoves.set(piece.instanceId, { from, to })
        }
      }
      lastDecision = decision
      if (decision.nextAction?.kind === 'end-turn' && decision.trace.some(item => (
        item.evaluation !== undefined
        && !['beginPhase', 'endTurn', 'deploymentLock'].includes(item.action.type)
      ))) {
        lastActionableEndDecision = decision
        if (process.env.RED122_PVE_DEBUG_LAST_END === '1') {
          lastActionableEndPieces = state.pieces.filter(piece => piece.currentHp > 0).map(piece => ({
            instanceId: piece.instanceId,
            ownerPlayerId: piece.ownerPlayerId,
            x: piece.x,
            y: piece.y,
            currentHp: piece.currentHp,
            shield: piece.shield ?? 0,
            buffs: (piece.buffs ?? []).map(item => item.type),
            debuffs: (piece.debuffs ?? []).map(item => item.type),
          }))
        }
      }
      if (process.env.RED122_PVE_DEBUG_LAST_END === '1'
        && decision.nextAction?.kind === 'end-turn'
        && !decision.trace.some(item => item.evaluation !== undefined && item.action.type !== 'endTurn')) {
        const player = state.players.find(item => item.playerId === playerId)
        lastEndOnlyContext = {
          turn: structuredClone(state.turn),
          player: player ? {
            playerId: player.playerId,
            actionPoints: player.actionPoints,
            maxActionPoints: player.maxActionPoints,
            chargePoints: player.chargePoints,
            handSize: player.hand.length,
          } : null,
          pendingOptionPlayerId: state.pendingOptionSelection?.playerId ?? null,
          pendingTargetPlayerId: state.pendingTargetSelection?.ownerPlayerId
            ?? state.pendingTargetSelection?.playerId
            ?? null,
          candidates: decision.trace.map(item => item.action),
          pieces: state.pieces.filter(piece => piece.currentHp > 0 && piece.ownerPlayerId === playerId)
            .map(piece => ({
              instanceId: piece.instanceId,
              x: piece.x,
              y: piece.y,
              currentHp: piece.currentHp,
              moveRange: piece.moveRange,
              skills: (piece.skills ?? []).map(skill => ({
                skillId: skill.skillId,
                currentCooldown: skill.currentCooldown ?? 0,
                usesRemaining: skill.usesRemaining ?? null,
              })),
            })),
        }
      }
      durations.push(performance.now() - started)
      nodes += decision.nodesVisited
      candidates += decision.candidatesConsidered
      return decision.nextAction ? [decision.nextAction] : []
    },
    simulate(state, action, context) {
      const transition = aiEnvironmentV1.simulate(state, action, context)
      if (transition.accepted) {
        lastAcceptedState = transition.state
        const submitted = 'action' in action ? action.action : action
        const submittedPlayerId = 'playerId' in submitted
          ? submitted.playerId
          : state.turn.currentPlayerId
        if (!zeroSeats.has(submittedPlayerId)) opponentActionsThisTurn += 1
      }
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
      movement,
      debugLastEndOnly: process.env.RED122_PVE_DEBUG_LAST_END === '1'
        ? lastEndOnlyContext
        : undefined,
      debugLastActionableEnd: process.env.RED122_PVE_DEBUG_LAST_END === '1' && lastActionableEndDecision
        ? (() => {
            const decision = lastActionableEndDecision!
            const summarize = (item: typeof decision.trace[number] | undefined) => item ? ({
              action: item.action,
              staticValue: item.staticValue ?? null,
              components: item.evaluation ? Object.fromEntries(Object.entries(item.evaluation.components)
                .map(([key, component]) => [key, component.contribution])) : null,
            }) : null
            const selected = decision.trace.find(item => (
              item.candidateId === decision.nextAction?.id
            ))
            const bestAction = decision.trace
              .filter(item => item.evaluation !== undefined && item.action.type !== 'endTurn')
              .sort((left, right) => (right.staticValue ?? Number.NEGATIVE_INFINITY)
                - (left.staticValue ?? Number.NEGATIVE_INFINITY))[0]
            const bestByType = Object.values(decision.trace.reduce((groups, item) => {
              if (item.evaluation === undefined) return groups
              const current = groups[item.action.type]
              if (!current || (item.staticValue ?? Number.NEGATIVE_INFINITY)
                > (current.staticValue ?? Number.NEGATIVE_INFINITY)) groups[item.action.type] = item
              return groups
            }, {} as Record<string, typeof decision.trace[number]>)).map(summarize)
            return {
              selected: summarize(selected),
              bestAction: summarize(bestAction),
              bestByType,
              pieces: lastActionableEndPieces,
            }
          })()
        : undefined,
    }),
  }
}

function manifestFor(opponentAgentId = ZERO_AGENT_ID): SelfPlaySuiteManifest {
  const requestedTurnBudget = Number(process.env.RED122_PVE_MAX_ACTIONS_PER_TURN ?? 12)
  const requestedMatchTurns = Number(process.env.RED122_PVE_MAX_TURNS ?? 80)
  if (!Number.isSafeInteger(requestedTurnBudget) || requestedTurnBudget < 1) {
    throw new RangeError('RED122_PVE_MAX_ACTIONS_PER_TURN must be a positive safe integer')
  }
  if (!Number.isSafeInteger(requestedMatchTurns) || requestedMatchTurns < 1) {
    throw new RangeError('RED122_PVE_MAX_TURNS must be a positive safe integer')
  }
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
      maxActionsPerTurn: opponentAgentId === PVE_AGENT_ID ? requestedTurnBudget : 12,
      maxTurns: opponentAgentId === PVE_AGENT_ID ? requestedMatchTurns : 80,
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
    const pveCases = resolvePveCases()
    const pveSeedPartitions = {
      ...seedPartitions,
      training: [...new Set([...seedPartitions.training, ...pveCases.map(item => item.rootSeed)])],
    }
    const results = []
    for (const pveCase of pveCases) {
      const { game, rootSeed } = pveCase
      const swapIndex = (game - 1) % 2 as 0 | 1
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
          seedPartitions: pveSeedPartitions,
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
      const finalState = zero.finalState()
      const actionTypes = match.actions.reduce((counts, action) => {
        const player = counts[action.playerId as keyof typeof counts]
        if (player) player[action.action.type] = (player[action.action.type] ?? 0) + 1
        return counts
      }, {
        'player-red': {} as Record<string, number>,
        'player-blue': {} as Record<string, number>,
      })
      const skillUses = match.actions.reduce((counts, action) => {
        const submitted = action.action
        if ((submitted.type === 'useBasicSkill' || submitted.type === 'useChargeSkill')) {
          const player = counts[action.playerId as keyof typeof counts]
          if (player) player[submitted.skillId] = (player[submitted.skillId] ?? 0) + 1
        }
        return counts
      }, {
        'player-red': {} as Record<string, number>,
        'player-blue': {} as Record<string, number>,
      })
      results.push({
        game,
        rootSeed,
        zeroSeat,
        status: match.status,
        winnerAgentId: match.winnerAgentId,
        terminalReason: match.terminalReason ?? null,
        completedRounds: match.completedRounds,
        actionCount: match.actionCount,
        rejectedActions: match.rejectedActions,
        failure: match.failure?.kind ?? null,
        failureAgentId: match.failure?.reproduction.agentId ?? null,
        failureAction: match.failure?.reproduction.action ?? null,
        failureErrorCode: match.failure?.reproduction.errorCode ?? null,
        failureErrorMessage: match.failure?.reproduction.errorMessage ?? null,
        durationMs: match.durationMs,
        actionTypes,
        skillUses,
        livingPieces: finalState?.pieces.filter(piece => piece.currentHp > 0).reduce((counts, piece) => {
          counts[piece.ownerPlayerId] = (counts[piece.ownerPlayerId] ?? 0) + 1
          return counts
        }, {} as Record<string, number>) ?? {},
        livingCores: finalState?.pieces.filter(piece => piece.currentHp > 0 && piece.isCore).reduce((counts, piece) => {
          counts[piece.ownerPlayerId] = (counts[piece.ownerPlayerId] ?? 0) + 1
          return counts
        }, {} as Record<string, number>) ?? {},
        coreHealth: finalState?.pieces.filter(piece => piece.currentHp > 0 && piece.isCore).reduce((counts, piece) => {
          const current = counts[piece.ownerPlayerId] ?? { current: 0, maximum: 0 }
          current.current += piece.currentHp
          current.maximum += piece.maxHp
          counts[piece.ownerPlayerId] = current
          return counts
        }, {} as Record<string, { current: number; maximum: number }>) ?? {},
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
    expect(results).toHaveLength(pveCases.length)
    if (Number(process.env.RED122_PVE_MAX_TURNS ?? 80) < 80) {
      expect(results.every(result => (
        result.failure === 'turn-budget'
        || (result.status === 'finished' && result.failure === null)
      ))).toBe(true)
    } else {
      expect(summary.failures).toBe(0)
    }
    expect(summary.rejectedActions).toBe(0)
  }, 30 * 60 * 1000)
})
