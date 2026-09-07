import { ZERO_STAGE_AI_PROFILE_VERSION, type ZeroStageConfig, type ZeroStageStaticComponentKey } from './evaluator-types'
export const DEFAULT_ZERO_STAGE_CONFIG: ZeroStageConfig = Object.freeze({
  version: ZERO_STAGE_AI_PROFILE_VERSION,
  candidateMode: 'all-legal',
  maxActionsPerTurn: 8,
  terminal: Object.freeze({ win: 1_000_000, loss: -1_000_000, draw: 0 }),
  weights: Object.freeze({
    coreSurvival: 200_000,
    survival: 10_000,
    graveyard: 10_000,
    health: 80_000,
    combatPower: 300,
    shield: 30_000,
    protection: 80_000,
    delayedDamage: 40_000,
    resources: 0,
    actionability: 150,
    deploymentReadiness: 500_000,
    turnProgress: 0,
    lethalOpportunity: 5_000,
    attackPressure: 2_000,
    status: 400,
    positionSafety: 2_500,
    strategicPosition: 5_000,
    enemyProximity: 80_000,
    futureAttackPotential: 500,
    supportPotential: 400,
    mobilityPotential: 500,
    terrainValue: 700,
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

export function resolveZeroStageConfig(overrides: Partial<Omit<ZeroStageConfig, 'version' | 'weights' | 'terminal'>> & {
  weights?: Partial<Record<ZeroStageStaticComponentKey, number>>
  terminal?: Partial<ZeroStageConfig['terminal']>
} = {}): ZeroStageConfig {
  const weights = { ...DEFAULT_ZERO_STAGE_CONFIG.weights, ...overrides.weights }
  for (const [key, value] of Object.entries(weights)) finiteNumber(value, `zeroStage.weights.${key}`)
  const terminal = { ...DEFAULT_ZERO_STAGE_CONFIG.terminal, ...overrides.terminal }
  for (const [key, value] of Object.entries(terminal)) finiteNumber(value, `zeroStage.terminal.${key}`)
  if (!(terminal.win > terminal.draw && terminal.draw > terminal.loss)) {
    throw new RangeError('Zero-stage terminal scores must satisfy win > draw > loss')
  }
  const candidateMode = overrides.candidateMode ?? DEFAULT_ZERO_STAGE_CONFIG.candidateMode
  if (candidateMode !== 'all-legal') {
    throw new RangeError('Zero-stage candidate mode must be all-legal')
  }
  return {
    version: ZERO_STAGE_AI_PROFILE_VERSION,
    candidateMode,
    maxActionsPerTurn: positiveInteger(
      overrides.maxActionsPerTurn ?? DEFAULT_ZERO_STAGE_CONFIG.maxActionsPerTurn,
      'zeroStage.maxActionsPerTurn',
    ),
    terminal,
    weights,
  }
}
