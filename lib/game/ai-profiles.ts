import {
  ZERO_STAGE_AI_PROFILE_VERSION,
  type AiPlannerConfig,
  type ZeroStageConfig,
  type ZeroStageStaticComponentKey,
} from './ai-types'

/**
 * Version 1 deliberately contains no roster, character, skill, or card IDs.
 * Persist the resolved object beside a replay/experiment so later profiles can
 * change without silently changing an old decision trace.
 */
export const DEFAULT_AI_PLANNER_CONFIG: AiPlannerConfig = Object.freeze({
  version: 1,
  nodeBudget: 96,
  beamWidth: 6,
  maxActions: 8,
  candidateLimit: 20,
  minActionScore: 0,
  weights: Object.freeze({
    enemyHp: 3,
    ownHp: 3,
    enemyRemoved: 30,
    ownRemoved: -35,
    enemyStatusAdded: 4,
    ownStatusRemoved: 4,
    ownStatusAdded: -2,
    enemyStatusRemoved: -2,
    goalDistance: 0.6,
    safety: 1.5,
    resources: 0.15,
    ownSummoned: 8,
    enemySummoned: -8,
    ownTransformed: 4,
    enemyTransformed: -4,
    endTurn: -0.05,
    goal: 15,
  }),
})

/**
 * Hand-authored zero-stage baseline. Orders of magnitude are deliberate:
 * terminal > immediate lethal/core survival > material > positional detail.
 */
export const DEFAULT_ZERO_STAGE_CONFIG: ZeroStageConfig = Object.freeze({
  version: ZERO_STAGE_AI_PROFILE_VERSION,
  nodeBudget: 10_000,
  lambda: 3_000,
  topWeights: Object.freeze([0.6, 0.3, 0.1] as [number, number, number]),
  terminal: Object.freeze({ win: 1_000_000, loss: -1_000_000, draw: 0 }),
  weights: Object.freeze({
    coreSurvival: 50_000,
    survival: 12_000,
    graveyard: 8_000,
    health: 3_000,
    combatPower: 250,
    shield: 400,
    resources: 250,
    actionability: 500,
    lethalOpportunity: 20_000,
    attackPressure: 1_500,
    status: 500,
    formation: 150,
    mapControl: 100,
  }),
})

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`AI planner ${field} must be a positive safe integer`)
  }
  return value
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`AI planner ${field} must be finite`)
  return value
}

export function resolveAiPlannerConfig(overrides: Partial<Omit<AiPlannerConfig, 'version' | 'weights'>> & {
  weights?: Record<string, number>
} = {}): AiPlannerConfig {
  const weights = { ...DEFAULT_AI_PLANNER_CONFIG.weights, ...overrides.weights }
  for (const [key, value] of Object.entries(weights)) finiteNumber(value, `weights.${key}`)
  return {
    version: 1,
    nodeBudget: positiveInteger(overrides.nodeBudget ?? DEFAULT_AI_PLANNER_CONFIG.nodeBudget, 'nodeBudget'),
    beamWidth: positiveInteger(overrides.beamWidth ?? DEFAULT_AI_PLANNER_CONFIG.beamWidth, 'beamWidth'),
    maxActions: positiveInteger(overrides.maxActions ?? DEFAULT_AI_PLANNER_CONFIG.maxActions, 'maxActions'),
    candidateLimit: positiveInteger(overrides.candidateLimit ?? DEFAULT_AI_PLANNER_CONFIG.candidateLimit, 'candidateLimit'),
    minActionScore: finiteNumber(overrides.minActionScore ?? DEFAULT_AI_PLANNER_CONFIG.minActionScore, 'minActionScore'),
    weights,
  }
}

export function resolveZeroStageConfig(overrides: Partial<Omit<ZeroStageConfig, 'version' | 'weights' | 'terminal'>> & {
  weights?: Partial<Record<ZeroStageStaticComponentKey, number>>
  terminal?: Partial<ZeroStageConfig['terminal']>
} = {}): ZeroStageConfig {
  const weights = { ...DEFAULT_ZERO_STAGE_CONFIG.weights, ...overrides.weights }
  for (const [key, value] of Object.entries(weights)) finiteNumber(value, `zeroStage.weights.${key}`)
  const topWeights = overrides.topWeights ?? DEFAULT_ZERO_STAGE_CONFIG.topWeights
  if (topWeights.length !== 3 || topWeights.some(value => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Zero-stage topWeights must contain three finite non-negative values')
  }
  if (topWeights.every(value => value === 0)) {
    throw new RangeError('Zero-stage topWeights must contain at least one positive value')
  }
  const terminal = { ...DEFAULT_ZERO_STAGE_CONFIG.terminal, ...overrides.terminal }
  for (const [key, value] of Object.entries(terminal)) finiteNumber(value, `zeroStage.terminal.${key}`)
  if (!(terminal.win > terminal.draw && terminal.draw > terminal.loss)) {
    throw new RangeError('Zero-stage terminal scores must satisfy win > draw > loss')
  }
  const lambda = finiteNumber(overrides.lambda ?? DEFAULT_ZERO_STAGE_CONFIG.lambda, 'zeroStage.lambda')
  if (lambda < 0) throw new RangeError('Zero-stage lambda must be non-negative')
  return {
    version: ZERO_STAGE_AI_PROFILE_VERSION,
    nodeBudget: positiveInteger(overrides.nodeBudget ?? DEFAULT_ZERO_STAGE_CONFIG.nodeBudget, 'zeroStage.nodeBudget'),
    lambda,
    topWeights: [...topWeights] as [number, number, number],
    terminal,
    weights,
  }
}
