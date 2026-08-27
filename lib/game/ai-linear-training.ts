import { createHash } from 'node:crypto'

import { AI_LINEAR_FEATURE_NAMES, type AiLinearFeatureName } from './ai-linear-features'
import { hashStable } from './battle-trace'

export interface LinearPopulationCandidate {
  candidateId: string
  pairIndex: number
  sign: 1 | -1
  perturbation: Record<AiLinearFeatureName, number>
  weights: Record<AiLinearFeatureName, number>
}

export interface LinearGenerationJob {
  jobId: string
  order: number
  generation: number
  candidateId: string
  rootSeed: number
  lineupId: string
  opponentAgentId: string
  swapIndex: 0 | 1
}

export interface LinearTrainingMatchResult {
  jobId: string
  candidateId: string
  outcome: 'win' | 'draw' | 'loss'
  hardGatePassed: boolean
  durationMs?: number
  failureKind?: string
}

export interface LinearAdamState {
  step: number
  firstMoment: Record<AiLinearFeatureName, number>
  secondMoment: Record<AiLinearFeatureName, number>
}

export interface LinearGenerationState {
  generation: number
  status: 'running' | 'paused'
  rootSeeds: number[]
  lineupId: string
  opponentAgentIds: string[]
  sigma: number
  population: LinearPopulationCandidate[]
  schedule: LinearGenerationJob[]
  matches: LinearTrainingMatchResult[]
  commitment: string
  startedAt: string
}

export interface LinearTrainingRun {
  schemaVersion: 1
  kind: 'rvb-linear-training-run-v1'
  runId: string
  status: 'awaiting-user' | 'running' | 'paused'
  pauseReason?: 'user-requested' | 'hard-gate-failure'
  codeCommit: string
  codeHash: string
  rulesHash: string
  contentHash: string
  featureSchemaHash: string
  trainingConfigHash: string
  optimizerSeed: number
  completedGeneration: number
  centerWeights: Record<AiLinearFeatureName, number>
  optimizerState?: LinearAdamState
  activeGeneration?: LinearGenerationState
  archives: Array<{
    generation: number
    commitment: string
    rootSeeds: number[]
    lineupId: string
    opponentAgentIds: string[]
    totalMatches: number
    wins: number
    draws: number
    losses: number
    durationMs: number
    fitnessByCandidate: Record<string, number>
    gradient: Record<AiLinearFeatureName, number>
    weightsAfter: Record<AiLinearFeatureName, number>
    completedAt: string
  }>
}

function uniform(token: unknown) {
  const digest = createHash('sha256').update(hashStable(token)).digest()
  return (digest.readUInt32BE(0) + 1) / (0x1_0000_0000 + 1)
}

function normal(seed: number, generation: number, pairIndex: number, featureIndex: number) {
  const u1 = uniform({ stream: 'linear-es-u1', seed, generation, pairIndex, featureIndex })
  const u2 = uniform({ stream: 'linear-es-u2', seed, generation, pairIndex, featureIndex })
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function finiteRecord(input: Readonly<Record<string, number>>, field: string): Record<AiLinearFeatureName, number> {
  const output = {} as Record<AiLinearFeatureName, number>
  for (const name of AI_LINEAR_FEATURE_NAMES) {
    const value = input[name]
    if (!Number.isFinite(value)) throw new RangeError(`${field}.${name} must be finite`)
    output[name] = value
  }
  return output
}

export function buildMirroredLinearPopulation(
  inputCenter: Readonly<Record<string, number>>,
  config: { optimizerSeed: number; generation: number; pairCount: number; sigma: number },
): LinearPopulationCandidate[] {
  if (!Number.isSafeInteger(config.optimizerSeed) || config.optimizerSeed < 0 || config.optimizerSeed > 0xffff_ffff) {
    throw new RangeError('optimizerSeed must be a uint32')
  }
  if (!Number.isSafeInteger(config.generation) || config.generation <= 0) throw new RangeError('generation must be positive')
  if (!Number.isSafeInteger(config.pairCount) || config.pairCount <= 0) throw new RangeError('pairCount must be positive')
  if (!Number.isFinite(config.sigma) || config.sigma <= 0) throw new RangeError('sigma must be positive')
  const center = finiteRecord(inputCenter, 'center')
  return Array.from({ length: config.pairCount }, (_, pairIndex) => {
    const perturbation = Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map((name, featureIndex) => [
      name, normal(config.optimizerSeed, config.generation, pairIndex, featureIndex),
    ])) as Record<AiLinearFeatureName, number>
    return ([1, -1] as const).map(sign => ({
      candidateId: `g${String(config.generation).padStart(4, '0')}-p${String(pairIndex).padStart(2, '0')}-${sign === 1 ? 'plus' : 'minus'}`,
      pairIndex,
      sign,
      perturbation,
      weights: Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [
        name, center[name] + sign * config.sigma * perturbation[name],
      ])) as Record<AiLinearFeatureName, number>,
    }))
  }).flat()
}

