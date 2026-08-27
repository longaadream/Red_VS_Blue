import { resolveZeroStageConfig } from './ai-profiles'
import type {
  AIObservation,
  AIObservedPiece,
  ZeroStageConfig,
  ZeroStageStaticComponent,
  ZeroStageStaticComponentKey,
  ZeroStageStaticEvaluation,
} from './ai-types'

type ZeroStageConfigOverrides = Partial<Omit<ZeroStageConfig, 'version' | 'weights' | 'terminal'>> & {
  weights?: Partial<ZeroStageConfig['weights']>
  terminal?: Partial<ZeroStageConfig['terminal']>
}

const samePlayer = (left: unknown, right: unknown) => (
  String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
)

const alive = (piece: AIObservedPiece) => piece.currentHp > 0
const ratio = (value: number, maximum: number) => maximum > 0 ? value / maximum : 0
const position = (piece: AIObservedPiece) => piece.x == null || piece.y == null ? undefined : { x: piece.x, y: piece.y }
const distance = (left: AIObservedPiece, right: AIObservedPiece) => {
  const a = position(left)
  const b = position(right)
  return a && b ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : Number.POSITIVE_INFINITY
}

function engagement(source: AIObservedPiece, target: AIObservedPiece) {
  return distance(source, target) <= Math.max(1, source.moveRange + 1)
}

function lethalOpportunities(sources: AIObservedPiece[], targets: AIObservedPiece[]) {
  return sources.reduce((total, source) => total + targets.filter(target => (
    engagement(source, target)
    && Math.max(1, source.attack - target.defense) >= target.currentHp
  )).length, 0)
}

function attackPressure(sources: AIObservedPiece[], targets: AIObservedPiece[]) {
  return sources.reduce((total, source) => total + targets.reduce((subtotal, target) => {
    if (!engagement(source, target)) return subtotal
    return subtotal + Math.max(1, source.attack - target.defense) / Math.max(1, target.maxHp)
  }, 0), 0)
}

function formationPairs(pieces: AIObservedPiece[]) {
  let pairs = 0
  for (let left = 0; left < pieces.length; left += 1) {
    for (let right = left + 1; right < pieces.length; right += 1) {
      if (distance(pieces[left], pieces[right]) <= 2) pairs += 1
    }
  }
  return pairs
}

function mapControl(pieces: AIObservedPiece[], width: number, height: number) {
  const center = { x: (width - 1) / 2, y: (height - 1) / 2 }
  const maximum = Math.max(1, center.x + center.y)
  return pieces.reduce((total, piece) => {
    const point = position(piece)
    if (!point) return total
    const centerDistance = Math.abs(point.x - center.x) + Math.abs(point.y - center.y)
    return total + Math.max(0, 1 - centerDistance / maximum)
  }, 0)
}

function statusBalance(pieces: AIObservedPiece[]) {
  return pieces.reduce((total, piece) => (
    total + (piece.buffs?.length ?? 0) - (piece.debuffs?.length ?? 0)
  ), 0)
}

function terminalOutcome(observation: AIObservation): 'win' | 'loss' | 'draw' | undefined {
  const terminal = observation.terminalResult
  if (!terminal) return undefined
  if (terminal.winnerPlayerId === null) return 'draw'
  return samePlayer(terminal.winnerPlayerId, observation.playerId) ? 'win' : 'loss'
}

