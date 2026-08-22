/* eslint-disable @typescript-eslint/no-explicit-any -- serialized offline match fixtures intentionally exercise schema boundaries. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  SELF_PLAY_SCHEMA_VERSION,
  agentConfigHash,
  buildPairedMatchSchedule,
  replaySelfPlayMatch,
  resolveSelfPlaySeeds,
  runSelfPlaySuite,
  validateAgentArchive,
  validateSeedPartitions,
  type SelfPlayAgentArchive,
  type SelfPlayRosterArchive,
  type SelfPlaySeedPartitions,
  type SelfPlaySuiteManifest,
} from '@/lib/game/ai-match-runner'
import { hashStable } from '@/lib/game/battle-trace'
import type { AIEnvironment, CandidateAction, TransitionResult } from '@/lib/game/ai-types'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const CANDIDATE: SelfPlayAgentArchive = {
  schemaVersion: 1,
  agentId: 'planner-candidate-v1',
  version: '1.0.0',
  kind: 'planner',
  config: {
    version: 1,
    nodeBudget: 8,
    beamWidth: 1,
    maxActions: 3,
    candidateLimit: 2,
    minActionScore: 0,
    weights: {},
  },
}

const CHAMPION: SelfPlayAgentArchive = {
  schemaVersion: 1,
  agentId: 'planner-champion-v1',
  version: '1.0.0',
  kind: 'planner',
  historical: true,
  config: {
    version: 1,
    nodeBudget: 6,
    beamWidth: 1,
    maxActions: 3,
    candidateLimit: 2,
    minActionScore: 0,
    weights: {},
  },
}

const RANDOM: SelfPlayAgentArchive = {
  schemaVersion: 1,
  agentId: 'legal-random-v1',
  version: '1.0.0',
  kind: 'legal-random',
  testOnly: true,
}

const ROSTERS: SelfPlayRosterArchive[] = [
  { schemaVersion: 1, rosterId: 'red-alpha-v1', version: '1.0.0', faction: 'red', pieceIds: ['red-a'] },
  { schemaVersion: 1, rosterId: 'blue-alpha-v1', version: '1.0.0', faction: 'blue', pieceIds: ['blue-a'] },
  { schemaVersion: 1, rosterId: 'red-beta-v1', version: '1.0.0', faction: 'red', pieceIds: ['red-b'] },
  { schemaVersion: 1, rosterId: 'blue-beta-v1', version: '1.0.0', faction: 'blue', pieceIds: ['blue-b'] },
]

const SEEDS: SelfPlaySeedPartitions = {
  schemaVersion: 1,
  training: [101, 102],
  publicValidation: [201, 202],
  candidateHoldout: {
    source: 'external',
    commitmentHash: hashStable([301, 302]),
  },
}

function manifest(overrides: Partial<SelfPlaySuiteManifest> = {}): SelfPlaySuiteManifest {
  return {
    schemaVersion: 1,
    suiteId: 'fixed-baseline-v1',
    seedTier: 'public-validation',
    candidateAgentId: CANDIDATE.agentId,
    opponentAgentIds: [CHAMPION.agentId],
    lineups: [
      { lineupId: 'alpha', candidateRosterId: 'red-alpha-v1', opponentRosterId: 'blue-alpha-v1' },
      { lineupId: 'beta', candidateRosterId: 'red-beta-v1', opponentRosterId: 'blue-beta-v1' },
    ],
    budgets: {
      maxActionsPerMatch: 8,
      maxActionsPerTurn: 4,
      maxTurns: 4,
      maxDecisionNodesPerAction: 8,
    },
    rulesHash: 'rules-fixture-v1',
    contentHash: 'content-fixture-v1',
    codeCommit: '0123456789abcdef0123456789abcdef01234567',
    ...overrides,
  }
}

function candidate(id: string, action: CandidateAction['action'], kind: CandidateAction['kind']): CandidateAction {
  return { protocolVersion: 1, id, kind, action }
}

function result(state: BattleState, action: CandidateAction, accepted = true): TransitionResult {
  if (!accepted) {
    return {
      protocolVersion: 1,
      accepted: false,
      state,
      stateHash: hashStable(state),
      transitionHash: hashStable({ state, action, accepted }),
      error: { code: 'FIXTURE_REJECTED', name: 'FixtureRejection', message: 'fixture rejection' },
      trace: { actionLog: [], stateChanges: [] },
    }
  }
  return {
    protocolVersion: 1,
    accepted: true,
    state,
    stateHash: hashStable(state),
    transitionHash: hashStable({ state, action, accepted }),
    trace: { actionLog: [], stateChanges: [] },
  }
}

function decisiveEnvironment(mode: 'finish' | 'reject' | 'loop' | 'progress' | 'exception' = 'finish'): AIEnvironment {
  return {
    protocolVersion: 1,
    capabilities: { protocolVersion: 1, supportedActionTypes: [] as never, unsupportedActionTypes: [] },
    observe: () => ({} as never),
    isTerminal: state => state.terminalResult !== undefined,
    stateKey: state => hashStable(state),
    listLegalActions: state => {
      const playerId = state.turn.currentPlayerId
      if (mode === 'loop' || mode === 'progress' || mode === 'reject' || mode === 'exception') {
        return [candidate('forced-step', { type: 'beginPhase' }, 'phase-advance')]
      }
      const actor = state.pieces.find(piece => piece.ownerPlayerId === playerId && piece.currentHp > 0)!
      const target = state.pieces.find(piece => piece.ownerPlayerId !== playerId && piece.currentHp > 0)!
      return [
        candidate('finish', {
          type: 'useBasicSkill', playerId, pieceId: actor.instanceId,
          skillId: 'basic-attack', targetPieceId: target.instanceId,
        }, 'basic-skill'),
        candidate('end', { type: 'endTurn', playerId }, 'end-turn'),
      ]
    },
    simulate: (state, input) => {
      const selected = 'action' in input ? input : candidate('direct', input, 'phase-advance')
      if (mode === 'exception') throw new Error('fixture exception')
      if (mode === 'reject') return result(state, selected, false)
      if (mode === 'loop') return result(state, selected)
      const next = structuredClone(state) as BattleState & { fixtureRevision?: number }
      if (mode === 'progress') {
        next.fixtureRevision = (next.fixtureRevision ?? 0) + 1
        return result(next, selected)
      }
      const action = selected.action as Extract<CandidateAction['action'], { type: 'useBasicSkill' | 'endTurn' }>
      if (action.type === 'endTurn') {
        next.turn.phase = 'end'
        return result(next, selected)
      }
      const defeated = next.pieces.find(piece => piece.instanceId === action.targetPieceId)!
      defeated.currentHp = 0
      next.pieces = next.pieces.filter(piece => piece.instanceId !== defeated.instanceId)
      next.graveyard.push(defeated)
      next.terminalResult = {
        status: 'finished',
        winnerPlayerId: action.playerId,
        loserPlayerId: defeated.ownerPlayerId,
        reason: 'core-eliminated',
        settledAt: {
          actionIndex: 1, actionType: action.type, actorPlayerId: action.playerId,
          turnNumber: next.turn.turnNumber, phase: next.turn.phase, completedRound: 0,
        },
      }
      return result(next, selected)
    },
  }
}

function randomBudgetEnvironment(): AIEnvironment {
  return {
    protocolVersion: 1,
    capabilities: { protocolVersion: 1, supportedActionTypes: [] as never, unsupportedActionTypes: [] },
    observe: () => ({} as never),
    isTerminal: state => state.terminalResult !== undefined,
    stateKey: state => hashStable(state),
    listLegalActions: state => {
      const playerId = state.turn.currentPlayerId
      const revision = (state as BattleState & { fixtureRevision?: number }).fixtureRevision ?? 0
      if (revision < 3 || revision === 4) {
        return [candidate(`structural-${revision}`, { type: 'beginPhase' }, 'phase-advance')]
      }
      return [
        candidate('progress', { type: 'beginPhase' }, 'move'),
        candidate('end', { type: 'endTurn', playerId }, 'end-turn'),
      ]
    },
    simulate: (state, input) => {
      const selected = 'action' in input ? input : candidate('direct', input, 'phase-advance')
      const next = structuredClone(state) as BattleState & { fixtureRevision?: number }
      if (selected.action.type === 'endTurn') {
        next.fixtureRevision = 4
        return result(next, selected)
      }
      if ((next.fixtureRevision ?? 0) < 4) {
        next.fixtureRevision = (next.fixtureRevision ?? 0) + 1
        return result(next, selected)
      }
      const winnerPlayerId = next.turn.currentPlayerId
      const loserPlayerId = winnerPlayerId === 'player-red' ? 'player-blue' : 'player-red'
      next.terminalResult = {
        status: 'finished',
        winnerPlayerId,
        loserPlayerId,
        reason: 'core-eliminated',
        settledAt: {
          actionIndex: 5, actionType: selected.action.type, actorPlayerId: winnerPlayerId,
          turnNumber: next.turn.turnNumber, phase: next.turn.phase, completedRound: 0,
        },
      }
      return result(next, selected)
    },
  }
}

async function createFixtureState() {
  const red = makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 5 }) as any
  const blue = makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 5 }) as any
  red.isCore = true
  blue.isCore = true
  return makeState({ pieces: [red, blue], currentPlayerId: 'player-red' })
}

describe('offline self-play league and evaluation baseline', () => {
  it('locks agent/config hashes and keeps training, public, and external holdout seeds disjoint', () => {
    expect(SELF_PLAY_SCHEMA_VERSION).toBe(1)
    expect(validateAgentArchive(CANDIDATE)).toEqual(CANDIDATE)
    expect(agentConfigHash(structuredClone(CANDIDATE))).toBe(agentConfigHash(CANDIDATE))
    expect(validateSeedPartitions(SEEDS)).toEqual(SEEDS)
    expect(resolveSelfPlaySeeds(SEEDS, 'training')).toEqual([101, 102])
    expect(resolveSelfPlaySeeds(SEEDS, 'public-validation')).toEqual([201, 202])
    expect(() => resolveSelfPlaySeeds(SEEDS, 'candidate-holdout')).toThrowError(/external candidate holdout seeds/i)
    expect(resolveSelfPlaySeeds(SEEDS, 'candidate-holdout', [301, 302])).toEqual([301, 302])

    expect(() => validateSeedPartitions({ ...SEEDS, training: [] })).toThrowError(/must not be empty/i)
    expect(() => resolveSelfPlaySeeds(SEEDS, 'candidate-holdout', [])).toThrowError(/must not be empty/i)
    expect(() => validateSeedPartitions({ ...SEEDS, publicValidation: [102] })).toThrowError(/overlap/i)
    expect(() => resolveSelfPlaySeeds(SEEDS, 'candidate-holdout', [201])).toThrowError(/overlap/i)
    expect(() => resolveSelfPlaySeeds(SEEDS, 'candidate-holdout', [301])).toThrowError(/commitment/i)
  })

  it('loads the committed fixed suite as immutable self-contained archives', () => {
    const read = (path: string) => JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
    const suite = read('config/ai/suites/fixed-baseline-v1.json')
    const partitions = read('config/ai/seeds.v1.json')
    const agents = suite.agentArchiveFiles.map((path: string) => read(path)) as SelfPlayAgentArchive[]
    const rosters = suite.rosterArchiveFiles.map((path: string) => read(path)) as SelfPlayRosterArchive[]

    expect(validateSeedPartitions(partitions)).toEqual(partitions)
    expect(partitions.candidateHoldout).toEqual({ source: 'external', commitmentHash: 'external-required' })
    expect(agents.map(validateAgentArchive)).toEqual(agents)
    expect(agents.some(agent => agent.historical === true)).toBe(true)
    expect(agents.find(agent => agent.agentId === suite.candidateAgentId)?.kind).toBe('planner')
    for (const agent of agents.filter(agent => agent.kind === 'planner')) {
      expect(agent.config).toMatchObject({
        version: 1,
        nodeBudget: expect.any(Number),
        weights: expect.objectContaining({ enemyHp: expect.any(Number), goal: expect.any(Number) }),
      })
      expect(agentConfigHash(agent)).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(rosters).toHaveLength(4)
    expect(rosters.every(roster => roster.schemaVersion === 1 && roster.pieceIds.length === 8)).toBe(true)

    const schedule = buildPairedMatchSchedule({
      ...suite, rulesHash: 'rules', contentHash: 'content', codeCommit: 'fixture-commit',
    }, partitions.publicValidation)
    expect(schedule).toHaveLength(suite.opponentAgentIds.length * suite.lineups.length * 2)
  })

  it('builds paired seat swaps for every seed, lineup, and historical opponent', () => {
    const schedule = buildPairedMatchSchedule(manifest(), [201, 202])
    expect(schedule).toHaveLength(8)
    for (let index = 0; index < schedule.length; index += 2) {
      const first = schedule[index]
      const swapped = schedule[index + 1]
      expect(swapped.pairId).toBe(first.pairId)
      expect(swapped.rootSeed).toBe(first.rootSeed)
      expect(swapped.lineupId).toBe(first.lineupId)
      expect(swapped.seats['player-red']).toEqual(first.seats['player-blue'])
      expect(swapped.seats['player-blue']).toEqual(first.seats['player-red'])
    }
  })

  it('repeats deterministic paired matches, emits matrices/splits, and replays from archived snapshots', async () => {
    const input = {
      manifest: manifest(),
      seedPartitions: SEEDS,
      agentArchives: [CANDIDATE, CHAMPION],
      rosterArchives: ROSTERS,
      createInitialState: createFixtureState,
      environment: decisiveEnvironment(),
      now: () => 0,
    }
    const first = await runSelfPlaySuite(input)
    const second = await runSelfPlaySuite(input)

    expect(first.schemaVersion).toBe(1)
    expect(first.matches).toHaveLength(8)
    expect(second.matches.map(match => [match.actionTraceHash, match.finalStateHash]))
      .toEqual(first.matches.map(match => [match.actionTraceHash, match.finalStateHash]))
    expect(first.summary.totalMatches).toBe(8)
    expect(first.summary.winMatrix).toHaveLength(2)
    expect(first.summary.seatSplits).toHaveLength(4)
    expect(first.summary.rosterSplits).toHaveLength(4)
    expect(first.summary.seedSplits).toHaveLength(4)
    expect(first.promotionGate).toMatchObject({ hardGatePassed: true, status: 'eligible-for-human-review' })
    expect(first.promotionGate.competitiveEvidence).toContain('win-matrix')
    expect(first.promotionGate.competitiveEvidence).not.toContain('elo-only')
    expect(first.agentArchives.find(agent => agent.agentId === CHAMPION.agentId)?.historical).toBe(true)

    const replay = await replaySelfPlayMatch(first, first.matches[0].matchId, {
      createInitialState: createFixtureState,
      environment: decisiveEnvironment(),
      now: () => 0,
    })
    expect([replay.actionTraceHash, replay.finalStateHash])
      .toEqual([first.matches[0].actionTraceHash, first.matches[0].finalStateHash])

    const failed = await runSelfPlaySuite({
      ...input,
      environment: decisiveEnvironment('exception'),
    })
    expect(failed.matches[0].failure?.kind).toBe('rule-exception')
    const recovered = await replaySelfPlayMatch(failed, failed.matches[0].matchId, {
      createInitialState: createFixtureState,
      environment: decisiveEnvironment(),
      now: () => 0,
    })
    expect(recovered.status).toBe('finished')
    expect(recovered.failure).toBeUndefined()
  })

  it('excludes forced structural actions and ends legal-random turns before the strategy budget is exhausted', async () => {
    const historicalRandom: SelfPlayAgentArchive = {
      ...RANDOM,
      agentId: 'legal-random-history-v1',
      historical: true,
    }
    const report = await runSelfPlaySuite({
      manifest: manifest({
        candidateAgentId: RANDOM.agentId,
        opponentAgentIds: [historicalRandom.agentId],
        lineups: [manifest().lineups[0]],
        budgets: { ...manifest().budgets, maxActionsPerTurn: 1 },
      }),
      seedPartitions: SEEDS,
      explicitSeeds: [201],
      agentArchives: [RANDOM, historicalRandom],
      rosterArchives: ROSTERS,
      createInitialState: createFixtureState,
      environment: randomBudgetEnvironment(),
      now: () => 0,
    })

    expect(report.promotionGate.hardGatePassed).toBe(true)
    expect(report.summary.budgetFailures).toBe(0)
    for (const match of report.matches) {
      expect(match.actions).toHaveLength(5)
      expect(match.actions.slice(0, 3).every(action => action.action.type === 'beginPhase')).toBe(true)
      expect(match.actions[3].action.type).toBe('endTurn')
      expect(match.actions[4].action.type).toBe('beginPhase')
    }
  })

  it.each([
    ['rejected-action', 'reject'],
    ['rule-exception', 'exception'],
    ['state-loop', 'loop'],
    ['action-budget', 'progress'],
  ] as const)('fails the hard gate and preserves a minimal reproduction for %s', async (failureKind, mode) => {
    const failingManifest = manifest({
      candidateAgentId: RANDOM.agentId,
      opponentAgentIds: [CHAMPION.agentId],
      lineups: [manifest().lineups[0]],
      budgets: { ...manifest().budgets, maxActionsPerMatch: 1 },
    })
    const report = await runSelfPlaySuite({
      manifest: failingManifest,
      seedPartitions: SEEDS,
      explicitSeeds: [201],
      agentArchives: [RANDOM, CHAMPION],
      rosterArchives: ROSTERS,
      createInitialState: createFixtureState,
      environment: decisiveEnvironment(mode),
      now: () => 0,
    })

    expect(report.promotionGate.hardGatePassed).toBe(false)
    expect(report.summary.failures.some(failure => failure.kind === failureKind)).toBe(true)
    expect(report.summary.failures[0].reproduction).toMatchObject({
      rootSeed: 201,
      lineupId: 'alpha',
      actionIndex: expect.any(Number),
      stateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    if (failureKind === 'rule-exception') {
      const exception = report.summary.failures.find(failure => failure.kind === failureKind)!
      expect(exception.reproduction.errorStack).toContain('fixture exception')
    }
  })
})