export function buildLinearGenerationSchedule(input: {
  generation: number
  candidates: readonly LinearPopulationCandidate[]
  rootSeeds: readonly number[]
  lineupId: string
  opponentAgentIds: readonly string[]
}): LinearGenerationJob[] {
  const jobs: LinearGenerationJob[] = []
  for (const candidate of input.candidates) {
    for (const rootSeed of input.rootSeeds) {
      for (const opponentAgentId of input.opponentAgentIds) {
        for (const swapIndex of [0, 1] as const) {
          const order = jobs.length
          const identity = {
            generation: input.generation, candidateId: candidate.candidateId, rootSeed,
            lineupId: input.lineupId, opponentAgentId, swapIndex,
          }
          jobs.push({ jobId: `linear-job-${hashStable(identity).slice(0, 24)}`, order, ...identity })
        }
      }
    }
  }
  return jobs
}

export function centeredRanks(values: readonly number[]): number[] {
  if (values.length <= 1) return values.map(() => 0)
  if (values.some(value => !Number.isFinite(value))) throw new RangeError('fitness values must be finite')
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index)
  const ranks = Array(values.length).fill(0) as number[]
  for (let start = 0; start < sorted.length;) {
    let end = start + 1
    while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1
    const averageRank = (start + end - 1) / 2
    for (let index = start; index < end; index += 1) ranks[sorted[index].index] = averageRank / (values.length - 1) - 0.5
    start = end
  }
  return ranks
}

export function estimateMirroredGradient(
  population: readonly LinearPopulationCandidate[],
  fitnessByCandidate: Readonly<Record<string, number>>,
  sigma: number,
): Record<AiLinearFeatureName, number> {
  if (!Number.isFinite(sigma) || sigma <= 0) throw new RangeError('sigma must be positive')
  const ranks = centeredRanks(population.map(candidate => fitnessByCandidate[candidate.candidateId]))
  const pairs = new Map<number, { plus?: number; minus?: number; perturbation: Record<AiLinearFeatureName, number> }>()
  population.forEach((candidate, index) => {
    const pair = pairs.get(candidate.pairIndex) ?? { perturbation: candidate.perturbation }
    if (candidate.sign === 1) pair.plus = ranks[index]
    else pair.minus = ranks[index]
    pairs.set(candidate.pairIndex, pair)
  })
  const gradient = Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [name, 0])) as Record<AiLinearFeatureName, number>
  for (const pair of pairs.values()) {
    if (pair.plus === undefined || pair.minus === undefined) throw new Error('mirrored population pair is incomplete')
    for (const name of AI_LINEAR_FEATURE_NAMES) {
      gradient[name] += (pair.plus - pair.minus) * pair.perturbation[name] / (pairs.size * sigma)
    }
  }
  return gradient
}

