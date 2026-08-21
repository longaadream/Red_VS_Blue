import type { BattleState } from './turn'
import { transitionFeatures } from './ai-semantics'
import type { AiPlannerConfig, AiPlannerScore, AiTurnGoal } from './ai-types'

const same = (a: unknown, b: unknown) => String(a) === String(b)

function living(state: BattleState, playerId: string) {
  return state.pieces.filter(piece => piece.currentHp > 0 && same(piece.ownerPlayerId, playerId))
}

function hp(state: BattleState, playerId: string) {
  return living(state, playerId).reduce((total, piece) => total + piece.currentHp, 0)
}

function nearestEnemyDistance(state: BattleState, playerId: string): number {
  const own = living(state, playerId).filter(piece => piece.x != null && piece.y != null)
  const enemy = state.pieces.filter(piece => piece.currentHp > 0 && !same(piece.ownerPlayerId, playerId) && piece.x != null && piece.y != null)
  if (!own.length || !enemy.length) return 0
  return Math.min(...own.flatMap(piece => enemy.map(target => Math.abs(piece.x! - target.x!) + Math.abs(piece.y! - target.y!))))
}

export function chooseAiTurnGoal(state: BattleState, playerId: string, previous?: AiTurnGoal): AiTurnGoal {
  if (previous?.targetId && state.pieces.some(piece => piece.instanceId === previous.targetId && piece.currentHp > 0)) return previous
  const enemies = state.pieces.filter(piece => piece.currentHp > 0 && !same(piece.ownerPlayerId, playerId))
  const weakest = enemies.slice().sort((a, b) => a.currentHp - b.currentHp || a.instanceId.localeCompare(b.instanceId))[0]
  if (weakest) return { kind: 'eliminate', targetId: weakest.instanceId, rationale: 'lowest-live-enemy-hp' }
  const threatened = living(state, playerId).slice().sort((a, b) => (a.currentHp / a.maxHp) - (b.currentHp / b.maxHp) || a.instanceId.localeCompare(b.instanceId))[0]
  return threatened && threatened.currentHp < threatened.maxHp
    ? { kind: 'protect', targetId: threatened.instanceId, rationale: 'lowest-friendly-health-ratio' }
    : { kind: 'conserve', rationale: 'no-live-enemy-target' }
}

export function evaluateAiTransition(before: BattleState, after: BattleState, playerId: string, goal: AiTurnGoal, config: AiPlannerConfig, isEndTurn = false): AiPlannerScore {
  const enemyBefore = before.pieces.filter(piece => piece.currentHp > 0 && !same(piece.ownerPlayerId, playerId))
  const enemyAfter = after.pieces.filter(piece => piece.currentHp > 0 && !same(piece.ownerPlayerId, playerId))
  const ownBefore = living(before, playerId)
  const ownAfter = living(after, playerId)
  const features = transitionFeatures(before, after)
  const components = {
    enemyHp: (enemyBefore.reduce((n, p) => n + p.currentHp, 0) - enemyAfter.reduce((n, p) => n + p.currentHp, 0)) * config.weights.enemyHp,
    ownHp: (hp(after, playerId) - hp(before, playerId)) * config.weights.ownHp,
    enemyRemoved: (enemyBefore.length - enemyAfter.length) * config.weights.enemyRemoved,
    ownRemoved: (ownBefore.length - ownAfter.length) * config.weights.ownRemoved,
    status: (features.statusAdded - features.statusRemoved) * config.weights.status,
    distance: (nearestEnemyDistance(before, playerId) - nearestEnemyDistance(after, playerId)) * config.weights.distance,
    resources: features.resourceDelta * config.weights.resources,
    endTurn: isEndTurn ? config.weights.endTurn : 0,
    goal: goal.kind === 'eliminate' && goal.targetId && !after.pieces.some(piece => piece.instanceId === goal.targetId && piece.currentHp > 0) ? config.weights.enemyRemoved : 0,
  }
  return { total: Object.values(components).reduce((total, value) => total + value, 0), components }
}
