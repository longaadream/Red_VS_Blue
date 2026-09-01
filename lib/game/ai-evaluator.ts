import cardManifest from '../../data/cards/manifest.json'
import semanticRegistry from '../../data/rules/ai-semantics.json'
import skillManifest from '../../data/skills/manifest.json'

import { candidateActionFeatures } from './ai-semantics'
import { stableJson } from './battle-trace'
import type {
  AiCandidateActionFeatures,
  AiCompatibility,
  AiPlannerConfig,
  AiPlannerScore,
  AiTurnGoal,
  CandidateAction,
} from './ai-types'
import type { PieceInstance } from './piece'
import type { BattleState } from './turn'

type SemanticGroup = 'skills' | 'cards'
const AUDITED_CONTENT: Readonly<Record<SemanticGroup, ReadonlySet<string>>> = {
  skills: new Set(skillManifest),
  cards: new Set(cardManifest),
}

type CandidateDescription = {
  features: AiCandidateActionFeatures
  priority: number
  reasons: string[]
}

const samePlayer = (left: unknown, right: unknown) => (
  String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
)
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const distance = (left: { x: number | null; y: number | null }, right: { x: number | null; y: number | null }) => (
  left.x == null || left.y == null || right.x == null || right.y == null
    ? Number.POSITIVE_INFINITY
    : Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
)
const living = (state: BattleState) => state.pieces.filter(piece => piece.currentHp > 0)
const allies = (state: BattleState, playerId: string) => living(state).filter(piece => samePlayer(piece.ownerPlayerId, playerId))
const enemies = (state: BattleState, playerId: string) => living(state).filter(piece => !samePlayer(piece.ownerPlayerId, playerId))
const weight = (config: AiPlannerConfig, key: string) => config.weights[key] ?? 0

function isValidGoal(state: BattleState, playerId: string, goal: AiTurnGoal): boolean {
  if (goal.kind === 'conserve') return enemies(state, playerId).length === 0
  if (!goal.targetId) return false
  const target = living(state).find(piece => piece.instanceId === goal.targetId)
  if (!target) return false
  return goal.kind === 'protect'
    ? samePlayer(target.ownerPlayerId, playerId)
    : !samePlayer(target.ownerPlayerId, playerId)
}

/** Goal selection uses only public, roster-neutral combat fields and preserves valid goals across replans. */
export function chooseAiTurnGoal(state: BattleState, playerId: string, previous?: AiTurnGoal): AiTurnGoal {
  if (previous && isValidGoal(state, playerId, previous)) return previous
  const own = allies(state, playerId)
  const hostile = enemies(state, playerId)
  if (!hostile.length) return { kind: 'conserve', rationale: 'no-live-enemy-target' }

  const critical = own
    .filter(piece => piece.maxHp > 0 && piece.currentHp / piece.maxHp <= 0.35)
    .sort((left, right) => (
      (left.currentHp / left.maxHp) - (right.currentHp / right.maxHp)
      || right.attack - left.attack
      || compareText(left.instanceId, right.instanceId)
    ))[0]
  if (critical) return { kind: 'protect', targetId: critical.instanceId, rationale: 'critical-high-value-friendly' }

  const maximumOwnAttack = Math.max(0, ...own.map(piece => piece.attack))
  const killable = hostile
    .filter(piece => piece.currentHp <= maximumOwnAttack)
    .sort((left, right) => left.currentHp - right.currentHp || compareText(left.instanceId, right.instanceId))[0]
  if (killable) return { kind: 'eliminate', targetId: killable.instanceId, rationale: 'publicly-killable-enemy' }

  const threat = hostile
    .slice()
    .sort((left, right) => right.attack - left.attack || left.currentHp - right.currentHp || compareText(left.instanceId, right.instanceId))[0]
  if (threat && threat.attack >= Math.max(1, maximumOwnAttack * 1.5)) {
    return { kind: 'control', targetId: threat.instanceId, rationale: 'highest-public-attack-threat' }
  }

  const weakest = hostile
    .slice()
    .sort((left, right) => left.currentHp - right.currentHp || compareText(left.instanceId, right.instanceId))[0]
  const nearest = own.length ? Math.min(...own.map(piece => distance(piece, weakest))) : Number.POSITIVE_INFINITY
  if (nearest > 2) return { kind: 'reposition', targetId: weakest.instanceId, rationale: 'close-distance-to-priority-enemy' }
  return { kind: 'eliminate', targetId: weakest.instanceId, rationale: 'lowest-live-enemy-hp' }
}