export function adamLinearUpdate(
  inputWeights: Readonly<Record<string, number>>,
  inputGradient: Readonly<Record<string, number>>,
  previous: LinearAdamState | undefined,
  options: {
    step: number
    learningRate: number
    beta1?: number
    beta2?: number
    epsilon?: number
    weightDecay?: number
    maxAbsWeight?: number
  },
): { weights: Record<AiLinearFeatureName, number>; optimizerState: LinearAdamState } {
  const weights = finiteRecord(inputWeights, 'weights')
  const gradient = finiteRecord(inputGradient, 'gradient')
  const beta1 = options.beta1 ?? 0.9
  const beta2 = options.beta2 ?? 0.999
  const epsilon = options.epsilon ?? 1e-8
  const weightDecay = options.weightDecay ?? 0.001
  const maxAbsWeight = options.maxAbsWeight ?? 5
  if (!Number.isSafeInteger(options.step) || options.step <= 0) throw new RangeError('Adam step must be positive')
  if (!Number.isFinite(options.learningRate) || options.learningRate <= 0) throw new RangeError('learningRate must be positive')
  if (previous && previous.step !== options.step - 1) throw new Error('Adam state step does not precede requested step')
  const oldFirst = previous?.firstMoment ?? Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [name, 0]))
  const oldSecond = previous?.secondMoment ?? Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [name, 0]))
  const firstMoment = {} as Record<AiLinearFeatureName, number>
  const secondMoment = {} as Record<AiLinearFeatureName, number>
  const next = {} as Record<AiLinearFeatureName, number>
  for (const name of AI_LINEAR_FEATURE_NAMES) {
    const adjustedGradient = gradient[name] - weightDecay * weights[name]
    firstMoment[name] = beta1 * oldFirst[name] + (1 - beta1) * adjustedGradient
    secondMoment[name] = beta2 * oldSecond[name] + (1 - beta2) * adjustedGradient ** 2
    const firstHat = firstMoment[name] / (1 - beta1 ** options.step)
    const secondHat = secondMoment[name] / (1 - beta2 ** options.step)
    next[name] = Math.max(-maxAbsWeight, Math.min(maxAbsWeight,
      weights[name] + options.learningRate * firstHat / (Math.sqrt(secondHat) + epsilon)))
  }
  return { weights: next, optimizerState: { step: options.step, firstMoment, secondMoment } }
}

export function finalizeLinearGeneration(input: {
  center: Readonly<Record<string, number>>
  population: readonly LinearPopulationCandidate[]
  schedule: readonly LinearGenerationJob[]
  matches: readonly LinearTrainingMatchResult[]
  sigma: number
  optimizerState?: LinearAdamState
  learningRate?: number
}) {
  const expected = new Set(input.schedule.map(job => job.jobId))
  const matchesById = new Map<string, LinearTrainingMatchResult>()
  for (const match of input.matches) {
    if (!expected.has(match.jobId) || matchesById.has(match.jobId)) throw new Error(`invalid or duplicate match ${match.jobId}`)
    matchesById.set(match.jobId, match)
  }
  if (matchesById.size !== expected.size) throw new Error(`generation incomplete: ${matchesById.size}/${expected.size} matches`)
  const hardGateFailures = [...matchesById.values()].filter(match => !match.hardGatePassed)
  if (hardGateFailures.length > 0) {
    throw new Error(`generation has ${hardGateFailures.length} hard-gate failure(s); weights must not update`)
  }
  const fitnessByCandidate = Object.fromEntries(input.population.map(candidate => {
    const results = input.schedule.filter(job => job.candidateId === candidate.candidateId)
      .map(job => matchesById.get(job.jobId)!)
    const total = results.reduce((score, match) => score + (!match.hardGatePassed
      ? -2 : match.outcome === 'win' ? 1 : match.outcome === 'loss' ? -1 : 0), 0)
    return [candidate.candidateId, total / results.length]
  }))
  const gradient = estimateMirroredGradient(input.population, fitnessByCandidate, input.sigma)
  const updated = adamLinearUpdate(input.center, gradient, input.optimizerState, {
    step: (input.optimizerState?.step ?? 0) + 1,
    learningRate: input.learningRate ?? 0.02,
  })
  return {
    commitment: hashStable({ population: input.population, schedule: input.schedule, matches: [...matchesById.values()].sort((a, b) => a.jobId.localeCompare(b.jobId)) }),
    fitnessByCandidate,
    gradient,
    weightsAfter: updated.weights,
    optimizerState: updated.optimizerState,
  }
}