/** Static, public-observation-only position estimate F_p(S). */
export function evaluateZeroStageState(
  observation: AIObservation,
  overrides: ZeroStageConfigOverrides = {},
): ZeroStageStaticEvaluation {
  const config = resolveZeroStageConfig(overrides)
  const own = observation.pieces.filter(piece => alive(piece) && samePlayer(piece.ownerPlayerId, observation.playerId))
  const enemy = observation.pieces.filter(piece => alive(piece) && !samePlayer(piece.ownerPlayerId, observation.playerId))
  const ownGraveyard = observation.graveyard.filter(piece => samePlayer(piece.ownerPlayerId, observation.playerId)).length
  const enemyGraveyard = observation.graveyard.length - ownGraveyard
  const ownPlayer = observation.players.find(player => samePlayer(player.playerId, observation.playerId))
  const enemyPlayers = observation.players.filter(player => !samePlayer(player.playerId, observation.playerId))
  const activeOwn = observation.turn.phase === 'action'
    && samePlayer(observation.turn.currentPlayerId, observation.playerId)
  const activeEnemy = observation.turn.phase === 'action' && !activeOwn
  const raw: Record<ZeroStageStaticComponentKey, number> = {
    coreSurvival: own.filter(piece => piece.isCore).length - enemy.filter(piece => piece.isCore).length,
    survival: own.length - enemy.length,
    graveyard: enemyGraveyard - ownGraveyard,
    health: own.reduce((total, piece) => total + ratio(piece.currentHp, piece.maxHp), 0)
      - enemy.reduce((total, piece) => total + ratio(piece.currentHp, piece.maxHp), 0),
    combatPower: own.reduce((total, piece) => total + ratio(piece.attack + piece.defense, piece.maxHp), 0)
      - enemy.reduce((total, piece) => total + ratio(piece.attack + piece.defense, piece.maxHp), 0),
    shield: own.reduce((total, piece) => total + (piece.shield ?? 0), 0)
      - enemy.reduce((total, piece) => total + (piece.shield ?? 0), 0),
    resources: (ownPlayer?.actionPoints ?? 0) + (ownPlayer?.chargePoints ?? 0)
      - enemyPlayers.reduce((total, player) => total + player.actionPoints + player.chargePoints, 0),
    actionability: activeOwn
      ? own.length + Math.min(3, ownPlayer?.actionPoints ?? 0)
      : activeEnemy ? -(enemy.length + Math.min(3, enemyPlayers.reduce((total, player) => total + player.actionPoints, 0))) : 0,
    lethalOpportunity: lethalOpportunities(own, enemy) - lethalOpportunities(enemy, own),
    attackPressure: attackPressure(own, enemy) - attackPressure(enemy, own),
    status: statusBalance(own) - statusBalance(enemy),
    formation: formationPairs(own) - formationPairs(enemy),
    mapControl: mapControl(own, observation.map.width, observation.map.height)
      - mapControl(enemy, observation.map.width, observation.map.height),
  }
  const components = Object.fromEntries(
    (Object.keys(raw) as ZeroStageStaticComponentKey[]).map(key => {
      const weight = config.weights[key]
      const component: ZeroStageStaticComponent = { raw: raw[key], weight, contribution: raw[key] * weight }
      return [key, component]
    }),
  ) as Record<ZeroStageStaticComponentKey, ZeroStageStaticComponent>
  const outcome = terminalOutcome(observation)
  const total = outcome
    ? config.terminal[outcome]
    : Object.values(components).reduce((sum, component) => sum + component.contribution, 0)
  if (!Number.isFinite(total)) throw new RangeError('Zero-stage static evaluation must be finite')
  return { total, terminalOutcome: outcome, components }
}

export function combineZeroStagePotential(
  values: readonly number[],
  weights: readonly [number, number, number],
  fallback: number,
): { value: number; selected: number[]; normalizedWeights: number[] } {
  if (values.length === 0) return { value: fallback, selected: [], normalizedWeights: [] }
  const selected = [...values].sort((left, right) => right - left).slice(0, 3)
  const admittedWeights = weights.slice(0, selected.length)
  const sum = admittedWeights.reduce((total, value) => total + value, 0)
  if (!(sum > 0)) throw new RangeError('Zero-stage admitted top weights must sum to a positive number')
  const normalizedWeights = admittedWeights.map(value => value / sum)
  return {
    value: selected.reduce((total, value, index) => total + value * normalizedWeights[index], 0),
    selected,
    normalizedWeights,
  }
}