function candidateContent(state: BattleState, playerId: string, candidate: CandidateAction): {
  group?: SemanticGroup
  id?: string
} {
  const action = candidate.action
  if (action.type === 'useBasicSkill' || action.type === 'useChargeSkill') {
    return { group: 'skills', id: action.skillId }
  }
  if (action.type === 'playCard') {
    const player = state.players.find(item => samePlayer(item.playerId, playerId))
    const card = player?.hand.find(item => item.instanceId === action.cardInstanceId)
    return { group: 'cards', id: card?.cardId }
  }
  return {}
}

function declared(group: SemanticGroup | undefined, id: string | undefined, field: 'unsupported' | 'metadataRequired' | 'evaluatorRequired') {
  if (!group || !id) return false
  const values = (semanticRegistry[field] as Partial<Record<SemanticGroup, string[]>>)[group]
  return Array.isArray(values) && values.includes(id)
}

function compatibilityFor(group?: SemanticGroup, id?: string): { compatibility: AiCompatibility; diagnostics?: string } {
  if (group && (!id || !AUDITED_CONTENT[group].has(id))) {
    return { compatibility: 'unsupported', diagnostics: `fallback=skip-action;unknown-${group}-content` }
  }
  if (declared(group, id, 'unsupported')) return { compatibility: 'unsupported', diagnostics: 'fallback=skip-action' }
  if (declared(group, id, 'metadataRequired')) return { compatibility: 'metadata-required', diagnostics: 'fallback=skip-action' }
  if (declared(group, id, 'evaluatorRequired')) return { compatibility: 'evaluator-required', diagnostics: 'fallback=neutral-value' }
  return { compatibility: 'automatic', diagnostics: 'fallback=transition-diff' }
}

function targetPiece(state: BattleState, candidate: CandidateAction): PieceInstance | undefined {
  const targetId = 'targetPieceId' in candidate.action ? candidate.action.targetPieceId : undefined
  return targetId ? state.pieces.find(piece => piece.instanceId === targetId) : undefined
}

function nearestEnemyDistance(state: BattleState, playerId: string, point: { x: number; y: number }) {
  const hostile = enemies(state, playerId)
  return hostile.length
    ? Math.min(...hostile.map(piece => distance(point, piece)))
    : 0
}

/** Stable, explainable pre-simulation rank used only to crop already-legal environment candidates. */
export function describeAiCandidate(
  state: BattleState,
  playerId: string,
  goal: AiTurnGoal,
  candidate: CandidateAction,
): CandidateDescription {
  const content = candidateContent(state, playerId, candidate)
  const semantic = compatibilityFor(content.group, content.id)
  const rawFeatures = candidateActionFeatures(candidate.action, semantic)
  const features = content.id ? { ...rawFeatures, contentId: content.id } : rawFeatures
  const reasons: string[] = [`kind=${candidate.kind}`]
  const kindPriority: Record<CandidateAction['kind'], number> = {
    'pending-option': 0,
    'pending-target': 1,
    'cancel-selection': 2,
    'deployment-choice': 5,
    'deployment-lock': 6,
    'reserve-deployment': 7,
    'phase-advance': 8,
    'basic-skill': 20,
    'charge-skill': 21,
    card: 22,
    move: 40,
    'end-turn': 1_000,
  }
  let priority = kindPriority[candidate.kind]
  const selectedTarget = targetPiece(state, candidate)
  if (selectedTarget) {
    if (selectedTarget.instanceId === goal.targetId) {
      priority -= 500
      reasons.push('goal-target')
    }
    const ratio = selectedTarget.maxHp > 0 ? selectedTarget.currentHp / selectedTarget.maxHp : 1
    priority += samePlayer(selectedTarget.ownerPlayerId, playerId) ? ratio * 20 : ratio * 10
    reasons.push(`target-hp=${ratio.toFixed(3)}`)
  }

  const goalTarget = goal.targetId ? state.pieces.find(piece => piece.instanceId === goal.targetId) : undefined
  const action = candidate.action
  if (action.type === 'move') {
    const mover = state.pieces.find(piece => piece.instanceId === action.pieceId)
    const destination = { x: action.toX, y: action.toY }
    if (goalTarget && goal.kind !== 'protect') {
      const goalDistance = distance(destination, goalTarget)
      priority += Number.isFinite(goalDistance) ? goalDistance * 4 : 100
      reasons.push(`goal-distance=${goalDistance}`)
    }
    if (mover && goal.kind === 'protect' && mover.instanceId === goal.targetId) {
      const safety = nearestEnemyDistance(state, playerId, destination)
      priority -= safety * 4
      reasons.push(`protected-safety=${safety}`)
    }
  } else if ('targetX' in action && action.targetX !== undefined && action.targetY !== undefined && goalTarget) {
    const goalDistance = distance({ x: action.targetX, y: action.targetY }, goalTarget)
    priority += Number.isFinite(goalDistance) ? goalDistance * 3 : 100
    reasons.push(`area-goal-distance=${goalDistance}`)
  }
  return { features, priority, reasons }
}