export function createLinearTrainingRun(input: {
  runId: string
  codeCommit: string
  codeHash: string
  rulesHash: string
  contentHash: string
  featureSchemaHash: string
  trainingConfigHash: string
  centerWeights: Readonly<Record<string, number>>
  optimizerSeed: number
}): LinearTrainingRun {
  if (!input.runId.trim()) throw new Error('runId must not be empty')
  return {
    schemaVersion: 1,
    kind: 'rvb-linear-training-run-v1',
    runId: input.runId,
    status: 'awaiting-user',
    codeCommit: input.codeCommit,
    codeHash: input.codeHash,
    rulesHash: input.rulesHash,
    contentHash: input.contentHash,
    featureSchemaHash: input.featureSchemaHash,
    trainingConfigHash: input.trainingConfigHash,
    optimizerSeed: input.optimizerSeed,
    completedGeneration: 0,
    centerWeights: finiteRecord(input.centerWeights, 'centerWeights'),
    archives: [],
  }
}

export function beginLinearGeneration(
  run: LinearTrainingRun,
  input: {
    rootSeeds: readonly number[]
    lineupId: string
    opponentAgentIds: readonly string[]
    pairCount?: number
    sigma: number
    now?: string
  },
): LinearTrainingRun {
  if (run.status === 'paused') throw new Error('paused generation must resume instead of starting the next generation')
  if (run.status !== 'awaiting-user' || run.activeGeneration) throw new Error('run is not awaiting a user-requested generation')
  const generation = run.completedGeneration + 1
  const population = buildMirroredLinearPopulation(run.centerWeights, {
    optimizerSeed: run.optimizerSeed,
    generation,
    pairCount: input.pairCount ?? 12,
    sigma: input.sigma,
  })
  const schedule = buildLinearGenerationSchedule({
    generation, candidates: population, rootSeeds: input.rootSeeds,
    lineupId: input.lineupId, opponentAgentIds: input.opponentAgentIds,
  })
  const activeGeneration: LinearGenerationState = {
    generation,
    status: 'running',
    rootSeeds: [...input.rootSeeds],
    lineupId: input.lineupId,
    opponentAgentIds: [...input.opponentAgentIds],
    sigma: input.sigma,
    population,
    schedule,
    matches: [],
    commitment: hashStable({
      runId: run.runId, generation, codeHash: run.codeHash, rulesHash: run.rulesHash,
      contentHash: run.contentHash, featureSchemaHash: run.featureSchemaHash,
      population, schedule,
    }),
    startedAt: input.now ?? new Date().toISOString(),
  }
  return { ...run, status: 'running', activeGeneration }
}

export function recordLinearTrainingMatch(
  run: LinearTrainingRun,
  match: LinearTrainingMatchResult,
): LinearTrainingRun {
  const active = run.activeGeneration
  if (!active || run.status !== 'running') throw new Error('no running generation')
  const job = active.schedule.find(item => item.jobId === match.jobId)
  if (!job || job.candidateId !== match.candidateId) throw new Error(`match does not belong to active schedule: ${match.jobId}`)
  if (active.matches.some(item => item.jobId === match.jobId)) throw new Error(`duplicate match ${match.jobId}`)
  return {
    ...run,
    activeGeneration: { ...active, matches: [...active.matches, match] },
  }
}

export function pauseLinearGeneration(
  run: LinearTrainingRun,
  reason: LinearTrainingRun['pauseReason'] = 'user-requested',
): LinearTrainingRun {
  if (run.status !== 'running' || !run.activeGeneration) throw new Error('no running generation to pause')
  return {
    ...run,
    status: 'paused',
    pauseReason: reason,
    activeGeneration: { ...run.activeGeneration, status: 'paused' },
  }
}

