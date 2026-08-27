import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AI_LINEAR_FEATURE_NAMES } from '@/lib/game/ai-linear-features'
import {
  adamLinearUpdate,
  assertLinearRunCompatibility,
  beginLinearGeneration,
  buildLinearGenerationSchedule,
  buildMirroredLinearPopulation,
  centeredRanks,
  classifyLinearTrainingMatch,
  completeLinearGeneration,
  createLinearTrainingRun,
  estimateMirroredGradient,
  finalizeLinearGeneration,
  linearTrainingProgress,
  pauseLinearGeneration,
  recordLinearTrainingMatch,
  resumeLinearGeneration,
  selectLinearGenerationSeeds,
} from '@/lib/game/ai-linear-training'

const center = Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [name, 0]))

describe('linear AI single-generation optimizer', () => {
  it('builds 24 deterministic mirrored candidates and exactly 96 paired matches', () => {
    const population = buildMirroredLinearPopulation(center, {
      optimizerSeed: 42,
      generation: 1,
      pairCount: 12,
      sigma: 0.15,
    })
    const repeated = buildMirroredLinearPopulation(center, {
      optimizerSeed: 42,
      generation: 1,
      pairCount: 12,
      sigma: 0.15,
    })
    expect(population).toEqual(repeated)
    expect(population).toHaveLength(24)
    for (let pair = 0; pair < 12; pair += 1) {
      const plus = population[pair * 2]
      const minus = population[pair * 2 + 1]
      for (const name of AI_LINEAR_FEATURE_NAMES) {
        expect(plus.weights[name]).toBeCloseTo(-minus.weights[name], 12)
      }
    }

    const schedule = buildLinearGenerationSchedule({
      generation: 1,
      candidates: population,
      rootSeeds: [1001],
      lineupId: 'alpha',
      opponentAgentIds: ['simple-v1', 'planner-champion-v1'],
    })
    expect(schedule).toHaveLength(96)
    expect(new Set(schedule.map(job => job.jobId)).size).toBe(96)
    expect(schedule.filter(job => job.candidateId === population[0].candidateId)).toHaveLength(4)
  })

  it('starts from signed heuristic priors with a smaller first-generation perturbation', () => {
    const seed = JSON.parse(readFileSync(resolve(
      process.cwd(), 'config/ai/agents/linear-greedy-seed-v2.json',
    ), 'utf8'))
    const config = JSON.parse(readFileSync(resolve(
      process.cwd(), 'config/ai/linear-training-v2.json',
    ), 'utf8'))
    expect(seed.config.weights.bias).toBe(0)
    expect(seed.config.weights.actingPlayer).toBe(0)
    for (const name of AI_LINEAR_FEATURE_NAMES.filter(name => !['bias', 'actingPlayer'].includes(name))) {
      expect(seed.config.weights[name]).toBeGreaterThan(0)
    }
    expect(config.sigma).toBe(0.08)
    expect(config.seedsPerGeneration).toBe(1)
    expect(config.processCount).toBe(6)
    expect(config.budgets.maxTurns).toBe(40)
    expect(config.budgets.maxActionsPerMatch)
      .toBeGreaterThan(config.budgets.maxTurns * config.budgets.maxActionsPerTurn)
    const seeds = [1001, 1002, 1003]
    expect(selectLinearGenerationSeeds(seeds, 1)).toEqual([1001])
    expect(selectLinearGenerationSeeds(seeds, 2)).toEqual([1002])
    expect(selectLinearGenerationSeeds(seeds, 4)).toEqual([1001])
  })

  it('adjudicates only the configured turn limit and applies a negative draw score', () => {
    const turnLimit = classifyLinearTrainingMatch({
      jobId: 'turn-limit', candidateId: 'candidate', candidateAgentId: 'candidate-agent',
      status: 'failed', winnerAgentId: null, failureKind: 'turn-budget',
    }, { adjudicatedFailureKinds: ['turn-budget'] })
    expect(turnLimit).toMatchObject({
      outcome: 'draw', hardGatePassed: true, failureKind: 'turn-budget',
      adjudication: 'turn-limit-draw',
    })
    const actionLimit = classifyLinearTrainingMatch({
      jobId: 'action-limit', candidateId: 'candidate', candidateAgentId: 'candidate-agent',
      status: 'failed', winnerAgentId: null, failureKind: 'action-budget',
    }, { adjudicatedFailureKinds: ['turn-budget'] })
    expect(actionLimit).toMatchObject({ outcome: 'draw', hardGatePassed: false, failureKind: 'action-budget' })

    const population = buildMirroredLinearPopulation(center, {
      optimizerSeed: 31, generation: 1, pairCount: 1, sigma: 0.08,
    })
    const schedule = buildLinearGenerationSchedule({
      generation: 1, candidates: population, rootSeeds: [1001], lineupId: 'alpha',
      opponentAgentIds: ['simple-v1'],
    })
    const matches = schedule.map((job, index) => ({
      jobId: job.jobId,
      candidateId: job.candidateId,
      outcome: index < 2 ? 'draw' : 'loss',
      hardGatePassed: true,
      adjudication: index < 2 ? 'turn-limit-draw' : undefined,
    } as const))
    const result = finalizeLinearGeneration({
      center, population, schedule, matches, sigma: 0.08, drawScore: -0.25,
    })
    expect(result.fitnessByCandidate[population[0].candidateId]).toBe(-0.25)
    expect(result.fitnessByCandidate[population[1].candidateId]).toBe(-1)
  })

  it('uses tied centered ranks, estimates a mirrored gradient, and updates Adam deterministically', () => {
    expect(centeredRanks([1, 1, 3])).toEqual([-0.25, -0.25, 0.5])
    const population = buildMirroredLinearPopulation(center, {
      optimizerSeed: 9, generation: 2, pairCount: 2, sigma: 0.2,
    })
    const fitness = Object.fromEntries(population.map((candidate, index) => [candidate.candidateId, index % 2 === 0 ? 1 : -1]))
    const gradient = estimateMirroredGradient(population, fitness, 0.2)
    expect(Object.values(gradient).some(value => Math.abs(value) > 0)).toBe(true)
    const first = adamLinearUpdate(center, gradient, undefined, { step: 1, learningRate: 0.02 })
    const second = adamLinearUpdate(center, gradient, undefined, { step: 1, learningRate: 0.02 })
    expect(first).toEqual(second)
    expect(Object.values(first.weights).every(Number.isFinite)).toBe(true)
  })

  it('refuses to update weights until every scheduled match is complete and is order independent', () => {
    const population = buildMirroredLinearPopulation(center, {
      optimizerSeed: 7, generation: 1, pairCount: 1, sigma: 0.1,
    })
    const schedule = buildLinearGenerationSchedule({
      generation: 1,
      candidates: population,
      rootSeeds: [1001, 1002],
      lineupId: 'alpha',
      opponentAgentIds: ['simple-v1', 'planner-champion-v1'],
    })
    const matches = schedule.map((job, index) => ({
      jobId: job.jobId,
      candidateId: job.candidateId,
      outcome: index % 3 === 0 ? 'win' : index % 3 === 1 ? 'draw' : 'loss',
      hardGatePassed: true,
    } as const))
    expect(() => finalizeLinearGeneration({ center, population, schedule, matches: matches.slice(1), sigma: 0.1 }))
      .toThrowError(/incomplete/i)
    expect(() => finalizeLinearGeneration({
      center, population, schedule,
      matches: matches.map((match, index) => index === 0 ? { ...match, hardGatePassed: false } : match),
      sigma: 0.1,
    })).toThrowError(/hard-gate/i)
    const forward = finalizeLinearGeneration({ center, population, schedule, matches, sigma: 0.1 })
    const reverse = finalizeLinearGeneration({ center, population, schedule, matches: [...matches].reverse(), sigma: 0.1 })
    expect(forward).toEqual(reverse)
  })

  it('archives auditable matchup and outcome totals after a complete generation', () => {
    const run = createLinearTrainingRun({
      runId: 'archive-run', codeCommit: 'a'.repeat(40), codeHash: 'b'.repeat(64),
      rulesHash: 'c'.repeat(64), contentHash: 'd'.repeat(64), featureSchemaHash: 'e'.repeat(64),
      centerWeights: center, optimizerSeed: 13, trainingConfigHash: 'f'.repeat(64),
    })
    let active = beginLinearGeneration(run, {
      rootSeeds: [1001], lineupId: 'alpha', opponentAgentIds: ['simple-v1'], pairCount: 1, sigma: 0.1,
    })
    for (const [index, job] of active.activeGeneration!.schedule.entries()) {
      active = recordLinearTrainingMatch(active, {
        jobId: job.jobId, candidateId: job.candidateId,
        outcome: index === 0 ? 'win' : index === 1 ? 'loss' : 'draw', hardGatePassed: true,
        durationMs: 5,
        adjudication: index === 2 ? 'turn-limit-draw' : undefined,
      })
    }
    const completed = completeLinearGeneration(active, {
      drawScore: -0.25, now: '2026-08-27T00:00:00.000Z',
    })
    expect(completed.archives[0]).toMatchObject({
      rootSeeds: [1001], lineupId: 'alpha', opponentAgentIds: ['simple-v1'],
      totalMatches: 4, wins: 1, losses: 1, draws: 2, adjudicatedDraws: 1,
      drawScore: -0.25, durationMs: 20,
    })
    expect(linearTrainingProgress(completed)).toMatchObject({
      status: 'awaiting-user', generation: 1, completed: 4, total: 4,
      wins: 1, losses: 1, draws: 2, adjudicatedDraws: 1, completedDurationMs: 20,
    })
  })

  it('archives one generation, pauses safely, and always returns to awaiting-user', () => {
    const run = createLinearTrainingRun({
      runId: 'fixture-run', codeCommit: 'a'.repeat(40), codeHash: 'b'.repeat(64),
      rulesHash: 'c'.repeat(64), contentHash: 'd'.repeat(64), featureSchemaHash: 'e'.repeat(64),
      centerWeights: center, optimizerSeed: 17, trainingConfigHash: 'f'.repeat(64),
    })
    expect(run.status).toBe('awaiting-user')
    const started = beginLinearGeneration(run, {
      rootSeeds: [1001], lineupId: 'alpha', opponentAgentIds: ['simple-v1', 'planner-champion-v1'],
      pairCount: 1, sigma: 0.1,
    })
    expect(started.status).toBe('running')
    expect(linearTrainingProgress(started)).toMatchObject({ generation: 1, completed: 0, total: 8 })
    const firstJob = started.activeGeneration!.schedule[0]
    const recorded = recordLinearTrainingMatch(started, {
      jobId: firstJob.jobId, candidateId: firstJob.candidateId, outcome: 'draw', hardGatePassed: true,
    })
    expect(linearTrainingProgress(recorded).completed).toBe(1)
    const paused = pauseLinearGeneration(recorded)
    expect(paused.status).toBe('paused')
    expect(paused.pauseReason).toBe('user-requested')
    expect(paused.centerWeights).toEqual(run.centerWeights)
    expect(() => beginLinearGeneration(paused, {
      rootSeeds: [1003, 1004], lineupId: 'beta', opponentAgentIds: ['simple-v1', 'planner-champion-v1'],
      pairCount: 1, sigma: 0.1,
    })).toThrowError(/resume/i)
  })

  it('keeps weights unchanged and retries only hard-gate failures after resume', () => {
    const run = createLinearTrainingRun({
      runId: 'retry-run', codeCommit: 'a'.repeat(40), codeHash: 'b'.repeat(64),
      rulesHash: 'c'.repeat(64), contentHash: 'd'.repeat(64), featureSchemaHash: 'e'.repeat(64),
      centerWeights: center, optimizerSeed: 19, trainingConfigHash: 'f'.repeat(64),
    })
    const started = beginLinearGeneration(run, {
      rootSeeds: [1001], lineupId: 'alpha', opponentAgentIds: ['simple-v1'], pairCount: 1, sigma: 0.1,
    })
    const [passedJob, failedJob] = started.activeGeneration!.schedule
    const withPassed = recordLinearTrainingMatch(started, {
      jobId: passedJob.jobId, candidateId: passedJob.candidateId, outcome: 'draw', hardGatePassed: true, durationMs: 10,
    })
    const withFailure = recordLinearTrainingMatch(withPassed, {
      jobId: failedJob.jobId, candidateId: failedJob.candidateId, outcome: 'draw', hardGatePassed: false,
      durationMs: 20, failureKind: 'action-budget',
    })
    const blocked = pauseLinearGeneration(withFailure, 'hard-gate-failure')
    expect(blocked.centerWeights).toEqual(run.centerWeights)
    expect(blocked.pauseReason).toBe('hard-gate-failure')
    expect(linearTrainingProgress(blocked)).toMatchObject({ completed: 2, hardGateFailures: 1, completedDurationMs: 30 })
    const resumed = resumeLinearGeneration(blocked)
    expect(resumed.activeGeneration!.matches).toEqual([withPassed.activeGeneration!.matches[0]])
    expect(resumed.centerWeights).toEqual(run.centerWeights)
    expect(resumed.pauseReason).toBeUndefined()
  })

  it('fails closed when the training config or active schedule commitment changes', () => {
    const run = createLinearTrainingRun({
      runId: 'compatibility-run', codeCommit: 'a'.repeat(40), codeHash: 'b'.repeat(64),
      rulesHash: 'c'.repeat(64), contentHash: 'd'.repeat(64), featureSchemaHash: 'e'.repeat(64),
      trainingConfigHash: 'f'.repeat(64), centerWeights: center, optimizerSeed: 23,
    })
    const active = beginLinearGeneration(run, {
      rootSeeds: [1001], lineupId: 'alpha', opponentAgentIds: ['simple-v1'], pairCount: 1, sigma: 0.1,
    })
    const expected = {
      codeHash: active.codeHash, rulesHash: active.rulesHash, contentHash: active.contentHash,
      featureSchemaHash: active.featureSchemaHash, trainingConfigHash: active.trainingConfigHash,
    }
    expect(() => assertLinearRunCompatibility(active, expected)).not.toThrow()
    expect(() => assertLinearRunCompatibility(active, { ...expected, trainingConfigHash: '0'.repeat(64) }))
      .toThrowError(/trainingConfigHash mismatch/)
    const corrupted = structuredClone(active)
    corrupted.activeGeneration!.schedule[0].rootSeed = 9999
    expect(() => assertLinearRunCompatibility(corrupted, expected)).toThrowError(/schedule commitment mismatch/)
  })
})