export function compareAiCandidateDescriptions(
  left: CandidateDescription & { candidate: CandidateAction },
  right: CandidateDescription & { candidate: CandidateAction },
) {
  return left.priority - right.priority
    || compareText(stableJson(left.candidate.action), stableJson(right.candidate.action))
    || compareText(left.candidate.id, right.candidate.id)
}

function hpTotal(items: PieceInstance[]) {
  return items.reduce((total, piece) => total + piece.currentHp, 0)
}

function statusKeys(piece: PieceInstance | undefined) {
  return new Set((piece?.statusTags || [])
    .filter(tag => tag.visible !== false)
    .map(tag => String(tag.type || tag.id)))
}

function statusChanges(before: BattleState, after: BattleState, playerId: string) {
  const oldPieces = new Map(before.pieces.map(piece => [piece.instanceId, piece]))
  const newPieces = new Map(after.pieces.map(piece => [piece.instanceId, piece]))
  const result = { ownAdded: 0, ownRemoved: 0, enemyAdded: 0, enemyRemoved: 0 }
  for (const id of new Set([...oldPieces.keys(), ...newPieces.keys()])) {
    const oldPiece = oldPieces.get(id)
    const newPiece = newPieces.get(id)
    const owner = newPiece?.ownerPlayerId ?? oldPiece?.ownerPlayerId
    const own = samePlayer(owner, playerId)
    const oldStatuses = statusKeys(oldPiece)
    const newStatuses = statusKeys(newPiece)
    const added = [...newStatuses].filter(status => !oldStatuses.has(status)).length
    const removed = [...oldStatuses].filter(status => !newStatuses.has(status)).length
    if (own) {
      result.ownAdded += added
      result.ownRemoved += removed
    } else {
      result.enemyAdded += added
      result.enemyRemoved += removed
    }
  }
  return result
}

function countTransforms(before: BattleState, after: BattleState, playerId: string) {
  const oldPieces = new Map(before.pieces.map(piece => [piece.instanceId, piece]))
  let own = 0
  let enemy = 0
  for (const piece of after.pieces) {
    const previous = oldPieces.get(piece.instanceId)
    if (!previous || previous.templateId === piece.templateId) continue
    if (samePlayer(piece.ownerPlayerId, playerId)) own += 1
    else enemy += 1
  }
  return { own, enemy }
}

function resourceTotal(state: BattleState, playerId: string) {
  const player = state.players.find(item => samePlayer(item.playerId, playerId))
  return (player?.actionPoints ?? 0) + (player?.chargePoints ?? 0)
}

function goalDistance(state: BattleState, playerId: string, goal: AiTurnGoal) {
  if (!goal.targetId || goal.kind === 'protect' || goal.kind === 'conserve') return 0
  const target = state.pieces.find(piece => piece.instanceId === goal.targetId && piece.currentHp > 0)
  const own = allies(state, playerId)
  if (!target || !own.length) return 0
  return Math.min(...own.map(piece => distance(piece, target)))
}

function safetyValue(state: BattleState, playerId: string) {
  const hostile = enemies(state, playerId)
  if (!hostile.length) return 0
  return allies(state, playerId).reduce((total, piece) => {
    if (piece.maxHp <= 0) return total
    const missingRatio = Math.max(0, 1 - piece.currentHp / piece.maxHp)
    const nearest = Math.min(...hostile.map(target => distance(piece, target)))
    return total + (Number.isFinite(nearest) ? nearest * missingRatio : 0)
  }, 0)
}