export function resumeLinearGeneration(run: LinearTrainingRun): LinearTrainingRun {
  if (run.status !== 'paused' || !run.activeGeneration) throw new Error('no paused generation to resume')
  const retryableMatches = run.activeGeneration.matches.filter(match => match.hardGatePassed)
  return {
    ...run,
    status: 'running',
    pauseReason: undefined,
    activeGeneration: { ...run.activeGeneration, status: 'running', matches: retryableMatches },
  }
}

export function completeLinearGeneration(run: LinearTrainingRun, input: { learningRate?: number; now?: string } = {}): LinearTrainingRun {
  const active = run.activeGeneration
  if (!active || run.status !== 'running') throw new Error('no running generation')
  const result = finalizeLinearGeneration({
    center: run.centerWeights,
    population: active.population,
    schedule: active.schedule,
    matches: active.matches,
    sigma: active.sigma,
    optimizerState: run.optimizerState,
    learningRate: input.learningRate,
  })
  return {
    ...run,
    status: 'awaiting-user',
    completedGeneration: active.generation,
    centerWeights: result.weightsAfter,
    optimizerState: result.optimizerState,
    activeGeneration: undefined,
    archives: [...run.archives, {
      generation: active.generation,
      commitment: result.commitment,
      rootSeeds: [...active.rootSeeds],
      lineupId: active.lineupId,
      opponentAgentIds: [...active.opponentAgentIds],
      totalMatches: active.matches.length,
      wins: active.matches.filter(match => match.outcome === 'win').length,
      draws: active.matches.filter(match => match.outcome === 'draw').length,
      losses: active.matches.filter(match => match.outcome === 'loss').length,
      durationMs: active.matches.reduce((total, match) => total + (match.durationMs ?? 0), 0),
      fitnessByCandidate: result.fitnessByCandidate,
      gradient: result.gradient,
      weightsAfter: result.weightsAfter,
      completedAt: input.now ?? new Date().toISOString(),
    }],
  }
}

export function linearTrainingProgress(run: LinearTrainingRun) {
  const active = run.activeGeneration
  const matches = active?.matches ?? []
  return {
    runId: run.runId,
    status: run.status,
    generation: active?.generation ?? run.completedGeneration,
    completed: matches.length,
    total: active?.schedule.length ?? 0,
    wins: matches.filter(match => match.hardGatePassed && match.outcome === 'win').length,
    draws: matches.filter(match => match.hardGatePassed && match.outcome === 'draw').length,
    losses: matches.filter(match => match.hardGatePassed && match.outcome === 'loss').length,
    hardGateFailures: matches.filter(match => !match.hardGatePassed).length,
    completedDurationMs: matches.reduce((total, match) => total + (match.durationMs ?? 0), 0),
    commitment: active?.commitment,
  }
}

export function assertLinearRunCompatibility(
  run: LinearTrainingRun,
  expected: Pick<LinearTrainingRun, 'codeHash' | 'rulesHash' | 'contentHash' | 'featureSchemaHash' | 'trainingConfigHash'>,
) {
  for (const field of ['codeHash', 'rulesHash', 'contentHash', 'featureSchemaHash', 'trainingConfigHash'] as const) {
    if (run[field] !== expected[field]) throw new Error(`linear training checkpoint ${field} mismatch`)
  }
  const active = run.activeGeneration
  if (!active) return
  const expectedCommitment = hashStable({
    runId: run.runId, generation: active.generation, codeHash: run.codeHash, rulesHash: run.rulesHash,
    contentHash: run.contentHash, featureSchemaHash: run.featureSchemaHash,
    population: active.population, schedule: active.schedule,
  })
  if (active.commitment !== expectedCommitment) throw new Error('linear training checkpoint schedule commitment mismatch')
  const jobs = new Map(active.schedule.map(job => [job.jobId, job]))
  const seen = new Set<string>()
  for (const match of active.matches) {
    const job = jobs.get(match.jobId)
    if (!job || job.candidateId !== match.candidateId || seen.has(match.jobId)) {
      throw new Error(`linear training checkpoint invalid match ${match.jobId}`)
    }
    seen.add(match.jobId)
  }
}
