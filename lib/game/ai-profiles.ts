import type { AiPlannerConfig } from './ai-types'

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