function goalProgress(before: BattleState, after: BattleState, playerId: string, goal: AiTurnGoal) {
  const oldTarget = goal.targetId ? before.pieces.find(piece => piece.instanceId === goal.targetId) : undefined
  const newTarget = goal.targetId ? after.pieces.find(piece => piece.instanceId === goal.targetId) : undefined
  if (goal.kind === 'eliminate' && oldTarget) {
    if (!newTarget || newTarget.currentHp <= 0) return 1
    return Math.max(0, oldTarget.currentHp - newTarget.currentHp) / Math.max(1, oldTarget.maxHp)
  }
  if (goal.kind === 'protect' && oldTarget && newTarget) {
    const heal = Math.max(0, newTarget.currentHp - oldTarget.currentHp) / Math.max(1, oldTarget.maxHp)
    return heal + Math.max(0, safetyValue(after, playerId) - safetyValue(before, playerId)) / 10
  }
  if (goal.kind === 'control' && goal.targetId) {
    const oldStatuses = statusKeys(oldTarget)
    return [...statusKeys(newTarget)].filter(status => !oldStatuses.has(status)).length
  }
  if (goal.kind === 'reposition') {
    const oldDistance = goalDistance(before, playerId, goal)
    const newDistance = goalDistance(after, playerId, goal)
    return oldDistance > 0 ? Math.max(0, oldDistance - newDistance) / oldDistance : 0
  }
  return 0
}

/** Player-relative utility derived only from public state changes. */
export function evaluateAiTransition(
  before: BattleState,
  after: BattleState,
  playerId: string,
  goal: AiTurnGoal,
  config: AiPlannerConfig,
  isEndTurn = false,
  compatibility: AiCompatibility = 'automatic',
): AiPlannerScore {
  if (compatibility !== 'automatic') {
    return { total: 0, components: { semanticFallback: 0 } }
  }
  const ownBefore = allies(before, playerId)
  const ownAfter = allies(after, playerId)
  const enemyBefore = enemies(before, playerId)
  const enemyAfter = enemies(after, playerId)
  const statuses = statusChanges(before, after, playerId)
  const transforms = countTransforms(before, after, playerId)
  const ownSummoned = Math.max(0, ownAfter.length - ownBefore.length)
  const enemySummoned = Math.max(0, enemyAfter.length - enemyBefore.length)
  const components = {
    enemyHp: (hpTotal(enemyBefore) - hpTotal(enemyAfter)) * weight(config, 'enemyHp'),
    ownHp: (hpTotal(ownAfter) - hpTotal(ownBefore)) * weight(config, 'ownHp'),
    enemyRemoved: Math.max(0, enemyBefore.length - enemyAfter.length) * weight(config, 'enemyRemoved'),
    ownRemoved: Math.max(0, ownBefore.length - ownAfter.length) * weight(config, 'ownRemoved'),
    enemyStatusAdded: statuses.enemyAdded * weight(config, 'enemyStatusAdded'),
    ownStatusRemoved: statuses.ownRemoved * weight(config, 'ownStatusRemoved'),
    ownStatusAdded: statuses.ownAdded * weight(config, 'ownStatusAdded'),
    enemyStatusRemoved: statuses.enemyRemoved * weight(config, 'enemyStatusRemoved'),
    goalDistance: (goalDistance(before, playerId, goal) - goalDistance(after, playerId, goal)) * weight(config, 'goalDistance'),
    safety: (safetyValue(after, playerId) - safetyValue(before, playerId)) * weight(config, 'safety'),
    resources: (resourceTotal(after, playerId) - resourceTotal(before, playerId)) * weight(config, 'resources'),
    ownSummoned: ownSummoned * weight(config, 'ownSummoned'),
    enemySummoned: enemySummoned * weight(config, 'enemySummoned'),
    ownTransformed: transforms.own * weight(config, 'ownTransformed'),
    enemyTransformed: transforms.enemy * weight(config, 'enemyTransformed'),
    endTurn: isEndTurn ? weight(config, 'endTurn') : 0,
    goal: goalProgress(before, after, playerId, goal) * weight(config, 'goal'),
  }
  return { total: Object.values(components).reduce((total, value) => total + value, 0), components }
}
