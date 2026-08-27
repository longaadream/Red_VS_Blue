import { hashStable } from './battle-trace'
import {
  AI_LINEAR_FEATURE_SCHEMA_VERSION,
  type AiLinearFeatureVector,
  type AIObservation,
  type AIObservedPiece,
} from './ai-types'

export const AI_LINEAR_FEATURE_NAMES = Object.freeze([
  'bias',
  'coreAliveBalance',
  'coreHpBalance',
  'livingBalance',
  'hpBalance',
  'attackBalance',
  'defenseBalance',
  'shieldBalance',
  'buffBalance',
  'debuffBalance',
  'readySkillBalance',
  'actionPointBalance',
  'chargePointBalance',
  'handBalance',
  'engagementBalance',
  'coreSafetyBalance',
  'actingPlayer',
] as const)

export type AiLinearFeatureName = typeof AI_LINEAR_FEATURE_NAMES[number]

export const AI_LINEAR_FEATURE_SCHEMA_HASH = hashStable({
  schemaVersion: AI_LINEAR_FEATURE_SCHEMA_VERSION,
  observationScope: 'player-public-observation',
  featureNames: AI_LINEAR_FEATURE_NAMES,
  normalization: 'bounded-relative-v1',
})

const samePlayer = (left: unknown, right: unknown) => (
  String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
)

function clamp(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, value))
}

function relative(left: number, right: number) {
  const scale = Math.abs(left) + Math.abs(right)
  return scale === 0 ? 0 : clamp((left - right) / scale)
}

function hpRatio(piece: AIObservedPiece) {
  return piece.maxHp > 0 ? clamp(Math.max(0, piece.currentHp) / piece.maxHp) : 0
}

function sum(items: readonly AIObservedPiece[], read: (piece: AIObservedPiece) => number) {
  return items.reduce((total, piece) => total + read(piece), 0)
}

function readySkills(piece: AIObservedPiece) {
  return (piece.skills || []).filter(skill => (skill.currentCooldown ?? 0) <= 0).length
}

function distance(left: AIObservedPiece, right: AIObservedPiece) {
  if (left.x == null || left.y == null || right.x == null || right.y == null) return undefined
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
}

function averageNearest(from: readonly AIObservedPiece[], to: readonly AIObservedPiece[], fallback: number) {
  if (!from.length || !to.length) return fallback
  const distances = from.map(piece => {
    const candidates = to.map(other => distance(piece, other)).filter(value => value !== undefined)
    return candidates.length ? Math.min(...candidates) : fallback
  })
  return distances.reduce((total, value) => total + value, 0) / distances.length
}

function coreNearest(core: readonly AIObservedPiece[], hostile: readonly AIObservedPiece[], fallback: number) {
  if (!core.length || !hostile.length) return fallback
  return Math.min(...core.flatMap(piece => hostile
    .map(other => distance(piece, other))
    .filter(value => value !== undefined)))
}

/**
 * Compress the explicit player observation into a stable, roster-neutral vector.
 * No BattleState, content ID, hidden status, opponent hand identity, or runtime rule
 * definition is accepted by this boundary.
 */
export function encodeLinearObservation(observation: AIObservation): AiLinearFeatureVector {
  const own = observation.pieces.filter(piece => piece.currentHp > 0 && samePlayer(piece.ownerPlayerId, observation.playerId))
  const enemy = observation.pieces.filter(piece => piece.currentHp > 0 && !samePlayer(piece.ownerPlayerId, observation.playerId))
  const ownCore = own.filter(piece => piece.isCore === true)
  const enemyCore = enemy.filter(piece => piece.isCore === true)
  const ownPlayer = observation.players.find(player => samePlayer(player.playerId, observation.playerId))
  const enemyPlayers = observation.players.filter(player => !samePlayer(player.playerId, observation.playerId))
  const enemyActionPoints = enemyPlayers.reduce((total, player) => total + player.actionPoints, 0)
  const enemyChargePoints = enemyPlayers.reduce((total, player) => total + player.chargePoints, 0)
  const enemyHandCount = enemyPlayers.reduce((total, player) => total + player.handCount, 0)
  const diameter = Math.max(1, observation.map.width + observation.map.height - 2)
  const ownNearest = averageNearest(own, enemy, diameter)
  const enemyNearest = averageNearest(enemy, own, diameter)
  const ownCoreSafety = coreNearest(ownCore, enemy, diameter)
  const enemyCoreSafety = coreNearest(enemyCore, own, diameter)

  const named: Record<AiLinearFeatureName, number> = {
    bias: 1,
    coreAliveBalance: relative(ownCore.length, enemyCore.length),
    coreHpBalance: relative(sum(ownCore, hpRatio), sum(enemyCore, hpRatio)),
    livingBalance: relative(own.length, enemy.length),
    hpBalance: relative(sum(own, hpRatio), sum(enemy, hpRatio)),
    attackBalance: relative(sum(own, piece => piece.attack), sum(enemy, piece => piece.attack)),
    defenseBalance: relative(sum(own, piece => piece.defense), sum(enemy, piece => piece.defense)),
    shieldBalance: relative(sum(own, piece => piece.shield ?? 0), sum(enemy, piece => piece.shield ?? 0)),
    buffBalance: relative(sum(own, piece => piece.buffs?.length ?? 0), sum(enemy, piece => piece.buffs?.length ?? 0)),
    // Enemy debuffs are favorable, own debuffs are unfavorable.
    debuffBalance: relative(sum(enemy, piece => piece.debuffs?.length ?? 0), sum(own, piece => piece.debuffs?.length ?? 0)),
    readySkillBalance: relative(sum(own, readySkills), sum(enemy, readySkills)),
    actionPointBalance: relative(ownPlayer?.actionPoints ?? 0, enemyActionPoints),
    chargePointBalance: relative(ownPlayer?.chargePoints ?? 0, enemyChargePoints),
    handBalance: relative(ownPlayer?.handCount ?? 0, enemyHandCount),
    engagementBalance: clamp((enemyNearest - ownNearest) / diameter),
    coreSafetyBalance: clamp((ownCoreSafety - enemyCoreSafety) / diameter),
    actingPlayer: samePlayer(observation.turn.currentPlayerId, observation.playerId) ? 1 : -1,
  }
  const values = AI_LINEAR_FEATURE_NAMES.map(name => clamp(named[name]))
  return {
    schemaVersion: AI_LINEAR_FEATURE_SCHEMA_VERSION,
    schemaHash: AI_LINEAR_FEATURE_SCHEMA_HASH,
    featureNames: AI_LINEAR_FEATURE_NAMES,
    values,
  }
}

export function linearFeatureRecord(vector: AiLinearFeatureVector): Record<AiLinearFeatureName, number> {
  if (vector.schemaVersion !== AI_LINEAR_FEATURE_SCHEMA_VERSION
    || vector.schemaHash !== AI_LINEAR_FEATURE_SCHEMA_HASH
    || vector.featureNames.length !== AI_LINEAR_FEATURE_NAMES.length
    || !vector.featureNames.every((name, index) => name === AI_LINEAR_FEATURE_NAMES[index])) {
    throw new Error('AI_LINEAR_FEATURE_SCHEMA_MISMATCH')
  }
  return Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map((name, index) => [name, vector.values[index]])) as Record<AiLinearFeatureName, number>
}
