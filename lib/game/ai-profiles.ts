import type { AiPlannerConfig } from './ai-types'

/**
 * The baseline deliberately has no roster IDs. Consumers may persist this object
 * with a replay/experiment and can introduce a later profile version explicitly.
 */
export const DEFAULT_AI_PLANNER_CONFIG: AiPlannerConfig = Object.freeze({
  version: 1,
  nodeBudget: 96,
  beamWidth: 6,
  maxActions: 8,
  candidateLimit: 20,
  weights: Object.freeze({
    enemyHp: 3,
    ownHp: 3,
    enemyRemoved: 30,
    ownRemoved: -35,
    status: 2,
    distance: 0.4,
    resources: 0.15,
    endTurn: -0.05,
  }),
})

export function resolveAiPlannerConfig(overrides: Partial<Omit<AiPlannerConfig, 'version' | 'weights'>> & {
  weights?: Record<string, number>
} = {}): AiPlannerConfig {
  return {
    ...DEFAULT_AI_PLANNER_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_AI_PLANNER_CONFIG.weights, ...overrides.weights },
  }
}
