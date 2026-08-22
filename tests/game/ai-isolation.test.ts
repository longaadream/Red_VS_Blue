/* eslint-disable @typescript-eslint/no-explicit-any -- fixture rule/cache snapshots intentionally inspect runtime boundaries. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  runSelfPlaySuite,
  validateSelfPlayExecutionMode,
  type SelfPlayAgentArchive,
  type SelfPlayRosterArchive,
  type SelfPlaySeedPartitions,
  type SelfPlaySuiteManifest,
} from '@/lib/game/ai-match-runner'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { dynamicCodeRuntime } from '@/lib/game/dynamic-code-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const seedPartitions: SelfPlaySeedPartitions = {
  schemaVersion: 1,
  training: [701],
  publicValidation: [801],
  candidateHoldout: { source: 'external', commitmentHash: 'not-used-by-this-fixture' },
}

const planner = (agentId: string, historical = false): SelfPlayAgentArchive => ({
  schemaVersion: 1,
  agentId,
  version: '1.0.0',
  kind: 'planner',
  historical,
  config: {
    version: 1,
    nodeBudget: 8,
    beamWidth: 1,
    maxActions: 3,
    candidateLimit: 2,
    minActionScore: 0,
    weights: {},
  },
})

const candidate = planner('isolation-candidate-v1')
const simple: SelfPlayAgentArchive = {
  schemaVersion: 1,
  agentId: 'isolation-simple-v1',
  version: '1.0.0',
  kind: 'simple',
}
const champion = planner('isolation-champion-v1', true)
const rosters: SelfPlayRosterArchive[] = [
  { schemaVersion: 1, rosterId: 'red-isolation-v1', version: '1.0.0', faction: 'red', pieceIds: ['red-a'] },
  { schemaVersion: 1, rosterId: 'blue-isolation-v1', version: '1.0.0', faction: 'blue', pieceIds: ['blue-a'] },
]
const manifest: SelfPlaySuiteManifest = {
  schemaVersion: 1,
  suiteId: 'isolation-v1',
  seedTier: 'public-validation',
  candidateAgentId: candidate.agentId,
  opponentAgentIds: [champion.agentId],
  lineups: [{ lineupId: 'isolation', candidateRosterId: rosters[0].rosterId, opponentRosterId: rosters[1].rosterId }],
  budgets: {
    maxActionsPerMatch: 4,
    maxActionsPerTurn: 3,
    maxTurns: 2,
    maxDecisionNodesPerAction: 8,
  },
  rulesHash: 'rules-isolation-v1',
  contentHash: 'content-isolation-v1',
  codeCommit: '0123456789abcdef0123456789abcdef01234567',
}

async function createCombatState() {
  const red = makePiece({
    instanceId: 'red-core', ownerPlayerId: 'player-red', x: 1, y: 1, currentHp: 5, attack: 10,
  }) as any
  const blue = makePiece({
    instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 5, attack: 10,
  }) as any
  red.isCore = true
  blue.isCore = true
  red.skills = [{ skillId: 'basic-attack', currentCooldown: 0, usesRemaining: -1 }]
  blue.skills = [{ skillId: 'basic-attack', currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({ pieces: [red, blue], currentPlayerId: 'player-red' }) as any
  state.players[0].actionPoints = 2
  state.players[1].actionPoints = 2
  return state
}

async function createExtendedCombatState() {
  const state = await createCombatState()
  for (const piece of state.pieces) {
    piece.attack = 1
    piece.currentHp = 5
    piece.maxHp = 5
  }
  state.players[0].actionPoints = 3
  state.players[1].actionPoints = 3
  return state
}

beforeEach(() => {
  globalTriggerSystem.clearRules()
  dynamicCodeRuntime.clear()
})
afterEach(() => {
  globalTriggerSystem.clearRules()
  dynamicCodeRuntime.clear()
})

describe('self-play runtime isolation', () => {
  it('fails closed for shared in-process concurrency and documents process isolation as the only parallel mode', () => {
    expect(validateSelfPlayExecutionMode({ inProcessConcurrency: 1, processCount: 1 }))
      .toMatchObject({ isolation: 'serial-in-process', processCount: 1 })
    expect(() => validateSelfPlayExecutionMode({ inProcessConcurrency: 2, processCount: 2 }))
      .toThrowError(/in-process concurrency.*unsafe/i)
    expect(() => validateSelfPlayExecutionMode({ inProcessConcurrency: 1, processCount: 2 }))
      .toThrowError(/process-parallel orchestration.*not implemented/i)
  })

  it('repeats paired formal matches without leaking TriggerSystem state, RNG trace, or compiled cache identity', async () => {
    const sentinel: any = {
      id: 'sentinel-rule', name: 'sentinel', description: 'sentinel',
      trigger: { type: 'beforeSkill' }, limits: { maxUses: 10, uses: 0 },
      effect: () => ({ success: true }),
    }
    globalTriggerSystem.addRule(sentinel)
    const input = {
      manifest,
      seedPartitions,
      explicitSeeds: [801],
      agentArchives: [candidate, champion],
      rosterArchives: rosters,
      createInitialState: createCombatState,
      environment: aiEnvironmentV1,
      now: () => 0,
    }

    const first = await runSelfPlaySuite(input)
    const cacheAfterFirst = dynamicCodeRuntime.stats()
    const second = await runSelfPlaySuite(input)

    expect(first.matches.map(match => [match.actionTraceHash, match.finalStateHash]))
      .toEqual(second.matches.map(match => [match.actionTraceHash, match.finalStateHash]))
    expect(globalTriggerSystem.getRules()[0]).toBe(sentinel)
    expect(sentinel.limits).toEqual({ maxUses: 10, uses: 0 })
    expect(dynamicCodeRuntime.stats()).toEqual(cacheAfterFirst)
    expect(first.execution).toMatchObject({ isolation: 'serial-in-process', inProcessConcurrency: 1 })
  }, 30_000)

  it('adapts canonical cache-stripped states before every Simple AI decision', async () => {
    const report = await runSelfPlaySuite({
      manifest: { ...manifest, candidateAgentId: simple.agentId },
      seedPartitions,
      explicitSeeds: [801],
      agentArchives: [simple, champion],
      rosterArchives: rosters,
      createInitialState: createExtendedCombatState,
      environment: aiEnvironmentV1,
      now: () => 0,
    })

    const simpleAsRed = report.matches.find(match => match.seats['player-red'].agentId === simple.agentId)
    expect(simpleAsRed?.actions.filter(action => action.agentId === simple.agentId).length).toBeGreaterThan(1)
    expect(report.summary.exceptionFailures).toBe(0)
    expect(report.summary.failures.every(failure =>
      failure.reproduction.errorMessage?.includes('basic-attack') !== true,
    )).toBe(true)
  }, 30_000)
})
